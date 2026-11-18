'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')

function fakeCtx() {
  const calls = { effects: [], injects: [], localeRegisters: [], slotsInjected: [], slotsRegistered: [], whileServed: [] }
  const ctx = {
    calls,
    effect(producer, label) {
      calls.effects.push({ label, producer })
      return () => {}
    },
    inject(services, callback) {
      calls.injects.push({ services, callback })
    },
    locale: {
      register(ns, dicts) {
        calls.localeRegisters.push({ ns, dicts })
        return () => {}
      },
    },
    slots: {
      inject(name, factory) {
        calls.slotsInjected.push({ name })
        factory()
        return () => {}
      },
      register(options, component) {
        calls.slotsRegistered.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, calls }
}

function runEffect(calls, label) {
  const entry = calls.effects.find((candidate) => candidate.label === label)
  assert.notEqual(entry, undefined, `effect ${label} was registered`)
  entry.producer()
}

function driveConfigForms(ctx) {
  const entry = ctx.calls.injects.find((call) => call.services.includes('configForms'))
  assert.notEqual(entry, undefined)
  const formsCalls = { effects: [], whileServed: [], slotsInjected: [], slotsRegistered: [] }
  const formsScope = {
    getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  entry.callback({
    effect(producer, label) {
      formsCalls.effects.push({ label, producer })
      return () => {}
    },
    configForms: {
      get: () => formsScope,
      describe: () => ({
        getSnapshot: () => ({ view: { namespaces: [{ ns: 'dsh-zen-remote', secrets: [] }] } }),
        subscribe: () => () => {},
      }),
      whileServed(namespaces, register) {
        formsCalls.whileServed.push({ namespaces })
        return register(new Set(namespaces))
      },
    },
    slots: {
      inject(name, factory) {
        formsCalls.slotsInjected.push({ name })
        factory()
        return () => {}
      },
      register(options, component) {
        formsCalls.slotsRegistered.push({ options, component })
        return () => {}
      },
    },
  })
  const served = formsCalls.effects.find((candidate) => candidate.label === 'dsh-zen-remote: row config page')
  assert.notEqual(served, undefined)
  served.producer()
  const dispose = formsCalls.effects.find((candidate) => candidate.label === 'dsh-zen-remote: settings form')
  assert.notEqual(dispose, undefined)
  assert.equal(typeof dispose.producer(), 'function')
  return formsCalls
}

const stubSection = () => null

test('desktop shell: the settings page still registers (locale + row config block)', async () => {
  globalThis.dshDesktop = {}
  try {
    const { registerSettingsPage } = await import('../src/client/settings/register-settings.ts')
    const { ctx, calls } = fakeCtx()
    registerSettingsPage(ctx, stubSection)

    runEffect(calls, 'dsh-mobile-nav: dictionaries')
    assert.equal(calls.localeRegisters.length, 1)
    assert.equal(calls.localeRegisters[0].ns, 'mobileNav')

    const formsCalls = driveConfigForms(ctx)
    assert.deepEqual(formsCalls.whileServed[0].namespaces, ['dsh-zen-remote'])
    assert.equal(formsCalls.slotsInjected[0].name, 'plugins.row.config')
    const registration = formsCalls.slotsRegistered[0]
    assert.notEqual(registration, undefined)
    assert.equal(registration.options.name, 'plugins.row.config')
    assert.equal(registration.options.key, 'dsh-zen-remote#dsh-zen-remote')
    assert.equal(registration.options.locale, 'mobileNav')
    const share = registration.options.inject()
    assert.equal(typeof share.config.stage, 'function')
    assert.equal(typeof share.config.canSave, 'function')
    assert.equal(typeof share.config.save, 'function')
  } finally {
    delete globalThis.dshDesktop
  }
})

test('plain web: the settings page registers the same way', async () => {
  assert.ok(!('dshDesktop' in globalThis))
  const { registerSettingsPage } = await import('../src/client/settings/register-settings.ts')
  const { ctx, calls } = fakeCtx()
  registerSettingsPage(ctx, stubSection)
  runEffect(calls, 'dsh-mobile-nav: dictionaries')
  assert.equal(calls.localeRegisters.length, 1)
  const formsCalls = driveConfigForms(ctx)
  assert.equal(formsCalls.slotsRegistered.length, 1)
  assert.equal(formsCalls.slotsRegistered[0].options.key, 'dsh-zen-remote#dsh-zen-remote')
})

test('configForms is lazy: nothing outside the ctx.inject callback touches it', async () => {
  const { registerSettingsPage } = await import('../src/client/settings/register-settings.ts')
  const { ctx, calls } = fakeCtx()
  registerSettingsPage(ctx, stubSection)
  assert.deepEqual(calls.slotsRegistered, [])
  assert.deepEqual(calls.injects.map((call) => call.services), [['configForms']])
})

test('apply order guard: registerSettingsPage, registerRemoteShareUi, registerRemoteStatusUi, and installRemoteSessionGuard run before the desktop gate', () => {
  const source = readFileSync(join(ROOT, 'src', 'client', 'index.tsx'), 'utf8')
  const gateAt = source.indexOf('if (isDesktopShell()) return')
  assert.ok(gateAt !== -1)
  for (const call of [
    'registerSettingsPage(ctx, SettingsSection)',
    'registerRemoteShareUi(ctx, RemoteHeaderIcon, RemoteShareMenuItem)',
    'registerRemoteStatusUi(ctx, RemoteStatusIcon, RemoteComposerBanner)',
    'installRemoteSessionGuard(ctx)',
    'mountLegacyGatewayUpgradePrompt(ctx)',
  ]) {
    const at = source.indexOf(call)
    assert.ok(at !== -1 && at < gateAt, `${call} must run before the desktop gate`)
  }
  const injectMatch = source.match(/export const inject = \[([^\]]*)\]/)
  assert.notEqual(injectMatch, null)
  assert.equal(injectMatch[1].includes('configForms'), false)
})

test('T33b: desktop shell — the remote icon and menu item still register (both slots + styles)', async () => {
  globalThis.dshDesktop = {}
  try {
    const { registerRemoteShareUi } = await import('../src/client/remote-share-register.ts')
    const { ctx, calls } = fakeCtx()
    registerRemoteShareUi(ctx, () => null, () => null)
    assert.notEqual(calls.effects.find((c) => c.label === 'dsh-zen-remote: remote-share styles'), undefined)
    const names = calls.slotsInjected.map((call) => call.name)
    assert.ok(names.includes('conversation.session.header.actions'))
    assert.ok(names.includes('sidebar.workspaces.session.menu.item'))
    const byName = new Map(calls.slotsRegistered.map((entry) => [entry.options.name, entry]))
    const header = byName.get('conversation.session.header.actions')
    const menu = byName.get('sidebar.workspaces.session.menu.item')
    assert.notEqual(header, undefined)
    assert.equal(header.options.id, 'remote-share-icon')
    assert.equal(header.options.order, 25)
    assert.equal(header.options.locale, 'mobileNav')
    assert.notEqual(menu, undefined)
    assert.equal(menu.options.id, 'remote-share')
    assert.equal(menu.options.order, 500)
    assert.equal(menu.options.locale, 'mobileNav')
    assert.equal(typeof menu.component, 'function')
    const injects = calls.injects.map((call) => call.services)
    assert.ok(injects.some((services) => services.includes('configForms')))
    const { getSharesStore } = await import('../src/client-data/shares.ts')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(getSharesStore().getSnapshot().role, 'unknown')
  } finally {
    delete globalThis.dshDesktop
  }
})

test('T33b-fix2: wireSharesRole — the row role wins, the probe fills the gap, updates re-decide', async () => {
  const { wireSharesRole } = await import('../src/client/remote-share-register.ts')
  const { createSharesStore } = await import('../src/client-data/shares.ts')
  const store = createSharesStore(async () => { throw new Error('the wiring test never polls') })

  const probeCalls = []
  const probeWaiters = []
  const probeReplies = []
  const probe = (refetch = false) => {
    probeCalls.push(refetch)
    if (probeReplies.length > 0) return Promise.resolve(probeReplies.shift())
    return new Promise((resolve) => { probeWaiters.push(resolve) })
  }
  const answerProbe = (value) => {
    const waiter = probeWaiters.shift()
    if (waiter !== undefined) waiter(value)
    else probeReplies.push(value)
  }

  const snap = { status: 'loading', value: {}, user: {} }
  const listeners = new Set()
  const scope = {
    getSnapshot: () => snap,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const notify = () => { for (const listener of [...listeners]) listener() }
  const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)) }
  const off = wireSharesRole(scope, store, { probe })

  assert.equal(store.getSnapshot().role, 'unknown')
  assert.deepEqual(probeCalls, [])

  snap.status = 'ready'
  snap.value = { role: 'client' }
  notify()
  assert.equal(store.getSnapshot().role, 'client')
  assert.deepEqual(probeCalls, [])

  snap.value = {}
  notify()
  assert.deepEqual(probeCalls, [false])
  assert.equal(store.getSnapshot().role, 'client')

  answerProbe('host')
  await settle()
  assert.equal(store.getSnapshot().role, 'host')
  assert.deepEqual(probeCalls, [false])

  snap.value = { role: 'client' }
  notify()
  assert.equal(store.getSnapshot().role, 'client')
  assert.deepEqual(probeCalls, [false])

  snap.status = 'unavailable'
  snap.value = {}
  notify()
  assert.deepEqual(probeCalls, [false, true])
  answerProbe('client')
  await settle()
  assert.equal(store.getSnapshot().role, 'client')

  notify()
  assert.deepEqual(probeCalls, [false, true, false])
  answerProbe(undefined)
  await settle()
  assert.equal(store.getSnapshot().role, 'client')
  notify()
  assert.deepEqual(probeCalls, [false, true, false, false])
  answerProbe(undefined)
  off()
})

