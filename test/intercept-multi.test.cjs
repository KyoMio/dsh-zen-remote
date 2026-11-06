/* dsh-zen-remote · multi-server intercept routing (src/intercept.ts, MS-3)
 *
 * The POOL half of installIntercept: two fake relay clients behind a fake
 * pool, exercising the per-serverId routing of single calls and session
 * streams, the multi-server merge of the three global reads + modelCatalog,
 * and the per-server pending-event cancel discipline of the merged $events
 * stream. The single-relay behavior stays pinned by intercept.test.cjs —
 * this file only drives `pool:`, and the two must never disagree about the
 * wire shapes.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { installIntercept } = require('../lib/intercept.js')
const { toVirtual, VIRTUAL_GROUP_NAME_MARK: MARK, encodeServerIdZeroWidth } = require('../lib/virtual-id.js')
const { RelayError } = require('../lib/relay-client.js')

const SID_A = 'aaa11111'
const SID_B = 'bbb22222'
const VA = (id) => toVirtual(SID_A, id)
const VB = (id) => toVirtual(SID_B, id)
// MS-4: a remote model group's heading carries the server id's 32 zero-width
// bits between two marks, BEFORE the display name — the browser half reads
// the server back out of the heading text alone.
const MARK_A = encodeServerIdZeroWidth(SID_A)
const MARK_B = encodeServerIdZeroWidth(SID_B)

// -- the fakes (mirrors of intercept.test.cjs's) --------------------------------

class FakeTypertGateway {
  constructor(spec = {}) {
    this.spec = spec
    this.rpcCalls = []
    this.streamCalls = []
    this.wireStream = {
      open: (endpoint, payload, uplink, peer, signal) => this.openWireStream(endpoint, payload, uplink, peer, signal, { signal }),
    }
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

/** A controllable stream leg: the test pushes frames, finishes it, throws,
 * and the generator honors its signal like the real relay client does. */
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

/** One fake relay client per pooled server: online with a handshake by
 * default, records every invoke/openStream/postEventResult, hands out
 * independent controllable gates per openStream. */
function createMultiRelay(serverId, overrides = {}) {
  const listeners = new Set()
  const relay = {
    serverId,
    state: 'online',
    compat: undefined,
    handshakeInfo: { relayProtocol: 1, serverId, serverName: 'server', dshVersion: '0.0.0', fingerprints: {} },
    invokes: [],
    streams: [],
    results: [],
    invokeValues: {},
    invokeThrow: undefined,
    resultValue: undefined,
    resultThrow: undefined,
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
      return Promise.resolve({ whatever: true })
    },
    postEventResult(eventId, result, signal) {
      relay.results.push({ eventId, result, signal })
      if (relay.resultThrow) return Promise.reject(relay.resultThrow)
      return Promise.resolve(relay.resultValue)
    },
    openStream(namespace, method, args, signal) {
      const gate = createGate(signal)
      relay.streams.push({ namespace, method, args, gate, get aborted() { return signal?.aborted === true } })
      return gate.iterable
    },
    ...overrides,
  }
  return relay
}

/** A hand-rolled pool double: the test controls the pairing order and the
 * display names (already derived — deriveDisplayServerNames itself is
 * pinned by relay-pool.test.cjs), plus add/remove + a change broadcast. */
function createFakePool(initial = []) {
  const views = [...initial]
  return {
    entries: () => views.map((view) => ({ ...view })),
    getByServerId(serverId) {
      const found = views.find((view) => view.serverId === serverId)
      return found === undefined ? undefined : { ...found }
    },
    add(view) { views.push(view) },
    remove(entryId) {
      const index = views.findIndex((view) => view.entryId === entryId)
      if (index >= 0) views.splice(index, 1)
    },
    views,
  }
}

