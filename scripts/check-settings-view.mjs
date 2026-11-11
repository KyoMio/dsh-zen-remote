// Behaviour check for the MS-6 browser data layer — the multi-server view
// pieces across src/client-data/{settings-form,wizard,remote-status}.ts,
// driven against the REAL bodies src/client-routes.ts answers since MS-5:
//
// - `client/status` carries `servers: ClientServerStatusItem[]` (one row per
//   paired pool entry) plus `maxServers` and the FIRST entry's top-level
//   compatibility fields;
// - `remote-status` carries `servers: Record<serverId, …>` keyed by the
//   handshake serverId plus the FIRST entry's top-level mirror;
// - the pairing gate judges "new address at the cap" against "existing
//   address overwrite" (the cap never blocks a re-pair).
//
// Run: node scripts/check-settings-view.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import {
  canSubmitClientPairing,
  CLIENT_PEER_JOIN_ROUTE,
  CLIENT_PEER_LEAVE_ROUTE,
  CLIENT_PEER_REPROBE_ROUTE,
  CLIENT_PEER_STATUS_ROUTE,
  CLIENT_PEER_TOGGLE_MOUNT_ROUTE,
  CLIENT_PEER_TRUST_ROUTE,
  CLIENT_UNPAIR_ROUTE,
  deriveClientStatusView,
  derivePeerStatusView,
  debugExportFileName,
  MAX_PAIRED_SERVERS,
  normalizePairingCode,
  savedRowRole,
  settingsPollOf,
  settingsRoleOf,
} from '../src/client-data/settings-form.ts'
import { deriveClientOverviewSummary, derivePeerOverviewSummary, isWizardConfigured } from '../src/client-data/wizard.ts'
import {
  bannerText,
  BRIDGE_STAMP_PLUGIN,
  describeRemoteStatus,
  parseRemoteStatusBody,
  resolveServerStatusView,
  shouldStampBridgeForSession,
} from '../src/client-data/remote-status.ts'

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

const t = (key) => `#${key}`

/** One paired-server row exactly as client-routes.ts's poolStatusBodyOf
 * serves it (no token anywhere). */
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

await test('the MS-6 constants name the cap and the unpair route', () => {
  assert.equal(MAX_PAIRED_SERVERS, 8)
  assert.equal(CLIENT_UNPAIR_ROUTE, '/_dsh/zen-remote/client/unpair')
})

await test('deriveClientStatusView parses the pool list: 0 … 8 rows, limitReached only at the cap', () => {
  // An old single-server body (no servers field): empty list, default cap.
  const single = deriveClientStatusView({ state: 'online', serverUrl: 'http://a.local:3088', serverName: 'A-main' })
  assert.deepEqual(single.servers, [])
  assert.equal(single.maxServers, 8)
  assert.equal(single.limitReached, false)

  // A real pool answer: rows ride through, top-level compat still parses.
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
  assert.equal(two.servers[1].state, 'unreachable', 'the wire offline word maps like the top level does')
  assert.equal(two.servers[1].nextRetryAt, 5_000)
  assert.equal(two.limitReached, false)

  // Eight rows: the cap is reached.
  const full = deriveClientStatusView({
    state: 'online', maxServers: 8,
    servers: Array.from({ length: 8 }, (_, i) => serverRow({ serverId: `aaaa111${i}`, serverUrl: `http://${i}.local` })),
  })
  assert.equal(full.servers.length, 8)
  assert.equal(full.maxServers, 8)
  assert.equal(full.limitReached, true)

  // The body's own maxServers decides when it carries one.
  assert.equal(deriveClientStatusView({ state: 'online', maxServers: 4, servers: [serverRow(), serverRow({ serverUrl: 'b' }), serverRow({ serverUrl: 'c' }), serverRow({ serverUrl: 'd' })] }).limitReached, true)

  // Garbage degrades: junk rows drop, junk fields default. A PRESENT but
  // garbage compat still renders the empty group (the presence gate, like
  // the top level); only an absent one stays undefined.
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
})

