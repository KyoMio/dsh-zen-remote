// PG-6a 控制台前端纯逻辑测试：中英词典 100% 键对称、「说人话」黑话扫描、
// SSE 快照合并只动 topology 切片（绝不碰 UI 本地交互状态：弹窗/下拉菜单/
// 行内二次确认/表单草稿）、REST 信封解包与 SSE 订阅解析。
// GC-7b 扩展：配额格式化 / 用量进度档位、配额到期展示、无头接入命令、
// GC-5/GC-6 认证自助与管理 API 客户端契约、公开策略/配额/管理切片的
// 状态转移与引用隔离。
// 与其余测试相同：.mjs 直接 import 编译产物 ../dist/。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCALES,
  LOCALE_STORAGE_KEY,
  pickLocale,
  resolveLocale,
  translate,
} from '../dist/web/i18n/locales.js';
import {
  buildHeadlessJoinCommand,
  classifyLinkPath,
  computeUsagePercent,
  derivePeerConnRow,
  filterJoinedMembers,
  formatBytesQuota,
  formatLatencyRange,
  formatQuotaExpiry,
  formatRate,
  isQuotaExceeded,
  maskInviteUri,
  memberStatusView,
  quotaUsageLevel,
} from '../dist/web/format.js';
import { PeerRateLimiter } from '../dist/peer-hub/rate-limiter.js';
import { copyTextToClipboard } from '../dist/web/clipboard.js';
import {
  ConsoleApiError,
  ConsoleClient,
  ConsoleStore,
  ManagedRefreshCycle,
  applyAdminGroups,
  applyAdminRuntime,
  applyNetworks,
  applyPublicPolicy,
  applyQuota,
  applySession,
  applySessionPayload,
  applyTopologySnapshot,
  createInitialState,
  deriveNetworkCounts,
  markAdminError,
  markAdminLoading,
  patchUiState,
  setLoggedOut,
} from '../dist/web/store/console-store.js';

// ---------------------------------------------------------------- 夹具

function makeNetworkView(id, name, overrides = {}) {
  return {
    id,
    name,
    admissionMode: 'both',
    maxPeers: 8,
    createdAt: '2026-01-01T00:00:00.000Z',
    joinKey: 'a'.repeat(64),
    joinUri: `zr-net://gw.local/${id}#${'a'.repeat(64)}`,
    gatewayUrl: 'http://gw.local',
    onlineDevices: 1,
    totalDevices: 3,
    pendingCount: 0,
    ...overrides,
  };
}

function makeSnapshot(networkId, overrides = {}) {
  return {
    network: { id: networkId, name: `net-${networkId}`, admissionMode: 'both', maxPeers: 8 },
    summary: { onlineDevices: 1, pendingCount: 1, totalLiveRelayKbps: 12.5 },
    pending: [{ nodeId: 'deadbeef', name: '新设备', lastIp: '192.168.1.5' }],
    members: [
      {
        nodeId: 'deadbeef',
        name: '新设备',
        status: 'pending',
        natType: 'unknown',
        lastIp: '192.168.1.5',
        online: false,
        liveRelayKbps: 0,
        cumulativeRelayBytes: 0,
      },
    ],
    links: [],
    ...overrides,
  };
}

const TEST_USER = { id: 'u-1', email: 'owner@local', role: 'user' };
const TEST_META = { allowSignup: true, maxNetworksPerUser: 3 };

// ---- GC-7b 夹具：镜像后端 GC-5/GC-6a/GC-6b 真实返回形状 ----

/** GET /auth/me 登录态与 login/signup 响应里的配额视图 */
function makeQuota(overrides = {}) {
  return {
    groupId: 'grp_default',
    assignedGroupId: 'grp_default',
    groupCode: 'default',
    groupName: '默认用户组',
    groupExpiresAt: null,
    isExpiredFallback: false,
    maxNetworks: 3,
    maxPeersPerNetwork: 8,
    relayRateKbps: 512,
    monthlyRelayQuotaBytes: 1073741824,
    usedNetworks: 1,
    usedMonthlyRelayBytes: 2048,
    ...overrides,
  };
}

/** 登录/注册响应的公开策略段 */
function makePublicPolicy(overrides = {}) {
  return {
    allowSignup: true,
    requireEmailVerification: false,
    smtpConfigured: true,
    maxNetworksPerUser: 3,
    defaultMaxPeers: 8,
    ...overrides,
  };
}

/** GET /api/v1/admin/runtime 的运行态 */
function makeRuntimeStatus(overrides = {}) {
  return {
    listenPort: 19393,
    udpPort: 19394,
    udpAltPort: 19395,
    storageDriver: 'sqlite',
    secretSource: 'env',
    publicUrlEffective: 'https://gw.example.com',
    publicUrlSource: 'settings',
    smtpConfigured: true,
    onlineDevices: 3,
    totalLiveRelayKbps: 12.5,
    cumulativeRelayBytes: 1048576,
    securityWarnings: [],
    ...overrides,
  };
}

/** GET/PATCH /api/v1/admin/settings 的完整脱敏视图 */
function makeAdminSettings(overrides = {}) {
  return {
    allowSignup: true,
    requireEmailVerification: false,
    maxNetworksPerUser: 3,
    defaultMaxPeers: 8,
    relayRateKbps: 512,
    publicUrl: null,
    sessionTtlDays: 7,
    defaultGroupId: 'grp_default',
    smtp: {
      configured: false,
      host: '',
      port: 0,
      security: 'starttls',
      username: '',
      hasPassword: false,
      fromAddress: '',
      fromName: '',
      rejectUnauthorized: true,
    },
    adminApiKey: { configured: false, prefix: null, createdAt: null },
    ...overrides,
  };
}

/** GET /api/v1/admin/groups 的行（UserGroupRecord + userCount） */
function makeGroup(id, overrides = {}) {
  return {
    id,
    code: id.replace(/^grp_/, ''),
    name: `组-${id}`,
    description: '',
    isDefault: false,
    maxNetworks: 3,
    maxPeersPerNetwork: 8,
    relayRateKbps: 512,
    monthlyRelayQuotaBytes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    userCount: 1,
    ...overrides,
  };
}

