/* dsh-zen-remote · network-restore fast path and health probe
 * (src/relay-client.ts: probeHealth / networkRestored)
 *
 * The relay client exposes a single `state`, and a client that lands
 * `offline` waits out the reconnect ladder (1s → 2s → 5s → 10s → 30s).
 * When a reliable "the network came back" signal arrives, the page should
 * not have to wait for the next rung — but it must also not turn a flapping
 * interface into a reconnect storm, and a hint must never alone prove the
 * link is up. These tests pin exactly that contract:
 *
 *  - probeHealth() asks the host with one authenticated GET /ping and never
 *    moves `state` (it is a question, not a verdict);
 *  - probeHealth() de-duplicates concurrent calls;
 *  - networkRestored() fires only from `offline`;
 *  - networkRestored() refuses inside its anti-storm gap;
 *  - a successful restore clears nextRetryAt and resets the ladder.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createRelayClient } = require('../lib/relay-client.js')

const HANDSHAKE = '/_dsh/zen-remote/relay/v1/handshake'
const PING = '/_dsh/zen-remote/relay/ping'

const HANDSHAKE_OK = () => [200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: 'fake', dshVersion: '9.9.9-test', fingerprints: { algo: 'sha256' } }]

function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.length) })
  res.end(bytes)
}

/** One fake relay: `ping` counts hits and answers whatever `pingStatus` says. */
function startFakeRelay(options = {}) {
  const state = {
    pingStatus: options.pingStatus ?? 200,
    pingCalls: 0,
    handshakeCalls: 0,
    /** When true, handshake answers 503 so the client lands offline. */
    rejectHandshake: options.rejectHandshake ?? false,
    /** Delay the ping response, so a concurrent-call test can overlap. */
    pingDelayMs: options.pingDelayMs ?? 0,
  }
  const server = http.createServer((req, res) => {
    if (req.url === HANDSHAKE) {
      state.handshakeCalls += 1
      req.resume()
      req.on('end', () => {
        if (state.rejectHandshake) return sendJson(res, 503, { ok: false, error: { code: 'unavailable' } })
        const [status, body] = HANDSHAKE_OK()
        sendJson(res, status, body)
      })
      return
    }
    if (req.url === PING) {
      state.pingCalls += 1
      req.resume()
      const answer = () => sendJson(res, state.pingStatus, state.pingStatus === 200 ? { ok: true } : { ok: false, error: { code: 'relay-unauthorized' } })
      if (state.pingDelayMs > 0) setTimeout(answer, state.pingDelayMs)
      else answer()
      return
    }
    req.resume()
    sendJson(res, 404, { ok: false, error: { code: 'not-found' } })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`
      resolve({ server, url, state })
    })
  })
}

function makeClient(url, options = {}) {
  return createRelayClient({
    getServerUrl: () => url,
    getToken: () => 'test-token',
    infoRefreshMs: 0,
    ...options,
  })
}

test('probeHealth: one authenticated GET /ping, state untouched', async () => {
  const relay = await startFakeRelay()
  const client = makeClient(relay.url)
  await client.connect()
  assert.equal(client.state, 'online')

  const before = client.state
  const ok = await client.probeHealth()
  assert.equal(ok, true, 'a 200 ping resolves true')
  assert.equal(relay.state.pingCalls, 1, 'exactly one ping round')
  assert.equal(client.state, before, 'a probe is a question — it must not move state')
  relay.server.close()
})

test('probeHealth: a refused ping resolves false and leaves state alone', async () => {
  const relay = await startFakeRelay({ pingStatus: 401 })
  const client = makeClient(relay.url)
  await client.connect()
  const before = client.state
  const ok = await client.probeHealth()
  assert.equal(ok, false, 'a 401 ping resolves false')
  assert.equal(client.state, before, 'a refusal is about the call, not the link')
  relay.server.close()
})

test('probeHealth: concurrent calls share ONE round trip', async () => {
  const relay = await startFakeRelay({ pingDelayMs: 40 })
  const client = makeClient(relay.url)
  await client.connect()
  const results = await Promise.all([client.probeHealth(), client.probeHealth(), client.probeHealth()])
  assert.deepEqual(results, [true, true, true], 'all callers get the same answer')
  assert.equal(relay.state.pingCalls, 1, 'the in-flight slot collapses the three calls')
  relay.server.close()
})

test('networkRestored: refused while online', async () => {
  const relay = await startFakeRelay()
  const client = makeClient(relay.url)
  await client.connect()
  assert.equal(client.state, 'online')
  assert.equal(client.networkRestored(), false, 'only an offline client has anything to restore')
  relay.server.close()
})

test('networkRestored: fires from offline and lands online', async () => {
  const relay = await startFakeRelay({ rejectHandshake: true })
  const client = makeClient(relay.url)
  await assert.rejects(() => client.connect())
  assert.equal(client.state, 'offline')
  const armed = client.nextRetryAt
  assert.notEqual(armed, null, 'offline arms the ladder')

  relay.state.rejectHandshake = false
  assert.equal(client.networkRestored(), true, 'the hint starts one attempt')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(client.state, 'online', 'the attempt lands online without waiting out the ladder')
  assert.equal(client.nextRetryAt, null, 'a success retires the armed retry')
  relay.server.close()
})

test('networkRestored: the anti-storm gap refuses an immediate second hint', async () => {
  const relay = await startFakeRelay({ rejectHandshake: true })
  const client = makeClient(relay.url)
  await assert.rejects(() => client.connect())
  assert.equal(client.state, 'offline')

  assert.equal(client.networkRestored(), true, 'the first hint is honoured')
  await new Promise((r) => setTimeout(r, 20))
  // Still offline (the server keeps refusing), and the gap has not elapsed.
  assert.equal(client.state, 'offline')
  assert.equal(client.networkRestored(), false, 'a second hint inside the gap is refused')
  relay.server.close()
})
