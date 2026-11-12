/* dsh-zen-remote · PC-01b 节点生产入口启用 STUN。
 *
 * 两层正常功能验证（无攻击 PoC / 渗透 / 利用链）：
 *
 *   生产接线（真实组装）：经 gateway-server 的 startGateway 组装完整网关
 *   （welcome 带 PC-01a 的真实 UDP bind 端口），两台真实 PeerEngine **不传
 *   udpProbe**（生产缺省路径）入网——断言探测真的发生（引擎 NAT 自查完成、
 *   网关侧登记反射端点）、直连形成且可用。节点打洞 socket 绑定 127.0.0.1，
 *   令反射端点成为唯一可达候选——直连成立本身就证明 welcome→探测→反射登记
 *   这条链路通了（lanEndpoints 全是非回环地址，绑回环的 socket 收不到）。
 *
 *   引擎边界（fake WS 网关 + 可控 UDP listener）：welcome 缺字段/形状坏的
 *   明确降级（unknown，零发包，不异常逃逸）；显式 udpProbe 的关闭/覆盖语义
 *   不被新路径翻转；探测生命周期跟随网关连接代次——断开重连即新连接，重新
 *   探测登记反射端点、读取本次 welcome 端口，同连接重复 welcome 不重发；
 *   旧连接在途探测的迟到结果不写进重连后的状态；换网/leave/stop 的既有
 *   保护保持。
 *
 * 全部用临时目录（.scratch/pc-01b）、随机身份与回环端口；不触碰真实 DSH。
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const dgram = require('node:dgram')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createHash } = require('node:crypto')

// 主仓（编译产物）
const { createPeerEngine } = require('../lib/peer/engine.js')
const { ensurePeerIdentity, writePeerNetwork } = require('../lib/state-store.js')
const { createShareStore } = require('../lib/share-store.js')
const { createRelayHandler, loadServerId } = require('../lib/relay-server.js')
const { createRelayPool } = require('../lib/relay-pool.js')
// gateway-server（独立包编译产物）——生产组装根，welcome 自带真实 stun 端口
const { startGateway } = require('../gateway-server/dist/main.js')

const SCRATCH = path.join(__dirname, '..', '.scratch', 'pc-01b')
fs.mkdirSync(SCRATCH, { recursive: true })
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }) } catch { /* best effort */ } })

const SECRET = 'pc-01b-production-stun-relay-secret-0123456789abcdef'.slice(0, 48)
const ADMIN_EMAIL = 'admin@pc-01b'
const ADMIN_PASSWORD = 'admin-pc-01b-pass'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function eventually(predicate, ms = 1500, what = 'condition') {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > ms) throw new Error(`eventually timeout: ${what}`)
    await sleep(25)
  }
}
async function waitFor(predicate, ms = 8000, what = 'condition') {
  return eventually(predicate, ms, what)
}
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex')

// ---------------------------------------------------------------- 引擎边界夹具

/** 服务端→客户端的未掩码 WS 帧（0x81 + 16 位长度，welcome 尺寸足够）。 */
function frame(value) {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(body.length, 2)
  return Buffer.concat([header, body])
}

/** 最小 fake WS 网关：每次 upgrade 回 101 后下发 `welcome`（逐测试可换），
 * 忽略客户端一切非 close 帧。引擎不校验 welcome 签名，授权态由消息驱动。 */
