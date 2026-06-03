/* sw.js — KTT PWA with precache list + sane fetch strategies */

const CACHE_NAME = 'ktt-precache-v3';

// App shell (always cached)
const APP_SHELL = [
  './index.html',
  './fifteenAFC.html',            // include in case you land here directly
  './fifteenAFC.js',
  './manifest.webmanifest',
  './Images/pai.png',
  './UClogo.png',
  './icon-192.png',
  './icon-512.png'
];

// Best-effort optional items
const OPTIONAL = [
  './kupu_lists.tsv',
  './sounds/Kei_hea_te_01.mp3'    // preface audio
];

// Where the preload list lives (one path per line)
const PRELOAD_LIST = 'preloadfilelist.txt';

// --- Install: precache shell + preload list (if present) ---
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // 1) App shell (must-have)
    await cache.addAll(APP_SHELL);

    // 2) Optional files (best-effort)
    for (const url of OPTIONAL) {
      try { await cache.add(url); } catch (_) {}
    }

    // 3) Preload list (if present)
    try {
      const scopeURL = new URL(self.registration.scope);
      const res = await fetch(new URL(PRELOAD_LIST, scopeURL), { cache: 'no-store' });
      if (res.ok) {
        const raw = await res.text();
        const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

        // Normalize + encode each path segment (macrons/spaces safe)
        const urls = lines.map((p) => {
          // Adjust folder case if your repo uses 'Images' but list says 'images'
          const fixed = p.replace(/^images\//, 'Images/').replace(/^sounds\//, 'sounds/');
          const segs = fixed.split('/').map(encodeURIComponent).join('/');
          return new URL(segs, scopeURL).toString();
        });

        // Add in small chunks to be nicer to mobile
        const chunk = 32;
        for (let i = 0; i < urls.length; i += chunk) {
          const part = urls.slice(i, i + chunk);
          try { await cache.addAll(part); } catch (_) { /* continue */ }
        }

        // Optional log (visible in Application → Service Workers)
        console.log(`SW: precached ${urls.length} assets from ${PRELOAD_LIST}`);
      }
    } catch (err) {
      console.warn('SW: no preload list or failed to precache it', err);
    }

    await self.skipWaiting();
  })());
});

// --- Activate: clean up old caches, take control ---
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CACHE_NAME]);
    const names = await caches.keys();
    await Promise.all(names.map(n => keep.has(n) ? null : caches.delete(n)));
    await self.clients.claim();
  })());
});

// --- Fetch: one handler, clear rules ---
// - Navigations: network-first (fallback to cached HTML)
// - Images & Audio: cache-first (populate cache on miss)  ← offline friendly
// - Everything else (JS/CSS/data): stale-while-revalidate
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Same-origin only
  if (url.origin !== location.origin) return;

  // HTML navigations
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  // Static media: images + audio
  if (/\.(png|jpg|jpeg|webp|gif|svg|mp3|wav|ogg)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Default: JS/CSS/data → stale-while-revalidate
  event.respondWith(staleWhileRevalidate(req));
});

// --- Strategies ---

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const net = await fetch(req);
    if (net && net.ok) cache.put(req, net.clone());
    return net;
  } catch {
    return cached || Response.error();
  }
}

async function networkFirstHTML(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const net = await fetch(req);
    if (net && net.ok) cache.put(req, net.clone());
    return net;
  } catch {
    // Fallback to whichever HTML we have
    const fallback =
      (await cache.match(req)) ||
      (await cache.match('./fifteenAFC.html')) ||
      (await cache.match('./index.html'));
    return fallback || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const netPromise = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await netPromise) || Response.error();
}
