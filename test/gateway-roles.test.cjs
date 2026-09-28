/* dsh-zen-remote · T13 gateway roles: device role, marking headers, relay admission.
 * Boots the real lib/lan-gate-server.cjs behind a RECORDING mock upstream
 * (every request and every WebSocket upgrade is captured) and exercises the
 * desktop-client device surface end to end over real HTTP/WS. */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { REMOTE_HEADERS, startGateway, startGatewayAt, request, cookieFrom, pairDevice, pairDesktop, startRecordingTarget, rawUpgrade, stopAll } = require('./util.cjs')

const PORT = 39241
const TARGET_PORT = 39242

async function boot(extraEnv, targetOpts) {
  const target = await startRecordingTarget(TARGET_PORT, targetOpts)
  const gw = startGateway(PORT, TARGET_PORT, extraEnv)
  await gw.ready
  return { target, gw, stop: () => stopAll({ close: (done) => target.close().then(done, done) }, gw.child) }
}

function socketClosed(sock) {
  return Promise.race([
    new Promise((resolve) => { if (sock.destroyed) resolve(true); else sock.on('close', () => resolve(true)) }),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000))
  ])
}

// Plain GET over a raw socket: for request lines a real HTTP client would
// never produce (backslash separators), the hostile client does not use one.
function rawGet(port, urlPath, headers) {
  return new Promise((resolve) => {
    const lines = ['GET ' + urlPath + ' HTTP/1.1', 'Host: 127.0.0.1', 'Connection: close']
    for (const k of Object.keys(headers || {})) lines.push(k + ': ' + headers[k])
    const sock = net.connect(port, '127.0.0.1', () => { sock.write(lines.join('\r\n') + '\r\n\r\n') })
    let buf = ''
    let done = false
    const finish = () => { if (done) return; done = true; try { sock.destroy() } catch (e) {} resolve(buf) }
    sock.on('data', (d) => { buf += d.toString('utf8') })
    sock.on('close', finish)
    sock.on('error', finish)
    setTimeout(finish, 3000)
  })
}

// ---- 1. state migration -----------------------------------------------------
test('T13-1: a v2 state file without roles backfills role=web and is written back, version stays 2', async () => {
  const webpush = require('web-push')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-roles-'))
  fs.writeFileSync(path.join(home, 'lan-gate-state.json'), JSON.stringify({
    version: 2,
    vapid: webpush.generateVAPIDKeys(),
    pushSubscriptions: {},
    devices: {
      legacy1: { id: 'legacy1', token: 'tok-legacy-1', name: '旧手机', kind: 'auto', createdAt: 1, lastSeen: 2, ua: 'ua' },
      legacy2: { id: 'legacy2', token: 'tok-legacy-2', name: '坏角色', kind: 'phone', role: 'desktop', createdAt: 3, lastSeen: 4, ua: 'ua' }
    }
  }))
  const target = await startRecordingTarget(TARGET_PORT)
  const gw = startGatewayAt(home, PORT, TARGET_PORT)
  await gw.ready
  try {
    const status = JSON.parse((await request(PORT, { path: '/lan-gate/status' })).body)
    assert.strictEqual(status.devices.length, 2)
    for (const d of status.devices) assert.strictEqual(d.role, 'web', 'missing AND invalid role both become web')

    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'lan-gate-state.json'), 'utf8'))
    assert.strictEqual(onDisk.version, 2, 'version stays 2')
    assert.strictEqual(onDisk.devices.legacy1.role, 'web')
    assert.strictEqual(onDisk.devices.legacy2.role, 'web')
  } finally { await stopAll(target.server, gw.child) }
})

// ---- 2. desktop code vs browser claim --------------------------------------
test('T13-2: a desktop code refuses the browser claim with role-mismatch, then the desktop claim redeems it without a cookie', async () => {
  const { stop } = await boot()
  try {
    const gen = await request(PORT, { method: 'POST', path: '/lan-gate/pair', body: { role: 'desktop-client' } })
    const gj = JSON.parse(gen.body)
    assert.strictEqual(gj.role, 'desktop-client', 'the minted code carries its role')

    const browser = await request(PORT, { method: 'POST', path: '/lan-gate/pair/claim', headers: REMOTE_HEADERS, body: { code: gj.code, name: '浏览器' } })
    assert.strictEqual(browser.status, 403)
    const bj = JSON.parse(browser.body)
    assert.strictEqual(bj.ok, false)
    assert.strictEqual(bj.reason, 'role-mismatch')
    assert.strictEqual(bj.expected, 'desktop-client')
    assert.ok(bj.message && bj.message.includes('桌面应用端'), 'human-readable mismatch copy, saw: ' + bj.message)

    const desk = await request(PORT, { method: 'POST', path: '/lan-gate/pair/claim-desktop', headers: REMOTE_HEADERS, body: { code: gj.code, name: '台式机' } })
    assert.strictEqual(desk.status, 200)
    const dj = JSON.parse(desk.body)
    assert.strictEqual(dj.ok, true)
    assert.ok(dj.id && dj.token, 'token handed to the desktop client')
    assert.strictEqual(desk.headers['set-cookie'], undefined, 'desktop claim never plants a cookie')
  } finally { await stop() }
})

