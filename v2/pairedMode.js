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

  async function getFB() {
    if (pairEl._fb?.initialized) {
      kttLog('🔥', 'Firebase already initialized');
      return pairEl._fb;
    }
    if (!pairEl.parentNode) { kttLog('🔥', 'Appending pairEl for Firebase init'); document.body.appendChild(pairEl); }
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

    if (!pairEl.parentNode) {
      kttLog('⚡', 'Appending pairEl to DOM for Firebase access');
      document.body.appendChild(pairEl);
    }

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

    if (!pairEl.parentNode) {
      kttLog('📡', 'Appending pairEl to DOM for Firebase access');
      document.body.appendChild(pairEl);
    }

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

    kttLog('🚀', 'All listeners registered. pairEl NOT in DOM yet.');

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
      kttLog('📡', 'Scheduling responder beacon check in 2s');
      setTimeout(responderCheckBeacon, 2000);
    }
  }

  function openPairModal() {
    const state = loadReconnectState();
    kttLog('📱', 'openPairModal — saved state:', state, '| pairSecure:', pairSecure);

    if (state?.secret && state.role === 'controller' && !pairSecure) {
      kttLog('⚡', 'Attempting fast reconnect before opening modal');
      attemptFastReconnect().then(found => {
        kttLog('⚡', 'Fast reconnect result:', found ? 'succeeded' : 'failed/timed out', '— opening modal');
        if (!pairEl.parentNode) document.body.appendChild(pairEl);
        else pairEl.open();
      });
    } else {
      kttLog('📱', 'Opening modal directly (no saved state or already connected)');
      if (!pairEl.parentNode) document.body.appendChild(pairEl);
      else pairEl.open();
    }
  }

  function setAudioSource(src) {
    audioFromResponder = (src === 'responder');
  }

  // ─── Connection events ────────────────────────────────────────────────────

  function onSecure(e) {
    pairRole   = e.detail.role;
    pairSecure = true;
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

  function onDisconnected() {
    pairSecure = false;
    kttLog('❌', 'DISCONNECTED');
    updateStatusBadge('disconnected');
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

  // ─── Status badge ─────────────────────────────────────────────────────────

  function updateStatusBadge(state) {
    const el = document.getElementById('ktt-pair-status');
    if (!el) return;
    const map = {
      connected:    { text: '🔒 Paired',         bg: '#e8f5e9', color: '#2e7d32', border: '#a5d6a7' },
      disconnected: { text: '⚠ Disconnected',    bg: '#fff8e1', color: '#e65100', border: '#ffcc80' },
      idle:         { text: '📱 Not paired',      bg: '#f5f5f5', color: '#888',    border: '#ddd'    },
    };
    const s = map[state] || map.idle;
    el.textContent = s.text;
    el.style.cssText = `display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;background:${s.bg};color:${s.color};border:1px solid ${s.border}`;
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
      c.classList.remove('resp-tapped', 'resp-correct', 'resp-incorrect');
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
    kttLog('📝', `Received confirm: ${p.correct ? 'CORRECT' : 'INCORRECT'} | kupu: ${p.kupu}`);
    respConfirmed = true;
    const cell = document.querySelector(`#ktt-responder-grid [data-kupu="${CSS.escape(p.kupu || respTapped)}"]`);
    if (cell) {
      cell.classList.remove('resp-tapped');
      cell.classList.add(p.correct ? 'resp-correct' : 'resp-incorrect');
      setTimeout(() => {
        cell.classList.remove('resp-correct', 'resp-incorrect');
        respConfirmed = false; respTapped = null; respArmed = true;
        kttLog('📝', 'Confirm flash done — grid re-armed');
      }, 1200);
    } else {
      kttWarn('📝', 'No cell found for confirm kupu:', p.kupu || respTapped);
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

    // Always show "Tap here to commence" — unlocks iOS audio on first render,
    // and signals readiness to controller on every new test/list
    showCommenceOverlay();
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
      .resp-cell.resp-correct  { border-color: #2e7d32; background: #e8f5e9; }
      .resp-cell.resp-incorrect{ border-color: #c62828; background: #ffebee; }

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
