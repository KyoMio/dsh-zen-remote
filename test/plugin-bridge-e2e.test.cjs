'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { createBridgeRegistry, normalizeDeclaration, compareBridges } = require('../lib/plugin-bridge.js')
const { createPluginLoopback } = require('../lib/plugin-loopback.js')
const { installPluginRouteIntercept } = require('../lib/plugin-route-intercept.js')
const { normalizeAdapter } = require('../lib/plugin-adapter-core.js')
const { toVirtual } = require('../lib/virtual-id.js')
const { request } = require('./util.cjs')
const { makeFakeHost, createE2eHarness, waitFor } = require('./helpers/relay-e2e-harness.cjs')

const harness = createE2eHarness('dsh-zen-remote-pb-e2e-')
const ROOT = harness.ROOT
test.before(() => harness.start())
test.after(() => harness.stop())
const boot = (opts) => harness.boot(opts)
const bootIsolated = (opts) => harness.bootIsolated(opts)

// ---- PB-3: the plugin forwarding route over the REAL gateway ------------------

test('e2e PB-3: a hand-written device POST to relay/v1/plugin crosses the gateway into the bridged plugin route', async () => {
  // The plugin side: a local fake DSH — token exchange at `/`, one NDJSON
  // plugin route demanding the cookie.
  const pluginHits = []
  const pluginServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://plugin.internal')
    if (url.pathname === '/') {
      res.writeHead(303, { 'set-cookie': 'dsh-auth=e2e; Path=/', location: '/' })
      res.end()
      return
    }
    pluginHits.push({ url: req.url ?? '/', cookie: String(req.headers.cookie ?? '') })
    if (String(req.headers.cookie ?? '') !== 'dsh-auth=e2e') {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write('e2e-frame-1\n')
    setTimeout(() => { res.write('e2e-frame-2\n'); res.end() }, 15)
  })
  await new Promise((resolve) => pluginServer.listen(0, '127.0.0.1', resolve))
  const pluginPort = pluginServer.address().port
  const pluginStop = () => new Promise((done) => { pluginServer.closeAllConnections(); pluginServer.close(done) })

  const declared = normalizeDeclaration({
    plugin: 'e2e-panel',
    version: '1.0.0',
    routes: [{ path: '/panel/stream', scope: 'session', stream: true }],
  })
  const registry = createBridgeRegistry()
  registry.register({
    plugin: 'e2e-panel',
    version: '1.0.0',
    routes: [{ path: '/panel/stream', scope: 'session', stream: true }],
  })
  const env = await boot({
    shared: ['session-a'],
    plugins: () => ({ 'e2e-panel': { version: '1.0.0', digest: declared.digest, serverScopeConsent: true } }),
    pluginBridge: {
      registry,
      getConsent: () => ({}),
      loopback: createPluginLoopback({
        getTarget: () => ({ protocol: 'http:', port: pluginPort }),
        getTokenUrl: () => `http://127.0.0.1:${pluginPort}/?token=t`,
      }),
    },
  })
  try {
    // The sub-client's hand-written forward: device Bearer against the
    // gateway (through the proxy hop, like every relay call), coordinates
    // in the x-zr-* headers, no body.
    const res = await request(env.proxyPort, {
      method: 'POST',
      path: '/_dsh/zen-remote/relay/v1/plugin',
      headers: {
        authorization: `Bearer ${env.deviceToken}`,
        accept: 'application/x-ndjson',
        'x-zr-plugin': 'e2e-panel',
        'x-zr-plugin-version': '1.0.0',
        'x-zr-plugin-digest': declared.digest,
        'x-zr-path': '/panel/stream',
        'x-zr-query': 'sessionId=session-a',
      },
    })
    assert.equal(res.status, 200, `the forward crosses the whole chain: ${res.body.slice(0, 200)}`)
    assert.equal(res.headers['content-type'], 'application/x-ndjson')
    assert.equal(res.headers['x-zen-remote-error'], undefined, 'a success carries no refusal marker')
    assert.deepEqual(
      res.body.split('\n').filter(Boolean),
      ['e2e-frame-1', 'e2e-frame-2'],
      'the streamed plugin answer arrives in order through gateway + proxy + relay + loopback',
    )
    // The loopback really ran against the local plugin: cookie exchanged
    // once, the session id forwarded as validated.
    assert.equal(pluginHits.filter((hit) => hit.url.startsWith('/panel/')).length, 2, 'one 401 + one cookie-authenticated hit')
    assert.ok(pluginHits.some((hit) => hit.cookie === 'dsh-auth=e2e'), 'the exchanged cookie authenticated the plugin request')
    const pluginUrl = new URL(`http://plugin.internal${pluginHits.find((hit) => hit.url.startsWith('/panel/'))?.url ?? '/'}`)
    assert.equal(pluginUrl.searchParams.get('sessionId'), 'session-a')
  } finally {
    await env.stop()
    await pluginStop()
  }
})

// ---- PB-2: the plugin bridge rides the handshake -----------------------------

/**
 * The client-side packaging index.ts wires around the relay client (PB-2):
 * the local registry's list against the LAST handshake's plugins table, with
 * `online` read live off the client state. The e2e tests run THIS exact
 * composition against the real chain, so the assertions below are about what
 * the handshake really carried.
 */
function bridgeStatusOf(localRegistry, client) {
  return compareBridges(localRegistry.list(), client.handshakeInfo?.plugins, client.state === 'online')
}

/** One declaration per scenario, same shape on both ends unless noted. */
const BRIDGE_DECL = (plugin, version, routes) => ({ plugin, version, routes })

test('e2e PB-2: the handshake plugins table drives every bridge verdict, and a consent flip lands on the NEXT connect', async () => {
  const local = createBridgeRegistry()
  local.register(BRIDGE_DECL('bridge-ok', '1.0.0', [{ path: '/ok', scope: 'session' }]))
  local.register(BRIDGE_DECL('bridge-ver', '1.0.0', [{ path: '/ver', scope: 'session' }]))
  local.register(BRIDGE_DECL('bridge-dec', '1.0.0', [{ path: '/dec', scope: 'session' }]))
  local.register(BRIDGE_DECL('bridge-consent', '1.0.0', [{ path: '/consent', scope: 'server' }]))
  local.register(BRIDGE_DECL('bridge-absent', '1.0.0', [{ path: '/absent', scope: 'session' }]))

  const serverRegistry = createBridgeRegistry()
  serverRegistry.register(BRIDGE_DECL('bridge-ok', '1.0.0', [{ path: '/ok', scope: 'session' }]))
  // Same declaration, different version → version-mismatch.
  serverRegistry.register(BRIDGE_DECL('bridge-ver', '2.0.0', [{ path: '/ver', scope: 'session' }]))
  // Same version, one route's scope differs → the digests diverge →
  // declaration-mismatch.
  serverRegistry.register(BRIDGE_DECL('bridge-dec', '1.0.0', [{ path: '/dec', scope: 'server' }]))
  // Identical to the local one; its consent is a LIVE variable the callback
  // reads per handshake — the flip below is the acceptance case.
  serverRegistry.register(BRIDGE_DECL('bridge-consent', '1.0.0', [{ path: '/consent', scope: 'server' }]))
  let consentGranted = false
  const env = await boot({
    plugins: () => {
      const table = {}
      for (const declaration of serverRegistry.list()) {
        table[declaration.plugin] = {
          version: declaration.version,
          digest: declaration.digest,
          serverScopeConsent: declaration.plugin === 'bridge-consent' ? consentGranted : true,
        }
      }
      return table
    },
  })
  try {
    await env.client.connect()
    assert.equal(env.client.state, 'online')
    const verdicts = new Map(bridgeStatusOf(local, env.client).map((s) => [s.plugin, s]))
    assert.equal(verdicts.size, 5, 'one status per local declaration')

    const ok = verdicts.get('bridge-ok')
    assert.equal(ok.bridged, true, 'name + version + digest all equal → bridged')
    assert.equal(ok.serverVersion, '1.0.0')

    const ver = verdicts.get('bridge-ver')
    assert.equal(ver.bridged, false)
    assert.equal(ver.reason, 'version-mismatch')
    assert.equal(ver.serverVersion, '2.0.0', 'the server version rides the status')

    const dec = verdicts.get('bridge-dec')
    assert.equal(dec.bridged, false)
    assert.equal(dec.reason, 'declaration-mismatch')
    assert.equal(dec.serverVersion, '1.0.0', 'the version agreed — only the digest differs')

    const consent = verdicts.get('bridge-consent')
    assert.equal(consent.bridged, false)
    assert.equal(consent.reason, 'consent-off', 'a server-scope route without consent stays home')

    const absent = verdicts.get('bridge-absent')
    assert.equal(absent.bridged, false)
    assert.equal(absent.reason, 'not-on-server')

    // The server grants consent; the verdict flips on the NEXT handshake —
    // the client dials again directly (the settings-page reconnect path).
    consentGranted = true
    await env.client.connect()
    const after = new Map(bridgeStatusOf(local, env.client).map((s) => [s.plugin, s]))
    assert.equal(after.get('bridge-consent').bridged, true, 'consent granted → bridged on the next connect')
    assert.equal(after.get('bridge-consent').reason, undefined)
  } finally {
    await env.stop()
  }
})

