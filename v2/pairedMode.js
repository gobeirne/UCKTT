// pairedMode.js — RapidPair integration for UC KTT
// Controller: clinician device. Responder: child/client device.
// Both run the same URL. Role is chosen in the pairing modal.

(() => {
  'use strict';

  const AUDIO_DIR   = 'sounds';
  const CARRIER_URL = `${AUDIO_DIR}/keiheate.mp3`;
  // Max bytes per image chunk over data channel (WebRTC max msg ~256 KB, stay safe)
  const CHUNK_BYTES = 180000;

  // ─── State ────────────────────────────────────────────────────────────────

  let pairEl       = null;   // <rapid-pair> element
  let pairRole     = null;   // 'controller' | 'responder' | null
  let pairSecure   = false;
  let audioFromResponder = false;  // if true, responder plays audio
  let pendingResponse = null;      // kupu the responder tapped, awaiting confirm

  // Responder-side state
  let respKupu      = [];
  let respArmed     = false;
  let respTapped    = null;
  let respConfirmed = false;  // true after clinician confirms — blocks re-tap

  // Audio (responder plays these)
  let respCarrier  = null;
  let respKupuAud  = null;
  let _audioCtx    = null;   // unlocked AudioContext (iOS workaround)

  // Call on first user gesture on the responder device to unlock iOS audio
  function unlockAudio() {
    if (_audioCtx) return;
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Play a silent buffer — this is the gesture-triggered unlock
      const buf = _audioCtx.createBuffer(1, 1, 22050);
      const src = _audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(_audioCtx.destination);
      src.start(0);
      // Resume in case it started suspended
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
    } catch (_) {}
  }

  // iOS-safe play: use a fetch+decodeAudioData approach via the unlocked context
  function playAudioIOS(url) {
    return new Promise((resolve, reject) => {
      if (!_audioCtx) {
        // Fall back to standard Audio element if no context yet
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
        .catch(reject);
    });
  }

  // ─── Public API (called from manualTest.js) ───────────────────────────────

  window.kttPaired = {
    init,
    openPairModal,
    isConnected:    () => pairSecure,
    getRole:        () => pairRole,
    sendPlay,
    sendSync,
    sendListReset,
    sendConfirm,
    setAudioSource,
    statusEl:       null,
  };

  // ─── Fast reconnect ───────────────────────────────────────────────────────
  // On first pairing, controller generates a shared secret and sends it to the
  // responder via ktt-hello. Both store it in localStorage.
  // On subsequent pair attempts, controller writes a "beacon" doc to Firebase
  // under the secret. Responder (open in background) sees it and auto-enters
  // the pairing code in rapidpair's modal — no manual entry needed.

  const LS_KEY_RECONNECT = 'ktt_reconnect_v1';
  // How long to wait for the beacon response before falling back to full modal
  const BEACON_TIMEOUT_MS = 4000;
  const FB_BEACON_COLL    = 'ktt_beacons';  // separate Firestore collection

  function loadReconnectState() {
    try { return JSON.parse(localStorage.getItem(LS_KEY_RECONNECT) || 'null'); } catch { return null; }
  }
  function saveReconnectState(obj) {
    try { localStorage.setItem(LS_KEY_RECONNECT, JSON.stringify(obj)); } catch (_) {}
  }
  function clearReconnectState() {
    localStorage.removeItem(LS_KEY_RECONNECT);
  }

  // Called when controller gets secure — generate secret, send to responder
  function initReconnectSecret() {
    const existing = loadReconnectState();
    // Reuse existing secret if we have one; create new one if not
    const secret = existing?.secret || Array.from(crypto.getRandomValues(new Uint8Array(5)))
      .map(b => b.toString(36)).join('').toUpperCase();
    saveReconnectState({ secret, role: 'controller', savedAt: Date.now() });
    // Tell responder the secret so they can save it too
    pairEl.send('ktt-hello', { secret, v: 1 });
  }

  // Responder receives the hello and saves the secret
  function onKttHello(p) {
    if (pairRole !== 'responder') return;
    saveReconnectState({ secret: p.secret, role: 'responder', savedAt: Date.now() });
  }

  // Get the Firebase db reference — reuse rapidpair's own instance
  async function getFB() {
    // RapidPair lazily initialises Firebase when the element connects.
    // We trigger that by appending the element (which we do in openPairModal
    // anyway), then wait briefly for it to be ready.
    // Fall back to our own lightweight init if needed.
    if (pairEl._fb?.initialized) return pairEl._fb;
    // Wait up to 2s for pairEl Firebase to init
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (pairEl._fb?.initialized) return pairEl._fb;
    }
    return null; // timed out — fall through to normal modal
  }

  // Controller side: write a beacon, wait for responder to acknowledge
  async function attemptFastReconnect() {
    const state = loadReconnectState();
    if (!state?.secret || state.role !== 'controller') return false;

    showFastReconnectUI('Checking for saved device…');

    // Ensure pairEl is in DOM (needed for Firebase access)
    if (!pairEl.parentNode) document.body.appendChild(pairEl);

    const fb = await getFB();
    if (!fb) { hideFastReconnectUI(); return false; }

    const secret  = state.secret;
    const beaconId = secret + '_ctrl';
    const replyId  = secret + '_resp';

    try {
      // Write controller beacon
      const beaconRef = fb.doc(fb.db, FB_BEACON_COLL, beaconId);
      await fb.setDoc(beaconRef, { ts: fb.ts(), status: 'calling' });

      showFastReconnectUI('Waiting for responder device…');

      // Poll for responder's acknowledgement
      const found = await new Promise(resolve => {
        const deadline = setTimeout(() => resolve(false), BEACON_TIMEOUT_MS);
        const unsub = fb.onSnapshot(fb.doc(fb.db, FB_BEACON_COLL, replyId), snap => {
          if (snap.exists() && snap.data()?.status === 'ready') {
            clearTimeout(deadline);
            unsub();
            resolve(true);
          }
        });
      });

      // Clean up beacon docs
      fb.deleteDoc(beaconRef).catch(() => {});
      fb.deleteDoc(fb.doc(fb.db, FB_BEACON_COLL, replyId)).catch(() => {});

      hideFastReconnectUI();
      if (found) {
        showFastReconnectUI('Responder found — opening pairing…');
        // The responder device is online and ready.
        // Open the pairing modal — the responder will auto-enter the code.
        // Brief delay so the user sees the message.
        await new Promise(r => setTimeout(r, 600));
        hideFastReconnectUI();
        return true; // caller should proceed with pairEl.open()
      }
      return false;

    } catch (err) {
      console.warn('[KTT reconnect] beacon error:', err);
      hideFastReconnectUI();
      return false;
    }
  }

  // Responder side: poll for controller beacon on app load, auto-enter code
  async function responderCheckBeacon() {
    const state = loadReconnectState();
    if (!state?.secret || state.role !== 'responder') return;

    // Don't run if already connected
    if (pairSecure) return;

    const secret  = state.secret;
    const beaconId = secret + '_ctrl';
    const replyId  = secret + '_resp';

    // Ensure pairEl is in DOM
    if (!pairEl.parentNode) document.body.appendChild(pairEl);

    const fb = await getFB();
    if (!fb) return;

    try {
      // Check if controller beacon exists
      const snap = await fb.getDoc(fb.doc(fb.db, FB_BEACON_COLL, beaconId));
      if (!snap.exists()) return;

      const ageSec = (Date.now() - (snap.data()?.ts?.toMillis?.() || 0)) / 1000;
      if (ageSec > 30) return; // stale beacon

      // Write reply
      await fb.setDoc(fb.doc(fb.db, FB_BEACON_COLL, replyId), { ts: fb.ts(), status: 'ready' });

      // Clean up controller beacon
      fb.deleteDoc(fb.doc(fb.db, FB_BEACON_COLL, beaconId)).catch(() => {});

      // Open modal in responder mode — auto-click the responder role button
      pairEl.open();
      await new Promise(r => setTimeout(r, 300));
      document.querySelectorAll('.rp-modal button').forEach(b => {
        if (b.textContent.trim() === 'Responder device') b.click();
      });

    } catch (err) {
      console.warn('[KTT reconnect] responder beacon check error:', err);
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
    // Create the element and wire all listeners NOW so messages aren't missed,
    // but do NOT append it to the DOM yet — that would trigger connectedCallback
    // and auto-open the pairing modal immediately.
    pairEl = document.createElement('rapid-pair');
    pairEl.id = 'ktt-rapid-pair';
    pairEl.setAttribute('controller-label', 'Clinician');
    pairEl.setAttribute('responder-label',  'Responder device');
    pairEl.setAttribute('auto-close', 'true');

    // Wire events before appending
    pairEl.addEventListener('secure', onSecure);
    pairEl.addEventListener('disconnected', onDisconnected);
    pairEl.addEventListener('reconnected', onReconnected);

    // Controller receives
    pairEl.on('ktt-response', onKttResponse);

    // Responder receives
    pairEl.on('ktt-sync',        onKttSync);
    pairEl.on('ktt-image-chunk', onKttImageChunk);
    pairEl.on('ktt-play',        onKttPlay);
    pairEl.on('ktt-confirm',     onKttConfirm);
    pairEl.on('ktt-list-reset',  onKttListReset);
    pairEl.on('ktt-list-update', onKttSync);
    pairEl.on('ktt-hello',       onKttHello);

    // ?role=responder support (future)
    if (new URLSearchParams(location.search).get('role') === 'responder') {
      openPairModal();
      setTimeout(() => {
        document.querySelectorAll('.rp-modal button').forEach(b => {
          if (b.textContent.trim() === 'Responder device') b.click();
        });
      }, 500);
    }

    // If this device has a saved responder pairing, silently check for a
    // waiting controller beacon in the background (runs ~2s after load)
    const state = loadReconnectState();
    if (state?.secret && state.role === 'responder') {
      setTimeout(responderCheckBeacon, 2000);
    }
  }

  function openPairModal() {
    // If we have a saved pairing, try fast reconnect first
    const state = loadReconnectState();
    if (state?.secret && state.role === 'controller' && !pairSecure) {
      attemptFastReconnect().then(found => {
        // Whether found or not, open the modal — if found the responder will
        // auto-enter their side, if not the clinician does it manually as normal
        if (!pairEl.parentNode) document.body.appendChild(pairEl);
        else pairEl.open();
      });
    } else {
      // First time or responder role — just open normally
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
    updateStatusBadge('connected');

    if (pairRole === 'controller') {
      // Generate/reuse shared reconnect secret and send to responder
      initReconnectSecret();
      // Tell responder to show waiting state — grid populates on "Start test"
      const list = window.kttManual?.getActiveListForPair?.();
      sendListReset(list?.name || '');
    } else {
      // Responder: hide clinician UI, show waiting screen
      activateResponderMode();
    }
  }

  function onDisconnected() {
    pairSecure = false;
    updateStatusBadge('disconnected');
  }

  function onReconnected(e) {
    pairRole   = e.detail.role;
    pairSecure = true;
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

  function sendListReset(listName) {
    if (!pairSecure || pairRole !== 'controller') return;
    pairEl.send('ktt-list-reset', { listName: listName || '' });
  }

  function sendSync() {
    if (!pairSecure || pairRole !== 'controller') return;
    const list = window.kttManual?.getActiveListForPair?.() || null;
    if (!list) return;

    // Send list structure first (fast, small)
    pairEl.send('ktt-sync', { kupu: list.kupu, listName: list.name });

    // Then stream image overrides as individual chunks
    const overrides = window.kttImageStore ? window.kttImageStore.all() : {};
    const keys = Object.keys(overrides).filter(k => list.kupu.includes(k));
    let delay = 100;
    keys.forEach(kupu => {
      const dataURL = overrides[kupu];
      if (!dataURL) return;
      // Split large data URLs into chunks
      const chunks = [];
      for (let i = 0; i < dataURL.length; i += CHUNK_BYTES) {
        chunks.push(dataURL.slice(i, i + CHUNK_BYTES));
      }
      chunks.forEach((chunk, idx) => {
        setTimeout(() => {
          if (!pairSecure) return;
          pairEl.send('ktt-image-chunk', {
            kupu, idx, total: chunks.length, data: chunk
          });
        }, delay);
        delay += 60;
      });
    });
  }

  function sendPlay(kupu, level) {
    if (!pairSecure || pairRole !== 'controller') return;
    pairEl.send('ktt-play', {
      kupu,
      level,
      playAudio: audioFromResponder,  // if true, responder should play audio
    });
    // Mark responder grid as pending this kupu
    pendingResponse = null;
  }

  function sendConfirm(correct) {
    if (!pairSecure || pairRole !== 'controller') return;
    pairEl.send('ktt-confirm', { correct, kupu: pendingResponse });
    pendingResponse = null;
    // Clear highlight in controller table
    refreshControllerHighlight(null);
  }

  // ─── CONTROLLER — receive response ────────────────────────────────────────

  function onKttResponse(p) {
    if (pairRole !== 'controller') return;
    pendingResponse = p.kupu;
    refreshControllerHighlight(p.kupu);
    // Update confirm bar — works for both first response and changes
    if (typeof window.kttManual?.onPairResponse === 'function') {
      window.kttManual.onPairResponse(p.kupu);
    }
  }

  function refreshControllerHighlight(kupu) {
    document.querySelectorAll('#mt-tbody tr').forEach(tr => {
      tr.classList.remove('mt-row-peer-response');
    });
    if (!kupu) return;
    const row = document.querySelector(`#mt-tbody tr[data-kupu="${CSS.escape(kupu)}"]`);
    if (row) row.classList.add('mt-row-peer-response');
  }

  // ─── RESPONDER — receive and render ───────────────────────────────────────

  // Assembled image chunks: { kupu → { parts[], total, received } }
  const _imgChunks = {};

  function onKttListReset(p) {
    if (pairRole !== 'responder') return;
    respKupu   = [];
    respArmed  = false;
    respTapped = null;
    stopRespAudio();
    activateResponderMode();
  }

  function onKttSync(p) {
    if (pairRole !== 'responder') return;
    respKupu  = p.kupu || [];
    renderResponderGrid();
  }

  function onKttImageChunk(p) {
    if (pairRole !== 'responder') return;
    const { kupu, idx, total, data } = p;
    if (!_imgChunks[kupu]) _imgChunks[kupu] = { parts: Array(total).fill(''), received: 0, total };
    const c = _imgChunks[kupu];
    if (!c.parts[idx]) { c.parts[idx] = data; c.received++; }
    if (c.received === c.total) {
      const dataURL = c.parts.join('');
      delete _imgChunks[kupu];
      // Update image in responder grid
      const img = document.querySelector(`#ktt-responder-grid [data-kupu="${CSS.escape(kupu)}"] img`);
      if (img) img.src = dataURL;
    }
  }

  function onKttPlay(p) {
    if (pairRole !== 'responder') return;
    respArmed     = false;
    respTapped    = null;
    respConfirmed = false;
    // Clear any previous highlight
    document.querySelectorAll('#ktt-responder-grid .resp-cell').forEach(c => {
      c.classList.remove('resp-tapped', 'resp-correct', 'resp-incorrect');
    });

    if (p.playAudio) {
      stopRespAudio();
      const carrierURL = CARRIER_URL;
      const kupuURL    = `${AUDIO_DIR}/${encodeURIComponent(p.kupu)}.mp3`;

      // Show a "tap to play" prompt if audio context not yet unlocked (iOS first play)
      if (!_audioCtx) {
        showRespAudioPrompt(() => {
          playAudioIOS(carrierURL)
            .then(() => playAudioIOS(kupuURL))
            .then(() => { respArmed = true; })
            .catch(() => { respArmed = true; });
        });
      } else {
        playAudioIOS(carrierURL)
          .then(() => playAudioIOS(kupuURL))
          .then(() => { respArmed = true; })
          .catch(() => { respArmed = true; });
      }
    } else {
      setTimeout(() => { respArmed = true; }, 800);
    }
  }

  function onKttConfirm(p) {
    if (pairRole !== 'responder') return;
    respConfirmed = true;
    const cell = document.querySelector(
      `#ktt-responder-grid [data-kupu="${CSS.escape(p.kupu || respTapped)}"]`
    );
    if (cell) {
      cell.classList.remove('resp-tapped');
      cell.classList.add(p.correct ? 'resp-correct' : 'resp-incorrect');
      setTimeout(() => {
        cell.classList.remove('resp-correct', 'resp-incorrect');
        respConfirmed = false;
        respTapped    = null;
        respArmed     = true;
      }, 1200);
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

      cell.append(img, lbl);
      cell.addEventListener('click',    ()  => onResponderTap(kupu));
      cell.addEventListener('touchend', (e) => { e.preventDefault(); onResponderTap(kupu); });
      grid.appendChild(cell);
    });

    view.appendChild(grid);
    // Mark grid interactive immediately — first play will arm it properly
    respArmed = false;

    // Show a one-time audio unlock prompt at the bottom for iOS
    if (!_audioCtx) {
      const hint = document.createElement('div');
      hint.id = 'ktt-audio-hint';
      hint.style.cssText = `
        position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
        background:rgba(0,0,0,.7);color:#fff;font-family:system-ui,sans-serif;
        font-size:13px;padding:8px 18px;border-radius:999px;z-index:6000;
        pointer-events:none;
      `;
      hint.textContent = '🔊 Tap any image to enable audio';
      view.appendChild(hint);
      // Remove after first tap (unlockAudio called in onResponderTap)
      const removeHint = () => { hint.remove(); view.removeEventListener('click', removeHint); };
      view.addEventListener('click', removeHint);
    }
  }

  function onResponderTap(kupu) {
    // Unlock iOS audio on every tap (safe to call multiple times)
    unlockAudio();

    // Grid must be armed (i.e. a play has happened)
    if (!respArmed) return;
    // If clinician has already confirmed, don't allow changes
    if (respConfirmed) return;

    // Allow changing — clear previous highlight
    document.querySelectorAll('#ktt-responder-grid .resp-cell').forEach(c => {
      c.classList.remove('resp-tapped');
    });

    respTapped = kupu;

    const cell = document.querySelector(`#ktt-responder-grid [data-kupu="${CSS.escape(kupu)}"]`);
    if (cell) cell.classList.add('resp-tapped');

    // Send/update response to controller — controller confirm bar updates each time
    if (pairSecure) pairEl.send('ktt-response', { kupu, ts: Date.now() });
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
