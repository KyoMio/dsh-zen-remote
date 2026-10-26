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
  deriveClientWizardLights,
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

console.log('check-wizard-ui: ok')
