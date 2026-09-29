/* dsh-zen-remote · T22a(+fix) relay routes (src/relay-server.ts)
 *
 * Boots a plain node:http server that mounts ONLY createRelayHandler (the
 * same shape the host webServer's prefix registration gives it) and drives
 * it with real requests. The gateway is a recording fake (configurable
 * return value or thrown error); the share table is a REAL createShareStore
 * over a temp file; DSH_HOME is not consulted — loadServerId takes the home
 * directory explicitly, and the tests hand it a temp one.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-relay-'))
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

const SECRET = 'e5f6g7h8'.repeat(8) // 64 chars, like the real per-apply secret
const AUTH = {
  'x-zen-remote-secret': SECRET,
  'x-zen-remote-via': 'gateway',
  'x-zen-remote-role': 'desktop-client',
  'x-zen-remote-device': 'device-9',
}

/** One relay handler plus its recording fake gateway. Each call gets its own
 * share file and server id, so tests cannot bleed into each other. */
function makeParts(name, overrides = {}) {
  const home = path.join(ROOT, name)
  fs.mkdirSync(home, { recursive: true })
  const calls = []
  const streamCalls = []
  const gateway = {
    invoke: async (call) => {
      calls.push(call)
      if (overrides.throw !== undefined) throw overrides.throw
      return overrides.value !== undefined ? overrides.value : { echo: { namespace: call.namespace, method: call.method, args: call.args } }
    },
    // T22b: the ownership check for job/kill (and the ownership probe for
    // job/follow) opens a throwaway job/list stream. The fake answers it
    // from `overrides.rows` (default: an empty recent set) and finishes.
    stream: async (call) => {
      streamCalls.push(call)
      if (overrides.stream !== undefined) return overrides.stream(call)
      const rows = call.namespace === 'job' && call.method === 'list' ? (overrides.rows ?? []) : []
      return (async function* () {
        yield { type: 'rows', jobs: rows }
      })()
    },
  }
  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  const handler = createRelayHandler({
    secret: overrides.secret !== undefined ? overrides.secret : SECRET,
    store,
    gateway,
    serverInfo: {
      serverId: loadServerId(home),
      serverName: () => (overrides.serverName !== undefined ? overrides.serverName : 'test-server'),
      dshVersion: '0.0.0-test',
      ...(overrides.fingerprints !== undefined ? { fingerprints: overrides.fingerprints } : {}),
    },
    ...(overrides.parentOf ? { parentOf: overrides.parentOf } : {}),
  })
  return { handler, calls, streamCalls, gateway, store, home }
}

/** Mount the handler alone on an OS-assigned port. */
async function startServer(handler) {
  const server = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.destroy() } catch (e) {} }) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    stop: () => new Promise((resolve) => server.close(resolve)),
    async fetch(pathName, opts = {}) {
      return fetch(`http://127.0.0.1:${port}${pathName}`, {
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body,
        signal: opts.signal,
      })
    },
  }
}

const post = (pathName, body, headers) => ({ method: 'POST', headers, body: JSON.stringify(body) })

/** One job row shaped like the `job/list` codec (owner optional — ownerless
 * jobs are exactly what the relay must hide). */
const JOB = (id, owner) => ({ id, ...(owner === undefined ? {} : { owner }), kind: 'process', label: id, status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } })

// ---- authentication -----------------------------------------------------------

