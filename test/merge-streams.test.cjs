/* dsh-zen-remote · global-stream mergers (src/merge-streams.ts, T23b-2 + T23b2-fix)
 *
 * Pure state machines: no gateway, no relay, no network — frames in, frames
 * out. Frame shapes follow the verified 0.2.0 generated codecs (the same
 * ones relay-filter.ts filters by on the server). The disconnect semantics
 * follow the corrected spec: a mere remote death NEVER removes — the UI's
 * ClientWorkspaceModel.remove() blacklists ids forever (verified against the
 * real RT model below) — only a serverId change or unpair/revocation does.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createWorkspaceMerger, createControlMerger, mergeSessionList, mergeModelCatalogs, virtualizeModelSelectionValue } = require('../lib/merge-streams.js')
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
  // merged order: local first, remote appended; lists merged; no removes on
  // first contact (nothing shown yet)
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

test('CP4-client-fix2: a session the server stopped serving keeps a TOMBSTONE in its last group — no archived frame', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  // The server closed s1's remote: the filtered upsert carries only s2, and
  // the forwarded record still lists s1 — appended at the end. No archived
  // frame: the RT navigation guard (clearArchivedCurrent) keys on that list,
  // and an archived CURRENT session would be kicked off its page.
  const out = m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['s2']) })
  assert.deepEqual(out, [
    { type: 'upsert', workspace: { ...remoteWorkspace('w-1', '远端一', ['s2']), workspaceId: V('w-1'), title: `${NAME} · 远端一`, sessionIds: [V('s2'), V('s1')] } },
  ])
  // A later refresher upsert (a rename) keeps carrying the tombstone.
  const again = m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '改名', ['s2']) })
  assert.deepEqual(again, [
    { type: 'upsert', workspace: { ...remoteWorkspace('w-1', '改名', ['s2']), workspaceId: V('w-1'), title: `${NAME} · 改名`, sessionIds: [V('s2'), V('s1')] } },
  ])
})

test('CP4-client-fix2: a re-shared session returns to its live position — once, tombstone cleared', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['s2']) }) // s1 tombstoned
  // Back in the SAME group: the live list rules, no tombstone duplicate.
  const back = m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['s2', 's1']) })
  assert.deepEqual(back, [
    { type: 'upsert', workspace: { ...remoteWorkspace('w-1', '远端一', ['s2', 's1']), workspaceId: V('w-1'), title: `${NAME} · 远端一`, sessionIds: [V('s2'), V('s1')] } },
  ])
  // Shared into a DIFFERENT group instead: the home moves, the old group
  // drops the tombstone.
  m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['s2']) }) // s1 tombstoned again
  const moved = m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-2', '远端二', ['s3', 's1']) })
  assert.deepEqual(moved, [
    { type: 'upsert', workspace: { ...remoteWorkspace('w-2', '远端二', ['s3', 's1']), workspaceId: V('w-2'), title: `${NAME} · 远端二`, sessionIds: [V('s3'), V('s1')] } },
  ])
  // w-1 no longer carries it: refresh w-1 (a rename) and look.
  const refresh = m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '改名', ['s2']) })
  assert.deepEqual(refresh, [
    { type: 'upsert', workspace: { ...remoteWorkspace('w-1', '改名', ['s2']), workspaceId: V('w-1'), title: `${NAME} · 改名`, sessionIds: [V('s2')] } },
  ])
})

test('remote remove: virtual remove + merged order; the group\'s tombstones die with it; an unknown remove is a silent no-op', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['s2']) }) // s1 tombstoned in w-1
  const out = m.onRemote({ type: 'remove', workspaceId: 'w-1' })
  // No archived frame: CP4-client-fix2 removed the orphan hiding — a remove
  // takes the whole group AND its tombstones away.
  assert.deepEqual(out, [
    { type: 'remove', workspaceId: V('w-1') },
    { type: 'order', workspaceIds: ['ws-local', V('w-2')] },
  ])
  // A same-id group re-shared by the server carries no old tombstone.
  const recreated = m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '新组', ['s9']) })
  assert.deepEqual(recreated[0].workspace.sessionIds, [V('s9')])
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

// -- 5. the disconnect lifecycle (T23b2-fix) ---------------------------------------

test('onRemoteDown emits nothing and KEEPS the shown state: a reconnecting baseline diffs against it', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)

  // The carrier dies: no remove may reach the UI — ClientWorkspaceModel
  // would blacklist the virtual ids forever.
  assert.deepEqual(m.onRemoteDown(), [])
  // The shown state survives: local frames merge with the remote tail again.
  assert.deepEqual(m.onLocal({ type: 'order', workspaceIds: ['ws-local'] }), [
    { type: 'order', workspaceIds: ['ws-local', V('w-1'), V('w-2')] },
  ])

  // Reconnect: the new baseline diffs against the shown set — same content,
  // so upserts only (content refresh), NO removes.
  const again = m.onRemote(REMOTE_BASELINE)
  assert.deepEqual(again.map((frame) => frame.type), ['upsert', 'upsert', 'order', 'archived', 'pinned'])
})

test('a reconnecting baseline removes only workspaces the server dropped', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  assert.deepEqual(m.onRemoteDown(), [])

  // The server deleted w-1 (and w-2 got a new title): the diff shows it, and
  // w-1's sessions leave WITH the group — their tombstones die with it, the
  // archived set holds only the server's own archived sessions.
  const out = m.onRemote({ type: 'baseline', value: { items: [remoteWorkspace('w-2', '改名了', ['s3'])], archivedSessionIds: [], pinnedSessionIds: [] } })
  assert.deepEqual(out, [
    { type: 'upsert', workspace: { ...remoteWorkspace('w-2', '改名了', ['s3']), workspaceId: V('w-2'), title: `${NAME} · 改名了`, sessionIds: [V('s3')] } },
    { type: 'remove', workspaceId: V('w-1') },
    { type: 'order', workspaceIds: ['ws-local', V('w-2')] },
    { type: 'archived', archivedSessionIds: [] },
    { type: 'pinned', pinnedSessionIds: [] },
  ])
  // a second identical baseline: still-present → upserts only
  const again = m.onRemote({ type: 'baseline', value: { items: [remoteWorkspace('w-2', '改名了', ['s3'])], archivedSessionIds: [], pinnedSessionIds: [] } })
  assert.deepEqual(again.map((frame) => frame.type), ['upsert', 'order', 'archived', 'pinned'])
})

test('onRemoteDown before the local baseline discards nothing and the cached state still flushes with the baseline', () => {
  const m = merger()
  m.onRemote(REMOTE_BASELINE)
  assert.deepEqual(m.onRemoteDown(), [])
  const out = m.onLocal(LOCAL_BASELINE)
  assert.equal(out.length, 3, 'the cached remote state still lands with the baseline')
  assert.deepEqual(out[0].value.items.map((w) => w.workspaceId), ['ws-local', V('w-1'), V('w-2')])
})

test('onServerRenamed re-upserts the shown groups under the new title — no removes, no order churn', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  m.retarget({ serverId: SID, serverName: '改名的服务器' })
  const out = m.onServerRenamed()
  assert.deepEqual(out, [
    { type: 'upsert', workspace: { ...W1, workspaceId: V('w-1'), title: '改名的服务器 · 远端一', sessionIds: [V('s1'), V('s2')] } },
    { type: 'upsert', workspace: { ...W2, workspaceId: V('w-2'), title: '改名的服务器 · 远端二', sessionIds: [V('s3')] } },
  ])
  // nothing shown yet (or nothing remote): a no-op
  const fresh = merger()
  fresh.onRemote(REMOTE_BASELINE)
  fresh.retarget({ serverId: SID, serverName: 'x' })
  assert.deepEqual(fresh.onServerRenamed(), [])
})

test('onRemoteGone (serverId change / unpair / revoke) removes the whole group and resets; idempotent after that', () => {
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

test('CP4-client-fix2: onRemoteGone clears the tombstones with the identity — the new server never sees them', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['s2']) }) // s1 tombstoned
  m.onRemoteGone()
  m.retarget({ serverId: 'ffffffff', serverName: '新服务器' })
  // A same-named workspace on the NEW server lists only what the server sent.
  const out = m.onRemote({ type: 'baseline', value: { items: [remoteWorkspace('w-1', '远端一', ['s2'])], archivedSessionIds: [], pinnedSessionIds: [] } })
  assert.deepEqual(out[0].workspace.sessionIds, [toVirtual('ffffffff', 's2')])
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
  diag.onLocal({ type: 'baseline', value: { projections: {} } })
  assert.deepEqual(diag.onRemote({ type: 'mystery' }), [])
  assert.deepEqual(diag.onRemote({ type: 'projection', key: 'title', value: null, seq: 1 }), [])
  assert.equal(dropped.length, 2)
  assert.deepEqual(m.onRemoteGone(), [])
})

test('control: remote frames before the local baseline are buffered, then flushed after it (update-before-snapshot is a UI protocol violation)', () => {
  const m = createControlMerger({ serverId: SID })
  // Remote traffic lands first — it must NOT reach the UI.
  assert.deepEqual(m.onRemote({
    type: 'baseline',
    value: { projections: { s1: { asOfSeq: 7, values: { title: '远端' } } } },
  }), [])
  assert.deepEqual(m.onRemote({ type: 'projection', sessionId: 's1', key: 'title', value: '改', seq: 8 }), [])

  // The local baseline opens the stream; the buffered output follows it.
  const localBaseline = { type: 'baseline', value: { projections: {} } }
  const out = m.onLocal(localBaseline)
  assert.equal(out.length, 3)
  assert.equal(out[0], localBaseline)
  assert.deepEqual(out[1], { type: 'projection', sessionId: V('s1'), key: 'title', value: '远端', seq: 7 })
  assert.deepEqual(out[2], { type: 'projection', sessionId: V('s1'), key: 'title', value: '改', seq: 8 })

  // afterwards remote frames flow directly again
  assert.deepEqual(m.onRemote({ type: 'projection', sessionId: 's1', key: 'title', value: '再改', seq: 9 }), [
    { type: 'projection', sessionId: V('s1'), key: 'title', value: '再改', seq: 9 },
  ])
  // a second local baseline is a passthrough (no double flush)
  assert.deepEqual(m.onLocal({ type: 'baseline', value: { projections: {} } }).length, 1)
})

test('control: a zero-event session (asOfSeq -1) is skipped with a diagnostic, never clamped to 0', () => {
  const dropped = []
  const m = createControlMerger({ serverId: SID, onDiagnostic: (message) => dropped.push(message) })
  m.onLocal({ type: 'baseline', value: { projections: {} } })
  // A zero-event session has asOfSeq -1; the UI's SessionSeq throws on
  // negative seqs, so the record must be skipped — and NOT rewritten to 0:
  // the UI compares `seq <= held → drop`, so a clamped 0 would swallow the
  // real seq-0 entry.
  const out = m.onRemote({
    type: 'baseline',
    value: { projections: { 's-empty': { asOfSeq: -1, values: { title: '空会话' } }, 's-live': { asOfSeq: 4, values: { title: '活着' } } } },
  })
  assert.deepEqual(out, [{ type: 'projection', sessionId: V('s-live'), key: 'title', value: '活着', seq: 4 }])
  assert.equal(dropped.length, 1)
  assert.match(dropped[0], /s-empty/)
  assert.match(dropped[0], /-1/)

  // the same hazard on live updates (a synthesized projection of a
  // newly-shared zero-event session carries the same -1)
  assert.deepEqual(m.onRemote({ type: 'projection', sessionId: 's-empty', key: 'title', value: 'x', seq: -1 }), [])
  assert.deepEqual(dropped.length, 2)
  // seq 0 is a legitimate value and passes
  assert.deepEqual(m.onRemote({ type: 'projection', sessionId: 's', key: 'title', value: 'x', seq: 0 }), [
    { type: 'projection', sessionId: V('s'), key: 'title', value: 'x', seq: 0 },
  ])
})

test('control: retarget moves the virtualization to the new server id', () => {
  const m = createControlMerger({ serverId: SID })
  m.onLocal({ type: 'baseline', value: { projections: {} } })
  m.retarget({ serverId: 'ffffffff', serverName: '新' })
  assert.deepEqual(m.onRemote({ type: 'projection', sessionId: 's1', key: 'title', value: 'x', seq: 1 }), [
    { type: 'projection', sessionId: toVirtual('ffffffff', 's1'), key: 'title', value: 'x', seq: 1 },
  ])
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

test('T52-fix3 mergeSessionList: a row\'s projections.modelSelection is virtualized unconditionally — a sequenced block must not poison the projection store', () => {
  // RT dsh-api-session-controller lib/typert.remote-client.js:381-428: a
  // list row carries {kind:'cached'|'sequenced', asOfSeq, values}; the client
  // face applies it per session (lib/client.js:2633 → applyListBlock
  // :2842-2855) and a sequenced modelSelection lands under higher-seq-wins
  // (lib/client.js:986-995) — the control stream's rewritten frame rides the
  // SAME seq, so an original-provider value here would permanently win.
  const selection = { lastUsed: { provider: 'codex', model: 'sol' }, next: { provider: 'codex', model: 'sol' } }
  const local = { items: [{ sessionId: 'session-local', updatedAt: 9 }] }
  const remote = {
    items: [
      {
        sessionId: 's1',
        updatedAt: 2,
        projections: { kind: 'sequenced', asOfSeq: 7, values: { modelSelection: selection, title: '远端' } },
      },
      // cached kind gets the same rewrite — the store applies it wherever no
      // sequenced row holds (lib/client.js:1004-1013).
      { sessionId: 's2', updatedAt: 3, projections: { kind: 'cached', asOfSeq: 1, values: { modelSelection: selection } } },
      // a row without a projections block (or without a modelSelection key)
      // passes untouched.
      { sessionId: 's3', updatedAt: 4 },
      { sessionId: 's4', updatedAt: 5, projections: { kind: 'sequenced', asOfSeq: 2, values: { title: '无模型' } } },
    ],
  }
  const merged = mergeSessionList(local, remote, SID)
  const [r1, r2, r3, r4] = merged.items.slice(1)
  assert.deepEqual(r1.projections.values.modelSelection, {
    lastUsed: { provider: V('codex'), model: 'sol' },
    next: { provider: V('codex'), model: 'sol' },
  })
  assert.equal(r1.projections.kind, 'sequenced', 'kind and seq ride unchanged')
  assert.equal(r1.projections.asOfSeq, 7)
  assert.equal(r1.projections.values.title, '远端', 'the other projection values stay verbatim')
  assert.equal(r2.projections.values.modelSelection.next.provider, V('codex'))
  assert.equal(r3.projections, undefined)
  assert.deepEqual(r4.projections.values, { title: '无模型' })
  // the LOCAL rows never enter the rewrite (their ids and blocks are local)
  assert.deepEqual(merged.items[0], { sessionId: 'session-local', updatedAt: 9 })
  // inputs untouched
  assert.equal(remote.items[0].projections.values.modelSelection.lastUsed.provider, 'codex')

  // T52-fix3: the rewrite does not depend on any catalog knowledge at all —
  // first-write-wins per seq forbids a gate (a pre-catalog original would
  // occupy the seq forever), so even a provider NO catalog lists goes
  // virtual. Accepted cost: the UI renders the `zr~…` fallback for it.
  const again = mergeSessionList(local, remote, SID)
  assert.deepEqual(again.items[1].projections.values.modelSelection, {
    lastUsed: { provider: V('codex'), model: 'sol' },
    next: { provider: V('codex'), model: 'sol' },
  }, 'the rewrite is the same with or without a fetched catalog')
})

test('T52-fix3 mergeSessionList: first-write-wins store — control baseline before the catalog, list row after, the store still ends virtual', () => {
  // The poison-ref repro (scratchpad/poison-ref.mjs), as a regression pin:
  // the host's projection store applies first-write-wins per seq
  // (dsh-api-session-controller lib/client.js:986-994 —
  // `if (row?.kind === 'sequenced' && seq <= row.seq) return`, the seed /
  // list blocks take the same road). T52-fix2's catalog gate projected an
  // ORIGINAL provider from the control baseline while the catalog had not
  // landed; the same seq's VIRTUAL list row was then dropped as stale and
  // the store kept the original forever. The rewrite must therefore be
  // identical whenever it runs.
  const store = new Map()
  const apply = (key, value, seq) => {
    const row = store.get(key)
    if (row !== undefined && seq <= row.seq) return 'ignored'
    store.set(key, { value, seq })
    return 'applied'
  }
  const selection = { lastUsed: null, next: { provider: 'codex', model: 'sol' } }
  // The control baseline arrives FIRST — no catalog anywhere in sight.
  const m = createControlMerger({ serverId: SID })
  m.onLocal({ type: 'baseline', value: { projections: {} } })
  const [frame] = m.onRemote({ type: 'baseline', value: { projections: { s1: { asOfSeq: 7, values: { modelSelection: selection } } } } })
  assert.equal(apply('s1/modelSelection', frame.value, frame.seq), 'applied')
  assert.equal(store.get('s1/modelSelection').value.next.provider, V('codex'), 'the pre-catalog baseline already lands virtual')

  // The catalog lands later and the list row re-states the SAME seq — the
  // store rejects it as stale, which is harmless ONLY because the rewrite
  // was identical.
  const list = mergeSessionList(
    { items: [] },
    { items: [{ sessionId: 's1', projections: { kind: 'sequenced', asOfSeq: 7, values: { modelSelection: selection } } }] },
    SID,
  )
  const block = list.items[0].projections
  assert.equal(block.values.modelSelection.next.provider, V('codex'), 'the list row rewrites to the very same virtual value')
  assert.equal(apply('s1/modelSelection', block.values.modelSelection, block.asOfSeq), 'ignored', 'same seq is first-write-wins')
  assert.equal(store.get('s1/modelSelection').value.next.provider, V('codex'), 'the store ends with the virtual provider — no poison')
})

test('mergeSessionList: parentSessionId is virtualized with the row (CP4) — the fork link must point at the id the UI knows', () => {
  const local = { items: [] }
  const remote = {
    items: [
      { sessionId: 's1', parentSessionId: 's0', updatedAt: 2 },
      { sessionId: 's2', updatedAt: 3 },
      { junk: true },
    ],
  }
  const merged = mergeSessionList(local, remote, SID)
  assert.deepEqual(merged.items, [
    { sessionId: V('s1'), parentSessionId: V('s0'), updatedAt: 2 },
    { sessionId: V('s2'), updatedAt: 3 },
    { junk: true },
  ])
})

// -- 8. driven through the REAL DSH UI model ------------------------------------------

/**
 * The real `ClientWorkspaceModel`, loaded from this repo's OWN devDependency
 * (`@deepseek-ai/dsh-api-workspace-controller` 0.1.7-rc.2 — its
 * `ClientWorkspaceModel.remove()` records ids in the never-cleared
 * `removedIds` set exactly like the 0.2.0 build, `upsert` and baseline
 * replacement both drop blacklisted ids), driven exactly like the host
 * drives it. The bundle is a browser-style `window.__ModuleLoader__` module:
 * shim the loader with a require stub answering the module shapes its
 * neighbours need (the model itself touches none of them) and let Node
 * execute the file through its `exports["./client"]` subpath.
 */
