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
  let respKupu     = [];     // current 15 kupu
  let respArmed    = false;  // grid is accepting taps
  let respTapped   = null;   // which kupu was tapped

  // Audio (responder plays these)
  let respCarrier  = null;
  let respKupuAud  = null;

  // ─── Public API (called from manualTest.js) ───────────────────────────────

  window.kttPaired = {
    init,
    openPairModal,
    isConnected:    () => pairSecure,
    getRole:        () => pairRole,
    sendPlay,
    sendSync,
    sendConfirm,
    setAudioSource, // 'controller' | 'responder'
    statusEl:       null,   // set by init — a DOM element for status badge
  };

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
    pairEl.on('ktt-list-update', onKttSync);

    // ?role=responder support (future)
    if (new URLSearchParams(location.search).get('role') === 'responder') {
      openPairModal();
      setTimeout(() => {
        document.querySelectorAll('.rp-modal button').forEach(b => {
          if (b.textContent.trim() === 'Responder device') b.click();
        });
      }, 500);
    }
  }

  function openPairModal() {
    // First call: append to DOM (triggers connectedCallback → showModal)
    if (!pairEl.parentNode) {
      document.body.appendChild(pairEl);
    } else {
      pairEl.open();
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
      // Send the current list and images to responder
      sendSync();
    } else {
      // Responder: hide clinician UI, show responder grid
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
    if (pairRole === 'controller') sendSync();
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
    // Highlight the tapped kupu row in amber in the scoring table
    refreshControllerHighlight(p.kupu);
    // Notify manualTest.js
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
    respArmed  = false;
    respTapped = null;
    // Clear any previous highlight
    document.querySelectorAll('#ktt-responder-grid .resp-cell').forEach(c => {
      c.classList.remove('resp-tapped', 'resp-correct', 'resp-incorrect');
    });

    if (p.playAudio) {
      stopRespAudio();
      respCarrier = new Audio(CARRIER_URL);
      respKupuAud = new Audio(`${AUDIO_DIR}/${encodeURIComponent(p.kupu)}.mp3`);
      respCarrier.play().catch(() => {});
      respCarrier.onended = () => {
        respKupuAud.play().catch(() => {});
        respKupuAud.onended = () => { respArmed = true; };
      };
    } else {
      // Controller is playing audio — give a small delay then arm the grid
      setTimeout(() => { respArmed = true; }, 800);
    }
  }

  function onKttConfirm(p) {
    if (pairRole !== 'responder') return;
    const cell = document.querySelector(
      `#ktt-responder-grid [data-kupu="${CSS.escape(p.kupu || respTapped)}"]`
    );
    if (cell) {
      cell.classList.remove('resp-tapped');
      cell.classList.add(p.correct ? 'resp-correct' : 'resp-incorrect');
      setTimeout(() => {
        cell.classList.remove('resp-correct', 'resp-incorrect');
        respArmed = true;
        respTapped = null;
      }, 1200);
    }
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
  }

  function onResponderTap(kupu) {
    if (!respArmed || respTapped) return;
    respArmed  = false;
    respTapped = kupu;

    // Highlight tapped cell amber
    document.querySelectorAll('#ktt-responder-grid .resp-cell').forEach(c => {
      c.classList.remove('resp-tapped');
    });
    const cell = document.querySelector(`#ktt-responder-grid [data-kupu="${CSS.escape(kupu)}"]`);
    if (cell) cell.classList.add('resp-tapped');

    // Send response to controller
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
