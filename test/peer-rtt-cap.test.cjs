/* dsh-zen-remote · peer-resilience T5 (tasks/peer-resilience/todo.md)
 *
 * src/peer/engine.ts — the direct-path RTT cap policy (2.5.x re-anchored):
 *   - the cap is GATEWAY-OWNED since T4 (peer-network-switch): welcome and
 *     `network-updated` carry `peerDirectMaxRttMs` (0..10000), it persists as
 *     `peerNetwork.peerDirectMaxRttMsFromGateway`, and the effective cap
 *     resolves `capFromGateway ?? options.directMaxRttMs?.() ?? 300` —
 *     options stays a test-injection channel; production wires nothing.
 *   - cap 0 keeps the legacy "ready means direct" behaviour; cap > 0 pins
 *     the member at 'relay' until TWO consecutive keepalive samples
 *     <= cap*0.7 promote it.
 *   - once direct, a demotion needs the CURRENT sample AND the pre-update
 *     EWMA (alpha 0.3) both over the cap — one 2000ms spike over a healthy
 *     baseline must not relay the path — or two consecutive unanswered PINGs
 *     (one over-limit sample equivalent).
 *   - promotion (first chain AND post-demotion alike) needs a streak of 2
 *     consecutive samples at rtt <= cap * 0.7; a single in-streak high
 *     sample or unanswered PING resets the count.
 *   - the cap getter is read live per sample: flipping it to 0 promotes the
 *     member on the next sample.
 *   - onDirectLost wipes measurement/demotion state; a re-established
 *     session walks the 2-sample gate again.
 *   - status peers rows carry directRttMs (rounded EWMA) + directDemoted,
 *     and a demoted member reports path 'relay' with rttMs null.
 *
 * The harness runs the REAL engine (node A) against a scripted WS gateway
 * and a REAL PeerPunchManager (node B) on loopback UDP — lib modules are
 * loaded through the typescript transpile trick used by
 * peer-auth-timeout.test.cjs, so this file tests src/ without a build.
 * Determinism: A and B share ONE manual clock. B's socket wrapper delays
 * only PONG replies (200ms real), so each sample's value is scriptable by
 * advancing the virtual clock inside that window: the engine reads
 * now() - lastPingSentAt. keepAliveMs (3500) exceeds every scripted rtt
 * (<=3000) so the PONG always lands before the next PING overwrites
 * lastPingSentAt, and the 3x lost budget (10500 virtual) comfortably
 * exceeds the ~6500 virtual elapsed per sample cycle.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const dgram = require('node:dgram')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const modules = new Map()
function loadSource(filename) {
  if (modules.has(filename)) return modules.get(filename).exports
  const loaded = new Module(filename, module)
  modules.set(filename, loaded)
  loaded.filename = filename
  loaded.paths = module.paths
  loaded.require = specifier => specifier.startsWith('.')
    ? loadSource(path.resolve(path.dirname(filename), specifier.replace(/\.js$/, '.ts')))
    : module.require(specifier)
  const text = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(require('node:url').pathToFileURL(filename).href))
  loaded._compile(ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, filename)
  return loaded.exports
}
const source = file => loadSource(path.resolve(__dirname, '../src', file))
const { createPeerEngine } = source('peer/engine.ts')
const { PeerPunchManager } = source('peer/punch.ts')
const { generatePeerIdentity } = source('peer/crypto.ts')
const { ensurePeerIdentity, writePeerNetwork, readPeerNetwork } = source('state-store.ts')
const { PeerFrameType } = source('peer/wire.ts')
const { createRelayPool } = source('relay-pool.ts')

const NET_ID = '0123456789abcdef'
const KEEPALIVE_MS = 3500
const PONG_DELAY_MS = 200

// -- harness helpers ------------------------------------------------------------

/** Deterministic virtual clock: timers fire only when advance() is called. */
function manualClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let best = null
        for (const [id, t] of timers) {
          if (t.at > target) continue
          if (!best || t.at < best.t.at || (t.at === best.t.at && id < best.id)) best = { id, t }
        }
        if (!best) break
        now = Math.max(now, best.t.at)
        timers.delete(best.id)
        best.t.fn()
      }
      now = target
    },
    pendingCount: () => timers.size,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function defer() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} within ${ms}ms`)), ms)
  })
  try { return await Promise.race([promise, timeout]) } finally { clearTimeout(timer) }
}

async function waitFor(predicate, label, ms = 3000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  assert.ok(predicate(), `${label} within ${ms}ms`)
}

async function openUdp() {
  const socket = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    socket.once('error', onError)
    socket.bind({ port: 0, address: '127.0.0.1' }, () => {
      socket.removeListener('error', onError)
      resolve()
    })
  })
  return socket
}

function waitClose(socket) {
  return new Promise((resolve) => socket.once('close', resolve))
}

function endpointOf(socket) {
  const a = socket.address()
  return `${a.address}:${a.port}`
}

/**
 * B's outbound gate. Delays only PONG frames (28B wire header, frame type
 * at byte 3; handshake envelopes are JSON and pass through untouched) and
 * can drop everything for the lost-link phase. The delay gives the test a
 * real-time window to advance the virtual clock between the PING send and
 * the PONG processing — the script's number IS the measured sample.
 */
function makeGate(realSocket) {
  const pending = new Set()
  const gate = {
    pongDelayMs: PONG_DELAY_MS,
    dropAll: false,
    // Only eat PONG replies: A's keepalives go unanswered while B's own PINGs
    // still reach A — lastSeen keeps refreshing, so the loss deadline does not
    // race the missed-PING counter the way dropAll would.
    dropPongs: false,
    // dgram.send is overloaded: punch.ts always uses the 3-arg
    // (buf, port, host) form — normalize it into (buf, 0, len, port, host).
    send(buf, offset, length, port, host, cb) {
      if (typeof length === 'string') {
        cb = port
        host = length
        port = offset
        offset = 0
        length = buf.length
      }
      const isPong = length >= 4 && buf[offset + 3] === PeerFrameType.PONG
      if (gate.dropAll || (isPong && gate.dropPongs)) {
        if (typeof cb === 'function') cb()
        return
      }
      if (isPong && gate.pongDelayMs > 0) {
        const packet = Buffer.from(buf.slice(offset, offset + length))
        const dstPort = port
        const dstHost = host
        const timer = setTimeout(() => {
          pending.delete(timer)
          if (gate.dropAll) return
          realSocket.send(packet, 0, packet.length, dstPort, dstHost)
        }, gate.pongDelayMs)
        pending.add(timer)
        if (typeof cb === 'function') cb()
        return
      }
      realSocket.send(buf, offset, length, port, host, cb)
    },
    // Deterministic cipher-race killer: completeDirect's immediate PING can
    // arrive before B's ciphers exist (its HELLO-ACK still in flight), so
    // whether B answers it is a packet-ordering race — and an answered one
    // lands as a bogus ~0ms sample mid-test. Eating the FIRST inbound PING
    // makes every scripted sample come off a keepalive tick, always.
    dropFirstPing: true,
    on(event, listener) {
      if (event !== 'message') return realSocket.on(event, listener)
      return realSocket.on('message', (buf, rinfo) => {
        if (gate.dropFirstPing && buf.length >= 4 && buf[3] === PeerFrameType.PING) {
          gate.dropFirstPing = false
          return
        }
        listener(buf, rinfo)
      })
    },
    once: (...args) => realSocket.once(...args),
    removeListener: (...args) => realSocket.removeListener(...args),
    address: () => realSocket.address(),
    unref: () => realSocket.unref(),
    ref: () => realSocket.ref(),
    bind: (...args) => realSocket.bind(...args),
    close() {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
      realSocket.close()
    },
  }
  return gate
}

// -- fake gateway: upgrade → challenge → welcome(peers) ---------------------------

/** Parse one masked client frame; returns {opcode, payload, rest} or null. */
function readClientFrame(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    off = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    off = 10
  }
  const maskLen = masked ? 4 : 0
  if (buf.length < off + maskLen + len) return null
  let payload = buf.subarray(off + maskLen, off + maskLen + len)
  if (masked) {
    const mask = buf.subarray(off, off + 4)
    const out = Buffer.alloc(len)
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
    payload = out
  }
  return { opcode, payload, rest: buf.subarray(off + maskLen + len) }
}

/** One unmasked server→client WS frame. */
function wsFrame(value) {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body])
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(body.length, 2)
  return Buffer.concat([header, body])
}

async function startGateway({ peers, rttCap }) {
  const server = http.createServer()
  const sockets = []
  server.on('upgrade', (req, socket) => {
    sockets.push(socket)
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (parsed === null) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(); return }
        if (parsed.opcode === 9) {
          const head = Buffer.from([0x8a, parsed.payload.length])
          socket.write(Buffer.concat([head, parsed.payload]))
          continue
        }
        if (parsed.opcode !== 1) continue // binary relay frames: no-op
        let msg
        try { msg = JSON.parse(parsed.payload.toString('utf8')) } catch { continue }
        if (msg?.type === 'auth') {
          socket.write(wsFrame({
            type: 'welcome',
            status: 'authorized',
            maxPeers: 8,
            // T4: the field is absent unless the test opts in — an "old
            // gateway" exercises the options/300 fallback chain.
            ...(rttCap !== undefined ? { peerDirectMaxRttMs: rttCap } : {}),
            peers: peers(),
          }))
        }
      }
    })
    const accept = createHash('sha1')
      .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    const response = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    socket.write(Buffer.concat([Buffer.from(response), wsFrame({ type: 'challenge', challengeHex: 'a1b2c3d4e5f60718' })]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    httpPort: port,
    wsUrl: `ws://127.0.0.1:${port}`,
    /** Push a server→client control message to every live ws connection. */
    send: (value) => {
      const frame = wsFrame(value)
      for (const socket of sockets) socket.write(frame)
    },
    dropConnections: () => {
      for (const socket of sockets.splice(0)) socket.destroy()
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * One full topology: fake gateway + node A (real PeerEngine) + node B
 * (bare PeerPunchManager). `capRef` is an object {value} the engine's
 * directMaxRttMs getter reads live, so a test can flip it mid-flight.
 */
/**
 * A's outbound sniffer: a pass-through wrapper that only records the
 * virtual time of the last PING the engine sent, so the test can land
 * each scripted RTT exactly on a keepalive tick boundary (the ticks are
 * periodic at handshake+keepAliveMs·k — naive advance() cycles drift
 * against them and the measured sample absorbs the drift).
 */
function makePingSniffer(realSocket, clock) {
  const sniff = {
    lastPingAt: -1,
    send(buf, offset, length, port, host, cb) {
      if (typeof length === 'string') {
        cb = port
        host = length
        port = offset
        offset = 0
        length = buf.length
      }
      if (length >= 4 && buf[offset + 3] === PeerFrameType.PING) sniff.lastPingAt = clock.now()
      realSocket.send(buf, offset, length, port, host, cb)
    },
    on: (...args) => realSocket.on(...args),
    once: (...args) => realSocket.once(...args),
    removeListener: (...args) => realSocket.removeListener(...args),
    address: () => realSocket.address(),
    unref: () => realSocket.unref(),
    ref: () => realSocket.ref(),
    bind: (...args) => realSocket.bind(...args),
    close: () => realSocket.close(),
  }
  return sniff
}

async function buildPair(t, { cap, rttCap }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-rtt-cap-'))
  const clock = manualClock()
  const logs = []
  const capRef = { value: cap }

  // Node A: the real engine. Its punch socket is created here so B can aim
  // at a known endpoint.
  const stateFileA = path.join(home, 'a-state.json')
  const socketA = await openUdp()
  const sniffA = makePingSniffer(socketA, clock)
  // Inbound PONG counter on the REAL socket: sample() waits on this rather
  // than a fixed sleep, so the gate's real-time delay can't race asserts.
  let pongCount = 0
  socketA.on('message', (buf) => {
    if (buf.length >= 4 && buf[3] === PeerFrameType.PONG) pongCount += 1
  })
  const identityA = ensurePeerIdentity(stateFileA)

  // Node B: a bare punch manager behind the outbound gate.
  const socketB = await openUdp()
  const gateB = makeGate(socketB)
  const identityB = generatePeerIdentity()

  const gateway = await startGateway({
    rttCap,
    peers: () => [{
      nodeId: identityB.nodeId,
      publicKeyHex: identityB.publicKeyHex,
      name: 'peer-B',
      lanEndpoints: [endpointOf(socketB)],
    }],
  })

  const reconnectCalls = []
  const engine = createPeerEngine({
    stateFile: stateFileA,
    identity: identityA,
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (input) => ({ entryId: input.entryId, serverId: input.serverId, serverName: input.serverName, displayName: input.serverName }),
      unmountVirtual: () => true,
      updateVirtualName: () => true,
      reconnect: (id) => { reconnectCalls.push(id); return Promise.resolve(true) },
    },
    relayHandler: () => undefined,
    relaySecret: () => 'test',
    serverName: () => 'node-A',
    udpSocket: sniffA,
    udpProbe: null,
    clock,
    log: (line) => logs.push(line),
    directMaxRttMs: () => capRef.value,
    punch: {
      keepAliveMs: KEEPALIVE_MS,
      keepAliveLostFrames: 3,
      reprobeIntervalMs: 800,
    },
  })

  const mgrB = new PeerPunchManager({
    networkId: NET_ID,
    identity: identityB,
    socket: gateB,
    clock,
    keepAliveMs: KEEPALIVE_MS,
    keepAliveLostFrames: 3,
    reprobeIntervalMs: 800,
  })
  await mgrB.ready()

  writePeerNetwork(stateFileA, {
    gatewayWsUrl: gateway.wsUrl,
    gatewayHttpOrigin: `http://127.0.0.1:${gateway.httpPort}`,
    networkId: NET_ID,
    joinedAt: 1,
  })

  t.after(async () => {
    const closingB = waitClose(socketB)
    const closingA = waitClose(socketA)
    mgrB.close()
    engine.stop()
    await closingB
    await closingA
    await gateway.close()
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()))
    assert.ok(path.basename(home).startsWith('zr-rtt-cap-'))
    fs.rmSync(home, { recursive: true, force: true })
  })

  engine.resumeFromState()
  // B's passive session for A exists before the HELLOs fly.
  mgrB.beginPunch({ peerNodeId: identityA.nodeId, peerPublicKeyHex: identityA.publicKeyHex, lanEndpoints: [] })

  const peerOf = () => engine.status().peers.find((peer) => peer.nodeId === identityB.nodeId)

  // Engine-side observables.
  const waitReady = async () => {
    await waitFor(() => logs.some((line) => line.includes('direct ready')), 'A direct ready log')
  }
  const waitLost = async () => {
    await waitFor(() => peerOf()?.path === 'relay', 'A onDirectLost applied')
  }

  /**
   * Drive one keepalive sample worth `rtt` ms: advance the virtual clock
   * in small steps until the engine's next keepalive PING goes out (the
   * sniffer records its exact virtual send time), let the PING reach B
   * in real time, then land `now` on pingAt + rtt — inside the gate's
   * 200ms real delay window — so the engine measures exactly `rtt`.
   * Also serves as the "first sample": completeDirect's immediate PING
   * races B's cipher derivation (its own HELLO-ACK may still be in
   * flight) and is typically dropped, so the first decryptable PONG
   * comes off the first keepalive tick.
   */
  const sample = async (rtt) => {
    assert.ok(rtt < KEEPALIVE_MS, 'scripted rtt must stay under one keepalive interval')
    // A dropped datagram (loopback UDP is lossless in practice but the PING
    // can still race B's cipher derivation on a re-established session) must
    // not hang the test: retry across ticks until a PONG lands.
    for (let attempt = 0; attempt < 4; attempt++) {
      const pongsBefore = pongCount
      const before = sniffA.lastPingAt
      for (let i = 0; i < 200 && sniffA.lastPingAt === before; i++) {
        clock.advance(25)
        // Yield real time: an idle session's reprobe handshake needs real
        // packet round-trips between virtual steps, else the punch window
        // (1000ms) burns away inside a synchronous advance chain.
        await sleep(5)
      }
      assert.ok(sniffA.lastPingAt !== before, `a keepalive ping within 5000 virtual ms — logs: ${JSON.stringify(logs)}`)
      await sleep(60) // let the PING reach B and its reply queue
      const delta = sniffA.lastPingAt + rtt - clock.now()
      if (delta > 0) clock.advance(delta)
      // The measured value is fixed by the virtual clock at processing
      // time, so the PONG's real-time arrival only needs to happen.
      try {
        await waitFor(() => pongCount > pongsBefore, 'the delayed PONG', 1500)
        return
      } catch { /* datagram lost — next tick pings again */ }
    }
    assert.fail('the delayed PONG after 4 keepalive ticks')
  }

  /**
   * Advance the virtual clock in small steps, sleeping between each so real
   * datagrams (keepalive PINGs, replies, handshake rounds) can interleave —
   * advance() fires timers synchronously and packets in flight must land
   * between steps for lastSeen refreshes and deliveries to happen.
   */
  const drain = async (ms, step = 25, pause = 2) => {
    for (let left = ms; left > 0; left -= step) {
      clock.advance(Math.min(step, left))
      await sleep(pause)
    }
  }

  return { engine, mgrB, gateB, gateway, clock, logs, capRef, peerOf, waitReady, waitLost, sample, drain, identityB, identityA, socketB, stateFileA, reconnectCalls }
}

