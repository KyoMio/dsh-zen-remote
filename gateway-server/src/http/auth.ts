// HTTP 层基座（PG-4）：统一 JSON 信封、Cookie 会话、同源写保护（CSRF 防御）、auth 路由
// （GC-5 起含邮箱 OTP 发码 / 忘记密码重置），以及跨路由共享的类型（运行时统计注入、
// PG-5 钩子、SMTP 配置编解码与 OTP 发送限流器）与迷你路由匹配器。
//
// 信封契约：
//   成功 { ok: true, data: T }；失败 { ok: false, error: { code, message } }。
//   HTTP 状态码与语义一致：400 参数错、401 未登录、403 无权限/账号停用/跨站拒绝、
//   404 不存在（含防枚举）、409 配额或状态冲突、429 限流/冷却/锁定、500 内部错误脱敏。
//
// 会话：浏览器保存 32B 随机令牌 hex（Cookie `zr_gw_session`），库里只存其 sha256。
// 同源写保护：POST/PATCH/DELETE 一律先过 CSRF 检查——桌面端/CLI 不带 Origin 与
// Sec-Fetch-Site，放行；可辨认的跨站（Sec-Fetch-Site: cross-site 或 Origin host
// 与请求 Host 不一致）一律 403，与宿主 webServer 的同源门同一套语义。
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';

import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../master-key.js';
import { sendMail } from '../mail/smtp-client.js';
import type { SmtpSecurityMode } from '../mail/smtp-client.js';
import { renderOtpEmail } from '../mail/templates.js';
import type { MailLocale } from '../mail/templates.js';
import { StoreError } from '../store/types.js';
import type {
  AdmissionMode,
  EmailOtpPurpose,
  ExtendedSystemSettings,
  GatewayStore,
  MemberStatus,
  NatType,
  SystemSettings,
  UserRecord,
  UserRole,
} from '../store/types.js';

// ---------------------------------------------------------------- 共享类型

/** HTTP 层业务拒绝：handler 抛出，dispatcher 统一转信封 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiServerConfig {
  /** 对外可达基础 URL（缺省时 joinUri 的 host 取请求 Host 头） */
  publicUrl: string | undefined;
}

/** PG-5 运行时注入：WS 在线表与实时中继速率的查询口；缺省全 0 */
export interface GatewayRuntimeStats {
  getOnlineCountByNetwork(networkId: string): number;
  getOnlineCountByUser(userId: string): number;
  getRelayKbpsByUser(userId: string): number;
}

export const NOOP_RUNTIME_STATS: GatewayRuntimeStats = {
  getOnlineCountByNetwork: () => 0,
  getOnlineCountByUser: () => 0,
  getRelayKbpsByUser: () => 0,
};

/** 成员五态操作（含 DELETE 彻底移除与 PATCH 改名）后的事件，供 PG-5 实时通知 WS 与 SSE */
export interface MemberChangedEvent {
  networkId: string;
  nodeId: string;
  action: 'approve' | 'reject' | 'pause' | 'resume' | 'repin' | 'remove' | 'rename';
  /** 迁移后的成员状态；remove（行已删除）记为 revoked */
  status: MemberStatus;
  /** action === 'rename' 时的新显示名 */
  name?: string | null;
}

/** PG-5 钩子：HTTP 侧状态变更后通知实时层；钩子抛错不回滚 HTTP 操作 */
export interface GatewayHooks {
  onMemberChanged?: (event: MemberChangedEvent) => void | Promise<void>;
  onNetworkDeleted?: (networkId: string) => void | Promise<void>;
  /** PC-08a / PS-5：网络 PATCH（仅 maxPeers）持久化成功后直传新上限给 hub */
  onNetworkUpdated?: (networkId: string, maxPeers: number) => void | Promise<void>;
  onSettingsChanged?: (settings: SystemSettings) => void | Promise<void>;
  onUserDisabled?: (userId: string) => void | Promise<void>;
}

// ---------------------------------------------------------------- 拓扑快照（PG-5）

