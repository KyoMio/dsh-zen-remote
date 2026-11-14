// 超级管理员路由（PG-4 / GC-6a）：系统设置热更新、只读运行态与安全告警、
// SMTP 测试发信、Admin API Key 管理、用户组 CRUD、用户管理 CRUD 与密码重置。
// 仅 admin 角色可访问（requireAdmin 前置，GC-6a 起支持 Bearer API Key 双轨），
// 普通用户一律 403 FORBIDDEN。
// 用户列表永不暴露 passwordHash；停用/改密由 store 原子清除其全部登录会话。
// settings（GC-6b 起切到扩展设置视图）：HTTP 层给出脱敏视图（含 smtp 已配置态与
// adminApiKey 前缀），底层 store 仍保持基础 4 键 SystemSettings 契约与钩子签名不变。
import { randomBytes } from 'node:crypto';

import { sendMail, SmtpClientError } from '../mail/smtp-client.js';
import type { SmtpSecurityMode } from '../mail/smtp-client.js';
import { renderSmtpTestEmail } from '../mail/templates.js';
import type { MailLocale } from '../mail/templates.js';
import { generatePassword, hashPassword } from '../master-key.js';
import { DEFAULT_GROUP_ID, validateGroupInput } from '../store/types.js';
import type {
  AdminUserPatch,
  CreateUserGroupInput,
  ExtendedSettingsPatch,
  GatewayStore,
  SettingsPatch,
  UpdateUserGroupPatch,
  UserGroupRecord,
  UserRecord,
  UserRole,
} from '../store/types.js';
import {
  ApiError,
  decodeSmtpConfig,
  encodeSmtpConfig,
  hashToken,
  isSmtpConfigured,
  isValidEmail,
  readJsonObjectBody,
  requireAdmin,
  runHook,
  sendOk,
  SYSTEM_API_ADMIN_ID,
} from './auth.js';
import type { RouteContext, RouteDef, StoredSmtpConfig } from './auth.js';

