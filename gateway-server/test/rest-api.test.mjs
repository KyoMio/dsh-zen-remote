// PG-4 REST API 契约测试：真实 http.Server + SqliteStore(:memory:)。
// 覆盖：统一 JSON 信封、Cookie 会话鉴权、同源写保护（CSRF）、auth 四路由、
// allowSignup 开关联动注册、租户隔离与 admin 门禁、网络 CRUD / 配额 / rotate-key、
// 成员五态操作（approve/reject/pause/resume/repin/delete）与满额 409、
// 管理员路由与停用租户即时令 Cookie 失效。
// 与 store.test.mjs 相同：.mjs 直接 import 编译产物 ../dist/。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createGatewayApiServer } from '../dist/server.js';
import { encodeSmtpConfig, hashToken } from '../dist/http/auth.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import { deriveMasterKeyFromSecret, hashPassword, decryptSecret } from '../dist/master-key.js';
import { maskInviteUri } from '../dist/web/format.js';

const MASTER_KEY = deriveMasterKeyFromSecret('rest-api-test');
const ADMIN_EMAIL = 'admin@local';
const ADMIN_PASSWORD = 'admin-pass-1234';
const TENANT_EMAIL = 'tenant@local';
const TENANT_PASSWORD = 'tenant-pass-1234';
const SESSION_COOKIE_RE = /^zr_gw_session=[0-9a-f]{64}$/; // 32B 随机令牌 hex

function seedSettings(overrides = {}) {
  return { allowSignup: false, maxNetworksPerUser: 2, defaultMaxPeers: 4, relayRateKbps: 2048, ...overrides };
}

