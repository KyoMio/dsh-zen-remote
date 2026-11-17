import assert from 'node:assert/strict'
import test from 'node:test'
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

test('initialStep and isWizardConfigured', () => {
  assert.equal(initialStep(undefined), 'pick')
  assert.equal(initialStep({ ok: true, mode: 'off' }), 'pick')
  for (const mode of ['caddy', 'external', 'cloudflared']) {
    assert.equal(initialStep({ ok: true, mode }), 'verify')
  }

  const baseWizardStatus = {
    ok: true, mode: 'off', domain: '', httpsPort: 443, publicUrl: '',
    cfTokenConfigured: false, tunnelTokenConfigured: false, caddyRunning: false,
    cloudflaredRunning: false, gatewayActualPort: 3088,
    lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null,
  }
  const base = {
    effectiveClient: false,
    wizardStatus: baseWizardStatus,
    pairedDeviceCount: 0,
    hasSavedHostConfig: false,
    tokenConfigured: false,
    clientServerUrl: '',
    clientState: undefined,
  }
  assert.equal(isWizardConfigured(base), false)
  assert.equal(isWizardConfigured({ ...base, wizardStatus: { ...baseWizardStatus, mode: 'external', publicUrl: 'https://dsh.example.com' } }), true)
  assert.equal(isWizardConfigured({ ...base, pairedDeviceCount: 1 }), true)
  assert.equal(isWizardConfigured({ ...base, hasSavedHostConfig: true }), true)
  assert.equal(isWizardConfigured({ ...base, effectiveClient: true, wizardStatus: undefined }), false)
  assert.equal(isWizardConfigured({ ...base, effectiveClient: true, wizardStatus: undefined, tokenConfigured: true, clientServerUrl: 'https://dsh.example.com', clientState: 'connected' }), true)
  assert.equal(isWizardConfigured({ ...base, effectiveClient: true, wizardStatus: undefined, pairedServerCount: 2 }), true)
  assert.equal(isWizardConfigured({ ...base, effectiveClient: true, wizardStatus: undefined, pairedServerCount: 0 }), false)
})