const workspaceClient = (() => {
  let mod
  global.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => ({ isRemoteFailure: () => true, Service: class {}, RemoteSnapshotStream: class {} })) } } }
  require(require.resolve('@deepseek-ai/dsh-api-workspace-controller/client'))
  if (typeof mod?.ClientWorkspaceModel !== 'function') {
    throw new Error('dsh-api-workspace-controller/client did not export ClientWorkspaceModel')
  }
  return mod
})()

function createUiModel() {
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

test('RT UI model: a disconnect keeps the remote groups and the reconnecting baseline revives them (the old remove-based flow made them un-revivable)', () => {
  const m = merger()
  const ui = createUiModel()
  m.onLocal(LOCAL_BASELINE).forEach(ui.apply)
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)
  assert.equal(ui.ids(), `ws-local,${V('w-1')},${V('w-2')}`)

  // carrier loss — the OLD flow emitted removes here, which permanently
  // blacklisted the ids (upsert and baseline replacement drop blacklisted
  // ids in ClientWorkspaceModel)
  m.onRemoteDown().forEach(ui.apply)
  assert.equal(ui.ids(), `ws-local,${V('w-1')},${V('w-2')}`, 'nothing left the UI')

  // reconnect with the same server: the diffed baseline revives nothing
  // because nothing left — the groups stay visible
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)
  assert.equal(ui.ids(), `ws-local,${V('w-1')},${V('w-2')}`)
  assert.equal(ui.model.items[1].title, `${NAME} · 远端一`)
})