// -- the cap contract -------------------------------------------------------------

test('cap 0 keeps the legacy behaviour: punch ready switches to UDP immediately', async (t) => {
  const env = await buildPair(t, { cap: 0 })
  await env.waitReady()
  const peer = env.peerOf()
  assert.equal(peer.path, 'lan', 'cap 0 promotes at handshake, no sample wait')
  // The first sample still feeds the EWMA column.
  await env.sample(40)
  const after = env.peerOf()
  assert.equal(after.path, 'lan')
  assert.equal(after.directRttMs, 40)
  assert.equal(after.directDemoted, false)
})

test('cap 300: the first-sample chain needs 2 consecutive samples <= cap*0.7', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  const pending = env.peerOf()
  assert.equal(pending.path, 'relay', 'path is pinned to relay while the switch waits for the streak')
  assert.equal(pending.directDemoted, false)
  await env.sample(60)
  assert.equal(env.peerOf().path, 'relay', 'one qualifying sample does not promote')
  assert.equal(env.peerOf().directDemoted, false)
  await env.sample(60)
  const peer = env.peerOf()
  assert.equal(peer.path, 'lan', 'two consecutive samples <= 210 promote')
  assert.equal(peer.directDemoted, false)
  assert.equal(peer.directRttMs, 60)
  assert.equal(typeof peer.rttMs, 'number', 'direct path reports the punch RTT')
})

