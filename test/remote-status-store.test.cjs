'use strict'
/* dsh-zen-remote · the remote-status store's network-hint wiring
 * (src/client-data/remote-status.ts: createRemoteStatusStore's hint half)
 *
 * PR29 added a browser→host fast path for network restoration: a window
 * `online` / visibility event fires a hint source, the store POSTs
 * client/network-hint once (in-flight slot + a client-side gap), and the
 * following refresh re-reads the status. The relay-client layer has its own
 * file (relay-network-restore.test.cjs); THIS file pins the store's half of
 * the glue, driven by a counting fake fetch and a hand-fired hint source —
 * the same direct-.ts-import discipline as client-desktop-gate.test.cjs.
 *
 * Pinned here:
 *  - one hint event = exactly one network-hint POST, then one auto-refresh;
 *  - the in-flight slot collapses overlapping hints;
 *  - the client-side gap (injected small via `hintGapMs`) refuses a fast
 *    second hint and admits it again once the gap has elapsed;
 *  - the hint source follows the subscribers (attach on first, detach on
 *    last, re-attach on return);
 *  - the healthy-link gate: while the last status read says `online`, a
 *    hint spends nothing (no POST, no refresh); `offline` still hints;
 *  - a store built WITHOUT a hint source keeps every other behavior;
 *  - `windowNetworkHint` under Node returns a detacher and never fires.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

/** A VisibilitySource the store can trust: always visible, no notifications. */
const ALWAYS_VISIBLE = { visible: () => true, subscribe: () => () => {} }

/** A NetworkHintSource the test drives by hand: it records attach/detach and
 * fires only when `fire()` is called. */
function makeHintSource() {
  const src = {
    listener: undefined,
    attached: 0,
    detached: 0,
    subscribe(listener) {
      src.attached += 1
      src.listener = listener
      return () => { src.detached += 1; src.listener = undefined }
    },
    fire() { if (src.listener !== undefined) src.listener() },
  }
  return src
}

/** One counting fake fetch: the status GET answers `statusState`; the hint
 * POST records and answers ok — held open until `releaseHint()` when
 * `hold` is set (the in-flight test needs a POST that is genuinely pending). */
function makeFakeFetch(statusState = 'offline') {
  const fake = {
    calls: [],
    statusState,
    hold: false,
    releaseHint: undefined,
  }
  fake.fetch = async (url, init) => {
    const method = init?.method ?? 'GET'
    fake.calls.push({ url, method })
    if (method === 'POST') {
      if (fake.hold) await new Promise((resolve) => { fake.releaseHint = resolve })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ state: fake.statusState, versionMismatch: false, serverName: 's', closed: {} }),
    }
  }
  return fake
}

function hintPosts(fake) {
  return fake.calls.filter((call) => call.method === 'POST')
}

function statusGets(fake) {
  return fake.calls.filter((call) => call.method === 'GET')
}

let storeMod
async function importStore() {
  storeMod ??= await import('../src/client-data/remote-status.ts')
  return storeMod
}

/** One store factory for the whole file: every test runs on the always-visible
 * source and a far-off poll cadence; src / gapMs are the knobs under test. */
async function makeStore(fake, src, gapMs) {
  const { createRemoteStatusStore } = await importStore()
  return createRemoteStatusStore(fake.fetch, ALWAYS_VISIBLE, 60_000, src, gapMs)
}

test('hint: one event = exactly one POST to client/network-hint', async () => {
  const { NETWORK_HINT_ROUTE } = await importStore()
  const src = makeHintSource()
  const fake = makeFakeFetch('offline')
  const store = await makeStore(fake, src)
  const off = store.subscribe(() => {})
  try {
    await settle()
    src.fire()
    await settle()
    const posts = hintPosts(fake)
    assert.equal(posts.length, 1, 'exactly one hint POST left the store')
    assert.equal(posts[0].url, NETWORK_HINT_ROUTE)
    assert.equal(statusGets(fake)[0].url, '/_dsh/zen-remote/client/remote-status', 'the GETs still target the status route')
  } finally { off() }
})

test('hint: after the POST lands, the store refreshes the status by itself', async () => {
  const src = makeHintSource()
  const fake = makeFakeFetch('offline')
  const store = await makeStore(fake, src)
  const off = store.subscribe(() => {})
  try {
    await settle()
    assert.equal(statusGets(fake).length, 1, 'baseline: the subscribe pull only')
    src.fire()
    await settle()
    const order = fake.calls.map((call) => call.method)
    assert.deepEqual(order, ['GET', 'POST', 'GET'], 'hint POST, then the follow-up status refresh')
  } finally { off() }
})

