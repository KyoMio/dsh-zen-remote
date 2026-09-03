/* Shared helpers: boot the real gateway child process behind a mock DSH
 * upstream and talk to it over real HTTP. The only test seam is the gateway's
 * HTTP surface. */
'use strict'
const http = require('node:http')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const GATEWAY = path.join(__dirname, '..', 'lib', 'lan-gate-server.cjs')

// Simulates the reverse proxy: loopback socket + forwarded headers = remote client.
const REMOTE_HEADERS = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }

// Mock DSH homepage in the 0.1.2 shape (mirrors the real index.html's
// structure, rev hashes made deterministic): head carries preload links for
// the client-modules combo script, the blocking bootstrap <script>, the
// manifest link and a viewport meta; the body ends with the
// __DSH_BOOT_READY__ settlement script. The gateway's injection lands before
// </head> — i.e. after DSH's bootstrap lines and before __DSH_BOOT_READY__ —
// and the ordering test in gateway.test.cjs guards that. `upstream-ok` is
// the marker older tests assert on, kept inside the conversation main.
function defaultPage() {
  return [
    '<!doctype html><html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<link rel="preload" as="script" href="/plugins/??@deepseek-ai/dsh-client-ui-layout/client.js&rev=testrev-a">',
    '<link rel="preload" as="script" href="/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=testrev-b">',
    '<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=testrev"></script>',
    '<link rel="manifest" href="./manifest.webmanifest" />',
    '</head><body>',
    '<main data-slot="conversation">upstream-ok</main>',
    '<script>window.__DSH_BOOT_READY__ = true</script>',
    '</body></html>'
  ].join('\n')
}

function startMockTarget(port, html) {
  const page = html || defaultPage()
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

// Mock DSH upstream that acts like 0.1.2's browser auth: no signed cookie →
// 401; `GET /?token=T` → 303 + Set-Cookie (unless opts.tokenOk is false, the
// "even the token fails" guard case); cookie present → 200 HTML page;
// /api/* always 401. Every request is recorded in `seen` so tests can assert
// on what the gateway actually sent (e.g. the Host header of the exchange).
function startMockAuthTarget(port, opts) {
  const tokenOk = !opts || opts.tokenOk !== false
  const page = defaultPage()
  const seen = []
  const server = http.createServer((req, res) => {
    const url = req.url || '/'
    seen.push({ method: req.method, path: url, headers: req.headers })
    if (String(url).indexOf('token=') >= 0) {
      if (!tokenOk) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('401 Unauthorized'); return }
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-x=v; Path=/; HttpOnly; SameSite=Strict' })
      res.end()
      return
    }
    if (String(req.headers.cookie || '').indexOf('dsh-auth-x=') >= 0) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page)
      return
    }
    if (String(url).indexOf('/api/') === 0) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('401 Unauthorized'); return }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('401 Unauthorized')
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, seen })))
}

function startGateway(port, targetPort, extraEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-pwa-test-'))
  return startGatewayAt(home, port, targetPort, extraEnv)
}
function startGatewayAt(home, port, targetPort, extraEnv) {
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_HOME: home,
      LAN_GATE_PORT: String(port),
      LAN_GATE_TARGET_PORT: String(targetPort),
      ...(extraEnv || {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const ready = new Promise((resolve) => {
    const t = setInterval(() => { if (out.includes('[lan-gate] listening')) { clearInterval(t); resolve() } }, 25)
    setTimeout(() => { clearInterval(t); resolve() }, 4000)
  })
  return { child, ready, logs: () => out, home }
}

function request(port, opts) {
  const body = opts.body === undefined ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
  const headers = Object.assign({}, opts.headers || {})
  if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json'
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method || 'GET', path: opts.path, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), raw: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function cookieFrom(res) {
  const sc = res.headers['set-cookie']
  if (!sc || !sc.length) return undefined
  return String(sc[0]).split(';')[0]
}

async function pairDevice(port, name) {
  const gen = await request(port, { method: 'POST', path: '/lan-gate/pair' })
  const code = JSON.parse(gen.body).code
  const claim = await request(port, { method: 'POST', path: '/lan-gate/pair/claim', headers: REMOTE_HEADERS, body: { code, name: name || 'test-phone' } })
  return { claim, cookie: cookieFrom(claim), id: JSON.parse(claim.body).id }
}

// Awaits child exit + server close so the next test can rebind the same ports.
function stopAll(target, child) {
  return new Promise((resolve) => {
    let n = (target ? 1 : 0) + (child ? 1 : 0)
    if (n === 0) { resolve(); return }
    const done = () => { if (--n === 0) resolve() }
    if (target) target.close(done)
    if (child) {
      if (child.exitCode !== null) done()
      else { child.once('exit', done); child.kill('SIGTERM') }
    }
  })
}

module.exports = { GATEWAY, REMOTE_HEADERS, startMockTarget, startMockAuthTarget, startGateway, startGatewayAt, request, cookieFrom, pairDevice, stopAll }
