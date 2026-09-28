// Behaviour check for the settings block's pure logic
// (src/client-data/settings-form.ts), driven against the REAL admin/status
// shapes src/admin-routes.ts answers: devices and the pairing code live
// NESTED in `gateway` (the gateway's /lan-gate/status verbatim), and
// `gatewayStatus` is the HTTP status the route saw (null = no answer).
// Covers the status -> view mapping, the staged row form against a FAKE
// shared form object (validation, env locking, the effective-value display
// baseline, set/unset plans, the expectedRevision fence).
//
// Run: node scripts/check-settings-form.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import {
  deriveSettingsView,
  ZenRemoteSettingsForm,
} from '../src/client-data/settings-form.ts'

// Tiny sequential runner so the file stays plain node:assert (no node:test import).
let testChain = Promise.resolve()
function test(name, fn) {
  testChain = testChain
    .then(fn)
    .then(() => { console.log(`ok - ${name}`) })
    .catch((error) => {
      console.error(`not ok - ${name}`)
      throw error
    })
  return testChain
}

// ---- 1. deriveSettingsView -------------------------------------------------

const NOW = 1_700_000_000_000

const GATEWAY = {
  state: 'running',
  port: 3088,
  target: '127.0.0.1:3080',
  upstreamAuth: 'token',
  pwa: true,
  devices: [
    { id: 'd1', name: 'iPhone', role: 'web', kind: 'phone', createdAt: NOW - 99, lastSeen: NOW - 1000, hasPush: true },
    { id: 'd2', name: 'Studio', role: 'desktop-client', kind: 'weird', createdAt: NOW - 99, lastSeen: NOW - 2000, hasPush: false },
    { id: '', name: 'ghost', role: 'web', kind: 'auto', lastSeen: 0, hasPush: false },
  ],
  pairing: { code: 'AB12CD34', expiresAt: NOW + 6500, role: 'web' },
  pushSubscriptions: 2,
}

const VALUES = {
  role: 'host', port: 4000, host: '0.0.0.0', trustedProxies: '', rateLimit: 60,
  vapidSubject: 'mailto:admin@example.net', lang: 'zh', pushSummary: true,
  pushTurnEnd: false, pushTool: true, pushDebounceMs: 5000, serverName: 'studio',
  idleHours: 24, autoShareNewSessions: false,
}

const SOURCES = {
  role: 'row', port: 'file', host: 'row', trustedProxies: 'default', rateLimit: 'env',
  vapidSubject: 'row', lang: 'default', pushSummary: 'row', pushTurnEnd: 'default',
  pushTool: 'env', pushDebounceMs: 'row', serverName: 'row', idleHours: 'default',
  autoShareNewSessions: 'default',
}

const STATUS = {
  ok: true,
  gateway: GATEWAY,
  gatewayReachable: true,
  gatewayStatus: 200,
  config: { values: VALUES, sources: SOURCES },
  viaGateway: false,
}

const view = deriveSettingsView(STATUS, { now: NOW, rowUser: { port: 99999, serverName: 'x', lang: 'en' } })

assert.equal(view.available, true)
assert.equal(view.role, 'host')
assert.equal(view.viaGateway, false)
assert.equal(view.gatewayReachable, true)
assert.equal(view.gatewayPort, 3088)
assert.equal(view.gatewayTarget, '127.0.0.1:3080')
assert.equal(view.gatewayStatus, 200)
assert.equal(view.gatewayAbnormal, false, 'a 2xx probe is healthy')

// Source annotation: file badge, env lock. A row-layer value another NON-env
// layer replaced marks the saved value invalid; being shadowed by an env
// variable is NOT invalid (the lock badge already says so).
assert.equal(view.fields.port.source, 'file')
assert.equal(view.fields.port.fromFile, true)
assert.equal(view.fields.port.locked, false)
assert.equal(view.fields.port.savedRowInvalid, true, 'row stored a port but the file layer supplied the value')
assert.equal(view.fields.rateLimit.source, 'env')
assert.equal(view.fields.rateLimit.locked, true)
assert.equal(view.fields.rateLimit.savedRowInvalid, false, 'env shadowing is not an invalid saved value')
assert.equal(view.fields.serverName.savedRowInvalid, false, 'the row layer IS the winner for serverName')
assert.equal(view.fields.lang.savedRowInvalid, true, 'row stored a lang but the default layer supplied the value')
assert.equal(view.fields.role.source, 'row')
assert.equal(view.fields.role.savedRowInvalid, false)
assert.equal(view.fields.trustedProxies.source, 'default')
assert.equal(view.fields.trustedProxies.savedRowInvalid, false, 'no row-layer entry, nothing invalid')
// The effective value rides through verbatim.
assert.equal(view.fields.port.value, 4000)
assert.equal(view.fields.pushSummary.value, true)

