// fifteenAFC.js — Kendall Toy Test (15 items)
// Responsive grid fits viewport both horizontally & vertically (5×3 landscape, 3×5 portrait)
// - Exact filenames preserved (macrons/spaces OK; URLs encoded on load)
// - Inline TSV on file://; fetch TSV on http/https
// - Gapless WebAudio “Kei hea te_01” + kupu; fallback to HTMLAudio on file://
// - Clicks accepted from kupu onset (not during preface)
// - Settings screen: training taps (kupu-only)
// - Test screen: ⚙ pause; ✖ quit; Esc=quit; S=pause
// - Show/hide labels, progress, correct; neutral glow when hidden
// - Resume after settings changes repaints grid preserving order
// - End screen thumbs-up + phrase; auto-saves .txt and tells user file name

(() => {
  const DEBUG = false;
  const dbg  = (...a) => { if (DEBUG) console.log('[KTT]', ...a); };
  const warn = (...a) => console.warn('[KTT]', ...a);

  const $ = (s) => document.querySelector(s);

  // Views
  const settingsView = $('#settingsView');
  const testView     = $('#testView');

  // Settings DOM
  const listSel          = $('#listSelect');
  const showLabelsEl     = $('#showLabels');
  const randomizeEl      = $('#randomize');
  const repeatCountEl    = $('#repeatCount');
  const showProgressEl   = $('#showProgress');
  const showCorrectEl    = $('#showCorrect');
  const startOrReturnBtn = $('#startOrReturnBtn');
  const downloadBtn      = $('#downloadResults');
  const settingsHint     = $('#settingsHint');
  const settingsPreview  = $('#settingsPreviewGrid');
  const settingsStatus   = $('#settingsStatus');

  // Test DOM
  const gridEl            = $('#grid');
  const statusEl          = $('#status');
  const progressSummaryEl = $('#progressSummary'); // optional
  const btnToSettings     = $('#btnToSettingsPaused');
  const btnQuitTest       = $('#btnQuitTest');
  const testTopbar        = document.querySelector('.test-topbar') || $('#testTopbar');

  // Paths
  const DATA_URL    = 'kupu_lists.tsv';
  const IMAGE_DIR   = 'Images';
  const AUDIO_DIR   = 'sounds';
  const SUCCESS_IMG = `${IMAGE_DIR}/pai.png`;
  const END_PHRASES = ['Tau kē koe!','Ki a koe hoki!','Karawhiua!','Koia te hāngaitanga!','Mīharo!'];

  const USE_INLINE_LISTS = location.protocol === 'file:';

  const AUDIO_CTX =
    (location.protocol !== 'file:' && (window.AudioContext || window.webkitAudioContext))
      ? new (window.AudioContext || window.webkitAudioContext)()
      : null;
  const audioBufferCache = new Map();

  // /a/, /ā/, /ai/, /au/, /ae/, etc.
  const PHONEME_RE = /^\/[a-zāēīōū]{1,3}\/$/i;

  // -------- State --------
  let lists = [];
  let currentListIdx = 0;
  let gridOrder = [];
  let testQueue = [];
  let trialIndex = 0;
  let currentTarget = null;
  let awaitingResponse = false;
  let trialStartTime = null;
  let playing = false;
  let score = 0;
  let results = [];
  let testInProgress = false;
  let testPaused = false;

  // timers/audio refs
  let htmlAudio1 = null, htmlAudio2 = null;
  let playbackDoneTimer = null, kupuOnsetTimer = null, isiTimer = null;
  let currentSources = [];
  let trainingSource = null, trainingAudio = null;

  // -------- Utils --------
  const isLandscape = () => window.innerWidth >= window.innerHeight;
  const randChoice  = (arr) => arr[Math.floor(Math.random()*arr.length)];
  function encodeURL(dir, filename, ext) { return `${dir}/${encodeURIComponent(filename)}.${ext}`; }
  function shuffle(a){ const x=a.slice(); for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];} return x; }

  function clearTimersAndAudio() {
    [playbackDoneTimer, kupuOnsetTimer, isiTimer].forEach(t => t && clearTimeout(t));
    playbackDoneTimer = kupuOnsetTimer = isiTimer = null;
    currentSources.forEach(s => { try{s.stop();}catch{} });
    currentSources = [];
    if (htmlAudio1) { try{htmlAudio1.pause();}catch{} htmlAudio1=null; }
    if (htmlAudio2) { try{htmlAudio2.pause();}catch{} htmlAudio2=null; }
    playing=false; awaitingResponse=false;
  }
  function stopTrainingAudio() {
    if (trainingSource) { try{trainingSource.stop();}catch{} trainingSource=null; }
    if (trainingAudio)  { try{trainingAudio.pause();}catch{} trainingAudio=null; }
  }

  // -------- Lists --------
  function parseLineToKupu(line) {
    const raw  = line.trim().split(/\t| {2,}|\s{1,}/).filter(Boolean);
    const kupu = raw.filter(tok => !PHONEME_RE.test(tok));
    return kupu.slice(0, 15);
  }
  function parseTextToLists(text) {
    const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    return lines.map(parseLineToKupu).filter(row => row.length === 15);
  }
  async function loadLists() {
    if (USE_INLINE_LISTS) {
      const node = document.getElementById('kupu-lists');
      if (node && node.textContent.trim()) {
        const parsed = parseTextToLists(node.textContent);
        if (parsed.length) return parsed;
      }
      try {
        const r = await fetch(DATA_URL, { cache: 'no-store' });
        if (r.ok) {
          const t = await r.text();
          const parsed = parseTextToLists(t);
          if (parsed.length) return parsed;
        }
      } catch(_) {}
      throw new Error('Could not load lists from inline block (and fetch blocked on file://).');
    } else {
      try {
        const r = await fetch(DATA_URL, { cache: 'no-store' });
        if (r.ok) {
          const t = await r.text();
          const parsed = parseTextToLists(t);
          if (parsed.length) return parsed;
        }
      } catch(e){ warn('fetch failed',e); }
      const node = document.getElementById('kupu-lists');
      if (node && node.textContent.trim()) {
        const parsed = parseTextToLists(node.textContent);
        if (parsed.length) return parsed;
      }
      throw new Error('Could not load lists.');
    }
  }

  // -------- Audio --------
  async function getAudioBuffer(url) {
    if (audioBufferCache.has(url)) return audioBufferCache.get(url);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`fetch failed: ${url}`);
    const arr = await res.arrayBuffer();
    const buf = await AUDIO_CTX.decodeAudioData(arr);
    audioBufferCache.set(url, buf);
    return buf;
  }
  const keiHeaTeURL  = () => `${AUDIO_DIR}/Kei_hea_te_01.mp3`; // fixed version
  const kupuAudioURL = (kupu) => encodeURL(AUDIO_DIR, kupu, 'mp3');

  // -------- Responsive sizing: scale grid to viewport (both axes) --------
  function fitGridToViewport() {
    if (!gridEl || !testView.classList.contains('active')) return;

    // Desired geometry
    const cols = isLandscape() ? 5 : 3;
    const rows = isLandscape() ? 3 : 5;

    // Available width = grid content box width
    // Available height = viewport bottom minus grid's top minus testView bottom padding
    const gridCS = getComputedStyle(gridEl);
    const gap = parseFloat(gridCS.gap) || 14;

    const tvRect = testView.getBoundingClientRect();
    const tvCS = getComputedStyle(testView);
    const padBottom = parseFloat(tvCS.paddingBottom) || 0;

    const gridTop = gridEl.getBoundingClientRect().top;
    const vw = document.documentElement.clientWidth;
    const vh = window.visualViewport ? Math.floor(window.visualViewport.height) : window.innerHeight;

    const availW = gridEl.clientWidth || (vw - 32);
    const availH = Math.max(0, vh - (gridTop) - padBottom);

    const sizeW = (availW - gap * (cols - 1)) / cols;
    const sizeH = (availH - gap * (rows - 1)) / rows;
    const cell = Math.floor(Math.max(60, Math.min(sizeW, sizeH)));

    // Apply fixed columns of that cell size (square via img aspect-ratio)
    gridEl.style.gridTemplateColumns = `repeat(${cols}, ${cell}px)`;
    gridEl.querySelectorAll('.cell').forEach(c => { c.style.width = `${cell}px`; });
  }

  // -------- Views --------
  function showSettings() {
    settingsView.classList.add('active');
    testView.classList.remove('active');
    startOrReturnBtn.textContent = testInProgress ? 'Return to test' : 'Start test';
    settingsHint.textContent = testInProgress
      ? 'Test paused. Adjust display options, then return.'
      : 'Tap an image to hear its kupu.';
    renderSettingsPreview();
  }
  function showTest() {
    settingsView.classList.remove('active');
    testView.classList.add('active');
    ensureTopbarOnTop();
    stopTrainingAudio();
    // Fit after DOM is visible
    requestAnimationFrame(fitGridToViewport);
  }
  function ensureTopbarOnTop() {
    if (!testTopbar) return;
    Object.assign(testTopbar.style, {
      position:'fixed', top:'8px', right:'16px', zIndex:'2147483647',
      pointerEvents:'auto', display:'flex', gap:'10px',
      background:'rgba(255,255,255,0.85)', backdropFilter:'blur(6px)',
      padding:'6px', borderRadius:'10px', border:'1px solid #ccc'
    });
    [btnToSettings, btnQuitTest].forEach(b=> b && Object.assign(b.style,{pointerEvents:'auto', zIndex:'2147483647'}));
  }

  // -------- Grid render --------
  function renderGrid(kupu15) {
    gridEl.innerHTML = '';
    statusEl.textContent = '';
    if (progressSummaryEl) progressSummaryEl.textContent = '';

    const items = (randomizeEl && randomizeEl.checked) ? shuffle(kupu15) : kupu15.slice();
    gridOrder = items.slice();

    items.forEach(kupu => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.tabIndex = 0;

      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = kupu;
      img.src = encodeURL(IMAGE_DIR, kupu, 'png');
      img.onerror = () => { img.style.display = 'none'; };

      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = kupu;
      label.style.display = showLabelsEl.checked ? '' : 'none';

      cell.appendChild(img);
      cell.appendChild(label);
      cell.addEventListener('click', () => handleResponse(kupu));
      gridEl.appendChild(cell);
    });

    fitGridToViewport();
  }

  function repaintGridPreservingOrder() {
    if (!gridOrder.length) return;
    gridEl.innerHTML = '';
    gridOrder.forEach(kupu => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.tabIndex = 0;

      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = kupu;
      img.src = encodeURL(IMAGE_DIR, kupu, 'png');
      img.onerror = () => { img.style.display = 'none'; };

      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = kupu;
      label.style.display = showLabelsEl.checked ? '' : 'none';

      cell.appendChild(img);
      cell.appendChild(label);
      cell.addEventListener('click', () => handleResponse(kupu));
      gridEl.appendChild(cell);
    });

    fitGridToViewport();
  }

  function applyDisplayOptionsToExistingGrid() {
    gridEl.querySelectorAll('.label').forEach(l => {
      l.style.display = showLabelsEl.checked ? '' : 'none';
    });
    updateProgressUI();
  }

  // Settings preview (training taps)
  function renderSettingsPreview() {
    settingsPreview.innerHTML = '';
    const kupu15 = lists[currentListIdx];
    const items = (randomizeEl && randomizeEl.checked) ? shuffle(kupu15) : kupu15.slice();

    items.forEach(kupu => {
      const cell = document.createElement('div');
      cell.className = 'cell';

      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = kupu;
      img.src = encodeURL(IMAGE_DIR, kupu, 'png');
      img.onerror = () => { img.style.display = 'none'; };

      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = kupu;
      label.style.display = showLabelsEl.checked ? '' : 'none';

      cell.appendChild(img);
      cell.appendChild(label);

      cell.addEventListener('click', () => playKupuOnly(kupu));
      settingsPreview.appendChild(cell);
    });
    settingsStatus.textContent = '';
  }

  // -------- Training playback (kupu only) --------
  async function playKupuOnly(kupu) {
    stopTrainingAudio();
    if (AUDIO_CTX) {
      try {
        if (AUDIO_CTX.state !== 'running') await AUDIO_CTX.resume();
        const buf = await getAudioBuffer(kupuAudioURL(kupu));
        const t0  = AUDIO_CTX.currentTime + 0.02;
        const src = AUDIO_CTX.createBufferSource();
        src.buffer = buf; src.connect(AUDIO_CTX.destination);
        trainingSource = src; src.start(t0);
        return;
      } catch(e){ warn('training WebAudio failed; fallback to HTMLAudio', e); }
    }
    trainingAudio = new Audio(kupuAudioURL(kupu));
    trainingAudio.onended = () => { trainingAudio = null; };
    trainingAudio.play().catch(()=>{ trainingAudio=null; });
  }

  // -------- Test queue --------
  function getRepeatCount() {
    const n = parseInt(repeatCountEl.value, 10);
    return isFinite(n) && n >= 1 && n <= 10 ? n : 3;
  }
  function buildTestQueue(kupu15, repeatCount) {
    const q = [];
    kupu15.forEach(k => { for (let i=0;i<repeatCount;i++) q.push(k); });
    return shuffle(q);
  }

  // -------- Trial playback --------
  async function playPromptThenKupu(kupu, onDone) {
    clearTimersAndAudio();

    if (AUDIO_CTX) {
      try {
        if (AUDIO_CTX.state !== 'running') await AUDIO_CTX.resume();
        const phraseBuf = await getAudioBuffer(keiHeaTeURL());
        const kupuBuf   = await getAudioBuffer(kupuAudioURL(kupu));

        const t0 = AUDIO_CTX.currentTime + 0.03;
        const s1 = AUDIO_CTX.createBufferSource(); s1.buffer = phraseBuf;
        const s2 = AUDIO_CTX.createBufferSource(); s2.buffer = kupuBuf;
        s1.connect(AUDIO_CTX.destination);
        s2.connect(AUDIO_CTX.destination);
        currentSources = [s1, s2]; playing = true;

        s1.start(t0);
        s2.start(t0 + phraseBuf.duration);

        const msUntilKupu = Math.max(0, Math.ceil((t0 + phraseBuf.duration - AUDIO_CTX.currentTime) * 1000));
        kupuOnsetTimer = setTimeout(() => {
          awaitingResponse = true; trialStartTime = Date.now(); kupuOnsetTimer = null;
        }, msUntilKupu);

        const total = phraseBuf.duration + kupuBuf.duration;
        playbackDoneTimer = setTimeout(() => {
          playing = false; playbackDoneTimer = null; onDone && onDone();
        }, Math.ceil((t0 + total - AUDIO_CTX.currentTime) * 1000));
        return;
      } catch(e){ warn('WebAudio failed; fallback to HTMLAudio', e); currentSources=[]; }
    }

    // Fallback
    playing = true;
    htmlAudio1 = new Audio(keiHeaTeURL());
    htmlAudio1.onended = () => {
      htmlAudio2 = new Audio(kupuAudioURL(kupu));
      htmlAudio2.onplay  = () => { awaitingResponse = true; trialStartTime = Date.now(); };
      htmlAudio2.onended = () => { playing=false; htmlAudio1=htmlAudio2=null; onDone && onDone(); };
      htmlAudio2.play().catch(()=>{ playing=false; htmlAudio1=htmlAudio2=null; onDone && onDone(); });
    };
    htmlAudio1.play().catch(() => {
      htmlAudio2 = new Audio(kupuAudioURL(kupu));
      htmlAudio2.onplay  = () => { awaitingResponse = true; trialStartTime = Date.now(); };
      htmlAudio2.onended = () => { playing=false; htmlAudio1=htmlAudio2=null; onDone && onDone(); };
      htmlAudio2.play().catch(()=>{ playing=false; htmlAudio1=htmlAudio2=null; onDone && onDone(); });
    });
  }

  // -------- Flow --------
  function updateProgressUI() {
    const showProg = showProgressEl && showProgressEl.checked;
    const t = `Trial ${trialIndex + 1} / ${testQueue.length} • Score: ${score}`;
    statusEl.textContent = showProg ? t : '';
    if (progressSummaryEl) progressSummaryEl.textContent = '';
  }

  function startTest() {
    currentListIdx = parseInt(listSel.value, 10) || 0;
    const kupu15 = lists[currentListIdx];
    const repeatCount = getRepeatCount();

    testQueue = buildTestQueue(kupu15, repeatCount);
    trialIndex = 0; score = 0; results = [];
    testInProgress = true; testPaused = false;
    downloadBtn && (downloadBtn.disabled = true);

    if (AUDIO_CTX && AUDIO_CTX.state !== 'running') AUDIO_CTX.resume().catch(()=>{});
    showTest();
    renderGrid(kupu15);
    updateProgressUI();
    nextTrial();
  }

  function pauseToSettings() {
    if (!testInProgress) { showSettings(); return; }
    testPaused = true; clearTimersAndAudio(); showSettings();
    startOrReturnBtn.textContent = 'Return to test';
    settingsHint.textContent = 'Test paused. Adjust display options, then return.';
  }

  function quitTest() {
    testInProgress = false; testPaused = false; clearTimersAndAudio();
    statusEl.textContent = ''; if (progressSummaryEl) progressSummaryEl.textContent = '';
    currentTarget = null; showSettings();
  }

  function nextTrial() {
    if (!testInProgress || testPaused) return;
    if (trialIndex >= testQueue.length) {
      endTestScreen();
      testInProgress = false;
      startOrReturnBtn.textContent = 'Start test';
      downloadBtn && (downloadBtn.disabled = false);
      return;
    }
    currentTarget = testQueue[trialIndex];
    const showProg = showProgressEl && showProgressEl.checked;
    statusEl.textContent = showProg ? `Trial ${trialIndex + 1} / ${testQueue.length}` : '';
    awaitingResponse = false; trialStartTime = null;
    playPromptThenKupu(currentTarget, () => {});
  }

  function handleResponse(clickedKupu) {
    if (!testInProgress || testPaused) return;
    if (!currentTarget || !awaitingResponse) return;

    awaitingResponse = false;
    const rt = trialStartTime ? (Date.now() - trialStartTime) : NaN;
    const ok = clickedKupu === currentTarget;
    if (ok) score++;

    const cells = Array.from(gridEl.children);
    const clicked = cells.find(c => {
      const lbl = c.querySelector('.label'); return lbl && lbl.textContent === clickedKupu;
    });

    const showCorr = showCorrectEl && showCorrectEl.checked;
    if (clicked) {
      clicked.classList.remove('correct','incorrect','neutral');
      clicked.classList.add(showCorr ? (ok ? 'correct' : 'incorrect') : 'neutral');
    }
    if (showCorr) {
      statusEl.textContent = ok ? '✅ Correct' : `✖️ Incorrect (was ${currentTarget})`;
    } else if (showProgressEl && showProgressEl.checked) {
      statusEl.textContent = `Trial ${trialIndex + 1} / ${testQueue.length} • Score: ${score}`;
    } else {
      statusEl.textContent = '';
    }

    results.push({ trial: trialIndex+1, list: currentListIdx+1, target: currentTarget,
                   response: clickedKupu, correct: ok ? 1 : 0, rt_ms: rt, ts_iso: new Date().toISOString() });

    isiTimer = setTimeout(() => {
      cells.forEach(c => c.classList.remove('correct','incorrect','neutral'));
      trialIndex++; updateProgressUI(); nextTrial();
    }, 1000);
  }

  // -------- End & export --------
  function downloadResults(autoNoteEl) {
    if (!results.length) return null;
    const header = ['trial','list','target','response','correct','rt_ms','ts_iso'].join('\t')+'\n';
    const body = results.map(r => [r.trial,r.list,r.target,r.response,r.correct,r.rt_ms,r.ts_iso].join('\t')).join('\n');
    const filename = `results_${new Date().toISOString().replace(/[:.]/g,'-')}.txt`;
    const blob = new Blob([header+body], {type:'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
    if (autoNoteEl) autoNoteEl.textContent = `Results saved to your Downloads folder as “${filename}”.`;
    return filename;
  }

  function endTestScreen() {
    clearTimersAndAudio();
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position:'fixed', inset:'0', background:'#fff',
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
      gap:'20px', padding:'24px', textAlign:'center', zIndex:'3000', cursor:'pointer'
    });
    const img = document.createElement('img');
    img.src = SUCCESS_IMG; img.alt = 'Thumbs up';
    Object.assign(img.style,{maxWidth:'70vw', maxHeight:'50vh', objectFit:'contain'});
    const phrase = document.createElement('div');
    phrase.textContent = randChoice(END_PHRASES);
    Object.assign(phrase.style,{fontSize:'clamp(1.6rem,4vw,2.4rem)', fontWeight:'700'});
    const note = document.createElement('div');
    Object.assign(note.style,{fontSize:'clamp(0.9rem,2.2vw,1.05rem)', color:'#444'});
    const tap = document.createElement('div');
    tap.textContent = 'Tap anywhere to return to home screen';
    Object.assign(tap.style,{fontSize:'clamp(0.95rem,2.2vw,1.1rem)', color:'#666'});
    overlay.append(img, phrase, note, tap);
    document.body.appendChild(overlay);
    downloadResults(note);
    overlay.addEventListener('click', () => { overlay.remove(); quitTest(); });
  }

  // -------- Hotkeys & toolbar --------
  function handleHotkeys(e) {
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (['input','select','textarea'].includes(tag)) return;
    if (e.key === 'Escape') { e.preventDefault(); quitTest(); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); pauseToSettings(); }
  }
  function bindToolbarDelegation() {
    document.addEventListener('click', (e) => {
      const q = e.target && e.target.closest && e.target.closest('#btnQuitTest');
      if (q) { e.preventDefault(); e.stopPropagation(); quitTest(); return; }
      const s = e.target && e.target.closest && e.target.closest('#btnToSettingsPaused');
      if (s) { e.preventDefault(); e.stopPropagation(); pauseToSettings(); return; }
    }, true);
  }
  function bindToolbarDirect() {
    btnQuitTest && btnQuitTest.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); quitTest(); });
    btnToSettings && btnToSettings.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); pauseToSettings(); });
  }

