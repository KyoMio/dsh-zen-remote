/* dsh-zen-remote · T23a relay end-to-end (relay client → real gateway child →
 * createRelayHandler test server)
 *
 * The 2.0.0 relay seam end to end: ONLY the DSH service is fake. The
 * sub-client runs the real src/relay-client.ts, the gateway is the real
 * lib/lan-gate-server.cjs child process (test/util.cjs spawns it with
 * LAN_GATE_RELAY_SECRET and LAN_GATE_TARGET_PORT pointed at this file's test
 * server), and the server side is the real createRelayHandler over a REAL
 * createShareStore — mounted on a plain node:http server with a
 * controllable fake `typertGateway` (the same gate seam relay-stream.test.cjs
 * drives directly). Pairing runs the real ceremony: POST /lan-gate/pair
 * {role:'desktop-client'} on the gateway's local admin surface, then
 * /lan-gate/pair/claim-desktop with X-Forwarded-* headers playing the public
 * internet. What this proves that no half-test can: the Bearer token, the
 * gateway's marking headers, the shared secret and the NDJSON stream all
 * survive the real child process.
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
const { createRelayClient, RelayError } = require('../lib/relay-client.js')
const { createClientHandler } = require('../lib/client-routes.js')
const { installIntercept } = require('../lib/intercept.js')
const { installFetchRouteIntercept, FILE_UPLOAD_PATH, SESSION_EXPORT_PATH } = require('../lib/fetch-route-intercept.js')
const { toVirtual } = require('../lib/virtual-id.js')
const { startGatewayAt, request, pairDesktop, stopAll } = require('./util.cjs')

// T31-fix: every port is system-assigned so parallel test-run copies cannot
// collide. The proxy and the relay-handler server listen(0) and read their
// bound port back; the gateway child needs a fixed port parameter, so boot()
// pre-grabs a free port (bind → read → release) and hands it over — the
// gateway's own same-port retry band absorbs the small rebind race, and a
// RESTART reuses the same number (freed by the previous child's SIGTERM).
// The proxy reads `gwPort` at request time, so it always routes to the
// current boot's child.
let gwPort = 0
const SECRET = '7e6a5b4c3d2e1f00'.repeat(4)
const SERVER_NAME = '端到端服务器'

/** One free loopback port: bound, read, released. */
async function freePort() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * The reverse proxy every real deployment puts in front of the gateway. In
 * production the desktop client is ANOTHER machine: its requests reach the
 * gateway through nginx/Caddy with X-Forwarded-*, and only that keeps the
 * gateway from judging them "the local user" (loopback + no forwarded
 * headers = local, which bypasses device auth entirely). Client and gateway
 * share this machine in the test, so this hop restores the real topology:
 * the relay client's serverUrl points HERE, and everything it sends —
 * Bearer token, NDJSON streams, mid-stream aborts — is piped to the gateway
 * as a public visitor's request.
 */
/** Total requests the proxy has piped to the gateway — the observable for
 * "the client is retrying on its own" and "the client stopped asking". */
let proxyHits = 0

function startProxy() {
  const server = http.createServer((req, res) => {
    proxyHits += 1
    const headers = { ...req.headers, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }
    delete headers.connection
    delete headers['keep-alive']
    let upstream
    // A client hang-up mid-stream must reach the gateway as a disconnect.
    res.on('close', () => { try { if (upstream !== undefined) upstream.destroy() } catch { /* gone */ } })
    upstream = http.request({ host: '127.0.0.1', port: gwPort, method: req.method, path: req.url, headers }, (upRes) => {
      const out = { ...upRes.headers }
      delete out['transfer-encoding']
      delete out.connection
      delete out['keep-alive']
      res.writeHead(upRes.statusCode || 502, out)
      // Mirror the real gateway's T23a-fix2 flushHeaders: without it the
      // proxied 200 would wait for the first body byte at this hop too.
      res.flushHeaders()
      upRes.pipe(res)
    })
    upstream.on('error', () => {
      try { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }) } catch { /* gone */ }
      try { res.end() } catch { /* gone */ }
    })
    req.pipe(upstream)
  })
  const stop = () => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, stop })))
}

let proxy
let proxyPort = 0
test.before(async () => {
  proxy = await startProxy()
  proxyPort = proxy.port
})
test.after(async () => { if (proxy) await proxy.stop() })

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-relay-e2e-'))
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

/** One controllable upstream stream: the test pushes frames, finishes it, or
 * observes the abort the relay route sends on hang-up/unshare. */
function makeGate(call) {
  const pending = []
  let wake = () => {}
  let settled = 'open' // 'open' | 'done' | { error }
  call.signal?.addEventListener('abort', () => {
    if (settled === 'open') {
      settled = { error: Object.assign(new Error('Remote invocation was aborted'), { code: 'gateway/cancelled' }) }
      wake()
    }
  })
  const iterable = (async function* () {
    while (true) {
      if (pending.length > 0) {
        const next = pending.shift()
        if (next.kind === 'frame') yield next.frame
        else if (next.kind === 'throw') throw next.error
        else return
      } else if (settled !== 'open') {
        if (settled === 'done') return
        throw settled.error
      } else {
        await new Promise((resolve) => { wake = resolve })
      }
    }
  })()
  return {
    call,
    iterable,
    push: (frame) => { pending.push({ kind: 'frame', frame }); wake() },
    finish: () => { pending.push({ kind: 'return' }); wake() },
    get aborted() { return call.signal?.aborted === true },
  }
}

/** The gateway's `$events` leg (T32): ready first, exactly like
 * openRemoteEvents yields it; abort becomes the documented cancelled throw. */
function makeEventsGate(signal) {
  const pending = []
  let wake = () => {}
  let settled = 'open'
  signal?.addEventListener('abort', () => {
    if (settled === 'open') {
      settled = { error: Object.assign(new Error('Remote invocation "$events" was aborted'), { code: 'gateway/cancelled' }) }
      wake()
    }
  })
  const iterable = (async function* () {
    yield { type: 'ready', clientId: 'srv-events-client', host: { home: '/srv/home' } }
    while (true) {
      if (pending.length > 0) {
        const next = pending.shift()
        if (next.kind === 'frame') yield next.frame
        else if (next.kind === 'throw') throw next.error
        else return
      } else if (settled !== 'open') {
        if (settled === 'done') return
        throw settled.error
      } else {
        await new Promise((resolve) => { wake = resolve })
      }
    }
  })()
  return {
    iterable,
    push: (frame) => { pending.push({ kind: 'frame', frame }); wake() },
    finish: () => { pending.push({ kind: 'return' }); wake() },
    get aborted() { return signal?.aborted === true },
  }
}

const FOLLOW_ARGS = { request: { address: { kind: 'session', sessionId: 'session-a' } } }

