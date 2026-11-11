/**
 * PeerEngine — 本机作为 peer 节点加入虚拟网络的完整生命周期（PG-8，
 * tasks/peer-gateway/PG-8.md）。四件东西在这里接线：
 *
 * 1. **网关 WS 控制连接**：`src/peer/ws-client.ts` 的零依赖 RFC6455 客户端
 *    连 `/peer/v1/ws`，走 challenge → auth 挑战应答握手（口令邀请带
 *    joinKeyProofHex 自动准入；无口令挂 pending 等管理员 REST approve 后
 *    原地升级）。断线指数退避重连（1s 起、2 倍增长、30s 封顶）。
 * 2. **本机独立 TOFU 锚定**：每个对端公告（welcome.peers / peer-joined /
 *    punch-coordinate）先过 `verifyOrPinPeerKey`——返回 `key-mismatch` 就把
 *    该对端标为 `identity-mismatch`：绝不握手、绝不挂载，即便网关状态是
 *    authorized。放行只有一条路：本机用户显式 `trustPeer()`（内部走
 *    `repinPeerKey` 换锚）。
 * 3. **RelayPool 自动编排**：通过 TOFU 且未被本机 `disabledNodes` 忽略的
 *    对端（按公告顺序、最多生效 `maxServers` 台）在 pool 里挂载**内存态**
 *    虚拟服务端条目：`mountVirtual` 的 client 用 `mux.createFetchForPeer()`
 *    当 fetch，于是 intercept / merge-streams / 插件桥 / 文件上传对同网
 *    节点天然生效，而纯 client 模式的 `servers` 列表一字不写。
 * 4. **路径与打洞**：`PeerPunchManager` 先跑 1000ms 优先 UDP 打洞
 *    （`onDirectReady` → mux 路径切 UDP、拓扑记 `lan`/`p2p`）；窗口过期
 *    `onPunchFallback` → mux 起网关 WS 中转握手、路径记 `relay`；直连事后
 *    打通/丢失各自热切换路径，ARQ 在途分片随新路径重传不断流。每 15s 和
 *    任意路径变化向网关发 `path-report` 控制帧（`/topology` 的数据源）。
 */

import { createSocket } from 'node:dgram'
import type { Socket as DgramSocket } from 'node:dgram'

import {
  computeJoinKeyProof,
  parseInviteUri,
  signGatewayChallenge,
} from './crypto.js'
import type { PeerIdentityKeyPair } from './crypto.js'
import { probeStunNatType } from './punch.js'
import type { PeerNatType, PunchFrameSender } from './punch.js'
import { PeerPunchManager } from './punch.js'
import type { DirectReadyInfo, PunchPeerInfo } from './punch.js'
import { PeerMux } from './mux.js'
import type { PeerPath } from './mux.js'
import { decodeFrameHeader } from './wire.js'
import {
  readPeerNetwork,
  repinPeerKey,
  setPeerNodeDisabled,
  verifyOrPinPeerKey,
  writePeerNetwork,
} from '../state-store.js'
import type { RelayPool, RelayPoolEntryView } from '../relay-pool.js'
import { WsClient } from './ws-client.js'

export type PeerGatewayState =
  | 'unconfigured'
  | 'connecting'
  | 'pending-approval'
  | 'authorized'
  | 'mismatch'
  | 'paused'
  | 'revoked'
  | 'offline'

export type PeerMemberState = 'eligible' | 'identity-mismatch' | 'disabled'
export type PeerMemberPath = 'lan' | 'p2p' | 'relay' | 'blocked' | 'none'

export interface PeerEnginePeerStatus {
  nodeId: string
  name: string
  state: PeerMemberState
  path: PeerMemberPath
  rttMs: number | null
  mounted: boolean
}

export interface PeerEngineStatus {
  nodeId: string
  gatewayState: PeerGatewayState
  networkId: string | null
  maxPeers: number | null
  natType: PeerNatType | null
  peers: PeerEnginePeerStatus[]
}

