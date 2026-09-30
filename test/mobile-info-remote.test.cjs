// dsh-zen-remote · T67 the mobile info-card remote-access row
//
// The「远程访问」row in the phone session-info sheet, driven at the two
// layers Node can reach (MobileSessionInfo.tsx is JSX — Node's type
// stripping rejects it, so per the task's own note the component half is
// pinned textually, the same fallback client-desktop-gate.test.cjs uses):
//
// - the PURE derivation (src/client-data/shares.ts shareCardRemoteView):
//   the shared visibility gate (host role + answered table + not a
//   subagent), the shared/shared-not split, and a description line built
//   from the EXISTING words — the icon's state/countdown copy plus the
//   settings list's viewers line (reused verbatim, never duplicated);
// - the component's wiring: subscribe only while the sheet is open (a
//   subscription is what keeps the 30 s admin/shares poll alive, and the
//   phone shell must not poll through the gateway), pull once on open,
//   the accessible switch semantics, the row's own busy window and the
//   shareFailText error path.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const loadView = () => import('../src/client-data/shares.ts?' + Math.random())

const ROOT = join(__dirname, '..')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const NOW = 1_700_000_000_000

/** A formatter that records WHICH keys were read — the copy-reuse rule is
 * part of the spec (no duplicate words), so the test asserts the keys. */
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

const ENTRY = (over = {}) => ({
  sessionId: 'session-1', sharedAt: NOW - 1000, lastActivityAt: NOW - 1000,
  busy: false, remainingMs: 45 * 60_000, viewers: 0, title: null, asOf: NOW,
  ...over,
})

test('T67 view: host + answered table + regular session → visible; the entryless row reads off', async () => {
  const { shareCardRemoteView } = await loadView()
  const t = fakeT()
  const view = shareCardRemoteView({ ready: true, role: 'host', subagent: false, entry: undefined, now: NOW, t })
  assert.deepEqual(view, { visible: true, shared: false, line: 'shareRemoteStateOff' })
})

test('T67 view: shared reads on with the idle countdown; watchers reuse the settings viewers line', async () => {
  const { shareCardRemoteView } = await loadView()
  const t = fakeT()
  const on = shareCardRemoteView({ ready: true, role: 'host', subagent: false, entry: ENTRY(), now: NOW, t })
  assert.equal(on.shared, true)
  assert.deepEqual(t.used, ['shareRemoteStateOn', 'shareRemoteRemainingMinutes({"count":45})'], 'the icon\'s own words, nothing duplicated')
  assert.equal(on.line, 'shareRemoteStateOn · 45 分钟后闲置休眠', 'the state word plus the icon\'s countdown copy')

  const watched = shareCardRemoteView({ ready: true, role: 'host', subagent: false, entry: ENTRY({ viewers: 2 }), now: NOW, t })
  assert.deepEqual(t.used.includes('settings.shareViewers({"count":2})'), true, 'the settings list\'s viewers line, reused verbatim')
  assert.equal(watched.line, 'shareRemoteStateOn · 2 台设备正在查看 · 45 分钟后闲置休眠')

  const busy = shareCardRemoteView({ ready: true, role: 'host', subagent: false, entry: ENTRY({ busy: true, remainingMs: null }), now: NOW, t })
  assert.equal(busy.line, 'shareRemoteStateOn · shareRemoteBusy', 'the busy copy replaces the countdown')
})

test('T67 view: the gate — client role, unanswered table, subagent session all render nothing', async () => {
  const { shareCardRemoteView } = await loadView()
  const base = { ready: true, role: 'host', subagent: false, entry: ENTRY(), now: NOW, t: fakeT() }
  assert.equal(shareCardRemoteView({ ...base, role: 'client' }).visible, false, 'a sub-client has no server table')
  assert.equal(shareCardRemoteView({ ...base, role: 'unknown' }).visible, false, 'an unwired role renders nothing')
  assert.equal(shareCardRemoteView({ ...base, ready: false }).visible, false, 'never answered → nothing')
  assert.equal(shareCardRemoteView({ ...base, subagent: true }).visible, false, 'the server refuses to share a subagent alone')
})

// -- the component's wiring (textual: .tsx has no Node harness) ---------------

