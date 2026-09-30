// dsh-zen-remote · T64 remote group expansion memory (src/client-data/remote-group-expansion.ts
// + src/client/remote-group-expansion.ts)
//
// The server groups' expansion state dies on every page load (the host's
// retainAccountKeys purges the zr~ keys while the workspace list is still
// local-only), so the plugin keeps its own record and re-applies it by
// clicking the group rows. Driven the dynamic .ts way (the same seam
// current-session-report.test.cjs uses):
//
// - the PURE core: the four planning rules (host-recorded → sync, never
//   click; no record anywhere → default EXPANDED and click when collapsed;
//   plugin-recorded collapsed → stays collapsed; non-zr~ rows ignored) plus
//   the record cap's oldest eviction;
// - the keeper loop: clicks exactly the planned rows, only once per group
//   per page load, writes the record back, and idles on a non-client role.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const loadPure = () => import('../src/client-data/remote-group-expansion.ts?' + Math.random())
const loadKeeper = () => import('../src/client/remote-group-expansion.ts?' + Math.random())

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// -- the pure planning core -----------------------------------------------------------

test('T64 plan: a host-recorded group is never clicked and its value syncs into the plugin record', async () => {
  const { planRemoteGroupExpansion } = await loadPure()
  const plan = planRemoteGroupExpansion({
    hostRecord: { 'zr~sid~w1': false, 'zr~sid~w2': true, 'ws-local': true },
    pluginRecord: { 'zr~sid~w1': true, 'zr~sid~w2': false },
    rows: [
      { key: 'zr~sid~w1', expanded: false },
      { key: 'zr~sid~w2', expanded: true },
      { key: 'ws-local', expanded: false },
    ],
  })
  // The host holds records for both zr~ groups — the user's latest choice
  // lives there: no click, and the plugin record takes the host's values
  // (the local group never enters the record at all).
  assert.deepEqual(plan.clicks, [])
  assert.deepEqual(plan.record, { 'zr~sid~w1': false, 'zr~sid~w2': true })
})

test('T64 plan: no record anywhere → default EXPANDED and click; a plugin-recorded collapsed group stays collapsed', async () => {
  const { planRemoteGroupExpansion } = await loadPure()
  const plan = planRemoteGroupExpansion({
    hostRecord: {},
    pluginRecord: { 'zr~sid~w2': false, 'zr~sid~w3': true },
    rows: [
      // Just purged on the host, never recorded by the plugin: the group was
      // showing its sessions before — restore to expanded.
      { key: 'zr~sid~w1', expanded: false },
      // The user collapsed it deliberately at some point: keep collapsed.
      { key: 'zr~sid~w2', expanded: false },
      // Plugin says expanded and the row already is: nothing to do.
      { key: 'zr~sid~w3', expanded: true },
    ],
  })
  assert.deepEqual(plan.clicks, ['zr~sid~w1'])
  // The untouched groups ride along in the record (value and order kept).
  assert.deepEqual(plan.record, { 'zr~sid~w2': false, 'zr~sid~w3': true })
})

test('T64 plan: an expanded-by-default group that is already expanded is left alone', async () => {
  const { planRemoteGroupExpansion } = await loadPure()
  const plan = planRemoteGroupExpansion({
    hostRecord: {},
    pluginRecord: {},
    rows: [{ key: 'zr~sid~w1', expanded: true }],
  })
  assert.deepEqual(plan.clicks, [], 'already expanded — the wanted state agrees')
  assert.deepEqual(plan.record, {})
})

test('T64 plan: the record is capped and the oldest entries evict first', async () => {
  const pure = await loadPure()
  const over = {}
  for (let i = 0; i < pure.REMOTE_GROUP_EXPANSION_LIMIT; i += 1) over[`zr~sid~old${i}`] = true
  // Touch an OLD key last (sync refreshes recency) and add a NEW key past
  // the cap: the untouched oldest head must evict, the touched one stays.
  const hostRecord = { 'zr~sid~old3': true }
  over['zr~sid~new'] = false
  const plan = pure.planRemoteGroupExpansion({
    hostRecord,
    pluginRecord: over,
    rows: [{ key: 'zr~sid~new', expanded: true }],
  })
  assert.deepEqual(plan.clicks, ['zr~sid~new'], 'plugin-recorded collapsed, row expanded → click to restore')
  const keys = Object.keys(plan.record)
  assert.equal(keys.length, pure.REMOTE_GROUP_EXPANSION_LIMIT, 'the cap holds')
  assert.equal(keys.includes('zr~sid~old0'), false, 'the untouched oldest head evicted')
  assert.equal(keys.includes('zr~sid~old3'), true, 'the touched key survived')
  assert.equal(keys[keys.length - 1], 'zr~sid~old3', 'the host-synced key is the freshest (touched last)')
  assert.equal(keys[keys.length - 2], 'zr~sid~new', 'the newest plugin key sits right before it')
})

test('T64 parse: malformed values degrade to empty records', async () => {
  const { parseExpansionRecord, parseHostGroupExpansion } = await loadPure()
  for (const raw of [null, undefined, '', 'not-json', '[1]', '42', '{"a":1}', '{"a":"yes"}']) {
    assert.deepEqual(parseExpansionRecord(raw), {}, String(raw))
  }
  assert.deepEqual(parseExpansionRecord('{"zr~sid~w1":true,"bad":1}'), { 'zr~sid~w1': true })
  assert.deepEqual(parseHostGroupExpansion(null), {})
  assert.deepEqual(parseHostGroupExpansion('not-json'), {})
  assert.deepEqual(parseHostGroupExpansion('{"orderBy":"manual"}'), {})
  assert.deepEqual(
    parseHostGroupExpansion(JSON.stringify({ orderBy: 'manual', groupExpansion: { 'zr~sid~w1': false, 'ws-local': true } })),
    { 'zr~sid~w1': false, 'ws-local': true },
  )
})