/** 一对节点间的路径观测 + 该节点对的实时中转速率 */
export interface TopologyLink {
  srcNodeId: string;
  peerNodeId: string;
  /** 节点自报路径（'lan' / 'p2p' / 'relay' / 'blocked'，PC-16a 起含本机身份阻断），原样透传给控制台 */
  path: string;
  /** 实测往返延迟；null = 未知（中继/阻断路径没有测速协议，未知与实测 0 是两种观测） */
  rttMs: number | null;
  liveRelayKbps: number;
}

/** 拓扑页的成员行：库中五态 + 内存在线状态合并视图 */
export interface TopologyMemberRow {
  nodeId: string;
  name: string | null;
  /** 归属者给设备写的备注（PG-6b 控制台设备列表展示） */
  note: string | null;
  status: MemberStatus;
  /** 在线（WS 已认证入网）优先取内存 natType/lastIp，离线回落库值 */
  natType: NatType;
  lastIp: string | null;
  online: boolean;
  /** 该成员作为发送方的实时中转速率 */
  liveRelayKbps: number;
  cumulativeRelayBytes: number;
  /** 最后一次遥测/入网落库时间；从未上报过为 null（控制台显示「刚刚」） */
  lastSeenAt: string | null;
}

/** GET /networks/:id/topology 与 SSE 共用的完整快照 */
export interface NetworkTopologySnapshot {
  network: { id: string; name: string; admissionMode: AdmissionMode; maxPeers: number };
  summary: { onlineDevices: number; pendingCount: number; totalLiveRelayKbps: number };
  pending: Array<{ nodeId: string; name: string | null; lastIp: string | null }>;
  members: TopologyMemberRow[];
  links: TopologyLink[];
}

/** 拓扑数据的窄接口：PG-5 的 ws-hub 实现，routes-topology 只依赖这里 */
export interface TopologyProvider {
  renderTopology(networkId: string): Promise<NetworkTopologySnapshot | null>;
  /** 订阅某网络的快照推送（SSE）；返回退订函数。回调抛错由订阅方自行兜住 */
  subscribe(networkId: string, cb: (snapshot: NetworkTopologySnapshot) => void): () => void;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  store: GatewayStore;
  masterKey: Buffer;
  config: ApiServerConfig;
  runtime: GatewayRuntimeStats;
  hooks: GatewayHooks;
  /** PG-5 实时层；未装配（无 topology 选项）时拓扑路由不注册 */
  topology?: TopologyProvider;
}

export type RouteHandler = (ctx: RouteContext, params: Record<string, string>) => Promise<void>;

export interface RouteDef {
  method: string;
  /** `/api/v1/networks/:id/rotate-key` 形态的模式，`:x` 为路径参数 */
  path: string;
  handler: RouteHandler;
}

// ---------------------------------------------------------------- 信封

export function sendOk(res: ServerResponse, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: true, data }));
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy(); // 头已发出无法改写状态码，只能断开
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: false, error: { code, message } }));
}

/** StoreError → ApiError：码表钉死，未知业务码一律 404（不向客户端泄漏内部细节） */
export function storeErrorToApiError(err: StoreError): ApiError {
  switch (err.code) {
    case 'duplicate-email':
      return new ApiError(409, 'EMAIL_TAKEN', 'email already registered');
    case 'quota-exceeded':
      return new ApiError(409, 'QUOTA_EXCEEDED', 'network quota exhausted');
    case 'limit-reached':
      return new ApiError(409, 'LIMIT_REACHED', 'network member limit reached');
    case 'invalid-transition':
      return new ApiError(409, 'INVALID_TRANSITION', 'member status transition not allowed');
    // GC-2 邮箱 OTP 三态：冷却（重发太快）、错码、连错锁定——锁定的验证码连正确码也拒绝
    case 'otp-cooldown':
      return new ApiError(429, 'OTP_COOLDOWN', 'a verification code was issued recently, wait before requesting another');
    case 'otp-invalid':
      return new ApiError(400, 'OTP_INVALID', 'verification code is invalid or expired');
    case 'otp-locked':
      return new ApiError(429, 'OTP_LOCKED', 'verification code locked after too many failed attempts');
    default:
      return new ApiError(404, 'NOT_FOUND', 'resource not found');
  }
}

