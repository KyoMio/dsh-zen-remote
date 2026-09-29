/* dsh-zen-remote · global-stream mergers (src/merge-streams.ts, T23b-2)
 *
 * Pure state machines: no gateway, no relay, no network — frames in, frames
 * out. Frame shapes follow the verified 0.2.0 generated codecs (the same
 * ones relay-filter.ts filters by on the server).
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createWorkspaceMerger, createControlMerger, mergeSessionList } = require('../lib/merge-streams.js')
const { toVirtual } = require('../lib/virtual-id.js')

const SID = 'a1b2c3d4'
const NAME = '主服务器'
const V = (id) => toVirtual(SID, id)

const LOCAL_WS = {
  workspaceId: 'ws-local',
  path: '/home/me/local',
  title: '本地',
  sessionIds: ['session-l1'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}
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
const W1 = remoteWorkspace('w-1', '远端一', ['s1', 's2'])
const W2 = remoteWorkspace('w-2', '远端二', ['s3'])
const REMOTE_BASELINE = { type: 'baseline', value: { items: [W1, W2], archivedSessionIds: ['s2'], pinnedSessionIds: ['s3'] } }
const LOCAL_BASELINE = { type: 'baseline', value: { items: [LOCAL_WS], archivedSessionIds: [], pinnedSessionIds: [] } }

function merger() {
  return createWorkspaceMerger({ serverId: SID, serverName: NAME })
}

// -- 1. local baseline first, remote baseline after -----------------------------

test('local baseline passes clean; a later remote baseline becomes upserts + merged order/archived/pinned, never a second baseline', () => {
  const m = merger()
  const localOut = m.onLocal(LOCAL_BASELINE)
  assert.equal(localOut.length, 1)
  assert.equal(localOut[0], LOCAL_BASELINE, 'nothing remote known yet — the baseline passes verbatim, same object')

  const remoteOut = m.onRemote(REMOTE_BASELINE)
  assert.equal(remoteOut.length, 5)
  // one upsert per remote workspace: title prefixed, ids virtualized
  assert.deepEqual(remoteOut[0], {
    type: 'upsert',
    workspace: { ...W1, workspaceId: V('w-1'), title: `${NAME} · 远端一`, sessionIds: [V('s1'), V('s2')] },
  })
  assert.deepEqual(remoteOut[1], {
    type: 'upsert',
    workspace: { ...W2, workspaceId: V('w-2'), title: `${NAME} · 远端二`, sessionIds: [V('s3')] },
  })
  // merged order: local first, remote appended; lists merged
  assert.deepEqual(remoteOut[2], { type: 'order', workspaceIds: ['ws-local', V('w-1'), V('w-2')] })
  assert.deepEqual(remoteOut[3], { type: 'archived', archivedSessionIds: [V('s2')] })
  assert.deepEqual(remoteOut[4], { type: 'pinned', pinnedSessionIds: [V('s3')] })
  // and not a single baseline ever left the remote side
  assert.ok(remoteOut.every((frame) => frame.type !== 'baseline'))
  // the input is never mutated
  assert.deepEqual(REMOTE_BASELINE.value.items[0].sessionIds, ['s1', 's2'])
})

// -- 2. remote baseline BEFORE the local one: cached -----------------------------

test('a remote baseline that arrives first is cached; the local baseline carries the merged order and the upserts follow', () => {
  const m = merger()
  assert.deepEqual(m.onRemote(REMOTE_BASELINE), [], 'the UI has seen nothing — cache only')

  const out = m.onLocal(LOCAL_BASELINE)
  assert.equal(out.length, 3)
  const [baseline, upsert1, upsert2] = out
  assert.equal(baseline.type, 'baseline')
  // the baseline's own order already ends with the remote ids; the lists merged
  assert.deepEqual(baseline.value.items.map((w) => w.workspaceId), ['ws-local', V('w-1'), V('w-2')])
  assert.deepEqual(baseline.value.items[1], { ...W1, workspaceId: V('w-1'), title: `${NAME} · 远端一`, sessionIds: [V('s1'), V('s2')] })
  assert.deepEqual(baseline.value.archivedSessionIds, [V('s2')])
  assert.deepEqual(baseline.value.pinnedSessionIds, [V('s3')])
  // the upserts restate the remote content
  assert.deepEqual(upsert1, { type: 'upsert', workspace: { ...W1, workspaceId: V('w-1'), title: `${NAME} · 远端一`, sessionIds: [V('s1'), V('s2')] } })
  assert.deepEqual(upsert2, { type: 'upsert', workspace: { ...W2, workspaceId: V('w-2'), title: `${NAME} · 远端二`, sessionIds: [V('s3')] } })
  assert.ok(out.every((frame) => frame.type !== 'baseline' || frame === baseline))
})

// -- 3. local order increments keep the remote tail ------------------------------

test('a local order increment still carries the remote ids at its tail; cached increments merge once the baseline lands', () => {
  const m = merger()
  m.onRemote(REMOTE_BASELINE) // cached
  m.onLocal(LOCAL_BASELINE)

  const out = m.onLocal({ type: 'order', workspaceIds: ['ws-other', 'ws-local'] })
  assert.deepEqual(out, [{ type: 'order', workspaceIds: ['ws-other', 'ws-local', V('w-1'), V('w-2')] }])
  // and the merger remembers the new local order for later merged frames
  const again = m.onRemote({ type: 'order', workspaceIds: ['w-2', 'w-1'] })
  assert.deepEqual(again, [{ type: 'order', workspaceIds: ['ws-other', 'ws-local', V('w-2'), V('w-1')] }])

  // with no remote state a local order is verbatim
  const empty = merger()
  assert.deepEqual(empty.onLocal({ type: 'order', workspaceIds: ['a'] }), [{ type: 'order', workspaceIds: ['a'] }])
})

// -- 4. remote increments ---------------------------------------------------------

test('remote upsert of a KNOWN workspace: one upsert, no order frame', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  const renamed = remoteWorkspace('w-1', '改名', ['s1', 's2', 's9'])
  const out = m.onRemote({ type: 'upsert', workspace: renamed })
  assert.deepEqual(out, [{ type: 'upsert', workspace: { ...renamed, workspaceId: V('w-1'), title: `${NAME} · 改名`, sessionIds: [V('s1'), V('s2'), V('s9')] } }])
})

test('remote upsert of a NEW workspace: upsert + merged order', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  const w3 = remoteWorkspace('w-3', '新组', ['s4'])
  const out = m.onRemote({ type: 'upsert', workspace: w3 })
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { type: 'upsert', workspace: { ...w3, workspaceId: V('w-3'), title: `${NAME} · 新组`, sessionIds: [V('s4')] } })
  assert.deepEqual(out[1], { type: 'order', workspaceIds: ['ws-local', V('w-1'), V('w-2'), V('w-3')] })
})

test('remote remove: virtual remove + merged order; an unknown remove is a silent no-op', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  const out = m.onRemote({ type: 'remove', workspaceId: 'w-1' })
  assert.deepEqual(out, [
    { type: 'remove', workspaceId: V('w-1') },
    { type: 'order', workspaceIds: ['ws-local', V('w-2')] },
  ])
  assert.deepEqual(m.onRemote({ type: 'remove', workspaceId: 'w-ghost' }), [])
})

test('remote order / archived / pinned each emit the merged frame', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  assert.deepEqual(m.onRemote({ type: 'order', workspaceIds: ['w-2', 'w-1'] }), [
    { type: 'order', workspaceIds: ['ws-local', V('w-2'), V('w-1')] },
  ])
  assert.deepEqual(m.onRemote({ type: 'archived', archivedSessionIds: ['s1', 's3'] }), [
    { type: 'archived', archivedSessionIds: [V('s1'), V('s3')] },
  ])
  assert.deepEqual(m.onRemote({ type: 'pinned', pinnedSessionIds: [] }), [
    { type: 'pinned', pinnedSessionIds: [] },
  ])
  // a partial remote order keeps unmentioned workspaces at the tail
  assert.deepEqual(m.onRemote({ type: 'order', workspaceIds: ['w-2'] }), [
    { type: 'order', workspaceIds: ['ws-local', V('w-2'), V('w-1')] },
  ])
})

test('remote increments before the local baseline stay cached and unknown types are dropped with a diagnostic', () => {
  const dropped = []
  const m = createWorkspaceMerger({ serverId: SID, serverName: NAME, onDiagnostic: (message) => dropped.push(message) })
  assert.deepEqual(m.onRemote({ type: 'upsert', workspace: W1 }), [])
  assert.deepEqual(m.onRemote({ type: 'order', workspaceIds: ['w-1'] }), [])
  assert.deepEqual(m.onRemote({ type: 'archived', archivedSessionIds: ['s1'] }), [])
  assert.deepEqual(m.onRemote({ type: 'pinned', pinnedSessionIds: ['s1'] }), [])
  assert.deepEqual(m.onRemote({ type: 'time-travel' }), [])
  assert.equal(dropped.length, 1)
  assert.match(dropped[0], /time-travel/)
  // The cached state was never OUTPUT, but it is state: the local baseline
  // merges it in exactly like test 2 (order appended, lists merged, upsert
  // restated) instead of starting from a clean sheet.
  const local = m.onLocal(LOCAL_BASELINE)
  assert.equal(local.length, 2)
  assert.deepEqual(local[0].value.items.map((w) => w.workspaceId), ['ws-local', V('w-1')])
  assert.deepEqual(local[0].value.archivedSessionIds, [V('s1')])
  assert.deepEqual(local[0].value.pinnedSessionIds, [V('s1')])
  assert.deepEqual(local[1], { type: 'upsert', workspace: { ...W1, workspaceId: V('w-1'), title: `${NAME} · 远端一`, sessionIds: [V('s1'), V('s2')] } })
  // and a later local order keeps the remote tail
  const out = m.onLocal({ type: 'order', workspaceIds: ['ws-local'] })
  assert.deepEqual(out, [{ type: 'order', workspaceIds: ['ws-local', V('w-1')] }])
})

// -- 5. onRemoteGone ---------------------------------------------------------------

test('onRemoteGone removes every shown remote workspace and restores the local-only order/lists; idempotent after that', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  const out = m.onRemoteGone()
  assert.deepEqual(out, [
    { type: 'remove', workspaceId: V('w-1') },
    { type: 'remove', workspaceId: V('w-2') },
    { type: 'order', workspaceIds: ['ws-local'] },
    { type: 'archived', archivedSessionIds: [] },
    { type: 'pinned', pinnedSessionIds: [] },
  ])
  assert.deepEqual(m.onRemoteGone(), [], 'a second gone has nothing left to remove')
  // local frames are verbatim again
  assert.deepEqual(m.onLocal({ type: 'order', workspaceIds: ['ws-local'] }), [{ type: 'order', workspaceIds: ['ws-local'] }])
})

test('onRemoteGone before the local baseline discards the cached state silently', () => {
  const m = merger()
  m.onRemote(REMOTE_BASELINE)
  assert.deepEqual(m.onRemoteGone(), [])
  // and the merger is reusable: a fresh remote baseline after the local one works
  m.onLocal(LOCAL_BASELINE)
  assert.equal(m.onRemote(REMOTE_BASELINE).length, 5)
})

// -- 6. the control merger -----------------------------------------------------------

test('control: a remote baseline is exploded into per-key projections with virtual ids; local frames pass through', () => {
  const m = createControlMerger({ serverId: SID })
  const localFrame = { type: 'baseline', value: { projections: { 'session-local': { asOfSeq: 3, values: { title: 'L' } } } } }
  assert.deepEqual(m.onLocal(localFrame), [localFrame], 'local control frames are verbatim')

  const out = m.onRemote({
    type: 'baseline',
    value: { projections: { s1: { asOfSeq: 7, values: { title: '远端标题', sessionListMetadata: { blank: false, lastPromptAt: 5 } } } } },
  })
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { type: 'projection', sessionId: V('s1'), key: 'title', value: '远端标题', seq: 7 })
  assert.deepEqual(out[1], {
    type: 'projection',
    sessionId: V('s1'),
    key: 'sessionListMetadata',
    value: { blank: false, lastPromptAt: 5 },
    seq: 7,
  })
  assert.ok(out.every((frame) => frame.type !== 'baseline'))

  // live single-key updates virtualize the session id, everything else verbatim
  assert.deepEqual(m.onRemote({ type: 'projection', sessionId: 's1', key: 'title', value: '新', seq: 8 }), [
    { type: 'projection', sessionId: V('s1'), key: 'title', value: '新', seq: 8 },
  ])
  // unknown types dropped; onRemoteGone is silent by design
  const dropped = []
  const diag = createControlMerger({ serverId: SID, onDiagnostic: (message) => dropped.push(message) })
  assert.deepEqual(diag.onRemote({ type: 'mystery' }), [])
  assert.deepEqual(diag.onRemote({ type: 'projection', key: 'title', value: null, seq: 1 }), [])
  assert.equal(dropped.length, 2)
  assert.deepEqual(m.onRemoteGone(), [])
})

test('control: retarget moves the virtualization to the new server id', () => {
  const m = createControlMerger({ serverId: SID })
  m.retarget({ serverId: 'ffffffff', serverName: '新' })
  assert.deepEqual(m.onRemote({ type: 'projection', sessionId: 's1', key: 'title', value: 'x', seq: 1 }), [
    { type: 'projection', sessionId: toVirtual('ffffffff', 's1'), key: 'title', value: 'x', seq: 1 },
  ])
})

test('workspace merger retarget keeps the observed local state and switches the virtual prefix', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  m.onRemoteGone()
  m.retarget({ serverId: 'ffffffff', serverName: '新服务器' })
  const out = m.onRemote({ type: 'baseline', value: { items: [W1], archivedSessionIds: [], pinnedSessionIds: [] } })
  assert.deepEqual(out[0].workspace.workspaceId, toVirtual('ffffffff', 'w-1'))
  assert.equal(out[0].workspace.title, '新服务器 · 远端一')
  assert.deepEqual(out[1], { type: 'order', workspaceIds: ['ws-local', toVirtual('ffffffff', 'w-1')] })
})

// -- 7. session/list ------------------------------------------------------------------

test('mergeSessionList: first page appends the virtualized remote items after the local ones, local fields rule', () => {
  const local = { items: [{ sessionId: 'session-local', updatedAt: 9 }], nextPageToken: 'tok-9' }
  const remote = { items: [{ sessionId: 's1', updatedAt: 2 }, { junk: true }] }
  const merged = mergeSessionList(local, remote, SID)
  assert.deepEqual(merged, {
    items: [{ sessionId: 'session-local', updatedAt: 9 }, { sessionId: V('s1'), updatedAt: 2 }, { junk: true }],
    nextPageToken: 'tok-9',
  })
  assert.deepEqual(merged.nextPageToken, 'tok-9')
  // inputs untouched
  assert.equal(remote.items[0].sessionId, 's1')
})

test('mergeSessionList: a missing or malformed remote result returns the local result as-is', () => {
  const local = { items: [{ sessionId: 'session-local', updatedAt: 9 }] }
  assert.equal(mergeSessionList(local, undefined, SID), local)
  assert.equal(mergeSessionList(local, null, SID), local)
  assert.equal(mergeSessionList(local, { noItems: true }, SID), local)
  assert.equal(mergeSessionList(local, { items: 'junk' }, SID), local)
  // a local result without items still merges around an empty local list
  assert.deepEqual(mergeSessionList({ ok: 1 }, { items: [] }, SID), { ok: 1, items: [] })
})
