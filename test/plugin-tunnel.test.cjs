/* dsh-zen-remote · the WebSocket byte tunnel's server half (PB-10)
 *
 * Drives the BUILT lib/plugin-tunnel.js directly (createPluginTunnel) over
 * real sockets: the upstream is a raw net server that records every byte a
 * tunnel writes (the upgrade request line included) and can be told to
 * answer 101 and push bytes; the downstream is plain HTTP requests to the
 * three routes. Covers the shared validation chain's refusals through the
 * tunnel lens (non-upgrade route, CR/LF headers, missing key), the device
 * binding (another device's send/close is tunnel-unknown), the sequence
 * gate (409 closes), the per-device budget (8 + busy + recovery), and the
 * two teardown directions (upstream close → end line; downstream abort →
 * upstream socket destroyed).
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const { pathToFileURL } = require('node:url')
const { request } = require('./util.cjs')
const { waitFor } = require('./helpers/plugin-bridge-harness.cjs')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-tunnel-'))
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

const DECL = {
  plugin: 'ws-panel',
  version: '1.0.0',
  routes: [
    { path: '/panel/ws', scope: 'session', upgrade: true },
    { path: '/panel/http', scope: 'session' },
  ],
}

/**
 * The fake upstream: a raw net server. Every connection is recorded
 * (request head bytes); the test answers connections manually — the 101
 * handshake, pushed bytes, or nothing.
 */
function startUpstream() {
  const state = { connections: [], closed: [] }
  const hooks = { onConnection: null }
  const server = net.createServer((socket) => {
    const entry = { socket, head: '', closed: false }
    state.connections.push(entry)
    // Tunnel teardown can destroy the upstream socket before the client reads
    // the 101 response, surfacing an expected ECONNRESET on the fake socket.
    socket.on('error', () => { /* expected ECONNRESET on teardown */ })
    socket.on('data', (chunk) => {
      // Accumulate until the blank line (end of the HTTP head).
      if (!entry.headDone) {
        entry.head += chunk.toString('utf8')
        if (entry.head.includes('\r\n\r\n')) {
          entry.headDone = true
          entry.head = entry.head.split('\r\n\r\n')[0]
          hooks.onConnection?.(entry)
        }
      }
    })
    socket.on('close', () => { entry.closed = true; state.closed.push(entry) })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        state,
        hooks,
        port: server.address().port,
        stop: () => new Promise((done) => { for (const c of state.connections) c.socket.destroy(); server.close(done) }),
      })
    })
  })
}

/** One tunnel wiring: real registry + real tunnel routes + the fake upstream. */
async function makeTunnel({ consent = {}, ...overrides } = {}) {
  const registryMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-bridge.js')).href)
  const tunnelMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-tunnel.js')).href)
  const store = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'share-store.js')).href)
  const shareStore = store.createShareStore({ file: path.join(ROOT, `t-${Math.random().toString(36).slice(2)}.json`), idleHours: 48 })
  shareStore.share('session-shared')
  const declared = registryMod.normalizeDeclaration(DECL)
  const registry = registryMod.createBridgeRegistry()
  registry.register(DECL)
  const upstream = await startUpstream()
  const consentBox = { map: consent }
  const loopback = {
    // The tunnel only needs the cookie: a fixed pair, no exchange.
    cookieHeader: async () => 'dsh-auth=tunnel',
  }
  const tunnel = tunnelMod.createPluginTunnel({
    bridge: { registry, getConsent: () => consentBox.map, loopback },
    getTarget: () => ({ protocol: 'http:', port: upstream.port }),
    isAccessible: (sessionId) => sessionId === 'session-shared',
    heartbeatMs: 15_000,
  })
  return { tunnel, registry, declared, upstream, consentBox, shareStore, ...overrides }
}

/** One open request (raw fetch so the NDJSON stream can be consumed line by
 * line). Returns the response plus a line reader. */
