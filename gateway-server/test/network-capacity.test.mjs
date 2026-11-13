// PC-08a 网络容量变更广播：真实 REST PATCH → GatewayHooks → WS 的端到端契约。
// 覆盖：authorized 在线连接收 network-updated（跨网络隔离）、同值重复幂等与
// 仅改 name 不伪造、hanging/paused 池快照更新使 approve/resume welcome 带最新
// 容量、认证在途遇 PATCH 静默关闭重连取新值、两次 PATCH 异步乱序不回灌、
// 旧节点（无消费者）PATCH 后仍可中转且重连 welcome 带最新 maxPeers。
// 与其他测试相同：真实 http.Server + SqliteStore(:memory:)，.mjs 直接 import ../dist/。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createGatewayApiServer } from '../dist/server.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import { deriveMasterKeyFromSecret, hashPassword } from '../dist/master-key.js';
import { PeerWsHub } from '../dist/peer-hub/ws-hub.js';
import WebSocket from 'ws';

const ADMIN_EMAIL = 'admin@local';
const ADMIN_PASSWORD = 'admin-pass-1234';
const TENANT_EMAIL = 'tenant@local';
const TENANT_PASSWORD = 'tenant-pass-1234';

// ---------------------------------------------------------------- 节点身份（与 peer-hub.test.mjs 同一套自证明方案）

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

// ---------------------------------------------------------------- 28B 帧头 + 假密文载荷（中转兼容性用）

function frame({ src, dst, type = 3, streamId = 1, seq = 1n, payloadBytes = 16 }) {
  const header = Buffer.alloc(28);
  header.writeUInt16BE(0x5a52, 0);
  header.writeUInt8(0x01, 2);
  header.writeUInt8(type, 3);
  header.write(src, 4, 'hex');
  header.write(dst, 8, 'hex');
  header.writeUInt32BE(streamId, 12);
  header.writeBigUInt64BE(seq, 16);
  header.writeUInt32BE(0, 24);
  return Buffer.concat([header, crypto.randomBytes(payloadBytes)]);
}

// ---------------------------------------------------------------- WS 客户端工具（与 peer-hub.test.mjs 同款）

function attachWsDispatcher(ws) {
  ws.__textQueue = [];
  ws.__binaryQueue = [];
  ws.__textWaiters = [];
  ws.__binaryWaiters = [];
  ws.__arrivalCount = 0;
  ws.__closed = false;
  ws.on('close', () => {
    ws.__closed = true;
  });
  ws.on('message', (data, isBinary) => {
    ws.__arrivalCount += 1;
    const buf = Buffer.from(data);
    if (isBinary) {
      const waiter = ws.__binaryWaiters.shift();
      if (waiter !== undefined) waiter(buf);
      else ws.__binaryQueue.push(buf);
      return;
    }
    let json;
    try { json = JSON.parse(buf.toString('utf8')); } catch { json = { __raw: buf.toString('utf8') }; }
    const waiter = ws.__textWaiters.shift();
    if (waiter !== undefined) waiter(json);
    else ws.__textQueue.push(json);
  });
}

function wsOpen(base, path = '/peer/v1/ws') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + path);
    attachWsDispatcher(ws);
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 2000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function wsJson(ws, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws message timeout')), timeoutMs);
    const deliver = (json) => { clearTimeout(timer); resolve(json); };
    if (ws.__textQueue.length > 0) deliver(ws.__textQueue.shift());
    else ws.__textWaiters.push(deliver);
  });
}

function wsBinary(ws, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws binary timeout')), timeoutMs);
    const deliver = (buf) => { clearTimeout(timer); resolve(buf); };
    if (ws.__binaryQueue.length > 0) deliver(ws.__binaryQueue.shift());
    else ws.__binaryWaiters.push(deliver);
  });
}

function wsSilence(ws, ms = 300) {
  return new Promise((resolve, reject) => {
    if (ws.__textQueue.length > 0 || ws.__binaryQueue.length > 0) {
      reject(new Error(`expected silence, got queued message: ${JSON.stringify(ws.__textQueue[0]) ?? ''}`));
      return;
    }
    const before = ws.__arrivalCount;
    const timer = setTimeout(() => {
      if (ws.__arrivalCount !== before) reject(new Error('expected silence, got a message'));
      else resolve();
    }, ms);
  });
}

function wsClosed(ws, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    if (ws.__closed) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('ws close timeout')), timeoutMs);
    ws.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

function wsSendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

