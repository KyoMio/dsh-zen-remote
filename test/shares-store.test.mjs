import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ADMIN_SHARES_ROUTE,
  SHARES_POLL_MS,
  createSharesStore,
  createZhShareFormatter,
  describeShare,
  documentVisibility,
  parseSharesBody,
  shareCardRemoteView,
  shareFailText,
  subscribeWhileOpen,
} from '../src/client-data/shares.ts'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const MINUTE = 60_000
const tZh = createZhShareFormatter()

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

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

const entry = (over = {}) => ({
  sessionId: 's1', sharedAt: NOW - 99, lastActivityAt: NOW - 5 * MINUTE,
  busy: false, remainingMs: 31.4 * HOUR, viewers: 0, title: 'Refactor', asOf: NOW, ...over,
})

async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

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
  assert.equal(entries[1].busy, true)
  assert.equal(entries[1].title, null)
  assert.equal(entries[2].busy, true)
  assert.equal(entries[2].remainingMs, null)
  assert.equal(entries[2].viewers, 0)
  assert.equal(entries[2].title, null)
  assert.equal(entries[2].asOf, NOW)
})

test('describeShare: off, idle countdown, busy, watched, and local decay', () => {
  assert.deepEqual(describeShare(undefined, NOW, tZh), { state: 'off', remainingText: '未开启远程' })
  assert.deepEqual(describeShare(null, NOW, tZh), { state: 'off', remainingText: '未开启远程' })

  assert.deepEqual(describeShare(entry(), NOW, tZh), { state: 'on', remainingText: '剩余闲置时间 31 小时' })
  assert.equal(describeShare(entry({ remainingMs: 45 * MINUTE }), NOW, tZh).remainingText, '剩余闲置时间 45 分钟')
  assert.equal(describeShare(entry({ remainingMs: HOUR }), NOW, tZh).remainingText, '剩余闲置时间 1 小时')
  assert.equal(describeShare(entry({ remainingMs: 1.5 * HOUR }), NOW, tZh).remainingText, '剩余闲置时间 2 小时')
  assert.equal(describeShare(entry({ remainingMs: 30_000 }), NOW, tZh).remainingText, '剩余闲置时间 1 分钟')

  assert.deepEqual(describeShare(entry({ busy: true, remainingMs: null }), NOW, tZh), { state: 'on', remainingText: '运行中，不计时' })
  assert.equal(describeShare(entry({ remainingMs: null }), NOW, tZh).remainingText, '运行中，不计时')

  assert.equal(describeShare(entry({ viewers: 1 }), NOW, tZh).state, 'watched')
  assert.equal(describeShare(entry({ viewers: 3 }), NOW, tZh).remainingText, '剩余闲置时间 31 小时')
  const busyWatched = describeShare(entry({ busy: true, remainingMs: null, viewers: 1 }), NOW, tZh)
  assert.equal(busyWatched.state, 'watched')
  assert.equal(busyWatched.remainingText, '运行中，不计时')

  assert.equal(describeShare(entry({ remainingMs: 55 * MINUTE, asOf: NOW - 10 * MINUTE }), NOW, tZh).remainingText, '剩余闲置时间 45 分钟')
  assert.equal(describeShare(entry({ remainingMs: MINUTE, asOf: NOW - 10 * MINUTE }), NOW, tZh).remainingText, '剩余闲置时间 1 分钟')
})

