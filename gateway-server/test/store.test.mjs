// PG-3 store 契约测试：config 解析、master-key 加密、GatewayStore（SQLite 全量 + Pg mock 契约子集）。
// 测试文件为 .mjs，直接 import 编译产物 ../dist/，避免 Node 22 的 .ts strip 差异。
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolveGatewayConfig } from '../dist/config.js';
import {
  deriveMasterKeyFromSecret,
  loadOrCreateMasterKey,
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  generatePassword,
} from '../dist/master-key.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import { PgStore } from '../dist/store/pg-store.js';
import { StoreError } from '../dist/store/types.js';

const HEX16 = /^[0-9a-f]{16}$/;
const HEX8 = /^[0-9a-f]{8}$/;

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zr-gw-${label}-`));
}

function rejectsCode(promise, code) {
  return assert.rejects(promise, (err) => {
    assert.ok(err instanceof StoreError, `expected StoreError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    return true;
  });
}

// ---------------------------------------------------------------- config

describe('resolveGatewayConfig', () => {
  test('默认值', () => {
    const cfg = resolveGatewayConfig({});
    assert.deepEqual(cfg, {
      port: 19393,
      udpAltPort: 19394,
      publicUrl: undefined,
      dataDir: './data',
      databaseUrl: undefined,
      adminUser: 'admin@local',
      adminPassword: undefined,
      allowSignup: false,
      defaultMaxPeers: 8,
      maxNetworksPerUser: 3,
      relayRateKbps: 4096,
    });
  });

  test('env 覆盖与规范化', () => {
    const cfg = resolveGatewayConfig({
      ZR_GATEWAY_PORT: '20000',
      ZR_GATEWAY_UDP_ALT_PORT: '0', // 显式 0 表示关闭辅助口
      ZR_GATEWAY_PUBLIC_URL: 'https://gw.example.com/',
      ZR_GATEWAY_DATA_DIR: '/srv/gw-data',
      ZR_GATEWAY_DATABASE_URL: 'postgres://db.local:5432/zr',
      ZR_GATEWAY_ADMIN_USER: 'root@local',
      ZR_GATEWAY_ADMIN_PASSWORD: 's3cret',
      ZR_GATEWAY_ALLOW_SIGNUP: '1',
      ZR_GATEWAY_MAX_PEERS: '16',
      ZR_GATEWAY_MAX_NETWORKS_PER_USER: '10',
      ZR_GATEWAY_RELAY_RATE_KBPS: '8192',
    });
    assert.equal(cfg.port, 20000);
    assert.equal(cfg.udpAltPort, 0);
    assert.equal(cfg.publicUrl, 'https://gw.example.com'); // 去掉末尾 /
    assert.equal(cfg.databaseUrl, 'postgres://db.local:5432/zr');
    assert.equal(cfg.adminUser, 'root@local');
    assert.equal(cfg.adminPassword, 's3cret');
    assert.equal(cfg.allowSignup, true);
    assert.equal(cfg.defaultMaxPeers, 16);
    assert.equal(cfg.maxNetworksPerUser, 10);
    assert.equal(cfg.relayRateKbps, 8192);
  });

  test('udpAltPort 缺省跟随 port+1；显式值生效', () => {
    assert.equal(resolveGatewayConfig({ ZR_GATEWAY_PORT: '20001' }).udpAltPort, 20002);
    assert.equal(resolveGatewayConfig({ ZR_GATEWAY_PORT: '20001', ZR_GATEWAY_UDP_ALT_PORT: '20100' }).udpAltPort, 20100);
  });

  test('越界或非法值抛错', () => {
    const cases = [
      { ZR_GATEWAY_PORT: '0' },
      { ZR_GATEWAY_PORT: '65536' },
      { ZR_GATEWAY_PORT: 'abc' },
      { ZR_GATEWAY_UDP_ALT_PORT: '65536' },
      { ZR_GATEWAY_MAX_PEERS: '1' },
      { ZR_GATEWAY_MAX_PEERS: '65' },
      { ZR_GATEWAY_MAX_NETWORKS_PER_USER: '0' },
      { ZR_GATEWAY_MAX_NETWORKS_PER_USER: '51' },
      { ZR_GATEWAY_RELAY_RATE_KBPS: '63' },
      { ZR_GATEWAY_RELAY_RATE_KBPS: '1048577' },
    ];
    for (const env of cases) {
      assert.throws(() => resolveGatewayConfig(env), /ZR_GATEWAY_/);
    }
  });

  test('allowSignup 只认 true/1', () => {
    assert.equal(resolveGatewayConfig({ ZR_GATEWAY_ALLOW_SIGNUP: 'true' }).allowSignup, true);
    assert.equal(resolveGatewayConfig({ ZR_GATEWAY_ALLOW_SIGNUP: 'yes' }).allowSignup, false);
    assert.equal(resolveGatewayConfig({ ZR_GATEWAY_ALLOW_SIGNUP: '' }).allowSignup, false);
  });
});

// ---------------------------------------------------------------- master-key

