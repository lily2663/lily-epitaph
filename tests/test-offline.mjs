import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../static/sw.js', import.meta.url), 'utf8');
const origin = 'https://blog.test';

function response(body, init) {
  return new Response(body, init);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function serviceWorker({ fetch, match, open, timeout, cacheKeys, deleteCache } = {}) {
  const listeners = new Map();
  const writes = [];
  const timers = [];
  const stores = new Map();
  const deletedCaches = [];
  let claimed = false;
  let skippedWaiting = false;
  const key = (request) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const cacheFor = (name) => ({
    match: async (request) => match ? match(request, name) : store(name).get(key(request))?.clone(),
    keys: async () => [...store(name).keys()].map((url) => new Request(url)),
    delete: async (request) => store(name).delete(key(request)),
    put: async (request, value) => {
      // Cache.put consumes a clone while keeping stored responses reusable.
      await value.clone().arrayBuffer();
      store(name).set(key(request), value);
      writes.push({ request, value: value.clone(), name });
    },
  });
  const context = vm.createContext({
    URL,
    Response,
    fetch,
    caches: {
      open: async (name) => ({ ...cacheFor(name), ...(open ? await open(name) : {}) }),
      keys: cacheKeys || (async () => [...stores.keys()]),
      delete: async (name) => {
        if (deleteCache) await deleteCache(name);
        deletedCaches.push(name);
        return stores.delete(name);
      },
    },
    self: {
      location: { origin },
      addEventListener: (name, listener) => listeners.set(name, listener),
      skipWaiting: () => { skippedWaiting = true; },
      clients: { claim: async () => { claimed = true; } },
    },
    // Keep navigation timeouts deterministic and avoid one-second timers in Node.
    setTimeout: (callback) => {
      timers.push(callback);
      if (timeout) queueMicrotask(callback);
      return timers.length;
    },
  });
  vm.runInContext(source, context, { filename: 'sw.js' });
  const policies = vm.runInContext('CACHE_POLICIES', context);

  function dispatch({ path = '/asset.js', mode = 'cors', destination = 'script' } = {}) {
    const lifetimes = [];
    let dispatching = true;
    let result;
    const request = { url: `${origin}${path}`, method: 'GET', headers: new Headers(), mode, destination };
    listeners.get('fetch')({
      request,
      respondWith: (value) => { result = value; },
      waitUntil: (value) => {
        assert.ok(dispatching, 'Background work must be registered during fetch dispatch');
        lifetimes.push(value);
      },
    });
    dispatching = false;
    return { response: result, lifetimes };
  }

  return {
    dispatch, writes, policies, deletedCaches,
    seed: (name, request, value) => store(name).set(key(request), value),
    entries: (name) => [...store(name).keys()],
    stored: (name, request) => store(name).get(key(request))?.clone(),
    async lifecycle(type) {
      const lifetimes = [];
      let dispatching = true;
      listeners.get(type)({ waitUntil: (value) => {
        assert.ok(dispatching, 'Lifecycle work must be registered during dispatch');
        lifetimes.push(value);
      } });
      dispatching = false;
      await Promise.all(lifetimes);
    },
    get claimed() { return claimed; },
    get skippedWaiting() { return skippedWaiting; },
  };
}

for (const mode of ['asset', 'navigation']) {
  const request = mode === 'navigation' ? { path: '/post/', mode: 'navigate' } : {};

  for (const failure of ['open', 'put']) {
    test(`${mode}: ${failure} rejection preserves the successful network response`, async () => {
      const network = response(`network after ${failure} failure`);
      const worker = serviceWorker({
        fetch: async () => network,
        open: failure === 'open'
          ? async () => { throw new Error('Storage denied'); }
          : async () => ({ put: async () => { throw new Error('Quota exceeded'); } }),
      });
      const event = worker.dispatch(request);
      assert.strictEqual(await event.response, network);
      assert.equal(await network.text(), `network after ${failure} failure`);
      assert.equal(event.lifetimes.length, 1);
      await Promise.all(event.lifetimes);
    });
  }

  test(`${mode}: match rejection still allows a successful network response`, async () => {
    const network = response('fresh content');
    const worker = serviceWorker({
      fetch: async () => network,
      match: async () => { throw new Error('Cache unavailable'); },
      timeout: mode === 'navigation',
    });
    const event = worker.dispatch(request);
    assert.strictEqual(await event.response, network);
    await Promise.all(event.lifetimes);
  });

  test(`${mode}: an offline request returns the cached response`, async () => {
    const cached = response('saved content');
    const worker = serviceWorker({
      fetch: async () => { throw new TypeError('Network offline'); },
      match: async () => cached,
    });
    const event = worker.dispatch(request);
    assert.strictEqual(await event.response, cached);
    assert.equal(event.lifetimes.length, 1);
    await Promise.all(event.lifetimes);
  });

  test(`${mode}: network and cache failures report an offline failure`, async () => {
    const worker = serviceWorker({
      fetch: async () => { throw new TypeError('Network offline'); },
      match: async () => { throw new Error('Cache unavailable'); },
    });
    const event = worker.dispatch(request);
    const result = await event.response;
    if (mode === 'navigation') {
      assert.equal(result.status, 503);
      assert.match(await result.text(), /暂时离线/);
    } else {
      assert.equal(result.type, 'error');
    }
    await Promise.all(event.lifetimes);
  });

  test(`${mode}: an HTTP error remains an HTTP error and is not cached`, async () => {
    const network = response('not found', { status: 404 });
    const worker = serviceWorker({ fetch: async () => network });
    const event = worker.dispatch(request);
    assert.strictEqual(await event.response, network);
    assert.equal((await event.response).status, 404);
    assert.equal(worker.writes.length, 0);
    await Promise.all(event.lifetimes);
  });
}

test('assets return cached content while the registered update writes fresh content', async () => {
  const pending = deferred();
  const cached = response('old script');
  const network = response('new script');
  const worker = serviceWorker({ fetch: () => pending.promise, match: async () => cached });
  const event = worker.dispatch();
  assert.equal(event.lifetimes.length, 1);
  assert.strictEqual(await event.response, cached);
  pending.resolve(network);
  await Promise.all(event.lifetimes);
  assert.equal(worker.writes.length, 1);
  assert.equal(await worker.writes[0].value.text(), 'new script');
  assert.equal(await network.text(), 'new script');
});

test('slow navigation returns its cached page while the registered update remains alive', async () => {
  const pending = deferred();
  const cached = response('saved page');
  const network = response('fresh page');
  const worker = serviceWorker({ fetch: () => pending.promise, match: async () => cached, timeout: true });
  const event = worker.dispatch({ path: '/post/', mode: 'navigate' });
  assert.equal(event.lifetimes.length, 1);
  assert.strictEqual(await event.response, cached);
  pending.resolve(network);
  await Promise.all(event.lifetimes);
  assert.equal(worker.writes.length, 1);
  assert.equal(await worker.writes[0].value.text(), 'fresh page');
});

test('offline navigation reports an uncached page instead of disguising the homepage as that page', async () => {
  const shell = response('saved home page');
  const worker = serviceWorker({
    fetch: async () => { throw new TypeError('Network offline'); },
  });
  worker.seed(worker.policies.pages.name, '/', shell);
  const event = worker.dispatch({ path: '/missing/', mode: 'navigate' });
  const offline = await event.response;
  assert.equal(offline.status, 503);
  assert.equal(offline.headers.get('cache-control'), 'no-store');
  const body = await offline.text();
  assert.match(body, /暂时离线/);
  assert.match(body, /href="\/"/);
  assert.doesNotMatch(body, /saved home page/);
  await Promise.all(event.lifetimes);
});

test('network responses do not wait for cache writes to finish', async () => {
  const writing = deferred();
  const network = response('available immediately');
  const worker = serviceWorker({
    fetch: async () => network,
    open: async () => ({ put: () => writing.promise }),
  });
  const event = worker.dispatch();
  assert.strictEqual(await event.response, network);
  assert.equal(await network.text(), 'available immediately');
  writing.resolve();
  await Promise.all(event.lifetimes);
});

test('concurrent asset updates evict oldest entries and stay within their independent limit', async () => {
  const worker = serviceWorker({ fetch: async () => response('asset') });
  const limit = worker.policies.assets.maxEntries;
  worker.seed(worker.policies.pages.name, '/saved-post/', response('saved page'));
  const events = Array.from({ length: limit + 5 }, (_, index) => worker.dispatch({ path: `/image-${index}.webp`, destination: 'image' }));
  await Promise.all(events.map(async (event) => {
    await (await event.response).text();
    await Promise.all(event.lifetimes);
  }));
  const keys = worker.entries(worker.policies.assets.name);
  assert.equal(keys.length, limit);
  assert.equal(keys.includes(`${origin}/image-0.webp`), false);
  assert.equal(keys.includes(`${origin}/image-${limit + 4}.webp`), true);
  assert.equal(await worker.stored(worker.policies.pages.name, '/saved-post/').text(), 'saved page');
});

test('page eviction preserves the homepage and recently saved offline navigation', async () => {
  let online = true;
  const worker = serviceWorker({ fetch: async (request) => {
    if (!online) throw new TypeError('Network offline');
    return response(`page ${request.url}`);
  } });
  worker.seed(worker.policies.pages.name, '/', response('saved home page'));
  const limit = worker.policies.pages.maxEntries;
  for (let index = 0; index < limit + 2; index += 1) {
    const event = worker.dispatch({ path: `/post-${index}/`, mode: 'navigate' });
    await (await event.response).text();
    await Promise.all(event.lifetimes);
  }
  const keys = worker.entries(worker.policies.pages.name);
  assert.equal(keys.length, limit);
  assert.equal(keys.includes(`${origin}/`), true);
  assert.equal(keys.includes(`${origin}/post-0/`), false);
  online = false;
  const event = worker.dispatch({ path: `/post-${limit + 1}/`, mode: 'navigate' });
  assert.match(await (await event.response).text(), new RegExp(`page ${origin}/post-${limit + 1}/`));
  await Promise.all(event.lifetimes);
  const home = worker.dispatch({ path: '/', mode: 'navigate' });
  assert.equal(await (await home.response).text(), 'saved home page');
  await Promise.all(home.lifetimes);
});

for (const mode of ['asset', 'navigation']) {
  test(`${mode}: oversized decoded bodies are served without entering Cache Storage`, async () => {
    const worker = serviceWorker({ fetch: async () => response('x'.repeat((mode === 'asset' ? 1024 * 1024 : 512 * 1024) + 1)) });
    const event = worker.dispatch(mode === 'navigation' ? { path: '/large-post/', mode: 'navigate' } : {});
    assert.equal((await (await event.response).text()).length, (mode === 'asset' ? 1024 * 1024 : 512 * 1024) + 1);
    await Promise.all(event.lifetimes);
    assert.equal(worker.writes.length, 0);
  });

  test(`${mode}: a body exactly at its byte limit is cached`, async () => {
    const bytes = mode === 'asset' ? 1024 * 1024 : 512 * 1024;
    const worker = serviceWorker({ fetch: async () => response('x'.repeat(bytes)) });
    const event = worker.dispatch(mode === 'navigation' ? { path: '/maximum-post/', mode: 'navigate' } : {});
    assert.equal((await (await event.response).text()).length, bytes);
    await Promise.all(event.lifetimes);
    assert.equal(worker.writes.length, 1);
    assert.equal((await worker.writes[0].value.arrayBuffer()).byteLength, bytes);
  });
}

test('body budgets count UTF-8 bytes rather than text characters or Content-Length', async () => {
  const body = '中'.repeat(Math.ceil((1024 * 1024) / 3));
  const worker = serviceWorker({ fetch: async () => response(body, { headers: { 'Content-Length': '1' } }) });
  const event = worker.dispatch();
  assert.equal(await (await event.response).text(), body);
  await Promise.all(event.lifetimes);
  assert.equal(worker.writes.length, 0);
});

test('offline reads do not reuse stale or unrelated caches with matching URLs', async () => {
  const worker = serviceWorker({ fetch: async () => { throw new TypeError('Network offline'); } });
  worker.seed('lily-runtime-v1', '/asset.js', response('retired asset'));
  worker.seed('other-app-cache', '/asset.js', response('unrelated asset'));
  const event = worker.dispatch();
  assert.equal((await event.response).type, 'error');
  await Promise.all(event.lifetimes);
});

test('search query variants share one static search shell and keep working offline', async () => {
  let online = true;
  const worker = serviceWorker({ fetch: async () => {
    if (!online) throw new TypeError('Network offline');
    return response('search shell');
  } });
  for (const query of ['one', 'two', 'three']) {
    const event = worker.dispatch({ path: `/search/?q=${query}`, mode: 'navigate' });
    await (await event.response).text();
    await Promise.all(event.lifetimes);
  }
  assert.deepEqual(worker.entries(worker.policies.pages.name), [`${origin}/search/`]);
  online = false;
  const event = worker.dispatch({ path: '/search/?q=offline', mode: 'navigate' });
  assert.equal(await (await event.response).text(), 'search shell');
  await Promise.all(event.lifetimes);
});

test('other query-dependent navigation responses are served without creating cache variants', async () => {
  const worker = serviceWorker({ fetch: async () => response('query page') });
  const event = worker.dispatch({ path: '/post/?preview=1', mode: 'navigate' });
  assert.equal(await (await event.response).text(), 'query page');
  await Promise.all(event.lifetimes);
  assert.equal(worker.writes.length, 0);
});

test('the exact public search index is saved under the asset budget and remains available offline', async () => {
  let online = true;
  const index = [{ title: 'Saved article', url: '/saved-article/', text: 'Searchable public text' }];
  const worker = serviceWorker({ fetch: async () => {
    if (!online) throw new TypeError('Network offline');
    return response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } });
  } });
  const first = worker.dispatch({ path: '/index.json', destination: '' });
  assert.deepEqual(await (await first.response).json(), index);
  await Promise.all(first.lifetimes);
  assert.deepEqual(worker.entries(worker.policies.assets.name), [`${origin}/index.json`]);
  online = false;
  const offline = worker.dispatch({ path: '/index.json', destination: '' });
  assert.deepEqual(await (await offline.response).json(), index);
  await Promise.all(offline.lifetimes);
});

