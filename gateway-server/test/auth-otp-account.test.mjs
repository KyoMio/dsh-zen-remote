// GC-5 邮箱 OTP 与自助账号设置 REST 契约测试：真实 http.Server + SqliteStore(:memory:)
// + 本机 node:net 假 SMTP 服务器（零依赖，捕获 MAIL FROM / RCPT TO / 正文中的 6 位验证码）。
// 覆盖：send-otp 的 SMTP 未配置 503、注册验证全链路（冷却/锁定/正确码注册）、
// 忘记密码防枚举与会话吊销、同 IP 滑动窗限流、已登录改密（当前会话保留）、
// 两步换绑邮箱（SMTP 开/关两种形态）。与 store.test.mjs 相同：.mjs 直接 import 编译产物 ../dist/。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createGatewayApiServer } from '../dist/server.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import { deriveMasterKeyFromSecret, hashPassword } from '../dist/master-key.js';
import {
  OTP_COOLDOWN_MS,
  OTP_IP_MAX_REQUESTS,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  encodeSmtpConfig,
  hashOtpCode,
  otpSendRateLimiter,
} from '../dist/http/auth.js';

const MASTER_KEY = deriveMasterKeyFromSecret('auth-otp-account-test');
const ADMIN_EMAIL = 'admin@local';
const ADMIN_PASSWORD = 'admin-pass-1234';
const SESSION_COOKIE_RE = /^zr_gw_session=[0-9a-f]{64}$/;

// ---------------------------------------------------------------- 假 SMTP 服务器

/**
 * 零依赖 mock SMTP：明文会话、EHLO 广告 AUTH PLAIN、逐命令回 250、DATA 收完整个
 * payload 记入 messages。只服务本文件的 sendMail 调用，不做任何校验。
 */
