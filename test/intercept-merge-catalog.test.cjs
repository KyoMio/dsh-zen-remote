'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { request } = require('./util.cjs')
const routes = require('../lib/client-routes.js')
const { checkGatewayShape } = require('../lib/intercept-shape.js')
const { installIntercept, behaviorSelfCheck, runSelfCheck, CLIENT_METHOD_FIELDS, OPTIONAL_CLIENT_METHOD_FIELDS, REMOTE_READ_METHODS, REMOTE_UPLINK_STREAM_METHODS, SESSION_STREAM_HOLD_ENDPOINTS, isRemoteWrite, rewriteRemoteEventFrame } = require('../lib/intercept.js')
const { toVirtual } = require('../lib/virtual-id.js')
const { encodeSessionReferenceUri, decodeSessionReferenceUri } = require('../lib/relay-server.js')
const { RelayError } = require('../lib/relay-client.js')
const { symbols } = require('@deepseek-ai/cordis')
const {
  SERVER_ID,
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
  createFakeUplink,
  createControllableRelay,
  createMergeGateway,
  readSome,
  waitForStream,
  flushAsync,
  LOCAL_WS,
  LOCAL_BASELINE,
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


test('workspace/follow merges the two legs: local first, remote upserts + merged order, a remote death emits NOTHING (state kept), recovery diffs, abort stops both', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  // The uplink the mux always passes rides to the LOCAL method verbatim.
  const inbox = { [Symbol.asyncIterator]() { return this }, next: async () => ({ done: true }) }
  const merged = await gateway.wireTap('workspace/follow', { args: {} }, inbox, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  assert.ok(typeof merged[Symbol.asyncIterator] === 'function', 'the wrap answered an async iterable (after the async open)')
  const iterator = merged[Symbol.asyncIterator]()
  assert.equal(gateway.streamCalls[0].uplink, inbox, 'the uplink went to the local stream, not the remote leg')

  // local baseline flows through untouched while no remote state exists
  localGate.push(LOCAL_BASELINE)
  const first = await readSome(iterator, 1)
  assert.deepEqual(first, [LOCAL_BASELINE])
  // the remote leg opened against the filtered server stream
  assert.equal(relay.streams.length, 1)
  assert.deepEqual(
    { namespace: relay.streams[0].namespace, method: relay.streams[0].method, args: relay.streams[0].args },
    { namespace: 'workspace', method: 'follow', args: {} },
  )

  // remote baseline arrives → upserts (server-filtered: w-1 only shows the
  // shared session) + merged order/archived/pinned, never a second baseline
  relay.streams[0].gate.push(REMOTE_BASELINE)
  const mergedRemote = await readSome(iterator, 5)
  assert.deepEqual(mergedRemote, [
    { type: 'upsert', workspace: { ...REMOTE_BASELINE.value.items[0], workspaceId: toVirtual(SERVER_ID, 'w-1'), title: `主服务器 · 远端一`, sessionIds: [toVirtual(SERVER_ID, 'session-a'), toVirtual(SERVER_ID, 'session-b')] } },
    { type: 'upsert', workspace: { ...REMOTE_BASELINE.value.items[1], workspaceId: toVirtual(SERVER_ID, 'w-2'), title: `主服务器 · 远端二`, sessionIds: [toVirtual(SERVER_ID, 'session-c')] } },
    { type: 'order', workspaceIds: ['ws-local', toVirtual(SERVER_ID, 'w-1'), toVirtual(SERVER_ID, 'w-2')] },
    { type: 'archived', archivedSessionIds: [toVirtual(SERVER_ID, 'session-b')] },
    { type: 'pinned', pinnedSessionIds: [] },
  ])

  // the remote leg dies → the death itself emits NOTHING, but the OFFLINE
  // transition (T34) annotates the shown titles: two upserts ride ahead of
  // the next local frame. NO remove anywhere — a remove would blacklist the
  // virtual ids in the UI's ClientWorkspaceModel forever
  relay.transition('offline')
  relay.streams[0].gate.throwNow(new RelayError('offline', '链路断了'))
  localGate.push({ type: 'order', workspaceIds: ['ws-local'] })
  const afterDeath = await readSome(iterator, 3)
  assert.deepEqual(afterDeath.map((frame) => frame.type), ['upsert', 'upsert', 'order'])
  assert.equal(afterDeath[0].workspace.title, '主服务器 · 远端一（离线）')
  assert.equal(afterDeath[1].workspace.title, '主服务器 · 远端二（离线）')
  assert.deepEqual(afterDeath[2], { type: 'order', workspaceIds: ['ws-local', toVirtual(SERVER_ID, 'w-1'), toVirtual(SERVER_ID, 'w-2')] },
    'the shown remote state survives the death — the local order still merges it')

  // relay back online → the annotation clears IMMEDIATELY (T34-fix: the
  // stream may not reopen at all, so the clear's own upserts are the
  // restore) and the remote leg reopens on top; the new baseline DIFFS
  // against the shown set: same content → upserts only, no removes
  relay.transition('online')
  const restored = await readSome(iterator, 2)
  assert.deepEqual(restored.map((frame) => frame.type), ['upsert', 'upsert'])
  assert.equal(restored[0].workspace.title, '主服务器 · 远端一', 'the titles restored with the online transition itself')
  await waitForStream(relay, 2)
  relay.streams[1].gate.push(REMOTE_BASELINE)
  const remerged = await readSome(iterator, 5)
  assert.deepEqual(remerged.map((frame) => frame.type), ['upsert', 'upsert', 'order', 'archived', 'pinned'])
  assert.equal(remerged[0].workspace.workspaceId, toVirtual(SERVER_ID, 'w-1'), 'the reopened stream re-shows the remote groups')

  // external abort: both legs stop, the merged iteration ends normally
  controller.abort()
  const done = await iterator.next()
  assert.equal(done.done, true)
  assert.ok(relay.streams[1].aborted, 'the remote leg was aborted')
  assert.ok(gateway.streamCalls[0].signal.aborted, 'the local leg rides the same external signal')
  localGate.finish()
  handle.uninstall()
})

test('PB-25b wiring: the merged stream reports its real-session inventory through the slot — replace per refresh, dropped with the stream', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const events = []
  const { handle } = install(gateway, relay, {
    // The wiring's slot, recorded: every report is that stream's FULL set
    // (replace — never a delta), and the stream end disposes the share.
    createSessionInventorySlot: () => ({
      replace: (ids) => events.push({ replace: [...ids].sort() }),
      dispose: () => events.push('disposed'),
    }),
  })
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(LOCAL_BASELINE)
  await readSome(iterator, 1)
  assert.equal(relay.streams.length, 1)
  // The remote baseline learns per workspace record — one full-set report
  // each (original ids, tombstones included).
  relay.streams[0].gate.push(REMOTE_BASELINE)
  await readSome(iterator, 5)
  // The reconnecting baseline diffs w-2 away: the learn of w-1 reports the
  // still-complete set, the same refresh's forget of w-2 reports it WITHOUT
  // session-c — a session that left the sub-client's view stops being known
  // with the refresh that removed it.
  relay.streams[0].gate.push({ type: 'baseline', value: { items: [remoteWorkspace('w-1', '远端一', ['session-a'])], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(iterator, 5)
  // Stream end → the share is dropped with the stream (the ids may no
  // longer be in the UI's view).
  controller.abort()
  const done = await iterator.next()
  assert.equal(done.done, true)
  assert.deepEqual(events, [
    { replace: ['session-a', 'session-b'] },
    { replace: ['session-a', 'session-b', 'session-c'] },
    { replace: ['session-a', 'session-b', 'session-c'] },
    { replace: ['session-a', 'session-b'] },
    'disposed',
  ])
  localGate.finish()
  handle.uninstall()
})

test('T62/T65 wiring: the current session comes from the injected browser report — a close is judged per report, and past the grace the notification lands the hide at once', async () => {
  // The intercept runs in the backend Node process; the current-session
  // value arrives from the browser half through the client route and is
  // held by the wiring — here, one mutable holder behind the injected
  // getter (index.ts does exactly this with `reportedCurrentSession`). The
  // fake `now` crosses the tombstone hide grace (T65) without real waiting.
  const { clock, advance } = clockWithFakeNow()
  let current = { kind: 'unavailable' }
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay, { getCurrentSession: () => current, clock })
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(LOCAL_BASELINE)
  await readSome(iterator, 1)
  relay.streams[0].gate.push({
    type: 'baseline',
    value: { items: [remoteWorkspace('w-1', '远端一', ['session-a', 'session-b'])], archivedSessionIds: [], pinnedSessionIds: [] },
  })
  await readSome(iterator, 4)

  // The browser reports session-b open (the route's sink stores the value
  // and calls handle.currentSessionChanged()).
  current = { kind: 'open', sessionId: toVirtual(SERVER_ID, 'session-b') }
  handle.currentSessionChanged()

  // session-b's remote closes WHILE the user has it open: the tombstone
  // stays (the page keeps its 「远程已关闭」 banner), nothing is archived —
  // and inside the grace it rides the group as before.
  relay.streams[0].gate.push({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['session-a']) })
  const [kept] = await readSome(iterator, 1)
  assert.deepEqual(kept.workspace.sessionIds, [toVirtual(SERVER_ID, 'session-a'), toVirtual(SERVER_ID, 'session-b')])

  // The browser reports the user navigated away (a readable "nothing
  // open"); past the grace the change notification re-judges AT ONCE — one
  // merged archived frame, no group upsert (T65: hiding moves only the
  // archived set).
  current = { kind: 'none' }
  advance(2_001)
  handle.currentSessionChanged()
  const [archived] = await readSome(iterator, 1)
  assert.deepEqual(archived, { type: 'archived', archivedSessionIds: [toVirtual(SERVER_ID, 'session-b')] })
  // and the group still carries the tombstone: a marker frame after the
  // notification proves no group upsert followed
  localGate.push({ type: 'pinned', pinnedSessionIds: [] })
  const [marker] = await readSome(iterator, 1)
  assert.equal(marker.type, 'pinned', 'no group upsert — hiding is the archived set alone')

  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('T62 wiring: no report yet (getter unavailable) keeps the conservative tombstone — a close hides nothing', async () => {
  // Default install: no getCurrentSession injected, permanently
  // `unavailable` — the pre-report conservative behavior (T58's fallback).
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(LOCAL_BASELINE)
  await readSome(iterator, 1)
  relay.streams[0].gate.push({
    type: 'baseline',
    value: { items: [remoteWorkspace('w-1', '远端一', ['session-a', 'session-b'])], archivedSessionIds: [], pinnedSessionIds: [] },
  })
  await readSome(iterator, 4)

  relay.streams[0].gate.push({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['session-a']) })
  const [kept] = await readSome(iterator, 1)
  assert.deepEqual(kept.workspace.sessionIds, [toVirtual(SERVER_ID, 'session-a'), toVirtual(SERVER_ID, 'session-b')], 'the tombstone stays while no signal has arrived')

  // A spurious change notification WITHOUT a signal must not start hiding
  // either: prove it by pushing a marker frame after the notification and
  // asserting the very next frame is the marker itself.
  handle.currentSessionChanged()
  localGate.push({ type: 'pinned', pinnedSessionIds: [] })
  const [marker] = await readSome(iterator, 1)
  assert.equal(marker.type, 'pinned', 'the notification produced no frames of its own')

  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('T62/T65 e2e: the REAL client route feeds the intercept — report A, close A, report B, A enters archived', async () => {
  // The route and the intercept exactly as index.ts wires them: the route's
  // sink stores the report and calls handle.currentSessionChanged(); the
  // intercept reads the holder per use. The fake `now` crosses the hide
  // grace (T65) without real waiting.
  const { clock, advance } = clockWithFakeNow()
  let reported = { kind: 'unavailable' }
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay, { getCurrentSession: () => reported, clock })
  const handler = routes.createClientHandler({
    admit: () => ({ peer: {} }),
    getRowConfig: () => ({ role: 'client' }),
    onCurrentSession: (read) => {
      reported = read
      handle.currentSessionChanged()
    },
  })
  const server = http.createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
    localGate.push(LOCAL_BASELINE)
    await readSome(iterator, 1)
    relay.streams[0].gate.push({
      type: 'baseline',
      value: { items: [remoteWorkspace('w-1', '远端一', ['session-a'])], archivedSessionIds: [], pinnedSessionIds: [] },
    })
    await readSome(iterator, 4)

    // The browser reports session-a open; the server then closes its remote.
    const posted = await request(port, {
      method: 'POST',
      path: '/_dsh/zen-remote/client/current-session',
      headers: { origin: `http://127.0.0.1:${port}` },
      body: { sessionId: toVirtual(SERVER_ID, 'session-a') },
    })
    assert.equal(posted.status, 200)
    relay.streams[0].gate.push({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', []) })
    const [kept] = await readSome(iterator, 1)
    assert.deepEqual(kept.workspace.sessionIds, [toVirtual(SERVER_ID, 'session-a')], 'the open closed session keeps its tombstone')

    // The user navigates away: the report of B (a local id) arrives through
    // the REAL route; past the grace the notification lands the hide — one
    // merged archived frame (T65: the group copy keeps the tombstone).
    const away = await request(port, {
      method: 'POST',
      path: '/_dsh/zen-remote/client/current-session',
      headers: { origin: `http://127.0.0.1:${port}` },
      body: { sessionId: 'session-l2' },
    })
    assert.equal(away.status, 200)
    advance(2_001)
    handle.currentSessionChanged()
    const [archived] = await readSome(iterator, 1)
    assert.deepEqual(archived, { type: 'archived', archivedSessionIds: [toVirtual(SERVER_ID, 'session-a')] })

    controller.abort()
    localGate.finish()
    handle.uninstall()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a server RENAME (same serverId) re-upserts under the new title without reopening the stream or removing anything', async () => {
  // T59: this is also the shape the stream heartbeat's names arrive through —
  // the relay client folds a ping's `serverName` into `handshakeInfo` and
  // broadcasts the CURRENT state (`notify`, state unmoved), which is exactly
  // what the `transition('online')` below simulates: an identity change with
  // no state transition, re-titleing the groups via the existing
  // retarget/onServerRenamed path, never a reopen.
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(LOCAL_BASELINE)
  await readSome(iterator, 1)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  await readSome(iterator, 5)

  relay.handshakeInfo = { ...relay.handshakeInfo, serverName: '改名的服务器' }
  relay.transition('online')
  const renamed = await readSome(iterator, 2)
  assert.deepEqual(renamed, [
    { type: 'upsert', workspace: { ...REMOTE_BASELINE.value.items[0], workspaceId: toVirtual(SERVER_ID, 'w-1'), title: '改名的服务器 · 远端一', sessionIds: [toVirtual(SERVER_ID, 'session-a'), toVirtual(SERVER_ID, 'session-b')] } },
    { type: 'upsert', workspace: { ...REMOTE_BASELINE.value.items[1], workspaceId: toVirtual(SERVER_ID, 'w-2'), title: '改名的服务器 · 远端二', sessionIds: [toVirtual(SERVER_ID, 'session-c')] } },
  ])
  assert.equal(relay.streams.length, 1, 'no reopen for a rename')
  await flushAsync()
  assert.equal(relay.streams[0].aborted, false, 'the stream was never cut')
  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('unpair / revocation keeps the shown group (serverId persists server-side); a re-pair to the same serverId reopens and re-shows everything in the REAL UI model', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const ui = createUiModel()
  const v1 = toVirtual(SERVER_ID, 'w-1')
  const v2 = toVirtual(SERVER_ID, 'w-2')
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(LOCAL_BASELINE)
  ;(await readSome(iterator, 1)).forEach(ui.apply)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  ;(await readSome(iterator, 5)).forEach(ui.apply)
  assert.equal(ui.ids(), `ws-local,${v1},${v2}`)

  // the pairing dies (T23b2-fix3): NOT a remove any more. The server keeps
  // its serverId, so a re-pair reuses the prefix — and ClientWorkspaceModel's
  // removedIds blacklist never clears, so a remove here would make the whole
  // group un-revivable. Nothing leaves; the T34 annotation rides out as the
  // two title upserts ahead of the next local frame.
  relay.transition('revoked')
  await flushAsync()
  assert.equal(relay.streams.length, 1, 'no reopen while revoked')
  assert.ok(relay.streams[0].aborted, 'the in-flight remote leg was cut')
  assert.equal(ui.ids(), `ws-local,${v1},${v2}`, 'the revocation removed nothing from the UI model')

  // local frames keep flowing while revoked, still merged with the kept tail,
  // and the annotation upserts precede them (T34)
  localGate.push({ type: 'order', workspaceIds: ['ws-local'] })
  const kept = await readSome(iterator, 3)
  kept.forEach(ui.apply)
  assert.deepEqual(kept.map((frame) => frame.type), ['upsert', 'upsert', 'order'])
  assert.equal(kept[0].workspace.title, '主服务器 · 远端一（令牌已吊销）')
  assert.deepEqual(kept[2], { type: 'order', workspaceIds: ['ws-local', v1, v2] })
  assert.equal(ui.model.items[1].title, '主服务器 · 远端一（令牌已吊销）')

  // re-paired to the SAME server id: the annotation clears with its own
  // plain-title upserts first (T34-fix), then the leg reopens and the new
  // baseline diffs against the kept state — content refresh (upserts only,
  // no removes) — and the REAL model ends up holding the remote groups with
  // the NEW baseline's content.
  relay.transition('online')
  const unannotated = await readSome(iterator, 2)
  unannotated.forEach(ui.apply)
  assert.equal(ui.model.items[1].title, '主服务器 · 远端一', 'the re-pair restored the plain titles')
  await waitForStream(relay, 2)
  const repairedBaseline = {
    type: 'baseline',
    value: {
      items: [remoteWorkspace('w-1', '重配后', ['session-a']), remoteWorkspace('w-2', '远端二', ['session-c'])],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
  }
  relay.streams[1].gate.push(repairedBaseline)
  const remerged = await readSome(iterator, 5)
  remerged.forEach(ui.apply)
  assert.deepEqual(remerged.map((frame) => frame.type), ['upsert', 'upsert', 'order', 'archived', 'pinned'])
  assert.equal(ui.ids(), `ws-local,${v1},${v2}`, 'the remote groups survived the revoke → re-pair round trip')
  assert.equal(ui.model.items[1].title, '主服务器 · 重配后', 'the content came from the NEW baseline')
  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('a revocation that never re-pairs emits NO remove: the merged stream stays quiet and the REAL UI model keeps the groups', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const ui = createUiModel()
  const v1 = toVirtual(SERVER_ID, 'w-1')
  const v2 = toVirtual(SERVER_ID, 'w-2')
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(LOCAL_BASELINE)
  ;(await readSome(iterator, 1)).forEach(ui.apply)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  ;(await readSome(iterator, 5)).forEach(ui.apply)

  relay.transition('revoked')
  // Give the aborted remote leg every chance to surface a wrongly emitted
  // frame: a remove would be queued in the channel AHEAD of the frames read
  // below. The T34 annotation's two title upserts ARE emitted (they are not
  // removes) and precede the local order.
  await flushAsync()
  localGate.push({ type: 'order', workspaceIds: ['ws-local'] })
  const only = await readSome(iterator, 3)
  only.forEach(ui.apply)
  assert.deepEqual(only.map((frame) => frame.type), ['upsert', 'upsert', 'order'], 'only title upserts (no remove) preceded the local order')
  assert.equal(ui.ids(), `ws-local,${v1},${v2}`, 'the REAL model still holds the remote groups — the blacklist was never triggered')
  assert.equal(relay.streams.length, 1, 'nothing reopens while revoked')
  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('a relay.subscribe that throws degrades the merged stream to pure local passthrough', async () => {
  const controller = new AbortController()
  const gateway = new FakeTypertGateway({ stream: { 'workspace/follow': [LOCAL_BASELINE] } })
  const relay = createControllableRelay({
    subscribe() { throw new Error('no listeners for you') },
  })
  const { handle } = install(gateway, relay)
  const frames = await drained(gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))
  assert.deepEqual(frames, [LOCAL_BASELINE], 'the local stream flowed untouched')
  assert.equal(relay.streams.length, 0, 'the remote leg never started')
  handle.uninstall()
})

test('a hostile relay (identity getter throws) stops only the remote leg — no unhandled rejection, local keeps flowing', async () => {
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const controller = new AbortController()
    const { gateway, localGate } = createMergeGateway(controller.signal)
    let reads = 0
    const relay = createControllableRelay()
    Object.defineProperty(relay, 'handshakeInfo', {
      get() {
        reads += 1
        if (reads > 2) throw new Error('hostile handshake read')
        return { relayProtocol: 1, serverId: SERVER_ID, serverName: '主服务器', dshVersion: '0.0.0', fingerprints: {} }
      },
    })
    const { handle } = install(gateway, relay)
    const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
    localGate.push(LOCAL_BASELINE)
    const first = await readSome(iterator, 1)
    assert.deepEqual(first, [LOCAL_BASELINE])
    // let the remote pump hit the hostile getter and give the microtask
    // queue time to surface any unhandled rejection
    await flushAsync()
    localGate.push({ type: 'order', workspaceIds: ['ws-local'] })
    const second = await readSome(iterator, 1)
    assert.deepEqual(second, [{ type: 'order', workspaceIds: ['ws-local'] }], 'the local leg never noticed')
    assert.deepEqual(unhandled, [], 'no unhandled promise rejection from the remote pump')
    controller.abort()
    await iterator.next()
    localGate.finish()
    handle.uninstall()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('an external signal already aborted before the merged stream starts ends it immediately', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  controller.abort()
  const merged = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const done = await merged[Symbol.asyncIterator]().next()
  assert.equal(done.done, true, 'both legs skipped')
  assert.equal(relay.streams.length, 0, 'no remote stream was opened')
  localGate.finish()
  handle.uninstall()
})

test('the behavior self-check probe goes through the wrapper but skips the remote leg entirely', async () => {
  const gateway = new FakeTypertGateway({ stream: { 'workspace/follow': [{ type: 'baseline', value: { items: [] } }] } })
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const outcome = await behaviorSelfCheck(gateway)
  assert.deepEqual(outcome, { ok: true })
  assert.equal(relay.streams.length, 0, 'the probe never opened a relay stream')
  assert.equal(gateway.streamCalls.length, 1, 'the wrap served the probe stream')
  handle.uninstall()
})


test('a re-handshake with a DIFFERENT server removes the old groups and reopens under the new identity', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(LOCAL_BASELINE)
  await readSome(iterator, 1)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  await readSome(iterator, 5)

  relay.handshakeInfo = { ...relay.handshakeInfo, serverId: 'ffffffff', serverName: '新服务器' }
  relay.transition('online')
  await waitForStream(relay, 2)
  assert.ok(relay.streams[0].aborted, 'the old server stream was cut')

  // the OLD groups leave with OLD-prefix ids, then the reopened stream (new
  // merger identity) re-shows them under the NEW prefix
  const gone = await readSome(iterator, 5)
  assert.deepEqual(gone.slice(0, 2), [
    { type: 'remove', workspaceId: toVirtual(SERVER_ID, 'w-1') },
    { type: 'remove', workspaceId: toVirtual(SERVER_ID, 'w-2') },
  ])
  assert.deepEqual(gone[2], { type: 'order', workspaceIds: ['ws-local'] })

  relay.streams[1].gate.push(REMOTE_BASELINE)
  const next = await readSome(iterator, 5)
  assert.equal(next[0].workspace.workspaceId, toVirtual('ffffffff', 'w-1'))
  assert.equal(next[0].workspace.title, '新服务器 · 远端一')
  assert.deepEqual(next[2], { type: 'order', workspaceIds: ['ws-local', toVirtual('ffffffff', 'w-1'), toVirtual('ffffffff', 'w-2')] })
  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('session/control merges: a remote baseline explodes into virtual projections, local frames pass through, remote death is silent', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay()
  const { handle } = install(gateway, relay)
  const iterator = (await gateway.wireTap('session/control', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()

  const localBaseline = { type: 'baseline', value: { projections: { 'session-l1': { asOfSeq: 1, values: { title: '本地' } } } } }
  localGate.push(localBaseline)
  assert.deepEqual(await readSome(iterator, 1), [localBaseline], 'local control frames are verbatim')

  assert.deepEqual({ namespace: relay.streams[0].namespace, method: relay.streams[0].method }, { namespace: 'session', method: 'control' })
  relay.streams[0].gate.push({ type: 'baseline', value: { projections: { 'session-a': { asOfSeq: 7, values: { title: '远端', todos: [] } } } } })
  const exploded = await readSome(iterator, 2)
  assert.deepEqual(exploded, [
    P({ type: 'projection', sessionId: toVirtual(SERVER_ID, 'session-a'), key: 'title', value: '远端', seq: 7 }),
    P({ type: 'projection', sessionId: toVirtual(SERVER_ID, 'session-a'), key: 'todos', value: [], seq: 7 }),
  ])
  relay.streams[0].gate.push({ type: 'projection', sessionId: 'session-a', key: 'title', value: '改名', seq: 8 })
  assert.deepEqual(await readSome(iterator, 1), [
    P({ type: 'projection', sessionId: toVirtual(SERVER_ID, 'session-a'), key: 'title', value: '改名', seq: 8 }),
  ])

  // the remote stream ENDS: control emits no removal frames — local keeps flowing
  relay.streams[0].gate.finish()
  localGate.push({ type: 'projection', sessionId: 'session-l1', key: 'title', value: '本地改', seq: 2 })
  assert.deepEqual(await readSome(iterator, 1), [{ type: 'projection', sessionId: 'session-l1', key: 'title', value: '本地改', seq: 2 }])

  controller.abort()
  const done = await iterator.next()
  assert.equal(done.done, true)
  assert.equal(handle.diagnostics().recentFailures.filter((f) => f.endpoint === 'session/control').length, 0, 'a clean remote end is no failure')
  localGate.finish()
  handle.uninstall()
})

test('session/list merges the relay first page into the local one; cursor, offline, local and remote failures keep the local answer', async () => {
  const gateway = new FakeTypertGateway({
    rpc: { 'session/list': { ok: true, value: { items: [{ sessionId: 'session-local', updatedAt: 1 }], nextCursor: 'tok' } } },
  })
  const relay = createControllableRelay()
  // T52-fix2: the provider rewrite is catalog-gated — stage the server's
  // answer and fill the cache the way the online fetch (or the route) would.
  relay.invokeValues = { 'session/modelCatalog': SERVER_CATALOG }
  // T52-fix: a remote row's projections block rides along (sequenced kind —
  // the shape that poisons the projection store if left unwritten); the
  // merged route must rewrite its modelSelection like every other route.
  relay.invokeValue = {
    items: [
      {
        sessionId: 'session-a',
        updatedAt: 2,
        projections: {
          kind: 'sequenced',
          asOfSeq: 6,
          values: { modelSelection: { lastUsed: { provider: 'codex', model: 'sol' }, next: null } },
        },
      },
      { sessionId: 'session-b', updatedAt: 3 },
    ],
  }
  const { handle } = install(gateway, relay)
  await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)

  // first page, online: local items first, remote items virtualized after,
  // the pagination field comes from the LOCAL result
  const merged = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, gateway.operatorPeer())
  assert.deepEqual(merged, {
    ok: true,
    value: {
      items: [
        { sessionId: 'session-local', updatedAt: 1 },
        {
          sessionId: toVirtual(SERVER_ID, 'session-a'),
          updatedAt: 2,
          projections: {
            kind: 'sequenced',
            asOfSeq: 6,
            values: { modelSelection: { lastUsed: { provider: toVirtual(SERVER_ID, 'codex'), model: 'sol' }, next: null } },
          },
        },
        { sessionId: toVirtual(SERVER_ID, 'session-b'), updatedAt: 3 },
      ],
      nextCursor: 'tok',
    },
  })
  assert.deepEqual(relay.invokes, [
    { namespace: 'session', method: 'modelCatalog', args: {}, signal: undefined },
    { namespace: 'session', method: 'list', args: { _request: {} }, signal: undefined },
  ])

  // a paged request never touches the relay
  const paged = await gateway.rpcBridge('session/list', { args: { _request: { cursor: 'tok' } } }, undefined, undefined)
  assert.deepEqual(paged.value.items, [{ sessionId: 'session-local', updatedAt: 1 }])
  assert.equal(relay.invokes.length, 2)

  // a remote failure degrades to the local answer and is recorded
  relay.invokeThrow = new RelayError('offline', 'down')
  const degraded = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, undefined)
  assert.deepEqual(degraded.value.items, [{ sessionId: 'session-local', updatedAt: 1 }])
  const ring = handle.diagnostics().recentFailures
  assert.deepEqual([ring[ring.length - 1].endpoint, ring[ring.length - 1].code], ['session/list', 'offline'])
  assert.equal(relay.invokes.length, 3)

  // offline: no relay round-trip at all
  relay.transition('offline')
  const offline = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, undefined)
  assert.deepEqual(offline.value.items, [{ sessionId: 'session-local', updatedAt: 1 }])
  assert.equal(relay.invokes.length, 3)

  // a non-ok LOCAL envelope is the answer; nothing merges into it
  gateway.spec.rpc['session/list'] = { ok: false, error: { code: 'internal', message: 'boom', details: {} } }
  const localFailure = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, undefined)
  assert.equal(localFailure.ok, false)
  assert.equal(localFailure.error.code, 'internal')
  handle.uninstall()
})


test('merged $events: the local ready opens, local frames pass untouched, remote frames arrive virtualized', async () => {
  const relay = createControllableRelay()
  const { controller, localGate, iterator } = await openMergedEvents(relay)
  // The local ready is queued before the first pull, so the FIRST frame of
  // the merged stream is the local one — what the client face demands.
  localGate.push(READY)
  const [first] = await readSome(iterator, 1)
  assert.deepEqual(first, READY)

  // The relay leg opened on its own ($zr/events, no args).
  await waitForStream(relay, 1)
  assert.equal(relay.streams.length, 1)
  assert.equal(relay.streams[0].namespace, '$zr')
  assert.equal(relay.streams[0].method, 'events')
  assert.deepEqual(relay.streams[0].args, {})

  const gate = relay.streams[0].gate
  // The server's ready is dropped; the waterfall arrives with virtual ids.
  gate.push({ type: 'ready', clientId: 'srv-client', host: { home: '/srv/home' } })
  gate.push(SERVER_WATERFALL)
  const [second] = await readSome(iterator, 1)
  assert.deepEqual(second, {
    type: 'waterfall',
    event: 'approval/request',
    eventId: V_REMOTE_EVENT,
    agentId: VIRTUAL_ID,
    request: { toolName: 'Bash', callId: 'c2' },
  })

  // Local frames flow beside the remote ones, untouched.
  localGate.push(LOCAL_WATERFALL)
  const [third] = await readSome(iterator, 1)
  assert.deepEqual(third, LOCAL_WATERFALL)

  // Cancel closes the prompt: the correlation id goes virtual too.
  gate.push({ type: 'cancel', eventId: 'evt-remote-1' })
  const [fourth] = await readSome(iterator, 1)
  assert.deepEqual(fourth, { type: 'cancel', eventId: toVirtual(SERVER_ID, 'evt-remote-1') })

  // T75: the forwarded status emit crosses with its session id virtualized.
  gate.push({ type: 'emit', event: 'api-session/status', args: [LOCAL_ID, true] })
  const [fifth] = await readSome(iterator, 1)
  assert.deepEqual(fifth, { type: 'emit', event: 'api-session/status', args: [VIRTUAL_ID, true] })

  // Tearing the UI's stream down ends the merged stream and both legs.
  controller.abort()
  const done = await iterator.next()
  assert.equal(done.done, true)
  assert.equal(localGate.aborted, true, 'the local stream observed the teardown')
})


test('merged $events: a remote death keeps the local stream alive, the next online reopens', async () => {
  const relay = createControllableRelay()
  const { localGate, iterator } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  await waitForStream(relay, 1)

  const first = relay.streams[0].gate
  first.throwNow(new RelayError('offline', 'the relay chain answered 502'))
  // The local UI stream keeps flowing — a remote death emits nothing.
  localGate.push({ type: 'emit', event: 'settings/document-updated', args: [] })
  const [next] = await readSome(iterator, 1)
  assert.deepEqual(next, { type: 'emit', event: 'settings/document-updated', args: [] })

  // The reconnect lands online: the leg reopens and pending events arrive again.
  // This 'online' lands without the state ever leaving online (a test-double
  // artifact — the real client notifies on state changes only), and being the
  // stream's FIRST online notification it fires the T52 catalog-refresh emit
  // ahead of the reopened leg's frames.
  relay.transition('online')
  await waitForStream(relay, 2)
  relay.streams[1].gate.push(SERVER_WATERFALL)
  const [refresh, waterfall] = await readSome(iterator, 2)
  assert.deepEqual(refresh, { type: 'emit', event: 'llm/adapters-updated', args: [] })
  assert.equal(waterfall.eventId, V_REMOTE_EVENT)
  await iterator.return?.(undefined)
})

test('merged $events: unpaired ends the remote leg until a re-pair; local keeps running', async () => {
  const relay = createControllableRelay()
  const { localGate, iterator } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  await waitForStream(relay, 1)
  assert.equal(relay.streams[0].aborted, false)

  relay.transition('revoked')
  await waitUntil(() => relay.streams[0].aborted)
  localGate.push({ type: 'emit', event: 'commands/change', args: [] })
  const [next] = await readSome(iterator, 1)
  assert.deepEqual(next, { type: 'emit', event: 'commands/change', args: [] })

  // A re-pair DOES reopen: the online transition carries a handshake
  // identity again (the leg reopens and pending events re-deliver). But an
  // online event with NO handshake — the unpaired row — reopens nothing.
  relay.transition('online')
  await waitForStream(relay, 2)
  relay.streams[1].gate.push(SERVER_WATERFALL)
  // The re-pair is a REAL serving transition (revoked → online): the T52
  // catalog-refresh emit precedes the reopened leg's frames.
  const [refresh, again] = await readSome(iterator, 2)
  assert.deepEqual(refresh, { type: 'emit', event: 'llm/adapters-updated', args: [] })
  assert.equal(again.eventId, V_REMOTE_EVENT)
  await iterator.return?.(undefined)

  const cold = createControllableRelay()
  const coldOpen = await openMergedEvents(cold)
  coldOpen.localGate.push(READY)
  await readSome(coldOpen.iterator, 1)
  await waitForStream(cold, 1)
  cold.handshakeInfo = undefined
  cold.transition('revoked')
  await waitUntil(() => cold.streams[0].aborted)
  cold.transition('online')
  await flushAsync()
  assert.equal(cold.streams.length, 1, 'no reopen without a handshake identity')
  await coldOpen.iterator.return?.(undefined)
})

test('merged $events: a handshake that names another server reopens under the new ids', async () => {
  const relay = createControllableRelay()
  const { localGate, iterator } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  await waitForStream(relay, 1)
  relay.streams[0].gate.push(SERVER_WATERFALL)
  await readSome(iterator, 1)

  relay.handshakeInfo = { ...relay.handshakeInfo, serverId: 'ffffffff' }
  relay.transition('online')
  await waitForStream(relay, 2)
  assert.equal(relay.streams[1].aborted, false)
  relay.streams[1].gate.push(SERVER_WATERFALL)
  // The cut leg closes the prompt it showed BEFORE the new leg speaks; the
  // identity change also emitted the T52 catalog-refresh emit first (the
  // state listener runs synchronously, the pump's orphan cancels after).
  const [renamed, orphanCancel, frame] = await readSome(iterator, 3)
  assert.deepEqual(renamed, { type: 'emit', event: 'llm/adapters-updated', args: [] })
  assert.deepEqual(orphanCancel, { type: 'cancel', eventId: V_REMOTE_EVENT })
  assert.equal(frame.agentId, toVirtual('ffffffff', LOCAL_ID))
  assert.equal(frame.eventId, toVirtual('ffffffff', 'a1b2c3d4e5f60718.evt-remote-1'))
  await iterator.return?.(undefined)
})

test('merged $events: the consumer abort ends everything and both legs unwind', async () => {
  const relay = createControllableRelay()
  const { controller, localGate, iterator } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  await waitForStream(relay, 1)
  controller.abort()
  const done = await iterator.next()
  assert.equal(done.done, true)
  await waitUntil(() => relay.streams[0].aborted)
  assert.equal(localGate.aborted, true)
})

// -- T63: the summary sync (synthesized api-session/added rows) ----------------

const T63_SHARED_ROW = { sessionId: 'session-shared', updatedAt: 5 }
const T63_WORKSPACE = { workspaceId: 'w-1', title: '远端一', sessionIds: ['session-shared'], createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z' }

/** The host's WIRE shape for `session/list` (RT dsh-api-session-controller
 * lib/typert.remote-client.js:993-1003 — ONE strict parameter named
 * `_request`, SessionListRequest = {cursor?}); anything else answers
 * `gateway/arguments-invalid` on the real server. The mock relay accepts any
 * args, which is exactly how T63 shipped a bare `{}` and the sync silently
 * never served — this wraps the mock to refuse every other shape the way the
 * real gateway would. */
function enforceSessionListWireShape(relay) {
  const baseInvoke = relay.invoke
  relay.invoke = function (namespace, method, args, signal) {
    if (namespace === 'session' && method === 'list') {
      const keys = args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : []
      const request = keys.length === 1 && keys[0] === '_request' ? args._request : undefined
      if (request === null || typeof request !== 'object' || Array.isArray(request)) {
        return Promise.reject(new RelayError('gateway/arguments-invalid', 'session/list expects { _request: {...} }'))
      }
    }
    return baseInvoke(namespace, method, args, signal)
  }
}

/** A gateway whose LOCAL streams are one gate PER ENDPOINT (the T63 tests
 * drive `$events` and `workspace/follow` side by side through one install). */
function createPerEndpointGateway() {
  const gateway = new FakeTypertGateway()
  const gates = {}
  gateway.openWireStream = async function (endpoint, payload, uplink, peer, legSignal, control) {
    gateway.streamCalls.push({ endpoint, payload, uplink, peer, signal: legSignal, control })
    if (gates[endpoint] === undefined) gates[endpoint] = createGate(legSignal)
    return gates[endpoint].iterable
  }
  return { gateway, gates }
}

test('T63-fix: session/list answered offline at page load, then the relay serves — the sync re-pulls with the WIRE shape ({ _request }) and announces the missing row', async () => {
  const relay = createControllableRelay()
  // The page-load state: the handshake is not up (no state event — the UI's
  // one list pull runs against a relay that cannot serve).
  relay.state = 'offline'
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: [T63_SHARED_ROW] },
  }
  // The real server rejects a bare {} with gateway/arguments-invalid (T63's
  // shipped bug) — arm the same refusal here so the sync's request shape is
  // load-bearing in the test.
  enforceSessionListWireShape(relay)
  // The gate is armed: the shape T63 originally sent is refused exactly like
  // the real gateway refuses it. (The probe's invoke record is wiped below,
  // like install() wipes the install-time catalog probe.)
  await assert.rejects(relay.invoke('session', 'list', {}, undefined), (error) => error.code === 'gateway/arguments-invalid')
  relay.invokes.length = 0
  const { gateway, iterator, localGate } = await openMergedEvents(relay)
  gateway.spec.rpc = {
    'session/list': { ok: true, value: { items: [{ sessionId: 'session-local', updatedAt: 1 }] } },
  }
  localGate.push(READY)
  await readSome(iterator, 1)

  // The offline pull: the merged route answers the local list alone, and no
  // relay round-trip happens. This is the root cause — the UI now holds no
  // summary for the shared session, and the host re-pulls only on a
  // connection generation change, which a quiet page never gets.
  const offline = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, undefined)
  assert.deepEqual(offline.value.items, [{ sessionId: 'session-local', updatedAt: 1 }])
  assert.equal(relay.invokes.length, 0)

  // The relay comes up: the serving period opens, the sync fetches the list
  // and announces the row the UI is missing (after the catalog refresh the
  // same transition emits). T75: the serving period runs a SECOND list pull
  // — the status re-sync — ahead of the announce, so one status frame per
  // row precedes the added frames (the row carries no `running`, so the
  // snapshot reads false).
  relay.transition('online')
  await waitForStream(relay, 1)
  const [refresh, status, added] = await readSome(iterator, 3)
  assert.deepEqual(refresh, { type: 'emit', event: 'llm/adapters-updated', args: [] })
  assert.deepEqual(status, {
    type: 'emit',
    event: 'api-session/status',
    args: [toVirtual(SERVER_ID, 'session-shared'), false],
  })
  assert.deepEqual(added, {
    type: 'emit',
    event: 'api-session/added',
    args: [{ sessionId: toVirtual(SERVER_ID, 'session-shared'), updatedAt: 5 }],
  })
  const listInvokes = relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list')
  assert.equal(listInvokes.length, 2, 'one pull for the announce, one for the T75 status re-sync')
  assert.deepEqual(listInvokes[0].args, { _request: {} })
  assert.deepEqual(listInvokes[1].args, { _request: {} })

  // The pull the announce stands in for: with the relay serving, the merged
  // list route folds the remote session in.
  const repulled = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, undefined)
  assert.deepEqual(repulled.value.items, [
    { sessionId: 'session-local', updatedAt: 1 },
    { sessionId: toVirtual(SERVER_ID, 'session-shared'), updatedAt: 5 },
  ])
  await iterator.return?.(undefined)
})

test('T63-fix: the workspace route nudges about an unannounced session id once — an already-announced id stays quiet', async () => {
  const { gateway, gates } = createPerEndpointGateway()
  const relay = createControllableRelay()
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: [T63_SHARED_ROW] },
  }
  // The sync's fetch must carry the host's wire shape (T63-fix), so the
  // mock refuses anything else exactly like the real server.
  enforceSessionListWireShape(relay)
  install(gateway, relay)
  const controller = new AbortController()
  const events = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const eventsIterator = events[Symbol.asyncIterator]()
  gates['$events'].push(READY)
  await readSome(eventsIterator, 1)
  await waitForStream(relay, 1)

  // The workspace leg: a local baseline, then the server's baseline carrying
  // the shared session. The forwarded upsert nudges the hub; the sync
  // fetches once and announces on the EVENTS stream (stream 0 is the events
  // leg, stream 1 the workspace leg).
  const workspaces = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const workspacesIterator = workspaces[Symbol.asyncIterator]()
  gates['workspace/follow'].push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 1)
  await waitForStream(relay, 2)
  assert.equal(relay.streams[1].method, 'follow')
  relay.streams[1].gate.push({ type: 'baseline', value: { items: [T63_WORKSPACE], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 4)
  const [added] = await readSome(eventsIterator, 1)
  assert.deepEqual(added, {
    type: 'emit',
    event: 'api-session/added',
    args: [{ sessionId: toVirtual(SERVER_ID, 'session-shared'), updatedAt: 5 }],
  })
  assert.equal(relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length, 1)

  // A second workspace frame carrying the SAME (announced) id: no new fetch,
  // no new announce — the hub's announced set gates the nudges.
  relay.streams[1].gate.push({ type: 'upsert', workspace: T63_WORKSPACE })
  await readSome(workspacesIterator, 1)
  await flushAsync()
  assert.equal(relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length, 1)
  await eventsIterator.return?.(undefined)
  await workspacesIterator.return?.(undefined)
})

test('T63/T65 regression: a hidden closed-remote session stays hidden, nudges once, and keeps riding its group', async () => {
  const { gateway, gates } = createPerEndpointGateway()
  const relay = createControllableRelay()
  // The server serves only the live session: the closed one left the share
  // table, so its list row is gone (the relay's output filter) — the announce
  // can never resurrect what the server no longer serves.
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: [T63_SHARED_ROW] },
  }
  // Same wire-shape gate as above: the announce only proves anything if the
  // fetch would actually serve on the real server.
  enforceSessionListWireShape(relay)
  // A readable current session (a LOCAL one) arms the T58 hiding; the fake
  // `now` crosses the T65 hide grace without real waiting.
  const { clock, advance } = clockWithFakeNow()
  const { handle } = install(gateway, relay, { getCurrentSession: () => ({ kind: 'open', sessionId: 'local-current' }), clock })
  const controller = new AbortController()
  const events = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const eventsIterator = events[Symbol.asyncIterator]()
  gates['$events'].push(READY)
  await readSome(eventsIterator, 1)
  await waitForStream(relay, 1)

  const workspaces = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const workspacesIterator = workspaces[Symbol.asyncIterator]()
  gates['workspace/follow'].push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 1)
  await waitForStream(relay, 2)
  // The server's baseline still lists BOTH sessions in the group…
  const both = { ...T63_WORKSPACE, sessionIds: ['session-shared', 'session-closed'] }
  relay.streams[1].gate.push({ type: 'baseline', value: { items: [both], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 4)
  // …and the announce that follows names only the live one.
  const [added] = await readSome(eventsIterator, 1)
  assert.deepEqual(added.args, [{ sessionId: toVirtual(SERVER_ID, 'session-shared'), updatedAt: 5 }])

  // The closure lands (the group's server-side copy retracts the closed
  // session): inside the hide grace the tombstone rides the group and
  // nothing is archived yet.
  const closedVirtual = toVirtual(SERVER_ID, 'session-closed')
  relay.streams[1].gate.push({ type: 'upsert', workspace: T63_WORKSPACE })
  const [duringGrace] = await readSome(workspacesIterator, 1)
  assert.deepEqual(duringGrace.workspace.sessionIds, [
    toVirtual(SERVER_ID, 'session-shared'),
    closedVirtual,
  ], 'the just-closed tombstone stays in the group inside the grace')
  // The closure's nudge asked about [shared, closed] — both already
  // announced-or-asked, so no second fetch: the tombstone nudges exactly
  // once even though it keeps riding every forwarded frame (T65).
  await flushAsync()
  assert.equal(relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length, 1)

  // Past the grace, the current-session re-judge (the poll's call) hides:
  // one archived frame on the workspace stream — and a refresher upsert
  // still carries the hidden id in the group.
  advance(2_001)
  handle.currentSessionChanged()
  const [archived] = await readSome(workspacesIterator, 1)
  assert.deepEqual(archived, { type: 'archived', archivedSessionIds: [closedVirtual] })
  relay.streams[1].gate.push({ type: 'upsert', workspace: T63_WORKSPACE })
  const [refresh] = await readSome(workspacesIterator, 1)
  assert.deepEqual(refresh.workspace.sessionIds, [
    toVirtual(SERVER_ID, 'session-shared'),
    closedVirtual,
  ], 'the hidden id keeps riding the forwarded group')
  await flushAsync()
  assert.equal(relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length, 1, 'still one fetch — asked-once holds')
  // No second added frame ever reached the events stream.
  await eventsIterator.return?.(undefined)
  await workspacesIterator.return?.(undefined)
  assert.equal(handle.diagnostics().recentFailures.length, 0)
})

/** A gateway whose `$events` taps each open a FRESH gate (the T65 multi-
 * subscriber tests drive two live $events generations side by side). */
function createMultiEventsGateway() {
  const gateway = new FakeTypertGateway()
  const gates = {}
  gateway.openWireStream = async function (endpoint, payload, uplink, peer, legSignal, control) {
    gateway.streamCalls.push({ endpoint, payload, uplink, peer, signal: legSignal, control })
    if (endpoint === '$events') {
      const gate = createGate(legSignal)
      ;(gates.events ??= []).push(gate)
      return gate.iterable
    }
    if (gates[endpoint] === undefined) gates[endpoint] = createGate(legSignal)
    return gates[endpoint].iterable
  }
  return { gateway, gates }
}

const T65_SECOND_ROW = { sessionId: 'session-second', updatedAt: 6 }
const T65_THIRD_ROW = { sessionId: 'session-third', updatedAt: 7 }

test('T65 sync: every live $events stream receives the nudge and announces for itself — two streams, two syncs, both quiet afterwards', async () => {
  const { gateway, gates } = createMultiEventsGateway()
  const relay = createControllableRelay()
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: [T63_SHARED_ROW] },
  }
  enforceSessionListWireShape(relay)
  install(gateway, relay)
  const controller = new AbortController()
  const openEvents = async () => {
    const events = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
    const iterator = events[Symbol.asyncIterator]()
    const index = gates.events.length - 1
    gates.events[index].push(READY)
    await readSome(iterator, 1)
    return iterator
  }
  const events1 = await openEvents()
  const events2 = await openEvents()
  const workspaces = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const workspacesIterator = workspaces[Symbol.asyncIterator]()
  gates['workspace/follow'].push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 1)
  await waitForStream(relay, 3)

  // ONE workspace nudge: the broadcast reaches BOTH streams, and each —
  // judging its own empty sets — runs its own sync and announces its own
  // consumer (the old latest-subscriber-wins hub starved the first stream).
  relay.streams[2].gate.push({ type: 'baseline', value: { items: [T63_WORKSPACE], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 4)
  const [added1] = await readSome(events1, 1)
  const [added2] = await readSome(events2, 1)
  assert.deepEqual(added1.args, [{ sessionId: toVirtual(SERVER_ID, 'session-shared'), updatedAt: 5 }])
  assert.deepEqual(added2.args, [{ sessionId: toVirtual(SERVER_ID, 'session-shared'), updatedAt: 5 }])
  const listCount = () => relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length
  assert.equal(listCount(), 2, 'each stream syncs for itself')

  // a second workspace frame with the SAME id: both streams' sets have it —
  // neither re-syncs, neither re-pushes
  relay.streams[2].gate.push({ type: 'upsert', workspace: T63_WORKSPACE })
  await readSome(workspacesIterator, 1)
  await flushAsync()
  assert.equal(listCount(), 2)
  await events1.return?.(undefined)
  await events2.return?.(undefined)
  await workspacesIterator.return?.(undefined)
})

test('T65 sync: a new page\'s stream syncs again after the previous page announced — the sets are per stream', async () => {
  // Fresh $events gates per tap: page 2's LOCAL leg must be a new stream, not
  // the drained one page 1 left behind.
  const { gateway, gates } = createMultiEventsGateway()
  const relay = createControllableRelay()
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: [T63_SHARED_ROW] },
  }
  enforceSessionListWireShape(relay)
  install(gateway, relay)
  const controller = new AbortController()
  // The events stream opens FIRST (relay stream 0), the workspace leg second
  // (relay stream 1) — the same order the T63 tests pin.
  const events1 = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const events1Iterator = events1[Symbol.asyncIterator]()
  gates.events[0].push(READY)
  await readSome(events1Iterator, 1)
  await waitForStream(relay, 1)
  const workspaces = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const workspacesIterator = workspaces[Symbol.asyncIterator]()
  gates['workspace/follow'].push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 1)
  await waitForStream(relay, 2)
  assert.equal(relay.streams[1].method, 'follow')

  // Page 1: the nudge announces the shared row on THIS stream.
  relay.streams[1].gate.push({ type: 'baseline', value: { items: [T63_WORKSPACE], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 4)
  const [added1] = await readSome(events1Iterator, 1)
  assert.deepEqual(added1.args, [{ sessionId: toVirtual(SERVER_ID, 'session-shared'), updatedAt: 5 }])
  const listCount = () => relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length
  assert.equal(listCount(), 1)
  await events1Iterator.return?.(undefined)

  // Page 2 (the refresh): a NEW $events generation whose sets start empty —
  // the same id nudges again and the sync runs again for the new consumer.
  const events2 = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const events2Iterator = events2[Symbol.asyncIterator]()
  gates.events[1].push(READY)
  await readSome(events2Iterator, 1)
  relay.streams[1].gate.push({ type: 'upsert', workspace: T63_WORKSPACE })
  const [added2] = await readSome(events2Iterator, 1)
  assert.deepEqual(added2.args, [{ sessionId: toVirtual(SERVER_ID, 'session-shared'), updatedAt: 5 }], 'the new generation is not skipped by the old one\'s sets')
  assert.equal(listCount(), 2)
  await events2Iterator.return?.(undefined)
  await workspacesIterator.return?.(undefined)
})

