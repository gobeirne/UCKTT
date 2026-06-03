// preload-ktt.js — runtime preloader + cache warmup (macron-safe, single-count progress)

const CACHE_NAME = 'ktt-precache-v3'; // match sw.js

export async function preloadAllAssets(onProgress) {
  const scope = location.origin + location.pathname.replace(/[^/]*$/, '');
  const listURL = scope + 'preloadfilelist.txt';

  // 1) Fetch list
  let rawList = [];
  try {
    const res = await fetch(listURL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = await res.text();
    rawList = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (e) {
    console.warn('Preloader: failed to fetch preloadfilelist.txt', e);
    return { ok:false, count:0 };
  }

  // 2) Normalize + encode segments; fix folder case if needed; de-duplicate
  const normalizeToURL = (p) => {
    const fixed = p
      .replace(/^images\//i, 'Images/')   // adjust if your repo uses capital I
      .replace(/^sounds\//i, 'sounds/');
    const segs = fixed.split('/').map(encodeURIComponent).join('/');
    return scope + segs;
  };

  const urls = Array.from(new Set(rawList.map(normalizeToURL))); // de-dupe

  // 3) Warm Service Worker cache first (no progress increments here)
  onProgress && onProgress({ done: 0, total: urls.length, phase: 'warming-cache' });
  if ('caches' in window) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const chunk = 32;
      for (let i = 0; i < urls.length; i += chunk) {
        const slice = urls.slice(i, i + chunk);
        try { await cache.addAll(slice); } catch (_) { /* continue even if some 404 */ }
      }
    } catch (e) {
      console.warn('Preloader: cache warm failed', e);
    }
  }

  // 4) Decode assets so first use is instant; progress increments EXACTLY once per asset
  let done = 0;
  const step = () => { done++; onProgress && onProgress({ done, total: urls.length, phase: 'decoding' }); };

  const tasks = urls.map(u => () => {
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(u)) return loadImage(u, step);
    if (/\.(mp3|wav|ogg)$/i.test(u))           return loadAudio(u, step);
    step(); return Promise.resolve(); // non-media: just count it
  });

  await runWithConcurrency(tasks, 8);
  return { ok:true, count: urls.length };
}

function loadImage(url, step) {
  return new Promise((resolve) => {
    let settled = false;
    const fin = () => {
      if (settled) return;
      settled = true;
      step();
      resolve();
    };
    const i = new Image();
    const t = setTimeout(fin, 8000);
    i.onload = () => { clearTimeout(t); fin(); };
    i.onerror = () => { clearTimeout(t); fin(); };
    i.src = url;
    // On modern browsers, decode() often fires after onload; guard ensures single step.
    if (i.decode) i.decode().then(() => {}).catch(() => {}); // no extra fin() here
  });
}

function loadAudio(url, step) {
  return new Promise((resolve) => {
    let settled = false;
    const fin = () => {
      if (settled) return;
      settled = true;
      step();
      resolve();
    };
    const a = new Audio();
    a.preload = 'auto';
    const t = setTimeout(fin, 10000);
    // Any of these may fire first; guard makes it count once.
    ['canplaythrough','loadeddata','loadedmetadata','error','stalled'].forEach(ev => {
      a.addEventListener(ev, () => { clearTimeout(t); fin(); }, { once: true });
    });
    a.src = url;
    try { a.load(); } catch (_) {}
  });
}

async function runWithConcurrency(fns, limit = 8) {
  let i = 0;
  const max = Math.min(limit, fns.length);
  const workers = Array.from({ length: max }, async () => {
    while (i < fns.length) {
      const idx = i++;
      try { await fns[idx](); } catch (_) { /* continue */ }
    }
  });
  await Promise.all(workers);
}

/* Convenience: wire a button + label */
export function wirePreloadUI(buttonEl, labelEl) {
  if (!buttonEl) return;
  buttonEl.addEventListener('click', async () => {
    buttonEl.disabled = true;
    if (labelEl) labelEl.textContent = 'Warming cache…';
    const res = await preloadAllAssets(({done,total,phase}) => {
      if (!labelEl) return;
      labelEl.textContent = phase === 'warming-cache'
        ? 'Warming cache…'
        : `Caching ${done} / ${total}…`;
    });
    if (labelEl) labelEl.textContent = res.ok
      ? `Ready offline (${res.count} items cached)`
      : 'Preload failed (check console)';
    buttonEl.disabled = false;
  });
}