function makeEntry(serverId, displayName, client) {
  return {
    entryId: `entry-${serverId ?? Math.random().toString(16).slice(2, 10)}`,
    serverUrl: `http://${serverId ?? 'pending'}.test:3088`,
    serverId,
    serverName: displayName,
    displayName,
    client,
    createdAt: 1_700_000_000_000,
  }
}

function makeLog() {
  const lines = []
  return { lines, log: (format, ...args) => lines.push([format, ...args]) }
}

function installPool(raw, pool, overrides = {}) {
  const logging = makeLog()
  const handle = installIntercept({
    raw,
    pool,
    ...(overrides.getCurrentSession !== undefined ? { getCurrentSession: overrides.getCurrentSession } : {}),
    ...(overrides.clock !== undefined ? { clock: overrides.clock } : {}),
    ...(overrides.createSessionInventorySlot !== undefined ? { createSessionInventorySlot: overrides.createSessionInventorySlot } : {}),
    log: logging.log,
  })
  // The pool-mode install fires one proactive modelCatalog fetch per
  // already-online entry; tests assert their OWN calls' records.
  for (const entry of pool.entries()) entry.client.invokes.length = 0
  return { handle, ...logging }
}

/** The gateway for the merged-stream tests: the LOCAL stream is one
 * controllable gate, so the test drives the local side frame by frame. */
function createMergeGateway() {
  const gateway = new FakeTypertGateway()
  const localGate = createGate(undefined)
  gateway.openWireStream = async function (endpoint, payload, uplink, peer, legSignal, control) {
    gateway.streamCalls.push({ endpoint, payload, uplink, peer, signal: legSignal, control })
    return localGate.iterable
  }
  return { gateway, localGate }
}

/** Read exactly `count` frames, failing loudly on a stall. */
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

/** Let the fire-and-forget pumps settle a few microtask turns. */
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function bothRelays() {
  return { relayA: createMultiRelay(SID_A), relayB: createMultiRelay(SID_B) }
}

function bothPool(relayA, relayB) {
  return createFakePool([makeEntry(SID_A, 'MacBook-1', relayA), makeEntry(SID_B, 'MacBook-2', relayB)])
}

// -- 1. single-call routing ------------------------------------------------------

test('MS-3 routing: an invoke on server A\'s session travels only through A\'s client, restored and rewritten for A', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const gateway = new FakeTypertGateway()
  const { handle } = installPool(gateway, pool)
  const envelope = await gateway.rpcBridge(
    'session/cancel',
    { args: { request: { sessionId: VA('session-x') } } },
    undefined,
    gateway.operatorPeer(),
  )
  assert.equal(relayA.invokes.length, 1, 'A\'s client served the call')
  assert.equal(relayB.invokes.length, 0, 'B\'s client never saw A\'s call')
  assert.deepEqual(relayA.invokes[0].args, { request: { sessionId: 'session-x' } }, 'the id traveled restored')
  assert.deepEqual(envelope, { ok: true, value: { whatever: true } })
  handle.uninstall()
})

test('MS-3 routing: a call carrying two servers\' virtual ids refuses remote-mismatch, neither client is touched', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const gateway = new FakeTypertGateway()
  const { handle } = installPool(gateway, pool)
  const envelope = await gateway.rpcBridge(
    'subagents/prompt',
    { args: { request: { parentSessionId: VA('p1'), childSessionId: VB('c1') } } },
    undefined,
    gateway.operatorPeer(),
  )
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'remote-mismatch')
  assert.equal(relayA.invokes.length, 0)
  assert.equal(relayB.invokes.length, 0)
  handle.uninstall()
})

