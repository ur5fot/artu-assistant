// Minimal Service Worker: passthrough only.
// Exists so Chrome/Edge consider R2 installable. No caching — R2 requires a
// live connection to the local server and cannot run offline.
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', () => {
  // Fall through to default network handling.
});
