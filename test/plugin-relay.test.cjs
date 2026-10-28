/* dsh-zen-remote · the relay's plugin forwarding route (PB-3)
 *
 * Boots createRelayHandler alone (the relay-server.test.cjs discipline) over
 * a REAL declaration registry (lib/plugin-bridge.js) and a loopback executor
 * pointed at a local fake plugin server — the one that plays DSH: `/?token=`
 * exchanges for a cookie, `/panel/*` demands it, and records every raw
 * request fact. Covers the whole validation chain (one case per refusal
 * code), the parse-once query discipline (a control-character key must
 * survive end to end — the T41b bypass shape), the consent wall (session
 * routes pass without consent, server routes do not), the per-device busy
 * budget (8 held + 1 refused + recovery), ordered NDJSON streaming, and the
 * sub-client hang-up reaching the plugin as an abort.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRelayHandler, loadServerId } = require('../lib/relay-server.js')
const { createShareStore } = require('../lib/share-store.js')
const { createBridgeRegistry, normalizeDeclaration } = require('../lib/plugin-bridge.js')
const { createPluginLoopback } = require('../lib/plugin-loopback.js')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-plugin-relay-'))
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

const SECRET = 'a1b2c3d4'.repeat(8)
const AUTH = {
  'x-zen-remote-secret': SECRET,
  'x-zen-remote-via': 'gateway',
  'x-zen-remote-role': 'desktop-client',
  'x-zen-remote-device': 'device-9',
}

/** The declaration both ends register, in its normalized (digest-carrying) form. */
const DECLARATION_INPUT = {
  plugin: 'test-panel',
  version: '1.0.0',
  routes: [
    { path: '/panel/data', scope: 'session' },
    { path: '/panel/all', scope: 'server' },
    { path: '/panel/stream', scope: 'session', stream: true },
    { path: '/panel/hold', scope: 'session' },
  ],
}

/**
 * The fake plugin server (playing DSH): token exchange at `/`, cookie-
 * guarded routes under `/panel/`, a holdable response, and an NDJSON route.
 * Every request's facts land in `state`.
 */
function startFakePluginServer() {
  const state = { requests: [], aborted: [] }
  let holds = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://plugin.internal')
    if (url.pathname === '/') {
      res.writeHead(303, { 'set-cookie': 'dsh-auth=ok; Path=/', location: '/' })
      res.end()
      return
    }
    const entry = { url: req.url ?? '/', host: String(req.headers.host ?? ''), cookie: String(req.headers.cookie ?? ''), accept: req.headers.accept, range: req.headers.range, headers: req.headers, method: req.method, contentType: req.headers['content-type'], body: '', bodyDone: false, aborted: false }
    state.requests.push(entry)
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { entry.body = Buffer.concat(chunks).toString('utf8'); entry.bodyDone = true })
    req.on('error', () => { entry.aborted = true })
    req.on('close', () => { if (!entry.bodyDone) entry.aborted = true })
    if (String(req.headers.cookie ?? '') !== 'dsh-auth=ok') {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    req.on('close', () => { if (!res.writableEnded) state.aborted.push(url.pathname) })
    if (url.pathname === '/panel/hold') {
      holds.push(res)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('held')
      return
    }
    if (url.pathname === '/panel/stream') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"n":1}\n')
      setTimeout(() => res.write('{"n":2}\n'), 10)
      setTimeout(() => { res.write('{"n":3}\n'); res.end() }, 20)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ panel: true, path: url.pathname, query: url.search }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        state,
        releaseOne: () => { const res = holds.shift(); if (res !== undefined) res.end() },
        releaseAll: () => { for (const res of holds.splice(0)) res.end() },
        stop: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }),
        target: () => ({ protocol: 'http:', port }),
        tokenUrl: () => `http://127.0.0.1:${port}/?token=t`,
      })
    })
  })
}

/**
 * One relay handler wired for the plugin bridge: a real registry holding
 * DECLARATION_INPUT, a consent map the test can flip live, and a loopback
 * over the fake plugin server. `overrides` re-shapes the wiring per test.
 */
