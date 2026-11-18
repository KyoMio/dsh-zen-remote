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
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { installIntercept } = require('../lib/intercept.js')
const { createRelayClient, RelayError } = require('../lib/relay-client.js')
const { createRelayHandler, loadServerId } = require('../lib/relay-server.js')
const { createShareStore } = require('../lib/share-store.js')
const { toVirtual, VIRTUAL_GROUP_NAME_MARK: MARK, encodeServerIdZeroWidth } = require('../lib/virtual-id.js')

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
    ['ws-local', VA('w-a'), VB('w-b')],
    'one baseline; all workspaces on connected servers (including empty ones) are shown in pairing order',
  )
  const upserts = await readSome(iterator, 2)
  assert.deepEqual(
    upserts.map((frame) => frame.workspace.workspaceId),
    [VA('w-a'), VB('w-b')],
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

test('MS-3 control merge: local baseline before peer joins pool still forwards late peer live projections immediately', async () => {
  const pool = createFakePool([])
  const { gateway, localGate } = createMergeGateway()
  const { handle } = installPool(gateway, pool)
  const stream = gateway.wireTap('session/control', { args: {} }, undefined, undefined, undefined, { signal: undefined })
  const iterator = (await stream)[Symbol.asyncIterator]()

  // Local session/control emits baseline BEFORE any remote peer joins the pool.
  localGate.push({ type: 'baseline', value: { projections: {} } })
  const [baseline] = await readSome(iterator, 1)
  assert.equal(baseline.type, 'baseline')

  // Peer A joins/connects afterward: its control leg opens with localBaselineFrame already seeded,
  // so seq: 0 live projection frames must forward immediately without another local baseline.
  const relayA = createMultiRelay(SID_A)
  pool.add(makeEntry(SID_A, 'A', relayA))
  handle.notePoolEvent()
  await settle()
  const legA = relayA.streams.find((leg) => leg.namespace === 'session' && leg.method === 'control')
  assert.ok(legA, 'late peer opens its control leg upon joining the pool')

  legA.gate.push({
    type: 'projection',
    sessionId: 's-live',
    key: 'modelSelection',
    value: { lastUsed: null, next: { provider: 'prov', model: 'm2', reasoningEffort: 'high' } },
    seq: 0,
  })
  legA.gate.push({
    type: 'projection',
    sessionId: 's-live',
    key: 'agentPreset',
    value: { currentValue: 'preset-a' },
    seq: 0,
  })

  const frames = await readSome(iterator, 2)
  assert.deepEqual(frames[0], {
    type: 'projection',
    sessionId: VA('s-live'),
    key: 'modelSelection',
    value: { lastUsed: null, next: { provider: VA('prov'), model: 'm2', reasoningEffort: 'high' } },
    seq: 0,
    changes: [
      {
        key: 'modelSelection',
        val: { lastUsed: null, next: { provider: VA('prov'), model: 'm2', reasoningEffort: 'high' } },
      },
    ],
  })
  assert.deepEqual(frames[1], {
    type: 'projection',
    sessionId: VA('s-live'),
    key: 'agentPreset',
    value: { currentValue: 'preset-a' },
    seq: 0,
    changes: [
      {
        key: 'agentPreset',
        val: { currentValue: 'preset-a' },
      },
    ],
  })

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

test('PAS-5: removing server A emits api-session/removed even for list-only sessions and purges A caches', async () => {
  const { relayA, relayB } = bothRelays()
  relayA.invokeValues['session/modelCatalog'] = { groups: [{ id: 'prov-a', name: 'ProvA' }], routableProviders: ['prov-a'] }
  relayB.invokeValues['session/modelCatalog'] = { groups: [{ id: 'prov-b', name: 'ProvB' }], routableProviders: ['prov-b'] }
  const pool = bothPool(relayA, relayB)
  const gateway = new FakeTypertGateway({
    rpc: {
      'session/list': { ok: true, value: { items: [], hasMore: false } },
      'session/modelCatalog': { ok: true, value: { groups: [{ id: 'local', name: 'Local' }], routableProviders: ['local'] } },
    },
  })
  const localGate = createGate(undefined)
  gateway.openWireStream = async function (endpoint, payload, uplink, peer, legSignal, control) {
    gateway.streamCalls.push({ endpoint, payload, uplink, peer, signal: legSignal, control })
    return localGate.iterable
  }
  const { handle } = installPool(gateway, pool)

  // Seed closedSessions on both A and B via session/follow stream closure (`not-shared`).
  const drainFollow = async (vid) => {
    const it = (await gateway.wireTap('session/follow', { args: { request: { address: { kind: 'session', sessionId: vid } } } }, undefined, undefined, undefined, { signal: undefined }))[Symbol.asyncIterator]()
    const p = it.next().catch(() => {})
    await settle()
    return p
  }
  const followB = drainFollow(VB('s-closed-b'))
  await settle()
  relayB.streams[relayB.streams.length - 1].gate.throwNow(new RelayError('not-shared', 'closed', { reason: 'manual' }))
  await followB
  const followA = drainFollow(VA('s-closed-a'))
  await settle()
  relayA.streams[relayA.streams.length - 1].gate.throwNow(new RelayError('not-shared', 'closed', { reason: 'manual' }))
  await followA

  // Seed catalog caches and verify A & B are both present before removal.
  const catBefore = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, gateway.operatorPeer())
  assert.ok(catBefore.value.groups.some((g) => g.id === VA('prov-a')))

  // Open $events AFTER ready settles with empty initial session/list on A.
  const stream = gateway.wireTap('$events', { args: {} }, undefined, undefined, undefined, { signal: undefined })
  const iterator = (await stream)[Symbol.asyncIterator]()
  localGate.push({ type: 'ready' })
  await readSome(iterator, 2) // local ready + llm/adapters-updated
  await settle()

  const legA = relayA.streams.find((leg) => leg.namespace === '$zr')
  assert.ok(legA)
  legA.gate.push(waterfall('w1.p1', 'ag1'))
  await readSome(iterator, 1)

  // Discover `s-list-only` ONLY through the RPC session/list path (never announced on $events).
  relayA.invokeValues['session/list'] = {
    items: [{ sessionId: 's-list-only', updatedAt: 1, running: false, cwd: '/proj/a' }],
    hasMore: false,
  }
  await gateway.rpcBridge('session/list', { args: { _request: { filter: 'all' } } }, undefined, undefined)
  assert.deepEqual(handle.resolveRemoteFileScope('/proj/a/shot.png'), { serverId: SID_A, sessionId: 's-list-only' })

  // Remove A: pending waterfall cancel comes first, then api-session/removed for A's known sessions.
  pool.remove(`entry-${SID_A}`)
  handle.notePoolEvent()
  const postRemove = await readSome(iterator, 3)
  assert.deepEqual(postRemove[0], { type: 'cancel', eventId: VA('w1.p1') })
  const removedEvents = postRemove.slice(1).map((f) => ({ event: f.event, id: f.args?.[0] })).sort((a, b) => a.id.localeCompare(b.id))
  assert.deepEqual(removedEvents, [
    { event: 'api-session/removed', id: VA('s-closed-a') },
    { event: 'api-session/removed', id: VA('s-list-only') },
  ])

  assert.equal(handle.resolveRemoteFileScope('/proj/a/shot.png'), undefined, 'remoteSessionCwds purged for removed server')
  assert.deepEqual(
    handle.diagnostics().closedSessions.map((r) => r.sessionId),
    [VB('s-closed-b')],
    'closedSessions purged for A while B remains intact',
  )
  const catAfter = await gateway.rpcBridge('session/modelCatalog', { args: {} }, undefined, gateway.operatorPeer())
  assert.equal(catAfter.value.groups.some((g) => g.id === VA('prov-a')), false, 'serverCatalogCaches purged for A')
  assert.equal(catAfter.value.groups.some((g) => g.id === VB('prov-b')), true, 'B catalog stays intact')

  await iterator.return?.(undefined)
  handle.uninstall()
})

test('PAS-5: removing server A before local ready defers api-session/removed until after ready', async () => {
  const { relayA, relayB } = bothRelays()
  const pool = bothPool(relayA, relayB)
  const { gateway, localGate } = createMergeGateway()
  const { handle } = installPool(gateway, pool)

  // Seed a session in knownVirtualSessionsByServer via session/list before $events opens.
  relayA.invokeValues['session/list'] = {
    items: [{ sessionId: 's-early', updatedAt: 1, running: false, cwd: '/proj/early' }],
    hasMore: false,
  }
  await gateway.rpcBridge('session/list', { args: { _request: {} } }, undefined, undefined)

  const stream = gateway.wireTap('$events', { args: {} }, undefined, undefined, undefined, { signal: undefined })
  const iterator = (await stream)[Symbol.asyncIterator]()
  const firstFramePromise = iterator.next()
  await settle()

  // Remove A BEFORE localGate sends `ready`.
  pool.remove(`entry-${SID_A}`)
  handle.notePoolEvent()
  await settle()

  // First emitted frame MUST be the local `ready` frame, followed immediately by api-session/removed.
  localGate.push({ type: 'ready' })
  const firstResult = await firstFramePromise
  const [second] = await readSome(iterator, 1)
  assert.deepEqual(firstResult.value, { type: 'ready' }, 'local ready precedes deferred api-session/removed')
  assert.deepEqual(second, { type: 'emit', event: 'api-session/removed', args: [VA('s-early')] })

  await iterator.return?.(undefined)
  handle.uninstall()
})

test('PAS-5: re-adding the same serverId preserves incremented workspaceEpochs and re-announces sessions', async () => {
  const relayA1 = createMultiRelay(SID_A)
  relayA1.invokeValues['session/list'] = { items: [{ sessionId: 's-rejoin', updatedAt: 10, running: false }], hasMore: false }
  const pool = createFakePool([makeEntry(SID_A, 'A', relayA1)])
  const gateway = new FakeTypertGateway({ rpc: { 'session/list': { ok: true, value: { items: [], hasMore: false } } } })
  let nextLocalGate = createGate(undefined)
  gateway.openWireStream = async function (endpoint, payload, uplink, peer, legSignal, control) {
    gateway.streamCalls.push({ endpoint, payload, uplink, peer, signal: legSignal, control })
    if (endpoint === 'workspace/follow') return nextLocalGate.iterable
    return createGate(undefined).iterable
  }
  // Open one workspace/follow and one $events stream on separate controllable gates.
  const wsLocalGate = nextLocalGate
  const eventsLocalGate = createGate(undefined)
  gateway.openWireStream = async function (endpoint, payload, uplink, peer, legSignal, control) {
    gateway.streamCalls.push({ endpoint, payload, uplink, peer, signal: legSignal, control })
    return endpoint === '$events' ? eventsLocalGate.iterable : wsLocalGate.iterable
  }
  const { handle } = installPool(gateway, pool)

  const wsIter = (await gateway.wireTap('workspace/follow', { args: {} }, undefined, undefined, undefined, { signal: undefined }))[Symbol.asyncIterator]()
  const evIter = (await gateway.wireTap('$events', { args: {} }, undefined, undefined, undefined, { signal: undefined }))[Symbol.asyncIterator]()

  wsLocalGate.push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  await readSome(wsIter, 1)
  eventsLocalGate.push({ type: 'ready' })
  await readSome(evIter, 3) // ready, llm/adapters-updated, api-session/added (or status)
  // Drain any remaining status frame from initial sync so channel is quiet before remove.
  await settle()
  await evIter.next()

  const legWs1 = relayA1.streams.find((leg) => leg.namespace === 'workspace')
  legWs1.gate.push(workspaceBaseline('w-1', 'WS1', ['s-rejoin']))
  const wsFrames1 = await readSome(wsIter, 4)
  assert.equal(wsFrames1[0].workspace.workspaceId, VA('w-1'))

  // Remove A: workspace removes (epoch increments from 0 -> 1) and session emits api-session/removed.
  pool.remove(`entry-${SID_A}`)
  handle.notePoolEvent()
  const wsRemove = await readSome(wsIter, 4)
  assert.deepEqual(wsRemove[0], { type: 'remove', workspaceId: VA('w-1') })
  const [evRemoved] = await readSome(evIter, 1)
  assert.deepEqual(evRemoved, { type: 'emit', event: 'api-session/removed', args: [VA('s-rejoin')] })

  // Re-add A with fresh client: workspace epoch MUST be preserved (> 0), and session re-announces cleanly.
  const relayA2 = createMultiRelay(SID_A)
  relayA2.invokeValues['session/list'] = { items: [{ sessionId: 's-rejoin', updatedAt: 10, running: false }], hasMore: false }
  pool.add(makeEntry(SID_A, 'A', relayA2))
  handle.notePoolEvent()
  await settle()

  const legWs2 = relayA2.streams.find((leg) => leg.namespace === 'workspace')
  assert.ok(legWs2)
  legWs2.gate.push(workspaceBaseline('w-1', 'WS1', ['s-rejoin']))
  const wsFrames2 = await readSome(wsIter, 4)
  assert.equal(wsFrames2[0].workspace.workspaceId, VA('#1~w-1'), 're-added server must use incremented workspaceEpochs id')

  // On $events, s-rejoin was cleared from `announced` on removal, so it re-announces via api-session/added.
  const evAfterReadd = await readSome(evIter, 3)
  const reAdded = evAfterReadd.find((f) => f.type === 'emit' && f.event === 'api-session/added')
  assert.deepEqual(reAdded?.args?.[0]?.sessionId, VA('s-rejoin'))

  await wsIter.return?.(undefined)
  await evIter.return?.(undefined)
  handle.uninstall()
})

// -- 7. pool client swap: the held session/follow follows the CURRENT client -----
// peer-resilience T1: a held SESSION_STREAM_HOLD endpoint bound its wait and
// its reopen to the client object captured at open time. A dead leg's pool
// swap (peer-left → unmount → peer-joined → new client under the same
// serverId) left the old client waiting on a `stopped` relay that can never
// go online again — the remote session page froze on 正在加载 until a DSH
// restart. The hold now follows `pool.getByServerId(serverId)` per iteration.

/** A manual clock for the hold's reopen backoff (the serve-again wait costs
 * one backoff step when the re-resolved client already reads online). */
function fakeClock() {
  let now = 1_700_000_000_000
  const timers = []
  return {
    now: () => now,
    random: () => 0,
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

/** Drive the hold's serve-again path to completion: keep settling until the
 * generator arms its backoff timer, fire it, repeat — the generator's
 * re-entry into waitServeAgain spans many microtask turns (IteratorClose on
 * the dead gate + async-generator queue draining), so a fixed settle count
 * races it. `done` marks success: either a stream leg appears on `watchRelay`
 * or nothing more can arm. */
async function driveRecovery(clock, watchRelay) {
  for (let i = 0; i < 40; i += 1) {
    if (watchRelay !== undefined && watchRelay.streams.length > 0) return
    if (clock.pending > 0) clock.advance(10_000)
    await settle()
  }
}

/** A pending `next()` promise that must NOT settle within `ms` — used where
 * the hold is supposed to keep the UI stream open and silent. */
async function expectSilent(pending, ms = 80) {
  let timer
  const raced = await Promise.race([
    pending.then(() => 'settled'),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('pending'), ms)
    }),
  ]).finally(() => clearTimeout(timer))
  assert.equal(raced, 'pending', 'the held stream must stay open and silent')
}

test('peer-resilience: a held session/follow whose pool entry swaps to a NEW client reopens on the new one (first frame still owed)', async () => {
  const relayA1 = createMultiRelay(SID_A)
  const pool = createFakePool([makeEntry(SID_A, 'A', relayA1)])
  const gateway = new FakeTypertGateway()
  const clock = fakeClock()
  const { handle } = installPool(gateway, pool, { clock })
  const iterable = gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VA('s1') } } } },
    undefined, undefined, undefined, { signal: undefined },
  )
  const iterator = (await iterable)[Symbol.asyncIterator]()
  const pending = iterator.next()
  await settle()
  assert.equal(relayA1.streams.length, 1, 'the leg opened on A1')

  // The leg dies offline; the peer-left path then swaps the pool entry to a
  // fresh client under the same serverId.
  relayA1.transition('offline')
  relayA1.streams[0].gate.throwNow(new RelayError('offline', 'transport died'))
  await settle()
  const relayA2 = createMultiRelay(SID_A)
  pool.remove(`entry-${SID_A}`)
  pool.add(makeEntry(SID_A, 'A', relayA2))
  handle.notePoolEvent()
  await settle()
  await driveRecovery(clock, relayA2)

  const legA2 = relayA2.streams.find((leg) => leg.namespace === 'session' && leg.method === 'follow')
  assert.ok(legA2, 'the hold reopened on the NEW client')
  assert.equal(relayA1.streams.length, 1, 'the dead client never saw another openStream')
  legA2.gate.push({ type: 'snapshot', header: { id: 's1' } })
  const result = await pending
  assert.equal(result.done, false)
  assert.equal(result.value.header.id, VA('s1'), 'the snapshot arrived virtualized through the new leg')

  await iterator.return?.(undefined)
  handle.uninstall()
})

