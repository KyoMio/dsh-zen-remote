// 节点信令与零明文二进制帧中转中心（PG-5）。
//
// 挂在宿主 http.Server 的 upgrade 事件路径 /peer/v1/ws 上（WebSocketServer
// noServer 模式），一条连接的生命周期由 ConnState.state 表达：
//
//   hanging    → 挑战应答通过但五态判定为 pending / mismatch：连接挂起在
//                等待池，转发全阻断；管理员 REST approve / repin 后原地升级
//                为 authorized（无需重连），拿到 peers 快照。
//   authorized → 进内存路由表；二进制帧按 28B 明文头查表原样转发
//                （srcNodeId 严格等于连接自身 nodeId，网关绝不解密载荷）。
//   paused     → PC-03：已认证成员被暂停。连接降级为受限控制通道留在
//                pausedConns 池（不路由帧、不受 path-report、STUN 准入拒绝），
//                仅承载 {type:'paused'} 通知与 resume 后的原地恢复；auth 带
//                pauseHold 能力位的新版节点才保留，旧版节点维持 deny + 关闭。
//   关闭        → authorized 广播 peer-left，路由表摘除；挂起/暂停池摘除。
//
// 与 PG-4 的打通全部经 GatewayHooks：approve/reject/pause/resume/repin/
// remove/deleteNetwork/disableUser/settings 变更实时反映到内存路由表与
// 在线连接。中转字节经 PeerRateLimiter 限速（超限丢弃背压）并累计
// pendingRelayBytes，由内部定时器经 store.flushMemberTelemetry 落库。
// 拓扑订阅（SSE）在成员变动、path-report、3s 速率跳动时重渲染快照推送。
import { randomBytes } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

import { DEFAULT_SETTINGS } from '../store/types.js';
import type {
  GatewayStore,
  MemberRecord,
  NatType,
  NetworkRecord,
  TelemetryUpdate,
} from '../store/types.js';
import type {
  GatewayHooks,
  MemberChangedEvent,
  NetworkTopologySnapshot,
  TopologyLink,
  TopologyMemberRow,
} from '../http/auth.js';
import { decryptSecret } from '../master-key.js';
import {
  normalizeNetworkId,
  normalizeNodeId,
  normalizePublicKeyHex,
  verifyGatewayChallengeSignature,
  verifyJoinKeyProofHex,
} from './peer-crypto.js';
import { readRelayHeader } from './relay-frame.js';
import { PeerRateLimiter } from './rate-limiter.js';
import type { NatObservation } from './udp-stun.js';

const WS_PATH = '/peer/v1/ws';
/** auth/path-report 时间戳的新鲜度窗口（±） */
const TIMESTAMP_WINDOW_MS = 5 * 60_000;
const MAX_PATH_REPORTS_PER_NODE = 64;
const MAX_LAN_ENDPOINTS = 16;

export interface PeerWsHubOptions {
  store: GatewayStore;
  /** 秘密加密主密钥：入网时解密 joinKey 验证口令证明 */
  masterKey: Buffer;
  /** SSE 速率跳动推送间隔；缺省 3000ms，传 null 关闭 */
  rateTickMs?: number | null;
  /** 遥测刷盘（flushMemberTelemetry）间隔；缺省 5000ms，传 null 关闭 */
  flushMs?: number | null;
  /** 时间戳窗口，缺省 ±5 分钟 */
  timestampWindowMs?: number;
  now?: () => number;
  /** 生产实例的真实 UDP STUN 端口供给器：组合根在 UdpStunService.bind() 完成后才返回
   * 实际绑定值（不得用配置值或 HTTP 端口冒充）；返回 null 或缺省时 welcome 不带 stun 字段 */
  stunPorts?: () => { primaryPort: number; altPort: number | null } | null;
}

/**
 * 一条已通过挑战应答的连接。state = 'hanging' 时在挂起池（pending/mismatch
 * 共用，具体等哪个动作看挂起原因——approve 与 repin 都通向同一升级路径）；
 * state = 'authorized' 时在路由表；state = 'paused' 时在暂停池（PC-03 受限
 * 控制连接，等待 resume 原地恢复）；state = 'closed' 为终态（被踢/替换），
 * RFC6455 close 握手窗口内任何帧一律拒收（见 killConn）。
 */
interface ConnState {
  ws: WebSocket;
  /** Opaque STUN generation; replacements with the same identity get a new token. */
  stunAdmission: symbol;
  state: 'hanging' | 'authorized' | 'paused' | 'closed';
  networkId: string;
  nodeId: string;
  ownerId: string;
  maxPeers: number;
  /** 认证通过的 64 hex 公钥；repin 晋级时随 store 同步为新公钥 */
  publicKeyHex: string;
  name: string | null;
  lanEndpoints: string[];
  natType: NatType;
  reflexive: { ip: string; port: number } | null;
  remoteIp: string | null;
  connectedAt: number;
  /** 该节点上报到各 peer 的路径观测 */
  pathReports: Map<string, { path: string; rttMs: number }>;
}

interface PeerView {
  nodeId: string;
  publicKeyHex: string;
  name: string | null;
  lanEndpoints: string[];
  natType: NatType;
  reflexiveEndpoint: string | null;
}

/** PC-08a fix1：每网络的容量观察状态，字段语义见 capacityFacts 字段注释 */
interface NetworkCapacityFacts {
  readTicket: number;
  factVersion: number;
  appliedMaxPeers: number | null;
}

const connKey = (networkId: string, nodeId: string): string => `${networkId}|${nodeId}`;

function endpointString(reflexive: { ip: string; port: number } | null): string | null {
  return reflexive !== null ? `${reflexive.ip}:${reflexive.port}` : null;
}

function peerView(conn: ConnState): PeerView {
  return {
    nodeId: conn.nodeId,
    publicKeyHex: conn.publicKeyHex,
    name: conn.name,
    lanEndpoints: conn.lanEndpoints,
    natType: conn.natType,
    reflexiveEndpoint: endpointString(conn.reflexive),
  };
}

function sendJson(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(message), () => {/* 写失败由 close/error 事件兜底 */});
}

/** 拒绝并关闭：先发原因再发 close 帧，同一条 TCP 流上按序到达（仅限未入网连接） */
function deny(ws: WebSocket, reason: string): void {
  sendJson(ws, { type: 'denied', reason });
  ws.close(1008, reason.slice(0, 120));
}

/** 被踢连接的宽限毫秒数：够 denied 消息冲出内核缓冲，也封死 close 握手挂住的可能 */
const KICK_GRACE_MS = 250;

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof Buffer) return data;
  return Buffer.from(data as ArrayBuffer);
}

function parseJsonObject(data: RawData): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(toBuffer(data).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** lanEndpoints：≤16 条、每条 1..64 字符的字符串（`ip:port` 形态由节点侧保证） */
function parseLanEndpoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length < 1 || trimmed.length > 64) continue;
    out.push(trimmed);
    if (out.length >= MAX_LAN_ENDPOINTS) break;
  }
  return out;
}

function parseName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return null;
  return trimmed;
}

