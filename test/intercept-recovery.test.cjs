/* dsh-zen-remote · CP4 recovery: the merged global streams reopen on their own
 *
 * Drives the REAL createRelayClient (real HTTP, real NDJSON pump, real
 * reconnect ladder on an injected clock) against a fake relay server, through
 * the REAL installIntercept, and proves the fix for the frozen-group bug: a
 * remote leg that ends while the relay still reads `online` — the server's
 * `error{server-restart}` line, a clean `{type:'end'}`, a 429
 * `too-many-streams` — reopens within the backoff delay instead of parking on
 * `waitOnline` forever (nothing would ever fire it). The server-restart line
 * additionally marks the client offline AT ONCE, so the group annotates
 * （离线） and the reconnect ladder's fresh handshake restores the name.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { installIntercept } = require('../lib/intercept.js')
const { createRelayClient } = require('../lib/relay-client.js')
const { toVirtual } = require('../lib/virtual-id.js')

const SERVER_ID = '5e5a5a5a'
const RW = { workspaceId: 'w-1', path: '/srv/w1', title: '远端一', sessionIds: ['s1'], createdAt: '2026', updatedAt: '2026' }
const REMOTE_BASELINE_FRAME = { type: 'baseline', value: { items: [RW], archivedSessionIds: [], pinnedSessionIds: [] } }
const LOCAL_BASELINE = { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }

/** A manual clock for the ladder AND the reopen backoff: `advance` moves time
 * and fires due timers synchronously; `random` is pinned so the ladder's
 * jitter math is exact. */
function fakeClock() {
  let now = 1_700_000_000_000
  let rng = 0
  const timers = []
  return {
    now: () => now,
    random: () => rng,
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

/** A fake relay server: the handshake answers `ok` (unless a 502 is wanted),
 * every stream open is recorded as a `{ write, end }` NDJSON gate the test
 * drives, and a scripted refusal answers the NEXT stream open once. */
function createRelayServer() {
  const state = { handshakeOk: true, firstStreamRefusal: null, streams: [] }
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (req.url.endsWith('/handshake')) {
        if (!state.handshakeOk) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false })); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, relayProtocol: 1, serverId: SERVER_ID, serverName: '主服务端', dshVersion: '0.2.0', fingerprints: {} }))
        return
      }
      if (req.url.endsWith('/stream')) {
        if (state.firstStreamRefusal !== null) {
          const refusal = state.firstStreamRefusal
          state.firstStreamRefusal = null
          res.writeHead(refusal.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(refusal.body))
          return
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        const stream = {
          closed: false,
          write: (object) => { res.write(JSON.stringify(object) + '\n') },
          end: () => { res.end() },
        }
        res.on('close', () => { stream.closed = true })
        state.streams.push(stream)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: {} }))
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        url: `http://127.0.0.1:${srv.address().port}`,
        stop: () => { srv.closeAllConnections?.(); return new Promise((r) => srv.close(r)) },
      })
    })
  })
}

/** One controllable local workspace stream for the fake gateway. */
function createLocalGate(signal) {
  const pending = []
  let wake = () => {}
  let finished = false
  const iterable = (async function* () {
    const onAbort = () => { finished = true; wake() }
    if (signal?.aborted) return
    signal?.addEventListener('abort', onAbort)
    try {
      while (true) {
        if (pending.length > 0) yield pending.shift()
        else if (finished) return
        else await new Promise((resolve) => { wake = resolve })
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  })()
  return {
    iterable,
    push: (frame) => { pending.push(frame); wake() },
    finish: () => { finished = true; wake() },
  }
}

/** Poll until the predicate holds, failing loudly. */
async function waitFor(predicate, ms = 4000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** One wired scenario: real relay client + real intercept + fake server +
 * manual clock, the merged workspace/follow consumer collecting frames, the
 * remote baseline already flowing. */
async function boot(t) {
  const relay = await createRelayServer()
  const clock = fakeClock()
  // T59: the periodic info refresh would arm a second fake-clock timer on
  // `online`, and these tests count timers (`clock.pending`) — off here.
  const client = createRelayClient({ getServerUrl: () => relay.url, getToken: () => 'token-1', clock, infoRefreshMs: 0 })
  await client.connect()
  assert.equal(client.state, 'online')

  const localGate = createLocalGate(undefined)
  const gateway = {
    operatorPeer: () => ({ id: 'p' }),
    openWireStream: async function () { return localGate.iterable },
    wireTap: (endpoint, payload, uplink, peer, signal, control) => gateway.openWireStream(endpoint, payload, uplink, peer, control.signal, control),
  }
  const handle = installIntercept({
    raw: gateway,
    relay: client,
    getServerId: () => client.handshakeInfo?.serverId,
    clock,
  })
  t.after(() => { handle.uninstall(); client.stop(); return relay.stop() })

  const merged = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), undefined, { signal: undefined })
  const frames = []
  const done = (async () => {
    try { for await (const frame of merged) frames.push(frame) } catch { frames.push({ terminal: true }) }
  })()
  // The local baseline opens the merged stream (the UI's own stream is the
  // base); the pump then dials the relay's filtered stream on its own.
  localGate.push(LOCAL_BASELINE)
  await waitFor(() => frames.length >= 1)
  await waitFor(() => relay.state.streams.length === 1)
  relay.state.streams[0].write({ type: 'frame', frame: REMOTE_BASELINE_FRAME })
  // upsert + order + archived + pinned fold in after the local baseline.
  await waitFor(() => frames.length >= 5)
  return { relay, clock, client, handle, frames, gateway, localGate, done }
}

test('CP4: the server-restart error line marks the client offline at once and the merged stream reopens after the reconnect', async (t) => {
  const { relay, clock, client, frames } = await boot(t)

  // The server app exits cleanly: every NDJSON stream gets the restart line.
  relay.state.streams[0].write({ type: 'error', error: { code: 'server-restart' } })
  relay.state.streams[0].end()
  // IMMEDIATELY offline — before any ladder tick, the state is the restart's
  // verdict (this is what flips the group's （离线） annotation).
  await waitFor(() => client.state === 'offline')
  assert.equal(client.lastError, 'offline')
  assert.equal(client.nextRetryAt, clock.now() + 1000, 'the reconnect ladder armed its first step')
  await waitFor(() => frames.some((frame) => frame.workspace?.title === '主服务端 · 远端一（离线）'))

  // The server is back: the ladder's first due attempt reconnects, the pump
  // wakes on the online transition and reopens the remote leg.
  clock.advance(1000)
  await waitFor(() => client.state === 'online')
  await waitFor(() => relay.state.streams.length === 2)
  relay.state.streams[1].write({ type: 'frame', frame: REMOTE_BASELINE_FRAME })
  await waitFor(() => frames.filter((frame) => frame.type === 'upsert' && frame.workspace?.title === '主服务端 · 远端一').length >= 2)
  assert.equal(frames.some((frame) => frame.terminal), false, 'the consumer never saw an error')
})

test('CP4: a clean stream end while still online reopens after the backoff delay — 1s, doubling empty spins, reset by a served frame', async (t) => {
  const { relay, clock, client, frames } = await boot(t)
  assert.equal(client.state, 'online')

  // First end: {type:'end'} on the wire — the state never moves, so nothing
  // but the backoff can wake the pump. The pump walks real socket I/O before
  // it arms the backoff timer, so every wait below lets the arming land
  // BEFORE advancing the fake clock.
  relay.state.streams[0].write({ type: 'end' })
  relay.state.streams[0].end()
  assert.equal(client.state, 'online')
  // The first spin waits 1s.
  await waitFor(() => clock.pending === 1)
  clock.advance(500)
  await flushAsync()
  assert.equal(relay.state.streams.length, 1, 'no reopen before the delay')
  clock.advance(500)
  await waitFor(() => relay.state.streams.length === 2)

  // Second EMPTY spin (the reopened leg served nothing): the delay doubles
  // to 2s — 1s of advance must not reopen, the next second does.
  relay.state.streams[1].write({ type: 'end' })
  relay.state.streams[1].end()
  await waitFor(() => clock.pending === 1)
  clock.advance(1000)
  await flushAsync()
  assert.equal(relay.state.streams.length, 2, 'the doubled delay is still running')
  clock.advance(1000)
  await waitFor(() => relay.state.streams.length === 3)

  // A stream that SERVED a frame proves the route works: the delay resets,
  // and the next end reopens after 1s again.
  relay.state.streams[2].write({ type: 'frame', frame: { type: 'upsert', workspace: { ...RW, title: '刷新' } } })
  await waitFor(() => frames.some((frame) => frame.workspace?.title === '主服务端 · 刷新'))
  relay.state.streams[2].write({ type: 'end' })
  relay.state.streams[2].end()
  await waitFor(() => clock.pending === 1)
  clock.advance(1000)
  await waitFor(() => relay.state.streams.length === 4, 4000)
  assert.equal(client.state, 'online', 'the state never left online through any of it')
  assert.equal(frames.some((frame) => frame.terminal), false)
})

test('CP4: a 429 too-many-streams refusal keeps the state online and the stream reopens within the delay', async (t) => {
  const { relay, clock, client, handle, frames } = await boot(t)

  // The next stream open is refused once. Kill the current leg cleanly (a
  // plain end — the state must stay online for this scenario).
  relay.state.firstStreamRefusal = { status: 429, body: { ok: false, error: { code: 'too-many-streams' } } }
  relay.state.streams[0].write({ type: 'end' })
  relay.state.streams[0].end()
  await waitFor(() => clock.pending === 1)
  clock.advance(1000)
  // The reopen attempt draws the 429: an ANSWER about the call, the state is
  // untouched, the ring records it, and the pump waits out the doubled delay.
  await waitFor(() => handle.diagnostics().recentFailures.at(-1)?.code === 'too-many-streams')
  assert.equal(client.state, 'online')
  await waitFor(() => clock.pending === 1)
  clock.advance(2000)
  await waitFor(() => relay.state.streams.length === 2, 4000)
  relay.state.streams[1].write({ type: 'frame', frame: { type: 'upsert', workspace: { ...RW, title: '重开' } } })
  await waitFor(() => frames.some((frame) => frame.workspace?.title === '主服务端 · 重开'), 4000)
  assert.equal(frames.some((frame) => frame.terminal), false, 'the 429 never reached the UI as an error')
})

// -- CP5: the same trio for the merged $events leg --------------------------------

/** The remote approval waterfall the reopened $events leg re-delivers. The
 * eventId/agentId rewrite virtualizes both with the server id. */
const EVENTS_WATERFALL = {
  type: 'waterfall',
  event: 'approval/request',
  eventId: 'evt-remote-1',
  agentId: 'session-local',
  request: { toolName: 'Bash', callId: 'c1' },
}

/** The $events variant of boot: real relay client + intercept + manual clock,
 * the merged events consumer collecting frames, the local ready already
 * flowed and the remote `$zr/events` leg already open. */
async function bootEvents(t) {
  const relay = await createRelayServer()
  const clock = fakeClock()
  // T59: no periodic info refresh — these tests count fake-clock timers.
  const client = createRelayClient({ getServerUrl: () => relay.url, getToken: () => 'token-1', clock, infoRefreshMs: 0 })
  await client.connect()
  assert.equal(client.state, 'online')

  const localGate = createLocalGate(undefined)
  const gateway = {
    operatorPeer: () => ({ id: 'p' }),
    openWireStream: async function () { return localGate.iterable },
    wireTap: (endpoint, payload, uplink, peer, signal, control) => gateway.openWireStream(endpoint, payload, uplink, peer, control.signal, control),
  }
  const handle = installIntercept({
    raw: gateway,
    relay: client,
    getServerId: () => client.handshakeInfo?.serverId,
    clock,
  })
  t.after(() => { handle.uninstall(); client.stop(); return relay.stop() })

  const merged = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), undefined, { signal: undefined })
  const frames = []
  const done = (async () => {
    try { for await (const frame of merged) frames.push(frame) } catch { frames.push({ terminal: true }) }
  })()
  // The local ready opens the merged stream (the UI's own subscription is the
  // base); the pump then dials the relay's $zr/events leg on its own.
  localGate.push({ type: 'ready', clientId: 'local-events-client', host: { home: '/local/home' } })
  await waitFor(() => frames.length >= 1)
  await waitFor(() => relay.state.streams.length === 1)
  return { relay, clock, client, handle, frames, gateway, localGate, done }
}

