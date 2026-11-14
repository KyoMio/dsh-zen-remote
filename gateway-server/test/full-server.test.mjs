// PG-6b 全栈集成测试：经 src/main.ts 的 startGateway 组装完整网关实例——
// 同一进程里 HTTP（REST + 静态托管控制台）+ WS 入网 + 双 UDP STUN 协同就绪，
// 并可无泄漏 close()。静态部分钉住：`/` 返回编译后的控制台 HTML 与严格自包含
// CSP 安全头、`/assets/*` 哈希资源 immutable 且零外部 URL、SPA 回退 no-cache。
// 与其他测试相同：.mjs 直接 import 编译产物 ../dist/。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { startGateway } from '../dist/main.js';
import { createGatewayApiServer } from '../dist/server.js';
import { resolveGatewayConfig } from '../dist/config.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import { SETTINGS_KEYS } from '../dist/store/types.js';
import { deriveMasterKeyFromSecret, hashPassword } from '../dist/master-key.js';
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

async function api(base, method, apiPath, { body, cookie, headers: extraHeaders } = {}) {
  const headers = { ...extraHeaders };
  if (cookie !== undefined) headers.cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
    if (headers['origin'] === undefined) headers.origin = base; // 写请求过同源门（浏览器形态）；Bearer 用例可显式覆盖
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
      // 客户端 wsClosed 不保证服务端 TCP close 回调在同一微任务完成，有界轮询等待服务端 teardown 落定
      const deadline = Date.now() + 1000;
      let memberAfter;
      for (;;) {
        const topoAfter = await api(gw.base, 'GET', `/api/v1/networks/${net.id}/topology`, { cookie });
        memberAfter = topoAfter.json.data.members.find((m) => m.nodeId === node.nodeId);
        if (memberAfter?.online === false || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(memberAfter?.status, 'authorized');
      assert.equal(memberAfter?.online, false);
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

// ---------------------------------------------------------------- PC-19 第二片：停止接收后补末批与有界退出
//
// 契约：close 先停止 WS/UDP 摄入与周期写入，再经第一片的同一串行 flush 入口
// 补末批（追平在途轮/合并尾轮，并有界收尾写库在途期间到达的少量新增），最后
// 才关 store；写失败/存储不响应时在墙钟预算内如实拒绝、报告未确认累计、停净
// 自有资源；重复/并发 close 共享同一真实结果。真实 SIGTERM 进程退出码与重开
// 数据库证据在 test/pc19-shutdown.test.mjs 的受控子进程里验证。

describe('PC-19 第二片：停止接收后补末批与有界退出', () => {
  /**
   * 驱动少量真实中转流量：REST 建网（key 模式）+ 两节点入网 + 一帧 A→B 并确认
   * 到达 B。返回 { net, a, b, sentBytes }——pendingRelayBytes 此时应含 sentBytes，
   * 且周期刷盘（5s）远未到点，构成「关停前已接收但尚未落库」的场景。
   */
  async function driveRelayTraffic(gw) {
    const cookie = await login(gw.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    const created = await api(gw.base, 'POST', '/api/v1/networks', {
      body: { name: 'pc19-shutdown-net', admissionMode: 'key' },
      cookie,
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const net = created.json.data;
    const a = identity();
    const b = identity();
    const wsA = await wsOpen(gw.base);
    await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey });
    assert.equal((await wsJson(wsA)).status, 'authorized');
    const wsB = await wsOpen(gw.base);
    await authNode(wsB, b, { networkId: net.id, joinKey: net.joinKey });
    assert.equal((await wsJson(wsB)).status, 'authorized');
    assert.equal((await wsJson(wsB)).type, 'punch-coordinate');
    assert.equal((await wsJson(wsA)).type, 'peer-joined');
    assert.equal((await wsJson(wsA)).type, 'punch-coordinate');

    const header = Buffer.alloc(28);
    header.writeUInt16BE(0x5a52, 0);
    header.writeUInt8(0x01, 2);
    header.writeUInt8(3, 3);
    header.write(a.nodeId, 4, 'hex');
    header.write(b.nodeId, 8, 'hex');
    header.writeUInt32BE(1, 12);
    header.writeBigUInt64BE(1n, 16);
    header.writeUInt32BE(0, 24);
    const frameBuf = Buffer.concat([header, crypto.randomBytes(32 + 16)]);
    wsA.send(frameBuf);
    const receivedAtB = await wsJson(wsB);
    assert.ok(receivedAtB.__raw !== undefined, 'B 应收到二进制帧');
    return { net, a, b, sentBytes: frameBuf.length };
  }

  /** 重开同一 sqlite 文件（openStore 用 dataDir/gateway.sqlite）读回成员行 */
  async function reopenMemberRow(dataDir, netId, nodeId) {
    const reopened = new SqliteStore({ path: path.join(dataDir, 'gateway.sqlite') });
    try {
      return (await reopened.listMembers(netId)).find((m) => m.nodeId === nodeId);
    } finally {
      await reopened.close();
    }
  }

  test('尚未周期落库的流量经 close 补末批：重开数据库读回最终累计', async () => {
    const gw = await startGateway(makeConfig(), { closeBudgetMs: 5000 });
    try {
      const { net, a, sentBytes } = await driveRelayTraffic(gw);
      assert.ok(gw.hub.limiter.pendingRelayBytes(net.id, a.nodeId) >= sentBytes, '中转字节应进待刷盘累计');
      await gw.close();
      const row = await reopenMemberRow(gw.config.dataDir, net.id, a.nodeId);
      assert.equal(row.cumulativeRelayBytes, sentBytes, '末批必须在关 store 前落库');
      assert.ok(row.lastSeenAt !== null, '末批应携带 lastSeenAt');
    } finally {
      await gw.close().catch(() => {});
    }
  });

  test('慢写在途时 close：关停前追加的数据经后续轮串行落库，不重复计数', async () => {
    const held = [];
    let holdWrites = false;
    const original = SqliteStore.prototype.flushMemberTelemetry;
    SqliteStore.prototype.flushMemberTelemetry = async function (updates) {
      if (holdWrites && updates.length > 0) {
        await new Promise((resolve) => held.push(resolve));
      }
      return original.call(this, updates);
    };
    let gw;
    try {
      gw = await startGateway(makeConfig(), { closeBudgetMs: 10_000 });
      const { net, a, sentBytes } = await driveRelayTraffic(gw);
      // 关停前已接收的 NAT 观测（close 开始后的观测会被 closed 闸拒收——
      // 由「关闭开始后新 NAT 观测不再接纳」用例单独钉住）
      gw.hub.applyNatObservation({
        networkId: net.id,
        nodeId: a.nodeId,
        natType: 'cone',
        reflexiveIp: '10.9.9.9',
        reflexivePort: 40001,
        serverPortRole: 'primary',
      });
      holdWrites = true; // 扣住第一轮末批
      const closing = gw.close();
      await new Promise((resolve) => setImmediate(resolve));
      // 关停在途期间追加的字节（对停摄入窗口内尾量的建模）由后续轮串行落库
      gw.hub.limiter.tryRelay({ networkId: net.id, nodeId: a.nodeId, peerNodeId: 'bbbbbbbb' }, 50, 4096);
      holdWrites = false;
      for (const release of held.splice(0)) release();
      await closing;
      const row = await reopenMemberRow(gw.config.dataDir, net.id, a.nodeId);
      assert.equal(row.cumulativeRelayBytes, sentBytes + 50, '两轮串行各落一次，不重计');
      assert.equal(row.lastIp, '10.9.9.9', '追加的 NAT 观测落库');
      assert.equal(row.natType, 'cone');
    } finally {
      SqliteStore.prototype.flushMemberTelemetry = original;
      if (gw !== undefined) await gw.close().catch(() => {});
    }
  });

  test('flush 失败时 close 降级打印 warning 并正常返回，资源停净，并发 close 共享同一完成', async () => {
    let failNext = false;
    const original = SqliteStore.prototype.flushMemberTelemetry;
    const origWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    SqliteStore.prototype.flushMemberTelemetry = async function (updates) {
      if (failNext && updates.length > 0) {
        failNext = false;
        throw new Error('controlled pc19 close flush failure');
      }
      return original.call(this, updates);
    };
    let gw;
    try {
      gw = await startGateway(makeConfig(), { closeBudgetMs: 5000 });
      const { net, a } = await driveRelayTraffic(gw);
      failNext = true;
      const first = gw.close();
      const second = gw.close(); // 并发调用：共享同一关闭 Promise
      await Promise.all([first, second]);
      assert.ok(
        warnings.some((line) => /final telemetry flush incomplete/i.test(line) && /unconfirmed/i.test(line)),
        `flush 失败时必须打印包含未确认信息的 warning，实际：${JSON.stringify(warnings)}`,
      );
      await assert.rejects(() => fetch(gw.base + '/'), undefined, '关停后资源停净：HTTP 拒连');
      assert.ok(gw.hub.limiter.pendingRelayBytes(net.id, a.nodeId) > 0, '失败后待写累计不得被误清零');
    } finally {
      console.warn = origWarn;
      SqliteStore.prototype.flushMemberTelemetry = original;
      if (gw !== undefined) await gw.close().catch(() => {});
    }
  });

  test('存储不响应时 close 在预算内打告警日志并正常结束（不因遥测挂起阻塞关停）', async () => {
    // 受控永不完成的写：刻意不解扣——解扣会对已关 store 触发迟到拒绝；
    // 挂起的 promise 无定时器/无 I/O，不阻碍测试进程退出
    let holdForever = false;
    const original = SqliteStore.prototype.flushMemberTelemetry;
    const origWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    SqliteStore.prototype.flushMemberTelemetry = async function (updates) {
      if (holdForever && updates.length > 0) {
        await new Promise(() => {});
      }
      return original.call(this, updates);
    };
    let gw;
    try {
      gw = await startGateway(makeConfig(), { closeBudgetMs: 400 });
      await driveRelayTraffic(gw);
      holdForever = true;
      const startedAt = Date.now();
      await gw.close();
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 3000, `close 必须在预算内有界完成（耗时 ${elapsed}ms）`);
      assert.ok(
        warnings.some((line) => /final telemetry flush incomplete/i.test(line) && /unconfirmed/i.test(line)),
        `遥测超时时必须打印包含未确认信息的 warning，实际：${JSON.stringify(warnings)}`,
      );
      await assert.rejects(() => fetch(gw.base + '/'), undefined, '关停后资源停净：HTTP 拒连');
    } finally {
      console.warn = origWarn;
      SqliteStore.prototype.flushMemberTelemetry = original;
      if (gw !== undefined) await gw.close().catch(() => {});
    }
  });

  test('已接收的 NAT 观测随末批持久化（重开读回 lastIp/natType）', async () => {
    const gw = await startGateway(makeConfig(), { closeBudgetMs: 5000 });
    try {
      const { net, a, sentBytes } = await driveRelayTraffic(gw);
      gw.hub.applyNatObservation({
        networkId: net.id,
        nodeId: a.nodeId,
        natType: 'cone',
        reflexiveIp: '10.7.7.7',
        reflexivePort: 40001,
        serverPortRole: 'primary',
      });
      await gw.close();
      const row = await reopenMemberRow(gw.config.dataDir, net.id, a.nodeId);
      assert.equal(row.cumulativeRelayBytes, sentBytes);
      assert.equal(row.lastIp, '10.7.7.7', '关闭前已接收的 NAT 观测必须在末批落库');
      assert.equal(row.natType, 'cone');
    } finally {
      await gw.close().catch(() => {});
    }
  });

  test('关闭开始后新 NAT 观测不再接纳：末批只确认关闭前已接收的数据', async () => {
    const held = [];
    let holdWrites = false;
    const original = SqliteStore.prototype.flushMemberTelemetry;
    SqliteStore.prototype.flushMemberTelemetry = async function (updates) {
      if (holdWrites && updates.length > 0) {
        await new Promise((resolve) => held.push(resolve));
      }
      return original.call(this, updates);
    };
    let gw;
    try {
      gw = await startGateway(makeConfig(), { closeBudgetMs: 10_000 });
      const { net, a, sentBytes } = await driveRelayTraffic(gw);
      // 关闭前已接收的观测（必须在末批落库）
      gw.hub.applyNatObservation({
        networkId: net.id,
        nodeId: a.nodeId,
        natType: 'cone',
        reflexiveIp: '10.0.0.1',
        reflexivePort: 40001,
        serverPortRole: 'primary',
      });
      holdWrites = true; // 扣住第一轮末批，制造「close 已开始」的窗口
      const closing = gw.close();
      await new Promise((resolve) => setImmediate(resolve));
      // 模拟在途回调此刻才送达的新观测：close 已开始，必须拒收——不进待写、不落库
      gw.hub.applyNatObservation({
        networkId: net.id,
        nodeId: a.nodeId,
        natType: 'symmetric',
        reflexiveIp: '10.0.0.2',
        reflexivePort: 40002,
        serverPortRole: 'primary',
      });
      assert.equal(
        gw.hub.pendingTelemetrySummary().natObservations,
        1,
        'close 开始后只保留关闭前那条观测，新观测不得进入待写',
      );
      holdWrites = false;
      for (const release of held.splice(0)) release();
      await closing;
      assert.equal(gw.hub.pendingTelemetrySummary().natObservations, 0, '末批确认后无待确认观测');
      const row = await reopenMemberRow(gw.config.dataDir, net.id, a.nodeId);
      assert.equal(row.lastIp, '10.0.0.1', '末批只携带关闭前已接收的观测');
      assert.equal(row.natType, 'cone');
      assert.equal(row.cumulativeRelayBytes, sentBytes);
    } finally {
      SqliteStore.prototype.flushMemberTelemetry = original;
      if (gw !== undefined) await gw.close().catch(() => {});
    }
  });

  test('仅 NAT 的批次写失败时 close 降级打印 warning 并保留待确认观测', async () => {
    let failNatOnly = false;
    const original = SqliteStore.prototype.flushMemberTelemetry;
    const origWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    SqliteStore.prototype.flushMemberTelemetry = async function (updates) {
      if (failNatOnly && updates.length > 0 && updates.every((u) => u.relayBytesDelta === undefined)) {
        throw new Error('controlled pc19 nat-only flush failure');
      }
      return original.call(this, updates);
    };
    let gw;
    try {
      gw = await startGateway(makeConfig(), { closeBudgetMs: 5000 });
      const tenant = await gw.store.createUser({
        email: 'pc19-nat-only@local',
        passwordHash: await hashPassword('pc19-nat-only-pass'),
        role: 'user',
      });
      const net = await gw.store.createNetwork({
        ownerId: tenant.id,
        name: 'pc19-nat-only',
        admissionMode: 'key',
        joinKeyEnc: 'pc19-nat-only-not-read',
        maxPeers: 8,
      });
      await gw.store.upsertMemberJoinAttempt({
        networkId: net.id,
        nodeId: 'cc19cccc',
        publicKeyHex: 'cc'.repeat(32),
        joinKeyMatched: true,
      });
      gw.hub.applyNatObservation({
        networkId: net.id,
        nodeId: 'cc19cccc',
        natType: 'cone',
        reflexiveIp: '10.8.8.8',
        reflexivePort: 40001,
        serverPortRole: 'primary',
      });
      failNatOnly = true;
      await gw.close();
      assert.ok(
        warnings.some((line) => /final telemetry flush incomplete/i.test(line) && /unconfirmed/i.test(line)),
        `NAT 批次写失败时必须打印包含未确认信息的 warning，实际：${JSON.stringify(warnings)}`,
      );
      assert.ok(gw.hub.pendingTelemetrySummary().natObservations > 0, '失败后待确认观测不得被清零');
    } finally {
      console.warn = origWarn;
      SqliteStore.prototype.flushMemberTelemetry = original;
      if (gw !== undefined) await gw.close().catch(() => {});
    }
  });

  test('UDP 关闭挂死时 close 在预算内拒绝，失败兜底同样有界', async () => {
    let hangUdpClose = false;
    const original = UdpStunService.prototype.close;
    UdpStunService.prototype.close = async function () {
      if (hangUdpClose) {
        await new Promise(() => {}); // 受控永不完成（无定时器无 I/O）
      }
      return original.call(this);
    };
    let gw;
    try {
      gw = await startGateway(makeConfig(), { closeBudgetMs: 400 });
      hangUdpClose = true; // 第一层关停即卡点
      const startedAt = Date.now();
      const outcome = await Promise.race([
        gw.close().then(
          () => 'resolved',
          (err) => ({ err }),
        ),
        new Promise((r) => setTimeout(() => r('deadline-exceeded'), 8000)),
      ]);
      assert.notEqual(outcome, 'resolved', '卡点路径不得假称成功');
      assert.notEqual(outcome, 'deadline-exceeded', 'close 失败兜底不得无界挂起（8s 观察窗内必须落定）');
      assert.match(outcome.err.message, /budget|unconfirmed/, '预算耗尽必须如实拒绝');
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 5500, `close 失败路径必须在预算 + 清理宽限内有界结束（实测 ${elapsed}ms，上界 = 400ms 预算 + 4×1000ms 兜底 + 余量）`);
      await assert.rejects(() => fetch(gw.base + '/'), undefined, '失败路径资源兜底停净：HTTP 拒连');
    } finally {
      // 先还原真实 close 再有界收尾：closePromise 可能仍挂在卡点上（RED 形态），
      // 直接 await 会无界阻塞；真实 dgram socket 与 HTTP 监听句柄必须关闭，
      // 否则测试进程退不出
      UdpStunService.prototype.close = original;
      if (gw !== undefined) {
        await Promise.race([
          gw.close().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
        try {
          gw.udp.primary?.close();
          gw.udp.alt?.close();
        } catch {
          /* 已关闭 */
        }
        try {
          gw.server.closeAllConnections?.();
          gw.server.close();
        } catch {
          /* 已关闭 */
        }
      }
    }
  });

  test('关停开始即停止 HTTP 新连接接收（不等末批完成）', async () => {
    const held = [];
    let holdWrites = false;
    const original = SqliteStore.prototype.flushMemberTelemetry;
    SqliteStore.prototype.flushMemberTelemetry = async function (updates) {
      if (holdWrites && updates.length > 0) {
        await new Promise((resolve) => held.push(resolve));
      }
      return original.call(this, updates);
    };
    let gw;
    try {
      gw = await startGateway(makeConfig(), { closeBudgetMs: 10_000 });
      await driveRelayTraffic(gw);
      holdWrites = true; // 扣住末批，制造「close 已开始但末批未完成」的窗口
      const closing = gw.close();
      await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(() => fetch(gw.base + '/'), undefined, '关停开始后 HTTP 必须立即拒新连接');
      holdWrites = false;
      for (const release of held.splice(0)) release();
      await closing;
    } finally {
      SqliteStore.prototype.flushMemberTelemetry = original;
      if (gw !== undefined) await gw.close().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------- PC-07 部署配置播种

// 这一组不走 makeConfig 直配对象，而是走 resolveGatewayConfig（env → GatewayConfig）
// 再进 startGateway 的生产组装路径：证明环境变量里的部署配置真的进了 openStore 的
// 播种，而不是只有测试直接给 store 传 seed 才生效。
describe('PC-07 部署配置播种：resolveGatewayConfig → startGateway 生产接线（SQLite）', () => {
  /** 四个部署键的 env 形态：与 resolveGatewayConfig 的变量名一一对应 */
  function envFor(dataDir, { allowSignup, defaultMaxPeers, maxNetworksPerUser, relayRateKbps }) {
    return {
      ZR_GATEWAY_UDP_ALT_PORT: '0',
      ZR_GATEWAY_DATA_DIR: dataDir,
      ZR_GATEWAY_ADMIN_USER: ADMIN_EMAIL,
      ZR_GATEWAY_ADMIN_PASSWORD: ADMIN_PASSWORD,
      ZR_GATEWAY_ALLOW_SIGNUP: String(allowSignup),
      ZR_GATEWAY_MAX_PEERS: String(defaultMaxPeers),
      ZR_GATEWAY_MAX_NETWORKS_PER_USER: String(maxNetworksPerUser),
      ZR_GATEWAY_RELAY_RATE_KBPS: String(relayRateKbps),
    };
  }

  /** 生产解析 + 测试管线例外：四键全部走真实 env 解析，仅 HTTP 端口覆写 0（内核分配，避免与其他测试文件并发抢端口） */
  function resolveForTest(env) {
    return { ...resolveGatewayConfig(env), port: 0 };
  }

  const ENV_A = { allowSignup: true, defaultMaxPeers: 16, maxNetworksPerUser: 7, relayRateKbps: 128 };
  const ENV_B = { allowSignup: false, defaultMaxPeers: 64, maxNetworksPerUser: 50, relayRateKbps: 1048576 };
  const ENV_C = { allowSignup: false, defaultMaxPeers: 32, maxNetworksPerUser: 2, relayRateKbps: 512 };

  // GC-6b 扩展设置视图的公共段（本组测试未配 SMTP / API Key / publicUrl 的初始形态）
  const EXTENDED_SETTINGS_TAIL = {
    requireEmailVerification: false,
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
  };

  async function adminCookie(gw) {
    return login(gw.base, ADMIN_EMAIL, ADMIN_PASSWORD);
  }

  test('空库：环境配置 true/16/7/128 经生产组装播种，REST 实际读值一致', async () => {
    const gw = await startGateway(resolveForTest(envFor(makeDataDir(), ENV_A)));
    try {
      assert.equal(gw.admin.created, true);
      const cookie = await adminCookie(gw);
      const res = await api(gw.base, 'GET', '/api/v1/admin/settings', { cookie });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      // GC-6b 扩展设置视图：基础 4 键 + 脱敏扩展段（响应仍无密文/哈希字段）
      assert.deepEqual(res.json.data, {
        allowSignup: true,
        maxNetworksPerUser: 7,
        defaultMaxPeers: 16,
        relayRateKbps: 128,
        ...EXTENDED_SETTINGS_TAIL,
      });
      const raw = JSON.stringify(res.json);
      assert.ok(!raw.includes('smtpConfigEnc'));
      assert.ok(!raw.includes('adminApiKeyHash'));
      assert.ok(!raw.includes('password'));
    } finally {
      await gw.close();
    }
  });

  test('控制台修改持久化后，不同环境值重启不覆盖；admin 账号保持', async () => {
    const dataDir = makeDataDir();
    const gw1 = await startGateway(resolveForTest(envFor(dataDir, ENV_A)));
    try {
      const cookie = await adminCookie(gw1);
      const patched = await api(gw1.base, 'PATCH', '/api/v1/admin/settings', {
        body: { allowSignup: false, defaultMaxPeers: 24 },
        cookie,
      });
      assert.equal(patched.status, 200, JSON.stringify(patched.json));
      assert.equal(patched.json.data.allowSignup, false);
    } finally {
      await gw1.close(); // 前半步断言失败也归还已开的 HTTP/UDP/hub/store
    }

    // 全部四个键都已持久化：env_B 与库内值处处不同，重开后必须原样保留
    const gw2 = await startGateway(resolveForTest(envFor(dataDir, ENV_B)));
    try {
      const res = await api(gw2.base, 'GET', '/api/v1/admin/settings', { cookie: await adminCookie(gw2) });
      assert.deepEqual(res.json.data, {
        allowSignup: false, // 控制台改过
        maxNetworksPerUser: 7, // ENV_A 播种值，ENV_B 的 50 不得覆盖
        defaultMaxPeers: 24, // 控制台改过
        relayRateKbps: 128, // ENV_A 播种值，ENV_B 的 1048576 不得覆盖
        ...EXTENDED_SETTINGS_TAIL,
      });
    } finally {
      await gw2.close();
    }
  });

  test('缺键逐键补齐：删掉 relay_rate_kbps 后重开，只按本轮环境补该键，其余保留', async () => {
    const dataDir = makeDataDir();
    const gw1 = await startGateway(resolveForTest(envFor(dataDir, ENV_A)));
    try {
      const cookie = await adminCookie(gw1);
      const patched = await api(gw1.base, 'PATCH', '/api/v1/admin/settings', {
        body: { maxNetworksPerUser: 5 },
        cookie,
      });
      assert.equal(patched.status, 200, JSON.stringify(patched.json));
      const created = await api(gw1.base, 'POST', '/api/v1/networks', {
        body: { name: 'pc07-net', admissionMode: 'manual' },
        cookie,
      });
      assert.equal(created.status, 200, JSON.stringify(created.json));
    } finally {
      await gw1.close(); // 前半步断言失败也归还已开的 HTTP/UDP/hub/store
    }

    // 模拟旧版本库缺键：裸开 SQLite 删掉单个设置行
    const raw = new DatabaseSync(path.join(dataDir, 'gateway.sqlite'));
    try {
      raw.prepare('DELETE FROM system_settings WHERE key = ?').run(SETTINGS_KEYS.relayRateKbps);
    } finally {
      raw.close();
    }

    const gw2 = await startGateway(resolveForTest(envFor(dataDir, ENV_C)));
    try {
      const res = await api(gw2.base, 'GET', '/api/v1/admin/settings', { cookie: await adminCookie(gw2) });
      assert.deepEqual(res.json.data, {
        allowSignup: true, // ENV_A 播种值保留（ENV_C 是 false）
        maxNetworksPerUser: 5, // 控制台改过的值保留（ENV_C 是 2）
        defaultMaxPeers: 16, // ENV_A 播种值保留（ENV_C 是 32）
        relayRateKbps: 512, // 唯一缺失的键按本轮 ENV_C 补齐
        ...EXTENDED_SETTINGS_TAIL,
      });
      // admin 与其网络在两次重开后保持（初始化逻辑不得重置业务数据）
      const nets = await api(gw2.base, 'GET', '/api/v1/networks', { cookie: await adminCookie(gw2) });
      assert.equal(nets.status, 200);
      assert.ok(
        Array.isArray(nets.json.data) && nets.json.data.some((n) => n.name === 'pc07-net'),
        `pc07-net 必须在重开后保留：${JSON.stringify(nets.json.data)}`,
      );
    } finally {
      await gw2.close();
    }
  });
});

// ---------------------------------------------------------------- GC-10：控制台静态投递与管理全链路

// 假 SMTP（与 auth-otp-account.test.mjs 同一套零依赖 mock：明文会话、EHLO 广告
// AUTH、逐命令回 250、DATA 收完整 payload 记入 messages）。测试文件各自持有
// 一份实现，互不 import。
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

describe('GC-10：控制台静态投递（Observation C）', () => {
  test('GET /theme-init.js 200 JS；index.html 引用 /theme-init.js、页面内零内联 <script>；CONSOLE_CSP 逐字不变', async () => {
    const gw = await startTestGateway();
    try {
      const themeRes = await fetch(gw.base + '/theme-init.js');
      assert.equal(themeRes.status, 200);
      assert.match(themeRes.headers.get('content-type') ?? '', /^text\/javascript/, 'theme-init 必须以 JS 投递');
      assert.equal(themeRes.headers.get('cache-control'), 'no-cache');
      const themeJs = await themeRes.text();
      assert.match(themeJs, /data-theme/, 'theme-init 脚本必须在渲染前写 <html data-theme>');

      const res = await fetch(gw.base + '/');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(res.headers.get('content-security-policy'), CSP_EXPECTED, 'CONSOLE_CSP 必须逐字不变');
      const html = await res.text();
      assert.match(html, /<script[^>]*src="\/theme-init\.js"/, 'index.html 必须外链引用 /theme-init.js');

      // 页面内零内联 <script>：每个 script 标签都必须带 src（CSP 禁内联脚本，
      // 主题防闪走同源静态文件而不是 <script>alert(1)</script> 之类的内联块）
      const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
      assert.ok(scriptTags.length >= 2, 'index.html 至少含 theme-init 与入口 bundle 两个外链 script');
      for (const attrs of scriptTags) {
        assert.match(attrs, /\bsrc=/, `每个 <script> 都必须外链（CSP 禁内联脚本）：${attrs}`);
      }
    } finally {
      await gw.close();
    }
  });
});

describe('GC-10：管理全链路（假 SMTP + OTP 注册 + Bearer Key + 改密/找回 + 零秘密泄漏）', () => {
  const SMTP_SECRET = 'gc10-smtp-secret';
  const SIGNUP_EMAIL = 'gc10-user@example.com';
  const SIGNUP_PASSWORD = 'gc10-pass-1234';
  const AGENT_EMAIL = 'gc10-agent@example.com';

  let gw;
  let smtp;
  let smtpPort;
  let adminCookie;
  let apiKey = '';
  let userCookie = '';

  before(async () => {
    smtp = createFakeSmtp();
    smtpPort = await listen(smtp.server);
    gw = await startTestGateway({ allowSignup: true });
    adminCookie = await login(gw.base, ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  after(async () => {
    if (gw !== undefined) await gw.close().catch(() => {});
    if (smtp !== undefined) await closeServer(smtp.server);
  });

  test('PATCH /admin/settings 配置 SMTP → smtp-test 真实发信，假 SMTP 收到测试邮件', async () => {
    const patched = await api(gw.base, 'PATCH', '/api/v1/admin/settings', {
      body: {
        smtp: {
          host: '127.0.0.1',
          port: smtpPort,
          security: 'none',
          username: 'mailer@gateway.local',
          password: SMTP_SECRET,
          fromAddress: 'gateway@example.com',
          fromName: 'Zen Remote Gateway',
        },
      },
      cookie: adminCookie,
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    assert.equal(patched.json.data.smtp.configured, true);
    assert.equal(patched.json.data.smtp.hasPassword, true, '脱敏视图只给 hasPassword 布尔');
    assert.equal(patched.json.data.smtp.host, '127.0.0.1');

    const sent = await api(gw.base, 'POST', '/api/v1/admin/settings/smtp-test', {
      body: { toEmail: 'tester@example.com' },
      cookie: adminCookie,
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.deepEqual(sent.json.data, { sent: true });
    const last = smtp.state.messages.at(-1);
    assert.ok(last, 'smtp-test 必须产生真实发信');
    assert.equal(last.to, 'RCPT TO:<tester@example.com>');
    assert.match(last.payload, /Subject:/);
  });

  test('POST /admin/settings/api-key 生成 Bearer Key：明文仅本次返回，库里只有前缀与时刻', async () => {
    const res = await api(gw.base, 'POST', '/api/v1/admin/settings/api-key', { cookie: adminCookie });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    apiKey = res.json.data.apiKey;
    assert.match(apiKey, /^zr_adm_[0-9a-f]{48}$/);
    assert.equal(res.json.data.prefix, apiKey.slice(0, 14));
    assert.ok(!Number.isNaN(Date.parse(res.json.data.createdAt)));

    const view = await api(gw.base, 'GET', '/api/v1/admin/settings', { cookie: adminCookie });
    assert.equal(view.json.data.adminApiKey.configured, true);
    assert.equal(view.json.data.adminApiKey.prefix, apiKey.slice(0, 14));
    assert.ok(!JSON.stringify(view.json).includes(apiKey), '脱敏设置视图绝不回传密钥明文');
  });

  test('开启注册邮箱验证：send-otp → 假 SMTP 取码 → signup 建号建网', async () => {
    const enable = await api(gw.base, 'PATCH', '/api/v1/admin/settings', {
      body: { requireEmailVerification: true },
      cookie: adminCookie,
    });
    assert.equal(enable.status, 200, JSON.stringify(enable.json));
    assert.equal(enable.json.data.requireEmailVerification, true);

    const otp = await api(gw.base, 'POST', '/api/v1/auth/send-otp', {
      body: { email: SIGNUP_EMAIL, purpose: 'signup' },
    });
    assert.equal(otp.status, 200, JSON.stringify(otp.json));
    const code = otpFromMessage(smtp.state.messages.at(-1));
    assert.match(code, /^\d{6}$/);

    const signed = await api(gw.base, 'POST', '/api/v1/auth/signup', {
      body: { email: SIGNUP_EMAIL, password: SIGNUP_PASSWORD, otpCode: code },
    });
    assert.equal(signed.status, 200, JSON.stringify(signed.json));
    userCookie = sessionCookie(signed);
    assert.equal(signed.json.data.user.email, SIGNUP_EMAIL);

    const net = await api(gw.base, 'POST', '/api/v1/networks', {
      body: { name: 'gc10-net', admissionMode: 'key' },
      cookie: userCookie,
    });
    assert.equal(net.status, 200, JSON.stringify(net.json));
    assert.match(net.json.data.joinUri, /^zr-net:\/\//);
  });

  test('管理员建组/改组/到期回退：新组速率与配额经 /auth/me 即时生效', async () => {
    const group = await api(gw.base, 'POST', '/api/v1/admin/groups', {
      body: {
        code: 'gc10pro',
        name: 'GC10 Pro',
        maxNetworks: 10,
        maxPeersPerNetwork: 16,
        relayRateKbps: 65536,
        monthlyRelayQuotaBytes: 1073741824,
      },
      cookie: adminCookie,
    });
    assert.equal(group.status, 200, JSON.stringify(group.json));
    const groupId = group.json.data.id;

    const users = await api(gw.base, 'GET', '/api/v1/admin/users', { cookie: adminCookie });
    const target = users.json.data.find((u) => u.email === SIGNUP_EMAIL);
    assert.ok(target, '用户列表应含新注册用户');

    const moved = await api(gw.base, 'PATCH', `/api/v1/admin/users/${target.id}`, {
      body: { groupId, groupExpiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      cookie: adminCookie,
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    assert.equal(moved.json.data.effectiveGroupId, groupId);
    assert.equal(moved.json.data.isExpiredFallback, false);

    const me = await api(gw.base, 'GET', '/api/v1/auth/me', { cookie: userCookie });
    assert.equal(me.json.data.quota.groupId, groupId);
    assert.equal(me.json.data.quota.relayRateKbps, 65536, '单设备限速必须即时跟随新组');
    assert.equal(me.json.data.quota.monthlyRelayQuotaBytes, 1073741824);

    const expired = await api(gw.base, 'PATCH', `/api/v1/admin/users/${target.id}`, {
      body: { groupExpiresAt: new Date(Date.now() - 1000).toISOString() },
      cookie: adminCookie,
    });
    assert.equal(expired.status, 200);
    assert.equal(expired.json.data.isExpiredFallback, true, '到期必须标记回退');
    const meAfter = await api(gw.base, 'GET', '/api/v1/auth/me', { cookie: userCookie });
    assert.notEqual(meAfter.json.data.quota.groupId, groupId, '到期后生效组必须回到默认组');

    const renewed = await api(gw.base, 'PATCH', `/api/v1/admin/users/${target.id}`, {
      body: { groupExpiresAt: null },
      cookie: adminCookie,
    });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.json.data.isExpiredFallback, false);
  });

  test('热改 publicUrl：新建网络的 joinUri 立即使用新域名；清空后回退请求推断', async () => {
    const setUrl = await api(gw.base, 'PATCH', '/api/v1/admin/settings', {
      body: { publicUrl: 'https://gc10.example.com' },
      cookie: adminCookie,
    });
    assert.equal(setUrl.status, 200, JSON.stringify(setUrl.json));
    assert.equal(setUrl.json.data.publicUrl, 'https://gc10.example.com');

    const net = await api(gw.base, 'POST', '/api/v1/networks', {
      body: { name: 'gc10-hot-url', admissionMode: 'key' },
      cookie: userCookie,
    });
    assert.equal(net.status, 200, JSON.stringify(net.json));
    // 反代 443/80 未显式写端口时生成器补齐默认端口（buildJoinEndpoint 契约），两种形态都算跟随
    assert.match(net.json.data.joinUri, /^zr-net:\/\/gc10\.example\.com(:443)?\//, 'joinUri 必须立即跟随新 publicUrl');

    const cleared = await api(gw.base, 'PATCH', '/api/v1/admin/settings', {
      body: { publicUrl: null },
      cookie: adminCookie,
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.data.publicUrl, null);
    const fallback = await api(gw.base, 'POST', '/api/v1/networks', {
      body: { name: 'gc10-fallback', admissionMode: 'key' },
      cookie: userCookie,
    });
    assert.equal(fallback.status, 200);
    assert.doesNotMatch(fallback.json.data.joinUri, /gc10\.example\.com/, '清空后必须回落请求头推断');
  });

  test('外部 Bearer zr_adm_ Key 直调 /admin/*：无 Cookie 跨站改到期日成功；无效 Key 401', async () => {
    const list = await api(gw.base, 'GET', '/api/v1/admin/users', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(list.status, 200, JSON.stringify(list.json));
    const target = list.json.data.find((u) => u.email === SIGNUP_EMAIL);
    assert.ok(target);

    const futureIso = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const patched = await api(gw.base, 'PATCH', `/api/v1/admin/users/${target.id}`, {
      body: { groupExpiresAt: futureIso },
      headers: { authorization: `Bearer ${apiKey}`, origin: 'https://billing.example', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    assert.equal(patched.json.data.groupExpiresAt, futureIso);

    const me = await api(gw.base, 'GET', '/api/v1/auth/me', { cookie: userCookie });
    assert.equal(me.json.data.quota.groupExpiresAt, futureIso, '外部系统的续期必须对用户即刻可见');

    const bad = await api(gw.base, 'GET', '/api/v1/admin/users', {
      headers: { authorization: `Bearer zr_adm_${'0'.repeat(48)}` },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error?.code, 'INVALID_API_KEY');
  });

  test('账户设置改密：当前会话保留、他端会话与旧密码全部失效', async () => {
    const second = await api(gw.base, 'POST', '/api/v1/auth/login', {
      body: { email: SIGNUP_EMAIL, password: SIGNUP_PASSWORD },
    });
    assert.equal(second.status, 200);
    const otherSession = sessionCookie(second);

    const changed = await api(gw.base, 'PATCH', '/api/v1/auth/account/password', {
      body: { currentPassword: SIGNUP_PASSWORD, newPassword: 'gc10-new-pass-456' },
      cookie: userCookie,
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.deepEqual(changed.json.data, { changed: true });

    const meStill = await api(gw.base, 'GET', '/api/v1/auth/me', { cookie: userCookie });
    assert.equal(meStill.status, 200, '改密后当前会话必须保留');
    assert.equal(meStill.json.data.authenticated, true);
    // 被吊销的会话访问 /auth/me 回匿名形态（200 + authenticated:false），业务接口才是硬 401
    const meOther = await api(gw.base, 'GET', '/api/v1/auth/me', { cookie: otherSession });
    assert.equal(meOther.status, 200);
    assert.equal(meOther.json.data.authenticated, false, '其他端会话必须被吊销（/auth/me 匿名形态）');
    const otherNetworks = await api(gw.base, 'GET', '/api/v1/networks', { cookie: otherSession });
    assert.equal(otherNetworks.status, 401, '其他端会话访问业务接口必须 401');
    const oldLogin = await api(gw.base, 'POST', '/api/v1/auth/login', {
      body: { email: SIGNUP_EMAIL, password: SIGNUP_PASSWORD },
    });
    assert.equal(oldLogin.status, 401);
  });

  test('忘记密码重置：全端会话失效，新密码可登录', async () => {
    const otp = await api(gw.base, 'POST', '/api/v1/auth/send-otp', {
      body: { email: SIGNUP_EMAIL, purpose: 'reset_password' },
    });
    assert.equal(otp.status, 200, JSON.stringify(otp.json));
    const code = otpFromMessage(smtp.state.messages.at(-1));

    const reset = await api(gw.base, 'POST', '/api/v1/auth/reset-password', {
      body: { email: SIGNUP_EMAIL, otpCode: code, newPassword: 'gc10-reset-pass-789' },
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    assert.deepEqual(reset.json.data, { reset: true });

    const meOld = await api(gw.base, 'GET', '/api/v1/auth/me', { cookie: userCookie });
    assert.equal(meOld.status, 200);
    assert.equal(meOld.json.data.authenticated, false, '重置后全部历史会话必须失效（/auth/me 匿名形态）');
    const oldNetworks = await api(gw.base, 'GET', '/api/v1/networks', { cookie: userCookie });
    assert.equal(oldNetworks.status, 401, '重置后旧会话访问业务接口必须 401');
    const relogin = await api(gw.base, 'POST', '/api/v1/auth/login', {
      body: { email: SIGNUP_EMAIL, password: 'gc10-reset-pass-789' },
    });
    assert.equal(relogin.status, 200);
    userCookie = sessionCookie(relogin);
  });

  test('管理员创建用户（留空密码）与重置密码：generatedPassword 仅本次返回且可登录', async () => {
    const created = await api(gw.base, 'POST', '/api/v1/admin/users', {
      body: { email: AGENT_EMAIL, role: 'user' },
      cookie: adminCookie,
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const firstPassword = created.json.data.generatedPassword;
    assert.ok(firstPassword, '留空密码必须返回一次性 generatedPassword');
    assert.equal(firstPassword.length, 16);
    const loginWith = await api(gw.base, 'POST', '/api/v1/auth/login', {
      body: { email: AGENT_EMAIL, password: firstPassword },
    });
    assert.equal(loginWith.status, 200, '一次性密码必须能立即登录');

    const reset = await api(gw.base, 'POST', `/api/v1/admin/users/${created.json.data.id}/reset-password`, {
      body: {},
      cookie: adminCookie,
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    const secondPassword = reset.json.data.generatedPassword;
    assert.ok(secondPassword && secondPassword.length === 16 && secondPassword !== firstPassword);
    const oldAfter = await api(gw.base, 'POST', '/api/v1/auth/login', {
      body: { email: AGENT_EMAIL, password: firstPassword },
    });
    assert.equal(oldAfter.status, 401, '重置后旧密码必须失效');
  });

  test('零秘密泄漏：/api/v1/admin/*、/auth/me 与全部前端静态资源都不含密钥/密码明文', async () => {
    const surfaces = [];
    for (const path of ['/api/v1/admin/users', '/api/v1/admin/settings', '/api/v1/admin/runtime', '/api/v1/admin/groups']) {
      surfaces.push(await api(gw.base, 'GET', path, { cookie: adminCookie }));
    }
    surfaces.push(await api(gw.base, 'GET', '/api/v1/auth/me', { cookie: userCookie }));
    for (const res of surfaces) {
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const raw = JSON.stringify(res.json);
      for (const secret of [apiKey, SMTP_SECRET, 'passwordHash', 'smtpConfigEnc', 'adminApiKeyHash']) {
        assert.ok(!raw.includes(secret), `管理/会话响应不得包含 ${secret}`);
      }
    }

    const html = await (await fetch(gw.base + '/')).text();
    const assetRefs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(assetRefs.length > 0);
    for (const ref of assetRefs) {
      const asset = await (await fetch(gw.base + ref)).text();
      for (const secret of [apiKey, SMTP_SECRET, SIGNUP_PASSWORD, 'gc10-reset-pass-789', 'gc10-new-pass-456']) {
        assert.ok(!asset.includes(secret), `静态资源不得包含运行期秘密：${ref}`);
      }
    }

    const themeJs = await (await fetch(gw.base + '/theme-init.js')).text();
    assert.ok(!themeJs.includes(apiKey) && !themeJs.includes(SMTP_SECRET));
  });
});