// Devices and the pairing code are read from the NESTED gateway payload.
assert.deepEqual(view.devices.map((d) => [d.id, d.role, d.kind, d.hasPush]), [
  ['d1', 'web', 'phone', true],
  ['d2', 'desktop-client', 'auto', false],
])
assert.deepEqual(view.pairing, { code: 'AB12CD34', role: 'web', remainingSeconds: 7 })
assert.equal(
  deriveSettingsView(STATUS, { now: NOW + 6500 }).pairing,
  null,
  'an expired pairing code maps to null',
)
assert.equal(
  deriveSettingsView(STATUS, { now: NOW + 1000 }).pairing.remainingSeconds,
  6,
  'the countdown shrinks with the clock',
)

// gatewayStatus: a non-null, non-2xx probe means the gateway answered with an
// error envelope — admin-routes then reports gateway: null, reachable: false.
const abnormal = deriveSettingsView(
  { ...STATUS, gateway: null, gatewayReachable: false, gatewayStatus: 503 },
  { now: NOW },
)
assert.equal(abnormal.gatewayAbnormal, true)
assert.equal(abnormal.gatewayStatus, 503)
assert.equal(abnormal.gatewayReachable, false)
assert.deepEqual(abnormal.devices, [], 'a gateway error envelope carries no device list')
assert.equal(abnormal.pairing, null)
assert.equal(deriveSettingsView({ ...STATUS, gatewayStatus: 301 }, { now: NOW }).gatewayAbnormal, true)
assert.equal(deriveSettingsView({ ...STATUS, gatewayStatus: 204 }, { now: NOW }).gatewayAbnormal, false)
assert.equal(
  deriveSettingsView({ ...STATUS, gateway: null, gatewayReachable: false, gatewayStatus: null }, { now: NOW }).gatewayAbnormal,
  false,
  'no answer at all is "not running", not "abnormal"',
)
assert.equal(
  deriveSettingsView({ ...STATUS, gateway: null, gatewayReachable: false, gatewayStatus: null }, { now: NOW }).devices.length,
  0,
  'gateway null renders as no devices',
)

// role: client surfaces as such (the block then hides every group but the role one).
const clientView = deriveSettingsView(
  { ...STATUS, config: { ...STATUS.config, values: { ...VALUES, role: 'client' } } },
  { now: NOW },
)
assert.equal(clientView.role, 'client')

// viaGateway is the disable flag for every server-local button.
assert.equal(deriveSettingsView({ ...STATUS, viaGateway: true }, { now: NOW }).viaGateway, true)

// An unshaped body degrades instead of throwing.
const empty = deriveSettingsView({}, { now: NOW })
assert.equal(empty.available, false)
assert.equal(empty.role, 'host')
assert.equal(empty.gatewayReachable, false)
assert.equal(empty.gatewayAbnormal, false)
assert.deepEqual(empty.devices, [])
assert.equal(empty.pairing, null)

// ---- 2. the staged row form ------------------------------------------------