function parseIntInRange(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, 'INVALID_REQUEST', `${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/** 必填字符串字段（trim 后非空）；缺失/类型错 → 400 */
function requireStringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'INVALID_REQUEST', `${key} must be a non-empty string`);
  }
  return value.trim();
}

/** 必填整数字段；缺失/类型错 → 400（范围校验交给 validateGroupInput） */
function requireIntField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiError(400, 'INVALID_REQUEST', `${key} must be an integer`);
  }
  return value;
}

/**
 * 与 routes-networks.ts 的同名函数逐字对齐的内网/回环主机判定（GC-6a）：
 * 该文件未导出、而任务单只放开 5 个文件，故此处持有一份副本；改动判定规则必须两处同步。
 */
function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1).toLowerCase() : hostname.toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  if (h.endsWith('.local') || h.endsWith('.lan')) return true; // mDNS 名 / 家用路由后缀
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

/** groupId → 用户计数表（/admin/groups 与单组行共用） */
async function countUsersByGroup(store: GatewayStore): Promise<Map<string, number>> {
  const users = await store.listUsers();
  const counts = new Map<string, number>();
  for (const u of users) {
    counts.set(u.groupId, (counts.get(u.groupId) ?? 0) + 1);
  }
  return counts;
}

async function groupRowWithCount(ctx: RouteContext, group: UserGroupRecord): Promise<Record<string, unknown>> {
  const counts = await countUsersByGroup(ctx.store);
  return { ...group, userCount: counts.get(group.id) ?? 0 };
}

// ---------------------------------------------------------------- 系统设置（GC-6b 扩展视图）

/**
 * GET/PATCH /admin/settings 共用的脱敏视图。绝对红线：响应 JSON 严禁出现
 * password / smtpConfigEnc 密文 / adminApiKeyHash 原文或密文——密码只给
 * hasPassword 布尔，API Key 只给前缀与创建时刻。
 */
async function buildSettingsView(ctx: RouteContext): Promise<Record<string, unknown>> {
  const [ext, groups] = await Promise.all([ctx.store.getExtendedSettings(), ctx.store.listUserGroups()]);
  const smtp = decodeSmtpConfig(ext.smtpConfigEnc, ctx.masterKey);
  return {
    allowSignup: ext.allowSignup,
    requireEmailVerification: ext.requireEmailVerification,
    maxNetworksPerUser: ext.maxNetworksPerUser,
    defaultMaxPeers: ext.defaultMaxPeers,
    relayRateKbps: ext.relayRateKbps,
    publicUrl: ext.publicUrl,
    sessionTtlDays: ext.sessionTtlDays,
    // 当前 is_default 组的 id；无默认组行时兜底内置 id（正常初始化流程不会发生）
    defaultGroupId: groups.find((g) => g.isDefault)?.id ?? DEFAULT_GROUP_ID,
    smtp: {
      configured: isSmtpConfigured(smtp),
      // 未配置时给一份空草稿形态（host/port 明显为空值），控制台可直接渲染表单
      host: smtp?.host ?? '',
      port: smtp?.port ?? 0,
      security: smtp?.security ?? 'starttls',
      username: smtp?.username ?? '',
      hasPassword: smtp?.password !== undefined && smtp.password.length > 0,
      fromAddress: smtp?.fromAddress ?? '',
      fromName: smtp?.fromName ?? '',
      rejectUnauthorized: smtp?.rejectUnauthorized ?? true,
    },
    adminApiKey: {
      configured: ext.adminApiKeyHash !== null,
      prefix: ext.adminApiKeyPrefix,
      createdAt: ext.adminApiKeyCreatedAt,
    },
  };
}

/** PATCH /admin/settings 的基础 4 键部分校验：范围与默认组字段校验（validateGroupInput）对齐 */
function parseBaseSettingsPatch(body: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};
  if (body['allowSignup'] !== undefined) {
    if (typeof body['allowSignup'] !== 'boolean') {
      throw new ApiError(400, 'INVALID_REQUEST', 'allowSignup must be a boolean');
    }
    patch.allowSignup = body['allowSignup'];
  }
  if (body['maxNetworksPerUser'] !== undefined) {
    patch.maxNetworksPerUser = parseIntInRange(body['maxNetworksPerUser'], 1, 100, 'maxNetworksPerUser');
  }
  if (body['defaultMaxPeers'] !== undefined) {
    patch.defaultMaxPeers = parseIntInRange(body['defaultMaxPeers'], 2, 64, 'defaultMaxPeers');
  }
  if (body['relayRateKbps'] !== undefined) {
    patch.relayRateKbps = parseIntInRange(body['relayRateKbps'], 64, 1048576, 'relayRateKbps');
  }
  return patch;
}

/**
 * publicUrl 归一化（SPEC 5.4）：传 `""` 或 null 清空；非空串必须解析为 http:/https:
 * 裸地址——不带路径（仅允许空或 `/`，末尾 `/` 自动去掉）、不带查询串/哈希/控制字符。
 */
function parsePublicUrlPatch(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_REQUEST', 'publicUrl must be a string or null');
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'publicUrl must not contain leading/trailing whitespace or control characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', 'publicUrl must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, 'INVALID_REQUEST', 'publicUrl must use http: or https:');
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0 || (parsed.pathname.length > 0 && parsed.pathname !== '/')) {
    throw new ApiError(400, 'INVALID_REQUEST', 'publicUrl must not contain a path, query, or hash');
  }
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** SMTP 字符串字段的邮件头注入防线：\r \n \0 一律拒绝 */
function rejectSmtpHeaderInjection(value: string, label: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new ApiError(400, 'INVALID_REQUEST', `${label} must not contain CR, LF, or NUL`);
  }
}

/** smtp 草稿字段的主字段/别名读取（secure/user/pass/fromEmail 为历史别名） */
function readSmtpAliasField(draft: Record<string, unknown>, primary: string, alias: string): unknown {
  return draft[primary] !== undefined ? draft[primary] : draft[alias];
}

/**
 * PATCH /admin/settings 的 smtp 对象解析（与 smtp-test 的 parseSmtpDraft 同一套校验，
 * 另支持别名与安全模式归一化）：
 * - `security` 归一化 `implicit_tls`→`tls`、`plain`→`none`；
 * - password 省略或空串时沿用库中已存密码（管理员改 host/port 不必重输密码）；
 * - 返回合并后的完整配置，由调用方 encodeSmtpConfig 加密落库。
 */
function parseSmtpSettingsPatch(value: unknown, savedPassword: string | undefined): StoredSmtpConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'smtp must be an object or null');
  }
  const draft = value as Record<string, unknown>;
  const host = requireStringField(draft, 'host');
  rejectSmtpHeaderInjection(host, 'smtp.host');
  const port = parseIntInRange(draft['port'], 1, 65535, 'smtp.port');
  const rawSecurity = readSmtpAliasField(draft, 'security', 'secure');
  const security = rawSecurity === 'implicit_tls' ? 'tls' : rawSecurity === 'plain' ? 'none' : rawSecurity;
  if (security !== 'tls' && security !== 'starttls' && security !== 'none') {
    throw new ApiError(400, 'INVALID_REQUEST', "smtp.security must be one of: tls, starttls, none");
  }
  const rawFromAddress = readSmtpAliasField(draft, 'fromAddress', 'fromEmail');
  if (typeof rawFromAddress !== 'string' || rawFromAddress.trim().length === 0) {
    throw new ApiError(400, 'INVALID_REQUEST', 'smtp.fromAddress must be a non-empty string');
  }
  const fromAddress = rawFromAddress.trim();
  rejectSmtpHeaderInjection(fromAddress, 'smtp.fromAddress');
  const rawUsername = readSmtpAliasField(draft, 'username', 'user');
  if (rawUsername !== undefined && typeof rawUsername !== 'string') {
    throw new ApiError(400, 'INVALID_REQUEST', 'smtp.username must be a string');
  }
  const username = typeof rawUsername === 'string' && rawUsername.length > 0 ? rawUsername : undefined;
  const rawPassword = readSmtpAliasField(draft, 'password', 'pass');
  if (rawPassword !== undefined && rawPassword !== null && typeof rawPassword !== 'string') {
    throw new ApiError(400, 'INVALID_REQUEST', 'smtp.password must be a string');
  }
  const password =
    typeof rawPassword === 'string' && rawPassword.length > 0 ? rawPassword : savedPassword;
  const rawFromName = draft['fromName'];
  if (rawFromName !== undefined && typeof rawFromName !== 'string') {
    throw new ApiError(400, 'INVALID_REQUEST', 'smtp.fromName must be a string');
  }
  const fromName = typeof rawFromName === 'string' && rawFromName.length > 0 ? rawFromName : undefined;
  const rejectUnauthorized = draft['rejectUnauthorized'];
  if (rejectUnauthorized !== undefined && typeof rejectUnauthorized !== 'boolean') {
    throw new ApiError(400, 'INVALID_REQUEST', 'smtp.rejectUnauthorized must be a boolean');
  }
  for (const [label, text] of [
    ['smtp.username', username],
    ['smtp.password', password],
    ['smtp.fromName', fromName],
  ] as const) {
    if (text !== undefined) rejectSmtpHeaderInjection(text, label);
  }
  return {
    host,
    port,
    security: security as SmtpSecurityMode,
    username,
    password,
    fromAddress,
    fromName,
    rejectUnauthorized: typeof rejectUnauthorized === 'boolean' ? rejectUnauthorized : undefined,
  };
}

async function handleGetSettings(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  sendOk(ctx.res, await buildSettingsView(ctx));
}

async function handlePatchSettings(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  const body = await readJsonObjectBody(ctx.req);

  // ---- 第一阶段：全部提交字段先校验，任何 400/404 都不落盘
  const extPatch: ExtendedSettingsPatch = { ...parseBaseSettingsPatch(body) };
  if (body['requireEmailVerification'] !== undefined) {
    if (typeof body['requireEmailVerification'] !== 'boolean') {
      throw new ApiError(400, 'INVALID_REQUEST', 'requireEmailVerification must be a boolean');
    }
    extPatch.requireEmailVerification = body['requireEmailVerification'];
  }
  if (body['publicUrl'] !== undefined) {
    extPatch.publicUrl = parsePublicUrlPatch(body['publicUrl']);
  }
  if (body['sessionTtlDays'] !== undefined) {
    extPatch.sessionTtlDays = parseIntInRange(body['sessionTtlDays'], 1, 90, 'sessionTtlDays');
  }
  const ext = await ctx.store.getExtendedSettings();
  const savedSmtp = decodeSmtpConfig(ext.smtpConfigEnc, ctx.masterKey);
  let smtpProvided = false;
  if (body['smtp'] !== undefined) {
    smtpProvided = true;
    if (body['smtp'] === null) {
      extPatch.smtpConfigEnc = null; // 显式清空发信配置
    } else {
      extPatch.smtpConfigEnc = encodeSmtpConfig(
        parseSmtpSettingsPatch(body['smtp'], savedSmtp?.password),
        ctx.masterKey,
      );
    }
  }
  // 空体或一个已知键都没有 → 400（读取走 GET，不再支持「空补丁读当前值」；
  // defaultGroupId 也是已知键，只改它时继续走组存在性校验 → 404）
  const hasDefaultGroupId = body['defaultGroupId'] !== undefined;
  if (Object.keys(extPatch).length === 0 && !hasDefaultGroupId) {
    throw new ApiError(400, 'INVALID_REQUEST', 'at least one known setting field is required');
  }
  let switchDefaultGroupId: string | undefined;
  if (hasDefaultGroupId) {
    if (typeof body['defaultGroupId'] !== 'string' || body['defaultGroupId'].length === 0) {
      throw new ApiError(400, 'INVALID_REQUEST', 'defaultGroupId must be a non-empty string');
    }
    if ((await ctx.store.getUserGroup(body['defaultGroupId'])) === null) {
      throw new ApiError(404, 'GROUP_NOT_FOUND', 'user group not found');
    }
    switchDefaultGroupId = body['defaultGroupId'];
  }

  // ---- 第二阶段：SMTP 门禁按「更新后的最终结果」判定——本次改了 smtp 就按新值，
  // 否则按库中现值；防止清空 smtp 或关掉发信后邮箱验证流程卡死
  const finalRequireVerification = extPatch.requireEmailVerification ?? ext.requireEmailVerification;
  const finalSmtp = smtpProvided
    ? decodeSmtpConfig(extPatch.smtpConfigEnc ?? null, ctx.masterKey)
    : savedSmtp;
  if (finalRequireVerification && !isSmtpConfigured(finalSmtp)) {
    throw new ApiError(400, 'SMTP_NOT_CONFIGURED', 'requireEmailVerification requires a configured smtp');
  }

  // ---- 第三阶段：落盘。先切默认组再写扩展设置——store 对三项配额键的双向同步
  // 目标是「当前 is_default 组」，这个顺序保证本次 PATCH 的新配额写进新默认组
  if (switchDefaultGroupId !== undefined) {
    await ctx.store.updateUserGroup(switchDefaultGroupId, { isDefault: true });
  }
  await ctx.store.updateExtendedSettings(extPatch);
  // 钩子仍按基础 4 键契约通知实时层（PG-5 限速器 / 会话 TTL），配额全量失效刷新
  await runHook(ctx.hooks.onSettingsChanged, await ctx.store.getSettings());
  await runHook(ctx.hooks.onQuotaChanged);
  sendOk(ctx.res, await buildSettingsView(ctx));
}

// ---------------------------------------------------------------- 只读运行态与安全告警（GC-6a）

async function handleGetRuntime(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  const meta = ctx.config.runtimeMeta;
  const listenPort = meta?.listenPort ?? 0;
  const udpPort = meta?.udpPort ?? 0;
  const udpAltPort = meta?.udpAltPort ?? 0;

  // 有效公网入口优先级（SPEC 5.1.4）：settings.publicUrl > 环境变量 > 请求头推断。
  // settings 值由 server.ts 逐请求热读后已注入 ctx.config.publicUrl，这里直接复用同一份。
  let publicUrlEffective: string;
  let publicUrlSource: 'settings' | 'env' | 'request';
  if (ctx.config.publicUrl !== undefined) {
    publicUrlEffective = ctx.config.publicUrl;
    publicUrlSource = 'settings';
  } else if (meta?.publicUrlFromEnv !== undefined && meta.publicUrlFromEnv.length > 0) {
    publicUrlEffective = meta.publicUrlFromEnv;
    publicUrlSource = 'env';
  } else {
    const host = ctx.req.headers['host'];
    const hostHeader = Array.isArray(host) ? host[0] : host;
    const forwardedProto = String(ctx.req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      ?.trim()
      .toLowerCase();
    publicUrlEffective = hostHeader !== undefined && hostHeader.length > 0
      ? `${forwardedProto === 'https' ? 'https' : 'http'}://${hostHeader}`
      : '';
    publicUrlSource = 'request';
  }

  // 聚合在线设备 / 实时中转速率 / 累计中转字节（store 库值 + 注入的运行时统计）
  const ext = await ctx.store.getExtendedSettings();
  const users = await ctx.store.listUsers();
  let onlineDevices = 0;
  let totalLiveRelayKbps = 0;
  let cumulativeRelayBytes = 0;
  for (const user of users) {
    onlineDevices += ctx.runtime.getOnlineCountByUser(user.id);
    totalLiveRelayKbps += ctx.runtime.getRelayKbpsByUser(user.id);
    const networks = await ctx.store.listNetworksByOwner(user.id);
    for (const network of networks) {
      const members = await ctx.store.listMembers(network.id);
      for (const member of members) {
        cumulativeRelayBytes += member.cumulativeRelayBytes;
      }
    }
  }

  // 非阻塞安全告警：公网明文入口、辅助探测口关闭。脱敏红线——绝不返回
  // 数据库连接串、网关共享密钥、masterKey 或本机绝对路径；也不提供
  // 「允许不安全连接」之类开关（安全边界只读，不做解锁按钮）。
  const securityWarnings: string[] = [];
  if (publicUrlEffective.length > 0) {
    try {
      const parsed = new URL(publicUrlEffective);
      if (parsed.protocol === 'http:' && !isLoopbackOrPrivateHostname(parsed.hostname)) {
        securityWarnings.push('PUBLIC_HTTP_PLAINTEXT');
      }
    } catch {
      // 无法解析的地址不给告警，也不让接口 500
    }
  }
  if (udpPort === 0 || udpAltPort === 0) {
    securityWarnings.push('UDP_ALT_DISABLED');
  }

  sendOk(ctx.res, {
    listenPort,
    udpPort,
    udpAltPort,
    storageDriver: meta?.storageDriver ?? 'sqlite',
    secretSource: meta?.secretSource ?? 'file',
    publicUrlEffective,
    publicUrlSource,
    smtpConfigured: isSmtpConfigured(decodeSmtpConfig(ext.smtpConfigEnc, ctx.masterKey)),
    onlineDevices,
    totalLiveRelayKbps,
    cumulativeRelayBytes,
    securityWarnings,
  });
}

