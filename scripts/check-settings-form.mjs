// Behaviour check for the settings block's pure logic
// (src/client-data/settings-form.ts), driven against the REAL admin/status
// shapes src/admin-routes.ts answers: devices and the pairing code live
// NESTED in `gateway` (the gateway's /lan-gate/status verbatim), and
// `gatewayStatus` is the HTTP status the route saw (null = no answer).
// Covers the status -> view mapping, the staged row form against a FAKE
// shared form object (validation, env locking, the effective-value display
// baseline, set/unset plans, the expectedRevision fence), the T16 client
// group's pure pieces: the client status -> view mapping, the pairing-code
// input normalization, the direct pairing writes and the latest-wins gate,
// the T16-fix 3 role/poll decisions extended by T17's two-level role (saved
// row role first, the client-config probe as fallback), and T17's
// restartPending flag behind the plugin-reload note (T17b: it fires only
// when a save would actually write a restart-field change, never for an
// identical draft, an invalid draft or an env-locked field).
//
// Run: node scripts/check-settings-form.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import {
  CLIENT_RECONNECT_ROUTE,
  createLatestGate,
  clientStatusLineOf,
  deriveClientStatusView,
  deriveSettingsView,
  localOpsAllowed,
  normalizePairingCode,
  savedRowRole,
  settingsPollOf,
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

// localOpsAllowed: the server-local buttons enable only for a viaGateway:false
// answer — undefined (no answer yet) and viaGateway:true both stay disabled.
assert.equal(localOpsAllowed(undefined), false, 'no status answer yet counts as remote')
assert.equal(localOpsAllowed(deriveSettingsView({ ...STATUS, viaGateway: true }, { now: NOW })), false, 'viaGateway:true disables the server-local buttons')
assert.equal(localOpsAllowed(deriveSettingsView({ ...STATUS, viaGateway: false }, { now: NOW })), true, 'viaGateway:false enables the server-local buttons')

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

test('a field the row layer stores shows the RESOLVED value unless the saved value is invalid (T15-fix 3)', () => {
  const { scope } = fakeScope({ user: { port: 99999, serverName: '  ' } })
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES)
  // resolveConfig skipped the stored port 99999 (out of range) — the file
  // layer supplies 4000 and admin/status flags savedRowInvalid for port. The
  // page feeds that set in; the box then shows the RAW stored value so the
  // user sees (and can fix) the mistake.
  form.setRowInvalidFields(['port'])
  const snap = form.getSnapshot()
  assert.equal(snap.port.text, '99999', 'the raw (illegal) stored value shows, with the invalid-saved note')
  assert.equal(snap.port.invalid, false, 'a stored value is not a DRAFT; nothing is flagged invalid')

  // Same stored shape, but the row value is LEGAL: the box shows the
  // normalized resolved value, not the raw one (T15-fix 3).
  const normalized = fakeScope({ user: { trustedProxies: ['10.0.0.1', '10.0.0.2'], pushTool: 1 } })
  const normForm = new ZenRemoteSettingsForm(normalized.scope)
  normForm.setBaseline({ ...VALUES, trustedProxies: '10.0.0.1,10.0.0.2', pushTool: true })
  const normSnap = normForm.getSnapshot()
  assert.equal(normSnap.trustedProxies.text, '10.0.0.1,10.0.0.2', 'a stored array shows the comma string resolveConfig produces')
  assert.equal(normSnap.pushTool.text, 'true', 'a stored 1 shows true, matching what a save writes')

  // Re-typing the shown (normalized) value is not a phantom change.
  normForm.stage('pushTool', 'true')
  assert.equal(normForm.canSave(), false, 'the draft equals the displayed baseline')
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

// ---- T15-fix 2: the staged-clear display ------------------------------------

test('a staged clear keeps showing the current value and flags `cleared` (T15-fix 2)', async () => {
  // This plugin's base layer is empty, so the old `spec.format(base[field])`
  // preview always rendered an empty string — a fake "new value" that was
  // never true. Now the box keeps the CURRENT value and the field carries
  // `cleared` for the "reverts on save" hint.
  const { scope, state } = fakeScope({ user: { port: 4000 } })
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES) // effective port: 4000 (file layer wins over nothing here)
  form.resetField('port')
  const snap = form.getSnapshot()
  assert.equal(snap.port.cleared, true)
  assert.equal(snap.port.text, '4000', 'the current value keeps showing; no fake preview of the next layer')
  assert.equal(snap.port.overridden, false)
  assert.equal(form.canSave(), true, 'the clear still plans an unset for a stored field')

  // Selects (role/lang) stay renderable too: the box shows a REAL option.
  const withRole = fakeScope({ user: { role: 'client' } })
  const roleForm = new ZenRemoteSettingsForm(withRole.scope)
  roleForm.resetField('role')
  assert.equal(roleForm.getSnapshot().role.text, 'client')
  assert.equal(roleForm.getSnapshot().role.cleared, true)

  await form.save()
  assert.deepEqual(state.mutateCalls[0].ops, [{ op: 'unset', path: ['port'] }], 'the clear still writes the unset')
})

