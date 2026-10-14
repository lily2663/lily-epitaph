const CACHE_NAME = 'lily-runtime-v1';
const APP_SHELL = ['/'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('lily-runtime-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isCacheable(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default');
}

async function updateCache(request) {
  const response = await fetch(request);
  if (isCacheable(response)) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    } catch {
      // Cache storage is optional; quota or storage failures must not hide a network response.
    }
  }
  return response;
}

async function cachedResponse(request) {
  try {
    return await caches.match(request);
  } catch {
    return null;
  }
}

async function staleWhileRevalidate(request, event) {
  const update = updateCache(request).catch(() => null);
  event.waitUntil(update);
  const cached = await cachedResponse(request);
  return cached || (await update) || Response.error();
}

async function navigationResponse(request, event) {
  const network = updateCache(request).catch(() => null);
  event.waitUntil(network);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1000));
  const quick = await Promise.race([network, timeout]);
  if (quick) return quick;
  const cached = await cachedResponse(request);
  if (cached) return cached;
  return (await network) || (await cachedResponse('/')) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request, event));
    return;
  }

  if (['style', 'script', 'image', 'font'].includes(request.destination)) {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});
