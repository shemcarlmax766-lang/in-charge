/*
 * BEM-FRS service worker — an *app shell* cache, deliberately not an offline data layer.
 *
 * Rules:
 *   • /api/** is NEVER intercepted: fault reports and repair records must hit the server or
 *     fail loudly in the UI (an offline queue that silently "accepted" a report would be
 *     worse than a visible error — see docs/FAILURE-POINTS.md §6).
 *   • Navigations are network-first with a cached-shell fallback, so a flaky/LAN-down phone
 *     still opens the app and immediately shows per-request offline errors where data lives.
 *   • Content-hashed assets are cache-first (they are immutable by URL).
 *   • Registered from main.jsx only in production builds; dev/HMR must never be intercepted.
 */
const CACHE = 'bems-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(new Request('/'), res.clone()); // the shell itself
          cache.put(req, res.clone());               // plus the deep link, so a cached scan URL opens offline
        }
        return res;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(req)) ?? (await cache.match('/'))
          ?? new Response('Offline — the app shell could not be loaded.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // Static assets: stale-while-revalidate (hashed chunks never change content at a URL).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const network = fetch(req)
      .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => hit);
    return hit ?? network;
  })());
});
