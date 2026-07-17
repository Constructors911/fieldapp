/* C911 Field service worker (Agent C).
 * - App shell: cache-first (precached at install, runtime-cached for hashed
 *   /assets/ files so the shell works fully offline after first load).
 * - /api GET: network-first with cache fallback, so last-fetched data is
 *   available offline.
 * - Bump VERSION to invalidate old caches (cleaned up on activate).
 */

const VERSION = 'c911-v1';
const SHELL_CACHE = `shell-${VERSION}`;
const API_CACHE = `api-${VERSION}`;

const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== API_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && new URL(request.url).origin === self.location.origin) {
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function shellNavigate(request) {
  // Network-first app shell for navigations so new deploys are picked up
  // (index.html changes every build; this sw.js may not). Falls back to the
  // cached shell when offline.
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('/', response.clone());
    }
    return response;
  } catch (err) {
    const cached = (await caches.match('/')) || (await caches.match('/index.html'));
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // mutations are the offline queue's job

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
  } else if (request.mode === 'navigate') {
    event.respondWith(shellNavigate(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});
