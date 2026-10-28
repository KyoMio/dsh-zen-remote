/* dsh-zen-remote · the plugin bridge's route interception, declaration-v2
 * locators (PB-21) + the deny / rewriteIds client semantics (PB-22)
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
 *
 * PB-22 pins the two remaining v2 flags on top:
 *   - a `deny: true` route answers the uniform 503 reason `route-denied`
 *     the moment a REMOTE context touches it — the request locating a
 *     virtual id, or the browser's reported CURRENT session being one —
 *     while a local session's requests land on the local handler verbatim;
 *   - a `rewriteIds: true` route's JSON answer is buffered (8 MB cap) and
 *     deep-scanned: every string EXACTLY equal to one of the request's own
 *     real ids comes back virtual (envelope fields, arrays, nested objects
 *     alike), unknown strings pass through, and over the cap — or without
 *     the declaration, or for non-JSON answers — the bytes pass verbatim.
 *
 * PB-25a pins the `{ fields }` form on top: the response's NEWLY-CREATED id
 * at a declared dot path gains its virtual shell (the value scan cannot see
 * it — the request never carried it), missing paths are no-ops, already
 * virtual / empty values are skipped, and the browser sending the wrapped id
 * back closes the loop (the follow-up request forwards the real half). The
 * buffering discipline (8 MB cap, non-JSON verbatim) is unchanged.
 *
 * PB-25b pins the value scan's widened lookup: the wiring's known-real-id
 * inventory (a lazily-read ReadonlySet — the choice over a snapshot, which
 * would be permanently empty since the streams report after the install)
 * joins the request-local mapping, so an id in the browser's view but not in
 * THIS request is rewritten too, while strings outside the set, already-
 * virtual ones and the option-absent case all stay exactly PB-22.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
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
    // PB-22 deny: a 2.1-style query route and a json-body route that refuse
    // a REMOTE context outright (local-only data behind them).
    { path: '/v2/deny-query', scope: 'session', deny: true },
    { path: '/v2/deny-body', scope: 'session', methods: ['POST'], locator: { in: 'json-body', fields: ['sessionId'] }, deny: true },
    // PB-22 deny on the tunnel: an upgrade route with the same flag never
    // opens a byte tunnel for a remote context.
    { path: '/v2/deny-ws', scope: 'session', upgrade: true, deny: true },
    // PB-22 rewriteIds: the answer's JSON is deep-scanned for the request's
    // own real ids — query locator and json-body locator alike.
    { path: '/v2/rewrite', scope: 'session', rewriteIds: true },
    { path: '/v2/rewrite-body', scope: 'session', methods: ['POST'], locator: { in: 'json-body', fields: ['sessionId', 'childId'] }, rewriteIds: true },
    // PB-25a rewriteIds { fields }: the position form — the response's
    // NEWLY-CREATED id at a declared dot path gains its virtual shell.
    { path: '/v2/create', scope: 'session', rewriteIds: { fields: ['value.childId'] } },
    { path: '/v2/create-deep', scope: 'session', rewriteIds: { fields: ['a.b.c', 'top'] } },
    // The rewrite CONTROL: the same query shape, no rewriteIds — answers
    // must pass verbatim.
    { path: '/v2/plain', scope: 'session' },
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
  const hits = { localCommand: 0, localMedia: 0, localOld: 0, localAmb: 0, localAmbSub: 0, localDenyQuery: 0, localDenyBody: 0 }
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
  // The upgrade face (PB-10): the host hands the looked-up handler the raw
  // socket; an undeclared upgrade path is destroyed.
  server.on('upgrade', (req, socket, head) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const entry = raw.upgrades.get(rawPath)
    if (entry !== undefined && typeof entry.handler === 'function') {
      entry.handler(req, socket, head)
      return
    }
    socket.destroy()
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
          raw.register({ kind: 'exact', path: '/v2/deny-body', handler: bodyEcho('localDenyBody') })
          const urlEcho = (key) => async (req, res) => {
            hits[key] += 1
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ local: true, url: req.url }))
          }
          raw.register({ kind: 'prefix', path: '/v2/media', handler: urlEcho('localMedia') })
          raw.register({ kind: 'prefix', path: '/v2/old', handler: urlEcho('localOld') })
          raw.register({ kind: 'prefix', path: '/v2/amb', handler: urlEcho('localAmb') })
          raw.register({ kind: 'exact', path: '/v2/deny-query', handler: urlEcho('localDenyQuery') })
          // The deny upgrade route's LOCAL handler: answers a plain 101 so a
          // passthrough is distinguishable from a refusal or a dead socket.
          raw.upgrades.set('/v2/deny-ws', {
            path: '/v2/deny-ws',
            handler: (req, socket) => {
              socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
              socket.end()
            },
          })
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
 * rewritten bytes crossed the boundary. `state.reply` (PB-22 tests) replaces
 * the echo with a programmable answer: (req, res, body) => void owns the
 * response entirely; unset, the built-in echo answers.
 */
