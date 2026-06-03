/**
 * RapidPair Web Component v1.0
 *
 * Drop-in <rapid-pair> custom element for secure, encrypted device pairing.
 * Handles WebRTC, Firebase signaling, ECDH key exchange, QR codes, and
 * verification — behind a simple send() / on() API.
 *
 * Dependencies (load before this script):
 *   - pako.min.js    (compression for QR payloads)
 *   - qrcode.js      (QR generation)
 *   - html5-qrcode.min.js (QR scanning)
 *
 * Usage:
 *   <rapid-pair id="pair"
 *     controller-label="Clinician"
 *     responder-label="Client"
 *     auto-close="true">
 *   </rapid-pair>
 *
 *   const pair = document.getElementById('pair');
 *   pair.addEventListener('secure', e => { ... });
 *   pair.send('my-type', { data: 123 });
 *   pair.on('my-type', payload => { ... });
 */

(function () {
  'use strict';

  /* ================================================================
   *  STYLES — injected into Shadow DOM
   * ================================================================ */
  const COMPONENT_CSS = `
    rapid-pair { display: block; }

    .rp-modal {
      display: flex;
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: rgba(0,0,0,0.6);
      justify-content: center;
      align-items: center;
      z-index: 10000;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 15px;
      color: #222;
    }

    .rp-container {
      background: #fff;
      border-radius: 16px;
      padding: 24px;
      max-width: 480px;
      width: 92%;
      max-height: 92vh;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      box-shadow: 0 8px 32px rgba(0,0,0,0.25);
      position: relative;
    }

    .rp-modal h2 { font-size: 17px; margin-bottom: 12px; }

    .rp-step { display: none; }
    .rp-step.rp-active { display: block; }

    .rp-modal button {
      padding: 10px 20px;
      border-radius: 10px;
      border: 1px solid #ccc;
      background: #f5f5f5;
      cursor: pointer;
      font-size: 15px;
      margin: 4px;
      font-family: inherit;
    }
    .rp-modal button:disabled { opacity: .55; cursor: not-allowed; }
    .rp-primary {
      background: var(--rp-primary, #1976d2) !important;
      border-color: var(--rp-primary, #1976d2) !important;
      color: #fff !important;
      font-weight: 600;
    }
    .rp-modal button.rp-success { background: #e8f5e9; border-color: #4caf50; }
    .rp-warning { background: #fff8e1 !important; border-color: #f57c00 !important; color: #e65100 !important; }

    .rp-modal input {
      padding: 10px;
      border: 1px solid #ccc;
      border-radius: 8px;
      font-size: 16px;
      font-family: inherit;
      width: 100%;
      box-sizing: border-box;
    }
    .rp-textarea {
      padding: 10px;
      border: 1px solid #ccc;
      border-radius: 8px;
      font-size: 12px;
      font-family: monospace;
      width: 100%;
      box-sizing: border-box;
      height: 72px;
    }

    .rp-hint { font-size: .88rem; color: #666; margin: 8px 0; }
    .rp-instruction { font-size: 1.05rem; font-weight: 600; margin: 10px 0; color: #333; }
    .rp-mono {
      font-family: monospace; letter-spacing: 2px; font-size: 28px;
      font-weight: 700; text-align: center; padding: 18px;
      background: #f0f0f0; border-radius: 8px; margin: 14px 0;
    }

    .rp-status-indicator {
      background: #f0f7ff; border: 1px solid #90caf9; border-radius: 8px;
      padding: 10px 14px; margin: 12px 0; font-size: 14px;
      text-align: center; color: #1565c0; font-weight: 500; display: none;
    }
    .rp-status-indicator.rp-active { display: block; }
    @keyframes rp-pulse { 0%,100%{opacity:1} 50%{opacity:.6} }
    .rp-status-indicator.rp-loading { animation: rp-pulse 1.5s ease-in-out infinite; display: block; }
    .rp-status-indicator.rp-success { background: #e8f5e9; border-color: #81c784; color: #2e7d32; display: block; }
    .rp-status-indicator.rp-error   { background: #ffebee; border-color: #e57373; color: #c62828; display: block; }

    .rp-verify-bar {
      background: #f1f8e9; border: 1px solid #c5e1a5; border-radius: 10px;
      padding: 14px 16px; margin: 10px 0; text-align: center;
    }
    .rp-verify-code {
      font-size: 2.4rem; font-weight: 800; letter-spacing: 6px;
      font-family: monospace; margin: 6px 0; color: #1b5e20;
    }
    .rp-verify-label { font-size: .85rem; color: #558b2f; font-weight: 600; }
    .rp-verify-hint  { font-size: .8rem; color: #666; margin-top: 6px; line-height: 1.4; }
    .rp-verify-buttons { display: flex; gap: 10px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
    .rp-verify-buttons button { padding: 14px 28px; border-radius: 10px; font-size: 16px; font-weight: 600; min-height: 48px; }
    .rp-btn-match    { background: #e8f5e9 !important; border: 2px solid #4caf50 !important; color: #2e7d32 !important; }
    .rp-btn-match:hover { background: #c8e6c9 !important; }
    .rp-btn-no-match { background: #ffebee !important; border: 2px solid #e57373 !important; color: #c62828 !important; }
    .rp-btn-no-match:hover { background: #ffcdd2 !important; }

    .rp-verify-mismatch {
      background: #ffebee; border: 2px solid #e57373; border-radius: 10px;
      padding: 16px; margin: 10px 0; text-align: center; display: none;
    }
    .rp-warn-icon { font-size: 2rem; }
    .rp-warn-text { font-size: 1rem; font-weight: 600; color: #c62828; margin: 8px 0; }
    .rp-warn-detail { font-size: .85rem; color: #666; }

    .rp-secure-badge {
      display: inline-flex; align-items: center; gap: 6px;
      background: #e8f5e9; border: 1.5px solid #4caf50; border-radius: 20px;
      padding: 4px 14px; font-size: .92rem; font-weight: 600; color: #2e7d32;
    }
    .rp-encryption-info { font-size: .78rem; color: #666; margin: 8px 0; }
    .rp-encryption-info code { background: #f0f0f0; padding: 1px 5px; border-radius: 3px; font-size: .73rem; }

    .rp-qr-wrap { text-align: center; margin: 14px auto; cursor: pointer; background: #fff; padding: 16px; border-radius: 8px; }
    .rp-qr-wrap svg { display: block; margin: 0 auto; background: #fff; padding: 8px; max-width: 100%; height: auto; }
    .rp-qr-nav { display: flex; gap: 8px; align-items: center; justify-content: center; margin-top: 8px; flex-wrap: wrap; }
    .rp-qr-nav label { display: inline-flex; align-items: center; gap: 4px; font-size: .9rem; }

    .rp-qr-section { display: none; margin-top: 16px; padding: 12px; background: #f9f9f9; border-radius: 8px; }
    .rp-qr-section h3 { margin: 0 0 10px; font-size: 14px; color: #666; }

    .rp-reader-box { width: 100%; max-width: 360px; margin: 10px auto; }

    .rp-qr-overlay {
      display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.9); z-index: 11000;
      align-items: center; justify-content: center; flex-direction: column;
    }
    .rp-qr-overlay.rp-active { display: flex; }
    .rp-qr-overlay-content { max-width: 90vw; max-height: 90vh; text-align: center; }
    .rp-qr-overlay svg { max-width: 90vmin; max-height: 90vmin; }
    .rp-qr-overlay-close {
      position: absolute; top: 16px; right: 16px;
      background: #fff; border: none; border-radius: 50%;
      width: 36px; height: 36px; font-size: 22px; cursor: pointer;
    }

    .rp-close-btn {
      position: absolute; top: 12px; right: 16px; background: none;
      border: none; font-size: 22px; cursor: pointer; color: #999; padding: 4px 8px;
    }
    .rp-close-btn:hover { color: #333; }

    .rp-modal details { margin-top: 16px; padding: 12px; background: #f9f9f9; border-radius: 8px; }
    .rp-modal details summary { cursor: pointer; font-weight: 600; color: #666; font-size: .95rem; }
  `;

  /* ================================================================
   *  SecureChannel — ECDH P-256 + AES-256-GCM, replay-protected
   * ================================================================ */
  class SecureChannel {
    constructor(dc, isInitiator) {
      this.dc = dc;
      this.isInitiator = isInitiator;
      this.ready = false;
      this.verified = false;
      this.sharedKey = null;
      this.localKeyPair = null;
      this.localPubRaw = null;
      this.peerPubRaw = null;
      this.verifyCode = '';
      this.sendCounter = 0;
      this.recvCounter = 0;
      this._peerReady = false;
      this._onSecure = null;
      this._pendingInbound = [];
      this._pendingOutbound = [];
      this._pendingVerify = [];
    }

    async start() {
      this.localKeyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
      );
      this.localPubRaw = new Uint8Array(
        await crypto.subtle.exportKey('raw', this.localKeyPair.publicKey)
      );
      const pubB64 = btoa(String.fromCharCode(...this.localPubRaw));
      this.dc.send(JSON.stringify({ _sec: 'pubkey', k: pubB64 }));
    }

    async handleMessage(data) {
      let msg;
      try {
        if (typeof data === 'string' && data.startsWith('{"_sec"')) {
          msg = JSON.parse(data);
        }
      } catch (_) { /* not JSON */ }

      if (msg && msg._sec === 'pubkey') { await this._handlePeerKey(msg.k); return true; }
      if (msg && msg._sec === 'ready')  { await this._handleReady(); return true; }

      if (this.ready && typeof data === 'string' && data.startsWith('ENC|')) {
        const plaintext = await this.decrypt(data);
        return { decrypted: plaintext };
      }

      if (!this.ready) {
        if (typeof data === 'string' && data.startsWith('ENC|')) {
          this._pendingInbound.push(data);
        }
        return true;
      }
      return false;
    }

    async _handlePeerKey(peerKeyB64) {
      this.peerPubRaw = Uint8Array.from(atob(peerKeyB64), c => c.charCodeAt(0));
      const peerPub = await crypto.subtle.importKey(
        'raw', this.peerPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []
      );
      const sharedBits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: peerPub }, this.localKeyPair.privateKey, 256
      );
      const saltInput = this._sortedKeyConcat(this.localPubRaw, this.peerPubRaw);
      const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', saltInput));
      const sharedMaterial = await crypto.subtle.importKey(
        'raw', sharedBits, 'HKDF', false, ['deriveKey', 'deriveBits']
      );
      this.sharedKey = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('rapidpair-e2e-v1') },
        sharedMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
      const verifyBits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('rapidpair-verify-v1') },
        sharedMaterial, 16
      );
      const vb = new Uint8Array(verifyBits);
      this.verifyCode = String.fromCharCode(65 + (vb[0] % 26)) + (vb[1] % 10);

      this.dc.send(JSON.stringify({ _sec: 'ready' }));
      if (this._peerReady) this._finalize();
    }

    _sortedKeyConcat(a, b) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] < b[i]) return this._concat(a, b);
        if (a[i] > b[i]) return this._concat(b, a);
      }
      return this._concat(a, b);
    }
    _concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

    async _handleReady() { this._peerReady = true; if (this.sharedKey) this._finalize(); }

    async _finalize() {
      this.ready = true;
      this.verified = false;
      for (const pending of this._pendingInbound) {
        const pt = await this.decrypt(pending);
        if (pt !== null) this._pendingVerify.push(pt);
      }
      this._pendingInbound = [];
      if (this._onSecure) this._onSecure();
    }

    async encrypt(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const counter = this.sendCounter++;
      const aad = new ArrayBuffer(8);
      const v = new DataView(aad);
      v.setUint32(0, Math.floor(counter / 0x100000000), false);
      v.setUint32(4, counter >>> 0, false);
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new Uint8Array(aad), tagLength: 128 },
        this.sharedKey, new TextEncoder().encode(plaintext)
      );
      return `ENC|${counter}|${btoa(String.fromCharCode(...iv))}|${btoa(String.fromCharCode(...new Uint8Array(ct)))}`;
    }

    async decrypt(data) {
      try {
        const parts = data.split('|');
        if (parts[0] !== 'ENC' || parts.length !== 4) return null;
        const counter = parseInt(parts[1], 10);
        if (isNaN(counter) || counter < 0) return null;
        if (counter < this.recvCounter) return null;
        if (counter > this.recvCounter + 1000) return null;
        this.recvCounter = counter + 1;
        const aad = new ArrayBuffer(8);
        const v = new DataView(aad);
        v.setUint32(0, Math.floor(counter / 0x100000000), false);
        v.setUint32(4, counter >>> 0, false);
        const iv = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
        const ct = Uint8Array.from(atob(parts[3]), c => c.charCodeAt(0));
        const buf = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: new Uint8Array(aad), tagLength: 128 },
          this.sharedKey, ct
        );
        return new TextDecoder().decode(buf);
      } catch (_) { return null; }
    }
  }

  /* ================================================================
   *  RapidPair — the custom element
   * ================================================================ */
  class RapidPair extends HTMLElement {

    /* ---------- lifecycle ---------- */
    constructor() {
      super();

      // Use a unique prefix for all IDs to avoid collisions in light DOM
      this._uid = 'rp-' + Math.random().toString(36).slice(2, 8);

      // State
      this._role = null;
      this._lastRole = null;
      this._pc = null;
      this._dc = null;
      this._secureChan = null;
      this._hostRef = null;
      this._listeners = {};          // type → Set<callback>
      this._inactivityTimer = null;
      this._cachedTURN = null;
      this._turnPromise = null;
      this._fb = { app: null, db: null, auth: null, initialized: false };
      this._scannerController = null;
      this._scannerResponder = null;
      this._asm = { total: 0, got: new Set(), parts: [] };
      this._qrPacked = '';
      this._qrChunks = [];
      this._qrIdx = 0;
      this._autoTimer = null;
      this._qrPackedResponder = '';
      this._qrChunksResponder = [];
      this._qrIdxResponder = 0;
      this._autoTimerResponder = null;
      this._isGeneratingLanQR = false;
      this._snapshotUnsub = null;
      this._hadPreviousConnection = false;
      this._initialized = false;
    }

    connectedCallback() {
      if (!this._initialized) {
        this._initialized = true;
        this._render();
        this._attachListeners();
        // Pre-fetch TURN credentials
        this._turnPromise = this._getCloudflareTURN().then(s => { this._cachedTURN = s; }).catch(() => {});
      }
      // Auto-open the modal on mount
      this._showModal();
    }

    disconnectedCallback() {
      this._cleanup();
    }

    /* ---------- observed attributes ---------- */
    static get observedAttributes() {
      return ['controller-label', 'responder-label', 'auto-close', 'primary-color', 'code-ttl'];
    }

    get _controllerLabel() { return this.getAttribute('controller-label') || 'Controller'; }
    get _responderLabel()  { return this.getAttribute('responder-label')  || 'Responder'; }
    get _autoClose()       { return this.getAttribute('auto-close') !== 'false'; }
    get _primaryColor()    { return this.getAttribute('primary-color') || '#1976d2'; }
    get _codeTTL()         { return parseInt(this.getAttribute('code-ttl')) || 300; }

    /* ================================================================
     *  PUBLIC API  (as per design doc)
     * ================================================================ */

    /** Send a typed JSON message to the peer. */
    send(type, payload) {
      const json = JSON.stringify({ t: type, p: payload });
      this._sendRaw(json);
    }

    /** Listen for a specific message type from the peer. */
    on(type, callback) {
      if (!this._listeners[type]) this._listeners[type] = new Set();
      this._listeners[type].add(callback);
    }

    /** Remove a listener for a message type. */
    off(type, callback) {
      if (this._listeners[type]) this._listeners[type].delete(callback);
    }

    /** Manually show the pairing modal. */
    open() { this._showModal(); }

    /** Manually hide the pairing modal. */
    close() { this._hideModal(); }

    /** End the connection. */
    disconnect() {
      if (this._snapshotUnsub) { try { this._snapshotUnsub(); } catch (_) {} this._snapshotUnsub = null; }
      if (this._dc) try { this._dc.close(); } catch (_) {}
      if (this._pc) try { this._pc.close(); } catch (_) {}
      this._dc = null;
      this._pc = null;
      this._secureChan = null;
      this.dispatchEvent(new CustomEvent('disconnected', { detail: {} }));
    }

    /** Returns 'controller', 'responder', or null. */
    getRole() { return this._role; }

    /** Returns true if the channel is encrypted and the user confirmed the code. */
    isSecure() { return !!(this._secureChan && this._secureChan.ready && this._secureChan.verified); }

    /* ================================================================
     *  RENDERING
     * ================================================================ */
    _render() {
      // Inject scoped styles into document head (once)
      if (!document.getElementById('rapidpair-styles')) {
        const styleEl = document.createElement('style');
        styleEl.id = 'rapidpair-styles';
        styleEl.textContent = COMPONENT_CSS;
        document.head.appendChild(styleEl);
      }

      // Build the modal HTML
      const html = `
        <div id="${this._uid}-modal" class="rp-modal">
          <div id="${this._uid}-container" class="rp-container">
            <button class="rp-close-btn" id="${this._uid}-closeBtn">&times;</button>

            <!-- Step 1 — Role selection -->
            <div id="${this._uid}-step1" class="rp-step rp-active">
              <h2>Select device role</h2>
              <div style="text-align:center;margin:16px 0">
                <button id="${this._uid}-btnController" class="rp-primary">${this._controllerLabel}</button>
                <button id="${this._uid}-btnResponder" class="rp-primary">${this._responderLabel}</button>
              </div>
            </div>

            <!-- Step 2 — Controller -->
            <div id="${this._uid}-step2controller" class="rp-step">
              <h2>${this._controllerLabel}: Share Connection Code</h2>
              <div id="${this._uid}-controllerStatus" class="rp-status-indicator"></div>
              <div id="${this._uid}-controllerCodeSection">
                <p class="rp-instruction">Share this code with the ${this._responderLabel}:</p>
                <div id="${this._uid}-controllerCode" class="rp-mono">----</div>
                <div style="text-align:center">
                  <button id="${this._uid}-btnCopyCode">Copy Code</button>
                </div>
                <p style="text-align:center;margin-top:10px">
                  <a href="#" id="${this._uid}-btnLanQR" style="display:none;color:#999;font-size:.9rem;text-decoration:none">No internet? Try LAN QR Code →</a>
                </p>
              </div>
              <div class="rp-qr-section" id="${this._uid}-qrSection">
                <h3>LAN QR Code (Same WiFi Only)</h3>
                <div id="${this._uid}-qrDisplayArea">
                  <div class="rp-qr-wrap" id="${this._uid}-qrWrap"></div>
                  <div id="${this._uid}-qrNav" class="rp-qr-nav" style="display:none">
                    <button id="${this._uid}-qrPrev">◀ Prev</button>
                    <span id="${this._uid}-qrIndex"></span>
                    <button id="${this._uid}-qrNext">Next ▶</button>
                    <label><input type="checkbox" id="${this._uid}-autoAdvance" checked><span>Auto (1.5s)</span></label>
                  </div>
                  <div style="text-align:center;margin-top:10px">
                    <button id="${this._uid}-btnCopyQRText">Copy QR Text</button>
                    <button id="${this._uid}-qrTrouble" style="display:none">Trouble scanning?</button>
                  </div>
                  <p class="rp-hint">Scan with ${this._responderLabel}'s camera. Both devices must be on the same WiFi.</p>
                </div>
                <div style="margin-top:14px">
                  <button id="${this._uid}-btnShowCodeAndQR" style="display:none;margin-bottom:8px">▼ Show my code and QR</button>
                  <button id="${this._uid}-scanStartController">Start Camera to Scan Reply</button>
                  <button id="${this._uid}-scanStopController" disabled>Stop Camera</button>
                  <div id="${this._uid}-qrProgressController" style="font-weight:600;color:#666;margin:8px 0;min-height:18px"></div>
                  <div class="rp-reader-box" id="${this._uid}-readerController"></div>
                  <p class="rp-hint" style="margin-top:10px">Or paste the reply QR text:</p>
                  <textarea id="${this._uid}-qrPasteController" class="rp-textarea" placeholder="Paste here..."></textarea>
                  <div style="text-align:center;margin-top:6px">
                    <button id="${this._uid}-qrApplyController">Apply Pasted Text</button>
                  </div>
                </div>
                <button id="${this._uid}-btnHideQR" style="margin-top:10px">Hide QR Code</button>
              </div>
            </div>

            <!-- Step 2 — Responder -->
            <div id="${this._uid}-step2responder" class="rp-step">
              <h2>${this._responderLabel}: Enter Connection Code</h2>
              <div id="${this._uid}-responderStatus" class="rp-status-indicator"></div>
              <div id="${this._uid}-responderCodeSection">
                <p class="rp-instruction">Enter the code from ${this._controllerLabel}:</p>
                <input id="${this._uid}-responderCodeInput" class="rp-mono" placeholder="####" inputmode="numeric"
                  style="text-align:center;font-size:24px;letter-spacing:4px;max-width:280px;margin:12px auto;display:block"/>
                <div style="text-align:center;margin-top:12px">
                  <button id="${this._uid}-btnResponderConnect" class="rp-primary">Connect</button>
                </div>
              </div>
              <details style="margin-top:16px;padding:12px;background:#f9f9f9;border-radius:8px">
                <summary style="cursor:pointer;font-weight:600;color:#666">Alternative: Scan QR Code Instead</summary>
                <div style="text-align:center;margin:12px 0">
                  <button id="${this._uid}-btnShowCodeEntry" style="display:none;margin-bottom:8px">▼ Show code entry</button>
                  <button id="${this._uid}-scanStartResponder">Start Camera</button>
                  <button id="${this._uid}-scanStopResponder" disabled>Stop Camera</button>
                </div>
                <div id="${this._uid}-qrProgressResponder" style="font-weight:600;color:#666;margin:8px 0;min-height:18px"></div>
                <div class="rp-reader-box" id="${this._uid}-readerResponder"></div>
                <p class="rp-hint" style="margin-top:10px">Or paste the QR text:</p>
                <textarea id="${this._uid}-qrPasteResponder" class="rp-textarea" placeholder="Paste here..."></textarea>
                <div style="text-align:center;margin-top:6px">
                  <button id="${this._uid}-qrApplyResponder">Apply Pasted Text</button>
                </div>
              </details>
            </div>

            <!-- Step 4 — Responder reply QR -->
            <div id="${this._uid}-step4responderReply" class="rp-step">
              <p class="rp-instruction">Show this QR to the ${this._controllerLabel}:</p>
              <div class="rp-qr-wrap" id="${this._uid}-qrWrapResponderReply"></div>
              <div id="${this._uid}-qrNavResponder" class="rp-qr-nav" style="display:none">
                <button id="${this._uid}-qrPrevResponder">◀ Prev</button>
                <span id="${this._uid}-qrIndexResponder"></span>
                <button id="${this._uid}-qrNextResponder">Next ▶</button>
                <label><input type="checkbox" id="${this._uid}-autoAdvanceResponder" checked><span>Auto (3s)</span></label>
              </div>
              <div style="text-align:center;margin-top:10px">
                <button id="${this._uid}-btnCopyQRTextResponder">Copy QR Text</button>
                <button id="${this._uid}-qrTroubleResponder" style="display:none">Trouble scanning?</button>
              </div>
              <p class="rp-hint">Waiting for ${this._controllerLabel} to scan…</p>
            </div>

            <!-- Verification step -->
            <div id="${this._uid}-stepVerify" class="rp-step">
              <div style="text-align:center;margin-bottom:10px">
                <span class="rp-secure-badge"><span style="font-size:1.1rem">🔒</span> Encrypted Connection</span>
              </div>
              <div class="rp-verify-bar" id="${this._uid}-verifyBar">
                <div class="rp-verify-label">Security Code</div>
                <div class="rp-verify-code" id="${this._uid}-verifyCode"></div>
                <div class="rp-verify-hint">Does the other device show the same code?</div>
                <div class="rp-verify-buttons">
                  <button class="rp-btn-match" id="${this._uid}-btnVerifyMatch">Yes, codes match</button>
                  <button class="rp-btn-no-match" id="${this._uid}-btnVerifyNoMatch">No, different</button>
                </div>
              </div>
              <p class="rp-encryption-info">End-to-end encrypted · <code>AES-256-GCM</code> + <code>ECDH P-256</code> · DTLS transport</p>

              <div id="${this._uid}-verifyMismatch" class="rp-verify-mismatch">
                <div class="rp-warn-icon">⛔</div>
                <div class="rp-warn-text">Connection may not be secure</div>
                <div class="rp-warn-detail">The codes don't match — this session may have been intercepted.<br>Please disconnect and try again.</div>
                <div style="margin-top:12px"><button id="${this._uid}-btnDisconnectMismatch" class="rp-warning">Disconnect</button></div>
              </div>
            </div>
          </div>
        </div>

        <!-- Fullscreen QR overlay -->
        <div class="rp-qr-overlay" id="${this._uid}-qrOverlay">
          <button class="rp-qr-overlay-close" id="${this._uid}-qrOverlayClose">×</button>
          <div class="rp-qr-overlay-content" id="${this._uid}-qrOverlayContent"></div>
        </div>
      `;

      // CRITICAL: Append modal directly to document.body, not inside the
      // <rapid-pair> element. On mobile browsers, position:fixed elements
      // inside non-body parents have broken touch/click event handling.
      this._modalWrapper = document.createElement('div');
      this._modalWrapper.innerHTML = html;
      document.body.appendChild(this._modalWrapper);
    }

    /* ---------- internal helpers for light DOM queries ---------- */
    _$(sel) {
      // Translate bare #id selectors to UID-prefixed ones
      if (sel.startsWith('#')) {
        return document.getElementById(this._uid + '-' + sel.slice(1));
      }
      return this.querySelector(sel);
    }
    _$$(sel) {
      // For class-based selectors, scope to this element
      return this.querySelectorAll(sel);
    }

    _showModal() { if (this._modalWrapper) this._modalWrapper.style.display = 'block'; const m = this._$('#modal'); if (m) m.style.display = 'flex'; }
    _hideModal() { const m = this._$('#modal'); if (m) m.style.display = 'none'; if (this._modalWrapper) this._modalWrapper.style.display = 'none'; }

    _showStep(id) {
      // Steps live inside the body-appended modal wrapper
      const root = this._modalWrapper || document;
      root.querySelectorAll('.rp-step').forEach(s => s.classList.remove('rp-active'));
      const el = document.getElementById(this._uid + '-' + id);
      if (el) el.classList.add('rp-active');
    }

    _showStatus(sel, html, type = 'loading') {
      const el = this._$(sel);
      if (!el) return;
      el.className = `rp-status-indicator rp-${type}`;
      el.innerHTML = html;
    }
    _hideStatus(sel) { const el = this._$(sel); if (el) el.className = 'rp-status-indicator'; }

    _log(...a) { console.log('[RapidPair]', ...a); }

    /* ================================================================
     *  EVENT WIRING
     * ================================================================ */
    _attachListeners() {
      const $ = sel => this._$(sel);

      $('#closeBtn').onclick = () => this._hideModal();

      // Role selection
      $('#btnController').onclick = () => {
        this._role = 'controller';
        this._lastRole = 'controller';
        this._showStep('step2controller');
        this._controllerGenerateCode();
      };
      $('#btnResponder').onclick = () => {
        this._role = 'responder';
        this._lastRole = 'responder';
        this._showStep('step2responder');
      };

      // Controller — copy code
      $('#btnCopyCode').onclick = async () => {
        try {
          await navigator.clipboard.writeText($('#controllerCode').textContent);
          $('#btnCopyCode').textContent = 'Copied!';
          $('#btnCopyCode').classList.add('rp-success');
          setTimeout(() => { $('#btnCopyCode').textContent = 'Copy Code'; $('#btnCopyCode').classList.remove('rp-success'); }, 2000);
        } catch (_) {}
      };

      // LAN QR toggle
      $('#btnLanQR').onclick = (e) => { e.preventDefault(); this._showLanQR(); };
      $('#btnHideQR').onclick = () => { $('#qrSection').style.display = 'none'; $('#btnLanQR').style.display = 'inline'; this._isGeneratingLanQR = false; };

      // QR copy buttons
      $('#btnCopyQRText').onclick = () => this._copyToClipboard(this._qrPacked, '#btnCopyQRText', 'Copy QR Text');
      $('#btnCopyQRTextResponder').onclick = () => this._copyToClipboard(this._qrPackedResponder, '#btnCopyQRTextResponder', 'Copy QR Text');

      // QR chunk navigation (controller)
      $('#qrPrev').onclick = () => { clearTimeout(this._autoTimer); this._qrIdx = (this._qrIdx - 1 + this._qrChunks.length) % this._qrChunks.length; this._showChunkQR(); };
      $('#qrNext').onclick = () => { clearTimeout(this._autoTimer); this._qrIdx = (this._qrIdx + 1) % this._qrChunks.length; this._showChunkQR(); };
      $('#qrTrouble').onclick = () => { if (!this._qrPacked) return; clearTimeout(this._autoTimer); this._qrChunks = this._makeChunks(this._qrPacked, true); this._qrIdx = 0; this._showChunkQR(); };

      // QR chunk navigation (responder)
      $('#qrPrevResponder').onclick = () => { clearTimeout(this._autoTimerResponder); this._qrIdxResponder = (this._qrIdxResponder - 1 + this._qrChunksResponder.length) % this._qrChunksResponder.length; this._showChunkQRResponder(); };
      $('#qrNextResponder').onclick = () => { clearTimeout(this._autoTimerResponder); this._qrIdxResponder = (this._qrIdxResponder + 1) % this._qrChunksResponder.length; this._showChunkQRResponder(); };
      $('#qrTroubleResponder').onclick = () => { if (!this._qrPackedResponder) return; clearTimeout(this._autoTimerResponder); this._qrChunksResponder = this._makeChunks(this._qrPackedResponder, true); this._qrIdxResponder = 0; this._showChunkQRResponder(); };

      // QR enlarge overlay
      $('#qrWrap').onclick = () => { $('#qrOverlayContent').innerHTML = $('#qrWrap').innerHTML; $('#qrOverlay').classList.add('rp-active'); };
      $('#qrWrapResponderReply').onclick = () => { $('#qrOverlayContent').innerHTML = $('#qrWrapResponderReply').innerHTML; $('#qrOverlay').classList.add('rp-active'); };
      $('#qrOverlayClose').onclick = () => $('#qrOverlay').classList.remove('rp-active');
      $('#qrOverlay').onclick = (e) => { if (e.target === $('#qrOverlay')) $('#qrOverlay').classList.remove('rp-active'); };

      // Controller scanner
      $('#scanStartController').onclick = () => this._startScanner(true);
      $('#scanStopController').onclick  = () => this._stopScannerUI(true);

      $('#btnShowCodeAndQR').onclick = () => {
        const cs = $('#controllerCodeSection');
        const qa = $('#qrDisplayArea');
        const btn = $('#btnShowCodeAndQR');
        if (cs.style.display === 'none') {
          cs.style.display = 'block'; qa.style.display = 'block'; btn.textContent = '▲ Hide my code and QR';
        } else {
          cs.style.display = 'none'; qa.style.display = 'none'; btn.textContent = '▼ Show my code and QR';
        }
      };

      // Controller paste
      $('#qrApplyController').onclick = () => { const t = $('#qrPasteController').value.trim(); if (t) { this._absorb(t, true); $('#qrPasteController').value = ''; } };

      // Responder — connect with code
      $('#btnResponderConnect').onclick = () => this._responderConnect();

      // Responder scanner
      $('#scanStartResponder').onclick = () => this._startScanner(false);
      $('#scanStopResponder').onclick  = () => this._stopScannerUI(false);

      $('#btnShowCodeEntry').onclick = () => {
        const cs = $('#responderCodeSection');
        const btn = $('#btnShowCodeEntry');
        if (cs.style.display === 'none') { cs.style.display = 'block'; btn.textContent = '▲ Hide code entry'; }
        else { cs.style.display = 'none'; btn.textContent = '▼ Show code entry'; }
      };

      // Responder paste
      $('#qrApplyResponder').onclick = () => { const t = $('#qrPasteResponder').value.trim(); if (t) { this._absorb(t, false); $('#qrPasteResponder').value = ''; } };

      // Verification
      $('#btnVerifyMatch').addEventListener('click', () => this._onVerifyMatch());
      $('#btnVerifyNoMatch').addEventListener('click', () => this._onVerifyNoMatch());
      $('#btnDisconnectMismatch').addEventListener('click', () => this._onDisconnectMismatch());

      // Allow Enter key on responder code input
      $('#responderCodeInput').onkeydown = (e) => { if (e.key === 'Enter') this._responderConnect(); };
    }

    async _copyToClipboard(text, btnSel, defaultLabel) {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const btn = this._$(btnSel);
        btn.textContent = 'Copied!'; btn.classList.add('rp-success');
        setTimeout(() => { btn.textContent = defaultLabel; btn.classList.remove('rp-success'); }, 2000);
      } catch (_) {}
    }

    /* ================================================================
     *  COMPRESSION  (pako)
     * ================================================================ */
    _b64urlFromU8(u8) {
      let bin = ''; for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    _b64urlToU8(s) {
      let b64 = s.replace(/-/g, '+').replace(/_/g, '/'); while (b64.length % 4) b64 += '=';
      const bin = atob(b64); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    }
    _pack(obj) {
      return this._b64urlFromU8(pako.deflate(JSON.stringify(obj), { level: 9 }));
    }
    _unpack(s) {
      if (typeof s !== 'string' || s.length > 10000) throw new Error('Input too large');
      const inf = pako.inflate(this._b64urlToU8(s), { to: 'string' });
      if (inf.length > 50000) throw new Error('Decompressed output too large');
      return JSON.parse(inf);
    }

    /* ================================================================
     *  SDP HELPERS
     * ================================================================ */
    _extractMinimalSDP(sdp, type, includeAllCandidates = false) {
      const lines = sdp.split('\r\n');
      const m = { t: type === 'offer' ? 'o' : 'a', u: '', p: '', f: '', s: '', m: '', c: [] };
      let sctpPort = '';
      for (const line of lines) {
        if (line.startsWith('a=ice-ufrag:')) m.u = line.split(':')[1];
        else if (line.startsWith('a=ice-pwd:')) m.p = line.split(':')[1];
        else if (line.startsWith('a=fingerprint:')) { const p = line.split(' '); if (p.length >= 2) m.f = p.slice(1).join(' '); }
        else if (line.startsWith('a=setup:')) m.s = line.split(':')[1];
        else if (line.startsWith('a=mid:')) m.m = line.split(':')[1];
        else if (line.startsWith('a=sctp-port:')) sctpPort = line.split(':')[1];
        else if (line.startsWith('a=candidate:')) {
          const typMatch = line.match(/typ\s+(\w+)/);
          const candType = typMatch ? typMatch[1] : 'host';
          if (includeAllCandidates || candType === 'host') {
            const parts = line.substring(12).split(' ');
            if (parts.length >= 6) m.c.push(`${parts[0]}|${parts[1]}|${parts[2]}|${parts[4]}|${parts[5]}|${candType}`);
          }
        }
      }
      if (sctpPort) m.sp = sctpPort;
      return m;
    }

    _reconstructSDP(minimal) {
      const isOffer = minimal.t === 'o';
      let sdp = `v=0\r\no=- ${Date.now()} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE ${minimal.m}\r\n`;
      if (isOffer) sdp += `a=msid-semantic: WMS\r\n`;
      sdp += `m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n`;
      if (!isOffer) sdp += `a=bundle-only\r\n`;
      sdp += `a=ice-ufrag:${minimal.u}\r\na=ice-pwd:${minimal.p}\r\na=ice-options:trickle\r\n`;
      sdp += `a=fingerprint:sha-256 ${minimal.f.toUpperCase()}\r\na=setup:${minimal.s}\r\na=mid:${minimal.m}\r\n`;
      sdp += `a=sctp-port:${minimal.sp || '5000'}\r\na=max-message-size:262144\r\n`;
      if (minimal.c && minimal.c.length > 0) {
        for (const cc of minimal.c) {
          const p = cc.split('|');
          if (p.length >= 6) {
            sdp += `a=candidate:${p[0]} ${p[1]} ${p[2]} 2130706431 ${p[3]} ${p[4]} typ ${p[5]} generation 0 network-id 1\r\n`;
          }
        }
      }
      return sdp;
    }

    /* ================================================================
     *  TURN CREDENTIALS
     * ================================================================ */
    async _getCloudflareTURN() {
      if (this._cachedTURN) return this._cachedTURN;
      try {
        const res = await fetch('https://turn-credentials-proxy.gregory-obeirne.workers.dev', { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const iceServers = data.iceServers || [];
        const hasProtocol = (srv, proto) => {
          if (!srv.urls) return false;
          const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
          return urls.some(u => u.includes(proto));
        };
        const stun = iceServers.filter(s => hasProtocol(s, 'stun:'));
        const turn = iceServers.filter(s => hasProtocol(s, 'turn:'));
        this._cachedTURN = [...stun, ...turn];
        return this._cachedTURN;
      } catch (_) {
        const fb = [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
        ];
        this._cachedTURN = fb;
        return fb;
      }
    }

    /* ================================================================
     *  FIREBASE
     * ================================================================ */
    async _ensureFirebase() {
      if (this._fb.initialized) return;
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js');
      const { getAuth, signInAnonymously, onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js');
      const { getFirestore, doc, getDoc, setDoc, deleteDoc, serverTimestamp, onSnapshot } =
        await import('https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js');

      this._fb.app = initializeApp({
        apiKey: "AIzaSyBZhqD0RE0miHDHhhlDZerGIsD0S5oy4Yw",
        authDomain: "ucpairing.firebaseapp.com",
        projectId: "ucpairing"
      });
      this._fb.auth = getAuth(this._fb.app);

      onAuthStateChanged(this._fb.auth, (user) => {
        if (!user) signInAnonymously(this._fb.auth).catch(() => {});
      }, () => {});

      await signInAnonymously(this._fb.auth);
      this._fb.db = getFirestore(this._fb.app);
      this._fb.doc = doc;
      this._fb.getDoc = getDoc;
      this._fb.setDoc = setDoc;
      this._fb.deleteDoc = deleteDoc;
      this._fb.ts = serverTimestamp;
      this._fb.onSnapshot = onSnapshot;
      this._fb.initialized = true;
      this._log('Firebase ready');
    }

    /* ================================================================
     *  WebRTC PEER CONNECTION
     * ================================================================ */
    async _newPC(config = 'lan') {
      let cfg;
      if (config === 'lan') cfg = { iceServers: [] };
      else if (config === 'stun') cfg = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
      else if (config === 'turn') { const s = await this._getCloudflareTURN(); cfg = { iceServers: s }; }

      const p = new RTCPeerConnection(cfg);

      p.oniceconnectionstatechange = () => {
        if (p.iceConnectionState === 'failed' || p.iceConnectionState === 'disconnected') this._handleDisconnect();
      };
      p.onconnectionstatechange = () => {
        const s = p.connectionState;
        if (s === 'connected' && this._dc && this._dc.readyState === 'open') this._onConnected();
        else if (s === 'failed' || s === 'disconnected') this._handleDisconnect();
      };
      p.ondatachannel = (e) => { this._dc = e.channel; this._attachDC(); };
      return p;
    }

    _attachDC() {
      if (!this._dc) return;
      this._dc.onopen = () => {
        this._log('DataChannel open');
        this._secureChan = new SecureChannel(this._dc, this._role === 'controller');
        this._secureChan._onSecure = () => this._onSecureChannelReady();
        this._secureChan.start();
        if (this._pc && this._pc.connectionState === 'connected') this._onConnected();
      };
      this._dc.onclose = () => {
        this._log('DataChannel closed');
        this._secureChan = null;
        this._handleDisconnect();
      };
      this._dc.onmessage = async (e) => {
        this._resetInactivityTimer();
        if (this._secureChan) {
          const result = await this._secureChan.handleMessage(e.data);
          if (result === true) return;
          if (result && result.decrypted !== undefined) {
            const pt = result.decrypted;
            if (pt !== null) {
              if (!this._secureChan.verified) {
                this._secureChan._pendingVerify.push(pt);
              } else {
                this._routeMessage(pt);
              }
            }
            return;
          }
        }
      };
    }

    _sendRaw(json) {
      if (this._dc && this._dc.readyState === 'open') {
        if (this._secureChan && this._secureChan.ready && this._secureChan.verified) {
          this._secureChan.encrypt(json).then(enc => {
            this._dc.send(enc);
            this._resetInactivityTimer();
          }).catch(err => this._log('Encrypt/send error:', err.message));
        } else if (this._secureChan) {
          this._log('Queuing message (not yet verified)');
          this._secureChan._pendingOutbound.push(json);
        } else {
          this._log('Cannot send: no secure channel');
        }
      } else {
        this._log('Cannot send: DataChannel not open, state:', this._dc?.readyState);
      }
    }

    _routeMessage(plaintext) {
      try {
        const msg = JSON.parse(plaintext);
        if (msg.t && this._listeners[msg.t]) {
          this._listeners[msg.t].forEach(cb => {
            try { cb(msg.p); } catch (err) { console.error('[RapidPair] Listener error:', err); }
          });
        }
      } catch (_) {
        this._log('Non-JSON message received:', plaintext);
      }
    }

    _onConnected() {
      this._log('Connected!');
      this._resetInactivityTimer();
      // Clean up Firebase code
      if (this._hostRef) {
        this._fb.deleteDoc(this._hostRef).catch(() => {});
        this._hostRef = null;
      }
      // If this is a reconnection (had previous role), dispatch reconnected
      if (this._hadPreviousConnection) {
        this.dispatchEvent(new CustomEvent('reconnected', { detail: { role: this._role } }));
      }
      this._hadPreviousConnection = true;
    }

    _onSecureChannelReady() {
      this._log('Secure channel ready, code:', this._secureChan.verifyCode);
      this._stopAllScanners();
      this._showStep('stepVerify');
      this._$('#verifyCode').textContent = this._secureChan.verifyCode;
      this._$('#verifyBar').style.display = 'block';
      this._$('#verifyMismatch').style.display = 'none';
    }

    _onVerifyMatch() {
      if (!this._secureChan) { this._log('Verify match clicked but no secure channel!'); return; }
      this._secureChan.verified = true;
      this._log('User confirmed: codes match');

      // Flush pending verify messages
      const pvCount = this._secureChan._pendingVerify.length;
      for (const pt of this._secureChan._pendingVerify) {
        this._routeMessage(pt);
      }
      this._secureChan._pendingVerify = [];
      if (pvCount) this._log('Flushed', pvCount, 'pending inbound messages');

      // Flush pending outbound
      const poCount = this._secureChan._pendingOutbound.length;
      for (const json of this._secureChan._pendingOutbound) {
        this._secureChan.encrypt(json).then(enc => {
          this._dc.send(enc);
        });
      }
      this._secureChan._pendingOutbound = [];
      if (poCount) this._log('Flushed', poCount, 'pending outbound messages');

      // Dispatch the 'secure' event
      this._log('Dispatching secure event, role:', this._role);
      this.dispatchEvent(new CustomEvent('secure', {
        detail: { role: this._role, verifyCode: this._secureChan.verifyCode }
      }));

      // Auto-close modal
      if (this._autoClose) {
        this._log('Auto-closing modal');
        this._hideModal();
      }
    }

    _onVerifyNoMatch() {
      this._log('User reported: codes do NOT match');
      this._$('#verifyBar').style.display = 'none';
      this._$('#verifyMismatch').style.display = 'block';
    }

    _onDisconnectMismatch() {
      this.disconnect();
      this._showStep('step1');
      this._showModal();
    }

    _handleDisconnect() {
      this._secureChan = null;
      this.dispatchEvent(new CustomEvent('disconnected', { detail: {} }));
      // If we had a previous role, allow reconnect by reopening modal
      if (this._lastRole) {
        this._showModal();
        if (this._lastRole === 'controller') {
          this._showStep('step2controller');
          this._controllerGenerateCode();
        } else {
          this._showStep('step2responder');
        }
      }
    }

    _resetInactivityTimer() {
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = setTimeout(() => {
        if (this._pc && this._pc.connectionState === 'connected') {
          this._log('Inactivity timeout (2h), closing');
          this.disconnect();
        }
      }, 2 * 60 * 60 * 1000);
    }

    _cleanup() {
      clearTimeout(this._inactivityTimer);
      clearTimeout(this._autoTimer);
      clearTimeout(this._autoTimerResponder);
      this._stopAllScanners();
      if (this._snapshotUnsub) { try { this._snapshotUnsub(); } catch (_) {} }
      try { if (this._dc) this._dc.close(); } catch (_) {}
      try { if (this._pc) this._pc.close(); } catch (_) {}
      // Remove modal from body
      if (this._modalWrapper && this._modalWrapper.parentNode) {
        this._modalWrapper.parentNode.removeChild(this._modalWrapper);
      }
    }

    /* ================================================================
     *  CONTROLLER FLOW
     * ================================================================ */
    async _controllerGenerateCode() {
      try {
        await this._ensureFirebase();
      } catch (e) {
        this._showStatus('#controllerStatus', '⚠️ No internet connection detected', 'error');
        this._$('#btnLanQR').style.display = 'inline';
        this._$('#btnLanQR').textContent = '📱 Use LAN QR Code (works offline) →';
        this._$('#btnLanQR').style.color = '#f57c00';
        this._$('#btnLanQR').style.fontWeight = '600';
        return;
      }

      this._showStatus('#controllerStatus', '⏳ Initializing connection...', 'loading');
      try { this._pc?.close(); } catch (_) {}

      this._pc = await this._newPC('turn');
      this._dc = this._pc.createDataChannel('x');
      this._attachDC();

      this._showStatus('#controllerStatus', '🔑 Generating pairing code...', 'loading');
      await this._pc.setLocalDescription(await this._pc.createOffer());

      // Wait for ICE gathering with 1.5s timeout
      if (this._pc.iceGatheringState !== 'complete') {
        await Promise.race([
          new Promise(res => {
            const h = () => { if (this._pc.iceGatheringState === 'complete') { this._pc.removeEventListener('icegatheringstatechange', h); res(); } };
            this._pc.addEventListener('icegatheringstatechange', h);
          }),
          new Promise(res => setTimeout(res, 1500))
        ]);
      }

      const minSDP = this._extractMinimalSDP(this._pc.localDescription.sdp, 'offer', true);
      const hostPacked = this._pack({ role: 'host', sdp: minSDP });

      // Show LAN QR button
      this._$('#btnLanQR').style.display = 'inline';

      // Allocate code in Firebase
      const tryCode = async (len) => {
        const code = String(Math.floor(Math.random() * Math.pow(10, len))).padStart(len, '0');
        const ref = this._fb.doc(this._fb.db, 'pairs', code);
        const snap = await this._fb.getDoc(ref);
        if (snap.exists()) return null;
        await this._fb.setDoc(ref, { offer: hostPacked, ts: this._fb.ts() });
        return { code, ref };
      };

      let result = null;
      for (let i = 0; i < 50 && !result; i++) result = await tryCode(4);
      if (!result) for (let i = 0; i < 100 && !result; i++) result = await tryCode(6);

      if (!result) {
        this._showStatus('#controllerStatus', '❌ Could not allocate code', 'error');
        return;
      }

      this._hostRef = result.ref;
      this._$('#controllerCode').textContent = result.code;
      this._showStatus('#controllerStatus', '✅ Code ready!', 'success');
      this._log('Code:', result.code);

      // Listen for answer
      this._snapshotUnsub = this._fb.onSnapshot(result.ref, async (snap) => {
        const data = snap.data() || {};
        if (data.answer && !this._pc.currentRemoteDescription) {
          try {
            this._showStatus('#controllerStatus', '🔗 Responder found! Connecting...', 'loading');
            const obj = this._unpack(data.answer);
            const fullSDP = this._reconstructSDP(obj.sdp);
            await this._pc.setRemoteDescription({ type: obj.sdp.t === 'o' ? 'offer' : 'answer', sdp: fullSDP });
            this._log('Controller: got answer, connecting...');
          } catch (e) { this._log('Apply answer error:', e.message); }
        }
      });
    }

    /* ================================================================
     *  RESPONDER FLOW
     * ================================================================ */
    async _responderConnect() {
      try {
        await this._ensureFirebase();
      } catch (e) {
        this._showStatus('#responderStatus', '⚠️ No internet. Use "Scan QR Code" option below.', 'error');
        return;
      }

      const code = this._$('#responderCodeInput').value.trim();
      if (!code) { this._showStatus('#responderStatus', '⚠️ Please enter a code', 'error'); return; }

      this._showStatus('#responderStatus', '🔍 Looking up code...', 'loading');
      const ref = this._fb.doc(this._fb.db, 'pairs', code);
      const snap = await this._fb.getDoc(ref);

      if (!snap.exists()) { this._showStatus('#responderStatus', '❌ Code not found', 'error'); return; }

      const data = snap.data() || {};

      // Check expiry
      if (data.ts) {
        const ageSec = (Date.now() - data.ts.toMillis()) / 1000;
        if (ageSec > this._codeTTL) {
          this._showStatus('#responderStatus', '❌ Code expired. Ask for a new code.', 'error');
          return;
        }
      }

      if (!data.offer) { this._showStatus('#responderStatus', '⏳ No offer yet. Wait a moment.', 'error'); return; }

      this._showStatus('#responderStatus', '🔗 Connecting...', 'loading');
      const obj = this._unpack(data.offer);

      const hasRelay = obj.sdp.c && obj.sdp.c.some(c => { const p = c.split('|'); return p.length >= 6 && p[5] === 'relay'; });
      const hasSRFLX = obj.sdp.c && obj.sdp.c.some(c => { const p = c.split('|'); return p.length >= 6 && p[5] === 'srflx'; });
      let pcConfig = 'lan';
      if (hasRelay) pcConfig = 'turn';
      else if (hasSRFLX) pcConfig = 'stun';

      try { this._pc?.close(); } catch (_) {}
      this._pc = await this._newPC(pcConfig);

      const fullSDP = this._reconstructSDP(obj.sdp);
      await this._pc.setRemoteDescription({ type: obj.sdp.t === 'o' ? 'offer' : 'answer', sdp: fullSDP });
      await this._pc.setLocalDescription(await this._pc.createAnswer());

      // Wait for first relay candidate or 1.5s timeout
      await new Promise(res => {
        let done = false;
        const resolve = () => { if (!done) { done = true; res(); } };
        const check = (e) => {
          if (e.candidate && e.candidate.type === 'relay') { this._pc.removeEventListener('icecandidate', check); resolve(); }
        };
        this._pc.addEventListener('icecandidate', check);
        setTimeout(() => { this._pc.removeEventListener('icecandidate', check); resolve(); }, 1500);
      });

      const minSDP = this._extractMinimalSDP(this._pc.localDescription.sdp, this._pc.localDescription.type, pcConfig !== 'lan');
      const joinPacked = this._pack({ role: 'join', sdp: minSDP });
      await this._fb.setDoc(ref, { answer: joinPacked, ts: this._fb.ts() }, { merge: true });
      this._showStatus('#responderStatus', '⏳ Waiting for connection...', 'loading');
    }

    /* ================================================================
     *  LAN QR FLOW
     * ================================================================ */
    async _showLanQR() {
      if (this._isGeneratingLanQR) return;
      this._isGeneratingLanQR = true;
      this._$('#btnLanQR').style.display = 'none';
      this._$('#qrSection').style.display = 'block';

      try { this._pc?.close(); } catch (_) {}
      this._pc = await this._newPC('lan');
      this._dc = this._pc.createDataChannel('x');
      this._attachDC();

      await this._pc.setLocalDescription(await this._pc.createOffer());

      if (this._pc.iceGatheringState !== 'complete') {
        await new Promise(res => {
          const h = () => { if (this._pc.iceGatheringState === 'complete') { this._pc.removeEventListener('icegatheringstatechange', h); res(); } };
          this._pc.addEventListener('icegatheringstatechange', h);
        });
      }

      const minSDP = this._extractMinimalSDP(this._pc.localDescription.sdp, 'offer', false);
      this._qrPacked = this._pack({ role: 'host', sdp: minSDP });
      this._showDenseQR(this._qrPacked, '#qrWrap', '#qrNav', '#qrTrouble');
      this._isGeneratingLanQR = false;
    }

    /* ================================================================
     *  QR CODE GENERATION
     * ================================================================ */
    _QR_PREFIX = 'UCP1|';
    _NAV_SCALE = 6;

    _tryRenderQR(text, typeNumber, ecc = 'M') {
      const q = qrcode(typeNumber, ecc);
      q.addData(text);
      q.make();
      return q.createSvgTag(this._NAV_SCALE);
    }

    _maxPayloadForVersion(ver, parts) {
      const cap = { 4: 114, 6: 180, 8: 250, 10: 346, 12: 434, 14: 538, 16: 666, 18: 778, 20: 906, 24: 1174, 28: 1502, 32: 1853, 36: 2132, 40: 2409 };
      const maxChars = cap[ver] || 100;
      const overhead = this._QR_PREFIX.length + String(parts).length + 1 + String(parts).length + 1;
      return Math.max(0, maxChars - overhead);
    }

    _makeChunks(packed, forceV4 = false) {
      if (forceV4) {
        const ver = 4;
        for (let parts = 2; parts <= 20; parts++) {
          const maxPay = this._maxPayloadForVersion(ver, parts);
          const size = Math.ceil(packed.length / parts);
          if (size <= maxPay) {
            const out = [];
            for (let i = 0; i < parts; i++) {
              const slice = packed.slice(i * size, Math.min((i + 1) * size, packed.length));
              const framed = `${this._QR_PREFIX}${parts}|${i + 1}|${slice}`;
              try { this._tryRenderQR(framed, ver, 'M'); out.push({ ver, str: framed }); } catch (_) { break; }
            }
            if (out.length === parts) return out;
          }
        }
        throw Error('Payload too large for V4');
      }

      const versions = [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40];
      for (let parts = 2; parts <= 4; parts++) {
        for (const ver of versions) {
          const size = Math.ceil(packed.length / parts);
          const out = []; let ok = true;
          for (let i = 0; i < parts; i++) {
            const slice = packed.slice(i * size, Math.min((i + 1) * size, packed.length));
            const framed = `${this._QR_PREFIX}${parts}|${i + 1}|${slice}`;
            try { this._tryRenderQR(framed, ver, 'M'); out.push({ ver, str: framed }); } catch (_) { ok = false; break; }
          }
          if (ok) return out;
        }
      }
      throw Error('Payload too large');
    }

    _showDenseQR(packed, wrapId, navId, troubleId) {
      try {
        const svg = this._tryRenderQR(packed, 0, 'M');
        this._$(wrapId).innerHTML = svg;
        this._$(navId).style.display = 'none';
        if (troubleId) this._$(troubleId).style.display = 'inline';
      } catch (_) {
        const chunks = this._makeChunks(packed, false);
        if (wrapId === '#qrWrap') {
          this._qrChunks = chunks; this._qrIdx = 0; this._showChunkQR();
        } else {
          this._qrChunksResponder = chunks; this._qrIdxResponder = 0; this._showChunkQRResponder();
        }
      }
    }

    _showChunkQR() {
      if (!this._qrChunks.length) return;
      const { ver, str } = this._qrChunks[this._qrIdx];
      this._$('#qrWrap').innerHTML = this._tryRenderQR(str, ver, 'M');
      this._$('#qrIndex').textContent = `${this._qrIdx + 1}/${this._qrChunks.length} (V${ver})`;
      this._$('#qrNav').style.display = 'flex';
      this._$('#qrTrouble').style.display = 'inline';
      if (this._$('#autoAdvance').checked) {
        clearTimeout(this._autoTimer);
        this._autoTimer = setTimeout(() => { this._qrIdx = (this._qrIdx + 1) % this._qrChunks.length; this._showChunkQR(); }, 1500);
      }
    }

    _showChunkQRResponder() {
      if (!this._qrChunksResponder.length) return;
      const { ver, str } = this._qrChunksResponder[this._qrIdxResponder];
      this._$('#qrWrapResponderReply').innerHTML = this._tryRenderQR(str, ver, 'M');
      this._$('#qrIndexResponder').textContent = `${this._qrIdxResponder + 1}/${this._qrChunksResponder.length} (V${ver})`;
      this._$('#qrNavResponder').style.display = 'flex';
      this._$('#qrTroubleResponder').style.display = 'inline';
      if (this._$('#autoAdvanceResponder').checked) {
        clearTimeout(this._autoTimerResponder);
        this._autoTimerResponder = setTimeout(() => { this._qrIdxResponder = (this._qrIdxResponder + 1) % this._qrChunksResponder.length; this._showChunkQRResponder(); }, 1500);
      }
    }

    /* ================================================================
     *  QR SCANNING
     * ================================================================ */
    _resetAsm(isController) {
      this._asm = { total: 0, got: new Set(), parts: [] };
      const el = this._$(isController ? '#qrProgressController' : '#qrProgressResponder');
      if (el) el.textContent = '';
    }

    _updateProgress(isController) {
      if (!this._asm.total) return;
      let display = 'Scanned: [';
      for (let i = 1; i <= this._asm.total; i++) {
        display += `${i}${this._asm.got.has(i) ? '✓' : '◻'}`;
        if (i < this._asm.total) display += ' ';
      }
      display += ']';
      const el = this._$(isController ? '#qrProgressController' : '#qrProgressResponder');
      if (el) el.textContent = display;
    }

    _absorb(text, isController = false) {
      if (text.startsWith(this._QR_PREFIX)) {
        const rest = text.slice(this._QR_PREFIX.length);
        const p1 = rest.indexOf('|'), p2 = rest.indexOf('|', p1 + 1);
        if (p1 < 0 || p2 < 0) return;
        const total = +rest.slice(0, p1), index = +rest.slice(p1 + 1, p2), data = rest.slice(p2 + 1);
        if (!this._asm.total) { this._asm.total = total; this._asm.parts = Array(total).fill(''); }
        if (!this._asm.got.has(index)) { this._asm.got.add(index); this._asm.parts[index - 1] = data; }
        this._updateProgress(isController);
        if (this._asm.got.size === this._asm.total) {
          const packed = this._asm.parts.join('');
          if (isController) this._stopScanner(this._scannerController, '#scanStartController', '#scanStopController').then(s => { this._scannerController = s; });
          else this._stopScanner(this._scannerResponder, '#scanStartResponder', '#scanStopResponder').then(s => { this._scannerResponder = s; });
          this._resetAsm(isController);
          this._applyPacked(packed, isController);
        }
      } else {
        this._applyPacked(text, isController);
      }
    }

    async _applyPacked(packed, isController) {
      try {
        const obj = this._unpack(packed);
        if (isController && obj.role === 'join') {
          if (!this._pc.currentRemoteDescription) {
            const fullSDP = this._reconstructSDP(obj.sdp);
            await this._pc.setRemoteDescription({ type: obj.sdp.t === 'o' ? 'offer' : 'answer', sdp: fullSDP });
            this._log('Controller: got answer QR');
          }
        } else if (!isController && obj.role === 'host') {
          const hasRelay = obj.sdp.c && obj.sdp.c.some(c => { const p = c.split('|'); return p.length >= 6 && p[5] === 'relay'; });
          const hasSRFLX = obj.sdp.c && obj.sdp.c.some(c => { const p = c.split('|'); return p.length >= 6 && p[5] === 'srflx'; });
          let pcConfig = 'lan';
          if (hasRelay) pcConfig = 'turn';
          else if (hasSRFLX) pcConfig = 'stun';

          if (!this._pc) this._pc = await this._newPC(pcConfig);
          if (!this._pc.currentRemoteDescription) {
            const fullSDP = this._reconstructSDP(obj.sdp);
            await this._pc.setRemoteDescription({ type: obj.sdp.t === 'o' ? 'offer' : 'answer', sdp: fullSDP });
            await this._pc.setLocalDescription(await this._pc.createAnswer());
            if (this._pc.iceGatheringState !== 'complete') {
              await new Promise(res => {
                const h = () => { if (this._pc.iceGatheringState === 'complete') { this._pc.removeEventListener('icegatheringstatechange', h); res(); } };
                this._pc.addEventListener('icegatheringstatechange', h);
              });
            }
            const minSDP = this._extractMinimalSDP(this._pc.localDescription.sdp, this._pc.localDescription.type, pcConfig !== 'lan');
            this._qrPackedResponder = this._pack({ role: 'join', sdp: minSDP });
            this._stopAllScanners();
            this._showStep('step4responderReply');
            this._showDenseQR(this._qrPackedResponder, '#qrWrapResponderReply', '#qrNavResponder', '#qrTroubleResponder');
          }
        }
      } catch (e) {
        this._log('applyPacked error:', e.message);
        this.dispatchEvent(new CustomEvent('error', { detail: { error: e } }));
      }
    }

    _startScanner(isController) {
      this._resetAsm(isController);
      const startBtn = isController ? '#scanStartController' : '#scanStartResponder';
      const stopBtn = isController ? '#scanStopController' : '#scanStopResponder';

      if (isController) {
        this._$('#controllerCodeSection').style.display = 'none';
        this._$('#qrDisplayArea').style.display = 'none';
        this._$('#btnShowCodeAndQR').style.display = 'inline-block';
        this._$('#btnHideQR').style.display = 'none';
      } else {
        this._$('#responderCodeSection').style.display = 'none';
        this._$('#btnShowCodeEntry').style.display = 'inline-block';
      }

      try {
        // Light DOM: elements are accessible via document.getElementById
        const readerId = this._uid + '-' + (isController ? 'readerController' : 'readerResponder');
        const scannerInstance = new Html5Qrcode(readerId);

        scannerInstance.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: 240 },
          txt => this._absorb(txt, isController),
          _ => {}
        ).then(() => {
          this._$(startBtn).disabled = true;
          this._$(stopBtn).disabled = false;
          if (isController) this._scannerController = scannerInstance;
          else this._scannerResponder = scannerInstance;
        }).catch(err => this._log('Scanner error:', err));
      } catch (e) {
        this._log('Scanner init error:', e.message);
      }
    }

    async _stopScanner(scanner, startBtn, stopBtn) {
      if (!scanner) return null;
      try { await scanner.stop(); scanner.clear(); } catch (_) {}
      const sb = this._$(startBtn);
      const stb = this._$(stopBtn);
      if (sb) sb.disabled = false;
      if (stb) stb.disabled = true;
      return null;
    }

    _stopScannerUI(isController) {
      if (isController) {
        this._stopScanner(this._scannerController, '#scanStartController', '#scanStopController').then(s => { this._scannerController = s; });
        this._resetAsm(true);
        this._$('#controllerCodeSection').style.display = 'block';
        this._$('#qrDisplayArea').style.display = 'block';
        this._$('#btnShowCodeAndQR').style.display = 'none';
        this._$('#btnHideQR').style.display = 'block';
      } else {
        this._stopScanner(this._scannerResponder, '#scanStartResponder', '#scanStopResponder').then(s => { this._scannerResponder = s; });
        this._resetAsm(false);
        this._$('#responderCodeSection').style.display = 'block';
        this._$('#btnShowCodeEntry').style.display = 'none';
      }
    }

    _stopAllScanners() {
      if (this._scannerController) this._stopScanner(this._scannerController, '#scanStartController', '#scanStopController').then(s => { this._scannerController = s; });
      if (this._scannerResponder) this._stopScanner(this._scannerResponder, '#scanStartResponder', '#scanStopResponder').then(s => { this._scannerResponder = s; });
    }
  }

  /* ================================================================
   *  REGISTER & PAGE LIFECYCLE
   * ================================================================ */

  // Register immediately. When the script is loaded after the <rapid-pair>
  // element (recommended), this triggers an upgrade of the existing element.
  // The upgrade path does NOT throw "must not have attributes".
  if (!customElements.get('rapid-pair')) {
    customElements.define('rapid-pair', RapidPair);
  }

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    document.querySelectorAll('rapid-pair').forEach(el => el._cleanup());
  });

  // Register service worker for offline support
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./rapidpair-sw.js').catch(() => {});
    });
  }

  console.log('[RapidPair] Web Component loaded');
})();
