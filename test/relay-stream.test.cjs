/* dsh-zen-remote · T22b streaming relay route (src/relay-server.ts)
 *
 * Boots a plain node:http server that mounts ONLY createRelayHandler and
 * drives the `POST /_dsh/zen-remote/relay/v1/stream` protocol with real
 * requests: NDJSON frames, ping heartbeats, the end/error tails, share-change
 * synchronization against a REAL createShareStore, the per-device stream
 * budget, and viewer counts. The gateway's `stream` half is a controllable
 * fake: each open returns a gate the test can push frames into, finish, or
 * fail, and whose abort signal is observable.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-relay-stream-'))
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

const SECRET = 'f1e2d3c4'.repeat(8)
const AUTH = {
  'x-zen-remote-secret': SECRET,
  'x-zen-remote-via': 'gateway',
  'x-zen-remote-role': 'desktop-client',
  'x-zen-remote-device': 'device-1',
}

/** The error the real gateway surfaces when a stream's signal aborts —
 * documented as the stream's normal end (docs/spike-relay.md §2). */
const abortError = (call) => Object.assign(
  new Error(`Remote invocation "${call.namespace}/${call.method}" was aborted`),
  { code: 'gateway/cancelled' },
)

/** One controllable async-iterable stream: the test pushes frames, finishes,
 * or fails it; the route's abort lands as a gateway/cancelled throw. */
function makeGate(call) {
  const pending = []
  let wake = () => {}
  let settled = 'open' // 'open' | 'done' | { error }
  call.signal?.addEventListener('abort', () => {
    if (settled === 'open') {
      settled = { error: abortError(call) }
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
    throwNow: (error) => { pending.push({ kind: 'throw', error }); wake() },
    finish: () => { pending.push({ kind: 'return' }); wake() },
    get aborted() { return call.signal?.aborted === true },
    /** Frames pushed but not yet pulled by the relay pump — the observable
     * half of the backpressure test. */
    get queued() { return pending.length },
  }
}

/** A recording fake gateway: `invoke` answers from overrides.invoke (default:
 * a DSH-shaped not-implemented error), `stream` opens a gate per call. */
function makeFakeGateway(overrides = {}) {
  const invokeCalls = []
  const streams = []
  const gateway = {
    invoke: async (call) => {
      invokeCalls.push(call)
      if (overrides.invoke !== undefined) return overrides.invoke(call)
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
    stream: async (call) => {
      const gate = makeGate(call)
      streams.push(gate)
      if (overrides.stream !== undefined) await overrides.stream(call, gate)
      return gate.iterable
    },
  }
  return { gateway, invokeCalls, streams }
}

function makeParts(name, { shared = [], overrides = {}, heartbeatMs, endDrainTimeoutMs, parentOf } = {}) {
  const home = path.join(ROOT, name)
  fs.mkdirSync(home, { recursive: true })
  const fake = makeFakeGateway(overrides)
  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  for (const id of shared) store.share(id)
  const handler = createRelayHandler({
    secret: SECRET,
    store,
    gateway: fake.gateway,
    serverInfo: { serverId: loadServerId(home), serverName: () => 'stream-test', dshVersion: '0.0.0-test' },
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
    ...(endDrainTimeoutMs !== undefined ? { endDrainTimeoutMs } : {}),
    ...(parentOf !== undefined ? { parentOf } : {}),
  })
  return { handler, store, ...fake }
}

async function startServer(handler) {
  const server = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } }) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    stop: () => new Promise((resolve) => {
      // fetch/undici parks idle keep-alive sockets that would hold
      // server.close() open until its own idle timeout — teardown must be
      // deterministic, so the connections go first.
      server.closeAllConnections()
      server.close(resolve)
    }),
    async fetch(pathName, opts = {}) {
      return fetch(`http://127.0.0.1:${server.address().port}${pathName}`, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body })
    },
  }
}

const post = (pathName, body, headers) => ({ method: 'POST', headers, body: JSON.stringify(body) })

/** Open one stream with a RAW node:http request (the desktop client IS a
 * Node process; destroy() models its hang-ups deterministically, unlike
 * fetch/undici pooled sockets). Resolves once the response HEADERS arrive. */
function openStream(server, body, headers = AUTH) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.port, method: 'POST',
      path: '/_dsh/zen-remote/relay/v1/stream',
      // Connection: close — agent:false still means a keep-alive socket on
      // modern Node, and a socket pool nobody drains would pin the test
      // process after the assertions are done.
      headers: { ...headers, 'content-type': 'application/json', connection: 'close' },
      agent: false,
    }, (res) => {
      const lines = []
      const rawChunks = []
      let buffer = ''
      let bodyResolve
      const body = new Promise((r) => { bodyResolve = r })
      let doneResolve
      const done = new Promise((r) => { doneResolve = r })
      let ended = false
      const finish = () => {
        if (ended) return
        ended = true
        doneResolve()
        bodyResolve(Buffer.concat(rawChunks).toString('utf8'))
      }
      res.on('data', (chunk) => {
        rawChunks.push(chunk)
        buffer += chunk.toString('utf8')
        let idx
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (raw.trim() === '') continue
          try { lines.push(JSON.parse(raw)) } catch { lines.push({ parseError: raw }) }
        }
      })
      res.on('end', finish)
      res.on('close', finish)
      resolve({ status: res.statusCode, headers: res.headers, res, req, lines, body, done })
    })
    req.on('error', () => { /* the destroy() below surfaces here; the test observes the server side */ })
    req.end(JSON.stringify(body))
  })
}