// ---- T15-fix 4: the latest-wins gate -----------------------------------------

test('the latest-wins gate drops tickets that are no longer newest (T15-fix 4)', () => {
  const gate = createLatestGate()
  const first = gate.next()
  assert.equal(gate.isLatest(first), true)
  const second = gate.next()
  assert.equal(gate.isLatest(second), true)
  assert.equal(gate.isLatest(first), false, 'an earlier request answering LATE is dropped')
  assert.notEqual(first, second)
})

// ---- T16: the client group ----------------------------------------------------

test('deriveClientStatusView maps every probe state and tolerates garbage', () => {
  const bare = { state: 'unpaired', serverUrl: '', serverName: '', nextRetryAt: undefined, lastError: '', intercept: undefined, compat: undefined }
  assert.deepEqual(deriveClientStatusView({ state: 'unpaired' }), bare)
  assert.deepEqual(deriveClientStatusView({ state: 'connected', serverUrl: 'http://192.168.3.129:3088' }), {
    ...bare,
    state: 'connected',
    serverUrl: 'http://192.168.3.129:3088',
  })
  assert.deepEqual(deriveClientStatusView({ state: 'revoked', serverUrl: 'https://dsh.example.com' }), {
    ...bare,
    state: 'revoked',
    serverUrl: 'https://dsh.example.com',
  })
  assert.deepEqual(deriveClientStatusView({ state: 'unreachable', serverUrl: 'http://x.local:1' }), {
    ...bare,
    state: 'unreachable',
    serverUrl: 'http://x.local:1',
  })
  assert.equal(deriveClientStatusView({ state: 'unexpected', serverUrl: 'http://x.local:1' }).state, 'unexpected')
  assert.equal(deriveClientStatusView({ state: 'incompatible' }).state, 'incompatible', 'T43: the protocol mismatch renders its own word')
  // T16-fix 1: the stored address failed re-validation; nothing was probed.
  assert.deepEqual(deriveClientStatusView({ state: 'invalid-url' }), { ...bare, state: 'invalid-url' })
  // Degraded shapes: unknown state words and non-objects fall back to unpaired.
  assert.equal(deriveClientStatusView({ state: 'gibberish', serverUrl: 'http://x' }).state, 'unpaired')
  assert.deepEqual(deriveClientStatusView({}), bare)
  assert.deepEqual(deriveClientStatusView(undefined), bare)
})

test('T43: the status view carries the reconnect readout only for well-shaped values', () => {
  const view = deriveClientStatusView({
    state: 'unreachable',
    serverUrl: 'http://x.local:1',
    serverName: '书房服务器',
    nextRetryAt: 1_700_000_005_000,
    lastError: 'offline',
  })
  assert.equal(view.serverName, '书房服务器')
  assert.equal(view.nextRetryAt, 1_700_000_005_000)
  assert.equal(view.lastError, 'offline')

  // Garbage degrades: non-numeric nextRetryAt is absent, a non-string
  // lastError is '', a non-string serverName is ''.
  const junk = deriveClientStatusView({ state: 'unreachable', nextRetryAt: 'soon', lastError: 42, serverName: 7 })
  assert.equal(junk.nextRetryAt, undefined)
  assert.equal(junk.lastError, '')
  assert.equal(junk.serverName, '')
})

