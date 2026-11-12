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
const { createHash } = require('node:crypto')

// 主仓（编译产物）
const { createRelayHandler, loadServerId } = require('../lib/relay-server.js')
const { createShareStore } = require('../lib/share-store.js')
const { createRelayPool } = require('../lib/relay-pool.js')
const { ensurePeerIdentity, readPeerNetwork, readStateFile, upsertPairedServer } = require('../lib/state-store.js')
const { createPeerEngine } = require('../lib/peer/engine.js')
const { toVirtual } = require('../lib/virtual-id.js')
const { installIntercept, createLocalOnlyGateway } = require('../lib/intercept.js')
const { createBridgeRegistry } = require('../lib/plugin-bridge.js')
const { createPluginLoopback } = require('../lib/plugin-loopback.js')
const { installPluginRouteIntercept } = require('../lib/plugin-route-intercept.js')
const { normalizeAdapter } = require('../lib/plugin-adapter-core.js')
const { ADAPTERS } = require('../lib/adapters/index.js')

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
async function startNode(gw, { name, firewall = false, shared = [], heartbeatMs = 300, hostFetch } = {}) {
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
    // 请求体完整送到并带回响应，不是宿主上传路由本身。hostFetch 允许单测
    // 换一个增量观测的替身（PC-05：边收边数、到点拉黑 UDP）。
    getApiFetch: hostFetch !== undefined ? hostFetch : () => async (request) => {
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

// ---------------------------------------------------------------- 6. 双端同挂 installIntercept 不触发流风暴，远程历史与实时流式回复正常

/**
 * 仿真真实 DSH 宿主中 TypertGatewayService 的动态方法分派：
 * `invoke` / `stream` / `wireStream.open` 全部经由实例属性 `this.dispatchRpc`
 * 与 `this.openWireStream` 调用——与生产环境 `role === 'peer'` 下 `servesRole`
 * 和 `connectsRole` 共享同一个 `typertGateway` 完全一致。
 */
class PeerHostGateway {
  constructor(handlers) {
    this.handlers = handlers
    this.wireStream = {
      open: (endpoint, payload, uplink, peer, signal) => this.openWireStream(endpoint, payload, uplink, peer, signal, { signal }),
    }
    this.rpcBridge = (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)
    this.wireTap = (endpoint, payload, uplink, peer, signal, control, window) =>
      this.openWireStream(endpoint, payload, uplink, peer, control.signal, control, window)
  }
  async dispatchRpc(endpoint, payload, signal, peer) {
    return this.handlers.dispatchRpc(endpoint, payload, signal, peer)
  }
  async openWireStream(endpoint, payload, uplink, peer, signal, control) {
    return this.handlers.openWireStream(endpoint, payload, uplink, peer, signal, control)
  }
  async invoke(call) {
    const endpoint = `${call.namespace}/${call.method}`
    const res = await this.dispatchRpc(endpoint, { args: call.args }, call.signal, call.peer)
    if (res && res.ok === false) {
      throw Object.assign(new Error(res.error?.message ?? 'rpc failed'), { code: res.error?.code ?? 'rpc-failed' })
    }
    return res && typeof res === 'object' && 'value' in res ? res.value : res
  }
  stream(call) {
    const endpoint = `${call.namespace}/${call.method}`
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        const inner = await self.openWireStream(endpoint, { args: call.args }, undefined, call.peer, call.signal, { signal: call.signal })
        yield* inner
      },
    }
  }
}