function createFakeSmtp() {
  const state = { messages: [], openSockets: new Set() };
  const server = net.createServer((sock) => {
    state.openSockets.add(sock);
    sock.on('error', () => {}); // 客户端 destroy 后的 ECONNRESET 吞掉即可
    sock.once('close', () => state.openSockets.delete(sock));
    const conn = { buf: '', inData: false, from: null, to: null };
    sock.write('220 fake.gateway.local ESMTP fake ready\r\n');
    sock.on('data', function onData(chunk) {
      conn.buf += chunk.toString('utf8');
      while (true) {
        if (conn.inData) {
          const end = conn.buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const payload = conn.buf.slice(0, end + 2); // 含正文尾 CRLF，不含终止符
          conn.buf = conn.buf.slice(end + 5);
          conn.inData = false;
          state.messages.push({ from: conn.from, to: conn.to, payload });
          sock.write('250 OK message accepted\r\n');
          continue;
        }
        const idx = conn.buf.indexOf('\r\n');
        if (idx < 0) return;
        const line = conn.buf.slice(0, idx);
        conn.buf = conn.buf.slice(idx + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          sock.write('250-fake.gateway.local\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          sock.write('235 accepted\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          conn.from = line;
          sock.write('250 OK\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          conn.to = line;
          sock.write('250 OK\r\n');
        } else if (upper.startsWith('DATA')) {
          conn.inData = true;
          sock.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (upper.startsWith('QUIT')) {
          sock.write('221 bye\r\n');
          sock.end();
        } else {
          sock.write('250 OK\r\n');
        }
      }
    });
  });
  return { server, state };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** 从捕获的邮件里取 6 位验证码：主题行（中英双语）都以验证码结尾；中文主题是 RFC 2047 编码词 */
function otpFromMessage(message) {
  const subjectLine = message.payload.split('\r\n').find((line) => line.toUpperCase().startsWith('SUBJECT:'));
  assert.ok(subjectLine, `message must have a Subject header:\n${message.payload}`);
  const encoded = /=\?UTF-8\?B\?([^?]*)\?=/.exec(subjectLine);
  const subject = encoded
    ? Buffer.from(encoded[1], 'base64').toString('utf8')
    : subjectLine.slice('Subject:'.length).trim();
  const match = /(\d{6})\s*$/.exec(subject);
  assert.ok(match, `subject must end with the 6-digit code: ${subjectLine}`);
  return match[1];
}

/** 一个必然错误（≠ 真实验证码）的 6 位码 */
function wrongCode(realCode) {
  return realCode === '000000' ? '111111' : '000000';
}

// ---------------------------------------------------------------- HTTP 测试夹具

function seedSettings(overrides = {}) {
  return { allowSignup: false, maxNetworksPerUser: 2, defaultMaxPeers: 4, relayRateKbps: 2048, ...overrides };
}

async function startServer(opts = {}) {
  const store = opts.store ?? new SqliteStore({ seed: seedSettings(opts.seed) });
  const server = createGatewayApiServer({ store, masterKey: MASTER_KEY, publicUrl: opts.publicUrl });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, store, base: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(handle) {
  await new Promise((resolve) => {
    handle.server.closeIdleConnections?.();
    handle.server.close(() => resolve());
    handle.server.closeAllConnections?.();
  });
  await handle.store.close();
}

/** 与 rest-api.test.mjs 同一套客户端：写请求默认带同源 Origin（浏览器形态） */
async function api(base, method, path, { body, headers = {}, cookie } = {}) {
  const h = { ...headers };
  if (method !== 'GET' && method !== 'HEAD') h.origin = base;
  if (cookie !== undefined) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null, setCookies: res.headers.getSetCookie() };
}

function sessionCookie(res) {
  const raw = res.setCookies.find((c) => c.startsWith('zr_gw_session='));
  assert.ok(raw, 'expected a zr_gw_session Set-Cookie header');
  const pair = raw.split(';')[0];
  assert.match(pair, SESSION_COOKIE_RE);
  return pair;
}

async function login(base, email, password) {
  const res = await api(base, 'POST', '/api/v1/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login ${email} failed: ${JSON.stringify(res.json)}`);
  return sessionCookie(res);
}

function assertEnvelopeError(json, code) {
  assert.equal(json.ok, false);
  assert.equal(json.error.code, code);
  assert.ok(json.error.message.length > 0);
}

/** 任何认证/账号响应都不得携带秘密字段（密码哈希、SMTP 密文/密码、验证码哈希） */
function assertNoSecrets(json) {
  const text = JSON.stringify(json);
  assert.ok(!text.includes('passwordHash'), 'response must not contain passwordHash');
  assert.ok(!text.includes('smtpConfigEnc'), 'response must not contain smtpConfigEnc');
  assert.ok(!text.includes('smtp-test-pass'), 'response must not contain the SMTP password');
  assert.ok(!text.includes('codeHash'), 'response must not contain codeHash');
}

async function seedTenant(store, email, password) {
  return store.createUser({ email, passwordHash: await hashPassword(password), role: 'user' });
}

// ---------------------------------------------------------------- 1. SMTP 未配置

describe('SMTP 未配置（独立实例）', () => {
  let handle;
  let adminCookie;

  before(async () => {
    handle = await startServer();
    await handle.store.ensureBootstrapAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminCookie = await login(handle.base, ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  after(async () => stopServer(handle));

  test('send-otp 一律 503 SMTP_NOT_CONFIGURED（signup 与 reset_password 同样拒绝）', async () => {
    for (const purpose of ['signup', 'reset_password']) {
      const res = await api(handle.base, 'POST', '/api/v1/auth/send-otp', {
        body: { email: 'someone@example.com', purpose },
      });
      assert.equal(res.status, 503);
      assertEnvelopeError(res.json, 'SMTP_NOT_CONFIGURED');
    }
  });

  test('换绑申请响应不含秘密，且密码错误 → 401', async () => {
    const bad = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: adminCookie,
      body: { currentPassword: 'wrong-pass-999', newEmail: 'root@example.com' },
    });
    assert.equal(bad.status, 401);
    assertEnvelopeError(bad.json, 'INVALID_CREDENTIALS');
    assertNoSecrets(bad.json);
  });

  test('换绑参数校验：非法邮箱 / 与当前相同 → 400', async () => {
    const notEmail = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: 'not-an-email' },
    });
    assert.equal(notEmail.status, 400);
    assertEnvelopeError(notEmail.json, 'INVALID_REQUEST');
    const same = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: ADMIN_EMAIL },
    });
    assert.equal(same.status, 400);
    assertEnvelopeError(same.json, 'INVALID_REQUEST');
  });

  test('无 SMTP 一步换绑：request 报 otpRequired:false，confirm 直改成功', async () => {
    const request = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: 'root@example.com' },
    });
    assert.equal(request.status, 200);
    assert.deepEqual(request.json.data, { otpRequired: false, cooldownSec: 0 });

    const confirm = await api(handle.base, 'POST', '/api/v1/auth/account/email', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: 'root@example.com' },
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.json.ok, true);
    assert.equal(confirm.json.data.user.email, 'root@example.com');
    assert.equal(confirm.json.data.user.emailVerifiedAt, null); // 无 SMTP 换绑视为未验证
    assertNoSecrets(confirm.json);

    const me = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: adminCookie });
    assert.equal(me.json.data.authenticated, true);
    assert.equal(me.json.data.user.email, 'root@example.com');
  });

  test('换绑后新邮箱 + 原密码可登录，旧邮箱失效', async () => {
    const oldEmail = await api(handle.base, 'POST', '/api/v1/auth/login', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(oldEmail.status, 401);
    const newEmail = await login(handle.base, 'root@example.com', ADMIN_PASSWORD);
    assert.match(newEmail, SESSION_COOKIE_RE);
  });
});

