import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLIENT_PEER_DISMISS_REVOKED_ROUTE,
  CLIENT_PEER_JOIN_ROUTE,
  CLIENT_PEER_LEAVE_ROUTE,
  CLIENT_PEER_REPROBE_ROUTE,
  CLIENT_PEER_STATUS_ROUTE,
  CLIENT_PEER_TOGGLE_MOUNT_ROUTE,
  CLIENT_PEER_TRUST_ROUTE,
  CLIENT_RECONNECT_ROUTE,
  CLIENT_STATUS_ROUTE,
  CLIENT_UNPAIR_ROUTE,
  MAX_PAIRED_SERVERS,
  SETTINGS_FIELDS,
  ZenRemoteSettingsForm,
  awaitClientStatusReady,
  canSubmitClientPairing,
  claimDeviceNameOf,
  clientStatusLineOf,
  consentField,
  createLatestGate,
  debugExportFileName,
  deriveClientStatusView,
  derivePeerStatusView,
  isRttCapDemotion,
  deriveSettingsView,
  localOpsAllowed,
  normalizePairingCode,
  savedRowRole,
  settingsPollOf,
  settingsRoleOf,
  shouldReloadAfterClientActivation,
} from '../src/client-data/settings-form.ts'
import {
  bridgeSectionState,
  derivePluginBridgeStatuses,
  readAdminBridgeRow,
  togglePluginConsent,
} from '../src/client-data/plugin-bridge.ts'
import { BRIDGE_STAMP_PLUGIN } from '../src/client-data/remote-status.ts'

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
  vapidSubject: 'mailto:admin@example.net', lang: 'zh', logLevel: 'debug', pushSummary: true,
  pushTurnEnd: false, pushTool: true, pushEnabled: true, pushSessionName: false,
  pushDebounceMs: 5000, serverName: 'studio',
  idleHours: 24, autoShareNewSessions: false,
}