export interface PeerEnginePunchTimings {
  punchIntervalMs?: number
  punchRounds?: number
  punchWindowMs?: number
  reprobeIntervalMs?: number
  keepAliveMs?: number
  keepAliveLostFrames?: number
}

export interface PeerEngineOptions {
  /** `zen-remote-state.json`——身份、成员资格、TOFU 锚都在这里。 */
  stateFile: string
  identity: Pick<PeerIdentityKeyPair, 'publicKeyHex' | 'privateKeyHex' | 'nodeId'>
  /** 插件的连接池——虚拟服务端条目挂在这里（内存态）。 */
  relayPool: RelayPool
  /** 本机服务半边的 relayHandler（未挂载时回答 undefined）。 */
  relayHandler: () => ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>) | undefined
  /** 每条入站虚拟请求盖的本机标记密文。 */
  relaySecret: () => string
  /** 公告与虚拟条目显示名。 */
  serverName: () => string
  /** 自带已绑定的打洞 socket（测试防火墙注入）；缺省自建 udp4。 */
  udpSocket?: DgramSocket
  /** 网关双 UDP 端口（STUN 自查）；null 关闭探测。 */
  udpProbe?: { primaryPort: number; altPort?: number } | null
  /** 打洞节奏（缺省全按 PG-7 规格）。 */
  punch?: PeerEnginePunchTimings
  /** path-report 周期（缺省 15000ms）。 */
  pathReportMs?: number
  /** WS 重连退避（缺省 1000ms 起、30000ms 封顶）。 */
  wsReconnectBaseMs?: number
  wsReconnectMaxMs?: number
  clock?: { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
  log?: (line: string) => void
}

export interface PeerEngine {
  joinNetwork(inviteUri: string): Promise<{ ok: true } | { ok: false; code: string }>
  /** PG-9 启动自动恢复：state 文件里已有 peerNetwork 记录时按同一条
   * join 序列（备好打洞 socket 与 mux，再连网关 WS）直接连回，已入网机器
   * 重启 DSH 后无需重新粘贴邀请链接。未入网回答 false，什么也不做。 */
  resumeFromState(): boolean
  leaveNetwork(): void
  setNodeDisabled(nodeId: string, disabled: boolean): void
  trustPeer(nodeId: string): boolean
  reprobePunch(): void
  status(): PeerEngineStatus
  stop(): void
}

