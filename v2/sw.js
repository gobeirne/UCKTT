/* sw.js — KTT PWA service worker (single source of truth for caching)
 *
 * Caching policy designed so deployed updates reach devices reliably:
 *   • App code (JS/CSS) + HTML  → NETWORK-FIRST: a fresh deploy is picked up on
 *     the very next load; cache is only a fallback when offline.
 *   • Images + audio            → CACHE-FIRST: large, effectively immutable, and
 *     wanted offline. A version bump purges them when they do change.
 *
 * One APP_VERSION drives the cache name, so bumping it auto-purges every older
 * cache on activate. Bump APP_VERSION on every deploy (or let your build stamp it).
 */

const APP_VERSION = '2.2.0';
const CACHE_NAME  = `ktt-v${APP_VERSION}`;

// App shell — must-have files, including the formerly RapidPair-owned libs so a
// single SW now covers them (no second SW needed).
const APP_SHELL = [
  './index.html',
  './manifest.webmanifest',
  './style.css',
  './fifteenAFC.js',
  './imageStore.js',
  './listBuilder.js',
  './manualTest.js',
  './pairedMode.js',
  './rapidpair.js',
  './qrcode.js',
  './pako.min.js',
  './html5-qrcode.min.js',
  './UClogo.png',
  './icon-192.png',
  './icon-512.png',
  './Images/pai.png',
];

// Best-effort optional items
const OPTIONAL = [
  './kupu_lists.tsv',
  './sounds/Kei_hea_te_01.mp3',
];

const PRELOAD_LIST = 'preloadfilelist.txt';

// Treat these as "app code" → network-first.
function isCodeOrShell(url) {
  return /\.(js|css|html|webmanifest)$/i.test(url.pathname);
}
// Treat these as static media → cache-first.
function isMedia(url) {
  return /\.(png|jpg|jpeg|webp|gif|svg|mp3|wav|ogg)$/i.test(url.pathname);
}

// --- Install: precache shell + preload list ---
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Shell items added individually so one 404 can't abort the whole install.
    for (const url of APP_SHELL) {
      try { await cache.add(url); } catch (err) { console.warn('SW: shell miss', url); }
    }
    for (const url of OPTIONAL) {
      try { await cache.add(url); } catch (_) {}
    }
    try {
      const scopeURL = new URL(self.registration.scope);
      const res = await fetch(new URL(PRELOAD_LIST, scopeURL), { cache: 'no-store' });
      if (res.ok) {
        const raw = await res.text();
        const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const urls = lines.map((p) => {
          const fixed = p.replace(/^images\//, 'Images/').replace(/^sounds\//, 'sounds/');
          const segs = fixed.split('/').map(encodeURIComponent).join('/');
          return new URL(segs, scopeURL).toString();
        });
        const chunk = 32;
        for (let i = 0; i < urls.length; i += chunk) {
          try { await cache.addAll(urls.slice(i, i + chunk)); } catch (_) {}
        }
        console.log(`SW ${APP_VERSION}: precached ${urls.length} assets from ${PRELOAD_LIST}`);
      }
    } catch (err) {
      console.warn('SW: no preload list or failed to precache it', err);
    }
    await self.skipWaiting();
  })());
});

// --- Activate: purge ALL old ktt caches, take control ---
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n =>
      (n.startsWith('ktt-') && n !== CACHE_NAME) ? caches.delete(n) : null
    ));
    await self.clients.claim();
    // Tell open pages a new version is live so they can offer a reload.
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'SW_ACTIVATED', version: APP_VERSION }));
  })());
});

// --- Fetch ---
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // same-origin only
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(networkFirst(req)); return;
  }
  if (isCodeOrShell(url)) { event.respondWith(networkFirst(req)); return; }
  if (isMedia(url))       { event.respondWith(cacheFirst(req));  return; }
  event.respondWith(networkFirst(req));                 // default safe: network-first
});

// --- Message hook (version query + manual skipWaiting) ---
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
});

// --- Strategies ---
// Range requests (audio/video seeking) return 206 Partial Content, which the
// Cache API refuses to store. `net.ok` is true for 206, so it must be excluded
// explicitly or every media request throws an uncaught rejection.
function cacheable(res) {
  return res && res.ok && res.status !== 206 && res.type !== 'opaque';
}

function putSafe(cache, req, res) {
  if (!cacheable(res)) return;
  cache.put(req, res.clone()).catch(err => console.warn('SW: cache put failed', req.url, err));
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const net = await fetch(req);
    putSafe(cache, req, net);
    return net;
  } catch { return cached || Response.error(); }
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    // cache:'no-store' on the network leg defeats the GitHub Pages edge cache.
    const net = await fetch(req, { cache: 'no-store' });
    putSafe(cache, req, net);
    return net;
  } catch {
    const cached = await cache.match(req) || await cache.match('./index.html');
    return cached || Response.error();
  }
}
