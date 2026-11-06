// dsh-zen-remote · PB-14: the bridge stamp's pure core
// (src/client-data/remote-status.ts)
//
// The remote-status body's `bridgedPlugins` list decides whether the
// better-sidebar panels stay visible in a remote session: the pure parse
// (tolerant — a garbage field degrades to "nothing bridged") and the
// shouldStampBridgeAttribute verdict the remote-session effect spends on
// the html attribute. Pure functions, driven the dynamic .ts way.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/client-data/remote-status.ts?' + Math.random())

test('PB-14: the parse carries bridgedPlugins tolerantly', async () => {
  const { parseRemoteStatusBody } = await load()
  const now = 1_700_000_000_000

  // A real body: the list rides through verbatim.
  const full = parseRemoteStatusBody({ state: 'online', bridgedPlugins: ['dsh-better-sidebar', 'other-panel'] }, now)
  assert.deepEqual(full.bridgedPlugins, ['dsh-better-sidebar', 'other-panel'])

  // Non-string and empty entries are dropped, not kept.
  const filtered = parseRemoteStatusBody({ bridgedPlugins: ['dsh-better-sidebar', 42, null, '', 'x'] }, now)
  assert.deepEqual(filtered.bridgedPlugins, ['dsh-better-sidebar', 'x'])

  // An older server that never learned the field, or a broken body, reads
  // as NOTHING bridged — the hiding rules stay in force.
  assert.deepEqual(parseRemoteStatusBody({ state: 'online' }, now).bridgedPlugins, [])
  assert.deepEqual(parseRemoteStatusBody({ bridgedPlugins: 'dsh-better-sidebar' }, now).bridgedPlugins, [])
  assert.deepEqual(parseRemoteStatusBody({ bridgedPlugins: { 0: 'dsh-better-sidebar' } }, now).bridgedPlugins, [])
  assert.deepEqual(parseRemoteStatusBody('garbage', now).bridgedPlugins, [])
})

test('PB-14: shouldStampBridgeAttribute judges one plugin off the list', async () => {
  const { shouldStampBridgeAttribute, BRIDGE_STAMP_ATTRIBUTE, BRIDGE_STAMP_PLUGIN } = await load()
  assert.equal(BRIDGE_STAMP_PLUGIN, 'dsh-better-sidebar')
  assert.equal(BRIDGE_STAMP_ATTRIBUTE, 'data-zr-bridge-dsh-better-sidebar')

  assert.equal(shouldStampBridgeAttribute(['dsh-better-sidebar'], 'dsh-better-sidebar'), true)
  assert.equal(shouldStampBridgeAttribute(['other-panel'], 'dsh-better-sidebar'), false)
  // Garbage inputs read as NOT bridged — the hiding rules stay unless the
  // server positively says otherwise.
  assert.equal(shouldStampBridgeAttribute(undefined, 'dsh-better-sidebar'), false)
  assert.equal(shouldStampBridgeAttribute('dsh-better-sidebar', 'dsh-better-sidebar'), false)
  assert.equal(shouldStampBridgeAttribute(null, 'dsh-better-sidebar'), false)
})

test('PB-14: the parse keeps every OTHER field\u2019s tolerance while bridgedPlugins lands', async () => {
  const { parseRemoteStatusBody } = await load()
  const now = 1
  const view = parseRemoteStatusBody({ state: 'online', versionMismatch: true, serverName: 'srv', closed: { 's1': 'idle' } }, now)
  assert.equal(view.state, 'online')
  assert.equal(view.versionMismatch, true)
  assert.equal(view.serverName, 'srv')
  assert.deepEqual(view.closed, { s1: 'idle' })
  assert.equal(view.asOf, now)
})

// ---- MS-6: the per-server bridge verdicts ----------------------------------------

/** The MS-6 poll body: server A bridges better-sidebar, B does not; the top
 * level mirrors A (the FIRST pool entry). */
function multiServerView(mod) {
  const { parseRemoteStatusBody } = mod
  return parseRemoteStatusBody({
    state: 'online',
    versionMismatch: false,
    serverName: 'A-main',
    closed: {},
    bridgedPlugins: ['dsh-better-sidebar'],
    servers: {
      aaaa1111: { state: 'online', versionMismatch: false, serverName: 'A-main', bridgedPlugins: ['dsh-better-sidebar'] },
      bbbb2222: { state: 'offline', versionMismatch: false, serverName: 'B-backup', bridgedPlugins: [] },
    },
  }, 1)
}

