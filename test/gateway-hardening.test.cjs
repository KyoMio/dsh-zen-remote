/* dsh-zen-remote · CP4 gateway hardening
 *
 * Three walls, each pinned by its regression:
 *   1. DNS rebinding — isLocalDirect now also demands a loopback Host, so a
 *      rebound domain (evil.example → 127.0.0.1) is just an unpaired remote:
 *      no token-exchange 303, no cookie, no local surface. CP5: the port part
 *      of that Host must be digits, so loopback-named non-ports
 *      ('localhost:evil') fail closed too.
 *   2. Cross-site simple requests — a loopback socket with a loopback Host
 *      can still be a webpage's cross-site POST (no preflight for
 *      text/plain): the local-only endpoints refuse any request carrying an
 *      Origin header (403) and any non-JSON body (415).
 *   3. Revocation cuts HTTP long streams — device forwards register their
 *      client socket for the lifetime of the response, so a revoked device's
 *      NDJSON relay stream dies immediately (previously only WebSocket
 *      tunnels were torn down). CP5: that kill set is counted PER DEVICE — a
 *      pipelined socket serving A's finished response next to B's live stream
 *      leaves A's kill set at A's response end, so revoking A cannot murder
 *      the connection B is still streaming on.
 * Plus the orphan guard: a gateway whose parent died exits on its own
 * instead of squatting on the port forever.
 *
 * Every port is system-assigned (T31-fix, relay-e2e pattern) so parallel
 * test-run copies cannot collide, and every test carries a timeout: the old
 * fixed ports turned an EADDRINUSE from a parallel copy into a silently
 * hung suite (an unresolved listen promise), which is exactly what the
 * timeouts now bound to a visible failure.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { GATEWAY, REMOTE_HEADERS, startMockAuthTarget, startGateway, request, stopAll, pairDevice, pairDesktop, freePort } = require('./util.cjs')

// The current gateway/target pair; tests run sequentially in this file, so
// each test's boot overwrites them freely (module scope mirrors relay-e2e's
// mutable gwPort).
let PORT = 0
let TARGET_PORT = 0
let STREAM_TARGET_PORT = 0

// Poll until fn() returns a truthy value; assert-with-message on timeout so a
// stalled wait surfaces as a named failure, not a silent hang.
async function waitFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.ok(fn(), message)
}

// Boot the gateway behind a freshly-allocated pair; opts may carry the
// token-URL mode the rebind tests need.
//
// Readiness is the gateway's own `listening on 127.0.0.1:<port>` line, and the
// port it names must be the one we handed over: gw.ready's 4s cap would
// otherwise paper over a lost rebind race (busy port → silent fallback) and
// leave every later request pointing at a dead port. Cleanup is registered
// with t.after BEFORE anything can throw, so a failed or timed-out test body
// still tears the child down; stopAll is idempotent, so the tests' own finally
// is just the early path of the same teardown.
async function bootGateway(t, opts) {
  const target = await startMockAuthTarget(0)
  TARGET_PORT = target.server.address().port
  PORT = await freePort()
  const env = opts && opts.tokenUrl ? { LAN_GATE_UPSTREAM_TOKEN_URL: 'http://127.0.0.1:' + TARGET_PORT + '/?token=SECRET' } : undefined
  const gw = startGateway(PORT, TARGET_PORT, env)
  t.after(() => stopAll(target.server, gw.child))
  try {
    const listened = await waitFor(
      () => (gw.logs().match(/listening on 127\.0\.0\.1:(\d+)/) || [])[1],
      8000,
      'the gateway never announced a listening port, logs: ' + gw.logs(),
    )
    assert.strictEqual(Number(listened), PORT, 'the gateway must listen on the handed-over port, logs: ' + gw.logs())
  } catch (e) {
    await stopAll(target.server, gw.child)
    throw e
  }
  return { target, gw, stop: () => stopAll(target.server, gw.child) }
}

// ---- 1. DNS rebinding --------------------------------------------------------

test('rebind: a navigation with a rebound Host is an unpaired remote — no 303, no cookie', { timeout: 20000 }, async (t) => {
  const { stop } = await bootGateway(t, { tokenUrl: true })
  try {
    const r = await request(PORT, { path: '/', headers: { host: 'evil.example:' + PORT, accept: 'text/html' } })
    assert.notEqual(r.status, 303, 'the token exchange must not fire for a rebound Host')
    assert.strictEqual(r.headers['set-cookie'], undefined, 'no upstream cookie is handed to a rebound Host')
    assert.strictEqual(r.headers['location'], undefined, 'no redirect for a rebound Host')
    assert.strictEqual(r.status, 401, 'the request is treated as an unpaired remote')
    assert.ok(r.body.indexOf('Pairing') >= 0 || r.body.indexOf('配对') >= 0, 'the pairing page is what it gets')
  } finally { await stop() }
})

test('rebind: the local-only surface refuses a rebound Host — no pairing code, no status', { timeout: 20000 }, async (t) => {
  const { stop } = await bootGateway(t, { tokenUrl: true })
  try {
    const mint = await request(PORT, { method: 'POST', path: '/lan-gate/pair', headers: { host: 'evil.example:' + PORT }, body: { role: 'desktop-client' } })
    assert.strictEqual(mint.status, 403, 'pairing-code generation is local-only')
    assert.strictEqual(JSON.parse(mint.body).code, undefined, 'no pairing code leaks to a rebound Host')
    const status = await request(PORT, { path: '/lan-gate/status', headers: { host: 'evil.example:' + PORT } })
    assert.strictEqual(status.status, 403, 'the device list is local-only')
    const action = await request(PORT, { method: 'POST', path: '/lan-gate/action', headers: { host: 'evil.example:' + PORT }, body: { action: 'revoke-all' } })
    assert.strictEqual(action.status, 403, 'admin actions are local-only')
  } finally { await stop() }
})

test('rebind: a loopback-named Host with a non-numeric port is not a loopback authority', { timeout: 20000 }, async (t) => {
  const { stop } = await bootGateway(t)
  try {
    // CP5: the port used to be dropped unverified after the last-colon split,
    // so any authority embedding a loopback name ('localhost:evil',
    // 'localhost:<port>@evil') reached the local surface. Now the port part
    // must match ^\d*$ — digits, or no port at all.
    for (const host of ['localhost:evil', 'LOCALHOST:evil', 'localhost:1@evil', 'localhost:1@' + PORT, '[::1]:evil']) {
      const status = await request(PORT, { path: '/lan-gate/status', headers: { host } })
      assert.strictEqual(status.status, 403, 'Host ' + JSON.stringify(host) + ' must stay a stranger')
    }
    // The digit rule is shape-based, not range-based; an empty port is still
    // plain localhost. (Leading/trailing whitespace is refused in the
    // function itself but unreachable here: llhttp trims header values
    // before the handler ever sees them.)
    const emptyPort = await request(PORT, { path: '/lan-gate/status', headers: { host: 'localhost:' } })
    assert.strictEqual(emptyPort.status, 200, 'an empty port is still plain localhost')
    const anyDigits = await request(PORT, { path: '/lan-gate/status', headers: { host: 'localhost:123456' } })
    assert.strictEqual(anyDigits.status, 200, 'digits — any digits — are a port')
  } finally { await stop() }
})

// ---- 2. cross-site simple requests against a loopback Host --------------------

test('csrf: local-only endpoints refuse any request carrying an Origin header (403)', { timeout: 20000 }, async (t) => {
  const { stop } = await bootGateway(t)
  try {
    // The classic cross-site shapes: a no-preflight POST from any webpage, and
    // a rebound-domain fetch (whose Origin is the attacker's origin).
    for (const origin of ['http://evil.example', 'http://127.0.0.1:' + PORT]) {
      const pair = await request(PORT, { method: 'POST', path: '/lan-gate/pair', headers: { origin }, body: { role: 'desktop-client' } })
      assert.strictEqual(pair.status, 403, 'pair with Origin ' + origin + ' is 403')
      const action = await request(PORT, { method: 'POST', path: '/lan-gate/action', headers: { origin }, body: { action: 'revoke-all' } })
      assert.strictEqual(action.status, 403, 'action with Origin ' + origin + ' is 403')
    }
    const status = await request(PORT, { path: '/lan-gate/status', headers: { origin: 'http://evil.example' } })
    assert.strictEqual(status.status, 403, 'status with Origin is 403 too — the plugin backend sends no Origin')
    const push = await request(PORT, { method: 'POST', path: '/pwa/push/send', headers: { origin: 'http://evil.example' }, body: { title: 'x' } })
    assert.strictEqual(push.status, 403, 'push/send with Origin is 403')
  } finally { await stop() }
})

test('csrf: a text/plain body on /lan-gate/action is 415 and revokes nothing', { timeout: 20000 }, async (t) => {
  const { stop } = await bootGateway(t)
  try {
    const { id } = await pairDevice(PORT, 'survivor')
    const csrf = await request(PORT, { method: 'POST', path: '/lan-gate/action', headers: { 'content-type': 'text/plain' }, body: '{"action":"revoke-all"}' })
    assert.strictEqual(csrf.status, 415, 'the simple-request body shape is refused')
    const status = await request(PORT, { path: '/lan-gate/status' })
    assert.ok(status.body.includes('"id":"' + id + '"'), 'the paired device survived the text/plain revoke-all')
    // A browser-form body shape is the same refusal.
    const form = await request(PORT, { method: 'POST', path: '/lan-gate/action', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=revoke-all' })
    assert.strictEqual(form.status, 415)
  } finally { await stop() }
})

test('csrf: the plugin backend’s exact call shape still passes (json body, no Origin, loopback Host)', { timeout: 20000 }, async (t) => {
  const { stop } = await bootGateway(t)
  try {
    // admin-routes callGateway sends Content-Type: application/json; charset=utf-8
    // and no Origin; dsh-push.mjs sends Content-Type: application/json. Both
    // Hosts are 127.0.0.1:<port>.
    const action = await request(PORT, { method: 'POST', path: '/lan-gate/action', headers: { 'content-type': 'application/json; charset=utf-8' }, body: { action: 'new-code', role: 'web' } })
    assert.strictEqual(action.status, 200)
    assert.strictEqual(JSON.parse(action.body).ok, true)
    const pair = await request(PORT, { method: 'POST', path: '/lan-gate/pair' })
    assert.strictEqual(pair.status, 200, 'a body-less POST (the push-test style) is untouched')
    assert.ok(JSON.parse(pair.body).code, 'the pairing code still mints for the real local user')
    const status = await request(PORT, { path: '/lan-gate/status' })
    assert.strictEqual(status.status, 200)
    // Other loopback Host spellings stay local: the settings page and the
    // pairing page both live behind them.
    const viaLocalhost = await request(PORT, { path: '/lan-gate/status', headers: { host: 'localhost:' + PORT } })
    assert.strictEqual(viaLocalhost.status, 200, 'Host localhost stays local')
    const via6 = await request(PORT, { path: '/lan-gate/status', headers: { host: '[::1]:' + PORT } })
    assert.strictEqual(via6.status, 200, 'Host [::1] stays local')
  } finally { await stop() }
})

// ---- 3. revocation cuts device HTTP streams -----------------------------------

// The probe-shaped upstream: /api/fast answers at once, anything else streams
// NDJSON forever at ~10 lines/s. Listens on 0 and reports the kernel's pick.
function startFastAndStreamTarget() {
  const up = http.createServer((req, res) => {
    if (String(req.url || '').indexOf('/api/fast') === 0) { res.end('ok'); return }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.flushHeaders()
    const t = setInterval(() => res.write('x\n'), 100)
    res.on('close', () => clearInterval(t))
  })
  return new Promise((resolve, reject) => {
    up.on('error', reject) // refuse, never hang
    up.listen(0, '127.0.0.1', () => resolve(up))
  })
}

test('revoke tears down an open device HTTP stream (forwards register their socket now)', { timeout: 20000 }, async (t) => {
  // Upstream: an NDJSON stream that emits a line every 100ms forever — the
  // relay-shaped long response the desktop client parks on.
  const up = await startFastAndStreamTarget()
  STREAM_TARGET_PORT = up.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, STREAM_TARGET_PORT, { LAN_GATE_RELAY_SECRET: 's' })
  t.after(() => stopAll(up, gw.child))
  await gw.ready
  try {
    const d = await pairDesktop(PORT)
    let lines = 0
    let closed = false
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/_dsh/zen-remote/relay/v1/stream',
      headers: { ...REMOTE_HEADERS, authorization: 'Bearer ' + d.token, 'content-type': 'application/json' },
    }, (res) => {
      res.on('data', (c) => { lines += String(c).split('\n').filter(Boolean).length })
      res.on('close', () => { closed = true })
    })
    req.end('{}')
    await new Promise((r) => setTimeout(r, 800))
    const before = lines
    assert.ok(before > 0, 'the stream is flowing before the revoke')

    const rv = await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id: d.id } })
    assert.strictEqual(rv.status, 200)
    await new Promise((r) => setTimeout(r, 600))
    assert.strictEqual(closed, true, 'the stream socket was destroyed by the revoke')
    const atClose = lines
    await new Promise((r) => setTimeout(r, 400))
    assert.strictEqual(lines, atClose, 'no lines flow after the revoke (was: kept pushing forever)')
  } finally {
    await stopAll(up, gw.child)
  }
})

// ---- 3b. the forward kill set is counted per device, not per socket ----------
//
// A keep-alive socket serves one request after another, and pipelined ones
// overlap on it. The counting must be per (socket, device): when device A's
// response ends, the socket leaves A's kill set even though device B's stream
// is still riding it — otherwise a later revoke of A murders the connection
// that is serving B, and the socket stays pinned by A forever. Deleting the
// counting logic keeps every earlier test green; these two do not.

// One raw client socket plus the two request strings for devices A (short
// response) and B (endless stream). Tracks everything the socket receives so
// the tests can watch it live on / die after a revoke.
async function openTwoDeviceSocket(port, cookieA, cookieB) {
  const fwd = 'Host: 127.0.0.1\r\nX-Forwarded-For: 203.0.113.9\r\nX-Forwarded-Proto: https\r\n'
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => {}) // a revoke RSTs this socket; that must not crash the file
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('close', () => reject(new Error('socket closed before connect')))
  })
  let data = ''
  let closed = false
  socket.on('data', (c) => { data += c })
  socket.on('close', () => { closed = true })
  return {
    socket,
    reqA: 'GET /api/fast HTTP/1.1\r\n' + fwd + 'Cookie: ' + cookieA + '\r\n\r\n',
    reqB: 'GET /api/stream HTTP/1.1\r\n' + fwd + 'Cookie: ' + cookieB + '\r\n\r\n',
    data: () => data,
    closed: () => closed,
  }
}

test('pipeline: A\'s response ends, B still streams — revoking A must not close the socket', { timeout: 20000 }, async (t) => {
  const up = await startFastAndStreamTarget()
  STREAM_TARGET_PORT = up.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, STREAM_TARGET_PORT, { LAN_GATE_RELAY_SECRET: 's' })
  t.after(() => stopAll(up, gw.child))
  await gw.ready
  try {
    const a = await pairDevice(PORT, 'pipe-a')
    const b = await pairDevice(PORT, 'pipe-b')
    const c = await openTwoDeviceSocket(PORT, a.cookie, b.cookie)
    c.socket.write(c.reqA + c.reqB) // both requests in one write: true pipelining
    await new Promise((r) => setTimeout(r, 700))
    assert.ok(c.data().indexOf('ok') >= 0, 'A\'s short response has fully arrived')
    assert.ok(c.data().length > 2, 'B\'s stream is flowing on the same socket')

    const atRevoke = c.data().length
    const rv = await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id: a.id } })
    assert.strictEqual(rv.status, 200)
    await new Promise((r) => setTimeout(r, 600))
    assert.strictEqual(c.closed(), false, 'revoking A must not kill the socket B is still streaming on')
    assert.ok(c.data().length > atRevoke, 'B\'s stream keeps flowing past the revoke of A')
    c.socket.destroy()
  } finally {
    await stopAll(up, gw.child)
  }
})

test('sequential: A finishes, B streams on the same socket — revoking B disconnects it', { timeout: 20000 }, async (t) => {
  const up = await startFastAndStreamTarget()
  STREAM_TARGET_PORT = up.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, STREAM_TARGET_PORT, { LAN_GATE_RELAY_SECRET: 's' })
  t.after(() => stopAll(up, gw.child))
  await gw.ready
  try {
    const a = await pairDevice(PORT, 'seq-a')
    const b = await pairDevice(PORT, 'seq-b')
    const c = await openTwoDeviceSocket(PORT, a.cookie, b.cookie)
    c.socket.write(c.reqA)
    await new Promise((r) => setTimeout(r, 300))
    c.socket.write(c.reqB)
    await new Promise((r) => setTimeout(r, 700))
    assert.ok(c.data().indexOf('ok') >= 0 && c.closed() === false, 'A\'s response is done and B is streaming, socket alive')

    const rv = await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id: b.id } })
    assert.strictEqual(rv.status, 200)
    await new Promise((r) => setTimeout(r, 600))
    assert.strictEqual(c.closed(), true, 'revoking B destroys the socket it is streaming on')
    c.socket.destroy()
  } finally {
    await stopAll(up, gw.child)
  }
})

// ---- 4. orphan guard ------------------------------------------------------------

// The gateway must notice its parent died (crash / kill -9 — no SIGTERM
// reaches the child) and exit on its own instead of squatting on the port.
// A throwaway intermediary plays the parent: it spawns the gateway, the test
// SIGKILLs the intermediary, and the gateway has to take the port down.
test('orphan guard: a gateway whose parent died exits within a few seconds', { timeout: 30000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-orphan-'))
  const ORPHAN_PORT = await freePort()
  const SPAWNER = 'const { spawn } = require("node:child_process");' +
    'const c = spawn(process.execPath, [process.env.GW], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });' +
    'c.stdout.on("data", (d) => process.stdout.write(d)); c.stderr.on("data", (d) => process.stderr.write(d));' +
    'c.on("exit", () => process.exit(0))'
  const parent = spawn(process.execPath, ['-e', SPAWNER], {
    env: { ...process.env, GW: GATEWAY, DSH_HOME: home, LAN_GATE_PORT: String(ORPHAN_PORT), LAN_GATE_TARGET_PORT: String(await freePort()) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { try { parent.kill('SIGKILL') } catch (e) {} })
  let out = ''
  parent.stdout.on('data', (d) => { out += d })
  parent.stderr.on('data', (d) => { out += d })
  try {
    await new Promise((resolve, reject) => {
      const t = setInterval(() => { if (out.includes('[lan-gate] listening')) { clearInterval(t); resolve() } }, 25)
      setTimeout(() => { clearInterval(t); reject(new Error('gateway never came up: ' + out)) }, 5000)
    })
    // The gateway may have had to fall back from the requested port (a
    // leftover listener from an earlier run, say) — probe whichever port the
    // listening line names, not the one we asked for.
    const listened = out.match(/listening on 127\.0\.0\.1:(\d+)/)
    assert.ok(listened, 'the listening line names the port: ' + out)
    const livePort = Number(listened[1])
    parent.kill('SIGKILL') // the crash: no SIGTERM reaches the gateway
    // The port must free itself: poll until connect fails, well past the 5s
    // check interval.
    const deadline = Date.now() + 12000
    let freed = false
    while (Date.now() < deadline && !freed) {
      await new Promise((r) => setTimeout(r, 250))
      freed = await new Promise((resolve) => {
        const probe = http.get({ host: '127.0.0.1', port: livePort, path: '/lan-gate/status', timeout: 500 }, (res) => {
          res.resume()
          resolve(false) // still answering — still alive
        })
        probe.on('error', () => resolve(true)) // connection refused — gone
        probe.on('timeout', () => { probe.destroy(); resolve(false) })
      })
    }
    assert.strictEqual(freed, true, 'the orphaned gateway gave the port back on its own\n--- gateway output ---\n' + out)
  } finally {
    try { parent.kill('SIGKILL') } catch (e) {}
    try { fs.rmSync(home, { recursive: true, force: true }) } catch (e) {}
  }
})
