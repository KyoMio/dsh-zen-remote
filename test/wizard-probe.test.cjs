/* dsh-zen-remote · hostPath probe (GW-8)
 *
 * The pure classifiers are pinned branch by branch; probeHostPath runs
 * against a real local HTTP server answering every shape the wizard must
 * tell apart (the pairing page, the admin-403, the DANGEROUS exposed
 * admin, Cloudflare-Access-style redirects), plus the refusal paths:
 * invalid URLs, public plain http, dead ports, timeouts. redirect:
 * 'manual' is proven by a 302 that arrives UNFOLLOWED.
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'lib', 'wizard', rel)).href)

let probe

before(async () => {
  probe = await load('probe.js')
})

// --- the pure classifiers ------------------------------------------------------

test('classifyRootResponse: the pairing page is the one right answer', () => {
  const pairingBody = '<!doctype html><html><body>fetch("/lan-gate/pair/claim",...)</body></html>'
  assert.equal(probe.classifyRootResponse(401, 'text/html; charset=utf-8', pairingBody), 'gateway-pairing-page')
  // 401 but the wrong shape: no marker, wrong type.
  assert.equal(probe.classifyRootResponse(401, 'text/html; charset=utf-8', '<html>login</html>'), 'unexpected-401')
  assert.equal(probe.classifyRootResponse(401, 'application/json', pairingBody), 'unexpected-401')
  // 200: something else lives at this URL.
  assert.equal(probe.classifyRootResponse(200, 'text/html', '<html>hello</html>'), 'unexpected-200')
  // 3xx: Cloudflare Access / proxy rewrite.
  assert.equal(probe.classifyRootResponse(302, 'text/html', ''), 'redirect')
  assert.equal(probe.classifyRootResponse(301, '', ''), 'redirect')
  // Everything else.
  assert.equal(probe.classifyRootResponse(500, 'text/plain', 'boom'), 'unexpected')
})

test('classifyAdminResponse: gateway 403 right, exposed admin DANGEROUS, Access 403 suspicious', () => {
  assert.equal(probe.classifyAdminResponse(403, 'application/json; charset=utf-8', '{"ok":false}'), 'gateway-admin-403')
  assert.equal(probe.classifyAdminResponse(200, 'text/html; charset=utf-8', '<html>gateway admin</html>'), 'admin-exposed', 'forwarded headers were dropped')
  assert.equal(probe.classifyAdminResponse(403, 'text/html; charset=utf-8', '<html>Access denied</html>'), 'proxy-403')
  // JSON header but not the gateway's envelope; JSON envelope but ok:true; other statuses.
  assert.equal(probe.classifyAdminResponse(403, 'application/json', '<html>not json</html>'), 'unexpected')
  assert.equal(probe.classifyAdminResponse(403, 'application/json', '{"ok":true}'), 'unexpected')
  assert.equal(probe.classifyAdminResponse(500, 'text/plain', 'boom'), 'unexpected')
})

// --- probeHostPath ---------------------------------------------------------------

const PAIRING_PAGE = '<!doctype html><html><script>fetch("/lan-gate/pair/claim"' 

function serve(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

test('the happy shape: pairing page + admin 403 answer reached with both classifications', async () => {
  const { server, port } = await serve((req, res) => {
    if (req.url === '/lan-gate/admin') {
      const body = '{"ok":false}'
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length) })
      res.end(body)
      return
    }
    // Mirror lan-gate-server.cjs line 1274: if Accept includes
    // application/json, the gateway returns 401 JSON instead of the HTML
    // pairing page. The probe must send a browser-like Accept header.
    if (String(req.headers.accept || '').includes('application/json')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end('{"ok":false,"reason":"unpaired"}')
      return
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAIRING_PAGE)
  })
  try {
    const outcome = await probe.probeHostPath(`http://127.0.0.1:${port}`)
    assert.equal(outcome.kind, 'reached')
    assert.equal(outcome.root, 'gateway-pairing-page')
    assert.equal(outcome.admin, 'gateway-admin-403')
    assert.ok(typeof outcome.ms === 'number' && outcome.ms >= 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the dangerous shape: an exposed admin answers admin-exposed', async () => {
  const { server, port } = await serve((req, res) => {
    if (req.url === '/lan-gate/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html>gateway admin</html>')
      return
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAIRING_PAGE)
  })
  try {
    const outcome = await probe.probeHostPath(`http://127.0.0.1:${port}`)
    assert.equal(outcome.kind, 'reached')
    assert.equal(outcome.admin, 'admin-exposed')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a redirect is classified, never followed (redirect: manual)', async () => {
  const { server, port } = await serve((req, res) => {
    res.writeHead(302, { Location: 'https://elsewhere.example/login' })
    res.end()
  })
  try {
    const outcome = await probe.probeHostPath(`http://127.0.0.1:${port}`)
    assert.equal(outcome.kind, 'reached')
    assert.equal(outcome.root, 'redirect', 'the 302 itself is the verdict — no follow-up request happened')
    assert.equal(outcome.admin, 'unexpected', 'the admin classifier has no redirect branch — a redirect there is just unexpected')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('URL admission reuses normalizeServerUrl: junk is invalid, public plain http is insecure-http', async () => {
  for (const bad of ['not a url', 'ftp://x', 'https://x/path', 'https://x?q=1']) {
    const outcome = await probe.probeHostPath(bad)
    assert.deepEqual(outcome, { kind: 'unreachable', reason: 'invalid-url', ms: 0 }, bad)
  }
  const publicHttp = await probe.probeHostPath('http://dsh.example.com')
  assert.deepEqual(publicHttp, { kind: 'unreachable', reason: 'insecure-http', ms: 0 })
  // …while a private-network plain http URL is admitted (and probes).
  const { server, port } = await serve((req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAIRING_PAGE)
  })
  try {
    const lan = await probe.probeHostPath(`http://127.0.0.1:${port}/`)
    assert.equal(lan.kind, 'reached')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('non-string and empty URLs refuse before any request', async () => {
  const before = Date.now()
  for (const bad of [undefined, null, 42, '', '   ']) {
    const outcome = await probe.probeHostPath(bad)
    assert.equal(outcome.kind, 'unreachable')
    assert.equal(outcome.reason, 'invalid-url')
  }
  assert.ok(Date.now() - before < 500, 'all refusals were local')
})

test('a dead endpoint is network-unreachable; a slow one hits the timeout', async () => {
  const dead = http.createServer()
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))
  const network = await probe.probeHostPath(`http://127.0.0.1:${deadPort}`)
  assert.equal(network.kind, 'unreachable')
  assert.equal(network.reason, 'network')

  const slow = http.createServer(() => { /* never answers */ })
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve))
  try {
    const timeout = await probe.probeHostPath(`http://127.0.0.1:${slow.address().port}`, { timeoutMs: 200 })
    assert.equal(timeout.kind, 'unreachable')
    assert.equal(timeout.reason, 'timeout')
  } finally {
    slow.close()
  }
})