function startFakeRelay() {
  const state = { hits: [], reply: undefined }
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
      if (state.reply !== undefined) {
        state.reply(req, res, body)
        return
      }
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

/** Host + relay + registry + install, wired for the v2 declaration. The
 * T62 current-session signal rides a mutable box the tests flip (`h.
 * setCurrentSession`); `undefined` — the default — is "the wiring reports
 * nothing", exactly the signal's absent shape. PB-25b: pass `{ knownIds:
 * true }` to wire the known-real-id inventory against the same kind of box
 * (`h.knownBox.value`); without it the option is ABSENT — the zero-change
 * control the PB-25b tests lean on. */
async function startV2Harness({ knownIds } = {}) {
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const relay = await startFakeRelay()
  const relayClient = fakeRelayClient(relay.__port)
  const registry = createBridgeRegistry()
  registry.register(DECLARED_V2)
  const sessionBox = { value: undefined }
  const knownBox = { value: undefined }
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: relayClient,
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'v2-panel', bridged: true, localVersion: '2.0.0', serverVersion: '2.0.0' }],
    getCurrentSession: () => sessionBox.value,
    ...(knownIds ? { getKnownRealIds: () => knownBox.value } : {}),
    log: () => {},
  })
  return {
    host,
    relay,
    relayClient,
    handle,
    knownBox,
    setCurrentSession(value) { sessionBox.value = value },
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

// ---- PB-22: deny + rewriteIds ----------------------------------------------

test('PB-22: a deny route refuses a remote context — the request id, the current session, or a zr~-shaped id — and serves local sessions untouched', async () => {
  const h = await startV2Harness()
  try {
    // Remote by the request's own id (no current-session report at all —
    // the request alone speaks).
    const remote = await h.host.get(`/v2/deny-query?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(remote.status, 503)
    assert.equal(remote.headers.get('x-zen-remote'), 'unbridged')
    assert.deepEqual(await remote.json(), { ok: false, error: { code: 'zr-plugin-unbridged', reason: 'route-denied', plugin: 'v2-panel' } })
    assert.equal(h.host.hits.localDenyQuery, 0, 'the local handler never ran')
    assert.equal(h.relay.state.hits.length, 0, 'nothing was forwarded either — deny never bridges')
    assert.equal(h.relayClient.forwarded.length, 0)

    // Remote by the browser's CURRENT session alone (no id in the request —
    // the open.external shape; only the T62 signal makes it judgeable).
    h.setCurrentSession(VB)
    const current = await h.host.get('/v2/deny-query')
    assert.equal(current.status, 503)
    assert.equal((await current.json()).error.reason, 'route-denied')
    assert.equal(h.host.hits.localDenyQuery, 0)

    // A local session's requests — with an id, without one — land on the
    // local handler exactly as if the bridge did not exist.
    h.setCurrentSession('local-current')
    const localWithId = await h.host.get('/v2/deny-query?sessionId=local-1')
    assert.equal(localWithId.status, 200)
    assert.deepEqual(await localWithId.json(), { local: true, url: '/v2/deny-query?sessionId=local-1' })
    const localNoId = await h.host.get('/v2/deny-query')
    assert.equal(localNoId.status, 200)
    assert.deepEqual(await localNoId.json(), { local: true, url: '/v2/deny-query' })
    assert.equal(h.host.hits.localDenyQuery, 2)

    // A zr~-SHAPED but unparseable id still reads as a remote-context
    // request: route-denied, never the local plugin.
    h.setCurrentSession(undefined)
    const malformed = await h.host.get('/v2/deny-query?sessionId=zr~bad')
    assert.equal(malformed.status, 503)
    assert.equal((await malformed.json()).error.reason, 'route-denied')
    assert.equal(h.host.hits.localDenyQuery, 2)
    assert.equal(h.handle.diagnostics().refusalsByReason['route-denied'], 3)
  } finally {
    await h.stop()
  }
})

test('PB-22: a deny route with a v2 locator — the current-session wall sits before body work, the request wall catches any located virtual id', async () => {
  const h = await startV2Harness()
  try {
    // Current session remote, LOCAL id in the body → refused by the
    // current-session wall BEFORE the body is judged: a CORRUPT body still
    // answers route-denied, not bad-query.
    h.setCurrentSession(VA)
    const corrupt = await h.host.get('/v2/deny-body', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sessionId": "local-x"' })
    assert.equal(corrupt.status, 503)
    assert.equal((await corrupt.json()).error.reason, 'route-denied')
    assert.equal(h.host.hits.localDenyBody, 0)
    assert.equal(h.relay.state.hits.length, 0)

    // No current-session report; the request itself carries a virtual id →
    // the request wall refuses (a mixed body would refuse the same way).
    h.setCurrentSession(undefined)
    const remote = await h.host.get('/v2/deny-body', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: VA }) })
    assert.equal(remote.status, 503)
    assert.equal((await remote.json()).error.reason, 'route-denied')
    assert.equal(h.relayClient.forwarded.length, 0)

    // Local session, local id → the local handler, original bytes replayed.
    const localBody = JSON.stringify({ sessionId: 'local-x' })
    const local = await h.host.get('/v2/deny-body', { method: 'POST', headers: { 'content-type': 'application/json' }, body: localBody })
    assert.equal(local.status, 200)
    assert.deepEqual(await local.json(), { local: true, body: localBody })
    assert.equal(h.host.hits.localDenyBody, 1)
  } finally {
    await h.stop()
  }
})

test("PB-22: a rewriteIds route deep-scans its JSON answer — the request's own ids come back virtual from envelope fields, arrays and nested objects; unknown strings pass", async () => {
  const h = await startV2Harness()
  try {
    // The envelope shape that beat the field-level rewriter (f6b570f): the
    // id sits under {ok, value:{childId}}, not on a declared field.
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: { childId: 'session-a' } }))
    }
    const res = await h.host.get(`/v2/rewrite?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.deepEqual(JSON.parse(text), { ok: true, value: { childId: VA } }, 'the envelope\'s real id came back virtual')
    assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(text), 'the content-length is the REWRITTEN byte count')

    // Two ids in the request (json-body locator): both known everywhere in
    // the answer — envelope fields, array items, nested objects — while
    // same-shaped unknowns pass untouched (exact equality only, no shape
    // guessing).
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        value: {
          childId: 'session-b',
          items: ['session-a', 'session-b', 'session-unknown', 'session-a-suffix'],
          deep: { inner: 'session-a' },
          count: 2,
        },
      }))
    }
    const res2 = await h.host.get('/v2/rewrite-body', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: VA, childId: VB }) })
    assert.equal(res2.status, 200)
    // 'session-unknown' / 'session-a-suffix' passing through verbatim IS the documented rewriteIds boundary (docs/plugin-bridge.md field table): a real id the request never carried — sidechat.start's new-childId shape — reaches the browser untouched by design, not an oversight.
    assert.deepEqual(await res2.json(), {
      ok: true,
      value: {
        childId: VB,
        items: [VA, VB, 'session-unknown', 'session-a-suffix'],
        deep: { inner: VA },
        count: 2,
      },
    })
    assert.equal(h.host.hits.localCommand, 0)
  } finally {
    await h.stop()
  }
})

