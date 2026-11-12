// PG-5 peer hub 契约测试：真实 http.Server（WS upgrade + SSE）+ 真实 UDP dgram + SqliteStore(:memory:)。
// 覆盖验收清单：挑战应答自动口令入网、无口令 pending 后 REST approve 实时放行、
// 同 nodeId 换公钥 mismatch 与 repin 恢复、双 UDP 端口区分 cone/symmetric、
// 28B+密文二进制帧原样中转与伪造 srcNodeId 丢弃、pause/DELETE 瞬间切断、
// path-report 与 /topology + SSE 实时联动、令牌桶限速与滑窗速率、deleteNetwork/disableUser 断连。
// 与其他测试相同：.mjs 直接 import 编译产物 ../dist/。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';

import { createGatewayApiServer } from '../dist/server.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import { deriveMasterKeyFromSecret, hashPassword } from '../dist/master-key.js';
import { PeerRateLimiter } from '../dist/peer-hub/rate-limiter.js';
import { UdpStunService } from '../dist/peer-hub/udp-stun.js';
import { PeerWsHub } from '../dist/peer-hub/ws-hub.js';
import WebSocket from 'ws';

const ADMIN_EMAIL = 'admin@local';
const ADMIN_PASSWORD = 'admin-pass-1234';
const TENANT_EMAIL = 'tenant@local';
const TENANT_PASSWORD = 'tenant-pass-1234';

// ---------------------------------------------------------------- 节点身份（与 src/peer/crypto.ts 同一套自证明方案）

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

// 域分隔字符串与 gateway-server/src/peer-hub/peer-crypto.ts 保持一致
const authMessage = (networkId, nodeId, challengeHex, timestamp) =>
  Buffer.from(`zr-gw-auth-v1|${networkId}|${nodeId}|${challengeHex}|${timestamp}`, 'utf8');
const joinProof = (joinKey, networkId, nodeId, challengeHex) =>
  crypto
    .createHmac('sha256', Buffer.from(joinKey, 'utf8'))
    .update(Buffer.from(`zr-join-v1|${networkId}|${nodeId}|${challengeHex}`, 'utf8'))
    .digest('hex');
const stunMessage = (networkId, nodeId, nonce, timestamp) =>
  Buffer.from(`zr-stun-probe-v1|${networkId}|${nodeId}|${nonce}|${timestamp}`, 'utf8');

// ---------------------------------------------------------------- 28B 帧头 + 假密文载荷

function frame({ src, dst, type = 3, streamId = 1, seq = 1n, payloadBytes = 16, totalBytes }) {
  const header = Buffer.alloc(28);
  header.writeUInt16BE(0x5a52, 0);
  header.writeUInt8(0x01, 2);
  header.writeUInt8(type, 3);
  header.write(src, 4, 'hex');
  header.write(dst, 8, 'hex');
  header.writeUInt32BE(streamId, 12);
  header.writeBigUInt64BE(seq, 16);
  header.writeUInt32BE(0, 24);
  let rest = totalBytes !== undefined ? totalBytes - 28 : payloadBytes + 16;
  if (rest < 16) rest = 16;
  return Buffer.concat([header, crypto.randomBytes(rest - 16), crypto.randomBytes(16)]);
}

// ---------------------------------------------------------------- WS 客户端工具

/**
 * 连接建立即挂分发器：服务端的 challenge 在 upgrade 握手同一批数据里到达，
 * 若等 open 事件之后再挂 message 监听，首帧会在无监听者时被静默丢弃。
 * 文本/二进制分双队列缓冲，读取时先耗队列再登记等待者。
 */
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

/** 等待下一条 Text JSON 消息（先取缓冲队列，再登记等待者） */
function wsJson(ws, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws message timeout')), timeoutMs);
    const deliver = (json) => { clearTimeout(timer); resolve(json); };
    if (ws.__textQueue.length > 0) deliver(ws.__textQueue.shift());
    else ws.__textWaiters.push(deliver);
  });
}

/** 等待下一条二进制消息 */
function wsBinary(ws, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws binary timeout')), timeoutMs);
    const deliver = (buf) => { clearTimeout(timer); resolve(buf); };
    if (ws.__binaryQueue.length > 0) deliver(ws.__binaryQueue.shift());
    else ws.__binaryWaiters.push(deliver);
  });
}

/** 断言窗口期内一条消息都没有（文本与二进制都算，含已缓冲的） */
function wsSilence(ws, ms = 150) {
  return new Promise((resolve, reject) => {
    if (ws.__textQueue.length > 0 || ws.__binaryQueue.length > 0) {
      reject(new Error(`expected silence, got queued messages: ${JSON.stringify(ws.__textQueue[0]) ?? ''}`));
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
    if (ws.__closed) { resolve(); return; } // close 可能已在上一拍同步触发过
    const timer = setTimeout(() => reject(new Error('ws close timeout')), timeoutMs);
    ws.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

function wsSendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

/**
 * 走完挑战应答：读 challenge、（可选）算 join key 证明、签名 auth 上送。
 * 返回收到的 challenge 消息；后续 welcome 由调用方读。
 */
async function authNode(ws, node, { networkId, joinKey, name, lanEndpoints = [], timestamp = Date.now(), omitProof = false, badSignature = false, badIdentity = false } = {}) {
  const challenge = await wsJson(ws);
  assert.equal(challenge.type, 'challenge');
  assert.match(challenge.challengeHex, /^[0-9a-f]{64}$/);
  const presentedNodeId = badIdentity ? 'deadbeef' : node.nodeId;
  const signatureHex = badSignature
    ? 'ff'.repeat(64)
    : edSign(node.privateKeyHex, node.publicKeyHex, authMessage(networkId, presentedNodeId, challenge.challengeHex, timestamp));
  const auth = {
    type: 'auth',
    networkId,
    nodeId: presentedNodeId,
    publicKeyHex: node.publicKeyHex,
    name: name ?? `node-${presentedNodeId}`,
    lanEndpoints,
    timestamp,
    signatureHex,
  };
  if (joinKey !== undefined && !omitProof) {
    auth.joinKeyProofHex = joinProof(joinKey, networkId, presentedNodeId, challenge.challengeHex);
  }
  wsSendJson(ws, auth);
  return challenge;
}

function peerViewShape(view) {
  assert.equal(typeof view.nodeId, 'string');
  assert.equal(typeof view.natType, 'string');
  assert.ok(Array.isArray(view.lanEndpoints));
  assert.match(view.publicKeyHex, /^[0-9a-f]{64}$/, 'peer 视图必须携带对端公钥');
  assert.ok('name' in view && 'reflexiveEndpoint' in view);
}

// ---------------------------------------------------------------- UDP 探测工具

async function udpSocket() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', () => { sock.removeAllListeners('error'); resolve(sock); });
  });
}

function udpProbe(sock, port, node, { networkId, nonce = 'aa01', timestamp = Date.now(), signIt = true } = {}) {
  const msg = {
    type: 'stun-probe',
    networkId,
    nodeId: node.nodeId,
    publicKeyHex: node.publicKeyHex,
    nonce,
    timestamp,
    signatureHex: signIt ? edSign(node.privateKeyHex, node.publicKeyHex, stunMessage(networkId, node.nodeId, nonce, timestamp)) : 'ff'.repeat(64),
  };
  sock.send(Buffer.from(JSON.stringify(msg)), port, '127.0.0.1');
}

function udpRecv(sock, { timeoutMs = 800 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('udp reply timeout')), timeoutMs);
    const onMsg = (buf) => {
      clearTimeout(timer);
      sock.off('message', onMsg);
      try { resolve(JSON.parse(buf.toString('utf8'))); } catch (err) { reject(err); }
    };
    sock.on('message', onMsg);
  });
}

function udpSilence(sock, ms = 300) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sock.off('message', onMsg); resolve(); }, ms);
    const onMsg = (buf) => {
      clearTimeout(timer);
      sock.off('message', onMsg);
      reject(new Error(`expected no udp reply, got ${buf.toString('utf8')}`));
    };
    sock.on('message', onMsg);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 裸 TCP WS 客户端（恶意形态：握完手不回 close 帧）