async function startServer(opts = {}) {
  const store = opts.store ?? new SqliteStore({ seed: opts.seed ?? seedSettings() });
  const hooks = { memberChanged: [], networkDeleted: [], settingsChanged: [], userDisabled: [], quotaChanged: [], userDeleted: [] };
  const server = createGatewayApiServer({
    store,
    masterKey: MASTER_KEY,
    publicUrl: opts.publicUrl,
    runtimeMeta: opts.runtimeMeta,
    runtime: opts.runtime,
    hooks: {
      onMemberChanged: (event) => hooks.memberChanged.push(event),
      onNetworkDeleted: (networkId) => hooks.networkDeleted.push(networkId),
      onSettingsChanged: (settings) => hooks.settingsChanged.push(settings),
      onUserDisabled: (userId) => hooks.userDisabled.push(userId),
      onQuotaChanged: (userId) => hooks.quotaChanged.push(userId ?? null),
      onUserDeleted: (userId) => hooks.userDeleted.push(userId),
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, store, hooks, base: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(handle) {
  await new Promise((resolve) => {
    handle.server.closeIdleConnections?.();
    handle.server.close(() => resolve());
    handle.server.closeAllConnections?.();
  });
  await handle.store.close();
}

/**
 * 统一 API 客户端。写请求默认带同源 Origin（浏览器形态）；origin 选项：
 * - undefined → 自动带 Origin: base（同源浏览器）
 * - null → 不带 Origin、不带 Sec-Fetch-Site（桌面端 / CLI 形态）
 * - 'http://...' → 显式 Origin（跨站测试）；headers 可再补 sec-fetch-site
 */
async function api(base, method, path, { body, headers = {}, cookie, origin } = {}) {
  const h = { ...headers };
  const isWrite = method !== 'GET' && method !== 'HEAD';
  if (isWrite && origin === undefined) h.origin = base;
  else if (typeof origin === 'string') h.origin = origin;
  if (cookie !== undefined) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const text = await res.text();
  const json = text.length > 0 ? JSON.parse(text) : null;
  return { status: res.status, json, setCookies: res.headers.getSetCookie() };
}

function sessionCookie(res) {
  const raw = res.setCookies.find((c) => c.startsWith('zr_gw_session='));
  assert.ok(raw, 'expected a zr_gw_session Set-Cookie header');
  const pair = raw.split(';')[0];
  assert.match(pair, SESSION_COOKIE_RE);
  return pair;
}

function assertEnvelopeError(json, code) {
  assert.equal(json.ok, false);
  assert.deepEqual(Object.keys(json.error).sort(), ['code', 'message']);
  assert.equal(json.error.code, code);
  assert.ok(json.error.message.length > 0);
}

async function seedUsers(store) {
  await store.ensureBootstrapAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const tenant = await store.createUser({
    email: TENANT_EMAIL,
    passwordHash: await hashPassword(TENANT_PASSWORD),
    role: 'user',
  });
  const admin = await store.findUserByEmail(ADMIN_EMAIL);
  return { tenantId: tenant.id, adminId: admin.id };
}

async function login(base, email, password) {
  const res = await api(base, 'POST', '/api/v1/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login ${email} failed: ${JSON.stringify(res.json)}`);
  return sessionCookie(res);
}

/** 经 store 直造成员（模拟 PG-5 入网协议落库后的状态），REST 层在其上做状态操作 */
async function seedMember(store, netId, nodeId, state) {
  const attempt = (publicKeyHex, matched) =>
    store.upsertMemberJoinAttempt({
      networkId: netId,
      nodeId,
      name: `node-${nodeId}`,
      publicKeyHex,
      joinKeyMatched: matched,
    });
  if (state === 'pending') return attempt(`${nodeId}-pub`, false);
  if (state === 'authorized') return attempt(`${nodeId}-pub`, true);
  if (state === 'paused') {
    await attempt(`${nodeId}-pub`, true);
    return store.transitionMemberStatus(netId, nodeId, 'pause');
  }
  if (state === 'mismatch') {
    await attempt(`${nodeId}-pub`, true);
    return attempt(`${nodeId}-cand`, true); // 同 nodeId 换公钥 → mismatch 暂存候选
  }
  if (state === 'revoked') {
    await attempt(`${nodeId}-pub`, false); // both 模式无口令 → pending
    await store.transitionMemberStatus(netId, nodeId, 'reject');
    return (await store.listMembers(netId)).find((m) => m.nodeId === nodeId);
  }
  throw new Error(`unknown state ${state}`);
}

// ---------------------------------------------------------------- 主服务器：会话 / 注册 / 同源 / 隔离 / CRUD / 成员 / 管理员

describe('REST API /api/v1（主服务器）', () => {
  let handle;
  let adminCookie;
  let tenantCookie;
  let adminId;
  let tenantId;
  let tenantNetId;
  let adminNetId;
  let tenantJoinKey;

  before(async () => {
    handle = await startServer({ seed: seedSettings() });
    ({ adminId, tenantId } = await seedUsers(handle.store));
    adminCookie = await login(handle.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    tenantCookie = await login(handle.base, TENANT_EMAIL, TENANT_PASSWORD);
  });

  after(async () => stopServer(handle));

  // ---- 会话与信封

  describe('信封与会话鉴权', () => {
    test('未登录 GET /auth/me → 200 匿名信封（方便首屏渲染登录页）', async () => {
      const res = await api(handle.base, 'GET', '/api/v1/auth/me');
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.deepEqual(res.json.data, {
        authenticated: false,
        allowSignup: false,
        requireEmailVerification: false,
        smtpConfigured: false,
        maxNetworksPerUser: 2,
        defaultMaxPeers: 4,
      });
    });

    test('login 成功：信封 + HttpOnly/Path=/ SameSite=Strict Cookie（http 无 Secure）', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/login', {
        body: { email: TENANT_EMAIL, password: TENANT_PASSWORD },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.deepEqual(res.json.data, {
        user: { id: tenantId, email: TENANT_EMAIL, role: 'user', emailVerifiedAt: null },
        allowSignup: false,
        requireEmailVerification: false,
        smtpConfigured: false,
        maxNetworksPerUser: 2,
        defaultMaxPeers: 4,
        quota: {
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
        },
      });
      const raw = res.setCookies.find((c) => c.startsWith('zr_gw_session='));
      assert.ok(raw, 'expected Set-Cookie zr_gw_session');
      assert.ok(raw.includes('HttpOnly'));
      assert.ok(raw.includes('Path=/'));
      assert.ok(raw.includes('SameSite=Strict'));
      assert.ok(!raw.includes('Secure'), 'plain http request must not set Secure');
    });

    test('login Cookie 有效：带 Cookie 的 /auth/me 返回 authenticated user', async () => {
      const me = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: tenantCookie });
      assert.equal(me.status, 200);
      assert.equal(me.json.data.authenticated, true);
      assert.deepEqual(me.json.data.user, { id: tenantId, email: TENANT_EMAIL, role: 'user', emailVerifiedAt: null });
      // GC-5：登录态 /auth/me 附带有效组配额与公开策略
      assert.equal(me.json.data.quota.groupId, 'grp_default');
      assert.equal(me.json.data.quota.maxNetworks, 2);
      assert.equal(me.json.data.quota.usedMonthlyRelayBytes, 0);
      assert.equal(me.json.data.smtpConfigured, false);
      assert.equal(me.json.data.requireEmailVerification, false);
    });

    test('X-Forwarded-Proto: https → Cookie 附加 Secure', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/login', {
        body: { email: TENANT_EMAIL, password: TENANT_PASSWORD },
        headers: { 'x-forwarded-proto': 'https' },
      });
      const raw = res.setCookies.find((c) => c.startsWith('zr_gw_session='));
      assert.ok(raw.includes('Secure'));
      assert.ok(raw.includes('HttpOnly'));
    });

    test('login 密码错误 → 401 INVALID_CREDENTIALS，不发 Cookie', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/login', {
        body: { email: TENANT_EMAIL, password: 'wrong-pass-999' },
      });
      assert.equal(res.status, 401);
      assertEnvelopeError(res.json, 'INVALID_CREDENTIALS');
      assert.equal(res.setCookies.length, 0);
    });

    test('login 未知邮箱 → 同一 401 错误码（防枚举）', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/login', {
        body: { email: 'nobody@local', password: 'whatever-pass-1' },
      });
      assert.equal(res.status, 401);
      assertEnvelopeError(res.json, 'INVALID_CREDENTIALS');
    });

    test('login 缺字段 → 400 INVALID_REQUEST', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/login', { body: { email: TENANT_EMAIL } });
      assert.equal(res.status, 400);
      assertEnvelopeError(res.json, 'INVALID_REQUEST');
    });

    test('login body 非法 JSON → 400 INVALID_JSON', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/login', { body: '{oops' });
      assert.equal(res.status, 400);
      assertEnvelopeError(res.json, 'INVALID_JSON');
    });

    test('未登录访问受保护接口 → 401 UNAUTHENTICATED', async () => {
      const res = await api(handle.base, 'GET', '/api/v1/networks');
      assert.equal(res.status, 401);
      assertEnvelopeError(res.json, 'UNAUTHENTICATED');
    });

    test('无效令牌 Cookie 视为匿名', async () => {
      const res = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: 'zr_gw_session=deadbeef' });
      assert.equal(res.status, 200);
      assert.equal(res.json.data.authenticated, false);
    });

    test('logout：删除服务端会话 + 下发清除 Cookie，旧 Cookie 立即失效', async () => {
      const temp = await login(handle.base, TENANT_EMAIL, TENANT_PASSWORD);
      const res = await api(handle.base, 'POST', '/api/v1/auth/logout', { cookie: temp });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      const raw = res.setCookies.find((c) => c.startsWith('zr_gw_session='));
      assert.ok(raw, 'logout must clear the cookie');
      assert.ok(raw.includes('Max-Age=0'));
      assert.ok(raw.includes('HttpOnly'));
      const me = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: temp });
      assert.equal(me.json.data.authenticated, false);
    });
  });

  // ---- signup 开关联动

  describe('signup 与 allowSignup 开关联动', () => {
    test('allowSignup=false → 403 SIGNUP_DISABLED', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/signup', {
        body: { email: 'newbie@local', password: 'newbie-pass-123' },
      });
      assert.equal(res.status, 403);
      assertEnvelopeError(res.json, 'SIGNUP_DISABLED');
    });

    test('admin PATCH settings 开启 allowSignup', async () => {
      const res = await api(handle.base, 'PATCH', '/api/v1/admin/settings', {
        cookie: adminCookie,
        body: { allowSignup: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.data.allowSignup, true);
    });

    test('allowSignup=true → 注册成功且自动登录（role 固定 user、active）', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/signup', {
        body: { email: 'newbie@local', password: 'newbie-pass-123' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.data.user.role, 'user');
      const cookie = sessionCookie(res);
      const me = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie });
      assert.equal(me.json.data.authenticated, true);
      const stored = await handle.store.findUserByEmail('newbie@local');
      assert.equal(stored.role, 'user');
      assert.equal(stored.active, true);
    });

    test('重复邮箱注册 → 409 EMAIL_TAKEN', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/signup', {
        body: { email: 'newbie@local', password: 'another-pass-123' },
      });
      assert.equal(res.status, 409);
      assertEnvelopeError(res.json, 'EMAIL_TAKEN');
    });

    test('注册参数校验：密码太短 / 邮箱缺 @ → 400', async () => {
      const short = await api(handle.base, 'POST', '/api/v1/auth/signup', {
        body: { email: 'x@local', password: 'short' },
      });
      assert.equal(short.status, 400);
      assertEnvelopeError(short.json, 'INVALID_REQUEST');
      const badEmail = await api(handle.base, 'POST', '/api/v1/auth/signup', {
        body: { email: 'not-an-email', password: 'long-enough-pass' },
      });
      assert.equal(badEmail.status, 400);
      assertEnvelopeError(badEmail.json, 'INVALID_REQUEST');
    });

    test('admin 关闭 allowSignup → 再次注册 403；未登录 /auth/me 反映最新设置', async () => {
      await api(handle.base, 'PATCH', '/api/v1/admin/settings', {
        cookie: adminCookie,
        body: { allowSignup: false },
      });
      const res = await api(handle.base, 'POST', '/api/v1/auth/signup', {
        body: { email: 'late@local', password: 'late-pass-12345' },
      });
      assert.equal(res.status, 403);
      assertEnvelopeError(res.json, 'SIGNUP_DISABLED');
      assert.equal(await handle.store.findUserByEmail('late@local'), null);
      const me = await api(handle.base, 'GET', '/api/v1/auth/me');
      assert.equal(me.json.data.allowSignup, false);
    });
  });

  // ---- 同源写保护

  describe('同源写保护（CSRF 防御）', () => {
    test('跨站 Origin → 403 FORBIDDEN_ORIGIN', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/login', {
        body: { email: TENANT_EMAIL, password: TENANT_PASSWORD },
        origin: 'http://evil.example',
      });
      assert.equal(res.status, 403);
      assertEnvelopeError(res.json, 'FORBIDDEN_ORIGIN');
    });

    test('Sec-Fetch-Site: cross-site → 403（即便 Origin 缺失）', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/login', {
        body: { email: TENANT_EMAIL, password: TENANT_PASSWORD },
        origin: null,
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      assert.equal(res.status, 403);
      assertEnvelopeError(res.json, 'FORBIDDEN_ORIGIN');
    });

    test('Origin host 与请求 Host 不一致（端口不同）→ 403', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/login', {
        body: { email: TENANT_EMAIL, password: TENANT_PASSWORD },
        origin: 'http://127.0.0.1:9',
      });
      assert.equal(res.status, 403);
      assertEnvelopeError(res.json, 'FORBIDDEN_ORIGIN');
    });

    test('读请求不受同源写保护限制', async () => {
      const res = await api(handle.base, 'GET', '/api/v1/auth/me', {
        headers: { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
    });

    test('桌面端形态（无 Origin 无 Sec-Fetch-Site）放行', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/login', {
        body: { email: TENANT_EMAIL, password: TENANT_PASSWORD },
        origin: null,
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
    });
  });

  // ---- 租户隔离与管理员门禁

  describe('租户隔离与管理员门禁', () => {
    test('tenant 建网：16 位 hex id + 完整 joinUri（publicUrl 缺省取请求 Host）', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/networks', {
        cookie: tenantCookie,
        body: { name: 'tenant-net' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      const data = res.json.data;
      assert.match(data.id, /^[0-9a-f]{16}$/);
      assert.equal(data.name, 'tenant-net');
      assert.equal(data.admissionMode, 'both'); // 缺省 both
      assert.equal(data.maxPeers, 4); // 缺省 defaultMaxPeers
      assert.match(data.joinKey, /^[0-9a-f]{64}$/); // 高熵 joinKey
      const host = new URL(handle.base).host;
      assert.equal(data.joinUri, `zr-net://${host}/${data.id}#${data.joinKey}`);
      assert.equal(data.gatewayUrl, `http://${host}`);
      tenantNetId = data.id;
      tenantJoinKey = data.joinKey;
    });

    test('admin 建网成功（admin 不受配额限制）', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/networks', {
        cookie: adminCookie,
        body: { name: 'admin-net' },
      });
      assert.equal(res.status, 200);
      adminNetId = res.json.data.id;
    });

    test('GET /networks 只列自己的网络', async () => {
      const res = await api(handle.base, 'GET', '/api/v1/networks', { cookie: tenantCookie });
      assert.equal(res.status, 200);
      const list = res.json.data;
      assert.equal(list.length, 1);
      assert.equal(list[0].id, tenantNetId);
      assert.ok(!list.some((n) => n.id === adminNetId));
    });

    test('tenant 越权操作他人网络 → 404 防枚举', async () => {
      const patch = await api(handle.base, 'PATCH', `/api/v1/networks/${adminNetId}`, {
        cookie: tenantCookie,
        body: { name: 'hijacked' },
      });
      assert.equal(patch.status, 404);
      assertEnvelopeError(patch.json, 'NOT_FOUND');
      const rotate = await api(handle.base, 'POST', `/api/v1/networks/${adminNetId}/rotate-key`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(rotate.status, 404);
      const del = await api(handle.base, 'DELETE', `/api/v1/networks/${adminNetId}`, { cookie: tenantCookie });
      assert.equal(del.status, 404);
      const approve = await api(handle.base, 'POST', `/api/v1/networks/${adminNetId}/members/aaaaaaaa/approve`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(approve.status, 404);
    });

    test('admin 也只管理自己名下的网络（租户数据隔离）', async () => {
      const patch = await api(handle.base, 'PATCH', `/api/v1/networks/${tenantNetId}`, {
        cookie: adminCookie,
        body: { name: 'hijacked-by-admin' },
      });
      assert.equal(patch.status, 404);
      assertEnvelopeError(patch.json, 'NOT_FOUND');
    });

    test('tenant 访问 /admin/* 一律 403 FORBIDDEN', async () => {
      const get = await api(handle.base, 'GET', '/api/v1/admin/settings', { cookie: tenantCookie });
      assert.equal(get.status, 403);
      assertEnvelopeError(get.json, 'FORBIDDEN');
      const patchSettings = await api(handle.base, 'PATCH', '/api/v1/admin/settings', {
        cookie: tenantCookie,
        body: { allowSignup: true },
      });
      assert.equal(patchSettings.status, 403);
      const users = await api(handle.base, 'GET', '/api/v1/admin/users', { cookie: tenantCookie });
      assert.equal(users.status, 403);
      const patchUser = await api(handle.base, 'PATCH', `/api/v1/admin/users/${adminId}`, {
        cookie: tenantCookie,
        body: { active: false },
      });
      assert.equal(patchUser.status, 403);
    });

    test('未知路由与不匹配的方法 → 404 NOT_FOUND', async () => {
      const nope = await api(handle.base, 'GET', '/api/v1/nope', { cookie: tenantCookie });
      assert.equal(nope.status, 404);
      assertEnvelopeError(nope.json, 'NOT_FOUND');
      const wrongMethod = await api(handle.base, 'PATCH', '/api/v1/auth/me', {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(wrongMethod.status, 404);
    });
  });

  // ---- 网络 CRUD

  describe('网络 CRUD 与 rotate-key', () => {
    test('PATCH 部分更新：name/admissionMode/maxPeers 生效，joinKey 不变', async () => {
      const res = await api(handle.base, 'PATCH', `/api/v1/networks/${tenantNetId}`, {
        cookie: tenantCookie,
        body: { name: 'renamed', admissionMode: 'both', maxPeers: 2 },
      });
      assert.equal(res.status, 200);
      const data = res.json.data;
      assert.equal(data.name, 'renamed');
      assert.equal(data.admissionMode, 'both');
      assert.equal(data.maxPeers, 2);
      assert.equal(data.joinKey, tenantJoinKey); // patch 不动 join key
      const host = new URL(handle.base).host;
      assert.equal(data.joinUri, `zr-net://${host}/${tenantNetId}#${data.joinKey}`);
    });

    test('PATCH 参数校验：maxPeers 2..64、name 1..32、admissionMode 枚举 → 400', async () => {
      const cases = [
        { maxPeers: 65 },
        { maxPeers: 1 },
        { maxPeers: 2.5 },
        { maxPeers: '8' },
        { admissionMode: 'open' },
        { name: '' },
        { name: 'x'.repeat(33) },
      ];
      for (const body of cases) {
        const res = await api(handle.base, 'PATCH', `/api/v1/networks/${tenantNetId}`, {
          cookie: tenantCookie,
          body,
        });
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
        assertEnvelopeError(res.json, 'INVALID_REQUEST');
      }
    });

    test('rotate-key：新 joinKey、joinUri 同步更新、库中密文可解出新口令', async () => {
      const res = await api(handle.base, 'POST', `/api/v1/networks/${tenantNetId}/rotate-key`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(res.status, 200);
      const data = res.json.data;
      assert.notEqual(data.joinKey, tenantJoinKey);
      assert.match(data.joinKey, /^[0-9a-f]{64}$/);
      const host = new URL(handle.base).host;
      assert.equal(data.joinUri, `zr-net://${host}/${tenantNetId}#${data.joinKey}`);
      const stored = await handle.store.getNetwork(tenantNetId);
      assert.equal(decryptSecret(stored.joinKeyEnc, MASTER_KEY), data.joinKey);
      tenantJoinKey = data.joinKey;
    });

    test('DELETE 网络级联删除成员，删除后 404，onNetworkDeleted 钩子触发', async () => {
      const create = await api(handle.base, 'POST', '/api/v1/networks', {
        cookie: tenantCookie,
        body: { name: 'scratch' },
      });
      assert.equal(create.status, 200);
      const scratchId = create.json.data.id;
      await seedMember(handle.store, scratchId, '9a000001', 'authorized');

      const del = await api(handle.base, 'DELETE', `/api/v1/networks/${scratchId}`, { cookie: tenantCookie });
      assert.equal(del.status, 200);
      assert.equal(del.json.ok, true);
      assert.deepEqual(del.json.data, { id: scratchId, deleted: true });

      const list = await api(handle.base, 'GET', '/api/v1/networks', { cookie: tenantCookie });
      assert.deepEqual(list.json.data.map((n) => n.id), [tenantNetId]);
      assert.ok(handle.hooks.networkDeleted.includes(scratchId));
      // 级联：成员行也没了
      assert.deepEqual(await handle.store.listMembers(scratchId), []);

      const patch = await api(handle.base, 'PATCH', `/api/v1/networks/${scratchId}`, {
        cookie: tenantCookie,
        body: { name: 'zombie' },
      });
      assert.equal(patch.status, 404);
      const delAgain = await api(handle.base, 'DELETE', `/api/v1/networks/${scratchId}`, { cookie: tenantCookie });
      assert.equal(delAgain.status, 404);
    });
  });

  // ---- 成员五态

  describe('成员五态操作', () => {
    // tenantNetId：maxPeers 2、admissionMode both（上一组 PATCH 后的形态）
    test('approve：pending → authorized，onMemberChanged 事件', async () => {
      await seedMember(handle.store, tenantNetId, 'b1aaaaaa', 'pending');
      const res = await api(handle.base, 'POST', `/api/v1/networks/${tenantNetId}/members/b1aaaaaa/approve`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.data.member.nodeId, 'b1aaaaaa');
      assert.equal(res.json.data.member.status, 'authorized');
      assert.deepEqual(handle.hooks.memberChanged.at(-1), {
        networkId: tenantNetId,
        nodeId: 'b1aaaaaa',
        action: 'approve',
        status: 'authorized',
      });
    });

    test('pause → resume：authorized → paused → authorized', async () => {
      const paused = await api(handle.base, 'POST', `/api/v1/networks/${tenantNetId}/members/b1aaaaaa/pause`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(paused.status, 200);
      assert.equal(paused.json.data.member.status, 'paused');
      const resumed = await api(handle.base, 'POST', `/api/v1/networks/${tenantNetId}/members/b1aaaaaa/resume`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(resumed.status, 200);
      assert.equal(resumed.json.data.member.status, 'authorized');
    });

    test('repin：mismatch → authorized，候选公钥提升为正式钥匙', async () => {
      await seedMember(handle.store, tenantNetId, 'b4aaaaaa', 'mismatch'); // 第 2 个席位
      const res = await api(handle.base, 'POST', `/api/v1/networks/${tenantNetId}/members/b4aaaaaa/repin`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.data.member.status, 'authorized');
      assert.equal(res.json.data.member.publicKeyHex, 'b4aaaaaa-cand');
      assert.equal(res.json.data.member.candidatePublicKeyHex, null);
      assert.equal(handle.hooks.memberChanged.at(-1).action, 'repin');
    });

    test('approve 满额 → 409 LIMIT_REACHED，成员保持 pending', async () => {
      await seedMember(handle.store, tenantNetId, 'b3aaaaaa', 'pending'); // 2/2 已满
      const res = await api(handle.base, 'POST', `/api/v1/networks/${tenantNetId}/members/b3aaaaaa/approve`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(res.status, 409);
      assertEnvelopeError(res.json, 'LIMIT_REACHED');
      const still = (await handle.store.listMembers(tenantNetId)).find((m) => m.nodeId === 'b3aaaaaa');
      assert.equal(still.status, 'pending');
    });

    test('reject：pending → revoked（拒绝即吊销）', async () => {
      await seedMember(handle.store, tenantNetId, 'b5aaaaaa', 'pending');
      const res = await api(handle.base, 'POST', `/api/v1/networks/${tenantNetId}/members/b5aaaaaa/reject`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.data.member.status, 'revoked');
      assert.deepEqual(handle.hooks.memberChanged.at(-1), {
        networkId: tenantNetId,
        nodeId: 'b5aaaaaa',
        action: 'reject',
        status: 'revoked',
      });
    });

    test('DELETE 成员：彻底移除 + remove 事件', async () => {
      const res = await api(handle.base, 'DELETE', `/api/v1/networks/${tenantNetId}/members/b4aaaaaa`, {
        cookie: tenantCookie,
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.deepEqual(res.json.data, { networkId: tenantNetId, nodeId: 'b4aaaaaa', removed: true });
      const left = (await handle.store.listMembers(tenantNetId)).some((m) => m.nodeId === 'b4aaaaaa');
      assert.equal(left, false);
      assert.deepEqual(handle.hooks.memberChanged.at(-1), {
        networkId: tenantNetId,
        nodeId: 'b4aaaaaa',
        action: 'remove',
        status: 'revoked',
      });
    });

    test('成员不存在 → 404；非法迁移 → 409 INVALID_TRANSITION', async () => {
      const missing = await api(handle.base, 'POST', `/api/v1/networks/${tenantNetId}/members/00dead00/approve`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(missing.status, 404);
      assertEnvelopeError(missing.json, 'NOT_FOUND');
      const delMissing = await api(handle.base, 'DELETE', `/api/v1/networks/${tenantNetId}/members/00dead00`, {
        cookie: tenantCookie,
      });
      assert.equal(delMissing.status, 404);
      const illegal = await api(handle.base, 'POST', `/api/v1/networks/${tenantNetId}/members/b3aaaaaa/pause`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(illegal.status, 409);
      assertEnvelopeError(illegal.json, 'INVALID_TRANSITION');
    });
  });

  // ---- 管理员路由

  describe('管理员路由', () => {
    test('GET /admin/settings 返回四项系统设置', async () => {
      const res = await api(handle.base, 'GET', '/api/v1/admin/settings', { cookie: adminCookie });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.data, {
        allowSignup: false,
        maxNetworksPerUser: 2,
        defaultMaxPeers: 4,
        relayRateKbps: 2048,
      });
    });

    test('PATCH /admin/settings 部分热更新 + onSettingsChanged 钩子', async () => {
      const res = await api(handle.base, 'PATCH', '/api/v1/admin/settings', {
        cookie: adminCookie,
        body: { relayRateKbps: 4096 },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.data, {
        allowSignup: false,
        maxNetworksPerUser: 2,
        defaultMaxPeers: 4,
        relayRateKbps: 4096,
      });
      assert.deepEqual(await handle.store.getSettings(), res.json.data);
      assert.ok(handle.hooks.settingsChanged.length > 0);
      assert.deepEqual(handle.hooks.settingsChanged.at(-1), res.json.data);
    });

    test('PATCH /admin/settings 范围与类型校验 → 400', async () => {
      const cases = [
        { relayRateKbps: 0 },
        { relayRateKbps: 'high' },
        { maxNetworksPerUser: 0 },
        { maxNetworksPerUser: 51 },
        { defaultMaxPeers: 65 },
        { defaultMaxPeers: 1 },
        { allowSignup: 'yes' },
      ];
      for (const body of cases) {
        const res = await api(handle.base, 'PATCH', '/api/v1/admin/settings', {
          cookie: adminCookie,
          body,
        });
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
        assertEnvelopeError(res.json, 'INVALID_REQUEST');
      }
    });

    test('GET /admin/users：脱敏（无 passwordHash）+ 严格 19 键扩展视图（GC-6a）', async () => {
      const res = await api(handle.base, 'GET', '/api/v1/admin/users', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const list = res.json.data;
      const adminRow = list.find((u) => u.email === ADMIN_EMAIL);
      const tenantRow = list.find((u) => u.email === TENANT_EMAIL);
      const newbieRow = list.find((u) => u.email === 'newbie@local');
      assert.ok(adminRow && tenantRow && newbieRow);
      for (const row of [adminRow, tenantRow, newbieRow]) {
        assert.deepEqual(Object.keys(row).sort(), [
          'active',
          'createdAt',
          'effectiveGroupId',
          'effectiveGroupName',
          'email',
          'emailVerifiedAt',
          'groupCode',
          'groupExpiresAt',
          'groupId',
          'groupName',
          'id',
          'isExpiredFallback',
          'maxNetworks',
          'monthlyRelayBytes',
          'monthlyRelayQuotaBytes',
          'networkCount',
          'onlineDevices',
          'relayKbps',
          'role',
        ]);
        assert.ok(!JSON.stringify(row).includes('passwordHash'));
        assert.equal(row.onlineDevices, 0);
        assert.equal(row.relayKbps, 0);
        assert.equal(row.effectiveGroupId, 'grp_default');
        assert.equal(row.effectiveGroupName, '默认用户组');
        assert.equal(row.isExpiredFallback, false);
        assert.equal(row.monthlyRelayBytes, 0);
      }
      // admin 不受组配额约束：上限两项为 null；普通用户取默认组配额
      assert.equal(adminRow.role, 'admin');
      assert.equal(adminRow.maxNetworks, null);
      assert.equal(adminRow.monthlyRelayQuotaBytes, null);
      assert.equal(tenantRow.maxNetworks, 2);
      assert.equal(tenantRow.monthlyRelayQuotaBytes, null); // 默认组不限月度流量
      assert.equal(adminRow.networkCount, 1);
      assert.equal(tenantRow.networkCount, 1); // scratch 已删
      assert.equal(newbieRow.networkCount, 0);
      assert.equal(tenantRow.active, true);
    });

    test('admin 停用 tenant：会话即时失效、登录被拒、钩子触发', async () => {
      const res = await api(handle.base, 'PATCH', `/api/v1/admin/users/${tenantId}`, {
        cookie: adminCookie,
        body: { active: false },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.data.active, false);
      assert.ok(handle.hooks.userDisabled.includes(tenantId));

      // 旧 Cookie 立即失效
      const stale = await api(handle.base, 'GET', '/api/v1/networks', { cookie: tenantCookie });
      assert.equal(stale.status, 401);
      assertEnvelopeError(stale.json, 'UNAUTHENTICATED');
      // 已停用账号登录 → 403 ACCOUNT_DISABLED
      const relogin = await api(handle.base, 'POST', '/api/v1/auth/login', {
        body: { email: TENANT_EMAIL, password: TENANT_PASSWORD },
      });
      assert.equal(relogin.status, 403);
      assertEnvelopeError(relogin.json, 'ACCOUNT_DISABLED');
      const listed = (await handle.store.listUsers()).find((u) => u.id === tenantId);
      assert.equal(listed.active, false);
    });

    test('admin 不能停用自己 → 400 CANNOT_DISABLE_SELF', async () => {
      const res = await api(handle.base, 'PATCH', `/api/v1/admin/users/${adminId}`, {
        cookie: adminCookie,
        body: { active: false },
      });
      assert.equal(res.status, 400);
      assertEnvelopeError(res.json, 'CANNOT_DISABLE_SELF');
    });

    test('恢复 tenant：重新登录可用新 Cookie；参数校验 400 / 未知用户 404', async () => {
      const bad = await api(handle.base, 'PATCH', `/api/v1/admin/users/${tenantId}`, {
        cookie: adminCookie,
        body: { active: 'yes' },
      });
      assert.equal(bad.status, 400);
      const empty = await api(handle.base, 'PATCH', `/api/v1/admin/users/${tenantId}`, {
        cookie: adminCookie,
        body: {},
      });
      assert.equal(empty.status, 400);
      const unknown = await api(handle.base, 'PATCH', '/api/v1/admin/users/ffffffffffffffff', {
        cookie: adminCookie,
        body: { active: false },
      });
      assert.equal(unknown.status, 404);

      const enable = await api(handle.base, 'PATCH', `/api/v1/admin/users/${tenantId}`, {
        cookie: adminCookie,
        body: { active: true },
      });
      assert.equal(enable.status, 200);
      assert.equal(enable.json.data.active, true);

      // 旧 Cookie 不复活（禁用时已删会话），重新登录拿新 Cookie
      const stale = await api(handle.base, 'GET', '/api/v1/networks', { cookie: tenantCookie });
      assert.equal(stale.status, 401);
      tenantCookie = await login(handle.base, TENANT_EMAIL, TENANT_PASSWORD);
      const fresh = await api(handle.base, 'GET', '/api/v1/networks', { cookie: tenantCookie });
      assert.equal(fresh.status, 200);
    });
  });
});

// ---------------------------------------------------------------- 建网配额（独立实例：maxNetworksPerUser=1）

describe('建网配额上限（独立实例）', () => {
  const handle = {};
  let adminCookie;
  let tenantCookie;

  before(async () => {
    Object.assign(handle, await startServer({ seed: seedSettings({ maxNetworksPerUser: 1 }) }));
    const { adminId, tenantId } = await seedUsers(handle.store);
    adminCookie = await login(handle.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    tenantCookie = await login(handle.base, TENANT_EMAIL, TENANT_PASSWORD);
    assert.ok(adminId && tenantId);
  });

  after(async () => stopServer(handle));

  test('普通租户建满 1 个后再建 → 409 QUOTA_EXCEEDED', async () => {
    const first = await api(handle.base, 'POST', '/api/v1/networks', {
      cookie: tenantCookie,
      body: { name: 'q1' },
    });
    assert.equal(first.status, 200);
    const second = await api(handle.base, 'POST', '/api/v1/networks', {
      cookie: tenantCookie,
      body: { name: 'q2' },
    });
    assert.equal(second.status, 409);
    assertEnvelopeError(second.json, 'QUOTA_EXCEEDED');
  });

  test('admin 建网不受 maxNetworksPerUser 限制', async () => {
    for (const name of ['a1', 'a2', 'a3']) {
      const res = await api(handle.base, 'POST', '/api/v1/networks', {
        cookie: adminCookie,
        body: { name },
      });
      assert.equal(res.status, 200);
    }
  });
});

// ---------------------------------------------------------------- publicUrl 主机与运行时统计注入（独立实例）

describe('publicUrl 主机与运行时统计注入（独立实例）', () => {
  let tenantIdRef = null;
  const runtime = {
    getOnlineCountByNetwork: () => 2, // 每个网络 2 台在线
    getOnlineCountByUser: (userId) => (userId === tenantIdRef ? 2 : 0),
    getRelayKbpsByUser: (userId) => (userId === tenantIdRef ? 128 : 0),
  };
  const handle = {};
  let tenantCookie;
  let adminCookie;
  let netId;

  before(async () => {
    Object.assign(handle, await startServer({ publicUrl: 'https://gw.example.com:8443', runtime }));
    const { adminId, tenantId } = await seedUsers(handle.store);
    tenantIdRef = tenantId;
    tenantCookie = await login(handle.base, TENANT_EMAIL, TENANT_PASSWORD);
    adminCookie = await login(handle.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    assert.ok(adminId);
  });

  after(async () => stopServer(handle));

  test('joinUri 的 publicHost 优先取 publicUrl 的 host:port（而非请求 Host）', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/networks', {
      cookie: tenantCookie,
      body: { name: 'via-public-url' },
    });
    assert.equal(res.status, 200);
    netId = res.json.data.id;
    assert.equal(res.json.data.joinUri, `zr-net://gw.example.com:8443/${netId}#${res.json.data.joinKey}`);
    assert.equal(res.json.data.gatewayUrl, 'https://gw.example.com:8443');
  });

  test('GET /networks 附带在线/总设备数与待审批数（runtime 注入 + store 统计）', async () => {
    await seedMember(handle.store, netId, 'aa000001', 'authorized');
    await seedMember(handle.store, netId, 'aa000002', 'pending');
    await seedMember(handle.store, netId, 'aa000003', 'revoked');
    const res = await api(handle.base, 'GET', '/api/v1/networks', { cookie: tenantCookie });
    assert.equal(res.status, 200);
    const item = res.json.data.find((n) => n.id === netId);
    assert.equal(item.gatewayUrl, 'https://gw.example.com:8443');
    assert.equal(item.onlineDevices, 2); // runtime 注入
    assert.equal(item.totalDevices, 1); // 占席位成员（authorized+paused+mismatch），pending/revoked 不计
    assert.equal(item.pendingCount, 1);
  });

  test('GET /admin/users 使用注入的 runtime 统计（在线数 / 实时中转速率）', async () => {
    const res = await api(handle.base, 'GET', '/api/v1/admin/users', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const tenantRow = res.json.data.find((u) => u.email === TENANT_EMAIL);
    const adminRow = res.json.data.find((u) => u.email === ADMIN_EMAIL);
    assert.equal(tenantRow.onlineDevices, 2);
    assert.equal(tenantRow.relayKbps, 128);
    assert.equal(adminRow.onlineDevices, 0);
    assert.equal(adminRow.relayKbps, 0);
  });

  test('GET /peer/v1/networks：免登录仅返回可人工审批（both/manual）活跃租户网络，零敏感字段', async () => {
    await api(handle.base, 'POST', '/api/v1/networks', {
      cookie: tenantCookie,
      body: { name: 'key-only-net', admissionMode: 'key' },
    });
    const manualRes = await api(handle.base, 'POST', '/api/v1/networks', {
      cookie: adminCookie,
      body: { name: 'manual-net', admissionMode: 'manual' },
    });
    assert.equal(manualRes.status, 200);

    const pub = await api(handle.base, 'GET', '/peer/v1/networks');
    assert.equal(pub.status, 200);
    assert.equal(pub.json.ok, true);
    assert.equal(pub.json.data.totalNetworks, 3);
    assert.deepEqual(
      pub.json.data.networks.map((n) => n.name),
      ['via-public-url', 'manual-net'],
    );
    for (const row of pub.json.data.networks) {
      assert.deepEqual(Object.keys(row).sort(), ['id', 'name']);
    }
  });
});

describe('publicUrl 协议与缺省端口映射（HTTP 公网直连与无端口反代）', () => {
  test('公网 IP 跑明文 http:// 时 joinUri 附 ?tls=0 纠偏，避免节点端误连 wss://', async () => {
    const h = await startServer({ publicUrl: 'http://203.0.113.10:19393' });
    try {
      await seedUsers(h.store);
      const cookie = await login(h.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const res = await api(h.base, 'POST', '/api/v1/networks', { cookie, body: { name: 'http-public' } });
      assert.equal(res.status, 200);
      assert.equal(
        res.json.data.joinUri,
        `zr-net://203.0.113.10:19393/${res.json.data.id}?tls=0#${res.json.data.joinKey}`,
      );
      assert.equal(res.json.data.gatewayUrl, 'http://203.0.113.10:19393');
    } finally {
      await stopServer(h);
    }
  });

  test('https:// 反代未显式带端口时自动补 :443，防止节点端回落默认 19393', async () => {
    const h = await startServer({ publicUrl: 'https://zr.example.com' });
    try {
      await seedUsers(h.store);
      const cookie = await login(h.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const res = await api(h.base, 'POST', '/api/v1/networks', { cookie, body: { name: 'https-proxy' } });
      assert.equal(res.status, 200);
      assert.equal(
        res.json.data.joinUri,
        `zr-net://zr.example.com:443/${res.json.data.id}#${res.json.data.joinKey}`,
      );
      assert.equal(res.json.data.gatewayUrl, 'https://zr.example.com');
    } finally {
      await stopServer(h);
    }
  });

  test('https:// 指向私网 IP 时自动补 :443 并附 ?tls=1 纠偏（私网默认推断是明文）', async () => {
    const h = await startServer({ publicUrl: 'https://192.168.1.10' });
    try {
      await seedUsers(h.store);
      const cookie = await login(h.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const res = await api(h.base, 'POST', '/api/v1/networks', { cookie, body: { name: 'https-private' } });
      assert.equal(res.status, 200);
      assert.equal(
        res.json.data.joinUri,
        `zr-net://192.168.1.10:443/${res.json.data.id}?tls=1#${res.json.data.joinKey}`,
      );
      assert.equal(res.json.data.gatewayUrl, 'https://192.168.1.10');
    } finally {
      await stopServer(h);
    }
  });

  test('http:// 指向私网 IP 时自动补 :80 且不带 query（与私网默认明文一致）', async () => {
    const h = await startServer({ publicUrl: 'http://192.168.1.10' });
    try {
      await seedUsers(h.store);
      const cookie = await login(h.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const res = await api(h.base, 'POST', '/api/v1/networks', { cookie, body: { name: 'http-private' } });
      assert.equal(res.status, 200);
      assert.equal(
        res.json.data.joinUri,
        `zr-net://192.168.1.10:80/${res.json.data.id}#${res.json.data.joinKey}`,
      );
      assert.equal(res.json.data.gatewayUrl, 'http://192.168.1.10');
    } finally {
      await stopServer(h);
    }
  });

  test('https:// 指向 .local 域名时附 ?tls=1（.local/.lan 与客户端同样视为内网默认明文）', async () => {
    const h = await startServer({ publicUrl: 'https://nas.local:8443' });
    try {
      await seedUsers(h.store);
      const cookie = await login(h.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const res = await api(h.base, 'POST', '/api/v1/networks', { cookie, body: { name: 'https-mdns' } });
      assert.equal(res.status, 200);
      assert.equal(
        res.json.data.joinUri,
        `zr-net://nas.local:8443/${res.json.data.id}?tls=1#${res.json.data.joinKey}`,
      );
      assert.equal(res.json.data.gatewayUrl, 'https://nas.local:8443');
    } finally {
      await stopServer(h);
    }
  });

  test('缺省 publicUrl 但带 X-Forwarded-Proto: https 时 gatewayUrl 返回 https://origin', async () => {
    const h = await startServer();
    try {
      await seedUsers(h.store);
      const cookie = await login(h.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const res = await api(h.base, 'POST', '/api/v1/networks', {
        cookie,
        headers: { 'x-forwarded-proto': 'https' },
        body: { name: 'xfp-https' },
      });
      assert.equal(res.status, 200);
      const host = new URL(h.base).host;
      assert.equal(res.json.data.gatewayUrl, `https://${host}`);
      assert.equal(
        res.json.data.joinUri,
        `zr-net://${host}/${res.json.data.id}?tls=1#${res.json.data.joinKey}`,
      );
    } finally {
      await stopServer(h);
    }
  });

  test('maskInviteUri 对 ?tls=0|1 的新格式保留 query、只打码 # 后的 joinKey', () => {
    assert.equal(
      maskInviteUri('zr-net://203.0.113.10:19393/0123456789abcdef?tls=0#secret'),
      'zr-net://203.0.113.10:19393/0123456789abcdef?tls=0#••••••••',
    );
    assert.equal(
      maskInviteUri('zr-net://nas.local:8443/0123456789abcdef?tls=1#secret'),
      'zr-net://nas.local:8443/0123456789abcdef?tls=1#••••••••',
    );
  });
});

describe('PATCH /api/v1/networks/:id/members/:nodeId（成员重命名与备注）', () => {
  test('owner 可修改设备名称与备注；空名/超长返回 400；跨租户或未知节点返回 404', async () => {
    const h = await startServer();
    try {
      await seedUsers(h.store);
      const adminCookie = await login(h.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const tenantCookie = await login(h.base, TENANT_EMAIL, TENANT_PASSWORD);
      const netRes = await api(h.base, 'POST', '/api/v1/networks', {
        cookie: tenantCookie,
        body: { name: 'rename-net' },
      });
      const netId = netRes.json.data.id;
      await seedMember(h.store, netId, 'bb001122', 'authorized');

      const okRes = await api(h.base, 'PATCH', `/api/v1/networks/${netId}/members/bb001122`, {
        cookie: tenantCookie,
        body: { name: '客厅 Mac Studio', note: '主力机' },
      });
      assert.equal(okRes.status, 200);
      assert.equal(okRes.json.ok, true);
      assert.equal(okRes.json.data.member.name, '客厅 Mac Studio');
      assert.equal(okRes.json.data.member.note, '主力机');
      assert.equal(h.hooks.memberChanged.length, 1);
      assert.equal(h.hooks.memberChanged[0].action, 'rename');
      assert.equal(h.hooks.memberChanged[0].name, '客厅 Mac Studio');

      const emptyName = await api(h.base, 'PATCH', `/api/v1/networks/${netId}/members/bb001122`, {
        cookie: tenantCookie,
        body: { name: '   ' },
      });
      assert.equal(emptyName.status, 400);

      const longName = await api(h.base, 'PATCH', `/api/v1/networks/${netId}/members/bb001122`, {
        cookie: tenantCookie,
        body: { name: 'x'.repeat(65) },
      });
      assert.equal(longName.status, 400);

      const unknownNode = await api(h.base, 'PATCH', `/api/v1/networks/${netId}/members/deadbeef`, {
        cookie: tenantCookie,
        body: { name: 'ghost' },
      });
      assert.equal(unknownNode.status, 404);

      const foreignOwner = await api(h.base, 'PATCH', `/api/v1/networks/${netId}/members/bb001122`, {
        cookie: adminCookie,
        body: { name: 'hijack' },
      });
      assert.equal(foreignOwner.status, 404);
    } finally {
      await stopServer(h);
    }
  });
});

// ---------------------------------------------------------------- GC-6a：运行态 / SMTP 测试 / API Key / 用户组 / 用户管理 / publicUrl 热更新

/**
 * 最小 mock SMTP 服务器（security 'none' + AUTH PLAIN 校验凭证）：记录收到的命令行
 * 与 DATA payload，供 smtp-test 端到端用例断言真实投递。写法与 smtp-client.test.mjs
 * 的 mock 同源（同一协议状态机的简化版）。
 */
function startMockSmtp({ username, password }) {
  const state = { commands: [], dataPayload: null };
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    let inData = false;
    sock.write('220 mock.gateway.local ESMTP mock ready\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end >= 0) {
          state.dataPayload = buf.slice(0, end + 2);
          buf = buf.slice(end + 5);
          inData = false;
          sock.write('250 OK message accepted\r\n');
          drain();
        }
        return;
      }
      drain();
    });

    function drain() {
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (line.length > 0) state.commands.push(line);
        handleLine(line);
      }
    }

    function handleLine(line) {
      const up = line.toUpperCase();
      if (up.startsWith('EHLO')) {
        sock.write('250-mock.gateway.local greets you\r\n250 AUTH PLAIN\r\n250 SIZE 52428800\r\n');
      } else if (up.startsWith('AUTH PLAIN')) {
        // base64(\0username\0password)；凭证不符回 535（客户端会把它转成 SMTP_AUTH_FAILED）
        const arg = line.slice('AUTH PLAIN'.length).trim();
        const parts = Buffer.from(arg, 'base64').toString('utf8').split('\0');
        const ok = parts.length === 3 && parts[1] === username && parts[2] === password;
        sock.write(ok ? '235 2.7.0 authentication succeeded\r\n' : '535 5.7.8 bad credentials\r\n');
      } else if (up.startsWith('MAIL FROM')) {
        sock.write('250 2.1.0 sender OK\r\n');
      } else if (up.startsWith('RCPT TO')) {
        sock.write('250 2.1.5 recipient OK\r\n');
      } else if (up === 'DATA') {
        inData = true;
        sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (up === 'QUIT') {
        sock.write('221 2.0.0 Bye\r\n');
        sock.end();
      } else {
        sock.write('500 5.5.2 unrecognized command\r\n');
      }
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, port: server.address().port, sockets });
    });
  });
}

describe('GC-6a GET /admin/runtime：运行态聚合与安全告警', () => {
  const handle = {};
  let adminCookie;
  let tenantCookie;
  let tenantIdRef = null;
  const runtime = {
    getOnlineCountByNetwork: () => 0,
    getOnlineCountByUser: (userId) => (userId === tenantIdRef ? 3 : 0),
    getRelayKbpsByUser: (userId) => (userId === tenantIdRef ? 250 : 0),
  };
  const runtimeMeta = {
    listenPort: 19393,
    udpPort: 19393,
    udpAltPort: 0, // 辅助探测口关闭 → UDP_ALT_DISABLED
    storageDriver: 'sqlite',
    secretSource: 'env',
    publicUrlFromEnv: 'https://gw-env.example.com',
  };

  before(async () => {
    Object.assign(handle, await startServer({ runtime, runtimeMeta }));
    const { adminId, tenantId } = await seedUsers(handle.store);
    assert.ok(adminId);
    tenantIdRef = tenantId;
    adminCookie = await login(handle.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    tenantCookie = await login(handle.base, TENANT_EMAIL, TENANT_PASSWORD);
  });

  after(async () => stopServer(handle));

  test('聚合在线设备/速率/累计字节；env 回退入口 + UDP_ALT_DISABLED 告警 + 脱敏红线', async () => {
    const net = await api(handle.base, 'POST', '/api/v1/networks', {
      cookie: tenantCookie,
      body: { name: 'runtime-net' },
    });
    assert.equal(net.status, 200);
    await seedMember(handle.store, net.json.data.id, 'cc000001', 'authorized');
    await handle.store.flushMemberTelemetry([{ networkId: net.json.data.id, nodeId: 'cc000001', relayBytesDelta: 123456 }]);

    const res = await api(handle.base, 'GET', '/api/v1/admin/runtime', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = res.json.data;
    assert.deepEqual(Object.keys(data).sort(), [
      'cumulativeRelayBytes',
      'listenPort',
      'onlineDevices',
      'publicUrlEffective',
      'publicUrlSource',
      'secretSource',
      'securityWarnings',
      'smtpConfigured',
      'storageDriver',
      'totalLiveRelayKbps',
      'udpAltPort',
      'udpPort',
    ]);
    assert.equal(data.listenPort, 19393);
    assert.equal(data.udpPort, 19393);
    assert.equal(data.udpAltPort, 0);
    assert.equal(data.storageDriver, 'sqlite');
    assert.equal(data.secretSource, 'env');
    assert.equal(data.publicUrlSource, 'env');
    assert.equal(data.publicUrlEffective, 'https://gw-env.example.com');
    assert.equal(data.smtpConfigured, false);
    assert.equal(data.onlineDevices, 3);
    assert.equal(data.totalLiveRelayKbps, 250);
    assert.equal(data.cumulativeRelayBytes, 123456);
    assert.deepEqual(data.securityWarnings, ['UDP_ALT_DISABLED']);

    // 脱敏：无数据库连接串、无主密钥痕迹、无本机绝对路径、没有「允许不安全连接」开关
    const raw = JSON.stringify(res.json);
    assert.ok(!raw.includes('postgres://'));
    assert.ok(!raw.includes('gateway.sqlite'));
    assert.ok(!raw.includes('/Volumes/'));
    assert.ok(!raw.includes('masterKey'));
    assert.ok(!raw.includes('allowInsecure'));
    assert.ok(!raw.includes('allow_insecure'));
    assert.ok(!raw.includes('allowUnsafe'));
    assert.ok(!raw.includes('allow_unsafe'));
  });

  test('热更新 settings.publicUrl 后 /admin/runtime 与 joinUri 立即反映（含 PUBLIC_HTTP_PLAINTEXT）', async () => {
    const updated = await handle.store.updateExtendedSettings({ publicUrl: 'http://203.0.113.10:19393' });
    assert.equal(updated.publicUrl, 'http://203.0.113.10:19393');

    const res = await api(handle.base, 'GET', '/api/v1/admin/runtime', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.publicUrlEffective, 'http://203.0.113.10:19393');
    assert.equal(res.json.data.publicUrlSource, 'settings');
    assert.ok(res.json.data.securityWarnings.includes('PUBLIC_HTTP_PLAINTEXT')); // 公网明文入口
    assert.ok(res.json.data.securityWarnings.includes('UDP_ALT_DISABLED'));

    // 同一次热更新即刻作用于 joinUri（无需重启）
    const net = await api(handle.base, 'POST', '/api/v1/networks', {
      cookie: tenantCookie,
      body: { name: 'hot-net' },
    });
    assert.equal(net.status, 200);
    assert.ok(net.json.data.joinUri.startsWith('zr-net://203.0.113.10:19393/'));
    assert.ok(net.json.data.joinUri.includes('?tls=0#'));

    // 清空 settings 恢复 env 回退，告警随之消失
    await handle.store.updateExtendedSettings({ publicUrl: null });
    const restored = await api(handle.base, 'GET', '/api/v1/admin/runtime', { cookie: adminCookie });
    assert.equal(restored.json.data.publicUrlSource, 'env');
    assert.equal(restored.json.data.publicUrlEffective, 'https://gw-env.example.com');
    assert.ok(!restored.json.data.securityWarnings.includes('PUBLIC_HTTP_PLAINTEXT'));
  });
});

describe('GC-6a POST /admin/settings/smtp-test：真实发信 / 未配置 / 失败脱敏', () => {
  const SMTP_PASSWORD = 'smtp-super-secret-9';
  const SMTP_DRAFT_BASE = { security: 'none', username: 'mailer', fromAddress: 'gateway@test.local' };
  const handle = {};
  let mock;
  let adminCookie;

  before(async () => {
    mock = await startMockSmtp({ username: 'mailer', password: SMTP_PASSWORD });
    Object.assign(handle, await startServer());
    await seedUsers(handle.store);
    adminCookie = await login(handle.base, ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  after(async () => {
    await new Promise((resolve) => {
      mock.server.closeIdleConnections?.();
      mock.server.close(resolve);
      mock.server.closeAllConnections?.();
    });
    await stopServer(handle);
  });

  test('未配置 SMTP（无保存配置且无草稿）→ 400 SMTP_NOT_CONFIGURED', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/admin/settings/smtp-test', {
      cookie: adminCookie,
      body: { toEmail: 'boss@example.com' },
    });
    assert.equal(res.status, 400);
    assertEnvelopeError(res.json, 'SMTP_NOT_CONFIGURED');
  });

  test('草稿缺 password → 从库中已保存配置回填并真实投递成功（200 { sent: true }）', async () => {
    await handle.store.updateExtendedSettings({
      smtpConfigEnc: encodeSmtpConfig(
        { host: '127.0.0.1', port: mock.port, ...SMTP_DRAFT_BASE, password: SMTP_PASSWORD },
        MASTER_KEY,
      ),
    });
    const res = await api(handle.base, 'POST', '/api/v1/admin/settings/smtp-test', {
      cookie: adminCookie,
      body: {
        toEmail: 'boss@example.com',
        smtp: { host: '127.0.0.1', port: mock.port, ...SMTP_DRAFT_BASE }, // 无 password 字段
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { sent: true });
    // AUTH 成功 = mock 校验了回填的密码（535 会让整个请求 502）
    assert.ok(
      mock.state.commands.some((c) => c.startsWith('AUTH PLAIN')),
      'expected AUTH PLAIN after password backfill',
    );
    assert.ok(
      mock.state.commands.some((c) => c.startsWith('RCPT TO:<boss@example.com>')),
      `expected RCPT TO in ${JSON.stringify(mock.state.commands)}`,
    );
    assert.ok(mock.state.dataPayload.includes('这是一封测试邮件。'));
    assert.ok(mock.state.commands.some((c) => c === 'QUIT'));
    // 响应绝不回显密码
    assert.ok(!JSON.stringify(res.json).includes(SMTP_PASSWORD));
  });

  test('连接失败 → 502 SMTP_SEND_FAILED，错误响应不含密码', async () => {
    // 起一个临时端口随即关闭 → 连接必被拒绝（ECONNREFUSED）
    const dead = net.createServer(() => {});
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const deadPort = dead.address().port;
    await new Promise((resolve) => dead.close(resolve));

    const res = await api(handle.base, 'POST', '/api/v1/admin/settings/smtp-test', {
      cookie: adminCookie,
      body: {
        toEmail: 'boss@example.com',
        smtp: { host: '127.0.0.1', port: deadPort, ...SMTP_DRAFT_BASE, password: SMTP_PASSWORD },
      },
    });
    assert.equal(res.status, 502);
    assertEnvelopeError(res.json, 'SMTP_SEND_FAILED');
    assert.ok(!JSON.stringify(res.json).includes(SMTP_PASSWORD));
  });

  test('非法 toEmail → 400 INVALID_REQUEST；`to` 别名与 `toEmail` 等价', async () => {
    const bad = await api(handle.base, 'POST', '/api/v1/admin/settings/smtp-test', {
      cookie: adminCookie,
      body: { toEmail: 'not-an-email', smtp: { host: '127.0.0.1', port: mock.port, ...SMTP_DRAFT_BASE } },
    });
    assert.equal(bad.status, 400);
    assertEnvelopeError(bad.json, 'INVALID_REQUEST');

    // `to` 别名走通（复用已回填的保存配置，无草稿）
    const ok = await api(handle.base, 'POST', '/api/v1/admin/settings/smtp-test', {
      cookie: adminCookie,
      body: { to: 'alias@example.com' },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.data, { sent: true });
  });
});

describe('GC-6a Admin API Key 与 Bearer 双轨鉴权', () => {
  const handle = {};
  let adminCookie;
  let tenantCookie;
  let adminId;
  let tenantId;
  let apiKey;

  before(async () => {
    Object.assign(handle, await startServer());
    ({ adminId, tenantId } = await seedUsers(handle.store));
    adminCookie = await login(handle.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    tenantCookie = await login(handle.base, TENANT_EMAIL, TENANT_PASSWORD);
  });

  after(async () => stopServer(handle));

  test('POST /admin/settings/api-key：明文仅本次返回（zr_adm_ + 48 hex），库中只存哈希与前缀', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/admin/settings/api-key', { cookie: adminCookie });
    assert.equal(res.status, 200);
    apiKey = res.json.data.apiKey;
    assert.match(apiKey, /^zr_adm_[0-9a-f]{48}$/);
    assert.equal(res.json.data.prefix, apiKey.slice(0, 14));
    assert.ok(res.json.data.createdAt.length > 0);
    const ext = await handle.store.getExtendedSettings();
    assert.equal(ext.adminApiKeyHash, hashToken(apiKey));
    assert.equal(ext.adminApiKeyPrefix, apiKey.slice(0, 14));
    assert.equal(ext.adminApiKeyCreatedAt, res.json.data.createdAt);
  });

  test('跨站写 + 无 Cookie 的 Bearer 调 PATCH /admin/users/:id：CSRF 豁免，改组设到期日成功', async () => {
    const group = await api(handle.base, 'POST', '/api/v1/admin/groups', {
      headers: { authorization: `Bearer ${apiKey}` },
      origin: 'http://evil.example',
      body: { code: 'pro', name: 'Pro 组', maxNetworks: 5, maxPeersPerNetwork: 16, relayRateKbps: 8192 },
    });
    assert.equal(group.status, 200, `create group failed: ${JSON.stringify(group.json)}`);
    const groupId = group.json.data.id;

    const res = await api(handle.base, 'PATCH', `/api/v1/admin/users/${tenantId}`, {
      headers: { authorization: `Bearer ${apiKey}`, 'sec-fetch-site': 'cross-site' },
      origin: 'http://evil.example',
      body: { groupId, groupExpiresAt: '2027-01-01T00:00:00.000Z' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.groupId, groupId);
    assert.equal(res.json.data.effectiveGroupId, groupId);
    assert.equal(res.json.data.groupExpiresAt, '2027-01-01T00:00:00.000Z');
    assert.equal(res.json.data.maxNetworks, 5); // pro 组配额生效
    assert.ok(handle.hooks.quotaChanged.includes(tenantId));
  });

  test('Bearer 优先于 Cookie：有效 Bearer + 普通用户 Cookie → 放行（绝不回退 Cookie 判定角色）', async () => {
    const res = await api(handle.base, 'GET', '/api/v1/admin/users', {
      headers: { authorization: `Bearer ${apiKey}` },
      cookie: tenantCookie,
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.data));
  });

  test('无效 Bearer → 401 INVALID_API_KEY；普通用户 Cookie 访问 /admin/* → 403 FORBIDDEN', async () => {
    const bad = await api(handle.base, 'GET', '/api/v1/admin/users', {
      headers: { authorization: `Bearer zr_adm_${'0'.repeat(48)}` },
      cookie: adminCookie,
    });
    assert.equal(bad.status, 401);
    assertEnvelopeError(bad.json, 'INVALID_API_KEY');

    const forbidden = await api(handle.base, 'GET', '/api/v1/admin/users', { cookie: tenantCookie });
    assert.equal(forbidden.status, 403);
    assertEnvelopeError(forbidden.json, 'FORBIDDEN');

    const anonymous = await api(handle.base, 'GET', '/api/v1/admin/runtime');
    assert.equal(anonymous.status, 401);
    assertEnvelopeError(anonymous.json, 'UNAUTHENTICATED');
  });

  test('Bearer 身份豁免自我保护：PATCH/DELETE 唯一活跃管理员 → 400 CANNOT_REMOVE_LAST_ADMIN', async () => {
    const demote = await api(handle.base, 'PATCH', `/api/v1/admin/users/${adminId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { role: 'user' },
    });
    assert.equal(demote.status, 400);
    assertEnvelopeError(demote.json, 'CANNOT_REMOVE_LAST_ADMIN');

    const del = await api(handle.base, 'DELETE', `/api/v1/admin/users/${adminId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(del.status, 400);
    assertEnvelopeError(del.json, 'CANNOT_REMOVE_LAST_ADMIN');
    // 管理员账号仍在
    assert.ok(await handle.store.findUserById(adminId));
  });

  test('DELETE /admin/settings/api-key 吊销后，同一 Bearer 立即 401', async () => {
    const rev = await api(handle.base, 'DELETE', '/api/v1/admin/settings/api-key', { cookie: adminCookie });
    assert.equal(rev.status, 200);
    assert.deepEqual(rev.json.data, { revoked: true });
    const ext = await handle.store.getExtendedSettings();
    assert.equal(ext.adminApiKeyHash, null);
    assert.equal(ext.adminApiKeyPrefix, null);
    assert.equal(ext.adminApiKeyCreatedAt, null);

    const after = await api(handle.base, 'GET', '/api/v1/admin/users', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(after.status, 401);
    assertEnvelopeError(after.json, 'INVALID_API_KEY');
    apiKey = null;
  });
});

describe('GC-6a 用户组管理 /admin/groups CRUD', () => {
  const handle = {};
  let adminCookie;
  let tenantCookie;
  let adminId;
  let tenantId;
  let groupId;
  let spareGroupId;

  before(async () => {
    Object.assign(handle, await startServer());
    ({ adminId, tenantId } = await seedUsers(handle.store));
    adminCookie = await login(handle.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    tenantCookie = await login(handle.base, TENANT_EMAIL, TENANT_PASSWORD);
  });

  after(async () => stopServer(handle));

  test('GET 初始列表：默认组 grp_default 携带 userCount', async () => {
    const res = await api(handle.base, 'GET', '/api/v1/admin/groups', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.length, 1);
    const def = res.json.data[0];
    assert.equal(def.id, 'grp_default');
    assert.equal(def.code, 'default');
    assert.equal(def.isDefault, true);
    assert.equal(def.userCount, 2); // admin + tenant
    groupId = def.id;
  });

  test('POST 校验：缺字段 / 非法 code → 400 INVALID_REQUEST；重复 code → 409 DUPLICATE_GROUP_CODE', async () => {
    const missing = await api(handle.base, 'POST', '/api/v1/admin/groups', {
      cookie: adminCookie,
      body: { code: 'x1', name: 'X' },
    });
    assert.equal(missing.status, 400);
    assertEnvelopeError(missing.json, 'INVALID_REQUEST');

    const badCode = await api(handle.base, 'POST', '/api/v1/admin/groups', {
      cookie: adminCookie,
      body: { code: 'Bad Code!', name: 'X', maxNetworks: 1, maxPeersPerNetwork: 2, relayRateKbps: 64 },
    });
    assert.equal(badCode.status, 400);
    assertEnvelopeError(badCode.json, 'INVALID_REQUEST');

    const dup = await api(handle.base, 'POST', '/api/v1/admin/groups', {
      cookie: adminCookie,
      body: { code: 'default', name: '冒牌默认组', maxNetworks: 1, maxPeersPerNetwork: 2, relayRateKbps: 64 },
    });
    assert.equal(dup.status, 409);
    assertEnvelopeError(dup.json, 'DUPLICATE_GROUP_CODE');

    const outOfRange = await api(handle.base, 'POST', '/api/v1/admin/groups', {
      cookie: adminCookie,
      body: { code: 'huge', name: 'Huge', maxNetworks: 101, maxPeersPerNetwork: 2, relayRateKbps: 64 },
    });
    assert.equal(outOfRange.status, 400);
    assertEnvelopeError(outOfRange.json, 'INVALID_REQUEST');
  });

  test('POST isDefault: true 切换默认组 → 列表互斥 + settings/quota 全局钩子', async () => {
    const settingsChangedBefore = handle.hooks.settingsChanged.length;
    const res = await api(handle.base, 'POST', '/api/v1/admin/groups', {
      cookie: adminCookie,
      body: {
        code: 'premium',
        name: 'Premium 组',
        description: '高配额组',
        isDefault: true,
        maxNetworks: 10,
        maxPeersPerNetwork: 32,
        relayRateKbps: 65536,
        monthlyRelayQuotaBytes: 10 * 1024 ** 3,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.isDefault, true);
    assert.equal(res.json.data.userCount, 0);
    spareGroupId = res.json.data.id;

    const list = await api(handle.base, 'GET', '/api/v1/admin/groups', { cookie: adminCookie });
    const def = list.json.data.find((g) => g.id === 'grp_default');
    const premium = list.json.data.find((g) => g.id === spareGroupId);
    assert.equal(def.isDefault, false);
    assert.equal(premium.isDefault, true);

    assert.ok(handle.hooks.settingsChanged.length > settingsChangedBefore);
    assert.ok(handle.hooks.quotaChanged.includes(null)); // 全量失效
    // 默认组切换同步 system_settings 三项配额键
    const settings = await handle.store.getSettings();
    assert.equal(settings.maxNetworksPerUser, 10);
    assert.equal(settings.relayRateKbps, 65536);
  });

  test('PATCH /admin/groups/:id：空体 400、默认组不可撤销、改默认组配额同步 settings + 钩子', async () => {
    const empty = await api(handle.base, 'PATCH', `/api/v1/admin/groups/${spareGroupId}`, {
      cookie: adminCookie,
      body: {},
    });
    assert.equal(empty.status, 400);
    assertEnvelopeError(empty.json, 'INVALID_REQUEST');

    const unset = await api(handle.base, 'PATCH', `/api/v1/admin/groups/${spareGroupId}`, {
      cookie: adminCookie,
      body: { isDefault: false },
    });
    assert.equal(unset.status, 400);
    assertEnvelopeError(unset.json, 'CANNOT_UNSET_DEFAULT_GROUP');

    const unknown = await api(handle.base, 'PATCH', '/api/v1/admin/groups/grp_nope', {
      cookie: adminCookie,
      body: { name: 'X' },
    });
    assert.equal(unknown.status, 404);
    assertEnvelopeError(unknown.json, 'GROUP_NOT_FOUND');

    const settingsChangedBefore = handle.hooks.settingsChanged.length;
    const patched = await api(handle.base, 'PATCH', `/api/v1/admin/groups/${spareGroupId}`, {
      cookie: adminCookie,
      body: { name: 'Premium 组 v2', relayRateKbps: 131072 },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.data.name, 'Premium 组 v2');
    assert.equal(patched.json.data.relayRateKbps, 131072);
    assert.ok(handle.hooks.settingsChanged.length > settingsChangedBefore);
    assert.ok(handle.hooks.quotaChanged.includes(null));
    const settings = await handle.store.getSettings();
    assert.equal(settings.relayRateKbps, 131072);
  });

  test('GC-fix-batch1 R3：修改非默认组配额 → onQuotaChanged 触发且不误触 onSettingsChanged', async () => {
    // 此 describe 的时序里默认组是 premium 组（spareGroupId）；新建一个非默认组再改它的配额
    const grp = await api(handle.base, 'POST', '/api/v1/admin/groups', {
      cookie: adminCookie,
      body: { code: 'nondef', name: 'NonDefault', maxNetworks: 2, maxPeersPerNetwork: 4, relayRateKbps: 64 },
    });
    assert.equal(grp.status, 200);
    const gid = grp.json.data.id;
    assert.equal(grp.json.data.isDefault, false);
    const settingsBefore = handle.hooks.settingsChanged.length;
    const quotaBefore = handle.hooks.quotaChanged.length;
    const patched = await api(handle.base, 'PATCH', `/api/v1/admin/groups/${gid}`, {
      cookie: adminCookie,
      body: { maxPeersPerNetwork: 6, relayRateKbps: 128 },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.data.maxPeersPerNetwork, 6);
    assert.equal(handle.hooks.quotaChanged.length, quotaBefore + 1, '非默认组配额变更必须触发 onQuotaChanged');
    assert.ok(handle.hooks.quotaChanged.slice(quotaBefore).includes(null), '全量失效通知');
    assert.equal(handle.hooks.settingsChanged.length, settingsBefore, '非默认组变更不得触发 onSettingsChanged');
    // 仅改名称不触发配额刷新
    const quotaBeforeRename = handle.hooks.quotaChanged.length;
    const renamed = await api(handle.base, 'PATCH', `/api/v1/admin/groups/${gid}`, {
      cookie: adminCookie,
      body: { name: 'NonDefault v2' },
    });
    assert.equal(renamed.status, 200);
    assert.equal(handle.hooks.quotaChanged.length, quotaBeforeRename, '名称变更不属于配额变更');
  });

  test('DELETE 保护：默认组 400（检查优先于引用）/ 非默认有引用 409 / 空组成功', async () => {
    // 前序测试已把默认组切到 premium 组：删除当前默认组 → 400 CANNOT_DELETE_DEFAULT_GROUP
    const defDel = await api(handle.base, 'DELETE', `/api/v1/admin/groups/${spareGroupId}`, { cookie: adminCookie });
    assert.equal(defDel.status, 400);
    assertEnvelopeError(defDel.json, 'CANNOT_DELETE_DEFAULT_GROUP');

    // grp_default 此刻已非默认组，但仍被初始管理员引用 → 409 GROUP_IN_USE
    const inUse = await api(handle.base, 'DELETE', '/api/v1/admin/groups/grp_default', { cookie: adminCookie });
    assert.equal(inUse.status, 409);
    assertEnvelopeError(inUse.json, 'GROUP_IN_USE');

    const emptyGroup = await api(handle.base, 'POST', '/api/v1/admin/groups', {
      cookie: adminCookie,
      body: { code: 'temp', name: '临时组', maxNetworks: 1, maxPeersPerNetwork: 2, relayRateKbps: 64 },
    });
    assert.equal(emptyGroup.status, 200);
    const del = await api(handle.base, 'DELETE', `/api/v1/admin/groups/${emptyGroup.json.data.id}`, {
      cookie: adminCookie,
    });
    assert.equal(del.status, 200);
    assert.deepEqual(del.json.data, { deleted: true });
    const list = await api(handle.base, 'GET', '/api/v1/admin/groups', { cookie: adminCookie });
    assert.ok(!list.json.data.some((g) => g.code === 'temp'));
  });
});

describe('GC-6a 用户管理 /admin/users CRUD 与密码重置', () => {
  const handle = {};
  let adminCookie;
  let adminId;
  let tenantId;
  let autoUserId;
  let autoPassword;

  before(async () => {
    Object.assign(handle, await startServer());
    const seeded = await seedUsers(handle.store);
    adminId = seeded.adminId;
    tenantId = seeded.tenantId;
    adminCookie = await login(handle.base, ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  after(async () => stopServer(handle));

  test('POST 无密码创建 → 仅本次返回 generatedPassword，且可立即登录', async () => {
    const res = await api(handle.base, 'POST', '/api/v1/admin/users', {
      cookie: adminCookie,
      body: { email: 'auto@local' },
    });
    assert.equal(res.status, 200);
    autoUserId = res.json.data.id;
    autoPassword = res.json.data.generatedPassword;
    assert.match(autoPassword, /^[a-hj-km-np-z2-9]{16}$/i); // 16 位无易混字符（排除 i/l/o/0/1）字母表
    assert.equal(res.json.data.email, 'auto@local');
    assert.equal(res.json.data.groupId, 'grp_default');
    assert.equal(res.json.data.effectiveGroupId, 'grp_default');
    // 生成密码可登录
    const loginRes = await api(handle.base, 'POST', '/api/v1/auth/login', {
      body: { email: 'auto@local', password: autoPassword },
    });
    assert.equal(loginRes.status, 200);
  });

  test('POST 显式密码 + groupCode 解析 + emailVerified；重复邮箱 409、未知组 404', async () => {
    await api(handle.base, 'POST', '/api/v1/admin/groups', {
      cookie: adminCookie,
      body: { code: 'staff', name: 'Staff', maxNetworks: 4, maxPeersPerNetwork: 8, relayRateKbps: 4096 },
    });
    const res = await api(handle.base, 'POST', '/api/v1/admin/users', {
      cookie: adminCookie,
      body: { email: 'coded@local', password: 'plain-pass-123', groupCode: 'staff', emailVerified: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.generatedPassword, undefined);
    assert.equal(res.json.data.groupCode, 'staff');
    assert.equal(res.json.data.emailVerifiedAt !== null, true);

    const dup = await api(handle.base, 'POST', '/api/v1/admin/users', {
      cookie: adminCookie,
      body: { email: 'coded@local', password: 'another-pass-1' },
    });
    assert.equal(dup.status, 409);
    assertEnvelopeError(dup.json, 'EMAIL_TAKEN');

    const unknownGroup = await api(handle.base, 'POST', '/api/v1/admin/users', {
      cookie: adminCookie,
      body: { email: 'ghost@local', password: 'another-pass-1', groupCode: 'nope' },
    });
    assert.equal(unknownGroup.status, 404);
    assertEnvelopeError(unknownGroup.json, 'GROUP_NOT_FOUND');

    const shortPass = await api(handle.base, 'POST', '/api/v1/admin/users', {
      cookie: adminCookie,
      body: { email: 'short@local', password: 'short' },
    });
    assert.equal(shortPass.status, 400);
    assertEnvelopeError(shortPass.json, 'INVALID_REQUEST');
  });

  test('PATCH 部分更新：空体 400、未知用户 404、非法到期时间 400、groupId null 复位默认组', async () => {
    const empty = await api(handle.base, 'PATCH', `/api/v1/admin/users/${tenantId}`, {
      cookie: adminCookie,
      body: {},
    });
    assert.equal(empty.status, 400);
    assertEnvelopeError(empty.json, 'INVALID_REQUEST');

    const unknown = await api(handle.base, 'PATCH', '/api/v1/admin/users/ffffffffffffffff', {
      cookie: adminCookie,
      body: { active: true },
    });
    assert.equal(unknown.status, 404);

    const badExpiry = await api(handle.base, 'PATCH', `/api/v1/admin/users/${tenantId}`, {
      cookie: adminCookie,
      body: { groupExpiresAt: 'not-a-date' },
    });
    assert.equal(badExpiry.status, 400);
    assertEnvelopeError(badExpiry.json, 'INVALID_REQUEST');

    // groupId: null → 复位回当前默认组（grp_default）
    const reset = await api(handle.base, 'PATCH', `/api/v1/admin/users/${tenantId}`, {
      cookie: adminCookie,
      body: { groupId: null, groupExpiresAt: null },
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.data.groupId, 'grp_default');
    assert.equal(reset.json.data.groupCode, 'default');
    assert.equal(reset.json.data.groupExpiresAt, null);
  });

  test('GC-fix-batch1 R3：切换默认组后 groupId/groupCode null 绑定新默认组（而非 grp_default）', async () => {
    const grp = await api(handle.base, 'POST', '/api/v1/admin/groups', {
      cookie: adminCookie,
      body: { code: 'newdef', name: 'New Default', isDefault: true, maxNetworks: 5, maxPeersPerNetwork: 5, relayRateKbps: 64 },
    });
    assert.equal(grp.status, 200);
    const newDefId = grp.json.data.id;
    assert.notEqual(newDefId, 'grp_default');

    // PATCH groupId: null → 新默认组
    const byId = await api(handle.base, 'PATCH', `/api/v1/admin/users/${tenantId}`, {
      cookie: adminCookie,
      body: { groupId: null },
    });
    assert.equal(byId.status, 200);
    assert.equal(byId.json.data.groupId, newDefId);
    // PATCH groupCode: null → 新默认组
    const byCode = await api(handle.base, 'PATCH', `/api/v1/admin/users/${tenantId}`, {
      cookie: adminCookie,
      body: { groupCode: null },
    });
    assert.equal(byCode.status, 200);
    assert.equal(byCode.json.data.groupId, newDefId);
    // POST 新用户 groupId: null → 新默认组
    const created = await api(handle.base, 'POST', '/api/v1/admin/users', {
      cookie: adminCookie,
      body: { email: 'nulldef@local', password: 'nulldef-pass-1', groupId: null },
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.data.groupId, newDefId);

    // 还原默认组，避免影响后续用例
    const restore = await api(handle.base, 'PATCH', '/api/v1/admin/groups/grp_default', {
      cookie: adminCookie,
      body: { isDefault: true },
    });
    assert.equal(restore.status, 200);
  });

  test('自我保护：CANNOT_DISABLE_SELF / CANNOT_DEMOTE_SELF / CANNOT_DELETE_SELF', async () => {
    const disable = await api(handle.base, 'PATCH', `/api/v1/admin/users/${adminId}`, {
      cookie: adminCookie,
      body: { active: false },
    });
    assert.equal(disable.status, 400);
    assertEnvelopeError(disable.json, 'CANNOT_DISABLE_SELF');

    const demote = await api(handle.base, 'PATCH', `/api/v1/admin/users/${adminId}`, {
      cookie: adminCookie,
      body: { role: 'user' },
    });
    assert.equal(demote.status, 400);
    assertEnvelopeError(demote.json, 'CANNOT_DEMOTE_SELF');

    const del = await api(handle.base, 'DELETE', `/api/v1/admin/users/${adminId}`, { cookie: adminCookie });
    assert.equal(del.status, 400);
    assertEnvelopeError(del.json, 'CANNOT_DELETE_SELF');
  });

  test('reset-password：自动生成（旧会话全部失效）与显式新密码两条路', async () => {
    // 自动生成路径
    const oldCookie = await login(handle.base, 'auto@local', autoPassword);
    const auto = await api(handle.base, 'POST', `/api/v1/admin/users/${autoUserId}/reset-password`, {
      cookie: adminCookie,
      body: {},
    });
    assert.equal(auto.status, 200);
    assert.equal(auto.json.data.reset, true);
    assert.ok(typeof auto.json.data.generatedPassword === 'string' && auto.json.data.generatedPassword.length === 16);

    const stale = await api(handle.base, 'GET', '/api/v1/networks', { cookie: oldCookie });
    assert.equal(stale.status, 401); // 历史会话已吊销
    const relogin = await api(handle.base, 'POST', '/api/v1/auth/login', {
      body: { email: 'auto@local', password: auto.json.data.generatedPassword },
    });
    assert.equal(relogin.status, 200);

    // 显式新密码路径
    const explicit = await api(handle.base, 'POST', `/api/v1/admin/users/${autoUserId}/reset-password`, {
      cookie: adminCookie,
      body: { newPassword: 'brand-new-pass-1' },
    });
    assert.equal(explicit.status, 200);
    assert.deepEqual(explicit.json.data, { reset: true });
    const withNew = await api(handle.base, 'POST', '/api/v1/auth/login', {
      body: { email: 'auto@local', password: 'brand-new-pass-1' },
    });
    assert.equal(withNew.status, 200);

    const tooShort = await api(handle.base, 'POST', `/api/v1/admin/users/${autoUserId}/reset-password`, {
      cookie: adminCookie,
      body: { newPassword: 'short' },
    });
    assert.equal(tooShort.status, 400);
    assertEnvelopeError(tooShort.json, 'INVALID_REQUEST');

    const unknown = await api(handle.base, 'POST', '/api/v1/admin/users/ffffffffffffffff/reset-password', {
      cookie: adminCookie,
      body: { newPassword: 'brand-new-pass-1' },
    });
    assert.equal(unknown.status, 404);
  });

  test('DELETE 用户：级联删除 + onUserDeleted/onUserDisabled 钩子 + 账号消失', async () => {
    const del = await api(handle.base, 'DELETE', `/api/v1/admin/users/${autoUserId}`, { cookie: adminCookie });
    assert.equal(del.status, 200);
    assert.deepEqual(del.json.data, { deleted: true });
    assert.ok(handle.hooks.userDeleted.includes(autoUserId));
    assert.ok(handle.hooks.userDisabled.includes(autoUserId));
    assert.equal(await handle.store.findUserById(autoUserId), null);
    // 已删账号登录 → 401
    const loginRes = await api(handle.base, 'POST', '/api/v1/auth/login', {
      body: { email: 'auto@local', password: 'brand-new-pass-1' },
    });
    assert.equal(loginRes.status, 401);
    assertEnvelopeError(loginRes.json, 'INVALID_CREDENTIALS');

    const unknown = await api(handle.base, 'DELETE', '/api/v1/admin/users/ffffffffffffffff', {
      cookie: adminCookie,
    });
    assert.equal(unknown.status, 404);
  });
});

describe('GC-6a publicUrl 热更新（settings 优先级最高，立即生效）', () => {
  test('settings 更新后 joinUri 与 /admin/runtime 立即反映新地址，无需重启', async () => {
    const h = await startServer({ publicUrl: 'https://old.example.com' });
    try {
      await seedUsers(h.store);
      const adminCookie = await login(h.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const tenantCookie = await login(h.base, TENANT_EMAIL, TENANT_PASSWORD);

      const before = await api(h.base, 'POST', '/api/v1/networks', {
        cookie: tenantCookie,
        body: { name: 'pre-hot' },
      });
      assert.equal(before.status, 200);
      assert.ok(before.json.data.joinUri.startsWith('zr-net://old.example.com:443/'));
      const rtBefore = await api(h.base, 'GET', '/api/v1/admin/runtime', { cookie: adminCookie });
      assert.equal(rtBefore.json.data.publicUrlSource, 'settings');
      assert.equal(rtBefore.json.data.publicUrlEffective, 'https://old.example.com');

      // 管理后台热更新的持久化路径：直接写 extendedSettings
      await h.store.updateExtendedSettings({ publicUrl: 'https://gw.new.example.com' });

      const after = await api(h.base, 'POST', '/api/v1/networks', {
        cookie: tenantCookie,
        body: { name: 'post-hot' },
      });
      assert.equal(after.status, 200);
      assert.ok(after.json.data.joinUri.startsWith('zr-net://gw.new.example.com:443/'));
      const rtAfter = await api(h.base, 'GET', '/api/v1/admin/runtime', { cookie: adminCookie });
      assert.equal(rtAfter.json.data.publicUrlSource, 'settings');
      assert.equal(rtAfter.json.data.publicUrlEffective, 'https://gw.new.example.com');
    } finally {
      await stopServer(h);
    }
  });
});

describe('GC-fix-batch1 R1：POST /approve 遵守用户组每网设备上限', () => {
  test('普通用户网络 maxPeers=4 但组上限 2：第 3 台 approve → 409 LIMIT_REACHED；admin 网络豁免', async () => {
    const h = await startServer();
    try {
      const { tenantId, adminId } = await seedUsers(h.store);
      const tiny = await h.store.createUserGroup({
        code: 'r1tiny', name: 'Tiny', maxNetworks: 4, maxPeersPerNetwork: 2, relayRateKbps: 2048,
      });
      await h.store.updateUserByAdmin(tenantId, { groupId: tiny.id });
      // 祖父存量形态：网络容量 4 大于组上限 2（绕过 REST 建网校验，直经 store 造）
      const net = await h.store.createNetwork({
        ownerId: tenantId, name: 'r1-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 4,
      });
      await seedMember(h.store, net.id, 'd1aaaaaa', 'authorized');
      await seedMember(h.store, net.id, 'd2aaaaaa', 'authorized');
      await seedMember(h.store, net.id, 'd3aaaaaa', 'pending');
      const tenantCookie = await login(h.base, TENANT_EMAIL, TENANT_PASSWORD);
      const res = await api(h.base, 'POST', `/api/v1/networks/${net.id}/members/d3aaaaaa/approve`, {
        cookie: tenantCookie,
        body: {},
      });
      assert.equal(res.status, 409);
      assertEnvelopeError(res.json, 'LIMIT_REACHED');
      const still = (await h.store.listMembers(net.id)).find((m) => m.nodeId === 'd3aaaaaa');
      assert.equal(still.status, 'pending', '被拒的 approve 不得改变成员状态');

      // admin 属主的网络无组上限约束：2 席内正常批准
      const adminNet = await h.store.createNetwork({
        ownerId: adminId, name: 'r1-admin-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 2,
      });
      await seedMember(h.store, adminNet.id, 'd4aaaaaa', 'authorized');
      await seedMember(h.store, adminNet.id, 'd5aaaaaa', 'pending');
      const adminCookie = await login(h.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const ok = await api(h.base, 'POST', `/api/v1/networks/${adminNet.id}/members/d5aaaaaa/approve`, {
        cookie: adminCookie,
        body: {},
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.data.member.status, 'authorized');
    } finally {
      await stopServer(h);
    }
  });
});

describe('GC-fix-batch1 R3：/admin/runtime 在未注入 runtimeMeta 时安全', () => {
  test('meta 缺省 → 200 保守值（端口 0、sqlite/file、request 推断入口），不抛异常', async () => {
    const h = await startServer(); // 不传 runtimeMeta
    try {
      await seedUsers(h.store);
      const adminCookie = await login(h.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const res = await api(h.base, 'GET', '/api/v1/admin/runtime', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const data = res.json.data;
      assert.equal(data.listenPort, 0);
      assert.equal(data.udpPort, 0);
      assert.equal(data.udpAltPort, 0);
      assert.equal(data.storageDriver, 'sqlite');
      assert.equal(data.secretSource, 'file');
      assert.equal(data.publicUrlSource, 'request');
      assert.ok(data.securityWarnings.includes('UDP_ALT_DISABLED'), '辅助口未确认启用时的保守告警');
    } finally {
      await stopServer(h);
    }
  });
});
