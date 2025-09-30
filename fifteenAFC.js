// fifteenAFC.js — Two-screen Kendall Toy Test with verbose debug logging (FIXED)
// - Exact filenames preserved (macrons/spaces OK) with URL-encoded loads
// - Inline TSV fallback on file://; fetch on http/https
// - GAPLESS “Kei hea te_01” → kupu (Web Audio); HTMLAudio fallback on file://
// - Clicks accepted from kupu onset (not during preface)
// - Settings “training mode”: tap preview to hear kupu only
// - End screen + auto-save; neutral glow when correct hidden
// - Toolbar (⚙/✖) click-safe + Hotkeys (Esc/S)
// - VERBOSE DEBUG LOGGING. Toggle with DEBUG=true/false.

(() => {
  // ===== DEBUG UTIL =====
  const DEBUG = true;
  const dbg  = (...a) => { if (DEBUG) console.log('[KTT DEBUG]', ...a); };
  const warn = (...a) => console.warn('[KTT WARN]', ...a);
  const err  = (...a) => console.error('[KTT ERROR]', ...a);

  window.addEventListener('error', (e) => err('window.onerror', e.message, e.error || e));
  window.addEventListener('unhandledrejection', (e) => err('unhandledrejection', e.reason));

  function describeEl(el) {
    if (!el) return '(null)';
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className ? '.' + String(el.className).trim().replace(/\s+/g,'.') : '';
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
  }
  function styleInfo(el) {
    if (!el) return {};
    const cs = getComputedStyle(el);
    return {
      position: cs.position,
      zIndex: cs.zIndex,
      pointerEvents: cs.pointerEvents,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
    };
  }
  function rectInfo(el) {
    if (!el) return {};
    const r = el.getBoundingClientRect();
    return {x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height)};
  }
  function hitTestLog(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = Math.round(r.right - 8);
    const py = Math.round(r.top + 8);
    const stack = document.elementsFromPoint(px, py);
    dbg('elementsFromPoint near', describeEl(el), {px,py}, stack.map(describeEl));
  }

  // ===== SHORTHANDS =====
  const $ = (s) => document.querySelector(s);

  // Views
  const settingsView = $('#settingsView');
  const testView     = $('#testView');

  // Settings DOM
  const listSel            = $('#listSelect');
  const showLabelsEl       = $('#showLabels');
  const randomizeEl        = $('#randomize');
  const repeatCountEl      = $('#repeatCount');
  const showProgressEl     = $('#showProgress');
  const showCorrectEl      = $('#showCorrect');
  const startOrReturnBtn   = $('#startOrReturnBtn');
  const downloadBtn        = $('#downloadResults');
  const settingsHint       = $('#settingsHint');
  const settingsPreview    = $('#settingsPreviewGrid');
  const settingsStatus     = $('#settingsStatus');

  // Test DOM
  const gridEl             = $('#grid');
  const statusEl           = $('#status');
  const progressSummaryEl  = $('#progressSummary');
  const btnToSettingsPaused= $('#btnToSettingsPaused');
  const btnQuitTest        = $('#btnQuitTest');
  const testTopbar         = document.querySelector('.test-topbar') || $('#testTopbar');

  dbg('DOMContentLoaded hook queued: elements snapshot', {
    settingsView: !!settingsView, testView: !!testView,
    listSel: !!listSel, showLabelsEl: !!showLabelsEl, randomizeEl: !!randomizeEl,
    repeatCountEl: !!repeatCountEl, showProgressEl: !!showProgressEl, showCorrectEl: !!showCorrectEl,
    startOrReturnBtn: !!startOrReturnBtn, downloadBtn: !!downloadBtn,
    settingsPreview: !!settingsPreview, gridEl: !!gridEl, statusEl: !!statusEl,
    btnToSettingsPaused: !!btnToSettingsPaused, btnQuitTest: !!btnQuitTest, testTopbar: !!testTopbar,
  });

  // Paths
  const DATA_URL  = 'kupu_lists.tsv';
  const IMAGE_DIR = 'Images';
  const AUDIO_DIR = 'sounds';
  const SUCCESS_IMG = 'Images/pai.png';

  const END_PHRASES = ['Tau kē koe!','Ki a koe hoki!','Karawhiua!','Koia te hāngaitanga!','Mīharo!'];

  const USE_INLINE_LISTS = location.protocol === 'file:';
  const AUDIO_CTX =
    (location.protocol !== 'file:' && (window.AudioContext || window.webkitAudioContext))
      ? new (window.AudioContext || window.webkitAudioContext)()
      : null;
  const audioBufferCache = new Map();

  const PHONEME_RE = /^\/[a-zāēīōū]{1,3}\/$/i;

  // State
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

  // audio/timers
  let htmlAudio1 = null, htmlAudio2 = null;
  let playbackDoneTimer = null;
  let kupuOnsetTimer = null;
  let isiTimer = null;
  let currentSources = [];

  // Training playback refs
  let trainingSource = null;
  let trainingAudio  = null;

  // ===== UTIL =====
  function encodeURL(dir, filename, ext) { return `${dir}/${encodeURIComponent(filename)}.${ext}`; }
  function shuffle(arr) { const a = arr.slice(); for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
  const randChoice = (arr) => arr[Math.floor(Math.random()*arr.length)];

  function clearTimersAndAudio() {
    dbg('clearTimersAndAudio()');
    [playbackDoneTimer, kupuOnsetTimer, isiTimer].forEach(t => { if (t) clearTimeout(t); });
    playbackDoneTimer = kupuOnsetTimer = isiTimer = null;
    currentSources.forEach(src => { try { src.stop(); } catch(_){} });
    currentSources = [];
    if (htmlAudio1) { try { htmlAudio1.pause(); } catch(_){} htmlAudio1 = null; }
    if (htmlAudio2) { try { htmlAudio2.pause(); } catch(_){} htmlAudio2 = null; }
    playing = false;
    awaitingResponse = false;
  }
  function stopTrainingAudio() {
    dbg('stopTrainingAudio()');
    if (trainingSource) { try { trainingSource.stop(); } catch(_){} trainingSource = null; }
    if (trainingAudio)  { try { trainingAudio.pause(); } catch(_){} trainingAudio  = null; }
  }

  // ===== LOAD LISTS =====
  function parseLineToKupu(line) {
    const raw = line.trim().split(/\t| {2,}|\s{1,}/).filter(Boolean);
    const kupu = raw.filter(tok => !PHONEME_RE.test(tok));
    return kupu.slice(0, 15);
  }
  function parseTextToLists(text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return lines.map(parseLineToKupu).filter(row => row.length === 15);
  }
  async function loadLists() {
    dbg('loadLists() start. inline?', USE_INLINE_LISTS);
    if (USE_INLINE_LISTS) {
      const node = document.getElementById('kupu-lists');
      if (node && node.textContent.trim()) {
        const parsed = parseTextToLists(node.textContent);
        dbg('parsed inline lists:', parsed.length);
        if (parsed.length) return parsed;
      }
      try {
        const res = await fetch(DATA_URL, { cache: 'no-store' });
        if (res.ok) {
          const text = await res.text();
          const parsed = parseTextToLists(text);
          dbg('parsed fetch lists (file:// attempt):', parsed.length);
          if (parsed.length) return parsed;
        }
      } catch (e) { warn('fetch on file:// failed', e); }
      throw new Error('No lists via inline <script> (file:// CORS blocks fetch).');
    }
    try {
      const res = await fetch(DATA_URL, { cache: 'no-store' });
      if (res.ok) {
        const text = await res.text();
        const parsed = parseTextToLists(text);
        dbg('parsed fetch lists (http/https):', parsed.length);
        if (parsed.length) return parsed;
      } else warn('fetch not ok', res.status);
    } catch (e) { warn('fetch failed', e); }
    const node = document.getElementById('kupu-lists');
    if (node && node.textContent.trim()) {
      const parsed = parseTextToLists(node.textContent);
      dbg('parsed inline fallback:', parsed.length);
      if (parsed.length) return parsed;
    }
    throw new Error('Could not load lists.');
  }

  // ===== AUDIO =====
  async function getAudioBuffer(url) {
    if (audioBufferCache.has(url)) return audioBufferCache.get(url);
    dbg('getAudioBuffer()', url);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`fetch failed: ${url}`);
    const arr = await res.arrayBuffer();
    const buf = await AUDIO_CTX.decodeAudioData(arr);
    audioBufferCache.set(url, buf);
    return buf;
  }
  function keiHeaTeURL() { return `${AUDIO_DIR}/Kei hea te_01.mp3`; } // fixed
  function kupuAudioURL(kupu) { return encodeURL(AUDIO_DIR, kupu, 'mp3'); }

  // ===== VIEWS =====
  function showSettings() {
    dbg('showSettings()');
    settingsView.classList.add('active');
    testView.classList.remove('active');
    startOrReturnBtn.textContent = testInProgress ? 'Return to test' : 'Start test';
    settingsHint.textContent = testInProgress ? 'Test paused. Adjust display options, then return.' : 'Tap an image to hear its kupu.';
    renderSettingsPreview();
  }
  function ensureTopbarOnTop() {
    if (!testTopbar) return;
    Object.assign(testTopbar.style, {
      position: 'fixed',
      top: '8px',
      right: '16px',
      zIndex: '2147483647',
      pointerEvents: 'auto',
      display: 'flex',
      gap: '10px',
      background: 'rgba(255,255,255,0.85)',
      backdropFilter: 'blur(6px)',
      padding: '6px',
      borderRadius: '10px',
      border: '1px solid #ccc'
    });
    [btnToSettingsPaused, btnQuitTest].forEach(b=>{
      if (b) Object.assign(b.style, {pointerEvents:'auto', zIndex:'2147483647'});
    });
    dbg('ensureTopbarOnTop()', {
      topbarStyle: styleInfo(testTopbar), topbarRect: rectInfo(testTopbar),
      gearStyle: styleInfo(btnToSettingsPaused), gearRect: rectInfo(btnToSettingsPaused),
      xStyle: styleInfo(btnQuitTest), xRect: rectInfo(btnQuitTest),
    });
    hitTestLog(btnQuitTest || testTopbar);
  }
  function showTest() {
    dbg('showTest()');
    settingsView.classList.remove('active');
    testView.classList.add('active');
    ensureTopbarOnTop();
    stopTrainingAudio();
  }

  // ===== RENDER =====
  function renderGrid(kupu15) {
    dbg('renderGrid() with 15 kupu', kupu15);
    gridEl.innerHTML = '';
    statusEl.textContent = '';
    progressSummaryEl.textContent = '';
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
  }
  function renderSettingsPreview() {
    dbg('renderSettingsPreview()');
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
      // training tap
      cell.addEventListener('click', () => {
        dbg('training tap', kupu);
        playKupuOnly(kupu);
      });
      settingsPreview.appendChild(cell);
    });
    settingsStatus.textContent = '';
  }

  // ===== TRAINING PLAYBACK =====
  async function playKupuOnly(kupu) {
    stopTrainingAudio();
    if (AUDIO_CTX) {
      try {
        if (AUDIO_CTX.state !== 'running') await AUDIO_CTX.resume();
        const buf = await getAudioBuffer(kupuAudioURL(kupu));
        const t0 = AUDIO_CTX.currentTime + 0.02;
        const src = AUDIO_CTX.createBufferSource();
        src.buffer = buf;
        src.connect(AUDIO_CTX.destination);
        trainingSource = src;
        dbg('training WebAudio start', kupu);
        src.start(t0);
        const ms = Math.ceil((t0 + buf.duration - AUDIO_CTX.currentTime) * 1000);
        setTimeout(() => { if (trainingSource === src) trainingSource = null; }, ms + 20);
        return;
      } catch (e) { warn('training WebAudio failed, fallback', e); }
    }
    trainingAudio = new Audio(kupuAudioURL(kupu));
    trainingAudio.onended = () => { trainingAudio = null; };
    trainingAudio.play().catch((e)=>{ warn('training HTMLAudio failed', e); trainingAudio = null; });
  }

  // ===== TEST QUEUE =====
  function getRepeatCount() {
    const n = parseInt(repeatCountEl.value, 10);
    return isFinite(n) && n >= 1 && n <= 10 ? n : 3;
  }
  function buildTestQueue(kupu15, repeatCount) {
    const q = [];
    kupu15.forEach(k => { for (let i=0; i<repeatCount; i++) q.push(k); });
    const out = shuffle(q);
    dbg('buildTestQueue()', {repeatCount, total: out.length});
    return out;
  }

  // ===== PLAY TRIAL =====
  async function playPromptThenKupu(kupu, onDone) {
    clearTimersAndAudio();
    dbg('playPromptThenKupu()', kupu, {AUDIO_CTX: !!AUDIO_CTX});

    if (AUDIO_CTX) {
      try {
        if (AUDIO_CTX.state !== 'running') { await AUDIO_CTX.resume(); dbg('AUDIO_CTX resumed'); }
        const phraseURL = keiHeaTeURL();
        const kupuURL   = kupuAudioURL(kupu);
        const [phraseBuf, kupuBuf] = await Promise.all([getAudioBuffer(phraseURL), getAudioBuffer(kupuURL)]);
        const t0 = AUDIO_CTX.currentTime + 0.03;
        const s1 = AUDIO_CTX.createBufferSource();
        const s2 = AUDIO_CTX.createBufferSource();
        s1.buffer = phraseBuf; s2.buffer = kupuBuf;
        s1.connect(AUDIO_CTX.destination); s2.connect(AUDIO_CTX.destination);

        currentSources = [s1, s2];
        playing = true;

        s1.start(t0);
        s2.start(t0 + phraseBuf.duration);

        const msUntilKupu = Math.max(0, Math.ceil((t0 + phraseBuf.duration - AUDIO_CTX.currentTime) * 1000));
        dbg('kupu onset in ms', msUntilKupu);
        kupuOnsetTimer = setTimeout(() => {
          awaitingResponse = true;
          trialStartTime = Date.now();
          kupuOnsetTimer = null;
          dbg('awaitingResponse = true (WebAudio kupu onset)');
        }, msUntilKupu);

        const total = phraseBuf.duration + kupuBuf.duration;
        playbackDoneTimer = setTimeout(() => {
          playing = false;
          playbackDoneTimer = null;
          dbg('playback finished (WebAudio)');
          onDone && onDone();
        }, Math.ceil((t0 + total - AUDIO_CTX.currentTime) * 1000));

        return;
      } catch (e) {
        warn('WebAudio path failed, falling back', e);
        currentSources = [];
      }
    }

    // Fallback (file://)
    playing = true;
    htmlAudio1 = new Audio(keiHeaTeURL());
    htmlAudio1.onended = () => {
      htmlAudio2 = new Audio(kupuAudioURL(kupu));
      htmlAudio2.onplay  = () => {
        awaitingResponse = true;
        trialStartTime = Date.now();
        dbg('awaitingResponse = true (HTMLAudio kupu onplay)');
      };
      htmlAudio2.onended = () => {
        playing = false;
        htmlAudio1 = htmlAudio2 = null;
        dbg('playback finished (HTMLAudio)');
        onDone && onDone();
      };
      htmlAudio2.play().catch((e)=>{ warn('kupu play failed (HTMLAudio)', e); playing=false; htmlAudio1=htmlAudio2=null; onDone&&onDone();});
    };
    htmlAudio1.play().catch((e)=>{
      warn('phrase play failed (HTMLAudio), trying kupu alone', e);
      htmlAudio2 = new Audio(kupuAudioURL(kupu));
      htmlAudio2.onplay  = () => { awaitingResponse = true; trialStartTime = Date.now(); dbg('awaitingResponse = true (HTMLAudio kupu-only onplay)'); };
      htmlAudio2.onended = () => { playing=false; htmlAudio1=htmlAudio2=null; onDone&&onDone(); };
      htmlAudio2.play().catch((e2)=>{ warn('kupu-only play failed (HTMLAudio)', e2); playing=false; htmlAudio1=htmlAudio2=null; onDone&&onDone();});
    });
  }

  // ===== FLOW =====
  function updateProgressUI() {
    const showProg = showProgressEl && showProgressEl.checked;
    const t = `Trial ${trialIndex + 1} / ${testQueue.length} • Score: ${score}`;
    statusEl.textContent = showProg ? t : '';
    progressSummaryEl.textContent = '';
  }

  function startTest() {
    dbg('startTest()');
    currentListIdx = parseInt(listSel.value, 10) || 0;
    const kupu15 = lists[currentListIdx];
    const repeatCount = getRepeatCount();
    testQueue = buildTestQueue(kupu15, repeatCount);
    trialIndex = 0; score = 0; results = []; testInProgress = true; testPaused = false;
    if (downloadBtn) downloadBtn.disabled = true;
    if (AUDIO_CTX && AUDIO_CTX.state !== 'running') { AUDIO_CTX.resume().catch(()=>{}); }
    showTest();
    renderGrid(kupu15);
    updateProgressUI();
    nextTrial();
  }

  function pauseToSettings() {
    dbg('pauseToSettings()');
    if (!testInProgress) { showSettings(); return; }
    testPaused = true;
    clearTimersAndAudio();
    showSettings();
    startOrReturnBtn.textContent = 'Return to test';
    settingsHint.textContent = 'Test paused. Adjust display options, then return.';
  }

  function quitTest() {
    dbg('quitTest()');
    testInProgress = false;
    testPaused = false;
    clearTimersAndAudio();
    statusEl.textContent = '';
    progressSummaryEl.textContent = '';
    currentTarget = null;
    showSettings();
  }

  function nextTrial() {
    dbg('nextTrial()', {trialIndex, total: testQueue.length});
    if (!testInProgress || testPaused) return;
    if (trialIndex >= testQueue.length) {
      dbg('test finished -> end screen');
      endTestScreen();
      testInProgress = false;
      startOrReturnBtn.textContent = 'Start test';
      if (downloadBtn) downloadBtn.disabled = false;
      return;
    }
    currentTarget = testQueue[trialIndex];
    const showProg = showProgressEl && showProgressEl.checked;
    statusEl.textContent = showProg ? `Trial ${trialIndex + 1} / ${testQueue.length}` : '';
    awaitingResponse = false; trialStartTime = null;
    playPromptThenKupu(currentTarget, () => {});
  }

  function handleResponse(clickedKupu) {
    if (!testInProgress || testPaused) { dbg('handleResponse ignored (not in progress/paused)'); return; }
    if (!currentTarget || !awaitingResponse) { dbg('handleResponse ignored (awaitingResponse=false or no target)'); return; }

    awaitingResponse = false;
    const rt = trialStartTime ? (Date.now() - trialStartTime) : NaN;
    const ok = clickedKupu === currentTarget;
    if (ok) score++;
    dbg('handleResponse', {clickedKupu, currentTarget, ok, rt});

    const cells = Array.from(gridEl.children);
    const clicked = cells.find(c => {
      const lbl = c.querySelector('.label');
      return lbl && lbl.textContent === clickedKupu;
    });

    const showCorr = showCorrectEl && showCorrectEl.checked;
    if (clicked) {
      clicked.classList.remove('correct', 'incorrect', 'neutral');
      clicked.classList.add(showCorr ? (ok ? 'correct' : 'incorrect') : 'neutral');
    }
    if (showCorr) {
      statusEl.textContent = ok ? '✅ Correct' : `✖️ Incorrect (was ${currentTarget})`;
    } else if (showProgressEl && showProgressEl.checked) {
      statusEl.textContent = `Trial ${trialIndex + 1} / ${testQueue.length} • Score: ${score}`;
    } else {
      statusEl.textContent = '';
    }

    results.push({ trial: trialIndex + 1, list: currentListIdx + 1, target: currentTarget,
                   response: clickedKupu, correct: ok ? 1 : 0, rt_ms: rt, ts_iso: new Date().toISOString() });

    isiTimer = setTimeout(() => {
      cells.forEach(c => c.classList.remove('correct', 'incorrect', 'neutral'));
      trialIndex++;
      updateProgressUI();
      nextTrial();
    }, 1000);
  }

  // ===== END SCREEN & EXPORT =====
  function downloadResults(autoNoteEl) {
    if (!results.length) return null;
    const header = ['trial','list','target','response','correct','rt_ms','ts_iso'].join('\t') + '\n';
    const body = results.map(r => [r.trial,r.list,r.target,r.response,r.correct,r.ts_iso ? r.rt_ms : r.rt_ms, r.ts_iso].join('\t')).join('\n');
    const filename = `results_${new Date().toISOString().replace(/[:.]/g,'-')}.txt`;
    const blob = new Blob([header + body], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
    if (autoNoteEl) autoNoteEl.textContent = `Results saved to your Downloads folder as “${filename}”.`;
    dbg('downloadResults()', filename);
    return filename;
  }

  function endTestScreen() {
    clearTimersAndAudio();
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position:'fixed', inset:'0', background:'#fff', display:'flex', flexDirection:'column',
      alignItems:'center', justifyContent:'center', gap:'20px', padding:'24px',
      textAlign:'center', zIndex:'3000', cursor:'pointer'
    });
    const img = document.createElement('img');
    img.src = SUCCESS_IMG; img.alt = 'Thumbs up';
    Object.assign(img.style, {maxWidth:'70vw', maxHeight:'50vh', objectFit:'contain'});
    const phrase = document.createElement('div');
    phrase.textContent = randChoice(END_PHRASES);
    Object.assign(phrase.style, {fontSize:'clamp(1.6rem, 4vw, 2.4rem)', fontWeight:'700'});
    const note = document.createElement('div');
    Object.assign(note.style, {fontSize:'clamp(0.9rem, 2.2vw, 1.05rem)', color:'#444'});
    const tap = document.createElement('div');
    tap.textContent = 'Tap anywhere to return to home screen';
    Object.assign(tap.style, {fontSize:'clamp(0.95rem, 2.2vw, 1.1rem)', color:'#666'});

    overlay.append(img, phrase, note, tap);
    document.body.appendChild(overlay);

    downloadResults(note);

    overlay.addEventListener('click', () => {
      overlay.remove();
      quitTest();
    });
  }

  // ===== HOTKEYS & TOOLBAR =====
  function handleHotkeys(e) {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    const inFormField = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (inFormField) return;
    if (e.key === 'Escape') {
      dbg('hotkey: ESC');
      e.preventDefault(); quitTest();
    } else if (e.key === 's' || e.key === 'S') {
      dbg('hotkey: S');
      e.preventDefault(); pauseToSettings();
    }
  }

  // Capture-phase click logger + delegation for toolbar
  document.addEventListener('click', (e) => {
    if (!DEBUG) return;
    const path = (e.composedPath && e.composedPath()) || [];
    dbg('DOC CLICK (capture)', {
      target: describeEl(e.target),
      at: {x: e.clientX, y: e.clientY},
      path: path.slice(0, 6).map(describeEl)
    });
  }, true);

  function bindToolbarDelegation() {
    document.addEventListener('click', (e) => {
      const q = e.target && (e.target.closest && e.target.closest('#btnQuitTest'));
      if (q) {
        dbg('toolbar delegated: Quit clicked', describeEl(e.target));
        e.preventDefault(); e.stopPropagation(); quitTest(); return;
      }
      const s = e.target && (e.target.closest && e.target.closest('#btnToSettingsPaused'));
      if (s) {
        dbg('toolbar delegated: Settings clicked', describeEl(e.target));
        e.preventDefault(); e.stopPropagation(); pauseToSettings(); return;
      }
    }, true);
  }

  function bindToolbarDirect() {
    if (btnQuitTest) {
      btnQuitTest.addEventListener('click', (e) => { dbg('btnQuitTest direct click', describeEl(e.target)); e.preventDefault(); e.stopPropagation(); quitTest(); });
      btnQuitTest.addEventListener('pointerdown', (e) => dbg('btnQuitTest pointerdown', {target:describeEl(e.target)}));
    } else warn('btnQuitTest not found');
    if (btnToSettingsPaused) {
      btnToSettingsPaused.addEventListener('click', (e) => { dbg('btnToSettingsPaused direct click', describeEl(e.target)); e.preventDefault(); e.stopPropagation(); pauseToSettings(); });
      btnToSettingsPaused.addEventListener('pointerdown', (e) => dbg('btnToSettingsPaused pointerdown', {target:describeEl(e.target)}));
    } else warn('btnToSettingsPaused not found');
  }

  // ===== INIT =====
  async function init() {
    dbg('init() start');
    try {
      lists = await loadLists();
    } catch (e) {
      settingsStatus.textContent = `Error: ${e.message}`;
      err('loadLists failed', e);
      return;
    }
    dbg('lists loaded', {count: lists.length});

    // Fill list select
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

    // Settings handlers
    listSel.addEventListener('change', () => { currentListIdx = parseInt(listSel.value, 10) || 0; dbg('list changed', currentListIdx); renderSettingsPreview(); });
    showLabelsEl.addEventListener('change', () => { dbg('showLabels changed', showLabelsEl.checked); renderSettingsPreview(); });
    randomizeEl.addEventListener('change', () => { dbg('randomize changed', randomizeEl.checked); renderSettingsPreview(); });
    repeatCountEl.addEventListener('change', () => dbg('repeatCount changed', repeatCountEl.value));
    showProgressEl.addEventListener('change', () => { dbg('showProgress changed', showProgressEl.checked); if (testInProgress && !testPaused) updateProgressUI(); });
    showCorrectEl.addEventListener('change', () => dbg('showCorrect changed', showCorrectEl.checked));

    startOrReturnBtn.addEventListener('click', () => {
      dbg('startOrReturnBtn click', {testInProgress, testPaused});
      if (testInProgress && testPaused) {
        testPaused = false; showTest(); updateProgressUI(); nextTrial();
      } else if (!testInProgress) {
        startTest();
      } else {
        showTest();
      }
    });

    downloadBtn.addEventListener('click', () => { dbg('downloadBtn click'); downloadResults(); });

    // Toolbar bindings
    bindToolbarDirect();
    bindToolbarDelegation();
    ensureTopbarOnTop();
    window.addEventListener('resize', () => { dbg('resize'); ensureTopbarOnTop(); });

    // Hotkeys
    window.addEventListener('keydown', handleHotkeys, true);

    // Defensive grid delegation (still have per-cell handlers)
    gridEl.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const lbl = cell.querySelector('.label');
      if (!lbl) return;
      dbg('grid delegated click ->', lbl.textContent);
      handleResponse(lbl.textContent);
    });

    // Expose debug helpers
    window.KTT_DEBUG = {
      ping() {
        dbg('PING topbar', {
          exists: {topbar: !!testTopbar, gear: !!btnToSettingsPaused, quit: !!btnQuitTest},
          topbar: {style: styleInfo(testTopbar), rect: rectInfo(testTopbar)},
          gear:   {style: styleInfo(btnToSettingsPaused), rect: rectInfo(btnToSettingsPaused)},
          quit:   {style: styleInfo(btnQuitTest), rect: rectInfo(btnQuitTest)},
        });
        hitTestLog(btnQuitTest || testTopbar);
      }
    };

    dbg('init() done');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