/** Poll until the predicate holds; times out loud, never silently. */
async function waitFor(predicate, ms = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// ---- 1. the happy path -------------------------------------------------------------

test('stream: a shared session/follow flows as NDJSON frames and ends', async () => {
  const parts = makeParts('follow-ok', { shared: ['session-a'] })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    assert.equal(open.status, 200)
    // The compression middleware of DSH's web server would hold the stream;
    // no-transform makes it skip. X-Accel-Buffering does the same for nginx.
    assert.equal(open.headers['content-type'], 'application/x-ndjson; charset=utf-8')
    assert.equal(open.headers['cache-control'], 'no-store, no-transform')
    assert.equal(open.headers['x-accel-buffering'], 'no')

    const gate = parts.streams[0]
    assert.ok(gate, 'the gateway stream was opened once')
    assert.equal(gate.call.namespace, 'session')
    assert.equal(gate.call.method, 'follow')
    assert.equal(gate.call.args.request.address.sessionId, 'session-a', 'the wire args travel verbatim')

    gate.push({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    gate.push({ type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: {} } })
    gate.finish()
    await open.done
    assert.deepEqual(open.lines, [
      { type: 'frame', frame: { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } } },
      { type: 'frame', frame: { type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: {} } } },
      { type: 'end' },
    ])
  } finally { await server.stop() }
})

// ---- 2. refusal before the stream --------------------------------------------------

test('stream: an unshared session is a 403 not-shared and never opens the gateway stream', async () => {
  const parts = makeParts('follow-unshared')
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/stream', post('/s', { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-secret' } } } }, AUTH))
    assert.equal(res.status, 403)
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(parts.streams.length, 0)
  } finally { await server.stop() }
})

test('stream: non-stream and unregistered methods are 403 forbidden-method, malformed bodies 400', async () => {
  const parts = makeParts('stream-refusals', { shared: ['session-a'] })
  const server = await startServer(parts.handler)
  try {
    for (const body of [
      { namespace: 'session', method: 'page', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } },
      { namespace: 'session', method: 'list', args: { _request: {} } },
      { namespace: 'settings', method: 'update', args: {} },
    ]) {
      const res = await server.fetch('/_dsh/zen-remote/relay/v1/stream', post('/s', body, AUTH))
      assert.equal(res.status, 403, `${body.namespace}/${body.method}`)
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'forbidden-method' } })
    }
    const bad = await server.fetch('/_dsh/zen-remote/relay/v1/stream', { method: 'POST', headers: AUTH, body: '[1]' })
    assert.equal(bad.status, 400)
    assert.deepEqual(await bad.json(), { ok: false, error: { code: 'bad-request' } })
    assert.equal(parts.streams.length, 0)
  } finally { await server.stop() }
})

// ---- 3. heartbeat ------------------------------------------------------------------

test('stream: an idle stream carries ping heartbeats, and they stop at the end', async () => {
  const parts = makeParts('heartbeat', { shared: ['session-a'], heartbeatMs: 25 })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    await waitFor(() => open.lines.some((line) => line.type === 'ping'))
    parts.streams[0].finish()
    await open.done
    assert.equal(open.lines[open.lines.length - 1].type, 'end')
  } finally { await server.stop() }
})

// ---- 4. client hang-up -------------------------------------------------------------

test('stream: a mid-stream disconnect aborts the upstream signal and raises nothing', async () => {
  const parts = makeParts('disconnect', { shared: ['session-a'], heartbeatMs: 25 })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    const gate = parts.streams[0]
    gate.push({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    await waitFor(() => open.lines.length >= 1)
    open.req.destroy()
    await waitFor(() => gate.aborted, 2000)
    await open.done
    // Nothing further may arrive after the hang-up (no trailing end line).
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(open.lines.some((line) => line.type === 'end'), false)
  } finally { await server.stop() }
})

// ---- 5. upstream failures ------------------------------------------------------------

test('stream: a DSH-shaped upstream error rides the error line with its message', async () => {
  const parts = makeParts('throw-dsh', { shared: ['session-a'] })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    parts.streams[0].throwNow(Object.assign(new Error('Remote invocation "session/follow" is unavailable'), { code: 'gateway/invocation-unavailable' }))
    await open.done
    assert.deepEqual(open.lines, [{ type: 'error', error: { code: 'gateway/invocation-unavailable', message: 'Remote invocation "session/follow" is unavailable' } }])
  } finally { await server.stop() }
})

test('stream: a Node-shaped upstream error (ENOENT) reports internal without its path', async () => {
  const parts = makeParts('throw-enoent', { shared: ['session-a'] })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    parts.streams[0].throwNow(Object.assign(new Error("ENOENT: no such file or directory, open '/Users/x/secret'"), { code: 'ENOENT' }))
    await open.done
    assert.deepEqual(open.lines, [{ type: 'error', error: { code: 'internal' } }])
    assert.equal(JSON.stringify(open.lines).includes('/Users/x'), false)
  } finally { await server.stop() }
})