const SOURCES = {
  role: 'row', port: 'file', host: 'row', trustedProxies: 'default', rateLimit: 'env',
  vapidSubject: 'row', lang: 'default', logLevel: 'env', pushSummary: 'row', pushTurnEnd: 'default',
  pushTool: 'env', pushEnabled: 'default', pushSessionName: 'row',
  pushDebounceMs: 'row', serverName: 'row', idleHours: 'default',
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

function fakeScope(overrides = {}) {
  const state = {
    snapshot: {
      status: 'ready',
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

const viewOf = (extra = {}) => deriveClientStatusView({ state: 'unreachable', serverUrl: 'http://x.local:1', ...extra })

function serverRow(over = {}) {
  return {
    entryId: over.serverUrl ?? 'http://a.local:3088',
    serverId: 'aaaa1111',
    serverUrl: over.serverUrl ?? 'http://a.local:3088',
    serverName: 'A-main',
    displayName: 'A-main',
    state: 'online',
    nextRetryAt: null,
    lastError: 'offline',
    compat: { identical: ['session'], different: ['workspace'], unavailable: [] },
    pluginBridge: [{ plugin: BRIDGE_STAMP_PLUGIN, bridged: true, localVersion: '1.0', remoteVersion: '1.0', reason: undefined }],
    ...over,
  }
}

test('deriveSettingsView maps status, sources, devices, pairing, gateway abnormalities, and localOpsAllowed', () => {
  const view = deriveSettingsView(STATUS, { now: NOW, rowUser: { port: 99999, serverName: 'x', lang: 'en' } })

  assert.equal(view.available, true)
  assert.equal(view.role, 'host')
  assert.equal(view.viaGateway, false)
  assert.equal(view.gatewayReachable, true)
  assert.equal(view.gatewayPort, 3088)
  assert.equal(view.gatewayTarget, '127.0.0.1:3080')
  assert.equal(view.gatewayStatus, 200)
  assert.equal(view.gatewayAbnormal, false)

  assert.equal(view.fields.port.source, 'file')
  assert.equal(view.fields.port.fromFile, true)
  assert.equal(view.fields.port.locked, false)
  assert.equal(view.fields.port.savedRowInvalid, true)
  assert.equal(view.fields.rateLimit.source, 'env')
  assert.equal(view.fields.rateLimit.locked, true)
  assert.equal(view.fields.rateLimit.savedRowInvalid, false)
  assert.equal(view.fields.serverName.savedRowInvalid, false)
  assert.equal(view.fields.lang.savedRowInvalid, true)
  assert.equal(view.fields.role.source, 'row')
  assert.equal(view.fields.role.savedRowInvalid, false)
  assert.equal(view.fields.trustedProxies.source, 'default')
  assert.equal(view.fields.trustedProxies.savedRowInvalid, false)
  assert.equal(view.fields.port.value, 4000)
  assert.equal(view.fields.pushSummary.value, true)
  assert.equal(view.fields.pushEnabled.value, true)
  assert.equal(view.fields.pushEnabled.source, 'default')
  assert.equal(view.fields.pushEnabled.locked, false)
  assert.equal(view.fields.pushSessionName.value, false)
  assert.equal(view.fields.pushSessionName.source, 'row')
  assert.equal(view.fields.pushSessionName.savedRowInvalid, false)
  assert.equal(view.fields.logLevel.value, 'debug')
  assert.equal(view.fields.logLevel.source, 'env')
  assert.equal(view.fields.logLevel.locked, true)
  assert.equal('peerDirectMaxRttMs' in view.fields, false)

  assert.deepEqual(view.devices.map((d) => [d.id, d.role, d.kind, d.hasPush]), [
    ['d1', 'web', 'phone', true],
    ['d2', 'desktop-client', 'auto', false],
  ])
  assert.deepEqual(view.pairing, { code: 'AB12CD34', role: 'web', remainingSeconds: 7 })
  assert.equal(deriveSettingsView(STATUS, { now: NOW + 6500 }).pairing, null)
  assert.equal(deriveSettingsView(STATUS, { now: NOW + 1000 }).pairing.remainingSeconds, 6)

  const abnormal = deriveSettingsView(
    { ...STATUS, gateway: null, gatewayReachable: false, gatewayStatus: 503 },
    { now: NOW },
  )
  assert.equal(abnormal.gatewayAbnormal, true)
  assert.equal(abnormal.gatewayStatus, 503)
  assert.equal(abnormal.gatewayReachable, false)
  assert.deepEqual(abnormal.devices, [])
  assert.equal(abnormal.pairing, null)
  assert.equal(deriveSettingsView({ ...STATUS, gatewayStatus: 301 }, { now: NOW }).gatewayAbnormal, true)
  assert.equal(deriveSettingsView({ ...STATUS, gatewayStatus: 204 }, { now: NOW }).gatewayAbnormal, false)
  assert.equal(
    deriveSettingsView({ ...STATUS, gateway: null, gatewayReachable: false, gatewayStatus: null }, { now: NOW }).gatewayAbnormal,
    false,
  )
  assert.equal(
    deriveSettingsView({ ...STATUS, gateway: null, gatewayReachable: false, gatewayStatus: null }, { now: NOW }).devices.length,
    0,
  )

  const clientView = deriveSettingsView(
    { ...STATUS, config: { ...STATUS.config, values: { ...VALUES, role: 'client' } } },
    { now: NOW },
  )
  assert.equal(clientView.role, 'client')
  assert.equal(deriveSettingsView({ ...STATUS, viaGateway: true }, { now: NOW }).viaGateway, true)

  assert.equal(localOpsAllowed(undefined), false)
  assert.equal(localOpsAllowed(deriveSettingsView({ ...STATUS, viaGateway: true }, { now: NOW })), false)
  assert.equal(localOpsAllowed(deriveSettingsView({ ...STATUS, viaGateway: false }, { now: NOW })), true)

  const empty = deriveSettingsView({}, { now: NOW })
  assert.equal(empty.available, false)
  assert.equal(empty.role, 'host')
  assert.equal(empty.gatewayReachable, false)
  assert.equal(empty.gatewayAbnormal, false)
  assert.deepEqual(empty.devices, [])
  assert.equal(empty.pairing, null)
})

test('fields display the EFFECTIVE value while the row layer stores nothing', () => {
  const { scope } = fakeScope()
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES)
  const snap = form.getSnapshot()
  assert.equal(snap.port.text, '4000')
  assert.equal(snap.pushTool.text, 'true')
  assert.equal(snap.pushSummary.text, 'true')
  assert.equal(snap.serverName.text, 'studio')
  assert.equal(snap.idleHours.text, '24')
  assert.equal(snap.trustedProxies.text, '')
})

test('a field the row layer stores shows the RESOLVED value unless the saved value is invalid (T15-fix 3)', () => {
  const { scope } = fakeScope({ user: { port: 99999, serverName: '  ' } })
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES)
  form.setRowInvalidFields(['port'])
  const snap = form.getSnapshot()
  assert.equal(snap.port.text, '99999')
  assert.equal(snap.port.invalid, false)

  const normalized = fakeScope({ user: { trustedProxies: ['10.0.0.1', '10.0.0.2'], pushTool: 1 } })
  const normForm = new ZenRemoteSettingsForm(normalized.scope)
  normForm.setBaseline({ ...VALUES, trustedProxies: '10.0.0.1,10.0.0.2', pushTool: true })
  const normSnap = normForm.getSnapshot()
  assert.equal(normSnap.trustedProxies.text, '10.0.0.1,10.0.0.2')
  assert.equal(normSnap.pushTool.text, 'true')

  normForm.stage('pushTool', 'true')
  assert.equal(normForm.canSave(), false)
})

test('env-locked fields show the effective value and cannot be staged', async () => {
  const { scope, state } = fakeScope({ user: { rateLimit: 5 } })
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline({ ...VALUES, rateLimit: 90 })
  form.setLockedFields(['rateLimit'])
  const snap = form.getSnapshot()
  assert.equal(snap.rateLimit.locked, true)
  assert.equal(snap.rateLimit.text, '90')

  form.stage('rateLimit', '1')
  assert.equal(snap.rateLimit.text, '90')
  assert.equal(form.canSave(), false)
  assert.equal(await form.save(), false)
  assert.equal(state.mutateCalls.length, 0)

  form.stage('port', '4001')
  form.setLockedFields(['port'])
  assert.equal(form.canSave(), false)
  await form.save()
  assert.equal(state.mutateCalls.length, 0)
})

test('the draft comparison baseline is the displayed value', async () => {
  const { scope, state } = fakeScope()
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline(VALUES)
  form.stage('port', '4000')
  assert.equal(form.canSave(), false)
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
  assert.equal(state.mutateCalls.length, 0)

  form.stage('idleHours', '0')
  assert.equal(form.getSnapshot().idleHours.invalid, true)

  form.stage('serverName', 'x'.repeat(41))
  assert.equal(form.getSnapshot().serverName.invalid, true)

  form.stage('rateLimit', '0')
  assert.equal(form.getSnapshot().rateLimit.invalid, true)

  form.stage('logLevel', 'trace')
  assert.equal(form.getSnapshot().logLevel.invalid, true)

  const junk = fakeScope()
  const junkForm = new ZenRemoteSettingsForm(junk.scope)
  junkForm.setBaseline({ ...VALUES, logLevel: 'noise' })
  assert.equal(junkForm.getSnapshot().logLevel.text, 'info')
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
  form.setBaseline(VALUES)
  form.stage('vapidSubject', '')
  assert.equal(form.canSave(), true)
  await form.save()
  assert.deepEqual(state.mutateCalls[0].ops, [{ op: 'unset', path: ['vapidSubject'] }])

  const clean = new ZenRemoteSettingsForm(scope)
  clean.resetField('vapidSubject')
  assert.equal(clean.canSave(), false)
  await clean.save()
  assert.equal(state.mutateCalls.length, 1)
})

test('a legal draft plans a set; a draft equal to the current value plans nothing', async () => {
  const { scope, state } = fakeScope({ value: { host: '127.0.0.1' } })
  const form = new ZenRemoteSettingsForm(scope)
  form.stage('port', '4001')
  form.stage('pushSummary', 'true')
  form.stage('lang', 'zh')
  form.stage('role', 'client')
  form.stage('logLevel', 'warn')
  assert.equal(form.canSave(), true)

  form.stage('host', '127.0.0.1')
  assert.equal(form.getSnapshot().dirty, true)

  await form.save()
  const ops = state.mutateCalls[0].ops.sort((a, b) => a.path[0].localeCompare(b.path[0]))
  assert.deepEqual(ops, [
    { op: 'set', path: ['lang'], value: 'zh' },
    { op: 'set', path: ['logLevel'], value: 'warn' },
    { op: 'set', path: ['port'], value: 4001 },
    { op: 'set', path: ['pushSummary'], value: true },
    { op: 'set', path: ['role'], value: 'client' },
  ])
})

test('save fence, refusal, availability, rowUser, and staged clear (T15-fix 2)', async () => {
  {
    const { scope, state } = fakeScope()
    const form = new ZenRemoteSettingsForm(scope)
    form.stage('port', '4001')
    state.snapshot = { ...state.snapshot, revision: 9 }
    await form.save()
    assert.equal(state.mutateCalls.length, 1)
    assert.equal(state.mutateCalls[0].expectedRevision, 7)
    assert.equal(form.getSnapshot().dirty, false)
  }

  {
    const { scope } = fakeScope({ mutateResult: false })
    const form = new ZenRemoteSettingsForm(scope)
    form.stage('port', '4001')
    assert.equal(await form.save(), false)
    const snap = form.getSnapshot()
    assert.equal(snap.failed, true)
    assert.equal(snap.dirty, true)
    assert.equal(snap.port.text, '4001')
  }

  {
    const unavailable = new ZenRemoteSettingsForm(fakeScope({ ready: false }).scope)
    unavailable.stage('port', '4001')
    assert.equal(unavailable.canSave(), false)
    assert.equal(await unavailable.save(), false)

    const readOnly = new ZenRemoteSettingsForm(fakeScope({ writable: false }).scope)
    readOnly.stage('port', '4001')
    assert.equal(readOnly.canSave(), false)
  }

  {
    const { scope } = fakeScope({ user: { port: 4000, host: '0.0.0.0', rateLimit: 60 } })
    const form = new ZenRemoteSettingsForm(scope)
    assert.deepEqual(form.rowUser(), { port: 4000, host: '0.0.0.0', rateLimit: 60 })
  }

  {
    const { scope, state } = fakeScope({ user: { port: 4000 } })
    const form = new ZenRemoteSettingsForm(scope)
    form.setBaseline(VALUES)
    form.resetField('port')
    const snap = form.getSnapshot()
    assert.equal(snap.port.cleared, true)
    assert.equal(snap.port.text, '4000')
    assert.equal(snap.port.overridden, false)
    assert.equal(form.canSave(), true)

    const withRole = fakeScope({ user: { role: 'client' } })
    const roleForm = new ZenRemoteSettingsForm(withRole.scope)
    roleForm.resetField('role')
    assert.equal(roleForm.getSnapshot().role.text, 'client')
    assert.equal(roleForm.getSnapshot().role.cleared, true)

    await form.save()
    assert.deepEqual(state.mutateCalls[0].ops, [{ op: 'unset', path: ['port'] }])
  }
})

test('T55: stale admin baseline ignored on client source and cleared on live role switch', () => {
  const client = fakeScope({ value: { role: 'client' } })
  const clientForm = new ZenRemoteSettingsForm(client.scope)
  clientForm.setBaseline({ role: 'host', port: 4000 })
  assert.equal(clientForm.statusPoll(), 'client')
  assert.equal(clientForm.getSnapshot().role.text, 'client')
  assert.equal(clientForm.getSnapshot().port.text, '')

  const host = fakeScope({ value: { role: 'host' } })
  const hostForm = new ZenRemoteSettingsForm(host.scope)
  hostForm.setBaseline({ role: 'host', port: 4000 })
  assert.equal(hostForm.statusPoll(), 'admin')
  assert.equal(hostForm.getSnapshot().role.text, 'host')
  assert.equal(hostForm.getSnapshot().port.text, '4000')

  const { scope, state } = fakeScope({ value: { role: 'host' } })
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline({ role: 'host', port: 4000 })
  assert.equal(form.getSnapshot().role.text, 'host')

  state.snapshot = { ...state.snapshot, value: { role: 'client' } }
  for (const listener of state.listeners) listener()
  assert.equal(form.statusPoll(), 'client')
  assert.equal(form.getSnapshot().role.text, 'client')
  assert.equal(form.getSnapshot().port.text, '')
})

test('the latest-wins gate drops tickets that are no longer newest (T15-fix 4)', () => {
  const gate = createLatestGate()
  const first = gate.next()
  assert.equal(gate.isLatest(first), true)
  const second = gate.next()
  assert.equal(gate.isLatest(second), true)
  assert.equal(gate.isLatest(first), false)
  assert.notEqual(first, second)
})

test('deriveClientStatusView maps every probe state, reconnect, intercept/compat, T55 online, and tolerates garbage', () => {
  const bare = { state: 'unpaired', serverUrl: '', serverName: '', deviceName: '', nextRetryAt: undefined, lastError: '', intercept: undefined, compat: undefined, pluginBridge: [], pluginRouteIntercept: undefined, uploadProbe: undefined, servers: [], maxServers: 8, limitReached: false }
  assert.deepEqual(deriveClientStatusView({ state: 'unpaired' }), bare)
  assert.deepEqual(deriveClientStatusView({ state: 'connected', serverUrl: 'http://192.168.1.10:3088' }), {
    ...bare,
    state: 'connected',
    serverUrl: 'http://192.168.1.10:3088',
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
  assert.equal(deriveClientStatusView({ state: 'incompatible' }).state, 'incompatible')
  assert.deepEqual(deriveClientStatusView({ state: 'invalid-url' }), { ...bare, state: 'invalid-url' })
  assert.equal(deriveClientStatusView({ state: 'gibberish', serverUrl: 'http://x' }).state, 'unpaired')
  assert.deepEqual(deriveClientStatusView({}), bare)
  assert.deepEqual(deriveClientStatusView(undefined), bare)

  const t55View = deriveClientStatusView({ state: 'online', serverName: '书房', serverUrl: 'http://192.168.1.10:3088' })
  assert.equal(t55View.state, 'connected')
  assert.equal(t55View.serverName, '书房')
  assert.deepEqual(clientStatusLineOf(t55View, NOW), { kind: 'connectedName', serverName: '书房' })

  const expected = {
    online: 'connected',
    offline: 'unreachable',
    unpaired: 'unpaired',
    revoked: 'revoked',
    incompatible: 'incompatible',
    'invalid-url': 'invalid-url',
    connected: 'connected',
    unreachable: 'unreachable',
    unexpected: 'unexpected',
  }
  for (const [wire, want] of Object.entries(expected)) {
    const view = deriveClientStatusView({ state: wire, serverUrl: 'http://x.local:1', serverName: '书房' })
    assert.equal(view.state, want, `wire state ${wire}`)
    if (wire !== 'unpaired') {
      assert.notEqual(view.state, 'unpaired')
    }
  }
  assert.deepEqual(
    clientStatusLineOf(deriveClientStatusView({ state: 'offline', serverUrl: 'http://x.local:1', nextRetryAt: NOW + 5_000 }), NOW),
    { kind: 'offlineRetry', seconds: 5 },
  )

  const reconnect = deriveClientStatusView({
    state: 'unreachable',
    serverUrl: 'http://x.local:1',
    serverName: '书房服务器',
    nextRetryAt: 1_700_000_005_000,
    lastError: 'offline',
  })
  assert.equal(reconnect.serverName, '书房服务器')
  assert.equal(reconnect.nextRetryAt, 1_700_000_005_000)
  assert.equal(reconnect.lastError, 'offline')

  const junk = deriveClientStatusView({ state: 'unreachable', nextRetryAt: 'soon', lastError: 42, serverName: 7 })
  assert.equal(junk.nextRetryAt, undefined)
  assert.equal(junk.lastError, '')
  assert.equal(junk.serverName, '')

  assert.equal(deriveClientStatusView({ state: 'unreachable' }).intercept, undefined)
  assert.equal(deriveClientStatusView({ state: 'unreachable' }).compat, undefined)

  const icView = deriveClientStatusView({
    state: 'unreachable',
    intercept: {
      installed: true,
      reasons: ['AssistantMarkdown root missing'],
      recentFailures: [
        { time: 1_700_000_000_000, method: 'session/page', code: 'gateway/invocation-unavailable' },
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
  assert.deepEqual(icView.intercept, {
    installed: true,
    reasons: ['AssistantMarkdown root missing'],
    recentFailures: [
      { time: 1_700_000_000_000, method: 'session/page', code: 'gateway/invocation-unavailable' },
      { time: Date.parse('2026-09-29T01:02:03.000Z'), method: 'session/follow', code: 'offline' },
      { time: 0, method: '', code: '' },
    ],
  })
  assert.deepEqual(icView.compat, {
    mismatchedGroups: ['workspace', 'goal'],
    recentCalls: [{ time: 1_700_000_000_000, method: 'session/page', code: 'gateway/arguments-invalid' }],
  })

  const emptyIc = deriveClientStatusView({ state: 'unreachable', intercept: {}, compat: null })
  assert.deepEqual(emptyIc.intercept, { installed: false, reasons: [], recentFailures: [] })
  assert.equal(emptyIc.compat, undefined)

  const flooded = deriveClientStatusView({
    state: 'unreachable',
    intercept: { recentFailures: Array.from({ length: 14 }, (_, i) => ({ time: 1_000 + i, method: `m${i}`, code: 'x' })) },
  })
  assert.equal(flooded.intercept.recentFailures.length, 10)
  assert.deepEqual(flooded.intercept.recentFailures[0], { time: 1_004, method: 'm4', code: 'x' })
  assert.deepEqual(flooded.intercept.recentFailures[9], { time: 1_013, method: 'm13', code: 'x' })
})

test('clientStatusLineOf, routes, normalizePairingCode, writeClientPairing, discardField, clearDeviceToken', async () => {
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'connected', serverName: '书房服务器' }), NOW), { kind: 'connectedName', serverName: '书房服务器' })
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'connected' }), NOW), { kind: 'connected', serverUrl: 'http://x.local:1' })
  assert.deepEqual(clientStatusLineOf(viewOf({ nextRetryAt: NOW + 9_400 }), NOW), { kind: 'offlineRetry', seconds: 10 })
  assert.deepEqual(clientStatusLineOf(viewOf({ nextRetryAt: NOW + 1_000 }), NOW + 1_500), { kind: 'offlineRetrySoon' })
  assert.deepEqual(clientStatusLineOf(viewOf({ nextRetryAt: NOW + 500 }), NOW), { kind: 'offlineRetry', seconds: 1 })
  assert.deepEqual(clientStatusLineOf(viewOf({}), NOW), { kind: 'unreachable' })
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'unexpected', nextRetryAt: NOW + 4_000 }), NOW), { kind: 'offlineRetry', seconds: 4 })
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'unexpected' }), NOW), { kind: 'unexpected' })
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'revoked' }), NOW), { kind: 'revoked' })
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'incompatible' }), NOW), { kind: 'incompatible' })
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'invalid-url' }), NOW), { kind: 'invalidUrl' })
  assert.deepEqual(clientStatusLineOf(viewOf({ state: 'unpaired' }), NOW), { kind: 'unpaired' })

  assert.equal(CLIENT_RECONNECT_ROUTE, '/_dsh/zen-remote/client/reconnect')
  assert.equal(CLIENT_STATUS_ROUTE, '/_dsh/zen-remote/client/status')
  assert.equal(CLIENT_UNPAIR_ROUTE, '/_dsh/zen-remote/client/unpair')
  assert.equal(MAX_PAIRED_SERVERS, 8)
  assert.equal(CLIENT_PEER_STATUS_ROUTE, '/_dsh/zen-remote/client/peer/status')
  assert.equal(CLIENT_PEER_JOIN_ROUTE, '/_dsh/zen-remote/client/peer/join')
  assert.equal(CLIENT_PEER_LEAVE_ROUTE, '/_dsh/zen-remote/client/peer/leave')
  assert.equal(CLIENT_PEER_TOGGLE_MOUNT_ROUTE, '/_dsh/zen-remote/client/peer/toggle-mount')
  assert.equal(CLIENT_PEER_TRUST_ROUTE, '/_dsh/zen-remote/client/peer/trust')
  assert.equal(CLIENT_PEER_REPROBE_ROUTE, '/_dsh/zen-remote/client/peer/reprobe')
  assert.equal(CLIENT_PEER_DISMISS_REVOKED_ROUTE, '/_dsh/zen-remote/client/peer/dismiss-revoked')

  assert.equal(normalizePairingCode('ab cd-23'), 'ABCD23')
  assert.equal(normalizePairingCode('  abcd23ef  '), 'ABCD23EF')
  assert.equal(normalizePairingCode('abcd-23-ef-gh'), 'ABCD23EF')
  assert.equal(normalizePairingCode('0O1IL!@#$%^&*()_+=abcd2345'), 'ABCD2345')
  assert.equal(normalizePairingCode(''), '')

  {
    const { scope, state } = fakeScope()
    const form = new ZenRemoteSettingsForm(scope)
    assert.equal(await form.writeClientPairing('http://192.168.1.10:3088', 'tok-xyz', '书房的台式机'), true)
    assert.equal(state.mutateCalls.length, 1)
    assert.deepEqual(state.mutateCalls[0].ops, [
      { op: 'set', path: ['serverUrl'], value: 'http://192.168.1.10:3088' },
      { op: 'set', path: ['deviceToken'], value: 'tok-xyz' },
      { op: 'set', path: ['serverName'], value: '书房的台式机' },
    ])
    assert.equal(state.mutateCalls[0].expectedRevision, 7)

    const staged = fakeScope()
    const stForm = new ZenRemoteSettingsForm(staged.scope)
    stForm.stage('host', '0.0.0.0')
    assert.equal(await stForm.writeClientPairing('http://x.local', 'tok', '台式机'), true)
    await stForm.save()
    assert.equal(staged.state.mutateCalls[1].expectedRevision, 8)
    assert.deepEqual(staged.state.mutateCalls[1].ops, [{ op: 'set', path: ['host'], value: '0.0.0.0' }])
  }

  {
    const { scope } = fakeScope({ value: { role: 'client' } })
    const form = new ZenRemoteSettingsForm(scope)
    form.stage('serverName', '书房的台式机')
    assert.equal(form.hasDraft('serverName'), true)
    assert.equal(await form.writeClientPairing('http://x.local', 'tok', '书房的台式机'), true)
    form.discardField('serverName')
    assert.equal(form.hasDraft('serverName'), false)
    assert.equal(form.rowValue('serverName'), undefined)

    form.stage('role', 'client')
    form.discardField('serverName')
    form.discardField('host')
    assert.equal(form.hasDraft('role'), true)
  }

  {
    const { scope, state } = fakeScope()
    const form = new ZenRemoteSettingsForm(scope)
    assert.equal(await form.clearDeviceToken(), true)
    assert.deepEqual(state.mutateCalls[0].ops, [{ op: 'unset', path: ['deviceToken'] }])
  }

  {
    const unavailable = new ZenRemoteSettingsForm(fakeScope({ ready: false }).scope)
    assert.equal(await unavailable.writeClientPairing('http://x.local', 'tok', '名'), false)
    assert.equal(await unavailable.clearDeviceToken(), false)
    const readOnly = new ZenRemoteSettingsForm(fakeScope({ writable: false }).scope)
    assert.equal(await readOnly.writeClientPairing('http://x.local', 'tok', '名'), false)
    const refused = fakeScope({ mutateResult: false })
    const refusedForm = new ZenRemoteSettingsForm(refused.scope)
    assert.equal(await refusedForm.clearDeviceToken(), false)
    assert.equal(refusedForm.getSnapshot().failed, false)
  }

  {
    let configured = false
    const { scope } = fakeScope({ value: { role: 'client', serverUrl: 'http://192.168.1.10:3088' } })
    const form = new ZenRemoteSettingsForm(scope, () => configured)
    assert.equal(form.getSnapshot().deviceToken.configured, false)
    assert.equal(form.rowValue('role'), 'client')
    assert.equal(form.rowValue('serverUrl'), 'http://192.168.1.10:3088')
    assert.equal(form.rowValue('deviceToken'), undefined)
    configured = true
    form.refresh()
    assert.equal(form.getSnapshot().deviceToken.configured, true)
  }
})