test('CP5: the $events leg reopens after a server-restart line — offline at once, back within the ladder\'s first step', async (t) => {
  const { relay, clock, client, frames } = await bootEvents(t)

  // The server app exits cleanly: the leg draws the restart line, the client
  // marks itself offline at once, and the pump parks on the state wait.
  relay.state.streams[0].write({ type: 'error', error: { code: 'server-restart' } })
  relay.state.streams[0].end()
  await waitFor(() => client.state === 'offline')
  assert.equal(client.nextRetryAt, clock.now() + 1000, 'the reconnect ladder armed its first step')

  // The server is back: the ladder's first due attempt reconnects and the
  // pump reopens the leg — a remote approval can arrive and be answered again.
  clock.advance(1000)
  await waitFor(() => client.state === 'online')
  await waitFor(() => relay.state.streams.length === 2, 4000)
  relay.state.streams[1].write({ type: 'frame', frame: EVENTS_WATERFALL })
  await waitFor(() => frames.some((frame) => frame.eventId === toVirtual(SERVER_ID, 'evt-remote-1')), 4000)
  assert.equal(frames.some((frame) => frame.terminal), false, 'the consumer never saw an error')
})

test('CP5: a clean end of the $events leg while still online reopens after the 1s backoff — not before', async (t) => {
  const { relay, clock, client, frames } = await bootEvents(t)
  assert.equal(client.state, 'online')

  // A plain {type:'end'} — the state never moves, so nothing but the backoff
  // can wake the pump. The pump walks real socket I/O before it arms the
  // backoff timer, so the wait below lets the arming land BEFORE advancing.
  relay.state.streams[0].write({ type: 'end' })
  relay.state.streams[0].end()
  await waitFor(() => clock.pending === 1)
  clock.advance(500)
  await flushAsync()
  assert.equal(relay.state.streams.length, 1, 'no reopen before the delay')
  clock.advance(500)
  await waitFor(() => relay.state.streams.length === 2, 4000)
  relay.state.streams[1].write({ type: 'frame', frame: EVENTS_WATERFALL })
  await waitFor(() => frames.some((frame) => frame.eventId === toVirtual(SERVER_ID, 'evt-remote-1')), 4000)
  assert.equal(frames.some((frame) => frame.terminal), false)
})

test('CP5: a 429 on the reopened $events leg is a $zr/events ring record and the leg waits out the doubled delay', async (t) => {
  const { relay, clock, client, handle, frames } = await bootEvents(t)

  // Kill the current leg cleanly; the reopen attempt draws the 429.
  relay.state.firstStreamRefusal = { status: 429, body: { ok: false, error: { code: 'too-many-streams' } } }
  relay.state.streams[0].write({ type: 'end' })
  relay.state.streams[0].end()
  await waitFor(() => clock.pending === 1)
  clock.advance(1000)
  await waitFor(() => handle.diagnostics().recentFailures.at(-1)?.code === 'too-many-streams')
  assert.equal(handle.diagnostics().recentFailures.at(-1).endpoint, '$zr/events', 'the refusal landed on the events leg')
  assert.equal(client.state, 'online')
  // The empty spin doubles the delay: 1s of advance must not reopen.
  await waitFor(() => clock.pending === 1)
  clock.advance(1000)
  await flushAsync()
  assert.equal(relay.state.streams.length, 1, 'the doubled 2s delay is still running')
  clock.advance(1000)
  await waitFor(() => relay.state.streams.length === 2, 4000)
  relay.state.streams[1].write({ type: 'frame', frame: EVENTS_WATERFALL })
  await waitFor(() => frames.some((frame) => frame.eventId === toVirtual(SERVER_ID, 'evt-remote-1')), 4000)
  assert.equal(frames.some((frame) => frame.terminal), false, 'the 429 never reached the UI as an error')
})

const {
  SERVER_ID: H_SERVER_ID,
  LOCAL_ID,
  VIRTUAL_ID,
  SERVER_MARK,
  MARK,
  P,
  FakeTypertGateway,
  createFakeRelay,
  makeLog,
  clockWithFakeNow,
  install,
  drained,
  createGate,
  createControllableRelay,
  createMergeGateway,
  readSome,
  waitForStream,
  flushAsync,
  LOCAL_WS,
  LOCAL_BASELINE: H_LOCAL_BASELINE,
  remoteWorkspace,
  REMOTE_BASELINE,
  createUiModel,
  EVT,
  READY,
  LOCAL_WATERFALL,
  SERVER_WATERFALL,
  V_REMOTE_EVENT,
  openMergedEvents,
  waitUntil,
} = require('./helpers/intercept-harness.cjs')
const { CLIENT_METHOD_FIELDS, OPTIONAL_CLIENT_METHOD_FIELDS, REMOTE_READ_METHODS, REMOTE_UPLINK_STREAM_METHODS, SESSION_STREAM_HOLD_ENDPOINTS, isRemoteWrite } = require('../lib/intercept.js')
const { RelayError } = require('../lib/relay-client.js')

// -- T34: offline writes, status annotations, closed sessions ------------------------

test('T34: every write method is refused remote-offline while the relay is not online, and never reaches the relay', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  relay.transition('offline')
  const writes = [
    ['session/prompt', { request: { sessionId: VIRTUAL_ID, content: [{ type: 'text', text: 'hi' }] } }],
    ['session/cancel', { request: { sessionId: VIRTUAL_ID } }],
    ['session/rename', { request: { sessionId: VIRTUAL_ID, title: 'x' } }],
    ['session/selectModel', { request: { sessionId: VIRTUAL_ID, selection: { provider: 'p', model: 'm' } } }],
    ['session/updateQueue', { request: { sessionId: VIRTUAL_ID, itemId: 'q', action: { kind: 'remove' } } }],
    ['job/kill', { request: { sessionId: VIRTUAL_ID, jobId: 'j' } }],
    ['messageFeedback/put', { request: { sessionId: VIRTUAL_ID, messageId: 'm', rating: 'up' } }],
    ['messageFeedback/delete', { request: { sessionId: VIRTUAL_ID, messageId: 'm' } }],
    ['workspace/pinSession', { request: { sessionId: VIRTUAL_ID } }],
    ['workspace/unpinSession', { request: { sessionId: VIRTUAL_ID } }],
    ['workspace/archiveSession', { request: { sessionId: VIRTUAL_ID } }],
    ['workspace/unarchiveSession', { request: { sessionId: VIRTUAL_ID } }],
  ]
  for (const [endpoint, request] of writes) {
    const envelope = await gateway.rpcBridge(endpoint, { args: request }, undefined, gateway.operatorPeer())
    assert.deepEqual(envelope, { ok: false, error: { code: 'remote-offline', message: '服务端离线，远程会话暂时只读', details: {} } }, endpoint)
  }
  assert.deepEqual(relay.invokes, [], 'not one write traveled')
  assert.equal(gateway.rpcCalls.length, 0, 'the local gateway never saw them either')
  handle.uninstall()
})

test('T34: a read method still forwards while offline (its own transport error answers it)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  relay.transition('offline')
  const envelope = await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, gateway.operatorPeer())
  assert.equal(relay.invokes.length, 1, 'the read was forwarded as today')
  assert.equal(envelope.ok, true, 'the fake relay answers; the REAL client would fail the call offline — the point is it was SENT')
  // the same session answering again once online: the refusal must be gone
  relay.transition('online')
  const write = await gateway.rpcBridge('session/rename', { args: { request: { sessionId: VIRTUAL_ID, title: 'x' } } }, undefined, gateway.operatorPeer())
  assert.equal(write.ok, true)
  handle.uninstall()
})