test('stream: a gateway.stream open failure surfaces as an error line after the 200', async () => {
  const parts = makeParts('open-throws', { shared: ['session-a'] })
  parts.gateway.stream = async () => { throw Object.assign(new Error('unary Remote methods cannot be opened through the stream carrier'), { code: 'gateway/signature-invalid' }) }
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    assert.equal(open.status, 200, 'the headers are already out when the open fails')
    await open.done
    assert.deepEqual(open.lines, [{ type: 'error', error: { code: 'gateway/signature-invalid', message: 'unary Remote methods cannot be opened through the stream carrier' } }])
  } finally { await server.stop() }
})

// ---- 6. workspace/follow: filtering + share-change synthesis -------------------------

const WORKSPACE = (id, sessionIds) => ({ workspaceId: id, path: `/tmp/${id}`, title: id, sessionIds, createdAt: 'c', updatedAt: 'u' })

test('stream: workspace/follow filters unshared sessions, then follows share and unshare live', async () => {
  const parts = makeParts('workspace-sync', { shared: ['S-shared'] })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'workspace', method: 'follow', args: {} })
    const gate = parts.streams[0]
    gate.push({
      type: 'baseline',
      value: {
        items: [WORKSPACE('w1', ['S-shared', 'S-secret']), WORKSPACE('w2', ['S-secret'])],
        archivedSessionIds: ['S-secret'],
        pinnedSessionIds: ['S-secret'],
      },
    })
    await waitFor(() => open.lines.length >= 1)
    assert.deepEqual(open.lines[0], {
      type: 'frame',
      frame: {
        type: 'baseline',
        value: {
          items: [WORKSPACE('w1', ['S-shared']), WORKSPACE('w2', [])],
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
      },
    }, 'unshared ids are filtered out of items, archived and pinned; workspaces themselves stay')

    // Sharing S-secret re-filters every workspace that contains it — the
    // synthesized upserts carry it now, as do archived/pinned.
    parts.store.share('S-secret')
    await waitFor(() => open.lines.length >= 5)
    assert.deepEqual(open.lines.slice(1), [
      { type: 'frame', frame: { type: 'upsert', workspace: WORKSPACE('w1', ['S-shared', 'S-secret']) } },
      { type: 'frame', frame: { type: 'upsert', workspace: WORKSPACE('w2', ['S-secret']) } },
      { type: 'frame', frame: { type: 'archived', archivedSessionIds: ['S-secret'] } },
      { type: 'frame', frame: { type: 'pinned', pinnedSessionIds: ['S-secret'] } },
    ])

    // Unsharing re-filters the same workspaces WITHOUT the session.
    parts.store.unshare('S-secret', 'manual')
    await waitFor(() => open.lines.length >= 9)
    assert.deepEqual(open.lines.slice(5), [
      { type: 'frame', frame: { type: 'upsert', workspace: WORKSPACE('w1', ['S-shared']) } },
      { type: 'frame', frame: { type: 'upsert', workspace: WORKSPACE('w2', []) } },
      { type: 'frame', frame: { type: 'archived', archivedSessionIds: [] } },
      { type: 'frame', frame: { type: 'pinned', pinnedSessionIds: [] } },
    ])

    gate.finish()
    await open.done
    assert.equal(open.lines[open.lines.length - 1].type, 'end')
  } finally { await server.stop() }
})

// ---- 7. session/control: filtered projections + share synthesis ---------------------

test('stream: session/control filters foreign projections, then synthesizes them on share', async () => {
  const parts = makeParts('control-sync', {
    shared: ['S-shared'],
    overrides: {
      invoke: (call) => {
        assert.equal(call.namespace, 'session')
        assert.equal(call.method, 'projections')
        return { asOfSeq: 9, values: { title: 'fresh', permissions: { currentValue: 'default' } } }
      },
    },
  })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'control', args: {} })
    const gate = parts.streams[0]
    gate.push({
      type: 'baseline',
      value: {
        projections: {
          'S-shared': { asOfSeq: 1, values: { title: 'mine' } },
          'S-secret': { asOfSeq: 2, values: { title: 'hidden' } },
        },
      },
    })
    gate.push({ type: 'projection', sessionId: 'S-secret', key: 'title', value: 'nope', seq: 3 })
    gate.push({ type: 'projection', sessionId: 'S-shared', key: 'title', value: 'yes', seq: 4 })
    await waitFor(() => open.lines.length >= 2)
    assert.deepEqual(open.lines, [
      {
        type: 'frame',
        frame: { type: 'baseline', value: { projections: { 'S-shared': { asOfSeq: 1, values: { title: 'mine' } } } } },
      },
      { type: 'frame', frame: { type: 'projection', sessionId: 'S-shared', key: 'title', value: 'yes', seq: 4 } },
    ])

    // Sharing S-secret fetches its current projections and emits one
    // synthesized projection frame per key, seq = the reported asOfSeq.
    parts.store.share('S-secret')
    await waitFor(() => open.lines.length >= 4)
    assert.deepEqual(open.lines.slice(2), [
      { type: 'frame', frame: { type: 'projection', sessionId: 'S-secret', key: 'title', value: 'fresh', seq: 9 } },
      { type: 'frame', frame: { type: 'projection', sessionId: 'S-secret', key: 'permissions', value: { currentValue: 'default' }, seq: 9 } },
    ])

    // Unshare synthesizes nothing: the workspace stream removes the session.
    const before = open.lines.length
    parts.store.unshare('S-secret', 'client')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(open.lines.length, before)
    gate.finish()
    await open.done
  } finally { await server.stop() }
})

// ---- 8. a session-scoped stream dies loudly on unshare ------------------------------

