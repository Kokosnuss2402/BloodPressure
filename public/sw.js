// Offline support: network-first for pages, cache-first for static assets.
// API calls (cloud backup) and cross-origin requests are never cached.
const CACHE = 'vitals-log-v2';

const SHELL = ['./', './manifest.webmanifest', './icon.svg', './icon-192.png'];

// Cache the app shell plus every asset index.html references, so the app also
// opens offline after the very first visit (those assets load before the SW runs).
self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      const html = await (await cache.match('./')).text();
      const assets = [...html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll(assets);
    })(),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./')),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }),
    ),
  );
});
