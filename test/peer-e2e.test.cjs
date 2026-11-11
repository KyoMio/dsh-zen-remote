/* dsh-zen-remote · PG-8 测试接缝四：PeerMux 虚拟 HTTP 适配 + PeerEngine 接线的端到端。
 *
 * 单测进程内拉起**真实的 gateway-server**（SqliteStore + PeerWsHub + 双 UDP 端口
 * UdpStunService + HTTP REST），和 **3 台模拟 DSH peer 节点**（Node A/B/C）。每台
 * 节点 = 真实的 ShareStore + createRelayHandler（假 typertGateway）+ 真实
 * RelayPool + 真实 PeerEngine（真实 RFC6455 WS 客户端、真实 UDP 打洞 socket、
 * 真实 E2EE）。唯一 fake 的是各节点宿主的 typertGateway（同 relay-e2e 的门扇形）。
 *
 * 覆盖三条验收：
 *   1. 入网与自动双向共享（key 邀请自动准入 / 无口令 pending 后 REST approve、
 *      侧栏合并流的虚拟行 `zr~<nodeIdA>~s-a1`、双向 invoke、NDJSON 流、二进制
 *      upload、防套娃守卫）；
 *   2. 打洞直连 → 1s 降级走网关 WS → 网关零明文断言 → 恢复 UDP 后热切回直连
 *      不断流，/topology 实时反映 relay 与 lan/p2p；
 *   3. 双端独立 TOFU：本机锚点与网关通告公钥分叉 → 本地立即阻断，trustPeer
 *      重锚后才恢复互通。
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dgram = require('node:dgram')

// 主仓（编译产物）
const { createRelayHandler, loadServerId } = require('../lib/relay-server.js')
const { createShareStore } = require('../lib/share-store.js')
const { createRelayPool } = require('../lib/relay-pool.js')
const { ensurePeerIdentity, readPeerNetwork, readStateFile } = require('../lib/state-store.js')
const { createPeerEngine } = require('../lib/peer/engine.js')
const { toVirtual } = require('../lib/virtual-id.js')

// gateway-server（独立包编译产物）
const { createGatewayApiServer } = require('../gateway-server/dist/server.js')
const { SqliteStore } = require('../gateway-server/dist/store/sqlite-store.js')
const { deriveMasterKeyFromSecret, hashPassword } = require('../gateway-server/dist/master-key.js')
const { PeerWsHub } = require('../gateway-server/dist/peer-hub/ws-hub.js')
const { UdpStunService } = require('../gateway-server/dist/peer-hub/udp-stun.js')

const SECRET = 'peer-e2e-relay-secret-0123456789abcdef'.repeat(2).slice(0, 64)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-peer-e2e-'))
const SESSION_TITLE = 'A 的私密会话标题'
const FOLLOW_ARGS = { request: { address: { kind: 'all' } } }

process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, ms = 8000, what = 'condition') {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > ms) throw new Error(`waitFor timeout: ${what}`)
    await sleep(25)
  }
}

// ---------------------------------------------------------------- 网关装配

const ADMIN_EMAIL = 'admin@peer-e2e'
const ADMIN_PASSWORD = 'admin-peer-e2e-pass'
const TENANT_EMAIL = 'tenant@peer-e2e'
const TENANT_PASSWORD = 'tenant-peer-e2e-pass'

async function startGateway() {
  const store = new SqliteStore({
    seed: { allowSignup: false, maxNetworksPerUser: 4, defaultMaxPeers: 8, relayRateKbps: 512 },
  })
  const masterKey = deriveMasterKeyFromSecret('peer-e2e-gateway')
  const hub = new PeerWsHub({ store, masterKey, rateTickMs: null, flushMs: null })
  const server = createGatewayApiServer({ store, masterKey, runtime: hub, hooks: hub.hooks, topology: hub })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  hub.attach(server)
  // 零明文断言的观测点：网关侧每条 ws 连接的 send 都抄送一份（只记二进制帧——
  // 控制面文本帧按协议就是明文 JSON，与断言无关）。
  const relayedBinary = []
  // noServer 模式不触发 'connection' 事件——包装在 handleUpgrade 上：
  // 每条被 hub 接纳的连接的 send 都抄送一份二进制帧（零明文断言的观测点）。
  const origHandleUpgrade = hub.wss.handleUpgrade.bind(hub.wss)
  hub.wss.handleUpgrade = (req, sock, head, cb) => {
    origHandleUpgrade(req, sock, head, (ws) => {
      const origSend = ws.send.bind(ws)
      ws.send = (data, optsOrCb, maybeCb) => {
        const binary = optsOrCb !== null && typeof optsOrCb === 'object' && optsOrCb.binary === true
        if (binary) relayedBinary.push(Buffer.from(data))
        return origSend(data, optsOrCb, maybeCb)
      }
      cb(ws)
    })
  }
  const natRecords = []
  const stun = new UdpStunService({
    primaryPort: 0,
    altPort: 0,
    host: '127.0.0.1',
    lanEndpointsLookup: (networkId, nodeId) => hub.getLanEndpoints(networkId, nodeId),
    onNatDetected: (rec) => { natRecords.push(rec); hub.applyNatObservation(rec) },
  })
  const udp = await stun.bind()
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  await store.ensureBootstrapAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  const tenant = await store.createUser({
    email: TENANT_EMAIL,
    passwordHash: await hashPassword(TENANT_PASSWORD),
    role: 'user',
  })
  const adminCookie = await login(base, ADMIN_EMAIL, ADMIN_PASSWORD)
  const tenantCookie = await login(base, TENANT_EMAIL, TENANT_PASSWORD)

  const close = async () => {
    await hub.close()
    await stun.close()
    await new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
    await store.close()
  }
  return { store, hub, stun, udp, natRecords, relayedBinary, base, port, tenantId: tenant.id, adminCookie, tenantCookie, close }
}

async function api(base, method, reqPath, { body, cookie } = {}) {
  const headers = {}
  if (cookie !== undefined) headers.cookie = cookie
  let payload
  if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['content-type'] = 'application/json'
    headers.origin = base // 写请求过同源门
  }
  const res = await fetch(base + reqPath, { method, headers, body: payload })
  const text = await res.text()
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null, setCookies: res.headers.getSetCookie() }
}

async function login(base, email, password) {
  const res = await api(base, 'POST', '/api/v1/auth/login', { body: { email, password } })
  assert.equal(res.status, 200, `login ${email} failed: ${JSON.stringify(res.json)}`)
  const raw = res.setCookies.find((c) => c.startsWith('zr_gw_session='))
  assert.ok(raw, 'expected session cookie')
  return raw.split(';')[0]
}

async function createNetwork(gw, { mode = 'key' } = {}) {
  const res = await api(gw.base, 'POST', '/api/v1/networks', {
    body: { name: `net-${Math.random().toString(36).slice(2, 8)}`, admissionMode: mode },
    cookie: gw.tenantCookie,
  })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return res.json.data // { id, joinKey, maxPeers, joinUri? ... }
}

async function getTopology(gw, networkId) {
  const res = await api(gw.base, 'GET', `/api/v1/networks/${networkId}/topology`, { cookie: gw.tenantCookie })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return res.json.data
}

/** `zr-net+insecure://127.0.0.1:<port>/<networkId>#<joinKey>` —— 测试网关的邀请链接。 */
function inviteUri(gw, networkId, joinKey) {
  const fragment = joinKey !== undefined && joinKey !== null && joinKey !== '' ? `#${joinKey}` : ''
  return `zr-net+insecure://127.0.0.1:${gw.port}/${networkId}${fragment}`
}