test('hint: in-flight dedupe — a second event while the POST is pending sends nothing', async () => {
  const src = makeHintSource()
  const fake = makeFakeFetch('offline')
  fake.hold = true
  const store = await makeStore(fake, src)
  const off = store.subscribe(() => {})
  try {
    await settle()
    src.fire()
    await settle()
    assert.equal(hintPosts(fake).length, 1, 'the first POST is held in flight')
    src.fire()
    await settle()
    assert.equal(hintPosts(fake).length, 1, 'the overlapping event was collapsed, not queued')
    fake.releaseHint()
    await settle()
    assert.equal(hintPosts(fake).length, 1, 'releasing the first POST does not loose a second one')
  } finally { off() }
})

test('hint: the client-side gap — a fast second event is refused, one after the gap is admitted', async () => {
  const src = makeHintSource()
  const fake = makeFakeFetch('offline')
  const store = await makeStore(fake, src, 50)
  const off = store.subscribe(() => {})
  try {
    await settle()
    src.fire()
    await settle()
    assert.equal(hintPosts(fake).length, 1, 'the first hint is honoured')
    src.fire()
    await settle()
    assert.equal(hintPosts(fake).length, 1, 'a second hint inside the gap is refused')
    await settle(60)
    src.fire()
    await settle()
    assert.equal(hintPosts(fake).length, 2, 'once the gap has elapsed, hints are admitted again')
  } finally { off() }
})

test('lifecycle: the hint source follows the subscribers — attach, detach, re-attach', async () => {
  const src = makeHintSource()
  const fake = makeFakeFetch('offline')
  const store = await makeStore(fake, src)
  assert.equal(src.attached, 0, 'no subscribers — nothing attached')
  const off = store.subscribe(() => {})
  assert.equal(src.attached, 1, 'the first subscriber attaches the hint source')
  off()
  assert.equal(src.detached, 1, 'the last unsubscribe detaches it')
  const off2 = store.subscribe(() => {})
  assert.equal(src.attached, 2, 'a returning subscriber re-attaches')
  off2()
  assert.equal(src.detached, 2)
})

test('notifyNetworkRestored: the manual trigger is exactly one hint round', async () => {
  const src = makeHintSource()
  const fake = makeFakeFetch('offline')
  const store = await makeStore(fake, src)
  const off = store.subscribe(() => {})
  try {
    await settle()
    store.notifyNetworkRestored()
    await settle()
    assert.equal(hintPosts(fake).length, 1, 'the manual probe POSTs once, like a fired event')
    assert.equal(fake.calls.at(-1).method, 'GET', 'and the follow-up refresh runs')
  } finally { off() }
})

test('no hint source wired (the default): every other behavior is untouched', async () => {
  const fake = makeFakeFetch('offline')
  const store = await makeStore(fake)
  const off = store.subscribe(() => {})
  try {
    await settle()
    assert.equal(statusGets(fake).length, 1, 'the poll half works as ever')
    assert.equal(store.getSnapshot().ready, true, 'the snapshot fills as ever')
    store.notifyNetworkRestored()
    await settle()
    assert.equal(hintPosts(fake).length, 1, 'the manual probe needs no source — it never did')
  } finally { off() }
})

test('windowNetworkHint under Node: a detacher comes back and nothing ever fires', async () => {
  const { windowNetworkHint, NETWORK_HINT_ROUTE } = await importStore()
  let fired = 0
  const detach = windowNetworkHint.subscribe(() => { fired += 1 })
  assert.equal(typeof detach, 'function', 'subscribe returns a callable detacher')
  detach()
  assert.doesNotThrow(detach, 'the detacher is safe to call twice')

  // Wired into a store on a host/SSR mount, it stays silent forever.
  const src = windowNetworkHint
  const fake = makeFakeFetch('offline')
  const store = await makeStore(fake, src)
  const off = store.subscribe(() => {})
  try {
    await settle()
    assert.equal(hintPosts(fake).length, 0, `no event ever POSTed ${NETWORK_HINT_ROUTE} from Node`)
    assert.equal(fired, 0, 'the listener itself was never invoked')
  } finally { off() }
})

// ---- the healthy-link gate (PR29 follow-up) --------------------------------------

