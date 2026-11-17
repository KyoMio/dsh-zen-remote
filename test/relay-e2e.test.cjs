'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { createRelayHandler, loadServerId } = require('../lib/relay-server.js')
const { createShareStore } = require('../lib/share-store.js')
const { createRelayPool } = require('../lib/relay-pool.js')
const { RelayError } = require('../lib/relay-client.js')
const { createClientHandler } = require('../lib/client-routes.js')
const { installIntercept } = require('../lib/intercept.js')
const { installFetchRouteIntercept, FILE_UPLOAD_PATH, SESSION_EXPORT_PATH } = require('../lib/fetch-route-intercept.js')
const { toVirtual } = require('../lib/virtual-id.js')
const { startGatewayAt, request, pairDesktop, stopAll } = require('./util.cjs')
const {
  SECRET,
  SERVER_NAME,
  FOLLOW_ARGS,
  makeGate,
  makeEventsGate,
  makeLocalGate,
  LocalMergeGateway,
  LocalEventsGateway,
  BareGateway,
  fakeClock,
  createE2eHarness,
  waitFor,
  collect,
  collectFrames,
  sleep,
} = require('./helpers/relay-e2e-harness.cjs')

const harness = createE2eHarness('dsh-zen-remote-relay-e2e-')
const ROOT = harness.ROOT
test.before(() => harness.start())
test.after(() => harness.stop())
const boot = (opts) => harness.boot(opts)
const bootIsolated = (opts) => harness.bootIsolated(opts)

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

test('e2e: workspaceFiles/readBytes rides the JSON relay as a base64 marker (2026-10-14 fix)', async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 200])
  const env = await boot({
    shared: ['session-a'],
    invoke: (call) => {
      if (call.namespace === 'workspaceFiles' && call.method === 'readBytes') return { data: bytes, path: 'pic.png' }
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
  })
  try {
    await env.client.connect()
    // The relay CLIENT sees the wire shape: the server half marked the typed
    // array (invoke-binary.ts) because JSON.stringify would have collapsed it
    // into a plain object the caller-side zod rejects. The intercept half
    // (tested in intercept.test.cjs) restores it above this layer.
    const value = await env.client.invoke('workspaceFiles', 'readBytes', { workspaceFileScopeId: 'session-a', path: 'pic.png' })
    assert.equal(value.path, 'pic.png')
    assert.equal(typeof value.data['$zr-u8'], 'string', 'the typed array traveled as the base64 marker')
    assert.deepEqual(Array.from(Buffer.from(value.data['$zr-u8'], 'base64')), Array.from(bytes), 'the bytes round-tripped exactly')
  } finally { await env.stop() }
})

test('e2e: officeToPdf/render is a shared-session read whose PDF bytes ride the binary marker (2.2.6)', async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 254, 255])
  const env = await boot({
    shared: ['session-a'],
    invoke: (call) => {
      if (call.namespace === 'officeToPdf' && call.method === 'render') {
        return { data: pdf, eof: true, absolutePath: '/srv/a/report.docx', version: 'v1', missingFonts: [] }
      }
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
  })
  try {
    await env.client.connect()
    const value = await env.client.invoke('officeToPdf', 'render', {
      workspaceFileScopeId: 'session-a',
      path: 'report.docx',
      priority: 'foreground',
    })
    assert.equal(value.absolutePath, '/srv/a/report.docx')
    assert.equal(typeof value.data['$zr-u8'], 'string', 'the PDF typed array traveled as the base64 marker')
    assert.deepEqual(Array.from(Buffer.from(value.data['$zr-u8'], 'base64')), Array.from(pdf), 'the bytes round-tripped exactly')

    // The registry discipline: the session field is the ONLY authorization,
    // so an unshared scope is refused before the fake gateway sees the call.
    const before = env.invokeCalls.length
    await assert.rejects(
      () => env.client.invoke('officeToPdf', 'render', { workspaceFileScopeId: 'session-secret', path: 'x.docx' }),
      (error) => error instanceof RelayError && error.code === 'not-shared',
    )
    assert.equal(env.invokeCalls.length, before, 'the unshared conversion never ran on the host')
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
  const env = await boot({ shared: ['session-a'], heartbeatMs: 60 })
  try {
    const patient = env.tunedClient({ idleTimeoutMs: 110, requestTimeoutMs: 30 })
    await patient.connect()
    const stream = patient.openStream('session', 'follow', FOLLOW_ARGS)
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await waitFor(() => env.streams.length === 1)
    const gate = env.streams[0]
    await sleep(160)
    const verdict = await Promise.race([
      pending.then(() => 'ended', (error) => `errored:${error.code}`),
      sleep(20).then(() => 'open'),
    ])
    assert.equal(verdict, 'open', 'the stream survived the silent window on pings alone')
    gate.finish()
    const done = await pending
    assert.equal(done.done, true)
    assert.equal(patient.state, 'online')

    const impatient = env.tunedClient({ idleTimeoutMs: 20 })
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
  const env = await bootIsolated({ shared: ['session-a'], invoke: () => ({ page: 'ok' }) })
  try {
    await env.client.connect()
    assert.equal(env.client.state, 'online')
    const action = await request(env.gwPort, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id: env.deviceId } })
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
  const env = await bootIsolated({ shared: ['session-a'], invoke: () => ({ page: 'ok', n: 1 }) })
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
  const env = await bootIsolated({ shared: ['session-a'], invoke: () => ({ page: 'ok' }) })
  try {
    const clock = fakeClock()
    const client = env.tunedClient({ clock, infoRefreshMs: 0 })
    await client.connect()
    assert.equal(client.state, 'online')

    await env.killGateway()
    await assert.rejects(() => client.invoke('session', 'page', FOLLOW_ARGS), (error) => error.code === 'offline')
    assert.equal(client.state, 'offline')
    assert.ok(client.nextRetryAt !== null, 'a retry is armed')
    assert.ok(client.nextRetryAt - clock.now() <= 1200, 'the first wait is the 1s step (+ jitter)')

    const hitsBefore = env.getProxyHits()
    clock.advance(1200)
    await waitFor(() => env.getProxyHits() > hitsBefore && client.state === 'offline', 5000)
    assert.equal(client.state, 'offline', 'the gateway is still down — the retry failed into offline again')
    assert.equal(client.lastError, 'offline')

    await env.restartGateway()
    await waitFor(() => clock.pending === 1)
    clock.advance(2500)
    await waitFor(() => client.state === 'online', 5000)
    assert.equal(client.nextRetryAt, null)
    assert.equal(client.lastError, undefined)
    const value = await client.invoke('session', 'page', FOLLOW_ARGS)
    assert.deepEqual(value, { page: 'ok' })
  } finally { await env.stop() }
})

test('e2e T43: a device revoked while the client is in the retry loop lands revoked and the client goes silent', async () => {
  const env = await bootIsolated({ shared: ['session-a'], invoke: () => ({ page: 'ok' }) })
  try {
    const clock = fakeClock()
    const client = env.tunedClient({ clock, infoRefreshMs: 0 })
    await client.connect()
    const action = await request(env.gwPort, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id: env.deviceId } })
    assert.equal(action.status, 200)
    await env.killGateway()
    await assert.rejects(() => client.invoke('session', 'page', FOLLOW_ARGS), (error) => error.code === 'offline')
    assert.equal(client.state, 'offline')

    await env.restartGateway()
    await waitFor(() => clock.pending === 1)
    clock.advance(1200)
    await waitFor(() => client.state === 'revoked', 5000)
    assert.equal(client.nextRetryAt, null, 'revoked cancels the ladder')

    const quiet = env.getProxyHits()
    clock.advance(60_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(clock.pending, 0)
    assert.equal(env.getProxyHits(), quiet, 'not one request after the revocation wall')
  } finally { await env.stop() }
})

