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
const { installIntercept, behaviorSelfCheck, runSelfCheck, CLIENT_METHOD_FIELDS, REMOTE_READ_METHODS, isRemoteWrite, rewriteRemoteEventFrame } = require('../lib/intercept.js')
const { toVirtual } = require('../lib/virtual-id.js')
const { encodeSessionReferenceUri, decodeSessionReferenceUri } = require('../lib/relay-server.js')
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
  // `async` like the host's real method (RT dsh-api-gateway: `async
  // openWireStream(...)`), so everything below it — the wire adapter's
  // open(), our wrap's passthrough return value — hands its caller a
  // Promise of the stream, exactly as production does.
  async openWireStream(endpoint, payload, uplink, peer, signal, control) {
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

/** Memory relay client: records calls, plays staged answers. Online with a
 * handshake by default — the T23b-2 merge routes read `state` /
 * `handshakeInfo` / `subscribe` exactly like the real client. */
function createFakeRelay() {
  const listeners = new Set()
  const relay = {
    invokes: [],
    streams: [],
    invokeValue: { whatever: true },
    // Per-method answers staged over `invokeValue` (T52-fix2): the catalog
    // fetch and the forwarded calls share one relay, and a test that needs
    // the cache filled must not clobber the value the forwarded call plays.
    invokeValues: {},
    invokeThrow: undefined,
    streamFrames: [],
    streamThrow: undefined,
    state: 'online',
    handshakeInfo: { relayProtocol: 1, serverId: SERVER_ID, serverName: '测试服务器', dshVersion: '0.0.0', fingerprints: {} },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    transition(state) {
      relay.state = state
      for (const listener of [...listeners]) listener(state)
    },
    invoke(namespace, method, args, signal) {
      relay.invokes.push({ namespace, method, args, signal })
      const staged = relay.invokeValues[`${namespace}/${method}`]
      if (staged !== undefined) return Promise.resolve(staged)
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
  // T52-fix3: installing into an already-online relay fires one proactive
  // session/modelCatalog fetch whose invoke lands in the recorder
  // SYNCHRONOUSLY (the .then only writes the cache later). Tests below
  // assert their OWN calls' records, so the install-time probe is wiped
  // here; the one test that asserts the probe itself drives
  // installIntercept directly.
  relay.invokes.length = 0
  return { handle, ...logging }
}

async function drained(iterable) {
  const frames = []
  // `await` first: the real openWireStream is async (the mux awaits it), so
  // callers may hand this helper either a promise of an iterable or a bare
  // one.
  for await (const frame of await iterable) frames.push(frame)
  return frames
}

// -- merged-global-stream helpers (T23b-2) ---------------------------------------

/**
 * One controllable stream leg: the test pushes frames, finishes it, throws,
 * and the generator honors its signal the way the real relay client does
 * (abort → the iteration ends normally).
 */
function createGate(signal) {
  const pending = []
  let wake = () => {}
  let finished = false
  const iterable = (async function* () {
    const onAbort = () => { finished = true; wake() }
    if (signal?.aborted) return
    signal?.addEventListener('abort', onAbort)
    try {
      while (true) {
        if (pending.length > 0) {
          const next = pending.shift()
          if (next.kind === 'frame') yield next.frame
          else if (next.kind === 'throw') throw next.error
          else return
        } else if (finished) {
          return
        } else {
          await new Promise((resolve) => { wake = resolve })
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  })()
  return {
    iterable,
    push: (frame) => { pending.push({ kind: 'frame', frame }); wake() },
    finish: () => { finished = true; wake() },
    throwNow: (error) => { pending.push({ kind: 'throw', error }); wake() },
    get aborted() { return signal?.aborted === true },
  }
}

/** A relay double whose openStream hands out INDEPENDENT controllable gates,
 * so tests can drive reconnects and identity changes gate by gate. */
function createControllableRelay(overrides = {}) {
  const listeners = new Set()
  const relay = {
    state: 'online',
    handshakeInfo: { relayProtocol: 1, serverId: SERVER_ID, serverName: '主服务器', dshVersion: '0.0.0', fingerprints: {} },
    invokes: [],
    streams: [],
    results: [],
    invokeValue: undefined,
    // Per-method answers staged over `invokeValue` (T52-fix2) — same shape
    // as createFakeRelay's.
    invokeValues: {},
    invokeThrow: undefined,
    resultValue: undefined,
    resultThrow: undefined,
    invoke(namespace, method, args, signal) {
      relay.invokes.push({ namespace, method, args, signal })
      const staged = relay.invokeValues[`${namespace}/${method}`]
      if (staged !== undefined) return Promise.resolve(staged)
      if (relay.invokeThrow) return Promise.reject(relay.invokeThrow)
      return Promise.resolve(relay.invokeValue)
    },
    postEventResult(eventId, result, signal) {
      relay.results.push({ eventId, result, signal })
      if (relay.resultThrow) return Promise.reject(relay.resultThrow)
      return Promise.resolve(relay.resultValue)
    },
    openStream(namespace, method, args, signal) {
      const gate = createGate(signal)
      const record = { namespace, method, args, gate, get aborted() { return signal?.aborted === true } }
      relay.streams.push(record)
      return gate.iterable
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    transition(state) {
      relay.state = state
      for (const listener of [...listeners]) listener(state)
    },
    ...overrides,
  }
  return relay
}

/** A fake gateway whose LOCAL stream for the merge tests is one controllable
 * gate (the scripted generator would end the merged stream immediately). */
function createMergeGateway(signal) {
  const gateway = new FakeTypertGateway()
  const localGate = createGate(signal)
  gateway.openWireStream = async function (endpoint, payload, uplink, peer, legSignal, control) {
    gateway.streamCalls.push({ endpoint, payload, uplink, peer, signal: legSignal, control })
    return localGate.iterable
  }
  return { gateway, localGate }
}

/** Read exactly `count` frames, failing loudly on a stall (the merged pumps
 * are promise-driven; a lost frame would otherwise hang the test). */
async function readSome(iterator, count, ms = 2000) {
  const frames = []
  for (let i = 0; i < count; i += 1) {
    let timer
    const result = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for merged frame ${frames.length + 1}/${count}`)), ms)
      }),
    ]).finally(() => clearTimeout(timer))
    if (result.done) throw new Error(`merged stream ended after ${frames.length} of ${count} frames`)
    frames.push(result.value)
  }
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
    async () => gateway.wireTap('goals/create', { args: { agentId: VIRTUAL_ID, request: { objective: 'x', maxGoalRounds: 1 } } }, undefined, undefined, undefined, { signal: undefined }),
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

// -- 7b. the global merge route (T23b-2) ---------------------------------------------

const LOCAL_WS = {
  workspaceId: 'ws-local',
  path: '/home/me/local',
  title: '本地',
  sessionIds: ['session-l1'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}
const LOCAL_BASELINE = { type: 'baseline', value: { items: [LOCAL_WS], archivedSessionIds: [], pinnedSessionIds: [] } }
function remoteWorkspace(id, title, sessionIds) {
  return {
    workspaceId: id,
    path: `/srv/${id}`,
    title,
    sessionIds,
    createdAt: '2026-02-02T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
  }
}
const REMOTE_BASELINE = {
  type: 'baseline',
  value: {
    items: [remoteWorkspace('w-1', '远端一', ['session-a', 'session-b']), remoteWorkspace('w-2', '远端二', ['session-c'])],
    archivedSessionIds: ['session-b'],
    pinnedSessionIds: [],
  },
}

/**
 * The real `ClientWorkspaceModel` (same loader as test/merge-streams.test.cjs:
 * the devDep's browser-style bundle executed through a shimmed
 * `window.__ModuleLoader__`), used to prove the revocation/re-pair lifecycle
 * against the model whose never-cleared `removedIds` blacklist is the whole
 * reason a revoke may not emit removes (T23b2-fix3). Loaded lazily so the
 * global `window` shim only exists while these tests actually run.
 */
let workspaceClient
function createUiModel() {
  if (workspaceClient === undefined) {
    let mod
    global.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => ({ isRemoteFailure: () => true, Service: class {}, RemoteSnapshotStream: class {} })) } } }
    require(require.resolve('@deepseek-ai/dsh-api-workspace-controller/client'))
    if (typeof mod?.ClientWorkspaceModel !== 'function') {
      throw new Error('dsh-api-workspace-controller/client did not export ClientWorkspaceModel')
    }
    workspaceClient = mod
  }
  const model = new workspaceClient.ClientWorkspaceModel({})
  const apply = (frame) => {
    if (frame.type === 'baseline') model.replaceBaseline(frame.value)
    else if (frame.type === 'upsert') model.upsertView(frame.workspace)
    else if (frame.type === 'remove') model.removeView(frame.workspaceId)
    else if (frame.type === 'order') model.replaceOrder(frame.workspaceIds)
    else if (frame.type === 'archived') model.replaceArchived(frame.archivedSessionIds)
    else model.replacePinned(frame.pinnedSessionIds)
  }
  return { model, apply, ids: () => model.items.map((item) => item.workspaceId).join(',') }
}

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
  await new Promise((resolve) => setTimeout(resolve, 20))
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
  await new Promise((resolve) => setTimeout(resolve, 20))
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
  await new Promise((resolve) => setTimeout(resolve, 50))
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
    await new Promise((resolve) => setTimeout(resolve, 50))
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

async function waitForStream(relay, count, ms = 2000) {
  const start = Date.now()
  while (relay.streams.length < count) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${count} relay streams`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

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
    { type: 'projection', sessionId: toVirtual(SERVER_ID, 'session-a'), key: 'title', value: '远端', seq: 7 },
    { type: 'projection', sessionId: toVirtual(SERVER_ID, 'session-a'), key: 'todos', value: [], seq: 7 },
  ])
  relay.streams[0].gate.push({ type: 'projection', sessionId: 'session-a', key: 'title', value: '改名', seq: 8 })
  assert.deepEqual(await readSome(iterator, 1), [
    { type: 'projection', sessionId: toVirtual(SERVER_ID, 'session-a'), key: 'title', value: '改名', seq: 8 },
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
  // T41a: the NEW field types are compared too — string equality would hide a
  // typo only if both sides misspelled it the same way, so pin the shapes the
  // registry grew by name.
  assert.deepEqual(serverTable['terminal/create'], ['agentId'])
  assert.deepEqual(serverTable['terminal/list'], ['sessionId'])
  assert.deepEqual(serverTable['terminal/retain'], ['sessionId'])
  assert.deepEqual(serverTable['workspaceFiles/list'], ['workspaceFileScopeId'])
  assert.deepEqual(serverTable['sessionFeedback/record'], ['request.sessionId'])
  assert.deepEqual(serverTable['subagents/prompt'], ['request.parentSessionId', 'request.childSessionId'])
  assert.deepEqual(serverTable['subagents/interruptByParent'], ['parentSessionId', 'childSessionId'])
  // Every field either table names is one of the known field types — a typo
  // on either side fails here instead of silently matching itself.
  const KNOWN = new Set([
    'request.sessionId', 'request.address', 'request.parentSessionId', 'request.childSessionId', 'request.workspaceId',
    'parentSessionId', 'childSessionId', 'sessionId', 'workspaceFileScopeId', 'agentId',
  ])
  for (const fields of Object.values(serverTable)) {
    for (const field of fields) assert.ok(KNOWN.has(field), `unknown field type: ${field}`)
  }
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
  // call failure like any other) — and its envelope carries the host-mandated
  // `details` object: dsh-client-connection refuses a failure without one, so
  // the forwardInvoke catch branch must not skip it.
  relay.invokeThrow = new RelayError('not-shared')
  const thrown = await gateway.rpcBridge('session/page', { args: { request: { address: { kind: 'session', sessionId: VIRTUAL_ID } } } }, undefined, undefined)
  assert.equal(thrown.ok, false)
  assert.deepEqual(thrown.error.details, {}, 'the catch-branch envelope carries details: {}')
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
    await new Promise((resolve) => setTimeout(resolve, 5))
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
  // row is unpaired → remote-offline, T51-fix's 200 contract); a local id
  // reaches the original route untouched.
  const virtual = toVirtual(SERVER_ID, LOCAL_ID)
  const refused = await connection.routes.get(FILE_UPLOAD_PATH).fetch(uploadRequestOf(virtual))
  assert.equal(refused.status, 200)
  assert.equal((await refused.json()).error.code, 'remote-offline')
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
  localGate.push(LOCAL_BASELINE)
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
    { type: 'order', workspaceIds: ['ws-local', toVirtual(SERVER_ID, 'w-1'), toVirtual(SERVER_ID, 'w-2')] },
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
  localGate.push(LOCAL_BASELINE)
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
  localGate.push(LOCAL_BASELINE)
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
    const id = toVirtual(SERVER_ID, `session-${i}`)
    relay.streamFrames = []
    relay.streamThrow = new RelayError('unshared', 'closed', undefined, 'idle')
    await assert.rejects(
      drained(gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: id } } } }, undefined, undefined, undefined, { signal: undefined })),
      (error) => error.code === 'unshared',
    )
  }
  const closed = handle.diagnostics().closedSessions
  assert.equal(closed.length, 200)
  assert.equal(closed[0].sessionId, toVirtual(SERVER_ID, 'session-5'), 'the oldest entries were evicted')
  assert.equal(closed[199].sessionId, toVirtual(SERVER_ID, 'session-204'))
  handle.uninstall()
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
  assert.deepEqual(envelope.value, { sessionId: toVirtual(SERVER_ID, 'session-fresh'), agentPreset: 'default' }, 'the minted id travels virtualized')
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
  const envelope = await gateway.rpcBridge('goals/create', { args: { agentId: VIRTUAL_ID, request: { objective: 'x', maxGoalRounds: 1 } } }, undefined, undefined)
  assert.deepEqual(envelope, { ok: false, error: { code: 'remote-unsupported', message: '此功能暂不支持远程会话', details: {} } })
  assert.equal(relay.invokes.length, 0)
  assert.equal(gateway.rpcCalls.length, 0)
  handle.uninstall()
})

// -- T32: the forwarded-event frames -------------------------------------------------

const EVT = (id) => `evt-${id}`

test('rewriteRemoteEventFrame: waterfall ids go virtual in place, cancel matches, ready and emit drop', () => {
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
  // Emit frames are dropped outright (T32-fix): server-wide state the UI
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
})

// -- T32: the merged $events stream ---------------------------------------------------

const READY = { type: 'ready', clientId: 'local-stream-client', host: { home: '/local/home' } }
const LOCAL_WATERFALL = {
  type: 'waterfall',
  event: 'user-questions/request',
  eventId: 'evt-local-1',
  agentId: 'session-local',
  request: { questions: [{ id: 'q1' }] },
}
const SERVER_WATERFALL = {
  type: 'waterfall',
  event: 'approval/request',
  // The server tokenizes eventIds (`<token>.<original>`); the client treats
  // that as opaque and wraps the whole string.
  eventId: 'a1b2c3d4e5f60718.evt-remote-1',
  agentId: LOCAL_ID,
  request: { toolName: 'Bash', callId: 'c2' },
}
const V_REMOTE_EVENT = toVirtual(SERVER_ID, 'a1b2c3d4e5f60718.evt-remote-1')

async function openMergedEvents(relay, overrides = {}) {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const { handle, log } = install(gateway, relay, overrides)
  const merged = await gateway.wireTap('$events', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal })
  return { controller, gateway, localGate, handle, log, merged, iterator: merged[Symbol.asyncIterator]() }
}

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

  // Tearing the UI's stream down ends the merged stream and both legs.
  controller.abort()
  const done = await iterator.next()
  assert.equal(done.done, true)
  assert.equal(localGate.aborted, true, 'the local stream observed the teardown')
})