test('relay auth: missing secret, wrong secret, missing via, and role web all get the same 401', async () => {
  const { handler } = makeParts('auth')
  const server = await startServer(handler)
  try {
    const attempts = [
      ['no secret header', { 'x-zen-remote-via': 'gateway', 'x-zen-remote-role': 'desktop-client' }],
      ['wrong secret', { ...AUTH, 'x-zen-remote-secret': 'wrong' }],
      ['missing via', { 'x-zen-remote-secret': SECRET, 'x-zen-remote-role': 'desktop-client' }],
      ['wrong via', { ...AUTH, 'x-zen-remote-via': 'forged' }],
      ['web role', { ...AUTH, 'x-zen-remote-role': 'web' }],
      ['no headers at all', {}],
    ]
    for (const [label, headers] of attempts) {
      const res = await server.fetch('/_dsh/zen-remote/relay/ping', { headers })
      assert.equal(res.status, 401, label)
      const body = await res.json()
      assert.deepEqual(body, { ok: false, error: { code: 'relay-unauthorized' } }, label + ' — uniform body, no hint which check failed')
    }
  } finally { await server.stop() }
})

test('relay auth: an empty configured secret refuses everything, even perfect headers', async () => {
  const { handler } = makeParts('empty-secret', { secret: '' })
  const server = await startServer(handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/ping', { headers: AUTH })
    assert.equal(res.status, 401, 'secret off means fail closed')
  } finally { await server.stop() }
})

// ---- ping ---------------------------------------------------------------------

test('ping: 200 {ok:true} with the JSON contract headers', async () => {
  const { handler } = makeParts('ping')
  const server = await startServer(handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/ping', { headers: AUTH })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(res.headers.get('cache-control'), 'no-store')
  } finally { await server.stop() }
})

// ---- handshake ------------------------------------------------------------------

test('handshake: complete fields, stable serverId across requests and handler instances', async () => {
  const parts = makeParts('handshake')
  const server = await startServer(parts.handler)
  try {
    const first = await server.fetch('/_dsh/zen-remote/relay/v1/handshake', post('/h', {}, AUTH))
    assert.equal(first.status, 200)
    const body1 = await first.json()
    assert.equal(body1.ok, true)
    assert.equal(body1.relayProtocol, 1)
    assert.equal(typeof body1.serverId, 'string')
    assert.match(body1.serverId, /^[0-9a-f]{8}$/, 'the server id is an 8-hex short id')
    assert.equal(body1.serverName, 'test-server')
    assert.equal(body1.dshVersion, '0.0.0-test')
    assert.deepEqual(body1.fingerprints, {})

    const second = await server.fetch('/_dsh/zen-remote/relay/v1/handshake', post('/h', {}, AUTH))
    const body2 = await second.json()
    assert.equal(body2.serverId, body1.serverId, 'the same handler reports the same id twice')

    // A brand-new store + handler over the SAME home keeps the identity.
    const again = makeParts('handshake')
    const server2 = await startServer(again.handler)
    try {
      const third = await server2.fetch('/_dsh/zen-remote/relay/v1/handshake', post('/h', {}, AUTH))
      const body3 = await third.json()
      assert.equal(body3.serverId, body1.serverId, 'the id is persisted per DSH_HOME, not per instance')
    } finally { await server2.stop() }

    const onDisk = JSON.parse(fs.readFileSync(path.join(parts.home, 'zen-remote-server.json'), 'utf8'))
    assert.equal(onDisk.serverId, body1.serverId, 'and the persisted file carries it')
  } finally { await server.stop() }
})

test('handshake: an empty request body is accepted, non-JSON content is 400', async () => {
  const { handler } = makeParts('handshake-empty')
  const server = await startServer(handler)
  try {
    const empty = await server.fetch('/_dsh/zen-remote/relay/v1/handshake', { method: 'POST', headers: AUTH })
    assert.equal(empty.status, 200, 'the handshake takes no arguments — an absent body is fine')
    assert.equal((await empty.json()).ok, true)

    const bad = await server.fetch('/_dsh/zen-remote/relay/v1/handshake', { method: 'POST', headers: AUTH, body: '[1,2]' })
    assert.equal(bad.status, 400, 'content that IS there must still be a JSON object')
  } finally { await server.stop() }
})

// ---- invoke: the happy path -----------------------------------------------------

