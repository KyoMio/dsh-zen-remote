// Behaviour check for the T33b(+fix) session-sharing client data
// (src/client-data/shares.ts), driven against the REAL admin/shares shapes
// src/admin-routes.ts answers: `GET` → { ok, shares:[{ sessionId, sharedAt,
// lastActivityAt, busy, remainingMs(null=忙碌), viewers, title }] }, `POST`
// → { action, sessionId? } answered with { ok }. Covers the tolerant body
// parse, describeShare's three states and countdown text (hours / minutes /
// busy, with local decay from the parse stamp), and the shared store against
// a FAKE fetch: the role gate (unknown wires nothing / client never polls /
// host pulls immediately and a client→host flip recovers), latest-wins
// sequencing, one-failed-round-only error semantics (404 included),
// visibility-shaped polling, and POST-then-refresh for all three actions.
//
// Run: node scripts/check-shares.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import {
  ADMIN_SHARES_ROUTE,
  createSharesStore,
  createZhShareFormatter,
  describeShare,
  documentVisibility,
  parseSharesBody,
  shareFailText,
  SHARES_POLL_MS,
} from '../src/client-data/shares.ts'

// Tiny sequential runner so the file stays plain node:assert (no node:test import).
let testChain = Promise.resolve()
function test(name, fn) {
  testChain = testChain
    .then(fn)
    .then(() => { console.log(`ok - ${name}`) })
    .catch((error) => {
      console.error(`not ok - ${name}`)
      throw error
    })
  return testChain
}

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const MINUTE = 60_000
const t = createZhShareFormatter()

// ---- 1. parseSharesBody -----------------------------------------------------

test('parseSharesBody: tolerant of garbage, drops broken rows, stamps asOf', () => {
  assert.deepEqual(parseSharesBody(undefined, NOW), [])
  assert.deepEqual(parseSharesBody(null, NOW), [])
  assert.deepEqual(parseSharesBody({ ok: true }, NOW), [])
  assert.deepEqual(parseSharesBody({ ok: true, shares: 'nope' }, NOW), [])
  const entries = parseSharesBody({
    ok: true,
    shares: [
      {
        sessionId: 's1', sharedAt: NOW - 99, lastActivityAt: NOW - 5 * MINUTE,
        busy: false, remainingMs: 31.4 * HOUR, viewers: 2, title: 'Refactor the gateway',
      },
      { sessionId: 's2', busy: true, remainingMs: null, title: null },
      { sessionId: '', title: 'dropped' },
      null,
      { title: 'no id' },
      { sessionId: 's3', busy: 'yes', remainingMs: 'x', viewers: -3, title: 42 },
    ],
  }, NOW)
  assert.equal(entries.length, 3)
  assert.deepEqual(entries[0], {
    sessionId: 's1', sharedAt: NOW - 99, lastActivityAt: NOW - 5 * MINUTE,
    busy: false, remainingMs: 31.4 * HOUR, viewers: 2, title: 'Refactor the gateway', asOf: NOW,
  })
  // busy: remainingMs null reads busy even without the flag.
  assert.equal(entries[1].busy, true)
  assert.equal(entries[1].title, null)
  // Garbage fields fall back, never throw. A garbage remainingMs reads null,
  // and null is the wire's busy mark — so the row counts as busy, matching
  // how respondShares encodes it.
  assert.equal(entries[2].busy, true)
  assert.equal(entries[2].remainingMs, null)
  assert.equal(entries[2].viewers, 0)
  assert.equal(entries[2].title, null)
  assert.equal(entries[2].asOf, NOW)
})

// ---- 2. describeShare -------------------------------------------------------

const entry = (over = {}) => ({
  sessionId: 's1', sharedAt: NOW - 99, lastActivityAt: NOW - 5 * MINUTE,
  busy: false, remainingMs: 31.4 * HOUR, viewers: 0, title: 'Refactor', asOf: NOW, ...over,
})

