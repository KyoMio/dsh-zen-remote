/* dsh-zen-remote · T23a relay client, pure logic (src/relay-client.ts)
 *
 * The client half of the relay protocol against a LOCAL fake relay server —
 * no gateway child, no share table, just the HTTP shapes the real chain
 * produces. Two things are pinned here: the NDJSON line parser's edge cases
 * (a line split across chunks, several lines in one chunk, a damaged line
 * skipped, a ping never yielded, a final line without its newline) and the
 * full result→state mapping (unpaired/revoked/incompatible/offline, the
 * per-call refusals that must NOT move the state, and the offline→online
 * recovery on the next success). Stream lifecycle — caller abort, break,
 * the idle clock and its heartbeat interplay — runs against raw chunked
 * writers so every timing is observable.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createRelayClient, relayCredentialsDigest, RelayError } = require('../lib/relay-client.js')

const HANDSHAKE = '/_dsh/zen-remote/relay/v1/handshake'
const INVOKE = '/_dsh/zen-remote/relay/v1/invoke'
const STREAM = '/_dsh/zen-remote/relay/v1/stream'
const UNSHARE = '/_dsh/zen-remote/relay/v1/unshare'
const UPLOAD = '/_dsh/zen-remote/relay/v1/upload'
const DEVICE_NAME = '/_dsh/zen-remote/relay/v1/device/name'

const HANDSHAKE_OK = () => [200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '假服务器', dshVersion: '9.9.9-test', fingerprints: { algo: 'sha256' } }]

function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.length) })
  res.end(bytes)
}

/**
 * One fake relay server: scenario functions per route, every request
 * recorded (headers, parsed body, and whether the client hung up before the
 * response ended — `closed.beforeEnd`). The stream route hands the RAW
 * req/res to the scenario so tests write exact chunk boundaries.
 */
function startFakeRelay() {
  const seen = []
  const scenario = {
    handshake: HANDSHAKE_OK,
    invoke: () => [200, { ok: true, value: { answer: 42 } }],
    stream: undefined,
    unshare: () => [200, { ok: true }],
    upload: () => [200, { ok: true, value: { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ ok: true, value: { receiptId: 'r-1', file: { attachmentId: 'att-1', name: 'note.txt', bytes: 5 } } }) } }],
    deviceName: (req, res, body) => [200, { ok: true, name: body && typeof body.name === 'string' ? body.name : '' }],
  }
  const server = http.createServer((req, res) => {
    // T51-fix: the uploadStart hook fires when the HEADERS arrive — the only
    // place a mid-SEND connection reset can be staged (the end-gated
    // dispatch below runs after the body, where a destroy never rejects the
    // pending fetch; only the round-trip budget would, minutes later).
    if (String(req.url).split('?')[0] === UPLOAD && scenario.uploadStart !== undefined) scenario.uploadStart(req)
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const rawBody = Buffer.concat(chunks)
      let body
      try { body = raw === '' ? {} : JSON.parse(raw) } catch { body = undefined }
      const closed = { beforeEnd: false }
      res.on('close', () => { closed.beforeEnd = !res.writableEnded })
      seen.push({ method: req.method, url: String(req.url).split('?')[0], query: new URL(req.url || '/', 'http://x').search, headers: req.headers, body, rawBody, req, res, closed })
      const route = String(req.url).split('?')[0]
      if (route === HANDSHAKE) {
        // A scenario either RETURNS [status, body] to be answered for it, or
        // answers the response itself (a stall that must outlive timers).
        const answered = scenario.handshake(req, res)
        if (answered !== undefined) sendJson(res, answered[0], answered[1])
        return
      }
      if (route === UPLOAD) {
        // T51: the binary channel — the body is raw bytes, never JSON. Same
        // scenario contract as the JSON routes.
        const answered = scenario.upload(req, res)
        if (answered !== undefined) sendJson(res, answered[0], answered[1])
        return
      }
      if (route === INVOKE) {
        // A scenario either RETURNS [status, body] to be answered for it, or
        // answers the response itself (the timeout/abort scenarios stall).
        const answered = scenario.invoke(req, res)
        if (answered !== undefined) sendJson(res, answered[0], answered[1])
        return
      }
      if (route === STREAM) {
        if (scenario.stream) { scenario.stream(req, res, body); return }
        sendJson(res, 403, { ok: false, error: { code: 'forbidden-method' } })
        return
      }
      if (route === DEVICE_NAME) {
        // T59: the gateway's device-name endpoint — a scenario contract like
        // the JSON routes above.
        const answered = scenario.deviceName(req, res, body)
        if (answered !== undefined) sendJson(res, answered[0], answered[1])
        return
      }
      if (route === UNSHARE) {
        const answered = scenario.unshare(req, res)
        if (answered !== undefined) sendJson(res, answered[0], answered[1])
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'not-found' } })
    })
  })
  const stop = () => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen, scenario, stop })))
}

/** A loopback port that was listening a moment ago and is closed now:
 * deterministic connection refusal, no real network. */
async function deadPort() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function makeClient(port, overrides = {}) {
  let url = `http://127.0.0.1:${port}`
  let token = 'token' in overrides ? overrides.token : 'tok-1'
  const client = createRelayClient({
    getServerUrl: () => url,
    getToken: () => token,
    ...(overrides.idleTimeoutMs !== undefined ? { idleTimeoutMs: overrides.idleTimeoutMs } : {}),
    ...(overrides.requestTimeoutMs !== undefined ? { requestTimeoutMs: overrides.requestTimeoutMs } : {}),
    // T59: handshake-counting tests would see the periodic info refresh as
    // extra handshakes — off unless a test opts in.
    infoRefreshMs: overrides.infoRefreshMs ?? 0,
    ...(overrides.clock !== undefined ? { clock: overrides.clock } : {}),
    ...(overrides.computeOwnFingerprints !== undefined ? { computeOwnFingerprints: overrides.computeOwnFingerprints } : {}),
  })
  return { client, setUrl: (v) => { url = v }, setToken: (v) => { token = v } }
}

async function waitFor(predicate, ms = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Collect a whole stream, capturing the thrown error if any. */
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

// ---- credentials ------------------------------------------------------------

test('unpaired: no token, no address — every entry point throws without touching the network', async () => {
  const relay = await startFakeRelay()
  try {
    for (const overrides of [{ token: '' }, { token: undefined }]) {
      const { client } = makeClient(relay.port, overrides)
      await assert.rejects(() => client.connect(), (error) => error instanceof RelayError && error.code === 'unpaired')
      await assert.rejects(() => client.invoke('session', 'page', {}), (error) => error.code === 'unpaired')
      assert.throws(() => client.openStream('session', 'follow', {}), (error) => error.code === 'unpaired')
      assert.equal(client.state, 'unpaired')
      assert.equal(client.handshakeInfo, undefined)
    }
    // An address that is present but blank counts as missing too.
    const blank = makeClient(relay.port)
    blank.setUrl('   ')
    await assert.rejects(() => blank.client.invoke('session', 'page', {}), (error) => error.code === 'unpaired')
    assert.equal(relay.seen.length, 0, 'not one request left the client')
  } finally { await relay.stop() }
})

// ---- handshake --------------------------------------------------------------

test('handshake: success stores the info and walks unpaired → connecting → online', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    const states = []
    client.subscribe((s) => states.push(s))
    const info = await client.connect()
    assert.equal(client.state, 'online')
    assert.deepEqual(states, ['connecting', 'online'])
    assert.deepEqual(info, { relayProtocol: 1, serverId: 'abcd1234', serverName: '假服务器', dshVersion: '9.9.9-test', fingerprints: { algo: 'sha256' } })
    assert.equal(client.handshakeInfo, info)
    const hit = relay.seen[0]
    assert.equal(hit.url, HANDSHAKE)
    assert.deepEqual(hit.body, {})
    assert.equal(hit.headers.authorization, 'Bearer tok-1')
    assert.equal(hit.headers.accept, 'application/json')
  } finally { await relay.stop() }
})

test('handshake: a foreign relayProtocol is incompatible and the state says so', async () => {
  const relay = await startFakeRelay()
  relay.scenario.handshake = () => [200, { ok: true, relayProtocol: 2, serverId: 'x', serverName: 'n', dshVersion: 'v', fingerprints: {} }]
  try {
    const { client } = makeClient(relay.port)
    await assert.rejects(() => client.connect(), (error) => error instanceof RelayError && error.code === 'incompatible')
    assert.equal(client.state, 'incompatible')
    assert.equal(client.handshakeInfo, undefined)
  } finally { await relay.stop() }
})

