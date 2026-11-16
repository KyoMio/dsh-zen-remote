/* dsh-zen-remote · peer-resilience T5 (tasks/peer-resilience/todo.md)
 *
 * src/peer/engine.ts — the direct-path RTT cap policy:
 *   - `peerDirectMaxRttMs` (default 300, env LAN_GATE_PEER_DIRECT_MAX_RTT_MS,
 *     0..10000) gates the post-handshake UDP switch: cap 0 keeps the legacy
 *     "ready means direct" behaviour; cap > 0 holds the member on the relay
 *     path until the first measured keepalive PONG proves rtt <= cap.
 *   - once direct, a demotion needs the CURRENT sample AND the pre-update
 *     EWMA (alpha 0.3) both over the cap — one 2000ms spike over a healthy
 *     baseline must not relay the path.
 *   - demoted members recover only on a streak of 3 consecutive samples at
 *     rtt <= cap * 0.7; a single in-streak high sample resets the count.
 *   - the cap getter is read live per sample: flipping it to 0 promotes the
 *     member on the next sample.
 *   - onDirectLost wipes measurement/demotion state; a re-established
 *     session walks the first-sample gate again.
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
const { ensurePeerIdentity, writePeerNetwork } = source('state-store.ts')
const { PeerFrameType } = source('peer/wire.ts')

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
      if (gate.dropAll) {
        if (typeof cb === 'function') cb()
        return
      }
      const isPong = length >= 4 && buf[offset + 3] === PeerFrameType.PONG
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

async function startGateway({ peers }) {
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
        if (parsed.opcode !== 1) continue // binary relay frames: no-op
        let msg
        try { msg = JSON.parse(parsed.payload.toString('utf8')) } catch { continue }
        if (msg?.type === 'auth') {
          socket.write(wsFrame({
            type: 'welcome',
            status: 'authorized',
            maxPeers: 8,
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

async function buildPair(t, { cap }) {
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
    peers: () => [{
      nodeId: identityB.nodeId,
      publicKeyHex: identityB.publicKeyHex,
      name: 'peer-B',
      lanEndpoints: [endpointOf(socketB)],
    }],
  })

  const engine = createPeerEngine({
    stateFile: stateFileA,
    identity: identityA,
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (input) => ({ entryId: input.entryId, serverId: input.serverId, serverName: input.serverName, displayName: input.serverName }),
      unmountVirtual: () => true,
      updateVirtualName: () => true,
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

  return { engine, mgrB, gateB, gateway, clock, logs, capRef, peerOf, waitReady, waitLost, sample, identityB }
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

test('cap 300: a low first sample promotes lan → direct; status carries the EWMA', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  const pending = env.peerOf()
  assert.equal(pending.path, 'none', 'the UDP switch waits for the first sample')
  assert.equal(pending.directDemoted, false)
  await env.sample(60)
  const peer = env.peerOf()
  assert.equal(peer.path, 'lan', 'first sample 60 <= 300 promotes')
  assert.equal(peer.directDemoted, false)
  assert.equal(peer.directRttMs, 60)
  assert.equal(typeof peer.rttMs, 'number', 'direct path reports the punch RTT')
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
  await env.sample(50) // promote
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

test('demoted: recovery needs a 3-sample streak under cap*0.7 and resets on highs', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(3000) // first-sample deny → demoted
  assert.equal(env.peerOf().path, 'relay')

  // Two qualifying samples are not enough.
  await env.sample(100)
  await env.sample(100)
  assert.equal(env.peerOf().path, 'relay', 'two low samples must not re-promote')
  assert.equal(env.peerOf().directDemoted, true)

  // A high sample inside the streak zeroes the count.
  await env.sample(900)
  assert.equal(env.peerOf().path, 'relay')
  await env.sample(100)
  await env.sample(100)
  assert.equal(env.peerOf().path, 'relay', 'the broken streak does not promote')

  // Three in a row → promote.
  await env.sample(100)
  const peer = env.peerOf()
  assert.equal(peer.path, 'lan', '3 consecutive samples <= 210 promote')
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

test('onDirectLost clears measurement state; the re-established session re-gates', async (t) => {
  const env = await buildPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(50)
  assert.equal(env.peerOf().path, 'lan')

  // Kill the link: A advances past the 3-cycle loss deadline while B's
  // outbound traffic is blocked entirely.
  env.gateB.dropAll = true
  env.clock.advance(11000)
  await sleep(100)
  await env.waitLost()
  const lost = env.peerOf()
  assert.equal(lost.path, 'relay')
  assert.equal(lost.directDemoted, false, 'loss wipes the demotion flag')

  // Restore the link: the armed reprobe re-punches and the member walks
  // the first-sample gate again.
  env.gateB.dropAll = false
  env.gateB.dropFirstPing = true // same cipher race on the fresh session
  env.logs.length = 0
  env.clock.advance(1000) // fire the reprobe → fresh handshake
  await env.waitReady()
  assert.equal(env.peerOf().path, 'relay', 'the lost path stays relayed until the fresh session proves itself')
  await env.sample(150)
  const peer = env.peerOf()
  assert.equal(peer.path, 'lan')
  assert.equal(peer.directRttMs, 150, 'EWMA restarts from the fresh sample')
  assert.equal(peer.directDemoted, false)
})