/** 客户端 → 服务端的帧必须带掩码（RFC6455）；payload < 64KB */
function encodeClientFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** 裸 TCP WebSocket 客户端：完整握手、收发帧，但收到 close 帧后装死不回应 */
async function rawWsConnect(port, path = '/peer/v1/ws') {
  const sock = await new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('error', reject);
    s.once('connect', () => { s.removeListener('error', reject); resolve(s); });
  });
  const api = {
    sock,
    frames: [], // 数据帧（text/binary）
    frameWaiters: [],
    closed: false,
    closeWaiters: [],
  };
  const key = crypto.randomBytes(16).toString('base64');
  let upgraded = false;
  let handshake = Buffer.alloc(0);
  let parseBuf = Buffer.alloc(0);
  let upgradedResolve = null;
  const upgradedPromise = new Promise((resolve) => { upgradedResolve = resolve; });

  const onFrame = (f) => {
    if (f.opcode === 0x8 || f.opcode === 0x9 || f.opcode === 0xa) return; // close/ping/pong 不入数据队列；close 帧故意不回应
    const w = api.frameWaiters.shift();
    if (w !== undefined) w(f);
    else api.frames.push(f);
  };

  const parseChunk = (chunk) => {
    parseBuf = Buffer.concat([parseBuf, chunk]);
    for (;;) {
      if (parseBuf.length < 2) return;
      const opcode = parseBuf[0] & 0x0f;
      const masked = (parseBuf[1] & 0x80) !== 0;
      let len = parseBuf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (parseBuf.length < 4) return;
        len = parseBuf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (parseBuf.length < 10) return;
        len = Number(parseBuf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (parseBuf.length < offset + maskLen + len) return;
      const payload = Buffer.from(parseBuf.subarray(offset + maskLen, offset + maskLen + len));
      if (masked) {
        const maskKey = parseBuf.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      parseBuf = parseBuf.subarray(offset + maskLen + len);
      onFrame({ opcode, payload });
    }
  };

  sock.on('data', (chunk) => {
    if (!upgraded) {
      handshake = Buffer.concat([handshake, chunk]);
      const idx = handshake.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = handshake.slice(0, idx).toString('utf8');
      api.upgradeStatus = head.split('\r\n')[0];
      upgraded = true;
      const rest = handshake.slice(idx + 4);
      handshake = Buffer.alloc(0);
      if (rest.length > 0) parseChunk(rest);
      upgradedResolve();
      return;
    }
    parseChunk(chunk);
  });
  sock.on('close', () => {
    api.closed = true;
    for (const w of api.closeWaiters.splice(0)) w();
  });

  sock.write(`GET ${path} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: ${key}\r\nsec-websocket-version: 13\r\n\r\n`);
  await upgradedPromise;
  if (!/^HTTP\/1\.1 101/.test(api.upgradeStatus ?? '')) {
    throw new Error(`upgrade failed: ${api.upgradeStatus}`);
  }
  api.sendFrame = (opcode, payload) => sock.write(encodeClientFrame(opcode, payload));
  api.sendText = (obj) => api.sendFrame(0x1, Buffer.from(JSON.stringify(obj)));
  api.sendBinary = (buf) => api.sendFrame(0x2, buf);
  api.nextFrame = ({ timeoutMs = 2000 } = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('raw frame timeout')), timeoutMs);
    const deliver = (f) => { clearTimeout(timer); resolve(f); };
    if (api.frames.length > 0) deliver(api.frames.shift());
    else api.frameWaiters.push(deliver);
  });
  api.nextJson = async (opts) => JSON.parse((await api.nextFrame(opts)).payload.toString('utf8'));
  api.waitClosed = ({ timeoutMs = 2000 } = {}) => new Promise((resolve, reject) => {
    if (api.closed) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('raw close timeout')), timeoutMs);
    api.closeWaiters.push(() => { clearTimeout(timer); resolve(); });
  });
  return api;
}

// ---------------------------------------------------------------- REST / SSE 工具

async function api(base, method, path, { body, cookie } = {}) {
  const headers = {};
  if (cookie !== undefined) headers.cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
    headers.origin = base; // 写请求过同源门（浏览器形态）
  }
  const res = await fetch(base + path, { method, headers, body: payload });
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
  assert.equal(res.status, 200, `login ${email} failed`);
  return sessionCookie(res);
}

async function createNetwork(gw, { mode = 'key', maxPeers } = {}) {
  const res = await api(gw.base, 'POST', '/api/v1/networks', {
    body: { name: `net-${Math.random().toString(36).slice(2, 8)}`, admissionMode: mode, ...(maxPeers !== undefined ? { maxPeers } : {}) },
    cookie: gw.tenantCookie,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.data; // { id, joinKey, maxPeers, ... }
}

async function getTopology(gw, networkId, cookie) {
  const res = await api(gw.base, 'GET', `/api/v1/networks/${networkId}/topology`, { cookie: cookie ?? gw.tenantCookie });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.data;
}

async function openSse(base, path, cookie) {
  const res = await fetch(base + path, { headers: { cookie } });
  assert.equal(res.status, 200, `sse open failed: ${res.status}`);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let closed = false;
  async function pullEvent(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = buf.indexOf('\n\n');
      if (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue; // retry:/注释块，无 payload
        return { event, data: JSON.parse(dataLines.join('\n')) };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('sse event timeout');
      const step = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('sse read timeout')), remaining)),
      ]);
      if (step.done) { closed = true; throw new Error('sse stream ended'); }
      buf += decoder.decode(step.value, { stream: true });
    }
  }
  async function waitFor(pred, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ev = await pullEvent(Math.max(50, deadline - Date.now()));
      if (pred(ev)) return ev;
    }
  }
  return {
    res,
    pullEvent,
    waitFor,
    get closed() { return closed; },
    close: () => reader.cancel().catch(() => {}),
  };
}

// ---------------------------------------------------------------- 网关组装

async function startGateway(opts = {}) {
  const store = new SqliteStore({
    seed: { allowSignup: false, maxNetworksPerUser: 4, defaultMaxPeers: 8, relayRateKbps: 64 },
  });
  const masterKey = deriveMasterKeyFromSecret('peer-hub-test');
  const hub = new PeerWsHub({
    store,
    masterKey,
    rateTickMs: opts.rateTickMs ?? null, // 缺省关掉速率跳动定时器，按需开
    flushMs: opts.flushMs ?? null, // 缺省关掉遥测刷盘定时器，按需开
  });
  const server = createGatewayApiServer({ store, masterKey, runtime: hub, hooks: hub.hooks, topology: hub });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  hub.attach(server);

  const natRecords = [];
  const stun = new UdpStunService({
    primaryPort: 0,
    // PC-02: stunAltDisabled=true 模拟配置层 udpAltPort=0（组合根映射成 null）
    altPort: opts.stunAltDisabled ? null : 0,
    host: '127.0.0.1',
    // PC-02: 缩短主/辅配对窗口，测「分类保留」不必等默认 10s
    ...(opts.stunWindowMs !== undefined ? { windowMs: opts.stunWindowMs } : {}),
    // 与生产组合根（main.ts）同款：准入绑定当前连接 token，代次守卫可测
    admitProbe: (networkId, nodeId, publicKeyHex) => hub.admitStunProbe(networkId, nodeId, publicKeyHex),
    lanEndpointsLookup: (networkId, nodeId) => hub.getLanEndpoints(networkId, nodeId),
    onNatDetected: (rec) => { natRecords.push(rec); hub.applyNatObservation(rec); },
  });
  const udp = await stun.bind();

  const base = `http://127.0.0.1:${server.address().port}`;
  await store.ensureBootstrapAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const tenant = await store.createUser({
    email: TENANT_EMAIL,
    passwordHash: await hashPassword(TENANT_PASSWORD),
    role: 'user',
  });
  const adminCookie = await login(base, ADMIN_EMAIL, ADMIN_PASSWORD);
  const tenantCookie = await login(base, TENANT_EMAIL, TENANT_PASSWORD);

  const close = async () => {
    await hub.close();
    await stun.close();
    await new Promise((resolve) => {
      server.closeIdleConnections?.();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await store.close();
  };
  return { store, masterKey, hub, stun, udp, natRecords, base, tenantId: tenant.id, adminCookie, tenantCookie, close };
}

/**
 * 建一个 key 模式网络并让 A、B 两节点入网，逐条读掉 join 广播
 * （welcome × 2、peer-joined、punch × 2），返回干净的连接句柄。
 */
async function setupPair(gw, { mode = 'key', maxPeers } = {}) {
  const net = await createNetwork(gw, { mode, maxPeers });
  const a = identity();
  const b = identity();
  const wsA = await wsOpen(gw.base);
  await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey, name: 'alpha' });
  const welcomeA = await wsJson(wsA);
  assert.equal(welcomeA.status, 'authorized');
  const wsB = await wsOpen(gw.base);
  await authNode(wsB, b, { networkId: net.id, joinKey: net.joinKey, name: 'bravo' });
  const welcomeB = await wsJson(wsB);
  assert.equal(welcomeB.status, 'authorized');
  assert.deepEqual(welcomeB.peers.map((p) => p.nodeId), [a.nodeId]);
  assert.equal(welcomeB.peers[0].publicKeyHex, a.publicKeyHex, 'welcome.peers 必须携带对端公钥');
  const punchAtB = await wsJson(wsB);
  assert.equal(punchAtB.type, 'punch-coordinate');
  assert.equal(punchAtB.peerNodeId, a.nodeId);
  assert.equal(punchAtB.publicKeyHex, a.publicKeyHex, 'punch 必须携带对端公钥');
  const joinedAtA = await wsJson(wsA);
  assert.equal(joinedAtA.type, 'peer-joined');
  assert.equal(joinedAtA.nodeId, b.nodeId);
  assert.equal(joinedAtA.publicKeyHex, b.publicKeyHex, 'peer-joined 必须携带对端公钥');
  const punchAtA = await wsJson(wsA);
  assert.equal(punchAtA.type, 'punch-coordinate');
  assert.equal(punchAtA.peerNodeId, b.nodeId);
  assert.equal(punchAtA.publicKeyHex, b.publicKeyHex);
  return { net, a, b, wsA, wsB };
}

// ---------------------------------------------------------------- 测试

