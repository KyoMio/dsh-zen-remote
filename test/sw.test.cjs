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
 * v3 must only cache-first the true static shell (manifest/icons/offline
 * fallback) and network-first everything else.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SW_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'sw.js'), 'utf8')
const ORIGIN = 'https://x.test'

function loadSw(fetchImpl) {
  const listeners = {}
  const cacheStores = new Map() // cacheName -> Map(key -> response)
  const keyOf = (reqOrKey) => (typeof reqOrKey === 'string' ? reqOrKey : reqOrKey.url)
  const caches = {
    open: async (name) => {
      if (!cacheStores.has(name)) cacheStores.set(name, new Map())
      const store = cacheStores.get(name)
      return {
        match: async (reqOrKey) => store.get(keyOf(reqOrKey)),
        put: async (reqOrKey, res) => { store.set(keyOf(reqOrKey), res) },
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
  return { listeners, caches, fetchCalls }
}

// Drives the captured 'fetch' listener the way the real dispatcher would:
// event.respondWith(promise) synchronously stashes the promise to await.
function dispatchFetch(sw, req) {
  let respondedWith
  sw.listeners.fetch({ request: req, respondWith: (p) => { respondedWith = Promise.resolve(p) } })
  return respondedWith
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

test('sw: DSH client bundle JS/CSS is network-first — regression guard for "new DOM + old CSS"', async () => {
  let networkCalls = 0
  const responses = [{ ok: true, marker: 'bundle-v1' }, { ok: true, marker: 'bundle-v2-deployed' }]
  const sw = loadSw(async () => { const r = responses[Math.min(networkCalls, responses.length - 1)]; networkCalls++; return r })
  const req = { method: 'GET', url: ORIGIN + '/assets/app.abc123.css', mode: 'cors' }

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