async function startFullPeerNode(gw, { name, shared = [], localWorkspaceId = 'ws-local', localSessionId = 's-local' } = {}) {
  const home = path.join(ROOT, `full-${name}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(home, { recursive: true })
  const stateFile = path.join(home, 'zen-remote-state.json')
  const identity = ensurePeerIdentity(stateFile)
  const punchSocket = await openUdp()
  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  for (const id of shared) store.share(id)

  const sessionFollowFeeders = new Map()
  const promptsReceived = []
  const createdWorkspaceIds = []
  let activeLocalStreams = 0
  let peakLocalStreams = 0

  function openHeldStream(initialFrames, signal, onRegister) {
    const queue = [...initialFrames.map((frame) => ({ kind: 'frame', frame }))]
    let closed = false
    let wake = () => {}
    activeLocalStreams += 1
    if (activeLocalStreams > peakLocalStreams) peakLocalStreams = activeLocalStreams
    const release = () => {
      if (!closed) {
        closed = true
        activeLocalStreams -= 1
        wake()
      }
    }
    signal?.addEventListener('abort', release)
    const push = (frame) => {
      if (closed) return
      queue.push({ kind: 'frame', frame })
      wake()
    }
    if (onRegister) onRegister({ push, close: release })
    return (async function* () {
      try {
        for (;;) {
          if (queue.length > 0) {
            yield queue.shift().frame
          } else if (closed) {
            return
          } else {
            await new Promise((resolve) => { wake = resolve })
          }
        }
      } finally {
        release()
      }
    })()
  }

  const rawGateway = new PeerHostGateway({
    async dispatchRpc(endpoint, payload) {
      const args = payload?.args ?? {}
      if (endpoint === 'session/list') {
        return { ok: true, value: { items: [{ sessionId: localSessionId, title: `${name}-title` }] } }
      }
      if (endpoint === 'session/modelCatalog') {
        return { ok: true, value: { default: null, routableProviders: [], groups: [], failures: [] } }
      }
      if (endpoint === 'session/prompt') {
        const req = args?.request ?? args ?? {}
        promptsReceived.push(req)
        const sid = req.sessionId
        const feeder = sessionFollowFeeders.get(sid)
        if (feeder) {
          setImmediate(() => {
            feeder.push({ type: 'assistant-stream', chunk: { kind: 'text', delta: `reply-from-${name}:${req.content ?? ''}` } })
          })
        }
        return { ok: true, value: { accepted: true } }
      }
      if (endpoint === 'session/create') {
        createdWorkspaceIds.push(args?.request?.workspaceId)
        store.share('s-created')
        return { ok: true, value: { sessionId: 's-created' } }
      }
      return { ok: true, value: {} }
    },
    async openWireStream(endpoint, payload, _uplink, _peer, signal) {
      const args = payload?.args ?? {}
      if (endpoint === 'workspace/follow') {
        return openHeldStream([
          {
            type: 'baseline',
            value: {
              items: [{ workspaceId: localWorkspaceId, title: `${name}-ws`, sessionIds: [localSessionId] }],
              orderIds: [localWorkspaceId],
              archivedSessionIds: [],
              pinnedSessionIds: [],
            },
          },
        ], signal)
      }
      if (endpoint === 'session/control') {
        return openHeldStream([
          { type: 'baseline', value: { projections: { [localSessionId]: { title: `${name}-title` } } } },
        ], signal)
      }
      if (endpoint === '$events') {
        return openHeldStream([], signal)
      }
      if (endpoint === 'session/follow') {
        const sid = args?.request?.address?.sessionId
        return openHeldStream(
          [{ type: 'snapshot', header: { id: sid, cwd: '/tmp' }, events: [{ kind: 'user', text: 'history-hello' }] }],
          signal,
          (feeder) => {
            sessionFollowFeeders.set(sid, feeder)
            signal?.addEventListener('abort', () => {
              if (sessionFollowFeeders.get(sid) === feeder) sessionFollowFeeders.delete(sid)
            })
          },
        )
      }
      throw Object.assign(new Error(`unexpected stream ${endpoint}`), { code: 'test/unexpected-stream' })
    },
  })

  let interceptHandle
  let currentServerName = name
  const relayPool = createRelayPool({
    stateFile,
    skipPersistedServers: true,
    computeOwnFingerprints: () => ({}),
    onStateChange: () => { interceptHandle?.notePoolEvent() },
    onServerRemoved: () => { interceptHandle?.notePoolEvent() },
  })
  interceptHandle = installIntercept({
    raw: rawGateway,
    pool: relayPool,
  })

  const relayHandler = createRelayHandler({
    secret: SECRET,
    store,
    gateway: createLocalOnlyGateway(rawGateway),
    serverInfo: {
      serverId: loadServerId(home),
      serverName: () => currentServerName,
      dshVersion: '0.0.0-peer-e2e',
      fingerprints: () => ({}),
      plugins: () => ({}),
    },
    heartbeatMs: 300,
  })

  const engine = createPeerEngine({
    stateFile,
    identity,
    relayPool,
    relayHandler: () => relayHandler,
    relaySecret: () => SECRET,
    serverName: () => currentServerName,
    udpSocket: punchSocket,
    udpProbe: { primaryPort: gw.udp.primaryPort, altPort: gw.udp.altPort ?? 0 },
    punch: { punchWindowMs: 1000, punchIntervalMs: 100, punchRounds: 10, reprobeIntervalMs: 60_000 },
  })

  return {
    name,
    setServerName: (n) => {
      currentServerName = n
      engine.announceSelfName(n)
    },
    identity,
    home,
    stateFile,
    store,
    rawGateway,
    relayPool,
    interceptHandle,
    relayHandler,
    engine,
    promptsReceived,
    createdWorkspaceIds,
    get activeLocalStreams() { return activeLocalStreams },
    get peakLocalStreams() { return peakLocalStreams },
    stop: () => {
      interceptHandle.uninstall()
      engine.stop()
      relayPool.stop()
      try { punchSocket.close() } catch { /* already closed */ }
    },
  }
}

test('PG-8 #6: 双端同装 installIntercept 打开全局流不产生流风暴（无 too-many-streams），远程历史加载与实时流式回复正常', async () => {
  const gw = await startGateway()
  const net = await createNetwork(gw, { mode: 'key' })
  const nodes = []
  const aborts = []
  try {
    assert.equal(typeof createLocalOnlyGateway, 'function', 'createLocalOnlyGateway must be exported from intercept')
    const A = await startFullPeerNode(gw, { name: 'Alpha', shared: ['s-a1'], localWorkspaceId: 'ws-a', localSessionId: 's-a1' })
    const B = await startFullPeerNode(gw, { name: 'Beta', shared: ['s-b1'], localWorkspaceId: 'ws-b', localSessionId: 's-b1' })
    nodes.push(A, B)

    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await waitPeerOnline(A, B.identity.nodeId)
    await waitPeerOnline(B, A.identity.nodeId)

    // 模拟两端各自的桌面窗口同时打开 workspace/follow + session/control + $events 三条全局合并流
    const openUiStreams = async (node) => {
      const ac = new AbortController()
      aborts.push(ac)
      const wsFrames = []
      const wsIter = await node.rawGateway.openWireStream('workspace/follow', { args: {} }, undefined, undefined, ac.signal, { signal: ac.signal })
      const ctrlIter = await node.rawGateway.openWireStream('session/control', { args: {} }, undefined, undefined, ac.signal, { signal: ac.signal })
      const evIter = await node.rawGateway.openWireStream('$events', {}, undefined, undefined, ac.signal, { signal: ac.signal })
      ;(async () => { for await (const f of wsIter) wsFrames.push(f) })().catch(() => {})
      ;(async () => { for await (const _ of ctrlIter) { /* drain */ } })().catch(() => {})
      ;(async () => { for await (const _ of evIter) { /* drain */ } })().catch(() => {})
      return wsFrames
    }
    const wsFramesA = await openUiStreams(A)
    const wsFramesB = await openUiStreams(B)

    const virtualBSessionOnA = toVirtual(B.identity.nodeId, 's-b1')
    await waitFor(
      () => wsFramesA.some((f) => f.type === 'upsert' && Array.isArray(f.workspace?.sessionIds) && f.workspace.sessionIds.includes(virtualBSessionOnA)),
      8000,
      'A sidebar received virtualized workspace from B',
    )
    const virtualASessionOnB = toVirtual(A.identity.nodeId, 's-a1')
    await waitFor(
      () => wsFramesB.some((f) => f.type === 'upsert' && Array.isArray(f.workspace?.sessionIds) && f.workspace.sessionIds.includes(virtualASessionOnB)),
      8000,
      'B sidebar received virtualized workspace from A',
    )

    // 确认绝无指数级互拉流风暴：每端本地流数量保持个位数（本地 UI 3 条 + 对端中继拉取的 2~3 条）
    await sleep(300)
    assert.ok(A.peakLocalStreams <= 10, `A peakLocalStreams should stay bounded, got ${A.peakLocalStreams}`)
    assert.ok(B.peakLocalStreams <= 10, `B peakLocalStreams should stay bounded, got ${B.peakLocalStreams}`)

    // 从 A 打开远程会话 zr~<nodeB>~s-b1 的 session/follow：不得报 429 too-many-streams，立即拿到历史快照
    const followAc = new AbortController()
    aborts.push(followAc)
    const followFrames = []
    const followIter = await A.rawGateway.openWireStream(
      'session/follow',
      { args: { request: { address: { kind: 'session', sessionId: virtualBSessionOnA } } } },
      undefined,
      undefined,
      followAc.signal,
      { signal: followAc.signal },
    )
    ;(async () => {
      for await (const frame of followIter) followFrames.push(frame)
    })().catch(() => {})

    await waitFor(() => followFrames.some((f) => f.type === 'snapshot'), 5000, 'remote session/follow delivered history snapshot')
    assert.equal(followFrames[0].header.id, virtualBSessionOnA)

    // 从 A 向远程会话发送消息，断言 B 收到真实 sessionId，且 A 实时收到流式回复帧
    const promptRes = await A.rawGateway.dispatchRpc(
      'session/prompt',
      { args: { request: { sessionId: virtualBSessionOnA, content: 'ping-live' } } },
      undefined,
      undefined,
    )
    assert.equal(promptRes.ok, true)
    await waitFor(
      () => followFrames.some((f) => f.type === 'assistant-stream' && f.chunk?.delta === 'reply-from-Beta:ping-live'),
      5000,
      'remote session/follow streamed live assistant reply back to A',
    )
    assert.equal(B.promptsReceived[0].sessionId, 's-b1')
  } finally {
    for (const ac of aborts) ac.abort()
    for (const node of nodes) node.stop()
    await gw.close()
  }
})

// ---------------------------------------------------------------- 7. 卸载后再手动挂载、断线重连清理陈旧设备、设备重命名实时同步

test('PG-8 #7: 手动卸载后再次挂载可恢复且生成新工作区纪元 id、welcome 差集清理离网设备、重命名实时同步且跳过非网络配对记录', async () => {
  const gw = await startGateway()
  const net = await createNetwork(gw, { mode: 'key' })
  const nodes = []
  const aborts = []
  try {
    const A = await startFullPeerNode(gw, { name: 'DupHost', shared: ['s-a1'], localWorkspaceId: 'ws-a', localSessionId: 's-a1' })
    // 在 B 的状态文件里预埋一条旧 client 模式的同名配对记录，验证 peer 模式 skipPersistedServers 不会让它占用 DupHost-1
    upsertPairedServer(path.join(ROOT, 'unused.json'), { serverUrl: 'http://192.168.1.9:3088', token: 'tok' })
    const B = await startFullPeerNode(gw, { name: 'Viewer', shared: ['s-b1'], localWorkspaceId: 'ws-b', localSessionId: 's-b1' })
    upsertPairedServer(B.stateFile, { serverUrl: 'http://192.168.1.9:3088', token: 'tok', serverName: 'DupHost' })
    // 重建一个带 skipPersistedServers 的池验证不会混入旧 client 记录
    const cleanCheckPool = createRelayPool({ stateFile: B.stateFile, skipPersistedServers: true })
    assert.equal(cleanCheckPool.entries().length, 0, 'peer mode pool must ignore persisted client-mode servers')
    cleanCheckPool.stop()

    nodes.push(A, B)
    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await waitPeerOnline(B, A.identity.nodeId)

    const ac = new AbortController()
    aborts.push(ac)
    const wsFramesB = []
    const wsIter = await B.rawGateway.openWireStream('workspace/follow', { args: {} }, undefined, undefined, ac.signal, { signal: ac.signal })
    ;(async () => { for await (const f of wsIter) wsFramesB.push(f) })().catch(() => {})

    const epoch0WsId = toVirtual(A.identity.nodeId, 'ws-a')
    await waitFor(
      () => wsFramesB.some((f) => f.type === 'upsert' && f.workspace?.workspaceId === epoch0WsId),
      8000,
      'initial mount emits epoch-0 workspaceId',
    )

    // 1) 点击取消挂载（disabled=true）→ 自动发出 remove 卸载工作区
    B.engine.setNodeDisabled(A.identity.nodeId, true)
    assert.equal(B.engine.status().peers.find((p) => p.nodeId === A.identity.nodeId)?.mounted, false)
    await waitFor(
      () => wsFramesB.some((f) => f.type === 'remove' && f.workspaceId === epoch0WsId),
      5000,
      'unmount emits workspace remove',
    )

    // 2) 再次点击手动挂载（disabled=false）→ 必须重新挂载上线，且使用新纪元 workspaceId 绕开前端 ClientWorkspaceModel.removedIds 黑名单
    B.engine.setNodeDisabled(A.identity.nodeId, false)
    assert.equal(B.engine.status().peers.find((p) => p.nodeId === A.identity.nodeId)?.mounted, true)
    await waitPeerOnline(B, A.identity.nodeId)
    const epoch1WsId = toVirtual(A.identity.nodeId, '#1~ws-a')
    await waitFor(
      () => wsFramesB.some((f) => f.type === 'upsert' && f.workspace?.workspaceId === epoch1WsId),
      8000,
      're-mount emits fresh epoch-1 workspaceId so UI sidebar restores immediately',
    )

    // 在新纪元工作区上新建会话：intercept 必须剥掉 #1~ 还原真实 ws-a
    const createRes = await B.rawGateway.dispatchRpc(
      'session/create',
      { args: { request: { workspaceId: epoch1WsId } } },
      undefined,
      undefined,
    )
    assert.equal(createRes.ok, true)
    assert.equal(A.createdWorkspaceIds[0], 'ws-a')

    // 3) 设备重命名（节点自改名 + 网关控制台 PATCH 改名）→ 对端实时收到 peer-renamed 并更新工作区显示名
    A.setServerName('StudioMac')
    await waitFor(
      () => B.engine.status().peers.find((p) => p.nodeId === A.identity.nodeId)?.name === 'StudioMac',
      5000,
      'B peer status reflects A self-rename',
    )
    await waitFor(
      () => wsFramesB.some((f) => f.type === 'upsert' && f.workspace?.workspaceId === epoch1WsId && String(f.workspace?.title).includes('StudioMac')),
      5000,
      'B sidebar workspace title updated live after A self-rename',
    )

    const patchRes = await api(gw.base, 'PATCH', `/api/v1/networks/${net.id}/members/${A.identity.nodeId}`, {
      cookie: gw.tenantCookie,
      body: { name: 'OfficeMini' },
    })
    assert.equal(patchRes.status, 200)
    await waitFor(
      () => B.engine.status().peers.find((p) => p.nodeId === A.identity.nodeId)?.name === 'OfficeMini',
      5000,
      'gateway console PATCH member rename propagated to B',
    )
  } finally {
    for (const ac of aborts) ac.abort()
    for (const node of nodes) node.stop()
    await gw.close()
  }
})

// ---------------------------------------------------------------- 8. peer 模式文件目录侧栏（dsh-better-sidebar）默认放行且回环不重入拦截

test('PG-8 #8: peer 模式下 dsh-better-sidebar 远程会话请求默认桥接 200（无 503 consent-off 且回环不串扰），显式 false 时返回 503', async () => {
  const gw = await startGateway()
  const net = await createNetwork(gw, { mode: 'key' })
  const nodes = []
  const servers = []
  const liveSockets = new Set()
  try {
    const sidebarAdapter = ADAPTERS.find((a) => a.plugin === 'dsh-better-sidebar')
    assert.ok(sidebarAdapter, 'dsh-better-sidebar adapter must exist')

    let serverExplicitConsent = {}
    const makeBridgedPeer = async (name, shared) => {
      const home = path.join(ROOT, `sb-${name}-${Math.random().toString(36).slice(2, 6)}`)
      fs.mkdirSync(home, { recursive: true })
      const stateFile = path.join(home, 'zen-remote-state.json')
      const identity = ensurePeerIdentity(stateFile)
      const punchSocket = await openUdp()
      const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
      for (const id of shared) store.share(id)

      const registry = createBridgeRegistry()
      const normalized = normalizeAdapter(sidebarAdapter, sidebarAdapter.versions[0])
      registry.registerNormalized(normalized.declaration)
      const adapters = [normalized]
      const loopbackSecret = `loopback-secret-${name}-${Math.random().toString(16).slice(2)}`

      // 模拟真实 dsh-host-webserver + dsh-better-sidebar 路由表
      const routes = new Map()
      routes.set('/sidebar/api', {
        kind: 'prefix',
        path: '/sidebar/api',
        handler: async (req, res) => {
          const chunks = []
          for await (const c of req) chunks.push(c)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, servedBy: name, sessionId: body.sessionId, entries: ['README.md'] }))
        },
      })
      const webServer = {
        exact: new Map(),
        prefixes: new Map(),
        upgrades: new Map(),
        match(pathname) {
          for (const [p, r] of routes.entries()) {
            if (pathname === p || pathname.startsWith(`${p}/`)) return r
          }
          return undefined
        },
      }
      const httpServer = http.createServer((req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        if (pathname === '/__auth') {
          res.writeHead(303, { 'set-cookie': 'dsh_auth=ok; Path=/', location: '/' })
          res.end()
          return
        }
        const matched = webServer.match(pathname)
        if (!matched) { res.writeHead(404); res.end(); return }
        void matched.handler(req, res)
      })
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
      servers.push(httpServer)
      const port = httpServer.address().port

      const loopback = createPluginLoopback({
        getTarget: () => ({ protocol: 'http:', port }),
        getTokenUrl: () => `http://127.0.0.1:${port}/__auth`,
        loopbackSecret,
      })

      const effectivePeerConsent = () => {
        const out = {}
        for (const decl of registry.list()) {
          out[decl.plugin] = serverExplicitConsent[decl.plugin] ?? true
        }
        return out
      }

      const gateway = {
        invoke: async () => ({ items: [] }),
        stream: async () => (async function* () {})(),
        wireStream: { open: async () => (async function* () {})() },
        dispatchRpc: async () => ({ ok: true, value: {} }),
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
          plugins: () => {
            const consent = effectivePeerConsent()
            const table = {}
            for (const decl of registry.list()) {
              table[decl.plugin] = {
                version: decl.version,
                digest: decl.digest,
                serverScopeConsent: consent[decl.plugin] === true,
              }
            }
            return table
          },
        },
        pluginBridge: {
          registry,
          getConsent: effectivePeerConsent,
          loopback,
          adapters,
        },
      })

      const relayPool = createRelayPool({ stateFile, skipPersistedServers: true, computeOwnFingerprints: () => ({}) })
      const { compareBridges } = require('../lib/plugin-bridge.js')
      const intercept = installPluginRouteIntercept({
        webServer,
        registry,
        adapters,
        loopbackSecret,
        getRelayForServer: (sid) => relayPool.getByServerId(sid)?.client,
        getStatusForServer: (sid) => {
          const entry = relayPool.getByServerId(sid)
          return entry ? compareBridges(registry.list(), entry.client.handshakeInfo?.plugins, entry.client.state === 'online') : []
        },
        // 故意让服务端自己的浏览器正停在另一个虚拟会话上，验证回环请求不会触发本机拦截串扰
        getCurrentSession: () => 'zr~deadbeef~other-remote',
      })

      const engine = createPeerEngine({
        stateFile,
        identity,
        relayPool,
        relayHandler: () => relayHandler,
        relaySecret: () => SECRET,
        serverName: () => name,
        udpSocket: punchSocket,
        udpProbe: null,
        punch: { punchWindowMs: 400, punchIntervalMs: 100, punchRounds: 4, reprobeIntervalMs: 60_000 },
      })

      return {
        name,
        identity,
        port,
        relayPool,
        engine,
        stop: () => {
          intercept.uninstall()
          relayHandler.closeAll('stop')
          engine.stop()
          relayPool.stop()
          try { punchSocket.close() } catch { /* ignore */ }
        },
      }
    }

    const A = await makeBridgedPeer('PeerA', ['s-a1'])
    const B = await makeBridgedPeer('PeerB', ['s-b1'])
    nodes.push(A, B)

    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await waitPeerOnline(A, B.identity.nodeId)
    await waitPeerOnline(B, A.identity.nodeId)

    // 从 A 请求远程会话 zr~<nodeB>~s-b1 的文件树：默认同意放行 → 200 OK
    const treeRes = await fetch(`http://127.0.0.1:${A.port}/sidebar/api/fs.tree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: toVirtual(B.identity.nodeId, 's-b1'), path: '.' }),
    })
    assert.equal(treeRes.status, 200, 'dsh-better-sidebar fs.tree must answer 200 instead of 503 on peer session')
    const treeBody = await treeRes.json()
    assert.equal(treeBody.servedBy, 'PeerB')
    assert.equal(treeBody.sessionId, 's-b1', 'virtual sessionId rewritten to real id on PeerB')

    // 当 PeerB 显式关闭 dsh-better-sidebar 同意开关时 → 503 consent-off
    serverExplicitConsent = { 'dsh-better-sidebar': false }
    await A.relayPool.getByServerId(B.identity.nodeId).client.connect()
    const deniedRes = await fetch(`http://127.0.0.1:${A.port}/sidebar/api/fs.tree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: toVirtual(B.identity.nodeId, 's-b1'), path: '.' }),
    })
    assert.equal(deniedRes.status, 503)
  } finally {
    for (const node of nodes) node.stop()
    for (const sock of liveSockets) { try { sock.destroy() } catch { /* ignore */ } }
    await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r) })))
    await gw.close()
  }
})