test('MS-3 routing: an empty pool and a pool of never-handshook entries both answer remote-offline', async () => {
  const gateway = new FakeTypertGateway()
  const empty = installPool(gateway, createFakePool([]))
  let envelope = await gateway.rpcBridge('session/cancel', { args: { request: { sessionId: VA('s') } } }, undefined, gateway.operatorPeer())
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'remote-offline')
  empty.handle.uninstall()

  const pendingClient = createMultiRelay(SID_A)
  const neverHandshook = createFakePool([makeEntry(undefined, 'pending', pendingClient)])
  const offline = installPool(gateway, neverHandshook)
  envelope = await gateway.rpcBridge('session/cancel', { args: { request: { sessionId: VA('s') } } }, undefined, gateway.operatorPeer())
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'remote-offline', 'no handshook server in the pool — the honest offline answer')
  assert.equal(pendingClient.invokes.length, 0)
  offline.handle.uninstall()
})

test('MS-3 routing: a handshook pool without the target server answers remote-mismatch', async () => {
  const { relayA } = bothRelays()
  const pool = createFakePool([makeEntry(SID_A, 'MacBook-1', relayA)])
  const gateway = new FakeTypertGateway()
  const { handle } = installPool(gateway, pool)
  const envelope = await gateway.rpcBridge('session/cancel', { args: { request: { sessionId: VB('s') } } }, undefined, gateway.operatorPeer())
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'remote-mismatch', 'the id names a server this pool does not serve')
  assert.equal(relayA.invokes.length, 0)
  handle.uninstall()
})

test('MS-3 routing: a WRITE whose target leg is offline refuses remote-offline without traveling', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const gateway = new FakeTypertGateway()
  const { handle } = installPool(gateway, pool)
  relayB.transition('offline')
  const envelope = await gateway.rpcBridge('session/cancel', { args: { request: { sessionId: VB('s') } } }, undefined, gateway.operatorPeer())
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'remote-offline')
  assert.equal(relayB.invokes.length, 0)
  handle.uninstall()
})

test('MS-3 routing: $events/result routes by the eventId\'s serverId; a missing leg answers the stale-result silent ok', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const gateway = new FakeTypertGateway()
  const { handle } = installPool(gateway, pool)
  const outcome = { ok: true, value: undefined }
  const envelope = await gateway.rpcBridge('$events/result', { args: { eventId: VB('tok.e1'), outcome } }, undefined, gateway.operatorPeer())
  assert.equal(relayB.results.length, 1, 'B\'s client answered the event')
  assert.deepEqual(relayB.results[0].eventId, 'tok.e1', 'the id traveled restored')
  assert.deepEqual(relayB.results[0].result, outcome)
  assert.equal(relayA.results.length, 0)
  assert.deepEqual(envelope, { ok: true, value: undefined })

  // The server left the pool: nothing can settle its events anymore — the
  // stale-result silent ok, never a refusal envelope (that would restart
  // the UI's whole $events generation).
  pool.remove(`entry-${SID_B}`)
  handle.notePoolEvent()
  const late = await gateway.rpcBridge('$events/result', { args: { eventId: VB('tok.e2'), outcome } }, undefined, gateway.operatorPeer())
  assert.deepEqual(late, { ok: true, value: undefined }, 'a removed leg answers silent ok')
  assert.equal(relayB.results.length, 1, 'and nothing traveled')
  handle.uninstall()
})

// -- 2. session-stream routing ---------------------------------------------------

test('MS-3 routing: a session/follow on server B\'s session opens on B\'s client with B-rewritten frames', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const gateway = new FakeTypertGateway()
  const { handle } = installPool(gateway, pool)
  const control = { signal: undefined }
  const iterable = gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VB('s1'), assistantStream: true } } } },
    undefined,
    undefined,
    undefined,
    control,
  )
  await settle()
  assert.equal(relayB.streams.length, 1, 'B\'s client opened the stream')
  assert.equal(relayA.streams.length, 0, 'A\'s client was never touched')
  assert.deepEqual(relayB.streams[0].args.request.address.sessionId, 's1', 'the address traveled restored')
  relayB.streams[0].gate.push({ type: 'snapshot', header: { id: 's1' } })
  const iterator = (await iterable)[Symbol.asyncIterator]()
  const frames = await readSome(iterator, 1)
  assert.deepEqual(frames[0].header.id, VB('s1'), 'the snapshot id came back virtualized for B')
  await iterator.return?.(undefined)
  handle.uninstall()
})