/** Poll until the predicate holds; times out loud (the merged pumps are
 * promise-driven, a lost wake would otherwise hang the test). Named apart
 * from waitForStream, which waits for a COUNT of relay streams. */
async function waitUntil(predicate, ms = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

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
  await new Promise((resolve) => setTimeout(resolve, 50))
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
    { args: { clientId: 'c', eventId: toVirtual(SERVER_ID, 'evt-x'), outcome: { kind: 'next' } } },
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
      { args: { clientId: 'c', eventId: toVirtual(SERVER_ID, 'evt-gone'), outcome: { kind: 'next' } } },
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
    { args: { clientId: 'c', eventId: toVirtual(SERVER_ID, 'evt-gone'), outcome: { kind: 'next' } } },
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
    { args: { clientId: 'c', eventId: toVirtual(SERVER_ID, 'evt-gone'), outcome: { kind: 'next' } } },
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
  await new Promise((resolve) => setTimeout(resolve, 50))
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
    name: '测试服务器 · Codex',
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
    name: '测试服务器 · Codex',
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
  console.error('[dbg] before second-outage readSome')
  relay.streams[0].gate.push(SERVER_WATERFALL)
  const [second, waterfall] = await readSome(iterator, 2)
  console.error('[dbg] after second-outage readSome')
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
  await gateway.rpcBridge('agentPresets/select', { args: { agentId: VIRTUAL_ID, agentPreset: 'default' } }, undefined, undefined)
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

// -- T34-fix: annotation restore semantics, read-whitelist guard, offline answers ----

test('T34-fix: a version mismatch survives an offline round trip (PROBE1) — the reopened baseline keeps the annotation', async () => {
  const controller = new AbortController()
  const { gateway, localGate } = createMergeGateway(controller.signal)
  const relay = createControllableRelay({ compat: { identical: ['session'], different: ['workspace'], unavailable: [] } })
  const { handle } = install(gateway, relay)
  const iterator = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), controller.signal, { signal: controller.signal }))[Symbol.asyncIterator]()
  localGate.push(LOCAL_BASELINE)
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
  localGate.push(LOCAL_BASELINE)
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
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(relay.streams.length, 1, 'no reopen — the leg never died')
  // and the stream keeps flowing merged under the plain titles
  localGate.push({ type: 'order', workspaceIds: ['ws-local'] })
  assert.deepEqual(await readSome(iterator, 1), [
    { type: 'order', workspaceIds: ['ws-local', toVirtual(SERVER_ID, 'w-1'), toVirtual(SERVER_ID, 'w-2')] },
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
    'fileUploads/upload',
    'job/kill',
    'messageFeedback/put',
    'messageFeedback/delete',
    'workspace/pinSession',
    'workspace/unpinSession',
    'workspace/archiveSession',
    'workspace/unarchiveSession',
    // T41a mutations
    'goals/edit',
    'goals/pause',
    'goals/resume',
    'goals/clear',
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
  ])
  for (const endpoint of Object.keys(CLIENT_METHOD_FIELDS)) {
    assert.ok(
      REMOTE_READ_METHODS.has(endpoint) || writes.has(endpoint),
      `${endpoint} must be classified read or write`,
    )
  }
  // T31's five mutations are writes — refused remote-offline while offline.
  for (const endpoint of ['session/create', 'session/fork', 'subagents/prompt', 'subagents/interruptByParent', 'fileUploads/upload']) {
    assert.equal(isRemoteWrite(endpoint), true, endpoint)
  }
  // spot-check the read side (the full list lives in the source comment)
  for (const endpoint of ['session/page', 'session/attachment', 'session/list', 'fileReferences/list', 'job/list', 'workspace/follow']) {
    assert.equal(isRemoteWrite(endpoint), false, endpoint)
  }
})

