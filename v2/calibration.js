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
  /* Calibration noise. A .wav is preferred and probed first: it carries no
     encoder padding, so it loops seamlessly and decodes to exactly the PCM that
     was measured when the file was made. The .mp3 fallback works but needs the
     loop trim below. */
  const NOISE_CANDIDATES = ['sounds/noise.wav', 'sounds/noise.mp3'];
  let   NOISE_URL   = NOISE_CANDIDATES[1];   // resolved on first use

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

  const GATE_RAMP_MS  = 8;     // short ramp so opening/closing the gate doesn't click
  const MAX_GATE_MS   = 15000; // ceiling for a single stimulus presentation
  /* Sustained sources — the calibration noise and the test tone — are held open
     deliberately by a clinician with a visible Stop button in front of them, and
     a measurement can take minutes. Applying the stimulus ceiling to them cut
     the noise off mid-measurement, which is worse than useless: it invites a
     reading taken from a signal that stopped part-way through. They still get a
     ceiling, just one long enough to be a runaway guard rather than a timer. */
  const MAX_SUSTAINED_MS = 20 * 60 * 1000;
  const LOOP_TRIM_S   = 0.03;  // skip mp3 encoder padding at both ends of the loop
  const RANGE_SPAN_DB = 60;    // dial spans this far below the calibrated max
  const STEP_DB       = 5;
  const MAX_CLIP_MS   = 8000;  // playback watchdog

  let ctx     = null;
  let master  = null;          // every sound-producing path terminates here
  let gateHolders = 0;         // >0 = a deliberate presentation is in progress
  let gateWatchdog = null;
  let gateDeadline = 0;
  let cal     = { measuredDbA: null, timestamp: null, isCalibrated: false };
  let calNode = null;                 // looping calibration noise source (unity)
  let testNode = null;                // looping test-level source (via presentation gain)
  let calGate  = null;
  let testGate = null;
  let noiseBuffer = null;
  const els    = {};                  // role → HTMLAudioElement
  const graphs = new WeakMap();       // element → { source, gain, ear }
  const listeners = [];

  const log  = (...a) => (window.kttLog  ? window.kttLog('🎚', ...a) : console.log('[KTT cal]', ...a));
  const warn = (...a) => (window.kttWarn ? window.kttWarn('🎚', ...a) : console.warn('[KTT cal]', ...a));

  // ─── Audio context ────────────────────────────────────────────────────────

  /* Master gate.
     Every path that can make a sound — stimuli, calibration noise, the test
     tone, even the silent priming plays — terminates at this one gain node, and
     it sits at ZERO unless a deliberate presentation has opened it. This is a
     structural guarantee rather than a behavioural one: no future code path,
     error branch, watchdog or half-finished refactor can produce audible output
     without going through openGate(), because there is no other route to the
     speaker. The device may be strapped to an audiometer feeding a child's ear,
     so "we remembered to pause it" is not a strong enough property. */
  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function output() { ensureCtx(); return master; }

  function rampTo(value, ms) {
    if (!master) return;
    const t = ctx.currentTime;
    try {
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(value, t + (ms || GATE_RAMP_MS) / 1000);
    } catch (_) {
      master.gain.value = value;
    }
  }

  // Acquire the gate for a presentation. Reference-counted, because a carrier
  // and a kupu are two sources within one presentation and the gate must not
  // slam shut between them.
  function openGate(reason, opts) {
    ensureCtx();
    const maxMs = (opts && opts.maxMs) || MAX_GATE_MS;
    gateHolders++;
    if (gateHolders === 1) {
      rampTo(1, GATE_RAMP_MS);
      window.kttLogs?.event('gate-open', { reason, maxMs }, `Audio gate opened: ${reason}`);
    }
    // The watchdog tracks the longest-lived holder, so a short stimulus opening
    // alongside a sustained tone can't shorten the tone's allowance.
    gateDeadline = Math.max(gateDeadline || 0, Date.now() + maxMs);
    clearTimeout(gateWatchdog);
    gateWatchdog = setTimeout(() => {
      warn(`gate watchdog: forcing closed after ${maxMs} ms (${reason})`);
      forceCloseGate('watchdog');
    }, gateDeadline - Date.now());
    return { reason, released: false };
  }

  function closeGate(token) {
    if (!token || token.released) return;
    token.released = true;
    gateHolders = Math.max(0, gateHolders - 1);
    if (gateHolders === 0) {
      clearTimeout(gateWatchdog);
      gateDeadline = 0;
      rampTo(0, GATE_RAMP_MS * 2);
    }
  }

  // Slam shut regardless of outstanding holders, and silence every source.
  function forceCloseGate(why) {
    gateHolders = 0;
    gateDeadline = 0;
    clearTimeout(gateWatchdog);
    if (master) { try { master.gain.cancelScheduledValues(ctx.currentTime); } catch (_) {} master.gain.value = 0; }
    window.kttLogs?.event('gate-close', { why }, `Audio gate forced shut: ${why}`);
  }

  function gateIsOpen() { return gateHolders > 0; }

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
      s.buffer = b; s.connect(output()); s.start(0);   // silent, and gated anyway
    } catch (e) { warn('context prime failed:', e.message); }

    ['carrier', 'kupu'].forEach(role => {
      const el = element(role);
      // Build the graph BEFORE priming, so the priming play goes through the
      // (closed) master gate rather than straight out of the element. Combined
      // with the silent placeholder, priming is inaudible two ways over.
      try { graphFor(el); } catch (e) { warn('graph build failed during prime:', e.message); }
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
    merger.connect(output());

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
      const gate = openGate(`stimulus:${role}`,
                            o.loop ? { maxMs: MAX_SUSTAINED_MS } : undefined);
      const done = ok => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        closeGate(gate);
        el.onended = el.onerror = null;
        resolve(ok);
      };
      try {
        const g = graphFor(el);
        g.gain.gain.value = gainForLevel(o.level);
        g.ear.setEar(o.ear || 'binaural');

        el.loop = !!o.loop;
        el.onended = () => { if (!el.loop) done(true); };
        el.onerror = () => { warn('media error:', url); done(false); };
        if (!el.src.endsWith(url)) el.src = url;
        el.currentTime = 0;
        // A looped test tone is stopped by the clinician, not by the clip ending,
        // so it gets the sustained ceiling rather than the stimulus one.
        watchdog = setTimeout(() => { warn('watchdog fired for', url); done(true); },
                              o.loop ? MAX_SUSTAINED_MS : MAX_CLIP_MS);
        const p = el.play();
        if (p && p.catch) p.catch(err => { warn('play rejected:', err.message); done(false); });
      } catch (e) {
        warn('play threw:', e.message);
        done(false);
      }
    });
  }

  // Panic stop: shut the gate first (instant silence regardless of what is
  // running), then tidy up the sources behind it.
  function stopAll() {
    forceCloseGate('stopAll');
    Object.values(els).forEach(a => { try { a.pause(); a.loop = false; a.currentTime = 0; } catch (_) {} });
    if (testNode) { try { testNode.stop(); } catch (_) {} testNode = null; }
    if (calNode)  { try { calNode.stop();  } catch (_) {} calNode  = null; }
    calGate = testGate = null;
  }

  // ─── Calibration noise ────────────────────────────────────────────────────

  async function loadNoise() {
    if (noiseBuffer) return noiseBuffer;
    const c = ensureCtx();
    let lastErr = null;
    for (const url of NOISE_CANDIDATES) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) { lastErr = new Error(`${url}: ${resp.status}`); continue; }
        noiseBuffer = await c.decodeAudioData(await resp.arrayBuffer());
        NOISE_URL = url;
        log(`calibration noise: ${url} (${noiseBuffer.duration.toFixed(2)}s, ` +
            `${noiseBuffer.numberOfChannels}ch @ ${noiseBuffer.sampleRate} Hz)`);
        return noiseBuffer;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no calibration noise file found');
  }

  async function startNoise() {
    const c = ensureCtx();
    await loadNoise();
    stopNoise();
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    applyLoopTrim(src);
    /* Unity gain, but through the SAME gain node and ear router the stimuli use.
       Previously this ran straight to the output, which meant the path being
       measured was not quite the path being used. The level is identical either
       way — a mono buffer up-mixes to dual-mono at the destination just as the
       router does — but "identical by argument" is weaker than "identical by
       construction", and calibration is the wrong place to accept the weaker one. */
    const gain = c.createGain();
    gain.gain.value = 1.0;
    src.connect(gain);
    makeEarRouter(c, gain).setEar('binaural');
    src.start();
    calNode = src;
    calGate = openGate('calibration-noise', { maxMs: MAX_SUSTAINED_MS });
    log('calibration noise playing at unity');
  }

  /* A .wav needs no trim; an .mp3 decodes with a few ms of encoder padding at
     each end, and looping across that splices silence into continuous noise —
     the click at the loop point. */
  function applyLoopTrim(src) {
    const isMp3 = /\.mp3$/i.test(NOISE_URL);
    if (!isMp3 || !noiseBuffer || noiseBuffer.duration <= LOOP_TRIM_S * 4) return;
    src.loopStart = LOOP_TRIM_S;
    src.loopEnd   = noiseBuffer.duration - LOOP_TRIM_S;
  }

  function stopNoise() {
    if (calNode) { try { calNode.stop(); } catch (_) {} calNode = null; }
    closeGate(calGate); calGate = null;
  }

  function isNoisePlaying() { return !!calNode; }

  /* Test level: play the same noise back through the *presentation* gain path
     at a chosen level, so the clinician can put the meter on it and confirm
     the app is delivering what the dial claims. Routed exactly like a real
     stimulus — gain from the profile, ear routing applied — because a check
     that bypassed the presentation path would prove nothing about it. */
  async function startTest(levelDbA, ear) {
    const c = ensureCtx();
    await loadNoise();
    stopTest();
    stopNoise();
    const src  = c.createBufferSource();
    const gain = c.createGain();
    src.buffer = noiseBuffer;
    src.loop = true;
    applyLoopTrim(src);
    gain.gain.value = gainForLevel(levelDbA);
    src.connect(gain);
    makeEarRouter(c, gain).setEar(ear || 'binaural');
    src.start();
    testNode = src;
    testGate = openGate('test-level', { maxMs: MAX_SUSTAINED_MS });
    log(`test level playing at ${levelDbA} ${unit()} (gain ${gain.gain.value.toFixed(5)})`);
  }

  function stopTest() {
    if (testNode) { try { testNode.stop(); } catch (_) {} testNode = null; }
    closeGate(testGate); testGate = null;
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
    openGate, closeGate, forceCloseGate, gateIsOpen,
    loadNoise, noiseURL: () => NOISE_URL,
    STEP_DB, SPEECH_NOISE_OFFSET_DB, SILENT_WAV,
    MAX_GATE_MS, MAX_SUSTAINED_MS, NOISE_CANDIDATES,
  };
})();