/** GET /api/v1/admin/users 的 19 键行 */
function makeAdminUserRow(id, overrides = {}) {
  return {
    id,
    email: `${id}@local`,
    role: 'user',
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    emailVerifiedAt: null,
    groupId: 'grp_default',
    groupCode: 'default',
    groupName: '默认用户组',
    effectiveGroupId: 'grp_default',
    effectiveGroupName: '默认用户组',
    groupExpiresAt: null,
    isExpiredFallback: false,
    maxNetworks: 3,
    networkCount: 1,
    onlineDevices: 0,
    relayKbps: 0,
    monthlyRelayBytes: 0,
    monthlyRelayQuotaBytes: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------- i18n 词典

describe('i18n 双语词典', () => {
  const zhKeys = Object.keys(LOCALES.zh).sort();
  const enKeys = Object.keys(LOCALES.en).sort();

  test('zh 与 en 键 100% 对称，值均为非空字符串', () => {
    assert.deepEqual(enKeys, zhKeys);
    assert.ok(zhKeys.length > 0);
    for (const key of zhKeys) {
      assert.equal(typeof LOCALES.zh[key], 'string', `zh['${key}'] 必须是字符串`);
      assert.equal(typeof LOCALES.en[key], 'string', `en['${key}'] 必须是字符串`);
      assert.ok(LOCALES.zh[key].length > 0, `zh['${key}'] 不能是空串`);
      assert.ok(LOCALES.en[key].length > 0, `en['${key}'] 不能是空串`);
    }
  });

  test('任务钉死的概览词条 zh 文案逐字一致', () => {
    const required = {
      'app.title': 'Zen Remote 网关',
      'nav.networks': '网络',
      'network.devices': '设备',
      'network.inviteLink': '邀请链接',
      'network.rotateInviteLink': '重置邀请链接',
      'network.joinRequests': '加入申请',
      'network.deviceLimit': '设备上限',
      'network.createNew': '新建网络…',
      'identity.verified': '身份已验证',
      'identity.mismatch': '身份异常 / 身份变了',
      'path.lan': '局域网直连',
      'path.direct': '直连',
      'path.relay': '经网关中转',
      'admin.allowSignup': '开放注册',
      'admin.perDeviceRelayLimit': '单台设备中转限速',
      'view.admin': '网关管理',
    };
    for (const [key, expected] of Object.entries(required)) {
      assert.ok(key in LOCALES.zh, `缺少词条 ${key}`);
      assert.equal(LOCALES.zh[key], expected, `zh['${key}'] 应为「${expected}」`);
    }
  });

  test('zh 词典全部值不含禁用技术缩写（说人话规范）', () => {
    const forbidden = [/lan/i, /p2p/i, /relay/i, /nat/i, /tofu/i, /e2ee/i, /ed25519/i, /joinkey/i];
    const offenders = [];
    for (const [key, value] of Object.entries(LOCALES.zh)) {
      for (const re of forbidden) {
        if (re.test(value)) offenders.push(`${key}: ${value} (matched ${re})`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('pickLocale：zh* 归 zh、en* 归 en、其余回落 zh', () => {
    assert.equal(pickLocale('zh-CN'), 'zh');
    assert.equal(pickLocale('zh'), 'zh');
    assert.equal(pickLocale('en-US'), 'en');
    assert.equal(pickLocale('en'), 'en');
    assert.equal(pickLocale('ja-JP'), 'zh');
    assert.equal(pickLocale(''), 'zh');
  });

  test('resolveLocale：持久化选择优先，未设置时按浏览器语言识别', () => {
    assert.equal(resolveLocale('en', 'zh-CN'), 'en');
    assert.equal(resolveLocale('zh', 'en-US'), 'zh');
    assert.equal(resolveLocale(null, 'en-US'), 'en');
    assert.equal(resolveLocale(null, 'zh-CN'), 'zh');
    assert.equal(resolveLocale('xx', 'zh-CN'), 'zh'); // 垃圾值当作未设置
  });

  test('translate 支持 {n} 插值，未知键直接抛错', () => {
    assert.equal(translate('zh', 'auth.signupQuotaHint', { n: 3 }), '注册后最多可以创建 3 个网络');
    assert.equal(translate('en', 'auth.signupQuotaHint', { n: 5 }), 'After signing up you can create up to 5 networks');
    assert.equal(translate('zh', 'app.title'), 'Zen Remote 网关');
    assert.throws(() => translate('zh', 'no.such.key'));
  });

  test('localStorage 键是稳定非空字符串', () => {
    assert.equal(typeof LOCALE_STORAGE_KEY, 'string');
    assert.ok(LOCALE_STORAGE_KEY.length > 0);
  });
});

// ---------------------------------------------------------------- SSE 快照合并

describe('console-store：SSE 快照合并只动 topology 切片', () => {
  test('初始状态干净', () => {
    const state = createInitialState();
    assert.equal(state.boot, 'loading');
    assert.equal(state.session, null);
    assert.deepEqual(state.networks, []);
    assert.deepEqual(state.topology, {});
    assert.equal(state.ui.networkSwitcherOpen, false);
    assert.equal(state.ui.accountMenuOpen, false);
    assert.equal(state.ui.loginMode, 'login');
    assert.equal(state.ui.loginEmail, '');
    assert.equal(state.ui.loginPassword, '');
    assert.equal(state.ui.confirmTarget, null);
    assert.equal(state.ui.dialog, null);
    assert.equal(state.ui.draftNetworkName, '');
  });

  test('topology-updated 合并不重置 networks / ui / session / meta 引用', () => {
    const s1 = applyNetworks(createInitialState(), [
      makeNetworkView('a'.repeat(16), '家里'),
      makeNetworkView('b'.repeat(16), '办公室'),
    ]);
    const s2 = patchUiState(s1, {
      networkSwitcherOpen: true,
      confirmTarget: `rotate-key:${'a'.repeat(16)}`,
      dialog: 'new-network',
      draftNetworkName: '出门用',
      loginEmail: 'owner@local',
      loginPassword: 'pw123456',
    });
    const snapA = makeSnapshot('a'.repeat(16));

    const s3 = applyTopologySnapshot(s2, snapA);
    assert.equal(s3.topology['a'.repeat(16)], snapA, 'topology 切片应存入本次快照');
    assert.equal(s3.networks, s2.networks, 'networks 引用必须原样保留');
    assert.equal(s3.ui, s2.ui, 'ui（菜单/弹窗/二次确认/草稿）引用必须原样保留');
    assert.equal(s3.session, s2.session);
    assert.equal(s3.meta, s2.meta);
    assert.equal(s3.topology['b'.repeat(16)], undefined);
    // 源状态不被原地修改
    assert.equal(s2.topology['a'.repeat(16)], undefined);
  });

  test('另一网络的快照到达时，已打开的 ui 与已有 topology 原样保留', () => {
    const netA = 'a'.repeat(16);
    const netB = 'b'.repeat(16);
    let state = applyNetworks(createInitialState(), [makeNetworkView(netA, '家里'), makeNetworkView(netB, '办公室')]);
    const snapA = makeSnapshot(netA);
    state = applyTopologySnapshot(state, snapA);
    state = patchUiState(state, { accountMenuOpen: true, dialog: 'new-network' });
    const before = state;

    const snapB = makeSnapshot(netB);
    const next = applyTopologySnapshot(state, snapB);
    assert.equal(next.topology[netA], snapA, '别的网络的 topology 切片原样保留');
    assert.equal(next.topology[netB], snapB);
    assert.equal(next.ui, before.ui);
    assert.notEqual(next.topology, before.topology);
  });

  test('同一网络连续推送：只替换该网络切片，其余一切不动', () => {
    const netA = 'a'.repeat(16);
    let state = applyNetworks(createInitialState(), [makeNetworkView(netA, '家里')]);
    state = patchUiState(state, { networkSwitcherOpen: true, confirmTarget: `remove:deadbeef` });
    const snapV1 = makeSnapshot(netA);
    const snapV2 = makeSnapshot(netA, { summary: { onlineDevices: 2, pendingCount: 0, totalLiveRelayKbps: 0 } });

    state = applyTopologySnapshot(state, snapV1);
    const before = state;
    state = applyTopologySnapshot(state, snapV2);
    assert.equal(state.topology[netA], snapV2);
    assert.equal(state.ui, before.ui, '连续推送下 ui 引用纹丝不动');
    assert.equal(state.networks, before.networks);
  });

  test('patchUiState 浅合并、不改源状态', () => {
    const s1 = createInitialState();
    const s2 = patchUiState(s1, { networkSwitcherOpen: true });
    assert.notEqual(s1.ui, s2.ui);
    assert.equal(s2.ui.networkSwitcherOpen, true);
    assert.equal(s2.ui.loginMode, 'login', '未提到的字段原样带过来');
    assert.equal(s1.ui.networkSwitcherOpen, false);
  });

  test('登录写入 session；退出清空数据切片但保留 ui（表单草稿不丢）', () => {
    const netA = 'a'.repeat(16);
    let state = applySession(createInitialState(), TEST_USER, TEST_META);
    assert.equal(state.session.user.email, TEST_USER.email);
    assert.deepEqual(state.meta, TEST_META);

    state = patchUiState(state, { loginEmail: 'owner@local', loginPassword: 'pw123456' });
    state = applyNetworks(state, [makeNetworkView(netA, '家里')]);
    state = applyTopologySnapshot(state, makeSnapshot(netA));
    const withData = state;

    const out = setLoggedOut(withData, TEST_META);
    assert.equal(out.session, null);
    assert.deepEqual(out.networks, []);
    assert.deepEqual(out.topology, {});
    assert.equal(out.ui, withData.ui, '退出登录不清表单草稿');
    assert.deepEqual(out.meta, TEST_META);
  });
});

describe('ConsoleStore（可订阅包装）', () => {
  test('init 按 /auth/me 结果就绪；每次变更只发一次通知', () => {
    const store = new ConsoleStore();
    assert.equal(store.getState().boot, 'loading');

    let emissions = 0;
    const unsubscribe = store.subscribe(() => {
      emissions += 1;
    });

    store.init({ authenticated: false, allowSignup: true, maxNetworksPerUser: 5 });
    assert.equal(emissions, 1);
    assert.equal(store.getState().boot, 'ready');
    assert.equal(store.getState().session, null);
    assert.deepEqual(store.getState().meta, { allowSignup: true, maxNetworksPerUser: 5 });

    store.init({ authenticated: true, user: TEST_USER, allowSignup: false, maxNetworksPerUser: 3 });
    assert.equal(emissions, 2);
    assert.equal(store.getState().session?.user.id, TEST_USER.id);

    unsubscribe();
    store.patchUi({ networkSwitcherOpen: true });
    assert.equal(emissions, 2, '退订后不再收到通知');
    assert.equal(store.getState().ui.networkSwitcherOpen, true, '状态仍正常更新');
  });

  test('applyTopologySnapshot 经由 store 合并后 ui 引用保持不变', () => {
    const store = new ConsoleStore();
    store.init({ authenticated: true, user: TEST_USER, allowSignup: false, maxNetworksPerUser: 3 });
    store.patchUi({ accountMenuOpen: true, loginEmail: 'a@b.c' });
    const before = store.getState();

    const snap = makeSnapshot('c'.repeat(16));
    store.applyTopologySnapshot(snap);
    const after = store.getState();
    assert.equal(after.ui, before.ui);
    assert.equal(after.networks, before.networks);
    assert.equal(after.topology['c'.repeat(16)], snap);
  });
});

// ---------------------------------------------------------------- ConsoleClient

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  };
  return { calls, impl };
}

function jsonEnvelope(status, payload) {
  return { status, json: async () => payload };
}

describe('ConsoleClient：REST 信封', () => {
  test('login：POST 正确路径与 JSON 体，解开 {ok:true,data} 信封', async () => {
    const data = { user: TEST_USER, allowSignup: true, maxNetworksPerUser: 3 };
    const { calls, impl } = fakeFetch(() => jsonEnvelope(200, { ok: true, data }));
    const client = new ConsoleClient({ fetchImpl: impl });

    const result = await client.login('Owner@Local ', 'pw123456');
    assert.deepEqual(result, data);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/v1/auth/login');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'owner@local', password: 'pw123456' });
  });

  test('fetchMe 与 listNetworks 同样走信封解包', async () => {
    const { impl } = fakeFetch((url) =>
      jsonEnvelope(
        200,
        url === '/api/v1/auth/me'
          ? { ok: true, data: { authenticated: false, allowSignup: true, maxNetworksPerUser: 3 } }
          : { ok: true, data: [makeNetworkView('a'.repeat(16), '家里')] },
      ),
    );
    const client = new ConsoleClient({ fetchImpl: impl });

    const me = await client.fetchMe();
    assert.deepEqual(me, { authenticated: false, allowSignup: true, maxNetworksPerUser: 3 });
    const networks = await client.listNetworks();
    assert.equal(networks.length, 1);
    assert.equal(networks[0].name, '家里');
  });

  test('失败信封映射为 ConsoleApiError（code 与 status 保留）', async () => {
    const { impl } = fakeFetch(() =>
      jsonEnvelope(401, { ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'invalid email or password' } }),
    );
    const client = new ConsoleClient({ fetchImpl: impl });
    await assert.rejects(
      () => client.login('a@b.c', 'wrong-pass'),
      (err) => {
        assert.ok(err instanceof ConsoleApiError);
        assert.equal(err.status, 401);
        assert.equal(err.code, 'INVALID_CREDENTIALS');
        assert.equal(err.message, 'invalid email or password');
        return true;
      },
    );
  });
});

describe('ConsoleClient：SSE 订阅', () => {
  function fakeEventSource() {
    const listeners = new Map();
    let url = '';
    let closed = false;
    return {
      get url() {
        return url;
      },
      get closed() {
        return closed;
      },
      dispatch(type, event) {
        const l = listeners.get(type);
        if (l !== undefined) l(event);
      },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      close() {
        closed = true;
      },
      factory(input) {
        url = input;
        return this;
      },
    };
  }

  test('订阅 topology-updated 与 snapshot，解析 data JSON 并回调', () => {
    const es = fakeEventSource();
    const client = new ConsoleClient({ eventSourceFactory: (url) => es.factory(url) });
    const got = [];
    const unsubscribe = client.subscribeTopology('net-9', (snapshot) => got.push(snapshot));

    assert.equal(es.url, '/api/v1/networks/net-9/events');

    const snap = makeSnapshot('net-9');
    es.dispatch('topology-updated', { data: JSON.stringify(snap) });
    assert.equal(got.length, 1);
    assert.deepEqual(got[0], snap); // JSON 传输边界只保证深相等，引用相等是进程内合并的事

    const snap2 = makeSnapshot('net-9', { summary: { onlineDevices: 0, pendingCount: 0, totalLiveRelayKbps: 0 } });
    es.dispatch('snapshot', { data: JSON.stringify(snap2) });
    assert.equal(got.length, 2);
    assert.deepEqual(got[1], snap2);

    unsubscribe();
    assert.equal(es.closed, true);
  });

  test('坏帧（非 JSON / 缺 data）静默忽略，不中断订阅', () => {
    const es = fakeEventSource();
    const client = new ConsoleClient({ eventSourceFactory: (url) => es.factory(url) });
    const got = [];
    const unsubscribe = client.subscribeTopology('net-9', (snapshot) => got.push(snapshot));

    es.dispatch('topology-updated', { data: 'not-json' });
    es.dispatch('topology-updated', {});
    assert.equal(got.length, 0);

    const snap = makeSnapshot('net-9');
    es.dispatch('topology-updated', { data: JSON.stringify(snap) });
    assert.equal(got.length, 1);
    unsubscribe();
  });
});

// ---------------------------------------------------------------- WebIDL this 接收器

// 真实浏览器的 window.fetch 带 WebIDL 品牌检查（brand check）：receiver 不是
// Window/globalThis 就抛 TypeError: Illegal invocation。Node 的 undici fetch
// 不校验 this，所以这两个回归用例专门模拟浏览器行为，钉住调用形态：
// defaultFetch() 必须 .bind(globalThis)，request()/subscribeTopology() 必须
// 以局部变量调用注入件，绝不把 ConsoleClient 实例当 receiver 传出去。
describe('ConsoleClient：WebIDL this 接收器（浏览器 Illegal invocation 回归）', () => {
  test('默认 globalThis.fetch：品牌检查替身要求 receiver 恰为 globalThis（bind 已生效）', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    assert.ok(original, '运行环境必须有全局 fetch');
    const brandCheckedFetch = function (url, init) {
      // 严格模拟 Chromium：defaultFetch() 绑定 globalThis 后，绑定函数的
      // receiver 恒为 globalThis；若仍是方法属性调用（this = client 实例）
      // 或依赖隐式 undefined，都按浏览器语义抛 Illegal invocation。
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(
        jsonEnvelope(200, { ok: true, data: { authenticated: false, allowSignup: true, maxNetworksPerUser: 3 } }),
      );
    };
    // Node 的全局 fetch 是 getter-only 属性，普通赋值在 strict mode 下会抛错，
    // 用 defineProperty 原地替换、finally 按原描述符还原。
    Object.defineProperty(globalThis, 'fetch', {
      value: brandCheckedFetch,
      writable: true,
      enumerable: original.enumerable,
      configurable: true,
    });
    try {
      // 不传 fetchImpl：走 defaultFetch() 全局路径（构造时读取 globalThis.fetch）
      const me = await new ConsoleClient().fetchMe();
      assert.deepEqual(me, { authenticated: false, allowSignup: true, maxNetworksPerUser: 3 });
    } finally {
      Object.defineProperty(globalThis, 'fetch', original);
    }
  });

  test('显式注入 fetchImpl / eventSourceFactory：不得以 ConsoleClient 实例为 this 调用', async () => {
    const seenFetchReceivers = [];
    const seenFactoryReceivers = [];
    const esStub = {
      addEventListener() {},
      close() {},
    };
    const customFetch = async function (url) {
      seenFetchReceivers.push(this);
      return jsonEnvelope(200, { ok: true, data: { authenticated: false, allowSignup: true, maxNetworksPerUser: 3 } });
    };
    const customEsFactory = function (url) {
      seenFactoryReceivers.push(this);
      return esStub;
    };
    const client = new ConsoleClient({ fetchImpl: customFetch, eventSourceFactory: customEsFactory });

    await client.fetchMe();
    const unsubscribe = client.subscribeTopology('net-9', () => {});
    unsubscribe();

    assert.equal(seenFetchReceivers.length, 1);
    assert.ok(
      !(seenFetchReceivers[0] instanceof ConsoleClient),
      'request() 不得把 ConsoleClient 实例当 this 传给注入的 fetch',
    );
    assert.equal(seenFactoryReceivers.length, 1);
    assert.ok(
      !(seenFactoryReceivers[0] instanceof ConsoleClient),
      'subscribeTopology() 不得把 ConsoleClient 实例当 this 传给注入的工厂',
    );
  });
});

// ---------------------------------------------------------------- PG-6c：纯逻辑与数据语义

const tZh = (key, vars) => translate('zh', key, vars);
const tEn = (key, vars) => translate('en', key, vars);

function makeMember(nodeId, status, overrides = {}) {
  return {
    nodeId,
    name: `dev-${nodeId}`,
    note: null,
    status,
    natType: 'cone',
    lastIp: null,
    online: true,
    liveRelayKbps: 0,
    cumulativeRelayBytes: 0,
    lastSeenAt: null,
    ...overrides,
  };
}

describe('format：邀请链接掩码 maskInviteUri', () => {
  test('保留 # 之前的 zr-net:// 前缀，只把入网口令换成圆点', () => {
    assert.equal(
      maskInviteUri('zr-net://gw.local:19393/0123456789abcdef#secret'),
      'zr-net://gw.local:19393/0123456789abcdef#••••••••',
    );
  });

  test('不含 # 时原样返回', () => {
    assert.equal(maskInviteUri('zr-net://gw.local/0123456789abcdef'), 'zr-net://gw.local/0123456789abcdef');
  });

  test('第一个 # 之后的内容整体掩掉（口令里出现 # 也不泄露）', () => {
    assert.equal(maskInviteUri('zr-net://gw.local/0123456789abcdef#a#b'), 'zr-net://gw.local/0123456789abcdef#••••••••');
  });
});

describe('format：占席位成员过滤 filterJoinedMembers', () => {
  test('只保留 authorized / paused / mismatch，pending 与 revoked 不进设备表', () => {
    const members = [
      makeMember('a', 'authorized'),
      makeMember('b', 'pending'),
      makeMember('c', 'paused'),
      makeMember('d', 'mismatch'),
      makeMember('e', 'revoked'),
    ];
    assert.deepEqual(
      filterJoinedMembers(members).map((m) => m.nodeId),
      ['a', 'c', 'd'],
      'pending（只在加入申请格）与 revoked（已移除）必须被滤掉',
    );
  });

  test('空列表与全过滤后为空数组，顺序保持原样', () => {
    assert.deepEqual(filterJoinedMembers([]), []);
    const members = [makeMember('x', 'revoked'), makeMember('y', 'pending')];
    assert.deepEqual(filterJoinedMembers(members), []);
    const kept = [makeMember('m', 'mismatch'), makeMember('n', 'authorized')];
    assert.deepEqual(
      filterJoinedMembers(kept).map((m) => m.nodeId),
      ['m', 'n'],
    );
  });
});

describe('format：成员状态圆点 memberStatusView', () => {
  test('paused 用中性圆点（Warn 只留给中转连接点与加入申请），词不变', () => {
    assert.deepEqual(memberStatusView('paused', false, tZh), { dot: 'muted', word: '已暂停' });
    assert.deepEqual(memberStatusView('paused', true, tZh), { dot: 'muted', word: '已暂停' });
    assert.deepEqual(memberStatusView('paused', true, tEn), { dot: 'muted', word: 'Paused' });
  });

  test('其余四档圆点档位保持钉住', () => {
    assert.deepEqual(memberStatusView('authorized', true, tZh), { dot: 'ok', word: '在线' });
    assert.deepEqual(memberStatusView('authorized', false, tZh), { dot: 'muted', word: '离线' });
    assert.deepEqual(memberStatusView('pending', false, tZh), { dot: 'warn', word: '待审批' });
    assert.deepEqual(memberStatusView('mismatch', false, tZh), { dot: 'danger', word: '身份变了' });
    assert.deepEqual(memberStatusView('revoked', false, tZh), { dot: 'muted', word: '已移除' });
  });
});

describe('format：设备间连接行 derivePeerConnRow', () => {
  const linksOf = (...links) => links;

  test('身份异常（self 或任一方 mismatch）→ danger 阻断文案，不再漏判成「设备当前离线」', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    const expectedZh = { dot: 'danger', kindWord: '已阻断', reason: '身份异常，连接已阻断', latency: '—' };
    assert.deepEqual(derivePeerConnRow(tZh, { ...self, status: 'mismatch' }, other, []), expectedZh);
    assert.deepEqual(derivePeerConnRow(tZh, self, { ...other, status: 'mismatch' }, []), expectedZh);
    // mismatch 优先于对方暂停与链路存在
    const lanLink = { srcNodeId: 'self', peerNodeId: 'other', path: 'lan', rttMs: 12, liveRelayKbps: 0 };
    assert.deepEqual(derivePeerConnRow(tZh, self, { ...other, status: 'mismatch' }, linksOf(lanLink)), expectedZh);
  });

  test('英文阻断文案对齐 ui-ux-spec §3.5', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'mismatch');
    assert.deepEqual(derivePeerConnRow(tEn, self, other, []), {
      dot: 'danger',
      kindWord: 'Blocked',
      reason: 'Identity changed, connection blocked',
      latency: '—',
    });
  });

  test('对方暂停 → muted 未连接 + 「对方已暂停」；自己暂停 → muted 未连接 + 本机暂停原因', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    assert.deepEqual(derivePeerConnRow(tZh, self, { ...other, status: 'paused' }, []), {
      dot: 'muted',
      kindWord: '未连接',
      reason: '对方已暂停',
      latency: '—',
    });
    assert.deepEqual(derivePeerConnRow(tZh, { ...self, status: 'paused' }, other, []), {
      dot: 'muted',
      kindWord: '未连接',
      reason: '设备已被暂停，连接已断开',
      latency: '—',
    });
    assert.equal(translate('en', 'device.reasonPeerPaused'), 'The other device is paused');
  });

  test('任一方离线 → muted「设备当前离线」，优先于已存在的链路', () => {
    const self = makeMember('self', 'authorized');
    const otherOffline = makeMember('other', 'authorized', { online: false });
    assert.deepEqual(derivePeerConnRow(tZh, self, otherOffline, []), {
      dot: 'muted',
      kindWord: '未连接',
      reason: '设备当前离线',
      latency: '—',
    });
    const lanLink = { srcNodeId: 'self', peerNodeId: 'other', path: 'lan', rttMs: 12, liveRelayKbps: 0 };
    assert.deepEqual(derivePeerConnRow(tZh, self, otherOffline, linksOf(lanLink)).reason, '设备当前离线');
    assert.equal(derivePeerConnRow(tZh, { ...self, online: false }, makeMember('other', 'authorized'), []).reason, '设备当前离线');
  });

  test('局域网直连 → ok / 局域网直连 / 在同一个局域网内 / 真实延迟；反向登记的链路同样算数', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    const forward = { srcNodeId: 'self', peerNodeId: 'other', path: 'lan', rttMs: 12, liveRelayKbps: 0 };
    const expected = { dot: 'ok', kindWord: '局域网直连', reason: '在同一个局域网内', latency: '12 ms' };
    assert.deepEqual(derivePeerConnRow(tZh, self, other, linksOf(forward)), expected);
    const backward = { srcNodeId: 'other', peerNodeId: 'self', path: 'lan', rttMs: 12, liveRelayKbps: 0 };
    assert.deepEqual(derivePeerConnRow(tZh, self, other, linksOf(backward)), expected);
  });

  test('直连 → ok / 直连 / 已打通直连，不经过网关', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    for (const path of ['p2p', 'direct']) {
      const link = { srcNodeId: 'self', peerNodeId: 'other', path, rttMs: 5, liveRelayKbps: 0 };
      assert.deepEqual(derivePeerConnRow(tZh, self, other, linksOf(link)), {
        dot: 'ok',
        kindWord: '直连',
        reason: '已打通直连，不经过网关',
        latency: '5 ms',
      });
    }
  });

  test('中转按对称型网络区分原因：本机对称 / 对方对称 / 普通中转', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    // PC16a 契约：中继没有测速协议，relay 链路的 rttMs 恒为 null（未知）
    const link = { srcNodeId: 'self', peerNodeId: 'other', path: 'relay', rttMs: null, liveRelayKbps: 8 };

    assert.deepEqual(derivePeerConnRow(tZh, { ...self, natType: 'symmetric' }, other, linksOf(link)), {
      dot: 'warn',
      kindWord: '经网关中转',
      reason: '这台设备的网络不支持直连，已自动中转 · 8 KB/s',
      latency: '—',
    });
    assert.deepEqual(derivePeerConnRow(tZh, self, { ...other, natType: 'symmetric' }, linksOf(link)), {
      dot: 'warn',
      kindWord: '经网关中转',
      reason: '对方网络不支持直连，已自动中转 · 8 KB/s',
      latency: '—',
    });
    assert.deepEqual(derivePeerConnRow(tZh, self, other, linksOf(link)), {
      dot: 'warn',
      kindWord: '经网关中转',
      reason: '这台设备/对方网络不支持直连，已自动中转 · 8 KB/s',
      latency: '—',
    });
    // 双方都对称时优先说本机的原因
    assert.equal(
      derivePeerConnRow(tZh, { ...self, natType: 'symmetric' }, { ...other, natType: 'symmetric' }, linksOf(link)).reason,
      '这台设备的网络不支持直连，已自动中转 · 8 KB/s',
    );
  });

  test('双方在线且已授权但无链路 → muted「还没有建立连接」', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    assert.deepEqual(derivePeerConnRow(tZh, self, other, []), {
      dot: 'muted',
      kindWord: '未连接',
      reason: '还没有建立连接',
      latency: '—',
    });
  });
});

