// Behaviour check for the gateway-wizard UI pure pieces (GW-10), driven
// against the REAL client-data modules (Node >= 23.6 type stripping, no
// build needed):
//
// - the step state machine: initialStep, configureReadiness (every path ×
//   every refusal), publicUrlFrom, hostname/port validation, the pairing
//   countdown, and the three verification lights;
// - the locale dictionaries: zh/en key sets identical, and EVERY wizard key
//   the components use is present (the literal list below is the contract);
// - the snippet templates: client-data/wizard.ts (browser mirror) vs the
//   host's BUILT lib/wizard/proxy-snippets.js — byte-identical on shared
//   input, so the two cannot drift (the built lib because the src half
//   transitively imports node builtins through config.js, which Node's
//   strip-only loader cannot map; pnpm test runs after the build anyway);
// - the QR encoder at DECODER level: structural checks, format-info BCH,
//   Reed–Solomon syndromes all-zero, and full data recovery — stronger
//   than comparing against a memorized reference matrix.
//
// Run: node scripts/check-wizard-ui.mjs
import assert from 'node:assert/strict'
import {
  caddyFailureCopy,
  configureReadiness,
  tunnelCheckCopy,
  tunnelFailureCopy,
  caddySnippetText,
  deriveClientServerLights,
  deriveClientWizardLights,
  derivePeerDiscoveryLight,
  derivePeerOverviewSummary,
  derivePeerWizardLights,
  deriveWizardLights,
  formSeedOf,
  WIZARD_CF_TOKEN_ROUTE,
  WIZARD_CADDY_START_ROUTE,
  WIZARD_CADDY_STATUS_ROUTE,
  WIZARD_CADDY_STOP_ROUTE,
  WIZARD_TUNNEL_CHECK_ROUTE,
  WIZARD_TUNNEL_SETUP_ROUTE,
  WIZARD_TUNNEL_STATUS_ROUTE,
  WIZARD_TUNNEL_STOP_ROUTE,
  WIZARD_TUNNEL_TOKEN_ROUTE,
  assemblePeerInviteUri,
  initialStep,
  isWizardConfigured,
  isValidHostname,
  isValidPort,
  luckyStepTexts,
  nginxSnippetText,
  pairingSecondsLeft,
  publicUrlFrom,
  targetHostSaveRole,
  upstreamPortOf,
} from '../src/client-data/wizard.ts'
import { luckySteps, nginxSnippet, caddySnippet } from '../lib/wizard/proxy-snippets.js'
import { parseInviteUri, parseGatewayJoinInput } from '../src/peer/crypto.ts'
import { qrMatrix } from '../src/client-data/qr.ts'
import {
  WIZARD_CF_TOKEN_ROUTE as HOST_CF_TOKEN_ROUTE,
  WIZARD_CADDY_START_ROUTE as HOST_CADDY_START_ROUTE,
  WIZARD_CADDY_STOP_ROUTE as HOST_CADDY_STOP_ROUTE,
  WIZARD_CADDY_STATUS_ROUTE as HOST_CADDY_STATUS_ROUTE,
  WIZARD_TUNNEL_TOKEN_ROUTE as HOST_TUNNEL_TOKEN_ROUTE,
  WIZARD_TUNNEL_CHECK_ROUTE as HOST_TUNNEL_CHECK_ROUTE,
  WIZARD_TUNNEL_SETUP_ROUTE as HOST_TUNNEL_SETUP_ROUTE,
  WIZARD_TUNNEL_STATUS_ROUTE as HOST_TUNNEL_STATUS_ROUTE,
  WIZARD_TUNNEL_STOP_ROUTE as HOST_TUNNEL_STOP_ROUTE,
} from '../lib/wizard/routes.js'

import { en, zh } from '../src/client/locales.ts'
import { registerGatewayWizard, WIZARD_BUNDLE_KEY } from '../src/client/wizard/register-wizard.ts'

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

// ---- the step state machine -------------------------------------------------

await test('initialStep: a configured ingress opens on verify, off opens on pick', () => {
  assert.equal(initialStep(undefined), 'pick')
  assert.equal(initialStep({ ok: true, mode: 'off' }), 'pick')
  for (const mode of ['caddy', 'external', 'cloudflared']) {
    assert.equal(initialStep({ ok: true, mode }), 'verify')
  }
})

await test('isWizardConfigured: distinguishes fresh install from configured host or client', () => {
  const baseWizardStatus = {
    ok: true, mode: 'off', domain: '', httpsPort: 443, publicUrl: '',
    cfTokenConfigured: false, tunnelTokenConfigured: false, caddyRunning: false,
    cloudflaredRunning: false, gatewayActualPort: 3088,
    lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null,
  }
  assert.equal(
    isWizardConfigured({
      effectiveClient: false,
      wizardStatus: baseWizardStatus,
      pairedDeviceCount: 0,
      hasSavedHostConfig: false,
      tokenConfigured: false,
      clientServerUrl: '',
      clientState: undefined,
    }),
    false,
  )
  assert.equal(
    isWizardConfigured({
      effectiveClient: false,
      wizardStatus: { ...baseWizardStatus, mode: 'external', publicUrl: 'https://dsh.example.com' },
      pairedDeviceCount: 0,
      hasSavedHostConfig: false,
      tokenConfigured: false,
      clientServerUrl: '',
      clientState: undefined,
    }),
    true,
  )
  assert.equal(
    isWizardConfigured({
      effectiveClient: false,
      wizardStatus: baseWizardStatus,
      pairedDeviceCount: 1,
      hasSavedHostConfig: false,
      tokenConfigured: false,
      clientServerUrl: '',
      clientState: undefined,
    }),
    true,
  )
  assert.equal(
    isWizardConfigured({
      effectiveClient: false,
      wizardStatus: baseWizardStatus,
      pairedDeviceCount: 0,
      hasSavedHostConfig: true,
      tokenConfigured: false,
      clientServerUrl: '',
      clientState: undefined,
    }),
    true,
  )
  assert.equal(
    isWizardConfigured({
      effectiveClient: true,
      wizardStatus: undefined,
      pairedDeviceCount: 0,
      hasSavedHostConfig: false,
      tokenConfigured: false,
      clientServerUrl: '',
      clientState: undefined,
    }),
    false,
  )
  assert.equal(
    isWizardConfigured({
      effectiveClient: true,
      wizardStatus: undefined,
      pairedDeviceCount: 0,
      hasSavedHostConfig: false,
      tokenConfigured: true,
      clientServerUrl: 'https://dsh.example.com',
      clientState: 'connected',
    }),
    true,
  )
})

await test('hostname/port validation mirrors the row layer', () => {
  for (const ok of ['dsh.example.com', 'mybox', '192.168.1.10', 'a-b.cd']) {
    assert.equal(isValidHostname(ok), true, ok)
  }
  for (const bad of ['https://x', 'x/y', 'a b', 'a\nb', 'x{}', 'x:443', '-x', 'x-', '']) {
    assert.equal(isValidHostname(bad), false, bad)
  }
  assert.equal(isValidPort('443'), true)
  assert.equal(isValidPort('1'), true)
  assert.equal(isValidPort('65535'), true)
  for (const bad of ['0', '65536', '-1', '4.5', 'abc', '', '0443 ']) {
    assert.equal(isValidPort(bad), false, bad)
  }
  assert.equal(publicUrlFrom('dsh.example.com', 443), 'https://dsh.example.com')
  assert.equal(publicUrlFrom('dsh.example.com', 8443), 'https://dsh.example.com:8443')
})

await test('configureReadiness: each path demands its own fields', () => {
  const caddy = { path: 'caddy', form: { domain: 'dsh.example.com', httpsPort: '8443', cfToken: 'tok', serverUrl: '' } }
  assert.deepEqual(configureReadiness(caddy.path, caddy.form), { ok: true, publicUrl: 'https://dsh.example.com:8443', httpsPort: 8443 })
  assert.equal(configureReadiness('caddy', { ...caddy.form, cfToken: '  ' }).error, 'missing-token')
  assert.equal(configureReadiness('cloudflared', { ...caddy.form, cfToken: '' }).error, 'missing-token')
  assert.equal(configureReadiness('caddy', { ...caddy.form, domain: 'a b' }).error, 'bad-domain')
  assert.equal(configureReadiness('caddy', { ...caddy.form, httpsPort: '0' }).error, 'bad-port')
  // external: the public origin is the whole form.
  assert.deepEqual(
    configureReadiness('external', { domain: '', httpsPort: '', cfToken: '', serverUrl: 'https://dsh.example.com/' }),
    { ok: true, publicUrl: 'https://dsh.example.com', httpsPort: 443 },
  )
  assert.equal(configureReadiness('external', { domain: '', httpsPort: '', cfToken: '', serverUrl: 'http://dsh.example.com' }).error, 'bad-server-url')
  assert.equal(configureReadiness('external', { domain: '', httpsPort: '', cfToken: '', serverUrl: 'https://x/app' }).error, 'bad-server-url')
  assert.equal(configureReadiness('external', { domain: '', httpsPort: '', cfToken: '', serverUrl: 'not a url' }).error, 'bad-server-url')
  // lan: empty serverUrl is valid (LAN/Tailscale direct without public URL), or http/https origin.
  assert.deepEqual(
    configureReadiness('lan', { domain: '', httpsPort: '', cfToken: '', serverUrl: '' }),
    { ok: true, publicUrl: '', httpsPort: 443 },
  )
  assert.deepEqual(
    configureReadiness('lan', { domain: '', httpsPort: '', cfToken: '', serverUrl: 'http://192.168.1.10:3088/' }),
    { ok: true, publicUrl: 'http://192.168.1.10:3088', httpsPort: 443 },
  )
  assert.equal(configureReadiness('lan', { domain: '', httpsPort: '', cfToken: '', serverUrl: 'ftp://192.168.1.10' }).error, 'bad-server-url')
})

