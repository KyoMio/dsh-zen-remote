'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { startResetServer } = require('./util.cjs')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'lib', 'wizard', rel)).href)

let cloudflare
let orchestrator
let home
let server
let port
const seen = []

function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
  res.end(bytes)
}

before(async () => {
  cloudflare = await load('cloudflare.js')
  orchestrator = await load('tunnel-orchestrator.js')
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-tunnel-'))

  const routes = {
    'GET /accounts?per_page=50&page=1': { success: true, result: [{ id: 'acc-1' }, { id: 'acc-2' }], result_info: { total_pages: 1 } },
    'GET /zones?name=dsh.example.com&account.id=acc-1': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=example.com&account.id=acc-1': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=com&account.id=acc-1': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=dsh.example.com&account.id=acc-2': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=example.com&account.id=acc-2': { success: true, result: [{ id: 'zone-2', name: 'example.com' }], result_info: { total_pages: 1 } },
    'GET /zones?name=com&account.id=acc-2': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=elsewhere.example&account.id=acc-1': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=elsewhere.example&account.id=acc-2': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=example&account.id=acc-1': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=example&account.id=acc-2': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=exact.example&account.id=acc-1': { success: true, result: [{ id: 'zone-exact', name: 'exact.example' }], result_info: { total_pages: 1 } },
    'POST /accounts/acc-1/cfd_tunnel': { success: true, result: { id: 'tun-1', token: 'connector-secret', name: 'dsh-zen-remote' } },
    'GET /accounts/acc-1/cfd_tunnel/tun-1/token': { success: true, result: 'raw-string-connector-token' },
    'GET /accounts/acc-1/cfd_tunnel?is_deleted=false&per_page=50&page=1': { success: true, result: [{ id: 'tun-1', name: 'dsh-zen-remote', status: 'down' }], result_info: { total_pages: 1 } },
    'PUT /accounts/acc-1/cfd_tunnel/tun-1/configurations': { success: true, result: { id: 'tun-1' } },
    'POST /zones/zone-2/dns_records': { success: true, result: { id: 'rec-1' } },
  }
  server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = String(req.url).replace(/^\/client\/v4/, '')
      seen.push({ method: req.method, url, authorization: req.headers.authorization, body })
      const key = `${req.method} ${url}`
      const match = routes[key]
      if (match !== undefined) { sendJson(res, 200, match); return }
      sendJson(res, 404, { success: false, errors: [{ code: 7000, message: 'no route mocked' }] })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(home, { recursive: true, force: true })
})

const api = (overrides = {}) => cloudflare.createCloudflareApi({
  token: 'sekret-cf-token',
  baseUrl: `http://127.0.0.1:${port}/client/v4`,
  ...overrides,
})

// --- Cloudflare API client ----------------------------------------------------

test('listAccounts returns the account ids with the Bearer header', async () => {
  const accounts = await api().listAccounts()
  assert.deepEqual(accounts, ['acc-1', 'acc-2'])
  assert.equal(seen.at(-1).authorization, 'Bearer sekret-cf-token')
  assert.equal(seen.at(-1).method, 'GET')
})

test('getZone matches the zone name EXACTLY and answers its id', async () => {
  assert.equal(await api().getZone('acc-1', 'exact.example'), 'zone-exact')
  await assert.rejects(api().getZone('acc-1', 'dsh.example.com'), (error) => error.code === 'cf-zone-not-found')
  await assert.rejects(api().getZone('acc-1', 'elsewhere.example'), (error) => error.code === 'cf-zone-not-found')
  const before = seen.length
  await assert.rejects(api().getZone('acc-1', 'evil{}'), (error) => error.code === 'cf-api')
  assert.equal(seen.length, before)
})