// ---------------------------------------------------------------- 2. 注册邮箱验证全链路

describe('注册邮箱验证全链路（独立实例 + 假 SMTP）', () => {
  let handle;
  let smtp;
  let smtpPort;
  const EMAIL = 'alice@example.com';
  const PASSWORD = 'alice-pass-1234';

  before(async () => {
    smtp = createFakeSmtp();
    smtpPort = await listen(smtp.server);
    handle = await startServer({
      seed: seedSettings({
        allowSignup: true,
        requireEmailVerification: true,
        smtpConfigEnc: encodeSmtpConfig(
          {
            host: '127.0.0.1',
            port: smtpPort,
            security: 'none',
            username: 'mailer@gateway.local',
            password: 'smtp-test-pass',
            fromAddress: 'gateway@example.com',
            fromName: 'Zen Remote Gateway',
          },
          MASTER_KEY,
        ),
      }),
    });
  });

  after(async () => {
    await stopServer(handle);
    await closeServer(smtp.server);
  });

  test('缺验证码注册 → 400 INVALID_REQUEST，不建用户', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/auth/signup', {
      body: { email: EMAIL, password: PASSWORD },
    });
    assert.equal(res.status, 400);
    assertEnvelopeError(res.json, 'INVALID_REQUEST');
    assert.equal(await handle.store.findUserByEmail(EMAIL), null);
  });

  test('验证码格式非法（非 6 位数字）→ 400，不计错输', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/auth/signup', {
      body: { email: EMAIL, password: PASSWORD, otpCode: '12ab56' },
    });
    assert.equal(res.status, 400);
    assertEnvelopeError(res.json, 'INVALID_REQUEST');
    assert.equal(await handle.store.findUserByEmail(EMAIL), null);
  });

  test('send-otp → 200 sent:true，假 SMTP 收信且 RCPT TO 指向注册邮箱', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/auth/send-otp', {
      body: { email: EMAIL, purpose: 'signup' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { sent: true, cooldownSec: 60 });
    assert.equal(smtp.state.messages.length, 1);
    assert.equal(smtp.state.messages[0].to, `RCPT TO:<${EMAIL}>`);
    assert.match(otpFromMessage(smtp.state.messages[0]), /^\d{6}$/);
  });

  test('60s 内重发 → 429 OTP_COOLDOWN，不重复发信', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/auth/send-otp', {
      body: { email: EMAIL, purpose: 'signup' },
    });
    assert.equal(res.status, 429);
    assertEnvelopeError(res.json, 'OTP_COOLDOWN');
    assert.equal(smtp.state.messages.length, 1);
  });

  test(`连续错 ${OTP_MAX_ATTEMPTS} 次 → 429 OTP_LOCKED，正确码也被锁`, async () => {
    const real = otpFromMessage(smtp.state.messages[0]);
    const wrong = wrongCode(real);
    for (let i = 1; i <= OTP_MAX_ATTEMPTS - 1; i++) {
      const res = await api(handle.base, 'POST', '/api/v1/auth/signup', {
        body: { email: EMAIL, password: PASSWORD, otpCode: wrong },
      });
      assert.equal(res.status, 400, `attempt ${i} should be 400 OTP_INVALID`);
      assertEnvelopeError(res.json, 'OTP_INVALID');
    }
    const fifth = await api(handle.base, 'POST', '/api/v1/auth/signup', {
      body: { email: EMAIL, password: PASSWORD, otpCode: wrong },
    });
    assert.equal(fifth.status, 429);
    assertEnvelopeError(fifth.json, 'OTP_LOCKED');
    // 锁定后连正确码也拒绝（锁定行未消费、保持到过期或被新签发覆盖）
    const correctButLocked = await api(handle.base, 'POST', '/api/v1/auth/signup', {
      body: { email: EMAIL, password: PASSWORD, otpCode: real },
    });
    assert.equal(correctButLocked.status, 429);
    assertEnvelopeError(correctButLocked.json, 'OTP_LOCKED');
    assert.equal(await handle.store.findUserByEmail(EMAIL), null);
  });

  test('重新签发后用正确码注册成功，emailVerifiedAt 落库且 /auth/me 带配额', async () => {
    // 锁定行要等冷却（60s）后才允许新签发；store 的 nowMs 注入让测试免等待
    const code2 = '246813';
    await handle.store.issueEmailOtp({
      email: EMAIL,
      purpose: 'signup',
      codeHash: hashOtpCode(MASTER_KEY, 'signup', EMAIL, code2),
      ttlMs: OTP_TTL_MS,
      cooldownMs: OTP_COOLDOWN_MS,
      nowMs: Date.now() + OTP_COOLDOWN_MS + 1000,
    });
    const res = await api(handle.base, 'POST', '/api/v1/auth/signup', {
      body: { email: EMAIL, password: PASSWORD, otp: code2 }, // otp 别名兼容
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.data.user.email, EMAIL);
    assert.ok(typeof res.json.data.user.emailVerifiedAt === 'string', 'verified signup must set emailVerifiedAt');
    assert.equal(res.json.data.requireEmailVerification, true);
    assert.equal(res.json.data.smtpConfigured, true);
    assertNoSecrets(res.json);

    const stored = await handle.store.findUserByEmail(EMAIL);
    assert.ok(stored.emailVerifiedAt !== null);

    const cookie = sessionCookie(res);
    const me = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.data.authenticated, true);
    assert.deepEqual(me.json.data.quota, {
      groupId: 'grp_default',
      assignedGroupId: 'grp_default',
      groupCode: 'default',
      groupName: '默认用户组',
      groupExpiresAt: null,
      isExpiredFallback: false,
      maxNetworks: 2,
      maxPeersPerNetwork: 4,
      relayRateKbps: 2048,
      monthlyRelayQuotaBytes: null,
      usedNetworks: 0,
      usedMonthlyRelayBytes: 0,
    });
    assertNoSecrets(me.json);
  });

  test('已验证邮箱重复 send-otp signup → 409 EMAIL_TAKEN', async () => {
    otpSendRateLimiter.clear(); // 甩掉本组前面累计的同 IP 计数，聚焦邮箱占用分支
    const res = await api(handle.base, 'POST', '/api/v1/auth/send-otp', {
      body: { email: EMAIL, purpose: 'signup' },
    });
    assert.equal(res.status, 409);
    assertEnvelopeError(res.json, 'EMAIL_TAKEN');
    assert.equal(smtp.state.messages.length, 1); // 不发信
  });
});