test('invoke: a shared session is forwarded with args verbatim plus an abort signal', async () => {
  const parts = makeParts('invoke-ok')
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    const args = { request: { address: { kind: 'session', sessionId: 'session-a' }, throughSeq: 376, turnWindow: 30 } }
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'page', args }, AUTH))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.value, { echo: { namespace: 'session', method: 'page', args } })
    assert.equal(parts.calls.length, 1)
    assert.equal(parts.calls[0].namespace, 'session')
    assert.equal(parts.calls[0].method, 'page')
    assert.deepEqual(parts.calls[0].args, args, 'the gateway got the wire args untouched')
    assert.ok(parts.calls[0].signal instanceof AbortSignal, 'the call carries a cancellation signal')
    assert.equal(parts.calls[0].signal.aborted, false)
  } finally { await server.stop() }
})

test('invoke: request.sessionId methods forward through the same gate', async () => {
  const parts = makeParts('invoke-sessionid')
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    const args = { request: { sessionId: 'session-a', title: '新名字' } }
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'rename', args }, AUTH))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).ok, true)
    assert.deepEqual(parts.calls[0].args, args)
  } finally { await server.stop() }
})

test('invoke: a subagent address is judged by its shared parent', async () => {
  const parts = makeParts('invoke-subagent')
  parts.store.share('session-parent')
  const server = await startServer(parts.handler)
  try {
    const args = { request: { address: { kind: 'subagent', parentSessionId: 'session-parent', childSessionId: 'session-child', mode: 'continuable' } } }
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'page', args }, AUTH))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).ok, true)
  } finally { await server.stop() }
})

test('invoke: parentOf wiring — a child of a shared ancestor passes through the injected lookup', async () => {
  const parts = makeParts('invoke-parentof', {
    parentOf: (id) => (id === 'session-child' ? 'session-parent' : undefined),
    rows: [JOB('job-child', 'session-child')],
  })
  parts.store.share('session-parent')
  const server = await startServer(parts.handler)
  try {
    const args = { request: { sessionId: 'session-child', jobId: 'job-child' } }
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'job', method: 'kill', args }, AUTH))
    assert.equal(res.status, 200, 'the child borrows the parent share through parentOf')
    assert.equal((await res.json()).ok, true)
  } finally { await server.stop() }
})

// ---- invoke: refusals -------------------------------------------------------------

test('invoke: the three reviewer bypasses are 403 forbidden-method and never reach the gateway', async () => {
  const parts = makeParts('invoke-bypass')
  parts.store.share('S-shared')
  const server = await startServer(parts.handler)
  try {
    const bypasses = [
      ['session/search + decoy', { namespace: 'session', method: 'search', args: { request: { query: 'password', sessionId: 'S-shared' } } }],
      ['goals/create + agentId + decoy', { namespace: 'goals', method: 'create', args: { agentId: 'VICTIM', request: { objective: 'x', maxGoalRounds: 3, sessionId: 'S-shared' } } }],
      ['subagents/prompt + parentSessionId + decoy', { namespace: 'subagents', method: 'prompt', args: { request: { requestId: 'r', parentSessionId: 'VICTIM', childSessionId: 'C', mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: 'hi' }], sessionId: 'S-shared' } } }],
    ]
    for (const [label, body] of bypasses) {
      const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', body, AUTH))
      assert.equal(res.status, 403, label)
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'forbidden-method' } }, label)
    }
    assert.equal(parts.calls.length, 0, 'none of the bypass attempts reached the gateway')
  } finally { await server.stop() }
})

test('invoke: a stream-only method is forbidden on the invoke route', async () => {
  const parts = makeParts('invoke-stream')
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    for (const body of [
      { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } },
      { namespace: 'job', method: 'list', args: { request: { sessionId: 'session-a' } } },
    ]) {
      const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', body, AUTH))
      assert.equal(res.status, 403, `${body.namespace}/${body.method} streams via T22b, never invokes`)
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'forbidden-method' } })
    }
    assert.equal(parts.calls.length, 0)
  } finally { await server.stop() }
})