test('T65 sync: a later sync pushes only the rows not announced yet — announced rows are never re-pushed', async () => {
  const { gateway, gates } = createPerEndpointGateway()
  const relay = createControllableRelay()
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: [T63_SHARED_ROW, T65_SECOND_ROW] },
  }
  enforceSessionListWireShape(relay)
  install(gateway, relay)
  const controller = new AbortController()
  const events = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const eventsIterator = events[Symbol.asyncIterator]()
  gates['$events'].push(READY)
  await readSome(eventsIterator, 1)
  await waitForStream(relay, 1)
  const workspaces = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const workspacesIterator = workspaces[Symbol.asyncIterator]()
  gates['workspace/follow'].push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 1)
  await waitForStream(relay, 2)
  relay.streams[1].gate.push({ type: 'baseline', value: { items: [T63_WORKSPACE], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 4)

  // The first sync announces BOTH rows the list served.
  const [first1, first2] = await readSome(eventsIterator, 2)
  assert.deepEqual(first1.args, [{ sessionId: toVirtual(SERVER_ID, 'session-shared'), updatedAt: 5 }])
  assert.deepEqual(first2.args, [{ sessionId: toVirtual(SERVER_ID, T65_SECOND_ROW.sessionId), updatedAt: 6 }])

  // A THIRD session is shared mid-page: its id is unannounced, so one new
  // sync runs — and the fresh answer re-serves all three rows, of which
  // only the new one may reach the UI (a re-pushed row races the host's own
  // applyMutation and can flip a just-idle session back to running).
  relay.invokeValues['session/list'] = { items: [T63_SHARED_ROW, T65_SECOND_ROW, T65_THIRD_ROW] }
  relay.streams[1].gate.push({ type: 'upsert', workspace: { ...T63_WORKSPACE, sessionIds: ['session-shared', 'session-third'] } })
  await readSome(workspacesIterator, 1)
  const [third] = await readSome(eventsIterator, 1)
  assert.deepEqual(third.args, [{ sessionId: toVirtual(SERVER_ID, 'session-third'), updatedAt: 7 }], 'only the unannounced row travels')
  await flushAsync()
  assert.equal(relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length, 2)
  await eventsIterator.return?.(undefined)
  await workspacesIterator.return?.(undefined)
})