/** A fake shared form (the ConfigForm face the Plugins page / settings share). */
function fakeScope(overrides = {}) {
  const state = {
    snapshot: {
      status: 'ready',
      // The entry's own document: empty here — the row never stored anything
      // (what the fields display instead comes from setBaseline's payload).
      value: {},
      base: {},
      user: {},
      revision: 7,
      writable: true,
    },
    mutateCalls: [],
    listeners: new Set(),
  }
  if (overrides.value !== undefined) state.snapshot.value = overrides.value
  if (overrides.user !== undefined) state.snapshot.user = overrides.user
  if (overrides.ready === false) state.snapshot.status = 'unavailable'
  if (overrides.writable === false) state.snapshot.writable = false
  const scope = {
    getSnapshot: () => state.snapshot,
    subscribe: (listener) => {
      state.listeners.add(listener)
      return () => { state.listeners.delete(listener) }
    },
    mutate: async (ops, expectedRevision) => {
      state.mutateCalls.push({ ops: structuredClone(ops), expectedRevision })
      const accepted = overrides.mutateResult ?? true
      if (accepted) state.snapshot = { ...state.snapshot, revision: state.snapshot.revision + 1 }
      for (const listener of state.listeners) listener()
      return accepted
    },
  }
  return { scope, state }
}

test('fields display the EFFECTIVE value while the row layer stores nothing', () => {
  const { scope } = fakeScope()
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES) // config.values from admin/status
  const snap = form.getSnapshot()
  assert.equal(snap.port.text, '4000', 'a file-supplied port shows its effective value')
  assert.equal(snap.pushTool.text, 'true', 'an unstored boolean shows the effective value (on)')
  assert.equal(snap.pushSummary.text, 'true')
  assert.equal(snap.serverName.text, 'studio')
  assert.equal(snap.idleHours.text, '24')
  assert.equal(snap.trustedProxies.text, '', 'an empty effective value stays an empty box')
})

test('a field the row layer stores shows the stored raw value', () => {
  const { scope } = fakeScope({ user: { port: 99999, serverName: '  ' } })
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES)
  const snap = form.getSnapshot()
  assert.equal(snap.port.text, '99999', 'the raw (illegal) stored value shows, with the invalid-saved note')
  assert.equal(snap.port.invalid, false, 'a stored value is not a DRAFT; nothing is flagged invalid')
})

test('env-locked fields show the effective value and cannot be staged', async () => {
  const { scope, state } = fakeScope({ user: { rateLimit: 5 } })
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline({ ...VALUES, rateLimit: 90 }) // env supplies 90
  form.setLockedFields(['rateLimit'])
  const snap = form.getSnapshot()
  assert.equal(snap.rateLimit.locked, true)
  assert.equal(snap.rateLimit.text, '90', 'locked boxes show the effective value, not the shadowed row entry')

  form.stage('rateLimit', '1')
  assert.equal(snap.rateLimit.text, '90', 'the draft was refused')
  assert.equal(form.canSave(), false)
  assert.equal(await form.save(), false)
  assert.equal(state.mutateCalls.length, 0, 'nothing was staged, nothing was sent')

  // Even a pre-existing draft for a freshly locked field is skipped by the plan.
  form.stage('port', '4001')
  form.setLockedFields(['port'])
  assert.equal(form.canSave(), false)
  await form.save()
  assert.equal(state.mutateCalls.length, 0)
})

test('the draft comparison baseline is the displayed value', async () => {
  const { scope, state } = fakeScope()
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES) // effective port: 4000 (file), row stores nothing
  form.stage('port', '4000') // re-typing exactly what the box shows
  assert.equal(form.canSave(), false, 'no phantom override for the displayed effective value')
  await form.save()
  assert.equal(state.mutateCalls.length, 0)

  form.stage('port', '4001')
  assert.equal(form.canSave(), true)
  await form.save()
  assert.deepEqual(state.mutateCalls[0].ops, [{ op: 'set', path: ['port'], value: 4001 }])
})

test('validation: out-of-range drafts block the save instead of being dropped', async () => {
  const { scope, state } = fakeScope()
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES)

  form.stage('port', '70000')
  assert.equal(form.getSnapshot().port.invalid, true)
  assert.equal(form.getSnapshot().invalid, true)
  assert.equal(form.canSave(), false)
  assert.equal(await form.save(), false)
  assert.equal(state.mutateCalls.length, 0, 'the save refuses while a draft is invalid')

  form.stage('idleHours', '0')
  assert.equal(form.getSnapshot().idleHours.invalid, true, 'idleHours excludes zero')

  form.stage('serverName', 'x'.repeat(41))
  assert.equal(form.getSnapshot().serverName.invalid, true, 'serverName caps at 40 characters')

  form.stage('rateLimit', '0')
  assert.equal(form.getSnapshot().rateLimit.invalid, true, 'rateLimit is a positive integer')
})