test('PB-22: a deny upgrade route refuses a remote context before any tunnel opens; a local session upgrades through', async () => {
  const h = await startV2Harness()
  try {
    // Raw-socket speak: the upgrade request bytes, the whole answer back.
    const speak = (target) => new Promise((resolve, reject) => {
      const socket = net.connect(h.host.port, '127.0.0.1', () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`)
      })
      let data = ''
      socket.on('data', (chunk) => { data += chunk.toString('utf8') })
      socket.on('close', () => resolve(data))
      socket.on('error', reject)
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade answer timed out')) }, 5000)
      socket.on('close', () => clearTimeout(timer))
    })
    // Remote by the request's own id: the uniform 503 on the raw socket —
    // the handshake never completes and no tunnel was ever opened (the fake
    // relay client has no tunnel door; a try would have destroyed the
    // socket with no 503 bytes).
    const refused = await speak(`/v2/deny-ws?sessionId=${encodeURIComponent(VA)}`)
    assert.match(refused, /^HTTP\/1\.1 503/)
    assert.match(refused, /x-zen-remote: unbridged/)
    assert.match(refused, /"reason":"route-denied"/)
    assert.equal(h.relay.state.hits.length, 0)

    // Remote by the current session alone (no id in the request at all).
    h.setCurrentSession(VB)
    const refusedCurrent = await speak('/v2/deny-ws')
    assert.match(refusedCurrent, /"reason":"route-denied"/)

    // A local session's upgrade passes through to the local handler's 101.
    h.setCurrentSession(undefined)
    const local = await speak('/v2/deny-ws')
    assert.match(local, /^HTTP\/1\.1 101/)
  } finally {
    await h.stop()
  }
})

test('PB-22: an over-cap (>8 MB) JSON answer passes through untouched — ids and all', async () => {
  const h = await startV2Harness()
  try {
    const pad = 'x'.repeat(9 * 1024 * 1024)
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: { pad, childId: 'session-a' } }))
    }
    const res = await h.host.get(`/v2/rewrite?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(res.status, 200)
    const parsed = await res.json()
    assert.equal(parsed.value.childId, 'session-a', 'NOT virtualized — past the buffer cap the answer is never rewritten')
    assert.equal(parsed.value.pad.length, pad.length, 'the body crossed byte-intact')
  } finally {
    await h.stop()
  }
})

test('PB-22: answers of routes without rewriteIds — and non-JSON answers of rewrite routes — pass verbatim', async () => {
  const h = await startV2Harness()
  try {
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: { childId: 'session-a' } }))
    }
    // The control: the SAME answer shape, no rewriteIds declared → the real
    // id reaches the browser untouched (behavior unchanged, PB-22 or not).
    const plain = await h.host.get(`/v2/plain?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(plain.status, 200)
    assert.deepEqual(await plain.json(), { ok: true, value: { childId: 'session-a' } })

    // A rewrite route's non-JSON answer streams verbatim too — the scan is
    // strictly for JSON answers.
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('session-a')
    }
    const text = await h.host.get(`/v2/rewrite?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(text.status, 200)
    assert.equal(text.headers.get('content-type'), 'text/plain')
    assert.equal(await text.text(), 'session-a')
  } finally {
    await h.stop()
  }
})

