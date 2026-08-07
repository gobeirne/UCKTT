/* calibration.js — KTT output calibration and routed playback.
 *
 * Replicates the calibration mechanism of the UC_CVCV speech-audiometry tool.
 *
 *   The whole sound set is ILTASS-filtered and level-matched at source: every
 *   kupu (and the "Kei hea te…" carrier) sits at −22.5 LUFS momentary, and
 *   noise.mp3 sits at the same mean dB(A) as the mean momentary dB(A) of the
 *   kupu. So the meter reading taken on noise.mp3 at unity gain IS the
 *   unity-gain speech level, and the attenuation needed to land on a requested
 *   presentation level is a plain subtraction. SPEECH_NOISE_OFFSET_DB exists
 *   only so that, if the noise is ever re-rendered at a different level, this
 *   is the single number to change.
 *
 * Procedure: device volume to MAXIMUM → play noise.mp3 looped at unity → read
 * the sound level meter → type the dB(A) in. Everything after that is
 * attenuation below unity, so gain is never above 1.0 and can never clip.
 *
 * Both devices in a paired session calibrate themselves independently: the
 * profile is stored per-device in localStorage, and the responder ships its
 * profile to the clinician on pairing so the level control can be bounded by
 * whichever device is actually producing sound.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'kttCalibration';
  const NOISE_URL   = 'sounds/noise.mp3';

  /* 40 ms of true digital silence, used as the placeholder src when priming the
     media elements. It MUST be silent: priming plays each element to satisfy
     the iOS gesture requirement, and if that play ever fails to be paused
     cleanly, whatever is loaded will be heard at full level. A real asset here
     (the calibration noise, say) turns a routine priming glitch into a blast of
     noise in a child's ear. */
  const SILENT_WAV = 'data:audio/wav;base64,UklGRqQCAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YYACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  // noise.mp3 mean dB(A) − mean kupu momentary dB(A). Zero by construction for
  // the current sound set. Change here if the noise is ever re-rendered.
  const SPEECH_NOISE_OFFSET_DB = 0;

  const RANGE_SPAN_DB = 60;    // dial spans this far below the calibrated max
  const STEP_DB       = 5;
  const MAX_CLIP_MS   = 8000;  // playback watchdog

  let ctx     = null;
  let cal     = { measuredDbA: null, timestamp: null, isCalibrated: false };
  let calNode = null;                 // looping calibration noise source (unity)
  let testNode = null;                // looping test-level source (via presentation gain)
  let noiseBuffer = null;
  const els    = {};                  // role → HTMLAudioElement
  const graphs = new WeakMap();       // element → { source, gain, ear }
  const listeners = [];

  const log  = (...a) => (window.kttLog  ? window.kttLog('🎚', ...a) : console.log('[KTT cal]', ...a));
  const warn = (...a) => (window.kttWarn ? window.kttWarn('🎚', ...a) : console.warn('[KTT cal]', ...a));

  // ─── Audio context ────────────────────────────────────────────────────────

  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // Must be called from inside a user gesture. Sets the iOS audio session to
  // 'playback' (otherwise the context is silenced by the Ring/Silent switch and
  // its clock can freeze), then unlocks the context and both media elements.
  function prime() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (_) {}
    try {
      const c = ensureCtx();
      const b = c.createBuffer(1, 1, 22050);
      const s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
    } catch (e) { warn('context prime failed:', e.message); }

    ['carrier', 'kupu'].forEach(role => {
      const el = element(role);
      // The element must be stopped whether play() resolves OR rejects. An
      // interrupted play (AbortError is common on the first gesture, when both
      // elements start at once) previously left it running and then unmuted it.
      const settle = () => {
        try { el.pause(); el.currentTime = 0; } catch (_) {}
        el.muted = false;
      };
      try {
        el.muted = true;
        const p = el.play();
        if (p && p.then) p.then(settle, settle);
        else settle();
        setTimeout(settle, 400);   // last resort if neither path fires
      } catch (_) { settle(); }
    });
    log('primed — ctx:', ctx && ctx.state);
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  /* Route to the test ear(s) by muting the non-test channel and passing the
     test channel through UNCHANGED — no panning, no summing, no level
     compensation. StereoPannerNode is deliberately not used: its equal-power
     law sums both input channels into the output channel for a stereo source
     panned hard, giving up to +6 dB in that ear relative to the calibration
     path, so single-ear presentation would measure hot while the on-screen
     level read correctly.

     A mono source must behave as dual-mono, or single-ear presentation of a
     mono file would be silent in one ear: ChannelSplitterNode uses "discrete"
     interpretation, under which mono maps to ch0=signal, ch1=silence. Passing
     through a GainNode explicitly configured for a "speakers" up-mix to 2
     channels duplicates mono into L and R at unchanged level first. */
  function makeEarRouter(c, inputNode) {
    const stereoize = c.createGain();
    stereoize.channelCount = 2;
    stereoize.channelCountMode = 'explicit';
    stereoize.channelInterpretation = 'speakers';
    inputNode.connect(stereoize);

    const splitter  = c.createChannelSplitter(2);
    const leftGain  = c.createGain();
    const rightGain = c.createGain();
    const merger    = c.createChannelMerger(2);
    stereoize.connect(splitter);
    splitter.connect(leftGain, 0).connect(merger, 0, 0);
    splitter.connect(rightGain, 1).connect(merger, 0, 1);
    merger.connect(c.destination);

    // 'binaural' and 'soundfield' both feed two channels at unchanged level;
    // they are kept distinct so the record says which was actually used.
    const setEar = ear => {
      const both = (ear === 'binaural' || ear === 'soundfield' || !ear);
      leftGain.gain.value  = (both || ear === 'left')  ? 1 : 0;
      rightGain.gain.value = (both || ear === 'right') ? 1 : 0;
    };
    setEar('binaural');
    return { setEar };
  }

  function element(role) {
    if (!els[role]) {
      const a = new Audio();
      a.preload = 'auto';
      a.src = SILENT_WAV;     // silent by construction — see SILENT_WAV above
      els[role] = a;
    }
    return els[role];
  }

  // createMediaElementSource may only be called once per element, so the graph
  // is built once and the element's src swapped per presentation. This also
  // preserves the iOS unlock, which belongs to the element, not the src.
  function graphFor(el) {
    let g = graphs.get(el);
    if (g) return g;
    const c = ensureCtx();
    const source = c.createMediaElementSource(el);
    const gain   = c.createGain();
    source.connect(gain);
    g = { source, gain, ear: makeEarRouter(c, gain) };
    graphs.set(el, g);
    return g;
  }

  // ─── Level maths ──────────────────────────────────────────────────────────

  function gainForLevel(levelDbA) {
    if (cal.isCalibrated && cal.measuredDbA !== null) {
      const unityGainSpeechDbA = Number(cal.measuredDbA) + SPEECH_NOISE_OFFSET_DB;
      const attenuation = unityGainSpeechDbA - Number(levelDbA);
      return Math.pow(10, -attenuation / 20);
    }
    // Uncalibrated: the level control is a dB FS attenuator, unity at 0.
    const fs = Math.min(0, Number(levelDbA) || 0);
    return Math.pow(10, fs / 20);
  }

  function maxLevel() { return cal.isCalibrated ? Number(cal.measuredDbA) : 0; }
  function minLevel() {
    return cal.isCalibrated
      ? Math.floor(Number(cal.measuredDbA) / STEP_DB) * STEP_DB - RANGE_SPAN_DB
      : -RANGE_SPAN_DB;
  }
  function unit() { return cal.isCalibrated ? 'dB A' : 'dB FS'; }

  // Snap to 5 dB, except within a tolerance of the exact calibrated maximum,
  // which stays reachable so full output is always available.
  function snapLevel(v) {
    const max = maxLevel();
    const n = Number(v);
    if (!isFinite(n)) return max;
    if (Math.abs(n - max) <= 0.25) return max;
    return Math.min(max, Math.max(minLevel(), Math.round(n / STEP_DB) * STEP_DB));
  }

  // ─── Playback ─────────────────────────────────────────────────────────────

  function play(role, url, opts) {
    const o = opts || {};
    const el = element(role);
    return new Promise(resolve => {
      let settled = false, watchdog = null;
      const done = ok => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        el.onended = el.onerror = null;
        resolve(ok);
      };
      try {
        const g = graphFor(el);
        g.gain.gain.value = gainForLevel(o.level);
        g.ear.setEar(o.ear || 'binaural');

        el.onended = () => done(true);
        el.onerror = () => { warn('media error:', url); done(false); };
        if (!el.src.endsWith(url)) el.src = url;
        el.currentTime = 0;
        watchdog = setTimeout(() => { warn('watchdog fired for', url); done(true); }, MAX_CLIP_MS);
        const p = el.play();
        if (p && p.catch) p.catch(err => { warn('play rejected:', err.message); done(false); });
      } catch (e) {
        warn('play threw:', e.message);
        done(false);
      }
    });
  }

  function stopAll() {
    Object.values(els).forEach(a => { try { a.pause(); a.currentTime = 0; } catch (_) {} });
    stopTest();
  }

  // ─── Calibration noise ────────────────────────────────────────────────────

  async function startNoise() {
    const c = ensureCtx();
    if (!noiseBuffer) {
      const resp = await fetch(NOISE_URL);
      if (!resp.ok) throw new Error(`${NOISE_URL} not found`);
      noiseBuffer = await c.decodeAudioData(await resp.arrayBuffer());
    }
    stopNoise();
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    // Straight to destination at unity — no gain, no ear routing. This is the
    // reference path the measured figure describes.
    src.connect(c.destination);
    src.start();
    calNode = src;
    log('calibration noise playing at unity');
  }

  function stopNoise() {
    if (calNode) { try { calNode.stop(); } catch (_) {} calNode = null; }
  }

  function isNoisePlaying() { return !!calNode; }

  /* Test level: play the same noise back through the *presentation* gain path
     at a chosen level, so the clinician can put the meter on it and confirm
     the app is delivering what the dial claims. Routed exactly like a real
     stimulus — gain from the profile, ear routing applied — because a check
     that bypassed the presentation path would prove nothing about it. */
  async function startTest(levelDbA, ear) {
    const c = ensureCtx();
    if (!noiseBuffer) {
      const resp = await fetch(NOISE_URL);
      if (!resp.ok) throw new Error(`${NOISE_URL} not found`);
      noiseBuffer = await c.decodeAudioData(await resp.arrayBuffer());
    }
    stopTest();
    stopNoise();
    const src  = c.createBufferSource();
    const gain = c.createGain();
    src.buffer = noiseBuffer;
    src.loop = true;
    gain.gain.value = gainForLevel(levelDbA);
    src.connect(gain);
    makeEarRouter(c, gain).setEar(ear || 'binaural');
    src.start();
    testNode = src;
    log(`test level playing at ${levelDbA} ${unit()} (gain ${gain.gain.value.toFixed(5)})`);
  }

  function stopTest() {
    if (testNode) { try { testNode.stop(); } catch (_) {} testNode = null; }
  }

  function isTestPlaying() { return !!testNode; }

  // ─── Profile ──────────────────────────────────────────────────────────────

  function applyLevel(level, timestamp) {
    cal.measuredDbA  = Number(level);
    cal.timestamp    = timestamp || new Date().toISOString();
    cal.isCalibrated = true;
    save();
    notify();
    log(`calibrated to ${cal.measuredDbA} dB A`);
  }

  function clear() {
    cal = { measuredDbA: null, timestamp: null, isCalibrated: false };
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    notify();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        level: cal.measuredDbA, timestamp: cal.timestamp,
      }));
    } catch (_) {}
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && data.level != null) {
        cal.measuredDbA  = Number(data.level);
        cal.timestamp    = data.timestamp || null;
        cal.isCalibrated = true;
        log(`restored calibration: ${cal.measuredDbA} dB A from ${cal.timestamp || 'earlier'}`);
      }
    } catch (_) {}
  }

  function profile() {
    return {
      isCalibrated: cal.isCalibrated,
      measuredDbA: cal.measuredDbA,
      timestamp: cal.timestamp,
      maxLevel: maxLevel(),
      minLevel: minLevel(),
      unit: unit(),
      offsetDb: SPEECH_NOISE_OFFSET_DB,
      ua: navigator.userAgent,
    };
  }

  function summary(p) {
    const c = p || profile();
    if (!c.isCalibrated) return 'Uncalibrated (dB FS, unity = 0)';
    const when = c.timestamp
      ? new Date(c.timestamp).toLocaleString('en-NZ', { dateStyle: 'short', timeStyle: 'short' })
      : 'unknown date';
    return `${c.measuredDbA} dB A max, calibrated ${when} — device volume must be at maximum`;
  }

  function onChange(fn) { listeners.push(fn); }
  function notify() { listeners.forEach(fn => { try { fn(profile()); } catch (_) {} }); }

  load();

  window.kttCal = {
    prime, ensureCtx,
    play, stopAll,
    startNoise, stopNoise, isNoisePlaying,
    startTest, stopTest, isTestPlaying,
    applyLevel, clear,
    gainForLevel, maxLevel, minLevel, snapLevel, unit,
    isCalibrated: () => cal.isCalibrated,
    profile, summary, onChange,
    STEP_DB, SPEECH_NOISE_OFFSET_DB, NOISE_URL, SILENT_WAV,
  };
})();
