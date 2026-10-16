// =============================================
// DropShare — Frontend Application
// =============================================
// This file contains the complete client-side logic:
//   1. UI management (screen switching, notifications)
//   2. WebSocket signaling (connect to Cloudflare Worker)
//   3. WebRTC peer connection (data channel)
//   4. File chunking, sending, and receiving
//   5. Text message sharing
// =============================================

(function () {
  'use strict';

  // ==========================================================
  //  CONFIGURATION — edit the signalingUrl after deploying your
  //  Cloudflare Worker, or leave empty to use same-origin.
  // ==========================================================
  const CONFIG = {
    // Set this to your deployed Worker URL, e.g.:
    //   'wss://dropshare-signaling.YOUR_SUBDOMAIN.workers.dev'
    // Leave empty string '' to auto-detect (same origin).
    signalingUrl: '',

    // STUN servers help peers discover their public IP.
    // These free servers work for most cases.
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
      // To support peers behind symmetric NATs, add a TURN server:
      // { urls: 'turn:YOUR_TURN_SERVER:3478', username: 'user', credential: 'pass' }
    ],

    // Chunk size for file transfer (bytes). 64 KB is a safe default.
    chunkSize: 65536,

    // DataChannel bufferedAmount threshold (1 MB). We pause sending
    // when the buffer exceeds this to avoid memory issues.
    bufferThreshold: 1048576,

    // How long to wait (ms) for a peer before timing out.
    pairingTimeout: 300000 // 5 minutes
  };

  // ==========================================================
  //  UTILITY HELPERS
  // ==========================================================

  /** Generate a random 6-digit numeric code. */
  function generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  /** Format bytes into a human-readable string. */
  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  /** Generate a short unique ID. */
  function uid() {
    return Math.random().toString(36).substring(2, 10);
  }

  /** Get file extension from name. */
  function getExtension(name) {
    const parts = name.split('.');
    return parts.length > 1 ? parts.pop().toUpperCase() : 'FILE';
  }

  // ==========================================================
  //  TOAST NOTIFICATIONS
  // ==========================================================
  const Toast = {
    container: null,

    init() {
      this.container = document.getElementById('toast-container');
    },

    show(message, type = 'info') {
      const el = document.createElement('div');
      el.className = `toast toast-${type}`;
      el.textContent = message;
      this.container.appendChild(el);
      // Auto-remove after animation finishes
      setTimeout(() => el.remove(), 3200);
    },

    success(msg) { this.show(msg, 'success'); },
    error(msg)   { this.show(msg, 'error'); },
    info(msg)    { this.show(msg, 'info'); }
  };

  // ==========================================================
  //  UI MANAGER — screen switching, DOM helpers
  // ==========================================================
  const UI = {
    screens: {},
    currentScreen: 'home',

    init() {
      // Cache screen elements
      document.querySelectorAll('.screen').forEach(el => {
        const id = el.id.replace('screen-', '');
        this.screens[id] = el;
      });

      // Back buttons
      document.querySelectorAll('.btn-back').forEach(btn => {
        btn.addEventListener('click', () => {
          App.handleBack();
        });
      });
    },

    /** Switch to a named screen ('home', 'send', 'receive'). */
    showScreen(name) {
      // Deactivate current
      if (this.screens[this.currentScreen]) {
        this.screens[this.currentScreen].classList.remove('active');
      }
      // Activate new
      if (this.screens[name]) {
        this.screens[name].classList.add('active');
        this.currentScreen = name;
      }
    },

    /** Show/hide an element by ID. */
    show(id) { document.getElementById(id)?.classList.remove('hidden'); },
    hide(id) { document.getElementById(id)?.classList.add('hidden'); }
  };

  // ==========================================================
  //  SIGNALING CLIENT — WebSocket connection to Worker
  // ==========================================================
  class SignalingClient {
    constructor() {
      /** @type {WebSocket|null} */
      this.ws = null;
      this.code = '';
      this.role = '';
      this.connected = false;

      // Callbacks
      this.onWelcome = null;   // (data) => {}
      this.onPaired = null;    // (data) => {}
      this.onMessage = null;   // (data) => {}
      this.onDisconnect = null; // () => {}
      this.onError = null;     // (error) => {}
    }

    /**
     * Build the WebSocket URL for a given room code.
     * If CONFIG.signalingUrl is set, use that; otherwise derive
     * from the current page origin (useful when Worker and Pages
     * are on the same domain or during local dev).
     */
    _buildUrl(code) {
      let base = CONFIG.signalingUrl;
      if (!base) {
        // Derive from current page
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        base = `${proto}//${location.host}`;
      }
      // Ensure it starts with ws:// or wss://
      if (base.startsWith('http://'))  base = base.replace('http://', 'ws://');
      if (base.startsWith('https://')) base = base.replace('https://', 'wss://');
      if (!base.startsWith('ws://') && !base.startsWith('wss://')) {
        base = 'wss://' + base;
      }
      return `${base}/ws/${code}`;
    }

    /** Connect to a signaling room. */
    connect(code) {
      this.code = code;
      const url = this._buildUrl(code);
      console.log('[Signaling] Connecting to', url);

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        console.error('[Signaling] WebSocket creation failed:', err);
        this.onError?.('ไม่สามารถเชื่อมต่อไปยังเซิร์ฟเวอร์สัญญาณได้');
        return;
      }

      this.ws.addEventListener('open', () => {
        console.log('[Signaling] WebSocket opened');
        this.connected = true;
      });

      this.ws.addEventListener('message', (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (e) {
          console.warn('[Signaling] Non-JSON message:', event.data);
          return;
        }

        console.log('[Signaling] Received:', data.type);

        switch (data.type) {
          case 'welcome':
            this.role = data.role;
            this.onWelcome?.(data);
            break;
          case 'paired':
            this.onPaired?.(data);
            break;
          case 'peer-disconnected':
            this.onDisconnect?.();
            break;
          default:
            // Forward SDP / ICE messages to WebRTC handler
            this.onMessage?.(data);
        }
      });

      this.ws.addEventListener('close', () => {
        console.log('[Signaling] WebSocket closed');
        this.connected = false;
        this.onDisconnect?.();
      });

      this.ws.addEventListener('error', (err) => {
        console.error('[Signaling] WebSocket error:', err);
        this.onError?.('การเชื่อมต่อไปยังเซิร์ฟเวอร์สัญญาณขาดหาย');
      });
    }

    /** Send a JSON message through the signaling channel. */
    send(data) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(data));
      }
    }

    /** Close the WebSocket. */
    disconnect() {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.connected = false;
    }
  }

  // ==========================================================
  //  WEBRTC MANAGER — peer connection + data channel
  // ==========================================================
  class PeerConnection {
    constructor(signaling) {
      /** @type {SignalingClient} */
      this.signaling = signaling;
      /** @type {RTCPeerConnection|null} */
      this.pc = null;
      /** @type {RTCDataChannel|null} */
      this.dataChannel = null;
      this.isInitiator = false;

      // Callbacks
      this.onDataChannelOpen = null;  // () => {}
      this.onDataChannelClose = null; // () => {}
      this.onStringMessage = null;    // (data) => {}
      this.onBinaryMessage = null;    // (ArrayBuffer) => {}
    }

    /** Create and configure the RTCPeerConnection. */
    _createPeerConnection() {
      this.pc = new RTCPeerConnection({
        iceServers: CONFIG.iceServers
      });

      // Send ICE candidates to the remote peer via signaling
      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.signaling.send({
            type: 'ice-candidate',
            candidate: event.candidate
          });
        }
      };

      // Log connection state changes
      this.pc.onconnectionstatechange = () => {
        console.log('[WebRTC] Connection state:', this.pc.connectionState);
        if (this.pc.connectionState === 'failed') {
          Toast.error('การเชื่อมต่อกับอีกเครื่องขัดข้อง กรุณาลองใหม่อีกครั้งหรือตรวจสอบเครือข่าย');
        }
      };

      this.pc.oniceconnectionstatechange = () => {
        console.log('[WebRTC] ICE state:', this.pc.iceConnectionState);
      };

      // Handle incoming data channels (for the joiner/receiver)
      this.pc.ondatachannel = (event) => {
        console.log('[WebRTC] Received data channel');
        this._setupDataChannel(event.channel);
      };
    }

    /** Configure event listeners on the data channel. */
    _setupDataChannel(channel) {
      this.dataChannel = channel;
      this.dataChannel.binaryType = 'arraybuffer';

      // Use ordered, reliable delivery for file transfers
      this.dataChannel.onopen = () => {
        console.log('[WebRTC] Data channel OPEN');
        this.onDataChannelOpen?.();
      };

      this.dataChannel.onclose = () => {
        console.log('[WebRTC] Data channel CLOSED');
        this.onDataChannelClose?.();
      };

      this.dataChannel.onerror = (err) => {
        console.error('[WebRTC] Data channel error:', err);
      };

      this.dataChannel.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const parsed = JSON.parse(event.data);
            this.onStringMessage?.(parsed);
          } catch {
            this.onStringMessage?.({ type: 'raw', text: event.data });
          }
        } else {
          // ArrayBuffer — binary file chunk
          this.onBinaryMessage?.(event.data);
        }
      };
    }

    /**
     * Start the WebRTC handshake as the initiator.
     * Creates the data channel and an SDP offer.
     */
    async startAsInitiator() {
      this.isInitiator = true;
      this._createPeerConnection();

      // Create the data channel
      const channel = this.pc.createDataChannel('dropshare', {
        ordered: true
      });
      this._setupDataChannel(channel);

      // Create and send the SDP offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signaling.send({
        type: 'offer',
        sdp: this.pc.localDescription
      });

      console.log('[WebRTC] Sent offer');
    }

    /**
     * Start the WebRTC handshake as the joiner.
     * Waits for the offer to arrive via signaling.
     */
    startAsJoiner() {
      this.isInitiator = false;
      this._createPeerConnection();
      console.log('[WebRTC] Ready as joiner, waiting for offer…');
    }

    /**
     * Handle incoming signaling messages (offer, answer, ICE candidate).
     */
    async handleSignalingMessage(data) {
      if (!this.pc) return;

      switch (data.type) {
        case 'offer':
          console.log('[WebRTC] Received offer');
          await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.signaling.send({
            type: 'answer',
            sdp: this.pc.localDescription
          });
          console.log('[WebRTC] Sent answer');
          break;

        case 'answer':
          console.log('[WebRTC] Received answer');
          await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          break;

        case 'ice-candidate':
          try {
            await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (err) {
            console.warn('[WebRTC] Failed to add ICE candidate:', err);
          }
          break;
      }
    }

    /** Send a string message through the data channel. */
    sendString(data) {
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this.dataChannel.send(JSON.stringify(data));
      }
    }

    /** Send binary data through the data channel. */
    sendBinary(buffer) {
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this.dataChannel.send(buffer);
      }
    }

    /** Get the current bufferedAmount of the data channel. */
    get bufferedAmount() {
      return this.dataChannel ? this.dataChannel.bufferedAmount : 0;
    }

    /** Close everything. */
    close() {
      if (this.dataChannel) {
        this.dataChannel.close();
        this.dataChannel = null;
      }
      if (this.pc) {
        this.pc.close();
        this.pc = null;
      }
    }
  }

  // ==========================================================
  //  FILE TRANSFER — send & receive files over data channel
  // ==========================================================
  class FileTransfer {
    constructor(peerConnection) {
      /** @type {PeerConnection} */
      this.peer = peerConnection;

      // --- Sending state ---
      this.sendQueue = [];       // Array of File objects to send
      this.isSending = false;

      // --- Receiving state ---
      // Map of fileId -> { name, size, mimeType, receivedBytes, chunks: [] }
      this.incomingFiles = new Map();

      // Callbacks
      this.onSendProgress = null;   // (fileId, sentBytes, totalBytes) => {}
      this.onSendComplete = null;   // (fileId, fileName) => {}
      this.onSendError = null;      // (fileId, error) => {}
      this.onReceiveStart = null;   // (fileId, name, size) => {}
      this.onReceiveProgress = null; // (fileId, receivedBytes, totalBytes) => {}
      this.onReceiveComplete = null; // (fileId, name, blob) => {}
      this.onTextReceived = null;   // (text) => {}

      // Wire up message handlers on the peer connection
      this.peer.onStringMessage = (data) => this._handleStringMessage(data);
      this.peer.onBinaryMessage = (buf) => this._handleBinaryMessage(buf);
    }

    // ---- SENDING ----

    /**
     * Queue files for sending and start the transfer.
     * @param {FileList|File[]} files
     */
    sendFiles(files) {
      for (const file of files) {
        const id = uid();
        this.sendQueue.push({ id, file });
      }
      if (!this.isSending) {
        this._processQueue();
      }
    }

    /** Send a text message to the peer. */
    sendText(text) {
      this.peer.sendString({
        type: 'text-message',
        text: text,
        timestamp: Date.now()
      });
    }

    /** Process the next file in the send queue. */
    async _processQueue() {
      if (this.sendQueue.length === 0) {
        this.isSending = false;
        return;
      }

      this.isSending = true;
      const { id, file } = this.sendQueue.shift();

      // Send file metadata
      this.peer.sendString({
        type: 'file-start',
        id: id,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream'
      });

      // Read and send chunks
      let offset = 0;
      const reader = file.stream().getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // The stream gives us Uint8Array chunks, but they may be
          // larger or smaller than CONFIG.chunkSize. We re-chunk them.
          let pos = 0;
          while (pos < value.length) {
            const end = Math.min(pos + CONFIG.chunkSize, value.length);
            const chunk = value.slice(pos, end);

            // Wait if the channel buffer is too full
            await this._waitForBuffer();

            this.peer.sendBinary(chunk.buffer.slice(
              chunk.byteOffset,
              chunk.byteOffset + chunk.byteLength
            ));

            offset += chunk.byteLength;
            this.onSendProgress?.(id, offset, file.size);
            pos = end;
          }
        }
      } catch (err) {
        console.error('[FileTransfer] Send error:', err);
        this.onSendError?.(id, err.message);
        this._processQueue();
        return;
      }

      // Notify the peer that the file is complete
      this.peer.sendString({
        type: 'file-end',
        id: id
      });

      this.onSendComplete?.(id, file.name);

      // Process next file in queue
      this._processQueue();
    }

    /**
     * Wait until the data channel buffer drains below the threshold.
     * This prevents memory issues when sending large files.
     */
    _waitForBuffer() {
      return new Promise((resolve) => {
        const check = () => {
          if (this.peer.bufferedAmount < CONFIG.bufferThreshold) {
            resolve();
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });
    }

    // ---- RECEIVING ----

    /** Handle a JSON control message from the peer. */
    _handleStringMessage(data) {
      switch (data.type) {
        case 'file-start':
          this.incomingFiles.set(data.id, {
            name: data.name,
            size: data.size,
            mimeType: data.mimeType,
            receivedBytes: 0,
            chunks: []
          });
          this.onReceiveStart?.(data.id, data.name, data.size);
          break;

        case 'file-end': {
          const file = this.incomingFiles.get(data.id);
          if (file) {
            // Assemble the Blob from all received chunks
            const blob = new Blob(file.chunks, { type: file.mimeType });
            this.onReceiveComplete?.(data.id, file.name, blob);
            this.incomingFiles.delete(data.id);
          }
          break;
        }

        case 'text-message':
          this.onTextReceived?.(data.text, data.timestamp);
          break;

        default:
          console.log('[FileTransfer] Unknown message type:', data.type);
      }
    }

    /** Handle a binary chunk from the peer. */
    _handleBinaryMessage(buffer) {
      // Find the file that is currently being received
      // (the most recently started file that isn't complete)
      let currentFile = null;
      let currentId = null;
      for (const [id, file] of this.incomingFiles) {
        currentFile = file;
        currentId = id;
      }

      if (!currentFile) {
        console.warn('[FileTransfer] Received binary data but no file is in progress');
        return;
      }

      currentFile.chunks.push(new Uint8Array(buffer));
      currentFile.receivedBytes += buffer.byteLength;

      this.onReceiveProgress?.(
        currentId,
        currentFile.receivedBytes,
        currentFile.size
      );
    }
  }

  // ==========================================================
  //  MAIN APPLICATION CONTROLLER
  // ==========================================================
  const App = {
    signaling: null,
    peer: null,
    transfer: null,
    pairingCode: '',
    mode: '',            // 'send' or 'receive'
    selectedFiles: [],   // Files selected by the sender
    _fileIdMap: new Map(), // uid -> File for UI tracking

    /** Initialize the entire application. */
    init() {
      Toast.init();
      UI.init();

      // Home screen buttons
      document.getElementById('btn-send').addEventListener('click', () => this.startSendMode());
      document.getElementById('btn-receive').addEventListener('click', () => this.startReceiveMode());

      // Send screen: file selection
      document.getElementById('btn-browse').addEventListener('click', () => {
        document.getElementById('file-input').click();
      });
      document.getElementById('file-input').addEventListener('change', (e) => {
        this.addFiles(e.target.files);
        e.target.value = ''; // reset so same file can be re-added
      });
      document.getElementById('btn-add-more').addEventListener('click', () => {
        document.getElementById('file-input').click();
      });
      document.getElementById('btn-send-files').addEventListener('click', () => this.sendAllFiles());
      document.getElementById('btn-send-text').addEventListener('click', () => this.sendTextMessage());

      // Copy code button
      document.getElementById('btn-copy-code').addEventListener('click', () => {
        navigator.clipboard.writeText(this.pairingCode).then(() => {
          Toast.success('คัดลอกรหัสเรียบร้อยแล้ว!');
        }).catch(() => {
          Toast.error('ไม่สามารถคัดลอกรหัสได้');
        });
      });

      // Receive screen: code input
      this._setupCodeInput();
      document.getElementById('btn-join').addEventListener('click', () => this.joinRoom());

      // Drag & drop
      this._setupDragDrop();

      // Keyboard shortcut: Enter to send text
      document.getElementById('text-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendTextMessage();
        }
      });

      console.log('[DropShare] App initialized');
    },

    // ---- MODE SETUP ----

    /** Start Send mode: generate code, connect to signaling, show QR. */
    startSendMode() {
      this.mode = 'send';
      this.pairingCode = generateCode();
      this.selectedFiles = [];
      this._fileIdMap.clear();

      // Display the code
      const digits = this.pairingCode.split('');
      for (let i = 0; i < 6; i++) {
        document.getElementById('d' + (i + 1)).textContent = digits[i];
      }

      // Generate QR code
      const qrContainer = document.getElementById('qr-container');
      qrContainer.innerHTML = '';
      const qrUrl = `${location.origin}${location.pathname}#join:${this.pairingCode}`;
      if (typeof QRCode !== 'undefined') {
        QRCode.toCanvas(qrUrl, {
          width: 160,
          margin: 1,
          color: { dark: '#000000', light: '#ffffff' }
        }, (err, canvas) => {
          if (!err && canvas) {
            qrContainer.appendChild(canvas);
          }
        });
      }

      // Show send screen with pairing step
      UI.show('send-step-pair');
      UI.hide('send-step-connected');
      UI.showScreen('send');

      // Connect to signaling server
      this._connectSignaling(this.pairingCode);
    },

    /** Start Receive mode: show code input. */
    startReceiveMode() {
      this.mode = 'receive';

      // Reset code inputs
      document.querySelectorAll('.code-cell').forEach(input => {
        input.value = '';
      });
      document.getElementById('btn-join').disabled = true;

      UI.show('recv-step-pair');
      UI.hide('recv-step-connected');
      UI.showScreen('receive');

      // Check if there's a join code in the URL hash
      const hash = location.hash;
      if (hash.startsWith('#join:')) {
        const code = hash.substring(6);
        if (/^\d{6}$/.test(code)) {
          // Auto-fill the code
          const digits = code.split('');
          document.querySelectorAll('.code-cell').forEach((input, i) => {
            input.value = digits[i] || '';
          });
          document.getElementById('btn-join').disabled = false;
          // Auto-join
          location.hash = '';
          setTimeout(() => this.joinRoom(), 300);
        }
      }

      // Focus the first code cell
      document.querySelector('.code-cell[data-idx="1"]')?.focus();
    },

    /** Join a room as a receiver. */
    joinRoom() {
      // Collect code from inputs
      let code = '';
      document.querySelectorAll('.code-cell').forEach(input => {
        code += input.value;
      });

      if (!/^\d{6}$/.test(code)) {
        Toast.error('กรุณากรอกรหัสตัวเลขให้ครบ 6 หลัก');
        return;
      }

      this.pairingCode = code;
      document.getElementById('btn-join').disabled = true;
      UI.show('join-spinner');

      // Connect to signaling server
      this._connectSignaling(code);
    },

    /** Handle back button — disconnect and return home. */
    handleBack() {
      // Clean up connections
      if (this.transfer) this.transfer = null;
      if (this.peer) { this.peer.close(); this.peer = null; }
      if (this.signaling) { this.signaling.disconnect(); this.signaling = null; }

      this.selectedFiles = [];
      this._fileIdMap.clear();

      // Reset UI
      UI.hide('send-step-connected');
      UI.show('send-step-pair');
      UI.hide('recv-step-connected');
      UI.show('recv-step-pair');
      UI.hide('join-spinner');
      document.getElementById('btn-join').disabled = false;
      document.getElementById('selected-files-list').innerHTML = '';
      UI.hide('selected-files-section');
      document.getElementById('send-transfer-list').innerHTML = '';
      UI.hide('send-transfers');
      document.getElementById('received-files-list').innerHTML = '';
      document.getElementById('recv-empty').classList.remove('hidden');
      UI.hide('recv-texts-section');
      document.getElementById('received-texts').innerHTML = '';
      document.getElementById('recv-transfer-list').innerHTML = '';
      UI.hide('recv-transfers');

      UI.showScreen('home');
    },

    // ---- SIGNALING & WEBRTC SETUP ----

    /** Connect to the signaling server and set up WebRTC when paired. */
    _connectSignaling(code) {
      this.signaling = new SignalingClient();

      this.signaling.onWelcome = (data) => {
        console.log('[App] Welcome, role:', data.role, 'peers:', data.peerCount);
        // If we are the second client, pairing will happen immediately
      };

      this.signaling.onPaired = (data) => {
        console.log('[App] Paired!');
        Toast.success('จับคู่อุปกรณ์สำเร็จแล้ว!');

        // Determine who initiates the WebRTC connection.
        // The 'initiator' (first to join the room) creates the offer.
        this.peer = new PeerConnection(this.signaling);

        this.peer.onDataChannelOpen = () => {
          console.log('[App] Data channel open — ready for transfers');
          this._onConnected();
        };

        this.peer.onDataChannelClose = () => {
          Toast.info('อุปกรณ์อีกฝั่งตัดการเชื่อมต่อแล้ว');
        };

        // Forward signaling messages to the peer connection
        this.signaling.onMessage = (msg) => {
          this.peer.handleSignalingMessage(msg);
        };

        // Start WebRTC handshake
        if (data.role === 'initiator') {
          this.peer.startAsInitiator();
        } else {
          this.peer.startAsJoiner();
        }
      };

      this.signaling.onDisconnect = () => {
        console.log('[App] Signaling disconnected');
      };

      this.signaling.onError = (error) => {
        Toast.error(error);
        UI.hide('join-spinner');
        document.getElementById('btn-join').disabled = false;
      };

      this.signaling.connect(code);
    },

    /** Called when the WebRTC data channel is open and ready. */
    _onConnected() {
      // Set up file transfer
      this.transfer = new FileTransfer(this.peer);

      if (this.mode === 'send') {
        // Show the send interface
        UI.hide('send-step-pair');
        UI.show('send-step-connected');

        this._setupSendCallbacks();
      } else {
        // Show the receive interface
        UI.hide('recv-step-pair');
        UI.show('recv-step-connected');

        this._setupReceiveCallbacks();
      }
    },

    // ---- SEND MODE ----

    /** Set up file transfer callbacks for the sender. */
    _setupSendCallbacks() {
      this.transfer.onSendProgress = (id, sent, total) => {
        this._updateTransferProgress('send', id, sent, total);
      };

      this.transfer.onSendComplete = (id, name) => {
        this._markTransferComplete('send', id, name);
        Toast.success(`ส่งไฟล์ "${name}" สำเร็จแล้ว!`);
      };

      this.transfer.onSendError = (id, error) => {
        this._markTransferError('send', id, error);
        Toast.error(`การส่งไฟล์ล้มเหลว: ${error}`);
      };

      // Sender can also receive text from the peer
      this.transfer.onTextReceived = (text) => {
        Toast.info('ได้รับข้อความจากอีกเครื่อง');
      };
    },

    /** Add files to the selected files list. */
    addFiles(fileList) {
      const list = document.getElementById('selected-files-list');

      for (const file of fileList) {
        const id = uid();
        this._fileIdMap.set(id, file);
        this.selectedFiles.push({ id, file });

        const li = document.createElement('li');
        li.className = 'file-item';
        li.id = `sel-${id}`;
        li.innerHTML = `
          <div class="file-icon">${getExtension(file.name)}</div>
          <div class="file-info">
            <div class="file-name">${this._escapeHtml(file.name)}</div>
            <div class="file-size">${formatBytes(file.size)}</div>
          </div>
          <div class="file-action">
            <button class="btn-remove" data-id="${id}" aria-label="ลบ">&times;</button>
          </div>
        `;
        list.appendChild(li);

        // Remove button handler
        li.querySelector('.btn-remove').addEventListener('click', () => {
          this.selectedFiles = this.selectedFiles.filter(f => f.id !== id);
          this._fileIdMap.delete(id);
          li.remove();
          if (this.selectedFiles.length === 0) {
            UI.hide('selected-files-section');
          }
        });
      }

      if (this.selectedFiles.length > 0) {
        UI.show('selected-files-section');
      }
    },

    /** Send all selected files through the data channel. */
    sendAllFiles() {
      if (this.selectedFiles.length === 0) {
        Toast.info('ยังไม่ได้เลือกไฟล์');
        return;
      }

      if (!this.transfer || !this.peer?.dataChannel ||
          this.peer.dataChannel.readyState !== 'open') {
        Toast.error('ยังไม่ได้เชื่อมต่อกับอีกเครื่อง');
        return;
      }

      // Create progress entries
      const files = this.selectedFiles.map(f => f.file);
      for (const { id, file } of this.selectedFiles) {
        this._createTransferEntry('send', id, file.name, file.size);
      }
      UI.show('send-transfers');

      // Start the transfer
      this.transfer.sendFiles(files);

      // Clear selected files list
      this.selectedFiles = [];
      this._fileIdMap.clear();
      document.getElementById('selected-files-list').innerHTML = '';
      UI.hide('selected-files-section');
    },

    /** Send a text message. */
    sendTextMessage() {
      const textarea = document.getElementById('text-input');
      const text = textarea.value.trim();
      if (!text) return;

      if (!this.transfer || !this.peer?.dataChannel ||
          this.peer.dataChannel.readyState !== 'open') {
        Toast.error('ยังไม่ได้เชื่อมต่อกับอีกเครื่อง');
        return;
      }

      this.transfer.sendText(text);
      textarea.value = '';
      Toast.success('ส่งข้อความเรียบร้อยแล้ว!');
    },

    // ---- RECEIVE MODE ----

    /** Set up file transfer callbacks for the receiver. */
    _setupReceiveCallbacks() {
      this.transfer.onReceiveStart = (id, name, size) => {
        document.getElementById('recv-empty').classList.add('hidden');
        this._createTransferEntry('recv', id, name, size);
        UI.show('recv-transfers');
      };

      this.transfer.onReceiveProgress = (id, received, total) => {
        this._updateTransferProgress('recv', id, received, total);
      };

      this.transfer.onReceiveComplete = (id, name, blob) => {
        this._markTransferComplete('recv', id, name);
        this._addReceivedFile(id, name, blob);
        Toast.success(`ได้รับไฟล์ "${name}" แล้ว!`);
      };

      this.transfer.onTextReceived = (text, timestamp) => {
        this._addReceivedText(text, timestamp);
        Toast.info('ได้รับข้อความใหม่');
      };
    },

    /** Add a received file to the download list. */
    _addReceivedFile(id, name, blob) {
      const list = document.getElementById('received-files-list');
      const url = URL.createObjectURL(blob);

      const li = document.createElement('li');
      li.className = 'file-item';
      li.innerHTML = `
        <div class="file-icon">${getExtension(name)}</div>
        <div class="file-info">
          <div class="file-name">${this._escapeHtml(name)}</div>
          <div class="file-size">${formatBytes(blob.size)}</div>
        </div>
        <div class="file-action">
          <a class="btn-download" href="${url}" download="${this._escapeHtml(name)}">ดาวน์โหลด</a>
        </div>
      `;
      list.appendChild(li);
    },

    /** Add a received text message to the messages section. */
    _addReceivedText(text, timestamp) {
      UI.show('recv-texts-section');
      const container = document.getElementById('received-texts');

      const div = document.createElement('div');
      div.className = 'text-bubble';
      div.innerHTML = `
        <span>${this._escapeHtml(text)}</span>
        <button class="text-copy" aria-label="คัดลอกข้อความ">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
        <div class="text-time">${new Date(timestamp || Date.now()).toLocaleTimeString()}</div>
      `;

      // Copy button
      div.querySelector('.text-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(text).then(() => {
          Toast.success('คัดลอกข้อความแล้ว!');
        });
      });

      container.appendChild(div);
    },

    // ---- TRANSFER PROGRESS UI ----

    /** Create a progress entry in the transfer list. */
    _createTransferEntry(prefix, id, name, size) {
      const list = document.getElementById(`${prefix}-transfer-list`);
      const li = document.createElement('li');
      li.className = 'transfer-item';
      li.id = `tf-${prefix}-${id}`;
      li.innerHTML = `
        <div class="transfer-header">
          <span class="transfer-name">${this._escapeHtml(name)}</span>
          <span class="transfer-percent" id="pct-${prefix}-${id}">0%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" id="bar-${prefix}-${id}"></div>
        </div>
        <div class="transfer-status" id="stat-${prefix}-${id}">
          0 B / ${formatBytes(size)}
        </div>
      `;
      list.appendChild(li);
    },

    /** Update the progress bar for a transfer. */
    _updateTransferProgress(prefix, id, current, total) {
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      const pctEl = document.getElementById(`pct-${prefix}-${id}`);
      const barEl = document.getElementById(`bar-${prefix}-${id}`);
      const statEl = document.getElementById(`stat-${prefix}-${id}`);

      if (pctEl) pctEl.textContent = pct + '%';
      if (barEl) barEl.style.width = pct + '%';
      if (statEl) statEl.textContent = `${formatBytes(current)} / ${formatBytes(total)}`;
    },

    /** Mark a transfer as complete. */
    _markTransferComplete(prefix, id, name) {
      const pctEl = document.getElementById(`pct-${prefix}-${id}`);
      const barEl = document.getElementById(`bar-${prefix}-${id}`);
      const statEl = document.getElementById(`stat-${prefix}-${id}`);

      if (pctEl) pctEl.textContent = '100%';
      if (barEl) barEl.style.width = '100%';
      if (statEl) {
        statEl.textContent = '✓ สำเร็จ';
        statEl.classList.add('success');
      }
    },

    /** Mark a transfer as failed. */
    _markTransferError(prefix, id, error) {
      const pctEl = document.getElementById(`pct-${prefix}-${id}`);
      const statEl = document.getElementById(`stat-${prefix}-${id}`);

      if (pctEl) pctEl.textContent = 'ข้อผิดพลาด';
      if (statEl) {
        statEl.textContent = '✗ ' + error;
        statEl.classList.add('error');
      }
    },

    // ---- CODE INPUT (receiver) ----

    /** Set up the 6-digit code input with auto-advance. */
    _setupCodeInput() {
      const cells = document.querySelectorAll('.code-cell');

      cells.forEach((cell, index) => {
        // Allow only digits
        cell.addEventListener('input', (e) => {
          const val = e.target.value.replace(/\D/g, '');
          e.target.value = val;
          if (val && index < cells.length - 1) {
            cells[index + 1].focus();
          }
          this._checkCodeComplete();
        });

        // Handle backspace — go to previous cell
        cell.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !cell.value && index > 0) {
            cells[index - 1].focus();
            cells[index - 1].value = '';
          }
          // Enter to join
          if (e.key === 'Enter') {
            this.joinRoom();
          }
        });

        // Handle paste — spread digits across cells
        cell.addEventListener('paste', (e) => {
          e.preventDefault();
          const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '');
          for (let i = 0; i < Math.min(pasted.length, cells.length); i++) {
            cells[i].value = pasted[i];
          }
          if (pasted.length >= cells.length) {
            cells[cells.length - 1].focus();
          } else {
            cells[Math.min(pasted.length, cells.length - 1)].focus();
          }
          this._checkCodeComplete();
        });
      });
    },

    /** Enable the Connect button when all 6 digits are entered. */
    _checkCodeComplete() {
      let code = '';
      document.querySelectorAll('.code-cell').forEach(c => code += c.value);
      document.getElementById('btn-join').disabled = code.length !== 6;
    },

    // ---- DRAG & DROP ----

    _setupDragDrop() {
      const dropZone = document.getElementById('drop-zone');
      if (!dropZone) return;

      // Click the drop zone to browse files
      dropZone.addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON') {
          document.getElementById('file-input').click();
        }
      });

      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      });

      dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
      });

      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) {
          this.addFiles(e.dataTransfer.files);
        }
      });
    },

    // ---- HELPERS ----

    _escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  };

  // ==========================================================
  //  BOOTSTRAP — start the app when DOM is ready
  // ==========================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init());
  } else {
    App.init();
  }

  // Check for join code in URL on initial load
  window.addEventListener('hashchange', () => {
    const hash = location.hash;
    if (hash.startsWith('#join:')) {
      App.startReceiveMode();
    }
  });

})();