// ---- T23a-fix ----------------------------------------------------------------

test('T23a-fix: the request timeout only bounds the headers — a pinged stream outlives it', async () => {
  const relay = await startFakeRelay()
  relay.scenario.stream = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.flushHeaders()
    let pings = 0
    const timer = setInterval(() => {
      pings += 1
      if (pings > 10) {
        // 10 × 30ms = 300ms+ of pings — far past the 80ms request timeout.
        clearInterval(timer)
        res.end('{"type":"frame","frame":{"n":9}}')
        return
      }
      try { res.write('{"type":"ping"}\n') } catch { clearInterval(timer) }
    }, 30)
    res.on('close', () => clearInterval(timer))
  }
  try {
    const { client } = makeClient(relay.port, { requestTimeoutMs: 80 })
    await client.connect()
    const { frames, error } = await collect(client.openStream('session', 'follow', {}))
    assert.equal(error, undefined, `a healthy stream must outlive requestTimeoutMs: ${error}`)
    assert.deepEqual(frames, [{ n: 9 }])
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('T23a-fix: connect failures that change no state restore the entry state instead of sticking on connecting', async () => {
  const relay = await startFakeRelay()
  try {
    // A FIRST attempt reverts to 'offline' — the attempt HAD credentials, so
    // 'unpaired' (reserved for "none configured") would be a lie (T23a-fix2).
    relay.scenario.handshake = () => [401, { ok: false, error: { code: 'relay-unauthorized' } }]
    const first = makeClient(relay.port)
    await assert.rejects(() => first.client.connect(), (error) => error.code === 'relay-unauthorized')
    assert.equal(first.client.state, 'offline', 'a failed first attempt with credentials is offline, not unpaired')

    // ...the same for a status-less 404...
    relay.scenario.handshake = () => [404, { ok: false }]
    const second = makeClient(relay.port)
    await assert.rejects(() => second.client.connect(), (error) => error.code === 'http-404')
    assert.equal(second.client.state, 'offline', 'a 404 handshake strands the client on neither connecting nor unpaired')

    // ...and a LATER attempt from online keeps 'online'.
    relay.scenario.handshake = HANDSHAKE_OK
    const third = makeClient(relay.port)
    await third.client.connect()
    assert.equal(third.client.state, 'online')
    relay.scenario.handshake = () => [401, { ok: false, error: { code: 'relay-unauthorized' } }]
    await assert.rejects(() => third.client.connect(), (error) => error.code === 'relay-unauthorized')
    assert.equal(third.client.state, 'online', 'the online verdict survives an unmapped handshake failure')
  } finally { await relay.stop() }
})

test('T23a-fix2: 4xx headers with a never-ending body fail within the request timeout instead of hanging', async () => {
  const relay = await startFakeRelay()
  relay.scenario.stream = (req, res) => {
    // The refusal headers go out, the body never does: with the header clock
    // disarmed too early this would hang the stream forever.
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.flushHeaders()
  }
  try {
    const { client } = makeClient(relay.port, { requestTimeoutMs: 80 })
    await client.connect()
    const settled = await Promise.race([
      collect(client.openStream('workspace', 'follow', {})).then(
        ({ frames, error }) => ({ frames, error }),
        (error) => ({ frames: [], error }),
      ),
      sleep(1000).then(() => null),
    ])
    assert.notEqual(settled, null, 'the stream must not hang on a bodyless refusal')
    assert.ok(settled.error instanceof RelayError && settled.error.code === 'offline', `expected offline, got: ${settled.error}`)
    assert.equal(client.state, 'offline')
  } finally { await relay.stop() }
})

test('T23a-fix2: a second connect() while one is in flight joins it — the server sees one handshake', async () => {
  const relay = await startFakeRelay()
  try {
    let hits = 0
    relay.scenario.handshake = (req, res) => {
      hits += 1
      setTimeout(() => sendJson(res, 200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '并发', dshVersion: 'v', fingerprints: {} }), 200)
    }
    const { client } = makeClient(relay.port)
    const [a, b] = await Promise.all([client.connect(), client.connect()])
    assert.equal(a, b, 'both callers received the very same handshake verdict')
    assert.equal(hits, 1, 'one attempt, one wire handshake')
    assert.equal(client.state, 'online')
    // Once settled, a later connect is a genuinely fresh attempt.
    await client.connect()
    assert.equal(hits, 2)
  } finally { await relay.stop() }
})

test('T23a-fix: a 502 with an empty body is offline — the reverse proxy says the gateway is down', async () => {
  const relay = await startFakeRelay()
  relay.scenario.invoke = (req, res) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end()
  }
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    await assert.rejects(() => client.invoke('session', 'page', {}), (error) => {
      return error instanceof RelayError && error.code === 'offline' && error.status === 502
    })
    assert.equal(client.state, 'offline')
  } finally { await relay.stop() }
})

test('T23a-fix: the recorded digest tracks exactly the credentials the handshake used', async () => {
  const relay = await startFakeRelay()
  try {
    const { client, setToken } = makeClient(relay.port)
    assert.equal(client.lastHandshakeDigest, undefined, 'no handshake, no digest')
    await client.connect()
    assert.equal(client.lastHandshakeDigest, relayCredentialsDigest(`http://127.0.0.1:${relay.port}`, 'tok-1'))
    setToken('tok-2')
    await client.connect()
    assert.equal(client.lastHandshakeDigest, relayCredentialsDigest(`http://127.0.0.1:${relay.port}`, 'tok-2'), 'a re-pair re-digests')
  } finally { await relay.stop() }
})

// ---- invoke + the state map ---------------------------------------------------

test('invoke: the value rides out, the request carries bearer + json + the verbatim body', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    const value = await client.invoke('session', 'page', { request: { address: { kind: 'session', sessionId: 'session-a' } } })
    assert.deepEqual(value, { answer: 42 })
    const hit = relay.seen.find((r) => r.url === INVOKE)
    assert.equal(hit.method, 'POST')
    assert.equal(hit.headers.authorization, 'Bearer tok-1')
    assert.equal(hit.headers['content-type'], 'application/json')
    assert.equal(hit.headers.accept, 'application/json')
    assert.deepEqual(hit.body, { namespace: 'session', method: 'page', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
  } finally { await relay.stop() }
})