// ---------------------------------------------------------------- PC-16b：blocked 与未知延迟的展示派生

describe('PC-16b：classifyLinkPath 白名单分类', () => {
  test('blocked 独立成类，不再默认归 relay', () => {
    assert.equal(classifyLinkPath('blocked'), 'blocked');
    assert.notEqual(classifyLinkPath('blocked'), 'relay');
  });

  test('正常 lan / p2p / direct / relay 分类保持不变', () => {
    assert.equal(classifyLinkPath('lan'), 'lan');
    assert.equal(classifyLinkPath('p2p'), 'direct');
    assert.equal(classifyLinkPath('direct'), 'direct');
    assert.equal(classifyLinkPath('relay'), 'relay');
  });

  test('白名单外的未知路径归 unknown，不伪装 relay', () => {
    assert.equal(classifyLinkPath('future-path'), 'unknown');
    assert.equal(classifyLinkPath(''), 'unknown');
    assert.notEqual(classifyLinkPath('future-path'), 'relay');
  });
});

describe('PC-16b：formatLatencyRange 未知与实测 0', () => {
  test('null（未知）显示 —，绝不强转成 0 ms', () => {
    assert.equal(formatLatencyRange([null]), '—');
    assert.equal(formatLatencyRange([null, null]), '—');
  });

  test('实测 0 保持真实 0 ms，混合 null 与 0 也不吞掉实测值', () => {
    assert.equal(formatLatencyRange([0]), '0 ms');
    assert.equal(formatLatencyRange([null, 0]), '0 ms');
  });

  test('已知值区间与空列表行为保持', () => {
    assert.equal(formatLatencyRange([]), '—');
    assert.equal(formatLatencyRange([12]), '12 ms');
    assert.equal(formatLatencyRange([12, 30]), '12–30 ms');
    assert.equal(formatLatencyRange([null, 20]), '20 ms', '混合未知与实测时只对实测值取区间');
  });
});

describe('PC-17：速率单位全链（meter → API 字段 → formatter 文案）', () => {
  const linksOf = (...links) => links;

  test('5120 字节 / 5 秒滑窗：meter 读数 1 → liveRelayKbps 字段 → 界面「1 KB/s」', () => {
    const clock = { now: 1_000_000 };
    const lim = new PeerRateLimiter({ now: () => clock.now });
    lim.tryRelay({ networkId: 'n', nodeId: 'self', peerNodeId: 'other' }, 5120, 64);
    // ws-hub 把 limiter 读数原样写进 link.liveRelayKbps（字段名不变，数值单位 KB/s）
    const apiValue = lim.liveRelayKbpsPair('n', 'self', 'other');
    assert.ok(Math.abs(apiValue - 1) < 1e-9, `API 字段值应为 1 KB/s，实际 ${apiValue}`);
    assert.equal(formatRate(apiValue), '1 KB/s');
    const link = { srcNodeId: 'self', peerNodeId: 'other', path: 'relay', rttMs: null, liveRelayKbps: apiValue };
    const row = derivePeerConnRow(tZh, makeMember('self', 'authorized'), makeMember('other', 'authorized'), linksOf(link));
    assert.equal(row.dot, 'warn');
    assert.equal(row.reason, '这台设备/对方网络不支持直连，已自动中转 · 1 KB/s');
  });

  test('该读数经 formatRate 的量级换算不变：值就是 KB/s，不被再乘或除 8', () => {
    // 2.4 KB/s（(8192+4096)/5/1024）必须原样显示，不得出现 19.2（×8）或 0.3（÷8）
    assert.equal(formatRate(2.4), '2 KB/s');
    assert.equal(formatRate(19.2), '19 KB/s');
    // 与配置同单位对照：relayRateKbps=512 → 管理页直显 512 KB/s，formatter 对同值同词
    assert.equal(formatRate(512), '512 KB/s');
  });
});