test('RT UI model: the server deleting a workspace removes only that one', () => {
  const m = merger()
  const ui = createUiModel()
  m.onLocal(LOCAL_BASELINE).forEach(ui.apply)
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)
  m.onRemoteDown().forEach(ui.apply)

  m.onRemote({ type: 'baseline', value: { items: [W2], archivedSessionIds: [], pinnedSessionIds: [] } }).forEach(ui.apply)
  assert.equal(ui.ids(), `ws-local,${V('w-2')}`, 'only w-1 left')
})

test('RT UI model: a server rename updates the titles without removing anything', () => {
  const m = merger()
  const ui = createUiModel()
  m.onLocal(LOCAL_BASELINE).forEach(ui.apply)
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)

  m.retarget({ serverId: SID, serverName: '新名字' })
  m.onServerRenamed().forEach(ui.apply)
  assert.equal(ui.ids(), `ws-local,${V('w-1')},${V('w-2')}`, 'the groups never left')
  assert.equal(ui.model.items[1].title, '新名字 · 远端一')
})

test('RT UI model: a serverId change swaps the whole group — old prefix gone, new prefix appears', () => {
  const m = merger()
  const ui = createUiModel()
  m.onLocal(LOCAL_BASELINE).forEach(ui.apply)
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)

  m.onRemoteGone().forEach(ui.apply)
  assert.equal(ui.ids(), 'ws-local', 'the old group left')

  m.retarget({ serverId: 'ffffffff', serverName: '新服务器' })
  m.onRemote({ type: 'baseline', value: { items: [W1], archivedSessionIds: [], pinnedSessionIds: [] } }).forEach(ui.apply)
  assert.equal(ui.ids(), `ws-local,${toVirtual('ffffffff', 'w-1')}`, 'the NEW prefix is not blacklisted')
})