/**
 * One full stack: relay handler + fake gateway behind a real HTTP server,
 * the REAL gateway child pointed at it, one paired desktop device, and a
 * relay client speaking to the child. Every test gets its own home (device
 * state) and its own share table.
 */
let bootCounter = 0
async function boot(opts = {}) {
  const { shared = [], heartbeatMs, invoke, fingerprints, apiFetch } = opts
  const home = path.join(ROOT, `run-${bootCounter++}`)
  fs.mkdirSync(home, { recursive: true })
  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  for (const id of shared) store.share(id)
  const invokeCalls = []
  const streams = []
  const eventsGates = []
  const eventResults = []
  const gateway = {
    invoke: async (call) => {
      invokeCalls.push(call)
      // T52-fix3: the client fetches the model catalog proactively as soon as
      // it serves (install into an online relay, every online transition) —
      // the real server has answered this global read since T52, so the fake
      // does too: an empty catalog, no session data anywhere.
      if (call.namespace === 'session' && call.method === 'modelCatalog') {
        return { default: null, routableProviders: [], groups: [], failures: [] }
      }
      if (invoke !== undefined) return invoke(call)
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
    stream: async (call) => {
      const gate = makeGate(call)
      streams.push(gate)
      return gate.iterable
    },
    // T32: the two event surfaces — `$events` through the wire adapter, the
    // answers through the /api dispatch.
    wireStream: {
      open: async (endpoint, payload, uplink, peer, signal) => {
        if (endpoint !== '$events') {
          throw Object.assign(new Error(`no wireStream fake for ${endpoint}`), { code: 'test/not-implemented' })
        }
        const gate = makeEventsGate(signal)
        eventsGates.push(gate)
        return gate.iterable
      },
    },
    dispatchRpc: async (endpoint, payload, signal, peer) => {
      eventResults.push({ endpoint, payload, signal, peer })
      return { ok: true, value: undefined }
    },
  }
  const apiFetchCalls = []
  const handler = createRelayHandler({
    secret: SECRET,
    store,
    gateway,
    // T41b: the host's shared `/api` dispatcher, faked with a recording
    // double that answers a canned diff — the synthetic Request's URL is
    // asserted to the byte in the http e2e test below.
    ...(apiFetch !== undefined
      ? {
          getApiFetch: () => async (request) => {
            apiFetchCalls.push(request)
            return apiFetch(request)
          },
        }
      : {}),
    serverInfo: {
      serverId: loadServerId(home),
      serverName: () => SERVER_NAME,
      dshVersion: '0.0.0-e2e',
      ...(fingerprints !== undefined ? { fingerprints: () => fingerprints } : {}),
    },
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
  })
  const server = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } }) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const targetPort = server.address().port

  const env = { store, invokeCalls, streams, eventsGates, eventResults, apiFetchCalls, handler }
  // T43: every client this boot created is remembered so the teardown can
  // stop its reconnect ladder — an offline zombie client from test N would
  // otherwise keep firing retries into test N+1's gateway.
  const allClients = []
  const registerClient = (client) => { allClients.push(client); return client }
  // Pre-grab a free port for the child (bind → read → release), then start
  // it on that number.
  gwPort = await freePort()
  let gw = startGatewayAt(home, gwPort, targetPort, { LAN_GATE_RELAY_SECRET: SECRET })
  await gw.ready
  const paired = await pairDesktop(gwPort, '端到端台式机')
  const token = paired.token
  env.deviceId = paired.id
  // The client reaches the gateway THROUGH the proxy hop, like any desktop
  // client behind its server's reverse proxy.
  env.client = registerClient(createRelayClient({
    getServerUrl: () => `http://127.0.0.1:${proxyPort}`,
    getToken: () => token,
  }))
  // A second client with custom tuning against the SAME paired device.
  env.tunedClient = (overrides = {}) => registerClient(createRelayClient({
    getServerUrl: () => `http://127.0.0.1:${proxyPort}`,
    getToken: () => token,
    ...overrides,
  }))
  env.allClients = allClients
  env.killGateway = () => new Promise((resolve) => {
    const child = gw.child
    if (child.exitCode !== null) { resolve(); return }
    child.once('exit', resolve)
    child.kill('SIGTERM')
  })
  env.restartGateway = async () => {
    // The SAME port the first child drew: it was freed by the SIGTERM and
    // the gateway's same-port retry band absorbs the teardown tail race.
    gw = startGatewayAt(home, gwPort, targetPort, { LAN_GATE_RELAY_SECRET: SECRET })
    await gw.ready
  }
  env.stop = async () => {
    for (const client of allClients) client.stop()
    handler.closeAll('e2e teardown')
    await stopAll({ close: (done) => { server.closeAllConnections(); server.close(done) } }, gw.child)
  }
  return env
}

async function waitFor(predicate, ms = 3000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function collect(iterable) {
  const frames = []
  let error
  try {
    for await (const frame of iterable) frames.push(frame)
  } catch (e) {
    error = e
  }
  return { frames, error }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 1. handshake through the real chain -------------------------------------

test('e2e: connect() handshakes through the real gateway and lands online', async () => {
  const env = await boot({ shared: ['session-a'] })
  try {
    const states = []
    env.client.subscribe((s) => states.push(s))
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    assert.deepEqual(states, ['connecting', 'online'])
    assert.equal(info.relayProtocol, 1)
    assert.equal(info.serverName, SERVER_NAME)
    assert.match(info.serverId, /^[0-9a-f]{8}$/)
    assert.equal(info.dshVersion, '0.0.0-e2e')
    assert.deepEqual(info.fingerprints, {})
    assert.equal(env.client.handshakeInfo, info)
  } finally { await env.stop() }
})

// ---- 2. invoke: shared passes, unshared is refused before the fake gateway ----

test('e2e: a shared session invoke returns the fake gateway value, an unshared one is not-shared', async () => {
  const env = await boot({
    shared: ['session-a'],
    invoke: (call) => ({ page: 'ok', echoed: call.args.request.address.sessionId }),
  })
  try {
    await env.client.connect()
    const value = await env.client.invoke('session', 'page', FOLLOW_ARGS)
    assert.deepEqual(value, { page: 'ok', echoed: 'session-a' })
    assert.equal(env.invokeCalls.length, 1)

    await assert.rejects(
      () => env.client.invoke('session', 'page', { request: { address: { kind: 'session', sessionId: 'session-secret' } } }),
      (error) => error instanceof RelayError && error.code === 'not-shared' && error.status === 403,
    )
    assert.equal(env.invokeCalls.length, 1, 'the unshared call never reached the gateway service')
    assert.equal(env.client.state, 'online', 'a per-call refusal leaves the state alone')
  } finally { await env.stop() }
})

// ---- 3. stream: frames flow, an unshare kills the stream loudly ---------------

test('e2e: openStream delivers the pushed frames in order and ends cleanly', async () => {
  const env = await boot({ shared: ['session-a'] })
  try {
    await env.client.connect()
    const frames = [
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } },
      { type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: {} } },
      { type: 'event', event: { type: 'user/message', seq: 3, time: 3, data: {} } },
    ]
    const stream = env.client.openStream('session', 'follow', FOLLOW_ARGS)
    // The iterable is a generator: the FIRST pull is what fires the request.
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await waitFor(() => env.streams.length === 1)
    const gate = env.streams[0]
    assert.equal(gate.call.namespace, 'session')
    assert.equal(gate.call.method, 'follow')
    for (const frame of frames) gate.push(frame)
    gate.finish()
    const first = await pending
    const rest = []
    let streamError
    try {
      for await (const frame of iterator) rest.push(frame)
    } catch (error) { streamError = error }
    assert.equal(streamError, undefined)
    assert.deepEqual([first.value, ...rest], frames)
    assert.equal(env.client.state, 'online')
  } finally { await env.stop() }
})

