// Offline-first cache. Bump VERSION when files change.
const VERSION = 'amirnet-v7';
const SHELL = ['./', 'index.html', 'app.js', 'words.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
// 'reload' skips the browser's HTTP cache (GitHub Pages keeps files for 10 minutes),
// so a new version never gets filled with the previous version's files.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, {cache: 'reload'}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.includes('script.google')) return;
  // open instantly from cache, refresh the cached copy in the background (bypassing the HTTP cache)
  e.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(req, {ignoreSearch: true});
    const net = fetch(req, {cache: 'no-cache'}).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => cached);
    return cached || net;
  }));
});
