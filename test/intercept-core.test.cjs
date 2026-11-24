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


// -- 1. shape detection ---------------------------------------------------------

test('checkGatewayShape: the faithful fake passes with no reasons', () => {
  const verdict = checkGatewayShape(new FakeTypertGateway())
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.notes, [])
})

test('checkGatewayShape: each broken shape fails with its own reason', () => {
  // a) missing method — a STANDALONE class: a subclass cannot hide an
  //    inherited method by deletion, and its own constructor source would
  //    fail the dynamic-call check instead
  class MissingDispatch {
    constructor() {
      this.wireStream = { open: (endpoint, payload, uplink, peer, signal) => this.openWireStream(endpoint, payload, uplink, peer, signal, { signal }) }
      this.rpcBridge = (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)
      this.wireTap = (endpoint, payload, uplink, peer, signal, control) => this.openWireStream(endpoint, payload, uplink, peer, control.signal, control)
    }
    operatorPeer() { return { id: 'p' } }
    openWireStream(endpoint, payload, uplink, peer, signal, control) {
      return (async function* () { yield { type: 'baseline' } })()
    }
    // dispatchRpc deliberately absent from the prototype
  }
  const missing = checkGatewayShape(new MissingDispatch())
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.reasons, ['prototype: dispatchRpc is not a function'])

  // b) wrong arity
  class WrongArity extends FakeTypertGateway {}
  WrongArity.prototype.dispatchRpc = function (endpoint, payload, signal) { return this.dispatchRpc(endpoint, payload, signal) }
  const arity = checkGatewayShape(new WrongArity())
  assert.equal(arity.ok, false)
  assert.ok(arity.reasons.some((r) => r.includes('dispatchRpc has 3 parameters, expected 4')), arity.reasons.join('; '))

  // c) constructor binds directly instead of dynamic lookup — the load-bearing
  //    check: everything else looks fine, only the source grep refuses.
  class ClosureGateway {
    constructor() {
      const proto = ClosureGateway.prototype
      this.rpcBridge = (endpoint, payload, signal, peer) => proto.dispatchRpc.call(this, endpoint, payload, signal, peer)
      this.wireTap = (endpoint, payload, uplink, peer, signal, control) => proto.openWireStream.call(this, endpoint, payload, uplink, peer, control.signal, control)
    }
    operatorPeer() { return { id: 'p' } }
    dispatchRpc(endpoint, payload, signal, peer) { this.rpcCalls = this.rpcCalls || []; return Promise.resolve({ ok: true, value: null }) }
    openWireStream(endpoint, payload, uplink, peer, signal, control) { return (async function* () { yield { type: 'baseline' } })() }
  }
  Object.defineProperty(ClosureGateway.prototype, 'wireStream', { value: { open() { return (async function* () { yield { type: 'baseline' } })() } }, enumerable: true })
  const closure = checkGatewayShape(new ClosureGateway())
  assert.equal(closure.ok, false)
  assert.equal(closure.reasons.length, 2, closure.reasons.join('; '))
  assert.ok(closure.reasons.every((r) => r.startsWith('constructor:')), closure.reasons.join('; '))

  // d) not an object at all
  for (const junk of [undefined, null, 42, 'gateway', []]) {
    const verdict = checkGatewayShape(junk)
    assert.equal(verdict.ok, false, String(typeof junk))
    assert.ok(verdict.reasons.length > 0)
  }
})

test('checkGatewayShape: an existing own property is a note, not a failure', () => {
  const raw = new FakeTypertGateway()
  raw.dispatchRpc = function (endpoint, payload, signal, peer) { return FakeTypertGateway.prototype.dispatchRpc.call(this, endpoint, payload, signal, peer) }
  const verdict = checkGatewayShape(raw)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.notes.length, 1)
  assert.match(verdict.notes[0], /dispatchRpc.*own property/)
})

/** The DSH 0.2.1-alpha.3 gateway shape: openWireStream takes a seventh
 * `uplinkWindow`, the mux call site passes `window`, operatorPeer is gone
 * and every stream asserts a live Peer (RT dsh-api-gateway 0.2.1-alpha.3). */
class Alpha3TypertGateway {
  constructor() {
    this.streamCalls = []
    this.wireStream = {
      open: (endpoint, payload, uplink, peer, signal) => this.openWireStream(endpoint, payload, uplink, peer, signal, new AbortController()),
    }
    this.rpcBridge = (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)
    this.muxTap = (endpoint, payload, uplink, peer, control, window) => this.openWireStream(endpoint, payload, uplink, peer, control.signal, control, window)
  }
  async dispatchRpc(endpoint, payload, signal, peer) {
    if (peer === undefined) throw new TypeError("Cannot read properties of undefined (reading 'signal')")
    return { ok: true, value: { endpoint } }
  }
  async openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow) {
    if (peer === undefined) throw new TypeError("Cannot read properties of undefined (reading 'signal')")
    this.streamCalls.push({ endpoint, payload, uplink, peer, signal, control, uplinkWindow })
    return (async function* () { yield { type: 'baseline', value: { items: [] } } })()
  }
}

test('checkGatewayShape: the alpha.3 7-parameter openWireStream and window call site pass', () => {
  assert.equal(Alpha3TypertGateway.prototype.openWireStream.length, 7)
  const verdict = checkGatewayShape(new Alpha3TypertGateway())
  assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.reasons.join('; '))
})

test('checkGatewayShape: an 8-parameter openWireStream is still refused', () => {
  class TooMany extends Alpha3TypertGateway {}
  TooMany.prototype.openWireStream = function (a, b, c, d, e, f, g, h) { return Alpha3TypertGateway.prototype.openWireStream.call(this, a, b, c, d, e, f, g) }
  const verdict = checkGatewayShape(new TooMany())
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reasons.some((r) => r.includes('has 8 parameters, expected 6 or 7')), verdict.reasons.join('; '))
})

test('alpha.3: the wrap passes uplinkWindow through and the self-check opens as the owner Peer', async () => {
  const gateway = new Alpha3TypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const window = { credit: 4 }
  const control = new AbortController()
  const ownerPeer = { principal: { kind: 'owner' }, interactions: 'answer', signal: new AbortController().signal }
  const stream = await gateway.muxTap('job/list', { args: { request: { sessionId: 's1' } } }, undefined, ownerPeer, control, window)
  for await (const _ of stream) break
  assert.equal(gateway.streamCalls.at(-1).uplinkWindow, window, 'the 7th argument reached the original')
  assert.equal(gateway.streamCalls.at(-1).peer, ownerPeer)

  const noPeer = await behaviorSelfCheck(gateway, { timeoutMs: 500 })
  assert.equal(noPeer.ok, false, 'alpha.3 refuses a Peer-less probe (no operatorPeer fallback)')
  const outcome = await behaviorSelfCheck(gateway, { getPeer: () => ownerPeer })
  assert.deepEqual(outcome, { ok: true })
  assert.equal(gateway.streamCalls.at(-1).peer, ownerPeer)
  handle.uninstall()
})

test('a shape refusal installs nothing (wiring)', async () => {
  const { apply } = await import(INDEX_URL)
  class BrokenGateway extends FakeTypertGateway {}
  delete BrokenGateway.prototype.dispatchRpc
  const gateway = new BrokenGateway()
  const { ctx, registered, warns } = makeWiringCtx({ connection: { admit: () => ({}) }, typertGateway: { [symbols.original]: gateway } })
  apply(ctx, { role: 'client' })
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), false, 'no wrap on a broken gateway')
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'dispatchRpc'), false)
  assert.ok(warns.some((args) => String(args[0]).includes('intercept not installed')), warns.map(String).join('|'))
  const status = await serveOnce(registered, '/_dsh/zen-remote/client/status')
  assert.equal(status.intercept.installed, false)
  assert.equal(status.intercept.shape.ok, false)
  assert.ok(status.intercept.shape.reasons.length > 0)
})

test('issue #53: the intercept waits for the connection service — absent means no install, present means install + self-check pass', async () => {
  const { apply } = await import(INDEX_URL)
  const gateway = new Alpha3TypertGateway()
  const ownerPeer = { principal: { kind: 'owner' }, interactions: 'answer', signal: new AbortController().signal }

  // typertGateway up, connection NOT yet: the install inject must not fire.
  // Before the fix the callback ran on typertGateway alone, the self-check
  // could not mint an owner Peer (the host gateway service only pulls
  // connection in through a NESTED inject, so it lags), the alpha.3 gateway
  // answered `reading 'signal'` and the one-retry-then-uninstall policy tore
  // the whole interception down with no recovery path.
  const early = makeWiringCtx({ typertGateway: { [symbols.original]: gateway } })
  apply(early.ctx, { role: 'client' })
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), false,
    'no wrap while the connection service is absent')
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'dispatchRpc'), false)
  assert.ok(!early.warns.some((args) => String(args[0]).includes('client intercept')),
    'the typert intercept wiring stayed silent while connection was absent (the plugin-route intercept refusal above is its own, unrelated install)')

  // connection arrives — a fresh apply is the unit-level stand-in for the
  // service registering after the gateway: the inject now fires, the wrap
  // installs, and the self-check opens workspace/follow AS the minted owner
  // Peer instead of undefined.
  const wired = makeWiringCtx({
    connection: { createPeer: () => ownerPeer },
    typertGateway: { [symbols.original]: gateway },
  })
  apply(wired.ctx, { role: 'client' })
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), true,
    'the wrap installed once connection is available')
  const deadline = Date.now() + 2_000
  while (!wired.infos.some((args) => String(args[0]).includes('self-check passed'))) {
    if (Date.now() > deadline) {
      assert.fail('the self-check never passed — infos=' + JSON.stringify(wired.infos.map(String))
        + ' warns=' + JSON.stringify(wired.warns.map(String)))
    }
    await flushAsync()
  }
  assert.equal(gateway.streamCalls.at(-1).peer, ownerPeer,
    'the probe reached the gateway as the minted owner Peer, never undefined')
})

// -- 2. local passthrough ---------------------------------------------------------

test('a call without virtual ids reaches the original method untouched', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const payload = { args: { request: { sessionId: LOCAL_ID, title: '本地改名' } } }
  const envelope = await gateway.rpcBridge('session/rename', payload, undefined, gateway.operatorPeer())
  assert.deepEqual(relay.invokes, [], 'nothing travels to the relay')
  assert.equal(gateway.rpcCalls.length, 1)
  assert.equal(gateway.rpcCalls[0].payload, payload, 'the original payload object, not a copy')
  assert.deepEqual(envelope, { ok: true, value: { endpoint: 'session/rename' } })
  assert.equal(handle.wrappedCalls().dispatchRpc, 1, 'the wrap was entered')
  handle.uninstall()
})

test('a non-global stream without virtual ids passes through verbatim, uplink included', async () => {
  const frames = [{ type: 'rows', jobs: [] }, { type: 'order', workspaceIds: [] }]
  const gateway = new FakeTypertGateway({ stream: { 'job/list': frames } })
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const uplink = { write() {} }
  const control = { signal: undefined }
  const iterable = await gateway.wireTap('job/list', { args: {} }, uplink, gateway.operatorPeer(), undefined, control)
  assert.deepEqual(await drained(iterable), frames, 'frames unchanged')
  assert.equal(relay.streams.length, 0)
  assert.equal(gateway.streamCalls.length, 1)
  assert.equal(gateway.streamCalls[0].uplink, uplink, 'the uplink object rides through')
  assert.equal(gateway.streamCalls[0].control, control)
  assert.equal(handle.wrappedCalls().openWireStream, 1)
  handle.uninstall()
})

// -- 3. session/page: virtual address restored for the relay ----------------------

test('session/page forwards the ORIGINAL id and passes the result through', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const pageValue = { records: [{ type: 'event', event: { type: 'user/message', seq: 1, data: {} } }], hasMore: false }
  relay.invokeValue = pageValue
  const { handle } = install(gateway, relay)
  const args = { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, throughSeq: 5 } }
  const envelope = await gateway.rpcBridge('session/page', { args }, undefined, gateway.operatorPeer())
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value, pageValue, 'session/page has no result ids — the value is untouched')
  assert.deepEqual(relay.invokes, [{
    namespace: 'session',
    method: 'page',
    args: { request: { address: { kind: 'session', sessionId: LOCAL_ID }, throughSeq: 5 } },
    signal: undefined,
  }])
  assert.equal(args.request.address.sessionId, VIRTUAL_ID, 'the caller arguments are never mutated')
  handle.uninstall()
})

test('a subagent address restores childSessionId and optional parentSessionId, rejecting cross-server pairs', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const childId = 'session-child-original'
  const envelope = await gateway.rpcBridge('session/page', {
    args: { request: { address: { kind: 'subagent', parentSessionId: toVirtual(SERVER_ID, 'session-parent'), childSessionId: childId, mode: 'continuable' } } },
  }, undefined, undefined)
  assert.equal(envelope.ok, true)
  assert.equal(relay.invokes[0].args.request.address.parentSessionId, 'session-parent')
  assert.equal(relay.invokes[0].args.request.address.childSessionId, childId, 'non-virtual child id stays untouched')

  const bothVirtual = await gateway.rpcBridge('session/page', {
    args: { request: { address: { kind: 'subagent', parentSessionId: toVirtual(SERVER_ID, 'p2'), childSessionId: toVirtual(SERVER_ID, 'c2'), mode: 'continuable' } } },
  }, undefined, undefined)
  assert.equal(bothVirtual.ok, true)
  assert.equal(relay.invokes[1].args.request.address.parentSessionId, 'p2')
  assert.equal(relay.invokes[1].args.request.address.childSessionId, 'c2')

  const childOnly = await gateway.rpcBridge('session/page', {
    args: { request: { address: { kind: 'subagent', childSessionId: toVirtual(SERVER_ID, 'c3') } } },
  }, undefined, undefined)
  assert.equal(childOnly.ok, true)
  assert.equal(relay.invokes[2].args.request.address.childSessionId, 'c3')

  const cross = await gateway.rpcBridge('session/page', {
    args: { request: { address: { kind: 'subagent', parentSessionId: toVirtual(SERVER_ID, 'p'), childSessionId: toVirtual('eeeeeeee', 'c') } } },
  }, undefined, undefined)
  assert.equal(cross.ok, false)
  assert.equal(cross.error.code, 'remote-mismatch')
  handle.uninstall()
})

// -- 4. session/follow: frame rewriting and coded stream errors --------------------

test('session/follow rewrites snapshot header ids to virtual and relays errors with codes', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.streamFrames = [
    { type: 'snapshot', header: { version: 4, id: LOCAL_ID, cwd: '/tmp' }, cursor: 3, records: [] },
    { type: 'event', event: { type: 'session/end-seed', seq: 4, data: {} } },
  ]
  const { handle } = install(gateway, relay)
  const control = { signal: undefined }
  const iterable = gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID }, assistantStream: true } } }, undefined, undefined, undefined, control)
  const frames = await drained(iterable)
  assert.deepEqual(relay.streams, [{ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: LOCAL_ID }, assistantStream: true } }, signal: undefined }])
  assert.deepEqual(frames[0].header, { version: 4, id: VIRTUAL_ID, cwd: '/tmp' })
  assert.equal(frames[1], relay.streamFrames[1], 'event frames carry no session id — same object passes through')

  relay.streamFrames = []
  relay.streamThrow = new RelayError('unshared', 'the session is not shared any more')
  const refused = gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, control)
  await assert.rejects(drained(refused), (error) => {
    // The host folds unmarked errors into gateway/internal — only an error
    // marked isDSHRemoteError with a string code keeps its identity across
    // the wire (dsh-typert-protocol's remoteErrorOf).
    assert.equal(error.isDSHRemoteError, true, 'the marker remoteErrorOf checks')
    assert.equal(error.code, 'unshared')
    assert.equal(error.message, '远程已关闭', "the banner's word, never the server's internal message (T73)")
    assert.ok(error.details !== null && typeof error.details === 'object', 'details is an object')
    assert.equal(error instanceof RelayError, false, 'a locally built coded error, not the relay client class')
    return true
  })
  handle.uninstall()
})