test('stream: session/follow ends with an unshared error line when its session leaves the table', async () => {
  const parts = makeParts('unshare-kill', { shared: ['session-a'] })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    const gate = parts.streams[0]
    gate.push({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    await waitFor(() => open.lines.length >= 1)

    parts.store.unshare('session-a', 'manual')
    await open.done
    const errorLine = open.lines[open.lines.length - 1]
    assert.equal(errorLine.type, 'error')
    assert.equal(errorLine.error.code, 'unshared')
    assert.match(errorLine.error.message, /session-a/)
    assert.equal(gate.aborted, true, 'the upstream subscription was aborted')
  } finally { await server.stop() }
})

// ---- 9. session/list through invoke is filtered --------------------------------------

test('invoke: session/list results keep only shared sessions, other fields ride along', async () => {
  const parts = makeParts('list-filter', {
    shared: ['S-shared'],
    overrides: {
      invoke: () => ({
        items: [
          { sessionId: 'S-shared', running: false, blank: true },
          { sessionId: 'S-secret', running: true, blank: false },
        ],
        extraField: 'kept',
      }),
    },
  })
  const server = await startServer(parts.handler)
  try {
    const res = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'session', method: 'list', args: { _request: {} } }, AUTH))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.value, {
      items: [{ sessionId: 'S-shared', running: false, blank: true }],
      extraField: 'kept',
    })
  } finally { await server.stop() }
})

// ---- 10. the per-device stream budget ------------------------------------------------

test('stream: more than 32 concurrent streams for one device get 429 too-many-streams', async () => {
  const parts = makeParts('stream-budget', { shared: ['session-a'], heartbeatMs: 60_000 })
  const server = await startServer(parts.handler)
  const opens = []
  try {
    for (let i = 0; i < 32; i += 1) {
      opens.push(await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } }))
    }
    await waitFor(() => opens.every((open) => open.status === 200))
    assert.equal(parts.streams.length, 32)

    const thirtyThird = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    assert.equal(thirtyThird.status, 429)
    assert.deepEqual(JSON.parse(await thirtyThird.body), { ok: false, error: { code: 'too-many-streams' } })
    assert.equal(parts.streams.length, 32, 'no 33rd gateway stream was opened')

    // Another device has its own budget.
    const other = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } }, { ...AUTH, 'x-zen-remote-device': 'device-2' })
    assert.equal(other.status, 200)
    opens.push(other)
  } finally {
    for (const open of opens) open.req.destroy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await server.stop()
  }
})

// ---- 11. viewer counts ----------------------------------------------------------------

test('viewerCount: session-scoped streams count and uncount, global streams never count', async () => {
  const parts = makeParts('viewers', { shared: ['session-a'], heartbeatMs: 60_000 })
  const server = await startServer(parts.handler)
  const opens = []
  try {
    assert.equal(parts.handler.viewerCount('session-a'), 0)
    const first = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    const second = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } }, { ...AUTH, 'x-zen-remote-device': 'device-2' })
    opens.push(first, second)
    await waitFor(() => parts.handler.viewerCount('session-a') === 2)

    const global = await openStream(server, { namespace: 'workspace', method: 'follow', args: {} })
    opens.push(global)
    await waitFor(() => parts.streams.length === 3)
    assert.equal(parts.handler.viewerCount('session-a'), 2, 'the global stream adds nothing')

    first.req.destroy()
    await waitFor(() => parts.handler.viewerCount('session-a') === 1)
    second.req.destroy()
    await waitFor(() => parts.handler.viewerCount('session-a') === 0)
    assert.equal(parts.handler.viewerCount('session-never-shared'), 0)
  } finally {
    for (const open of opens) open.req.destroy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await server.stop()
  }
})

// ---- 4b: job filtering through the stream route ----------------------------------------

test('stream: job/list keeps only jobs owned by the claimed session', async () => {
  const JOB = (id, owner) => ({ id, ...(owner === undefined ? {} : { owner }), kind: 'process', label: id, status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } })
  const parts = makeParts('job-list-filter', { shared: ['session-a'] })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'job', method: 'list', args: { request: { sessionId: 'session-a' } } })
    const gate = parts.streams[0]
    gate.push({ type: 'rows', jobs: [JOB('j-mine', 'session-a'), JOB('j-foreign', 'session-b'), JOB('j-ownerless', undefined)] })
    gate.push({ type: 'rows', jobs: [] })
    gate.finish()
    await open.done
    assert.deepEqual(open.lines, [
      { type: 'frame', frame: { type: 'rows', jobs: [JOB('j-mine', 'session-a')] } },
      { type: 'frame', frame: { type: 'rows', jobs: [] } },
      { type: 'end' },
    ])
  } finally { await server.stop() }
})