// ---------------------------------------------------------------- SMTP 测试发信（GC-6a）

/**
 * 解析请求里的 SMTP 草稿。password 省略或空串时回填库中已保存配置的密码
 * （前端脱敏回显拿不到密码原文，管理员只改 host/port 时不必重输密码）。
 */
function parseSmtpDraft(value: unknown, savedPassword: string | undefined): StoredSmtpConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'smtp draft must be an object');
  }
  const draft = value as Record<string, unknown>;
  const host = requireStringField(draft, 'host');
  const port = parseIntInRange(draft['port'], 1, 65535, 'smtp.port');
  const security = draft['security'];
  if (security !== 'tls' && security !== 'starttls' && security !== 'none') {
    throw new ApiError(400, 'INVALID_REQUEST', "smtp.security must be one of: tls, starttls, none");
  }
  const fromAddress = requireStringField(draft, 'fromAddress');
  if (draft['username'] !== undefined && typeof draft['username'] !== 'string') {
    throw new ApiError(400, 'INVALID_REQUEST', 'smtp.username must be a string');
  }
  if (draft['password'] !== undefined && draft['password'] !== null && typeof draft['password'] !== 'string') {
    throw new ApiError(400, 'INVALID_REQUEST', 'smtp.password must be a string');
  }
  if (draft['fromName'] !== undefined && typeof draft['fromName'] !== 'string') {
    throw new ApiError(400, 'INVALID_REQUEST', 'smtp.fromName must be a string');
  }
  if (draft['rejectUnauthorized'] !== undefined && typeof draft['rejectUnauthorized'] !== 'boolean') {
    throw new ApiError(400, 'INVALID_REQUEST', 'smtp.rejectUnauthorized must be a boolean');
  }
  const draftPassword = draft['password'];
  const password = typeof draftPassword === 'string' && draftPassword.length > 0 ? draftPassword : savedPassword;
  return {
    host,
    port,
    security: security as SmtpSecurityMode,
    username: typeof draft['username'] === 'string' && draft['username'].length > 0 ? draft['username'] : undefined,
    password,
    fromAddress,
    fromName: typeof draft['fromName'] === 'string' && draft['fromName'].length > 0 ? draft['fromName'] : undefined,
    rejectUnauthorized: typeof draft['rejectUnauthorized'] === 'boolean' ? draft['rejectUnauthorized'] : undefined,
  };
}