test('RT UI model: a revocation clears every remote group', () => {
  const m = merger()
  const ui = createUiModel()
  m.onLocal(LOCAL_BASELINE).forEach(ui.apply)
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)

  m.onRemoteGone().forEach(ui.apply)
  assert.equal(ui.ids(), 'ws-local')
})

// -- 8b. tombstones through the REAL DSH UI model (CP4-client-fix2) -------------------

const heldSessions = () => new Set([V('s1'), V('s2'), V('s3'), 'session-l1'])
/** The sidebar's 「未分组」 invariant: every session the UI's store holds must
 * sit in some workspace's sessionIds (or be archived-hidden — which the
 * tombstone design never does for closed remotes). */
function assertNoStrays(ui) {
  const grouped = new Set(ui.model.items.flatMap((item) => item.sessionIds))
  for (const id of heldSessions()) {
    assert.ok(grouped.has(id), `${id} belongs to a group — no 「未分组」 stray`)
  }
}

test('CP4-client-fix2 RT UI model: a closed remote session keeps its group slot — not archived (no page kick), no strays', () => {
  const m = merger()
  const ui = createUiModel()
  m.onLocal(LOCAL_BASELINE).forEach(ui.apply)
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)

  // The server closed s1's remote: the filtered upsert drops it from w-1's
  // sessionIds. RT dsh-client-ui-workspace watchNavigation → clearArchivedCurrent
  // (lib/client.js:897, 957-962) clears the CURRENT session to the home page
  // the moment its id enters archivedSessionIds — the tombstone keeps it OUT
  // of that list, so the open page stays put for its 「远程已关闭」 banner.
  m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['s2']) }).forEach(ui.apply)
  const group = ui.model.items.find((item) => item.workspaceId === V('w-1'))
  assert.deepEqual(group.sessionIds, [V('s2'), V('s1')], 'the closed session still rides its group, appended at the end')
  assert.equal(ui.model.archivedSessionIds.includes(V('s1')), false, 'NOT archived-hidden — the open page is not navigated away')
  assertNoStrays(ui)
})