/** A clock whose timers the test FIRES by advancing — the T65-fix retry
 * backoff (2s/10s) is driven deterministically, with no real waiting. */
function manualClock() {
  let nowMs = 1_700_000_000_000
  const timers = new Map()
  let seq = 0
  const clock = {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      seq += 1
      timers.set(seq, { fn, at: nowMs + ms })
      return seq
    },
    clearTimeout: (id) => timers.delete(id),
    random: () => 0.5,
  }
  const advance = async (ms) => {
    nowMs += ms
    for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= nowMs) {
        timers.delete(id)
        timer.fn()
        await Promise.resolve()
      }
    }
    await flushAsync()
  }
  return { clock, advance }
}

const T65_NEW_ROW = { sessionId: 'session-new', updatedAt: 8 }

test('T65-fix sync: an id that appears while a sync is in flight runs its own follow-up round and is announced', async () => {
  const { gateway, gates } = createPerEndpointGateway()
  const relay = createControllableRelay()
  relay.invokeValues = { 'session/modelCatalog': SERVER_CATALOG }
  // A controllable session/list: each call parks its resolver (the
  // reviewer's harness). Each parked round resolves with the list snapshot
  // of its own moment.
  const pendingLists = []
  const baseInvoke = relay.invoke.bind(relay)
  relay.invoke = function (ns, m, args, signal) {
    if (ns === 'session' && m === 'list') {
      relay.invokes.push({ namespace: ns, method: m, args, signal })
      return new Promise((resolve) => pendingLists.push((value) => resolve(value)))
    }
    return baseInvoke(ns, m, args, signal)
  }
  install(gateway, relay)
  const controller = new AbortController()
  const events = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const eventsIterator = events[Symbol.asyncIterator]()
  gates['$events'].push(READY)
  await readSome(eventsIterator, 1)
  await waitForStream(relay, 1)
  const workspaces = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const workspacesIterator = workspaces[Symbol.asyncIterator]()
  gates['workspace/follow'].push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 1)
  await waitForStream(relay, 2)

  // Round 1 parks with session-shared as its trigger.
  relay.streams[1].gate.push({ type: 'baseline', value: { items: [T63_WORKSPACE], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 4)
  await flushAsync()
  assert.equal(pendingLists.length, 1, 'round 1 in flight')

  // MID-FLIGHT: a workspace frame carries the just-shared session-new. Its
  // id must NOT join round 1 — that round's list snapshot predates the
  // share, and marking session-new asked there would bury the row forever.
  relay.streams[1].gate.push({ type: 'upsert', workspace: { ...T63_WORKSPACE, sessionIds: ['session-shared', 'session-new'] } })
  await readSome(workspacesIterator, 1)
  await flushAsync()
  assert.equal(pendingLists.length, 1, 'the mid-flight batch did not start a second sync yet')

  // Round 1 lands serving only what its snapshot knew: session-shared.
  pendingLists[0]({ items: [T63_SHARED_ROW] })
  const [added1] = await readSome(eventsIterator, 1)
  assert.deepEqual(added1.args, [{ sessionId: toVirtual(SERVER_ID, 'session-shared'), updatedAt: 5 }])

  // The queued mid-flight batch runs as its OWN round against a fresh
  // snapshot, and session-new is announced by it.
  assert.equal(pendingLists.length, 2, 'exactly one follow-up round was queued beside round 1')
  pendingLists[1]({ items: [T63_SHARED_ROW, T65_NEW_ROW] })
  const [added2] = await readSome(eventsIterator, 1)
  assert.deepEqual(added2.args, [{ sessionId: toVirtual(SERVER_ID, 'session-new'), updatedAt: 8 }], 'session-new is announced by the follow-up round')

  // Both ids settled (announced or returned): a refresher frame pulls nothing.
  relay.streams[1].gate.push({ type: 'upsert', workspace: { ...T63_WORKSPACE, sessionIds: ['session-shared', 'session-new'] } })
  await readSome(workspacesIterator, 1)
  await flushAsync()
  assert.equal(relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length, 2)
  await eventsIterator.return?.(undefined)
  await workspacesIterator.return?.(undefined)
})

test('T65-fix sync: a session the server admits late is announced by the scheduled retry', async () => {
  const { clock, advance } = manualClock()
  const { gateway, gates } = createPerEndpointGateway()
  const relay = createControllableRelay()
  // The variant without any mid-flight timing: the server's list lags the
  // workspace frames in admitting a just-forked session.
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: [T63_SHARED_ROW] },
  }
  enforceSessionListWireShape(relay)
  install(gateway, relay, { clock })
  const controller = new AbortController()
  const events = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const eventsIterator = events[Symbol.asyncIterator]()
  gates['$events'].push(READY)
  await readSome(eventsIterator, 1)
  await waitForStream(relay, 1)
  const workspaces = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const workspacesIterator = workspaces[Symbol.asyncIterator]()
  gates['workspace/follow'].push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 1)
  await waitForStream(relay, 2)
  relay.streams[1].gate.push({ type: 'baseline', value: { items: [{ ...T63_WORKSPACE, sessionIds: ['session-shared', 'session-late'] }], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 4)
  // Round 1 announced shared; session-late was asked and not returned — the
  // first retry is scheduled at +2s.
  const [added1] = await readSome(eventsIterator, 1)
  assert.deepEqual(added1.args, [{ sessionId: toVirtual(SERVER_ID, 'session-shared'), updatedAt: 5 }])
  const listCount = () => relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length
  assert.equal(listCount(), 1)

  // The server catches up, the retry fires, and session-late is announced.
  relay.invokeValues['session/list'] = { items: [T63_SHARED_ROW, { sessionId: 'session-late', updatedAt: 9 }] }
  await advance(2_000)
  const [added2] = await readSome(eventsIterator, 1)
  assert.deepEqual(added2.args, [{ sessionId: toVirtual(SERVER_ID, 'session-late'), updatedAt: 9 }])
  assert.equal(listCount(), 2)
  await eventsIterator.return?.(undefined)
  await workspacesIterator.return?.(undefined)
})

