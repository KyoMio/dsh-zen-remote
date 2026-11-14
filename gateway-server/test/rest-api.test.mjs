// PG-4 REST API 契约测试：真实 http.Server + SqliteStore(:memory:)。
// 覆盖：统一 JSON 信封、Cookie 会话鉴权、同源写保护（CSRF）、auth 四路由、
// allowSignup 开关联动注册、租户隔离与 admin 门禁、网络 CRUD / 配额 / rotate-key、
// 成员五态操作（approve/reject/pause/resume/repin/delete）与满额 409、
// 管理员路由与停用租户即时令 Cookie 失效。
// 与 store.test.mjs 相同：.mjs 直接 import 编译产物 ../dist/。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createGatewayApiServer } from '../dist/server.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import { deriveMasterKeyFromSecret, hashPassword, decryptSecret } from '../dist/master-key.js';

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
  const hooks = { memberChanged: [], networkDeleted: [], settingsChanged: [], userDisabled: [] };
  const server = createGatewayApiServer({
    store,
    masterKey: MASTER_KEY,
    publicUrl: opts.publicUrl,
    runtime: opts.runtime,
    hooks: {
      onMemberChanged: (event) => hooks.memberChanged.push(event),
      onNetworkDeleted: (networkId) => hooks.networkDeleted.push(networkId),
      onSettingsChanged: (settings) => hooks.settingsChanged.push(settings),
      onUserDisabled: (userId) => hooks.userDisabled.push(userId),
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
        maxNetworksPerUser: 2,
      });
    });

    test('login 成功：信封 + HttpOnly/Path=/ SameSite=Strict Cookie（http 无 Secure）', async () => {
      const res = await api(handle.base, 'POST', '/api/v1/auth/login', {
        body: { email: TENANT_EMAIL, password: TENANT_PASSWORD },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.deepEqual(res.json.data, {
        user: { id: tenantId, email: TENANT_EMAIL, role: 'user' },
        allowSignup: false,
        maxNetworksPerUser: 2,
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
      assert.deepEqual(me.json.data.user, { id: tenantId, email: TENANT_EMAIL, role: 'user' });
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

    test('GET /admin/users：脱敏（无 passwordHash）+ 网络/在线/速率统计（缺省 runtime 为 0）', async () => {
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
          'email',
          'id',
          'networkCount',
          'onlineDevices',
          'relayKbps',
          'role',
        ]);
        assert.ok(!JSON.stringify(row).includes('passwordHash'));
        assert.equal(row.onlineDevices, 0);
        assert.equal(row.relayKbps, 0);
      }
      assert.equal(adminRow.role, 'admin');
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
  test('公网 IP 跑明文 http:// 时 joinUri 发出 zr-net+insecure://，避免节点端误连 wss://', async () => {
    const h = await startServer({ publicUrl: 'http://203.0.113.10:19393' });
    try {
      await seedUsers(h.store);
      const cookie = await login(h.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const res = await api(h.base, 'POST', '/api/v1/networks', { cookie, body: { name: 'http-public' } });
      assert.equal(res.status, 200);
      assert.equal(
        res.json.data.joinUri,
        `zr-net+insecure://203.0.113.10:19393/${res.json.data.id}#${res.json.data.joinKey}`,
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
        `zr-nets://${host}/${res.json.data.id}#${res.json.data.joinKey}`,
      );
    } finally {
      await stopServer(h);
    }
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