test('CP4-client-fix2 RT UI model: a re-shared session returns to its live position exactly once', () => {
  const m = merger()
  const ui = createUiModel()
  m.onLocal(LOCAL_BASELINE).forEach(ui.apply)
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)
  m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['s2']) }).forEach(ui.apply) // tombstone

  m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['s2', 's1']) }).forEach(ui.apply)
  const group = ui.model.items.find((item) => item.workspaceId === V('w-1'))
  assert.equal(group.sessionIds.filter((id) => id === V('s1')).length, 1, 'restored once — no tombstone duplicate')
  assert.equal(group.sessionIds.join(','), [V('s2'), V('s1')].join(','), 'the live order rules again')
  assert.equal(ui.model.archivedSessionIds.includes(V('s1')), false)
  assertNoStrays(ui)
})

test('CP4-client-fix2 RT UI model: deleting the workspace takes its tombstones with it', () => {
  const m = merger()
  const ui = createUiModel()
  m.onLocal(LOCAL_BASELINE).forEach(ui.apply)
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)
  m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['s2']) }).forEach(ui.apply) // s1 tombstoned

  m.onRemote({ type: 'remove', workspaceId: 'w-1' }).forEach(ui.apply)
  assert.equal(ui.ids(), `ws-local,${V('w-2')}`, 'the group left, tombstones with it')
  // A same-id group re-shared later carries no old tombstone (frame level —
  // the UI model itself would still blacklist the removed id, the documented
  // ClientWorkspaceModel limitation).
  const [recreated] = m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '新组', ['s9']) })
  assert.deepEqual(recreated.workspace.sessionIds, [V('s9')])
})