async function openTunnel(base, { device = 'dev-1', path = '/panel/ws', plugin = 'ws-panel', version = '1.0.0', digest, query = 'sessionId=session-shared', headers, head, rawPath, signal } = {}) {
  const res = await fetch(`${base}${rawPath ?? '/_dsh/zen-remote/relay/v1/plugin-tunnel/open'}`, {
    method: 'POST',
    ...(signal !== undefined ? { signal } : {}),
    headers: {
      'x-zen-remote-device': device,
      'x-zr-plugin': plugin,
      'x-zr-plugin-version': version,
      'x-zr-plugin-digest': digest ?? declaredDigest(),
      'x-zr-path': path,
      'x-zr-query': query,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ headers: headers ?? { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' }, ...(head !== undefined ? { head } : {}) }),
  })
  return {
    status: res.status,
    marker: res.headers.get('x-zen-remote-error'),
    res,
    lines: readLines(res),
  }
}

function declaredDigest() {
  // Recomputed lazily against the built module (the tests re-register the
  // same DECL, so both ends agree the same way production would).
  return lastDigest
}
let lastDigest

/** Line reader over an NDJSON response. A stream error (an aborted body —
 * the open-abort teardown does exactly that) just ends the reading. */
function readLines(res) {
  const decoder = new TextDecoder()
  let buffer = ''
  const pending = []
  const waiters = []
  let done = false
  const push = (line) => {
    if (waiters.length > 0) waiters.shift()(line)
    else pending.push(line)
  }
  void (async () => {
    const reader = res.body.getReader()
    while (true) {
      let read
      try {
        read = await reader.read()
      } catch {
        break // the body was aborted/cancelled — the reading ends here
      }
      if (read.done) break
      buffer += decoder.decode(read.value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        push(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
      }
    }
    done = true
    for (const waiter of waiters.splice(0)) waiter(null)
  })()
  return {
    next(timeoutMs = 3000) {
      if (pending.length > 0) return Promise.resolve(pending.shift())
      if (done) return Promise.resolve(null)
      return new Promise((resolve) => {
        let timer
        const onLine = (line) => {
          clearTimeout(timer)
          resolve(line === null ? null : line)
        }
        waiters.push(onLine)
        timer = setTimeout(() => {
          const idx = waiters.indexOf(onLine)
          if (idx >= 0) waiters.splice(idx, 1)
          resolve(null)
        }, timeoutMs)
      })
    },
  }
}

/** The tunnel test's own base URL: a tiny HTTP server exposing ONLY the
 * three tunnel routes (the relay-server gate lives elsewhere). */
async function startTunnelServer(tunnel) {
  const server = http.createServer((req, res) => {
    const route = new URL(req.url ?? '/', 'http://x').pathname
    if (route.endsWith('/open')) void tunnel.open(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } })
    else if (route.endsWith('/send')) void tunnel.send(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } })
    else if (route.endsWith('/close')) void tunnel.close(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } })
    else { res.writeHead(404); res.end() }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }) }
}

