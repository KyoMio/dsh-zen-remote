/* dsh-zen-remote · T22b relay frame filters (src/relay-filter.ts)
 *
 * The frame shapes below are pinned to the generated codecs in the 0.2.0
 * `lib/typert.remote-client.js` of the workspace / session / job controller
 * packages: `baseline` nests under `value`, every increment frame carries its
 * fields at the top level. Each test also proves the input is left untouched
 * (deep-compared against a pre-call clone) and that unrecognized frame types
 * come back as null — the drop-me-not-leak-me contract.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  filterWorkspaceFrame,
  filterControlFrame,
  filterSessionListResult,
  filterJobListFrame,
  createWorkspaceFollowState,
} = require('../lib/relay-filter.js')

const yes = () => true
const no = () => false
const only = (shared) => (id) => shared.includes(id)

/** The input a filter must not touch: a deep-frozen clone. A filter that
 * mutates its input (or its nested arrays) throws on the frozen structures. */
const snapshot = (value) => {
  const walk = (node) => {
    if (node !== null && typeof node === 'object') {
      for (const child of Object.values(node)) walk(child)
      Object.freeze(node)
    }
    return node
  }
  return walk(JSON.parse(JSON.stringify(value)))
}

// -- workspace/follow -------------------------------------------------------------

const WORKSPACE = (id, sessionIds) => ({
  workspaceId: id,
  path: `/tmp/${id}`,
  title: id,
  sessionIds,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
})

test('filterWorkspaceFrame: baseline keeps every workspace, narrows its session lists', () => {
  const frame = {
    type: 'baseline',
    value: {
      items: [WORKSPACE('w1', ['S-shared', 'S-secret']), WORKSPACE('w2', ['S-secret', 'S-also'])],
      archivedSessionIds: ['S-secret', 'S-shared'],
      pinnedSessionIds: ['S-secret'],
    },
  }
  const input = snapshot(frame)
  const out = filterWorkspaceFrame(frame, only(['S-shared', 'S-also']))
  assert.deepEqual(out, {
    type: 'baseline',
    value: {
      items: [WORKSPACE('w1', ['S-shared']), WORKSPACE('w2', ['S-also'])],
      archivedSessionIds: ['S-shared'],
      pinnedSessionIds: [],
    },
  })
  // A workspace with no accessible sessions still travels (the desktop client
  // creates sessions in any server-side workspace).
  assert.equal(out.value.items.length, 2)
  assert.deepEqual(frame, input, 'the input frame is untouched')
  assert.notEqual(out, frame, 'a new object comes back')
  assert.notEqual(out.value.items[0], frame.value.items[0], 'workspaces are copied, not aliased')
})

test('filterWorkspaceFrame: upsert narrows, remove/order pass through, archived/pinned narrow', () => {
  const upsert = { type: 'upsert', workspace: WORKSPACE('w1', ['S-shared', 'S-secret']) }
  assert.deepEqual(filterWorkspaceFrame(upsert, only(['S-shared'])), {
    type: 'upsert',
    workspace: WORKSPACE('w1', ['S-shared']),
  })

  const remove = { type: 'remove', workspaceId: 'w1' }
  assert.deepEqual(filterWorkspaceFrame(remove, only(['S-shared'])), remove)

  const order = { type: 'order', workspaceIds: ['w2', 'w1'] }
  assert.deepEqual(filterWorkspaceFrame(order, no), order)

  const archived = { type: 'archived', archivedSessionIds: ['S-secret', 'S-shared'] }
  assert.deepEqual(filterWorkspaceFrame(archived, only(['S-shared'])), { type: 'archived', archivedSessionIds: ['S-shared'] })

  const pinned = { type: 'pinned', pinnedSessionIds: ['S-secret'] }
  assert.deepEqual(filterWorkspaceFrame(pinned, yes), pinned)
})

test('filterWorkspaceFrame: unknown or malformed frames are dropped', () => {
  for (const frame of [null, 42, 'x', {}, { type: 'nope' }, { type: 'baseline' }, { type: 'baseline', value: 3 }]) {
    assert.equal(filterWorkspaceFrame(frame, yes), null, JSON.stringify(frame))
  }
})

// -- session/control ----------------------------------------------------------------