test('CP4-client-fix2 RT UI model: a serverId change takes the tombstones away with the old prefix', () => {
  const m = merger()
  const ui = createUiModel()
  m.onLocal(LOCAL_BASELINE).forEach(ui.apply)
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)
  m.onRemote({ type: 'upsert', workspace: remoteWorkspace('w-1', '远端一', ['s2']) }).forEach(ui.apply) // s1 tombstoned

  m.onRemoteGone().forEach(ui.apply)
  assert.equal(ui.ids(), 'ws-local', 'the old groups left with the identity')
  assert.equal(ui.model.archivedSessionIds.includes(V('s1')), false, 'no archived leftovers either')

  m.retarget({ serverId: 'ffffffff', serverName: '新服务器' })
  const frames = m.onRemote({ type: 'baseline', value: { items: [remoteWorkspace('w-1', '远端一', ['s2'])], archivedSessionIds: [], pinnedSessionIds: [] } })
  assert.deepEqual(frames[0].workspace.sessionIds, [toVirtual('ffffffff', 's2')], 'the new server carries no old tombstone')
  frames.forEach(ui.apply)
})

// -- 9. status annotations (T34) -----------------------------------------------------

test('T34: setStatus offline + onStatusChanged re-upserts the shown groups with （离线）titles', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  m.setStatus('offline')
  const out = m.onStatusChanged()
  assert.deepEqual(out, [
    { type: 'upsert', workspace: { ...W1, workspaceId: V('w-1'), title: `${NAME} · 远端一（离线）`, sessionIds: [V('s1'), V('s2')] } },
    { type: 'upsert', workspace: { ...W2, workspaceId: V('w-2'), title: `${NAME} · 远端二（离线）`, sessionIds: [V('s3')] } },
  ])
  // and the annotation rides every later frame until cleared (a local
  // baseline carrying the remote tail, for instance)
  const local = m.onLocal({ ...LOCAL_BASELINE })
  assert.equal(local[0].value.items[1].title, `${NAME} · 远端一（离线）`)
})

test('T34: clearing the annotation and re-baselining restores the plain titles', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  m.setStatus('offline')
  m.onStatusChanged()
  // back online: the intercept layer emits nothing on a CLEAR (the
  // reconnecting baseline does the restore); the merger primitive's
  // onStatusChanged re-upserts the shown groups, now with plain titles
  m.setStatus('none')
  assert.deepEqual(m.onStatusChanged(), [
    { type: 'upsert', workspace: { ...W1, workspaceId: V('w-1'), title: `${NAME} · 远端一`, sessionIds: [V('s1'), V('s2')] } },
    { type: 'upsert', workspace: { ...W2, workspaceId: V('w-2'), title: `${NAME} · 远端二`, sessionIds: [V('s3')] } },
  ])
  const again = m.onRemote(REMOTE_BASELINE)
  assert.deepEqual(again[0], {
    type: 'upsert',
    workspace: { ...W1, workspaceId: V('w-1'), title: `${NAME} · 远端一`, sessionIds: [V('s1'), V('s2')] },
  })
  assert.ok(again.every((frame) => !String(frame.workspace?.title ?? '').includes('（离线）')))
})

test('T34: revoked / unpaired / mismatch annotations each render their suffix', () => {
  const m = merger()
  m.onLocal(LOCAL_BASELINE)
  m.onRemote(REMOTE_BASELINE)
  for (const [annotation, suffix] of [
    ['revoked', '（令牌已吊销）'],
    ['unpaired', '（已解除配对）'],
    ['mismatch', '（版本有差异）'],
  ]) {
    m.setStatus(annotation)
    const [frame] = m.onStatusChanged()
    assert.equal(frame.workspace.title, `${NAME} · 远端一${suffix}`, annotation)
    assert.equal(frame.workspace.workspaceId, V('w-1'))
  }
  // the suffix REPLACES, never stacks: setting revoked after offline renders
  // only the revoked copy (the caller owns the priority)
  m.setStatus('offline')
  m.onStatusChanged()
  m.setStatus('revoked')
  const [frame] = m.onStatusChanged()
  assert.equal(frame.workspace.title, `${NAME} · 远端一（令牌已吊销）`)
  assert.ok(!frame.workspace.title.includes('（离线）'))
})