test('T65-fix sync: a tombstone id triggers at most three session/list pulls — further frames never add more', async () => {
  const { clock, advance } = manualClock()
  const { gateway, gates } = createPerEndpointGateway()
  const relay = createControllableRelay()
  // The list NEVER carries session-tomb (its remote access was closed): no
  // round can ever return it.
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: [T63_SHARED_ROW] },
  }
  enforceSessionListWireShape(relay)
  install(gateway, relay, { clock })
  const controller = new AbortController()
  const events = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const eventsIterator = events[Symbol.asyncIterator]()
  gates['$events'].push(READY)
  await readSome(eventsIterator, 1)
  await waitForStream(relay, 1)
  const workspaces = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const workspacesIterator = workspaces[Symbol.asyncIterator]()
  gates['workspace/follow'].push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 1)
  await waitForStream(relay, 2)
  relay.streams[1].gate.push({ type: 'baseline', value: { items: [{ ...T63_WORKSPACE, sessionIds: ['session-shared', 'session-tomb'] }], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 4)
  const listCount = () => relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length
  await flushAsync()
  assert.equal(listCount(), 1, 'round 1: the initial ask')

  // The tombstone cannot be returned, so the conservative retries run: +2s,
  // then +10s — and after the third attempt the id is asked for good.
  await advance(2_000)
  await flushAsync()
  assert.equal(listCount(), 2, 'round 2: the first retry')
  await advance(10_000)
  await flushAsync()
  assert.equal(listCount(), 3, 'round 3: the second and final retry')
  await advance(10_000)
  await flushAsync()
  assert.equal(listCount(), 3, 'no scheduled anything after the cap')

  // Further workspace frames carrying the exhausted id never pull again —
  // the T65 guarantee (no infinite re-pull) still holds.
  for (let i = 0; i < 3; i += 1) {
    relay.streams[1].gate.push({ type: 'upsert', workspace: { ...T63_WORKSPACE, sessionIds: ['session-shared', 'session-tomb'] } })
    await readSome(workspacesIterator, 1)
  }
  await flushAsync()
  assert.equal(listCount(), 3)
  // The only announce ever pushed was the live row.
  await eventsIterator.return?.(undefined)
  await workspacesIterator.return?.(undefined)
})