test('T34: the relay going offline annotates the shown group titles （离线）; the reopened baseline restores them', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(H_LOCAL_BASELINE)
  await readSome(iterator, 1)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  await readSome(iterator, 5)

  relay.transition('offline')
  // the transport death takes the in-flight leg with it, like the real
  // client's stream does on an outage (the pump then parks on waitOnline)
  relay.streams[0].gate.throwNow(new RelayError('offline', '链路断了'))
  const annotated = await readSome(iterator, 2)
  assert.deepEqual(annotated.map((frame) => frame.type), ['upsert', 'upsert'])
  assert.equal(annotated[0].workspace.title, '主服务器 · 远端一（离线）')
  assert.equal(annotated[1].workspace.title, '主服务器 · 远端二（离线）')

  // local frames keep merging under the annotation while offline
  localGate.push({ type: 'order', workspaceIds: ['ws-local'] })
  assert.deepEqual(await readSome(iterator, 1), [
    { type: 'order', workspaceIds: ['ws-local', toVirtual(H_SERVER_ID, 'w-1'), toVirtual(H_SERVER_ID, 'w-2')] },
  ])

  // back online: the annotation clears with its own plain-title upserts
  // right away (T34-fix — the leg may not reopen), then the reopened leg's
  // baseline refreshes the content
  relay.transition('online')
  const cleared = await readSome(iterator, 2)
  assert.equal(cleared[0].workspace.title, '主服务器 · 远端一')
  assert.ok(cleared.every((frame) => !(frame.workspace?.title ?? '').includes('（离线）')))
  await waitForStream(relay, 2)
  relay.streams[1].gate.push(REMOTE_BASELINE)
  const refreshed = await readSome(iterator, 5)
  assert.equal(refreshed[0].workspace.title, '主服务器 · 远端一')
  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('T34: revoked keeps the group and annotates 令牌已吊销; re-pair restores', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(H_LOCAL_BASELINE)
  await readSome(iterator, 1)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  await readSome(iterator, 5)

  relay.transition('revoked')
  const annotated = await readSome(iterator, 2)
  assert.deepEqual(annotated.map((frame) => frame.type), ['upsert', 'upsert'])
  assert.equal(annotated[0].workspace.title, '主服务器 · 远端一（令牌已吊销）')
  assert.ok(relay.streams[0].aborted, 'the in-flight leg was cut')

  relay.transition('online')
  const cleared = await readSome(iterator, 2)
  assert.equal(cleared[0].workspace.title, '主服务器 · 远端一')
  await waitForStream(relay, 2)
  relay.streams[1].gate.push(REMOTE_BASELINE)
  const restored = await readSome(iterator, 5)
  assert.equal(restored[0].workspace.title, '主服务器 · 远端一')
  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('T34: a version mismatch (compat.different) annotates 版本有差异 while online; offline outranks it', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay({
    compat: { identical: ['session'], different: ['workspace'], unavailable: [] },
  })
  const { handle } = install(gateway, relay)
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(H_LOCAL_BASELINE)
  await readSome(iterator, 1)
  // the FIRST baseline already carries the annotation (set at stream start)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  const mismatched = await readSome(iterator, 5)
  assert.equal(mismatched[0].workspace.title, '主服务器 · 远端一（版本有差异）')

  // offline outranks the mismatch: the titles re-annotate 离线
  relay.transition('offline')
  const annotated = await readSome(iterator, 2)
  assert.equal(annotated[0].workspace.title, '主服务器 · 远端一（离线）')
  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('T34: an unshared error line registers the closed session with its structured reason', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  relay.streamFrames = [{ type: 'snapshot', header: { id: LOCAL_ID } }]
  relay.streamThrow = new RelayError('unshared', 'shared session session-x was unshared (idle)', undefined, 'idle')
  await assert.rejects(
    drained(gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined })),
    (error) => error.code === 'unshared',
  )
  assert.deepEqual(handle.diagnostics().closedSessions, [{ sessionId: VIRTUAL_ID, reason: 'idle' }])

  // an unknown (or absent) reason degrades to manual — an older server's
  // frame has no reason field at all
  relay.streamFrames = [{ type: 'snapshot', header: { id: LOCAL_ID } }]
  relay.streamThrow = new RelayError('unshared', 'shared session session-x was unshared')
  await assert.rejects(
    drained(gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined })),
    (error) => error.code === 'unshared',
  )
  assert.deepEqual(handle.diagnostics().closedSessions, [{ sessionId: VIRTUAL_ID, reason: 'manual' }])
  handle.uninstall()
})

test('T34: a successful call for the session clears its closed entry; a reconnect clears them all', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  relay.streamFrames = []
  relay.streamThrow = new RelayError('unshared', 'closed', undefined, 'client')
  await assert.rejects(
    drained(gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined })),
    (error) => error.code === 'unshared',
  )
  assert.equal(handle.diagnostics().closedSessions.length, 1)

  // a succeeding invoke for the SAME session proves it is served again
  relay.streamThrow = undefined
  relay.invokeValue = { ok: 1 }
  const page = await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, gateway.operatorPeer())
  assert.equal(page.ok, true)
  assert.deepEqual(handle.diagnostics().closedSessions, [], 'the per-session clear ran')

  // register two, then the SAME session replaces its entry, not appends —
  // and a reconnect clears NOTHING (T34-fix): a link that flapped under a
  // still-standing closure would make the banner flicker away and back
  for (const reason of ['manual', 'idle']) {
    relay.streamFrames = []
    relay.streamThrow = new RelayError('unshared', 'closed', undefined, reason)
    await assert.rejects(
      drained(gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined })),
      (error) => error.code === 'unshared',
    )
  }
  assert.equal(handle.diagnostics().closedSessions.length, 1, 'the same session replaced its entry, not appended')
  relay.transition('online')
  assert.equal(handle.diagnostics().closedSessions.length, 1, 'a reconnect clears nothing — the closure outlived the flap')
  // the ONLY clear is the session proving itself served again
  relay.streamThrow = undefined
  relay.invokeValue = { ok: 1 }
  await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, gateway.operatorPeer())
  assert.deepEqual(handle.diagnostics().closedSessions, [], 'the per-session clear ran')
  handle.uninstall()
})

test('T34: the closed registry caps at 200 entries', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  for (let i = 0; i < 205; i += 1) {
    const id = toVirtual(H_SERVER_ID, `session-${i}`)
    relay.streamFrames = []
    relay.streamThrow = new RelayError('unshared', 'closed', undefined, 'idle')
    await assert.rejects(
      drained(gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: id } } } }, undefined, undefined, undefined, { signal: undefined })),
      (error) => error.code === 'unshared',
    )
  }
  const closed = handle.diagnostics().closedSessions
  assert.equal(closed.length, 200)
  assert.equal(closed[0].sessionId, toVirtual(H_SERVER_ID, 'session-5'), 'the oldest entries were evicted')
  assert.equal(closed[199].sessionId, toVirtual(H_SERVER_ID, 'session-204'))
  handle.uninstall()
})


// -- T32: the $events/result answer split ---------------------------------------------

test('$events/result: a virtual eventId rides postEventResult with the ORIGINAL id and never the local gateway', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const outcome = { kind: 'result', value: 'allowed-once' }
  const envelope = await gateway.rpcBridge(
    '$events/result',
    { args: { clientId: 'local-stream-client', eventId: V_REMOTE_EVENT, outcome } },
    undefined,
    undefined,
  )
  assert.deepEqual(envelope, { ok: true, value: undefined })
  assert.deepEqual(relay.results, [{ eventId: 'a1b2c3d4e5f60718.evt-remote-1', result: outcome, signal: undefined }])
  assert.equal(gateway.rpcCalls.filter((call) => call.endpoint === '$events/result').length, 0, 'the local DSH never saw it')
  handle.uninstall()
})

test('$events/result: a local eventId reaches the local gateway verbatim, the relay untouched', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const payload = { args: { clientId: 'local-stream-client', eventId: 'evt-local-1', outcome: { kind: 'result', value: 'ok' } } }
  const envelope = await gateway.rpcBridge('$events/result', payload, undefined, undefined)
  assert.deepEqual(envelope, { ok: true, value: { endpoint: '$events/result' } })
  assert.equal(gateway.rpcCalls.filter((call) => call.endpoint === '$events/result').length, 1)
  assert.deepEqual(gateway.rpcCalls[0].payload, payload)
  assert.equal(relay.results.length, 0)
  handle.uninstall()
})

test('$events/result: a foreign server id or a missing handshake refuses locally with details intact', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const mismatch = await gateway.rpcBridge(
    '$events/result',
    { args: { clientId: 'c', eventId: toVirtual('ffffffff', 'evt-x'), outcome: { kind: 'next' } } },
    undefined,
    undefined,
  )
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.error.code, 'remote-mismatch')
  assert.deepEqual(mismatch.error.details, {})
  assert.equal(relay.results.length, 0)
  handle.uninstall()

  // T34-fix: a missing handshake (and an offline relay alike) answers the
  // SILENT ok now, not a refusal — RT dsh-api-gateway's answer() throws on a
  // !response.ok body and the pump aborts the UI's whole $events generation,
  // so the offline refusal is recorded in the ring instead.
  const offline = new FakeTypertGateway()
  const offlineRelay = createControllableRelay()
  const offlineInstall = install(offline, offlineRelay, { getServerId: () => undefined })
  const refused = await offline.rpcBridge(
    '$events/result',
    { args: { clientId: 'c', eventId: toVirtual(H_SERVER_ID, 'evt-x'), outcome: { kind: 'next' } } },
    undefined,
    undefined,
  )
  assert.deepEqual(refused, { ok: true, value: undefined })
  assert.equal(offlineRelay.results.length, 0, 'nothing traveled')
  const ring = offlineInstall.handle.diagnostics().recentFailures
  assert.deepEqual([ring[ring.length - 1].endpoint, ring[ring.length - 1].code], ['$events/result', 'remote-offline'])
  offlineInstall.handle.uninstall()
})

test('$events/result: an already-over event answers silent ok — the UI stream must not fail', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  for (const code of ['unknown-event', 'not-shared']) {
    relay.resultThrow = new RelayError(code, 'no subscription forwarded it', 403)
    const envelope = await gateway.rpcBridge(
      '$events/result',
      { args: { clientId: 'c', eventId: toVirtual(H_SERVER_ID, 'evt-gone'), outcome: { kind: 'next' } } },
      undefined,
      undefined,
    )
    // Same answer DSH gives a stale result (receiveRemoteEventResult no-ops):
    // a thrown answer would fail the UI's whole $events generation.
    assert.deepEqual(envelope, { ok: true, value: undefined }, code)
  }
  assert.equal(handle.diagnostics().recentFailures.length, 0, 'not a call failure — the ring stays out of it')

  // T32-fix2: the silent-ok mapping is pinned to the route's 403 — the same
  // code string arriving on any other status is a different fault and keeps
  // the refusal envelope (recorded in the diagnostics ring).
  relay.resultThrow = new RelayError('unknown-event', 'not the answer route', 200)
  const notSilent = await gateway.rpcBridge(
    '$events/result',
    { args: { clientId: 'c', eventId: toVirtual(H_SERVER_ID, 'evt-gone'), outcome: { kind: 'next' } } },
    undefined,
    undefined,
  )
  assert.equal(notSilent.ok, false)
  assert.equal(notSilent.error.code, 'unknown-event')
  assert.deepEqual(notSilent.error.details, {})
  const failures = handle.diagnostics().recentFailures
  assert.equal(failures[failures.length - 1].code, 'unknown-event')
  handle.uninstall()
})