async function makeWiring(name, { consent = {}, registryOverride, getTokenUrl, getTarget, omitBridge } = {}) {
  const home = path.join(ROOT, name)
  fs.mkdirSync(home, { recursive: true })
  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  store.share('session-shared')
  const pluginServer = await startFakePluginServer()
  const registry = registryOverride ?? createBridgeRegistry()
  if (registryOverride === undefined) registry.register(DECLARATION_INPUT)
  const consentBox = { map: consent }
  const handler = createRelayHandler({
    secret: SECRET,
    store,
    gateway: { invoke: async () => ({}), stream: async () => (async function* () {})() },
    serverInfo: { serverId: loadServerId(home), serverName: () => 'test-server', dshVersion: '0.0.0-test' },
    ...(omitBridge ? {} : {
      pluginBridge: {
        registry,
        getConsent: () => consentBox.map,
        loopback: createPluginLoopback({
          getTarget: getTarget ?? pluginServer.target,
          getTokenUrl: getTokenUrl ?? pluginServer.tokenUrl,
        }),
      },
    }),
  })
  const server = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } }) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const headers = (overrides = {}) => ({ ...AUTH, ...overrides })
  return {
    store,
    registry,
    pluginServer,
    consentBox,
    _port: port,
    stop: async () => {
      pluginServer.releaseAll()
      await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
      await pluginServer.stop()
    },
    /** One POST to the plugin route with the given coordinates. */
    pluginFetch(pathName, { plugin = 'test-panel', version = '1.0.0', digest, zrPath = '/panel/data', query = 'sessionId=session-shared', headers: extra = {}, device, body } = {}) {
      const declared = normalizeDeclaration(DECLARATION_INPUT)
      return fetch(`http://127.0.0.1:${port}${pathName}`, {
        method: 'POST',
        headers: headers({
          'x-zr-plugin': plugin,
          'x-zr-plugin-version': version,
          'x-zr-plugin-digest': digest ?? declared.digest,
          'x-zr-path': zrPath,
          'x-zr-query': query,
          ...(device !== undefined ? { 'x-zen-remote-device': device } : {}),
          ...extra,
        }),
        ...(body !== undefined
          ? { body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }
          : {}),
      })
    },
  }
}

const ROUTE = '/_dsh/zen-remote/relay/v1/plugin'

test('PB-3: an unwired bridge answers 501 unsupported', async () => {
  const wiring = await makeWiring('unsupported', { omitBridge: true })
  try {
    const res = await wiring.pluginFetch(ROUTE)
    assert.equal(res.status, 501)
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'unsupported' } })
  } finally { await wiring.stop() }
})

test('PB-3: the refusal codes each get their case, and every refusal carries the x-zen-remote-error header', async () => {
  const wiring = await makeWiring('refusals')
  try {
    const cases = [
      ['plugin-unknown', 404, { plugin: 'never-registered' }],
      ['plugin-mismatch', 409, { version: '9.9.9' }],
      ['plugin-mismatch', 409, { digest: '0'.repeat(16) }],
      ['route-undeclared', 404, { zrPath: '/panel/undeclared' }],
      // Prefix semantics are opt-in (PB-23): without `prefix: true` a
      // declared exact path does not cover longer paths under it.
      ['route-undeclared', 404, { zrPath: '/panel/data/extra' }],
      ['bad-query', 400, { query: 'other=1' }],
      ['bad-query', 400, { query: 'sessionId=session-shared&sessionId=session-shared' }],
      ['bad-query', 400, { query: 'sessionId=' }],
      ['not-shared', 403, { query: 'sessionId=session-secret' }],
      ['consent-off', 403, { zrPath: '/panel/all' }],
    ]
    for (const [code, status, overrides] of cases) {
      const res = await wiring.pluginFetch(ROUTE, overrides)
      assert.equal(res.status, status, `${code}: status`)
      assert.deepEqual(await res.json(), { ok: false, error: { code } }, `${code}: body`)
      assert.equal(res.headers.get('x-zen-remote-error'), code, `${code}: marker header`)
    }

    // Missing coordinate headers are a plain bad-request: no plugin name,
    // nothing to look up (sent raw — pluginFetch would default it back).
    const noPlugin = await fetch(`http://127.0.0.1:${wiring._port}${ROUTE}`, {
      method: 'POST',
      headers: { ...AUTH, 'x-zr-plugin-version': '1.0.0', 'x-zr-plugin-digest': normalizeDeclaration(DECLARATION_INPUT).digest, 'x-zr-path': '/panel/data', 'x-zr-query': 'sessionId=session-shared' },
    })
    assert.equal(noPlugin.status, 400)
    assert.equal(noPlugin.headers.get('x-zen-remote-error'), 'bad-request')

    // A body is a protocol violation (the coordinates live in the headers).
    const withBody = await fetch(`http://127.0.0.1:${wiring._port}${ROUTE}`, {
      method: 'POST',
      headers: { ...AUTH, 'x-zr-plugin': 'test-panel', 'x-zr-plugin-version': '1.0.0', 'x-zr-plugin-digest': normalizeDeclaration(DECLARATION_INPUT).digest, 'x-zr-path': '/panel/data', 'x-zr-query': 'sessionId=session-shared' },
      body: '{"sneaky":true}',
    })
    assert.equal(withBody.status, 400)
    assert.equal(withBody.headers.get('x-zen-remote-error'), 'bad-request')
  } finally { await wiring.stop() }
})