test('cap 300: a sample under cap but over cap*0.7 does not promote and resets the streak', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  assert.equal(env.peerOf().path, 'relay')
  await env.sample(100) // streak 1
  await env.sample(250) // 250 <= 300 yet > 210 — neither demotion nor promotion material
  const peer = env.peerOf()
  assert.equal(peer.path, 'relay', 'samples between cap*0.7 and cap never promote')
  assert.equal(peer.directDemoted, false, 'a sub-cap sample is not a demotion')
  await env.sample(100) // streak restarts at 1 — still not enough alone
  assert.equal(env.peerOf().path, 'relay', 'the reset streak does not promote early')
  await env.sample(100) // streak 2 → promote
  assert.equal(env.peerOf().path, 'lan')
})

test('cap 300: a high first sample stays relayed and reports directDemoted', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(3000)
  const peer = env.peerOf()
  assert.equal(peer.path, 'relay', '3000 > 300 keeps the member on the gateway path')
  assert.equal(peer.rttMs, null, 'relay path has no direct RTT')
  assert.equal(peer.directDemoted, true)
  assert.equal(peer.directRttMs, 3000)
  assert.ok(
    env.logs.some((line) => /direct .+ rtt 3000ms over cap 300ms/.test(line)),
    'the demotion log line names sample and cap',
  )
})