test('T67 wiring: subscribe only while open, pull once on open, accessible switch, row-local busy', () => {
  const source = readFileSync(join(ROOT, 'src', 'client', 'MobileSessionInfo.tsx'), 'utf8')

  // T68: the gating itself is a tested pure function (subscribeWhileOpen —
  // see the behavior test below); here only a LOOSE call-presence check.
  assert.ok(source.includes('subscribeWhileOpen(shares, open, onStoreChange)'), 'the subscription goes through the tested gating function')
  assert.ok(source.includes('void shares.refresh()'), 'opening the sheet reads the table once right away')

  // The switch is an accessible one (role/aria, not a bare div).
  const switchAt = source.indexOf('role="switch"')
  assert.notEqual(switchAt, -1, 'the switch carries role="switch"')
  const switchBlock = source.slice(switchAt, source.indexOf('/>', switchAt))
  assert.ok(switchBlock.includes('aria-checked={remoteRow.shared}'), 'aria-checked mirrors the shared state')
  assert.ok(switchBlock.includes('aria-label={t(\'infoRemoteAccess\')}'), 'an accessible label')
  assert.ok(switchBlock.includes('disabled={remoteBusy}'), 'the switch disables itself while a push is in flight')

  // The toggle: share/unshare by the derived state; a refusal lands on the
  // sheet's error row via the shared shareFailText copy.
  const toggleAt = source.indexOf('const onToggleRemote = (): void => {')
  assert.notEqual(toggleAt, -1)
  const toggleBlock = source.slice(toggleAt, source.indexOf('remoteRow.shared ? \'unshare\' : \'share\'', toggleAt) + 40)
  assert.ok(toggleBlock.includes('shares.unshare(sessionId)'), 'an on switch unshares')
  assert.ok(toggleBlock.includes('shares.share(sessionId)'), 'an off switch shares')
  assert.ok(toggleBlock.includes('shareFailText(outcome'), 'failures use the shared failure copy')
})

test('T67 wiring: the store arrives as the SAME page-wide singleton via the registration inject', () => {
  const index = readFileSync(join(ROOT, 'src', 'client', 'index.tsx'), 'utf8')
  const injectAt = index.indexOf("id: 'mobile-session-info'")
  assert.notEqual(injectAt, -1, 'the info sheet registration is the anchor')
  const injectBlock = index.slice(injectAt, index.indexOf('MobileSessionInfo)', injectAt))
  assert.ok(injectBlock.includes('shares: getSharesStore()'), 'the shared singleton is bound, never a second store')
})

// -- subscribeWhileOpen: the behavior behind the row's subscription ----------

/** A shares store over a COUNTING fake fetch (the real createSharesStore,
 * 5 ms poll cadence, always-visible Node), plus its request counter. */
async function makeCountedStore() {
  const { createSharesStore } = await loadView()
  let requests = 0
  const store = createSharesStore(async () => {
    requests += 1
    return {
      ok: true,
      json: async () => ({ ok: true, shares: [] }),
    }
  }, undefined, 5)
  store.setRole('host')
  return { store, requests: () => requests }
}

test('T68 subscribeWhileOpen: closed subscribes nothing, open polls, unsubscribe stops it', async () => {
  const { store, requests } = await makeCountedStore()
  const { subscribeWhileOpen } = await loadView()
  try {
    // Closed sheet: the no-op unsubscribe means the store never sees a
    // listener — no poll, no request.
    const closed = subscribeWhileOpen(store, false, () => {})
    closed()
    await wait(30)
    assert.equal(requests(), 0, 'a closed sheet never polls')

    // Open: the real subscription starts the 5 ms cadence.
    const unsubscribe = subscribeWhileOpen(store, true, () => {})
    await wait(30)
    const seenWhileOpen = requests()
    assert.ok(seenWhileOpen >= 2, `an open sheet polls (saw ${seenWhileOpen} requests)`)

    // Unsubscribed: the cadence stops for good.
    unsubscribe()
    await wait(30)
    const seenAtStop = requests()
    await wait(30)
    assert.equal(requests(), seenAtStop, 'the poll stopped after the sheet closed')
  } finally {
    store.setRole('client')
  }
})