describe('PeerRateLimiter（令牌桶 + 滑窗）', () => {
  test('突发容量 1 秒量、超限丢弃、随时间回填', () => {
    const clock = { now: 1_000_000 };
    const lim = new PeerRateLimiter({ now: () => clock.now });
    // 8 kbps = 8192 B/s → 突发桶容量 8192 B
    const scope = { networkId: 'n1', nodeId: 'aaaa', peerNodeId: 'bbbb' };
    assert.equal(lim.tryRelay(scope, 8192, 8), true);
    assert.equal(lim.tryRelay(scope, 1, 8), false, '桶空后应丢弃');
    clock.now += 500; // 回填 4096 B
    assert.equal(lim.tryRelay(scope, 4096, 8), true);
    assert.equal(lim.tryRelay(scope, 4096, 8), false, '只回填了半秒的量');
    clock.now += 60_000; // 长时间闲置回满
    assert.equal(lim.tryRelay(scope, 8192, 8), true);
    assert.equal(lim.tryRelay(scope, 1, 8), false);
  });

  test('不同节点各自独立计数', () => {
    const clock = { now: 0 };
    const lim = new PeerRateLimiter({ now: () => clock.now });
    assert.equal(lim.tryRelay({ networkId: 'n', nodeId: 'a' }, 8192, 8), true);
    assert.equal(lim.tryRelay({ networkId: 'n', nodeId: 'b' }, 8192, 8), true, 'b 有自己的桶');
    assert.equal(lim.tryRelay({ networkId: 'n', nodeId: 'a' }, 1, 8), false);
    assert.equal(lim.tryRelay({ networkId: 'other', nodeId: 'a' }, 8192, 8), true, '不同网络也是独立桶');
  });

  test('5 秒滑动窗口速率：total / byNetwork / byNode / pair', () => {
    const clock = { now: 1_000_000 };
    const lim = new PeerRateLimiter({ now: () => clock.now });
    lim.tryRelay({ networkId: 'n1', nodeId: 'a', peerNodeId: 'b' }, 8192, 64); // t+0
    clock.now += 500;
    lim.tryRelay({ networkId: 'n1', nodeId: 'a', peerNodeId: 'b' }, 4096, 64); // t+0.5
    clock.now += 2000; // t+2.5：两条都在 5s 窗口内
    // (8192+4096)*8/5/1024 = 19.2 kbps
    assert.ok(Math.abs(lim.liveRelayKbpsTotal() - 19.2) < 1e-9, `total=${lim.liveRelayKbpsTotal()}`);
    assert.ok(Math.abs(lim.liveRelayKbpsByNetwork('n1') - 19.2) < 1e-9);
    assert.equal(lim.liveRelayKbpsByNetwork('n2'), 0);
    assert.ok(Math.abs(lim.liveRelayKbpsByNode('n1', 'a') - 19.2) < 1e-9);
    assert.ok(Math.abs(lim.liveRelayKbpsPair('n1', 'a', 'b') - 19.2) < 1e-9, 'pair 无序匹配');
    assert.ok(Math.abs(lim.liveRelayKbpsPair('n1', 'b', 'a') - 19.2) < 1e-9);
    clock.now += 4000; // t+6.5：全部滑出窗口
    assert.equal(lim.liveRelayKbpsTotal(), 0);
    assert.equal(lim.liveRelayKbpsPair('n1', 'a', 'b'), 0);
  });

  test('pendingRelayBytes 待刷盘累计与 drainAllPending 清零', () => {
    const clock = { now: 0 };
    const lim = new PeerRateLimiter({ now: () => clock.now });
    lim.tryRelay({ networkId: 'n', nodeId: 'a', peerNodeId: 'b' }, 100, 4096);
    lim.tryRelay({ networkId: 'n', nodeId: 'a', peerNodeId: 'b' }, 50, 4096);
    lim.tryRelay({ networkId: 'n', nodeId: 'c', peerNodeId: 'b' }, 10, 4096);
    lim.tryRelay({ networkId: 'n', nodeId: 'a', peerNodeId: 'b' }, 999_999_999, 4096); // 被丢弃，不计
    assert.equal(lim.pendingRelayBytes('n', 'a'), 150);
    assert.equal(lim.pendingRelayBytes('n', 'c'), 10);
    const drained = lim.drainAllPending();
    assert.deepEqual(drained.sort((x, y) => x.nodeId.localeCompare(y.nodeId)), [
      { networkId: 'n', nodeId: 'a', bytes: 150 },
      { networkId: 'n', nodeId: 'c', bytes: 10 },
    ]);
    assert.equal(lim.pendingRelayBytes('n', 'a'), 0, 'drain 后清零');
    assert.deepEqual(lim.drainAllPending(), []);
  });
});

describe('挑战应答入网与口令自动放行', () => {
  test('key 模式：口令证明正确即 welcome authorized，后加入者触发 peer-joined 与双向 punch-coordinate', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'key', maxPeers: 8 });
      const a = identity();
      const b = identity();

      const wsA = await wsOpen(gw.base);
      await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey, name: 'alpha', lanEndpoints: ['192.168.1.10:40001'] });
      const welcomeA = await wsJson(wsA);
      assert.equal(welcomeA.type, 'welcome');
      assert.equal(welcomeA.status, 'authorized');
      assert.equal(welcomeA.maxPeers, net.maxPeers);
      assert.deepEqual(welcomeA.peers, [], '首个节点无同伴');

      const wsB = await wsOpen(gw.base);
      await authNode(wsB, b, { networkId: net.id, joinKey: net.joinKey, name: 'bravo', lanEndpoints: ['192.168.1.11:40002'] });
      const welcomeB = await wsJson(wsB);
      assert.equal(welcomeB.status, 'authorized');
      assert.equal(welcomeB.peers.length, 1);
      peerViewShape(welcomeB.peers[0]);
      assert.equal(welcomeB.peers[0].nodeId, a.nodeId);
      assert.equal(welcomeB.peers[0].publicKeyHex, a.publicKeyHex, 'welcome.peers 必须携带对端公钥');
      assert.equal(welcomeB.peers[0].name, 'alpha');
      assert.deepEqual(welcomeB.peers[0].lanEndpoints, ['192.168.1.10:40001']);

      // A 收到 peer-joined + punch-coordinate（顺序固定）
      const joined = await wsJson(wsA);
      assert.equal(joined.type, 'peer-joined');
      assert.equal(joined.nodeId, b.nodeId);
      assert.equal(joined.publicKeyHex, b.publicKeyHex, 'peer-joined 必须携带对端公钥');
      assert.equal(joined.name, 'bravo');
      assert.deepEqual(joined.lanEndpoints, ['192.168.1.11:40002']);
      const punchAtA = await wsJson(wsA);
      assert.equal(punchAtA.type, 'punch-coordinate');
      assert.equal(punchAtA.peerNodeId, b.nodeId);
      assert.equal(punchAtA.publicKeyHex, b.publicKeyHex);
      assert.deepEqual(punchAtA.lanEndpoints, ['192.168.1.11:40002']);
      assert.equal(punchAtA.startAfterMs, 20);

      // B 也收到指向 A 的 punch-coordinate
      const punchAtB = await wsJson(wsB);
      assert.equal(punchAtB.type, 'punch-coordinate');
      assert.equal(punchAtB.peerNodeId, a.nodeId);
      assert.equal(punchAtB.publicKeyHex, a.publicKeyHex, 'punch 必须携带对端公钥');
      assert.deepEqual(punchAtB.lanEndpoints, ['192.168.1.10:40001']);

      // 拓扑实时可见
      const topo = await getTopology(gw, net.id);
      assert.equal(topo.network.id, net.id);
      assert.equal(topo.summary.onlineDevices, 2);
      assert.equal(topo.pending.length, 0);
      const bRow = topo.members.find((m) => m.nodeId === b.nodeId);
      assert.equal(bRow.status, 'authorized');
      assert.equal(bRow.online, true);
    } finally {
      await gw.close();
    }
  });

  test('key 模式：口令错、签名错、时间戳过期、假身份、网络满各自被拒并断开', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'key', maxPeers: 2 });
      const a = identity();
      const wsA = await wsOpen(gw.base);
      await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey });
      assert.equal((await wsJson(wsA)).status, 'authorized');
      const b = identity();
      const wsB = await wsOpen(gw.base);
      await authNode(wsB, b, { networkId: net.id, joinKey: net.joinKey });
      assert.equal((await wsJson(wsB)).status, 'authorized');

      const expectDenied = async (ws, label) => {
        const msg = await wsJson(ws);
        assert.equal(msg.type, 'denied', `${label} 应被拒`);
        assert.ok(typeof msg.reason === 'string' && msg.reason.length > 0);
        await wsClosed(ws);
      };

      // 口令错（key 模式直接拒绝、不入库）
      const wrongKey = identity();
      const wsWrongKey = await wsOpen(gw.base);
      await authNode(wsWrongKey, wrongKey, { networkId: net.id, joinKey: 'not-the-key' });
      await expectDenied(wsWrongKey, 'wrong join key');

      // 签名错
      const badSig = identity();
      const wsBadSig = await wsOpen(gw.base);
      await authNode(wsBadSig, badSig, { networkId: net.id, joinKey: net.joinKey, badSignature: true });
      await expectDenied(wsBadSig, 'bad signature');

      // 时间戳过期（±5min 窗口外）
      const stale = identity();
      const wsStale = await wsOpen(gw.base);
      await authNode(wsStale, stale, { networkId: net.id, joinKey: net.joinKey, timestamp: Date.now() - 6 * 60_000 });
      await expectDenied(wsStale, 'stale timestamp');

      // nodeId 与公钥哈希不符（自证明失败）
      const fake = identity();
      const wsFake = await wsOpen(gw.base);
      await authNode(wsFake, fake, { networkId: net.id, joinKey: net.joinKey, badIdentity: true });
      await expectDenied(wsFake, 'forged identity');

      // 网络满：maxPeers=2 已占满，第三个被拒
      const extra = identity();
      const wsExtra = await wsOpen(gw.base);
      await authNode(wsExtra, extra, { networkId: net.id, joinKey: net.joinKey });
      await expectDenied(wsExtra, 'network full');
    } finally {
      await gw.close();
    }
  });

  test('网络不存在 → denied', async () => {
    const gw = await startGateway();
    try {
      const node = identity();
      const ws = await wsOpen(gw.base);
      await authNode(ws, node, { networkId: '0123456789abcdef', joinKey: 'whatever' });
      const msg = await wsJson(ws);
      assert.equal(msg.type, 'denied');
      await wsClosed(ws);
    } finally {
      await gw.close();
    }
  });
});

