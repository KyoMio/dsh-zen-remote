/* Pairing-token auth model, exercised black-box over the gateway HTTP surface.
 * Remote clients are simulated with X-Forwarded-* headers on a loopback socket
 * (exactly what a same-host reverse proxy produces). */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const http = require('node:http')
const { REMOTE_HEADERS, startMockTarget, startGateway, startGatewayAt, request, cookieFrom, pairDevice, stopAll, freePort } = require('./util.cjs')

let SHARED_PORT = 0
let sharedTarget
let sharedGw

before(async () => {
  sharedTarget = await startMockTarget(0)
  sharedGw = startGateway(0, sharedTarget.address().port)
  SHARED_PORT = await sharedGw.ready
})

after(async () => {
  await stopAll(sharedTarget, sharedGw && sharedGw.child)
})

async function boot(extraEnv) {
  const target = await startMockTarget(0)
  const targetPort = target.address().port
  const gw = startGateway(0, targetPort, extraEnv)
  const port = await gw.ready
  return { port, targetPort, target, gw, stop: () => stopAll(target, gw.child) }
}

test('gate pages follow Accept-Language, and LAN_GATE_LANG pins them', async () => {
  const zh = await request(SHARED_PORT, { path: '/', headers: { ...REMOTE_HEADERS, 'accept-language': 'zh-CN,zh;q=0.9' } })
  assert.ok(zh.body.includes('设备配对') && zh.body.includes('lang="zh-CN"'), 'a Chinese browser gets the Chinese pairing page')

  const en = await request(SHARED_PORT, { path: '/', headers: { ...REMOTE_HEADERS, 'accept-language': 'en-US,en;q=0.9' } })
  assert.ok(en.body.includes('Device Pairing') && en.body.includes('lang="en"'), 'an English browser gets the English one')

  // No header at all keeps the pre-i18n behaviour rather than guessing.
  const bare = await request(SHARED_PORT, { path: '/', headers: REMOTE_HEADERS })
  assert.ok(bare.body.includes('设备配对'), 'no Accept-Language falls back to zh')
})

test('LAN_GATE_LANG=en overrides what the browser asks for', async () => {
  const { port, stop } = await boot({ LAN_GATE_LANG: 'en' })
  try {
    const page = await request(port, { path: '/', headers: { ...REMOTE_HEADERS, 'accept-language': 'zh-CN,zh;q=0.9' } })
    assert.ok(page.body.includes('Device Pairing'), 'a pinned language ignores Accept-Language')
  } finally { await stop() }
})

test('unpaired remote gets 401 pairing page; local-only surface rejects proxied requests', async () => {
  const page = await request(SHARED_PORT, { path: '/', headers: REMOTE_HEADERS })
  assert.strictEqual(page.status, 401)
  assert.ok(page.body.includes('/lan-gate/pair/claim'), 'pairing page shown')
  assert.ok(!page.body.includes('?t='), 'no URL token flow anywhere')

  const api = await request(SHARED_PORT, { path: '/api/session', headers: REMOTE_HEADERS })
  assert.strictEqual(api.status, 401)
  assert.strictEqual(JSON.parse(api.body).reason, 'unpaired')

  for (const p of ['/lan-gate/admin', '/lan-gate/status', '/lan-gate/action', '/lan-gate/pair', '/pwa/push/send']) {
    const isGet = p === '/lan-gate/admin' || p === '/lan-gate/status'
    const r = await request(SHARED_PORT, { method: isGet ? 'GET' : 'POST', path: p, headers: REMOTE_HEADERS, body: isGet ? undefined : {} })
    assert.strictEqual(r.status, 403, p + ' must be local-only')
  }

  const manifest = await request(SHARED_PORT, { path: '/pwa/manifest.json', headers: REMOTE_HEADERS })
  assert.strictEqual(manifest.status, 200)
  const asset = await request(SHARED_PORT, { path: '/pwa/sw.js', headers: REMOTE_HEADERS })
  assert.strictEqual(asset.status, 401)
})