async function handleSmtpTest(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  const body = await readJsonObjectBody(ctx.req);
  // `toEmail` 主字段，兼容 `to` 别名
  const rawTo = body['toEmail'] ?? body['to'];
  if (typeof rawTo !== 'string' || !isValidEmail(rawTo.trim())) {
    throw new ApiError(400, 'INVALID_REQUEST', 'a valid toEmail is required');
  }
  const toEmail = rawTo.trim();
  const locale: MailLocale = body['locale'] === 'en' ? 'en' : 'zh';

  const ext = await ctx.store.getExtendedSettings();
  const saved = decodeSmtpConfig(ext.smtpConfigEnc, ctx.masterKey);
  const config = body['smtp'] !== undefined && body['smtp'] !== null
    ? parseSmtpDraft(body['smtp'], saved?.password)
    : saved;
  if (!isSmtpConfigured(config) || config === null) {
    throw new ApiError(400, 'SMTP_NOT_CONFIGURED', 'smtp is not configured on this gateway');
  }

  const rendered = renderSmtpTestEmail({
    locale,
    publicUrl: ext.publicUrl ?? ctx.config.publicUrl ?? null,
    sentAtIso: new Date().toISOString(),
  });
  try {
    await sendMail(config, { to: toEmail, subject: rendered.subject, text: rendered.text });
  } catch (err) {
    // 脱敏：只透出错误类别码，绝不透出 SmtpClientError 消息正文（更不可能含密码）
    const detail = err instanceof SmtpClientError ? err.code : 'SEND_FAILED';
    throw new ApiError(502, 'SMTP_SEND_FAILED', `failed to send the test email (${detail})`);
  }
  sendOk(ctx.res, { sent: true });
}

