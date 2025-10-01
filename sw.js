/* sw.js — simple PWA cache for KTT 15 */
const CACHE_VERSION = 'ktt-v1';
const APP_SHELL = [
  './index.html',
  './fifteenAFC.js',
  './manifest.webmanifest',
  './Images/pai.png',
  './UClogo.png',
  './icon-192.png',
  './icon-512.png'
];

// Try to add optional assets, but don’t fail install if missing
const OPTIONAL = [
  './kupu_lists.tsv',                  // only if you’re fetching TSV (not needed if inline)
  './sounds/Kei_hea_te_01.mp3'        // preface (space is fine in URL)
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Precache shell
    await cache.addAll(APP_SHELL);
    // Optional files (best-effort)
    for (const url of OPTIONAL) {
      try { await cache.add(url); } catch (e) { /* ignore */ }
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === CACHE_VERSION ? null : caches.delete(k))));
    self.clients.claim();
  })());
});

/* Strategy:
   - Navigations & HTML/JS/CSS: stale-while-revalidate.
   - Images: cache-first (good offline).
   - Audio: network-first (avoid bloating cache / Range issues). */
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin
  if (url.origin !== location.origin) return;

  // HTML navigations
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, net.clone());
        return net;
      } catch {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match('./fifteenAFC.html')) || Response.error();
      }
    })());
    return;
  }

  // Static assets
  if (req.destination === 'image') {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (req.destination === 'audio') {
    event.respondWith(networkFirst(req));
    return;
  }

  // Default: stale-while-revalidate for JS/CSS/data
  event.respondWith(staleWhileRevalidate(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  if (cached) return cached;
  const net = await fetch(req);
  cache.put(req, net.clone());
  return net;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const net = await fetch(req);
    cache.put(req, net.clone());
    return net;
  } catch {
    const cached = await cache.match(req);
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  const netPromise = fetch(req).then(res => {
    cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await netPromise) || Response.error();
}