// ---------------------------------------------------------------- 请求体

const MAX_BODY_BYTES = 256 * 1024;

/** 读 JSON 对象体；空体返回 {}；非法 JSON / 非对象 → 400 INVALID_JSON */
export async function readJsonObjectBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, 'INVALID_JSON', 'request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// ---------------------------------------------------------------- 会话 Cookie

export const SESSION_COOKIE_NAME = 'zr_gw_session';

export function readSessionToken(req: IncomingMessage): string | null {
  const header = readHeader(req, 'cookie');
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      const token = part.slice(eq + 1).trim();
      return token.length > 0 ? token : null;
    }
  }
  return null;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function requestIsHttps(req: IncomingMessage): boolean {
  return (
    (req.socket instanceof TLSSocket && req.socket.encrypted) ||
    readHeader(req, 'x-forwarded-proto') === 'https'
  );
}

export function issueSessionCookie(req: IncomingMessage, token: string): string {
  const secure = requestIsHttps(req) ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Strict${secure}`;
}

export function clearSessionCookie(req: IncomingMessage): string {
  const secure = requestIsHttps(req) ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0${secure}`;
}

// ---------------------------------------------------------------- 同源写保护

const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

/**
 * 可辨认的跨站写请求判定：Sec-Fetch-Site: cross-site，或 Origin host 与请求 Host
 * 不一致（`Origin: null` / 解析失败也视为跨站）。两个头都缺 → 桌面端/CLI 形态，放行。
 */
export function isCrossSiteWrite(req: IncomingMessage): boolean {
  if (!WRITE_METHODS.has(req.method ?? '')) return false;
  if (readHeader(req, 'sec-fetch-site')?.toLowerCase() === 'cross-site') return true;
  const origin = readHeader(req, 'origin');
  if (origin === undefined || origin.length === 0) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  const host = (readHeader(req, 'host') ?? '').toLowerCase();
  return host.length === 0 || originHost !== host;
}

// ---------------------------------------------------------------- 认证

export async function requireUser(ctx: RouteContext): Promise<UserRecord> {
  const token = readSessionToken(ctx.req);
  if (token !== null) {
    const user = await ctx.store.getSessionUser(hashToken(token), Date.now());
    if (user !== null) return user;
  }
  throw new ApiError(401, 'UNAUTHENTICATED', 'login required');
}

export async function requireAdmin(ctx: RouteContext): Promise<UserRecord> {
  const user = await requireUser(ctx);
  if (user.role !== 'admin') {
    throw new ApiError(403, 'FORBIDDEN', 'admin role required');
  }
  return user;
}

/** 客户端可见的用户形态：永不携带 passwordHash */
export function publicUser(user: UserRecord): { id: string; email: string; role: UserRole } {
  return { id: user.id, email: user.email, role: user.role };
}

/** 认证上下文（/auth/me、login、signup、换绑邮箱响应）里的用户形态：publicUser + 验证时刻 */
export function authUserPayload(user: UserRecord): {
  id: string;
  email: string;
  role: UserRole;
  emailVerifiedAt: string | null;
} {
  return { ...publicUser(user), emailVerifiedAt: user.emailVerifiedAt };
}

// 未知邮箱时也对一次 scrypt，抹平「邮箱是否存在」的时序侧信道
let dummyHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (dummyHashPromise === null) {
    dummyHashPromise = hashPassword(`timing-equalizer-${randomBytes(16).toString('hex')}`);
  }
  return dummyHashPromise;
}

export function isValidEmail(email: string): boolean {
  if (email.length < 3 || email.length > 254) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  if (/\s/.test(email) || email.includes('@', at + 1)) return false;
  return true;
}

/** 从 Cookie 解析当前会话令牌并做 sha256；无 Cookie 返回 null。供改密时传 keepTokenHash */
export function currentSessionTokenHash(req: IncomingMessage): string | null {
  const token = readSessionToken(req);
  return token === null ? null : hashToken(token);
}