// -- 3. workspace/follow multi-merge ----------------------------------------------

function workspaceBaseline(workspaceId, title, sessionIds) {
  return { type: 'baseline', value: { items: [{ workspaceId, title, sessionIds }], archivedSessionIds: [], pinnedSessionIds: [] } }
}

test('MS-3 workspace merge: the order frame is [...local, ...A, ...B] in PAIRING order, whatever the connect order', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const { gateway, localGate } = createMergeGateway()
  const slotEntryIds = []
  const { handle } = installPool(gateway, pool, {
    createSessionInventorySlot: (serverId) => {
      const slot = {
        replace() {},
        dispose() {},
      }
      slotEntryIds.push(serverId)
      return slot
    },
  })
  const stream = gateway.wireTap('workspace/follow', { args: {} }, undefined, undefined, undefined, { signal: undefined })
  const iterator = (await stream)[Symbol.asyncIterator]()

  // The generator body (and with it the per-server slot pumps) starts on the
  // first next() — push the local baseline and read it, THEN look for the
  // legs.
  localGate.push({ type: 'baseline', value: { items: [{ workspaceId: 'ws-local', title: '本地', sessionIds: [] }], archivedSessionIds: [], pinnedSessionIds: [] } })
  const [localBaseline] = await readSome(iterator, 1)
  assert.equal(localBaseline.type, 'baseline')
  await settle()
  const legA = relayA.streams.find((leg) => leg.namespace === 'workspace')
  const legB = relayB.streams.find((leg) => leg.namespace === 'workspace')
  assert.ok(legA && legB, 'each pooled server runs its own remote workspace pump')

  // B delivers FIRST (it connected first) — the pairing order still rules.
  // A remote baseline's whole update is 4 frames: upsert + the canonical
  // order/archived/pinned trio.
  legB.gate.push(workspaceBaseline('w-b', '工作区B', ['sb1']))
  const framesB = await readSome(iterator, 4)
  assert.equal(framesB[0].type, 'upsert')
  assert.equal(framesB[0].workspace.workspaceId, VB('w-b'))
  assert.equal(framesB[0].workspace.title, 'MacBook-2 · 工作区B', 'the pool display name titles the group')
  assert.deepEqual(framesB[1].workspaceIds, ['ws-local', VB('w-b')])

  legA.gate.push(workspaceBaseline('w-a', '工作区A', ['sa1']))
  const framesA = await readSome(iterator, 4)
  assert.equal(framesA[0].type, 'upsert')
  assert.equal(framesA[0].workspace.workspaceId, VA('w-a'))
  assert.equal(framesA[0].workspace.title, 'MacBook-1 · 工作区A')
  assert.deepEqual(
    framesA[1].workspaceIds,
    ['ws-local', VA('w-a'), VB('w-b')],
    'A joined AFTER B but still sorts first — pairing order, not connect order',
  )
  assert.deepEqual(slotEntryIds.sort(), [SID_A, SID_B], 'one inventory slot per server, keyed by serverId')

  await iterator.return?.(undefined)
  handle.uninstall()
})