test('T65-fix sync: a fresh serving period clears the ask bookkeeping — an exhausted id can be asked again', async () => {
  const { clock, advance } = manualClock()
  const { gateway, gates } = createPerEndpointGateway()
  const relay = createControllableRelay()
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: [T63_SHARED_ROW] },
  }
  enforceSessionListWireShape(relay)
  install(gateway, relay, { clock })
  const controller = new AbortController()
  const events = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const eventsIterator = events[Symbol.asyncIterator]()
  gates['$events'].push(READY)
  await readSome(eventsIterator, 1)
  await waitForStream(relay, 1)
  const workspaces = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const workspacesIterator = workspaces[Symbol.asyncIterator]()
  gates['workspace/follow'].push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 1)
  await waitForStream(relay, 2)
  relay.streams[1].gate.push({ type: 'baseline', value: { items: [{ ...T63_WORKSPACE, sessionIds: ['session-shared', 'session-tomb'] }], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(workspacesIterator, 4)
  const listCount = () => relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length
  // Drive the tombstone to exhaustion: three asks, none ever returned.
  await flushAsync()
  await advance(2_000)
  await flushAsync()
  await advance(10_000)
  await flushAsync()
  assert.equal(listCount(), 3)

  // The relay re-establishes its serving period: the bookkeeping clears and
  // the fresh-serving announce runs (plus, since T75, the status re-sync's
  // own pull — 4 pulls total).
  relay.transition('offline')
  await flushAsync()
  relay.transition('online')
  await flushAsync()
  assert.equal(listCount(), 5, 'the fresh serving period announces again — announce + status re-sync')
  // and the exhausted id has its chances back: one frame with it nudges a
  // fresh round (which still cannot return it — it re-enters the schedule).
  relay.streams[1].gate.push({ type: 'upsert', workspace: { ...T63_WORKSPACE, sessionIds: ['session-shared', 'session-tomb'] } })
  await readSome(workspacesIterator, 1)
  await flushAsync()
  assert.equal(listCount(), 6, 'the cleared bookkeeping lets the id be asked again')
  await eventsIterator.return?.(undefined)
  await workspacesIterator.return?.(undefined)
})

// -- T75: the serving-period status sync --------------------------------------

const T75_ROWS = [
  { sessionId: 'session-shared', updatedAt: 5, running: true },
  { sessionId: 'session-idle', updatedAt: 4, running: false },
]
const T75_STATUS_FRAMES = [
  { type: 'emit', event: 'api-session/status', args: [toVirtual(SERVER_ID, 'session-shared'), true] },
  { type: 'emit', event: 'api-session/status', args: [toVirtual(SERVER_ID, 'session-idle'), false] },
]

function offlineRelayWithRows() {
  const relay = createControllableRelay()
  // The page-load state: the UI's one list pull runs while the relay cannot
  // serve (the T63 hole — and the status flips inside the offline window are
  // equally lost, which the serving-period re-sync repairs).
  relay.state = 'offline'
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: T75_ROWS },
  }
  enforceSessionListWireShape(relay)
  return relay
}

test('T75: a new serving period pushes one status frame per row, and every new period pushes again', async () => {
  const relay = offlineRelayWithRows()
  const { iterator, localGate } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)

  // The relay starts serving: the T52 catalog refresh leads, then the two
  // syncs' synthesized emits — one status frame per row, value from the
  // snapshot.
  relay.transition('online')
  await waitForStream(relay, 1)
  const frames = await readSome(iterator, 5)
  assert.deepEqual(frames[0], { type: 'emit', event: 'llm/adapters-updated', args: [] })
  assert.deepEqual(
    frames.filter((frame) => frame.event === 'api-session/status'),
    T75_STATUS_FRAMES,
  )
  assert.equal(frames.filter((frame) => frame.event === 'api-session/added').length, 2, 'the T63 announce still runs beside the status sync')

  // A SECOND serving period: the status frames are pushed again — the
  // `announced` dedup gates only the row announcements, never the running
  // flags — while the announced rows stay quiet.
  relay.transition('offline')
  relay.transition('online')
  const frames2 = await readSome(iterator, 3)
  assert.deepEqual(frames2[0], { type: 'emit', event: 'llm/adapters-updated', args: [] })
  assert.deepEqual(
    frames2.filter((frame) => frame.event === 'api-session/status'),
    T75_STATUS_FRAMES,
  )
  assert.equal(frames2.some((frame) => frame.event === 'api-session/added'), false, 'announced rows are not re-announced')
  await iterator.return?.(undefined)
})

