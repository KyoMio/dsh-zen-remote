'use strict'
// dsh-zen-remote · PC-03 暂停后自动恢复节点互通——真实网关 + 真实双节点的端到端。
//
// 单测进程内拉起**真实的 gateway-server**（SqliteStore + PeerWsHub + HTTP REST，
// 复用 peer-e2e 的装配方式），和**两台真实 peer 节点**（真实 ShareStore +
// createRelayHandler 假网关门 + 真实 RelayPool + 真实 PeerEngine）。覆盖：
//
//   1. 真实 REST pause → resume 闭环：暂停即断业务（双向卸载、拓扑离线），
//      resume 后同一条控制连接原地恢复挂载与会话读取（2s 内），不重贴邀请、
//      不重启节点（SPEC：resume 后立即恢复互通，无需重新入网）。
//   2. 暂停期间节点重启 / 断线重连 / 重复 pause-resume / 暂停后删除成员，
//      全部以服务端最新持久授权为准。
//   3. resume 沿同一 WS 重建授权事实后，必要的 STUN 重探发生（恢复前在途
//      探测结果作废）——用独立 fake UDP listener 计数探测。
//
// 全部用临时目录、随机身份与回环端口；不触碰真实 DSH；无攻击 PoC。
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
const { ensurePeerIdentity } = require('../lib/state-store.js')
const { createPeerEngine } = require('../lib/peer/engine.js')
const { toVirtual } = require('../lib/virtual-id.js')

// gateway-server（独立包编译产物）
const { createGatewayApiServer } = require('../gateway-server/dist/server.js')
const { SqliteStore } = require('../gateway-server/dist/store/sqlite-store.js')
const { deriveMasterKeyFromSecret, hashPassword } = require('../gateway-server/dist/master-key.js')
const { PeerWsHub } = require('../gateway-server/dist/peer-hub/ws-hub.js')

const SECRET = 'peer-pause-resume-relay-secret-0123456789abcdef'.repeat(2).slice(0, 64)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-peer-pause-resume-'))
const SESSION_TITLE = 'A 的私密会话标题'

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

const ADMIN_EMAIL = 'admin@peer-pause-resume'
const ADMIN_PASSWORD = 'admin-peer-pause-resume-pass'
const TENANT_EMAIL = 'tenant@peer-pause-resume'
const TENANT_PASSWORD = 'tenant-peer-pause-resume-pass'

/** 不带真实 UDP STUN 服务的网关（探测类用例自己提供 fake listener）。 */
async function startGateway({ withStun = true } = {}) {
  const store = new SqliteStore({
    seed: { allowSignup: false, maxNetworksPerUser: 4, defaultMaxPeers: 8, relayRateKbps: 512 },
  })
  const masterKey = deriveMasterKeyFromSecret('peer-pause-resume-gateway')
  const hub = new PeerWsHub({ store, masterKey, rateTickMs: null, flushMs: null })
  const server = createGatewayApiServer({ store, masterKey, runtime: hub, hooks: hub.hooks, topology: hub })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  hub.attach(server)
  const natRecords = []
  let udp = null
  let stun = null
  if (withStun) {
    const { UdpStunService } = require('../gateway-server/dist/peer-hub/udp-stun.js')
    stun = new UdpStunService({
      primaryPort: 0,
      altPort: 0,
      host: '127.0.0.1',
      lanEndpointsLookup: (networkId, nodeId) => hub.getLanEndpoints(networkId, nodeId),
      onNatDetected: (rec) => { natRecords.push(rec); hub.applyNatObservation(rec) },
    })
    udp = await stun.bind()
  }
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
    if (stun !== null) await stun.close()
    await new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
    await store.close()
  }
  return { store, hub, stun, udp, natRecords, base, port, tenantId: tenant.id, adminCookie, tenantCookie, close }
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
  return res.json.data
}

async function getTopology(gw, networkId) {
  const res = await api(gw.base, 'GET', `/api/v1/networks/${networkId}/topology`, { cookie: gw.tenantCookie })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return res.json.data
}

