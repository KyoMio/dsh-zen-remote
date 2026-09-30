// dsh-zen-remote · T62 current-session signal (src/client-data/current-session.ts
// + src/client/current-session-report.ts)
//
// The browser half of the current-session pipeline, driven the dynamic .ts
// way (the same seam settings-form-t55.test.cjs uses):
//
// - the PURE core: parsing one raw localStorage read into the report
//   vocabulary (unavailable = never report; none = `{sessionId:null}`;
//   open = `{sessionId}`) and the content equality the change gate uses;
// - the reporter loop: only CHANGES travel (no value, no POST — and a
//   failed POST is retried by the next tick because the last-reported value
//   did not advance), an `unavailable` read never posts, and a non-client
//   role probes but never reports.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const loadPure = () => import('../src/client-data/current-session.ts?' + Math.random())
const loadReporter = () => import('../src/client/current-session-report.ts?' + Math.random())

test('T62 parse: the storage value maps onto the report vocabulary', async () => {
  const { parseCurrentSessionStorage } = await loadPure()
  // A real open session (the host writes `{sessionId}` — virtual or local).
  assert.deepEqual(parseCurrentSessionStorage(JSON.stringify({ sessionId: 'zr~721b94fb~session-a' })), {
    kind: 'open',
    sessionId: 'zr~721b94fb~session-a',
  })
  // The host's clearMain writes `{}` — a real, REPORTABLE "nothing open".
  assert.deepEqual(parseCurrentSessionStorage('{}'), { kind: 'none' })
  assert.deepEqual(parseCurrentSessionStorage(JSON.stringify({ sessionId: '' })), { kind: 'none' })
  assert.deepEqual(parseCurrentSessionStorage(JSON.stringify({ sessionId: null })), { kind: 'none' })
  // No signal, never a guess: an absent key, broken JSON, a non-object, and
  // an unusable sessionId shape all read unavailable.
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

/** A deterministic environment for the reporter: fake storage + fetch
 * recorder + manual role answer, no DOM (the real window/document listeners
 * are simply absent under Node), and a fast interval the test waits on. */
// `roleAnswer` has NO destructuring default on purpose: `undefined` is a
// real answer here (a failed probe), and a default would turn it into a
// definite verdict.
function makeEnv({ initial = '{}', roleAnswer, failFirst = false, resendIntervalMs } = {}) {
  const posted = []
  let storageValue = initial
  let fail = failFirst
  const env = {
    posted,
    setStorage(next) { storageValue = next },
    setFail(next) { fail = next },
    stop: undefined,
  }
  const load = async () => {
    const mod = await loadReporter()
    env.stop = mod.startCurrentSessionReporter({
      storage: { getItem: (key) => (key === 'dsh.sessions.current' ? storageValue : null) },
      fetchImpl: async (url, init) => {
        if (fail) throw new Error('offline')
        posted.push({ url, body: JSON.parse(init.body) })
        return { ok: true }
      },
      probeRole: async () => roleAnswer,
      intervalMs: 5,
      ...(resendIntervalMs !== undefined ? { resendIntervalMs } : {}),
    })
  }
  env.load = load
  return env
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('T62 reporter: page load posts once, an unchanged value never re-posts, a change does', async () => {
  const env = makeEnv({ initial: JSON.stringify({ sessionId: 'zr~721b94fb~s1' }), roleAnswer: 'client' })
  await env.load()
  try {
    await wait(40)
    assert.deepEqual(env.posted, [
      { url: '/_dsh/zen-remote/client/current-session', body: { sessionId: 'zr~721b94fb~s1' } },
    ], 'the initial value travels exactly once; the 1s check sees the same value and stays quiet')

    // The user navigates: the next tick (or storage/visibility event) posts
    // the new value.
    env.setStorage(JSON.stringify({ sessionId: 'session-l2' }))
    await wait(40)
    assert.equal(env.posted.length, 2)
    assert.deepEqual(env.posted[1].body, { sessionId: 'session-l2' })

    // Cleared selection ({} → none) reports `null`.
    env.setStorage('{}')
    await wait(40)
    assert.equal(env.posted.length, 3)
    assert.deepEqual(env.posted[2].body, { sessionId: null })
  } finally {
    env.stop()
  }
})

test('T62 reporter: an unavailable read never posts, and a failed POST retries on the next tick', async () => {
  const env = makeEnv({ initial: null, roleAnswer: 'client', failFirst: true })
  await env.load()
  try {
    // The key is absent: no signal, nothing posts — even across ticks.
    await wait(40)
    assert.deepEqual(env.posted, [])

    // Now a value appears, but the POST fails: nothing recorded, and the
    // last-reported value did not advance, so the next tick retries.
    env.setStorage(JSON.stringify({ sessionId: 'zr~721b94fb~s1' }))
    await wait(40)
    assert.deepEqual(env.posted, [])
    env.setFail(false)
    await wait(40)
    assert.deepEqual(env.posted, [
      { url: '/_dsh/zen-remote/client/current-session', body: { sessionId: 'zr~721b94fb~s1' } },
    ], 'the retry carries the same value exactly once')
    await wait(40)
    assert.equal(env.posted.length, 1, 'and then it stays quiet again')
  } finally {
    env.stop()
  }
})

test('T62 reporter: a non-client role never reports', async () => {
  const env = makeEnv({ initial: JSON.stringify({ sessionId: 's1' }), roleAnswer: 'host' })
  await env.load()
  try {
    await wait(40)
    assert.deepEqual(env.posted, [], 'a host page idles forever')
  } finally {
    env.stop()
  }
  // An undecided probe (a FAILED client-config read answers undefined) also
  // never reports — it keeps the role unknown tick after tick.
  const unknown = makeEnv({ initial: JSON.stringify({ sessionId: 's1' }), roleAnswer: undefined })
  await unknown.load()
  try {
    await wait(40)
    assert.deepEqual(unknown.posted, [])
  } finally {
    unknown.stop()
  }
})

test('T66 reporter: an unchanged value re-posts once per resend window; a change posts immediately', async () => {
  const env = makeEnv({
    initial: JSON.stringify({ sessionId: 'zr~721b94fb~s1' }),
    roleAnswer: 'client',
    resendIntervalMs: 50,
  })
  await env.load()
  try {
    // The page-load post lands at once; inside the window the unchanged
    // value stays quiet.
    await wait(20)
    assert.equal(env.posted.length, 1, 'initial value, window still open')

    // The window passes: the SAME value re-posts — the backend may have
    // been reset underneath the page (a plugin row reload re-ran apply).
    await wait(40)
    assert.equal(env.posted.length, 2)
    assert.deepEqual(env.posted[1].body, env.posted[0].body, 'the identical value, re-sent unconditionally')

    // A CHANGE posts immediately, without waiting for a window.
    env.setStorage(JSON.stringify({ sessionId: 'session-l2' }))
    await wait(20)
    assert.equal(env.posted.length, 3)
    assert.deepEqual(env.posted[2].body, { sessionId: 'session-l2' })
    // The window restarted with that post: the new value does not re-post
    // inside it.
    await wait(15)
    assert.equal(env.posted.length, 3)
  } finally {
    env.stop()
  }
})
