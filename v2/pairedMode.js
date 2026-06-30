// pairedMode.js — RapidPair integration for UC KTT
// Controller: clinician device. Responder: child/client device.
// Both run the same URL. Role is chosen in the pairing modal.

(() => {
  'use strict';

  const AUDIO_DIR   = 'sounds';
  const CARRIER_URL = `${AUDIO_DIR}/keiheate.mp3`;
  const CHUNK_BYTES = 180000;

  // ─── Logging ──────────────────────────────────────────────────────────────

  const LOG_PREFIX = '[KTT]';
  function kttLog(emoji, ...args) {
    console.log(`${LOG_PREFIX} ${emoji}`, ...args);
  }
  function kttWarn(emoji, ...args) {
    console.warn(`${LOG_PREFIX} ${emoji}`, ...args);
  }

  // Expose full state dump for debugging — call kttDebug() in console
  window.kttDebug = () => {
    const state = {
      pairSecure,
      pairRole,
      audioFromResponder,
      responderReady,
      pendingResponse,
      respKupu,
      respArmed,
      respTapped,
      respConfirmed,
      audioCtxState: _audioCtx?.state || 'none',
      reconnectState: loadReconnectState(),
      pairElInDOM: !!pairEl?.parentNode,
      fbInitialized: !!pairEl?._fb?.initialized,
    };
    console.group(`${LOG_PREFIX} 🔍 State dump`);
    Object.entries(state).forEach(([k, v]) => console.log(`  ${k}:`, v));
    console.groupEnd();
    return state;
  };

  // ─── State ────────────────────────────────────────────────────────────────

  let pairEl       = null;
  let pairRole     = null;
  let pairSecure   = false;
  let audioFromResponder = false;
  let pendingResponse = null;
  let responderReady  = false;
  let respShowLabels  = true;   // mirrors clinician's showLabels setting

  // Responder-side state
  let respKupu      = [];
  let respArmed     = false;
  let respTapped    = null;
  let respConfirmed = false;

  // Audio (responder plays these)
  let respCarrier  = null;
  let respKupuAud  = null;
  let _audioCtx    = null;

  function unlockAudio() {
    if (_audioCtx) return;
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = _audioCtx.createBuffer(1, 1, 22050);
      const src = _audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(_audioCtx.destination);
      src.start(0);
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      kttLog('🔊', 'AudioContext unlocked, state:', _audioCtx.state);
    } catch (e) {
      kttWarn('🔊', 'AudioContext unlock failed:', e.message);
    }
  }

  function playAudioIOS(url) {
    return new Promise((resolve, reject) => {
      kttLog('🎵', 'playAudioIOS:', url, '| ctx:', _audioCtx?.state || 'none');
      if (!_audioCtx) {
        const a = new Audio(url);
        a.play().catch(reject);
        a.onended = resolve;
        return;
      }
      fetch(url)
        .then(r => r.arrayBuffer())
        .then(buf => _audioCtx.decodeAudioData(buf))
        .then(decoded => {
          const src = _audioCtx.createBufferSource();
          src.buffer = decoded;
          src.connect(_audioCtx.destination);
          src.onended = resolve;
          src.start(0);
        })
        .catch(err => { kttWarn('🎵', 'playAudioIOS error:', err.message); reject(err); });
    });
  }

  // ─── Public API (called from manualTest.js) ───────────────────────────────

  window.kttPaired = {
    init,
    openPairModal,
    isConnected:          () => pairSecure,
    getRole:              () => pairRole,
    getAudioFromResponder:() => audioFromResponder,
    sendPlay,
    sendSync,
    sendDisplay,
    sendListReset,
    sendConfirm,
    setAudioSource,
    statusEl:             null,
  };

  // ─── Fast reconnect ───────────────────────────────────────────────────────
  // On first pairing, controller generates a shared secret and sends it to the
  // responder via ktt-hello. Both store it in localStorage.
  // On subsequent pair attempts, controller writes a "beacon" doc to Firebase
  // under the secret. Responder (open in background) sees it and auto-enters
  // the pairing code in rapidpair's modal — no manual entry needed.

  const LS_KEY_RECONNECT = 'ktt_reconnect_v1';
  // How long to wait for the beacon response before falling back to full modal
  const BEACON_TIMEOUT_MS = 5000;
  const FB_BEACON_COLL    = 'pairs';   // reuse existing pairs collection with KTT_ prefix
  const FB_KEY_PREFIX     = 'KTT_';   // distinguishes our docs from live pairing codes

  function loadReconnectState() {
    try { return JSON.parse(localStorage.getItem(LS_KEY_RECONNECT) || 'null'); } catch { return null; }
  }
  function saveReconnectState(obj) {
    try { localStorage.setItem(LS_KEY_RECONNECT, JSON.stringify(obj)); } catch (_) {}
  }
  function clearReconnectState() {
    localStorage.removeItem(LS_KEY_RECONNECT);
  }

  function initReconnectSecret() {
    const existing = loadReconnectState();
    const secret = existing?.secret || Array.from(crypto.getRandomValues(new Uint8Array(5)))
      .map(b => b.toString(36)).join('').toUpperCase();
    const isNew = !existing?.secret;
    saveReconnectState({ secret, role: 'controller', savedAt: Date.now() });
    kttLog('🔑', isNew ? 'Generated new reconnect secret:' : 'Reusing existing secret:', secret);
    pairEl.send('ktt-hello', { secret, v: 1 });
  }

  function onKttHello(p) {
    if (pairRole !== 'responder') return;
    saveReconnectState({ secret: p.secret, role: 'responder', savedAt: Date.now() });
    kttLog('🔑', 'Responder: saved reconnect secret:', p.secret);
  }

  let _pairElAppended = false;

  function appendPairEl() {
    if (_pairElAppended) return;
    kttLog('🔌', 'Appending pairEl to DOM (once)');
    document.body.appendChild(pairEl);
    _pairElAppended = true;
  }

  async function getFB() {
    // Only ever append pairEl to DOM once — re-appending re-triggers connectedCallback
    // which re-initialises WebRTC machinery and causes disconnect event storms
    appendPairEl();
    if (pairEl._fb?.initialized) {
      kttLog('🔥', 'Firebase already initialized');
      return pairEl._fb;
    }
    kttLog('🔥', 'Waiting for Firebase + auth to init (up to 4s)…');
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (pairEl._fb?.initialized) {
        kttLog('🔥', `Firebase ready after ${(i+1)*100}ms`);
        return pairEl._fb;
      }
    }
    kttWarn('🔥', 'Firebase init timed out after 4s');
    return null;
  }

  async function attemptFastReconnect() {
    const state = loadReconnectState();
    kttLog('⚡', 'attemptFastReconnect — saved state:', state);
    if (!state?.secret || state.role !== 'controller') {
      kttLog('⚡', 'No saved controller secret — skipping fast reconnect');
      return false;
    }

    const ageDays = (Date.now() - (state.savedAt || 0)) / 86400000;
    kttLog('⚡', `Secret age: ${ageDays.toFixed(1)} days`);

    showFastReconnectUI('Checking for saved device…');

    appendPairEl();

    const fb = await getFB();
    if (!fb) {
      kttWarn('⚡', 'No Firebase — falling back to modal');
      hideFastReconnectUI();
      return false;
    }

    const secret   = state.secret;
    const beaconId = FB_KEY_PREFIX + secret + '_ctrl';
    const replyId  = FB_KEY_PREFIX + secret + '_resp';
    kttLog('⚡', `Writing controller beacon: ${FB_BEACON_COLL}/${beaconId}`);

    try {
      const beaconRef = fb.doc(fb.db, FB_BEACON_COLL, beaconId);
      await fb.setDoc(beaconRef, { ts: fb.ts(), status: 'calling', app: 'ktt' });
      kttLog('⚡', 'Beacon written — waiting up to', BEACON_TIMEOUT_MS, 'ms for responder reply');
      showFastReconnectUI('Waiting for responder device…');

      const found = await new Promise(resolve => {
        const deadline = setTimeout(() => {
          kttLog('⚡', `Beacon timeout after ${BEACON_TIMEOUT_MS}ms — no reply`);
          resolve(false);
        }, BEACON_TIMEOUT_MS);
        const unsub = fb.onSnapshot(fb.doc(fb.db, FB_BEACON_COLL, replyId), snap => {
          if (snap.exists() && snap.data()?.status === 'ready') {
            kttLog('⚡', '✅ Responder beacon reply received!');
            clearTimeout(deadline);
            unsub();
            resolve(true);
          }
        });
      });

      fb.deleteDoc(beaconRef).catch(() => {});
      fb.deleteDoc(fb.doc(fb.db, FB_BEACON_COLL, replyId)).catch(() => {});

      hideFastReconnectUI();
      if (found) {
        kttLog('⚡', 'Fast reconnect succeeded — opening pairing modal');
        showFastReconnectUI('Responder found — opening pairing…');
        await new Promise(r => setTimeout(r, 600));
        hideFastReconnectUI();
        return true;
      }
      kttLog('⚡', 'Fast reconnect: no reply — falling back to full modal');
      return false;

    } catch (err) {
      kttWarn('⚡', 'Beacon error:', err.message);
      hideFastReconnectUI();
      return false;
    }
  }

  async function responderCheckBeacon() {
    const state = loadReconnectState();
    kttLog('📡', 'responderCheckBeacon — saved state:', state);
    if (!state?.secret || state.role !== 'responder') {
      kttLog('📡', 'No saved responder secret — skipping beacon check');
      return;
    }
    if (pairSecure) {
      kttLog('📡', 'Already connected — skipping beacon check');
      return;
    }

    const secret   = state.secret;
    const beaconId = FB_KEY_PREFIX + secret + '_ctrl';
    const replyId  = FB_KEY_PREFIX + secret + '_resp';

    appendPairEl();

    const fb = await getFB();
    if (!fb) {
      kttWarn('📡', 'No Firebase — cannot check beacon');
      return;
    }

    try {
      kttLog('📡', `Checking for controller beacon: ${FB_BEACON_COLL}/${beaconId}`);
      const snap = await fb.getDoc(fb.doc(fb.db, FB_BEACON_COLL, beaconId));
      if (!snap.exists()) {
        kttLog('📡', 'No beacon found — controller not calling');
        return;
      }

      const ageSec = (Date.now() - (snap.data()?.ts?.toMillis?.() || 0)) / 1000;
      kttLog('📡', `Beacon found, age: ${ageSec.toFixed(1)}s`);
      if (ageSec > 30) {
        kttLog('📡', 'Beacon stale (>30s) — ignoring');
        return;
      }

      kttLog('📡', `Writing responder reply: ${FB_BEACON_COLL}/${replyId}`);
      await fb.setDoc(fb.doc(fb.db, FB_BEACON_COLL, replyId), { ts: fb.ts(), status: 'ready', app: 'ktt' });
      fb.deleteDoc(fb.doc(fb.db, FB_BEACON_COLL, beaconId)).catch(() => {});

      kttLog('📡', 'Reply sent — auto-opening pairing modal in responder mode');
      pairEl.open();
      await new Promise(r => setTimeout(r, 300));
      document.querySelectorAll('.rp-modal button').forEach(b => {
        if (b.textContent.trim() === 'Responder device') {
          kttLog('📡', 'Auto-clicking Responder device button');
          b.click();
        }
      });

    } catch (err) {
      kttWarn('📡', 'Responder beacon check error:', err.message);
    }
  }

  // ─── Fast reconnect UI ────────────────────────────────────────────────────

  function showFastReconnectUI(msg) {
    let el = document.getElementById('ktt-reconnect-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ktt-reconnect-toast';
      el.style.cssText = `
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: #1a5fa5; color: #fff; font-family: system-ui, sans-serif;
        font-size: 13px; font-weight: 600; padding: 10px 20px; border-radius: 999px;
        box-shadow: 0 4px 16px rgba(0,0,0,.2); z-index: 99999;
        display: flex; align-items: center; gap: 8px; white-space: nowrap;
      `;
      document.body.appendChild(el);
    }
    el.innerHTML = `<span style="font-size:16px">⟳</span> ${msg}`;
    el.style.display = 'flex';
  }

  function hideFastReconnectUI() {
    const el = document.getElementById('ktt-reconnect-toast');
    if (el) el.style.display = 'none';
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    kttLog('🚀', 'pairedMode init');
    const savedState = loadReconnectState();
    if (savedState) kttLog('💾', 'Saved reconnect state:', savedState);
    else kttLog('💾', 'No saved reconnect state');

    pairEl = document.createElement('rapid-pair');
    pairEl.id = 'ktt-rapid-pair';
    pairEl.setAttribute('controller-label', 'Clinician');
    pairEl.setAttribute('responder-label',  'Responder device');
    pairEl.setAttribute('auto-close', 'true');

    pairEl.addEventListener('secure',       onSecure);
    pairEl.addEventListener('disconnected', onDisconnected);
    pairEl.addEventListener('reconnected',  onReconnected);
    pairEl.addEventListener('linkquality',  onLinkQuality);
    pairEl.addEventListener('linkrecovered',onLinkRecovered);

    pairEl.on('ktt-response',    onKttResponse);
    pairEl.on('ktt-sync',        onKttSync);
    pairEl.on('ktt-image-chunk', onKttImageChunk);
    pairEl.on('ktt-play',        onKttPlay);
    pairEl.on('ktt-confirm',     onKttConfirm);
    pairEl.on('ktt-list-reset',  onKttListReset);
    pairEl.on('ktt-list-update', onKttSync);
    pairEl.on('ktt-hello',       onKttHello);
    pairEl.on('ktt-ready',       onKttReadyReceived);
    pairEl.on('ktt-display',     onKttDisplay);
    pairEl.on('ktt-bg',          onKttBackground);

    kttLog('🚀', 'All listeners registered. pairEl NOT in DOM yet.');

    wireBackgroundDetection();

    if (new URLSearchParams(location.search).get('role') === 'responder') {
      kttLog('🔗', '?role=responder detected — auto-opening modal');
      openPairModal();
      setTimeout(() => {
        document.querySelectorAll('.rp-modal button').forEach(b => {
          if (b.textContent.trim() === 'Responder device') b.click();
        });
      }, 500);
    }

    if (savedState?.secret && savedState.role === 'responder') {
      kttLog('📡', 'Starting responder beacon poll (every 15s while unconnected)');
      // First check after 2s (Firebase needs time to init), then every 15s
      setTimeout(startResponderBeaconPoll, 2000);
    }
  }

  let _beaconPollTimer = null;

  function startResponderBeaconPoll() {
    if (pairSecure) {
      kttLog('📡', 'Already connected — not starting beacon poll');
      return;
    }
    responderCheckBeacon();
    _beaconPollTimer = setInterval(() => {
      if (pairSecure) {
        kttLog('📡', 'Connected — stopping beacon poll');
        clearInterval(_beaconPollTimer);
        _beaconPollTimer = null;
        return;
      }
      kttLog('📡', 'Beacon poll tick');
      responderCheckBeacon();
    }, 15000);
  }

  function openPairModal() {
    const state = loadReconnectState();
    kttLog('📱', 'openPairModal — saved state:', state, '| pairSecure:', pairSecure);

    const alreadyInDOM = _pairElAppended;

    if (state?.secret && state.role === 'controller' && !pairSecure) {
      kttLog('⚡', 'Attempting fast reconnect before opening modal');
      attemptFastReconnect().then(() => {
        appendPairEl();
        if (alreadyInDOM) pairEl.open();
      });
    } else {
      kttLog('📱', 'Opening modal directly');
      appendPairEl();
      if (alreadyInDOM) pairEl.open();
    }
  }

  function setAudioSource(src) {
    audioFromResponder = (src === 'responder');
  }

  // ─── Connection events ────────────────────────────────────────────────────

  function onSecure(e) {
    pairRole   = e.detail.role;
    pairSecure = true;
    // Stop beacon polling if running
    if (_beaconPollTimer) {
      clearInterval(_beaconPollTimer);
      _beaconPollTimer = null;
      kttLog('📡', 'Beacon poll stopped — now connected');
    }
    kttLog('🔒', 'SECURE — role:', pairRole, '| verifyCode:', e.detail.verifyCode);
    updateStatusBadge('connected');

    if (pairRole === 'controller') {
      initReconnectSecret();
      const list = window.kttManual?.getActiveListForPair?.();
      kttLog('📋', 'Controller: sending list-reset, list:', list?.name || 'none');
      sendListReset(list?.name || '');
    } else {
      kttLog('📺', 'Responder: activating responder mode');
      activateResponderMode();
    }
  }

  let _disconnectDebounce = null;

  function onDisconnected() {
    // Debounce — RapidPair can fire this many times rapidly during ICE failures
    clearTimeout(_disconnectDebounce);
    _disconnectDebounce = setTimeout(() => {
      if (pairSecure) return; // reconnected in the meantime
      pairSecure = false;
      _link = { state: 'idle', lastSeenMs: null, rtt: null };
      _peerBackgrounded = false;
      kttLog('❌', 'DISCONNECTED');
      updateStatusBadge('disconnected');
    }, 500);
  }

  function onReconnected(e) {
    pairRole   = e.detail.role;
    pairSecure = true;
    kttLog('🔄', 'RECONNECTED — role:', pairRole);
    updateStatusBadge('connected');
    if (pairRole === 'controller') {
      const list = window.kttManual?.getActiveListForPair?.();
      sendListReset(list?.name || '');
    }
  }

  // ─── Status badge + diagnostic panel ──────────────────────────────────────
  //
  // The badge now reflects real link liveness (live/stale/dead), not just
  // paired/not-paired, and is clickable to open the diagnostic panel.

  // Last-known connection summary, kept fresh by onLinkQuality.
  let _link = { state: 'idle', lastSeenMs: null, rtt: null };
  let _peerBackgrounded = false;   // set when the OTHER device reports backgrounding
  let _selfBackgrounded  = false;  // set when THIS device is backgrounded
  let _panelTimer = null;

  const BADGE_STYLES = {
    // logical state → presentation
    idle:         { dot: '#bbb',    text: 'Not paired',     bg: '#f5f5f5', color: '#888',    border: '#ddd'    },
    live:         { dot: '#2e7d32', text: 'Connected',      bg: '#e8f5e9', color: '#2e7d32', border: '#a5d6a7' },
    stale:        { dot: '#f9a825', text: 'Unstable',       bg: '#fff8e1', color: '#e65100', border: '#ffcc80' },
    dead:         { dot: '#c62828', text: 'Reconnecting…',  bg: '#fdecea', color: '#c62828', border: '#f5b5ae' },
    disconnected: { dot: '#c62828', text: 'Disconnected',   bg: '#fdecea', color: '#c62828', border: '#f5b5ae' },
  };

  function badgeStateFromLink() {
    if (!pairSecure && _link.state === 'idle') return 'idle';
    if (_link.state === 'live')  return 'live';
    if (_link.state === 'stale') return 'stale';
    if (_link.state === 'dead')  return 'dead';
    if (!pairSecure)             return 'disconnected';
    return 'live';
  }

  function updateStatusBadge(stateOverride) {
    const el = document.getElementById('ktt-pair-status');
    if (!el) return;
    // Accept legacy calls ('connected'/'disconnected'/'idle') and new liveness states.
    let key = stateOverride;
    if (key === 'connected') key = 'live';
    if (!key) key = badgeStateFromLink();
    const s = BADGE_STYLES[key] || BADGE_STYLES.idle;
    const warn = (_peerBackgrounded || _selfBackgrounded) ? ' ⚠' : '';
    el.innerHTML =
      `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;`
      + `background:${s.dot};margin-right:5px;vertical-align:middle"></span>${s.text}${warn}`;
    el.style.cssText =
      `display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;`
      + `font-weight:600;cursor:pointer;background:${s.bg};color:${s.color};border:1px solid ${s.border}`;
    el.title = 'Tap for connection diagnostics';
    if (!el._diagBound) {
      el.addEventListener('click', toggleDiagPanel);
      el._diagBound = true;
    }
    // Keep the panel in sync if it's open.
    if (document.getElementById('ktt-diag-panel')) renderDiagPanel();
  }

  function onLinkQuality(e) {
    _link = e.detail || _link;
    updateStatusBadge();
  }

  function onLinkRecovered() {
    kttLog('💚', 'Link recovered silently');
    _peerBackgrounded = false;
    updateStatusBadge();
  }

  // ─── Diagnostic panel ─────────────────────────────────────────────────────

  function toggleDiagPanel() {
    const existing = document.getElementById('ktt-diag-panel');
    if (existing) { closeDiagPanel(); return; }
    openDiagPanel();
  }

  function openDiagPanel() {
    let p = document.getElementById('ktt-diag-panel');
    if (p) return;
    p = document.createElement('div');
    p.id = 'ktt-diag-panel';
    p.style.cssText =
      'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:100000;'
      + 'width:min(420px,92vw);max-height:88vh;overflow:auto;background:#fff;color:#222;'
      + 'border:1px solid #ccc;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.28);'
      + 'font-family:system-ui,-apple-system,sans-serif;font-size:13px;';
    document.body.appendChild(p);
    renderDiagPanel();
    // Live-refresh while open.
    clearInterval(_panelTimer);
    _panelTimer = setInterval(renderDiagPanel, 500);
  }

  function closeDiagPanel() {
    clearInterval(_panelTimer); _panelTimer = null;
    const p = document.getElementById('ktt-diag-panel');
    if (p) p.remove();
  }

  function fmtMs(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(1) + ' s';
  }

  function renderDiagPanel() {
    const p = document.getElementById('ktt-diag-panel');
    if (!p) return;
    const ls = (pairEl && typeof pairEl.getLinkStatus === 'function')
      ? pairEl.getLinkStatus() : {};
    const state = badgeStateFromLink();
    const sty = BADGE_STYLES[state] || BADGE_STYLES.idle;

    const stateReason = {
      live:  'Data flowing normally.',
      stale: 'No recent data — link may be briefly interrupted.',
      dead:  'No data. Holding the connection open and trying to recover.',
      disconnected: 'Not connected.',
      idle:  'No device paired.',
    }[state] || '';

    const methodLabel = ls.pairMethod === 'lan'
      ? 'LAN / QR (offline)'
      : ls.pairMethod === 'turn' ? 'Relay (TURN)'
      : ls.pairMethod === 'stun' ? 'Direct (STUN)'
      : '—';

    // Recovery countdown when nursing a dead link.
    let recoveryRow = '';
    if (state === 'dead' && ls.recoverMs) {
      const left = Math.max(0, ls.recoverMs - (ls.deadForMs || 0));
      recoveryRow = row('Auto-recovery', `gives up in ${fmtMs(left)}`);
    }

    // Backgrounding warnings.
    let bgWarn = '';
    if (_selfBackgrounded || _peerBackgrounded) {
      const who = _selfBackgrounded && _peerBackgrounded ? 'Both devices have'
        : _selfBackgrounded ? 'This device has' : 'The other device has';
      bgWarn = `<div style="margin:10px 12px;padding:8px 10px;background:#fff3cd;`
        + `border:1px solid #ffe08a;border-radius:8px;color:#7a5b00;font-size:12px">`
        + `⚠ ${who} left the app in the background. The connection is being held open.</div>`;
    }

    // Re-pair button only mentions QR if THIS session actually used it.
    const repairNote = ls.pairMethod === 'lan'
      ? 'Starts fresh pairing (QR scan needed offline).'
      : 'Starts fresh pairing on a new device.';

    p.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;
                  padding:14px 16px;border-bottom:1px solid #eee">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="width:11px;height:11px;border-radius:50%;background:${sty.dot}"></span>
          <strong style="font-size:15px">${sty.text}</strong>
          <span style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.04em">
            ${ls.role || '—'}</span>
        </div>
        <button id="ktt-diag-close" style="border:none;background:none;font-size:20px;
                cursor:pointer;color:#999;line-height:1">&times;</button>
      </div>
      <div style="padding:4px 12px 0;color:#666;font-size:12px">${stateReason}</div>
      ${bgWarn}
      <div style="padding:10px 4px">
        ${row('Round-trip', ls.rtt != null ? Math.round(ls.rtt) + ' ms' : '—')}
        ${row('Last packet', fmtMs(ls.lastSeenMs))}
        ${recoveryRow}
        ${row('Method', methodLabel)}
        ${row('Verify code', ls.verifyCode || '—')}
        ${row('ICE state', ls.iceState || '—')}
        ${row('PC state', ls.connState || '—')}
        ${row('Data channel', ls.dcState || '—')}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px;border-top:1px solid #eee">
        <button class="ktt-diag-btn" id="ktt-diag-reconnect"
                style="background:#1a5fa5;color:#fff;border:none">Reconnect</button>
        <button class="ktt-diag-btn" id="ktt-diag-repair">Re-pair / switch device</button>
        <button class="ktt-diag-btn" id="ktt-diag-disconnect"
                style="color:#c62828">Disconnect</button>
      </div>
      <div style="padding:0 16px 14px;color:#999;font-size:11px">${repairNote}</div>
    `;

    p.querySelector('#ktt-diag-close').onclick = closeDiagPanel;
    p.querySelector('#ktt-diag-reconnect').onclick = () => {
      kttLog('🔁', 'Manual reconnect from panel');
      openPairModal();
    };
    p.querySelector('#ktt-diag-repair').onclick = () => {
      kttLog('♻️', 'Re-pair from scratch from panel');
      if (!confirm('Start fresh pairing? The current test will keep running.')) return;
      clearReconnectState();
      try { pairEl.disconnect(); } catch (_) {}
      openPairModal();
    };
    p.querySelector('#ktt-diag-disconnect').onclick = () => {
      kttLog('🔌', 'Manual disconnect from panel');
      try { pairEl.disconnect(); } catch (_) {}
      closeDiagPanel();
    };
  }

  function row(label, value) {
    return `<div style="display:flex;justify-content:space-between;padding:5px 12px;
            border-bottom:1px solid #f4f4f4">
            <span style="color:#888">${label}</span>
            <span style="font-variant-numeric:tabular-nums;color:#333">${value}</span></div>`;
  }

  // ─── Backgrounding detection ──────────────────────────────────────────────
  //
  // Each device tells the peer when it is backgrounded / foregrounded, so the
  // clinician (and, in dev, the child device too) can SEE the moment a device
  // leaves the app — the common "kid navigated away" / "iPad locked" case that
  // ICE is too slow to report. This complements the heartbeat: backgrounding is
  // an explicit, instant signal; the heartbeat is the fallback when the device
  // freezes before it can send anything.

  function reportBackground(isBackground) {
    if (!pairSecure) return;
    try { pairEl.send('ktt-bg', { bg: isBackground, ts: Date.now() }); } catch (_) {}
  }

  function onKttBackground(p) {
    _peerBackgrounded = !!(p && p.bg);
    kttLog(_peerBackgrounded ? '🌙' : '☀️',
      'Peer', _peerBackgrounded ? 'backgrounded' : 'foregrounded', 'the app');
    updateStatusBadge();
  }

  function wireBackgroundDetection() {
    document.addEventListener('visibilitychange', () => {
      _selfBackgrounded = document.visibilityState === 'hidden';
      kttLog(_selfBackgrounded ? '🌙' : '☀️',
        'This device', _selfBackgrounded ? 'hidden' : 'visible');
      // Tell the peer BEFORE we may get frozen (send is best-effort).
      reportBackground(_selfBackgrounded);
      updateStatusBadge();
    });
    // pagehide fires on navigation-away / tab close — last chance to warn the peer.
    window.addEventListener('pagehide', () => { reportBackground(true); });
  }

  // ─── CONTROLLER — send helpers ────────────────────────────────────────────

  function onKttReadyReceived() {
    if (pairRole !== 'controller') return;
    responderReady = true;
    kttLog('✅', 'Responder is ready (tapped commence)');
    if (typeof window.kttManual?.onPairReady === 'function') window.kttManual.onPairReady();
  }

  function sendListReset(listName) {
    if (!pairSecure || pairRole !== 'controller') return;
    responderReady = false;
    kttLog('📋', 'sendListReset:', listName || '(no name)');
    if (typeof window.kttManual?.onPairResponderWaiting === 'function') window.kttManual.onPairResponderWaiting();
    pairEl.send('ktt-list-reset', { listName: listName || '' });
  }

  function sendDisplay(showLabels) {
    if (!pairSecure || pairRole !== 'controller') return;
    respShowLabels = showLabels;
    kttLog('🏷', 'sendDisplay: showLabels =', showLabels);
    pairEl.send('ktt-display', { showLabels });
  }

  function sendSync() {
    if (!pairSecure || pairRole !== 'controller') return;
    responderReady = false;
    if (typeof window.kttManual?.onPairResponderWaiting === 'function') window.kttManual.onPairResponderWaiting();
    const list = window.kttManual?.getActiveListForPair?.() || null;
    if (!list) { kttWarn('📤', 'sendSync: no active list'); return; }
    // Include current showLabels setting from clinician
    const showLabels = typeof window.kttManual?.getShowLabels === 'function'
      ? window.kttManual.getShowLabels() : true;
    kttLog('📤', 'sendSync: list =', list.name, '| kupu count:', list.kupu.length, '| showLabels:', showLabels);
    pairEl.send('ktt-sync', { kupu: list.kupu, listName: list.name, showLabels });
    const overrides = window.kttImageStore ? window.kttImageStore.all() : {};
    const keys = Object.keys(overrides).filter(k => list.kupu.includes(k));
    kttLog('🖼', 'Image overrides to send:', keys.length, keys.length ? keys : '(none)');
    let delay = 100;
    keys.forEach(kupu => {
      const dataURL = overrides[kupu];
      if (!dataURL) return;
      const chunks = [];
      for (let i = 0; i < dataURL.length; i += CHUNK_BYTES) chunks.push(dataURL.slice(i, i + CHUNK_BYTES));
      kttLog('🖼', `  ${kupu}: ${chunks.length} chunk(s), ~${Math.round(dataURL.length/1024)}KB`);
      chunks.forEach((chunk, idx) => {
        setTimeout(() => {
          if (!pairSecure) return;
          pairEl.send('ktt-image-chunk', { kupu, idx, total: chunks.length, data: chunk });
        }, delay);
        delay += 60;
      });
    });
  }

  function sendPlay(kupu, level) {
    if (!pairSecure || pairRole !== 'controller') return;
    kttLog('▶', `sendPlay: ${kupu} @ ${level} dBA | playAudio on responder: ${audioFromResponder}`);
    pairEl.send('ktt-play', { kupu, level, playAudio: audioFromResponder });
    pendingResponse = null;
  }

  function sendConfirm(correct) {
    if (!pairSecure || pairRole !== 'controller') return;
    kttLog('📝', `sendConfirm: ${correct ? 'CORRECT' : 'INCORRECT'} | kupu: ${pendingResponse}`);
    pairEl.send('ktt-confirm', { correct, kupu: pendingResponse });
    pendingResponse = null;
    refreshControllerHighlight(null);
  }

  // ─── CONTROLLER — receive response ────────────────────────────────────────

  function onKttResponse(p) {
    if (pairRole !== 'controller') return;
    kttLog('👆', `Responder tapped: ${p.kupu} (prev: ${pendingResponse || 'none'})`);
    pendingResponse = p.kupu;
    refreshControllerHighlight(p.kupu);
    if (typeof window.kttManual?.onPairResponse === 'function') window.kttManual.onPairResponse(p.kupu);
  }

  function refreshControllerHighlight(kupu) {
    document.querySelectorAll('#mt-tbody tr').forEach(tr => tr.classList.remove('mt-row-peer-response'));
    if (!kupu) return;
    const row = document.querySelector(`#mt-tbody tr[data-kupu="${CSS.escape(kupu)}"]`);
    if (row) row.classList.add('mt-row-peer-response');
  }

  // ─── RESPONDER — receive and render ───────────────────────────────────────

  const _imgChunks = {};

  function onKttListReset(p) {
    if (pairRole !== 'responder') return;
    kttLog('📋', 'Received list-reset — returning to waiting screen');
    respKupu = []; respArmed = false; respTapped = null;
    stopRespAudio();
    activateResponderMode();
  }

  function onKttDisplay(p) {
    if (pairRole !== 'responder') return;
    respShowLabels = p.showLabels;
    kttLog('🏷', 'Received ktt-display: showLabels =', respShowLabels);
    // Update labels on existing grid without full re-render
    document.querySelectorAll('#ktt-responder-grid .resp-lbl').forEach(lbl => {
      lbl.style.display = respShowLabels ? '' : 'none';
    });
  }

  function onKttSync(p) {
    if (pairRole !== 'responder') return;
    respKupu = p.kupu || [];
    if (p.showLabels !== undefined) respShowLabels = p.showLabels;
    kttLog('📥', 'Received ktt-sync | kupu count:', respKupu.length, '| showLabels:', respShowLabels);
    renderResponderGrid();
  }

  function onKttImageChunk(p) {
    if (pairRole !== 'responder') return;
    const { kupu, idx, total, data } = p;
    if (!_imgChunks[kupu]) _imgChunks[kupu] = { parts: Array(total).fill(''), received: 0, total };
    const c = _imgChunks[kupu];
    if (!c.parts[idx]) { c.parts[idx] = data; c.received++; }
    if (c.received === c.total) {
      kttLog('🖼', `Image chunk complete for ${kupu} (${total} chunk(s))`);
      const dataURL = c.parts.join('');
      delete _imgChunks[kupu];
      const img = document.querySelector(`#ktt-responder-grid [data-kupu="${CSS.escape(kupu)}"] img`);
      if (img) { img.src = dataURL; kttLog('🖼', `Updated img for ${kupu}`); }
      else kttWarn('🖼', `No img element found for ${kupu} in grid`);
    } else {
      kttLog('🖼', `Chunk ${idx+1}/${total} received for ${kupu}`);
    }
  }

  function onKttPlay(p) {
    if (pairRole !== 'responder') return;
    kttLog('▶', `Received ktt-play: ${p.kupu} @ ${p.level} dBA | playAudio: ${p.playAudio}`);
    respArmed = false; respTapped = null; respConfirmed = false;
    document.querySelectorAll('#ktt-responder-grid .resp-cell').forEach(c => {
      c.classList.remove('resp-tapped', 'resp-done');
    });
    if (p.playAudio) {
      stopRespAudio();
      const carrierURL = CARRIER_URL;
      const kupuURL    = `${AUDIO_DIR}/${encodeURIComponent(p.kupu)}.mp3`;
      kttLog('🎵', 'Playing audio on responder | audioCtx:', _audioCtx?.state || 'none');
      if (!_audioCtx) {
        kttWarn('🎵', 'AudioContext not yet unlocked — showing tap prompt');
        showRespAudioPrompt(() => {
          playAudioIOS(carrierURL).then(() => playAudioIOS(kupuURL))
            .then(() => { kttLog('🎵', 'Audio complete, arming grid'); respArmed = true; })
            .catch(e => { kttWarn('🎵', 'Audio error:', e.message); respArmed = true; });
        });
      } else {
        playAudioIOS(carrierURL).then(() => playAudioIOS(kupuURL))
          .then(() => { kttLog('🎵', 'Audio complete, arming grid'); respArmed = true; })
          .catch(e => { kttWarn('🎵', 'Audio error:', e.message); respArmed = true; });
      }
    } else {
      kttLog('🎵', 'Audio playing on controller — arming grid after 800ms');
      setTimeout(() => { respArmed = true; }, 800);
    }
  }

  function onKttConfirm(p) {
    if (pairRole !== 'responder') return;
    kttLog('📝', `Received confirm | kupu: ${p.kupu}`);
    respConfirmed = true;
    const cell = document.querySelector(`#ktt-responder-grid [data-kupu="${CSS.escape(p.kupu || respTapped)}"]`);
    if (cell) {
      // Neutral acknowledgement only — no correct/incorrect feedback to the child
      cell.classList.remove('resp-tapped');
      cell.classList.add('resp-done');
      setTimeout(() => {
        cell.classList.remove('resp-done');
        respConfirmed = false; respTapped = null; respArmed = true;
        kttLog('📝', 'Confirm done — grid re-armed');
      }, 600);
    } else {
      kttWarn('📝', 'No cell found for confirm kupu:', p.kupu || respTapped);
      respConfirmed = false; respTapped = null; respArmed = true;
    }
  }

  function showRespAudioPrompt(onTap) {
    const existing = document.getElementById('ktt-audio-prompt');
    if (existing) { existing.remove(); }

    const prompt = document.createElement('div');
    prompt.id = 'ktt-audio-prompt';
    prompt.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      font-family:system-ui,sans-serif;color:#fff;text-align:center;padding:24px;
    `;
    prompt.innerHTML = `
      <div style="font-size:52px;margin-bottom:16px">🔊</div>
      <div style="font-size:20px;font-weight:700;margin-bottom:8px">Tap to enable sound</div>
      <div style="font-size:14px;color:rgba(255,255,255,.8)">Your device needs a tap to allow audio</div>
    `;
    prompt.onclick = () => {
      unlockAudio();
      prompt.remove();
      onTap();
    };
    document.body.appendChild(prompt);
  }

  function stopRespAudio() {
    [respCarrier, respKupuAud].forEach(a => { if (a) { a.pause(); a.currentTime = 0; } });
  }

  // ─── RESPONDER — full-screen grid UI ─────────────────────────────────────

  function activateResponderMode() {
    // Hide all clinician views
    ['settingsView','testView','manualSetupView','manualTestView'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.style.display = 'none'; el.classList.remove('active'); }
    });

    // Show or create the responder view
    let view = document.getElementById('ktt-responder-view');
    if (!view) {
      view = document.createElement('div');
      view.id = 'ktt-responder-view';
      document.body.appendChild(view);
    }
    view.style.display = 'flex';
    view.className = 'resp-view';
    renderResponderGrid();
  }

  function renderResponderGrid() {
    const view = document.getElementById('ktt-responder-view');
    if (!view) return;
    view.innerHTML = '';

    // Waiting state
    if (!respKupu.length) {
      view.innerHTML = `<div class="resp-waiting">
        <div style="font-size:48px;margin-bottom:16px">👂</div>
        <div style="font-size:20px;font-weight:700;color:#333">Waiting for clinician…</div>
        <div style="font-size:14px;color:#888;margin-top:8px">🔒 Securely connected</div>
      </div>`;
      addResponderDebugGesture(view);
      return;
    }

    const grid = document.createElement('div');
    grid.id = 'ktt-responder-grid';
    grid.className = 'resp-grid';

    // Build absolute base URL so images load correctly regardless of navigation state
    const base = location.href.replace(/\/[^/]*$/, '/');

    respKupu.forEach(kupu => {
      const cell = document.createElement('div');
      cell.className = 'resp-cell';
      cell.dataset.kupu = kupu;

      const img = document.createElement('img');
      img.alt = kupu;
      img.style.background = '#f5f5f5'; // visible while loading

      // Try extensions in order using absolute URLs
      const exts = ['png','jpg','jpeg','webp'];
      let extIdx = 0;
      function tryNext() {
        if (extIdx >= exts.length) { img.style.visibility = 'hidden'; return; }
        img.src = `${base}Images/${encodeURIComponent(kupu)}.${exts[extIdx++]}`;
      }
      img.onerror = tryNext;
      img.onload  = () => { img.style.visibility = ''; };
      tryNext();

      const lbl = document.createElement('div');
      lbl.className = 'resp-lbl';
      lbl.textContent = kupu;
      if (!respShowLabels) lbl.style.display = 'none';

      cell.append(img, lbl);
      cell.addEventListener('click',    ()  => onResponderTap(kupu));
      cell.addEventListener('touchend', (e) => { e.preventDefault(); onResponderTap(kupu); });
      grid.appendChild(cell);
    });

    view.appendChild(grid);
    respArmed = false;

    // Invisible triple-tap zone top-right — opens debug panel without disrupting session
    addResponderDebugGesture(view);

    // Always show "Tap here to commence"
    showCommenceOverlay();
  }

  function addResponderDebugGesture(view) {
    // Remove any existing gesture zone
    const existing = view.querySelector('.resp-debug-zone');
    if (existing) existing.remove();

    const zone = document.createElement('div');
    zone.className = 'resp-debug-zone';
    zone.style.cssText = `
      position:fixed;top:0;right:0;width:60px;height:60px;z-index:7000;
      cursor:default;-webkit-tap-highlight-color:transparent;
    `;

    let tapCount = 0;
    let tapTimer = null;

    zone.addEventListener('touchend', (e) => {
      e.preventDefault();
      tapCount++;
      clearTimeout(tapTimer);
      if (tapCount >= 3) {
        tapCount = 0;
        kttLog('🐛', 'Triple-tap debug gesture detected on responder');
        window.kttDebugPanel?.toggle();
      } else {
        tapTimer = setTimeout(() => { tapCount = 0; }, 600);
      }
    });

    // Also works with mouse for desktop testing
    zone.addEventListener('click', () => {
      tapCount++;
      clearTimeout(tapTimer);
      if (tapCount >= 3) {
        tapCount = 0;
        window.kttDebugPanel?.toggle();
      } else {
        tapTimer = setTimeout(() => { tapCount = 0; }, 600);
      }
    });

    document.body.appendChild(zone);
  }

  function showCommenceOverlay() {
    const existing = document.getElementById('ktt-commence-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ktt-commence-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(15,40,80,.82);z-index:6500;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      font-family:system-ui,sans-serif;color:#fff;text-align:center;padding:32px;
      cursor:pointer;-webkit-tap-highlight-color:transparent;
    `;
    overlay.innerHTML = `
      <div style="font-size:56px;margin-bottom:20px">👂</div>
      <div style="font-size:24px;font-weight:700;margin-bottom:10px">Tap here to commence</div>
      <div style="font-size:15px;color:rgba(255,255,255,.75);max-width:280px;line-height:1.5">
        This will also enable audio on your device
      </div>
    `;
    overlay.onclick = () => {
      unlockAudio();
      overlay.remove();
      // Tell controller the responder is ready
      if (pairSecure) pairEl.send('ktt-ready', { ts: Date.now() });
    };
    document.body.appendChild(overlay);
  }

  function onResponderTap(kupu) {
    unlockAudio();
    kttLog('👆', `Tap: ${kupu} | armed: ${respArmed} | confirmed: ${respConfirmed} | tapped: ${respTapped}`);
    if (!respArmed) { kttLog('👆', 'Ignoring — grid not armed'); return; }
    if (respConfirmed) { kttLog('👆', 'Ignoring — waiting for confirm flash to finish'); return; }
    document.querySelectorAll('#ktt-responder-grid .resp-cell').forEach(c => c.classList.remove('resp-tapped'));
    respTapped = kupu;
    const cell = document.querySelector(`#ktt-responder-grid [data-kupu="${CSS.escape(kupu)}"]`);
    if (cell) cell.classList.add('resp-tapped');
    if (pairSecure) {
      kttLog('👆', 'Sending ktt-response:', kupu);
      pairEl.send('ktt-response', { kupu, ts: Date.now() });
    } else {
      kttWarn('👆', 'Not connected — response not sent');
    }
  }

  // ─── CSS injection ────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('ktt-paired-styles')) return;
    const s = document.createElement('style');
    s.id = 'ktt-paired-styles';
    s.textContent = `
      /* Responder full-screen view */
      #ktt-responder-view {
        position: fixed; inset: 0; background: #f0f4f8;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        z-index: 5000; padding: 12px; box-sizing: border-box;
      }
      .resp-waiting {
        text-align: center; padding: 40px;
      }
      .resp-grid {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: clamp(6px, 1.5vw, 12px);
        width: 100%; max-width: 900px;
        max-height: 100%;
      }
      @media (orientation: portrait) {
        .resp-grid { grid-template-columns: repeat(3, 1fr); }
      }
      .resp-cell {
        background: #fff; border: 3px solid #ddd; border-radius: 14px;
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; padding: 8px; gap: 5px;
        cursor: pointer; user-select: none;
        transition: border-color .15s, background .15s, transform .08s;
        -webkit-tap-highlight-color: transparent;
        aspect-ratio: 1;
      }
      .resp-cell:active { transform: scale(.96); }
      .resp-cell img { width: 100%; flex: 1; object-fit: contain; min-height: 0; border-radius: 6px; }
      .resp-lbl { font-size: clamp(10px, 2vw, 14px); font-weight: 700; color: #333; text-align: center; }

      /* States */
      .resp-cell.resp-tapped   { border-color: #f0a500; background: #fff8e6; transform: scale(.98); }
      .resp-cell.resp-done     { opacity: 0.4; transition: opacity 0.3s; }

      /* Controller: amber highlight for peer response */
      .mt-row-peer-response td { background: #fff3cd !important; }
      .mt-row-peer-response:hover td { background: #ffe8a0 !important; }

      /* Connection status badge */
      #ktt-pair-status {
        display: inline-block; padding: 3px 10px; border-radius: 999px;
        font-size: 11px; font-weight: 600;
        background: #f5f5f5; color: #888; border: 1px solid #ddd;
      }

      /* Audio source toggle */
      .mt-audio-src-seg {
        display: flex; border: 1px solid #ccc; border-radius: 6px;
        overflow: hidden; width: 100%;
      }
      .mt-audio-src-btn {
        flex: 1; font-size: 11px; padding: 5px 8px; background: #fff;
        color: #666; cursor: pointer; border: none; text-align: center;
      }
      .mt-audio-src-btn.on { background: #e8f0fc; color: #1a5fa5; font-weight: 700; }
    `;
    document.head.appendChild(s);
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  injectStyles();
  document.addEventListener('DOMContentLoaded', init);

})();
