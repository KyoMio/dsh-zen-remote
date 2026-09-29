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
const { createRelayHandler, loadServerId, encodeSessionReferenceUri, decodeSessionReferenceUri } = require('../lib/relay-server.js')
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
    ...(overrides.getApiFetch ? { getApiFetch: overrides.getApiFetch } : {}),
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

test('invoke: the three reviewer bypasses are 403 and never reach the gateway', async () => {
  const parts = makeParts('invoke-bypass')
  parts.store.share('S-shared')
  const server = await startServer(parts.handler)
  try {
    const bypasses = [
      ['session/search + decoy', { namespace: 'session', method: 'search', args: { request: { query: 'password', sessionId: 'S-shared' } } }, 'forbidden-method'],
      ['goals/create + agentId + decoy', { namespace: 'goals', method: 'create', args: { agentId: 'VICTIM', request: { objective: 'x', maxGoalRounds: 3, sessionId: 'S-shared' } } }, 'forbidden-method'],
      // T31 registered subagents/prompt (judged by the parent): the decoy no
      // longer buys a forbidden-method — the unshared PARENT refuses, and the
      // padded shared sessionId changes nothing.
      ['subagents/prompt + parentSessionId + decoy', { namespace: 'subagents', method: 'prompt', args: { request: { requestId: 'r', parentSessionId: 'VICTIM', childSessionId: 'C', mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: 'hi' }], sessionId: 'S-shared' } } }, 'not-shared'],
    ]
    for (const [label, body, code] of bypasses) {
      const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', body, AUTH))
      assert.equal(res.status, 403, label)
      assert.deepEqual(await res.json(), { ok: false, error: { code } }, label)
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

test('invoke: session/modelCatalog leaves with its failures emptied (T52-fix)', async () => {
  // The host's per-group failure text is its own load error (endpoint URLs,
  // credential states); the sub-client discards `failures` anyway, so the
  // route scrubs them (relay-filter.ts filterModelCatalogResult) while the
  // groups travel whole.
  const catalog = {
    default: { provider: 'codex', model: 'sol' },
    routableProviders: ['codex'],
    groups: [{ id: 'codex', name: 'Codex', models: [{ id: 'sol', name: 'Sol' }] }],
    failures: [{ id: 'broken', name: 'Broken', message: 'POST https://secret.example/v1 failed: 401 bad key' }],
  }
  const parts = makeParts('invoke-model-catalog', { value: catalog })
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'modelCatalog', args: {} }, AUTH))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.value.groups, catalog.groups, 'the groups travel whole')
    assert.deepEqual(body.value.default, catalog.default)
    assert.deepEqual(body.value.failures, [], 'the failure texts never leave the box')
    assert.equal(parts.calls.length, 1)
    const call = parts.calls[0]
    assert.deepEqual({ namespace: call.namespace, method: call.method, args: call.args }, {
      namespace: 'session',
      method: 'modelCatalog',
      args: {},
    })
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

test('invoke: a */internal DSH code keeps its code but drops the message (CP4)', async () => {
  // `gateway/internal` is the server calling its own failure by name — the
  // message that rides it quotes server-side facts, so only the code travels.
  const err = Object.assign(new Error('host internals: /Users/x/.dsh broke'), { code: 'gateway/internal' })
  const parts = makeParts('invoke-gw-internal', { throw: err })
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'page', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } }, AUTH))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, { ok: false, error: { code: 'gateway/internal' } }, 'the code stays, the message goes')
    assert.equal(JSON.stringify(body).includes('/Users/x'), false)
  } finally { await server.stop() }
})

// ---- invoke: the per-device budget (CP4) ------------------------------------------

test('invoke: more than 32 in-flight invokes on one device get 429 too-many-invokes, and the budget frees up after', async () => {
  let release = () => {}
  const drained = new Promise((resolve) => { release = resolve })
  const parts = makeParts('invoke-budget')
  parts.store.share('session-a')
  // Park every forwarded call at the gateway until the test says go.
  parts.gateway.invoke = async (call) => {
    parts.calls.push(call)
    await drained
    return { echo: call.method }
  }
  const server = await startServer(parts.handler)
  try {
    const args = { request: { address: { kind: 'session', sessionId: 'session-a' } } }
    const inFlight = []
    for (let i = 0; i < 32; i++) {
      inFlight.push(server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'page', args }, AUTH)))
    }
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(parts.calls.length, 32, 'the first thirty-two sit at the gateway')

    const over = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'page', args }, AUTH))
    assert.equal(over.status, 429, 'the thirty-third concurrent invoke is over the device budget')
    assert.deepEqual(await over.json(), { ok: false, error: { code: 'too-many-invokes' } })
    assert.equal(parts.calls.length, 32, 'the refused one never reached the gateway')

    release()
    for (const res of await Promise.all(inFlight)) assert.equal(res.status, 200)
    await new Promise((r) => setTimeout(r, 30))
    const again = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'page', args }, AUTH))
    assert.equal(again.status, 200, 'after the drain the budget is free again')
  } finally {
    release()
    await server.stop()
  }
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

