'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const loadPure = () => import('../src/client-data/remote-group-expansion.ts?' + Math.random())
const loadKeeper = () => import('../src/client/remote-group-expansion.ts?' + Math.random())

async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

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
  assert.deepEqual(plan.clicks, [])
  assert.deepEqual(plan.record, { 'zr~sid~w1': false, 'zr~sid~w2': true })
})

test('T64 plan: no record anywhere -> default EXPANDED and click; plugin-recorded collapsed stays collapsed', async () => {
  const { planRemoteGroupExpansion } = await loadPure()
  const plan = planRemoteGroupExpansion({
    hostRecord: {},
    pluginRecord: { 'zr~sid~w2': false, 'zr~sid~w3': true },
    rows: [
      { key: 'zr~sid~w1', expanded: false },
      { key: 'zr~sid~w2', expanded: false },
      { key: 'zr~sid~w3', expanded: true },
    ],
  })
  assert.deepEqual(plan.clicks, ['zr~sid~w1'])
  assert.deepEqual(plan.record, { 'zr~sid~w2': false, 'zr~sid~w3': true })
})

test('T64 plan: an expanded-by-default group that is already expanded is left alone', async () => {
  const { planRemoteGroupExpansion } = await loadPure()
  const plan = planRemoteGroupExpansion({
    hostRecord: {},
    pluginRecord: {},
    rows: [{ key: 'zr~sid~w1', expanded: true }],
  })
  assert.deepEqual(plan.clicks, [])
  assert.deepEqual(plan.record, {})
})

test('T64 plan: the record is capped and the oldest entries evict first', async () => {
  const pure = await loadPure()
  const over = {}
  for (let i = 0; i < pure.REMOTE_GROUP_EXPANSION_LIMIT; i += 1) over[`zr~sid~old${i}`] = true
  const hostRecord = { 'zr~sid~old3': true }
  over['zr~sid~new'] = false
  const plan = pure.planRemoteGroupExpansion({
    hostRecord,
    pluginRecord: over,
    rows: [{ key: 'zr~sid~new', expanded: true }],
  })
  assert.deepEqual(plan.clicks, ['zr~sid~new'])
  const keys = Object.keys(plan.record)
  assert.equal(keys.length, pure.REMOTE_GROUP_EXPANSION_LIMIT)
  assert.equal(keys.includes('zr~sid~old0'), false)
  assert.equal(keys.includes('zr~sid~old3'), true)
  assert.equal(keys[keys.length - 1], 'zr~sid~old3')
  assert.equal(keys[keys.length - 2], 'zr~sid~new')
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

function makeEnv({ hostView = {}, rows = [], roleAnswer, pluginRecord = null } = {}) {
  const backing = new Map()
  if (pluginRecord !== null) backing.set('zr.remoteGroupExpansion.v1', JSON.stringify(pluginRecord))
  if (hostView !== null) backing.set('dsh.workspace.view.v5', JSON.stringify({ groupExpansion: hostView }))
  const clicked = []
  const env = {
    clicked,
    backing,
    setHost(groupExpansion) { backing.set('dsh.workspace.view.v5', JSON.stringify({ groupExpansion })) },
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
      intervalMs: 100,
    })
  }
  return env
}

test('T64 keeper: collapsed purged groups are restored by one click each; the record is written back', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
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
    await flushMicrotasks()
    assert.deepEqual(env.clicked, ['zr~sid~w1', 'zr~sid~w2'])
    assert.equal(env.backing.has('zr.remoteGroupExpansion.v1'), false)

    env.setHost({ 'ws-local': true, 'zr~sid~w1': true, 'zr~sid~w2': true })
    env.setRowStates([
      { key: 'zr~sid~w1', expanded: true },
      { key: 'zr~sid~w2', expanded: true },
    ])
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.deepEqual(env.clicked, ['zr~sid~w1', 'zr~sid~w2'])
    assert.deepEqual(JSON.parse(env.backing.get('zr.remoteGroupExpansion.v1')), {
      'zr~sid~w1': true,
      'zr~sid~w2': true,
    })
  } finally {
    env.stop()
  }
})

test('T64 keeper: the same group is auto-clicked at most once per page load', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const env = makeEnv({ rows: [{ key: 'zr~sid~w1', expanded: false }], roleAnswer: 'client' })
  await env.load()
  try {
    await flushMicrotasks()
    assert.deepEqual(env.clicked, ['zr~sid~w1'])
    t.mock.timers.tick(300)
    await flushMicrotasks()
    assert.deepEqual(env.clicked, ['zr~sid~w1'])
  } finally {
    env.stop()
  }
})

