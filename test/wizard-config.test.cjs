/* dsh-zen-remote · gateway-wizard config fields + status projection (GW-1)
 *
 * The five ingress fields resolve through the same four-layer contract as
 * every other field (env absent by design: the wizard's own routes write
 * them on this machine, never the environment), and `projectWizardStatus`
 * is the security boundary between the wizard back-end and the browser:
 * whatever goes in, the answer carries no token material and no file paths.
 * Drives the BUILT lib/config.js / lib/wizard/status.js / lib/admin-routes.js
 * (same reason as config-resolve.test.cjs: src/ uses relative specifiers
 * Node's strip-only type stripping cannot map).
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'lib', rel)).href)

const INGRESS_FIELDS = ['ingressMode', 'ingressDomain', 'ingressHttpsPort', 'ingressAcmeEmail', 'ingressPublicUrl']

// --- resolveConfig: the five new fields -------------------------------------

test('the ingress fields resolve with their defaults on an empty row', async () => {
  const { resolveConfig } = await load('config.js')
  const { values, sources } = resolveConfig({}, {}, {})
  assert.equal(values.ingressMode, 'off')
  assert.equal(values.ingressDomain, '')
  assert.equal(values.ingressHttpsPort, 443)
  assert.equal(values.ingressAcmeEmail, '')
  assert.equal(values.ingressPublicUrl, '')
  for (const key of INGRESS_FIELDS) {
    assert.equal(sources[key], 'default', `sources.${key} must name a layer`)
  }
})

test('legal row values win per field, sources tracked', async () => {
  const { resolveConfig } = await load('config.js')
  const row = {
    ingressMode: 'caddy',
    ingressDomain: 'dsh.example.com',
    ingressHttpsPort: 8443,
    ingressAcmeEmail: 'admin@example.com',
    ingressPublicUrl: 'https://dsh.example.com:8443',
  }
  const { values, sources } = resolveConfig(row, {}, {})
  assert.equal(values.ingressMode, 'caddy')
  assert.equal(values.ingressDomain, 'dsh.example.com')
  assert.equal(values.ingressHttpsPort, 8443)
  assert.equal(values.ingressAcmeEmail, 'admin@example.com')
  assert.equal(values.ingressPublicUrl, 'https://dsh.example.com:8443')
  for (const key of INGRESS_FIELDS) assert.equal(sources[key], 'row')
})

test('an illegal ingressMode makes its layer transparent, falling to off — and the file layer can rescue it', async () => {
  const { resolveConfig } = await load('config.js')
  assert.equal(resolveConfig({ ingressMode: 'foo' }, {}, {}).values.ingressMode, 'off')
  assert.equal(resolveConfig({ ingressMode: 'foo' }, {}, {}).sources.ingressMode, 'default')
  assert.equal(resolveConfig({ ingressMode: 'foo' }, { ingressMode: 'cloudflared' }, {}).values.ingressMode, 'cloudflared', 'a legal file value answers when the row wrote junk')
  assert.equal(resolveConfig({ ingressMode: 'Caddy' }, {}, {}).values.ingressMode, 'off', 'the enum is exact')
  assert.equal(resolveConfig({ ingressMode: 42 }, {}, {}).values.ingressMode, 'off')
  // Off-enum but exact members are all legal.
  for (const mode of ['off', 'caddy', 'external', 'cloudflared']) {
    assert.equal(resolveConfig({ ingressMode: mode }, {}, {}).values.ingressMode, mode)
  }
})

test('ingressHttpsPort accepts only [1, 65535]; the file layer keeps its digit-string leniency', async () => {
  const { resolveConfig } = await load('config.js')
  assert.equal(resolveConfig({ ingressHttpsPort: 1 }, {}, {}).values.ingressHttpsPort, 1, 'the lower bound is inclusive')
  assert.equal(resolveConfig({ ingressHttpsPort: 65535 }, {}, {}).values.ingressHttpsPort, 65535, 'the upper bound is inclusive')
  for (const bad of [0, -1, 65536, 443.5, '443', Number.NaN]) {
    const r = resolveConfig({ ingressHttpsPort: bad }, {}, {})
    assert.equal(r.values.ingressHttpsPort, 443, `ingressHttpsPort ${String(bad)} must fall to the default`)
    assert.equal(r.sources.ingressHttpsPort, 'default')
  }
  const viaFile = resolveConfig({}, { ingressHttpsPort: '8443' }, {})
  assert.equal(viaFile.values.ingressHttpsPort, 8443, 'a hand-edited digit string keeps working at the file layer')
  assert.equal(viaFile.sources.ingressHttpsPort, 'file')
})

test('ingressAcmeEmail must look like an email', async () => {
  const { resolveConfig } = await load('config.js')
  assert.equal(resolveConfig({ ingressAcmeEmail: 'a@b.c' }, {}, {}).values.ingressAcmeEmail, 'a@b.c', 'the minimal dotted shape is legal')
  assert.equal(resolveConfig({ ingressAcmeEmail: 'admin@mail.example.com' }, {}, {}).values.ingressAcmeEmail, 'admin@mail.example.com')
  for (const bad of ['not-an-email', 'a@b', 'a b@c.d', 'a@b.c d', 42, '']) {
    assert.equal(resolveConfig({ ingressAcmeEmail: bad }, {}, {}).values.ingressAcmeEmail, '', `acmeEmail ${JSON.stringify(bad)} must fall to the default`)
  }
})

test('ingressDomain must be a bare hostname: no scheme, path, whitespace, braces, newline or port (GW-fix-1/M1)', async () => {
  const { resolveConfig } = await load('config.js')
  for (const ok of ['dsh.example.com', 'mybox', 'a-b.cd', '192.168.1.10', 'a.b.c.d.e']) {
    const r = resolveConfig({ ingressDomain: ok }, {}, {})
    assert.equal(r.values.ingressDomain, ok, `${ok} is a legal bare hostname`)
    assert.equal(r.sources.ingressDomain, 'row')
  }
  // The ticket's five illegal shapes, plus the adjacent ones the grammar
  // rules out: any of these flowing into generated Caddyfile/DNS material
  // would break the config or smuggle an injection.
  for (const bad of [
    'https://foo', // scheme
    'foo/path', // path
    'foo bar', // space
    'foo\nbar', // newline
    'foo{}', // braces
    'foo:443', // port
    'HTTP://foo', // scheme, any case
    'foo..bar', // empty label
    '-foo', 'foo-', // hyphen at a label edge
    `${'a'.repeat(64)}.com`, // label over 63
    `${`${'a'.repeat(63)}.`.repeat(4)}com`, // total over 253
    'pünct.example', // non-ASCII (must arrive punycoded)
    '   ', 42, '', null,
  ]) {
    const r = resolveConfig({ ingressDomain: bad }, {}, {})
    assert.equal(r.values.ingressDomain, '', `ingressDomain ${JSON.stringify(String(bad).slice(0, 20))} must fall to the default`)
    assert.equal(r.sources.ingressDomain, 'default')
  }
  // A legal file value still answers when the row wrote junk.
  const rescued = resolveConfig({ ingressDomain: 'foo{}' }, { ingressDomain: 'file.example.com' }, {})
  assert.equal(rescued.values.ingressDomain, 'file.example.com')
  assert.equal(resolveConfig({ ingressDomain: 'dsh.example.com' }, {}, {}).values.ingressDomain, 'dsh.example.com')
})

test('ingressPublicUrl accepts only an http(s) origin: any path, query, fragment or userinfo is illegal', async () => {
  const { resolveConfig } = await load('config.js')
  for (const ok of ['https://dsh.example.com', 'https://dsh.example.com:8443', 'http://203.0.113.9:8080', 'https://dsh.example.com/']) {
    assert.equal(resolveConfig({ ingressPublicUrl: ok }, {}, {}).values.ingressPublicUrl, ok, `${ok} is a legal origin`)
  }
  for (const bad of ['https://dsh.example.com/app', 'https://dsh.example.com/?x=1', 'https://dsh.example.com/#frag', 'ftp://dsh.example.com', 'javascript:alert(1)', 'dsh.example.com', 'https://user:pw@dsh.example.com', 42, '']) {
    assert.equal(resolveConfig({ ingressPublicUrl: bad }, {}, {}).values.ingressPublicUrl, '', `publicUrl ${JSON.stringify(bad)} must fall to the default`)
  }
})

test('the ingress fields unwrap volatile loader references like every row field', async () => {
  const { resolveConfig, Config } = await load('config.js')
  const row = Config({
    ingressMode: 'external',
    ingressDomain: 'box.example.com',
    ingressHttpsPort: 443,
    ingressAcmeEmail: 'acme@example.com',
    ingressPublicUrl: 'https://box.example.com',
  })
  const resolved = resolveConfig(row, {}, {})
  assert.equal(resolved.values.ingressMode, 'external')
  assert.equal(resolved.values.ingressDomain, 'box.example.com')
  assert.equal(resolved.values.ingressAcmeEmail, 'acme@example.com')
  // Live reads: a changed getter must change the next resolution.
  const updated = resolveConfig({ ...row, ingressMode: { get: () => 'cloudflared' } }, {}, {})
  assert.equal(updated.values.ingressMode, 'cloudflared')
})

test('the Config schema declares the five fields, all volatile', async () => {
  const { Config } = await load('config.js')
  for (const key of INGRESS_FIELDS) {
    assert.ok(key in Config.dict, `Config.${key} must exist`)
    assert.equal(Config.dict[key].meta?.volatile, true, `Config.${key} must be volatile`)
  }
})

test('RESTART_FIELDS stays free of the ingress fields', async () => {
  const { RESTART_FIELDS } = await load('restart-fields.js')
  for (const key of INGRESS_FIELDS) {
    assert.ok(!RESTART_FIELDS.includes(key), `${key} must not reload the row`)
  }
})

// --- projectWizardStatus -----------------------------------------------------

test('the empty projection is the honest not-started state', async () => {
  const { projectWizardStatus } = await load('wizard/status.js')
  assert.deepEqual(projectWizardStatus(), {
    ok: true,
    mode: 'off',
    domain: '',
    httpsPort: 443,
    publicUrl: '',
    cfTokenConfigured: false,
    tunnelTokenConfigured: false,
    caddyRunning: false,
    cloudflaredRunning: false,
    gatewayActualPort: null,
    lastHostProbe: null,
    lastExternalVerification: null,
    lastForwardedSource: null,
  })
})

test('the projection whitelists declared + runtime facts into the sanitized shape', async () => {
  const { projectWizardStatus } = await load('wizard/status.js')
  const status = projectWizardStatus(
    { ingressMode: 'cloudflared', ingressDomain: 'dsh.example.com', ingressHttpsPort: 443, ingressPublicUrl: 'https://dsh.example.com' },
    {
      cfTokenConfigured: true,
      tunnelTokenConfigured: true,
      caddyRunning: false,
      cloudflaredRunning: true,
      gatewayActualPort: 3088,
      lastHostProbe: { result: 'pass', at: 1698249600000 },
      lastExternalVerification: { result: 'pass', deviceId: 'abc123', at: 1698249660000 },
      lastForwardedSource: { ip: '198.51.100.7', at: 1698249700000 },
    },
  )
  assert.deepEqual(status, {
    ok: true,
    mode: 'cloudflared',
    domain: 'dsh.example.com',
    httpsPort: 443,
    publicUrl: 'https://dsh.example.com',
    cfTokenConfigured: true,
    tunnelTokenConfigured: true,
    caddyRunning: false,
    cloudflaredRunning: true,
    gatewayActualPort: 3088,
    lastHostProbe: { result: 'pass', deviceId: null, at: 1698249600000 },
    lastExternalVerification: { result: 'pass', deviceId: 'abc123', at: 1698249660000 },
    lastForwardedSource: { ip: '198.51.100.7', at: 1698249700000 },
  })
})

test('the projection never echoes token material or file paths, whatever the runtime carries', async () => {
  const { projectWizardStatus } = await load('wizard/status.js')
  const status = projectWizardStatus(
    { ingressMode: 'caddy', ingressDomain: 'x.example.com', ingressHttpsPort: 443 },
    {
      // Hostile / sloppy runtime: tokens, paths and extra fields everywhere.
      cfToken: 'supersecret-token-material',
      cfTokenPath: '/Users/x/.dsh/zen-remote-ingress/cf-api-token',
      caddyBinaryPath: '/Users/x/.dsh/zen-remote-ingress/bin/caddy',
      cfTokenConfigured: true,
      caddyRunning: true,
      gatewayActualPort: 4088,
      lastHostProbe: { result: 'fail', url: 'https://x.example.com/secret-path', error: 'ECONNREFUSED /etc/hosts', at: 1 },
      lastExternalVerification: { result: 'fail', deviceId: 'd1', at: 2, token: 'leak-me' },
    },
  )
  const json = JSON.stringify(status)
  assert.ok(!json.includes('supersecret'), 'no token material may surface')
  assert.ok(!json.includes('/Users/'), 'no file path may surface')
  assert.ok(!json.includes('secret-path'), 'no probe URL may surface')
  assert.ok(!json.includes('/etc/hosts'), 'no probe error detail may surface')
  assert.ok(!json.includes('leak-me'), 'no verification extra may surface')
  // The shape is exactly the whitelist: extra runtime keys contribute nothing.
  assert.deepEqual(Object.keys(status).sort(), [
    'caddyRunning', 'cfTokenConfigured', 'cloudflaredRunning', 'domain', 'gatewayActualPort',
    'httpsPort', 'lastExternalVerification', 'lastForwardedSource', 'lastHostProbe', 'mode', 'ok', 'publicUrl',
    'tunnelTokenConfigured',
  ])
  assert.deepEqual(status.lastHostProbe, { result: 'fail', deviceId: null, at: 1 })
})

test('the projection coerces junk inputs at the rendering edge', async () => {
  const { projectWizardStatus } = await load('wizard/status.js')
  const status = projectWizardStatus(
    { ingressMode: 'foo', ingressDomain: 42, ingressHttpsPort: 'x', ingressPublicUrl: { evil: true } },
    { gatewayActualPort: 0, lastHostProbe: { at: 1 }, lastExternalVerification: 'pass' },
  )
  assert.equal(status.mode, 'off')
  assert.equal(status.domain, '')
  assert.equal(status.httpsPort, 443)
  assert.equal(status.publicUrl, '')
  assert.equal(status.gatewayActualPort, null, 'an out-of-band actual port renders as none')
  assert.equal(status.lastHostProbe, null, 'a record without a string result is no record')
  assert.equal(status.lastExternalVerification, null, 'a string is not a record either')
})

// --- admin/status must not leak the new fields --------------------------------

/** Minimal ServerResponse stand-in (same shape role-wiring.test.cjs uses). */
function fakeRes() {
  return {
    status: 0,
    body: '',
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    writeHead(code) { this.status = code },
    end(bytes) { if (bytes !== undefined) this.body = bytes.toString() },
  }
}