test('MS-3 workspace merge: a local baseline after cached remote baselines composes all servers in pairing order', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const { gateway, localGate } = createMergeGateway()
  const { handle } = installPool(gateway, pool)
  const stream = gateway.wireTap('workspace/follow', { args: {} }, undefined, undefined, undefined, { signal: undefined })
  const iterator = (await stream)[Symbol.asyncIterator]()

  // Start the generator (first next()), then cache both remote baselines.
  const started = iterator.next()
  const legA = relayA.streams.find((leg) => leg.namespace === 'workspace')
  const legB = relayB.streams.find((leg) => leg.namespace === 'workspace')
  assert.ok(legA && legB, 'each pooled server runs its own remote workspace pump')
  legA.gate.push(workspaceBaseline('w-a', '工作区A', ['sa1']))
  legB.gate.push(workspaceBaseline('w-b', '工作区B', []))
  await settle()
  // Nothing may have left the merged stream yet: the UI has seen nothing.
  localGate.push({ type: 'baseline', value: { items: [{ workspaceId: 'ws-local', title: '本地', sessionIds: [] }], archivedSessionIds: [], pinnedSessionIds: [] } })
  const firstResult = await started
  assert.equal(firstResult.done, false)
  const baseline = firstResult.value
  assert.equal(baseline.type, 'baseline')
  assert.deepEqual(
    baseline.value.items.map((item) => item.workspaceId),
    ['ws-local', VA('w-a')],
    'one baseline; B\'s group is EMPTY (no sessions) so T56 withholds it',
  )
  const upserts = await readSome(iterator, 1)
  assert.deepEqual(
    upserts.map((frame) => frame.workspace.workspaceId),
    [VA('w-a')],
    'each shown server\'s upserts follow in pairing order',
  )

  await iterator.return?.(undefined)
  handle.uninstall()
})