test('$events/result: a real relay failure maps onto the failure envelope with details', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createControllableRelay()
  relay.resultThrow = new RelayError('offline', 'the relay chain answered 502', 502)
  const { handle } = install(gateway, relay)
  const envelope = await gateway.rpcBridge(
    '$events/result',
    { args: { clientId: 'c', eventId: toVirtual(H_SERVER_ID, 'evt-gone'), outcome: { kind: 'next' } } },
    undefined,
    undefined,
  )
  assert.deepEqual(envelope, {
    ok: false,
    error: { code: 'offline', message: 'the relay chain answered 502', details: {} },
  })
  const failures = handle.diagnostics().recentFailures
  assert.deepEqual(failures[failures.length - 1], { endpoint: '$events/result', code: 'offline', time: failures[failures.length - 1].time })
  handle.uninstall()
})

// -- T32-fix: orphan prompts and leg-end closes --------------------------------------

test('merged $events T32-fix: a dying leg closes every prompt it showed, a remote emit never travels', async () => {
  const relay = createControllableRelay()
  const { localGate, iterator } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  await waitForStream(relay, 1)
  const gate = relay.streams[0].gate

  // Remote emits are dropped outright (second line of defense).
  gate.push({ type: 'emit', event: 'api-session/added', args: [{ sessionId: 's', title: 'x' }] })
  gate.push(SERVER_WATERFALL)
  const [waterfall] = await readSome(iterator, 1)
  assert.equal(waterfall.eventId, V_REMOTE_EVENT, 'the emit never reached the UI, the waterfall did')

  // The leg dies with the prompt still open: the UI gets the exact cancel
  // shape its client face closes a waterfall on (type + eventId only).
  gate.throwNow(new RelayError('offline', 'the relay chain answered 502'))
  const [orphan] = await readSome(iterator, 1)
  assert.deepEqual(orphan, { type: 'cancel', eventId: V_REMOTE_EVENT })

  // The reopen re-delivers the still-pending event (fresh leg, fresh
  // record): the prompt legitimately comes back. The first 'online' this
  // stream sees also fires the T52 catalog-refresh emit (the fake notifies
  // without a real state change — in production the recovery transition
  // offline→online is exactly when the refresh belongs).
  relay.transition('online')
  await waitForStream(relay, 2)
  relay.streams[1].gate.push(SERVER_WATERFALL)
  const [refresh, again] = await readSome(iterator, 2)
  assert.deepEqual(refresh, { type: 'emit', event: 'llm/adapters-updated', args: [] })
  assert.equal(again.eventId, V_REMOTE_EVENT)
  await iterator.return?.(undefined)
})

test('merged $events T32-fix: a real cancel clears the record — a leg end does not double-close', async () => {
  const relay = createControllableRelay()
  const { localGate, iterator } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  await waitForStream(relay, 1)
  const gate = relay.streams[0].gate

  gate.push(SERVER_WATERFALL)
  const [waterfall] = await readSome(iterator, 1)
  assert.equal(waterfall.eventId, V_REMOTE_EVENT)
  // The server settled it: the real cancel closes the prompt AND the record.
  gate.push({ type: 'cancel', eventId: 'a1b2c3d4e5f60718.evt-remote-1' })
  const [cancel] = await readSome(iterator, 1)
  assert.deepEqual(cancel, { type: 'cancel', eventId: V_REMOTE_EVENT })

  // Now the leg dies: nothing is shown anymore, so nothing is synthesized.
  gate.throwNow(new RelayError('offline', 'gone'))
  relay.transition('online')
  await flushAsync()
  // Prove liveness and the absence of a second cancel with a local frame —
  // behind the T52 refresh emit this stream's first 'online' produced.
  localGate.push(LOCAL_WATERFALL)
  const [refresh, local] = await readSome(iterator, 2)
  assert.deepEqual(refresh, { type: 'emit', event: 'llm/adapters-updated', args: [] })
  assert.deepEqual(local, LOCAL_WATERFALL, 'no synthesized cancel arrived after the real one')
  await iterator.return?.(undefined)
})

test('merged $events T32-fix: a repeat waterfall within one leg is not re-shown', async () => {
  const relay = createControllableRelay()
  const { localGate, iterator } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  await waitForStream(relay, 1)
  const gate = relay.streams[0].gate
  gate.push(SERVER_WATERFALL)
  gate.push(SERVER_WATERFALL)
  const [waterfall] = await readSome(iterator, 1)
  assert.equal(waterfall.eventId, V_REMOTE_EVENT)
  localGate.push(LOCAL_WATERFALL)
  const [local] = await readSome(iterator, 1)
  assert.deepEqual(local, LOCAL_WATERFALL, 'the duplicate never arrived between the frames')
  await iterator.return?.(undefined)
})


// -- T34-fix: annotation restore semantics, read-whitelist guard, offline answers ----

test('T34-fix: a version mismatch survives an offline round trip (PROBE1) — the reopened baseline keeps the annotation', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay({ compat: { identical: ['session'], different: ['workspace'], unavailable: [] } })
  const { handle } = install(gateway, relay)
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(H_LOCAL_BASELINE)
  await readSome(iterator, 1)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  await readSome(iterator, 5)

  relay.transition('offline')
  relay.streams[0].gate.throwNow(new RelayError('offline', 'x'))
  await readSome(iterator, 2)
  relay.transition('online')
  // the clear's own upserts land with the online transition; the recomputed
  // annotation is the MISMATCH again (the real relay re-evaluates compat
  // before the online transition) — wait, no: the transition itself emits
  // with annotationOf('online') = mismatch, so these upserts carry it
  const restored = await readSome(iterator, 2)
  assert.equal(restored[0].workspace.title, '主服务器 · 远端一（版本有差异）', 'the mismatch annotation survived the outage')
  await waitForStream(relay, 2)
  relay.streams[1].gate.push(REMOTE_BASELINE)
  const remerged = await readSome(iterator, 5)
  assert.equal(remerged[0].workspace.title, '主服务器 · 远端一（版本有差异）', 'and the reopened baseline carries it too')
  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('T34-fix: an offline flap with the stream STILL ALIVE restores the titles on online without a reopen (PROBE2)', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(H_LOCAL_BASELINE)
  await readSome(iterator, 1)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  await readSome(iterator, 5)

  // one invoke 502s the relay into offline; the workspace/follow stream is
  // untouched
  relay.transition('offline')
  const off = await readSome(iterator, 2)
  assert.equal(off[0].workspace.title, '主服务器 · 远端一（离线）')

  // the next invoke succeeds: back online. The stream does NOT reopen —
  // the clear's own upserts are the only restore path (the old code left
  // the titles stuck at 离线 forever here).
  relay.transition('online')
  const restored = await readSome(iterator, 2)
  assert.deepEqual(restored.map((frame) => frame.type), ['upsert', 'upsert'])
  assert.equal(restored[0].workspace.title, '主服务器 · 远端一', 'the titles restored without a reopen')
  await flushAsync()
  assert.equal(relay.streams.length, 1, 'no reopen — the leg never died')
  // and the stream keeps flowing merged under the plain titles
  localGate.push({ type: 'order', workspaceIds: ['ws-local'] })
  assert.deepEqual(await readSome(iterator, 1), [
    { type: 'order', workspaceIds: ['ws-local', toVirtual(H_SERVER_ID, 'w-1'), toVirtual(H_SERVER_ID, 'w-2')] },
  ])
  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('T34-fix: every client-table method classifies read or write; the T31 writes are writes', () => {
  // The guard: any FUTURE table entry must be classified explicitly before
  // this passes — an unclassified method is a write by rule, and the test
  // list below is the review surface that keeps that rule honest.
  const writes = new Set([
    'session/prompt',
    'session/cancel',
    'session/rename',
    'session/selectModel',
    'session/updateQueue',
    'session/create',
    'session/fork',
    'subagents/prompt',
    'subagents/interruptByParent',
    'subagents/interruptByUser',
    'fileUploads/upload',
    'job/kill',
    'messageFeedback/put',
    'messageFeedback/delete',
    'workspace/pinSession',
    'workspace/unpinSession',
    'workspace/archiveSession',
    'workspace/unarchiveSession',
    'workspace/insertSessionBefore',
    // T41a mutations
    'goals/edit',
    'goals/create',
    'goals/complete',
    'goals/pause',
    'goals/resume',
    'goals/clear',
    'agentTeams/setEnabled',
    'userQuestions/answer',
    'actionCards/act',
    'commands/execute',
    'agentPresets/select',
    'sessionFeedback/record',
    'terminal/create',
    'terminal/write',
    'terminal/resize',
    'terminal/rename',
    'terminal/close',
    // T41a-fix2: follow ATTACHES with exclusive input control ("an older
    // attachment becomes read-only", RT dsh-api-terminal-controller) — a
    // state change, refused offline like every other mutation.
    'terminal/follow',
    // TA-1: the 0.2.2 duplex stream — same attachment semantics as follow
    // (exclusive input control) plus the write/resize uplink, so it sits on
    // the write side too (refused remote-offline). The interceptor's own
    // uplink wiring lands in TA-2.
    'terminal/attach',
    // API-4: 18 forgePanel write mutations
    'forgePanel/requestWorktree',
    'forgePanel/cancelWorktree',
    'forgePanel/continueInProject',
    'forgePanel/restoreWorktree',
    'forgePanel/retryWorktree',
    'forgePanel/stopCreation',
    'forgePanel/worktreeCleanup',
    'forgePanel/refresh',
    'forgePanel/track',
    'forgePanel/dismiss',
    'forgePanel/setFileViewed',
    'forgePanel/changeRequestReviewWrite',
    'forgePanel/submitReview',
    'forgePanel/requestReviews',
    'forgePanel/rerunChecks',
    'forgePanel/markReady',
    'forgePanel/updateBranch',
    'forgePanel/merge',
    // D23-5: sessionStatus reading mark
    'sessionStatus/mark',
    // D23-6: forgePanel reviewStage mutation
    'forgePanel/reviewStage',
  ])
  for (const endpoint of Object.keys(CLIENT_METHOD_FIELDS)) {
    assert.ok(
      REMOTE_READ_METHODS.has(endpoint) || writes.has(endpoint),
      `${endpoint} must be classified read or write`,
    )
  }
  // T31's five mutations are writes — refused remote-offline while offline.
  for (const endpoint of ['session/create', 'session/fork', 'subagents/prompt', 'subagents/interruptByParent', 'subagents/interruptByUser', 'fileUploads/upload']) {
    assert.equal(isRemoteWrite(endpoint), true, endpoint)
  }
  // spot-check the read side (the full list lives in the source comment)
  for (const endpoint of ['session/page', 'session/attachment', 'session/list', 'fileReferences/list', 'job/list', 'workspace/follow']) {
    assert.equal(isRemoteWrite(endpoint), false, endpoint)
  }
  // TA-2: the duplex set names exactly the stream the host feeds an uplink
  // into; every member must be a table entry and a WRITE (an uplink is input
  // — offline it refuses rather than silently swallowing keystrokes).
  assert.deepEqual([...REMOTE_UPLINK_STREAM_METHODS], ['terminal/attach'])
  for (const endpoint of REMOTE_UPLINK_STREAM_METHODS) {
    assert.ok(CLIENT_METHOD_FIELDS[endpoint] !== undefined, `${endpoint} is in the client table`)
    assert.equal(isRemoteWrite(endpoint), true, endpoint)
  }
})

test('T34-fix: the T31 writes are refused remote-offline while the relay is not online', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  relay.transition('offline')
  const writes = [
    ['session/create', { args: { request: { workspaceId: toVirtual(H_SERVER_ID, 'w-1'), title: 'x' } } }],
    ['session/fork', { args: { request: { sessionId: VIRTUAL_ID } } }],
    ['subagents/prompt', { args: { request: { parentSessionId: VIRTUAL_ID, content: [{ type: 'text', text: 'hi' }] } } }],
    ['subagents/interruptByParent', { args: { parentSessionId: VIRTUAL_ID } }],
    ['subagents/interruptByUser', { args: { childSessionId: VIRTUAL_ID } }],
    ['fileUploads/upload', { args: { agentId: VIRTUAL_ID } }],
  ]
  for (const [endpoint, payload] of writes) {
    const envelope = await gateway.rpcBridge(endpoint, payload, undefined, gateway.operatorPeer())
    assert.deepEqual(envelope, { ok: false, error: { code: 'remote-offline', message: '服务端离线，远程会话暂时只读', details: {} } }, endpoint)
  }
  assert.deepEqual(relay.invokes, [], 'nothing traveled')
  handle.uninstall()
})

test('T34-fix: an offline answer to a virtual eventId is the SILENT ok plus a ring record — a refusal would restart the UI $events generation', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  // Offline with a live handshake (the real shape: the token died mid-party,
  // some other call 502ed the relay into offline).
  relay.transition('offline')
  const payload = { args: { eventId: toVirtual(H_SERVER_ID, 'tok-1.e-9'), outcome: { kind: 'next' } } }
  const envelope = await gateway.rpcBridge('$events/result', payload, undefined, gateway.operatorPeer())
  // RT dsh-api-gateway client face: answer() throws on a !response.ok body
  // and the pump aborts the WHOLE generation — so the offline answer must be
  // the same silent ok DSH itself gives a stale result.
  assert.deepEqual(envelope, { ok: true, value: undefined })
  assert.equal(relay.results.length, 0, 'nothing traveled to the relay')
  assert.equal(gateway.rpcCalls.length, 0, 'the local gateway stayed out')
  const ring = handle.diagnostics().recentFailures
  assert.deepEqual([ring[ring.length - 1].endpoint, ring[ring.length - 1].code], ['$events/result', 'remote-offline'], 'the refusal is recorded, not silent everywhere')

  // Never handshook: the same silent ok.
  const fresh = new FakeTypertGateway()
  const freshRelay = createControllableRelay()
  const { handle: freshHandle } = install(fresh, freshRelay, { getServerId: () => undefined })
  const unpaired = await fresh.rpcBridge('$events/result', payload, undefined, undefined)
  assert.deepEqual(unpaired, { ok: true, value: undefined })
  assert.equal(freshRelay.results.length, 0)
  freshHandle.uninstall()
  handle.uninstall()
})

