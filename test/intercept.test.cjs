/* dsh-zen-remote · gateway interception (src/intercept.ts, T23b-1)
 *
 * The fake gateway mirrors the ONE fact the wrap depends on (spike §2.2):
 * TypertGatewayService's constructor registers ARROW functions that look
 * the two methods up on the instance at every call — so the fake's
 * constructor source contains the exact same two call sites
 * checkGatewayShape greps for, and its taps prove an own property really is
 * reached (not just that a direct call works). The fake relay client
 * records every invoke/openStream and plays configurable results, frame
 * sequences and errors.
 *
 * The wiring test drives the BUILT lib/index.js the same way
 * role-wiring.test.cjs does: a fake cordis context whose inject executes,
 * a real socket in front of the mounted client route, and the status route
 * as the observer for both the installed and the refused-install shapes.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-intercept-'))
process.on('exit', () => { try { fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* best effort */ } })
for (const key of Object.keys(process.env)) {
  if (/^(?:LAN_GATE|DSH_PUSH)_/.test(key)) delete process.env[key]
}

const { checkGatewayShape } = require('../lib/intercept-shape.js')
const { installIntercept, behaviorSelfCheck, runSelfCheck, CLIENT_METHOD_FIELDS } = require('../lib/intercept.js')
const { toVirtual } = require('../lib/virtual-id.js')
const { RelayError } = require('../lib/relay-client.js')
const { symbols } = require('@deepseek-ai/cordis')

const SERVER_ID = '721b94fb'
const LOCAL_ID = 'session-712828e2-492f-4ad1-8a88-ece10ecc4cc0'
const VIRTUAL_ID = toVirtual(SERVER_ID, LOCAL_ID)

// -- the fakes -----------------------------------------------------------------

/**
 * Mirror of TypertGatewayService's interception surface. The constructor
 * source MUST contain the two dynamic call sites verbatim — that is not a
 * test adornment, it is the class's contract with checkGatewayShape.
 */
class FakeTypertGateway {
  constructor(spec = {}) {
    this.spec = spec
    this.rpcCalls = []
    this.streamCalls = []
    // Same dynamic lookup as the real wire adapter: open() resolves the
    // instance method at call time, so the installed own property shadows it.
    this.wireStream = {
      open: (endpoint, payload, uplink, peer, signal) => this.openWireStream(endpoint, payload, uplink, peer, signal, { signal }),
    }
    // The /api bridge and the wire tap, exactly as the real constructor
    // registers them — arrow functions over `this`.
    this.rpcBridge = (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)
    this.wireTap = (endpoint, payload, uplink, peer, signal, control) => this.openWireStream(endpoint, payload, uplink, peer, control.signal, control)
  }
  operatorPeer() { return { id: 'operator-peer' } }
  dispatchRpc(endpoint, payload, signal, peer) {
    this.rpcCalls.push({ endpoint, payload, signal, peer })
    const scripted = this.spec.rpc ? this.spec.rpc[endpoint] : undefined
    if (scripted !== undefined) return Promise.resolve(scripted)
    return Promise.resolve({ ok: true, value: { endpoint } })
  }
  openWireStream(endpoint, payload, uplink, peer, signal, control) {
    this.streamCalls.push({ endpoint, payload, uplink, peer, signal, control })
    const scripted = this.spec.stream ? this.spec.stream[endpoint] : undefined
    if (scripted instanceof Error) {
      return (async function* () { throw scripted })()
    }
    return (async function* () {
      for (const frame of scripted ?? [{ type: 'baseline', value: { items: [] } }]) yield frame
    })()
  }
}