test('stream: a body past the 1 MiB cap drains and answers 413 payload-too-large', async () => {
  // The generic ceiling lives on (invoke now carries the prompt-sized one):
  // the stream route still refuses a body over 1 MiB — as 413, distinct
  // from a 400 malformed-JSON answer.
  const parts = makeParts('stream-big')
  const server = await startServer(parts.handler)
  try {
    const body = JSON.stringify({ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } }, pad: 'x'.repeat(1024 * 1024) } })
    assert.ok(body.length > 1024 * 1024)
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/stream', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body })
    assert.equal(res.status, 413)
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'payload-too-large', details: {} } })
    assert.equal(parts.streamCalls.length, 0)
  } finally { await server.stop() }
})

test('invoke: a body over the generic 1 MiB cap now parses (T31 prompt headroom)', async () => {
  // The prompt routes carry inline images far past 1 MiB, so the invoke
  // route widened its ceiling — a ~2 MiB body reaches the access table
  // instead of dying in the body reader.
  const parts = makeParts('invoke-upload-size')
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  try {
    const body = JSON.stringify({ namespace: 'fileUploads', method: 'upload', args: { agentId: 'session-a', request: { data: 'A'.repeat(2 * 1024 * 1024), name: 'big.png' } } })
    assert.ok(body.length > 1024 * 1024)
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).ok, true)
    assert.equal(parts.calls.length, 1)
    assert.equal(parts.calls[0].namespace, 'fileUploads')
  } finally { await server.stop() }
})

test('invoke: a body past the invoke cap (32 MiB) drains and answers 413 payload-too-large', async () => {
  const parts = makeParts('invoke-huge')
  const server = await startServer(parts.handler)
  try {
    const body = JSON.stringify({ namespace: 'fileUploads', method: 'upload', args: { agentId: 'session-a', request: { data: 'A'.repeat(33 * 1024 * 1024) } } })
    assert.ok(body.length > 32 * 1024 * 1024)
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body })
    assert.equal(res.status, 413, 'oversize is 413 — a 400 would read as malformed JSON')
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'payload-too-large', details: {} } })
    assert.equal(parts.calls.length, 0)
  } finally { await server.stop() }
})

test('invoke: malformed JSON stays a 400, distinct from the 413 oversize answer', async () => {
  const parts = makeParts('invoke-bad-json')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: '{"namespace": "session", ' })
    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'bad-request' } })
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

// ---- T31: session/create, session/fork, subagents, agentId-located calls -------------

/** One `workspace/follow` baseline shaped like the workspace-controller codec. */
const WORKSPACE = (workspaceId, path) => ({ workspaceId, path, title: workspaceId, sessionIds: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' })
/** A stream override answering the workspace probe (other namespaces: an empty job feed). */
const workspaceStream = (workspaces) => async (call) => {
  if (call.namespace === 'workspace' && call.method === 'follow') {
    return (async function* () { yield { type: 'baseline', value: { items: workspaces, archivedSessionIds: [], pinnedSessionIds: [] } } })()
  }
  return (async function* () { yield { type: 'rows', jobs: [] } })()
}

test('T31 create: an existing workspace is forwarded pinned to it, and the new session is shared', async () => {
  const parts = makeParts('t31-create-ok', { stream: workspaceStream([WORKSPACE('W-1', '/srv/proj')]), value: { sessionId: 'session-new' } })
  const server = await startServer(parts.handler)
  try {
    const args = { request: { workspaceId: 'W-1', cwd: '/client/side/path', sessionId: 'session-attacker' } }
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'create', args }, AUTH))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, value: { sessionId: 'session-new' } })
    // The probe was one throwaway workspace/follow stream.
    assert.equal(parts.streamCalls.length, 1)
    assert.equal(parts.streamCalls[0].namespace, 'workspace')
    assert.equal(parts.streamCalls[0].method, 'follow')
    // The forwarded call kept the workspace and lost the client's cwd and
    // session id (DSH takes workspace.path as the cwd and mints the id).
    assert.equal(parts.calls.length, 1)
    assert.deepEqual(parts.calls[0].args, { request: { workspaceId: 'W-1' } })
    // Born shared: the client only ever sees shared sessions.
    assert.equal(parts.store.isShared('session-new'), true)
  } finally { await server.stop() }
})