test('T34-fix: a session-scoped stream refused not-shared registers the closure (reason manual); an offline death holds the stream open instead (CP4)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  // The closure happened before this page even opened: the open fails with
  // the server's 403 not-shared — no event was observed, so the reason
  // degrades to manual.
  relay.streamThrow = new RelayError('not-shared', 'the session is not shared')
  await assert.rejects(
    drained(gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined })),
    (error) => error.code === 'not-shared',
  )
  assert.deepEqual(handle.diagnostics().closedSessions, [{ sessionId: VIRTUAL_ID, reason: 'manual' }])

  // A mere offline death is a link fact (CP4): the UI stream is NOT failed —
  // it holds open and silent while the relay is down, then the leg reopens
  // IN PLACE once the relay serves again (no frame was accepted yet, so a
  // clean end would be the UI's "ended before its opening snapshot"
  // protocol violation) and the frames flow. The registry survives the hold
  // itself.
  // The relay goes down BEFORE the error is caught (the real client parks
  // `offline` inside streamLines before the throw) so the hold parks on the
  // state wait; the still-online backoff path is the recovery file's business.
  relay.transition('offline')
  relay.streamThrow = new RelayError('offline', '链路断了')
  const held = drained(gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined }))
  let settled = false
  held.then(() => { settled = true }, () => { settled = true })
  await flushAsync()
  assert.equal(settled, false, 'the stream held open through the outage — no frames, no error')
  assert.deepEqual(handle.diagnostics().closedSessions, [{ sessionId: VIRTUAL_ID, reason: 'manual' }], 'the registry is unchanged through the outage')
  relay.streamThrow = undefined
  relay.streamFrames = [{ type: 'snapshot', header: { id: LOCAL_ID } }]
  relay.transition('online')
  assert.deepEqual(await held, [{ type: 'snapshot', header: { id: VIRTUAL_ID } }])
  // And the delivered frame proved the session is served again — the stale
  // not-shared entry clears exactly as T34 designed it (per session, on
  // success — never wholesale on a reconnect).
  assert.deepEqual(handle.diagnostics().closedSessions, [], 'frames flowing again cleared the stale closure')
  handle.uninstall()
})

// -- CP4: stream-route offline writes, carrier-style recovery, switch guards,
//    closed-session tombstones -----------------------------------------------------

test('CP4: a WRITE stream opened while the relay is offline refuses remote-offline like the invoke route', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  // terminal/follow is the one write-shaped STREAM in the table: its
  // attachment takes over the terminal's input control, so opening it into a
  // dead link must refuse locally instead of failing out there (fix 2).
  // The refusal is at CALL time — a sync throw (the real host's async
  // openWireStream turns it into a rejected open).
  relay.transition('offline')
  assert.throws(
    () => gateway.wireTap('terminal/follow', { args: { agentId: VIRTUAL_ID } }, undefined, undefined, undefined, { signal: undefined }),
    (error) => error.code === 'remote-offline',
  )
  assert.deepEqual(relay.streams, [], 'nothing reached the relay')
  assert.equal(handle.diagnostics().recentFailures.at(-1).endpoint, 'terminal/follow')
  assert.equal(handle.diagnostics().recentFailures.at(-1).code, 'remote-offline')
  // A READ opened offline still forwards (its own transport error answers
  // it) — the refusal is write-shaped only, on both routes.
  const readEnvelope = await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  assert.equal(readEnvelope.ok, true, 'the fake relay answered; the REAL client would fail the call offline — the point is it was SENT')
  assert.equal(relay.invokes.length, 1, 'the read went out')
  handle.uninstall()
})

test('CP4 (SPEC 54): a session stream that died offline mid-flight ends CLEANLY once the relay serves again — the end the RT UI retries as a carrier failure', async () => {
  const relay = createControllableRelay()
  const gateway = new FakeTypertGateway()
  const { handle } = install(gateway, relay)
  const seen = []
  // Generation 1, consumed like the RT's RemoteStream: frames are accepted,
  // a THROW would be terminal, a CLEAN end after acceptance is the carrier
  // signal the client face retries.
  const outcome = (async () => {
    try {
      for await (const frame of await gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined })) {
        seen.push(frame)
      }
      return 'ended-clean'
    } catch (error) {
      return `threw:${error.code}`
    }
  })()
  await waitForStream(relay, 1)
  relay.streams[0].gate.push({ type: 'snapshot', header: { id: LOCAL_ID } })
  await waitUntil(() => seen.length === 1)
  assert.deepEqual(seen, [{ type: 'snapshot', header: { id: VIRTUAL_ID } }])

  // The link dies: NO terminal error reaches the UI stream — it holds silent
  // (the T34 offline banner explains the pause).
  relay.transition('offline')
  relay.streams[0].gate.throwNow(new RelayError('offline', '链路断了'))
  await flushAsync()
  assert.equal(seen.length, 1, 'nothing further arrived while offline')

  // The relay serves again: the consumed generation ends CLEANLY — RT
  // dsh-api-gateway turns an accepted clean end into
  // `RemoteStreamCarrierError("… ended without a terminal result")` and
  // retries immediately — instead of the terminal RemoteError the old code
  // produced (the frozen-page bug).
  relay.transition('online')
  assert.equal(await outcome, 'ended-clean', 'the UI stream ended without any error after recovery')

  // The RT retry reopens through the same wrapper and gets a fresh snapshot.
  const retried = []
  const generation2 = (async () => {
    try {
      for await (const frame of await gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined })) {
        retried.push(frame)
      }
      return 'ended-clean'
    } catch (error) {
      return `threw:${error.code}`
    }
  })()
  await waitForStream(relay, 2)
  relay.streams[1].gate.push({ type: 'snapshot', header: { id: LOCAL_ID } })
  relay.streams[1].gate.push({ type: 'event', event: { seq: 9 } })
  await waitUntil(() => retried.length === 2)
  assert.equal(retried[0].header.id, VIRTUAL_ID, 'the retry re-snapshotted through the recovered relay')
  relay.streams[1].gate.finish()
  assert.equal(await generation2, 'ended-clean')
  handle.uninstall()
})