// ---- 3. web code vs desktop claim ------------------------------------------
test('T13-3: a web code offered to the desktop claim is refused but stays live for the browser', async () => {
  const { stop } = await boot()
  try {
    const gen = await request(PORT, { method: 'POST', path: '/lan-gate/pair', body: {} })
    const gj = JSON.parse(gen.body)
    assert.strictEqual(gj.role, 'web', 'default role is web')

    const desk = await request(PORT, { method: 'POST', path: '/lan-gate/pair/claim-desktop', headers: REMOTE_HEADERS, body: { code: gj.code, name: '台式机' } })
    assert.strictEqual(desk.status, 403)
    const dj = JSON.parse(desk.body)
    assert.strictEqual(dj.reason, 'role-mismatch')
    assert.strictEqual(dj.expected, 'web')

    const browser = await request(PORT, { method: 'POST', path: '/lan-gate/pair/claim', headers: REMOTE_HEADERS, body: { code: gj.code, name: '手机' } })
    assert.strictEqual(browser.status, 200, 'the code was not consumed by the wrong-channel try')
    assert.ok(cookieFrom(browser), 'web claim plants the cookie')
  } finally { await stop() }
})

// ---- 4. mismatches are not guesses ------------------------------------------
test('T13-4: role mismatches never count toward the lockout', async () => {
  const { stop } = await boot()
  try {
    const gen = await request(PORT, { method: 'POST', path: '/lan-gate/pair', body: { role: 'desktop-client' } })
    const code = JSON.parse(gen.body).code
    // 6 > PAIR_MAX_FAILS (5): counting any of these would lock the client out.
    for (let i = 0; i < 6; i++) {
      const r = await request(PORT, { method: 'POST', path: '/lan-gate/pair/claim', headers: REMOTE_HEADERS, body: { code } })
      assert.strictEqual(r.status, 403, 'try ' + i + ' is a mismatch, not a lockout')
      assert.strictEqual(JSON.parse(r.body).reason, 'role-mismatch')
    }
    const desk = await request(PORT, { method: 'POST', path: '/lan-gate/pair/claim-desktop', headers: REMOTE_HEADERS, body: { code, name: '台式机' } })
    assert.strictEqual(desk.status, 200, 'the right channel still redeems the untouched code')
  } finally { await stop() }
})

// ---- 5. desktop-client admission --------------------------------------------
test('T13-5: a desktop-client token walks the relay and nothing else', async () => {
  const { target, stop } = await boot()
  try {
    const { token, id } = await pairDesktop(PORT)
    // The desktop client sits on ANOTHER machine: loopback + forwarded
    // headers is how a same-host reverse proxy delivers it (a bare loopback
    // socket with no forwards IS the local user, by design).
    const auth = { ...REMOTE_HEADERS, authorization: 'Bearer ' + token }

    const relay = await request(PORT, { path: '/_dsh/zen-remote/relay/ping', headers: auth })
    assert.strictEqual(relay.status, 200, 'relay path is forwarded')
    const hit = target.seen.find((r) => r.path === '/_dsh/zen-remote/relay/ping')
    assert.ok(hit, 'upstream saw the relay request')
    assert.strictEqual(hit.headers['x-zen-remote-via'], 'gateway')
    assert.strictEqual(hit.headers['x-zen-remote-role'], 'desktop-client')
    assert.strictEqual(hit.headers['x-zen-remote-device'], id)
    assert.strictEqual(hit.headers.authorization, undefined, 'the gateway Bearer credential never reaches DSH')

    for (const p of ['/', '/api/x']) {
      const r = await request(PORT, { path: p, headers: auth })
      assert.strictEqual(r.status, 403, p + ' is relay-only for desktop clients')
      assert.strictEqual(JSON.parse(r.body).reason, 'relay-only')
    }
    const sub = await request(PORT, { method: 'POST', path: '/pwa/push/subscribe', headers: auth, body: { subscription: { endpoint: 'https://push.example.com/x' } } })
    assert.strictEqual(sub.status, 403, '/pwa/push/subscribe is relay-only too')
    assert.strictEqual(JSON.parse(sub.body).reason, 'relay-only')

    const cookie = await request(PORT, { path: '/', headers: { ...REMOTE_HEADERS, cookie: 'lg_device=' + token } })
    assert.strictEqual(cookie.status, 401, 'a desktop token presented as a cookie authenticates nothing')
    assert.ok(cookie.body.includes('/lan-gate/pair/claim'), 'and gets the pairing wall, not a DSH page')
  } finally { await stop() }
})

