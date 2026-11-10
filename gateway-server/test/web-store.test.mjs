// PG-6a 控制台前端纯逻辑测试：中英词典 100% 键对称、「说人话」黑话扫描、
// SSE 快照合并只动 topology 切片（绝不碰 UI 本地交互状态：弹窗/下拉菜单/
// 行内二次确认/表单草稿）、REST 信封解包与 SSE 订阅解析。
// 与其余测试相同：.mjs 直接 import 编译产物 ../dist/。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCALES,
  LOCALE_STORAGE_KEY,
  pickLocale,
  resolveLocale,
  translate,
} from '../dist/web/i18n/locales.js';
import {
  ConsoleApiError,
  ConsoleClient,
  ConsoleStore,
  applyNetworks,
  applySession,
  applyTopologySnapshot,
  createInitialState,
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