// ---------------------------------------------------------------- 节点装配

/** 一个绑定好的 udp4 socket。 */
function openUdp() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')
    sock.once('error', reject)
    sock.bind(0, '127.0.0.1', () => {
      sock.removeAllListeners('error')
      resolve(sock)
    })
  })
}

/**
 * C 节点的「UDP 防火墙」socket：真实绑定（地址是真的），但 blocked 期间
 * 出站全部吞掉、入站全部不上送——模拟该节点在 UDP 层被整体丢弃。
 * 恢复后真实收发，punch 重探即可打通直连。
 */
function makeFirewallSocket(realSocket) {
  let blocked = true
  const messageListeners = []
  const api = {
    on(ev, fn) {
      if (ev === 'message') messageListeners.push(fn)
      else realSocket.on(ev, fn)
      return api
    },
    once(ev, fn) { return api.on(ev, fn) },
    off(ev, fn) {
      const i = messageListeners.indexOf(fn)
      if (i >= 0) messageListeners.splice(i, 1)
      else realSocket.off(ev, fn)
      return api
    },
    removeListener(ev, fn) { return api.off(ev, fn) },
    address() { return realSocket.address() },
    send(bytes, port, host, cb) {
      if (blocked) {
        if (typeof cb === 'function') cb()
        return
      }
      realSocket.send(bytes, port, host, cb)
    },
    bind(opts, cb) { realSocket.bind(opts, cb) },
    close(cb) { realSocket.close(cb) },
    setBlocked(v) { blocked = v },
    get blocked() { return blocked },
  }
  realSocket.on('message', (buf, rinfo) => {
    if (blocked) return
    for (const fn of [...messageListeners]) fn(buf, rinfo)
  })
  return api
}