test('gate: a HEALTHY last status read (online) swallows the hint — no POST, no refresh', async () => {
  const src = makeHintSource()
  const fake = makeFakeFetch('online')
  const store = await makeStore(fake, src)
  const off = store.subscribe(() => {})
  try {
    await settle()
    assert.equal(store.getSnapshot().view?.state, 'online', 'precondition: the status GET answered online')
    src.fire()
    await settle()
    assert.equal(hintPosts(fake).length, 0, 'a healthy link spends no hint')
    assert.equal(statusGets(fake).length, 1, 'and no follow-up refresh either — the triple is skipped whole')
    store.notifyNetworkRestored()
    await settle()
    assert.equal(hintPosts(fake).length, 0, 'the manual trigger passes the same gate')
  } finally { off() }
})

test('gate: view undefined (no GET yet) and OFFLINE both pass — the hint goes out and refreshes', async () => {
  const src = makeHintSource()
  const fake = makeFakeFetch('offline')
  const store = await makeStore(fake, src, 50)
  const off = store.subscribe(() => {})
  try {
    // Fired BEFORE the first GET has answered: view is still undefined — the
    // gate must stay conservative and let the hint through.
    src.fire()
    await settle()
    assert.equal(store.getSnapshot().ready, true)
    assert.equal(hintPosts(fake).length, 1, 'a hint fired before any status answer is not swallowed')

    // And an OFFLINE view keeps hinting (and refreshing) as before — after
    // the injected 50ms gap has elapsed.
    await settle(60)
    const before = fake.calls.length
    src.fire()
    await settle()
    const recent = fake.calls.slice(before)
    assert.ok(recent.some((call) => call.method === 'POST'), 'offline: the hint POSTs')
    assert.equal(recent.at(-1).method, 'GET', 'offline: the follow-up refresh runs')
  } finally { off() }
})

// ---- MS-6: the per-server views (servers dict) -----------------------------------

/** A poll body the MS-5 route answers with TWO paired servers: A online with
 * better-sidebar bridged, B offline without the bridge. The top level
 * mirrors A (the FIRST pool entry) for the old page. */
function multiServerBody() {
  return {
    state: 'online',
    versionMismatch: false,
    serverName: 'A-main',
    closed: {},
    bridgedPlugins: ['dsh-better-sidebar'],
    servers: {
      aaaa1111: { state: 'online', versionMismatch: false, serverName: 'A-main', bridgedPlugins: ['dsh-better-sidebar'] },
      bbbb2222: { state: 'offline', versionMismatch: false, serverName: 'B-backup', bridgedPlugins: [] },
    },
  }
}

const t = (key) => `#${key}`

test('MS-6: parseRemoteStatusBody carries the servers dict tolerantly', async () => {
  const { parseRemoteStatusBody } = await importStore()
  const now = 1_700_000_000_000

  const view = parseRemoteStatusBody(multiServerBody(), now)
  assert.deepEqual(view.servers.aaaa1111, {
    state: 'online', versionMismatch: false, serverName: 'A-main', bridgedPlugins: ['dsh-better-sidebar'],
  })
  assert.deepEqual(view.servers.bbbb2222, {
    state: 'offline', versionMismatch: false, serverName: 'B-backup', bridgedPlugins: [],
  })

  // The top-level fields still ride through unchanged (the old page's truth).
  assert.equal(view.state, 'online')
  assert.equal(view.serverName, 'A-main')
  assert.deepEqual(view.bridgedPlugins, ['dsh-better-sidebar'])

  // Garbage shapes degrade, never throw: a non-object dict, junk entries, a
  // junk field inside an entry, an empty serverId key.
  assert.deepEqual(parseRemoteStatusBody({ servers: 'garbage' }, now).servers, {})
  assert.deepEqual(parseRemoteStatusBody({ servers: 42 }, now).servers, {})
  assert.deepEqual(parseRemoteStatusBody({ servers: ['a'] }, now).servers, {})
  assert.deepEqual(
    parseRemoteStatusBody({ servers: { aaaa1111: 'garbage' } }, now).servers.aaaa1111,
    { state: 'offline', versionMismatch: false, serverName: '', bridgedPlugins: [] },
  )
  assert.deepEqual(
    parseRemoteStatusBody({ servers: { aaaa1111: { state: 'online', bridgedPlugins: 'x', versionMismatch: 1 } } }, now).servers.aaaa1111,
    { state: 'online', versionMismatch: false, serverName: '', bridgedPlugins: [] },
  )
  assert.deepEqual(parseRemoteStatusBody({ servers: { '': { state: 'online' } } }, now).servers, {}, 'an empty serverId owns no entry')

  // A legacy single-server body (no servers field) parses exactly as before,
  // with an EMPTY dict — the fallback path serves the parts.
  const legacy = parseRemoteStatusBody({ state: 'online', serverName: 's', closed: { s1: 'idle' } }, now)
  assert.deepEqual(legacy.servers, {})
  assert.equal(legacy.state, 'online')
})