await test('deriveClientWizardLights: reflects token and client connection state', () => {
  assert.deepEqual(
    deriveClientWizardLights({ tokenConfigured: false, clientState: undefined }),
    { credential: 'pending', connection: 'pending', sync: 'pending' },
  )
  assert.deepEqual(
    deriveClientWizardLights({ tokenConfigured: true, clientState: 'connected' }),
    { credential: 'pass', connection: 'pass', sync: 'pass' },
  )
  assert.deepEqual(
    deriveClientWizardLights({ tokenConfigured: false, clientState: 'revoked' }),
    { credential: 'fail', connection: 'fail', sync: 'pending' },
  )
  assert.deepEqual(
    deriveClientWizardLights({ tokenConfigured: true, clientState: 'unreachable' }),
    { credential: 'pass', connection: 'fail', sync: 'pending' },
  )
})

await test('derivePeerDiscoveryLight: the third light rides the sync facts (PC-14a)', () => {
  const light = (gatewayState, sync, mismatchCount = 0) =>
    derivePeerDiscoveryLight({ gatewayState, mismatchCount, ...(sync !== undefined ? { sync } : {}) })

  // ready + authorized → pass; the copy says the handshakes COMPLETED and
  // syncing MAY START — never that any session data has finished syncing.
  assert.deepEqual(light('authorized', { state: 'ready', reason: 'ok' }), { light: 'pass', copyKey: 'wizard.peer.syncReady' })
  // A ready word under a non-authorized gateway must NOT pass: the admission
  // fact gates the verdict (no cached-online bypass).
  assert.equal(light('offline', { state: 'ready', reason: 'ok' }).light, 'pending', 'ready under a dead gateway stays pending')
  assert.equal(light('revoked', { state: 'ready', reason: 'ok' }).light, 'pending', 'ready under revoked stays pending')
  // partial → pending; KNOWN counts ride the copy as params, unknown counts
  // never guess 0 (they degrade to the plain unknown copy).
  assert.deepEqual(
    light('authorized', { state: 'partial', reason: 'peers-partial', readyCount: 1, candidateCount: 2 }),
    { light: 'pending', copyKey: 'wizard.peer.syncPartialReady', copyParams: { ready: '1', total: '2' } },
  )
  assert.equal(light('authorized', { state: 'partial', reason: 'peers-partial' }).copyKey, 'wizard.peer.syncUnknown', 'unknown partial counts stay unknown')
  // waiting-peers / ignored → pending with their own copy.
  assert.equal(light('authorized', { state: 'waiting-peers', reason: 'waiting-peers' }).copyKey, 'wizard.peer.syncWaitingPeers')
  assert.equal(light('authorized', { state: 'ignored', reason: 'ignored' }).copyKey, 'wizard.peer.syncIgnored')
  // blocked (a local TOFU anomaly) and a locally known mismatch → fail.
  assert.deepEqual(light('authorized', { state: 'blocked', reason: 'identity-mismatch', readyCount: 1, candidateCount: 1 }), { light: 'fail', copyKey: 'wizard.peer.syncBlocked' })
  assert.equal(light('authorized', { state: 'ready', reason: 'ok' }, 1).light, 'fail', 'a local mismatch fails the light even against a ready word')
  // not-ready → the reason's own copy; unmounted is the NEUTRAL word (fix1:
  // no capacity claim), gateway words fold into the network-not-ready copy.
  assert.equal(light('authorized', { state: 'not-ready', reason: 'peers-not-mounted', candidateCount: 2, unmountedCount: 2 }).copyKey, 'wizard.peer.syncNotMounted')
  assert.equal(light('authorized', { state: 'not-ready', reason: 'peers-not-online', candidateCount: 1 }).copyKey, 'wizard.peer.syncNotOnline')
  for (const gateway of ['connecting', 'pending-approval', 'mismatch', 'paused', 'revoked', 'offline']) {
    assert.equal(light(gateway, { state: 'not-ready', reason: `gateway-${gateway}` }).copyKey, 'wizard.peer.syncGatewayHold', gateway)
  }
  // An old body without sync (or an unknown state word) → pending UNKNOWN —
  // never "peers non-empty is green"; a locally known mismatch still fails.
  assert.deepEqual(light('authorized', undefined), { light: 'pending', copyKey: 'wizard.peer.syncUnknown' })
  assert.deepEqual(light('authorized', { state: undefined, reason: undefined }), { light: 'pending', copyKey: 'wizard.peer.syncUnknown' })
  assert.equal(light('authorized', undefined, 1).light, 'fail', 'a mismatch is a LOCAL fact — it fails even an old body')
  // unconfigured → the not-joined copy.
  assert.equal(light('unconfigured', { state: 'unconfigured', reason: 'unconfigured' }).copyKey, 'wizard.peer.notJoined')
})

await test('derivePeerWizardLights: the peer node\'s three lights (PG-9 + PC-14a)', () => {
  // ① identity is green once the engine has a node id, amber before.
  assert.equal(derivePeerWizardLights({ identityReady: false, gatewayState: 'unconfigured', mismatchCount: 0 }).identity, 'pending')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'unconfigured', mismatchCount: 0 }).identity, 'pass')
  // ② admission: authorized is green; pending-approval is the amber
  // 「等待网络管理员批准」; connecting/offline stay amber; mismatch,
  // revoked and paused are red.
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0 }).admission, 'pass')
  for (const amber of ['pending-approval', 'connecting', 'offline', 'unconfigured']) {
    assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: amber, mismatchCount: 0 }).admission, 'pending', amber)
  }
  for (const red of ['mismatch', 'revoked', 'paused']) {
    assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: red, mismatchCount: 0 }).admission, 'fail', red)
  }
  // ③ discovery & sync (PC-14a): ONLY the body's sync fact can turn it green
  // — a non-empty peers list, a lan path or a mounted count never do.
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0, sync: { state: 'ready' } }).discovery, 'pass')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0, sync: { state: 'partial', readyCount: 1, candidateCount: 2 } }).discovery, 'pending')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0, sync: { state: 'waiting-peers' } }).discovery, 'pending')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0, sync: { state: 'blocked' } }).discovery, 'fail')
  // The old-body rule (the decided fallback): no sync → pending UNKNOWN,
  // except a locally known mismatch which still fails.
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0 }).discovery, 'pending', 'old body: discovery must NOT go green off peerCount alone')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 1 }).discovery, 'fail')
  // A non-authorized gateway keeps discovery amber even against a ready word.
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'connecting', mismatchCount: 0, sync: { state: 'ready' } }).discovery, 'pending')
})