test('savedRowRole, settingsPollOf, settingsRoleOf (host / client / peer), and restartPending', async () => {
  assert.equal(savedRowRole({ value: { role: 'client' }, user: {} }), 'client')
  assert.equal(savedRowRole({ value: {}, user: { role: 'client' } }), 'client')
  assert.equal(savedRowRole({ value: { role: 'host' }, user: {} }), 'host')
  assert.equal(savedRowRole({ value: {}, user: { role: 'host' } }), 'host')
  assert.equal(savedRowRole({ value: { role: 'peer' }, user: {} }), 'peer')
  assert.equal(savedRowRole({ value: {}, user: { role: 'peer' } }), 'peer')
  assert.equal(savedRowRole({ value: {}, user: {} }), undefined)
  assert.equal(savedRowRole({ value: { role: 'Client' }, user: {} }), undefined)
  assert.equal(savedRowRole({ value: { role: 'Peer' }, user: {} }), undefined)
  assert.equal(savedRowRole({}), undefined)
  assert.equal(savedRowRole({ value: undefined, user: undefined }), undefined)

  assert.equal(settingsPollOf('loading', { value: { role: 'client' } }), 'none')
  assert.equal(settingsPollOf('ready', { value: { role: 'client' } }), 'client')
  assert.equal(settingsPollOf('ready', { user: { role: 'client' } }), 'client')
  assert.equal(settingsPollOf('ready', { value: { role: 'host' } }), 'admin')
  assert.equal(settingsPollOf('ready', { value: { role: 'peer' } }), 'admin')
  assert.equal(settingsPollOf('ready', { value: {}, user: {} }, 'peer'), 'admin')
  assert.equal(settingsRoleOf('ready', { value: {}, user: {} }, 'peer'), 'peer')
  assert.equal(settingsPollOf('ready', { value: {} }), 'none')
  assert.equal(settingsPollOf('unavailable', { value: {} }), 'none')
  assert.equal(settingsPollOf('ready', { value: {} }, 'client'), 'client')
  assert.equal(settingsPollOf('ready', { value: {} }, 'host'), 'admin')
  assert.equal(settingsPollOf('ready', { value: { role: 'host' } }, 'client'), 'admin')
  assert.equal(settingsPollOf('ready', { value: { role: 'client' } }, 'host'), 'client')

  const noRole = new ZenRemoteSettingsForm(fakeScope({ value: {} }).scope)
  assert.equal(noRole.savedRoleIsClient(), false)
  assert.equal(noRole.statusPoll(), 'none')
  noRole.setProbedRole('client')
  assert.equal(noRole.savedRoleIsClient(), true)
  assert.equal(noRole.statusPoll(), 'client')
  noRole.setProbedRole('host')
  assert.equal(noRole.savedRoleIsClient(), false)
  assert.equal(noRole.statusPoll(), 'admin')
  noRole.setProbedRole(undefined)
  assert.equal(noRole.statusPoll(), 'none')

  const hostRow = new ZenRemoteSettingsForm(fakeScope({ value: { role: 'host' } }).scope)
  hostRow.setProbedRole('client')
  assert.equal(hostRow.savedRoleIsClient(), false)
  assert.equal(hostRow.statusPoll(), 'admin')
  const clientRow = new ZenRemoteSettingsForm(fakeScope({ user: { role: 'client' } }).scope)
  clientRow.setProbedRole('host')
  assert.equal(clientRow.savedRoleIsClient(), true)
  assert.equal(clientRow.statusPoll(), 'client')

  const clientForm = new ZenRemoteSettingsForm(fakeScope({ value: { role: 'client' } }).scope)
  assert.equal(clientForm.savedRoleIsClient(), true)
  assert.equal(clientForm.statusPoll(), 'client')
  assert.equal(clientForm.scopeStatus(), 'ready')

  {
    const { scope, state } = fakeScope({ value: { port: 4000 }, user: { port: 4000 } })
    const form = new ZenRemoteSettingsForm(scope)
    form.setBaseline(VALUES)
    assert.equal(form.getSnapshot().restartPending, false)
    form.stage('serverName', 'renamed')
    assert.equal(form.getSnapshot().restartPending, false)
    form.stage('port', '4001')
    assert.equal(form.getSnapshot().restartPending, true)
    assert.equal(form.getSnapshot().dirty, true)
    form.discard()
    assert.equal(form.getSnapshot().restartPending, false)
    form.stage('role', 'client')
    assert.equal(form.getSnapshot().restartPending, true)
    form.resetField('port')
    assert.equal(form.getSnapshot().restartPending, true)
    assert.equal(await form.save(), true)
    assert.deepEqual(state.mutateCalls[0].ops, [
      { op: 'set', path: ['role'], value: 'client' },
      { op: 'unset', path: ['port'] },
    ])
    assert.equal(form.getSnapshot().restartPending, false)
  }

  {
    const { scope } = fakeScope({ value: { port: 4000 }, user: { port: 4000 } })
    const form = new ZenRemoteSettingsForm(scope)
    form.setBaseline(VALUES)
    form.stage('port', '4000')
    assert.equal(form.getSnapshot().restartPending, false)
    assert.equal(form.getSnapshot().dirty, false)
    form.stage('port', '70000')
    assert.equal(form.getSnapshot().restartPending, false)
    assert.equal(form.getSnapshot().invalid, true)

    const env = fakeScope({ user: { port: 4000 } })
    const envForm = new ZenRemoteSettingsForm(env.scope)
    envForm.setBaseline(VALUES)
    envForm.stage('port', '4001')
    assert.equal(envForm.getSnapshot().restartPending, true)
    envForm.setLockedFields(['port'])
    assert.equal(envForm.getSnapshot().restartPending, false)

    const clear = fakeScope()
    const clearForm = new ZenRemoteSettingsForm(clear.scope)
    clearForm.setBaseline(VALUES)
    clearForm.resetField('port')
    assert.equal(clearForm.getSnapshot().restartPending, false)
    clearForm.stage('port', '4001')
    assert.equal(clearForm.getSnapshot().restartPending, true)
  }
})

