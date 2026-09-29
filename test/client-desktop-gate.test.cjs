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
    // The T33b remote-share registration records through the same calls
    // object; register-settings never touches slots at the top level, so
    // the existing deepEqual([]) assertions below stay valid.
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

// --- T33b: session-sharing parts on the desktop shell -------------------------

test('T33b: desktop shell — the remote icon and menu item still register (both slots + styles)', async () => {
  globalThis.dshDesktop = {}
  try {
    const { registerRemoteShareUi } = await import('../src/client/remote-share-register.ts')
    const { ctx, calls } = fakeCtx()
    registerRemoteShareUi(ctx, () => null, () => null)
    // The styles effect touches `document`, so like every effect here it is
    // asserted present, not invoked.
    assert.notEqual(
      calls.effects.find((candidate) => candidate.label === 'dsh-zen-remote: remote-share styles'),
      undefined,
      'the remote-share stylesheet effect is registered',
    )
    const names = calls.slotsInjected.map((call) => call.name)
    assert.ok(names.includes('conversation.session.header.actions'), 'the title-row icon slot is injected')
    assert.ok(names.includes('sidebar.workspaces.session.menu.item'), 'the session-menu slot is injected')
    const byName = new Map(calls.slotsRegistered.map((entry) => [entry.options.name, entry]))
    const header = byName.get('conversation.session.header.actions')
    const menu = byName.get('sidebar.workspaces.session.menu.item')
    assert.notEqual(header, undefined, 'the title-row icon registers on the desktop shell')
    assert.equal(header.options.id, 'remote-share-icon')
    // Order 25: past the official jobs entry (20), so the two never tie.
    assert.equal(header.options.order, 25)
    assert.equal(header.options.locale, 'mobileNav')
    assert.notEqual(menu, undefined, 'the menu item registers on the desktop shell')
    assert.equal(menu.options.id, 'remote-share')
    assert.equal(menu.options.order, 500)
    assert.equal(menu.options.locale, 'mobileNav')
    assert.equal(typeof menu.component, 'function')
    // The role wiring rides a lazy configForms inject (T33b-fix), and the
    // no-configForms fallback probe runs on its own. Under Node the probe's
    // relative fetch fails fast, and T33b-fix2 semantics apply: a FAILED
    // probe wires NOTHING — the role stays unknown (the parts stay dark)
    // instead of guessing host.
    const injects = calls.injects.map((call) => call.services)
    assert.ok(injects.some((services) => services.includes('configForms')), 'the role wiring waits for configForms')
    const { getSharesStore } = await import('../src/client-data/shares.ts')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(getSharesStore().getSnapshot().role, 'unknown', 'a failed fallback probe wires nothing, never a guessed host')
  } finally {
    delete globalThis.dshDesktop
  }
})

test('T33b: apply order guard — the remote-share registration runs before the desktop gate', () => {
  // Same textual pin as the settings-page guard above: registerRemoteShareUi
  // is gate-independent by design, so desktop coverage rests on the call
  // sitting before `if (isDesktopShell()) return` in apply.
  const source = readFileSync(join(ROOT, 'src', 'client', 'index.tsx'), 'utf8')
  const registerAt = source.indexOf('registerRemoteShareUi(ctx, RemoteHeaderIcon, RemoteShareMenuItem)')
  const gateAt = source.indexOf('if (isDesktopShell()) return')
  assert.ok(registerAt !== -1, 'apply registers the remote-share parts')
  assert.ok(registerAt < gateAt, 'the remote-share parts register BEFORE the desktop gate')
})