// ---------------------------------------------------------------- 3. 忘记密码防枚举与 IP 限流

describe('忘记密码重置与 IP 限流（独立实例 + 假 SMTP）', () => {
  let handle;
  let smtp;
  let smtpPort;
  const TENANT_EMAIL = 'tenant@example.com';
  const TENANT_PASSWORD = 'tenant-pass-1234';
  const NEW_PASSWORD = 'brand-new-pass-9';

  before(async () => {
    smtp = createFakeSmtp();
    smtpPort = await listen(smtp.server);
    handle = await startServer({
      seed: seedSettings({ smtpConfigEnc: encodeSmtpConfig(
        { host: '127.0.0.1', port: smtpPort, security: 'none', fromAddress: 'gateway@example.com' },
        MASTER_KEY,
      ) }),
    });
    await handle.store.ensureBootstrapAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    await seedTenant(handle.store, TENANT_EMAIL, TENANT_PASSWORD);
    await handle.store.createUser({ email: 'off@example.com', passwordHash: await hashPassword('off-pass-12345'), role: 'user' });
    await handle.store.setUserActive((await handle.store.findUserByEmail('off@example.com')).id, false);
  });

  after(async () => {
    await stopServer(handle);
    await closeServer(smtp.server);
  });

  test('未注册邮箱防枚举：仍返回 sent:true，零收信、零写库', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/auth/send-otp', {
      body: { email: 'ghost@example.com', purpose: 'reset_password' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { sent: true, cooldownSec: 60 });
    assert.equal(smtp.state.messages.length, 0);
  });

  test('已停用账号同样防枚举：sent:true 且不发信', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/auth/send-otp', {
      body: { email: 'off@example.com', purpose: 'reset_password' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { sent: true, cooldownSec: 60 });
    assert.equal(smtp.state.messages.length, 0);
  });

  test('重置参数校验：验证码格式 / 新密码长度 → 400（不核销验证码）', async () => {
    const send = await api(handle.base, 'POST', '/api/v1/auth/send-otp', {
      body: { email: TENANT_EMAIL, purpose: 'reset_password' },
    });
    assert.equal(send.status, 200);
    assert.equal(smtp.state.messages.length, 1);
    const real = otpFromMessage(smtp.state.messages[0]);

    const badCode = await api(handle.base, 'POST', '/api/v1/auth/reset-password', {
      body: { email: TENANT_EMAIL, otpCode: 'abc123', newPassword: NEW_PASSWORD },
    });
    assert.equal(badCode.status, 400);
    assertEnvelopeError(badCode.json, 'INVALID_REQUEST');

    const shortPass = await api(handle.base, 'POST', '/api/v1/auth/reset-password', {
      body: { email: TENANT_EMAIL, otpCode: real, newPassword: 'short' },
    });
    assert.equal(shortPass.status, 400);
    assertEnvelopeError(shortPass.json, 'INVALID_REQUEST');
    // 两次都停在参数校验，验证码未被消费也未计错输
  });

  test('收码重置成功：全部旧会话吊销、旧密码失效、新密码可登录', async () => {
    const real = otpFromMessage(smtp.state.messages[0]);
    const cookieA = await login(handle.base, TENANT_EMAIL, TENANT_PASSWORD);
    const cookieB = await login(handle.base, TENANT_EMAIL, TENANT_PASSWORD);

    const reset = await api(handle.base, 'POST', '/api/v1/auth/reset-password', {
      body: { email: TENANT_EMAIL, otpCode: real, newPassword: NEW_PASSWORD },
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.json.data, { reset: true });

    for (const cookie of [cookieA, cookieB]) {
      const me = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie });
      assert.equal(me.json.data.authenticated, false, 'reset must revoke every existing session');
    }
    const oldLogin = await api(handle.base, 'POST', '/api/v1/auth/login', {
      body: { email: TENANT_EMAIL, password: TENANT_PASSWORD },
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await login(handle.base, TENANT_EMAIL, NEW_PASSWORD);
    assert.match(newLogin, SESSION_COOKIE_RE);
    assertNoSecrets(reset.json);
  });

  test(`重置验证码错输 ${OTP_MAX_ATTEMPTS} 次 → 429 OTP_LOCKED`, async () => {
    const send = await api(handle.base, 'POST', '/api/v1/auth/send-otp', {
      body: { email: TENANT_EMAIL, purpose: 'reset_password' },
    });
    assert.equal(send.status, 200);
    assert.equal(smtp.state.messages.length, 2);
    const real = otpFromMessage(smtp.state.messages[1]);
    const wrong = wrongCode(real);
    for (let i = 1; i <= OTP_MAX_ATTEMPTS - 1; i++) {
      const res = await api(handle.base, 'POST', '/api/v1/auth/reset-password', {
        body: { email: TENANT_EMAIL, otpCode: wrong, newPassword: NEW_PASSWORD },
      });
      assert.equal(res.status, 400);
      assertEnvelopeError(res.json, 'OTP_INVALID');
    }
    const locked = await api(handle.base, 'POST', '/api/v1/auth/reset-password', {
      body: { email: TENANT_EMAIL, otpCode: wrong, newPassword: NEW_PASSWORD },
    });
    assert.equal(locked.status, 429);
    assertEnvelopeError(locked.json, 'OTP_LOCKED');
    // 密码保持不变：锁定后旧密码仍可登录
    const still = await api(handle.base, 'POST', '/api/v1/auth/login', {
      body: { email: TENANT_EMAIL, password: NEW_PASSWORD },
    });
    assert.equal(still.status, 200);
  });

  test(`同 IP 滑动窗超过 ${OTP_IP_MAX_REQUESTS} 次 → 429 RATE_LIMITED`, async () => {
    otpSendRateLimiter.clear(); // 独立计数：本组前面的合法用量不算进突发窗口
    const statuses = [];
    for (let i = 0; i <= OTP_IP_MAX_REQUESTS; i++) {
      const res = await api(handle.base, 'POST', '/api/v1/auth/send-otp', {
        body: { email: `burst${i}@example.com`, purpose: 'reset_password' },
      });
      statuses.push(res.status);
      if (res.status === 429) assertEnvelopeError(res.json, 'RATE_LIMITED');
    }
    assert.deepEqual(statuses.slice(0, OTP_IP_MAX_REQUESTS), new Array(OTP_IP_MAX_REQUESTS).fill(200));
    assert.equal(statuses[OTP_IP_MAX_REQUESTS], 429);
    // 这些请求都没触发发信（收件人不存在）
    assert.equal(smtp.state.messages.length, 2);
  });
});