test('T31-fix create: the forwarded request is a WHITELIST — unknown fields never reach the gateway', async () => {
  const parts = makeParts('t31-create-whitelist', { stream: workspaceStream([WORKSPACE('W-1', '/srv/proj')]), value: { sessionId: 'session-new' } })
  const server = await startServer(parts.handler)
  try {
    // Unknown/forbidden fields (env, permissionMode, cwd, a caller-chosen
    // sessionId) ride in like any hostile padding — the rebuild leaves only
    // the two fields DSH's create understands, agentPreset among them when
    // it is a string.
    const args = {
      request: {
        workspaceId: 'W-1',
        agentPreset: 'coder',
        cwd: '/client/side/path',
        sessionId: 'session-attacker',
        env: { SECRET: 'leak' },
        permissionMode: 'yolo',
      },
    }
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'create', args }, AUTH))
    assert.equal(res.status, 200)
    assert.equal(parts.calls.length, 1)
    assert.deepEqual(parts.calls[0].args, { request: { workspaceId: 'W-1', agentPreset: 'coder' } })
    // A non-string agentPreset is dropped too (the wire field is a string).
    const odd = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'create', args: { request: { workspaceId: 'W-1', agentPreset: 42, env: 'x' } } }, AUTH))
    assert.equal(odd.status, 200)
    assert.deepEqual(parts.calls[1].args, { request: { workspaceId: 'W-1' } })
  } finally { await server.stop() }
})

test('T31-fix: a gateway failure shares NOTHING for create or fork', async () => {
  const parts = makeParts('t31-no-share-on-error', {
    stream: workspaceStream([WORKSPACE('W-1', '/srv/proj')]),
    throw: Object.assign(new Error('attach failed'), { code: 'session/workspace-attach-failed' }),
  })
  parts.store.share('S-src')
  const server = await startServer(parts.handler)
  try {
    const created = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'create', args: { request: { workspaceId: 'W-1' } } }, AUTH))
    assert.equal(created.status, 200)
    assert.deepEqual(await created.json(), { ok: false, error: { code: 'session/workspace-attach-failed', message: 'attach failed' } })
    const forked = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'fork', args: { request: { sessionId: 'S-src', atSeq: 1 } } }, AUTH))
    assert.equal(forked.status, 200)
    assert.deepEqual(await forked.json(), { ok: false, error: { code: 'session/workspace-attach-failed', message: 'attach failed' } })
    // No result, no share — a session the table never saw is not the
    // client's to reach, and nothing was created to leak. (The fork SOURCE
    // 'S-src' is legitimately in the table — it had to be for the call to
    // reach the gateway at all.)
    for (const id of ['session-new', 'session-forked']) assert.equal(parts.store.isShared(id), false, id)
  } finally { await server.stop() }
})

test('T31 create: an unknown workspace is a 403 workspace/not-found and never reaches the gateway', async () => {
  const parts = makeParts('t31-create-miss', { stream: workspaceStream([WORKSPACE('W-other', '/srv/other')]) })
  const server = await startServer(parts.handler)
  try {
    for (const workspaceId of ['W-missing', 'zr~abcd1234~W-1']) {
      const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'create', args: { request: { workspaceId } } }, AUTH))
      assert.equal(res.status, 403, workspaceId)
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'workspace/not-found' } }, workspaceId)
    }
    assert.equal(parts.calls.length, 0, 'nothing was created')
    // A `zr~` id must not have leaked into a workspace either way.
  } finally { await server.stop() }
})

test('T31 create: a failed workspace probe refuses exactly like a miss', async () => {
  const parts = makeParts('t31-create-probe-fail', {
    stream: async () => { throw new Error('probe down') },
  })
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'create', args: { request: { workspaceId: 'W-1' } } }, AUTH))
    assert.equal(res.status, 403)
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'workspace/not-found' } })
    assert.equal(parts.calls.length, 0)
  } finally { await server.stop() }
})