test('T75: a real-time status frame that lands mid-fetch outranks the list snapshot', async () => {
  const relay = offlineRelayWithRows()
  // The status sync's session/list fetch hangs until released — the window
  // a real server's slow answer would open. The WIRE shape stays policed.
  let releaseList = () => {}
  const listGate = new Promise((resolve) => { releaseList = resolve })
  const baseInvoke = relay.invoke
  relay.invoke = function (namespace, method, args, signal) {
    if (namespace === 'session' && method === 'list') {
      const keys = args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : []
      if (!(keys.length === 1 && keys[0] === '_request')) {
        return Promise.reject(new RelayError('gateway/arguments-invalid', 'session/list expects { _request: {...} }'))
      }
      return listGate.then(() => relay.invokeValues['session/list'])
    }
    return baseInvoke(namespace, method, args, signal)
  }
  const { iterator, localGate } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  relay.transition('online')
  await waitForStream(relay, 1)
  const [refresh] = await readSome(iterator, 1)
  assert.deepEqual(refresh, { type: 'emit', event: 'llm/adapters-updated', args: [] })

  // While the fetch hangs, the shared session flips to idle ON THE LEG — a
  // real-time fact fresher than the snapshot (whose row still says running).
  relay.streams[0].gate.push({ type: 'emit', event: 'api-session/status', args: ['session-shared', false] })
  const [live] = await readSome(iterator, 1)
  assert.deepEqual(live, { type: 'emit', event: 'api-session/status', args: [toVirtual(SERVER_ID, 'session-shared'), false] })

  releaseList()
  // The snapshot lands: the live frame's session is NOT overwritten (no
  // second status frame for it); the untouched row passes. The summary
  // sync's announce rode the same gate and follows — and (PB-26a) because
  // the live flip to idle predates the announce whose row still says
  // running, a realigning status frame follows THAT row's added frame
  // at once (the host's mergeSummary would otherwise re-mark it running
  // from the stale snapshot). The idle row saw no live frame: added only.
  const rest = await readSome(iterator, 1)
  assert.deepEqual(rest, [{ type: 'emit', event: 'api-session/status', args: [toVirtual(SERVER_ID, 'session-idle'), false] }])
  const added = await readSome(iterator, 3)
  assert.deepEqual(added.map((frame) => frame.event), ['api-session/added', 'api-session/status', 'api-session/added'])
  assert.deepEqual(added[1].args, [toVirtual(SERVER_ID, 'session-shared'), false], 'the realign carries the LIVE value, not the snapshot\'s')
  await iterator.return?.(undefined)
})

test('T75: the status sync obeys the local-ready gate — it defers until the UI stream has spoken', async () => {
  const relay = offlineRelayWithRows()
  const { iterator, localGate } = await openMergedEvents(relay)
  // Start the pumps (async generators run on the first pull) while the
  // relay is still offline, THEN open the serving period — the order a real
  // page loaded during an outage lives through.
  const firstPull = iterator.next()
  relay.transition('online')
  await waitForStream(relay, 1)
  await flushAsync()
  // Both syncs deferred: nothing fetched, so nothing synthesized — a frame
  // here would precede the ready and fail the client face's parser.
  assert.equal(relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length, 0, 'the syncs deferred past the ready')

  localGate.push(READY)
  const ready = (await firstPull).value
  assert.deepEqual(ready, READY)
  const frames = await readSome(iterator, 5)
  assert.deepEqual(frames[0], { type: 'emit', event: 'llm/adapters-updated', args: [] })
  assert.deepEqual(
    frames.filter((frame) => frame.event === 'api-session/status'),
    T75_STATUS_FRAMES,
  )
  await iterator.return?.(undefined)
})

// -- PB-26a: sidechat / subagent rows outside workspace/follow -----------------------

const V_SIDE_1 = toVirtual(SERVER_ID, 'session-side-1')
const V_SIDE_2 = toVirtual(SERVER_ID, 'session-side-2')

/** A relay online from the start (no serving-period syncs muddy the
 * baseline) whose `session/list` answers only after `release()` — the slow
 * server window a quick sidechat turn can end inside. The wire shape stays
 * policed. */
function onlineRelayWithHangingList(rows) {
  const relay = createControllableRelay()
  relay.invokeValues = { 'session/modelCatalog': SERVER_CATALOG }
  let release = () => {}
  const listGate = new Promise((resolve) => { release = resolve })
  const baseInvoke = relay.invoke
  relay.invoke = function (namespace, method, args, signal) {
    if (namespace === 'session' && method === 'list') {
      const keys = args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : []
      if (!(keys.length === 1 && keys[0] === '_request')) {
        return Promise.reject(new RelayError('gateway/arguments-invalid', 'session/list expects { _request: {...} }'))
      }
      relay.invokes.push({ namespace, method, args, signal })
      return listGate.then(() => ({ items: rows }))
    }
    return baseInvoke(namespace, method, args, signal)
  }
  const listCalls = () => relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length
  return { relay, release: () => release(), listCalls }
}

test('PB-26a: a real-time status for an UNANNOUNCED remote session (a sidechat child rides no workspace/follow frame) pulls session/list and announces the row; a flip during the pull is re-pushed right after the added frame', async () => {
  // The child's row as the server lists it AFTER the pull began: still
  // `running: true` from the snapshot's point of view.
  const { relay, release, listCalls } = onlineRelayWithHangingList([{ sessionId: 'session-side-1', updatedAt: 7, running: true }])
  const { iterator, localGate } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  await waitForStream(relay, 1)
  const gate = relay.streams[0].gate
  assert.equal(listCalls(), 0, 'an already-online relay runs no serving-period sync — the baseline is clean')

  // The child's turn starts: the server forwards status true. The UI has
  // no summary for this id (the host's handleSessionStatus drops the frame
  // for a session it does not list), so the leg must go and fetch the row.
  gate.push({ type: 'emit', event: 'api-session/status', args: ['session-side-1', true] })
  const [live] = await readSome(iterator, 1)
  assert.deepEqual(live, { type: 'emit', event: 'api-session/status', args: [V_SIDE_1, true] }, 'the live frame still crosses at once')
  await waitUntil(() => listCalls() === 1)

  // The quick turn ends while the pull hangs: status false travels live
  // (and, as the T65-fix rule says, a nudge landing mid-flight queues its
  // own follow-up round instead of joining the stale one).
  gate.push({ type: 'emit', event: 'api-session/status', args: ['session-side-1', false] })
  const [liveFalse] = await readSome(iterator, 1)
  assert.deepEqual(liveFalse, { type: 'emit', event: 'api-session/status', args: [V_SIDE_1, false] })
  assert.equal(listCalls(), 1, 'no second pull while the first is in flight')

  // The snapshot lands: the row is announced with the snapshot's stale
  // `running: true` — and the latest LIVE value follows immediately, so the
  // host's mergeSummary never leaves the row marked running.
  release()
  const [added, realigned] = await readSome(iterator, 2)
  assert.deepEqual(added, { type: 'emit', event: 'api-session/added', args: [{ sessionId: V_SIDE_1, updatedAt: 7, running: true }] })
  assert.deepEqual(realigned, { type: 'emit', event: 'api-session/status', args: [V_SIDE_1, false] })

  // The queued follow-up round pulls once more (its snapshot is fresh) and
  // announces nothing new; the stream stays otherwise silent.
  await waitUntil(() => listCalls() === 2)
  localGate.push({ type: 'emit', event: 'commands/change', args: [] })
  const [next] = await readSome(iterator, 1)
  assert.deepEqual(next, { type: 'emit', event: 'commands/change', args: [] }, 'no re-announce, no stray status frame')

  // Once announced, a later status for the same id is just a status frame:
  // no pull, no realign.
  gate.push({ type: 'emit', event: 'api-session/status', args: ['session-side-1', true] })
  const [later] = await readSome(iterator, 1)
  assert.deepEqual(later, { type: 'emit', event: 'api-session/status', args: [V_SIDE_1, true] })
  await flushAsync()
  assert.equal(listCalls(), 2, 'an announced id never pulls again')
  await iterator.return?.(undefined)
})

test('PB-26a: a status that AGREES with the announced row adds no realign frame', async () => {
  const { relay, release, listCalls } = onlineRelayWithHangingList([{ sessionId: 'session-side-1', updatedAt: 7, running: true }])
  const { iterator, localGate } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  await waitForStream(relay, 1)
  relay.streams[0].gate.push({ type: 'emit', event: 'api-session/status', args: ['session-side-1', true] })
  await readSome(iterator, 1)
  await waitUntil(() => listCalls() === 1)
  release()
  const [added] = await readSome(iterator, 1)
  assert.equal(added.event, 'api-session/added')
  localGate.push({ type: 'emit', event: 'commands/change', args: [] })
  const [next] = await readSome(iterator, 1)
  assert.deepEqual(next, { type: 'emit', event: 'commands/change', args: [] }, 'the snapshot already says running — nothing to realign')
  await iterator.return?.(undefined)
})

test('PB-26a: handle.nudgeSummarySync announces a virtual id discovered outside workspace/follow (the bridge minted it); non-virtual and empty ids are ignored, an announced id stays quiet', async () => {
  const relay = createControllableRelay()
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: [{ sessionId: 'session-side-2', updatedAt: 9 }] },
  }
  enforceSessionListWireShape(relay)
  const { iterator, localGate, handle } = await openMergedEvents(relay)
  localGate.push(READY)
  await readSome(iterator, 1)
  await waitForStream(relay, 1)
  const listCalls = () => relay.invokes.filter((call) => call.namespace === 'session' && call.method === 'list').length
  assert.equal(listCalls(), 0)

  // The plugin bridge just rewrote a sidechat.start answer: the minted id
  // reaches the sync through the handle — mixed in with the junk a careless
  // caller could pass, which must not trigger anything.
  handle.nudgeSummarySync(['', 'session-local-plain', V_SIDE_2])
  const [added] = await readSome(iterator, 1)
  assert.deepEqual(added, { type: 'emit', event: 'api-session/added', args: [{ sessionId: V_SIDE_2, updatedAt: 9 }] })
  assert.equal(listCalls(), 1)

  // No virtual id at all → no pull. An announced id → quiet.
  handle.nudgeSummarySync(['', 'session-local-plain'])
  handle.nudgeSummarySync([])
  await flushAsync()
  assert.equal(listCalls(), 1, 'nothing virtual, nothing pulled')
  handle.nudgeSummarySync([V_SIDE_2])
  await flushAsync()
  assert.equal(listCalls(), 1, 'an announced id nudges nothing')
  localGate.push({ type: 'emit', event: 'commands/change', args: [] })
  const [next] = await readSome(iterator, 1)
  assert.deepEqual(next, { type: 'emit', event: 'commands/change', args: [] }, 'no re-announce')
  await iterator.return?.(undefined)
})

test('PB-26a: a nudge that lands BEFORE the $events stream opens is served at the stream\'s ready (the pending slot)', async () => {
  const relay = createControllableRelay()
  relay.invokeValues = {
    'session/modelCatalog': SERVER_CATALOG,
    'session/list': { items: [{ sessionId: 'session-side-2', updatedAt: 9 }] },
  }
  enforceSessionListWireShape(relay)
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const { handle } = install(gateway, relay)
  handle.nudgeSummarySync([V_SIDE_2])
  const merged = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const iterator = merged[Symbol.asyncIterator]()
  localGate.push(READY)
  const [ready, added] = await readSome(iterator, 2)
  assert.deepEqual(ready, READY)
  assert.deepEqual(added, { type: 'emit', event: 'api-session/added', args: [{ sessionId: V_SIDE_2, updatedAt: 9 }] })
  await iterator.return?.(undefined)
})


// -- T52: the model catalog, the model selection, and the provider-bearing results ----

const LOCAL_CATALOG = {
  default: { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
  routableProviders: ['deepseek-account', 'openai-custom'],
  groups: [
    { id: 'deepseek-account', name: 'DeepSeek 账号', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
    { id: 'openai-custom', name: 'OpenAI 中转', models: [{ id: 'gpt-5.6', name: 'GPT-5.6' }] },
  ],
  failures: [{ id: 'broken', name: '坏的分组', message: 'boom' }],
}
const SERVER_CATALOG = {
  default: { provider: 'codex', model: 'gpt-5.6-sol' },
  routableProviders: ['codex'],
  groups: [{ id: 'codex', name: 'Codex', models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }] }],
  failures: [{ id: 'server-broken', name: '服务端坏的', message: '远端坏了' }],
}