// ---------------------------------------------------------------- Admin API Key（GC-6a）

async function handleCreateApiKey(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  const apiKey = `zr_adm_${randomBytes(24).toString('hex')}`; // 48 位 hex，明文仅在本次响应出现
  const prefix = apiKey.slice(0, 14);
  const createdAt = new Date().toISOString();
  await ctx.store.updateExtendedSettings({
    adminApiKeyHash: hashToken(apiKey),
    adminApiKeyPrefix: prefix,
    adminApiKeyCreatedAt: createdAt,
  });
  sendOk(ctx.res, { apiKey, prefix, createdAt });
}

async function handleRevokeApiKey(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  await ctx.store.updateExtendedSettings({
    adminApiKeyHash: null,
    adminApiKeyPrefix: null,
    adminApiKeyCreatedAt: null,
  });
  sendOk(ctx.res, { revoked: true });
}

// ---------------------------------------------------------------- 用户组 CRUD（GC-6a）

async function handleListGroups(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  const [groups, counts] = await Promise.all([ctx.store.listUserGroups(), countUsersByGroup(ctx.store)]);
  sendOk(ctx.res, groups.map((group) => ({ ...group, userCount: counts.get(group.id) ?? 0 })));
}

/** 组数字字段的可选出现校验：给了就收（范围交给 validateGroupInput / store） */
function parseOptionalGroupQuotaFields(
  body: Record<string, unknown>,
  patch: UpdateUserGroupPatch & Partial<CreateUserGroupInput>,
): void {
  if (body['maxNetworks'] !== undefined) patch.maxNetworks = requireIntField(body, 'maxNetworks');
  if (body['maxPeersPerNetwork'] !== undefined) patch.maxPeersPerNetwork = requireIntField(body, 'maxPeersPerNetwork');
  if (body['relayRateKbps'] !== undefined) patch.relayRateKbps = requireIntField(body, 'relayRateKbps');
  if (body['monthlyRelayQuotaBytes'] !== undefined) {
    const value = body['monthlyRelayQuotaBytes'];
    if (value !== null && typeof value !== 'number') {
      throw new ApiError(400, 'INVALID_REQUEST', 'monthlyRelayQuotaBytes must be null or an integer');
    }
    patch.monthlyRelayQuotaBytes = value as number | null;
  }
}

/** validateGroupInput 的普通 Error 是输入校验（非业务拒绝）→ 统一 400 INVALID_REQUEST */
function assertGroupInputValid(input: Parameters<typeof validateGroupInput>[0]): void {
  try {
    validateGroupInput(input);
  } catch (err) {
    throw new ApiError(400, 'INVALID_REQUEST', err instanceof Error ? err.message : 'invalid group input');
  }
}