test('peer-resilience: a held session/follow past its first frame ends cleanly once the new client serves', async () => {
  const relayA1 = createMultiRelay(SID_A)
  const pool = createFakePool([makeEntry(SID_A, 'A', relayA1)])
  const gateway = new FakeTypertGateway()
  const clock = fakeClock()
  const { handle } = installPool(gateway, pool, { clock })
  const iterable = gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VA('s1') } } } },
    undefined, undefined, undefined, { signal: undefined },
  )
  const iterator = (await iterable)[Symbol.asyncIterator]()
  const pending = iterator.next()
  await settle()
  relayA1.streams[0].gate.push({ type: 'snapshot', header: { id: 's1' } })
  const first = await pending
  assert.equal(first.value.header.id, VA('s1'))

  relayA1.transition('offline')
  relayA1.streams[0].gate.throwNow(new RelayError('offline', 'transport died'))
  await settle()
  const relayA2 = createMultiRelay(SID_A)
  pool.remove(`entry-${SID_A}`)
  pool.add(makeEntry(SID_A, 'A', relayA2))
  handle.notePoolEvent()
  // Serve-again runs the backoff inside the generator, which resumes over
  // many turns; drive it until the clean end lands (no new leg to watch).
  const donePump = (async () => { for (let i = 0; i < 40; i += 1) { if (clock.pending > 0) clock.advance(10_000); await settle() } })()
  const done = await Promise.race([iterator.next(), donePump.then(() => ({ timedOut: true }))])
  if (done.timedOut === true) throw new Error('held stream never ended after the pool swap')

  // The accepted-generation clean end: the UI retries on a carrier failure,
  // and ITS reopen goes through validate → the new client.
  assert.equal(done.done, true, 'the delivered generation ends cleanly on recovery')
  assert.equal(relayA1.streams.length, 1, 'the dead client never saw another openStream')

  handle.uninstall()
})