test('pairing flow: code -> cookie -> proxied access; kind & revoke via admin', async () => {
  const { claim, cookie, id } = await pairDevice(SHARED_PORT, '手机A')
  assert.strictEqual(claim.status, 200)
  assert.ok(cookie && cookie.startsWith('lg_device='), 'device cookie issued')
  assert.ok(String(claim.headers['set-cookie'][0]).includes('Secure'), 'Secure flag under https proxy')
  assert.ok(String(claim.headers['set-cookie'][0]).includes('HttpOnly'))

  const page = await request(SHARED_PORT, { path: '/', headers: { ...REMOTE_HEADERS, cookie } })
  assert.strictEqual(page.status, 200)
  assert.ok(page.body.includes('upstream-ok'), 'reached upstream')
  assert.ok(page.body.includes('window.__DSH_PWA__'), 'PWA bootstrap injected')
  assert.ok(!/<html[^>]*data-lan-device/.test(page.body), 'kind auto = no device attr on <html>')
  const asset = await request(SHARED_PORT, { path: '/pwa/manifest.json', headers: { ...REMOTE_HEADERS, cookie } })
  assert.strictEqual(asset.status, 200)

  const status = JSON.parse((await request(SHARED_PORT, { path: '/lan-gate/status' })).body)
  const dev = status.devices.find((d) => d.id === id)
  assert.ok(dev)
  assert.strictEqual(dev.name, '手机A')
  await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-kind', id, kind: 'phone' } })
  const phonePage = await request(SHARED_PORT, { path: '/', headers: { ...REMOTE_HEADERS, cookie } })
  assert.ok(phonePage.body.includes('data-lan-device="phone"'), 'phone kind injected')
  assert.ok(!phonePage.body.includes('href="/lan-gate/admin"'), 'no admin entry chip for anyone (removed in T13)')

  assert.ok(page.body.includes('askPush'), 'auto-kind device still gets the push opt-in entry')
  assert.ok(page.body.includes('PushManager'), 'push support probe present for auto-kind device')

  await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'revoke', id } })
  const after = await request(SHARED_PORT, { path: '/', headers: { ...REMOTE_HEADERS, cookie } })
  assert.strictEqual(after.status, 401)
})

test('websocket upgrade rejected without device cookie', async () => {
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(SHARED_PORT, '127.0.0.1', () => {
      sock.write('GET / HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 203.0.113.9\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
    })
    let buf = ''
    let timer
    const finish = () => { clearTimeout(timer); resolve(buf) }
    sock.on('data', (d) => { buf += d })
    sock.on('close', finish)
    sock.on('error', (err) => { clearTimeout(timer); reject(err) })
    timer = setTimeout(() => { try { sock.destroy() } catch (e) {} finish() }, 2000)
  })
  assert.ok(reply.includes('403'), 'upgrade got 403, saw: ' + reply.slice(0, 60))
})

test('five wrong codes lock the client out', async () => {
  const lockHeaders = { 'x-forwarded-for': '203.0.113.55', 'x-forwarded-proto': 'https' }
  await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair' })
  for (let i = 0; i < 5; i++) {
    const r = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair/claim', headers: lockHeaders, body: { code: 'WRONGAAA' } })
    assert.strictEqual(r.status, 403)
  }
  const gen = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair' })
  const code = JSON.parse(gen.body).code
  const locked = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair/claim', headers: lockHeaders, body: { code } })
  assert.strictEqual(locked.status, 429, 'even the right code is refused while locked')
  assert.strictEqual(JSON.parse(locked.body).reason, 'locked')
})