test('CP4: a frame the aborted generation already decoded never reaches the merger (the switch guard, mutation coverage for the generation break)', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(H_LOCAL_BASELINE)
  await readSome(iterator, 1)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  await readSome(iterator, 5)

  // Park the pump inside the remote leg, then queue one frame that the abort
  // below must drop: the transport may hand over lines it already decoded,
  // and they belong to a generation the serverId switch just killed. The
  // shrunken sessionIds tombstones session-b into the group — the padded
  // upsert is read off here, alone (no archived frame rides along since
  // CP4-client-fix2).
  relay.streams[0].gate.push({ type: 'upsert', workspace: remoteWorkspace('w-1', '更新', ['session-a']) })
  const parked = await readSome(iterator, 1)
  assert.deepEqual(parked.map((frame) => frame.type), ['upsert'])
  relay.streams[0].gate.push({ type: 'upsert', workspace: remoteWorkspace('w-1', '泄漏', ['session-a']) })
  // Switch servers — no await in between, so the pump is still parked when
  // the onState handler aborts the in-flight controller (reopenNow).
  relay.handshakeInfo = { ...relay.handshakeInfo, serverId: '99999999', serverName: '别服' }
  relay.transition('online')
  // The ONLY outputs are the retarget frames — a leaked frame would surface
  // as a 泄漏 upsert ahead of the removes.
  const frames = await readSome(iterator, 5)
  assert.deepEqual(frames.map((frame) => frame.type), ['remove', 'remove', 'order', 'archived', 'pinned'])
  assert.ok(frames.every((frame) => frame.workspace?.title !== '别服 · 泄漏'), 'the decoded-but-dead frame never reached the merger')

  // The new leg opens against the new server and its baseline flows.
  await waitForStream(relay, 2)
  relay.streams[1].gate.push({ type: 'baseline', value: { items: [remoteWorkspace('x-1', '别组', ['q1'])], archivedSessionIds: [], pinnedSessionIds: [] } })
  const next = await readSome(iterator, 4)
  assert.equal(next[0].workspace.workspaceId, toVirtual('99999999', 'x-1'))
  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('CP4-client-fix2: a session the server stopped serving keeps its group slot in the REAL UI model — no archive kick, no strays, re-share restores it', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const ui = createUiModel()
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(H_LOCAL_BASELINE)
  ;(await readSome(iterator, 1)).forEach(ui.apply)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  ;(await readSome(iterator, 5)).forEach(ui.apply)
  const vA = toVirtual(H_SERVER_ID, 'session-a')
  const vB = toVirtual(H_SERVER_ID, 'session-b')
  const w1 = () => ui.model.items.find((item) => item.workspaceId === toVirtual(H_SERVER_ID, 'w-1'))
  assert.equal(w1().sessionIds.includes(vA), true, 'sanity: session-a is in w-1 before the close')

  // The server closes the remote: the filtered upsert drops the session from
  // the group's sessionIds. The merger tombstones it into w-1 instead of
  // archiving it — the RT navigation guard (dsh-client-ui-workspace
  // watchNavigation → clearArchivedCurrent, lib/client.js:897/957-962: an
  // archived CURRENT session is cleared to the home page) never fires, so
  // the open page stays put for its 「远程已关闭」 banner, and the row can
  // never stray into 「未分组」 (the UI's session store keeps the entry).
  relay.streams[0].gate.push({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['session-b']) })
  const closed = await readSome(iterator, 1)
  assert.deepEqual(closed.map((frame) => frame.type), ['upsert'])
  closed.forEach(ui.apply)
  assert.equal(w1().sessionIds.includes(vA), true, 'the closed session keeps its group slot')
  assert.equal(ui.model.archivedSessionIds.includes(vA), false, 'and is NOT archived-hidden — the open page is not navigated away')

  // Re-sharing returns the session to the live list: exactly once, no
  // tombstone duplicate.
  relay.streams[0].gate.push({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['session-a', 'session-b']) })
  const reshow = await readSome(iterator, 1)
  assert.deepEqual(reshow.map((frame) => frame.type), ['upsert'])
  reshow.forEach(ui.apply)
  assert.equal(w1().sessionIds.filter((id) => id === vA).length, 1, 'restored exactly once — no tombstone duplicate')
  assert.equal(ui.model.archivedSessionIds.includes(vA), false)
  assert.equal(ui.model.archivedSessionIds.includes(vB), true, 'the server-archived session stays archived')
  controller.abort()
  localGate.finish()
  handle.uninstall()
})

// -- CP5: the hold list, the pairing-wall verdict, the session-stream backoff ----

/** Consume one session-level UI stream, classifying how it ended. */
function consumeStream(gateway, endpoint, args) {
  const seen = []
  const outcome = (async () => {
    try {
      for await (const frame of await gateway.wireTap(endpoint, { args }, undefined, undefined, undefined, { signal: undefined })) {
        seen.push(frame)
      }
      return 'ended-clean'
    } catch (error) {
      return `threw:${error.code}`
    }
  })()
  return { seen, outcome }
}

test('CP5 hold list: job/follow (a carrier-retry endpoint) still holds through a link-down and ends cleanly on recovery', async () => {
  const relay = createControllableRelay()
  const gateway = new FakeTypertGateway()
  const { handle } = install(gateway, relay)
  const { seen, outcome } = consumeStream(gateway, 'job/follow', { request: { sessionId: VIRTUAL_ID } })
  await waitForStream(relay, 1)
  relay.streams[0].gate.push({ type: 'opened', job: { id: 'j-1', owner: LOCAL_ID } })
  await waitUntil(() => seen.length === 1)
  assert.equal(seen[0].job.owner, VIRTUAL_ID, 'sanity: the frame flowed and was rewritten')

  // The link dies: NO terminal error reaches the UI stream — the RT
  // job-controller (lib/client.js:269/303) turns an accepted clean end into
  // the RemoteStreamCarrierError it retries, so the hold is what serves it.
  relay.transition('offline')
  relay.streams[0].gate.throwNow(new RelayError('offline', '链路断了'))
  await flushAsync()
  assert.equal(seen.length, 1, 'nothing further arrived while offline')

  relay.transition('online')
  assert.equal(await outcome, 'ended-clean', 'the accepted generation ended cleanly — the carrier signal the job UI retries')
  handle.uninstall()
})

test('CP5 hold list: workspaceFiles/changes (outside the list) ends with the ORIGINAL code the moment the link dies — no hold', async () => {
  const relay = createControllableRelay()
  const gateway = new FakeTypertGateway()
  const { handle } = install(gateway, relay)
  const { outcome } = consumeStream(gateway, 'workspaceFiles/changes', { workspaceFileScopeId: VIRTUAL_ID })
  await waitForStream(relay, 1)

  // The RT consumers of this stream (dsh-api-workspace-files lib/client.js:112,
  // dsh-client-ui-sidebar-files lib/client.js:229) turn ANY clean end into a
  // plain terminal Error with no retry — a hold would freeze the tree on
  // recovery. The old behavior stands: the outage fails the stream at once,
  // with the link error's own code.
  relay.transition('offline')
  relay.streams[0].gate.throwNow(new RelayError('offline', '链路断了'))
  assert.equal(await outcome, 'threw:offline', 'the terminal error carries the original code')
  await flushAsync()
  assert.equal(relay.streams.length, 1, 'no reopen behind the terminal — the stream is over')
  handle.uninstall()
})

test('CP5: the pairing wall ends a held session stream with a terminal error in the wall\'s own code — no silent park, the state listener released', async () => {
  const relay = createControllableRelay()
  // Count LIVE state listeners: the hold parks on one, and the verdict must
  // release it (a leaked listener would tick forever behind a dead stream).
  let liveListeners = 0
  const baseSubscribe = relay.subscribe.bind(relay)
  relay.subscribe = (listener) => {
    liveListeners += 1
    const off = baseSubscribe(listener)
    return () => { liveListeners -= 1; off() }
  }
  const gateway = new FakeTypertGateway()
  const { handle } = install(gateway, relay)

  // revoked: the token died server-side. No ladder climbs back from the
  // wall — the held stream must say so and stop.
  const first = consumeStream(gateway, 'session/follow', { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } })
  await waitForStream(relay, 1)
  relay.transition('offline')
  relay.streams[0].gate.throwNow(new RelayError('offline', '链路断了'))
  await flushAsync()
  const parked = liveListeners
  assert.ok(parked >= 1, 'the hold is parked on a relay state listener')
  relay.transition('revoked')
  assert.equal(await first.outcome, 'threw:revoked', 'the wall ends the hold with its own code')
  assert.equal(first.seen.length, 0, 'no frame ever reached the UI through the outage')
  assert.equal(liveListeners, parked - 1, 'the serve-wait released its state listener')

  // unpaired: the row lost its pairing — same verdict shape, own code.
  const second = consumeStream(gateway, 'session/follow', { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } })
  await waitForStream(relay, 2)
  relay.transition('offline')
  relay.streams[1].gate.throwNow(new RelayError('offline', '链路断了'))
  await flushAsync()
  relay.transition('unpaired')
  assert.equal(await second.outcome, 'threw:unpaired', 'unpaired ends the hold the same way')
  handle.uninstall()
})

test('CP5: waitServeAgain backs off the in-place reopen — state stays online, every retry costs the current step and the step doubles', async () => {
  const relay = createControllableRelay()
  const gateway = new FakeTypertGateway()
  const clock = fakeClock()
  const handle = installIntercept({ raw: gateway, relay, getServerId: () => H_SERVER_ID, clock })
  const { seen, outcome } = consumeStream(gateway, 'session/follow', { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } })
  await waitForStream(relay, 1)

  // The leg dies with `offline` while the relay STILL reads online (an error
  // line that never was a state fact — the exact contradiction that would
  // spin a hot reopen loop without the delayWait). No frame was accepted, so
  // every retry reopens IN PLACE: first after 1s, then 2s, then 4s.
  let settled = false
  outcome.then(() => { settled = true }, () => { settled = true })
  const intervals = []
  let lastOpenAt = null
  for (const [delay, reopenStreams] of [[1_000, 2], [2_000, 3], [4_000, 4]]) {
    relay.streams[reopenStreams - 2].gate.throwNow(new RelayError('offline', '链路断了'))
    await waitUntil(() => clock.pending === 1, 2000)
    if (lastOpenAt === null) lastOpenAt = clock.now()
    clock.advance(delay - 100)
    await flushAsync()
    assert.equal(relay.streams.length, reopenStreams - 1, `no reopen inside the ${delay}ms step`)
    clock.advance(100)
    await waitForStream(relay, reopenStreams)
    intervals.push(clock.now() - lastOpenAt)
    lastOpenAt = clock.now()
  }
  assert.deepEqual(intervals, [1_000, 2_000, 4_000], 'each reopen waited the current step, and the step doubled')
  assert.equal(relay.state, 'online', 'the state never moved through any of it')
  assert.equal(settled, false, 'the UI stream stayed open and silent the whole time')
  assert.equal(seen.length, 0)
  handle.uninstall()
})