test('peer-resilience: a held session/follow outlives a pool entry ABSENCE and resumes on the re-added client', async () => {
  const relayA1 = createMultiRelay(SID_A)
  const pool = createFakePool([makeEntry(SID_A, 'A', relayA1)])
  const gateway = new FakeTypertGateway()
  const clock = fakeClock()
  const { handle } = installPool(gateway, pool, { clock })
  const iterable = gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VA('s1') } } } },
    undefined, undefined, undefined, { signal: undefined },
  )
  const iterator = (await iterable)[Symbol.asyncIterator]()
  const pending = iterator.next()
  await settle()

  relayA1.transition('offline')
  relayA1.streams[0].gate.throwNow(new RelayError('offline', 'transport died'))
  await settle()
  // The server is gone from the pool entirely for a while — the hold must
  // neither end nor error, just wait.
  pool.remove(`entry-${SID_A}`)
  handle.notePoolEvent()
  await settle()
  await expectSilent(pending)

  const relayA2 = createMultiRelay(SID_A)
  pool.add(makeEntry(SID_A, 'A', relayA2))
  handle.notePoolEvent()
  await settle()
  await driveRecovery(clock, relayA2)
  const legA2 = relayA2.streams[0]
  assert.ok(legA2, 'the re-added client received the reopen')
  legA2.gate.push({ type: 'snapshot', header: { id: 's1' } })
  const result = await pending
  assert.equal(result.value.header.id, VA('s1'))

  await iterator.return?.(undefined)
  handle.uninstall()
})