test('createTunnel, listTunnels, configureIngress, createDnsRecord, getTunnelToken', async () => {
  const tunnel = await api().createTunnel('acc-1', 'dsh-zen-remote')
  assert.deepEqual(tunnel, { id: 'tun-1', token: 'connector-secret' })
  assert.equal(seen.at(-1).method, 'POST')
  assert.equal(seen.at(-1).url, '/accounts/acc-1/cfd_tunnel')
  assert.deepEqual(JSON.parse(seen.at(-1).body), { name: 'dsh-zen-remote', config_src: 'cloudflare' })

  assert.deepEqual(await api().listTunnels('acc-1'), [{ id: 'tun-1', name: 'dsh-zen-remote', status: 'down' }])

  await api().configureIngress('acc-1', 'tun-1', 'dsh.example.com', 'http://127.0.0.1:4088')
  assert.equal(seen.at(-1).method, 'PUT')
  assert.equal(seen.at(-1).url, '/accounts/acc-1/cfd_tunnel/tun-1/configurations')
  assert.deepEqual(JSON.parse(seen.at(-1).body).config.ingress, [
    { hostname: 'dsh.example.com', service: 'http://127.0.0.1:4088' },
    { service: 'http_status:404' },
  ])

  const uuidTunnelTarget = 'ef824ff9-4004-4b23-8538-b501202821c8.cfargotunnel.com'
  assert.equal(await api().createDnsRecord('zone-2', 'dsh.example.com', uuidTunnelTarget), 'rec-1')
  assert.equal(seen.at(-1).url, '/zones/zone-2/dns_records')
  const body = JSON.parse(seen.at(-1).body)
  assert.equal(body.type, 'CNAME')
  assert.equal(body.proxied, true)
  assert.equal(body.content, uuidTunnelTarget)
  assert.equal(await api().getTunnelToken('acc-1', 'tun-1'), 'raw-string-connector-token')
})

test('checkDomainOnCloudflare walks the ancestor chain and ancestorHosts builds it', async () => {
  assert.deepEqual(
    await api().checkDomainOnCloudflare('dsh.example.com'),
    { onCloudflare: true, zoneId: 'zone-2', accountId: 'acc-2' },
  )
  assert.deepEqual(
    await api().checkDomainOnCloudflare('elsewhere.example'),
    { onCloudflare: false, zoneId: null, accountId: null },
  )
  assert.deepEqual(cloudflare.ancestorHosts('dsh.example.com'), ['dsh.example.com', 'example.com', 'com'])
  assert.deepEqual(cloudflare.ancestorHosts('example.com'), ['example.com', 'com'])
  assert.deepEqual(cloudflare.ancestorHosts('mybox'), ['mybox'])
})

test('listAccounts/listTunnels page through result_info and tolerate missing result_info', async () => {
  const pages = http.createServer((req, res) => {
    const url = String(req.url)
    if (url === '/v4/accounts?per_page=50&page=1') {
      sendJson(res, 200, { success: true, result: [{ id: 'a1' }, { id: 'a2' }], result_info: { total_pages: 2 } })
      return
    }
    if (url === '/v4/accounts?per_page=50&page=2') {
      sendJson(res, 200, { success: true, result: [{ id: 'a3' }], result_info: { total_pages: 2 } })
      return
    }
    sendJson(res, 404, { success: false, errors: [{ code: 7000, message: `unexpected page request ${url}` }] })
  })
  await new Promise((resolve) => pages.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${pages.address().port}/v4`
    assert.deepEqual(await cloudflare.createCloudflareApi({ token: 't', baseUrl: base }).listAccounts(), ['a1', 'a2', 'a3'])
  } finally {
    await new Promise((resolve) => pages.close(resolve))
  }

  const onePage = http.createServer((req, res) => {
    assert.equal(String(req.url), '/v4/accounts?per_page=50&page=1')
    sendJson(res, 200, { success: true, result: [{ id: 'only' }] })
  })
  await new Promise((resolve) => onePage.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${onePage.address().port}/v4`
    assert.deepEqual(await cloudflare.createCloudflareApi({ token: 't', baseUrl: base }).listAccounts(), ['only'])
  } finally {
    await new Promise((resolve) => onePage.close(resolve))
  }
})

