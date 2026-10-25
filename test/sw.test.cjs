/* dsh-mobile-pwa · service worker caching-strategy test
 *
 * pwa/sw.js only runs inside a real ServiceWorkerGlobalScope, so this loads
 * its source into a node:vm sandbox with fake `self`/`caches`/`fetch`
 * globals and drives its 'fetch' listener directly — exercising the actual
 * strategy code, not just grepping the source text.
 *
 * This is the regression guard for the "new DOM + old CSS" bug: v2 served
 * ALL JS/CSS (including the DSH client bundle and plugin client bundles)
 * stale-first, so a phone that had the PWA open across a deploy kept
 * showing yesterday's cached CSS under today's freshly network-fetched HTML.
 * v4 only cache-firsts the true static shell (manifest/icons/offline
 * fallback) plus content-addressed URLs (Vite filename hash, DSH's
 * ?rev=<content hash> plugin batches); everything else stays network-first.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SW_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'sw.js'), 'utf8')
const ORIGIN = 'https://x.test'

function loadSw(fetchImpl, opts) {
  const o = opts || {}
  const listeners = {}
  const cacheStores = new Map() // cacheName -> Map(key -> response)
  const keyOf = (reqOrKey) => (typeof reqOrKey === 'string' ? reqOrKey : reqOrKey.url)
  const putCalls = []
  const caches = {
    open: async (name) => {
      if (!cacheStores.has(name)) cacheStores.set(name, new Map())
      const store = cacheStores.get(name)
      return {
        match: async (reqOrKey) => store.get(keyOf(reqOrKey)),
        put: async (reqOrKey, res) => {
          putCalls.push(keyOf(reqOrKey))
          if (o.putHangs) return new Promise(() => {})
          store.set(keyOf(reqOrKey), res)
        },
        addAll: async (urls) => { for (const u of urls) store.set(u, { ok: true, seeded: true }) }
      }
    },
    keys: async () => Array.from(cacheStores.keys())
  }
  const fetchCalls = []
  // Real Response objects are clone()-able; our plain test-double responses
  // need the same so sw.js's `res.clone()` (done before caching, so the
  // cached copy and the returned copy don't share one read body) doesn't throw.
  const fetchFn = async (req) => {
    fetchCalls.push(req.url)
    const res = await fetchImpl(req)
    if (res && typeof res.clone !== 'function') res.clone = () => res
    return res
  }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn }
  }
  const context = vm.createContext({ self, caches, fetch: fetchFn, URL, Set, Response, console })
  vm.runInContext(SW_SOURCE, context, { filename: 'sw.js' })
  return { listeners, caches, fetchCalls, putCalls }
}

// Drives the captured 'fetch' listener the way the real dispatcher would:
// event.respondWith(promise) synchronously stashes the promise to await.
function dispatchFetch(sw, req) {
  let respondedWith
  sw.listeners.fetch({ request: req, respondWith: (p) => { respondedWith = Promise.resolve(p) } })
  return respondedWith
}

// A cached marker plus the Content-Type the real response would carry;
// cacheFirst refuses to store anything that is not the payload its URL claims.
function typed(marker, contentType) {
  return {
    ok: true,
    marker,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) }
  }
}

test('sw: true static shell (icons/manifest) is cache-first — cached copy served without a second network hit', async () => {
  let networkCalls = 0
  const sw = loadSw(async () => { networkCalls++; return { ok: true, marker: 'shell-v1' } })
  const req = { method: 'GET', url: ORIGIN + '/pwa/icons/icon-192.png', mode: 'no-cors' }

  const res1 = await dispatchFetch(sw, req)
  assert.strictEqual(res1.marker, 'shell-v1')
  assert.strictEqual(networkCalls, 1, 'first request populates the cache')

  const res2 = await dispatchFetch(sw, req)
  assert.strictEqual(res2.marker, 'shell-v1', 'served from cache')
  assert.strictEqual(networkCalls, 1, 'no second network call for a cached shell asset')
})

test('sw: content-hashed /assets/ is cache-first — a repeat cold start never re-crosses the proxy', async () => {
  let networkCalls = 0
  const sw = loadSw(async () => { networkCalls++; return typed('hashed-v1', 'text/javascript; charset=utf-8') })
  // A real Vite output name: 8-char content hash before the extension.
  const req = { method: 'GET', url: ORIGIN + '/assets/index-CN7NIWNw.js', mode: 'cors' }

  const res1 = await dispatchFetch(sw, req)
  assert.strictEqual(res1.marker, 'hashed-v1')
  assert.strictEqual(networkCalls, 1, 'first request populates the cache')

  const res2 = await dispatchFetch(sw, req)
  assert.strictEqual(res2.marker, 'hashed-v1', 'served from cache')
  assert.strictEqual(networkCalls, 1, 'the hashed URL is its own freshness proof — no second network hit')
})

test('sw: hashed fonts under /assets/fonts/ are cache-first too (DSH serves them as octet-stream)', async () => {
  let networkCalls = 0
  const sw = loadSw(async () => { networkCalls++; return typed('font-v1', 'application/octet-stream') })
  const req = { method: 'GET', url: ORIGIN + '/assets/fonts/montserrat-light-Cvd2VjE_.woff2', mode: 'no-cors' }

  await dispatchFetch(sw, req)
  const res2 = await dispatchFetch(sw, req)
  assert.strictEqual(res2.marker, 'font-v1')
  assert.strictEqual(networkCalls, 1, 'font cache hit')
})

test('sw: DSH plugin batches carrying ?rev=<content hash> are cache-first', async () => {
  let networkCalls = 0
  const sw = loadSw(async () => { networkCalls++; return typed('plugins-v1', 'text/javascript; charset=utf-8') })
  // Shape DSH actually emits: /plugins/??<id>/client.js&rev=<content hash>.
  const req = { method: 'GET', url: ORIGIN + '/plugins/??@deepseek-ai/dsh-client-ui-layout/client.js&rev=9d22877bc8d0', mode: 'cors' }

  await dispatchFetch(sw, req)
  const res2 = await dispatchFetch(sw, req)
  assert.strictEqual(res2.marker, 'plugins-v1')
  assert.strictEqual(networkCalls, 1, 'the whole plugin graph is served from CacheStorage on the second boot')
})

test('sw: a 200 HTML page at an immutable URL is never stored as an asset', async () => {
  let networkCalls = 0
  const sw = loadSw(async () => {
    networkCalls++
    // Deploy race / login wall: the asset URL answers 200 with HTML.
    return networkCalls === 1 ? typed('login-page', 'text/html; charset=utf-8') : typed('asset-v2', 'text/javascript')
  })
  const req = { method: 'GET', url: ORIGIN + '/assets/index-CN7NIWNw.js', mode: 'cors' }

  const first = await dispatchFetch(sw, req)
  assert.strictEqual(first.marker, 'login-page')
  const second = await dispatchFetch(sw, req)
  assert.strictEqual(second.marker, 'asset-v2', 'the HTML page was not served from the asset cache')
  assert.strictEqual(networkCalls, 2, 'network consulted again instead of trusting the poisoned entry')
})

test('sw: a response without a usable Content-Type is not stored under an immutable URL', async () => {
  let networkCalls = 0
  const sw = loadSw(async () => { networkCalls++; return { ok: true, marker: 'opaque-' + networkCalls } })
  const req = { method: 'GET', url: ORIGIN + '/assets/langs/cpp-DddhVWhK.js', mode: 'cors' }

  await dispatchFetch(sw, req)
  const second = await dispatchFetch(sw, req)
  assert.strictEqual(second.marker, 'opaque-2')
  assert.strictEqual(networkCalls, 2)
})

test('sw: hash-shaped plain words are NOT immutable — regression guard for the shape heuristic', async () => {
  for (const [path, ct] of [['/assets/vendor-bootstrap.css', 'text/css'], ['/assets/app-BOOTSTRAP.js', 'text/javascript']]) {
    let networkCalls = 0
    const responses = [typed('v1', ct), typed('v2', ct)]
    const sw = loadSw(async () => { const r = responses[Math.min(networkCalls, responses.length - 1)]; networkCalls++; return r })
    const req = { method: 'GET', url: ORIGIN + path, mode: 'cors' }
    await dispatchFetch(sw, req)
    const res2 = await dispatchFetch(sw, req)
    assert.strictEqual(res2.marker, 'v2', path + ' is not content-addressed')
    assert.strictEqual(networkCalls, 2, path + ' stays network-first')
  }
})

test('sw: a plugin rev that is not a content hash (rev=default) stays network-first', async () => {
  let networkCalls = 0
  const responses = [typed('p1', 'text/javascript'), typed('p2', 'text/javascript')]
  const sw = loadSw(async () => { const r = responses[Math.min(networkCalls, responses.length - 1)]; networkCalls++; return r })
  const req = { method: 'GET', url: ORIGIN + '/plugins/??@deepseek-ai/dsh-client-ui-layout/client.js&rev=default', mode: 'cors' }

  await dispatchFetch(sw, req)
  const res2 = await dispatchFetch(sw, req)
  assert.strictEqual(res2.marker, 'p2', 'a non-hash rev must not be trusted as immutable')
  assert.strictEqual(networkCalls, 2)
})

test('sw: a plugin chunk carrying ?rev=<hex> is cache-first too', async () => {
  let networkCalls = 0
  const sw = loadSw(async () => { networkCalls++; return typed('chunk-v1', 'text/javascript; charset=utf-8') })
  const req = { method: 'GET', url: ORIGIN + '/plugins/@deepseek-ai/dsh-client-ui-layout/client.abc12345.js?rev=9d22877bc8d0', mode: 'cors' }

  await dispatchFetch(sw, req)
  const res2 = await dispatchFetch(sw, req)
  assert.strictEqual(res2.marker, 'chunk-v1')
  assert.strictEqual(networkCalls, 1, 'plugin chunks are content-addressed through ?rev')
})

test('sw: an endless event stream (HMR /plugins/events) is never cached and never blocks', async () => {
  let networkCalls = 0
  const sw = loadSw(async () => { networkCalls++; return typed('stream', 'text/event-stream') }, { putHangs: true })
  const req = { method: 'GET', url: ORIGIN + '/plugins/events', mode: 'cors' }

  const res = await dispatchFetch(sw, req)
  assert.strictEqual(res.marker, 'stream')
  assert.strictEqual(networkCalls, 1)
  assert.strictEqual(sw.putCalls.length, 0, 'event streams must not be cloned into CacheStorage')
})

test('sw: a hanging cache write does not hold the response (no await on the write path)', async () => {
  const sw = loadSw(async () => typed('file-v1', 'application/octet-stream'), { putHangs: true })
  const req = { method: 'GET', url: ORIGIN + '/api/download', mode: 'cors' }

  const res = await Promise.race([
    dispatchFetch(sw, req),
    new Promise((resolve) => setTimeout(() => resolve({ marker: 'timed-out' }), 1000))
  ])
  assert.strictEqual(res.marker, 'file-v1', 'respondWith settles without waiting for cache.put')
  assert.strictEqual(sw.putCalls.length, 1)
})

test('sw: a plugin URL WITHOUT rev stays network-first — no rev means no freshness proof', async () => {
  let networkCalls = 0
  const responses = [{ ok: true, marker: 'p1' }, { ok: true, marker: 'p2' }]
  const sw = loadSw(async () => { const r = responses[Math.min(networkCalls, responses.length - 1)]; networkCalls++; return r })
  const req = { method: 'GET', url: ORIGIN + '/plugins/??@deepseek-ai/dsh-client-ui-layout/client.js', mode: 'cors' }

  await dispatchFetch(sw, req)
  const res2 = await dispatchFetch(sw, req)
  assert.strictEqual(res2.marker, 'p2', 'network response wins')
  assert.strictEqual(networkCalls, 2, 'network consulted on every request')
})

test('sw: unhashed DSH client bundle JS/CSS is network-first — regression guard for "new DOM + old CSS"', async () => {
  let networkCalls = 0
  const responses = [{ ok: true, marker: 'bundle-v1' }, { ok: true, marker: 'bundle-v2-deployed' }]
  const sw = loadSw(async () => { const r = responses[Math.min(networkCalls, responses.length - 1)]; networkCalls++; return r })
  const req = { method: 'GET', url: ORIGIN + '/assets/app.css', mode: 'cors' }

  const res1 = await dispatchFetch(sw, req)
  assert.strictEqual(res1.marker, 'bundle-v1')
  assert.strictEqual(networkCalls, 1)

  // Simulates a fresh deploy landing under the same URL: network-first must
  // ask again instead of serving the response cached a moment ago.
  const res2 = await dispatchFetch(sw, req)
  assert.strictEqual(res2.marker, 'bundle-v2-deployed', 'fresh network response wins over the stale cache')
  assert.strictEqual(networkCalls, 2, 'network is consulted on every request, not just the first')
})

test('sw: DSH bundle asset falls back to the cache only when the network is actually unreachable', async () => {
  let networkCalls = 0
  const sw = loadSw(async () => {
    networkCalls++
    if (networkCalls === 1) return { ok: true, marker: 'bundle-v1' }
    throw new Error('offline')
  })
  const req = { method: 'GET', url: ORIGIN + '/assets/app.js', mode: 'cors' }

  await dispatchFetch(sw, req)
  const res2 = await dispatchFetch(sw, req)
  assert.strictEqual(res2.marker, 'bundle-v1', 'offline fallback uses the last-known-good cached copy')
  assert.strictEqual(networkCalls, 2, 'network was retried, not skipped')
})

test('sw: HTML navigation is network-first, falling back to the last successfully loaded page offline', async () => {
  let networkCalls = 0
  const sw = loadSw(async () => {
    networkCalls++
    if (networkCalls === 1) return { ok: true, marker: 'page-v1' }
    throw new Error('offline')
  })
  const req = { method: 'GET', url: ORIGIN + '/', mode: 'navigate' }

  const res1 = await dispatchFetch(sw, req)
  assert.strictEqual(res1.marker, 'page-v1')

  const res2 = await dispatchFetch(sw, req)
  assert.strictEqual(res2.marker, 'page-v1', 'offline nav served the last-good page from cache')
  assert.strictEqual(networkCalls, 2, 'still tried the network first on the second request')
})

test('sw: HTML navigation falls back to the built-in offline hint when nothing is cached yet', async () => {
  const sw = loadSw(async () => { throw new Error('offline') })
  const req = { method: 'GET', url: ORIGIN + '/', mode: 'navigate' }

  const res = await dispatchFetch(sw, req)
  const text = await res.text()
  assert.match(text, /location\.reload/, 'built-in offline hint served, and it retries on its own')
})

test('sw: cross-origin requests are left alone (event.respondWith never called)', async () => {
  const sw = loadSw(async () => ({ ok: true }))
  let called = false
  sw.listeners.fetch({
    request: { method: 'GET', url: 'https://other-origin.example/x.js', mode: 'cors' },
    respondWith: () => { called = true }
  })
  assert.strictEqual(called, false)
})