test('e2e PB-2: a throwing plugins table still handshakes, a stripped field reads server-too-old, and offline reads offline', async () => {
  const local = createBridgeRegistry()
  local.register(BRIDGE_DECL('bridge-any', '1.0.0', [{ path: '/any', scope: 'session' }]))
  const env = await bootIsolated({
    plugins: () => {
      throw new Error('the bridge table source is broken')
    },
  })
  try {
    // A throwing compute degrades to the empty table; the handshake itself
    // succeeds and the client reads not-on-server — never a dead link.
    await env.client.connect()
    assert.equal(env.client.state, 'online', 'the broken table did not fail the handshake')
    const [status] = bridgeStatusOf(local, env.client)
    assert.equal(status.reason, 'not-on-server', 'the degraded empty table means nothing is registered')

    // A TRUE old server: the handshake reply carries NO plugins field at all
    // (simulated at the fetch face, the only seam where the wire can lose
    // the field). The client must keep `undefined` — NOT normalize it — so
    // the verdict is server-too-old.
    const stripped = env.tunedClient({
      fetchImpl: async (url, init) => {
        const response = await fetch(url, init)
        if (typeof url === 'string' && url.endsWith('/relay/v1/handshake')) {
          const body = await response.json()
          delete body.plugins
          return new Response(JSON.stringify(body), { status: response.status, headers: { 'content-type': 'application/json' } })
        }
        return response
      },
    })
    await stripped.connect()
    assert.equal(stripped.state, 'online')
    assert.equal(stripped.handshakeInfo.plugins, undefined, 'an absent field stays undefined')
    const [tooOld] = bridgeStatusOf(local, stripped)
    assert.equal(tooOld.reason, 'server-too-old')

    // The link dies: the non-online state reads every plugin offline.
    await env.killGateway()
    await env.client.connect().catch(() => {})
    assert.equal(env.client.state, 'offline')
    const offline = bridgeStatusOf(local, env.client)
    assert.equal(offline.length, 1)
    assert.equal(offline[0].reason, 'offline')
    assert.equal(offline[0].bridged, false)
    assert.equal(offline[0].serverVersion, undefined, 'an offline verdict carries no server facts')
  } finally {
    await env.stop()
  }
})

// ---- PB-4: the sub-client route interception, full chain ----------------------

test('e2e PB-4: the browser hits the local webServer, the wrap forwards over the relay, the server loopbacks its plugin — streamed back end to end', async () => {
  // The SERVER's fake DSH: token exchange at `/`, the plugin routes behind
  // the cookie, one NDJSON stream, one holdable response.
  const dshState = { hits: 0, aborted: false }
  let hold
  const fakeDsh = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    if (url.pathname === '/') {
      res.writeHead(303, { 'set-cookie': 'dsh-auth=e2e; Path=/', location: '/' })
      res.end()
      return
    }
    dshState.hits += 1
    if (String(req.headers.cookie ?? '') !== 'dsh-auth=e2e') {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    if (url.pathname === '/panel/hold') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('held')
      hold = { release: () => res.end() }
      req.on('close', () => { dshState.aborted = true })
      return
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write('dsh-frame-1\n')
    setTimeout(() => res.write('dsh-frame-2\n'), 8)
    setTimeout(() => { res.write('dsh-frame-3\n'); res.end() }, 16)
  })
  await new Promise((resolve) => fakeDsh.listen(0, '127.0.0.1', resolve))
  const dshPort = fakeDsh.address().port
  const dshStop = () => new Promise((done) => { fakeDsh.closeAllConnections(); fakeDsh.close(done) })

  const DECLARED_INPUT = {
    plugin: 'e2e-panel',
    version: '1.0.0',
    routes: [
      { path: '/panel/stream', scope: 'session', stream: true },
      { path: '/panel/hold', scope: 'session' },
      { path: '/panel/all', scope: 'server' },
    ],
  }
  const declared = normalizeDeclaration(DECLARED_INPUT)
  const serverRegistry = createBridgeRegistry()
  serverRegistry.register(DECLARED_INPUT)
  const consentBox = { map: { 'e2e-panel': true } }

  const env = await boot({
    shared: ['session-a'],
    plugins: () => {
      const table = {}
      for (const d of serverRegistry.list()) {
        table[d.plugin] = { version: d.version, digest: d.digest, serverScopeConsent: consentBox.map[d.plugin] === true }
      }
      return table
    },
    pluginBridge: {
      registry: serverRegistry,
      getConsent: () => consentBox.map,
      loopback: createPluginLoopback({
        getTarget: () => ({ protocol: 'http:', port: dshPort }),
        getTokenUrl: () => `http://127.0.0.1:${dshPort}/?token=t`,
      }),
    },
  })

  // The SUB-CLIENT side: a host-shaped fake webServer (raw undecoded
  // pathname → this.match → handler), the SAME declaration registered
  // locally, the REAL relay client wired into the interception.
  const hostRaw = makeFakeHost()
  const subServer = http.createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    Promise.resolve(hostRaw.match(rawPath)).then(async (route) => {
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    }).catch(() => { try { res.destroy() } catch { /* gone */ } })
  })
  await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve))
  const subPort = subServer.address().port
  const subStop = () => new Promise((done) => { subServer.closeAllConnections(); subServer.close(done) })

  const localRegistry = createBridgeRegistry()
  localRegistry.register(DECLARED_INPUT)
  const bridgeStatusOf = () =>
    compareBridges(localRegistry.list(), env.client.handshakeInfo?.plugins, env.client.state === 'online')
  const handle = installPluginRouteIntercept({
    webServer: hostRaw,
    registry: localRegistry,
    relay: env.client,
    getServerId: () => env.client.handshakeInfo?.serverId,
    getStatus: bridgeStatusOf,
    log: () => {},
  })

  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    const virtual = toVirtual(info.serverId, 'session-a')
    const base = `http://127.0.0.1:${subPort}`

    // 1. The streamed answer crosses every hop in order: browser → local
    //    match wrap → relay client → gateway child → relay route →
    //    loopback → fake DSH.
    const stream = await fetch(`${base}/panel/stream?sessionId=${encodeURIComponent(virtual)}`)
    assert.equal(stream.status, 200, `the bridged stream: ${await stream.clone().text().catch(() => '')}`.slice(0, 300))
    assert.equal(stream.headers.get('content-type'), 'application/x-ndjson')
    assert.equal(await stream.text(), 'dsh-frame-1\ndsh-frame-2\ndsh-frame-3\n', 'three hops, three frames, one order')
    assert.equal(dshState.hits, 2, 'one 401 + one cookie-authenticated hit on the fake DSH')

    // 2. The consent wall: server scope refused while the server owner has
    //    NOT consented — flipped here WITHOUT touching either process, both
    //    ends read it live.
    consentBox.map = {}
    const unconsented = await fetch(`${base}/panel/all?sessionId=${encodeURIComponent(virtual)}`)
    assert.equal(unconsented.status, 503)
    assert.equal(unconsented.headers.get('x-zen-remote'), 'unbridged')
    assert.deepEqual(await unconsented.json(), {
      ok: false, error: { code: 'zr-plugin-unbridged', reason: 'consent-off', plugin: 'e2e-panel' },
    })

    // 3. The mid-stream hang-up: the browser aborts a held response; the
    //    abort crosses every hop and the fake DSH sees its connection close.
    consentBox.map = { 'e2e-panel': true }
    const controller = new AbortController()
    const pending = fetch(`${base}/panel/hold?sessionId=${encodeURIComponent(virtual)}`, { signal: controller.signal })
    const held = await pending
    assert.equal(held.status, 200)
    await waitFor(() => dshState.hits >= 2)
    controller.abort()
    await held.text().catch(() => 'aborted')
    await waitFor(() => dshState.aborted === true)
    assert.equal(dshState.aborted, true, 'the abort crossed the whole chain into the fake DSH')
  } finally {
    handle.uninstall()
    if (hold !== undefined) hold.release()
    await env.stop()
    await subStop()
    await dshStop()
  }
})

// ---- PB-9: write requests end to end, at the 1 MiB boundary -------------------

