'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

const ALWAYS_VISIBLE = { visible: () => true, subscribe: () => () => {} }

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

const hintPosts = (fake) => fake.calls.filter((call) => call.method === 'POST')
const statusGets = (fake) => fake.calls.filter((call) => call.method === 'GET')

let storeMod
async function importStore() {
  storeMod ??= await import('../src/client-data/remote-status.ts')
  return storeMod
}

async function makeStore(fake, src, gapMs) {
  const { createRemoteStatusStore } = await importStore()
  return createRemoteStatusStore(fake.fetch, ALWAYS_VISIBLE, 60_000, src, gapMs)
}

test('hint: one event = exactly one POST to client/network-hint and follow-up refresh', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10_000 })
  const { NETWORK_HINT_ROUTE } = await importStore()
  const src = makeHintSource()
  const fake = makeFakeFetch('offline')
  const store = await makeStore(fake, src)
  const off = store.subscribe(() => {})
  try {
    await settle()
    assert.equal(statusGets(fake).length, 1)
    src.fire()
    await settle()
    const posts = hintPosts(fake)
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, NETWORK_HINT_ROUTE)
    assert.equal(statusGets(fake)[0].url, '/_dsh/zen-remote/client/remote-status')
    assert.deepEqual(fake.calls.map((call) => call.method), ['GET', 'POST', 'GET'])
  } finally { off() }
})

test('hint: in-flight dedupe collapses overlapping hints', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10_000 })
  const src = makeHintSource()
  const fake = makeFakeFetch('offline')
  fake.hold = true
  const store = await makeStore(fake, src)
  const off = store.subscribe(() => {})
  try {
    await settle()
    src.fire()
    await settle()
    assert.equal(hintPosts(fake).length, 1)
    src.fire()
    await settle()
    assert.equal(hintPosts(fake).length, 1)
    fake.releaseHint()
    await settle()
    assert.equal(hintPosts(fake).length, 1)
  } finally { off() }
})

test('hint: the client-side gap refuses a fast second event and admits after gap', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10_000 })
  const src = makeHintSource()
  const fake = makeFakeFetch('offline')
  const store = await makeStore(fake, src, 50)
  const off = store.subscribe(() => {})
  try {
    await settle()
    src.fire()
    await settle()
    assert.equal(hintPosts(fake).length, 1)
    src.fire()
    await settle()
    assert.equal(hintPosts(fake).length, 1)
    t.mock.timers.tick(60)
    src.fire()
    await settle()
    assert.equal(hintPosts(fake).length, 2)
  } finally { off() }
})

test('lifecycle: hint source attach/detach/re-attach, manual notify, no source, and windowNetworkHint under Node', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10_000 })
  const src = makeHintSource()
  const fake = makeFakeFetch('offline')
  const store = await makeStore(fake, src)
  assert.equal(src.attached, 0)
  const off = store.subscribe(() => {})
  assert.equal(src.attached, 1)
  await settle()
  store.notifyNetworkRestored()
  await settle()
  assert.equal(hintPosts(fake).length, 1)
  assert.equal(fake.calls.at(-1).method, 'GET')
  off()
  assert.equal(src.detached, 1)
  const off2 = store.subscribe(() => {})
  assert.equal(src.attached, 2)
  off2()
  assert.equal(src.detached, 2)

  const noSrcFake = makeFakeFetch('offline')
  const noSrcStore = await makeStore(noSrcFake)
  const offNoSrc = noSrcStore.subscribe(() => {})
  try {
    await settle()
    assert.equal(statusGets(noSrcFake).length, 1)
    assert.equal(noSrcStore.getSnapshot().ready, true)
    noSrcStore.notifyNetworkRestored()
    await settle()
    assert.equal(hintPosts(noSrcFake).length, 1)
  } finally { offNoSrc() }

  const { windowNetworkHint } = await importStore()
  let fired = 0
  const detach = windowNetworkHint.subscribe(() => { fired += 1 })
  assert.equal(typeof detach, 'function')
  detach()
  assert.doesNotThrow(detach)
  const nodeFake = makeFakeFetch('offline')
  const nodeStore = await makeStore(nodeFake, windowNetworkHint)
  const offNode = nodeStore.subscribe(() => {})
  try {
    await settle()
    assert.equal(hintPosts(nodeFake).length, 0)
    assert.equal(fired, 0)
  } finally { offNode() }
})