// ---- PB-23: prefix routes ------------------------------------------------------

test('PB-23: a prefix-declared route admits its sub-paths — the loopback sees the raw x-zr-path; exact stays exact; the walls read the hit route', async () => {
  const wiring = await makeWiring('prefix-routes', { registryOverride: createBridgeRegistry() })
  try {
    // /p/media/a is DELIBERATELY also declared exact and server-scoped: the
    // path-sorted declaration order meets the PREFIX /p/media first, so the
    // multi-hit rule (first hit in declaration order) is observable as a
    // 200 without consent at the bottom of this test.
    const PREFIX_DECL = {
      plugin: 'test-panel',
      version: '1.0.0',
      routes: [
        { path: '/p/api', scope: 'session' },
        { path: '/p/get-only', scope: 'session', prefix: true, methods: ['GET'] },
        { path: '/p/media', scope: 'session', prefix: true },
        { path: '/p/media/a', scope: 'server' },
      ],
    }
    const prefixDigest = normalizeDeclaration(PREFIX_DECL).digest
    wiring.registry.register(PREFIX_DECL)
    wiring.consentBox.map = {}

    // Declared sub-paths pass — one segment and many segments deeper (the
    // rule is `pathname === path || pathname.startsWith(path + '/')`, the
    // SAME one the adapter segment applies) — and the loopback receives the
    // x-zr-path VERBATIM: the full path as the sub-client forwarded it,
    // next to the re-serialized query.
    const one = await wiring.pluginFetch(ROUTE, { zrPath: '/p/media/file/42', digest: prefixDigest })
    assert.equal(one.status, 200)
    assert.equal((await one.json()).path, '/p/media/file/42', 'the plugin saw the declared sub-path')
    const deep = await wiring.pluginFetch(ROUTE, { zrPath: '/p/media/a/b', query: 'sessionId=session-shared&v=2', digest: prefixDigest })
    assert.equal(deep.status, 200, 'an any-depth tail is still the prefix route\'s')
    await deep.text()
    assert.equal(
      wiring.pluginServer.state.requests.at(-1).url,
      '/p/media/a/b?sessionId=session-shared&v=2',
      'the loopback saw the original path and the checked query',
    )

    // Undeclared paths refuse with the standing shape — including the
    // near-miss: a prefix hit needs the "/" separator, never a raw prefix.
    for (const undeclared of ['/p/nowhere', '/p/mediax']) {
      const res = await wiring.pluginFetch(ROUTE, { zrPath: undeclared, digest: prefixDigest })
      assert.equal(res.status, 404, `${undeclared}: status`)
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'route-undeclared' } }, `${undeclared}: body`)
      assert.equal(res.headers.get('x-zen-remote-error'), 'route-undeclared', `${undeclared}: marker header`)
    }

    // An exact declaration does NOT grow prefix semantics: /p/api declared
    // without `prefix: true` keeps its sub-paths undeclared.
    const exactTail = await wiring.pluginFetch(ROUTE, { zrPath: '/p/api/x', digest: prefixDigest })
    assert.equal(exactTail.status, 404)
    assert.equal(exactTail.headers.get('x-zen-remote-error'), 'route-undeclared')

    // The per-route walls read the HIT route: the prefix route declared GET
    // only, so another method on its sub-path answers 405 and reaches
    // nothing.
    const before = wiring.pluginServer.state.requests.length
    const undeclaredMethod = await wiring.pluginFetch(ROUTE, {
      zrPath: '/p/get-only/media',
      digest: prefixDigest,
      headers: { 'x-zr-method': 'DELETE' },
    })
    assert.equal(undeclaredMethod.status, 405)
    assert.equal(undeclaredMethod.headers.get('x-zen-remote-error'), 'method-undeclared')
    assert.equal(wiring.pluginServer.state.requests.length, before, 'the plugin saw nothing')

    // The ordering pin: /p/media/a is declared exact + server-scoped, but
    // the declaration order meets the prefix /p/media first — the call
    // rides THAT route, so consent-off still serves it.
    const ordered = await wiring.pluginFetch(ROUTE, { zrPath: '/p/media/a', digest: prefixDigest })
    assert.equal(ordered.status, 200, 'the first hit in declaration order (the prefix route) owns the call')
    await ordered.text()
  } finally { await wiring.stop() }
})

