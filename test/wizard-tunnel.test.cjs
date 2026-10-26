/* dsh-zen-remote · tunnel orchestration (GW-13b)
 *
 * setupTunnel / checkDomainOnCloudflare driven through the apiFactory seam
 * against a scripted CloudflareApi (the transport's error classification
 * is wizard-cloudflare's; here the orchestration is what's under test).
 * Pinned: the full chain's call ORDER, the ingress/CNAME shapes against
 * the ACTUAL gateway port, the conflict round-trip (refuse with the list →
 * adopt by tunnelId through the token endpoint), the 模式切换 rule (caddy
 * stops BEFORE cloudflared starts), the 0600 token file, and every
 * failure reason.
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Drives the BUILT lib (same reason as the other lib-driving tests: the
// orchestrator transitively imports node builtins through config.js, which
// Node's strip-only loader cannot map).
const ORCH_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'wizard', 'tunnel-orchestrator.js')).href

let orchestrator

let home

before(async () => {
  orchestrator = await import(ORCH_URL)
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-tunnel-'))
})

after(() => new Promise((resolve) => {
  fs.rmSync(home, { recursive: true, force: true })
  resolve()
}))

/** The scripted CloudflareApi: records every call, answers per overrides. */
function fakeApi(overrides = {}) {
  const calls = []
  const api = {
    calls,
    async checkDomainOnCloudflare(domain) {
      calls.push(['checkDomain', domain])
      if (overrides.zoneThrow !== undefined) throw overrides.zoneThrow
      if (overrides.zoneMiss) return { onCloudflare: false, zoneId: null, accountId: null }
      return { onCloudflare: true, zoneId: overrides.zoneId ?? 'zone-1', accountId: overrides.accountId ?? 'acc-1' }
    },
    async listTunnels(accountId) {
      calls.push(['listTunnels', accountId])
      return overrides.existing ?? []
    },
    async createTunnel(accountId, name) {
      calls.push(['createTunnel', accountId, name])
      if (overrides.createThrow !== undefined) throw overrides.createThrow
      return { id: 'tun-new', token: 'fresh-connector-secret' }
    },
    async getTunnelToken(accountId, tunnelId) {
      calls.push(['getTunnelToken', accountId, tunnelId])
      return 'adopted-connector-secret'
    },
    async configureIngress(accountId, tunnelId, domain, serviceUrl) {
      calls.push(['configureIngress', accountId, tunnelId, domain, serviceUrl])
    },
    async createDnsRecord(zoneId, subdomain, target) {
      calls.push(['createDnsRecord', zoneId, subdomain, target])
      return 'rec-1'
    },
  }
  return api
}

/** Harness: scripted api + recorded managers + a real stored token. */
function harness(apiOverrides = {}, managerOverrides = {}) {
  const api = fakeApi(apiOverrides)
  const calls = []
  const tokenFile = path.join(home, `cf-token-${Math.random().toString(16).slice(2)}`)
  fs.writeFileSync(tokenFile, 'cf-token-material')
  const options = {
    dshHome: home,
    readToken: () => fs.readFileSync(tokenFile, 'utf8'),
    gatewayPort: () => 4088,
    apiFactory: () => api,
    cloudflared: {
      start: async (input) => {
        calls.push(['cf-start', input.tunnelToken])
        if (managerOverrides.startFails) return { ok: false, error: 'spawn boom' }
        return { ok: true }
      },
      stopCaddy: () => { calls.push(['stop-caddy']) },
    },
  }
  return { api, calls, options, tokenFile }
}

test('the full chain: zone → create → ingress(actual port) → CNAME → token file → start, in order', async () => {
  const { api, calls, options } = harness()
  const result = await orchestrator.setupTunnel(options, { domain: 'dsh.example.com' })
  assert.deepEqual(result, {
    ok: true,
    tunnelId: 'tun-new',
    publicUrl: 'https://dsh.example.com',
    tokenFile: path.join(home, 'zen-remote-ingress', 'tunnel-token'),
  })
  // The wire order the ticket demands: zone check → conflict scan → create
  // → ingress on the ACTUAL port → the proxied CNAME to the tunnel host.
  assert.deepEqual(api.calls, [
    ['checkDomain', 'dsh.example.com'],
    ['listTunnels', 'acc-1'],
    ['createTunnel', 'acc-1', 'dsh-zen-remote'],
    ['configureIngress', 'acc-1', 'tun-new', 'dsh.example.com', 'http://127.0.0.1:4088'],
    ['createDnsRecord', 'zone-1', 'dsh.example.com', 'tun-new.cfargotunnel.com'],
  ])
  // 模式切换 BEFORE the child starts; the connector secret rides the file.
  const cfCalls = calls.filter((entry) => entry[0] === 'stop-caddy' || entry[0] === 'cf-start')
  assert.deepEqual(cfCalls, [['stop-caddy'], ['cf-start', 'fresh-connector-secret']])
  const tokenPath = path.join(home, 'zen-remote-ingress', 'tunnel-token')
  assert.equal(fs.readFileSync(tokenPath, 'utf8'), 'fresh-connector-secret')
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600)
})

