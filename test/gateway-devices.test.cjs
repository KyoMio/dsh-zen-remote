/* dsh-zen-remote · gateway devices: roles, marking headers, relay admission & T59 device-name sync */
'use strict'
const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { REMOTE_HEADERS, startGateway, startGatewayAt, request, cookieFrom, pairDevice, pairDesktop, startRecordingTarget, rawUpgrade, stopAll } = require('./util.cjs')

const DEVICE_NAME_PATH = '/_dsh/zen-remote/relay/v1/device/name'

let SHARED_PORT = 0
let sharedTarget
let sharedGw

before(async () => {
  sharedTarget = await startRecordingTarget(0)
  sharedGw = startGateway(0, sharedTarget.server.address().port)
  SHARED_PORT = await sharedGw.ready
})

after(async () => {
  await stopAll({ close: (done) => sharedTarget.close().then(done, done) }, sharedGw && sharedGw.child)
})

beforeEach(() => {
  sharedTarget.seen.length = 0
  sharedTarget.upgrades.length = 0
})

async function boot(extraEnv, targetOpts) {
  const target = await startRecordingTarget(0, targetOpts)
  const targetPort = target.server.address().port
  const resolvedEnv = typeof extraEnv === 'function' ? extraEnv(targetPort) : extraEnv
  const gw = startGateway(0, targetPort, resolvedEnv)
  const port = await gw.ready
  return { port, targetPort, target, gw, stop: () => stopAll({ close: (done) => target.close().then(done, done) }, gw.child) }
}

function socketClosed(sock) {
  let timer
  return Promise.race([
    new Promise((resolve) => { if (sock.destroyed) resolve(true); else sock.on('close', () => resolve(true)) }),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), 3000) }),
  ]).finally(() => clearTimeout(timer))
}