test('describeShare: no entry reads off', () => {
  assert.deepEqual(describeShare(undefined, NOW, t), { state: 'off', remainingText: '未开启远程' })
  assert.deepEqual(describeShare(null, NOW, t), { state: 'off', remainingText: '未开启远程' })
})

test('describeShare: idle countdown in hours and minutes', () => {
  assert.deepEqual(describeShare(entry(), NOW, t), { state: 'on', remainingText: '剩余闲置时间 31 小时' })
  assert.equal(describeShare(entry({ remainingMs: 45 * MINUTE }), NOW, t).remainingText, '剩余闲置时间 45 分钟')
  // Exactly the hour boundary flips the unit; a tie rounds to nearest.
  assert.equal(describeShare(entry({ remainingMs: HOUR }), NOW, t).remainingText, '剩余闲置时间 1 小时')
  assert.equal(describeShare(entry({ remainingMs: 1.5 * HOUR }), NOW, t).remainingText, '剩余闲置时间 2 小时')
  // Sub-minute leftovers still read as one minute, never zero.
  assert.equal(describeShare(entry({ remainingMs: 30_000 }), NOW, t).remainingText, '剩余闲置时间 1 分钟')
})

test('describeShare: busy reads the no-countdown copy', () => {
  assert.deepEqual(describeShare(entry({ busy: true, remainingMs: null }), NOW, t), {
    state: 'on', remainingText: '运行中，不计时',
  })
  assert.equal(describeShare(entry({ remainingMs: null }), NOW, t).remainingText, '运行中，不计时')
})

test('describeShare: viewers promote on -> watched, countdown stays in the text', () => {
  assert.equal(describeShare(entry({ viewers: 1 }), NOW, t).state, 'watched')
  assert.equal(describeShare(entry({ viewers: 3 }), NOW, t).remainingText, '剩余闲置时间 31 小时')
  const busyWatched = describeShare(entry({ busy: true, remainingMs: null, viewers: 1 }), NOW, t)
  assert.equal(busyWatched.state, 'watched')
  assert.equal(busyWatched.remainingText, '运行中，不计时')
})

test('describeShare: the countdown decays locally from the parse stamp', () => {
  // 55 min left as of 10 min ago -> 45 min now.
  assert.equal(
    describeShare(entry({ remainingMs: 55 * MINUTE, asOf: NOW - 10 * MINUTE }), NOW, t).remainingText,
    '剩余闲置时间 45 分钟',
  )
  // Expired locally clamps at one minute instead of going negative.
  assert.equal(
    describeShare(entry({ remainingMs: MINUTE, asOf: NOW - 10 * MINUTE }), NOW, t).remainingText,
    '剩余闲置时间 1 分钟',
  )
})

// ---- 3. the store -----------------------------------------------------------

/** One fake Response-shaped body. */
const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

/** A fake fetch recording every call; programs replies from a queue. */
function fakeFetch(replies) {
  const calls = []
  const queue = [...replies]
  const fetchImpl = async (input, init) => {
    calls.push({ input, init: init ?? null })
    const next = queue.shift()
    if (typeof next === 'function') return next(calls.length)
    if (next !== undefined) return next
    return jsonRes(200, { ok: true, shares: [] })
  }
  fetchImpl.calls = calls
  fetchImpl.queue = queue
  return fetchImpl
}

const bodyOf = (calls, index) => JSON.parse(calls[index]?.init?.body ?? 'null')

const SHARES = [
  { sessionId: 's1', sharedAt: NOW, lastActivityAt: NOW - MINUTE, busy: false, remainingMs: 2 * HOUR, viewers: 0, title: 'One' },
  { sessionId: 's2', sharedAt: NOW, lastActivityAt: NOW, busy: true, remainingMs: null, viewers: 1, title: 'Two' },
]