test('T31 fork: a shared source forks and the child is auto-shared; an unshared source refuses', async () => {
  const parts = makeParts('t31-fork', { value: { sessionId: 'session-forked' } })
  parts.store.share('session-src')
  const server = await startServer(parts.handler)
  try {
    const args = { request: { sessionId: 'session-src', atSeq: 4 } }
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'fork', args }, AUTH))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, value: { sessionId: 'session-forked' } })
    assert.deepEqual(parts.calls[0].args, args, 'the fork arguments travel verbatim')
    assert.equal(parts.store.isShared('session-forked'), true, 'the fork follows the share')

    const denied = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'fork', args: { request: { sessionId: 'session-secret' } } }, AUTH))
    assert.equal(denied.status, 403)
    assert.deepEqual(await denied.json(), { ok: false, error: { code: 'not-shared' } })
  } finally { await server.stop() }
})

test('T31 agentId calls: the agentId decides and a shared request.sessionId decoy buys nothing', async () => {
  const parts = makeParts('t31-agentid')
  parts.store.share('session-shared')
  const server = await startServer(parts.handler)
  try {
    const decoy = { agentId: 'session-secret', request: { data: 'Zm9v', sessionId: 'session-shared' } }
    const refused = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'fileUploads', method: 'upload', args: decoy }, AUTH))
    assert.equal(refused.status, 403, 'the unshared agentId refuses despite the shared decoy')
    assert.deepEqual(await refused.json(), { ok: false, error: { code: 'not-shared' } })

    const refsDecoy = { agentId: 'session-secret', query: 'src', request: { sessionId: 'session-shared' } }
    const refusedRefs = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'fileReferences', method: 'list', args: refsDecoy }, AUTH))
    assert.equal(refusedRefs.status, 403)
    assert.deepEqual(await refusedRefs.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(parts.calls.length, 0)

    const upload = { agentId: 'session-shared', request: { data: 'Zm9v', name: 'x.png' } }
    const ok = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'fileUploads', method: 'upload', args: upload }, AUTH))
    assert.equal(ok.status, 200)
    assert.deepEqual(parts.calls[0].args, upload, 'the upload travels verbatim')
  } finally { await server.stop() }
})

test('T31/T41a subagents: both calls forward with parent shared and child inherited, a foreign child refuses', async () => {
  // T41a claims BOTH ids: the child session never enters the table but
  // borrows the parent's share through the injected parentOf — exactly the
  // store.isAccessible(id, parentOf) inheritance.
  const parts = makeParts('t31-subagents', {
    parentOf: (id) => (id === 'session-child' ? 'session-parent' : undefined),
  })
  parts.store.share('session-parent')
  const server = await startServer(parts.handler)
  try {
    const prompt = { request: { requestId: 'r1', parentSessionId: 'session-parent', childSessionId: 'session-child', mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: '你好' }] } }
    const okPrompt = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'subagents', method: 'prompt', args: prompt }, AUTH))
    assert.equal(okPrompt.status, 200)
    assert.deepEqual(parts.calls[0].args, prompt, 'both ids travel in original form; DSH still validates the pair')

    const interrupt = { childSessionId: 'session-child', parentSessionId: 'session-parent', mode: 'continuable' }
    const okInterrupt = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'subagents', method: 'interruptByParent', args: interrupt }, AUTH))
    assert.equal(okInterrupt.status, 200)
    assert.deepEqual(parts.calls[1].args, interrupt, 'top-level arguments travel verbatim')

    const denied = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'subagents', method: 'prompt', args: { request: { requestId: 'r2', parentSessionId: 'session-secret', childSessionId: 'session-parent', mode: 'continuable', delivery: 'queue', content: [] } } }, AUTH))
    assert.equal(denied.status, 403, 'an unshared parent refuses even with a shared child id')
    assert.deepEqual(await denied.json(), { ok: false, error: { code: 'not-shared' } })

    // The T41a decoy: a shared parent with a child that belongs to nobody
    // (parentOf leads nowhere shared) refuses before DSH is ever asked.
    const foreign = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'subagents', method: 'prompt', args: { request: { requestId: 'r3', parentSessionId: 'session-parent', childSessionId: 'session-foreign', mode: 'continuable', delivery: 'queue', content: [] } } }, AUTH))
    assert.equal(foreign.status, 403, 'a foreign child refuses under a shared parent')
    assert.deepEqual(await foreign.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(parts.calls.length, 2, 'the refusals never reached the gateway')
  } finally { await server.stop() }
})

// ---- T41a-fix: @ candidates and prompt-text session references ---------------------