test('origin and referer are rewritten to the upstream origin', async () => {
  const captured = []
  const target = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => { captured.push(req.headers); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') })
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
  const targetPort = target.address().port
  const gw = startGateway(0, targetPort)
  const port = await gw.ready
  try {
    const { cookie } = await pairDevice(port, '市场机')
    await request(port, { method: 'POST', path: '/api/market/install', headers: { ...REMOTE_HEADERS, cookie, origin: 'https://dsh.example.com', referer: 'https://dsh.example.com/market?page=2' }, body: {} })
    assert.strictEqual(captured.length, 1)
    assert.strictEqual(captured[0].origin, 'http://127.0.0.1:' + targetPort, 'Origin rewritten to upstream origin')
    assert.strictEqual(captured[0].referer, 'http://127.0.0.1:' + targetPort + '/market?page=2', 'Referer rewritten, path preserved')
    assert.strictEqual(captured[0].host, '127.0.0.1:' + targetPort)
  } finally { await stopAll(target, gw.child) }
})

test('rate limit hits unpaired clients only', async () => {
  const { port, stop } = await boot({ LAN_GATE_RATE_LIMIT: '5' })
  try {
    const { cookie } = await pairDevice(port, '快手机')
    for (let i = 0; i < 12; i++) {
      const r = await request(port, { path: '/', headers: { ...REMOTE_HEADERS, cookie } })
      assert.strictEqual(r.status, 200, 'paired device is never rate limited (request ' + i + ')')
    }
    let saw429 = false
    for (let i = 0; i < 8; i++) {
      const r = await request(port, { path: '/', headers: { 'x-forwarded-for': '203.0.113.77' } })
      if (r.status === 429) { saw429 = true; break }
    }
    assert.ok(saw429, 'unpaired stranger hits the limit')
  } finally { await stop() }
})

test('lan-gate.config.json configures the gateway (env absent)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-pwa-test-'))
  fs.writeFileSync(path.join(home, 'lan-gate.config.json'), JSON.stringify({ rateLimit: 5 }))
  const target = await startMockTarget(0)
  const gw = startGatewayAt(home, 0, target.address().port)
  const port = await gw.ready
  try {
    let saw429 = false
    for (let i = 0; i < 8; i++) {
      const r = await request(port, { path: '/', headers: { 'x-forwarded-for': '203.0.113.88' } })
      if (r.status === 429) { saw429 = true; break }
    }
    assert.ok(saw429, 'file-configured rateLimit=5 enforced on unpaired client')
  } finally {
    await stopAll(target, gw.child)
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('v1 state file is archived, not loaded', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-pwa-test-'))
  fs.writeFileSync(path.join(home, 'lan-gate-state.json'), JSON.stringify({ decisions: { '192.168.1.5': { allow: true, token: 'x' } } }))
  const target = await startMockTarget(0)
  const gw = startGatewayAt(home, 0, target.address().port)
  const port = await gw.ready
  try {
    const status = JSON.parse((await request(port, { path: '/lan-gate/status' })).body)
    assert.strictEqual(status.devices.length, 0)
    assert.ok(fs.existsSync(path.join(home, 'lan-gate-state.json.v1.bak')), 'v1 archived')
  } finally {
    await stopAll(target, gw.child)
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('paired devices survive a gateway restart', async () => {
  const target = await startMockTarget(0)
  const targetPort = target.address().port
  const gw1 = startGateway(0, targetPort)
  const port1 = await gw1.ready
  let cookie
  try {
    cookie = (await pairDevice(port1, '重启机')).cookie
  } finally { await stopAll(null, gw1.child, { keepHome: true }) }
  const port2 = await freePort()
  const gw2 = startGatewayAt(gw1.home, port2, targetPort)
  gw2.child._zrHome = gw1.home
  await gw2.ready
  try {
    const page = await request(port2, { path: '/', headers: { ...REMOTE_HEADERS, cookie } })
    assert.strictEqual(page.status, 200)
    assert.ok(page.body.includes('upstream-ok'))
  } finally { await stopAll(target, gw2.child) }
})

for (const trustedProxies of ['', '127.0.0.1']) {
  test(`same-host tunnel: forwarded headers decide, LAN_GATE_TRUSTED_PROXIES="${trustedProxies}" is not what holds the wall`, async () => {
    const target = await startMockTarget(0)
    const gw = startGateway(0, target.address().port, trustedProxies ? { LAN_GATE_TRUSTED_PROXIES: trustedProxies } : undefined)
    const port = await gw.ready
    try {
      const tunnel = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }

      const page = await request(port, { path: '/', headers: tunnel })
      assert.strictEqual(page.status, 401, 'tunnel visitor hits the pairing wall')
      assert.ok(page.body.includes('/lan-gate/pair/claim'))

      const admin = await request(port, { path: '/lan-gate/admin', headers: tunnel })
      assert.strictEqual(admin.status, 403, 'tunnel visitor cannot reach the admin surface')

      const { cookie } = await pairDevice(port, 'tunnel-phone')
      const proxied = await request(port, { path: '/', headers: { ...tunnel, cookie } })
      assert.strictEqual(proxied.status, 200, 'paired tunnel device is proxied through')
      assert.ok(proxied.body.includes('upstream-ok'))

      const bare = await request(port, { path: '/lan-gate/admin' })
      assert.strictEqual(bare.status, 200, 'loopback without forwarded headers is still the local user')
    } finally { await stopAll(target, gw.child) }
  })
}