test('e2e PB-9: a 1 MiB POST crosses the whole chain byte for byte; one byte over the declared cap refuses locally with 413', async () => {
  const seen = { hits: 0, bytes: 0, ct: '' }
  const fakeDsh = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    if (url.pathname === '/') {
      res.writeHead(303, { 'set-cookie': 'dsh-auth=e2e; Path=/', location: '/' })
      res.end()
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.hits += 1
      seen.bytes = Buffer.concat(chunks).length
      seen.ct = String(req.headers['content-type'] ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ received: seen.bytes }))
    })
  })
  await new Promise((resolve) => fakeDsh.listen(0, '127.0.0.1', resolve))
  const dshPort = fakeDsh.address().port
  const dshStop = () => new Promise((done) => { fakeDsh.closeAllConnections(); fakeDsh.close(done) })

  // maxBody declared EXPLICITLY at exactly 1 MiB: the boundary is the
  // contract, not the default.
  const DECLARED_INPUT = {
    plugin: 'e2e-panel',
    version: '1.0.0',
    routes: [{ path: '/panel/write', scope: 'session', methods: ['POST'], maxBody: 1024 * 1024 }],
  }
  const declared = normalizeDeclaration(DECLARED_INPUT)
  const serverRegistry = createBridgeRegistry()
  serverRegistry.register(DECLARED_INPUT)
  const env = await boot({
    shared: ['session-a'],
    plugins: () => {
      const table = {}
      for (const d of serverRegistry.list()) {
        table[d.plugin] = { version: d.version, digest: d.digest, serverScopeConsent: true }
      }
      return table
    },
    pluginBridge: {
      registry: serverRegistry,
      getConsent: () => ({ 'e2e-panel': true }),
      loopback: createPluginLoopback({
        getTarget: () => ({ protocol: 'http:', port: dshPort }),
        getTokenUrl: () => `http://127.0.0.1:${dshPort}/?token=t`,
      }),
    },
  })

  // The sub-client side: a host-shaped fake webServer with the interception.
  const hostRaw = makeFakeHost()
  const subServer = http.createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    Promise.resolve(hostRaw.match(rawPath)).then(async (route) => {
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    }).catch(() => { try { res.destroy() } catch { /* gone */ } })
  })
  await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve))
  const subPort = subServer.address().port
  const subStop = () => new Promise((done) => { subServer.closeAllConnections(); subServer.close(done) })

  const localRegistry = createBridgeRegistry()
  localRegistry.register(DECLARED_INPUT)
  const handle = installPluginRouteIntercept({
    webServer: hostRaw,
    registry: localRegistry,
    relay: env.client,
    getServerId: () => env.client.handshakeInfo?.serverId,
    getStatus: () => compareBridges(localRegistry.list(), env.client.handshakeInfo?.plugins, env.client.state === 'online'),
    log: () => {},
  })

  try {
    await env.client.connect()
    assert.equal(env.client.state, 'online')
    const virtual = toVirtual(env.client.handshakeInfo?.serverId ?? '', 'session-a')
    const base = `http://127.0.0.1:${subPort}`

    // EXACTLY the declared cap: crosses every hop, byte for byte.
    const exactly = Buffer.alloc(1024 * 1024, 0x61)
    const ok = await fetch(`${base}/panel/write?sessionId=${encodeURIComponent(virtual)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: exactly,
    })
    const okBody = await ok.json().catch(() => ({ error: { code: 'unreadable' } }))
    assert.equal(ok.status, 200, `the 1 MiB write crossed: ${JSON.stringify(okBody)}`)
    assert.deepEqual(okBody, { received: 1024 * 1024 })
    assert.equal(seen.bytes, 1024 * 1024, 'the fake DSH received the whole MiB')
    assert.equal(seen.ct, 'application/octet-stream', 'the content type rode every hop')

    // One byte over: refused at the SUB-CLIENT (before the relay sees a
    // byte) with the local 413 shape.
    const over = Buffer.alloc(1024 * 1024 + 1, 0x61)
    const refused = await fetch(`${base}/panel/write?sessionId=${encodeURIComponent(virtual)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: over,
    })
    assert.equal(refused.status, 413)
    assert.deepEqual(await refused.json(), { ok: false, error: { code: 'zr-plugin-body-too-large' } })
    assert.equal(seen.hits, 1, 'the over-limit write never reached the server')

    // CHUNKED over-limit (PB-9-fix): a TRUE no-Content-Length body trips
    // the gate mid-forward. The local 413 answers — and, decisive, the REAL
    // relay client never judged the link offline for its caller's abort:
    // the connection stays online for everything after it.
    const chunked = await fetch(`${base}/panel/write?sessionId=${encodeURIComponent(virtual)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(1024 * 1024 + 1)))
          controller.close()
        },
      }),
      duplex: 'half',
    })
    const chunkedBody = await chunked.json()
    assert.equal(chunked.status, 413, `the chunked over-limit answer: ${JSON.stringify(chunkedBody)}`)
    assert.deepEqual(chunkedBody, { ok: false, error: { code: 'zr-plugin-body-too-large' } })
    assert.equal(seen.hits, 1, 'the chunked over-limit never reached the server either')
    assert.equal(env.client.state, 'online', 'the gate trip is a caller verdict — the relay client stayed online')
  } finally {
    handle.uninstall()
    await env.stop()
    await subStop()
    await dshStop()
  }
})

// ---- PB-10: the WebSocket byte tunnel end to end ------------------------------

/** Minimal WebSocket server helpers (RFC 6455, text frames only — the
 * handshake accept, a masked-client-frame decoder, and an unmasked
 * server-frame encoder). No npm dependency, per the task boundary. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
}
function wsEncodeText(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let head
  if (length < 126) {
    head = Buffer.from([0x81, length])
  } else if (length < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x81
    head[1] = 126
    head.writeUInt16BE(length, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x81
    head[1] = 127
    head.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([head, payload])
}
/** Decode ONE client frame (masked per RFC). Returns { opcode, text } or
 * null when the chunk is not one complete frame (the tests keep frames
 * small enough to arrive whole). */
function wsDecodeClientFrame(chunk) {
  if (chunk.length < 2) return null
  const opcode = chunk[0] & 0x0f
  const masked = (chunk[1] & 0x80) !== 0
  let length = chunk[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (chunk.length < 4) return null
    length = chunk.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (chunk.length < 10) return null
    length = Number(chunk.readBigUInt64BE(2))
    offset = 10
  }
  const mask = masked ? chunk.subarray(offset, offset + 4) : null
  if (masked) offset += 4
  const payload = chunk.subarray(offset, offset + length)
  if (masked) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
  }
  return { opcode, text: payload.toString('utf8') }
}

test('e2e PB-10: a browser WebSocket on the sub-client speaks to the bridged plugin through the byte tunnel; unbridged refuses 503; local sessions stay local', async () => {
  // ---- the SERVER's fake DSH: a real http server whose 'upgrade' handler
  // is a hand-written WebSocket endpoint (handshake, echo, one server push,
  // close awareness).
  const dshWs = { opened: 0, echoed: [], closed: false, pushed: false }
  const fakeDsh = http.createServer((req, res) => {
    // The tunnel's cookie exchange lands here (GET /?token=...).
    res.writeHead(303, { 'set-cookie': 'dsh-auth=e2e; Path=/', location: '/' })
    res.end()
  })
  fakeDsh.on('upgrade', (req, socket) => {
    dshWs.opened += 1
    const key = req.headers['sec-websocket-key']
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`)
    socket.write(wsEncodeText('server-push-hello'))
    socket.on('data', (chunk) => {
      const frame = wsDecodeClientFrame(chunk)
      if (frame === null) return
      if (frame.opcode === 0x8) {
        dshWs.closed = true
        socket.end()
        return
      }
      if (frame.opcode === 0x1) {
        dshWs.echoed.push(frame.text)
        socket.write(wsEncodeText(`echo:${frame.text}`))
      }
    })
    socket.on('close', () => { dshWs.closed = true })
  })
  await new Promise((resolve) => fakeDsh.listen(0, '127.0.0.1', resolve))
  const dshPort = fakeDsh.address().port
  const dshStop = () => new Promise((done) => { fakeDsh.closeAllConnections(); fakeDsh.close(done) })

  const DECLARED_INPUT = {
    plugin: 'e2e-panel',
    version: '1.0.0',
    routes: [{ path: '/panel/ws', scope: 'session', upgrade: true }],
  }
  const serverRegistry = createBridgeRegistry()
  serverRegistry.register(DECLARED_INPUT)
  // The tunnel's server half, wired over the SAME pieces before boot.
  const pluginTunnelMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-tunnel.js')).href)
  const pluginLoopbackObj = createPluginLoopback({
    getTarget: () => ({ protocol: 'http:', port: dshPort }),
    getTokenUrl: () => `http://127.0.0.1:${dshPort}/?token=t`,
  })
  const shareStoreMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'share-store.js')).href)
  const tunnelStore = shareStoreMod.createShareStore({ file: path.join(ROOT, `tunnel-e2e-${Date.now()}.json`), idleHours: 48 })
  tunnelStore.share('session-a')
  const pluginTunnel = pluginTunnelMod.createPluginTunnel({
    bridge: { registry: serverRegistry, getConsent: () => ({ 'e2e-panel': true }), loopback: pluginLoopbackObj },
    getTarget: () => ({ protocol: 'http:', port: dshPort }),
    isAccessible: (sessionId) => sessionId === 'session-a',
    heartbeatMs: 15_000,
  })
  // The server's plugins table starts EMPTY (the first WebSocket below must
  // hit the unbridged wall) and fills in for the re-handshake after it.
  const pluginsBox = { table: {} }
  const env = await boot({
    shared: ['session-a'],
    plugins: () => pluginsBox.table,
    pluginBridge: {
      registry: serverRegistry,
      getConsent: () => ({ 'e2e-panel': true }),
      loopback: pluginLoopbackObj,
      tunnel: pluginTunnel,
    },
  })

  // ---- the SUB-CLIENT side: a host-shaped fake webServer with BOTH the
  // match wrap and the upgrade interception, plus a real upgrade listener.
  const hostRaw = makeFakeHost()
  const subServer = http.createServer(() => {})
  const localWs = { opened: 0 }
  // The LOCAL plugin's own upgrade handler (the one remote sessions must
  // NEVER reach). The fake host's upgrade dispatch mirrors the real host:
  // the route table lookup, then the handler, async body detached.
  subServer.on('upgrade', (req, socket, head) => {
    try {
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const route = hostRaw.upgrades.get(rawPath)
      if (route !== undefined) {
        route.handler(req, socket, head)
        return
      }
      socket.destroy()
    } catch {
      socket.destroy()
    }
  })
  // The local route itself (registered on the same table the intercept
  // shadows): a same-shaped WS endpoint marking its hits.
  hostRaw.upgrades.set('/panel/ws', {
    path: '/panel/ws',
    handler: (req, socket) => {
      localWs.opened += 1
      const key = req.headers['sec-websocket-key']
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`)
      socket.write(wsEncodeText('local-answer'))
    },
  })
  await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve))
  const subPort = subServer.address().port
  // Node stops tracking an UPGRADED socket (closeAllConnections never sees
  // it — verified on v22), so the teardown destroys every connection this
  // server accepted by hand before closing.
  const subSockets = new Set()
  subServer.on('connection', (socket) => {
    subSockets.add(socket)
    socket.on('close', () => subSockets.delete(socket))
  })
  const subStop = () => new Promise((done) => {
    for (const socket of subSockets) socket.destroy()
    subServer.closeAllConnections()
    subServer.close(done)
  })

  const localRegistry = createBridgeRegistry()
  localRegistry.register(DECLARED_INPUT)
  const handle = installPluginRouteIntercept({
    webServer: hostRaw,
    registry: localRegistry,
    relay: env.client,
    getServerId: () => env.client.handshakeInfo?.serverId,
    getStatus: () => compareBridges(localRegistry.list(), env.client.handshakeInfo?.plugins, env.client.state === 'online'),
    log: () => {},
  })

  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    const virtual = toVirtual(info.serverId, 'session-a')

    // ---- 1. UNBRIDGED first (the statuses start empty): the browser's
    //    WebSocket gets the 503 with the marker; the LOCAL handler never ran.
    const unbridged = new WebSocket(`ws://127.0.0.1:${subPort}/panel/ws?sessionId=${encodeURIComponent(virtual)}`)
    const unbridgedResult = await new Promise((resolve) => {
      // The verdict must ARRIVE — a socket that just sits there fails the
      // test here instead of hanging the whole case.
      const timer = setTimeout(() => resolve({ timeout: true }), 5000)
      unbridged.addEventListener('open', () => { clearTimeout(timer); resolve({ opened: true }) })
      unbridged.addEventListener('error', (event) => { clearTimeout(timer); resolve({ opened: false, error: event.error ?? event.message }) })
      unbridged.addEventListener('close', (event) => { clearTimeout(timer); resolve({ opened: false, closedCode: event.code }) })
    })
    assert.equal(unbridgedResult.timeout, undefined, `the unbridged socket must answer at all: ${JSON.stringify(unbridgedResult)}`)
    assert.equal(unbridgedResult.opened, false, `the unbridged socket must not open: ${JSON.stringify(unbridgedResult)}`)
    assert.equal(localWs.opened, 0, 'the local upgrade handler never ran')
    // The server now announces the plugin; the re-handshake picks the table
    // up and every later virtual-id call takes the tunnel.
    pluginsBox.table = Object.fromEntries(
      serverRegistry.list().map((d) => [d.plugin, { version: d.version, digest: d.digest, serverScopeConsent: true }]),
    )
    await env.client.connect() // re-handshake to pick up the plugins table

    // ---- 2. BRIDGED: handshake opens, echo round-trips, the server push
    // arrives, close closes — everything through the byte tunnel.
    const bridged = new WebSocket(`ws://127.0.0.1:${subPort}/panel/ws?sessionId=${encodeURIComponent(virtual)}`)
    const messages = []
    const bridgedOpened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      bridged.addEventListener('open', () => { clearTimeout(timer); resolve(true) })
      bridged.addEventListener('error', (event) => { clearTimeout(timer); resolve(`error: ${event.error ?? event.message}`) })
    })
    assert.equal(bridgedOpened, true, `the bridged handshake: ${JSON.stringify(bridgedOpened)}`)
    bridged.addEventListener('message', (event) => { messages.push(String(event.data)) })
    bridged.send('hello-tunnel')
    await waitFor(() => messages.includes('echo:hello-tunnel') && messages.includes('server-push-hello') && dshWs.echoed.includes('hello-tunnel'))
    assert.ok(messages.includes('echo:hello-tunnel'), `the echo arrived: ${JSON.stringify(messages)}`)
    assert.ok(messages.includes('server-push-hello'), `the server push arrived: ${JSON.stringify(messages)}`)
    assert.ok(dshWs.echoed.includes('hello-tunnel'), 'the server side decoded the browser frame')

    // ---- 3. Close: the browser closes; the server side learns.
    bridged.close()
    await waitFor(() => dshWs.closed === true)
    assert.equal(dshWs.closed, true, 'the server side saw the close')

    // ---- 4. A LOCAL session on the same route: the intercept passthrough —
    // the LOCAL handler answers (its own marker message proves it).
    const local = new WebSocket(`ws://127.0.0.1:${subPort}/panel/ws?sessionId=session-local`)
    const localMessages = []
    const localOpened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000)
      local.addEventListener('open', () => { clearTimeout(timer); resolve(true) })
      local.addEventListener('error', () => { clearTimeout(timer); resolve(false) })
    })
    assert.equal(localOpened, true, 'the local session opened against the LOCAL handler')
    local.addEventListener('message', (event) => { localMessages.push(String(event.data)) })
    await waitFor(() => localMessages.includes('local-answer'))
    assert.ok(localMessages.includes('local-answer'), 'the local answer came from the LOCAL handler')
    assert.equal(localWs.opened, 1, 'exactly the local session reached the local handler')
    local.close()
  } finally {
    handle.uninstall()
    await env.stop()
    await subStop()
    await dshStop()
  }
})