test('stream: job/follow with a foreign job is 403 forbidden, an owned job streams', async () => {
  const JOB = (id, owner) => ({ id, owner, kind: 'process', label: id, status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } })
  const parts = makeParts('job-follow-ownership', { shared: ['session-a'] })
  // The ownership probe (job/list) sees exactly one owned job; every other
  // stream opens a normal controllable gate.
  parts.gateway.stream = async (call) => {
    if (call.namespace === 'job' && call.method === 'list') {
      return (async function* () { yield { type: 'rows', jobs: [JOB('job-owned', 'session-a')] } })()
    }
    const gate = makeGate(call)
    parts.streams.push(gate)
    return gate.iterable
  }
  const server = await startServer(parts.handler)
  try {
    const foreign = await server.fetch('/_dsh/zen-remote/relay/v1/stream', post('/s', { namespace: 'job', method: 'follow', args: { request: { sessionId: 'session-a', jobId: 'job-elsewhere' } } }, AUTH))
    assert.equal(foreign.status, 403, 'a job the list does not mention is refused, not guessed')
    assert.deepEqual(await foreign.json(), { ok: false, error: { code: 'forbidden' } })

    const open = await openStream(server, { namespace: 'job', method: 'follow', args: { request: { sessionId: 'session-a', jobId: 'job-owned' } } })
    assert.equal(open.status, 200)
    const gate = parts.streams.find((entry) => entry.call.method === 'follow')
    assert.ok(gate, 'the follow stream opened after the ownership probe')
    gate.push({ type: 'opened', job: JOB('job-owned', 'session-a'), from: 0 })
    gate.finish()
    await open.done
    assert.deepEqual(open.lines[0], { type: 'frame', frame: { type: 'opened', job: JOB('job-owned', 'session-a'), from: 0 } })
    assert.equal(open.lines[open.lines.length - 1].type, 'end')
  } finally { await server.stop() }
})

test('stream: a job/list relay stream feeds the ownership cache for later kills', async () => {
  const JOB = (id, owner) => ({ id, owner, kind: 'process', label: id, status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } })
  const parts = makeParts('job-cache', { shared: ['session-a'], overrides: { invoke: () => ({ killed: true }) } })
  const server = await startServer(parts.handler)
  try {
    // The job/list stream flows through the relay — its rows feed the cache.
    const list = await openStream(server, { namespace: 'job', method: 'list', args: { request: { sessionId: 'session-a' } } })
    const gate = parts.streams[0]
    gate.push({ type: 'rows', jobs: [JOB('job-live', 'session-a')] })
    await waitFor(() => list.lines.length >= 1)

    const kill = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'job', method: 'kill', args: { request: { sessionId: 'session-a', jobId: 'job-live' } } }, AUTH))
    assert.equal(kill.status, 200, 'the kill is answered from the recent rows, no probe needed')
    assert.deepEqual(await kill.json(), { ok: true, value: { killed: true } })
    assert.equal(parts.streams.length, 1, 'the cache hit opened no probe stream')

    // A job the cache does not know gets exactly ONE throwaway probe.
    let probes = 0
    parts.gateway.stream = async (call) => {
      probes += 1
      if (call.namespace === 'job' && call.method === 'list') {
        return (async function* () { yield { type: 'rows', jobs: [] } })()
      }
      return makeGate(call).iterable
    }
    const refused = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'job', method: 'kill', args: { request: { sessionId: 'session-a', jobId: 'job-ghost' } } }, AUTH))
    assert.equal(refused.status, 403, 'unknown ownership is a refusal, never a guess')
    assert.equal(probes, 1)

    gate.finish()
    await list.done
  } finally { await server.stop() }
})

// ---- teardown hygiene -----------------------------------------------------------------

test('stream: the share-table listener is gone once the stream ends', async () => {
  const parts = makeParts('no-leak', { shared: ['session-a'] })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    parts.streams[0].finish()
    await open.done
    // A share AFTER the stream ended must synthesize nothing anywhere — and
    // must not throw into a dead response.
    parts.store.share('session-b')
    assert.equal(parts.handler.viewerCount('session-a'), 0, 'the viewer count was released too')
  } finally { await server.stop() }
})

// ---- T22b-fix: the ownership-probe race (reviewer's exp-race.cjs) ----------------------

test('race: an unshare during the ownership probe ends the job/follow with an unshared error', async () => {
  // The reviewer's repro, as a test: the job/list ownership probe hangs
  // until released; remote is closed WHILE it hangs. The unshared event
  // fires before any listener of this stream exists — the pre-open re-check
  // must catch the stale decision.
  let releaseProbe = () => {}
  const parts = makeParts('probe-race', {
    shared: ['S'],
    heartbeatMs: 60_000,
    overrides: {
      stream: (call, gate) => {
        if (call.namespace === 'job' && call.method === 'list') {
          releaseProbe = () => {
            gate.push({ type: 'rows', jobs: [{ id: 'j1', owner: 'S', kind: 'process', label: 'j1', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }] })
            gate.finish()
          }
        }
      },
    },
  })
  const server = await startServer(parts.handler)
  try {
    const openPromise = openStream(server, { namespace: 'job', method: 'follow', args: { request: { sessionId: 'S', jobId: 'j1' } } })
    await waitFor(() => parts.streams.length === 1, 'the ownership probe stream is open and pending')
    parts.store.unshare('S', 'manual')
    releaseProbe()

    const open = await openPromise
    assert.equal(open.status, 200, 'the headers were flushed before the re-check')
    await open.done
    assert.equal(open.lines.length, 1)
    assert.equal(open.lines[0].type, 'error')
    assert.equal(open.lines[0].error.code, 'unshared')
    assert.match(open.lines[0].error.message, /S/)
    // No follow gate ever opened, nothing kept pushing, no viewer stuck.
    assert.equal(parts.streams.length, 1, 'the upstream follow stream never opened')
    assert.equal(parts.handler.viewerCount('S'), 0, 'the viewer count was released')
  } finally { await server.stop() }
})