test('hostname/port validation, configureReadiness, and publicUrlFrom', () => {
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

  const caddy = { path: 'caddy', form: { domain: 'dsh.example.com', httpsPort: '8443', cfToken: 'tok', serverUrl: '' } }
  assert.deepEqual(configureReadiness(caddy.path, caddy.form), { ok: true, publicUrl: 'https://dsh.example.com:8443', httpsPort: 8443 })
  assert.equal(configureReadiness('caddy', { ...caddy.form, cfToken: '  ' }).error, 'missing-token')
  assert.equal(configureReadiness('cloudflared', { ...caddy.form, cfToken: '' }).error, 'missing-token')
  assert.equal(configureReadiness('caddy', { ...caddy.form, domain: 'a b' }).error, 'bad-domain')
  assert.equal(configureReadiness('caddy', { ...caddy.form, httpsPort: '0' }).error, 'bad-port')
  assert.deepEqual(
    configureReadiness('external', { domain: '', httpsPort: '', cfToken: '', serverUrl: 'https://dsh.example.com/' }),
    { ok: true, publicUrl: 'https://dsh.example.com', httpsPort: 443 },
  )
  assert.equal(configureReadiness('external', { domain: '', httpsPort: '', cfToken: '', serverUrl: 'http://dsh.example.com' }).error, 'bad-server-url')
  assert.equal(configureReadiness('external', { domain: '', httpsPort: '', cfToken: '', serverUrl: 'https://x/app' }).error, 'bad-server-url')
  assert.equal(configureReadiness('external', { domain: '', httpsPort: '', cfToken: '', serverUrl: 'not a url' }).error, 'bad-server-url')
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

test('deriveClientWizardLights, derivePeerDiscoveryLight, derivePeerWizardLights, derivePeerOverviewSummary, deriveClientServerLights', () => {
  assert.deepEqual(deriveClientWizardLights({ tokenConfigured: false, clientState: undefined }), { credential: 'pending', connection: 'pending', sync: 'pending' })
  assert.deepEqual(deriveClientWizardLights({ tokenConfigured: true, clientState: 'connected' }), { credential: 'pass', connection: 'pass', sync: 'pass' })
  assert.deepEqual(deriveClientWizardLights({ tokenConfigured: false, clientState: 'revoked' }), { credential: 'fail', connection: 'fail', sync: 'pending' })
  assert.deepEqual(deriveClientWizardLights({ tokenConfigured: true, clientState: 'unreachable' }), { credential: 'pass', connection: 'fail', sync: 'pending' })

  const light = (gatewayState, sync, mismatchCount = 0, limitReached) =>
    derivePeerDiscoveryLight({
      gatewayState,
      mismatchCount,
      ...(limitReached !== undefined ? { limitReached } : {}),
      ...(sync !== undefined ? { sync } : {}),
    })

  assert.deepEqual(light('authorized', { readyCount: 2, mountedCandidateCount: 2, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 }), { light: 'pass', copyKey: 'wizard.peer.syncReady' })
  assert.deepEqual(light('authorized', { readyCount: 0, mountedCandidateCount: 0, candidateCount: 0, ignoredCount: 0, mismatchCount: 0 }), { light: 'pass', copyKey: 'wizard.peer.syncWaitingPeers' })
  assert.deepEqual(light('authorized', { readyCount: 0, mountedCandidateCount: 0, candidateCount: 0, ignoredCount: 2, mismatchCount: 0 }), { light: 'pass', copyKey: 'wizard.peer.syncIgnored' })
  assert.deepEqual(light('authorized', { readyCount: 1, mountedCandidateCount: 1, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 }, 0, true), { light: 'pass', copyKey: 'wizard.peer.syncReady' })
  assert.deepEqual(light('authorized', { readyCount: 0, mountedCandidateCount: 0, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 }, 0, true), { light: 'pass', copyKey: 'wizard.peer.syncReady' })
  assert.deepEqual(light('authorized', { readyCount: 1, mountedCandidateCount: 2, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 }), { light: 'pending', copyKey: 'wizard.peer.syncPartialReady', copyParams: { ready: '1', total: '2' } })
  assert.deepEqual(light('authorized', { readyCount: 0, mountedCandidateCount: 0, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 }, 0, false), { light: 'pending', copyKey: 'wizard.peer.syncPartialReady', copyParams: { ready: '0', total: '2' } })
  assert.deepEqual(light('authorized', { readyCount: 1, mountedCandidateCount: 1, candidateCount: 1, ignoredCount: 0, mismatchCount: 1 }, 1), { light: 'pass', copyKey: 'wizard.peer.syncReady' })
  assert.deepEqual(light('authorized', { readyCount: 0, mountedCandidateCount: 0, candidateCount: 0, ignoredCount: 0, mismatchCount: 1 }, 1), { light: 'fail', copyKey: 'wizard.peer.syncBlocked' })
  assert.equal(light('authorized', undefined, 1).light, 'fail')
  for (const gateway of ['connecting', 'pending-approval', 'mismatch', 'paused', 'revoked', 'offline', 'identity-error']) {
    assert.deepEqual(light(gateway, { readyCount: 2, mountedCandidateCount: 2, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 }), { light: 'pending', copyKey: 'wizard.peer.syncGatewayHold' })
  }
  assert.deepEqual(light('authorized', undefined), { light: 'pending', copyKey: 'wizard.peer.syncGatewayHold' })
  assert.equal(light('unconfigured', undefined).copyKey, 'wizard.peer.notJoined')

  assert.equal(derivePeerWizardLights({ identityReady: false, gatewayState: 'unconfigured', mismatchCount: 0 }).identity, 'pending')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'unconfigured', mismatchCount: 0 }).identity, 'pass')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0 }).admission, 'pass')
  for (const amber of ['pending-approval', 'connecting', 'offline', 'unconfigured']) {
    assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: amber, mismatchCount: 0 }).admission, 'pending')
  }
  for (const red of ['mismatch', 'revoked', 'paused', 'identity-error']) {
    assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: red, mismatchCount: 0 }).admission, 'fail')
  }
  assert.deepEqual(derivePeerWizardLights({ identityReady: false, gatewayState: 'identity-error', mismatchCount: 0 }), { identity: 'fail', admission: 'fail', discovery: 'pending' })
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0, sync: { readyCount: 2, mountedCandidateCount: 2, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 } }).discovery, 'pass')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0, sync: { readyCount: 1, mountedCandidateCount: 2, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 } }).discovery, 'pending')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0, sync: { readyCount: 0, mountedCandidateCount: 0, candidateCount: 0, ignoredCount: 0, mismatchCount: 0 } }).discovery, 'pass')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0, sync: { readyCount: 0, mountedCandidateCount: 0, candidateCount: 0, ignoredCount: 0, mismatchCount: 1 } }).discovery, 'fail')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 0 }).discovery, 'pending')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'authorized', mismatchCount: 1 }).discovery, 'fail')
  assert.equal(derivePeerWizardLights({ identityReady: true, gatewayState: 'connecting', mismatchCount: 0, sync: { readyCount: 2, mountedCandidateCount: 2, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 } }).discovery, 'pending')

  const pRow = (path, over = {}) => ({
    nodeId: over.nodeId ?? 'aaaa1111', name: over.name ?? '书房电脑',
    mounted: over.mounted ?? true, path, rttMs: over.rttMs ?? 3, ...over,
  })
  assert.deepEqual(derivePeerOverviewSummary([], {}), {
    totalCount: 0, directCount: 0, relayCount: 0, mismatchCount: 0, offlineCount: 0,
    mountedCount: undefined, maxServers: undefined, maxPeers: undefined, limitReached: undefined,
    connectionLight: 'pending', devicesLight: 'pending',
  })
  const mix = derivePeerOverviewSummary([
    pRow('lan', { nodeId: 'a' }), pRow('p2p', { nodeId: 'b', mounted: false }),
    pRow('relay', { nodeId: 'c' }), pRow('offline', { nodeId: 'd', mounted: false, rttMs: null }),
  ], { maxPeers: 16, maxServers: 3, mountedCount: 2, limitReached: false })
  assert.equal(mix.totalCount, 4)
  assert.equal(mix.directCount, 2)
  assert.equal(mix.relayCount, 1)
  assert.equal(mix.offlineCount, 1)
  assert.equal(mix.mountedCount, 2)
  assert.equal(mix.maxServers, 3)
  assert.equal(mix.maxPeers, 16)
  assert.equal(mix.limitReached, false)
  assert.equal(mix.connectionLight, 'pending')
  assert.equal(mix.devicesLight, 'pass')
  assert.equal(derivePeerOverviewSummary([pRow('lan', { nodeId: 'a' }), pRow('p2p', { nodeId: 'b' }), pRow('relay', { nodeId: 'c' })], { maxPeers: 8, maxServers: 3, mountedCount: 1, limitReached: false }).connectionLight, 'pass')
  const full = derivePeerOverviewSummary(Array.from({ length: 3 }, (_, i) => pRow('lan', { nodeId: `node${i}` })), { maxPeers: 16, maxServers: 3, mountedCount: 3, limitReached: true })
  assert.equal(full.limitReached, true)
  assert.equal(full.devicesLight, 'fail')
  assert.equal(full.connectionLight, 'pass')
  assert.equal(derivePeerOverviewSummary([pRow('lan'), pRow('lan', { nodeId: 'b' }), pRow('lan', { nodeId: 'c', mounted: false })], { maxPeers: 16, maxServers: 2, mountedCount: 2, limitReached: true }).devicesLight, 'fail')
  const overCap = derivePeerOverviewSummary(Array.from({ length: 5 }, (_, i) => pRow('lan', { nodeId: `node${i}` })), { maxPeers: 16, maxServers: 3, mountedCount: 5, limitReached: true })
  assert.equal(overCap.limitReached, true)
  assert.equal(overCap.mountedCount, 5)
  assert.equal(overCap.devicesLight, 'fail')
  const unknown = derivePeerOverviewSummary([pRow('lan')], {})
  assert.equal(unknown.mountedCount, undefined)
  assert.equal(unknown.maxServers, undefined)
  assert.equal(unknown.limitReached, undefined)
  assert.equal(unknown.devicesLight, 'pending')
  assert.equal(derivePeerOverviewSummary([], { mountedCount: 2, maxServers: 3 }).limitReached, false)
  assert.equal(derivePeerOverviewSummary([], { mountedCount: 3, maxServers: 3 }).limitReached, true)
  assert.equal(derivePeerOverviewSummary([], { mountedCount: 2 }).limitReached, undefined)
  const blocked = derivePeerOverviewSummary([pRow('lan', { nodeId: 'a' }), pRow('mismatch', { nodeId: 'b', mounted: false, rttMs: null })], {})
  assert.equal(blocked.mismatchCount, 1)
  assert.equal(blocked.devicesLight, 'fail')
  assert.equal(blocked.connectionLight, 'fail')
  const soloJoined = derivePeerOverviewSummary([], { maxPeers: 8, maxServers: 3, mountedCount: 0, limitReached: false }, { includeSelf: true })
  assert.equal(soloJoined.totalCount, 1)
  assert.equal(soloJoined.devicesLight, 'pass')
  assert.equal(soloJoined.connectionLight, 'pending')
  assert.equal(soloJoined.limitReached, false)
  assert.equal(soloJoined.mountedCount, 0)

  const sRow = (state, extra = {}) => ({
    entryId: 'e1', serverId: 's1', serverUrl: 'http://x.local:3088', serverName: 'srv',
    displayName: 'srv', state, nextRetryAt: undefined, lastError: '', compat: undefined, pluginBridge: [], ...extra,
  })
  assert.deepEqual(deriveClientServerLights(undefined), { credential: 'pending', connection: 'pending', sync: 'pending' })
  assert.deepEqual(deriveClientServerLights(sRow('connected')), { credential: 'pass', connection: 'pass', sync: 'pass' })
  assert.deepEqual(deriveClientServerLights(sRow('connected', { compat: { mismatchedGroups: ['session'], recentCalls: [] } })), { credential: 'pass', connection: 'pass', sync: 'fail' })
  assert.deepEqual(deriveClientServerLights(sRow('revoked')), { credential: 'fail', connection: 'fail', sync: 'pending' })
  assert.deepEqual(deriveClientServerLights(sRow('unreachable')), { credential: 'pass', connection: 'fail', sync: 'pending' })
  assert.deepEqual(deriveClientServerLights(sRow('incompatible')), { credential: 'pass', connection: 'fail', sync: 'pending' })
})