test('shares store: refresh, latest-wins, failure isolation, 404 recovery, actions, error copy', async () => {
  {
    const store = createSharesStore(fakeFetch([jsonRes(200, { ok: true, shares: SHARES })]))
    store.setRole('host')
    assert.equal(store.getSnapshot().ready, false)
    assert.equal(await store.refresh(), true)
    const snap = store.getSnapshot()
    assert.equal(snap.ready, true)
    assert.deepEqual(snap.entries.map((row) => row.sessionId), ['s1', 's2'])
    assert.equal(snap.entries[1].busy, true)
  }

  {
    let releaseFirst
    const first = new Promise((resolve) => { releaseFirst = () => resolve(jsonRes(200, { ok: true, shares: [{ sessionId: 'STALE' }] })) })
    const store = createSharesStore(fakeFetch([() => first, jsonRes(200, { ok: true, shares: SHARES })]))
    store.setRole('host')
    const slow = store.refresh()
    const fast = store.refresh()
    assert.equal(await fast, true)
    assert.deepEqual(store.getSnapshot().entries.map((row) => row.sessionId), ['s1', 's2'])
    releaseFirst()
    assert.equal(await slow, false)
    assert.deepEqual(store.getSnapshot().entries.map((row) => row.sessionId), ['s1', 's2'])
  }

  {
    const store = createSharesStore(fakeFetch([
      jsonRes(200, { ok: true, shares: SHARES }),
      jsonRes(500, { ok: false }),
      jsonRes(200, { ok: false }),
      jsonRes(200, { ok: true, shares: [{ ...SHARES[0] }] }),
    ]))
    store.setRole('host')
    await store.refresh()
    assert.equal(await store.refresh(), false)
    assert.equal(store.getSnapshot().ready, true)
    assert.deepEqual(store.getSnapshot().entries.map((row) => row.sessionId), ['s1', 's2'])
    assert.equal(await store.refresh(), false)
    assert.equal(store.getSnapshot().ready, true)
    assert.equal(await store.refresh(), true)
    assert.deepEqual(store.getSnapshot().entries.map((row) => row.sessionId), ['s1'])
  }

  {
    const fetchImpl = fakeFetch([jsonRes(404, { ok: false }), jsonRes(404, { ok: false }), jsonRes(200, { ok: true, shares: SHARES })])
    const store = createSharesStore(fetchImpl)
    store.setRole('host')
    assert.equal(await store.refresh(), false)
    assert.equal(await store.refresh(), false)
    assert.equal(store.getSnapshot().ready, false)
    assert.equal(await store.refresh(), true)
    assert.deepEqual(store.getSnapshot().entries.map((row) => row.sessionId), ['s1', 's2'])
    assert.equal(fetchImpl.calls.length, 3)
  }

  {
    const fetchImpl = fakeFetch([
      jsonRes(200, { ok: true, shares: [] }),
      jsonRes(200, { ok: true }),
      jsonRes(200, { ok: true, shares: [{ ...SHARES[0] }] }),
      jsonRes(200, { ok: true }),
      jsonRes(200, { ok: true, shares: [] }),
      jsonRes(200, { ok: true }),
      jsonRes(200, { ok: true, shares: [] }),
    ])
    const store = createSharesStore(fetchImpl)
    store.setRole('host')
    await store.refresh()
    assert.deepEqual(await store.share('s1'), { ok: true })
    assert.equal(fetchImpl.calls[1].init.method, 'POST')
    assert.deepEqual(bodyOf(fetchImpl.calls, 1), { action: 'share', sessionId: 's1' })
    assert.equal(fetchImpl.calls[2].init.method, undefined)
    assert.deepEqual(store.getSnapshot().entries.map((row) => row.sessionId), ['s1'])
    assert.deepEqual(await store.unshare('s1'), { ok: true })
    assert.deepEqual(bodyOf(fetchImpl.calls, 3), { action: 'unshare', sessionId: 's1' })
    assert.deepEqual(store.getSnapshot().entries, [])
    assert.deepEqual(await store.unshareAll(), { ok: true })
    assert.deepEqual(bodyOf(fetchImpl.calls, 5), { action: 'unshare-all' })
    assert.equal(fetchImpl.calls.length, 7)
  }

  {
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
    assert.equal(fetchImpl.calls.length, 3)
  }

  assert.equal(shareFailText({ ok: false, code: 'subagent-session' }, 'share', tZh), '开启远程失败：子智能体会话不能单独开启')
  assert.equal(shareFailText({ ok: false, code: 'no-session' }, 'share', tZh), '开启远程失败：会话暂无内容')
  assert.equal(shareFailText({ ok: false }, 'share', tZh), '操作失败，请稍后再试')
  assert.equal(shareFailText({ ok: false, code: 'subagent-session' }, 'unshare', tZh), '操作失败，请稍后再试')
  assert.equal(ADMIN_SHARES_ROUTE, '/_dsh/zen-remote/admin/shares')
})