// ---- PB-11: an adapter crosses the whole chain end to end ----------------------

test('e2e PB-11: a fake adapter forwards a JSON-body request for a remote session and maps the answer\u2019s id back to virtual form', async () => {
  // The fake DSH: the third-party plugin's route. It records what arrived
  // and answers with a body carrying the REAL session id.
  const dshHits = []
  const dshServer = http.createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://x').pathname === '/') {
      res.writeHead(303, { 'set-cookie': 'dsh-auth=e2e; Path=/', location: '/' })
      res.end()
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      dshHits.push({ path: new URL(req.url ?? '/', 'http://x').pathname, body: Buffer.concat(chunks).toString('utf8') })
      const body = JSON.parse(dshHits[dshHits.length - 1].body || '{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ served: true, sessionId: body.sessionId ?? 'unknown' }))
    })
  })
  await new Promise((resolve) => dshServer.listen(0, '127.0.0.1', resolve))
  const dshPort = dshServer.address().port
  const dshStop = () => new Promise((done) => { dshServer.closeAllConnections(); dshServer.close(done) })

  // The fake adapter (the tests' stand-in for a real one — the real array
  // in src/adapters/ stays empty until PB-12): JSON-body locating plus a
  // response rewrite.
  const ADAPTER_INPUT = {
    plugin: 'fake-panel', versions: ['1.0.0'],
    client: { response: (ctx) => ({ ...ctx.body, sessionId: ctx.virtualize(ctx.body.sessionId) }) },
    routes: [{ path: '/fake-panel/api', match: 'prefix', methods: ['POST'], locator: { in: 'json-body', fields: ['sessionId'] } }],
  }
  const adapter = normalizeAdapter(ADAPTER_INPUT, '1.0.0')
  const env = await boot({
    shared: ['session-a'],
    plugins: () => ({ 'fake-panel': { version: '1.0.0', digest: adapter.digest, serverScopeConsent: true } }),
    pluginBridge: {
      registry: (() => { const r = createBridgeRegistry(); r.registerNormalized(adapter.declaration); return r })(),
      getConsent: () => ({ 'fake-panel': true }),
      loopback: createPluginLoopback({
        getTarget: () => ({ protocol: 'http:', port: dshPort }),
        getTokenUrl: () => `http://127.0.0.1:${dshPort}/?token=t`,
      }),
      adapters: [adapter],
    },
  })

  const hostRaw = {
    exact: new Map(), prefixes: new Map(), upgrades: new Map(),
    match(pathname) { return this.exact.get(pathname) ?? [...this.prefixes.values()].find((r) => pathname.startsWith(`${r.path}/`)) },
    register(route) { (route.kind === 'exact' ? this.exact : this.prefixes).set(route.path, route); return () => undefined },
  }
  const subServer = http.createServer((req, res) => {
    Promise.resolve(hostRaw.match(new URL(req.url ?? '/', 'http://x').pathname)).then(async (route) => {
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    }).catch(() => { try { res.destroy() } catch { /* gone */ } })
  })
  await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve))
  const subPort = subServer.address().port
  const subStop = () => new Promise((done) => { subServer.closeAllConnections(); subServer.close(done) })

  const localRegistry = createBridgeRegistry()
  localRegistry.registerNormalized(adapter.declaration)
  const handle = installPluginRouteIntercept({
    webServer: hostRaw,
    registry: localRegistry,
    relay: env.client,
    getServerId: () => env.client.handshakeInfo?.serverId,
    getStatus: () => compareBridges(localRegistry.list(), env.client.handshakeInfo?.plugins, env.client.state === 'online'),
    adapters: [adapter],
    log: () => {},
  })

  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    const virtual = toVirtual(info.serverId, 'session-a')

    const answer = await fetch(`http://127.0.0.1:${subPort}/fake-panel/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual, note: 'hello' }),
    })
    assert.equal(answer.status, 200, `the adapter forward crossed every hop: ${await answer.clone().text()}`)
    assert.deepEqual(await answer.json(), { served: true, sessionId: virtual }, 'the answer\u2019s real id came back VIRTUAL')
    // The fake DSH saw the REAL id and the untouched extra field.
    assert.equal(dshHits.length, 1)
    assert.equal(dshHits[0].path, '/fake-panel/api/open')
    const seen = JSON.parse(dshHits[0].body)
    assert.equal(seen.sessionId, 'session-a', 'the plugin received the REAL id')
    assert.equal(seen.note, 'hello')
    assert.equal(answer.headers.get('content-length'), String(Buffer.byteLength(JSON.stringify({ served: true, sessionId: virtual }))), 'the content-length matches the rewritten body')
  } finally {
    handle.uninstall()
    await env.stop()
    await subStop()
    await dshStop()
  }
})

// ---- PB-12: the better-sidebar adapter crosses the whole chain -----------------

test('e2e PB-12: the better-sidebar adapter reads, writes and serves the html preview across the full chain; a drifted version bridges only through its wire surface', async () => {
  // The fake DSH: better-sidebar's real route shapes (the /sidebar/api
  // dispatcher, the file media route, the html preview with its CSP).
  const dshHits = []
  const fakeDsh = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/') {
      res.writeHead(303, { 'set-cookie': 'dsh-auth=e2e; Path=/', location: '/' })
      res.end()
      return
    }
    if (url.pathname === '/sidebar/api/git.status') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        dshHits.push({ path: url.pathname, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ branch: 'main', sessionId: body.sessionId ?? null }))
      })
      return
    }
    if (url.pathname === '/sidebar/api/git.commit') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        dshHits.push({ path: url.pathname, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, cwdSeen: body.cwd ?? null }))
      })
      return
    }
    if (url.pathname.startsWith('/sidebar/html/')) {
      const segments = url.pathname.slice('/sidebar/html/'.length).split('/').map((s) => decodeURIComponent(s))
      dshHits.push({ path: url.pathname, sessionId: segments[0] })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': 'sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src \'none\'',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end('<html><body>preview</body></html>')
      return
    }
    // The raw text-write route (PB-15, 0.26.0 lib/index.js:7875-7919):
    // POST, the session id + path + cwd ride the QUERY, the body is the
    // plain document text, and the answer rides writeOk's {ok:true, value}
    // envelope — the fake uses the REAL wire shape (the 2026-10-13 lesson:
    // never copy the handler's bare return value).
    if (url.pathname === '/sidebar/write') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        dshHits.push({ path: url.pathname, query: url.searchParams, body: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, value: { ok: true, path: url.searchParams.get('path') } }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => fakeDsh.listen(0, '127.0.0.1', resolve))
  const dshPort = fakeDsh.address().port
  const dshStop = () => new Promise((done) => { fakeDsh.closeAllConnections(); fakeDsh.close(done) })

  const ADAPTER_INPUT = {
    plugin: 'dsh-better-sidebar', versions: ['0.25.0', '0.26.0', '0.26.1'],
    routes: [
      { path: '/sidebar/api', match: 'prefix', methods: ['POST'], maxBody: 1024 * 1024, locator: { in: 'json-body', fields: ['sessionId', 'rootSessionId', 'childId'] } },
      { path: '/sidebar/file', match: 'exact', methods: ['GET'], locator: { in: 'query', name: 'sessionId' } },
      { path: '/sidebar/write', match: 'exact', methods: ['POST'], maxBody: 10 * 1024 * 1024, locator: { in: 'query', name: 'sessionId' } },
      { path: '/sidebar/html', match: 'prefix', methods: ['GET'], locator: { in: 'path-segment', index: 0 } },
      { path: '/sidebar/bundle', match: 'prefix', methods: ['GET'], locator: { in: 'query', name: 'sessionId' }, local: true },
    ],
    server: {
      request: (ctx) => {
        // The media/write routes: the client-supplied query cwd goes — a
        // remote panel never steers the server by path (PB-15 adds write).
        if (ctx.pathname === '/sidebar/file' || ctx.pathname === '/sidebar/write') {
          if (ctx.query.get('cwd') !== null) {
            const stripped = new URLSearchParams(ctx.query)
            stripped.delete('cwd')
            return { allow: true, query: stripped }
          }
          return { allow: true }
        }
        if (ctx.body !== null && typeof ctx.body === 'object' && 'cwd' in ctx.body) {
          const stripped = { ...ctx.body }
          delete stripped.cwd
          return { allow: true, body: stripped }
        }
        return { allow: true }
      },
    },
    client: {
      response: (ctx) => {
        if (ctx.pathname === '/sidebar/api/git.status' && ctx.body !== null && typeof ctx.body === 'object' && typeof ctx.body.sessionId === 'string') {
          return { ...ctx.body, sessionId: ctx.virtualize(ctx.body.sessionId) }
        }
        return ctx.body
      },
    },
  }
  const adapter = normalizeAdapter(ADAPTER_INPUT, '0.25.0')
  // PB-19: the surface-admitted twin — the SAME route table, but the version
  // (0.27.0) sits OUTSIDE `versions` and gets in through the surfaces table
  // (the 0.28.1 generation digest stands in for "wire-identical upstream").
  const surfaceInput = { ...ADAPTER_INPUT, surfaces: { '65a0acaeb56f87d9': 'the 0.28.1 generation' } }
  const surfaceAdapter = normalizeAdapter(surfaceInput, '0.27.0', { surfaceDigest: '65a0acaeb56f87d9' })
  const env = await boot({
    shared: ['session-a'],
    plugins: () => ({ 'dsh-better-sidebar': { version: '0.25.0', digest: adapter.digest, serverScopeConsent: true } }),
    pluginBridge: {
      registry: (() => { const r = createBridgeRegistry(); r.registerNormalized(adapter.declaration); return r })(),
      getConsent: () => ({ 'dsh-better-sidebar': true }),
      loopback: createPluginLoopback({
        getTarget: () => ({ protocol: 'http:', port: dshPort }),
        getTokenUrl: () => `http://127.0.0.1:${dshPort}/?token=t`,
      }),
      adapters: [adapter],
    },
  })

  const hostRaw = {
    exact: new Map(), prefixes: new Map(), upgrades: new Map(),
    match(pathname) {
      const exact = this.exact.get(pathname)
      if (exact !== undefined) return exact
      for (const [, route] of this.prefixes) {
        if (pathname === route.path || pathname.startsWith(`${route.path}/`)) return route
      }
      return undefined
    },
    register(route) { (route.kind === 'exact' ? this.exact : this.prefixes).set(route.path, route); return () => undefined },
  }
  const subServer = http.createServer((req, res) => {
    Promise.resolve(hostRaw.match(new URL(req.url ?? '/', 'http://x').pathname)).then(async (route) => {
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    }).catch(() => { try { res.destroy() } catch { /* gone */ } })
  })
  await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve))
  const subPort = subServer.address().port
  const subStop = () => new Promise((done) => { subServer.closeAllConnections(); subServer.close(done) })

  const localRegistry = createBridgeRegistry()
  localRegistry.registerNormalized(adapter.declaration)
  const handle = installPluginRouteIntercept({
    webServer: hostRaw,
    registry: localRegistry,
    relay: env.client,
    getServerId: () => env.client.handshakeInfo?.serverId,
    getStatus: () => compareBridges(localRegistry.list(), env.client.handshakeInfo?.plugins, env.client.state === 'online'),
    adapters: [adapter],
    log: () => {},
  })

  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    const virtual = toVirtual(info.serverId, 'session-a')

    // READ: git.status forwards and the answer's id comes back virtual.
    const read = await fetch(`http://127.0.0.1:${subPort}/sidebar/api/git.status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual }),
    })
    assert.equal(read.status, 200, await read.clone().text())
    const readBody = await read.json()
    assert.equal(readBody.sessionId, virtual, 'the answer id came back VIRTUAL')
    assert.equal(dshHits[0].body.sessionId, 'session-a', 'the fake plugin saw the REAL id')

    // WRITE: git.commit forwards, and the client cwd is stripped server-side.
    const write = await fetch(`http://127.0.0.1:${subPort}/sidebar/api/git.commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual, message: 'ship it', cwd: '/home/me/leaked' }),
    })
    assert.equal(write.status, 200)
    assert.equal(dshHits[1].body.cwd, undefined, 'the server hook stripped the cwd before the loopback')
    assert.equal(dshHits[1].body.message, 'ship it')

    // HTML: the segment id rewrites, and the CSP + hardening headers survive the hop.
    const html = await fetch(`http://127.0.0.1:${subPort}/sidebar/html/${encodeURIComponent(virtual)}/index.html`)
    assert.equal(html.status, 200)
    assert.match(html.headers.get('content-security-policy') ?? '', /sandbox allow-scripts/, 'the CSP sandbox travelled')
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff', 'nosniff header travelled')
    assert.equal(html.headers.get('referrer-policy'), 'no-referrer', 'referrer-policy header travelled')
    assert.equal((await html.text()).includes('preview'), true)
    assert.equal(dshHits[2].sessionId, 'session-a', 'the html segment arrived as the REAL id')

    // RAW WRITE (PB-15, 0.26.0's /sidebar/write): the query id rewrites to
    // REAL, the query cwd is stripped server-side, the text body crosses
    // verbatim, and writeOk's envelope comes back untouched.
    const raw = await fetch(`http://127.0.0.1:${subPort}/sidebar/write?sessionId=${encodeURIComponent(virtual)}&path=notes.md&cwd=${encodeURIComponent('/home/me/leaked')}`, {
      method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'the document text',
    })
    assert.equal(raw.status, 200, await raw.clone().text())
    assert.deepEqual(await raw.json(), { ok: true, value: { ok: true, path: 'notes.md' } }, 'the envelope came back')
    assert.equal(dshHits[3].path, '/sidebar/write')
    assert.equal(dshHits[3].query.get('sessionId'), 'session-a', 'the query id arrived REAL')
    assert.equal(dshHits[3].query.get('cwd'), null, 'the server hook stripped the query cwd')
    assert.equal(dshHits[3].query.get('path'), 'notes.md')
    assert.equal(dshHits[3].body, 'the document text', 'the text body crossed verbatim')

    // (PB-19, case 1) A version outside the table whose surface MISSES never
    // bridges — the original drifted behavior, twice over: normalizeAdapter
    // refuses the registration outright (nothing exists to forward with),
    // and a two-end version disagreement still reads version-mismatch.
    assert.throws(() => normalizeAdapter(surfaceInput, '0.27.0', { surfaceDigest: '0000000000000000' }), /not among the adapter's versions/)
    const driftedRegistry = createBridgeRegistry()
    driftedRegistry.registerNormalized(adapter.declaration)
    const driftedStatus = compareBridges(
      driftedRegistry.list(),
      { 'dsh-better-sidebar': { version: '0.27.0', digest: adapter.digest, serverScopeConsent: true } },
      true,
    )
    assert.equal(driftedStatus[0].bridged, false)
    assert.equal(driftedStatus[0].reason, 'version-mismatch')

    // (PB-19, case 2) Version outside the table, surface HIT → the full
    // PB-12 chain bridges: both ends register the surface-admitted 0.27.0,
    // the server's plugins table announces the same version/digest pair, and
    // a read crosses with the id rewrite — the exact relief ADR-0003 promises.
    handle.uninstall()
    const surfaceEnv = await boot({
      shared: ['session-a'],
      plugins: () => ({ 'dsh-better-sidebar': { version: '0.27.0', digest: surfaceAdapter.digest, serverScopeConsent: true } }),
      pluginBridge: {
        registry: (() => { const r = createBridgeRegistry(); r.registerNormalized(surfaceAdapter.declaration); return r })(),
        getConsent: () => ({ 'dsh-better-sidebar': true }),
        loopback: createPluginLoopback({
          getTarget: () => ({ protocol: 'http:', port: dshPort }),
          getTokenUrl: () => `http://127.0.0.1:${dshPort}/?token=t`,
        }),
        adapters: [surfaceAdapter],
      },
    })
    const surfaceRegistry = createBridgeRegistry()
    surfaceRegistry.registerNormalized(surfaceAdapter.declaration)
    const surfaceHandle = installPluginRouteIntercept({
      webServer: hostRaw,
      registry: surfaceRegistry,
      relay: surfaceEnv.client,
      getServerId: () => surfaceEnv.client.handshakeInfo?.serverId,
      getStatus: () => compareBridges(surfaceRegistry.list(), surfaceEnv.client.handshakeInfo?.plugins, surfaceEnv.client.state === 'online'),
      adapters: [surfaceAdapter],
      log: () => {},
    })
    try {
      const surfaceInfo = await surfaceEnv.client.connect()
      assert.equal(surfaceEnv.client.state, 'online')
      const surfaceVirtual = toVirtual(surfaceInfo.serverId, 'session-a')
      const hitsBefore = dshHits.length
      const surfaceRead = await fetch(`http://127.0.0.1:${subPort}/sidebar/api/git.status`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: surfaceVirtual }),
      })
      assert.equal(surfaceRead.status, 200, await surfaceRead.clone().text())
      assert.equal((await surfaceRead.json()).sessionId, surfaceVirtual, 'the answer id came back VIRTUAL for the surface-admitted version')
      assert.equal(dshHits[hitsBefore].path, '/sidebar/api/git.status')
      assert.equal(dshHits[hitsBefore].body.sessionId, 'session-a', 'the fake plugin saw the REAL id')
    } finally {
      surfaceHandle.uninstall()
      await surfaceEnv.stop()
    }
  } finally {
    handle.uninstall()
    await env.stop()
    await subStop()
    await dshStop()
  }
})