/** Memory relay client: records calls, plays staged answers. */
function createFakeRelay() {
  const relay = {
    invokes: [],
    streams: [],
    invokeValue: { whatever: true },
    invokeThrow: undefined,
    streamFrames: [],
    streamThrow: undefined,
    invoke(namespace, method, args, signal) {
      relay.invokes.push({ namespace, method, args, signal })
      if (relay.invokeThrow) return Promise.reject(relay.invokeThrow)
      return Promise.resolve(relay.invokeValue)
    },
    openStream(namespace, method, args, signal) {
      relay.streams.push({ namespace, method, args, signal })
      return (async function* () {
        if (relay.streamThrow) throw relay.streamThrow
        for (const frame of relay.streamFrames) yield frame
      })()
    },
  }
  return relay
}

function makeLog() {
  const lines = []
  return { lines, log: (format, ...args) => lines.push([format, ...args]) }
}

function install(raw, relay, overrides = {}) {
  const logging = makeLog()
  const handle = installIntercept({
    raw,
    relay,
    getServerId: overrides.getServerId ?? (() => SERVER_ID),
    log: logging.log,
  })
  return { handle, ...logging }
}

async function drained(iterable) {
  const frames = []
  for await (const frame of iterable) frames.push(frame)
  return frames
}

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

test('a stream without virtual ids passes through verbatim, uplink included', async () => {
  const frames = [{ type: 'baseline', value: { items: [1, 2] } }, { type: 'order', workspaceIds: [] }]
  const gateway = new FakeTypertGateway({ stream: { 'workspace/follow': frames } })
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const uplink = { write() {} }
  const control = { signal: undefined }
  const iterable = gateway.wireTap('workspace/follow', { args: {} }, uplink, gateway.operatorPeer(), undefined, control)
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

test('a subagent address rewrites only parentSessionId', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const childId = 'session-child-original'
  const envelope = await gateway.rpcBridge('session/page', {
    args: { request: { address: { kind: 'subagent', parentSessionId: toVirtual(SERVER_ID, 'session-parent'), childSessionId: childId, mode: 'continuable' } } },
  }, undefined, undefined)
  assert.equal(envelope.ok, true)
  assert.equal(relay.invokes[0].args.request.address.parentSessionId, 'session-parent')
  assert.equal(relay.invokes[0].args.request.address.childSessionId, childId, 'the child id is already the server-side original')
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
    assert.equal(error.message, 'the session is not shared any more')
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
  const envelope = await gateway.rpcBridge('session/search', { args: { request: { query: 'x', sessionId: VIRTUAL_ID } } }, undefined, undefined)
  // `details: {}` is what the UI's server-response parser REQUIRES — a
  // details-less failure throws `invalid server-response failure` there.
  assert.deepEqual(envelope, { ok: false, error: { code: 'remote-unsupported', message: '此功能暂不支持远程会话', details: {} } })
  assert.equal(gateway.rpcCalls.length, 0, 'the local gateway never saw the virtual id')
  assert.equal(relay.invokes.length, 0)

  await assert.rejects(
    async () => gateway.wireTap('terminal/create', { args: { request: { agentId: VIRTUAL_ID } } }, undefined, undefined, undefined, { signal: undefined }),
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
  const mixed = await gateway.rpcBridge('session/search', { args: { request: { sessionId: VIRTUAL_ID, query: toVirtual('eeeeeeee', 'x') } } }, undefined, undefined)
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

test('CLIENT_METHOD_FIELDS is method-for-method and field-for-field identical to RELAY_METHODS', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay-access.js'), 'utf8')
  const serverTable = {}
  for (const [, endpoint, fieldsSrc] of source.matchAll(/^    '([a-zA-Z$/]+)': \{ fields: \[([^\]]*)\]/gm)) {
    serverTable[endpoint] = fieldsSrc
      .split(',')
      .map((raw) => raw.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
  }
  assert.ok(Object.keys(serverTable).length >= 20, `the regex still finds the server table (${Object.keys(serverTable).length} entries)`)
  assert.deepEqual(CLIENT_METHOD_FIELDS, serverTable)
})

// -- diagnostics -------------------------------------------------------------------

test('diagnostics reports the shape verdict, the self-check and the failure ring', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  handle.noteSelfCheck({ ok: true })
  await gateway.rpcBridge('session/search', { args: { request: { sessionId: VIRTUAL_ID } } }, undefined, undefined)
  await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: toVirtual('ffffffff', 's') } } } }, undefined, undefined)
  const diagnostics = handle.diagnostics()
  assert.equal(diagnostics.installed, true)
  assert.equal(diagnostics.shape.ok, true)
  assert.deepEqual(diagnostics.selfCheck, { ok: true })
  assert.deepEqual(diagnostics.recentFailures.map((f) => [f.endpoint, f.code]), [
    ['session/search', 'remote-unsupported'],
    ['session/page', 'remote-mismatch'],
  ])
  for (const failure of diagnostics.recentFailures) assert.match(failure.time, /^\d{4}-\d{2}-\d{2}T/)
  // The ring caps at 20.
  for (let i = 0; i < 25; i += 1) {
    await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: toVirtual('ffffffff', 's') } } } }, undefined, undefined)
  }
  assert.equal(handle.diagnostics().recentFailures.length, 20)
  // An envelope failure ALSO lands in the ring (a relay refusal is a remote
  // call failure like any other).
  relay.invokeThrow = new RelayError('not-shared')
  await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  const ring = handle.diagnostics().recentFailures
  assert.equal(ring[ring.length - 1].code, 'not-shared')
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

