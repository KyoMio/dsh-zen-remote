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
// pendingRelayBytes，由串行化 flush 取批次快照经 store.flushMemberTelemetry
// 落库、成功后才确认该批（PC-19：失败保留待写累计，不丢字节）。
// 拓扑订阅（SSE）在成员变动、path-report、3s 速率跳动时重渲染快照推送。
import { randomBytes } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

import { DEFAULT_SETTINGS, currentUtcYearMonth } from '../store/types.js';
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
/** PC-19 第二片：关停末批的收尾轮数上界（追平在途/尾轮 + 写库在途期间的少量新增） */
const MAX_CLOSE_FLUSH_ROUNDS = 8;
/** GC-3：中转数据帧类型（relay-frame.ts 的 PeerFrameType.DATA），月度配额门禁只拦这一种 */
const RELAY_FRAME_TYPE_DATA = 0x03;

/**
 * GC-3：网络属主的有效配额快照（内存缓存）。relayBinary 是同步热路径，月度
 * 门禁与按组限速都只读这里的内存值；缓存由首帧/入网注册惰性加载，UTC 月份
 * 切换、组配额到期（expiresAtMs，GC-fix-batch1 R2）、refreshQuota、
 * onSettingsChanged（默认组配额随 settings 双向同步）时失效重拉。store 才是
 * 事实来源——快照只为避免每帧三次 store 查询。
 */
interface OwnerQuotaSnapshot {
  ownerId: string;
  isAdmin: boolean;
  /** 有效组的实时中继速率（admin 同样按所在组速率） */
  relayRateKbps: number;
  /** null = 不限月度中转流量；admin 恒不受月度门禁拦截 */
  monthlyRelayQuotaBytes: number | null;
  /** 快照时刻该属主当月（UTC）已落库的中转字节 */
  dbUsedBytes: number;
  /** 快照对应的 UTC 年月（YYYY-MM），跨月即失效重拉 */
  yearMonth: string;
  /**
   * 组配额到期时刻的毫秒值（GC-fix-batch1 R2）；null = 不跟踪（未设到期，或
   * 已是到期回退态——回退后 groupExpiresAt 仍是过去时间，设 null 防止每帧
   * 都触发过期重查）。
   */
  expiresAtMs: number | null;
  /**
   * 读取 DB 使用量之前捕获的 flush 提交序号（GC-fix-batch1 R5）：快照的
   * dbUsedBytes 只包含该序号之前的落库字节；flush 推进时仅当
   * seqBeforeRead < flushSeq 才叠加本批字节，防止「flush 前查到的旧值 +
   * flush 后增量」重复叠加。
   */
  seqBeforeRead: number;
}

/**
 * path-report 行的合法路径枚举（PC-16a）：节点自报的既有 lan/p2p/relay 三值
 * 加 blocked（本机 TOFU 身份阻断——对端在网关侧在线，但本机拒绝一切握手）。
 * 枚举外的值整行拒绝，绝不默认翻译成 relay：网关存储的是节点声明的观测，
 * 不是网关的猜测。
 */
const PATH_REPORT_PATHS: readonly string[] = ['lan', 'p2p', 'relay', 'blocked'];
type PeerReportPath = (typeof PATH_REPORT_PATHS)[number];

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
  /** 该节点上报到各 peer 的路径观测（PC-16a：路径限合法枚举，RTT 可为 null=未知） */
  pathReports: Map<string, { path: PeerReportPath; rttMs: number | null }>;
}