test('cap 300: a lone 2000ms spike does not demote; sustained highs do', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(50)
  await env.sample(50) // two qualifying samples → promote
  assert.equal(env.peerOf().path, 'lan')

  // EWMA after the spike: 50*0.7 + 2000*0.3 = 635 — over cap, yet the
  // pre-update baseline (50) was under it: no demotion on a single spike.
  await env.sample(2000)
  const spiked = env.peerOf()
  assert.equal(spiked.path, 'lan', 'one spike must not relay the path')
  assert.equal(spiked.directDemoted, false)
  assert.equal(spiked.directRttMs, 635)

  // Sustained highs: EWMA converges past the cap and the next over-cap
  // sample demotes.
  await env.sample(2000) // smoothed 1045
  const demoted = env.peerOf()
  assert.equal(demoted.path, 'relay')
  assert.equal(demoted.directDemoted, true)
  assert.equal(demoted.rttMs, null)
})

test('demoted: recovery needs a 2-sample streak under cap*0.7 and resets on highs', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(3000) // first-chain deny → demoted
  assert.equal(env.peerOf().path, 'relay')

  // One qualifying sample is not enough.
  await env.sample(100)
  assert.equal(env.peerOf().path, 'relay', 'one low sample must not re-promote')
  assert.equal(env.peerOf().directDemoted, true)

  // A high sample inside the streak zeroes the count.
  await env.sample(100)
  await env.sample(900)
  await env.sample(100)
  assert.equal(env.peerOf().path, 'relay', 'the broken streak does not promote')

  // Two in a row → promote.
  await env.sample(100)
  const peer = env.peerOf()
  assert.equal(peer.path, 'lan', '2 consecutive samples <= 210 promote')
  assert.equal(peer.directDemoted, false)
})

test('flipping the cap getter to 0 promotes on the next sample (live read)', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(3000)
  assert.equal(env.peerOf().path, 'relay')

  env.capRef.value = 0
  await env.sample(900) // 900 was over the old cap*0.7 — irrelevant once cap is 0
  const peer = env.peerOf()
  assert.equal(peer.path, 'lan', 'cap 0 promotes on the very next sample')
  assert.equal(peer.directDemoted, false)
  assert.equal(peer.directRttMs > 0, true)
})

// -- T4: the cap is gateway-owned ---------------------------------------------

test('welcome peerDirectMaxRttMs=100 wins over the injected getter, persists, and gates at 100', async (t) => {
  const env = await buildPair(t, { cap: 0, rttCap: 100 })
  await env.waitReady()
  // The gateway's word outranks the options injection (which says 0 = uncapped).
  assert.equal(env.engine.status().directCapMs, 100)
  assert.equal(env.engine.status().directCapSource, 'gateway')
  await waitFor(
    () => readPeerNetwork(env.stateFileA)?.peerDirectMaxRttMsFromGateway === 100,
    'the cap persisted to the peer network record',
  )
  assert.equal(env.peerOf().path, 'relay', 'a real cap pins the path until samples qualify')
  // Two samples <= 70 (cap*0.7) promote.
  await env.sample(50)
  assert.equal(env.peerOf().path, 'relay', 'one qualifying sample does not promote')
  await env.sample(50)
  assert.equal(env.peerOf().path, 'lan', 'two consecutive samples <= 70 promote')
})