test('respondStatus answers the config WITHOUT the ingress fields', async () => {
  const { createAdminHandler } = await load('admin-routes.js')
  const fullValues = {
    role: 'host', port: 40000, host: '127.0.0.1', targetPort: undefined, rateLimit: 120,
    trustedProxies: '', vapidSubject: 'mailto:a@b.c', lang: 'zh', pushEvents: 'x/y',
    pushDebounceMs: 1, pushSummary: false, pushTurnEnd: false, pushTool: true,
    serverName: 'box', idleHours: 48, autoShareNewSessions: false, pluginBridgeConsent: {},
    ingressMode: 'caddy', ingressDomain: 'secret-domain.example.com', ingressHttpsPort: 8443,
    ingressAcmeEmail: 'secret@example.com', ingressPublicUrl: 'https://secret-domain.example.com:8443',
  }
  const sources = {}
  for (const key of Object.keys(fullValues)) sources[key] = 'row'
  const handler = createAdminHandler({
    admit: () => ({ peer: {} }),
    // A closed port: the status call refuses instantly, config is the point.
    gatewayBase: 'http://127.0.0.1:1',
    getConfig: () => ({ values: fullValues, sources }),
  })
  const res = fakeRes()
  await handler({ method: 'GET', url: '/_dsh/zen-remote/admin/status', headers: {} }, res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.ok(body.config.values.serverName, 'the ordinary fields still ride the config dump')
  assert.equal(body.config.values.port, 40000)
  for (const key of INGRESS_FIELDS) {
    assert.ok(!(key in body.config.values), `config.values.${key} must not appear on admin/status`)
    assert.ok(!(key in body.config.sources), `config.sources.${key} must not appear on admin/status`)
  }
  const raw = res.body
  assert.ok(!raw.includes('secret-domain.example.com'), 'the ingress domain must not leak anywhere in the body')
  assert.ok(!raw.includes('secret@example.com'), 'the acme email must not leak anywhere in the body')
})