interface PeerView {
  nodeId: string;
  publicKeyHex: string;
  name: string | null;
  lanEndpoints: string[];
  natType: NatType;
  reflexiveEndpoint: string | null;
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
  // PS-5：单通道刷盘合流——同一时刻至多一个在途 flushTelemetry，重叠调用共享同一 Promise 并通过 flushQueued 续刷一轮。
  private flushInFlight: Promise<void> | null = null;
  private flushQueued = false;
  /** PC-19 第二片：close 共享同一真实结果——重复/并发调用不得提前成功 */
  private closePromise: Promise<void> | null = null;
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
  // PS-5：各网络已同步的 maxPeers 缓存（{ maxPeers, seq }：seq 用于抗 A->B->A 并发 PATCH 乱序），网络删除时清理。
  private readonly networkMaxPeers = new Map<string, { maxPeers: number; seq: number }>();
  // GC-3：networkId → 属主配额快照（OwnerQuotaSnapshot；惰性加载，跨月/refreshQuota/settings 变更失效）
  private readonly ownerQuotaByNetwork = new Map<string, OwnerQuotaSnapshot>();
  // GC-3：在途快照加载去重——并发帧与 refreshQuota 共享同一次 store 读，不重复查询
  private readonly ownerQuotaLoading = new Map<string, Promise<OwnerQuotaSnapshot | null>>();
  // GC-3：受月度配额约束的属主尚未刷盘的中转字节（relayBinary 放行时累计、flush 落库成功后扣减）
  private readonly pendingRelayBytesByOwner = new Map<string, number>();
  // GC-3：月度配额耗尽被静默丢弃的 DATA 帧计数（按网络；单测与排障观测量）
  private readonly monthlyQuotaDroppedByNetwork = new Map<string, number>();
  // GC-fix-batch1 R5：networkId → 属主 id 的最近观测（handleAuth/入网注册/中继/快照加载
  // 任意路径拿到 ownerId 都回写）。快照缺失（冷缓存/被停用清掉）时 flush 仍能按它找到
  // 属主扣减 pending；属主被停用后刻意保留，让在途尾批 flush 也能正确对账清零。
  private readonly networkOwnerById = new Map<string, string>();
  // GC-fix-batch1 R5：flush 提交序号（每次成功落库 +1）。快照记录读取时的序号，
  // flush 推进 dbUsedBytes 前比对，防止异步读取与 flush 交错时重复叠加/漏加。
  private committedFlushSeq = 0;

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