test('a welcome without peerDirectMaxRttMs leaves the options getter in charge (old gateway)', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  assert.equal(env.engine.status().directCapMs, 300)
  assert.equal(env.engine.status().directCapSource, 'default')
  assert.equal(env.peerOf().path, 'relay', 'the injected cap still gates')
})

test('a welcome with neither the field nor an injection falls back to 300', async (t) => {
  const env = await buildPair(t, { cap: undefined })
  await env.waitReady()
  assert.equal(env.engine.status().directCapMs, 300)
  assert.equal(env.engine.status().directCapSource, 'default')
  assert.equal(env.peerOf().path, 'relay', 'the default 300 pins until samples qualify')
})

test('network-updated peerDirectMaxRttMs applies live on the next sample', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  // 250ms is in the dead band under cap 300 (> 210, ≤ 300): it neither
  // promotes nor demotes — under the OLD cap it could never qualify.
  await env.sample(250)
  assert.equal(env.peerOf().path, 'relay')
  env.gateway.send({ type: 'network-updated', networkId: NET_ID, maxPeers: 8, peerDirectMaxRttMs: 400 })
  await waitFor(
    () => readPeerNetwork(env.stateFileA)?.peerDirectMaxRttMsFromGateway === 400,
    'the live cap persisted',
  )
  assert.equal(env.engine.status().directCapMs, 400)
  assert.equal(env.engine.status().directCapSource, 'gateway')
  // Under cap 400 the same 250ms qualifies (≤ 280): the update took effect live.
  await env.sample(250)
  assert.equal(env.peerOf().path, 'relay', 'one qualifying sample does not promote')
  await env.sample(250)
  assert.equal(env.peerOf().path, 'lan', 'the second <= 280 sample promotes under the new cap')
})

test('an invalid network-updated peerDirectMaxRttMs is ignored but a valid maxPeers still lands', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  env.gateway.send({ type: 'network-updated', networkId: NET_ID, maxPeers: 12, peerDirectMaxRttMs: -5 })
  await waitFor(() => env.engine.status().maxPeers === 12, 'maxPeers updated independently')
  assert.equal(env.engine.status().directCapMs, 300, 'a malformed RTT value is rejected, not applied')
  assert.equal(env.engine.status().directCapSource, 'default')
  assert.equal(readPeerNetwork(env.stateFileA)?.peerDirectMaxRttMsFromGateway, undefined, 'nothing bogus persisted')
})

test('a resume seeds the cap from the persisted record before any welcome lands', async (t) => {
  const env = await buildPair(t, { cap: 0, rttCap: 100 })
  await env.waitReady()
  await waitFor(
    () => readPeerNetwork(env.stateFileA)?.peerDirectMaxRttMsFromGateway === 100,
    'the cap persisted',
  )
  const engine2 = createPeerEngine({
    stateFile: env.stateFileA,
    identity: env.identityA,
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (input) => ({ entryId: input.entryId, serverId: input.serverId, serverName: input.serverName }),
      unmountVirtual: () => true,
      updateVirtualName: () => true,
    },
    relayHandler: () => undefined,
    relaySecret: () => 'test',
    serverName: () => 'node-A',
    clock: env.clock,
    log: () => {},
    directMaxRttMs: () => env.capRef.value, // 0 = "uncapped" — the disk record must win
    punch: { keepAliveMs: KEEPALIVE_MS, keepAliveLostFrames: 3, reprobeIntervalMs: 800 },
  })
  t.after(() => engine2.stop())
  assert.equal(engine2.status().directCapMs, 0, 'unjoined engine still follows the options getter')
  engine2.resumeFromState()
  // Synchronous seeding: the assert runs before the resumed WS can carry a
  // welcome, so 100 can only come from the peerNetwork record on disk.
  assert.equal(engine2.status().directCapMs, 100, 'resume seeds the cap from the peer network record')
  assert.equal(engine2.status().directCapSource, 'gateway')
})

test('two consecutive unanswered PINGs demote a direct member; loss then re-gates the re-established session', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(50)
  await env.sample(50)
  assert.equal(env.peerOf().path, 'lan')
  assert.equal(env.peerOf().directDemoted, false)

  // Kill only B's PONGs: A's keepalives go unanswered (miss#1 @+14000,
  // miss#2 @+17500 → demote — the first post-promote tick does not count:
  // the matched PONG cleared the pending PING) while B's own PINGs still
  // refresh A's lastSeen, keeping the loss deadline (~28000) clear of the
  // assertion window. pongDelayMs→0: the 200ms delay would otherwise let a
  // queued PONG slip past a mid-drain dropAll flip and poison the streak.
  env.gateB.pongDelayMs = 0
  env.gateB.dropPongs = true
  await env.drain(11000) // stepped advance — real packets land between steps
  const demoted = env.peerOf()
  assert.equal(demoted.path, 'relay', 'two unanswered PINGs demote like an over-cap sample')
  assert.equal(demoted.directDemoted, true)
  assert.ok(
    env.logs.some((line) => /direct .+ keepalive unanswered ×2 — relaying/.test(line)),
    'the demotion log names the unanswered keepalives',
  )

  // Total silence: the 3×keepalive loss deadline still fires behind the
  // demotion and wipes the flag.
  env.gateB.dropPongs = false
  env.gateB.dropAll = true
  await env.drain(14000) // past lastSeen(~10500) + 10500
  assert.ok(env.logs.some((line) => /direct lost .+ — relaying/.test(line)), 'onDirectLost logs its own line')
  await env.waitLost()
  const lost = env.peerOf()
  assert.equal(lost.path, 'relay')
  assert.equal(lost.directDemoted, false, 'loss wipes the demotion flag')

  // Restore the link: the armed reprobe re-punches and the member walks
  // the 2-sample gate again.
  env.gateB.dropAll = false
  env.gateB.pongDelayMs = PONG_DELAY_MS // restore the scripted-sample delay
  env.gateB.dropFirstPing = true // same cipher race on the fresh session
  env.logs.length = 0
  env.clock.advance(5000) // fire the first-tier reprobe → fresh handshake
  await env.waitReady()
  assert.equal(env.peerOf().path, 'relay', 'the lost path stays relayed until the fresh session proves itself')
  await env.sample(150)
  assert.equal(env.peerOf().path, 'relay', 'one qualifying sample does not re-promote')
  await env.sample(150)
  const peer = env.peerOf()
  assert.equal(peer.path, 'lan')
  assert.equal(peer.directRttMs, 150, 'EWMA restarts from the fresh sample')
  assert.equal(peer.directDemoted, false)
})