async function startFakeGateway() {
  const sockets = []
  let welcome = null
  let upgrades = 0
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    upgrades += 1
    sockets.push(socket)
    socket.on('error', () => {})
    socket.on('data', (data) => {
      if ((data[0] & 15) === 8) socket.end(Buffer.from([0x88, 0]))
    })
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`))
    if (welcome !== null) socket.write(frame(welcome))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const close = async () => {
    for (const socket of sockets.splice(0)) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
  return {
    port: server.address().port,
    set welcome(value) { welcome = value },
    /** 已发生的 WS 握手（upgrade）次数——断言「真实新握手」用。 */
    upgradeCount: () => upgrades,
    /** 断开当前连接（重连语义测试用）。 */
    dropCurrentConnection() {
      const socket = sockets.at(-1)
      if (socket !== undefined) socket.destroy()
    },
    /** 向当前连接再下发一次 welcome（同连接重复授权场景）。 */
    resendWelcome() {
      const socket = sockets.at(-1)
      if (socket !== undefined && welcome !== null) socket.write(frame(welcome))
    },
    close,
  }
}

/** 可控 UDP listener：记录收到的探测包；`replyNonce` 让测试决定何时对哪个
 * nonce 回一份合法形状的 stun-reply（reflexive 全部指向回环）。 */
async function startProbeListener() {
  const packets = []
  const sock = dgram.createSocket('udp4')
  sock.on('message', (buf, rinfo) => {
    let parsed = null
    try { parsed = JSON.parse(buf.toString('utf8')) } catch { /* 非JSON不算探测 */ }
    packets.push({ parsed, rinfo })
  })
  await new Promise((resolve, reject) => {
    sock.once('error', reject)
    sock.bind(0, '127.0.0.1', () => { sock.removeAllListeners('error'); resolve() })
  })
  const replyNonce = (nonce, reflexivePort = 40000) => {
    const hit = packets.find((p) => p.parsed !== null && p.parsed.type === 'stun-probe' && p.parsed.nonce === nonce)
    if (hit === undefined) return false
    const reply = Buffer.from(JSON.stringify({
      type: 'stun-reply',
      nonce,
      reflexiveIp: '127.0.0.1',
      reflexivePort,
      serverPortRole: 'primary',
    }))
    sock.send(reply, hit.rinfo.port, hit.rinfo.address, () => {})
    return true
  }
  const close = async () => new Promise((resolve) => sock.close(() => resolve()))
  return { port: sock.address().port, packets, replyNonce, close }
}

/** 边界测试用的裸节点：fake 中继池（无 peer 挂载需求）+ 无 udpProbe 注入
 * （生产缺省路径），状态先落盘再 resumeFromState。 */
async function startBareNode(gateway, { udpProbe } = {}) {
  const home = path.join(SCRATCH, `bare-${randomHex(4)}`)
  fs.mkdirSync(home, { recursive: true })
  const stateFile = path.join(home, 'zen-remote-state.json')
  const identity = ensurePeerIdentity(stateFile)
  const networkId = randomHex(8)
  writePeerNetwork(stateFile, {
    gatewayWsUrl: `ws://127.0.0.1:${gateway.port}`,
    gatewayHttpOrigin: `http://127.0.0.1:${gateway.port}`,
    networkId,
    joinedAt: 1,
  })
  const logs = []
  const engine = createPeerEngine({
    stateFile,
    identity,
    relayPool: { maxServers: () => 8 },
    relayHandler: () => undefined,
    relaySecret: () => 'test',
    serverName: () => 'bare',
    ...(udpProbe === undefined ? {} : { udpProbe }),
    log: (line) => logs.push(line),
  })
  engine.resumeFromState()
  return { engine, logs, networkId, stop: () => engine.stop() }
}

const authorizedWelcome = (extra = {}) => ({ type: 'welcome', status: 'authorized', maxPeers: 8, peers: [], ...extra })

// ---------------------------------------------------------------- 引擎边界用例

test('PC-01b: 旧网关 welcome 无 stun 字段 → 明确降级 unknown，零发包，不异常逃逸', async (t) => {
  const gateway = await startFakeGateway()
  const listener = await startProbeListener()
  t.after(async () => { await listener.close(); await gateway.close() })
  gateway.welcome = authorizedWelcome() // 无 stun —— PC-01a 之前的网关形态
  const node = await startBareNode(gateway)
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  // 明确降级：探测没跑，但状态是"查过、未知"，不是 null（从未探测）
  await eventually(() => node.engine.status().natType === 'unknown', 1500, 'degraded to unknown')
  await sleep(250)
  assert.equal(listener.packets.length, 0, '缺字段绝不发探测包')
  assert.ok(node.logs.some((l) => /stun/i.test(l)), '降级要留日志线索')
})