async function handleCreateGroup(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  const body = await readJsonObjectBody(ctx.req);
  const input: CreateUserGroupInput = {
    code: requireStringField(body, 'code'),
    name: requireStringField(body, 'name'),
    maxNetworks: requireIntField(body, 'maxNetworks'),
    maxPeersPerNetwork: requireIntField(body, 'maxPeersPerNetwork'),
    relayRateKbps: requireIntField(body, 'relayRateKbps'),
  };
  if (body['description'] !== undefined) {
    if (typeof body['description'] !== 'string') {
      throw new ApiError(400, 'INVALID_REQUEST', 'description must be a string');
    }
    input.description = body['description'];
  }
  if (body['isDefault'] !== undefined) {
    if (typeof body['isDefault'] !== 'boolean') {
      throw new ApiError(400, 'INVALID_REQUEST', 'isDefault must be a boolean');
    }
    input.isDefault = body['isDefault'];
  }
  parseOptionalGroupQuotaFields(body, input as UpdateUserGroupPatch & Partial<CreateUserGroupInput>);
  assertGroupInputValid(input);

  const group = await ctx.store.createUserGroup(input); // code 重复 → 409 DUPLICATE_GROUP_CODE
  if (input.isDefault === true) {
    // 默认组变化即时刷新实时层默认限速与全量配额快照
    await runHook(ctx.hooks.onSettingsChanged, await ctx.store.getSettings());
    await runHook(ctx.hooks.onQuotaChanged);
  }
  sendOk(ctx.res, await groupRowWithCount(ctx, group));
}

async function handlePatchGroup(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  await requireAdmin(ctx);
  const id = params['id'] ?? '';
  const body = await readJsonObjectBody(ctx.req);
  if (Object.keys(body).length === 0) {
    throw new ApiError(400, 'INVALID_REQUEST', 'at least one field is required');
  }
  const current = await ctx.store.getUserGroup(id);
  if (current === null) {
    throw new ApiError(404, 'GROUP_NOT_FOUND', 'user group not found');
  }
  const patch: UpdateUserGroupPatch = {};
  if (body['name'] !== undefined) {
    if (typeof body['name'] !== 'string') {
      throw new ApiError(400, 'INVALID_REQUEST', 'name must be a string');
    }
    patch.name = body['name'];
  }
  if (body['description'] !== undefined) {
    if (typeof body['description'] !== 'string') {
      throw new ApiError(400, 'INVALID_REQUEST', 'description must be a string');
    }
    patch.description = body['description'];
  }
  if (body['isDefault'] !== undefined) {
    if (typeof body['isDefault'] !== 'boolean') {
      throw new ApiError(400, 'INVALID_REQUEST', 'isDefault must be a boolean');
    }
    // 默认组身份不可撤销（只能转移到别的组）：对当前默认组传 isDefault: false 明确拒绝
    if (current.isDefault && body['isDefault'] === false) {
      throw new ApiError(400, 'CANNOT_UNSET_DEFAULT_GROUP', 'cannot unset the default user group');
    }
    patch.isDefault = body['isDefault'];
  }
  parseOptionalGroupQuotaFields(body, patch);
  assertGroupInputValid({
    code: current.code,
    name: patch.name ?? current.name,
    maxNetworks: patch.maxNetworks ?? current.maxNetworks,
    maxPeersPerNetwork: patch.maxPeersPerNetwork ?? current.maxPeersPerNetwork,
    relayRateKbps: patch.relayRateKbps ?? current.relayRateKbps,
    monthlyRelayQuotaBytes:
      patch.monthlyRelayQuotaBytes !== undefined ? patch.monthlyRelayQuotaBytes : current.monthlyRelayQuotaBytes,
  });

  // SPEC 5.4.4：任意组（含非默认组）的配额字段实际发生变更都要通知实时层刷新配额快照，
  // 属主在线节点的速率 / 月度门禁才能立即跟随新值；仅改名称等非配额字段不触发
  const quotaTouched =
    (patch.maxNetworks !== undefined && patch.maxNetworks !== current.maxNetworks) ||
    (patch.maxPeersPerNetwork !== undefined && patch.maxPeersPerNetwork !== current.maxPeersPerNetwork) ||
    (patch.relayRateKbps !== undefined && patch.relayRateKbps !== current.relayRateKbps) ||
    (patch.monthlyRelayQuotaBytes !== undefined && patch.monthlyRelayQuotaBytes !== current.monthlyRelayQuotaBytes);
  const updated = await ctx.store.updateUserGroup(id, patch); // 不存在 → 404 GROUP_NOT_FOUND
  if (current.isDefault || patch.isDefault === true) {
    // 更新了默认组（三项配额同事务回写 system_settings）或切换了默认组
    await runHook(ctx.hooks.onSettingsChanged, await ctx.store.getSettings());
  }
  if (current.isDefault || patch.isDefault === true || quotaTouched) {
    await runHook(ctx.hooks.onQuotaChanged); // 无条件通知 hub 刷新所有在线节点配额
  }
  sendOk(ctx.res, await groupRowWithCount(ctx, updated));
}

async function handleDeleteGroup(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  await requireAdmin(ctx);
  await ctx.store.deleteUserGroup(params['id'] ?? '');
  // 默认组 → 400 CANNOT_DELETE_DEFAULT_GROUP；仍有用户引用 → 409 GROUP_IN_USE
  sendOk(ctx.res, { deleted: true });
}

// ---------------------------------------------------------------- 用户管理（GC-6a）

/**
 * 管理员视角的用户行（严格 19 键）：publicUser 三件套 + 账号字段 + 有效组配额视图，
 * 无 passwordHash。admin 不受组配额约束（maxNetworks / monthlyRelayQuotaBytes 为 null）。
 */
