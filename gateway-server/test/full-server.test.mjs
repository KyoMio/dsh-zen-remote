// PG-6b 全栈集成测试：经 src/main.ts 的 startGateway 组装完整网关实例——
// 同一进程里 HTTP（REST + 静态托管控制台）+ WS 入网 + 双 UDP STUN 协同就绪，
// 并可无泄漏 close()。静态部分钉住：`/` 返回编译后的控制台 HTML 与严格自包含
// CSP 安全头、`/assets/*` 哈希资源 immutable 且零外部 URL、SPA 回退 no-cache。
// 与其他测试相同：.mjs 直接 import 编译产物 ../dist/。
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startGateway } from '../dist/main.js';
import { createGatewayApiServer } from '../dist/server.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import { deriveMasterKeyFromSecret } from '../dist/master-key.js';
import { PeerWsHub } from '../dist/peer-hub/ws-hub.js';
import { UdpStunService } from '../dist/peer-hub/udp-stun.js';
import WebSocket from 'ws';

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.join(TEST_ROOT, '.full-server-data');

after(() => {
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
});
const CSP_EXPECTED =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'";
const ADMIN_EMAIL = 'admin@local';
const ADMIN_PASSWORD = 'admin-pass-1234';

// ---------------------------------------------------------------- 实例组装

let dataDirSeq = 0;

function makeDataDir() {
  dataDirSeq += 1;
  const dataDir = path.join(DATA_ROOT, `run-${process.pid}-${dataDirSeq}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  return dataDir;
}

function makeConfig(overrides = {}) {
  return {
    port: 0,
    udpAltPort: 0, // 默认关辅助口；UDP 用例自行覆盖为预留端口
    publicUrl: undefined,
    dataDir: makeDataDir(),
    databaseUrl: undefined,
    adminUser: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    allowSignup: false,
    defaultMaxPeers: 8,
    maxNetworksPerUser: 3,
    relayRateKbps: 1024,
    ...overrides,
  };
}

/** 占住一个 UDP 端口立刻释放，拿内核刚分配过的空闲端口号给 udpAltPort 用 */
async function reserveUdpPort() {
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', () => {
      sock.removeAllListeners('error');
      resolve();
    });
  });
  const port = sock.address().port;
  await new Promise((resolve) => sock.close(() => resolve()));
  return port;
}

async function startTestGateway(configOverrides = {}) {
  const gw = await startGateway(makeConfig(configOverrides));
  return gw;
}

// ---------------------------------------------------------------- REST 客户端

async function api(base, method, apiPath, { body, cookie } = {}) {
  const headers = {};
  if (cookie !== undefined) headers.cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
    headers.origin = base; // 写请求过同源门（浏览器形态）
  }
  const res = await fetch(base + apiPath, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null, setCookies: res.headers.getSetCookie() };
}

function sessionCookie(res) {
  const raw = res.setCookies.find((c) => c.startsWith('zr_gw_session='));
  assert.ok(raw, 'expected session cookie');
  return raw.split(';')[0];
}

async function login(base, email, password) {
  const res = await api(base, 'POST', '/api/v1/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login ${email} failed: ${JSON.stringify(res.json)}`);
  return sessionCookie(res);
}

// ---------------------------------------------------------------- 节点身份与 WS/UDP 客户端（与 peer-hub.test.mjs 同一套自证明方案）

function identity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const publicKeyHex = Buffer.from(pubJwk.x, 'base64url').toString('hex');
  const privateKeyHex = Buffer.from(privJwk.d, 'base64url').toString('hex');
  const nodeId = crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 8);
  return { publicKeyHex, privateKeyHex, nodeId };
}

function edSign(privateKeyHex, publicKeyHex, message) {
  const key = crypto.createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(publicKeyHex, 'hex').toString('base64url'),
      d: Buffer.from(privateKeyHex, 'hex').toString('base64url'),
    },
    format: 'jwk',
  });
  return crypto.sign(null, message, key).toString('hex');
}

const authMessage = (networkId, nodeId, challengeHex, timestamp) =>
  Buffer.from(`zr-gw-auth-v1|${networkId}|${nodeId}|${challengeHex}|${timestamp}`, 'utf8');