test('T57 / T59 / T60 / UX-1: serverName on client, claimDeviceNameOf, and reload-after-activation', () => {
  assert.equal(claimDeviceNameOf('书房的台式机', '桌面应用端'), '书房的台式机')
  assert.equal(claimDeviceNameOf('', '桌面应用端'), '桌面应用端')
  assert.equal(claimDeviceNameOf('   ', '桌面应用端'), '桌面应用端')
  assert.equal(claimDeviceNameOf('x'.repeat(41), '桌面应用端'), '桌面应用端')
  assert.equal(claimDeviceNameOf('x'.repeat(40), '桌面应用端'), 'x'.repeat(40))
  assert.equal(claimDeviceNameOf('  书房  ', '桌面应用端'), '书房')
  assert.equal(claimDeviceNameOf('\t书房\n', '桌面应用端'), '书房')
  assert.equal(claimDeviceNameOf('  ' + 'x'.repeat(40) + '  ', '桌面应用端'), 'x'.repeat(40))
  assert.equal(claimDeviceNameOf('x'.repeat(39) + '  ', '桌面应用端'), 'x'.repeat(39))
  assert.equal(claimDeviceNameOf(' \t ', '桌面应用端'), '桌面应用端')

  const view = deriveClientStatusView({ state: 'online', serverName: '书房', serverUrl: 'http://x.local', deviceName: '书房的台式机' })
  assert.equal(view.state, 'connected')
  assert.equal(view.deviceName, '书房的台式机')
  assert.equal(deriveClientStatusView({ state: 'online', serverUrl: 'http://x.local' }).deviceName, '')
  assert.equal(deriveClientStatusView({ state: 'online', deviceName: 42 }).deviceName, '')

  assert.equal(shouldReloadAfterClientActivation({ wasEffectiveClient: false, nowClientRole: true, savedOrPaired: false }), false)
  assert.equal(shouldReloadAfterClientActivation({ wasEffectiveClient: true, nowClientRole: true, savedOrPaired: false }), false)
  assert.equal(shouldReloadAfterClientActivation({ wasEffectiveClient: false, nowClientRole: false, savedOrPaired: true }), false)
  assert.equal(shouldReloadAfterClientActivation({ wasEffectiveClient: true, nowClientRole: false, savedOrPaired: true }), false)
  assert.equal(shouldReloadAfterClientActivation({ wasEffectiveClient: false, nowClientRole: true, savedOrPaired: true }), true)
  assert.equal(shouldReloadAfterClientActivation({ wasEffectiveClient: false, nowClientRole: true, savedOrPaired: true, streamInterceptAlreadyActive: false }), true)
  assert.equal(shouldReloadAfterClientActivation({ wasEffectiveClient: false, nowClientRole: true, savedOrPaired: true, streamInterceptAlreadyActive: true }), true)
  assert.equal(shouldReloadAfterClientActivation({ wasEffectiveClient: false, nowClientRole: true, savedOrPaired: true, streamInterceptAlreadyActive: undefined }), true)
  assert.equal(shouldReloadAfterClientActivation({ wasEffectiveClient: true, nowClientRole: true, savedOrPaired: true, streamInterceptAlreadyActive: false }), true)
  assert.equal(shouldReloadAfterClientActivation({ wasEffectiveClient: true, nowClientRole: true, savedOrPaired: true, streamInterceptAlreadyActive: true }), false)
  assert.equal(shouldReloadAfterClientActivation({ wasEffectiveClient: true, nowClientRole: true, savedOrPaired: true, streamInterceptAlreadyActive: undefined }), false)
})