test('T34: onStatusChanged is silent before the local baseline and with no remote state', () => {
  const m = merger()
  m.setStatus('offline')
  assert.deepEqual(m.onStatusChanged(), [], 'nothing shown yet — cached remote state stays cached')
  m.onRemote(REMOTE_BASELINE)
  assert.deepEqual(m.onStatusChanged(), [], 'still nothing shown')
  m.onLocal(LOCAL_BASELINE)
  // the baseline itself carried the annotation (set before it arrived)
  assert.equal(m.onLocal({ ...LOCAL_BASELINE })[0].value.items[1].title, `${NAME} · 远端一（离线）`)
  const fresh = merger()
  fresh.onLocal(LOCAL_BASELINE)
  fresh.setStatus('offline')
  assert.deepEqual(fresh.onStatusChanged(), [], 'no remote groups — nothing to annotate')
})

test('T34: the control merger accepts setStatus and answers [] — projections carry no titles', () => {
  const m = createControlMerger({ serverId: SID })
  m.onLocal({ type: 'baseline', value: { projections: { s1: { asOfSeq: 1, values: { title: 'L' } } } } })
  m.setStatus('offline')
  assert.deepEqual(m.onStatusChanged(), [])
  // the control stream keeps converting frames normally afterwards
  assert.deepEqual(m.onRemote({ type: 'projection', sessionId: 's1', key: 'title', value: 'x', seq: 2 }), [
    { type: 'projection', sessionId: V('s1'), key: 'title', value: 'x', seq: 2 },
  ])
})

test('T34 RT UI model: offline keeps the groups under annotated titles; the reconnecting baseline restores them', () => {
  const m = merger()
  const ui = createUiModel()
  m.onLocal(LOCAL_BASELINE).forEach(ui.apply)
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)
  assert.equal(ui.ids(), `ws-local,${V('w-1')},${V('w-2')}`)

  m.setStatus('offline')
  m.onStatusChanged().forEach(ui.apply)
  assert.equal(ui.ids(), `ws-local,${V('w-1')},${V('w-2')}`, 'the annotation removed nothing')
  assert.equal(ui.model.items[1].title, `${NAME} · 远端一（离线）`)

  // back online: clear, then the fresh baseline diff re-upserts — plain titles
  m.setStatus('none')
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)
  assert.equal(ui.model.items[1].title, `${NAME} · 远端一`)
})

test('T34 RT UI model: a revoked relay keeps the group under the 吊销 annotation, re-pair restores it', () => {
  const m = merger()
  const ui = createUiModel()
  m.onLocal(LOCAL_BASELINE).forEach(ui.apply)
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)

  m.setStatus('revoked')
  m.onRemoteDown().forEach(ui.apply)
  m.onStatusChanged().forEach(ui.apply)
  assert.equal(ui.ids(), `ws-local,${V('w-1')},${V('w-2')}`, 'the revocation removed nothing (T23b2-fix3)')
  assert.equal(ui.model.items[1].title, `${NAME} · 远端一（令牌已吊销）`)

  // re-paired to the same server: annotation clears, the diffed baseline revives
  m.setStatus('none')
  m.onRemote(REMOTE_BASELINE).forEach(ui.apply)
  assert.equal(ui.model.items[1].title, `${NAME} · 远端一`)
})

// -- 7. the model catalog and the modelSelection projection values (T52) -----------