test('invoke: a transport failure lands offline and the next success lifts it back', async () => {
  const relay = await startFakeRelay()
  try {
    const { client, setUrl } = makeClient(relay.port)
    await client.connect()
    setUrl(`http://127.0.0.1:${await deadPort()}`)
    await assert.rejects(() => client.invoke('session', 'page', {}), (error) => error.code === 'offline')
    assert.equal(client.state, 'offline')

    // Back on the live server the next success lifts the state again.
    setUrl(`http://127.0.0.1:${relay.port}`)
    await client.invoke('session', 'page', {})
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('invoke: a timeout fails the CALL but leaves the connection state alone (T31-fix)', async () => {
  // A slow call is not a dead link: a big inline-image prompt may need
  // minutes on the wire. The timeout error says so, the state stays online,
  // and the reconnect ladder stays disarmed (no retry was scheduled).
  const relay = await startFakeRelay()
  relay.scenario.invoke = (req, res) => {
    setTimeout(() => { if (!res.destroyed) sendJson(res, 200, { ok: true, value: 'late' }) }, 500)
  }
  try {
    const { client } = makeClient(relay.port, { requestTimeoutMs: 80 })
    await client.connect()
    assert.equal(client.state, 'online')
    await assert.rejects(() => client.invoke('session', 'page', {}), (error) => error.code === 'request-timeout')
    assert.equal(client.state, 'online', 'an invoke timeout never judges the link')
    assert.equal(client.nextRetryAt, null, 'no reconnect was armed for a slow call')
    assert.equal(client.lastError, 'request-timeout')
  } finally { await relay.stop() }
})

test('invoke: the round-trip budget scales with the body size (T31-fix)', async () => {
  // Base budget 30 ms; the body carries 2 MiB, buying +4 s. A server that
  // answers in 120 ms — four times the base budget, far inside the scaled
  // one — must succeed. It would have timed out under a flat budget.
  const relay = await startFakeRelay()
  relay.scenario.invoke = (req, res) => {
    setTimeout(() => { if (!res.destroyed) sendJson(res, 200, { ok: true, value: 'slow but in budget' }) }, 120)
  }
  try {
    const { client } = makeClient(relay.port, { requestTimeoutMs: 30 })
    await client.connect()
    const bigArgs = { request: { sessionId: 'session-a', content: [{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(2 * 1024 * 1024) }] } }
    const value = await client.invoke('session', 'prompt', bigArgs)
    assert.equal(value, 'slow but in budget')
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('invoke: a 413 payload-too-large answers its body code without a state change', async () => {
  const relay = await startFakeRelay()
  relay.scenario.invoke = () => [413, { ok: false, error: { code: 'payload-too-large', details: {} } }]
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    await assert.rejects(
      () => client.invoke('session', 'prompt', { request: { sessionId: 's', content: [] } }),
      (error) => error instanceof RelayError && error.code === 'payload-too-large' && error.status === 413,
    )
    assert.equal(client.state, 'online', 'an oversize refusal is an answer about the call, not the link')
  } finally { await relay.stop() }
})

test('invoke: the gateway unpaired wall is revoked, the relay-unauthorized 401 is not', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    await client.connect()

    relay.scenario.invoke = () => [401, { ok: false, reason: 'unpaired' }]
    await assert.rejects(() => client.invoke('session', 'page', {}), (error) => {
      return error instanceof RelayError && error.code === 'revoked' && error.status === 401
    })
    assert.equal(client.state, 'revoked')

    // The server's internal secret mismatch is a SERVER problem: the error
    // is specific and the state (already revoked here) is not unpaired away.
    relay.scenario.invoke = () => [401, { ok: false, error: { code: 'relay-unauthorized' } }]
    await assert.rejects(() => client.invoke('session', 'page', {}), (error) => {
      return error instanceof RelayError && error.code === 'relay-unauthorized' && error.status === 401
    })
    assert.equal(client.state, 'revoked', 'relay-unauthorized never maps to a state change')
  } finally { await relay.stop() }
})

test('invoke: relay-unauthorized leaves a healthy online state alone', async () => {
  const relay = await startFakeRelay()
  relay.scenario.invoke = () => [401, { ok: false, error: { code: 'relay-unauthorized' } }]
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    assert.equal(client.state, 'online')
    await assert.rejects(() => client.invoke('session', 'page', {}), (error) => error.code === 'relay-unauthorized')
    assert.equal(client.state, 'online', 'a server-side secret mismatch does not unpair the client')
  } finally { await relay.stop() }
})

test('invoke: the relay-only wall is incompatible, per-call refusals leave the state', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    await client.connect()

    relay.scenario.invoke = () => [403, { ok: false, reason: 'relay-only' }]
    await assert.rejects(() => client.invoke('session', 'page', {}), (error) => error.code === 'incompatible')
    assert.equal(client.state, 'incompatible')

    // From incompatible, a per-call refusal still must not move the state.
    relay.scenario.invoke = () => [403, { ok: false, error: { code: 'not-shared' } }]
    await assert.rejects(() => client.invoke('session', 'page', {}), (error) => {
      return error instanceof RelayError && error.code === 'not-shared' && error.status === 403
    })
    assert.equal(client.state, 'incompatible')
  } finally { await relay.stop() }
})

test('invoke: a 200 ok:false envelope carries the DSH code + message and no state change', async () => {
  const relay = await startFakeRelay()
  relay.scenario.invoke = () => [200, { ok: false, error: { code: 'session/unknown-session', message: 'no such session' } }]
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    await assert.rejects(() => client.invoke('session', 'page', {}), (error) => {
      return error instanceof RelayError
        && error.code === 'session/unknown-session'
        && error.message === 'no such session'
    })
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('invoke: unmapped statuses answer their body code (429 too-many-streams) without a state change', async () => {
  const relay = await startFakeRelay()
  relay.scenario.invoke = () => [429, { ok: false, error: { code: 'too-many-streams' } }]
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    await assert.rejects(() => client.invoke('session', 'page', {}), (error) => error.code === 'too-many-streams')
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('invoke: a caller abort is an aborted error, not offline', async () => {
  const relay = await startFakeRelay()
  relay.scenario.invoke = (req, res) => {
    setTimeout(() => { if (!res.destroyed) sendJson(res, 200, { ok: true, value: 'late' }) }, 500)
  }
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    const controller = new AbortController()
    const pending = client.invoke('session', 'page', {}, controller.signal)
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(() => pending, (error) => error.code === 'aborted')
    await waitFor(() => relay.seen[relay.seen.length - 1].closed.beforeEnd)
  } finally { await relay.stop() }
})

// ---- T51: the binary upload channel ---------------------------------------------

const RECEIPT_ENVELOPE = { ok: true, value: { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ ok: true, value: { receiptId: 'r-1', file: { attachmentId: 'att-1', name: 'note.txt', bytes: 5 } } }) } }

function byteStreamOf(buffer, chunkSize = 3) {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= buffer.length) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(buffer.subarray(offset, offset + chunkSize)))
      offset += chunkSize
    },
  })
}

test('upload: the byte stream rides out, the query carries the original id + name, and the upstream answer comes back', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    const bytes = Buffer.from('hello')
    const result = await client.upload({ sessionId: 'session-a', name: 'note.txt', body: byteStreamOf(bytes), bytes: 5 })
    assert.equal(result.status, 200)
    assert.equal(result.contentType, 'application/json; charset=utf-8')
    assert.deepEqual(JSON.parse(result.body), { ok: true, value: { receiptId: 'r-1', file: { attachmentId: 'att-1', name: 'note.txt', bytes: 5 } } })
    const hits = relay.seen.filter((r) => r.url === UPLOAD)
    assert.equal(hits.length, 1)
    const hit = hits[0]
    assert.equal(hit.method, 'POST')
    assert.equal(hit.query, '?sessionId=session-a&name=note.txt')
    assert.equal(hit.headers['content-type'], 'application/octet-stream')
    assert.equal(hit.headers['content-length'], undefined, 'the body goes chunked — a hand-set length breaks DSH undici')
    assert.ok(hit.rawBody.equals(bytes), 'the exact bytes arrived, in order')
    assert.equal(hit.headers.authorization, 'Bearer tok-1')
  } finally { await relay.stop() }
})