// -- endpoint re-anchoring (announcePeer endpoint-set diff) --------------------------

test('announcePeer with a changed endpoint set re-anchors: relay first, old endpoint goes silent, new session punches', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(50)
  await env.sample(50)
  assert.equal(env.peerOf().path, 'lan')

  // Count frames still landing on B's OLD socket after the re-announce.
  let oldEpFrames = 0
  env.socketB.on('message', () => { oldEpFrames += 1 })

  // First re-announce a dead endpoint: path drops to relay instantly and
  // the window expiry lands onPunchFallback with the same relay pinning.
  env.logs.length = 0
  env.gateway.send({
    type: 'punch-coordinate',
    peerNodeId: env.identityB.nodeId,
    publicKeyHex: env.identityB.publicKeyHex,
    lanEndpoints: ['127.0.0.1:1'], // dead: a port nobody hears
    reflexiveEndpoint: null,
  })
  await waitFor(() => env.logs.some((line) => line.includes('re-anchored')), 're-anchored log')
  const staged = env.peerOf()
  assert.equal(staged.path, 'relay', 'path falls back to relay the moment endpoints change')
  assert.equal(staged.directDemoted, false)
  assert.equal(staged.directRttMs, null, 'measurement state is wiped with the old session')
  assert.ok(
    env.logs.some((line) => new RegExp(`re-anchored ${env.identityB.nodeId} \\(endpoints changed\\)`).test(line)),
    'the re-anchor log names the peer',
  )
  env.clock.advance(1200) // 1000ms punch window expires on the dead endpoint
  await sleep(30)
  assert.ok(env.logs.some((line) => /punch fallback .+ \(window expired\)/.test(line)), 'the window-expiry fallback fires')
  assert.equal(env.peerOf().path, 'relay', 'onPunchFallback keeps path pinned at relay')

  // B resurfaces on a new socket (new LAN port — the "switched network" peer).
  const socketB2 = await openUdp()
  const gateB2 = makeGate(socketB2)
  const mgrB2 = new PeerPunchManager({
    networkId: NET_ID,
    identity: env.identityB,
    socket: gateB2,
    clock: env.clock,
    keepAliveMs: KEEPALIVE_MS,
    keepAliveLostFrames: 3,
    reprobeIntervalMs: 800,
  })
  await mgrB2.ready()
  t.after(async () => {
    const closing = waitClose(socketB2)
    mgrB2.close()
    await closing
  })
  mgrB2.beginPunch({ peerNodeId: env.identityA.nodeId, peerPublicKeyHex: env.identityA.publicKeyHex, lanEndpoints: [] })

  env.gateway.send({
    type: 'punch-coordinate',
    peerNodeId: env.identityB.nodeId,
    publicKeyHex: env.identityB.publicKeyHex,
    lanEndpoints: [endpointOf(socketB2)],
    reflexiveEndpoint: null,
  })
  await env.waitReady()
  assert.equal(env.peerOf().path, 'relay', 'cap 300 keeps the fresh session relayed until samples prove it')

  const framesAfterReady = oldEpFrames
  env.clock.advance(6000) // a keepalive tick plus slack — all aimed at B2 now
  await sleep(80)
  assert.equal(oldEpFrames, framesAfterReady, 'no frames reach the dead endpoint after re-anchoring')
})

test('announcePeer with an unchanged endpoint set leaves the direct session untouched', async (t) => {
  const env = await buildPair(t, { cap: 0 })
  await env.waitReady()
  assert.equal(env.peerOf().path, 'lan')

  env.logs.length = 0
  env.gateway.send({
    type: 'punch-coordinate',
    peerNodeId: env.identityB.nodeId,
    publicKeyHex: env.identityB.publicKeyHex,
    lanEndpoints: [endpointOf(env.socketB)], // identical to the welcome set
    reflexiveEndpoint: null,
  })
  await sleep(200)
  assert.equal(env.peerOf().path, 'lan', 'the session is not torn down')
  assert.equal(
    env.logs.some((line) => line.includes('re-anchored')),
    false,
    'an identical re-announce must not re-anchor',
  )
})

test('T3: additive STUN punch-coordinate (null -> ip:port) under same connSeq preserves live direct session', async (t) => {
  const env = await buildPair(t, { cap: 0 })
  await env.waitReady()
  assert.equal(env.peerOf().path, 'lan')

  env.logs.length = 0
  env.gateway.send({
    type: 'punch-coordinate',
    peerNodeId: env.identityB.nodeId,
    publicKeyHex: env.identityB.publicKeyHex,
    lanEndpoints: [endpointOf(env.socketB)],
    reflexiveEndpoint: '203.0.113.5:4000',
    connSeq: 1,
  })
  await sleep(150)
  assert.equal(env.peerOf().path, 'lan', 'additive STUN enrichment must not tear down active direct session')
  assert.equal(
    env.logs.some((line) => line.includes('re-anchored')),
    false,
    'additive STUN must not log re-anchored',
  )
})