function rawGet(port, urlPath, headers) {
  return new Promise((resolve) => {
    const lines = ['GET ' + urlPath + ' HTTP/1.1', 'Host: 127.0.0.1', 'Connection: close']
    for (const k of Object.keys(headers || {})) lines.push(k + ': ' + headers[k])
    const sock = net.connect(port, '127.0.0.1', () => { sock.write(lines.join('\r\n') + '\r\n\r\n') })
    let buf = ''
    let done = false
    let timer
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy() } catch (e) {} resolve(buf) }
    sock.on('data', (d) => { buf += d.toString('utf8') })
    sock.on('close', finish)
    sock.on('error', finish)
    timer = setTimeout(finish, 3000)
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
  const target = await startRecordingTarget(0)
  const gw = startGatewayAt(home, 0, target.server.address().port)
  const port = await gw.ready
  try {
    const status = JSON.parse((await request(port, { path: '/lan-gate/status' })).body)
    assert.strictEqual(status.devices.length, 2)
    for (const d of status.devices) assert.strictEqual(d.role, 'web', 'missing AND invalid role both become web')

    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'lan-gate-state.json'), 'utf8'))
    assert.strictEqual(onDisk.version, 2, 'version stays 2')
    assert.strictEqual(onDisk.devices.legacy1.role, 'web')
    assert.strictEqual(onDisk.devices.legacy2.role, 'web')
  } finally {
    await stopAll(target.server, gw.child)
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ---- 2. desktop code vs browser claim --------------------------------------
test('T13-2: a desktop code refuses the browser claim with role-mismatch, then the desktop claim redeems it without a cookie', async () => {
  const gen = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair', body: { role: 'desktop-client' } })
  const gj = JSON.parse(gen.body)
  assert.strictEqual(gj.role, 'desktop-client', 'the minted code carries its role')

  const browser = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair/claim', headers: REMOTE_HEADERS, body: { code: gj.code, name: '浏览器' } })
  assert.strictEqual(browser.status, 403)
  const bj = JSON.parse(browser.body)
  assert.strictEqual(bj.ok, false)
  assert.strictEqual(bj.reason, 'role-mismatch')
  assert.strictEqual(bj.expected, 'desktop-client')
  assert.ok(bj.message && bj.message.includes('桌面应用端'), 'human-readable mismatch copy, saw: ' + bj.message)

  const desk = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair/claim-desktop', headers: REMOTE_HEADERS, body: { code: gj.code, name: '台式机' } })
  assert.strictEqual(desk.status, 200)
  const dj = JSON.parse(desk.body)
  assert.strictEqual(dj.ok, true)
  assert.ok(dj.id && dj.token, 'token handed to the desktop client')
  assert.strictEqual(desk.headers['set-cookie'], undefined, 'desktop claim never plants a cookie')
})

// ---- 3. web code vs desktop claim ------------------------------------------
test('T13-3: a web code offered to the desktop claim is refused but stays live for the browser', async () => {
  const gen = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair', body: {} })
  const gj = JSON.parse(gen.body)
  assert.strictEqual(gj.role, 'web', 'default role is web')

  const desk = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair/claim-desktop', headers: REMOTE_HEADERS, body: { code: gj.code, name: '台式机' } })
  assert.strictEqual(desk.status, 403)
  const dj = JSON.parse(desk.body)
  assert.strictEqual(dj.reason, 'role-mismatch')
  assert.strictEqual(dj.expected, 'web')

  const browser = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair/claim', headers: REMOTE_HEADERS, body: { code: gj.code, name: '手机' } })
  assert.strictEqual(browser.status, 200, 'the code was not consumed by the wrong-channel try')
  assert.ok(cookieFrom(browser), 'web claim plants the cookie')
})

// ---- 4. mismatches are not guesses ------------------------------------------
test('T13-4: role mismatches never count toward the lockout', async () => {
  const gen = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair', body: { role: 'desktop-client' } })
  const code = JSON.parse(gen.body).code
  for (let i = 0; i < 6; i++) {
    const r = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair/claim', headers: REMOTE_HEADERS, body: { code } })
    assert.strictEqual(r.status, 403, 'try ' + i + ' is a mismatch, not a lockout')
    assert.strictEqual(JSON.parse(r.body).reason, 'role-mismatch')
  }
  const desk = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair/claim-desktop', headers: REMOTE_HEADERS, body: { code, name: '台式机' } })
  assert.strictEqual(desk.status, 200, 'the right channel still redeems the untouched code')
})

// ---- 5. desktop-client admission --------------------------------------------
test('T13-5: a desktop-client token walks the relay and nothing else', async () => {
  const { token, id } = await pairDesktop(SHARED_PORT)
  const auth = { ...REMOTE_HEADERS, authorization: 'Bearer ' + token }

  const relay = await request(SHARED_PORT, { path: '/_dsh/zen-remote/relay/ping', headers: auth })
  assert.strictEqual(relay.status, 200, 'relay path is forwarded')
  const hit = sharedTarget.seen.find((r) => r.path === '/_dsh/zen-remote/relay/ping')
  assert.ok(hit, 'upstream saw the relay request')
  assert.strictEqual(hit.headers['x-zen-remote-via'], 'gateway')
  assert.strictEqual(hit.headers['x-zen-remote-role'], 'desktop-client')
  assert.strictEqual(hit.headers['x-zen-remote-device'], id)
  assert.strictEqual(hit.headers.authorization, undefined, 'the gateway Bearer credential never reaches DSH')

  for (const p of ['/', '/api/x']) {
    const r = await request(SHARED_PORT, { path: p, headers: auth })
    assert.strictEqual(r.status, 403, p + ' is relay-only for desktop clients')
    assert.strictEqual(JSON.parse(r.body).reason, 'relay-only')
  }
  const sub = await request(SHARED_PORT, { method: 'POST', path: '/pwa/push/subscribe', headers: auth, body: { subscription: { endpoint: 'https://push.example.com/x' } } })
  assert.strictEqual(sub.status, 403, '/pwa/push/subscribe is relay-only too')
  assert.strictEqual(JSON.parse(sub.body).reason, 'relay-only')

  const cookie = await request(SHARED_PORT, { path: '/', headers: { ...REMOTE_HEADERS, cookie: 'lg_device=' + token } })
  assert.strictEqual(cookie.status, 401, 'a desktop token presented as a cookie authenticates nothing')
  assert.ok(cookie.body.includes('/lan-gate/pair/claim'), 'and gets the pairing wall, not a DSH page')
})

// ---- 6. web devices unchanged -----------------------------------------------
test('T13-6: web devices keep cookie access everywhere (marked role=web) and reject bearer', async () => {
  const { cookie, id } = await pairDevice(SHARED_PORT, '网页机')
  const token = cookie.split('=')[1]

  const page = await request(SHARED_PORT, { path: '/', headers: { ...REMOTE_HEADERS, cookie } })
  assert.strictEqual(page.status, 200)
  const hit = sharedTarget.seen.find((r) => r.path === '/')
  assert.ok(hit, 'upstream saw the proxied page request')
  assert.strictEqual(hit.headers['x-zen-remote-via'], 'gateway')
  assert.strictEqual(hit.headers['x-zen-remote-role'], 'web')
  assert.strictEqual(hit.headers['x-zen-remote-device'], id)

  const bearer = await request(SHARED_PORT, { path: '/', headers: { ...REMOTE_HEADERS, authorization: 'Bearer ' + token } })
  assert.strictEqual(bearer.status, 401, 'a web token in Authorization is not a desktop client')

  const relay = await request(SHARED_PORT, { path: '/_dsh/zen-remote/relay/ping', headers: { ...REMOTE_HEADERS, cookie } })
  assert.strictEqual(relay.status, 200, 'the relay prefix is not gated for web devices (unchanged)')
})

// ---- 7. forged marking headers ----------------------------------------------
test('T13-7: client-sent x-zen-remote-* is stripped; only the gateway writes the real values', async () => {
  const forged = { 'x-zen-remote-via': 'forged', 'x-zen-remote-role': 'desktop-client', 'x-zen-remote-device': 'spoof' }

  await request(SHARED_PORT, { path: '/local-direct', headers: { accept: 'text/html', ...forged } })
  let hit = sharedTarget.seen.find((r) => r.path === '/local-direct')
  assert.ok(hit, 'local direct request reached upstream')
  const leaked = Object.keys(hit.headers).filter((k) => k.indexOf('x-zen-remote-') === 0)
  assert.strictEqual(leaked.length, 0, 'local direct requests carry no x-zen-remote-* headers upstream, got: ' + leaked.join(','))

  const { token, id } = await pairDesktop(SHARED_PORT)
  await request(SHARED_PORT, { path: '/_dsh/zen-remote/relay/ping', headers: { ...REMOTE_HEADERS, authorization: 'Bearer ' + token, ...forged } })
  hit = sharedTarget.seen.find((r) => r.path === '/_dsh/zen-remote/relay/ping')
  assert.ok(hit, 'device relay request reached upstream')
  assert.strictEqual(hit.headers['x-zen-remote-via'], 'gateway', 'forged via replaced by the gateway value')
  assert.strictEqual(hit.headers['x-zen-remote-role'], 'desktop-client')
  assert.strictEqual(hit.headers['x-zen-remote-device'], id, 'device id is the real one, not the forged spoof')
})

// ---- 8. websocket admission + revocation ------------------------------------
test('T13-8: desktop-client upgrades only the relay prefix; revoking closes the live tunnel', async () => {
  const { token, id } = await pairDesktop(SHARED_PORT)
  const headers = { ...REMOTE_HEADERS, authorization: 'Bearer ' + token }

  const rejected = await rawUpgrade(SHARED_PORT, '/elsewhere/ws', headers)
  assert.ok(/HTTP\/1\.1 403/.test(rejected.buf), 'non-relay upgrade is refused, saw: ' + rejected.buf.slice(0, 40))
  try { rejected.sock.destroy() } catch (e) {}

  const up = await rawUpgrade(SHARED_PORT, '/_dsh/zen-remote/relay/ws', headers)
  assert.ok(/HTTP\/1\.1 101/.test(up.buf), 'relay upgrade succeeds')
  assert.strictEqual(sharedTarget.upgrades.length, 1, 'only the relay upgrade reached upstream')
  assert.strictEqual(sharedTarget.upgrades[0].headers['x-zen-remote-role'], 'desktop-client', 'the upgrade is marked for upstream too')
  assert.strictEqual(sharedTarget.upgrades[0].headers['x-zen-remote-device'], id)
  const closed = socketClosed(up.sock)

  await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id } })
  assert.ok(await closed, 'revoking the device closed the established tunnel')
  try { up.sock.destroy() } catch (e) {}
})