test('upload: refusals keep their code and status, and an unknown-size body gets no content-length anyway', async () => {
  const relay = await startFakeRelay()
  relay.scenario.upload = () => [403, { ok: false, error: { code: 'not-shared' } }]
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    await assert.rejects(
      () => client.upload({ sessionId: 'session-secret', body: byteStreamOf(Buffer.from('x')) }),
      (error) => error instanceof RelayError && error.code === 'not-shared' && error.status === 403,
    )
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('upload: 413 payload-too-large answers its body code without a state change', async () => {
  const relay = await startFakeRelay()
  relay.scenario.upload = () => [413, { ok: false, error: { code: 'payload-too-large', details: {} } }]
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    await assert.rejects(
      () => client.upload({ sessionId: 'session-a', body: byteStreamOf(Buffer.from('x')) }),
      (error) => error instanceof RelayError && error.code === 'payload-too-large' && error.status === 413,
    )
    assert.equal(client.state, 'online', 'an oversize refusal is an answer about the call, not the link')
  } finally { await relay.stop() }
})

test('upload: a timeout fails the CALL and leaves the connection state alone (the T31-fix rule)', async () => {
  const relay = await startFakeRelay()
  relay.scenario.upload = () => undefined // stalls forever
  try {
    const { client } = makeClient(relay.port, { requestTimeoutMs: 80 })
    await client.connect()
    assert.equal(client.state, 'online')
    // A DECLARED size of 0 keeps the base budget (80 ms); an UNDECLARED one
    // would get the five-minute cap — exactly why the bytes hint exists.
    await assert.rejects(
      () => client.upload({ sessionId: 'session-a', body: byteStreamOf(Buffer.from('x')), bytes: 0 }),
      (error) => error.code === 'request-timeout',
    )
    assert.equal(client.state, 'online', 'an upload timeout never judges the link')
    assert.equal(client.nextRetryAt, null, 'no reconnect was armed for a slow upload')
    assert.equal(client.lastError, 'request-timeout')
  } finally { await relay.stop() }
})

test('upload: the budget scales with the declared size (the T31-fix rule)', async () => {
  // Base budget 30 ms; a declared 2 MiB buys +4 s. A server that answers in
  // 120 ms — four times the base budget, far inside the scaled one — must
  // succeed; it would have timed out under a flat budget.
  const relay = await startFakeRelay()
  relay.scenario.upload = (req, res) => {
    setTimeout(() => { if (!res.destroyed) sendJson(res, 200, RECEIPT_ENVELOPE) }, 120)
  }
  try {
    const { client } = makeClient(relay.port, { requestTimeoutMs: 30 })
    await client.connect()
    const result = await client.upload({ sessionId: 'session-a', body: byteStreamOf(Buffer.from('x')), bytes: 2 * 1024 * 1024 })
    assert.equal(result.status, 200)
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('upload: a null body rides as an empty stream', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    const result = await client.upload({ sessionId: 'session-a', body: null })
    assert.equal(result.status, 200)
    const hit = relay.seen.find((r) => r.url === UPLOAD)
    assert.equal(hit.rawBody.length, 0)
  } finally { await relay.stop() }
})

test('upload (T51-fix): a mid-flight transport death fails the CALL and leaves the connection state online', async () => {
  // A connection reset WHILE THE BODY IS STILL PUMPING is the server's size
  // gate and drain doing their job, not a dead link: the call rejects with
  // the transport code within moments, the diagnostics record it, the state
  // stays online and no reconnect is armed (the next invoke judges the
  // link). The body drips slowly so the reset lands mid-send — a reset
  // after the body finished would only be caught by the round-trip budget.
  const relay = await startFakeRelay()
  relay.scenario.uploadStart = (req) => {
    let first = true
    req.on('data', () => {
      if (first) {
        first = false
        setTimeout(() => { req.destroy() }, 20)
      }
    })
  }
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    assert.equal(client.state, 'online')
    // A bounded drip: the reset should land mid-send (~20-30 ms); if it
    // somehow missed, the stream CLOSES after 40 chunks (the server then
    // answers its receipt and the reject assertion fails loudly) instead of
    // holding the runner's event loop open forever.
    let sent = 0
    const drip = new ReadableStream({
      async pull(controller) {
        if (sent >= 40) {
          controller.close()
          return
        }
        sent += 1
        controller.enqueue(new Uint8Array(8192).fill(1))
        await new Promise((resolve) => setTimeout(resolve, 10))
      },
    })
    await assert.rejects(
      () => client.upload({ sessionId: 'session-a', body: drip, bytes: 256 * 1024 }),
      (error) => error instanceof RelayError && error.code === 'offline',
    )
    assert.equal(client.state, 'online', 'an upload reset never judges the link')
    assert.equal(client.nextRetryAt, null, 'no reconnect was armed for a cut upload')
    assert.equal(client.lastError, 'offline', 'the failure code is still recorded for the diagnostics')
  } finally { await relay.stop() }
})

test('invoke: a transport failure still judges the link offline (the T51-fix upload opt-out does not leak)', async () => {
  // The guard against my own refactor: only the UPLOAD route opts out of
  // transport failures setting the state — invoke keeps the T43 contract
  // (a dead link arms the reconnect ladder).
  const port = await deadPort()
  const { client } = makeClient(port)
  await assert.rejects(() => client.connect(), (error) => error.code === 'offline')
  assert.equal(client.state, 'offline')
  await assert.rejects(() => client.invoke('session', 'page', {}), (error) => error.code === 'offline')
  assert.equal(client.state, 'offline', 'invoke keeps judging the link')
  assert.ok(client.nextRetryAt !== null, 'the ladder armed')
  client.stop()
})

// ---- subscribe ----------------------------------------------------------------

test('subscribe: a throwing listener never blocks the others; unsubscribe detaches', async () => {
  const relay = await startFakeRelay()
  try {
    const { client, setUrl } = makeClient(relay.port)
    const seen = []
    const removeBroken = client.subscribe(() => { throw new Error('listener bug') })
    client.subscribe((s) => seen.push(s))
    await client.connect()
    assert.deepEqual(seen, ['connecting', 'online'])
    removeBroken()
    client.subscribe(() => seen.push('still-here'))
    const unsubscribe = client.subscribe(() => seen.push('gone'))
    unsubscribe()
    setUrl(`http://127.0.0.1:${await deadPort()}`)
    await assert.rejects(() => client.invoke('session', 'page', {}), (error) => error.code === 'offline')
    assert.deepEqual(seen, ['connecting', 'online', 'offline', 'still-here'])
  } finally { await relay.stop() }
})

// ---- openStream: the NDJSON parser --------------------------------------------

test('stream: split lines, multi-line chunks, damaged lines, pings and a bare tail all parse', async () => {
  const relay = await startFakeRelay()
  relay.scenario.stream = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write('{"type":"fra')
    setTimeout(() => {
      // One chunk finishes line 1 AND carries line 2 whole.
      res.write('me","frame":{"n":1}}\n{"type":"frame","frame":{"n":2}}\n')
      res.write('{"type":"frame","frame":{"n":bro')
      setTimeout(() => {
        res.write('ken}}\n') // completes into unparsable JSON — skipped
        res.write('{"type":"frame","frame":{"n":3}}\n{"type":"ping"}\n')
        setTimeout(() => {
          res.end('{"type":"frame","frame":{"n":4}}') // no trailing newline
        }, 20)
      }, 20)
    }, 20)
  }
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    const { frames, error } = await collect(client.openStream('session', 'follow', { request: { address: { kind: 'session', sessionId: 's' } } }))
    assert.equal(error, undefined)
    assert.deepEqual(frames, [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }])
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('stream: an error line throws its code and message as a RelayError', async () => {
  const relay = await startFakeRelay()
  relay.scenario.stream = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write('{"type":"frame","frame":{"n":1}}\n')
    res.end('{"type":"error","error":{"code":"unshared","message":"shared session s was unshared (manual)"}}\n')
  }
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    const { frames, error } = await collect(client.openStream('session', 'follow', {}))
    assert.deepEqual(frames, [{ n: 1 }])
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'unshared')
    assert.equal(error.message, 'shared session s was unshared (manual)')
  } finally { await relay.stop() }
})

test('stream: a refusal (403 not-shared shape) throws at the first pull and keeps the state', async () => {
  const relay = await startFakeRelay()
  relay.scenario.stream = undefined // the default answers 403 forbidden-method
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    const { frames, error } = await collect(client.openStream('workspace', 'follow', {}))
    assert.deepEqual(frames, [])
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'forbidden-method')
    assert.equal(error.status, 403)
    assert.equal(client.state, 'online', 'a per-call refusal does not move the state')
  } finally { await relay.stop() }
})

// ---- openStream: lifecycle ------------------------------------------------------

test('stream: silence beyond the idle timeout aborts the request and reports offline', async () => {
  const relay = await startFakeRelay()
  relay.scenario.stream = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.flushHeaders()
    // Nothing ever arrives; the client must give up on its own.
  }
  try {
    const { client } = makeClient(relay.port, { idleTimeoutMs: 80 })
    await client.connect()
    const started = Date.now()
    const { frames, error } = await collect(client.openStream('session', 'follow', {}))
    assert.deepEqual(frames, [])
    assert.ok(error instanceof RelayError && error.code === 'offline')
    assert.equal(client.state, 'offline')
    assert.ok(Date.now() - started < 1000, 'the idle clock fired promptly')
    await waitFor(() => relay.seen[relay.seen.length - 1].closed.beforeEnd)
  } finally { await relay.stop() }
})

