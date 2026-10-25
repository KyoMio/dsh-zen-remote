/* dsh-zen-remote · reverse-proxy snippets + source detection + trust-proxy (GW-5)
 *
 * proxy-snippets.js is pinned on the exact generated text and its
 * injection guards; source-detect.js on the gateway-status extraction and
 * the trust-list merge; the trust-proxy POST is driven over a real socket
 * through the REAL createWizardHandler with a persister pointed at a real
 * file (temp DSH_HOME) — walls first, then the merge semantics, then the
 * shadowed-layer refusal.
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { request } = require('./util.cjs')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'lib', 'wizard', rel)).href)

let snippets
let detect
let routes

let home

before(async () => {
  snippets = await load('proxy-snippets.js')
  detect = await load('source-detect.js')
  routes = await load('routes.js')
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-proxy-'))
})

after(() => new Promise((resolve) => {
  fs.rmSync(home, { recursive: true, force: true })
  resolve()
}))

const VALID = { domain: 'dsh.example.com', upstreamHost: '127.0.0.1', upstreamPort: 4088 }

// --- snippets -------------------------------------------------------------------

test('nginx snippet: full server block with upgrade map, forwarding headers, timeouts, body cap', () => {
  const result = snippets.nginxSnippet(VALID)
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('map $http_upgrade $connection_upgrade'), 'the WebSocket map is there')
  assert.ok(result.text.includes('server_name dsh.example.com;'))
  assert.ok(result.text.includes('proxy_pass http://127.0.0.1:4088;'))
  assert.ok(result.text.includes('proxy_buffering off;'), 'streaming needs buffering off')
  assert.ok(result.text.includes('client_max_body_size 128m;'))
  assert.ok(result.text.includes('proxy_read_timeout 3600s;'))
  assert.ok(result.text.includes('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'))
})

test('caddy snippet: the site block is one reverse_proxy line', () => {
  const result = snippets.caddySnippet(VALID)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'dsh.example.com {\n    reverse_proxy 127.0.0.1:4088\n}\n')
})

test('lucky steps: three lines, listen 443, upstream target, catch-all switch', () => {
  const result = snippets.luckySteps({ upstreamHost: '127.0.0.1', upstreamPort: 4088 })
  assert.equal(result.ok, true)
  assert.equal(result.steps.length, 3)
  assert.ok(result.steps[0].includes('443'))
  assert.ok(result.steps[1].includes('http://127.0.0.1:4088'))
  assert.ok(result.steps[2].includes('万事大吉'))
})

test('snippet inputs are injection-proof: scheme, path, newline, braces, bad ports all refuse', () => {
  for (const bad of [
    { ...VALID, domain: 'x\nserver{ listener' },
    { ...VALID, domain: 'https://evil' },
    { ...VALID, upstreamHost: '127.0.0.1/x' },
    { ...VALID, upstreamHost: 'a b' },
    { ...VALID, upstreamPort: 0 },
    { ...VALID, upstreamPort: 70000 },
    { ...VALID, upstreamPort: '4088' },
  ]) {
    const nginx = snippets.nginxSnippet(bad)
    assert.equal(nginx.ok, false, `nginx must refuse ${JSON.stringify(bad)}`)
    assert.equal(snippets.caddySnippet(bad).ok, false, `caddy must refuse ${JSON.stringify(bad)}`)
  }
  // The refusals are typed per field, so the UI can point at the input.
  assert.equal(snippets.nginxSnippet({ ...VALID, domain: 'https://evil' }).error, 'bad-domain')
  assert.equal(snippets.nginxSnippet({ ...VALID, upstreamHost: 'a b' }).error, 'bad-upstream-host')
  assert.equal(snippets.nginxSnippet({ ...VALID, upstreamPort: 0 }).error, 'bad-upstream-port')
  assert.equal(snippets.luckySteps({ upstreamHost: 'a b', upstreamPort: 1 }).error, 'bad-upstream-host')
})

// --- source detection ------------------------------------------------------------

test('detectForwardedSource lifts the gateway detection; junk and old gateways read as none', () => {
  assert.deepEqual(detect.detectForwardedSource({ lastForwardedSource: { ip: '192.168.1.1', at: 1698 } }), { ip: '192.168.1.1', at: 1698 })
  assert.equal(detect.detectForwardedSource({}), null, 'an older gateway sends nothing')
  assert.equal(detect.detectForwardedSource(null), null)
  assert.equal(detect.detectForwardedSource({ lastForwardedSource: null }), null)
  assert.equal(detect.detectForwardedSource({ lastForwardedSource: { ip: 'x', at: 'no' } }), null)
  assert.equal(detect.detectForwardedSource({ lastForwardedSource: { ip: '', at: 1 } }), null)
})

test('normalizeTrustedIp accepts IP literals, unwraps ::ffff:, refuses everything else', () => {
  assert.equal(detect.normalizeTrustedIp('203.0.113.9'), '203.0.113.9')
  assert.equal(detect.normalizeTrustedIp('::ffff:203.0.113.9'), '203.0.113.9')
  assert.equal(detect.normalizeTrustedIp('2001:DB8::1'), '2001:db8::1', 'IPv6 lowercases')
  assert.equal(detect.normalizeTrustedIp(' 127.0.0.1 '), '127.0.0.1', 'trim then accept')
  for (const bad of ['proxy.example.com', '1.2.3.999', '1.2.3', 'fe80::1%en0', '2001:db8::zz', '', 'x y', 42, null, undefined]) {
    assert.equal(detect.normalizeTrustedIp(bad), undefined, String(bad))
  }
})

test('parse/merge of the proxy list: append, dedupe, tolerate junk', () => {
  assert.deepEqual(detect.parseProxyList(' 10.0.0.1 , 10.0.0.2 '), ['10.0.0.1', '10.0.0.2'])
  assert.deepEqual(detect.parseProxyList(''), [])
  assert.deepEqual(detect.parseProxyList(undefined), [])
  assert.equal(detect.mergeProxyList('10.0.0.1', '10.0.0.2'), '10.0.0.1,10.0.0.2')
  assert.equal(detect.mergeProxyList('10.0.0.1,10.0.0.2', '10.0.0.2'), '10.0.0.1,10.0.0.2', 'no duplicate entry')
  assert.equal(detect.mergeProxyList('', '10.0.0.3'), '10.0.0.3')
})

// --- the trust-proxy route over a real socket --------------------------------------

const sameOrigin = (port) => ({ origin: `http://127.0.0.1:${port}` })

/** The REAL wizard handler with a trustProxy persister backed by a real
 * file (the same read-check-write shape the index.ts wiring uses). */