// ============================================================================
// 验收 9：高延迟中继 + 单向 UDP 黑洞 + 侧栏 WS 隧道切换会话 + 实时流式回复不断连不丢帧
// ============================================================================

test('PG-8 #9: high-latency WS relay + one-way UDP blackhole + sidebar WS session switching delivers live streaming replies with zero offline flaps', async () => {
  const netMod = require('node:net')
  const cryptoMod = require('node:crypto')
  const gw = await startGateway()
  // Inject realistic cross-region latency (70ms one-way = 140ms RTT) on binary relay frames at gateway!
  const origUpgrade = gw.hub.wss.handleUpgrade.bind(gw.hub.wss)
  gw.hub.wss.handleUpgrade = (req, sock, head, cb) => {
    origUpgrade(req, sock, head, (ws) => {
      const origSend = ws.send.bind(ws)
      ws.send = (data, optsOrCb, maybeCb) => {
        const binary = optsOrCb !== null && typeof optsOrCb === 'object' && optsOrCb.binary === true
        if (binary) {
          const copy = Buffer.from(data)
          setTimeout(() => {
            try { origSend(copy, optsOrCb, maybeCb) } catch { /* closed */ }
          }, 70)
          return
        }
        return origSend(data, optsOrCb, maybeCb)
      }
      cb(ws)
    })
  }

  const net = await createNetwork(gw, { mode: 'key' })
  const nodes = []
  const servers = []
  const liveSockets = new Set()

  try {
    const sidebarAdapter = ADAPTERS.find((a) => a.plugin === 'dsh-better-sidebar')
    assert.ok(sidebarAdapter, 'dsh-better-sidebar adapter must exist')

    async function makeStreamingPeer(name, sessionIds, { dropUdpToPort } = {}) {
      const home = fs.mkdtempSync(path.join(ROOT, `live-${name}-`))
      const stateFile = path.join(home, 'zen-remote-state.json')
      const identity = ensurePeerIdentity(stateFile)
      const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
      for (const sid of sessionIds) store.share(sid)

      const punchSocket = await openUdp()
      if (typeof dropUdpToPort === 'function') {
        const realSend = punchSocket.send.bind(punchSocket)
        punchSocket.send = (buf, port, address, cb) => {
          if (dropUdpToPort(port)) {
            if (typeof cb === 'function') cb(null)
            return
          }
          return realSend(buf, port, address, cb)
        }
      }

      // Live streaming state per session (mirrors SessionHistoryController.follow)
      const followers = new Map() // sid -> Set<(frame) => void>
      for (const sid of sessionIds) followers.set(sid, new Set())

      const loopbackSecret = `loopback-${name}-secret`
      const registry = createBridgeRegistry()
      const normalized = normalizeAdapter(sidebarAdapter, sidebarAdapter.versions[0])
      registry.registerNormalized(normalized.declaration)
      const adapters = [normalized]
      const routes = new Map()
      routes.set('/sidebar/api', {
        path: '/sidebar/api',
        prefix: true,
        handler: async (req, res) => {
          const chunks = []
          for await (const c of req) chunks.push(c)
          const parsed = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, servedBy: name, sessionId: parsed.sessionId ?? null }))
        },
      })

      const upgrades = new Map()
      for (const wsPath of ['/sidebar/ws/agent-opens', '/sidebar/ws/fs-watch']) {
        upgrades.set(wsPath, {
          path: wsPath,
          handler: (req, socket) => {
            const key = req.headers['sec-websocket-key']
            const accept = cryptoMod
              .createHash('sha1')
              .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
              .digest('base64')
            const u = new URL(req.url ?? '/', 'http://127.0.0.1')
            const sid = u.searchParams.get('sessionId') ?? ''
            const greeting = Buffer.from(JSON.stringify({ wsPath, servedBy: name, sessionId: sid }), 'utf8')
            // Unmasked server -> client text WS frame (0x81)
            const wsFrame = Buffer.concat([Buffer.from([0x81, greeting.length]), greeting])
            socket.write(
              `HTTP/1.1 101 Switching Protocols\r\n`
              + `Upgrade: websocket\r\n`
              + `Connection: Upgrade\r\n`
              + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            )
            socket.write(wsFrame)
            socket.on('error', () => {})
          },
        })
      }

      const webServer = {
        exact: new Map(),
        prefixes: new Map(),
        upgrades,
        match(pathname) {
          for (const [p, r] of routes.entries()) {
            if (pathname === p || pathname.startsWith(`${p}/`)) return r
          }
          return undefined
        },
      }
      const httpServer = http.createServer((req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        if (pathname === '/__auth') {
          res.writeHead(303, { 'set-cookie': 'dsh_auth=ok; Path=/', location: '/' })
          res.end()
          return
        }
        const matched = webServer.match(pathname)
        if (!matched) { res.writeHead(404); res.end(); return }
        void matched.handler(req, res)
      })
      httpServer.on('connection', (sock) => {
        liveSockets.add(sock)
        sock.on('close', () => liveSockets.delete(sock))
      })
      httpServer.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        const entry = webServer.upgrades.get(pathname)
        if (!entry) { socket.destroy(); return }
        entry.handler(req, socket, head)
      })
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
      servers.push(httpServer)
      const port = httpServer.address().port

      const loopback = createPluginLoopback({
        getTarget: () => ({ protocol: 'http:', port }),
        getTokenUrl: () => `http://127.0.0.1:${port}/__auth`,
        loopbackSecret,
      })

      let turnDoneResolve = null
      const gateway = {
        invoke: async (call) => {
          const { namespace: ns, method, args } = call
          if (ns === 'session' && method === 'list') {
            return { items: sessionIds.map((id) => ({ sessionId: id, title: `${name}:${id}` })) }
          }
          if (ns === 'session' && method === 'prompt') {
            const sid = args.request.sessionId
            const subs = followers.get(sid)
            // Stream 80 live assistant-stream chunks asynchronously over ~240ms
            void (async () => {
              for (const fn of subs ?? []) {
                fn({ kind: 'event', event: { seq: 1, type: 'turn-started' } })
              }
              for (let i = 0; i < 80; i += 1) {
                await sleep(3)
                const chunkText = `chunk-${i}-${'x'.repeat(80)}`
                for (const fn of subs ?? []) {
                  fn({
                    kind: 'assistant-stream',
                    event: { kind: 'chunk', turnId: 'turn-1', seq: i + 1, part: { type: 'text', text: chunkText } },
                  })
                }
              }
              for (const fn of subs ?? []) {
                fn({ kind: 'assistant-stream', event: { kind: 'end', turnId: 'turn-1', status: 'completed' } })
                fn({ kind: 'event', event: { seq: 2, type: 'turn-ended' } })
              }
              if (turnDoneResolve) turnDoneResolve()
            })()
            return { accepted: true, sessionId: sid }
          }
          return { ok: true }
        },
        stream: async (call) => {
          const { namespace: ns, method, args, signal } = call
          if (ns === 'session' && method === 'follow') {
            const sid = args.request.address.sessionId
            const queue = [{ kind: 'snapshot', session: { id: sid, status: 'idle' }, events: [] }]
            let notify = null
            let closed = false
            const push = (frame) => {
              if (closed) return
              queue.push(frame)
              if (notify) { const n = notify; notify = null; n() }
            }
            followers.get(sid)?.add(push)
            const cleanup = () => {
              closed = true
              followers.get(sid)?.delete(push)
              if (notify) { const n = notify; notify = null; n() }
            }
            signal?.addEventListener('abort', cleanup, { once: true })
            return (async function* () {
              try {
                while (!closed) {
                  while (queue.length > 0) yield queue.shift()
                  if (closed) break
                  await new Promise((r) => { notify = r })
                }
              } finally {
                cleanup()
              }
            })()
          }
          return (async function* () {})()
        },
        wireStream: { open: async () => (async function* () {})() },
        dispatchRpc: async () => ({ ok: true, value: {} }),
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
          plugins: () => {
            const table = {}
            for (const decl of registry.list()) {
              table[decl.plugin] = { version: decl.version, digest: decl.digest, serverScopeConsent: true }
            }
            return table
          },
        },
        pluginBridge: {
          registry,
          getConsent: () => ({ 'dsh-better-sidebar': true }),
          loopback,
          adapters,
          tunnel: require('../lib/plugin-tunnel.js').createPluginTunnel({
            bridge: { registry, getConsent: () => ({ 'dsh-better-sidebar': true }), loopback },
            getTarget: () => ({ protocol: 'http:', port }),
            isAccessible: (sid) => store.isAccessible(sid),
            heartbeatMs: 15_000,
            loopbackSecret,
          }),
        },
      })

      const relayPool = createRelayPool({ stateFile, skipPersistedServers: true, computeOwnFingerprints: () => ({}) })
      const { compareBridges } = require('../lib/plugin-bridge.js')
      const intercept = installPluginRouteIntercept({
        webServer,
        registry,
        adapters,
        loopbackSecret,
        getRelayForServer: (sid) => relayPool.getByServerId(sid)?.client,
        getStatusForServer: (sid) => {
          const entry = relayPool.getByServerId(sid)
          return entry ? compareBridges(registry.list(), entry.client.handshakeInfo?.plugins, entry.client.state === 'online') : []
        },
      })

      const engine = createPeerEngine({
        stateFile,
        identity,
        relayPool,
        relayHandler: () => relayHandler,
        relaySecret: () => SECRET,
        serverName: () => name,
        udpSocket: punchSocket,
        udpProbe: null,
        punch: { punchWindowMs: 400, punchIntervalMs: 100, punchRounds: 4, reprobeIntervalMs: 60_000 },
      })

      return {
        name,
        identity,
        port,
        punchPort: punchSocket.address().port,
        relayPool,
        engine,
        waitNextTurnDone: () => new Promise((r) => { turnDoneResolve = r }),
        stop: () => {
          intercept.uninstall()
          relayHandler.closeAll('stop')
          engine.stop()
          relayPool.stop()
          try { punchSocket.close() } catch { /* ignore */ }
        },
      }
    }

    let portA = -1
    const A = await makeStreamingPeer('PeerA', ['s-a1'])
    portA = A.punchPort
    // Asymmetric one-way UDP blackhole: A -> B UDP reaches B, but B -> A UDP is 100% dropped!
    const B = await makeStreamingPeer('PeerB', ['s-b1', 's-b2'], {
      dropUdpToPort: (dstPort) => dstPort === portA,
    })
    nodes.push(A, B)

    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await waitPeerOnline(A, B.identity.nodeId, 12_000)
    await waitPeerOnline(B, A.identity.nodeId, 12_000)

    const clientToB = A.relayPool.getByServerId(B.identity.nodeId).client
    const stateTransitions = []
    clientToB.subscribe((s) => stateTransitions.push(s))

    // Helper: open a real WebSocket upgrade to A's local webServer (as dsh-better-sidebar does on session switch)
    function openSidebarWs(wsPath, virtualSessionId) {
      return new Promise((resolve, reject) => {
        const sock = netMod.connect(A.port, '127.0.0.1', () => {
          const wsKey = cryptoMod.randomBytes(16).toString('base64')
          // Include >1200B header padding to also exercise multi-fragment request metadata over PeerMux!
          const bigCookie = `pad=${'c'.repeat(1400)}`
          sock.write(
            `GET ${wsPath}?sessionId=${encodeURIComponent(virtualSessionId)} HTTP/1.1\r\n`
            + `Host: 127.0.0.1:${A.port}\r\n`
            + `Upgrade: websocket\r\n`
            + `Connection: Upgrade\r\n`
            + `Sec-WebSocket-Key: ${wsKey}\r\n`
            + `Sec-WebSocket-Version: 13\r\n`
            + `Cookie: ${bigCookie}\r\n\r\n`,
          )
        })
        let buf = Buffer.alloc(0)
        sock.on('data', (c) => {
          buf = Buffer.concat([buf, c])
          const headerEnd = buf.indexOf('\r\n\r\n')
          if (headerEnd === -1) return
          const headStr = buf.subarray(0, headerEnd).toString('utf8')
          if (!headStr.startsWith('HTTP/1.1 101')) {
            reject(new Error(`WS upgrade failed: ${headStr.split('\r\n')[0]}`))
            sock.destroy()
            return
          }
          const rest = buf.subarray(headerEnd + 4)
          if (rest.length >= 2) {
            const payloadLen = rest[1] & 0x7f
            if (rest.length >= 2 + payloadLen) {
              const json = JSON.parse(rest.subarray(2, 2 + payloadLen).toString('utf8'))
              resolve({ sock, greeting: json })
            }
          }
        })
        sock.on('error', reject)
      })
    }

    // 1. Open remote session s-b1 + sidebar WS tunnels, then rapidly switch s-b1 -> s-b2 -> s-b1!
    const vS1 = toVirtual(B.identity.nodeId, 's-b1')
    const vS2 = toVirtual(B.identity.nodeId, 's-b2')

    const ws1 = await openSidebarWs('/sidebar/ws/agent-opens', vS1)
    assert.equal(ws1.greeting.servedBy, 'PeerB')
    assert.equal(ws1.greeting.sessionId, 's-b1', 'WS tunnel rewrote virtual sessionId to s-b1 and delivered greeting in order')
    ws1.sock.destroy() // Close on switch to s-b2

    const ws2 = await openSidebarWs('/sidebar/ws/fs-watch', vS2)
    assert.equal(ws2.greeting.sessionId, 's-b2')
    ws2.sock.destroy() // Switch back to s-b1

    const ws3 = await openSidebarWs('/sidebar/ws/agent-opens', vS1)
    assert.equal(ws3.greeting.sessionId, 's-b1')

    assert.equal(clientToB.state, 'online', 'switching remote sessions must keep RelayClient online')
    assert.deepEqual(stateTransitions, [], 'ZERO offline/reconnecting flaps during session switches under high latency')

    // 2. Open session/follow on s-b1 and send session/prompt — verify LIVE streaming before turn finishes!
    const followAbort = new AbortController()
    const streamIter = clientToB.openStream(
      'session',
      'follow',
      { request: { address: { kind: 'session', sessionId: 's-b1' } } },
      followAbort.signal,
    )[Symbol.asyncIterator]()

    const firstSnap = await streamIter.next()
    assert.equal(firstSnap.value?.kind, 'snapshot')

    const liveChunks = []
    let turnEndedSeen = false
    const pumpPromise = (async () => {
      for (;;) {
        const step = await streamIter.next()
        if (step.done) break
        const frame = step.value
        if (frame?.kind === 'assistant-stream' && frame.event?.kind === 'chunk') {
          liveChunks.push(frame.event.part.text)
        }
        if (frame?.kind === 'event' && frame.event?.type === 'turn-ended') {
          turnEndedSeen = true
          break
        }
      }
    })()

    let chunksMidTurn = 0
    const turnDoneOnB = B.waitNextTurnDone().then(() => {
      chunksMidTurn = liveChunks.length
    })

    const promptRes = await clientToB.invoke('session', 'prompt', {
      request: {
        sessionId: 's-b1',
        content: [{ type: 'text', text: 'stream 80 chunks please' }],
      },
    })
    assert.equal(promptRes.accepted, true)

    await Promise.all([turnDoneOnB, pumpPromise])
    followAbort.abort()
    ws3.sock.destroy()

    assert.ok(chunksMidTurn > 0, `expected live chunks to arrive mid-turn before turn ended on PeerB, got ${chunksMidTurn}`)
    assert.equal(turnEndedSeen, true, 'turn-ended event delivered live over session/follow')
    assert.equal(liveChunks.length, 80, 'all 80 assistant-stream chunks delivered live without switching sessions')
    assert.equal(liveChunks[0], `chunk-0-${'x'.repeat(80)}`)
    assert.equal(liveChunks[79], `chunk-79-${'x'.repeat(80)}`)
    assert.deepEqual(stateTransitions, [], 'ZERO offline flaps throughout live streaming under latency + one-way UDP')
  } finally {
    for (const node of nodes) node.stop()
    for (const sock of liveSockets) { try { sock.destroy() } catch { /* ignore */ } }
    await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r) })))
    await gw.close()
  }
})

