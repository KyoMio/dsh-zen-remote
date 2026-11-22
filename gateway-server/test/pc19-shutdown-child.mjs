// PC-19 第二片受控子进程：经真实 main() 入口（安装 SIGINT/SIGTERM 处理器）验证
// SQLite 形态下 SIGTERM → close 补末批 → exit(0)，父进程重开 SQLite 读回最终累计。
// 就绪标记：stdout 打印 `PC19_CHILD_READY bytes=<N> net=... sender=...`。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { main } from '../dist/main.js';
import { loadOrCreateMasterKey, encryptSecret } from '../dist/master-key.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';

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
    try { json = JSON.parse(Buffer.from(data).toString('utf8')); } catch { json = { __raw: true }; }
    const waiter = ws.__waiters.shift();
    if (waiter !== undefined) waiter(json);
    else ws.__queue.push(json);
  });
}

const wsJson = (ws, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child ws message timeout')), timeoutMs);
    const deliver = (json) => { clearTimeout(timer); resolve(json); };
    if (ws.__queue.length > 0) deliver(ws.__queue.shift());
    else ws.__waiters.push(deliver);
  });

const wsOpen = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    attach(ws);
    const timer = setTimeout(() => reject(new Error('child ws open timeout')), 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
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

fs.mkdirSync(dataDir, { recursive: true });
const masterKey = loadOrCreateMasterKey(dataDir);
const seeder = new SqliteStore({ path: path.join(dataDir, 'gateway.sqlite') });
let networkId;
const nodes = [identity(), identity()];
try {
  await seeder.ensureBootstrapAdmin({ email: adminEmail, password: adminPassword });
  const admin = await seeder.findUserByEmail(adminEmail);
  const net = await seeder.createNetwork({
    ownerId: admin.id,
    name: 'pc19-child-net',
    admissionMode: 'key',
    joinKeyEnc: encryptSecret(joinKey, masterKey),
    maxPeers: 8,
  });
  networkId = net.id;
  for (const node of nodes) {
    const joined = await seeder.upsertMemberJoinAttempt({
      verifiedJoinKeyEnc: net.joinKeyEnc,
      networkId: net.id,
      nodeId: node.nodeId,
      publicKeyHex: node.publicKeyHex,
      joinKeyMatched: true,
    });
    if (joined.status !== 'authorized') throw new Error(`seed join not authorized: ${joined.status}`);
  }
} finally {
  await seeder.close();
}

await main(process.env);

const [a, b] = nodes;
const wsA = await wsOpen(base.replace(/^http/, 'ws') + '/peer/v1/ws');
await authNode(wsA, a, { networkId });
if ((await wsJson(wsA)).status !== 'authorized') throw new Error('child node A not authorized');
const wsB = await wsOpen(base.replace(/^http/, 'ws') + '/peer/v1/ws');
await authNode(wsB, b, { networkId });
if ((await wsJson(wsB)).status !== 'authorized') throw new Error('child node B not authorized');
await wsJson(wsB); // punch-coordinate (A)
await wsJson(wsA); // peer-joined (B)
await wsJson(wsA); // punch-coordinate (B)

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
