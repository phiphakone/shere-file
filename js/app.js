// =============================================
// DropShare — ระบบส่งไฟล์ P2P (PeerJS WebRTC Engine)
// =============================================
// ทำงานผ่าน WebRTC Peer-to-Peer 100% 
// ใช้คลาวด์ Signaling ฟรีของ PeerJS ไม่ต้องตั้งค่าเซิร์ฟเวอร์เอง
// รองรับการทำงานบน GitHub Pages ได้ทันที
// =============================================

(function () {
  'use strict';

  const CONFIG = {
    // ขนาดของชิ้นส่วนไฟล์ (Chunk) 64 KB เพื่อความเสถียรบนมือถือ
    chunkSize: 65536,
    // รหัส Prefix ป้องกันชื่อห้องชนกับโปรเจกต์อื่น
    roomPrefix: 'dropshare-v2-'
  };

  // ==========================================================
  //  ตัวช่วยทั่วไป (UTILITY HELPERS)
  // ==========================================================

  /** สุ่มรหัสตัวเลข 6 หลัก */
  function generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  /** แปลงขนาดไบต์เป็นข้อความที่อ่านง่าย (KB, MB, GB) */
  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  /** สุ่ม ID สั้นๆ */
  function uid() {
    return Math.random().toString(36).substring(2, 10);
  }

  /** ดึงนามสกุลไฟล์ */
  function getExtension(name) {
    const parts = name.split('.');
    return parts.length > 1 ? parts.pop().toUpperCase() : 'FILE';
  }

  // ==========================================================
  //  ระบบแจ้งเตือน (TOAST NOTIFICATIONS)
  // ==========================================================
  const Toast = {
    container: null,

    init() {
      this.container = document.getElementById('toast-container');
    },

    show(message, type = 'info') {
      if (!this.container) return;
      const el = document.createElement('div');
      el.className = `toast toast-${type}`;
      el.textContent = message;
      this.container.appendChild(el);
      setTimeout(() => el.remove(), 3200);
    },

    success(msg) { this.show(msg, 'success'); },
    error(msg)   { this.show(msg, 'error'); },
    info(msg)    { this.show(msg, 'info'); }
  };

  // ==========================================================
  //  การจัดการหน้าจอ (UI MANAGER)
  // ==========================================================
  const UI = {
    screens: {},
    currentScreen: 'home',

    init() {
      document.querySelectorAll('.screen').forEach(el => {
        const id = el.id.replace('screen-', '');
        this.screens[id] = el;
      });

      document.querySelectorAll('.btn-back').forEach(btn => {
        btn.addEventListener('click', () => {
          App.handleBack();
        });
      });
    },

    showScreen(name) {
      if (this.screens[this.currentScreen]) {
        this.screens[this.currentScreen].classList.remove('active');
      }
      if (this.screens[name]) {
        this.screens[name].classList.add('active');
        this.currentScreen = name;
      }
    },

    show(id) { document.getElementById(id)?.classList.remove('hidden'); },
    hide(id) { document.getElementById(id)?.classList.add('hidden'); }
  };

  // ==========================================================
  //  ตัวควบคุมหลักของแอปพลิเคชัน (MAIN APP CONTROLLER)
  // ==========================================================
  const App = {
    peer: null,          // อ็อบเจกต์ PeerJS
    conn: null,          // DataConnection WebRTC ระหว่างสองเครื่อง
    pairingCode: '',     // รหัส 6 หลัก
    mode: '',            // 'send' หรือ 'receive'
    selectedFiles: [],   // ไฟล์ที่ผู้ส่งเลือกไว้
    _fileIdMap: new Map(),
    incomingFiles: new Map(), // จัดเก็บชิ้นส่วนไฟล์ที่ผู้รับกำลังได้รับ

    init() {
      Toast.init();
      UI.init();

      // ปุ่มหน้าแรก
      document.getElementById('btn-send').addEventListener('click', () => this.startSendMode());
      document.getElementById('btn-receive').addEventListener('click', () => this.startReceiveMode());

      // หน้าส่งไฟล์: เลือกไฟล์
      document.getElementById('btn-browse').addEventListener('click', () => {
        document.getElementById('file-input').click();
      });
      document.getElementById('file-input').addEventListener('change', (e) => {
        this.addFiles(e.target.files);
        e.target.value = '';
      });
      document.getElementById('btn-add-more').addEventListener('click', () => {
        document.getElementById('file-input').click();
      });
      document.getElementById('btn-send-files').addEventListener('click', () => this.sendAllFiles());
      document.getElementById('btn-send-text').addEventListener('click', () => this.sendTextMessage());

      // ปุ่มคัดลอกรหัส
      document.getElementById('btn-copy-code').addEventListener('click', () => {
        navigator.clipboard.writeText(this.pairingCode).then(() => {
          Toast.success('คัดลอกรหัสเรียบร้อยแล้ว!');
        }).catch(() => {
          Toast.error('ไม่สามารถคัดลอกรหัสได้');
        });
      });

      // หน้ารับไฟล์: กรอกรหัส
      this._setupCodeInput();
      document.getElementById('btn-join').addEventListener('click', () => this.joinRoom());

      // Drag & Drop
      this._setupDragDrop();

      // ปุ่ม Enter เพื่อส่งข้อความ
      document.getElementById('text-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendTextMessage();
        }
      });

      // ตรวจสอบรหัสจาก URL Hash ตอนเปิดเว็บครั้งแรก (เช่น #join:123456)
      this._checkUrlHash();

      console.log('[DropShare] พร้อมใช้งาน 100%');
    },

    // ---- 1. โหมดส่งไฟล์ (SEND MODE) ----

    startSendMode() {
      this.mode = 'send';
      this.pairingCode = generateCode();
      this.selectedFiles = [];
      this._fileIdMap.clear();

      // แสดงรหัส 6 หลักบนหน้าจอ
      const digits = this.pairingCode.split('');
      for (let i = 0; i < 6; i++) {
        document.getElementById('d' + (i + 1)).textContent = digits[i];
      }

      // สร้าง QR Code ให้สแกนได้ทันที
      const qrContainer = document.getElementById('qr-container');
      qrContainer.innerHTML = '';
      const qrUrl = `${location.origin}${location.pathname}#join:${this.pairingCode}`;
      if (typeof QRCode !== 'undefined') {
        QRCode.toCanvas(qrContainer, qrUrl, {
          width: 160,
          margin: 1,
          color: { dark: '#000000', light: '#ffffff' }
        }, (err) => {
          if (err) console.error(err);
        });
      }

      UI.show('send-step-pair');
      UI.hide('send-step-connected');
      UI.showScreen('send');

      // เริ่มสร้างห้องผ่าน PeerJS ด้วยรหัสห้อง dropshare-v2-<รหัส 6 หลัก>
      const peerId = CONFIG.roomPrefix + this.pairingCode;
      this._initPeerAsHost(peerId);
    },

    /** ผู้ส่งทำหน้าที่เป็น Host รอรับการเชื่อมต่อ */
    _initPeerAsHost(peerId) {
      this._destroyPeer();

      try {
        this.peer = new Peer(peerId);
      } catch (err) {
        console.error(err);
        Toast.error('ไม่สามารถสร้างห้องส่งไฟล์ได้ กรุณาลองใหม่อีกครั้ง');
        return;
      }

      this.peer.on('open', (id) => {
        console.log('[Host] ห้องพร้อมแล้ว ID:', id);
      });

      // เมื่อมีเครื่องอื่น (ผู้รับ) กดเชื่อมต่อเข้ามา
      this.peer.on('connection', (conn) => {
        console.log('[Host] มีเครื่องเชื่อมต่อเข้ามา!');
        this.conn = conn;
        this._setupConnectionHandlers(conn);
      });

      this.peer.on('error', (err) => {
        console.warn('[Host Error]', err);
        if (err.type === 'unavailable-id') {
          // หากรหัสซ้ำ ให้สุ่มรหัสใหม่
          this.startSendMode();
        } else {
          Toast.error('การเชื่อมต่อขัดข้อง: ' + (err.message || err.type));
        }
      });
    },

    // ---- 2. โหมดรับไฟล์ (RECEIVE MODE) ----

    startReceiveMode() {
      this.mode = 'receive';

      document.querySelectorAll('.code-cell').forEach(input => input.value = '');
      document.getElementById('btn-join').disabled = true;

      UI.show('recv-step-pair');
      UI.hide('recv-step-connected');
      UI.showScreen('receive');

      this._checkUrlHash();
      document.querySelector('.code-cell[data-idx="1"]')?.focus();
    },

    /** ผู้รับกดเชื่อมต่อไปยังห้องของผู้ส่ง */
    joinRoom() {
      let code = '';
      document.querySelectorAll('.code-cell').forEach(input => code += input.value);

      if (!/^\d{6}$/.test(code)) {
        Toast.error('กรุณากรอกรหัสตัวเลขให้ครบ 6 หลัก');
        return;
      }

      this.pairingCode = code;
      document.getElementById('btn-join').disabled = true;
      UI.show('join-spinner');

      this._destroyPeer();

      try {
        // ผู้รับสุ่ม ID ตัวเอง แล้วต่อหา Host
        this.peer = new Peer();
      } catch (err) {
        Toast.error('ไม่สามารถเปิดใช้งาน WebRTC ได้');
        UI.hide('join-spinner');
        document.getElementById('btn-join').disabled = false;
        return;
      }

      this.peer.on('open', () => {
        const targetHostId = CONFIG.roomPrefix + code;
        console.log('[Joiner] กำลังเชื่อมต่อไปยัง:', targetHostId);

        const conn = this.peer.connect(targetHostId, { reliable: true });
        this.conn = conn;
        this._setupConnectionHandlers(conn);
      });

      this.peer.on('error', (err) => {
        console.warn('[Joiner Error]', err);
        UI.hide('join-spinner');
        document.getElementById('btn-join').disabled = false;
        Toast.error('ไม่พบเครื่องส่ง หรือรหัส 6 หลักไม่ถูกต้อง');
      });
    },

    // ---- 3. การจัดการการเชื่อมต่อ WEBRTC P2P ----

    _setupConnectionHandlers(conn) {
      conn.on('open', () => {
        console.log('[P2P] เชื่อมต่อหากันสำเร็จแล้ว!');
        Toast.success('จับคู่อุปกรณ์สำเร็จแล้ว!');
        UI.hide('join-spinner');

        if (this.mode === 'send') {
          UI.hide('send-step-pair');
          UI.show('send-step-connected');
        } else {
          UI.hide('recv-step-pair');
          UI.show('recv-step-connected');
        }
      });

      // จัดการข้อมูลที่ส่งข้ามเครื่องมา
      conn.on('data', (data) => {
        this._handleIncomingData(data);
      });

      conn.on('close', () => {
        Toast.info('อุปกรณ์อีกฝั่งตัดการเชื่อมต่อแล้ว');
      });

      conn.on('error', (err) => {
        console.error('[Conn Error]', err);
        Toast.error('การเชื่อมต่อขัดข้อง');
      });
    },

    /** จัดการข้อมูลที่วิ่งเข้ามาผ่าน WebRTC DataChannel */
    _handleIncomingData(data) {
      if (!data || !data.type) return;

      switch (data.type) {
        // 1. ผู้ส่งแจ้งว่าเริ่มส่งไฟล์
        case 'file-start':
          this.incomingFiles.set(data.id, {
            name: data.name,
            size: data.size,
            mimeType: data.mimeType,
            receivedBytes: 0,
            chunks: []
          });
          document.getElementById('recv-empty')?.classList.add('hidden');
          this._createTransferEntry('recv', data.id, data.name, data.size);
          UI.show('recv-transfers');
          break;

        // 2. ได้รับชิ้นส่วนไฟล์ (Chunk)
        case 'file-chunk': {
          const file = this.incomingFiles.get(data.id);
          if (file) {
            file.chunks.push(data.chunk);
            file.receivedBytes += data.chunk.byteLength || data.chunk.size || 0;
            this._updateTransferProgress('recv', data.id, file.receivedBytes, file.size);
          }
          break;
        }

        // 3. รวมไฟล์เมื่อส่งครบ
        case 'file-end': {
          const file = this.incomingFiles.get(data.id);
          if (file) {
            const blob = new Blob(file.chunks, { type: file.mimeType });
            this._markTransferComplete('recv', data.id, file.name);
            this._addReceivedFile(data.id, file.name, blob);
            this.incomingFiles.delete(data.id);
            Toast.success(`ได้รับไฟล์ "${file.name}" แล้ว!`);
          }
          break;
        }

        // 4. ได้รับข้อความ
        case 'text-message':
          this._addReceivedText(data.text, data.timestamp);
          Toast.info('ได้รับข้อความใหม่');
          break;
      }
    },

    // ---- 4. ส่งไฟล์และข้อความ (SEND ACTIONS) ----

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

    async sendAllFiles() {
      if (this.selectedFiles.length === 0) {
        Toast.info('ยังไม่ได้เลือกไฟล์');
        return;
      }
      if (!this.conn || !this.conn.open) {
        Toast.error('ยังไม่ได้เชื่อมต่อกับอีกเครื่อง');
        return;
      }

      const filesToSend = [...this.selectedFiles];
      this.selectedFiles = [];
      this._fileIdMap.clear();
      document.getElementById('selected-files-list').innerHTML = '';
      UI.hide('selected-files-section');

      UI.show('send-transfers');

      for (const { id, file } of filesToSend) {
        this._createTransferEntry('send', id, file.name, file.size);
        await this._sendFile(id, file);
      }
    },

    async _sendFile(id, file) {
      // แจ้งเริ่มส่งไฟล์
      this.conn.send({
        type: 'file-start',
        id: id,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream'
      });

      let offset = 0;
      const chunkSize = CONFIG.chunkSize;

      while (offset < file.size) {
        const slice = file.slice(offset, offset + chunkSize);
        const buffer = await slice.arrayBuffer();

        this.conn.send({
          type: 'file-chunk',
          id: id,
          chunk: buffer
        });

        offset += buffer.byteLength;
        this._updateTransferProgress('send', id, offset, file.size);

        // หยุดพักเล็กน้อย 5ms ป้องกัน Buffer ล้นบนมือถือ
        await new Promise(r => setTimeout(r, 5));
      }

      // แจ้งว่าไฟล์ส่งจบแล้ว
      this.conn.send({
        type: 'file-end',
        id: id
      });

      this._markTransferComplete('send', id, file.name);
      Toast.success(`ส่งไฟล์ "${file.name}" สำเร็จแล้ว!`);
    },

    sendTextMessage() {
      const textarea = document.getElementById('text-input');
      const text = textarea.value.trim();
      if (!text) return;

      if (!this.conn || !this.conn.open) {
        Toast.error('ยังไม่ได้เชื่อมต่อกับอีกเครื่อง');
        return;
      }

      this.conn.send({
        type: 'text-message',
        text: text,
        timestamp: Date.now()
      });

      textarea.value = '';
      Toast.success('ส่งข้อความเรียบร้อยแล้ว!');
    },

    // ---- 5. UI การรับไฟล์ & ข้อความ ----

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

      div.querySelector('.text-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(text).then(() => {
          Toast.success('คัดลอกข้อความแล้ว!');
        });
      });

      container.appendChild(div);
    },

    // ---- PROGRESS BARS ----

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

    _updateTransferProgress(prefix, id, current, total) {
      const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
      const pctEl = document.getElementById(`pct-${prefix}-${id}`);
      const barEl = document.getElementById(`bar-${prefix}-${id}`);
      const statEl = document.getElementById(`stat-${prefix}-${id}`);

      if (pctEl) pctEl.textContent = pct + '%';
      if (barEl) barEl.style.width = pct + '%';
      if (statEl) statEl.textContent = `${formatBytes(current)} / ${formatBytes(total)}`;
    },

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

    // ---- การควบคุม CODE INPUT & BACK ----

    handleBack() {
      this._destroyPeer();
      this.selectedFiles = [];
      this._fileIdMap.clear();

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
      document.getElementById('recv-empty')?.classList.remove('hidden');
      UI.hide('recv-texts-section');
      document.getElementById('received-texts').innerHTML = '';
      document.getElementById('recv-transfer-list').innerHTML = '';
      UI.hide('recv-transfers');

      UI.showScreen('home');
    },

    _destroyPeer() {
      if (this.conn) {
        try { this.conn.close(); } catch(e){}
        this.conn = null;
      }
      if (this.peer) {
        try { this.peer.destroy(); } catch(e){}
        this.peer = null;
      }
    },

    _setupCodeInput() {
      const cells = document.querySelectorAll('.code-cell');

      cells.forEach((cell, index) => {
        cell.addEventListener('input', (e) => {
          const val = e.target.value.replace(/\D/g, '');
          e.target.value = val;
          if (val && index < cells.length - 1) {
            cells[index + 1].focus();
          }
          this._checkCodeComplete();
        });

        cell.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !cell.value && index > 0) {
            cells[index - 1].focus();
            cells[index - 1].value = '';
          }
          if (e.key === 'Enter') {
            this.joinRoom();
          }
        });

        cell.addEventListener('paste', (e) => {
          e.preventDefault();
          const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '');
          for (let i = 0; i < Math.min(pasted.length, cells.length); i++) {
            cells[i].value = pasted[i];
          }
          this._checkCodeComplete();
        });
      });
    },

    _checkCodeComplete() {
      let code = '';
      document.querySelectorAll('.code-cell').forEach(c => code += c.value);
      document.getElementById('btn-join').disabled = code.length !== 6;
    },

    _setupDragDrop() {
      const dropZone = document.getElementById('drop-zone');
      if (!dropZone) return;

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

    _checkUrlHash() {
      const hash = location.hash;
      if (hash.startsWith('#join:')) {
        const code = hash.substring(6);
        if (/^\d{6}$/.test(code)) {
          const digits = code.split('');
          document.querySelectorAll('.code-cell').forEach((input, i) => {
            input.value = digits[i] || '';
          });
          document.getElementById('btn-join').disabled = false;
          location.hash = '';
          setTimeout(() => this.joinRoom(), 300);
        }
      }
    },

    _escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init());
  } else {
    App.init();
  }

  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#join:')) {
      App.startReceiveMode();
    }
  });

})();
