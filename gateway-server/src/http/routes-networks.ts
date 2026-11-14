// 虚拟网络与五态成员管理路由（PG-4）。
//
// 租户数据隔离：所有接口严格校验 network.ownerId === 当前用户 id——admin 也只
// 管理自己名下的网络，他人网络一律 404（防枚举），不做「admin 可见全网」。
//
// joinUri 拼装：`zr-net://<publicHost>/<networkId>#<joinKey>`，publicHost 优先取
// config.publicUrl 的 host:port（反代后的对外可达地址），缺省取请求 Host 头。
// 明文 joinKey 只在归属者视角的响应里出现，库中永远是 AES-256-GCM 密文。
import { randomBytes } from 'node:crypto';

import { decryptSecret, encryptSecret } from '../master-key.js';
import { ApiError, readJsonObjectBody, requireUser, runHook, sendOk } from './auth.js';
import type { RouteContext, RouteDef } from './auth.js';
import type {
  AdmissionMode,
  MemberProfilePatch,
  MemberRecord,
  NetworkPatch,
  NetworkRecord,
  TransitionAction,
} from '../store/types.js';

const ADMISSION_MODES: readonly AdmissionMode[] = ['key', 'manual', 'both'];

/** 高熵 joinKey：32B 随机 hex（64 字符） */
function generateJoinKey(): string {
  return randomBytes(32).toString('hex');
}

function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1).toLowerCase() : hostname.toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a > 255 || b > 255) return false;
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

function extractHostname(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']');
    return close === -1 ? hostHeader : hostHeader.slice(1, close);
  }
  const colon = hostHeader.indexOf(':');
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

/**
 * 解析邀请链接的协议头与 authority（对齐插件端 `parseInviteUri` 的默认端口 19393 与公私网 TLS 推断）：
 * - 配置了 `publicUrl` 时：严格遵循其 `https:` / `http:` 协议；若未显式写端口（如反代 443/80），补齐默认端口，
 *   防止节点端把无端口邀请链接误回落到 19393；
 * - 未配 `publicUrl` 时：从 `X-Forwarded-Proto` 与 `Host` 推断；公网 IP 直连跑明文 HTTP（如 Docker 19393 裸跑）
 *   时发出 `zr-net+insecure://`，避免节点端把公网地址误走 `wss://` 握手失败；私网/回环继续保持简短 `zr-net://`。
 */
function buildJoinEndpoint(ctx: RouteContext): {
  scheme: 'zr-net' | 'zr-nets' | 'zr-net+insecure';
  authority: string;
  gatewayUrl: string;
} {
  if (ctx.config.publicUrl !== undefined) {
    const pub = new URL(ctx.config.publicUrl);
    const isTls = pub.protocol === 'https:';
    const isPrivate = isLoopbackOrPrivateHostname(pub.hostname);
    const authority = pub.port !== '' ? pub.host : `${pub.hostname}:${isTls ? '443' : '80'}`;
    const scheme = isTls ? (isPrivate ? 'zr-nets' : 'zr-net') : (isPrivate ? 'zr-net' : 'zr-net+insecure');
    return { scheme, authority, gatewayUrl: pub.origin };
  }
  const authority = ctx.req.headers['host'] ?? '';
  const hostname = extractHostname(authority);
  const forwardedProto = String(ctx.req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim().toLowerCase();
  const isTls = forwardedProto === 'https';
  const isPrivate = hostname === '' || isLoopbackOrPrivateHostname(hostname);
  const scheme = isTls ? (isPrivate ? 'zr-nets' : 'zr-net') : (isPrivate ? 'zr-net' : 'zr-net+insecure');
  const gatewayUrl = authority !== '' ? `${isTls ? 'https' : 'http'}://${authority}` : '';
  return { scheme, authority, gatewayUrl };
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_REQUEST', 'name must be a string');
  }
  const name = value.trim();
  if (name.length < 1 || name.length > 32) {
    throw new ApiError(400, 'INVALID_REQUEST', 'name must be 1..32 characters');
  }
  return name;
}

function parseAdmissionMode(value: unknown): AdmissionMode {
  if (typeof value !== 'string' || !ADMISSION_MODES.includes(value as AdmissionMode)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'admissionMode must be one of: key, manual, both');
  }
  return value as AdmissionMode;
}

function parseMaxPeers(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 64) {
    throw new ApiError(400, 'INVALID_REQUEST', 'maxPeers must be an integer in [2, 64]');
  }
  return value;
}

/** 归属者视角的网络视图：解密 joinKey 拼完整 joinUri，附带设备统计 */
async function networkView(ctx: RouteContext, network: NetworkRecord): Promise<Record<string, unknown>> {
  const joinKey = decryptSecret(network.joinKeyEnc, ctx.masterKey);
  const members = await ctx.store.listMembers(network.id);
  let totalDevices = 0; // 占席位成员：authorized + paused + mismatch
  let pendingCount = 0;
  for (const m of members) {
    if (m.status === 'authorized' || m.status === 'paused' || m.status === 'mismatch') {
      totalDevices += 1;
    } else if (m.status === 'pending') {
      pendingCount += 1;
    }
  }
  const endpoint = buildJoinEndpoint(ctx);
  return {
    id: network.id,
    name: network.name,
    admissionMode: network.admissionMode,
    maxPeers: network.maxPeers,
    createdAt: network.createdAt,
    joinKey,
    joinUri: `${endpoint.scheme}://${endpoint.authority}/${network.id}#${joinKey}`,
    gatewayUrl: endpoint.gatewayUrl,
    onlineDevices: ctx.runtime.getOnlineCountByNetwork(network.id),
    totalDevices,
    pendingCount,
  };
}

