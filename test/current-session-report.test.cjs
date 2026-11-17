'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const loadPure = () => import('../src/client-data/current-session.ts?' + Math.random())
const loadReporter = () => import('../src/client/current-session-report.ts?' + Math.random())

async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

test('T62 parse: the storage value maps onto the report vocabulary', async () => {
  const { parseCurrentSessionStorage } = await loadPure()
  assert.deepEqual(parseCurrentSessionStorage(JSON.stringify({ sessionId: 'zr~721b94fb~session-a' })), {
    kind: 'open',
    sessionId: 'zr~721b94fb~session-a',
  })
  assert.deepEqual(parseCurrentSessionStorage('{}'), { kind: 'none' })
  assert.deepEqual(parseCurrentSessionStorage(JSON.stringify({ sessionId: '' })), { kind: 'none' })
  assert.deepEqual(parseCurrentSessionStorage(JSON.stringify({ sessionId: null })), { kind: 'none' })
  for (const raw of [null, undefined, '', 'not-json', '[1,2]', '42', '"str"', JSON.stringify({ sessionId: 42 })]) {
    assert.deepEqual(parseCurrentSessionStorage(raw), { kind: 'unavailable' }, String(raw))
  }
})

test('T62 equals: content, not identity', async () => {
  const { currentSessionReportEquals } = await loadPure()
  assert.equal(currentSessionReportEquals({ kind: 'none' }, { kind: 'none' }), true)
  assert.equal(currentSessionReportEquals({ kind: 'open', sessionId: 'a' }, { kind: 'open', sessionId: 'a' }), true)
  assert.equal(currentSessionReportEquals({ kind: 'open', sessionId: 'a' }, { kind: 'open', sessionId: 'b' }), false)
  assert.equal(currentSessionReportEquals({ kind: 'open', sessionId: 'a' }, { kind: 'none' }), false)
  assert.equal(currentSessionReportEquals({ kind: 'unavailable' }, { kind: 'none' }), false)
})

function makeEnv({ initial = '{}', roleAnswer, failFirst = false, resendIntervalMs, getLang } = {}) {
  const posted = []
  let storageValue = initial
  let fail = failFirst
  const env = {
    posted,
    setStorage(next) { storageValue = next },
    setFail(next) { fail = next },
    stop: undefined,
  }
  env.load = async () => {
    const mod = await loadReporter()
    env.stop = mod.startCurrentSessionReporter({
      storage: { getItem: (key) => (key === 'dsh.sessions.current' ? storageValue : null) },
      fetchImpl: async (url, init) => {
        if (fail) throw new Error('offline')
        posted.push({ url, body: JSON.parse(init.body) })
        return { ok: true }
      },
      probeRole: async () => roleAnswer,
      intervalMs: 100,
      ...(resendIntervalMs !== undefined ? { resendIntervalMs } : {}),
      ...(getLang !== undefined ? { getLang } : {}),
    })
  }
  return env
}

test('T62 reporter: page load posts once, an unchanged value never re-posts, a change does', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] })
  const env = makeEnv({ initial: JSON.stringify({ sessionId: 'zr~721b94fb~s1' }), roleAnswer: 'client' })
  await env.load()
  try {
    await flushMicrotasks()
    assert.deepEqual(env.posted, [
      { url: '/_dsh/zen-remote/client/current-session', body: { sessionId: 'zr~721b94fb~s1' } },
    ])

    env.setStorage(JSON.stringify({ sessionId: 'session-l2' }))
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.equal(env.posted.length, 2)
    assert.deepEqual(env.posted[1].body, { sessionId: 'session-l2' })

    env.setStorage('{}')
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.equal(env.posted.length, 3)
    assert.deepEqual(env.posted[2].body, { sessionId: null })
  } finally {
    env.stop()
  }
})

test('T62 reporter: an unavailable read never posts, and a failed POST retries on the next tick', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] })
  const env = makeEnv({ initial: null, roleAnswer: 'client', failFirst: true })
  await env.load()
  try {
    t.mock.timers.tick(300)
    await flushMicrotasks()
    assert.deepEqual(env.posted, [])

    env.setStorage(JSON.stringify({ sessionId: 'zr~721b94fb~s1' }))
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.deepEqual(env.posted, [])

    env.setFail(false)
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.deepEqual(env.posted, [
      { url: '/_dsh/zen-remote/client/current-session', body: { sessionId: 'zr~721b94fb~s1' } },
    ])
    t.mock.timers.tick(200)
    await flushMicrotasks()
    assert.equal(env.posted.length, 1)
  } finally {
    env.stop()
  }
})

test('T62 reporter: a non-client role never reports', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] })
  const env = makeEnv({ initial: JSON.stringify({ sessionId: 's1' }), roleAnswer: 'host' })
  await env.load()
  try {
    t.mock.timers.tick(300)
    await flushMicrotasks()
    assert.deepEqual(env.posted, [])
  } finally {
    env.stop()
  }

  const unknown = makeEnv({ initial: JSON.stringify({ sessionId: 's1' }), roleAnswer: undefined })
  await unknown.load()
  try {
    t.mock.timers.tick(300)
    await flushMicrotasks()
    assert.deepEqual(unknown.posted, [])
  } finally {
    unknown.stop()
  }
})

test('PG-9-fix reporter: a PEER role reports the current session exactly like a client', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] })
  const env = makeEnv({ initial: JSON.stringify({ sessionId: 'zr~721b94fb~s1' }), roleAnswer: 'peer' })
  await env.load()
  try {
    await flushMicrotasks()
    assert.deepEqual(env.posted, [
      { url: '/_dsh/zen-remote/client/current-session', body: { sessionId: 'zr~721b94fb~s1' } },
    ])
    env.setStorage(JSON.stringify({ sessionId: 'zr~aaaaaaaa~s2' }))
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.equal(env.posted.length, 2)
    assert.deepEqual(env.posted[1].body, { sessionId: 'zr~aaaaaaaa~s2' })
  } finally {
    env.stop()
  }
})

test('T66 reporter: an unchanged value re-posts once per resend window; a change posts immediately', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] })
  const env = makeEnv({
    initial: JSON.stringify({ sessionId: 'zr~721b94fb~s1' }),
    roleAnswer: 'client',
    resendIntervalMs: 500,
  })
  await env.load()
  try {
    await flushMicrotasks()
    t.mock.timers.tick(400)
    await flushMicrotasks()
    assert.equal(env.posted.length, 1)

    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.equal(env.posted.length, 2)
    assert.deepEqual(env.posted[1].body, env.posted[0].body)

    env.setStorage(JSON.stringify({ sessionId: 'session-l2' }))
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.equal(env.posted.length, 3)
    assert.deepEqual(env.posted[2].body, { sessionId: 'session-l2' })

    t.mock.timers.tick(300)
    await flushMicrotasks()
    assert.equal(env.posted.length, 3)
  } finally {
    env.stop()
  }
})

test('I18N-3 reporter: forwards UI language and re-posts when language changes', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] })
  let lang = 'zh'
  const env = makeEnv({
    initial: JSON.stringify({ sessionId: 'zr~721b94fb~s1' }),
    roleAnswer: 'client',
    getLang: () => lang,
  })
  await env.load()
  try {
    await flushMicrotasks()
    assert.equal(env.posted.length, 1)
    assert.deepEqual(env.posted[0].body, { sessionId: 'zr~721b94fb~s1', lang: 'zh' })

    lang = 'en'
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.equal(env.posted.length, 2)
    assert.deepEqual(env.posted[1].body, { sessionId: 'zr~721b94fb~s1', lang: 'en' })
  } finally {
    env.stop()
  }
})