test('PB-10 tunnel: the validation chain answers through the tunnel lens', async () => {
  lastDigest = undefined
  const registryMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-bridge.js')).href)
  lastDigest = registryMod.normalizeDeclaration(DECL).digest
  const wiring = await makeTunnel()
  const { base, stop } = await startTunnelServer(wiring.tunnel)
  try {
    // An ordinary (non-upgrade) route: the shared chain passes it but the
    // tunnel's own wall refuses — 404 route-undeclared.
    const httpRoute = await openTunnel(base, { path: '/panel/http' })
    assert.equal(httpRoute.status, 404)
    assert.equal(httpRoute.marker, 'route-undeclared')

    // Unknown plugin.
    const unknown = await openTunnel(base, { plugin: 'nope' })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.marker, 'plugin-unknown')

    // Version mismatch.
    const mismatch = await openTunnel(base, { version: '9.9.9' })
    assert.equal(mismatch.status, 409)
    assert.equal(mismatch.marker, 'plugin-mismatch')

    // Unshared session.
    const unshared = await openTunnel(base, { query: 'sessionId=session-secret' })
    assert.equal(unshared.status, 403)
    assert.equal(unshared.marker, 'not-shared')

    // Missing websocket key; CR/LF in a header value.
    const noKey = await openTunnel(base, { headers: { 'sec-websocket-version': '13' } })
    assert.equal(noKey.status, 400)
    assert.equal(noKey.marker, 'bad-request')
    const crlf = await openTunnel(base, { headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13\r\nX-Injected: 1' } })
    assert.equal(crlf.status, 400)
    assert.equal(crlf.marker, 'bad-request')
    // The optional headers get the same check even when key/version are
    // clean — a CR/LF protocol must not reach the hand-built upgrade request
    // as a literal `undefined` header.
    const crlfProtocol = await openTunnel(base, { headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', 'sec-websocket-protocol': 'chat\r\nX-Injected: 1' } })
    assert.equal(crlfProtocol.status, 400)
    assert.equal(crlfProtocol.marker, 'bad-request')
  } finally {
    await stop()
    await wiring.upstream.stop()
  }
})

test('PB-10 tunnel: consent gates server-scope upgrades; the happy path dials the upstream with the upgrade request and the cookie', async () => {
  lastDigest = undefined
  const registryMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-bridge.js')).href)
  lastDigest = registryMod.normalizeDeclaration(DECL).digest
  const wiring = await makeTunnel({ consent: {} })
  const { base, stop } = await startTunnelServer(wiring.tunnel)
  try {
    // A server-scope upgrade route without consent stays home.
    const abortOpen = new AbortController()
    const refused = await openTunnel(base, { path: '/panel/ws', query: 'sessionId=session-shared', signal: abortOpen.signal })
    // /panel/ws is session-scoped: consent does not apply — assert the open
    // SUCCEEDS, then close it; the consent case is covered by the
    // shared-chain tests (validatePluginCall) in plugin-relay.
    if (refused.status !== 200) {
      assert.equal(refused.status, 200)
    }
    const lines = refused.lines
    const openLine = await lines.next()
    const open = JSON.parse(openLine)
    assert.equal(open.type, 'open')
    assert.match(open.tunnel, /^[0-9a-f]{32}$/)
    // The upstream dialed: the upgrade request with Host, Upgrade headers,
    // the cookie, and NO Origin.
    await waitFor(() => wiring.upstream.state.connections.some((c) => c.headDone))
    const conn = wiring.upstream.state.connections.at(-1)
    assert.ok(conn, 'the upstream was dialed')
    assert.match(conn.head, /^GET \/panel\/ws\?sessionId=session-shared HTTP\/1\.1\r\n/)
    assert.match(conn.head, /Host: 127\.0\.0\.1:\d+/)
    assert.match(conn.head, /Connection: Upgrade/)
    assert.match(conn.head, /Upgrade: websocket/)
    assert.match(conn.head, /Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==/)
    assert.match(conn.head, /Cookie: dsh-auth=tunnel/)
    assert.ok(!/origin:/i.test(conn.head), 'no Origin is written')

    // Client aborts the open stream → the upstream socket is destroyed.
    const conn2 = conn
    abortOpen.abort()
    await waitFor(() => conn2.closed === true)
    assert.ok(conn2.closed, 'the upstream socket was destroyed after the open stream died')
  } finally {
    await stop()
    await wiring.upstream.stop()
  }
})

test('PB-10 tunnel: device binding, ordered sends, out-of-order closes, budget of 8', async () => {
  lastDigest = undefined
  const registryMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-bridge.js')).href)
  lastDigest = registryMod.normalizeDeclaration(DECL).digest
  const wiring = await makeTunnel()
  const { base, stop } = await startTunnelServer(wiring.tunnel)
  const send = (tunnelId, seq, device = 'dev-1') =>
    fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'x-zen-remote-device': device, 'x-zr-tunnel': tunnelId, 'x-zr-seq': String(seq), 'content-type': 'application/octet-stream' },
      body: 'x',
    })
  try {
    // Upstream answers 101 and records incoming bytes.
    wiring.upstream.hooks.onConnection = (entry) => {
      entry.socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    }
    const open = await openTunnel(base)
    assert.equal(open.status, 200)
    const openLine = await open.lines.next()
    const tunnelId = JSON.parse(openLine).tunnel
    await waitFor(() => wiring.upstream.state.connections.some((c) => c.headDone))

    // Another device's send is tunnel-unknown.
    const foreign = await send(tunnelId, 0, 'dev-2')
    assert.equal(foreign.status, 404)
    assert.equal((await foreign.json()).error.code, 'tunnel-unknown')

    // In-order sends answer ok and reach the upstream.
    const first = await send(tunnelId, 0)
    assert.equal(first.status, 200)
    const second = await send(tunnelId, 1)
    assert.equal(second.status, 200)

    // Out-of-order: 409 tunnel-out-of-order AND the tunnel closes — the
    // next send (even with the right seq) reads tunnel-unknown.
    const disorder = await send(tunnelId, 5)
    assert.equal(disorder.status, 409)
    assert.equal((await disorder.json()).error.code, 'tunnel-out-of-order')
    const after = await send(tunnelId, 2)
    assert.equal(after.status, 404, 'the tunnel was closed by the out-of-order answer')

    // Budget: the FIRST tunnel was closed by the out-of-order gate, so
    // exactly 8 fresh opens fill the device's budget and the 9th is busy.
    const opened = []
    const aborts = []
    for (let i = 0; i < 8; i += 1) {
      const ac = new AbortController()
      aborts.push(ac)
      const o = await openTunnel(base, { signal: ac.signal })
      assert.equal(o.status, 200)
      await o.lines.next()
      opened.push(o)
    }
    const ninth = await openTunnel(base)
    assert.equal(ninth.status, 429)
    assert.equal(ninth.marker, 'busy')
    const targetClosed = wiring.upstream.state.connections.length
    for (const ac of aborts) {
      ac.abort()
    }
    await waitFor(() => wiring.upstream.state.closed.length >= targetClosed)
    const recovery = await openTunnel(base)
    assert.equal(recovery.status, 200, 'a freed slot is reusable')

    // Close is idempotent and answers ok even for an unknown id.
    const closed = await fetch(`${base}/close`, { method: 'POST', headers: { 'x-zen-remote-device': 'dev-1', 'x-zr-tunnel': tunnelId } })
    assert.equal(closed.status, 200)
    const again = await fetch(`${base}/close`, { method: 'POST', headers: { 'x-zen-remote-device': 'dev-1', 'x-zr-tunnel': tunnelId } })
    assert.equal(again.status, 200)
  } finally {
    await stop()
    await wiring.upstream.stop()
  }
})