for (const bad of [
  ['字符串', 'x'],
  ['数字', 42],
  ['数组', []],
  ['空对象', {}],
  ['主口为 0', { primaryPort: 0 }],
  ['主口超界', { primaryPort: 70000 }],
  ['主口非整数', { primaryPort: 8080.5 }],
  ['主口为字符串', { primaryPort: '8080' }],
  ['辅助口为 0', { primaryPort: 8080, altPort: 0 }],
  ['辅助口为字符串', { primaryPort: 8080, altPort: 'x' }],
  ['辅助口超界', { primaryPort: 8080, altPort: 70000 }],
  ['辅助口非整数', { primaryPort: 8080, altPort: 8080.5 }],
]) {
  test(`PC-01b: welcome stun 形状坏（${bad[0]}）→ 降级 unknown 且零发包`, async (t) => {
    const gateway = await startFakeGateway()
    const listener = await startProbeListener()
    t.after(async () => { await listener.close(); await gateway.close() })
    gateway.welcome = authorizedWelcome({ stun: bad[1] })
    const node = await startBareNode(gateway)
    t.after(() => node.stop())

    await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
    await eventually(() => node.engine.status().natType === 'unknown', 1500, `degraded to unknown (${bad[0]})`)
    await sleep(250)
    assert.equal(listener.packets.length, 0, `形状坏（${bad[0]}）绝不发探测包`)
  })
}

test('PC-01b: 显式 udpProbe:null 优先于 welcome —— 关闭语义不被新路径翻转', async (t) => {
  const gateway = await startFakeGateway()
  const listener = await startProbeListener()
  t.after(async () => { await listener.close(); await gateway.close() })
  gateway.welcome = authorizedWelcome({ stun: { primaryPort: listener.port, altPort: null } })
  const node = await startBareNode(gateway, { udpProbe: null })
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  await sleep(300)
  assert.equal(listener.packets.length, 0, '显式关闭时不探测')
  assert.equal(node.engine.status().natType, null, '显式关闭保持"从未探测"（null），不是 unknown')
})

test('PC-01b: 显式 udpProbe 对象覆盖 welcome 端口 —— 覆盖语义不被新路径翻转', async (t) => {
  const gateway = await startFakeGateway()
  const explicitListener = await startProbeListener()
  const welcomeListener = await startProbeListener()
  t.after(async () => {
    await welcomeListener.close()
    await explicitListener.close()
    await gateway.close()
  })
  gateway.welcome = authorizedWelcome({ stun: { primaryPort: welcomeListener.port, altPort: null } })
  const node = await startBareNode(gateway, { udpProbe: { primaryPort: explicitListener.port, altPort: 0 } })
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  await eventually(() => explicitListener.packets.length >= 1, 1500, 'explicit port receives the probe')
  await sleep(250)
  assert.equal(welcomeListener.packets.length, 0, 'welcome 端口不被使用')
  const probe = explicitListener.packets[0].parsed
  assert.equal(probe.type, 'stun-probe', '发的是签名探测包')
  assert.equal(probe.networkId, node.networkId, '探测网络与入网一致')
})

test('PC-01b: 生产缺省（不传 udpProbe）从 authorized welcome 的 stun 端口探测', async (t) => {
  const gateway = await startFakeGateway()
  const listener = await startProbeListener()
  t.after(async () => { await listener.close(); await gateway.close() })
  gateway.welcome = authorizedWelcome({ stun: { primaryPort: listener.port, altPort: null } })
  const node = await startBareNode(gateway)
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  await eventually(() => listener.packets.length >= 1, 1500, 'welcome port receives the probe')
  const probe = listener.packets[0].parsed
  assert.equal(probe.type, 'stun-probe', '发的是签名探测包')
  assert.equal(probe.networkId, node.networkId, '探测网络与入网一致')
})

test('PC-01b/fix1: WS断开→真实新握手→按本次welcome重新探测；同连接重复welcome不重发', async (t) => {
  const gateway = await startFakeGateway()
  const listener = await startProbeListener()
  t.after(async () => { await listener.close(); await gateway.close() })
  gateway.welcome = authorizedWelcome({ stun: { primaryPort: listener.port, altPort: null } })
  const node = await startBareNode(gateway)
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  await eventually(() => listener.packets.length >= 1, 1500, 'first probe')
  const nonce1 = listener.packets[0].parsed.nonce
  // 断开 → 必须先观察到 close（offline），再等新握手后的 authorized——
  // 不许 drop 后立刻匹配旧 authorized 而虚假通过。
  gateway.dropCurrentConnection()
  await eventually(() => node.engine.status().gatewayState === 'offline', 1500, 'close observed (offline)')
  await eventually(() => node.engine.status().gatewayState === 'authorized', 5000, 're-authorized after reconnect')
  assert.equal(gateway.upgradeCount(), 2, '重连是真实的新握手')
  // 新连接代次：网关侧是全新 ConnState（reflexive 置 null），必须重新探测登记
  await eventually(() => listener.packets.length >= 2, 1500, 're-probe on the new connection')
  assert.notEqual(listener.packets[1].parsed.nonce, nonce1, '重连后是全新的一次探测')
  // 同一连接上重复下发 authorized welcome：不重发探测
  gateway.resendWelcome()
  await sleep(300)
  assert.equal(listener.packets.length, 2, '同连接重复welcome不重复探测')
})