test('T52: session/modelCatalog merges the relay groups behind the local ones; offline and remote failures answer the local result', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  gateway.spec.rpc = { 'session/modelCatalog': { ok: true, value: LOCAL_CATALOG } }
  relay.invokeValue = SERVER_CATALOG
  const { handle } = install(gateway, relay)

  const envelope = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.equal(envelope.ok, true)
  const merged = envelope.value
  // Local groups first, verbatim; the server group appended after with the
  // virtual group id and the server-prefixed name, its models untouched.
  assert.deepEqual(merged.groups[0], LOCAL_CATALOG.groups[0])
  assert.deepEqual(merged.groups[1], LOCAL_CATALOG.groups[1])
  assert.deepEqual(merged.groups[2], {
    id: toVirtual(SERVER_ID, 'codex'),
    name: `${SERVER_MARK}测试服务器 · Codex`,
    models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
  })
  // default and failures stay LOCAL (server failures never alarm the
  // dropdown); routableProviders mirrors the merged group ids.
  assert.deepEqual(merged.default, LOCAL_CATALOG.default)
  assert.deepEqual(merged.failures, LOCAL_CATALOG.failures)
  assert.deepEqual(merged.routableProviders, ['deepseek-account', 'openai-custom', toVirtual(SERVER_ID, 'codex')])
  // One relay invoke, parameterless.
  assert.deepEqual(relay.invokes, [{ namespace: 'session', method: 'modelCatalog', args: {}, signal: undefined }])

  // A failed remote call degrades to the local catalog and records a ring
  // entry — a dead link must never take the model picker down.
  relay.invokeThrow = new RelayError('offline', '链路断了')
  const fallback = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.deepEqual(fallback.value, LOCAL_CATALOG)
  assert.equal(handle.diagnostics().recentFailures.at(-1).code, 'offline')

  // Offline (T52-fix): the last fetched server groups still merge in — a
  // refreshed dropdown must not go blank and an open remote session's
  // trigger must not fall back to the raw `zr~…` string — while the relay
  // itself is never asked.
  relay.invokeThrow = undefined
  relay.transition('offline')
  const offlineAnswer = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.equal(offlineAnswer.ok, true)
  assert.deepEqual(offlineAnswer.value.groups[2], {
    id: toVirtual(SERVER_ID, 'codex'),
    name: `${SERVER_MARK}测试服务器 · Codex`,
    models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
  })
  assert.deepEqual(offlineAnswer.value.failures, LOCAL_CATALOG.failures, 'only the local failures travel')
  assert.equal(relay.invokes.length, 2)

  // A DIFFERENT server's handshake never serves the old cache: offline with
  // a mismatched identity the answer is local-only (a re-pair elsewhere must
  // not keep showing the previous server's groups).
  relay.handshakeInfo = { ...relay.handshakeInfo, serverId: 'ffffffff', serverName: '别服' }
  relay.transition('offline')
  const otherServerOffline = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.deepEqual(otherServerOffline.value, LOCAL_CATALOG, 'the old server\'s cache does not survive a server change')

  // The pairing wall clears the cache outright: while the wall stands the
  // answer is local-only, and re-serving the same server refetches.
  relay.transition('unpaired')
  const afterUnpair = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.deepEqual(afterUnpair.value, LOCAL_CATALOG)
  handle.uninstall()
})

test('T52-fix2: the online transition fetches the server catalog proactively; failures only diagnose', async () => {
  const gateway = new FakeTypertGateway()
  gateway.spec.rpc = { 'session/modelCatalog': { ok: true, value: LOCAL_CATALOG } }
  const relay = createFakeRelay()
  relay.invokeValues = { 'session/modelCatalog': SERVER_CATALOG }
  relay.state = 'offline'
  const { handle } = install(gateway, relay)
  assert.deepEqual(relay.invokes, [], 'nothing is fetched before the relay serves')

  // The online transition fetches once, parameterless, and fills the cache —
  // the provider gate must not depend on the UI opening a dropdown first.
  relay.transition('online')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(relay.invokes, [{ namespace: 'session', method: 'modelCatalog', args: {}, signal: undefined }])

  // The proactive answer feeds the OFFLINE merge: a dropdown refreshed while
  // the link is down still shows the server groups.
  relay.transition('offline')
  const offlineAnswer = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.equal(offlineAnswer.value.groups.at(-1).id, toVirtual(SERVER_ID, 'codex'), 'the proactive fetch filled the cache the offline merge reads')
  assert.equal(relay.invokes.length, 1, 'the offline answer never re-asks the relay')

  // A failed proactive fetch is a diagnostics-ring entry, nothing else — and
  // the NEXT transition retries.
  relay.invokeValues = {}
  relay.invokeThrow = new RelayError('offline', '链路断了')
  relay.transition('online')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(relay.invokes.length, 2)
  assert.equal(handle.diagnostics().recentFailures.at(-1).code, 'offline')

  // A re-pair wall drops the cache EAGERLY — the same rule the route applies
  // lazily on its own offline branch: offline right after the wall, the
  // answer is local-only even though a successful fetch had filled the cache
  // just before (and a failed refetch had not emptied it).
  relay.transition('unpaired')
  relay.transition('offline')
  const cleared = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.deepEqual(cleared.value, LOCAL_CATALOG, 'the wall cleared the cache the offline merge would otherwise have served')

  // Re-serving refetches, and uninstall stops the watcher: a late online
  // transition after it fetches nothing.
  relay.invokeThrow = undefined
  relay.invokeValues = { 'session/modelCatalog': SERVER_CATALOG }
  relay.transition('online')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(relay.invokes.length, 3, 're-serving refetches')
  handle.uninstall()
  relay.transition('online')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(relay.invokes.length, 3, 'no fetch after uninstall')
})

test('T52-fix3: installing while the relay already serves fetches the catalog at once — subscribe replays no state', async () => {
  // relay-client.ts setState returns on a same-state write, so a subscriber
  // learns of `online` only on the NEXT transition. An install into an
  // already-serving relay must therefore ask by itself: the gateway is
  // already up (plugin reload while connected) and the projections it
  // serves rewrite unconditionally — but the OFFLINE merge of the dropdown
  // still wants the cache filled at the first flap, not the first
  // dropdown open.
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay() // online at install, like the real reload shape
  relay.invokeValues = { 'session/modelCatalog': SERVER_CATALOG }
  const log = makeLog()
  const handle = installIntercept({
    raw: gateway,
    relay,
    getServerId: () => SERVER_ID,
    log: log.log,
  })
  assert.deepEqual(relay.invokes, [{ namespace: 'session', method: 'modelCatalog', args: {}, signal: undefined }], 'the install itself asked once')
  await new Promise((resolve) => setImmediate(resolve))
  // The answer fed the cache: taking the relay down right away, the offline
  // merge still serves the server groups.
  relay.transition('offline')
  gateway.spec.rpc = { 'session/modelCatalog': { ok: true, value: LOCAL_CATALOG } }
  const offlineAnswer = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.equal(offlineAnswer.value.groups.at(-1).id, toVirtual(SERVER_ID, 'codex'), 'the install-time fetch filled the cache the offline merge reads')
  handle.uninstall()
})

test('T52-fix3: a proactive catalog fetch that was in flight when the wall rose never writes the cache', async () => {
  const gateway = new FakeTypertGateway()
  gateway.spec.rpc = { 'session/modelCatalog': { ok: true, value: LOCAL_CATALOG } }
  const relay = createFakeRelay()
  // Hold every catalog fetch in flight until the test releases it.
  const pendingCatalogs = []
  relay.invoke = (namespace, method, args, signal) => {
    relay.invokes.push({ namespace, method, args, signal })
    if (namespace === 'session' && method === 'modelCatalog') {
      return new Promise((resolve) => { pendingCatalogs.push(resolve) })
    }
    return Promise.resolve(relay.invokeValue)
  }
  relay.state = 'offline'
  const { handle } = install(gateway, relay)
  relay.transition('online')
  assert.equal(relay.invokes.length, 1, 'the transition fetched, still in flight')

  // The wall rises while the fetch is in flight; the answer lands AFTER.
  relay.transition('unpaired')
  for (const resolve of pendingCatalogs.splice(0)) resolve(SERVER_CATALOG)
  await new Promise((resolve) => setImmediate(resolve))

  // Offline after the wall: the stale answer must not resurrect the old
  // groups — the route answers local-only.
  relay.transition('offline')
  const offlineAnswer = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.deepEqual(offlineAnswer.value, LOCAL_CATALOG, 'the in-flight answer was discarded with the wall')
  handle.uninstall()
})

test('T52-fix3: the catalog route\'s own fetch invalidated by a wall answers the caller but writes no cache', async () => {
  const gateway = new FakeTypertGateway()
  gateway.spec.rpc = { 'session/modelCatalog': { ok: true, value: LOCAL_CATALOG } }
  const relay = createFakeRelay()
  const pendingCatalogs = []
  relay.invoke = (namespace, method, args, signal) => {
    relay.invokes.push({ namespace, method, args, signal })
    if (namespace === 'session' && method === 'modelCatalog') {
      return new Promise((resolve) => { pendingCatalogs.push(resolve) })
    }
    return Promise.resolve(relay.invokeValue)
  }
  const { handle } = install(gateway, relay)
  relay.invokes.length = 0 // ignore the install-time probe; this test drives the route

  // The route's fetch starts while online — and hangs. One macrotask lets
  // the async route body reach its relay.invoke (it sits behind the awaited
  // local dispatch).
  const merged = gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(relay.invokes.length, 1, 'the route asked the relay, still in flight')
  relay.transition('unpaired')
  for (const resolve of pendingCatalogs.splice(0)) resolve(SERVER_CATALOG)
  const answer = await merged
  // The CALLER still gets its live answer — it asked while the link served.
  assert.equal(answer.ok, true)
  assert.equal(answer.value.groups.at(-1).id, toVirtual(SERVER_ID, 'codex'), 'the live answer is not withheld')

  // But the cache stayed empty: offline after the wall, the answer is
  // local-only — the walled groups do not resurrect through the cache.
  relay.transition('offline')
  const after = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.deepEqual(after.value, LOCAL_CATALOG, 'the invalidated fetch never re-entered the cache')
  handle.uninstall()
})

test('T5x: after a pairing wall the same server going offline never serves the pre-unpair cache', async () => {
  // The drop must not depend on a catalog call happening to run while the
  // wall stands: unpair → (no call) → re-pair to the SAME server that cannot
  // be reached lands offline, and a refreshed dropdown must not resurrect
  // the pre-unpair groups. The install subscribes to the relay's states, so
  // the transition itself is the drop.
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  gateway.spec.rpc = { 'session/modelCatalog': { ok: true, value: LOCAL_CATALOG } }
  relay.invokeValue = SERVER_CATALOG
  const { handle } = install(gateway, relay)

  // Online: the fetch fills the cache and the merge carries the server group.
  const merged = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.equal(merged.ok, true)
  assert.equal(merged.value.groups.length, 3, 'the server group merged in while online')

  // The wall rises — and NO catalog call observes it (nothing is asked while
  // unpaired; the next call only comes after the offline re-pair attempt).
  relay.transition('unpaired')
  relay.transition('offline')
  const offline = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  assert.equal(offline.ok, true)
  assert.deepEqual(offline.value, LOCAL_CATALOG, 'the pre-unpair groups never served again for the same server id')
  assert.equal(relay.invokes.length, 1, 'offline serves no relay ask either')
  handle.uninstall()
})

test('T52: session/selectModel routes the provider by session context', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.invokeValues = {
    // The proactive install fetch (T52-fix3) shares this staged answer, so
    // the cache is filled before the assertions below read it.
    'session/modelCatalog': SERVER_CATALOG,
  }
  relay.invokeValue = { selected: { provider: 'codex', model: 'gpt-5.6-sol' } }
  const { handle } = install(gateway, relay)
  await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)

  // Remote session + the server's own group → the provider travels restored
  // to the original id, and the echoed selection comes back virtual.
  const remote = await gateway.rpcBridge(
    'session/selectModel',
    { args: { request: { sessionId: VIRTUAL_ID, provider: toVirtual(SERVER_ID, 'codex'), model: 'gpt-5.6-sol' } } },
    undefined,
    undefined,
  )
  assert.equal(remote.ok, true)
  assert.deepEqual(relay.invokes[1].args, { request: { sessionId: LOCAL_ID, provider: 'codex', model: 'gpt-5.6-sol' } })
  assert.deepEqual(remote.value, { selected: { provider: toVirtual(SERVER_ID, 'codex'), model: 'gpt-5.6-sol' } })

  // Remote session + a LOCAL group → refused with the server's name in the
  // message; the relay is never asked.
  const refused = await gateway.rpcBridge(
    'session/selectModel',
    { args: { request: { sessionId: VIRTUAL_ID, provider: 'deepseek-account', model: 'deepseek-v4-pro' } } },
    undefined,
    undefined,
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'remote-unsupported')
  assert.match(refused.error.message, /测试服务器/)
  assert.deepEqual(refused.error.details, {})
  assert.equal(relay.invokes.length, 2)

  // Local session + a virtual group → refused before the local gateway sees it.
  const localCallsBefore = gateway.rpcCalls.length
  const localRefused = await gateway.rpcBridge(
    'session/selectModel',
    { args: { request: { sessionId: LOCAL_ID, provider: toVirtual(SERVER_ID, 'codex'), model: 'gpt-5.6-sol' } } },
    undefined,
    undefined,
  )
  assert.equal(localRefused.ok, false)
  assert.equal(localRefused.error.code, 'remote-unsupported')
  assert.equal(gateway.rpcCalls.length, localCallsBefore, 'the refusal never reached the local gateway')

  // Local session + local group → the plain local call, byte-for-byte.
  const localArgs = { args: { request: { sessionId: LOCAL_ID, provider: 'deepseek-account', model: 'deepseek-v4-pro' } } }
  await gateway.rpcBridge('session/selectModel', localArgs, undefined, undefined)
  assert.deepEqual(gateway.rpcCalls.at(-1).payload, localArgs)

  // Another server's group for this server's session → remote-mismatch.
  const mismatch = await gateway.rpcBridge(
    'session/selectModel',
    { args: { request: { sessionId: VIRTUAL_ID, provider: toVirtual('ffffffff', 'codex'), model: 'x' } } },
    undefined,
    undefined,
  )
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.error.code, 'remote-mismatch')

  // A session of ANOTHER server → the generic path's mismatch verdict (this
  // route steps aside — the sessionId is the registered field there).
  const wrongServer = await gateway.rpcBridge(
    'session/selectModel',
    { args: { request: { sessionId: toVirtual('ffffffff', 's'), provider: 'deepseek-account', model: 'm' } } },
    undefined,
    undefined,
  )
  assert.equal(wrongServer.ok, false)
  assert.equal(wrongServer.error.code, 'remote-mismatch')

  // T52-fix3: an echoed provider is virtualized UNCONDITIONALLY — no catalog
  // gate (first-write-wins per seq forbids one). The cache now holds a
  // catalog WITHOUT codex and the echo still names codex: it goes back
  // virtual all the same (accepted cost: the UI renders the `zr~…` string
  // for a provider its server catalog does not list).
  relay.invokeValues = { 'session/modelCatalog': { groups: [{ id: 'deepseek-official', name: 'DeepSeek' }] } }
  await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  const foreignEcho = await gateway.rpcBridge(
    'session/selectModel',
    { args: { request: { sessionId: VIRTUAL_ID, provider: toVirtual(SERVER_ID, 'deepseek-official'), model: 'deepseek-v4-pro' } } },
    undefined,
    undefined,
  )
  assert.deepEqual(foreignEcho.value, { selected: { provider: toVirtual(SERVER_ID, 'codex'), model: 'gpt-5.6-sol' } }, 'the echo is virtual with or without a matching catalog')
  handle.uninstall()
})