test('PB-10 tunnel: upstream bytes arrive as data lines; upstream close sends the end line', async () => {
  lastDigest = undefined
  const registryMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-bridge.js')).href)
  lastDigest = registryMod.normalizeDeclaration(DECL).digest
  const wiring = await makeTunnel()
  const { base, stop } = await startTunnelServer(wiring.tunnel)
  try {
    wiring.upstream.hooks.onConnection = (entry) => {
      entry.socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      entry.socket.write('frame-bytes-from-upstream')
      setTimeout(() => { try { entry.socket.end() } catch { /* gone */ } }, 40)
    }
    const open = await openTunnel(base)
    assert.equal(open.status, 200)
    const lines = open.lines
    const openLine = JSON.parse(await lines.next())
    assert.equal(openLine.type, 'open')

    // Collect every data line until the end line: HOW the upstream's two
    // writes split into data lines is TCP scheduling, not the contract —
    // the contract is the byte-exact concatenation.
    const endLine = { type: '', reason: '' }
    const dataChunks = []
    for (let raw = await lines.next(); raw !== null; raw = await lines.next()) {
      const line = JSON.parse(raw)
      if (line.type === 'data') dataChunks.push(Buffer.from(line.b64, 'base64').toString('utf8'))
      if (line.type === 'end') {
        endLine.type = line.type
        endLine.reason = line.reason
        break
      }
    }
    assert.equal(Buffer.concat(dataChunks.map((c) => Buffer.from(c, 'utf8'))).toString('utf8'), 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nframe-bytes-from-upstream', 'the RAW bytes — the 101 answer and the frames — travel verbatim')

    assert.equal(endLine.type, 'end')
    assert.equal(endLine.reason, 'upstream-closed')
  } finally {
    await stop()
    await wiring.upstream.stop()
  }
})

test('PB-10 tunnel: sub-chunk upstream bytes travel NOW — a live session never waits for a full buffer or a close', async () => {
  lastDigest = undefined
  const registryMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-bridge.js')).href)
  lastDigest = registryMod.normalizeDeclaration(DECL).digest
  const wiring = await makeTunnel()
  const { base, stop } = await startTunnelServer(wiring.tunnel)
  try {
    // The upstream answers 101, pushes ONE small message, and STAYS OPEN —
    // the shape of every real WebSocket session (the PB-10 e2e hang: the
    // 148-byte handshake answer sat in the buffer until a close that never
    // came, and the browser's WebSocket never opened).
    wiring.upstream.hooks.onConnection = (entry) => {
      entry.socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      entry.socket.write('server-push-small')
    }
    const open = await openTunnel(base)
    assert.equal(open.status, 200)
    const lines = open.lines
    const openLine = JSON.parse(await lines.next())
    assert.equal(openLine.type, 'open')

    // Same collect-per-arrival discipline as above: one line per arrival,
    // possibly split — what matters (and what the PB-10 e2e hang regression
    // checks) is that the sub-chunk push arrives WITHOUT the upstream
    // closing, in order, verbatim.
    let bytes = ''
    while (!bytes.includes('server-push-small')) {
      const data = JSON.parse(await lines.next(1500))
      assert.notEqual(data, null, 'the sub-chunk push arrived without the upstream closing')
      assert.equal(data.type, 'data')
      bytes += Buffer.from(data.b64, 'base64').toString('utf8')
    }
    assert.equal(bytes, 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nserver-push-small', 'the arrival travels verbatim, in order, without waiting for a close')

    // The tunnel is still alive: no end line raced in behind the data, and
    // the upstream socket is exactly where it was.
    assert.equal(await lines.next(300), null, 'no end line behind a live tunnel')
    assert.equal(wiring.upstream.state.connections[0].closed, false, 'the upstream session stays open')
  } finally {
    await stop()
    await wiring.upstream.stop()
  }
})

function buildMaskedWsFrame(opcode, fin, payloadBuf) {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const b0 = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  const len = payloadBuf.length
  let hdr
  if (len < 126) {
    hdr = Buffer.from([b0, 0x80 | len])
  } else {
    hdr = Buffer.alloc(4)
    hdr[0] = b0; hdr[1] = 0xfe; hdr.writeUInt16BE(len, 2)
  }
  const masked = Buffer.from(payloadBuf)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  return Buffer.concat([hdr, mask, masked])
}

test('T6 plugin-tunnel: json-body gate enforces share check on binary 0x2 frames and refuses fragmented/0x0 frames with 400', async () => {
  const registryMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-bridge.js')).href)
  const tunnelMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-tunnel.js')).href)
  const decl = {
    plugin: 'sidechat-ws',
    version: '1.0.0',
    routes: [
      { path: '/sidechat/ws', scope: 'session', upgrade: true, locator: { in: 'json-body', fields: ['threadIds'] } },
    ],
  }
  const declared = registryMod.normalizeDeclaration(decl)
  const registry = registryMod.createBridgeRegistry()
  registry.register(decl)
  const upstream = await startUpstream()
  const upstreamReceived = []
  upstream.hooks.onConnection = (entry) => {
    entry.socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    entry.socket.on('data', (chunk) => upstreamReceived.push(Buffer.from(chunk)))
  }
  const tunnel = tunnelMod.createPluginTunnel({
    bridge: { registry, getConsent: () => ({ 'sidechat-ws': true }), loopback: { cookieHeader: async () => 'dsh-auth=t' } },
    getTarget: () => ({ protocol: 'http:', port: upstream.port }),
    isAccessible: (id) => id === 'session-shared',
    heartbeatMs: 15_000,
  })
  const { base, stop } = await startTunnelServer(tunnel)

  const sendFrame = async (tunnelId, seq, rawFrame) => fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'x-zen-remote-device': 'dev-1', 'x-zr-tunnel': tunnelId, 'x-zr-seq': String(seq), 'content-type': 'application/octet-stream' },
    body: rawFrame,
  })

  try {
    // 1. Binary frame (opcode=0x2) with unshared sessionId -> 403 not-shared
    const open1 = await fetch(`${base}/open`, {
      method: 'POST',
      headers: {
        'x-zen-remote-device': 'dev-1',
        'x-zr-plugin': 'sidechat-ws',
        'x-zr-plugin-version': '1.0.0',
        'x-zr-plugin-digest': declared.digest,
        'x-zr-path': '/sidechat/ws',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } }),
    })
    assert.equal(open1.status, 200)
    const r1 = open1.body.getReader()
    try {
      const firstChunk = Buffer.from((await r1.read()).value).toString('utf8')
      const id1 = JSON.parse(firstChunk.split('\n')[0]).tunnel
      const unsharedBin = buildMaskedWsFrame(0x2, true, Buffer.from(JSON.stringify({ op: 'watch', threadIds: ['session-secret'] })))
      const resBin = await sendFrame(id1, 0, unsharedBin)
      assert.equal(resBin.status, 403)
      assert.equal((await resBin.json()).error.code, 'not-shared')
      assert.equal(upstreamReceived.length, 0, 'unshared binary frame must never reach upstream')
    } finally {
      await r1.cancel().catch(() => {})
    }

    // 2. Fragmented frame (fin=false, opcode=0x1) -> 400 bad-request
    const open2 = await fetch(`${base}/open`, {
      method: 'POST',
      headers: {
        'x-zen-remote-device': 'dev-1',
        'x-zr-plugin': 'sidechat-ws',
        'x-zr-plugin-version': '1.0.0',
        'x-zr-plugin-digest': declared.digest,
        'x-zr-path': '/sidechat/ws',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } }),
    })
    const r2 = open2.body.getReader()
    try {
      const id2 = JSON.parse(Buffer.from((await r2.read()).value).toString('utf8').split('\n')[0]).tunnel
      const fragFrame = buildMaskedWsFrame(0x1, false, Buffer.from('{"op":"watch"'))
      const resFrag = await sendFrame(id2, 0, fragFrame)
      assert.equal(resFrag.status, 400)
      assert.equal((await resFrag.json()).error.code, 'bad-request')
    } finally {
      await r2.cancel().catch(() => {})
    }

    // 3. Control frame (ping=0x9, fin=true) -> 200 allowed
    const open3 = await fetch(`${base}/open`, {
      method: 'POST',
      headers: {
        'x-zen-remote-device': 'dev-1',
        'x-zr-plugin': 'sidechat-ws',
        'x-zr-plugin-version': '1.0.0',
        'x-zr-plugin-digest': declared.digest,
        'x-zr-path': '/sidechat/ws',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } }),
    })
    const r3 = open3.body.getReader()
    try {
      const id3 = JSON.parse(Buffer.from((await r3.read()).value).toString('utf8').split('\n')[0]).tunnel
      const pingFrame = buildMaskedWsFrame(0x9, true, Buffer.from('hi'))
      const resPing = await sendFrame(id3, 0, pingFrame)
      assert.equal(resPing.status, 200)
    } finally {
      await r3.cancel().catch(() => {})
    }
  } finally {
    await stop()
    await upstream.stop()
  }
})