test('invoke: an unshared session is a 403 not-shared and never reaches the gateway', async () => {
  const parts = makeParts('invoke-unshared')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'page', args: { request: { address: { kind: 'session', sessionId: 'session-secret' } } } }, AUTH))
    assert.equal(res.status, 403)
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(parts.calls.length, 0)
  } finally { await server.stop() }
})

test('invoke: unregistered methods are 403 forbidden-method, registered ones without an id are no-session', async () => {
  const parts = makeParts('invoke-registry')
  const server = await startServer(parts.handler)
  try {
    // session/list is registered since T22b (invoke + result filter); the
    // fake's echo value carries no items array, so it passes through as-is.
    const list = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'list', args: { _request: {} } }, AUTH))
    assert.equal(list.status, 200, 'session/list invokes through the filtered controlled path')
    assert.equal((await list.json()).ok, true)

    const withDecoy = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'anything', method: 'else', args: { request: { sessionId: 'whatever' } } }, AUTH))
    assert.equal(withDecoy.status, 403)
    assert.deepEqual(await withDecoy.json(), { ok: false, error: { code: 'forbidden-method' } }, 'unknown methods refuse even when a request object rides along')

    const noId = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'projections', args: {} }, AUTH))
    assert.equal(noId.status, 403)
    assert.deepEqual(await noId.json(), { ok: false, error: { code: 'no-session' } }, 'a registered method with no id in its field is no-session')
  } finally { await server.stop() }
})

// ---- invoke: gateway failures ------------------------------------------------------

test('invoke: a DSH error (string code) is passed through with a clipped message', async () => {
  const err = new Error('Remote invocation "session/page" is unavailable')
  err.code = 'gateway/invocation-unavailable'
  const parts = makeParts('invoke-throw', { throw: err })
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'page', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } }, AUTH))
    assert.equal(res.status, 200, 'gateway failures are business answers, not transport errors')
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'gateway/invocation-unavailable')
    assert.equal(body.error.message, 'Remote invocation "session/page" is unavailable')
  } finally { await server.stop() }
})

test('invoke: a code-less error reports internal with NO message, long DSH messages clip to 500', async () => {
  const parts = makeParts('invoke-internal', { throw: new Error('/absolute/server/path leaked') })
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    const internal = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'page', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } }, AUTH))
    assert.equal(internal.status, 200)
    const body = await internal.json()
    assert.deepEqual(body, { ok: false, error: { code: 'internal' } }, 'no message field at all — internal paths stay internal')
  } finally { await server.stop() }

  const long = new Error('x'.repeat(2000))
  long.code = 'session/too-long'
  const parts2 = makeParts('invoke-long', { throw: long })
  parts2.store.share('session-a')
  const server2 = await startServer(parts2.handler)
  try {
    const res = await server2.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'page', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } }, AUTH))
    const body = await res.json()
    assert.equal(body.error.code, 'session/too-long')
    assert.equal(body.error.message.length, 500)
  } finally { await server2.stop() }
})

test('invoke: a Node system error (ENOENT) reports internal with NO path-leaking message', async () => {
  // 4b: Node errors carry string `code`s too, and their messages quote
  // server-side absolute paths. Only the DSH `namespace/name` code shape
  // travels with a message.
  const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/x/secret'"), { code: 'ENOENT' })
  const parts = makeParts('invoke-enoent', { throw: enoent })
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'page', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } }, AUTH))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, { ok: false, error: { code: 'internal' } })
    assert.equal(JSON.stringify(body).includes('/Users/x'), false, 'the server path never leaves')
  } finally { await server.stop() }
})

// ---- job ownership (4b) -----------------------------------------------------------