test('runSelfCheck passes when OTHER streams run concurrently (counter delta, not absolute)', async () => {
  const { gateway, handle } = makeSelfCheckTarget(undefined)
  // The UI opens its own local stream while the probe waits for its first
  // frame: the wrap counter rises by TWO, and an absolute === 1 check would
  // have uninstalled a perfectly healthy interception.
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
  const result = await runSelfCheck(gateway, { handle, retryDelayMs: 5 })
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
  const result = await runSelfCheck(gateway, { handle, retryDelayMs: 1 })
  assert.equal(result.ok, false)
  assert.match(result.reason, /bypassed the wrapper/)
  assert.equal(handle.diagnostics().installed, false, 'two failed runs uninstall')
  assert.equal(handle.diagnostics().selfCheck.ok, false)
})

test('runSelfCheck fault B: the first frame is not a baseline', async () => {
  // ONE fault only: the wrap IS reached (counter moves), but the first
  // frame answers `ready` on every attempt.
  const { gateway, handle } = makeSelfCheckTarget({ 'workspace/follow': [{ type: 'ready' }] })
  const result = await runSelfCheck(gateway, { handle, retryDelayMs: 1 })
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
  await new Promise((resolve) => setTimeout(resolve, 60))
  const settled = await serveOnce(registered, '/_dsh/zen-remote/client/status')
  assert.deepEqual(settled.intercept.selfCheck, { ok: true })

  // Disposal uninstalls: the recorded effect disposers include the intercept's.
  for (const disposer of effects) disposer()
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'dispatchRpc'), false)
})

test('the wiring uninstalls when the self-check fails (unreachable wrap)', async () => {
  // The shape looks perfect, but the wire adapter is closure-bound: it calls
  // the prototype method directly, so the wrap is never reached AND the
  // probe's first frame is not a baseline. The self-check must notice and
  // remove the interception.
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
  // The wiring retries once after 3s; both attempts fail on this gateway,
  // so the uninstall lands only after the retry.
  await new Promise((resolve) => setTimeout(resolve, 3_500))
  assert.equal(Object.prototype.hasOwnProperty.call(gateway, 'openWireStream'), false, 'a doubly failed self-check removes the wrap')
  const status = await serveOnce(registered, '/_dsh/zen-remote/client/status')
  assert.equal(status.intercept.installed, false)
  assert.equal(status.intercept.selfCheck.ok, false)
  for (const disposer of effects) disposer()
})