// ---- 9. set-role -------------------------------------------------------------
test('T13-9: set-role validates the value, flips the role, kills the old tunnel, and the credential switches channels', async () => {
  const { cookie, id } = await pairDevice(SHARED_PORT, '变身机')

  const bad = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-role', id, role: 'desktop' } })
  assert.strictEqual(bad.status, 400, 'a display-kind value is not a role')

  const up = await rawUpgrade(SHARED_PORT, '/ws', { ...REMOTE_HEADERS, cookie })
  assert.ok(/HTTP\/1\.1 101/.test(up.buf), 'web device may open a tunnel before the switch')
  const closed = socketClosed(up.sock)

  const ok = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-role', id, role: 'desktop-client' } })
  assert.strictEqual(ok.status, 200)

  const status = JSON.parse((await request(SHARED_PORT, { path: '/lan-gate/status' })).body)
  assert.strictEqual(status.devices.find((d) => d.id === id).role, 'desktop-client', 'status reflects the new role')
  assert.ok(await closed, 'changing the role closed the still-open tunnel')

  const page = await request(SHARED_PORT, { path: '/', headers: { ...REMOTE_HEADERS, cookie } })
  assert.strictEqual(page.status, 401, 'the old cookie no longer authenticates a web device')
  try { up.sock.destroy() } catch (e) {}
})