test('T41a-fix reference codec: canonical base64url(JSON) round-trip, non-canonical rejected', () => {
  // The shape RT dsh-session-reference implements: base64url of the
  // JSON-QUOTED id, decode demanding byte-exact re-encoding.
  for (const id of ['session-a', 'zr~721b94fb~session-b', '含中文', 'a"b\\c', 'x'.repeat(300)]) {
    const uri = encodeSessionReferenceUri(id)
    assert.ok(uri.startsWith('dsh-session:'))
    assert.equal(decodeSessionReferenceUri(uri), id, JSON.stringify(id))
  }
  // Non-canonical payloads are not references: wrong JSON quoting, a padded
  // or mutated payload, non-base64url characters, a non-string decode.
  assert.equal(decodeSessionReferenceUri('dsh-session:'), undefined)
  assert.equal(decodeSessionReferenceUri('dsh-session:!!!'), undefined)
  assert.equal(decodeSessionReferenceUri('dsh-session:session-a'), undefined, 'bare id without JSON quoting')
  assert.equal(
    decodeSessionReferenceUri(`dsh-session:${Buffer.from('"session-a"', 'utf8').toString('base64url')}x`),
    undefined,
    'mutated payload fails the canonical round-trip',
  )
  assert.equal(decodeSessionReferenceUri(`dsh-session:${Buffer.from('42', 'utf8').toString('base64url')}`), undefined, 'a number is not a session id')
})

test('T41a-fix candidates: only accessible sessions travel, malformed rows are dropped', async () => {
  const rows = [
    { sessionId: 'session-shared', label: '共享', displayTitle: '共享的会话', mention: `@[共享的会话](${encodeSessionReferenceUri('session-shared')})`, sameWorkspace: true, createdAt: 1 },
    { sessionId: 'session-secret', label: '机密', displayTitle: '机密的会话', mention: `@[机密的会话](${encodeSessionReferenceUri('session-secret')})`, sameWorkspace: false, createdAt: 2 },
    { label: 'row without an id' },
  ]
  const parts = makeParts('t41a-fix-candidates', { value: rows })
  parts.store.share('session-shared')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'sessionReferenceResolver', method: 'candidates', args: { agentId: 'session-shared', query: '' } }, AUTH))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.value, [rows[0]], 'the unshared row and the id-less row never travel')
    assert.equal(parts.calls.length, 1, 'the call itself ran — the filter is output-side')
  } finally { await server.stop() }
})

test('T41a-fix prompt references: shared travels verbatim, unshared refuses before the gateway', async () => {
  const parts = makeParts('t41a-fix-refs')
  parts.store.share('session-a')
  parts.store.share('session-b')
  const server = await startServer(parts.handler)
  const prompt = (text) => ({
    namespace: 'session',
    method: 'prompt',
    args: { request: { requestId: 'r1', sessionId: 'session-a', mode: 'queue', content: [{ type: 'text', text }, { type: 'image', mediaType: 'image/png', data: 'Zm9v' }] } },
  })
  try {
    // Markdown mention + bare URI, both naming accessible sessions.
    const okText = `对照 @[调试](dsh-session:${Buffer.from(JSON.stringify('session-b'), 'utf8').toString('base64url')}) 与裸地址 ${encodeSessionReferenceUri('session-a')}`
    const ok = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', prompt(okText), AUTH))
    assert.equal(ok.status, 200)
    assert.deepEqual(parts.calls[0].args, prompt(okText).args, 'the text travels verbatim — the relay only checks')

    // One unshared reference in the text refuses the WHOLE prompt.
    const leak = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', prompt(`顺便看看 ${encodeSessionReferenceUri('session-secret')}`), AUTH))
    assert.equal(leak.status, 403)
    assert.deepEqual(await leak.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(parts.calls.length, 1, 'the refused prompt never reached the gateway')

    // A mixed text (shared + unshared) refuses too; non-text blocks alone travel.
    const mixed = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', prompt(`@[a](dsh-session:${Buffer.from(JSON.stringify('session-b'), 'utf8').toString('base64url')}) 和 ${encodeSessionReferenceUri('session-secret')}`), AUTH))
    assert.equal(mixed.status, 403)

    // Malformed addresses are DSH's business error, not ours: they travel.
    const junk = `解析这个 dsh-session:!!! 和伪地址 dsh-session:${Buffer.from('session-b', 'utf8').toString('base64url')}`
    const junkRes = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', prompt(junk), AUTH))
    assert.equal(junkRes.status, 200, 'non-canonical tokens do not crash the relay')
    assert.deepEqual(parts.calls[1].args, prompt(junk).args)
  } finally { await server.stop() }
})

test('T41a-fix subagents/prompt references get the same share check', async () => {
  // parentOf wires the child's inheritance so the CALL itself passes the
  // T41a both-ids check — this test is about the TEXT reference.
  const parts = makeParts('t41a-fix-subagent-refs', {
    parentOf: (id) => (id === 'session-child' ? 'session-parent' : undefined),
  })
  parts.store.share('session-parent')
  const server = await startServer(parts.handler)
  const prompt = (text) => ({
    namespace: 'subagents',
    method: 'prompt',
    args: { request: { requestId: 'r1', parentSessionId: 'session-parent', childSessionId: 'session-child', mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text }] } },
  })
  try {
    const ok = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', prompt(`父会话 ${encodeSessionReferenceUri('session-parent')} 的结论`), AUTH))
    assert.equal(ok.status, 200)
    const leak = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', prompt(`别的会话 ${encodeSessionReferenceUri('session-secret')}`), AUTH))
    assert.equal(leak.status, 403)
    assert.deepEqual(await leak.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(parts.calls.length, 1)
  } finally { await server.stop() }
})