test('T3: pure UDP rebind preserves active MuxSession while connSeq change or WS reconnect resets MuxSession', async (t) => {
  let currentPeerConnSeq = 10
  const peersData = () => [{
    nodeId: envRef.identityB.nodeId,
    publicKeyHex: envRef.identityB.publicKeyHex,
    name: 'peer-B',
    lanEndpoints: [endpointOf(envRef.socketB)],
    reflexiveEndpoint: null,
    connSeq: currentPeerConnSeq,
  }]
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-t3-seq-'))
  const clock = manualClock()
  const logs = []
  const stateFileA = path.join(home, 'a-state.json')
  const socketA = await openUdp()
  const identityA = ensurePeerIdentity(stateFileA)
  const socketB = await openUdp()
  const identityB = generatePeerIdentity()
  const envRef = { identityB, socketB }

  // Custom gateway that speaks connSeq and records binary frames.
  const sockets = []
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    sockets.push(socket)
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (parsed === null) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(); return }
        if (parsed.opcode === 9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, parsed.payload.length]), parsed.payload]))
          continue
        }
        if (parsed.opcode !== 1) continue
        let msg
        try { msg = JSON.parse(parsed.payload.toString('utf8')) } catch { continue }
        if (msg?.type === 'auth') {
          socket.write(wsFrame({
            type: 'welcome',
            status: 'authorized',
            connSeq: 1,
            maxPeers: 8,
            peers: peersData(),
          }))
        }
      }
    })
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
      wsFrame({ type: 'challenge', challengeHex: 'a1b2c3d4e5f60718' }),
    ]))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const reconnectCalls = []
  let mountedFetch = null
  const engine = createPeerEngine({
    stateFile: stateFileA,
    identity: identityA,
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (input) => {
        mountedFetch = input.fetchImpl
        return { entryId: input.entryId, serverId: input.serverId, serverName: input.serverName, displayName: input.serverName }
      },
      unmountVirtual: () => true,
      updateVirtualName: () => true,
      reconnect: (id) => { reconnectCalls.push(id); return Promise.resolve(true) },
    },
    relayHandler: () => undefined,
    relaySecret: () => 'test',
    serverName: () => 'node-A',
    udpSocket: socketA,
    udpProbe: null,
    clock,
    log: (line) => logs.push(line),
    directMaxRttMs: () => 0,
    punch: { keepAliveMs: KEEPALIVE_MS, keepAliveLostFrames: 3, reprobeIntervalMs: 800 },
  })
  const mgrB = new PeerPunchManager({
    networkId: NET_ID,
    identity: identityB,
    socket: socketB,
    clock,
    keepAliveMs: KEEPALIVE_MS,
    keepAliveLostFrames: 3,
    reprobeIntervalMs: 800,
  })
  await mgrB.ready()
  writePeerNetwork(stateFileA, { gatewayWsUrl: `ws://127.0.0.1:${port}`, gatewayHttpOrigin: `http://127.0.0.1:${port}`, networkId: NET_ID, joinedAt: 1 })
  t.after(async () => {
    mgrB.close()
    engine.stop()
    for (const s of sockets) s.destroy()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  })

  mgrB.beginPunch({ peerNodeId: identityA.nodeId, peerPublicKeyHex: identityA.publicKeyHex, lanEndpoints: [] })
  engine.resumeFromState()
  await waitFor(() => logs.some(l => l.includes('direct ready')), 'initial direct ready')
  assert.ok(reconnectCalls.includes(identityB.nodeId), 'onPathChanged(udp) triggers relayPool.reconnect')
  assert.ok(mountedFetch, 'virtual fetch mounted')

  // Open a pending fetch on the active mux session.
  let hangingSettled = false
  const hangingFetch = mountedFetch('http://peer/hang')
  hangingFetch.then(() => { hangingSettled = true }, () => { hangingSettled = true })
  await sleep(10)

  // (a) Pure UDP endpoint replacement (connSeq unchanged, WS not reconnected) must re-anchor UDP
  // without tearing down or aborting the active MuxSession stream.
  const rebindFrame = wsFrame({
    type: 'punch-coordinate',
    peerNodeId: identityB.nodeId,
    publicKeyHex: identityB.publicKeyHex,
    lanEndpoints: ['127.0.0.1:19999'],
    reflexiveEndpoint: null,
    connSeq: 10,
  })
  for (const s of sockets) if (!s.destroyed) s.write(rebindFrame)
  await waitFor(() => logs.some(l => l.includes('re-anchored') && l.includes('endpoints changed')), 'pure UDP rebind logged')
  await sleep(40)
  assert.equal(hangingSettled, false, 'pure UDP rebind must keep active MuxSession stream alive')
  assert.equal(engine.status().peers.find(p => p.nodeId === identityB.nodeId)?.path, 'relay', 'pure UDP rebind switches path to relay during re-punch')

  // (b1) Peer connSeq change MUST reset MuxSession and abort open streams immediately.
  currentPeerConnSeq = 11
  const frame = wsFrame({
    type: 'punch-coordinate',
    peerNodeId: identityB.nodeId,
    publicKeyHex: identityB.publicKeyHex,
    lanEndpoints: [endpointOf(socketB)],
    reflexiveEndpoint: null,
    connSeq: 11,
  })
  for (const s of sockets) if (!s.destroyed) s.write(frame)

  await assert.rejects(
    Promise.race([
      hangingFetch,
      new Promise((_, reject) => setTimeout(() => reject(new Error('hangingFetch did not reset promptly')), 500)),
    ]),
    /peer session reset/,
    'connSeq change must reset MuxSession and abort open streams',
  )
  assert.equal(engine.status().peers.find(p => p.nodeId === identityB.nodeId)?.path, 'relay', 'path resets to relay on connSeq change')
  assert.ok(logs.some(l => l.includes('re-anchored') && l.includes('connSeq changed')), 're-anchored logged on connSeq change')

  // (b2) Local WS reconnect MUST also reset MuxSession even when peer connSeq stays 11.
  const hangingFetchAfterWs = mountedFetch('http://peer/hang-ws')
  hangingFetchAfterWs.catch(() => {})
  await sleep(10)
  logs.length = 0
  for (const s of sockets) s.destroy()
  await waitFor(() => engine.status().gatewayState === 'offline', 'ws offline before reconnect')
  clock.advance(1100)
  await waitFor(() => engine.status().gatewayState === 'authorized', 'ws reconnected')
  await assert.rejects(
    Promise.race([
      hangingFetchAfterWs,
      new Promise((_, reject) => setTimeout(() => reject(new Error('hangingFetchAfterWs did not reset promptly')), 500)),
    ]),
    /peer session reset/,
    'local WS reconnect must reset MuxSession and abort open streams',
  )
  assert.ok(logs.some(l => l.includes('re-anchored') && l.includes('local network changed')), 're-anchored logged on WS reconnect')
})