// ---- 10. admin signpost page --------------------------------------------------
test('T13-10: /lan-gate/admin is a local-only signpost page and the admin chip is gone from proxied HTML', async () => {
  const zh = await request(SHARED_PORT, { path: '/lan-gate/admin', headers: { 'accept-language': 'zh-CN' } })
  assert.strictEqual(zh.status, 200)
  assert.ok(zh.body.includes('dsh-zen-remote'), 'the notice names the plugin')
  assert.ok(zh.body.includes('插件'), 'Chinese notice for a Chinese browser')

  const en = await request(SHARED_PORT, { path: '/lan-gate/admin', headers: { 'accept-language': 'en-US' } })
  assert.strictEqual(en.status, 200)
  assert.ok(en.body.includes('dsh-zen-remote'))

  const remote = await request(SHARED_PORT, { path: '/lan-gate/admin', headers: REMOTE_HEADERS })
  assert.strictEqual(remote.status, 403, 'still local-only')

  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  assert.strictEqual(page.status, 200)
  assert.ok(!page.body.includes('href="/lan-gate/admin"'), 'proxied HTML carries no admin entry chip')
})

// ---- T13-fix 1: the relay prefix cannot be escaped by path tricks ------------
test('T13-fix-1: dot-segment, encoded-dot and backslash paths cannot escape the relay prefix', async () => {
  const { token } = await pairDesktop(SHARED_PORT)
  const auth = { ...REMOTE_HEADERS, authorization: 'Bearer ' + token }

  const escapes = [
    '/_dsh/zen-remote/relay/../../../api/x',
    '/_dsh/zen-remote/relay/%2e%2e/%2E%2E/%2e%2e/api/x',
    '/_dsh/zen-remote/relay/./x'
  ]
  for (const p of escapes) {
    const r = await request(SHARED_PORT, { path: p, headers: auth })
    assert.strictEqual(r.status, 403, p + ' must be refused, got ' + r.status)
    assert.strictEqual(JSON.parse(r.body).reason, 'relay-only', p)
  }

  const raw = await rawGet(SHARED_PORT, '/_dsh/zen-remote/relay/..\\..\\..\\api/x', auth)
  assert.ok(/HTTP\/1\.1 403/.test(raw), 'backslash traversal refused over a raw socket, saw: ' + raw.split('\r\n')[0])

  assert.strictEqual(sharedTarget.seen.length, 0, 'upstream received none of the escape attempts')
})

test('T13-fix-1b: a double-slash relay path normalizes to itself and is forwarded', async () => {
  const { token } = await pairDesktop(SHARED_PORT)
  const r = await request(SHARED_PORT, { path: '/_dsh/zen-remote/relay//x', headers: { ...REMOTE_HEADERS, authorization: 'Bearer ' + token } })
  assert.strictEqual(r.status, 200, 'raw path === normalized path → allowed')
  assert.ok(sharedTarget.seen.some((h) => h.path === '/_dsh/zen-remote/relay//x'), 'forwarded verbatim')
})

test('T13-fix-1c: the WebSocket upgrade applies the same normalization-aware gate', async () => {
  const { token } = await pairDesktop(SHARED_PORT)
  const headers = { ...REMOTE_HEADERS, authorization: 'Bearer ' + token }
  for (const p of ['/_dsh/zen-remote/relay/../../../api/terminal/ws', '/_dsh/zen-remote/relay/%2e%2e/ws']) {
    const up = await rawUpgrade(SHARED_PORT, p, headers)
    assert.ok(/HTTP\/1\.1 403/.test(up.buf), p + ' upgrade refused, saw: ' + up.buf.slice(0, 40))
    try { up.sock.destroy() } catch (e) {}
  }
  assert.strictEqual(sharedTarget.upgrades.length, 0, 'no escape attempt may reach the upstream as an upgrade')
})