function inviteUri(gw, networkId, joinKey) {
  const fragment = joinKey !== undefined && joinKey !== null && joinKey !== '' ? `#${joinKey}` : ''
  return `zr-net+insecure://127.0.0.1:${gw.port}/${networkId}${fragment}`
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
 * 一台真实 peer 节点。home 可复用（节点重启场景沿用同一 state 文件与身份）；
 * udpProbe 显式注入（缺省指向网关真实 STUN 端口，与 peer-e2e 相同）。
 */
async function startNode(gw, { name, home, shared = [], udpProbe } = {}) {
  const ownHome = home ?? path.join(ROOT, `node-${name}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(ownHome, { recursive: true })
  const stateFile = path.join(ownHome, 'zen-remote-state.json')
  const identity = ensurePeerIdentity(stateFile)
  const punchSocket = await openUdp()

  const store = createShareStore({ file: path.join(ownHome, 'shares.json'), idleHours: 48 })
  for (const id of shared) store.share(id)
  const listResults = new Map()
  let invokeImpl = null

  const gateway = {
    invoke: async (call) => {
      if (invokeImpl !== null) return invokeImpl(call)
      if (call.namespace === 'session' && call.method === 'list') {
        return listResults.get(call.args?.request?.sessionId ?? '*') ?? { items: [] }
      }
      if (call.namespace === 'session' && call.method === 'modelCatalog') {
        return { default: null, routableProviders: [], groups: [], failures: [] }
      }
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
    stream: async () => {
      throw Object.assign(new Error('no stream fake'), { code: 'test/not-implemented' })
    },
    wireStream: { open: async () => { throw Object.assign(new Error('no wireStream fake'), { code: 'test/not-implemented' }) } },
    dispatchRpc: async () => ({ ok: true, value: undefined }),
  }

  const relayHandler = createRelayHandler({
    secret: SECRET,
    store,
    gateway,
    serverInfo: {
      serverId: loadServerId(ownHome),
      serverName: () => name,
      dshVersion: '0.0.0-peer-pause-resume',
      fingerprints: () => ({}),
      plugins: () => ({}),
    },
    heartbeatMs: 300,
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
    udpProbe: udpProbe ?? { primaryPort: gw.udp.primaryPort, altPort: gw.udp.altPort ?? 0 },
    punch: { punchWindowMs: 1000, punchIntervalMs: 100, punchRounds: 10, reprobeIntervalMs: 60_000 },
    log: (line) => logs.push(line),
  })

  return {
    name,
    identity,
    home: ownHome,
    stateFile,
    store,
    relayHandler,
    relayPool,
    engine,
    logs,
    listResults,
    set invokeImpl(fn) { invokeImpl = fn },
    stop: () => {
      engine.stop()
      relayPool.stop()
      try { punchSocket.close() } catch { /* gone */ }
    },
  }
}

/** 等本节点把远端 peer 挂载为在线虚拟服务端条目。 */
async function waitPeerOnline(node, peerNodeId, ms = 15000) {
  try {
    await waitFor(() => {
      const entry = node.relayPool.getByServerId(peerNodeId)
      return entry !== undefined && entry.client.state === 'online'
    }, ms, `${node.name} → ${peerNodeId} virtual entry online`)
  } catch (err) {
    const entry = node.relayPool.getByServerId(peerNodeId)
    console.error(`[debug] ${node.name} logs:\n  ${node.logs.join('\n  ')}`)
    console.error(`[debug] ${node.name} entry=${JSON.stringify(entry && { state: entry.client.state, lastError: entry.client.lastError, serverId: entry.serverId })}`)
    throw err
  }
  return node.relayPool.getByServerId(peerNodeId)
}

// ---------------------------------------------------------------- 用例

test('PC-03 #1: 真实 REST pause → resume，同连接原地恢复挂载与会话读取', async () => {
  const gw = await startGateway()
  const net = await createNetwork(gw, { mode: 'both' })
  const nodes = []
  try {
    const A = await startNode(gw, { name: 'node-a', shared: ['s-a1'] })
    const B = await startNode(gw, { name: 'node-b' })
    nodes.push(A, B)

    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await waitFor(() => A.engine.status().gatewayState === 'authorized', 8000, 'A authorized')
    await B.engine.joinNetwork(inviteUri(gw, net.id, undefined))
    await waitFor(() => B.engine.status().gatewayState === 'pending-approval', 8000, 'B pending')
    const approveRes = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${B.identity.nodeId}/approve`, { cookie: gw.tenantCookie })
    assert.equal(approveRes.status, 200, JSON.stringify(approveRes.json))
    await waitFor(() => B.engine.status().gatewayState === 'authorized', 8000, 'B authorized')

    const virtualAonB = await waitPeerOnline(B, A.identity.nodeId)
    await waitPeerOnline(A, B.identity.nodeId)
    A.listResults.set('*', { items: [{ sessionId: 's-a1', title: SESSION_TITLE }] })
    const listed = await virtualAonB.client.invoke('session', 'list', { request: {} })
    assert.equal(listed.items[0].sessionId, 's-a1', '暂停前会话读取正常')

    // —— pause：业务即刻停止 ——
    const pauseRes = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${B.identity.nodeId}/pause`, { cookie: gw.tenantCookie })
    assert.equal(pauseRes.status, 200, JSON.stringify(pauseRes.json))
    await waitFor(() => B.engine.status().gatewayState === 'paused', 3000, 'B paused')
    await waitFor(() => A.relayPool.getByServerId(B.identity.nodeId) === undefined, 3000, 'A unmounted B')
    await waitFor(() => B.relayPool.getByServerId(A.identity.nodeId) === undefined, 3000, 'B unmounted A')
    const topo = await getTopology(gw, net.id)
    assert.equal(topo.summary.onlineDevices, 1)
    assert.equal(topo.members.find((m) => m.nodeId === B.identity.nodeId).status, 'paused')
    assert.equal(topo.members.find((m) => m.nodeId === B.identity.nodeId).online, false)

    // 重复 pause 幂等：状态一致、不短暂恢复业务
    const pause2 = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${B.identity.nodeId}/pause`, { cookie: gw.tenantCookie })
    assert.equal(pause2.status, 200, JSON.stringify(pause2.json))
    await sleep(300)
    assert.equal(B.engine.status().gatewayState, 'paused')
    assert.equal(A.relayPool.getByServerId(B.identity.nodeId), undefined, '重复 pause 后 B 仍未被 A 挂载')

    // —— resume：原地恢复（2.5s 截止内完成授权恢复与重挂载），不重贴邀请、不重启节点 ——
    const resumeRes = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${B.identity.nodeId}/resume`, { cookie: gw.tenantCookie })
    assert.equal(resumeRes.status, 200, JSON.stringify(resumeRes.json))
    await waitFor(() => B.engine.status().gatewayState === 'authorized', 2500, 'B back to authorized after resume')
    await waitFor(() => A.engine.status().peers.some((p) => p.nodeId === B.identity.nodeId && p.mounted), 2500, 'A remounted B within 2s')
    const virtualAonB2 = await waitPeerOnline(B, A.identity.nodeId, 2500)
    const listed2 = await virtualAonB2.client.invoke('session', 'list', { request: {} })
    assert.equal(listed2.items[0].sessionId, 's-a1', 'resume 后会话读取恢复')
    const topo2 = await getTopology(gw, net.id)
    assert.equal(topo2.summary.onlineDevices, 2)
    assert.equal(topo2.members.find((m) => m.nodeId === B.identity.nodeId).online, true)
  } catch (err) {
    for (const node of nodes) console.error(`[dbg ${node.name}]`, node.logs.join(' | '))
    throw err
  } finally {
    for (const node of nodes) node.stop()
    await gw.close()
  }
})

/** A（共享 s-a1）+ B 双节点互通就绪；返回 B 挂载 A 的虚拟条目。 */
async function setupInteroperatingPair(gw, net) {
  const A = await startNode(gw, { name: 'node-a', shared: ['s-a1'] })
  const B = await startNode(gw, { name: 'node-b' })
  await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
  await waitFor(() => A.engine.status().gatewayState === 'authorized', 8000, 'A authorized')
  await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
  await waitFor(() => B.engine.status().gatewayState === 'authorized', 8000, 'B authorized')
  const virtualAonB = await waitPeerOnline(B, A.identity.nodeId)
  await waitPeerOnline(A, B.identity.nodeId)
  A.listResults.set('*', { items: [{ sessionId: 's-a1', title: SESSION_TITLE }] })
  return { A, B, virtualAonB }
}

async function pauseMember(gw, net, nodeId) {
  const res = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${nodeId}/pause`, { cookie: gw.tenantCookie })
  assert.equal(res.status, 200, JSON.stringify(res.json))
}