test('PB-3: the parse-once query — a control-character key cannot fork check and dispatch', async () => {
  const wiring = await makeWiring('query-once')
  try {
    // `session%09Id` decodes to a TAB key inside URLSearchParams: it is NOT
    // the session parameter (so validation passes on the ONE real
    // sessionId), and the loopback request must carry it verbatim — a
    // WHATWG-style strip would turn it into a SECOND sessionId on the wire,
    // the exact T41b bypass shape. The fake records its RAW url.
    const res = await wiring.pluginFetch(ROUTE, { query: 'session%09Id=x&sessionId=session-shared' })
    assert.equal(res.status, 200)
    await res.text()
    const seen = wiring.pluginServer.state.requests.at(-1)
    assert.equal(seen.url, '/panel/data?session%09Id=x&sessionId=session-shared', 'the forwarded query is the CHECKED serialization, tab-key intact')
    const pluginSide = new URLSearchParams(seen.url.split('?')[1])
    assert.deepEqual(pluginSide.getAll('sessionId'), ['session-shared'], 'the plugin reads exactly one sessionId')
    assert.deepEqual(pluginSide.getAll('session\tId'), ['x'], 'and the tab key survives as its own parameter')
    assert.match(seen.host, /^127\.0\.0\.1:\d+$/, 'the loopback Host is the loopback authority')
  } finally { await wiring.stop() }
})

test("PB-3: consent gates only scope:'server' routes, read LIVE per request", async () => {
  const wiring = await makeWiring('consent', { consent: {} })
  try {
    // A session-scoped route needs NO consent (empty map)…
    const sessionRoute = await wiring.pluginFetch(ROUTE, { zrPath: '/panel/data' })
    assert.equal(sessionRoute.status, 200)
    await sessionRoute.text()
    // …and the server-scoped route is refused until the map says yes —
    // flipped WITHOUT any re-wiring, proving the live read.
    assert.equal((await wiring.pluginFetch(ROUTE, { zrPath: '/panel/all' })).status, 403)
    wiring.consentBox.map = { 'test-panel': true }
    const granted = await wiring.pluginFetch(ROUTE, { zrPath: '/panel/all' })
    assert.equal(granted.status, 200)
    await granted.text()
  } finally { await wiring.stop() }
})

// ---- PB-9: write requests -----------------------------------------------------