// ---- 6. web devices unchanged -----------------------------------------------
test('T13-6: web devices keep cookie access everywhere (marked role=web) and reject bearer', async () => {
  const { target, stop } = await boot()
  try {
    const { cookie, id } = await pairDevice(PORT, '网页机')
    const token = cookie.split('=')[1]

    const page = await request(PORT, { path: '/', headers: { ...REMOTE_HEADERS, cookie } })
    assert.strictEqual(page.status, 200)
    const hit = target.seen.find((r) => r.path === '/')
    assert.ok(hit, 'upstream saw the proxied page request')
    assert.strictEqual(hit.headers['x-zen-remote-via'], 'gateway')
    assert.strictEqual(hit.headers['x-zen-remote-role'], 'web')
    assert.strictEqual(hit.headers['x-zen-remote-device'], id)

    const bearer = await request(PORT, { path: '/', headers: { ...REMOTE_HEADERS, authorization: 'Bearer ' + token } })
    assert.strictEqual(bearer.status, 401, 'a web token in Authorization is not a desktop client')

    const relay = await request(PORT, { path: '/_dsh/zen-remote/relay/ping', headers: { ...REMOTE_HEADERS, cookie } })
    assert.strictEqual(relay.status, 200, 'the relay prefix is not gated for web devices (unchanged)')
  } finally { await stop() }
})

// ---- 7. forged marking headers ----------------------------------------------
test('T13-7: client-sent x-zen-remote-* is stripped; only the gateway writes the real values', async () => {
  const { target, stop } = await boot()
  try {
    const forged = { 'x-zen-remote-via': 'forged', 'x-zen-remote-role': 'desktop-client', 'x-zen-remote-device': 'spoof' }

    await request(PORT, { path: '/local-direct', headers: { accept: 'text/html', ...forged } })
    let hit = target.seen.find((r) => r.path === '/local-direct')
    assert.ok(hit, 'local direct request reached upstream')
    const leaked = Object.keys(hit.headers).filter((k) => k.indexOf('x-zen-remote-') === 0)
    assert.strictEqual(leaked.length, 0, 'local direct requests carry no x-zen-remote-* headers upstream, got: ' + leaked.join(','))

    const { token, id } = await pairDesktop(PORT)
    await request(PORT, { path: '/_dsh/zen-remote/relay/ping', headers: { ...REMOTE_HEADERS, authorization: 'Bearer ' + token, ...forged } })
    hit = target.seen.find((r) => r.path === '/_dsh/zen-remote/relay/ping')
    assert.ok(hit, 'device relay request reached upstream')
    assert.strictEqual(hit.headers['x-zen-remote-via'], 'gateway', 'forged via replaced by the gateway value')
    assert.strictEqual(hit.headers['x-zen-remote-role'], 'desktop-client')
    assert.strictEqual(hit.headers['x-zen-remote-device'], id, 'device id is the real one, not the forged spoof')
  } finally { await stop() }
})

// ---- 8. websocket admission + revocation ------------------------------------
test('T13-8: desktop-client upgrades only the relay prefix; revoking closes the live tunnel', async () => {
  const { target, stop } = await boot()
  try {
    const { token, id } = await pairDesktop(PORT)
    const headers = { ...REMOTE_HEADERS, authorization: 'Bearer ' + token }

    const rejected = await rawUpgrade(PORT, '/elsewhere/ws', headers)
    assert.ok(/HTTP\/1\.1 403/.test(rejected.buf), 'non-relay upgrade is refused, saw: ' + rejected.buf.slice(0, 40))
    try { rejected.sock.destroy() } catch (e) {}

    const up = await rawUpgrade(PORT, '/_dsh/zen-remote/relay/ws', headers)
    assert.ok(/HTTP\/1\.1 101/.test(up.buf), 'relay upgrade succeeds')
    assert.strictEqual(target.upgrades.length, 1, 'only the relay upgrade reached upstream')
    assert.strictEqual(target.upgrades[0].headers['x-zen-remote-role'], 'desktop-client', 'the upgrade is marked for upstream too')
    assert.strictEqual(target.upgrades[0].headers['x-zen-remote-device'], id)
    const closed = socketClosed(up.sock)

    await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id } })
    assert.ok(await closed, 'revoking the device closed the established tunnel')
    try { up.sock.destroy() } catch (e) {}
  } finally { await stop() }
})

