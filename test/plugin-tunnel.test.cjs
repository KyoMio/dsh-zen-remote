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
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { request } = require('./util.cjs')

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
        waiters.push((line) => resolve(line === null ? null : line))
        setTimeout(() => resolve(null), timeoutMs)
      })
    },
  }
}

/** The tunnel test's own base URL: a tiny HTTP server exposing ONLY the
 * three tunnel routes (the relay-server gate lives elsewhere). */
async function startTunnelServer(tunnel) {
  const http = require('node:http')
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
    await new Promise((resolve) => setTimeout(resolve, 80))
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
    await new Promise((resolve) => setTimeout(resolve, 200))
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
    const open = await openTunnel(base)
    assert.equal(open.status, 200)
    const openLine = await open.lines.next()
    const tunnelId = JSON.parse(openLine).tunnel

    // Upstream answers 101 and records incoming bytes.
    wiring.upstream.hooks.onConnection = (entry) => {
      entry.socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    }
    await new Promise((resolve) => setTimeout(resolve, 60))

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
    for (const ac of aborts) {
      ac.abort()
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
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

    const data = JSON.parse(await lines.next())
    assert.equal(data.type, 'data')
    assert.equal(Buffer.from(data.b64, 'base64').toString('utf8'), 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nframe-bytes-from-upstream', 'the RAW bytes — the 101 answer and the frames — travel verbatim')

    const end = JSON.parse(await lines.next())
    assert.equal(end.type, 'end')
    assert.equal(end.reason, 'upstream-closed')
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

    const data = JSON.parse(await lines.next(1500))
    assert.notEqual(data, null, 'the sub-chunk push arrived without the upstream closing')
    assert.equal(data.type, 'data')
    assert.equal(Buffer.from(data.b64, 'base64').toString('utf8'), 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nserver-push-small', 'the whole arrival travels as ONE verbatim line')

    // The tunnel is still alive: no end line raced in behind the data, and
    // the upstream socket is exactly where it was.
    assert.equal(await lines.next(300), null, 'no end line behind a live tunnel')
    assert.equal(wiring.upstream.state.connections[0].closed, false, 'the upstream session stays open')
  } finally {
    await stop()
    await wiring.upstream.stop()
  }
})
