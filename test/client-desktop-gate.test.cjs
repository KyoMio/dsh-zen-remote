'use strict'
/* dsh-zen-remote · T15 desktop-gate tests
 *
 * The settings page (plugin-row config block) must register on BOTH sides of
 * apply's desktop gate — the desktop app IS the main server — while the phone
 * shell stays behind the gate. Driving the real `apply` from Node is not
 * possible: src/client/index.tsx is JSX, and Node's type stripping rejects
 * .tsx. Per the task's sanctioned fallback, the pre-gate work lives in
 * register-settings.ts (JSX-free, component passed in) and these tests drive
 * it with a recording fake ctx + a fake globalThis.dshDesktop.
 *
 * Honest limits of this harness (T15-fix #11): `registerSettingsPage` is
 * deliberately gate-INDEPENDENT — it never reads `dshDesktop`, because the
 * whole point is that it runs on both sides — so no test here can
 * behaviorally distinguish desktop from web, and the guarantee "the desktop
 * does not register the phone-shell slots" rests entirely on the source-order
 * assertion in the last test below (registerSettingsPage is called before
 * `isDesktopShell()` returns). A behavioral test would need a JSX-capable
 * loader to drive the real apply.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')

/** A recording fake ctx: every cordis seam register-settings touches. */
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
  }
  return { ctx, calls }
}

/** Invoke only the named effect producer (the styles effect touches `document`, so effects stay un-invoked by default). */
function runEffect(calls, label) {
  const entry = calls.effects.find((candidate) => candidate.label === label)
  assert.notEqual(entry, undefined, `effect ${label} was registered`)
  entry.producer()
}

/** Drive the recorded ['configForms'] inject callback with a fake forms ctx. */
function driveConfigForms(ctx) {
  const entry = ctx.calls.injects.find((call) => call.services.includes('configForms'))
  assert.notEqual(entry, undefined, 'the settings registration waits for the configForms service')
  const formsCalls = { effects: [], whileServed: [], slotsInjected: [], slotsRegistered: [] }
  const formsScope = {
    getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  entry.callback({
    effect(producer, label) {
      // Recorded, not invoked: the dispose effect's producer hands back a
      // disposer and the whileServed effect pulls the registration chain —
      // the test drives the whileServed one explicitly below.
      formsCalls.effects.push({ label, producer })
      return () => {}
    },
    configForms: {
      get: () => formsScope,
      // The device token's configured flag reads the describe view's secrets
      // sidecar (T16); the fake carries the empty sidecar.
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
  // Drive the whileServed effect the way cordis would (the dispose effect is
  // only invoked at fiber teardown; its presence is asserted instead).
  const served = formsCalls.effects.find((candidate) => candidate.label === 'dsh-zen-remote: row config page')
  assert.notEqual(served, undefined, 'the row config page registers through whileServed')
  served.producer()
  const dispose = formsCalls.effects.find((candidate) => candidate.label === 'dsh-zen-remote: settings form')
  assert.notEqual(dispose, undefined, 'the controller is released through its own effect')
  assert.equal(typeof dispose.producer(), 'function', 'the dispose effect producer returns a disposer')
  return formsCalls
}

const stubSection = () => null

test('desktop shell: the settings page still registers (locale + row config block)', async () => {
  globalThis.dshDesktop = {}
  try {
    const { registerSettingsPage } = await import('../src/client/settings/register-settings.ts')
    const { ctx, calls } = fakeCtx()
    registerSettingsPage(ctx, stubSection)

    // Dictionaries registered before anything else reads them.
    runEffect(calls, 'dsh-mobile-nav: dictionaries')
    assert.equal(calls.localeRegisters.length, 1)
    assert.equal(calls.localeRegisters[0].ns, 'mobileNav')

    const formsCalls = driveConfigForms(ctx)
    assert.deepEqual(formsCalls.whileServed[0].namespaces, ['dsh-zen-remote'])
    assert.equal(formsCalls.slotsInjected[0].name, 'plugins.row.config')
    const registration = formsCalls.slotsRegistered[0]
    assert.notEqual(registration, undefined, 'the row config block registers on the desktop shell')
    assert.equal(registration.options.name, 'plugins.row.config')
    assert.equal(registration.options.key, 'dsh-zen-remote#dsh-zen-remote')
    assert.equal(registration.options.locale, 'mobileNav')
    // The injected share hands the component the staged form controller.
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
  // Without driving the inject callback, no slot registration happened — the
  // whole block hangs off the lazy inject, so a composition without
  // configForms loads the plugin and simply never registers the page.
  assert.deepEqual(calls.slotsRegistered, [])
  assert.deepEqual(
    calls.injects.map((call) => call.services),
    [['configForms']],
    'exactly one lazy inject, for configForms only',
  )
})

test('apply order guard: registerSettingsPage runs before the desktop gate returns', () => {
  // No runtime seam exists for the gate ordering under Node (apply is .tsx);
  // this pins the two constraints textually until a harness can drive apply.
  const source = readFileSync(join(ROOT, 'src', 'client', 'index.tsx'), 'utf8')
  const registerAt = source.indexOf('registerSettingsPage(ctx, SettingsSection)')
  const gateAt = source.indexOf('if (isDesktopShell()) return')
  assert.ok(registerAt !== -1, 'apply registers the settings page')
  assert.ok(gateAt !== -1, 'the desktop gate is still present')
  assert.ok(registerAt < gateAt, 'the settings page registers BEFORE the desktop gate')
  // The top-level inject array must not name configForms (acceptance 3).
  const injectMatch = source.match(/export const inject = \[([^\]]*)\]/)
  assert.notEqual(injectMatch, null)
  assert.equal(injectMatch[1].includes('configForms'), false, 'configForms stays out of the required services')
})

test('T16-fix2: an admin/status 200 whose body is not ok:true is a failed load', () => {
  // Same Node limitation as the guard above: loadStatus is React-internal, so
  // the contract is pinned textually. The throw must sit where a non-ok body
  // lands in the catch — which keeps the last ready data (T15-fix 1) instead
  // of letting a broken 200 overwrite it.
  const source = readFileSync(join(ROOT, 'src', 'client', 'settings', 'SettingsSection.tsx'), 'utf8')
  const thenAt = source.indexOf('.then((body) => {', source.indexOf('loadStatus'))
  assert.notEqual(thenAt, -1, 'loadStatus has a body handler')
  const handler = source.slice(thenAt, source.indexOf('.catch', thenAt))
  assert.ok(handler.includes('body?.ok !== true'), 'a 200 body without ok:true must throw into the catch (stale data kept)')
})