test('T64 keeper: a host-recorded group is left alone; a malformed DOM shape is skipped silently', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
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
    await flushMicrotasks()
    assert.deepEqual(env.clicked, ['zr~sid~w2'])
    assert.deepEqual(JSON.parse(env.backing.get('zr.remoteGroupExpansion.v1')), { 'zr~sid~w1': false })
  } finally {
    env.stop()
  }
})

test('T64 keeper: a non-client role never clicks and never writes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const env = makeEnv({ rows: [{ key: 'zr~sid~w1', expanded: false }], roleAnswer: 'host' })
  await env.load()
  try {
    t.mock.timers.tick(200)
    await flushMicrotasks()
    assert.deepEqual(env.clicked, [])
    assert.equal(env.backing.has('zr.remoteGroupExpansion.v1'), false)

    const unknown = makeEnv({ rows: [{ key: 'zr~sid~w1', expanded: false }], roleAnswer: undefined })
    await unknown.load()
    try {
      t.mock.timers.tick(200)
      await flushMicrotasks()
      assert.deepEqual(unknown.clicked, [])
      assert.equal(unknown.backing.has('zr.remoteGroupExpansion.v1'), false)
    } finally {
      unknown.stop()
    }
  } finally {
    env.stop()
  }
})

test('PG-9-fix keeper: a PEER role remembers and restores zr~ groups exactly like a client', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const env = makeEnv({
    hostView: { 'ws-local': true },
    roleAnswer: 'peer',
    rows: [
      { key: 'zr~sid~w1', expanded: false },
      { key: 'zr~sid~w2', expanded: false },
    ],
  })
  await env.load()
  try {
    await flushMicrotasks()
    assert.deepEqual(env.clicked, ['zr~sid~w1', 'zr~sid~w2'])
    env.setHost({ 'ws-local': true, 'zr~sid~w1': true, 'zr~sid~w2': true })
    env.setRowStates([
      { key: 'zr~sid~w1', expanded: true },
      { key: 'zr~sid~w2', expanded: true },
    ])
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.deepEqual(JSON.parse(env.backing.get('zr.remoteGroupExpansion.v1')), {
      'zr~sid~w1': true,
      'zr~sid~w2': true,
    })
  } finally {
    env.stop()
  }
})

test('T66 keeper: a throwing localStorage neither rejects the tick nor clicks — and recovery works', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let broken = true
  const backing = new Map()
  const clicked = []
  const mod = await loadKeeper()
  const stop = mod.startRemoteGroupExpansionKeeper({
    storage: {
      getItem: (key) => {
        if (broken) throw new Error('quota exceeded')
        return backing.has(key) ? backing.get(key) : null
      },
      setItem: (key, value) => {
        if (broken) throw new Error('quota exceeded')
        backing.set(key, value)
      },
    },
    probeRole: async () => 'client',
    queryRows: () => [{
      key: 'zr~sid~w1',
      expanded: false,
      click: () => {
        clicked.push('zr~sid~w1')
        backing.set('dsh.workspace.view.v5', JSON.stringify({ groupExpansion: { 'zr~sid~w1': true } }))
      },
    }],
    intervalMs: 100,
  })
  try {
    await flushMicrotasks()
    t.mock.timers.tick(200)
    await flushMicrotasks()
    broken = false
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.deepEqual(clicked, ['zr~sid~w1'])
    assert.deepEqual(JSON.parse(backing.get('zr.remoteGroupExpansion.v1')), { 'zr~sid~w1': true })
  } finally {
    stop()
  }
})

test('T66 keeper: a group whose row DISAPPEARS may be restored once more when it comes back', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const env = makeEnv({ rows: [{ key: 'zr~sid~w1', expanded: false }], roleAnswer: 'client' })
  await env.load()
  try {
    await flushMicrotasks()
    assert.deepEqual(env.clicked, ['zr~sid~w1'])

    env.setRowStates([])
    t.mock.timers.tick(100)
    await flushMicrotasks()

    env.setRowStates([{ key: 'zr~sid~w1', expanded: false }])
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.deepEqual(env.clicked, ['zr~sid~w1', 'zr~sid~w1'])

    t.mock.timers.tick(200)
    await flushMicrotasks()
    assert.equal(env.clicked.length, 2)
  } finally {
    env.stop()
  }
})