test('an empty draft plans an unset for a field the user layer carries', async () => {
  const { scope, state } = fakeScope({ user: { host: '0.0.0.0' } })
  const form = new ZenRemoteSettingsForm(scope)
  form.stage('host', '')
  assert.equal(form.canSave(), true)
  await form.save()
  assert.deepEqual(state.mutateCalls[0].ops, [{ op: 'unset', path: ['host'] }])
})

test('typing-empty plans an unset; a reset of a non-carried field writes nothing', async () => {
  const { scope, state } = fakeScope()
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES) // the box shows the effective mailto:…, so '' is a real change
  // 留空 = 清除：a typed-empty draft plans the unset even when the row layer
  // does not currently carry the field (the composition layer wins on save).
  form.stage('vapidSubject', '')
  assert.equal(form.canSave(), true)
  await form.save()
  assert.deepEqual(state.mutateCalls[0].ops, [{ op: 'unset', path: ['vapidSubject'] }])

  // The reset control, in contrast, only writes for a field the user layer carries.
  const clean = new ZenRemoteSettingsForm(scope)
  clean.resetField('vapidSubject')
  assert.equal(clean.canSave(), false)
  await clean.save()
  assert.equal(state.mutateCalls.length, 1, 'only the first save reached the wire')
})

test('a legal draft plans a set; a draft equal to the current value plans nothing', async () => {
  const { scope, state } = fakeScope({ value: { host: '127.0.0.1' } })
  const form = new ZenRemoteSettingsForm(scope)
  form.stage('port', '4001')
  form.stage('pushSummary', 'true')
  form.stage('lang', 'zh')
  form.stage('role', 'client')
  assert.equal(form.canSave(), true)

  form.stage('host', '127.0.0.1') // equals the display baseline: no phantom override
  assert.equal(form.getSnapshot().dirty, true, 'other drafts remain staged')

  await form.save()
  const ops = state.mutateCalls[0].ops.sort((a, b) => a.path[0].localeCompare(b.path[0]))
  assert.deepEqual(ops, [
    { op: 'set', path: ['lang'], value: 'zh' },
    { op: 'set', path: ['port'], value: 4001 },
    { op: 'set', path: ['pushSummary'], value: true },
    { op: 'set', path: ['role'], value: 'client' },
  ])
})

test('the save fences with the revision the drafts started from', async () => {
  const { scope, state } = fakeScope()
  const form = new ZenRemoteSettingsForm(scope)
  form.stage('port', '4001')
  // The mirror moves underneath after staging: the fence must stay at 7.
  state.snapshot = { ...state.snapshot, revision: 9 }
  await form.save()
  assert.equal(state.mutateCalls.length, 1)
  assert.equal(state.mutateCalls[0].expectedRevision, 7)
  assert.equal(form.getSnapshot().dirty, false, 'an accepted save clears the drafts')
})

test('a refused save keeps its drafts and reports failure', async () => {
  const { scope, state } = fakeScope({ mutateResult: false })
  const form = new ZenRemoteSettingsForm(scope)
  form.stage('port', '4001')
  assert.equal(await form.save(), false)
  const snap = form.getSnapshot()
  assert.equal(snap.failed, true)
  assert.equal(snap.dirty, true)
  assert.equal(snap.port.text, '4001')
})

test('an unavailable or read-only form cannot save', async () => {
  const unavailable = new ZenRemoteSettingsForm(fakeScope({ ready: false }).scope)
  unavailable.stage('port', '4001')
  assert.equal(unavailable.canSave(), false)
  assert.equal(await unavailable.save(), false)

  const readOnly = new ZenRemoteSettingsForm(fakeScope({ writable: false }).scope)
  readOnly.stage('port', '4001')
  assert.equal(readOnly.canSave(), false)
})

test('rowUser exposes the raw user layer for the savedRowInvalid check', () => {
  const { scope } = fakeScope({ user: { port: 4000, host: '0.0.0.0', rateLimit: 60 } })
  const form = new ZenRemoteSettingsForm(scope)
  assert.deepEqual(form.rowUser(), { port: 4000, host: '0.0.0.0', rateLimit: 60 })
})
