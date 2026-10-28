/* dsh-zen-remote · the plugin bridge's route interception, declaration-v2
 * locators (PB-21)
 *
 * The cooperative surrogate generalized: a route declared with a v2
 * `locator` (json-body, or path-segment on a `prefix: true` route) runs the
 * SAME adapter-core locate → classify → rewrite functions the adapters run,
 * through the route's adapter-core view. Pinned here end to end over a real
 * http server + the fake relay:
 *   - json-body locating (sessionId/childId dual fields) forwards with the
 *     ids swapped for their real halves, every other field byte-intact;
 *   - a prefix route's path segment decodes once and the rewrite RE-ENCODES
 *     the real id (a real id with a space and a slash proves it);
 *   - a mixed verdict (one virtual id, one plain) refuses bad-query —
 *     nothing local, nothing forwarded;
 *   - no id / all-real ids stay with the local handler, body replayed;
 *   - an over-max body answers the cooperative 413 shape (buffered and
 *     chunked alike);
 *   - a 2.1-style query locator on a prefix route forwards the FULL matched
 *     pathname, and an ambiguous hit resolves in declaration order.
 * The 2.1 query-locator behavior itself is pinned by
 * plugin-route-intercept.test.cjs, untouched by this task.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { installPluginRouteIntercept } = require('../lib/plugin-route-intercept.js')
const { createBridgeRegistry, normalizeDeclaration } = require('../lib/plugin-bridge.js')
const { toVirtual } = require('../lib/virtual-id.js')

const DECLARED_V2 = {
  plugin: 'v2-panel',
  version: '2.0.0',
  routes: [
    // json-body locating: BOTH fields count when present (the adapter-core
    // rule), so one virtual + one plain id is a mixed verdict.
    { path: '/v2/command', scope: 'session', methods: ['POST'], maxBody: 4096, locator: { in: 'json-body', fields: ['sessionId', 'childId'] } },
    // path-segment locating on a prefix route: index 0 = the first segment
    // after the declared path.
    { path: '/v2/media', scope: 'session', prefix: true, locator: { in: 'path-segment', index: 0 } },
    // The 2.1 query locator on a PREFIX route: the forward must carry the
    // full matched pathname, not the declared base.
    { path: '/v2/old', scope: 'session', prefix: true },
    // Ambiguity: /v2/amb/sub matches BOTH routes; declaration order (the
    // path-sorted normalization) decides — the earlier prefix base wins.
    { path: '/v2/amb', scope: 'session', prefix: true },
    { path: '/v2/amb/sub', scope: 'session', methods: ['POST'], locator: { in: 'json-body', fields: ['sessionId'] } },
    // A streaming (non-buffered) body on a path-segment route rides the
    // cooperative counting gate.
    { path: '/v2/upload', scope: 'session', prefix: true, methods: ['POST'], maxBody: 1024, locator: { in: 'path-segment', index: 0 } },
  ],
}
const V2_DIGEST = normalizeDeclaration(DECLARED_V2).digest

const SERVER_ID = 'abcd1234'
const VA = toVirtual(SERVER_ID, 'session-a')
const VB = toVirtual(SERVER_ID, 'session-b')

/**
 * The fake host webServer — the same shape plugin-route-intercept.test.cjs
 * drives: real http server, host-shaped handle (raw undecoded pathname,
 * `this.match(rawPath)`, route.handler, else fallback), exact + prefix
 * tables, hit counters as the security observable.
 */
function startFakeHost() {
  const hits = { localCommand: 0, localMedia: 0, localOld: 0, localAmb: 0, localAmbSub: 0 }
  let fallback = undefined
  const raw = {
    exact: new Map(),
    prefixes: new Map(),
    upgrades: new Map(),
    match(pathname) {
      const exact = this.exact.get(pathname)
      if (exact !== undefined) return exact
      let best
      for (const [prefix, route] of this.prefixes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
        if (best === undefined || prefix.length > best.path.length) best = route
      }
      return best
    },
    register(route) {
      const table = route.kind === 'exact' ? this.exact : this.prefixes
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
    registerFallback(handler) {
      fallback = handler
      return () => { fallback = undefined }
    },
  }
  const server = http.createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    Promise.resolve(raw.match(rawPath)).then(async (route) => {
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      if (fallback !== undefined) {
        await fallback(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    }).catch(() => { try { res.destroy() } catch { /* gone */ } })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        raw,
        hits,
        port,
        stop: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }),
        /** The LOCAL plugin routes the bridge must guard. The json-body ones
         * echo the request body back, so a test can prove the replay handed
         * the handler the exact original bytes. */
        registerLocalPlugin() {
          const bodyEcho = (key) => async (req, res) => {
            hits[key] += 1
            const chunks = []
            req.on('data', (c) => chunks.push(c))
            req.on('end', () => {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ local: true, body: Buffer.concat(chunks).toString('utf8') }))
            })
          }
          raw.register({ kind: 'exact', path: '/v2/command', handler: bodyEcho('localCommand') })
          raw.register({ kind: 'exact', path: '/v2/amb/sub', handler: bodyEcho('localAmbSub') })
          const urlEcho = (key) => async (req, res) => {
            hits[key] += 1
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ local: true, url: req.url }))
          }
          raw.register({ kind: 'prefix', path: '/v2/media', handler: urlEcho('localMedia') })
          raw.register({ kind: 'prefix', path: '/v2/old', handler: urlEcho('localOld') })
          raw.register({ kind: 'prefix', path: '/v2/amb', handler: urlEcho('localAmb') })
        },
        get: (pathWithQuery, { headers = {}, signal, method, body } = {}) =>
          fetch(`http://127.0.0.1:${port}${pathWithQuery}`, {
            method: method ?? 'GET',
            headers,
            ...(body !== undefined ? { body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } : {}),
            signal,
          }),
      })
    })
  })
}