await test('derivePeerOverviewSummary: counts, the cap\'s red device light and the connection light (PG-9)', () => {
  const row = (path, over = {}) => ({
    nodeId: over.nodeId ?? 'aaaa1111', name: over.name ?? '书房电脑',
    mounted: over.mounted ?? true, path, rttMs: over.rttMs ?? 3,
    ...over,
  })
  // PC-11b: the capacity facts are the peer/status body's OWN fields
  // (PC-11a) — mountedCount/maxServers/limitReached/maxPeers verbatim; the
  // helper must NOT re-derive them from the discovered rows (peers.length is
  // the DISCOVERED count, never the mount count; maxPeers is the raw network
  // cap incl. self, never the mount cap).
  // Empty network, empty facts: everything amber, nothing claimed.
  assert.deepEqual(derivePeerOverviewSummary([], {}), {
    totalCount: 0, directCount: 0, relayCount: 0, mismatchCount: 0, offlineCount: 0,
    mountedCount: undefined, maxServers: undefined, maxPeers: undefined, limitReached: undefined,
    connectionLight: 'pending', devicesLight: 'pending',
  })
  // A healthy mix: lan+p2p count direct, relay counts relayed; the mounted
  // count rides the body's fact (2 of the rows carry mounted), the cap is
  // the body's effective 3 — NOT maxPeers-1 (raw network 16).
  const mix = derivePeerOverviewSummary([
    row('lan', { nodeId: 'a' }),
    row('p2p', { nodeId: 'b', mounted: false }),
    row('relay', { nodeId: 'c' }),
    row('offline', { nodeId: 'd', mounted: false, rttMs: null }),
  ], { maxPeers: 16, maxServers: 3, mountedCount: 2, limitReached: false })
  assert.equal(mix.totalCount, 4)
  assert.equal(mix.directCount, 2)
  assert.equal(mix.relayCount, 1)
  assert.equal(mix.offlineCount, 1)
  assert.equal(mix.mountedCount, 2)
  assert.equal(mix.maxServers, 3)
  assert.equal(mix.maxPeers, 16)
  assert.equal(mix.limitReached, false)
  assert.equal(mix.connectionLight, 'pending', 'one device is offline mid-retry — the connection light stays amber')
  assert.equal(mix.devicesLight, 'pass', 'known capacity under the cap is the one green case')
  // All devices on usable paths: the connection light goes green.
  assert.equal(
    derivePeerOverviewSummary([row('lan', { nodeId: 'a' }), row('p2p', { nodeId: 'b' }), row('relay', { nodeId: 'c' })], { maxPeers: 8, maxServers: 3, mountedCount: 1, limitReached: false }).connectionLight,
    'pass',
  )
  // 满额：at the local mount cap the device light goes red while the
  // connection light stays green.
  const full = derivePeerOverviewSummary(
    Array.from({ length: 3 }, (_, i) => row('lan', { nodeId: `node${i}` })),
    { maxPeers: 16, maxServers: 3, mountedCount: 3, limitReached: true },
  )
  assert.equal(full.limitReached, true)
  assert.equal(full.devicesLight, 'fail')
  assert.equal(full.connectionLight, 'pass')
  // A local explicit cap tighter than the network decides on its own
  // (raw network 16, effective 3): discovered 3 ≠ mounted 3 — the counts
  // stay separate vocabularies.
  assert.equal(
    derivePeerOverviewSummary([row('lan'), row('lan', { nodeId: 'b' }), row('lan', { nodeId: 'c', mounted: false })], { maxPeers: 16, maxServers: 2, mountedCount: 2, limitReached: true }).devicesLight,
    'fail',
  )
  // 缩容后的超额存量：mounted above the (now smaller) cap reads true, the
  // count is shown unclamped, existing mounts stay visible.
  const overCap = derivePeerOverviewSummary(
    Array.from({ length: 5 }, (_, i) => row('lan', { nodeId: `node${i}` })),
    { maxPeers: 16, maxServers: 3, mountedCount: 5, limitReached: true },
  )
  assert.equal(overCap.limitReached, true)
  assert.equal(overCap.mountedCount, 5, 'an over-cap stock is shown as-is, never clamped')
  assert.equal(overCap.devicesLight, 'fail')
  // UNKNOWN capacity (an old body without the PC-11a fields): the light
  // stays amber and limitReached stays undefined — never a fake false
  // (which would claim room that may not exist).
  const unknown = derivePeerOverviewSummary([row('lan')], {})
  assert.equal(unknown.mountedCount, undefined)
  assert.equal(unknown.maxServers, undefined)
  assert.equal(unknown.limitReached, undefined)
  assert.equal(unknown.devicesLight, 'pending', 'unknown capacity is amber, not green and not red')
  // Known counts without the flag still agree with the PC-11a definition.
  assert.equal(derivePeerOverviewSummary([], { mountedCount: 2, maxServers: 3 }).limitReached, false)
  assert.equal(derivePeerOverviewSummary([], { mountedCount: 3, maxServers: 3 }).limitReached, true)
  // Known mounted but unknown cap stays unknown (the cap is the missing half).
  assert.equal(derivePeerOverviewSummary([], { mountedCount: 2 }).limitReached, undefined)
  // A locally blocked identity turns both lights red — the user must act —
  // even when the capacity facts are unknown.
  const blocked = derivePeerOverviewSummary([row('lan', { nodeId: 'a' }), row('mismatch', { nodeId: 'b', mounted: false, rttMs: null })], {})
  assert.equal(blocked.mismatchCount, 1)
  assert.equal(blocked.devicesLight, 'fail')
  assert.equal(blocked.connectionLight, 'fail')
  // includeSelf: the DISCOVERED count only — when authorized in a network
  // alone it reads 1 (this machine), the mount facts stay the body's.
  const soloJoined = derivePeerOverviewSummary([], { maxPeers: 8, maxServers: 3, mountedCount: 0, limitReached: false }, { includeSelf: true })
  assert.equal(soloJoined.totalCount, 1)
  assert.equal(soloJoined.devicesLight, 'pass')
  assert.equal(soloJoined.connectionLight, 'pending')
  assert.equal(soloJoined.limitReached, false)
  assert.equal(soloJoined.mountedCount, 0, 'self never counts as a mounted remote')
})

await test('deriveClientServerLights: one paired server row drives the wizard step-3 lights (MS-8)', () => {
  // A minimal pool row: the view shape deriveClientStatusView answers.
  const row = (state, extra = {}) => ({
    entryId: 'e1', serverId: 's1', serverUrl: 'http://x.local:3088', serverName: 'srv',
    displayName: 'srv', state, nextRetryAt: undefined, lastError: '', compat: undefined, pluginBridge: [],
    ...extra,
  })
  // Nothing selected (no pool rows at all): all three stay amber.
  assert.deepEqual(deriveClientServerLights(undefined), { credential: 'pending', connection: 'pending', sync: 'pending' })
  // A healthy connected row: everything green.
  assert.deepEqual(deriveClientServerLights(row('connected')), { credential: 'pass', connection: 'pass', sync: 'pass' })
  // Connected but the interface groups differ from the server's: sync red.
  assert.deepEqual(
    deriveClientServerLights(row('connected', { compat: { mismatchedGroups: ['session'], recentCalls: [] } })),
    { credential: 'pass', connection: 'pass', sync: 'fail' },
  )
  // Revoked: the credential AND the connection are both dead, sync stays amber.
  assert.deepEqual(deriveClientServerLights(row('revoked')), { credential: 'fail', connection: 'fail', sync: 'pending' })
  // Offline mid-retry: the token is fine, the connection is red, sync waits.
  assert.deepEqual(deriveClientServerLights(row('unreachable')), { credential: 'pass', connection: 'fail', sync: 'pending' })
  // Incompatible: connection red, credential still fine.
  assert.deepEqual(deriveClientServerLights(row('incompatible')), { credential: 'pass', connection: 'fail', sync: 'pending' })
})

await test('formSeedOf: the configure forms seed from the wizard projection, not admin/status (GW-fix-3/M1)', () => {
  // The projection carries the ingress fields; admin/status does not (GW-1
  // strips them) — seeding from there would silently never backfill.
  const configured = {
    ok: true, mode: 'caddy', domain: 'dsh.example.com', httpsPort: 8443,
    publicUrl: 'https://dsh.example.com:8443', cfTokenConfigured: true, tunnelTokenConfigured: false,
    caddyRunning: false, cloudflaredRunning: false, gatewayActualPort: 4088,
    lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null,
  }
  assert.deepEqual(formSeedOf(configured), {
    domain: 'dsh.example.com', httpsPort: '8443', serverUrl: 'https://dsh.example.com:8443', path: 'caddy',
  })
  // An unconfigured projection seeds nothing (the forms keep the user's
  // input) and names no path.
  assert.deepEqual(formSeedOf({ ...configured, mode: 'off', domain: '', httpsPort: 443, publicUrl: '' }), {
    domain: '', httpsPort: '', serverUrl: '', path: undefined,
  })
  assert.deepEqual(formSeedOf(undefined).path, undefined)
})

await test('upstreamPortOf: the gateway ACTUAL port wins, 3088 is the fallback (GW-fix-3/M2)', () => {
  assert.equal(upstreamPortOf(undefined), 3088)
  assert.equal(upstreamPortOf({ ok: true, mode: 'caddy', domain: '', httpsPort: 443, publicUrl: '', cfTokenConfigured: false, tunnelTokenConfigured: false, caddyRunning: false, cloudflaredRunning: false, gatewayActualPort: null, lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null }), 3088)
  assert.equal(upstreamPortOf({ ok: true, mode: 'caddy', domain: '', httpsPort: 443, publicUrl: '', cfTokenConfigured: false, tunnelTokenConfigured: false, caddyRunning: false, cloudflaredRunning: false, gatewayActualPort: 4088, lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null }), 4088)
  // A junk actual port falls back too.
  assert.equal(upstreamPortOf({ ok: true, mode: 'caddy', domain: '', httpsPort: 443, publicUrl: '', cfTokenConfigured: false, tunnelTokenConfigured: false, caddyRunning: false, cloudflaredRunning: false, gatewayActualPort: 0, lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null }), 3088)
})

