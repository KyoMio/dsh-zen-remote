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