test('cloudflare error classification: 401, tunnel/DNS conflicts, generic, network, wrappers', async () => {
  const refusal = http.createServer((req, res) => sendJson(res, 401, { success: false, errors: [{ code: 9109, message: 'Invalid API Token' }] }))
  const byCode = http.createServer((req, res) => sendJson(res, 400, { success: false, errors: [{ code: 10405, message: 'tunnel exists' }] }))
  const byMessage = http.createServer((req, res) => sendJson(res, 400, { success: false, errors: [{ code: 1234, message: 'A tunnel with this name already exists' }] }))
  const dns = http.createServer((req, res) => sendJson(res, 400, { success: false, errors: [{ code: 81053, message: 'Record already exists' }] }))
  const generic = http.createServer((req, res) => sendJson(res, 400, { success: false, errors: [{ code: 5432, message: 'something odd' }] }))
  const plain = http.createServer((req, res) => { res.writeHead(200); res.end('<html>not json</html>') })
  const reset = await startResetServer()

  for (const s of [refusal, byCode, byMessage, dns, generic, plain]) {
    await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  }
  try {
    await assert.rejects(
      cloudflare.createCloudflareApi({ token: 't', baseUrl: `http://127.0.0.1:${refusal.address().port}` }).listAccounts(),
      (error) => error.code === 'cf-auth-failed' && error.status === 401 && /Invalid API Token/.test(error.message),
    )
    await assert.rejects(
      cloudflare.createCloudflareApi({ token: 't', baseUrl: `http://127.0.0.1:${byCode.address().port}` }).createTunnel('acc', 'name'),
      (error) => error.code === 'cf-tunnel-conflict',
    )
    await assert.rejects(
      cloudflare.createCloudflareApi({ token: 't', baseUrl: `http://127.0.0.1:${byMessage.address().port}` }).createTunnel('acc', 'name'),
      (error) => error.code === 'cf-tunnel-conflict',
    )
    await assert.rejects(
      cloudflare.createCloudflareApi({ token: 't', baseUrl: `http://127.0.0.1:${dns.address().port}` }).createDnsRecord('z', 'a.example', 'x'.repeat(32) + '.cfargotunnel.com'),
      (error) => error.code === 'cf-dns-conflict' && error.apiCodes.includes(81053),
    )
    await assert.rejects(
      cloudflare.createCloudflareApi({ token: 't', baseUrl: `http://127.0.0.1:${generic.address().port}` }).listAccounts(),
      (error) => error.code === 'cf-api' && error.apiCodes.includes(5432) && /something odd/.test(error.message),
    )
    await assert.rejects(
      cloudflare.createCloudflareApi({ token: 'topsecret', baseUrl: `http://127.0.0.1:${reset.port}` }).listAccounts(),
      (error) => error.code === 'cf-network' && !String(error.message).includes('topsecret'),
    )
    await assert.rejects(
      cloudflare.createCloudflareApi({ token: 'topsecret', baseUrl: `http://127.0.0.1:${plain.address().port}` }).listAccounts(),
      (error) => error.code === 'cf-network' && !String(error.message).includes('topsecret'),
    )
    assert.deepEqual(await cloudflare.cfListAccounts('sekret-cf-token', { baseUrl: `http://127.0.0.1:${port}/client/v4` }), ['acc-1', 'acc-2'])
    assert.equal(await cloudflare.cfGetZone('sekret-cf-token', 'acc-1', 'exact.example', { baseUrl: `http://127.0.0.1:${port}/client/v4` }), 'zone-exact')
  } finally {
    await reset.close()
    for (const s of [refusal, byCode, byMessage, dns, generic, plain]) {
      await new Promise((resolve) => s.close(resolve))
    }
  }
})

// --- Tunnel orchestrator ------------------------------------------------------

function fakeApi(overrides = {}) {
  const calls = []
  const apiObj = {
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
    async listDnsRecords(zoneId, name) {
      calls.push(['listDnsRecords', name])
      return overrides.dnsRecords ?? []
    },
  }
  return apiObj
}

function harness(apiOverrides = {}, managerOverrides = {}) {
  const apiObj = fakeApi(apiOverrides)
  const calls = []
  const tokenFile = path.join(home, `cf-token-${Math.random().toString(16).slice(2)}`)
  fs.writeFileSync(tokenFile, 'cf-token-material')
  const options = {
    dshHome: home,
    readToken: () => fs.readFileSync(tokenFile, 'utf8'),
    gatewayPort: () => 4088,
    apiFactory: () => apiObj,
    cloudflared: {
      start: async (input) => {
        calls.push(['cf-start', input.tunnelToken])
        if (managerOverrides.startFails) return { ok: false, error: 'spawn boom' }
        return { ok: true }
      },
      stopCaddy: () => { calls.push(['stop-caddy']) },
    },
  }
  return { api: apiObj, calls, options, tokenFile }
}

