// Pack Shorts service worker.
// - Precaches the whole app (incl. the 13 MB OpenCV build) so it starts and works offline.
// - Offline-first for same-origin app files; anything same-origin fetched later is cached too.
// - Never touches api.scryfall.com, mtgjson.com, huggingface.co, cdn.jsdelivr.net, cards.scryfall.io
//   (network only — the card-data, voice and recognition modules cache those themselves).
// - Updates: bump VERSION. The new worker installs in the background and waits; the page shows
//   "A new version of Pack Shorts is ready" and posts {type:'SKIP_WAITING'} when the user taps Refresh.

const VERSION = 'v4';
const PREFIX = 'pack-shorts-app-';
const CACHE = PREFIX + VERSION;

// Must exist — install fails without them.
const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/store.js',
  'js/layout.js',
  'js/localcopy.js',
  'js/tiers.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.png',
];

// The rest of the app. Fetched one by one so a missing optional file (e.g. a worker a module doesn't use)
// doesn't break installation.
const MORE = [
  'js/mocks.js',
  'js/data.js',
  'js/detect.js',
  'js/detect-worker.js',
  'js/voice.js',
  'js/voice-worker.js',
  'js/voice-match.js',
  'js/media/demux.js',
  'js/media/frames.js',
  'js/media/audio.js',
  'js/render/painter.js',
  'js/render/sfx.js',
  'js/render/render.js',
  'js/render/render-worker.js',
  'lib/opencv.js',
  'lib/mp4-muxer.mjs',
  'lib/webm-muxer.mjs',
];

const NETWORK_ONLY = ['api.scryfall.com', 'mtgjson.com', 'huggingface.co', 'cdn.jsdelivr.net', 'cards.scryfall.io'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })));
    await Promise.all(MORE.map(async (u) => {
      try {
        const r = await fetch(new Request(u, { cache: 'reload' }));
        if (r.ok) await cache.put(u, r);
      } catch (e) { /* optional file missing or offline: fetched and cached on first use instead */ }
    }));
    // First install: take over right away. Updates wait for the user (see SKIP_WAITING).
    if (!self.registration.active) self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // only our own app caches — never the card-art / model caches other modules keep in Cache Storage
    await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'VERSION') event.ports?.[0]?.postMessage(VERSION);
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (NETWORK_ONLY.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) return; // network only
  if (url.origin !== self.location.origin) return;                                          // other origins: browser default
  if (req.headers.has('range')) return;                                                     // media byte ranges
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  const rel = url.pathname.slice(scope.pathname.length);
  if (rel.startsWith('tests/')) return;                                                      // test fixtures: never cache

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      // the app is a single page: any navigation inside the scope gets index.html (query strings like ?mock=1 kept by the URL)
      const hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('index.html')) || (await cache.match('./'));
      if (hit) return hit;
      return fetch(req);
    }
    const hit = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (e) {
      return new Response('Offline and not cached: ' + rel, { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
