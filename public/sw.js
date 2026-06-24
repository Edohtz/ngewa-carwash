// Bump VERSION on every deploy (keep in sync with APP_VERSION in index.html).
// Changing it gives the cache a new name, so activate() purges the old one and
// returning users get the fresh build instead of stale HTML.
const VERSION = 'v8';
const CACHE = `ngewa-${VERSION}`;
const CORE = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never cache writes
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;     // API is network-only

  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // Network-first: a new deploy is reflected immediately; cache is the
    // offline fallback only.
    e.respondWith(
      fetch(req)
        .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; })
        .catch(() => caches.match(req).then(m => m || caches.match('/index.html')))
    );
    return;
  }

  // Static assets (icon, manifest, fonts): cache-first for speed. They are
  // versioned by the cache name, so a VERSION bump refetches them.
  e.respondWith(
    caches.match(req).then(m => m ||
      fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; }))
  );
});
