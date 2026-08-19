/**
 * Navigation-cache behaviour from the real service worker.
 *
 * The worker is evaluated in a small VM-backed Service Worker environment so
 * these tests exercise its registered fetch handler rather than duplicating
 * the routing policy in test code.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const ORIGIN = 'https://example.test';
const SCOPE = `${ORIGIN}/media-forge/`;

function response(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function createHarness(networkFetch) {
  const entries = new Map();
  const listeners = new Map();

  const keyFor = (request, ignoreSearch = false) => {
    const raw = typeof request === 'string' ? request : request.url;
    const url = new URL(raw, SCOPE);
    if (ignoreSearch) url.search = '';
    return url.href;
  };

  const cache = {
    async add() {},
    async put(request, value) {
      entries.set(keyFor(request), value.clone());
    },
  };

  const caches = {
    async open() {
      return cache;
    },
    async match(request, options = {}) {
      const stored = entries.get(keyFor(request, options.ignoreSearch));
      return stored?.clone();
    },
    async keys() {
      return [];
    },
    async delete() {
      return true;
    },
  };

  const self = {
    location: new URL(`${SCOPE}sw.js`),
    registration: { scope: SCOPE },
    clients: { async claim() {} },
    async skipWaiting() {},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };

  vm.runInNewContext(SOURCE, {
    self,
    caches,
    fetch: networkFetch,
    URL,
    Request,
    Response,
    console,
  });

  return {
    async seed(path, value) {
      entries.set(keyFor(path), response(value));
    },

    async cachedText(path) {
      const cached = entries.get(keyFor(path));
      return cached ? cached.clone().text() : null;
    },

    async navigate(path) {
      let responsePromise;
      const event = {
        request: {
          method: 'GET',
          mode: 'navigate',
          url: new URL(path, SCOPE).href,
        },
        respondWith(value) {
          responsePromise = Promise.resolve(value);
        },
        waitUntil() {},
      };

      listeners.get('fetch')(event);
      assert.ok(responsePromise, 'the service worker did not handle the navigation');
      return responsePromise;
    },
  };
}

describe('service worker navigation caching', () => {
  test('a successful scope-root navigation refreshes the app shell', async () => {
    const harness = createHarness(async () => response('fresh shell'));
    await harness.seed('./index.html', 'old shell');

    const result = await harness.navigate('./');

    assert.equal(await result.text(), 'fresh shell');
    assert.equal(await harness.cachedText('./index.html'), 'fresh shell');
  });

  test('a successful explicit index navigation refreshes the app shell', async () => {
    const harness = createHarness(async () => response('fresh explicit shell'));
    await harness.seed('./index.html', 'old shell');

    await harness.navigate('./index.html?utm=test');

    assert.equal(await harness.cachedText('./index.html'), 'fresh explicit shell');
  });

  test('about.html never replaces the app shell', async () => {
    const harness = createHarness(async () => response('online about'));
    await harness.seed('./index.html', 'known shell');

    const result = await harness.navigate('./about.html');

    assert.equal(await result.text(), 'online about');
    assert.equal(await harness.cachedText('./index.html'), 'known shell');
  });

  test('a 404 response never replaces the app shell', async () => {
    const harness = createHarness(async () => response('server not found', 404));
    await harness.seed('./index.html', 'known shell');

    const result = await harness.navigate('./missing-page');

    assert.equal(result.status, 404);
    assert.equal(await result.text(), 'server not found');
    assert.equal(await harness.cachedText('./index.html'), 'known shell');
  });

  test('an unsuccessful shell navigation does not replace its cached copy', async () => {
    const harness = createHarness(async () => response('root unavailable', 503));
    await harness.seed('./index.html', 'known shell');

    const result = await harness.navigate('./');

    assert.equal(result.status, 503);
    assert.equal(await result.text(), 'root unavailable');
    assert.equal(await harness.cachedText('./index.html'), 'known shell');
  });

  test('offline about.html uses its own cached document', async () => {
    const harness = createHarness(async () => {
      throw new TypeError('network unavailable');
    });
    await harness.seed('./index.html', 'cached shell');
    await harness.seed('./about.html', 'cached about');

    const result = await harness.navigate('./about.html?lang=es');

    assert.equal(await result.text(), 'cached about');
  });

  test('the offline scope root uses the canonical index cache entry', async () => {
    const harness = createHarness(async () => {
      throw new TypeError('network unavailable');
    });
    await harness.seed('./', 'stale install-time root alias');
    await harness.seed('./index.html', 'refreshed cached shell');

    const result = await harness.navigate('./');

    assert.equal(await result.text(), 'refreshed cached shell');
  });

  test('an unknown offline route falls back to the app shell', async () => {
    const harness = createHarness(async () => {
      throw new TypeError('network unavailable');
    });
    await harness.seed('./index.html', 'cached shell');

    const result = await harness.navigate('./unknown/deep/link');

    assert.equal(await result.text(), 'cached shell');
  });

  test('offline without a cached document returns a useful 503', async () => {
    const harness = createHarness(async () => {
      throw new TypeError('network unavailable');
    });

    const result = await harness.navigate('./');

    assert.equal(result.status, 503);
    assert.equal(await result.text(), 'Offline and nothing cached yet.');
  });
});