test('T33b-fix2: role wiring — the row role wins, the probe fills the gap, updates re-decide', async () => {
  // wireSharesRole is Node-drivable by design: a fresh store, a fake scope
  // with a mutable snapshot, and an INJECTED probe double — no dependence
  // on the module-level client-config cache any earlier test might have
  // filled (T33b-fix2).
  const { wireSharesRole } = await import('../src/client/remote-share-register.ts')
  const { createSharesStore } = await import('../src/client-data/shares.ts')
  const store = createSharesStore(async () => { throw new Error('the wiring test never polls') })

  // The probe double: records every call's refetch flag. A queued answer
  // resolves immediately; without one the probe stays PENDING until
  // answerProbe() feeds it — 'host' / 'client' are definite, undefined is
  // a FAILED probe.
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

  // Loading: nothing is knowable — the store stays untouched (nothing
  // polls, the parts render nothing), the settings page's wait-out rule.
  assert.equal(store.getSnapshot().role, 'unknown')
  assert.deepEqual(probeCalls, [], 'loading never probes')

  // A row-carried role decides the moment the mirror settles — and beats
  // any probe (none even runs while the row answers).
  snap.status = 'ready'
  snap.value = { role: 'client' }
  notify()
  assert.equal(store.getSnapshot().role, 'client')
  assert.deepEqual(probeCalls, [])

  // The row going silent hands the decision to the probe: one call, and
  // while it is PENDING the last definite verdict stands (still client —
  // the parts keep rendering, no flicker to unknown).
  snap.value = {}
  notify()
  assert.deepEqual(probeCalls, [false], 'the row-silent snapshot probes once, unforced')
  assert.equal(store.getSnapshot().role, 'client', 'still client while the probe is pending')

  // The probe answers host: the role recovers — and the completion path
  // must NOT have probed again (no re-entry loop).
  answerProbe('host')
  await settle()
  assert.equal(store.getSnapshot().role, 'host', 'the probe answer recovered the role')
  assert.deepEqual(probeCalls, [false], 'the probe completion re-evaluated without probing again')

  // A row role arriving later still wins over the cached probe answer.
  snap.value = { role: 'client' }
  notify()
  assert.equal(store.getSnapshot().role, 'client')
  assert.deepEqual(probeCalls, [false], 'a row-silent -> row-carried flip needs no probe')

  // Scope STATUS changed (mirror resync): the old probe answer is dropped
  // and the probe runs FORCED. It answers client this time.
  snap.status = 'unavailable'
  snap.value = {}
  notify()
  assert.deepEqual(probeCalls, [false, true], 'the status change re-probes, forced')
  answerProbe('client')
  await settle()
  assert.equal(store.getSnapshot().role, 'client', 'the forced re-probe re-decided')

  // A FAILED probe (undefined) is not remembered: the verdict stays put —
  // the role keeps its last definite value, never a guessed host — and the
  // NEXT snapshot update probes again.
  notify()
  assert.deepEqual(probeCalls, [false, true, false], 'the next update probes again')
  answerProbe(undefined)
  await settle()
  assert.equal(store.getSnapshot().role, 'client', 'a failed probe left the role alone')
  notify()
  assert.deepEqual(probeCalls, [false, true, false, false], 'failures are not cached — every update re-probes')
  answerProbe(undefined)
  off()
})

test('T33b-fix: client role hides, host role shows, a 404 round fails alone', async () => {
  const { createSharesStore, describeShare } = await import('../src/client-data/shares.ts')
  const replies = [
    { ok: true, status: 404, json: async () => ({ ok: false }) },
    { ok: true, status: 200, json: async () => ({ ok: true, shares: [{ sessionId: 's1', busy: false, remainingMs: null, viewers: 0, title: 'One' }] }) },
  ]
  let calls = 0
  const store = createSharesStore(async () => { calls += 1; return replies[Math.min(calls - 1, replies.length - 1)] })

  // Client role: hidden, and NOTHING polls — a client deployment must never
  // see a wasted admin/* request.
  store.setRole('client')
  const seen = []
  const off = store.subscribe(() => { seen.push('x') })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.getSnapshot().role, 'client')
  assert.equal(calls, 0, 'a client deployment never asks for admin/shares')
  assert.equal(describeShare(undefined, Date.now()).state, 'off', 'no entry reads off')

  // Host role: the poll starts with an immediate pull — but the reload
  // window answers 404, which fails exactly that one round.
  store.setRole('host')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(store.getSnapshot().ready, false, 'the 404 round cached nothing')

  // The next round lands: the parts show. Nothing stayed latched anywhere.
  await store.refresh()
  assert.equal(store.getSnapshot().ready, true)
  assert.deepEqual(store.getSnapshot().entries.map((entry) => entry.sessionId), ['s1'])

  // Render-level: the .tsx parts cannot load under Node, so their
  // render-empty rule is pinned textually — each gates its JSX behind the
  // wired role (and the menu item additionally behind the first unanswered
  // GET and subagent rows).
  for (const file of ['RemoteHeaderIcon.tsx', 'RemoteShareMenu.tsx']) {
    const source = readFileSync(join(ROOT, 'src', 'client', file), 'utf8')
    assert.ok(source.includes("snap.role !== 'host'"), `${file} renders empty off the wired role`)
  }
  off()
})