test('T43: intercept/compat render only when the body carried the field', () => {
  // Absent on an older server — nothing to render.
  assert.equal(deriveClientStatusView({ state: 'unreachable' }).intercept, undefined)
  assert.equal(deriveClientStatusView({ state: 'unreachable' }).compat, undefined)

  const view = deriveClientStatusView({
    state: 'unreachable',
    intercept: {
      installed: true,
      reasons: ['AssistantMarkdown root missing'],
      recentFailures: [
        { time: 1_700_000_000_000, method: 'session/page', code: 'gateway/invocation-unavailable' },
        // The interceptor's actual wire dialect (T42-fix): ISO time under
        // `endpoint` — both must render, not 1970 and "—".
        { time: '2026-09-29T01:02:03.000Z', endpoint: 'session/follow', code: 'offline' },
        { time: 'x', code: 42 },
      ],
    },
    compat: {
      identical: ['session'],
      different: ['workspace', 'goal'],
      unavailable: ['events'],
      incompatibleCalls: [{ time: 1_700_000_000_000, endpoint: 'session/page', code: 'gateway/arguments-invalid' }],
    },
  })
  assert.deepEqual(view.intercept, {
    installed: true,
    reasons: ['AssistantMarkdown root missing'],
    recentFailures: [
      { time: 1_700_000_000_000, method: 'session/page', code: 'gateway/invocation-unavailable' },
      { time: Date.parse('2026-09-29T01:02:03.000Z'), method: 'session/follow', code: 'offline' },
      { time: 0, method: '', code: '' },
    ],
  })
  // T42: the view keeps its render names (mismatchedGroups / recentCalls,
  // endpoint rows mapped onto method) while the WIRE names are the status
  // route's different / incompatibleCalls.
  assert.deepEqual(view.compat, {
    mismatchedGroups: ['workspace', 'goal'],
    recentCalls: [{ time: 1_700_000_000_000, method: 'session/page', code: 'gateway/arguments-invalid' }],
  })

  // Present but empty/garbage still renders the group (installed defaults
  // false, lists empty) — the field's presence is the gate, not its shape.
  const empty = deriveClientStatusView({ state: 'unreachable', intercept: {}, compat: null })
  assert.deepEqual(empty.intercept, { installed: false, reasons: [], recentFailures: [] })
  assert.equal(empty.compat, undefined, 'null counts as absent')

  // T42-fix: the MOST RECENT 10 rows survive a longer ring (the rings are
  // oldest-first, so the tail is the fresh end), not the oldest ten.
  const flooded = deriveClientStatusView({
    state: 'unreachable',
    intercept: { recentFailures: Array.from({ length: 14 }, (_, i) => ({ time: 1_000 + i, method: `m${i}`, code: 'x' })) },
  })
  assert.equal(flooded.intercept.recentFailures.length, 10)
  assert.deepEqual(flooded.intercept.recentFailures[0], { time: 1_004, method: 'm4', code: 'x' })
  assert.deepEqual(flooded.intercept.recentFailures[9], { time: 1_013, method: 'm13', code: 'x' })
})

// ---- T43: the connection-line copy selector ---------------------------------

const viewOf = (extra = {}) => deriveClientStatusView({ state: 'unreachable', serverUrl: 'http://x.local:1', ...extra })

test('clientStatusLineOf picks the diagnostics wording per state', () => {
  // Connected prefers the handshake's server name, falls back to the URL.
  assert.deepEqual(
    clientStatusLineOf(viewOf({ state: 'connected', serverName: '书房服务器' }), NOW),
    { kind: 'connectedName', serverName: '书房服务器' },
  )
  assert.deepEqual(
    clientStatusLineOf(viewOf({ state: 'connected' }), NOW),
    { kind: 'connected', serverUrl: 'http://x.local:1' },
  )

  // Offline with a pending retry counts down; overdue collapses to "soon".
  assert.deepEqual(
    clientStatusLineOf(viewOf({ nextRetryAt: NOW + 9_400 }), NOW),
    { kind: 'offlineRetry', seconds: 10 },
    'the countdown rounds up to whole seconds',
  )
  assert.deepEqual(
    clientStatusLineOf(viewOf({ nextRetryAt: NOW + 1_000 }), NOW + 1_500),
    { kind: 'offlineRetrySoon' },
    'an overdue wait reads as imminent',
  )
  assert.deepEqual(
    clientStatusLineOf(viewOf({ nextRetryAt: NOW + 500 }), NOW),
    { kind: 'offlineRetry', seconds: 1 },
  )
  // The probe fallback (no relay client) has no nextRetryAt.
  assert.deepEqual(clientStatusLineOf(viewOf({}), NOW), { kind: 'unreachable' })

  // T43-fix: the countdown follows the nextRetryAt, whatever the probe
  // word underneath — an `unexpected` verdict backed by a pending retry is
  // still OFFLINE with a ladder running.
  assert.deepEqual(
    clientStatusLineOf(viewOf({ state: 'unexpected', nextRetryAt: NOW + 4_000 }), NOW),
    { kind: 'offlineRetry', seconds: 4 },
  )
  // Without a nextRetryAt the two verdicts keep their own plain copy.
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'unexpected' }), NOW), { kind: 'unexpected' })

  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'revoked' }), NOW), { kind: 'revoked' })
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'incompatible' }), NOW), { kind: 'incompatible' })
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'unexpected' }), NOW), { kind: 'unexpected' })
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'invalid-url' }), NOW), { kind: 'invalidUrl' })
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'unpaired' }), NOW), { kind: 'unpaired' })
})