test('MS-6 acceptance: shouldStampBridgeForSession judges the session\u2019s OWN server', async () => {
  const mod = await load()
  const { shouldStampBridgeForSession } = mod
  const view = multiServerView(mod)

  assert.equal(shouldStampBridgeForSession(view, 'zr~aaaa1111~s1', 'dsh-better-sidebar'), true, 'A bridges the plugin')
  assert.equal(shouldStampBridgeForSession(view, 'zr~bbbb2222~s2', 'dsh-better-sidebar'), false, 'B does not — the panel must stay hidden there')

  // Other plugins stay judged per server too.
  assert.equal(shouldStampBridgeForSession(view, 'zr~aaaa1111~s1', 'other-panel'), false)
})

test('MS-6: shouldStampBridgeForSession falls back to the top-level verdict', async () => {
  const mod = await load()
  const { shouldStampBridgeForSession } = mod
  const view = multiServerView(mod)

  // A session whose server never answered the dict (or a pre-MS-6 body
  // without a dict at all, or no session id at all): the TOP-LEVEL list
  // decides, exactly like the old 2-argument call did.
  assert.equal(shouldStampBridgeForSession(view, 'zr~cccc3333~x', 'dsh-better-sidebar'), true)
  assert.equal(shouldStampBridgeForSession(view, undefined, 'dsh-better-sidebar'), true)
  assert.equal(shouldStampBridgeForSession(view, 'session-local', 'dsh-better-sidebar'), true)

  // No view, no stamp.
  assert.equal(shouldStampBridgeForSession(undefined, 'zr~aaaa1111~s1', 'dsh-better-sidebar'), false)

  // The legacy body shape (no servers field) keeps working without a throw.
  const { parseRemoteStatusBody } = mod
  const legacy = parseRemoteStatusBody({ state: 'online', bridgedPlugins: ['dsh-better-sidebar'] }, 1)
  assert.equal(shouldStampBridgeForSession(legacy, 'zr~aaaa1111~s1', 'dsh-better-sidebar'), true)
})

test('MS-6: switching remote A to remote B re-judges the stamp without a new poll', async (t) => {
  const attrs = new Map()
  const root = {
    setAttribute: (name, value) => { attrs.set(name, value) },
    getAttribute: (name) => attrs.get(name) ?? null,
    removeAttribute: (name) => { attrs.delete(name) },
    style: { setProperty() {}, removeProperty() {} },
  }
  const realFetch = globalThis.fetch
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
  const { BRIDGE_STAMP_ATTRIBUTE, getRemoteStatusStore } = await import('../src/client-data/remote-status.ts')
  installRemoteSessionGuard(ctx)
  const dispose = effects.get('dsh-zen-remote: bridge stamp')()
  t.after(() => {
    dispose()
    globalThis.fetch = realFetch
    delete globalThis.document
  })

  await getRemoteStatusStore().refresh()
  assert.equal(attrs.get(BRIDGE_STAMP_ATTRIBUTE), '1', 'A bridges the plugin')

  uiSession.current.value = { key: SESSION_B }
  for (const listener of currentListeners) listener()
  assert.equal(attrs.has(BRIDGE_STAMP_ATTRIBUTE), false, 'B does not bridge it, so the stamp comes off at once')

  uiSession.current.value = { key: SESSION_A }
  for (const listener of currentListeners) listener()
  assert.equal(attrs.get(BRIDGE_STAMP_ATTRIBUTE), '1', 'back on A, the stamp returns')
})

test('MS-6: the 2-argument shouldStampBridgeAttribute stays untouched', async () => {
  const { shouldStampBridgeAttribute } = await load()
  assert.equal(shouldStampBridgeAttribute(['dsh-better-sidebar'], 'dsh-better-sidebar'), true)
  assert.equal(shouldStampBridgeAttribute([], 'dsh-better-sidebar'), false)
  assert.equal(shouldStampBridgeAttribute(undefined, 'dsh-better-sidebar'), false)
})