// ---- 9. set-role -------------------------------------------------------------
test('T13-9: set-role validates the value, flips the role, kills the old tunnel, and the credential switches channels', async () => {
  const { stop } = await boot()
  try {
    const { cookie, id } = await pairDevice(PORT, '变身机')

    const bad = await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-role', id, role: 'desktop' } })
    assert.strictEqual(bad.status, 400, 'a display-kind value is not a role')

    const up = await rawUpgrade(PORT, '/ws', { ...REMOTE_HEADERS, cookie })
    assert.ok(/HTTP\/1\.1 101/.test(up.buf), 'web device may open a tunnel before the switch')
    const closed = socketClosed(up.sock)

    const ok = await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-role', id, role: 'desktop-client' } })
    assert.strictEqual(ok.status, 200)

    const status = JSON.parse((await request(PORT, { path: '/lan-gate/status' })).body)
    assert.strictEqual(status.devices[0].role, 'desktop-client', 'status reflects the new role')
    assert.ok(await closed, 'changing the role closed the still-open tunnel')

    const page = await request(PORT, { path: '/', headers: { ...REMOTE_HEADERS, cookie } })
    assert.strictEqual(page.status, 401, 'the old cookie no longer authenticates a web device')
    try { up.sock.destroy() } catch (e) {}
  } finally { await stop() }
})

// ---- 10. admin signpost page --------------------------------------------------
test('T13-10: /lan-gate/admin is a local-only signpost page and the admin chip is gone from proxied HTML', async () => {
  const { stop } = await boot()
  try {
    const zh = await request(PORT, { path: '/lan-gate/admin', headers: { 'accept-language': 'zh-CN' } })
    assert.strictEqual(zh.status, 200)
    assert.ok(zh.body.includes('dsh-zen-remote'), 'the notice names the plugin')
    assert.ok(zh.body.includes('插件'), 'Chinese notice for a Chinese browser')

    const en = await request(PORT, { path: '/lan-gate/admin', headers: { 'accept-language': 'en-US' } })
    assert.strictEqual(en.status, 200)
    assert.ok(en.body.includes('dsh-zen-remote'))

    const remote = await request(PORT, { path: '/lan-gate/admin', headers: REMOTE_HEADERS })
    assert.strictEqual(remote.status, 403, 'still local-only')

    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.strictEqual(page.status, 200)
    assert.ok(!page.body.includes('href="/lan-gate/admin"'), 'proxied HTML carries no admin entry chip')
  } finally { await stop() }
})

// ---- T13-fix 1: the relay prefix cannot be escaped by path tricks ------------
// DSH routes on new URL(req.url).pathname, which resolves dot segments,
// %-encoded dots and backslashes — so the gateway only admits relay paths
// whose RAW and NORMALIZED forms are byte-identical (relayPathOk).
test('T13-fix-1: dot-segment, encoded-dot and backslash paths cannot escape the relay prefix', async () => {
  const { target, stop } = await boot()
  try {
    const { token } = await pairDesktop(PORT)
    const auth = { ...REMOTE_HEADERS, authorization: 'Bearer ' + token }

    const escapes = [
      '/_dsh/zen-remote/relay/../../../api/x',
      '/_dsh/zen-remote/relay/%2e%2e/%2E%2E/%2e%2e/api/x',
      '/_dsh/zen-remote/relay/./x'
    ]
    for (const p of escapes) {
      const r = await request(PORT, { path: p, headers: auth })
      assert.strictEqual(r.status, 403, p + ' must be refused, got ' + r.status)
      assert.strictEqual(JSON.parse(r.body).reason, 'relay-only', p)
    }

    // Backslash traversal straight over a raw socket — a real HTTP client is
    // never in the loop for the shapes a hostile client sends.
    const raw = await rawGet(PORT, '/_dsh/zen-remote/relay/..\\..\\..\\api/x', auth)
    assert.ok(/HTTP\/1\.1 403/.test(raw), 'backslash traversal refused over a raw socket, saw: ' + raw.split('\r\n')[0])

    assert.strictEqual(target.seen.length, 0, 'upstream received none of the escape attempts')
  } finally { await stop() }
})