test('job/list frames and workspace results get their session ids virtualized', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const owner = 'session-owner'
  relay.streamFrames = [{ type: 'rows', jobs: [{ id: 'j1', owner }, { id: 'j2', owner: LOCAL_ID }] }]
  const frames = await drained(gateway.wireTap('job/list', { args: { request: { sessionId: VIRTUAL_ID } } }, undefined, undefined, undefined, { signal: undefined }))
  assert.deepEqual(frames, [{ type: 'rows', jobs: [{ id: 'j1', owner: toVirtual(SERVER_ID, owner) }, { id: 'j2', owner: VIRTUAL_ID }] }])

  // job/follow: `opened{job}` and `status{job}` carry the job record — its
  // owner is a session id; the `output` frame has none and passes through.
  relay.streamFrames = [
    { type: 'opened', job: { id: 'j9', owner: LOCAL_ID, status: 'running' }, from: 0 },
    { type: 'output', chunks: [{ at: 1, text: 'hi', channel: 'stdout' }], next: 2, lossy: false },
    { type: 'status', job: { id: 'j9', owner: 'session-third', status: 'completed' } },
  ]
  const followFrames = await drained(gateway.wireTap('job/follow', { args: { request: { sessionId: VIRTUAL_ID, jobId: 'j9' } } }, undefined, undefined, undefined, { signal: undefined }))
  assert.deepEqual(followFrames, [
    { type: 'opened', job: { id: 'j9', owner: VIRTUAL_ID, status: 'running' }, from: 0 },
    { type: 'output', chunks: [{ at: 1, text: 'hi', channel: 'stdout' }], next: 2, lossy: false },
    { type: 'status', job: { id: 'j9', owner: toVirtual(SERVER_ID, 'session-third'), status: 'completed' } },
  ])

  const pinned = { pinnedSessionIds: [LOCAL_ID, 'session-other'] }
  relay.invokeValue = pinned
  const pin = await gateway.rpcBridge('workspace/pinSession', { args: { request: { sessionId: VIRTUAL_ID } } }, undefined, undefined)
  assert.deepEqual(pin.value, { pinnedSessionIds: [VIRTUAL_ID, toVirtual(SERVER_ID, 'session-other')] })
  assert.deepEqual(pinned, { pinnedSessionIds: [LOCAL_ID, 'session-other'] }, 'the relay value is copied, not mutated')

  relay.invokeValue = { ok: false, error: { code: 'session-not-found', sessionId: LOCAL_ID } }
  const feedback = await gateway.rpcBridge('messageFeedback/put', { args: { request: { sessionId: VIRTUAL_ID, messageId: 'm', rating: 'up' } } }, undefined, undefined)
  assert.equal(feedback.value.error.sessionId, VIRTUAL_ID, 'even the error variant carries its id rewritten')
  handle.uninstall()
})

// -- 5. unsupported methods ------------------------------------------------------

test('an unregistered method carrying a virtual id is refused before anything runs', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const envelope = await gateway.rpcBridge('schedule/update', { args: { request: { id: 's1', sessionId: VIRTUAL_ID } } }, undefined, undefined)
  // `details: {}` is what the UI's server-response parser REQUIRES — a
  // details-less failure throws `invalid server-response failure` there.
  assert.deepEqual(envelope, { ok: false, error: { code: 'remote-unsupported', message: '此功能暂不支持远程会话', details: {} } })
  assert.equal(gateway.rpcCalls.length, 0, 'the local gateway never saw the virtual id')
  assert.equal(relay.invokes.length, 0)

  await assert.rejects(
    async () => gateway.wireTap('schedule/watch', { args: { agentId: VIRTUAL_ID, request: { objective: 'x', maxGoalRounds: 1 } } }, undefined, undefined, undefined, { signal: undefined }),
    (error) => error.isDSHRemoteError === true && error.code === 'remote-unsupported' && typeof error.details === 'object',
  )
  assert.equal(gateway.streamCalls.length, 0)
  assert.equal(relay.streams.length, 0)
  handle.uninstall()
})

test('a GLOBAL read owns no fields, so a stray id in its args stays local (T23b-2 merges)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  // session/list / workspace/follow / session/control own NO field — nothing
  // in their arguments locates a session, so nothing is forwarded and
  // nothing is refused: merging their state is T23b-2's job. (The deep scan
  // for unowned ids applies to UNREGISTERED methods, not to these.)
  const payload = { args: { _request: { cursor: VIRTUAL_ID } } }
  const envelope = await gateway.rpcBridge('session/list', payload, undefined, undefined)
  assert.deepEqual(envelope, { ok: true, value: { endpoint: 'session/list' } }, 'the local gateway answered')
  assert.equal(gateway.rpcCalls.length, 1)
  assert.equal(relay.invokes.length, 0)
  assert.equal(handle.diagnostics().recentFailures.length, 0)
  handle.uninstall()
})

// -- 6. server mismatch ------------------------------------------------------------

test('virtual ids from another server (or mixed servers) are remote-mismatch', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const foreign = toVirtual('ffffffff', 'session-elsewhere')

  // a) single id, wrong server
  const envelope = await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: foreign } } } }, undefined, undefined)
  assert.equal(envelope.error.code, 'remote-mismatch')
  assert.equal(gateway.rpcCalls.length, 0)
  assert.equal(relay.invokes.length, 0)

  // b) two ids of DIFFERENT servers inside one call (deep-scanned table-miss)
  const mixed = await gateway.rpcBridge('schedule/update', { args: { request: { id: 's1', sessionId: VIRTUAL_ID, label: toVirtual('eeeeeeee', 'x') } } }, undefined, undefined)
  assert.equal(mixed.error.code, 'remote-mismatch')

  // c) a stream with a foreign id throws instead of answering
  await assert.rejects(
    async () => gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: foreign } } } }, undefined, undefined, undefined, { signal: undefined }),
    (error) => error.isDSHRemoteError === true && error.code === 'remote-mismatch',
  )
  handle.uninstall()
})

test('before the first handshake the answer is remote-offline, not mismatch', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay, { getServerId: () => undefined })
  const envelope = await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  // Not connected yet is a different fact from being pointed at the wrong
  // server — the settings surface words them differently.
  assert.deepEqual(envelope, { ok: false, error: { code: 'remote-offline', message: '尚未连接到服务端', details: {} } })
  handle.uninstall()

  // English mode renders English messages
  const { handle: enHandle } = install(gateway, relay, { getServerId: () => undefined, lang: 'en' })
  const enEnvelope = await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  assert.deepEqual(enEnvelope, { ok: false, error: { code: 'remote-offline', message: 'Not connected to the server yet', details: {} } })
  enHandle.uninstall()
})

// -- 7. uplink ---------------------------------------------------------------------

test('the mux\'s uplink inbox is released and the remote stream still opens', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  relay.streamFrames = [{ type: 'snapshot', header: { id: LOCAL_ID } }]
  // The WebSocket multiplex channel passes an UplinkInbox on EVERY open —
  // never undefined — so the wrap must half-close it (the host's own move
  // for `$events`) and forward, not refuse: refusing uplinks would refuse
  // every remote stream the UI opens.
  let released = false
  const inbox = {
    [Symbol.asyncIterator]() { return this },
    next: async () => ({ done: true }),
    return() { released = true; return Promise.resolve({ done: true }) },
  }
  const frames = await drained(gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, inbox, undefined, undefined, { signal: undefined }))
  assert.equal(frames[0].header.id, VIRTUAL_ID, 'the stream opened and its frames were rewritten')
  assert.equal(relay.streams.length, 1, 'relay.openStream was called')
  assert.ok(released, 'the uplink inbox was return()-ed')
  assert.equal(gateway.streamCalls.length, 0, 'the local gateway stayed out of the path')
  // A hostile/broken uplink must not take the stream down with it.
  relay.streamFrames = [{ type: 'snapshot', header: { id: LOCAL_ID } }]
  const badUplink = { [Symbol.asyncIterator]() { throw new Error('no iterator for you') } }
  const frames2 = await drained(gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, badUplink, undefined, undefined, { signal: undefined }))
  assert.equal(frames2[0].header.id, VIRTUAL_ID, 'a non-iterable uplink is tolerated')
  handle.uninstall()
})


// -- 8. uninstall -------------------------------------------------------------------

test('uninstall removes the own properties and restores the prototype path', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), true)
  handle.uninstall()
  handle.uninstall() // idempotent
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'dispatchRpc'), false)
  const envelope = await gateway.rpcBridge('session/rename', { args: { request: { sessionId: 'S', title: 'x' } } }, undefined, undefined)
  assert.equal(gateway.rpcCalls.length, 1, 'calls reach the prototype method again')
  assert.equal(handle.wrappedCalls().dispatchRpc, 0, 'the wrap is out of the path — it never saw a call')
  assert.equal(handle.diagnostics().installed, false)
})

// -- 9. stacking over an existing wrapper ---------------------------------------------

test('installing over an existing own property chains to it and restores it', async () => {
  const gateway = new FakeTypertGateway()
  const outerCalls = []
  const protoDispatch = FakeTypertGateway.prototype.dispatchRpc
  const outer = function (endpoint, payload, signal, peer) {
    outerCalls.push({ endpoint, payload })
    return protoDispatch.call(this, endpoint, payload, signal, peer)
  }
  gateway.dispatchRpc = outer
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  await gateway.rpcBridge('session/rename', { args: { request: { sessionId: 'S', title: 'x' } } }, undefined, undefined)
  assert.equal(outerCalls.length, 1, 'the pre-existing wrapper sits in front of the prototype')
  assert.equal(gateway.rpcCalls.length, 1)

  // A remote call stacking over the outer wrapper: our wrap forwards, the
  // outer wrapper is not consulted.
  await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  assert.equal(outerCalls.length, 1)
  assert.equal(relay.invokes.length, 1)

  handle.uninstall()
  assert.equal(gateway.dispatchRpc, outer, 'exactly the saved value is restored')
  await gateway.rpcBridge('session/rename', { args: { request: { sessionId: 'S2', title: 'y' } } }, undefined, undefined)
  assert.equal(outerCalls.length, 2, 'the outer wrapper still works after our uninstall')
  assert.equal(gateway.rpcCalls.length, 2)
})

// -- 6b. uninstalling underneath a later wrapper --------------------------------------

test('uninstall leaves a LATER wrapper alone and goes inert underneath it', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  // Another plugin wraps OVER our dispatchRpc after we installed.
  const laterCalls = []
  const ours = gateway.dispatchRpc
  const later = function (endpoint, payload, signal, peer) {
    laterCalls.push({ endpoint })
    return ours.call(this, endpoint, payload, signal, peer)
  }
  gateway.dispatchRpc = later

  handle.uninstall()
  assert.equal(gateway.dispatchRpc, later, 'the later wrapper stays in place')
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), false, 'the untouched property is still cleaned up')

  // Our inert wrap passthrough: a VIRTUAL id now reaches the LOCAL gateway
  // instead of being forwarded — the interception is out of the business.
  await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  assert.equal(laterCalls.length, 1, 'the later wrapper stayed in the path')
  assert.equal(gateway.rpcCalls.length, 1, 'the call reached the local prototype')
  assert.equal(relay.invokes.length, 0, 'nothing was forwarded')
})

// -- 10. the two method tables agree ---------------------------------------------------

test('CLIENT_METHOD_FIELDS and OPTIONAL_CLIENT_METHOD_FIELDS match RELAY_METHODS', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay-access.js'), 'utf8')
  const serverTable = {}
  const serverOptionalTable = {}
  const parseList = (src) => src
    .split(',')
    .map((raw) => raw.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
  for (const [, endpoint, fieldsSrc, optionalSrc] of source.matchAll(/^    '([a-zA-Z$/]+)': \{ fields: \[([^\]]*)\](?:, optionalFields: \[([^\]]*)\])?/gm)) {
    serverTable[endpoint] = parseList(fieldsSrc)
    if (optionalSrc !== undefined) {
      serverOptionalTable[endpoint] = parseList(optionalSrc)
    }
  }
  assert.ok(Object.keys(serverTable).length >= 20, `the regex still finds the server table (${Object.keys(serverTable).length} entries)`)
  assert.deepEqual(CLIENT_METHOD_FIELDS, serverTable)
  assert.deepEqual(OPTIONAL_CLIENT_METHOD_FIELDS, serverOptionalTable)
  assert.deepEqual(serverOptionalTable['subagents/prompt'], ['request.parentSessionId'])
  assert.deepEqual(serverOptionalTable['workspace/insertSessionBefore'], ['request.beforeSessionId'])
  // T41a: the NEW field types are compared too — string equality would hide a
  // typo only if both sides misspelled it the same way, so pin the shapes the
  // registry grew by name.
  assert.deepEqual(serverTable['terminal/create'], ['agentId'])
  assert.deepEqual(serverTable['terminal/list'], ['sessionId'])
  assert.deepEqual(serverTable['terminal/retain'], ['sessionId'])
  assert.deepEqual(serverTable['workspaceFiles/list'], ['workspaceFileScopeId'])
  assert.deepEqual(serverTable['sessionFeedback/record'], ['request.sessionId'])
  assert.deepEqual(serverTable['subagents/prompt'], ['request.childSessionId'])
  assert.deepEqual(serverTable['subagents/interruptByParent'], ['parentSessionId', 'childSessionId'])
  assert.deepEqual(serverTable['subagents/interruptByUser'], ['childSessionId'])
  assert.deepEqual(serverTable['workspaceFiles/search'], ['workspaceFileScopeId'])
  assert.deepEqual(serverTable['officeKit/render'], ['workspaceFileScopeId'])
  assert.deepEqual(serverTable['terminal/watch'], ['sessionId'])
  // Every field either table names is one of the known field types — a typo
  // on either side fails here instead of silently matching itself.
  const KNOWN = new Set([
    'request.sessionId', 'request.address', 'request.parentSessionId', 'request.childSessionId', 'request.beforeSessionId', 'request.workspaceId',
    'parentSessionId', 'childSessionId', 'sessionId', 'workspaceFileScopeId', 'agentId',
  ])
  for (const fields of [...Object.values(serverTable), ...Object.values(serverOptionalTable)]) {
    for (const field of fields) assert.ok(KNOWN.has(field), `unknown field type: ${field}`)
  }
})

// -- diagnostics -------------------------------------------------------------------

test('diagnostics reports the shape verdict, the self-check and the failure ring', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  handle.noteSelfCheck({ ok: true })
  await gateway.rpcBridge('schedule/update', { args: { request: { id: 's1', sessionId: VIRTUAL_ID } } }, undefined, undefined)
  await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: toVirtual('ffffffff', 's') } } } }, undefined, undefined)
  const diagnostics = handle.diagnostics()
  assert.equal(diagnostics.installed, true)
  assert.equal(diagnostics.shape.ok, true)
  assert.deepEqual(diagnostics.selfCheck, { ok: true })
  assert.deepEqual(diagnostics.recentFailures.map((f) => [f.endpoint, f.code]), [
    ['schedule/update', 'remote-unsupported'],
    ['session/page', 'remote-mismatch'],
  ])
  for (const failure of diagnostics.recentFailures) assert.match(failure.time, /^\d{4}-\d{2}-\d{2}T/)
  // The ring caps at 20.
  for (let i = 0; i < 25; i += 1) {
    await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: toVirtual('ffffffff', 's') } } } }, undefined, undefined)
  }
  assert.equal(handle.diagnostics().recentFailures.length, 20)
  // An envelope failure ALSO lands in the ring (a relay refusal is a remote
  // call failure like any other) — and its envelope carries the host-mandated
  // `details` object: dsh-client-connection refuses a failure without one, so
  // the forwardInvoke catch branch must not skip it.
  relay.invokeThrow = new RelayError('not-shared')
  const thrown = await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  assert.equal(thrown.ok, false)
  assert.deepEqual(thrown.error.details, {}, 'the catch-branch envelope carries details: {}')
  assert.equal(thrown.error.message, '远程已关闭', 'a closed session reads like the banner, not the bare code (T73)')
  const ring = handle.diagnostics().recentFailures
  assert.equal(ring[ring.length - 1].code, 'not-shared')
  handle.uninstall()
})

// -- the incompatible-call ring (T42) ---------------------------------------------

test('validation-refused remote calls land in incompatibleCalls (T42)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  // A server-side parameter validation refusal travels as the gateway's DSH
  // code through a 200 {ok:false} envelope.
  relay.invokeThrow = new RelayError('gateway/arguments-invalid', 'args fields do not match the descriptor')
  await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  // The stream route records through the same funnel.
  relay.streamThrow = new RelayError('gateway/input-invalid', 'wire field "request" failed boundary validation')
  await (async () => { try { for await (const f of gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined })) void f } catch { /* the coded throw is expected */ } })()
  const diagnostics = handle.diagnostics()
  assert.deepEqual(diagnostics.incompatibleCalls.map((c) => [c.endpoint, c.code]), [
    ['session/page', 'gateway/arguments-invalid'],
    ['session/follow', 'gateway/input-invalid'],
  ])
  for (const call of diagnostics.incompatibleCalls) {
    assert.equal(typeof call.time, 'number', 'the settings view renders epoch milliseconds directly')
    assert.ok(Number.isFinite(call.time))
  }
  handle.uninstall()
})

test('non-validation refusals never enter the incompatible ring (T42, T42-fix)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  for (const code of ['not-shared', 'remote-mismatch', 'offline', 'gateway/cancelled', 'internal', 'gateway/result-invalid']) {
    relay.invokeThrow = new RelayError(code)
    await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  }
  // `gateway/invocation-unavailable` DOES count (T42-fix): the client called
  // an endpoint an older server does not export — a version symptom. But
  // `gateway/result-invalid` does NOT: it only flags a stream method that
  // returned no iterable (a server implementation bug), and the gateway
  // schema-validates no results, so result-shape drift is invisible there.
  relay.invokeThrow = new RelayError('gateway/invocation-unavailable')
  await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  const diagnostics = handle.diagnostics()
  assert.equal(diagnostics.recentFailures.length, 7, 'the general ring holds every failure')
  assert.deepEqual(diagnostics.incompatibleCalls.map((c) => c.code), ['gateway/invocation-unavailable'])
  handle.uninstall()
})

