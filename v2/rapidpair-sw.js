/* rapidpair-sw.js — RETIRED.
 *
 * RapidPair caching is now handled by the single app service worker (sw.js).
 * Two service workers on the same scope caused cache-fighting and stale code,
 * so this one self-unregisters and deletes its old caches. Devices that still
 * have it installed will clean themselves up on next load. Safe to delete this
 * file once you're confident no deployed device still references it.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.map(n => n.startsWith('rapidpair-') ? caches.delete(n) : null));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(c => c.navigate(c.url));   // reload so sw.js takes over cleanly
    } catch (_) {}
  })());
});