test('PB-9 POST round-trip: the plugin receives the VERBATIM bytes and content type; undeclared method 405; bodyless GET with a body 400', async () => {
  const wiring = await makeWiring('post-write', { registryOverride: createBridgeRegistry() })
  try {
    const WRITE_DECL = {
      plugin: 'test-panel',
      version: '1.0.0',
      routes: [
        { path: '/panel/write', scope: 'session', methods: ['POST', 'PUT'] },
        { path: '/panel/data', scope: 'session' },
      ],
    }
    const writeDigest = normalizeDeclaration(WRITE_DECL).digest
    wiring.registry.register(WRITE_DECL)
    wiring.consentBox.map = {}
    const body = JSON.stringify({ title: '新任务', items: [1, 2, 3] })
    const res = await wiring.pluginFetch(ROUTE, {
      zrPath: '/panel/write',
      query: 'sessionId=session-shared',
      digest: writeDigest,
      headers: { 'x-zr-method': 'POST', 'content-type': 'application/json; charset=utf-8' },
      body,
    })
    assert.equal(res.status, 200, `the write round-trip: ${res.body?.slice?.(0, 200) ?? ''}`)
    await res.text()
    const seen = wiring.pluginServer.state.requests.at(-1)
    assert.equal(seen.method, 'POST', 'the loopback method is the forwarded one')
    assert.equal(seen.bodyDone, true)
    assert.equal(seen.body, body, 'the exact bytes reached the plugin')
    assert.equal(seen.contentType, 'application/json; charset=utf-8', 'the content type rode the passthrough')

    // A method the route did NOT declare answers 405 method-undeclared, and
    // the plugin never sees it.
    const before = wiring.pluginServer.state.requests.length
    const undeclared = await wiring.pluginFetch(ROUTE, {
      zrPath: '/panel/write',
      query: 'sessionId=session-shared',
      digest: writeDigest,
      headers: { 'x-zr-method': 'DELETE' },
    })
    assert.equal(undeclared.status, 405)
    assert.equal(undeclared.headers.get('x-zen-remote-error'), 'method-undeclared')
    assert.equal(wiring.pluginServer.state.requests.length, before, 'the plugin saw nothing')

    // A route without `methods` forwards GET only: the default is still
    // exactly 2.1's.
    const getDefault = await wiring.pluginFetch(ROUTE, { zrPath: '/panel/data', digest: writeDigest })
    assert.equal(getDefault.status, 200)
    const postOnGet = await wiring.pluginFetch(ROUTE, {
      zrPath: '/panel/data',
      digest: writeDigest,
      headers: { 'x-zr-method': 'POST' },
      body: 'x',
    })
    assert.equal(postOnGet.status, 405)

    // GET/HEAD stay bodyless: a body on them is a shape violation.
    const getWithBody = await wiring.pluginFetch(ROUTE, {
      zrPath: '/panel/data',
      headers: { 'content-type': 'application/json' },
      body: '{"sneaky":true}',
    })
    assert.equal(getWithBody.status, 400)
    assert.equal(getWithBody.headers.get('x-zen-remote-error'), 'bad-request')
  } finally {
    wiring.pluginServer.releaseAll()
    await wiring.stop()
  }
})

test('PB-9 body gates: a declared over-max content-length refuses 413 before forwarding; a chunked over-max body trips the streaming count and the loopback dies', async () => {
  const wiring = await makeWiring('body-gates', { registryOverride: createBridgeRegistry() })
  try {
    const GATE_DECL = {
      plugin: 'test-panel',
      version: '1.0.0',
      routes: [{ path: '/panel/write', scope: 'session', methods: ['POST'], maxBody: 1024 }],
    }
    const gateDigest = normalizeDeclaration(GATE_DECL).digest
    wiring.registry.register(GATE_DECL)
    wiring.consentBox.map = {}

    // Declared length over the cap: refused before a byte moves.
    const before = wiring.pluginServer.state.requests.length
    const pre = await wiring.pluginFetch(ROUTE, {
      zrPath: '/panel/write',
      query: 'sessionId=session-shared',
      digest: gateDigest,
      headers: { 'x-zr-method': 'POST' },
      body: 'x'.repeat(1025),
    })
    assert.equal(pre.status, 413)
    assert.equal(pre.headers.get('x-zen-remote-error'), 'body-too-large')
    assert.equal(wiring.pluginServer.state.requests.length, before, 'nothing reached the plugin')

    // Chunked body past the cap: NO content-length (a web-stream body rides
    // chunked), so the pre-check cannot see it — the pump's counting gate
    // trips mid-forward, the loopback request dies mid-write, and the 413
    // answers with the relay's headers not yet out.
    const chunkInit = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(2000)))
        controller.close()
      },
    })
    const chunked = await wiring.pluginFetch(ROUTE, {
      zrPath: '/panel/write',
      query: 'sessionId=session-shared',
      digest: gateDigest,
      headers: { 'x-zr-method': 'POST', 'content-type': 'application/octet-stream' },
      body: chunkInit,
    })
    assert.equal(chunked.status, 413)
    assert.equal(chunked.headers.get('x-zen-remote-error'), 'body-too-large')
    const writes = wiring.pluginServer.state.requests.filter((r) => r.url.startsWith('/panel/write'))
    // The 2000-byte body arrives as ONE chunk past the 1024 cap: the gate
    // trips before the loopback has written anything, so ZERO connection
    // attempts is the honest "aborted at the gate" outcome — and any attempt
    // that DID open was killed mid-body, never completed.
    assert.ok(writes.every((w) => !w.bodyDone && w.aborted), 'no loopback attempt ever completed a body')
  } finally {
    wiring.pluginServer.releaseAll()
    await wiring.stop()
  }
})