test('shares store polling: role gate, visibility gate, subscribe refcount, and subscribeWhileOpen under mock timers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })

  // unknown role
  {
    const fetchImpl = fakeFetch([jsonRes(200, { ok: true, shares: SHARES })])
    const store = createSharesStore(fetchImpl)
    const seen = []
    const off = store.subscribe(() => { seen.push('x') })
    await flushMicrotasks()
    assert.equal(store.getSnapshot().role, 'unknown')
    assert.equal(fetchImpl.calls.length, 0)
    assert.deepEqual(seen, [])
    off()
  }

  // client/host role switch
  {
    const fetchImpl = fakeFetch([
      jsonRes(200, { ok: true, shares: SHARES }),
      jsonRes(200, { ok: true, shares: [] }),
      jsonRes(200, { ok: true, shares: [] }),
    ])
    const store = createSharesStore(fetchImpl, documentVisibility, 100)
    store.setRole('client')
    const off = store.subscribe(() => {})
    t.mock.timers.tick(300)
    await flushMicrotasks()
    assert.equal(fetchImpl.calls.length, 0)
    assert.equal(store.getSnapshot().role, 'client')

    store.setRole('host')
    await flushMicrotasks()
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.ok(fetchImpl.calls.length >= 2)
    assert.equal(store.getSnapshot().role, 'host')
    assert.equal(store.getSnapshot().ready, true)

    store.setRole('client')
    assert.equal(store.getSnapshot().role, 'client')
    const clientAt = fetchImpl.calls.length
    t.mock.timers.tick(500)
    await flushMicrotasks()
    assert.equal(fetchImpl.calls.length, clientAt)
    off()
  }

  // visibility gate
  {
    let visible = false
    const visibilityFans = []
    const visibility = {
      visible: () => visible,
      subscribe(listener) { visibilityFans.push(listener); return () => { visibilityFans.splice(visibilityFans.indexOf(listener), 1) } },
    }
    const fetchImpl = fakeFetch([jsonRes(200, { ok: true, shares: SHARES })])
    const store = createSharesStore(fetchImpl, visibility, 100)
    store.setRole('host')
    const off = store.subscribe(() => {})
    await flushMicrotasks()
    assert.equal(fetchImpl.calls.length, 0)

    visible = true
    for (const fan of [...visibilityFans]) fan()
    await flushMicrotasks()
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.ok(fetchImpl.calls.length >= 2)

    visible = false
    for (const fan of [...visibilityFans]) fan()
    const hiddenAt = fetchImpl.calls.length
    t.mock.timers.tick(500)
    await flushMicrotasks()
    assert.equal(fetchImpl.calls.length, hiddenAt)

    visible = true
    for (const fan of [...visibilityFans]) fan()
    await flushMicrotasks()
    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.ok(fetchImpl.calls.length > hiddenAt)
    off()
    assert.deepEqual(visibilityFans, [])
  }

  // subscribe refcount
  {
    const fetchImpl = fakeFetch([jsonRes(200, { ok: true, shares: SHARES })])
    const store = createSharesStore(fetchImpl, documentVisibility, 100)
    store.setRole('host')
    const seen = []
    const offA = store.subscribe(() => { seen.push('a') })
    const offB = store.subscribe(() => { seen.push('b') })
    assert.equal(SHARES_POLL_MS, 30_000)
    await flushMicrotasks()
    assert.equal(fetchImpl.calls.length, 1)
    assert.deepEqual(seen, ['a', 'b'])

    t.mock.timers.tick(100)
    await flushMicrotasks()
    assert.ok(fetchImpl.calls.length >= 2)
    offA()
    offB()
    const unsubscribedAt = fetchImpl.calls.length
    t.mock.timers.tick(500)
    await flushMicrotasks()
    assert.equal(fetchImpl.calls.length, unsubscribedAt)
  }

  // T68 subscribeWhileOpen
  {
    let requests = 0
    const store = createSharesStore(async () => {
      requests += 1
      return { ok: true, json: async () => ({ ok: true, shares: [] }) }
    }, undefined, 100)
    store.setRole('host')
    try {
      const closed = subscribeWhileOpen(store, false, () => {})
      closed()
      t.mock.timers.tick(300)
      await flushMicrotasks()
      assert.equal(requests, 0)

      const unsubscribe = subscribeWhileOpen(store, true, () => {})
      await flushMicrotasks()
      t.mock.timers.tick(200)
      await flushMicrotasks()
      assert.ok(requests >= 2)

      unsubscribe()
      const seenAtStop = requests
      t.mock.timers.tick(300)
      await flushMicrotasks()
      assert.equal(requests, seenAtStop)
    } finally {
      store.setRole('client')
    }
  }
})

