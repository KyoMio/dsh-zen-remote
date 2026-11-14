// 登录用户的自助「账号设置」路由（GC-5）：改密（当前会话不掉线、其余会话全部吊销）
// 与两步换绑邮箱（SMTP 未配置时一步直改，方便初始 admin@local 换绑真实邮箱）。
// 三条路由都 requireUser 前置；响应只含用户公开字段，绝不携带 passwordHash、
// smtpConfigEnc、SMTP 密码或验证码明文。
import {
  ApiError,
  OTP_COOLDOWN_MS,
  OTP_MAX_ATTEMPTS,
  authUserPayload,
  currentSessionTokenHash,
  hashOtpCode,
  issueAndSendOtp,
  isValidEmail,
  loadAuthEnvironment,
  otpSendRateLimiter,
  readJsonObjectBody,
  requestClientIp,
  requireUser,
  sendOk,
} from './auth.js';
import type { RouteContext, RouteDef } from './auth.js';
import { hashPassword, verifyPassword } from '../master-key.js';
import type { MailLocale } from '../mail/templates.js';

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function requestLocale(body: Record<string, unknown>): MailLocale {
  return body['locale'] === 'en' ? 'en' : 'zh';
}

/** 读 body 里的 6 位数字验证码（otpCode 主字段，otp 别名兼容）；缺失/格式错 → 400 */
function readAccountOtpCode(body: Record<string, unknown>): string {
  const raw = body['otpCode'] ?? body['otp'];
  if (typeof raw !== 'string' || !/^\d{6}$/.test(raw)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'a 6-digit verification code is required');
  }
  return raw;
}

/**
 * PATCH /api/v1/auth/account/password：改密需当前密码。传 keepTokenHash（当前请求的
 * 会话令牌哈希）——当前设备 Cookie 继续有效，同一用户的其他所有会话立即失效。
 */
async function handleChangePassword(ctx: RouteContext): Promise<void> {
  const user = await requireUser(ctx);
  const body = await readJsonObjectBody(ctx.req);
  const currentPassword = readString(body, 'currentPassword');
  const newPassword = readString(body, 'newPassword');
  if (currentPassword.length === 0 || newPassword.length < 8 || newPassword.length > 128) {
    throw new ApiError(400, 'INVALID_REQUEST', 'currentPassword and newPassword (8..128 characters) are required');
  }
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'current password is incorrect');
  }
  const keepTokenHash = currentSessionTokenHash(ctx.req);
  await ctx.store.updateUserPassword(user.id, await hashPassword(newPassword), keepTokenHash ?? undefined);
  sendOk(ctx.res, { changed: true });
}

/**
 * POST /api/v1/auth/account/email/request：换绑第一步。SMTP 已配置时向新邮箱发
 * change_email 验证码；未配置时直接放行（otpRequired: false），配合下一步一步改绑。
 */
async function handleRequestEmailChange(ctx: RouteContext): Promise<void> {
  const user = await requireUser(ctx);
  const body = await readJsonObjectBody(ctx.req);
  const currentPassword = readString(body, 'currentPassword');
  const newEmail = readString(body, 'newEmail').trim().toLowerCase();
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'current password is incorrect');
  }
  if (!isValidEmail(newEmail)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'a valid newEmail is required');
  }
  if (newEmail === user.email.toLowerCase()) {
    throw new ApiError(400, 'INVALID_REQUEST', 'newEmail must differ from the current email');
  }
  const existing = await ctx.store.findUserByEmail(newEmail);
  if (existing !== null) {
    throw new ApiError(409, 'EMAIL_TAKEN', 'email already registered');
  }
  const env = await loadAuthEnvironment(ctx);
  if (!env.smtpConfigured || env.smtp === null) {
    sendOk(ctx.res, { otpRequired: false, cooldownSec: 0 });
    return;
  }
  if (!otpSendRateLimiter.tryConsume(requestClientIp(ctx.req))) {
    throw new ApiError(429, 'RATE_LIMITED', 'too many verification code requests, try again later');
  }
  await issueAndSendOtp(ctx, env, env.smtp, newEmail, 'change_email', requestLocale(body));
  sendOk(ctx.res, { otpRequired: true, cooldownSec: OTP_COOLDOWN_MS / 1000 });
}

/**
 * POST /api/v1/auth/account/email：换绑第二步。SMTP 已配置时强制核验发到新邮箱的
 * change_email 验证码（换绑后视为已验证）；未配置时跳过 OTP（换绑后视为未验证）。
 */
async function handleConfirmEmailChange(ctx: RouteContext): Promise<void> {
  const user = await requireUser(ctx);
  const body = await readJsonObjectBody(ctx.req);
  const currentPassword = readString(body, 'currentPassword');
  const newEmail = readString(body, 'newEmail').trim().toLowerCase();
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'current password is incorrect');
  }
  if (!isValidEmail(newEmail)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'a valid newEmail is required');
  }
  if (newEmail === user.email.toLowerCase()) {
    throw new ApiError(400, 'INVALID_REQUEST', 'newEmail must differ from the current email');
  }
  const env = await loadAuthEnvironment(ctx);
  let emailVerifiedAt: string | null = null;
  if (env.smtpConfigured) {
    const code = readAccountOtpCode(body);
    await ctx.store.verifyAndConsumeEmailOtp({
      email: newEmail,
      purpose: 'change_email',
      codeHash: hashOtpCode(ctx.masterKey, 'change_email', newEmail, code),
      maxAttempts: OTP_MAX_ATTEMPTS,
    });
    emailVerifiedAt = new Date().toISOString();
  }
  // 新邮箱在两步之间被抢注 → store 抛 duplicate-email → 409 EMAIL_TAKEN
  const updated = await ctx.store.updateUserEmail(user.id, newEmail, emailVerifiedAt);
  sendOk(ctx.res, { user: authUserPayload(updated) });
}

export function buildAccountRoutes(): RouteDef[] {
  return [
    { method: 'PATCH', path: '/api/v1/auth/account/password', handler: handleChangePassword },
    { method: 'POST', path: '/api/v1/auth/account/email/request', handler: handleRequestEmailChange },
    { method: 'POST', path: '/api/v1/auth/account/email', handler: handleConfirmEmailChange },
  ];
}
