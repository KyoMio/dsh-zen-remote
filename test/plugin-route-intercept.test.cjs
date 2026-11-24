/* dsh-zen-remote · the plugin bridge's route interception (PB-4)
 *
 * Drives the BUILT lib/plugin-route-intercept.js against a fake host
 * webServer: a REAL node:http server whose `handle` follows the host's own
 * shape (RT dsh-host-webserver lib/index.js:350-364 — raw undecoded
 * pathname, `this.match(rawPath)`, route.handler(req, res), else fallback).
 * The local plugin registers `/panel/*` routes there and COUNTS its handler
 * invocations — the security observable is that a remote session's request
 * on a declared route NEVER reaches it, whatever the bridge state.
 *
 * The fake relay (a local http server speaking PB-3's relay/v1/plugin)
 * records the forwarded coordinates, can refuse with x-zen-remote-error,
 * stream NDJSON, and observe the caller's abort.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { checkWebServerShape, installPluginRouteIntercept } = require('../lib/plugin-route-intercept.js')
const { createBridgeRegistry, normalizeDeclaration } = require('../lib/plugin-bridge.js')
const { encodeRfc6455Frame } = require('../lib/plugin-tunnel.js')
const {
  waitFor,
  startResetServer,
  startFakeHost: createFakeHost,
  startFakeRelay,
  fakeRelayClient,
} = require('./helpers/plugin-bridge-harness.cjs')

const DECLARED = {
  plugin: 'test-panel',
  version: '1.0.0',
  routes: [
    { path: '/panel/data', scope: 'session' },
    { path: '/panel/all', scope: 'server' },
    { path: '/panel/stream', scope: 'session', stream: true },
    { path: '/panel/hold', scope: 'session' },
    { path: '/panel/write', scope: 'session', methods: ['POST'], maxBody: 1024 },
  ],
}
const DIGEST = normalizeDeclaration(DECLARED).digest

function startFakeHost() {
  return createFakeHost({ localPanel: 0, other: 0 }, (raw, hits) => {
    raw.register({
      kind: 'exact',
      path: '/panel/data',
      handler: async (req, res) => {
        hits.localPanel += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ local: true, query: new URL(req.url ?? '/', 'http://x').search }))
      },
    })
    raw.register({
      kind: 'exact',
      path: '/panel/all',
      handler: async (req, res) => {
        hits.localPanel += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ local: true, whole: 'machine' }))
      },
    })
    raw.register({
      kind: 'exact',
      path: '/panel/stream',
      handler: async (req, res) => {
        hits.localPanel += 1
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end('local\n')
      },
    })
  })
}

const VIRTUAL = 'zr~abcd1234~session-a'
const SERVER_ID = 'abcd1234'

test('PB-4: shape check accepts the host shape and refuses lookalikes', () => {
  const good = { match: () => undefined, exact: new Map(), prefixes: new Map(), upgrades: new Map() }
  assert.deepEqual(checkWebServerShape(good), { ok: true })
  for (const bad of [null, 42, {}, { match: () => undefined }, { match: () => undefined, exact: new Map() }, { match: 'x', exact: new Map(), prefixes: new Map() }]) {
    const verdict = checkWebServerShape(bad)
    assert.equal(verdict.ok, false, `shape ${JSON.stringify(bad)} must refuse`)
    assert.ok(verdict.reasons.length > 0)
  }
})

test('PB-4/10: install itself refuses a bad shape INERTLY — no TypeError, nothing touched', () => {
  // A caller that skips checkWebServerShape (the e2e fake hosts once lacked
  // `upgrades` and install died mid-wrap with a TypeError — the PB-10
  // rework) gets an inert handle, never a throw.
  const bad = { match: () => undefined, exact: new Map(), prefixes: new Map() } // no upgrades
  const handle = installPluginRouteIntercept({
    webServer: bad,
    registry: createBridgeRegistry(),
    relay: {},
    getServerId: () => undefined,
    getStatus: () => [],
    log: () => {},
  })
  assert.equal(handle.diagnostics().installed, false, 'the inert handle reports uninstalled')
  assert.equal(handle.diagnostics().shape.ok, false, 'the diagnostics carry the refusal')
  handle.uninstall() // a no-op, not a throw
  assert.equal(typeof bad.upgrades, 'undefined', 'the bad host was never touched')
})

test('PB-4: a LOCAL session id reaches the local plugin; an UNDECLARED route flows untouched', async () => {
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const relay = await startFakeRelay()
  const registry = createBridgeRegistry()
  registry.register(DECLARED)
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: fakeRelayClient(relay.__port),
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'test-panel', bridged: true, localVersion: '1.0.0' }],
    log: () => {},
  })
  try {
    // Local session on a declared route: the LOCAL handler ran, the relay
    // never saw anything.
    const local = await host.get('/panel/data?sessionId=session-local')
    assert.equal(local.status, 200)
    assert.deepEqual(JSON.parse(await local.text()), { local: true, query: '?sessionId=session-local' })
    assert.equal(host.hits.localPanel, 1)
    assert.equal(relay.state.hits.length, 0)

    // An undeclared path: even with a virtual id, it flows to whatever the
    // original match answered (here the fallback-less 404) — never forward.
    const undeclared = await host.get(`/panel/unknown?sessionId=${encodeURIComponent(VIRTUAL)}`)
    assert.equal(undeclared.status, 404)
    assert.equal(relay.state.hits.length, 0)
    assert.equal(host.hits.localPanel, 1)

    // A declared path WITHOUT the session parameter: local business too.
    const noParam = await host.get('/panel/data')
    assert.equal(noParam.status, 200)
    assert.equal(host.hits.localPanel, 2)
    assert.equal(relay.state.hits.length, 0)
  } finally {
    handle.uninstall()
    await relay.stop()
    await host.stop()
  }
})

test('PB-4: a virtual id on a bridged route forwards through the relay and streams back', async () => {
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const relay = await startFakeRelay()
  const registry = createBridgeRegistry()
  registry.register(DECLARED)
  const logs = []
  const debugs = []
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: fakeRelayClient(relay.__port),
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'test-panel', bridged: true, localVersion: '1.0.0', serverVersion: '1.0.0' }],
    log: (format, ...args) => logs.push([format, ...args]),
    debug: (format, ...args) => debugs.push([format, ...args]),
  })
  try {
    const res = await host.get(`/panel/stream?sessionId=${encodeURIComponent(VIRTUAL)}`, { headers: { accept: 'application/x-ndjson' } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/x-ndjson')
    assert.equal(await res.text(), 'frame-1\nframe-2\n', 'the streamed frames arrive in order')
    assert.equal(host.hits.localPanel, 0, 'the LOCAL plugin handler never ran')

    const forwarded = relay.state.hits[0]
    assert.equal(forwarded.plugin, 'test-panel')
    assert.equal(forwarded.version, '1.0.0', 'the DECLARATION version rides the forward')
    assert.equal(forwarded.digest, DIGEST, 'the DECLARATION digest rides the forward')
    assert.equal(forwarded.zrPath, '/panel/stream')
    assert.equal(forwarded.zrQuery, 'sessionId=session-a', 'the virtual id was restored to the ORIGINAL form')
    assert.equal(forwarded.accept, 'application/x-ndjson', 'the browser accept header passed through')

    const diag = handle.diagnostics()
    assert.equal(diag.installed, true)
    assert.equal(diag.forwarded, 1)
    assert.equal(diag.refused, 0)

    // T3: the per-request forwards line rides the debug channel, not log.
    assert.ok(debugs.some(([format]) => format === 'plugin route %s forwards for %s'), 'forwards line on debug')
    assert.ok(!logs.some(([format]) => format === 'plugin route %s forwards for %s'), 'forwards line left info')
  } finally {
    handle.uninstall()
    await relay.stop()
    await host.stop()
  }
})

test('PB-4: every unbridged reason answers the uniform 503 and the local handler NEVER runs', async () => {
  // bridged:false → getStatus finds the plugin NOT bridged → reason from
  // the status (here 'offline' from a verdict-shaped status is covered by
  // the absent case below; this one carries an explicit reason).
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const relay = await startFakeRelay()
  const registry = createBridgeRegistry()
  registry.register(DECLARED)
  let statuses = [{ plugin: 'test-panel', bridged: false, reason: 'version-mismatch', localVersion: '1.0.0' }]
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: fakeRelayClient(relay.__port),
    getServerId: () => SERVER_ID,
    getStatus: () => statuses,
    log: () => {},
  })
  try {
    const cases = [
      ['version-mismatch', `/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`, 'getStatus verdict reason'],
    ]
    for (const [reason, path, label] of cases) {
      const res = await host.get(path)
      assert.equal(res.status, 503, label)
      assert.equal(res.headers.get('x-zen-remote'), 'unbridged')
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
      const body = await res.json()
      assert.deepEqual(body, { ok: false, error: { code: 'zr-plugin-unbridged', reason, plugin: 'test-panel' } }, label)
    }
    assert.equal(host.hits.localPanel, 0, 'the local handler never ran for a remote session')
    assert.equal(relay.state.hits.length, 0, 'nothing was forwarded either')

    // Absent from the status list entirely → not-on-server.
    statuses = []
    const absent = await host.get(`/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`)
    assert.equal(absent.status, 503)
    assert.equal((await absent.json()).error.reason, 'not-on-server')

    // The relay itself refuses (x-zen-remote-error) → that code is the reason.
    statuses = [{ plugin: 'test-panel', bridged: true, localVersion: '1.0.0', serverVersion: '1.0.0' }]
    const refusingRelay = await startFakeRelay({ refuse: { status: 403, code: 'not-shared' } })
    const handle2 = installPluginRouteIntercept({
      webServer: host.raw,
      registry,
      relay: fakeRelayClient(refusingRelay.__port),
      getServerId: () => SERVER_ID,
      getStatus: () => statuses,
      log: () => {},
    })
    try {
      const relayRefused = await host.get(`/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`)
      assert.equal(relayRefused.status, 503)
      assert.deepEqual(await relayRefused.json(), {
        ok: false, error: { code: 'zr-plugin-unbridged', reason: 'not-shared', plugin: 'test-panel' },
      })
    } finally {
      handle2.uninstall()
      await refusingRelay.stop()
    }

    // method / query / server walls, each its own reason — all carrying the
    // virtual id (a request without it is the LOCAL route's business).
    const walls = [
      ['method-not-bridged', `/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`, { method: 'POST' }],
      ['bad-query', '/panel/data?sessionId=zr~nothex~x', {}],
      ['server-changed', '/panel/data?sessionId=zr~deadbeef~x', {}],
    ]
    for (const [reason, path, init] of walls) {
      const res = await host.get(path, { method: init.method ?? 'GET', headers: init.headers })
      assert.equal(res.status, 503, reason)
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'zr-plugin-unbridged', reason, plugin: 'test-panel' } }, reason)
    }
    // A duplicated session parameter is also bad-query — and repeated twice
    // with one virtual id it must not reach the plugin either way.
    const dup = await host.get(`/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}&sessionId=${encodeURIComponent(VIRTUAL)}`)
    assert.equal(dup.status, 503)
    assert.equal((await dup.json()).error.reason, 'bad-query')

    assert.equal(host.hits.localPanel, 0, 'still zero local handler runs across every wall')
    const diag = handle.diagnostics()
    assert.equal(diag.forwarded, 0)
    // verdict 1 + absent 1 + walls 3 + duplicate 1 (the relay-refusal case
    // runs on its own handle above).
    assert.equal(diag.refused, 6, 'every refusal was counted')
    assert.ok(diag.refusalsByReason['method-not-bridged'] === 1)
    assert.ok(diag.recentFailures.every((record) => record.plugin === 'test-panel' && !JSON.stringify(record).includes('sessionId')), 'the ring carries plugin + reason only')
  } finally {
    handle.uninstall()
    await relay.stop()
    await host.stop()
  }
})

test('PB-5-fix: a LOCAL session request logs NOTHING; only forwards and refusals speak', async () => {
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const relay = await startFakeRelay()
  const registry = createBridgeRegistry()
  registry.register(DECLARED)
  const logLines = []
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: fakeRelayClient(relay.__port),
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'test-panel', bridged: true, localVersion: '1.0.0', serverVersion: '1.0.0' }],
    log: (format, ...args) => logLines.push(`${format} ${args.join(' ')}`),
    // T3: forwards ride the debug channel — counted here too.
    debug: (format, ...args) => logLines.push(`${format} ${args.join(' ')}`),
  })
  try {
    // The local panel's own polling shape: declared route, local id, over
    // and over.
    for (let i = 0; i < 5; i += 1) {
      const res = await host.get('/panel/data?sessionId=session-local')
      assert.equal(res.status, 200)
    }
    assert.equal(logLines.length, 0, 'the local passthrough never logged')

    // The relay side still speaks: one forward, one line.
    await host.get(`/panel/stream?sessionId=${encodeURIComponent(VIRTUAL)}`, { headers: { accept: 'text/event-stream' } })
    assert.equal(logLines.length, 1, 'the forward logged exactly once')
  } finally {
    handle.uninstall()
    await relay.stop()
    await host.stop()
  }
})

test('PB-9: a POST on a declared route streams through; an undeclared method and an over-max body never reach the local plugin', async () => {
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const relay = await startFakeRelay()
  const relayClient = fakeRelayClient(relay.__port)
  const registry = createBridgeRegistry()
  registry.register(DECLARED)
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: relayClient,
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'test-panel', bridged: true, localVersion: '1.0.0', serverVersion: '1.0.0' }],
    log: () => {},
  })
  try {
    // POST on the declared route: the body crosses to the relay and the
    // echoed answer streams back; the local plugin handler never ran.
    const posted = await host.get(`/panel/write?sessionId=${encodeURIComponent(VIRTUAL)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新任务' }),
    })
    assert.equal(posted.status, 200)
    assert.deepEqual(JSON.parse(await posted.text()), {
      echoed: JSON.stringify({ title: '新任务' }),
      ct: 'application/json',
    }, 'the exact bytes and content type crossed the boundary')
    const forward = relayClient.forwarded.at(-1)
    assert.equal(forward.method, 'POST', 'the forwarded method is the browser\'s')
    assert.equal(forward.contentType, 'application/json', 'the content type is passed through')
    // 21 = the JSON string's UTF-8 byte length (新任务 are 3 bytes each) —
    // what the browser's Content-Length named and what the budget scales with.
    assert.equal(forward.contentLength, Buffer.byteLength(JSON.stringify({ title: '新任务' })), 'the declared length rides along for the budget')
    assert.equal(forward.path, '/panel/write')
    assert.equal(host.hits.localPanel, 0)

    // A PUT the route did not declare: uniform 503, local plugin untouched,
    // relay untouched.
    const put = await host.get(`/panel/write?sessionId=${encodeURIComponent(VIRTUAL)}`, { method: 'PUT', body: 'x' })
    assert.equal(put.status, 503)
    assert.equal((await put.json()).error.reason, 'method-not-bridged')
    assert.equal(relay.state.hits.filter((hit) => hit.zrPath === '/panel/write').length, 1, 'nothing was forwarded')

    // PRE-CHECK case: a DECLARED Content-Length past maxBody refuses
    // locally before a byte moves.
    const over = await host.get(`/panel/write?sessionId=${encodeURIComponent(VIRTUAL)}`, {
      method: 'POST',
      headers: { 'content-length': '1025' },
      body: 'x'.repeat(1025),
    })
    assert.equal(over.status, 413)
    assert.deepEqual(await over.json(), { ok: false, error: { code: 'zr-plugin-body-too-large' } })
    assert.equal(host.hits.localPanel, 0)

    // CHUNKED case (PB-9-fix): a TRUE no-Content-Length body — a web-stream
    // body rides chunked — outgrows the gate mid-forward. The gate's LOCAL
    // flag answers the 413 (the relay client correctly did NOT judge the
    // link offline for the caller abort), the local plugin never runs.
    const chunked = await host.get(`/panel/write?sessionId=${encodeURIComponent(VIRTUAL)}`, {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(2000)))
          controller.close()
        },
      }),
    })
    const chunkedBody = await chunked.json()
    assert.equal(chunked.status, 413, 'the chunked over-max body answers the local 413')
    assert.deepEqual(chunkedBody, { ok: false, error: { code: 'zr-plugin-body-too-large' } })
    assert.equal(host.hits.localPanel, 0, 'the local plugin handler still never runs')
    // The relay client never saw the body gate's failure as a link verdict.
    assert.equal(relayClient.offlineVerdicts.length, 0, 'the gate trip is a caller verdict, never offline')
    // The over-limit request did not reach the fake relay either (the abort
    // tore the forward down mid-flight).
    assert.equal(relay.state.hits.filter((hit) => hit.zrPath === '/panel/write').length, 1, 'only the legal POST was ever forwarded')

    const diag = handle.diagnostics()
    // forwarded counts REQUESTS THAT ENTERED the forward — the legal POST
    // plus the chunked one whose gate tripped MID-forward. The over-max
    // pre-check refusal never entered, so it is not counted here.
    assert.equal(diag.forwarded, 2, 'the legal POST entered the forward, and so did the chunked one before its gate tripped')
    assert.equal(diag.refusalsByReason['body-too-large'], 2)
  } finally {
    handle.uninstall()
    await relay.stop()
    await host.stop()
  }
})

test('PB-5-fix: a relay TRANSPORT failure answers the uniform 503 offline, and the local handler still never runs', async () => {
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const registry = createBridgeRegistry()
  registry.register(DECLARED)
  // A relay client pointed at a port nothing listens on: the transport dies.
  const reset = await startResetServer()
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: fakeRelayClient(reset.port),
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'test-panel', bridged: true, localVersion: '1.0.0', serverVersion: '1.0.0' }],
    log: () => {},
  })
  try {
    const res = await host.get(`/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`)
    assert.equal(res.status, 503)
    assert.equal(res.headers.get('x-zen-remote'), 'unbridged')
    assert.deepEqual(await res.json(), {
      ok: false, error: { code: 'zr-plugin-unbridged', reason: 'offline', plugin: 'test-panel' },
    })
    assert.equal(host.hits.localPanel, 0, 'the local handler still never ran')
    const diag = handle.diagnostics()
    assert.equal(diag.refusalsByReason.offline, 1)
  } finally {
    handle.uninstall()
    await reset.close()
    await host.stop()
  }
})

test('PB-4: the browser hang-up aborts the relay round-trip', async () => {
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const relay = await startFakeRelay()
  const registry = createBridgeRegistry()
  registry.register(DECLARED)
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: fakeRelayClient(relay.__port),
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'test-panel', bridged: true, localVersion: '1.0.0', serverVersion: '1.0.0' }],
    log: () => {},
  })
  try {
    const controller = new AbortController()
    const pending = host.get(`/panel/hold?sessionId=${encodeURIComponent(VIRTUAL)}`, { signal: controller.signal })
    await waitFor(() => relay.state.hits.length === 1)
    assert.equal(relay.state.hits.length, 1, 'the forward reached the relay')
    controller.abort()
    await pending.catch(() => 'aborted')
    await waitFor(() => relay.state.aborted === 1)
    assert.equal(relay.state.aborted, 1, 'the relay saw its connection close')
  } finally {
    await relay.releaseHold()
    handle.uninstall()
    await relay.stop()
    await host.stop()
  }
})

test('PB-4: a refused shape never installs; uninstall restores; a chained-over wrap goes inert', async () => {
  // Refused shape: nothing changed at all.
  const bad = { exact: new Map(), prefixes: new Map() } // no match
  const registry = createBridgeRegistry()
  registry.register(DECLARED)
  const verdict = checkWebServerShape(bad)
  assert.equal(verdict.ok, false)
  assert.ok(!('match' in bad), 'the check mutated nothing')

  // Install + uninstall restores the ORIGINAL match identity.
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const relay = await startFakeRelay()
  const originalMatch = host.raw.match
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: fakeRelayClient(relay.__port),
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'test-panel', bridged: true, localVersion: '1.0.0' }],
    log: () => {},
  })
  assert.notEqual(host.raw.match, originalMatch, 'the wrap is on the instance')
  handle.uninstall()
  assert.equal(host.raw.match, originalMatch, 'the uninstall restored the original while it held OUR wrap')
  const after = await host.get(`/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`)
  assert.equal(after.status, 200, 'the local route answers again, remote or not')
  assert.equal(host.hits.localPanel, 1)
  handle.uninstall() // idempotent

  // Chained-over: an outer wrap takes the seat, then our uninstall runs —
  // the outer wrap must survive, ours goes inert.
  const host2 = await startFakeHost()
  host2.registerLocalPlugin()
  const relay2 = await startFakeRelay()
  const inner = installPluginRouteIntercept({
    webServer: host2.raw,
    registry,
    relay: fakeRelayClient(relay2.__port),
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'test-panel', bridged: true, localVersion: '1.0.0' }],
    log: () => {},
  })
  const outerWrap = function match(pathname) { return host2.raw.exact.get(pathname) }
  const savedByOuter = host2.raw.match
  host2.raw.match = outerWrap
  inner.uninstall()
  assert.equal(host2.raw.match, outerWrap, 'the chained-over outer wrap was NOT replaced')
  const through = await host2.get(`/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`)
  assert.equal(through.status, 200, 'the outer wrap still serves (and ours never fired)')
  assert.equal(relay2.state.hits.length, 0, 'our inert wrap forwarded nothing')
  void savedByOuter
  await relay2.stop()
  await host2.stop()
  await relay.stop()
  await host.stop()
})

function sendRawUpgrade(port, pathWithQuery, after101) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks = []
    let headDone = false
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`raw upgrade timed out for ${pathWithQuery}`))
    }, 3000)
    socket.on('connect', () => {
      socket.write(
        `GET ${pathWithQuery} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`,
      )
    })
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      if (!headDone && after101 !== undefined) {
        const buf = Buffer.concat(chunks)
        if (buf.includes('\r\n\r\n')) {
          headDone = true
          after101(socket, buf.toString('utf8'))
        }
      }
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

test('T4 refusal log throttling: 5-min window per (kind, plugin, reason) keeps diagnostics accurate across route, HTTP 503 upgrade, and post-101 upgrade', async (t) => {
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const relay = await startFakeRelay()
  const registry = createBridgeRegistry()
  registry.register({
    plugin: 'test-panel',
    version: '1.0.0',
    routes: [
      { path: '/panel/data', scope: 'session' },
      { path: '/panel/ws', scope: 'session', upgrade: true },
      { path: '/panel/ws-json', scope: 'session', upgrade: true, locator: { in: 'json-body', fields: ['sessionId'] } },
    ],
  })
  registry.register({
    plugin: 'other-panel',
    version: '1.0.0',
    routes: [{ path: '/other/data', scope: 'session' }],
  })

  let fakeNow = 1_000_000
  const logs = []
  const debugs = []
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: fakeRelayClient(relay.__port),
    getServerId: () => SERVER_ID,
    getStatus: () => [
      { plugin: 'test-panel', bridged: false, reason: 'version-mismatch', localVersion: '1.0.0' },
      { plugin: 'other-panel', bridged: false, reason: 'version-mismatch', localVersion: '1.0.0' },
    ],
    now: () => fakeNow,
    log: (format, ...args) => logs.push({ format, args }),
    debug: (format, ...args) => debugs.push({ format, args }),
  })
  t.after(async () => {
    handle.uninstall()
    await relay.stop()
    await host.stop()
  })

  const isRefusalLine = (entry) => entry.format.includes('refused for')

  // 1. 10 consecutive route refusals for (test-panel, version-mismatch) within 5 min:
  //    1 log, 9 debug, diagnostics().refused === 10, refusalsByReason['version-mismatch'] === 10
  for (let i = 0; i < 10; i += 1) {
    fakeNow += 1_000
    const res = await host.get(`/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`)
    assert.equal(res.status, 503)
  }
  assert.equal(logs.filter(isRefusalLine).length, 1, 'only first route refusal logged at info level')
  assert.equal(debugs.filter(isRefusalLine).length, 9, 'remaining 9 route refusals went to debug')
  assert.equal(handle.diagnostics().refused, 10)
  assert.equal(handle.diagnostics().refusalsByReason['version-mismatch'], 10)

  // 2. Different reason on same plugin emits its own first log immediately
  const wrongMethod = await host.get(`/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`, { method: 'POST' })
  assert.equal(wrongMethod.status, 503)
  assert.equal(logs.filter(isRefusalLine).length, 2)
  assert.equal(handle.diagnostics().refusalsByReason['method-not-bridged'], 1)

  // 3. Different plugin with same reason emits its own first log immediately
  const otherRes = await host.get(`/other/data?sessionId=${encodeURIComponent(VIRTUAL)}`)
  assert.equal(otherRes.status, 503)
  assert.equal(logs.filter(isRefusalLine).length, 3)
  assert.equal(handle.diagnostics().refusalsByReason['version-mismatch'], 11)

  // 4. Advancing injected time past 5 * 60_000ms restores info logging for (test-panel, version-mismatch)
  fakeNow += 5 * 60_000 + 1
  const afterWindow = await host.get(`/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`)
  assert.equal(afterWindow.status, 503)
  assert.equal(logs.filter(isRefusalLine).length, 4, 'new window emits info log again')
  assert.match(logs.filter(isRefusalLine)[3].format, /suppressed %d repeats/)
  assert.equal(logs.filter(isRefusalLine)[3].args.at(-1), 9)
  assert.equal(handle.diagnostics().refusalsByReason['version-mismatch'], 12)

  // Immediate repeat in new window is throttled again
  const repeatInNewWindow = await host.get(`/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`)
  assert.equal(repeatInNewWindow.status, 503)
  assert.equal(logs.filter(isRefusalLine).length, 4)
  assert.equal(debugs.filter(isRefusalLine).length, 10)

  // 5. Upgrade refusal (HTTP 503 via answerUnbridgedSocket): separate 'upgrade' kind key
  for (let i = 0; i < 4; i += 1) {
    fakeNow += 1_000
    const raw = await sendRawUpgrade(host.port, `/panel/ws?sessionId=${encodeURIComponent(VIRTUAL)}`)
    assert.match(raw, /^HTTP\/1\.1 503/)
  }
  assert.equal(logs.filter(isRefusalLine).length, 5, 'first upgrade 503 logged at info even when route key is throttled')
  assert.equal(debugs.filter(isRefusalLine).length, 13, 'next 3 upgrade 503 refusals went to debug')
  assert.equal(handle.diagnostics().refusalsByReason['version-mismatch'], 17)

  fakeNow += 5 * 60_000 + 1
  const upgradeAfterWindow = await sendRawUpgrade(host.port, `/panel/ws?sessionId=${encodeURIComponent(VIRTUAL)}`)
  assert.match(upgradeAfterWindow, /^HTTP\/1\.1 503/)
  assert.equal(logs.filter(isRefusalLine).length, 6, 'upgrade 503 logs again after 5 min window')

  // 6. Upgrade refusal (post-101 via refuseAndDie)
  for (let i = 0; i < 4; i += 1) {
    fakeNow += 1_000
    const raw = await sendRawUpgrade(host.port, '/panel/ws-json', (socket) => {
      socket.write(encodeRfc6455Frame(0x1, Buffer.from('not-json'), true, true))
    })
    assert.match(raw, /^HTTP\/1\.1 101/)
  }
  assert.equal(logs.filter(isRefusalLine).length, 7, 'first post-101 upgrade refusal logged at info')
  assert.equal(debugs.filter(isRefusalLine).length, 16, 'next 3 post-101 upgrade refusals went to debug')
  assert.equal(handle.diagnostics().refusalsByReason['bad-query'], 4)

  fakeNow += 5 * 60_000 + 1
  await sendRawUpgrade(host.port, '/panel/ws-json', (socket) => {
    socket.write(encodeRfc6455Frame(0x1, Buffer.from('not-json'), true, true))
  })
  assert.equal(logs.filter(isRefusalLine).length, 8, 'post-101 upgrade refusal logs again after 5 min window')
  assert.equal(handle.diagnostics().refusalsByReason['bad-query'], 5)
  assert.equal(handle.diagnostics().refused, 24)
})

test('T4 refusal log throttling: refusalLogWindowMs=0 disables throttling', async (t) => {
  const host = await startFakeHost()
  host.registerLocalPlugin()
  const relay = await startFakeRelay()
  const registry = createBridgeRegistry()
  registry.register(DECLARED)
  const logs = []
  const debugs = []
  const handle = installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay: fakeRelayClient(relay.__port),
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'test-panel', bridged: false, reason: 'version-mismatch', localVersion: '1.0.0' }],
    refusalLogWindowMs: 0,
    log: (format, ...args) => logs.push({ format, args }),
    debug: (format, ...args) => debugs.push({ format, args }),
  })
  t.after(async () => {
    handle.uninstall()
    await relay.stop()
    await host.stop()
  })

  for (let i = 0; i < 3; i += 1) {
    const res = await host.get(`/panel/data?sessionId=${encodeURIComponent(VIRTUAL)}`)
    assert.equal(res.status, 503)
  }
  assert.equal(logs.filter((entry) => entry.format.includes('refused for')).length, 3)
  assert.equal(debugs.filter((entry) => entry.format.includes('refused for')).length, 0)
  assert.equal(handle.diagnostics().refused, 3)
})

test('D23-2: wrappedMatch and wrappedUpgradesGet preserve original auth without synthesizing absent auth', () => {
  const exact = new Map()
  const prefixes = new Map()
  const upgrades = new Map()
  const webServer = {
    exact,
    prefixes,
    upgrades,
    match(pathname) {
      return exact.get(pathname) ?? prefixes.get(pathname)
    },
  }
  const noop = () => {}
  exact.set('/panel/anon', { kind: 'exact', path: '/panel/anon', auth: 'anonymous', handler: noop })
  exact.set('/panel/deny', { kind: 'exact', path: '/panel/deny', auth: 'deny', handler: noop })
  exact.set('/panel/plain', { kind: 'exact', path: '/panel/plain', handler: noop })
  upgrades.set('/panel/ws-anon', { path: '/panel/ws-anon', auth: 'anonymous', handler: noop })
  upgrades.set('/panel/ws-deny', { path: '/panel/ws-deny', auth: 'deny', handler: noop })
  upgrades.set('/panel/ws-plain', { path: '/panel/ws-plain', handler: noop })

  const registry = createBridgeRegistry()
  registry.register({
    plugin: 'auth-panel',
    version: '1.0.0',
    routes: [
      { path: '/panel/anon', scope: 'session' },
      { path: '/panel/deny', scope: 'session' },
      { path: '/panel/plain', scope: 'session' },
      { path: '/panel/ws-anon', scope: 'session', upgrade: true },
      { path: '/panel/ws-deny', scope: 'session', upgrade: true },
      { path: '/panel/ws-plain', scope: 'session', upgrade: true },
    ],
  })

  const handle = installPluginRouteIntercept({
    webServer,
    registry,
    relay: {},
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'auth-panel', bridged: true, localVersion: '1.0.0', serverVersion: '1.0.0' }],
    log: () => {},
  })
  try {
    assert.equal(webServer.match('/panel/anon').auth, 'anonymous')
    assert.equal(webServer.match('/panel/deny').auth, 'deny')
    const plainMatch = webServer.match('/panel/plain')
    assert.equal('auth' in plainMatch, false, 'must not fabricate auth when original route omits it')

    assert.equal(webServer.upgrades.get('/panel/ws-anon').auth, 'anonymous')
    assert.equal(webServer.upgrades.get('/panel/ws-deny').auth, 'deny')
    const plainUpgrade = webServer.upgrades.get('/panel/ws-plain')
    assert.equal('auth' in plainUpgrade, false, 'must not fabricate auth when original upgrade omits it')
  } finally {
    handle.uninstall()
  }
})

test('PR77-1/PR77-2: wrappedMatch preserves WebResourceRoute resource and forwards peer on local resource, query handler, and upgrade', async (t) => {
  const { PassThrough } = require('node:stream')
  const { EventEmitter } = require('node:events')
  const relay = await startFakeRelay()
  t.after(() => relay.stop())
  const relayClient = fakeRelayClient(relay.__port)

  const exact = new Map()
  const prefixes = new Map()
  const upgrades = new Map()
  const webServer = {
    exact,
    prefixes,
    upgrades,
    match(pathname) {
      const exactHit = exact.get(pathname)
      if (exactHit !== undefined) return exactHit
      for (const [prefix, route] of prefixes) {
        if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return route
      }
      return undefined
    },
  }

  const seen = { resourcePeers: [], handlerPeers: [], upgradePeers: [] }
  exact.set('/panel/res', {
    kind: 'exact',
    path: '/panel/res',
    auth: 'anonymous',
    resource: async (request, peer) => {
      seen.resourcePeers.push({ method: request.method, peer })
      return new Response(request.method === 'HEAD' ? null : JSON.stringify({ localRes: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-local-res': 'yes' },
      })
    },
  })
  prefixes.set('/panel/res-prefix', {
    kind: 'prefix',
    path: '/panel/res-prefix',
    resource: async (request, peer) => {
      seen.resourcePeers.push({ method: request.method, peer, url: request.url })
      return new Response('prefix-local', { status: 200, headers: { 'x-prefix-res': '1' } })
    },
  })
  exact.set('/panel/data', {
    kind: 'exact',
    path: '/panel/data',
    handler: async (_req, res, peer) => {
      seen.handlerPeers.push(peer)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    },
  })
  upgrades.set('/panel/ws', {
    path: '/panel/ws',
    handler: (_req, socket, _head, peer) => {
      seen.upgradePeers.push(peer)
      socket.end()
    },
  })

  const registry = createBridgeRegistry()
  registry.register({
    plugin: 'res-panel',
    version: '1.0.0',
    routes: [
      { path: '/panel/res', scope: 'session' },
      { path: '/panel/res-prefix', scope: 'session', prefix: true },
      { path: '/panel/data', scope: 'session' },
      { path: '/panel/ws', scope: 'session', upgrade: true },
    ],
  })

  const handle = installPluginRouteIntercept({
    webServer,
    registry,
    relay: relayClient,
    getServerId: () => SERVER_ID,
    getStatus: () => [{ plugin: 'res-panel', bridged: true, localVersion: '1.0.0', serverVersion: '1.0.0' }],
    log: () => {},
  })
  t.after(() => handle.uninstall())

  const ownerPeer = { principal: { kind: 'owner', id: 'local-owner' } }

  // 1. WebResourceRoute keeps `.resource` (not `.handler`) and preserves auth
  const resRoute = webServer.match('/panel/res')
  assert.equal(typeof resRoute.resource, 'function')
  assert.equal(resRoute.handler, undefined)
  assert.equal(resRoute.auth, 'anonymous')

  const localHead = await resRoute.resource(
    new Request('http://127.0.0.1/panel/res?sessionId=local-1', { method: 'HEAD' }),
    ownerPeer,
  )
  assert.equal(localHead.status, 200)
  assert.equal(localHead.headers.get('x-local-res'), 'yes')
  assert.equal(seen.resourcePeers.length, 1)
  assert.equal(seen.resourcePeers[0].method, 'HEAD')
  assert.equal(seen.resourcePeers[0].peer, ownerPeer)

  const prefixRoute = webServer.match('/panel/res-prefix/sub.txt')
  assert.equal(typeof prefixRoute.resource, 'function')
  assert.equal(prefixRoute.handler, undefined)
  const localPrefix = await prefixRoute.resource(
    new Request('http://127.0.0.1/panel/res-prefix/sub.txt?sessionId=local-1'),
    ownerPeer,
  )
  assert.equal(await localPrefix.text(), 'prefix-local')
  assert.equal(seen.resourcePeers.length, 2)
  assert.equal(seen.resourcePeers[1].peer, ownerPeer)

  // Remote session still bridges through relay and returns a Fetch Response
  relay.state.reply = (_relayReq, relayRes) => {
    relayRes.writeHead(200, { 'content-type': 'application/json' })
    relayRes.end(JSON.stringify({ remoteRes: true }))
  }
  const remoteRes = await resRoute.resource(
    new Request(`http://127.0.0.1/panel/res?sessionId=${encodeURIComponent(VIRTUAL)}`),
    ownerPeer,
  )
  assert.equal(remoteRes.status, 200)
  assert.deepEqual(await remoteRes.json(), { remoteRes: true })
  assert.equal(seen.resourcePeers.length, 2, 'remote request must not invoke local resource')
  assert.equal(relay.state.hits.length, 1)
  assert.equal(relay.state.hits[0].zrQuery, 'sessionId=session-a')

  // 2. Local query handler receives forwarded peer
  const req = Object.assign(new EventEmitter(), {
    url: '/panel/data?sessionId=local-1',
    method: 'GET',
    headers: {},
    destroy() {},
  })
  const chunks = []
  const res = Object.assign(new PassThrough(), {
    statusCode: 200,
    setHeader() {},
    writeHead(code) { this.statusCode = code },
  })
  res.on('data', (c) => chunks.push(c))
  await webServer.match('/panel/data').handler(req, res, ownerPeer)
  assert.equal(seen.handlerPeers.length, 1)
  assert.equal(seen.handlerPeers[0], ownerPeer)
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), { ok: true })

  // 3. Local WebSocket upgrade receives forwarded peer
  const upReq = Object.assign(new EventEmitter(), {
    url: '/panel/ws?sessionId=local-1',
    method: 'GET',
    headers: {},
  })
  const socket = new PassThrough()
  webServer.upgrades.get('/panel/ws').handler(upReq, socket, Buffer.alloc(0), ownerPeer)
  assert.equal(seen.upgradePeers.length, 1)
  assert.equal(seen.upgradePeers[0], ownerPeer)
})