describe('manual 模式 pending 与管理员实时放行', () => {
  test('无口令进入 pending，REST approve 后同一连接实时收到 authorized + peers', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'manual', maxPeers: 4 });
      const c = identity();
      const wsC = await wsOpen(gw.base);
      await authNode(wsC, c, { networkId: net.id, omitProof: true, name: 'charlie' });
      const pending = await wsJson(wsC);
      assert.equal(pending.type, 'welcome');
      assert.equal(pending.status, 'pending');
      assert.equal(pending.maxPeers, net.maxPeers);
      assert.equal('peers' in pending, false, 'pending 不带 peers');

      // 控制台拓扑里出现待审批项
      let topo = await getTopology(gw, net.id);
      assert.equal(topo.summary.pendingCount, 1);
      assert.deepEqual(topo.pending.map((p) => p.nodeId), [c.nodeId]);
      assert.equal(topo.summary.onlineDevices, 0, 'pending 不占在线席位');

      // 管理员（归属者）REST approve；hook 被 await，响应返回时 WS 推送已发出
      const res = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${c.nodeId}/approve`, { cookie: gw.tenantCookie });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.data.member.status, 'authorized');

      const promoted = await wsJson(wsC);
      assert.equal(promoted.type, 'welcome');
      assert.equal(promoted.status, 'authorized');
      assert.equal(promoted.maxPeers, net.maxPeers);
      assert.deepEqual(promoted.peers, []);
      assert.equal((await getTopology(gw, net.id)).summary.onlineDevices, 1, '放行后进入在线表');

      // 第二个节点 pending → approve 后与 C 互见 + punch
      const d = identity();
      const wsD = await wsOpen(gw.base);
      await authNode(wsD, d, { networkId: net.id, omitProof: true });
      assert.equal((await wsJson(wsD)).status, 'pending');
      const resD = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${d.nodeId}/approve`, { cookie: gw.tenantCookie });
      assert.equal(resD.status, 200);
      const welcomeD = await wsJson(wsD);
      assert.equal(welcomeD.status, 'authorized');
      assert.deepEqual(welcomeD.peers.map((p) => p.nodeId), [c.nodeId]);
      const punch = await wsJson(wsD);
      assert.equal(punch.type, 'punch-coordinate');
      assert.equal(punch.peerNodeId, c.nodeId);
      const joinedAtC = await wsJson(wsC);
      assert.equal(joinedAtC.type, 'peer-joined');
      assert.equal(joinedAtC.nodeId, d.nodeId);
      const punchAtC = await wsJson(wsC);
      assert.equal(punchAtC.type, 'punch-coordinate');
      assert.equal(punchAtC.peerNodeId, d.nodeId);
    } finally {
      await gw.close();
    }
  });

  test('reject：挂起连接被拒并断开', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'manual' });
      const c = identity();
      const wsC = await wsOpen(gw.base);
      await authNode(wsC, c, { networkId: net.id, omitProof: true });
      assert.equal((await wsJson(wsC)).status, 'pending');
      const res = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${c.nodeId}/reject`, { cookie: gw.tenantCookie });
      assert.equal(res.status, 200);
      const msg = await wsJson(wsC);
      assert.equal(msg.type, 'denied');
      await wsClosed(wsC);
      assert.equal((await getTopology(gw, net.id)).summary.pendingCount, 0);
    } finally {
      await gw.close();
    }
  });

  test('准入模式完整矩阵：manual 持邀请链接进 pending 审批放行；both 无口令转有效口令直升 authorized；key 轮换口令不影响存量已授权节点', async () => {
    const gw = await startGateway();
    try {
      // 1) manual 模式：节点粘贴邀请链接（携带正确 joinKey）不得被拒，应进入 pending，批准后原地升级 authorized
      const manualNet = await createNetwork(gw, { mode: 'manual', maxPeers: 4 });
      const m1 = identity();
      const wsM1 = await wsOpen(gw.base);
      await authNode(wsM1, m1, { networkId: manualNet.id, joinKey: manualNet.joinKey, name: 'manual-invite-node' });
      const welcomeM1 = await wsJson(wsM1);
      assert.equal(welcomeM1.type, 'welcome', `manual 持邀请链接不应返回 denied: ${JSON.stringify(welcomeM1)}`);
      assert.equal(welcomeM1.status, 'pending');
      const approveRes = await api(gw.base, 'POST', `/api/v1/networks/${manualNet.id}/members/${m1.nodeId}/approve`, { cookie: gw.tenantCookie });
      assert.equal(approveRes.status, 200);
      const promotedM1 = await wsJson(wsM1);
      assert.equal(promotedM1.type, 'welcome');
      assert.equal(promotedM1.status, 'authorized');
      wsM1.close();

      // 2) both 模式：先通过网关地址无口令入网停在 pending，再换有效邀请链接重连应直接 authorized
      const bothNet = await createNetwork(gw, { mode: 'both', maxPeers: 4 });
      const b1 = identity();
      const wsB1Pending = await wsOpen(gw.base);
      await authNode(wsB1Pending, b1, { networkId: bothNet.id, omitProof: true, name: 'both-upgrade-node' });
      assert.equal((await wsJson(wsB1Pending)).status, 'pending');
      wsB1Pending.close();
      await wsClosed(wsB1Pending);

      const wsB1Auth = await wsOpen(gw.base);
      await authNode(wsB1Auth, b1, { networkId: bothNet.id, joinKey: bothNet.joinKey, name: 'both-upgrade-node' });
      const welcomeB1 = await wsJson(wsB1Auth);
      assert.equal(welcomeB1.type, 'welcome');
      assert.equal(welcomeB1.status, 'authorized');
      wsB1Auth.close();

      // 3) key 模式：有效链接直接 authorized；轮换口令后旧链接对新节点失效，但已授权节点重连（即使无新口令）依然保持 authorized
      const keyNet = await createNetwork(gw, { mode: 'key', maxPeers: 4 });
      const k1 = identity();
      const wsK1 = await wsOpen(gw.base);
      await authNode(wsK1, k1, { networkId: keyNet.id, joinKey: keyNet.joinKey, name: 'key-node-1' });
      assert.equal((await wsJson(wsK1)).status, 'authorized');
      wsK1.close();
      await wsClosed(wsK1);

      const rotRes = await api(gw.base, 'POST', `/api/v1/networks/${keyNet.id}/rotate-key`, { cookie: gw.tenantCookie });
      assert.equal(rotRes.status, 200);
      const newKey = rotRes.json.data.joinKey;
      assert.notEqual(newKey, keyNet.joinKey);

      // 新节点用旧链接被拒
      const k2 = identity();
      const wsK2Old = await wsOpen(gw.base);
      await authNode(wsK2Old, k2, { networkId: keyNet.id, joinKey: keyNet.joinKey, name: 'key-node-old' });
      assert.equal((await wsJson(wsK2Old)).type, 'denied');
      await wsClosed(wsK2Old);

      // 新节点用新链接自动准入
      const wsK2New = await wsOpen(gw.base);
      await authNode(wsK2New, k2, { networkId: keyNet.id, joinKey: newKey, name: 'key-node-new' });
      assert.equal((await wsJson(wsK2New)).status, 'authorized');
      wsK2New.close();

      // 已授权存量节点持旧链接重连仍然 authorized
      const wsK1Reconnect = await wsOpen(gw.base);
      await authNode(wsK1Reconnect, k1, { networkId: keyNet.id, joinKey: keyNet.joinKey, name: 'key-node-1' });
      assert.equal((await wsJson(wsK1Reconnect)).status, 'authorized');
      wsK1Reconnect.close();
    } finally {
      await gw.close();
    }
  });
});

describe('mismatch 与 repin 恢复', () => {
  test('同 nodeId 换公钥 → welcome mismatch 且转发被阻断，repin 后恢复互通', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'key', maxPeers: 8 });
      const b = identity();
      const impostor = identity(); // 「碰撞漏网」形态：库里 (net, b.nodeId) 行挂着别人的公钥
      await gw.store.upsertMemberJoinAttempt({
        networkId: net.id,
        nodeId: b.nodeId,
        name: 'bravo',
        publicKeyHex: impostor.publicKeyHex,
        joinKeyMatched: true,
      });

      const a = identity();
      const wsA = await wsOpen(gw.base);
      await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey, name: 'alpha' });
      assert.equal((await wsJson(wsA)).status, 'authorized');

      // B 用真身份连接 → 与库中公钥不同 → mismatch，连接挂起
      const wsB = await wsOpen(gw.base);
      await authNode(wsB, b, { networkId: net.id, joinKey: net.joinKey, name: 'bravo' });
      const mismatch = await wsJson(wsB);
      assert.equal(mismatch.type, 'welcome');
      assert.equal(mismatch.status, 'mismatch');

      // mismatch 连接的转发被阻断：B 发帧 A 不得收到
      wsB.send(frame({ src: b.nodeId, dst: a.nodeId }));
      await wsSilence(wsA, 150);

      let topo = await getTopology(gw, net.id);
      assert.equal(topo.members.find((m) => m.nodeId === b.nodeId).status, 'mismatch');

      // 管理员 repin → 候选公钥（B 的真钥匙）提升，挂起连接实时恢复
      const res = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${b.nodeId}/repin`, { cookie: gw.tenantCookie });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const promoted = await wsJson(wsB);
      assert.equal(promoted.type, 'welcome');
      assert.equal(promoted.status, 'authorized');
      assert.deepEqual(promoted.peers.map((p) => p.nodeId), [a.nodeId]);
      const joinedAtA = await wsJson(wsA);
      assert.equal(joinedAtA.type, 'peer-joined');
      assert.equal(joinedAtA.nodeId, b.nodeId);
      const punchAtA = await wsJson(wsA);
      assert.equal(punchAtA.type, 'punch-coordinate');
      assert.equal(punchAtA.peerNodeId, b.nodeId);

      // 恢复后二进制帧原样中转
      const payload = frame({ src: b.nodeId, dst: a.nodeId, payloadBytes: 24, seq: 7n });
      wsB.send(payload);
      assert.deepEqual(await wsBinary(wsA), payload);
      assert.equal((await getTopology(gw, net.id)).summary.onlineDevices, 2);
    } finally {
      await gw.close();
    }
  });
});