describe('PC-16b：derivePeerConnRow 阻断与未知路径', () => {
  const linksOf = (...links) => links;

  test('节点本机 TOFU 阻断（双方在网关侧都是正常成员）→ danger 已阻断 + 平实原因 + 延迟 —', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    const blockedFwd = { srcNodeId: 'self', peerNodeId: 'other', path: 'blocked', rttMs: null, liveRelayKbps: 0 };
    const expectedZh = { dot: 'danger', kindWord: '已阻断', reason: '至少一端未认可对方身份，连接已阻断', latency: '—' };
    assert.deepEqual(derivePeerConnRow(tZh, self, other, linksOf(blockedFwd)), expectedZh);
    assert.equal(derivePeerConnRow(tEn, self, other, linksOf(blockedFwd)).kindWord, 'Blocked');
    assert.equal(derivePeerConnRow(tEn, self, other, linksOf(blockedFwd)).latency, '—');
  });

  test('阻断行的延迟一律 —：链路带着旧 RTT 也不冒充当前阻断路径延迟', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    const blockedStale = { srcNodeId: 'self', peerNodeId: 'other', path: 'blocked', rttMs: 42, liveRelayKbps: 0 };
    assert.equal(derivePeerConnRow(tZh, self, other, linksOf(blockedStale)).latency, '—');
    // 反向登记的 blocked 同样算数（findLink 式只看本机自报会漏掉「对方阻断了我」）
    const blockedBack = { srcNodeId: 'other', peerNodeId: 'self', path: 'blocked', rttMs: null, liveRelayKbps: 0 };
    assert.equal(derivePeerConnRow(tZh, self, other, linksOf(blockedBack)).dot, 'danger');
    assert.equal(derivePeerConnRow(tZh, self, other, linksOf(blockedBack)).kindWord, '已阻断');
  });

  test('单向 blocked + 反向 p2p 正常：不能被「优选直连」合并掩盖，阻断优先呈现', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    const blockedFwd = { srcNodeId: 'self', peerNodeId: 'other', path: 'blocked', rttMs: null, liveRelayKbps: 0 };
    const p2pBack = { srcNodeId: 'other', peerNodeId: 'self', path: 'p2p', rttMs: 5, liveRelayKbps: 0 };
    const row = derivePeerConnRow(tZh, self, other, linksOf(blockedFwd, p2pBack));
    assert.deepEqual(row, { dot: 'danger', kindWord: '已阻断', reason: '至少一端未认可对方身份，连接已阻断', latency: '—' });
    // 反向的 p2p 观测不冒充阻断行的延迟（正常方向事实保留在数据里，不臆造双向正常）
    assert.notEqual(row.latency, '5 ms');
    // 方向互换：blocked 在反向、p2p 在正向，同样阻断优先
    const rowFlipped = derivePeerConnRow(tZh, self, other, linksOf(p2pBack, blockedFwd));
    assert.equal(rowFlipped.dot, 'danger');
    assert.equal(rowFlipped.kindWord, '已阻断');
  });

  test('未知路径（白名单外）→ muted「未知」行，不伪装 relay/直连，延迟 —', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    const weird = { srcNodeId: 'self', peerNodeId: 'other', path: 'future-path', rttMs: 7, liveRelayKbps: 0 };
    const expectedZh = { dot: 'muted', kindWord: '未知', reason: '上报了无法识别的连接方式，暂时无法判定', latency: '—' };
    assert.deepEqual(derivePeerConnRow(tZh, self, other, linksOf(weird)), expectedZh);
    assert.equal(derivePeerConnRow(tEn, self, other, linksOf(weird)).kindWord, 'Unknown');
  });

  test('DB mismatch（成员状态身份异常）仍优先于链路 blocked，文案不变', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    const blockedFwd = { srcNodeId: 'self', peerNodeId: 'other', path: 'blocked', rttMs: null, liveRelayKbps: 0 };
    const expected = { dot: 'danger', kindWord: '已阻断', reason: '身份异常，连接已阻断', latency: '—' };
    assert.deepEqual(derivePeerConnRow(tZh, { ...self, status: 'mismatch' }, other, linksOf(blockedFwd)), expected);
    assert.deepEqual(derivePeerConnRow(tZh, self, { ...other, status: 'mismatch' }, linksOf(blockedFwd)), expected);
  });

  test('正常呈现保持：lan 实测 0 显示 0 ms，relay（rttMs null）显示 —，负延迟视作未知', () => {
    const self = makeMember('self', 'authorized');
    const other = makeMember('other', 'authorized');
    const lan0 = { srcNodeId: 'self', peerNodeId: 'other', path: 'lan', rttMs: 0, liveRelayKbps: 0 };
    const rowLan = derivePeerConnRow(tZh, self, other, linksOf(lan0));
    assert.deepEqual(rowLan, { dot: 'ok', kindWord: '局域网直连', reason: '在同一个局域网内', latency: '0 ms' });
    const relayNull = { srcNodeId: 'self', peerNodeId: 'other', path: 'relay', rttMs: null, liveRelayKbps: 8 };
    const rowRelay = derivePeerConnRow(tZh, self, other, linksOf(relayNull));
    assert.equal(rowRelay.dot, 'warn');
    assert.equal(rowRelay.kindWord, '经网关中转');
    assert.equal(rowRelay.latency, '—');
    const junkRtt = { srcNodeId: 'self', peerNodeId: 'other', path: 'lan', rttMs: -3, liveRelayKbps: 0 };
    assert.equal(derivePeerConnRow(tZh, self, other, linksOf(junkRtt)).latency, '—', '契约外 junk 值按未知处理，不当 0');
  });
});

describe('PC-16b：新增双语词条', () => {
  test('阻断原因 / 未知路径 / 阻断计数词条中英成对', () => {
    assert.equal(LOCALES.zh['device.reasonNodeBlocked'], '至少一端未认可对方身份，连接已阻断');
    assert.equal(LOCALES.en['device.reasonNodeBlocked'], 'At least one end rejected the other\u2019s identity; connection blocked');
    assert.equal(LOCALES.zh['path.unknown'], '未知');
    assert.equal(LOCALES.en['path.unknown'], 'Unknown');
    assert.equal(LOCALES.zh['device.reasonUnknownPath'], '上报了无法识别的连接方式，暂时无法判定');
    assert.equal(LOCALES.en['device.reasonUnknownPath'], 'The device reported an unrecognized connection type; cannot classify it yet');
    assert.equal(translate('zh', 'devices.blockedCount', { n: 2 }), '阻断 2');
    assert.equal(translate('en', 'devices.blockedCount', { n: 2 }), 'Blocked 2');
  });
});

describe('PG-6c 新增双语词条', () => {
  test('席位计数改为 占席位数 / 上限（{count} / {max}）', () => {
    assert.equal(LOCALES.zh['network.deviceCount'], '{count} / {max} 台设备');
    assert.equal(LOCALES.en['network.deviceCount'], '{count} / {max} devices');
    assert.equal(LOCALES.en['network.capacityFull'], '· Full');
    assert.equal(translate('zh', 'network.deviceCount', { count: 2, max: 8 }), '2 / 8 台设备');
  });

  test('设备间连接固定原因词条（中英对照）', () => {
    assert.equal(LOCALES.zh['device.reasonMismatchBlocked'], '身份异常，连接已阻断');
    assert.equal(LOCALES.en['device.reasonMismatchBlocked'], 'Identity changed, connection blocked');
    assert.equal(LOCALES.zh['device.reasonPeerPaused'], '对方已暂停');
    assert.equal(LOCALES.en['device.reasonPeerPaused'], 'The other device is paused');
    assert.equal(LOCALES.zh['device.reasonRelaySelf'], '这台设备的网络不支持直连，已自动中转 · {rate}');
    assert.equal(LOCALES.zh['device.reasonRelayPeer'], '对方网络不支持直连，已自动中转 · {rate}');
  });

  test('设备列表引导、空态、危险区说明与管理页停用标记词条', () => {
    assert.equal(LOCALES.zh['devices.clickHint'], '点击设备，查看它和其他设备怎么连接');
    assert.equal(LOCALES.zh['devices.empty'], '还没有设备加入');
    assert.equal(LOCALES.zh['devices.emptyBody'], '在装了 dsh-zen-remote 的电脑上，把角色设为「节点端」，粘贴上面的邀请链接。');
    assert.equal(LOCALES.zh['network.rotateHint'], '旧链接立即失效，已加入的设备不受影响');
    assert.equal(LOCALES.zh['network.deleteHint'], '所有设备会立即断开，无法恢复');
    assert.equal(LOCALES.zh['admin.disabledTag'], '已停用');
    assert.equal(LOCALES.en['admin.disabledTag'], 'Disabled');
    assert.equal(LOCALES.en['devices.clickHint'], 'Click a device to see how it connects to others');
  });
});

describe('clipboard：非安全上下文 HTTP 剪贴板回退（回归修复）', () => {
  function makeMockDoc(execResult = true) {
    const appended = [];
    const removed = [];
    let restoredFocus = false;
    let copiedValue = null;
    const doc = {
      activeElement: {
        focus() {
          restoredFocus = true;
        },
      },
      body: {
        appendChild(node) {
          appended.push(node);
          return node;
        },
        removeChild(node) {
          removed.push(node);
          return node;
        },
      },
      createElement(tag) {
        assert.equal(tag, 'textarea');
        return {
          value: '',
          readOnly: false,
          style: { position: '', top: '', left: '', opacity: '', pointerEvents: '' },
          setAttribute() {},
          focus() {},
          select() {
            copiedValue = this.value;
          },
          setSelectionRange() {},
        };
      },
      execCommand(cmd) {
        assert.equal(cmd, 'copy');
        return execResult;
      },
    };
    return { doc, getCopied: () => copiedValue, appended, removed, isFocusRestored: () => restoredFocus };
  }

  test('HTTP 部署下 navigator.clipboard 为 undefined 时，不抛 TypeError 并自动走 execCommand("copy")', async () => {
    const mock = makeMockDoc(true);
    const ok = await copyTextToClipboard('zr-net://203.0.113.10:19393/0123456789abcdef?tls=0#secret', {
      navigator: {}, // 非安全上下文：navigator.clipboard === undefined
      document: mock.doc,
    });
    assert.equal(ok, true);
    assert.equal(mock.getCopied(), 'zr-net://203.0.113.10:19393/0123456789abcdef?tls=0#secret');
    assert.equal(mock.appended.length, 1);
    assert.equal(mock.removed.length, 1);
    assert.equal(mock.isFocusRestored(), true);
  });

  test('标准 navigator.clipboard.writeText 被权限拒绝时，继续回落 execCommand("copy")', async () => {
    const mock = makeMockDoc(true);
    const ok = await copyTextToClipboard('zr-net://127.0.0.1:19393/0123456789abcdef#k', {
      navigator: {
        clipboard: {
          async writeText() {
            throw new Error('NotAllowedError');
          },
        },
      },
      document: mock.doc,
    });
    assert.equal(ok, true);
    assert.equal(mock.getCopied(), 'zr-net://127.0.0.1:19393/0123456789abcdef#k');
  });

  test('标准 API 与 DOM 均不可用时返回 false，绝不抛未捕获异常', async () => {
    const ok = await copyTextToClipboard('test', { navigator: {} });
    assert.equal(ok, false);
  });
});

// ---------------------------------------------------------------- PC-20：顶栏 SSE 计数派生与管理页刷新循环

describe('PC-20：顶栏计数沿当前网络 SSE 快照派生', () => {
  test('快照在场按快照口径计数（占席=authorized+paused+mismatch）；无快照或串网快照回落 REST 值', () => {
    const netA = 'a'.repeat(16);
    const view = makeNetworkView(netA, '家里', { onlineDevices: 1, totalDevices: 3, pendingCount: 0 });
    // 未订阅/未首推：保持 REST 拉到的值（没订阅的网络不假称实时）
    assert.deepEqual(deriveNetworkCounts(view, undefined), { totalDevices: 3, onlineDevices: 1, pendingCount: 0 });

    const snap = makeSnapshot(netA, {
      summary: { onlineDevices: 2, pendingCount: 1, totalLiveRelayKbps: 4 },
      members: [
        makeMember('m1', 'authorized'),
        makeMember('m2', 'paused', { online: false }),
        makeMember('m3', 'mismatch', { online: false }),
        makeMember('m4', 'pending'),
        makeMember('m5', 'revoked', { online: false }),
      ],
    });
    // 与 REST NetworkView 字段同口径：占席 3（pending/revoked 不占席）、在线 2、待审批 1
    assert.deepEqual(deriveNetworkCounts(view, snap), { totalDevices: 3, onlineDevices: 2, pendingCount: 1 });

    // 串网防护：别的网络的快照塞给本网视图 → 不采信，回落 REST
    const snapB = makeSnapshot('b'.repeat(16), {
      summary: { onlineDevices: 99, pendingCount: 99, totalLiveRelayKbps: 0 },
      members: [],
    });
    assert.deepEqual(deriveNetworkCounts(view, snapB), { totalDevices: 3, onlineDevices: 1, pendingCount: 0 });
  });

  test('切网后旧流迟到：旧网快照只进旧网切片，新网的派生计数不被串改', () => {
    const netA = 'a'.repeat(16);
    const netB = 'b'.repeat(16);
    let state = applyNetworks(createInitialState(), [makeNetworkView(netA, '家里'), makeNetworkView(netB, '办公室')]);
    state = applyTopologySnapshot(state, makeSnapshot(netA));
    const snapB = makeSnapshot(netB, { summary: { onlineDevices: 5, pendingCount: 0, totalLiveRelayKbps: 0 }, members: [] });
    state = applyTopologySnapshot(state, snapB);
    const viewB = state.networks.find((n) => n.id === netB);
    const beforeB = deriveNetworkCounts(viewB, state.topology[netB]);
    assert.deepEqual(beforeB, { totalDevices: 0, onlineDevices: 5, pendingCount: 0 });

    // 已切到 B 后 A 的旧事件迟到：只改 A 自己的切片
    const lateA = makeSnapshot(netA, { summary: { onlineDevices: 42, pendingCount: 42, totalLiveRelayKbps: 0 } });
    const next = applyTopologySnapshot(state, lateA);
    assert.equal(next.topology[netB], snapB, 'B 的切片引用不变');
    assert.deepEqual(
      deriveNetworkCounts(next.networks.find((n) => n.id === netB), next.topology[netB]),
      beforeB,
      'B 的顶栏派生计数不被旧网迟到事件串改',
    );
    assert.equal(
      deriveNetworkCounts(next.networks.find((n) => n.id === netA), next.topology[netA]).onlineDevices,
      42,
      'A 的事实照常进 A 自己的切片',
    );
  });
});