test('T52: remote projections and follow snapshots carry the virtual group id; local results stay verbatim', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const selection = {
    lastUsed: { provider: 'codex', model: 'gpt-5.6-sol' },
    next: { provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
  }
  relay.invokeValues = { 'session/modelCatalog': SERVER_CATALOG }
  relay.invokeValue = { asOfSeq: 7, values: { modelSelection: selection, title: '远端' } }
  const { handle } = install(gateway, relay)

  // T52-fix3, SAME-SEQ CONSISTENCY: the rewrite may not depend on when the
  // catalog arrived — the host's projection store is first-write-wins per
  // seq (lib/client.js:986-994), so a pre-catalog original would occupy the
  // seq and the later virtual value would be dropped forever. Assert the
  // value read BEFORE any catalog exists and AFTER the fetch agree exactly.
  const early = await gateway.rpcBridge('session/projections', { args: { request: { sessionId: VIRTUAL_ID } } }, undefined, undefined)
  assert.deepEqual(early.value.values.modelSelection, {
    lastUsed: { provider: toVirtual(SERVER_ID, 'codex'), model: 'gpt-5.6-sol' },
    next: { provider: toVirtual(SERVER_ID, 'codex'), model: 'gpt-5.6-sol', reasoningEffort: 'high' },
  }, 'the pre-catalog rewrite is already the virtual value')

  // Fill the cache (SERVER_CATALOG lists codex) the way the online fetch
  // would; the same read rewrites identically.
  await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)

  // session/projections: the modelSelection value's providers go virtual,
  // its models and the other projection values stay verbatim.
  const projections = await gateway.rpcBridge('session/projections', { args: { request: { sessionId: VIRTUAL_ID } } }, undefined, undefined)
  assert.deepEqual(projections.value.values.modelSelection, {
    lastUsed: { provider: toVirtual(SERVER_ID, 'codex'), model: 'gpt-5.6-sol' },
    next: { provider: toVirtual(SERVER_ID, 'codex'), model: 'gpt-5.6-sol', reasoningEffort: 'high' },
  })
  assert.equal(projections.value.values.title, '远端')

  // session/page: NO projections rewrite (T52-fix) — the result is
  // `{records, hasMore}` only (RT lib/typert.remote-client.js:549-566), and
  // whatever a caller pads onto it passes through verbatim.
  relay.invokeValue = { records: [{ type: 'event', event: { type: 'model/selection', seq: 2, time: 1, data: selection } }], hasMore: false, projections: { asOfSeq: 3, values: { modelSelection: selection } } }
  const page = await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  assert.deepEqual(page.value, relay.invokeValue, 'the page result travels untouched')

  // session/follow: the snapshot seeds the projection store — its
  // projections block rewrites; the header and the raw event frames do not.
  relay.streamFrames = [
    { type: 'snapshot', header: { version: 4, id: LOCAL_ID }, cursor: 5, hasMore: false, projections: { asOfSeq: 5, values: { modelSelection: selection } } },
    { type: 'event', event: { type: 'model/selection', seq: 6, time: 2, data: { provider: 'codex', model: 'gpt-5.6-sol' } } },
  ]
  const frames = await drained(gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined }))
  assert.equal(frames[0].header.id, VIRTUAL_ID)
  assert.equal(frames[0].projections.values.modelSelection.lastUsed.provider, toVirtual(SERVER_ID, 'codex'))
  assert.equal(frames[0].projections.values.modelSelection.next.provider, toVirtual(SERVER_ID, 'codex'))
  assert.deepEqual(frames[1].event.data, { provider: 'codex', model: 'gpt-5.6-sol' }, 'event bodies keep their own ids')

  // T52-fix3: swap the cache to a catalog WITHOUT codex (the isolated-repro
  // shape — a DeepSeek-only server against a codex session) and the rewrite
  // is STILL the same virtual value — catalog presence changes nothing.
  relay.invokeValue = { asOfSeq: 7, values: { modelSelection: selection, title: '远端' } }
  relay.invokeValues = { 'session/modelCatalog': { groups: [{ id: 'deepseek-official', name: 'DeepSeek' }] } }
  await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)
  const foreign = await gateway.rpcBridge('session/projections', { args: { request: { sessionId: VIRTUAL_ID } } }, undefined, undefined)
  assert.deepEqual(foreign.value.values.modelSelection, early.value.values.modelSelection, 'the rewrite is identical with a catalog that lacks the provider')
  assert.deepEqual(foreign.value.values.modelSelection, projections.value.values.modelSelection, 'all three reads above agree byte for byte')

  // The LOCAL half of the same routes never passes through these rewrites:
  // a local session's page result reaches the gateway verbatim (the wrapper
  // only answers calls it forwards) — proven by the relay not being asked
  // and the local call carrying the original payload.
  const localArgs = { args: { request: { address: { kind: 'session', sessionId: LOCAL_ID } } } }
  await gateway.rpcBridge('session/page', localArgs, undefined, undefined)
  assert.deepEqual(gateway.rpcCalls.at(-1).payload, localArgs)
  assert.equal(relay.invokes.length, 6)
  handle.uninstall()
})

test('blank remote session (asOfSeq: -1) seeds virtualized modelSelection.next from cached remote catalog default while settled sessions stay untouched', async () => {
  const gateway = new FakeTypertGateway({
    rpc: { 'session/list': { ok: true, value: { items: [] } } },
  })
  const relay = createFakeRelay()
  const remoteDefault = { provider: 'deepseek-account', model: 'deepseek-chat', reasoningEffort: 'high' }
  relay.invokeValues = {
    'session/modelCatalog': {
      groups: [{ id: 'deepseek-account', name: 'DeepSeek' }],
      default: remoteDefault,
    },
  }
  const { handle } = install(gateway, relay)
  await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, undefined)

  const expectedDefault = {
    provider: toVirtual(SERVER_ID, 'deepseek-account'),
    model: 'deepseek-chat',
    reasoningEffort: 'high',
  }

  // 1) session/follow snapshot at asOfSeq: -1
  relay.streamFrames = [
    {
      type: 'snapshot',
      header: { version: 4, id: LOCAL_ID, cwd: '/tmp' },
      cursor: 0,
      records: [],
      projections: { kind: 'sequenced', asOfSeq: -1, values: { modelSelection: { lastUsed: null, next: null } } },
    },
  ]
  const followFrames = await drained(
    gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined }),
  )
  assert.deepEqual(followFrames[0].projections.values.modelSelection, { lastUsed: null, next: expectedDefault })

  // 2) session/projections RPC at asOfSeq: -1 vs settled asOfSeq >= 0
  relay.invokeValue = { asOfSeq: -1, values: { modelSelection: { lastUsed: null, next: null } } }
  const blankProj = await gateway.rpcBridge('session/projections', { args: { request: { sessionId: VIRTUAL_ID } } }, undefined, undefined)
  assert.deepEqual(blankProj.value.values.modelSelection, { lastUsed: null, next: expectedDefault })

  relay.invokeValue = { asOfSeq: 6, values: { modelSelection: { lastUsed: { provider: 'codex', model: 'sol' }, next: null } } }
  const settledProj = await gateway.rpcBridge('session/projections', { args: { request: { sessionId: VIRTUAL_ID } } }, undefined, undefined)
  assert.deepEqual(settledProj.value.values.modelSelection, { lastUsed: { provider: toVirtual(SERVER_ID, 'codex'), model: 'sol' }, next: null })

  // 3) session/list RPC: blank (asOfSeq: -1) gets next seeded; settled (asOfSeq: 6) keeps next: null
  relay.invokeValue = {
    items: [
      {
        sessionId: 'blank-1',
        updatedAt: 2,
        projections: { kind: 'sequenced', asOfSeq: -1, values: { modelSelection: { lastUsed: null, next: null } } },
      },
      {
        sessionId: 'settled-1',
        updatedAt: 1,
        projections: { kind: 'sequenced', asOfSeq: 6, values: { modelSelection: { lastUsed: { provider: 'codex', model: 'sol' }, next: null } } },
      },
    ],
  }
  const listRes = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, gateway.operatorPeer())
  assert.deepEqual(listRes.value.items[0].projections.values.modelSelection, { lastUsed: null, next: expectedDefault })
  assert.deepEqual(listRes.value.items[1].projections.values.modelSelection, { lastUsed: { provider: toVirtual(SERVER_ID, 'codex'), model: 'sol' }, next: null })

  handle.uninstall()
})

test('T52: the merged $events leg emits the catalog-refresh frame on serving transitions, deduped per identity, deferred past the local ready', async () => {
  const REFRESH = { type: 'emit', event: 'llm/adapters-updated', args: [] }
  // Deferred: the relay is ALREADY online when the stream opens, but the
  // state listener never ran — the refresh comes from the first transition,
  // after the local ready frame.
  const relay = createControllableRelay()
  const { localGate, iterator } = await openMergedEvents(relay)
  localGate.push(READY)
  const [ready] = await readSome(iterator, 1)
  assert.equal(ready.type, 'ready')
  await waitForStream(relay, 1)
  relay.transition('offline')
  relay.transition('online')
  const [refresh] = await readSome(iterator, 1)
  assert.deepEqual(refresh, REFRESH, 'the offline→online transition refreshed the catalog')

  // Continuous serving period: a redundant online notification refreshes
  // nothing (the real client notifies on state changes only), and the next
  // real offline→online pair refreshes exactly once more. A mere offline
  // does NOT cut the remote leg (only unpaired/revoked do), so the frames
  // still ride the original gate.
  relay.transition('online')
  relay.transition('offline')
  relay.transition('online')
  relay.streams[0].gate.push(SERVER_WATERFALL)
  const [second, waterfall] = await readSome(iterator, 2)
  assert.deepEqual(second, REFRESH, 'the second outage refreshed once')
  assert.equal(waterfall.eventId, V_REMOTE_EVENT)

  // A rename while serving refreshes under the new identity.
  relay.handshakeInfo = { ...relay.handshakeInfo, serverName: '改名服务器' }
  relay.transition('offline')
  relay.transition('online')
  const [renamedRefresh] = await readSome(iterator, 1)
  assert.deepEqual(renamedRefresh, REFRESH)
  await iterator.return?.(undefined)

  // A transition landing BEFORE the local ready is deferred: the emit may
  // only leave after the `ready` the UI's pump validates first. The first
  // next() call starts the generator body on the microtask queue (async
  // generators resume asynchronously — the transitions must wait out one
  // macrotask so the state listener is actually registered).
  const cold = createControllableRelay()
  const coldOpen = await openMergedEvents(cold)
  // The FIRST next() starts the generator body (async generators resume on
  // the microtask queue — the transitions below must wait out one macrotask
  // so the state listener is registered). That same request is kept as the
  // reader of the first frame: async-generator requests are served FIFO, so
  // leaving it pending beside readSome's would steal the ready frame.
  const first = coldOpen.iterator.next()
  await new Promise((resolve) => setImmediate(resolve))
  cold.transition('offline')
  cold.transition('online')
  coldOpen.localGate.push(READY)
  const coldReady = await first
  assert.equal(coldReady.done, false)
  assert.equal(coldReady.value.type, 'ready')
  const deferred = await coldOpen.iterator.next()
  assert.deepEqual(deferred.value, REFRESH, 'the pre-ready refresh left after the ready frame')
  await coldOpen.iterator.return?.(undefined)
})
