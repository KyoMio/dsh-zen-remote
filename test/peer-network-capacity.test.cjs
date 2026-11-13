/* dsh-zen-remote · PC-08b：节点消费动态网络容量的端到端。
 *
 * 进程内拉起**真实的 gateway-server**（SqliteStore + PeerWsHub + 双 UDP 端口
 * UdpStunService + HTTP REST），和 **4 台模拟 DSH peer 节点**。每台节点 =
 * 真实 ShareStore + createRelayHandler（假 typertGateway）+ 真实 RelayPool +
 * 真实 PeerEngine。与 peer-e2e 的唯一差别在 pool 接线：这里传**生产同款**
 * 三件套（src/index.ts PG-2 注释锚点）——getPeerNetworkCap 读真实 statefile
 * 的 peerNetwork.maxPeersFromGateway，getMaxServersSource 'default'，
 * skipPersistedServers true（peer 角色）——容量约束因此真的穿过 pool。
 *
 * 覆盖 PC-08b 三条验收：
 *   1. REST PATCH maxPeers → ws-hub 广播 network-updated → 节点消费、同一
 *      事实源落盘、池上限实时生效；
 *   2. 缩容保留存量挂载、腾出的空位在超额时不补（显式 default 层取
 *      min(64, maxPeers-1)）、升容自动补位（不重连、不 welcome）；
 *   3. 断线（进程重启模拟）后 resumeFromState 重连，welcome 带最新容量，
 *      状态持久化并在新上限内重新挂载。
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dgram = require('node:dgram')

// 主仓（编译产物）
const { createRelayHandler, loadServerId } = require('../lib/relay-server.js')
const { createShareStore } = require('../lib/share-store.js')
const { createRelayPool } = require('../lib/relay-pool.js')
const { ensurePeerIdentity, readPeerNetwork } = require('../lib/state-store.js')
const { createPeerEngine } = require('../lib/peer/engine.js')

// gateway-server（独立包编译产物）
const { createGatewayApiServer } = require('../gateway-server/dist/server.js')
const { SqliteStore } = require('../gateway-server/dist/store/sqlite-store.js')
const { deriveMasterKeyFromSecret, hashPassword } = require('../gateway-server/dist/master-key.js')
const { PeerWsHub } = require('../gateway-server/dist/peer-hub/ws-hub.js')
const { UdpStunService } = require('../gateway-server/dist/peer-hub/udp-stun.js')

const SECRET = 'peer-capacity-e2e-secret-0123456789abcdef'.repeat(2).slice(0, 64)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-peer-capacity-'))
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, ms = 10000, what = 'condition') {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > ms) throw new Error(`waitFor timeout: ${what}`)
    await sleep(25)
  }
}

// ---------------------------------------------------------------- 网关装配

const TENANT_EMAIL = 'tenant@peer-capacity'
const TENANT_PASSWORD = 'tenant-peer-capacity-pass'

async function startGateway() {
  const store = new SqliteStore({
    seed: { allowSignup: false, maxNetworksPerUser: 4, defaultMaxPeers: 8, relayRateKbps: 512 },
  })
  const masterKey = deriveMasterKeyFromSecret('peer-capacity-gateway')
  const hub = new PeerWsHub({ store, masterKey, rateTickMs: null, flushMs: null })
  const server = createGatewayApiServer({ store, masterKey, runtime: hub, hooks: hub.hooks, topology: hub })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  hub.attach(server)
  const stun = new UdpStunService({
    primaryPort: 0,
    altPort: 0,
    host: '127.0.0.1',
    lanEndpointsLookup: (networkId, nodeId) => hub.getLanEndpoints(networkId, nodeId),
    onNatDetected: (rec) => hub.applyNatObservation(rec),
  })
  const udp = await stun.bind()
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const tenant = await store.createUser({
    email: TENANT_EMAIL,
    passwordHash: await hashPassword(TENANT_PASSWORD),
    role: 'user',
  })
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
  return { store, hub, udp, base, port, tenantId: tenant.id, tenantCookie, close }
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

async function createNetwork(gw) {
  const res = await api(gw.base, 'POST', '/api/v1/networks', {
    body: { name: `cap-${Math.random().toString(36).slice(2, 8)}`, admissionMode: 'key' },
    cookie: gw.tenantCookie,
  })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return res.json.data // { id, joinKey, maxPeers, ... }
}

async function patchNetwork(gw, networkId, maxPeers) {
  const res = await api(gw.base, 'PATCH', `/api/v1/networks/${networkId}`, {
    body: { maxPeers },
    cookie: gw.tenantCookie,
  })
  assert.equal(res.status, 200, `PATCH maxPeers=${maxPeers} failed: ${JSON.stringify(res.json)}`)
  return res.json.data
}

/** `zr-net+insecure://127.0.0.1:<port>/<networkId>#<joinKey>`. */
function inviteUri(gw, networkId, joinKey) {
  return `zr-net+insecure://127.0.0.1:${gw.port}/${networkId}#${joinKey}`
}