describe('PC-20 fix1：管理页刷新循环（固定节拍、在途取消）', () => {
  /** 假定时器：固定节拍用原生 interval 语义，记录注册、手动触发；cancel 即摘除 */
  function fakeRefreshTimers() {
    const intervals = new Map();
    let nextHandle = 1;
    return {
      interval(handler, ms) {
        const handle = nextHandle;
        nextHandle += 1;
        intervals.set(handle, { handler, ms });
        return handle;
      },
      cancel(handle) {
        intervals.delete(handle);
      },
      get intervalCount() {
        return intervals.size;
      },
      soleIntervalMs() {
        assert.equal(intervals.size, 1, `应恰好一张挂起 interval，实际 ${intervals.size}`);
        return [...intervals.values()][0].ms;
      },
      fireInterval() {
        assert.equal(intervals.size, 1, `应恰好一张挂起 interval，实际 ${intervals.size}`);
        [...intervals.values()][0].handler();
      },
    };
  }

  /** 放完所有挂起的微任务，让挂起拍的后半段（isCurrent 核对 / settle）跑完 */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test('start 立即拉一次并注册固定 3s interval；收拍不排下一拍（固定格点驱动）；忙碌格点跳过不叠加；stop 清 interval', async () => {
    const timers = fakeRefreshTimers();
    const tickets = [];
    let releaseFirst;
    const cycle = new ManagedRefreshCycle({
      intervalMs: 3000,
      timers,
      load: async (ticket) => {
        tickets.push(ticket);
        if (tickets.length === 1) await new Promise((resolve) => { releaseFirst = resolve; }); // 首拍挂起，模拟 2s 慢响应
        ticket.settle();
      },
    });

    cycle.start();
    assert.equal(tickets.length, 1, 'start 立即拉一次');
    assert.equal(timers.intervalCount, 1, '整个运行期恰好一张 interval');
    assert.equal(timers.soleIntervalMs(), 3000);
    cycle.start();
    assert.equal(tickets.length, 1, '已在跑的循环重复 start 不叠加立即拍');

    // 首拍挂起期间的第 3 秒格点：忙碌跳过，不叠加请求
    timers.fireInterval();
    assert.equal(tickets.length, 1, '在途未收拍时格点拍必须跳过（慢响应不叠加）');

    // 慢响应收拍：不得触发下一拍——固定 3s 格点是唯一驱动（fix1 R3）
    releaseFirst();
    await flush();
    assert.equal(tickets.length, 1, '收拍不得立刻排下一拍（否则节拍变成 响应耗时+3s）');
    assert.equal(timers.intervalCount, 1, '收拍不得重排/新增 interval');

    // 下一个 3s 格点照常起拍：节拍不因响应耗时漂移
    timers.fireInterval();
    assert.equal(tickets.length, 2, '下一格点起拍');
    assert.equal(tickets[1].signal.aborted, false, '新拍的取消信号未触发');

    cycle.stop();
    assert.equal(timers.intervalCount, 0, 'stop 清掉 interval');
  });

  test('stop abort 在途 signal、其迟到结果不落库；重开新信号立即拍；反复停开不累积活动请求', async () => {
    const timers = fakeRefreshTimers();
    const tickets = [];
    const applied = [];
    const gates = [];
    const cycle = new ManagedRefreshCycle({
      intervalMs: 3000,
      timers,
      load: async (ticket) => {
        tickets.push(ticket);
        if (gates.length > 0) await new Promise((resolve) => gates.shift()(resolve));
        if (ticket.isCurrent()) applied.push(tickets.length);
        ticket.settled = true; // 测试标记：settle 过的拍不再「在途」
        ticket.settle();
      },
    });

    // 第一拍挂起
    let releaseFirst;
    gates.push((resolve) => {
      releaseFirst = resolve;
    });
    cycle.start();
    assert.equal(tickets[0].signal.aborted, false, '运行中的拍不该被取消');

    // stop：清 interval + abort 在途请求（fix1 R2：只作废结果不够，旧请求不能永久留在后台）
    cycle.stop();
    assert.equal(tickets[0].signal.aborted, true, 'stop 必须 abort 在途请求');
    assert.equal(timers.intervalCount, 0, 'stop 清掉 interval');

    // 被取消拍若仍迟到（不可取消的底层兜底场景）：世代守卫挡住，不落库
    releaseFirst();
    await flush();
    assert.deepEqual(applied, [], '被取消世代的迟到结果不得落库');

    // 重开：立即新拍、新 signal 未取消
    cycle.start();
    assert.equal(tickets.length, 2, '重开立即拉新的一拍');
    assert.equal(timers.intervalCount, 1, '重开重新注册 interval');
    assert.equal(tickets[1].signal.aborted, false, '新世代用新 signal');
    assert.deepEqual(applied, [2], '新世代结果落库');

    // 反复停开：旧信号全部 aborted，任意时刻至多一个未取消的活动请求
    let releaseThird;
    gates.push((resolve) => {
      releaseThird = resolve;
    });
    timers.fireInterval();
    assert.equal(tickets.length, 3, '格点拍拉第三拍');
    cycle.stop();
    cycle.start();
    assert.equal(tickets.length, 4, '旧世代在途不挡新一代立即拍');
    assert.equal(tickets[2].signal.aborted, true, '第三拍被 stop 取消');
    assert.equal(tickets[3].signal.aborted, false);
    releaseThird();
    await flush();
    assert.deepEqual(applied, [2, 4], '第三拍（旧世代）不落库，第四拍（当前世代）落库');
    // R2 累积防护：被 stop 终止的世代其在途 signal 都已 abort（底层请求会被取消，
    // 不永久留在后台）；不存在既未收拍又未取消的悬挂请求
    assert.equal(tickets[0].signal.aborted, true, '第一拍被第一次 stop 取消');
    assert.equal(tickets[2].signal.aborted, true, '第三拍被第二次 stop 取消');
    assert.deepEqual(tickets.filter((t) => !t.settled && !t.signal.aborted), [], '不得存在既未收拍又未取消的悬挂请求');
    cycle.stop();
    // 第四拍已在 start#3 同步收拍（无东西可取消，signal 保持未取消是正确行为）；
    // 在途拍被 stop 取消已由第一/第三拍断言覆盖
    assert.deepEqual(tickets.filter((t) => !t.settled && !t.signal.aborted), [], '收尾后无悬挂请求');
  });
});

describe('PC-20 fix1：ConsoleClient 把 AbortSignal 透传给底层 fetch', () => {
  test('adminListUsers(signal) 原样透传；不传时保持旧行为', async () => {
    const { calls, impl } = fakeFetch(() => jsonEnvelope(200, { ok: true, data: [] }));
    const client = new ConsoleClient({ fetchImpl: impl });
    const controller = new AbortController();

    await client.adminListUsers(controller.signal);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/v1/admin/users');
    assert.equal(calls[0].init.signal, controller.signal, 'signal 必须原样传给底层 fetch（停表时真取消）');

    await client.adminListUsers();
    assert.equal(calls[1].init.signal, undefined, '不传 signal 保持旧行为');
  });
});

describe('PS-4b：NetworkView 分项快速复制（网关地址 / 网络 ID / 入网口令）', () => {
  test('渐进披露 <details className="invite-parts"> 不在 DOM 中明文展示 joinKey，并处理 manual 与无网关地址态', () => {
    const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = fs.readFileSync(path.join(pkgDir, 'src/web/components/NetworkView.tsx'), 'utf8');
    assert.match(source, /<details className="invite-parts">/, '必须包含原生渐进披露细节区');
    assert.ok(source.includes('{network.gatewayUrl || \'—\'}'), '网关地址行使用后端返回的 gatewayUrl');
    assert.ok(source.includes('{network.id}'), '网络 ID 行展示 network.id');
    assert.ok(source.includes('••••••••••••'), '入网口令行必须只显示打码圆点');
    assert.ok(!source.includes('>{network.joinKey}<'), '不得把明文 joinKey 渲染进可见 DOM 文本');
    assert.ok(source.includes("network.admissionMode === 'manual'"), '手动审批模式需隐去无用口令复制按钮');
    assert.ok(
      source.includes("onCopyField?.(network.joinKey, 'toast.joinPassphraseCopied')"),
      '点击口令复制按钮时交由回调复制完整 joinKey 并弹独立提示',
    );
  });
});

// ---------------------------------------------------------------- GC-7b：配额格式化与用量档位

describe('GC-7b：formatBytesQuota 配额字节', () => {
  test('null（不限额）→ 固定双语「不限 / Unlimited」，不随 locale 变', () => {
    assert.equal(formatBytesQuota(null, 'zh'), '不限 / Unlimited');
    assert.equal(formatBytesQuota(null, 'en'), '不限 / Unlimited');
  });

  test('0 与契约外垃圾值（负数 / NaN）→ 0 KB，绝不出 B 档或负数', () => {
    assert.equal(formatBytesQuota(0, 'zh'), '0 KB');
    assert.equal(formatBytesQuota(-5, 'zh'), '0 KB');
    assert.equal(formatBytesQuota(Number.NaN, 'en'), '0 KB');
  });

  test('整数字节按 KB / MB / GB / TB 升单位，不足 1 KB 显示 <1 KB', () => {
    assert.equal(formatBytesQuota(512, 'zh'), '<1 KB');
    assert.equal(formatBytesQuota(1024, 'zh'), '1 KB');
    assert.equal(formatBytesQuota(2048, 'zh'), '2 KB');
    assert.equal(formatBytesQuota(1024 * 1024 * 1.5, 'zh'), '1.5 MB');
    assert.equal(formatBytesQuota(100 * 1024 * 1024, 'zh'), '100 MB');
    assert.equal(formatBytesQuota(1024 * 1024 * 1024 * 1.5, 'zh'), '1.5 GB');
    assert.equal(formatBytesQuota(1024 ** 4, 'zh'), '1 TB');
    assert.equal(formatBytesQuota(1024 ** 4 * 2.5, 'zh'), '2.5 TB');
  });

  test('数字与单位刻意语言无关：zh / en 输出一致', () => {
    assert.equal(formatBytesQuota(2048, 'zh'), formatBytesQuota(2048, 'en'));
    assert.equal(formatBytesQuota(1024 ** 4 * 2.5, 'en'), '2.5 TB');
  });
});

describe('GC-7b：computeUsagePercent 钳位百分比', () => {
  test('0 / 80% / 100% / 超限钳位', () => {
    assert.equal(computeUsagePercent(0, 100), 0);
    assert.equal(computeUsagePercent(80, 100), 80);
    assert.equal(computeUsagePercent(8, 10), 80, '浮点毛刺被一位小数四舍五入吸收');
    assert.equal(computeUsagePercent(100, 100), 100);
    assert.equal(computeUsagePercent(150, 100), 100, '超限钳位到 100，超限事实由 isQuotaExceeded 表达');
    assert.equal(computeUsagePercent(24, 25), 96);
  });

  test('null 上限（不限额）或 limit <= 0 → null，调用方据此不渲染进度条', () => {
    assert.equal(computeUsagePercent(50, null), null);
    assert.equal(computeUsagePercent(0, null), null);
    assert.equal(computeUsagePercent(50, 0), null);
    assert.equal(computeUsagePercent(50, -1), null);
  });

  test('用量侧垃圾值（负数 / NaN）按 0 处理，不产生负百分比', () => {
    assert.equal(computeUsagePercent(-5, 100), 0);
    assert.equal(computeUsagePercent(Number.NaN, 100), 0);
  });
});