// ---- T41a-fix2: the two prompt-scan bypasses ---------------------------------------

test('T41a-fix2 updateQueue: an edit content referencing an unshared session refuses before the gateway', async () => {
  // The PoC: updateQueue's edit REPLACES a queued USER message's content
  // verbatim (RT dsh-api-session-controller updateQueue), and
  // prepareDirectMessages parses that content at the next turn start — so
  // the edit content is a prompt-text sibling, not opaque data.
  const parts = makeParts('t41a-fix2-queue')
  parts.store.share('session-a')
  parts.store.share('session-b')
  const server = await startServer(parts.handler)
  const update = (action) => ({
    namespace: 'session',
    method: 'updateQueue',
    args: { request: { sessionId: 'session-a', itemId: 'q1', action } },
  })
  try {
    const poc = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', update({ kind: 'edit', content: [{ type: 'text', text: `重新组织 ${encodeSessionReferenceUri('session-secret')}` }] }), AUTH))
    assert.equal(poc.status, 403, 'the poisoned edit refuses')
    assert.deepEqual(await poc.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(parts.calls.length, 0, 'it never reached the gateway')

    // An edit naming an accessible session travels verbatim — the relay
    // only checks, never rewrites.
    const okAction = update({ kind: 'edit', content: [{ type: 'text', text: `对照 ${encodeSessionReferenceUri('session-b')}` }] })
    const ok = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', okAction, AUTH))
    assert.equal(ok.status, 200)
    assert.deepEqual(parts.calls[0].args, okAction.args)

    // steer/remove carry no content the host would inject (RT updateQueue
    // reads action.content only under 'edit' — steer re-sends the STORED
    // message), so junk references there are not the relay's business.
    const steer = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', update({ kind: 'steer', content: [{ type: 'text', text: encodeSessionReferenceUri('session-secret') }] }), AUTH))
    assert.equal(steer.status, 200, 'the host ignores this content for steer')
    assert.equal(parts.calls.length, 2)
  } finally { await server.stop() }
})

test('T41a-fix2 commands/execute: an unshared reference anywhere in the arguments refuses', async () => {
  // The PoC: /plan steers its raw input in as a fresh USER message (RT
  // dsh-plan-mode, agent.steer(createUserMessage(…))) — parsed exactly like
  // prompt text at the next turn start. The scan is RECURSIVE over every
  // string in the arguments, keyed on no field name.
  const parts = makeParts('t41a-fix2-commands')
  parts.store.share('session-a')
  const server = await startServer(parts.handler)
  const execute = (args) => ({ namespace: 'commands', method: 'execute', args })
  try {
    const poc = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', execute({ agentId: 'session-a', line: `/plan ${encodeSessionReferenceUri('session-secret')}` }), AUTH))
    assert.equal(poc.status, 403, 'the poisoned /plan refuses')
    assert.deepEqual(await poc.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(parts.calls.length, 0, 'it never reached the gateway')

    // A reference hidden in a nested NON-line string refuses too.
    const hidden = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', execute({ agentId: 'session-a', line: '/plan ok', extra: { deep: [`看看 ${encodeSessionReferenceUri('session-secret')}`] } }), AUTH))
    assert.equal(hidden.status, 403)
    assert.equal(parts.calls.length, 0)

    // An accessible reference (and a plain command line) travels.
    const ok = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', execute({ agentId: 'session-a', line: `/plan ${encodeSessionReferenceUri('session-a')}` }), AUTH))
    assert.equal(ok.status, 200)
    assert.equal(parts.calls.length, 1)
  } finally { await server.stop() }
})

// ---- T41b: relay/v1/http (the plain-HTTP panel passthrough) --------------------

/** A shared-handler double that records the synthetic Request and answers a
 * canned Response. The URL is asserted to the byte in the tests below. */
function fakeApiFetch(answer) {
  const seen = []
  const dispatch = async (request) => {
    seen.push(request)
    if (typeof answer === 'function') return answer(request)
    return answer
  }
  return { seen, dispatch }
}

test('T41b http: an unregistered route answers 404 before any id is read', async () => {
  const api = fakeApiFetch(new Response('{}', { status: 200 }))
  const parts = makeParts('t41b-http-unknown', { getApiFetch: () => api.dispatch })
  parts.store.share('session-1')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 'session.export', query: 'sessionId=session-1' }, AUTH))
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'unknown-route' } })
    const proto = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 'constructor', query: 'sessionId=session-1' }, AUTH))
    assert.equal(proto.status, 404, 'a prototype key name is not a route')
    assert.equal(api.seen.length, 0, 'nothing was dispatched')
  } finally { await server.stop() }
})