// ---- PB-13: the better-sidebar WebSockets cross the byte tunnel ---------------

test('e2e PB-13: fs-watch speaks through the tunnel both ways and agent-opens pushes server-initiated frames; sidechat forwards end to end', async () => {
  // The fake DSH: both WS endpoints (handshake, per-message behaviour) plus
  // the cookie-exchange and one sidechat method.
  const dshState = { fsWatchOpened: 0, watched: [], pushed: false, agentOpensOpened: 0, agentOpensSeenClose: false, sidechatStarts: [] }
  // ONE request listener (a createServer callback would answer every
  // request TWICE alongside the on('request') handler below).
  const fakeDsh = http.createServer()
  const fsWatchSockets = new Set()
  const agentOpensSockets = new Set()
  fakeDsh.on('upgrade', (req, socket) => {
    agentOpensSockets.add(socket)
    socket.on('close', () => agentOpensSockets.delete(socket))
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const key = req.headers['sec-websocket-key']
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`)
    if (url.pathname === '/sidebar/ws/fs-watch') {
      dshState.fsWatchOpened += 1
      if (url.searchParams.get('sessionId') !== 'session-a') {
        socket.end()
        return
      }
      fsWatchSockets.add(socket)
      socket.on('data', (chunk) => {
        const frame = wsDecodeClientFrame(chunk)
        if (frame === null || frame.opcode !== 0x1) return
        const message = JSON.parse(frame.text)
        if (message.op === 'watch') {
          dshState.watched.push(message.path)
          if (socket.writable) socket.write(wsEncodeText(JSON.stringify({ dir: `/srv/proj/${message.path}` })))
        }
      })
      socket.on('close', () => fsWatchSockets.delete(socket))
      return
    }
    if (url.pathname === '/sidebar/ws/agent-opens') {
      dshState.agentOpensOpened += 1
      if (url.searchParams.get('sessionId') !== 'session-a') {
        socket.end()
        return
      }
      socket.on('close', () => { dshState.agentOpensSeenClose = true })
      // The SERVER-initiated push (the whole point of agent-opens).
      dshState.pushed = true
      socket.write(wsEncodeText(JSON.stringify({ id: 'req-1', sessionId: 'session-a', kind: 'file', target: '/srv/proj/README.md', title: 'README' })))
      return
    }
    socket.destroy()
  })
  fakeDsh.on('request', (req, res) => {
    if (new URL(req.url ?? '/', 'http://x').pathname === '/sidebar/api/sidechat.start') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        dshState.sidechatStarts.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        // The REAL wire shape: writeOk wraps the handler result.
        res.end(JSON.stringify({ ok: true, value: { childId: 'session-child-9' } }))
      })
      return
    }
    res.writeHead(303, { 'set-cookie': 'dsh-auth=e2e; Path=/', location: '/' })
    res.end()
  })
  await new Promise((resolve) => fakeDsh.listen(0, '127.0.0.1', resolve))
  const dshPort = fakeDsh.address().port
  const dshStop = () => new Promise((done) => {
    // Upgraded sockets escape closeAllConnections (the PB-10 finding).
    for (const socket of [...fsWatchSockets, ...agentOpensSockets]) socket.destroy()
    fakeDsh.closeAllConnections()
    fakeDsh.close(done)
  })

  const ADAPTER_INPUT = {
    plugin: 'dsh-better-sidebar', versions: ['0.25.0'],
    client: { response: (ctx) => (ctx.pathname === '/sidebar/api/sidechat.start' && ctx.body !== null && typeof ctx.body === 'object' && ctx.body.ok === true && ctx.body.value !== null && typeof ctx.body.value === 'object' && typeof ctx.body.value.childId === 'string' && !ctx.isVirtual(ctx.body.value.childId) ? { ...ctx.body, value: { ...ctx.body.value, childId: ctx.virtualize(ctx.body.value.childId) } } : ctx.body) },
    routes: [
      { path: '/sidebar/api', match: 'prefix', methods: ['POST'], maxBody: 1024 * 1024, locator: { in: 'json-body', fields: ['sessionId', 'rootSessionId', 'childId'] } },
      { path: '/sidebar/ws/agent-opens', match: 'exact', methods: ['GET'], upgrade: true, locator: { in: 'query', name: 'sessionId' } },
      { path: '/sidebar/ws/fs-watch', match: 'exact', methods: ['GET'], upgrade: true, locator: { in: 'query', name: 'sessionId' } },
    ],
  }
  const adapter = normalizeAdapter(ADAPTER_INPUT, '0.25.0')
  // The tunnel's server half, wired over the SAME pieces before boot (the
  // PB-10 shape — the WebSocket routes answer 501 unsupported without it).
  const pluginTunnelMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-tunnel.js')).href)
  const pluginLoopbackObj = createPluginLoopback({
    getTarget: () => ({ protocol: 'http:', port: dshPort }),
    getTokenUrl: () => `http://127.0.0.1:${dshPort}/?token=t`,
  })
  const pluginTunnel = pluginTunnelMod.createPluginTunnel({
    bridge: { registry: (() => { const r = createBridgeRegistry(); r.registerNormalized(adapter.declaration); return r })(), getConsent: () => ({ 'dsh-better-sidebar': true }), loopback: pluginLoopbackObj },
    getTarget: () => ({ protocol: 'http:', port: dshPort }),
    isAccessible: (sessionId) => sessionId === 'session-a',
    heartbeatMs: 15_000,
  })
  const env = await boot({
    shared: ['session-a'],
    plugins: () => ({ 'dsh-better-sidebar': { version: '0.25.0', digest: adapter.digest, serverScopeConsent: true } }),
    pluginBridge: {
      registry: (() => { const r = createBridgeRegistry(); r.registerNormalized(adapter.declaration); return r })(),
      getConsent: () => ({ 'dsh-better-sidebar': true }),
      loopback: pluginLoopbackObj,
      adapters: [adapter],
      tunnel: pluginTunnel,
    },
  })

  const hostRaw = {
    exact: new Map(), prefixes: new Map(), upgrades: new Map(),
    match(pathname) { return this.exact.get(pathname) },
    register(route) { this.exact.set(route.path, route); return () => undefined },
  }
  const subServer = http.createServer((req, res) => {
    // The HTTP half (sidechat.start) dispatches through the SAME wrapped
    // match; the WS half rides the upgrade listener below.
    Promise.resolve(hostRaw.match(new URL(req.url ?? '/', 'http://x').pathname)).then(async (route) => {
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    }).catch(() => { try { res.destroy() } catch { /* gone */ } })
  })
  subServer.on('upgrade', (req, socket, head) => {
    const route = hostRaw.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (route !== undefined) {
      route.handler(req, socket, head)
      return
    }
    socket.destroy()
  })
  await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve))
  const subPort = subServer.address().port
  // Node stops tracking an UPGRADED socket (closeAllConnections never sees
  // it — the PB-10 finding), so the teardown destroys every connection this
  // server accepted by hand before closing.
  const subSockets = new Set()
  subServer.on('connection', (socket) => {
    subSockets.add(socket)
    socket.on('close', () => subSockets.delete(socket))
  })
  const subStop = () => new Promise((done) => {
    for (const socket of subSockets) socket.destroy()
    subServer.closeAllConnections()
    subServer.close(done)
  })

  const localRegistry = createBridgeRegistry()
  localRegistry.registerNormalized(adapter.declaration)
  const handle = installPluginRouteIntercept({
    webServer: hostRaw,
    registry: localRegistry,
    relay: env.client,
    getServerId: () => env.client.handshakeInfo?.serverId,
    getStatus: () => compareBridges(localRegistry.list(), env.client.handshakeInfo?.plugins, env.client.state === 'online'),
    adapters: [adapter],
    log: () => {},
  })

  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    const virtual = toVirtual(info.serverId, 'session-a')

    // ---- fs-watch: handshake opens through the tunnel, the browser's
    // watch frame crosses, the server's {dir} push comes back.
    const fsWatch = new WebSocket(`ws://127.0.0.1:${subPort}/sidebar/ws/fs-watch?sessionId=${encodeURIComponent(virtual)}`)
    const fsOpened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 5000)
      fsWatch.addEventListener('open', () => { clearTimeout(timer); resolve(true) })
      fsWatch.addEventListener('error', (event) => { clearTimeout(timer); resolve(`error: ${event.message ?? event.error ?? 'unknown'}`) })
      fsWatch.addEventListener('close', (event) => { clearTimeout(timer); resolve(`close code=${event.code} reason=${event.reason}`) })
    })
    assert.equal(fsOpened, true, 'the fs-watch handshake opened through the tunnel')
    const fsMessages = []
    fsWatch.addEventListener('message', (event) => { fsMessages.push(String(event.data)) })
    fsWatch.send(JSON.stringify({ op: 'watch', path: 'src' }))
    await waitFor(() => dshState.fsWatchOpened === 1 && dshState.watched.length === 1 && fsMessages.some((text) => JSON.parse(text).dir === '/srv/proj/src'))
    assert.equal(dshState.fsWatchOpened, 1, 'the fake DSH accepted the upgrade')
    assert.deepEqual(dshState.watched, ['src'], 'the watch op crossed to the server')
    assert.ok(fsMessages.some((text) => JSON.parse(text).dir === '/srv/proj/src'), `the server push arrived: ${JSON.stringify(fsMessages)}`)
    fsWatch.close()
    await waitFor(() => fsWatch.readyState >= WebSocket.CLOSING)

    // ---- agent-opens: the SERVER-initiated push arrives at the browser.
    const agentOpens = new WebSocket(`ws://127.0.0.1:${subPort}/sidebar/ws/agent-opens?sessionId=${encodeURIComponent(virtual)}`)
    const agentOpened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      agentOpens.addEventListener('open', () => { clearTimeout(timer); resolve(true) })
      agentOpens.addEventListener('error', () => { clearTimeout(timer); resolve(false) })
    })
    assert.equal(agentOpened, true, 'the agent-opens handshake opened through the tunnel')
    const agentMessages = []
    agentOpens.addEventListener('message', (event) => { agentMessages.push(String(event.data)) })
    await waitFor(() => dshState.pushed === true && agentMessages.length === 1)
    assert.equal(dshState.pushed, true)
    assert.equal(agentMessages.length, 1, 'the server push crossed the tunnel')
    const pushed = JSON.parse(agentMessages[0])
    assert.equal(pushed.kind, 'file')
    assert.equal(pushed.sessionId, 'session-a', 'the push bytes travel VERBATIM (the browser never reads this field)')

    // ---- sidechat.start forwards and the answer's childId comes back
    // virtual — the closed loop, end to end.
    const start = await fetch(`http://127.0.0.1:${subPort}/sidebar/api/sidechat.start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual, question: 'what changed?' }),
    })
    assert.equal(start.status, 200)
    assert.deepEqual(await start.json(), { ok: true, value: { childId: toVirtual(info.serverId, 'session-child-9') } }, 'the child id came back VIRTUAL inside the envelope')
    assert.deepEqual(dshState.sidechatStarts, [{ sessionId: 'session-a', question: 'what changed?' }], 'the plugin saw the REAL ids')
  } finally {
    handle.uninstall()
    await env.stop()
    await subStop()
    await dshStop()
  }
})

// ---- PB-26b: the sidechat ws (a json-body upgrade) crosses the whole chain ----

test('e2e PB-26b: ws/sidechat watch frames rewrite both ways through the frame gate; an unshared thread id never reaches the plugin', async () => {
  // The fake DSH: the sidechat ws endpoint — handshake, watch recording, a
  // push back per watched thread (the REAL id on the wire, exactly the
  // 0.26 push shape) — plus the cookie exchange the tunnel's loopback rides.
  const dshState = { opened: 0, watched: [] }
  const sidechatSockets = new Set()
  const fakeDsh = http.createServer((req, res) => {
    res.writeHead(303, { 'set-cookie': 'dsh-auth=e2e; Path=/', location: '/' })
    res.end()
  })
  fakeDsh.on('upgrade', (req, socket) => {
    sidechatSockets.add(socket)
    socket.on('close', () => sidechatSockets.delete(socket))
    if (new URL(req.url ?? '/', 'http://dsh.internal').pathname !== '/sidebar/ws/sidechat') {
      socket.destroy()
      return
    }
    dshState.opened += 1
    const key = req.headers['sec-websocket-key']
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`)
    socket.on('data', (chunk) => {
      const frame = wsDecodeClientFrame(chunk)
      if (frame === null || frame.opcode !== 0x1) return
      const message = JSON.parse(frame.text)
      if (message.op === 'watch') {
        dshState.watched.push(message.threadIds)
        for (const tid of message.threadIds) {
          socket.write(wsEncodeText(JSON.stringify({ threadId: tid })))
        }
      }
    })
  })
  await new Promise((resolve) => fakeDsh.listen(0, '127.0.0.1', resolve))
  const dshPort = fakeDsh.address().port
  const dshStop = () => new Promise((done) => {
    // Upgraded sockets escape closeAllConnections (the PB-10 finding).
    for (const socket of sidechatSockets) socket.destroy()
    fakeDsh.closeAllConnections()
    fakeDsh.close(done)
  })

  // The REAL better-sidebar adapter at its listed 0.25.0 version — the
  // declaration under test is the one production registers, with the
  // PB-26b sidechat route and the threadId response hook.
  const adaptersMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'adapters', 'index.js')).href)
  const rawAdapter = adaptersMod.ADAPTERS.find((entry) => entry.plugin === 'dsh-better-sidebar')
  const adapter = normalizeAdapter(rawAdapter, '0.25.0')

  // The tunnel's server half — the frame gate lives in its send route.
  const pluginTunnelMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-tunnel.js')).href)
  const pluginLoopbackObj = createPluginLoopback({
    getTarget: () => ({ protocol: 'http:', port: dshPort }),
    getTokenUrl: () => `http://127.0.0.1:${dshPort}/?token=t`,
  })
  const pluginTunnel = pluginTunnelMod.createPluginTunnel({
    bridge: { registry: (() => { const r = createBridgeRegistry(); r.registerNormalized(adapter.declaration); return r })(), getConsent: () => ({ 'dsh-better-sidebar': true }), loopback: pluginLoopbackObj },
    getTarget: () => ({ protocol: 'http:', port: dshPort }),
    // The sidechat child inherits its parent's share (the ancestor chain
    // the sidechat.* HTTP calls pass through too).
    isAccessible: (sessionId) => sessionId === 'session-a' || sessionId === 'session-child-9',
    heartbeatMs: 15_000,
  })
  const env = await boot({
    shared: ['session-a'],
    plugins: () => ({ 'dsh-better-sidebar': { version: '0.25.0', digest: adapter.digest, serverScopeConsent: true } }),
    pluginBridge: {
      registry: (() => { const r = createBridgeRegistry(); r.registerNormalized(adapter.declaration); return r })(),
      getConsent: () => ({ 'dsh-better-sidebar': true }),
      loopback: pluginLoopbackObj,
      adapters: [adapter],
      tunnel: pluginTunnel,
    },
  })

  const hostRaw = {
    exact: new Map(), prefixes: new Map(), upgrades: new Map(),
    match(pathname) { return this.exact.get(pathname) },
    register(route) { this.exact.set(route.path, route); return () => undefined },
  }
  const subServer = http.createServer(() => {})
  subServer.on('upgrade', (req, socket, head) => {
    const route = hostRaw.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (route !== undefined) {
      route.handler(req, socket, head)
      return
    }
    socket.destroy()
  })
  await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve))
  const subPort = subServer.address().port
  // Node stops tracking an UPGRADED socket (closeAllConnections never sees
  // it — the PB-10 finding), so the teardown destroys every connection this
  // server accepted by hand before closing.
  const subSockets = new Set()
  subServer.on('connection', (socket) => {
    subSockets.add(socket)
    socket.on('close', () => subSockets.delete(socket))
  })
  const subStop = () => new Promise((done) => {
    for (const socket of subSockets) socket.destroy()
    subServer.closeAllConnections()
    subServer.close(done)
  })

  const localRegistry = createBridgeRegistry()
  localRegistry.registerNormalized(adapter.declaration)
  const handle = installPluginRouteIntercept({
    webServer: hostRaw,
    registry: localRegistry,
    relay: env.client,
    getServerId: () => env.client.handshakeInfo?.serverId,
    getStatus: () => compareBridges(localRegistry.list(), env.client.handshakeInfo?.plugins, env.client.state === 'online'),
    adapters: [adapter],
    log: () => {},
  })

  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    const serverId = info.serverId
    const virtualChild = toVirtual(serverId, 'session-child-9')

    // ---- the happy path: the browser's watch frame crosses REAL, the
    // plugin's push comes back VIRTUAL — the exact better-sidebar exchange,
    // with NO query parameter on the upgrade URL at all.
    const ws = new WebSocket(`ws://127.0.0.1:${subPort}/sidebar/ws/sidechat`)
    const opened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 5000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(true) })
      ws.addEventListener('error', (event) => { clearTimeout(timer); resolve(`error: ${event.message ?? event.error ?? 'unknown'}`) })
      ws.addEventListener('close', (event) => { clearTimeout(timer); resolve(`close code=${event.code}`) })
    })
    assert.equal(opened, true, `the 101 answered without any query parameter: ${JSON.stringify(opened)}`)
    const messages = []
    ws.addEventListener('message', (event) => { messages.push(String(event.data)) })
    ws.send(JSON.stringify({ op: 'watch', threadIds: [virtualChild] }))
    await waitFor(() => dshState.watched.length > 0)
    assert.deepEqual(dshState.watched, [['session-child-9']], 'the plugin saw the REAL child id')
    await waitFor(() => messages.length > 0)
    assert.deepEqual(messages.map((text) => JSON.parse(text).threadId), [virtualChild], 'the push arrived VIRTUAL (the response hook rewrote the frame)')
    ws.close()
    await waitFor(() => ws.readyState >= WebSocket.CLOSING)

    // ---- the share wall, frame by frame: an unshared thread id is refused
    // on the server's send gate — the plugin never sees it, and the refusal
    // tears the tunnel (and with it the browser socket) down.
    const watchedBefore = dshState.watched.length
    const unshared = new WebSocket(`ws://127.0.0.1:${subPort}/sidebar/ws/sidechat`)
    const unsharedOpened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      unshared.addEventListener('open', () => { clearTimeout(timer); resolve(true) })
      unshared.addEventListener('error', () => { clearTimeout(timer); resolve(false) })
    })
    assert.equal(unsharedOpened, true, 'the second socket opened (the 101 is unconditional)')
    const unsharedOutcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('still-open'), 5000)
      unshared.addEventListener('close', () => { clearTimeout(timer); resolve('closed') })
      unshared.addEventListener('error', () => { clearTimeout(timer); resolve('errored') })
      unshared.send(JSON.stringify({ op: 'watch', threadIds: [toVirtual(serverId, 'session-unshared')] }))
    })
    assert.notEqual(unsharedOutcome, 'still-open', `the unshared watch killed the connection: ${JSON.stringify(unsharedOutcome)}`)
    await waitFor(() => unshared.readyState >= WebSocket.CLOSING)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(dshState.watched.length, watchedBefore, 'the unshared id never reached the plugin')
    unshared.close()
  } finally {
    handle.uninstall()
    await env.stop()
    await subStop()
    await dshStop()
  }
})

