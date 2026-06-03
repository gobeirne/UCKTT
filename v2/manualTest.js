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
    stepped: { label: 'Stepped levels',     desc: 'Start at 40 dBA, raise 5 dB until correct.' },
    percent: { label: '% correct at level', desc: 'All kupu at one level; record % correct.' },
    free:    { label: 'Free / manual',       desc: 'Full clinician control.' },
  };

  const USEFUL_PHRASES = [
    { mi: 'Kei hea te ___?',       en: 'Where is the ___?' },
    { mi: 'Tohu ki te ___',         en: 'Point to the ___' },
    { mi: 'Whakaatuhia mai te ___', en: 'Show me the ___' },
    { mi: 'Ka pai tō whakarongo',   en: 'Good listening' },
    { mi: 'Tino pai',               en: 'Very good' },
    { mi: 'Ka mau te pai',          en: "That's great" },
    { mi: 'Turituri',               en: 'Be quiet' },
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
  let scoringMode   = 'stepped';
  let currentLevel  = DEFAULT_LEVEL;
  let armedKupu     = null;
  let showLabels    = true;   // show kupu text labels on test screen
  // scores[kupu][level] = ['correct'|'incorrect'|'empty', ...]  — dynamic array
  let scores        = {};
  // levelsUsed: ordered array of levels we've presented at (drives column display)
  let levelsUsed    = [];
  let clinicianViewMode = 'words';
  let sessionMeta   = { clientName: '', nhi: '', dob: '', testDate: '', clinician: '' };
  let sessionNotes  = '';
  let carrierAudio  = null;
  let kupuAudio     = null;

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

    // Ensure a pip slot exists before playing
    ensurePipSlot(kupu, currentLevel);

    const btn = document.getElementById('mt-play-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Playing…'; }

    refreshScoringTable();

    carrierAudio = new Audio(CARRIER_URL);
    kupuAudio    = new Audio(`${AUDIO_DIR}/${encodeURIComponent(kupu)}.mp3`);

    carrierAudio.play().catch(() => {});
    carrierAudio.onended = () => {
      kupuAudio.play().catch(() => {});
      kupuAudio.onended = () => {
        if (btn) { btn.disabled = !armedKupu; btn.textContent = '▶ Play'; }
      };
    };
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
    ['clientName','nhi','dob','testDate','clinician'].forEach(k => {
      if (S[k]) sessionMeta[k] = S[k];
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
    right.appendChild(sect('Custom lists', renderImportExport()));
  }

  function renderClientForm() {
    const wrap = el('div', { cls: 'mt-card' });

    function inp(label, key, placeholder, flex) {
      const d = el('div', { style: `flex:${flex||1};min-width:80px` });
      d.appendChild(el('div', { cls: 'mt-field-label' }, label));
      const i = el('input', { cls: 'mt-inp', placeholder, value: sessionMeta[key] || '',
        oninput: e => { sessionMeta[key] = e.target.value; saveSettings({ ...sessionMeta }); }
      });
      d.appendChild(i);
      return d;
    }

    const row1 = el('div', { cls: 'mt-form-row' });
    row1.append(inp('Name', 'clientName', 'Client name', 2), inp('NHI', 'nhi', 'NHI number', 1));
    const row2 = el('div', { cls: 'mt-form-row' });
    row2.append(inp('Date of birth', 'dob', 'DD/MM/YYYY', 1),
                inp('Test date', 'testDate', 'Today', 1),
                inp('Clinician', 'clinician', 'Initials', 1));
    wrap.append(row1, row2);
    return wrap;
  }

  function renderListSelector() {
    const wrap = el('div', { cls: 'mt-card mt-list-card' });
    const custom  = allLists.filter(l => !l.builtin);
    const builtin = allLists.filter(l => l.builtin);

    function listItem(list) {
      const item = el('div', { cls: 'mt-list-item' + (list.id === activeListId ? ' active' : ''),
        onclick: () => { activeListId = list.id; saveSettings({ activeListId }); renderSetupScreen(); }
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
    for (const [key, info] of Object.entries(SCORING_MODES)) {
      const card = el('div', { cls: 'mt-scoring-card' + (scoringMode === key ? ' active' : ''),
        onclick: () => { scoringMode = key; saveSettings({ scoringMode }); renderSetupScreen(); }
      });
      card.appendChild(el('div', { cls: 'mt-scoring-title' }, info.label));
      card.appendChild(el('div', { cls: 'mt-scoring-desc' }, info.desc));
      wrap.appendChild(card);
    }
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
    card.appendChild(el('button', { cls: 'mt-btn', style: 'width:100%;color:#888',
      onclick: () => alert('Paired device mode coming soon!') }, '📱 Pair child\'s device'));
    return card;
  }

  function renderImportExport() {
    const card = el('div', { cls: 'mt-card', style: 'display:flex;gap:6px' });
    card.appendChild(el('button', { cls: 'mt-btn', style: 'flex:1', onclick: importLists }, '↑ Import'));
    card.appendChild(el('button', { cls: 'mt-btn', style: 'flex:1', onclick: exportLists }, '↓ Export'));
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
    root.appendChild(infoBar);

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

    // Empty state
    if (levelsUsed.length === 0) {
      const empty = el('div', { cls: 'mt-table-empty' },
        'Select a kupu above and press Play to begin scoring.');
      container.appendChild(empty);
      return;
    }

    const table = el('table', { cls: 'mt-ktable', id: 'mt-ktable' });

    // Header
    const thead = el('thead');
    const hrow  = el('tr');
    hrow.appendChild(el('th', { cls: 'mt-th-kupu' }, showLabels ? 'Kupu' : ''));
    levelsUsed.forEach(lv => {
      hrow.appendChild(el('th', { cls: 'mt-th-level' + (lv === currentLevel ? ' current-level' : '') }, `${lv} dBA`));
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    // Body
    const tbody = el('tbody', { id: 'mt-tbody' });
    list.kupu.forEach(kupu => tbody.appendChild(buildKupuRow(kupu)));
    table.appendChild(tbody);
    container.appendChild(table);
  }

  function buildKupuRow(kupu) {
    const isArmed = kupu === armedKupu;
    const tr = el('tr', { cls: isArmed ? 'mt-row-armed' : '', 'data-kupu': kupu });

    // Kupu cell
    const nameTd = el('td', { cls: 'mt-kupu-td' });
    if (clinicianViewMode === 'images') {
      const imgEl = el('img', { cls: 'mt-kupu-img', alt: kupu });
      if (window.loadKupuImage) window.loadKupuImage(imgEl, kupu);
      else imgEl.src = `Images/${encodeURIComponent(kupu)}.png`;
      if (showLabels) {
        const lbl = el('div', { cls: 'mt-kupu-img-label' }, kupu);
        const wrap = el('div', { cls: 'mt-kupu-img-wrap' + (isArmed ? ' armed' : ''),
          onclick: () => armKupu(kupu) });
        wrap.append(imgEl, lbl);
        nameTd.appendChild(wrap);
      } else {
        imgEl.className += (isArmed ? ' armed-img' : '');
        imgEl.onclick = () => armKupu(kupu);
        nameTd.appendChild(imgEl);
      }
    } else {
      const nameSpan = el('span', { cls: 'mt-kupu-name' + (isArmed ? ' armed' : ''),
        onclick: () => armKupu(kupu) }, kupu);
      nameTd.appendChild(nameSpan);
    }
    tr.appendChild(nameTd);

    // Level cells (only columns in levelsUsed)
    levelsUsed.forEach(lv => {
      const td = el('td', { cls: 'mt-score-td' + (lv === currentLevel ? ' current-level' : '') });
      const pips = getPips(kupu, lv);
      const pipWrap = el('div', { cls: 'mt-pip-wrap' });
      pips.forEach((state, idx) => {
        const pip = el('div', { cls: `mt-pip ${state}`,
          title: `${kupu} @ ${lv} dBA`,
          onclick: () => { cyclePip(kupu, lv, idx); refreshScoringTable(); }
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

  // ─── Print image sheet ────────────────────────────────────────────────────

  function printImageSheet() {
    const list = getActiveList();
    if (!list) { alert('No list selected'); return; }

    // Build image URLs using same fallback logic as loadKupuImage
    const EXTS = ['png','jpg','jpeg','webp'];

    const cells = list.kupu.map(kupu => {
      // Try to find what extension the image actually has by building candidates
      // In print context we can't do async fallback, so we emit all as <img> with onerror
      const imgTag = `<img src="Images/${encodeURIComponent(kupu)}.png"
        onerror="
          var exts=['jpg','jpeg','webp'];
          var tried=this.dataset.tried?parseInt(this.dataset.tried):0;
          if(tried<exts.length){this.dataset.tried=tried+1;this.src='Images/${encodeURIComponent(kupu)}.'+exts[tried];}
          else this.style.visibility='hidden';"
        alt="${kupu}">`;
      return `<div class="cell">${imgTag}<div class="lbl">${kupu}</div></div>`;
    }).join('');

    const win = window.open('', '_blank');
    if (!win) { alert('Please allow popups to print'); return; }
    win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>KTT — ${list.name}</title>
      <style>
        @page { size: A4 landscape; margin: 1cm; }
        body { font-family: system-ui, sans-serif; margin: 0; padding: 0; }
        header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
        header img { height: 36px; }
        header h2 { font-size: 13px; margin: 0; color: #111; }
        header .list-name { font-size: 12px; color: #bbb; margin-left: 4px; }
        .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
        .cell { border: 1px solid #ddd; border-radius: 6px; padding: 6px; text-align: center; }
        .cell img { width: 100%; aspect-ratio: 1; object-fit: contain; }
        .lbl { font-size: 10px; color: #bbb; margin-top: 3px; }
      </style></head><body>
      <header>
        <img src="UClogo.png" alt="UC">
        <h2>Te reo Māori Kendall Toy Test
          <span class="list-name">— ${list.name}</span>
        </h2>
      </header>
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
    const dl   = (blob, name) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name; a.click(); URL.revokeObjectURL(a.href);
    };
    dl(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `KTT_${slug}_${ts}.json`);
    dl(new Blob([buildTextSummary(data)],          { type: 'text/plain' }),       `KTT_${slug}_${ts}.txt`);
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

  window.kttManual = { rebuildAllLists, renderSetupScreen, showView };

})();