describe('GC-7b：quotaUsageLevel / isQuotaExceeded', () => {
  test('进度条档位阈值：>=100% danger、>=80% warn、否则 ok', () => {
    assert.equal(quotaUsageLevel(0, 100), 'ok');
    assert.equal(quotaUsageLevel(79, 100), 'ok');
    assert.equal(quotaUsageLevel(80, 100), 'warn');
    assert.equal(quotaUsageLevel(99, 100), 'warn');
    assert.equal(quotaUsageLevel(100, 100), 'danger');
    assert.equal(quotaUsageLevel(500, 100), 'danger');
  });

  test('不限额（null）或无效上限永远 ok——不限额没有「快用完」', () => {
    assert.equal(quotaUsageLevel(999, null), 'ok');
    assert.equal(quotaUsageLevel(999, 0), 'ok');
    assert.equal(quotaUsageLevel(999, -1), 'ok');
  });

  test('超限判定与钳位分工：percent 封顶 100，exceeded 独立报真', () => {
    assert.equal(isQuotaExceeded(99, 100), false);
    assert.equal(isQuotaExceeded(100, 100), true);
    assert.equal(isQuotaExceeded(150, 100), true);
    assert.equal(isQuotaExceeded(150, null), false, '不限额永不超限');
    assert.equal(isQuotaExceeded(150, 0), false, '无效上限不算超限');
  });
});

describe('GC-7b：formatQuotaExpiry 配额到期展示', () => {
  const future = '2026-06-01T00:00:00.000Z';
  const before = Date.parse('2026-01-15T00:00:00.000Z');
  const after = Date.parse('2026-07-01T00:00:00.000Z');

  test('null → 长期有效 / No expiry（按 locale 取词）', () => {
    assert.equal(formatQuotaExpiry(null, 'zh', before), '长期有效');
    assert.equal(formatQuotaExpiry(null, 'en', before), 'No expiry');
  });

  test('未到期 → UTC 年月日；到期（含同刻）→ 尾缀到期标记', () => {
    assert.equal(formatQuotaExpiry(future, 'zh', before), '2026-06-01');
    assert.equal(formatQuotaExpiry(future, 'en', before), '2026-06-01');
    assert.equal(formatQuotaExpiry(future, 'zh', after), '2026-06-01（已到期）');
    assert.equal(formatQuotaExpiry(future, 'en', after), '2026-06-01 (expired)');
    assert.equal(formatQuotaExpiry(future, 'zh', Date.parse(future)), '2026-06-01（已到期）', '到期当刻即算已到期');
  });

  test('无法解析的 ISO → —，绝不抛错或显示 Invalid Date', () => {
    assert.equal(formatQuotaExpiry('not-a-date', 'zh', before), '—');
  });
});

// ---------------------------------------------------------------- GC-7b：邀请链接掩码（?tls 契约）与无头命令

describe('GC-7b：maskInviteUri 保留统一链接查询串', () => {
  test('?tls=0|1 查询串在 # 之前原样保留，# 之后掩码', () => {
    assert.equal(
      maskInviteUri('zr-net://gw.local:19393/0123456789abcdef?tls=0#secret'),
      'zr-net://gw.local:19393/0123456789abcdef?tls=0#••••••••',
    );
    assert.equal(
      maskInviteUri('zr-net://gw.local:19393/0123456789abcdef?tls=1#secret'),
      'zr-net://gw.local:19393/0123456789abcdef?tls=1#••••••••',
    );
  });

  test('老格式输入（无 ?tls、口令里还有 #）依旧只认第一个 #', () => {
    assert.equal(maskInviteUri('zr-net://gw.local/0123456789abcdef#a#b'), 'zr-net://gw.local/0123456789abcdef#••••••••');
    assert.equal(maskInviteUri('zr-net://203.0.113.10:19393/netid?tls=0#a#b'), 'zr-net://203.0.113.10:19393/netid?tls=0#••••••••');
  });
});

describe('GC-7b：buildHeadlessJoinCommand 无头接入命令', () => {
  test('普通统一链接原样包进双引号', () => {
    assert.equal(
      buildHeadlessJoinCommand('zr-net://gw.local:19393/0123456789abcdef?tls=0#secret'),
      'dsh-zen-remote setup --role peer --invite "zr-net://gw.local:19393/0123456789abcdef?tls=0#secret"',
    );
  });

  test('双引号 / 反斜杠 / $ / 反引号统一前置反斜杠转义，命令不被截断或展开', () => {
    assert.equal(
      buildHeadlessJoinCommand('zr-net://gw.local/n#se"cret'),
      'dsh-zen-remote setup --role peer --invite "zr-net://gw.local/n#se\\"cret"',
    );
    assert.equal(
      buildHeadlessJoinCommand('zr-net://gw.local/n#x$y`z'),
      'dsh-zen-remote setup --role peer --invite "zr-net://gw.local/n#x\\$y\\`z"',
    );
    assert.equal(
      buildHeadlessJoinCommand('zr-net://gw.local/n#a\\b'),
      'dsh-zen-remote setup --role peer --invite "zr-net://gw.local/n#a\\\\b"',
    );
  });
});

// ---------------------------------------------------------------- GC-7b：locales 错误码与管理文案完整性

describe('GC-7b：GC-5/GC-6 新错误码与管理文案键完整性', () => {
  const errorCodeKeys = [
    'error.otpCooldown',
    'error.otpInvalid',
    'error.otpLocked',
    'error.rateLimited',
    'error.smtpNotConfigured',
    'error.smtpSendFailed',
    'error.currentPasswordWrong',
    'error.noteTooLong',
    'error.peerLimitByGroup',
    'error.cannotRemoveLastAdmin',
    'error.cannotDeleteDefaultGroup',
    'error.groupInUse',
    'error.duplicateGroupCode',
    'error.invalidApiKey',
  ];

  const adminCopyKeys = [
    'admin.tabUsers',
    'admin.tabGroups',
    'admin.tabSettings',
    'admin.runtimeTcpPort',
    'admin.runtimeStorage',
    'admin.runtimeMasterKey',
    'admin.advisoryTitle',
    'admin.newUser',
    'admin.emailVerified',
    'admin.columnGroup',
    'admin.columnExpiry',
    'admin.columnMonthlyTraffic',
    'admin.newGroup',
    'admin.groupName',
    'admin.groupCode',
    'admin.isDefaultGroup',
    'admin.groupPeerCap',
    'admin.monthlyQuotaGb',
    'admin.quotaThrottleNote',
    'admin.publicUrl',
    'admin.requireEmailVerification',
    'admin.sessionTtlDays',
    'admin.smtpTitle',
    'admin.smtpHost',
    'admin.smtpTestSend',
    'admin.apiKeyTitle',
    'admin.apiKeyOnce',
    'admin.apiKeyPrefixLabel',
    'network.partHeadlessCommand',
    'network.headlessCommandHint',
    'accountSettings.title',
    'accountSettings.monthlyTraffic',
    'common.unlimited',
    'common.usedOfLimit',
  ];

  test('错误码键中英齐备且都能取词（删键会被钉住）', () => {
    for (const key of errorCodeKeys) {
      assert.ok(key in LOCALES.zh, `zh 缺少 ${key}`);
      assert.ok(key in LOCALES.en, `en 缺少 ${key}`);
      assert.ok(translate('zh', key).length > 0);
      assert.ok(translate('en', key).length > 0);
    }
  });

  test('管理三标签页 / 运行态 / 设置页关键文案键中英齐备', () => {
    for (const key of adminCopyKeys) {
      assert.ok(key in LOCALES.zh, `zh 缺少 ${key}`);
      assert.ok(key in LOCALES.en, `en 缺少 ${key}`);
      assert.ok(LOCALES.zh[key].length > 0);
      assert.ok(LOCALES.en[key].length > 0);
    }
  });

  test('带插值的错误/提示词条取词正常', () => {
    assert.equal(translate('zh', 'admin.smtpTestFailed', { message: '超时' }), '发送失败：超时');
    assert.equal(translate('zh', 'common.usedOfLimit', { used: 2, limit: 3 }), '已用 2 / 3');
    assert.equal(translate('en', 'common.usedOfLimit', { used: 2, limit: 3 }), 'Used 2 / 3');
  });
});

// ---------------------------------------------------------------- GC-7b：ConsoleClient 新方法契约

describe('GC-7b：ConsoleClient 认证自助方法（路径 / 方法 / 体）', () => {
  test('sendOtp：POST /auth/send-otp，邮箱归一化，purpose 与 locale 透传', async () => {
    const data = { sent: true, cooldownSec: 60 };
    const { calls, impl } = fakeFetch(() => jsonEnvelope(200, { ok: true, data }));
    const client = new ConsoleClient({ fetchImpl: impl });

    const result = await client.sendOtp({ email: ' Owner@Local ', purpose: 'signup', locale: 'en' });
    assert.deepEqual(result, data);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/v1/auth/send-otp');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'owner@local', purpose: 'signup', locale: 'en' });

    await client.sendOtp({ email: 'a@b.c', purpose: 'reset_password' });
    assert.deepEqual(JSON.parse(calls[1].init.body), { email: 'a@b.c', purpose: 'reset_password' }, 'locale 省略时不占键');
  });

  test('signup：带 otpCode 与不带两种形态；返回完整 SessionPayload 信封数据', async () => {
    const data = {
      user: { ...TEST_USER, emailVerifiedAt: null },
      quota: makeQuota(),
      allowSignup: true,
      requireEmailVerification: true,
      smtpConfigured: true,
      maxNetworksPerUser: 3,
      defaultMaxPeers: 8,
    };
    const { calls, impl } = fakeFetch(() => jsonEnvelope(200, { ok: true, data }));
    const client = new ConsoleClient({ fetchImpl: impl });

    const withOtp = await client.signup('Owner@Local ', 'pw123456', '123456');
    assert.deepEqual(withOtp, data);
    assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'owner@local', password: 'pw123456', otpCode: '123456' });

    const withoutOtp = await client.signup('owner@local', 'pw123456');
    assert.deepEqual(withoutOtp, data);
    const body = JSON.parse(calls[1].init.body);
    assert.equal('otpCode' in body, false, '未传验证码时不得发空 otpCode 键');
  });

  test('resetPassword / changeMyPassword：路径与体逐字段核对', async () => {
    const { calls, impl } = fakeFetch(() => jsonEnvelope(200, { ok: true, data: { reset: true } }));
    const client = new ConsoleClient({ fetchImpl: impl });

    await client.resetPassword({ email: ' Owner@Local ', otpCode: '654321', newPassword: 'newpass123' });
    assert.equal(calls[0].url, '/api/v1/auth/reset-password');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'owner@local', otpCode: '654321', newPassword: 'newpass123' });

    await client.changeMyPassword({ currentPassword: 'old-pass-1', newPassword: 'newpass123' });
    assert.equal(calls[1].url, '/api/v1/auth/account/password');
    assert.equal(calls[1].init.method, 'PATCH');
    assert.deepEqual(JSON.parse(calls[1].init.body), { currentPassword: 'old-pass-1', newPassword: 'newpass123' });
  });

  test('换绑邮箱两步：request 返回 otpRequired 形态；confirm 未传 otpCode 不占键', async () => {
    const { calls, impl } = fakeFetch((url) =>
      jsonEnvelope(200, {
        ok: true,
        data: url === '/api/v1/auth/account/email/request' ? { otpRequired: false, cooldownSec: 0 } : { user: { ...TEST_USER, emailVerifiedAt: null } },
      }),
    );
    const client = new ConsoleClient({ fetchImpl: impl });

    const requested = await client.requestEmailChange({ currentPassword: 'pw123456', newEmail: ' New@Local ', locale: 'zh' });
    assert.deepEqual(requested, { otpRequired: false, cooldownSec: 0 }, 'SMTP 未配置时后端放行直改');
    assert.equal(calls[0].url, '/api/v1/auth/account/email/request');
    assert.deepEqual(JSON.parse(calls[0].init.body), { currentPassword: 'pw123456', newEmail: 'new@local', locale: 'zh' });

    await client.confirmEmailChange({ currentPassword: 'pw123456', newEmail: 'new@local' });
    assert.equal(calls[1].url, '/api/v1/auth/account/email');
    const body = JSON.parse(calls[1].init.body);
    assert.equal('otpCode' in body, false, 'SMTP 未配置路径不发验证码键');
  });
});

