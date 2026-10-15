const CACHE_PREFIX = 'lily-runtime-';
const HOME_URL = new URL('/', self.location.origin).href;
// FIFO entry limits plus decoded-body limits bound stored payloads to 76 MiB.
// Page and asset budgets are independent; gallery images cannot evict pages.
const CACHE_POLICIES = {
  pages: { name: `${CACHE_PREFIX}v2-pages`, maxEntries: 24, maxBytes: 512 * 1024, pinnedKey: HOME_URL },
  assets: { name: `${CACHE_PREFIX}v2-assets`, maxEntries: 64, maxBytes: 1024 * 1024 },
};
let cacheWrites = Promise.resolve();

self.addEventListener('install', (event) => {
  event.waitUntil(
    fetch(HOME_URL)
      .then((response) => storeResponse({ ...CACHE_POLICIES.pages, key: HOME_URL }, response))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => {
        const active = Object.values(CACHE_POLICIES).map((policy) => policy.name);
        return Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && !active.includes(key)).map((key) => caches.delete(key).catch(() => false)));
      })
      .catch(() => {})
      .then(() => self.clients.claim())
  );
});

function isCacheable(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default');
}

function cachePolicy(request) {
  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    if (url.pathname === '/search' || url.pathname === '/search/') {
      // Search is a static shell; query state remains in the browser URL.
      url.pathname = '/search/';
      url.search = '';
    } else if (url.search) {
      // Other query-dependent navigation responses have no shared offline key.
      return null;
    }
    return { ...CACHE_POLICIES.pages, key: url.href };
  }
  return { ...CACHE_POLICIES.assets, key: url.href };
}

async function withinBodyLimit(response, maxBytes) {
  if (!response.body) return true;
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return true;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // Do not await tee cancellation: the original network body may still be read.
        reader.cancel().catch(() => {});
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function trimCache(cache, maxEntries, pinnedKey, knownKeys) {
  const keys = knownKeys || await cache.keys();
  const removable = keys.filter((request) => request.url !== pinnedKey);
  const excess = Math.max(0, keys.length - maxEntries);
  for (const request of removable.slice(0, excess)) await cache.delete(request);
}

async function storeResponse(policy, response) {
  if (!policy || !isCacheable(response)) return;
  const copy = response.clone();
  if (!(await withinBodyLimit(copy.clone(), policy.maxBytes))) {
    copy.body?.cancel().catch(() => {});
    return;
  }
  const write = cacheWrites.then(async () => {
    const cache = await caches.open(policy.name);
    const keys = await cache.keys();
    const exists = keys.some((request) => request.url === policy.key);
    // Reserve a slot first. If enumeration or eviction fails, skip the write.
    await trimCache(cache, policy.maxEntries - (exists ? 0 : 1), policy.pinnedKey, keys);
    await cache.put(policy.key, copy);
    await trimCache(cache, policy.maxEntries, policy.pinnedKey);
  });
  // A quota or storage failure must not block later writes or network responses.
  cacheWrites = write.catch(() => {});
  return write;
}

function updateCache(request, event) {
  const network = Promise.resolve().then(() => fetch(request));
  event.waitUntil(network.then((response) => storeResponse(cachePolicy(request), response)).catch(() => {}));
  return network;
}

async function cachedResponse(request) {
  const policy = cachePolicy(request);
  if (!policy) return null;
  try {
    const cache = await caches.open(policy.name);
    return await cache.match(policy.key);
  } catch {
    return null;
  }
}

async function staleWhileRevalidate(request, event) {
  const update = updateCache(request, event).catch(() => null);
  const cached = await cachedResponse(request);
  return cached || (await update) || Response.error();
}

async function navigationResponse(request, event) {
  const network = updateCache(request, event).catch(() => null);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1000));
  const quick = await Promise.race([network, timeout]);
  if (quick) return quick;
  const cached = await cachedResponse(request);
  if (cached) return cached;
  return (await network) || new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>暂时离线</title></head><body><main><h1>暂时离线</h1><p>此页面尚未保存，联网后可以继续阅读。</p><p><a href="">重试当前页面</a> · <a href="/">返回博客首页</a></p></main></body></html>`, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
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

  const isSearchIndex = url.pathname === '/index.json' && !url.search;
  if (isSearchIndex || ['style', 'script', 'image', 'font'].includes(request.destination)) {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});