test('filterControlFrame: baseline keeps only accessible keys of the projections map', () => {
  const frame = {
    type: 'baseline',
    value: {
      projections: {
        'S-shared': { asOfSeq: 1, values: { title: 'a' } },
        'S-secret': { asOfSeq: 2, values: { title: 'b' } },
      },
    },
  }
  const input = snapshot(frame)
  const out = filterControlFrame(frame, only(['S-shared']))
  assert.deepEqual(out, {
    type: 'baseline',
    value: { projections: { 'S-shared': { asOfSeq: 1, values: { title: 'a' } } } },
  })
  assert.deepEqual(frame, input)
})

test('filterControlFrame: projection frames pass or drop whole by their session id', () => {
  const frame = { type: 'projection', sessionId: 'S-secret', key: 'title', value: 'x', seq: 7 }
  assert.equal(filterControlFrame(frame, only(['S-shared'])), null)
  const kept = { type: 'projection', sessionId: 'S-shared', key: 'title', value: 'x', seq: 7 }
  assert.deepEqual(filterControlFrame(kept, only(['S-shared'])), kept)
})

test('filterControlFrame: unknown or malformed frames are dropped', () => {
  for (const frame of [null, 'x', {}, { type: 'nope' }, { type: 'baseline' }, { type: 'projection' }]) {
    assert.equal(filterControlFrame(frame, yes), null, JSON.stringify(frame))
  }
  // A KNOWN frame with a damaged payload normalizes instead of dropping —
  // dropping a baseline would leave the client with no state at all.
  assert.deepEqual(filterControlFrame({ type: 'baseline', value: {} }, yes), {
    type: 'baseline',
    value: { projections: {} },
  })
})

// -- session/list -----------------------------------------------------------------

test('filterSessionListResult: items narrow, every other field rides along', () => {
  const result = {
    items: [{ sessionId: 'S-shared', running: false }, { sessionId: 'S-secret', running: true }, { broken: true }],
    extra: { kept: true },
  }
  const input = snapshot(result)
  const out = filterSessionListResult(result, only(['S-shared']))
  assert.deepEqual(out, { items: [{ sessionId: 'S-shared', running: false }], extra: { kept: true } })
  assert.deepEqual(result, input)
})

test('filterSessionListResult: a result without an items array is returned as-is', () => {
  assert.deepEqual(filterSessionListResult({ total: 3 }, no), { total: 3 })
  assert.equal(filterSessionListResult(null, no), null)
})

// -- job/list (4b: ownerless jobs are server-side only) -----------------------------

test('filterJobListFrame: rows keep only jobs owned by the claimed session', () => {
  const mine = { id: 'j1', owner: 'S-shared', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }
  const foreign = { id: 'j2', owner: 'S-other', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }
  const ownerless = { id: 'j3', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }
  const frame = { type: 'rows', jobs: [mine, foreign, ownerless] }
  const input = snapshot(frame)
  assert.deepEqual(filterJobListFrame(frame, 'S-shared'), { type: 'rows', jobs: [mine] })
  assert.deepEqual(frame, input)
  // A frame of nothing-but-ownerless jobs filters to an empty job list — the
  // frame itself still travels (its shape is a real upstream frame).
  assert.deepEqual(filterJobListFrame({ type: 'rows', jobs: [ownerless] }, 'S-shared'), { type: 'rows', jobs: [] })
})

test('filterWorkspaceFrame: malformed id lists filter to empty (T22b-fix)', () => {
  // A non-array where an id list belongs is a frame the relay cannot vouch
  // for: nothing from it travels — not even the junk that was there.
  const upsert = { type: 'upsert', workspace: { ...WORKSPACE('w1', 'garbage'), sessionIds: 'garbage' } }
  assert.deepEqual(filterWorkspaceFrame(upsert, yes), { type: 'upsert', workspace: { ...WORKSPACE('w1', []), sessionIds: [] } })
  assert.deepEqual(filterWorkspaceFrame({ type: 'archived', archivedSessionIds: 7 }, yes), {
    type: 'archived',
    archivedSessionIds: [],
  })
  assert.deepEqual(filterWorkspaceFrame({ type: 'pinned', pinnedSessionIds: 'x' }, no), {
    type: 'pinned',
    pinnedSessionIds: [],
  })
  const baseline = { type: 'baseline', value: { items: [WORKSPACE('w1', ['S-a'])], archivedSessionIds: null, pinnedSessionIds: 42 } }
  assert.deepEqual(filterWorkspaceFrame(baseline, yes), {
    type: 'baseline',
    value: { items: [WORKSPACE('w1', ['S-a'])], archivedSessionIds: [], pinnedSessionIds: [] },
  })
})