async function resumeMember(gw, net, nodeId) {
  const res = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${nodeId}/resume`, { cookie: gw.tenantCookie })
  assert.equal(res.status, 200, JSON.stringify(res.json))
}

test('PC-03 #2: 暂停期间节点重启——受限重连等待 resume，恢复后无需重新入网', async () => {
  const gw = await startGateway()
  const net = await createNetwork(gw, { mode: 'key' })
  const nodes = []
  try {
    const { A, B } = await setupInteroperatingPair(gw, net)
    nodes.push(A, B)

    await pauseMember(gw, net, B.identity.nodeId)
    await waitFor(() => B.engine.status().gatewayState === 'paused', 3000, 'B paused')
    await waitFor(() => A.relayPool.getByServerId(B.identity.nodeId) === undefined, 3000, 'A unmounted B')

    // 节点重启：同一 state 文件与身份，resumeFromState 走 PG-9 自动恢复序列
    const home = B.home
    B.stop()
    const B2 = await startNode(gw, { name: 'node-b', home })
    nodes.push(B2)
    assert.equal(B2.engine.resumeFromState(), true)
    await waitFor(() => B2.engine.status().gatewayState === 'paused', 8000, 'restarted B re-held as paused')
    assert.equal(B2.relayPool.getByServerId(A.identity.nodeId), undefined, '挂起期无业务挂载')
    const topo = await getTopology(gw, net.id)
    assert.equal(topo.summary.onlineDevices, 1)
    assert.equal(topo.members.find((m) => m.nodeId === B2.identity.nodeId).status, 'paused')

    await resumeMember(gw, net, B2.identity.nodeId)
    await waitFor(() => B2.engine.status().gatewayState === 'authorized', 2500, 'restarted B authorized after resume')
    const virtualAonB2 = await waitPeerOnline(B2, A.identity.nodeId, 2500)
    const listed = await virtualAonB2.client.invoke('session', 'list', { request: {} })
    assert.equal(listed.items[0].sessionId, 's-a1', '恢复后会话读取正常')
  } catch (err) {
    for (const node of nodes) console.error(`[dbg ${node.name}]`, node.logs.join(' | '))
    throw err
  } finally {
    for (const node of nodes) node.stop()
    await gw.close()
  }
})

test('PC-03 #3: 暂停后删除成员——连接被拒，迟到 resume 不重新挂载', async () => {
  const gw = await startGateway()
  const net = await createNetwork(gw, { mode: 'key' })
  const nodes = []
  try {
    const { A, B } = await setupInteroperatingPair(gw, net)
    nodes.push(A, B)

    await pauseMember(gw, net, B.identity.nodeId)
    await waitFor(() => B.engine.status().gatewayState === 'paused', 3000, 'B paused')

    const delRes = await api(gw.base, 'DELETE', `/api/v1/networks/${net.id}/members/${B.identity.nodeId}`, { cookie: gw.tenantCookie })
    assert.equal(delRes.status, 200, JSON.stringify(delRes.json))
    await waitFor(() => B.engine.status().gatewayState === 'revoked', 3000, 'B revoked after delete')
    await waitFor(async () => (await getTopology(gw, net.id)).members.every((m) => m.nodeId !== B.identity.nodeId), 3000, 'B gone from topology')

    // 迟到的 resume：成员已删除，REST 404，什么也不恢复
    const lateResume = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${B.identity.nodeId}/resume`, { cookie: gw.tenantCookie })
    assert.equal(lateResume.status, 404, JSON.stringify(lateResume.json))
    await sleep(500)
    assert.equal(B.engine.status().gatewayState, 'revoked', '删除成员不被迟到的恢复消息重新拉起')
    assert.equal(A.relayPool.getByServerId(B.identity.nodeId), undefined, 'A 不重新挂载已删除成员')
    assert.equal(A.engine.status().peers.some((p) => p.nodeId === B.identity.nodeId), false)
  } catch (err) {
    for (const node of nodes) console.error(`[dbg ${node.name}]`, node.logs.join(' | '))
    throw err
  } finally {
    for (const node of nodes) node.stop()
    await gw.close()
  }
})

