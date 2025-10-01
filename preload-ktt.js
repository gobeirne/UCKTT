// preload-ktt.js — runtime preloader + cache warmup (macron-safe)
export async function preloadAllAssets(onProgress) {
  const scope = location.origin + location.pathname.replace(/[^/]*$/, '');
  const listURL = scope + 'preloadfilelist.txt';
  let rawList = [];

  // load the list
  try {
    const res = await fetch(listURL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = await res.text();
    rawList = txt.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  } catch (e) {
    console.warn('Preloader: failed to fetch preloadfilelist.txt', e);
    return { ok:false, count:0 };
  }

  // normalize & encode segments; fix folder case if needed
  const toURL = (p) => {
    const fixed = p.replace(/^images\//, 'Images/').replace(/^sounds\//, 'sounds/');
    const segs  = fixed.split('/').map(encodeURIComponent).join('/');
    return scope + segs;
  };

  const assets = rawList.map(toURL);
  const total = assets.length;
  let done = 0;
  const step = () => { done++; onProgress && onProgress({ done, total }); };

  // Warm the SW cache as well (safe to call even before SW is ready)
  if ('caches' in window) {
    try {
      const c = await caches.open('ktt-precache-v3');
      // addAll in chunks to avoid large promise rejections on mobile
      const chunk = 24;
      for (let i=0;i<assets.length;i+=chunk) {
        const part = assets.slice(i, i+chunk);
        try { await c.addAll(part); } catch (e) { /* continue */ }
      }
    } catch (e) {
      console.warn('Preloader: cache warm failed', e);
    }
  }

  // Fire actual decode loads so image/audio decoders are primed
  const img = (src) => new Promise((resolve) => {
    const i = new Image();
    const fin = () => { step(); resolve(); };
    const t = setTimeout(fin, 7000);
    i.onload = () => { clearTimeout(t); fin(); };
    i.onerror = () => { clearTimeout(t); fin(); };
    i.src = src;
    if (i.decode) i.decode().then(fin).catch(fin);
  });

  const aud = (src) => new Promise((resolve) => {
    const a = new Audio();
    const fin = () => { step(); resolve(); };
    const t = setTimeout(fin, 8000);
    ['canplaythrough','loadeddata','loadedmetadata','error'].forEach(ev => a.addEventListener(ev, () => { clearTimeout(t); fin(); }, { once:true }));
    a.preload = 'auto'; a.src = src;
    try { a.load(); } catch(_) {}
  });

  const tasks = assets.map(u => () => /\.(png|jpg)$/i.test(u) ? img(u)
                                  : /\.mp3$/i.test(u) ? aud(u)
                                  : (step(), Promise.resolve()));

  await runWithConcurrency(tasks, 8);
  return { ok:true, count: total };
}

async function runWithConcurrency(fns, limit = 8) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, fns.length) }, async () => {
    while (i < fns.length) await fns[i++]();
  });
  await Promise.all(workers);
}

// Optional: little helper to wire a button + label
export function wirePreloadUI(buttonEl, labelEl) {
  if (!buttonEl) return;
  buttonEl.addEventListener('click', async () => {
    buttonEl.disabled = true;
    if (labelEl) labelEl.textContent = 'Starting preload…';
    const res = await preloadAllAssets(({done,total}) => {
      if (labelEl) labelEl.textContent = `Caching ${done} / ${total}…`;
    });
    if (labelEl) labelEl.textContent = res.ok ? `Ready offline (${res.count} items cached)` : 'Preload failed (check console)';
    buttonEl.disabled = false;
  });
}