/**
 * The fake relay: records every arrival (forwarded coordinates + the body),
 * echoes a json-body forward verbatim so the test can prove the exact
 * rewritten bytes crossed the boundary.
 */
function startFakeRelay() {
  const state = { hits: [] }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay.internal')
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      state.hits.push({
        method: req.method,
        plugin: req.headers['x-zr-plugin'],
        version: req.headers['x-zr-plugin-version'],
        digest: req.headers['x-zr-plugin-digest'],
        zrPath: req.headers['x-zr-path'],
        zrQuery: req.headers['x-zr-query'],
        ct: req.headers['content-type'],
        body,
      })
      if (url.pathname === '/_dsh/zen-remote/relay/v1/plugin' && req.headers['x-zr-path'] === '/v2/command') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ echoed: body, ct: req.headers['content-type'] }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ remote: true }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        __port: port,
        state,
        stop: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }),
      })
    })
  })
}

/** The relay client stub — the same contract mirror
 * plugin-route-intercept.test.cjs uses: every call recorded, a caller abort
 * is a caller verdict (never offline). */
function fakeRelayClient(relayPort) {
  const forwarded = []
  const offlineVerdicts = []
  const client = {
    forwarded,
    offlineVerdicts,
    pluginRequest: async (request, signal) => {
      const hasBody = request.body !== undefined && request.body !== null
      forwarded.push({
        method: request.method ?? 'GET',
        contentType: request.contentType,
        contentLength: request.contentLength,
        path: request.path,
        query: request.query,
      })
      const init = {
        method: request.method ?? 'POST',
        headers: {
          accept: request.accept ?? 'application/json',
          ...(hasBody && request.contentType !== undefined ? { 'content-type': request.contentType } : {}),
          'x-zr-plugin': request.plugin,
          'x-zr-plugin-version': request.version,
          'x-zr-plugin-digest': request.digest,
          'x-zr-path': request.path,
          'x-zr-query': request.query,
        },
        ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
        signal,
      }
      try {
        return await fetch(`http://127.0.0.1:${relayPort}/_dsh/zen-remote/relay/v1/plugin`, init)
      } catch (error) {
        if (signal?.aborted) {
          throw Object.assign(new Error('aborted'), { code: 'aborted' })
        }
        offlineVerdicts.push({ code: 'offline', message: String((error && error.message) ?? error) })
        throw Object.assign(new Error('offline'), { code: 'offline' })
      }
    },
  }
  return client
}

/** Host + relay + registry + install, wired for the v2 declaration. */
async function startV2Harness() {
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const relay = await startFakeRelay()
  const relayClient = fakeRelayClient(relay.__port)
  const registry = createBridgeRegistry()
  registry.register(DECLARED_V2)
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: relayClient,
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'v2-panel', bridged: true, localVersion: '2.0.0', serverVersion: '2.0.0' }],
    log: () => {},
  })
  return {
    host,
    relay,
    relayClient,
    handle,
    stop: async () => {
      handle.uninstall()
      await relay.stop()
      await host.stop()
    },
  }
}