test('T34: desktop shell — the status icon and composer banner register and render gates stay intact', async () => {
  globalThis.dshDesktop = {}
  try {
    const { registerRemoteStatusUi } = await import('../src/client/remote-status-register.ts')
    const iconComponent = () => null
    const bannerComponent = () => null
    const { ctx, calls } = fakeCtx()
    registerRemoteStatusUi(ctx, iconComponent, bannerComponent)
    assert.notEqual(calls.effects.find((c) => c.label === 'dsh-zen-remote: remote-status styles'), undefined)
    const byName = new Map(calls.slotsRegistered.map((entry) => [entry.options.name, entry]))
    const icon = byName.get('conversation.session.header.actions')
    const banner = byName.get('conversation.input.dock')
    assert.notEqual(icon, undefined)
    assert.equal(icon.options.id, 'remote-status-icon')
    assert.equal(icon.options.order, 26)
    assert.equal(icon.options.locale, 'mobileNav')
    assert.equal(icon.component, iconComponent)
    assert.notEqual(banner, undefined)
    assert.equal(banner.options.id, 'remote-status-banner')
    assert.equal(banner.options.order, 15)
    const share = icon.options.inject()
    assert.equal(typeof share.status.subscribe, 'function')
    assert.equal(typeof share.status.getSnapshot, 'function')
    const bannerShare = banner.options.inject('zr~abcd1234~session-a')
    assert.equal(typeof bannerShare.setComposerBlock, 'function')
    bannerShare.setComposerBlock('reason')
    bannerShare.setComposerBlock(undefined)
  } finally {
    delete globalThis.dshDesktop
  }

  for (const [file, marker] of [
    ['RemoteStatusIcon.tsx', 'isVirtual(sessionId)'],
    ['RemoteComposerBanner.tsx', 'isVirtual(sessionId)'],
  ]) {
    const source = readFileSync(join(ROOT, 'src', 'client', file), 'utf8')
    assert.ok(source.includes(marker))
    assert.ok(source.includes('subscribeIfVirtual(status, sessionId'))
    assert.ok(source.includes('return null'))
  }
  const banner = readFileSync(join(ROOT, 'src', 'client', 'RemoteComposerBanner.tsx'), 'utf8')
  assert.ok(banner.includes('setComposerBlock(text)'))
  assert.ok(banner.includes('setComposerBlock(undefined)'))
  const css = readFileSync(join(ROOT, 'src', 'client', 'remote-status-css.ts'), 'utf8')
  assert.ok(!css.includes('data-zr-remote-readonly'))
  assert.ok(!css.includes('width: 100%'))
})