test('CLIENT_RECONNECT_ROUTE is the one reconnect endpoint', () => {
  assert.equal(CLIENT_RECONNECT_ROUTE, '/_dsh/zen-remote/client/reconnect')
})

test('normalizePairingCode uppercases and strips spaces and hyphens', () => {
  assert.equal(normalizePairingCode('ab cd-12'), 'ABCD12')
  assert.equal(normalizePairingCode('  abcd12ef  '), 'ABCD12EF')
  assert.equal(normalizePairingCode('abcd-12-ef'), 'ABCD12EF')
  assert.equal(normalizePairingCode(''), '')
})

test('writeClientPairing lands one mutate with both ops and clears the draft fence', async () => {
  const { scope, state } = fakeScope()
  const form = new ZenRemoteSettingsForm(scope)
  assert.equal(await form.writeClientPairing('http://192.168.3.129:3088', 'tok-xyz'), true)
  assert.equal(state.mutateCalls.length, 1)
  assert.deepEqual(state.mutateCalls[0].ops, [
    { op: 'set', path: ['serverUrl'], value: 'http://192.168.3.129:3088' },
    { op: 'set', path: ['deviceToken'], value: 'tok-xyz' },
  ])
  assert.equal(state.mutateCalls[0].expectedRevision, 7, 'fenced with the current revision')

  // Staged drafts survive the direct write, and their fence refreshes: a
  // draft staged BEFORE the pairing write must save against the NEW revision,
  // not the one it was staged under.
  const staged = fakeScope()
  const stForm = new ZenRemoteSettingsForm(staged.scope)
  stForm.stage('host', '0.0.0.0')
  assert.equal(await stForm.writeClientPairing('http://x.local', 'tok'), true)
  await stForm.save()
  assert.equal(staged.state.mutateCalls[1].expectedRevision, 8, 'the fence moved with the row, not with the stale stage time')
  assert.deepEqual(staged.state.mutateCalls[1].ops, [{ op: 'set', path: ['host'], value: '0.0.0.0' }])
})

test('clearDeviceToken unsets only the token and keeps the address', async () => {
  const { scope, state } = fakeScope()
  const form = new ZenRemoteSettingsForm(scope)
  assert.equal(await form.clearDeviceToken(), true)
  assert.deepEqual(state.mutateCalls[0].ops, [{ op: 'unset', path: ['deviceToken'] }])
})

test('the direct writes refuse when the form is unavailable, read-only or already saving', async () => {
  const unavailable = new ZenRemoteSettingsForm(fakeScope({ ready: false }).scope)
  assert.equal(await unavailable.writeClientPairing('http://x.local', 'tok'), false)
  assert.equal(await unavailable.clearDeviceToken(), false)

  const readOnly = new ZenRemoteSettingsForm(fakeScope({ writable: false }).scope)
  assert.equal(await readOnly.writeClientPairing('http://x.local', 'tok'), false)

  // A refused mutate reports failure through the return value; the frame's
  // staged-save `failed` flag stays untouched (pairing has its own copy).
  const refused = fakeScope({ mutateResult: false })
  const refusedForm = new ZenRemoteSettingsForm(refused.scope)
  assert.equal(await refusedForm.clearDeviceToken(), false)
  assert.equal(refusedForm.getSnapshot().failed, false)
})