await test('deriveWizardLights: amber before trying, red on wrong shapes, pass only on pass', () => {
  // Nothing started: gateway reflects reachability, the rest stay amber.
  assert.deepEqual(
    deriveWizardLights({ gatewayReachable: false, poll: undefined }),
    { gateway: 'fail', publicUrl: 'pending', pairing: 'pending' },
  )
  assert.deepEqual(
    deriveWizardLights({ gatewayReachable: true, poll: undefined }),
    { gateway: 'pass', publicUrl: 'pending', pairing: 'pending' },
  )
  // Pending verdicts keep everything amber-but-running.
  for (const result of ['not-started', 'pending', 'stale', 'code-expired']) {
    const lights = deriveWizardLights({ gatewayReachable: true, poll: { result } })
    assert.equal(lights.publicUrl, 'pending', result)
    assert.equal(lights.pairing, 'pending', result)
  }
  assert.deepEqual(
    deriveWizardLights({ gatewayReachable: true, poll: { result: 'pass', deviceId: 'd1', at: 1 } }),
    { gateway: 'pass', publicUrl: 'pass', pairing: 'pass' },
  )
  // A wrong-shape probe answer fails the public light but never pairing.
  const lights = deriveWizardLights({ gatewayReachable: true, poll: { result: 'cookie-insecure', deviceId: 'd1' } })
  assert.deepEqual(lights, { gateway: 'pass', publicUrl: 'fail', pairing: 'fail' })
  // When startResult is supplied, a successful start probe turns publicUrl green immediately,
  // while a failed probe turns publicUrl red immediately.
  assert.deepEqual(
    deriveWizardLights({
      gatewayReachable: true,
      poll: { result: 'pending' },
      startResult: { ok: true, pairingCode: 'ABCD1234', publicUrl: 'https://dsh.example.com', expiresAt: 1000 },
    }),
    { gateway: 'pass', publicUrl: 'pass', pairing: 'pending' },
  )
  assert.deepEqual(
    deriveWizardLights({
      gatewayReachable: true,
      poll: undefined,
      startResult: { ok: false, reason: 'probe-failed', detail: { kind: 'reached', root: 'unexpected-401', admin: 'gateway-admin-403' } },
    }),
    { gateway: 'pass', publicUrl: 'fail', pairing: 'pending' },
  )
})

await test('caddyFailureCopy: every wire error maps to its locale key (GW-13a)', () => {
  assert.equal(caddyFailureCopy('missing-token').key, 'wizard.caddy.failMissingToken')
  assert.equal(caddyFailureCopy('already-running').key, 'wizard.caddy.failAlreadyRunning')
  assert.deepEqual(caddyFailureCopy('bad-config', 'bad-domain'), { key: 'wizard.caddy.failBadConfig', params: { detail: 'bad-domain' } })
  const download = caddyFailureCopy('download-failed', undefined, 'https://caddyserver.com/download')
  assert.equal(download.key, 'wizard.caddy.failDownload')
  assert.equal(download.installUrl, 'https://caddyserver.com/download')
  assert.equal(caddyFailureCopy('validate-failed').key, 'wizard.caddy.failValidate')
  assert.equal(caddyFailureCopy('spawn-failed').key, 'wizard.caddy.failSpawn')
  assert.equal(caddyFailureCopy('something-new').key, 'wizard.caddy.failSpawn', 'unknown codes degrade to the generic failure')
})

await test('the route constants mirror the host routes (GW-13a)', () => {
  assert.equal(WIZARD_CF_TOKEN_ROUTE, HOST_CF_TOKEN_ROUTE)
  assert.equal(WIZARD_CADDY_START_ROUTE, HOST_CADDY_START_ROUTE)
  assert.equal(WIZARD_CADDY_STOP_ROUTE, HOST_CADDY_STOP_ROUTE)
  assert.equal(WIZARD_CADDY_STATUS_ROUTE, HOST_CADDY_STATUS_ROUTE)
  assert.equal(WIZARD_TUNNEL_TOKEN_ROUTE, HOST_TUNNEL_TOKEN_ROUTE)
})

await test('tunnelFailureCopy / tunnelCheckCopy: every reason maps to its locale key (GW-13b)', () => {
  for (const [reason, key] of [
    ['tunnel-conflict', 'wizard.tunnel.conflict'],
    ['zone-not-found', 'wizard.tunnel.zoneNotFound'],
    ['dns-conflict', 'wizard.tunnel.dnsConflict'],
    ['auth', 'wizard.tunnel.auth'],
    ['network', 'wizard.tunnel.network'],
    ['no-token', 'wizard.tunnel.noToken'],
    ['bad-domain', 'wizard.tunnel.badDomain'],
    ['spawn-failed', 'wizard.tunnel.spawnFailed'],
  ]) {
    const copy = tunnelFailureCopy(reason, 'd')
    assert.equal(copy.key, key, reason)
    if (reason === 'spawn-failed') assert.deepEqual(copy.params, { detail: 'd' })
    if (reason === 'dns-conflict') assert.deepEqual(copy.params, { detail: 'd' })
  }
  // Unknown reasons degrade to the generic API failure carrying the reason.
  assert.deepEqual(tunnelFailureCopy('anything-new'), { key: 'wizard.tunnel.api', params: { detail: 'anything-new' } })
  assert.deepEqual(tunnelCheckCopy({ ok: true, onCloudflare: true, zoneId: 'z' }), { key: 'wizard.check.okOnCf', tone: 'ok' })
  assert.equal(tunnelCheckCopy({ ok: true, onCloudflare: false, zoneId: null }).tone, 'error')
  assert.equal(tunnelCheckCopy({ ok: false, reason: 'network' }).key, 'wizard.check.failed')
})

await test('the tunnel route constants mirror the host routes (GW-13b)', () => {
  assert.equal(WIZARD_TUNNEL_CHECK_ROUTE, HOST_TUNNEL_CHECK_ROUTE)
  assert.equal(WIZARD_TUNNEL_SETUP_ROUTE, HOST_TUNNEL_SETUP_ROUTE)
  assert.equal(WIZARD_TUNNEL_STATUS_ROUTE, HOST_TUNNEL_STATUS_ROUTE)
  assert.equal(WIZARD_TUNNEL_STOP_ROUTE, HOST_TUNNEL_STOP_ROUTE)
})

await test('the pairing countdown counts whole seconds, never negative', () => {
  const now = 1_000_000
  assert.equal(pairingSecondsLeft(now + 59_500, now), 60)
  assert.equal(pairingSecondsLeft(now + 1000, now), 1)
  assert.equal(pairingSecondsLeft(now, now), 0)
  assert.equal(pairingSecondsLeft(now - 5000, now), 0)
})

// ---- the locale dictionaries --------------------------------------------------

