// manualTest.js — Clinician manual test panel for UC KTT
// v2: dynamic columns, play-triggers-pip, mobile-first layout, UC header

(() => {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────

  const AUDIO_DIR        = 'sounds';
  const CARRIER_URL      = `${AUDIO_DIR}/keiheate.mp3`;
  const LS_KEY_SETTINGS  = 'ktt_manual_settings_v1';
  const LS_KEY_LISTS     = 'ktt_custom_lists_v1';
  const DEFAULT_LEVEL    = 40;
  const LEVEL_STEP       = 5;
  const LEVEL_MIN        = 20;
  const LEVEL_MAX        = 90;

  const SCORING_MODES = {
    free: { label: 'Full manual', desc: 'Clinician controls order, level, and scoring freely.' },
  };

  const USEFUL_PHRASES = [
    { mi: 'Kei hea te ___?',         en: 'Where is the ___?' },
    { mi: 'Ka pai tō whakarongo',     en: 'Good listening' },
    { mi: 'Ka pai!',                  en: 'Good!' },
    { mi: 'He tino pai tō mahi!',     en: 'Your work is very good!' },
    { mi: 'Ka rawe!',                 en: 'Excellent!' },
    { mi: 'Kei runga noa atu koe!',   en: 'You\'re above and beyond!' },
    { mi: 'Ka mau te wehi!',          en: 'Awesome!' },
    { mi: 'Karawhiua!',               en: 'Go for it!' },
    { mi: 'Turituri',                 en: 'Be quiet' },
  ];

  // Parse Isiah lists from the inline block (must be in DOM before this script runs)
  const ISIAH_LISTS = (() => {
    const node = document.getElementById('kupu-lists');
    if (!node) return [];
    const isPhoneme = t => t.startsWith('/');
    return node.textContent.trim().split(/\r?\n/)
      .map(line => line.split('\t').map(s => s.trim()).filter(Boolean)
        .filter(t => !isPhoneme(t)).slice(0, 15))
      .filter(row => row.length === 15)
      .map((kupu, i) => ({ id: `isiah_${i+1}`, name: `Isiah list ${i+1}`, kupu, builtin: true }));
  })();

  // ─── State ────────────────────────────────────────────────────────────────

  let allLists      = [];
  let activeListId  = null;
  let scoringMode   = 'free';
  let currentLevel  = DEFAULT_LEVEL;
  let armedKupu     = null;
  let showLabels    = true;
  let scores        = {};
  let levelsUsed    = [];
  let clinicianViewMode = 'words';
  let sessionMeta   = { clientName: '', nhi: '', dob: '', testDate: '', clinicianName: '', clinicianRole: '', location: '' };
  let sessionNotes  = '';
  let carrierAudio  = null;
  let kupuAudio     = null;

  // Clinic settings — persisted separately, survive across sessions
  const LS_KEY_CLINIC = 'ktt_clinic_settings_v1';
  function loadClinicSettings() {
    try { return JSON.parse(localStorage.getItem(LS_KEY_CLINIC) || '{}'); } catch { return {}; }
  }
  function saveClinicSettings(patch) {
    const cur = loadClinicSettings();
    localStorage.setItem(LS_KEY_CLINIC, JSON.stringify({ ...cur, ...patch }));
  }

  // ─── localStorage ─────────────────────────────────────────────────────────

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(LS_KEY_SETTINGS) || '{}'); } catch { return {}; }
  }
  function saveSettings(patch) {
    const cur = loadSettings();
    localStorage.setItem(LS_KEY_SETTINGS, JSON.stringify({ ...cur, ...patch }));
  }
  function loadCustomLists() {
    try { return JSON.parse(localStorage.getItem(LS_KEY_LISTS) || '[]'); } catch { return []; }
  }
  function saveCustomLists(lists) {
    localStorage.setItem(LS_KEY_LISTS, JSON.stringify(lists));
  }

  // ─── List management ──────────────────────────────────────────────────────

  function rebuildAllLists() {
    const custom = loadCustomLists();
    allLists = [...custom, ...ISIAH_LISTS];
    if (!allLists.find(l => l.id === activeListId))
      activeListId = allLists[0]?.id || null;
  }
  function getActiveList() {
    return allLists.find(l => l.id === activeListId) || allLists[0] || null;
  }

  // ─── Score helpers ────────────────────────────────────────────────────────

  function getPips(kupu, level) {
    if (!scores[kupu]) scores[kupu] = {};
    if (!scores[kupu][level]) scores[kupu][level] = [];
    return scores[kupu][level];
  }

  // Add a blank pip for kupu at level if there's no empty slot (called on Play)
  function ensurePipSlot(kupu, level) {
    const pips = getPips(kupu, level);
    const hasEmpty = pips.some(p => p === 'empty');
    if (!hasEmpty) pips.push('empty');
    // Ensure this level is tracked
    if (!levelsUsed.includes(level)) {
      levelsUsed.push(level);
      levelsUsed.sort((a, b) => a - b);
    }
  }

  function cyclePip(kupu, level, idx) {
    const pips = getPips(kupu, level);
    if (idx >= pips.length) return;
    const cur = pips[idx];
    pips[idx] = cur === 'empty' ? 'correct' : cur === 'correct' ? 'incorrect' : 'empty';
  }

  function levelTally(level) {
    const list = getActiveList();
    if (!list) return { nc: 0, ni: 0, total: 0 };
    let nc = 0, ni = 0;
    for (const kupu of list.kupu) {
      const pips = getPips(kupu, level);
      for (const p of pips) {
        if (p === 'correct') nc++;
        if (p === 'incorrect') ni++;
      }
    }
    return { nc, ni, total: nc + ni };
  }

  // ─── Audio ────────────────────────────────────────────────────────────────

  function stopAudio() {
    [carrierAudio, kupuAudio].forEach(a => { if (a) { a.pause(); a.currentTime = 0; } });
  }

  function playKupu(kupu) {
    if (!kupu) return;
    stopAudio();
    ensurePipSlot(kupu, currentLevel);

    const btn = document.getElementById('mt-play-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Playing…'; }

    // Tell responder (if paired) — responder plays if audioFromResponder
    if (window.kttPaired?.isConnected()) {
      window.kttPaired.sendPlay(kupu, currentLevel);
    }

    refreshScoringTable();

    // Play on this device unless responder is handling audio
    const responderPlays = window.kttPaired?.isConnected() &&
      document.querySelector('.mt-audio-src-btn:last-child.on');

    if (!responderPlays) {
      carrierAudio = new Audio(CARRIER_URL);
      kupuAudio    = new Audio(`${AUDIO_DIR}/${encodeURIComponent(kupu)}.mp3`);
      carrierAudio.play().catch(() => {});
      carrierAudio.onended = () => {
        kupuAudio.play().catch(() => {});
        kupuAudio.onended = () => {
          if (btn) { btn.disabled = !armedKupu; btn.textContent = '▶ Play'; }
        };
      };
    } else {
      if (btn) { btn.disabled = !armedKupu; btn.textContent = '▶ Play'; }
    }
  }

  // ─── View switching ───────────────────────────────────────────────────────

  function showView(id) {
    ['settingsView', 'testView', 'manualSetupView', 'manualTestView'].forEach(v => {
      const e = document.getElementById(v);
      if (e) { e.classList.remove('active'); e.style.display = 'none'; }
    });
    const target = document.getElementById(id);
    if (target) { target.classList.add('active'); target.style.display = 'block'; }
  }

  // ─── DOM helpers ──────────────────────────────────────────────────────────

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'cls') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function sect(title, content) {
    const w = el('div', { cls: 'mt-section' });
    if (title) w.appendChild(el('div', { cls: 'mt-section-label' }, title));
    w.appendChild(content);
    return w;
  }

  // ─── UC Header (shared) ───────────────────────────────────────────────────

  function makeHeader(subtitle, rightContent) {
    const hdr = el('div', { cls: 'mt-uc-header' });
    const left = el('div', { cls: 'mt-uc-header-left' });
    const logo = el('img', { src: 'UClogo.png', alt: 'UC', cls: 'mt-uc-logo' });
    const titles = el('div', { cls: 'mt-uc-titles' });
    titles.appendChild(el('div', { cls: 'mt-uc-title' }, 'Te reo Māori Kendall Toy Test'));
    if (subtitle) titles.appendChild(el('div', { cls: 'mt-uc-subtitle' }, subtitle));
    left.append(logo, titles);
    hdr.appendChild(left);
    if (rightContent) {
      const right = el('div', { cls: 'mt-uc-header-right' });
      right.appendChild(rightContent);
      hdr.appendChild(right);
    }
    return hdr;
  }

  // ─── SETUP SCREEN ─────────────────────────────────────────────────────────

  function renderSetupScreen() {
    const root = document.getElementById('manualSetupView');
    if (!root) return;
    rebuildAllLists();

    const S = loadSettings();
    ['clientName','nhi','dob','testDate','clinicianName','clinicianRole','location'].forEach(k => {
      if (S[k] !== undefined) sessionMeta[k] = S[k];
    });
    if (S.scoringMode) scoringMode = S.scoringMode;
    if (S.activeListId) activeListId = S.activeListId;
    if (S.clinicianViewMode) clinicianViewMode = S.clinicianViewMode;
    if (!activeListId && allLists.length) activeListId = allLists[0].id;

    root.innerHTML = '';

    // Header right: calibration link
    const calibLink = el('a', { cls: 'mt-btn', href: 'https://gobeirne.github.io/UCLing/', target: '_blank' },
      '🔊 Calibration');
    root.appendChild(makeHeader('Setup', calibLink));

    // Body
    const body = el('div', { cls: 'mt-setup-body' });
    root.appendChild(body);

    const left = el('div', { cls: 'mt-setup-left' });
    body.appendChild(left);
    left.appendChild(sect('Client', renderClientForm()));
    left.appendChild(sect('Test list', renderListSelector()));
    left.appendChild(sect('Scoring method', renderScoringSelector()));

    const right = el('div', { cls: 'mt-setup-right' });
    body.appendChild(right);
    right.appendChild(sect('Clinician view during test', renderViewToggle()));
    right.appendChild(sect('', renderActions()));
    right.appendChild(sect('Clinic / report settings', renderClinicSettings()));
    right.appendChild(sect('Custom lists', renderImportExport()));
  }

  function renderClientForm() {
    const wrap = el('div', { cls: 'mt-card' });

    function inp(label, key, placeholder, flex) {
      const d = el('div', { style: `flex:${flex||1};min-width:72px` });
      d.appendChild(el('div', { cls: 'mt-field-label' }, label));
      const i = el('input', { cls: 'mt-inp', placeholder, value: sessionMeta[key] || '',
        oninput: e => { sessionMeta[key] = e.target.value; saveSettings({ ...sessionMeta }); }
      });
      d.appendChild(i);
      return d;
    }

    const row1 = el('div', { cls: 'mt-form-row' });
    row1.append(inp('Client name', 'clientName', 'Full name', 2), inp('NHI', 'nhi', 'NHI number', 1));
    const row2 = el('div', { cls: 'mt-form-row' });
    row2.append(inp('Date of birth', 'dob', 'DD/MM/YYYY', 1), inp('Test date', 'testDate', 'Today', 1));
    const row3 = el('div', { cls: 'mt-form-row' });
    row3.append(inp('Clinician', 'clinicianName', 'Full name', 2), inp('Role', 'clinicianRole', 'e.g. Audiologist', 1));
    const row4 = el('div', { cls: 'mt-form-row' });
    row4.append(inp('Location / facility', 'location', 'e.g. Waikato Hospital', 3));
    wrap.append(row1, row2, row3, row4);
    return wrap;
  }

  function renderListSelector() {
    const wrap = el('div', { cls: 'mt-card mt-list-card' });
    const custom  = allLists.filter(l => !l.builtin);
    const builtin = allLists.filter(l => l.builtin);

    function listItem(list) {
      const item = el('div', { cls: 'mt-list-item' + (list.id === activeListId ? ' active' : ''),
        onclick: () => {
          activeListId = list.id;
          saveSettings({ activeListId });
          // If paired, tell responder to go back to waiting — new list not started yet
          if (window.kttPaired?.isConnected()) {
            window.kttPaired.sendListReset(list.name);
          }
          renderSetupScreen();
        }
      });
      const dot  = el('div', { cls: 'mt-list-dot ' + (list.builtin ? 'builtin' : 'custom') });
      const name = el('div', { cls: 'mt-list-name' }, list.name);
      name.appendChild(el('span', { cls: 'mt-badge ' + (list.builtin ? 'builtin' : 'custom') },
        list.builtin ? 'built-in' : 'custom'));
      const meta = el('div', { cls: 'mt-list-meta' }, `${list.kupu.length} kupu`);
      item.append(dot, name, meta);
      if (!list.builtin) {
        item.appendChild(el('button', { cls: 'mt-btn', style: 'padding:2px 8px;font-size:11px',
          onclick: e => { e.stopPropagation(); openListBuilder(list.id); }
        }, 'Edit'));
        item.appendChild(el('button', {
          cls: 'mt-btn', style: 'padding:2px 6px;font-size:11px;color:#c0392b;border-color:#e0b0b0',
          title: 'Delete this list',
          onclick: e => {
            e.stopPropagation();
            if (!confirm(`Delete "${list.name}"? This cannot be undone.`)) return;
            const remaining = loadCustomLists().filter(l => l.id !== list.id);
            saveCustomLists(remaining);
            if (activeListId === list.id) activeListId = null;
            rebuildAllLists();
            renderSetupScreen();
          }
        }, '✕'));
      }
      return item;
    }

    if (custom.length) {
      custom.forEach(l => wrap.appendChild(listItem(l)));
      wrap.appendChild(el('div', { cls: 'mt-divider' }));
    }
    builtin.forEach(l => wrap.appendChild(listItem(l)));
    wrap.appendChild(el('div', { style: 'padding:6px 8px' },
      el('button', { cls: 'mt-btn-sm-primary', onclick: () => openListBuilder(null) },
        '+ New custom list')));
    return wrap;
  }

  function renderScoringSelector() {
    const wrap = el('div', { cls: 'mt-scoring-cards' });

    // Active mode
    const card = el('div', { cls: 'mt-scoring-card active' });
    card.appendChild(el('div', { cls: 'mt-scoring-title' }, 'Full manual'));
    card.appendChild(el('div', { cls: 'mt-scoring-desc' }, 'Clinician controls order, level, and scoring freely.'));
    wrap.appendChild(card);

    // Ghosted future mode
    const ghost = el('div', { cls: 'mt-scoring-card', style: 'opacity:0.38;cursor:not-allowed' });
    ghost.appendChild(el('div', { cls: 'mt-scoring-title' }, 'Semi-automated adaptive'));
    ghost.appendChild(el('div', { cls: 'mt-scoring-desc' }, 'Finds SRT automatically. Coming soon.'));
    const soon = el('span', { style: 'display:inline-block;margin-top:5px;font-size:10px;padding:2px 7px;background:#f0f0f0;border-radius:10px;color:#888' }, 'Coming soon');
    ghost.appendChild(soon);
    wrap.appendChild(ghost);

    return wrap;
  }

  function renderViewToggle() {
    const card = el('div', { cls: 'mt-card' });
    const seg  = el('div', { cls: 'mt-seg' });
    ['words', 'images'].forEach(mode => {
      seg.appendChild(el('button', {
        cls: 'mt-seg-btn' + (clinicianViewMode === mode ? ' on' : ''),
        onclick: () => { clinicianViewMode = mode; saveSettings({ clinicianViewMode }); renderSetupScreen(); }
      }, mode.charAt(0).toUpperCase() + mode.slice(1)));
    });
    card.append(seg, el('div', { cls: 'mt-hint-text', style: 'margin-top:6px' },
      'Child works from printed sheet or paired device'));
    return card;
  }

  function renderActions() {
    const card = el('div', { cls: 'mt-card' });
    card.appendChild(el('button', { cls: 'mt-btn-primary',
      style: 'width:100%;margin-bottom:6px', onclick: startManualTest }, '▶ Start manual test'));
    card.appendChild(el('button', { cls: 'mt-btn',
      style: 'width:100%;margin-bottom:4px', onclick: printImageSheet }, '🖨 Print image sheet'));
    card.appendChild(el('button', { cls: 'mt-btn',
      style: 'width:100%;margin-bottom:4px', onclick: openImageManager }, '🖼 Manage images'));
    card.appendChild(el('button', { cls: 'mt-btn', style: 'width:100%;color:#1a5fa5;border-color:#9ab8f0',
      onclick: () => { if (window.kttPaired) window.kttPaired.openPairModal(); }
    }, '📱 Pair responder device'));
    const pairState = (() => { try { return JSON.parse(localStorage.getItem('ktt_reconnect_v1') || 'null'); } catch { return null; } })();
    if (pairState?.secret) {
      const forgetRow = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-top:2px' });
      forgetRow.appendChild(el('span', { style: 'font-size:10px;color:#888;flex:1' },
        pairState.role === 'controller' ? '💾 Saved pairing — tap above to reconnect' : '💾 Saved as responder'));
      forgetRow.appendChild(el('button', {
        cls: 'mt-btn', style: 'font-size:10px;padding:2px 7px;color:#c0392b;border-color:#e0b0b0',
        title: 'Forget saved pairing',
        onclick: () => { localStorage.removeItem('ktt_reconnect_v1'); renderSetupScreen(); }
      }, 'Forget'));
      card.appendChild(forgetRow);
    }
    return card;
  }

  function renderImportExport() {
    const card = el('div', { cls: 'mt-card', style: 'display:flex;gap:6px' });
    card.appendChild(el('button', { cls: 'mt-btn', style: 'flex:1', onclick: importLists }, '↑ Import'));
    card.appendChild(el('button', { cls: 'mt-btn', style: 'flex:1', onclick: exportLists }, '↓ Export'));
    return card;
  }

  function renderClinicSettings() {
    const C = loadClinicSettings();
    const card = el('div', { cls: 'mt-card' });

    // Clinic name
    const nameRow = el('div', { cls: 'mt-form-row', style: 'margin-bottom:8px' });
    const nameWrap = el('div', { style: 'flex:1' });
    nameWrap.appendChild(el('div', { cls: 'mt-field-label' }, 'Clinic / organisation name'));
    nameWrap.appendChild(el('input', { cls: 'mt-inp', placeholder: 'e.g. Waikato DHB Audiology',
      value: C.clinicName || '',
      oninput: e => saveClinicSettings({ clinicName: e.target.value })
    }));
    nameRow.appendChild(nameWrap);
    card.appendChild(nameRow);

    // Logo upload
    const logoLabel = el('div', { cls: 'mt-field-label', style: 'margin-bottom:4px' }, 'Report logo');
    card.appendChild(logoLabel);

    const logoRow = el('div', { style: 'display:flex;gap:8px;align-items:center' });

    // Preview
    const preview = el('div', { style: 'width:64px;height:40px;border:1px solid #ddd;border-radius:5px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#fafafa;flex-shrink:0' });
    if (C.logoDataURL) {
      const img = el('img', { src: C.logoDataURL, style: 'max-width:100%;max-height:100%;object-fit:contain' });
      preview.appendChild(img);
    } else {
      preview.appendChild(el('span', { style: 'font-size:10px;color:#bbb;text-align:center;line-height:1.3' }, 'No\nlogo'));
    }
    logoRow.appendChild(preview);

    const btnCol = el('div', { style: 'display:flex;flex-direction:column;gap:4px;flex:1' });
    const uploadBtn = el('button', { cls: 'mt-btn', style: 'font-size:11px;width:100%',
      onclick: () => logoFileInput.click() }, C.logoDataURL ? 'Replace logo…' : 'Upload logo…');
    btnCol.appendChild(uploadBtn);

    if (C.logoDataURL) {
      btnCol.appendChild(el('button', { cls: 'mt-btn', style: 'font-size:11px;width:100%;color:#c0392b;border-color:#e0b0b0',
        onclick: () => { saveClinicSettings({ logoDataURL: '' }); renderSetupScreen(); }
      }, 'Remove logo'));
    }

    btnCol.appendChild(el('div', { cls: 'mt-hint-text' }, 'PNG or SVG recommended.\nShown on printed reports.'));
    logoRow.appendChild(btnCol);
    card.appendChild(logoRow);

    // Hidden file input
    const logoFileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    logoFileInput.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        // Auto-compress if large
        const dataURL = ev.target.result;
        const sizeKB = Math.round(dataURL.length * 0.75 / 1024);
        if (sizeKB > 200) {
          const img = new Image();
          img.onload = () => {
            const scale = Math.min(1, 300 / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            saveClinicSettings({ logoDataURL: canvas.toDataURL('image/png') });
            renderSetupScreen();
          };
          img.src = dataURL;
        } else {
          saveClinicSettings({ logoDataURL: dataURL });
          renderSetupScreen();
        }
      };
      reader.readAsDataURL(file);
    };
    card.appendChild(logoFileInput);

    return card;
  }

  // ─── TEST SCREEN ──────────────────────────────────────────────────────────

  function startManualTest() {
    scores     = {};
    levelsUsed = [];
    armedKupu  = null;
    currentLevel = DEFAULT_LEVEL;
    const S = loadSettings();
    if (S.lastLevel) currentLevel = parseInt(S.lastLevel) || DEFAULT_LEVEL;
    if (S.showLabels !== undefined) showLabels = !!S.showLabels;

    // Push current list + images to responder now that test is starting
    if (window.kttPaired?.isConnected()) {
      window.kttPaired.sendSync();
    }

    renderTestScreen();
    showView('manualTestView');
  }

  function renderTestScreen() {
    const root = document.getElementById('manualTestView');
    if (!root) return;
    const list = getActiveList();
    if (!list) { alert('No list selected'); return; }

    root.innerHTML = '';

    // Header right: save + back
    const hdrRight = el('div', { style: 'display:flex;gap:6px;align-items:center' });
    // Pair status badge
    const statusBadge = el('span', { id: 'ktt-pair-status' }, '📱 Not paired');
    hdrRight.appendChild(statusBadge);
    // Initialise badge state if already paired
    if (window.kttPaired?.isConnected()) {
      statusBadge.textContent = '🔒 Paired';
      statusBadge.style.cssText = 'display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7';
    }
    hdrRight.appendChild(el('button', { cls: 'mt-btn',
      onclick: () => { stopAudio(); renderSetupScreen(); showView('manualSetupView'); }
    }, '← Setup'));
    hdrRight.appendChild(el('button', { cls: 'mt-btn-primary',
      onclick: saveResults }, '↓ Save results'));
    root.appendChild(makeHeader(null, hdrRight));

    // Client + list info bar
    const infoBar = el('div', { cls: 'mt-info-bar' });
    const clientStr = [sessionMeta.clientName, sessionMeta.nhi].filter(Boolean).join(' · ') || 'No client';
    infoBar.appendChild(el('div', { cls: 'mt-info-client' }, clientStr));
    infoBar.appendChild(el('div', { cls: 'mt-info-list' }, list.name));
    infoBar.appendChild(el('div', { cls: 'mt-info-mode' }, SCORING_MODES[scoringMode].label));

    // Label toggle
    const labelToggle = el('label', { cls: 'mt-label-toggle', title: 'Show kupu text labels' });
    const labelCb = el('input', { type: 'checkbox' });
    labelCb.checked = showLabels;
    labelCb.onchange = () => { showLabels = labelCb.checked; saveSettings({ showLabels }); refreshScoringTable(); };
    labelToggle.append(labelCb, ' labels');
    infoBar.appendChild(labelToggle);

    infoBar.appendChild(el('button', { cls: 'mt-btn', style: 'font-size:11px;padding:3px 8px',
      onclick: () => printImageSheet() }, '🖨'));

    // Audio source toggle (only visible when paired)
    if (window.kttPaired?.isConnected()) {
      const audioSeg = el('div', { cls: 'mt-audio-src-seg', style: 'width:auto;margin-left:4px' });
      ['This device', "Child's device"].forEach((lbl, i) => {
        const src = i === 0 ? 'controller' : 'responder';
        const btn = el('button', { cls: 'mt-audio-src-btn' + (i === 0 ? ' on' : ''),
          onclick: (e) => {
            audioSeg.querySelectorAll('.mt-audio-src-btn').forEach(b => b.classList.remove('on'));
            e.target.classList.add('on');
            window.kttPaired.setAudioSource(src);
          }
        }, '🔊 ' + lbl);
        audioSeg.appendChild(btn);
      });
      infoBar.appendChild(audioSeg);
    }

    // Peer-response confirm bar (hidden until response arrives)
    const confirmBar = el('div', {
      id: 'mt-confirm-bar',
      style: 'display:none;padding:6px 14px;background:#fff3cd;border-bottom:1px solid #ffc107;display:none;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px'
    });
    confirmBar.appendChild(el('span', { id: 'mt-confirm-label' }, 'Child tapped:'));
    confirmBar.appendChild(el('strong', { id: 'mt-confirm-kupu', style: 'font-size:15px' }, '—'));
    confirmBar.appendChild(el('button', {
      cls: 'mt-btn', style: 'background:#e8f5e9;border-color:#4caf50;color:#2e7d32;font-weight:700',
      onclick: () => { confirmPeerResponse(true); }
    }, '✓ Correct'));
    confirmBar.appendChild(el('button', {
      cls: 'mt-btn', style: 'background:#ffebee;border-color:#e57373;color:#c62828;font-weight:700',
      onclick: () => { confirmPeerResponse(false); }
    }, '✗ Incorrect'));
    root.appendChild(infoBar);
    root.appendChild(confirmBar);

    // Main area: scoring table + sidebar
    const body = el('div', { cls: 'mt-test-body' });
    root.appendChild(body);

    const main = el('div', { cls: 'mt-test-main' });
    body.appendChild(main);

    // Level controls
    main.appendChild(renderLevelBar());

    // Scrollable table area
    const tableWrap = el('div', { cls: 'mt-table-wrap', id: 'mt-table-wrap' });
    main.appendChild(tableWrap);
    renderScoringTable(tableWrap, list);

    // Sidebar
    body.appendChild(renderTestSidebar());
  }

  function renderLevelBar() {
    const bar = el('div', { cls: 'mt-level-bar' });

    const minusBtn = el('button', { cls: 'mt-level-btn', onclick: () => adjustLevel(-LEVEL_STEP) }, '−5');
    const levelDisp = el('div', { cls: 'mt-level-disp', id: 'mt-level-disp' }, `${currentLevel} dBA`);
    const plusBtn  = el('button', { cls: 'mt-level-btn', onclick: () => adjustLevel(+LEVEL_STEP) }, '+5');

    const manualWrap = el('div', { cls: 'mt-manual-wrap' });
    const manualInp  = el('input', { cls: 'mt-manual-level', id: 'mt-manual-level',
      type: 'number', value: String(currentLevel), min: String(LEVEL_MIN), max: String(LEVEL_MAX), step: '1',
      oninput: e => { const n = parseInt(e.target.value); if (!isNaN(n) && n >= LEVEL_MIN && n <= LEVEL_MAX) setLevel(n); }
    });
    manualWrap.append(manualInp, el('span', { cls: 'mt-hint-text' }, ' dBA'));

    const spacer = el('div', { style: 'flex:1' });

    const armedLbl = el('div', { cls: 'mt-armed-label', id: 'mt-armed-label' },
      armedKupu ? `"Kei hea te ${armedKupu}?"` : '— select a kupu —');

    const playBtn = el('button', { cls: 'mt-btn-primary mt-play-btn', id: 'mt-play-btn',
      onclick: () => { if (armedKupu) playKupu(armedKupu); }
    }, '▶ Play');
    if (!armedKupu) playBtn.disabled = true;

    bar.append(minusBtn, levelDisp, plusBtn, manualWrap, spacer, armedLbl, playBtn);
    return bar;
  }

  // Full re-render of the scoring table
  function renderScoringTable(container, list) {
    container.innerHTML = '';
    list = list || getActiveList();
    if (!list) return;

    const table = el('table', { cls: 'mt-ktable', id: 'mt-ktable' });

    // Header — kupu column always, then one column per level used
    const thead = el('thead');
    const hrow  = el('tr');
    hrow.appendChild(el('th', { cls: 'mt-th-kupu' }, showLabels ? 'Kupu' : ''));
    if (levelsUsed.length === 0) {
      hrow.appendChild(el('th', { cls: 'mt-th-level', style: 'color:#bbb;font-style:italic;font-weight:normal' },
        'press Play to score'));
    } else {
      levelsUsed.forEach(lv => {
        hrow.appendChild(el('th', { cls: 'mt-th-level' + (lv === currentLevel ? ' current-level' : '') }, `${lv} dBA`));
      });
    }
    thead.appendChild(hrow);
    table.appendChild(thead);

    // Body — always render all kupu rows
    const tbody = el('tbody', { id: 'mt-tbody' });
    list.kupu.forEach(kupu => tbody.appendChild(buildKupuRow(kupu)));
    table.appendChild(tbody);
    container.appendChild(table);
  }

  function buildKupuRow(kupu) {
    const isArmed = kupu === armedKupu;
    // Clicking anywhere on the row arms the kupu; pip clicks stop propagation
    const tr = el('tr', {
      cls: (isArmed ? 'mt-row-armed' : '') + ' mt-row-clickable',
      'data-kupu': kupu,
      onclick: () => armKupu(kupu)
    });

    // Kupu cell
    const nameTd = el('td', { cls: 'mt-kupu-td' });
    if (clinicianViewMode === 'images') {
      const imgEl = el('img', { cls: 'mt-kupu-img', alt: kupu });
      if (window.loadKupuImage) window.loadKupuImage(imgEl, kupu);
      else imgEl.src = `Images/${encodeURIComponent(kupu)}.png`;
      if (showLabels) {
        const lbl = el('div', { cls: 'mt-kupu-img-label' }, kupu);
        const wrap = el('div', { cls: 'mt-kupu-img-wrap' + (isArmed ? ' armed' : '') });
        wrap.append(imgEl, lbl);
        nameTd.appendChild(wrap);
      } else {
        if (isArmed) imgEl.className += ' armed-img';
        nameTd.appendChild(imgEl);
      }
    } else {
      nameTd.appendChild(el('span', { cls: 'mt-kupu-name' + (isArmed ? ' armed' : '') }, kupu));
    }
    tr.appendChild(nameTd);

    // Level cells — pip clicks stop propagation so they don't also fire armKupu
    levelsUsed.forEach(lv => {
      const td = el('td', { cls: 'mt-score-td' + (lv === currentLevel ? ' current-level' : '') });
      const pips = getPips(kupu, lv);
      const pipWrap = el('div', { cls: 'mt-pip-wrap' });
      pips.forEach((state, idx) => {
        const pip = el('div', { cls: `mt-pip ${state}`, title: `${kupu} @ ${lv} dBA`,
          onclick: e => { e.stopPropagation(); cyclePip(kupu, lv, idx); refreshScoringTable(); }
        });
        pipWrap.appendChild(pip);
      });
      td.appendChild(pipWrap);
      tr.appendChild(td);
    });

    return tr;
  }

  // Incremental refresh — rebuild tbody and update sidebar score
  function refreshScoringTable() {
    const list = getActiveList();
    if (!list) return;

    const wrap = document.getElementById('mt-table-wrap');
    if (wrap) renderScoringTable(wrap, list);

    // Update level header highlights
    document.querySelectorAll('.mt-th-level').forEach(th => {
      const lv = parseInt(th.textContent);
      th.classList.toggle('current-level', lv === currentLevel);
    });

    // Update sidebar
    updateSidebarScore();
  }

  function renderTestSidebar() {
    const sb = el('div', { cls: 'mt-test-sidebar' });

    // Level display
    const lvCard = el('div', { cls: 'mt-card', style: 'display:flex;align-items:baseline;gap:5px' });
    lvCard.appendChild(el('div', { cls: 'mt-level-big', id: 'mt-level-big' }, String(currentLevel)));
    lvCard.appendChild(el('span', { cls: 'mt-level-unit' }, ' dBA'));
    sb.appendChild(sect('Current level', lvCard));

    // Score summary
    const scoreCard = el('div', { cls: 'mt-score-grid', id: 'mt-score-grid' });
    sb.appendChild(sect('Score at this level', scoreCard));
    updateSidebarScore();   // populate it

    // Carrier phrase
    const cpCard = el('div', { cls: 'mt-card mt-carrier', id: 'mt-carrier-display' },
      armedKupu ? `"Kei hea te ${armedKupu}?"` : '"Kei hea te ___?"');
    sb.appendChild(sect('Carrier phrase', cpCard));

    // Phrases
    const phCard = el('div', { cls: 'mt-card mt-phrases' });
    USEFUL_PHRASES.slice(0, 5).forEach(p => {
      const row = el('div', { cls: 'mt-phrase-row' });
      row.appendChild(el('span', { cls: 'mt-phrase-mi' }, p.mi));
      row.appendChild(el('span', { cls: 'mt-phrase-en' }, p.en));
      phCard.appendChild(row);
    });
    sb.appendChild(sect('Phrases', phCard));

    // Notes
    const notesArea = el('textarea', { cls: 'mt-notes', placeholder: 'Clinical notes…',
      oninput: e => { sessionNotes = e.target.value; }
    }, sessionNotes);
    sb.appendChild(sect('Notes', notesArea));

    // Legend
    const leg = el('div', { cls: 'mt-legend' });
    [['correct','correct'],['incorrect','incorrect'],['empty','untested']].forEach(([cls, lbl]) => {
      const item = el('div', { cls: 'mt-leg-item' });
      item.appendChild(el('div', { cls: `mt-leg-pip ${cls}` }));
      item.appendChild(document.createTextNode(lbl));
      leg.appendChild(item);
    });
    leg.appendChild(el('span', { cls: 'mt-hint-text', style: 'margin-left:6px' },
      'Play adds a slot · click pip to score'));
    sb.appendChild(leg);

    return sb;
  }

  function updateSidebarScore() {
    const grid = document.getElementById('mt-score-grid');
    if (!grid) return;
    const { nc, ni, total } = levelTally(currentLevel);
    grid.innerHTML = `
      <div class="mt-score-tile"><div class="mt-score-v green-v" id="mt-nc">${nc}</div><div class="mt-score-l">correct</div></div>
      <div class="mt-score-tile"><div class="mt-score-v red-v" id="mt-ni">${ni}</div><div class="mt-score-l">incorrect</div></div>
      <div class="mt-score-tile" style="grid-column:span 2">
        <div class="mt-score-v">${total > 0 ? Math.round(nc/total*100)+'%' : '—'}</div>
        <div class="mt-score-l">% correct at ${currentLevel} dBA</div>
      </div>`;
  }

  // ─── Level control ────────────────────────────────────────────────────────

  function adjustLevel(delta) {
    setLevel(Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, currentLevel + delta)));
  }

  function setLevel(n) {
    currentLevel = n;
    saveSettings({ lastLevel: n });
    const disp   = document.getElementById('mt-level-disp');
    const big    = document.getElementById('mt-level-big');
    const manual = document.getElementById('mt-manual-level');
    if (disp)   disp.textContent   = `${n} dBA`;
    if (big)    big.textContent    = String(n);
    if (manual) manual.value       = String(n);
    refreshScoringTable();
  }

  // ─── Peer response handling ───────────────────────────────────────────────

  // Called by pairedMode.js when responder taps a kupu
  function onPairResponse(kupu) {
    const bar   = document.getElementById('mt-confirm-bar');
    const label = document.getElementById('mt-confirm-kupu');
    if (bar)   { bar.style.display = 'flex'; }
    if (label) { label.textContent = kupu; }
  }

  function confirmPeerResponse(correct) {
    if (window.kttPaired) window.kttPaired.sendConfirm(correct);
    const bar = document.getElementById('mt-confirm-bar');
    if (bar) bar.style.display = 'none';
    // Auto-score: add a pip for the armed kupu at current level
    if (armedKupu) {
      ensurePipSlot(armedKupu, currentLevel);
      const pips = getPips(armedKupu, currentLevel);
      const emptyIdx = pips.indexOf('empty');
      if (emptyIdx >= 0) {
        pips[emptyIdx] = correct ? 'correct' : 'incorrect';
        refreshScoringTable();
      }
    }
  }

  // Exposed for pairedMode.js to call sendSync
  function getActiveListForPair() {
    return getActiveList();
  }

  // ─── Arm kupu ─────────────────────────────────────────────────────────────

  function armKupu(kupu) {
    armedKupu = armedKupu === kupu ? null : kupu;
    const armedLbl = document.getElementById('mt-armed-label');
    const carrier  = document.getElementById('mt-carrier-display');
    const playBtn  = document.getElementById('mt-play-btn');
    if (armedLbl) armedLbl.textContent = armedKupu ? `"Kei hea te ${armedKupu}?"` : '— select a kupu —';
    if (carrier)  carrier.textContent  = armedKupu ? `"Kei hea te ${armedKupu}?"` : '"Kei hea te ___?"';
    if (playBtn)  playBtn.disabled     = !armedKupu;
    refreshScoringTable();
  }

  // ─── Image manager ────────────────────────────────────────────────────────

  function openImageManager() {
    const list = getActiveList();
    if (!list) { alert('No list selected'); return; }

    const existing = document.getElementById('mt-img-manager');
    if (existing) { existing.remove(); return; }

    // Build the full word pool — all unique kupu across all lists so you can
    // manage images even for kupu not in the current list
    const allKupu = [...new Set(allLists.flatMap(l => l.kupu))].sort();
    const overrides = window.kttImageStore ? window.kttImageStore.all() : {};

    // Inject styles once
    if (!document.getElementById('mt-imgmgr-styles')) {
      const s = document.createElement('style');
      s.id = 'mt-imgmgr-styles';
      s.textContent = `
        .imgmgr-overlay { position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box; }
        .imgmgr-modal { background:#fff;border-radius:10px;width:100%;max-width:780px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.2); }
        .imgmgr-header { display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #e8e8e8;background:#f7f7f7;flex-shrink:0; }
        .imgmgr-title { font-size:14px;font-weight:700; }
        .imgmgr-sub { font-size:11px;color:#888;margin-top:1px; }
        .imgmgr-close { font-size:18px;border:none;background:none;cursor:pointer;color:#888;padding:2px 8px;border-radius:4px; }
        .imgmgr-close:hover { background:#eee;color:#333; }
        .imgmgr-filter { padding:8px 16px;border-bottom:1px solid #f0f0f0;display:flex;gap:8px;align-items:center;flex-shrink:0; }
        .imgmgr-filter input { flex:1;font-size:13px;padding:5px 9px;border:1px solid #ccc;border-radius:6px; }
        .imgmgr-filter label { font-size:12px;color:#666;display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap; }
        .imgmgr-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;padding:14px 16px;overflow-y:auto;flex:1; }
        .imgmgr-cell { display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px;border:1px solid #e8e8e8;border-radius:8px;background:#fafafa; }
        .imgmgr-cell.has-override { border-color:#3a7de0;background:#f0f5ff; }
        .imgmgr-cell img { width:80px;height:80px;object-fit:contain;border-radius:4px; }
        .imgmgr-name { font-size:11px;font-weight:700;color:#333;text-align:center; }
        .imgmgr-badge { font-size:9px;color:#1a5fa5;background:#e8f0fc;border-radius:10px;padding:1px 6px; }
        .imgmgr-btn { font-size:11px;padding:3px 9px;border:1px solid #ccc;border-radius:5px;background:#fff;cursor:pointer;width:100%; }
        .imgmgr-btn:hover { background:#f0f0f0; }
        .imgmgr-btn.restore { border-color:#e0b0b0;color:#c0392b; }
        .imgmgr-btn.restore:hover { background:#fde8e8; }
      `;
      document.head.appendChild(s);
    }

    const overlay = document.createElement('div');
    overlay.id = 'mt-img-manager';
    overlay.className = 'imgmgr-overlay';
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

    const modal = document.createElement('div');
    modal.className = 'imgmgr-modal';
    overlay.appendChild(modal);

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'imgmgr-header';
    hdr.innerHTML = `
      <div>
        <div class="imgmgr-title">Manage images</div>
        <div class="imgmgr-sub">Click "Replace" to upload a custom image for any kupu. Stored on this device.</div>
      </div>
      <button class="imgmgr-close" id="imgmgr-close">✕</button>`;
    modal.appendChild(hdr);
    hdr.querySelector('#imgmgr-close').onclick = () => overlay.remove();

    // Filter bar
    const filterBar = document.createElement('div');
    filterBar.className = 'imgmgr-filter';
    filterBar.innerHTML = `
      <input id="imgmgr-search" type="search" placeholder="Search kupu…">
      <label><input type="checkbox" id="imgmgr-overrides-only"> Custom only</label>`;
    modal.appendChild(filterBar);

    // Grid
    const grid = document.createElement('div');
    grid.className = 'imgmgr-grid';
    modal.appendChild(grid);

    function buildGrid(filter, overridesOnly) {
      grid.innerHTML = '';
      const overrides = window.kttImageStore ? window.kttImageStore.all() : {};
      const kupuToShow = allKupu.filter(k => {
        if (overridesOnly && !overrides[k]) return false;
        if (filter && !k.toLowerCase().includes(filter.toLowerCase())) return false;
        return true;
      });

      if (!kupuToShow.length) {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#aaa;padding:24px;font-size:13px">No kupu match</div>';
        return;
      }

      kupuToShow.forEach(kupu => {
        const hasOverride = !!overrides[kupu];
        const cell = document.createElement('div');
        cell.className = 'imgmgr-cell' + (hasOverride ? ' has-override' : '');

        const img = document.createElement('img');
        img.alt = kupu;
        if (window.loadKupuImage) window.loadKupuImage(img, kupu);
        else img.src = `Images/${encodeURIComponent(kupu)}.png`;

        const name = document.createElement('div');
        name.className = 'imgmgr-name';
        name.textContent = kupu;

        const replBtn = document.createElement('button');
        replBtn.className = 'imgmgr-btn';
        replBtn.textContent = 'Replace…';
        replBtn.onclick = () => {
          if (window.kttImageStore) {
            window.kttImageStore.openReplacer(kupu, () => buildGrid(
              document.getElementById('imgmgr-search').value,
              document.getElementById('imgmgr-overrides-only').checked
            ));
          }
        };

        cell.append(img, name);
        if (hasOverride) {
          const badge = document.createElement('div');
          badge.className = 'imgmgr-badge';
          badge.textContent = 'custom';
          cell.appendChild(badge);
          const restBtn = document.createElement('button');
          restBtn.className = 'imgmgr-btn restore';
          restBtn.textContent = 'Restore default';
          restBtn.onclick = () => {
            window.kttImageStore.remove(kupu);
            buildGrid(
              document.getElementById('imgmgr-search').value,
              document.getElementById('imgmgr-overrides-only').checked
            );
          };
          cell.append(replBtn, restBtn);
        } else {
          cell.appendChild(replBtn);
        }

        grid.appendChild(cell);
      });
    }

    document.body.appendChild(overlay);
    buildGrid('', false);

    // Wire filter/search
    filterBar.querySelector('#imgmgr-search').oninput = e =>
      buildGrid(e.target.value, filterBar.querySelector('#imgmgr-overrides-only').checked);
    filterBar.querySelector('#imgmgr-overrides-only').onchange = e =>
      buildGrid(filterBar.querySelector('#imgmgr-search').value, e.target.checked);
  }

  // ─── Print image sheet ────────────────────────────────────────────────────

  function printImageSheet() {
    const list = getActiveList();
    if (!list) { alert('No list selected'); return; }

    // Show a small options dialog inline
    const existing = document.getElementById('mt-print-opts');
    if (existing) { existing.remove(); return; }

    const dlg = document.createElement('div');
    dlg.id = 'mt-print-opts';
    dlg.style.cssText = `
      position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
      background:#fff; border:1px solid #ccc; border-radius:10px;
      padding:20px; z-index:8000; box-shadow:0 4px 24px rgba(0,0,0,.18);
      width:280px; font-family:system-ui,sans-serif; font-size:13px;
    `;

    dlg.innerHTML = `
      <div style="font-weight:700;font-size:14px;margin-bottom:12px">Print options</div>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input type="checkbox" id="po-header" checked> Include UC header
      </label>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input type="checkbox" id="po-labels" checked> Show kupu labels
      </label>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        <input type="checkbox" id="po-listname" checked> Show list name
      </label>
      <div style="display:flex;gap:8px">
        <button id="po-cancel" style="flex:1;padding:7px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Cancel</button>
        <button id="po-print" style="flex:2;padding:7px;border:none;border-radius:6px;background:#1a5fa5;color:#fff;font-weight:700;cursor:pointer">Print</button>
      </div>
    `;

    document.body.appendChild(dlg);

    document.getElementById('po-cancel').onclick = () => dlg.remove();
    document.getElementById('po-print').onclick = () => {
      const showHeader   = document.getElementById('po-header').checked;
      const showLabels_p = document.getElementById('po-labels').checked;
      const showListName = document.getElementById('po-listname').checked;
      dlg.remove();
      doPrint(list, showHeader, showLabels_p, showListName);
    };

    // Close on backdrop click
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:7999';
    backdrop.onclick = () => { dlg.remove(); backdrop.remove(); };
    document.body.insertBefore(backdrop, dlg);
  }

  function doPrint(list, showHeader, showLabels_p, showListName) {
    const n = list.kupu.length;
    const cols = n <= 9 ? 3 : n <= 12 ? 4 : 5;
    const overrides = window.kttImageStore ? window.kttImageStore.all() : {};

    const cells = list.kupu.map(kupu => {
      const lbl = showLabels_p ? `<div class="lbl">${kupu}</div>` : '';
      // Use custom override if present (base64 data URL), otherwise fall back with onerror chain
      const override = overrides[kupu];
      const imgTag = override
        ? `<img src="${override}" alt="${kupu}">`
        : `<img src="Images/${encodeURIComponent(kupu)}.png"
            onerror="var e=['jpg','jpeg','webp'],t=+(this.dataset.t||0);t<e.length?(this.dataset.t=t+1,this.src='Images/${encodeURIComponent(kupu)}.'+e[t]):this.style.visibility='hidden'"
            alt="${kupu}">`;
      return `<div class="cell">${imgTag}${lbl}</div>`;
    }).join('');

    const headerHTML = showHeader ? `
      <header>
        <img src="UClogo.png" alt="UC">
        <div>
          <div style="font-size:12px;font-weight:700">Te reo Māori Kendall Toy Test</div>
          ${showListName ? `<div style="font-size:10px;color:#bbb">${list.name}</div>` : ''}
        </div>
      </header>` : (showListName ? `<div style="font-size:9px;color:#bbb;margin-bottom:4px">${list.name}</div>` : '');

    const win = window.open('', '_blank');
    if (!win) { alert('Please allow popups to print'); return; }
    win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>KTT — ${list.name}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @page { size: A4 landscape; margin: 0.7cm; }
        body { font-family: system-ui, sans-serif; }
        header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        header img { height: 28px; }
        .grid {
          display: grid;
          grid-template-columns: repeat(${cols}, 1fr);
          gap: 5px;
          height: calc(100vh - ${showHeader || showListName ? '48px' : '0px'});
        }
        .cell {
          border: 1px solid #ddd; border-radius: 5px; padding: 4px;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          overflow: hidden;
        }
        .cell img { width: 100%; flex: 1; object-fit: contain; min-height: 0; }
        .lbl { font-size: 9px; color: #bbb; margin-top: 2px; flex-shrink: 0; }
      </style></head><body>
      ${headerHTML}
      <div class="grid">${cells}</div>
      </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 600);
  }

  // ─── Save results ─────────────────────────────────────────────────────────

  function buildResultsJSON() {
    const list = getActiveList();
    const now  = new Date();
    const scoringGrid = {};
    if (list) {
      list.kupu.forEach(kupu => {
        const byLevel = {};
        levelsUsed.forEach(lv => {
          const pips = getPips(kupu, lv);
          const nc = pips.filter(p => p === 'correct').length;
          const ni = pips.filter(p => p === 'incorrect').length;
          if (nc + ni > 0) byLevel[lv] = { correct: nc, incorrect: ni, total: nc+ni, pips: pips.slice() };
        });
        if (Object.keys(byLevel).length) scoringGrid[kupu] = byLevel;
      });
    }
    return {
      schema_version: 1,
      exported_at: now.toISOString(),
      client: { ...sessionMeta },
      clinic: loadClinicSettings(),
      test: {
        list_name: list?.name || 'unknown',
        list_id:   list?.id   || 'unknown',
        kupu:      list?.kupu || [],
        scoring_mode: scoringMode,
        levels_used:  levelsUsed.slice(),
      },
      notes: sessionNotes,
      scores: scoringGrid,
    };
  }

  function buildTextSummary(data) {
    const lines = [
      '# UC Te reo Māori Kendall Toy Test — Results',
      `# Exported: ${new Date(data.exported_at).toLocaleString('en-NZ')}`,
      '',
      `Client:     ${data.client.clientName || '—'}`,
      `NHI:        ${data.client.nhi        || '—'}`,
      `DOB:        ${data.client.dob        || '—'}`,
      `Test date:  ${data.client.testDate   || '—'}`,
      `Clinician:  ${data.client.clinician  || '—'}`,
      '',
      `List:           ${data.test.list_name}`,
      `Scoring mode:   ${SCORING_MODES[data.test.scoring_mode]?.label || data.test.scoring_mode}`,
      `Levels used:    ${data.test.levels_used.join(', ')} dBA`,
      '',
      '─── Scores ───', '',
    ];

    const lvls = data.test.levels_used;
    if (!lvls.length) {
      lines.push('(No responses recorded)');
    } else {
      const pad = (s, n) => String(s).padEnd(n);
      lines.push(pad('Kupu', 14) + lvls.map(lv => pad(`${lv}dBA`, 11)).join(''));
      lines.push('─'.repeat(14 + lvls.length * 11));
      data.test.kupu.forEach(kupu => {
        const row = data.scores[kupu] || {};
        const cells = lvls.map(lv => {
          const c = row[lv];
          if (!c) return pad('—', 11);
          const pct = Math.round(c.correct / c.total * 100);
          return pad(`${c.correct}/${c.total} (${pct}%)`, 11);
        });
        lines.push(pad(kupu, 14) + cells.join(''));
      });
    }

    if (data.notes) lines.push('', '─── Notes ───', '', data.notes);
    return lines.join('\n');
  }

  function saveResults() {
    const data = buildResultsJSON();
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = (sessionMeta.clientName || 'client').replace(/\s+/g, '_');

    // Always download the verbose JSON for record-keeping
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `KTT_${slug}_${ts}.json`;
    a.click();
    URL.revokeObjectURL(a.href);

    // Open the print/PDF report in a new window
    openPrintReport(data);
  }

  function openPrintReport(data) {
    const lvls = data.test.levels_used;
    const kupu = data.test.kupu;

    // ── Score table rows ──────────────────────────────────────────────────
    function pipDots(pips) {
      return (pips || []).map(p => {
        const col = p === 'correct' ? '#2d8a1a' : p === 'incorrect' ? '#c0392b' : '#ddd';
        return `<span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:${col};margin:0 1px;vertical-align:middle"></span>`;
      }).join('');
    }

    function levelSummaryRow(lv) {
      let nc = 0, ni = 0;
      kupu.forEach(k => {
        const s = data.scores[k]?.[lv];
        if (s) { nc += s.correct; ni += s.incorrect; }
      });
      const tot = nc + ni;
      return tot ? `${nc}/${tot} (${Math.round(nc/tot*100)}%)` : '—';
    }

    const headerCols = lvls.map(lv =>
      `<th style="${lv === lvls[lvls.length-1] ? 'background:#eef4ff;' : ''}">${lv} dBA</th>`
    ).join('');

    const bodyRows = kupu.map(k => {
      const cells = lvls.map(lv => {
        const s = data.scores[k]?.[lv];
        const dots = s ? pipDots(s.pips) : '<span style="color:#ccc">—</span>';
        const pct  = s && s.total ? `<br><span style="font-size:9px;color:#888">${Math.round(s.correct/s.total*100)}%</span>` : '';
        return `<td>${dots}${pct}</td>`;
      }).join('');
      return `<tr><td class="kupu-col">${k}</td>${cells}</tr>`;
    }).join('');

    const summaryRow = lvls.length ? `
      <tr style="border-top:2px solid #333;font-weight:700;background:#f7f7f7">
        <td class="kupu-col" style="font-size:10px;color:#666">% correct</td>
        ${lvls.map(lv => `<td style="font-size:11px">${levelSummaryRow(lv)}</td>`).join('')}
      </tr>` : '';

    // ── Scoring mode note ─────────────────────────────────────────────────
    const modeNote = SCORING_MODES[data.test.scoring_mode]?.label || data.test.scoring_mode;

    // ── Header: custom logo takes priority over UC logo ───────────────────
    const clinic = data.clinic || {};
    const logoSrc     = clinic.logoDataURL || 'UClogo.png';
    const orgName     = clinic.clinicName  || 'University of Canterbury';
    const headerColor = clinic.logoDataURL ? '#333' : '#1a5fa5';

    // ── Build the HTML ────────────────────────────────────────────────────
    const html = `<!DOCTYPE html>
<html lang="mi"><head><meta charset="UTF-8">
<title>KTT Results — ${data.client.clientName || 'Client'}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 1.5cm 1.8cm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; background: #fff; }

  .page-header { display: flex; align-items: flex-start; justify-content: space-between; padding-bottom: 10px; border-bottom: 2px solid ${headerColor}; margin-bottom: 14px; }
  .header-left { display: flex; align-items: center; gap: 10px; }
  .header-logo { height: 40px; max-width: 180px; object-fit: contain; }
  .header-title { font-size: 15px; font-weight: 700; color: ${headerColor}; line-height: 1.2; }
  .header-sub   { font-size: 10px; color: #888; margin-top: 2px; }
  .header-right { text-align: right; font-size: 10px; color: #666; line-height: 1.7; }

  .client-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin-bottom: 14px; padding: 10px 12px; background: #f7f9ff; border: 1px solid #d0daf5; border-radius: 6px; }
  .client-field { display: flex; gap: 6px; }
  .client-label { font-size: 9px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: .05em; min-width: 72px; padding-top: 1px; }
  .client-value { font-size: 11px; color: #111; }

  .section-title { font-size: 10px; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { font-size: 10px; font-weight: 700; color: #555; padding: 5px 8px; text-align: center; background: #f5f5f5; border: 1px solid #ddd; }
  td { padding: 5px 8px; border: 1px solid #e8e8e8; text-align: center; vertical-align: middle; line-height: 1.3; }
  .kupu-col { text-align: left; font-weight: 700; font-size: 12px; color: #111; min-width: 80px; }
  th.kupu-col { text-align: left; }
  tr:nth-child(even) td { background: #fafafa; }
  tr:nth-child(even) .kupu-col { background: #fafafa; }

  .key { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; font-size: 10px; color: #666; }
  .key-dot { display: inline-block; width: 11px; height: 11px; border-radius: 3px; vertical-align: middle; margin-right: 3px; }

  .notes-box { border: 1px solid #ddd; border-radius: 5px; padding: 10px 12px; min-height: 60px; font-size: 11px; color: #333; line-height: 1.6; white-space: pre-wrap; }
  .notes-empty { color: #bbb; font-style: italic; }

  .page-footer { margin-top: 20px; padding-top: 8px; border-top: 1px solid #ddd; display: flex; justify-content: space-between; font-size: 9px; color: #aaa; }

  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head><body>

<div class="page-header">
  <div class="header-left">
    <img class="header-logo" src="${logoSrc}" alt="${orgName}">
    <div>
      <div class="header-title">Te reo Māori Kendall Toy Test</div>
      <div class="header-sub">${orgName} — Clinical Results</div>
    </div>
  </div>
  <div class="header-right">
    <div><strong>Date:</strong> ${data.client.testDate || new Date(data.exported_at).toLocaleDateString('en-NZ')}</div>
    <div><strong>Clinician:</strong> ${[data.client.clinicianName, data.client.clinicianRole].filter(Boolean).join(', ') || '—'}</div>
    ${data.client.location ? `<div><strong>Location:</strong> ${data.client.location}</div>` : ''}
    <div><strong>Exported:</strong> ${new Date(data.exported_at).toLocaleString('en-NZ')}</div>
  </div>
</div>

<div class="client-grid">
  <div class="client-field"><span class="client-label">Client</span><span class="client-value">${data.client.clientName || '—'}</span></div>
  <div class="client-field"><span class="client-label">NHI</span><span class="client-value">${data.client.nhi || '—'}</span></div>
  <div class="client-field"><span class="client-label">Date of birth</span><span class="client-value">${data.client.dob || '—'}</span></div>
  <div class="client-field"><span class="client-label">Test list</span><span class="client-value">${data.test.list_name}</span></div>
  <div class="client-field"><span class="client-label">Scoring</span><span class="client-value">${modeNote}</span></div>
  <div class="client-field"><span class="client-label">Levels tested</span><span class="client-value">${lvls.length ? lvls.join(', ') + ' dBA' : '—'}</span></div>
</div>

${lvls.length ? `
<div class="section-title">Results</div>
<table>
  <thead><tr>
    <th class="kupu-col">Kupu</th>
    ${headerCols}
  </tr></thead>
  <tbody>
    ${bodyRows}
    ${summaryRow}
  </tbody>
</table>

<div class="key">
  <strong style="color:#555;font-size:10px">Key:</strong>
  <span><span class="key-dot" style="background:#2d8a1a"></span> Correct</span>
  <span><span class="key-dot" style="background:#c0392b"></span> Incorrect</span>
  <span><span class="key-dot" style="background:#ddd"></span> Not scored</span>
  <span style="margin-left:8px;color:#aaa">Each dot = one presentation</span>
</div>` : '<div style="color:#aaa;font-style:italic;margin-bottom:16px">No responses recorded.</div>'}

<div class="section-title">Clinical notes</div>
<div class="notes-box">${data.notes
  ? data.notes.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  : '<span class="notes-empty">No notes recorded.</span>'}</div>

<div class="page-footer">
  <span>Te reo Māori KTT — University of Canterbury</span>
  <span>Generated ${new Date(data.exported_at).toLocaleString('en-NZ')}</span>
</div>

<script>window.onload = () => window.print();<\/script>
</body></html>`;

    const win = window.open('', '_blank');
    if (!win) { alert('Please allow popups to open the report.'); return; }
    win.document.write(html);
    win.document.close();
  }

  // ─── Import / Export custom lists ─────────────────────────────────────────

  function exportLists() {
    const custom = loadCustomLists();
    if (!custom.length) { alert('No custom lists to export'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(custom, null, 2)], { type: 'application/json' }));
    a.download = `ktt_lists_${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  function importLists() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const imported = JSON.parse(ev.target.result);
          if (!Array.isArray(imported)) throw new Error('Expected an array');
          const cur    = loadCustomLists();
          const merged = [...imported.filter(l => !cur.find(c => c.id === l.id)), ...cur];
          saveCustomLists(merged);
          rebuildAllLists();
          renderSetupScreen();
          alert(`Imported ${imported.length} list(s).`);
        } catch (err) { alert('Import failed: ' + err.message); }
      };
      reader.readAsText(file);
    };
    inp.click();
  }

  // ─── List Builder bridge ──────────────────────────────────────────────────

  function openListBuilder(listId) {
    if (typeof window.kttListBuilder !== 'undefined') {
      window.kttListBuilder.open(listId, () => { rebuildAllLists(); renderSetupScreen(); });
    } else {
      alert('List builder not loaded.');
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    rebuildAllLists();
    // Always start on the manual setup screen
    renderSetupScreen();
    showView('manualSetupView');

    const manualBtn = document.getElementById('manualTestBtn');
    if (manualBtn) {
      manualBtn.addEventListener('click', () => {
        renderSetupScreen();
        showView('manualSetupView');
      });
    }

    if (location.hash === '#manual') {
      renderSetupScreen();
      showView('manualSetupView');
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  window.kttManual = { rebuildAllLists, renderSetupScreen, showView,
    onPairResponse, getActiveListForPair };

})();