// '/relay//x' is its own normalized form (WHATWG URL keeps empty segments),
// so raw === normalized and the path still sits under the relay prefix: it
// is a legal relay request, and DSH's router sees exactly the same bytes.
test('T13-fix-1b: a double-slash relay path normalizes to itself and is forwarded', async () => {
  const { target, stop } = await boot()
  try {
    const { token } = await pairDesktop(PORT)
    const r = await request(PORT, { path: '/_dsh/zen-remote/relay//x', headers: { ...REMOTE_HEADERS, authorization: 'Bearer ' + token } })
    assert.strictEqual(r.status, 200, 'raw path === normalized path → allowed')
    assert.ok(target.seen.some((h) => h.path === '/_dsh/zen-remote/relay//x'), 'forwarded verbatim')
  } finally { await stop() }
})

test('T13-fix-1c: the WebSocket upgrade applies the same normalization-aware gate', async () => {
  const { target, stop } = await boot()
  try {
    const { token } = await pairDesktop(PORT)
    const headers = { ...REMOTE_HEADERS, authorization: 'Bearer ' + token }
    for (const p of ['/_dsh/zen-remote/relay/../../../api/terminal/ws', '/_dsh/zen-remote/relay/%2e%2e/ws']) {
      const up = await rawUpgrade(PORT, p, headers)
      assert.ok(/HTTP\/1\.1 403/.test(up.buf), p + ' upgrade refused, saw: ' + up.buf.slice(0, 40))
      try { up.sock.destroy() } catch (e) {}
    }
    // T22a review follow-up: refusal is not just "no 101" — the recording
    // upstream must have received ZERO upgrade requests, i.e. the tunnel was
    // never opened toward DSH, not merely closed right after.
    assert.strictEqual(target.upgrades.length, 0, 'no escape attempt may reach the upstream as an upgrade')
  } finally { await stop() }
})

// The 0.1.2 auth exchange mints a BROWSER session cookie — exactly what the
// relay gate exists to keep from a desktop client. A desktop-client 401 must
// pass through untouched, never trigger an exchange or a tap-through page.
test('T13-fix-1d: an upstream 401 on a relay path reaches the desktop client verbatim, with no cookie exchange', async () => {
  const { target, stop } = await boot(
    { LAN_GATE_UPSTREAM_TOKEN_URL: 'http://127.0.0.1:' + TARGET_PORT + '/?token=TESTTOKEN' },
    { statusFor: (p) => (p.indexOf('/_dsh/zen-remote/relay/locked') === 0 ? 401 : 0) }
  )
  try {
    const { token } = await pairDesktop(PORT)
    const r = await request(PORT, {
      path: '/_dsh/zen-remote/relay/locked',
      headers: { ...REMOTE_HEADERS, authorization: 'Bearer ' + token, accept: 'text/html' }
    })
    assert.strictEqual(r.status, 401, 'the upstream 401 passes through')
    assert.strictEqual(r.headers['set-cookie'], undefined, 'no DSH session cookie is minted for a desktop client')
    assert.ok(!target.seen.some((h) => String(h.path).indexOf('token=') >= 0), 'upstream never received a token-exchange request')
    assert.ok(target.seen.some((h) => h.path === '/_dsh/zen-remote/relay/locked'), 'the relay request itself did reach upstream')
  } finally { await stop() }
})

// ---- T13-fix 3: demotion to desktop-client drops the push subscription -------
test('T13-fix-3: set-role to desktop-client deletes the push subscription', async () => {
  const { stop } = await boot()
  try {
    const { cookie, id } = await pairDevice(PORT, '推送机')
    const sub = await request(PORT, {
      method: 'POST', path: '/pwa/push/subscribe',
      headers: { ...REMOTE_HEADERS, cookie },
      body: { subscription: { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'k', auth: 'a' } } }
    })
    assert.strictEqual(sub.status, 200)
    let status = JSON.parse((await request(PORT, { path: '/lan-gate/status' })).body)
    assert.strictEqual(status.pushSubscriptions, 1)
    assert.strictEqual(status.devices[0].hasPush, true)

    await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-role', id, role: 'desktop-client' } })
    status = JSON.parse((await request(PORT, { path: '/lan-gate/status' })).body)
    assert.strictEqual(status.pushSubscriptions, 0, 'the subscription is gone')
    assert.strictEqual(status.devices[0].hasPush, false)
  } finally { await stop() }
})

// ---- T13-fix 5: set-role on an unknown device 404s ---------------------------
test('T13-fix-5: set-role for a nonexistent device returns 404 no-device', async () => {
  const { stop } = await boot()
  try {
    const r = await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-role', id: 'does-not-exist', role: 'web' } })
    assert.strictEqual(r.status, 404)
    assert.strictEqual(JSON.parse(r.body).reason, 'no-device')
  } finally { await stop() }
})