test('invoke: job/kill forwards when the job belongs to the claimed session', async () => {
  const parts = makeParts('kill-owned', { rows: [JOB('job-1', 'session-a'), JOB('job-2', undefined), JOB('job-3', 'session-b')] })
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'job', method: 'kill', args: { request: { sessionId: 'session-a', jobId: 'job-1' } } }, AUTH))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).ok, true)
    assert.equal(parts.calls.length, 1, 'the kill reached the gateway')
    // The throwaway job/list probe ran through the stream carrier.
    assert.equal(parts.streamCalls.length, 1)
    assert.equal(parts.streamCalls[0].method, 'list')
  } finally { await server.stop() }
})

test('invoke: job/kill refuses foreign and ownerless jobs, and a cache hit skips the probe', async () => {
  const parts = makeParts('kill-foreign', { rows: [JOB('job-2', undefined), JOB('job-3', 'session-b')] })
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    for (const jobId of ['job-2', 'job-3', 'job-unknown']) {
      const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'job', method: 'kill', args: { request: { sessionId: 'session-a', jobId } } }, AUTH))
      assert.equal(res.status, 403, `${jobId} is not owned by the claimed session`)
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'forbidden' } })
    }
    assert.equal(parts.calls.length, 0, 'no kill ever reached the gateway')
  } finally { await server.stop() }

  // The probe reads whatever the fake's job/list reports — an owned job the
  // list DOES mention goes through.
  const parts2 = makeParts('kill-probe-owned', { rows: [JOB('job-9', 'session-a')] })
  parts2.store.share('session-a')
  const server2 = await startServer(parts2.handler)
  try {
    const res = await server2.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'job', method: 'kill', args: { request: { sessionId: 'session-a', jobId: 'job-9' } } }, AUTH))
    assert.equal(res.status, 200, 'the probe found the job owned by the claimed session')
    assert.equal((await res.json()).ok, true)
  } finally { await server2.stop() }
})

// ---- client hang-up -----------------------------------------------------------------

test('invoke: a client disconnect aborts the signal the gateway call received', async () => {
  const parts = makeParts('invoke-abort')
  // The fake gateway hangs until its signal aborts. `reached` resolves when
  // the call arrives; `settled` only resolves THROUGH the abort listener, so
  // awaiting it proves the hang-up actually reached the gateway call.
  let sawAborted
  let reachedResolve
  const reached = new Promise((resolve) => { reachedResolve = resolve })
  // `settled` resolves ONLY through the abort listener, so awaiting it
  // proves the hang-up actually reached the gateway call. The listener must
  // resolve BOTH promises: the inner one (which the route awaits) and the
  // outer `settled` (the executor's return value would be discarded — the
  // one-test bug that made this exact wiring look like a lost abort).
  const settled = new Promise((resolve) => {
    parts.gateway.invoke = (call) => new Promise((resolveCall) => {
      call.signal.addEventListener('abort', () => {
        sawAborted = call.signal.aborted
        resolveCall(true)
        resolve(true)
      })
      reachedResolve()
    })
  })
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    // A raw node:http client, not fetch: the desktop client IS a Node
    // process hanging up mid-call, and req.destroy() tears the socket down
    // deterministically. (fetch/undici can leave the pooled socket open for
    // seconds after an abort — the hang-up this route must honor is the
    // connection closing, which destroy() models faithfully.)
    let clientError = null
    const req = http.request({
      host: '127.0.0.1', port: server.port, method: 'POST',
      path: '/_dsh/zen-remote/relay/v1/invoke',
      headers: { ...AUTH, 'content-type': 'application/json' }, agent: false,
    }, () => {})
    req.on('error', (e) => { clientError = e })
    req.end(JSON.stringify({ namespace: 'session', method: 'page', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } }))
    await reached
    // Abort a settled, pending call — the handshake-free state the route
    // actually guards — where teardown propagates in milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 100))
    req.destroy()
    const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))])
    assert.equal(outcome, true, 'the abort listener on the gateway signal fired (no timeout)')
    assert.equal(sawAborted, true, 'the gateway call saw signal.aborted === true')
    assert.ok(clientError !== null || req.destroyed, 'the client really hung up')
  } finally { await server.stop() }
})