describe('master-key', () => {
  test('ZR_GATEWAY_SECRET 经 HKDF 派生 32B，同 secret 同 key、异 secret 异 key', () => {
    const a1 = deriveMasterKeyFromSecret('alpha');
    const a2 = deriveMasterKeyFromSecret('alpha');
    const b = deriveMasterKeyFromSecret('beta');
    assert.equal(a1.length, 32);
    assert.deepEqual(a1, a2);
    assert.notDeepEqual(a1, b);
  });

  test('loadOrCreateMasterKey：secret 优先，其次文件（0600、重启可复读）', () => {
    const dir = tmpDir('key');
    try {
      // 无 secret、无文件：生成 32B 且权限 0600
      const k1 = loadOrCreateMasterKey(dir, {});
      assert.equal(k1.length, 32);
      const keyPath = path.join(dir, 'master.key');
      assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
      // 重启（重新打开）读到同一把
      const k2 = loadOrCreateMasterKey(dir, {});
      assert.deepEqual(k1, k2);
      // env secret 优先于已有文件
      const viaEnv = loadOrCreateMasterKey(dir, { ZR_GATEWAY_SECRET: 'alpha' });
      assert.deepEqual(viaEnv, deriveMasterKeyFromSecret('alpha'));
      assert.notDeepEqual(viaEnv, k1);
      // 空 secret 视为未设置
      const empty = loadOrCreateMasterKey(dir, { ZR_GATEWAY_SECRET: '' });
      assert.deepEqual(empty, k1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('master.key 损坏（长度不对）时拒绝启动而不是悄悄换钥匙', () => {
    const dir = tmpDir('key-corrupt');
    try {
      fs.writeFileSync(path.join(dir, 'master.key'), Buffer.alloc(8));
      assert.throws(() => loadOrCreateMasterKey(dir, {}), /master\.key/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('encryptSecret/decryptSecret 往返与格式', () => {
    const key = deriveMasterKeyFromSecret('roundtrip');
    const enc = encryptSecret('join-pass-123', key);
    const parts = enc.split(':');
    assert.deepEqual(parts.slice(0, 1), ['v1']);
    assert.equal(parts.length, 4);
    assert.match(parts[1], /^[0-9a-f]{24}$/); // 12B IV
    assert.match(parts[2], /^[0-9a-f]{32}$/); // 16B authTag
    assert.ok(!enc.includes('join-pass-123'));
    // 同明文两次加密密文不同（随机 IV）
    assert.notEqual(enc, encryptSecret('join-pass-123', key));
    assert.equal(decryptSecret(enc, key), 'join-pass-123');
  });

  test('解密失败：篡改 authTag / 换 masterKey / 坏格式', () => {
    const key = deriveMasterKeyFromSecret('enc-test');
    const other = deriveMasterKeyFromSecret('enc-other');
    const enc = encryptSecret('payload', key);
    const [v, iv, tag, ct] = enc.split(':');
    const tamperedTag = (tag[0] === '0' ? '1' : '0') + tag.slice(1);
    assert.throws(() => decryptSecret(`${v}:${iv}:${tamperedTag}:${ct}`, key));
    assert.throws(() => decryptSecret(enc, other));
    assert.throws(() => decryptSecret('v0:aa:bb:cc', key));
    assert.throws(() => decryptSecret('garbage', key));
  });

  test('hashPassword/verifyPassword：scrypt + 随机盐 + timingSafeEqual', async () => {
    const h1 = await hashPassword('correct horse');
    const h2 = await hashPassword('correct horse');
    assert.notEqual(h1, h2); // 盐随机
    const [scheme, saltHex, hashHex] = h1.split(':');
    assert.equal(scheme, 'scrypt');
    assert.match(saltHex, /^[0-9a-f]{32}$/); // 16B 盐
    assert.ok(await verifyPassword('correct horse', h1));
    assert.ok(!(await verifyPassword('wrong horse', h1)));
    assert.ok(!(await verifyPassword('correct horse', 'garbage')));
    assert.ok(!(await verifyPassword('', h1)));
  });

  test('generatePassword 生成 16 位可用密码', () => {
    const pw = generatePassword();
    assert.equal(pw.length, 16);
    assert.match(pw, /^[A-Za-z0-9]+$/);
    assert.notEqual(pw, generatePassword());
  });
});

// ---------------------------------------------------------------- SqliteStore

describe('SqliteStore', () => {
  const dir = tmpDir('store');
  const dbPath = path.join(dir, 'gateway.db');
  const masterKey = deriveMasterKeyFromSecret('store-test');

  const seed = { allowSignup: false, maxNetworksPerUser: 2, defaultMaxPeers: 4, relayRateKbps: 2048 };

  const store = new SqliteStore({ path: dbPath, seed });

  after(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---- bootstrap admin & users

  const adminEmail = 'admin@local';

  test('空库 ensureBootstrapAdmin：创建 admin 并生成 16 位密码', async () => {
    const res = await store.ensureBootstrapAdmin({ email: adminEmail });
    assert.equal(res.created, true);
    assert.equal(res.email, adminEmail);
    assert.equal(res.generatedPassword.length, 16);
    const admin = await store.findUserByEmail(adminEmail);
    assert.equal(admin.role, 'admin');
    assert.equal(admin.active, true);
    assert.ok(await verifyPassword(res.generatedPassword, admin.passwordHash));
  });

  test('ensureBootstrapAdmin 幂等：已有 admin（无论邮箱）不再创建', async () => {
    const again = await store.ensureBootstrapAdmin({ email: adminEmail });
    assert.equal(again.created, false);
    assert.equal(again.generatedPassword, undefined);
    // 换个邮箱，只要库里已有 admin 也不创建
    const other = await store.ensureBootstrapAdmin({ email: 'another@local' });
    assert.equal(other.created, false);
    assert.equal((await store.listUsers()).length, 1);
  });

  test('createUser：显式密码则用之；邮箱重复抛 duplicate-email', async () => {
    const pw = await hashPassword('tenant-pass');
    const u = await store.createUser({ email: 'tenant@local', passwordHash: pw, role: 'user' });
    assert.match(u.id, /^[0-9a-f]+$/);
    assert.equal(u.role, 'user');
    assert.equal(u.active, true);
    assert.ok(await verifyPassword('tenant-pass', u.passwordHash));
    await rejectsCode(store.createUser({ email: 'tenant@local', passwordHash: pw, role: 'user' }), 'duplicate-email');
  });

  test('findUserByEmail / findUserById / listUsers', async () => {
    assert.ok(await store.findUserByEmail('tenant@local'));
    assert.equal(await store.findUserByEmail('nobody@local'), null);
    const u = await store.findUserByEmail('tenant@local');
    const byId = await store.findUserById(u.id);
    assert.equal(byId.email, 'tenant@local');
    assert.equal(await store.findUserById('nonexistent'), null);
    const emails = (await store.listUsers()).map((r) => r.email).sort();
    assert.deepEqual(emails, ['admin@local', 'tenant@local']);
  });

  // ---- settings

  test('settings：首次按 GatewayConfig 播种，updateSettings 部分更新', async () => {
    assert.deepEqual(await store.getSettings(), seed);
    const updated = await store.updateSettings({ allowSignup: true, relayRateKbps: 4096 });
    assert.deepEqual(updated, { allowSignup: true, maxNetworksPerUser: 2, defaultMaxPeers: 4, relayRateKbps: 4096 });
    assert.deepEqual(await store.getSettings(), updated);
  });

  // ---- networks & join key encryption

  let adminId;
  let userId;

  test('createNetwork：16 位 hex id；join_key_enc 裸查表无明文口令', async () => {
    const admin = await store.findUserByEmail(adminEmail);
    adminId = admin.id;
    const tenant = await store.findUserByEmail('tenant@local');
    userId = tenant.id;

    const net = await store.createNetwork({
      ownerId: userId,
      name: 'tenant-net',
      admissionMode: 'key',
      joinKeyEnc: encryptSecret('open-sesame', masterKey),
      maxPeers: 4,
    });
    assert.match(net.id, HEX16);
    assert.equal(net.ownerId, userId);
    assert.equal(net.admissionMode, 'key');
    assert.ok(!net.joinKeyEnc.includes('open-sesame'));

    // 裸开数据库直查表，确认库里没有任何明文口令
    const raw = new DatabaseSync(dbPath);
    try {
      const row = raw.prepare('SELECT join_key_enc FROM networks WHERE id = ?').get(net.id);
      assert.ok(!row.join_key_enc.includes('open-sesame'));
      assert.equal(decryptSecret(row.join_key_enc, masterKey), 'open-sesame');
    } finally {
      raw.close();
    }
  });

  test('建网配额：普通租户超 maxNetworksPerUser 抛 quota-exceeded；admin 不受限', async () => {
    // seed maxNetworksPerUser=2，tenant 已建 1 个
    await store.createNetwork({ ownerId: userId, name: 't2', admissionMode: 'manual', joinKeyEnc: 'enc', maxPeers: 4 });
    await rejectsCode(
      store.createNetwork({ ownerId: userId, name: 't3', admissionMode: 'manual', joinKeyEnc: 'enc', maxPeers: 4 }),
      'quota-exceeded',
    );
    // admin 建满 3 个不受限
    for (let i = 0; i < 3; i++) {
      await store.createNetwork({ ownerId: adminId, name: `a${i}`, admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 2 });
    }
  });

  test('listNetworksByOwner 只返回自己的网络', async () => {
    const tenantNets = await store.listNetworksByOwner(userId);
    assert.deepEqual(tenantNets.map((n) => n.name).sort(), ['t2', 'tenant-net']);
    const adminNets = await store.listNetworksByOwner(adminId);
    assert.deepEqual(adminNets.map((n) => n.name).sort(), ['a0', 'a1', 'a2']);
  });

  test('updateNetwork：patch 生效；getNetwork 不存在返回 null', async () => {
    const net = (await store.listNetworksByOwner(userId))[0];
    const updated = await store.updateNetwork(net.id, { name: 'renamed', admissionMode: 'both', maxPeers: 8 });
    assert.equal(updated.name, 'renamed');
    assert.equal(updated.admissionMode, 'both');
    assert.equal(updated.maxPeers, 8);
    // joinKeyEnc 不受 patch 影响
    assert.equal(updated.joinKeyEnc, net.joinKeyEnc);
    assert.equal(await store.getNetwork('does-not-exist-0000'), null);
    assert.equal(await store.updateNetwork('does-not-exist-0000', { name: 'x' }), null);
  });

  test('rotateNetworkJoinKey：换密文、可解出新口令', async () => {
    const net = await store.getNetwork((await store.listNetworksByOwner(userId))[0].id);
    const fresh = encryptSecret('second-key', masterKey);
    await store.rotateNetworkJoinKey(net.id, fresh);
    const after = await store.getNetwork(net.id);
    assert.notEqual(after.joinKeyEnc, net.joinKeyEnc);
    assert.equal(after.joinKeyEnc, fresh);
    assert.equal(decryptSecret(after.joinKeyEnc, masterKey), 'second-key');
  });

  // ---- members: join admission

  // 在指定网络上按 admissionMode 造一个入网尝试
  async function join(net, nodeId, { matched = true, pub, name } = {}) {
    return store.upsertMemberJoinAttempt({
      networkId: net.id,
      nodeId,
      name: name ?? `node-${nodeId}`,
      publicKeyHex: pub ?? `${nodeId.padEnd(8, '0').slice(0, 8)}pub`,
      joinKeyMatched: matched,
    });
  }

  // 造一个 manual 网络（无口令路径）与一个 key 网络（口令路径）
  let manualNet;
  let keyNet;

  test('入网判定：manual 无口令 → pending；key 口令匹配 → authorized', async () => {
    manualNet = await store.createNetwork({ ownerId: adminId, name: 'manual-net', admissionMode: 'manual', joinKeyEnc: 'enc', maxPeers: 4 });
    keyNet = await store.createNetwork({ ownerId: adminId, name: 'key-net', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 4 });

    const p = await join(manualNet, 'aaaaaaaa', { matched: false });
    assert.equal(p.status, 'pending');
    assert.match(p.nodeId, HEX8);
    assert.equal(p.publicKeyHex, 'aaaaaaaa' + 'pub');

    // manual 模式（「每台都需要我批准」）：即使持有效邀请链接（matched: true）加入，
    // 也必须进入 pending 等管理员审批，绝不能被当作口令错误拒绝返回 null
    const pWithInvite = await join(manualNet, 'aaabbbcc', { matched: true });
    assert.ok(pWithInvite !== null, 'manual 模式下使用有效邀请链接加入不应被拒绝');
    assert.equal(pWithInvite.status, 'pending');

    const a = await join(keyNet, 'bbbbbbbb', { matched: true });
    assert.equal(a.status, 'authorized');
    assert.equal(a.candidatePublicKeyHex, null);
  });

  test('入网判定：key 口令不匹配 → 拒绝不入库；both 双路径与 pending 补交有效邀请链接直升 authorized', async () => {
    const rejected = await join(keyNet, 'cccccccc', { matched: false });
    assert.equal(rejected, null);
    const members = await store.listMembers(keyNet.id);
    assert.ok(!members.some((m) => m.nodeId === 'cccccccc'));

    const bothNet = await store.createNetwork({ ownerId: adminId, name: 'both-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 4 });
    assert.equal((await join(bothNet, 'dddddddd', { matched: true })).status, 'authorized');
    assert.equal((await join(bothNet, 'eeeeeeee', { matched: false })).status, 'pending');
    // pending 成员随后粘贴有效邀请链接（同公钥 + matched: true）重新握手，应直接升级为 authorized
    assert.equal((await join(bothNet, 'eeeeeeee', { matched: true })).status, 'authorized');
    // manual 模式下 pending 成员即使带邀请链接重试，仍保持 pending 等待人工批准
    assert.equal((await join(manualNet, 'aaabbbcc', { matched: true })).status, 'pending');
  });

  test('F3：口令正确但已准入满额 → 抛 limit-reached（不再与口令错误混淆为 null）', async () => {
    const tight = await store.createNetwork({ ownerId: adminId, name: 'tight-net', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 2 });
    assert.equal((await join(tight, '11111111', { matched: true })).status, 'authorized');
    assert.equal((await join(tight, '22222222', { matched: true })).status, 'authorized');
    await rejectsCode(join(tight, '33333333', { matched: true }), 'limit-reached');
    // key 模式口令不匹配仍然是 null（拒绝不入库）
    assert.equal(await join(tight, '33333333', { matched: false }), null);

    // revoked 复活路径遇满额同样明确抛 limit-reached（both 模式可造 revoked）
    const bothTight = await store.createNetwork({ ownerId: adminId, name: 'tight-both-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 2 });
    await join(bothTight, '51111111', { matched: true });
    await join(bothTight, '52222222', { matched: true }); // 席位占满
    await join(bothTight, '53333333', { matched: false }); // 无口令 → pending
    await store.transitionMemberStatus(bothTight.id, '53333333', 'reject'); // → revoked
    await rejectsCode(join(bothTight, '53333333', { matched: true }), 'limit-reached');
  });

  test('入网判定：同 nodeId 换公钥 → mismatch 暂存候选；mismatch 期间再来同候选保持 mismatch', async () => {
    const m = await join(keyNet, 'bbbbbbbb', { pub: 'bbbbbbbbNEW' });
    assert.equal(m.status, 'mismatch');
    assert.equal(m.candidatePublicKeyHex, 'bbbbbbbbNEW');
    assert.equal(m.publicKeyHex, 'bbbbbbbbpub'); // 原钥匙仍在
    const again = await join(keyNet, 'bbbbbbbb', { pub: 'bbbbbbbbNEW2' });
    assert.equal(again.status, 'mismatch');
    assert.equal(again.candidatePublicKeyHex, 'bbbbbbbbNEW2');
  });

  test('入网判定：pending 成员同钥匙重试 → 保持现状；mismatch 成员交原钥匙 → 维持 mismatch 等裁决', async () => {
    const p = await join(manualNet, 'aaaaaaaa', { matched: false });
    assert.equal(p.status, 'pending');
    const a = await join(keyNet, 'bbbbbbbb', { pub: 'bbbbbbbbpub', matched: true });
    assert.equal(a.status, 'mismatch'); // mismatch 不因同原钥匙重试而消除，等管理员裁决
  });

  test('入网判定：revoked 成员持正确口令重新入网 → 重新判定准入', async () => {
    const revNet = await store.createNetwork({ ownerId: adminId, name: 'rev-net', admissionMode: 'manual', joinKeyEnc: 'enc', maxPeers: 4 });
    const p = await join(revNet, 'ffffffff', { matched: false });
    assert.equal(p.status, 'pending');
    await store.transitionMemberStatus(revNet.id, 'ffffffff', 'reject');
    const before = (await store.listMembers(revNet.id))[0];
    assert.equal(before.status, 'revoked');
    const rejoined = await join(revNet, 'ffffffff', { matched: false });
    assert.equal(rejoined.status, 'pending');
    // both 模式下：无口令 pending 被 reject 成 revoked 后，持口令重新入网直接 authorized
    const revBothNet = await store.createNetwork({ ownerId: adminId, name: 'rev-both-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 4 });
    await join(revBothNet, 'f0f0f0f0', { matched: false });
    await store.transitionMemberStatus(revBothNet.id, 'f0f0f0f0', 'reject');
    const reauthorized = await join(revBothNet, 'f0f0f0f0', { matched: true });
    assert.equal(reauthorized.status, 'authorized');
  });

  // ---- members: transitions

  // 造出五种状态的成员：pending / authorized / paused / mismatch / revoked
  async function memberInState(net, nodeId, wanted) {
    if (wanted === 'pending') return join(net, nodeId, { matched: false });
    if (wanted === 'authorized') return join(net, nodeId, { matched: true });
    if (wanted === 'paused') {
      await join(net, nodeId, { matched: true });
      return store.transitionMemberStatus(net.id, nodeId, 'pause');
    }
    if (wanted === 'mismatch') {
      await join(net, nodeId, { matched: true });
      return join(net, nodeId, { pub: `${nodeId}cand`, matched: true });
    }
    if (wanted === 'revoked') {
      await join(net, nodeId, { matched: false });
      return store.transitionMemberStatus(net.id, nodeId, 'reject');
    }
    throw new Error(`unknown state ${wanted}`);
  }

  test('合法迁移：approve / pause / resume / reject', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'trans-net', admissionMode: 'manual', joinKeyEnc: 'enc', maxPeers: 8 });
    const approved = await store.transitionMemberStatus(net.id, (await memberInState(net, 'a1aaaaaa', 'pending')).nodeId, 'approve');
    assert.equal(approved.status, 'authorized');
    const paused = await store.transitionMemberStatus(net.id, 'a1aaaaaa', 'pause');
    assert.equal(paused.status, 'paused');
    const resumed = await store.transitionMemberStatus(net.id, 'a1aaaaaa', 'resume');
    assert.equal(resumed.status, 'authorized');
    const rejected = await store.transitionMemberStatus(net.id, (await memberInState(net, 'a2aaaaaa', 'pending')).nodeId, 'reject');
    assert.equal(rejected.status, 'revoked');
  });

  test('幂等迁移：authorized→approve/pause/resume、paused→pause', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'idem-net', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 8 });
    await memberInState(net, 'b1aaaaaa', 'authorized');
    assert.equal((await store.transitionMemberStatus(net.id, 'b1aaaaaa', 'approve')).status, 'authorized');
    assert.equal((await store.transitionMemberStatus(net.id, 'b1aaaaaa', 'resume')).status, 'authorized');
    await memberInState(net, 'b2aaaaaa', 'paused');
    assert.equal((await store.transitionMemberStatus(net.id, 'b2aaaaaa', 'pause')).status, 'paused');
  });

  test('approve 满额返回 limit-reached（pending 存量不放行）', async () => {
    // both 模式：口令入网占满席位，无口令进 pending 等审批
    const net = await store.createNetwork({ ownerId: adminId, name: 'limit-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 2 });
    // 两个已授权占满 2 席
    await memberInState(net, 'c1aaaaaa', 'authorized');
    await memberInState(net, 'c2aaaaaa', 'authorized');
    // 第三个 pending 等审批
    await memberInState(net, 'c3aaaaaa', 'pending');
    await rejectsCode(store.transitionMemberStatus(net.id, 'c3aaaaaa', 'approve'), 'limit-reached');
    const still = (await store.listMembers(net.id)).find((m) => m.nodeId === 'c3aaaaaa');
    assert.equal(still.status, 'pending');
  });

  test('F2：pending→mismatch→repin 三步绕不过 maxPeers（满额 repin 抛 limit-reached）', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'bypass-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 2 });
    await join(net, 'b1aaaaaa', { matched: true });
    await join(net, 'b2aaaaaa', { matched: true }); // 两台 authorized 占满
    await join(net, 'b3aaaaaa', { matched: false }); // 第 3 台无口令进 pending（不占席）
    await join(net, 'b3aaaaaa', { pub: 'b3aaaaaaNEW', matched: true }); // 换公钥 → mismatch
    const m = (await store.listMembers(net.id)).find((x) => x.nodeId === 'b3aaaaaa');
    assert.equal(m.status, 'mismatch');
    // repin 必须被容量拦截：此时 authorized+paused = 2 >= maxPeers
    await rejectsCode(store.transitionMemberStatus(net.id, 'b3aaaaaa', 'repin'), 'limit-reached');

    // 合法路径不受误拦：authorized→mismatch→repin（mismatch 期间已空出一个 authorized 席位）
    await join(net, 'b1aaaaaa', { pub: 'b1aaaaaaNEW', matched: true }); // b1: authorized → mismatch
    const repinned = await store.transitionMemberStatus(net.id, 'b1aaaaaa', 'repin');
    assert.equal(repinned.status, 'authorized');
    assert.equal(repinned.publicKeyHex, 'b1aaaaaaNEW');
  });

  test('F2：repin 时候选公钥意外缺失 → invalid-transition，绝不把 null 写进公钥', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'nulcand-net', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 8 });
    await memberInState(net, 'n1aaaaaa', 'mismatch');
    // 直接在库里清掉候选公钥，模拟数据损坏
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare('UPDATE network_members SET candidate_public_key_hex = NULL WHERE network_id = ? AND node_id = ?')
        .run(net.id, 'n1aaaaaa');
    } finally {
      raw.close();
    }
    await rejectsCode(store.transitionMemberStatus(net.id, 'n1aaaaaa', 'repin'), 'invalid-transition');
    const after = (await store.listMembers(net.id)).find((x) => x.nodeId === 'n1aaaaaa');
    assert.equal(after.status, 'mismatch'); // 未发生迁移
    assert.equal(after.publicKeyHex, 'n1aaaaaa' + 'pub'); // 公钥未被污染成 "null"
  });

  test('repin：候选公钥提升为正式钥匙并清空候选、置 authorized（repin 不改变席位占用，不受满额拦截）', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'repin-net', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 8 });
    await memberInState(net, 'd1aaaaaa', 'mismatch');
    const repinned = await store.transitionMemberStatus(net.id, 'd1aaaaaa', 'repin');
    assert.equal(repinned.status, 'authorized');
    assert.equal(repinned.publicKeyHex, 'd1aaaaaacand');
    assert.equal(repinned.candidatePublicKeyHex, null);

    // 单席位网络：成员 authorized → mismatch 后 repin 回 authorized，席位计数不变、可以成功
    const tight = await store.createNetwork({ ownerId: adminId, name: 'repin-tight', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 1 });
    await memberInState(tight, 'd2aaaaaa', 'mismatch'); // authorized → mismatch（capacity 里 mismatch 计 1）
    const repinnedTight = await store.transitionMemberStatus(tight.id, 'd2aaaaaa', 'repin');
    assert.equal(repinnedTight.status, 'authorized');
    assert.equal(repinnedTight.publicKeyHex, 'd2aaaaaacand');
  });

  test('mismatch→reject：吊销并清空候选', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'mrej-net', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 8 });
    await memberInState(net, 'e1aaaaaa', 'mismatch');
    const rejected = await store.transitionMemberStatus(net.id, 'e1aaaaaa', 'reject');
    assert.equal(rejected.status, 'revoked');
    assert.equal(rejected.candidatePublicKeyHex, null);
  });

  test('非法迁移全部抛 invalid-transition', async () => {
    // both 模式允许在同一网络上造出全部五种状态
    const net = await store.createNetwork({ ownerId: adminId, name: 'ill-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 8 });
    // 先把各状态的成员都造在同一个网络上（注意容量：maxPeers 8；mismatch 计容量）
    await memberInState(net, 'f1aaaaaa', 'authorized');
    await memberInState(net, 'f2aaaaaa', 'paused');
    await memberInState(net, 'f3aaaaaa', 'pending');
    await memberInState(net, 'f4aaaaaa', 'mismatch');
    await memberInState(net, 'f5aaaaaa', 'revoked');

    const illegal = [
      ['f4aaaaaa', 'approve'], // mismatch 不能 approve，必须 repin 或 reject
      ['f5aaaaaa', 'approve'], // revoked 终态，须重新入网
      ['f1aaaaaa', 'reject'],
      ['f2aaaaaa', 'reject'],
      ['f5aaaaaa', 'reject'],
      ['f3aaaaaa', 'pause'], // 未准入不能暂停
      ['f4aaaaaa', 'pause'],
      ['f5aaaaaa', 'pause'],
      ['f3aaaaaa', 'resume'],
      ['f4aaaaaa', 'resume'],
      ['f5aaaaaa', 'resume'],
      ['f3aaaaaa', 'repin'],
      ['f1aaaaaa', 'repin'],
      ['f2aaaaaa', 'repin'],
      ['f5aaaaaa', 'repin'],
    ];
    for (const [nodeId, action] of illegal) {
      await rejectsCode(store.transitionMemberStatus(net.id, nodeId, action), 'invalid-transition');
    }
    // 成员不存在也是明确报错
    await rejectsCode(store.transitionMemberStatus(net.id, 'no-such1', 'approve'), 'member-not-found');
  });

  test('removeMember 删除成员', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'rm-net', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 4 });
    await memberInState(net, 'aa1aaaaa', 'authorized');
    await store.removeMember(net.id, 'aa1aaaaa');
    const list = await store.listMembers(net.id);
    assert.ok(!list.some((m) => m.nodeId === 'aa1aaaaa'));
  });

  test('flushMemberTelemetry：字节累加、lastIp/natType/lastSeenAt 更新', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'tele-net', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 4 });
    await memberInState(net, 'ab1aaaaa', 'authorized');
    await store.flushMemberTelemetry([
      { networkId: net.id, nodeId: 'ab1aaaaa', relayBytesDelta: 80, lastIp: '203.0.113.9', natType: 'cone', lastSeenAt: '2026-11-10T00:00:00.000Z' },
    ]);
    await store.flushMemberTelemetry([
      { networkId: net.id, nodeId: 'ab1aaaaa', relayBytesDelta: 70, lastIp: '203.0.113.10', natType: 'symmetric' },
    ]);
    const m = (await store.listMembers(net.id)).find((x) => x.nodeId === 'ab1aaaaa');
    assert.equal(m.cumulativeRelayBytes, 150);
    assert.equal(m.lastIp, '203.0.113.10');
    assert.equal(m.natType, 'symmetric');
    assert.equal(m.lastSeenAt, '2026-11-10T00:00:00.000Z');
    // 空 patch 只更新给定字段
    await store.flushMemberTelemetry([{ networkId: net.id, nodeId: 'ab1aaaaa', relayBytesDelta: 5 }]);
    const m2 = (await store.listMembers(net.id)).find((x) => x.nodeId === 'ab1aaaaa');
    assert.equal(m2.cumulativeRelayBytes, 155);
    assert.equal(m2.lastIp, '203.0.113.10');
  });

  test('deleteNetwork 级联删除成员', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'cascade-net', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 4 });
    await memberInState(net, 'ac1aaaaa', 'authorized');
    await store.deleteNetwork(net.id);
    assert.equal(await store.getNetwork(net.id), null);
    const raw = new DatabaseSync(dbPath);
    try {
      const left = raw.prepare('SELECT COUNT(*) AS n FROM network_members WHERE network_id = ?').get(net.id);
      assert.equal(left.n, 0);
    } finally {
      raw.close();
    }
  });

  // ---- sessions

  test('sessions：签发→读取→过期→清理', async () => {
    const user = await store.findUserByEmail('tenant@local');
    const issued = await store.createSession(user.id, 60_000);
    assert.match(issued.token, /^[0-9a-f]{64}$/);
    assert.notEqual(issued.tokenHash, issued.token); // 存的是哈希
    const seen = await store.getSessionUser(issued.tokenHash, Date.now());
    assert.equal(seen.id, user.id);
    // 推进到过期点之后
    assert.equal(await store.getSessionUser(issued.tokenHash, Date.now() + 61_000), null);
    // prune 清掉过期行（fresh 用长 TTL，确保只有 issued 一行过期）
    const fresh = await store.createSession(user.id, 3_600_000);
    const pruned = await store.pruneExpiredSessions(Date.now() + 61_000);
    assert.equal(pruned, 1);
    assert.ok(await store.getSessionUser(fresh.tokenHash, Date.now()));
    // 主动登出
    await store.deleteSession(fresh.tokenHash);
    assert.equal(await store.getSessionUser(fresh.tokenHash, Date.now()), null);
    // 未知 token
    assert.equal(await store.getSessionUser('deadbeef', Date.now()), null);
  });

  test('禁用用户：登录会话全部清理、读取立即失效；恢复 active 不会复活会话', async () => {
    const user = await store.findUserByEmail('tenant@local');
    const s1 = await store.createSession(user.id, 3_600_000);
    const s2 = await store.createSession(user.id, 3_600_000);
    await store.setUserActive(user.id, false);
    assert.equal(await store.getSessionUser(s1.tokenHash, Date.now()), null);
    assert.equal(await store.getSessionUser(s2.tokenHash, Date.now()), null);
    // 库里的 sessions 行确实没了
    const raw = new DatabaseSync(dbPath);
    try {
      const left = raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id);
      assert.equal(left.n, 0);
    } finally {
      raw.close();
    }
    const listed = (await store.listUsers()).find((u) => u.id === user.id);
    assert.equal(listed.active, false);
    // 重新签发也不行（active=false）
    const s3 = await store.createSession(user.id, 3_600_000);
    assert.equal(await store.getSessionUser(s3.tokenHash, Date.now()), null);
    // 恢复 active：新会话可用，旧会话不会复活
    await store.setUserActive(user.id, true);
    assert.equal(await store.getSessionUser(s1.tokenHash, Date.now()), null);
    assert.ok(await store.getSessionUser(s3.tokenHash, Date.now()));
  });

  // ---- restart persistence

  test('重启持久化：重新打开同一库，设置/用户/网络/成员全部恢复', async () => {
    const reopened = new SqliteStore({ path: dbPath }); // 不再传 seed：已有库不能被 seed 覆盖
    try {
      assert.deepEqual(await reopened.getSettings(), { allowSignup: true, maxNetworksPerUser: 2, defaultMaxPeers: 4, relayRateKbps: 4096 });
      const emails = (await reopened.listUsers()).map((u) => u.email).sort();
      assert.deepEqual(emails, ['admin@local', 'tenant@local']);
      const nets = await reopened.listNetworksByOwner(adminId);
      assert.ok(nets.length >= 3);
      const keyNetAfter = nets.find((n) => n.name === 'key-net');
      const members = await reopened.listMembers(keyNetAfter.id);
      // 剧情回顾：bbbbbbbb 在前文换过公钥，重开后保持 mismatch + 候选
      const mismatched = members.find((m) => m.nodeId === 'bbbbbbbb');
      assert.ok(mismatched);
      assert.equal(mismatched.status, 'mismatch');
      assert.equal(mismatched.candidatePublicKeyHex, 'bbbbbbbbNEW2');
      // tenant 侧 rotate 后的 join_key_enc 在重开后仍可解出
      const tenantNets = await reopened.listNetworksByOwner(userId);
      const renamed = tenantNets.find((n) => n.name === 'renamed');
      assert.equal(decryptSecret(renamed.joinKeyEnc, masterKey), 'second-key');
    } finally {
      await reopened.close();
    }
  });
});