const WIZARD_KEYS = [
  'wizard.title', 'wizard.subtitle', 'wizard.off',
  'wizard.step.pick', 'wizard.step.configure', 'wizard.step.verify',
  'wizard.path.caddy', 'wizard.path.caddyDesc', 'wizard.path.external', 'wizard.path.externalDesc',
  'wizard.path.cloudflared', 'wizard.path.cloudflaredDesc',
  'wizard.next', 'wizard.back', 'wizard.domain', 'wizard.domainHint', 'wizard.httpsPort',
  'wizard.cfToken', 'wizard.cfTokenHint', 'wizard.cfTokenHowTo', 'wizard.serverUrl', 'wizard.serverUrlHint',
  'wizard.proxySnippet', 'wizard.badDomain', 'wizard.badPort', 'wizard.missingToken', 'wizard.badServerUrl',
  'wizard.verify.gateway', 'wizard.verify.public', 'wizard.verify.pairing',
  'wizard.light.pass', 'wizard.light.pending', 'wizard.light.fail',
  'wizard.startVerify', 'wizard.reverify', 'wizard.pairingCode', 'wizard.pairingSeconds', 'wizard.qrHint',
  'wizard.verifyPass', 'wizard.verifyCookieInsecure', 'wizard.verifyExpired', 'wizard.verifyStale',
  'wizard.verifyPending', 'wizard.verifyNotStarted',
  'wizard.startFailed', 'wizard.startFailedProbe', 'wizard.startFailedRuntime', 'wizard.startFailedGateway',
  'wizard.startFailedPair', 'wizard.startFailedUrl',
  'wizard.remoteOnly', 'wizard.notWired',
  'wizard.card.proxyTitle', 'wizard.card.proxyCheck', 'wizard.card.tokenTitle', 'wizard.card.copy',
  'wizard.card.copied', 'wizard.card.close',
  'wizard.card.tokenStep1', 'wizard.card.tokenStep2', 'wizard.card.tokenStep3', 'wizard.card.tokenStep4',
  'wizard.card.tokenStep5', 'wizard.card.tokenStep6', 'wizard.card.tokenStep7', 'wizard.card.tokenStep8',
  'wizard.card.tokenPerms', 'wizard.card.tokenPermDns', 'wizard.card.tokenPermDnsWhy',
  'wizard.card.tokenPermTunnel', 'wizard.card.tokenPermTunnelWhy',
  'wizard.card.tokenPermAccount', 'wizard.card.tokenPermAccountWhy',
  'wizard.card.tokenPermZoneRead', 'wizard.card.tokenPermZoneReadWhy',
  'wizard.card.tokenPaste', 'wizard.card.tokenUse',
  'wizard.ingress',
  'wizard.caddy.start', 'wizard.caddy.stop', 'wizard.caddy.running', 'wizard.caddy.stopped',
  'wizard.caddy.neverStarted', 'wizard.caddy.startOk', 'wizard.caddy.startFailed',
  'wizard.caddy.failDownload', 'wizard.caddy.failValidate', 'wizard.caddy.failAlreadyRunning',
  'wizard.caddy.failMissingToken', 'wizard.caddy.failNoDomain', 'wizard.caddy.failBadConfig',
  'wizard.caddy.failSpawn',
  'wizard.token.saved', 'wizard.token.saveFailed',
  'wizard.tunnel.setup', 'wizard.tunnel.stop', 'wizard.tunnel.running', 'wizard.tunnel.stopped',
  'wizard.tunnel.neverStarted', 'wizard.tunnel.ok', 'wizard.tunnel.conflict', 'wizard.tunnel.useExisting',
  'wizard.tunnel.zoneNotFound', 'wizard.tunnel.dnsConflict', 'wizard.tunnel.auth', 'wizard.tunnel.network', 'wizard.tunnel.api',
  'wizard.tunnel.spawnFailed', 'wizard.tunnel.noToken', 'wizard.tunnel.badDomain', 'wizard.tunnel.checking',
  'wizard.check.okOnCf', 'wizard.check.okNotOnCf', 'wizard.check.failed',
  'wizard.card.migrateTitle', 'wizard.card.migrateRecheck',
  'wizard.card.migrateStep1', 'wizard.card.migrateStep2', 'wizard.card.migrateStep3',
  'wizard.card.migrateStep4', 'wizard.card.migrateStep5', 'wizard.card.migrateStep6',
  'wizard.card.portForwardTitle',
  'wizard.card.portForwardStep1', 'wizard.card.portForwardStep2', 'wizard.card.portForwardStep3',
  'wizard.card.portForwardStep4',
  'wizard.portForwardEntry', 'wizard.migrateEntry', 'wizard.caddy.starting',
  'wizard.overview.roleLabel', 'wizard.overview.gatewayLabel', 'wizard.overview.gatewayReady',
  'wizard.overview.gatewayDown', 'wizard.overview.ingressLabel', 'wizard.overview.devicesLabel',
  'wizard.overview.devicesSummary', 'wizard.overview.devicesNone', 'wizard.overview.clientCredLabel',
  'wizard.overview.clientConnLabel', 'wizard.overview.clientServerLabel', 'wizard.overview.startSetup',
  'wizard.overview.reconfigure', 'wizard.overview.pairPhone', 'wizard.overview.pairDesktop',
  'wizard.overview.clientDetail', 'wizard.overview.emptyIntro',
  'wizard.modal.title', 'wizard.modal.stepTag', 'wizard.modal.step1Desc', 'wizard.modal.step2Desc',
  'wizard.modal.step3Desc', 'wizard.modal.selectedPlan', 'wizard.modal.cancel',
  'wizard.modal.saveAndNext', 'wizard.modal.finish',
  'wizard.light.probing', 'wizard.overview.manageDevices',
  'wizard.devicesModal.title', 'wizard.devicesModal.subtitle', 'wizard.devicesModal.retest',
  'wizard.overview.clientSyncLabel', 'wizard.overview.syncOk', 'wizard.overview.syncBad', 'wizard.overview.syncPending',
  'wizard.overview.clientOnlineCount', 'wizard.overview.clientOfflineCount', 'wizard.overview.clientRevokedCount',
  'wizard.overview.clientAllOnline', 'wizard.overview.clientServersLabel', 'wizard.overview.clientPairedFull',
  'wizard.overview.clientPairedNames', 'wizard.overview.limitNote',
  'wizard.overview.manageServers', 'wizard.overview.addServer',
  'wizard.serversModal.title', 'wizard.serversModal.subtitle', 'wizard.serversModal.viewStatus',
  'wizard.client.poolCapNote', 'wizard.client.continueAdd', 'wizard.client.serverPicker',
  'wizard.desktop.addressFallback', 'wizard.desktop.copiedText',
  // PG-9: the peer node's role card, join flow, three lights, overview tiles
  // and the network-devices modal. The wording follows the glossary: the role
  // is 节点端 (Peer Node), the paths are 局域网直连 / 直连 / 经网关中转, a
  // key change is 身份异常 / 信任新身份, the invite is 邀请链接.
  'wizard.role.peer', 'wizard.role.peerDesc', 'wizard.role.peerPickNote',
  'wizard.peer.modeInvite', 'wizard.peer.modeGateway',
  'wizard.peer.inviteUri', 'wizard.peer.inviteUriHint', 'wizard.peer.inviteUriPlaceholder',
  'wizard.peer.gatewayUrl', 'wizard.peer.gatewayUrlHint', 'wizard.peer.gatewayUrlPlaceholder',
  'wizard.peer.selectNetwork', 'wizard.peer.selectNetworkHint', 'wizard.peer.requestJoin',
  // PC-15: the advanced split-fill's expander, three fields and local
  // refusals (the assembled invite reuses every existing join key below).
  'wizard.peer.advancedSummary', 'wizard.peer.advancedGateway', 'wizard.peer.advancedGatewayPlaceholder',
  'wizard.peer.advancedGatewayHint', 'wizard.peer.advancedNetworkId', 'wizard.peer.advancedNetworkIdPlaceholder',
  'wizard.peer.advancedNetworkIdHint', 'wizard.peer.advancedJoinKey', 'wizard.peer.advancedJoinKeyHint',
  'wizard.peer.advancedBadGateway', 'wizard.peer.advancedBadNetworkId',
  // PC-15 fix1: the unencodable-passphrase refusal and the paste entry's
  // paused hint while the advanced expander is open.
  'wizard.peer.advancedBadJoinKey', 'wizard.peer.inviteUriPausedHint',
  'wizard.peer.join', 'wizard.peer.joining', 'wizard.peer.rejoin', 'wizard.peer.leave',
  'wizard.peer.leaveConfirm',
  'wizard.peer.lightIdentity', 'wizard.peer.lightAdmission', 'wizard.peer.lightDiscovery',
  'wizard.peer.pendingApproval', 'wizard.peer.joinFailed', 'wizard.peer.joinInvalid',
  'wizard.peer.joinGatewayInvalid', 'wizard.peer.joinGatewayUnreachable',
  'wizard.peer.joinNoNetwork', 'wizard.peer.joinManualDisabled',
  'wizard.peer.connecting', 'wizard.peer.offline', 'wizard.peer.revoked', 'wizard.peer.mismatch',
  'wizard.peer.notJoined',
  'wizard.overview.peerNodeLabel', 'wizard.overview.peerNetworkLabel', 'wizard.overview.peerNetworkNone',
  'wizard.overview.peerConnLabel', 'wizard.overview.peerConnSummary', 'wizard.overview.peerConnNone',
  'wizard.overview.peerDevicesLabel',
  // PC-11b: the unified mount-capacity wording — 本机已挂载 N / M 台远端设备
  // as the main line, the RAW network cap annotated separately (含本机), the
  // discovered count named 已发现, and the full note blaming the LOCAL cap.
  'wizard.overview.peerMountCount', 'wizard.overview.peerMountUnknown', 'wizard.overview.peerMountFull',
  'wizard.overview.peerNetworkCapNote', 'wizard.overview.peerMountedDiscovered', 'wizard.overview.peerDiscoveredCount',
  'wizard.peer.devicesModalTitle', 'wizard.peer.devicesModalSubtitle', 'wizard.peer.devicesModalEmpty',
  'wizard.peer.devicePathLan', 'wizard.peer.devicePathP2p', 'wizard.peer.devicePathRelay',
  'wizard.peer.devicePathOffline', 'wizard.peer.devicePathMismatch', 'wizard.peer.deviceRtt',
  'wizard.peer.deviceMount', 'wizard.peer.deviceIgnore',
  'wizard.peer.mismatchNote', 'wizard.peer.trustNew', 'wizard.peer.trustOk', 'wizard.peer.actionFailed',
  'wizard.peer.pwaSectionTitle', 'wizard.peer.switchRole', 'wizard.peer.pairPhone',
  'wizard.peer.configurePhoneAccess', 'wizard.peer.managePairedDevices',
  'settings.peer.title', 'settings.peer.subtitle', 'settings.peer.notConfigured',
]

