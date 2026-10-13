// ClipForge service worker: makes the app installable and opens instantly.
// Only the app shell is cached — API calls, uploads and videos always go to the server.
const CACHE = 'clipforge-shell-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first so updates show up immediately; fall back to the cached shell offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // A page load that comes back empty or not as HTML (e.g. the codespace is still waking up)
        // would make Safari show a blank "file" screen — show the saved app instead.
        const isPage = e.request.mode === 'navigate';
        if (isPage && (!res.ok || !(res.headers.get('content-type') || '').includes('text/html'))) {
          return caches.match('/').then((cached) => cached || res);
        }
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/'))),
  );
});