test('e2e: unsharing mid-stream ends the stream with an unshared RelayError and aborts upstream', async () => {
  const env = await boot({ shared: ['session-a'] })
  try {
    await env.client.connect()
    const stream = env.client.openStream('session', 'follow', FOLLOW_ARGS)
    // First pull fires the (lazy) request.
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await waitFor(() => env.streams.length === 1)
    const gate = env.streams[0]
    gate.push({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    const first = await pending
    assert.deepEqual(first.value.event.type, 'turn/start')

    env.store.unshare('session-a', 'manual')
    let thrown
    try { await iterator.next() } catch (error) { thrown = error }
    assert.ok(thrown instanceof RelayError, `the stream throws, got: ${thrown}`)
    assert.equal(thrown.code, 'unshared')
    await waitFor(() => gate.aborted)
  } finally { await env.stop() }
})

// ---- 4. heartbeat: pings keep it alive, a too-impatient client dies -----------

test('e2e: server pings carry a silent stream past the idle timeout; a smaller idle clock does not', async () => {
  const env = await boot({ shared: ['session-a'], heartbeatMs: 300 })
  try {
    // (a) idle 400ms vs heartbeat 300ms, and requestTimeoutMs 80 — far
    // SMALLER than the heartbeat interval (T23a-fix2): the gateway now
    // flushHeaders'es the relay 200 the moment it arrives, so the header
    // phase ends in milliseconds while the stream itself lives on pings
    // alone. Remove the gateway's res.flushHeaders() and this test fails —
    // the 200 then waits for the first ping (300ms) and the 80ms header
    // clock judges the link offline first.
    const patient = env.tunedClient({ idleTimeoutMs: 400, requestTimeoutMs: 80 })
    await patient.connect()
    const stream = patient.openStream('session', 'follow', FOLLOW_ARGS)
    // First pull fires the (lazy) request.
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await waitFor(() => env.streams.length === 1)
    const gate = env.streams[0]
    // 700ms of total silence from the fake gateway — two heartbeats must
    // hold it together.
    await sleep(700)
    const verdict = await Promise.race([
      pending.then(() => 'ended', (error) => `errored:${error.code}`),
      sleep(50).then(() => 'open'),
    ])
    assert.equal(verdict, 'open', 'the stream survived the silent window on pings alone')
    gate.finish()
    const done = await pending
    assert.equal(done.done, true)
    assert.equal(patient.state, 'online')

    // (b) an idle clock SMALLER than the heartbeat interval: nothing can
    // refresh it in time, so it must go offline and abort upstream.
    const impatient = env.tunedClient({ idleTimeoutMs: 40 })
    await impatient.connect()
    const { error } = await collect(impatient.openStream('session', 'follow', FOLLOW_ARGS))
    assert.ok(error instanceof RelayError && error.code === 'offline', `expected offline, got: ${error}`)
    assert.equal(impatient.state, 'offline')
    await waitFor(() => env.streams[1] && env.streams[1].aborted)
  } finally { await env.stop() }
})

// ---- 5. caller abort reaches the fake gateway's signal -------------------------

test('e2e: an external abort ends the iteration normally and aborts the upstream subscription', async () => {
  const env = await boot({ shared: ['session-a'] })
  try {
    await env.client.connect()
    const controller = new AbortController()
    const stream = env.client.openStream('session', 'follow', FOLLOW_ARGS, controller.signal)
    // First pull fires the (lazy) request.
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await waitFor(() => env.streams.length === 1)
    const gate = env.streams[0]
    gate.push({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    const first = await pending
    assert.equal(first.value.event.type, 'turn/start')
    controller.abort()
    const second = await iterator.next()
    assert.equal(second.done, true, 'the abort ends the iteration without throwing')
    await waitFor(() => gate.aborted)
  } finally { await env.stop() }
})

// ---- 6. revocation -------------------------------------------------------------

test('e2e: revoking the device on the gateway turns the next invoke into revoked', async () => {
  const env = await boot({ shared: ['session-a'], invoke: () => ({ page: 'ok' }) })
  try {
    await env.client.connect()
    assert.equal(env.client.state, 'online')
    const action = await request(gwPort, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id: env.deviceId } })
    assert.equal(action.status, 200)
    await assert.rejects(
      () => env.client.invoke('session', 'page', FOLLOW_ARGS),
      (error) => error instanceof RelayError && error.code === 'revoked' && error.status === 401,
    )
    assert.equal(env.client.state, 'revoked')
    assert.equal(env.invokeCalls.length, 0, 'the revoked call never reached the relay server')
  } finally { await env.stop() }
})

// ---- 7. gateway death and rebirth ----------------------------------------------

test('e2e: a dead gateway reads offline, and the next success after restart reads online again', async () => {
  const env = await boot({ shared: ['session-a'], invoke: () => ({ page: 'ok', n: 1 }) })
  try {
    await env.client.connect()
    await env.client.invoke('session', 'page', FOLLOW_ARGS)
    assert.equal(env.client.state, 'online')

    await env.killGateway()
    await assert.rejects(() => env.client.invoke('session', 'page', FOLLOW_ARGS), (error) => error.code === 'offline')
    assert.equal(env.client.state, 'offline')

    // The device token lives in the home's state file, so the restarted
    // gateway accepts the SAME token — and the share table (server side)
    // never blinked.
    await env.restartGateway()
    const again = await env.client.invoke('session', 'page', FOLLOW_ARGS)
    assert.deepEqual(again, { page: 'ok', n: 1 })
    assert.equal(env.client.state, 'online', 'a successful call lifts offline back to online')
  } finally { await env.stop() }
})

// ---- 8. T43: the automatic reconnect ladder, end to end --------------------

test('e2e T43: the gateway dies, the client retries on its own, and a restarted gateway brings it back online within the backoff', async () => {
  const env = await boot({ shared: ['session-a'], invoke: () => ({ page: 'ok' }) })
  try {
    await env.client.connect()
    assert.equal(env.client.state, 'online')

    await env.killGateway()
    // The observed failure lands offline and arms the first wait (1s + up
    // to 20% jitter).
    await assert.rejects(() => env.client.invoke('session', 'page', FOLLOW_ARGS), (error) => error.code === 'offline')
    assert.equal(env.client.state, 'offline')
    assert.ok(env.client.nextRetryAt !== null, 'a retry is armed')
    assert.ok(env.client.nextRetryAt - Date.now() <= 1200, 'the first wait is the 1s step (+ jitter)')

    // Nobody calls the client: the RETRY must be what hits the dead chain.
    // The proxy counts a hit the moment the REQUEST arrives, but the 502 it
    // answers comes back asynchronously — a poll between the two would catch
    // `connecting`. Waiting for the hit AND the settled `offline` means the
    // observed attempt is complete (connect() switched to `connecting`
    // before sending, so offline after a new hit is this retry's end).
    const hitsBefore = proxyHits
    await waitFor(() => proxyHits > hitsBefore && env.client.state === 'offline', 5000)
    assert.equal(env.client.state, 'offline', 'the gateway is still down — the retry failed into offline again')
    assert.equal(env.client.lastError, 'offline')

    // The gateway returns on the SAME port with the SAME home (the device
    // token lives in its state file): the next automatic attempt succeeds.
    await env.restartGateway()
    await waitFor(() => env.client.state === 'online', 10000)
    assert.equal(env.client.nextRetryAt, null)
    assert.equal(env.client.lastError, undefined)
    // The link really works again — not just the state word.
    const value = await env.client.invoke('session', 'page', FOLLOW_ARGS)
    assert.deepEqual(value, { page: 'ok' })
  } finally { await env.stop() }
})

test('e2e T43: a device revoked while the client is in the retry loop lands revoked and the client goes silent', async () => {
  const env = await boot({ shared: ['session-a'], invoke: () => ({ page: 'ok' }) })
  try {
    await env.client.connect()
    // Revoke behind the client's back, then take the chain down: the client
    // walks its ladder against a dead proxy.
    const action = await request(gwPort, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id: env.deviceId } })
    assert.equal(action.status, 200)
    await env.killGateway()
    await assert.rejects(() => env.client.invoke('session', 'page', FOLLOW_ARGS), (error) => error.code === 'offline')
    assert.equal(env.client.state, 'offline')

    // The gateway returns; the retry reaches its pairing wall this time.
    await env.restartGateway()
    await waitFor(() => env.client.state === 'revoked', 10000)
    assert.equal(env.client.nextRetryAt, null, 'revoked cancels the ladder')

    // And the client NEVER asks again: no request leaves it, however long
    // the ladder would have waited.
    const quiet = proxyHits
    await sleep(2500)
    assert.equal(proxyHits, quiet, 'not one request after the revocation wall')
  } finally { await env.stop() }
})