const joinProof = (joinKey, networkId, nodeId, challengeHex) =>
  crypto
    .createHmac('sha256', Buffer.from(joinKey, 'utf8'))
    .update(Buffer.from(`zr-join-v1|${networkId}|${nodeId}|${challengeHex}`, 'utf8'))
    .digest('hex');
const stunMessage = (networkId, nodeId, nonce, timestamp) =>
  Buffer.from(`zr-stun-probe-v1|${networkId}|${nodeId}|${nonce}|${timestamp}`, 'utf8');

function attachWsDispatcher(ws) {
  ws.__textQueue = [];
  ws.__textWaiters = [];
  ws.__closed = false;
  ws.on('close', () => {
    ws.__closed = true;
  });
  ws.on('message', (data) => {
    let json;
    try {
      json = JSON.parse(Buffer.from(data).toString('utf8'));
    } catch {
      json = { __raw: Buffer.from(data).toString('utf8') };
    }
    const waiter = ws.__textWaiters.shift();
    if (waiter !== undefined) waiter(json);
    else ws.__textQueue.push(json);
  });
}

async function wsOpen(base, wsPath = '/peer/v1/ws') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + wsPath);
    attachWsDispatcher(ws);
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 2000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function wsJson(ws, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws message timeout')), timeoutMs);
    const deliver = (json) => {
      clearTimeout(timer);
      resolve(json);
    };
    if (ws.__textQueue.length > 0) deliver(ws.__textQueue.shift());
    else ws.__textWaiters.push(deliver);
  });
}

function wsClosed(ws, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    if (ws.__closed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('ws close timeout')), timeoutMs);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function authNode(ws, node, { networkId, joinKey, name }) {
  const challenge = await wsJson(ws);
  assert.equal(challenge.type, 'challenge');
  const timestamp = Date.now();
  ws.send(JSON.stringify({
    type: 'auth',
    networkId,
    nodeId: node.nodeId,
    publicKeyHex: node.publicKeyHex,
    name: name ?? `node-${node.nodeId}`,
    lanEndpoints: [],
    timestamp,
    signatureHex: edSign(node.privateKeyHex, node.publicKeyHex, authMessage(networkId, node.nodeId, challenge.challengeHex, timestamp)),
    joinKeyProofHex: joinProof(joinKey, networkId, node.nodeId, challenge.challengeHex),
  }));
}

async function udpSocket() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', () => {
      sock.removeAllListeners('error');
      resolve(sock);
    });
  });
}

function udpProbe(sock, port, node, { networkId, nonce = 'aa01', timestamp = Date.now() } = {}) {
  const msg = {
    type: 'stun-probe',
    networkId,
    nodeId: node.nodeId,
    publicKeyHex: node.publicKeyHex,
    nonce,
    timestamp,
    signatureHex: edSign(node.privateKeyHex, node.publicKeyHex, stunMessage(networkId, node.nodeId, nonce, timestamp)),
  };
  sock.send(Buffer.from(JSON.stringify(msg)), port, '127.0.0.1');
}

function udpRecv(sock, { timeoutMs = 800 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('udp reply timeout')), timeoutMs);
    const onMsg = (buf) => {
      clearTimeout(timer);
      sock.off('message', onMsg);
      try {
        resolve(JSON.parse(buf.toString('utf8')));
      } catch (err) {
        reject(err);
      }
    };
    sock.on('message', onMsg);
  });
}

function udpSilence(sock, ms = 250) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.off('message', onMsg);
      resolve();
    }, ms);
    const onMsg = (buf) => {
      clearTimeout(timer);
      sock.off('message', onMsg);
      reject(new Error(`expected no udp reply, got ${buf.toString('utf8')}`));
    };
    sock.on('message', onMsg);
  });
}

// ---------------------------------------------------------------- 静态托管

