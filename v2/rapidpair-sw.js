// rapidpair-sw.js - Service Worker for RapidPair
// Caches all dependencies for offline use

const CACHE_NAME = 'rapidpair-v8.8';
const urlsToCache = [
  // Main HTML (adjust path if needed)
  './rapidpair59.html',
  
  // Local dependencies (adjust paths if needed)
  './qrcode.js',
  './pako.min.js',
  './html5-qrcode.min.js',
  
  // Firebase CDN modules
  'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js'
];

// Install event - cache all resources
self.addEventListener('install', event => {
  console.log('[RapidPair SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[RapidPair SW] Caching resources...');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        console.log('[RapidPair SW] All resources cached successfully');
        return self.skipWaiting(); // Activate immediately
      })
      .catch(error => {
        console.error('[RapidPair SW] Cache failed:', error);
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('[RapidPair SW] Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // Delete old RapidPair caches (keep other apps' caches!)
          if (cacheName.startsWith('rapidpair-') && cacheName !== CACHE_NAME) {
            console.log('[RapidPair SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[RapidPair SW] Activated');
      return self.clients.claim(); // Take control immediately
    })
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', event => {
  // Only intercept requests for our cached resources
  const url = new URL(event.request.url);
  
  // Check if this is a request we care about
  const isRapidPairResource = 
    event.request.url.includes('rapidpair') ||
    event.request.url.includes('qrcode.js') ||
    event.request.url.includes('pako.min.js') ||
    event.request.url.includes('html5-qrcode.min.js') ||
    event.request.url.includes('gstatic.com/firebasejs');
  
  if (!isRapidPairResource) {
    // Not our resource, let other service workers handle it
    return;
  }
  
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          console.log('[RapidPair SW] Serving from cache:', event.request.url);
          return response;
        }
        
        console.log('[RapidPair SW] Fetching from network:', event.request.url);
        return fetch(event.request)
          .then(response => {
            // Don't cache if not successful
            if (!response || response.status !== 200 || response.type === 'error') {
              return response;
            }
            
            // Clone the response
            const responseToCache = response.clone();
            
            // Add to cache for next time
            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(event.request, responseToCache);
              });
            
            return response;
          });
      })
      .catch(error => {
        console.error('[RapidPair SW] Fetch failed:', error);
        // Could return a custom offline page here
      })
  );
});

// Message event - allow page to communicate with SW
self.addEventListener('message', event => {
  if (event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
  
  if (event.data.action === 'getCacheStatus') {
    caches.has(CACHE_NAME).then(exists => {
      event.ports[0].postMessage({
        cacheExists: exists,
        cacheName: CACHE_NAME
      });
    });
  }
});