test('T52 mergeModelCatalogs: server groups append after the local ones with virtual ids and prefixed names; default and failures stay local', () => {
  const local = {
    default: { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
    routableProviders: ['deepseek-account', 'openai'],
    groups: [
      { id: 'deepseek-account', name: 'DeepSeek 账号', models: [{ id: 'deepseek-v4-pro', name: 'V4 Pro' }] },
      { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT' }] },
    ],
    failures: [{ id: 'bad', name: '坏', message: 'x' }],
  }
  const remote = {
    default: { provider: 'codex', model: 'sol' },
    routableProviders: ['codex', 'claude'],
    groups: [
      { id: 'codex', name: 'Codex', models: [{ id: 'sol', name: 'Sol' }] },
      { id: 'claude', name: 'Claude', models: [{ id: 'sonnet', name: 'Sonnet' }] },
      { notAGroup: true },
    ],
    failures: [{ id: 'server-bad', name: '服务端坏', message: 'y' }],
  }
  const merged = mergeModelCatalogs(local, remote, { serverId: SID, serverName: NAME })
  assert.deepEqual(merged.groups, [
    local.groups[0],
    local.groups[1],
    { id: V('codex'), name: `${NAME} · Codex`, models: [{ id: 'sol', name: 'Sol' }] },
    { id: V('claude'), name: `${NAME} · Claude`, models: [{ id: 'sonnet', name: 'Sonnet' }] },
  ])
  // The default drives blank LOCAL sessions; server failures never alarm the
  // dropdown (each failure row's Retry reloads the whole local catalog).
  assert.equal(merged.default, local.default)
  assert.deepEqual(merged.failures, local.failures)
  // routableProviders mirrors the merged group ids (the host derives it as
  // groups.map(g => g.id); no RT client UI reads it — consistency move).
  assert.deepEqual(merged.routableProviders, ['deepseek-account', 'openai', V('codex'), V('claude')])
  // The inputs are never mutated.
  assert.deepEqual(remote.groups[0], { id: 'codex', name: 'Codex', models: [{ id: 'sol', name: 'Sol' }] })

  // A group without a usable id is skipped; a remote side that says nothing
  // (malformed, no groups array) leaves the local answer untouched.
  const partial = mergeModelCatalogs(local, { groups: [{ notAGroup: true }] }, { serverId: SID, serverName: NAME })
  assert.equal(partial, local)
  assert.equal(mergeModelCatalogs(local, undefined, { serverId: SID, serverName: NAME }), local)
  assert.equal(mergeModelCatalogs(undefined, remote, { serverId: SID, serverName: NAME }), undefined)
})

test('T52-fix3 virtualizeModelSelectionValue: providers always go virtual, nulls and foreign keys pass', () => {
  const value = {
    lastUsed: { provider: 'codex', model: 'sol' },
    next: { provider: 'codex', model: 'sol', reasoningEffort: 'high' },
  }
  assert.deepEqual(virtualizeModelSelectionValue(value, SID), {
    lastUsed: { provider: V('codex'), model: 'sol' },
    next: { provider: V('codex'), model: 'sol', reasoningEffort: 'high' },
  })
  // UNCONDITIONAL (T52-fix3, reverting the fix2 catalog gate): the rewrite
  // may not depend on WHEN the catalog arrived — first-write-wins per seq
  // means a pre-catalog original would occupy the seq forever. A provider
  // NO server catalog lists goes virtual all the same; the accepted cost is
  // the `zr~…` fallback string the UI renders for it.
  const foreign = { lastUsed: { provider: 'claude', model: 'sonnet' }, next: null }
  assert.deepEqual(
    virtualizeModelSelectionValue(foreign, SID),
    { lastUsed: { provider: V('claude'), model: 'sonnet' }, next: null },
    'an unlisted provider goes virtual too — the rewrite is catalog-independent',
  )
  assert.deepEqual(
    virtualizeModelSelectionValue({ lastUsed: null, next: null }, SID),
    { lastUsed: null, next: null },
  )
  // A selection without a provider string (or a non-object value) is untouchable.
  assert.deepEqual(virtualizeModelSelectionValue({ lastUsed: { model: 'x' } }, SID), { lastUsed: { model: 'x' } })
  assert.equal(virtualizeModelSelectionValue('nope', SID), 'nope')
})

test('T52-fix3 control merger: modelSelection projection frames get their providers virtualized beside the session id — unconditionally', () => {
  const m = createControlMerger({ serverId: SID })
  m.onLocal({ type: 'baseline', value: { projections: {} } })
  // The exploded baseline path.
  const exploded = m.onRemote({
    type: 'baseline',
    value: { projections: { s1: { asOfSeq: 9, values: { modelSelection: { lastUsed: { provider: 'codex', model: 'sol' }, next: null } } } } },
  })
  assert.deepEqual(exploded, [
    { type: 'projection', sessionId: V('s1'), key: 'modelSelection', value: { lastUsed: { provider: V('codex'), model: 'sol' }, next: null }, seq: 9 },
  ])
  // The live single-key path.
  assert.deepEqual(
    m.onRemote({ type: 'projection', sessionId: 's1', key: 'modelSelection', value: { lastUsed: null, next: { provider: 'codex', model: 'sol' } }, seq: 10 }),
    [{ type: 'projection', sessionId: V('s1'), key: 'modelSelection', value: { lastUsed: null, next: { provider: V('codex'), model: 'sol' } }, seq: 10 }],
  )
  // Any other key stays verbatim.
  assert.deepEqual(m.onRemote({ type: 'projection', sessionId: 's1', key: 'title', value: 't', seq: 11 }), [
    { type: 'projection', sessionId: V('s1'), key: 'title', value: 't', seq: 11 },
  ])

  // T52-fix3: no catalog gate anywhere — a provider no catalog lists goes
  // virtual exactly the same (first-write-wins per seq forbids the gate).
  assert.deepEqual(
    m.onRemote({ type: 'projection', sessionId: 's1', key: 'modelSelection', value: { next: { provider: 'claude', model: 'sonnet' } }, seq: 12 }),
    [{ type: 'projection', sessionId: V('s1'), key: 'modelSelection', value: { next: { provider: V('claude'), model: 'sonnet' } }, seq: 12 }],
    'an unlisted provider is virtualized identically',
  )
})