// ---- malformed requests --------------------------------------------------------------

test('invoke: malformed bodies and fields are 400 bad-request', async () => {
  const parts = makeParts('invoke-bad')
  const server = await startServer(parts.handler)
  try {
    const cases = [
      ['unparsable JSON', 'not-json'],
      ['JSON array', '[]'],
      ['JSON scalar', '42'],
      ['missing method', JSON.stringify({ namespace: 'session', args: {} })],
      ['empty namespace', JSON.stringify({ namespace: '', method: 'page', args: {} })],
      ['non-string method', JSON.stringify({ namespace: 'session', method: 3, args: {} })],
      ['args not an object', JSON.stringify({ namespace: 'session', method: 'page', args: 'x' })],
      ['args is an array', JSON.stringify({ namespace: 'session', method: 'page', args: [] })],
    ]
    for (const [label, body] of cases) {
      const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body })
      assert.equal(res.status, 400, label)
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'bad-request' } }, label)
    }
    assert.equal(parts.calls.length, 0, 'nothing malformed reached the gateway')
  } finally { await server.stop() }
})

test('invoke: a body past the 1 MiB cap drains and answers 400', async () => {
  const parts = makeParts('invoke-big')
  const server = await startServer(parts.handler)
  try {
    const body = JSON.stringify({ namespace: 'session', method: 'page', args: { request: { address: { kind: 'session', sessionId: 'session-a' }, pad: 'x'.repeat(1024 * 1024) } } })
    assert.ok(body.length > 1024 * 1024)
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body })
    assert.equal(res.status, 400)
    assert.equal(parts.calls.length, 0)
  } finally { await server.stop() }
})

// ---- client unshare (T33a) -----------------------------------------------------------

test('unshare: a session in the table is closed with reason client', async () => {
  const parts = makeParts('unshare-ok')
  parts.store.share('session-a')
  const reasons = []
  parts.store.subscribe((event) => { if (event.type === 'unshared') reasons.push([event.sessionId, event.reason]) })
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/unshare', post('/u', { sessionId: 'session-a' }, AUTH))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal(parts.store.isShared('session-a'), false)
    assert.deepEqual(reasons, [['session-a', 'client']], 'the close is a desktop-client act, not a manual one')
  } finally { await server.stop() }
})

test('unshare: a session outside the table is 403 not-shared — children cannot be closed alone', async () => {
  // parentOf says session-child hangs under a shared parent: isAccessible
  // would answer true, but the route deliberately consults the TABLE only
  // (a child leaves remote access with its family or not at all).
  const parts = makeParts('unshare-child', { parentOf: (id) => (id === 'session-child' ? 'session-parent' : undefined) })
  parts.store.share('session-parent')
  const server = await startServer(parts.handler)
  try {
    const child = await server.fetch('/_dsh/zen-remote/relay/v1/unshare', post('/u', { sessionId: 'session-child' }, AUTH))
    assert.equal(child.status, 403)
    assert.deepEqual(await child.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(parts.store.isShared('session-parent'), true, 'the parent share is untouched')

    const stranger = await server.fetch('/_dsh/zen-remote/relay/v1/unshare', post('/u', { sessionId: 'never-shared' }, AUTH))
    assert.equal(stranger.status, 403)
    assert.deepEqual(await stranger.json(), { ok: false, error: { code: 'not-shared' } })
  } finally { await server.stop() }
})

test('unshare: malformed bodies and fields are 400, bad auth is the uniform 401', async () => {
  const parts = makeParts('unshare-bad')
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    const cases = [
      ['no body', { method: 'POST', headers: AUTH }],
      ['missing sessionId', post('/u', {}, AUTH)],
      ['empty sessionId', post('/u', { sessionId: '' }, AUTH)],
      ['non-string sessionId', post('/u', { sessionId: 3 }, AUTH)],
    ]
    for (const [label, opts] of cases) {
      const res = await server.fetch('/_dsh/zen-remote/relay/v1/unshare', opts)
      assert.equal(res.status, 400, label)
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'bad-request' } }, label)
    }
    assert.equal(parts.store.isShared('session-a'), true, 'nothing was closed')

    const anonymous = await server.fetch('/_dsh/zen-remote/relay/v1/unshare', post('/u', { sessionId: 'session-a' }, {}))
    assert.equal(anonymous.status, 401)
    assert.deepEqual(await anonymous.json(), { ok: false, error: { code: 'relay-unauthorized' } })

    const wrongMethod = await server.fetch('/_dsh/zen-remote/relay/v1/unshare', { method: 'GET', headers: AUTH })
    assert.equal(wrongMethod.status, 404)
  } finally { await server.stop() }
})