// ---- 9. T23b-2: the sub-client interceptor merges the GLOBAL workspace stream ----

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
    const remote = await collectFrames(iterator, 5)
    // The server only shares session-a, so the remote groups show only what
    // is shared: w-1 carries ONE virtual session despite two server-side, and
    // w-2 forwards with an empty sessionIds list (unshared session-c stripped)
    // so new sessions can still target any workspace on connected nodes;
    // titles carry the server name; and the UI never sees a second baseline.
    assert.deepEqual(remote[0].workspace, { ...SERVER_W1, workspaceId: V('w-1'), title: `${SERVER_NAME} · 服务端一`, sessionIds: [V('session-a')] })
    assert.deepEqual(remote[1].workspace, { ...SERVER_W2, workspaceId: V('w-2'), title: `${SERVER_NAME} · 服务端二`, sessionIds: [] })
    assert.deepEqual(remote[2], { type: 'order', workspaceIds: ['ws-local', V('w-1'), V('w-2')] })
    assert.ok(remote.every((frame) => frame.type !== 'baseline'))

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
    await new Promise((resolve) => setImmediate(resolve))
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
    await new Promise((resolve) => setImmediate(resolve))
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

// ---- T75: the running-status emit, end to end ------------------------------------

test('e2e T75: a shared session (and its child) running-status emit crosses virtualized; unshared, malformed, and other emits never leave the server', async () => {
  const env = await boot({
    shared: ['session-parent'],
    parentOf: (id) => (id === 'session-child' ? 'session-parent' : undefined),
  })
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
    localGate.push({ type: 'ready', clientId: 'local-ui-client', host: { home: '/local/home' } })
    const [ready] = await collectFrames(iterator, 1)
    assert.deepEqual(ready, { type: 'ready', clientId: 'local-ui-client', host: { home: '/local/home' } })
    await waitFor(() => env.eventsGates.length === 1)

    // The shared session's status emit crosses the real chain virtualized —
    // and so does a CHILD session's: isAccessible walks the parent chain,
    // the same rule the waterfalls are judged by.
    env.eventsGates[0].push({ type: 'emit', event: 'api-session/status', args: ['session-parent', true] })
    env.eventsGates[0].push({ type: 'emit', event: 'api-session/status', args: ['session-child', false] })
    const crossing = await collectFrames(iterator, 2)
    assert.deepEqual(crossing, [
      { type: 'emit', event: 'api-session/status', args: [V('session-parent'), true] },
      { type: 'emit', event: 'api-session/status', args: [V('session-child'), false] },
    ])

    // Everything else is dropped server-side — the proof is ORDERED: the
    // next frame to cross the in-order stream is the known-good one pushed
    // last, so nothing before it can have slipped through. Unshared status,
    // the malformed shapes (extra key, args[1] not boolean, args length 3),
    // and any other emit all die at the relay.
    env.eventsGates[0].push({ type: 'emit', event: 'api-session/status', args: ['session-secret', true] })
    env.eventsGates[0].push({ type: 'emit', event: 'api-session/status', args: ['session-parent', true, 'extra'] })
    env.eventsGates[0].push({ type: 'emit', event: 'api-session/status', args: ['session-parent', 'yes'] })
    env.eventsGates[0].push({ type: 'emit', event: 'api-session/status', args: ['session-parent', true], extra: 1 })
    env.eventsGates[0].push({ type: 'emit', event: 'api-session/added', args: [{ sessionId: 'session-parent', title: '服务端会话' }] })
    env.eventsGates[0].push({ type: 'emit', event: 'api-session/status', args: ['session-parent', false] })
    const afterJunk = await collectFrames(iterator, 1)
    assert.deepEqual(afterJunk, [{ type: 'emit', event: 'api-session/status', args: [V('session-parent'), false] }])

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
    // The 7th open argument (DSH 0.2.1-alpha.3+, named `window` in the real
    // wire adapter's source) rides through, exactly like production.
    this.wireTap = (endpoint, payload, uplink, peer, signal, control, window) =>
      this.openWireStream(endpoint, payload, uplink, peer, control.signal, control, window)
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
    // The catalog fetch is fire-and-forget, so it can land either side of
    // the create: wait for both and pick the create by method, not position.
    await waitFor(() => env.invokeCalls.length >= 2)
    assert.equal(env.invokeCalls.length, 2)
    const createCall = env.invokeCalls.find((call) => call.namespace === 'terminal' && call.method === 'create')
    assert.deepEqual(createCall.args, { agentId: 'session-a', request: { id: 'term-e2e', cols: 80, rows: 24 } }, 'the ORIGINAL session id reached the server')

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

// ---- TA-2: the terminal/attach duplex stream end to end ----------------------------

/**
 * TA-2: a stand-in for the host's UplinkInbox (DSH 0.2.2 TerminalInput): the
 * test pushes write/resize commands in and the relay client's pump carries
 * them to the server through `/v1/stream-uplink`. Records whether `return()`
 * was called — the pump's teardown releases the host inbox when the stream
 * dies, the interceptor must NOT have released it at open time.
 */
function createAttachUplink() {
  const pending = []
  let wake = () => {}
  let finished = false
  let returnCalled = false
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          while (pending.length === 0 && !finished) {
            await new Promise((resolve) => { wake = resolve })
          }
          if (pending.length > 0) return { value: pending.shift(), done: false }
          return { value: undefined, done: true }
        },
        return: async () => {
          returnCalled = true
          finished = true
          wake()
          return { value: undefined, done: true }
        },
      }
    },
    push: (frame) => { pending.push(frame); wake() },
    get returnCalled() { return returnCalled },
  }
}