test('race: an unshare during the ownership probe refuses job/kill before forwarding', async () => {
  let releaseProbe = () => {}
  const parts = makeParts('probe-race-kill', {
    shared: ['S'],
    overrides: {
      stream: (call, gate) => {
        if (call.namespace === 'job' && call.method === 'list') {
          releaseProbe = () => {
            gate.push({ type: 'rows', jobs: [{ id: 'j1', owner: 'S', kind: 'process', label: 'j1', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }] })
            gate.finish()
          }
        }
      },
    },
  })
  const server = await startServer(parts.handler)
  try {
    const killPromise = server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'job', method: 'kill', args: { request: { sessionId: 'S', jobId: 'j1' } } }, AUTH))
    await waitFor(() => parts.streams.length === 1, 'the ownership probe is in flight')
    parts.store.unshare('S', 'manual')
    releaseProbe()

    const res = await killPromise
    assert.equal(res.status, 403, 'the stale allow is re-checked after the await')
    assert.deepEqual(await res.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(parts.invokeCalls.length, 0, 'the kill never reached the gateway')
  } finally { await server.stop() }
})

// ---- T22b-fix: closeAll on plugin row reload --------------------------------------------

test('closeAll: every open stream gets the server-restart line, upstreams abort, counts release', async () => {
  const parts = makeParts('close-all', { shared: ['S-a', 'S-b'], heartbeatMs: 60_000 })
  const server = await startServer(parts.handler)
  const opens = []
  try {
    const first = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'S-a' } } } })
    const second = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'S-b' } } } }, { ...AUTH, 'x-zen-remote-device': 'device-2' })
    opens.push(first, second)
    await waitFor(() => parts.streams.length === 2 && parts.handler.viewerCount('S-a') === 1 && parts.handler.viewerCount('S-b') === 1)

    parts.handler.closeAll('plugin row reloaded')
    await Promise.all([first.done, second.done])
    for (const [open, session] of [[first, 'S-a'], [second, 'S-b']]) {
      assert.deepEqual(open.lines, [{ type: 'error', error: { code: 'server-restart', message: 'plugin row reloaded' } }], session)
    }
    assert.equal(parts.streams[0].aborted, true, 'upstream 1 aborted')
    assert.equal(parts.streams[1].aborted, true, 'upstream 2 aborted')
    assert.equal(parts.handler.viewerCount('S-a'), 0)
    assert.equal(parts.handler.viewerCount('S-b'), 0)

    // A request that was still deciding when closeAll ran (or one that slips
    // in on a not-yet-deregistered route) reads the recorded reason at the
    // pre-open gate — nothing opens anymore.
    const late = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'S-a' } } } })
    await late.done
    assert.deepEqual(late.lines, [{ type: 'error', error: { code: 'server-restart', message: 'plugin row reloaded' } }])
    assert.equal(parts.streams.length, 2, 'no upstream opened after closeAll')
  } finally {
    for (const open of opens) open.req.destroy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await server.stop()
  }
})

// ---- T22b-fix: the ownership cache forgets unshared sessions ---------------------------

test('ownership cache: a session that left and rejoined the table starts from an empty cache', async () => {
  const JOB = (id, owner) => ({ id, owner, kind: 'process', label: id, status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } })
  const parts = makeParts('cache-cleanup', { shared: ['S'], overrides: { invoke: () => ({ killed: true }) } })
  const server = await startServer(parts.handler)
  try {
    const list = await openStream(server, { namespace: 'job', method: 'list', args: { request: { sessionId: 'S' } } })
    const gate = parts.streams[0]
    gate.push({ type: 'rows', jobs: [JOB('job-live', 'S')] })
    await waitFor(() => list.lines.length >= 1)
    gate.finish()
    await list.done

    // Unshare forgets the cached rows; re-sharing does not resurrect them —
    // the next ownership answer must come from a FRESH probe.
    parts.store.unshare('S', 'manual')
    parts.store.share('S')
    let probes = 0
    parts.gateway.stream = async (call) => {
      probes += 1
      if (call.namespace === 'job' && call.method === 'list') {
        return (async function* () { yield { type: 'rows', jobs: [] } })()
      }
      return makeGate(call).iterable
    }
    const kill = await server.fetch('/_dsh/zen-remote/relay/v1/invoke', post('/i', { namespace: 'job', method: 'kill', args: { request: { sessionId: 'S', jobId: 'job-live' } } }, AUTH))
    assert.equal(kill.status, 403, 'the stale cache entry is gone — the fresh probe refuses')
    assert.equal(probes, 1, 'the answer came from a probe, not the stale cache')
  } finally { await server.stop() }
})

// ---- T22b-fix: backpressure -------------------------------------------------------------

test('backpressure: the pump parks on a full socket and resumes in order after drain', async () => {
  const parts = makeParts('backpressure', { shared: ['session-a'], heartbeatMs: 60_000 })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    open.res.pause()
    const gate = parts.streams[0]
    const big = 'x'.repeat(2 * 1024 * 1024)
    const frame = (seq) => ({ type: 'event', event: { type: 'big', seq, time: seq, data: { pad: big } } })
    gate.push(frame(1))
    gate.push(frame(2))
    gate.push(frame(3))
    gate.finish()
    // Frame 1 exceeds every buffer on the path: its write must return false,
    // the pump must park on drain, and frames 2/3 must stay QUEUED — not
    // pulled, not buffered line-by-line.
    await waitFor(() => gate.queued >= 2)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(open.lines.length, 0, 'the paused client has parsed no complete line')
    assert.ok(gate.queued >= 2, `frames 2 and 3 are still queued (got ${gate.queued})`)

    open.res.resume()
    await open.done
    assert.deepEqual(
      open.lines.map((line) => line.frame?.event?.seq ?? line.type),
      [1, 2, 3, 'end'],
      'everything arrives, in order, after the drain',
    )
  } finally { await server.stop() }
})

