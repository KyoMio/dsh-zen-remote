/* Shared helpers: boot the real gateway child process behind a mock DSH
 * upstream and talk to it over real HTTP. The only test seam is the gateway's
 * HTTP surface. */
'use strict'
const http = require('node:http')
const net = require('node:net')
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

// Desktop-client pairing: mints a desktop-client code locally, redeems it via
// /lan-gate/pair/claim-desktop, returns the Bearer token + device id.
async function pairDesktop(port, name) {
  const gen = await request(port, { method: 'POST', path: '/lan-gate/pair', body: { role: 'desktop-client' } })
  const code = JSON.parse(gen.body).code
  const claim = await request(port, { method: 'POST', path: '/lan-gate/pair/claim-desktop', headers: REMOTE_HEADERS, body: { code, name: name || '台式机' } })
  const j = JSON.parse(claim.body)
  return { gen, claim, j, token: j.token, id: j.id }
}

// Mock DSH upstream that RECORDS every request and every WebSocket upgrade
// (and serves a trivial page): the gateway only pipes raw bytes, no frames
// are exchanged. opts.statusFor(path, req) may return a status code to force
// instead of the default 200. close() first destroys the tunnel sockets: a
// revoked tunnel leaves this side half-open, and server.close() would wait
// on it forever.
function startRecordingTarget(port, opts) {
  const o = opts || {}
  const seen = []
  const upgrades = []
  const tunnels = new Set()
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, headers: req.headers })
    const forced = o.statusFor ? o.statusFor(req.url || '/', req) : 0
    if (forced) { res.writeHead(forced, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('upstream-' + forced); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><main>roles-ok</main></body></html>')
  })
  server.on('upgrade', (req, socket) => {
    upgrades.push({ path: req.url, headers: req.headers })
    tunnels.add(socket)
    socket.on('close', () => tunnels.delete(socket))
    const crypto = require('node:crypto')
    const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    socket.on('error', () => {})
  })
  const close = () => new Promise((resolve) => {
    tunnels.forEach((s) => { try { s.destroy() } catch (e) {} })
    server.close(resolve)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, seen, upgrades, close })))
}

// Raw-socket WebSocket upgrade against the gateway: resolves as soon as the
// first response line is readable (101 = tunnel up, 403 = refused). The
// socket is returned open so the caller can wait for it to be closed.
function rawUpgrade(port, urlPath, headers) {
  return new Promise((resolve) => {
    const lines = ['GET ' + urlPath + ' HTTP/1.1', 'Host: 127.0.0.1', 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13']
    for (const k of Object.keys(headers || {})) lines.push(k + ': ' + headers[k])
    const sock = net.connect(port, '127.0.0.1', () => { sock.write(lines.join('\r\n') + '\r\n\r\n') })
    let buf = ''
    let done = false
    let timer = null
    const finish = () => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve({ sock, buf }) }
    timer = setTimeout(finish, 3000)
    sock.on('data', (d) => { buf += d.toString('utf8'); if (/HTTP\/1\.1 (101|403|429)/.test(buf)) finish() })
    sock.on('close', finish)
    sock.on('error', finish)
  })
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

module.exports = { GATEWAY, REMOTE_HEADERS, startMockTarget, startMockAuthTarget, startGateway, startGatewayAt, request, cookieFrom, pairDevice, pairDesktop, startRecordingTarget, rawUpgrade, stopAll }