test('PC-03 #4: 离线期间 resume——重连后按最新持久授权直接放行', async () => {
  const gw = await startGateway()
  const net = await createNetwork(gw, { mode: 'key' })
  const nodes = []
  try {
    const { A, B } = await setupInteroperatingPair(gw, net)
    nodes.push(A, B)

    await pauseMember(gw, net, B.identity.nodeId)
    await waitFor(() => B.engine.status().gatewayState === 'paused', 3000, 'B paused')

    // B 离线后管理员才 resume（钩子找不到挂起连接，只刷拓扑）
    const home = B.home
    B.stop()
    await resumeMember(gw, net, B.identity.nodeId)
    const topoOffline = await getTopology(gw, net.id)
    assert.equal(topoOffline.members.find((m) => m.nodeId === B.identity.nodeId).status, 'authorized')

    // B 重启回来：auth 时按最新授权直接放行，不经历暂停挂起
    const B2 = await startNode(gw, { name: 'node-b', home })
    nodes.push(B2)
    assert.equal(B2.engine.resumeFromState(), true)
    await waitFor(() => B2.engine.status().gatewayState === 'authorized', 8000, 'restarted B authorized directly')
    await waitPeerOnline(B2, A.identity.nodeId, 8000)
    await waitPeerOnline(A, B2.identity.nodeId, 8000)
    const virtualAonB = await waitPeerOnline(B2, A.identity.nodeId)
    const listed = await virtualAonB.client.invoke('session', 'list', { request: {} })
    assert.equal(listed.items[0].sessionId, 's-a1')
  } catch (err) {
    for (const node of nodes) console.error(`[dbg ${node.name}]`, node.logs.join(' | '))
    throw err
  } finally {
    for (const node of nodes) node.stop()
    await gw.close()
  }
})