test("PB-3-fix: a THROWN consent source reads as no consent — the server-scoped route stays home", async () => {
  const home = path.join(ROOT, 'consent-throws')
  fs.mkdirSync(home, { recursive: true })
  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  store.share('session-shared')
  const pluginServer = await startFakePluginServer()
  const registry = createBridgeRegistry()
  registry.register(DECLARATION_INPUT)
  const handler = createRelayHandler({
    secret: SECRET,
    store,
    gateway: { invoke: async () => ({}), stream: async () => (async function* () {})() },
    serverInfo: { serverId: loadServerId(home), serverName: () => 'test-server', dshVersion: '0.0.0-test' },
    pluginBridge: {
      registry,
      getConsent: () => { throw new Error('the consent source exploded') },
      loopback: createPluginLoopback({ getTarget: pluginServer.target, getTokenUrl: pluginServer.tokenUrl }),
    },
  })
  const server = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } }) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const declared = normalizeDeclaration(DECLARATION_INPUT)
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`, {
      method: 'POST',
      headers: { ...AUTH, 'x-zr-plugin': 'test-panel', 'x-zr-plugin-version': '1.0.0', 'x-zr-plugin-digest': declared.digest, 'x-zr-path': '/panel/all', 'x-zr-query': 'sessionId=session-shared' },
    })
    assert.equal(res.status, 403)
    assert.equal(res.headers.get('x-zen-remote-error'), 'consent-off', 'unknown consent is NO consent')
    // The session-scoped route is untouched by the broken source.
    const sessionRoute = await fetch(`http://127.0.0.1:${port}${ROUTE}`, {
      method: 'POST',
      headers: { ...AUTH, 'x-zr-plugin': 'test-panel', 'x-zr-plugin-version': '1.0.0', 'x-zr-plugin-digest': declared.digest, 'x-zr-path': '/panel/data', 'x-zr-query': 'sessionId=session-shared' },
    })
    assert.equal(sessionRoute.status, 200, 'session-scoped routes never read the consent source')
  } finally {
    pluginServer.releaseAll()
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
    await pluginServer.stop()
  }
})