// The cards' step counts are part of the walkthrough contract (GW-11).
const CARD_STEP_COUNTS = {
  tokenStep: 8,
  migrateStep: 6,
  portForwardStep: 4,
}
for (const [prefix, expected] of Object.entries(CARD_STEP_COUNTS)) {
  const keys = Object.keys(zh).filter((key) => key.startsWith(`wizard.card.${prefix}`))
  assert.equal(keys.length, expected, `${prefix} has exactly ${expected} steps, got ${keys.join(', ')}`)
  for (let i = 1; i <= expected; i++) {
    assert.ok(keys.includes(`wizard.card.${prefix}${i}`), `missing step ${prefix}${i}`)
  }
}
// The placeholder interpolation the port-forward steps promise.
assert.ok(zh['wizard.card.portForwardStep3'].includes('{port}'), 'step 3 interpolates the port')
assert.ok(en['wizard.card.portForwardStep3'].includes('{port}'), 'step 3 interpolates the port (en)')

await test('zh/en carry identical key sets, and every wizard key exists in both', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh is the key-set source of truth')
  for (const key of WIZARD_KEYS) {
    assert.ok(key in zh, `zh missing ${key}`)
    assert.ok(key in en, `en missing ${key}`)
    assert.equal(typeof zh[key], 'string')
    assert.equal(typeof en[key], 'string')
  }
})

// ---- the snippet templates: browser mirror == host half ------------------------

const SNIPPET_INPUT = { domain: 'dsh.example.com', upstreamHost: '127.0.0.1', upstreamPort: 4088 }

await test('the browser snippet mirrors are byte-identical to the host templates', () => {
  assert.equal(nginxSnippetText(SNIPPET_INPUT), nginxSnippet(SNIPPET_INPUT).text)
  assert.equal(caddySnippetText(SNIPPET_INPUT), caddySnippet(SNIPPET_INPUT).text)
  assert.deepEqual(luckyStepTexts(SNIPPET_INPUT), luckySteps(SNIPPET_INPUT).steps)
  const enInput = { ...SNIPPET_INPUT, lang: 'en' }
  assert.equal(nginxSnippetText(enInput), nginxSnippet(enInput).text)
  assert.equal(caddySnippetText(enInput), caddySnippet(enInput).text)
  assert.deepEqual(luckyStepTexts(enInput), luckySteps(enInput).steps)
  // The mirrors refuse the same inputs the host refuses.
  for (const bad of [{ ...SNIPPET_INPUT, domain: 'a b' }, { ...SNIPPET_INPUT, upstreamHost: 'x/y' }, { ...SNIPPET_INPUT, upstreamPort: 0 }]) {
    assert.equal(nginxSnippetText(bad), null)
    assert.equal(caddySnippetText(bad), null)
    assert.equal(luckyStepTexts(bad), null)
  }
})

// ---- the QR encoder, judged at decoder level ------------------------------------

// Galois field helpers for the syndrome check (same field as the encoder).
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** syndromes S_i = C(α^i), i in 0..n-1 — all zero ⇔ valid RS codeword. */
function syndromes(codewords, eccLen) {
  const out = []
  for (let i = 0; i < eccLen; i++) {
    let sum = 0
    for (const byte of codewords) sum = gfMul(sum, EXP[i]) ^ byte
    out.push(sum)
  }
  return out
}

const DATA_CODEWORDS = { 21: 19, 25: 34, 29: 55, 33: 80, 37: 108 }
const ECC_CODEWORDS = { 21: 7, 25: 10, 29: 15, 33: 20, 37: 26 }

await test('QR: every version encodes a decodable symbol (RS + format + data recovery)', () => {
  for (const text of ['https://dsh.example.com', 'HELLO', 'x'.repeat(106), 'a']) {
    const matrix = qrMatrix(text)
    assert.ok(matrix !== null, `qrMatrix(${text.slice(0, 12)}…) must encode`)
    const n = matrix.length
    assert.ok([21, 25, 29, 33, 37].includes(n), `size ${n} is a known version`)

    // Structure: the three finders + separators (top-left corner sampling),
    // timing alternation, the dark module.
    // The standard 7×7 finder, verbatim: solid border, hollow ring, 3×3 core.
    const FINDER = [
      [1, 1, 1, 1, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 0, 0, 0, 0, 1],
      [1, 1, 1, 1, 1, 1, 1],
    ]
    for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let dr = 0; dr < 7; dr++) {
        for (let dc = 0; dc < 7; dc++) {
          assert.equal(matrix[r0 + dr][c0 + dc], FINDER[dr][dc] === 1, `finder ${r0},${c0} +${dr},${dc}`)
        }
      }
    }
    for (let i = 8; i < n - 8; i++) assert.equal(matrix[6][i], i % 2 === 0, `timing row ${i}`)
    for (let i = 8; i < n - 8; i++) assert.equal(matrix[i][6], i % 2 === 0, `timing col ${i}`)
    assert.equal(matrix[n - 8][8], true, 'the fixed dark module')

    // Format info: both copies agree and decode to (L, mask 0).
    // ISO/IEC 18004 Figure 25: bit 14 (MSB) is at (8, 0) / (n - 1, 8) and
    // bit 0 (LSB) is at (0, 8) / (8, n - 1).
    const decodeFormat = (bits) => {
      let value = 0
      for (let i = 0; i < 15; i++) value |= (bits[i] ? 1 : 0) << i
      assert.equal(value, 0x77c4, 'ISO/IEC 18004 Table C.1 format word for L + mask 0')
      const unmasked = value ^ 0x5412
      // BCH check: re-encode the 5 data bits and compare.
      const data = unmasked >> 10
      let rem = data << 10
      for (let i = 4; i >= 0; i--) if ((rem >>> (i + 10)) & 1) rem ^= 0x537 << i
      assert.equal(((data << 10) | rem) ^ 0x5412, value, 'format BCH is self-consistent')
      assert.equal(data >> 3, 0b01, 'ECC level L')
      assert.equal(data & 0b111, 0, 'mask 0')
    }
    const formatBits = []
    for (let i = 0; i <= 5; i++) formatBits[14 - i] = matrix[8][i]
    formatBits[8] = matrix[8][7]
    formatBits[7] = matrix[8][8]
    formatBits[6] = matrix[7][8]
    for (let i = 9; i <= 14; i++) formatBits[14 - i] = matrix[14 - i][8]
    decodeFormat(formatBits)
    const formatBits2 = []
    for (let i = 0; i <= 6; i++) formatBits2[14 - i] = matrix[n - 1 - i][8]
    for (let i = 7; i <= 14; i++) formatBits2[14 - i] = matrix[8][n - 15 + i]
    assert.deepEqual(formatBits2, formatBits, 'both format copies agree')

    // Collect the DATA positions (the zigzag minus every reserved cell),
    // then read the codeword bits in placement order.
    const reserved = Array.from({ length: n }, () => new Array(n).fill(false))
    const mark = (r, c) => { if (r >= 0 && r < n && c >= 0 && c < n) reserved[r][c] = true }
    for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8) }
    for (let i = 0; i < 8; i++) { mark(n - 1 - i, 8); mark(8, n - 1 - i) }
    mark(n - 8, 8)
    // The finder blocks AND their one-module separators: the encoder
    // writes the full (dr, dc ∈ [-1, 7]) window of each corner.
    for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) mark(r0 + dr, c0 + dc)
      }
    }
    for (let i = 0; i < n; i++) { mark(6, i); mark(i, 6) }
    // Alignment patterns (versions 2-5): 5×5 at each center-pair point,
    // SKIPPING any center whose pattern would touch a finder window — the
    // same rule the encoder applies (standard: those positions do not get
    // an alignment pattern at all).
    const CENTERS = { 25: [6, 18], 29: [6, 22], 33: [6, 26], 37: [6, 30] }[n]
    if (CENTERS !== undefined) {
      const windows = [[0, 0], [0, n - 7], [n - 7, 0]].map(([r0, c0]) => [r0 - 1, r0 + 7, c0 - 1, c0 + 7])
      for (const r of CENTERS) {
        for (const c of CENTERS) {
          const overlaps = windows.some(([r1, r2, c1, c2]) => r >= r1 && r <= r2 && c >= c1 && c <= c2)
          if (overlaps) continue
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc)
          }
        }
      }
    }

    // Collect the data-bit stream AND undo mask 0 ((row+col) even flips) —
    // the RS codewords live UNDER the mask; a decoder un-masks first.
    const stream = []
    let inc = -1
    let row = n - 1
    for (let right = n - 1; right >= 0; right -= 2) {
      if (right === 6) right = 5
      while (true) {
        for (let c = 0; c < 2; c++) {
          if (!reserved[row][right - c]) {
            const bit = matrix[row][right - c]
            stream.push((row + (right - c)) % 2 === 0 ? !bit : bit)
          }
        }
        row += inc
        if (row < 0 || row >= n) { row -= inc; inc = -inc; break }
      }
    }
    const codewords = []
    for (let i = 0; i + 8 <= stream.length; i += 8) {
      let byte = 0
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (stream[i + j] ? 1 : 0)
      codewords.push(byte)
    }
    const eccLen = ECC_CODEWORDS[n]
    const dataLen = DATA_CODEWORDS[n]
    assert.equal(codewords.length, dataLen + eccLen, 'the stream length matches the version')

    // RS syndromes all zero: the ECC codewords are mathematically correct,
    // so ANY standard reader accepts the symbol.
    for (const s of syndromes(codewords, eccLen)) assert.equal(s, 0, 'RS syndrome')

    // Data recovery: mode 0100 + 8-bit count + the original bytes.
    let bitIndex = 0
    const readBit = () => {
      const byte = codewords[bitIndex >> 3]
      const bit = (byte >> (7 - (bitIndex & 7))) & 1
      bitIndex += 1
      return bit
    }
    const readBits = (count) => {
      let value = 0
      for (let i = 0; i < count; i++) value = (value << 1) | readBit()
      return value
    }
    assert.equal(readBits(4), 0b0100, 'byte mode')
    const length = readBits(8)
    const payload = new TextDecoder().decode(Uint8Array.from({ length }, () => readBits(8)))
    assert.equal(payload, text, `data round-trips: ${text.slice(0, 24)}…`)
  }

  // Overlong text refuses instead of mis-encoding.
  assert.equal(qrMatrix('x'.repeat(107)), null)
})