test('the device token rides the snapshot as presence only, and rowValue reads the saved document', () => {
  let configured = false
  const { scope } = fakeScope({ value: { role: 'client', serverUrl: 'http://192.168.3.129:3088' } })
  const form = new ZenRemoteSettingsForm(scope, () => configured)
  assert.equal(form.getSnapshot().deviceToken.configured, false)
  assert.equal(form.rowValue('role'), 'client')
  assert.equal(form.rowValue('serverUrl'), 'http://192.168.3.129:3088')
  assert.equal(form.rowValue('deviceToken'), undefined, 'secrets never ride the form document')

  configured = true
  form.refresh()
  assert.equal(form.getSnapshot().deviceToken.configured, true, 'the describe follow republishes')
})

// ---- T16-fix 3 + T17: the page's role and status-source decisions -----------

test('savedRowRole reads the SAVED role from the snapshot, never a display draft', () => {
  // The schema-resolved section carries the role…
  assert.equal(savedRowRole({ value: { role: 'client' }, user: {} }), 'client')
  // …but a row value kept only in the raw user layer counts too…
  assert.equal(savedRowRole({ value: {}, user: { role: 'client' } }), 'client')
  // …an explicit host is known…
  assert.equal(savedRowRole({ value: { role: 'host' }, user: {} }), 'host')
  assert.equal(savedRowRole({ value: {}, user: { role: 'host' } }), 'host')
  // …and T17: a row without any role — or with an unrecognized one — answers
  // undefined, meaning "ask the client-config probe", NOT a host assumption.
  assert.equal(savedRowRole({ value: {}, user: {} }), undefined)
  assert.equal(savedRowRole({ value: { role: 'Client' }, user: {} }), undefined, 'exact match only')
  assert.equal(savedRowRole({}), undefined)
  assert.equal(savedRowRole({ value: undefined, user: undefined }), undefined)
})

test('settingsPollOf: loading polls nothing; a known row role decides; otherwise wait for the probe', () => {
  assert.equal(settingsPollOf('loading', { value: { role: 'client' } }), 'none', 'the role is not knowable while the mirror loads')
  assert.equal(settingsPollOf('ready', { value: { role: 'client' } }), 'client')
  assert.equal(settingsPollOf('ready', { user: { role: 'client' } }), 'client')
  assert.equal(settingsPollOf('ready', { value: { role: 'host' } }), 'admin')
  // T17: no row role (the value lives only in lan-gate.config.json) — the
  // page polls NOTHING until the client-config probe answers, so a file-layer
  // client never sees a wasted admin/status 404.
  assert.equal(settingsPollOf('ready', { value: {} }), 'none')
  assert.equal(settingsPollOf('unavailable', { value: {} }), 'none')
  assert.equal(settingsPollOf('ready', { value: {} }, 'client'), 'client', 'the probe answers client')
  assert.equal(settingsPollOf('ready', { value: {} }, 'host'), 'admin', 'the probe answers host')
  // A stored row role always beats the probe.
  assert.equal(settingsPollOf('ready', { value: { role: 'host' } }, 'client'), 'admin')
  assert.equal(settingsPollOf('ready', { value: { role: 'client' } }, 'host'), 'client')
})

test('the controller falls back to the probed role; a stored row role wins over it', () => {
  const noRole = new ZenRemoteSettingsForm(fakeScope({ value: {} }).scope)
  assert.equal(noRole.savedRoleIsClient(), false, 'no row role, no probe yet: host default')
  assert.equal(noRole.statusPoll(), 'none', 'the poll waits for the probe')
  noRole.setProbedRole('client')
  assert.equal(noRole.savedRoleIsClient(), true, 'the probe flips the page to client mode')
  assert.equal(noRole.statusPoll(), 'client')
  noRole.setProbedRole('host')
  assert.equal(noRole.savedRoleIsClient(), false)
  assert.equal(noRole.statusPoll(), 'admin')
  noRole.setProbedRole(undefined)
  assert.equal(noRole.statusPoll(), 'none', 'clearing the probe re-arms the wait')

  const hostRow = new ZenRemoteSettingsForm(fakeScope({ value: { role: 'host' } }).scope)
  hostRow.setProbedRole('client')
  assert.equal(hostRow.savedRoleIsClient(), false, 'a stored row role beats a stale probe')
  assert.equal(hostRow.statusPoll(), 'admin')
  const clientRow = new ZenRemoteSettingsForm(fakeScope({ user: { role: 'client' } }).scope)
  clientRow.setProbedRole('host')
  assert.equal(clientRow.savedRoleIsClient(), true)
  assert.equal(clientRow.statusPoll(), 'client')
})