test('a public search index larger than the resource byte budget is served without caching', async () => {
  const body = JSON.stringify({ text: 'x'.repeat(1024 * 1024) });
  const worker = serviceWorker({ fetch: async () => response(body, { headers: { 'Content-Type': 'application/json' } }) });
  const event = worker.dispatch({ path: '/index.json', destination: '' });
  assert.equal(await (await event.response).text(), body);
  await Promise.all(event.lifetimes);
  assert.equal(worker.writes.length, 0);
});

test('other JSON, queried search indexes and API fetches are not intercepted', () => {
  let fetches = 0;
  const worker = serviceWorker({ fetch: async () => { fetches += 1; return response('unexpected'); } });
  for (const path of ['/other.json', '/protected/post.json', '/index.json?q=private', '/api/index.json', '/api/data']) {
    const event = worker.dispatch({ path, destination: '' });
    assert.equal(event.response, undefined, `${path} uses the browser network path`);
    assert.equal(event.lifetimes.length, 0);
  }
  assert.equal(fetches, 0);
  assert.equal(worker.writes.length, 0);
});

for (const failure of ['keys', 'delete']) {
  test(`${failure} rejection skips a cache update without hiding a successful response`, async () => {
    const network = response('fresh asset');
    const worker = serviceWorker({
      fetch: async () => network,
      open: async () => failure === 'keys'
        ? { keys: async () => { throw new Error('Storage enumeration denied'); } }
        : { delete: async () => { throw new Error('Storage deletion denied'); } },
    });
    if (failure === 'delete') {
      for (let index = 0; index < worker.policies.assets.maxEntries; index += 1) {
        worker.seed(worker.policies.assets.name, `/old-${index}.js`, response('saved asset'));
      }
    }
    const event = worker.dispatch();
    assert.strictEqual(await event.response, network);
    assert.equal(await network.text(), 'fresh asset');
    await Promise.all(event.lifetimes);
    assert.equal(worker.writes.length, 0);
  });
}