test('T57: serverName stages and saves on a CLIENT page', async () => {
  const { scope, state } = fakeScope({ value: { role: 'client' } })
  const form = new ZenRemoteSettingsForm(scope)
  assert.equal(form.statusPoll(), 'client')
  assert.equal(form.getSnapshot().serverName.text, '')
  form.stage('serverName', '书房的台式机')
  const staged = form.getSnapshot()
  assert.equal(staged.serverName.overridden, true)
  assert.equal(staged.serverName.invalid, false)
  assert.equal(form.canSave(), true)
  assert.equal(await form.save(), true)
  assert.deepEqual(state.mutateCalls[0].ops, [{ op: 'set', path: ['serverName'], value: '书房的台式机' }])
})

test('awaitClientStatusReady resolves immediately, polls until ok, and times out via mock timers', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })

  {
    let calls = 0
    await awaitClientStatusReady(async () => { calls += 1; return { ok: true } }, 5_000, 10)
    assert.equal(calls, 1)
  }

  {
    let calls = 0
    let settled = false
    const p = awaitClientStatusReady(async () => { calls += 1; return calls < 3 ? { ok: false } : { ok: true } }, 5_000, 5)
      .then(() => { settled = true })
    while (!settled) {
      await Promise.resolve()
      await Promise.resolve()
      if (!settled) t.mock.timers.tick(5)
    }
    await p
    assert.equal(calls, 3)
  }

  {
    let calls = 0
    let settled = false
    const started = Date.now()
    const p = awaitClientStatusReady(async () => { calls += 1; throw new Error('row reloading') }, 60, 10)
      .then(() => { settled = true })
    while (!settled) {
      await Promise.resolve()
      await Promise.resolve()
      if (!settled) t.mock.timers.tick(10)
    }
    await assert.doesNotReject(p)
    assert.ok(Date.now() - started >= 60)
    assert.ok(calls >= 2)
  }
})