// --- T34: the sub-client remote-status parts -----------------------------------

test('T34: desktop shell — the status icon and composer banner still register (both slots + styles)', async () => {
  globalThis.dshDesktop = {}
  try {
    const { registerRemoteStatusUi } = await import('../src/client/remote-status-register.ts')
    const iconComponent = () => null
    const bannerComponent = () => null
    const { ctx, calls } = fakeCtx()
    registerRemoteStatusUi(ctx, iconComponent, bannerComponent)
    assert.notEqual(
      calls.effects.find((candidate) => candidate.label === 'dsh-zen-remote: remote-status styles'),
      undefined,
      'the remote-status stylesheet effect is registered',
    )
    const byName = new Map(calls.slotsRegistered.map((entry) => [entry.options.name, entry]))
    const icon = byName.get('conversation.session.header.actions')
    const banner = byName.get('conversation.input.dock')
    assert.notEqual(icon, undefined, 'the status icon registers on the desktop shell')
    assert.equal(icon.options.id, 'remote-status-icon')
    // Order 26: past the T33b share icon (25), so the two never tie.
    assert.equal(icon.options.order, 26)
    assert.equal(icon.options.locale, 'mobileNav')
    assert.equal(icon.component, iconComponent)
    assert.notEqual(banner, undefined, 'the composer banner registers on the desktop shell')
    assert.equal(banner.options.id, 'remote-status-banner')
    assert.equal(banner.options.order, 15)
    // The inject face hands both parts the page-wide store singleton, and
    // the banner a per-session composer-block binding (T34-fix: the disable
    // rides the host's ctx.conversation.blocks contract).
    const share = icon.options.inject()
    assert.equal(typeof share.status.subscribe, 'function')
    assert.equal(typeof share.status.getSnapshot, 'function')
    const bannerShare = banner.options.inject('zr~abcd1234~session-a')
    assert.equal(typeof bannerShare.setComposerBlock, 'function')
    // A composition whose conversation service is absent degrades to a no-op
    // binding (the fake ctx has no `get`), not a crash.
    bannerShare.setComposerBlock('reason')
    bannerShare.setComposerBlock(undefined)
  } finally {
    delete globalThis.dshDesktop
  }
})

test('T34: apply order guard — the remote-status registration runs before the desktop gate', () => {
  const source = readFileSync(join(ROOT, 'src', 'client', 'index.tsx'), 'utf8')
  const registerAt = source.indexOf('registerRemoteStatusUi(ctx, RemoteStatusIcon, RemoteComposerBanner)')
  const gateAt = source.indexOf('if (isDesktopShell()) return')
  assert.ok(registerAt !== -1, 'apply registers the remote-status parts')
  assert.ok(registerAt < gateAt, 'the remote-status parts register BEFORE the desktop gate')
})

test('T34: the parts render only for virtual-id sessions (textual pins — .tsx cannot load under Node)', () => {
  for (const [file, marker] of [
    ['RemoteStatusIcon.tsx', 'isVirtual(sessionId)'],
    ['RemoteComposerBanner.tsx', 'isVirtual(sessionId)'],
  ]) {
    const source = readFileSync(join(ROOT, 'src', 'client', file), 'utf8')
    assert.ok(source.includes(marker), `${file} gates its render on the virtual id`)
    assert.ok(source.includes('return null'), `${file} renders nothing off the gate`)
  }
  // T34-fix: the disable rides the host's composer-block contract, not a CSS
  // override — the banner raises the block while it stands and the cleanup
  // clears it.
  const banner = readFileSync(join(ROOT, 'src', 'client', 'RemoteComposerBanner.tsx'), 'utf8')
  assert.ok(banner.includes('setComposerBlock(text)'), 'the banner raises the block')
  assert.ok(banner.includes('setComposerBlock(undefined)'), 'the cleanup clears it')
  const css = readFileSync(join(ROOT, 'src', 'client', 'remote-status-css.ts'), 'utf8')
  assert.ok(!css.includes('data-zr-remote-readonly'), 'the CSS override is gone')
  // and the banner no longer stacks an explicit width onto its side margins
  assert.ok(!css.includes('width: 100%'), 'no width+margins overflow')
})