describe('双 UDP 端口 STUN 与 NAT 判定', () => {
  test('同源端口先后命中主/辅 → cone；不同源端口 → symmetric', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'key' });
      const a = identity();
      const wsA = await wsOpen(gw.base);
      await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey, lanEndpoints: ['203.0.113.9:40000'] });
      assert.equal((await wsJson(wsA)).status, 'authorized');
      const { primaryPort, altPort } = gw.udp;
      assert.notEqual(primaryPort, 0);
      assert.notEqual(altPort, 0);

      // cone：同一个本地 socket 先后探测两个端口 → 两次反射地址一致
      const s1 = await udpSocket();
      const localPort = s1.address().port;
      udpProbe(s1, primaryPort, a, { networkId: net.id, nonce: 'aa01' });
      const reply1 = await udpRecv(s1);
      assert.equal(reply1.type, 'stun-reply');
      assert.equal(reply1.nonce, 'aa01');
      assert.equal(reply1.reflexiveIp, '127.0.0.1');
      assert.equal(reply1.reflexivePort, localPort);
      assert.equal(reply1.serverPortRole, 'primary');

      udpProbe(s1, altPort, a, { networkId: net.id, nonce: 'aa02' });
      const reply2 = await udpRecv(s1);
      assert.equal(reply2.serverPortRole, 'alt');
      assert.equal(reply2.reflexivePort, localPort);
      assert.equal(reply2.nonce, 'aa02');

      // 反射地址不在 lanEndpoints 里 → cone（而非 public）
      assert.deepEqual(gw.natRecords.at(-1), {
        networkId: net.id,
        nodeId: a.nodeId,
        natType: 'cone',
        reflexiveIp: '127.0.0.1',
        reflexivePort: localPort,
        serverPortRole: 'alt',
      });
      assert.equal((await getTopology(gw, net.id)).members.find((m) => m.nodeId === a.nodeId).natType, 'cone', '内存 natType 实时可见');
      s1.close();

      // symmetric：两次探测来自不同本地端口 → 反射端口不同
      const s2 = await udpSocket();
      const s3 = await udpSocket();
      udpProbe(s2, primaryPort, a, { networkId: net.id, nonce: 'bb01' });
      const reply3 = await udpRecv(s2);
      assert.equal(reply3.serverPortRole, 'primary');
      udpProbe(s3, altPort, a, { networkId: net.id, nonce: 'bb02' });
      const reply4 = await udpRecv(s3);
      assert.equal(reply4.serverPortRole, 'alt');
      assert.notEqual(reply4.reflexivePort, reply3.reflexivePort);
      assert.equal(gw.natRecords.at(-1).natType, 'symmetric');
      assert.equal((await getTopology(gw, net.id)).members.find((m) => m.nodeId === a.nodeId).natType, 'symmetric');
      s2.close();
      s3.close();
    } finally {
      await gw.close();
    }
  });

  test('反射地址与 lanEndpoints 完全一致 → public', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'key' });
      const a = identity();
      const s0 = await udpSocket();
      const publicPort = s0.address().port;
      const wsA = await wsOpen(gw.base);
      await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey, lanEndpoints: [`127.0.0.1:${publicPort}`] });
      assert.equal((await wsJson(wsA)).status, 'authorized');
      const { primaryPort, altPort } = gw.udp;
      udpProbe(s0, primaryPort, a, { networkId: net.id });
      await udpRecv(s0);
      udpProbe(s0, altPort, a, { networkId: net.id, nonce: 'aa02' });
      await udpRecv(s0);
      assert.equal(gw.natRecords.at(-1).natType, 'public');
      s0.close();
    } finally {
      await gw.close();
    }
  });

  test('伪造签名与过期时间戳的探测被静默丢弃（不回包、不改 NAT）', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'key' });
      const a = identity();
      const wsA = await wsOpen(gw.base);
      await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey });
      assert.equal((await wsJson(wsA)).status, 'authorized');
      const { primaryPort, altPort } = gw.udp;
      const s = await udpSocket();

      udpProbe(s, primaryPort, a, { networkId: net.id, signIt: false });
      await udpSilence(s, 300);
      udpProbe(s, primaryPort, a, { networkId: net.id, timestamp: Date.now() - 6 * 60_000 });
      await udpSilence(s, 300);
      assert.equal(gw.natRecords.length, 0, '没有任何 NAT 判定');
      s.close();
    } finally {
      await gw.close();
    }
  });

  test('FIX-3/PC-02：反射端点首次确定或变化时向同网同伴补发 punch-coordinate', async () => {
    const gw = await startGateway();
    const socks = [];
    const mkSock = async () => { const sock = await udpSocket(); socks.push(sock); return sock; };
    try {
      const { net, a, b, wsB } = await setupPair(gw);
      const { primaryPort, altPort } = gw.udp;

      // PC-02 时序：主口先到 → 立即补发携带反射端点的坐标（natType unknown，
      // 辅口尚未配对）；辅口随后到达完成 cone 分类——端点未变，不再补发
      const s1 = await mkSock();
      const p1 = s1.address().port;
      udpProbe(s1, primaryPort, a, { networkId: net.id, nonce: 'aa01' });
      await udpRecv(s1);
      const punchUnknown = await wsJson(wsB);
      assert.equal(punchUnknown.type, 'punch-coordinate');
      assert.equal(punchUnknown.peerNodeId, a.nodeId);
      assert.equal(punchUnknown.publicKeyHex, a.publicKeyHex, '补发打洞坐标必须携带对端公钥');
      assert.equal(punchUnknown.reflexiveEndpoint, `127.0.0.1:${p1}`);
      assert.equal(punchUnknown.natType, 'unknown', '主口观察必须先行发布（辅口未配对 → unknown）');
      udpProbe(s1, altPort, a, { networkId: net.id, nonce: 'aa02' });
      await udpRecv(s1);
      assert.equal(gw.natRecords.at(-1).natType, 'cone', '辅口配对完成 cone 分类');
      await wsSilence(wsB, 150); // 端点未变 → 不重复补发

      // 反射端点变化（主口换新源端口）→ 再补发一次携带新端点；路由端点以
      // 主口观察为准。round-1 的槽位还在 10s 窗口内：s2 的 primary 探测先与
      // 旧辅口判出一次 symmetric（端点 p2）；s3 的辅口随后配对，端点仍取
      // 主口 p2——两条发布的端点一致，只应看到一条新坐标
      const s2 = await mkSock();
      const s3 = await mkSock();
      const p2 = s2.address().port;
      udpProbe(s2, primaryPort, a, { networkId: net.id, nonce: 'bb01' });
      await udpRecv(s2);
      udpProbe(s3, altPort, a, { networkId: net.id, nonce: 'bb02' });
      await udpRecv(s3);
      let punch2 = null;
      const deadline = Date.now() + 2000;
      for (;;) {
        punch2 = await wsJson(wsB);
        if (punch2.type === 'punch-coordinate' && punch2.peerNodeId === a.nodeId && punch2.reflexiveEndpoint === `127.0.0.1:${p2}`) break;
        if (Date.now() > deadline) throw new Error(`no re-punch with new endpoint, got ${JSON.stringify(punch2)}`);
      }
      assert.equal(punch2.natType, 'symmetric');
      assert.equal(gw.natRecords.at(-1).reflexivePort, p2, '辅口配对发布的反射端点也以主口观察为准');
      await wsSilence(wsB, 150);
    } finally {
      for (const sock of socks.splice(0)) sock.close();
      await gw.close();
    }
  });

  // ------------------------------------------------------------ PC-02：主口可达即发布

  test('PC-02：主口单独可达（辅助口黑洞）→ 立即发布反射端点，natType unknown', async () => {
    const gw = await startGateway();
    const socks = [];
    const mkSock = async () => { const sock = await udpSocket(); socks.push(sock); return sock; };
    try {
      const { net, a, b, wsB } = await setupPair(gw);
      const { primaryPort } = gw.udp;

      // 只探测主口：辅助口的包从未发出——对网关而言与「辅助口实际丢包」不可区分
      const s1 = await mkSock();
      const p1 = s1.address().port;
      udpProbe(s1, primaryPort, a, { networkId: net.id, nonce: 'cc01' });
      const reply = await udpRecv(s1);
      assert.equal(reply.type, 'stun-reply');
      assert.equal(reply.serverPortRole, 'primary');

      // 观察流：主口回包后立即发布一条 unknown 记录（现状：完全没有记录）
      assert.deepEqual(gw.natRecords.at(-1), {
        networkId: net.id,
        nodeId: a.nodeId,
        natType: 'unknown',
        reflexiveIp: '127.0.0.1',
        reflexivePort: p1,
        serverPortRole: 'primary',
      });

      // 可观察拓扑：A 的反射端点已登记（现状 lastIp 为 null）
      const row = (await getTopology(gw, net.id)).members.find((m) => m.nodeId === a.nodeId);
      assert.equal(row.natType, 'unknown');
      assert.equal(row.lastIp, '127.0.0.1');

      // 实际数据调用证据：同伴 B 收到携带 A 反射端点的补发打洞坐标
      const punch = await wsJson(wsB);
      assert.equal(punch.type, 'punch-coordinate');
      assert.equal(punch.peerNodeId, a.nodeId);
      assert.equal(punch.reflexiveEndpoint, `127.0.0.1:${p1}`);
      assert.equal(punch.natType, 'unknown');
    } finally {
      for (const sock of socks.splice(0)) sock.close();
      await gw.close();
    }
  });

  test('PC-02：辅助口关闭（altPort null）→ 主口观察同样立即发布', async () => {
    const gw = await startGateway({ stunAltDisabled: true });
    const socks = [];
    const mkSock = async () => { const sock = await udpSocket(); socks.push(sock); return sock; };
    try {
      const net = await createNetwork(gw, { mode: 'key' });
      const a = identity();
      const wsA = await wsOpen(gw.base);
      await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey });
      assert.equal((await wsJson(wsA)).status, 'authorized');
      assert.equal(gw.udp.altPort, null, '夹具确认辅助口已关闭');

      const s1 = await mkSock();
      const p1 = s1.address().port;
      udpProbe(s1, gw.udp.primaryPort, a, { networkId: net.id, nonce: 'dd01' });
      const reply = await udpRecv(s1);
      assert.equal(reply.serverPortRole, 'primary');

      assert.deepEqual(gw.natRecords.at(-1), {
        networkId: net.id,
        nodeId: a.nodeId,
        natType: 'unknown',
        reflexiveIp: '127.0.0.1',
        reflexivePort: p1,
        serverPortRole: 'primary',
      });
      const row = (await getTopology(gw, net.id)).members.find((m) => m.nodeId === a.nodeId);
      assert.equal(row.natType, 'unknown');
      assert.equal(row.lastIp, '127.0.0.1');
    } finally {
      for (const sock of socks.splice(0)) sock.close();
      await gw.close();
    }
  });

  test('PC-02：只辅助口可达不发布——先辅助后主口，端点以主口观察为准', async () => {
    const gw = await startGateway();
    const socks = [];
    const mkSock = async () => { const sock = await udpSocket(); socks.push(sock); return sock; };
    try {
      const net = await createNetwork(gw, { mode: 'key' });
      const a = identity();
      const wsA = await wsOpen(gw.base);
      await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey });
      assert.equal((await wsJson(wsA)).status, 'authorized');
      const { primaryPort, altPort } = gw.udp;

      // 辅助口先到：只记槽位等主口配对，绝不冒充主口端点发布
      const altSock = await mkSock();
      const altPort0 = altSock.address().port;
      udpProbe(altSock, altPort, a, { networkId: net.id, nonce: 'ee01' });
      await udpRecv(altSock);
      assert.equal(gw.natRecords.length, 0, '仅辅助口可达不得产生任何 NAT 记录');

      // 主口后到（不同源端口 → symmetric）：发布端点必须取主口观察
      const primarySock = await mkSock();
      const primaryPort0 = primarySock.address().port;
      udpProbe(primarySock, primaryPort, a, { networkId: net.id, nonce: 'ee02' });
      await udpRecv(primarySock);
      assert.deepEqual(gw.natRecords.at(-1), {
        networkId: net.id,
        nodeId: a.nodeId,
        natType: 'symmetric',
        reflexiveIp: '127.0.0.1',
        reflexivePort: primaryPort0,
        serverPortRole: 'primary',
      });
      const row = (await getTopology(gw, net.id)).members.find((m) => m.nodeId === a.nodeId);
      assert.equal(row.natType, 'symmetric');
      assert.equal(row.lastIp, '127.0.0.1');
    } finally {
      for (const sock of socks.splice(0)) sock.close();
      await gw.close();
    }
  });

  test('PC-02：新鲜配对才分类——窗内反复主口更新继续配对，过窗正确降级 unknown', async () => {
    const gw = await startGateway({ stunWindowMs: 250 });
    const socks = [];
    const mkSock = async () => { const sock = await udpSocket(); socks.push(sock); return sock; };
    try {
      const { net, a, b, wsB } = await setupPair(gw);
      const { primaryPort, altPort } = gw.udp;

      // 双端口正常分类 → cone
      const s1 = await mkSock();
      const p1 = s1.address().port;
      udpProbe(s1, primaryPort, a, { networkId: net.id, nonce: 'ff01' });
      await udpRecv(s1);
      const punchUnknown = await wsJson(wsB);
      assert.equal(punchUnknown.reflexiveEndpoint, `127.0.0.1:${p1}`);
      assert.equal(punchUnknown.natType, 'unknown');
      udpProbe(s1, altPort, a, { networkId: net.id, nonce: 'ff02' });
      await udpRecv(s1);
      assert.equal(gw.natRecords.at(-1).natType, 'cone');

      // 窗口内仅主口更新（新源端口）：同代辅口仍新鲜 → 继续配对分类
      // （不同源端口 → symmetric），不是无条件先发 unknown
      const s2 = await mkSock();
      const p2 = s2.address().port;
      udpProbe(s2, primaryPort, a, { networkId: net.id, nonce: 'ff03' });
      await udpRecv(s2);
      assert.deepEqual(gw.natRecords.at(-1), {
        networkId: net.id,
        nodeId: a.nodeId,
        natType: 'symmetric',
        reflexiveIp: '127.0.0.1',
        reflexivePort: p2,
        serverPortRole: 'primary',
      });
      const punchSymmetric = await wsJson(wsB);
      assert.equal(punchSymmetric.reflexiveEndpoint, `127.0.0.1:${p2}`);
      assert.equal(punchSymmetric.natType, 'symmetric');

      // 等 > windowMs：主辅槽位过期。此后仅主口的观察没有新鲜配对——
      // 正确降级为 unknown（诚实反映「当前分类不可知」），端点照常更新
      await sleep(400);
      const s3 = await mkSock();
      const p3 = s3.address().port;
      udpProbe(s3, primaryPort, a, { networkId: net.id, nonce: 'ff04' });
      await udpRecv(s3);
      assert.deepEqual(gw.natRecords.at(-1), {
        networkId: net.id,
        nodeId: a.nodeId,
        natType: 'unknown',
        reflexiveIp: '127.0.0.1',
        reflexivePort: p3,
        serverPortRole: 'primary',
      });
      const punchDowngrade = await wsJson(wsB);
      assert.equal(punchDowngrade.reflexiveEndpoint, `127.0.0.1:${p3}`);
      assert.equal(punchDowngrade.natType, 'unknown');
      const row = (await getTopology(gw, net.id)).members.find((m) => m.nodeId === a.nodeId);
      assert.equal(row.natType, 'unknown', '过窗后的 unknown 是正确降级，不得沿用旧分类');
    } finally {
      for (const sock of socks.splice(0)) sock.close();
      await gw.close();
    }
  });

  test('PC-02：正常重连后代次守卫——旧连接的分类不混入新连接', async () => {
    const gw = await startGateway();
    const socks = [];
    const mkSock = async () => { const sock = await udpSocket(); socks.push(sock); return sock; };
    try {
      const net = await createNetwork(gw, { mode: 'key' });
      const a = identity();
      const wsA = await wsOpen(gw.base);
      await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey });
      assert.equal((await wsJson(wsA)).status, 'authorized');
      const { primaryPort, altPort } = gw.udp;

      // 连接代次 1：双端口 cone
      const s1 = await mkSock();
      udpProbe(s1, primaryPort, a, { networkId: net.id, nonce: 'ab01' });
      await udpRecv(s1);
      udpProbe(s1, altPort, a, { networkId: net.id, nonce: 'ab02' });
      await udpRecv(s1);
      assert.equal(gw.natRecords.at(-1).natType, 'cone');

      // 服务端断开 → 同一身份重新入网（新连接代次 2）
      const conn = gw.hub.conns.get(net.id)?.get(a.nodeId);
      assert.ok(conn, 'A 在路由表');
      conn.ws.close();
      await wsClosed(wsA);
      const wsA2 = await wsOpen(gw.base);
      await authNode(wsA2, a, { networkId: net.id, joinKey: net.joinKey });
      assert.equal((await wsJson(wsA2)).status, 'authorized');

      // 新代次仅主口探测：必须发布 unknown——既不能沿用旧代次的 cone，
      // 也不能沉默（新连接没有反射端点可供同伴打洞）
      const s2 = await mkSock();
      const p2 = s2.address().port;
      udpProbe(s2, primaryPort, a, { networkId: net.id, nonce: 'ab03' });
      await udpRecv(s2);
      assert.deepEqual(gw.natRecords.at(-1), {
        networkId: net.id,
        nodeId: a.nodeId,
        natType: 'unknown',
        reflexiveIp: '127.0.0.1',
        reflexivePort: p2,
        serverPortRole: 'primary',
      });
      const row = (await getTopology(gw, net.id)).members.find((m) => m.nodeId === a.nodeId);
      assert.equal(row.natType, 'unknown', '旧代次分类不得混入新连接');
    } finally {
      for (const sock of socks.splice(0)) sock.close();
      await gw.close();
    }
  });

  test('PC-02：同网多成员各自观察不串——记录与端点按节点各归各', async () => {
    const gw = await startGateway();
    const socks = [];
    const mkSock = async () => { const sock = await udpSocket(); socks.push(sock); return sock; };
    try {
      const { net, a, b } = await setupPair(gw);
      const { primaryPort } = gw.udp;
      const sockA = await mkSock();
      const sockB = await mkSock();
      const portA = sockA.address().port;
      const portB = sockB.address().port;
      udpProbe(sockA, primaryPort, a, { networkId: net.id, nonce: 'cd01' });
      await udpRecv(sockA);
      udpProbe(sockB, primaryPort, b, { networkId: net.id, nonce: 'cd02' });
      await udpRecv(sockB);

      const rows = (await getTopology(gw, net.id)).members;
      assert.equal(rows.find((m) => m.nodeId === a.nodeId).natType, 'unknown');
      assert.equal(rows.find((m) => m.nodeId === b.nodeId).natType, 'unknown');
      const recA = gw.natRecords.find((r) => r.nodeId === a.nodeId);
      const recB = gw.natRecords.find((r) => r.nodeId === b.nodeId);
      assert.equal(recA.reflexivePort, portA, 'A 的记录带 A 自己的反射端口');
      assert.equal(recB.reflexivePort, portB, 'B 的记录带 B 自己的反射端口');
    } finally {
      for (const sock of socks.splice(0)) sock.close();
      await gw.close();
    }
  });
});