test('MS-3 workspace merge: removing server A takes only A\'s group down and leaves B\'s pump untouched', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const { gateway, localGate } = createMergeGateway()
  const { handle } = installPool(gateway, pool)
  const stream = gateway.wireTap('workspace/follow', { args: {} }, undefined, undefined, undefined, { signal: undefined })
  const iterator = (await stream)[Symbol.asyncIterator]()

  localGate.push({ type: 'baseline', value: { items: [{ workspaceId: 'ws-local', title: '本地', sessionIds: [] }], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(iterator, 1)
  await settle()
  const legA = relayA.streams.find((leg) => leg.namespace === 'workspace')
  const legB = relayB.streams.find((leg) => leg.namespace === 'workspace')
  assert.ok(legA && legB)
  // Both baselines: 4 frames each.
  legA.gate.push(workspaceBaseline('w-a', '工作区A', ['sa1']))
  legB.gate.push(workspaceBaseline('w-b', '工作区B', ['sb1']))
  await readSome(iterator, 8)
  await settle()

  pool.remove(`entry-${SID_A}`)
  handle.notePoolEvent()
  const [removeA, orderAfter, archivedAfter, pinnedAfter] = await readSome(iterator, 4)
  assert.deepEqual(removeA, { type: 'remove', workspaceId: VA('w-a') }, 'only A\'s workspace was removed')
  assert.deepEqual(orderAfter.workspaceIds, ['ws-local', VB('w-b')], 'the merged order was re-emitted without A')
  assert.deepEqual(archivedAfter.archivedSessionIds, [])
  assert.deepEqual(pinnedAfter.pinnedSessionIds, [])
  assert.equal(legB.aborted, false, 'B\'s pump was never aborted')
  assert.equal(legA.aborted, true, 'A\'s pump was cut')

  // B keeps working: its frames still merge (a remote pinned frame re-airs
  // the canonical trio — order/archived/pinned).
  legB.gate.push({ type: 'pinned', pinnedSessionIds: ['sb1'] })
  const pinnedUpdate = await readSome(iterator, 3)
  assert.deepEqual(pinnedUpdate[2].pinnedSessionIds, [VB('sb1')])

  await iterator.return?.(undefined)
  handle.uninstall()
})

test('MS-3 workspace merge: a display-name change re-upserts the group under the new title', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const { gateway, localGate } = createMergeGateway()
  const { handle } = installPool(gateway, pool)
  const stream = gateway.wireTap('workspace/follow', { args: {} }, undefined, undefined, undefined, { signal: undefined })
  const iterator = (await stream)[Symbol.asyncIterator]()

  localGate.push({ type: 'baseline', value: { items: [{ workspaceId: 'ws-local', title: '本地', sessionIds: [] }], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(iterator, 1)
  await settle()
  const legA = relayA.streams.find((leg) => leg.namespace === 'workspace')
  assert.ok(legA)
  legA.gate.push(workspaceBaseline('w-a', '工作区A', ['sa1']))
  await readSome(iterator, 4)

  // A is renamed so the collision (and its -1 suffix) goes away — the fake
  // pool's views mutate exactly like deriveDisplayServerNames would on the
  // next entries() read.
  pool.views[0].displayName = 'desk'
  handle.notePoolEvent()
  const [renamed] = await readSome(iterator, 4)
  assert.equal(renamed.type, 'upsert')
  assert.equal(renamed.workspace.title, 'desk · 工作区A', 'the un-suffixed name now titles the group')

  await iterator.return?.(undefined)
  handle.uninstall()
})

// -- 4. session/control multi-merge -----------------------------------------------

test('MS-3 control merge: each server\'s control stream virtualizes into the main channel under its own ids', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const { gateway, localGate } = createMergeGateway()
  const { handle } = installPool(gateway, pool)
  const stream = gateway.wireTap('session/control', { args: {} }, undefined, undefined, undefined, { signal: undefined })
  const iterator = (await stream)[Symbol.asyncIterator]()

  localGate.push({ type: 'baseline', value: { projections: {} } })
  const [baseline] = await readSome(iterator, 1)
  assert.equal(baseline.type, 'baseline')
  await settle()
  const legA = relayA.streams.find((leg) => leg.namespace === 'session' && leg.method === 'control')
  const legB = relayB.streams.find((leg) => leg.namespace === 'session' && leg.method === 'control')
  assert.ok(legA && legB, 'each pooled server runs its own control pump')

  legA.gate.push({ type: 'projection', sessionId: 's1', key: 'modelSelection', value: { lastUsed: { provider: 'prov', model: 'm1' } }, seq: 3 })
  legB.gate.push({ type: 'projection', sessionId: 's2', key: 'k', value: 1, seq: 7 })
  const [frameA, frameB] = await readSome(iterator, 2)
  assert.equal(frameA.sessionId, VA('s1'), 'A\'s projection carries A\'s virtual id')
  assert.equal(frameB.sessionId, VB('s2'), 'B\'s projection carries B\'s virtual id')
  // The modelSelection rewrite keys on the frame's OWN server (A).
  assert.equal(frameA.value.lastUsed.provider, VA('prov'))

  await iterator.return?.(undefined)
  handle.uninstall()
})

// -- 5. session/list and session/modelCatalog multi-merge --------------------------

test('MS-3 session/list: every online server is fetched concurrently and merged in pairing order', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  relayA.invokeValues['session/list'] = { items: [{ sessionId: 'a1' }] }
  relayB.invokeValues['session/list'] = { items: [{ sessionId: 'b1' }] }
  const gateway = new FakeTypertGateway({ rpc: { 'session/list': { ok: true, value: { items: [{ sessionId: 'local1' }] } } } })
  const { handle } = installPool(gateway, pool)
  const envelope = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, gateway.operatorPeer())
  assert.equal(relayA.invokes.length, 1)
  assert.equal(relayB.invokes.length, 1)
  assert.deepEqual(
    envelope.value.items.map((row) => row.sessionId),
    ['local1', VA('a1'), VB('b1')],
  )
  handle.uninstall()
})

test('MS-3 session/list: an offline server is skipped, the online one still merges', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  relayB.transition('offline')
  relayA.invokeValues['session/list'] = { items: [{ sessionId: 'a1' }] }
  const gateway = new FakeTypertGateway({ rpc: { 'session/list': { ok: true, value: { items: [] } } } })
  const { handle } = installPool(gateway, pool)
  const envelope = await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, gateway.operatorPeer())
  assert.equal(relayA.invokes.length, 1)
  assert.equal(relayB.invokes.length, 0, 'an offline leg is not asked')
  assert.deepEqual(envelope.value.items.map((row) => row.sessionId), [VA('a1')])
  handle.uninstall()
})