test('the incompatible ring caps at 50 (T42)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  relay.invokeThrow = new RelayError('gateway/arguments-invalid')
  for (let i = 0; i < 55; i += 1) {
    await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  }
  const calls = handle.diagnostics().incompatibleCalls
  assert.equal(calls.length, 50)
  assert.equal(calls[calls.length - 1].endpoint, 'session/page')
  handle.uninstall()
})

// -- the behavior self-check -----------------------------------------------------------

test('behaviorSelfCheck demands a baseline first frame and counts on the wrap', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const outcome = await behaviorSelfCheck(gateway)
  assert.deepEqual(outcome, { ok: true })
  assert.equal(handle.wrappedCalls().openWireStream, 1, 'the wrap served the probe stream')
  assert.equal(gateway.streamCalls.length, 1)
  assert.equal(gateway.streamCalls[0].endpoint, 'workspace/follow')
  assert.equal(gateway.streamCalls[0].signal.aborted, true, 'the probe tears its subscription down')
  handle.uninstall()

  const wrong = new FakeTypertGateway({ stream: { 'workspace/follow': [{ type: 'ready' }] } })
  const bad = await behaviorSelfCheck(wrong)
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /baseline/)

  // spike §4.1: a baseline whose value.items is not an array is not a
  // workspace feed — one fault at a time (frame type is fine here).
  const noItems = new FakeTypertGateway({ stream: { 'workspace/follow': [{ type: 'baseline', value: {} }] } })
  const items = await behaviorSelfCheck(noItems)
  assert.equal(items.ok, false)
  assert.match(items.reason, /value\.items/)

  const hanging = new FakeTypertGateway({
    stream: { 'workspace/follow': new Error('unused') },
  })
  // A stream that never yields must hit the timeout, not hang startup.
  hanging.openWireStream = function () {
    this.streamCalls.push({ endpoint: 'workspace/follow' })
    const signal = arguments[4]
    return (async function* () {
      await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))); })
      yield { type: 'baseline' }
    })()
  }
  const slow = await behaviorSelfCheck(hanging, { timeoutMs: 80 })
  assert.equal(slow.ok, false)
  assert.match(slow.reason, /timeout|failed/u)
})

// -- the self-check RUN policy: counter DELTA, one retry, split faults ----------------

function makeSelfCheckTarget(streamSpec) {
  const gateway = new FakeTypertGateway({ stream: streamSpec })
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  return { gateway, handle }
}

/**
 * The runSelfCheck retry timer is unref()ed (a disposed plugin must not hold
 * a live process open for the delay), so a test awaiting nothing but that
 * timer lets the event loop drain — node:test then cancels the case with
 * "Promise resolution is still pending". A short ref'd keepalive stands in
 * for the production process's own live handles: an unref'd timer still
 * FIRES on schedule as long as any other handle exists.
 */
async function withLoopKeepalive(ms, run) {
  const keepalive = setTimeout(() => {}, ms)
  try {
    return await run()
  } finally {
    clearTimeout(keepalive)
  }
}

test('runSelfCheck passes when OTHER streams run concurrently (the probe is judged by identity, not by count)', async () => {
  const { gateway, handle } = makeSelfCheckTarget(undefined)
  // The UI opens its own local stream while the probe runs: both enter the
  // wrap, and the verdict must come from the probe payload ALONE — neither
  // an absolute count nor a delta, either of which could mistake the UI's
  // traffic for (or against) the probe.
  const pending = runSelfCheck(gateway, { handle, retryDelayMs: 1 })
  void drained(gateway.wireTap('workspace/follow', { args: {} }, undefined, undefined, undefined, { signal: undefined }))
  const result = await pending
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(handle.diagnostics().selfCheck, { ok: true })
  assert.ok(handle.wrappedCalls().openWireStream >= 2, 'both the probe and the concurrent stream entered the wrap')
  handle.uninstall()
})

test('runSelfCheck retries ONCE and recovers from a transient first failure', async () => {
  // Fault isolated to the FIRST attempt: the wire answers `ready` once,
  // then a proper baseline. The retry must see the healthy stream.
  let opens = 0
  const gateway = new FakeTypertGateway({ stream: {} })
  gateway.wireStream = {
    // Looks the instance method up AT CALL TIME (gateway.openWireStream),
    // so the wrap is reached on every attempt — only the frames differ.
    open(endpoint, payload, uplink, peer, signal) {
      opens += 1
      gateway.spec.stream['workspace/follow'] = opens === 1 ? [{ type: 'ready' }] : [{ type: 'baseline', value: { items: [] } }]
      return gateway.openWireStream(endpoint, payload, uplink, peer, signal, { signal })
    },
  }
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const result = await withLoopKeepalive(200, () => runSelfCheck(gateway, { handle, retryDelayMs: 5 }))
  assert.deepEqual(result, { ok: true })
  assert.equal(opens, 2, 'exactly one retry')
  assert.equal(handle.diagnostics().installed, true, 'a recovered self-check keeps the interception')
  handle.uninstall()
})

test('runSelfCheck fault A: the wrap is bypassed (closure-bound wire adapter)', async () => {
  // ONE fault only: wireStream.open calls the prototype directly (never the
  // wrap), frames are perfectly healthy baselines — the stream looks great,
  // the wrap was never reached.
  const gateway = new FakeTypertGateway({ stream: { 'workspace/follow': [{ type: 'baseline', value: { items: [] } }] } })
  gateway.wireStream = {
    open: (endpoint, payload, uplink, peer, signal) =>
      FakeTypertGateway.prototype.openWireStream.call(gateway, endpoint, payload, uplink, peer, signal, { signal: undefined }),
  }
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const result = await withLoopKeepalive(200, () => runSelfCheck(gateway, { handle, retryDelayMs: 1 }))
  assert.equal(result.ok, false)
  assert.match(result.reason, /bypassed the wrapper/)
  assert.equal(handle.diagnostics().installed, false, 'two failed runs uninstall')
  assert.equal(handle.diagnostics().selfCheck.ok, false)
})

test('runSelfCheck fault A: a concurrent UI stream does not mask a bypassed probe', async () => {
  // The old counter-delta check read ANY wrapper entry above the baseline,
  // so a stream the UI opened while the probe ran would vouch for a wire
  // adapter that routes around the wrapper. Here the probe rides the
  // prototype (bypassed) while a healthy local stream DOES enter the wrap —
  // the probe payload is judged by identity, so this must still fail.
  const gateway = new FakeTypertGateway({ stream: { 'workspace/follow': [{ type: 'baseline', value: { items: [] } }] } })
  gateway.wireStream = {
    open: (endpoint, payload, uplink, peer, signal) =>
      FakeTypertGateway.prototype.openWireStream.call(gateway, endpoint, payload, uplink, peer, signal, { signal: undefined }),
  }
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const pending = runSelfCheck(gateway, { handle, retryDelayMs: 1 })
  void drained(gateway.wireTap('workspace/follow', { args: {} }, undefined, undefined, undefined, { signal: undefined }))
  const result = await withLoopKeepalive(200, () => pending)
  assert.equal(result.ok, false)
  assert.match(result.reason, /bypassed the wrapper/)
  assert.equal(handle.diagnostics().installed, false, 'two failed runs uninstall')
})

test('runSelfCheck does not retry after the interception was uninstalled mid-check', async () => {
  // The first attempt fails on the frame shape; the plugin is disposed during
  // the retry delay. The retry must never run (no second probe against the
  // now-unwrapped gateway), the verdict must stay unrecorded, and the removal
  // must not be announced — it was not ours.
  let opens = 0
  const gateway = new FakeTypertGateway({ stream: { 'workspace/follow': [{ type: 'ready' }] } })
  gateway.wireStream = {
    open(endpoint, payload, uplink, peer, signal) {
      opens += 1
      return gateway.openWireStream(endpoint, payload, uplink, peer, signal, { signal })
    },
  }
  const relay = createFakeRelay()
  const logging = makeLog()
  const handle = installIntercept({ raw: gateway, relay, getServerId: () => SERVER_ID, log: logging.log })
  const result = await withLoopKeepalive(200, async () => {
    const pending = runSelfCheck(gateway, { handle, retryDelayMs: 30, log: logging.log })
    await flushAsync()
    handle.uninstall()
    return pending
  })
  assert.equal(result.ok, false)
  assert.equal(opens, 1, 'the probe ran once — the retry never opened a stream')
  assert.equal(handle.diagnostics().selfCheck, undefined, 'an uninstalled check records no verdict')
  assert.ok(
    !logging.lines.some(([format]) => String(format).includes('interception removed')),
    logging.lines.map(String).join('|'),
  )
})

test('runSelfCheck fault B: the first frame is not a baseline', async () => {
  // ONE fault only: the wrap IS reached (counter moves), but the first
  // frame answers `ready` on every attempt.
  const { gateway, handle } = makeSelfCheckTarget({ 'workspace/follow': [{ type: 'ready' }] })
  const result = await withLoopKeepalive(200, () => runSelfCheck(gateway, { handle, retryDelayMs: 1 }))
  assert.equal(result.ok, false)
  assert.match(result.reason, /baseline/)
  assert.equal(handle.diagnostics().installed, false, 'two failed runs uninstall')
  assert.ok(handle.wrappedCalls().openWireStream >= 2, 'the wrap was entered by both attempts')
})

// -- the wiring ---------------------------------------------------------------------

const INDEX_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href

/** Fake cordis context whose inject EXECUTES (services must all be present),
 * recording webServer registrations and effect disposers like
 * role-wiring.test.cjs's tightInject. The RECORDING webServer is the default
 * service — inside an inject callback `webServer` resolves to the service
 * passed in, so a stub there would silently drop registrations. */
function makeWiringCtx(services = {}) {
  const effects = []
  const warns = []
  const infos = []
  const registered = []
  const webServer = { register(route) { registered.push(route); return () => {} } }
  const provided = { webServer, ...services }
  const ctx = {
    plugin() {},
    on() { return () => {} },
    effect(fn) { const out = fn(); if (typeof out === 'function') effects.push(out); return out },
    inject(deps, cb) {
      if (!deps.every((d) => provided[d] !== undefined)) return
      const target = {
        get: (name) => provided[name],
        reflect: { get: (name) => provided[name] },
        effect: (inner) => { const out = inner(); if (typeof out === 'function') effects.push(out); return out },
      }
      const scoped = new Proxy(target, {
        get(t, prop) {
          if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop)
          if (deps.includes(prop)) return provided[prop]
          throw new Error(`cannot get property "${String(prop)}" without inject`)
        },
      })
      cb(scoped)
    },
    logger: {
      warn: (...args) => warns.push(args),
      info: (...args) => infos.push(args),
    },
    webServer,
  }
  return { ctx, effects, warns, infos, registered }
}

/** Serve the FIRST registered route (the client prefix) on a real socket and
 * GET one path, answering the parsed JSON body. */
function serveOnce(registered, requestPath) {
  const route = registered.find((r) => r.kind === 'prefix')
  assert.ok(route, 'the client route prefix is registered')
  const server = http.createServer((req, res) => { void route.handler(req, res) })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      http.get({ host: '127.0.0.1', port, path: requestPath }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          server.close()
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
        })
      }).on('error', reject)
    })
  })
}

test('the wiring installs on a good gateway and the status route surfaces it', async () => {
  const { apply } = await import(INDEX_URL)
  const gateway = new FakeTypertGateway()
  // The wiring builds its OWN relay client from the row; the fake services
  // only need webServer + connection + typertGateway. The row carries no
  // credentials, so the startup connect() stays silently unpaired.
  const { ctx, effects, registered } = makeWiringCtx({ connection: { admit: () => ({}) }, typertGateway: { [symbols.original]: gateway } })
  apply(ctx, { role: 'client' })
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), true)
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'dispatchRpc'), true)

  const status = await serveOnce(registered, '/_dsh/zen-remote/client/status')
  assert.equal(status.state, 'unpaired', 'the row is unpaired — the intercept rides along anyway')
  assert.equal(status.intercept.installed, true)
  assert.equal(status.intercept.shape.ok, true)
  assert.equal(typeof status.intercept.recentFailures, 'object')

  // The self-check runs async: give it a beat, then confirm it landed.
  await flushAsync()
  const settled = await serveOnce(registered, '/_dsh/zen-remote/client/status')
  assert.deepEqual(settled.intercept.selfCheck, { ok: true })

  // Disposal uninstalls: the recorded effect disposers include the intercept's.
  for (const disposer of effects) disposer()
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'dispatchRpc'), false)
})

test('the wiring uninstalls when the self-check fails (unreachable wrap)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { apply } = await import(INDEX_URL)
  const gateway = new FakeTypertGateway()
  gateway.wireStream = {
    open: (endpoint, payload, uplink, peer, signal) =>
      FakeTypertGateway.prototype.openWireStream.call(gateway, endpoint, payload, uplink, peer, signal, { signal }),
  }
  gateway.spec = { stream: { 'workspace/follow': [{ type: 'ready' }] } }
  const { ctx, effects, registered } = makeWiringCtx({ connection: { admit: () => ({}) }, typertGateway: { [symbols.original]: gateway } })
  apply(ctx, { role: 'client' })
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), true, 'installed while the self-check is in flight')
  await flushAsync()
  t.mock.timers.tick(3_500)
  await flushAsync()
  t.mock.timers.reset()
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), false, 'a doubly failed self-check removes the wrap')
  const status = await serveOnce(registered, '/_dsh/zen-remote/client/status')
  assert.equal(status.intercept.installed, false)
  assert.equal(status.intercept.selfCheck.ok, false)
  for (const disposer of effects) disposer()
})

// -- T51: the fetch-route wiring -----------------------------------------------------

const { FILE_UPLOAD_PATH, SESSION_EXPORT_PATH } = require('../lib/fetch-route-intercept.js')

/** A fake connection service with the raw instance the wiring unwraps: an
 * admit wall plus a fetchRoutes Map carrying the two entries the wrap gates
 * on. The upload route records what reached it. */
function makeFakeConnectionService(uploadEntry) {
  const seen = []
  const routes = new Map()
  if (uploadEntry !== undefined) routes.set(FILE_UPLOAD_PATH, uploadEntry)
  routes.set(SESSION_EXPORT_PATH, {
    methods: new Set(['GET', 'HEAD']),
    requestBody: 'buffered',
    fetch: async (request) => {
      seen.push(request)
      return new Response('local-export')
    },
  })
  const raw = {
    admit: () => ({}),
    fetchRoutes: routes,
  }
  return { proxy: { [symbols.original]: raw, admit: raw.admit }, raw, routes, seen }
}

function uploadEntryOf(fetch) {
  return {
    methods: new Set(['POST']),
    requestBody: 'streaming',
    fetch,
  }
}

const uploadRequestOf = (sessionId) =>
  new Request(`http://dsh.internal/api/session/uploadFileBinary?sessionId=${encodeURIComponent(sessionId)}&name=x.bin`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('bytes'),
    duplex: 'half',
  })

test('T51: the fetch-route wiring installs beside the typert wrap and the status route surfaces it', async () => {
  const { apply } = await import(INDEX_URL)
  const gateway = new FakeTypertGateway()
  const uploadSeen = []
  const connection = makeFakeConnectionService(
    uploadEntryOf(async (request) => {
      uploadSeen.push(request)
      return new Response('local-upload')
    }),
  )
  const originalExportFetch = connection.routes.get(SESSION_EXPORT_PATH).fetch
  const originalUploadFetch = connection.routes.get(FILE_UPLOAD_PATH).fetch
  const { ctx, effects, registered } = makeWiringCtx({
    connection: connection.proxy,
    fileUploads: {},
    typertGateway: { [symbols.original]: gateway },
  })
  apply(ctx, { role: 'client' })
  assert.notEqual(connection.routes.get(FILE_UPLOAD_PATH).fetch, uploadSeen, 'the entry is wrapped')

  // The status answer carries the new diagnostics block — the row is
  // unpaired, so the wrapper reports the offline refusal shape.
  const status = await serveOnce(registered, '/_dsh/zen-remote/client/status')
  assert.equal(status.fetchRouteIntercept.installed, true)
  assert.equal(status.fetchRouteIntercept.uploadWrapped, true)
  assert.equal(status.fetchRouteIntercept.exportWrapped, true)
  assert.equal(status.fetchRouteIntercept.shape.ok, true)

  // A virtual upload is refused locally with the UI-parseable envelope (the
  // MS-5 pool face: an id whose server the empty pool does not hold reads
  // remote-mismatch, still under T51-fix's 200 contract); a local id
  // reaches the original route untouched.
  const virtual = toVirtual(SERVER_ID, LOCAL_ID)
  const refused = await connection.routes.get(FILE_UPLOAD_PATH).fetch(uploadRequestOf(virtual))
  assert.equal(refused.status, 200)
  assert.equal((await refused.json()).error.code, 'remote-mismatch')
  assert.equal(uploadSeen.length, 0)
  const local = await connection.routes.get(FILE_UPLOAD_PATH).fetch(uploadRequestOf(LOCAL_ID))
  assert.equal(await local.text(), 'local-upload')
  assert.equal(uploadSeen.length, 1)
  const blocked = await connection.routes.get(SESSION_EXPORT_PATH).fetch(
    new Request(`http://dsh.internal/api/session.export?sessionId=${encodeURIComponent(virtual)}`, { method: 'HEAD' }),
  )
  assert.equal(blocked.status, 403)
  assert.equal(connection.seen.length, 0)

  // Disposal restores the exact original entries.
  for (const disposer of effects) disposer()
  assert.equal(connection.routes.get(FILE_UPLOAD_PATH).fetch, originalUploadFetch, 'the original upload fetch came back')
  assert.equal(connection.routes.get(SESSION_EXPORT_PATH).fetch, originalExportFetch, 'the original export fetch came back')
  // A disposed row answers without the block at all — the honest "nothing
  // is installed here" the typert diagnostics degrade to as well.
  const afterStatus = await serveOnce(registered, '/_dsh/zen-remote/client/status')
  assert.equal(afterStatus.fetchRouteIntercept, undefined)
})