// ---------------------------------------------------------------- 节点装配

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
 * 一台模拟 DSH peer 节点。pool 接线与生产 src/index.ts 的 peer 半边同款：
 * 三个容量 getter 全部每次调用现场读，getPeerNetworkCap 读真实 statefile。
 */
async function startNode(gw, { name }) {
  const home = path.join(ROOT, `node-${name}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(home, { recursive: true })
  const stateFile = path.join(home, 'zen-remote-state.json')
  const identity = ensurePeerIdentity(stateFile)
  const punchSocket = await openUdp()

  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  const gateway = {
    invoke: async () => { throw Object.assign(new Error('no invoke fake'), { code: 'test/not-implemented' }) },
    stream: async () => { throw Object.assign(new Error('no stream fake'), { code: 'test/not-implemented' }) },
    wireStream: { open: async () => { throw Object.assign(new Error('no wireStream fake'), { code: 'test/not-implemented' }) } },
    dispatchRpc: async () => ({ ok: true, value: undefined }),
  }
  const relayHandler = createRelayHandler({
    secret: SECRET,
    store,
    gateway,
    serverInfo: {
      serverId: loadServerId(home),
      serverName: () => name,
      dshVersion: '0.0.0-peer-capacity-e2e',
      fingerprints: () => ({}),
      plugins: () => ({}),
    },
    getApiFetch: () => async (request) => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    heartbeatMs: 300,
  })

  const relayPool = createRelayPool({
    stateFile,
    skipPersistedServers: true,
    getMaxServers: () => 8,
    getMaxServersSource: () => 'default',
    getPeerNetworkCap: () => readPeerNetwork(stateFile)?.maxPeersFromGateway,
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
    stop: () => {
      engine.stop()
      relayPool.stop()
      try { punchSocket.close() } catch { /* gone */ }
    },
  }
}

/** 等本节点把远端 peer 挂载为在线虚拟服务端条目。 */
async function waitPeerOnline(node, peerNodeId, ms = 20000) {
  try {
    await waitFor(() => {
      const entry = node.relayPool.getByServerId(peerNodeId)
      return entry !== undefined && entry.client.state === 'online'
    }, ms, `${node.name} → ${peerNodeId} virtual entry online`)
  } catch (err) {
    console.error(`[debug] ${node.name} logs:\n  ${node.logs.join('\n  ')}`)
    throw err
  }
  return node.relayPool.getByServerId(peerNodeId)
}

// ---------------------------------------------------------------- PC-08b

test('PC-08b: REST PATCH capacity reaches real engines — shrink retains mounts, a freed slot waits, rise auto-fills, restart restores latest', async () => {
  const gw = await startGateway()
  const nodes = []
  // 重启模拟的第二个 D 引擎/池/socket（finally 统一清理）。
  let restartedD = null
  try {
    const net = await createNetwork(gw)
    assert.equal(net.maxPeers, 8, 'fresh network starts at the seed defaultMaxPeers')
    // 5 台节点：缩容到 3 后每台仍有 4 个远端挂载——超额存量被完整保留；
    // 这样 D 离开只降到 3（仍 ≥ 上限 2），等待补位的空位不会被顺位抢占，
    // 直到升容的 network-updated 才补上。
    const A = await startNode(gw, { name: 'node-a' })
    const B = await startNode(gw, { name: 'node-b' })
    const C = await startNode(gw, { name: 'node-c' })
    const D = await startNode(gw, { name: 'node-d' })
    const E = await startNode(gw, { name: 'node-e' })
    nodes.push(A, B, C, D, E)

    // —— 入网：key 邀请自动准入，welcome 带 8 落到各自 statefile ——
    for (const node of nodes) {
      await node.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
      await waitFor(() => node.engine.status().gatewayState === 'authorized', 10000, `${node.name} authorized`)
    }
    for (const node of nodes) {
      await waitFor(() => readPeerNetwork(node.stateFile)?.maxPeersFromGateway === 8, 8000, `${node.name} persisted welcome cap`)
      assert.equal(node.engine.status().maxPeers, 8)
      assert.equal(node.relayPool.maxServers(), 7, '8 total members minus self, default-layer config lets the network win')
    }
    for (const node of nodes) {
      for (const other of nodes) {
        if (other !== node) await waitPeerOnline(node, other.identity.nodeId)
      }
      assert.equal(node.relayPool.entries().length, 4)
    }

    // —— REST PATCH 缩容 8→3：authorized 连接收 network-updated ——
    const shrunk = await patchNetwork(gw, net.id, 3)
    assert.equal(shrunk.maxPeers, 3, 'PATCH response reflects the persisted network row')
    for (const node of nodes) {
      await waitFor(() => node.engine.status().maxPeers === 3, 8000, `${node.name} consumed network-updated`)
      assert.equal(readPeerNetwork(node.stateFile).maxPeersFromGateway, 3, `${node.name} persisted the increment to the same fact source`)
      assert.equal(node.relayPool.maxServers(), 2, 'pool cap live-reads the statefile (3 minus self)')
      assert.equal(node.relayPool.entries().length, 4, `${node.name} keeps every existing mount through the shrink (4 over-cap mounts retained)`)
    }

    // —— A 手动卸载 B 再恢复：腾出的空位在缩容上限下等待，不超额补挂 ——
    A.engine.setNodeDisabled(B.identity.nodeId, true)
    await waitFor(() => A.relayPool.entries().length === 3, 8000, 'A unmounted B')
    A.engine.setNodeDisabled(B.identity.nodeId, false)
    await sleep(300) // announcePeer→refreshMounts 同步跑完；给反例留观察窗
    assert.equal(A.relayPool.getByServerId(B.identity.nodeId), undefined, 'no over-cap mount while the pool cap is 2')

    // —— D 断线（进程重启模拟），错过升容广播 ——
    D.stop()
    nodes.splice(nodes.indexOf(D), 1) // 从清理清单摘除已停的 D（不能 pop——末尾现在是 E）
    await waitFor(async () => {
      const res = await api(gw.base, 'GET', `/api/v1/networks/${net.id}/topology`, { cookie: gw.tenantCookie })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      const row = res.json.data.members.find((r) => r.nodeId === D.identity.nodeId)
      return row !== undefined && row.online === false
    }, 10000, 'gateway noticed D leaving (topology row offline)')
    // D 离开只把 A 降到 3 个挂载（仍 ≥ 上限 2）：等待中的 B 不得被顺位补上。
    assert.equal(A.relayPool.getByServerId(B.identity.nodeId), undefined, 'D departure must not consume the waiting slot below the shrunk cap')

    // —— REST PATCH 升容 3→4：等待中的 B 由 network-updated 自动补位 ——
    const grown = await patchNetwork(gw, net.id, 4)
    assert.equal(grown.maxPeers, 4)
    await waitFor(() => A.relayPool.getByServerId(B.identity.nodeId) !== undefined, 8000, 'A auto-refilled B after the rise')
    await waitFor(() => readPeerNetwork(A.stateFile).maxPeersFromGateway === 4, 8000, 'A persisted the rise')
    assert.equal(A.relayPool.maxServers(), 3)

    // —— D 重启恢复：新引擎/池挂同一 stateFile，resumeFromState 走原 join 序列 ——
    const Dudp = await openUdp()
    const Dpool = createRelayPool({
      stateFile: D.stateFile,
      skipPersistedServers: true,
      getMaxServers: () => 8,
      getMaxServersSource: () => 'default',
      getPeerNetworkCap: () => readPeerNetwork(D.stateFile)?.maxPeersFromGateway,
      computeOwnFingerprints: () => ({}),
    })
    const Dengine = createPeerEngine({
      stateFile: D.stateFile,
      identity: D.identity,
      relayPool: Dpool,
      relayHandler: () => D.relayHandler,
      relaySecret: () => SECRET,
      serverName: () => 'node-d',
      udpSocket: Dudp,
      udpProbe: { primaryPort: gw.udp.primaryPort, altPort: gw.udp.altPort ?? 0 },
      punch: { punchWindowMs: 1000, punchIntervalMs: 100, punchRounds: 10, reprobeIntervalMs: 60_000 },
      log: (line) => D.logs.push(line),
    })
    restartedD = {
      stop: () => {
        Dengine.stop()
        Dpool.stop()
        try { Dudp.close() } catch { /* gone */ }
      },
    }
    assert.equal(readPeerNetwork(D.stateFile).maxPeersFromGateway, 3, 'offline D still carries its last-known cap on disk (missed the rise broadcast)')
    assert.equal(Dengine.resumeFromState(), true)
    await waitFor(() => Dengine.status().gatewayState === 'authorized', 10000, 'D re-authorized after restart')
    await waitFor(() => Dengine.status().maxPeers === 4, 8000, 'reconnect welcome carries the latest capacity')
    assert.equal(readPeerNetwork(D.stateFile).maxPeersFromGateway, 4, 'latest capacity persisted across the restart')
    assert.equal(Dpool.maxServers(), 3)
    // 新上限内恰好补 3 个挂载（welcome.peers 公告序），不超额；挂上的都 online。
    await waitFor(() => Dpool.entries().length === 3 && Dpool.entries().every((entry) => entry.client.state === 'online'), 20000, 'D remounts exactly the peers the new cap allows, all online')
  } catch (err) {
    for (const node of nodes) console.error(`[dbg ${node.name}]`, node.logs.join(' | '))
    throw err
  } finally {
    for (const node of nodes) node.stop()
    if (restartedD !== null) restartedD.stop()
    await gw.close()
  }
})