// ---------------------------------------------------------------- 4. 已登录改密

describe('PATCH /api/v1/auth/account/password（独立实例）', () => {
  let handle;
  let mainCookie;
  let otherCookie;
  const TENANT_EMAIL = 'changepw@example.com';
  const OLD_PASSWORD = 'old-pass-123456';
  const NEW_PASSWORD = 'fresh-pass-654321';

  before(async () => {
    handle = await startServer();
    await handle.store.ensureBootstrapAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    await seedTenant(handle.store, TENANT_EMAIL, OLD_PASSWORD);
    mainCookie = await login(handle.base, TENANT_EMAIL, OLD_PASSWORD);
    otherCookie = await login(handle.base, TENANT_EMAIL, OLD_PASSWORD);
  });

  after(async () => stopServer(handle));

  test('未登录 → 401 UNAUTHENTICATED', async () => {
    const res = await api(handle.base, 'PATCH', '/api/v1/auth/account/password', {
      body: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 401);
    assertEnvelopeError(res.json, 'UNAUTHENTICATED');
  });

  test('当前密码错误 → 401 INVALID_CREDENTIALS，会话不受影响', async () => {
    const res = await api(handle.base, 'PATCH', '/api/v1/auth/account/password', {
      cookie: mainCookie,
      body: { currentPassword: 'wrong-pass-999', newPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 401);
    assertEnvelopeError(res.json, 'INVALID_CREDENTIALS');
    const me = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: mainCookie });
    assert.equal(me.json.data.authenticated, true);
  });

  test('新密码太短 → 400 INVALID_REQUEST', async () => {
    const res = await api(handle.base, 'PATCH', '/api/v1/auth/account/password', {
      cookie: mainCookie,
      body: { currentPassword: OLD_PASSWORD, newPassword: 'short' },
    });
    assert.equal(res.status, 400);
    assertEnvelopeError(res.json, 'INVALID_REQUEST');
  });

  test('改密成功：当前 Cookie 仍有效，另一会话 Cookie 立即失效', async () => {
    const res = await api(handle.base, 'PATCH', '/api/v1/auth/account/password', {
      cookie: mainCookie,
      body: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { changed: true });
    assertNoSecrets(res.json);

    const me = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: mainCookie });
    assert.equal(me.json.data.authenticated, true, 'the session that changed the password must survive');
    const stale = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: otherCookie });
    assert.equal(stale.json.data.authenticated, false, 'all other sessions must be revoked');

    const oldLogin = await api(handle.base, 'POST', '/api/v1/auth/login', {
      body: { email: TENANT_EMAIL, password: OLD_PASSWORD },
    });
    assert.equal(oldLogin.status, 401);
    await login(handle.base, TENANT_EMAIL, NEW_PASSWORD);
  });
});