test('T34: describeRemoteStatus — the three icon states, revoked/unpaired read offline, a mismatch only while online', async () => {
  const { describeRemoteStatus } = await import('../src/client-data/remote-status.ts')
  const t = (key) => `#${key}`
  const view = (over = {}) => ({ state: 'online', versionMismatch: false, serverName: 's', closed: {}, asOf: 1, ...over })
  assert.deepEqual(describeRemoteStatus(view(), t), { state: 'online', hoverText: '#remoteStatusOnline' })
  assert.deepEqual(describeRemoteStatus(view({ versionMismatch: true }), t), { state: 'mismatch', hoverText: '#remoteStatusMismatch' })
  assert.deepEqual(describeRemoteStatus(view({ state: 'offline' }), t), { state: 'offline', hoverText: '#remoteStatusOffline' })
  // T34-fix: revoked / unpaired are states of their own — the word is theirs,
  // never "reconnecting"
  assert.deepEqual(describeRemoteStatus(view({ state: 'revoked' }), t), { state: 'revoked', hoverText: '#remoteStatusRevoked' })
  assert.deepEqual(describeRemoteStatus(view({ state: 'unpaired' }), t), { state: 'unpaired', hoverText: '#remoteStatusUnpaired' })
  assert.deepEqual(describeRemoteStatus(undefined, t), { state: 'offline', hoverText: '#remoteStatusOffline' })
  // offline outranks the mismatch (the verdict may predate the outage)
  assert.equal(describeRemoteStatus(view({ state: 'offline', versionMismatch: true }), t).state, 'offline')
  // the default formatter is the Chinese dictionary
  assert.equal(describeRemoteStatus(view()).hoverText, '远程会话 · 已连接')
})

test('T34: bannerText — the closed reason outranks the offline line; online and clean means no banner', async () => {
  const { bannerText } = await import('../src/client-data/remote-status.ts')
  const t = (key) => `#${key}`
  const view = (over = {}) => ({ state: 'online', versionMismatch: false, serverName: 's', closed: {}, asOf: 1, ...over })
  const session = 'zr~abcd1234~session-a'
  assert.equal(bannerText(view({ state: 'offline' }), session, t), '#remoteBannerOffline')
  assert.equal(bannerText(view({ closed: { [session]: 'idle' } }), session, t), '#remoteBannerClosedIdle')
  assert.equal(bannerText(view({ closed: { [session]: 'manual' } }), session, t), '#remoteBannerClosedManual')
  assert.equal(bannerText(view({ closed: { [session]: 'client' } }), session, t), '#remoteBannerClosedClient')
  // a closed session stays closed even while the server is down: the reason wins
  assert.equal(bannerText(view({ state: 'offline', closed: { [session]: 'idle' } }), session, t), '#remoteBannerClosedIdle')
  // other sessions' closures say nothing about this one
  assert.equal(bannerText(view({ closed: { 'zr~abcd1234~other': 'idle' } }), session, t), undefined)
  assert.equal(bannerText(view(), session, t), undefined)
  assert.equal(bannerText(undefined, session, t), undefined)
  // an unknown reason in the closed map degrades to the manual close
  assert.equal(bannerText(view({ closed: { [session]: 'mystery' } }), session, t), '#remoteBannerClosedManual')
  // T41a-fix2: revoked / unpaired stand a banner of their own (and disable
  // the input through it) — neither recovers without the settings page
  assert.equal(bannerText(view({ state: 'revoked' }), session, t), '#remoteBannerRevoked')
  assert.equal(bannerText(view({ state: 'unpaired' }), session, t), '#remoteBannerUnpaired')
  // a session-level closure still outranks the link-level states
  assert.equal(bannerText(view({ state: 'revoked', closed: { [session]: 'idle' } }), session, t), '#remoteBannerClosedIdle')
  // the default formatter is the Chinese dictionary
  assert.equal(bannerText(view({ state: 'revoked' }), session), '令牌已吊销，请在设置页重新配对')
  assert.equal(bannerText(view({ state: 'unpaired' }), session), '已解除配对')
})