test('formSeedOf, upstreamPortOf, deriveWizardLights, failure copies, route constants, pairingSecondsLeft, registerGatewayWizard, targetHostSaveRole', () => {
  const configured = {
    ok: true, mode: 'caddy', domain: 'dsh.example.com', httpsPort: 8443,
    publicUrl: 'https://dsh.example.com:8443', cfTokenConfigured: true, tunnelTokenConfigured: false,
    caddyRunning: false, cloudflaredRunning: false, gatewayActualPort: 4088,
    lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null,
  }
  assert.deepEqual(formSeedOf(configured), {
    domain: 'dsh.example.com', httpsPort: '8443', serverUrl: 'https://dsh.example.com:8443', path: 'caddy',
  })
  assert.deepEqual(formSeedOf({ ...configured, mode: 'off', domain: '', httpsPort: 443, publicUrl: '' }), {
    domain: '', httpsPort: '', serverUrl: '', path: undefined,
  })
  assert.deepEqual(formSeedOf(undefined).path, undefined)

  assert.equal(upstreamPortOf(undefined), 3088)
  assert.equal(upstreamPortOf({ ...configured, gatewayActualPort: null }), 3088)
  assert.equal(upstreamPortOf({ ...configured, gatewayActualPort: 4088 }), 4088)
  assert.equal(upstreamPortOf({ ...configured, gatewayActualPort: 0 }), 3088)

  assert.deepEqual(deriveWizardLights({ gatewayReachable: false, poll: undefined }), { gateway: 'fail', publicUrl: 'pending', pairing: 'pending' })
  assert.deepEqual(deriveWizardLights({ gatewayReachable: true, poll: undefined }), { gateway: 'pass', publicUrl: 'pending', pairing: 'pending' })
  for (const result of ['not-started', 'pending', 'stale', 'code-expired']) {
    const lights = deriveWizardLights({ gatewayReachable: true, poll: { result } })
    assert.equal(lights.publicUrl, 'pending')
    assert.equal(lights.pairing, 'pending')
  }
  assert.deepEqual(deriveWizardLights({ gatewayReachable: true, poll: { result: 'pass', deviceId: 'd1', at: 1 } }), { gateway: 'pass', publicUrl: 'pass', pairing: 'pass' })
  assert.deepEqual(deriveWizardLights({ gatewayReachable: true, poll: { result: 'cookie-insecure', deviceId: 'd1' } }), { gateway: 'pass', publicUrl: 'fail', pairing: 'fail' })
  assert.deepEqual(deriveWizardLights({ gatewayReachable: true, poll: { result: 'pending' }, startResult: { ok: true, pairingCode: 'ABCD1234', publicUrl: 'https://dsh.example.com', expiresAt: 1000 } }), { gateway: 'pass', publicUrl: 'pass', pairing: 'pending' })
  assert.deepEqual(deriveWizardLights({ gatewayReachable: true, poll: undefined, startResult: { ok: false, reason: 'probe-failed', detail: { kind: 'reached', root: 'unexpected-401', admin: 'gateway-admin-403' } } }), { gateway: 'pass', publicUrl: 'fail', pairing: 'pending' })

  assert.equal(caddyFailureCopy('missing-token').key, 'wizard.caddy.failMissingToken')
  assert.equal(caddyFailureCopy('already-running').key, 'wizard.caddy.failAlreadyRunning')
  assert.deepEqual(caddyFailureCopy('bad-config', 'bad-domain'), { key: 'wizard.caddy.failBadConfig', params: { detail: 'bad-domain' } })
  const download = caddyFailureCopy('download-failed', undefined, 'https://caddyserver.com/download')
  assert.equal(download.key, 'wizard.caddy.failDownload')
  assert.equal(download.installUrl, 'https://caddyserver.com/download')
  assert.equal(caddyFailureCopy('validate-failed').key, 'wizard.caddy.failValidate')
  assert.equal(caddyFailureCopy('spawn-failed').key, 'wizard.caddy.failSpawn')
  assert.equal(caddyFailureCopy('something-new').key, 'wizard.caddy.failSpawn')

  assert.equal(WIZARD_CF_TOKEN_ROUTE, HOST_CF_TOKEN_ROUTE)
  assert.equal(WIZARD_CADDY_START_ROUTE, HOST_CADDY_START_ROUTE)
  assert.equal(WIZARD_CADDY_STOP_ROUTE, HOST_CADDY_STOP_ROUTE)
  assert.equal(WIZARD_CADDY_STATUS_ROUTE, HOST_CADDY_STATUS_ROUTE)
  assert.equal(WIZARD_TUNNEL_TOKEN_ROUTE, HOST_TUNNEL_TOKEN_ROUTE)
  assert.equal(WIZARD_TUNNEL_CHECK_ROUTE, HOST_TUNNEL_CHECK_ROUTE)
  assert.equal(WIZARD_TUNNEL_SETUP_ROUTE, HOST_TUNNEL_SETUP_ROUTE)
  assert.equal(WIZARD_TUNNEL_STATUS_ROUTE, HOST_TUNNEL_STATUS_ROUTE)
  assert.equal(WIZARD_TUNNEL_STOP_ROUTE, HOST_TUNNEL_STOP_ROUTE)

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
    assert.equal(copy.key, key)
    if (reason === 'spawn-failed' || reason === 'dns-conflict') assert.deepEqual(copy.params, { detail: 'd' })
  }
  assert.deepEqual(tunnelFailureCopy('anything-new'), { key: 'wizard.tunnel.api', params: { detail: 'anything-new' } })
  assert.deepEqual(tunnelCheckCopy({ ok: true, onCloudflare: true, zoneId: 'z' }), { key: 'wizard.check.okOnCf', tone: 'ok' })
  assert.equal(tunnelCheckCopy({ ok: true, onCloudflare: false, zoneId: null }).tone, 'error')
  assert.equal(tunnelCheckCopy({ ok: false, reason: 'network' }).key, 'wizard.check.failed')

  const now = 1_000_000
  assert.equal(pairingSecondsLeft(now + 59_500, now), 60)
  assert.equal(pairingSecondsLeft(now + 1000, now), 1)
  assert.equal(pairingSecondsLeft(now, now), 0)
  assert.equal(pairingSecondsLeft(now - 5000, now), 0)

  const slotsInjected = []
  const slotsRegistered = []
  let formsCallback
  registerGatewayWizard({
    effect: () => () => {},
    inject(services, cb) { if (services.includes('configForms')) formsCallback = cb },
  }, () => null)
  assert.equal(typeof formsCallback, 'function')
  const formsEffects = []
  formsCallback({
    effect(producer, label) { formsEffects.push({ label, producer }); return () => {} },
    configForms: { get: () => ({ getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true }), subscribe: () => () => {}, mutate: async () => true }) },
    slots: {
      inject(name, factory) { slotsInjected.push(name); factory(); return () => {} },
      register(options, component) { slotsRegistered.push({ options, component }); return () => {} },
    },
  })
  const sectionEffect = formsEffects.find((entry) => entry.label === 'dsh-zen-remote: wizard section')
  assert.ok(sectionEffect !== undefined)
  sectionEffect.producer()
  assert.deepEqual(slotsInjected, ['plugins.bundle.config'])
  assert.equal(slotsRegistered.length, 1)
  assert.equal(slotsRegistered[0].options.name, 'plugins.bundle.config')
  assert.equal(slotsRegistered[0].options.key, WIZARD_BUNDLE_KEY)
  assert.equal(slotsRegistered[0].options.key, 'dsh-zen-remote')

  assert.equal(targetHostSaveRole(false), 'host')
  assert.equal(targetHostSaveRole(true), 'peer')
})