test('T51-fix: a misshaped upload entry is refused for ITS route only; the rest installs and local behavior is identical', async () => {
  const { apply } = await import(INDEX_URL)
  const gateway = new FakeTypertGateway()
  // The upload entry is present but wrong (requestBody not "streaming" — a
  // reshaped future DSH): the structural shape still passes, the install
  // runs, the upload attach refuses (present-but-wrong never fixes itself,
  // no retry), and the healthy export route wraps anyway. The upload route
  // answers exactly as it did before the plugin existed — local and virtual
  // ids alike.
  const uploadSeen = []
  const connection = makeFakeConnectionService(undefined)
  connection.routes.set(FILE_UPLOAD_PATH, {
    methods: new Set(['POST']),
    requestBody: 'buffered',
    fetch: async (request) => {
      uploadSeen.push(request)
      return new Response('local-upload')
    },
  })
  const { ctx, effects, registered } = makeWiringCtx({
    connection: connection.proxy,
    fileUploads: {},
    typertGateway: { [symbols.original]: gateway },
  })
  apply(ctx, { role: 'client' })
  const status = await serveOnce(registered, '/_dsh/zen-remote/client/status')
  assert.equal(status.fetchRouteIntercept.installed, true, 'the structural gate passed')
  assert.equal(status.fetchRouteIntercept.uploadWrapped, false, 'the misshaped entry was never wrapped')
  assert.equal(status.fetchRouteIntercept.uploadPending, false, 'present-but-wrong does not retry')
  assert.ok(status.fetchRouteIntercept.uploadAttachRefused.includes('streaming'))
  assert.equal(status.fetchRouteIntercept.exportWrapped, true, 'the healthy route installed anyway')
  // The untouched upload route serves BOTH ids locally.
  const virtual = toVirtual(SERVER_ID, LOCAL_ID)
  const remote = await connection.routes.get(FILE_UPLOAD_PATH).fetch(uploadRequestOf(virtual))
  assert.equal(await remote.text(), 'local-upload')
  assert.equal(uploadSeen.length, 1)
  const local = await connection.routes.get(FILE_UPLOAD_PATH).fetch(uploadRequestOf(LOCAL_ID))
  assert.equal(await local.text(), 'local-upload')
  assert.equal(uploadSeen.length, 2)
  // The export refusal still works.
  const blocked = await connection.routes.get(SESSION_EXPORT_PATH).fetch(
    new Request(`http://dsh.internal/api/session.export?sessionId=${encodeURIComponent(virtual)}`, { method: 'HEAD' }),
  )
  assert.equal(blocked.status, 403)
  assert.equal(connection.seen.length, 0)
  for (const disposer of effects) disposer()
})


// -- T31: create / fork / subagents / agentId calls ----------------------------------

test('session/create rewrites the virtual workspaceId, drops sessionId, virtualizes the result id', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.invokeValue = { sessionId: 'session-fresh', agentPreset: 'default' }
  const { handle } = install(gateway, relay)
  const workspaceVirtual = toVirtual(SERVER_ID, 'workspace-9f0')
  const args = { request: { workspaceId: workspaceVirtual, cwd: '/client/side', sessionId: 'session-chosen-locally' } }
  const envelope = await gateway.rpcBridge('session/create', { args }, undefined, undefined)
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.value, { sessionId: toVirtual(SERVER_ID, 'session-fresh'), agentPreset: toVirtual(SERVER_ID, 'default') }, 'the minted id and preset travel virtualized')
  assert.deepEqual(relay.invokes, [{
    namespace: 'session',
    method: 'create',
    args: { request: { workspaceId: 'workspace-9f0', cwd: '/client/side' } },
    signal: undefined,
  }], 'the original workspace id travels, cwd rides as-is (the server discards it), and the caller-chosen session id is gone')
  assert.equal(args.request.workspaceId, workspaceVirtual, 'the caller arguments are never mutated')
  handle.uninstall()
})

test('session/create in a LOCAL workspace passes through untouched', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const args = { request: { workspaceId: 'local-workspace-uuid', cwd: '/tmp' } }
  await gateway.rpcBridge('session/create', { args }, undefined, undefined)
  assert.equal(relay.invokes.length, 0, 'nothing was forwarded')
  assert.equal(gateway.rpcCalls.length, 1, 'the local gateway answered')
  assert.deepEqual(gateway.rpcCalls[0].payload.args, args, 'a local create is not stripped of anything')
  handle.uninstall()
})

test('session/fork forwards the restored source id and virtualizes the child id', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.invokeValue = { sessionId: 'session-forked' }
  const { handle } = install(gateway, relay)
  const envelope = await gateway.rpcBridge('session/fork', { args: { request: { sessionId: VIRTUAL_ID, atSeq: 12 } } }, undefined, undefined)
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.value, { sessionId: toVirtual(SERVER_ID, 'session-forked') })
  assert.deepEqual(relay.invokes[0].args, { request: { sessionId: LOCAL_ID, atSeq: 12 } })
  handle.uninstall()
})

test('subagents calls rewrite BOTH id slots (request envelope and top level alike, T41a)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)

  // Both ids arrive VIRTUALIZED (the UI knows server sessions only through
  // session/follow snapshots, whose header.id is virtualized) — both are
  // restored before the call travels.
  await gateway.rpcBridge('subagents/prompt', {
    args: { request: { requestId: 'r1', parentSessionId: toVirtual(SERVER_ID, 'session-parent'), childSessionId: toVirtual(SERVER_ID, 'session-child'), mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: 'hi' }] } },
  }, undefined, undefined)
  assert.deepEqual(relay.invokes[0].args.request, {
    requestId: 'r1',
    parentSessionId: 'session-parent',
    childSessionId: 'session-child',
    mode: 'continuable',
    delivery: 'queue',
    content: [{ type: 'text', text: 'hi' }],
  }, 'parent AND child are restored inside the request envelope')

  await gateway.rpcBridge('subagents/interruptByParent', {
    args: { childSessionId: toVirtual(SERVER_ID, 'session-child'), parentSessionId: toVirtual(SERVER_ID, 'session-parent'), mode: 'continuable' },
  }, undefined, undefined)
  assert.deepEqual(relay.invokes[1].args, { childSessionId: 'session-child', parentSessionId: 'session-parent', mode: 'continuable' }, 'both TOP-LEVEL slots are restored')

  // 0.2.2-rc.2: only the child travels; a leftover parent id is unowned data
  // and is left alone (the interceptor only restores registered fields).
  await gateway.rpcBridge('subagents/interruptByUser', {
    args: { childSessionId: toVirtual(SERVER_ID, 'session-child') },
  }, undefined, undefined)
  assert.deepEqual(relay.invokes[2].args, { childSessionId: 'session-child' }, 'the single top-level child id is restored')

  // API-1: DSH 0.2.2-rc.2 omits parentSessionId on subagents/prompt (only childSessionId).
  await gateway.rpcBridge('subagents/prompt', {
    args: { request: { requestId: 'r2', childSessionId: toVirtual(SERVER_ID, 'session-child-only'), mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: 'hi' }] } },
  }, undefined, undefined)
  assert.deepEqual(relay.invokes[3].args.request, {
    requestId: 'r2',
    childSessionId: 'session-child-only',
    mode: 'continuable',
    delivery: 'queue',
    content: [{ type: 'text', text: 'hi' }],
  })

  // API-1: Mismatched parentSessionId & childSessionId across servers must be refused locally.
  const cross = await gateway.rpcBridge('subagents/prompt', {
    args: { request: { requestId: 'r3', parentSessionId: toVirtual(SERVER_ID, 'p'), childSessionId: toVirtual('eeeeeeee', 'c'), mode: 'continuable', delivery: 'queue', content: [] } },
  }, undefined, undefined)
  assert.equal(cross.ok, false)
  assert.equal(cross.error.code, 'remote-mismatch')
  handle.uninstall()
})

test('the agentId calls restore the top-level agentId and pass everything else through', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.invokeValue = { receiptId: 'r-1', file: { attachmentId: 'a-1', name: 'x.png', bytes: 3 } }
  const { handle } = install(gateway, relay)

  const uploadArgs = { agentId: VIRTUAL_ID, request: { data: 'Zm9v', name: 'x.png' } }
  const uploaded = await gateway.rpcBridge('fileUploads/upload', { args: uploadArgs }, undefined, undefined)
  assert.equal(uploaded.ok, true)
  assert.equal(uploaded.value, relay.invokeValue, 'receipt and attachment ids are not session ids — untouched')
  assert.deepEqual(relay.invokes[0].args, { agentId: LOCAL_ID, request: { data: 'Zm9v', name: 'x.png' } })

  const refsArgs = { agentId: VIRTUAL_ID, query: 'src/' }
  await gateway.rpcBridge('fileReferences/list', { args: refsArgs }, undefined, undefined)
  assert.deepEqual(relay.invokes[1].args, { agentId: LOCAL_ID, query: 'src/' })
  handle.uninstall()
})

test('an unregistered agentId-located method with a virtual agentId is still refused', async () => {
  // The registry grew, but the deep-scan backstop has not loosened: a virtual
  // id anywhere outside the table never reaches the local gateway.
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const envelope = await gateway.rpcBridge('dynamicCordisRunner/invoke', { args: { agentId: VIRTUAL_ID, request: { code: 'x' } } }, undefined, undefined)
  assert.deepEqual(envelope, { ok: false, error: { code: 'remote-unsupported', message: '此功能暂不支持远程会话', details: {} } })
  assert.equal(relay.invokes.length, 0)
  assert.equal(gateway.rpcCalls.length, 0)
  handle.uninstall()
})


test('rewriteRemoteEventFrame: waterfall ids go virtual in place, status goes virtual, ready and other emits drop', () => {
  const waterfall = {
    type: 'waterfall',
    event: 'approval/request',
    eventId: EVT('1'),
    agentId: LOCAL_ID,
    request: { toolName: 'Bash', callId: 'c1', reason: 'needs approval' },
  }
  // Exact-keys discipline (the client face validates every variant with
  // hasExactRemoteEventKeys): the rewrite renames IN PLACE, adds nothing.
  assert.deepEqual(rewriteRemoteEventFrame(waterfall, SERVER_ID), {
    type: 'waterfall',
    event: 'approval/request',
    eventId: toVirtual(SERVER_ID, EVT('1')),
    agentId: VIRTUAL_ID,
    request: { toolName: 'Bash', callId: 'c1', reason: 'needs approval' },
  })
  assert.deepEqual(
    rewriteRemoteEventFrame({ type: 'cancel', eventId: EVT('2') }, SERVER_ID),
    { type: 'cancel', eventId: toVirtual(SERVER_ID, EVT('2')) },
  )
  // The remote ready frame: dropped — the UI's stream opened with the LOCAL
  // ready, and a second one fails the client face's frame parser (plus it
  // carries the server's clientId/host, which the UI must never need).
  assert.equal(rewriteRemoteEventFrame({ type: 'ready', clientId: 'srv', host: { home: '/srv' } }, SERVER_ID), null)
  // T75: the ONE emit that crosses — a session's running flip. The id goes
  // virtual, the boolean passes through; a NEW frame leaves, never the
  // host's object.
  const status = { type: 'emit', event: 'api-session/status', args: [LOCAL_ID, true] }
  assert.deepEqual(rewriteRemoteEventFrame(status, SERVER_ID), {
    type: 'emit',
    event: 'api-session/status',
    args: [VIRTUAL_ID, true],
  })
  assert.deepEqual(rewriteRemoteEventFrame({ ...status, args: [LOCAL_ID, false] }, SERVER_ID), {
    type: 'emit',
    event: 'api-session/status',
    args: [VIRTUAL_ID, false],
  })
  // Every other emit is dropped outright (T32-fix): server-wide state the UI
  // must never mistake for local sessions.
  const emit = { type: 'emit', event: 'api-session/added', args: [{ sessionId: 's', title: '服务端会话' }] }
  assert.equal(rewriteRemoteEventFrame(emit, SERVER_ID), null)
  // Everything the client face's parseRemoteEventFrame would refuse is
  // dropped BEFORE the UI sees it (T32-fix2, mirroring the server's own
  // forwardable-shape gate): a malformed frame would fail the UI's whole
  // $events generation and leave it failing and reconnecting in a loop.
  assert.equal(rewriteRemoteEventFrame({ type: 'waterfall', event: 'e', eventId: 3, agentId: 4, request: {} }, SERVER_ID), null, 'non-string ids')
  assert.equal(rewriteRemoteEventFrame({ type: 'waterfall', event: 'e', eventId: 'e1' }, SERVER_ID), null, 'missing fields')
  assert.equal(rewriteRemoteEventFrame({ ...waterfall, extra: 1 }, SERVER_ID), null, 'an extra field breaks exact keys')
  assert.equal(rewriteRemoteEventFrame({ ...waterfall, request: { toolName: 'a', agent: 'x' } }, SERVER_ID), null, 'request carrying agent')
  assert.equal(rewriteRemoteEventFrame({ type: 'nonsense', eventId: 'e1' }, SERVER_ID), null, 'unknown type')
  assert.equal(rewriteRemoteEventFrame('junk', SERVER_ID), null, 'not even an object')
  // The status emit obeys the same exact-keys discipline (T75).
  assert.equal(rewriteRemoteEventFrame({ ...status, extra: 1 }, SERVER_ID), null, 'status: an extra field breaks exact keys')
  assert.equal(rewriteRemoteEventFrame({ ...status, args: [LOCAL_ID, 'yes'] }, SERVER_ID), null, 'status: args[1] not boolean')
  assert.equal(rewriteRemoteEventFrame({ ...status, args: [LOCAL_ID, 1] }, SERVER_ID), null, 'status: args[1] a number')
  assert.equal(rewriteRemoteEventFrame({ ...status, args: [LOCAL_ID, true, 'x'] }, SERVER_ID), null, 'status: args length 3')
  assert.equal(rewriteRemoteEventFrame({ ...status, args: ['', true] }, SERVER_ID), null, 'status: empty session id')
  assert.equal(rewriteRemoteEventFrame({ ...status, args: [LOCAL_ID] }, SERVER_ID), null, 'status: args length 1')
  assert.equal(rewriteRemoteEventFrame({ ...status, args: LOCAL_ID }, SERVER_ID), null, 'status: args not an array')
  assert.equal(rewriteRemoteEventFrame({ type: 'emit', event: 'api-session/status', args: [LOCAL_ID, true], clientId: 'c' }, SERVER_ID), null, 'status: four keys')
})


// -- T41a: the panel long tail — goals, commands, presets, @ candidates, feedback,
// -- workspace files, and the terminal half; both field halves, results, and streams ----