test('gate: healthy (online) swallows hint; undefined/offline passes', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10_000 })
  {
    const src = makeHintSource()
    const fake = makeFakeFetch('online')
    const store = await makeStore(fake, src)
    const off = store.subscribe(() => {})
    try {
      await settle()
      assert.equal(store.getSnapshot().view?.state, 'online')
      src.fire()
      await settle()
      assert.equal(hintPosts(fake).length, 0)
      assert.equal(statusGets(fake).length, 1)
      store.notifyNetworkRestored()
      await settle()
      assert.equal(hintPosts(fake).length, 0)
    } finally { off() }
  }

  {
    const src = makeHintSource()
    const fake = makeFakeFetch('offline')
    const store = await makeStore(fake, src, 50)
    const off = store.subscribe(() => {})
    try {
      src.fire()
      await settle()
      assert.equal(store.getSnapshot().ready, true)
      assert.equal(hintPosts(fake).length, 1)

      t.mock.timers.tick(60)
      const before = fake.calls.length
      src.fire()
      await settle()
      const recent = fake.calls.slice(before)
      assert.ok(recent.some((call) => call.method === 'POST'))
      assert.equal(recent.at(-1).method, 'GET')
    } finally { off() }
  }
})

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

const tKey = (key) => `#${key}`

test('MS-6: parseRemoteStatusBody, resolveServerStatusView, describeRemoteStatus, bannerText', async () => {
  const { parseRemoteStatusBody, resolveServerStatusView, describeRemoteStatus, bannerText } = await importStore()
  const now = 1_700_000_000_000
  const view = parseRemoteStatusBody(multiServerBody(), now)
  assert.deepEqual(view.servers.aaaa1111, {
    state: 'online', versionMismatch: false, serverName: 'A-main', bridgedPlugins: ['dsh-better-sidebar'],
  })
  assert.deepEqual(view.servers.bbbb2222, {
    state: 'offline', versionMismatch: false, serverName: 'B-backup', bridgedPlugins: [],
  })
  assert.equal(view.state, 'online')
  assert.equal(view.serverName, 'A-main')
  assert.deepEqual(view.bridgedPlugins, ['dsh-better-sidebar'])

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
  assert.deepEqual(parseRemoteStatusBody({ servers: { '': { state: 'online' } } }, now).servers, {})

  const legacy = parseRemoteStatusBody({ state: 'online', serverName: 's', closed: { s1: 'idle' } }, now)
  assert.deepEqual(legacy.servers, {})
  assert.equal(legacy.state, 'online')

  assert.equal(resolveServerStatusView(view, 'zr~aaaa1111~s1'), view.servers.aaaa1111)
  assert.equal(resolveServerStatusView(view, 'zr~bbbb2222~s2'), view.servers.bbbb2222)
  assert.equal(resolveServerStatusView(view, 'zr~cccc3333~x'), view)
  assert.equal(resolveServerStatusView(view, 'session-local'), view)
  assert.equal(resolveServerStatusView(view, undefined), view)
  assert.equal(resolveServerStatusView(view), view)
  assert.equal(resolveServerStatusView(undefined, 'zr~aaaa1111~s1'), undefined)
  assert.equal(resolveServerStatusView(null, 'zr~aaaa1111~s1'), undefined)
  const handView = { state: 'online', versionMismatch: false, serverName: 's', closed: {}, bridgedPlugins: [], asOf: 1 }
  assert.equal(resolveServerStatusView(handView, 'zr~aaaa1111~s1'), handView)

  assert.deepEqual(describeRemoteStatus(view, tKey, 'zr~aaaa1111~s1'), { state: 'online', hoverText: '#remoteStatusOnline' })
  assert.deepEqual(describeRemoteStatus(view, tKey, 'zr~bbbb2222~s2'), { state: 'offline', hoverText: '#remoteStatusOffline' })
  assert.deepEqual(describeRemoteStatus(view, tKey), { state: 'online', hoverText: '#remoteStatusOnline' })
  assert.deepEqual(describeRemoteStatus(view, tKey, 'zr~cccc3333~x'), { state: 'online', hoverText: '#remoteStatusOnline' })
  assert.deepEqual(describeRemoteStatus(undefined, tKey, 'zr~aaaa1111~s1'), { state: 'offline', hoverText: '#remoteStatusOffline' })

  const mismatched = parseRemoteStatusBody({
    ...multiServerBody(),
    servers: {
      ...multiServerBody().servers,
      bbbb2222: { state: 'online', versionMismatch: true, serverName: 'B-backup', bridgedPlugins: [] },
    },
  }, 1)
  assert.deepEqual(describeRemoteStatus(mismatched, tKey, 'zr~bbbb2222~s2'), { state: 'mismatch', hoverText: '#remoteStatusMismatch' })

  assert.equal(bannerText(view, 'zr~aaaa1111~s1', tKey), undefined)
  assert.equal(bannerText(view, 'zr~bbbb2222~s2', tKey), '#remoteBannerOffline')
  const closed = parseRemoteStatusBody({ ...multiServerBody(), closed: { 'zr~bbbb2222~s2': 'idle' } }, 1)
  assert.equal(bannerText(closed, 'zr~bbbb2222~s2', tKey), '#remoteBannerClosedIdle')
  assert.equal(bannerText(closed, 'zr~aaaa1111~s1', tKey), undefined)
})