test('zh/en carry identical key sets, wizard keys + card step contracts + retired keys + banned copy', () => {
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
    'wizard.role.peer', 'wizard.role.peerDesc', 'wizard.role.peerPickNote',
    'wizard.peer.modeInvite', 'wizard.peer.modeGateway',
    'wizard.peer.inviteUri', 'wizard.peer.inviteUriHint', 'wizard.peer.inviteUriPlaceholder',
    'wizard.peer.gatewayUrl', 'wizard.peer.gatewayUrlHint', 'wizard.peer.gatewayUrlPlaceholder',
    'wizard.peer.selectNetwork', 'wizard.peer.selectNetworkHint', 'wizard.peer.requestJoin',
    'wizard.peer.advancedSummary', 'wizard.peer.advancedGateway', 'wizard.peer.advancedGatewayPlaceholder',
    'wizard.peer.advancedGatewayHint', 'wizard.peer.advancedNetworkId', 'wizard.peer.advancedNetworkIdPlaceholder',
    'wizard.peer.advancedNetworkIdHint', 'wizard.peer.advancedJoinKey', 'wizard.peer.advancedJoinKeyHint',
    'wizard.peer.advancedBadGateway', 'wizard.peer.advancedBadNetworkId',
    'wizard.peer.advancedBadJoinKey', 'wizard.peer.inviteUriPausedHint',
    'wizard.peer.join', 'wizard.peer.joining', 'wizard.peer.rejoin', 'wizard.peer.leave',
    'wizard.peer.leaveConfirm',
    'wizard.peer.lightIdentity', 'wizard.peer.lightAdmission', 'wizard.peer.lightDiscovery',
    'wizard.peer.pendingApproval', 'wizard.peer.joinFailed', 'wizard.peer.joinInvalid',
    'wizard.peer.joinGatewayInvalid', 'wizard.peer.joinGatewayUnreachable',
    'wizard.peer.joinNoNetwork', 'wizard.peer.joinManualDisabled',
    'wizard.peer.gatewayEmail', 'wizard.peer.gatewayEmailPlaceholder',
    'wizard.peer.gatewayPassword', 'wizard.peer.gatewayPasswordPlaceholder',
    'wizard.peer.joinCredentialsRequired', 'wizard.peer.joinAuthFailed',
    'wizard.peer.joinSelectionExpired', 'wizard.peer.joinRateLimited',
    'wizard.peer.revokedBanner', 'wizard.peer.dismissRevoked', 'wizard.peer.leaveOfflineNote',
    'wizard.peer.connecting', 'wizard.peer.offline', 'wizard.peer.revoked', 'wizard.peer.mismatch',
    'wizard.peer.notJoined',
    'wizard.overview.peerNodeLabel', 'wizard.overview.peerNetworkLabel', 'wizard.overview.peerNetworkNone',
    'wizard.overview.peerConnLabel', 'wizard.overview.peerConnSummary', 'wizard.overview.peerConnNone',
    'wizard.overview.peerDevicesLabel',
    'wizard.overview.peerMountCount', 'wizard.overview.peerNetworkCount', 'wizard.overview.peerMountedCount',
    'wizard.overview.peerMountFull',
    'wizard.overview.peerNetworkCapNote', 'wizard.overview.peerMountedDiscovered', 'wizard.overview.peerDiscoveredCount',
    'wizard.peer.devicesModalTitle', 'wizard.peer.devicesModalSubtitle', 'wizard.peer.devicesModalEmpty',
    'wizard.peer.devicePathLan', 'wizard.peer.devicePathP2p', 'wizard.peer.devicePathRelay',
    'wizard.peer.devicePathRelayDemoted',
    'wizard.peer.devicePathOffline', 'wizard.peer.devicePathMismatch', 'wizard.peer.deviceRtt',
    'wizard.peer.deviceMount', 'wizard.peer.deviceIgnore',
    'wizard.peer.mismatchNote', 'wizard.peer.trustNew', 'wizard.peer.trustOk', 'wizard.peer.actionFailed',
    'wizard.peer.pwaSectionTitle', 'wizard.peer.switchRole', 'wizard.peer.pairPhone',
    'wizard.peer.configurePhoneAccess', 'wizard.peer.managePairedDevices',
    'settings.peer.title', 'settings.peer.subtitle', 'settings.peer.notConfigured',
  ]

  for (const [prefix, expected] of Object.entries({ tokenStep: 8, migrateStep: 6, portForwardStep: 4 })) {
    const keys = Object.keys(zh).filter((key) => key.startsWith(`wizard.card.${prefix}`))
    assert.equal(keys.length, expected)
    for (let i = 1; i <= expected; i++) assert.ok(keys.includes(`wizard.card.${prefix}${i}`))
  }
  assert.ok(zh['wizard.card.portForwardStep3'].includes('{port}'))
  assert.ok(en['wizard.card.portForwardStep3'].includes('{port}'))

  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of WIZARD_KEYS) {
    assert.equal(typeof zh[key], 'string', `zh missing ${key}`)
    assert.equal(typeof en[key], 'string', `en missing ${key}`)
  }

  for (const [locale, dict] of [['zh', zh], ['en', en]]) {
    for (const key of ['wizard.overview.peerDevicesCount', 'wizard.overview.peerDevicesFull']) {
      assert.ok(!(key in dict), `${locale} must not carry retired ${key}`)
    }
    for (const [key, value] of Object.entries(dict)) {
      assert.ok(!String(value).includes('互通端'), `${locale} ${key} uses banned word`)
    }
  }
})