test('PC-01b/fix1: 旧网关缺字段降级后，重连拿到有效端口即恢复探测', async (t) => {
  const gateway = await startFakeGateway()
  const listener = await startProbeListener()
  t.after(async () => { await listener.close(); await gateway.close() })
  gateway.welcome = authorizedWelcome() // 旧网关：无 stun
  const node = await startBareNode(gateway)
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  await eventually(() => node.engine.status().natType === 'unknown', 1500, 'degraded to unknown')
  await sleep(200)
  assert.equal(listener.packets.length, 0, '缺字段时不探测')
  // 网关升级为带 stun 的形态：重连后的 welcome 带有效端口 → 必须恢复探测
  gateway.welcome = authorizedWelcome({ stun: { primaryPort: listener.port, altPort: null } })
  gateway.dropCurrentConnection()
  await eventually(() => node.engine.status().gatewayState === 'offline', 1500, 'close observed (offline)')
  await eventually(() => node.engine.status().gatewayState === 'authorized', 5000, 're-authorized')
  assert.equal(gateway.upgradeCount(), 2, '真实新握手')
  await eventually(() => listener.packets.length >= 1, 1500, 'probe resumed with the new welcome ports')
})

test('PC-01b/fix1: 重连后读取新welcome端口——网关换UDP端口即改射新口', async (t) => {
  const gateway = await startFakeGateway()
  const listener1 = await startProbeListener()
  const listener2 = await startProbeListener()
  t.after(async () => {
    await listener2.close()
    await listener1.close()
    await gateway.close()
  })
  gateway.welcome = authorizedWelcome({ stun: { primaryPort: listener1.port, altPort: null } })
  const node = await startBareNode(gateway)
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  await eventually(() => listener1.packets.length >= 1, 1500, 'probe to the first port')
  // 网关重启换了 UDP 端口：重连后的 welcome 发布新端口
  gateway.welcome = authorizedWelcome({ stun: { primaryPort: listener2.port, altPort: null } })
  gateway.dropCurrentConnection()
  await eventually(() => node.engine.status().gatewayState === 'offline', 1500, 'close observed (offline)')
  await eventually(() => node.engine.status().gatewayState === 'authorized', 5000, 're-authorized')
  await eventually(() => listener2.packets.length >= 1, 1500, 'probe follows the NEW welcome port')
  assert.equal(listener1.packets.length, 1, '旧端口不再收到新探测')
})

test('PC-01b/fix1: 旧连接在途探测的迟到结果不写进重连后的状态', async (t) => {
  const gateway = await startFakeGateway()
  const primaryListener = await startProbeListener()
  const altListener = await startProbeListener()
  t.after(async () => {
    await altListener.close()
    await primaryListener.close()
    await gateway.close()
  })
  gateway.welcome = authorizedWelcome({ stun: { primaryPort: primaryListener.port, altPort: altListener.port } })
  const node = await startBareNode(gateway)
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  await eventually(
    () => primaryListener.packets.length >= 1 && altListener.packets.length >= 1,
    1500,
    'probe #1 in flight on both ports',
  )
  const stalePrimary = primaryListener.packets[0].parsed.nonce
  const staleAlt = altListener.packets[0].parsed.nonce
  // 连接断开（在途探测未回包）→ 重连 → 新连接代次重新探测（同样不回包）
  gateway.dropCurrentConnection()
  await eventually(() => node.engine.status().gatewayState === 'offline', 1500, 'close observed (offline)')
  await eventually(() => node.engine.status().gatewayState === 'authorized', 5000, 're-authorized')
  await eventually(
    () => primaryListener.packets.length >= 2 && altListener.packets.length >= 2,
    2000,
    'probe #2 on the new connection',
  )
  // 旧探测先过 2s 截止（无回包 → unknown）：新连接的结论只能来自新探测
  await eventually(() => node.engine.status().natType === 'unknown', 6000, 'fresh connection probe deadline')
  // 此刻才放行旧探测的迟到回包（两端口反射不同 → 会判 symmetric）：必须被丢弃
  primaryListener.replyNonce(stalePrimary, 43000)
  altListener.replyNonce(staleAlt, 44000)
  await sleep(500)
  assert.equal(node.engine.status().natType, 'unknown', '旧连接的迟到结果不落地')
})