interface MemberRec {
  nodeId: string
  publicKeyHex: string
  name: string
  state: PeerMemberState
  path: PeerMemberPath
  mounted: boolean
  lastLanEndpoints: string[]
  lastReflexive: string | null
}

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createPeerEngine(options: PeerEngineOptions): PeerEngine {
  const clock = options.clock ?? realClock
  const log = options.log ?? (() => {})
  const identity: PeerIdentityKeyPair = {
    publicKeyHex: options.identity.publicKeyHex,
    privateKeyHex: options.identity.privateKeyHex,
    nodeId: options.identity.nodeId.toLowerCase(),
  }
  const stateFile = options.stateFile
  const pathReportMs = options.pathReportMs ?? 15_000
  const wsBase = options.wsReconnectBaseMs ?? 1_000
  const wsMax = options.wsReconnectMaxMs ?? 30_000

  let stopped = false
  let networkId: string | null = null
  let gatewayState: PeerGatewayState = 'unconfigured'
  let maxPeers: number | null = null
  let natType: PeerNatType | null = null
  let stunProbed = false
  let ws: WsClient | null = null
  let wsAttempt = 0
  let wsReconnectTimer: unknown = null
  let wsReconnectable = true
  let punch: PeerPunchManager | null = null
  /** 打洞与 STUN 共用的 socket：注入的（引擎不关）或自建的（引擎关）。 */
  let punchSocket: DgramSocket | undefined
  let mux: PeerMux | null = null
  let pathReportTimer: unknown = null
  /** 挂载顺序即公告顺序；每项是 pool entryId（= 对端 nodeId）。 */
  const members = new Map<string, MemberRec>()

  const sendGatewayBinary = (bytes: Uint8Array): void => {
    if (ws === null || ws.state !== 'open') return
    try {
      ws.send(bytes)
    } catch (err) {
      log(`peer engine: gateway ws send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const sendControl = (message: Record<string, unknown>): void => {
    if (ws === null || ws.state !== 'open') return
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // 控制面失败等下一拍重连兜底。
    }
  }

  // ------------------------------------------------------------ 挂载与卸载

  const mountCount = (): number => {
    let count = 0
    for (const member of members.values()) if (member.mounted) count += 1
    return count
  }

  const mountPeer = (member: MemberRec): void => {
    if (member.mounted || mux === null) return
    const cap = options.relayPool.maxServers()
    if (mountCount() >= cap) {
      log(`peer engine: mount cap ${cap} reached, ${member.nodeId} stays unmounted`)
      return
    }
    const entry: RelayPoolEntryView = options.relayPool.mountVirtual({
      entryId: member.nodeId,
      serverId: member.nodeId,
      serverName: member.name,
      fetchImpl: (mux.createFetchForPeer(member.nodeId) as unknown) as typeof fetch,
    })
    member.mounted = true
    log(`peer engine: mounted virtual server for ${member.nodeId} (${entry.displayName})`)
  }

  const unmountPeer = (member: MemberRec): void => {
    if (!member.mounted) return
    member.mounted = false
    options.relayPool.unmountVirtual(member.nodeId)
  }

  const markMismatch = (member: MemberRec): void => {
    member.state = 'identity-mismatch'
    unmountPeer(member)
    mux?.dropSession(member.nodeId)
    log(`peer engine: TOFU key-mismatch for ${member.nodeId} — blocked locally until trustPeer()`)
  }

  /** 一条对端公告（welcome.peers / peer-joined / punch-coordinate 共用）。 */
  const announcePeer = (info: {
    nodeId: string
    publicKeyHex: string
    name?: string | null
    lanEndpoints?: string[] | null
    reflexiveEndpoint?: string | null
    startPunch: boolean
  }): void => {
    if (stopped || networkId === null) return
    const nodeId = info.nodeId.toLowerCase()
    if (nodeId === identity.nodeId) return
    if (mux === null) return
    const net = readPeerNetwork(stateFile)
    const disabled = net?.disabledNodes?.includes(nodeId) === true
    let member = members.get(nodeId)
    if (member === undefined) {
      member = {
        nodeId,
        publicKeyHex: info.publicKeyHex,
        name: typeof info.name === 'string' && info.name.trim() !== '' ? info.name.trim() : `peer-${nodeId}`,
        state: 'eligible',
        path: 'none',
        mounted: false,
        lastLanEndpoints: [],
        lastReflexive: null,
      }
      members.set(nodeId, member)
    }
    if (typeof info.name === 'string' && info.name.trim() !== '') member.name = info.name.trim()
    member.lastLanEndpoints = Array.isArray(info.lanEndpoints) ? info.lanEndpoints.filter((e) => typeof e === 'string') : member.lastLanEndpoints
    member.lastReflexive = typeof info.reflexiveEndpoint === 'string' ? info.reflexiveEndpoint : member.lastReflexive

    if (disabled) {
      member.state = 'disabled'
      unmountPeer(member)
      mux.dropSession(nodeId)
      return
    }

    // 本机独立 TOFU：锚定不一致立刻阻断，绝不握手、绝不挂载。
    const tofu = verifyOrPinPeerKey(stateFile, nodeId, info.publicKeyHex)
    if (!tofu.ok) {
      member.publicKeyHex = info.publicKeyHex
      markMismatch(member)
      return
    }
    member.publicKeyHex = info.publicKeyHex
    member.state = 'eligible'
    mux.ensureSession(nodeId, info.publicKeyHex, member.name)
    mountPeer(member)
    if (info.startPunch && punch !== null) {
      try {
        punch.beginPunch({
          peerNodeId: nodeId,
          peerPublicKeyHex: info.publicKeyHex,
          lanEndpoints: member.lastLanEndpoints,
          ...(member.lastReflexive !== null ? { reflexiveEndpoint: member.lastReflexive } : {}),
        } satisfies PunchPeerInfo)
        log(`peer engine: beginPunch(${nodeId}) candidates=${member.lastLanEndpoints.length + (member.lastReflexive !== null ? 1 : 0)} ours=${punch.lanEndpoints().length}`)
      } catch (err) {
        log(`peer engine: beginPunch refused for ${nodeId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** 对端离线/被暂停/被移除：卸载 + 拆会话 + 忘掉成员（锚点在盘上保留）。 */
  const memberGone = (nodeId: string): void => {
    const member = members.get(nodeId.toLowerCase())
    if (member === undefined) return
    unmountPeer(member)
    mux?.dropSession(member.nodeId)
    members.delete(member.nodeId)
    schedulePathReport()
  }

  // ------------------------------------------------------------ WS 控制面

  const connectWs = (): void => {
    if (stopped || ws !== null) return
    const net = readPeerNetwork(stateFile)
    if (net === undefined) {
      gatewayState = 'unconfigured'
      return
    }
    networkId = net.networkId
    gatewayState = 'connecting'
    let client: WsClient
    try {
      // 邀请链接的 wsUrl 只有 scheme://host:port——网关的 WS 挂载路径是
      // 固定的 /peer/v1/ws（gateway-server/src/peer-hub/ws-hub.ts 的 WS_PATH）。
      client = new WsClient(`${net.gatewayWsUrl.replace(/\/+$/, '')}/peer/v1/ws`)
    } catch (err) {
      log(`peer engine: ws dial failed: ${err instanceof Error ? err.message : String(err)}`)
      gatewayState = 'offline'
      scheduleReconnect()
      return
    }
    ws = client
    client.on('open', () => {
      wsAttempt = 0
    })
    client.on('message', (data, isBinary) => {
      if (isBinary) {
        // 二进制帧只属于已入网连接；网关对挂起连接本来就不路由，这里再
        // 过一遍 TOFU 闸：非 eligible 成员的帧一律不进 mux。
        if (gatewayState !== 'authorized' || mux === null) return
        const header = decodeFrameHeader(data)
        if (header === null) return
        const member = members.get(header.srcNodeId)
        if (member === undefined || member.state !== 'eligible') return
        mux.handleGatewayFrame(data)
        return
      }
      let message: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(data.toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
        message = parsed as Record<string, unknown>
      } catch {
        return
      }
      handleControl(message)
    })
    client.on('close', (code, reason) => {
      log(`peer engine: gateway ws closed (code=${code} reason=${reason || '—'} state=${gatewayState})`)
      if (ws === client) ws = null
      if (stopped) return
      if (gatewayState !== 'paused' && gatewayState !== 'revoked') {
        gatewayState = 'offline'
        scheduleReconnect()
      }
    })
    client.on('error', (err) => {
      log(`peer engine: gateway ws error: ${err.message}`)
    })
  }

  const scheduleReconnect = (): void => {
    if (stopped || !wsReconnectable || wsReconnectTimer !== null) return
    const delay = Math.min(wsBase * 2 ** wsAttempt, wsMax)
    wsAttempt += 1
    wsReconnectTimer = clock.setTimeout(() => {
      wsReconnectTimer = null
      if (!stopped) connectWs()
    }, delay)
  }

  const handleControl = (message: Record<string, unknown>): void => {
    const type = message['type']
    if (type === 'challenge') {
      const net = readPeerNetwork(stateFile)
      const challengeHex = message['challengeHex']
      if (net === undefined || typeof challengeHex !== 'string') return
      const timestamp = clock.now()
      sendControl({
        type: 'auth',
        networkId: net.networkId,
        nodeId: identity.nodeId,
        publicKeyHex: identity.publicKeyHex,
        name: options.serverName(),
        lanEndpoints: punch?.lanEndpoints() ?? [],
        timestamp,
        signatureHex: signGatewayChallenge({
          privateKeyHex: identity.privateKeyHex,
          publicKeyHex: identity.publicKeyHex,
          challengeHex,
          networkId: net.networkId,
          nodeId: identity.nodeId,
          timestamp,
        }),
        ...(net.joinKey !== undefined
          ? { joinKeyProofHex: computeJoinKeyProof({ joinKey: net.joinKey, challengeHex, networkId: net.networkId, nodeId: identity.nodeId }) }
          : {}),
      })
      return
    }
    if (type === 'welcome') {
      maxPeers = typeof message['maxPeers'] === 'number' && Number.isInteger(message['maxPeers']) ? (message['maxPeers'] as number) : maxPeers
      const status = message['status']
      if (status === 'authorized') {
        gatewayState = 'authorized'
        for (const peer of Array.isArray(message['peers']) ? (message['peers'] as Array<Record<string, unknown>>) : []) {
          if (typeof peer?.nodeId !== 'string' || typeof peer?.publicKeyHex !== 'string') continue
          announcePeer({
            nodeId: peer.nodeId,
            publicKeyHex: peer.publicKeyHex,
            name: typeof peer.name === 'string' ? peer.name : null,
            lanEndpoints: Array.isArray(peer.lanEndpoints) ? (peer.lanEndpoints as string[]) : null,
            reflexiveEndpoint: typeof peer.reflexiveEndpoint === 'string' ? peer.reflexiveEndpoint : null,
            startPunch: true,
          })
        }
        runStunProbeOnce()
        armPathReport()
        schedulePathReport()
      } else if (status === 'pending') {
        gatewayState = 'pending-approval'
      } else if (status === 'mismatch') {
        gatewayState = 'mismatch'
      }
      return
    }
    if (type === 'denied') {
      // 拒绝在握手前后都可能到达（挂起时被踢 / 入网后被暂停）——必须在
      // authorized 闸之前处理，否则挂在 connecting/pending 的连接会把拒绝
      // 静默吞掉，永远停在旧状态。
      const reason = typeof message['reason'] === 'string' ? message['reason'] : ''
      wsReconnectable = false
      gatewayState = reason.includes('paused') ? 'paused' : 'revoked'
      log(`peer engine: gateway denied (${reason || 'no reason'})`)
      try { ws?.close() } catch { /* dying */ }
      return
    }
    if (gatewayState !== 'authorized') return // peer-*/path 事件只在入网后有意义
    if (type === 'peer-joined') {
      if (typeof message['nodeId'] !== 'string' || typeof message['publicKeyHex'] !== 'string') return
      announcePeer({
        nodeId: message['nodeId'] as string,
        publicKeyHex: message['publicKeyHex'] as string,
        name: typeof message['name'] === 'string' ? message['name'] : null,
        lanEndpoints: Array.isArray(message['lanEndpoints']) ? (message['lanEndpoints'] as string[]) : null,
        reflexiveEndpoint: typeof message['reflexiveEndpoint'] === 'string' ? message['reflexiveEndpoint'] : null,
        startPunch: true,
      })
      return
    }
    if (type === 'peer-left') {
      if (typeof message['nodeId'] === 'string') memberGone(message['nodeId'])
      return
    }
    if (type === 'peer-paused') {
      if (typeof message['nodeId'] === 'string') memberGone(message['nodeId'])
      return
    }
    if (type === 'punch-coordinate') {
      if (typeof message['peerNodeId'] !== 'string' || typeof message['publicKeyHex'] !== 'string') return
      announcePeer({
        nodeId: message['peerNodeId'] as string,
        publicKeyHex: message['publicKeyHex'] as string,
        name: null,
        lanEndpoints: Array.isArray(message['lanEndpoints']) ? (message['lanEndpoints'] as string[]) : null,
        reflexiveEndpoint: typeof message['reflexiveEndpoint'] === 'string' ? message['reflexiveEndpoint'] : null,
        startPunch: true,
      })
      return
    }
    // 其余类型（含已认证后再来的 challenge）忽略。
  }

  // ------------------------------------------------------------ STUN 与 path-report

  const runStunProbeOnce = (): void => {
    if (stunProbed || stopped || options.udpProbe === null || punch === null) return
    stunProbed = true
    const probe = options.udpProbe
    if (probe === undefined || probe.primaryPort < 1) return
    const net = readPeerNetwork(stateFile)
    if (net === undefined) return
    let hostname = '127.0.0.1'
    try {
      hostname = new URL(net.gatewayHttpOrigin).hostname
    } catch { /* keep the fallback */ }
    void probeStunNatType({
      primaryHost: hostname,
      primaryPort: probe.primaryPort,
      ...(probe.altPort !== undefined && probe.altPort > 0 ? { altPort: probe.altPort } : {}),
      networkId: networkId ?? net.networkId,
      identity,
      // 承重墙（PG-8）：从打洞层自己的 socket 发探测——网关记录并广播的
      // reflexiveEndpoint 必须是 peers 真能打到的那个端口。临时探测 socket
      // 一关，反射端口就成了黑洞，同机回环与真实 cone NAT 都打不通。
      ...(punchSocket !== undefined ? { socket: punchSocket } : {}),
      timeoutMs: 2000,
    })
      .then((result) => {
        natType = result.natType
        log(`peer engine: STUN probe → ${result.natType} (${result.reflexiveEndpoint ?? 'no reflexive answer'})`)
      })
      .catch(() => {
        natType = 'unknown'
      })
  }

  const currentPeerPaths = (): Array<{ peerNodeId: string; path: string; rttMs: number }> => {
    const out: Array<{ peerNodeId: string; path: string; rttMs: number }> = []
    for (const member of members.values()) {
      if (member.state !== 'eligible') continue
      let path: PeerMemberPath = member.path
      if (path === 'none') path = 'relay' // 打洞在途/等待降级——中转面仍可用
      const rtt = punch?.sessionRttMs(member.nodeId) ?? null
      out.push({ peerNodeId: member.nodeId, path, rttMs: rtt ?? 0 })
    }
    return out
  }

  const sendPathReport = (): void => {
    if (stopped || gatewayState !== 'authorized' || ws === null || ws.state !== 'open') return
    sendControl({ type: 'path-report', peers: currentPeerPaths() })
  }

  const pathReportArmed = { timer: null as unknown }
  const schedulePathReport = (): void => {
    if (stopped || pathReportArmed.timer !== null) return
    pathReportArmed.timer = clock.setTimeout(() => {
      pathReportArmed.timer = null
      sendPathReport()
    }, 200)
  }

  const armPathReport = (): void => {
    if (pathReportTimer !== null || stopped) return
    pathReportTimer = clock.setTimeout(function tick() {
      pathReportTimer = null
      sendPathReport()
      if (!stopped && gatewayState === 'authorized') {
        pathReportTimer = clock.setTimeout(tick, pathReportMs)
      }
    }, pathReportMs)
  }

  // ------------------------------------------------------------ 打洞回调

  const onDirectReady = (nodeId: string, info: DirectReadyInfo): void => {
    log(`peer engine: direct ready ${nodeId} via ${info.mode} ${info.endpoint} rtt=${info.rttMs}`)
    const member = members.get(nodeId)
    if (member === undefined) return
    member.path = info.mode
    if (mux !== null && punch !== null) {
      mux.setDirectPath(nodeId, punch.frameSenderFor(nodeId))
    }
    schedulePathReport()
  }

  const onPunchFallback = (nodeId: string): void => {
    log(`peer engine: punch fallback ${nodeId} (window expired)`)
    const member = members.get(nodeId)
    if (member === undefined) return
    if (member.path !== 'lan' && member.path !== 'p2p') member.path = 'relay'
    mux?.enableRelayPath(nodeId)
    schedulePathReport()
  }

  const onDirectLost = (nodeId: string): void => {
    const member = members.get(nodeId)
    if (member === undefined) return
    member.path = 'relay'
    mux?.setRelayPath(nodeId)
    schedulePathReport()
  }

  // ------------------------------------------------------------ 引擎 API

  const buildPunch = (): PeerPunchManager | null => {
    if (stopped) return null
    if (punch !== null) return punch
    const net = readPeerNetwork(stateFile)
    if (net === undefined) return null
    // Socket 归一（PG-8）：打洞与 STUN 探测必须共用同一个已绑定的 UDP
    // socket——网关记录并广播的 reflexiveEndpoint 只有在探测帧真的出自
    // 打洞 socket 时才指向 peers 可达的端口。注入 socket（测试/防火墙包装）
    // 未绑定时这里代绑；没有注入时引擎自建一个并持有（stop 时关闭），
    // punch 管理器因此永远走「自带 socket」的路径（ownsSocket=false）。
    if (options.udpSocket !== undefined) {
      let bound = true
      try {
        bound = options.udpSocket.address().port > 0
      } catch {
        bound = false
      }
      if (!bound) {
        options.udpSocket.bind({ port: 0, address: '0.0.0.0' }, () => {})
      }
      punchSocket = options.udpSocket
    } else if (punchSocket === undefined) {
      const socket = createSocket('udp4')
      socket.unref?.()
      socket.bind({ port: 0, address: '0.0.0.0' }, () => {})
      punchSocket = socket
    }
    punch = new PeerPunchManager({
      networkId: net.networkId,
      identity,
      socket: punchSocket,
      clock,
      ...(options.punch ?? {}),
      onDirectReady,
      onPunchFallback,
      onDirectLost,
      onEncryptedFrame: (header, plaintext) => {
        mux?.handleOpenedFrame(header, plaintext)
      },
    })
    return punch
  }

  const buildMux = (): PeerMux => {
    if (mux !== null) return mux
    const net = readPeerNetwork(stateFile)
    mux = new PeerMux({
      networkId: net?.networkId ?? '0000000000000000',
      identity,
      sendGatewayBinary,
      relayHandler: options.relayHandler,
      relaySecret: options.relaySecret,
      clock,
      log,
    })
    return mux
  }

  const resetActiveSession = (): void => {
    for (const member of [...members.values()]) {
      unmountPeer(member)
      mux?.dropSession(member.nodeId)
    }
    members.clear()
    if (wsReconnectTimer !== null) {
      clock.clearTimeout(wsReconnectTimer)
      wsReconnectTimer = null
    }
    if (pathReportTimer !== null) {
      clock.clearTimeout(pathReportTimer)
      pathReportTimer = null
    }
    if (pathReportArmed.timer !== null) {
      clock.clearTimeout(pathReportArmed.timer)
      pathReportArmed.timer = null
    }
    wsReconnectable = false
    try { ws?.close() } catch { /* dying */ }
    ws = null
    mux?.close()
    mux = null
    punch?.close()
    punch = null
    stunProbed = false
    natType = null
    maxPeers = null
  }

  return {
    async joinNetwork(invite) {
      if (stopped) return { ok: false, code: 'stopped' }
      const parsed = parseInviteUri(invite)
      if (parsed === null) return { ok: false, code: 'invalid-invite' }
      const existing = readPeerNetwork(stateFile)
      // 切换网络或重填地址重新入网时，先拆掉上一轮挂起/在线的 WS、mux 与打洞器。
      resetActiveSession()
      writePeerNetwork(stateFile, {
        inviteUri: invite,
        gatewayWsUrl: parsed.wsUrl,
        gatewayHttpOrigin: parsed.httpOrigin,
        networkId: parsed.networkId,
        joinedAt: clock.now(),
        ...(parsed.joinKey !== undefined ? { joinKey: parsed.joinKey } : {}),
        ...(existing?.disabledNodes !== undefined ? { disabledNodes: existing.disabledNodes } : {}),
        ...(existing?.maxPeersFromGateway !== undefined ? { maxPeersFromGateway: existing.maxPeersFromGateway } : {}),
      })
      networkId = parsed.networkId
      wsReconnectable = true
      wsAttempt = 0
      // 先备好打洞 socket（lanEndpoints 要随 auth 上送）与 mux，再连网关。
      const manager = buildPunch()
      if (manager !== null) await manager.ready()
      buildMux()
      connectWs()
      return { ok: true }
    },

    resumeFromState() {
      if (stopped) return false
      const net = readPeerNetwork(stateFile)
      if (net === undefined) return false
      networkId = net.networkId
      wsReconnectable = true
      wsAttempt = 0
      // joinNetwork 的同一条序列，只是不落盘（记录已在）：apply 是同步的，
      // 打洞 socket 的 ready 在后台等待，auth 帧晚一拍上送没有影响——
      // challenge 本来就要等网关回应才发。
      void (async () => {
        const manager = buildPunch()
        if (manager !== null) await manager.ready()
        buildMux()
        connectWs()
      })()
      return true
    },

    leaveNetwork() {
      for (const member of [...members.values()]) {
        unmountPeer(member)
        mux?.dropSession(member.nodeId)
      }
      members.clear()
      if (pathReportTimer !== null) {
        clock.clearTimeout(pathReportTimer)
        pathReportTimer = null
      }
      wsReconnectable = false
      try { ws?.close() } catch { /* dying */ }
      punch?.close()
      punch = null
      stunProbed = false
      natType = null
      maxPeers = null
      networkId = null
      gatewayState = 'unconfigured'
      writePeerNetwork(stateFile, undefined)
    },

    setNodeDisabled(nodeId, disabled) {
      const id = nodeId.toLowerCase()
      setPeerNodeDisabled(stateFile, id, disabled)
      if (disabled) {
        const member = members.get(id)
        if (member !== undefined) {
          member.state = 'disabled'
          unmountPeer(member)
          mux?.dropSession(id)
        }
      }
    },

    trustPeer(nodeId) {
      const id = nodeId.toLowerCase()
      const member = members.get(id)
      if (member === undefined) return false
      const moved = repinPeerKey(stateFile, id, member.publicKeyHex)
      if (!moved) return false
      // 换锚成功：按一条全新公告放行（挂载 + WS 中转握手 + 重新打洞）。
      announcePeer({
        nodeId: id,
        publicKeyHex: member.publicKeyHex,
        name: member.name,
        lanEndpoints: member.lastLanEndpoints,
        reflexiveEndpoint: member.lastReflexive,
        startPunch: true,
      })
      mux?.enableRelayPath(id)
      return true
    },

    reprobePunch() {
      if (punch === null || stopped) return
      for (const member of members.values()) {
        if (member.state !== 'eligible') continue
        try {
          punch.beginPunch({
            peerNodeId: member.nodeId,
            peerPublicKeyHex: member.publicKeyHex,
            lanEndpoints: member.lastLanEndpoints,
            ...(member.lastReflexive !== null ? { reflexiveEndpoint: member.lastReflexive } : {}),
          })
        } catch {
          // 候选无效——下一轮坐标再试。
        }
      }
    },

    status() {
      const peers: PeerEnginePeerStatus[] = []
      for (const member of members.values()) {
        peers.push({
          nodeId: member.nodeId,
          name: member.name,
          state: member.state,
          path: member.path,
          rttMs: punch?.sessionRttMs(member.nodeId) ?? null,
          mounted: member.mounted,
        })
      }
      return {
        nodeId: identity.nodeId,
        gatewayState,
        networkId,
        maxPeers,
        natType,
        peers,
      }
    },

    stop() {
      if (stopped) return
      stopped = true
      for (const member of [...members.values()]) unmountPeer(member)
      members.clear()
      if (wsReconnectTimer !== null) {
        clock.clearTimeout(wsReconnectTimer)
        wsReconnectTimer = null
      }
      if (pathReportTimer !== null) {
        clock.clearTimeout(pathReportTimer)
        pathReportTimer = null
      }
      if (pathReportArmed.timer !== null) {
        clock.clearTimeout(pathReportArmed.timer)
        pathReportArmed.timer = null
      }
      try { ws?.close() } catch { /* dying */ }
      ws = null
      mux?.close()
      mux = null
      punch?.close()
      punch = null
      // 自建 socket 在这里收口；注入的 socket 归调用方，引擎不代关。
      if (punchSocket !== undefined && options.udpSocket === undefined) {
        try { punchSocket.close() } catch { /* already closed */ }
      }
      punchSocket = undefined
      gatewayState = 'unconfigured'
    },
  }
}