// ---------------------------------------------------------------- 5. 两步换绑邮箱（SMTP 开启）

describe('两步换绑邮箱（独立实例 + 假 SMTP）', () => {
  let handle;
  let smtp;
  let smtpPort;
  let adminCookie;
  const NEW_EMAIL = 'root@example.com';

  before(async () => {
    smtp = createFakeSmtp();
    smtpPort = await listen(smtp.server);
    handle = await startServer({
      seed: seedSettings({ smtpConfigEnc: encodeSmtpConfig(
        {
          host: '127.0.0.1',
          port: smtpPort,
          security: 'none',
          username: 'mailer@gateway.local',
          password: 'smtp-test-pass',
          fromAddress: 'gateway@example.com',
          fromName: 'Zen Remote Gateway',
        },
        MASTER_KEY,
      ) }),
    });
    await handle.store.ensureBootstrapAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    await seedTenant(handle.store, 'taken@example.com', 'taken-pass-12345'); // 占用邮箱查重用
    adminCookie = await login(handle.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    otpSendRateLimiter.clear();
  });

  after(async () => {
    await stopServer(handle);
    await closeServer(smtp.server);
  });

  test('新邮箱已被占用 → 409 EMAIL_TAKEN（查重先于发码）', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: 'taken@example.com' },
    });
    assert.equal(res.status, 409);
    assertEnvelopeError(res.json, 'EMAIL_TAKEN');
    assert.equal(smtp.state.messages.length, 0);
  });

  test('第一步 request：发 change_email 验证码到新邮箱', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: NEW_EMAIL, locale: 'en' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { otpRequired: true, cooldownSec: 60 });
    assert.equal(smtp.state.messages.length, 1);
    assert.equal(smtp.state.messages[0].to, `RCPT TO:<${NEW_EMAIL}>`);
    assert.match(otpFromMessage(smtp.state.messages[0]), /^\d{6}$/);
  });

  test('60s 内重复 request → 429 OTP_COOLDOWN', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: NEW_EMAIL },
    });
    assert.equal(res.status, 429);
    assertEnvelopeError(res.json, 'OTP_COOLDOWN');
    assert.equal(smtp.state.messages.length, 1);
  });

  test('第二步 confirm：错码 400 OTP_INVALID / 缺码 400 INVALID_REQUEST', async () => {
    const real = otpFromMessage(smtp.state.messages[0]);
    const wrong = await api(handle.base, 'POST', '/api/v1/auth/account/email', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: NEW_EMAIL, otpCode: wrongCode(real) },
    });
    assert.equal(wrong.status, 400);
    assertEnvelopeError(wrong.json, 'OTP_INVALID');
    const missing = await api(handle.base, 'POST', '/api/v1/auth/account/email', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: NEW_EMAIL },
    });
    assert.equal(missing.status, 400);
    assertEnvelopeError(missing.json, 'INVALID_REQUEST');
  });

  test('正确验证码 → 换绑成功、视为已验证、新邮箱可登录；响应不含秘密', async () => {
    const real = otpFromMessage(smtp.state.messages[0]);
    const confirm = await api(handle.base, 'POST', '/api/v1/auth/account/email', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: NEW_EMAIL, otpCode: real },
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.json.ok, true);
    assert.equal(confirm.json.data.user.email, NEW_EMAIL);
    assert.ok(typeof confirm.json.data.user.emailVerifiedAt === 'string', 'OTP-verified change must set emailVerifiedAt');
    assert.deepEqual(Object.keys(confirm.json.data.user).sort(), ['email', 'emailVerifiedAt', 'id', 'role']);
    assertNoSecrets(confirm.json);

    // 换绑不动会话：当前 Cookie 仍有效，且 /auth/me 反映新邮箱
    const me = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: adminCookie });
    assert.equal(me.json.data.authenticated, true);
    assert.equal(me.json.data.user.email, NEW_EMAIL);
    assert.equal(me.json.data.smtpConfigured, true);
    assertNoSecrets(me.json);

    const oldEmail = await api(handle.base, 'POST', '/api/v1/auth/login', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(oldEmail.status, 401);
    await login(handle.base, NEW_EMAIL, ADMIN_PASSWORD);
  });
});