test('the poll source follows a role switch at the NEXT snapshot, admin never on client', () => {
  // host → client: the new snapshot's decision references only its own role.
  const before = settingsPollOf('ready', { value: { role: 'host' } })
  assert.equal(before, 'admin')
  const after = settingsPollOf('ready', { value: { role: 'client' } })
  assert.equal(after, 'client', 'after switching to client, only client/status is polled')
  // Reverse direction.
  assert.equal(settingsPollOf('ready', { value: { role: 'host' } }), 'admin')
  // The controller reads the same decisions off its live scope.
  const clientScope = fakeScope({ value: { role: 'client' } }).scope
  const clientForm = new ZenRemoteSettingsForm(clientScope)
  assert.equal(clientForm.savedRoleIsClient(), true)
  assert.equal(clientForm.statusPoll(), 'client')
  assert.equal(clientForm.scopeStatus(), 'ready')
})

// ---- T17: the plugin-reload note ---------------------------------------------

test('restartPending tracks staged drafts over the restart-required fields only', async () => {
  // The row layer stores port, so the staged clear below plans an unset.
  const { scope, state } = fakeScope({ value: { port: 4000 }, user: { port: 4000 } })
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES)
  assert.equal(form.getSnapshot().restartPending, false, 'nothing staged yet')

  form.stage('serverName', 'renamed')
  assert.equal(form.getSnapshot().restartPending, false, 'serverName is live-read; no reload')

  form.stage('port', '4001')
  const pending = form.getSnapshot()
  assert.equal(pending.restartPending, true, 'a staged port reloads the row')
  assert.equal(pending.dirty, true)

  form.discard()
  assert.equal(form.getSnapshot().restartPending, false, 'discard clears the note')

  form.stage('role', 'client')
  assert.equal(form.getSnapshot().restartPending, true, 'the role is a restart field too')
  form.resetField('port')
  assert.equal(form.getSnapshot().restartPending, true, 'a staged clear of a restart field counts as well')

  assert.equal(await form.save(), true)
  const savedOps = state.mutateCalls[0].ops
  assert.deepEqual(savedOps, [
    { op: 'set', path: ['role'], value: 'client' },
    { op: 'unset', path: ['port'] },
  ], 'both restart-field drafts landed, in field order')
  assert.equal(form.getSnapshot().restartPending, false, 'a landed save clears the staged drafts — the reload takes over from here')
})

test('restartPending only promises a reload when a save would actually write a change (T17b)', async () => {
  // A draft equal to the displayed effective value plans no op → no note.
  const { scope } = fakeScope({ value: { port: 4000 }, user: { port: 4000 } })
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES) // effective port: 4000
  form.stage('port', '4000')
  assert.equal(form.getSnapshot().restartPending, false, 'a draft equal to the effective value is no change at all')
  assert.equal(form.getSnapshot().dirty, false)

  // An invalid draft blocks the save instead of saving anything → no note.
  form.stage('port', '70000')
  const invalidSnap = form.getSnapshot()
  assert.equal(invalidSnap.restartPending, false, 'an out-of-range draft never saves, so no reload is promised')
  assert.equal(invalidSnap.invalid, true)

  // An env-locked restart field stages nothing — and a draft staged before
  // the lock landed does not count either (a written value would be
  // shadowed by the variable, and plan() skips locked fields).
  const env = fakeScope({ user: { port: 4000 } })
  const envForm = new ZenRemoteSettingsForm(env.scope)
  envForm.setBaseline(VALUES)
  envForm.stage('port', '4001')
  assert.equal(envForm.getSnapshot().restartPending, true, 'still a plain staged change here')
  envForm.setLockedFields(['port'])
  assert.equal(envForm.getSnapshot().restartPending, false, 'an env-sourced field never promises a reload')

  // A staged clear of a restart field the row layer does NOT carry plans
  // no op → no note.
  const clear = fakeScope()
  const clearForm = new ZenRemoteSettingsForm(clear.scope)
  clearForm.setBaseline(VALUES)
  clearForm.resetField('port')
  assert.equal(clearForm.getSnapshot().restartPending, false, 'nothing to revert: the row stores no port')

  // A real value change still promises the reload.
  clearForm.stage('port', '4001')
  assert.equal(clearForm.getSnapshot().restartPending, true, 'a real change keeps the note')
})