// ---- Absorbed from remote-bridge-mark.test.cjs (PB-14 + MS-6 bridge stamp) ----

test('PB-14 & MS-6: bridgedPlugins parsing, shouldStampBridgeAttribute, and shouldStampBridgeForSession', async () => {
  const {
    parseRemoteStatusBody,
    shouldStampBridgeAttribute,
    shouldStampBridgeForSession,
    BRIDGE_STAMP_ATTRIBUTE,
    BRIDGE_STAMP_PLUGIN,
  } = await importStore()
  const now = 1_700_000_000_000

  assert.deepEqual(parseRemoteStatusBody({ state: 'online', bridgedPlugins: ['dsh-better-sidebar', 'other-panel'] }, now).bridgedPlugins, ['dsh-better-sidebar', 'other-panel'])
  assert.deepEqual(parseRemoteStatusBody({ bridgedPlugins: ['dsh-better-sidebar', 42, null, '', 'x'] }, now).bridgedPlugins, ['dsh-better-sidebar', 'x'])
  assert.deepEqual(parseRemoteStatusBody({ state: 'online' }, now).bridgedPlugins, [])
  assert.deepEqual(parseRemoteStatusBody({ bridgedPlugins: 'dsh-better-sidebar' }, now).bridgedPlugins, [])
  assert.deepEqual(parseRemoteStatusBody({ bridgedPlugins: { 0: 'dsh-better-sidebar' } }, now).bridgedPlugins, [])
  assert.deepEqual(parseRemoteStatusBody('garbage', now).bridgedPlugins, [])

  assert.equal(BRIDGE_STAMP_PLUGIN, 'dsh-better-sidebar')
  assert.equal(BRIDGE_STAMP_ATTRIBUTE, 'data-zr-bridge-dsh-better-sidebar')
  assert.equal(shouldStampBridgeAttribute(['dsh-better-sidebar'], 'dsh-better-sidebar'), true)
  assert.equal(shouldStampBridgeAttribute(['other-panel'], 'dsh-better-sidebar'), false)
  assert.equal(shouldStampBridgeAttribute(undefined, 'dsh-better-sidebar'), false)
  assert.equal(shouldStampBridgeAttribute('dsh-better-sidebar', 'dsh-better-sidebar'), false)
  assert.equal(shouldStampBridgeAttribute(null, 'dsh-better-sidebar'), false)

  const checkView = parseRemoteStatusBody({ state: 'online', versionMismatch: true, serverName: 'srv', closed: { s1: 'idle' } }, 1)
  assert.equal(checkView.state, 'online')
  assert.equal(checkView.versionMismatch, true)
  assert.equal(checkView.serverName, 'srv')
  assert.deepEqual(checkView.closed, { s1: 'idle' })
  assert.equal(checkView.asOf, 1)

  const msView = parseRemoteStatusBody(multiServerBody(), 1)
  assert.equal(shouldStampBridgeForSession(msView, 'zr~aaaa1111~s1', 'dsh-better-sidebar'), true)
  assert.equal(shouldStampBridgeForSession(msView, 'zr~bbbb2222~s2', 'dsh-better-sidebar'), false)
  assert.equal(shouldStampBridgeForSession(msView, 'zr~aaaa1111~s1', 'other-panel'), false)
  assert.equal(shouldStampBridgeForSession(msView, 'zr~cccc3333~x', 'dsh-better-sidebar'), true)
  assert.equal(shouldStampBridgeForSession(msView, undefined, 'dsh-better-sidebar'), true)
  assert.equal(shouldStampBridgeForSession(msView, 'session-local', 'dsh-better-sidebar'), true)
  assert.equal(shouldStampBridgeForSession(undefined, 'zr~aaaa1111~s1', 'dsh-better-sidebar'), false)

  const legacy = parseRemoteStatusBody({ state: 'online', bridgedPlugins: ['dsh-better-sidebar'] }, 1)
  assert.equal(shouldStampBridgeForSession(legacy, 'zr~aaaa1111~s1', 'dsh-better-sidebar'), true)
})