await test('registerGatewayWizard: mounts on plugins.bundle.config (top of bundle detail page, absent on row detail page)', () => {
  const slotsInjected = []
  const slotsRegistered = []
  let formsCallback
  const ctx = {
    effect: () => () => {},
    inject(services, cb) {
      if (services.includes('configForms')) formsCallback = cb
    },
  }
  const stubWizard = () => null
  registerGatewayWizard(ctx, stubWizard)
  assert.equal(typeof formsCallback, 'function', 'registers through lazy configForms inject')

  const formsEffects = []
  formsCallback({
    effect(producer, label) {
      formsEffects.push({ label, producer })
      return () => {}
    },
    configForms: {
      get: () => ({
        getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true }),
        subscribe: () => () => {},
        mutate: async () => true,
      }),
    },
    slots: {
      inject(name, factory) {
        slotsInjected.push(name)
        factory()
        return () => {}
      },
      register(options, component) {
        slotsRegistered.push({ options, component })
        return () => {}
      },
    },
  })
  const sectionEffect = formsEffects.find((entry) => entry.label === 'dsh-zen-remote: wizard section')
  assert.ok(sectionEffect !== undefined, 'wizard section effect registered')
  sectionEffect.producer()
  assert.deepEqual(slotsInjected, ['plugins.bundle.config'])
  assert.equal(slotsRegistered.length, 1)
  assert.equal(slotsRegistered[0].options.name, 'plugins.bundle.config')
  assert.equal(slotsRegistered[0].options.key, WIZARD_BUNDLE_KEY)
  assert.equal(slotsRegistered[0].options.key, 'dsh-zen-remote')
  assert.equal(slotsRegistered[0].component, stubWizard)
})

await test('targetHostSaveRole: the channel-config save keeps a peer a peer (PG-9-fix)', () => {
  // The phone-PWA channel flows run under wizardRole 'host' — a peer that
  // opens them from its lower PWA section must keep its row role after the
  // save, or the machine is kicked out of the virtual network.
  assert.equal(targetHostSaveRole(false), 'host')
  assert.equal(targetHostSaveRole(true), 'peer')
})

// ---- the advanced split-fill's invite assembler (PC-15) -----------------------
//
// The browser half cannot import src/peer/crypto.ts (node:crypto), so
// client-data/wizard.ts carries a mirror assembler. These tests ARE the
// drift guard: every positive sample must round-trip through the REAL
// parseInviteUri — the same function the join route's invite branch feeds
// engine.joinNetwork with — so an assembled invite behaves byte-for-byte
// like a pasted one (keyless = the existing manual-approval flow).

await test('assemblePeerInviteUri: positive samples round-trip through the REAL parser (PC-15)', () => {
  // Bare host: default peer port 19393, plain zr-net lets the parser infer
  // the transport from the host (public → TLS).
  const bare = assemblePeerInviteUri({ gatewayAddress: 'gw.example.com', networkId: '0123456789ABCDEF' })
  assert.deepEqual(bare, { ok: true, inviteUri: 'zr-net://gw.example.com:19393/0123456789abcdef' })
  const bareParsed = parseInviteUri(bare.inviteUri)
  assert.ok(bareParsed !== null)
  assert.equal(bareParsed.hostname, 'gw.example.com')
  assert.equal(bareParsed.port, 19393)
  assert.equal(bareParsed.networkId, '0123456789abcdef')
  assert.equal(bareParsed.joinKey, undefined)
  assert.equal(bareParsed.defaultTls, true, 'a public host infers TLS — the peer invite rule')

  // host:port, private v4: the parser infers plaintext.
  const lan = assemblePeerInviteUri({ gatewayAddress: '10.0.0.1:4088', networkId: '0123456789abcdef' })
  assert.equal(lan.inviteUri, 'zr-net://10.0.0.1:4088/0123456789abcdef')
  assert.equal(parseInviteUri(lan.inviteUri)?.defaultTls, false, 'a private host infers plaintext')

  // Explicit https/wss force TLS on any host.
  for (const address of ['https://zr.example.com', 'wss://zr.example.com:8443']) {
    const tls = assemblePeerInviteUri({ gatewayAddress: address, networkId: '0123456789abcdef' })
    assert.equal(tls.ok, true, address)
    const parsed = parseInviteUri(tls.inviteUri)
    assert.equal(parsed?.defaultTls, true, address)
    assert.equal(parsed?.port, address.includes('8443') ? 8443 : 443, address)
  }

  // Explicit public http/ws keep the peer rule's plaintext support (this is
  // NOT the host/client pairing rule, which refuses plain http outright).
  for (const address of ['http://zr.example.com:19393', 'ws://zr.example.com']) {
    const plain = assemblePeerInviteUri({ gatewayAddress: address, networkId: '0123456789abcdef' })
    assert.equal(plain.ok, true, address)
    const parsed = parseInviteUri(plain.inviteUri)
    assert.equal(parsed?.defaultTls, false, address)
    assert.ok(plain.inviteUri.startsWith('zr-net+insecure://') || plain.inviteUri.startsWith('zr-net://'), address)
  }

  // Bracketed IPv6 (ULA → plaintext via inference), hostname lowercased.
  const v6 = assemblePeerInviteUri({ gatewayAddress: '[FD00::1]:19393', networkId: '0123456789abcdef' })
  assert.equal(v6.inviteUri, 'zr-net://[FD00::1]:19393/0123456789abcdef')
  const v6Parsed = parseInviteUri(v6.inviteUri)
  assert.equal(v6Parsed?.hostname, 'fd00::1')
  assert.equal(v6Parsed?.defaultTls, false, 'an IPv6 ULA infers plaintext')

  // A trailing slash and the console SPA path both fold away. The host is
  // PRIVATE here, so the explicit-plain scheme table lands on plain `zr-net`
  // (the same scheme buildKeylessInviteUri picks for a private plaintext
  // gateway) — zr-net+insecure is the PUBLIC-plaintext scheme.
  for (const address of ['http://10.0.0.1:4088/', 'http://10.0.0.1:4088/peer/v1/ws']) {
    const folded = assemblePeerInviteUri({ gatewayAddress: address, networkId: '0123456789abcdef' })
    assert.equal(folded.ok, true, address)
    assert.equal(folded.inviteUri, 'zr-net://10.0.0.1:4088/0123456789abcdef', address)
  }
  // The public-plaintext invite (an explicit http:// PUBLIC host): the one
  // case that needs the zr-net+insecure scheme.
  const publicPlain = assemblePeerInviteUri({ gatewayAddress: 'http://gw.example.com:19393/', networkId: '0123456789abcdef' })
  assert.equal(publicPlain.inviteUri, 'zr-net+insecure://gw.example.com:19393/0123456789abcdef')
  assert.equal(parseInviteUri(publicPlain.inviteUri)?.defaultTls, false)

  // The passphrase: percent-encoded into the fragment, decoded EXACTLY back,
  // never trimmed — every character the user typed is meaningful.
  const keyed = assemblePeerInviteUri({ gatewayAddress: '10.0.0.1:4088', networkId: '0123456789abcdef', joinKey: 'p@ss word%#中文' })
  assert.ok(keyed.ok)
  assert.ok(keyed.inviteUri.includes('#'), 'a join key rides the fragment')
  assert.ok(!keyed.inviteUri.includes('p@ss word'), 'the raw key never appears in the URI')
  assert.equal(parseInviteUri(keyed.inviteUri)?.joinKey, 'p@ss word%#中文')
  const padded = assemblePeerInviteUri({ gatewayAddress: '10.0.0.1:4088', networkId: '0123456789abcdef', joinKey: ' padded ' })
  assert.equal(parseInviteUri(padded.inviteUri)?.joinKey, ' padded ', 'leading/trailing spaces are kept')

  // An empty-string key means NO key — byte-equivalent to the keyless invite
  // the route's manual-approval path synthesizes for the same gateway.
  const keyless = assemblePeerInviteUri({ gatewayAddress: '10.0.0.1:4088', networkId: '0123456789abcdef', joinKey: '' })
  assert.equal(keyless.inviteUri, 'zr-net://10.0.0.1:4088/0123456789abcdef')
  assert.equal(parseInviteUri(keyless.inviteUri)?.joinKey, undefined)
})