// ---------------------------------------------------------------- PC-05：中途丢 UDP 的已知长度上传经 WS 恢复完成

test('PC-05: 2MiB known-length upload rides out a mid-flight UDP blackout through the real virtual pool wiring', async (t) => {
  const gw = await startGateway()
  const net = await createNetwork(gw, { mode: 'key' })
  const nodes = []
  const MIB = 1024 * 1024
  const PAYLOAD = Buffer.alloc(2 * MIB)
  for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i & 0xff
  const EXPECTED_DIGEST = createHash('sha256').update(PAYLOAD).digest('hex')
  const BLACKOUT_AT = 768 * 1024

  // B（上传方）先装配成可拉黑形态：wrapper 一开始放行直连，黑窗由 A 的宿主
  // 替身在收到 768KiB 时拉上——真实 loopback UDP 在途丢失，PC-04 的 15s
  // 接收死线检测后经网关 WS 恢复。
  let B
  try {
    // A 的宿主替身：增量计数 + sha256；≥768KiB 时拉黑 B 的 UDP（恰好一次）。
    let blackedOut = false
    let hostCalls = 0
    let hostReceived = 0
    let hostDigest = null
    const A = await startNode(gw, {
      name: 'node-a',
      shared: ['s-a1'],
      hostFetch: () => async (request) => {
        hostCalls += 1
        const hash = createHash('sha256')
        const reader = request.body.getReader()
        let received = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          hash.update(value)
          if (!blackedOut && received >= BLACKOUT_AT) {
            blackedOut = true
            B.setFirewall(true)
          }
        }
        hostReceived = received
        hostDigest = hash.digest('hex')
        return new Response(JSON.stringify({ ok: true, echoedBytes: received, sha256: hostDigest }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    B = await startNode(gw, { name: 'node-b', firewall: true })
    nodes.push(A, B)
    B.setFirewall(false)

    // 顺序入网，A↔B 打洞直连。
    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await waitFor(() => A.engine.status().gatewayState === 'authorized', 8000, 'A authorized')
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await waitFor(() => B.engine.status().gatewayState === 'authorized', 8000, 'B authorized')
    await waitFor(() => {
      const peer = A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId)
      return peer !== undefined && (peer.path === 'lan' || peer.path === 'p2p')
    }, 15000, 'A↔B direct path')
    // 真实 RelayPool 的虚拟挂载（mountVirtual 接线）——上传预算的恢复余量
    // 必须经这条路到达，不是手工 new 一个带选项的 RelayClient。
    const virtualBonA = await waitPeerOnline(B, A.identity.nodeId)
    await waitPeerOnline(A, B.identity.nodeId)

    // 源速可控：256KiB × 8 段、段间 60ms——正常全程远低于旧 19s 预算，
    // 失败绝不来自慢源；断言看恢复等待本身。
    let sent = 0
    const drip = new ReadableStream({
      async pull(controller) {
        if (sent >= PAYLOAD.length) {
          controller.close()
          return
        }
        const end = Math.min(sent + 256 * 1024, PAYLOAD.length)
        controller.enqueue(new Uint8Array(PAYLOAD.subarray(sent, end)))
        sent = end
        await new Promise((resolve) => setTimeout(resolve, 60))
      },
    })
    const cancel = new AbortController()
    const startedAt = Date.now()
    const uploadPromise = virtualBonA.client.upload(
      { sessionId: 's-a1', name: 'big.bin', body: drip, bytes: PAYLOAD.length },
      cancel.signal,
    )
    const result = await uploadPromise
    const elapsed = Date.now() - startedAt
    t.diagnostic(`pc-05 elapsed=${elapsed}ms hostReceived=${hostReceived} hostCalls=${hostCalls} blackoutFired=${blackedOut}`)

    assert.equal(result.status, 200)
    const receipt = JSON.parse(result.body)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.echoedBytes, PAYLOAD.length, `the byte count survived the recovery (got ${receipt.echoedBytes})`)
    assert.equal(receipt.sha256, EXPECTED_DIGEST, 'the SHA256 survived the recovery')
    assert.equal(hostCalls, 1, 'the business forward ran exactly once — no whole-upload retry')
    assert.ok(elapsed >= 15_000 - 500, `the completion includes the real ~15s direct-loss detection (got ${elapsed} ms)`)
    assert.ok(elapsed < 39_000, `within the recovery budget (got ${elapsed} ms)`)
    cancel.abort() // 已完成——防御性 no-op
  } catch (err) {
    for (const node of nodes) console.error(`[dbg ${node.name}]`, node.logs.join(' | '))
    throw err
  } finally {
    for (const node of nodes) node.stop()
    await gw.close()
  }
})