// ---------------------------------------------------------------- PgStore（注入 mock query 的契约测试）

describe('PgStore contract (mock query)', () => {
  function mockQuery(routes) {
    const calls = [];
    const TX_RE = /^(BEGIN|COMMIT|ROLLBACK)$/;
    const fn = async (sql, params = []) => {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: norm, params });
      // 事务控制语句静默应答（仍进 calls 供断言），业务 SQL 走路由表
      if (TX_RE.test(norm)) return { rows: [] };
      const hit = routes.find(([re]) => re.test(norm));
      if (!hit) throw new Error(`mockQuery: unexpected SQL: ${norm}`);
      const produce = hit[1];
      return { rows: typeof produce === 'function' ? produce(params, calls) : produce };
    };
    fn.calls = calls;
    fn.dataCalls = () => calls.filter((c) => !TX_RE.test(c.sql));
    fn.txStatements = () => calls.filter((c) => TX_RE.test(c.sql)).map((c) => c.sql);
    return fn;
  }

  const NOW = new Date('2026-11-10T08:00:00.000Z');

  // PC-06：按路由应答并把每次调用记进独立数组（外层池与 tx 各自记账用）
  function mockRoutesOnly(calls, routes) {
    const TX_RE = /^(BEGIN|COMMIT|ROLLBACK)$/;
    return async (sql, params = []) => {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: norm, params });
      if (TX_RE.test(norm)) return { rows: [] };
      const hit = routes.find(([re]) => re.test(norm));
      if (!hit) throw new Error(`mockRoutesOnly: unexpected SQL: ${norm}`);
      const produce = hit[1];
      return { rows: typeof produce === 'function' ? produce(params, calls) : produce };
    };
  }

  test('getSettings：snake_case 行与字符串值映射为 camelCase 强类型', async () => {
    const q = mockQuery([
      [/FROM system_settings/, [
        { key: 'allow_signup', value: 'true' },
        { key: 'max_networks_per_user', value: '5' },
        { key: 'default_max_peers', value: '8' },
        { key: 'relay_rate_kbps', value: '1024' },
      ]],
    ]);
    const pg = new PgStore(q);
    const settings = await pg.getSettings();
    assert.deepEqual(settings, { allowSignup: true, maxNetworksPerUser: 5, defaultMaxPeers: 8, relayRateKbps: 1024 });
    assert.equal(q.calls[0].sql.startsWith('SELECT key, value FROM system_settings'), true);
  });

  test('createNetwork：普通租户先锁 owner 行再查配额，事务回滚且 count 字符串正确比较', async () => {
    const q = mockQuery([
      [/FROM users WHERE id = .*FOR UPDATE/, [{ role: 'user' }]],
      [/FROM system_settings/, [
        { key: 'allow_signup', value: 'false' },
        { key: 'max_networks_per_user', value: '3' },
        { key: 'default_max_peers', value: '8' },
        { key: 'relay_rate_kbps', value: '4096' },
      ]],
      [/COUNT\(\*\).*FROM networks WHERE owner_id/, [{ count: '3' }]],
    ]);
    const pg = new PgStore(q);
    await rejectsCode(
      pg.createNetwork({ ownerId: 'u1', name: 'n', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 4 }),
      'quota-exceeded',
    );
    const data = q.dataCalls();
    assert.equal(q.calls[0].sql, 'BEGIN');
    assert.match(data[0].sql, /FROM users WHERE id = \$1 FOR UPDATE/); // 行级锁串行化同 owner 的并发建网
    assert.deepEqual(data[0].params, ['u1']);
    assert.match(data[1].sql, /FROM system_settings/); // 配额来自系统设置（updateSettings 可改）
    assert.match(data[2].sql, /COUNT\(\*\).*FROM networks WHERE owner_id = \$1/);
    assert.deepEqual(data[2].params, ['u1', 3]); // 限额同语句传入做原子比较
    assert.deepEqual(q.txStatements(), ['BEGIN', 'ROLLBACK']); // 超限抛错 → 回滚
  });

  test('createNetwork：admin 免配额，INSERT RETURNING 行映射回 camelCase', async () => {
    const row = {
      id: '0123456789abcdef',
      owner_id: 'admin1',
      name: 'a-net',
      admission_mode: 'both',
      join_key_enc: 'enc-payload',
      max_peers: 6,
      created_at: NOW,
    };
    const q = mockQuery([
      [/FROM users WHERE id = .*FOR UPDATE/, [{ role: 'admin' }]],
      [/INSERT INTO networks/, [row]],
    ]);
    const pg = new PgStore(q);
    const net = await pg.createNetwork({ ownerId: 'admin1', name: 'a-net', admissionMode: 'both', joinKeyEnc: 'enc-payload', maxPeers: 6 });
    assert.deepEqual(net, {
      id: '0123456789abcdef',
      ownerId: 'admin1',
      name: 'a-net',
      admissionMode: 'both',
      joinKeyEnc: 'enc-payload',
      maxPeers: 6,
      createdAt: '2026-11-10T08:00:00.000Z',
    });
    assert.deepEqual(q.txStatements(), ['BEGIN', 'COMMIT']); // admin 不查配额但仍走事务
    const data = q.dataCalls();
    const insert = data[1];
    assert.match(insert.sql, /INSERT INTO networks \(id, owner_id, name, admission_mode, join_key_enc, max_peers, created_at\)/);
    assert.match(insert.params[0], /^[0-9a-f]{16}$/); // id 由 store 生成
    assert.deepEqual(insert.params.slice(1, 6), ['admin1', 'a-net', 'both', 'enc-payload', 6]);
  });

  test('upsertMemberJoinAttempt：口令匹配 + 容量未满 → INSERT authorized（参数核对）', async () => {
    const netRow = { id: 'net1', admission_mode: 'key', max_peers: 4 };
    const newMemberRow = {
      network_id: 'net1',
      node_id: 'abcd1234',
      name: 'node-abcd1234',
      note: null,
      status: 'authorized',
      public_key_hex: 'pubhex',
      candidate_public_key_hex: null,
      last_ip: null,
      nat_type: 'unknown',
      cumulative_relay_bytes: '0',
      last_seen_at: null,
      created_at: NOW,
    };
    const q = mockQuery([
      [/FROM networks WHERE id =/, [netRow]],
      [/FROM network_members WHERE network_id = \$1 AND node_id = \$2$/, []],
      [/COUNT\(\*\).*FROM network_members/, [{ count: '2' }]],
      [/INSERT INTO network_members/, [newMemberRow]],
    ]);
    const pg = new PgStore(q);
    const m = await pg.upsertMemberJoinAttempt({ networkId: 'net1', nodeId: 'abcd1234', publicKeyHex: 'pubhex', joinKeyMatched: true });
    assert.equal(m.status, 'authorized');
    assert.equal(m.cumulativeRelayBytes, 0); // pg 的 BIGINT 字符串转 number
    assert.equal(m.createdAt, '2026-11-10T08:00:00.000Z'); // Date → ISO
    assert.deepEqual(q.txStatements(), ['BEGIN', 'COMMIT']);
    const insert = q.dataCalls()[3];
    assert.equal(insert.params[0], 'net1');
    assert.equal(insert.params[1], 'abcd1234');
    assert.equal(insert.params[4], 'authorized');
  });

  test('upsertMemberJoinAttempt：已有成员换公钥 → UPDATE 置 mismatch + 候选', async () => {
    const netRow = { id: 'net1', admission_mode: 'key', max_peers: 4 };
    const existing = {
      network_id: 'net1', node_id: 'abcd1234', name: 'n', note: null,
      status: 'authorized', public_key_hex: 'oldpub', candidate_public_key_hex: null,
      last_ip: null, nat_type: 'unknown', cumulative_relay_bytes: '5', last_seen_at: null, created_at: NOW,
    };
    const updatedRow = { ...existing, status: 'mismatch', candidate_public_key_hex: 'newpub' };
    const q = mockQuery([
      [/FROM networks WHERE id =/, [netRow]],
      [/FROM network_members WHERE network_id = \$1 AND node_id = \$2$/, [existing]],
      [/UPDATE network_members/, [updatedRow]],
    ]);
    const pg = new PgStore(q);
    const m = await pg.upsertMemberJoinAttempt({ networkId: 'net1', nodeId: 'abcd1234', publicKeyHex: 'newpub', joinKeyMatched: true });
    assert.equal(m.status, 'mismatch');
    assert.equal(m.candidatePublicKeyHex, 'newpub');
    const upd = q.dataCalls()[2];
    assert.match(upd.sql, /status = \$\d+, candidate_public_key_hex = \$\d+/);
    assert.ok(upd.params.includes('mismatch'));
    assert.ok(upd.params.includes('newpub'));
  });

  test('transitionMemberStatus：approve 满额 → limit-reached（网络行加锁）；UPDATE 行映射', async () => {
    const memberRow = {
      network_id: 'net1', node_id: 'p1', name: 'n', note: null,
      status: 'pending', public_key_hex: 'pub', candidate_public_key_hex: null,
      last_ip: null, nat_type: 'unknown', cumulative_relay_bytes: '0', last_seen_at: null, created_at: NOW,
    };
    const q = mockQuery([
      [/FROM networks WHERE id = .*FOR UPDATE/, [{ id: 'net1', max_peers: 2 }]],
      [/FROM network_members WHERE network_id = \$1 AND node_id = \$2$/, [memberRow]],
      [/COUNT\(\*\).*FROM network_members/, [{ count: '2' }]],
    ]);
    const pg = new PgStore(q);
    await rejectsCode(pg.transitionMemberStatus('net1', 'p1', 'approve'), 'limit-reached');
    assert.deepEqual(q.txStatements(), ['BEGIN', 'ROLLBACK']);
    assert.match(q.dataCalls()[0].sql, /FROM networks WHERE id = \$1 FOR UPDATE/); // 锁网络行串行化容量裁决

    const approvedRow = { ...memberRow, status: 'authorized' };
    const q2 = mockQuery([
      [/FROM networks WHERE id = .*FOR UPDATE/, [{ id: 'net1', max_peers: 2 }]],
      [/FROM network_members WHERE network_id = \$1 AND node_id = \$2$/, [memberRow]],
      [/COUNT\(\*\).*FROM network_members/, [{ count: '1' }]],
      [/UPDATE network_members/, [approvedRow]],
    ]);
    const pg2 = new PgStore(q2);
    const m = await pg2.transitionMemberStatus('net1', 'p1', 'approve');
    assert.equal(m.status, 'authorized');
    assert.deepEqual(q2.txStatements(), ['BEGIN', 'COMMIT']);
  });

  test('getSessionUser：JOIN 映射；无行 → null', async () => {
    const row = {
      token_hash: 'h1',
      expires_at: new Date('2026-11-10T09:00:00.000Z'),
      id: 'u1',
      email: 'x@local',
      password_hash: 'scrypt:aa:bb',
      role: 'user',
      active: true,
      created_at: NOW,
    };
    const q = mockQuery([[/JOIN users u ON/, [row]]]);
    const pg = new PgStore(q);
    const user = await pg.getSessionUser('h1', NOW.getTime());
    assert.deepEqual(user, {
      id: 'u1', email: 'x@local', passwordHash: 'scrypt:aa:bb', role: 'user', active: true,
      createdAt: '2026-11-10T08:00:00.000Z',
    });
    const empty = new PgStore(mockQuery([[/JOIN users u ON/, []]]));
    assert.equal(await empty.getSessionUser('h2', NOW.getTime()), null);
  });

  test('flushMemberTelemetry：字节走 SQL 累加，其余字段 COALESCE', async () => {
    const q = mockQuery([[/UPDATE network_members/, []]]);
    const pg = new PgStore(q);
    await pg.flushMemberTelemetry([
      { networkId: 'net1', nodeId: 'nd1', relayBytesDelta: 128, lastIp: '10.0.0.2', natType: 'cone', lastSeenAt: NOW.toISOString() },
      { networkId: 'net1', nodeId: 'nd2', relayBytesDelta: 1 },
    ]);
    const [first, second] = q.dataCalls();
    assert.match(first.sql, /cumulative_relay_bytes = cumulative_relay_bytes \+ \$1/);
    assert.match(first.sql, /last_ip = COALESCE\(\$2, last_ip\)/);
    assert.match(first.sql, /nat_type = COALESCE\(\$3, nat_type\)/);
    assert.match(first.sql, /last_seen_at = COALESCE\(\$4, last_seen_at\)/);
    assert.deepEqual(first.params, [128, '10.0.0.2', 'cone', '2026-11-10T08:00:00.000Z', 'net1', 'nd1']);
    assert.deepEqual(second.params, [1, null, null, null, 'net1', 'nd2']);
  });

  test('initSchema 输出可执行的建表 DDL（幂等 CREATE IF NOT EXISTS）', async () => {
    const q = mockQuery([[/.+/, []]]);
    const pg = new PgStore(q);
    await pg.initSchema();
    const allSql = q.dataCalls().map((c) => c.sql).join('\n');
    for (const table of ['system_settings', 'users', 'sessions', 'networks', 'network_members']) {
      assert.match(allSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
    assert.match(allSql, /REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.match(allSql, /REFERENCES networks\(id\) ON DELETE CASCADE/);
  });

  test('F1：createUser 捕获唯一约束 23505 → duplicate-email（不再泄漏原生错误）', async () => {
    const dupErr = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: '23505' });
    const q = mockQuery([
      [/INSERT INTO users/, () => {
        throw dupErr;
      }],
    ]);
    const pg = new PgStore(q);
    await rejectsCode(
      pg.createUser({ email: 'x@local', passwordHash: 'scrypt:aa:bb', role: 'user' }),
      'duplicate-email',
    );
  });

  test('F1/F3：upsertMemberJoinAttempt 口令匹配但满额 → limit-reached（事务回滚）', async () => {
    const q = mockQuery([
      [/FROM networks WHERE id = .*FOR UPDATE/, [{ id: 'net1', admission_mode: 'key', max_peers: 2 }]],
      [/FROM network_members WHERE network_id = \$1 AND node_id = \$2$/, []],
      [/COUNT\(\*\).*FROM network_members/, [{ count: '2' }]],
    ]);
    const pg = new PgStore(q);
    await rejectsCode(
      pg.upsertMemberJoinAttempt({ networkId: 'net1', nodeId: 'abcd1234', publicKeyHex: 'p', joinKeyMatched: true }),
      'limit-reached',
    );
    assert.deepEqual(q.txStatements(), ['BEGIN', 'ROLLBACK']);
    assert.match(q.dataCalls()[0].sql, /FROM networks WHERE id = \$1 FOR UPDATE/);
  });

  test('F1/F2：repin 候选公钥缺失 → invalid-transition（PG 契约）', async () => {
    const corruptedMismatch = {
      network_id: 'net1', node_id: 'p1', name: 'n', note: null,
      status: 'mismatch', public_key_hex: 'pub', candidate_public_key_hex: null, // 数据损坏：候选为空
      last_ip: null, nat_type: 'unknown', cumulative_relay_bytes: '0', last_seen_at: null, created_at: NOW,
    };
    const q = mockQuery([
      [/FROM networks WHERE id = .*FOR UPDATE/, [{ id: 'net1', max_peers: 2 }]],
      [/FROM network_members WHERE network_id = \$1 AND node_id = \$2$/, [corruptedMismatch]],
    ]);
    const pg = new PgStore(q);
    await rejectsCode(pg.transitionMemberStatus('net1', 'p1', 'repin'), 'invalid-transition');
    assert.deepEqual(q.txStatements(), ['BEGIN', 'ROLLBACK']);
  });

  // PC-06：事务接缝契约。真实 pool 模式下 withTransaction checkout 独立连接（tx），
  // 事务体内若再调用 this.getSettings() 这类外层 query，就等于持事务连接去申请池内
  // 第二条连接——同 owner 并发占用剩余连接后互相等待。此测试用独立 runner 复刻该形态：
  // 外层池与 tx 分别记账，事务路径的任何 SQL 都不允许落到外层池上。
  test('PC-06：createNetwork 事务内所有查询走 tx 连接，不得回调外层池', async () => {
    const netRow = {
      id: '0123456789abcdef',
      owner_id: 'u1',
      name: 'n',
      admission_mode: 'key',
      join_key_enc: 'enc',
      max_peers: 4,
      created_at: NOW,
    };
    const routes = [
      [/FROM users WHERE id = .*FOR UPDATE/, [{ role: 'user' }]],
      [/FROM system_settings/, [
        { key: 'allow_signup', value: 'false' },
        { key: 'max_networks_per_user', value: '3' },
        { key: 'default_max_peers', value: '8' },
        { key: 'relay_rate_kbps', value: '4096' },
      ]],
      [/COUNT\(\*\).*FROM networks WHERE owner_id/, [{ count: '0' }]],
      [/INSERT INTO networks/, [netRow]],
    ];
    const outerCalls = [];
    const txCalls = [];
    const outer = mockRoutesOnly(outerCalls, routes);
    const tx = mockRoutesOnly(txCalls, routes);
    const pg = new PgStore(outer, {
      withTransaction: (fn) => fn(tx), // 真实形态：tx 是独立连接，与外层池不同函数
    });
    const net = await pg.createNetwork({ ownerId: 'u1', name: 'n', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 4 });
    assert.equal(net.id, '0123456789abcdef');
    assert.equal(outerCalls.length, 0, `事务路径不得在外层池上执行查询，实际: ${outerCalls.map((c) => c.sql).join('; ')}`);
    const txSql = txCalls.map((c) => c.sql);
    assert.ok(txSql.some((s) => /FROM users WHERE id = \$1 FOR UPDATE/.test(s)), 'owner 行锁应在 tx 上');
    assert.ok(txSql.some((s) => /FROM system_settings/.test(s)), '配额 settings 应在 tx 上查询（复用事务连接）');
    assert.ok(txSql.some((s) => /COUNT\(\*\).*FROM networks/.test(s)), '配额计数应在 tx 上');
    assert.ok(txSql.some((s) => /INSERT INTO networks/.test(s)), '插入应在 tx 上');
  });

  test('PC-06：getSettings 非事务调用仍走外层池（行为不变）', async () => {
    const routes = [
      [/FROM system_settings/, [
        { key: 'max_networks_per_user', value: '7' },
      ]],
    ];
    const outerCalls = [];
    const outer = mockRoutesOnly(outerCalls, routes);
    const pg = new PgStore(outer);
    const settings = await pg.getSettings();
    assert.equal(settings.maxNetworksPerUser, 7);
    assert.equal(outerCalls.length, 1);
    assert.match(outerCalls[0].sql, /SELECT key, value FROM system_settings/);
  });

  test('F1：ensureBootstrapAdmin 与 setUserActive 均在事务内执行（PG 契约）', async () => {
    const q1 = mockQuery([
      [/FROM users WHERE role = 'admin' LIMIT 1 FOR UPDATE/, []],
      [/INSERT INTO users/, [{ id: 'u9', email: 'a@local', password_hash: 'h', role: 'admin', active: true, created_at: NOW }]],
    ]);
    const pg1 = new PgStore(q1);
    const res = await pg1.ensureBootstrapAdmin({ email: 'a@local' });
    assert.equal(res.created, true);
    assert.deepEqual(q1.txStatements(), ['BEGIN', 'COMMIT']);
    assert.match(q1.dataCalls()[0].sql, /FROM users WHERE role = 'admin' LIMIT 1 FOR UPDATE/);

    const q2 = mockQuery([
      [/UPDATE users SET active/, [{ id: 'u1' }]],
      [/DELETE FROM sessions/, []],
    ]);
    const pg2 = new PgStore(q2);
    await pg2.setUserActive('u1', false);
    assert.deepEqual(q2.txStatements(), ['BEGIN', 'COMMIT']);
    assert.match(q2.dataCalls()[0].sql, /UPDATE users SET active = \$2 WHERE id = \$1 RETURNING id/);
    assert.match(q2.dataCalls()[1].sql, /DELETE FROM sessions WHERE user_id = \$1/);
  });
});