/** 直连对端地址（不信任 X-Forwarded-For：可伪造头不能当限流键）；无地址归入同一桶 */
export function requestClientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------- SMTP 配置编解码（GC-5，GC-6a/6b 共用）

/** 库里 `smtp_config_enc` 密文对应的明文形态（JSON 序列化后经 encryptSecret 加密落库） */
export interface StoredSmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurityMode;
  username?: string;
  password?: string;
  fromAddress: string;
  fromName?: string;
  /** 校验服务器证书，缺省 true（smtp-client 的同名语义） */
  rejectUnauthorized?: boolean;
}

/** 明文配置 → 密文（管理后端保存时用；GC-6b） */
export function encodeSmtpConfig(config: StoredSmtpConfig, masterKey: Buffer): string {
  return encryptSecret(JSON.stringify(config), masterKey);
}

/**
 * 密文 → 明文配置。null/空串、解密失败（钥匙不匹配）、JSON 损坏、必填字段缺失都
 * 归一为 null（视作未配置）——配置损坏降级为 503 SMTP_NOT_CONFIGURED，绝不 500 卡死登录。
 */
export function decodeSmtpConfig(smtpConfigEnc: string | null, masterKey: Buffer): StoredSmtpConfig | null {
  if (smtpConfigEnc === null || smtpConfigEnc.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecret(smtpConfigEnc, masterKey));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const cfg = parsed as Partial<StoredSmtpConfig>;
  if (typeof cfg.host !== 'string' || typeof cfg.port !== 'number' || typeof cfg.fromAddress !== 'string') {
    return null;
  }
  if (cfg.security !== 'tls' && cfg.security !== 'starttls' && cfg.security !== 'none') return null;
  return {
    host: cfg.host,
    port: cfg.port,
    security: cfg.security,
    username: cfg.username,
    password: cfg.password,
    fromAddress: cfg.fromAddress,
    fromName: cfg.fromName,
    rejectUnauthorized: cfg.rejectUnauthorized,
  };
}

/** host 与 fromAddress 都非空白才算已配置（其余字段允许留空：匿名发信、无显示名） */
export function isSmtpConfigured(config: StoredSmtpConfig | null): boolean {
  return config !== null && config.host.trim().length > 0 && config.fromAddress.trim().length > 0;
}

/** auth 与账号路由共用的运行环境：扩展设置 + 解码后的 SMTP 配置 + 派生会话 TTL */
export interface AuthEnvironment {
  ext: ExtendedSystemSettings;
  smtp: StoredSmtpConfig | null;
  smtpConfigured: boolean;
  /** 登录/注册会话 TTL：sessionTtlDays * 86_400_000（钳位 1..90 天发生在 store 解析层） */
  sessionTtlMs: number;
}

/** 现场读取扩展设置并解码 SMTP 配置（volatile 语义：每次请求现读，不拍快照） */
export async function loadAuthEnvironment(ctx: RouteContext): Promise<AuthEnvironment> {
  const ext = await ctx.store.getExtendedSettings();
  const smtp = decodeSmtpConfig(ext.smtpConfigEnc, ctx.masterKey);
  return {
    ext,
    smtp,
    smtpConfigured: isSmtpConfigured(smtp),
    sessionTtlMs: ext.sessionTtlDays * 86_400_000,
  };
}

/** 顺带清理过期验证码（登录/注册路径捎带）；失败不影响主流程 */
function pruneExpiredOtpsBestEffort(ctx: RouteContext): void {
  void ctx.store.pruneExpiredOtps(Date.now()).catch(() => {});
}

// ---------------------------------------------------------------- 邮箱 OTP（GC-5）

/** 验证码有效期 */
export const OTP_TTL_MS = 10 * 60_000;
/** 同 (email, purpose) 两次签发的最短间隔 */
export const OTP_COOLDOWN_MS = 60_000;
/** 连续错输该次数即锁定（store 侧 decideOtpVerify 消费该值） */
export const OTP_MAX_ATTEMPTS = 5;
/** 同 IP 发码滑动窗宽度 */
export const OTP_IP_WINDOW_MS = 15 * 60_000;
/** 同 IP 窗内最多发码次数（send-otp 与换绑邮箱申请共用一个计数器） */
export const OTP_IP_MAX_REQUESTS = 20;

