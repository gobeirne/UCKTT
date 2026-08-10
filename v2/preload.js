/* preload.js — warm the cache for every image and sound before a clinic starts.
 *
 * Modelled on the UC4AFC preloader: read preloadfilelist.txt, fetch everything
 * with modest concurrency, and never let one bad asset stall the run — each
 * item resolves on success, error OR timeout, so a missing file costs a warning
 * rather than a hung progress bar.
 *
 * Deliberately does NOT decode audio here. At preload time the AudioContext is
 * still suspended (it only unlocks on a user gesture), and decodeAudioData does
 * not reliably complete on a suspended context. Decoding stays lazy; this only
 * warms the HTTP cache, which is what the service worker then serves from.
 */
(function () {
  'use strict';

  const LIST_URL    = 'preloadfilelist.txt';
  const CONCURRENCY = 8;         // modest: this runs on phones too
  const TIMEOUT_MS  = 10000;
  const DONE_KEY    = 'kttPreloadedVersion';

  let running = false;
  const listeners = [];

  const log  = (...a) => (window.kttLog  ? window.kttLog('📦', ...a) : console.log('[KTT preload]', ...a));
  const warn = (...a) => (window.kttWarn ? window.kttWarn('📦', ...a) : console.warn('[KTT preload]', ...a));

  function onProgress(fn) { listeners.push(fn); }
  function emit(state) { listeners.forEach(fn => { try { fn(state); } catch (_) {} }); }

  async function fetchList() {
    const res = await fetch(LIST_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${LIST_URL}: ${res.status}`);
    const raw = await res.text();
    return raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  }

  function preloadImage(src) {
    return new Promise(resolve => {
      const img = new Image();
      let settled = false;
      const done = ok => { if (!settled) { settled = true; clearTimeout(t); resolve(ok); } };
      const t = setTimeout(() => { warn('image timed out:', src); done(false); }, TIMEOUT_MS);
      img.onload  = () => done(true);
      img.onerror = () => { warn('image failed:', src); done(false); };
      img.src = src;
      // decode() often settles earlier and more reliably than onload
      if (img.decode) img.decode().then(() => done(true)).catch(() => done(false));
    });
  }

  function preloadSound(src) {
    return new Promise(resolve => {
      const a = new Audio();
      let settled = false;
      const done = ok => { if (!settled) { settled = true; clearTimeout(t); resolve(ok); } };
      const t = setTimeout(() => { warn('sound timed out:', src); done(false); }, TIMEOUT_MS);
      ['canplaythrough', 'loadeddata', 'loadedmetadata'].forEach(ev =>
        a.addEventListener(ev, () => done(true), { once: true }));
      a.addEventListener('error', () => { warn('sound failed:', src); done(false); }, { once: true });
      a.preload = 'auto';
      a.src = src;
      try { a.load(); } catch (_) {}   // iOS needs the explicit kick
    });
  }

  function preloadOne(src) {
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(src)) return preloadImage(src);
    if (/\.(mp3|wav|ogg|m4a)$/i.test(src))        return preloadSound(src);
    return fetch(src).then(r => r.ok).catch(() => false);
  }

  async function runWithConcurrency(items, limit, step) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const src = items[i++];
        const ok = await preloadOne(src);
        step(src, ok);
      }
    });
    await Promise.all(workers);
  }

  async function run(opts) {
    if (running) return null;
    running = true;
    const o = opts || {};
    let list;
    try {
      list = await fetchList();
    } catch (e) {
      warn('could not read the asset list:', e.message);
      running = false;
      emit({ phase: 'error', message: e.message });
      return null;
    }

    let done = 0, failed = 0;
    const failures = [];
    const total = list.length;
    log(`preloading ${total} assets…`);
    emit({ phase: 'start', total, done: 0, failed: 0 });

    const t0 = performance.now();
    await runWithConcurrency(list, o.concurrency || CONCURRENCY, (src, ok) => {
      done++;
      if (!ok) { failed++; failures.push(src); }
      emit({ phase: 'progress', total, done, failed, current: src });
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);

    // Failures are reported rather than swallowed: a clinic needs to know that
    // an asset is missing BEFORE a child is sitting in the booth.
    if (failed) warn(`preload finished with ${failed} failure(s):`, failures.slice(0, 12));
    log(`preloaded ${done - failed}/${total} assets in ${secs}s`);

    try {
      localStorage.setItem(DONE_KEY, JSON.stringify({
        version: String(o.version || ''), at: new Date().toISOString(),
        total, failed,
      }));
    } catch (_) {}
    running = false;
    const result = { total, done, failed, failures, seconds: Number(secs) };
    emit({ phase: 'done', ...result });
    return result;
  }

  /* Runs on every load. The whole set is a few MB and the service worker serves
     the media cache-first, so a repeat run is a cache walk rather than a
     download — while the version-gated behaviour it replaced meant a device that
     had preloaded once never picked up assets added by a later deploy. Kept on
     the idle callback so it never competes with first paint.

     `version` is now recorded rather than used as a gate; kttPreloadedVersion
     is a diagnostic ("what did this device last warm, and when"). */
  function autoRun(version) {
    const start = () => run({ version });
    if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 4000 });
    else setTimeout(start, 2500);
  }

  window.kttPreload = { run, autoRun, onProgress, isRunning: () => running };
})();