test('T13-fix-1d: an upstream 401 on a relay path reaches the desktop client verbatim, with no cookie exchange', async () => {
  const { port, target, stop } = await boot(
    (targetPort) => ({ LAN_GATE_UPSTREAM_TOKEN_URL: 'http://127.0.0.1:' + targetPort + '/?token=TESTTOKEN' }),
    { statusFor: (p) => (p.indexOf('/_dsh/zen-remote/relay/locked') === 0 ? 401 : 0) }
  )
  try {
    const { token } = await pairDesktop(port)
    const r = await request(port, {
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
  const { cookie, id } = await pairDevice(SHARED_PORT, '推送机')
  const beforeSubs = JSON.parse((await request(SHARED_PORT, { path: '/lan-gate/status' })).body).pushSubscriptions
  const sub = await request(SHARED_PORT, {
    method: 'POST', path: '/pwa/push/subscribe',
    headers: { ...REMOTE_HEADERS, cookie },
    body: { subscription: { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'k', auth: 'a' } } }
  })
  assert.strictEqual(sub.status, 200)
  let status = JSON.parse((await request(SHARED_PORT, { path: '/lan-gate/status' })).body)
  assert.strictEqual(status.pushSubscriptions, beforeSubs + 1)
  assert.strictEqual(status.devices.find((d) => d.id === id).hasPush, true)

  await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-role', id, role: 'desktop-client' } })
  status = JSON.parse((await request(SHARED_PORT, { path: '/lan-gate/status' })).body)
  assert.strictEqual(status.pushSubscriptions, beforeSubs, 'the subscription is gone')
  assert.strictEqual(status.devices.find((d) => d.id === id).hasPush, false)
})

// ---- T13-fix 5: set-role on an unknown device 404s ---------------------------
test('T13-fix-5: set-role for a nonexistent device returns 404 no-device', async () => {
  const r = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-role', id: 'does-not-exist', role: 'web' } })
  assert.strictEqual(r.status, 404)
  assert.strictEqual(JSON.parse(r.body).reason, 'no-device')
})

test('dual pairing codes: /lan-gate/pair mints both web code and desktopCode simultaneously, and both redeem on their respective channels', async () => {
  const gen = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair', body: { role: 'web' } })
  const gj = JSON.parse(gen.body)
  assert.strictEqual(gj.ok, true)
  assert.ok(typeof gj.code === 'string' && gj.code.length === 8)
  assert.ok(typeof gj.desktopCode === 'string' && gj.desktopCode.length === 8)
  assert.notStrictEqual(gj.code, gj.desktopCode)

  const desk = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair/claim-desktop', headers: REMOTE_HEADERS, body: { code: gj.desktopCode, name: 'MacBook' } })
  assert.strictEqual(desk.status, 200)
  assert.strictEqual(JSON.parse(desk.body).ok, true)

  const web = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair/claim', headers: REMOTE_HEADERS, body: { code: gj.code, name: 'iPhone' } })
  assert.strictEqual(web.status, 200)
  assert.ok(cookieFrom(web))
})

// ---- T59 device-name sync (merged from gateway-device-name.test.cjs) --------

test('T59 gateway: desktop-client forwards carry the percent-encoded device-name header; a forged one is dropped', async () => {
  const { token } = await pairDesktop(SHARED_PORT, '书房的台式机')
  const res = await request(SHARED_PORT, {
    method: 'POST',
    path: '/_dsh/zen-remote/relay/v1/handshake',
    headers: {
      ...REMOTE_HEADERS,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-zen-remote-device': 'forged-id',
      'x-zen-remote-device-name': 'forged-name',
    },
    body: {},
  })
  assert.strictEqual(res.status, 200)
  const upstream = sharedTarget.seen.find((row) => String(row.path).split('?')[0] === '/_dsh/zen-remote/relay/v1/handshake')
  assert.notEqual(upstream, undefined, 'the forward reached the upstream')
  assert.strictEqual(upstream.headers['x-zen-remote-device-name'], encodeURIComponent('书房的台式机'), 'the gateway wrote ITS table name, encoded')
  assert.notEqual(upstream.headers['x-zen-remote-device'], 'forged-id', 'the forged device id was dropped too')
})

test('T59 gateway: device/name renames the CALLER only, validates the name, and never forwards', async () => {
  const own = await pairDesktop(SHARED_PORT, '旧名')
  const other = await pairDesktop(SHARED_PORT, '另一台')

  const ok = await request(SHARED_PORT, {
    method: 'POST',
    path: DEVICE_NAME_PATH,
    headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
    body: { name: '  书房的新名字  ' },
  })
  assert.strictEqual(ok.status, 200)
  assert.deepStrictEqual(JSON.parse(ok.body), { ok: true, name: '书房的新名字' })

  const status = JSON.parse((await request(SHARED_PORT, { path: '/lan-gate/status' })).body)
  const byId = new Map(status.devices.map((d) => [d.id, d.name]))
  assert.strictEqual(byId.get(own.id), '书房的新名字')
  assert.strictEqual(byId.get(other.id), '另一台')

  await request(SHARED_PORT, {
    method: 'POST',
    path: '/_dsh/zen-remote/relay/v1/handshake',
    headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
    body: {},
  })
  const forward = sharedTarget.seen.filter((row) => String(row.path).split('?')[0] === '/_dsh/zen-remote/relay/v1/handshake').pop()
  assert.strictEqual(forward.headers['x-zen-remote-device-name'], encodeURIComponent('书房的新名字'))

  for (const bad of ['', '   ']) {
    const res = await request(SHARED_PORT, {
      method: 'POST',
      path: DEVICE_NAME_PATH,
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
      body: { name: bad },
    })
    assert.strictEqual(res.status, 400, 'an empty-after-trim name is refused')
  }
  const after = JSON.parse((await request(SHARED_PORT, { path: '/lan-gate/status' })).body)
  assert.strictEqual(new Map(after.devices.map((d) => [d.id, d.name])).get(own.id), '书房的新名字', 'the table survived the bad bodies')

  const truncated = await request(SHARED_PORT, {
    method: 'POST',
    path: DEVICE_NAME_PATH,
    headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
    body: { name: 'y'.repeat(41) },
  })
  assert.strictEqual(truncated.status, 200)
  assert.deepStrictEqual(JSON.parse(truncated.body), { ok: true, name: 'y'.repeat(40) }, 'over cap truncates to 40 whole characters')

  const hits = sharedTarget.seen.filter((row) => String(row.path).split('?')[0] === DEVICE_NAME_PATH)
  assert.strictEqual(hits.length, 0, 'the endpoint was answered by the gateway, not proxied')

  const web = await pairDevice(SHARED_PORT, '手机')
  const webRes = await request(SHARED_PORT, {
    method: 'POST',
    path: DEVICE_NAME_PATH,
    headers: { ...REMOTE_HEADERS, cookie: web.cookie, 'content-type': 'application/json' },
    body: { name: '手机改名' },
  })
  assert.strictEqual(webRes.status, 403, 'a web device cannot rename anything here')
  const anonRes = await request(SHARED_PORT, {
    method: 'POST',
    path: DEVICE_NAME_PATH,
    headers: { ...REMOTE_HEADERS, 'content-type': 'application/json' },
    body: { name: '匿名' },
  })
  assert.strictEqual(anonRes.status, 403, 'an unauthenticated caller is refused')
  const localRes = await request(SHARED_PORT, { method: 'POST', path: DEVICE_NAME_PATH, headers: { 'content-type': 'application/json' }, body: { name: '本机' } })
  assert.strictEqual(localRes.status, 403, 'the local user is not a device')

  const getStatus = await request(SHARED_PORT, {
    method: 'GET',
    path: DEVICE_NAME_PATH,
    headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}` },
  })
  assert.strictEqual(getStatus.status, 405)

  const alive = await request(SHARED_PORT, { path: '/lan-gate/status' })
  assert.strictEqual(alive.status, 200)
  assert.ok(sharedGw.child.pid > 0)
})

test('T59-fix: a lone-surrogate rename is answered sanitized — the gateway lives on', async () => {
  const own = await pairDesktop(SHARED_PORT, '旧名')
  const res = await request(SHARED_PORT, {
    method: 'POST',
    path: DEVICE_NAME_PATH,
    headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
    body: { name: '\ud800' },
  })
  assert.strictEqual(res.status, 200)
  assert.deepStrictEqual(JSON.parse(res.body), { ok: true, name: '\uFFFD' })

  const alive = await request(SHARED_PORT, {
    method: 'POST',
    path: '/_dsh/zen-remote/relay/v1/handshake',
    headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
    body: {},
  })
  assert.strictEqual(alive.status, 200, 'the gateway survived the poison name')
  const forward = sharedTarget.seen.filter((row) => String(row.path).split('?')[0] === '/_dsh/zen-remote/relay/v1/handshake').pop()
  assert.strictEqual(forward.headers['x-zen-remote-device-name'], encodeURIComponent('\uFFFD'))
  assert.ok(sharedGw.child.pid > 0)
})

test('T59-fix: a pairing name cut at 39 chars + an emoji keeps the WHOLE emoji; the admin rename too', async () => {
  const gen = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair', body: { role: 'desktop-client' } })
  const code = JSON.parse(gen.body).code
  const claim = await request(SHARED_PORT, {
    method: 'POST',
    path: '/lan-gate/pair/claim-desktop',
    headers: REMOTE_HEADERS,
    body: { code, name: 'a'.repeat(39) + '\u{1F600}' },
  })
  assert.strictEqual(claim.status, 200)
  const j = JSON.parse(claim.body)
  assert.strictEqual(j.name, 'a'.repeat(39) + '\u{1F600}', 'the whole emoji survived the cap')

  const forward = await request(SHARED_PORT, {
    method: 'POST',
    path: '/_dsh/zen-remote/relay/v1/handshake',
    headers: { ...REMOTE_HEADERS, authorization: `Bearer ${j.token}`, 'content-type': 'application/json' },
    body: {},
  })
  assert.strictEqual(forward.status, 200)
  const seen = sharedTarget.seen.filter((row) => String(row.path).split('?')[0] === '/_dsh/zen-remote/relay/v1/handshake').pop()
  assert.strictEqual(seen.headers['x-zen-remote-device-name'], encodeURIComponent('a'.repeat(39) + '\u{1F600}'))

  const rename = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'rename', id: j.id, name: 'ab' + '\ud83d' } })
  assert.strictEqual(rename.status, 200)
  const status = JSON.parse((await request(SHARED_PORT, { path: '/lan-gate/status' })).body)
  assert.strictEqual(new Map(status.devices.map((d) => [d.id, d.name])).get(j.id), 'ab\uFFFD')
})

test('T59-fix: a poisoned name in the STATE FILE is scrubbed at boot and every request works', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't59fix-state-'))
  const poisonName = 'x'.repeat(10) + '\ud800'
  const token = 'f'.repeat(64)
  const state = {
    version: 2,
    devices: {
      deadbeef: { id: 'deadbeef', token, name: poisonName, role: 'desktop-client', kind: 'auto', createdAt: 1, lastSeen: 1, ua: '' },
    },
    vapid: null,
    pushSubscriptions: {},
  }
  fs.writeFileSync(path.join(home, 'lan-gate-state.json'), JSON.stringify(state), 'utf8')
  const target = await startRecordingTarget(0)
  const gw = startGatewayAt(home, 0, target.server.address().port)
  const port = await gw.ready
  try {
    const status = JSON.parse((await request(port, { path: '/lan-gate/status' })).body)
    assert.strictEqual(status.devices.length, 1)
    assert.strictEqual(status.devices[0].name, 'x'.repeat(10) + '\uFFFD', 'the lone surrogate became U+FFFD at load')

    const forward = await request(port, {
      method: 'POST',
      path: '/_dsh/zen-remote/relay/v1/handshake',
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: {},
    })
    assert.strictEqual(forward.status, 200)
    const seen = target.seen.filter((row) => String(row.path).split('?')[0] === '/_dsh/zen-remote/relay/v1/handshake').pop()
    assert.strictEqual(seen.headers['x-zen-remote-device-name'], encodeURIComponent('x'.repeat(10) + '\uFFFD'))

    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'lan-gate-state.json'), 'utf8'))
    assert.strictEqual(onDisk.devices.deadbeef.name, 'x'.repeat(10) + '\uFFFD', 'the rewrite landed')
  } finally {
    await stopAll(target.server, gw.child)
    fs.rmSync(home, { recursive: true, force: true })
  }
})