test('PB-21: json-body locating forwards with every virtual id swapped for its real half, other fields byte-intact', async () => {
  const h = await startV2Harness()
  try {
    const body = { sessionId: VA, childId: VB, title: '新任务', count: 3 }
    const res = await h.host.get('/v2/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(res.status, 200)
    const realJson = JSON.stringify({ sessionId: 'session-a', childId: 'session-b', title: '新任务', count: 3 })
    assert.deepEqual(JSON.parse(await res.text()), { echoed: realJson, ct: 'application/json' },
      'the body crossed with both ids real, key order and every other field byte-intact')
    assert.equal(h.host.hits.localCommand, 0, 'the local handler never ran')
    const forward = h.relayClient.forwarded[0]
    assert.equal(forward.method, 'POST')
    assert.equal(forward.path, '/v2/command')
    assert.equal(forward.query, '')
    assert.equal(forward.contentType, 'application/json', 'the content type passed through')
    assert.equal(forward.contentLength, Buffer.byteLength(realJson), 'the REWRITTEN byte count is the declared length')
    const hit = h.relay.state.hits[0]
    assert.equal(hit.plugin, 'v2-panel')
    assert.equal(hit.version, '2.0.0', 'the DECLARATION version rides the forward')
    assert.equal(hit.digest, V2_DIGEST, 'the DECLARATION digest rides the forward')
    assert.equal(hit.zrPath, '/v2/command')

    // ONE field present still forwards (every PRESENT field counts), and a
    // field the request never carried is not conjured by the rewrite.
    const single = await h.host.get('/v2/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ childId: VB, note: 'x' }) })
    assert.equal(single.status, 200)
    assert.deepEqual(JSON.parse(await single.text()).echoed, JSON.stringify({ childId: 'session-b', note: 'x' }))
    assert.equal(h.host.hits.localCommand, 0)
    assert.equal(h.handle.diagnostics().forwarded, 2)
  } finally {
    await h.stop()
  }
})

test('PB-21: a mixed verdict (one virtual id, one plain) refuses bad-query — nothing local, nothing forwarded', async () => {
  const h = await startV2Harness()
  try {
    const res = await h.host.get('/v2/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: VA, childId: 'plain-local-child' }) })
    assert.equal(res.status, 503)
    assert.equal(res.headers.get('x-zen-remote'), 'unbridged')
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'zr-plugin-unbridged', reason: 'bad-query', plugin: 'v2-panel' } })
    assert.equal(h.host.hits.localCommand, 0, 'the mixed request never reached the local plugin')
    assert.equal(h.relay.state.hits.length, 0, 'and never left for the relay either')
    assert.equal(h.relayClient.forwarded.length, 0)
    assert.equal(h.handle.diagnostics().refusalsByReason['bad-query'], 1)
  } finally {
    await h.stop()
  }
})

test('PB-21: no id or all-real ids stay with the local handler, body replayed byte-intact; a corrupted body refuses', async () => {
  const h = await startV2Harness()
  try {
    // All-real ids: the LOCAL handler ran and read the EXACT original bytes
    // (the classify-consumed body replayed behind the original metadata).
    const localBody = JSON.stringify({ sessionId: 'session-local', childId: 'child-local', note: 'n' })
    const local = await h.host.get('/v2/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: localBody })
    assert.equal(local.status, 200)
    assert.deepEqual(await local.json(), { local: true, body: localBody })
    assert.equal(h.host.hits.localCommand, 1)
    assert.equal(h.relay.state.hits.length, 0)

    // No id fields at all: local business too.
    const noId = await h.host.get('/v2/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) })
    assert.equal(noId.status, 200)
    assert.equal(h.host.hits.localCommand, 2)

    // A bodyless GET on the json-body route: nothing locates → local.
    const bodyless = await h.host.get('/v2/command')
    assert.equal(bodyless.status, 200)
    assert.equal(h.host.hits.localCommand, 3)

    // A present body that does not parse refuses — even a local session's —
    // rather than reaching the local plugin with a body the locate could
    // not judge (the adapter half's shared rule).
    const corrupt = await h.host.get('/v2/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sessionId": "zr~abcd1234~a"' })
    assert.equal(corrupt.status, 503)
    assert.equal((await corrupt.json()).error.reason, 'bad-query')
    assert.equal(h.host.hits.localCommand, 3, 'the corrupt body never reached the local handler')
    assert.equal(h.relay.state.hits.length, 0)
  } finally {
    await h.stop()
  }
})

test("PB-21: a prefix route's path segment decodes once and the rewrite re-encodes the real id", async () => {
  const h = await startV2Harness()
  try {
    // A real id with characters that MUST re-encode: the rewrite went
    // through encodeURIComponent, not a raw splice.
    const segVirtual = toVirtual(SERVER_ID, 'session a/b')
    const res = await h.host.get(`/v2/media/${encodeURIComponent(segVirtual)}/rest`)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(await res.text()), { remote: true })
    assert.equal(h.host.hits.localMedia, 0, 'the local media handler never ran')
    const hit = h.relay.state.hits[0]
    assert.equal(hit.plugin, 'v2-panel')
    assert.equal(hit.digest, V2_DIGEST)
    assert.equal(hit.zrPath, '/v2/media/session%20a%2Fb/rest', 'the FULL matched path, real id re-encoded')
    assert.equal(hit.zrQuery, '')

    // A plain (non-virtual) segment: the local handler, original URL.
    const localSeg = await h.host.get('/v2/media/local-9/rest')
    assert.equal(localSeg.status, 200)
    assert.deepEqual(await localSeg.json(), { local: true, url: '/v2/media/local-9/rest' })
    assert.equal(h.host.hits.localMedia, 1)

    // The bare prefix (no tail at all): nothing locates → local.
    const bare = await h.host.get('/v2/media')
    assert.equal(bare.status, 200)
    assert.equal(h.host.hits.localMedia, 2)
    assert.equal(h.relay.state.hits.length, 1)
  } finally {
    await h.stop()
  }
})