/** 归属校验：不存在或他人网络一律 404（防枚举） */
async function loadOwnedNetwork(ctx: RouteContext, userId: string, networkId: string): Promise<NetworkRecord> {
  const network = await ctx.store.getNetwork(networkId);
  if (network === null || network.ownerId !== userId) {
    throw new ApiError(404, 'NOT_FOUND', 'network not found');
  }
  return network;
}

// ---------------------------------------------------------------- 网络路由

async function handleListNetworks(ctx: RouteContext): Promise<void> {
  const user = await requireUser(ctx);
  const networks = await ctx.store.listNetworksByOwner(user.id);
  const views = [];
  for (const network of networks) {
    views.push(await networkView(ctx, network));
  }
  sendOk(ctx.res, views);
}

async function handleCreateNetwork(ctx: RouteContext): Promise<void> {
  const user = await requireUser(ctx);
  const body = await readJsonObjectBody(ctx.req);
  const name = parseName(body['name']);
  const settings = await ctx.store.getSettings();
  const admissionMode = body['admissionMode'] === undefined ? 'both' : parseAdmissionMode(body['admissionMode']);
  const maxPeers = body['maxPeers'] === undefined ? settings.defaultMaxPeers : parseMaxPeers(body['maxPeers']);
  const joinKey = generateJoinKey();
  const network = await ctx.store.createNetwork({
    ownerId: user.id,
    name,
    admissionMode,
    joinKeyEnc: encryptSecret(joinKey, ctx.masterKey),
    maxPeers,
  });
  sendOk(ctx.res, await networkView(ctx, network));
}

async function handlePatchNetwork(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  const user = await requireUser(ctx);
  const networkId = params['id'] ?? '';
  await loadOwnedNetwork(ctx, user.id, networkId);
  const body = await readJsonObjectBody(ctx.req);
  const patch: NetworkPatch = {};
  if (body['name'] !== undefined) patch.name = parseName(body['name']);
  if (body['admissionMode'] !== undefined) patch.admissionMode = parseAdmissionMode(body['admissionMode']);
  if (body['maxPeers'] !== undefined) patch.maxPeers = parseMaxPeers(body['maxPeers']);
  const updated = await ctx.store.updateNetwork(networkId, patch);
  if (updated === null) {
    throw new ApiError(404, 'NOT_FOUND', 'network not found');
  }
  // PC-08a：容量变化才通知实时层——仅改 name/admissionMode 不伪造容量事实；
  // 接收方（ws-hub）以库中最新事实为准收敛，重复同值 PATCH 不产生重复推送
  if (patch.maxPeers !== undefined) {
    await runHook(ctx.hooks.onNetworkUpdated, networkId);
  }
  sendOk(ctx.res, await networkView(ctx, updated));
}

async function handleDeleteNetwork(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  const user = await requireUser(ctx);
  const networkId = params['id'] ?? '';
  await loadOwnedNetwork(ctx, user.id, networkId);
  await ctx.store.deleteNetwork(networkId); // network_members 由 store 级联清除
  await runHook(ctx.hooks.onNetworkDeleted, networkId); // PG-5 据此断开在线 WS 节点
  sendOk(ctx.res, { id: networkId, deleted: true });
}

async function handleRotateKey(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  const user = await requireUser(ctx);
  const networkId = params['id'] ?? '';
  await loadOwnedNetwork(ctx, user.id, networkId);
  const joinKey = generateJoinKey();
  await ctx.store.rotateNetworkJoinKey(networkId, encryptSecret(joinKey, ctx.masterKey));
  const updated = await ctx.store.getNetwork(networkId);
  if (updated === null) {
    throw new ApiError(404, 'NOT_FOUND', 'network not found');
  }
  // 不影响已 authorized 成员：只换入网口令，成员表不动
  sendOk(ctx.res, await networkView(ctx, updated));
}

// ---------------------------------------------------------------- 成员路由

/** 五态操作公共体：归属校验 → store 状态机 → onMemberChanged 钩子 → 返回迁移后成员 */
async function handleMemberTransition(
  ctx: RouteContext,
  params: Record<string, string>,
  action: TransitionAction,
): Promise<void> {
  const user = await requireUser(ctx);
  const networkId = params['id'] ?? '';
  await loadOwnedNetwork(ctx, user.id, networkId);
  const nodeId = params['nodeId'] ?? '';
  const member: MemberRecord = await ctx.store.transitionMemberStatus(networkId, nodeId, action);
  await runHook(ctx.hooks.onMemberChanged, {
    networkId: member.networkId,
    nodeId: member.nodeId,
    action,
    status: member.status,
  });
  sendOk(ctx.res, { member });
}