test('stream: pings keep an otherwise silent stream alive past the idle timeout', async () => {
  const relay = await startFakeRelay()
  relay.scenario.stream = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.flushHeaders()
    let pings = 0
    const timer = setInterval(() => {
      pings += 1
      if (pings > 12) {
        clearInterval(timer)
        res.end('{"type":"frame","frame":{"n":9}}')
        return
      }
      try { res.write('{"type":"ping"}\n') } catch { clearInterval(timer) }
    }, 30)
    // Cleanup hangs off the RESPONSE close: req 'close' already fires when
    // the request body has been consumed, which would kill the pings right
    // after the open instead of when the client leaves.
    res.on('close', () => clearInterval(timer))
  }
  try {
    const { client } = makeClient(relay.port, { idleTimeoutMs: 120 })
    await client.connect()
    const { frames, error } = await collect(client.openStream('session', 'follow', {}))
    assert.equal(error, undefined, `pings must refresh the idle clock: ${error}`)
    assert.deepEqual(frames, [{ n: 9 }])
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('stream: a caller abort ends the iteration normally and closes the request', async () => {
  const relay = await startFakeRelay()
  relay.scenario.stream = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write('{"type":"frame","frame":{"n":1}}\n')
    const timer = setInterval(() => { try { res.write('{"type":"ping"}\n') } catch { clearInterval(timer) } }, 30)
    res.on('close', () => { clearInterval(timer); try { res.destroy() } catch { /* gone */ } })
  }
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    const controller = new AbortController()
    const iterator = client.openStream('session', 'follow', {}, controller.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    assert.deepEqual(first.value, { n: 1 })
    controller.abort()
    const second = await iterator.next()
    assert.equal(second.done, true, 'the abort ends the iteration without throwing')
    await waitFor(() => relay.seen[relay.seen.length - 1].closed.beforeEnd)
  } finally { await relay.stop() }
})

test('stream: breaking out of for-await aborts the underlying request', async () => {
  const relay = await startFakeRelay()
  relay.scenario.stream = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write('{"type":"frame","frame":{"n":1}}\n')
    const timer = setInterval(() => { try { res.write('{"type":"ping"}\n') } catch { clearInterval(timer) } }, 30)
    res.on('close', () => { clearInterval(timer); try { res.destroy() } catch { /* gone */ } })
  }
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    const taken = []
    for await (const frame of client.openStream('session', 'follow', {})) {
      taken.push(frame)
      break
    }
    assert.deepEqual(taken, [{ n: 1 }])
    await waitFor(() => relay.seen[relay.seen.length - 1].closed.beforeEnd)
  } finally { await relay.stop() }
})

// ---- dispatcher-managed headers -------------------------------------------------
//
// DSH's process replaces the global fetch dispatcher with its own undici,
// and that undici REJECTS a request carrying a hand-set content-length
// (fetch failed / UND_ERR_INVALID_ARG). The client therefore ships only
// endpoint headers — the body length is the dispatcher's business.

test('request headers stay dispatcher-safe: no content-length or connection-managed headers on any route', async () => {
  const captured = []
  const ndjson = [
    '{"type":"frame","frame":{"n":1}}',
    '{"type":"end"}',
    '',
  ].join('\n')
  const fetchImpl = async (url, init) => {
    captured.push({ url: String(url), init })
    const pathName = new URL(String(url)).pathname
    const body = pathName.endsWith('/v1/handshake')
      ? JSON.stringify({ ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: 'n', dshVersion: 'v', fingerprints: {} })
      : pathName.endsWith('/v1/stream')
        ? ndjson
        : JSON.stringify({ ok: true, value: null })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': pathName.endsWith('/v1/stream') ? 'application/x-ndjson' : 'application/json' },
    })
  }
  const client = createRelayClient({
    getServerUrl: () => 'http://127.0.0.1:1',
    getToken: () => 'tok-d',
    fetchImpl,
  })
  await client.connect()
  await client.invoke('session', 'page', { request: { sessionId: 's' } })
  for await (const frame of client.openStream('session', 'follow', {})) assert.equal(frame.n, 1)
  assert.equal(captured.length, 3)
  for (const { init } of captured) {
    const headers = init.headers
    assert.equal(headers['content-length'], undefined, 'a manual content-length breaks DSH undici (UND_ERR_INVALID_ARG)')
    assert.equal(headers.host, undefined)
    assert.equal(headers.connection, undefined)
    assert.equal(headers['transfer-encoding'], undefined)
    assert.equal(headers.authorization, 'Bearer tok-d')
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers.accept, 'application/json')
  }
  assert.deepEqual(captured.map((c) => new URL(c.url).pathname), [
    '/_dsh/zen-remote/relay/v1/handshake',
    '/_dsh/zen-remote/relay/v1/invoke',
    '/_dsh/zen-remote/relay/v1/stream',
  ])
})

// ---- T43: the automatic reconnect ladder ---------------------------------------
//
// The whole ladder runs on an INJECTED clock: no real waiting, every wait is
// asserted as the exact nextRetryAt timestamp the machinery arms. The
// handshake scenario answers 502 (the reverse-proxy-down shape) to keep the
// client offline; HANDSHAKE_OK flips it back.

/** A manual clock for the ladder: `advance` moves time and fires due timers
 * synchronously; `random` is pinned so the jitter math is exact. */
function fakeClock() {
  let now = 1_700_000_000_000
  let rng = 0
  const timers = []
  return {
    now: () => now,
    random: () => rng,
    setRandom: (v) => { rng = v },
    setTimeout(fn, ms) {
      const timer = { fn, at: now + ms }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    },
    advance(ms) {
      now += ms
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)
      for (const timer of due) {
        const index = timers.indexOf(timer)
        if (index >= 0) {
          timers.splice(index, 1)
          timer.fn()
        }
      }
    },
    get pending() { return timers.length },
  }
}

const OFFLINE_502 = () => [502, { ok: false }]
const handshakeHits = (relay) => relay.seen.filter((r) => r.url === HANDSHAKE).length

test('T43: the ladder walks 1/2/5/10/30/30s and resets to 1s after a success', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  relay.scenario.handshake = OFFLINE_502
  const { client } = makeClient(relay.port, { clock })
  try {
    // The FIRST failure arms the first step.
    await assert.rejects(() => client.connect(), (error) => error.code === 'offline')
    assert.equal(client.state, 'offline')
    assert.equal(client.nextRetryAt, clock.now() + 1000)
    assert.equal(clock.pending, 1)

    const steps = [1000, 2000, 5000, 10000, 30000, 30000]
    for (const [index, step] of steps.entries()) {
      clock.advance(step)
      // The fired attempt runs a real round-trip; wait for its failure to
      // have armed the next wait.
      await waitFor(() => clock.pending === 1 && client.state === 'offline', 3000)
      const next = steps[index + 1]
      if (next !== undefined) {
        assert.equal(client.nextRetryAt, clock.now() + next, `step ${index + 1} waits ${next} ms`)
      } else {
        assert.equal(client.nextRetryAt, clock.now() + 30000, 'the ladder stays at 30s forever')
      }
    }
    assert.equal(handshakeHits(relay), steps.length + 1, 'one initial connect plus one attempt per step')

    // The server comes back: the NEXT due attempt succeeds and clears the
    // machinery.
    relay.scenario.handshake = HANDSHAKE_OK
    clock.advance(client.nextRetryAt - clock.now())
    await waitFor(() => client.state === 'online', 3000)
    assert.equal(client.nextRetryAt, null)
    assert.equal(client.lastError, undefined)
    assert.equal(clock.pending, 0)

    // A failure after a success starts over at the FIRST step.
    relay.scenario.handshake = OFFLINE_502
    await assert.rejects(() => client.connect(), (error) => error.code === 'offline')
    assert.equal(client.nextRetryAt, clock.now() + 1000, 'the ladder reset — the first wait is 1s again')
  } finally { await relay.stop() }
})

test('T43: the jitter adds 0–20% to each wait', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  relay.scenario.handshake = OFFLINE_502
  const { client } = makeClient(relay.port, { clock })
  try {
    clock.setRandom(1) // the boundary: exactly +20%
    await assert.rejects(() => client.connect())
    assert.equal(client.nextRetryAt, clock.now() + 1200, '1000 ms + 20%')

    clock.setRandom(0.5) // +10%
    clock.advance(1200)
    await waitFor(() => clock.pending === 1 && client.state === 'offline', 3000)
    assert.equal(client.nextRetryAt, clock.now() + 2200, '2000 ms + 10%')
  } finally { await relay.stop() }
})

test('T43-fix: revoked cancels an ARMED ladder — the wall lands mid-retry, the timer dies', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  // First the client is merely offline WITH a retry armed...
  relay.scenario.handshake = OFFLINE_502
  const { client } = makeClient(relay.port, { clock })
  try {
    await assert.rejects(() => client.connect(), (error) => error.code === 'offline')
    assert.equal(client.state, 'offline')
    assert.equal(clock.pending, 1)
    assert.equal(client.nextRetryAt, clock.now() + 1000)

    // ...then the token dies: the NEXT (explicit) connect hits the gateway's
    // unpaired wall, and the armed wait must die with the ladder.
    relay.scenario.handshake = () => [401, { ok: false, reason: 'unpaired' }]
    await assert.rejects(() => client.connect(), (error) => error.code === 'revoked')
    assert.equal(client.state, 'revoked')
    assert.equal(client.nextRetryAt, null)
    assert.equal(clock.pending, 0)
    assert.equal(client.lastError, 'revoked')
    const hits = handshakeHits(relay)
    clock.advance(10 * 60_000)
    await sleep(30)
    assert.equal(handshakeHits(relay), hits, 'not one request left the client after the wall')
    assert.equal(client.state, 'revoked')
  } finally { await relay.stop() }
})