test('T41b http: an unshared session answers 403 not-shared, a malformed one 400', async () => {
  const api = fakeApiFetch(new Response('{}', { status: 200 }))
  const parts = makeParts('t41b-http-shared', { getApiFetch: () => api.dispatch })
  parts.store.share('session-1')
  const server = await startServer(parts.handler)
  try {
    const unshared = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 'changes.diff', query: 'sessionId=session-secret&seq=1&index=0' }, AUTH))
    assert.equal(unshared.status, 403)
    assert.deepEqual(await unshared.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(api.seen.length, 0, 'the unshared read was never dispatched')
    const noId = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 'changes.summary', query: 'seq=1' }, AUTH))
    assert.equal(noId.status, 400)
    assert.deepEqual(await noId.json(), { ok: false, error: { code: 'no-session' } })
  } finally { await server.stop() }
})

test('T41b http: a shared session dispatches a synthetic GET with the original id and passes the answer through', async () => {
  const api = fakeApiFetch(new Response(JSON.stringify({ kind: 'text', path: 'a.ts', hunks: [] }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }))
  const parts = makeParts('t41b-http-dispatch', { getApiFetch: () => api.dispatch })
  parts.store.share('session-1')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 'changes.diff', query: 'sessionId=session-1&seq=3&index=0' }, AUTH))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(api.seen.length, 1)
    // The synthetic Request is the contract: GET, exact /api path, the
    // ORIGINAL session id (the client swapped its virtual id back before
    // the relay), the rest of the query verbatim.
    assert.equal(api.seen[0].method, 'GET')
    assert.equal(api.seen[0].url, 'http://relay.local/api/changes.diff?sessionId=session-1&seq=3&index=0')
    assert.equal(body.value.status, 200)
    assert.equal(body.value.contentType, 'application/json; charset=utf-8')
    assert.equal(body.value.body, JSON.stringify({ kind: 'text', path: 'a.ts', hunks: [] }))
  } finally { await server.stop() }
})

test('T41b http: the underlying route status rides INSIDE the success envelope (a 404 is an answer, not a relay failure)', async () => {
  const api = fakeApiFetch(new Response('Change summary unavailable.', { status: 404 }))
  const parts = makeParts('t41b-http-404', { getApiFetch: () => api.dispatch })
  parts.store.share('session-1')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 'changes.summary', query: 'sessionId=session-1&seq=9' }, AUTH))
    assert.equal(res.status, 200)
    const body = await res.json()
    // Node answers a plain-text Response with its own default content type;
    // whatever it is, it travels verbatim beside the status.
    assert.equal(body.ok, true)
    assert.equal(body.value.status, 404)
    assert.equal(body.value.body, 'Change summary unavailable.')
    assert.ok(typeof body.value.contentType === 'string')
  } finally { await server.stop() }
})

test('T41b http: a missing shared handler answers 501 unsupported and never throws', async () => {
  const parts = makeParts('t41b-http-nohandler')
  parts.store.share('session-1')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 'changes.summary', query: 'sessionId=session-1&seq=1' }, AUTH))
    assert.equal(res.status, 501)
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'unsupported' } })
  } finally { await server.stop() }
})

