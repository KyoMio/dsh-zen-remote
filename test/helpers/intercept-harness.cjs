'use strict'
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

const { installIntercept } = require('../../lib/intercept.js')
const { toVirtual, VIRTUAL_GROUP_NAME_MARK: MARK, encodeServerIdZeroWidth } = require('../../lib/virtual-id.js')
const { RelayError } = require('../../lib/relay-client.js')

const SERVER_ID = '721b94fb'
const LOCAL_ID = 'session-712828e2-492f-4ad1-8a88-ece10ecc4cc0'
const VIRTUAL_ID = toVirtual(SERVER_ID, LOCAL_ID)
// MS-4: a remote model group's heading opens with the server id's zero-width
// bit encoding (the bare legacy MARK is the no-server fallback shape).
const SERVER_MARK = encodeServerIdZeroWidth(SERVER_ID)

// DSH ≤0.2.2-alpha.2 per-key fields + the ≥alpha.3 one-entry `changes` list (dual shape).
const P = (frame) => ({ ...frame, changes: [{ key: frame.key, val: frame.value }] })

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
    // registers them — arrow functions over `this`. The wire tap forwards the
    // mux's uplink window verbatim (DSH 0.2.1-alpha.3+, 7th argument, named
    // `window` in the real source — checkGatewayShape pins the literal call
    // site) the way the real wire adapter does.
    this.rpcBridge = (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)
    this.wireTap = (endpoint, payload, uplink, peer, signal, control, window) =>
      this.openWireStream(endpoint, payload, uplink, peer, control.signal, control, window)
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
    openStream(namespace, method, args, signal, options) {
      // TA-2: the duplex stream options are recorded ONLY when present — the
      // one-directional assertions below compare the whole record with
      // deepEqual and must keep passing unchanged.
      relay.streams.push({ namespace, method, args, signal, ...(options !== undefined ? { options } : {}) })
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

/** A RelayClock whose only fake part is `now()` — the tombstone hide grace
 * (T65) is time-gated, and the tests need to cross it without real waiting.
 * The timers stay real. */
function clockWithFakeNow() {
  let nowMs = 1_700_000_000_000
  return {
    clock: {
      now: () => nowMs,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
      random: () => 0.5,
    },
    advance: (ms) => { nowMs += ms },
  }
}

function install(raw, relay, overrides = {}) {
  const logging = makeLog()
  const handle = installIntercept({
    raw,
    relay,
    getServerId: overrides.getServerId ?? (() => SERVER_ID),
    ...(overrides.getCurrentSession !== undefined ? { getCurrentSession: overrides.getCurrentSession } : {}),
    ...(overrides.clock !== undefined ? { clock: overrides.clock } : {}),
    ...(overrides.createSessionInventorySlot !== undefined ? { createSessionInventorySlot: overrides.createSessionInventorySlot } : {}),
    ...(overrides.lang !== undefined ? { lang: overrides.lang } : {}),
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
    finish: () => { pending.push({ kind: 'return' }); wake() },
    throwNow: (error) => { pending.push({ kind: 'throw', error }); wake() },
    get aborted() { return signal?.aborted === true },
  }
}

/**
 * TA-2: a stand-in for the host's UplinkInbox — an async iterable the test
 * pushes terminal commands into. It records whether the iterator's `return()`
 * was called, which is how releaseUplink half-closes a stream it decided not
 * to forward: the duplex attach test asserts the call is ABSENT, the refusal
 * tests assert it happened.
 */
function createFakeUplink() {
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
    end: () => { finished = true; wake() },
    get returnCalled() { return returnCalled },
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

async function waitForStream(relay, count, ms = 2000) {
  const start = Date.now()
  while (relay.streams.length < count) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${count} relay streams`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

const EVT = (id) => `evt-${id}`
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

async function waitUntil(predicate, ms = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

module.exports = {
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
}