test('PC-01b/fix1: 显式 udpProbe 对象同样跟随连接代次——重连后重探', async (t) => {
  const gateway = await startFakeGateway()
  const listener = await startProbeListener()
  t.after(async () => { await listener.close(); await gateway.close() })
  gateway.welcome = authorizedWelcome()
  const node = await startBareNode(gateway, { udpProbe: { primaryPort: listener.port, altPort: 0 } })
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  await eventually(() => listener.packets.length >= 1, 1500, 'first probe (explicit port)')
  gateway.dropCurrentConnection()
  await eventually(() => node.engine.status().gatewayState === 'offline', 1500, 'close observed (offline)')
  await eventually(() => node.engine.status().gatewayState === 'authorized', 5000, 're-authorized')
  await eventually(() => listener.packets.length >= 2, 1500, 'explicit port re-probes after reconnect')
})

test('PC-01b: leaveNetwork 后迟到的探测结果不落地（异步过期防护）', async (t) => {
  const gateway = await startFakeGateway()
  const listener = await startProbeListener()
  t.after(async () => { await listener.close(); await gateway.close() })
  gateway.welcome = authorizedWelcome()
  // 受控显式路径驱动在途探测（防护逻辑与端口来源无关）
  const node = await startBareNode(gateway, { udpProbe: { primaryPort: listener.port, altPort: 0 } })
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  await eventually(() => listener.packets.length >= 1, 1500, 'probe in flight')
  node.engine.leaveNetwork()
  assert.equal(node.engine.status().natType, null, 'leave 即清探测状态')
  listener.replyNonce(listener.packets[0].parsed.nonce)
  // 在途探测的结论最迟在发出后 2s 截止时产生（socket 已随 leave 关闭，回包
  // 送不进去，deadline 路径照样会得出 unknown）——必须等过截止再断言不落地。
  await sleep(2300)
  assert.equal(node.engine.status().natType, null, '迟到结果不落地')
})

test('PC-01b: stop 后迟到的探测结果不落地（异步过期防护）', async (t) => {
  const gateway = await startFakeGateway()
  const listener = await startProbeListener()
  t.after(async () => { await listener.close(); await gateway.close() })
  gateway.welcome = authorizedWelcome()
  const node = await startBareNode(gateway, { udpProbe: { primaryPort: listener.port, altPort: 0 } })
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  await eventually(() => listener.packets.length >= 1, 1500, 'probe in flight')
  node.engine.stop()
  listener.replyNonce(listener.packets[0].parsed.nonce)
  // 同上：等过在途探测的 2s 截止，deadline 路径的过期结论也不得落地。
  await sleep(2300)
  assert.equal(node.engine.status().natType, null, 'stop 后迟到结果不落地')
})