test('setupTunnel full chain, conflict adoption, failure reasons, and checkDomainOnCloudflare', async () => {
  {
    const { api: a, calls, options } = harness()
    const result = await orchestrator.setupTunnel(options, { domain: 'dsh.example.com' })
    assert.deepEqual(result, {
      ok: true,
      tunnelId: 'tun-new',
      publicUrl: 'https://dsh.example.com',
      tokenFile: path.join(home, 'zen-remote-ingress', 'tunnel-token'),
    })
    assert.deepEqual(a.calls, [
      ['checkDomain', 'dsh.example.com'],
      ['listTunnels', 'acc-1'],
      ['createTunnel', 'acc-1', 'dsh-zen-remote'],
      ['configureIngress', 'acc-1', 'tun-new', 'dsh.example.com', 'http://127.0.0.1:4088'],
      ['listDnsRecords', 'dsh.example.com'],
      ['createDnsRecord', 'zone-1', 'dsh.example.com', 'tun-new.cfargotunnel.com'],
    ])
    const cfCalls = calls.filter((entry) => entry[0] === 'stop-caddy' || entry[0] === 'cf-start')
    assert.deepEqual(cfCalls, [['stop-caddy'], ['cf-start', 'fresh-connector-secret']])
    const tokenPath = path.join(home, 'zen-remote-ingress', 'tunnel-token')
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), 'fresh-connector-secret')
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600)
  }

  {
    const { api: a, calls, options } = harness({ existing: [{ id: 'tun-old', name: 'dsh-zen-remote', status: 'down' }] })
    const conflict = await orchestrator.setupTunnel(options, { domain: 'dsh.example.com' })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.reason, 'tunnel-conflict')
    assert.deepEqual(conflict.existing, [{ id: 'tun-old', name: 'dsh-zen-remote', status: 'down' }])
    assert.ok(!a.calls.some((entry) => entry[0] === 'createTunnel'))
    assert.ok(!calls.some((entry) => entry[0] === 'cf-start'))

    const adopted = await orchestrator.setupTunnel(options, { domain: 'dsh.example.com', tunnelId: 'tun-old' })
    assert.deepEqual(adopted, {
      ok: true,
      tunnelId: 'tun-old',
      publicUrl: 'https://dsh.example.com',
      tokenFile: path.join(home, 'zen-remote-ingress', 'tunnel-token'),
    })
    assert.ok(a.calls.some((entry) => entry[0] === 'getTunnelToken' && entry[2] === 'tun-old'))
    assert.deepEqual(a.calls.filter((entry) => entry[0] === 'configureIngress'), [['configureIngress', 'acc-1', 'tun-old', 'dsh.example.com', 'http://127.0.0.1:4088']])
    assert.deepEqual(a.calls.filter((entry) => entry[0] === 'listDnsRecords'), [['listDnsRecords', 'dsh.example.com']])
    assert.deepEqual(a.calls.filter((entry) => entry[0] === 'createDnsRecord'), [['createDnsRecord', 'zone-1', 'dsh.example.com', 'tun-old.cfargotunnel.com']])
    assert.deepEqual(calls.filter((entry) => entry[0] === 'cf-start'), [['cf-start', 'adopted-connector-secret']])
  }

  {
    const base = {
      dshHome: home,
      gatewayPort: () => 4088,
      cloudflared: { start: async () => ({ ok: true }), stopCaddy: () => {} },
    }
    assert.equal((await orchestrator.setupTunnel({ ...base, readToken: () => undefined }, { domain: 'dsh.example.com' })).reason, 'no-token')
    assert.equal((await orchestrator.setupTunnel({ ...base, readToken: () => 't' }, { domain: 'not a domain' })).reason, 'bad-domain')
    const { options: missOptions } = harness({ zoneMiss: true })
    assert.equal((await orchestrator.setupTunnel(missOptions, { domain: 'dsh.example.com' })).reason, 'zone-not-found')
    const { options: authOptions } = harness({ zoneThrow: { code: 'cf-auth-failed', message: 'bad token' } })
    const auth = await orchestrator.setupTunnel(authOptions, { domain: 'dsh.example.com' })
    assert.equal(auth.reason, 'auth')
    assert.equal(auth.detail, 'bad token')

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
  }

  {
    const { options } = harness()
    assert.deepEqual(
      await orchestrator.checkDomainOnCloudflare(options, 'dsh.example.com'),
      { ok: true, onCloudflare: true, zoneId: 'zone-1', accountId: 'acc-1' },
    )
    assert.equal((await orchestrator.checkDomainOnCloudflare({ readToken: () => undefined }, 'dsh.example.com')).reason, 'no-token')
    assert.equal((await orchestrator.checkDomainOnCloudflare({ readToken: () => 't' }, 'not a domain')).reason, 'bad-domain')
  }
})