/** 验证码只在 HMAC 里参与比对：masterKey 混入密钥位，库里泄露 code_hash 推不出明文码 */
export function hashOtpCode(masterKey: Buffer, purpose: EmailOtpPurpose, email: string, code: string): string {
  return createHmac('sha256', masterKey).update(`${purpose}:${email.trim().toLowerCase()}:${code}`).digest('hex');
}

/** 6 位数字随机码（randomInt 无模偏差；首位允许 0，padStart 补齐） */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** 全表清扫的触发周期（每 N 次 tryConsume 扫一次，均摊 O(1)） */
const RATE_LIMITER_SWEEP_INTERVAL = 64;

/**
 * 按键（来源 IP）的内存滑动窗限流器：窗口内第 maxRequests 次起拒绝。
 * 每次消费惰性剔除过期时间戳，并低频全表清扫空键，长期运行内存不无限增长。
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private calls = 0;

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  /** 窗口内配额未满则记账并放行（true）；已满直接拒绝（false，拒绝不计入窗口） */
  tryConsume(key: string, now: number = Date.now()): boolean {
    this.calls += 1;
    if (this.calls % RATE_LIMITER_SWEEP_INTERVAL === 0) this.sweep(now);
    const fresh = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (fresh.length >= this.maxRequests) {
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(key, fresh);
    return true;
  }

  /** 清空全部计数（测试隔离用） */
  clear(): void {
    this.hits.clear();
    this.calls = 0;
  }

  /** 全表清扫：删空键、缩列表，防止长期运行内存无限增长 */
  private sweep(now: number): void {
    for (const [key, hits] of this.hits) {
      const fresh = hits.filter((t) => t > now - this.windowMs);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }
}

/** send-otp 与换绑邮箱申请共用的发码限流器（同一进程一个网关，进程级单例） */
export const otpSendRateLimiter = new SlidingWindowRateLimiter(OTP_IP_WINDOW_MS, OTP_IP_MAX_REQUESTS);

/**
 * 签发验证码并发信。发信失败（含配置非法）统一抛 502 SMTP_SEND_FAILED，SmtpClientError
 * 的消息细节（更不可能含 SMTP 密码）一律不透传给客户端。smtp 必须已过 isSmtpConfigured。
 */
export async function issueAndSendOtp(
  ctx: RouteContext,
  env: AuthEnvironment,
  smtp: StoredSmtpConfig,
  email: string,
  purpose: EmailOtpPurpose,
  locale: MailLocale,
): Promise<void> {
  const code = generateOtpCode();
  await ctx.store.issueEmailOtp({
    email,
    purpose,
    codeHash: hashOtpCode(ctx.masterKey, purpose, email, code),
    ttlMs: OTP_TTL_MS,
    cooldownMs: OTP_COOLDOWN_MS,
  });
  const rendered = renderOtpEmail({
    locale,
    purpose,
    code,
    ttlMinutes: OTP_TTL_MS / 60_000,
    publicUrl: env.ext.publicUrl ?? ctx.config.publicUrl,
  });
  try {
    await sendMail(smtp, { to: email, subject: rendered.subject, text: rendered.text });
  } catch {
    throw new ApiError(502, 'SMTP_SEND_FAILED', 'failed to send the verification email');
  }
}

// ---------------------------------------------------------------- 认证上下文 payload

/**
 * 公开策略段（匿名与登录态都带）：注册开关、邮箱验证要求、SMTP 是否已配置、
 * 两项配额默认值。控制台首屏与注册/忘记密码表单据此渲染。
 */
export interface AuthPublicPolicy {
  allowSignup: boolean;
  requireEmailVerification: boolean;
  smtpConfigured: boolean;
  maxNetworksPerUser: number;
  defaultMaxPeers: number;
}

/** /auth/me、login、signup 返回的配额视图（GC-2 有效组解析；admin 三项上限不受组约束） */
export async function buildUserQuotaPayload(
  ctx: RouteContext,
  user: UserRecord,
): Promise<{
  groupId: string;
  assignedGroupId: string;
  groupCode: string;
  groupName: string;
  groupExpiresAt: string | null;
  isExpiredFallback: boolean;
  maxNetworks: number | null;
  maxPeersPerNetwork: number;
  relayRateKbps: number;
  monthlyRelayQuotaBytes: number | null;
  usedNetworks: number;
  usedMonthlyRelayBytes: number;
}> {
  const effective = await ctx.store.resolveEffectiveUserQuota(user.id);
  const usedNetworks = (await ctx.store.listNetworksByOwner(user.id)).length;
  const isAdmin = user.role === 'admin';
  return {
    groupId: effective.group.id,
    assignedGroupId: effective.assignedGroupId,
    groupCode: effective.group.code,
    groupName: effective.group.name,
    groupExpiresAt: effective.groupExpiresAt,
    isExpiredFallback: effective.isExpiredFallback,
    // admin 建网不受组配额约束（store 同语义），maxPeersPerNetwork 仍给 64 的硬上限
    maxNetworks: isAdmin ? null : effective.group.maxNetworks,
    maxPeersPerNetwork: isAdmin ? 64 : effective.group.maxPeersPerNetwork,
    relayRateKbps: effective.group.relayRateKbps,
    monthlyRelayQuotaBytes: isAdmin ? null : effective.group.monthlyRelayQuotaBytes,
    usedNetworks,
    usedMonthlyRelayBytes: effective.monthlyRelayUsedBytes,
  };
}

/** /auth/me 的返回：匿名带公开策略；登录态另有 user 与配额视图 */
export type AuthContextPayload = AuthPublicPolicy &
  (
    | { authenticated: false }
    | {
        authenticated: true;
        user: ReturnType<typeof authUserPayload>;
        quota: Awaited<ReturnType<typeof buildUserQuotaPayload>>;
      }
  );

/** 登录/注册响应体：user + quota + 公开策略段（不含 authenticated——会话刚建立，语义自明） */
export async function buildSessionPayload(
  ctx: RouteContext,
  user: UserRecord,
  env: AuthEnvironment,
): Promise<AuthPublicPolicy & { user: ReturnType<typeof authUserPayload>; quota: Awaited<ReturnType<typeof buildUserQuotaPayload>> }> {
  return {
    user: authUserPayload(user),
    quota: await buildUserQuotaPayload(ctx, user),
    allowSignup: env.ext.allowSignup,
    requireEmailVerification: env.ext.requireEmailVerification,
    smtpConfigured: env.smtpConfigured,
    maxNetworksPerUser: env.ext.maxNetworksPerUser,
    defaultMaxPeers: env.ext.defaultMaxPeers,
  };
}

/** /auth/me 的组装：匿名带公开策略，登录态复用登录响应体并加 authenticated */
export async function buildAuthContextPayload(ctx: RouteContext, user: UserRecord | null): Promise<AuthContextPayload> {
  const env = await loadAuthEnvironment(ctx);
  if (user === null) {
    return {
      authenticated: false,
      allowSignup: env.ext.allowSignup,
      requireEmailVerification: env.ext.requireEmailVerification,
      smtpConfigured: env.smtpConfigured,
      maxNetworksPerUser: env.ext.maxNetworksPerUser,
      defaultMaxPeers: env.ext.defaultMaxPeers,
    };
  }
  return { authenticated: true, ...(await buildSessionPayload(ctx, user, env)) };
}

// ---------------------------------------------------------------- 钩子

/** 钩子（PG-5 实时层）抛错只影响通知、不回滚已落库的 HTTP 操作 */
export async function runHook<Args extends unknown[]>(
  hook: ((...args: Args) => void | Promise<void>) | undefined,
  ...args: Args
): Promise<void> {
  if (hook === undefined) return;
  try {
    await hook(...args);
  } catch {
    /* 实时层故障不阻断 HTTP 响应 */
  }
}

// ---------------------------------------------------------------- 路由匹配

export function matchRoute(
  routes: readonly RouteDef[],
  method: string,
  segments: readonly string[],
): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const def of routes) {
    if (def.method !== method) continue;
    const pattern = def.path.split('/').filter((s) => s.length > 0);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < pattern.length; i++) {
      const pat = pattern[i] as string;
      const seg = segments[i] as string;
      if (pat.startsWith(':')) {
        params[pat.slice(1)] = seg;
      } else if (pat !== seg) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: def.handler, params };
  }
  return null;
}