test('PC-01b: 换网重入网 —— 旧探测过期丢弃，新 welcome 重新探测且结果生效', async (t) => {
  const gateway = await startFakeGateway()
  const primaryListener = await startProbeListener()
  const altListener = await startProbeListener()
  t.after(async () => {
    await altListener.close()
    await primaryListener.close()
    await gateway.close()
  })
  gateway.welcome = authorizedWelcome()
  const node = await startBareNode(gateway, {
    udpProbe: { primaryPort: primaryListener.port, altPort: altListener.port },
  })
  t.after(() => node.stop())

  await eventually(() => node.engine.status().gatewayState === 'authorized', 2000, 'authorized')
  await eventually(() => primaryListener.packets.length >= 1 && altListener.packets.length >= 1, 1500, 'first probe on both ports')

  // 换网：joinNetwork 重置会话（epoch 变更、punch socket 重建）。旧探测的两个
  // 迟到回包会把它判成别的结果——必须被丢弃，不得覆盖新探测的结论。
  const stalePrimary = primaryListener.packets[0].parsed.nonce
  const staleAlt = altListener.packets[0].parsed.nonce
  const newNetworkId = randomHex(8)
  await node.engine.joinNetwork(
    `zr-net+insecure://127.0.0.1:${gateway.port}/${newNetworkId}#rejoin-key`,
  )
  await eventually(() => node.engine.status().gatewayState === 'authorized', 3000, 're-authorized on the new network')
  // 新探测（新 punch socket 的新包）
  await eventually(() => {
    const freshPrimary = primaryListener.packets.find((p) => p.parsed.nonce !== stalePrimary)
    const freshAlt = altListener.packets.find((p) => p.parsed.nonce !== staleAlt)
    return freshPrimary !== undefined && freshAlt !== undefined
  }, 2000, 'fresh probe after rejoin')
  const freshPrimary = primaryListener.packets.find((p) => p.parsed.nonce !== stalePrimary)
  const freshAlt = altListener.packets.find((p) => p.parsed.nonce !== staleAlt)
  primaryListener.replyNonce(freshPrimary.parsed.nonce, 41000)
  altListener.replyNonce(freshAlt.parsed.nonce, 41000)
  await eventually(() => node.engine.status().natType === 'public', 2000, 'fresh probe result applied')
  // 旧探测此刻已过 2s 截止（无回包）——它的过期结论（unknown）在两种实现里
  // 都会在此刻产生：防护实现丢弃，裸实现覆盖。等过截止再断言。
  primaryListener.replyNonce(stalePrimary, 42000)
  altListener.replyNonce(staleAlt, 42000)
  await sleep(2300)
  assert.equal(node.engine.status().natType, 'public', '换网后旧探测的迟到结果被丢弃')
})

// ---------------------------------------------------------------- 生产接线用例

/** 占住一个 UDP 端口立刻释放，拿内核刚分配过的空闲端口号给 udpAltPort 用。 */
async function reserveUdpPort() {
  const sock = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    sock.once('error', reject)
    sock.bind(0, '127.0.0.1', () => { sock.removeAllListeners('error'); resolve() })
  })
  const port = sock.address().port
  await new Promise((resolve) => sock.close(() => resolve()))
  return port
}

/** 一个绑定好的回环 udp4 socket（打洞 socket 注入缝：反射端点之外的
 * lanEndpoints 候选对它全部不可达，直连成立即可证明反射端点接线完成）。 */
function openLoopbackUdp() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')
    sock.once('error', reject)
    sock.bind(0, '127.0.0.1', () => {
      sock.removeAllListeners('error')
      resolve(sock)
    })
  })
}