test('CP5: a waterfall the aborted $events generation already decoded never reaches the UI (the guard, symmetric with the merged global streams)', async () => {
  const relay = createControllableRelay()
  const { localGate, iterator } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  await waitForStream(relay, 1)
  relay.streams[0].gate.push(SERVER_WATERFALL)
  await readSome(iterator, 1)

  // Park the pump inside the remote leg, then queue one waterfall that the
  // abort below must drop: the transport may hand over lines it had already
  // decoded, and they belong to a generation the server switch just killed.
  const leaked = { ...SERVER_WATERFALL, eventId: 'a1b2c3d4e5f60718.evt-remote-2' }
  relay.streams[0].gate.push(leaked)
  // Switch servers — no await in between, so the pump is still parked when
  // the onState handler aborts the in-flight controller.
  relay.handshakeInfo = { ...relay.handshakeInfo, serverId: 'ffffffff', serverName: '别服' }
  relay.transition('online')
  await waitForStream(relay, 2)
  // The ONLY outputs are the T52 refresh emit (the identity change fired it
  // synchronously in the state listener), the orphan cancel for the SHOWN
  // event, and the new leg's waterfall — a leaked frame would surface among
  // them.
  relay.streams[1].gate.push(SERVER_WATERFALL)
  const frames = await readSome(iterator, 3)
  assert.deepEqual(frames[0], { type: 'emit', event: 'llm/adapters-updated', args: [] })
  assert.deepEqual(frames[1], { type: 'cancel', eventId: V_REMOTE_EVENT }, 'the shown prompt was closed by the leg death')
  assert.equal(frames[2].eventId, toVirtual('ffffffff', 'a1b2c3d4e5f60718.evt-remote-1'), 'the reopened leg delivers under the new ids')
  const leakedOld = toVirtual(H_SERVER_ID, 'a1b2c3d4e5f60718.evt-remote-2')
  const leakedNew = toVirtual('ffffffff', 'a1b2c3d4e5f60718.evt-remote-2')
  assert.ok(
    frames.every((frame) => frame.eventId !== leakedOld && frame.eventId !== leakedNew),
    'the decoded-but-dead waterfall never reached the UI — under either server id',
  )
  await iterator.return?.(undefined)
})

// -- T4: intercept-swr-bridge --------------------------------------------------

function makeFollowSnapshot(cursor, records, extra = {}) {
  return {
    type: 'snapshot',
    header: { id: LOCAL_ID, cwd: '/srv/repo', ...(extra.header ?? {}) },
    cursor,
    records,
    hasMore: extra.hasMore ?? false,
    projections: extra.projections ?? { asOfSeq: cursor, values: { model: 'm1' } },
    assistantStream: extra.assistantStream ?? { revision: 0 },
  }
}

function makeFollowEvent(seq, type = 'message') {
  return { type: 'event', event: { seq, type, time: seq * 1000, data: { text: `msg-${seq}` } } }
}

function attachStreamSpy(relay) {
  const origOpen = relay.openStream.bind(relay)
  relay.streamOptions = []
  relay.openStream = (namespace, method, args, signal, opts) => {
    relay.streamOptions.push({ namespace, method, opts, signal })
    return origOpen(namespace, method, args, signal, opts)
  }
  return relay
}

test('T4 SWR Case A (unchanged): 0ms cached open + background snapshot-sync(unchanged) + assistantStream revision offset', async () => {
  const relay = attachStreamSpy(createControllableRelay())
  const gateway = new FakeTypertGateway()
  const clock = fakeClock()
  const handle = installIntercept({ raw: gateway, relay, getServerId: () => H_SERVER_ID, clock })
  assert.equal(typeof handle.historyCacheStats, 'function')

  // 1. Cold miss: populates cache
  const gen0 = consumeStream(gateway, 'session/follow', { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } })
  await waitForStream(relay, 1)
  relay.streams[0].gate.push(makeFollowSnapshot(10, [makeFollowEvent(9), makeFollowEvent(10)], { assistantStream: { revision: 4 } }))
  await waitUntil(() => gen0.seen.length === 1)
  relay.streams[0].gate.finish()
  assert.equal(await gen0.outcome, 'ended-clean')
  assert.equal(handle.historyCacheStats().snapshotCount, 1)

  // 2. Warm hit: yields cached snapshot in 0ms (before background stream pushes anything!)
  const ac = new AbortController()
  const gen1Iter = (await gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } } },
    undefined,
    gateway.operatorPeer(),
    ac.signal,
    { signal: ac.signal },
  ))[Symbol.asyncIterator]()
  const firstPull = await gen1Iter.next()
  assert.equal(firstPull.done, false)
  assert.equal(firstPull.value.type, 'snapshot')
  assert.equal(firstPull.value.header.id, VIRTUAL_ID)
  assert.deepEqual(firstPull.value.assistantStream, { revision: 0 })

  await waitForStream(relay, 2)
  assert.equal(relay.streamOptions[1].opts?.knownCursor, 10)

  // Background sends snapshot-sync(unchanged) with upstream revision=5, then assistant-stream rev 6, event 11, assistant-stream rev 7
  relay.streams[1].gate.push({
    type: 'snapshot-sync',
    mode: 'unchanged',
    cursor: 10,
    hasMore: false,
    projections: { asOfSeq: 10, values: { model: 'm1' } },
    assistantStream: { revision: 5 },
  })
  relay.streams[1].gate.push({ type: 'assistant-stream', frame: { revision: 6, text: 'hello' } })
  relay.streams[1].gate.push(makeFollowEvent(11))
  relay.streams[1].gate.push({ type: 'assistant-stream', frame: { revision: 7, text: ' world' } })
  relay.streams[1].gate.finish()

  const rest = []
  while (true) {
    const step = await gen1Iter.next()
    if (step.done) break
    rest.push(step.value)
  }
  assert.deepEqual(rest, [
    { type: 'assistant-stream', frame: { revision: 1, text: 'hello' } },
    makeFollowEvent(11),
    { type: 'assistant-stream', frame: { revision: 2, text: ' world' } },
  ])
  assert.equal(handle.historyCacheStats().visitedCount, 1)
  handle.uninstall()
})

test('T4 SWR Case B (delta): 0ms cached open + contiguous delta event catch-up + revision offset', async () => {
  const relay = attachStreamSpy(createControllableRelay())
  const gateway = new FakeTypertGateway()
  const handle = installIntercept({ raw: gateway, relay, getServerId: () => H_SERVER_ID })

  const gen0 = consumeStream(gateway, 'session/follow', { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } })
  await waitForStream(relay, 1)
  relay.streams[0].gate.push(makeFollowSnapshot(10, [makeFollowEvent(10)]))
  await waitUntil(() => gen0.seen.length === 1)
  relay.streams[0].gate.finish()
  await gen0.outcome

  const gen1Iter = (await gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } } },
    undefined,
    gateway.operatorPeer(),
    undefined,
    {},
  ))[Symbol.asyncIterator]()
  const firstPull = await gen1Iter.next()
  assert.equal(firstPull.value.cursor, 10)
  await waitForStream(relay, 2)

  relay.streams[1].gate.push({
    type: 'snapshot-sync',
    mode: 'delta',
    baseCursor: 10,
    cursor: 12,
    records: [makeFollowEvent(11), makeFollowEvent(12)],
    hasMore: false,
    projections: { asOfSeq: 10, values: { model: 'm1' } },
    assistantStream: { revision: 3 },
  })
  relay.streams[1].gate.push({ type: 'assistant-stream', frame: { revision: 4, text: 'delta-live' } })
  relay.streams[1].gate.finish()

  const rest = []
  while (true) {
    const step = await gen1Iter.next()
    if (step.done) break
    rest.push(step.value)
  }
  assert.deepEqual(rest, [
    makeFollowEvent(11),
    makeFollowEvent(12),
    { type: 'assistant-stream', frame: { revision: 1, text: 'delta-live' } },
  ])
  handle.uninstall()
})

test('T4 SWR Case C (handoff): signal decoupling survives Gen 1 abort, Gen 2 takes over atomically, and unconsumed slot expires via TTL', async () => {
  const relay = attachStreamSpy(createControllableRelay())
  const gateway = new FakeTypertGateway()
  const clock = fakeClock()
  const handle = installIntercept({
    raw: gateway,
    relay,
    getServerId: () => H_SERVER_ID,
    clock,
    historyCache: { handoffTtlMs: 2000 },
  })

  // Seed cache at cursor 10
  const gen0 = consumeStream(gateway, 'session/follow', { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } })
  await waitForStream(relay, 1)
  relay.streams[0].gate.push(makeFollowSnapshot(10, [makeFollowEvent(10)]))
  await waitUntil(() => gen0.seen.length === 1)
  relay.streams[0].gate.finish()
  await gen0.outcome

  // Gen 1 hits cache; background returns activeAttempt snapshot (Case C)
  const gen1Ac = new AbortController()
  const gen1Iter = (await gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } } },
    undefined,
    gateway.operatorPeer(),
    gen1Ac.signal,
    { signal: gen1Ac.signal },
  ))[Symbol.asyncIterator]()
  const g1First = await gen1Iter.next()
  assert.equal(g1First.value.cursor, 10)
  await waitForStream(relay, 2)
  const bgSignal = relay.streamOptions[1].signal

  relay.streams[1].gate.push(makeFollowSnapshot(20, [makeFollowEvent(19), makeFollowEvent(20)], {
    assistantStream: { revision: 8, activeAttempt: { attemptId: 'att-9' } },
  }))
  const g1End = await gen1Iter.next()
  assert.equal(g1End.done, true, 'Gen 1 ends cleanly to trigger RemoteStream Gen 2 reopen')
  // DSH RemoteStream's finally aborts Gen 1 signal immediately on exit
  gen1Ac.abort()
  assert.equal(bgSignal.aborted, false, 'Case C must decouple Gen 1 abort from parked upstream stream')
  assert.equal(handle.historyCacheStats().handoffCount, 1)

  // Gen 2 opens and consumes handoff in 0ms without opening a 3rd relay stream
  const gen2Iter = (await gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } } },
    undefined,
    gateway.operatorPeer(),
    undefined,
    {},
  ))[Symbol.asyncIterator]()
  const g2First = await gen2Iter.next()
  assert.equal(g2First.done, false)
  assert.equal(g2First.value.cursor, 20)
  assert.deepEqual(g2First.value.assistantStream, { revision: 8, activeAttempt: { attemptId: 'att-9' } })
  assert.equal(relay.streams.length, 2, 'Gen 2 reused parked upstream without extra relay stream')
  assert.equal(handle.historyCacheStats().handoffCount, 0)

  relay.streams[1].gate.push({ type: 'assistant-stream', frame: { revision: 9, text: 'streaming' } })
  relay.streams[1].gate.finish()
  const g2Next = await gen2Iter.next()
  assert.deepEqual(g2Next.value, { type: 'assistant-stream', frame: { revision: 9, text: 'streaming' } })
  assert.equal((await gen2Iter.next()).done, true)

  // Unconsumed handoff expires after 2000ms and aborts upstream
  const gen3Iter = (await gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } } },
    undefined,
    gateway.operatorPeer(),
    undefined,
    {},
  ))[Symbol.asyncIterator]()
  await gen3Iter.next()
  await waitForStream(relay, 3)
  const bgSignal3 = relay.streamOptions[2].signal
  relay.streams[2].gate.push(makeFollowSnapshot(30, [makeFollowEvent(30)], {
    projections: { asOfSeq: 30, values: { model: 'm2' } },
  }))
  assert.equal((await gen3Iter.next()).done, true)
  assert.equal(handle.historyCacheStats().handoffCount, 1)
  assert.equal(bgSignal3.aborted, false)
  clock.advance(2000)
  assert.equal(handle.historyCacheStats().handoffCount, 0)
  assert.equal(bgSignal3.aborted, true, 'expired handoff aborts unconsumed upstream')
  handle.uninstall()
})