// ---- T22b-fix: subagent reachability over parentOf ---------------------------------------

test('parentOf: a child streams through its shared parent and dies when the parent unshares', async () => {
  const parts = makeParts('child-of-parent', {
    shared: ['S-parent'],
    heartbeatMs: 60_000,
    parentOf: (id) => (id === 'S-child' ? 'S-parent' : undefined),
  })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'S-child' } } } })
    assert.equal(open.status, 200, 'the child borrows the parent share')
    const gate = parts.streams[0]
    gate.push({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    await waitFor(() => open.lines.length >= 1)

    // Closing the PARENT's remote must end the CHILD's stream: its claimed
    // id is only reachable through the chain the unshare just cut.
    parts.store.unshare('S-parent', 'manual')
    await open.done
    const errorLine = open.lines[open.lines.length - 1]
    assert.equal(errorLine.type, 'error')
    assert.equal(errorLine.error.code, 'unshared')
    assert.match(errorLine.error.message, /S-parent/)
    assert.equal(gate.aborted, true)
    assert.equal(parts.handler.viewerCount('S-child'), 0)
  } finally { await server.stop() }
})

// ---- T43-A: the finish drain watchdog --------------------------------------------

test('T43-A: a finish with a full buffer and a stopped reader destroys the response and releases the viewer', async () => {
  // The injected watchdog is 80ms: a viewer that never reads must lose its
  // stream (and its count) within milliseconds of the close, not pin the
  // count and the device budget forever.
  const parts = makeParts('t43-end-drain', { shared: ['session-a'], heartbeatMs: 60_000, endDrainTimeoutMs: 80 })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    const gate = parts.streams[0]
    // The client stops reading; a 2MB frame overflows every buffer on the
    // path and parks the pump mid-write (the same shape the backpressure
    // test drives).
    open.res.pause()
    const big = 'x'.repeat(2 * 1024 * 1024)
    const frame = (seq) => ({ type: 'event', event: { type: 'big', seq, time: seq, data: { pad: big } } })
    gate.push(frame(1))
    gate.push(frame(2))
    gate.push(frame(3))
    await waitFor(() => gate.queued >= 2)
    await new Promise((resolve) => setTimeout(resolve, 150))

    parts.handler.closeAll('t43 watchdog test')
    const started = Date.now()
    await waitFor(() => parts.handler.viewerCount('session-a') === 0, 2000)
    assert.ok(Date.now() - started < 1500, `the watchdog released the viewer promptly (took ${Date.now() - started} ms)`)
    assert.equal(gate.aborted, true, 'the upstream subscription was aborted')
    // NOTE: open.done is NOT awaited here — a paused client whose server
    // destroyed the socket sits half-open forever (its own buffered bytes
    // stay unread, so the client-side res never ends). The assertion target
    // is the SERVER side, and it released within the watchdog budget.
  } finally {
    // Nothing to drain: the client was never reading. The connections go
    // first, like every teardown here.
    await server.stop()
  }
})

test('T43-A: a finish with a READING client still ends normally with its tail line', async () => {
  // The watchdog arms only on a backed-up buffer; the ordinary close paths
  // must be untouched (the tail line arrives, the response ends cleanly).
  const parts = makeParts('t43-end-normal', { shared: ['session-a'], heartbeatMs: 60_000, endDrainTimeoutMs: 80 })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    const gate = parts.streams[0]
    gate.push({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    await waitFor(() => open.lines.length >= 1)
    gate.finish()
    await open.done
    assert.deepEqual(open.lines[open.lines.length - 1], { type: 'end' })
    assert.equal(parts.handler.viewerCount('session-a'), 0)
  } finally { await server.stop() }
})

// ---- T43-B: closeAll detaches the handler from the share table --------------------

test('T43-B: closeAll unsubscribes every share-table listener — table changes never reach the dead handler', async () => {
  const home = path.join(ROOT, 't43-table-detach')
  fs.mkdirSync(home, { recursive: true })
  const real = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  real.share('S')
  // A counting wrapper around the REAL store: the handler subscribes through
  // it, so `active` is exactly how many of this handler's listeners the table
  // still holds.
  const counts = { subscribed: 0, active: 0 }
  const store = {
    isAccessible: (id, parentOf) => real.isAccessible(id, parentOf),
    isShared: (id) => real.isShared(id),
    unshare: (id, reason) => real.unshare(id, reason),
    subscribe: (listener) => {
      counts.subscribed += 1
      counts.active += 1
      const off = real.subscribe(listener)
      return () => {
        counts.active -= 1
        off()
      }
    },
  }
  const fake = makeFakeGateway()
  const handler = createRelayHandler({
    secret: SECRET,
    store,
    gateway: fake.gateway,
    serverInfo: { serverId: loadServerId(home), serverName: () => 't43-b', dshVersion: '0.0.0-test' },
  })
  assert.equal(counts.active, 1, 'the handler holds one listener of its own (the ownership-cache sweeper)')

  // An open stream adds its own listener; ending it releases it again.
  const server = await startServer(handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'S' } } } })
    await waitFor(() => counts.subscribed === 2)
    fake.streams[0].finish()
    await open.done
    await waitFor(() => counts.active === 1)

    handler.closeAll('t43-b test')
    assert.equal(counts.active, 0, 'closeAll detached the handler from the table')

    // Share changes after the close are invisible to the dead handler —
    // and must not throw into it.
    real.share('S2')
    real.unshare('S2', 'manual')
    assert.equal(counts.active, 0)
    assert.equal(counts.subscribed, 2, 'no listener was re-registered')
  } finally { await server.stop() }
})