async function api(base, method, reqPath, { body, cookie } = {}) {
  const headers = {}
  if (cookie !== undefined) headers.cookie = cookie
  let payload
  if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['content-type'] = 'application/json'
    headers.origin = base
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

/** 生产形态节点：真实 RelayPool + RelayHandler + PeerEngine，唯一刻意之处
 * 是**不传 udpProbe**（生产缺省路径，本单受试对象）。 */
async function startProdNode(name, { shared = [] } = {}) {
  const home = path.join(SCRATCH, `prod-${name}-${randomHex(4)}`)
  fs.mkdirSync(home, { recursive: true })
  const stateFile = path.join(home, 'zen-remote-state.json')
  const identity = ensurePeerIdentity(stateFile)
  const punchSocket = await openLoopbackUdp()

  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  for (const id of shared) store.share(id)
  const sharedItems = shared.map((id) => ({ sessionId: id, title: `${name} 的 ${id}` }))
  const gateway = {
    invoke: async (call) => {
      if (call.namespace === 'session' && call.method === 'list') return { items: sharedItems }
      if (call.namespace === 'session' && call.method === 'modelCatalog') {
        return { default: null, routableProviders: [], groups: [], failures: [] }
      }
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
    stream: async (call) => {
      throw Object.assign(new Error(`no stream fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
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
      dshVersion: '0.0.0-pc01b',
      fingerprints: () => ({}),
      plugins: () => ({}),
    },
    heartbeatMs: 300,
  })
  const relayPool = createRelayPool({ stateFile, computeOwnFingerprints: () => ({}) })
  const logs = []
  const engine = createPeerEngine({
    stateFile,
    identity,
    relayPool,
    relayHandler: () => relayHandler,
    relaySecret: () => SECRET,
    serverName: () => name,
    udpSocket: punchSocket,
    punch: { punchWindowMs: 1000, punchIntervalMs: 100, punchRounds: 10, reprobeIntervalMs: 60_000 },
    log: (line) => logs.push(line),
    // （刻意不传 udpProbe —— 生产缺省从 welcome 读取）
  })
  return {
    name,
    identity,
    engine,
    relayPool,
    logs,
    stop: () => {
      engine.stop()
      relayPool.stop()
      try { punchSocket.close() } catch { /* gone */ }
    },
  }
}

/** 服务端精准断开某节点的网关 WS 连接（hub 内部连接表：ConnState.ws）。
 * PC-01a/PC-01b 的网关侧事实：新 ConnState 的 reflexive 为 null、STUN 准入
 * 绑定本次连接 token——断开后旧反射端点不再是新连接的事实。 */
function dropGatewayConn(hub, networkId, nodeId) {
  const conn = hub.conns?.get?.(networkId)?.get?.(nodeId)
  if (conn === undefined || conn?.ws === undefined) return false
  try { conn.ws.close() } catch { return false }
  return true
}

test('PC-01b/fix1 生产接线: WS断开重连后网关重新登记反射端点，后续节点无LAN候选仍直连', async (t) => {
  const dataDir = path.join(SCRATCH, `gw-${randomHex(4)}`)
  fs.mkdirSync(dataDir, { recursive: true })
  const gw = await startGateway({
    port: 0,
    udpAltPort: await reserveUdpPort(),
    publicUrl: undefined,
    dataDir,
    databaseUrl: undefined,
    adminUser: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    allowSignup: false,
    defaultMaxPeers: 8,
    maxNetworksPerUser: 3,
    relayRateKbps: 1024,
  })
  // 网关侧 NAT 登记观测点：每次 applyNatObservation 记一笔（重连接线证明用）
  const natCalls = []
  const origApplyNat = gw.hub.applyNatObservation.bind(gw.hub)
  gw.hub.applyNatObservation = (record) => { natCalls.push(record.nodeId); return origApplyNat(record) }
  const nodes = []
  t.after(async () => {
    for (const node of nodes.splice(0)) node.stop()
    await gw.close()
  })
  const cookie = await login(gw.base, ADMIN_EMAIL, ADMIN_PASSWORD)
  const netRes = await api(gw.base, 'POST', '/api/v1/networks', {
    body: { name: `net-pc01b-fix1-${randomHex(3)}`, admissionMode: 'key' },
    cookie,
  })
  assert.equal(netRes.status, 200, JSON.stringify(netRes.json))
  const net = netRes.json.data
  const invite = `zr-net+insecure://127.0.0.1:${gw.port}/${net.id}#${net.joinKey}`

  const A = await startProdNode('fix1-a')
  nodes.push(A)
  await A.engine.joinNetwork(invite)
  await eventually(() => A.engine.status().gatewayState === 'authorized', 8000, 'A authorized')
  await eventually(() => A.engine.status().natType === 'public', 8000, 'A natType public')
  assert.ok(natCalls.includes(A.identity.nodeId), '首次连接已登记反射端点')
  // 基线必须在断开前抓：重探极快，可能与「观察到重连完成」发生在同一拍
  const registrationsForA = () => natCalls.filter((id) => id === A.identity.nodeId).length
  const beforeDrop = registrationsForA()

  // 服务端断开 A 的连接 → 必须先观察到 offline（真实断开），再等重连 authorized
  assert.equal(dropGatewayConn(gw.hub, net.id, A.identity.nodeId), true, '服务端断开 A 的连接')
  await eventually(() => A.engine.status().gatewayState === 'offline', 2000, 'close observed (offline)')
  await eventually(() => A.engine.status().gatewayState === 'authorized', 6000, 're-authorized after reconnect')
  // 重连接线证明：新 ConnState 的 reflexive 是 null，网关重新登记必须来自
  // A 在新连接上的重新探测——不是旧连接的遗留事实
  await eventually(() => registrationsForA() >= beforeDrop + 1, 6000, 'gateway re-registered A on the NEW connection')

  // 后续节点加入：welcome/坐标带的是 A 重连后的新登记——无 LAN 可达候选
  // （打洞 socket 绑回环）仍恢复直连
  const B = await startProdNode('fix1-b')
  nodes.push(B)
  await B.engine.joinNetwork(invite)
  await eventually(() => B.engine.status().gatewayState === 'authorized', 8000, 'B authorized')
  await eventually(() => B.engine.status().natType === 'public', 8000, 'B natType public')
  await waitFor(() => {
    const peer = A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId)
    return peer !== undefined && (peer.path === 'lan' || peer.path === 'p2p')
  }, 15000, 'A↔B direct path after A reconnect')
  const abRtt = A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId).rttMs
  assert.equal(typeof abRtt, 'number', '重连后的直连会话有 RTT')
})

test('PC-01b 生产接线: 真实 startGateway 下发 stun 端口 → 缺省引擎完成探测、网关登记反射端点、直连形成且可用', async (t) => {
  const dataDir = path.join(SCRATCH, `gw-${randomHex(4)}`)
  fs.mkdirSync(dataDir, { recursive: true })
  const gw = await startGateway({
    port: 0,
    udpAltPort: await reserveUdpPort(),
    publicUrl: undefined,
    dataDir,
    databaseUrl: undefined,
    adminUser: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    allowSignup: false,
    defaultMaxPeers: 8,
    maxNetworksPerUser: 3,
    relayRateKbps: 1024,
  })
  const nodes = []
  t.after(async () => {
    for (const node of nodes.splice(0)) node.stop()
    await gw.close()
  })
  const cookie = await login(gw.base, ADMIN_EMAIL, ADMIN_PASSWORD)
  const netRes = await api(gw.base, 'POST', '/api/v1/networks', {
    body: { name: `net-pc01b-${randomHex(3)}`, admissionMode: 'key' },
    cookie,
  })
  assert.equal(netRes.status, 200, JSON.stringify(netRes.json))
  const net = netRes.json.data
  const invite = `zr-net+insecure://127.0.0.1:${gw.port}/${net.id}#${net.joinKey}`

  const A = await startProdNode('prod-a', { shared: ['s-a1'] })
  const B = await startProdNode('prod-b')
  nodes.push(A, B)
  await A.engine.joinNetwork(invite)
  await eventually(() => A.engine.status().gatewayState === 'authorized', 8000, 'A authorized')
  await B.engine.joinNetwork(invite)
  await eventually(() => B.engine.status().gatewayState === 'authorized', 8000, 'B authorized')

  // 1) 引擎侧 NAT 自查完成：welcome 双口都应答且回环反射 → 'public'
  //    （探测没跑时这里是 null —— 本用例的 RED 断言点）
  await eventually(() => A.engine.status().natType === 'public', 8000, 'A natType public')
  await eventually(() => B.engine.status().natType === 'public', 8000, 'B natType public')

  // 2) 网关侧反射端点登记：探测真的从打洞 socket 抵达双 UDP 口并被记录
  await waitFor(async () => {
    const topo = await api(gw.base, 'GET', `/api/v1/networks/${net.id}/topology`, { cookie })
    assert.equal(topo.status, 200)
    const rows = topo.json.data.members ?? []
    return [A, B].every((node) => {
      const row = rows.find((m) => m.nodeId === node.identity.nodeId)
      return row !== undefined && row.natType === 'cone' && row.lastIp === '127.0.0.1'
    })
  }, 8000, 'gateway registered both reflexive endpoints')

  // 3) 直连形成：反射端点是回环绑定 socket 的唯一可达候选 —— path 'lan'
  await waitFor(() => {
    const peer = A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId)
    return peer !== undefined && (peer.path === 'lan' || peer.path === 'p2p')
  }, 15000, 'A↔B direct path')
  const abRtt = A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId).rttMs
  assert.equal(typeof abRtt, 'number', '直连会话有 RTT')

  // 4) 直连可用：B 挂载 A 的虚拟条目并跨直连取到 A 的共享会话
  await waitFor(() => {
    const entry = B.relayPool.getByServerId(A.identity.nodeId)
    return entry !== undefined && entry.client.state === 'online'
  }, 15000, 'B mounted A online')
  const virtualAonB = B.relayPool.getByServerId(A.identity.nodeId)
  const listed = await virtualAonB.client.invoke('session', 'list', { request: {} })
  assert.ok(
    Array.isArray(listed.items) && listed.items.some((item) => item.sessionId === 's-a1'),
    '直连路径上取到 A 的共享会话',
  )
})