test('T43-fix: incompatible cancels an ARMED ladder the same way', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  relay.scenario.handshake = OFFLINE_502
  const { client } = makeClient(relay.port, { clock })
  try {
    await assert.rejects(() => client.connect(), (error) => error.code === 'offline')
    assert.equal(client.state, 'offline')
    assert.equal(clock.pending, 1)
    assert.notEqual(client.nextRetryAt, null)

    relay.scenario.handshake = () => [200, { ok: true, relayProtocol: 2, serverId: 'x', serverName: 'n', dshVersion: 'v', fingerprints: {} }]
    await assert.rejects(() => client.connect(), (error) => error.code === 'incompatible')
    assert.equal(client.state, 'incompatible')
    assert.equal(client.nextRetryAt, null)
    assert.equal(clock.pending, 0)
    const hits = handshakeHits(relay)
    clock.advance(10 * 60_000)
    await sleep(30)
    assert.equal(handshakeHits(relay), hits)
  } finally { await relay.stop() }
})

test('T43: unpaired never reconnects, and clearing the credentials cancels a pending wait', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  relay.scenario.handshake = OFFLINE_502
  const { client, setToken } = makeClient(relay.port, { clock })
  try {
    await assert.rejects(() => client.connect(), (error) => error.code === 'offline')
    assert.equal(clock.pending, 1)
    setToken('')
    client.credentialsChanged()
    assert.equal(client.state, 'unpaired')
    assert.equal(client.nextRetryAt, null)
    assert.equal(clock.pending, 0)
    const hits = handshakeHits(relay)
    clock.advance(120_000)
    await sleep(30)
    assert.equal(handshakeHits(relay), hits, 'an unpaired client stays silent')
  } finally { await relay.stop() }
})

test('T43: changed credentials cancel the wait and dial the new values at once', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  relay.scenario.handshake = OFFLINE_502
  const { client, setToken } = makeClient(relay.port, { clock })
  try {
    await assert.rejects(() => client.connect())
    assert.equal(clock.pending, 1)

    // The same credentials are a no-op: the wait stays armed, nothing dials.
    client.credentialsChanged()
    assert.equal(clock.pending, 1)
    assert.equal(handshakeHits(relay), 1)

    // A REAL change cancels the wait and connects immediately.
    relay.scenario.handshake = HANDSHAKE_OK
    setToken('tok-2')
    client.credentialsChanged()
    await waitFor(() => client.state === 'online', 3000)
    assert.equal(clock.pending, 0)
    assert.equal(client.nextRetryAt, null)
    assert.equal(relay.seen[relay.seen.length - 1].headers.authorization, 'Bearer tok-2', 'the new token rode the wire')

    // The ladder was reset with the cancel: a fresh failure waits 1s again.
    relay.scenario.handshake = OFFLINE_502
    await assert.rejects(() => client.connect())
    assert.equal(client.nextRetryAt, clock.now() + 1000)
  } finally { await relay.stop() }
})

test('T43: stop() cancels the armed retry — the row teardown leaves nothing behind', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  relay.scenario.handshake = OFFLINE_502
  const { client } = makeClient(relay.port, { clock })
  try {
    await assert.rejects(() => client.connect())
    assert.equal(clock.pending, 1)
    client.stop()
    assert.equal(clock.pending, 0)
    assert.equal(client.nextRetryAt, null)
    const hits = handshakeHits(relay)
    clock.advance(120_000)
    await sleep(30)
    assert.equal(handshakeHits(relay), hits)
  } finally { await relay.stop() }
})

test('T43: relay-unauthorized keeps the ladder running and records its code', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  relay.scenario.handshake = () => [401, { ok: false, error: { code: 'relay-unauthorized' } }]
  const { client } = makeClient(relay.port, { clock })
  try {
    await assert.rejects(() => client.connect(), (error) => error.code === 'relay-unauthorized')
    assert.equal(client.state, 'offline', 'a server-side secret fault is NOT a dead token — the client stays offline')
    assert.equal(client.lastError, 'relay-unauthorized')
    assert.equal(client.nextRetryAt, clock.now() + 1000)
    clock.advance(1000)
    await waitFor(() => handshakeHits(relay) === 2, 3000)
    await waitFor(() => clock.pending === 1 && client.state === 'offline', 3000)
    assert.equal(client.lastError, 'relay-unauthorized', 'the code survives the retry')
  } finally { await relay.stop() }
})

test('T43: the retry readout never carries credential material', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  relay.scenario.handshake = OFFLINE_502
  const { client, setUrl } = makeClient(relay.port, { clock })
  try {
    await assert.rejects(() => client.connect())
    const readout = JSON.stringify({ state: client.state, nextRetryAt: client.nextRetryAt, lastError: client.lastError })
    assert.equal(readout.includes('tok-1'), false, 'no token in the readout')
    assert.equal(readout.includes('127.0.0.1'), false, 'no URL in the readout')
    // Same after the timer walked and the transport error was recorded.
    setUrl(`http://127.0.0.1:${await deadPort()}`)
    client.credentialsChanged()
    await waitFor(() => clock.pending === 1, 3000)
    const after = JSON.stringify({ state: client.state, nextRetryAt: client.nextRetryAt, lastError: client.lastError })
    assert.equal(after.includes('tok-1'), false)
    assert.equal(after.includes('127.0.0.1'), false)
  } finally { await relay.stop() }
})

// ---- T43-fix: sanitization, in-flight credentials, concurrent joins ------------

test('T43-fix: a server "code" outside the diagnostics vocabulary reads unexpected', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  try {
    // A long code quoting a URL is exactly what must never reach lastError.
    relay.scenario.handshake = () => [200, { ok: false, error: { code: `see http://evil.example/trace/${'x'.repeat(80)}` } }]
    const { client } = makeClient(relay.port, { clock })
    await assert.rejects(() => client.connect())
    assert.equal(client.lastError, 'unexpected')
    assert.equal(JSON.stringify({ lastError: client.lastError }).includes('evil.example'), false)

    // A code just past the cap is refused too; a legal server-shaped code
    // rides through verbatim.
    relay.scenario.handshake = () => [200, { ok: false, error: { code: 'a'.repeat(65) } }]
    const capped = makeClient(relay.port, { clock }).client
    await assert.rejects(() => capped.connect())
    assert.equal(capped.lastError, 'unexpected')

    relay.scenario.handshake = () => [200, { ok: false, error: { code: 'gateway/invocation-unavailable' } }]
    const legal = makeClient(relay.port, { clock }).client
    await assert.rejects(() => legal.connect())
    assert.equal(legal.lastError, 'gateway/invocation-unavailable')
  } finally { await relay.stop() }
})