async function adminUserRow(ctx: RouteContext, user: UserRecord): Promise<Record<string, unknown>> {
  const networks = await ctx.store.listNetworksByOwner(user.id);
  const quota = await ctx.store.resolveEffectiveUserQuota(user.id);
  const assigned = await ctx.store.getUserGroup(user.groupId);
  const isAdmin = user.role === 'admin';
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    emailVerifiedAt: user.emailVerifiedAt,
    groupId: user.groupId,
    groupCode: assigned?.code ?? null,
    groupName: assigned?.name ?? null,
    effectiveGroupId: quota.group.id,
    effectiveGroupName: quota.group.name,
    groupExpiresAt: user.groupExpiresAt,
    isExpiredFallback: quota.isExpiredFallback,
    maxNetworks: isAdmin ? null : quota.group.maxNetworks,
    networkCount: networks.length,
    onlineDevices: ctx.runtime.getOnlineCountByUser(user.id),
    relayKbps: ctx.runtime.getRelayKbpsByUser(user.id),
    monthlyRelayBytes: quota.monthlyRelayUsedBytes,
    monthlyRelayQuotaBytes: isAdmin ? null : quota.group.monthlyRelayQuotaBytes,
  };
}

async function handleListUsers(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  const users = await ctx.store.listUsers();
  const rows = [];
  for (const user of users) {
    rows.push(await adminUserRow(ctx, user));
  }
  sendOk(ctx.res, rows);
}

/** groupExpiresAt 的公共校验：合法 ISO 时间戳或 null */
function parseGroupExpiresAt(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  throw new ApiError(400, 'INVALID_REQUEST', 'groupExpiresAt must be an ISO timestamp or null');
}

/**
 * groupId / groupCode 的公共解析：groupId 显式优先，groupCode 经编码查找；组不存在 → 404。
 * 返回 null（GC-fix-batch1 R3）= 绑定当前 is_default 组：交给 store 在事务内解析
 * （当前默认组可能与 grp_default 不同），这里绝不硬编码 DEFAULT_GROUP_ID；
 * undefined = 未传，不动用户的组。
 */
async function resolveTargetGroupId(ctx: RouteContext, body: Record<string, unknown>): Promise<string | null | undefined> {
  if (body['groupId'] !== undefined) {
    if (body['groupId'] === null) return null; // null = 绑定当前默认组（store 事务内解析）
    if (typeof body['groupId'] !== 'string') {
      throw new ApiError(400, 'INVALID_REQUEST', 'groupId must be a string or null');
    }
    return body['groupId'];
  }
  if (body['groupCode'] !== undefined) {
    if (body['groupCode'] === null) return null;
    const code = requireStringField(body, 'groupCode');
    const group = await ctx.store.getUserGroupByCode(code);
    if (group === null) {
      throw new ApiError(404, 'GROUP_NOT_FOUND', 'user group not found');
    }
    return group.id;
  }
  return undefined;
}

/** 密码公共形态：显式给（8..128）或自动生成 16 位；返回 [实际密码, 生成的密码] */
function resolvePassword(body: Record<string, unknown>, key: string): [string, string | undefined] {
  const raw = body[key];
  if (typeof raw === 'string' && raw.length > 0) {
    if (raw.length < 8 || raw.length > 128) {
      throw new ApiError(400, 'INVALID_REQUEST', `${key} must be 8..128 characters`);
    }
    return [raw, undefined];
  }
  const generated = generatePassword(16);
  return [generated, generated];
}

async function handleCreateUser(ctx: RouteContext): Promise<void> {
  await requireAdmin(ctx);
  const body = await readJsonObjectBody(ctx.req);
  const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
  if (!isValidEmail(email)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'a valid email is required');
  }
  const [password, generatedPassword] = resolvePassword(body, 'password');
  let role: UserRole = 'user';
  if (body['role'] !== undefined) {
    if (body['role'] !== 'admin' && body['role'] !== 'user') {
      throw new ApiError(400, 'INVALID_REQUEST', "role must be 'admin' or 'user'");
    }
    role = body['role'] as UserRole;
  }
  const groupId = await resolveTargetGroupId(ctx, body);
  const groupExpiresAt =
    body['groupExpiresAt'] !== undefined ? parseGroupExpiresAt(body['groupExpiresAt']) : undefined;
  let emailVerifiedAt: string | null = null;
  if (body['emailVerified'] !== undefined) {
    if (typeof body['emailVerified'] !== 'boolean') {
      throw new ApiError(400, 'INVALID_REQUEST', 'emailVerified must be a boolean');
    }
    emailVerifiedAt = body['emailVerified'] ? new Date().toISOString() : null;
  }

  const user = await ctx.store.createUser({
    email,
    passwordHash: await hashPassword(password),
    role,
    groupId,
    groupExpiresAt,
    emailVerifiedAt,
  }); // 邮箱已占用 → 409 EMAIL_TAKEN；组不存在 → 404 GROUP_NOT_FOUND

  const row = await adminUserRow(ctx, user);
  if (generatedPassword !== undefined) {
    row.generatedPassword = generatedPassword; // 仅本次响应返回，绝不落库回显
  }
  sendOk(ctx.res, row);
}