// ---- 9. T23b-2: the sub-client interceptor merges the GLOBAL workspace stream ----

/**
 * The sub-client's own DSH process, faked at the same seam the intercept
 * wraps: async openWireStream (the 0.2.0 shape the mux awaits), the exact
 * dynamic call sites in the constructor, and a controllable local
 * workspace/follow stream so the merged stream stays open across the share.
 */
class LocalMergeGateway {
  constructor(localGate) {
    this.localGate = localGate
    this.streamCalls = []
    this.rpcCalls = []
    this.wireStream = {
      open: (endpoint, payload, uplink, peer, signal) => this.openWireStream(endpoint, payload, uplink, peer, signal, { signal }),
    }
    this.rpcBridge = (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)
    this.wireTap = (endpoint, payload, uplink, peer, signal, control) => this.openWireStream(endpoint, payload, uplink, peer, control.signal, control)
  }
  operatorPeer() { return { id: 'operator-peer' } }
  async dispatchRpc(endpoint, payload, signal, peer) {
    this.rpcCalls.push({ endpoint, payload })
    return { ok: true, value: { items: [{ sessionId: 'session-local', updatedAt: 1 }] } }
  }
  async openWireStream(endpoint, payload, uplink, peer, signal, control) {
    this.streamCalls.push({ endpoint, payload, uplink, peer, signal, control })
    if (endpoint === 'workspace/follow') return this.localGate.iterable
    return (async function* () { yield { type: 'baseline', value: { items: [] } } })()
  }
}

