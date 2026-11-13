// PC-19 第二片受控子进程：经**真实 main() 入口**（SIGINT/SIGTERM 处理器在生产
// 代码里安装）验证关停形态——
//   ok      ：少量真实中转流量尚未周期落库 → 父进程 SIGTERM → close 补末批 → 退出 0，
//             父进程重开数据库读回最终累计。
//   hang    ：flushMemberTelemetry 受控永不完成（模拟存储不响应）→ SIGTERM →
//             close 在墙钟预算耗尽后如实拒绝 → 非零退出。
//   udp-hang：UdpStunService.close 受控永不完成（模拟**早期关停步骤**卡点）→
//             SIGTERM → 生产入口仍须在预算 + 有限清理宽限内自有非零退出，失败
//             兜底不得重新卡死在卡点上。
// 环境由父进程提供（ZR_GATEWAY_*，见 pc19-shutdown.test.mjs）。
// 就绪标记：stdout 打印 `PC19_CHILD_READY bytes=<N> net=... sender=...`。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { main } from '../dist/main.js';
import { loadOrCreateMasterKey, encryptSecret } from '../dist/master-key.js';
import { PgStore } from '../dist/store/pg-store.js';
import { UdpStunService } from '../dist/peer-hub/udp-stun.js';

const modeArg = process.argv[2] ?? 'ok';
const mode = ['ok', 'hang', 'udp-hang'].includes(modeArg) ? modeArg : 'ok';
const port = Number(process.env.ZR_GATEWAY_PORT);
if (!Number.isInteger(port) || port < 1) {
  console.error('PC19_CHILD_FAIL: ZR_GATEWAY_PORT missing');
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;
const dataDir = process.env.ZR_GATEWAY_DATA_DIR;
const joinKey = 'pc19-child-join-key';
const adminEmail = process.env.ZR_GATEWAY_ADMIN_USER;
const adminPassword = process.env.ZR_GATEWAY_ADMIN_PASSWORD;

// ---- 节点身份与帧（与 test/peer-hub.test.mjs 同一套自证明方案的最小子集）----

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
const joinProof = (key, networkId, nodeId, challengeHex) =>
  crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.from(`zr-join-v1|${networkId}|${nodeId}|${challengeHex}`, 'utf8')).digest('hex');

function attach(ws) {
  ws.__queue = [];
  ws.__waiters = [];
  ws.on('message', (data) => {
    let json;
    try {
      json = JSON.parse(Buffer.from(data).toString('utf8'));
    } catch {
      json = { __raw: true };
    }
    const waiter = ws.__waiters.shift();
    if (waiter !== undefined) waiter(json);
    else ws.__queue.push(json);
  });
}

const wsJson = (ws, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child ws message timeout')), timeoutMs);
    const deliver = (json) => {
      clearTimeout(timer);
      resolve(json);
    };
    if (ws.__queue.length > 0) deliver(ws.__queue.shift());
    else ws.__waiters.push(deliver);
  });

const wsOpen = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    attach(ws);
    const timer = setTimeout(() => reject(new Error('child ws open timeout')), 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

async function authNode(ws, node, { networkId }) {
  const challenge = await wsJson(ws);
  if (challenge.type !== 'challenge') throw new Error(`expected challenge, got ${JSON.stringify(challenge)}`);
  const timestamp = Date.now();
  ws.send(JSON.stringify({
    type: 'auth',
    networkId,
    nodeId: node.nodeId,
    publicKeyHex: node.publicKeyHex,
    name: `child-${node.nodeId}`,
    lanEndpoints: [],
    timestamp,
    signatureHex: edSign(node.privateKeyHex, node.publicKeyHex, authMessage(networkId, node.nodeId, challenge.challengeHex, timestamp)),
    joinKeyProofHex: joinProof(joinKey, networkId, node.nodeId, challenge.challengeHex),
  }));
}

// ---- 1. 预播种：与网关共用同一 master.key，建 key 模式网络与两名授权成员 ----

fs.mkdirSync(dataDir, { recursive: true });
const masterKey = loadOrCreateMasterKey(dataDir); // main() 随后读取同一文件，密钥一致
const seeder = await PgStore.connect(process.env.ZR_GATEWAY_DATABASE_URL);
try {
  const admin = await seeder.ensureBootstrapAdmin({ email: adminEmail, password: adminPassword });
  const net = await seeder.createNetwork({
    ownerId: (await seeder.findUserByEmail(adminEmail)).id,
    name: 'pc19-child-net',
    admissionMode: 'key',
    joinKeyEnc: encryptSecret(joinKey, masterKey),
    maxPeers: 8,
  });
  void admin;
  globalThis.__pc19NetId = net.id;
  for (const node of [identity(), identity()]) {
    const joined = await seeder.upsertMemberJoinAttempt({
      networkId: net.id,
      nodeId: node.nodeId,
      publicKeyHex: node.publicKeyHex,
      joinKeyMatched: true,
    });
    if (joined.status !== 'authorized') throw new Error(`seed join not authorized: ${joined.status}`);
    (globalThis.__pc19Nodes ??= []).push(node);
  }
} finally {
  await seeder.close();
}

// ---- 2. hang / udp-hang 模式武装（受控永不完成，仅本测试进程）----

if (mode === 'hang') {
  PgStore.prototype.flushMemberTelemetry = async () => new Promise(() => {});
}
if (mode === 'udp-hang') {
  // 第一层关停步骤（udp.close）即卡点：生产入口的失败兜底不得重新卡死在这里
  UdpStunService.prototype.close = async () => new Promise(() => {});
}

// ---- 3. 真实入口：main() 安装 SIGINT/SIGTERM 优雅停机处理器 ----

await main(process.env);

// ---- 4. 网关就绪后驱动一帧真实中转流量，然后宣告 READY ----

const networkId = globalThis.__pc19NetId;
const [a, b] = globalThis.__pc19Nodes;
const wsA = await wsOpen(base.replace(/^http/, 'ws') + '/peer/v1/ws');
await authNode(wsA, a, { networkId });
if ((await wsJson(wsA)).status !== 'authorized') throw new Error('child node A not authorized');
const wsB = await wsOpen(base.replace(/^http/, 'ws') + '/peer/v1/ws');
await authNode(wsB, b, { networkId });
if ((await wsJson(wsB)).status !== 'authorized') throw new Error('child node B not authorized');
await wsJson(wsB); // punch-coordinate（对 A）
await wsJson(wsA); // peer-joined（B 上线）
await wsJson(wsA); // punch-coordinate（对 B）

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
const received = await wsJson(wsB);
if (received.__raw !== true) throw new Error('child: B did not receive the relay frame');

console.log(`PC19_CHILD_READY bytes=${frameBuf.length} net=${networkId} sender=${a.nodeId}`);
// 进程保持存活（server/udp 监听），等父进程 SIGTERM 触发 main() 的关停处理器