async function handlePatchUser(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  const admin = await requireAdmin(ctx);
  const targetId = params['id'] ?? '';
  const body = await readJsonObjectBody(ctx.req);
  if (Object.keys(body).length === 0) {
    throw new ApiError(400, 'INVALID_REQUEST', 'at least one field is required');
  }
  const patch: AdminUserPatch = {};
  if (body['active'] !== undefined) {
    if (typeof body['active'] !== 'boolean') {
      throw new ApiError(400, 'INVALID_REQUEST', 'active must be a boolean');
    }
    patch.active = body['active'];
  }
  if (body['role'] !== undefined) {
    if (body['role'] !== 'admin' && body['role'] !== 'user') {
      throw new ApiError(400, 'INVALID_REQUEST', "role must be 'admin' or 'user'");
    }
    patch.role = body['role'] as UserRole;
  }
  if (body['groupId'] !== undefined || body['groupCode'] !== undefined) {
    patch.groupId = await resolveTargetGroupId(ctx, body);
  }
  if (body['groupExpiresAt'] !== undefined) {
    patch.groupExpiresAt = parseGroupExpiresAt(body['groupExpiresAt']);
  }
  if (body['emailVerified'] !== undefined) {
    if (typeof body['emailVerified'] !== 'boolean') {
      throw new ApiError(400, 'INVALID_REQUEST', 'emailVerified must be a boolean');
    }
    patch.emailVerifiedAt = body['emailVerified'] ? new Date().toISOString() : null;
  }

  // 自我保护只约束真实登录的管理员（Bearer API Key 身份不是账号，无自我可言）
  if (admin.id !== SYSTEM_API_ADMIN_ID && targetId === admin.id) {
    if (patch.active === false) {
      throw new ApiError(400, 'CANNOT_DISABLE_SELF', 'administrators cannot disable their own account');
    }
    if (patch.role === 'user') {
      throw new ApiError(400, 'CANNOT_DEMOTE_SELF', 'administrators cannot demote their own account');
    }
  }
  const target = await ctx.store.findUserById(targetId);
  if (target === null) {
    throw new ApiError(404, 'NOT_FOUND', 'user not found');
  }
  // store 侧：停用即原子清除全部登录会话；停用/降级唯一活跃管理员 → 400 CANNOT_REMOVE_LAST_ADMIN
  const updated = await ctx.store.updateUserByAdmin(targetId, patch);
  if (patch.active === false) {
    await runHook(ctx.hooks.onUserDisabled, targetId); // PG-5 据此断开该用户的在线连接
  }
  if (
    updated.role !== target.role ||
    updated.groupId !== target.groupId ||
    updated.groupExpiresAt !== target.groupExpiresAt
  ) {
    await runHook(ctx.hooks.onQuotaChanged, targetId); // 组/角色/到期变化即时刷新在线配额
  }
  sendOk(ctx.res, await adminUserRow(ctx, updated));
}

async function handleResetUserPassword(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  await requireAdmin(ctx);
  const targetId = params['id'] ?? '';
  const body = await readJsonObjectBody(ctx.req);
  const [password, generatedPassword] = resolvePassword(body, 'newPassword');
  // keepTokenHash 缺省 → 该用户全部历史会话立即吊销；用户不存在 → 404 NOT_FOUND
  await ctx.store.updateUserPassword(targetId, await hashPassword(password));
  if (generatedPassword !== undefined) {
    sendOk(ctx.res, { reset: true, generatedPassword });
  } else {
    sendOk(ctx.res, { reset: true });
  }
}

async function handleDeleteUser(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  const admin = await requireAdmin(ctx);
  const targetId = params['id'] ?? '';
  if (admin.id !== SYSTEM_API_ADMIN_ID && targetId === admin.id) {
    throw new ApiError(400, 'CANNOT_DELETE_SELF', 'administrators cannot delete their own account');
  }
  await ctx.store.deleteUser(targetId); // 唯一活跃管理员 → 400 CANNOT_REMOVE_LAST_ADMIN
  // 删除级联清网络：onUserDeleted 断开节点连接，onUserDisabled 兜底同用户语义的清理
  await runHook(ctx.hooks.onUserDeleted, targetId);
  await runHook(ctx.hooks.onUserDisabled, targetId);
  sendOk(ctx.res, { deleted: true });
}

export function buildAdminRoutes(): RouteDef[] {
  return [
    { method: 'GET', path: '/api/v1/admin/settings', handler: handleGetSettings },
    { method: 'PATCH', path: '/api/v1/admin/settings', handler: handlePatchSettings },
    { method: 'POST', path: '/api/v1/admin/settings/smtp-test', handler: handleSmtpTest },
    { method: 'POST', path: '/api/v1/admin/settings/api-key', handler: handleCreateApiKey },
    { method: 'DELETE', path: '/api/v1/admin/settings/api-key', handler: handleRevokeApiKey },
    { method: 'GET', path: '/api/v1/admin/runtime', handler: handleGetRuntime },
    { method: 'GET', path: '/api/v1/admin/groups', handler: handleListGroups },
    { method: 'POST', path: '/api/v1/admin/groups', handler: handleCreateGroup },
    { method: 'PATCH', path: '/api/v1/admin/groups/:id', handler: handlePatchGroup },
    { method: 'DELETE', path: '/api/v1/admin/groups/:id', handler: handleDeleteGroup },
    { method: 'GET', path: '/api/v1/admin/users', handler: handleListUsers },
    { method: 'POST', path: '/api/v1/admin/users', handler: handleCreateUser },
    { method: 'PATCH', path: '/api/v1/admin/users/:id', handler: handlePatchUser },
    { method: 'POST', path: '/api/v1/admin/users/:id/reset-password', handler: handleResetUserPassword },
    { method: 'DELETE', path: '/api/v1/admin/users/:id', handler: handleDeleteUser },
  ];
}
