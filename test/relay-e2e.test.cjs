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
const { startGatewayAt, request, pairDesktop, stopAll } = require('./util.cjs')

// Far from every other file's fixture ports (the 392xx band).
const GW_PORT = 39301
const TARGET_PORT = 39302
const PROXY_PORT = 39303
const SECRET = '7e6a5b4c3d2e1f00'.repeat(4)
const SERVER_NAME = '端到端服务器'

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
    upstream = http.request({ host: '127.0.0.1', port: GW_PORT, method: req.method, path: req.url, headers }, (upRes) => {
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
  return new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', () => resolve({ server, stop })))
}

let proxy
test.before(async () => { proxy = await startProxy() })
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

const FOLLOW_ARGS = { request: { address: { kind: 'session', sessionId: 'session-a' } } }

/**
 * One full stack: relay handler + fake gateway behind a real HTTP server,
 * the REAL gateway child pointed at it, one paired desktop device, and a
 * relay client speaking to the child. Every test gets its own home (device
 * state) and its own share table.
 */
let bootCounter = 0
async function boot(opts = {}) {
  const { shared = [], heartbeatMs, invoke } = opts
  const home = path.join(ROOT, `run-${bootCounter++}`)
  fs.mkdirSync(home, { recursive: true })
  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  for (const id of shared) store.share(id)
  const invokeCalls = []
  const streams = []
  const gateway = {
    invoke: async (call) => {
      invokeCalls.push(call)
      if (invoke !== undefined) return invoke(call)
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
    stream: async (call) => {
      const gate = makeGate(call)
      streams.push(gate)
      return gate.iterable
    },
  }
  const handler = createRelayHandler({
    secret: SECRET,
    store,
    gateway,
    serverInfo: { serverId: loadServerId(home), serverName: () => SERVER_NAME, dshVersion: '0.0.0-e2e' },
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
  })
  const server = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } }) })
  await new Promise((resolve) => server.listen(TARGET_PORT, '127.0.0.1', resolve))

  const env = { store, invokeCalls, streams, handler }
  // T43: every client this boot created is remembered so the teardown can
  // stop its reconnect ladder — an offline zombie client from test N would
  // otherwise keep firing retries into test N+1's gateway.
  const allClients = []
  const registerClient = (client) => { allClients.push(client); return client }
  let gw = startGatewayAt(home, GW_PORT, TARGET_PORT, { LAN_GATE_RELAY_SECRET: SECRET })
  await gw.ready
  const paired = await pairDesktop(GW_PORT, '端到端台式机')
  const token = paired.token
  env.deviceId = paired.id
  // The client reaches the gateway THROUGH the proxy hop, like any desktop
  // client behind its server's reverse proxy.
  env.client = registerClient(createRelayClient({
    getServerUrl: () => `http://127.0.0.1:${PROXY_PORT}`,
    getToken: () => token,
  }))
  // A second client with custom tuning against the SAME paired device.
  env.tunedClient = (overrides = {}) => registerClient(createRelayClient({
    getServerUrl: () => `http://127.0.0.1:${PROXY_PORT}`,
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
    gw = startGatewayAt(home, GW_PORT, TARGET_PORT, { LAN_GATE_RELAY_SECRET: SECRET })
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
    const action = await request(GW_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id: env.deviceId } })
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
    const hitsBefore = proxyHits
    await waitFor(() => proxyHits > hitsBefore, 5000)
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
    const action = await request(GW_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id: env.deviceId } })
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