test('filterJobListFrame: unknown frames are dropped, malformed jobs filter to empty (T22b-fix)', () => {
  assert.equal(filterJobListFrame({ type: 'nope' }, 'S'), null)
  assert.equal(filterJobListFrame(null, 'S'), null)
  assert.deepEqual(filterJobListFrame({ type: 'rows' }, 'S'), { type: 'rows', jobs: [] })
  assert.deepEqual(filterJobListFrame({ type: 'rows', jobs: 'all-of-them' }, 'S'), { type: 'rows', jobs: [] })
})

// -- WorkspaceFollowState (share-change synthesis) -----------------------------------

test('WorkspaceFollowState: maintains unfiltered state and synthesizes shape-exact frames', () => {
  const state = createWorkspaceFollowState()
  state.apply({
    type: 'baseline',
    value: {
      items: [WORKSPACE('w1', ['S-a']), WORKSPACE('w2', ['S-b'])],
      archivedSessionIds: [],
      pinnedSessionIds: ['S-b'],
    },
  })

  // Sharing S-b: one re-filtered upsert for the workspace containing it, plus
  // the pinned frame (S-b sits in that list); w1 is untouched, no archived.
  let frames = state.onShareChange('S-b', yes)
  assert.deepEqual(frames, [
    { type: 'upsert', workspace: WORKSPACE('w2', ['S-b']) },
    { type: 'pinned', pinnedSessionIds: ['S-b'] },
  ])

  // After an unshare the same synthesis now EXCLUDES the session.
  frames = state.onShareChange('S-b', no)
  assert.deepEqual(frames, [
    { type: 'upsert', workspace: WORKSPACE('w2', []) },
    { type: 'pinned', pinnedSessionIds: [] },
  ])
})

test('WorkspaceFollowState: upsert/remove/order/archived/pinned update the state', () => {
  const state = createWorkspaceFollowState()
  state.apply({ type: 'baseline', value: { items: [WORKSPACE('w1', [])], archivedSessionIds: [], pinnedSessionIds: [] } })
  state.apply({ type: 'upsert', workspace: WORKSPACE('w1', ['S-x']) })
  assert.deepEqual(state.onShareChange('S-x', yes), [{ type: 'upsert', workspace: WORKSPACE('w1', ['S-x']) }])

  // remove erases the workspace: no more synthesis for its sessions.
  state.apply({ type: 'remove', workspaceId: 'w1' })
  assert.deepEqual(state.onShareChange('S-x', yes), [])

  // order decides the order of synthesized upserts (w2 before w1).
  state.apply({ type: 'upsert', workspace: WORKSPACE('w1', ['S-x']) })
  state.apply({ type: 'upsert', workspace: WORKSPACE('w2', ['S-x']) })
  state.apply({ type: 'order', workspaceIds: ['w2', 'w1'] })
  assert.deepEqual(
    state.onShareChange('S-x', yes).map((frame) => frame.workspace.workspaceId),
    ['w2', 'w1'],
  )

  // archived/pinned lists replace wholesale.
  state.apply({ type: 'archived', archivedSessionIds: ['S-x'] })
  assert.deepEqual(state.onShareChange('S-x', yes), [
    { type: 'upsert', workspace: WORKSPACE('w2', ['S-x']) },
    { type: 'upsert', workspace: WORKSPACE('w1', ['S-x']) },
    { type: 'archived', archivedSessionIds: ['S-x'] },
  ])
  state.apply({ type: 'pinned', pinnedSessionIds: ['S-x'] })
  const frames = state.onShareChange('S-x', yes)
  assert.deepEqual(frames[frames.length - 1], { type: 'pinned', pinnedSessionIds: ['S-x'] })
})

test('WorkspaceFollowState: unknown frames are ignored, garbage ids never synthesize', () => {
  const state = createWorkspaceFollowState()
  for (const frame of [null, 1, { type: 'nope' }, { type: 'upsert' }, { type: 'baseline' }]) state.apply(frame)
  assert.deepEqual(state.onShareChange('anything', yes), [])
})