export class PeerWsHub {
  readonly limiter: PeerRateLimiter;
  private readonly store: GatewayStore;
  private readonly masterKey: Buffer;
  private readonly timestampWindowMs: number;
  private readonly now: () => number;
  /** 真实 UDP STUN 端口供给器；null 表示组合根未接入（welcome 不带 stun 字段） */
  private readonly stunPorts: (() => { primaryPort: number; altPort: number | null } | null) | null;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  /** 已授权在线路由表：networkId → nodeId → 连接 */
  private readonly conns = new Map<string, Map<string, ConnState>>();
  /** 挂起池：pending / mismatch 共用，等待 approve / repin */
  private readonly hanging = new Map<string, ConnState>();
  /** 暂停池（PC-03）：已认证成员被暂停后保留的受限控制连接，等待 resume 原地恢复 */
  private readonly pausedConns = new Map<string, ConnState>();
  /** 本 hub 接纳的全部 socket（含尚未发 auth 的 preauth），close 时统一 terminate */
  private readonly acceptedSockets = new Set<WebSocket>();
  /** SSE 订阅者：networkId → 回调集合 */
  private readonly subscribers = new Map<string, Set<(snapshot: NetworkTopologySnapshot) => void>>();
  /** 上一次速率跳动推走的每网总速率（恒零不推） */
  private readonly lastPublishedKbps = new Map<string, number>();
  /** 待刷盘的 natType/lastIp 变更（flush 时与限速字节合并落库） */
  private readonly pendingNat = new Map<string, { networkId: string; nodeId: string; natType?: NatType; lastIp?: string }>();
  /** 系统实时 relayRateKbps；构造时异步拉一次，onSettingsChanged 钩子热更新 */
  private rateKbps: number = DEFAULT_SETTINGS.relayRateKbps;
  private rateTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;
  // In-flight reads may carry pre-disable snapshots (including PostgreSQL queries).
  private admissionEpoch = 0;
  // Retain the last disable across re-enable: only newer attempts may join again.
  private readonly ownerDisabledEpoch = new Map<string, number>();
  // PC-03 fix1/fix2：每成员授权代次（与 ownerDisabledEpoch 同一代次模式）。
  // 除 rename 外的成员动作在 onMemberChanged 入口递增；两类在途快照以捕获值
  // 做同步复核：(1) 池中连接的 resume/approve 晋升；(2) 尚未落地的在途认证
  // （handleAuth）。任何后到的状态变化都使旧快照失效。生命周期 = hub 进程
  // 生命周期：条目是每成员一个小整数，刻意不删——删除会让「已删代次」与
  // 「从未变化」（0）重新相等，放过过期快照；增长上界是本进程见过的
  // (network|node) 身份数，不落库、进程重启即清零。
  private readonly memberEpochs = new Map<string, number>();
  // PC-08a fix1：每网络容量观察状态（网络删除时清理）。数据库真值只在读的
  // 那一刻成立，异步返回的是读时快照——三个字段把「观察」与「传播」分开：
  //   readTicket     递增于每次 hook 读库发出；只有最新发出的读取允许落地，
  //                  迟到完成的旧快照在此作废（乱序不回灌）
  //   factVersion    递增于每次观察到的事实变化（成功应用且值不同）；auth/
  //                  晋升据此判断「我读库之后事实是否又变过」——广播读库失败
  //                  不递增，缓存滞后不会把读到真值的正常认证挡在门外
  //   appliedMaxPeers 最近一次成功传播（广播+池快照改写）的值；同值幂等参考；
  //                  读库失败不更新，同值重试 PATCH 即恢复传播
  private readonly capacityFacts = new Map<string, NetworkCapacityFacts>();