test('MS-6: multi-server pool parsing and canSubmitClientPairing cap gate', () => {
  const single = deriveClientStatusView({ state: 'online', serverUrl: 'http://a.local:3088', serverName: 'A-main' })
  assert.deepEqual(single.servers, [])
  assert.equal(single.maxServers, 8)
  assert.equal(single.limitReached, false)

  const two = deriveClientStatusView({
    state: 'online', serverUrl: 'http://a.local:3088', serverName: 'A-main', maxServers: 8,
    servers: [
      serverRow(),
      serverRow({ serverId: 'bbbb2222', serverUrl: 'http://b.local:3088', serverName: 'B-backup', displayName: 'B-backup', state: 'offline', nextRetryAt: 5_000 }),
    ],
  })
  assert.equal(two.servers.length, 2)
  assert.deepEqual(two.servers[0], {
    entryId: 'http://a.local:3088', serverId: 'aaaa1111', serverUrl: 'http://a.local:3088',
    serverName: 'A-main', displayName: 'A-main', state: 'connected', nextRetryAt: undefined,
    lastError: 'offline',
    compat: { mismatchedGroups: ['workspace'], recentCalls: [] },
    pluginBridge: [{ plugin: BRIDGE_STAMP_PLUGIN, localVersion: '1.0', stateKey: 'settings.bridge.stateBridged', serverVersion: undefined }],
  })
  assert.equal(two.servers[1].state, 'unreachable')
  assert.equal(two.servers[1].nextRetryAt, 5_000)
  assert.equal(two.limitReached, false)

  const full = deriveClientStatusView({
    state: 'online', maxServers: 8,
    servers: Array.from({ length: 8 }, (_, i) => serverRow({ serverId: `aaaa111${i}`, serverUrl: `http://${i}.local` })),
  })
  assert.equal(full.servers.length, 8)
  assert.equal(full.limitReached, true)
  assert.equal(deriveClientStatusView({ state: 'online', maxServers: 4, servers: [serverRow(), serverRow({ serverUrl: 'b' }), serverRow({ serverUrl: 'c' }), serverRow({ serverUrl: 'd' })] }).limitReached, true)

  const junk = deriveClientStatusView({
    state: 'online',
    servers: ['garbage', null, { entryId: 'keep', serverId: 'aaaa1111', state: 'revoked', nextRetryAt: 'soon', compat: 'x', pluginBridge: 'x' }, 42],
  })
  assert.equal(junk.servers.length, 1)
  assert.equal(junk.servers[0].entryId, 'keep')
  assert.equal(junk.servers[0].state, 'revoked')
  assert.equal(junk.servers[0].nextRetryAt, undefined)
  assert.deepEqual(junk.servers[0].compat, { mismatchedGroups: [], recentCalls: [] })
  assert.deepEqual(junk.servers[0].pluginBridge, [])
  assert.equal(deriveClientStatusView({ state: 'online', servers: [{ entryId: 'quiet', serverId: 'aaaa1111' }] }).servers[0].compat, undefined)
  assert.equal(deriveClientStatusView({ state: 'online', servers: 'garbage' }).servers.length, 0)
  assert.equal(deriveClientStatusView({ state: 'online', servers: 'garbage' }).limitReached, false)
  assert.equal(deriveClientStatusView({ state: 'online', maxServers: 'x' }).maxServers, 8)

  const one = [serverRow()]
  const eight = Array.from({ length: 8 }, (_, i) => serverRow({ serverId: `aaaa111${i}`, serverUrl: `http://${i}.local` }))
  assert.deepEqual(
    canSubmitClientPairing({ pairUrl: 'http://new.local:3088', pairCode: 'ABCD2345', servers: one }),
    { allowed: true, isOverwrite: false, blockedByLimit: false },
  )
  assert.equal(canSubmitClientPairing({ pairUrl: '', pairCode: 'ABCD2345', servers: [] }).allowed, false)
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://new.local', pairCode: '', servers: [] }).allowed, false)
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://new.local', pairCode: 'ABCD23', servers: [] }).allowed, false)
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://new.local', pairCode: normalizePairingCode('ab-23'), servers: [] }).allowed, false)
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://new.local', pairCode: 'ABCD2345', servers: [], busy: true }).allowed, false)
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://new.local', pairCode: 'ABCD2345', servers: [], deviceNameInvalid: true }).allowed, false)
  assert.deepEqual(
    canSubmitClientPairing({ pairUrl: 'http://9.local', pairCode: 'ABCD2345', servers: eight }),
    { allowed: false, isOverwrite: false, blockedByLimit: true },
  )
  assert.deepEqual(
    canSubmitClientPairing({ pairUrl: 'http://3.local', pairCode: 'ABCD2345', servers: eight }),
    { allowed: true, isOverwrite: true, blockedByLimit: false },
  )
  assert.equal(canSubmitClientPairing({ pairUrl: '  http://3.local/  ', pairCode: 'ABCD2345', servers: eight }).isOverwrite, true)
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://z.local', pairCode: 'ABCD2345', servers: one, maxServers: 1 }).blockedByLimit, true)
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://a.local:3088/', pairCode: 'ABCD2345', servers: one, maxServers: 1 }).allowed, true)
})

