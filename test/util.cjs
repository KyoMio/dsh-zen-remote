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

function startMockTarget(port, html) {
  const page = html || '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DSH Test</title></head><body><main data-slot="conversation">upstream-ok</main></body></html>'
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
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

module.exports = { GATEWAY, REMOTE_HEADERS, startMockTarget, startGateway, startGatewayAt, request, cookieFrom, pairDevice, stopAll }