test('PB-3: the per-device budget holds 8, refuses the 9th with busy, and recovers after one finishes', async () => {
  const wiring = await makeWiring('busy')
  try {
    // Warm the loopback cookie first, so the 8 held requests each arrive as
    // ONE plugin hit instead of a concurrent 401 + exchange + retry each.
    const warm = await wiring.pluginFetch(ROUTE, { zrPath: '/panel/data' })
    assert.equal(warm.status, 200)
    await warm.text()
    const hitsBefore = wiring.pluginServer.state.requests.length
    const held = []
    for (let i = 0; i < 8; i += 1) {
      held.push(wiring.pluginFetch(ROUTE, { zrPath: '/panel/hold', query: `sessionId=session-shared&i=${i}` }))
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(wiring.pluginServer.state.requests.length - hitsBefore, 8, 'eight requests reached the plugin')
    const ninth = await wiring.pluginFetch(ROUTE, { zrPath: '/panel/hold', query: 'sessionId=session-shared&i=9' })
    assert.equal(ninth.status, 429)
    assert.equal(ninth.headers.get('x-zen-remote-error'), 'busy')
    await ninth.text()
    // Another device is unaffected — the budget is per device.
    const otherDevice = await wiring.pluginFetch(ROUTE, { zrPath: '/panel/data', device: 'device-2' })
    assert.equal(otherDevice.status, 200)
    await otherDevice.text()
    // One slot frees; the same device is served again.
    wiring.pluginServer.releaseOne()
    await Promise.all(held)
    const recovered = await wiring.pluginFetch(ROUTE, { zrPath: '/panel/data', query: 'sessionId=session-shared&i=10' })
    assert.equal(recovered.status, 200)
    await recovered.text()
  } finally {
    wiring.pluginServer.releaseAll()
    await wiring.stop()
  }
})

test('PB-3: a loopback-auth failure answers 502 loopback-auth; any other loopback failure 502 internal', async () => {
  const noToken = await makeWiring('loopback-auth', { getTokenUrl: () => undefined })
  try {
    const res = await noToken.pluginFetch(ROUTE)
    assert.equal(res.status, 502)
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'loopback-auth' } })
    assert.equal(res.headers.get('x-zen-remote-error'), 'loopback-auth')
  } finally { await noToken.stop() }

  const deadTarget = await makeWiring('loopback-internal', {
    getTarget: () => { throw new Error('the web server exposes no loopback port') },
  })
  try {
    const res = await deadTarget.pluginFetch(ROUTE)
    assert.equal(res.status, 502)
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'internal' } })
    assert.equal(res.headers.get('x-zen-remote-error'), 'internal')
  } finally { await deadTarget.stop() }
})

test('PB-3: a streamed plugin answer crosses in order with its headers; a mid-stream hang-up aborts the plugin', async () => {
  const wiring = await makeWiring('streaming')
  try {
    const res = await wiring.pluginFetch(ROUTE, {
      zrPath: '/panel/stream',
      headers: { accept: 'application/x-ndjson', range: 'bytes=0-' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/x-ndjson')
    assert.equal(res.headers.get('x-zen-remote-error'), null, 'a success never carries the refusal marker')
    const text = await res.text()
    assert.deepEqual(text.split('\n').filter(Boolean), ['{"n":1}', '{"n":2}', '{"n":3}'], 'the three frames arrive in wire order')

    // Header discipline at the plugin hop (PB-3-fix): exactly the two
    // passthrough headers arrive; the relay secret, the device's Bearer
    // token and identity, and the x-zr-* coordinates NEVER do — the plugin
    // must not learn how the request was authenticated or forwarded.
    const seen = wiring.pluginServer.state.requests.at(-1)
    assert.equal(seen.headers.accept, 'application/x-ndjson', 'accept passes through')
    assert.equal(seen.headers.range, 'bytes=0-', 'range passes through')
    for (const forbidden of ['x-zen-remote-secret', 'authorization', 'x-zen-remote-device', 'x-zen-remote-via', 'x-zen-remote-role', 'x-zr-plugin', 'x-zr-plugin-version', 'x-zr-plugin-digest', 'x-zr-path', 'x-zr-query']) {
      assert.equal(seen.headers[forbidden], undefined, `${forbidden} must not reach the plugin`)
    }

    // The hang-up: headers arrive, the body is held, the client walks —
    // the plugin must see its connection close.
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${wiring._port}${ROUTE}`, {
      method: 'POST',
      headers: { ...AUTH, 'x-zr-plugin': 'test-panel', 'x-zr-plugin-version': '1.0.0', 'x-zr-plugin-digest': normalizeDeclaration(DECLARATION_INPUT).digest, 'x-zr-path': '/panel/hold', 'x-zr-query': 'sessionId=session-shared' },
      signal: controller.signal,
    })
    const held = await pending
    assert.equal(held.status, 200)
    controller.abort()
    await held.text().catch(() => 'aborted')
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.ok(wiring.pluginServer.state.aborted.includes('/panel/hold'), 'the hang-up reached the plugin as a closed connection')
  } finally {
    wiring.pluginServer.releaseAll()
    await wiring.stop()
  }
})
