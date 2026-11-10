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

function joinHost(ctx: RouteContext, reqHost: string | undefined): string {
  if (ctx.config.publicUrl !== undefined) {
    return new URL(ctx.config.publicUrl).host;
  }
  return reqHost ?? '';
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
  const host = joinHost(ctx, ctx.req.headers['host']);
  return {
    id: network.id,
    name: network.name,
    admissionMode: network.admissionMode,
    maxPeers: network.maxPeers,
    createdAt: network.createdAt,
    joinKey,
    joinUri: `zr-net://${host}/${network.id}#${joinKey}`,
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

export function buildNetworkRoutes(): RouteDef[] {
  return [
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
    { method: 'DELETE', path: '/api/v1/networks/:id/members/:nodeId', handler: handleDeleteMember },
  ];
}