test('T34-fix: the T31 writes are refused remote-offline while the relay is not online', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  relay.transition('offline')
  const writes = [
    ['session/create', { args: { request: { workspaceId: toVirtual(SERVER_ID, 'w-1'), title: 'x' } } }],
    ['session/fork', { args: { request: { sessionId: VIRTUAL_ID } } }],
    ['subagents/prompt', { args: { request: { parentSessionId: VIRTUAL_ID, content: [{ type: 'text', text: 'hi' }] } } }],
    ['subagents/interruptByParent', { args: { parentSessionId: VIRTUAL_ID } }],
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
  const payload = { args: { eventId: toVirtual(SERVER_ID, 'tok-1.e-9'), outcome: { kind: 'next' } } }
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
  await new Promise((resolve) => setTimeout(resolve, 20))
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
  await new Promise((resolve) => setTimeout(resolve, 20))
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
  localGate.push(LOCAL_BASELINE)
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
  localGate.push(LOCAL_BASELINE)
  ;(await readSome(iterator, 1)).forEach(ui.apply)
  relay.streams[0].gate.push(REMOTE_BASELINE)
  ;(await readSome(iterator, 5)).forEach(ui.apply)
  const vA = toVirtual(SERVER_ID, 'session-a')
  const vB = toVirtual(SERVER_ID, 'session-b')
  const w1 = () => ui.model.items.find((item) => item.workspaceId === toVirtual(SERVER_ID, 'w-1'))
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
  await new Promise((resolve) => setTimeout(resolve, 20))
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
  await new Promise((resolve) => setTimeout(resolve, 20))
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
  await new Promise((resolve) => setTimeout(resolve, 20))
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
  await new Promise((resolve) => setTimeout(resolve, 20))
  relay.transition('unpaired')
  assert.equal(await second.outcome, 'threw:unpaired', 'unpaired ends the hold the same way')
  handle.uninstall()
})

/** A manual clock for the session-stream backoff: `advance` moves time and
 * fires due timers synchronously (same shape as the recovery file's). */
function fakeClock() {
  let now = 1_700_000_000_000
  const timers = []
  return {
    now: () => now,
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

test('CP5: waitServeAgain backs off the in-place reopen — state stays online, every retry costs the current step and the step doubles', async () => {
  const relay = createControllableRelay()
  const gateway = new FakeTypertGateway()
  const clock = fakeClock()
  const handle = installIntercept({ raw: gateway, relay, getServerId: () => SERVER_ID, clock })
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
    await new Promise((resolve) => setTimeout(resolve, 20))
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
  const leakedOld = toVirtual(SERVER_ID, 'a1b2c3d4e5f60718.evt-remote-2')
  const leakedNew = toVirtual('ffffffff', 'a1b2c3d4e5f60718.evt-remote-2')
  assert.ok(
    frames.every((frame) => frame.eventId !== leakedOld && frame.eventId !== leakedNew),
    'the decoded-but-dead waterfall never reached the UI — under either server id',
  )
  await iterator.return?.(undefined)
})