test('the T41a agentId group restores the top-level agentId; candidates rows virtualize back', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.invokeValue = [
    { mention: '@调试', sessionId: 'session-candidate', label: '调试登录', sameWorkspace: true, createdAt: 1 },
  ]
  const { handle } = install(gateway, relay)

  // goals/edit: only agentId is touched; the goal ref and request ride as-is.
  const goalArgs = { agentId: VIRTUAL_ID, ref: { id: 'goal-1', revision: 2 }, request: { objective: '发版' } }
  const goal = await gateway.rpcBridge('goals/edit', { args: goalArgs }, undefined, undefined)
  assert.equal(goal.ok, true)
  assert.deepEqual(relay.invokes[0].args, { agentId: LOCAL_ID, ref: { id: 'goal-1', revision: 2 }, request: { objective: '发版' } })

  // commands/execute: the slash line and attachments are not session data.
  await gateway.rpcBridge('commands/execute', { args: { agentId: VIRTUAL_ID, line: '/model deepseek-chat', submittedAttachments: [] } }, undefined, undefined)
  assert.deepEqual(relay.invokes[1].args, { agentId: LOCAL_ID, line: '/model deepseek-chat', submittedAttachments: [] })

  // agentPresets/select and the @ resolver travel the same way.
  await gateway.rpcBridge('agentPresets/select', { args: { agentId: VIRTUAL_ID, agentPreset: toVirtual(SERVER_ID, 'default') } }, undefined, undefined)
  await gateway.rpcBridge('sessionReferenceResolver/candidates', { args: { agentId: VIRTUAL_ID, query: '调试' } }, undefined, undefined)
  assert.deepEqual(relay.invokes[2].args, { agentId: LOCAL_ID, agentPreset: 'default' })
  assert.deepEqual(relay.invokes[3].args, { agentId: LOCAL_ID, query: '调试' })

  // The candidates RESULT carries OTHER sessions' ids — each row virtualized,
  // everything else in the row untouched.
  const candidates = await gateway.rpcBridge('sessionReferenceResolver/candidates', { args: { agentId: VIRTUAL_ID, query: '调试' } }, undefined, undefined)
  assert.deepEqual(candidates.value, [
    { mention: '@调试', sessionId: toVirtual(SERVER_ID, 'session-candidate'), label: '调试登录', sameWorkspace: true, createdAt: 1 },
  ])
  handle.uninstall()
})

test('sessionFeedback/record forwards request.sessionId and virtualizes the not-found error id', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.invokeValue = { ok: false, error: { code: 'session-not-found', sessionId: 'session-gone' } }
  const { handle } = install(gateway, relay)
  const envelope = await gateway.rpcBridge('sessionFeedback/record', { args: { request: { sessionId: VIRTUAL_ID, category: 'other' } } }, undefined, undefined)
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.value, { ok: false, error: { code: 'session-not-found', sessionId: toVirtual(SERVER_ID, 'session-gone') } })
  assert.deepEqual(relay.invokes[0].args, { request: { sessionId: LOCAL_ID, category: 'other' } })
  // A success answer carries no ids and passes through untouched.
  relay.invokeValue = { ok: true, value: { recorded: true } }
  const ok = await gateway.rpcBridge('sessionFeedback/record', { args: { request: { sessionId: VIRTUAL_ID } } }, undefined, undefined)
  assert.deepEqual(ok.value, { ok: true, value: { recorded: true } })
  handle.uninstall()
})

test('workspaceFiles calls restore the top-level workspaceFileScopeId; local scopes stay local', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.invokeValue = { path: 'src', entries: [{ name: 'index.ts', type: 'file', size: 10 }], truncated: false }
  const { handle } = install(gateway, relay)
  const scopeVirtual = toVirtual(SERVER_ID, 'session-scope')
  const envelope = await gateway.rpcBridge('workspaceFiles/list', { args: { workspaceFileScopeId: scopeVirtual, path: 'src' } }, undefined, undefined)
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.value, relay.invokeValue, 'listings carry no session ids — untouched')
  assert.deepEqual(relay.invokes[0].args, { workspaceFileScopeId: 'session-scope', path: 'src' })
  // A LOCAL scope id passes through to the local gateway untouched (the
  // forwarded list call above never reached it — rpcCalls holds locals only).
  await gateway.rpcBridge('workspaceFiles/stat', { args: { workspaceFileScopeId: 'session-local', path: '.' } }, undefined, undefined)
  assert.equal(relay.invokes.length, 1)
  assert.equal(gateway.rpcCalls.length, 1)
  assert.deepEqual(gateway.rpcCalls[0].payload.args, { workspaceFileScopeId: 'session-local', path: '.' })
  handle.uninstall()
})

test('workspaceFiles/readBytes restores the binary marker into a real Uint8Array (2026-10-14 fix)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  // What the RELAY answers after the server half marked it: the JSON wire
  // shape (invoke-binary.ts) — a plain object no zod would accept as data.
  const bytes = new Uint8Array([0, 1, 250, 255, 128])
  relay.invokeValue = { data: { '$zr-u8': Buffer.from(bytes).toString('base64') }, path: 'pic.png' }
  const { handle } = install(gateway, relay)
  const scopeVirtual = toVirtual(SERVER_ID, 'session-scope')
  const envelope = await gateway.rpcBridge('workspaceFiles/readBytes', { args: { workspaceFileScopeId: scopeVirtual, path: 'pic.png' } }, undefined, undefined)
  assert.equal(envelope.ok, true)
  // The dispatchRpc envelope contract (dsh-api-gateway encodeRpcResult): the
  // typed array rides the ATTACHMENTS side channel, its value position is
  // null — that is what survives the background→browser bridge (2026-10-14
  // live-probed root cause of the remote image preview failure).
  assert.equal(envelope.value.data, null, 'the value position is null — bytes ride the attachment channel')
  assert.equal(envelope.value.path, 'pic.png')
  assert.ok(Array.isArray(envelope.attachments) && envelope.attachments.length === 1, 'exactly one attachment')
  assert.deepEqual(envelope.attachments[0].path, ['data'])
  assert.ok(envelope.attachments[0].bytes instanceof Uint8Array)
  assert.deepEqual(Array.from(envelope.attachments[0].bytes), Array.from(bytes))
  assert.deepEqual(relay.invokes[0].args, { workspaceFileScopeId: 'session-scope', path: 'pic.png' }, 'the scope id was restored for the relay as usual')
  handle.uninstall()
})

test('officeToPdf/render forwards with the restored workspaceFileScopeId and its PDF bytes as an attachment (2.2.6)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  // What the relay answers after the server half marked the PDF bytes.
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 254, 255])
  relay.invokeValue = {
    data: { '$zr-u8': Buffer.from(pdf).toString('base64') },
    absolutePath: '/srv/a/report.docx',
    version: 'v1',
    missingFonts: [],
    eof: true,
  }
  const { handle } = install(gateway, relay)
  const scopeVirtual = toVirtual(SERVER_ID, 'session-scope')
  const envelope = await gateway.rpcBridge(
    'officeToPdf/render',
    { args: { workspaceFileScopeId: scopeVirtual, path: 'report.docx', priority: 'foreground' } },
    undefined,
    undefined,
  )
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.data, null, 'the PDF bytes ride the attachment channel')
  assert.equal(envelope.value.absolutePath, '/srv/a/report.docx')
  assert.ok(Array.isArray(envelope.attachments) && envelope.attachments.length === 1)
  assert.deepEqual(envelope.attachments[0].path, ['data'])
  assert.deepEqual(Array.from(envelope.attachments[0].bytes), Array.from(pdf))
  assert.deepEqual(relay.invokes[0].args, {
    workspaceFileScopeId: 'session-scope',
    path: 'report.docx',
    priority: 'foreground',
  }, 'the virtual scope is restored to the server session id, path/priority pass verbatim')
  handle.uninstall()
})

test('officeKit/render (0.2.2-rc.2) forwards with the restored workspaceFileScopeId and its PDF bytes as an attachment', async () => {
  // Same shape as officeToPdf/render: the official document-preview plugin
  // now calls officeKit.render. Bytes still ride the attachment channel.
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 254, 255])
  relay.invokeValue = {
    data: { '$zr-u8': Buffer.from(pdf).toString('base64') },
    absolutePath: '/srv/a/report.docx',
    version: 'v1',
    missingFonts: [],
    eof: true,
  }
  const { handle } = install(gateway, relay)
  const scopeVirtual = toVirtual(SERVER_ID, 'session-scope')
  const envelope = await gateway.rpcBridge(
    'officeKit/render',
    { args: { workspaceFileScopeId: scopeVirtual, path: 'report.docx', priority: 'foreground' } },
    undefined,
    undefined,
  )
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.data, null, 'the PDF bytes ride the attachment channel')
  assert.equal(envelope.value.absolutePath, '/srv/a/report.docx')
  assert.ok(Array.isArray(envelope.attachments) && envelope.attachments.length === 1)
  assert.deepEqual(envelope.attachments[0].path, ['data'])
  assert.deepEqual(Array.from(envelope.attachments[0].bytes), Array.from(pdf))
  assert.deepEqual(relay.invokes[0].args, {
    workspaceFileScopeId: 'session-scope',
    path: 'report.docx',
    priority: 'foreground',
  }, 'the virtual scope is restored to the server session id, path/priority pass verbatim')
  handle.uninstall()
})

test('terminal calls restore BOTH field halves: agentId for the PTY half, sessionId for retain/list', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.invokeValue = { id: 'term-1', title: 'zsh', shell: { path: '/bin/zsh', args: [], name: 'zsh' }, cwd: '/srv', cols: 80, rows: 24, state: 'running', exitCode: null }
  const { handle } = install(gateway, relay)

  // create: agentId restored; the CLIENT-generated terminal id inside request
  // rides as-is (it is not a session id).
  const created = await gateway.rpcBridge('terminal/create', { args: { agentId: VIRTUAL_ID, request: { id: 'term-1', cols: 80, rows: 24 } } }, undefined, undefined)
  assert.equal(created.ok, true)
  assert.equal(created.value, relay.invokeValue, 'the terminal info carries no session id — untouched')
  assert.deepEqual(relay.invokes[0].args, { agentId: LOCAL_ID, request: { id: 'term-1', cols: 80, rows: 24 } })

  // write/resize/rename/close shape the same way.
  await gateway.rpcBridge('terminal/write', { args: { agentId: VIRTUAL_ID, id: 'term-1', attachmentId: 'att-9', data: 'ls\n' } }, undefined, undefined)
  assert.deepEqual(relay.invokes[1].args, { agentId: LOCAL_ID, id: 'term-1', attachmentId: 'att-9', data: 'ls\n' })
  await gateway.rpcBridge('terminal/close', { args: { agentId: VIRTUAL_ID, id: 'term-1' } }, undefined, undefined)
  assert.deepEqual(relay.invokes[2].args, { agentId: LOCAL_ID, id: 'term-1' })

  // list and retain locate by the plain top-level sessionId instead.
  await gateway.rpcBridge('terminal/list', { args: { sessionId: VIRTUAL_ID } }, undefined, undefined)
  assert.deepEqual(relay.invokes[3].args, { sessionId: LOCAL_ID })
  await gateway.rpcBridge('terminal/retain', { args: { sessionId: VIRTUAL_ID, id: 'term-1' } }, undefined, undefined)
  assert.deepEqual(relay.invokes[4].args, { sessionId: LOCAL_ID, id: 'term-1' })

  // A LOCAL session keeps its terminals local — both halves (the five
  // forwarded calls above never touched the local gateway).
  await gateway.rpcBridge('terminal/environment', { args: { agentId: 'session-local' } }, undefined, undefined)
  await gateway.rpcBridge('terminal/list', { args: { sessionId: 'session-local' } }, undefined, undefined)
  assert.equal(relay.invokes.length, 5)
  assert.equal(gateway.rpcCalls.length, 2)
  handle.uninstall()
})

test('terminal/follow forwards as a stream with the restored agentId and passes frames through', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.streamFrames = [
    { type: 'snapshot', sequence: 0, screen: '$ ', info: { id: 'term-1', title: 'zsh', cols: 80, rows: 24, state: 'running', exitCode: null } },
    { type: 'output', sequence: 1, data: 'hello\n' },
  ]
  const { handle } = install(gateway, relay)
  const frames = []
  for await (const frame of gateway.wireTap('terminal/follow', { args: { agentId: VIRTUAL_ID, id: 'term-1', attachmentId: 'att-9' } }, { add: () => {} }, undefined, undefined, { signal: undefined })) {
    frames.push(frame)
  }
  assert.deepEqual(frames, relay.streamFrames, 'snapshot/output frames carry no session id — untouched')
  assert.deepEqual(relay.streams, [{ namespace: 'terminal', method: 'follow', args: { agentId: LOCAL_ID, id: 'term-1', attachmentId: 'att-9' }, signal: undefined }])
  handle.uninstall()
})

test('workspaceFiles/changes forwards as a stream with the restored workspaceFileScopeId', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.streamFrames = [{ kind: 'ready' }, { kind: 'change', change: { absolutePath: '/srv/src/index.ts', version: 'v2' } }]
  const { handle } = install(gateway, relay)
  const frames = []
  for await (const frame of gateway.wireTap('workspaceFiles/changes', { args: { workspaceFileScopeId: VIRTUAL_ID, path: '.' } }, { add: () => {} }, undefined, undefined, { signal: undefined })) {
    frames.push(frame)
  }
  assert.deepEqual(frames, relay.streamFrames)
  assert.deepEqual(relay.streams, [{ namespace: 'workspaceFiles', method: 'changes', args: { workspaceFileScopeId: LOCAL_ID, path: '.' }, signal: undefined }])
  handle.uninstall()
})

// -- TA-2: the terminal/attach duplex stream (DSH 0.2.2+) ---------------------------
// 0.2.2 merged terminal/follow + write + resize into one stream whose uplink
// carries TerminalInput write/resize commands; the interceptor must hand the
// host inbox and its mux window to the relay instead of half-closing it, and
// must keep every refusal path half-closing it.

test('TA-2: terminal/attach forwards the host uplink and window to the relay; the downlink frames pass through', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.streamFrames = [
    { type: 'snapshot', sequence: 0, screen: '$ ', writable: true, inputWindow: { maxBytes: 4096, frameOverheadBytes: 16 }, info: { id: 'term-1', title: 'zsh', cols: 80, rows: 24, state: 'running', exitCode: null } },
    { type: 'output', sequence: 1, data: '/srv\r\n' },
    { type: 'state', sequence: 2, state: 'running' },
    { type: 'ack', sequence: 1 },
  ]
  const { handle } = install(gateway, relay)
  const uplink = createFakeUplink()
  const uplinkWindow = { maxBytes: 4096, frameOverheadBytes: 16 }
  const frames = []
  for await (const frame of gateway.wireTap('terminal/attach', { args: { agentId: VIRTUAL_ID, id: 'term-1', attachmentId: 'att-9' } }, uplink, undefined, undefined, { signal: undefined }, uplinkWindow)) {
    frames.push(frame)
  }
  assert.deepEqual(frames, relay.streamFrames, 'snapshot/output/state/ack frames carry no session id — untouched')
  assert.equal(relay.streams.length, 1)
  assert.deepEqual(relay.streams[0].args, { agentId: LOCAL_ID, id: 'term-1', attachmentId: 'att-9' }, 'the virtual agentId was restored')
  assert.equal(relay.streams[0].options.uplink, uplink, 'the HOST inbox itself rides to relay.openStream — not a half-close')
  assert.deepEqual(relay.streams[0].options.uplinkWindow, uplinkWindow, 'the mux window rides through verbatim')
  assert.equal(uplink.returnCalled, false, 'the duplex uplink was NOT half-closed by the interceptor')
  handle.uninstall()
})

test('TA-2: the uplink window is shape-checked client-side too — garbage is dropped, an older host forwards the bare uplink', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const uplink = createFakeUplink()

  // A zero budget is not a window: dropped, never refused (the numbers are
  // the host's own contract with itself — the server re-checks the shape).
  gateway.wireTap('terminal/attach', { args: { agentId: VIRTUAL_ID, id: 'term-1', attachmentId: 'att-1' } }, uplink, undefined, undefined, { signal: undefined }, { maxBytes: 0, frameOverheadBytes: 8 })
  assert.deepEqual(relay.streams[0].options, { uplink }, 'maxBytes: 0 dropped the window')

  // Fractional bytes are equally not a window.
  gateway.wireTap('terminal/attach', { args: { agentId: VIRTUAL_ID, id: 'term-1', attachmentId: 'att-1' } }, uplink, undefined, undefined, { signal: undefined }, { maxBytes: 4096.5, frameOverheadBytes: -1 })
  assert.deepEqual(relay.streams[1].options, { uplink }, 'fractional/negative values dropped the window')

  // A non-object window (an older/malformed mux) is dropped the same way.
  gateway.wireTap('terminal/attach', { args: { agentId: VIRTUAL_ID, id: 'term-1', attachmentId: 'att-1' } }, uplink, undefined, undefined, { signal: undefined }, 'junk')
  assert.deepEqual(relay.streams[2].options, { uplink }, 'a non-object window dropped')

  // An older host (the 5-argument open path) passes no window at all: the
  // bare uplink still forwards — the relay applies its own default window.
  gateway.wireTap('terminal/attach', { args: { agentId: VIRTUAL_ID, id: 'term-1', attachmentId: 'att-1' } }, uplink, undefined, undefined, { signal: undefined })
  assert.deepEqual(relay.streams[3].options, { uplink }, 'no window in, no window out — the uplink still forwards')
  handle.uninstall()
})

test('TA-2: terminal/attach opened offline refuses remote-offline at call time and releases the host uplink', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  relay.transition('offline')
  const uplink = createFakeUplink()
  assert.throws(
    () => gateway.wireTap('terminal/attach', { args: { agentId: VIRTUAL_ID, id: 'term-1', attachmentId: 'att-1' } }, uplink, undefined, undefined, { signal: undefined }),
    (error) => error.code === 'remote-offline',
  )
  assert.deepEqual(relay.streams, [], 'nothing reached the relay')
  assert.equal(uplink.returnCalled, true, 'the refused open half-closed the host inbox instead of leaking it')
  assert.equal(handle.diagnostics().recentFailures.at(-1).endpoint, 'terminal/attach')
  assert.equal(handle.diagnostics().recentFailures.at(-1).code, 'remote-offline')
  handle.uninstall()
})