test('peer-resilience: an aborted held wait releases BOTH subscriptions and never reopens', async () => {
  const relayA1 = createMultiRelay(SID_A)
  // Count live state listeners on the old client — install adds one
  // (catalog watcher) in pool mode, the hold adds one more while waiting.
  let liveSubs = 0
  const realSubscribe = relayA1.subscribe.bind(relayA1)
  relayA1.subscribe = (listener) => {
    liveSubs += 1
    const off = realSubscribe(listener)
    return () => { liveSubs -= 1; off() }
  }
  const pool = createFakePool([makeEntry(SID_A, 'A', relayA1)])
  const gateway = new FakeTypertGateway()
  const { handle } = installPool(gateway, pool)
  const installSubs = liveSubs

  const controller = new AbortController()
  const iterable = gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: VA('s1') } } } },
    undefined, undefined, undefined, { signal: controller.signal },
  )
  const iterator = (await iterable)[Symbol.asyncIterator]()
  const pending = iterator.next()
  await settle()

  relayA1.transition('offline')
  relayA1.streams[0].gate.throwNow(new RelayError('offline', 'transport died'))
  await settle()
  assert.equal(liveSubs, installSubs + 1, 'the hold parked one listener on the old client')

  // The page closes while the serverId is gone from the pool entirely.
  pool.remove(`entry-${SID_A}`)
  handle.notePoolEvent()
  await settle()
  await expectSilent(pending)
  controller.abort()
  const result = await pending
  assert.equal(result.done, true, 'abort ends the held wait')
  // The catalog watcher's own listener leaves with the entry (the rescan
  // unsubscribes it) — post-abort the count is one below the install baseline.
  assert.equal(liveSubs, installSubs - 1, 'the state listener was released on abort')

  // The pool watch was released too: re-adding a fresh client must not wake
  // anything — no new openStream, no pending work.
  const relayA2 = createMultiRelay(SID_A)
  pool.add(makeEntry(SID_A, 'A', relayA2))
  handle.notePoolEvent()
  await settle()
  assert.equal(relayA2.streams.length, 0, 'no waiter leaked to the new client')

  handle.uninstall()
})