// ---- PB-25a: rewriteIds { fields } — the position form ----------------------

test('PB-25a: a rewriteIds fields route wraps the NEWLY-created id at its declared position; the true form beside it does not', async () => {
  const h = await startV2Harness()
  try {
    // 'session-new' was never in the request — only the position declaration
    // can see it. The SAME string under an UNDECLARED key stays raw:
    // positions are declared, never guessed.
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: { childId: 'session-new' }, shadow: 'session-new' }))
    }
    const wrapped = toVirtual(SERVER_ID, 'session-new')
    const res = await h.host.get(`/v2/create?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.deepEqual(JSON.parse(text), { ok: true, value: { childId: wrapped }, shadow: 'session-new' },
      "the declared position wrapped; the undeclared same string did NOT")
    assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(text), 'the content-length is the REWRITTEN byte count')

    // The control: the SAME answer shape on a `true`-form route — the new id
    // reaches the browser raw (the value scan's documented boundary), while
    // the request's own id still comes back virtual from any position.
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: { childId: 'session-new' }, echo: 'session-a' }))
    }
    const trueForm = await h.host.get(`/v2/rewrite?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(trueForm.status, 200)
    assert.deepEqual(await trueForm.json(), { ok: true, value: { childId: 'session-new' }, echo: VA })

    // The closed loop: the browser sends the wrapped id back; the bridge
    // reads it as virtual and forwards the real half to the plugin.
    h.relay.state.reply = undefined
    const follow = await h.host.get(`/v2/plain?sessionId=${encodeURIComponent(wrapped)}`)
    assert.equal(follow.status, 200)
    assert.equal(h.relay.state.hits.at(-1).zrQuery, 'sessionId=session-new')
  } finally {
    await h.stop()
  }
})