/** Controllable local stream leg honoring its signal like the relay client. */
function makeLocalGate(signal) {
  const pending = []
  let wake = () => {}
  let finished = false
  const iterable = (async function* () {
    const onAbort = () => { finished = true; wake() }
    if (signal?.aborted) return
    signal?.addEventListener('abort', onAbort)
    try {
      while (true) {
        if (pending.length > 0) {
          const next = pending.shift()
          if (next.kind === 'frame') yield next.frame
          else return
        } else if (finished) return
        else await new Promise((resolve) => { wake = resolve })
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  })()
  return {
    iterable,
    push: (frame) => { pending.push({ kind: 'frame', frame }); wake() },
    get aborted() { return signal?.aborted === true },
  }
}

/** Read exactly `count` merged frames, failing loudly on a stall. */
async function collectFrames(iterator, count, ms = 5000) {
  const frames = []
  for (let i = 0; i < count; i += 1) {
    let timer
    const result = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for merged frame ${frames.length + 1}/${count}`)), ms)
      }),
    ]).finally(() => clearTimeout(timer))
    if (result.done) throw new Error(`merged stream ended after ${frames.length} of ${count} frames`)
    frames.push(result.value)
  }
  return frames
}

test('e2e T23b-2: the interceptor merges the global workspace stream — local group, filtered remote groups, and a live share travels the whole chain', async () => {
  const env = await boot({ shared: ['session-a'] })
  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    const serverId = info.serverId
    const V = (id) => toVirtual(serverId, id)

    const LOCAL_WS = {
      workspaceId: 'ws-local',
      path: '/home/me/local',
      title: '本地',
      sessionIds: ['session-l1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const SERVER_W1 = {
      workspaceId: 'w-1',
      path: '/srv/one',
      title: '服务端一',
      sessionIds: ['session-a', 'session-b'],
      createdAt: '2026-02-02T00:00:00.000Z',
      updatedAt: '2026-02-02T00:00:00.000Z',
    }
    const SERVER_W2 = { ...SERVER_W1, workspaceId: 'w-2', path: '/srv/two', title: '服务端二', sessionIds: ['session-c'] }

    const controller = new AbortController()
    const localGate = makeLocalGate(controller.signal)
    const localGateway = new LocalMergeGateway(localGate)
    const handle = installIntercept({
      raw: localGateway,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
      log: () => {},
    })

    // The merged stream through the sub-client's own wire adapter.
    const merged = await localGateway.wireTap('workspace/follow', { args: {} }, undefined, localGateway.operatorPeer(), controller.signal, { signal: controller.signal })
    const iterator = merged[Symbol.asyncIterator]()

    // Local baseline first — untouched, no remote state known yet.
    localGate.push({ type: 'baseline', value: { items: [LOCAL_WS], archivedSessionIds: [], pinnedSessionIds: [] } })
    const first = await collectFrames(iterator, 1)
    assert.deepEqual(first[0].value.items.map((workspace) => workspace.workspaceId), ['ws-local'])

    // The relay's filtered workspace/follow is the second server-side stream.
    await waitFor(() => env.streams.some((gate) => gate.call.namespace === 'workspace' && gate.call.method === 'follow'))
    const wsGate = env.streams.find((gate) => gate.call.namespace === 'workspace')
    wsGate.push({ type: 'baseline', value: { items: [SERVER_W1, SERVER_W2], archivedSessionIds: [], pinnedSessionIds: [] } })
    const remote = await collectFrames(iterator, 4)
    // The server only shares session-a, so the remote groups show only what
    // is shared: w-1 carries ONE virtual session despite two server-side;
    // w-2's unshared session-c leaves it NOTHING shared, so the group is not
    // forwarded to the UI at all (T56 — no empty 「服务端名 · 工作区名」
    // heading); titles carry the server name; and the UI never sees a second
    // baseline.
    assert.deepEqual(remote[0].workspace, { ...SERVER_W1, workspaceId: V('w-1'), title: `${SERVER_NAME} · 服务端一`, sessionIds: [V('session-a')] })
    assert.deepEqual(remote[1], { type: 'order', workspaceIds: ['ws-local', V('w-1')] })
    assert.ok(remote.every((frame) => frame.type !== 'baseline' && frame.workspaceId !== V('w-2') && frame.workspace?.workspaceId !== V('w-2')))

    // Sharing a second session on the server synthesizes an upsert there; it
    // must cross the real gateway child + NDJSON relay + interceptor merger
    // and land as ONE virtualized upsert with BOTH sessions.
    env.store.share('session-b')
    const shared = await collectFrames(iterator, 1)
    assert.deepEqual(shared, [
      { type: 'upsert', workspace: { ...SERVER_W1, workspaceId: V('w-1'), title: `${SERVER_NAME} · 服务端一`, sessionIds: [V('session-a'), V('session-b')] } },
    ])

    // External abort: the merged iteration ends and the server-side stream
    // observes the hang-up chain (mux abort → relay → gateway).
    controller.abort()
    const done = await iterator.next()
    assert.equal(done.done, true)
    await waitFor(() => wsGate.aborted)
    handle.uninstall()
  } finally { await env.stop() }
})

// ---- T32: the forwarded approval/question events, end to end --------------------

/**
 * The sub-client's own DSH, faked at the seam the intercept wraps: async
 * openWireStream handing out ONE controllable local `$events` stream, and a
 * dispatchRpc that answers every call (and records it, so the test can prove
 * a remote answer never reached the local gateway).
 */
class LocalEventsGateway {
  constructor(localGate) {
    this.localGate = localGate
    this.rpcCalls = []
    this.wireStream = {
      open: (endpoint, payload, uplink, peer, signal) => this.openWireStream(endpoint, payload, uplink, peer, signal, { signal }),
    }
    this.rpcBridge = (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)
    this.wireTap = (endpoint, payload, uplink, peer, signal, control) => this.openWireStream(endpoint, payload, uplink, peer, control.signal, control)
  }
  operatorPeer() { return { id: 'operator-peer' } }
  async dispatchRpc(endpoint, payload, signal, peer) {
    this.rpcCalls.push({ endpoint, payload })
    return { ok: true, value: undefined }
  }
  async openWireStream(endpoint, payload, uplink, peer, signal, control) {
    if (endpoint === '$events') return this.localGate.iterable
    return (async function* () { yield { type: 'baseline', value: { items: [] } } })()
  }
}

test('e2e T32: a server approval crosses into the local $events virtualized, the answer crosses back, and first-answer-wins closes the loser', async () => {
  const env = await boot({ shared: ['session-a'] })
  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    const serverId = info.serverId
    const V = (id) => toVirtual(serverId, id)

    const controller = new AbortController()
    const localGate = makeLocalGate(controller.signal)
    const localGateway = new LocalEventsGateway(localGate)
    const handle = installIntercept({
      raw: localGateway,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
      log: () => {},
    })

    const merged = await localGateway.wireTap('$events', { args: {} }, undefined, localGateway.operatorPeer(), controller.signal, { signal: controller.signal })
    const iterator = merged[Symbol.asyncIterator]()

    // The LOCAL ready is the merged stream's first frame — what the client
    // face demands — and the server's own ready never crosses the relay.
    // The first pull is what starts the pumps: it hands the queued local
    // ready over AND opens the server's $zr/events subscription.
    localGate.push({ type: 'ready', clientId: 'local-ui-client', host: { home: '/local/home' } })
    const [ready] = await collectFrames(iterator, 1)
    assert.deepEqual(ready, { type: 'ready', clientId: 'local-ui-client', host: { home: '/local/home' } })
    await waitFor(() => env.eventsGates.length === 1)

    // The shared session's approval arrives virtualized — the eventId is
    // the server's opaque `<token>.<original>` wrapped in the virtual
    // prefix; the unshared session's never leaves the server.
    env.eventsGates[0].push({ type: 'waterfall', event: 'approval/request', eventId: 'evt-srv-1', agentId: 'session-a', request: { toolName: 'Bash', callId: 'c1', reason: 'run a command' } })
    env.eventsGates[0].push({ type: 'waterfall', event: 'approval/request', eventId: 'evt-srv-secret', agentId: 'session-secret', request: { toolName: 'Bash', callId: 'c2' } })
    const [waterfall] = await collectFrames(iterator, 1)
    const { eventId: seenEventId, ...waterfallRest } = waterfall
    assert.equal(seenEventId.startsWith(V('')), true)
    assert.equal(seenEventId.endsWith('.evt-srv-1'), true)
    assert.deepEqual(waterfallRest, {
      type: 'waterfall',
      event: 'approval/request',
      agentId: V('session-a'),
      request: { toolName: 'Bash', callId: 'c1', reason: 'run a command' },
    })

    // The UI answers through its own /api dispatch with the id it SAW. The
    // answer rides the REAL chain back: the server resolves the token to
    // THIS subscription, strips it off the eventId, and composes the
    // gateway payload with ITS clientId; the local DSH never sees it.
    const envelope = await localGateway.rpcBridge(
      '$events/result',
      { args: { clientId: 'local-ui-client', eventId: seenEventId, outcome: { kind: 'result', value: 'allowed-once' } } },
      undefined,
      undefined,
    )
    assert.deepEqual(envelope, { ok: true, value: undefined })
    // Exactly ONE answer reached the gateway: the real one. The dropped
    // unshared waterfall is NOT abstained on behalf anymore (T32-fix2) —
    // the relay's silence keeps that delivery pending at the gateway,
    // answerable by the server UI or a future subscriber.
    await waitFor(() => env.eventResults.length >= 1)
    assert.deepEqual(env.eventResults[0].payload, {
      args: { clientId: 'srv-events-client', eventId: 'evt-srv-1', outcome: { kind: 'result', value: 'allowed-once' } },
    })
    assert.equal(localGateway.rpcCalls.filter((call) => call.endpoint === '$events/result').length, 0)

    // An event that was never forwarded refuses server-side (403
    // unknown-event), and the interceptor answers the UI with the same
    // silent ok DSH gives a stale result — a thrown answer would fail the
    // UI's whole $events generation.
    const ghost = await localGateway.rpcBridge(
      '$events/result',
      { args: { clientId: 'local-ui-client', eventId: V('token-guess.evt-ghost'), outcome: { kind: 'next' } } },
      undefined,
      undefined,
    )
    assert.deepEqual(ghost, { ok: true, value: undefined })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(env.eventResults.length, 1, 'the ghost answer never reached the server gateway')

    // First answer wins: the server's own UI answers a second waterfall
    // first, the gateway settles and pushes the cancel frame, the
    // sub-client's prompt closes — and its LATE answer is refused
    // server-side (the registry entry went with the forwarded cancel) but
    // still reads as silent ok at the UI.
    env.eventsGates[0].push({ type: 'waterfall', event: 'user-questions/request', eventId: 'evt-srv-2', agentId: 'session-a', request: { questions: [{ id: 'q1', prompt: '继续吗？' }] } })
    const question = (await collectFrames(iterator, 1))[0]
    assert.equal(question.eventId.endsWith('.evt-srv-2'), true)
    env.eventsGates[0].push({ type: 'cancel', eventId: 'evt-srv-2' })
    const [cancel] = await collectFrames(iterator, 1)
    assert.equal(cancel.eventId.endsWith('.evt-srv-2'), true)
    const late = await localGateway.rpcBridge(
      '$events/result',
      { args: { clientId: 'local-ui-client', eventId: question.eventId, outcome: { kind: 'result', value: { answers: { q1: '好的' } } } } },
      undefined,
      undefined,
    )
    assert.deepEqual(late, { ok: true, value: undefined })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(env.eventResults.length, 1, 'the late answer was refused before the gateway')

    // A dying remote leg closes every prompt still on screen: evt-srv-1
    // was answered but its real cancel never came (the fake gateway does
    // not settle), evt-orphan is still pending — both get the synthesized
    // cancel when the server's $events ends. evt-srv-2 does NOT: its real
    // cancel already cleared it from the record.
    env.eventsGates[0].push({ type: 'waterfall', event: 'approval/request', eventId: 'evt-orphan', agentId: 'session-a', request: { toolName: 'Bash', callId: 'c9' } })
    const orphan = (await collectFrames(iterator, 1))[0]
    assert.equal(orphan.eventId.endsWith('.evt-orphan'), true)
    env.eventsGates[0].finish()
    const closes = await collectFrames(iterator, 2)
    assert.deepEqual(
      closes.map((frame) => frame.eventId),
      [seenEventId, orphan.eventId],
    )
    for (const frame of closes) assert.deepEqual(Object.keys(frame).sort(), ['eventId', 'type'])

    handle.uninstall()
    controller.abort()
  } finally { await env.stop() }
})

// ---- T42: interface fingerprints over the real chain ---------------------------

test('e2e: injected fingerprints ride the real handshake and compare group by group', async () => {
  const SERVER_FP = { session: 'aaa111', workspace: 'bbb222' }
  const env = await boot({ shared: [], fingerprints: SERVER_FP })
  try {
    // Different workspace hash: the differing group is named; `events` only
    // the CLIENT computed, so it lands unavailable — never a difference.
    const different = env.tunedClient({
      computeOwnFingerprints: () => ({ session: 'aaa111', workspace: 'zzz999', events: 'ccc333' }),
    })
    const info = await different.connect()
    assert.deepEqual(info.fingerprints, SERVER_FP, 'the server\'s map survived the real gateway chain')
    assert.deepEqual(different.compat, { identical: ['session'], different: ['workspace'], unavailable: ['events'] })
    await different.stop()

    // The identical map: nothing differs.
    const same = env.tunedClient({ computeOwnFingerprints: () => ({ ...SERVER_FP }) })
    await same.connect()
    assert.deepEqual(same.compat, { identical: ['session', 'workspace'], different: [], unavailable: [] })
    await same.stop()
  } finally { await env.stop() }
})

// ---- T41a: the terminal panel end to end through the sub-client interceptor ----

/**
 * The sub-client's own DSH process, faked at the same seam as
 * LocalMergeGateway above: async openWireStream, the exact dynamic call sites
 * in the constructor. Local answers are irrelevant here — every call in the
 * test carries a virtual id and must travel.
 */
class LocalTerminalGateway {
  constructor() {
    this.streamCalls = []
    this.rpcCalls = []
    this.wireStream = {
      open: (endpoint, payload, uplink, peer, signal) => this.openWireStream(endpoint, payload, uplink, peer, signal, { signal }),
    }
    this.rpcBridge = (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)
    this.wireTap = (endpoint, payload, uplink, peer, signal, control) => this.openWireStream(endpoint, payload, uplink, peer, control.signal, control)
  }
  operatorPeer() { return { id: 'operator-peer' } }
  async dispatchRpc(endpoint, payload, signal, peer) {
    this.rpcCalls.push({ endpoint, payload })
    return { ok: true, value: { endpoint } }
  }
  async openWireStream(endpoint, payload, uplink, peer, signal, control) {
    this.streamCalls.push({ endpoint, payload })
    return (async function* () { yield { type: 'baseline', value: { items: [] } } })()
  }
}

test('e2e T41a: terminal/create + terminal/follow work through the sub-client, and closing remote ends follow with unshared', async () => {
  const env = await boot({
    shared: ['session-a'],
    invoke: (call) => {
      if (call.namespace === 'terminal' && call.method === 'create') {
        return {
          id: call.args.request.id,
          title: 'zsh',
          shell: { path: '/bin/zsh', args: [], name: 'zsh' },
          cwd: '/srv',
          cols: call.args.request.cols,
          rows: call.args.request.rows,
          state: 'running',
          exitCode: null,
        }
      }
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
  })
  try {
    const info = await env.client.connect()
    const V = (id) => toVirtual(info.serverId, id)
    const localGateway = new LocalTerminalGateway()
    const handle = installIntercept({
      raw: localGateway,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
      log: () => {},
    })

    // The PTY is created SERVER-side: the virtual agentId is restored on the
    // way out, and the server-minted terminal info (terminal id, no session
    // id) rides back untouched.
    const created = await localGateway.rpcBridge('terminal/create', { args: { agentId: V('session-a'), request: { id: 'term-e2e', cols: 80, rows: 24 } } }, undefined, undefined)
    assert.equal(created.ok, true)
    assert.deepEqual(created.value, { id: 'term-e2e', title: 'zsh', shell: { path: '/bin/zsh', args: [], name: 'zsh' }, cwd: '/srv', cols: 80, rows: 24, state: 'running', exitCode: null })
    // Two invokes reached the fake gateway: the T52-fix3 install-time
    // modelCatalog fetch (the relay was already online when the intercept
    // installed) and the terminal create itself.
    assert.equal(env.invokeCalls.length, 2)
    assert.deepEqual(env.invokeCalls[1].args, { agentId: 'session-a', request: { id: 'term-e2e', cols: 80, rows: 24 } }, 'the ORIGINAL session id reached the server')

    // follow rides the stream route; the fake gateway echoes an output frame.
    const stream = await localGateway.wireTap('terminal/follow', { args: { agentId: V('session-a'), id: 'term-e2e', attachmentId: 'att-e2e' } }, undefined, undefined, undefined, { signal: undefined })
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await waitFor(() => env.streams.some((gate) => gate.call.namespace === 'terminal' && gate.call.method === 'follow'))
    const gate = env.streams.find((item) => item.call.namespace === 'terminal')
    assert.deepEqual(gate.call.args, { agentId: 'session-a', id: 'term-e2e', attachmentId: 'att-e2e' })
    gate.push({ type: 'snapshot', sequence: 0, screen: '$ ', info: { id: 'term-e2e', title: 'zsh', cols: 80, rows: 24, state: 'running', exitCode: null } })
    const first = await pending
    assert.equal(first.value.type, 'snapshot')

    // Closing the session's remote access kills the follow with the SAME
    // unshared end frame every session-scoped stream gets — through the real
    // gateway child, NDJSON wire and interceptor.
    env.store.unshare('session-a', 'manual')
    let thrown
    try { await iterator.next() } catch (error) { thrown = error }
    assert.ok(thrown instanceof Error && thrown.code === 'unshared', `expected unshared, got: ${thrown}`)
    assert.equal(thrown.isDSHRemoteError, true, 'the code survives the host wire because the error is marked')
    await waitFor(() => gate.aborted)
    handle.uninstall()
  } finally { await env.stop() }
})

// ---- T34: the closed-session registry over the real chain --------------------------

test('e2e T34: the server idle-closes a session and the sub-client remote-status.closed carries the virtual id + reason; the unshare route closes through the chain', async () => {
  const env = await boot({ shared: ['session-a'] })
  let statusServer
  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    const virtual = toVirtual(info.serverId, 'session-a')

    const controller = new AbortController()
    const localGateway = new LocalMergeGateway(makeLocalGate(controller.signal))
    const handle = installIntercept({
      raw: localGateway,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
      log: () => {},
    })

    // The session page is OPEN (its follow stream runs through the real
    // gateway child + NDJSON relay) when the server closes the remote.
    const stream = localGateway.wireTap(
      'session/follow',
      { args: { request: { address: { kind: 'session', sessionId: virtual } } } },
      undefined,
      localGateway.operatorPeer(),
      controller.signal,
      { signal: controller.signal },
    )
    const collected = collect(stream)
    await waitFor(() => env.streams.some((gate) => gate.call.namespace === 'session' && gate.call.method === 'follow'))

    // The idle sweeper closes the session on the server.
    env.store.unshare('session-a', 'idle')
    const { error } = await collected
    assert.ok(error instanceof Error, 'the open page saw the closure')
    assert.equal(error.code, 'unshared')
    // The structured reason landed in the interceptor's registry.
    assert.deepEqual(handle.diagnostics().closedSessions, [{ sessionId: virtual, reason: 'idle' }])

    // The client route serves it: closed carries the VIRTUAL id + reason, and
    // the body carries no token and no server address.
    const handler = createClientHandler({
      admit: () => ({}),
      getRowConfig: () => ({}),
      getRelayClient: () => env.client,
      getIntercept: () => handle.diagnostics(),
    })
    statusServer = http.createServer((req, res) => { void handler(req, res) })
    await new Promise((resolve) => statusServer.listen(0, '127.0.0.1', resolve))
    const statusPort = statusServer.address().port
    const status = await fetch(`http://127.0.0.1:${statusPort}/_dsh/zen-remote/client/remote-status`)
    const body = await status.json()
    assert.equal(body.state, 'online')
    assert.equal(body.serverName, SERVER_NAME)
    assert.deepEqual(body.closed, { [virtual]: 'idle' })
    assert.ok(!JSON.stringify(body).includes(env.client.lastHandshakeDigest ?? ''), 'no credential material')

    // The unshare route closes through the WHOLE chain: local route → relay
    // client → proxy → gateway child → relay route → share table.
    env.store.share('session-a')
    assert.equal(env.store.isShared('session-a'), true)
    const close = await fetch(`http://127.0.0.1:${statusPort}/_dsh/zen-remote/client/unshare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${statusPort}` },
      body: JSON.stringify({ sessionId: virtual }),
    })
    assert.equal(close.status, 200)
    assert.deepEqual(await close.json(), { ok: true })
    await waitFor(() => !env.store.isShared('session-a'))

    // A non-virtual id is refused before anything travels.
    env.store.share('session-a')
    const bad = await fetch(`http://127.0.0.1:${statusPort}/_dsh/zen-remote/client/unshare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${statusPort}` },
      body: JSON.stringify({ sessionId: 'session-a' }),
    })
    assert.equal(bad.status, 400)
    assert.equal(env.store.isShared('session-a'), true, 'the local id never reached the relay')

    controller.abort()
    handle.uninstall()
  } finally {
    if (statusServer !== undefined) {
      statusServer.closeAllConnections()
      await new Promise((resolve) => statusServer.close(resolve))
    }
    await env.stop()
  }
})