test('MS-3 modelCatalog: per-server caches, displayName-prefixed group names, offline merge from cache, gone after removal', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  relayA.invokeValues['session/modelCatalog'] = { groups: [{ id: 'prov-a', name: 'ProvA' }], routableProviders: ['prov-a'] }
  relayB.invokeValues['session/modelCatalog'] = { groups: [{ id: 'prov-b', name: 'ProvB' }], routableProviders: ['prov-b'] }
  const localCatalog = { ok: true, value: { groups: [{ id: 'local-prov', name: '本地' }], routableProviders: ['local-prov'] } }
  const gateway = new FakeTypertGateway({ rpc: { 'session/modelCatalog': localCatalog } })
  const { handle } = installPool(gateway, pool)

  const envelope = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, gateway.operatorPeer())
  assert.deepEqual(
    envelope.value.groups,
    [
      { id: 'local-prov', name: '本地' },
      { id: VA('prov-a'), name: `${MARK_A}MacBook-1 · ProvA` },
      { id: VB('prov-b'), name: `${MARK_B}MacBook-2 · ProvB` },
    ],
    'the group names carry each server\'s id bits and display name behind the invisible mark (MS-4 encoding)',
  )
  const callsAfterFirst = relayA.invokes.length + relayB.invokes.length
  assert.equal(callsAfterFirst, 2, 'one fetch per online server')

  // A goes offline: its cached groups still merge, B is fetched fresh.
  relayA.transition('offline')
  const offlineEnvelope = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, gateway.operatorPeer())
  assert.deepEqual(offlineEnvelope.value.groups[1], { id: VA('prov-a'), name: `${MARK_A}MacBook-1 · ProvA` }, 'A\'s cache survives its outage')
  assert.equal(relayA.invokes.length, callsAfterFirst - 1, 'the offline leg was not asked again')

  // A leaves the pool entirely: its groups must not outlive the entry.
  pool.remove(`entry-${SID_A}`)
  handle.notePoolEvent()
  const goneEnvelope = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, gateway.operatorPeer())
  assert.deepEqual(
    goneEnvelope.value.groups.map((group) => group.id),
    ['local-prov', VB('prov-b')],
  )
  handle.uninstall()
})

// -- 6. the multi-server $zr/events stream -----------------------------------------

function waterfall(eventId, agentId) {
  return { type: 'waterfall', event: 'tool', eventId, agentId, request: { toolName: 'shell' } }
}

