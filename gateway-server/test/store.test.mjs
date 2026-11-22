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
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import { PgStore } from '../dist/store/pg-store.js';
import { decideJoinAttempt, StoreError } from '../dist/store/types.js';
import { gatewayLeaveMessage, verifyGatewayLeaveSignature } from '../dist/peer-hub/peer-crypto.js';
import { TENANT_HASH } from './helpers/fixtures.mjs';

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
      certDir: path.resolve('certs'),
      databaseUrl: undefined,
      adminUser: 'admin@local',
      adminPassword: undefined,
      allowSignup: false,
      defaultMaxPeers: 8,
      maxNetworksPerUser: 3,
      relayRateKbps: 4096,
      autoUpdateEnabled: true,
    });
  });

  test('env 覆盖与规范化', () => {
    const cfg = resolveGatewayConfig({
      ZR_GATEWAY_PORT: '20000',
      ZR_GATEWAY_UDP_ALT_PORT: '0', // 显式 0 表示关闭辅助口
      ZR_GATEWAY_PUBLIC_URL: 'https://gw.example.com/',
      ZR_GATEWAY_DATA_DIR: '/srv/gw-data',
      ZR_GATEWAY_CERT_DIR: '/certs',
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
    assert.equal(cfg.certDir, '/certs');
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

describe('PgStore network partial patches', () => {
  function fixture(t, beforeQuery = async () => {}) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(`CREATE TABLE networks (
      id TEXT PRIMARY KEY, owner_id TEXT, name TEXT NOT NULL, admission_mode TEXT NOT NULL,
      join_key_enc TEXT, max_peers INTEGER NOT NULL, peer_direct_max_rtt_ms INTEGER NOT NULL, created_at TEXT
    )`);
    db.prepare('INSERT INTO networks VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('network', 'owner', 'Home', 'manual', 'encrypted-key', 8, 300, '2026-01-01T00:00:00.000Z');
    const store = new PgStore(async (sql, params = []) => {
      await beforeQuery(sql);
      const values = [];
      const sqliteSql = sql.replace(/\$(\d+)/g, (_, index) => {
        values.push(params[Number(index) - 1]);
        return '?';
      });
      return { rows: db.prepare(sqliteSql).all(...values) };
    });
    return store;
  }

  test('interleaved patches from the same baseline preserve both fields', { timeout: 5000 }, async (t) => {
    let updates = 0;
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const store = fixture(t, async sql => {
      if (sql.startsWith('UPDATE networks SET')) {
        if (++updates === 2) release();
        await ready;
      }
    });
    const baseline = await store.getNetwork('network');
    const renamed = { name: `${baseline.name}'s new name` };
    const latency = { peerDirectMaxRttMs: baseline.peerDirectMaxRttMs + 200 };
    await Promise.all([store.updateNetwork(baseline.id, renamed), store.updateNetwork(baseline.id, latency)]);
    assert.deepEqual(await store.getNetwork(baseline.id), { ...baseline, ...renamed, ...latency });
  });

  test('partial, empty and missing-row updates retain returned record semantics', async (t) => {
    const store = fixture(t);
    let expected = await store.getNetwork('network');
    for (const patch of [{ name: "Home's network" }, { admissionMode: 'both' }, { maxPeers: 12 }, { peerDirectMaxRttMs: 0 }, {}, { name: undefined }]) {
      expected = { ...expected, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
      assert.deepEqual(await store.updateNetwork('network', patch), expected);
    }
    assert.equal(await store.updateNetwork('missing', {}), null);
    assert.equal(await store.updateNetwork('missing', { name: 'Absent' }), null);
  });

  test('database write failures propagate', async () => {
    const failure = new Error('Write unavailable');
    const store = new PgStore(async () => { throw failure; });
    await assert.rejects(store.updateNetwork('network', { name: 'Renamed' }), error => error === failure);
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
    // getSettings 只返回基础 4 键（扩展键走 getExtendedSettings，绝不混进基础设置）
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

  test('network patches write only supplied columns, including zero RTT', async (t) => {
    const dir = tmpDir('network-patch');
    let store;
    let raw;
    t.after(async () => {
      raw?.close();
      await store?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const dbPath = path.join(dir, 'gateway.db');
    store = new SqliteStore({ path: dbPath });
    const owner = await store.createUser({ email: 'patch-owner@local', passwordHash: await hashPassword('patch-test-password'), role: 'admin' });
    const net = await store.createNetwork({ ownerId: owner.id, name: 'Patch test', admissionMode: 'manual', joinKeyEnc: 'encrypted-key', maxPeers: 8 });
    raw = new DatabaseSync(dbPath);
    const columns = ['name', 'admission_mode', 'max_peers', 'peer_direct_max_rtt_ms'];
    raw.exec('CREATE TABLE network_patch_columns (name TEXT)');
    for (const column of columns) {
      raw.exec(`CREATE TRIGGER patch_${column} AFTER UPDATE OF ${column} ON networks
        BEGIN INSERT INTO network_patch_columns VALUES ('${column}'); END`);
    }
    let expected = await store.getNetwork(net.id);
    for (const [patch, written] of [
      [{ name: "Admin's renamed network" }, ['name']],
      [{ peerDirectMaxRttMs: 0 }, ['peer_direct_max_rtt_ms']],
      [{ admissionMode: 'both', maxPeers: 12 }, ['admission_mode', 'max_peers']],
      [{}, []], [{ name: undefined }, []],
    ]) {
      expected = { ...expected, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
      assert.deepEqual(await store.updateNetwork(net.id, patch), expected);
      assert.deepEqual(raw.prepare('SELECT name FROM network_patch_columns ORDER BY name').all().map(row => row.name), written);
      raw.exec('DELETE FROM network_patch_columns');
    }
    assert.equal(await store.updateNetwork('missing', {}), null);
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

  test('PC-10：满网下幂等动作不抛 limit-reached、占席数不变（重复 approve/resume/pause 不重复计席）', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'idem-full-net', admissionMode: 'key', joinKeyEnc: 'enc', maxPeers: 2 });
    await memberInState(net, 'e7aaaaaa', 'authorized');
    await memberInState(net, 'e8aaaaaa', 'paused'); // 2/2 占满
    assert.equal((await store.transitionMemberStatus(net.id, 'e7aaaaaa', 'approve')).status, 'authorized');
    assert.equal((await store.transitionMemberStatus(net.id, 'e7aaaaaa', 'approve')).status, 'authorized');
    assert.equal((await store.transitionMemberStatus(net.id, 'e8aaaaaa', 'resume')).status, 'authorized');
    assert.equal((await store.transitionMemberStatus(net.id, 'e8aaaaaa', 'pause')).status, 'paused');
    const occupying = (await store.listMembers(net.id)).filter((m) => ['authorized', 'paused', 'mismatch'].includes(m.status)).length;
    assert.equal(occupying, 2);
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

  test('PC-10：满网 pending 换公钥 → 入网层抛 limit-reached 保持 pending（mismatch 占席，不借道滑入）；authorized→mismatch→repin 席位不变可换锚', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'bypass-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 2 });
    await join(net, 'b1aaaaaa', { matched: true });
    await join(net, 'b2aaaaaa', { matched: true }); // 两台 authorized 占满
    await join(net, 'b3aaaaaa', { matched: false }); // 第 3 台无口令进 pending（不占席）
    // pending（不占席）→ mismatch（占席）是新增席位：满网必须在入网层拒绝，不能借 mismatch 滑入占席
    await rejectsCode(join(net, 'b3aaaaaa', { pub: 'b3aaaaaa' + 'ff'.repeat(28), matched: true }), 'limit-reached');
    const m = (await store.listMembers(net.id)).find((x) => x.nodeId === 'b3aaaaaa');
    assert.equal(m.status, 'pending');
    assert.equal(m.candidatePublicKeyHex, null);

    // authorized→mismatch 是占席内的原位换钥（席位不变），满网下 repin 换锚放行
    await join(net, 'b1aaaaaa', { pub: 'b1aaaaaa' + 'ee'.repeat(28), matched: true }); // b1: authorized → mismatch
    const repinned = await store.transitionMemberStatus(net.id, 'b1aaaaaa', 'repin');
    assert.equal(repinned.status, 'authorized');
    assert.equal(repinned.publicKeyHex, 'b1aaaaaa' + 'ee'.repeat(28));
  });

  test('PC-10：approve 计数与准入同口径——authorized+mismatch 两席占满时审批新 pending 拒绝；mismatch→reject 释放席位后空位可批', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'mix-limit-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 2 });
    await memberInState(net, 'c4aaaaaa', 'authorized');
    await memberInState(net, 'c5aaaaaa', 'mismatch'); // authorized 原位换钥 → mismatch（仍占原席位）
    await memberInState(net, 'c6aaaaaa', 'pending');
    // 占席成员 2/2（authorized+mismatch 都占席）：approve（不占席 → 占席）必须拒绝
    await rejectsCode(store.transitionMemberStatus(net.id, 'c6aaaaaa', 'approve'), 'limit-reached');
    const still = (await store.listMembers(net.id)).find((m) => m.nodeId === 'c6aaaaaa');
    assert.equal(still.status, 'pending');

    // mismatch→reject 释放席位（占席 → 不占席），腾出的空位可被合法批准
    await store.transitionMemberStatus(net.id, 'c5aaaaaa', 'reject'); // mismatch → revoked
    const approved = await store.transitionMemberStatus(net.id, 'c6aaaaaa', 'approve');
    assert.equal(approved.status, 'authorized');
  });

  test('PC-10：缩容后超额存量 resume/repin 保留原席位放行，新增占席仍拒绝（不断言总数小于新上限）', async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'shrink-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 3 });
    await memberInState(net, 'd3aaaaaa', 'authorized');
    await memberInState(net, 'd4aaaaaa', 'paused');
    await memberInState(net, 'd5aaaaaa', 'mismatch'); // 3 名占席成员
    await store.updateNetwork(net.id, { maxPeers: 1 }); // 缩容：存量全保留、瞬时超额
    // 占席 → 占席：resume / repin 保留原席位，超额也不被重复计席拒绝
    const resumed = await store.transitionMemberStatus(net.id, 'd4aaaaaa', 'resume');
    assert.equal(resumed.status, 'authorized');
    const repinned = await store.transitionMemberStatus(net.id, 'd5aaaaaa', 'repin');
    assert.equal(repinned.status, 'authorized');
    assert.equal(repinned.publicKeyHex, 'd5aaaaaacand');
    // 缩容后新增占席仍拒绝：满额（超额）下批准新 pending 必须 limit-reached
    await memberInState(net, 'd6aaaaaa', 'pending');
    await rejectsCode(store.transitionMemberStatus(net.id, 'd6aaaaaa', 'approve'), 'limit-reached');
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

// ---------------------------------------------------------------- GC-2：用户组 / 配额 / 月度流量 / 邮箱 OTP（SQLite 全量）

describe('SqliteStore GC-2 扩展', () => {
  function freshStore(seed) {
    return new SqliteStore({ seed });
  }

  test('旧库迁移：预建无新列的 users 表，打开后新列与默认组自动补齐', async () => {
    const dir = tmpDir('gc2-migrate');
    const dbPath = path.join(dir, 'legacy.db');
    // 旧版形：users 没有 group_id/group_expires_at/email_verified_at；settings 只有 3 个键
    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(`
        CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin','user')),
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
        INSERT INTO system_settings (key, value) VALUES ('max_networks_per_user', '5'), ('default_max_peers', '6'), ('relay_rate_kbps', '2048');
        INSERT INTO users (id, email, password_hash, role, active, created_at) VALUES ('legacy1', 'old@local', 'scrypt:aa:bb', 'user', 1, '2026-01-01T00:00:00.000Z');
      `);
    } finally {
      legacy.close();
    }
    const store = new SqliteStore({ path: dbPath }); // 无 seed 重开：缺键补默认、已有键不动
    try {
      const user = await store.findUserByEmail('old@local');
      assert.equal(user.groupId, 'grp_default'); // 旧行回落默认组
      assert.equal(user.groupExpiresAt, null);
      assert.equal(user.emailVerifiedAt, null);
      // 默认组按旧库已有设置播种（缺的 allow_signup 等键按默认补齐，不覆盖已有值）
      const groups = await store.listUserGroups();
      assert.equal(groups.length, 1);
      assert.equal(groups[0].id, 'grp_default');
      assert.equal(groups[0].code, 'default');
      assert.equal(groups[0].isDefault, true);
      assert.equal(groups[0].maxNetworks, 5);
      assert.equal(groups[0].maxPeersPerNetwork, 6);
      assert.equal(groups[0].relayRateKbps, 2048);
      // 裸查表确认新列真的在
      const raw = new DatabaseSync(dbPath);
      try {
        const cols = raw.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
        assert.ok(cols.includes('group_id') && cols.includes('group_expires_at') && cols.includes('email_verified_at'));
      } finally {
        raw.close();
      }
    } finally {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('旧库迁移：networks 缺 peer_direct_max_rtt_ms 列时打开后补齐，旧行回落默认 300', async () => {
    const dir = tmpDir('net-rtt-migrate');
    const dbPath = path.join(dir, 'legacy.db');
    // 旧版形：networks 没有 peer_direct_max_rtt_ms（其余列照 T3 之前形）
    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(`
        CREATE TABLE networks (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          name TEXT NOT NULL,
          admission_mode TEXT NOT NULL CHECK (admission_mode IN ('key','manual','both')),
          join_key_enc TEXT NOT NULL,
          max_peers INTEGER NOT NULL CHECK (max_peers BETWEEN 1 AND 64),
          created_at TEXT NOT NULL
        );
        INSERT INTO networks (id, owner_id, name, admission_mode, join_key_enc, max_peers, created_at)
        VALUES ('netlegacy1', 'legacy-owner', 'old net', 'key', 'not-a-real-ciphertext', 8, '2026-01-01T00:00:00.000Z');
      `);
    } finally {
      legacy.close();
    }
    const store = new SqliteStore({ path: dbPath });
    try {
      const net = await store.getNetwork('netlegacy1');
      assert.ok(net !== null);
      assert.equal(net.maxPeers, 8);
      assert.equal(net.peerDirectMaxRttMs, 300, '旧行由列默认值回落 300ms');
      const raw = new DatabaseSync(dbPath);
      try {
        const cols = raw.prepare('PRAGMA table_info(networks)').all().map((c) => c.name);
        assert.ok(cols.includes('peer_direct_max_rtt_ms'));
      } finally {
        raw.close();
      }
    } finally {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('默认组与 system_settings 双向同步', async () => {
    const store = freshStore({ allowSignup: false, maxNetworksPerUser: 4, defaultMaxPeers: 8, relayRateKbps: 512 });
    try {
      // 设置侧 → 默认组：改三项配额任一项即写回默认组对应列
      await store.updateSettings({ maxNetworksPerUser: 9, defaultMaxPeers: 10 });
      const def = await store.getUserGroupByCode('default');
      assert.equal(def.maxNetworks, 9);
      assert.equal(def.maxPeersPerNetwork, 10);
      assert.equal(def.relayRateKbps, 512);
      // 组侧 → 设置：修改当前默认组配额同步写回 system_settings
      await store.updateUserGroup(def.id, { relayRateKbps: 1024 });
      assert.equal((await store.getSettings()).relayRateKbps, 1024);
      // 新组置默认：旧默认让位 + 新组配额写回设置
      const vip = await store.createUserGroup({
        code: 'vip',
        name: 'VIP',
        isDefault: true,
        maxNetworks: 50,
        maxPeersPerNetwork: 32,
        relayRateKbps: 8192,
        monthlyRelayQuotaBytes: 10_000_000_000,
      });
      assert.equal(vip.isDefault, true);
      assert.equal((await store.getUserGroupByCode('default')).isDefault, false);
      const settings = await store.getSettings();
      assert.equal(settings.maxNetworksPerUser, 50);
      assert.equal(settings.defaultMaxPeers, 32);
      assert.equal(settings.relayRateKbps, 8192);
      // 再把 default 设回默认，双向同步继续成立
      await store.updateUserGroup(def.id, { isDefault: true });
      assert.equal((await store.getSettings()).maxNetworksPerUser, 9);
    } finally {
      await store.close();
    }
  });

  test('GC-2-fix1 扩展设置：getExtendedSettings 全 14 键（含 tls_*）；updateExtendedSettings 部分更新 + sessionTtlDays 钳位', async () => {
    const store = freshStore({ allowSignup: false, maxNetworksPerUser: 4, defaultMaxPeers: 8, relayRateKbps: 512 });
    try {
      // 空库播种后的完整形状：sessionTtlDays 默认 7，tlsEnabled 默认三态 null
      const ext = await store.getExtendedSettings();
      assert.deepEqual(ext, {
        allowSignup: false,
        maxNetworksPerUser: 4,
        defaultMaxPeers: 8,
        relayRateKbps: 512,
        requireEmailVerification: false,
        publicUrl: null,
        sessionTtlDays: 7,
        smtpConfigEnc: null,
        adminApiKeyHash: null,
        adminApiKeyPrefix: null,
        adminApiKeyCreatedAt: null,
        tlsEnabled: null,
        tlsCertFile: 'fullchain.pem',
        tlsKeyFile: 'privkey.pem',
        autoUpdateEnabled: true,
      });
      // 扩展键部分更新（含可空字符串、时间戳与 TLS 三态字段往返）；未在 patch 里的键不受影响
      const updated = await store.updateExtendedSettings({
        requireEmailVerification: true,
        publicUrl: 'https://gw.example.com',
        sessionTtlDays: 14,
        smtpConfigEnc: 'v1:aa:bb:cc',
        adminApiKeyHash: 'hash-abc',
        adminApiKeyPrefix: 'zr_abcd',
        adminApiKeyCreatedAt: '2026-11-13T00:00:00.000Z',
        tlsEnabled: true,
        tlsCertFile: 'cert.pem',
        tlsKeyFile: 'key.pem',
      });
      assert.deepEqual(updated, {
        ...ext,
        requireEmailVerification: true,
        publicUrl: 'https://gw.example.com',
        sessionTtlDays: 14,
        smtpConfigEnc: 'v1:aa:bb:cc',
        adminApiKeyHash: 'hash-abc',
        adminApiKeyPrefix: 'zr_abcd',
        adminApiKeyCreatedAt: '2026-11-13T00:00:00.000Z',
        tlsEnabled: true,
        tlsCertFile: 'cert.pem',
        tlsKeyFile: 'key.pem',
      });
      // 三态开关显式关（false）与恢复未配置（null）区分不混淆
      assert.equal((await store.updateExtendedSettings({ tlsEnabled: false })).tlsEnabled, false);
      assert.equal((await store.updateExtendedSettings({ tlsEnabled: null })).tlsEnabled, null);
      // 置 null 落空串、读回 null；其余键保持
      const nulled = await store.updateExtendedSettings({ publicUrl: null, smtpConfigEnc: null });
      assert.equal(nulled.publicUrl, null);
      assert.equal(nulled.smtpConfigEnc, null);
      assert.equal(nulled.adminApiKeyHash, 'hash-abc');
      // sessionTtlDays 按 SPEC 5.4.3 钳位 1..90
      assert.equal((await store.updateExtendedSettings({ sessionTtlDays: 0 })).sessionTtlDays, 1);
      assert.equal((await store.updateExtendedSettings({ sessionTtlDays: 500 })).sessionTtlDays, 90);
      // 基础 getSettings 仍只有 4 键，扩展内部字段（密文/哈希）绝不混入
      const base = await store.getSettings();
      assert.deepEqual(base, { allowSignup: false, maxNetworksPerUser: 4, defaultMaxPeers: 8, relayRateKbps: 512 });
      assert.ok(!('adminApiKeyHash' in base) && !('sessionTtlDays' in base));
    } finally {
      await store.close();
    }
  });

  test('GC-2-fix1 扩展设置与默认组双向同步：活跃默认组非 grp_default 时也写对组', async () => {
    const store = freshStore({ allowSignup: false, maxNetworksPerUser: 4, defaultMaxPeers: 8, relayRateKbps: 512 });
    try {
      const vip = await store.createUserGroup({ code: 'vip', name: 'VIP', isDefault: true, maxNetworks: 50, maxPeersPerNetwork: 32, relayRateKbps: 8192 });
      assert.equal((await store.getUserGroupByCode('default')).isDefault, false);
      // 扩展设置改配额键 + 一个扩展键：配额写进当前活跃默认组 vip，其余列不动
      await store.updateExtendedSettings({ maxNetworksPerUser: 60, sessionTtlDays: 30 });
      const vipAfter = await store.getUserGroup(vip.id);
      assert.equal(vipAfter.maxNetworks, 60);
      assert.equal(vipAfter.maxPeersPerNetwork, 32);
      assert.equal(vipAfter.relayRateKbps, 8192);
      assert.equal((await store.getExtendedSettings()).sessionTtlDays, 30);
    } finally {
      await store.close();
    }
  });

  test('GC-2-fix1 新组升为默认后：createUser 自动归入；配额失效回退当前 is_default 组；重开不复活第二个默认组', async () => {
    const dir = tmpDir('gc2-default-follow');
    const dbPath = path.join(dir, 'gw.db');
    let store = new SqliteStore({ path: dbPath, seed: { allowSignup: false, maxNetworksPerUser: 3, defaultMaxPeers: 8, relayRateKbps: 512 } });
    let vipId;
    let defaultId;
    try {
      const vip = await store.createUserGroup({ code: 'vip', name: 'VIP', isDefault: true, maxNetworks: 77, maxPeersPerNetwork: 40, relayRateKbps: 16384 });
      vipId = vip.id;
      defaultId = (await store.getUserGroupByCode('default')).id;
      assert.equal((await store.getUserGroup(defaultId)).isDefault, false);

      // 未显式指定组的新用户原子归入当前活跃默认组 vip（而非固定 grp_default）
      const newcomer = await store.createUser({ email: 'newcomer@local', passwordHash: 'h', role: 'user' });
      assert.equal(newcomer.groupId, vipId);
      // 显式指定组直接写入；组不存在抛 group-not-found
      const explicit = await store.createUser({ email: 'explicit@local', passwordHash: 'h', role: 'user', groupId: defaultId });
      assert.equal(explicit.groupId, defaultId);
      await rejectsCode(store.createUser({ email: 'badgroup@local', passwordHash: 'h', role: 'user', groupId: 'grp_missing' }), 'group-not-found');

      // 旧默认组（grp_default，已失活）配额到期 → 回退到当前 is_default 组 vip
      await store.updateUserByAdmin(explicit.id, { groupExpiresAt: '2020-01-01T00:00:00.000Z' });
      const quota = await store.resolveEffectiveUserQuota(explicit.id);
      assert.equal(quota.isExpiredFallback, true);
      assert.equal(quota.assignedGroupId, defaultId);
      assert.equal(quota.group.code, 'vip');
      // 建网配额走 vip 的 77（默认组 3 会拒）：连建 4 个全部成功
      for (let i = 0; i < 4; i++) {
        await store.createNetwork({ ownerId: explicit.id, name: `n${i}`, admissionMode: 'manual', joinKeyEnc: 'enc', maxPeers: 2 });
      }
    } finally {
      await store.close();
    }

    // 裸删 grp_default 行 + grp_default 仍是库里唯一 is_default 行之外的组织——
    // 重开时 vip 仍是活跃默认组，绝不能再插入一个 is_default=1 的 grp_default
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare('DELETE FROM user_groups WHERE id = ?').run(defaultId);
    } finally {
      raw.close();
    }
    store = new SqliteStore({ path: dbPath }); // 无 seed 重开
    try {
      const groups = await store.listUserGroups();
      assert.deepEqual(groups.map((g) => g.code), ['vip'], 'grp_default 行已删则重开不复活');
      assert.deepEqual(groups.filter((g) => g.isDefault).map((g) => g.id), [vipId], '重开不得出现第二个默认组');
      // 重开后新用户仍归入 vip
      const after = await store.createUser({ email: 'post-reopen@local', passwordHash: 'h', role: 'user' });
      assert.equal(after.groupId, vipId);
    } finally {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GC-2-fix1 PC-07 风格：删掉 relay_rate_kbps 后重开，活跃默认组的该配额同步补齐', async () => {
    const dir = tmpDir('gc2-pc07-refill');
    const dbPath = path.join(dir, 'gw.db');
    let store = new SqliteStore({ path: dbPath, seed: { allowSignup: false, maxNetworksPerUser: 3, defaultMaxPeers: 8, relayRateKbps: 512 } });
    let vipId;
    try {
      // 默认组切到 vip：512 的 relay_rate_kbps 留在失活的 grp_default，vip 是活跃默认组
      const vip = await store.createUserGroup({ code: 'vip', name: 'VIP', isDefault: true, maxNetworks: 9, maxPeersPerNetwork: 9, relayRateKbps: 7777 });
      vipId = vip.id;
    } finally {
      await store.close();
    }
    // 模拟旧版本库缺键：裸删单个设置行后重开（无 seed，缺键按默认补 4096）
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare('DELETE FROM system_settings WHERE key = ?').run('relay_rate_kbps');
    } finally {
      raw.close();
    }
    store = new SqliteStore({ path: dbPath });
    try {
      assert.equal((await store.getSettings()).relayRateKbps, 4096, '缺键按 DEFAULT_SETTINGS 补齐');
      // 活跃默认组 vip 的 relay_rate_kbps 同步补齐（防止 system_settings 与默认组漂移）
      const vipAfter = await store.getUserGroup(vipId);
      assert.equal(vipAfter.relayRateKbps, 4096);
      // 本次没有新插入的其余配额键不动 vip 的对应列；失活的 grp_default 也不被同步
      assert.equal(vipAfter.maxNetworks, 9);
      assert.equal((await store.getUserGroupByCode('default')).relayRateKbps, 512);
    } finally {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('用户组 CRUD：字段校验、code 唯一、禁删默认组、在用组与 group-not-found', async () => {
    const store = freshStore();
    try {
      // validateGroupInput 规则逐条拦截
      await assert.rejects(
        store.createUserGroup({ code: 'UPPER', name: 'x', maxNetworks: 1, maxPeersPerNetwork: 2, relayRateKbps: 64 }),
        /group code/,
      );
      await assert.rejects(
        store.createUserGroup({ code: 'ok1', name: '', maxNetworks: 1, maxPeersPerNetwork: 2, relayRateKbps: 64 }),
        /group name/,
      );
      await assert.rejects(
        store.createUserGroup({ code: 'ok2', name: 'x', maxNetworks: 0, maxPeersPerNetwork: 2, relayRateKbps: 64 }),
        /maxNetworks/,
      );
      await assert.rejects(
        store.createUserGroup({ code: 'ok3', name: 'x', maxNetworks: 1, maxPeersPerNetwork: 1, relayRateKbps: 64 }),
        /maxPeersPerNetwork/,
      );
      await assert.rejects(
        store.createUserGroup({ code: 'ok4', name: 'x', maxNetworks: 1, maxPeersPerNetwork: 2, relayRateKbps: 63 }),
        /relayRateKbps/,
      );
      await assert.rejects(
        store.createUserGroup({ code: 'ok5', name: 'x', maxNetworks: 1, maxPeersPerNetwork: 2, relayRateKbps: 64, monthlyRelayQuotaBytes: 0 }),
        /monthlyRelayQuotaBytes/,
      );

      const pro = await store.createUserGroup({ code: 'pro', name: '专业版', description: '付费用户', maxNetworks: 10, maxPeersPerNetwork: 16, relayRateKbps: 4096 });
      assert.match(pro.id, /^grp_[0-9a-f]{16}$/);
      assert.equal((await store.getUserGroupByCode('pro')).id, pro.id);
      assert.equal(await store.getUserGroupByCode('missing'), null);
      await rejectsCode(
        store.createUserGroup({ code: 'pro', name: '重复', maxNetworks: 1, maxPeersPerNetwork: 2, relayRateKbps: 64 }),
        'duplicate-group-code',
      );
      // updateUserGroup：组不存在 / 校验失败
      await rejectsCode(store.updateUserGroup('grp_missing', { name: 'x' }), 'group-not-found');
      await assert.rejects(store.updateUserGroup(pro.id, { maxNetworks: 1000 }), /maxNetworks/);
      const renamed = await store.updateUserGroup(pro.id, { name: 'Pro', monthlyRelayQuotaBytes: null });
      assert.equal(renamed.name, 'Pro');
      assert.equal(renamed.monthlyRelayQuotaBytes, null);

      // 删除守卫：默认组禁删、在用组禁删、未知组 group-not-found
      const def = await store.getUserGroupByCode('default');
      await rejectsCode(store.deleteUserGroup(def.id), 'cannot-delete-default-group');
      const member = await store.createUser({ email: 'm@local', passwordHash: 'h', role: 'user', groupId: pro.id });
      await rejectsCode(store.deleteUserGroup(pro.id), 'group-in-use');
      await rejectsCode(store.deleteUserGroup('grp_missing'), 'group-not-found');
      // 移除引用后可删
      await store.updateUserByAdmin(member.id, { groupId: def.id });
      await store.deleteUserGroup(pro.id);
      assert.equal(await store.getUserGroup(pro.id), null);
    } finally {
      await store.close();
    }
  });

  test('groupExpiresAt 到期自动回退默认组；建网配额走有效组；resolveNetworkEffectiveQuota', async () => {
    const store = freshStore({ allowSignup: false, maxNetworksPerUser: 3, defaultMaxPeers: 8, relayRateKbps: 512 });
    try {
      const vip = await store.createUserGroup({ code: 'vip', name: 'VIP', maxNetworks: 99, maxPeersPerNetwork: 32, relayRateKbps: 8192 });
      const user = await store.createUser({ email: 'u@local', passwordHash: 'h', role: 'user', groupId: vip.id });
      const T0 = Date.parse('2026-11-01T00:00:00.000Z');

      // 未到期 → vip；yearMonth 按注入时钟取 UTC 年月
      await store.updateUserByAdmin(user.id, { groupExpiresAt: '2026-11-02T00:00:00.000Z' });
      let quota = await store.resolveEffectiveUserQuota(user.id, T0);
      assert.equal(quota.isExpiredFallback, false);
      assert.equal(quota.group.code, 'vip');
      assert.equal(quota.assignedGroupId, vip.id);
      assert.equal(quota.groupExpiresAt, '2026-11-02T00:00:00.000Z');
      assert.equal(quota.yearMonth, '2026-11');
      assert.equal(quota.monthlyRelayUsedBytes, 0);

      // 过期 → 回退默认组（assignedGroupId 保持登记值）
      quota = await store.resolveEffectiveUserQuota(user.id, Date.parse('2026-11-02T00:00:01.000Z'));
      assert.equal(quota.isExpiredFallback, true);
      assert.equal(quota.group.code, 'default');
      assert.equal(quota.group.maxNetworks, 3);
      assert.equal(quota.assignedGroupId, vip.id);

      // 建网配额走有效组：未到期按 vip（99）不受限；过期后按默认组 3 个拒绝
      for (let i = 0; i < 3; i++) {
        await store.createNetwork({ ownerId: user.id, name: `n${i}`, admissionMode: 'key', joinKeyEnc: 'e', maxPeers: 4 });
      }
      await store.updateUserByAdmin(user.id, { groupExpiresAt: '2020-01-01T00:00:00.000Z' }); // 永远已过期
      await rejectsCode(
        store.createNetwork({ ownerId: user.id, name: 'n3', admissionMode: 'key', joinKeyEnc: 'e', maxPeers: 4 }),
        'quota-exceeded',
      );

      // 清除到期时间后恢复 vip；网络属主配额解析可用
      await store.updateUserByAdmin(user.id, { groupExpiresAt: null });
      quota = await store.resolveEffectiveUserQuota(user.id);
      assert.equal(quota.isExpiredFallback, false);
      assert.equal(quota.group.code, 'vip');
      const nets = await store.listNetworksByOwner(user.id);
      const netQuota = await store.resolveNetworkEffectiveQuota(nets[0].id, T0);
      assert.equal(netQuota.group.code, 'vip');
      assert.equal(netQuota.assignedGroupId, vip.id);
      await rejectsCode(store.resolveNetworkEffectiveQuota('nope0000'), 'network-not-found');
      await rejectsCode(store.resolveEffectiveUserQuota('ghost'), 'user-not-found');
    } finally {
      await store.close();
    }
  });

  test('GC-fix-batch1 R1：maxPeersCap 压低入网与 approve 的有效席位上限（低于网络 maxPeers 时原子拒绝）', async () => {
    const store = freshStore({ allowSignup: false, maxNetworksPerUser: 3, defaultMaxPeers: 8, relayRateKbps: 512 });
    try {
      const admin = await store.createUser({ email: 'cap-admin@local', passwordHash: 'h', role: 'admin' });
      // 网络容量 4，调用方压入 maxPeersCap=2（非管理员属主的组上限场景）
      const net = await store.createNetwork({ ownerId: admin.id, name: 'cap-net', admissionMode: 'both', joinKeyEnc: 'enc', maxPeers: 4 });
      const attempt = (nodeId, matched, cap) =>
        store.upsertMemberJoinAttempt({
          networkId: net.id,
          nodeId,
          name: `node-${nodeId}`,
          publicKeyHex: `${nodeId}pub`,
          joinKeyMatched: matched,
          ...(cap !== undefined ? { maxPeersCap: cap } : {}),
        });
      assert.equal((await attempt('caaaaaaa', true, 2))?.status, 'authorized');
      assert.equal((await attempt('cbbbbbbb', true, 2))?.status, 'authorized');
      // 第 3 台持有效口令：cap=2 已满 → limit-reached（网络自身 4 席并未满）
      await rejectsCode(attempt('cccccccc', true, 2), 'limit-reached');
      // manual 路径仍 pending（不占席），但 approve 在同一事务内受 cap 拒绝
      assert.equal((await attempt('cccccccc', false))?.status, 'pending');
      await rejectsCode(store.transitionMemberStatus(net.id, 'cccccccc', 'approve', 2), 'limit-reached');
      // pending 补交有效口令直升 authorized 的路径同样受 cap 拦截
      assert.equal((await attempt('cddddddd', false))?.status, 'pending');
      await rejectsCode(attempt('cddddddd', true, 2), 'limit-reached');
      // 不传 cap：网络自身 4 席照常生效（既有行为不变）
      assert.equal((await store.transitionMemberStatus(net.id, 'cccccccc', 'approve'))?.status, 'authorized');
      assert.equal((await attempt('cddddddd', true))?.status, 'authorized');
      await rejectsCode(attempt('ceeeeeee', true), 'limit-reached');
    } finally {
      await store.close();
    }
  });

  test('GC-fix-batch1 R3：groupId null 绑定当前活跃默认组——切换默认组后 createUser / updateUserByAdmin 跟随新默认组', async () => {
    const store = freshStore({ allowSignup: false, maxNetworksPerUser: 3, defaultMaxPeers: 8, relayRateKbps: 512 });
    try {
      const vip = await store.createUserGroup({ code: 'r3vip', name: 'VIP', isDefault: true, maxNetworks: 5, maxPeersPerNetwork: 5, relayRateKbps: 64 });
      assert.equal(vip.isDefault, true);
      assert.equal((await store.getUserGroupByCode('default'))?.isDefault, false);
      // createUser 显式 null 与缺省一样绑定当前活跃默认组（vip，而非 grp_default）
      const byNull = await store.createUser({ email: 'r3-null@local', passwordHash: 'h', role: 'user', groupId: null });
      assert.equal(byNull.groupId, vip.id);
      const byUndefined = await store.createUser({ email: 'r3-undef@local', passwordHash: 'h', role: 'user' });
      assert.equal(byUndefined.groupId, vip.id);
      // updateUserByAdmin groupId null 同样绑定当前活跃默认组；undefined 保持原值
      const member = await store.createUser({ email: 'r3-member@local', passwordHash: 'h', role: 'user', groupId: 'grp_default' });
      assert.equal((await store.updateUserByAdmin(member.id, { groupId: null })).groupId, vip.id);
      assert.equal((await store.updateUserByAdmin(member.id, { emailVerifiedAt: '2026-11-14T00:00:00.000Z' })).groupId, vip.id);
      // 默认组切回 grp_default 后，null 跟随最新默认组
      const def = await store.getUserGroupByCode('default');
      await store.updateUserGroup(def.id, { isDefault: true });
      assert.equal((await store.updateUserByAdmin(member.id, { groupId: null })).groupId, def.id);
    } finally {
      await store.close();
    }
  });

  test('last-admin：停用/降级/删除唯一活跃管理员全部拦截；有两个活跃管理员时可操作其一', async () => {
    const store = freshStore();
    try {
      const sole = await store.createUser({ email: 'sole@local', passwordHash: 'h', role: 'admin' });
      await rejectsCode(store.setUserActive(sole.id, false), 'last-admin');
      await rejectsCode(store.updateUserByAdmin(sole.id, { active: false }), 'last-admin');
      await rejectsCode(store.updateUserByAdmin(sole.id, { role: 'user' }), 'last-admin');
      await rejectsCode(store.deleteUser(sole.id), 'last-admin');
      // 不触及 admin/active 身份的字段修改不受保护拦截
      const vip = await store.createUserGroup({ code: 'g2', name: 'G2', maxNetworks: 2, maxPeersPerNetwork: 4, relayRateKbps: 64 });
      const patched = await store.updateUserByAdmin(sole.id, { groupId: vip.id, emailVerifiedAt: '2026-11-01T00:00:00.000Z' });
      assert.equal(patched.groupId, vip.id);
      assert.equal(patched.emailVerifiedAt, '2026-11-01T00:00:00.000Z');
      // groupId 指向不存在的组 → group-not-found
      await rejectsCode(store.updateUserByAdmin(sole.id, { groupId: 'grp_missing' }), 'group-not-found');

      // 第二个活跃管理员加入后即可操作第一个；被停用者不算「活跃管理员」
      const second = await store.createUser({ email: 'second@local', passwordHash: 'h', role: 'admin' });
      await store.setUserActive(sole.id, false);
      assert.equal((await store.findUserById(sole.id)).active, false);
      await rejectsCode(store.setUserActive(second.id, false), 'last-admin');
      // 重新启用 sole（启用不触发保护），随后可降级 second
      await store.setUserActive(sole.id, true);
      await store.updateUserByAdmin(second.id, { role: 'user' });
      assert.equal((await store.findUserById(second.id)).role, 'user');
    } finally {
      await store.close();
    }
  });

  test('updateUserPassword 保留 keepTokenHash 会话并吊销他端；updateUserEmail / deleteAllUserSessions', async () => {
    const store = freshStore();
    try {
      const u = await store.createUser({ email: 'p@local', passwordHash: 'old', role: 'user' });
      const keep = await store.createSession(u.id, 3_600_000);
      const other = await store.createSession(u.id, 3_600_000);
      await store.updateUserPassword(u.id, 'new-hash', keep.tokenHash);
      assert.equal((await store.findUserById(u.id)).passwordHash, 'new-hash');
      assert.ok(await store.getSessionUser(keep.tokenHash, Date.now()), 'keepTokenHash 会话保留');
      assert.equal(await store.getSessionUser(other.tokenHash, Date.now()), null, '他端会话吊销');
      // 不带 keepTokenHash → 全部吊销
      const s2 = await store.createSession(u.id, 3_600_000);
      await store.updateUserPassword(u.id, 'newer-hash');
      assert.equal(await store.getSessionUser(s2.tokenHash, Date.now()), null);
      await rejectsCode(store.updateUserPassword('ghost', 'x'), 'user-not-found');
      // deleteAllUserSessions：except 之外全删，返回删除行数
      const s3 = await store.createSession(u.id, 3_600_000);
      const s4 = await store.createSession(u.id, 3_600_000);
      assert.equal(await store.deleteAllUserSessions(u.id, s3.tokenHash), 1);
      assert.ok(await store.getSessionUser(s3.tokenHash, Date.now()));
      assert.equal(await store.getSessionUser(s4.tokenHash, Date.now()), null);
      await rejectsCode(store.deleteAllUserSessions('ghost'), 'user-not-found');
      // 改邮箱：撞已有邮箱拦截、自己改回自己不拦、验证时刻随改随写
      await store.createUser({ email: 'taken@local', passwordHash: 'h', role: 'user' });
      await rejectsCode(store.updateUserEmail(u.id, 'taken@local', null), 'duplicate-email');
      const moved = await store.updateUserEmail(u.id, 'moved@local', '2026-11-10T00:00:00.000Z');
      assert.equal(moved.email, 'moved@local');
      assert.equal(moved.emailVerifiedAt, '2026-11-10T00:00:00.000Z');
      const same = await store.updateUserEmail(u.id, 'moved@local', null);
      assert.equal(same.emailVerifiedAt, null);
      await rejectsCode(store.updateUserEmail('ghost', 'x@local', null), 'user-not-found');
    } finally {
      await store.close();
    }
  });

  test('flushMemberTelemetry 月度字节：同 owner 多网络跨月累计；零/负增量不产生月度行', async () => {
    const store = freshStore({ allowSignup: false, maxNetworksPerUser: 3, defaultMaxPeers: 8, relayRateKbps: 512 });
    try {
      await store.ensureBootstrapAdmin({ email: 'a@local', password: 'admin-pass' });
      const admin = await store.findUserByEmail('a@local');
      const n1 = await store.createNetwork({ ownerId: admin.id, name: 'n1', admissionMode: 'key', joinKeyEnc: 'e', maxPeers: 4 });
      const n2 = await store.createNetwork({ ownerId: admin.id, name: 'n2', admissionMode: 'key', joinKeyEnc: 'e', maxPeers: 4 });
      await store.upsertMemberJoinAttempt({ networkId: n1.id, nodeId: 'aa11aaaa', publicKeyHex: 'aa11aaaapub', joinKeyMatched: true });
      await store.upsertMemberJoinAttempt({ networkId: n2.id, nodeId: 'bb22bbbb', publicKeyHex: 'bb22bbbbpub', joinKeyMatched: true });

      // 跨月批次：10 月两网络聚合 250、11 月 200
      await store.flushMemberTelemetry([
        { networkId: n1.id, nodeId: 'aa11aaaa', relayBytesDelta: 100, lastSeenAt: '2026-10-05T00:00:00.000Z' },
        { networkId: n2.id, nodeId: 'bb22bbbb', relayBytesDelta: 150, lastSeenAt: '2026-10-25T00:00:00.000Z' },
        { networkId: n1.id, nodeId: 'aa11aaaa', relayBytesDelta: 200, lastSeenAt: '2026-11-01T12:00:00.000Z' },
      ]);
      assert.equal(await store.getMonthlyRelayUsage(admin.id, '2026-10'), 250);
      assert.equal(await store.getMonthlyRelayUsage(admin.id, '2026-11'), 200);
      assert.equal(await store.getMonthlyRelayUsage(admin.id, '2026-09'), 0);

      // 无 lastSeenAt → 按当前月份累计；零增量不产生月度行
      await store.flushMemberTelemetry([
        { networkId: n1.id, nodeId: 'aa11aaaa', relayBytesDelta: 5 },
        { networkId: n1.id, nodeId: 'aa11aaaa', relayBytesDelta: 0, lastSeenAt: '2026-09-01T00:00:00.000Z' },
      ]);
      // 当前月份与显式批次月份撞月时（如 2026-11 运行），当月合计要并上对应批次的字节
      const nowMonth = new Date().toISOString().slice(0, 7);
      const explicitMonths = { '2026-10': 250, '2026-11': 200 };
      const expectedNowMonth = 5 + (explicitMonths[nowMonth] ?? 0);
      assert.equal(await store.getMonthlyRelayUsage(admin.id, nowMonth), expectedNowMonth);
      // resolveEffectiveUserQuota 带出当月用量
      const quota = await store.resolveEffectiveUserQuota(admin.id);
      assert.equal(quota.monthlyRelayUsedBytes, expectedNowMonth);
      assert.equal(quota.yearMonth, nowMonth);
    } finally {
      await store.close();
    }
  });

  test('email OTP：冷却拦截、5 次错输永久锁定（正确码也拒）、一次消费、过期清理', async () => {
    const store = freshStore();
    try {
      const T0 = Date.parse('2026-11-10T00:00:00.000Z');
      const email = '  User@Example.COM ';
      const issued = await store.issueEmailOtp({ email, purpose: 'reset_password', codeHash: 'hash-1', ttlMs: 600_000, cooldownMs: 60_000, nowMs: T0 });
      assert.equal(issued.email, 'user@example.com'); // trim + 小写后才进库
      assert.equal(issued.expiresAt, '2026-11-10T00:10:00.000Z');
      assert.equal(issued.cooldownUntil, '2026-11-10T00:01:00.000Z');
      // 冷却窗口内再签发 → otp-cooldown；窗口外 → 允许且旧行被消费
      await rejectsCode(store.issueEmailOtp({ email, purpose: 'reset_password', codeHash: 'x', ttlMs: 600_000, cooldownMs: 60_000, nowMs: T0 + 30_000 }), 'otp-cooldown');
      const second = await store.issueEmailOtp({ email, purpose: 'reset_password', codeHash: 'hash-2', ttlMs: 600_000, cooldownMs: 60_000, nowMs: T0 + 61_000 });
      assert.notEqual(second.id, issued.id);
      // 旧行已被消费：旧码对不上活跃行（otp-invalid，并在新行计错 1 次）
      await rejectsCode(store.verifyAndConsumeEmailOtp({ email, purpose: 'reset_password', codeHash: 'hash-1', maxAttempts: 5, nowMs: T0 + 62_000 }), 'otp-invalid');
      // 不同 purpose 互不干扰
      await store.issueEmailOtp({ email, purpose: 'signup', codeHash: 'hash-s', ttlMs: 600_000, cooldownMs: 60_000, nowMs: T0 + 62_000 });
      // 再错输 3 次（累计 4 次）→ otp-invalid；错输计数已提交
      for (let i = 0; i < 3; i++) {
        await rejectsCode(store.verifyAndConsumeEmailOtp({ email, purpose: 'reset_password', codeHash: `wrong-${i}`, maxAttempts: 5, nowMs: T0 + 62_000 }), 'otp-invalid');
      }
      // 第 5 次错输 → otp-locked
      await rejectsCode(store.verifyAndConsumeEmailOtp({ email, purpose: 'reset_password', codeHash: 'wrong-3', maxAttempts: 5, nowMs: T0 + 62_000 }), 'otp-locked');
      // 锁定后即使输入正确码也拒之门外
      await rejectsCode(store.verifyAndConsumeEmailOtp({ email, purpose: 'reset_password', codeHash: 'hash-2', maxAttempts: 5, nowMs: T0 + 62_000 }), 'otp-locked');
      // 冷却过后重签，正确码一次消费成功；同一码第二次 → otp-invalid（已消费）
      await store.issueEmailOtp({ email, purpose: 'reset_password', codeHash: 'hash-3', ttlMs: 600_000, cooldownMs: 60_000, nowMs: T0 + 123_000 });
      await store.verifyAndConsumeEmailOtp({ email, purpose: 'reset_password', codeHash: 'hash-3', maxAttempts: 5, nowMs: T0 + 124_000 });
      await rejectsCode(store.verifyAndConsumeEmailOtp({ email, purpose: 'reset_password', codeHash: 'hash-3', maxAttempts: 5, nowMs: T0 + 125_000 }), 'otp-invalid');
      // 过期清理：短 TTL 行到期后可被 prune，未过期行保留
      await store.issueEmailOtp({ email: 'p@local', purpose: 'signup', codeHash: 'h', ttlMs: 1_000, cooldownMs: 0, nowMs: T0 });
      assert.equal(await store.pruneExpiredOtps(T0), 0);
      assert.equal(await store.pruneExpiredOtps(T0 + 1_000), 1);
      assert.equal(await store.pruneExpiredOtps(T0 + 724_000), 4); // 其余 4 行（最晚 T0+723s 到期）全部清理
      assert.equal(await store.pruneExpiredOtps(T0 + 724_000), 0);
    } finally {
      await store.close();
    }
  });
});

// ---------------------------------------------------------------- PAS-1a: decideJoinAttempt & leave signature

describe('PAS-1a：decideJoinAttempt 重连防复活、manual 强审批与 verifyGatewayLeaveSignature', () => {
  test('decideJoinAttempt：isReconnect=true 时成员缺失或 revoked 一律返回 removed', () => {
    assert.equal(
      decideJoinAttempt({
        admissionMode: 'both',
        maxPeers: 4,
        capacityUsed: 0,
        joinKeyMatched: true,
        existing: null,
        incomingPublicKeyHex: 'aa'.repeat(32),
        isReconnect: true,
      }),
      'removed',
    );
    assert.equal(
      decideJoinAttempt({
        admissionMode: 'manual',
        maxPeers: 4,
        capacityUsed: 0,
        joinKeyMatched: false,
        existing: { status: 'revoked', publicKeyHex: 'aa'.repeat(32) },
        incomingPublicKeyHex: 'aa'.repeat(32),
        isReconnect: true,
      }),
      'removed',
    );
    assert.equal(
      decideJoinAttempt({
        admissionMode: 'manual',
        maxPeers: 4,
        capacityUsed: 1,
        joinKeyMatched: false,
        existing: { status: 'authorized', publicKeyHex: 'aa'.repeat(32) },
        incomingPublicKeyHex: 'aa'.repeat(32),
        isReconnect: true,
      }),
      'keep',
    );
    assert.equal(
      decideJoinAttempt({
        admissionMode: 'both',
        maxPeers: 4,
        capacityUsed: 1,
        joinKeyMatched: false,
        existing: { status: 'paused', publicKeyHex: 'aa'.repeat(32) },
        incomingPublicKeyHex: 'aa'.repeat(32),
        isReconnect: true,
      }),
      'keep',
    );
  });

  test('decideJoinAttempt：manual 模式下非重连（含带有效口令）已授权成员也回退 pending', () => {
    assert.equal(
      decideJoinAttempt({
        admissionMode: 'manual',
        maxPeers: 4,
        capacityUsed: 1,
        joinKeyMatched: true,
        existing: { status: 'authorized', publicKeyHex: 'bb'.repeat(32) },
        incomingPublicKeyHex: 'bb'.repeat(32),
        isReconnect: false,
      }),
      'pending',
    );
    assert.equal(
      decideJoinAttempt({
        admissionMode: 'manual',
        maxPeers: 4,
        capacityUsed: 0,
        joinKeyMatched: true,
        existing: null,
        incomingPublicKeyHex: 'cc'.repeat(32),
        isReconnect: false,
      }),
      'pending',
    );
    assert.equal(
      decideJoinAttempt({
        admissionMode: 'both',
        maxPeers: 4,
        capacityUsed: 1,
        joinKeyMatched: false,
        existing: { status: 'authorized', publicKeyHex: 'dd'.repeat(32) },
        incomingPublicKeyHex: 'dd'.repeat(32),
        isReconnect: false,
      }),
      'keep',
    );
  });

  test('SqliteStore.upsertMemberJoinAttempt：重连遇删行/revoked 抛 member-removed；manual 显式重加转 pending 并刷新 createdAt', async () => {
    const dir = tmpDir('pas1a');
    const dbPath = path.join(dir, 'gateway.db');
    const s = new SqliteStore({
      path: dbPath,
      seed: { allowSignup: false, maxNetworksPerUser: 4, defaultMaxPeers: 4, relayRateKbps: 2048 },
    });
    try {
      const owner = await s.createUser({ email: 'owner@local', passwordHash: TENANT_HASH, role: 'admin' });
      const net = await s.createNetwork({
        ownerId: owner.id,
        name: 'pas1a-net',
        admissionMode: 'both',
        joinKeyEnc: 'enc',
        maxPeers: 4,
      });

      // 缺失成员走 isReconnect=true → member-removed
      await rejectsCode(
        s.upsertMemberJoinAttempt({
          networkId: net.id,
          nodeId: '12345678',
          name: 'node-a',
          publicKeyHex: 'aa'.repeat(32),
          joinKeyMatched: true,
          isReconnect: true,
        }),
        'member-removed',
      );

      // 首次入网成功，随后切换到 manual 并再次显式入网 → 回退 pending 且刷新 createdAt
      const joined = await s.upsertMemberJoinAttempt({
        networkId: net.id,
        nodeId: '12345678',
        name: 'node-a',
        publicKeyHex: 'aa'.repeat(32),
        joinKeyMatched: true,
        isReconnect: false,
      });
      assert.equal(joined?.status, 'authorized');
      await s.updateNetwork(net.id, { admissionMode: 'manual' });
      await new Promise((r) => setTimeout(r, 15));
      const reExplicit = await s.upsertMemberJoinAttempt({
        networkId: net.id,
        nodeId: '12345678',
        name: 'node-a',
        publicKeyHex: 'aa'.repeat(32),
        joinKeyMatched: true,
        isReconnect: false,
      });
      assert.equal(reExplicit?.status, 'pending');
      assert.ok(reExplicit.createdAt > joined.createdAt, '重新入网应刷新 createdAt 标定本轮加入纪元');

      // 批准后重连仍保持 authorized；被 removeMember 删除后重连抛 member-removed
      await s.transitionMemberStatus(net.id, '12345678', 'approve');
      const kept = await s.upsertMemberJoinAttempt({
        networkId: net.id,
        nodeId: '12345678',
        name: 'node-a',
        publicKeyHex: 'aa'.repeat(32),
        joinKeyMatched: false,
        isReconnect: true,
      });
      assert.equal(kept?.status, 'authorized');

      await s.removeMember(net.id, '12345678');
      await rejectsCode(
        s.upsertMemberJoinAttempt({
          networkId: net.id,
          nodeId: '12345678',
          name: 'node-a',
          publicKeyHex: 'aa'.repeat(32),
          joinKeyMatched: true,
          isReconnect: true,
        }),
        'member-removed',
      );

      // pending 被 reject 成 revoked 后，重连同样抛 member-removed
      await s.upsertMemberJoinAttempt({
        networkId: net.id,
        nodeId: '22345678',
        name: 'node-b',
        publicKeyHex: 'bb'.repeat(32),
        joinKeyMatched: false,
        isReconnect: false,
      });
      await s.transitionMemberStatus(net.id, '22345678', 'reject');
      await rejectsCode(
        s.upsertMemberJoinAttempt({
          networkId: net.id,
          nodeId: '22345678',
          name: 'node-b',
          publicKeyHex: 'bb'.repeat(32),
          joinKeyMatched: true,
          isReconnect: true,
        }),
        'member-removed',
      );
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verifyGatewayLeaveSignature：合法签名通过，篡改/错密钥/畸形输入全部返回 false', () => {
    const kp1 = generateKeyPairSync('ed25519');
    const kp2 = generateKeyPairSync('ed25519');
    const pub1 = kp1.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const pub2 = kp2.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const nodeId = createHash('sha256').update(Buffer.from(pub1, 'hex')).digest('hex').slice(0, 8);
    const networkId = '0123456789abcdef';
    const timestamp = Date.now();
    const signatureHex = sign(null, gatewayLeaveMessage(networkId, nodeId, timestamp), kp1.privateKey).toString('hex');

    assert.equal(
      verifyGatewayLeaveSignature({ networkId, nodeId, publicKeyHex: pub1, timestamp, signatureHex }),
      true,
    );
    // 篡改任一字段或换密钥均失败
    assert.equal(
      verifyGatewayLeaveSignature({ networkId: 'fedcba9876543210', nodeId, publicKeyHex: pub1, timestamp, signatureHex }),
      false,
    );
    assert.equal(
      verifyGatewayLeaveSignature({ networkId, nodeId: '00000000', publicKeyHex: pub1, timestamp, signatureHex }),
      false,
    );
    assert.equal(
      verifyGatewayLeaveSignature({ networkId, nodeId, publicKeyHex: pub1, timestamp: timestamp + 1, signatureHex }),
      false,
    );
    assert.equal(
      verifyGatewayLeaveSignature({ networkId, nodeId, publicKeyHex: pub2, timestamp, signatureHex }),
      false,
    );
    // 畸形输入不抛异常、返回 false
    assert.equal(
      verifyGatewayLeaveSignature({ networkId: 'bad', nodeId, publicKeyHex: pub1, timestamp, signatureHex }),
      false,
    );
    assert.equal(
      verifyGatewayLeaveSignature({ networkId, nodeId, publicKeyHex: pub1, timestamp: 1.5, signatureHex }),
      false,
    );
    assert.equal(
      verifyGatewayLeaveSignature({ networkId, nodeId, publicKeyHex: 'zz', timestamp, signatureHex }),
      false,
    );
    assert.equal(
      verifyGatewayLeaveSignature({ networkId, nodeId, publicKeyHex: pub1, timestamp, signatureHex: '00' }),
      false,
    );
  });
});

describe('T3 autoUpdateEnabled config & store persistence', () => {
  test('resolveGatewayConfig 解析 ZR_GATEWAY_AUTO_UPDATE（缺省 true，仅 false/0 关闭）', () => {
    assert.equal(resolveGatewayConfig({}).autoUpdateEnabled, true);
    assert.equal(resolveGatewayConfig({ ZR_GATEWAY_AUTO_UPDATE: 'true' }).autoUpdateEnabled, true);
    assert.equal(resolveGatewayConfig({ ZR_GATEWAY_AUTO_UPDATE: 'false' }).autoUpdateEnabled, false);
    assert.equal(resolveGatewayConfig({ ZR_GATEWAY_AUTO_UPDATE: '0' }).autoUpdateEnabled, false);
  });

  test('SqliteStore autoUpdateEnabled 默认 true、seed=false 覆写及热更新持久化', async () => {
    const dir = tmpDir('auto-update-store');
    const dbPath = path.join(dir, 'gw.sqlite');
    const s1 = new SqliteStore({ path: dbPath, seed: { autoUpdateEnabled: false } });
    try {
      const ext1 = await s1.getExtendedSettings();
      assert.equal(ext1.autoUpdateEnabled, false);
      const updated = await s1.updateExtendedSettings({ autoUpdateEnabled: true });
      assert.equal(updated.autoUpdateEnabled, true);
    } finally {
      await s1.close();
    }

    // Reopen with conflicting seed=false -> persisted true wins
    const s2 = new SqliteStore({ path: dbPath, seed: { autoUpdateEnabled: false } });
    try {
      const ext2 = await s2.getExtendedSettings();
      assert.equal(ext2.autoUpdateEnabled, true);
      await s2.updateExtendedSettings({ autoUpdateEnabled: false });
      assert.equal((await s2.getExtendedSettings()).autoUpdateEnabled, false);
    } finally {
      await s2.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