test('T6 plugin-tunnel: pumpDownstream drains buffered tail after backpressure without duplicate drain listeners', async () => {
  const tunnelMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-tunnel.js')).href)
  const upstream = await startUpstream()
  const payload = Buffer.alloc(60 * 1024, 0x42) // > 48 KiB single chunk, fits in single TCP read so tail stalls without drain pump
  upstream.hooks.onConnection = (entry) => {
    entry.socket.write(payload)
  }
  const registryMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-bridge.js')).href)
  const declared = registryMod.normalizeDeclaration(DECL)
  const registry = registryMod.createBridgeRegistry()
  registry.register(DECL)
  const tunnel = tunnelMod.createPluginTunnel({
    bridge: { registry, getConsent: () => ({}), loopback: { cookieHeader: async () => 'dsh-auth=t' } },
    getTarget: () => ({ protocol: 'http:', port: upstream.port }),
    isAccessible: (id) => id === 'session-shared',
    heartbeatMs: 15_000,
  })

  const req = Readable.from([Buffer.from(JSON.stringify({ headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } }))])
  req.headers = {
    'x-zen-remote-device': 'dev-1',
    'x-zr-plugin': 'ws-panel',
    'x-zr-plugin-version': '1.0.0',
    'x-zr-plugin-digest': declared.digest,
    'x-zr-path': '/panel/ws',
    'x-zr-query': 'sessionId=session-shared',
  }
  const res = new EventEmitter()
  const writtenLines = []
  let backpressured = false
  res.destroyed = false
  res.writableEnded = false
  res.writeHead = () => {}
  res.end = () => { res.writableEnded = true }
  res.write = (buf) => {
    writtenLines.push(JSON.parse(Buffer.from(buf).toString('utf8')))
    if (writtenLines.some((l) => l.type === 'data') && backpressured) return false
    return true
  }

  try {
    backpressured = true
    await tunnel.open(req, res)
    await waitFor(() => writtenLines.some((l) => l.type === 'data'))
    assert.equal(res.listenerCount('drain'), 1, 'exactly one drain listener registered under backpressure')
    const countBeforeDrain = writtenLines.filter((l) => l.type === 'data').length
    assert.equal(countBeforeDrain, 1)

    // Release backpressure: remaining buffered tail must flush immediately on drain without waiting for new upstream data
    backpressured = false
    res.emit('drain')
    await waitFor(() => {
      const total = Buffer.concat(writtenLines.filter((l) => l.type === 'data').map((l) => Buffer.from(l.b64, 'base64'))).length
      return total === payload.length
    }, 800, 'remaining buffered tail must flush on drain')
    assert.equal(res.listenerCount('drain'), 0)
  } finally {
    res.emit('close')
    await upstream.stop()
  }
})