describe('GC-7b：ConsoleClient 管理 API 方法（路径 / 方法 / 体）', () => {
  test('运行态与设置：GET /admin/runtime、GET/PATCH /admin/settings', async () => {
    const settings = makeAdminSettings({ publicUrl: 'https://gw.example.com' });
    const { calls, impl } = fakeFetch((url) =>
      jsonEnvelope(200, { ok: true, data: url === '/api/v1/admin/runtime' ? makeRuntimeStatus() : settings }),
    );
    const client = new ConsoleClient({ fetchImpl: impl });

    const runtime = await client.getAdminRuntime();
    assert.deepEqual(runtime, makeRuntimeStatus());
    assert.equal(calls[0].url, '/api/v1/admin/runtime');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.body, undefined);

    const got = await client.getAdminSettings();
    assert.deepEqual(got, settings);
    assert.equal(calls[1].url, '/api/v1/admin/settings');

    const patched = await client.updateAdminSettings({
      allowSignup: false,
      publicUrl: null,
      sessionTtlDays: 30,
      smtp: { host: 'smtp.local', port: 465, security: 'tls', fromAddress: 'from@x.y' },
    });
    assert.deepEqual(patched, settings);
    assert.equal(calls[2].init.method, 'PATCH');
    assert.deepEqual(JSON.parse(calls[2].init.body), {
      allowSignup: false,
      publicUrl: null,
      sessionTtlDays: 30,
      smtp: { host: 'smtp.local', port: 465, security: 'tls', fromAddress: 'from@x.y' },
    });
  });

  test('smtp-test / api-key：测试发信草稿透传；rotate 返回一次性明文', async () => {
    const draft = { host: 'smtp.local', port: 587, security: 'starttls', fromAddress: 'from@x.y' };
    const { calls, impl } = fakeFetch((url) =>
      jsonEnvelope(200, {
        ok: true,
        data:
          url === '/api/v1/admin/settings/api-key'
            ? { apiKey: 'zr_adm_secret', prefix: 'zr_adm_secret', createdAt: '2026-01-01T00:00:00.000Z' }
            : { sent: true },
      }),
    );
    const client = new ConsoleClient({ fetchImpl: impl });

    const sent = await client.sendSmtpTest({ toEmail: 'me@x.y', locale: 'en', smtp: draft });
    assert.deepEqual(sent, { sent: true });
    assert.equal(calls[0].url, '/api/v1/admin/settings/smtp-test');
    assert.deepEqual(JSON.parse(calls[0].init.body), { toEmail: 'me@x.y', locale: 'en', smtp: draft });

    const rotated = await client.rotateAdminApiKey();
    assert.deepEqual(rotated, { apiKey: 'zr_adm_secret', prefix: 'zr_adm_secret', createdAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(calls[1].url, '/api/v1/admin/settings/api-key');
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(calls[1].init.body, undefined);

    await client.revokeAdminApiKey();
    assert.equal(calls[2].init.method, 'DELETE');
    assert.equal(calls[2].init.body, undefined);
  });

  test('用户组 CRUD：list/create/update/delete 路径与方法', async () => {
    const groups = [makeGroup('grp_default', { isDefault: true })];
    const { calls, impl } = fakeFetch((url, init) =>
      jsonEnvelope(200, {
        ok: true,
        data:
          init.method === 'GET'
            ? groups
            : init.method === 'DELETE'
              ? { deleted: true }
              : groups[0],
      }),
    );
    const client = new ConsoleClient({ fetchImpl: impl });

    assert.deepEqual(await client.listGroups(), groups);
    assert.equal(calls[0].url, '/api/v1/admin/groups');

    const created = await client.createGroup({
      code: 'vip',
      name: 'VIP 组',
      maxNetworks: 10,
      maxPeersPerNetwork: 16,
      relayRateKbps: 1024,
      monthlyRelayQuotaBytes: null,
    });
    assert.deepEqual(created, groups[0]);
    assert.equal(calls[1].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      code: 'vip',
      name: 'VIP 组',
      maxNetworks: 10,
      maxPeersPerNetwork: 16,
      relayRateKbps: 1024,
      monthlyRelayQuotaBytes: null,
    });

    await client.updateGroup('g-1', { isDefault: true, monthlyRelayQuotaBytes: 5368709120 });
    assert.equal(calls[2].url, '/api/v1/admin/groups/g-1');
    assert.equal(calls[2].init.method, 'PATCH');
    assert.deepEqual(JSON.parse(calls[2].init.body), { isDefault: true, monthlyRelayQuotaBytes: 5368709120 });

    await client.deleteGroup('g-1');
    assert.equal(calls[3].url, '/api/v1/admin/groups/g-1');
    assert.equal(calls[3].init.method, 'DELETE');
    assert.equal(calls[3].init.body, undefined);
  });

  test('用户管理 CRUD：邮箱归一化、generatedPassword 只在响应出现、id 走路径编码', async () => {
    const row = makeAdminUserRow('u-9');
    const { calls, impl } = fakeFetch((url, init) => {
      let data = [row];
      if (init.method === 'DELETE') data = { deleted: true };
      if (url.endsWith('/reset-password')) data = JSON.parse(init.body).newPassword === undefined ? { reset: true, generatedPassword: 'gen-pass-16' } : { reset: true };
      if (init.method === 'POST' && url === '/api/v1/admin/users') data = { ...row, generatedPassword: 'gen-pass-16' };
      if (init.method === 'PATCH') data = row;
      return jsonEnvelope(200, { ok: true, data });
    });
    const client = new ConsoleClient({ fetchImpl: impl });

    const listed = await client.listAdminUsers();
    assert.deepEqual(listed, [row]);
    assert.equal(calls[0].url, '/api/v1/admin/users');

    const created = await client.createAdminUser({ email: ' New@Local ', role: 'user', groupCode: 'default' });
    assert.equal(created.generatedPassword, 'gen-pass-16');
    assert.deepEqual(JSON.parse(calls[1].init.body), { email: 'new@local', role: 'user', groupCode: 'default' });

    await client.updateAdminUser('u/1', { active: false, groupId: null });
    assert.equal(calls[2].url, '/api/v1/admin/users/u%2F1', '路径 id 必须编码');
    assert.deepEqual(JSON.parse(calls[2].init.body), { active: false, groupId: null });

    await client.deleteAdminUser('u-9');
    assert.equal(calls[3].url, '/api/v1/admin/users/u-9');
    assert.equal(calls[3].init.method, 'DELETE');

    const explicit = await client.resetAdminUserPassword('u-9', 'brandnew123');
    assert.deepEqual(explicit, { reset: true }, '显式密码不返回 generatedPassword');
    assert.deepEqual(JSON.parse(calls[4].init.body), { newPassword: 'brandnew123' });

    const generated = await client.resetAdminUserPassword('u-9');
    assert.deepEqual(generated, { reset: true, generatedPassword: 'gen-pass-16' });
    assert.deepEqual(JSON.parse(calls[5].init.body), {}, '未传密码发空对象，后端按生成路径处理');
  });

  test('AbortSignal 透传：getAdminRuntime / listGroups 与既有 adminListUsers 一致', async () => {
    const { calls, impl } = fakeFetch(() => jsonEnvelope(200, { ok: true, data: [] }));
    const client = new ConsoleClient({ fetchImpl: impl });
    const controller = new AbortController();

    await client.getAdminRuntime(controller.signal);
    assert.equal(calls[0].init.signal, controller.signal);
    await client.listGroups(controller.signal);
    assert.equal(calls[1].init.signal, controller.signal);
    await client.listAdminUsers(controller.signal);
    assert.equal(calls[2].init.signal, controller.signal);
    await client.getAdminSettings();
    assert.equal(calls[3].init.signal, undefined, '不传 signal 保持旧行为');
  });
});

describe('GC-7b：ConsoleClient 新错误码映射', () => {
  async function expectCode(run, status, code) {
    const { impl } = fakeFetch(() => jsonEnvelope(status, { ok: false, error: { code, message: 'boom' } }));
    const client = new ConsoleClient({ fetchImpl: impl });
    await assert.rejects(
      () => run(client),
      (err) => {
        assert.ok(err instanceof ConsoleApiError);
        assert.equal(err.status, status);
        assert.equal(err.code, code);
        return true;
      },
    );
  }

  test('发码限流 / 注册关闭 / API Key 无效 / 测试发信失败 / 原密码错误', async () => {
    await expectCode((c) => c.sendOtp({ email: 'a@b.c', purpose: 'signup' }), 429, 'OTP_COOLDOWN');
    await expectCode((c) => c.signup('a@b.c', 'pw123456'), 403, 'SIGNUP_DISABLED');
    await expectCode((c) => c.getAdminRuntime(), 401, 'INVALID_API_KEY');
    await expectCode((c) => c.sendSmtpTest({ toEmail: 'a@b.c' }), 502, 'SMTP_SEND_FAILED');
    await expectCode((c) => c.changeMyPassword({ currentPassword: 'x', newPassword: 'y' }), 401, 'INVALID_CREDENTIALS');
  });
});

// ---------------------------------------------------------------- GC-7b：ConsoleStore 公开策略 / 配额 / 管理切片

describe('GC-7b：ConsoleStore 公开策略与配额切片', () => {
  test('init 未登录：publicPolicy 同步写入（含验证 / SMTP 策略），quota 为空', () => {
    const store = new ConsoleStore();
    store.init({
      authenticated: false,
      allowSignup: true,
      requireEmailVerification: true,
      smtpConfigured: false,
      maxNetworksPerUser: 5,
      defaultMaxPeers: 16,
    });
    const s = store.getState();
    assert.equal(s.boot, 'ready');
    assert.equal(s.session, null);
    assert.deepEqual(s.publicPolicy, {
      allowSignup: true,
      requireEmailVerification: true,
      smtpConfigured: false,
      maxNetworksPerUser: 5,
      defaultMaxPeers: 16,
    });
    assert.equal(s.quota, null);
  });

  test('init 登录态：session、quota、publicPolicy 三切片同步写入', () => {
    const store = new ConsoleStore();
    const quota = makeQuota({ usedNetworks: 2 });
    store.init({
      authenticated: true,
      user: TEST_USER,
      quota,
      allowSignup: false,
      requireEmailVerification: false,
      smtpConfigured: true,
      maxNetworksPerUser: 3,
      defaultMaxPeers: 8,
    });
    const s = store.getState();
    assert.equal(s.session?.user.id, TEST_USER.id);
    assert.equal(s.quota, quota, 'quota 切片按引用存入');
    assert.deepEqual(s.publicPolicy, {
      allowSignup: false,
      requireEmailVerification: false,
      smtpConfigured: true,
      maxNetworksPerUser: 3,
      defaultMaxPeers: 8,
    });
  });

  test('init 缺省字段兜底（启动降级路径只带旧两键）：关闸 + 内置默认 8 台', () => {
    const store = new ConsoleStore();
    store.init({ authenticated: false, allowSignup: false, maxNetworksPerUser: 3 });
    assert.deepEqual(store.getState().publicPolicy, {
      allowSignup: false,
      requireEmailVerification: false,
      smtpConfigured: false,
      maxNetworksPerUser: 3,
      defaultMaxPeers: 8,
    });
  });

  test('applySessionPayload（登录/注册响应体）一次写入 session / meta / quota / publicPolicy', () => {
    const store = new ConsoleStore();
    store.init({ authenticated: false, allowSignup: true, requireEmailVerification: true, smtpConfigured: true, maxNetworksPerUser: 5, defaultMaxPeers: 16 });
    const payload = {
      user: TEST_USER,
      quota: makeQuota({ usedNetworks: 2 }),
      ...makePublicPolicy({ allowSignup: true, requireEmailVerification: false, smtpConfigured: true, maxNetworksPerUser: 9, defaultMaxPeers: 32 }),
    };
    store.applySessionPayload(payload);
    const s = store.getState();
    assert.equal(s.session?.user.id, TEST_USER.id);
    assert.deepEqual(s.meta, { allowSignup: true, maxNetworksPerUser: 9 }, 'meta 沿旧两键契约同步');
    assert.equal(s.quota?.usedNetworks, 2);
    assert.equal(s.publicPolicy.requireEmailVerification, false, '登录成功后策略覆盖旧值');
    assert.equal(s.publicPolicy.maxNetworksPerUser, 9);
    assert.equal(s.publicPolicy.defaultMaxPeers, 32);
  });

  test('applyPublicPolicy / applyQuota 独立刷新且不改源对象', () => {
    const state = createInitialState();
    const policy = makePublicPolicy({ maxNetworksPerUser: 7 });
    const withPolicy = applyPublicPolicy(state, policy);
    assert.equal(withPolicy.publicPolicy, policy);
    assert.deepEqual(state.publicPolicy, createInitialState().publicPolicy, '源状态不被原地修改');

    const quota = makeQuota();
    const withQuota = applyQuota(withPolicy, quota);
    assert.equal(withQuota.quota, quota);
    assert.equal(withQuota.publicPolicy, withPolicy.publicPolicy, '配额刷新不碰策略引用');

    const cleared = applyQuota(withQuota, null);
    assert.equal(cleared.quota, null);
    assert.equal(cleared.publicPolicy, withPolicy.publicPolicy);
  });
});