test('e2e TA-2: terminal/create + terminal/attach duplex stream through the sub-client, unshare kills it with unshared', async () => {
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

    // The PTY is created SERVER-side (same as the follow test).
    const created = await localGateway.rpcBridge('terminal/create', { args: { agentId: V('session-a'), request: { id: 'term-e2e', cols: 80, rows: 24 } } }, undefined, undefined)
    assert.equal(created.ok, true)
    await waitFor(() => env.invokeCalls.some((call) => call.namespace === 'terminal' && call.method === 'create'))

    // The duplex attach: the host inbox and its mux window ride through the
    // interceptor (virtual agentId restored) and the relay client's pump
    // (`uplink: true` in the open body) to the relay server, which hands the
    // gateway a bounded queue and answers the handshake line.
    const uplink = createAttachUplink()
    const uplinkWindow = { maxBytes: 8192, frameOverheadBytes: 32 }
    const stream = await localGateway.wireTap('terminal/attach', { args: { agentId: V('session-a'), id: 'term-e2e', attachmentId: 'att-e2e' } }, uplink, undefined, undefined, { signal: undefined }, uplinkWindow)
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await waitFor(() => env.streams.some((gate) => gate.call.namespace === 'terminal' && gate.call.method === 'attach'))
    const gate = env.streams.find((item) => item.call.namespace === 'terminal')
    assert.deepEqual(gate.call.args, { agentId: 'session-a', id: 'term-e2e', attachmentId: 'att-e2e' }, 'the ORIGINAL session id reached the server')
    assert.equal(typeof gate.call.uplink?.[Symbol.asyncIterator], 'function', 'the gateway got the bounded uplink queue')
    assert.deepEqual(gate.call.uplinkWindow, uplinkWindow, 'the advertised window rode through verbatim')

    // Consume the queue the way the host's attach implementation would.
    const received = []
    let consumeDone = false
    const consume = (async () => {
      for await (const item of gate.call.uplink) received.push(item)
      consumeDone = true
    })()

    // Down: the opening snapshot survives the whole chain, window intact.
    gate.push({ type: 'snapshot', sequence: 0, screen: '$ ', writable: true, inputWindow: uplinkWindow, info: { id: 'term-e2e', title: 'zsh', cols: 80, rows: 24, state: 'running', exitCode: null } })
    const first = await pending
    assert.equal(first.value.type, 'snapshot')
    assert.equal(first.value.writable, true)
    assert.deepEqual(first.value.inputWindow, uplinkWindow)

    // Up: a write and a resize land on the server IN ORDER, through the
    // single-flight batching pump.
    uplink.push({ type: 'write', sequence: 1, data: 'pwd\n' })
    uplink.push({ type: 'resize', sequence: 2, cols: 120, rows: 40 })
    await waitFor(() => received.length >= 2)
    assert.deepEqual(received, [
      { type: 'write', sequence: 1, data: 'pwd\n' },
      { type: 'resize', sequence: 2, cols: 120, rows: 40 },
    ])

    // Down: the server's answers ride back in order.
    gate.push({ type: 'ack', sequence: 1 })
    gate.push({ type: 'output', sequence: 1, data: '/srv\r\n' })
    gate.push({ type: 'ack', sequence: 2 })
    const answers = []
    for (let i = 0; i < 3; i += 1) answers.push((await iterator.next()).value)
    assert.deepEqual(answers, [
      { type: 'ack', sequence: 1 },
      { type: 'output', sequence: 1, data: '/srv\r\n' },
      { type: 'ack', sequence: 2 },
    ])

    // Closing the session's remote access kills the attach with the SAME
    // unshared end every session-scoped stream gets; the pump releases the
    // host inbox and the server-side queue consumer finishes.
    env.store.unshare('session-a', 'manual')
    let thrown
    try { await iterator.next() } catch (error) { thrown = error }
    assert.ok(thrown instanceof Error && thrown.code === 'unshared', `expected unshared, got: ${thrown}`)
    assert.equal(thrown.isDSHRemoteError, true, 'the code survives the host wire because the error is marked')
    await waitFor(() => gate.aborted)
    await waitFor(() => consumeDone)
    await waitFor(() => uplink.returnCalled)
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

test('e2e T73: an idle sweep closing the open page and another session leaves the page silent under its banner', async () => {
  // The 2026-09-30 repro: A (the open page) and B shared, one idle sweep
  // closes both, and page A showed 「历史加载失败：shared session <B> was
  // unshared (idle)（unshared）」 over its history. 'session-other' sorts
  // first, so B's closure is announced first. The page keeps what it
  // shows — no stream error, no end — while its own closure reaches the
  // banner's registry; only the page closing the stream ends it.
  const env = await boot({ shared: ['session-page', 'session-other'] })
  try {
    const info = await env.client.connect()
    const virtual = toVirtual(info.serverId, 'session-page')
    const controller = new AbortController()
    const localGateway = new LocalMergeGateway(makeLocalGate(controller.signal))
    const handle = installIntercept({
      raw: localGateway,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
      log: () => {},
    })
    const page = (await localGateway.wireTap(
      'session/follow',
      { args: { request: { address: { kind: 'session', sessionId: virtual } } } },
      undefined,
      localGateway.operatorPeer(),
      controller.signal,
      { signal: controller.signal },
    ))[Symbol.asyncIterator]()
    // The history arrives first: the page shows content when the sweep hits.
    const first = page.next()
    await waitFor(() => env.streams.length === 1)
    env.streams[0].push({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    assert.equal((await first).value.event.type, 'turn/start')

    env.store.setIdleHours(1e-9)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(env.store.sweep(), ['session-other', 'session-page'])
    const next = page.next().then((result) => ({ result }), (error) => ({ error }))
    await waitFor(() => env.streams[0].aborted)
    await waitFor(() => handle.diagnostics().closedSessions.length === 1)
    assert.deepEqual(handle.diagnostics().closedSessions, [{ sessionId: virtual, reason: 'idle' }], 'the banner learns the closure and its reason')
    // A TIME-WINDOW judgment, not a barrier: a failure would surface on the
    // very next iterator tick, so 300ms of silence is the evidence the hold
    // is quiet — no fixed bound can prove a negative.
    const verdict = await Promise.race([next, sleep(100).then(() => 'silent')])
    assert.equal(verdict, 'silent', `the page stream must neither fail nor end, got: ${verdict.error?.message ?? JSON.stringify(verdict)}`)

    controller.abort()
    assert.deepEqual(await next, { result: { value: undefined, done: true } }, 'the page closing the stream ends it cleanly')
    handle.uninstall()
  } finally { await env.stop() }
})

test('e2e T73-fix: a re-enabled remote ends the quiet history hold so the host reopens it with fresh history', async () => {
  const env = await boot({
    shared: ['session-page', 'session-other'],
    invoke: (call) => {
      if (call.namespace === 'session' && call.method === 'page') {
        return { events: [{ type: 'turn/start', seq: 9, time: 9, data: {} }], seq: 9 }
      }
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
  })
  try {
    const info = await env.client.connect()
    const virtual = toVirtual(info.serverId, 'session-page')
    const controller = new AbortController()
    const localGateway = new LocalMergeGateway(makeLocalGate(controller.signal))
    const handle = installIntercept({
      raw: localGateway,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
      log: () => {},
    })
    const page = (await localGateway.wireTap(
      'session/follow',
      { args: { request: { address: { kind: 'session', sessionId: virtual } } } },
      undefined,
      localGateway.operatorPeer(),
      controller.signal,
      { signal: controller.signal },
    ))[Symbol.asyncIterator]()
    const first = page.next()
    await waitFor(() => env.streams.length === 1)
    env.streams[0].push({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    assert.equal((await first).value.event.type, 'turn/start')

    // the sweep closes the page's remote: the stream goes quiet under its banner
    env.store.setIdleHours(1e-9)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(env.store.sweep(), ['session-other', 'session-page'])
    const next = page.next().then((result) => ({ result }), (error) => ({ error }))
    await waitFor(() => handle.diagnostics().closedSessions.length === 1)
    const quiet = await Promise.race([next, sleep(100).then(() => 'silent')])
    assert.equal(quiet, 'silent', 'the hold is quiet while the closure stands')

    // The host RE-ENABLES the remote (the sweep had closed it): the session
    // is shared again. The user keeps working through the still-enabled
    // composer — the forwarded single call now succeeds on the server,
    // which clears the closed-session record. The quiet hold ENDS cleanly:
    // this is exactly the accepted-generation clean end the host answers by
    // reopening the stream with a fresh history, so the re-enabled remote
    // comes back.
    env.store.share('session-page')
    const payload = { args: { request: { address: { kind: 'session', sessionId: virtual }, seq: 0 } } }
    const call = await localGateway.rpcBridge('session/page', payload, controller.signal, undefined)
    assert.equal(call.ok, true)
    const settled = await next
    assert.deepEqual(settled, { result: { value: undefined, done: true } }, 'the cleared record ends the hold; the host reopens the stream')

    // no waiter leaks: a further successful call (nothing held anymore) is a
    // plain success, and the page abort is uneventful.
    const again = await localGateway.rpcBridge('session/page', payload, controller.signal, undefined)
    assert.equal(again.ok, true)
    controller.abort()
    handle.uninstall()
  } finally { await env.stop() }
})

test('e2e T73-fix: the quiet close is a session/follow rule — a panel stream with a real signal still ends with 远程已关闭', async () => {
  const env = await boot({
    shared: ['session-a'],
    invoke: (call) => {
      if (call.namespace === 'terminal' && call.method === 'create') {
        return { id: call.args.request.id, title: 'zsh', shell: { path: '/bin/zsh', args: [], name: 'zsh' }, cwd: '/srv', cols: call.args.request.cols, rows: call.args.request.rows, state: 'running', exitCode: null }
      }
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
  })
  try {
    const info = await env.client.connect()
    const localGateway = new LocalTerminalGateway()
    const handle = installIntercept({
      raw: localGateway,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
      log: () => {},
    })
    await localGateway.rpcBridge('terminal/create', { args: { agentId: toVirtual(info.serverId, 'session-a'), request: { id: 'term-e2e', cols: 80, rows: 24 } } }, undefined, undefined)

    // A REAL signal this time — the earlier panel tests all passed
    // `signal: undefined`, which short-circuits the endpoint check and would
    // have hidden a regression that made panel streams hold too.
    const controller = new AbortController()
    const stream = await localGateway.wireTap('terminal/follow', { args: { agentId: toVirtual(info.serverId, 'session-a'), id: 'term-e2e', attachmentId: 'att-e2e' } }, undefined, undefined, controller.signal, { signal: controller.signal })
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await waitFor(() => env.streams.some((gate) => gate.call.namespace === 'terminal' && gate.call.method === 'follow'))
    const gate = env.streams.find((item) => item.call.namespace === 'terminal')
    gate.push({ type: 'snapshot', sequence: 0, screen: '$ ', info: { id: 'term-e2e', title: 'zsh', cols: 80, rows: 24, state: 'running', exitCode: null } })
    const first = await pending
    assert.equal(first.value.type, 'snapshot')

    // the remote closes after the first frame: the panel stream ends with
    // the banner's verdict — never a silent hold (that is session/follow only)
    env.store.unshare('session-a', 'manual')
    let thrown
    try { await iterator.next() } catch (error) { thrown = error }
    assert.ok(thrown instanceof Error && thrown.code === 'unshared', `expected unshared, got: ${thrown}`)
    assert.equal(thrown.message, '远程已关闭')
    assert.equal(thrown.isDSHRemoteError, true, 'the code survives the host wire')
    await waitFor(() => gate.aborted)
    controller.abort()
    handle.uninstall()
  } finally { await env.stop() }
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

// ---- details passthrough (2026-10-10) ----------------------------------------

// The host rejects an image-bearing prompt with `session/attachment-invalid`
// whose details.reason is what the client UI maps onto a user-facing line
// ("The current model does not support images…"). Every hop must carry it:
// server errorOf → wire envelope → client RelayError → the interceptor's
// UI envelope. Dropped anywhere, the UI prints `undefined` (real report).
test('e2e: a host error details.reason crosses the whole chain into the UI envelope', async () => {
  const env = await boot({
    shared: ['session-a'],
    invoke: (call) => {
      throw Object.assign(new Error('当前模型不支持图片'), {
        code: 'session/attachment-invalid',
        details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES', count: 1, nested: { x: 1 }, ok: true },
      })
    },
  })
  try {
    const info = await env.client.connect()
    const gateway = new BareGateway()
    const handle = installIntercept({ raw: gateway, relay: env.client, getServerId: () => info.serverId, log: () => {} })
    const envelope = await gateway.rpcBridge('session/prompt', {
      args: { request: { sessionId: toVirtual(info.serverId, 'session-a'), content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] } },
    }, undefined, gateway.operatorPeer())
    assert.equal(envelope.ok, false)
    assert.equal(envelope.error.code, 'session/attachment-invalid')
    assert.equal(envelope.error.message, '当前模型不支持图片')
    // Scalars ride, nested objects are stripped by the server sanitizer.
    assert.deepEqual(envelope.error.details, { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES', count: 1, ok: true })
    handle.uninstall()
  } finally { await env.stop() }
})




// ---- MS-9: two main servers, one sub-client (the multi-server E2E) ------------

/**
 * One INDEPENDENT main-server stack for the multi-server tests: the same
 * pieces boot() assembles (fake DSH service → real gateway child → proxy hop
 * with forwarded headers → paired desktop device), but with its OWN proxy,
 * ports and home — two of these run side by side, so nothing here may touch
 * the module-global single-server fixture above (gwPort / proxy / proxyPort).
 * `sessionListAnswer` / `pageAnswer` are mutable so the test can script the
 * fake DSH service AFTER it knows which stack pairs first.
 */
let stackCounter = 0
async function bootStack(opts = {}) {
  const { serverName = 'MS9服务器', invoke } = opts
  const home = path.join(ROOT, `stack-${stackCounter++}`)
  fs.mkdirSync(home, { recursive: true })
  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  const invokeCalls = []
  const streams = []
  const eventsGates = []
  const eventResults = []
  const env = { home, store, invokeCalls, streams, eventsGates, eventResults, serverName, sessionListAnswer: { items: [] } }
  const gateway = {
    invoke: async (call) => {
      invokeCalls.push(call)
      // The proactive per-entry catalog fetch (T52-fix3) answers here, like
      // boot()'s fake does; session/list is scriptable per stack through
      // env.sessionListAnswer (the merge route and the summary sync both ride it).
      if (call.namespace === 'session' && call.method === 'modelCatalog') {
        return { default: null, routableProviders: [], groups: [], failures: [] }
      }
      if (call.namespace === 'session' && call.method === 'list') return env.sessionListAnswer
      if (invoke !== undefined) return invoke(call)
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
    stream: async (call) => {
      const gate = makeGate(call)
      streams.push(gate)
      return gate.iterable
    },
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
  const handler = createRelayHandler({
    secret: SECRET,
    store,
    gateway,
    serverInfo: {
      serverId: loadServerId(home),
      serverName: () => serverName,
      dshVersion: '0.0.0-e2e',
    },
  })
  const target = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } }) })
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
  const targetPort = target.address().port

  // THIS stack's public-internet hop: forwarded headers play the reverse
  // proxy, so the pool's client counts as a remote desktop device.
  let gwPort = 0
  const proxyServer = http.createServer((req, res) => {
    const headers = { ...req.headers, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }
    delete headers.connection
    delete headers['keep-alive']
    let upstream
    res.on('close', () => { try { if (upstream !== undefined) upstream.destroy() } catch { /* gone */ } })
    upstream = http.request({ host: '127.0.0.1', port: gwPort, method: req.method, path: req.url, headers }, (upRes) => {
      const out = { ...upRes.headers }
      delete out['transfer-encoding']
      delete out.connection
      delete out['keep-alive']
      res.writeHead(upRes.statusCode || 502, out)
      res.flushHeaders()
      upRes.pipe(res)
    })
    upstream.on('error', () => {
      try { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }) } catch { /* gone */ }
      try { res.end() } catch { /* gone */ }
    })
    req.pipe(upstream)
  })
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
  env.proxyPort = proxyServer.address().port

  const gw = startGatewayAt(home, 0, targetPort, { LAN_GATE_RELAY_SECRET: SECRET })
  gwPort = await gw.ready
  const paired = await pairDesktop(gwPort, 'MS9台式机')
  env.serverId = loadServerId(home)
  env.token = paired.token
  env.deviceId = paired.id
  env.stop = async () => {
    handler.closeAll('e2e teardown')
    await stopAll({ close: (done) => { target.closeAllConnections(); target.close(done) } }, gw.child)
    await new Promise((resolve) => { proxyServer.closeAllConnections(); proxyServer.close(resolve) })
  }
  return env
}

/** The REAL pool over one state file, with the intercept's pool hub wired
 * through a mutable ref (the handle does not exist at pool creation — the
 * same ordering src/index.ts lives with). */
function makePool(stateFile) {
  const wiring = { notePoolEvent: () => {} }
  const pool = createRelayPool({
    stateFile,
    computeOwnFingerprints: () => ({}),
    onStateChange: () => wiring.notePoolEvent(),
    onServerRemoved: () => wiring.notePoolEvent(),
  })
  return { pool, wiring }
}

/** The client routes (createClientHandler, pool mode) on a plain port, the
 * same composition the CLIENT role's mount serves. */
async function startClientRouteServer(pool, getIntercept) {
  const handler = createClientHandler({
    admit: () => ({}),
    getRowConfig: () => ({}),
    pool,
    ...(getIntercept !== undefined ? { getIntercept } : {}),
  })
  const server = http.createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const stop = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
  return { port, stop }
}

/** Post one same-origin JSON body to a client route. */
function postRoute(port, route, body) {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify(body),
  })
}

/** Drain a merged stream into an array forever — the tolerant way to consume
 * a stream that carries background noise (the summary/status sync frames)
 * while the test waits for ONE specific frame. */
async function drainInto(iterator, sink) {
  try {
    for (;;) {
      const result = await iterator.next()
      if (result.done === true) break
      sink.push(result.value)
    }
  } catch { /* the abort path ends here */ }
}

test('e2e MS-9: two main servers pair into one sub-client — the sidebar merges in PAIRING order with -1/-2 names, session/list follows, and unpairing one leaves the other serving', async () => {
  const MS9_NAME = 'MS9同名服务器'
  // Both stacks report the SAME server name: only the -1/-2 derivation can
  // disambiguate the two sidebar groups.
  const stackOne = await bootStack({ serverName: MS9_NAME })
  const stackTwo = await bootStack({ serverName: MS9_NAME })
  const stateFile = path.join(ROOT, `pool-merge-${stackCounter}.json`)
  const { pool, wiring } = makePool(stateFile)
  let first
  let second
  try {
    // Pair the HIGHER serverId first on purpose: the merged order can then
    // never be explained by id sorting — only by pairing order.
    ;[first, second] = stackOne.serverId > stackTwo.serverId ? [stackOne, stackTwo] : [stackTwo, stackOne]
    first.sessionListAnswer = { items: [{ sessionId: 's1a', title: '甲会话', updatedAt: 1 }] }
    second.sessionListAnswer = { items: [{ sessionId: 's2a', title: '乙会话', updatedAt: 1 }] }
    first.store.share('s1a')
    second.store.share('s2a')
    const V1 = (id) => toVirtual(first.serverId, id)
    const V2 = (id) => toVirtual(second.serverId, id)

    const pairedFirst = await pool.pair({
      serverUrl: `http://127.0.0.1:${first.proxyPort}`,
      token: first.token,
      deviceId: first.deviceId,
      deviceName: 'MS9台式机',
    })
    assert.equal(pairedFirst.ok, true)
    await waitFor(() => pool.entries().length === 1 && pool.entries()[0].client.state === 'online')
    assert.equal(pool.entries()[0].serverId, first.serverId)
    const pairedSecond = await pool.pair({
      serverUrl: `http://127.0.0.1:${second.proxyPort}`,
      token: second.token,
      deviceId: second.deviceId,
      deviceName: 'MS9台式机',
    })
    assert.equal(pairedSecond.ok, true)
    await waitFor(() => pool.entries().length === 2 && pool.entries()[1].client.state === 'online')
    await waitFor(() => pool.entries()[1].serverId === second.serverId)
    // Duplicate names number in PAIRING order.
    assert.deepEqual(pool.entries().map((entry) => entry.displayName), [`${MS9_NAME}-1`, `${MS9_NAME}-2`])

    // The sub-client half: a controllable local gateway + the POOL install,
    // with the pool hub wired like index.ts wires it.
    const controller = new AbortController()
    const localGate = makeLocalGate(controller.signal)
    const localGateway = new LocalMergeGateway(localGate)
    const handle = installIntercept({ raw: localGateway, pool, log: () => {} })
    wiring.notePoolEvent = () => handle.notePoolEvent()

    // The merged sidebar stream through the sub-client's own wire adapter.
    const merged = await localGateway.wireTap('workspace/follow', { args: {} }, undefined, localGateway.operatorPeer(), controller.signal, { signal: controller.signal })
    const iterator = merged[Symbol.asyncIterator]()

    const LOCAL_WS = {
      workspaceId: 'ws-local',
      path: '/home/me/local',
      title: '本地',
      sessionIds: ['session-local'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    localGate.push({ type: 'baseline', value: { items: [LOCAL_WS], archivedSessionIds: [], pinnedSessionIds: [] } })
    const initial = await collectFrames(iterator, 1)
    assert.deepEqual(initial[0].value.items.map((workspace) => workspace.workspaceId), ['ws-local'])

    // First-paired server's baseline crosses as ONE virtualized group with
    // the -1 name and only its SHARED sessions (s1x stays unshared).
    await waitFor(() => first.streams.some((gate) => gate.call.namespace === 'workspace' && gate.call.method === 'follow'))
    const firstWsGate = first.streams.find((gate) => gate.call.namespace === 'workspace')
    firstWsGate.push({
      type: 'baseline',
      value: {
        items: [{
          workspaceId: 'w-1',
          path: '/srv/first',
          title: '甲工作区',
          sessionIds: ['s1a', 's1x'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    const afterFirst = await collectFrames(iterator, 4)
    assert.deepEqual(afterFirst[0], {
      type: 'upsert',
      workspace: {
        workspaceId: V1('w-1'),
        path: '/srv/first',
        title: `${MS9_NAME}-1 · 甲工作区`,
        sessionIds: [V1('s1a')],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    assert.deepEqual(afterFirst[1], { type: 'order', workspaceIds: ['ws-local', V1('w-1')] })
    assert.equal(afterFirst[2].type, 'archived')
    assert.equal(afterFirst[3].type, 'pinned')

    // Second-paired server's baseline: the order frame extends in PAIRING
    // order — first's group still leads (its serverId sorts LOWER by
    // construction, so only the pairing order explains this).
    await waitFor(() => second.streams.some((gate) => gate.call.namespace === 'workspace' && gate.call.method === 'follow'))
    const secondWsGate = second.streams.find((gate) => gate.call.namespace === 'workspace')
    secondWsGate.push({
      type: 'baseline',
      value: {
        items: [{
          workspaceId: 'w-2',
          path: '/srv/second',
          title: '乙工作区',
          sessionIds: ['s2a', 's2x'],
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        }],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    const afterSecond = await collectFrames(iterator, 4)
    assert.deepEqual(afterSecond[0].workspace.workspaceId, V2('w-2'))
    assert.deepEqual(afterSecond[0].workspace.title, `${MS9_NAME}-2 · 乙工作区`)
    assert.deepEqual(afterSecond[1], { type: 'order', workspaceIds: ['ws-local', V1('w-1'), V2('w-2')] })

    // The unscoped list merges in the SAME pairing order: local rows first,
    // then first-paired's, then second-paired's.
    const listEnvelope = await localGateway.rpcBridge('session/list', { args: {} }, undefined, undefined)
    assert.deepEqual(listEnvelope, {
      ok: true,
      value: {
        items: [
          { sessionId: 'session-local', updatedAt: 1 },
          { sessionId: V1('s1a'), title: '甲会话', updatedAt: 1 },
          { sessionId: V2('s2a'), title: '乙会话', updatedAt: 1 },
        ],
      },
    })

    // The client routes over the pool: status reports BOTH in pairing order
    // with the derived names, the 8-server cap, and no credential material.
    const routes = await startClientRouteServer(pool, () => handle.diagnostics())
    try {
      const status = await fetch(`http://127.0.0.1:${routes.port}/_dsh/zen-remote/client/status`)
      const statusBody = await status.json()
      assert.equal(statusBody.state, 'online')
      assert.equal(statusBody.maxServers, 8)
      assert.deepEqual(statusBody.servers.map((entry) => entry.displayName), [`${MS9_NAME}-1`, `${MS9_NAME}-2`])
      assert.deepEqual(statusBody.servers.map((entry) => entry.serverId), [first.serverId, second.serverId])
      assert.ok(statusBody.servers.every((entry) => entry.state === 'online'))
      assert.equal(JSON.stringify(statusBody).includes(first.token), false)

      // Remove the FIRST-paired server through the route. Two facts cross the
      // still-open sidebar stream, in order: the survivor's rename (the
      // duplicate name is gone, so its -2 suffix disappears and the group
      // re-upserts), then the removed server's group remove + the re-aired
      // trio without it.
      const unpair = await postRoute(routes.port, '/_dsh/zen-remote/client/unpair', { entryId: pairedFirst.entry.entryId })
      assert.deepEqual(await unpair.json(), { ok: true, removed: 1 })
      const gone = await collectFrames(iterator, 8)
      assert.deepEqual(gone[0], {
        type: 'upsert',
        workspace: {
          workspaceId: V2('w-2'),
          path: '/srv/second',
          title: `${MS9_NAME} · 乙工作区`,
          sessionIds: [V2('s2a')],
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      })
      assert.deepEqual(gone[1], { type: 'order', workspaceIds: ['ws-local', V2('w-2')] })
      assert.deepEqual(gone[4], { type: 'remove', workspaceId: V1('w-1') })
      assert.deepEqual(gone[5], { type: 'order', workspaceIds: ['ws-local', V2('w-2')] })
      assert.ok(gone.every((frame) => !JSON.stringify(frame).includes(V1('w-1')) || frame.type === 'remove'), 'the removed group never re-airs')

      // The removed server's leg is torn down for real.
      assert.equal(pool.entries().length, 1)
      await waitFor(() => firstWsGate.aborted)

      // The state file keeps only the survivor.
      const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      assert.deepEqual(onDisk.servers.map((record) => record.serverId), [second.serverId])

      // The survivor still serves END TO END: a fresh share on ITS side
      // synthesizes an upsert that crosses with both its sessions.
      second.store.share('s2x')
      const live = await collectFrames(iterator, 4)
      assert.deepEqual(live[0].workspace.workspaceId, V2('w-2'))
      assert.deepEqual(live[0].workspace.sessionIds, [V2('s2a'), V2('s2x')])

      // And the route view shrank to one server.
      const statusAfter = await fetch(`http://127.0.0.1:${routes.port}/_dsh/zen-remote/client/status`)
      const after = await statusAfter.json()
      assert.deepEqual(after.servers.map((entry) => entry.displayName), [MS9_NAME])
    } finally {
      await routes.stop()
    }

    controller.abort()
    const done = await iterator.next()
    assert.equal(done.done, true)
    handle.uninstall()
  } finally {
    await pool.stop()
    await first.stop()
    await second.stop()
  }
})

test('e2e MS-9: calls route BY serverId — invoke, stream and approval answers travel only their own server\'s chain, the unshare route closes the right store, and a foreign serverId reads remote-mismatch', async () => {
  const stackOne = await bootStack({
    serverName: 'MS9路由甲',
    invoke: async (call) => {
      if (call.namespace === 'session' && call.method === 'page') return { page: '甲服务端', echoed: call.args.request.address.sessionId }
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
  })
  const stackTwo = await bootStack({
    serverName: 'MS9路由乙',
    invoke: async (call) => {
      if (call.namespace === 'session' && call.method === 'page') return { page: '乙服务端', echoed: call.args.request.address.sessionId }
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
  })
  const { pool, wiring } = makePool(path.join(ROOT, `pool-route-${stackCounter}.json`))
  try {
    stackOne.sessionListAnswer = { items: [{ sessionId: 's1a', title: '甲会话', updatedAt: 1 }] }
    stackTwo.sessionListAnswer = { items: [{ sessionId: 's2a', title: '乙会话', updatedAt: 1 }] }
    stackOne.store.share('s1a')
    stackTwo.store.share('s2a')
    const pairedOne = await pool.pair({
      serverUrl: `http://127.0.0.1:${stackOne.proxyPort}`,
      token: stackOne.token,
      deviceId: stackOne.deviceId,
      deviceName: 'MS9台式机',
    })
    const pairedTwo = await pool.pair({
      serverUrl: `http://127.0.0.1:${stackTwo.proxyPort}`,
      token: stackTwo.token,
      deviceId: stackTwo.deviceId,
      deviceName: 'MS9台式机',
    })
    await waitFor(() => pool.entries().length === 2 && pool.entries().every((entry) => entry.client.state === 'online'))
    await waitFor(() => pool.entries().every((entry) => entry.serverId !== undefined))
    const SID_ONE = stackOne.serverId
    const SID_TWO = stackTwo.serverId
    const V1 = (id) => toVirtual(SID_ONE, id)
    const V2 = (id) => toVirtual(SID_TWO, id)

    const controller = new AbortController()
    const localGate = makeLocalGate(controller.signal)
    const localGateway = new LocalEventsGateway(localGate)
    const handle = installIntercept({ raw: localGateway, pool, log: () => {} })
    wiring.notePoolEvent = () => handle.notePoolEvent()

    // The merged $events stream, drained in the background — the summary and
    // status sync add frames of their own, so the tests wait on predicates.
    const merged = await localGateway.wireTap('$events', { args: {} }, undefined, localGateway.operatorPeer(), controller.signal, { signal: controller.signal })
    const iterator = merged[Symbol.asyncIterator]()
    localGate.push({ type: 'ready', clientId: 'local-ui-client', host: { home: '/local/home' } })
    const drained = []
    const drain = drainInto(iterator, drained)
    await waitFor(() => drained.length >= 1)
    assert.deepEqual(drained[0], { type: 'ready', clientId: 'local-ui-client', host: { home: '/local/home' } })
    await waitFor(() => stackOne.eventsGates.length === 1 && stackTwo.eventsGates.length === 1)

    // ---- invoke routing: each server sees ONLY its own session's page read.
    const pageOne = await localGateway.rpcBridge(
      'session/page',
      { args: { request: { address: { kind: 'session', sessionId: V1('s1a') } } } },
      undefined,
      localGateway.operatorPeer(),
    )
    assert.deepEqual(pageOne, { ok: true, value: { page: '甲服务端', echoed: 's1a' } })
    const pageTwo = await localGateway.rpcBridge(
      'session/page',
      { args: { request: { address: { kind: 'session', sessionId: V2('s2a') } } } },
      undefined,
      localGateway.operatorPeer(),
    )
    assert.deepEqual(pageTwo, { ok: true, value: { page: '乙服务端', echoed: 's2a' } })
    const pagesOf = (stack) => stack.invokeCalls.filter((call) => call.namespace === 'session' && call.method === 'page')
    assert.deepEqual(pagesOf(stackOne).map((call) => call.args.request.address.sessionId), ['s1a'])
    assert.deepEqual(pagesOf(stackTwo).map((call) => call.args.request.address.sessionId), ['s2a'])

    // ---- event answer routing: server ONE's waterfall crosses virtualized,
    // the answer rides back to ONE only, with the original id and the
    // server's own clientId; server TWO never sees either frame.
    stackOne.eventsGates[0].push({ type: 'waterfall', event: 'approval/request', eventId: 'evt-a-1', agentId: 's1a', request: { toolName: 'Bash', callId: 'c1', reason: 'run a command' } })
    await waitFor(() => drained.some((frame) => frame.type === 'waterfall' && frame.eventId.endsWith('.evt-a-1')))
    const seenOne = drained.find((frame) => frame.type === 'waterfall' && frame.eventId.endsWith('.evt-a-1'))
    assert.equal(seenOne.eventId.startsWith(V1('')), true)
    assert.deepEqual(seenOne.agentId, V1('s1a'))
    const answerOne = await localGateway.rpcBridge(
      '$events/result',
      { args: { clientId: 'local-ui-client', eventId: seenOne.eventId, outcome: { kind: 'result', value: 'allowed-once' } } },
      undefined,
      undefined,
    )
    assert.deepEqual(answerOne, { ok: true, value: undefined })
    await waitFor(() => stackOne.eventResults.length >= 1)
    assert.deepEqual(stackOne.eventResults[0].payload, {
      args: { clientId: 'srv-events-client', eventId: 'evt-a-1', outcome: { kind: 'result', value: 'allowed-once' } },
    })
    assert.equal(stackTwo.eventResults.length, 0, 'server ONE\'s answer never reached server TWO')

    // Server TWO's own waterfall answers on ITS leg, ONE's count untouched.
    stackTwo.eventsGates[0].push({ type: 'waterfall', event: 'approval/request', eventId: 'evt-b-1', agentId: 's2a', request: { toolName: 'Bash', callId: 'c2' } })
    await waitFor(() => drained.some((frame) => frame.type === 'waterfall' && frame.eventId.endsWith('.evt-b-1')))
    const seenTwo = drained.find((frame) => frame.type === 'waterfall' && frame.eventId.endsWith('.evt-b-1'))
    assert.equal(seenTwo.eventId.startsWith(V2('')), true)
    await localGateway.rpcBridge(
      '$events/result',
      { args: { clientId: 'local-ui-client', eventId: seenTwo.eventId, outcome: { kind: 'result', value: 'allowed-once' } } },
      undefined,
      undefined,
    )
    await waitFor(() => stackTwo.eventResults.length >= 1)
    assert.deepEqual(stackTwo.eventResults[0].payload.args.eventId, 'evt-b-1')
    assert.equal(stackOne.eventResults.length, 1)
    assert.equal(localGateway.rpcCalls.filter((call) => call.endpoint === '$events/result').length, 0, 'no answer ever reached the local gateway')

    // ---- stream routing: server TWO's session page streams from TWO only.
    const stream = await localGateway.wireTap(
      'session/follow',
      { args: { request: { address: { kind: 'session', sessionId: V2('s2a') } } } },
      undefined,
      undefined,
      undefined,
      { signal: undefined },
    )
    const streamIterator = stream[Symbol.asyncIterator]()
    const pending = streamIterator.next()
    await waitFor(() => stackTwo.streams.some((gate) => gate.call.namespace === 'session' && gate.call.method === 'follow'))
    const twoGate = stackTwo.streams.find((gate) => gate.call.namespace === 'session' && gate.call.method === 'follow')
    assert.deepEqual(twoGate.call.args, { request: { address: { kind: 'session', sessionId: 's2a' } } })
    assert.equal(stackOne.streams.some((gate) => gate.call.namespace === 'session'), false, 'server ONE saw no stream')
    twoGate.push({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    const frame = await pending
    assert.equal(frame.value.event.type, 'turn/start')

    // ---- the unshare route closes the RIGHT store through the whole chain.
    const routes = await startClientRouteServer(pool, () => handle.diagnostics())
    try {
      const close = await postRoute(routes.port, '/_dsh/zen-remote/client/unshare', { sessionId: V2('s2a') })
      assert.deepEqual(await close.json(), { ok: true })
      await waitFor(() => !stackTwo.store.isShared('s2a'))
      assert.equal(stackOne.store.isShared('s1a'), true, 'server ONE\'s share never blinked')
      let thrown
      try { await streamIterator.next() } catch (error) { thrown = error }
      assert.ok(thrown instanceof Error && thrown.code === 'unshared', `the open TWO page died with unshared, got: ${thrown}`)
      await waitFor(() => twoGate.aborted)

      // A foreign serverId (paired nowhere) reads remote-mismatch, nothing
      // travels.
      const ghost = await postRoute(routes.port, '/_dsh/zen-remote/client/unshare', { sessionId: toVirtual('deadbeef', 'session-x') })
      const ghostBody = await ghost.json()
      assert.equal(ghostBody.ok, false)
      assert.equal(ghostBody.error.code, 'remote-mismatch')
      assert.equal(stackOne.store.isShared('s1a'), true)
      assert.equal(stackTwo.store.isShared('s2a'), false)
    } finally {
      await routes.stop()
    }

    controller.abort()
    await drain
    handle.uninstall()
  } finally {
    await pool.stop()
    await stackOne.stop()
    await stackTwo.stop()
  }
})

test('API-2 e2e: P0 endpoints and all 5 session-scoped $zr/events emits honor share boundaries', async () => {
  const env = await boot({
    shared: ['session-parent'],
    invoke: async (call) => ({ echoed: `${call.namespace}/${call.method}` }),
  })
  const controller = new AbortController()
  let handle
  try {
    const info = await env.client.connect()
    assert.equal(env.client.state, 'online')
    const V = (id) => toVirtual(info.serverId, id)

    const localGate = makeLocalGate(controller.signal)
    const localGateway = new LocalEventsGateway(localGate)
    handle = installIntercept({
      raw: localGateway,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
      log: () => {},
    })

    // Open merged $events stream
    const merged = await localGateway.wireTap(
      '$events',
      { args: {} },
      undefined,
      localGateway.operatorPeer(),
      controller.signal,
      { signal: controller.signal },
    )
    const iterator = merged[Symbol.asyncIterator]()
    localGate.push({ type: 'ready', clientId: 'local', host: { home: '/tmp' } })
    await collectFrames(iterator, 1)
    await waitFor(() => env.eventsGates.length === 1)

    // 4 new session-scoped emits on shared session traverse & virtualize;
    // emits for unshared session or malformed args are dropped server-side.
    env.eventsGates[0].push({ type: 'emit', event: 'api-session/activity', args: ['session-secret', 999] })
    env.eventsGates[0].push({ type: 'emit', event: 'api-session/activity', args: ['session-parent', 4242] })
    env.eventsGates[0].push({ type: 'emit', event: 'api-session/error', args: ['session-parent', 'turn failed'] })
    env.eventsGates[0].push({ type: 'emit', event: 'agent-preset/selected', args: ['session-parent', 'ptc'] })
    env.eventsGates[0].push({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 'session-secret' }] })
    env.eventsGates[0].push({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 'session-parent', goal: { title: 'Ship' } }] })

    const emits = await collectFrames(iterator, 4)
    assert.deepEqual(emits, [
      { type: 'emit', event: 'api-session/activity', args: [V('session-parent'), 4242] },
      { type: 'emit', event: 'api-session/error', args: [V('session-parent'), 'turn failed'] },
      { type: 'emit', event: 'agent-preset/selected', args: [V('session-parent'), V('ptc')] },
      { type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: V('session-parent'), goal: { title: 'Ship' } }] },
    ])

    // P0 invoke + stream checks over the real HTTP/NDJSON relay
    const enableRes = await localGateway.rpcBridge('agentTeams/setEnabled', {
      args: { agentId: V('session-parent'), enabled: true },
    })
    assert.equal(enableRes.ok, true)
    assert.deepEqual(enableRes.value, { echoed: 'agentTeams/setEnabled' })
    const recorded = env.invokeCalls.find((c) => c.namespace === 'agentTeams' && c.method === 'setEnabled')
    assert.deepEqual(recorded?.args, { agentId: 'session-parent', enabled: true })

    const deniedRes = await localGateway.rpcBridge('goals/create', {
      args: { agentId: V('session-secret'), request: { title: 'x' } },
    })
    assert.equal(deniedRes.ok, false)
    assert.equal(deniedRes.error.code, 'not-shared')

    // toolResults/watch streams cleanly and dies with 'unshared' on unshare
    const watchStream = await localGateway.wireTap(
      'toolResults/watch',
      { args: { request: { sessionId: V('session-parent'), toolCallId: 'tc-1' } } },
      undefined,
      localGateway.operatorPeer(),
      controller.signal,
      { signal: controller.signal },
    )
    const watchIter = watchStream[Symbol.asyncIterator]()
    const firstPromise = watchIter.next()
    await waitFor(() => env.streams.some((s) => s.call.namespace === 'toolResults' && s.call.method === 'watch'))
    const watchGate = env.streams.find((s) => s.call.namespace === 'toolResults' && s.call.method === 'watch')
    watchGate.push({ type: 'chunk', text: 'hello' })
    const first = await firstPromise
    assert.deepEqual(first.value, { type: 'chunk', text: 'hello' })

    env.store.unshare('session-parent')
    await assert.rejects(() => watchIter.next(), (err) => err && err.code === 'unshared')
  } finally {
    controller.abort()
    handle?.uninstall()
    await env.stop()
  }
})

test('API-4 e2e: forgePanel/follow streams shared session and terminates with unshared; offline writes fail remote-offline', async () => {
  const env = await bootIsolated({
    shared: ['session-parent'],
    invoke: async (call) => ({ ok: true, method: call.method }),
  })
  const controller = new AbortController()
  let handle
  try {
    const info = await env.client.connect()
    const V = (id) => toVirtual(info.serverId, id)
    const localGateway = new LocalEventsGateway(makeLocalGate(controller.signal))
    handle = installIntercept({
      raw: localGateway,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
      log: () => {},
    })

    const followStream = await localGateway.wireTap(
      'forgePanel/follow',
      { args: { sessionId: V('session-parent') } },
      undefined,
      localGateway.operatorPeer(),
      controller.signal,
      { signal: controller.signal },
    )
    const followIter = followStream[Symbol.asyncIterator]()
    const firstPromise = followIter.next()
    await waitFor(() => env.streams.some((s) => s.call.namespace === 'forgePanel' && s.call.method === 'follow'))
    const gate = env.streams.find((s) => s.call.namespace === 'forgePanel' && s.call.method === 'follow')
    gate.push({ type: 'state', branch: 'feat/x' })
    assert.deepEqual((await firstPromise).value, { type: 'state', branch: 'feat/x' })

    env.store.unshare('session-parent')
    await assert.rejects(() => followIter.next(), (err) => err && err.code === 'unshared')

    // Offline writes refuse locally without reaching relay
    await env.killGateway()
    await assert.rejects(() => env.client.invoke('session', 'page', FOLLOW_ARGS), (err) => err.code === 'offline')
    assert.equal(env.client.state, 'offline')
    for (const m of ['forgePanel/merge', 'forgePanel/refresh']) {
      const res = await localGateway.rpcBridge(m, { args: { sessionId: V('session-parent') } })
      assert.equal(res.ok, false)
      assert.equal(res.error.code, 'remote-offline')
    }
  } finally {
    controller.abort()
    handle?.uninstall()
    await env.stop()
  }
})

test('API-5 e2e: forgePanel/changeRequestStates merges local + remote and tracks live share/unshare', async () => {
  const env = await boot({
    shared: ['s-shared'],
    invoke: async (call) => {
      if (call.namespace === 'session' && call.method === 'list') {
        return {
          items: [
            {
              sessionId: 's-shared',
              projections: {
                values: {
                  forgeChangeRequests: [
                    { url: 'https://gh/pr/1' },
                    { url: 'https://gh/pr/dismissed', dismissed: true },
                  ],
                },
              },
            },
            {
              sessionId: 's-hidden',
              projections: {
                values: {
                  forgeChangeRequests: [{ url: 'https://gh/pr/2' }],
                },
              },
            },
          ],
        }
      }
      return { ok: true }
    },
  })
  const controller = new AbortController()
  let handle
  try {
    await env.client.connect()
    const localGate = makeLocalGate(controller.signal)
    const localGateway = new LocalEventsGateway(localGate)
    const origOpen = localGateway.openWireStream.bind(localGateway)
    localGateway.openWireStream = (endpoint, ...rest) =>
      endpoint === 'forgePanel/changeRequestStates' ? localGate.iterable : origOpen(endpoint, ...rest)
    handle = installIntercept({
      raw: localGateway,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
      log: () => {},
    })

    const stream = await localGateway.wireTap(
      'forgePanel/changeRequestStates',
      { args: {} },
      undefined,
      localGateway.operatorPeer(),
      controller.signal,
      { signal: controller.signal },
    )
    const iter = stream[Symbol.asyncIterator]()
    const nextFrame = () => iter.next().then((r) => r.value)

    const localPr = { url: 'https://gh/local', title: 'Local' }
    const sharedPr = { url: 'https://gh/pr/1', title: 'Shared' }
    const hiddenPr = { url: 'https://gh/pr/2', title: 'Hidden' }
    const dismissedPr = { url: 'https://gh/pr/dismissed', title: 'Dismissed' }

    localGate.push({ type: 'baseline', states: [localPr] })
    assert.deepEqual(await nextFrame(), { type: 'baseline', states: [localPr] })

    await waitFor(
      () =>
        env.streams.some((s) => s.call.namespace === 'forgePanel' && s.call.method === 'changeRequestStates') &&
        env.streams.some((s) => s.call.namespace === 'session' && s.call.method === 'control'),
    )
    const remoteGate = env.streams.find((s) => s.call.namespace === 'forgePanel' && s.call.method === 'changeRequestStates')

    remoteGate.push({ type: 'baseline', states: [sharedPr, hiddenPr, dismissedPr] })
    assert.deepEqual(await nextFrame(), { type: 'changed', states: [sharedPr] })

    // Live share unlocks hiddenPr immediately as changed
    env.store.share('s-hidden')
    assert.deepEqual(await nextFrame(), { type: 'changed', states: [hiddenPr] })

    // Live unshare re-baselines keeping sharedPr + localPr while evicting hiddenPr
    env.store.unshare('s-hidden')
    assert.deepEqual(await nextFrame(), { type: 'baseline', states: [sharedPr, localPr] })
  } finally {
    controller.abort()
    handle?.uninstall()
    await env.stop()
  }
})

test('API-6 e2e: workspace/insertSessionBefore, session/search, and agentPresets zero-share/select/create lifecycle', async () => {
  const env = await boot({
    shared: ['s-shared', 's-before'],
    workspaces: [{ workspaceId: 'w-1', path: '/srv/w-1', title: 'Repo', sessionIds: ['s-before', 's-shared', 's-secret'] }],
    invoke: async (call) => {
      if (call.namespace === 'workspace' && call.method === 'list') {
        return { items: [{ workspaceId: 'w-1', path: '/srv/w-1', title: 'Repo', sessionIds: ['s-before', 's-shared', 's-secret'] }] }
      }
      if (call.namespace === 'workspace' && call.method === 'insertSessionBefore') {
        return {
          workspace: {
            workspaceId: 'w-1',
            path: '/srv/w-1',
            title: 'Repo',
            sessionIds: ['s-shared', 's-before', 's-secret'],
          },
        }
      }
      if (call.namespace === 'session' && call.method === 'search') {
        return {
          items: [
            { sessionId: 's-shared', title: 'Shared Hit' },
            { sessionId: 's-secret', title: 'Secret Hit' },
          ],
          hasMore: true,
        }
      }
      if (call.namespace === 'agentPresets' && call.method === 'list') {
        return { presets: [{ id: 'ptc', isDefault: true }, { id: 'custom', name: '审计官', isDefault: false }] }
      }
      if (call.namespace === 'agentPresets' && call.method === 'read') {
        return { agentPreset: call.args.agentPreset, content: 'Audit prompt' }
      }
      if (call.namespace === 'agentPresets' && call.method === 'select') {
        return call.args.agentPreset
      }
      if (call.namespace === 'session' && call.method === 'create') {
        return { sessionId: 's-created', agentPreset: call.args.request.agentPreset }
      }
      return { ok: true }
    },
  })
  const controller = new AbortController()
  let handle
  try {
    const info = await env.client.connect()
    const V = (id) => toVirtual(info.serverId, id)
    const localGateway = new LocalEventsGateway(makeLocalGate(controller.signal))
    localGateway.dispatchRpc = async (endpoint) => {
      if (endpoint === 'session/search') return { ok: true, value: { items: [{ sessionId: 'l-1', title: 'Local Hit' }], hasMore: false } }
      if (endpoint === 'agentPresets/list') return { ok: true, value: { presets: [{ id: 'standard', isDefault: true }] } }
      return { ok: true, value: undefined }
    }
    handle = installIntercept({
      raw: localGateway,
      relay: env.client,
      getServerId: () => env.client.handshakeInfo?.serverId,
      log: () => {},
    })

    // 1. workspace/insertSessionBefore allowed with shared beforeSessionId, unshared denied
    const insertOk = await localGateway.rpcBridge('workspace/insertSessionBefore', {
      args: { request: { workspaceId: V('w-1'), sessionId: V('s-shared'), beforeSessionId: V('s-before') } },
    })
    assert.equal(insertOk.ok, true)
    assert.equal(insertOk.value.workspace.workspaceId, V('w-1'))
    assert.deepEqual(insertOk.value.workspace.sessionIds, [V('s-shared'), V('s-before')])

    const insertDenied = await localGateway.rpcBridge('workspace/insertSessionBefore', {
      args: { request: { workspaceId: V('w-1'), sessionId: V('s-shared'), beforeSessionId: V('s-secret') } },
    })
    assert.equal(insertDenied.ok, false)
    assert.equal(insertDenied.error.code, 'not-shared')

    // 2. session/search merges local + shared remote hits and drops secret remote hits
    const search = await localGateway.rpcBridge('session/search', { args: { request: { query: 'Hit' } } })
    assert.deepEqual(search, {
      ok: true,
      value: {
        items: [
          { sessionId: 'l-1', title: 'Local Hit' },
          { sessionId: V('s-shared'), title: 'Shared Hit' },
        ],
        hasMore: true,
      },
    })

    // 3. agentPresets/list + read + select + session/create
    const presets = await localGateway.rpcBridge('agentPresets/list', { args: {} })
    assert.equal(presets.ok, true)
    assert.equal(presets.value.presets.length, 3)
    assert.equal(presets.value.presets[1].id, V('ptc'))
    assert.equal(presets.value.presets[1].isDefault, false)
    assert.match(presets.value.presets[1].name, /PTC 模式/)

    const read = await localGateway.rpcBridge('agentPresets/read', { args: { agentPreset: V('custom') } })
    assert.equal(read.ok, true)
    assert.equal(read.value.agentPreset, V('custom'))
    assert.equal(read.value.content, 'Audit prompt')

    const selected = await localGateway.rpcBridge('agentPresets/select', {
      args: { agentId: V('s-shared'), agentPreset: V('custom') },
    })
    assert.deepEqual(selected, { ok: true, value: V('custom') })

    const created = await localGateway.rpcBridge('session/create', {
      args: { request: { workspaceId: V('w-1'), agentPreset: V('ptc') } },
    })
    assert.deepEqual(created, { ok: true, value: { sessionId: V('s-created'), agentPreset: V('ptc') } })

    // 4. Zero-shared-session privacy gate activates once all shared sessions are unshared
    env.store.unshare('s-shared')
    env.store.unshare('s-before')
    env.store.unshare('s-created')
    const listZero = await localGateway.rpcBridge('agentPresets/list', { args: {} })
    assert.deepEqual(listZero, { ok: true, value: { presets: [{ id: 'standard', isDefault: true }] } })

    const readZero = await localGateway.rpcBridge('agentPresets/read', { args: { agentPreset: V('custom') } })
    assert.equal(readZero.ok, false)
    assert.equal(readZero.error.code, 'not-shared')
  } finally {
    controller.abort()
    handle?.uninstall()
    await env.stop()
  }
})