test('T41b http: a body field is refused (GET semantics only), and so is a non-object or wrong-typed payload', async () => {
  const api = fakeApiFetch(new Response('{}', { status: 200 }))
  const parts = makeParts('t41b-http-body', { getApiFetch: () => api.dispatch })
  parts.store.share('session-1')
  const server = await startServer(parts.handler)
  try {
    const withBody = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 'changes.summary', query: 'sessionId=session-1&seq=1', body: 'raw-bytes-attempt' }, AUTH))
    assert.equal(withBody.status, 400, 'a forwarded body is a protocol violation')
    assert.deepEqual(await withBody.json(), { ok: false, error: { code: 'bad-request' } })
    const wrongTypes = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 5, query: ['x'] }, AUTH))
    assert.equal(wrongTypes.status, 400)
    assert.equal(api.seen.length, 0, 'nothing was dispatched')
  } finally { await server.stop() }
})

test('T41b-fix parser differential: what the share check approves is EXACTLY what dispatches', async () => {
  // The reviewed bypass: URLSearchParams kept `\t` inside `session\tId` while
  // the WHATWG URL parser stripped it from the synthetic URL — one checked
  // parameter went in, two arrived, and the serving route read the FIRST
  // `sessionId` (the secret). The route now dispatches the decision's
  // normalized query alone.
  // A fresh Response per dispatch: a shared instance's body is consumed by
  // the first read and every later .text() would throw.
  const api = fakeApiFetch(() => new Response('{}', { status: 200 }))
  const parts = makeParts('t41b-fix-differential', { getApiFetch: () => api.dispatch })
  parts.store.share('session-1')
  const server = await startServer(parts.handler)
  const approvedId = (url) => new URL(url).searchParams.get('sessionId')
  try {
    for (const query of [
      'session\tId=session-secret&sessionId=session-1&seq=1&index=0',
      'session\rId=session-secret&sessionId=session-1&seq=1&index=0',
      'session\nId=session-secret&sessionId=session-1&seq=1&index=0',
      '?sessionId=session-1&seq=1',
      'sessionId=session-1&foo=bar&seq=1',
    ]) {
      const res = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 'changes.diff', query }, AUTH))
      assert.equal(res.status, 200, query)
      const body = await res.json()
      assert.equal(body.ok, true, query)
      assert.equal(api.seen.length, 1, query)
      const dispatched = new URL(api.seen[0].url)
      assert.equal(approvedId(api.seen[0].url), 'session-1', `host saw ${JSON.stringify(dispatched.search)} for ${JSON.stringify(query)}`)
      assert.equal(dispatched.searchParams.get('foo'), null, `unknown parameters must not travel: ${query}`)
      assert.equal(dispatched.searchParams.getAll('sessionId').length, 1, query)
      assert.ok(!api.seen[0].url.includes('session-secret'), query)
      assert.ok(!api.seen[0].url.includes('\t') && !api.seen[0].url.includes('\r') && !api.seen[0].url.includes('\n'), query)
      assert.equal(api.seen[0].url.startsWith('http://relay.local/api/changes.diff?'), true, query)
      api.seen.length = 0
    }
    // Garbage coordinates refuse with 400 and dispatch nothing.
    // A fragment in the query is garbage the serving route's own coordinate
    // parser would refuse too; refusing at the relay is the same answer, and
    // nothing of it travels.
    for (const query of ['sessionId=session-1&seq=1%2F..%2F', 'sessionId=session-1&seq=1#/../../session.export', 'sessionId=session-1&seq=1&seq=2', 'sessionId=session-1&%73essionId=session-secret&seq=1']) {
      const res = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 'changes.diff', query }, AUTH))
      assert.equal(res.status, 400, query)
      assert.equal(api.seen.length, 0, query)
    }
    // The byte-exact contract now reads the NORMALIZED query: fixed order,
    // whitelisted parameters only.
    const clean = await server.fetch('/_dsh/zen-remote/relay/v1/http', post('/h', { route: 'changes.diff', query: 'index=0&sessionId=session-1&extra=x&seq=3' }, AUTH))
    assert.equal(clean.status, 200)
    assert.equal(api.seen[0].url, 'http://relay.local/api/changes.diff?sessionId=session-1&seq=3&index=0')
  } finally { await server.stop() }
})