  constructor(options: PeerWsHubOptions) {
    this.store = options.store;
    this.masterKey = options.masterKey;
    this.timestampWindowMs = options.timestampWindowMs ?? TIMESTAMP_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.stunPorts = options.stunPorts ?? null;
    this.limiter = new PeerRateLimiter({ now: this.now });
    void this.store
      .getSettings()
      .then((settings) => {
        if (!this.closed) this.rateKbps = settings.relayRateKbps;
      })
      .catch(() => {/* 库暂不可用时用默认速率，settings 变更钩子会再喂 */});
    const rateTickMs = options.rateTickMs === undefined ? 3000 : options.rateTickMs;
    if (rateTickMs !== null && rateTickMs > 0) {
      this.rateTimer = setInterval(() => this.tickRates(), rateTickMs);
      this.rateTimer.unref?.();
    }
    const flushMs = options.flushMs === undefined ? 5000 : options.flushMs;
    if (flushMs !== null && flushMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flushTelemetry().catch(() => {/* 单次刷盘失败等下一轮 */});
      }, flushMs);
      this.flushTimer.unref?.();
    }
  }

  // ------------------------------------------------------------ 生命周期

  /** 挂到宿主 server 的 upgrade 事件；仅放行 /peer/v1/ws，其余路径直接销毁 */
  attach(server: HttpServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let pathname = '';
      try {
        pathname = new URL(req.url ?? '/', 'http://gateway.internal').pathname;
      } catch {
        pathname = '';
      }
      if (pathname !== WS_PATH) {
        socket.destroy();
        return;
      }
      const remoteIp = req.socket.remoteAddress ?? null;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.setupConnection(ws, remoteIp));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.rateTimer !== null) clearInterval(this.rateTimer);
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.rateTimer = null;
    this.flushTimer = null;
    // preauth socket 不在路由表/挂起池里，必须单独 terminate，
    // 否则 wss.close 会等它永远不触发回调
    for (const ws of this.acceptedSockets) ws.terminate();
    this.acceptedSockets.clear();
    for (const net of this.conns.values()) {
      for (const conn of net.values()) conn.ws.terminate();
    }
    for (const conn of this.hanging.values()) conn.ws.terminate();
    for (const conn of this.pausedConns.values()) conn.ws.terminate();
    this.conns.clear();
    this.hanging.clear();
    this.pausedConns.clear();
    this.subscribers.clear();
    this.lastPublishedKbps.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  // ------------------------------------------------------------ 连接建立

  private setupConnection(ws: WebSocket, remoteIp: string | null): void {
    if (this.closed) {
      ws.close(1013, 'gateway shutting down');
      return;
    }
    this.acceptedSockets.add(ws);
    ws.on('close', () => {
      this.acceptedSockets.delete(ws);
    });
    const challengeHex = randomBytes(32).toString('hex');
    /** auth 通过后的连接状态；断开清理据此分流 */
    let conn: ConnState | null = null;
    let phase: 'preauth' | 'authed' | 'closed' = 'preauth';
    sendJson(ws, { type: 'challenge', challengeHex });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (phase !== 'preauth' && phase !== 'authed') return;
      if (conn !== null && conn.state === 'closed') return; // 终态连接（close 握手窗口内）一律拒收
      if (isBinary) {
        this.relayBinary(conn, toBuffer(data));
        return;
      }
      const message = parseJsonObject(data);
      if (message === null) return;
      if (phase === 'preauth') {
        if (message['type'] !== 'auth') return;
        phase = 'authed'; // 一条连接只受理一次 auth
        void this.handleAuth(ws, message, challengeHex, remoteIp).then((state) => {
          if (state !== null) conn = state;
        });
        return;
      }
      if (conn !== null && conn.state === 'authorized' && message['type'] === 'path-report') {
        this.handlePathReport(conn, message);
        return;
      }
      if (conn !== null && (conn.state === 'authorized' || conn.state === 'hanging') && message['type'] === 'rename') {
        void this.handleRename(conn, message);
      }
      // 其余类型（含已认证后再发 auth）一律忽略
    });

    ws.on('error', () => {
      ws.terminate();
    });

    ws.on('close', () => {
      phase = 'closed';
      this.teardown(conn);
    });
  }

  /** 连接断开：路由表/挂起池/暂停池摘除、离线广播、对方拓扑里的过期路径清掉 */
  private teardown(conn: ConnState | null): void {
    if (conn === null) return; // preauth 就断开，无状态可清
    if (conn.state === 'authorized') {
      const net = this.conns.get(conn.networkId);
      if (net !== undefined && net.get(conn.nodeId) === conn) {
        net.delete(conn.nodeId);
        if (net.size === 0) this.conns.delete(conn.networkId);
        // 该节点下线后，其他成员上报的指向它的路径不再是可观测事实
        for (const other of this.conns.get(conn.networkId)?.values() ?? []) {
          other.pathReports.delete(conn.nodeId);
        }
        this.broadcast(conn.networkId, { type: 'peer-left', nodeId: conn.nodeId }, conn.nodeId);
        void this.publishTopology(conn.networkId);
      }
      return;
    }
    if (conn.state === 'paused') {
      // 暂停连接断开：对端早已被撤下业务（收过 peer-paused），拓扑无可见变化，
      // 摘出暂停池即可；重连由节点自己的退避驱动（auth 后重新挂回本池）
      const key = connKey(conn.networkId, conn.nodeId);
      if (this.pausedConns.get(key) === conn) this.pausedConns.delete(key);
      return;
    }
    const key = connKey(conn.networkId, conn.nodeId);
    if (this.hanging.get(key) === conn) {
      this.hanging.delete(key);
      void this.publishTopology(conn.networkId);
    }
  }

  /** 登记进内存路由表并通知全网（welcome 已由调用方先行下发） */
  private registerAndAnnounce(conn: ConnState): void {
    conn.state = 'authorized';
    let net = this.conns.get(conn.networkId);
    if (net === undefined) {
      net = new Map();
      this.conns.set(conn.networkId, net);
    }
    net.set(conn.nodeId, conn);
    const others = [...net.values()].filter((c) => c !== conn);
    this.broadcast(conn.networkId, {
      type: 'peer-joined',
      nodeId: conn.nodeId,
      publicKeyHex: conn.publicKeyHex,
      name: conn.name,
      lanEndpoints: conn.lanEndpoints,
      natType: conn.natType,
      reflexiveEndpoint: endpointString(conn.reflexive),
    }, conn.nodeId);
    // 打洞协调：向配对节点对（新节点 ↔ 每个在线成员）同时下发；
    // publicKeyHex 供对端做 TOFU 锚定与 E2EE 握手
    for (const other of others) {
      sendJson(conn.ws, {
        type: 'punch-coordinate',
        peerNodeId: other.nodeId,
        publicKeyHex: other.publicKeyHex,
        lanEndpoints: other.lanEndpoints,
        reflexiveEndpoint: endpointString(other.reflexive),
        natType: other.natType,
        startAfterMs: 20,
      });
      sendJson(other.ws, {
        type: 'punch-coordinate',
        peerNodeId: conn.nodeId,
        publicKeyHex: conn.publicKeyHex,
        lanEndpoints: conn.lanEndpoints,
        reflexiveEndpoint: endpointString(conn.reflexive),
        natType: conn.natType,
        startAfterMs: 20,
      });
    }
    void this.publishTopology(conn.networkId);
  }

  private welcomeAuthorized(conn: ConnState): void {
    const peers = [...(this.conns.get(conn.networkId)?.values() ?? [])]
      .filter((c) => c !== conn)
      .map(peerView);
    // stun 为增量字段：真实 UDP 端口供节点打洞，旧节点忽略；端口未就绪时整字段缺席
    const stunPorts = this.stunPorts?.() ?? null;
    sendJson(conn.ws, {
      type: 'welcome',
      status: 'authorized',
      maxPeers: conn.maxPeers,
      peers,
      ...(stunPorts !== null ? { stun: stunPorts } : {}),
    });
  }

  // ------------------------------------------------------------ 入网判定

  /** 挑战应答判定。拒绝路径发 denied 并关闭（返回 null）；通过则登记并返回连接 */
  private async handleAuth(
    ws: WebSocket,
    message: Record<string, unknown>,
    challengeHex: string,
    remoteIp: string | null,
  ): Promise<ConnState | null> {
    const epoch = this.admissionEpoch;
    const networkId = normalizeNetworkId(message['networkId']);
    const nodeId = normalizeNodeId(message['nodeId']);
    const publicKeyHex = normalizePublicKeyHex(message['publicKeyHex']);
    const timestamp = message['timestamp'];
    const signatureHex = message['signatureHex'];
    if (
      networkId === null || nodeId === null || publicKeyHex === null ||
      typeof timestamp !== 'number' || !Number.isInteger(timestamp) ||
      typeof signatureHex !== 'string'
    ) {
      deny(ws, 'malformed auth message');
      return null;
    }
    if (Math.abs(this.now() - timestamp) > this.timestampWindowMs) {
      deny(ws, 'timestamp out of range');
      return null;
    }
    if (!verifyGatewayChallengeSignature({ networkId, nodeId, publicKeyHex, challengeHex, timestamp, signatureHex })) {
      deny(ws, 'challenge signature verification failed');
      return null;
    }
    // PC-08a fix2：事实代次在读库**发出前**捕获。异步读取返回的是读时快照，
    // 若结果迟到返回而期间已有事实变化被观察应用，拿到旧数据后才捕获会给旧
    // maxPeers 贴上新代次、误过末端闸。发出前捕获使快照恒与发出时刻的代次
    // 配对：窗口内发生过事实变化就在末端闸静默关闭，重连按新值放行（读取
    // 执行前一刻恰好应用变化会多一次自愈重连，fail-closed 方向）。判定只用
    // 观察代次、不拿广播缓存值比较——传播读库失败不动代次，读到真值的认证
    // 照常放行（fix1 语义保持）。
    const handshakeCapacityVersion = this.capacityFacts.get(networkId)?.factVersion ?? 0;
    let network: NetworkRecord | null;
    try {
      network = await this.store.getNetwork(networkId);
    } catch {
      deny(ws, 'gateway storage unavailable');
      return null;
    }
    if (network === null) {
      deny(ws, 'network not found');
      return null;
    }
    if (!await this.checkOwnerAdmission(ws, network.ownerId, epoch) || !this.admissionCurrent(ws, network.ownerId, epoch)) return null;
    const proof = message['joinKeyProofHex'];
    // PC-03 能力位：节点声明「被暂停时可保留受限控制连接」。旧版节点不带此
    // 字段，维持既有 deny + 关闭语义；多余字段对旧网关无影响（additive）。
    const pauseHold = message['pauseHold'] === true;
    let joinKeyMatched = false;
    if (typeof proof === 'string') {
      try {
        const joinKey = decryptSecret(network.joinKeyEnc, this.masterKey);
        joinKeyMatched = verifyJoinKeyProofHex({ joinKey, networkId, nodeId, challengeHex, proofHex: proof });
      } catch {
        joinKeyMatched = false; // 密文损坏视同口令不匹配
      }
    }

    const name = parseName(message['name']);
    // PC-03 fix2：关键成员读写（upsertMemberJoinAttempt）之前捕获成员代次——
    // 此后到注册之间的所有 await 窗口内，管理员的 pause/remove 等正常操作
    // 都会递增它（见 onMemberChanged），末尾同步复核使过期快照失效。
    const memberEpoch = this.memberEpochs.get(connKey(networkId, nodeId)) ?? 0;
    let member: MemberRecord | null;
    try {
      member = await this.store.upsertMemberJoinAttempt({
        networkId,
        nodeId,
        name,
        publicKeyHex,
        joinKeyMatched,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      deny(ws, code === 'limit-reached' ? 'network is full' : 'join attempt rejected by gateway');
      return null;
    }
    if (member === null) {
      deny(ws, 'join key rejected');
      return null;
    }

    // Revalidate after the async join write, before any routing/hanging registration.
    if (!await this.checkOwnerAdmission(ws, network.ownerId, epoch) || !this.admissionCurrent(ws, network.ownerId, epoch)) return null;
    // PC-03 fix2：成员代次同步复核——这是最后一个 await 之后的闸，到这里与
    // 注册之间没有任何 await。认证中途落下的状态变化使 member 快照过期：不按
    // 旧状态注册/放行/挂起，直接关闭连接。刻意不发 denied——节点把一切
    // denied 视为终止性拒绝并停止重连（wsReconnectable=false），会把暂时性
    // pause 变成永久停机；静默关闭让节点沿既有有界退避重连，下一次认证按
    // 最新持久授权重新判定。
    if ((this.memberEpochs.get(connKey(networkId, nodeId)) ?? 0) !== memberEpoch) {
      ws.close(1013, 'membership changed during authentication');
      return null;
    }
    // PC-08a fix1：认证途中观察到容量事实变化（代次前进）——握手期读到的
    // maxPeers 已不可信，带旧快照落地会让 welcome 携带过期容量。沿成员代次
    // 同款静默关闭（不发 denied，节点不会把暂时性变化误判为终止性拒绝），节点
    // 沿既有有界退避重连，下一次认证直读库按新值放行。这是最后一个 await 之后
    // 的同步闸，与注册之间无 await。
    if ((this.capacityFacts.get(networkId)?.factVersion ?? 0) !== handshakeCapacityVersion) {
      ws.close(1013, 'network changed during authentication');
      return null;
    }
    this.replaceExisting(networkId, nodeId);
    const conn: ConnState = {
      ws,
      stunAdmission: Symbol(),
      state: 'hanging',
      networkId,
      nodeId,
      ownerId: network.ownerId,
      maxPeers: network.maxPeers,
      publicKeyHex,
      name: member.name ?? name,
      lanEndpoints: parseLanEndpoints(message['lanEndpoints']),
      natType: member.natType,
      reflexive: null,
      remoteIp,
      connectedAt: this.now(),
      pathReports: new Map(),
    };

    switch (member.status) {
      case 'authorized': {
        this.welcomeAuthorized(conn);
        this.registerAndAnnounce(conn);
        return conn;
      }
      case 'pending': {
        sendJson(ws, { type: 'welcome', status: 'pending', maxPeers: network.maxPeers });
        this.hanging.set(connKey(networkId, nodeId), conn);
        void this.publishTopology(networkId);
        return conn;
      }
      case 'mismatch': {
        sendJson(ws, { type: 'welcome', status: 'mismatch' });
        this.hanging.set(connKey(networkId, nodeId), conn);
        void this.publishTopology(networkId);
        return conn;
      }
      case 'paused': {
        // PC-03：新版节点（pauseHold 能力位）保留受限控制连接等待管理员
        // resume（原地恢复，无需重新入网）；旧版节点维持既有语义——告知
        // 原因并关闭，由节点重启/手工入网恢复。
        if (!pauseHold) {
          deny(ws, `membership ${member.status}`);
          return null;
        }
        conn.state = 'paused';
        sendJson(ws, { type: 'welcome', status: 'paused', maxPeers: network.maxPeers });
        this.pausedConns.set(connKey(networkId, nodeId), conn);
        return conn;
      }
      default: {
        // revoked（以及未带 pauseHold 能力位的旧版 paused）：告知原因并关闭
        deny(ws, `membership ${member.status}`);
        return null;
      }
    }
  }

  private admissionCurrent(ws: WebSocket, ownerId: string, epoch: number): boolean {
    if (this.closed || ws.readyState !== ws.OPEN) return false;
    if ((this.ownerDisabledEpoch.get(ownerId) ?? 0) <= epoch) return true;
    deny(ws, 'admission changed');
    return false;
  }

  private async checkOwnerAdmission(ws: WebSocket, ownerId: string, epoch: number): Promise<boolean> {
    try {
      const owner = await this.store.findUserById(ownerId);
      if (this.closed || ws.readyState !== ws.OPEN) return false;
      if (owner?.active && (this.ownerDisabledEpoch.get(ownerId) ?? 0) <= epoch) return true;
      deny(ws, 'account disabled or admission changed');
    } catch {
      deny(ws, 'gateway storage unavailable');
    }
    return false;
  }

  /** 踢掉同 (networkId, nodeId) 的旧连接（authorized / 挂起 / 暂停各查一遍） */
  private replaceExisting(networkId: string, nodeId: string): void {
    const net = this.conns.get(networkId);
    const old = net?.get(nodeId);
    if (old !== undefined) {
      this.killConn(old, 'replaced by a new connection');
    }
    const hangKey = connKey(networkId, nodeId);
    const oldHang = this.hanging.get(hangKey);
    if (oldHang !== undefined) {
      this.killConn(oldHang, 'replaced by a new connection');
    }
    const oldPaused = this.pausedConns.get(hangKey);
    if (oldPaused !== undefined) {
      this.killConn(oldPaused, 'replaced by a new connection');
    }
  }

  // ------------------------------------------------------------ 二进制中转

  /**
   * 零明文转发：只读 28B 明文头做路由判定（magic/version/长度/帧类型 +
   * srcNodeId 严格等于本连接身份——源地址欺骗在这一步被丢弃），载荷
   * 原样转交，网关永远没有明文。经令牌桶限速，超限丢弃（背压由发送端
   * 的可靠层负责），转发字节计入滑窗与待刷盘计数。
   */
  private relayBinary(conn: ConnState | null, buf: Buffer): void {
    if (conn === null || conn.state !== 'authorized') return; // 未入网/挂起/已踢连接一律丢弃
    if (conn.ws.readyState !== conn.ws.OPEN) return; // close 握手期（CLOSING）或半开连接拒收
    const header = readRelayHeader(buf);
    if (header === null) return;
    if (header.srcNodeId !== conn.nodeId) return; // 严禁源地址欺骗
    if (header.dstNodeId === conn.nodeId) return; // 自环不发
    const target = this.conns.get(conn.networkId)?.get(header.dstNodeId);
    if (target === undefined) return; // 目标不在线（或非 authorized）
    if (!this.limiter.tryRelay({ networkId: conn.networkId, nodeId: conn.nodeId, peerNodeId: header.dstNodeId }, buf.length, this.rateKbps)) {
      return;
    }
    target.ws.send(buf, { binary: true }, () => {/* 写失败由 close 事件兜底 */});
  }

  // ------------------------------------------------------------ 路径遥测

  /**
   * path-report（FIX-2）：每条消息视为该节点当前路径视图的**完整快照**——
   * 构建新表整表替换旧表，且只接纳本网当前在线（authorized 且在路由表里）
   * 的对端，总量硬上限 MAX_PATH_REPORTS_PER_NODE。随机伪造的 peerNodeId 在
   * 这里被过滤，内存不随报文放大；内容与旧表一致时不触发 SSE 重渲染。
   */
  private async handleRename(conn: ConnState, message: Record<string, unknown>): Promise<void> {
    if (typeof message['name'] !== 'string') return;
    const trimmed = message['name'].trim();
    if (trimmed.length < 1 || trimmed.length > 64) return;
    if (conn.name === trimmed) return;
    conn.name = trimmed;
    try {
      await this.store.updateMemberProfile(conn.networkId, conn.nodeId, { name: trimmed });
    } catch {
      return;
    }
    if (conn.state === 'authorized') {
      this.broadcast(conn.networkId, { type: 'peer-renamed', nodeId: conn.nodeId, name: trimmed }, conn.nodeId);
    }
    void this.publishTopology(conn.networkId);
  }

  private handlePathReport(conn: ConnState, message: Record<string, unknown>): void {
    const peers = message['peers'];
    if (!Array.isArray(peers)) return;
    const online = this.conns.get(conn.networkId);
    const next = new Map<string, { path: string; rttMs: number }>();
    if (online !== undefined) {
      for (const item of peers) {
        if (next.size >= MAX_PATH_REPORTS_PER_NODE) break;
        if (typeof item !== 'object' || item === null) continue;
        const entry = item as Record<string, unknown>;
        const peerNodeId = normalizeNodeId(entry['peerNodeId']);
        const path = typeof entry['path'] === 'string' ? entry['path'] : null;
        const rttMs = entry['rttMs'];
        if (peerNodeId === null || path === null || path.length > 128 || typeof rttMs !== 'number' || !Number.isFinite(rttMs) || rttMs < 0) {
          continue;
        }
        if (!online.has(peerNodeId)) continue; // 只留本网真实在线的对端
        next.set(peerNodeId, { path, rttMs });
      }
    }
    const changed =
      next.size !== conn.pathReports.size ||
      [...next].some(([peerId, report]) => {
        const old = conn.pathReports.get(peerId);
        return old === undefined || old.path !== report.path || old.rttMs !== report.rttMs;
      });
    conn.pathReports = next;
    if (changed) void this.publishTopology(conn.networkId);
  }

  // ------------------------------------------------------------ NAT 观察（udp-stun 回调）

  applyNatObservation(record: NatObservation): void {
    const key = connKey(record.networkId, record.nodeId);
    const conn = this.conns.get(record.networkId)?.get(record.nodeId) ?? this.hanging.get(key) ?? null;
    if (conn !== null) {
      const prevEndpoint = endpointString(conn.reflexive);
      conn.natType = record.natType;
      conn.reflexive = { ip: record.reflexiveIp, port: record.reflexivePort };
      const nextEndpoint = endpointString(conn.reflexive);
      // FIX-3：在线节点反射端点首次确定或发生变化时向同网在线同伴补发打洞
      // 坐标——节点通常先连 WS 再做 UDP STUN 探测，入网时下发的首条
      // punch-coordinate 里 reflexiveEndpoint 还是 null
      if (conn.state === 'authorized' && nextEndpoint !== prevEndpoint) {
        for (const other of this.conns.get(record.networkId)?.values() ?? []) {
          if (other === conn) continue;
          sendJson(other.ws, {
            type: 'punch-coordinate',
            peerNodeId: conn.nodeId,
            publicKeyHex: conn.publicKeyHex,
            lanEndpoints: conn.lanEndpoints,
            reflexiveEndpoint: nextEndpoint,
            natType: conn.natType,
            startAfterMs: 20,
          });
        }
      }
    }
    const pending = this.pendingNat.get(key) ?? { networkId: record.networkId, nodeId: record.nodeId };
    pending.natType = record.natType;
    pending.lastIp = record.reflexiveIp;
    this.pendingNat.set(key, pending);
    void this.publishTopology(record.networkId);
  }

  /** STUN observes only a live, owner-admitted identity; pending remains non-routing. */
  admitStunProbe(networkId: string, nodeId: string, publicKeyHex: string): symbol | null {
    const conn = this.conns.get(networkId)?.get(nodeId) ?? this.hanging.get(connKey(networkId, nodeId));
    return !this.closed && conn !== undefined && conn.state !== 'closed' &&
      conn.ws.readyState === conn.ws.OPEN && conn.publicKeyHex === publicKeyHex ? conn.stunAdmission : null;
  }

  /** udp-stun 的 public 判定要用到节点上报的 lanEndpoints */
  getLanEndpoints(networkId: string, nodeId: string): readonly string[] {
    const conn = this.conns.get(networkId)?.get(nodeId) ?? this.hanging.get(connKey(networkId, nodeId));
    return conn?.lanEndpoints ?? [];
  }

  // ------------------------------------------------------------ PG-4 钩子

  readonly hooks: GatewayHooks = {
    onMemberChanged: (event: MemberChangedEvent) => this.onMemberChanged(event),
    onNetworkDeleted: (networkId: string) => this.onNetworkDeleted(networkId),
    onNetworkUpdated: (networkId: string) => this.onNetworkUpdated(networkId),
    onSettingsChanged: (settings) => {
      this.rateKbps = settings.relayRateKbps;
    },
    onUserDisabled: (userId: string) => this.onUserDisabled(userId),
  };

  private async onMemberChanged(event: MemberChangedEvent): Promise<void> {
    const key = connKey(event.networkId, event.nodeId);
    // PC-03 fix2：除 rename（不改授权）外的成员动作都是授权事实变化——统一在
    // 入口递增成员代次，使两类在途快照失效：(1) fix1 的在途晋升（连接已在
    // 池中，等其 await 窗口过去后同步复核）；(2) 尚未落地（不在任何池里、钩子
    // 够不到）的在途认证（handleAuth 末尾同步复核）。pause/resume/approve/
    // reject/repin/remove 全部覆盖；重复动作幂等（代次递增本身无可见效果）。
    if (event.action !== 'rename') {
      this.memberEpochs.set(key, (this.memberEpochs.get(key) ?? 0) + 1);
    }
    switch (event.action) {
      case 'approve':
      case 'repin': {
        // 两条动作通向同一升级路径：挂起连接原地升级为 authorized
        await this.promoteHangingConn(event);
        // PC-03：approve 对 paused 成员同样合法（paused→authorized），
        // 挂起的受限连接一并原地恢复
        if (event.action === 'approve') await this.promoteHeldPausedConn(event);
        break;
      }
      case 'reject': {
        const conn = this.hanging.get(key);
        if (conn === undefined) break;
        this.killConn(conn, 'rejected by administrator');
        void this.publishTopology(event.networkId);
        break;
      }
      case 'pause': {
        // fix1：无论连接在路由表还是暂停池，落在任何在途晋升（resume/approve
        // 提升的 await 窗口）之后的 pause 都使旧晋升失效；已在暂停池的重复
        // pause 幂等（代次递增本身无可见效果）
        const conn = this.conns.get(event.networkId)?.get(event.nodeId);
        if (conn === undefined) break; // 已离线或已在暂停池：无连接动作
        this.broadcast(event.networkId, { type: 'peer-paused', nodeId: event.nodeId }, event.nodeId);
        this.demoteToPaused(conn);
        void this.publishTopology(event.networkId);
        break;
      }
      case 'resume': {
        // PC-03：挂起的受限连接原地恢复（以数据库最新授权为准）；离线成员
        // 沿自己的有界退避重连回来，auth 时按最新状态放行
        await this.promoteHeldPausedConn(event);
        void this.publishTopology(event.networkId);
        break;
      }
      case 'remove': {
        const conn = this.conns.get(event.networkId)?.get(event.nodeId);
        if (conn !== undefined) {
          this.broadcast(event.networkId, { type: 'peer-left', nodeId: event.nodeId }, event.nodeId);
          this.killConn(conn, 'removed from network');
        }
        const hang = this.hanging.get(key);
        if (hang !== undefined) {
          this.killConn(hang, 'removed from network');
        }
        const paused = this.pausedConns.get(key);
        if (paused !== undefined) {
          this.killConn(paused, 'removed from network');
        }
        void this.publishTopology(event.networkId);
        break;
      }
      case 'rename': {
        const nextName = typeof event.name === 'string' && event.name.trim() !== '' ? event.name.trim() : null;
        const conn = this.conns.get(event.networkId)?.get(event.nodeId);
        if (conn !== undefined) {
          conn.name = nextName;
          if (nextName !== null) {
            this.broadcast(event.networkId, { type: 'peer-renamed', nodeId: event.nodeId, name: nextName }, event.nodeId);
          }
        }
        const hang = this.hanging.get(key);
        if (hang !== undefined) hang.name = nextName;
        const paused = this.pausedConns.get(key);
        if (paused !== undefined) paused.name = nextName;
        void this.publishTopology(event.networkId);
        break;
      }
    }
  }

  /** approve / repin 共用的挂起连接升级路径（原 onMemberChanged 的 case 体 + fix1 代次复核） */
  private async promoteHangingConn(event: MemberChangedEvent): Promise<void> {
    const key = connKey(event.networkId, event.nodeId);
    const conn = this.hanging.get(key);
    if (conn === undefined) return;
    const epoch = this.admissionEpoch;
    const memberEpoch = this.memberEpochs.get(key) ?? 0;
    const capacityVersion = this.capacityFacts.get(event.networkId)?.factVersion ?? 0;
    // Keep the connection visible to disable/delete hooks throughout async promotion.
    // repin 后库里生效公钥即挂起连接入网时呈验的那把（store 已把
    // candidate 提升为 publicKeyHex）；从库再同步一次，防判定路径变化
    try {
      const members = await this.store.listMembers(event.networkId);
      const member = members.find((m) => m.nodeId === event.nodeId);
      if (member?.status !== 'authorized') return;
      conn.publicKeyHex = member.publicKeyHex;
    } catch {
      this.killConn(conn, 'gateway storage unavailable');
      return;
    }
    // PC-08a fix1：晋升容量以库中最新事实收敛，不依赖先前一次成功广播的快照
    // （传播读库失败时快照滞后）；读不到就退回 hook 维护的快照，不影响授权判定
    let freshCapacity: number | null = null;
    try {
      freshCapacity = (await this.store.getNetwork(event.networkId))?.maxPeers ?? null;
    } catch {
      freshCapacity = null;
    }
    // fix1：代次复核是最后一个 await 之后的同步闸——这里到发送之间没有
    // await，落在 await 窗口内的 pause 已递增代次，旧晋升在此失效
    if (!await this.checkOwnerAdmission(conn.ws, conn.ownerId, epoch) ||
        !this.admissionCurrent(conn.ws, conn.ownerId, epoch) ||
        conn.state !== 'hanging' || this.hanging.get(key) !== conn ||
        (this.memberEpochs.get(key) ?? 0) !== memberEpoch) return;
    this.hanging.delete(key);
    // 容量采纳的同步复核：读库期间无新观察到的事实变化才采纳本次读取；
    // 有变化说明 hook 已把更新值直接应用到池上快照，welcome 照现值发
    if (freshCapacity !== null && (this.capacityFacts.get(event.networkId)?.factVersion ?? 0) === capacityVersion) {
      conn.maxPeers = freshCapacity;
    }
    this.welcomeAuthorized(conn);
    this.registerAndAnnounce(conn);
  }

  /**
   * PC-03：受限控制连接的恢复提升（resume 与 paused→approve 共用）。以数据库
   * 最新授权为准——authorized：原地升级（welcome peers 快照 + 全网公告，与
   * approve 晋级同一条路径）；仍 paused：保持挂起（重复/迟到恢复通知幂等，
   * 新一轮暂停优先）；已删除/撤销/改待审：拒绝并关闭，迟到的恢复消息绝不
   * 重新挂载。返回是否处理了一条挂起连接。
   */
  private async promoteHeldPausedConn(event: { networkId: string; nodeId: string }): Promise<boolean> {
    const key = connKey(event.networkId, event.nodeId);
    const conn = this.pausedConns.get(key);
    if (conn === undefined) return false;
    const epoch = this.admissionEpoch;
    const memberEpoch = this.memberEpochs.get(key) ?? 0;
    const capacityVersion = this.capacityFacts.get(event.networkId)?.factVersion ?? 0;
    let member: MemberRecord | null = null;
    try {
      member = (await this.store.listMembers(event.networkId)).find((m) => m.nodeId === event.nodeId) ?? null;
    } catch {
      this.killConn(conn, 'gateway storage unavailable');
      return true;
    }
    if (member === null || member.status === 'revoked' || member.status === 'mismatch' || member.status === 'pending') {
      // 注意 reason 不得含 "paused"：节点端按 reason 分类恢复语义
      this.killConn(conn, 'membership revoked or removed');
      return true;
    }
    if (member.status === 'paused') return true; // 新一轮暂停已生效：保持受限挂起
    // PC-08a fix1：晋升容量以库中最新事实收敛，不依赖先前一次成功广播的快照；
    // 读不到就退回 hook 维护的快照，不影响授权判定
    let freshCapacity: number | null = null;
    try {
      freshCapacity = (await this.store.getNetwork(event.networkId))?.maxPeers ?? null;
    } catch {
      freshCapacity = null;
    }
    // fix1：代次复核是最后一个 await 之后的同步闸——这里到发送之间没有
    // await，落在 await 窗口内的 pause 已递增代次，旧晋升在此失效
    if (!await this.checkOwnerAdmission(conn.ws, conn.ownerId, epoch) ||
        !this.admissionCurrent(conn.ws, conn.ownerId, epoch) ||
        conn.state !== 'paused' || this.pausedConns.get(key) !== conn ||
        (this.memberEpochs.get(key) ?? 0) !== memberEpoch) return true;
    this.pausedConns.delete(key);
    // 与挂起晋级同款：从库再同步一次公钥，防判定路径变化
    conn.publicKeyHex = member.publicKeyHex;
    // 容量采纳的同步复核：读库期间无新观察到的事实变化才采纳本次读取；
    // 有变化说明 hook 已把更新值直接应用到池上快照，welcome 照现值发
    if (freshCapacity !== null && (this.capacityFacts.get(event.networkId)?.factVersion ?? 0) === capacityVersion) {
      conn.maxPeers = freshCapacity;
    }
    // fix1：恢复即新的授权事实——换发 STUN 准入代次（与节点 connEpoch 的暂停
    // 换代一致）。恢复前在途观察的迟到回包按旧 token 复查不匹配，不落新观察；
    // 恢复后的探测以新 token 登记，主辅槽不跨暂停混配
    conn.stunAdmission = Symbol();
    this.welcomeAuthorized(conn);
    this.registerAndAnnounce(conn);
    return true;
  }

  /**
   * PC-03：pause 不断连——在线连接降级为受限控制连接（pausedConns 池）：
   * 广播 peer-paused 后摘出路由表、清路径遥测，仅承载状态/恢复通知；
   * 帧转发、path-report、rename、STUN 准入全部受限。
   */
  private demoteToPaused(conn: ConnState): void {
    conn.state = 'paused';
    this.removeFromRouting(conn);
    conn.pathReports.clear();
    // fix1：旧授权代次的 STUN 准入随暂停失效（暂停期间 admitStunProbe 本就
    // 查不到此连接；这里换发保证 resume 换代后旧 token 一定不匹配）
    conn.stunAdmission = Symbol();
    this.pausedConns.set(connKey(conn.networkId, conn.nodeId), conn);
    sendJson(conn.ws, { type: 'paused' });
  }

  private removeFromRouting(conn: ConnState): void {
    const net = this.conns.get(conn.networkId);
    if (net !== undefined && net.get(conn.nodeId) === conn) {
      net.delete(conn.nodeId);
      if (net.size === 0) this.conns.delete(conn.networkId);
    }
  }

  /**
   * 统一断连（FIX-1）：先把 state 置为终态 'closed' 并从路由表/挂起池摘除——
   * RFC6455 close 握手窗口内（恶意客户端不回 close 帧时 ws 库最长 30s 仍会
   * 触发 message 事件），state 闸门 + readyState 双重校验让后续帧一律丢弃；
   * 再发 denied、走 close 握手，并安排宽限期后 terminate 强拆，防止恶意
   * 客户端挂住握手让 socket 迟迟不释放。
   */
  private killConn(conn: ConnState, reason: string): void {
    if (conn.state === 'closed') return;
    conn.state = 'closed';
    this.removeFromRouting(conn);
    const key = connKey(conn.networkId, conn.nodeId);
    if (this.hanging.get(key) === conn) this.hanging.delete(key);
    if (this.pausedConns.get(key) === conn) this.pausedConns.delete(key);
    conn.pathReports.clear();
    sendJson(conn.ws, { type: 'denied', reason });
    conn.ws.close(1008, reason.slice(0, 120));
    const killer = setTimeout(() => {
      try {
        conn.ws.terminate();
      } catch {
        /* 已关闭 */
      }
    }, KICK_GRACE_MS);
    killer.unref?.();
  }

  private onNetworkDeleted(networkId: string): void {
    const net = this.conns.get(networkId);
    if (net !== undefined) {
      for (const conn of [...net.values()]) this.killConn(conn, 'network deleted');
    }
    for (const [, conn] of [...this.hanging]) {
      if (conn.networkId === networkId) this.killConn(conn, 'network deleted');
    }
    for (const [, conn] of [...this.pausedConns]) {
      if (conn.networkId === networkId) this.killConn(conn, 'network deleted');
    }
    this.subscribers.delete(networkId);
    this.lastPublishedKbps.delete(networkId);
    // PC-08a fix1：观察状态一并清除——在途 hook 完成的票据复核随之失配，迟到
    // 完成不再落地；entry 消失本身即「删除事实」
    this.capacityFacts.delete(networkId);
  }

  /**
   * PC-08a fix1：网络容量变更（PATCH maxPeers 持久化成功后触发）。异步读库
   * 返回的是**读时快照**而非完成时刻的真值，所以落地前必须两道同步复核：
   * 票据（本读取是否已被更新的读取/删除超越，防乱序旧快照回灌）与幂等
   * （与已传播值同值则无事实变化，不推送不改快照不递增代次）。读库失败直接
   * 放弃且不动 appliedMaxPeers——同值重试 PATCH 即恢复传播，广播缓存滞后也
   * 不会借道这里阻断认证。authorized 连接收增量 {type:'network-updated'}
   * （刻意不发 welcome：那会改变状态并触发节点业务同步）；hanging/paused 池
   * 只更新快照，approve/resume 晋升时另行直读库收敛。
   */
  private async onNetworkUpdated(networkId: string): Promise<void> {
    // 发读取先领票：此后任何更新的读取（或删除清态）都让本次迟到完成作废
    const issued = this.capacityFacts.get(networkId) ?? { readTicket: 0, factVersion: 0, appliedMaxPeers: null };
    const readTicket = issued.readTicket + 1;
    this.capacityFacts.set(networkId, { ...issued, readTicket });
    let network: NetworkRecord | null;
    try {
      network = await this.store.getNetwork(networkId);
    } catch {
      return; // 库暂不可用：放弃本次（applied 不动），auth/welcome 始终直读库不受影响
    }
    if (network === null) return; // 网络已删：断连清理由 onNetworkDeleted 负责
    // 最后应用/广播前的同步复核（此后无 await）：旧快照绝不回灌
    const current = this.capacityFacts.get(networkId);
    if (this.closed || current === undefined || current.readTicket !== readTicket) return;
    if (current.appliedMaxPeers === network.maxPeers) return;
    this.capacityFacts.set(networkId, { ...current, factVersion: current.factVersion + 1, appliedMaxPeers: network.maxPeers });
    // 此处到发送之间没有任何 await：三个池的快照与广播是同一份事实的一次应用
    const net = this.conns.get(networkId);
    if (net !== undefined) {
      for (const conn of net.values()) conn.maxPeers = network.maxPeers;
    }
    for (const [, conn] of this.hanging) {
      if (conn.networkId === networkId) conn.maxPeers = network.maxPeers;
    }
    for (const [, conn] of this.pausedConns) {
      if (conn.networkId === networkId) conn.maxPeers = network.maxPeers;
    }
    this.broadcast(networkId, { type: 'network-updated', networkId, maxPeers: network.maxPeers });
  }

  private onUserDisabled(userId: string): void {
    this.ownerDisabledEpoch.set(userId, ++this.admissionEpoch);
    // 连接的 ownerId 是「网络归属者」：停用某租户即踢掉其名下全部网络的
    // 全部在线节点——收 peer-left 的对象自己也在被踢，广播没有意义，
    // 直接逐一拒绝即可（避免互踢消息穿插在 denied 之前）
    const affected = new Set<string>();
    for (const [networkId, net] of this.conns) {
      for (const conn of [...net.values()]) {
        if (conn.ownerId !== userId) continue;
        this.killConn(conn, 'account disabled');
        affected.add(networkId);
      }
    }
    for (const [, conn] of [...this.hanging]) {
      if (conn.ownerId !== userId) continue;
      this.killConn(conn, 'account disabled');
      affected.add(conn.networkId);
    }
    for (const [, conn] of [...this.pausedConns]) {
      if (conn.ownerId !== userId) continue;
      this.killConn(conn, 'account disabled');
      affected.add(conn.networkId);
    }
    for (const networkId of affected) void this.publishTopology(networkId);
  }

  // ------------------------------------------------------------ 广播与订阅

  /** 向同网其他 authorized 连接广播；excludeNodeId 为发起者 */
  private broadcast(networkId: string, message: Record<string, unknown>, excludeNodeId?: string): void {
    for (const conn of this.conns.get(networkId)?.values() ?? []) {
      if (excludeNodeId !== undefined && conn.nodeId === excludeNodeId) continue;
      sendJson(conn.ws, message);
    }
  }

  /** TopologyProvider：渲染某网络的完整拓扑快照；网络不存在返回 null */
  async renderTopology(networkId: string): Promise<NetworkTopologySnapshot | null> {
    let network: NetworkRecord | null;
    try {
      network = await this.store.getNetwork(networkId);
    } catch {
      return null;
    }
    if (network === null) return null;
    const members = await this.store.listMembers(networkId);
    const online = this.conns.get(networkId) ?? new Map<string, ConnState>();

    const rows: TopologyMemberRow[] = members.map((member) => {
      const conn = online.get(member.nodeId);
      return {
        nodeId: member.nodeId,
        name: member.name,
        note: member.note,
        status: member.status,
        natType: conn?.natType ?? member.natType,
        lastIp: conn?.reflexive?.ip ?? member.lastIp,
        online: conn !== undefined,
        liveRelayKbps: this.limiter.liveRelayKbpsByNode(networkId, member.nodeId),
        cumulativeRelayBytes: member.cumulativeRelayBytes,
        lastSeenAt: member.lastSeenAt,
      };
    });
    const links: TopologyLink[] = [];
    for (const conn of online.values()) {
      for (const [peerNodeId, report] of conn.pathReports) {
        links.push({
          srcNodeId: conn.nodeId,
          peerNodeId,
          path: report.path,
          rttMs: report.rttMs,
          liveRelayKbps: this.limiter.liveRelayKbpsPair(networkId, conn.nodeId, peerNodeId),
        });
      }
    }
    const pendingRows = rows
      .filter((row) => row.status === 'pending')
      .map((row) => ({ nodeId: row.nodeId, name: row.name, lastIp: row.lastIp }));
    return {
      network: {
        id: network.id,
        name: network.name,
        admissionMode: network.admissionMode,
        maxPeers: network.maxPeers,
      },
      summary: {
        onlineDevices: online.size,
        pendingCount: pendingRows.length,
        totalLiveRelayKbps: this.limiter.liveRelayKbpsByNetwork(networkId),
      },
      pending: pendingRows,
      members: rows,
      links,
    };
  }

  /** TopologyProvider：订阅快照推送；返回退订函数 */
  subscribe(networkId: string, cb: (snapshot: NetworkTopologySnapshot) => void): () => void {
    let set = this.subscribers.get(networkId);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(networkId, set);
    }
    set.add(cb);
    return () => {
      const current = this.subscribers.get(networkId);
      if (current === undefined) return;
      current.delete(cb);
      if (current.size === 0) {
        this.subscribers.delete(networkId);
        this.lastPublishedKbps.delete(networkId);
      }
    };
  }

  /** 重渲染并推送快照；渲染失败静默（下一轮 tick 还会拿到） */
  private async publishTopology(networkId: string): Promise<void> {
    const set = this.subscribers.get(networkId);
    if (set === undefined || set.size === 0) return;
    let snapshot: NetworkTopologySnapshot | null;
    try {
      snapshot = await this.renderTopology(networkId);
    } catch {
      return;
    }
    if (snapshot === null) return;
    for (const cb of set) {
      try {
        cb(snapshot);
      } catch {
        /* 单个订阅者写失败不拖累其他订阅者 */
      }
    }
  }

  /** 3s 速率跳动：每网总速率与上次推送值不同才推（恒零不推） */
  private tickRates(): void {
    for (const networkId of this.subscribers.keys()) {
      const total = this.limiter.liveRelayKbpsByNetwork(networkId);
      const last = this.lastPublishedKbps.get(networkId);
      if (last !== undefined && Math.abs(total - last) < 1e-9) continue;
      this.lastPublishedKbps.set(networkId, total);
      void this.publishTopology(networkId);
    }
  }

  // ------------------------------------------------------------ GatewayRuntimeStats

  /** 在线设备数（authorized 连接），供网络视图与管理员用户列表 */
  getOnlineCountByNetwork(networkId: string): number {
    return this.conns.get(networkId)?.size ?? 0;
  }

  getOnlineCountByUser(userId: string): number {
    let total = 0;
    for (const net of this.conns.values()) {
      for (const conn of net.values()) {
        if (conn.ownerId === userId) total += 1;
      }
    }
    return total;
  }

  getRelayKbpsByUser(userId: string): number {
    let total = 0;
    for (const [networkId, net] of this.conns) {
      const owned = [...net.values()].some((conn) => conn.ownerId === userId);
      if (owned) total += this.limiter.liveRelayKbpsByNetwork(networkId);
    }
    return total;
  }

  // ------------------------------------------------------------ 遥测刷盘

  /** 手动触发一次刷盘（内部定时器也走这里）：限速字节 + NAT 变更合并落库 */
  async flushTelemetry(): Promise<void> {
    const drained = this.limiter.drainAllPending();
    const updates = new Map<string, TelemetryUpdate>();
    for (const item of drained) {
      updates.set(connKey(item.networkId, item.nodeId), {
        networkId: item.networkId,
        nodeId: item.nodeId,
        relayBytesDelta: item.bytes,
      });
    }
    for (const nat of this.pendingNat.values()) {
      const key = connKey(nat.networkId, nat.nodeId);
      const existing = updates.get(key) ?? { networkId: nat.networkId, nodeId: nat.nodeId };
      if (nat.natType !== undefined) existing.natType = nat.natType;
      if (nat.lastIp !== undefined) existing.lastIp = nat.lastIp;
      updates.set(key, existing);
    }
    this.pendingNat.clear();
    if (updates.size === 0) return;
    const list = [...updates.values()];
    const seenAt = new Date(this.now()).toISOString();
    for (const update of list) {
      update.lastSeenAt = seenAt; // 只要这次有变更就顺手记 lastSeenAt
    }
    await this.store.flushMemberTelemetry(list);
  }
}