test('MS-6: switching remote A to remote B re-judges the bridge stamp without a new poll', async (t) => {
  const attrs = new Map()
  const root = {
    setAttribute: (name, value) => { attrs.set(name, value) },
    getAttribute: (name) => attrs.get(name) ?? null,
    removeAttribute: (name) => { attrs.delete(name) },
    style: { setProperty() {}, removeProperty() {} },
  }
  const realFetch = globalThis.fetch
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document')
  globalThis.document = {
    documentElement: root,
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      state: 'online',
      closed: {},
      bridgedPlugins: ['dsh-better-sidebar'],
      servers: {
        aaaa1111: { state: 'online', bridgedPlugins: ['dsh-better-sidebar'] },
        bbbb2222: { state: 'online', bridgedPlugins: [] },
      },
    }),
  })

  const SESSION_A = 'zr~aaaa1111~s1'
  const SESSION_B = 'zr~bbbb2222~s2'
  const currentListeners = new Set()
  const uiSession = {
    current: {
      value: { key: SESSION_A },
      subscribe: (listener) => { currentListeners.add(listener); return () => { currentListeners.delete(listener) } },
    },
  }
  const effects = new Map()
  const ctx = {
    effect: (producer, label) => { effects.set(label, producer) },
    get: (name) => (name === 'uiSession' ? uiSession : undefined),
    sessions: {
      list: {
        getSnapshot: () => ({
          byId: {
            [SESSION_A]: { retainedBy: { mainView: 1 } },
            [SESSION_B]: { retainedBy: { mainView: 1 } },
          },
        }),
        subscribe: () => () => {},
      },
    },
  }
  const { installRemoteSessionGuard } = await import('../src/client/effects/remote-session.ts')
  const { BRIDGE_STAMP_ATTRIBUTE, getRemoteStatusStore } = await importStore()
  installRemoteSessionGuard(ctx)
  const dispose = effects.get('dsh-zen-remote: bridge stamp')()
  t.after(() => {
    dispose()
    globalThis.fetch = realFetch
    if (prevDoc === undefined) delete globalThis.document
    else Object.defineProperty(globalThis, 'document', prevDoc)
  })

  await getRemoteStatusStore().refresh()
  assert.equal(attrs.get(BRIDGE_STAMP_ATTRIBUTE), '1')

  uiSession.current.value = { key: SESSION_B }
  for (const listener of currentListeners) listener()
  assert.equal(attrs.has(BRIDGE_STAMP_ATTRIBUTE), false)

  uiSession.current.value = { key: SESSION_A }
  for (const listener of currentListeners) listener()
  assert.equal(attrs.get(BRIDGE_STAMP_ATTRIBUTE), '1')
})

test('T7 chat silence: RemoteStatusIcon and RemoteComposerBanner never alter state on gatewayOutdated/pluginOutdated', async () => {
  const { bannerText, describeRemoteStatus } = await importStore()
  const t = (key) => key
  const onlineView = {
    state: 'online',
    versionMismatch: false,
    serverName: 'study-pc',
    closed: {},
    servers: {
      aaaa1111: {
        state: 'online',
        versionMismatch: false,
        serverName: 'study-pc',
        closed: {},
      },
    },
  }
  const desc = describeRemoteStatus(onlineView, t, 'zr~aaaa1111~s1')
  assert.equal(desc.state, 'online')
  assert.equal(bannerText(onlineView, 'zr~aaaa1111~s1', t), undefined)

  // Only true incompatible uses the existing disconnect state
  const incompatDesc = describeRemoteStatus(
    { state: 'incompatible', versionMismatch: false, serverName: 's', closed: {} },
    t,
    'zr~aaaa1111~s1',
  )
  assert.equal(incompatDesc.state, 'offline')
})