await test('canSubmitClientPairing: new addresses respect the cap, existing ones overwrite through it', () => {
  const one = [serverRow()]
  const eight = Array.from({ length: 8 }, (_, i) => serverRow({ serverId: `aaaa111${i}`, serverUrl: `http://${i}.local` }))

  // A clean new pairing under the cap.
  assert.deepEqual(
    canSubmitClientPairing({ pairUrl: 'http://new.local:3088', pairCode: 'ABCD2345', servers: one }),
    { allowed: true, isOverwrite: false, blockedByLimit: false },
  )

  // Refusals that have nothing to do with the cap.
  assert.equal(canSubmitClientPairing({ pairUrl: '', pairCode: 'ABCD2345', servers: [] }).allowed, false, 'no address, no pairing')
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://new.local', pairCode: '', servers: [] }).allowed, false, 'no code, no pairing')
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://new.local', pairCode: 'ABCD23', servers: [] }).allowed, false, 'a partial code is not a code')
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://new.local', pairCode: normalizePairingCode('ab-23'), servers: [] }).allowed, false)
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://new.local', pairCode: 'ABCD2345', servers: [], busy: true }).allowed, false, 'a claim in flight blocks a second')
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://new.local', pairCode: 'ABCD2345', servers: [], deviceNameInvalid: true }).allowed, false, 'an invalid device name blocks the claim (T60)')

  // The cap blocks only NEW addresses.
  assert.deepEqual(
    canSubmitClientPairing({ pairUrl: 'http://9.local', pairCode: 'ABCD2345', servers: eight }),
    { allowed: false, isOverwrite: false, blockedByLimit: true },
    'a ninth new address is refused at 8/8',
  )
  // Overwrite: the SAME (normalized) address pairs straight through the cap.
  assert.deepEqual(
    canSubmitClientPairing({ pairUrl: 'http://3.local', pairCode: 'ABCD2345', servers: eight }),
    { allowed: true, isOverwrite: true, blockedByLimit: false },
    'an existing address re-pairs even at 8/8',
  )
  // Trailing slashes and padding do not make a new address.
  assert.equal(canSubmitClientPairing({ pairUrl: '  http://3.local/  ', pairCode: 'ABCD2345', servers: eight }).isOverwrite, true)
  // An explicit maxServers decides like the body's does.
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://z.local', pairCode: 'ABCD2345', servers: one, maxServers: 1 }).blockedByLimit, true)
  assert.equal(canSubmitClientPairing({ pairUrl: 'http://a.local:3088/', pairCode: 'ABCD2345', servers: one, maxServers: 1 }).allowed, true)
})

await test('isWizardConfigured: pairedServerCount > 0 alone configures the overview', () => {
  const nothingElse = {
    effectiveClient: true,
    wizardStatus: undefined,
    pairedDeviceCount: 0,
    hasSavedHostConfig: false,
    tokenConfigured: false,
    clientServerUrl: '',
    clientState: undefined,
  }
  assert.equal(isWizardConfigured({ ...nothingElse, pairedServerCount: 2 }), true)
  assert.equal(isWizardConfigured({ ...nothingElse, pairedServerCount: 0 }), false)
  // Omitted keeps the pre-MS-6 verdict.
  assert.equal(isWizardConfigured({ ...nothingElse }), false)
})

await test('deriveClientOverviewSummary: counts, cap and the two lights', () => {
  // The summary consumes the DERIVED view list — the view vocabulary's state
  // words (connected / unreachable / revoked), not the wire's.
  const row = (state, url) => serverRow({ state, serverUrl: url, entryId: url })
  // Empty pool.
  assert.deepEqual(deriveClientOverviewSummary([]), {
    totalCount: 0, onlineCount: 0, offlineCount: 0, revokedCount: 0,
    maxServers: 8, limitReached: false, connectionLight: 'pending', serversLight: 'pending',
  })
  // All connected: both green.
  assert.deepEqual(deriveClientOverviewSummary([row('connected', 'a'), row('connected', 'b')]), {
    totalCount: 2, onlineCount: 2, offlineCount: 0, revokedCount: 0,
    maxServers: 8, limitReached: false, connectionLight: 'pass', serversLight: 'pass',
  })
  // Mixed: offline stays amber unless a dead verdict rides along.
  const mixed = deriveClientOverviewSummary([row('connected', 'a'), row('unreachable', 'b'), row('revoked', 'c')])
  assert.equal(mixed.onlineCount, 1)
  assert.equal(mixed.offlineCount, 1)
  assert.equal(mixed.revokedCount, 1)
  assert.equal(mixed.connectionLight, 'fail')
  assert.equal(deriveClientOverviewSummary([row('connected', 'a'), row('unreachable', 'b')]).connectionLight, 'pending')
  // The 8/8 cap is a servers fact: red servers light, green connection light.
  const full = deriveClientOverviewSummary(Array.from({ length: 8 }, (_, i) => row('connected', `s${i}`)))
  assert.equal(full.limitReached, true)
  assert.equal(full.serversLight, 'fail')
  assert.equal(full.connectionLight, 'pass')
  // Seven of eight is under the cap.
  assert.equal(deriveClientOverviewSummary(Array.from({ length: 7 }, (_, i) => row('connected', `s${i}`))).limitReached, false)
  // An explicit maxServers.
  assert.equal(deriveClientOverviewSummary([row('connected', 'a')], 1).limitReached, true)
})

