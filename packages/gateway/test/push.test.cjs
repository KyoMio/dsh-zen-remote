/* Real Web Push behavior, black-box: a mock push service captures what the
 * gateway sends and we assert VAPID auth + encrypted (non-plaintext) payload. */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const crypto = require('node:crypto')
const { REMOTE_HEADERS, startMockTarget, startGateway, request, pairDevice, stopAll } = require('./util.cjs')

const PORT = 39222
const TARGET_PORT = 39221
const PUSH_PORT = 39223

function fakeSubscription() {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    endpoint: 'http://127.0.0.1:' + PUSH_PORT + '/push/abc',
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
  }
}

function startMockPushService(statusCode) {
  const captured = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      captured.push({ headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(statusCode, {})
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(PUSH_PORT, '127.0.0.1', () => resolve({ server, captured })))
}

async function boot() {
  const target = await startMockTarget(TARGET_PORT)
  const gw = startGateway(PORT, TARGET_PORT, { LAN_GATE_ALLOW_HTTP_PUSH: '1' })
  await gw.ready
  return { target, gw, stop: () => stopAll(target, gw.child) }
}

test('subscribe requires a paired device', async () => {
  const { stop } = await boot()
  try {
    const anon = await request(PORT, { method: 'POST', path: '/pwa/push/subscribe', headers: REMOTE_HEADERS, body: { subscription: fakeSubscription() } })
    assert.strictEqual(anon.status, 401)

    const { cookie } = await pairDevice(PORT)
    const ok = await request(PORT, { method: 'POST', path: '/pwa/push/subscribe', headers: { ...REMOTE_HEADERS, cookie }, body: { subscription: fakeSubscription() } })
    assert.strictEqual(ok.status, 200)

    const bad = await request(PORT, { method: 'POST', path: '/pwa/push/subscribe', headers: { ...REMOTE_HEADERS, cookie }, body: { subscription: { endpoint: 'javascript:alert(1)' } } })
    assert.strictEqual(bad.status, 400)
  } finally { await stop() }
})

test('send delivers VAPID-signed encrypted push; no conversation text pass-through', async () => {
  const { server, captured } = await startMockPushService(201)
  const { stop } = await boot()
  try {
    const { cookie } = await pairDevice(PORT)
    await request(PORT, { method: 'POST', path: '/pwa/push/subscribe', headers: { ...REMOTE_HEADERS, cookie }, body: { subscription: fakeSubscription() } })

    const send = await request(PORT, { method: 'POST', path: '/pwa/push/send', body: { title: 'DSH 任务完成', body: '会话 X' } })
    assert.strictEqual(send.status, 200)
    assert.deepStrictEqual(JSON.parse(send.body), { ok: true, sent: 1, failed: 0 })

    assert.strictEqual(captured.length, 1)
    const req = captured[0]
    assert.match(String(req.headers.authorization || ''), /^vapid /i, 'VAPID Authorization header present')
    assert.strictEqual(req.headers['content-encoding'], 'aes128gcm', 'payload is encrypted')
    assert.ok(req.body.length > 0)
    assert.throws(() => JSON.parse(req.body.toString('utf8')), 'body must not be plaintext JSON')
  } finally { await stop(); await new Promise(r=>server.close(r)) }
})

test('expired subscription (410) is dropped after send', async () => {
  const { server } = await startMockPushService(410)
  const { stop } = await boot()
  try {
    const { cookie } = await pairDevice(PORT)
    await request(PORT, { method: 'POST', path: '/pwa/push/subscribe', headers: { ...REMOTE_HEADERS, cookie }, body: { subscription: fakeSubscription() } })

    const send = await request(PORT, { method: 'POST', path: '/pwa/push/send', body: {} })
    assert.deepStrictEqual(JSON.parse(send.body), { ok: true, sent: 0, failed: 1 })
    const status = JSON.parse((await request(PORT, { path: '/lan-gate/status' })).body)
    assert.strictEqual(status.pushSubscriptions, 0, 'dead subscription removed')
  } finally { await stop(); await new Promise(r=>server.close(r)) }
})