test('T3: local WS reconnect welcome re-anchors unchanged direct peer, clears stale reflexiveEndpoint:null, and wakes relayPool', async (t) => {
  const env = await buildPair(t, { cap: 0 })
  await env.waitReady()
  assert.equal(env.peerOf().path, 'lan')
  assert.ok(env.reconnectCalls.includes(env.identityB.nodeId), 'initial direct ready woke relayPool')

  // Seed a stale reflexiveEndpoint first (additive so direct stays up).
  env.gateway.send({
    type: 'punch-coordinate',
    peerNodeId: env.identityB.nodeId,
    publicKeyHex: env.identityB.publicKeyHex,
    lanEndpoints: [endpointOf(env.socketB)],
    reflexiveEndpoint: '203.0.113.99:5555',
  })
  await sleep(50)

  env.logs.length = 0
  env.reconnectCalls.length = 0
  // Hold UDP briefly so we can observe the intermediate path === 'relay' before fast loopback re-punch finishes.
  env.gateB.dropAll = true
  // Simulate local WS drop -> reconnect -> welcome with SAME endpoints and reflexiveEndpoint: null.
  env.gateway.dropConnections()
  await waitFor(() => env.engine.status().gatewayState === 'offline', 'ws offline after drop')
  env.clock.advance(1100) // wsReconnectBaseMs = 1000
  await waitFor(() => env.engine.status().gatewayState === 'authorized', 'ws reconnected')

  assert.ok(env.logs.some(l => l.includes('re-anchored')), 'WS reconnect welcome must re-anchor existing direct peer even with unchanged endpoints')
  assert.equal(env.peerOf().path, 'relay', 'path falls back to relay while re-punching after WS reconnect')
  // Check beginPunch candidates count: 1 LAN endpoint only (stale reflexiveEndpoint cleared by explicit null).
  const bpLog = env.logs.filter(l => l.includes(`beginPunch(${env.identityB.nodeId})`)).at(-1)
  assert.match(bpLog, /candidates=1 /, 'stale reflexiveEndpoint cleared on explicit null')

  // Unblock UDP and confirm re-punch recovers direct path and wakes relayPool.
  env.gateB.dropAll = false
  env.clock.advance(5000)
  await waitFor(() => env.peerOf().path === 'lan', 'direct path recovers after WS reconnect')
  assert.ok(env.reconnectCalls.includes(env.identityB.nodeId), 'post-reconnect path recovery wakes relayPool')
})

test('T3: joinNetwork switching networkId does not inherit disabledNodes or gateway caps from previous network', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-t3-netiso-'))
  const stateFile = path.join(home, 'state.json')
  const identity = ensurePeerIdentity(stateFile)
  const pool = createRelayPool({
    stateFile,
    skipPersistedServers: true,
    computeOwnFingerprints: () => ({}),
    createClient: () => ({ state: 'online', subscribe: () => () => {}, connect: async () => {}, stop() {} }),
  })
  const engine = createPeerEngine({
    stateFile,
    identity,
    relayPool: pool,
    relayHandler: () => undefined,
    relaySecret: () => 'test',
    serverName: () => 'node-iso',
    udpProbe: null,
  })
  t.after(() => {
    engine.stop()
    pool.stop()
    fs.rmSync(home, { recursive: true, force: true })
  })

  writePeerNetwork(stateFile, {
    gatewayWsUrl: 'ws://127.0.0.1:1',
    gatewayHttpOrigin: 'http://127.0.0.1:1',
    networkId: '1111111111111111',
    joinedAt: 1,
    disabledNodes: ['deadbeef'],
    maxPeersFromGateway: 12,
    peerDirectMaxRttMsFromGateway: 80,
  })

  // Join a DIFFERENT networkId: old disabledNodes/maxPeersFromGateway/peerDirectMaxRttMsFromGateway must NOT carry over.
  const otherInvite = `zr-net://127.0.0.1:1/2222222222222222#secret`
  assert.deepEqual(await engine.joinNetwork(otherInvite), { ok: true })
  const afterOther = readPeerNetwork(stateFile)
  assert.equal(afterOther.networkId, '2222222222222222')
  assert.equal(afterOther.disabledNodes, undefined)
  assert.equal(afterOther.maxPeersFromGateway, undefined)
  assert.equal(afterOther.peerDirectMaxRttMsFromGateway, undefined)
  assert.equal(engine.status().directCapMs, 300)
  assert.equal(engine.status().directCapSource, 'default')
})
