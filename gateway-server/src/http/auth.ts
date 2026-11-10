// HTTP 层基座（PG-4）：统一 JSON 信封、Cookie 会话、同源写保护（CSRF 防御）、auth 四路由，
// 以及跨路由共享的类型（运行时统计注入、PG-5 钩子）与迷你路由匹配器。
//
// 信封契约：
//   成功 { ok: true, data: T }；失败 { ok: false, error: { code, message } }。
//   HTTP 状态码与语义一致：400 参数错、401 未登录、403 无权限/账号停用/跨站拒绝、
//   404 不存在（含防枚举）、409 配额或状态冲突、500 内部错误脱敏。
//
// 会话：浏览器保存 32B 随机令牌 hex（Cookie `zr_gw_session`），库里只存其 sha256。
// 同源写保护：POST/PATCH/DELETE 一律先过 CSRF 检查——桌面端/CLI 不带 Origin 与
// Sec-Fetch-Site，放行；可辨认的跨站（Sec-Fetch-Site: cross-site 或 Origin host
// 与请求 Host 不一致）一律 403，与宿主 webServer 的同源门同一套语义。
import { createHash, randomBytes } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';

import { hashPassword, verifyPassword } from '../master-key.js';
import { StoreError } from '../store/types.js';
import type {
  GatewayStore,
  MemberStatus,
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
  /** 会话 TTL，默认 7 天 */
  sessionTtlMs: number;
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

/** 成员五态操作（含 DELETE 彻底移除）后的事件，供 PG-5 实时通知 WS 与 SSE */
export interface MemberChangedEvent {
  networkId: string;
  nodeId: string;
  action: 'approve' | 'reject' | 'pause' | 'resume' | 'repin' | 'remove';
  /** 迁移后的成员状态；remove（行已删除）记为 revoked */
  status: MemberStatus;
}

/** PG-5 钩子：HTTP 侧状态变更后通知实时层；钩子抛错不回滚 HTTP 操作 */
export interface GatewayHooks {
  onMemberChanged?: (event: MemberChangedEvent) => void | Promise<void>;
  onNetworkDeleted?: (networkId: string) => void | Promise<void>;
  onSettingsChanged?: (settings: SystemSettings) => void | Promise<void>;
  onUserDisabled?: (userId: string) => void | Promise<void>;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  store: GatewayStore;
  masterKey: Buffer;
  config: ApiServerConfig;
  runtime: GatewayRuntimeStats;
  hooks: GatewayHooks;
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
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

// 未知邮箱时也对一次 scrypt，抹平「邮箱是否存在」的时序侧信道
let dummyHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (dummyHashPromise === null) {
    dummyHashPromise = hashPassword(`timing-equalizer-${randomBytes(16).toString('hex')}`);
  }
  return dummyHashPromise;
}

function isValidEmail(email: string): boolean {
  if (email.length < 3 || email.length > 254) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  if (/\s/.test(email) || email.includes('@', at + 1)) return false;
  return true;
}

// ---------------------------------------------------------------- 钩子

/** 钩子（PG-5 实时层）抛错只影响通知、不回滚已落库的 HTTP 操作 */
export async function runHook<T>(hook: ((arg: T) => void | Promise<void>) | undefined, arg: T): Promise<void> {
  if (hook === undefined) return;
  try {
    await hook(arg);
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

async function handleLogin(ctx: RouteContext): Promise<void> {
  const body = await readJsonObjectBody(ctx.req);
  const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
  const password = typeof body['password'] === 'string' ? body['password'] : '';
  if (email.length === 0 || password.length === 0) {
    throw new ApiError(400, 'INVALID_REQUEST', 'email and password are required');
  }
  const user = await ctx.store.findUserByEmail(email);
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await getDummyPasswordHash()));
  if (user === null || !passwordOk) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'invalid email or password');
  }
  if (!user.active) {
    throw new ApiError(403, 'ACCOUNT_DISABLED', 'this account has been disabled');
  }
  const session = await ctx.store.createSession(user.id, ctx.config.sessionTtlMs);
  ctx.res.setHeader('set-cookie', issueSessionCookie(ctx.req, session.token));
  const { allowSignup, maxNetworksPerUser } = await ctx.store.getSettings();
  sendOk(ctx.res, { user: publicUser(user), allowSignup, maxNetworksPerUser });
}

async function handleSignup(ctx: RouteContext): Promise<void> {
  const settings = await ctx.store.getSettings();
  if (!settings.allowSignup) {
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
  const user = await ctx.store.createUser({
    email,
    passwordHash: await hashPassword(password),
    role: 'user',
  });
  // 自动登录
  const session = await ctx.store.createSession(user.id, ctx.config.sessionTtlMs);
  ctx.res.setHeader('set-cookie', issueSessionCookie(ctx.req, session.token));
  sendOk(ctx.res, { user: publicUser(user), allowSignup: settings.allowSignup, maxNetworksPerUser: settings.maxNetworksPerUser });
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
  const settings = await ctx.store.getSettings();
  const meta = { allowSignup: settings.allowSignup, maxNetworksPerUser: settings.maxNetworksPerUser };
  const token = readSessionToken(ctx.req);
  let user: UserRecord | null = null;
  if (token !== null) {
    try {
      user = await ctx.store.getSessionUser(hashToken(token), Date.now());
    } catch {
      user = null;
    }
  }
  if (user === null) {
    sendOk(ctx.res, { authenticated: false, ...meta });
  } else {
    sendOk(ctx.res, { authenticated: true, user: publicUser(user), ...meta });
  }
}

export function buildAuthRoutes(): RouteDef[] {
  return [
    { method: 'POST', path: '/api/v1/auth/login', handler: handleLogin },
    { method: 'POST', path: '/api/v1/auth/signup', handler: handleSignup },
    { method: 'POST', path: '/api/v1/auth/logout', handler: handleLogout },
    { method: 'GET', path: '/api/v1/auth/me', handler: handleMe },
  ];
}
