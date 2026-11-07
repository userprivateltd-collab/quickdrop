/**
 * BeamDrop Cache Purge Service Worker
 * Immediately clears all stale caches and unregisters.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map((key) => caches.delete(key)));
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Direct network pass-through, never cache
  event.respondWith(fetch(event.request));
});