test('T5 e2e: real relay server + client auto-prewarms cold-safely, upgrades to visited on open, and preempts on foreground RPC', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-t5-e2e-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const secret = 'a1b2c3d4'.repeat(8)
  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  store.share('s-pre')
  store.share('s-two')
  const serverId = loadServerId(home)

  let nextCount = 0
  let returnCount = 0
  let promoteCalled = false
  let holdSecondSnapshot = null
  const makeRec = (seq, type = 'message') => ({ type: 'event', event: { seq, type, data: { text: `m-${seq}` } } })

  const handler = createRelayHandler({
    secret,
    store,
    serverInfo: { serverId, serverName: () => 'SrvA', dshVersion: '0.2.1', fingerprints: {} },
    gateway: {
      invoke: async (call) => {
        if (call.namespace === 'session' && call.method === 'list') {
          return {
            items: [
              { sessionId: 's-pre', updatedAt: '2026-11-17T10:00:00Z', running: false },
              { sessionId: 's-two', updatedAt: '2026-11-17T09:00:00Z', running: false },
            ],
            hasMore: false,
          }
        }
        if (call.namespace === 'session' && call.method === 'modelCatalog') {
          return { providers: {}, default: undefined }
        }
        if (call.namespace === 'session' && call.method === 'page') {
          return { records: [], hasMore: false }
        }
        return {}
      },
      stream: async (call) => {
        if (call.namespace === 'session' && call.method === 'follow') {
          const id = call.args?.request?.address?.sessionId
          return {
            [Symbol.asyncIterator]() {
              let pulled = 0
              return {
                async next() {
                  nextCount += 1
                  pulled += 1
                  if (id === 's-two' && pulled === 1 && holdSecondSnapshot !== null) {
                    await holdSecondSnapshot.promise
                  }
                  if (pulled === 1) {
                    return {
                      done: false,
                      value: {
                        type: 'snapshot',
                        header: { id },
                        cursor: 2,
                        records: [makeRec(0, 'turn/start'), makeRec(1), makeRec(2)],
                        hasMore: false,
                        projections: { asOfSeq: 2, values: {} },
                        assistantStream: { revision: 0 },
                      },
                    }
                  }
                  promoteCalled = true
                  await new Promise((resolve) => {
                    if (call.signal?.aborted) resolve()
                    else call.signal?.addEventListener('abort', resolve, { once: true })
                  })
                  return { done: true, value: undefined }
                },
                async return() {
                  returnCount += 1
                  return { done: true, value: undefined }
                },
              }
            },
          }
        }
        return (async function* () {})()
      },
    },
  })

  const srv = http.createServer((req, res) => {
    req.headers['x-zen-remote-secret'] = secret
    req.headers['x-zen-remote-via'] = 'gateway'
    req.headers['x-zen-remote-role'] = 'desktop-client'
    req.headers['x-zen-remote-device'] = 'dev-t5'
    handler(req, res).catch(() => { try { res.destroy() } catch { /* ignore */ } })
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { srv.closeAllConnections(); srv.close(resolve) }))
  const port = srv.address().port

  const client = createRelayClient({
    getServerUrl: () => `http://127.0.0.1:${port}`,
    getToken: () => 'tok',
    infoRefreshMs: 0,
  })
  t.after(() => client.stop())
  await client.connect()

  let releaseTwo
  holdSecondSnapshot = { promise: new Promise((resolve) => { releaseTwo = resolve }) }
  let abortedPrewarmCount = 0
  const origFetchSnap = client.fetchSessionSnapshot.bind(client)
  client.fetchSessionSnapshot = (req, signal) => {
    signal?.addEventListener('abort', () => { abortedPrewarmCount += 1 }, { once: true })
    return origFetchSnap(req, signal)
  }

  const pool = createFakePool([{
    entryId: `entry-${serverId}`,
    serverId,
    displayName: 'SrvA',
    client,
  }])
  const gateway = new FakeTypertGateway()
  const handle = installIntercept({
    raw: gateway,
    pool,
    prewarm: { proactiveListDelayMs: 20, idleDelayMs: 30 },
  })
  t.after(() => handle.uninstall())

  const deadline = Date.now() + 2000
  while (handle.historyCacheStats().prewarmedCount < 1) {
    if (Date.now() > deadline) throw new Error('timed out waiting for s-prewarm')
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(handler.viewerCount('s-pre'), 0, 'prewarm leaves viewerCount at 0')
  assert.equal(promoteCalled, false, 'prewarm never calls second next() / promote')
  assert.ok(returnCount >= 1)

  const pageRes = await gateway.rpcBridge(
    'session/page',
    { args: { request: { address: { kind: 'session', sessionId: toVirtual(serverId, 's-pre') } } } },
    undefined,
    gateway.operatorPeer(),
  )
  assert.equal(pageRes.ok, true)
  assert.equal(abortedPrewarmCount >= 1, true, 'foreground RPC aborted in-flight prewarm')

  releaseTwo()
  const deadline2 = Date.now() + 2000
  while (handle.historyCacheStats().prewarmedCount < 2) {
    if (Date.now() > deadline2) throw new Error('timed out waiting for s-two prewarm after idle')
    await new Promise((r) => setTimeout(r, 10))
  }

  const ac = new AbortController()
  const iter = (await gateway.wireTap(
    'session/follow',
    { args: { request: { address: { kind: 'session', sessionId: toVirtual(serverId, 's-pre') }, assistantStream: true } } },
    undefined,
    gateway.operatorPeer(),
    ac.signal,
    { signal: ac.signal },
  ))[Symbol.asyncIterator]()
  const opened = await iter.next()
  assert.equal(opened.value.type, 'snapshot')
  assert.equal(opened.value.cursor, 2)
  assert.equal(handle.historyCacheStats().visitedCount, 1)
  ac.abort()
  await iter.return?.()
})