describe('GC-7b：ConsoleStore 管理员切片与引用隔离', () => {
  const netA = 'a'.repeat(16);

  function makeStore() {
    const store = new ConsoleStore();
    store.init({
      authenticated: true,
      user: { ...TEST_USER, role: 'admin' },
      quota: makeQuota(),
      allowSignup: true,
      requireEmailVerification: false,
      smtpConfigured: true,
      maxNetworksPerUser: 3,
      defaultMaxPeers: 8,
    });
    store.patchUi({ accountMenuOpen: true, loginEmail: 'a@b.c' });
    store.setNetworks([makeNetworkView(netA, '家里')]);
    const snap = makeSnapshot(netA);
    store.applyTopologySnapshot(snap);
    return { store, snap };
  }

  test('applyAdminRuntime / applyAdminGroups 刷新数据并把 phase 推到 ready，绝不污染 ui/topology/session 引用', () => {
    const { store, snap } = makeStore();
    const before = store.getState();

    store.markAdminLoading('runtime');
    let s = store.getState();
    assert.equal(s.adminLoad.runtime, 'loading');
    assert.equal(s.ui, before.ui, 'loading 标记也不碰 ui 引用');

    const runtime = makeRuntimeStatus();
    store.applyAdminRuntime(runtime);
    s = store.getState();
    assert.equal(s.adminRuntime, runtime);
    assert.equal(s.adminLoad.runtime, 'ready');
    assert.equal(s.adminError.runtime, null);
    assert.equal(s.ui, before.ui);
    assert.equal(s.topology[netA], snap, 'topology 切片引用不变');
    assert.equal(s.networks, before.networks);
    assert.equal(s.session, before.session);
    assert.equal(s.quota, before.quota);

    store.markAdminError('groups', 'boom');
    s = store.getState();
    assert.equal(s.adminLoad.groups, 'error');
    assert.equal(s.adminError.groups, 'boom');

    const groups = [makeGroup('grp_default', { isDefault: true })];
    store.applyAdminGroups(groups);
    s = store.getState();
    assert.equal(s.adminGroups, groups);
    assert.equal(s.adminLoad.groups, 'ready', '成功覆盖旧错误态');
    assert.equal(s.adminError.groups, null);
    assert.equal(s.ui, before.ui);
    assert.equal(s.topology[netA], snap);
  });

  test('applyAdminSettings / applyAdminUsers 写入新形状（含 smtp 与 adminApiKey）并推 ready', () => {
    const { store } = makeStore();
    const settings = makeAdminSettings({
      publicUrl: 'https://gw.example.com',
      smtp: { configured: true, host: 'smtp.local', port: 465, security: 'tls', username: 'mailer', hasPassword: true, fromAddress: 'from@x.y', fromName: 'Mailer', rejectUnauthorized: true },
      adminApiKey: { configured: true, prefix: 'zr_adm_4f9a', createdAt: '2026-01-01T00:00:00.000Z' },
    });
    const users = [makeAdminUserRow('u-9'), makeAdminUserRow('u-10', { role: 'admin' })];
    store.applyAdminSettings(settings);
    store.applyAdminUsers(users);
    const s = store.getState();
    assert.equal(s.adminSettings, settings);
    assert.equal(s.adminSettings.smtp.configured, true);
    assert.equal(s.adminSettings.adminApiKey.prefix, 'zr_adm_4f9a');
    assert.equal(s.adminLoad.settings, 'ready');
    assert.equal(s.adminUsers, users);
    assert.equal(s.adminLoad.users, 'ready');
    assert.equal(s.adminError.users, null);
  });

  test('纯函数 applyAdminRuntime / applyAdminGroups 不改源状态（新增对象返回）', () => {
    const state = createInitialState();
    const runtime = makeRuntimeStatus();
    const withRuntime = applyAdminRuntime(state, runtime);
    assert.equal(state.adminRuntime, null, '源状态不被原地修改');
    assert.equal(withRuntime.adminRuntime, runtime);
    const groups = [makeGroup('g-1')];
    const withGroups = applyAdminGroups(withRuntime, groups);
    assert.deepEqual(withRuntime.adminGroups, [], '中间状态不被原地修改');
    assert.equal(withGroups.adminGroups, groups);
  });

  test('logout 清 quota 与管理员四切片（含加载/错误态）；publicPolicy 与 ui 保留', () => {
    const { store } = makeStore();
    store.applyAdminRuntime(makeRuntimeStatus());
    store.applyAdminGroups([makeGroup('g-1')]);
    store.applyAdminSettings(makeAdminSettings());
    store.applyAdminUsers([makeAdminUserRow('u-9')]);
    const before = store.getState();

    store.logout({ allowSignup: false, maxNetworksPerUser: 3 });
    const s = store.getState();
    assert.equal(s.session, null);
    assert.equal(s.quota, null, '配额是会话数据，登出即清');
    assert.equal(s.adminRuntime, null);
    assert.equal(s.adminSettings, null);
    assert.deepEqual(s.adminGroups, []);
    assert.deepEqual(s.adminUsers, []);
    assert.deepEqual(s.adminLoad, { runtime: 'idle', settings: 'idle', groups: 'idle', users: 'idle' });
    assert.deepEqual(s.adminError, { runtime: null, settings: null, groups: null, users: null });
    assert.equal(s.ui, before.ui, '表单草稿保留（既有契约）');
    assert.deepEqual(s.publicPolicy, before.publicPolicy, '公开策略匿名可见，登出不删');
    assert.deepEqual(s.networks, []);
    assert.deepEqual(s.topology, {});
    assert.deepEqual(s.meta, { allowSignup: false, maxNetworksPerUser: 3 });
  });

  test('clearAdminSlices（切出管理页 / 401）：只清管理切片，session/quota/ui/topology 原样', () => {
    const { store, snap } = makeStore();
    store.applyAdminRuntime(makeRuntimeStatus());
    store.applyAdminGroups([makeGroup('g-1')]);
    store.applyAdminSettings(makeAdminSettings());
    store.applyAdminUsers([makeAdminUserRow('u-9')]);
    store.markAdminError('runtime', 'boom');
    const before = store.getState();

    store.clearAdminSlices();
    const s = store.getState();
    assert.equal(s.adminRuntime, null);
    assert.equal(s.adminSettings, null);
    assert.deepEqual(s.adminGroups, []);
    assert.deepEqual(s.adminUsers, []);
    assert.deepEqual(s.adminLoad, { runtime: 'idle', settings: 'idle', groups: 'idle', users: 'idle' });
    assert.deepEqual(s.adminError, { runtime: null, settings: null, groups: null, users: null });
    assert.equal(s.session, before.session, '会话不动');
    assert.equal(s.quota, before.quota, '配额不动');
    assert.equal(s.ui, before.ui);
    assert.equal(s.topology[netA], snap);
    assert.equal(s.networks, before.networks);
  });

  test('markAdminError 保留旧数据兜底：数据切片不动、错误消息独立记录', () => {
    const { store } = makeStore();
    const users = [makeAdminUserRow('u-9')];
    store.applyAdminUsers(users);

    store.markAdminLoading('users');
    let s = store.getState();
    assert.equal(s.adminLoad.users, 'loading');
    assert.equal(s.adminUsers, users, 'loading 不清数据');

    store.markAdminError('users', 'net down');
    s = store.getState();
    assert.equal(s.adminLoad.users, 'error');
    assert.equal(s.adminError.users, 'net down');
    assert.equal(s.adminUsers, users, '失败保留旧数据供展示兜底');
  });
});

// ---------------------------------------------------------------- GC-10b：grandfathered 词条上移与管理四切片 App 接线后的状态流转

describe('GC-10b：grandfathered 词条与四切片独立失败 / 彻底清理', () => {
  const netA = 'a'.repeat(16);

  /** 管理员会话 + 业务数据已就绪的 store（镜像 GC-7b makeStore） */
  function makeAdminStore() {
    const store = new ConsoleStore();
    store.init({
      authenticated: true,
      user: { ...TEST_USER, role: 'admin' },
      quota: makeQuota(),
      allowSignup: true,
      requireEmailVerification: false,
      smtpConfigured: true,
      maxNetworksPerUser: 3,
      defaultMaxPeers: 8,
    });
    store.patchUi({ accountMenuOpen: true, loginEmail: 'a@b.c' });
    store.setNetworks([makeNetworkView(netA, '家里')]);
    const snap = makeSnapshot(netA);
    store.applyTopologySnapshot(snap);
    return store;
  }

  test('network.grandfatheredPeerCap 中英双语词条齐备（组件内联双语上移词典）', () => {
    assert.ok('network.grandfatheredPeerCap' in LOCALES.zh, 'zh 缺少 network.grandfatheredPeerCap');
    assert.ok('network.grandfatheredPeerCap' in LOCALES.en, 'en 缺少 network.grandfatheredPeerCap');
    assert.equal(
      LOCALES.zh['network.grandfatheredPeerCap'],
      '当前上限来自历史配置，可继续维持或向下缩容，无法上调超过组上限',
    );
    assert.equal(
      LOCALES.en['network.grandfatheredPeerCap'],
      'This limit comes from an earlier configuration — keep it or shrink it, but it cannot be raised past the group cap',
    );
    assert.ok(translate('zh', 'network.grandfatheredPeerCap').length > 0);
    assert.ok(translate('en', 'network.grandfatheredPeerCap').length > 0);
  });

  test('admin.sliceError 词条中英齐备（四切片刷新失败的非阻塞提示）', () => {
    assert.ok('admin.sliceError' in LOCALES.zh, 'zh 缺少 admin.sliceError');
    assert.ok('admin.sliceError' in LOCALES.en, 'en 缺少 admin.sliceError');
    assert.ok(LOCALES.zh['admin.sliceError'].length > 0);
    assert.ok(LOCALES.en['admin.sliceError'].length > 0);
  });

  test('四张管理切片独立失败：各自 phase=error 且保留旧数据，互不拖累；单张恢复不影响其余错误态', () => {
    const store = makeAdminStore();
    const runtime = makeRuntimeStatus();
    const settings = makeAdminSettings();
    const groups = [makeGroup('grp_default', { isDefault: true })];
    const users = [makeAdminUserRow('u-9')];
    store.applyAdminRuntime(runtime);
    store.applyAdminSettings(settings);
    store.applyAdminGroups(groups);
    store.applyAdminUsers(users);
    const before = store.getState();

    // 四张切片相继失败：数据切片全部保留旧值，加载/错误态各自独立记录
    store.markAdminError('runtime', 'rt-down');
    store.markAdminError('settings', 'st-down');
    store.markAdminError('groups', 'gr-down');
    store.markAdminError('users', 'us-down');
    let s = store.getState();
    assert.equal(s.adminRuntime, runtime, 'runtime 失败保留旧数据');
    assert.equal(s.adminSettings, settings, 'settings 失败保留旧数据');
    assert.equal(s.adminGroups, groups, 'groups 失败保留旧数据');
    assert.equal(s.adminUsers, users, 'users 失败保留旧数据');
    assert.deepEqual(s.adminLoad, { runtime: 'error', settings: 'error', groups: 'error', users: 'error' });
    assert.deepEqual(s.adminError, { runtime: 'rt-down', settings: 'st-down', groups: 'gr-down', users: 'us-down' });
    assert.equal(s.ui, before.ui, '错误态不碰 ui 引用');
    assert.equal(s.networks, before.networks, '错误态不碰 networks 引用');

    // 单张恢复（面板补拍成功）：只推自己回 ready 并清错误，其余切片错误态保留
    const groups2 = [makeGroup('grp_vip')];
    store.applyAdminGroups(groups2);
    s = store.getState();
    assert.equal(s.adminGroups, groups2);
    assert.equal(s.adminLoad.groups, 'ready', '恢复的切片推回 ready');
    assert.equal(s.adminError.groups, null);
    assert.equal(s.adminLoad.users, 'error', '其余切片错误态不受影响');
    assert.equal(s.adminError.users, 'us-down');
    assert.equal(s.adminUsers, users, '其余切片数据不受影响');
  });

  test('clearAdminSlices 在四切片全失败态下彻底清空管理态，session/quota/ui/networks/topology 原样', () => {
    const store = makeAdminStore();
    store.applyAdminRuntime(makeRuntimeStatus());
    store.applyAdminSettings(makeAdminSettings());
    store.applyAdminGroups([makeGroup('grp_default', { isDefault: true })]);
    store.applyAdminUsers([makeAdminUserRow('u-9')]);
    store.markAdminError('runtime', 'rt-down');
    store.markAdminError('settings', 'st-down');
    store.markAdminError('groups', 'gr-down');
    store.markAdminError('users', 'us-down');
    const before = store.getState();

    // App 侧切出管理视图 / 任一管理请求 401 的统一清场路径
    store.clearAdminSlices();
    const s = store.getState();
    assert.equal(s.adminRuntime, null);
    assert.equal(s.adminSettings, null);
    assert.deepEqual(s.adminGroups, []);
    assert.deepEqual(s.adminUsers, []);
    assert.deepEqual(s.adminLoad, { runtime: 'idle', settings: 'idle', groups: 'idle', users: 'idle' });
    assert.deepEqual(s.adminError, { runtime: null, settings: null, groups: null, users: null });
    assert.equal(s.session, before.session, '会话不动');
    assert.equal(s.quota, before.quota, '配额不动');
    assert.equal(s.ui, before.ui, 'ui（菜单/弹窗/草稿）引用原样');
    assert.equal(s.networks, before.networks, 'networks 引用原样');
    assert.ok(s.topology[netA] !== undefined, 'topology 切片原样');
  });
});