describe('二进制帧中转与源地址防伪造', () => {
  test('授权节点互发 28B+密文帧原样到达；伪造 srcNodeId / 未知 dst / 垃圾帧被丢弃', async () => {
    const gw = await startGateway({ rateTickMs: 100 });
    try {
      const { net, a, b, wsA, wsB } = await setupPair(gw);

      // A → B 原样到达（网关不解密）
      const payload1 = frame({ src: a.nodeId, dst: b.nodeId, payloadBytes: 32, seq: 1n });
      wsA.send(payload1);
      assert.deepEqual(await wsBinary(wsB), payload1);
      // B → A 原样到达
      const payload2 = frame({ src: b.nodeId, dst: a.nodeId, payloadBytes: 8, seq: 2n, type: 5 });
      wsB.send(payload2);
      assert.deepEqual(await wsBinary(wsA), payload2);

      // 伪造 srcNodeId：A 冒充 C 发帧 → 丢弃、连接不断
      wsA.send(frame({ src: 'deadbeef', dst: b.nodeId }));
      await wsSilence(wsB, 150);
      // 未知 dst：静默丢弃
      wsA.send(frame({ src: a.nodeId, dst: 'cafebabe' }));
      await wsSilence(wsB, 150);
      // src === dst 自环：丢弃
      wsA.send(frame({ src: a.nodeId, dst: a.nodeId }));
      await wsSilence(wsB, 150);
      // 垃圾（太短/魔数错/超长）：丢弃且连接存活
      wsA.send(Buffer.from([0x5a, 0x52, 0x01]));
      wsA.send(frame({ src: a.nodeId, dst: b.nodeId, totalBytes: 44 }).fill(0x00, 0, 2));
      wsA.send(Buffer.concat([frame({ src: a.nodeId, dst: b.nodeId, totalBytes: 1200 }), Buffer.alloc(200)]));
      await wsSilence(wsB, 150);
      // A 的连接还活着：正常帧仍中转
      const payload3 = frame({ src: a.nodeId, dst: b.nodeId, seq: 3n });
      wsA.send(payload3);
      assert.deepEqual(await wsBinary(wsB), payload3);

      // 限速统计与拓扑速率联动
      assert.ok(gw.hub.limiter.pendingRelayBytes(net.id, a.nodeId) > 0, 'A 的中转字节进了待刷盘计数');
      const topo = await getTopology(gw, net.id);
      assert.ok(topo.summary.totalLiveRelayKbps > 0);
      assert.ok(topo.members.find((m) => m.nodeId === a.nodeId).liveRelayKbps > 0);

      // 3s 速率跳动（此处 tick=100ms）经 SSE 推送 topology-updated
      const tenant = gw.tenantCookie;
      const sse = await openSse(gw.base, `/api/v1/networks/${net.id}/events`, tenant);
      try {
        const snap = await sse.pullEvent();
        assert.equal(snap.event, 'snapshot');
        assert.equal(snap.data.network.id, net.id);
        const updated = await sse.waitFor((ev) => ev.event === 'topology-updated' && ev.data.summary.totalLiveRelayKbps > 0, 1500);
        assert.ok(updated.data.summary.totalLiveRelayKbps > 0);
      } finally {
        sse.close();
      }
    } finally {
      await gw.close();
    }
  });

  test('未入网连接（mismatch 挂起/pending）发帧一律丢弃', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'key' });
      const a = identity();
      const wsA = await wsOpen(gw.base);
      await authNode(wsA, a, { networkId: net.id, joinKey: net.joinKey });
      assert.equal((await wsJson(wsA)).status, 'authorized');

      const outsider = identity(); // 未入网：直接发帧
      const wsOut = await wsOpen(gw.base);
      const challenge = await wsJson(wsOut);
      wsOut.send(Buffer.concat([Buffer.alloc(0), frame({ src: outsider.nodeId, dst: a.nodeId })]));
      await wsSilence(wsA, 150);
      assert.equal(challenge.type, 'challenge');
    } finally {
      await gw.close();
    }
  });

  test('遥测刷盘：中转字节经 flushMemberTelemetry 累加进成员行', async () => {
    const gw = await startGateway({ flushMs: 100 });
    try {
      const { net, a, b, wsA, wsB } = await setupPair(gw);

      const f1 = frame({ src: a.nodeId, dst: b.nodeId, payloadBytes: 20 }); // 28+20+16 = 64
      wsA.send(f1);
      await wsBinary(wsB);
      const f2 = frame({ src: b.nodeId, dst: a.nodeId, payloadBytes: 4 }); // 48
      wsB.send(f2);
      await wsBinary(wsA);

      await new Promise((resolve) => setTimeout(resolve, 400));
      const members = await gw.store.listMembers(net.id);
      const aRow = members.find((m) => m.nodeId === a.nodeId);
      const bRow = members.find((m) => m.nodeId === b.nodeId);
      assert.equal(aRow.cumulativeRelayBytes, 64);
      assert.equal(bRow.cumulativeRelayBytes, 48);
      assert.ok(aRow.lastSeenAt !== null);
    } finally {
      await gw.close();
    }
  });
});