test('MS-6: resolveServerStatusView picks the session\u2019s server, falling back to the top level', async () => {
  const { parseRemoteStatusBody, resolveServerStatusView } = await importStore()
  const view = parseRemoteStatusBody(multiServerBody(), 1)

  assert.equal(resolveServerStatusView(view, 'zr~aaaa1111~s1'), view.servers.aaaa1111, 'the session\u2019s own server entry')
  assert.equal(resolveServerStatusView(view, 'zr~bbbb2222~s2'), view.servers.bbbb2222)
  // A session whose server never answered (an entry without a serverId) falls
  // back to the TOP-LEVEL view — the old single-server answer.
  assert.equal(resolveServerStatusView(view, 'zr~cccc3333~x'), view)
  // Non-virtual and missing session ids keep the top-level fallback too.
  assert.equal(resolveServerStatusView(view, 'session-local'), view)
  assert.equal(resolveServerStatusView(view, undefined), view)
  assert.equal(resolveServerStatusView(view), view)
  assert.equal(resolveServerStatusView(undefined, 'zr~aaaa1111~s1'), undefined)
  assert.equal(resolveServerStatusView(null, 'zr~aaaa1111~s1'), undefined)

  // A hand-rolled view without a servers field (every pre-MS-6 caller) must
  // not throw and must answer the top-level view.
  const legacy = { state: 'online', versionMismatch: false, serverName: 's', closed: {}, bridgedPlugins: [], asOf: 1 }
  assert.equal(resolveServerStatusView(legacy, 'zr~aaaa1111~s1'), legacy)
})

test('MS-6 acceptance: describeRemoteStatus answers per server for the icon', async () => {
  const { parseRemoteStatusBody, describeRemoteStatus } = await importStore()
  const view = parseRemoteStatusBody(multiServerBody(), 1)

  assert.deepEqual(describeRemoteStatus(view, t, 'zr~aaaa1111~s1'), { state: 'online', hoverText: '#remoteStatusOnline' })
  assert.deepEqual(describeRemoteStatus(view, t, 'zr~bbbb2222~s2'), { state: 'offline', hoverText: '#remoteStatusOffline' })

  // Without a session id (or with one the dict cannot answer) the behavior is
  // exactly the pre-MS-6 one: the top-level view decides.
  assert.deepEqual(describeRemoteStatus(view, t), { state: 'online', hoverText: '#remoteStatusOnline' })
  assert.deepEqual(describeRemoteStatus(view, t, 'zr~cccc3333~x'), { state: 'online', hoverText: '#remoteStatusOnline' })
  assert.deepEqual(describeRemoteStatus(undefined, t, 'zr~aaaa1111~s1'), { state: 'offline', hoverText: '#remoteStatusOffline' })

  // A per-server mismatch only ever shows while THAT server is online.
  const mismatched = parseRemoteStatusBody({
    ...multiServerBody(),
    servers: {
      ...multiServerBody().servers,
      bbbb2222: { state: 'online', versionMismatch: true, serverName: 'B-backup', bridgedPlugins: [] },
    },
  }, 1)
  assert.deepEqual(describeRemoteStatus(mismatched, t, 'zr~bbbb2222~s2'), { state: 'mismatch', hoverText: '#remoteStatusMismatch' })
})

test('MS-6 acceptance: bannerText answers per server for the composer', async () => {
  const { parseRemoteStatusBody, bannerText } = await importStore()
  const view = parseRemoteStatusBody(multiServerBody(), 1)

  // A online: no banner. B offline: the temporarily-readonly line.
  assert.equal(bannerText(view, 'zr~aaaa1111~s1', t), undefined)
  assert.equal(bannerText(view, 'zr~bbbb2222~s2', t), '#remoteBannerOffline')

  // The closed map stays SESSION-keyed (virtual ids embed their server, so
  // one global dict cannot collide) and still outranks the link state.
  const closed = parseRemoteStatusBody({
    ...multiServerBody(),
    closed: { 'zr~bbbb2222~s2': 'idle' },
  }, 1)
  assert.equal(bannerText(closed, 'zr~bbbb2222~s2', t), '#remoteBannerClosedIdle')
  assert.equal(bannerText(closed, 'zr~aaaa1111~s1', t), undefined, 'B\u2019s closure says nothing about A\u2019s session')
})