test('TA-2: terminal/attach aimed at a different server refuses remote-mismatch and releases the host uplink', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const uplink = createFakeUplink()
  const other = toVirtual('ffffffff', 'session-a')
  assert.throws(
    () => gateway.wireTap('terminal/attach', { args: { agentId: other, id: 'term-1', attachmentId: 'att-1' } }, uplink, undefined, undefined, { signal: undefined }),
    (error) => error.code === 'remote-mismatch',
  )
  assert.deepEqual(relay.streams, [])
  assert.equal(uplink.returnCalled, true, 'the validate refusal released the host inbox too')
  handle.uninstall()
})

test('TA-2: terminal/attach ends with unshared when the server closes the session remote', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.streamThrow = new RelayError('unshared', 'shared session session-a was unshared (manual)')
  const { handle } = install(gateway, relay)
  const uplink = createFakeUplink()
  let thrown
  try {
    for await (const frame of gateway.wireTap('terminal/attach', { args: { agentId: VIRTUAL_ID, id: 'term-1', attachmentId: 'att-1' } }, uplink, undefined, undefined, { signal: undefined })) {
      void frame
    }
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof Error && thrown.code === 'unshared', `expected unshared, got: ${thrown}`)
  assert.equal(thrown.isDSHRemoteError, true, 'the code survives the host wire because the error is marked')
  assert.deepEqual(handle.diagnostics().closedSessions, [{ sessionId: VIRTUAL_ID, reason: 'manual' }], 'the closure registered like every session-scoped stream')
  handle.uninstall()
})

// -- T41a-fix: session-reference discipline — mention virtualization, prompt-text
// -- restore, local-reference refusal, and the shared dsh-session codec ---------------

test('candidates rows virtualize the mention URI together with sessionId (T41a-fix)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.invokeValue = [
    { sessionId: 'session-candidate', label: '调试', displayTitle: '调试登录', mention: `@[调试登录](${encodeSessionReferenceUri('session-candidate')})`, sameWorkspace: true, createdAt: 1 },
  ]
  const { handle } = install(gateway, relay)
  const envelope = await gateway.rpcBridge('sessionReferenceResolver/candidates', { args: { agentId: VIRTUAL_ID, query: '调试' } }, undefined, undefined)
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.value, [
    { sessionId: toVirtual(SERVER_ID, 'session-candidate'), label: '调试', displayTitle: '调试登录', mention: `@[调试登录](${encodeSessionReferenceUri(toVirtual(SERVER_ID, 'session-candidate'))})`, sameWorkspace: true, createdAt: 1 },
  ], 'the mention URI carries the VIRTUAL id so the prompt restore can decode it again')
  // A row whose mention carries no decodable URI travels with the mention untouched.
  relay.invokeValue = [{ sessionId: 'session-x', label: 'y', mention: '@[y](not-a-uri)' }]
  const second = await gateway.rpcBridge('sessionReferenceResolver/candidates', { args: { agentId: VIRTUAL_ID, query: '' } }, undefined, undefined)
  assert.deepEqual(second.value, [{ sessionId: toVirtual(SERVER_ID, 'session-x'), label: 'y', mention: '@[y](not-a-uri)' }])
  handle.uninstall()
})

test('prompt references restore virtual ids in text; a LOCAL reference refuses the call (T41a-fix)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const enc = encodeSessionReferenceUri
  const text = `对照 @[另一个](${enc(toVirtual(SERVER_ID, 'session-b'))}) 与裸地址 ${enc(toVirtual(SERVER_ID, 'session-a'))}`
  const envelope = await gateway.rpcBridge('session/prompt', {
    args: { request: { requestId: 'r1', sessionId: VIRTUAL_ID, mode: 'queue', content: [{ type: 'text', text }, { type: 'image', mediaType: 'image/png', data: 'Zm9v' }] } },
  }, undefined, undefined)
  assert.equal(envelope.ok, true)
  assert.deepEqual(relay.invokes[0].args.request.content[0].text, `对照 @[另一个](${enc('session-b')}) 与裸地址 ${enc('session-a')}`, 'both address forms carry the ORIGINAL ids')
  assert.equal(relay.invokes[0].args.request.sessionId, LOCAL_ID, 'the registered-field restore still ran')

  // A reference to a LOCAL session refuses the whole call — the server does
  // not have it, and DSH would answer the address with whatever it found.
  const local = await gateway.rpcBridge('session/prompt', {
    args: { request: { requestId: 'r2', sessionId: VIRTUAL_ID, mode: 'queue', content: [{ type: 'text', text: `本地结论 ${enc('session-local-uuid')}` }] } },
  }, undefined, undefined)
  assert.deepEqual(local, { ok: false, error: { code: 'remote-unsupported', message: '引用的会话不在服务端上，无法转发', details: {} } })
  assert.equal(relay.invokes.length, 1, 'the refused prompt never traveled')

  // Non-canonical tokens are not references: they pass through untouched.
  const junk = `畸形 dsh-session:!!! 与伪地址 dsh-session:${Buffer.from('session-x', 'utf8').toString('base64url')}`
  await gateway.rpcBridge('session/prompt', {
    args: { request: { requestId: 'r3', sessionId: VIRTUAL_ID, mode: 'queue', content: [{ type: 'text', text: junk }] } },
  }, undefined, undefined)
  assert.deepEqual(relay.invokes[1].args.request.content[0].text, junk, 'malformed tokens travel for DSH to refuse')
  handle.uninstall()
})

test('subagents/prompt references restore the same way (T41a-fix)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const enc = encodeSessionReferenceUri
  const envelope = await gateway.rpcBridge('subagents/prompt', {
    args: { request: { requestId: 'r1', parentSessionId: toVirtual(SERVER_ID, 'session-parent'), childSessionId: toVirtual(SERVER_ID, 'session-child'), mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: `引用 ${enc(toVirtual(SERVER_ID, 'session-parent'))}` }] } },
  }, undefined, undefined)
  assert.equal(envelope.ok, true)
  assert.deepEqual(relay.invokes[0].args.request.content[0].text, `引用 ${enc('session-parent')}`)
  assert.deepEqual(relay.invokes[0].args.request.parentSessionId, 'session-parent')
  assert.deepEqual(relay.invokes[0].args.request.childSessionId, 'session-child')
  handle.uninstall()
})

test('updateQueue edit content restores references like prompt text (T41a-fix2)', async () => {
  // The edit REPLACES a queued user message's content (RT updateQueue), so
  // its text is parsed at the next turn start exactly like prompt text —
  // the restore must cover it, not just the prompt routes.
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const enc = encodeSessionReferenceUri
  const envelope = await gateway.rpcBridge('session/updateQueue', {
    args: { request: { sessionId: VIRTUAL_ID, itemId: 'q1', action: { kind: 'edit', content: [{ type: 'text', text: `改后 ${enc(toVirtual(SERVER_ID, 'session-b'))}` }] } } },
  }, undefined, undefined)
  assert.equal(envelope.ok, true)
  assert.deepEqual(relay.invokes[0].args.request.action.content[0].text, `改后 ${enc('session-b')}`, 'the edit content carries the ORIGINAL id')
  assert.equal(relay.invokes[0].args.request.sessionId, LOCAL_ID, 'the registered-field restore still ran')

  // A reference to a LOCAL session refuses the whole call, same rule.
  const local = await gateway.rpcBridge('session/updateQueue', {
    args: { request: { sessionId: VIRTUAL_ID, itemId: 'q2', action: { kind: 'edit', content: [{ type: 'text', text: `本地结论 ${enc('session-local-uuid')}` }] } } },
  }, undefined, undefined)
  assert.equal(local.ok, false)
  assert.equal(local.error.code, 'remote-unsupported')
  assert.equal(relay.invokes.length, 1, 'the refused edit never traveled')
  handle.uninstall()
})

test('commands/execute strings restore /plan references; a local one refuses (T41a-fix2)', async () => {
  // /plan steers its raw input in as a fresh USER message (RT
  // dsh-plan-mode), so EVERY string of a commands/execute call is scanned —
  // not just the line field.
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const enc = encodeSessionReferenceUri
  const envelope = await gateway.rpcBridge('commands/execute', {
    args: { agentId: VIRTUAL_ID, line: `/plan ${enc(toVirtual(SERVER_ID, 'session-c'))}` },
  }, undefined, undefined)
  assert.equal(envelope.ok, true)
  assert.deepEqual(relay.invokes[0].args.line, `/plan ${enc('session-c')}`, 'the line carries the ORIGINAL id')
  assert.equal(relay.invokes[0].args.agentId, LOCAL_ID, 'the registered-field restore still ran')

  // The scan is recursive: a reference in a nested non-line string is
  // restored the same way.
  await gateway.rpcBridge('commands/execute', {
    args: { agentId: VIRTUAL_ID, line: '/plan ok', extra: { deep: [`看看 ${enc(toVirtual(SERVER_ID, 'session-d'))}`] } },
  }, undefined, undefined)
  assert.deepEqual(relay.invokes[1].args.extra.deep[0], `看看 ${enc('session-d')}`)

  // A reference to a LOCAL session refuses the whole call.
  const local = await gateway.rpcBridge('commands/execute', {
    args: { agentId: VIRTUAL_ID, line: `/plan ${enc('session-local-uuid')}` },
  }, undefined, undefined)
  assert.equal(local.ok, false)
  assert.equal(local.error.code, 'remote-unsupported')
  assert.equal(relay.invokes.length, 2, 'the refused command never traveled')
  handle.uninstall()
})

test('both ends share ONE codec and ONE scan rule module (T41a-fix2)', () => {
  // T41a-fix kept two private copies pinned by this test; T41a-fix2 moved
  // the codec and the scan rule into src/session-reference.ts, imported by
  // BOTH ends — the pin is now the import itself, plus the re-export
  // identity on the server surface.
  const shared = require('../lib/session-reference.js')
  const server = require('../lib/relay-server.js')
  assert.equal(server.encodeSessionReferenceUri, shared.encodeSessionReferenceUri, 'the server surface IS the shared codec')
  assert.equal(server.decodeSessionReferenceUri, shared.decodeSessionReferenceUri)
  // The rule itself answers for exactly the three injection surfaces.
  const enc = shared.encodeSessionReferenceUri
  const prompt = { request: { sessionId: 's', content: [{ type: 'text', text: `a ${enc('p1')}` }] } }
  assert.deepEqual(shared.collectReferenceTexts('session', 'prompt', prompt), [`a ${enc('p1')}`])
  assert.deepEqual(shared.collectReferenceTexts('subagents', 'prompt', prompt), [`a ${enc('p1')}`])
  const queue = { request: { sessionId: 's', action: { kind: 'edit', content: [{ type: 'text', text: `b ${enc('q1')}` }] } } }
  assert.deepEqual(shared.collectReferenceTexts('session', 'updateQueue', queue), [`b ${enc('q1')}`])
  const steer = { request: { sessionId: 's', action: { kind: 'steer', content: [{ type: 'text', text: `c ${enc('q2')}` }] } } }
  assert.deepEqual(shared.collectReferenceTexts('session', 'updateQueue', steer), [], 'steer carries no injectable content')
  const command = { agentId: 's', line: `/plan ${enc('c1')}`, extra: { deep: [`d ${enc('c2')}`] } }
  assert.deepEqual(shared.collectReferenceTexts('commands', 'execute', command), ['s', `/plan ${enc('c1')}`, `d ${enc('c2')}`], 'every string, recursively — field names play no role')
  assert.deepEqual(shared.collectReferenceTexts('session', 'rename', { request: { sessionId: 's', title: `${enc('x')}` } }), [], 'other methods contribute nothing')
  // And neither end keeps a private copy: both import the shared module.
  for (const file of ['src/intercept.ts', 'src/relay-server.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    assert.ok(source.includes("from './session-reference.js'"), `${file} must import the shared codec/rule`)
    assert.ok(!/const SESSION_REFERENCE_URI|function decodeSessionReferenceUri/.test(source), `${file} must not re-define the codec`)
  }
})

test('the shared codec round-trips the host shapes (T41a-fix)', () => {
  // Both ends decode byte-identically by construction now (one module); what
  // still needs pinning is the WIRE shape against the host encoder.
  for (const id of ['session-a', toVirtual(SERVER_ID, 'session-b'), '含中文与~/字符', '"quoted"']) {
    const uri = encodeSessionReferenceUri(id)
    assert.ok(uri.startsWith('dsh-session:'))
    assert.equal(decodeSessionReferenceUri(uri), id)
  }
  assert.equal(decodeSessionReferenceUri('dsh-session:not-base64url!'), undefined)
  assert.equal(encodeSessionReferenceUri('a'), 'dsh-session:ImEi', 'base64url of the JSON-QUOTED id, matching the host encoder')
})


// -- P55-2: resolveRemoteFileScope — the /api/file session attribution --------

test('P55-2: resolveRemoteFileScope answers the just-opened remote follow at once, before any browser report', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.streamFrames = [
    { type: 'snapshot', header: { version: 4, id: LOCAL_ID, cwd: '/srv/work' }, cursor: 0, records: [] },
  ]
  // Default install: no getCurrentSession injected — permanently `unavailable`,
  // so EVERY answer below comes from the follow tracking alone.
  const { handle } = install(gateway, relay)
  assert.equal(handle.resolveRemoteFileScope('/srv/work/chart.png'), undefined, 'nothing is known before the first follow opens')

  // Opening the stream settles the answer SYNCHRONOUSLY — the wrapper marks
  // the followed session before it returns, so the first <img> of the page
  // (which races the 1s current-session report) cannot fall to the local 404.
  const iterable = gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined })
  assert.deepEqual(
    handle.resolveRemoteFileScope('/tmp/some-unrelated/render.png'),
    { serverId: SERVER_ID, sessionId: LOCAL_ID },
    'a path no known cwd claims falls back to the just-opened remote session (step C)',
  )

  // The snapshot frame's header.cwd feeds the precise match: a path under the
  // session's cwd resolves to THAT session even while nothing else knows it.
  await drained(iterable)
  assert.deepEqual(
    handle.resolveRemoteFileScope('/srv/work/sub/dir/notes.md'),
    { serverId: SERVER_ID, sessionId: LOCAL_ID },
    'a subpath of the snapshot cwd matches the session (step B)',
  )
  assert.deepEqual(
    handle.resolveRemoteFileScope('relative.png'),
    { serverId: SERVER_ID, sessionId: LOCAL_ID },
    'no cwd claim anywhere still falls back to the active remote session (step C)',
  )
  handle.uninstall()
})

test('P55-2: resolveRemoteFileScope matches session/list cwds precisely (POSIX and Windows, drive-letter case)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.invokeValues['session/list'] = {
    items: [
      { sessionId: 'session-posix', cwd: '/Volumes/Data/work' },
      { sessionId: 'session-win', cwd: 'C:\\Users\\dev\\proj' },
    ],
  }
  const { handle } = install(gateway, relay)
  // The merged list pull records each remote row's cwd under its ORIGINAL id.
  await gateway.rpcBridge('session/list', { args: {} }, undefined, undefined)

  assert.deepEqual(
    handle.resolveRemoteFileScope('/Volumes/Data/work/out/chart.png'),
    { serverId: SERVER_ID, sessionId: 'session-posix' },
    'a POSIX subpath matches the session whose cwd roots it',
  )
  assert.equal(
    handle.resolveRemoteFileScope('/Volumes/Data/other/chart.png'),
    undefined,
    'a sibling directory of a known cwd is not a match',
  )
  assert.deepEqual(
    handle.resolveRemoteFileScope('C:\\Users\\dev\\proj\\build\\out.png'),
    { serverId: SERVER_ID, sessionId: 'session-win' },
    'a Windows backslash path matches its session',
  )
  assert.deepEqual(
    handle.resolveRemoteFileScope('c:/users/dev/proj/readme.md'),
    { serverId: SERVER_ID, sessionId: 'session-win' },
    'the drive letter compares case-insensitively and forward slashes normalize',
  )
  assert.equal(
    handle.resolveRemoteFileScope('C:\\Users\\dev\\project\\x.png'),
    undefined,
    'a directory merely prefixed by the cwd string is not a match',
  )
  handle.uninstall()
})