describe('管理联动：pause / DELETE / deleteNetwork / disableUser 瞬间切断', () => {
  test('pause 断开目标连接并广播 peer-paused，转发即刻停止', async () => {
    const gw = await startGateway();
    try {
      const { net, a, b, wsA, wsB } = await setupPair(gw);

      const res = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${b.nodeId}/pause`, { cookie: gw.tenantCookie });
      assert.equal(res.status, 200, JSON.stringify(res.json));

      const pausedAtB = await wsJson(wsB);
      assert.equal(pausedAtB.type, 'denied');
      await wsClosed(wsB);
      const pausedAtA = await wsJson(wsA);
      assert.equal(pausedAtA.type, 'peer-paused');
      assert.equal(pausedAtA.nodeId, b.nodeId);

      // 转发立即切断：A 发帧不再有去处，也不报错
      wsA.send(frame({ src: a.nodeId, dst: b.nodeId }));
      const topo = await getTopology(gw, net.id);
      assert.equal(topo.summary.onlineDevices, 1);
      assert.equal(topo.members.find((m) => m.nodeId === b.nodeId).status, 'paused');
      assert.equal(topo.members.find((m) => m.nodeId === b.nodeId).online, false);

      // resume 后恢复授权状态（离线成员，无连接动作）
      const res2 = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${b.nodeId}/resume`, { cookie: gw.tenantCookie });
      assert.equal(res2.status, 200);
      assert.equal((await getTopology(gw, net.id)).members.find((m) => m.nodeId === b.nodeId).status, 'authorized');
    } finally {
      await gw.close();
    }
  });

  test('DELETE 成员：断开连接并向同网广播 peer-left', async () => {
    const gw = await startGateway();
    try {
      const { net, a, wsA, wsB } = await setupPair(gw);

      const res = await api(gw.base, 'DELETE', `/api/v1/networks/${net.id}/members/${a.nodeId}`, { cookie: gw.tenantCookie });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const deniedAtA = await wsJson(wsA);
      assert.equal(deniedAtA.type, 'denied');
      await wsClosed(wsA);
      const leftAtB = await wsJson(wsB);
      assert.equal(leftAtB.type, 'peer-left');
      assert.equal(leftAtB.nodeId, a.nodeId);
    } finally {
      await gw.close();
    }
  });

  test('deleteNetwork 断开该网全部连接；disableUser 断开该租户全部在线节点', async () => {
    const gw = await startGateway();
    try {
      // 建两个网络各挂一对节点，删除其一不得误伤另一个
      const pair1 = await setupPair(gw);
      const pair2 = await setupPair(gw);

      const res = await api(gw.base, 'DELETE', `/api/v1/networks/${pair1.net.id}`, { cookie: gw.tenantCookie });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const deniedA1 = await wsJson(pair1.wsA);
      assert.equal(deniedA1.type, 'denied');
      await wsClosed(pair1.wsA);
      const deniedB1 = await wsJson(pair1.wsB);
      assert.equal(deniedB1.type, 'denied');
      await wsClosed(pair1.wsB);
      assert.equal((await getTopology(gw, pair2.net.id)).summary.onlineDevices, 2, 'net2 不受影响');

      // 停用租户 → 该租户名下全部网络节点断开
      const res2 = await api(gw.base, 'PATCH', `/api/v1/admin/users/${gw.tenantId}`, { body: { active: false }, cookie: gw.adminCookie });
      assert.equal(res2.status, 200, JSON.stringify(res2.json));
      const deniedA2 = await wsJson(pair2.wsA);
      assert.equal(deniedA2.type, 'denied');
      await wsClosed(pair2.wsA);
      const deniedB2 = await wsJson(pair2.wsB);
      assert.equal(deniedB2.type, 'denied');
      await wsClosed(pair2.wsB);
    } finally {
      await gw.close();
    }
  });

  test('FIX-1：pause 后 close 握手期（裸 TCP 客户端不回 close 帧）帧中转立即停止', async () => {
    const gw = await startGateway();
    try {
      const { net, b, wsB } = await setupPair(gw);
      const c = identity();
      // C 用裸 TCP 客户端入网：完整握手，但收到 close 帧后装死不回应
      const raw = await rawWsConnect(Number(new URL(gw.base).port));
      const challenge = await raw.nextJson();
      assert.equal(challenge.type, 'challenge');
      const timestamp = Date.now();
      raw.sendText({
        type: 'auth',
        networkId: net.id,
        nodeId: c.nodeId,
        publicKeyHex: c.publicKeyHex,
        name: 'charlie',
        lanEndpoints: [],
        timestamp,
        signatureHex: edSign(c.privateKeyHex, c.publicKeyHex, authMessage(net.id, c.nodeId, challenge.challengeHex, timestamp)),
        joinKeyProofHex: joinProof(net.joinKey, net.id, c.nodeId, challenge.challengeHex),
      });
      const welcome = await raw.nextJson();
      assert.equal(welcome.status, 'authorized');
      // 入网时对每个在线成员各收一条打洞坐标（指向 A 与指向 B）
      const punchAtRawA = await raw.nextJson();
      assert.equal(punchAtRawA.type, 'punch-coordinate');
      const punchAtRawB = await raw.nextJson();
      assert.equal(punchAtRawB.type, 'punch-coordinate');
      await wsJson(wsB); // peer-joined c
      await wsJson(wsB); // punch c

      // 先证明裸客户端链路正常：C → B 一帧原样到达
      const probe = frame({ src: c.nodeId, dst: b.nodeId, payloadBytes: 8, seq: 1n });
      raw.sendBinary(probe);
      assert.deepEqual(await wsBinary(wsB), probe);

      // 管理员 pause C：服务端发 denied + close 帧；裸客户端不回应 close
      const res = await api(gw.base, 'POST', `/api/v1/networks/${net.id}/members/${c.nodeId}/pause`, { cookie: gw.tenantCookie });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const denied = await raw.nextJson();
      assert.equal(denied.type, 'denied');
      await wsJson(wsB); // peer-paused c

      // 下一毫秒起 C 继续发帧：0 帧到达 B
      for (let i = 0; i < 5; i++) {
        raw.sendBinary(frame({ src: c.nodeId, dst: b.nodeId, seq: BigInt(i + 10) }));
        await new Promise((r) => setTimeout(r, 20));
      }
      await wsSilence(wsB, 300);
      // 恶意客户端挂不住 close 握手：宽限期后服务端强制拆链
      await raw.waitClosed({ timeoutMs: 2000 });
    } finally {
      await gw.close();
    }
  });
});