test('a failed cache write does not poison the queue for later updates', async () => {
  let first = true;
  const worker = serviceWorker({
    fetch: async () => response('fresh asset'),
    open: async () => first ? { put: async () => { first = false; throw new Error('Quota exceeded'); } } : {},
  });
  for (const path of ['/first.js', '/second.js']) {
    const event = worker.dispatch({ path });
    await (await event.response).text();
    await Promise.all(event.lifetimes);
  }
  assert.deepEqual(worker.entries(worker.policies.assets.name), [`${origin}/second.js`]);
});

test('activation retires previous Lily runtime caches without deleting unrelated caches', async () => {
  const worker = serviceWorker();
  for (const name of ['lily-runtime-v1', 'lily-runtime-old', 'other-app-cache', worker.policies.pages.name, worker.policies.assets.name]) {
    worker.seed(name, '/', response('saved content'));
  }
  await worker.lifecycle('activate');
  assert.deepEqual(worker.deletedCaches.sort(), ['lily-runtime-old', 'lily-runtime-v1']);
  assert.equal(worker.entries('other-app-cache').length, 1);
  assert.equal(worker.entries(worker.policies.pages.name).length, 1);
  assert.equal(worker.claimed, true);
});

test('activation cleanup failure still allows the new worker to claim clients', async () => {
  const worker = serviceWorker({ cacheKeys: async () => { throw new Error('Cache storage unavailable'); } });
  await worker.lifecycle('activate');
  assert.equal(worker.claimed, true);
});

test('a legacy cache deletion failure does not prevent other cleanup or client claiming', async () => {
  const worker = serviceWorker({ deleteCache: async (name) => {
    if (name === 'lily-runtime-v1') throw new Error('Deletion denied');
  } });
  worker.seed('lily-runtime-v1', '/', response('old page'));
  worker.seed('lily-runtime-older', '/', response('older page'));
  await worker.lifecycle('activate');
  assert.deepEqual(worker.deletedCaches, ['lily-runtime-older']);
  assert.equal(worker.claimed, true);
});

test('installation caches the bounded homepage and tolerates unavailable storage', async () => {
  const worker = serviceWorker({ fetch: async () => response('home page') });
  await worker.lifecycle('install');
  assert.equal(await worker.stored(worker.policies.pages.name, '/').text(), 'home page');
  assert.equal(worker.skippedWaiting, true);
  const unavailable = serviceWorker({
    fetch: async () => response('home page'),
    open: async () => { throw new Error('Storage unavailable'); },
  });
  await unavailable.lifecycle('install');
  assert.equal(unavailable.skippedWaiting, true);
});