async function handlePatchMember(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  const user = await requireUser(ctx);
  const networkId = params['id'] ?? '';
  await loadOwnedNetwork(ctx, user.id, networkId);
  const nodeId = params['nodeId'] ?? '';
  const body = await readJsonObjectBody(ctx.req);
  const patch: MemberProfilePatch = {};
  if ('name' in body) {
    if (body['name'] === null) {
      patch.name = null;
    } else if (typeof body['name'] === 'string') {
      const trimmed = body['name'].trim();
      if (trimmed.length < 1 || trimmed.length > 64) {
        throw new ApiError(400, 'INVALID_REQUEST', 'name must be 1..64 characters');
      }
      patch.name = trimmed;
    } else {
      throw new ApiError(400, 'INVALID_REQUEST', 'name must be a string or null');
    }
  }
  if ('note' in body) {
    if (body['note'] === null) {
      patch.note = null;
    } else if (typeof body['note'] === 'string') {
      const trimmed = body['note'].trim();
      if (trimmed.length > 120) {
        throw new ApiError(400, 'INVALID_REQUEST', 'note must be at most 120 characters');
      }
      patch.note = trimmed === '' ? null : trimmed;
    } else {
      throw new ApiError(400, 'INVALID_REQUEST', 'note must be a string or null');
    }
  }
  if (!('name' in patch) && !('note' in patch)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'at least one of name or note is required');
  }
  const member = await ctx.store.updateMemberProfile(networkId, nodeId, patch);
  await runHook(ctx.hooks.onMemberChanged, {
    networkId: member.networkId,
    nodeId: member.nodeId,
    action: 'rename',
    status: member.status,
    name: member.name,
  });
  sendOk(ctx.res, { member });
}

async function handleDeleteMember(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  const user = await requireUser(ctx);
  const networkId = params['id'] ?? '';
  await loadOwnedNetwork(ctx, user.id, networkId);
  const nodeId = params['nodeId'] ?? '';
  const members = await ctx.store.listMembers(networkId);
  if (!members.some((m) => m.nodeId === nodeId)) {
    throw new ApiError(404, 'NOT_FOUND', 'member not found');
  }
  await ctx.store.removeMember(networkId, nodeId);
  await runHook(ctx.hooks.onMemberChanged, { networkId, nodeId, action: 'remove', status: 'revoked' });
  sendOk(ctx.res, { networkId, nodeId, removed: true });
}

/**
 * 节点端按网关地址发现可人工审批加入的网络（免 Cookie 公开面）：
 * 只返回允许无口令转人工审批（`manual` / `both`）的网络 `{ id, name }` 与总网络数 `totalNetworks`
 * （供节点端区分「网关尚未建网」与「网络均关闭人工审批」），绝不暴露 `joinKey`、`ownerId` 或成员表。
 */
async function handleListPeerJoinableNetworks(ctx: RouteContext): Promise<void> {
  const all = await ctx.store.listPublicNetworks();
  const networks = all
    .filter((n) => n.admissionMode === 'manual' || n.admissionMode === 'both')
    .map((n) => ({ id: n.id, name: n.name }));
  sendOk(ctx.res, { networks, totalNetworks: all.length });
}

export function buildNetworkRoutes(): RouteDef[] {
  return [
    { method: 'GET', path: '/peer/v1/networks', handler: handleListPeerJoinableNetworks },
    { method: 'GET', path: '/api/v1/networks', handler: handleListNetworks },
    { method: 'POST', path: '/api/v1/networks', handler: handleCreateNetwork },
    { method: 'PATCH', path: '/api/v1/networks/:id', handler: handlePatchNetwork },
    { method: 'DELETE', path: '/api/v1/networks/:id', handler: handleDeleteNetwork },
    { method: 'POST', path: '/api/v1/networks/:id/rotate-key', handler: handleRotateKey },
    { method: 'POST', path: '/api/v1/networks/:id/members/:nodeId/approve', handler: (ctx, p) => handleMemberTransition(ctx, p, 'approve') },
    { method: 'POST', path: '/api/v1/networks/:id/members/:nodeId/reject', handler: (ctx, p) => handleMemberTransition(ctx, p, 'reject') },
    { method: 'POST', path: '/api/v1/networks/:id/members/:nodeId/pause', handler: (ctx, p) => handleMemberTransition(ctx, p, 'pause') },
    { method: 'POST', path: '/api/v1/networks/:id/members/:nodeId/resume', handler: (ctx, p) => handleMemberTransition(ctx, p, 'resume') },
    { method: 'POST', path: '/api/v1/networks/:id/members/:nodeId/repin', handler: (ctx, p) => handleMemberTransition(ctx, p, 'repin') },
    { method: 'PATCH', path: '/api/v1/networks/:id/members/:nodeId', handler: handlePatchMember },
    { method: 'DELETE', path: '/api/v1/networks/:id/members/:nodeId', handler: handleDeleteMember },
  ];
}