test('a same-name tunnel refuses with the list; adopting one switches to the token endpoint', async () => {
  const { api, calls, options } = harness({ existing: [{ id: 'tun-old', name: 'dsh-zen-remote', status: 'down' }] })
  const conflict = await orchestrator.setupTunnel(options, { domain: 'dsh.example.com' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.reason, 'tunnel-conflict')
  assert.deepEqual(conflict.existing, [{ id: 'tun-old', name: 'dsh-zen-remote', status: 'down' }])
  assert.ok(!api.calls.some((entry) => entry[0] === 'createTunnel'), 'nothing was created')
  assert.ok(!calls.some((entry) => entry[0] === 'cf-start'), 'nothing was started')

  // The user picks the existing tunnel: adopt through the token endpoint,
  // then the rest of the chain runs with the ADOPTED id.
  const adopted = await orchestrator.setupTunnel(options, { domain: 'dsh.example.com', tunnelId: 'tun-old' })
  assert.deepEqual(adopted, {
    ok: true,
    tunnelId: 'tun-old',
    publicUrl: 'https://dsh.example.com',
    tokenFile: path.join(home, 'zen-remote-ingress', 'tunnel-token'),
  })
  assert.ok(api.calls.some((entry) => entry[0] === 'getTunnelToken' && entry[2] === 'tun-old'), 'the token endpoint answered')
  assert.deepEqual(api.calls.filter((entry) => entry[0] === 'configureIngress'), [['configureIngress', 'acc-1', 'tun-old', 'dsh.example.com', 'http://127.0.0.1:4088']])
  assert.deepEqual(api.calls.filter((entry) => entry[0] === 'createDnsRecord'), [['createDnsRecord', 'zone-1', 'dsh.example.com', 'tun-old.cfargotunnel.com']])
  assert.deepEqual(calls.filter((entry) => entry[0] === 'cf-start'), [['cf-start', 'adopted-connector-secret']])
})

test('failure reasons: no-token / bad-domain / zone-miss / auth / spawn (caddy still stops first)', async () => {
  const base = {
    dshHome: home,
    gatewayPort: () => 4088,
    cloudflared: {
      start: async () => ({ ok: true }),
      stopCaddy: () => {},
    },
  }
  assert.equal((await orchestrator.setupTunnel({ ...base, readToken: () => undefined }, { domain: 'dsh.example.com' })).reason, 'no-token')
  assert.equal((await orchestrator.setupTunnel({ ...base, readToken: () => 't' }, { domain: 'not a domain' })).reason, 'bad-domain')

  // Zone miss (the domain is on nobody's account).
  const { options: missOptions } = harness({ zoneMiss: true })
  assert.equal((await orchestrator.setupTunnel(missOptions, { domain: 'dsh.example.com' })).reason, 'zone-not-found')

  // An auth refusal from the zone check.
  const { options: authOptions } = harness({ zoneThrow: { code: 'cf-auth-failed', message: 'bad token' } })
  const auth = await orchestrator.setupTunnel(authOptions, { domain: 'dsh.example.com' })
  assert.equal(auth.reason, 'auth')
  assert.equal(auth.detail, 'bad token')

  // A spawn failure AFTER the Cloudflare half succeeded — caddy still
  // stopped first, and the reason carries the child's error.
  const spawnCalls = []
  const { options: spawnOptions } = harness({}, { startFails: true })
  spawnOptions.cloudflared = {
    start: async (input) => { spawnCalls.push(['cf-start', input.tunnelToken]); return { ok: false, error: 'spawn boom' } },
    stopCaddy: () => { spawnCalls.push(['stop-caddy']) },
  }
  const spawn = await orchestrator.setupTunnel(spawnOptions, { domain: 'dsh.example.com' })
  assert.equal(spawn.ok, false)
  assert.equal(spawn.reason, 'spawn-failed')
  assert.deepEqual(spawnCalls, [['stop-caddy'], ['cf-start', 'fresh-connector-secret']])
})

test('checkDomainOnCloudflare: the parent zone matches; no-token and bad-domain refuse', async () => {
  const { options } = harness()
  assert.deepEqual(
    await orchestrator.checkDomainOnCloudflare(options, 'dsh.example.com'),
    { ok: true, onCloudflare: true, zoneId: 'zone-1', accountId: 'acc-1' },
  )
  assert.equal((await orchestrator.checkDomainOnCloudflare({ readToken: () => undefined }, 'dsh.example.com')).reason, 'no-token')
  assert.equal((await orchestrator.checkDomainOnCloudflare({ readToken: () => 't' }, 'not a domain')).reason, 'bad-domain')
})