function enableVerboseWiring() {
  const toName = (el) => {
    if (!el) return '(none)';
    if (el.id) return `#${el.id}`;
    if (el.className) return `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}`;
    return el.tagName.toLowerCase();
  };

  console.log('[KTT VERBOSE] wiring:',
    { settingsView: !!document.querySelector('#settingsView'),
      testView: !!document.querySelector('#testView'),
      startOrReturnBtn: !!document.querySelector('#startOrReturnBtn'),
      btnQuitTest: !!document.querySelector('#btnQuitTest'),
      btnToSettingsPaused: !!document.querySelector('#btnToSettingsPaused') });

  document.addEventListener('click', (e) => {
    const t = e.target;
    const hitQuit = t.closest && t.closest('#btnQuitTest');
    const hitGear = t.closest && t.closest('#btnToSettingsPaused');
    const hitStart = t.closest && t.closest('#startOrReturnBtn');
    if (hitQuit)  console.log('[KTT VERBOSE] click → quit', toName(t));
    if (hitGear)  console.log('[KTT VERBOSE] click → settings/pause', toName(t));
    if (hitStart) console.log('[KTT VERBOSE] click → start/return', toName(t));
  }, true);

  window.addEventListener('keydown', (e) => {
    if (['Escape','s','S'].includes(e.key)) {
      console.log('[KTT VERBOSE] keydown', e.key, { testInProgress, testPaused });
    }
  }, true);
}
// in init():
// enableVerboseWiring();


  // -------- Init --------
  async function init() {
    try {
      lists = await loadLists();
    } catch (e) {
      settingsStatus.textContent = `Error: ${e.message}`;
      return;
    }

    listSel.innerHTML = '';
    lists.forEach((_, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = `List ${idx + 1}`;
      listSel.appendChild(opt);
    });
    currentListIdx = 0;

    renderSettingsPreview();
    showSettings();
	enableVerboseWiring();

    // Settings handlers
    listSel.addEventListener('change', () => {
      currentListIdx = parseInt(listSel.value, 10) || 0;
      renderSettingsPreview();
    });
    showLabelsEl.addEventListener('change', renderSettingsPreview);
    randomizeEl.addEventListener('change', renderSettingsPreview);
    repeatCountEl.addEventListener('change', () => {});
    showProgressEl.addEventListener('change', () => {});
    showCorrectEl.addEventListener('change', () => {});

    // Start / Return
    startOrReturnBtn.addEventListener('click', () => {
      if (testInProgress && testPaused) {
        testPaused = false; showTest();
        repaintGridPreservingOrder();     // no reorder
        applyDisplayOptionsToExistingGrid();
        updateProgressUI();
        nextTrial();
      } else if (!testInProgress) {
        startTest();
      } else {
        showTest();
      }
    });

    downloadBtn && downloadBtn.addEventListener('click', () => downloadResults());

    bindToolbarDirect();
    bindToolbarDelegation();
    ensureTopbarOnTop();

    // Fit grid whenever viewport changes (rotate, iOS URL bar, etc.)
    window.addEventListener('resize', () => { if (testView.classList.contains('active')) fitGridToViewport(); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => { if (testView.classList.contains('active')) fitGridToViewport(); });
    }
    window.addEventListener('keydown', handleHotkeys, true);

    // Defensive delegation for grid
    gridEl.addEventListener('click', (e) => {
      const cell = e.target.closest && e.target.closest('.cell');
      if (!cell) return;
      const lbl = cell.querySelector('.label');
      if (!lbl) return;
      handleResponse(lbl.textContent);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