// ---------------------------------------------------------------- auth 路由

/** 读 body 里的 6 位数字验证码（`otpCode` 主字段，兼容 `otp` 别名）；缺失/格式错 → 400 */
function readOtpCode(body: Record<string, unknown>): string {
  const raw = body['otpCode'] ?? body['otp'];
  if (typeof raw !== 'string' || !/^\d{6}$/.test(raw)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'a 6-digit verification code is required');
  }
  return raw;
}

async function handleLogin(ctx: RouteContext): Promise<void> {
  const body = await readJsonObjectBody(ctx.req);
  const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
  const password = typeof body['password'] === 'string' ? body['password'] : '';
  if (email.length === 0 || password.length === 0) {
    throw new ApiError(400, 'INVALID_REQUEST', 'email and password are required');
  }
  const env = await loadAuthEnvironment(ctx);
  const user = await ctx.store.findUserByEmail(email);
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await getDummyPasswordHash()));
  if (user === null || !passwordOk) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'invalid email or password');
  }
  if (!user.active) {
    throw new ApiError(403, 'ACCOUNT_DISABLED', 'this account has been disabled');
  }
  const session = await ctx.store.createSession(user.id, env.sessionTtlMs);
  ctx.res.setHeader('set-cookie', issueSessionCookie(ctx.req, session.token));
  pruneExpiredOtpsBestEffort(ctx);
  sendOk(ctx.res, await buildSessionPayload(ctx, user, env));
}

