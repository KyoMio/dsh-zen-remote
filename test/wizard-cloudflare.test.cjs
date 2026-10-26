/* dsh-zen-remote · Cloudflare API client (GW-7)
 *
 * The REAL client (lib/wizard/cloudflare.js) over a real local HTTP mock
 * of the v4 envelope: each endpoint's request shape (path, method, Bearer
 * header, JSON body), the typed error classification (auth / tunnel
 * conflict / dns conflict / network / generic), the exact-name zone rule,
 * the composed domain check, and the never-leak-the-token rule.
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'lib', 'wizard', rel)).href)

let cloudflare

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
  const routes = {
    // Keys carry the EXACT query string the client builds (match is by full
    // URL after the base-path strip), pagination parameters included.
    'GET /accounts?per_page=50&page=1': { success: true, result: [{ id: 'acc-1' }, { id: 'acc-2' }], result_info: { total_pages: 1 } },
    // GW-fix-2/H1: zones are APEX domains — `dsh.example.com` lives in the
    // zone named `example.com`, and the composed check must find it by
    // walking the ancestor chain. The full-domain lookups all MISS.
    'GET /zones?name=dsh.example.com&account.id=acc-1': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=example.com&account.id=acc-1': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=com&account.id=acc-1': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=dsh.example.com&account.id=acc-2': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=example.com&account.id=acc-2': { success: true, result: [{ id: 'zone-2', name: 'example.com' }], result_info: { total_pages: 1 } },
    'GET /zones?name=com&account.id=acc-2': { success: true, result: [], result_info: { total_pages: 1 } },
    // `elsewhere.example` is on nobody's account (both ancestors miss).
    'GET /zones?name=elsewhere.example&account.id=acc-1': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=elsewhere.example&account.id=acc-2': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=example&account.id=acc-1': { success: true, result: [], result_info: { total_pages: 1 } },
    'GET /zones?name=example&account.id=acc-2': { success: true, result: [], result_info: { total_pages: 1 } },
    // The exact-match rule itself: a zone whose name EQUALS the query.
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
      // Strip the base path the client prepends, so route keys read like
      // the API paths themselves.
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

after(() => new Promise((resolve) => server.close(resolve)))

const api = (overrides = {}) => cloudflare.createCloudflareApi({
  token: 'sekret-cf-token',
  baseUrl: `http://127.0.0.1:${port}/client/v4`,
  ...overrides,
})

test('listAccounts returns the account ids with the Bearer header', async () => {
  const accounts = await api().listAccounts()
  assert.deepEqual(accounts, ['acc-1', 'acc-2'])
  assert.equal(seen.at(-1).authorization, 'Bearer sekret-cf-token')
  assert.equal(seen.at(-1).method, 'GET')
})

test('getZone matches the zone name EXACTLY and answers its id', async () => {
  assert.equal(await api().getZone('acc-1', 'exact.example'), 'zone-exact')
  await assert.rejects(
    api().getZone('acc-1', 'dsh.example.com'),
    (error) => error.code === 'cf-zone-not-found',
    'an empty zone list is a typed zone-not-found',
  )
  // A DIFFERENT domain gets the not-found verdict too (no fuzzy suffix match).
  await assert.rejects(
    api().getZone('acc-1', 'elsewhere.example'),
    (error) => error.code === 'cf-zone-not-found',
  )
  // Hostile domain shapes refuse before any request.
  const before = seen.length
  await assert.rejects(api().getZone('acc-1', 'evil{}'), (error) => error.code === 'cf-api')
  assert.equal(seen.length, before, 'no request left the client')
})

test('createTunnel posts the name with config_src cloudflare and returns id + token', async () => {
  const tunnel = await api().createTunnel('acc-1', 'dsh-zen-remote')
  assert.deepEqual(tunnel, { id: 'tun-1', token: 'connector-secret' })
  const call = seen.at(-1)
  assert.equal(call.method, 'POST')
  assert.equal(call.url, '/accounts/acc-1/cfd_tunnel')
  const body = JSON.parse(call.body)
  assert.deepEqual(body, { name: 'dsh-zen-remote', config_src: 'cloudflare' })
})

test('listTunnels maps id / name / status', async () => {
  const tunnels = await api().listTunnels('acc-1')
  assert.deepEqual(tunnels, [{ id: 'tun-1', name: 'dsh-zen-remote', status: 'down' }])
})

test('configureIngress writes hostname→service plus the 404 fallback', async () => {
  await api().configureIngress('acc-1', 'tun-1', 'dsh.example.com', 'http://127.0.0.1:4088')
  const call = seen.at(-1)
  assert.equal(call.method, 'PUT')
  assert.equal(call.url, '/accounts/acc-1/cfd_tunnel/tun-1/configurations')
  const body = JSON.parse(call.body)
  assert.deepEqual(body.config.ingress, [
    { hostname: 'dsh.example.com', service: 'http://127.0.0.1:4088' },
    { service: 'http_status:404' },
  ])
})

test('createDnsRecord posts a proxied CNAME to the tunnel target (including 36-char hyphenated UUID tunnel IDs)', async () => {
  const uuidTunnelTarget = 'ef824ff9-4004-4b23-8538-b501202821c8.cfargotunnel.com'
  const recordId = await api().createDnsRecord('zone-2', 'dsh.example.com', uuidTunnelTarget)
  assert.equal(recordId, 'rec-1')
  const call = seen.at(-1)
  assert.equal(call.url, '/zones/zone-2/dns_records')
  const body = JSON.parse(call.body)
  assert.equal(body.type, 'CNAME')
  assert.equal(body.proxied, true)
  assert.equal(body.content, uuidTunnelTarget)
  // Also verify getTunnelToken accepts Cloudflare's raw-string result envelope.
  assert.equal(await api().getTunnelToken('acc-1', 'tun-1'), 'raw-string-connector-token')
})

test('checkDomainOnCloudflare walks the ancestor chain: the zone is the PARENT domain (GW-fix-2/H1)', async () => {
  // The zone is named `example.com` while the wizard asks about
  // `dsh.example.com` — the exact pre-fix behavior answered
  // onCloudflare:false here, which would have pushed a user whose domain
  // is already on Cloudflare into the migrate flow.
  assert.deepEqual(
    await api().checkDomainOnCloudflare('dsh.example.com'),
    { onCloudflare: true, zoneId: 'zone-2', accountId: 'acc-2' },
  )
  assert.deepEqual(
    await api().checkDomainOnCloudflare('elsewhere.example'),
    { onCloudflare: false, zoneId: null, accountId: null },
    'both ancestors miss on both accounts',
  )
})

test('ancestorHosts builds the walked chain, itself first', async () => {
  assert.deepEqual(cloudflare.ancestorHosts('dsh.example.com'), ['dsh.example.com', 'example.com', 'com'])
  assert.deepEqual(cloudflare.ancestorHosts('example.com'), ['example.com', 'com'])
  assert.deepEqual(cloudflare.ancestorHosts('mybox'), ['mybox'])
})

test('listAccounts/listTunnels page through result_info (GW-fix-2/L5)', async () => {
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
    pages.close()
  }
})

test('a missing result_info reads as one page (old envelopes keep working)', async () => {
  const onePage = http.createServer((req, res) => {
    assert.equal(String(req.url), '/v4/accounts?per_page=50&page=1', 'only page 1 is requested')
    sendJson(res, 200, { success: true, result: [{ id: 'only' }] })
  })
  await new Promise((resolve) => onePage.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${onePage.address().port}/v4`
    assert.deepEqual(await cloudflare.createCloudflareApi({ token: 't', baseUrl: base }).listAccounts(), ['only'])
  } finally {
    onePage.close()
  }
})

// --- error classification -------------------------------------------------------

test('a 401 envelope classifies as cf-auth-failed', async () => {
  const refusal = http.createServer((req, res) => sendJson(res, 401, { success: false, errors: [{ code: 9109, message: 'Invalid API Token' }] }))
  await new Promise((resolve) => refusal.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(
      cloudflare.createCloudflareApi({ token: 't', baseUrl: `http://127.0.0.1:${refusal.address().port}` }).listAccounts(),
      (error) => error.code === 'cf-auth-failed' && error.status === 401 && /Invalid API Token/.test(error.message),
    )
  } finally {
    refusal.close()
  }
})

test('conflicts classify by code and by message fallback', async () => {
  const byCode = http.createServer((req, res) => sendJson(res, 400, { success: false, errors: [{ code: 10405, message: 'tunnel exists' }] }))
  const byMessage = http.createServer((req, res) => sendJson(res, 400, { success: false, errors: [{ code: 1234, message: 'A tunnel with this name already exists' }] }))
  await new Promise((resolve) => byCode.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => byMessage.listen(0, '127.0.0.1', resolve))
  try {
    const codeApi = cloudflare.createCloudflareApi({ token: 't', baseUrl: `http://127.0.0.1:${byCode.address().port}` })
    await assert.rejects(codeApi.createTunnel('acc', 'name'), (error) => error.code === 'cf-tunnel-conflict')
    const messageApi = cloudflare.createCloudflareApi({ token: 't', baseUrl: `http://127.0.0.1:${byMessage.address().port}` })
    await assert.rejects(messageApi.createTunnel('acc', 'name'), (error) => error.code === 'cf-tunnel-conflict', 'message fallback catches a code renumber')
  } finally {
    byCode.close()
    byMessage.close()
  }
})

test('DNS conflicts classify, and an unclassified error lands on the generic code with its API code preserved', async () => {
  const dns = http.createServer((req, res) => sendJson(res, 400, { success: false, errors: [{ code: 81053, message: 'Record already exists' }] }))
  const generic = http.createServer((req, res) => sendJson(res, 400, { success: false, errors: [{ code: 5432, message: 'something odd' }] }))
  await new Promise((resolve) => dns.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => generic.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(
      cloudflare.createCloudflareApi({ token: 't', baseUrl: `http://127.0.0.1:${dns.address().port}` }).createDnsRecord('z', 'a.example', 'x'.repeat(32) + '.cfargotunnel.com'),
      (error) => error.code === 'cf-dns-conflict' && error.apiCodes.includes(81053),
    )
    await assert.rejects(
      cloudflare.createCloudflareApi({ token: 't', baseUrl: `http://127.0.0.1:${generic.address().port}` }).listAccounts(),
      (error) => error.code === 'cf-api' && error.apiCodes.includes(5432) && /something odd/.test(error.message),
    )
  } finally {
    dns.close()
    generic.close()
  }
})

test('transport failures and unparsable answers are cf-network; the token never leaks', async () => {
  // A dead port: connection refused.
  const dead = http.createServer()
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))
  await assert.rejects(
    cloudflare.createCloudflareApi({ token: 'topsecret', baseUrl: `http://127.0.0.1:${deadPort}` }).listAccounts(),
    (error) => error.code === 'cf-network' && !String(error.message).includes('topsecret'),
  )

  // Plain-text answer: unparsable JSON.
  const plain = http.createServer((req, res) => { res.writeHead(200); res.end('<html>not json</html>') })
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(
      cloudflare.createCloudflareApi({ token: 'topsecret', baseUrl: `http://127.0.0.1:${plain.address().port}` }).listAccounts(),
      (error) => error.code === 'cf-network' && !String(error.message).includes('topsecret'),
    )
  } finally {
    plain.close()
  }
})

test('the module-level cf* wrappers work with an explicit baseUrl', async () => {
  assert.deepEqual(await cloudflare.cfListAccounts('sekret-cf-token', { baseUrl: `http://127.0.0.1:${port}/client/v4` }), ['acc-1', 'acc-2'])
  assert.equal(await cloudflare.cfGetZone('sekret-cf-token', 'acc-1', 'exact.example', { baseUrl: `http://127.0.0.1:${port}/client/v4` }), 'zone-exact')
})