  /**
   * 关停（PC-19 第二片）：先停止接收与周期写入（closed 闸 + 定时器 + 摘除全部
   * 连接），再经 flushTelemetry **同一串行入口**补末批——追平在途轮与已合并
   * 尾轮，并有界收尾写库在途期间到达的少量新增；末批确认后才 resolve（组合根
   * 据此保证关 store 前无待确认批次）。末批自身的墙钟预算由调用方施加（见
   * StartGatewayOptions.closeBudgetMs）；重复/并发 close 共享同一真实结果。
   */
  close(telemetryBudgetMs = 3_000): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closePromise = this.doClose(telemetryBudgetMs);
    return this.closePromise;
  }

  private async doClose(telemetryBudgetMs: number): Promise<void> {
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
    await this.finalFlushOnClose(telemetryBudgetMs);
  }

  private warnIncompleteFinalFlush(reason: string): void {
    const summary = this.pendingTelemetrySummary();
    console.warn(
      `[gateway] final telemetry flush incomplete: ${reason}; unconfirmed: ${summary.bytes} bytes across ${summary.members} members, ${summary.natObservations} NAT observations`,
    );
  }

  /**
   * 关停末批（PS-5）：在有界时间预算内尽力完成遥测刷盘。遇到存储错误、超时
   * 或轮数耗尽时不再拒绝关停流程，改为记录 warning 告警并正常收尾放行。
   */
  private async finalFlushOnClose(telemetryBudgetMs: number): Promise<void> {
    const budgetMs = Math.max(1, telemetryBudgetMs);
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    const timeoutSentinel = Symbol('telemetry-timeout');
    const flushLoop = (async (): Promise<symbol | null> => {
      for (let round = 1; ; round++) {
        if (finished) return null;
        try {
          await this.flushTelemetry();
        } catch (error) {
          if (!finished) {
            const msg = error instanceof Error ? error.message : String(error);
            this.warnIncompleteFinalFlush(`flush failed (${msg})`);
          }
          return null;
        }
        if (finished) return null;
        const pending = this.limiter.snapshotAllPending();
        if (pending.length === 0 && this.pendingNat.size === 0) return null;
        if (round >= MAX_CLOSE_FLUSH_ROUNDS) {
          if (!finished) {
            this.warnIncompleteFinalFlush(`did not settle after ${MAX_CLOSE_FLUSH_ROUNDS} rounds`);
          }
          return null;
        }
      }
    })();
    try {
      const outcome = await Promise.race([
        flushLoop,
        new Promise<symbol>((resolve) => {
          timer = setTimeout(() => resolve(timeoutSentinel), budgetMs);
          timer.unref?.();
        }),
      ]);
      if (outcome === timeoutSentinel) {
        finished = true;
        this.warnIncompleteFinalFlush(`exceeded ${budgetMs}ms shutdown telemetry budget`);
      }
    } finally {
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 待确认遥测摘要（关停失败报告与诊断用）：字节累计、涉及成员数、NAT 观测条数 */
  pendingTelemetrySummary(): { bytes: number; members: number; natObservations: number } {
    const pending = this.limiter.snapshotAllPending();
    return {
      bytes: pending.reduce((sum, p) => sum + p.bytes, 0),
      members: pending.length,
      natObservations: this.pendingNat.size,
    };
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
    // GC-fix-batch1 R5：属主表随入网注册回写（对账兜底）
    this.networkOwnerById.set(conn.networkId, conn.ownerId);
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
    // GC-3：入网注册即预热属主配额快照——首条业务帧大概率已可按组速率/月度门禁判定
    void this.loadOwnerQuota(conn.networkId).then((snapshot) => this.storeOwnerQuota(conn.networkId, snapshot));
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
    // PS-5：读库前记录缓存容量代次，用于末尾同步判别并发 PATCH 是否已推送新上限。
    const preReadSeq = this.networkMaxPeers.get(networkId)?.seq ?? 0;
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
    // GC-fix-batch1 R5：拿到属主即登记（flush 对账与冷缓存扣减依赖这张表）
    this.networkOwnerById.set(networkId, network.ownerId);
    // GC-fix-batch1 R1：非管理员属主的用户组每网设备上限原子压进入网事务——
    // 网络 maxPeers 高于组上限时，超出组额的新席位在这里（同一事务内）被拒。
    // 管理员属主不传 cap（豁免组上限）。
    let maxPeersCap: number | undefined;
    try {
      const owner = await this.store.findUserById(network.ownerId);
      if (owner !== null && owner.role !== 'admin') {
        const quota = await this.store.resolveEffectiveUserQuota(network.ownerId, this.now());
        maxPeersCap = quota.group.maxPeersPerNetwork;
      }
    } catch {
      deny(ws, 'gateway storage unavailable');
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
        maxPeersCap,
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
    const effectiveMaxPeers = this.resolveNetworkMaxPeers(networkId, preReadSeq, network.maxPeers, network.maxPeers);
    this.replaceExisting(networkId, nodeId);
    const conn: ConnState = {
      ws,
      stunAdmission: Symbol(),
      state: 'hanging',
      networkId,
      nodeId,
      ownerId: network.ownerId,
      maxPeers: effectiveMaxPeers,
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
        sendJson(ws, { type: 'welcome', status: 'pending', maxPeers: conn.maxPeers });
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
        sendJson(ws, { type: 'welcome', status: 'paused', maxPeers: conn.maxPeers });
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
   * 原样转交，网关永远没有明文。经令牌桶限速（速率取属主有效组的
   * relayRateKbps，快照缺失时回退全局 rateKbps），超限丢弃（背压由发送端
   * 的可靠层负责），转发字节计入滑窗与待刷盘计数。
   *
   * GC-3 月度中转门禁：属主非 admin 且组设了 monthlyRelayQuotaBytes 时，
   * 已落库字节 + 本机未刷盘字节达到上限后**静默丢弃 DATA (0x03) 帧**——
   * 不转发、不计限速桶、不断开连接（信令与控制帧照常，配额恢复或跨月后
   * 自行恢复转发）。HELLO/ACK/SACK/PING/PONG/RST 控制帧、WS 文本信令与
   * UDP STUN 探测完全不受门禁影响。
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
    const quota = this.currentOwnerQuota(conn.networkId);
    const isDataFrame = header.frameType === RELAY_FRAME_TYPE_DATA;
    // 受月度配额约束的属主视图（非 admin 且组设了 monthlyRelayQuotaBytes）；null = 不受约束
    const meteredQuota =
      quota !== null && !quota.isAdmin && quota.monthlyRelayQuotaBytes !== null ? quota : null;
    if (
      isDataFrame && meteredQuota !== null && meteredQuota.monthlyRelayQuotaBytes !== null &&
      meteredQuota.dbUsedBytes + (this.pendingRelayBytesByOwner.get(meteredQuota.ownerId) ?? 0) >=
        meteredQuota.monthlyRelayQuotaBytes
    ) {
      // 月度配额耗尽：DATA 静默丢弃（可观测计数），控制帧照常转发
      this.monthlyQuotaDroppedByNetwork.set(
        conn.networkId,
        (this.monthlyQuotaDroppedByNetwork.get(conn.networkId) ?? 0) + 1,
      );
      return;
    }
    const effectiveRateKbps = quota === null ? this.rateKbps : quota.relayRateKbps;
    if (!this.limiter.tryRelay({ networkId: conn.networkId, nodeId: conn.nodeId, peerNodeId: header.dstNodeId }, buf.length, effectiveRateKbps)) {
      return;
    }
    target.ws.send(buf, { binary: true }, () => {/* 写失败由 close 事件兜底 */});
    // GC-fix-batch1 R5：放行的帧无条件记账——不限于 DATA、不要求快照已加载。
    // 快照缺失（冷缓存）时旧代码漏记，flush 后扣不到、月度门禁判定值永久偏低
    // （泄漏）；limiter 记账与 flushMemberTelemetry 落库都是全帧类型口径，这里的
    // 未刷盘增量必须同口径才能与 dbUsedBytes 收敛。
    this.networkOwnerById.set(conn.networkId, conn.ownerId);
    this.pendingRelayBytesByOwner.set(
      conn.ownerId,
      (this.pendingRelayBytesByOwner.get(conn.ownerId) ?? 0) + buf.length,
    );
  }

  // ------------------------------------------------------------ 属主配额快照（GC-3）

  /** 拉取并返回一个网络的属主配额快照；网络/属主不存在或 store 暂不可用返回 null（不缓存） */
  private async loadOwnerQuota(networkId: string): Promise<OwnerQuotaSnapshot | null> {
    const inFlight = this.ownerQuotaLoading.get(networkId);
    if (inFlight !== undefined) return inFlight;
    const load = (async (): Promise<OwnerQuotaSnapshot | null> => {
      try {
        const network = await this.store.getNetwork(networkId);
        if (network === null) return null;
        this.networkOwnerById.set(networkId, network.ownerId);
        const owner = await this.store.findUserById(network.ownerId);
        if (owner === null) return null;
        // GC-fix-batch1 R5：DB 使用量读取之前捕获 flush 序号与属主停用代次——
        // 读取在途期间若 flush 提交 / 属主被停用，据此判定快照是否仍然有效
        const seqBeforeRead = this.committedFlushSeq;
        const disabledEpochAtRead = this.ownerDisabledEpoch.get(network.ownerId) ?? 0;
        const quota = await this.store.resolveEffectiveUserQuota(network.ownerId, this.now());
        // 异步读取期间属主被停用/重触发：快照已失效，绝不把过期值写回缓存
        if ((this.ownerDisabledEpoch.get(network.ownerId) ?? 0) !== disabledEpochAtRead) return null;
        // GC-fix-batch1 R2：仅「未回退且确实设了到期时刻」时跟踪到期；已回退的
        // groupExpiresAt 仍是过去时间，设 null 防止每帧都触发过期重查
        const parsedExpiresAt = quota.groupExpiresAt !== null ? Date.parse(quota.groupExpiresAt) : Number.NaN;
        const expiresAtMs =
          !quota.isExpiredFallback && quota.groupExpiresAt !== null && Number.isFinite(parsedExpiresAt)
            ? parsedExpiresAt
            : null;
        return {
          ownerId: network.ownerId,
          isAdmin: owner.role === 'admin',
          relayRateKbps: quota.group.relayRateKbps,
          monthlyRelayQuotaBytes: quota.group.monthlyRelayQuotaBytes,
          dbUsedBytes: quota.monthlyRelayUsedBytes,
          yearMonth: quota.yearMonth,
          expiresAtMs,
          seqBeforeRead,
        };
      } catch {
        return null; // store 暂不可用：本帧按无快照放行，下一帧重试
      } finally {
        this.ownerQuotaLoading.delete(networkId);
      }
    })();
    this.ownerQuotaLoading.set(networkId, load);
    return load;
  }

  /** 写回快照；hub 已关停或快照为 null（网络/属主已消失）时不缓存 */
  private storeOwnerQuota(networkId: string, snapshot: OwnerQuotaSnapshot | null): void {
    if (snapshot === null || this.closed) return;
    this.ownerQuotaByNetwork.set(networkId, snapshot);
  }

  /**
   * 同步取当前有效快照（relayBinary 热路径用）；缓存缺失、UTC 月份已切换
   * （旧月用量对新月无意义）或组配额已到到期时刻（GC-fix-batch1 R2：回落默认组
   * 配额必须准时生效）时视作未命中——本帧按无快照放行，同时触发后台加载，
   * 下一帧起按新值生效。并发帧共享同一在途加载。
   */
  private currentOwnerQuota(networkId: string): OwnerQuotaSnapshot | null {
    const cached = this.ownerQuotaByNetwork.get(networkId);
    if (cached !== undefined) {
      const expired =
        currentUtcYearMonth(this.now()) !== cached.yearMonth ||
        (cached.expiresAtMs !== null && this.now() >= cached.expiresAtMs);
      if (!expired) return cached;
      this.ownerQuotaByNetwork.delete(networkId); // 跨月 / 组配额已到期：作废重拉
    }
    void this.loadOwnerQuota(networkId).then((snapshot) => this.storeOwnerQuota(networkId, snapshot));
    return null;
  }

  /**
   * GC-3：管理动作（改组 / 续期 / 改组配额 / 月度限额调整）后的失效入口，供
   * GC-6a 接线。传 userId 时重拉该属主名下全部已缓存网络的快照，不传时全量
   * 重拉；await 返回后下一帧即按新速率 / 新月度上限生效。从未加载过的网络
   * 没有旧值可失效，首帧本就走惰性加载。
   */
  async refreshQuota(userId?: string): Promise<void> {
    const targets: string[] = [];
    for (const [networkId, entry] of this.ownerQuotaByNetwork) {
      if (userId === undefined || entry.ownerId === userId) targets.push(networkId);
    }
    for (const networkId of targets) this.ownerQuotaByNetwork.delete(networkId);
    await Promise.all(
      targets.map((networkId) =>
        this.loadOwnerQuota(networkId).then((snapshot) => this.storeOwnerQuota(networkId, snapshot)),
      ),
    );
  }

  /**
   * GC-3：与 onUserDisabled 同语义的公共入口（GC-6a 接线）——递增属主准入
   * 代次并断开该用户全部名下网络的在线 / 挂起 / 暂停 WS 连接。
   */
  async evictUser(userId: string): Promise<void> {
    this.onUserDisabled(userId);
  }

  /** GC-3：月度配额耗尽被静默丢弃的 DATA 帧计数；不传 networkId 返回全网关总数 */
  getMonthlyQuotaDroppedCount(networkId?: string): number {
    if (networkId === undefined) {
      let total = 0;
      for (const count of this.monthlyQuotaDroppedByNetwork.values()) total += count;
      return total;
    }
    return this.monthlyQuotaDroppedByNetwork.get(networkId) ?? 0;
  }

  // ------------------------------------------------------------ 路径遥测

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

  /**
   * path-report（FIX-2 / PC-16a）：每条消息视为该节点当前路径视图的**完整
   * 快照**——构建新表整表替换旧表（空表 `peers: []` 同样整表生效，缺失的行
   * 直接消失，不合并保留幽灵边），且只接纳本网当前在线（authorized 且在
   * 路由表里）的对端，总量硬上限 MAX_PATH_REPORTS_PER_NODE。行形状严格校验
   * （PC-16a）：peerNodeId 必须是合法 8 hex 且**不指向自己**，path 必须在
   * PATH_REPORT_PATHS 枚举内，rttMs 为 null（未知——中继/阻断路径没有测速
   * 协议）或有限非负数；任一不符整行丢弃，绝不默认翻译成 relay。随机伪造
   * 的 peerNodeId 在这里被过滤，内存不随报文放大；内容与旧表一致时不触发
   * SSE 重渲染（null 与 0 是不同的观测，严格 !== 比较下不会互相吞掉）。
   */
  private handlePathReport(conn: ConnState, message: Record<string, unknown>): void {
    const peers = message['peers'];
    if (!Array.isArray(peers)) return;
    const online = this.conns.get(conn.networkId);
    const next = new Map<string, { path: PeerReportPath; rttMs: number | null }>();
    if (online !== undefined) {
      for (const item of peers) {
        if (next.size >= MAX_PATH_REPORTS_PER_NODE) break;
        if (typeof item !== 'object' || item === null) continue;
        const entry = item as Record<string, unknown>;
        const peerNodeId = normalizeNodeId(entry['peerNodeId']);
        const path = entry['path'];
        const rttMs = entry['rttMs'];
        const rttValid = rttMs === null || (typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs >= 0);
        if (
          peerNodeId === null || peerNodeId === conn.nodeId ||
          typeof path !== 'string' || !PATH_REPORT_PATHS.includes(path) || !rttValid
        ) {
          continue;
        }
        if (!online.has(peerNodeId)) continue; // 只留本网真实在线的对端
        next.set(peerNodeId, { path: path as PeerReportPath, rttMs });
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
    // PC-19 shutdown fix1：close 开始后不再接纳观测——关闭后的观测不是「已接收」
    // 数据（组合根先关 UDP，正常路径不存在此类观测；库级调用方后关 UDP 时在途
    // 回调的迟到送达在此被拒收，绝不静默积累成未确认残余）
    if (this.closed) return;
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
    // PC-19 fix1 R2：新观测落成新 record，绝不原地改旧 record——flush 快照持有
    // 的引用即观测身份，确认按引用相等只摘除确为本批的记录（同值复探或
    // 值变走又变回都会产生新对象，不会被旧批的确认误吞）
    this.pendingNat.set(key, {
      networkId: record.networkId,
      nodeId: record.nodeId,
      natType: record.natType,
      lastIp: record.reflexiveIp,
    });
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
    onNetworkUpdated: (networkId: string, maxPeers: number) => this.onNetworkUpdated(networkId, maxPeers),
    onSettingsChanged: (settings) => {
      this.rateKbps = settings.relayRateKbps;
      // GC-3：三项配额键在 settings ↔ 默认组间双向同步——settings 变更意味着
      // 默认组配额可能已变，属主快照一律作废（下一帧惰性重拉新值）
      this.ownerQuotaByNetwork.clear();
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
    const preReadSeq = this.networkMaxPeers.get(event.networkId)?.seq ?? 0;
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
    conn.maxPeers = this.resolveNetworkMaxPeers(event.networkId, preReadSeq, freshCapacity, conn.maxPeers);
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
    const preReadSeq = this.networkMaxPeers.get(event.networkId)?.seq ?? 0;
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
    conn.maxPeers = this.resolveNetworkMaxPeers(event.networkId, preReadSeq, freshCapacity, conn.maxPeers);
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
    this.networkMaxPeers.delete(networkId);
    // GC-3：网络的属主配额快照与丢弃计数随网络消失（loadOwnerQuota 在途完成时
    // 若网络已删会返回 null，不会把孤儿条目写回）
    this.ownerQuotaByNetwork.delete(networkId);
    this.monthlyQuotaDroppedByNetwork.delete(networkId);
  }

  private resolveNetworkMaxPeers(
    networkId: string,
    preReadSeq: number,
    dbMaxPeers: number | null,
    fallback: number,
  ): number {
    const currentCached = this.networkMaxPeers.get(networkId);
    if (currentCached !== undefined && currentCached.seq !== preReadSeq) {
      return currentCached.maxPeers;
    }
    if (currentCached === undefined && dbMaxPeers !== null) {
      this.networkMaxPeers.set(networkId, { maxPeers: dbMaxPeers, seq: 0 });
    }
    return dbMaxPeers ?? currentCached?.maxPeers ?? fallback;
  }

  /**
   * PS-5：网络容量变更（PATCH maxPeers 持久化成功后同一 event-loop turn 同步
   * 直传）。同值幂等去重；authorized 连接收增量 {type:'network-updated'}，
   * hanging/paused 池同步刷新快照。
   */
  private onNetworkUpdated(networkId: string, maxPeers: number): void {
    if (this.closed || typeof maxPeers !== 'number' || !Number.isInteger(maxPeers) || maxPeers < 2) return;
    const prev = this.networkMaxPeers.get(networkId);
    if (prev?.maxPeers === maxPeers) return;
    this.networkMaxPeers.set(networkId, { maxPeers, seq: (prev?.seq ?? 0) + 1 });
    const net = this.conns.get(networkId);
    if (net !== undefined) {
      for (const conn of net.values()) conn.maxPeers = maxPeers;
    }
    for (const [, conn] of this.hanging) {
      if (conn.networkId === networkId) conn.maxPeers = maxPeers;
    }
    for (const [, conn] of this.pausedConns) {
      if (conn.networkId === networkId) conn.maxPeers = maxPeers;
    }
    this.broadcast(networkId, { type: 'network-updated', networkId, maxPeers });
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
    // GC-fix-batch1 R5：停用即清该属主的配额快照、月度丢弃计数与待刷字节——
    // 快照留着会在重新启用后用旧值判定，pending 留着会污染后续月度门禁；
    // networkOwnerById 刻意保留：停用瞬间 rateLimiter 里可能还有未刷完的在途帧，
    // 保留让最终 flush 仍能按属主找到账目、把 pending 正确清零。
    for (const [networkId, entry] of [...this.ownerQuotaByNetwork]) {
      if (entry.ownerId !== userId) continue;
      this.ownerQuotaByNetwork.delete(networkId);
      this.monthlyQuotaDroppedByNetwork.delete(networkId);
    }
    this.pendingRelayBytesByOwner.delete(userId);
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

  /**
   * 触发一次刷盘（内部定时器、手动调用与未来关停补刷共用同一入口）。
   * PC-19 fix1 意图合并：空闲即开一轮；已有在途轮时全部重叠意图合并为至多
   * 一个尾轮（共享同一个 promise），绝不并发写库、不为每次调用排独立任务。
   * 每个调用方观察自己所属轮的完成/失败：开轮者得该轮结果，合并者共享尾轮
   * 结果（尾轮快照在开跑时取，覆盖登记前后到达的累计）。任何一轮失败只回给
   * 所属调用方，不毒化状态机（下一轮照常），也没有后台自动重试——失败批次
   * 原样保留待下一个正常入口。
   */
  flushTelemetry(): Promise<void> {
    if (this.flushInFlight !== null) {
      this.flushQueued = true;
      return this.flushInFlight;
    }
    const run = (async () => {
      try {
        do {
          this.flushQueued = false;
          await this.doFlushTelemetry();
        } while (this.flushQueued);
      } finally {
        this.flushInFlight = null;
        this.flushQueued = false;
      }
    })();
    this.flushInFlight = run;
    return run;
  }

  /** 单轮刷盘：取稳定批次快照（限速字节 + NAT 变更合并）→ 写库 → 成功才确认该批 */
  private async doFlushTelemetry(): Promise<void> {
    const byteBatch = this.limiter.snapshotAllPending();
    // NAT record 不可变（新观测永远换新对象，见 applyNatObservation）：快照持有
    // record 引用即观测身份，写库在途的新观测不影响本批内容
    const natBatch = [...this.pendingNat];
    const updates = new Map<string, TelemetryUpdate>();
    for (const item of byteBatch) {
      updates.set(connKey(item.networkId, item.nodeId), {
        networkId: item.networkId,
        nodeId: item.nodeId,
        relayBytesDelta: item.bytes,
      });
    }
    for (const [, record] of natBatch) {
      const key = connKey(record.networkId, record.nodeId);
      const existing = updates.get(key) ?? { networkId: record.networkId, nodeId: record.nodeId };
      if (record.natType !== undefined) existing.natType = record.natType;
      if (record.lastIp !== undefined) existing.lastIp = record.lastIp;
      updates.set(key, existing);
    }
    if (updates.size === 0) return;
    const list = [...updates.values()];
    const seenAt = new Date(this.now()).toISOString();
    for (const update of list) {
      update.lastSeenAt = seenAt; // 只要这次有变更就顺手记 lastSeenAt
    }
    await this.store.flushMemberTelemetry(list);
    // DB 成功才确认该批：扣减快照字节；NAT 条目仅当仍是快照那份 record（引用
    // 相等）时摘除——在途新观测是新对象，保留待下轮。失败时确认整体不发生，
    // 待写累计原样保留待下轮。
    this.limiter.confirmFlushed(byteBatch);
    for (const [key, record] of natBatch) {
      if (this.pendingNat.get(key) === record) this.pendingNat.delete(key);
    }
    // GC-3 / GC-fix-batch1 R5：落库成功后（提交序号 +1）按属主对账——
    // 1) 无条件扣减未刷盘计数：属主经 networkOwnerById 找（快照缺失的冷缓存网络
    //    也必须扣），减到 <=0 删键，防 Map 泄漏与负值漂移；
    // 2) 推进配额快照 dbUsedBytes：同属主全部已缓存网络共享月度配额，一起推进；
    //    仅 entry.seqBeforeRead < flushSeq 时叠加（快照读取早于本批提交才算「旧值
    //    + 本批增量」，防止与异步加载交错时重复叠加），推进后序号同步前移。
    const flushSeq = ++this.committedFlushSeq;
    const confirmedByNetwork = new Map<string, number>();
    for (const item of byteBatch) {
      confirmedByNetwork.set(item.networkId, (confirmedByNetwork.get(item.networkId) ?? 0) + item.bytes);
    }
    const confirmedByOwner = new Map<string, number>();
    for (const [networkId, bytes] of confirmedByNetwork) {
      const ownerId = this.networkOwnerById.get(networkId) ?? this.ownerQuotaByNetwork.get(networkId)?.ownerId;
      if (ownerId === undefined) continue; // 网络/属主均已消失：字节已落库，无内存状态可对账
      confirmedByOwner.set(ownerId, (confirmedByOwner.get(ownerId) ?? 0) + bytes);
    }
    for (const [ownerId, delta] of confirmedByOwner) {
      const pending = this.pendingRelayBytesByOwner.get(ownerId);
      if (pending === undefined) continue; // 已被清掉（如属主停用）：不得减成负值
      const next = pending - delta;
      if (next > 0) this.pendingRelayBytesByOwner.set(ownerId, next);
      else this.pendingRelayBytesByOwner.delete(ownerId);
    }
    const yearMonth = seenAt.slice(0, 7);
    for (const entry of this.ownerQuotaByNetwork.values()) {
      const delta = confirmedByOwner.get(entry.ownerId);
      if (delta === undefined) continue;
      if (entry.yearMonth !== yearMonth) continue; // 跨月旧快照：作废重拉时不叠加
      if (entry.seqBeforeRead >= flushSeq) continue; // 读取晚于本批提交：db 值已含本批
      entry.dbUsedBytes += delta;
      entry.seqBeforeRead = flushSeq;
    }
  }
}