async function handleSignup(ctx: RouteContext): Promise<void> {
  const env = await loadAuthEnvironment(ctx);
  if (!env.ext.allowSignup) {
    throw new ApiError(403, 'SIGNUP_DISABLED', 'signup is disabled on this gateway');
  }
  const body = await readJsonObjectBody(ctx.req);
  const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
  const password = typeof body['password'] === 'string' ? body['password'] : '';
  if (!isValidEmail(email)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'a valid email is required');
  }
  if (password.length < 8 || password.length > 128) {
    throw new ApiError(400, 'INVALID_REQUEST', 'password must be 8..128 characters');
  }
  // 邮箱验证开启时先核销 signup 验证码（错码不建用户），成功即视为已验证
  let emailVerifiedAt: string | null = null;
  if (env.ext.requireEmailVerification) {
    const code = readOtpCode(body);
    await ctx.store.verifyAndConsumeEmailOtp({
      email,
      purpose: 'signup',
      codeHash: hashOtpCode(ctx.masterKey, 'signup', email, code),
      maxAttempts: OTP_MAX_ATTEMPTS,
    });
    emailVerifiedAt = new Date().toISOString();
  }
  const user = await ctx.store.createUser({
    email,
    passwordHash: await hashPassword(password),
    role: 'user',
    emailVerifiedAt,
  });
  // 自动登录
  const session = await ctx.store.createSession(user.id, env.sessionTtlMs);
  ctx.res.setHeader('set-cookie', issueSessionCookie(ctx.req, session.token));
  pruneExpiredOtpsBestEffort(ctx);
  sendOk(ctx.res, await buildSessionPayload(ctx, user, env));
}

async function handleLogout(ctx: RouteContext): Promise<void> {
  const token = readSessionToken(ctx.req);
  if (token !== null) {
    await ctx.store.deleteSession(hashToken(token));
  }
  ctx.res.setHeader('set-cookie', clearSessionCookie(ctx.req));
  sendOk(ctx.res, { loggedOut: true });
}

async function handleMe(ctx: RouteContext): Promise<void> {
  const token = readSessionToken(ctx.req);
  let user: UserRecord | null = null;
  if (token !== null) {
    try {
      user = await ctx.store.getSessionUser(hashToken(token), Date.now());
    } catch {
      user = null;
    }
  }
  sendOk(ctx.res, await buildAuthContextPayload(ctx, user));
}