test('MS-3 events: both servers\' waterfalls fold in under their own virtual ids; A dying cancels only A\'s pending events', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const { gateway, localGate } = createMergeGateway()
  const { handle } = installPool(gateway, pool)
  const stream = gateway.wireTap('$events', { args: {} }, undefined, undefined, undefined, { signal: undefined })
  const iterator = (await stream)[Symbol.asyncIterator]()

  localGate.push({ type: 'ready' })
  // The local ready passes through, followed by the T52 catalog-refresh
  // emit the servers' fresh serving period synthesized (both were already
  // online when the stream opened).
  const [ready, refresh] = await readSome(iterator, 2)
  assert.equal(ready.type, 'ready', 'the local ready frame passes through')
  assert.deepEqual(refresh, { type: 'emit', event: 'llm/adapters-updated', args: [] })
  await settle()
  const legA = relayA.streams.find((leg) => leg.namespace === '$zr')
  const legB = relayB.streams.find((leg) => leg.namespace === '$zr')
  assert.ok(legA && legB, 'each pooled server runs its own $zr/events pump')

  legA.gate.push(waterfall('w1.e1', 'ag1'))
  legA.gate.push(waterfall('w1.e2', 'ag2'))
  legB.gate.push(waterfall('w2.e9', 'ag9'))
  // Two independent pumps interleave at the channel — arrival order across
  // servers is not deterministic, only per-server order is.
  const wfs = await readSome(iterator, 3)
  assert.deepEqual(
    wfs.map((frame) => frame.eventId).sort(),
    [VA('w1.e1'), VA('w1.e2'), VB('w2.e9')],
  )
  const wfA1 = wfs.find((frame) => frame.eventId === VA('w1.e1'))
  assert.equal(wfA1.agentId, VA('ag1'))
  assert.equal(wfs.find((frame) => frame.eventId === VB('w2.e9')).agentId, VB('ag9'))

  // A's leg dies: only A's shown events are closed, B's stay pending.
  legA.gate.throwNow(new RelayError('offline', 'transport died'))
  const [cancelA1, cancelA2] = await readSome(iterator, 2)
  assert.deepEqual(cancelA1, { type: 'cancel', eventId: VA('w1.e1') })
  assert.deepEqual(cancelA2, { type: 'cancel', eventId: VA('w1.e2') })
  assert.equal(legB.aborted, false, 'B\'s pump was never touched')

  // B keeps delivering.
  legB.gate.push(waterfall('w2.e10', 'ag10'))
  const [wfB2] = await readSome(iterator, 1)
  assert.equal(wfB2.eventId, VB('w2.e10'))

  // A reconnects: a fresh leg reopens on A's client and delivers again. Its
  // fresh serving period also re-airs the T52 catalog-refresh emit — read
  // that first, then the waterfall on the new leg.
  relayA.transition('offline')
  relayA.transition('online')
  await settle()
  const refreshed = await readSome(iterator, 1)
  assert.deepEqual(refreshed[0], { type: 'emit', event: 'llm/adapters-updated', args: [] }, 'the fresh serving period refreshes the catalog')
  const legA2 = relayA.streams[relayA.streams.length - 1]
  assert.ok(legA2 !== legA, 'a new leg was opened for A')
  legA2.gate.push(waterfall('w1.e3', 'ag3'))
  const [wfA3] = await readSome(iterator, 1)
  assert.equal(wfA3.eventId, VA('w1.e3'))

  await iterator.return?.(undefined)
  handle.uninstall()
})

test('MS-3 events: removing server A cancels only A\'s pending events and leaves B\'s stream running', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const { gateway, localGate } = createMergeGateway()
  const { handle } = installPool(gateway, pool)
  const stream = gateway.wireTap('$events', { args: {} }, undefined, undefined, undefined, { signal: undefined })
  const iterator = (await stream)[Symbol.asyncIterator]()

  localGate.push({ type: 'ready' })
  const [ready, refresh] = await readSome(iterator, 2)
  assert.equal(ready.type, 'ready')
  assert.deepEqual(refresh, { type: 'emit', event: 'llm/adapters-updated', args: [] })
  await settle()
  const legA = relayA.streams.find((leg) => leg.namespace === '$zr')
  const legB = relayB.streams.find((leg) => leg.namespace === '$zr')
  assert.ok(legA && legB)
  legA.gate.push(waterfall('w1.e5', 'ag5'))
  legB.gate.push(waterfall('w2.e7', 'ag7'))
  await readSome(iterator, 2)

  pool.remove(`entry-${SID_A}`)
  handle.notePoolEvent()
  const [cancelA] = await readSome(iterator, 1)
  assert.deepEqual(cancelA, { type: 'cancel', eventId: VA('w1.e5') }, 'only A\'s pending event was canceled')
  assert.equal(legB.aborted, false)

  legB.gate.push(waterfall('w2.e8', 'ag8'))
  const [wfB] = await readSome(iterator, 1)
  assert.equal(wfB.eventId, VB('w2.e8'), 'B\'s pump still serves after A left')

  await iterator.return?.(undefined)
  handle.uninstall()
})