test('T43-fix: resuming before the watchdog still finishes the response cleanly (tail line + end)', async () => {
  // The closeWith watchdog now arms unconditionally and only `finish` or
  // `close` disarms it. A client that resumes reading INSIDE the budget
  // must get the tail line and a clean end — the queued error line
  // included — and the viewer count releases through the normal teardown.
  const parts = makeParts('t43-end-resume', { shared: ['session-a'], heartbeatMs: 60_000, endDrainTimeoutMs: 400 })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    const gate = parts.streams[0]
    open.res.pause()
    const big = 'x'.repeat(2 * 1024 * 1024)
    const frame = (seq) => ({ type: 'event', event: { type: 'big', seq, time: seq, data: { pad: big } } })
    gate.push(frame(1))
    gate.push(frame(2))
    gate.push(frame(3))
    await waitFor(() => gate.queued >= 2)
    parts.handler.closeAll('t43 resume test')

    // Back inside the 400ms budget, the client starts reading again.
    await new Promise((resolve) => setTimeout(resolve, 100))
    open.res.resume()
    await open.done
    const last = open.lines[open.lines.length - 1]
    assert.equal(last.type, 'error', 'the queued server-restart tail line arrived')
    assert.equal(last.error.code, 'server-restart')
    assert.equal(parts.handler.viewerCount('session-a'), 0)
  } finally { await server.stop() }
})

// ---- T34: the structured close reason ---------------------------------------------------

test('T34: the unshared error line carries reason idle (the automatic idle shutdown)', async () => {
  const parts = makeParts('t34-reason-idle', { shared: ['session-a'] })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    await waitFor(() => parts.streams.length === 1)
    parts.store.unshare('session-a', 'idle')
    await open.done
    const errorLine = open.lines[open.lines.length - 1]
    assert.equal(errorLine.type, 'error')
    assert.equal(errorLine.error.code, 'unshared')
    assert.equal(errorLine.error.reason, 'idle', 'the structured reason rides beside the message')
    assert.match(errorLine.error.message, /session-a/, 'the message stays')
  } finally { await server.stop() }
})

test('T34: the unshared error line carries reason client (closed from the desktop-client route)', async () => {
  const parts = makeParts('t34-reason-client', { shared: ['session-a'] })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    await waitFor(() => parts.streams.length === 1)
    const close = await server.fetch('/_dsh/zen-remote/relay/v1/unshare', post('/u', { sessionId: 'session-a' }, AUTH))
    assert.equal(close.status, 200)
    await open.done
    const errorLine = open.lines[open.lines.length - 1]
    assert.equal(errorLine.type, 'error')
    assert.equal(errorLine.error.code, 'unshared')
    assert.equal(errorLine.error.reason, 'client')
  } finally { await server.stop() }
})

test('T34: the unshared error line carries reason manual (server-side close)', async () => {
  const parts = makeParts('t34-reason-manual', { shared: ['session-a'] })
  const server = await startServer(parts.handler)
  try {
    const open = await openStream(server, { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } })
    await waitFor(() => parts.streams.length === 1)
    parts.store.unshare('session-a', 'manual')
    await open.done
    const errorLine = open.lines[open.lines.length - 1]
    assert.equal(errorLine.type, 'error')
    assert.equal(errorLine.error.code, 'unshared')
    assert.equal(errorLine.error.reason, 'manual')
  } finally { await server.stop() }
})

test('T34: the pre-open gate (no event observed) degrades to reason manual', async () => {
  // The probe-race shape: the session leaves the table while the request is
  // still inside its ownership probe — no share-table listener existed yet,
  // so the pre-open re-check closes the stream. No event means no certain
  // reason: it reads as the manual close.
  let releaseProbe = () => {}
  const parts = makeParts('t34-reason-gate', {
    shared: ['S'],
    heartbeatMs: 60_000,
    overrides: {
      stream: (call, gate) => {
        if (call.namespace === 'job' && call.method === 'list') {
          releaseProbe = () => {
            gate.push({ type: 'rows', jobs: [{ id: 'j1', owner: 'S', kind: 'process', label: 'j1', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }] })
            gate.finish()
          }
        }
      },
    },
  })
  const server = await startServer(parts.handler)
  try {
    const openPromise = openStream(server, { namespace: 'job', method: 'follow', args: { request: { sessionId: 'S', jobId: 'j1' } } })
    await waitFor(() => parts.streams.length === 1)
    parts.store.unshare('S', 'idle')
    releaseProbe()
    const open = await openPromise
    await open.done
    assert.equal(open.lines.length, 1)
    assert.equal(open.lines[0].type, 'error')
    assert.equal(open.lines[0].error.code, 'unshared')
    assert.equal(open.lines[0].error.reason, 'manual', 'an eventless closure reads manual')
  } finally { await server.stop() }
})