test('P55-2: after switching to a local follow, paths off every remote cwd answer undefined; known cwds still match', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.streamFrames = [
    { type: 'snapshot', header: { version: 4, id: LOCAL_ID, cwd: '/srv/work' }, cursor: 0, records: [] },
  ]
  const { handle } = install(gateway, relay)
  const remoteFollow = gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined })
  await drained(remoteFollow)
  assert.deepEqual(handle.resolveRemoteFileScope('/srv/work/a.png'), { serverId: SERVER_ID, sessionId: LOCAL_ID })

  // The user navigates to a LOCAL session: the follow carries a non-virtual
  // session address, so the wrapper marks the switch at once.
  const localFollow = gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: 'session-local-1' } } } }, undefined, undefined, undefined, { signal: undefined })
  await drained(localFollow)
  assert.equal(
    handle.resolveRemoteFileScope('/tmp/elsewhere/x.png'),
    undefined,
    'the active remote is gone; a path no cwd claims stays local',
  )
  assert.deepEqual(
    handle.resolveRemoteFileScope('/srv/work/a.png'),
    { serverId: SERVER_ID, sessionId: LOCAL_ID },
    'a precise cwd match still forwards to the remote session that owns the file',
  )
  handle.uninstall()
})

test('P55-2: the reported current session drives the fallback until a local follow contradicts it', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  let current = { kind: 'open', sessionId: VIRTUAL_ID }
  const { handle } = install(gateway, relay, { getCurrentSession: () => current })
  assert.deepEqual(
    handle.resolveRemoteFileScope('/anything/x.png'),
    { serverId: SERVER_ID, sessionId: LOCAL_ID },
    'step A reads the browser-reported virtual session first',
  )

  // A local follow in THIS process is the newer fact — the report (which may
  // lag a reload by up to the report interval) must not override it.
  const localFollow = gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: 'session-local-1' } } } }, undefined, undefined, undefined, { signal: undefined })
  await drained(localFollow)
  assert.equal(handle.resolveRemoteFileScope('/anything/x.png'), undefined, 'the local follow wins over a stale virtual report')

  // And the browser catching up clears the contradiction again.
  current = { kind: 'open', sessionId: 'session-local-1' }
  assert.equal(handle.resolveRemoteFileScope('/anything/x.png'), undefined, 'a local current session never forwards')
  handle.uninstall()
})

test('API-1: virtualizeProjectionValues rewrites subagentCatalog and agentTeam across follow, projections, list, and control', async () => {
  const { createControlMerger, mergeSessionList } = require('../lib/merge-streams.js')
  const { virtualizeProjectionValues } = require('../lib/intercept.js')
  const subagentCatalog = [{ id: 'sub-1', mode: 'continuable' }, { id: 'sub-2', mode: 'one-shot' }]
  const agentTeam = { teamId: 't1', tasks: [{ id: 'task-1', ownerId: 'agent-a' }, { id: 'task-2', ownerId: '' }] }
  const modelSelection = { next: { provider: 'deepseek', model: 'chat' }, lastUsed: null }

  const rawValues = { modelSelection, subagentCatalog, agentTeam, untypedFlag: true }
  const direct = virtualizeProjectionValues(rawValues, SERVER_ID)
  assert.deepEqual(direct.subagentCatalog, [
    { id: toVirtual(SERVER_ID, 'sub-1'), mode: 'continuable' },
    { id: toVirtual(SERVER_ID, 'sub-2'), mode: 'one-shot' },
  ])
  assert.deepEqual(direct.agentTeam, {
    teamId: 't1',
    tasks: [
      { id: 'task-1', ownerId: toVirtual(SERVER_ID, 'agent-a') },
      { id: 'task-2', ownerId: '' },
    ],
  })
  assert.deepEqual(direct.modelSelection, { next: { provider: toVirtual(SERVER_ID, 'deepseek'), model: 'chat' }, lastUsed: null })
  assert.equal(direct.untypedFlag, true)

  // 1) session/follow snapshot
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  relay.streamFrames = [
    { type: 'snapshot', header: { version: 4, id: LOCAL_ID, cwd: '/tmp' }, cursor: 1, records: [], projections: { values: rawValues } },
  ]
  const { handle } = install(gateway, relay)
  const followFrames = await drained(
    gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined, undefined, { signal: undefined }),
  )
  assert.deepEqual(followFrames[0].projections.values, direct)

  // 2) session/projections
  relay.invokeValue = { asOfSeq: 5, values: rawValues }
  const projRes = await gateway.rpcBridge('session/projections', { args: { request: { sessionId: VIRTUAL_ID } } }, undefined, undefined)
  assert.equal(projRes.ok, true)
  assert.deepEqual(projRes.value.values, direct)
  handle.uninstall()

  // 3) session/list (projections.values & projectionValues)
  const mergedList = mergeSessionList(
    { items: [] },
    { items: [{ sessionId: 's1', projections: { asOfSeq: 2, values: rawValues }, projectionValues: rawValues }] },
    SERVER_ID,
  )
  assert.deepEqual(mergedList.items[0].projections.values, direct)
  assert.deepEqual(mergedList.items[0].projectionValues, direct)

  // 4) session/control (baseline + live legacy key/value + 0.2.2 changes[])
  const merger = createControlMerger({ serverId: SERVER_ID, serverName: 'srv' })
  merger.onLocal({ type: 'baseline', value: { projections: {} } })
  const baseOut = merger.onRemote({
    type: 'baseline',
    value: { projections: { s1: { asOfSeq: 3, values: rawValues } } },
  })
  const baseMap = Object.fromEntries(baseOut.map((f) => [f.key, f.value]))
  assert.deepEqual(baseMap.subagentCatalog, direct.subagentCatalog)
  assert.deepEqual(baseMap.agentTeam, direct.agentTeam)

  const legacyOut = merger.onRemote({ type: 'projection', sessionId: 's1', seq: 4, key: 'subagentCatalog', value: subagentCatalog })
  assert.deepEqual(legacyOut[0].value, direct.subagentCatalog)

  const batchedOut = merger.onRemote({ type: 'projection', sessionId: 's1', seq: 5, changes: [{ key: 'agentTeam', val: agentTeam }] })
  assert.deepEqual(batchedOut[0].value, direct.agentTeam)
  assert.deepEqual(batchedOut[0].changes[0].val, direct.agentTeam)
})

test('API-2: rewriteRemoteEventFrame virtualizes all 5 session-scoped emits and drops malformed or global emits', () => {
  const { rewriteRemoteEventFrame, SESSION_STREAM_HOLD_ENDPOINTS } = require('../lib/intercept.js')
  assert.deepEqual(
    rewriteRemoteEventFrame({ type: 'emit', event: 'api-session/status', args: ['s1', true] }, SERVER_ID),
    { type: 'emit', event: 'api-session/status', args: [toVirtual(SERVER_ID, 's1'), true] },
  )
  assert.deepEqual(
    rewriteRemoteEventFrame({ type: 'emit', event: 'api-session/activity', args: ['s1', 123456] }, SERVER_ID),
    { type: 'emit', event: 'api-session/activity', args: [toVirtual(SERVER_ID, 's1'), 123456] },
  )
  assert.deepEqual(
    rewriteRemoteEventFrame({ type: 'emit', event: 'api-session/error', args: ['s1', 'boom'] }, SERVER_ID),
    { type: 'emit', event: 'api-session/error', args: [toVirtual(SERVER_ID, 's1'), 'boom'] },
  )
  assert.deepEqual(
    rewriteRemoteEventFrame({ type: 'emit', event: 'agent-preset/selected', args: ['s1', 'standard'] }, SERVER_ID),
    { type: 'emit', event: 'agent-preset/selected', args: [toVirtual(SERVER_ID, 's1'), toVirtual(SERVER_ID, 'standard')] },
  )
  assert.deepEqual(
    rewriteRemoteEventFrame({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1' }] }, SERVER_ID),
    { type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: toVirtual(SERVER_ID, 's1') }] },
  )
  assert.deepEqual(
    rewriteRemoteEventFrame({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1', goal: { title: 'g' } }] }, SERVER_ID),
    { type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: toVirtual(SERVER_ID, 's1'), goal: { title: 'g' } }] },
  )
  // Invalid / global / malformed shapes are dropped
  for (const bad of [
    { type: 'emit', event: 'api-session/activity', args: ['s1', Number.NaN] },
    { type: 'emit', event: 'api-session/error', args: ['s1', { message: 'obj' }] },
    { type: 'emit', event: 'agent-preset/selected', args: ['s1', ''] },
    { type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1', extra: 1 }] },
    { type: 'emit', event: 'api-session/added', args: [{ sessionId: 's1' }] },
    { type: 'emit', event: 'api-session/status', args: ['s1', true], extra: 1 },
  ]) {
    assert.equal(rewriteRemoteEventFrame(bad, SERVER_ID), null, JSON.stringify(bad))
  }
  assert.equal(SESSION_STREAM_HOLD_ENDPOINTS?.has('toolResults/watch') ?? false, false)
  assert.equal(SESSION_STREAM_HOLD_ENDPOINTS?.has('userQuestions/attachWait') ?? false, false)
})

test('API-4: 31 forgePanel session-scoped endpoints classify read vs write and forgePanel/follow stays outside SESSION_STREAM_HOLD_ENDPOINTS', async () => {
  assert.equal(SESSION_STREAM_HOLD_ENDPOINTS.has('forgePanel/follow'), false)
  assert.equal(isRemoteWrite('forgePanel/follow'), false)
  for (const m of [
    'forgePanel/branches',
    'forgePanel/diffBases',
    'forgePanel/localCommits',
    'forgePanel/localDiff',
    'forgePanel/localText',
    'forgePanel/changeRequestChecks',
    'forgePanel/changeRequestCommits',
    'forgePanel/changeRequestDiff',
    'forgePanel/changeRequestReview',
    'forgePanel/changeRequestText',
    'forgePanel/changeRequestViewed',
    'forgePanel/reviewerCandidates',
  ]) {
    assert.equal(isRemoteWrite(m), false, m)
  }
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  relay.transition('offline')
  for (const m of [
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
  ]) {
    assert.equal(isRemoteWrite(m), true, m)
    const res = await gateway.rpcBridge(m, { args: { sessionId: VIRTUAL_ID } }, undefined, undefined)
    assert.equal(res.ok, false, m)
    assert.equal(res.error.code, 'remote-offline', m)
  }
  assert.equal(relay.invokes.length, 0)
  handle.uninstall()
})

test('API-6: workspace/insertSessionBefore rejects mixed local/remote ids and virtualizes WorkspaceValue result', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const wsVirtual = toVirtual(SERVER_ID, 'w-1')
  const beforeVirtual = toVirtual(SERVER_ID, 's-before')
  relay.invokeValue = {
    workspace: {
      workspaceId: 'w-1',
      title: '工作区',
      path: '/srv/w-1',
      sessionIds: ['s-1', 's-before'],
    },
  }
  const { handle } = install(gateway, relay)

  // Mixed local + remote ids are refused before reaching relay or local gateway
  const mixed = await gateway.rpcBridge(
    'workspace/insertSessionBefore',
    { args: { request: { workspaceId: wsVirtual, sessionId: 'local-session', beforeSessionId: beforeVirtual } } },
    undefined,
    undefined,
  )
  assert.equal(mixed.ok, false)
  assert.equal(mixed.error.code, 'remote-mismatch')
  assert.equal(relay.invokes.length, 0)
  assert.equal(gateway.rpcCalls.length, 0)

  // Same-server remote insert forwards stripped ids and virtualizes WorkspaceValue
  const ok = await gateway.rpcBridge(
    'workspace/insertSessionBefore',
    { args: { request: { workspaceId: wsVirtual, sessionId: VIRTUAL_ID, beforeSessionId: beforeVirtual } } },
    undefined,
    undefined,
  )
  assert.equal(ok.ok, true)
  assert.deepEqual(relay.invokes[0].args, {
    request: { workspaceId: 'w-1', sessionId: LOCAL_ID, beforeSessionId: 's-before' },
  })
  assert.equal(ok.value.workspace.workspaceId, wsVirtual)
  assert.equal(ok.value.workspace.title, '测试服务器 · 工作区')
  assert.deepEqual(ok.value.workspace.sessionIds, [toVirtual(SERVER_ID, 's-1'), beforeVirtual])
  handle.uninstall()
})

test('API-6: session/search & agentPresets/* merge across local and remote, protect local settings, and validate select/create', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)

  // settings/update refuses any virtual preset id
  const settingsRes = await gateway.rpcBridge(
    'settings/update',
    { args: { key: 'agent-preset-registry', patch: { selectedDefault: toVirtual(SERVER_ID, 'ptc') } } },
    undefined,
    undefined,
  )
  assert.equal(settingsRes.ok, false)
  assert.equal(settingsRes.error.code, 'remote-unsupported')
  assert.equal(gateway.rpcCalls.length, 0)

  // agentPresets/select routing: local+virtual, remote+local, cross-server mismatch, same-server echo
  const localPlusRemotePreset = await gateway.rpcBridge(
    'agentPresets/select',
    { args: { agentId: 'local-session', agentPreset: toVirtual(SERVER_ID, 'ptc') } },
    undefined,
    undefined,
  )
  assert.equal(localPlusRemotePreset.ok, false)
  assert.equal(localPlusRemotePreset.error.code, 'remote-unsupported')

  const remotePlusLocalPreset = await gateway.rpcBridge(
    'agentPresets/select',
    { args: { agentId: VIRTUAL_ID, agentPreset: 'standard' } },
    undefined,
    undefined,
  )
  assert.equal(remotePlusLocalPreset.ok, false)
  assert.equal(remotePlusLocalPreset.error.code, 'remote-unsupported')
  assert.ok(remotePlusLocalPreset.error.message.includes('测试服务器'))

  const crossServerSelect = await gateway.rpcBridge(
    'agentPresets/select',
    { args: { agentId: VIRTUAL_ID, agentPreset: toVirtual('ffffffff', 'ptc') } },
    undefined,
    undefined,
  )
  assert.equal(crossServerSelect.ok, false)
  assert.equal(crossServerSelect.error.code, 'remote-mismatch')

  relay.invokeValue = 'ptc'
  const sameServerSelect = await gateway.rpcBridge(
    'agentPresets/select',
    { args: { agentId: VIRTUAL_ID, agentPreset: toVirtual(SERVER_ID, 'ptc') } },
    undefined,
    undefined,
  )
  assert.deepEqual(sameServerSelect, { ok: true, value: toVirtual(SERVER_ID, 'ptc') })

  // session/create preset routing: local workspace + virtual preset refused; same server works
  const createLocalWithRemotePreset = await gateway.rpcBridge(
    'session/create',
    { args: { request: { workspaceId: 'local-ws', agentPreset: toVirtual(SERVER_ID, 'cordis') } } },
    undefined,
    undefined,
  )
  assert.equal(createLocalWithRemotePreset.ok, false)
  assert.equal(createLocalWithRemotePreset.error.code, 'remote-unsupported')

  relay.invokeValue = { sessionId: 's-new', agentPreset: 'cordis' }
  const createRemoteWithRemotePreset = await gateway.rpcBridge(
    'session/create',
    { args: { request: { workspaceId: toVirtual(SERVER_ID, 'w-1'), agentPreset: toVirtual(SERVER_ID, 'cordis') } } },
    undefined,
    undefined,
  )
  assert.equal(createRemoteWithRemotePreset.ok, true)
  assert.deepEqual(createRemoteWithRemotePreset.value, {
    sessionId: toVirtual(SERVER_ID, 's-new'),
    agentPreset: toVirtual(SERVER_ID, 'cordis'),
  })

  // agentPresets/read routes virtual preset id and localizes built-in name
  relay.invokeValue = { agentPreset: 'minimal', content: '# Minimal prompt' }
  const readRes = await gateway.rpcBridge(
    'agentPresets/read',
    { args: { agentPreset: toVirtual(SERVER_ID, 'minimal') } },
    undefined,
    undefined,
  )
  assert.deepEqual(readRes, {
    ok: true,
    value: {
      agentPreset: toVirtual(SERVER_ID, 'minimal'),
      content: '# Minimal prompt',
      name: '[测试服务器] 极简模式',
    },
  })

  // agentPresets/list merges local + remote presets
  gateway.spec.rpc = {
    'agentPresets/list': { ok: true, value: { presets: [{ id: 'standard', isDefault: true }] } },
    'session/search': { ok: true, value: { items: [{ sessionId: 'l-1', title: 'Local' }], hasMore: false } },
  }
  relay.invokeValue = { presets: [{ id: 'ptc', isDefault: true }, { id: 'custom', name: '代码审查', isDefault: false }] }
  const listRes = await gateway.rpcBridge('agentPresets/list', { args: {} }, undefined, undefined)
  assert.deepEqual(listRes, {
    ok: true,
    value: {
      presets: [
        { id: 'standard', isDefault: true },
        { id: toVirtual(SERVER_ID, 'ptc'), name: '[测试服务器] PTC 模式', isDefault: false },
        { id: toVirtual(SERVER_ID, 'custom'), name: '[测试服务器] 代码审查', isDefault: false },
      ],
    },
  })

  relay.invokeValue = { items: [{ sessionId: 's-hit', title: 'Remote' }], hasMore: true }
  const searchRes = await gateway.rpcBridge('session/search', { args: { request: { query: 'test' } } }, undefined, undefined)
  assert.deepEqual(searchRes, {
    ok: true,
    value: {
      items: [
        { sessionId: 'l-1', title: 'Local' },
        { sessionId: toVirtual(SERVER_ID, 's-hit'), title: 'Remote' },
      ],
      hasMore: true,
    },
  })
  handle.uninstall()
})

