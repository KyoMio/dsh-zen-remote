'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { once } = require('node:events')
const { PeerMux } = require('../lib/peer/mux.js')
const { generatePeerIdentity } = require('../lib/peer/crypto.js')
const { createRelayHandler } = require('../lib/relay-server.js')
const { createShareStore } = require('../lib/share-store.js')

function pair(t, handler) {
  const a = generatePeerIdentity(), b = generatePeerIdentity()
  const options = { networkId: '0123456789abcdef', sendGatewayBinary: null, relaySecret: () => 'test-secret' }
  const A = new PeerMux({ ...options, identity: a, relayHandler: () => undefined })
  const B = new PeerMux({ ...options, identity: b, relayHandler: () => handler })
  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  for (const [from, to, identity, target] of [[A, B, a, b], [B, A, b, a]]) {
    from.setDirectPath(target.nodeId, (frameType, streamId, payload, ack) => {
      setImmediate(() => to.handleOpenedFrame({ srcNodeId: identity.nodeId, frameType, streamId, ack }, payload))
    })
  }
  t.after(() => { A.close(); B.close() })
  return A.createFetchForPeer(b.nodeId)
}

for (const method of ['follow', 'control']) {
  test(`peer ${method}: large opening frame does not block later events`, { timeout: 5000 }, async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'zr-backpressure-'))
    t.after(() => rmSync(home, { recursive: true, force: true })) // exact mkdtemp-owned directory
    const store = createShareStore({ file: join(home, 'shares.json'), idleHours: 48 })
    store.share('session-test')
    const padding = 'x'.repeat(200000)
    const frames = method === 'follow' ? [
      { type: 'snapshot', header: { id: 'session-test' }, records: [], padding },
      { type: 'assistant-stream', frame: { revision: 1, text: 'thinking' } },
      { type: 'event', event: { type: 'tool/result', seq: 1 } },
      { type: 'assistant-stream', frame: { revision: 2, text: 'reply' } },
    ] : [
      { type: 'baseline', value: { projections: { 'session-test': { asOfSeq: 0, values: { padding } } } } },
      { type: 'projection', sessionId: 'session-test', changes: [{ key: 'modelSelection', value: { model: 'changed' } }], seq: 1 },
    ]
    let released = false
    const handler = createRelayHandler({
      secret: 'test-secret', store, heartbeatMs: 10000,
      serverInfo: { serverId: '12345678', serverName: () => 'test', dshVersion: 'test', fingerprints: () => ({}) },
      gateway: { stream: async ({ signal }) => (async function* () {
        try {
          for (const frame of frames) yield frame
          await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }))
        } finally { released = true }
      })() },
    })
    t.after(() => handler.closeAll())
    const fetch = pair(t, handler)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    t.after(() => { clearTimeout(timer); controller.abort() })
    const res = await fetch('http://peer/_dsh/zen-remote/relay/v1/stream', {
      method: 'POST', signal: controller.signal,
      body: JSON.stringify({ namespace: 'session', method, args: method === 'follow' ? { request: { address: { kind: 'session', sessionId: 'session-test' } } } : {} }),
    })
    assert.equal(res.status, 200)
    const reader = res.body.getReader()
    const received = []
    let buffer = ''
    try {
      while (received.length < frames.length) {
        const { value, done } = await reader.read()
        assert.equal(done, false)
        buffer += Buffer.from(value).toString()
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1)
          if (line.type === 'frame') received.push(line.frame)
        }
      }
      assert.deepEqual(received, frames)
    } finally { controller.abort() }
    await new Promise(resolve => setImmediate(() => setImmediate(resolve)))
    assert.equal(released, true, 'cancellation releases the upstream subscription')
  })
}

async function responseWithin(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('peer response did not settle')), 500)
    })])
  } finally { clearTimeout(timer) }
}

for (const status of [204, 205, 304]) {
  test(`peer response: ${status} resolves with a null body`, { timeout: 3000 }, async (t) => {
    const fetch = pair(t, async (_req, res) => { res.writeHead(status); res.end() })
    const response = await responseWithin(fetch('http://peer/no-content', { signal: AbortSignal.timeout(1000) }))
    assert.equal(response.status, status)
    assert.equal(response.body, null)
    assert.equal(await response.text(), '')
  })
}

test('peer response: invalid response metadata rejects instead of stranding fetch', { timeout: 3000 }, async (t) => {
  const fetch = pair(t, async (_req, res) => {
    res.socket.write('HTTP/1.1 200 OK\r\nbad\u0001name: value\r\n\r\n')
  })
  await assert.rejects(responseWithin(fetch('http://peer/invalid-header', { signal: AbortSignal.timeout(1000) })), /header/i)
})

test('peer response: repeated large writes drain and complete a content-length body', { timeout: 5000 }, async (t) => {
  const chunk = Buffer.alloc(200000, 'x')
  let response
  let drains = 0
  const fetch = pair(t, async (_req, res) => {
    response = res
    res.on('drain', () => drains++)
    res.setHeader('content-length', chunk.length * 3)
    for (let i = 0; i < 3; i++) {
      if (!res.write(chunk)) await once(res, 'drain')
    }
    res.end()
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  t.after(() => { clearTimeout(timer); controller.abort() })
  const res = await fetch('http://peer/large-response', { signal: controller.signal })
  assert.equal((await res.arrayBuffer()).byteLength, chunk.length * 3)
  assert.equal(drains, 3)
  response.socket.emit('drain')
  assert.equal(drains, 3, 'ended response must not receive drain')
  response.destroy()
  response.socket?.emit('drain')
  assert.equal(drains, 3, 'destroyed response must not receive drain')
})