test('T67 mobile info-card remote view and wiring', () => {
  function fakeT() {
    const used = []
    const fn = (key, params) => {
      used.push(params === undefined ? key : `${key}(${JSON.stringify(params)})`)
      if (key === 'settings.shareViewers') return `${params.count} 台设备正在查看`
      if (key === 'shareRemoteRemainingMinutes') return `${params.count} 分钟后闲置休眠`
      return key
    }
    fn.used = used
    return fn
  }

  const infoEntry = (over = {}) => ({
    sessionId: 'session-1', sharedAt: NOW - 1000, lastActivityAt: NOW - 1000,
    busy: false, remainingMs: 45 * 60_000, viewers: 0, title: null, asOf: NOW,
    ...over,
  })

  {
    const t = fakeT()
    assert.deepEqual(
      shareCardRemoteView({ ready: true, role: 'host', subagent: false, entry: undefined, now: NOW, t }),
      { visible: true, shared: false, line: 'shareRemoteStateOff' },
    )
  }
  {
    const t = fakeT()
    const on = shareCardRemoteView({ ready: true, role: 'host', subagent: false, entry: infoEntry(), now: NOW, t })
    assert.equal(on.shared, true)
    assert.deepEqual(t.used, ['shareRemoteStateOn', 'shareRemoteRemainingMinutes({"count":45})'])
    assert.equal(on.line, 'shareRemoteStateOn · 45 分钟后闲置休眠')

    const watched = shareCardRemoteView({ ready: true, role: 'host', subagent: false, entry: infoEntry({ viewers: 2 }), now: NOW, t })
    assert.equal(t.used.includes('settings.shareViewers({"count":2})'), true)
    assert.equal(watched.line, 'shareRemoteStateOn · 2 台设备正在查看 · 45 分钟后闲置休眠')

    const busy = shareCardRemoteView({ ready: true, role: 'host', subagent: false, entry: infoEntry({ busy: true, remainingMs: null }), now: NOW, t })
    assert.equal(busy.line, 'shareRemoteStateOn · shareRemoteBusy')
  }
  {
    const base = { ready: true, role: 'host', subagent: false, entry: infoEntry(), now: NOW, t: fakeT() }
    assert.equal(shareCardRemoteView({ ...base, role: 'client' }).visible, false)
    assert.equal(shareCardRemoteView({ ...base, role: 'unknown' }).visible, false)
    assert.equal(shareCardRemoteView({ ...base, ready: false }).visible, false)
    assert.equal(shareCardRemoteView({ ...base, subagent: true }).visible, false)
    assert.equal(shareCardRemoteView({ ...base, sessionId: 'zr~abcd1234~session-1' }).visible, false)
  }

  const source = readFileSync(join(ROOT, 'src', 'client', 'MobileSessionInfo.tsx'), 'utf8')
  assert.ok(source.includes('subscribeWhileOpen(shares, open, onStoreChange)'))
  assert.ok(source.includes('void shares.refresh()'))
  const switchAt = source.indexOf('role="switch"')
  assert.notEqual(switchAt, -1)
  const switchBlock = source.slice(switchAt, source.indexOf('/>', switchAt))
  assert.ok(switchBlock.includes('aria-checked={remoteRow.shared}'))
  assert.ok(switchBlock.includes("aria-label={t('infoRemoteAccess')}"))
  assert.ok(switchBlock.includes('disabled={remoteBusy}'))

  const toggleAt = source.indexOf('const onToggleRemote = (): void => {')
  assert.notEqual(toggleAt, -1)
  const toggleBlock = source.slice(toggleAt, source.indexOf("remoteRow.shared ? 'unshare' : 'share'", toggleAt) + 40)
  assert.ok(toggleBlock.includes('shares.unshare(sessionId)'))
  assert.ok(toggleBlock.includes('shares.share(sessionId)'))
  assert.ok(toggleBlock.includes('shareFailText(outcome'))

  const index = readFileSync(join(ROOT, 'src', 'client', 'index.tsx'), 'utf8')
  const injectAt = index.indexOf("id: 'mobile-session-info'")
  assert.notEqual(injectAt, -1)
  assert.ok(index.slice(injectAt, index.indexOf('MobileSessionInfo)', injectAt)).includes('shares: getSharesStore()'))
})