test('derivePeerStatusView: configured fields, capacity, sync, identityError, revokedNotice, directRttMs, and degradation', () => {
  const configured = derivePeerStatusView({
    configured: true,
    nodeId: 'abcd1234',
    gatewayState: 'authorized',
    networkId: '0123456789abcdef',
    gatewayOrigin: 'http://10.0.0.1:4088',
    maxPeers: 8,
    maxServers: 3,
    mountedCount: 7,
    peers: [
      { nodeId: 'aaaa1111', name: '书房电脑', mounted: true, path: 'lan', rttMs: 3 },
      { nodeId: 'bbbb2222', name: '客厅电脑', mounted: false, path: 'offline', rttMs: null },
    ],
  })
  assert.equal(configured.configured, true)
  assert.equal(configured.nodeId, 'abcd1234')
  assert.equal(configured.gatewayState, 'authorized')
  assert.equal(configured.networkId, '0123456789abcdef')
  assert.equal(configured.gatewayOrigin, 'http://10.0.0.1:4088')
  assert.equal(configured.maxPeers, 8)
  assert.equal(configured.maxServers, 3)
  assert.equal(configured.mountedCount, 7)
  assert.equal(configured.limitReached, true)

  const odd = derivePeerStatusView({
    configured: true,
    nodeId: 'abcd1234',
    gatewayState: 'pending-approval',
    maxPeers: 'eight',
    peers: [
      { nodeId: 'bbbb2222', name: '客厅电脑', mounted: true, path: 'warp' },
      { name: 'no id', mounted: true, path: 'lan' },
    ],
  })
  assert.equal(odd.gatewayState, 'pending-approval')
  assert.equal(odd.maxPeers, undefined)
  assert.equal(odd.peers.length, 1)
  assert.equal(odd.peers[0].path, 'offline')
  assert.equal(odd.peers[0].rttMs, null)
  assert.equal(odd.peers[0].mounted, true)
  assert.equal(derivePeerStatusView('garbage').configured, false)

  const oldBody = derivePeerStatusView({
    configured: true,
    nodeId: 'abcd1234',
    gatewayState: 'authorized',
    maxPeers: 8,
    peers: [
      { nodeId: 'aaaa1111', name: '书房电脑', mounted: true, path: 'lan', rttMs: 3 },
      { nodeId: 'bbbb2222', name: '客厅电脑', mounted: false, path: 'offline', rttMs: null },
      { nodeId: 'cccc3333', name: '断线还挂着的机器', mounted: true, path: 'none', rttMs: null },
    ],
  })
  assert.equal(oldBody.maxServers, undefined)
  assert.equal(oldBody.mountedCount, 2)
  assert.equal(oldBody.limitReached, undefined)

  const junk = derivePeerStatusView({
    maxPeers: 8,
    maxServers: 'eight',
    mountedCount: -1,
    peers: [{ nodeId: 'aaaa1111', name: '书房电脑', mounted: true, path: 'lan', rttMs: 3 }],
  })
  assert.equal(junk.maxServers, undefined)
  assert.equal(junk.mountedCount, 1)
  assert.equal(junk.limitReached, undefined)
  assert.equal(derivePeerStatusView({ maxServers: 0, peers: [] }).maxServers, undefined)
  assert.equal(derivePeerStatusView({ configured: false, maxPeers: null }).mountedCount, undefined)
  assert.equal(derivePeerStatusView({}).maxServers, undefined)

  for (const j of [1.5, 65, 0, -3, 'eight', true]) {
    const view = derivePeerStatusView({ maxServers: j, mountedCount: 2, peers: [] })
    assert.equal(view.maxServers, undefined)
    assert.equal(view.limitReached, undefined)
  }
  assert.equal(derivePeerStatusView({ maxServers: 1, peers: [] }).maxServers, 1)
  assert.equal(derivePeerStatusView({ maxServers: 64, peers: [] }).maxServers, 64)
  assert.equal(derivePeerStatusView({ maxServers: 4, mountedCount: 0.5, peers: [{ nodeId: 'aaaa1111', name: '书房电脑', mounted: true, path: 'lan', rttMs: 1 }] }).mountedCount, 1)
  assert.equal(derivePeerStatusView({ maxServers: 4, mountedCount: 2.5 }).mountedCount, undefined)

  assert.equal(derivePeerStatusView({ maxServers: 4, peers: [{ nodeId: 'aaaa1111', name: '书房电脑', mounted: true, path: 'lan', rttMs: 3 }, { nodeId: 'bbbb2222', name: '没给标志', path: 'offline', rttMs: null }] }).mountedCount, undefined)
  assert.equal(derivePeerStatusView({ maxServers: 4, peers: [{ nodeId: 'aaaa1111', name: '书房电脑', mounted: 'yes', path: 'lan', rttMs: 3 }] }).mountedCount, undefined)
  assert.equal(derivePeerStatusView({ maxServers: 4, peers: [{ nodeId: 'aaaa1111', name: '书房电脑', mounted: true, path: 'lan', rttMs: 3 }, 'garbage'] }).mountedCount, undefined)
  assert.equal(derivePeerStatusView({ maxServers: 4, peers: [] }).mountedCount, 0)
  assert.equal(derivePeerStatusView({ maxServers: 4, peers: [] }).limitReached, false)

  const syncView = derivePeerStatusView({
    configured: true, nodeId: 'abcd1234', gatewayState: 'authorized', maxPeers: 8, maxServers: 3, mountedCount: 2, peers: [],
    sync: { readyCount: 1, mountedCandidateCount: 2, candidateCount: 2, ignoredCount: 1, mismatchCount: 0 },
  })
  assert.deepEqual(syncView.sync, { readyCount: 1, mountedCandidateCount: 2, candidateCount: 2, ignoredCount: 1, mismatchCount: 0 })
  assert.equal(derivePeerStatusView({ peers: [{ nodeId: 'aaaa1111', name: '书房电脑', mounted: true, path: 'lan', rttMs: 3 }] }).sync, undefined)
  for (const j of [null, 'ready', 42, [], true]) {
    assert.equal(derivePeerStatusView({ peers: [], sync: j }).sync, undefined)
  }
  const junkSync = derivePeerStatusView({
    peers: [],
    sync: { readyCount: -1, mountedCandidateCount: 'two', candidateCount: 1.5, ignoredCount: Number.POSITIVE_INFINITY, mismatchCount: 2 },
  })
  assert.equal(junkSync.sync.readyCount, undefined)
  assert.equal(junkSync.sync.mountedCandidateCount, undefined)
  assert.equal(junkSync.sync.candidateCount, undefined)
  assert.equal(junkSync.sync.ignoredCount, undefined)
  assert.equal(junkSync.sync.mismatchCount, 2)

  const idErr = derivePeerStatusView({ configured: false, nodeId: '', gatewayState: 'identity-error', identityError: 'state-file-unreadable', peers: [] })
  assert.equal(idErr.gatewayState, 'identity-error')
  assert.equal(idErr.identityError, 'state-file-unreadable')

  const validNotice = derivePeerStatusView({
    configured: false, nodeId: 'aaaa1111', gatewayState: 'unconfigured',
    revokedNotice: { deviceName: 'MacBook', gatewayHost: 'gw.example.com:19393', networkId: '0123456789abcdef', reason: 'removed by administrator', revokedAt: 1700000000000 },
    peers: [],
  })
  assert.deepEqual(validNotice.revokedNotice, {
    deviceName: 'MacBook', gatewayHost: 'gw.example.com:19393', networkId: '0123456789abcdef', reason: 'removed by administrator', revokedAt: 1700000000000,
  })
  for (const junkNotice of [null, 'bad', [], { deviceName: '', revokedAt: 1 }, { deviceName: 'X', revokedAt: Number.NaN }, { deviceName: 'X', revokedAt: -1 }]) {
    assert.equal(derivePeerStatusView({ configured: false, revokedNotice: junkNotice, peers: [] }).revokedNotice, undefined)
  }

  const rttView = derivePeerStatusView({
    configured: true,
    peers: [
      { nodeId: 'aaaa1111', name: '慢直连', mounted: true, path: 'relay', rttMs: null, directRttMs: 3454, directDemoted: true },
      { nodeId: 'bbbb2222', name: '旧端', mounted: true, path: 'lan', rttMs: 3 },
      { nodeId: 'cccc3333', name: '怪行', mounted: false, path: 'relay', rttMs: null, directRttMs: 'fast', directDemoted: 1 },
      { nodeId: 'dddd4444', name: '负延迟', mounted: false, path: 'lan', rttMs: 1, directRttMs: -9 },
      { nodeId: 'eeee5555', name: '断直连', mounted: true, path: 'relay', rttMs: null, directRttMs: 5, directDemoted: true, directDemoteReason: 'path-lost' },
      { nodeId: 'ffff6666', name: '超上限', mounted: true, path: 'relay', rttMs: null, directRttMs: 900, directDemoted: true, directDemoteReason: 'rtt-cap' },
      { nodeId: 'abab7777', name: '怪原因', mounted: true, path: 'relay', rttMs: null, directRttMs: 9, directDemoted: true, directDemoteReason: 'bogus' },
    ],
  })
  assert.equal(rttView.peers[0].directDemoted, true)
  assert.equal(rttView.peers[0].directRttMs, 3454)
  assert.equal(rttView.peers[0].rttMs, null)
  assert.equal(rttView.peers[1].directDemoted, false)
  assert.equal(rttView.peers[1].directRttMs, null)
  assert.equal(rttView.peers[2].directDemoted, false)
  assert.equal(rttView.peers[2].directRttMs, null)
  assert.equal(rttView.peers[3].directRttMs, null)
  assert.equal(rttView.peers[0].directDemoteReason, null)
  assert.equal(isRttCapDemotion(rttView.peers[0]), true, 'old host without a reason keeps the cap note')
  assert.equal(rttView.peers[4].directDemoteReason, 'path-lost')
  assert.equal(isRttCapDemotion(rttView.peers[4]), false, 'a lost direct path never reads "over the cap"')
  assert.equal(rttView.peers[5].directDemoteReason, 'rtt-cap')
  assert.equal(isRttCapDemotion(rttView.peers[5]), true)
  assert.equal(rttView.peers[6].directDemoteReason, null, 'unknown reasons are dropped')
  assert.equal(isRttCapDemotion(rttView.peers[1]), false)
})