test('T43-fix: credentialsChanged during an in-flight connect follows up ONCE with the new token', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  const { client, setToken } = makeClient(relay.port, { clock })
  try {
    // The FIRST handshake (old credentials) stalls on the wire.
    let release = () => {}
    relay.scenario.handshake = (req, res) => {
      release = () => sendJson(res, 200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '补连', dshVersion: 'v', fingerprints: {} })
      return undefined // answered by release()
    }
    const first = client.connect()
    await waitFor(() => relay.seen.length === 1)

    // The credentials change while that attempt is still on the wire: no
    // second request may start — the running dial belongs to the OLD token.
    setToken('tok-2')
    client.credentialsChanged()
    await sleep(40)
    assert.equal(relay.seen.length, 1, 'nothing dials while the old attempt is in flight')

    // The stalled handshake answers; when it settles, exactly ONE follow-up
    // goes out with the NEW token.
    release()
    relay.scenario.handshake = HANDSHAKE_OK
    await first
    assert.equal(client.state, 'online')
    await waitFor(() => relay.seen.length === 2, 3000)
    assert.equal(relay.seen[1].headers.authorization, 'Bearer tok-2', 'the follow-up dialed the NEW credentials')
    await sleep(50)
    assert.equal(relay.seen.length, 2, 'exactly one follow-up, no loop')
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('T43-fix: concurrent connects while a retry is armed join into ONE handshake', async () => {
  const relay = await startFakeRelay()
  const clock = fakeClock()
  relay.scenario.handshake = OFFLINE_502
  const { client } = makeClient(relay.port, { clock })
  try {
    await assert.rejects(() => client.connect())
    assert.equal(clock.pending, 1, 'a retry is armed')

    relay.scenario.handshake = HANDSHAKE_OK
    const a = client.connect()
    const b = client.connect()
    assert.equal(a, b, 'the two callers joined one attempt')

    // Advancing past the armed wait must NOT stack another handshake on
    // top of the in-flight one (fireRetry no-ops on a non-offline state),
    // and at most one timer is ever outstanding.
    clock.advance(client.nextRetryAt - clock.now())
    await Promise.all([a, b])
    assert.equal(client.state, 'online')
    // One handshake for the initial failure, one for the JOINED attempt —
    // the fired timer added nothing.
    assert.equal(handshakeHits(relay), 2, 'the fired retry stacked no extra handshake')
    assert.ok(clock.pending <= 1)
    await sleep(30)
    assert.equal(handshakeHits(relay), 2)
    assert.equal(clock.pending, 0, 'the success cleared the machinery')
  } finally { await relay.stop() }
})

// ---- interface compatibility (T42) --------------------------------------------

test('compat: matching fingerprints compare identical; differing groups are named', async () => {
  const relay = await startFakeRelay()
  try {
    relay.scenario.handshake = () => [200, {
      ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '假服务器', dshVersion: '9.9.9-test',
      fingerprints: { session: 'aaa111', workspace: 'bbb222', events: 'ccc333' },
    }]
    const { client } = makeClient(relay.port, {
      computeOwnFingerprints: () => ({ session: 'aaa111', workspace: 'zzz999', events: 'ccc333' }),
    })
    assert.equal(client.compat, undefined, 'no verdict before the first handshake')
    await client.connect()
    assert.deepEqual(client.compat, { identical: ['events', 'session'], different: ['workspace'], unavailable: [] })
  } finally { await relay.stop() }
})

test('compat: an own-compute failure degrades every group to unavailable, never different', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port, {
      computeOwnFingerprints: () => { throw new Error('registry exploded') },
    })
    await client.connect()
    assert.deepEqual(client.compat, { identical: [], different: [], unavailable: ['algo'] })
  } finally { await relay.stop() }
})

test('compat: absent computeOwnFingerprints keeps compat undefined', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    assert.equal(client.compat, undefined)
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('compat: a verdict change rides the next handshake\u2019s state notification', async () => {
  const relay = await startFakeRelay()
  try {
    let serverFingerprints = { session: 'aaa111' }
    relay.scenario.handshake = () => [200, {
      ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '假服务器', dshVersion: '9.9.9-test',
      fingerprints: serverFingerprints,
    }]
    const { client } = makeClient(relay.port, { computeOwnFingerprints: () => ({ session: 'aaa111' }) })
    const events = []
    client.subscribe((s) => events.push(s))
    await client.connect()
    assert.deepEqual(client.compat, { identical: ['session'], different: [], unavailable: [] })
    assert.deepEqual(events, ['connecting', 'online'])
    // The server upgraded its interface: the next handshake flips the
    // verdict, stored BEFORE the online transition so the woken subscribers
    // read the fresh verdict off the getter.
    serverFingerprints = { session: 'fff999' }
    await client.connect()
    assert.deepEqual(client.compat, { identical: [], different: ['session'], unavailable: [] })
    assert.equal(client.state, 'online')
    assert.deepEqual(events, ['connecting', 'online', 'connecting', 'online'])
  } finally { await relay.stop() }
})

test('compat: unpairing and revocation clear the verdict (T42-fix)', async () => {
  const relay = await startFakeRelay()
  try {
    // Unpair path: a stored verdict, then the credentials vanish.
    const holder = makeClient(relay.port, { computeOwnFingerprints: () => ({ algo: 'sha256' }) })
    await holder.client.connect()
    assert.deepEqual(holder.client.compat?.identical, ['algo'])
    holder.setToken('')
    holder.client.credentialsChanged()
    assert.equal(holder.client.state, 'unpaired')
    assert.equal(holder.client.compat, undefined, 'the verdict described the OLD server — it goes with the link')

    // Revocation path: the same server later walls the token.
    const revoker = makeClient(relay.port, { computeOwnFingerprints: () => ({ algo: 'sha256' }) })
    await revoker.client.connect()
    assert.deepEqual(revoker.client.compat?.identical, ['algo'])
    relay.scenario.handshake = () => [401, { ok: false, reason: 'unpaired' }]
    await assert.rejects(() => revoker.client.connect(), (error) => error instanceof RelayError && error.code === 'revoked')
    assert.equal(revoker.client.state, 'revoked')
    assert.equal(revoker.client.compat, undefined, 'revocation is the same "this server is gone" wall')
  } finally { await relay.stop() }
})

test('compat: a credential change clears the verdict even while online (T23b2-fix3)', async () => {
  const relay = await startFakeRelay()
  try {
    const { client, setToken } = makeClient(relay.port, { computeOwnFingerprints: () => ({ algo: 'sha256' }) })
    await client.connect()
    assert.deepEqual(client.compat?.identical, ['algo'])
    assert.equal(client.state, 'online')
    // Unchanged credentials are a no-op — the verdict was earned by exactly
    // these values and stays.
    client.credentialsChanged()
    assert.deepEqual(client.compat?.identical, ['algo'])
    // A re-pair with a NEW token: the verdict described the OLD credentials.
    // It must vanish the moment the change is committed — there is a window
    // before the follow-up handshake repopulates it — and the fresh verdict
    // comes from that handshake.
    setToken('tok-2')
    client.credentialsChanged()
    assert.equal(client.compat, undefined, 'the verdict goes with the credentials it was earned with')
    await waitFor(() => client.state === 'online', 3000)
    assert.deepEqual(client.compat?.identical, ['algo'], 'the new handshake earned a fresh verdict')
  } finally { await relay.stop() }
})

// ---- T34: unshare + the structured error reason ------------------------------------

test('T34 unshare: the original sessionId rides POST relay/v1/unshare with the bearer token; success resolves', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    await client.unshare('session-a')
    const seen = relay.seen.filter((call) => call.url === UNSHARE)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].body, { sessionId: 'session-a' })
    assert.equal(seen[0].headers.authorization, 'Bearer tok-1')
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('T34 unshare: a refusal throws its code and never moves the state; unconfigured throws unpaired offline', async () => {
  const relay = await startFakeRelay()
  relay.scenario.unshare = () => [403, { ok: false, error: { code: 'not-shared' } }]
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    await assert.rejects(client.unshare('session-gone'), (error) => error instanceof RelayError && error.code === 'not-shared')
    assert.equal(client.state, 'online', 'a per-call refusal is not a link fact')

    const { client: bare } = makeClient(relay.port, { token: '' })
    await assert.rejects(bare.unshare('session-a'), (error) => error instanceof RelayError && error.code === 'unpaired')
    assert.equal(bare.state, 'unpaired')
  } finally { await relay.stop() }
})

test('T34 stream: the error line carries the structured reason on RelayError (and stays absent without one)', async () => {
  const relay = await startFakeRelay()
  relay.scenario.stream = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write('{"type":"error","error":{"code":"unshared","message":"closed","reason":"idle"}}\n')
  }
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    const { error } = await collect(client.openStream('session', 'follow', {}))
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'unshared')
    assert.equal(error.reason, 'idle', 'the structured close reason survived the line parser')

    relay.scenario.stream = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end('{"type":"error","error":{"code":"unshared","message":"closed"}}\n')
    }
    const again = await collect(client.openStream('session', 'follow', {}))
    assert.equal(again.error.code, 'unshared')
    assert.equal(again.error.reason, undefined, 'an older server frame without a reason stays undefined')

    relay.scenario.stream = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end('{"type":"error","error":{"code":"internal","message":"x","reason":42}}\n')
    }
    const junk = await collect(client.openStream('session', 'follow', {}))
    assert.equal(junk.error.code, 'internal')
    assert.equal(junk.error.reason, undefined, 'a non-string reason is dropped')
  } finally { await relay.stop() }
})

