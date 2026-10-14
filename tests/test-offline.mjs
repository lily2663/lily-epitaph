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

function serviceWorker({ fetch, match = async () => undefined, open, timeout } = {}) {
  const listeners = new Map();
  const writes = [];
  const timers = [];
  const cache = { put: async (request, value) => writes.push({ request, value }) };
  const context = vm.createContext({
    URL,
    Response,
    fetch,
    caches: { match, open: open || (async () => cache) },
    self: {
      location: { origin },
      addEventListener: (name, listener) => listeners.set(name, listener),
    },
    // Keep navigation timeouts deterministic and avoid one-second timers in Node.
    setTimeout: (callback) => {
      timers.push(callback);
      if (timeout) queueMicrotask(callback);
      return timers.length;
    },
  });
  vm.runInContext(source, context, { filename: 'sw.js' });

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

  return { dispatch, writes };
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

  test(`${mode}: network and cache failures return a network error`, async () => {
    const worker = serviceWorker({
      fetch: async () => { throw new TypeError('Network offline'); },
      match: async () => { throw new Error('Cache unavailable'); },
    });
    const event = worker.dispatch(request);
    assert.equal((await event.response).type, 'error');
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

test('offline navigation uses the cached app shell when the requested page is absent', async () => {
  const shell = response('saved home page');
  const worker = serviceWorker({
    fetch: async () => { throw new TypeError('Network offline'); },
    match: async (request) => request === '/' ? shell : undefined,
  });
  const event = worker.dispatch({ path: '/missing/', mode: 'navigate' });
  assert.strictEqual(await event.response, shell);
  await Promise.all(event.lifetimes);
});