test('GW-fix-4: DNS idempotence, dns-conflict untouched, and caddy stop after CF calls', async () => {
  {
    const calls = []
    const managerCalls = []
    const result = await orchestrator.setupTunnel({
      dshHome: home,
      readToken: () => 't',
      gatewayPort: () => 4088,
      apiFactory: () => ({
        async checkDomainOnCloudflare() { calls.push(['checkDomain']); return { onCloudflare: true, zoneId: 'zone-1', accountId: 'acc-1' } },
        async listTunnels() { calls.push(['listTunnels']); return [{ id: 'tun-existing', name: 'dsh-zen-remote', status: 'down' }] },
        async createTunnel() { calls.push(['createTunnel']); throw new Error('must not create on conflict') },
        async getTunnelToken(accountId, tunnelId) { calls.push(['getTunnelToken', tunnelId]); return 'adopted-secret' },
        async configureIngress(accountId, tunnelId, domain, serviceUrl) { calls.push(['configureIngress', tunnelId, serviceUrl]) },
        async listDnsRecords(zoneId, name) { calls.push(['listDnsRecords', name]); return [{ id: 'rec-1', name, content: 'tun-existing.cfargotunnel.com' }] },
        async createDnsRecord() { calls.push(['createDnsRecord']); throw new Error('must not re-POST') },
      }),
      cloudflared: {
        start: async (input) => { managerCalls.push(['cf-start', input.tunnelToken]); return { ok: true } },
        stopCaddy: () => { managerCalls.push(['stop-caddy']) },
      },
    }, { domain: 'dsh.example.com', tunnelId: 'tun-existing' })
    assert.equal(result.ok, true)
    assert.ok(!calls.some((entry) => entry[0] === 'createDnsRecord'))
    assert.deepEqual(managerCalls, [['stop-caddy'], ['cf-start', 'adopted-secret']])
  }

  {
    const calls = []
    const managerCalls = []
    const result = await orchestrator.setupTunnel({
      dshHome: home,
      readToken: () => 't',
      gatewayPort: () => 4088,
      apiFactory: () => ({
        async checkDomainOnCloudflare() { return { onCloudflare: true, zoneId: 'zone-1', accountId: 'acc-1' } },
        async listTunnels() { return [] },
        async createTunnel() { return { id: 'tun-new', token: 'fresh' } },
        async configureIngress() { calls.push(['configureIngress']) },
        async listDnsRecords() { calls.push(['listDnsRecords']); return [{ id: 'rec-other', name: 'dsh.example.com', content: 'old-target.example.com' }] },
        async createDnsRecord() { calls.push(['createDnsRecord']); throw new Error('must not overwrite') },
      }),
      cloudflared: {
        start: async () => { managerCalls.push(['cf-start']); return { ok: true } },
        stopCaddy: () => { managerCalls.push(['stop-caddy']) },
      },
    }, { domain: 'dsh.example.com' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'dns-conflict')
    assert.equal(result.detail, 'old-target.example.com')
    assert.ok(!calls.some((entry) => entry[0] === 'createDnsRecord'))
    assert.deepEqual(managerCalls, [])
  }

  {
    const order = []
    const result = await orchestrator.setupTunnel({
      dshHome: home,
      readToken: () => 't',
      gatewayPort: () => 4088,
      apiFactory: () => ({
        async checkDomainOnCloudflare() { order.push('check'); return { onCloudflare: true, zoneId: 'z', accountId: 'a' } },
        async listTunnels() { order.push('list'); return [] },
        async createTunnel() { order.push('create'); return { id: 't1', token: 'tok' } },
        async configureIngress() { order.push('ingress') },
        async listDnsRecords() { order.push('listDns'); return [] },
        async createDnsRecord() { order.push('dns'); return 'rec' },
      }),
      cloudflared: {
        start: async () => { order.push('cf-start'); return { ok: true } },
        stopCaddy: () => { order.push('stop-caddy') },
      },
    }, { domain: 'dsh.example.com' })
    assert.equal(result.ok, true)
    assert.equal(order.indexOf('stop-caddy'), order.length - 2)
    assert.ok(order.indexOf('dns') < order.indexOf('stop-caddy'))
  }
})