test('e2e T41b: the changes diff crosses the sub-client http route with the original id, and an unshare answers 403', async () => {
  const DIFF = { kind: 'text', path: 'src/a.ts', display: 'a.ts', before: false, after: false, coarse: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+hello'] }] }
  const env = await boot({
    shared: ['session-a'],
    apiFetch: () => new Response(JSON.stringify(DIFF), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
  })
  try {
    const info = await env.client.connect()
    // The sub-client backend route over the SAME relay client the browser
    // half rides: the fetch wrapper's rewrite target, driven with a plain
    // socket like the real webServer registration does.
    const clientHandler = createClientHandler({
      admit: () => ({ peer: {} }),
      getRowConfig: () => ({ serverUrl: `http://127.0.0.1:${proxyPort}/`, deviceToken: 'e2e-token', role: 'client' }),
      getRelayClient: () => env.client,
    })
    const clientServer = http.createServer((req, res) => { void clientHandler(req, res) })
    await new Promise((resolve) => clientServer.listen(0, '127.0.0.1', resolve))
    try {
      const virtual = toVirtual(info.serverId, 'session-a')
      const url = `/_dsh/zen-remote/client/http/changes.diff?sessionId=${encodeURIComponent(virtual)}&seq=3&index=0`
      const res = await fetch(`http://127.0.0.1:${clientServer.address().port}${url}`)
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), DIFF)
      await waitFor(() => env.apiFetchCalls.length === 1)
      // The synthetic Request carries the ORIGINAL session id and the rest
      // of the query verbatim — the whole point of the rewrite.
      assert.equal(
        env.apiFetchCalls[0].url,
        'http://relay.local/api/changes.diff?sessionId=session-a&seq=3&index=0',
      )
      assert.equal(env.apiFetchCalls[0].method, 'GET')

      // Closing the session's remote access closes its plain-HTTP reads too:
      // the relay answers 403 not-shared and the sub-client route relays it.
      env.store.unshare('session-a', 'manual')
      const denied = await fetch(`http://127.0.0.1:${clientServer.address().port}${url}`)
      assert.equal(denied.status, 403)
      assert.deepEqual(await denied.json(), { ok: false, error: { code: 'not-shared' } })
      assert.equal(env.apiFetchCalls.length, 1, 'the unshared read was never dispatched')
    } finally {
      await new Promise((resolve) => { clientServer.closeAllConnections(); clientServer.close(resolve) })
    }
  } finally { await env.stop() }
})