// ---- T59: the device-name sync -----------------------------------------------

test('T59 handshake: the server\'s record of this device rides the reply when sent', async () => {
  const relay = await startFakeRelay()
  try {
    relay.scenario.handshake = () => [200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '假服务器', dshVersion: '9.9.9-test', fingerprints: {}, deviceName: '书房的台式机' }]
    const { client } = makeClient(relay.port)
    const info = await client.connect()
    assert.equal(info.deviceName, '书房的台式机')
    assert.equal(client.handshakeInfo.deviceName, '书房的台式机')

    // An older server omits the field: the client keeps what it has — here,
    // nothing at all.
    const bare = await startFakeRelay()
    try {
      const { client: bareClient } = makeClient(bare.port)
      const bareInfo = await bareClient.connect()
      assert.equal('deviceName' in bareInfo, false, 'no field, no value')
    } finally { await bare.stop() }
  } finally { await relay.stop() }
})

test('T59 stream: a ping carrying names updates the handshake and notifies — state unmoved', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    const states = []
    let notifications = 0
    client.subscribe((s) => { notifications += 1; states.push(s) })
    // The heartbeat names, as the real server composes them per tick.
    relay.scenario.stream = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"type":"ping","serverName":"新服务端名","deviceName":"新设备名"}\n')
      res.end()
    }
    const iterator = client.openStream('session', 'follow', {})
    const first = await iterator.next()
    assert.equal(first.done, true, 'the one-shot stream ends after its ping')
    await waitFor(() => client.handshakeInfo.serverName === '新服务端名')
    assert.equal(client.handshakeInfo.deviceName, '新设备名')
    assert.ok(notifications >= 1, 'the identity change woke the subscribers')
    assert.ok(states.every((s) => s === 'online'), `no state movement — got ${states.join(',')}`)
    assert.equal(client.state, 'online')
  } finally { await relay.stop() }
})

test('T59 stream: an old-format bare ping neither errors nor notifies', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    let notifications = 0
    client.subscribe(() => { notifications += 1 })
    relay.scenario.stream = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"type":"ping"}\n')
      res.end()
    }
    const iterator = client.openStream('session', 'follow', {})
    const next = await iterator.next()
    assert.equal(next.done, true)
    await sleep(30)
    assert.equal(notifications, 0, 'a bare ping carries nothing worth announcing')
    assert.equal(client.state, 'online')
    assert.equal(client.handshakeInfo.serverName, '假服务器')
  } finally { await relay.stop() }
})

test('T59 queueDeviceName: online push, same-name no-op, offline queued for the first connect', async () => {
  // ONLINE, name differs: exactly one endpoint call carrying the name; the
  // local handshake record follows the confirmed answer.
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    await client.connect()
    client.queueDeviceName('书房的新名字')
    await waitFor(() => relay.seen.some((hit) => hit.url === DEVICE_NAME))
    const push = relay.seen.find((hit) => hit.url === DEVICE_NAME)
    assert.deepEqual(push.body, { name: '书房的新名字' })
    assert.equal(push.headers.authorization, 'Bearer tok-1')
    assert.equal(client.handshakeInfo.deviceName, '书房的新名字', 'the confirmed answer landed locally')
    const pushes = () => relay.seen.filter((hit) => hit.url === DEVICE_NAME).length

    // The same name again (the settings page's own write echoing back): a
    // no-op BY CONTRACT — this is the anti-bounce rule.
    client.queueDeviceName('书房的新名字')
    await sleep(40)
    assert.equal(pushes(), 1, 'an equal name never travels')

    // OFFLINE: the name queues, and the first successful connect flushes it.
    relay.scenario.deviceName = () => [200, { ok: true, name: '离线改名' }]
    relay.scenario.invoke = () => [502, { ok: false }]
    await assert.rejects(() => client.invoke('session', 'page', {}))
    await waitFor(() => client.state === 'offline')
    client.queueDeviceName('离线改名')
    await sleep(20)
    assert.equal(pushes(), 1, 'offline queues only')
    relay.scenario.handshake = HANDSHAKE_OK
    relay.scenario.handshake = () => [200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '假服务器', dshVersion: '9.9.9-test', fingerprints: {}, deviceName: '书房的新名字' }]
    await client.connect()
    await waitFor(() => pushes() === 2, 2000)
    assert.deepEqual(relay.seen.filter((hit) => hit.url === DEVICE_NAME).at(-1).body, { name: '离线改名' }, 'the queued rename went out after the handshake')

    // A queued name EQUAL to the server's record is dropped, not pushed:
    // the flush above left '离线改名' as the table's record, so queuing it
    // again is the echo — while the OLD name would legitimately travel (the
    // user actively saved it).
    client.queueDeviceName('离线改名')
    await sleep(40)
    assert.equal(pushes(), 2, 'a name the server already records is the echo, not a push')
    client.queueDeviceName('书房的新名字')
    await waitFor(() => pushes() === 3)
    assert.deepEqual(relay.seen.filter((hit) => hit.url === DEVICE_NAME).at(-1).body, { name: '书房的新名字' }, 'an actively saved rename travels, even back to an older value')
  } finally { await relay.stop() }
})

test('T59: a pushed rename outranks the stale stream heartbeat until the server confirms', async () => {
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port)
    relay.scenario.stream = (req, res) => {
      // The stream opened BEFORE the rename: its heartbeats still carry the
      // old marking header, and so the old name — indefinitely.
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"type":"ping","serverName":"假服务器","deviceName":"旧名"}\n')
      res.end()
    }
    await client.connect()
    const iterator = client.openStream('session', 'follow', {})
    await iterator.next()
    client.queueDeviceName('新名')
    await waitFor(() => relay.seen.some((hit) => hit.url === DEVICE_NAME))
    await waitFor(() => client.handshakeInfo.deviceName === '新名')
    // Let the stale ping land now that the local record is authoritative.
    await sleep(40)
    assert.equal(client.handshakeInfo.deviceName, '新名', 'the old heartbeat did NOT pull the name back — no overwrite loop')
    assert.equal(client.state, 'online')

    // The next server confirmation retires the authority: a handshake that
    // answers the new name keeps it (and a different one would win).
    relay.scenario.stream = undefined
    relay.scenario.handshake = () => [200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '假服务器', dshVersion: '9.9.9-test', fingerprints: {}, deviceName: '新名' }]
    await client.connect()
    assert.equal(client.handshakeInfo.deviceName, '新名')
    // Authority retired: a stale heartbeat WOULD win now — proving the flag
    // really cleared by pushing nothing and bouncing a differing ping back.
    relay.scenario.stream = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"type":"ping","serverName":"假服务器","deviceName":"服务端另一改"}\n')
      res.end()
    }
    const it2 = client.openStream('session', 'follow', {})
    await it2.next()
    await waitFor(() => client.handshakeInfo.deviceName === '服务端另一改')
  } finally { await relay.stop() }
})

test('T59: the periodic info refresh re-handshakes while online and folds the fresh names', async () => {
  const clock = fakeClock()
  const relay = await startFakeRelay()
  try {
    const { client } = makeClient(relay.port, { clock, infoRefreshMs: 30_000 })
    const handshakeBodies = () => relay.seen.filter((hit) => hit.url === HANDSHAKE).length
    await client.connect()
    assert.equal(handshakeBodies(), 1)
    // Advance past INFO_REFRESH_MS: the armed tick fires, one quiet
    // handshake goes out, and the fresh names land.
    relay.scenario.handshake = () => [200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '改名后的服务端', dshVersion: '9.9.9-test', fingerprints: {}, deviceName: '服务端改的名' }]
    clock.advance(30_000)
    await waitFor(() => handshakeBodies() === 2)
    await waitFor(() => client.handshakeInfo.serverName === '改名后的服务端' && client.handshakeInfo.deviceName === '服务端改的名')
    assert.equal(client.state, 'online', 'the refresh never leaves online')

    // And the ladder keeps re-arming while online.
    relay.scenario.handshake = () => [200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '再改', dshVersion: '9.9.9-test', fingerprints: {}, deviceName: '再改的设备名' }]
    clock.advance(30_000)
    await waitFor(() => handshakeBodies() === 3)
    await waitFor(() => client.handshakeInfo.serverName === '再改')
  } finally { await relay.stop() }
})