async function authNode(ws, node, { networkId, joinKey, name, timestamp = Date.now(), omitProof = false, pauseHold = false } = {}) {
  const challenge = await wsJson(ws);
  assert.equal(challenge.type, 'challenge');
  const signatureHex = edSign(node.privateKeyHex, node.publicKeyHex, authMessage(networkId, node.nodeId, challenge.challengeHex, timestamp));
  const auth = {
    type: 'auth',
    networkId,
    nodeId: node.nodeId,
    publicKeyHex: node.publicKeyHex,
    name: name ?? `node-${node.nodeId}`,
    lanEndpoints: [],
    timestamp,
    signatureHex,
  };
  if (joinKey !== undefined && !omitProof) {
    auth.joinKeyProofHex = joinProof(joinKey, networkId, node.nodeId, challenge.challengeHex);
  }
  if (pauseHold) auth.pauseHold = true;
  wsSendJson(ws, auth);
  return challenge;
}

// ---------------------------------------------------------------- REST 工具（与 peer-hub.test.mjs 同款）

async function api(base, method, path, { body, cookie } = {}) {
  const headers = {};
  if (cookie !== undefined) headers.cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
    headers.origin = base;
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}

async function createNetwork(gw, { mode = 'key', maxPeers } = {}) {
  const res = await api(gw.base, 'POST', '/api/v1/networks', {
    body: { name: `net-${Math.random().toString(36).slice(2, 8)}`, admissionMode: mode, ...(maxPeers !== undefined ? { maxPeers } : {}) },
    cookie: gw.tenantCookie,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.data;
}

async function patchNetwork(gw, networkId, body) {
  const res = await api(gw.base, 'PATCH', `/api/v1/networks/${networkId}`, { body, cookie: gw.tenantCookie });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.data;
}

// ---------------------------------------------------------------- 网关组装（无 STUN：本单不涉 UDP）

async function startGateway() {
  const store = new SqliteStore({
    seed: { allowSignup: false, maxNetworksPerUser: 4, defaultMaxPeers: 8, relayRateKbps: 64 },
  });
  const masterKey = deriveMasterKeyFromSecret('network-capacity-test');
  const hub = new PeerWsHub({ store, masterKey, rateTickMs: null, flushMs: null });
  const server = createGatewayApiServer({ store, masterKey, runtime: hub, hooks: hub.hooks, topology: hub });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  hub.attach(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  await store.ensureBootstrapAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  await store.createUser({ email: TENANT_EMAIL, passwordHash: await hashPassword(TENANT_PASSWORD), role: 'user' });
  const loginRes = await fetch(base + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: TENANT_EMAIL, password: TENANT_PASSWORD }),
  });
  const tenantCookie = loginRes.headers.getSetCookie().find((c) => c.startsWith('zr_gw_session=')).split(';')[0];
  const close = async () => {
    await hub.close();
    await new Promise((resolve) => {
      server.closeIdleConnections?.();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await store.close();
  };
  return { store, hub, base, tenantCookie, close };
}

/** key 模式建网 + 单节点 authorized，读完入网期消息，返回干净句柄 */
async function setupSingleNode(gw, { maxPeers = 4, pauseHold = false, name = 'solo' } = {}) {
  const net = await createNetwork(gw, { mode: 'key', maxPeers });
  const node = identity();
  const ws = await wsOpen(gw.base);
  await authNode(ws, node, { networkId: net.id, joinKey: net.joinKey, name, pauseHold });
  const welcome = await wsJson(ws);
  assert.equal(welcome.type, 'welcome');
  assert.equal(welcome.status, 'authorized');
  assert.equal(welcome.maxPeers, maxPeers);
  return { net, node, ws };
}

/**
 * 给 store 的某个异步方法按调用序号设闸：第 callIndex 次调用时通知 entered 并
 * 停住，直到 release() 才放行。用于制造「PATCH 持久化与 hook 读取之间」「认证
 * 中途」的有界正常交错；finally 里必须 release，失败也不能挂住。
 */
function gateStoreCall(store, method, callIndex, { enteredTimeoutMs = 2000 } = {}) {
  const original = store[method].bind(store);
  let calls = 0;
  let enteredResolve;
  let enteredReject;
  let release;
  // entered 带 deadline：闸口等不到目标调用（如修复前 hook 不存在）时让测试
  // 有界失败，绝不挂住整个进程
  const entered = new Promise((resolve, reject) => {
    enteredResolve = resolve;
    enteredReject = () => reject(new Error(`gated call #${callIndex} of ${method} never happened`));
    const timer = setTimeout(() => enteredReject(), enteredTimeoutMs);
    timer.unref?.();
  });
  const gate = new Promise((resolve) => { release = resolve; });
  store[method] = async (...args) => {
    calls += 1;
    if (calls === callIndex) {
      enteredResolve();
      await gate;
    }
    return original(...args);
  };
  return { entered, release };
}

/**
 * fix1 Required 1 专用：第 callIndex 次调用先真实执行拿到快照，再扣住**结果**
 * 直到 release()。与 gateStoreCall（读前停、放行后才读新值）互补——这里模拟
 * 「异步查询返回的是读时快照，迟到完成带着旧值」的真实交错。
 */
function holdStoreResult(store, method, callIndex, { enteredTimeoutMs = 2000 } = {}) {
  const original = store[method].bind(store);
  let calls = 0;
  let enteredResolve;
  let release;
  const entered = new Promise((resolve, reject) => {
    enteredResolve = resolve;
    const timer = setTimeout(() => reject(new Error(`held call #${callIndex} of ${method} never happened`)), enteredTimeoutMs);
    timer.unref?.();
  });
  const gate = new Promise((resolve) => { release = resolve; });
  store[method] = async (...args) => {
    calls += 1;
    if (calls === callIndex) {
      enteredResolve();
      const value = await original(...args); // 先读库：快照已在手
      await gate; // 再扣住结果，让更新的 PATCH 完整落地
      return value;
    }
    return original(...args);
  };
  return { entered, release };
}

/**
 * fix1 Required 2 专用：从安装起第 nth 次调用抛一次临时错误（模拟瞬时读库
 * 失败），一次性、之后自动恢复原行为；restore() 供 finally 兜底，避免串扰
 * 后续测试步骤。
 */
function failStoreCallOnce(store, method, nth) {
  const original = store[method].bind(store);
  let calls = 0;
  let spent = false;
  store[method] = async (...args) => {
    calls += 1;
    if (!spent && calls === nth) {
      spent = true;
      throw new Error('simulated transient store failure');
    }
    return original(...args);
  };
  return {
    restore: () => {
      spent = true;
      store[method] = original;
    },
  };
}

// ---------------------------------------------------------------- 测试

describe('PC-08a 网络容量变更广播', () => {
  test('真实 PATCH maxPeers 后本网在线连接收 network-updated，其他网络无消息', async () => {
    const gw = await startGateway();
    try {
      const first = await setupSingleNode(gw, { maxPeers: 4, name: 'alpha' });
      const second = await setupSingleNode(gw, { maxPeers: 4, name: 'bravo' });

      const view = await patchNetwork(gw, first.net.id, { maxPeers: 10 });
      assert.equal(view.maxPeers, 10, 'PATCH 响应携带新容量');

      const updated = await wsJson(first.ws);
      assert.equal(updated.type, 'network-updated');
      assert.equal(updated.networkId, first.net.id);
      assert.equal(updated.maxPeers, 10, '增量消息携带网络总席位原始值');
      assert.equal('joinKey' in updated, false, '控制消息不携带 joinKey 等设置');

      await wsSilence(second.ws, 300);
    } finally {
      await gw.close();
    }
  });

  test('重复相同容量 PATCH 幂等；仅改 name 不伪造容量变化', async () => {
    const gw = await startGateway();
    try {
      const { net, ws } = await setupSingleNode(gw, { maxPeers: 4 });

      await patchNetwork(gw, net.id, { maxPeers: 10 });
      const updated = await wsJson(ws);
      assert.equal(updated.type, 'network-updated');
      assert.equal(updated.maxPeers, 10);

      await patchNetwork(gw, net.id, { maxPeers: 10 });
      await patchNetwork(gw, net.id, { name: 'renamed-only' });
      await patchNetwork(gw, net.id, { admissionMode: 'manual' });
      await wsSilence(ws, 300);
    } finally {
      await gw.close();
    }
  });

  test('hanging 快照更新：pending 连接不收推送，approve 后 welcome 带最新容量', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'manual', maxPeers: 4 });
      const pending = identity();
      const wsPending = await wsOpen(gw.base);
      await authNode(wsPending, pending, { networkId: net.id, omitProof: true, name: 'waiter' });
      const hanging = await wsJson(wsPending);
      assert.equal(hanging.type, 'welcome');
      assert.equal(hanging.status, 'pending');
      assert.equal(hanging.maxPeers, 4);

      await patchNetwork(gw, net.id, { maxPeers: 12 });
      await wsSilence(wsPending, 300); // 挂起连接只更新快照，不收增量消息

      const res = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${pending.nodeId}/approve`, { cookie: gw.tenantCookie });
      assert.equal(res.status, 200);
      const promoted = await wsJson(wsPending);
      assert.equal(promoted.type, 'welcome');
      assert.equal(promoted.status, 'authorized');
      assert.equal(promoted.maxPeers, 12, 'approve welcome 用最新容量而非握手旧值');
    } finally {
      await gw.close();
    }
  });

  test('paused 快照更新：暂停期间不收推送，resume 后 welcome 带最新容量', async () => {
    const gw = await startGateway();
    try {
      const { net, node, ws } = await setupSingleNode(gw, { maxPeers: 4, pauseHold: true });

      const res = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${node.nodeId}/pause`, { cookie: gw.tenantCookie });
      assert.equal(res.status, 200);
      const paused = await wsJson(ws);
      assert.equal(paused.type, 'paused');

      await patchNetwork(gw, net.id, { maxPeers: 7 });
      await wsSilence(ws, 300); // 暂停的受限控制通道不收容量推送

      const resumeRes = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${node.nodeId}/resume`, { cookie: gw.tenantCookie });
      assert.equal(resumeRes.status, 200);
      const restored = await wsJson(ws);
      assert.equal(restored.type, 'welcome');
      assert.equal(restored.status, 'authorized');
      assert.equal(restored.maxPeers, 7, 'resume welcome 用最新容量而非握手旧值');
    } finally {
      await gw.close();
    }
  });

  test('认证在途遇容量 PATCH：静默关闭不落旧快照，重连 pending welcome 带新容量', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'manual', maxPeers: 4 });
      const gate = gateStoreCall(gw.store, 'upsertMemberJoinAttempt', 1);
      const joiner = identity();
      const wsJoiner = await wsOpen(gw.base);
      try {
        await authNode(wsJoiner, joiner, { networkId: net.id, omitProof: true, name: 'inflight' });
        await gate.entered; // 认证已推进到成员写入：此后 PATCH 落在握手窗口内

        await patchNetwork(gw, net.id, { maxPeers: 9 });
      } finally {
        gate.release(); // 无论断言成败都放行，不让认证挂住
      }
      await wsClosed(wsJoiner);
      assert.equal(wsJoiner.__textQueue.length, 0, '静默关闭：不发 welcome 也不发 denied');

      const wsRetry = await wsOpen(gw.base);
      await authNode(wsRetry, joiner, { networkId: net.id, omitProof: true, name: 'inflight' });
      const rewelcome = await wsJson(wsRetry);
      assert.equal(rewelcome.type, 'welcome');
      assert.equal(rewelcome.status, 'pending');
      assert.equal(rewelcome.maxPeers, 9, '重连认证按库中新值放行');
      wsRetry.close();
    } finally {
      await gw.close();
    }
  });

  test('两次 PATCH 异步乱序完成：迟到回调读当前事实，旧容量不回灌', async () => {
    const gw = await startGateway();
    try {
      const { net, ws } = await setupSingleNode(gw, { maxPeers: 4 });
      // 每个 PATCH 恰好两次异步 getNetwork：#1 路由归属校验、#2 hub hook 读事实。
      // 闸住第一单的 #2，让第二单完整落地后再放行，制造 hook 乱序。
      const gate = gateStoreCall(gw.store, 'getNetwork', 2);
      const firstPatch = patchNetwork(gw, net.id, { maxPeers: 10 });
      await gate.entered;
      try {
        const secondView = await patchNetwork(gw, net.id, { maxPeers: 20 });
        assert.equal(secondView.maxPeers, 20);
      } finally {
        gate.release();
      }
      const firstView = await firstPatch;
      assert.equal(firstView.maxPeers, 10);

      const updated = await wsJson(ws);
      assert.equal(updated.type, 'network-updated');
      assert.equal(updated.maxPeers, 20, '只播报当前事实（20），不回灌旧值 10');
      await wsSilence(ws, 300);
    } finally {
      await gw.close();
    }
  });

  test('旧节点无消费者：PATCH 后二进制中转不受影响，重连 welcome 带最新容量', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'key', maxPeers: 4 });
      const a = identity();
      const b = identity();
      const wsA = await wsOpen(gw.base);
      await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey, name: 'alpha' });
      assert.equal((await wsJson(wsA)).status, 'authorized');
      const wsB = await wsOpen(gw.base);
      await authNode(wsB, b, { networkId: net.id, joinKey: net.joinKey, name: 'bravo' });
      const welcomeB = await wsJson(wsB);
      assert.equal(welcomeB.status, 'authorized');
      await wsJson(wsB); // punch-coordinate
      await wsJson(wsA); // peer-joined
      await wsJson(wsA); // punch-coordinate

      await patchNetwork(gw, net.id, { maxPeers: 15 });
      assert.equal((await wsJson(wsA)).maxPeers, 15);
      assert.equal((await wsJson(wsB)).maxPeers, 15);

      // 无消费者的旧节点照常收发二进制帧（网关零明文转发不看容量消息）
      wsA.send(frame({ src: a.nodeId, dst: b.nodeId }), { binary: true });
      const relayed = await wsBinary(wsB);
      assert.equal(relayed.subarray(0, 28).toString('hex').slice(8, 16), a.nodeId, '帧头 src 原样到达');

      // 重连（正常 welcome 路径）拿最新容量
      wsA.close();
      await wsClosed(wsA);
      assert.equal((await wsJson(wsB)).type, 'peer-left');
      const wsA2 = await wsOpen(gw.base);
      await authNode(wsA2, a, { networkId: net.id, joinKey: net.joinKey, name: 'alpha' });
      const rewelcome = await wsJson(wsA2);
      assert.equal(rewelcome.status, 'authorized');
      assert.equal(rewelcome.maxPeers, 15, '重连 welcome 带最新 maxPeers');
      wsA2.close();
      wsB.close();
    } finally {
      await gw.close();
    }
  });
});

// ---------------------------------------------------------------- PC-08a fix1：读取完成乱序与旧缓存阻断

describe('PC-08a fix1 乱序迟到快照与传播失败恢复', () => {
  test('迟到完成的旧读取快照不回灌：hook 已读到 10，广播 20 之后旧结果才返回', async () => {
    const gw = await startGateway();
    try {
      const { net, ws } = await setupSingleNode(gw, { maxPeers: 4 });
      // 与 gateStoreCall（读前停）不同：这次先真实执行读库、拿到旧快照后再扣住
      // 结果——第 1 单 hook 实际读到 10；第 2 单完整落地广播 20 后才放行旧结果
      const hold = holdStoreResult(gw.store, 'getNetwork', 2);
      const firstPatch = patchNetwork(gw, net.id, { maxPeers: 10 });
      await hold.entered;
      try {
        const secondView = await patchNetwork(gw, net.id, { maxPeers: 20 });
        assert.equal(secondView.maxPeers, 20);
        const applied = await wsJson(ws);
        assert.equal(applied.type, 'network-updated');
        assert.equal(applied.maxPeers, 20, '第 2 单完整落地：广播 20');
      } finally {
        hold.release(); // finally 必放行，失败也不挂住
      }
      await firstPatch;

      // 旧快照 10 迟到返回：不得改写缓存/池、不得广播旧值（修复前这里会收到 10）
      await wsSilence(ws, 300);
    } finally {
      await gw.close();
    }
  });

  test('传播读库临时失败不阻断认证：新 auth 直读库落地 20，重试同值 PATCH 收敛在线连接', async () => {
    const gw = await startGateway();
    try {
      const { net, ws } = await setupSingleNode(gw, { maxPeers: 4 });
      // 基线：10 成功传播
      await patchNetwork(gw, net.id, { maxPeers: 10 });
      assert.equal((await wsJson(ws)).maxPeers, 10);

      // 第 2 次 getNetwork（= 本次 PATCH 的 hook 读取）失败一次：PATCH 落库成功、传播静默失败
      const failOnce = failStoreCallOnce(gw.store, 'getNetwork', 2);
      try {
        const view = await patchNetwork(gw, net.id, { maxPeers: 20 });
        assert.equal(view.maxPeers, 20, 'PATCH 本身不回滚（runHook 既有语义）');
      } finally {
        failOnce.restore();
      }
      await wsSilence(ws, 300); // 传播失败：无推送、缓存仍停在 10

      // 新 auth 直读库拿到 20：不得因广播缓存 10 被反复关闭（修复前这里 close 1013 循环）
      const joiner = identity();
      const wsJoiner = await wsOpen(gw.base);
      await authNode(wsJoiner, joiner, { networkId: net.id, joinKey: net.joinKey, name: 'fresh-joiner' });
      const welcome = await wsJson(wsJoiner);
      assert.equal(welcome.type, 'welcome');
      assert.equal(welcome.status, 'authorized');
      assert.equal(welcome.maxPeers, 20, '缓存滞后不得把读到最新真值的认证挡在门外');

      // A 侧消化新节点的 join 生命周期消息，避免混入后续恢复断言
      assert.equal((await wsJson(ws)).type, 'peer-joined');
      assert.equal((await wsJson(ws)).type, 'punch-coordinate');

      // 恢复后重试同值 PATCH 20：不得被幂等缓存吞掉，在线连接收敛到 20
      await patchNetwork(gw, net.id, { maxPeers: 20 });
      const recovered = await wsJson(ws);
      assert.equal(recovered.type, 'network-updated');
      assert.equal(recovered.maxPeers, 20, '失败过的传播由重试 PATCH 恢复');
      await wsJson(wsJoiner); // 入网期发给新节点的 punch-coordinate
      assert.equal((await wsJson(wsJoiner)).maxPeers, 20, '第二个在线连接同步收敛');
      await wsSilence(ws, 300);
      wsJoiner.close();
    } finally {
      await gw.close();
    }
  });

  test('传播失败后 approve/resume 收敛库中最新容量：不靠先前成功广播的快照', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'manual', maxPeers: 4 });
      const waiter = identity();
      const wsWaiter = await wsOpen(gw.base);
      await authNode(wsWaiter, waiter, { networkId: net.id, omitProof: true, name: 'waiter' });
      const hanging = await wsJson(wsWaiter);
      assert.equal(hanging.status, 'pending');
      assert.equal(hanging.maxPeers, 4, '握手期快照是当时的库值 4');

      // PATCH 20 落库成功但传播读库失败一次：挂起连接快照仍是 4
      const failOnce = failStoreCallOnce(gw.store, 'getNetwork', 2);
      try {
        assert.equal((await patchNetwork(gw, net.id, { maxPeers: 20 })).maxPeers, 20);
      } finally {
        failOnce.restore();
      }
      await wsSilence(wsWaiter, 300);

      // approve 晋升：welcome 必须用库中最新 20，而非握手旧值 4（修复前发 4）
      const res = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${waiter.nodeId}/approve`, { cookie: gw.tenantCookie });
      assert.equal(res.status, 200);
      const promoted = await wsJson(wsWaiter);
      assert.equal(promoted.type, 'welcome');
      assert.equal(promoted.status, 'authorized');
      assert.equal(promoted.maxPeers, 20, '晋升 welcome 以库中最新事实收敛，不靠广播快照');
    } finally {
      await gw.close();
    }
  });

  test('认证读取前捕获版本：旧读结果迟到返回不落过期 welcome', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'key', maxPeers: 4 });
      // auth 的 getNetwork 是本网关第 1 次调用：先真实读到旧容量 4，再扣住
      // **返回结果**（读前等待的闸无鉴别力——放行后才读会直接拿到新值）
      const hold = holdStoreResult(gw.store, 'getNetwork', 1);
      const joiner = identity();
      const wsJoiner = await wsOpen(gw.base);
      try {
        await authNode(wsJoiner, joiner, { networkId: net.id, joinKey: net.joinKey, name: 'late-reader' });
        await hold.entered; // 读库已真实执行，旧快照 4 在手、尚未返回

        // PATCH 9 正常完整落地：hook 应用、事实代次推进（此刻无任何池连接）
        await patchNetwork(gw, net.id, { maxPeers: 9 });
      } finally {
        hold.release(); // finally 必放行，失败也不挂住
      }

      // 旧读结果返回：若版本在拿到旧数据后才捕获，会配到新代次、过期 4 落地。
      // 正确行为是按发出时刻的代次判定失配 → 静默关闭，无 welcome 无 denied
      await wsClosed(wsJoiner);
      assert.equal(wsJoiner.__textQueue.length, 0, '不发过期 welcome 也不发 denied');

      // 关闭后正常重新认证拿新容量
      const wsRetry = await wsOpen(gw.base);
      await authNode(wsRetry, joiner, { networkId: net.id, joinKey: net.joinKey, name: 'late-reader' });
      const rewelcome = await wsJson(wsRetry);
      assert.equal(rewelcome.type, 'welcome');
      assert.equal(rewelcome.status, 'authorized');
      assert.equal(rewelcome.maxPeers, 9, '重连认证按库中新值放行');
      wsRetry.close();
    } finally {
      await gw.close();
    }
  });
});