test('refresh: ok body lands as ready, entries parsed', async () => {
  const store = createSharesStore(fakeFetch([jsonRes(200, { ok: true, shares: SHARES })]))
  store.setRole('host')
  assert.equal(store.getSnapshot().ready, false)
  assert.equal(await store.refresh(), true)
  const snap = store.getSnapshot()
  assert.equal(snap.ready, true)
  assert.deepEqual(snap.entries.map((row) => row.sessionId), ['s1', 's2'])
  assert.equal(snap.entries[1].busy, true)
})

test('refresh: latest-wins — a late stale body never overwrites a newer table', async () => {
  // First GET hangs until we release it; the second GET answers immediately.
  let releaseFirst
  const first = new Promise((resolve) => { releaseFirst = () => resolve(jsonRes(200, { ok: true, shares: [{ sessionId: 'STALE' }] })) })
  const store = createSharesStore(fakeFetch([() => first, jsonRes(200, { ok: true, shares: SHARES })]))
  store.setRole('host')
  const slow = store.refresh()
  const fast = store.refresh()
  assert.equal(await fast, true)
  assert.deepEqual(store.getSnapshot().entries.map((row) => row.sessionId), ['s1', 's2'])
  releaseFirst()
  assert.equal(await slow, false, 'the late stale request is dropped')
  assert.deepEqual(
    store.getSnapshot().entries.map((row) => row.sessionId),
    ['s1', 's2'],
    'the stale body did not land',
  )
})

test('refresh: a failed GET keeps the last ready table (one failed round, no latch)', async () => {
  const store = createSharesStore(fakeFetch([
    jsonRes(200, { ok: true, shares: SHARES }),
    jsonRes(500, { ok: false }),
    jsonRes(200, { ok: false }),
    jsonRes(200, { ok: true, shares: [{ ...SHARES[0] }] }),
  ]))
  store.setRole('host')
  await store.refresh()
  assert.equal(await store.refresh(), false)
  assert.equal(store.getSnapshot().ready, true, 'last ready data kept')
  assert.deepEqual(store.getSnapshot().entries.map((row) => row.sessionId), ['s1', 's2'])
  // A 200 whose body is not ok:true is a failed load too.
  assert.equal(await store.refresh(), false)
  assert.equal(store.getSnapshot().ready, true)
  // The next round asks again and lands — nothing latched anywhere.
  assert.equal(await store.refresh(), true)
  assert.deepEqual(store.getSnapshot().entries.map((row) => row.sessionId), ['s1'])
})

test('refresh: 404 (plugin reload window) fails its own round and the next round recovers', async () => {
  const fetchImpl = fakeFetch([
    jsonRes(404, { ok: false }),
    jsonRes(404, { ok: false }),
    jsonRes(200, { ok: true, shares: SHARES }),
  ])
  const store = createSharesStore(fetchImpl)
  store.setRole('host')
  assert.equal(await store.refresh(), false)
  assert.equal(await store.refresh(), false, 'the second round still asks')
  assert.equal(store.getSnapshot().ready, false, 'nothing wrong was cached')
  assert.equal(await store.refresh(), true, 'the round after the reload answers')
  assert.deepEqual(store.getSnapshot().entries.map((row) => row.sessionId), ['s1', 's2'])
  assert.equal(fetchImpl.calls.length, 3, 'no request was ever suppressed')
})

test('role: unknown wires nothing — no polling, parts would render nothing', async () => {
  const fetchImpl = fakeFetch([jsonRes(200, { ok: true, shares: SHARES })])
  const store = createSharesStore(fetchImpl)
  const seen = []
  const off = store.subscribe(() => { seen.push('x') })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.getSnapshot().role, 'unknown')
  assert.equal(fetchImpl.calls.length, 0, 'no role wired, no request — not even the first pull')
  assert.deepEqual(seen, [])
  off()
})