test('T53 & CP5: better-sidebar rules stay out of compat.css.ts; RemoteHeaderIcon uses subscribeIfNotPhoneShell', () => {
  const compatCss = readFileSync(join(ROOT, 'src', 'client', 'styles', 'compat.css.ts'), 'utf8')
  for (const marker of ['data-dsh-native-tab-host', 'data-dsh-bottom-toggle', 'data-dockkit-tab', 'data-floating-window']) {
    assert.ok(!compatCss.includes(marker), `compat.css.ts must not carry ${marker} (it sits behind the desktop gate)`)
  }
  const headerIcon = readFileSync(join(ROOT, 'src', 'client', 'RemoteHeaderIcon.tsx'), 'utf8')
  assert.ok(headerIcon.includes('subscribeIfNotPhoneShell(shares, phoneShell'))
})

test('T7 mountLegacyGatewayUpgradePrompt: host/via-gateway silent, 0.2.0+ silent, 0.1.0 mounts modal and cleans up on dismiss', async (t) => {
  const { mountLegacyGatewayUpgradePrompt } = await import('../src/client/effects/legacy-gateway-prompt.ts')
  const { ctx, calls } = fakeCtx()

  const appended = []
  const createdButtons = []
  const fakeDoc = {
    head: { appendChild: (el) => { appended.push(el); el.removed = false; el.remove = () => { el.removed = true } } },
    body: { appendChild: (el) => { appended.push(el); el.removed = false; el.remove = () => { el.removed = true } } },
    createElement: (tag) => {
      const listeners = {}
      const attrs = new Map()
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        dataset: {},
        style: {},
        textContent: '',
        innerHTML: '',
        open: false,
        children: [],
        appendChild: (child) => { el.children.push(child) },
        setAttribute: (k, v) => attrs.set(k, v),
        getAttribute: (k) => attrs.get(k) ?? null,
        addEventListener: (ev, fn) => { (listeners[ev] ??= []).push(fn) },
        dispatchEvent: (ev) => { for (const fn of listeners[ev.type] ?? []) fn(ev) },
        querySelector: () => null,
        showModal: () => { el.open = true },
        close: () => { el.open = false; for (const fn of listeners['close'] ?? []) fn() },
        remove: () => { el.removed = true },
      }
      if (tag === 'button') createdButtons.push(el)
      return el
    },
  }
  const sessionMem = new Map()
  const localMem = new Map()
  const fakeSession = { getItem: (k) => sessionMem.get(k) ?? null, setItem: (k, v) => sessionMem.set(k, v) }
  const fakeLocal = { getItem: (k) => localMem.get(k) ?? null, setItem: (k, v) => localMem.set(k, v) }

  // 1. host role makes zero fetch calls and mounts zero DOM
  let fetchCount = 0
  mountLegacyGatewayUpgradePrompt(ctx, {
    probeRole: async () => 'host',
    fetchImpl: async () => { fetchCount += 1; throw new Error('must not fetch') },
    doc: fakeDoc,
    sessionStore: fakeSession,
    localStore: fakeLocal,
    isViaGateway: () => false,
  })
  const hostEffect = calls.effects.at(-1)
  const disposeHost = hostEffect.producer()
  await new Promise((r) => setImmediate(r))
  assert.equal(fetchCount, 0)
  assert.equal(appended.length, 0)
  disposeHost?.()

  // 2. peer + 0.2.0 gateway mounts zero modal DOM
  const calls2 = fakeCtx()
  mountLegacyGatewayUpgradePrompt(calls2.ctx, {
    probeRole: async () => 'peer',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        configured: true,
        nodeId: 'abcd1234',
        gatewayState: 'authorized',
        peers: [],
        versionSync: {
          pluginVersion: '2.5.1',
          gatewayVersion: '0.2.0',
          recommendedGatewayVersion: '0.3.0',
          wireCompatLevel: 1,
          gatewayOutdated: true,
          pluginOutdated: false,
          newerPluginVersion: null,
          inferredLegacyGateway: false,
          gatewayConsoleUrl: 'https://gw.example.com:19393',
        },
      }),
    }),
    doc: fakeDoc,
    sessionStore: fakeSession,
    localStore: fakeLocal,
    isViaGateway: () => false,
  })
  const disposeModern = calls2.ctx.calls.effects.at(-1).producer()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.equal(appended.length, 0)
  disposeModern?.()

  // 3. peer + 0.1.0 legacy gateway mounts <dialog data-zen-remote="legacy-gateway-modal"> + style
  const calls3 = fakeCtx()
  mountLegacyGatewayUpgradePrompt(calls3.ctx, {
    probeRole: async () => 'peer',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        configured: true,
        nodeId: 'abcd1234',
        gatewayState: 'authorized',
        peers: [],
        versionSync: {
          pluginVersion: '2.5.1',
          gatewayVersion: '0.1.0',
          recommendedGatewayVersion: '0.2.0',
          wireCompatLevel: 1,
          gatewayOutdated: true,
          pluginOutdated: false,
          newerPluginVersion: null,
          inferredLegacyGateway: true,
          gatewayConsoleUrl: 'https://gw.example.com:19393',
        },
      }),
    }),
    doc: fakeDoc,
    sessionStore: fakeSession,
    localStore: fakeLocal,
    isViaGateway: () => false,
  })
  const disposeLegacy = calls3.ctx.calls.effects.at(-1).producer()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  const dialog = appended.find((el) => el.tagName === 'DIALOG')
  const style = appended.find((el) => el.tagName === 'STYLE')
  assert.notEqual(dialog, undefined)
  assert.notEqual(style, undefined)
  assert.equal(dialog.dataset.zenRemote, 'legacy-gateway-modal')
  // Fix 2A: primary style sits on copy button (index 0), NOT on never-show button
  assert.equal(createdButtons.length, 3)
  assert.equal(createdButtons[0].className, 'zr-lgw-primary')
  assert.equal(createdButtons[1].className, '')
  assert.equal(createdButtons[2].className, '')
  disposeLegacy?.()
  assert.equal(dialog.removed, true)
  assert.equal(style.removed, true)

  // Fix 2B: default isViaGateway detects documentElement[data-lan-device] and skips fetch
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: { hasAttribute: (name) => name === 'data-lan-device' },
    },
  })
  t.after(() => {
    if (prevDoc === undefined) delete globalThis.document
    else Object.defineProperty(globalThis, 'document', prevDoc)
  })
  let viaFetchCount = 0
  const callsVia = fakeCtx()
  mountLegacyGatewayUpgradePrompt(callsVia.ctx, {
    probeRole: async () => 'peer',
    fetchImpl: async () => { viaFetchCount += 1; throw new Error('must not fetch on via-gateway') },
    doc: fakeDoc,
    sessionStore: fakeSession,
    localStore: fakeLocal,
  })
  const disposeVia = callsVia.ctx.calls.effects.at(-1).producer()
  await new Promise((r) => setImmediate(r))
  assert.equal(viaFetchCount, 0)
  disposeVia?.()
})