test('browser snippet mirrors are byte-identical to host templates', () => {
  const SNIPPET_INPUT = { domain: 'dsh.example.com', upstreamHost: '127.0.0.1', upstreamPort: 4088 }
  assert.equal(nginxSnippetText(SNIPPET_INPUT), nginxSnippet(SNIPPET_INPUT).text)
  assert.equal(caddySnippetText(SNIPPET_INPUT), caddySnippet(SNIPPET_INPUT).text)
  assert.deepEqual(luckyStepTexts(SNIPPET_INPUT), luckySteps(SNIPPET_INPUT).steps)
  const enInput = { ...SNIPPET_INPUT, lang: 'en' }
  assert.equal(nginxSnippetText(enInput), nginxSnippet(enInput).text)
  assert.equal(caddySnippetText(enInput), caddySnippet(enInput).text)
  assert.deepEqual(luckyStepTexts(enInput), luckySteps(enInput).steps)
  for (const bad of [{ ...SNIPPET_INPUT, domain: 'a b' }, { ...SNIPPET_INPUT, upstreamHost: 'x/y' }, { ...SNIPPET_INPUT, upstreamPort: 0 }]) {
    assert.equal(nginxSnippetText(bad), null)
    assert.equal(caddySnippetText(bad), null)
    assert.equal(luckyStepTexts(bad), null)
  }
})