test('PB-21: a query locator on a prefix route forwards the FULL matched pathname; an ambiguous hit follows declaration order', async () => {
  const h = await startV2Harness()
  try {
    const res = await h.host.get(`/v2/old/tail/deeper?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(res.status, 200)
    assert.equal(h.host.hits.localOld, 0)
    const hit = h.relay.state.hits[0]
    assert.equal(hit.zrPath, '/v2/old/tail/deeper', 'the declared base alone would have lost the tail')
    assert.equal(hit.zrQuery, 'sessionId=session-a', 'the virtual id restored to its real half in the query')

    // A local session on the same prefix route: passthrough untouched.
    const local = await h.host.get('/v2/old/tail?sessionId=local-s')
    assert.equal(local.status, 200)
    assert.deepEqual(await local.json(), { local: true, url: '/v2/old/tail?sessionId=local-s' })
    assert.equal(h.host.hits.localOld, 1)

    // /v2/amb/sub matches BOTH the '/v2/amb' prefix (query locator, GET)
    // and the '/v2/amb/sub' exact (json-body, POST): declaration order —
    // the earlier route — wins, so the GET with a virtual query id
    // forwards through the PREFIX route's surrogate.
    const amb = await h.host.get(`/v2/amb/sub?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(amb.status, 200)
    assert.equal(h.host.hits.localAmbSub, 0, 'the later exact route never got the request')
    assert.equal(h.host.hits.localAmb, 0, 'and neither did any local handler')
    const ambHit = h.relay.state.hits.at(-1)
    assert.equal(ambHit.zrPath, '/v2/amb/sub')
    assert.equal(ambHit.zrQuery, 'sessionId=session-a')
  } finally {
    await h.stop()
  }
})

test('PB-21: an over-max body on a json-body route answers the cooperative 413, plugin and relay untouched', async () => {
  const h = await startV2Harness()
  try {
    const big = JSON.stringify({ sessionId: VA, payload: 'x'.repeat(5000) })
    const res = await h.host.get('/v2/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })
    assert.equal(res.status, 413)
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'zr-plugin-body-too-large' } })
    assert.equal(h.host.hits.localCommand, 0)
    assert.equal(h.relay.state.hits.length, 0)
    assert.equal(h.relayClient.forwarded.length, 0)
    assert.equal(h.handle.diagnostics().refusalsByReason['body-too-large'], 1)
  } finally {
    await h.stop()
  }
})

test('PB-21: a path-segment route streams its body through the counting gate — a legal one forwards, an over-max chunked one trips the local 413', async () => {
  const h = await startV2Harness()
  try {
    // The legal body streams through and arrives verbatim.
    const ok = await h.host.get(`/v2/upload/${encodeURIComponent(VA)}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'tiny' })
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(await ok.text()), { remote: true })
    const okHit = h.relay.state.hits[0]
    assert.equal(okHit.zrPath, '/v2/upload/session-a', 'the segment rewritten to the real id')
    assert.equal(okHit.body, 'tiny')
    assert.equal(h.host.hits.localMedia, 0)

    // A TRUE no-Content-Length body outgrowing maxBody mid-forward: the
    // gate's LOCAL flag answers the 413, never an offline verdict.
    const chunked = await h.host.get(`/v2/upload/${encodeURIComponent(VA)}`, {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(2000)))
          controller.close()
        },
      }),
    })
    assert.equal(chunked.status, 413, 'the chunked over-max body answers the local 413')
    assert.deepEqual(await chunked.json(), { ok: false, error: { code: 'zr-plugin-body-too-large' } })
    assert.equal(h.relayClient.offlineVerdicts.length, 0, 'the gate trip is a caller verdict, never offline')
    assert.equal(h.relay.state.hits.filter((entry) => entry.zrPath.startsWith('/v2/upload')).length, 1, 'only the legal body was ever forwarded')
  } finally {
    await h.stop()
  }
})