await test('remote-status per-server acceptance: A online / B offline through the icon and banner', () => {
  const view = parseRemoteStatusBody({
    state: 'online', versionMismatch: false, serverName: 'A-main', closed: {},
    bridgedPlugins: [BRIDGE_STAMP_PLUGIN],
    servers: {
      aaaa1111: { state: 'online', versionMismatch: false, serverName: 'A-main', bridgedPlugins: [BRIDGE_STAMP_PLUGIN] },
      bbbb2222: { state: 'offline', versionMismatch: false, serverName: 'B-backup', bridgedPlugins: [] },
    },
  }, 1)

  // The icon: A lit, B grey.
  assert.deepEqual(describeRemoteStatus(view, t, 'zr~aaaa1111~s1'), { state: 'online', hoverText: '#remoteStatusOnline' })
  assert.deepEqual(describeRemoteStatus(view, t, 'zr~bbbb2222~s2'), { state: 'offline', hoverText: '#remoteStatusOffline' })
  // The banner: A clean, B temporarily readonly.
  assert.equal(bannerText(view, 'zr~aaaa1111~s1', t), undefined)
  assert.equal(bannerText(view, 'zr~bbbb2222~s2', t), '#remoteBannerOffline')
  // The resolve seam the parts share: per-server entry, top-level fallback.
  assert.equal(resolveServerStatusView(view, 'zr~aaaa1111~s1'), view.servers.aaaa1111)
  assert.equal(resolveServerStatusView(view, 'zr~cccc3333~x'), view)
})

await test('remote-status per-server acceptance: the bridge stamp follows the session\u2019s server', () => {
  const view = parseRemoteStatusBody({
    state: 'online', versionMismatch: false, serverName: 'A-main', closed: {},
    bridgedPlugins: [BRIDGE_STAMP_PLUGIN],
    servers: {
      aaaa1111: { state: 'online', versionMismatch: false, serverName: 'A-main', bridgedPlugins: [BRIDGE_STAMP_PLUGIN] },
      bbbb2222: { state: 'offline', versionMismatch: false, serverName: 'B-backup', bridgedPlugins: [] },
    },
  }, 1)
  assert.equal(shouldStampBridgeForSession(view, 'zr~aaaa1111~s1', BRIDGE_STAMP_PLUGIN), true)
  assert.equal(shouldStampBridgeForSession(view, 'zr~bbbb2222~s2', BRIDGE_STAMP_PLUGIN), false)
})

// ---------------------------------------------------------------------------
// PG-9: the peer node's browser data layer — the peer/status body view, the
// three-valued role decision (host / client / peer), and the network-device
// summary's cap judgment as the settings page renders it.
// ---------------------------------------------------------------------------

await test('the PG-9 route constants name the six peer management paths', () => {
  assert.equal(CLIENT_PEER_STATUS_ROUTE, '/_dsh/zen-remote/client/peer/status')
  assert.equal(CLIENT_PEER_JOIN_ROUTE, '/_dsh/zen-remote/client/peer/join')
  assert.equal(CLIENT_PEER_LEAVE_ROUTE, '/_dsh/zen-remote/client/peer/leave')
  assert.equal(CLIENT_PEER_TOGGLE_MOUNT_ROUTE, '/_dsh/zen-remote/client/peer/toggle-mount')
  assert.equal(CLIENT_PEER_TRUST_ROUTE, '/_dsh/zen-remote/client/peer/trust')
  assert.equal(CLIENT_PEER_REPROBE_ROUTE, '/_dsh/zen-remote/client/peer/reprobe')
})

await test('derivePeerStatusView parses the peer/status body: configured, gateway facts and the device rows', () => {
  const view = derivePeerStatusView({
    configured: true,
    nodeId: 'abcd1234',
    gatewayState: 'authorized',
    networkId: '0123456789abcdef',
    gatewayOrigin: 'http://10.0.0.1:4088',
    maxPeers: 8,
    peers: [
      { nodeId: 'aaaa1111', name: '书房电脑', mounted: true, path: 'lan', rttMs: 3 },
      { nodeId: 'cccc3333', name: '换了钥的机器', mounted: false, path: 'mismatch', rttMs: null },
      'garbage',
      null,
    ],
  })
  assert.equal(view.configured, true)
  assert.equal(view.nodeId, 'abcd1234')
  assert.equal(view.gatewayState, 'authorized')
  assert.equal(view.networkId, '0123456789abcdef')
  assert.equal(view.gatewayOrigin, 'http://10.0.0.1:4088')
  assert.equal(view.maxPeers, 8)
  assert.equal(view.peers.length, 2, 'junk rows drop whole')
  assert.deepEqual(view.peers[0], { nodeId: 'aaaa1111', name: '书房电脑', mounted: true, path: 'lan', rttMs: 3 })
  assert.deepEqual(view.peers[1], { nodeId: 'cccc3333', name: '换了钥的机器', mounted: false, path: 'mismatch', rttMs: null })
})