test('role: client stops polling and hides; host starts with an immediate pull and recovers', async () => {
  const fetchImpl = fakeFetch([
    jsonRes(200, { ok: true, shares: SHARES }),
    // The client→host flip pulls immediately, then the cadence answers.
    jsonRes(200, { ok: true, shares: [] }),
    jsonRes(200, { ok: true, shares: [] }),
  ])
  // 5 ms cadence: the client phases below span several tick periods, so a
  // timer that survived the client flip cannot hide behind the 30 s default.
  const store = createSharesStore(fetchImpl, documentVisibility, 5)
  store.setRole('client')
  const seen = []
  const off = store.subscribe(() => { seen.push('x') })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(fetchImpl.calls.length, 0, 'a client deployment never asks — not across several tick periods')
  assert.equal(store.getSnapshot().role, 'client')
  // Flip to host: immediate pull, table lands, parts may render.
  store.setRole('host')
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(fetchImpl.calls.length >= 2, `the host flip pulled at once and the cadence ticks (saw ${fetchImpl.calls.length})`)
  assert.equal(store.getSnapshot().role, 'host')
  assert.equal(store.getSnapshot().ready, true)
  // Flipping back to client hides; several tick periods later no request
  // has fired.
  store.setRole('client')
  assert.equal(store.getSnapshot().role, 'client')
  const clientAt = fetchImpl.calls.length
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(fetchImpl.calls.length, clientAt, 'client: timer torn down, no more rounds')
  off()
})

test('visibility: hidden starts nothing; becoming visible pulls once immediately', async () => {
  let visible = false
  const visibilityFans = []
  const visibility = {
    visible: () => visible,
    subscribe(listener) { visibilityFans.push(listener); return () => { visibilityFans.splice(visibilityFans.indexOf(listener), 1) } },
  }
  const fetchImpl = fakeFetch([jsonRes(200, { ok: true, shares: SHARES })])
  // 5 ms cadence: the hidden phase below spans several real ticks, so a
  // tick that kept running while hidden CANNOT hide behind the 30 s default.
  const store = createSharesStore(fetchImpl, visibility, 5)
  store.setRole('host')
  const off = store.subscribe(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fetchImpl.calls.length, 0, 'hidden: no first pull, timer not started')
  // Become visible: the source fires its listeners, the store pulls at once,
  // and the cadence really runs — let a few ticks through.
  visible = true
  for (const fan of [...visibilityFans]) fan()
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(fetchImpl.calls.length >= 2, `the cadence ticks while visible (saw ${fetchImpl.calls.length})`)
  // Hide again: the timer is really stopped — several tick periods later
  // the count must not have moved.
  visible = false
  for (const fan of [...visibilityFans]) fan()
  const hiddenAt = fetchImpl.calls.length
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(fetchImpl.calls.length, hiddenAt, 'no request fires while the page is hidden')
  // Back to visible: one immediate pull, then the cadence resumes.
  visible = true
  for (const fan of [...visibilityFans]) fan()
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(fetchImpl.calls.length > hiddenAt, 'becoming visible pulls immediately and resumes the cadence')
  off()
  assert.deepEqual(visibilityFans, [], 'unsubscribed: the visibility listener went with it')
})

test('subscribe: with a role wired, the first listener starts ONE poll, the last unsubscriber stops it', async () => {
  const fetchImpl = fakeFetch([jsonRes(200, { ok: true, shares: SHARES })])
  // 5 ms cadence: the post-unsubscribe window below spans several tick
  // periods, so a surviving timer cannot hide behind the 30 s default.
  const store = createSharesStore(fetchImpl, documentVisibility, 5)
  store.setRole('host')
  const seen = []
  const offA = store.subscribe(() => { seen.push('a') })
  const offB = store.subscribe(() => { seen.push('b') })
  // Poll cadence matches the spec; the immediate pull is already landing.
  assert.equal(SHARES_POLL_MS, 30_000)
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fetchImpl.calls.length, 1, 'exactly one poll loop for two subscribers')
  assert.deepEqual(seen, ['a', 'b'], 'both listeners heard the snapshot change')
  // While BOTH listen the cadence really runs.
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(fetchImpl.calls.length >= 2, `the cadence ticks while subscribed (saw ${fetchImpl.calls.length})`)
  offA()
  offB()
  const unsubscribedAt = fetchImpl.calls.length
  // Several tick periods later the count must not have moved: the last
  // unsubscriber really stopped the loop.
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(fetchImpl.calls.length, unsubscribedAt, 'unsubscribed: the timer is gone, no further rounds fire')
})

