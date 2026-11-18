/* dsh-zen-remote · T2 session-history-store (src/session-history-cache.ts)
 *
 * Pure in-memory cache for remote session snapshots and immutable session/page
 * results: 4-tier byte/count quotas, dual-tier LRU (prewarmed evicted before
 * visited), turn/sourceEventSeqs-safe prefix trimming, offline TTL cleanup, and
 * one-shot handoff slots with leak-free timeout disposal.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  createSessionHistoryCache,
  estimateValueBytes,
  normalizeSessionAddress,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_BYTES_PER_SERVER,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  DEFAULT_MAX_PAGE_BYTES,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_SESSIONS_PER_SERVER,
  DEFAULT_MAX_RECORDS_PER_SESSION,
  DEFAULT_OFFLINE_TTL_MS,
  DEFAULT_HANDOFF_TTL_MS,
} = require('../lib/session-history-cache.js')
const { createSessionPrewarmScheduler } = require('../lib/session-prewarm.js')
const { RelayError } = require('../lib/relay-client.js')

function fakeClock(start = 1_700_000_000_000) {
  let now = start
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++
      const entry = { id, fn, runAt: now + ms, unrefCalled: false }
      timers.set(id, entry)
      return {
        id,
        unref() {
          entry.unrefCalled = true
        },
      }
    },
    clearTimeout(handle) {
      if (handle && typeof handle === 'object' && 'id' in handle) {
        timers.delete(handle.id)
      }
    },
    advance(ms) {
      now += ms
      while (true) {
        let due
        for (const entry of timers.values()) {
          if (entry.runAt <= now && (due === undefined || entry.runAt < due.runAt)) {
            due = entry
          }
        }
        if (!due) break
        timers.delete(due.id)
        due.fn()
      }
    },
    pendingCount: () => timers.size,
  }
}

function makeSnapshot(cursor, records, extra = {}) {
  return {
    type: 'snapshot',
    header: { id: extra.id ?? 's-1', ...(extra.header ?? {}) },
    cursor,
    records,
    hasMore: extra.hasMore ?? false,
    projections: extra.projections ?? { asOfSeq: cursor, values: {} },
    ...(extra.assistantStream !== undefined ? { assistantStream: extra.assistantStream } : { assistantStream: { revision: 0 } }),
  }
}

function makeEvent(seq, type = 'message', extra = {}) {
  return {
    seq,
    type,
    time: seq * 1000,
    data: { text: extra.text ?? `rec-${seq}` },
    ...(extra.sourceEventSeqs !== undefined ? { sourceEventSeqs: extra.sourceEventSeqs } : {}),
  }
}

function makeRecord(seq, type = 'message', extra = {}) {
  return {
    type: 'event',
    event: makeEvent(seq, type, extra),
  }
}

test('defaults and address normalization handle root sessions and subagent modes without collision', () => {
  assert.equal(DEFAULT_MAX_TOTAL_BYTES, 64 * 1024 * 1024)
  assert.equal(DEFAULT_MAX_BYTES_PER_SERVER, 24 * 1024 * 1024)
  assert.equal(DEFAULT_MAX_SNAPSHOT_BYTES, 8 * 1024 * 1024)
  assert.equal(DEFAULT_MAX_PAGE_BYTES, 16 * 1024 * 1024)
  assert.equal(DEFAULT_MAX_PAGES, 128)
  assert.equal(DEFAULT_MAX_SESSIONS_PER_SERVER, 32)
  assert.equal(DEFAULT_MAX_RECORDS_PER_SESSION, 600)
  assert.equal(DEFAULT_OFFLINE_TTL_MS, 30 * 60 * 1000)
  assert.equal(DEFAULT_HANDOFF_TTL_MS, 2000)

  const rootStr = normalizeSessionAddress('s-1')
  const rootObj = normalizeSessionAddress({ kind: 'session', sessionId: 's-1' })
  assert.deepEqual(rootStr, rootObj)
  assert.equal(rootStr.kind, 'session')
  assert.equal(rootStr.sessionId, 's-1')
  assert.equal(rootStr.parentSessionId, undefined)

  const subA = normalizeSessionAddress({ kind: 'subagent', parentSessionId: 'p-1', childSessionId: 'c-1', mode: 'inline' })
  const subB = normalizeSessionAddress({ kind: 'subagent', parentSessionId: 'p-1', childSessionId: 'c-1', mode: 'sidechat' })
  const rootC = normalizeSessionAddress({ kind: 'session', sessionId: 'c-1' })
  assert.equal(subA.kind, 'subagent')
  assert.equal(subA.sessionId, 'c-1')
  assert.equal(subA.parentSessionId, 'p-1')
  assert.notEqual(subA.addressKey, subB.addressKey)
  assert.notEqual(subA.addressKey, rootC.addressKey)
})

test('estimateValueBytes handles cycles and deep nesting safely', () => {
  const cyclic = { a: 'hello' }
  cyclic.self = cyclic
  assert.ok(estimateValueBytes(cyclic) > 0)

  let deep = { leaf: 'x' }
  for (let i = 0; i < 120; i += 1) deep = { next: deep }
  assert.ok(estimateValueBytes(deep) > 0)
})

test('putSnapshot sanitizes assistantStream activeAttempt and prevents prewarmed downgrade of visited', () => {
  const cache = createSessionHistoryCache()
  const raw = makeSnapshot(3, [makeRecord(1), makeRecord(2), makeRecord(3)], {
    assistantStream: { revision: 7, activeAttempt: { attemptId: 'att-1', text: 'partial' } },
  })
  assert.equal(cache.putSnapshot('srv-1', 's-1', raw, 'visited'), true)

  // Mutating caller raw snapshot/records must not mutate cached snapshot
  raw.records.push(makeRecord(999))
  const hit1 = cache.getSnapshot('srv-1', 's-1')
  assert.ok(hit1)
  assert.equal(hit1.tier, 'visited')
  assert.deepEqual(hit1.snapshot.assistantStream, { revision: 0 })
  assert.equal(hit1.snapshot.records.length, 3)

  // Prewarmed refresh must NOT downgrade a visited session
  const newer = makeSnapshot(4, [makeRecord(1), makeRecord(2), makeRecord(3), makeRecord(4)], {
    assistantStream: { revision: 9, activeAttempt: { attemptId: 'att-2' } },
  })
  assert.equal(cache.putSnapshot('srv-1', 's-1', newer, 'prewarmed'), true)
  const hit2 = cache.getSnapshot('srv-1', 's-1')
  assert.equal(hit2.tier, 'visited')
  assert.equal(hit2.cursor, 4)
  assert.deepEqual(hit2.snapshot.assistantStream, { revision: 0 })
})

test('single snapshot exceeding maxSnapshotBytes silently bypasses without evicting warm entries', () => {
  const smallSnap = makeSnapshot(1, [makeRecord(1, 'message', { text: 'a'.repeat(100) })])
  const oneSize = estimateValueBytes(smallSnap)
  const cache = createSessionHistoryCache({
    maxSnapshotBytes: oneSize + 100,
    maxBytesPerServer: oneSize * 4,
    maxTotalBytes: oneSize * 8,
  })
  assert.equal(cache.putSnapshot('srv-1', 'warm-1', smallSnap, 'visited'), true)
  const before = cache.stats()

  const hugeSnap = makeSnapshot(2, [makeRecord(1, 'message', { text: 'b'.repeat(2000) })])
  assert.equal(cache.putSnapshot('srv-1', 'huge-1', hugeSnap, 'prewarmed'), false)
  assert.ok(cache.getSnapshot('srv-1', 'warm-1'), 'warm entry must remain untouched')
  assert.equal(cache.getSnapshot('srv-1', 'huge-1'), undefined)
  assert.deepEqual(cache.stats(), before)
})

test('dual-tier LRU evicts prewarmed before visited across global, per-server, and session-count quotas', () => {
  const recBytes = estimateValueBytes(makeSnapshot(1, [makeRecord(1, 'message', { text: 'x'.repeat(200) })]))
  // Allow roughly 2.5 snapshots globally, 2 per server
  const cache = createSessionHistoryCache({
    maxTotalBytes: Math.floor(recBytes * 2.5),
    maxBytesPerServer: Math.floor(recBytes * 2.5),
    maxSnapshotBytes: recBytes + 200,
    maxSessionsPerServer: 32,
  })

  const s = (id) => makeSnapshot(1, [makeRecord(1, 'message', { text: 'x'.repeat(200) })], { id })
  assert.equal(cache.putSnapshot('srv-1', 'v-1', s('v-1'), 'visited'), true)
  assert.equal(cache.putSnapshot('srv-1', 'p-1', s('p-1'), 'prewarmed'), true)
  // Adding a 3rd entry exceeds maxTotalBytes -> must evict prewarmed 'p-1', NOT older visited 'v-1'
  assert.equal(cache.putSnapshot('srv-1', 'p-2', s('p-2'), 'prewarmed'), true)
  assert.ok(cache.getSnapshot('srv-1', 'v-1'), 'older visited must survive prewarmed eviction')
  assert.equal(cache.getSnapshot('srv-1', 'p-1'), undefined, 'oldest prewarmed is evicted first')
  assert.ok(cache.getSnapshot('srv-1', 'p-2'))

  // Per-server maxSessionsPerServer cap
  const countCache = createSessionHistoryCache({ maxSessionsPerServer: 2 })
  assert.equal(countCache.putSnapshot('srv-1', 's1', s('s1'), 'visited'), true)
  assert.equal(countCache.putSnapshot('srv-1', 's2', s('s2'), 'prewarmed'), true)
  assert.equal(countCache.putSnapshot('srv-1', 's3', s('s3'), 'visited'), true)
  assert.equal(countCache.getSnapshot('srv-1', 's2'), undefined, 'prewarmed evicted first under session count cap')
  assert.ok(countCache.getSnapshot('srv-1', 's1'))
  assert.ok(countCache.getSnapshot('srv-1', 's3'))

  // Adding 4th visited evicts LRU visited (s1 was accessed above before s3? wait: s1 accessed, so s3 is older or s1?)
  // Touch s1 explicitly so s3 is LRU visited; peekSnapshotMeta on s3 must NOT perturb LRU order
  countCache.getSnapshot('srv-1', 's1')
  assert.deepEqual(countCache.peekSnapshotMeta('srv-1', 's3'), { cursor: 1, stale: false, tier: 'visited' })
  assert.equal(countCache.peekSnapshotMeta('srv-1', 'missing'), undefined)
  assert.equal(countCache.putSnapshot('srv-1', 's4', s('s4'), 'visited'), true)
  assert.equal(countCache.getSnapshot('srv-1', 's3'), undefined, 'LRU visited evicted when no prewarmed exists')
  assert.ok(countCache.getSnapshot('srv-1', 's1'))
  assert.ok(countCache.getSnapshot('srv-1', 's4'))
})

test('appendRecord enforces seq continuity, trims at turn/start + sourceEventSeqs boundary, and updates byte totals', () => {
  const cache = createSessionHistoryCache({ maxRecordsPerSession: 5 })
  const initial = makeSnapshot(3, [
    makeRecord(1, 'turn/start'),
    makeRecord(2, 'message', { sourceEventSeqs: [1, 2] }),
    makeRecord(3, 'message', { sourceEventSeqs: [3] }),
  ])
  assert.equal(cache.putSnapshot('srv-1', 's-1', initial, 'visited'), true)

  // Duplicate seq <= cursor is idempotently ignored without turning stale
  assert.equal(cache.appendRecord('srv-1', 's-1', makeRecord(3, 'message')), true)
  assert.equal(cache.getSnapshot('srv-1', 's-1').snapshot.records.length, 3)

  // Turn 2 starts at seq 4, with seq 5 and seq 6 referencing sourceEventSeqs [4, 5] and [4, 6]
  assert.equal(cache.appendRecord('srv-1', 's-1', makeRecord(4, 'turn/start')), true)
  assert.equal(cache.appendRecord('srv-1', 's-1', makeRecord(5, 'message', { sourceEventSeqs: [4, 5] })), true)
  const beforeTrimBytes = cache.stats().totalBytes
  // Pushing seq 6 makes length = 6 > maxRecordsPerSession (5):
  // Should trim whole first turn [seq 1, 2, 3], starting cleanly at seq 4 ('turn/start')!
  assert.equal(cache.appendRecord('srv-1', 's-1', makeRecord(6, 'message', { sourceEventSeqs: [4, 6] })), true)

  const snap = cache.getSnapshot('srv-1', 's-1')
  assert.equal(snap.cursor, 6)
  assert.equal(snap.snapshot.hasMore, true)
  assert.deepEqual(
    snap.snapshot.records.map((r) => r.event.seq),
    [4, 5, 6],
  )
  assert.ok(snap.snapshot.records.every((r) => r.type === 'event' && r.event && typeof r.event.seq === 'number'))
  assert.ok(cache.stats().totalBytes < beforeTrimBytes + estimateValueBytes(makeRecord(6, 'message', { sourceEventSeqs: [4, 6] })))

  // Test fallback when entire window is one long turn with no turn/start inside [minDrop..len-1], respecting sourceEventSeqs
  const singleTurnCache = createSessionHistoryCache({ maxRecordsPerSession: 3 })
  singleTurnCache.putSnapshot('srv-1', 's-2', makeSnapshot(3, [
    makeRecord(1, 'turn/start'),
    makeRecord(2, 'message', { sourceEventSeqs: [2] }),
    makeRecord(3, 'message', { sourceEventSeqs: [2, 3] }), // references seq 2!
  ]), 'visited')
  // Appending bare event seq 4 normalizes to { type: 'event', event } in records
  assert.equal(singleTurnCache.appendRecord('srv-1', 's-2', makeEvent(4, 'message', { sourceEventSeqs: [4] })), true)
  const s2Snap = singleTurnCache.getSnapshot('srv-1', 's-2')
  assert.deepEqual(
    s2Snap.snapshot.records.map((r) => r.event.seq),
    [2, 3, 4],
  )
  assert.equal(s2Snap.snapshot.records[2].type, 'event')

  // Gap in seq marks entry stale and stops appending
  assert.equal(cache.appendRecord('srv-1', 's-1', makeRecord(9, 'message')), false)
  assert.equal(cache.getSnapshot('srv-1', 's-1').stale, true)
})

test('applyDelta merges contiguous records and updates projections/cursor', () => {
  const cache = createSessionHistoryCache()
  cache.putSnapshot('srv-1', 's-1', makeSnapshot(10, [makeRecord(9), makeRecord(10)]), 'visited')
  const merged = cache.applyDelta('srv-1', 's-1', {
    baseCursor: 10,
    cursor: 12,
    records: [makeRecord(11), makeRecord(12)],
    hasMore: true,
    projections: { asOfSeq: 12, values: { title: 'Updated' } },
    assistantStream: { revision: 3, activeAttempt: { id: 'a' } },
  })
  assert.ok(merged)
  assert.equal(merged.cursor, 12)
  assert.deepEqual(merged.records.map((r) => r.event.seq), [9, 10, 11, 12])
  assert.deepEqual(merged.assistantStream, { revision: 0 })
  assert.deepEqual(merged.projections, { asOfSeq: 12, values: { title: 'Updated' } })
})

test('session/page cache ignores throughSeq in key and enforces independent maxPageBytes/maxPages and global budget', () => {
  const p1 = { items: ['a'.repeat(100)] }
  const pSize = estimateValueBytes(p1)
  const cache = createSessionHistoryCache({
    maxPageBytes: Math.floor(pSize * 2.5),
    maxPages: 2,
    maxTotalBytes: Math.floor(pSize * 10),
  })
  assert.equal(cache.putPage('srv-1', 's-1', { beforeSeq: 50, maxMessages: 20, minMessages: 5, minTurns: 1 }, p1), true)
  // Lookup with identical window params succeeds (throughSeq not part of key)
  assert.deepEqual(cache.getPage('srv-1', 's-1', { beforeSeq: 50, maxMessages: 20, minMessages: 5, minTurns: 1 }), p1)

  assert.equal(cache.putPage('srv-1', 's-1', { beforeSeq: 30, maxMessages: 20, minMessages: 5, minTurns: 1 }, p1), true)
  // Touch first page so second becomes LRU
  cache.getPage('srv-1', 's-1', { beforeSeq: 50, maxMessages: 20, minMessages: 5, minTurns: 1 })
  // 3rd page triggers maxPages=2 eviction -> beforeSeq:30 evicted
  assert.equal(cache.putPage('srv-1', 's-1', { beforeSeq: 10, maxMessages: 20, minMessages: 5, minTurns: 1 }, p1), true)
  assert.equal(cache.getPage('srv-1', 's-1', { beforeSeq: 30, maxMessages: 20, minMessages: 5, minTurns: 1 }), undefined)
  assert.deepEqual(cache.getPage('srv-1', 's-1', { beforeSeq: 50, maxMessages: 20, minMessages: 5, minTurns: 1 }), p1)
  assert.equal(cache.stats().pageCount, 2)
})

test('offline TTL evicts server after 30 min and markServerOnline cancels the pending wipe', () => {
  const clock = fakeClock()
  const cache = createSessionHistoryCache({ clock, offlineTtlMs: 30 * 60 * 1000 })
  cache.putSnapshot('srv-1', 's-1', makeSnapshot(1, [makeRecord(1)]), 'visited')
  cache.putPage('srv-1', 's-1', { beforeSeq: 10 }, { items: [] })

  cache.markServerOffline('srv-1')
  clock.advance(29 * 60 * 1000)
  assert.ok(cache.getSnapshot('srv-1', 's-1'), 'still cached before TTL expires')

  cache.markServerOnline('srv-1')
  clock.advance(10 * 60 * 1000)
  assert.ok(cache.getSnapshot('srv-1', 's-1'), 'online cancelled offline wipe')

  cache.markServerOffline('srv-1')
  clock.advance(30 * 60 * 1000)
  assert.equal(cache.getSnapshot('srv-1', 's-1'), undefined)
  assert.equal(cache.getPage('srv-1', 's-1', { beforeSeq: 10 }), undefined)
  assert.equal(cache.stats().totalBytes, 0)
})

test('parkHandoff / takeHandoff cleans up unconsumed slots on TTL expiry and skips cleanup when taken', () => {
  const clock = fakeClock()
  const cache = createSessionHistoryCache({ clock, handoffTtlMs: 2000 })
  let cleanedA = 0
  let returnedA = 0
  cache.parkHandoff('srv-1', 's-1', {
    snapshot: makeSnapshot(5, []),
    upstreamIterator: { return: () => { returnedA += 1 } },
    cleanup: () => { cleanedA += 1 },
  })
  clock.advance(1999)
  assert.equal(cleanedA, 0)
  clock.advance(1)
  assert.equal(cleanedA, 1)
  assert.equal(returnedA, 1)
  assert.equal(cache.takeHandoff('srv-1', 's-1'), undefined)

  // Taken before TTL does not fire cleanup
  let cleanedB = 0
  cache.parkHandoff('srv-1', 's-2', {
    snapshot: makeSnapshot(6, []),
    cleanup: () => { cleanedB += 1 },
  })
  const taken = cache.takeHandoff('srv-1', 's-2')
  assert.ok(taken)
  assert.equal(taken.snapshot.cursor, 6)
  clock.advance(5000)
  assert.equal(cleanedB, 0)
})

test('deleteSessionFamily, deleteServer, and clearAll purge snapshots, pages, and handoffs to zero bytes', () => {
  const clock = fakeClock()
  const cache = createSessionHistoryCache({ clock })
  let handoffCleaned = 0

  cache.putSnapshot('srv-1', 'root-1', makeSnapshot(1, [makeRecord(1)]), 'visited')
  cache.putSnapshot('srv-1', { kind: 'subagent', parentSessionId: 'root-1', childSessionId: 'child-1', mode: 'inline' }, makeSnapshot(1, [makeRecord(1)]), 'visited')
  cache.putSnapshot('srv-1', 'root-2', makeSnapshot(1, [makeRecord(1)]), 'visited')
  cache.putPage('srv-1', { kind: 'subagent', parentSessionId: 'root-1', childSessionId: 'child-1', mode: 'inline' }, { beforeSeq: 5 }, { items: [1] })
  cache.parkHandoff('srv-1', 'root-1', { snapshot: makeSnapshot(2, []), cleanup: () => { handoffCleaned += 1 } })

  cache.deleteSessionFamily('srv-1', 'root-1')
  assert.equal(cache.getSnapshot('srv-1', 'root-1'), undefined)
  assert.equal(cache.getSnapshot('srv-1', { kind: 'subagent', parentSessionId: 'root-1', childSessionId: 'child-1', mode: 'inline' }), undefined)
  assert.equal(cache.getPage('srv-1', { kind: 'subagent', parentSessionId: 'root-1', childSessionId: 'child-1', mode: 'inline' }, { beforeSeq: 5 }), undefined)
  assert.equal(handoffCleaned, 1)
  assert.ok(cache.getSnapshot('srv-1', 'root-2'), 'unrelated session preserved')

  cache.clearAll()
  assert.equal(cache.stats().totalBytes, 0)
  assert.equal(cache.stats().snapshotCount, 0)
  assert.equal(cache.stats().pageCount, 0)
  assert.equal(cache.stats().handoffCount, 0)
})

test('childrenOf recursion, deleteServer, updateProjections, markStale, maxPageBytes, and handoff overwrite cleanup', () => {
  const clock = fakeClock()
  const singlePageCap = estimateValueBytes({ items: ['x'.repeat(50)] }) + 50
  const cache = createSessionHistoryCache({
    clock,
    maxSinglePageBytes: singlePageCap,
    maxPageBytes: singlePageCap * 2,
    maxPages: 128,
    maxTotalBytes: singlePageCap * 10,
  })

  // 1. Overwriting an existing handoff slot must cancel old timer and clean up old payload immediately
  let cleanedFirst = 0
  let returnedFirst = 0
  let cleanedSecond = 0
  cache.parkHandoff('srv-1', 's-ov', {
    snapshot: makeSnapshot(1, []),
    upstreamIterator: { return: () => { returnedFirst += 1 } },
    cleanup: () => { cleanedFirst += 1 },
  })
  cache.parkHandoff('srv-1', 's-ov', {
    snapshot: makeSnapshot(2, []),
    cleanup: () => { cleanedSecond += 1 },
  })
  assert.equal(cleanedFirst, 1)
  assert.equal(returnedFirst, 1)
  assert.equal(cleanedSecond, 0)
  const taken = cache.takeHandoff('srv-1', 's-ov')
  assert.equal(taken.snapshot.cursor, 2)
  clock.advance(5000)
  assert.equal(cleanedSecond, 0)

  // 2. deleteSessionFamily with transitive childrenOf callback + deleteServer
  cache.putSnapshot('srv-1', 'root-a', makeSnapshot(1, [makeRecord(1)]), 'visited')
  cache.putSnapshot('srv-1', 'child-a1', makeSnapshot(1, [makeRecord(1)]), 'visited')
  cache.putSnapshot('srv-1', 'grandchild-a1', makeSnapshot(1, [makeRecord(1)]), 'visited')
  cache.putSnapshot('srv-1', 'other-a', makeSnapshot(1, [makeRecord(1)]), 'visited')
  cache.putSnapshot('srv-2', 'root-b', makeSnapshot(1, [makeRecord(1)]), 'visited')

  const childMap = { 'root-a': ['child-a1'], 'child-a1': ['grandchild-a1'] }
  cache.deleteSessionFamily('srv-1', 'root-a', (id) => childMap[id])
  assert.equal(cache.getSnapshot('srv-1', 'root-a'), undefined)
  assert.equal(cache.getSnapshot('srv-1', 'child-a1'), undefined)
  assert.equal(cache.getSnapshot('srv-1', 'grandchild-a1'), undefined)
  assert.ok(cache.getSnapshot('srv-1', 'other-a'))
  assert.ok(cache.getSnapshot('srv-2', 'root-b'))

  // updateProjections & markStale
  const bytesBeforeProj = cache.stats().totalBytes
  assert.equal(cache.updateProjections('srv-1', 'other-a', { asOfSeq: 5, values: { summary: 'x'.repeat(200) } }), true)
  assert.ok(cache.stats().totalBytes > bytesBeforeProj)
  cache.markStale('srv-1', 'other-a')
  assert.equal(cache.getSnapshot('srv-1', 'other-a').stale, true)

  cache.deleteServer('srv-1')
  assert.equal(cache.getSnapshot('srv-1', 'other-a'), undefined)
  assert.ok(cache.getSnapshot('srv-2', 'root-b'))

  // 3. Single page exceeding maxSinglePageBytes bypasses; maxPageBytes evicts LRU page
  const smallPage = { items: ['a'] }
  const bigPage = { items: ['z'.repeat(2000)] }
  assert.equal(cache.putPage('srv-2', 'p', { beforeSeq: 10 }, smallPage), true)
  assert.equal(cache.putPage('srv-2', 'p', { beforeSeq: 20 }, bigPage), false, 'oversized single page bypasses')
  assert.deepEqual(cache.getPage('srv-2', 'p', { beforeSeq: 10 }), smallPage)

  const pageNearCap = { items: ['m'.repeat(30)] }
  assert.equal(cache.putPage('srv-2', 'p', { beforeSeq: 30 }, pageNearCap), true)
  assert.equal(cache.putPage('srv-2', 'p', { beforeSeq: 40 }, pageNearCap), true)
  assert.ok(cache.stats().pageBytes <= singlePageCap * 2)
})

// ---- T5: auto-prewarm-scheduler --------------------------------------------

test('T5 prewarm: picks Top 16 root sessions by updatedAt desc, skips subagents, and enforces concurrency=1', async () => {
  const clock = fakeClock()
  const cache = createSessionHistoryCache({ clock })
  const calls = []
  let inFlight = 0
  let maxInFlight = 0

  const client = {
    state: 'online',
    async fetchSessionSnapshot(req) {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      calls.push(req.address.sessionId)
      await Promise.resolve()
      inFlight -= 1
      return {
        ok: true,
        mode: 'full',
        snapshot: makeSnapshot(1, [makeRecord(1, 'turn/start')], { id: req.address.sessionId }),
      }
    },
  }

  const scheduler = createSessionPrewarmScheduler({
    cache,
    getOnlineTargets: () => [{ serverId: 'srv-1', client }],
    isForegroundBusy: () => false,
    clock,
  })

  // 25 root sessions (s-1 oldest .. s-25 newest) + 2 subagents (must be ignored)
  const items = Array.from({ length: 25 }, (_, i) => ({
    sessionId: `s-${i + 1}`,
    updatedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    running: false,
  }))
  items.push({ sessionId: 'sub-1', origin: 'subagent', updatedAt: new Date(1_800_000_000_000).toISOString() })
  items.push({ sessionId: 'sub-2', parentSession: 's-25', updatedAt: new Date(1_800_000_000_000).toISOString() })

  scheduler.noteSessionList('srv-1', { items })
  // Drive microtasks until queue settles
  for (let i = 0; i < 60; i += 1) await Promise.resolve()

  assert.equal(maxInFlight, 1, 'concurrency strictly <= 1')
  assert.equal(calls.length, 16, 'only Top 16 root sessions prewarmed')
  assert.deepEqual(
    calls,
    Array.from({ length: 16 }, (_, i) => `s-${25 - i}`),
    'prewarmed strictly in updatedAt descending order',
  )
  assert.equal(cache.stats().prewarmedCount, 16)
  assert.equal(cache.getSnapshot('srv-1', 'sub-1'), undefined)
  assert.equal(cache.getSnapshot('srv-1', 'sub-2'), undefined)
  scheduler.dispose()
})

test('T5 prewarm: foreground busy aborts in-flight fetch immediately and resumes after 300ms idle', async () => {
  const clock = fakeClock()
  const cache = createSessionHistoryCache({ clock })
  let busy = false
  const attempts = []

  const client = {
    state: 'online',
    fetchSessionSnapshot(req, signal) {
      const rec = { sessionId: req.address.sessionId, aborted: false }
      attempts.push(rec)
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          rec.aborted = true
          reject(new RelayError('aborted', 'aborted'))
        }, { once: true })
        rec.finish = () => resolve({
          ok: true,
          mode: 'full',
          snapshot: makeSnapshot(1, [makeRecord(1)], { id: req.address.sessionId }),
        })
      })
    },
  }

  const scheduler = createSessionPrewarmScheduler({
    cache,
    getOnlineTargets: () => [{ serverId: 'srv-1', client }],
    isForegroundBusy: () => busy,
    clock,
    idleDelayMs: 300,
  })

  scheduler.noteSessionList('srv-1', { items: [{ sessionId: 's-1', updatedAt: 1000 }] })
  await Promise.resolve()
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].aborted, false)

  // Foreground becomes busy -> immediately aborts in-flight prewarm
  busy = true
  scheduler.notifyForegroundBusy('srv-1', true)
  assert.equal(attempts[0].aborted, true)
  await Promise.resolve()

  // Foreground becomes idle -> waits full 300ms before retrying s-1
  busy = false
  scheduler.notifyForegroundBusy('srv-1', false)
  clock.advance(299)
  await Promise.resolve()
  assert.equal(attempts.length, 1, 'must wait full 300ms idle window')

  clock.advance(1)
  await Promise.resolve()
  assert.equal(attempts.length, 2, 'resumed s-1 after 300ms idle')
  attempts[1].finish()
  await Promise.resolve()
  assert.equal(cache.stats().prewarmedCount, 1)
  scheduler.dispose()
})

test('T5 prewarm: status running true->false and control seq>cursor trigger incremental refresh; 404/403/workspace-remove/oversized handled', async () => {
  const clock = fakeClock()
  const sampleSnap = makeSnapshot(10, [makeRecord(10)])
  const snapCap = estimateValueBytes(sampleSnap) + 1000
  const cache = createSessionHistoryCache({ clock, maxSnapshotBytes: snapCap })
  const calls = []
  let mode = 'normal'

  const client = {
    state: 'online',
    async fetchSessionSnapshot(req) {
      calls.push(req)
      if (mode === '404') return { ok: false, reason: 'unsupported' }
      if (mode === '403') throw new RelayError('not-shared', 'closed')
      if (mode === 'oversized') {
        return {
          ok: true,
          mode: 'full',
          snapshot: makeSnapshot(5, [makeRecord(1, 'message', { text: 'z'.repeat(2000) })]),
        }
      }
      if (req.knownCursor === 10) {
        return {
          ok: true,
          mode: 'delta',
          baseCursor: 10,
          cursor: 12,
          records: [makeRecord(11), makeRecord(12)],
          hasMore: false,
        }
      }
      return { ok: true, mode: 'full', snapshot: sampleSnap }
    },
  }

  const scheduler = createSessionPrewarmScheduler({
    cache,
    getOnlineTargets: () => [{ serverId: 'srv-1', client }],
    isForegroundBusy: () => false,
    clock,
  })

  scheduler.noteWorkspaceFrame('srv-1', {
    type: 'baseline',
    value: { items: [{ workspaceId: 'w-1', sessionIds: ['s-1', 's-gone'] }] },
  })
  scheduler.noteSessionList('srv-1', {
    items: [
      { sessionId: 's-1', updatedAt: 2000, running: true },
      { sessionId: 's-gone', updatedAt: 1000, running: false },
    ],
  })
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
  assert.equal(cache.getSnapshot('srv-1', 's-1').cursor, 10)
  assert.equal(cache.getSnapshot('srv-1', 's-gone').cursor, 10)

  // While running=true, control watermark > cursor marks dirty without fetching immediately
  const callsBeforeProj = calls.length
  scheduler.noteControlFrame('srv-1', { type: 'projection', sessionId: 's-1', seq: 12 })
  await Promise.resolve()
  assert.equal(calls.length, callsBeforeProj, 'defers refresh while session is running')

  // running true -> false triggers incremental knownCursor refresh
  scheduler.noteSessionStatus('srv-1', 's-1', false)
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  assert.equal(calls.length, callsBeforeProj + 1)
  assert.equal(calls.at(-1).knownCursor, 10)
  assert.equal(cache.getSnapshot('srv-1', 's-1').cursor, 12)

  // Workspace upsert removing s-gone immediately deletes it from cache
  scheduler.noteWorkspaceFrame('srv-1', {
    type: 'upsert',
    workspace: { workspaceId: 'w-1', sessionIds: ['s-1'] },
  })
  assert.equal(cache.getSnapshot('srv-1', 's-gone'), undefined)

  // Oversized snapshot bypassed without looping
  mode = 'oversized'
  scheduler.noteSessionList('srv-1', { items: [{ sessionId: 's-huge', updatedAt: 3000, running: false }] })
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  const hugeCalls = calls.filter((c) => c.address.sessionId === 's-huge').length
  assert.equal(hugeCalls, 1, 'oversized session is not re-fetched in an infinite loop')

  // 403 not-shared deletes session from cache
  mode = '403'
  scheduler.noteSessionStatus('srv-1', 's-1', true)
  scheduler.noteSessionStatus('srv-1', 's-1', false)
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  assert.equal(cache.getSnapshot('srv-1', 's-1'), undefined)

  // 404 unsupported disables prewarm for server until online reset
  mode = '404'
  scheduler.noteSessionList('srv-1', { items: [{ sessionId: 's-404', updatedAt: 4000 }] })
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  const callsAt404 = calls.length
  scheduler.noteSessionList('srv-1', { items: [{ sessionId: 's-after-404', updatedAt: 5000 }] })
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  assert.equal(calls.length, callsAt404, '404 disables further prewarm on same server connection')

  scheduler.dispose()
})

test('empty session cursor -1 advances to 0, invalid snapshots are rejected, and oversized refresh purges stale same-session entry', () => {
  const smallSnap = makeSnapshot(1, [makeRecord(1, 'message', { text: 'a'.repeat(100) })])
  const oneSize = estimateValueBytes(smallSnap)
  const cache = createSessionHistoryCache({
    maxSnapshotBytes: oneSize + 200,
    maxBytesPerServer: oneSize * 4,
    maxTotalBytes: oneSize * 8,
  })

  // Malformed snapshots are rejected without modifying state
  assert.equal(cache.putSnapshot('srv-1', 'bad-1', { type: 'other', cursor: 0, records: [] }, 'visited'), false)
  assert.equal(cache.putSnapshot('srv-1', 'bad-2', { type: 'snapshot', cursor: -2, records: [] }, 'visited'), false)
  assert.equal(cache.putSnapshot('srv-1', 'bad-3', { type: 'snapshot', cursor: 1.5, records: [] }, 'visited'), false)
  assert.equal(cache.putSnapshot('srv-1', 'bad-4', { type: 'snapshot', cursor: 0, records: null }, 'visited'), false)

  // Empty session cursor: -1 -> first event seq: 0
  assert.equal(cache.putSnapshot('srv-1', 'empty-1', makeSnapshot(-1, []), 'visited'), true)
  assert.equal(cache.getSnapshot('srv-1', 'empty-1').cursor, -1)
  assert.equal(cache.appendRecord('srv-1', 'empty-1', makeRecord(0, 'turn/start')), true)
  assert.equal(cache.getSnapshot('srv-1', 'empty-1').cursor, 0)
  assert.equal(cache.getSnapshot('srv-1', 'empty-1').snapshot.records.length, 1)

  // Same-session oversized refresh removes that session's stale prior cache while keeping other warm sessions
  assert.equal(cache.putSnapshot('srv-1', 'warm-keep', smallSnap, 'visited'), true)
  assert.equal(cache.putSnapshot('srv-1', 'grow-1', smallSnap, 'visited'), true)
  const hugeSnap = makeSnapshot(2, [makeRecord(1, 'message', { text: 'z'.repeat(2000) })])
  assert.equal(cache.putSnapshot('srv-1', 'grow-1', hugeSnap, 'visited'), false)
  assert.equal(cache.getSnapshot('srv-1', 'grow-1'), undefined, 'stale same-session entry must be removed on oversized refresh')
  assert.ok(cache.getSnapshot('srv-1', 'warm-keep'), 'unrelated warm session must survive')
})
