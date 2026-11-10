// 超级管理员路由（PG-4）：系统设置热更新、用户管理。
// 仅 admin 角色可访问（requireAdmin 前置），普通用户一律 403 FORBIDDEN。
// 用户列表永不暴露 passwordHash；停用用户由 store 原子清除其全部登录会话。
import { readJsonObjectBody, publicUser, requireAdmin, runHook, sendOk } from './auth.js';
import { ApiError } from './auth.js';
import type { RouteContext, RouteDef } from './auth.js';
import type { SettingsPatch, UserRecord } from '../store/types.js';

function parseIntInRange(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, 'INVALID_REQUEST', `${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/** PATCH /admin/settings 的部分校验：只收四个已知键，范围与 config 解析一致 */
function parseSettingsPatch(body: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};
  if (body['allowSignup'] !== undefined) {
    if (typeof body['allowSignup'] !== 'boolean') {
      throw new ApiError(400, 'INVALID_REQUEST', 'allowSignup must be a boolean');
    }
    patch.allowSignup = body['allowSignup'];
  }
  if (body['maxNetworksPerUser'] !== undefined) {
    patch.maxNetworksPerUser = parseIntInRange(body['maxNetworksPerUser'], 1, 50, 'maxNetworksPerUser');
  }
  if (body['defaultMaxPeers'] !== undefined) {
    patch.defaultMaxPeers = parseIntInRange(body['defaultMaxPeers'], 2, 64, 'defaultMaxPeers');
  }
  if (body['relayRateKbps'] !== undefined) {
    patch.relayRateKbps = parseIntInRange(body['relayRateKbps'], 64, 1048576, 'relayRateKbps');
  }
  return patch;
}

async function handleGetSettings(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  sendOk(ctx.res, await ctx.store.getSettings());
}

async function handlePatchSettings(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  const body = await readJsonObjectBody(ctx.req);
  const patch = parseSettingsPatch(body);
  const result = await ctx.store.updateSettings(patch);
  // 空补丁 = 只读取当前值，不打扰 PG-5 的限速器
  if (Object.keys(patch).length > 0) {
    await runHook(ctx.hooks.onSettingsChanged, result);
  }
  sendOk(ctx.res, result);
}

async function handleListUsers(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  const users = await ctx.store.listUsers();
  const rows = [];
  for (const user of users) {
    const networks = await ctx.store.listNetworksByOwner(user.id);
    rows.push({
      id: user.id,
      email: user.email,
      role: user.role,
      active: user.active,
      createdAt: user.createdAt,
      networkCount: networks.length,
      onlineDevices: ctx.runtime.getOnlineCountByUser(user.id),
      relayKbps: ctx.runtime.getRelayKbpsByUser(user.id),
    });
  }
  sendOk(ctx.res, rows);
}

/** 客户端可见的用户行：publicUser 三件套 + active/createdAt，无 passwordHash */
function adminUserRow(user: UserRecord): Record<string, unknown> {
  return { ...publicUser(user), active: user.active, createdAt: user.createdAt };
}

async function handlePatchUser(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  const admin = await requireAdmin(ctx);
  const targetId = params['id'] ?? '';
  const body = await readJsonObjectBody(ctx.req);
  const active = body['active'];
  if (typeof active !== 'boolean') {
    throw new ApiError(400, 'INVALID_REQUEST', 'active must be a boolean');
  }
  if (targetId === admin.id && active === false) {
    throw new ApiError(400, 'CANNOT_DISABLE_SELF', 'administrators cannot disable their own account');
  }
  const target = await ctx.store.findUserById(targetId);
  if (target === null) {
    throw new ApiError(404, 'NOT_FOUND', 'user not found');
  }
  // store 侧停用即原子清除该用户全部登录会话（Cookie 立即失效）
  await ctx.store.setUserActive(targetId, active);
  if (!active) {
    await runHook(ctx.hooks.onUserDisabled, targetId); // PG-5 据此断开该用户的在线连接
  }
  const updated = await ctx.store.findUserById(targetId);
  if (updated === null) {
    throw new ApiError(404, 'NOT_FOUND', 'user not found');
  }
  sendOk(ctx.res, adminUserRow(updated));
}

export function buildAdminRoutes(): RouteDef[] {
  return [
    { method: 'GET', path: '/api/v1/admin/settings', handler: handleGetSettings },
    { method: 'PATCH', path: '/api/v1/admin/settings', handler: handlePatchSettings },
    { method: 'GET', path: '/api/v1/admin/users', handler: handleListUsers },
    { method: 'PATCH', path: '/api/v1/admin/users/:id', handler: handlePatchUser },
  ];
}