// -- the keeper loop ------------------------------------------------------------------

/** A deterministic environment: fake storage (both keys), fake rows with
 * click recorders, a manual role answer, a fast interval. No DOM. */
// `roleAnswer` has NO destructuring default on purpose: `undefined` is a
// real answer here (a failed probe), and a default would turn it into a
// definite verdict.
function makeEnv({ hostView = {}, rows = [], roleAnswer, pluginRecord = null } = {}) {
  const backing = new Map()
  if (pluginRecord !== null) backing.set('zr.remoteGroupExpansion.v1', JSON.stringify(pluginRecord))
  if (hostView !== null) backing.set('dsh.workspace.view.v5', JSON.stringify({ groupExpansion: hostView }))
  const clicked = []
  const env = {
    clicked,
    backing,
    /** Rewrite what the host's own record now holds (as a real click would). */
    setHost(groupExpansion) { backing.set('dsh.workspace.view.v5', JSON.stringify({ groupExpansion })) },
    /** Rewrite the row states the next query sees. */
    setRowStates(states) { env.rowStates = states },
    rowStates: rows,
    stop: undefined,
  }
  env.load = async () => {
    const mod = await loadKeeper()
    env.stop = mod.startRemoteGroupExpansionKeeper({
      storage: {
        getItem: (key) => (backing.has(key) ? backing.get(key) : null),
        setItem: (key, value) => backing.set(key, value),
      },
      probeRole: async () => roleAnswer,
      queryRows: () => env.rowStates.map(({ key, expanded }) => ({
        key,
        expanded,
        click: () => clicked.push(key),
      })),
      intervalMs: 5,
    })
  }
  return env
}

test('T64 keeper: collapsed purged groups are restored by one click each; the record is written back', async () => {
  const env = makeEnv({
    hostView: { 'ws-local': true },
    roleAnswer: 'client',
    rows: [
      { key: 'zr~sid~w1', expanded: false },
      { key: 'zr~sid~w2', expanded: false },
    ],
  })
  await env.load()
  try {
    await wait(40)
    assert.deepEqual(env.clicked, ['zr~sid~w1', 'zr~sid~w2'], 'both just-purged groups restore to expanded')
    // The record only ever holds keys the HOST once recorded — right after
    // the restore clicks (nothing recorded yet is zr~) it stays unwritten.
    assert.equal(env.backing.has('zr.remoteGroupExpansion.v1'), false)

    // Simulate the clicks landing: the host records them, the rows show
    // expanded. The next ticks must not click again (host-recorded anyway)
    // — and the memory now fills from the host's own record.
    env.setHost({ 'ws-local': true, 'zr~sid~w1': true, 'zr~sid~w2': true })
    env.setRowStates([
      { key: 'zr~sid~w1', expanded: true },
      { key: 'zr~sid~w2', expanded: true },
    ])
    await wait(40)
    assert.deepEqual(env.clicked, ['zr~sid~w1', 'zr~sid~w2'], 'no re-click once the host holds the record')
    assert.deepEqual(JSON.parse(env.backing.get('zr.remoteGroupExpansion.v1')), {
      'zr~sid~w1': true,
      'zr~sid~w2': true,
    }, 'the host-recorded values synced into the plugin memory')
  } finally {
    env.stop()
  }
})

test('T64 keeper: the same group is auto-clicked at most once per page load', async () => {
  const env = makeEnv({ rows: [{ key: 'zr~sid~w1', expanded: false }], roleAnswer: 'client' })
  await env.load()
  try {
    await wait(40)
    assert.deepEqual(env.clicked, ['zr~sid~w1'])
    // The click did NOT land (the host wrote no record, the row still reads
    // collapsed): the once-per-load guard must keep the later ticks quiet —
    // re-clicking would fight the host.
    await wait(40)
    await wait(40)
    assert.deepEqual(env.clicked, ['zr~sid~w1'], 'no re-click even though nothing changed')
  } finally {
    env.stop()
  }
})

test('T64 keeper: a host-recorded group is left alone; a malformed DOM shape is skipped silently', async () => {
  const env = makeEnv({
    hostView: { 'zr~sid~w1': false },
    roleAnswer: 'client',
    rows: [
      { key: 'zr~sid~w1', expanded: false },
      { key: 'zr~sid~w2', expanded: false },
    ],
  })
  await env.load()
  try {
    await wait(40)
    assert.deepEqual(env.clicked, ['zr~sid~w2'], 'only the host-unrecorded group is clicked; the recorded one is the user\'s choice')
    assert.deepEqual(JSON.parse(env.backing.get('zr.remoteGroupExpansion.v1')), { 'zr~sid~w1': false })
  } finally {
    env.stop()
  }
})

test('T64 keeper: a non-client role never clicks and never writes', async () => {
  const env = makeEnv({ rows: [{ key: 'zr~sid~w1', expanded: false }], roleAnswer: 'host' })
  await env.load()
  try {
    await wait(40)
    assert.deepEqual(env.clicked, [])
    assert.equal(env.backing.has('zr.remoteGroupExpansion.v1'), false)
    // An undecided (failed) probe idles the same way.
    const unknown = makeEnv({ rows: [{ key: 'zr~sid~w1', expanded: false }], roleAnswer: undefined })
    await unknown.load()
    try {
      await wait(40)
      assert.deepEqual(unknown.clicked, [])
      assert.equal(unknown.backing.has('zr.remoteGroupExpansion.v1'), false)
    } finally {
      unknown.stop()
    }
  } finally {
    env.stop()
  }
})