test('share / unshare / unshareAll: POST the documented shapes, then refresh immediately', async () => {
  const fetchImpl = fakeFetch([
    jsonRes(200, { ok: true, shares: [] }),
    // share POST reply, then the follow-up GET.
    jsonRes(200, { ok: true }),
    jsonRes(200, { ok: true, shares: [{ ...SHARES[0] }] }),
    // unshare POST reply, then the follow-up GET.
    jsonRes(200, { ok: true }),
    jsonRes(200, { ok: true, shares: [] }),
    // unshare-all POST reply, then the follow-up GET.
    jsonRes(200, { ok: true }),
    jsonRes(200, { ok: true, shares: [] }),
  ])
  const store = createSharesStore(fetchImpl)
  store.setRole('host')
  await store.refresh()
  assert.deepEqual(await store.share('s1'), { ok: true })
  assert.equal(fetchImpl.calls[1].init.method, 'POST')
  assert.deepEqual(bodyOf(fetchImpl.calls, 1), { action: 'share', sessionId: 's1' })
  assert.equal(fetchImpl.calls[2].init.method, undefined, 'the follow-up is a GET')
  assert.deepEqual(store.getSnapshot().entries.map((row) => row.sessionId), ['s1'])

  assert.deepEqual(await store.unshare('s1'), { ok: true })
  assert.deepEqual(bodyOf(fetchImpl.calls, 3), { action: 'unshare', sessionId: 's1' })
  assert.deepEqual(store.getSnapshot().entries, [])

  assert.deepEqual(await store.unshareAll(), { ok: true })
  assert.deepEqual(bodyOf(fetchImpl.calls, 5), { action: 'unshare-all' })
  assert.equal(fetchImpl.calls.length, 7, 'every action refreshed right after landing')
})

test('actions: a refused POST carries the server error code, no refresh', async () => {
  const fetchImpl = fakeFetch([
    jsonRes(400, { ok: false, error: { code: 'subagent-session', message: 'no' } }),
    jsonRes(500, { ok: false, error: { code: 'internal', message: 'boom' } }),
    jsonRes(200, { ok: false }),
  ])
  const store = createSharesStore(fetchImpl)
  store.setRole('host')
  assert.deepEqual(await store.share('sub-1'), { ok: false, code: 'subagent-session', message: 'no' })
  assert.deepEqual(await store.unshare('gone'), { ok: false, code: 'internal', message: 'boom' })
  assert.deepEqual(await store.unshareAll(), { ok: false })
  assert.equal(fetchImpl.calls.length, 3, 'refused actions do not refresh')
})

test('shareFailText maps the server codes to the alert copy', () => {
  assert.equal(shareFailText({ ok: false, code: 'subagent-session' }, 'share', t), '开启远程失败：子智能体会话不能单独开启')
  assert.equal(shareFailText({ ok: false, code: 'no-session' }, 'share', t), '开启远程失败：会话还没有内容')
  assert.equal(shareFailText({ ok: false }, 'share', t), '操作失败，请稍后再试')
  // Even a mappable code reads generic on unshare.
  assert.equal(shareFailText({ ok: false, code: 'subagent-session' }, 'unshare', t), '操作失败，请稍后再试')
})

test('the route constant matches the T33a wire path', () => {
  assert.equal(ADMIN_SHARES_ROUTE, '/_dsh/zen-remote/admin/shares')
})

await testChain
console.log('check-shares: ok')