/**
 * POST /api/v1/auth/send-otp：注册 / 忘记密码发码。
 * reset_password 严格防枚举：邮箱不存在或已停用时同样返回成功，不发信不写库。
 */
async function handleSendOtp(ctx: RouteContext): Promise<void> {
  const body = await readJsonObjectBody(ctx.req);
  const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
  const purpose = body['purpose'];
  const locale: MailLocale = body['locale'] === 'en' ? 'en' : 'zh';
  if (!isValidEmail(email)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'a valid email is required');
  }
  if (purpose !== 'signup' && purpose !== 'reset_password') {
    throw new ApiError(400, 'INVALID_REQUEST', "purpose must be 'signup' or 'reset_password'");
  }
  if (!otpSendRateLimiter.tryConsume(requestClientIp(ctx.req))) {
    throw new ApiError(429, 'RATE_LIMITED', 'too many verification code requests, try again later');
  }
  const env = await loadAuthEnvironment(ctx);
  if (!env.smtpConfigured || env.smtp === null) {
    throw new ApiError(503, 'SMTP_NOT_CONFIGURED', 'smtp is not configured on this gateway');
  }
  if (purpose === 'signup') {
    if (!env.ext.allowSignup) {
      throw new ApiError(403, 'SIGNUP_DISABLED', 'signup is disabled on this gateway');
    }
    const existing = await ctx.store.findUserByEmail(email);
    if (existing !== null) {
      throw new ApiError(409, 'EMAIL_TAKEN', 'email already registered');
    }
  } else {
    const existing = await ctx.store.findUserByEmail(email);
    if (existing === null || !existing.active) {
      // 防枚举：不做任何写操作，补一次 scrypt 抹平与真实路径的时长差，照样报成功
      await getDummyPasswordHash();
      sendOk(ctx.res, { sent: true, cooldownSec: OTP_COOLDOWN_MS / 1000 });
      return;
    }
  }
  await issueAndSendOtp(ctx, env, env.smtp, email, purpose, locale);
  sendOk(ctx.res, { sent: true, cooldownSec: OTP_COOLDOWN_MS / 1000 });
}

/**
 * POST /api/v1/auth/reset-password：忘记密码重置。验证码核销通过后改密且不留
 * keepTokenHash——该用户全部会话立即吊销；响应恒为成功，不暴露邮箱是否存在。
 */
async function handleResetPassword(ctx: RouteContext): Promise<void> {
  const body = await readJsonObjectBody(ctx.req);
  const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
  const newPassword = typeof body['newPassword'] === 'string' ? body['newPassword'] : '';
  if (!isValidEmail(email)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'a valid email is required');
  }
  const code = readOtpCode(body);
  if (newPassword.length < 8 || newPassword.length > 128) {
    throw new ApiError(400, 'INVALID_REQUEST', 'password must be 8..128 characters');
  }
  await ctx.store.verifyAndConsumeEmailOtp({
    email,
    purpose: 'reset_password',
    codeHash: hashOtpCode(ctx.masterKey, 'reset_password', email, code),
    maxAttempts: OTP_MAX_ATTEMPTS,
  });
  const user = await ctx.store.findUserByEmail(email);
  if (user !== null && user.active) {
    await ctx.store.updateUserPassword(user.id, await hashPassword(newPassword));
  } else {
    await getDummyPasswordHash(); // 与真实改密路径的 scrypt 时长对齐
  }
  sendOk(ctx.res, { reset: true });
}

export function buildAuthRoutes(): RouteDef[] {
  return [
    { method: 'POST', path: '/api/v1/auth/login', handler: handleLogin },
    { method: 'POST', path: '/api/v1/auth/signup', handler: handleSignup },
    { method: 'POST', path: '/api/v1/auth/logout', handler: handleLogout },
    { method: 'GET', path: '/api/v1/auth/me', handler: handleMe },
    { method: 'POST', path: '/api/v1/auth/send-otp', handler: handleSendOtp },
    { method: 'POST', path: '/api/v1/auth/reset-password', handler: handleResetPassword },
  ];
}