await test('assemblePeerInviteUri: local refusals — a malformed part never reaches a request (PC-15)', () => {
  // Bad gateway addresses (each of these the REAL parser would also refuse).
  for (const bad of ['', '   ', 'a b', 'host:', 'host:0', 'host:65536', 'host:abc', '::1', '[fd00::1', 'ftp://x', 'host/?x=1', 'host/#frag']) {
    assert.deepEqual(
      assemblePeerInviteUri({ gatewayAddress: bad, networkId: '0123456789abcdef' }),
      { ok: false, error: 'bad-adv-gateway' },
      bad,
    )
  }
  // The gateway is checked first (it is the form's first field).
  assert.equal(
    assemblePeerInviteUri({ gatewayAddress: 'a b', networkId: 'nothex' }).error,
    'bad-adv-gateway',
  )
  // Bad network IDs: wrong length, non-hex, hex-prefix junk.
  for (const bad of ['', 'short', '0123456789abcdef0', 'zz23456789abcdef', '0x123456789abcde', '0123456789abcde ']) {
    assert.deepEqual(
      assemblePeerInviteUri({ gatewayAddress: '10.0.0.1:4088', networkId: bad }),
      { ok: false, error: 'bad-adv-network-id' },
      JSON.stringify(bad),
    )
  }
  // The one ambiguity the parser tolerates by design (an explicit empty port
  // is malformed, never guessed).
  assert.deepEqual(
    assemblePeerInviteUri({ gatewayAddress: 'host:/id', networkId: '0123456789abcdef' }),
    { ok: false, error: 'bad-adv-gateway' },
  )
  // And the assembled invite parses as an INVITE for the join route's own
  // gateway-input classifier (never misread as a gateway address).
  const ok = assemblePeerInviteUri({ gatewayAddress: '10.0.0.1:4088', networkId: '0123456789abcdef' })
  assert.equal(parseGatewayJoinInput(ok.inviteUri)?.kind, 'invite')
})

await test('assemblePeerInviteUri: a shape-valid authority must still build a REAL URL (PC-15 fix1 R2)', () => {
  // `[aa]` passes the bracketed-IPv6 CHARACTERS check but is not a valid
  // IPv6 literal; the same for IPv4 octets over 255. The REAL parser accepts
  // most of these BY SHAPE too (only `[::zz]` has a character outside the
  // set) — that is exactly why the grammar alone is not enough and the
  // assembler adds one standard-URL construction (no network): a refused
  // address never becomes an unusable dial target.
  for (const bad of ['[aa]:19393', '[::zz]:19393', '[1.2.3.4]:19393', '999.168.1.10:19393', '10.0.0.256:19393']) {
    assert.deepEqual(
      assemblePeerInviteUri({ gatewayAddress: bad, networkId: '0123456789abcdef' }),
      { ok: false, error: 'bad-adv-gateway' },
      bad,
    )
  }
  assert.equal(parseInviteUri('zr-net://[::zz]:19393/0123456789abcdef'), null, 'a non-hex IPv6 literal the real parser refuses')
  for (const shapeOk of ['[aa]:19393', '999.168.1.10:19393']) {
    assert.notEqual(
      parseInviteUri(`zr-net://${shapeOk}/0123456789abcdef`), null,
      `${shapeOk}: the real parser passes the SHAPE — the assembler must be the stricter gate`,
    )
  }
  // Less-than-4-part IPv4-ish names stay accepted (existing semantics —
  // the peer grammar always allowed them and the engine dials rawHost).
  assert.equal(assemblePeerInviteUri({ gatewayAddress: '1.2.3:19393', networkId: '0123456789abcdef' }).ok, true)

  // Usability, not just parser acceptance: the assembled authority must
  // construct as BOTH a gateway ws URL and an http origin — the two URL
  // shapes the peer engine and manual-approval path actually dial.
  for (const sample of [
    assemblePeerInviteUri({ gatewayAddress: '10.0.0.1:4088', networkId: '0123456789abcdef' }),
    assemblePeerInviteUri({ gatewayAddress: 'gw.example.com', networkId: '0123456789abcdef' }),
    assemblePeerInviteUri({ gatewayAddress: '[FD00::1]:19393', networkId: '0123456789abcdef' }),
    assemblePeerInviteUri({ gatewayAddress: 'https://zr.example.com', networkId: '0123456789abcdef' }),
  ]) {
    assert.equal(sample.ok, true)
    const authority = sample.inviteUri.slice(sample.inviteUri.indexOf('://') + 3).split('/')[0]
    assert.doesNotThrow(() => new URL(`ws://${authority}`), authority)
    assert.doesNotThrow(() => new URL(`http://${authority}`), authority)
  }
})

await test('assemblePeerInviteUri: an unencodable passphrase is a LOCAL refusal, not a crash (PC-15 fix1 R3)', () => {
  // A lone UTF-16 surrogate makes encodeURIComponent throw URIError; the
  // assembler must answer a refusal (the component shows its copy) instead
  // of throwing unhandled before the request try — and must NOT rewrite or
  // echo the secret.
  assert.deepEqual(
    assemblePeerInviteUri({ gatewayAddress: '10.0.0.1:4088', networkId: '0123456789abcdef', joinKey: 'ok\uD800lone' }),
    { ok: false, error: 'bad-adv-join-key' },
  )
  // The refusal never leaks the key material — the error is the static code.
  const refused = assemblePeerInviteUri({ gatewayAddress: '10.0.0.1:4088', networkId: '0123456789abcdef', joinKey: '\uD800' })
  assert.equal(JSON.stringify(refused).includes('uD800'), false)
  // Encodable passphrases (incl. surrogate PAIRS — real emoji) still work.
  const emoji = assemblePeerInviteUri({ gatewayAddress: '10.0.0.1:4088', networkId: '0123456789abcdef', joinKey: 'pass 🔑 word' })
  assert.equal(parseInviteUri(emoji.inviteUri)?.joinKey, 'pass 🔑 word')
})

// PC-11b: the pre-11a capacity wording is retired — the count mixed the
// discovered total into a mount-cap shape and the full note blamed the
// network cap. Their absence keeps the dictionaries from drifting back.
await test('the retired capacity keys are gone from both dictionaries (PC-11b)', () => {
  for (const [locale, dict] of [['zh', zh], ['en', en]]) {
    for (const key of ['wizard.overview.peerDevicesCount', 'wizard.overview.peerDevicesFull']) {
      assert.ok(!(key in dict), `${locale} must not carry the retired key ${key}`)
    }
  }
})

await test('the banned word 互通端 appears nowhere in either dictionary (PG-9-fix)', () => {
  for (const [locale, dict] of [['zh', zh], ['en', en]]) {
    for (const [key, value] of Object.entries(dict)) {
      assert.ok(!String(value).includes('互通端'), `${locale} ${key} must not use the banned word`)
    }
  }
})

console.log('check-wizard-ui: ok')
