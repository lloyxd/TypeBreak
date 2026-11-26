/**
 * Service worker: offline support for a fully client-side app.
 *
 * The app is static, so everything it needs can be precached. Strategy per
 * resource type:
 *
 *   · App shell (HTML/JS/CSS)  → network-first, falling back to cache. That way
 *     a deployed update is picked up promptly, but an offline launch still works.
 *   · Lesson library (JSON)    → cache-first with a background refresh. It is
 *     immutable per schema version and large, so serving it from cache keeps
 *     startup fast offline.
 *   · Navigation               → serve the cached shell, since routing is by hash.
 *
 * User progress lives in IndexedDB, which is not touched by this worker at all:
 * there is nothing to sync and no data to lose.
 */

const VERSION = 'typebreak-v9';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

/** Files required to launch offline. Paths are relative to the SW scope. */
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './client.js',
  './dom.js',
  './router.js',
  './pwa.js',
  './core/context.js',
  './core/db.js',
  './core/backup.js',
  './core/bts.js',
  './core/engine.js',
  './core/keyboard.js',
  './core/library.js',
  './core/profiles.js',
  './core/service.js',
  './core/words.js',
  './core/lesson-flow.js',
  './pages/adaptive.js',
  './pages/free-practice.js',
  './pages/dashboard.js',
  './pages/lessons.js',
  './pages/practice.js',
  './pages/progress.js',
  './pages/settings.js',
  './pages/shared.js',
  './ui/storage.js',
  './ui/scene.js',
  './ui/effects.js',
  './ui/onscreen-keyboard.js',
  './ui/mountain.js',
  './data/lessons.json',
  './manifest.webmanifest',
];

/** Install: precache the shell. A single failure must not abort the whole set. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // `addAll` fails atomically; add individually so one 404 cannot leave the
      // app with no offline cache at all.
      Promise.all(
        SHELL_ASSETS.map((asset) =>
          cache.add(new Request(asset, { cache: 'reload' })).catch(() => {
            /* a missing optional asset should not break installation */
          }),
        ),
      ),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions.
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GETs are cacheable, and never touch another origin.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigation: always serve the shell so hash routes work offline.
  if (request.mode === 'navigate') {
    event.respondWith(shellNavigation(request));
    return;
  }

  // The lesson library: cache-first, refreshed in the background.
  if (url.pathname.endsWith('/data/lessons.json')) {
    event.respondWith(cacheFirstWithRefresh(request, DATA_CACHE));
    return;
  }

  // Everything else in the app shell: network-first with a cache fallback.
  event.respondWith(networkFirst(request));
});

async function shellNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('./index.html', response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match('./index.html', { cacheName: SHELL_CACHE });
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>TypeBreak offline</title><p>TypeBreak is not cached yet. Reconnect once to enable offline use.',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    return new Response('Offline and not cached.', { status: 504, statusText: 'Offline' });
  }
}

async function cacheFirstWithRefresh(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    // Refresh in the background for the next launch.
    fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
      })
      .catch(() => {
        /* offline: the cached copy stays in service */
      });
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response(JSON.stringify({ error: 'Lesson library unavailable offline' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
}