test('PC-03 #5: resume 沿同一 WS 重建授权后，必要的 STUN 重探发生（同 socket、暂停前在途结果作废）', async () => {
  const gw = await startGateway({ withStun: false })
  // fake 探测汇：记录每条探测的 nodeId 与源端口（探测出自打洞 socket，
  // 源端口一致即「同一 socket 持续承载探测」）
  const probes = []
  const listener = await openUdp()
  listener.on('message', (buf, rinfo) => {
    try {
      const msg = JSON.parse(buf.toString('utf8'))
      if (msg.type === 'stun-probe') probes.push({ nodeId: msg.nodeId, srcPort: rinfo.port })
    } catch { /* 非 JSON 探测帧忽略 */ }
  })
  let B = null
  try {
    const net = await createNetwork(gw, { mode: 'key' })
    B = await startNode(gw, {
      name: 'node-b',
      udpProbe: { primaryPort: listener.address().port, altPort: 0 },
    })
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey))
    await waitFor(() => B.engine.status().gatewayState === 'authorized', 8000, 'B authorized')
    await waitFor(() => probes.length >= 1, 8000, 'initial STUN probe')
    const first = probes[0]
    assert.equal(first.nodeId, B.identity.nodeId)

    await pauseMember(gw, net, B.identity.nodeId)
    await waitFor(() => B.engine.status().gatewayState === 'paused', 3000, 'B paused')
    await resumeMember(gw, net, B.identity.nodeId)
    await waitFor(() => B.engine.status().gatewayState === 'authorized', 2500, 'B authorized after resume')
    // 同一条 WS 恢复授权后重探发生（PC-01b 的「同连接重复 welcome 不重探」
    // 闸不被误挡——暂停换代使旧值失效）
    await waitFor(() => probes.length >= 2, 4000, 're-probe after resume on the same connection')
    assert.equal(probes[1].nodeId, B.identity.nodeId)
    assert.equal(probes[1].srcPort, first.srcPort, '重探出自同一条打洞 socket（连接未被重建）')
  } catch (err) {
    if (B !== null) console.error(`[dbg node-b]`, B.logs.join(' | '))
    throw err
  } finally {
    if (B !== null) B.stop()
    listener.close()
    await gw.close()
  }
})