await test('derivePeerStatusView degrades tolerantly: junk bodies, unknown states, missing numbers', () => {
  // A pre-peer answer (or a plain-client 503 JSON): nothing configured.
  const empty = derivePeerStatusView({})
  assert.equal(empty.configured, false)
  assert.equal(empty.nodeId, '')
  assert.equal(empty.gatewayState, 'unconfigured')
  assert.equal(empty.networkId, undefined)
  assert.equal(empty.gatewayOrigin, undefined)
  assert.equal(empty.maxPeers, undefined)
  assert.deepEqual(empty.peers, [])
  // Total garbage degrades the same way — never throws into the page.
  const junk = derivePeerStatusView('garbage')
  assert.equal(junk.configured, false)
  assert.deepEqual(junk.peers, [])
  // A row with an unknown path degrades to offline; a missing rtt reads null;
  // a row without a nodeId drops whole; junk numbers fall back.
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
})

await test('the role decision reads peer: savedRowRole, settingsRoleOf and the admin poll choice', () => {
  // The saved row document decides first.
  assert.equal(savedRowRole({ value: { role: 'peer' }, user: {} }), 'peer')
  assert.equal(savedRowRole({ value: {}, user: { role: 'peer' } }), 'peer')
  // The client-config probe fills a silent row with peer too.
  assert.equal(settingsRoleOf('ready', { value: {}, user: {} }, 'peer'), 'peer')
  assert.equal(settingsPollOf('ready', { value: {}, user: {} }, 'peer'), 'admin', 'a peer serves its own admin routes — the PWA half polls admin/status')
  assert.equal(settingsPollOf('ready', { value: { role: 'peer' } }), 'admin')
  // Client and host verdicts are untouched.
  assert.equal(savedRowRole({ value: { role: 'client' }, user: {} }), 'client')
  assert.equal(savedRowRole({ value: { role: 'host' }, user: {} }), 'host')
  assert.equal(settingsPollOf('ready', { value: { role: 'client' } }), 'client')
  // An exact-match-only guard survives.
  assert.equal(savedRowRole({ value: { role: 'Peer' }, user: {} }), undefined)
})

await test('the peer network-device summary: the settings page sees the same cap-red judgment', () => {
  const row = (path, over = {}) => ({
    nodeId: over.nodeId ?? 'aaaa1111', name: over.name ?? '书房电脑',
    mounted: over.mounted ?? true, path, rttMs: over.rttMs ?? 3,
    ...over,
  })
  // 8 / 8: the counter's red word rides with limitReached + the red device light.
  const full = derivePeerOverviewSummary(Array.from({ length: 8 }, (_, i) => row('lan', { nodeId: `node${i}` })), 8)
  assert.equal(full.totalCount, 8)
  assert.equal(full.maxPeers, 8)
  assert.equal(full.limitReached, true)
  assert.equal(full.devicesLight, 'fail')
  // 3 / 8 healthy: green lights, direct/relay split for the 直连/中转 tile.
  const part = derivePeerOverviewSummary([row('lan', { nodeId: 'a' }), row('p2p', { nodeId: 'b' }), row('relay', { nodeId: 'c' })], 8)
  assert.deepEqual(
    { total: part.totalCount, direct: part.directCount, relay: part.relayCount, limit: part.limitReached, devices: part.devicesLight },
    { total: 3, direct: 2, relay: 1, limit: false, devices: 'pass' },
  )
})

await test('debugExportFileName stamps the peer role into the diagnostic export name (PG-9-fix)', () => {
  const now = new Date(2026, 10, 10, 9, 7)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  assert.equal(debugExportFileName('host', now), `zen-remote-debug-host-${stamp}.json`)
  assert.equal(debugExportFileName('client', now), `zen-remote-debug-client-${stamp}.json`)
  assert.equal(debugExportFileName('peer', now), `zen-remote-debug-peer-${stamp}.json`, 'a peer node must not export under the host name')
})

console.log('check-settings-view: ok')