test('T34: the store polls only with subscribers and only while visible; failures fail one round', async () => {
  const { createRemoteStatusStore } = await import('../src/client-data/remote-status.ts')
  const bodies = [
    { ok: false, status: 404, json: async () => ({}) },
    { ok: true, status: 200, json: async () => ({ state: 'online', versionMismatch: true, serverName: '书房', closed: { 'zr~abcd1234~s': 'idle' } }) },
    { ok: true, status: 200, json: async () => ({ state: 'offline', versionMismatch: false, serverName: '书房', closed: {} }) },
  ]
  let calls = 0
  let visible = true
  // A visibility source the test DRIVES: the notify callback is what the
  // store's onVisibility reacts to (the real one is document's
  // visibilitychange).
  let notifyVisibility = () => {}
  const store = createRemoteStatusStore(
    async () => { calls += 1; return bodies[Math.min(calls - 1, bodies.length - 1)] },
    { visible: () => visible, subscribe: (listener) => { notifyVisibility = listener; return () => { notifyVisibility = () => {} } } },
    5,
  )
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40))
  const waitFor = async (predicate, ms = 2000) => {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > ms) throw new Error('waitFor timeout')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  // No subscribers: nothing polls.
  await settle()
  assert.equal(calls, 0)

  const off = store.subscribe(() => {})
  try {
    // The immediate pull served the 404 (ready stays false); the cadence
    // burns through the rest until the newest answer shows.
    await waitFor(() => {
      const snap = store.getSnapshot()
      return snap.ready === true && snap.view?.state === 'offline'
    })
    assert.equal(store.getSnapshot().view.versionMismatch, false, 'the newest answer won')
    assert.deepEqual(store.getSnapshot().view.closed, {})
    const readyCalls = calls
    await settle()
    assert.ok(calls > readyCalls, 'the cadence kept polling while visible')

    // Hidden page: the visibility listener stops the timer — no more fetches
    // until visibility returns.
    visible = false
    notifyVisibility()
    await settle()
    const hiddenCalls = calls
    await settle()
    assert.equal(calls, hiddenCalls, 'nothing polls while the page is hidden')

    // Becoming visible pulls once immediately and resumes the cadence.
    visible = true
    notifyVisibility()
    await settle()
    assert.ok(calls > hiddenCalls, 'becoming visible pulled right away')
  } finally {
    off()
  }
  await settle()
  const afterOff = calls
  await settle()
  assert.equal(calls, afterOff, 'the last subscriber leaving stops the poll')
})

test('T34: the store unshare posts the virtual id to the client route, then refreshes', async () => {
  const { createRemoteStatusStore } = await import('../src/client-data/remote-status.ts')
  const seen = []
  let pollCalls = 0
  let posts = 0
  const store = createRemoteStatusStore(async (url, init) => {
    seen.push({ url, method: init?.method, body: init?.body })
    if (init?.method === 'POST') {
      posts += 1
      const ok = posts === 1
      return { ok, status: 200, json: async () => (ok ? { ok: true } : { ok: false, error: { code: 'not-shared' } }) }
    }
    pollCalls += 1
    return { ok: true, status: 200, json: async () => ({ state: 'online', versionMismatch: false, serverName: 's', closed: {} }) }
  }, { visible: () => true, subscribe: () => () => {} }, 60_000)
  const outcome = await store.unshare('zr~abcd1234~session-a')
  assert.deepEqual(outcome, { ok: true })
  const post = seen.find((call) => call.method === 'POST')
  assert.equal(post.url, '/_dsh/zen-remote/client/unshare')
  assert.deepEqual(JSON.parse(post.body), { sessionId: 'zr~abcd1234~session-a' })
  assert.ok(pollCalls >= 1, 'the action was followed by a refresh')

  const refused = await store.unshare('zr~abcd1234~session-b')
  const failBody = seen.filter((call) => call.method === 'POST')[1]
  assert.deepEqual(JSON.parse(failBody.body), { sessionId: 'zr~abcd1234~session-b' })
  assert.deepEqual(refused, { ok: false, code: 'not-shared' })
})