// ---- PB-24: a declarative v2 plugin crosses the whole chain --------------------

test('e2e PB-24: a declarative v2 plugin — json-body, prefix, deny, rewriteIds — crosses the whole chain', async () => {
  // The fake DSH: the server-side plugin's routes. The deny route's twin
  // records hits but must never be reached — the refusal answers on the
  // sub-client before any forward.
  const dshHits = []
  const fakeDsh = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/') {
      res.writeHead(303, { 'set-cookie': 'dsh-auth=e2e; Path=/', location: '/' })
      res.end()
      return
    }
    if (url.pathname === '/zb/api') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        dshHits.push({ path: url.pathname, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ served: true, sessionId: body.sessionId ?? null }))
      })
      return
    }
    if (url.pathname.startsWith('/zb/files/')) {
      dshHits.push({ path: url.pathname, sessionId: url.searchParams.get('sessionId') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ file: true, path: url.pathname }))
      return
    }
    if (url.pathname === '/zb/whoami') {
      dshHits.push({ path: url.pathname, sessionId: url.searchParams.get('sessionId') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ me: 'session-a', friend: 'session-b', list: ['session-a', 'session-c'] }))
      return
    }
    if (url.pathname === '/zb/vault') {
      dshHits.push({ path: url.pathname })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ vault: true }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => fakeDsh.listen(0, '127.0.0.1', resolve))
  const dshPort = fakeDsh.address().port
  const dshStop = () => new Promise((done) => { fakeDsh.closeAllConnections(); fakeDsh.close(done) })

  // The declarative v2 plugin: the four behaviors under test, one route each.
  const DECLARATION = {
    plugin: 'zb-panel',
    version: '2.0.0',
    routes: [
      // json-body locating + rewriteIds: the request's id crosses REAL, the
      // answer's id comes back VIRTUAL — both directions in one exchange.
      { path: '/zb/api', scope: 'session', methods: ['POST'], maxBody: 4096, locator: { in: 'json-body', fields: ['sessionId'] }, rewriteIds: true },
      // prefix: the full matched sub-path forwards, the query id rewrites.
      { path: '/zb/files', scope: 'session', prefix: true, locator: { in: 'query', name: 'sessionId' } },
      // rewriteIds alone: the answer's deep scan rewrites the request's OWN
      // id; ids the request never carried pass verbatim (the documented
      // request-local boundary).
      { path: '/zb/whoami', scope: 'session', rewriteIds: true },
      // deny: local-only data — a remote context never crosses.
      { path: '/zb/vault', scope: 'session', deny: true },
    ],
  }
  const digest = normalizeDeclaration(DECLARATION).digest
  const env = await boot({
    shared: ['session-a'],
    plugins: () => ({ 'zb-panel': { version: '2.0.0', digest, serverScopeConsent: true } }),
    pluginBridge: {
      registry: (() => { const r = createBridgeRegistry(); r.register(DECLARATION); return r })(),
      getConsent: () => ({ 'zb-panel': true }),
      loopback: createPluginLoopback({
        getTarget: () => ({ protocol: 'http:', port: dshPort }),
        getTokenUrl: () => `http://127.0.0.1:${dshPort}/?token=t`,
      }),
    },
  })

  const hostRaw = {
    exact: new Map(), prefixes: new Map(), upgrades: new Map(),
    match(pathname) {
      const exact = this.exact.get(pathname)
      if (exact !== undefined) return exact
      for (const [, route] of this.prefixes) {
        if (pathname === route.path || pathname.startsWith(`${route.path}/`)) return route
      }
      return undefined
    },
    register(route) { (route.kind === 'exact' ? this.exact : this.prefixes).set(route.path, route); return () => undefined },
  }
  // The deny route's LOCAL handler: the pass-through target proving a local
  // session's request runs exactly as if the bridge were not installed.
  const localHits = []
  hostRaw.register({ kind: 'exact', path: '/zb/vault', handler: async (req, res) => {
    localHits.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ local: true }))
  } })
  const subServer = http.createServer((req, res) => {
    Promise.resolve(hostRaw.match(new URL(req.url ?? '/', 'http://x').pathname)).then(async (route) => {
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    }).catch(() => { try { res.destroy() } catch { /* gone */ } })
  })
  await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve))
  const subPort = subServer.address().port
  const subStop = () => new Promise((done) => { subServer.closeAllConnections(); subServer.close(done) })

  const localRegistry = createBridgeRegistry()
  localRegistry.register(DECLARATION)
  // The T62 current-session signal, wired like src/index.ts: the deny wall
  // reads it live per request.
  const sessionBox = { value: undefined }
  const handle = installPluginRouteIntercept({
    webServer: hostRaw,
    registry: localRegistry,
    relay: env.client,
    getServerId: () => env.client.handshakeInfo?.serverId,
    getStatus: () => compareBridges(localRegistry.list(), env.client.handshakeInfo?.plugins, env.client.state === 'online'),
    getCurrentSession: () => sessionBox.value,
    log: () => {},
  })

  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    const virtual = toVirtual(info.serverId, 'session-a')

    // json-body: the body id crosses REAL, the answer id comes back VIRTUAL.
    const api = await fetch(`http://127.0.0.1:${subPort}/zb/api`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual, note: 'hello' }),
    })
    assert.equal(api.status, 200, await api.clone().text())
    assert.deepEqual(await api.json(), { served: true, sessionId: virtual }, 'the answer id came back VIRTUAL')
    assert.equal(dshHits.length, 1)
    assert.equal(dshHits[0].body.sessionId, 'session-a', 'the plugin received the REAL id')
    assert.equal(dshHits[0].body.note, 'hello', 'the untouched field crossed verbatim')

    // The share wall reads the LOCATED body id: an unshared session's id
    // refuses before the plugin is ever reached.
    const secret = await fetch(`http://127.0.0.1:${subPort}/zb/api`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: toVirtual(info.serverId, 'session-secret') }),
    })
    assert.equal(secret.status, 503)
    assert.equal(secret.headers.get('x-zen-remote'), 'unbridged')
    assert.deepEqual(await secret.json(), { ok: false, error: { code: 'zr-plugin-unbridged', reason: 'not-shared', plugin: 'zb-panel' } })
    assert.equal(dshHits.length, 1, 'the unshared id never reached the plugin')

    // prefix: the full sub-path reaches the plugin, the query id REAL.
    const file = await fetch(`http://127.0.0.1:${subPort}/zb/files/docs/readme.md?sessionId=${encodeURIComponent(virtual)}`)
    assert.equal(file.status, 200, await file.clone().text())
    assert.equal(dshHits.length, 2)
    assert.equal(dshHits[1].path, '/zb/files/docs/readme.md', 'the full sub-path reached the plugin')
    assert.equal(dshHits[1].sessionId, 'session-a', 'the query id arrived REAL')

    // rewriteIds: the request's own id comes back virtual from an envelope
    // field and an array; ids the request never carried stay verbatim.
    const who = await fetch(`http://127.0.0.1:${subPort}/zb/whoami?sessionId=${encodeURIComponent(virtual)}`)
    assert.equal(who.status, 200, await who.clone().text())
    assert.deepEqual(await who.json(), {
      me: virtual,
      friend: 'session-b',
      list: [virtual, 'session-c'],
    }, 'own id VIRTUAL, new ids verbatim')
    assert.equal(dshHits.length, 3)

    // deny, request id: the uniform 503 route-denied, nothing crossed.
    const denied = await fetch(`http://127.0.0.1:${subPort}/zb/vault?sessionId=${encodeURIComponent(virtual)}`)
    assert.equal(denied.status, 503)
    assert.equal(denied.headers.get('x-zen-remote'), 'unbridged')
    assert.deepEqual(await denied.json(), { ok: false, error: { code: 'zr-plugin-unbridged', reason: 'route-denied', plugin: 'zb-panel' } })
    assert.equal(localHits.length, 0)
    assert.equal(dshHits.length, 3, 'the server-side plugin saw nothing new')

    // deny, current session: a remote panel is refused without carrying an
    // id of its own (T62's signal read through the real install).
    sessionBox.value = virtual
    const deniedCurrent = await fetch(`http://127.0.0.1:${subPort}/zb/vault`)
    assert.equal(deniedCurrent.status, 503)
    assert.deepEqual(await deniedCurrent.json(), { ok: false, error: { code: 'zr-plugin-unbridged', reason: 'route-denied', plugin: 'zb-panel' } })
    sessionBox.value = undefined

    // deny, local session: the local handler runs, the relay never sees it.
    const localPass = await fetch(`http://127.0.0.1:${subPort}/zb/vault?sessionId=session-local`)
    assert.equal(localPass.status, 200)
    assert.deepEqual(await localPass.json(), { local: true })
    assert.equal(localHits.length, 1)
    assert.equal(dshHits.length, 3, 'the local pass never crossed the relay')
  } finally {
    handle.uninstall()
    await env.stop()
    await subStop()
    await dshStop()
  }
})