// ---- T51: the binary upload channel end to end ------------------------------------

test('e2e T51: an upload through the wrapped local route crosses the whole chain with the original id and the same bytes; export refuses locally', async () => {
  // The fake shared handler records the synthetic Request and reads its body
  // stream to the end — the byte-exact observable of the whole chain. The
  // read happens HERE (once): the pushed Request's body is consumed by this
  // callback, so the assertions below use the recorded bytes.
  const seenUploads = []
  const env = await boot({
    shared: ['session-a'],
    apiFetch: async (request) => {
      const chunks = []
      if (request.body !== null) {
        for await (const chunk of request.body) chunks.push(Buffer.from(chunk))
      }
      const bytes = Buffer.concat(chunks)
      seenUploads.push({ url: request.url, method: request.method, bytes })
      const receipt = { ok: true, value: { receiptId: 'r-e2e', file: { attachmentId: 'att-e2e', name: 'note.txt', bytes: bytes.length } } }
      return new Response(JSON.stringify(receipt), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
    },
  })
  let handle
  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    // The fake connection service: exactly the surface the wrap installs
    // over. The local upload route is a canary — a virtual id must NEVER
    // reach it.
    const routes = new Map()
    routes.set(FILE_UPLOAD_PATH, {
      methods: new Set(['POST']),
      requestBody: 'streaming',
      fetch: async () => {
        throw new Error('the local upload route ran for a virtual id')
      },
    })
    routes.set(SESSION_EXPORT_PATH, {
      methods: new Set(['GET', 'HEAD']),
      requestBody: 'buffered',
      fetch: async () => new Response('local-export'),
    })
    const connection = { fetchRoutes: routes }
    handle = installFetchRouteIntercept({
      connection,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
    })
    assert.equal(handle.diagnostics().uploadWrapped, true)
    assert.equal(handle.diagnostics().exportWrapped, true)

    const virtual = toVirtual(info.serverId, 'session-a')
    const bytes = Buffer.from('e2e-uploaded-bytes')
    const query = new URLSearchParams({ sessionId: virtual, name: 'note.txt' })
    const request = new Request(`http://dsh.internal/api/session/uploadFileBinary?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
      duplex: 'half',
    })
    const response = await routes.get(FILE_UPLOAD_PATH).fetch(request)
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(await response.text()), {
      ok: true,
      value: { receiptId: 'r-e2e', file: { attachmentId: 'att-e2e', name: 'note.txt', bytes: bytes.length } },
    })
    await waitFor(() => env.apiFetchCalls.length === 1)
    // The synthetic Request carries the ORIGINAL session id and the exact
    // bytes — through the real gateway child, binary wire, relay route and
    // shared handler.
    assert.equal(seenUploads[0].method, 'POST')
    assert.equal(
      seenUploads[0].url,
      'http://relay.local/api/session/uploadFileBinary?sessionId=session-a&name=note.txt',
    )
    assert.ok(seenUploads[0].bytes.equals(bytes), 'the exact bytes crossed the chain')
    assert.equal(handle.diagnostics().uploadForwarded, 1)

    // A local id on the same wrapped entry reaches the local route (which
    // would answer its own business failure for an unknown id — here the
    // canary throws, so observe the passthrough by the refusal counter).
    const localRequest = new Request(`http://dsh.internal/api/session/uploadFileBinary?sessionId=${encodeURIComponent('session-local')}&name=x.bin`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('x'),
      duplex: 'half',
    })
    await assert.rejects(() => routes.get(FILE_UPLOAD_PATH).fetch(localRequest), /local upload route/, 'the local id reached the local route')
    assert.equal(handle.diagnostics().uploadCalls, 2)
    assert.equal(env.apiFetchCalls.length, 1, 'the local upload never traveled')

    // The export refusal stays LOCAL: the server's /api dispatch is never
    // consulted.
    const exportResponse = await routes.get(SESSION_EXPORT_PATH).fetch(
      new Request(`http://dsh.internal/api/session.export?sessionId=${encodeURIComponent(virtual)}&includeDescendants=true`, { method: 'HEAD' }),
    )
    assert.equal(exportResponse.status, 403)
    assert.deepEqual(await exportResponse.json(), { ok: false, error: { code: 'remote-unsupported', message: '远程会话不支持导出', details: {} } })
    assert.equal(env.apiFetchCalls.length, 1, 'the export never reached the server')
    assert.equal(handle.diagnostics().exportBlocked, 1)

    handle.uninstall()
    assert.equal(handle.diagnostics().installed, false)
  } finally {
    if (handle !== undefined) handle.uninstall()
    await env.stop()
  }
})