async function serveWithTrustProxy() {
  const file = path.join(home, `lan-gate-${Date.now()}-${Math.random().toString(16).slice(2)}.config.json`)
  let resolvedSource = 'file'
  // GW-fix-2/L2: when set, the persister answers false — the persisted
  // list moved between resolve and write (a parallel trust click).
  let concurrentChange = false
  const handler = routes.createWizardHandler({
    admit: () => ({ peer: {} }),
    getConfig: () => ({ values: {}, sources: {} }),
    trustProxy: {
      resolved: () => {
        let value = ''
        try {
          value = String(JSON.parse(fs.readFileSync(file, 'utf8')).trustedProxies ?? '')
        } catch { /* no file yet */ }
        return { value, source: resolvedSource }
      },
      write: async (expected, list) => {
        if (concurrentChange) return false
        fs.writeFileSync(file, JSON.stringify({ trustedProxies: list }, null, 2))
        return true
      },
    },
  })
  const server = http.createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    server,
    setSource: (source) => { resolvedSource = source },
    setConcurrentChange: (value) => { concurrentChange = value },
    file,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('trust-proxy: walls first, then a typed flow — merge, dedupe, refuse junk, refuse shadowed layers', async () => {
  const svc = await serveWithTrustProxy()
  try {
    const { port } = svc

    // Wall order: via-gateway refuses even a same-origin POST.
    const via = await request(port, {
      method: 'POST',
      path: routes.WIZARD_TRUST_PROXY_ROUTE,
      headers: { 'x-zen-remote-via': 'gateway', ...sameOrigin(port) },
      body: { ip: '203.0.113.9' },
    })
    assert.equal(via.status, 403)
    assert.equal(JSON.parse(via.body).error.code, 'via-gateway')

    // Cross-site is refused before any write.
    const cross = await request(port, {
      method: 'POST',
      path: routes.WIZARD_TRUST_PROXY_ROUTE,
      headers: { origin: 'http://evil.example' },
      body: { ip: '203.0.113.9' },
    })
    assert.equal(cross.status, 403)
    assert.equal(JSON.parse(cross.body).error.code, 'origin-rejected')

    // Malformed bodies and non-IP values are typed 400s.
    for (const [body, code] of [
      [{ ip: 'not-an-ip' }, 'bad-ip'],
      [{}, 'bad-ip'],
      [{ ip: 42 }, 'bad-ip'],
      ['{"ip": "203.0.113.9"', 'bad-request'],
    ]) {
      const res = await request(port, {
        method: 'POST',
        path: routes.WIZARD_TRUST_PROXY_ROUTE,
        headers: sameOrigin(port),
        body: typeof body === 'string' ? body : JSON.stringify(body),
        raw: typeof body === 'string',
      })
      assert.equal(res.status, 400, code)
      assert.equal(JSON.parse(res.body).error.code, code)
    }

    // A wiring without the persister stays a 501.
    const bare = http.createServer((req, res) => {
      void routes.createWizardHandler({
        admit: () => ({ peer: {} }),
        getConfig: () => ({ values: {}, sources: {} }),
      })(req, res)
    })
    await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve))
    try {
      const notWired = await request(bare.address().port, {
        method: 'POST',
        path: routes.WIZARD_TRUST_PROXY_ROUTE,
        headers: sameOrigin(bare.address().port),
        body: { ip: '203.0.113.9' },
      })
      assert.equal(notWired.status, 501)
      assert.equal(JSON.parse(notWired.body).error.code, 'not-implemented')
    } finally {
      await new Promise((resolve) => bare.close(resolve))
    }

    // Happy path: first add appends and persists.
    const first = await request(port, {
      method: 'POST',
      path: routes.WIZARD_TRUST_PROXY_ROUTE,
      headers: sameOrigin(port),
      body: { ip: '::ffff:203.0.113.9' },
    })
    assert.equal(first.status, 200)
    assert.deepEqual(JSON.parse(first.body), { ok: true, added: true })
    assert.equal(JSON.parse(fs.readFileSync(svc.file, 'utf8')).trustedProxies, '203.0.113.9', 'the ::ffff: form is stored unwrapped')

    // Duplicate (same IP in any spelling): answered, nothing rewritten.
    const second = await request(port, {
      method: 'POST',
      path: routes.WIZARD_TRUST_PROXY_ROUTE,
      headers: sameOrigin(port),
      body: { ip: '203.0.113.9' },
    })
    assert.equal(second.status, 200)
    assert.deepEqual(JSON.parse(second.body), { ok: true, added: false })

    // A second IP merges behind the first.
    const third = await request(port, {
      method: 'POST',
      path: routes.WIZARD_TRUST_PROXY_ROUTE,
      headers: sameOrigin(port),
      body: { ip: '198.51.100.7' },
    })
    assert.equal(JSON.parse(third.body).added, true)
    assert.equal(JSON.parse(fs.readFileSync(svc.file, 'utf8')).trustedProxies, '203.0.113.9,198.51.100.7')

    // An env/row-supplied list shadows the file layer: refuse honestly.
    svc.setSource('row')
    const shadowed = await request(port, {
      method: 'POST',
      path: routes.WIZARD_TRUST_PROXY_ROUTE,
      headers: sameOrigin(port),
      body: { ip: '198.51.100.8' },
    })
    assert.equal(shadowed.status, 409)
    assert.equal(JSON.parse(shadowed.body).error.code, 'proxy-list-shadowed')

    // GW-fix-2/L2: a concurrent writer moved the list between resolve and
    // write — the persister refuses, the route answers 409 and the file
    // keeps whatever the other writer left.
    svc.setSource('file')
    svc.setConcurrentChange(true)
    const raced = await request(port, {
      method: 'POST',
      path: routes.WIZARD_TRUST_PROXY_ROUTE,
      headers: sameOrigin(port),
      body: { ip: '198.51.100.8' },
    })
    assert.equal(raced.status, 409)
    assert.equal(JSON.parse(raced.body).error.code, 'trust-list-changed')
    assert.equal(
      JSON.parse(fs.readFileSync(svc.file, 'utf8')).trustedProxies,
      '203.0.113.9,198.51.100.7',
      'a lost race must not clobber or append',
    )
    // After the other writer settles, the same click succeeds again.
    svc.setConcurrentChange(false)
    const retried = await request(port, {
      method: 'POST',
      path: routes.WIZARD_TRUST_PROXY_ROUTE,
      headers: sameOrigin(port),
      body: { ip: '198.51.100.8' },
    })
    assert.equal(JSON.parse(retried.body).added, true)
  } finally {
    await svc.close()
  }
})

test('wizard status surfaces the detection through the projection (read-only GET)', async () => {
  const handler = routes.createWizardHandler({
    admit: () => ({ peer: {} }),
    getConfig: () => ({
      values: { ingressMode: 'external' },
      sources: {},
    }),
    getRuntime: () => ({ lastForwardedSource: { ip: '198.51.100.7', at: 1698249600000 } }),
  })
  const server = http.createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await request(server.address().port, { method: 'GET', path: routes.WIZARD_STATUS_ROUTE })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.deepEqual(body.lastForwardedSource, { ip: '198.51.100.7', at: 1698249600000 })
    assert.equal(body.mode, 'external')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