test('debugExportFileName stamps host / client / peer roles', () => {
  const now = new Date(2026, 10, 10, 9, 7)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  assert.equal(debugExportFileName('host', now), `zen-remote-debug-host-${stamp}.json`)
  assert.equal(debugExportFileName('client', now), `zen-remote-debug-client-${stamp}.json`)
  assert.equal(debugExportFileName('peer', now), `zen-remote-debug-peer-${stamp}.json`)
})

test('PB-5 plugin bridge UI pure helpers and consentField', () => {
  const S = (over = {}) => ({ plugin: 'test-panel', bridged: false, reason: 'offline', localVersion: '1.0.0', ...over })
  const rows = derivePluginBridgeStatuses([
    S({ bridged: true, reason: undefined }),
    S({ reason: 'not-on-server' }),
    S({ reason: 'version-mismatch', serverVersion: '2.0.0' }),
    S({ reason: 'declaration-mismatch' }),
    S({ reason: 'consent-off' }),
    S({ reason: 'offline' }),
    S({ reason: 'server-too-old' }),
  ])
  assert.deepEqual(rows.map((row) => row.stateKey), [
    'settings.bridge.stateBridged',
    'settings.bridge.stateNotOnServer',
    'settings.bridge.stateVersionMismatch',
    'settings.bridge.stateDeclarationMismatch',
    'settings.bridge.stateConsentOff',
    'settings.bridge.stateOffline',
    'settings.bridge.stateServerTooOld',
  ])
  assert.equal(rows[0].plugin, 'test-panel')
  assert.equal(rows[0].localVersion, '1.0.0')
  assert.equal(rows[2].serverVersion, '2.0.0')

  const degraded = derivePluginBridgeStatuses([S({ reason: 'some-future-reason' }), S({ bridged: true, reason: 'offline' }), null, 42, { noPlugin: true }])
  assert.deepEqual(degraded.map((row) => row.stateKey), ['settings.bridge.stateOffline', 'settings.bridge.stateBridged'])
  assert.deepEqual(derivePluginBridgeStatuses(undefined), [])
  assert.deepEqual(derivePluginBridgeStatuses('x'), [])
  assert.deepEqual(derivePluginBridgeStatuses(42), [])

  const current = { 'old-plugin': true, 'another': false, 'gone-plugin': true }
  const next = togglePluginConsent(current, 'new-plugin', true)
  assert.deepEqual(next, { 'old-plugin': true, another: false, 'gone-plugin': true, 'new-plugin': true })
  assert.deepEqual(current, { 'old-plugin': true, 'another': false, 'gone-plugin': true })
  assert.deepEqual(togglePluginConsent(next, 'new-plugin', false), { 'old-plugin': true, another: false, 'gone-plugin': true, 'new-plugin': false })
  for (const bad of [undefined, null, 'x', 42, [], { plugin: 'yes' }]) {
    assert.deepEqual(togglePluginConsent(bad, 'p', true), { p: true })
  }

  assert.equal(bridgeSectionState('loading', []), 'loading')
  assert.equal(bridgeSectionState('error', []), 'error')
  assert.equal(bridgeSectionState('ready', []), 'empty')
  assert.equal(bridgeSectionState('ready', [{ plugin: 'p' }]), 'plugins')

  const spec = consentField('pluginBridgeConsent')
  assert.equal(spec.field, 'pluginBridgeConsent')
  const map = { a: true, b: false }
  assert.deepEqual(spec.parse(spec.format(map)), { kind: 'set', value: map })
  assert.equal(spec.format('junk'), '{}')
  assert.equal(spec.format(null), '{}')
  assert.equal(spec.format(['x']), '{}')
  assert.equal(spec.format({ a: 'yes' }), '{}')
  for (const bad of ['', 'not json', '"string"', '42', '[]', 'null', '{"a":"yes"}', '{"a":1}']) {
    assert.equal(spec.parse(bad), undefined)
  }

  assert.ok(SETTINGS_FIELDS.some((entry) => entry.field === 'pluginBridgeConsent'))
  const sharedSpec = SETTINGS_FIELDS.find((entry) => entry.field === 'pluginBridgeConsent')
  const toggled = togglePluginConsent({ old: true }, 'new-plugin', true)
  assert.deepEqual(sharedSpec.parse(JSON.stringify(toggled)), { kind: 'set', value: { old: true, 'new-plugin': true } })
  assert.equal(JSON.stringify(toggled) === sharedSpec.format(toggled), true)

  assert.deepEqual(
    readAdminBridgeRow({ plugin: 'p', version: '1.0.0', hasServerScope: true, consent: false, adapted: true }),
    { plugin: 'p', version: '1.0.0', hasServerScope: true, consent: false, adapted: true },
  )
  assert.equal(readAdminBridgeRow({ plugin: 'p', version: '1', hasServerScope: false, consent: true }).adapted, false)
  assert.equal(readAdminBridgeRow({ plugin: 'p', version: '1', hasServerScope: false, consent: true, adapted: 'yes' }).adapted, false)
  for (const bad of [undefined, null, 42, 'x', [], {}, { version: '1' }]) {
    assert.equal(readAdminBridgeRow(bad), undefined)
  }
})

test('hideInactiveRemoteWorkspaces defaults to true in client mode and writes false cleanly on toggle', async () => {
  let savedOps = null
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: { role: 'client' },
      base: {},
      user: { role: 'client' },
      revision: 1,
      writable: true,
    }),
    subscribe: () => () => {},
    mutate: async (ops) => {
      savedOps = ops
      return true
    },
  }
  const ctrl = new ZenRemoteSettingsForm(scope)
  assert.equal(ctrl.getSnapshot().hideInactiveRemoteWorkspaces.text, 'true')
  assert.equal(ctrl.getSnapshot().dirty, false)

  ctrl.stage('hideInactiveRemoteWorkspaces', 'false')
  assert.equal(ctrl.getSnapshot().dirty, true)
  assert.equal(ctrl.getSnapshot().restartPending, false)
  const landed = await ctrl.save()
  assert.equal(landed, true)
  assert.deepEqual(savedOps, [{ op: 'set', path: ['hideInactiveRemoteWorkspaces'], value: false }])
})

test('T6 derivePeerStatusView: parses versionSync tolerantly and ignores absent/malformed blocks', () => {
  const withoutVersionSync = derivePeerStatusView({
    configured: true,
    nodeId: 'aaaa1111',
    gatewayState: 'authorized',
    peers: [],
  })
  assert.equal(withoutVersionSync.versionSync, undefined)

  const withVersionSync = derivePeerStatusView({
    configured: true,
    nodeId: 'aaaa1111',
    gatewayState: 'authorized',
    peers: [],
    versionSync: {
      pluginVersion: '2.5.1',
      gatewayVersion: '0.1.0',
      recommendedGatewayVersion: '0.2.0',
      wireCompatLevel: 1,
      gatewayOutdated: true,
      pluginOutdated: true,
      newerPluginVersion: '2.6.0',
      inferredLegacyGateway: true,
      gatewayConsoleUrl: 'https://gw.example.com:19393',
    },
  })
  assert.deepEqual(withVersionSync.versionSync, {
    pluginVersion: '2.5.1',
    gatewayVersion: '0.1.0',
    recommendedGatewayVersion: '0.2.0',
    wireCompatLevel: 1,
    gatewayOutdated: true,
    pluginOutdated: true,
    newerPluginVersion: '2.6.0',
    inferredLegacyGateway: true,
    gatewayConsoleUrl: 'https://gw.example.com:19393',
  })

  for (const junk of [null, 'bad', [], 42, { gatewayOutdated: 'yes' }]) {
    assert.equal(
      derivePeerStatusView({ configured: true, peers: [], versionSync: junk }).versionSync,
      undefined,
    )
  }
})