test('QR encoder produces decodable RS + BCH symbols across versions', () => {
  const EXP = new Uint8Array(512)
  const LOG = new Uint8Array(256)
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])
  const syndromes = (codewords, eccLen) => {
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

  for (const text of ['https://dsh.example.com', 'HELLO', 'x'.repeat(106), 'a']) {
    const matrix = qrMatrix(text)
    assert.ok(matrix !== null)
    const n = matrix.length
    assert.ok([21, 25, 29, 33, 37].includes(n))

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
          assert.equal(matrix[r0 + dr][c0 + dc], FINDER[dr][dc] === 1)
        }
      }
    }
    for (let i = 8; i < n - 8; i++) assert.equal(matrix[6][i], i % 2 === 0)
    for (let i = 8; i < n - 8; i++) assert.equal(matrix[i][6], i % 2 === 0)
    assert.equal(matrix[n - 8][8], true)

    const decodeFormat = (bits) => {
      let value = 0
      for (let i = 0; i < 15; i++) value |= (bits[i] ? 1 : 0) << i
      assert.equal(value, 0x77c4)
      const unmasked = value ^ 0x5412
      const data = unmasked >> 10
      let rem = data << 10
      for (let i = 4; i >= 0; i--) if ((rem >>> (i + 10)) & 1) rem ^= 0x537 << i
      assert.equal(((data << 10) | rem) ^ 0x5412, value)
      assert.equal(data >> 3, 0b01)
      assert.equal(data & 0b111, 0)
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
    assert.deepEqual(formatBits2, formatBits)

    const reserved = Array.from({ length: n }, () => new Array(n).fill(false))
    const mark = (r, c) => { if (r >= 0 && r < n && c >= 0 && c < n) reserved[r][c] = true }
    for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8) }
    for (let i = 0; i < 8; i++) { mark(n - 1 - i, 8); mark(8, n - 1 - i) }
    mark(n - 8, 8)
    for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) mark(r0 + dr, c0 + dc)
      }
    }
    for (let i = 0; i < n; i++) { mark(6, i); mark(i, 6) }
    const CENTERS = { 25: [6, 18], 29: [6, 22], 33: [6, 26], 37: [6, 30] }[n]
    if (CENTERS !== undefined) {
      const windows = [[0, 0], [0, n - 7], [n - 7, 0]].map(([r0, c0]) => [r0 - 1, r0 + 7, c0 - 1, c0 + 7])
      for (const r of CENTERS) {
        for (const c of CENTERS) {
          if (windows.some(([r1, r2, c1, c2]) => r >= r1 && r <= r2 && c >= c1 && c <= c2)) continue
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc)
          }
        }
      }
    }

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
    assert.equal(codewords.length, dataLen + eccLen)
    for (const s of syndromes(codewords, eccLen)) assert.equal(s, 0)

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
    assert.equal(readBits(4), 0b0100)
    const length = readBits(8)
    const payload = new TextDecoder().decode(Uint8Array.from({ length }, () => readBits(8)))
    assert.equal(payload, text)
  }

  assert.equal(qrMatrix('x'.repeat(107)), null)
})