test('PB-25a: value scan and declared positions coexist — every string rewritten exactly once, at depth', async () => {
  const h = await startV2Harness()
  try {
    // a.b.c is DECLARED and holds a KNOWN id: rewritten once, to the very
    // form the value scan produces — never a double shell. top is DECLARED
    // with a fresh id (the position wrap's own catch); a.b.d is undeclared
    // and known (the value scan); a.b.e is undeclared and fresh (nobody's).
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        top: 'session-new',
        a: { b: { c: 'session-a', d: 'session-a', e: 'session-new' } },
      }))
    }
    const res = await h.host.get(`/v2/create-deep?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      top: toVirtual(SERVER_ID, 'session-new'),
      a: { b: { c: VA, d: VA, e: 'session-new' } },
    })
  } finally {
    await h.stop()
  }
})

test('PB-25a: missing paths, walks through scalars and arrays, already-virtual and empty values are all no-ops', async () => {
  const h = await startV2Harness()
  try {
    const reply = (body) => {
      h.relay.state.reply = (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
    }
    // A declared path the answer never grew: a structural no-op.
    reply({ ok: true, unrelated: 'x' })
    const missing = await h.host.get(`/v2/create-deep?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(missing.status, 200)
    assert.deepEqual(await missing.json(), { ok: true, unrelated: 'x' })

    // The walk hits a SCALAR (`a` is a string) or an ARRAY (the declaration
    // refuses numeric segments — arrays are the value scan's business): no
    // position write, the answer passes structurally unchanged.
    reply({ a: 'scalar' })
    const scalar = await h.host.get(`/v2/create-deep?sessionId=${encodeURIComponent(VA)}`)
    assert.deepEqual(await scalar.json(), { a: 'scalar' })
    reply({ a: { b: ['session-new'] } })
    const arrayWalk = await h.host.get(`/v2/create-deep?sessionId=${encodeURIComponent(VA)}`)
    assert.deepEqual(await arrayWalk.json(), { a: { b: ['session-new'] } })
    // A NULL mid-path segment (a: null) walks the same dead branch — the
    // review's adversarial shape, pinned here.
    reply({ a: null })
    const nullWalk = await h.host.get(`/v2/create-deep?sessionId=${encodeURIComponent(VA)}`)
    assert.deepEqual(await nullWalk.json(), { a: null })

    // Already-virtual and empty values ON the declared path: skipped, never
    // double-wrapped, never conjured.
    reply({ ok: true, value: { childId: VB } })
    const virtual = await h.host.get(`/v2/create?sessionId=${encodeURIComponent(VA)}`)
    assert.deepEqual(await virtual.json(), { ok: true, value: { childId: VB } })
    reply({ ok: true, value: { childId: '' } })
    const empty = await h.host.get(`/v2/create?sessionId=${encodeURIComponent(VA)}`)
    assert.deepEqual(await empty.json(), { ok: true, value: { childId: '' } })
  } finally {
    await h.stop()
  }
})

test('PB-25a: the buffering discipline is unchanged for a fields route — over-cap and non-JSON answers pass verbatim', async () => {
  const h = await startV2Harness()
  try {
    const pad = 'x'.repeat(9 * 1024 * 1024)
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: { pad, childId: 'session-new' } }))
    }
    const over = await h.host.get(`/v2/create?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(over.status, 200)
    const parsed = await over.json()
    assert.equal(parsed.value.childId, 'session-new', 'NOT wrapped — past the buffer cap the answer is never rewritten')
    assert.equal(parsed.value.pad.length, pad.length, 'the body crossed byte-intact')

    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('session-new')
    }
    const plain = await h.host.get(`/v2/create?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(plain.status, 200)
    assert.equal(await plain.text(), 'session-new')
  } finally {
    await h.stop()
  }
})