test('T4 session/page cache + full-path invalidation (unshared, not-shared, offline TTL, revoked, uninstall)', async () => {
  const relay = attachStreamSpy(createControllableRelay())
  const gateway = new FakeTypertGateway()
  const clock = fakeClock()
  const handle = installIntercept({
    raw: gateway,
    relay,
    getServerId: () => H_SERVER_ID,
    clock,
    historyCache: { offlineTtlMs: 30 * 60 * 1000 },
  })
  relay.invokes.length = 0 // discard proactive install-time modelCatalog probe

  // 1. session/page cache hit ignores throughSeq and clones returned value
  relay.invokeValues['session/page'] = { records: [makeFollowEvent(5)], hasMore: true }
  const page1 = await gateway.rpcBridge(
    'session/page',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, beforeSeq: 10, throughSeq: 15, maxMessages: 20, turnWindow: { minMessages: 5, minTurns: 1 } } } },
    undefined,
    gateway.operatorPeer(),
  )
  assert.equal(page1.ok, true)
  assert.equal(relay.invokes.length, 1)
  page1.value.records.push('mutated')

  const page2 = await gateway.rpcBridge(
    'session/page',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, beforeSeq: 10, throughSeq: 99, maxMessages: 20, turnWindow: { minMessages: 5, minTurns: 1 } } } },
    undefined,
    gateway.operatorPeer(),
  )
  assert.equal(page2.ok, true)
  assert.equal(relay.invokes.length, 1, 'second session/page hits cache with 0 RPC')
  assert.equal(page2.value.records.length, 1, 'caller mutation did not poison cached page')

  // beforeSeq > throughSeq + 1 bypasses cache
  await gateway.rpcBridge(
    'session/page',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, beforeSeq: 20, throughSeq: 15, maxMessages: 20, turnWindow: { minMessages: 5, minTurns: 1 } } } },
    undefined,
    gateway.operatorPeer(),
  )
  assert.equal(relay.invokes.length, 2)

  // 2. unshared mid-SWR clears session family and holds silently per T73
  const gen0 = consumeStream(gateway, 'session/follow', { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } })
  await waitForStream(relay, 1)
  relay.streams[0].gate.push(makeFollowSnapshot(10, [makeFollowEvent(10)]))
  await waitUntil(() => gen0.seen.length === 1)
  relay.streams[0].gate.finish()
  await gen0.outcome
  assert.equal(handle.historyCacheStats().snapshotCount, 1)

  const swrAc = new AbortController()
  const swrFrames = []
  const swrDone = (async () => {
    for await (const frame of await gateway.wireTap(
      'session/follow',
      { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } },
      undefined,
      gateway.operatorPeer(),
      swrAc.signal,
      { signal: swrAc.signal },
    )) {
      swrFrames.push(frame)
    }
  })()
  await waitForStream(relay, 2)
  relay.streams[1].gate.throwNow(new RelayError('unshared', 'gone', undefined, 'manual'))
  await waitUntil(() => handle.historyCacheStats().snapshotCount === 0)
  assert.equal(handle.historyCacheStats().pageCount, 0, 'unshared clears both snapshots and pages for session family')
  swrAc.abort()
  await swrDone

  // 3. offline TTL clears cache after 30 min; online cancels; revoked & uninstall clear immediately
  const genA = consumeStream(gateway, 'session/follow', { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } })
  await waitForStream(relay, 3)
  relay.streams[2].gate.push(makeFollowSnapshot(10, [makeFollowEvent(10)]))
  await waitUntil(() => genA.seen.length === 1)
  relay.streams[2].gate.finish()
  await genA.outcome
  assert.equal(handle.historyCacheStats().snapshotCount, 1)

  relay.transition('offline')
  clock.advance(15 * 60 * 1000)
  relay.transition('online')
  clock.advance(20 * 60 * 1000)
  assert.equal(handle.historyCacheStats().snapshotCount, 1, 'online cancelled offline TTL wipe')

  relay.transition('offline')
  clock.advance(30 * 60 * 1000)
  assert.equal(handle.historyCacheStats().totalBytes, 0, 'offline TTL cleared server cache')

  // Repopulate and verify revoked + uninstall clear
  const genB = consumeStream(gateway, 'session/follow', { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } })
  await waitForStream(relay, 4)
  relay.streams[3].gate.push(makeFollowSnapshot(11, [makeFollowEvent(11)]))
  await waitUntil(() => genB.seen.length === 1)
  relay.streams[3].gate.finish()
  await genB.outcome
  assert.equal(handle.historyCacheStats().snapshotCount, 1)

  relay.transition('revoked')
  assert.equal(handle.historyCacheStats().totalBytes, 0, 'revoked cleared server cache')

  relay.transition('online')
  const genC = consumeStream(gateway, 'session/follow', { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } })
  await waitForStream(relay, 5)
  relay.streams[4].gate.push(makeFollowSnapshot(12, [makeFollowEvent(12)]))
  await waitUntil(() => genC.seen.length === 1)
  relay.streams[4].gate.finish()
  await genC.outcome
  assert.equal(handle.historyCacheStats().snapshotCount, 1)

  handle.uninstall()
  assert.equal(handle.historyCacheStats().totalBytes, 0, 'uninstall cleared all cache')
})

test('T4 Step 0 handoff enters foreground to preempt prewarm, and Case C persists latest snapshot/unchanged to cache before parkHandoff', async () => {
  const relay = attachStreamSpy(createControllableRelay())
  const snapRequests = []
  relay.fetchSessionSnapshot = (req, signal) => {
    const entry = { sessionId: req.address?.sessionId, signal, aborted: false }
    signal?.addEventListener('abort', () => { entry.aborted = true }, { once: true })
    snapRequests.push(entry)
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new RelayError('aborted', 'aborted')), { once: true })
    })
  }
  const gateway = new FakeTypertGateway()
  const clock = fakeClock()
  const handle = installIntercept({
    raw: gateway,
    relay,
    getServerId: () => H_SERVER_ID,
    clock,
    historyCache: { handoffTtlMs: 2000 },
    prewarm: { idleDelayMs: 50, proactiveListDelayMs: 50, clock },
  })

  // 1. Case C snapshot write-back: if handoff expires via TTL, Step 1 must NOT fall back to old cursor 10
  const gen0 = consumeStream(gateway, 'session/follow', { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } })
  await waitForStream(relay, 1)
  relay.streams[0].gate.push(makeFollowSnapshot(10, [makeFollowEvent(10)]))
  await waitUntil(() => gen0.seen.length === 1)
  relay.streams[0].gate.finish()
  await gen0.outcome

  const gen1Iter = (await gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } } },
    undefined,
    gateway.operatorPeer(),
    undefined,
    {},
  ))[Symbol.asyncIterator]()
  assert.equal((await gen1Iter.next()).value.cursor, 10)
  await waitForStream(relay, 2)
  relay.streams[1].gate.push(makeFollowSnapshot(25, [makeFollowEvent(24), makeFollowEvent(25)], {
    projections: { asOfSeq: 25, values: { model: 'm-new' } },
    assistantStream: { revision: 3, activeAttempt: { attemptId: 'att-new' } },
  }))
  assert.equal((await gen1Iter.next()).done, true)
  assert.equal(handle.historyCacheStats().handoffCount, 1)

  // Handoff TTL expires unconsumed -> Gen 2 falls back to cache (Step 1)
  clock.advance(2000)
  assert.equal(handle.historyCacheStats().handoffCount, 0)
  const gen2FallbackIter = (await gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } } },
    undefined,
    gateway.operatorPeer(),
    undefined,
    {},
  ))[Symbol.asyncIterator]()
  const fallbackFirst = await gen2FallbackIter.next()
  assert.equal(fallbackFirst.value.cursor, 25, 'Case C must persist fresh snapshot to cache before parkHandoff')
  await waitForStream(relay, 3)
  relay.streams[2].gate.finish()
  await gen2FallbackIter.next()

  // 2. Step 0 enterForeground preempts in-flight prewarm for another session on same server
  relay.invokeValues['session/list'] = {
    items: [
      { sessionId: LOCAL_ID, title: 'main', updatedAt: '2026-01-01T00:00:00Z' },
      { sessionId: 's-other', title: 'other', updatedAt: '2026-01-01T00:00:01Z' },
    ],
  }
  await gateway.rpcBridge('session/list', { args: {} }, undefined, gateway.operatorPeer())
  // Park a Gen 1 -> Case C handoff for LOCAL_ID
  const gen3Iter = (await gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } } },
    undefined,
    gateway.operatorPeer(),
    undefined,
    {},
  ))[Symbol.asyncIterator]()
  await gen3Iter.next()
  await waitForStream(relay, 4)
  relay.streams[3].gate.push(makeFollowSnapshot(30, [makeFollowEvent(30)], {
    assistantStream: { revision: 4, activeAttempt: { attemptId: 'att-30' } },
  }))
  assert.equal((await gen3Iter.next()).done, true)
  assert.equal(handle.historyCacheStats().handoffCount, 1)

  // Let prewarm start fetching s-other after idleDelayMs
  clock.advance(60)
  await waitUntil(() => snapRequests.length >= 1)
  const prewarmReq = snapRequests.at(-1)
  assert.equal(prewarmReq.aborted, false)

  // Gen 2 enters Step 0 (handoffInitial) -> must immediately enterForeground and abort prewarm
  const gen4Iter = (await gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } } },
    undefined,
    gateway.operatorPeer(),
    undefined,
    {},
  ))[Symbol.asyncIterator]()
  const step0Snap = await gen4Iter.next()
  assert.equal(step0Snap.value.cursor, 30)
  assert.equal(prewarmReq.aborted, true, 'Step 0 handoff pickup must call enterForeground to abort concurrent prewarm')

  relay.streams[3].gate.finish()
  assert.equal((await gen4Iter.next()).done, true)
  handle.uninstall()
})
