/* dsh-zen-remote · CP4 gateway hardening
 *
 * Three walls, each pinned by its regression:
 *   1. DNS rebinding — isLocalDirect now also demands a loopback Host, so a
 *      rebound domain (evil.example → 127.0.0.1) is just an unpaired remote:
 *      no token-exchange 303, no cookie, no local surface.
 *   2. Cross-site simple requests — a loopback socket with a loopback Host
 *      can still be a webpage's cross-site POST (no preflight for
 *      text/plain): the local-only endpoints refuse any request carrying an
 *      Origin header (403) and any non-JSON body (415).
 *   3. Revocation cuts HTTP long streams — device forwards register their
 *      client socket for the lifetime of the response, so a revoked device's
 *      NDJSON relay stream dies immediately (previously only WebSocket
 *      tunnels were torn down).
 * Plus the orphan guard: a gateway whose parent died exits on its own
 * instead of squatting on the port forever.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { GATEWAY, REMOTE_HEADERS, startMockAuthTarget, startGateway, request, stopAll, pairDevice, pairDesktop } = require('./util.cjs')

const PORT = 39291
const TARGET_PORT = 39292
const STREAM_TARGET_PORT = 39293
const ORPHAN_PORT = 39295

// ---- 1. DNS rebinding --------------------------------------------------------

test('rebind: a navigation with a rebound Host is an unpaired remote — no 303, no cookie', async () => {
  const target = await startMockAuthTarget(TARGET_PORT)
  const gw = startGateway(PORT, TARGET_PORT, { LAN_GATE_UPSTREAM_TOKEN_URL: 'http://127.0.0.1:' + TARGET_PORT + '/?token=SECRET' })
  await gw.ready
  try {
    const r = await request(PORT, { path: '/', headers: { host: 'evil.example:' + PORT, accept: 'text/html' } })
    assert.notEqual(r.status, 303, 'the token exchange must not fire for a rebound Host')
    assert.strictEqual(r.headers['set-cookie'], undefined, 'no upstream cookie is handed to a rebound Host')
    assert.strictEqual(r.headers.location, undefined, 'no redirect for a rebound Host')
    assert.strictEqual(r.status, 401, 'the request is treated as an unpaired remote')
    assert.ok(r.body.indexOf('Pairing') >= 0 || r.body.indexOf('配对') >= 0, 'the pairing page is what it gets')
  } finally { await stopAll(target.server, gw.child) }
})

test('rebind: the local-only surface refuses a rebound Host — no pairing code, no status', async () => {
  const target = await startMockAuthTarget(TARGET_PORT)
  const gw = startGateway(PORT, TARGET_PORT, { LAN_GATE_UPSTREAM_TOKEN_URL: 'http://127.0.0.1:' + TARGET_PORT + '/?token=SECRET' })
  await gw.ready
  try {
    const mint = await request(PORT, { method: 'POST', path: '/lan-gate/pair', headers: { host: 'evil.example:' + PORT }, body: { role: 'desktop-client' } })
    assert.strictEqual(mint.status, 403, 'pairing-code generation is local-only')
    assert.strictEqual(JSON.parse(mint.body).code, undefined, 'no pairing code leaks to a rebound Host')
    const status = await request(PORT, { path: '/lan-gate/status', headers: { host: 'evil.example:' + PORT } })
    assert.strictEqual(status.status, 403, 'the device list is local-only')
    const action = await request(PORT, { method: 'POST', path: '/lan-gate/action', headers: { host: 'evil.example:' + PORT }, body: { action: 'revoke-all' } })
    assert.strictEqual(action.status, 403, 'admin actions are local-only')
  } finally { await stopAll(target.server, gw.child) }
})

// ---- 2. cross-site simple requests against a loopback Host --------------------

test('csrf: local-only endpoints refuse any request carrying an Origin header (403)', async () => {
  const target = await startMockAuthTarget(TARGET_PORT)
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
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
  } finally { await stopAll(target.server, gw.child) }
})

test('csrf: a text/plain body on /lan-gate/action is 415 and revokes nothing', async () => {
  const target = await startMockAuthTarget(TARGET_PORT)
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  try {
    const { id } = await pairDevice(PORT, 'survivor')
    const csrf = await request(PORT, { method: 'POST', path: '/lan-gate/action', headers: { 'content-type': 'text/plain' }, body: '{"action":"revoke-all"}' })
    assert.strictEqual(csrf.status, 415, 'the simple-request body shape is refused')
    const status = await request(PORT, { path: '/lan-gate/status' })
    assert.ok(status.body.includes('"id":"' + id + '"'), 'the paired device survived the text/plain revoke-all')
    // A browser-form body shape is the same refusal.
    const form = await request(PORT, { method: 'POST', path: '/lan-gate/action', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=revoke-all' })
    assert.strictEqual(form.status, 415)
  } finally { await stopAll(target.server, gw.child) }
})

test('csrf: the plugin backend’s exact call shape still passes (json body, no Origin, loopback Host)', async () => {
  const target = await startMockAuthTarget(TARGET_PORT)
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
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
  } finally { await stopAll(target.server, gw.child) }
})

// ---- 3. revocation cuts device HTTP streams -----------------------------------

test('revoke tears down an open device HTTP stream (forwards register their socket now)', async () => {
  // Upstream: an NDJSON stream that emits a line every 100ms forever — the
  // relay-shaped long response the desktop client parks on.
  const up = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.flushHeaders()
    let n = 0
    const t = setInterval(() => res.write(JSON.stringify({ n: n++ }) + '\n'), 100)
    res.on('close', () => clearInterval(t))
  })
  await new Promise((r) => up.listen(STREAM_TARGET_PORT, '127.0.0.1', r))
  const gw = startGateway(PORT, STREAM_TARGET_PORT, { LAN_GATE_RELAY_SECRET: 's' })
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

// ---- 4. orphan guard ------------------------------------------------------------

// The gateway must notice its parent died (crash / kill -9 — no SIGTERM
// reaches the child) and exit on its own instead of squatting on the port.
// A throwaway intermediary plays the parent: it spawns the gateway, the test
// SIGKILLs the intermediary, and the gateway has to take the port down.
test('orphan guard: a gateway whose parent died exits within a few seconds', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-orphan-'))
  const SPAWNER = 'const { spawn } = require("node:child_process");' +
    'const c = spawn(process.execPath, [process.env.GW], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });' +
    'c.stdout.on("data", (d) => process.stdout.write(d)); c.stderr.on("data", (d) => process.stderr.write(d));' +
    'c.on("exit", () => process.exit(0))'
  const parent = spawn(process.execPath, ['-e', SPAWNER], {
    env: { ...process.env, GW: GATEWAY, DSH_HOME: home, LAN_GATE_PORT: String(ORPHAN_PORT), LAN_GATE_TARGET_PORT: String(TARGET_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