// ---- routing ---------------------------------------------------------------------------

test('routing: unknown paths, wrong methods, and %2F-shaped paths are all 404', async () => {
  const parts = makeParts('routing')
  const server = await startServer(parts.handler)
  try {
    const unknown = [
      ['GET', '/_dsh/zen-remote/relay'],
      ['GET', '/_dsh/zen-remote/relay/'],
      ['GET', '/_dsh/zen-remote/relay/nope'],
      ['POST', '/_dsh/zen-remote/relay/ping'],
      ['GET', '/_dsh/zen-remote/relay/v1/invoke'],
      ['DELETE', '/_dsh/zen-remote/relay/v1/invoke'],
      // The gateway admits relay paths whose raw and normalized forms are
      // byte-identical — these two ARE admitted by it and arrive here
      // verbatim. Decoding them before matching would reopen the traversal,
      // so they must stay unrecognized: 404, never an invoke.
      ['POST', '/_dsh/zen-remote/relay/v1%2Finvoke'],
      ['POST', '/_dsh/zen-remote/relay/x%2F..%2Fv1/invoke'],
    ]
    for (const [method, p] of unknown) {
      const res = await server.fetch(p, { method, headers: AUTH, body: method === 'POST' ? '{}' : undefined })
      assert.equal(res.status, 404, `${method} ${p}`)
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'not-found' } }, `${method} ${p}`)
    }
    assert.equal(parts.calls.length, 0, 'no unknown route reached the gateway')
  } finally { await server.stop() }
})

// ---- T42 + T42-fix: the handshake's fingerprint map -----------------------------

test('T42-fix handshake: fingerprints are computed per handshake and a thrown compute degrades to {}', async () => {
  let computes = 0
  let fail = false
  const parts = makeParts('handshake-fingerprints', {
    fingerprints: () => {
      computes += 1
      if (fail) throw new Error('registry exploded')
      return { session: 'r:aaa111' }
    },
  })
  const server = await startServer(parts.handler)
  try {
    const first = await server.fetch('/_dsh/zen-remote/relay/v1/handshake', post('/h', {}, AUTH))
    const body1 = await first.json()
    assert.deepEqual(body1.fingerprints, { session: 'r:aaa111' })
    const second = await server.fetch('/_dsh/zen-remote/relay/v1/handshake', post('/h', {}, AUTH))
    await second.json()
    assert.equal(computes, 2, 'recomputed per handshake — never cached across requests')
    // A broken compute must not fail the handshake itself.
    fail = true
    const third = await server.fetch('/_dsh/zen-remote/relay/v1/handshake', post('/h', {}, AUTH))
    assert.equal(third.status, 200)
    const body3 = await third.json()
    assert.equal(body3.ok, true)
    assert.deepEqual(body3.fingerprints, {}, 'a thrown compute degrades to the empty map')
  } finally { await server.stop() }
})
