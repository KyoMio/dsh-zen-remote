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

// ---- sessionEvents: the turn-summary event log read, both DSH versions ----
// Pure-module cases; they need no gateway. The turnSummary expected text is
// derived by feeding the SAME events array straight in, so this locks the
// two readers (0.1.1 array getter / 0.1.2 snapshotEvents method) to produce
// identical summaries without restating the summary rules here.
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const PUSH_MODULE = pathToFileURL(path.join(__dirname, '..', 'dsh-push.mjs')).href
let importSeq = 0
const loadPushModule = () => import(`${PUSH_MODULE}?push-test=${++importSeq}`)

test('sessionEvents: 0.1.1 array form feeds turnSummary identically to a bare array', async () => {
  const { sessionEvents, turnSummary } = await loadPushModule()
  const events = [
    { type: 'tool/call', data: { turn: 7, step: 0, name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: '改完收工' }] } } }
  ]
  const direct = turnSummary(events, 7)
  const viaGetter = turnSummary(sessionEvents({ events }), 7)
  assert.strictEqual(viaGetter, direct)
  assert.match(viaGetter, /改完收工/)
})

test('sessionEvents: 0.1.2 method form produces the exact same summary as the array form', async () => {
  const { sessionEvents, turnSummary } = await loadPushModule()
  const events = [
    { type: 'tool/call', data: { turn: 7, step: 0, name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: '改完收工' }] } } }
  ]
  const direct = turnSummary(events, 7)
  const viaMethod = turnSummary(sessionEvents({ snapshotEvents: () => events }), 7)
  assert.strictEqual(viaMethod, direct, 'both DSH readers must yield byte-identical summaries')
})

test('sessionEvents: no reader available ({} or undefined) yields [] → empty summary', async () => {
  const { sessionEvents, turnSummary } = await loadPushModule()
  assert.deepStrictEqual(sessionEvents({}), [])
  assert.deepStrictEqual(sessionEvents(undefined), [])
  assert.strictEqual(turnSummary(sessionEvents({}), 7), '')
  assert.strictEqual(turnSummary(sessionEvents(undefined), 7), '')
})