/**
 * 一台模拟 DSH peer 节点：真实 ShareStore + createRelayHandler（假网关门）+
 * 真实 RelayPool + 真实 PeerEngine。宿主 typertGateway 的门扇形与 relay-e2e
 * 相同：`workspace/follow` 是可控的帧队列，`session/list` 等走可编程 invoke。
 */
async function startNode(gw, { name, firewall = false, shared = [], heartbeatMs = 300 } = {}) {
  const home = path.join(ROOT, `node-${name}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(home, { recursive: true })
  const stateFile = path.join(home, 'zen-remote-state.json')
  const identity = ensurePeerIdentity(stateFile)
  const punchReal = await openUdp()
  const punchSocket = firewall ? makeFirewallSocket(punchReal) : punchReal

  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  for (const id of shared) store.share(id)
  const invokeCalls = []
  const followGates = []
  const listResults = new Map()
  let invokeImpl = null

  function makeGate(signal) {
    const pending = []
    let settled = 'open' // 'open' | 'done' | { error }
    let wake = () => {}
    signal?.addEventListener('abort', () => {
      if (settled === 'open') {
        settled = { error: Object.assign(new Error('aborted'), { code: 'gateway/cancelled' }) }
        wake()
      }
    })
    const iterable = (async function* () {
      for (;;) {
        if (pending.length > 0) {
          const next = pending.shift()
          if (next.kind === 'frame') yield next.frame
          else return
        } else if (settled !== 'open') {
          if (settled === 'done') return
          throw settled.error
        } else {
          await new Promise((resolve) => { wake = resolve })
        }
      }
    })()
    return {
      iterable,
      push: (frame) => { pending.push({ kind: 'frame', frame }); wake() },
      finish: () => { pending.push({ kind: 'return' }); wake() },
    }
  }

  const gateway = {
    invoke: async (call) => {
      invokeCalls.push(call)
      if (invokeImpl !== null) return invokeImpl(call)
      if (call.namespace === 'session' && call.method === 'list') {
        return listResults.get(call.args?.request?.sessionId ?? '*') ?? { items: [] }
      }
      if (call.namespace === 'session' && call.method === 'modelCatalog') {
        return { default: null, routableProviders: [], groups: [], failures: [] }
      }
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
    stream: async (call) => {
      if (call.namespace === 'workspace' && call.method === 'follow') {
        const gate = makeGate(call.signal)
        followGates.push(gate)
        return gate.iterable
      }
      throw Object.assign(new Error(`no stream fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
    wireStream: {
      open: async (endpoint) => {
        throw Object.assign(new Error(`no wireStream fake for ${endpoint}`), { code: 'test/not-implemented' })
      },
    },
    dispatchRpc: async () => ({ ok: true, value: undefined }),
  }

  const relayHandler = createRelayHandler({
    secret: SECRET,
    store,
    gateway,
    serverInfo: {
      serverId: loadServerId(home),
      serverName: () => name,
      dshVersion: '0.0.0-peer-e2e',
      fingerprints: () => ({}),
      plugins: () => ({}),
    },
    // v1/upload 的宿主转发被替身为一个回显信封——断言的是 mux 通道把二进制
    // 请求体完整送到并带回响应，不是宿主上传路由本身。
    getApiFetch: () => async (request) => {
      const bodyText = await request.text()
      return new Response(JSON.stringify({ ok: true, echoedBytes: bodyText.length, url: request.url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    heartbeatMs,
  })

  const relayPool = createRelayPool({
    stateFile,
    computeOwnFingerprints: () => ({}),
  })

  const logs = []
  const engine = createPeerEngine({
    stateFile,
    identity,
    relayPool,
    relayHandler: () => relayHandler,
    relaySecret: () => SECRET,
    serverName: () => name,
    udpSocket: punchSocket,
    udpProbe: { primaryPort: gw.udp.primaryPort, altPort: gw.udp.altPort ?? 0 },
    punch: { punchWindowMs: 1000, punchIntervalMs: 100, punchRounds: 10, reprobeIntervalMs: 60_000 },
    log: (line) => logs.push(line),
  })

  return {
    name,
    identity,
    home,
    stateFile,
    store,
    relayHandler,
    relayPool,
    engine,
    logs,
    invokeCalls,
    followGates,
    listResults,
    set invokeImpl(fn) { invokeImpl = fn },
    setFirewall: (v) => punchSocket.setBlocked(v),
    stop: () => {
      engine.stop()
      relayPool.stop()
      try { punchSocket.close() } catch { /* gone */ }
    },
  }
}

/** A 节点对外共享一个会话（带可读标题供零明文断言用）。 */
function shareWithTitle(node, sessionId) {
  assert.equal(node.store.share(sessionId), true, `${node.name} shared ${sessionId}`)
  return { sessionId, title: SESSION_TITLE }
}

/** 等本节点把远端 peer 挂载为在线虚拟服务端条目。 */
async function waitPeerOnline(node, peerNodeId, ms = 15000) {
  try {
    await waitFor(() => {
      const entry = node.relayPool.getByServerId(peerNodeId)
      return entry !== undefined && entry.client.state === 'online'
    }, ms, `${node.name} → ${peerNodeId} virtual entry online`)
  } catch (err) {
    // 调试友好：把引擎/mux 日志与两侧 client 状态翻出来再抛。
    const entry = node.relayPool.getByServerId(peerNodeId)
    console.error(`[debug] ${node.name} logs:\n  ${node.logs.join('\n  ')}`)
    console.error(`[debug] ${node.name} entry=${JSON.stringify(entry && { state: entry.client.state, lastError: entry.client.lastError, serverId: entry.serverId })}`)
    throw err
  }
  return node.relayPool.getByServerId(peerNodeId)
}

// ---------------------------------------------------------------- 1. 入网与自动双向共享

test('PG-8 #1: 入网、自动准入、双向共享与 mux 三类通道', async () => {
  const gw = await startGateway()
  // both 模式：带口令的邀请自动准入（A），无口令进 pending 等管理员批准（B）
  const net = await createNetwork(gw, { mode: 'both' })
  const nodes = []
  try {
    const A = await startNode(gw, { name: 'node-a', shared: ['s-a1', 's-a2'] })
    const B = await startNode(gw, { name: 'node-b' })
    nodes.push(A, B)

    // A 凭带口令的邀请链接自动准入
    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await waitFor(() => A.engine.status().gatewayState === 'authorized', 8000, 'A authorized')
    // B 无口令进入 pending，REST approve 后实时准入
    await B.engine.joinNetwork(inviteUri(gw, net.id, undefined))
    await waitFor(() => B.engine.status().gatewayState === 'pending-approval', 8000, 'B pending')
    const approveRes = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${B.identity.nodeId}/approve`, { cookie: gw.tenantCookie })
    assert.equal(approveRes.status, 200, JSON.stringify(approveRes.json))
    await waitFor(() => B.engine.status().gatewayState === 'authorized', 8000, 'B authorized after approve')
    await waitFor(() => A.engine.status().gatewayState === 'authorized', 8000, 'A still authorized')

    // 双方都把对方挂载成在线虚拟服务端（serverId = 对端 nodeId）
    const virtualAonB = await waitPeerOnline(B, A.identity.nodeId)
    const virtualBonA = await waitPeerOnline(A, B.identity.nodeId)
    assert.equal(virtualAonB.entryId, A.identity.nodeId)
    assert.equal(toVirtual(virtualAonB.serverId, 's-a1'), `zr~${A.identity.nodeId}~s-a1`, '虚拟行 id 形态')
    // 内存态驱动：不污染纯 client 模式的 servers 列表
    const persisted = JSON.parse(fs.readFileSync(B.stateFile, 'utf8'))
    assert.equal((persisted.servers ?? []).length, 0, 'peer 模式的虚拟条目绝不写盘')

    // —— invoke 双向 ——（virtualAonB 的调用落在 A 的 fake gateway 上）
    A.listResults.set('*', { items: [{ sessionId: 's-a1', title: SESSION_TITLE }] })
    const listed = await virtualAonB.client.invoke('session', 'list', { request: {} })
    assert.equal(listed.items[0].sessionId, 's-a1')
    const echoed = await virtualBonA.client.invoke('session', 'modelCatalog', {})
    assert.deepEqual(echoed, { default: null, routableProviders: [], groups: [], failures: [] })

    // —— NDJSON 长流（合并流的底座）——
    const frames = []
    const stream = virtualAonB.client.openStream('workspace', 'follow', FOLLOW_ARGS)
    // 收尾兜底：行卸载（node.stop）拆 mux 会话时流会以错误收尾——这是
    // teardown 的正常形态，消费循环吞掉即可（断言只看测试期间收到的帧）。
    let streamClosed = null
    const consuming = (async () => {
      try {
        for await (const frame of stream) frames.push(frame)
      } catch (error) {
        streamClosed = error
      }
    })()
    await waitFor(() => A.followGates.length === 1, 8000, 'A saw the follow stream open')
    // A 侧推送「新增会话」帧——B 的合并流立即看到（原始 id 在断言里以虚拟形态对照）
    A.followGates[0].push({ type: 'upsert', workspace: { id: 'ws-1', name: '主工作区', sessionIds: ['s-a1'] } })
    await waitFor(() => frames.length >= 1, 8000, 'B received the follow frame over the mux')
    assert.equal(frames[0].type, 'upsert')
    assert.deepEqual(frames[0].workspace.sessionIds, ['s-a1'])

    // —— 二进制 upload ——
    const payload = Buffer.from('binary-attachment-' + 'x'.repeat(4096))
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(payload))
        controller.close()
      },
    })
    const uploadResult = await virtualAonB.client.upload({ sessionId: 's-a1', name: 'f.bin', body: bodyStream, bytes: payload.length })
    assert.equal(uploadResult.status, 200)
    const uploadBody = JSON.parse(uploadResult.body)
    assert.equal(uploadBody.ok, true)
    assert.equal(uploadBody.echoedBytes, payload.length, 'upload bytes survived the mux round trip')

    // —— 防套娃守卫 ——
    assert.equal(B.store.share(`zr~${A.identity.nodeId}~s-a1`), false, '二次共享虚拟 id 被拒绝')

    A.followGates[0].finish()
    await consuming
  } catch (err) {
    for (const node of nodes) console.error(`[dbg ${node.name}]`, node.logs.join(' | '))
    throw err
  } finally {
    for (const node of nodes) node.stop()
    await gw.close()
  }
})

// ---------------------------------------------------------------- 2. 打洞直连 → 1s 降级 → 热切不断流

test('PG-8 #2: UDP 降级走网关 WS（零明文），恢复后热切回直连不断流', async () => {
  const gw = await startGateway()
  const net = await createNetwork(gw, { mode: 'key' })
  const nodes = []
  try {
    const A = await startNode(gw, { name: 'node-a', shared: ['s-a1'] })
    const B = await startNode(gw, { name: 'node-b' })
    const C = await startNode(gw, { name: 'node-c', firewall: true, shared: ['s-c1'] })
    nodes.push(A, B, C)

    // 顺序入网：前两台先把 UDP 打洞打完，C 带防火墙最后加入——避免三台
    // 同时 join 的 hello/坐标风暴互相重置打洞轮次（场景关注点不在风暴）。
    for (const node of [A, B, C]) {
      await node.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
      await waitFor(() => node.engine.status().gatewayState === 'authorized', 8000, `${node.name} authorized`)
    }

    // A↔B 正常打洞 → 直连（同机回环 / 局域网）
    await waitFor(() => {
      const peer = A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId)
      return peer !== undefined && (peer.path === 'lan' || peer.path === 'p2p')
    }, 15000, 'A↔B direct path')
    const abRtt = A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId).rttMs
    assert.equal(typeof abRtt, 'number')

    // C 的 UDP 被整体丢弃：约 1s 打洞窗口过期后降级走网关 WS，仍跑通会话
    await waitFor(() => {
      const peer = A.engine.status().peers.find((p) => p.nodeId === C.identity.nodeId)
      return peer !== undefined && peer.path === 'relay'
    }, 15000, 'A→C degraded to relay after the 1000ms punch window')

    // 降级期的拓扑：path-report 是整表快照，C→A 的腿此刻就是 relay
    // （热切回直连后快照会被 lan/p2p 替换，所以 relay 必须趁降级期断言）。
    await waitFor(async () => {
      const snapshot = await getTopology(gw, net.id)
      return snapshot.links.some((l) => l.path === 'relay')
    }, 10000, 'the degraded relay leg was reported to the gateway')

    const virtualConA = await waitPeerOnline(A, C.identity.nodeId)
    const virtualAonC = await waitPeerOnline(C, A.identity.nodeId)
    const pong = await virtualConA.client.invoke('session', 'modelCatalog', {})
    assert.deepEqual(pong.groups, [], 'relay-path invoke works')

    // —— 网关零明文断言：中转的二进制帧里没有会话标题、没有协议明文 ——
    const markers = [SESSION_TITLE, 's-a1', 's-c1', 'workspace/follow', 'relay/v1/', 'handshake', 'api-session/added']
    for (const buf of gw.relayedBinary) {
      const text = buf.toString('utf8')
      for (const marker of markers) {
        assert.ok(!text.includes(marker), `relayed binary frame leaked plaintext marker ${JSON.stringify(marker)}`)
      }
    }
    assert.ok(gw.relayedBinary.length > 10, `expected relayed frames, got ${gw.relayedBinary.length}`)

    // —— C 建一条 NDJSON 订阅流（合并流的形态），喂几帧 ——
    const frames = []
    const stream = virtualAonC.client.openStream('workspace', 'follow', FOLLOW_ARGS)
    let streamError = null
    const consuming = (async () => {
      try {
        for await (const frame of stream) frames.push(frame)
      } catch (error) {
        streamError = error
      }
    })()
    await waitFor(() => A.followGates.length >= 1, 8000, 'A saw C\'s follow stream (relay path)')
    const gate = A.followGates[A.followGates.length - 1]
    gate.push({ type: 'upsert', workspace: { id: 'ws-2', name: '共享工作区', sessionIds: ['s-c1'] } })
    await waitFor(() => frames.length >= 1, 8000, 'first frame over the relay path')
    const framesBeforeSwitch = frames.length

    // —— 恢复 C 的 UDP 通路并触发重探：热切回直连，订阅流不中断 ——
    C.setFirewall(false)
    C.engine.reprobePunch()
    await waitFor(() => {
      const peer = A.engine.status().peers.find((p) => p.nodeId === C.identity.nodeId)
      return peer !== undefined && (peer.path === 'lan' || peer.path === 'p2p')
    }, 20000, 'A→C upgraded back to direct')
    const cPeer = C.engine.status().peers.find((p) => p.nodeId === A.identity.nodeId)
    assert.ok(cPeer.path === 'lan' || cPeer.path === 'p2p', 'C sees the direct path too')

    // 热切之后流还在走：先等新的帧过线（重探+切换窗口内心跳与推送照常）
    gate.push({ type: 'upsert', workspace: { id: 'ws-2', name: '共享工作区', sessionIds: ['s-c1'] } })
    await waitFor(() => frames.length > framesBeforeSwitch, 10000, 'the stream survived the hot switch')
    assert.equal(streamError, null, 'no stream error across the path swap')

    // —— /topology 实时反映路径：path-report 是整表快照，热切完成后
    // C→A 的腿已换成直连（relay 阶段在上面趁降级期断言过了）——
    const topology = await getTopology(gw, net.id)
    const paths = new Set(topology.links.map((l) => l.path))
    assert.ok(paths.has('lan') || paths.has('p2p'), 'the direct leg is live in the gateway topology after the hot switch')

    gate.finish()
    await consuming
    assert.equal(streamError, null)
  } catch (err) {
    for (const node of nodes) console.error(`[dbg ${node.name}]`, node.logs.join(' | '))
    throw err
  } finally {
    for (const node of nodes) node.stop()
    await gw.close()
  }
})

// ---------------------------------------------------------------- 3. 双端独立 TOFU 防中间人

test('PG-8 #3: 本机 TOFU 锚点与网关通告分叉 → 独立阻断，trustPeer 后恢复', async () => {
  const gw = await startGateway()
  const net = await createNetwork(gw, { mode: 'key' })
  const nodes = []
  try {
    const A = await startNode(gw, { name: 'node-a', shared: ['s-a1'] })
    const B = await startNode(gw, { name: 'node-b' })
    nodes.push(A, B)

    // 「碰撞/管理员放行」模拟钩子：在 B 入网**之前**，把 A 本机的 TOFU 锚点
    // 篡改为另一把（同为 64 hex）——模拟 A 曾在更早的纪元锚过一把不同的钥。
    // pinnedPeers 的读时校验只看形状，不重验自证明（锚点即信任根）。
    {
      const state = JSON.parse(fs.readFileSync(A.stateFile, 'utf8'))
      state.pinnedPeers = state.pinnedPeers ?? {}
      state.pinnedPeers[B.identity.nodeId] = {
        publicKeyHex: 'ff'.repeat(32),
        firstSeenAt: Date.now() - 86_400_000,
        updatedAt: Date.now() - 86_400_000,
      }
      fs.writeFileSync(A.stateFile, JSON.stringify(state))
    }

    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await waitFor(() => A.engine.status().gatewayState === 'authorized', 8000, 'A authorized')
    // B 正常入网——网关侧是 authorized，公告带的是 B 的真钥
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await waitFor(() => B.engine.status().gatewayState === 'authorized', 8000, 'B authorized (gateway-side)')

    // A 本机独立检测到 key-mismatch：立即阻断，绝不挂载、绝不握手
    await waitFor(() => {
      const peer = A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId)
      return peer !== undefined && peer.state === 'identity-mismatch'
    }, 8000, 'A marked B identity-mismatch')
    assert.equal(A.relayPool.getByServerId(B.identity.nodeId), undefined, 'no virtual entry for the mismatched peer')

    // 网关转发的二进制帧里没有 A→B 的任何帧（无握手、无数据）
    const aToB = gw.relayedBinary.filter((buf) => buf.length >= 12
      && buf.subarray(4, 8).toString('hex') === A.identity.nodeId
      && buf.subarray(8, 12).toString('hex') === B.identity.nodeId)
    assert.equal(aToB.length, 0, 'A sent nothing toward the mismatched peer')

    // B 单方面打不通 A：B 侧照常挂载 A 的虚拟条目（B 的 TOFU 正常），但 A
    // 丢弃 B 的一切帧 → B 的 client 停在 offline（阻断语义的可观测面）。
    await waitFor(() => {
      const entry = B.relayPool.getByServerId(A.identity.nodeId)
      return entry !== undefined && entry.client.state === 'offline'
    }, 20000, 'B mounted A but stays offline while blocked')
    const virtualAonB = B.relayPool.getByServerId(A.identity.nodeId)
    await assert.rejects(
      () => virtualAonB.client.invoke('session', 'list', { request: {} }, AbortSignal.timeout(2500)),
      /offline|aborted|reset|closed|timeout/,
      'B cannot reach A while A blocks it',
    )

    // trustPeer：本机显式重锚到「当前通告的钥」之后放行、恢复互通
    assert.equal(A.engine.trustPeer(B.identity.nodeId), true)
    const virtualBonA = await waitPeerOnline(A, B.identity.nodeId)
    const virtualAonB2 = await waitPeerOnline(B, A.identity.nodeId)
    const peerRow = A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId)
    assert.equal(peerRow.state, 'eligible')
    const listed = await virtualBonA.client.invoke('session', 'list', { request: {} })
    assert.deepEqual(listed.items, [], 'invoke works again after trustPeer')
    const listedBack = await virtualAonB2.client.invoke('session', 'list', { request: {} })
    assert.deepEqual(listedBack.items, [], 'the reverse direction works too')

    // 本机锚点已换到 B 的真钥（repin 落盘）
    const state = readStateFile(A.stateFile)
    assert.equal(state.pinnedPeers[B.identity.nodeId].publicKeyHex, B.identity.publicKeyHex)
  } catch (err) {
    for (const node of nodes) console.error(`[dbg ${node.name}]`, node.logs.join(' | '))
    throw err
  } finally {
    for (const node of nodes) node.stop()
    await gw.close()
  }
})

// ---------------------------------------------------------------- 5. 准入模式全矩阵与拒绝原因透传

test('PG-8 #5: manual 模式持有效邀请链接进 pending 审批放行互通，key 模式错误口令透传 deniedReason 后换正确链接恢复', async () => {
  const gw = await startGateway()
  const manualNet = await createNetwork(gw, { mode: 'manual' })
  const keyNet = await createNetwork(gw, { mode: 'key' })
  const nodes = []
  try {
    const A = await startNode(gw, { name: 'manual-a', shared: ['s-m1'] })
    const B = await startNode(gw, { name: 'manual-b' })
    const C = await startNode(gw, { name: 'key-c' })
    nodes.push(A, B, C)

    // 1) manual 模式：A 持完整邀请链接（含正确 joinKey）加入 → 必须停在 pending-approval，绝不变成 revoked
    await A.engine.joinNetwork(inviteUri(gw, manualNet.id, manualNet.joinKey))
    await waitFor(() => A.engine.status().gatewayState === 'pending-approval', 8000, 'A pending under manual mode with invite link')
    assert.equal(A.engine.status().deniedReason, null)

    // B 无口令加入同一 manual 网络 → 同样停在 pending-approval
    await B.engine.joinNetwork(inviteUri(gw, manualNet.id, undefined))
    await waitFor(() => B.engine.status().gatewayState === 'pending-approval', 8000, 'B pending under manual mode without key')

    // 管理员依次批准 A、B → 双方实时升级为 authorized 并完成端到端加密互挂
    const appA = await api(gw.base, 'POST', `/api/v1/networks/${manualNet.id}/members/${A.identity.nodeId}/approve`, { cookie: gw.tenantCookie })
    assert.equal(appA.status, 200)
    const appB = await api(gw.base, 'POST', `/api/v1/networks/${manualNet.id}/members/${B.identity.nodeId}/approve`, { cookie: gw.tenantCookie })
    assert.equal(appB.status, 200)
    await waitFor(() => A.engine.status().gatewayState === 'authorized', 8000, 'A authorized after approve')
    await waitFor(() => B.engine.status().gatewayState === 'authorized', 8000, 'B authorized after approve')

    const virtualAonB = await waitPeerOnline(B, A.identity.nodeId)
    A.listResults.set('*', { items: [{ sessionId: 's-m1', title: 'manual-session' }] })
    const listed = await virtualAonB.client.invoke('session', 'list', { request: {} })
    assert.equal(listed.items[0].sessionId, 's-m1')

    // 2) key 模式：C 先用错误邀请密钥加入 → revoked 且 deniedReason === 'join key rejected'
    await C.engine.joinNetwork(inviteUri(gw, keyNet.id, 'wrong-key-value'))
    await waitFor(() => C.engine.status().gatewayState === 'revoked', 8000, 'C denied on wrong joinKey')
    assert.equal(C.engine.status().deniedReason, 'join key rejected')

    // C 换正确邀请链接重连 → 自动准入 authorized，deniedReason 清空
    await C.engine.joinNetwork(inviteUri(gw, keyNet.id, keyNet.joinKey))
    await waitFor(() => C.engine.status().gatewayState === 'authorized', 8000, 'C authorized after valid joinKey')
    assert.equal(C.engine.status().deniedReason, null)
  } finally {
    for (const node of nodes) node.stop()
    await gw.close()
  }
})
