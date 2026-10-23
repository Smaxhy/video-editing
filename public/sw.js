// ClipForge service worker: makes the app installable and opens instantly.
// Only the app shell is cached — API calls, uploads and videos always go to the server.
const CACHE = 'clipforge-shell-v5';
const SHELL = ['/', '/app.css', '/app.js', '/vendor/tus/tus.min.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  // Cache what we can, one file at a time: a single failed fetch must not block the update.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
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
        const isPage = e.request.mode === 'navigate';
        if (isPage) {
          // A sign-in redirect (GitHub Codespaces checks who you are on private ports) must reach the
          // browser — serving the saved app here would hide the newest version behind an old copy forever.
          if (res.type === 'opaqueredirect' || res.redirected || (res.status >= 300 && res.status < 500)) return res;
          // Server errors or an empty/non-HTML page (the codespace is still waking up) would make Safari
          // show a blank "file" screen — show the saved app instead; it reconnects on its own.
          if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) {
            return caches.match('/').then((cached) => cached || res);
          }
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