describe('静态托管：编译后的控制台', () => {
  test('`/` 返回控制台 HTML、严格自包含 CSP 与 no-cache', async () => {
    const gw = await startTestGateway();
    try {
      const res = await fetch(gw.base + '/');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(res.headers.get('content-security-policy'), CSP_EXPECTED);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      const html = await res.text();
      assert.match(html, /<!doctype html>/i);
      assert.match(html, /<div id="root">/);
      assert.match(html, /<script [^>]*src="\/assets\/[^"]+\.js"/);

      // HEAD 同样 200 且无响应体
      const head = await fetch(gw.base + '/', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    } finally {
      await gw.close();
    }
  });

  test('HTML 与 CSS 零外部 URL；`/assets/*` immutable JS/CSS', async () => {
    const gw = await startTestGateway();
    try {
      const html = await (await fetch(gw.base + '/')).text();
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(refs.some((r) => /\.js$/.test(r)), 'HTML 应引用 JS 资源');
      assert.ok(refs.some((r) => /\.css$/.test(r)), 'HTML 应引用 CSS 资源');
      for (const ref of refs) {
        assert.match(ref, /^\//, `资源引用必须是站内相对路径：${ref}`);
        assert.doesNotMatch(ref, /^\/\//, `资源引用不得是协议相对地址：${ref}`);
      }
      assert.doesNotMatch(html, /(?:src|href)="https?:\/\//, 'HTML 不得引用外部 URL');

      for (const ref of refs.filter((r) => r.startsWith('/assets/'))) {
        const res = await fetch(gw.base + ref);
        assert.equal(res.status, 200, `资源 404：${ref}`);
        assert.equal(
          res.headers.get('cache-control'),
          'public, max-age=31536000, immutable',
          `哈希资源必须 immutable：${ref}`,
        );
        assert.match(
          res.headers.get('content-type') ?? '',
          /^text\/(javascript|css); charset=utf-8$/,
          `资源类型应为 JS/CSS：${ref}`,
        );
        if (ref.endsWith('.css')) {
          const css = await res.text();
          assert.doesNotMatch(css, /url\(\s*["']?https?:/i, 'CSS 不得引用外部 URL');
          assert.doesNotMatch(css, /@import\s+["']?https?:/i, 'CSS 不得外部 @import');
        }
      }
    } finally {
      await gw.close();
    }
  });

  test('SPA 回退 no-cache + CSP；`/assets/` 缺失与路径穿越一律 404', async () => {
    const gw = await startTestGateway();
    try {
      const index = await (await fetch(gw.base + '/')).text();

      const deep = await fetch(gw.base + '/networks/some-net/devices');
      assert.equal(deep.status, 200);
      assert.equal(deep.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(deep.headers.get('content-security-policy'), CSP_EXPECTED);
      assert.equal(deep.headers.get('cache-control'), 'no-cache');
      assert.equal(await deep.text(), index, 'SPA 回退必须返回同一份 index.html');

      const missingAsset = await fetch(gw.base + '/assets/definitely-missing-9a2b.js');
      assert.equal(missingAsset.status, 404);
      assert.doesNotMatch(await missingAsset.text(), /<div id="root">/, '资源缺失不得回落成 HTML');

      // 注意：fetch/URL 规范化会把 %2e 先解码成 `..` 并折叠掉（请求根本到不了服务端），
      // 这里用带 %2f 的整段编码保住穿越形态，服务端解码后才现出 `/../..`
      const traversal = await fetch(gw.base + '/%2e%2e%2f%2e%2e%2fpackage.json');
      assert.equal(traversal.status, 404, '路径穿越必须被拒绝');
      assert.doesNotMatch(await traversal.text(), /"name"/);
    } finally {
      await gw.close();
    }
  });
});

// ---------------------------------------------------------------- 同进程协同

describe('完整实例：API + WS + UDP 同进程协同', () => {
  test('API 就绪：管理员引导、登录、建网、拓扑快照', async () => {
    const gw = await startTestGateway();
    try {
      assert.equal(gw.admin.created, true);
      assert.equal(gw.admin.email, ADMIN_EMAIL);
      assert.equal(gw.admin.generatedPassword, undefined, '显式给了初始密码就不应再生成');

      const cookie = await login(gw.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const created = await api(gw.base, 'POST', '/api/v1/networks', {
        body: { name: '家里', admissionMode: 'key' },
        cookie,
      });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      const net = created.json.data;
      assert.match(net.id, /^[0-9a-f]{16}$/);
      assert.ok(net.joinKey.length >= 32);
      assert.match(net.joinUri, /^zr-net:\/\//);

      const topo = await api(gw.base, 'GET', `/api/v1/networks/${net.id}/topology`, { cookie });
      assert.equal(topo.status, 200);
      assert.equal(topo.json.data.network.id, net.id);
      assert.deepEqual(topo.json.data.members, []);
    } finally {
      await gw.close();
    }
  });

  test('WS 入网走同一实例：挑战应答授权，拓扑实时可见', async () => {
    const gw = await startTestGateway();
    try {
      const cookie = await login(gw.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const created = await api(gw.base, 'POST', '/api/v1/networks', { body: { name: 'net-ws', admissionMode: 'key' }, cookie });
      const net = created.json.data;

      const node = identity();
      const ws = await wsOpen(gw.base);
      try {
        await authNode(ws, node, { networkId: net.id, joinKey: net.joinKey, name: 'alpha' });
        const welcome = await wsJson(ws);
        assert.equal(welcome.type, 'welcome');
        assert.equal(welcome.status, 'authorized');
        assert.equal(welcome.maxPeers, net.maxPeers);

        // 在线状态在拓扑里实时可见（连接保持期间）
        const topo = await api(gw.base, 'GET', `/api/v1/networks/${net.id}/topology`, { cookie });
        const row = topo.json.data.members.find((m) => m.nodeId === node.nodeId);
        assert.ok(row, 'WS 节点应出现在同一进程的拓扑里');
        assert.equal(row.status, 'authorized');
        assert.equal(row.online, true);
        assert.ok('note' in row && 'lastSeenAt' in row, '拓扑成员行携带备注与最后在线时间');
      } finally {
        ws.close();
        await wsClosed(ws);
      }

      // 断开连接后成员行保留（authorized 落库），仅 online 回落为 false
      const topoAfter = await api(gw.base, 'GET', `/api/v1/networks/${net.id}/topology`, { cookie });
      assert.equal(topoAfter.json.data.members.find((m) => m.nodeId === node.nodeId)?.online, false);
    } finally {
      await gw.close();
    }
  });

  test('UDP 双端口探测应答，NAT 分类进拓扑', async () => {
    const altPort = await reserveUdpPort();
    const gw = await startTestGateway({ udpAltPort: altPort });
    try {
      assert.equal(gw.udpPorts.altPort, altPort);
      assert.notEqual(gw.udpPorts.primaryPort, 0);

      const cookie = await login(gw.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const created = await api(gw.base, 'POST', '/api/v1/networks', { body: { name: 'net-udp', admissionMode: 'key' }, cookie });
      const net = created.json.data;

      const node = identity();
      const ws = await wsOpen(gw.base);
      const sock = await udpSocket();
      try {
        await authNode(ws, node, { networkId: net.id, joinKey: net.joinKey });
        assert.equal((await wsJson(ws)).status, 'authorized');

        const localPort = sock.address().port;
        udpProbe(sock, gw.udpPorts.primaryPort, node, { networkId: net.id, nonce: 'aa01' });
        const reply1 = await udpRecv(sock);
        assert.equal(reply1.type, 'stun-reply');
        assert.equal(reply1.serverPortRole, 'primary');
        assert.equal(reply1.reflexiveIp, '127.0.0.1');
        assert.equal(reply1.reflexivePort, localPort);

        udpProbe(sock, gw.udpPorts.altPort, node, { networkId: net.id, nonce: 'aa02' });
        const reply2 = await udpRecv(sock);
        assert.equal(reply2.serverPortRole, 'alt');
        assert.equal(reply2.reflexivePort, localPort);

        const topo = await api(gw.base, 'GET', `/api/v1/networks/${net.id}/topology`, { cookie });
        assert.equal(topo.json.data.members.find((m) => m.nodeId === node.nodeId).natType, 'cone', '双端口同源判定进拓扑');
      } finally {
        sock.close();
        ws.close();
        await wsClosed(ws);
      }
    } finally {
      await gw.close();
    }
  });

  test('管理员引导：未给密码时生成随机密码，重启复用同一库', async () => {
    const dataDir = makeDataDir();
    const first = await startTestGateway({ dataDir, adminPassword: undefined });
    try {
      assert.equal(first.admin.created, true);
      assert.equal(first.admin.email, ADMIN_EMAIL);
      const generated = first.admin.generatedPassword ?? '';
      assert.equal(generated.length, 16, '生成的初始管理员密码应为 16 位');

      const second = await startTestGateway({ dataDir, adminPassword: 'unused-second-run' });
      try {
        assert.equal(second.admin.created, false, '同一数据目录重启不得重复创建管理员');
        // 首次生成的密码仍然有效（第二次的密码参数只作候选，不覆盖已有账号）
        const res = await api(second.base, 'POST', '/api/v1/auth/login', {
          body: { email: ADMIN_EMAIL, password: generated },
        });
        assert.equal(res.status, 200, JSON.stringify(res.json));
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });
});

// ---------------------------------------------------------------- welcome STUN 端点公布（PC-01a）

describe('welcome 公布真实 UDP STUN 端口', () => {
  test('测试配置（随机主端口、辅助关闭）：authorized welcome 带真实 UDP 主端口，altPort 为 null', async () => {
    // 测试夹具用 port 0 / udpAltPort 0（非生产默认 19393/19394）：UDP 主端口内核分配、辅助口关闭。
    // config.port 同时是 HTTP 监听口（内核另分配），welcome 必须给 UDP bind 结果而不是它。
    const gw = await startTestGateway();
    try {
      assert.equal(gw.udpPorts.altPort, null, '测试配置 udpAltPort=0 应关闭辅助口');
      assert.ok(
        Number.isInteger(gw.udpPorts.primaryPort) && gw.udpPorts.primaryPort >= 1 && gw.udpPorts.primaryPort <= 65535,
        `实际绑定主端口应为有效整数，收到 ${gw.udpPorts.primaryPort}`,
      );

      const cookie = await login(gw.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const created = await api(gw.base, 'POST', '/api/v1/networks', { body: { name: 'net-stun-default', admissionMode: 'key' }, cookie });
      const net = created.json.data;

      const node = identity();
      const ws = await wsOpen(gw.base);
      try {
        await authNode(ws, node, { networkId: net.id, joinKey: net.joinKey, name: 'stun-node' });
        const welcome = await wsJson(ws);
        assert.equal(welcome.type, 'welcome');
        assert.equal(welcome.status, 'authorized');
        assert.deepEqual(welcome.stun, { primaryPort: gw.udpPorts.primaryPort, altPort: null });
        assert.ok(
          Number.isInteger(welcome.stun.primaryPort) && welcome.stun.primaryPort >= 1 && welcome.stun.primaryPort <= 65535,
          `welcome.stun.primaryPort 应为有效整数，收到 ${welcome.stun.primaryPort}`,
        );
      } finally {
        ws.close();
        await wsClosed(ws);
      }
    } finally {
      await gw.close();
    }
  });

  test('自定义辅助端口：welcome.stun 携带主/辅两个实际绑定端口', async () => {
    const altPort = await reserveUdpPort();
    const gw = await startTestGateway({ udpAltPort: altPort });
    try {
      assert.equal(gw.udpPorts.altPort, altPort);

      const cookie = await login(gw.base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const created = await api(gw.base, 'POST', '/api/v1/networks', { body: { name: 'net-stun-alt', admissionMode: 'key' }, cookie });
      const net = created.json.data;

      const node = identity();
      const ws = await wsOpen(gw.base);
      try {
        await authNode(ws, node, { networkId: net.id, joinKey: net.joinKey, name: 'stun-node-alt' });
        const welcome = await wsJson(ws);
        assert.equal(welcome.status, 'authorized');
        assert.deepEqual(welcome.stun, { primaryPort: gw.udpPorts.primaryPort, altPort });
        assert.ok(
          Number.isInteger(welcome.stun.altPort) && welcome.stun.altPort >= 1 && welcome.stun.altPort <= 65535,
          `welcome.stun.altPort 应为有效整数，收到 ${welcome.stun.altPort}`,
        );
      } finally {
        ws.close();
        await wsClosed(ws);
      }
    } finally {
      await gw.close();
    }
  });
});

// ---------------------------------------------------------------- UDP 启动窗口安全（PC-01a fix1）

describe('UDP 启动窗口：回调安全与端口就绪时序', () => {
  test('hub 已建、端口未就绪时回调拒绝准入且无副作用；bind 完成后 welcome 才带真实端口', async () => {
    // 与 main.ts 同型的组装（fix1 形态：hub 先建、UDP 回调恒转发已初始化的 hub、
    // 真实端口经供给器在 bind 完成后才对 welcome 可见）。主口绑成即可投递 UDP 事件，
    // 「主口已绑、辅助口未完成」的启动窗口无法从外部冻结——这里用同一危险状态
    // （hub 在、端口供给器仍返回 null）直接调用初始回调验证安全性，仅调回调、
    // 不发任何数据包。
    const store = new SqliteStore({ path: path.join(makeDataDir(), 'gateway.sqlite') });
    const masterKey = deriveMasterKeyFromSecret('pc-01a-fix1');
    await store.ensureBootstrapAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    let boundPorts = null;
    const hub = new PeerWsHub({ store, masterKey, rateTickMs: null, flushMs: null, stunPorts: () => boundPorts });
    const admitProbe = (networkId, nodeId, publicKeyHex) => hub.admitStunProbe(networkId, nodeId, publicKeyHex);
    const lanEndpointsLookup = (networkId, nodeId) => hub.getLanEndpoints(networkId, nodeId);
    const onNatDetected = (record) => hub.applyNatObservation(record);
    const udp = new UdpStunService({
      primaryPort: 0,
      altPort: null,
      host: '127.0.0.1',
      admitProbe,
      lanEndpointsLookup,
      onNatDetected,
    });
    const server = createGatewayApiServer({ store, masterKey, runtime: hub, hooks: hub.hooks, topology: hub });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    hub.attach(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    let ws = null;
    try {
      // ---- 启动窗口（bind 前，端口供给器仍为 null）：回调必须安全且无业务副作用 ----
      assert.equal(
        admitProbe('0123456789abcdef', 'abcd1234', 'aa'.repeat(32)),
        null,
        '未就绪窗口必须明确拒绝准入（null），不得退回无准入 standalone 放行',
      );
      assert.deepEqual(lanEndpointsLookup('0123456789abcdef', 'abcd1234'), []);
      onNatDetected({
        networkId: '0123456789abcdef',
        nodeId: 'abcd1234',
        natType: 'cone',
        reflexiveIp: '127.0.0.1',
        reflexivePort: 40001,
        serverPortRole: 'primary',
      });
      await hub.flushTelemetry();
      assert.deepEqual(await store.listMembers('0123456789abcdef'), [], '窗口内的 NAT 通知不得落任何成员业务状态');

      // ---- 正常 bind 生命周期：真实绑定完成后端口才经供给器可见 ----
      boundPorts = await udp.bind();
      assert.ok(
        Number.isInteger(boundPorts.primaryPort) && boundPorts.primaryPort >= 1 && boundPorts.primaryPort <= 65535,
        `bind 结果应为有效端口，收到 ${boundPorts.primaryPort}`,
      );

      const cookie = await login(base, ADMIN_EMAIL, ADMIN_PASSWORD);
      const created = await api(base, 'POST', '/api/v1/networks', { body: { name: 'net-fix1', admissionMode: 'key' }, cookie });
      const net = created.json.data;
      const node = identity();
      ws = await wsOpen(base);
      await authNode(ws, node, { networkId: net.id, joinKey: net.joinKey, name: 'fix1-node' });
      const welcome = await wsJson(ws);
      assert.equal(welcome.status, 'authorized');
      assert.deepEqual(welcome.stun, { primaryPort: boundPorts.primaryPort, altPort: null });
    } finally {
      if (ws !== null) {
        ws.close();
        await wsClosed(ws);
      }
      await hub.close();
      await udp.close();
      await new Promise((resolve) => {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      await store.close();
    }
  });
});

// ---------------------------------------------------------------- 生命周期

describe('无泄漏关停', () => {
  test('close() 后 HTTP 拒连、UDP 静默，重复 close 幂等', async () => {
    const altPort = await reserveUdpPort();
    const gw = await startTestGateway({ udpAltPort: altPort });

    const alive = await fetch(gw.base + '/');
    assert.equal(alive.status, 200);
    await alive.body?.cancel();

    await gw.close();

    await assert.rejects(() => fetch(gw.base + '/'), (err) => {
      assert.ok(err instanceof Error);
      return true;
    }, '关停后 HTTP 不得再接受连接');

    const sock = await udpSocket();
    try {
      const node = identity();
      udpProbe(sock, gw.udpPorts.primaryPort, node, { networkId: '0123456789abcdef' });
      await udpSilence(sock);
    } finally {
      sock.close();
    }

    await gw.close(); // 幂等
  });

  test('close() 归还全部资源：store、hub、udp、server 逐层收尾不悬挂', async () => {
    const gw = await startTestGateway({ udpAltPort: await reserveUdpPort() });
    const startedAt = Date.now();
    await gw.close();
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3000, `close() 不应悬挂（耗时 ${elapsed}ms）`);
  });
});