// ---- PB-25b: the known-real-id inventory widens the by-value scan -----------

test('PB-25b: an id in the KNOWN inventory but never in the request is rewritten; strings outside the set pass untouched', async () => {
  const h = await startV2Harness({ knownIds: true })
  try {
    h.knownBox.value = new Set(['session-live', 'session-other'])
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        value: {
          key: 'session-live',
          list: ['session-live', 'session-ghost', 'session-live-suffix'],
          deep: { inner: 'session-live' },
          requested: 'session-a',
          alreadyVirtual: VA,
          count: 0,
        },
      }))
    }
    // The request carries ONLY session-a — session-live comes from the
    // inventory (the subagents.live object keys / workflows.list rows
    // shape: in the browser's view, not in this request). 'session-ghost'
    // and 'session-live-suffix' are outside the set: exact equality only,
    // the same no-shape-guessing boundary as PB-22. The already-virtual
    // string is never re-wrapped.
    const res = await h.host.get(`/v2/rewrite?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      ok: true,
      value: {
        key: toVirtual(SERVER_ID, 'session-live'),
        list: [toVirtual(SERVER_ID, 'session-live'), 'session-ghost', 'session-live-suffix'],
        deep: { inner: toVirtual(SERVER_ID, 'session-live') },
        requested: VA,
        alreadyVirtual: VA,
        count: 0,
      },
    })

    // The json-body locator half reads the same inventory.
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, row: 'session-live', other: 'session-ghost' }))
    }
    const res2 = await h.host.get('/v2/rewrite-body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: VA }),
    })
    assert.equal(res2.status, 200)
    assert.deepEqual(await res2.json(), {
      ok: true,
      row: toVirtual(SERVER_ID, 'session-live'),
      other: 'session-ghost',
    })
  } finally {
    await h.stop()
  }
})

test('PB-25b: the inventory is read LIVE per answer — a stream refresh replaces the set and the next answer obeys it', async () => {
  const h = await startV2Harness({ knownIds: true })
  try {
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: { old: 'session-live', fresh: 'session-fresh' } }))
    }
    h.knownBox.value = new Set(['session-live'])
    const first = await h.host.get(`/v2/rewrite?sessionId=${encodeURIComponent(VA)}`)
    assert.deepEqual(await first.json(), {
      ok: true,
      value: { old: toVirtual(SERVER_ID, 'session-live'), fresh: 'session-fresh' },
    })
    // The stream refreshed (the merger's replace-style report — the
    // merge-streams seam pinned in merge-streams.test.cjs): session-live
    // left the inventory, session-fresh entered. The SAME answer shape now
    // rewrites the other id — a snapshot taken at install could never see
    // either, which is why the option is a lazy getter.
    h.knownBox.value = new Set(['session-fresh'])
    const second = await h.host.get(`/v2/rewrite?sessionId=${encodeURIComponent(VA)}`)
    assert.deepEqual(await second.json(), {
      ok: true,
      value: { old: 'session-live', fresh: toVirtual(SERVER_ID, 'session-fresh') },
    })
  } finally {
    await h.stop()
  }
})

test('PB-25b: without getKnownRealIds wired the scan stays request-local — an inventory-shaped real id passes verbatim', async () => {
  const h = await startV2Harness()
  try {
    h.relay.state.reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: { mine: 'session-a', theirs: 'session-live' } }))
    }
    const res = await h.host.get(`/v2/rewrite?sessionId=${encodeURIComponent(VA)}`)
    assert.equal(res.status, 200)
    assert.deepEqual(
      await res.json(),
      { ok: true, value: { mine: VA, theirs: 'session-live' } },
      'the option is absent: only the request-carried id is rewritten (PB-22 behavior verbatim)',
    )
  } finally {
    await h.stop()
  }
})