test('D23-5: sessionStatus/mark restores virtual sessionId and sessionStatus/follow merges across pool servers', async () => {
  assert.deepEqual(CLIENT_METHOD_FIELDS['sessionStatus/mark'], ['sessionId'])
  assert.deepEqual(CLIENT_METHOD_FIELDS['sessionStatus/follow'], [])
  assert.equal(isRemoteWrite('sessionStatus/mark'), true)
  assert.equal(REMOTE_READ_METHODS.has('sessionStatus/follow'), true)

  const gateway = new FakeTypertGateway()
  const localGate = createGate()
  const origOpen = gateway.openWireStream.bind(gateway)
  gateway.openWireStream = (endpoint, ...rest) =>
    endpoint === 'sessionStatus/follow' ? localGate.iterable : origOpen(endpoint, ...rest)
  const relay1 = createControllableRelay({
    handshakeInfo: { relayProtocol: 1, serverId: '11111111', serverName: 'S1', dshVersion: '0.0.0', fingerprints: {} },
  })
  const relay2 = createControllableRelay({
    handshakeInfo: { relayProtocol: 1, serverId: '22222222', serverName: 'S2', dshVersion: '0.0.0', fingerprints: {} },
  })
  const poolEntries = [
    { id: 'e1', serverId: '11111111', serverName: 'S1', displayName: 'S1', client: relay1 },
    { id: 'e2', serverId: '22222222', serverName: 'S2', displayName: 'S2', client: relay2 },
  ]
  const pool = {
    entries: () => poolEntries,
    getByServerId: (sid) => poolEntries.find((e) => e.serverId === sid),
  }
  const handle = installIntercept({
    raw: gateway,
    pool,
    getServerId: () => undefined,
    log: () => {},
  })

  // sessionStatus/mark forwards restored sessionId
  const markOk = await gateway.rpcBridge(
    'sessionStatus/mark',
    { args: { sessionId: toVirtual('11111111', 's-1'), action: { type: 'unread' } } },
    undefined,
    undefined,
  )
  assert.equal(markOk.ok, true)
  const markInvokes = relay1.invokes.filter((c) => c.namespace === 'sessionStatus')
  assert.equal(markInvokes.length, 1)
  assert.deepEqual(
    { namespace: markInvokes[0].namespace, method: markInvokes[0].method, args: markInvokes[0].args },
    { namespace: 'sessionStatus', method: 'mark', args: { sessionId: 's-1', action: { type: 'unread' } } },
  )

  // Offline write refuses remote-offline
  relay1.transition('offline')
  const markOffline = await gateway.rpcBridge(
    'sessionStatus/mark',
    { args: { sessionId: toVirtual('11111111', 's-1'), action: { type: 'read', throughTurn: 1 } } },
    undefined,
    undefined,
  )
  assert.equal(markOffline.ok, false)
  assert.equal(markOffline.error.code, 'remote-offline')
  relay1.transition('online')

  // sessionStatus/follow merges local + pool servers
  const controller = new AbortController()
  const stream = await gateway.wireTap('sessionStatus/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const iter = stream[Symbol.asyncIterator]()
  const nextFrame = () => iter.next().then((r) => r.value)

  const lRec = { sessionId: 'local-1', completedTurn: 1, failed: false, readTurn: 0, manualUnread: false }
  const r1Rec = { sessionId: 's-1', completedTurn: 2, failed: false, readTurn: 1, manualUnread: false }
  const r2Rec = { sessionId: 's-2', completedTurn: 3, failed: true, readTurn: 0, manualUnread: true }

  localGate.push({ type: 'baseline', items: [lRec] })
  assert.deepEqual(await nextFrame(), { type: 'baseline', items: [lRec] })

  await waitUntil(() => relay1.streams.length === 1 && relay2.streams.length === 1)
  relay1.streams[0].gate.push({ type: 'baseline', items: [r1Rec] })
  assert.deepEqual(await nextFrame(), { type: 'changed', state: { ...r1Rec, sessionId: toVirtual('11111111', 's-1') } })

  relay2.streams[0].gate.push({ type: 'baseline', items: [r2Rec] })
  assert.deepEqual(await nextFrame(), { type: 'changed', state: { ...r2Rec, sessionId: toVirtual('22222222', 's-2') } })

  // Unpairing relay1 evicts relay1's records while preserving local + relay2
  relay1.transition('unpaired')
  assert.deepEqual(await nextFrame(), {
    type: 'baseline',
    items: [lRec, { ...r2Rec, sessionId: toVirtual('22222222', 's-2') }],
  })

  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('D23-6: forgePanel/{worktreeBases,revisit,reviewStage,changesLens} classify read/write, restore sessionId, and keep changesLens unheld', async () => {
  assert.equal(SESSION_STREAM_HOLD_ENDPOINTS.has('forgePanel/changesLens'), false)
  assert.equal(isRemoteWrite('forgePanel/worktreeBases'), false)
  assert.equal(isRemoteWrite('forgePanel/revisit'), false)
  assert.equal(isRemoteWrite('forgePanel/changesLens'), false)
  assert.equal(isRemoteWrite('forgePanel/reviewStage'), true)

  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)

  // Online read & write restore virtual sessionId -> original sessionId
  relay.invokeValue = { bases: ['main'] }
  const basesRes = await gateway.rpcBridge('forgePanel/worktreeBases', { args: { sessionId: VIRTUAL_ID, query: '' } }, undefined, undefined)
  assert.equal(basesRes.ok, true)
  assert.deepEqual(relay.invokes.at(-1).args, { sessionId: LOCAL_ID, query: '' })

  const revisitRes = await gateway.rpcBridge('forgePanel/revisit', { args: { sessionId: VIRTUAL_ID } }, undefined, undefined)
  assert.equal(revisitRes.ok, true)
  assert.deepEqual(relay.invokes.at(-1).args, { sessionId: LOCAL_ID })

  const stageRes = await gateway.rpcBridge('forgePanel/reviewStage', { args: { sessionId: VIRTUAL_ID, url: 'https://git/pr/1' } }, undefined, undefined)
  assert.equal(stageRes.ok, true)
  assert.deepEqual(relay.invokes.at(-1).args, { sessionId: LOCAL_ID, url: 'https://git/pr/1' })

  // Offline: reviewStage refuses remote-offline before invoke while revisit (read) still reaches client.invoke
  const countBeforeOffline = relay.invokes.length
  relay.transition('offline')
  const stageOffline = await gateway.rpcBridge('forgePanel/reviewStage', { args: { sessionId: VIRTUAL_ID, url: 'https://git/pr/1' } }, undefined, undefined)
  assert.equal(stageOffline.ok, false)
  assert.equal(stageOffline.error.code, 'remote-offline')
  assert.equal(stageOffline.error.message, '服务端离线，远程会话暂时只读')
  assert.equal(relay.invokes.length, countBeforeOffline)

  const revisitOffline = await gateway.rpcBridge('forgePanel/revisit', { args: { sessionId: VIRTUAL_ID } }, undefined, undefined)
  assert.equal(revisitOffline.ok, true)
  assert.equal(relay.invokes.length, countBeforeOffline + 1)

  handle.uninstall()
})

test('PR78-1: non-owner peers (e.g. LiveShare viewers) bypass Zen Remote dispatch/open on wrapped RPCs and streams', async () => {
  const gateway = new FakeTypertGateway()
  const localDispatches = []
  const localStreams = []
  const origDispatch = gateway.dispatchRpc.bind(gateway)
  const origOpen = gateway.openWireStream.bind(gateway)
  gateway.dispatchRpc = (endpoint, payload, signal, peer) => {
    localDispatches.push({ endpoint, payload, peer })
    return origDispatch(endpoint, payload, signal, peer)
  }
  gateway.openWireStream = (endpoint, payload, uplink, peer, signal, control) => {
    localStreams.push({ endpoint, payload, peer })
    return origOpen(endpoint, payload, uplink, peer, signal, control)
  }
  const relay = createControllableRelay({
    handshakeInfo: { relayProtocol: 1, serverId: '11111111', serverName: 'S1', dshVersion: '0.0.0', fingerprints: {} },
  })
  const poolEntries = [
    { id: 'e1', serverId: '11111111', serverName: 'S1', displayName: 'S1', client: relay },
  ]
  const pool = {
    entries: () => poolEntries,
    getByServerId: (sid) => poolEntries.find((e) => e.serverId === sid),
  }
  const handle = installIntercept({
    raw: gateway,
    pool,
    getServerId: () => undefined,
    log: () => {},
  })

  const viewerPeer = { principal: { kind: 'live-share', id: 'viewer-1' } }
  const ownerPeer = gateway.operatorPeer()
  const invokesBefore = relay.invokes.length
  const streamsBefore = relay.streams.length

  // Non-owner calling sessionStatus/mark with a virtual id must fall back locally instead of invoking relay
  await gateway.rpcBridge(
    'sessionStatus/mark',
    { args: { sessionId: toVirtual('11111111', 's-1'), action: { type: 'unread' } } },
    undefined,
    viewerPeer,
  )
  assert.equal(localDispatches.length, 1)
  assert.equal(localDispatches[0].peer, viewerPeer)
  assert.equal(relay.invokes.length, invokesBefore)

  // Non-owner opening sessionStatus/follow must fall back locally instead of opening relay stream
  const viewerController = new AbortController()
  await gateway.wireTap(
    'sessionStatus/follow',
    { args: {} },
    undefined,
    viewerPeer,
    viewerController.signal,
    { signal: viewerController.signal },
  )
  assert.equal(localStreams.length, 1)
  assert.equal(localStreams[0].peer, viewerPeer)
  assert.equal(relay.streams.length, streamsBefore)

  // Owner peer still forwards through Zen Remote relay
  const ownerMark = await gateway.rpcBridge(
    'sessionStatus/mark',
    { args: { sessionId: toVirtual('11111111', 's-1'), action: { type: 'unread' } } },
    undefined,
    ownerPeer,
  )
  assert.equal(ownerMark.ok, true)
  assert.equal(relay.invokes.length, invokesBefore + 1)
  assert.equal(relay.invokes[relay.invokes.length - 1].namespace, 'sessionStatus')

  handle.uninstall()
})

test('PR78-3: mergedMultiSnapshotStream reattaches when a re-paired RelayClient replaces the instance for the same serverId', async () => {
  const gateway = new FakeTypertGateway()
  const localGate = createGate()
  const origOpen = gateway.openWireStream.bind(gateway)
  gateway.openWireStream = (endpoint, ...rest) =>
    endpoint === 'sessionStatus/follow' ? localGate.iterable : origOpen(endpoint, ...rest)

  const relayOld = createControllableRelay({
    handshakeInfo: { relayProtocol: 1, serverId: '11111111', serverName: 'S1-old', dshVersion: '0.0.0', fingerprints: {} },
  })
  const relayNew = createControllableRelay({
    handshakeInfo: { relayProtocol: 1, serverId: '11111111', serverName: 'S1-new', dshVersion: '0.0.0', fingerprints: {} },
  })
  const poolEntries = [
    { id: 'e1', serverId: '11111111', serverName: 'S1-old', displayName: 'S1-old', client: relayOld },
  ]
  const pool = {
    entries: () => poolEntries,
    getByServerId: (sid) => poolEntries.find((e) => e.serverId === sid),
  }
  const handle = installIntercept({
    raw: gateway,
    pool,
    getServerId: () => undefined,
    log: () => {},
  })

  const controller = new AbortController()
  const stream = await gateway.wireTap('sessionStatus/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  const iter = stream[Symbol.asyncIterator]()
  const nextFrame = () => iter.next().then((r) => r.value)

  localGate.push({ type: 'baseline', items: [] })
  assert.deepEqual(await nextFrame(), { type: 'baseline', items: [] })

  await waitUntil(() => relayOld.streams.length === 1)
  const rOldRec = { sessionId: 's-1', completedTurn: 1, failed: false, readTurn: 0, manualUnread: false }
  relayOld.streams[0].gate.push({ type: 'baseline', items: [rOldRec] })
  assert.deepEqual(await nextFrame(), { type: 'changed', state: { ...rOldRec, sessionId: toVirtual('11111111', 's-1') } })

  // Swap client instance for the same serverId (re-pair to new host address) and notify pool
  poolEntries[0] = { id: 'e2', serverId: '11111111', serverName: 'S1-new', displayName: 'S1-new', client: relayNew }
  handle.notePoolEvent()

  // Old stream aborted + baseline removes old records + new client subscribes
  await waitUntil(() => relayNew.streams.length === 1)
  assert.equal(relayOld.streams[0].aborted, true)
  const resetBaseline = await nextFrame()
  assert.deepEqual(resetBaseline, { type: 'baseline', items: [] })

  const rNewRec = { sessionId: 's-1', completedTurn: 3, failed: false, readTurn: 3, manualUnread: false }
  relayNew.streams[0].gate.push({ type: 'baseline', items: [rNewRec] })
  assert.deepEqual(await nextFrame(), { type: 'changed', state: { ...rNewRec, sessionId: toVirtual('11111111', 's-1') } })

  controller.abort()
  localGate.finish()
  handle.uninstall()
})

test('PR78-R3-L1: mergedMultiSnapshotStream skips reopen after forbidden-method until host reconnects or handshake changes', async () => {
  const gateway = new FakeTypertGateway()
  const localGate = createGate()
  const origOpen = gateway.openWireStream.bind(gateway)
  gateway.openWireStream = (endpoint, ...rest) =>
    endpoint === 'sessionStatus/follow' ? localGate.iterable : origOpen(endpoint, ...rest)

  const relay = createControllableRelay({
    handshakeInfo: { relayProtocol: 1, serverId: '11111111', serverName: 'S-old', dshVersion: '0.2.1-rc.5', fingerprints: {} },
  })
  const origOpenStream = relay.openStream.bind(relay)
  let openAttempts = 0
  let rejectUnsupported = true
  relay.openStream = (namespace, method, args, signal, options) => {
    if (namespace === 'sessionStatus' && method === 'follow') {
      openAttempts += 1
      if (rejectUnsupported) {
        return (async function* () {
          throw new RelayError('forbidden-method', 'forbidden method', 403)
        })()
      }
    }
    return origOpenStream(namespace, method, args, signal, options)
  }

  const scheduledTimers = []
  const poolEntries = [
    { id: 'e1', serverId: '11111111', serverName: 'S-old', displayName: 'S-old', client: relay },
  ]
  const pool = {
    entries: () => poolEntries,
    getByServerId: (sid) => poolEntries.find((e) => e.serverId === sid),
  }
  const handle = installIntercept({
    raw: gateway,
    pool,
    getServerId: () => undefined,
    clock: {
      now: () => 0,
      setTimeout: (fn) => { scheduledTimers.push(fn); return scheduledTimers.length },
      clearTimeout: () => {},
      random: () => 0.5,
    },
    log: () => {},
  })

  const controller1 = new AbortController()
  const stream1 = await gateway.wireTap('sessionStatus/follow', { args: {} }, undefined, gateway.operatorPeer(), controller1.signal, { signal: controller1.signal })
  const iter1 = stream1[Symbol.asyncIterator]()
  localGate.push({ type: 'baseline', items: [] })
  assert.deepEqual((await iter1.next()).value, { type: 'baseline', items: [] })

  await waitUntil(() => openAttempts === 1)
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(scheduledTimers.length, 0, 'forbidden-method must not arm a reopen timer')
  assert.equal(handle.diagnostics().recentFailures.some((f) => f.code === 'forbidden-method'), false)

  // Heartbeat while remaining online must NOT clear unsupported cache or re-probe
  relay.transition('online')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(openAttempts, 1)

  // Second subscription on the same still-online connection skips probing immediately
  const controller2 = new AbortController()
  const stream2 = await gateway.wireTap('sessionStatus/follow', { args: {} }, undefined, gateway.operatorPeer(), controller2.signal, { signal: controller2.signal })
  const iter2 = stream2[Symbol.asyncIterator]()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(openAttempts, 1)

  // Reconnect after going offline clears unsupported cache and re-probes once
  rejectUnsupported = false
  relay.transition('offline')
  relay.handshakeInfo = { relayProtocol: 1, serverId: '11111111', serverName: 'S-new', dshVersion: '0.2.3-alpha.2', fingerprints: { sessionStatus: 1 } }
  relay.transition('online')

  await waitUntil(() => openAttempts >= 2)
  const upgradedRec = { sessionId: 's-1', completedTurn: 1, failed: false, readTurn: 0, manualUnread: false }
  const activeRemote = relay.streams[relay.streams.length - 1]
  activeRemote.gate.push({ type: 'baseline', items: [upgradedRec] })
  assert.deepEqual((await iter1.next()).value, {
    type: 'changed',
    state: { ...upgradedRec, sessionId: toVirtual('11111111', 's-1') },
  })

  controller1.abort()
  controller2.abort()
  void iter2.return?.()
  localGate.finish()
  handle.uninstall()
})
