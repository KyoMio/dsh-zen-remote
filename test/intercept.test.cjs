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
const { installIntercept, behaviorSelfCheck, runSelfCheck, CLIENT_METHOD_FIELDS, rewriteRemoteEventFrame } = require('../lib/intercept.js')
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
    invokeThrow: undefined,
    resultValue: undefined,
    resultThrow: undefined,
    invoke(namespace, method, args, signal) {
      relay.invokes.push({ namespace, method, args, signal })
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

  // relay back online → the remote leg reopens and the new baseline DIFFS
  // against the shown set: same content → upserts only, no removes
  relay.transition('online')
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

  // re-paired to the SAME server id: the leg reopens and the new baseline
  // diffs against the kept state — content refresh (upserts only, no
  // removes) — and the REAL model ends up holding the remote groups with the
  // NEW baseline's content.
  relay.transition('online')
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
  relay.invokeValue = { items: [{ sessionId: 'session-a', updatedAt: 2 }, { sessionId: 'session-b', updatedAt: 3 }] }
  const { handle } = install(gateway, relay)

  // first page, online: local items first, remote items virtualized after,
  // the pagination field comes from the LOCAL result
  const merged = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, gateway.operatorPeer())
  assert.deepEqual(merged, {
    ok: true,
    value: {
      items: [
        { sessionId: 'session-local', updatedAt: 1 },
        { sessionId: toVirtual(SERVER_ID, 'session-a'), updatedAt: 2 },
        { sessionId: toVirtual(SERVER_ID, 'session-b'), updatedAt: 3 },
      ],
      nextCursor: 'tok',
    },
  })
  assert.deepEqual(relay.invokes, [{ namespace: 'session', method: 'list', args: { _request: {} }, signal: undefined }])

  // a paged request never touches the relay
  const paged = await gateway.rpcBridge('session/list', { args: { _request: { cursor: 'tok' } } }, undefined, undefined)
  assert.deepEqual(paged.value.items, [{ sessionId: 'session-local', updatedAt: 1 }])
  assert.equal(relay.invokes.length, 1)

  // a remote failure degrades to the local answer and is recorded
  relay.invokeThrow = new RelayError('offline', 'down')
  const degraded = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, undefined)
  assert.deepEqual(degraded.value.items, [{ sessionId: 'session-local', updatedAt: 1 }])
  const ring = handle.diagnostics().recentFailures
  assert.deepEqual([ring[ring.length - 1].endpoint, ring[ring.length - 1].code], ['session/list', 'offline'])
  assert.equal(relay.invokes.length, 2)

  // offline: no relay round-trip at all
  relay.transition('offline')
  const offline = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, undefined)
  assert.deepEqual(offline.value.items, [{ sessionId: 'session-local', updatedAt: 1 }])
  assert.equal(relay.invokes.length, 2)

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

  // back online: the annotation clears SILENTLY (no premature all-clear);
  // the reopened leg's baseline is what restores the plain titles
  relay.transition('online')
  await waitForStream(relay, 2)
  relay.streams[1].gate.push(REMOTE_BASELINE)
  const restored = await readSome(iterator, 5)
  assert.equal(restored[0].workspace.title, '主服务器 · 远端一')
  assert.ok(restored.every((frame) => !(frame.workspace?.title ?? '').includes('（离线）')))
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

  // register two, then a relay return to online clears wholesale
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
  assert.deepEqual(handle.diagnostics().closedSessions, [], 'the reconnect cleared the registry')
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

test('subagents calls rewrite only the parent slot (request envelope and top level alike)', async () => {
  const gateway = new FakeTypertGateway()
  const relay = createFakeRelay()
  const { handle } = install(gateway, relay)
  const childId = 'session-child-original'

  await gateway.rpcBridge('subagents/prompt', {
    args: { request: { requestId: 'r1', parentSessionId: toVirtual(SERVER_ID, 'session-parent'), childSessionId: childId, mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: 'hi' }] } },
  }, undefined, undefined)
  assert.deepEqual(relay.invokes[0].args.request, {
    requestId: 'r1',
    parentSessionId: 'session-parent',
    childSessionId: childId,
    mode: 'continuable',
    delivery: 'queue',
    content: [{ type: 'text', text: 'hi' }],
  }, 'the parent id is restored; the child id is already the server-side original')

  await gateway.rpcBridge('subagents/interruptByParent', {
    args: { childSessionId: childId, parentSessionId: toVirtual(SERVER_ID, 'session-parent'), mode: 'continuable' },
  }, undefined, undefined)
  assert.deepEqual(relay.invokes[1].args, { childSessionId: childId, parentSessionId: 'session-parent', mode: 'continuable' }, 'the TOP-LEVEL parent slot is restored')
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
  // A frame missing its ids stays a valid frame of the same shape.
  assert.deepEqual(rewriteRemoteEventFrame({ type: 'waterfall', event: 'e', eventId: 3, agentId: 4, request: {} }, SERVER_ID), {
    type: 'waterfall',
    event: 'e',
    eventId: 3,
    agentId: 4,
    request: {},
  })
  assert.deepEqual(rewriteRemoteEventFrame('junk', SERVER_ID), 'junk')
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
  relay.transition('online')
  await waitForStream(relay, 2)
  relay.streams[1].gate.push(SERVER_WATERFALL)
  const [waterfall] = await readSome(iterator, 1)
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
  const [again] = await readSome(iterator, 1)
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
  // The cut leg closes the prompt it showed BEFORE the new leg speaks.
  const [orphanCancel, frame] = await readSome(iterator, 2)
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

  const offline = new FakeTypertGateway()
  const offlineRelay = createControllableRelay()
  const offlineInstall = install(offline, offlineRelay, { getServerId: () => undefined })
  const refused = await offline.rpcBridge(
    '$events/result',
    { args: { clientId: 'c', eventId: toVirtual(SERVER_ID, 'evt-x'), outcome: { kind: 'next' } } },
    undefined,
    undefined,
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'remote-offline')
  assert.deepEqual(refused.error.details, {})
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
  // record): the prompt legitimately comes back.
  relay.transition('online')
  await waitForStream(relay, 2)
  relay.streams[1].gate.push(SERVER_WATERFALL)
  const [again] = await readSome(iterator, 1)
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
  // Prove liveness and the absence of a second cancel with a local frame.
  localGate.push(LOCAL_WATERFALL)
  const [local] = await readSome(iterator, 1)
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