describe('path-report 与 /topology、SSE 联动', () => {
  test('path-report 更新拓扑矩阵，SSE 推送 snapshot 与 topology-updated', async () => {
    const gw = await startGateway();
    try {
      const { net, a, b, wsA, wsB } = await setupPair(gw);

      const sse = await openSse(gw.base, `/api/v1/networks/${net.id}/events`, gw.tenantCookie);
      try {
        const snap = await sse.pullEvent(2000);
        assert.equal(snap.event, 'snapshot');
        assert.equal(snap.data.network.id, net.id);
        assert.equal(snap.data.summary.onlineDevices, 2);

        // A 上报到 B 的路径
        wsSendJson(wsA, { type: 'path-report', peers: [{ peerNodeId: b.nodeId, path: 'p2p', rttMs: 12 }] });
        await sse.waitFor((ev) => ev.event === 'topology-updated', 2000);
        const topo = await getTopology(gw, net.id);
        const link = topo.links.find((l) => l.srcNodeId === a.nodeId && l.peerNodeId === b.nodeId);
        assert.ok(link, 'links 里应有 A→B');
        assert.equal(link.path, 'p2p');
        assert.equal(link.rttMs, 12);

        // B 离线 → SSE 推送 + 拓扑离线 + A 收到 peer-left
        wsB.close();
        await sse.waitFor((ev) => ev.event === 'topology-updated' && ev.data.summary.onlineDevices === 1, 2000);
        const leftAtA = await wsJson(wsA);
        assert.equal(leftAtA.type, 'peer-left');
        assert.equal(leftAtA.nodeId, b.nodeId);
        const topo2 = await getTopology(gw, net.id);
        assert.equal(topo2.members.find((m) => m.nodeId === b.nodeId).online, false);
        assert.equal(topo2.links.find((l) => l.srcNodeId === a.nodeId && l.peerNodeId === b.nodeId), undefined, '离线节点的路径上报随连接清空');
      } finally {
        sse.close();
      }
    } finally {
      await gw.close();
    }
  });

  test('FIX-2：path-report 只留本网在线对端且整表替换', async () => {
    const gw = await startGateway();
    try {
      const { net, a, b, wsA, wsB } = await setupPair(gw);
      const c = identity();
      const wsC = await wsOpen(gw.base);
      await authNode(wsC, c, { networkId: net.id, joinKey: net.joinKey, name: 'charlie' });
      assert.equal((await wsJson(wsC)).status, 'authorized');
      // 排干 join 广播：A、B 各收 peer-joined + punch；C 收两条 punch
      await wsJson(wsA);
      await wsJson(wsA);
      await wsJson(wsB);
      await wsJson(wsB);
      await wsJson(wsC);
      await wsJson(wsC);

      // 1) 混入本网不存在的随机 peerNodeId → 不留存
      wsSendJson(wsA, {
        type: 'path-report',
        peers: [
          { peerNodeId: b.nodeId, path: 'p2p', rttMs: 10 },
          { peerNodeId: c.nodeId, path: 'p2p', rttMs: 20 },
          { peerNodeId: 'deadbeef', path: 'relay', rttMs: 5 },
        ],
      });
      let links = (await getTopology(gw, net.id)).links.filter((l) => l.srcNodeId === a.nodeId);
      assert.deepEqual(
        links.map((l) => l.peerNodeId).sort(),
        [b.nodeId, c.nodeId].sort(),
        '随机伪造的 peerNodeId 不得进入拓扑矩阵',
      );

      // 2) 整表替换：新一轮只报 B → 旧一轮的 C 条目被清掉
      wsSendJson(wsA, { type: 'path-report', peers: [{ peerNodeId: b.nodeId, path: 'relay', rttMs: 99 }] });
      links = (await getTopology(gw, net.id)).links.filter((l) => l.srcNodeId === a.nodeId);
      assert.deepEqual(links.map((l) => l.peerNodeId), [b.nodeId]);
      assert.equal(links[0].path, 'relay');
      assert.equal(links[0].rttMs, 99);
    } finally {
      await gw.close();
    }
  });

  test('topology 路由归属校验：他人网络 404、未登录 401', async () => {
    const gw = await startGateway();
    try {
      const net = await createNetwork(gw, { mode: 'key' });
      const resForbidden = await api(gw.base, 'GET', `/api/v1/networks/${net.id}/topology`, { cookie: gw.adminCookie });
      assert.equal(resForbidden.status, 404, 'admin 也只管自己的网络');
      const resAnon = await api(gw.base, 'GET', `/api/v1/networks/${net.id}/topology`);
      assert.equal(resAnon.status, 401);
      const resSse = await fetch(gw.base + `/api/v1/networks/${net.id}/events`, { headers: { cookie: gw.adminCookie } });
      assert.equal(resSse.status, 404);
      await resSse.body?.cancel();
      const resSseAnon = await fetch(gw.base + `/api/v1/networks/${net.id}/events`);
      assert.equal(resSseAnon.status, 401);
      await resSseAnon.body?.cancel();
    } finally {
      await gw.close();
    }
  });

  test('WSS upgrade 路径白名单：其他路径握手失败', async () => {
    const gw = await startGateway();
    try {
      await assert.rejects(
        () => wsOpen(gw.base, '/api/v1/other'),
        /Unexpected server response|handshake|timeout|timed out|hang up|ECONNRESET|closed/i,
      );
    } finally {
      await gw.close();
    }
  });
});
