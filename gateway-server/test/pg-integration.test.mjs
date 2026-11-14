// PC-06 真实 PostgreSQL 集成测试：schema 初始化、顺序建网/成员持久化、配额拒绝回滚、
// 并发建网（配额内有界结束、auth/另租户查询不被饿死）、关闭重开持久化。
// 仅正常功能路径，不包含任何 DoS/攻击复现脚本。
//
// 结构性隔离（PC-06 fix1）：每轮运行创建两个独占的随机 schema（前缀 zr_pc06_test_ +
// 随机 hex，均由本轮 CREATE SCHEMA 成功取得拥有权并记录在本轮变量里）：主 schema 承载
// PgStore（search_path 定位，close/reopen 始终同一 schema），对照 schema 建同名业务表
// 与对照行充当「本轮运行之外的数据」。收尾只允许 DROP 本轮成功创建、名字严格匹配
// 变量的这两个 schema——不写 public、不认领任何既有对象。测试只证明本轮两个 schema
// 彼此隔离，不宣称检测了所有 public 数据。
//
// 有界等待（PC-06 fix1）：并发批次与受控挂起用例均在隔离子进程中运行（父侧真实
// 总 deadline，超时 SIGKILL；子进程的数据库连接随进程终止被服务端回收，经
// pg_stat_activity 验证归零）。管理连接（root client）的 connect/query/end 每步
// 都有超时收口，超时即断开底层 socket，绝不留下活连接。正常路径仍明确 store.close
// 与 schema 清理。
//
// 运行方式：环境变量 ZR_TEST_PG_URL_FILE 指向一个仅含数据库连接 URL 的本地文件
// （相对路径按 gateway-server 目录解析）。未设置时整组测试 skip；
// 本单验收必须在真实 PG 上跑通，skip 不算完成。
//
// 防挂死兜底：连接附加服务端 statement_timeout（见 STATEMENT_TIMEOUT_MS）。
// 任何 statement timeout 错误都按失败处理，绝不当作正常拒绝。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { PgStore } from '../dist/store/pg-store.js';
import { StoreError, SETTINGS_KEYS } from '../dist/store/types.js';
import { encryptSecret, hashPassword } from '../dist/master-key.js';
import { resolveGatewayConfig } from '../dist/config.js';
import { startGateway } from '../dist/main.js';

const urlFileEnv = process.env.ZR_TEST_PG_URL_FILE;
const hasPg = typeof urlFileEnv === 'string' && urlFileEnv.trim().length > 0;

/** 服务端 statement_timeout 兜底：超时查询报 57014，测试一律视为失败（而非正常拒绝） */
const STATEMENT_TIMEOUT_MS = 5000;
/** 并发批次总 deadline（父侧对子进程的真实等待上限） */
const BATCH_DEADLINE_MS = 30_000;
/** 单次健康查询（auth/me 等价路径）允许的最大延迟 */
const HEALTH_LATENCY_MS = 5_000;
/** 收尾各步骤（close/drop/清理）的独立等待上限 */
const TEARDOWN_STEP_MS = 5_000;
/** 本轮独占 schema 前缀；拥有权 = 本轮 CREATE SCHEMA 成功且名字记录在本轮变量 */
const SCHEMA_PREFIX = 'zr_pc06_test_';
/** 管理连接（root client）每一步（connect/query/end）的等待上限 */
const ROOT_STEP_MS = 5_000;

function readRawDatabaseUrl() {
  const p = path.isAbsolute(urlFileEnv) ? urlFileEnv : path.resolve(process.cwd(), urlFileEnv);
  return fs.readFileSync(p, 'utf8').trim();
}

/** 本轮 schema 的连接 URL：search_path 定位到独占 schema + statement_timeout 兜底 */
function databaseUrlFor(schema, applicationName) {
  const u = new URL(readRawDatabaseUrl());
  u.searchParams.set('options', `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c search_path=${schema}`);
  u.searchParams.set('application_name', applicationName);
  return u.toString();
}

/**
 * root 连接（默认 search_path）：仅用于 schema 管理、对照数据与 pg_stat_activity。
 * connect/query/end 每步都有真实超时收口：超时先断开底层 socket 再报错——不是
 * Promise.race 后留下活连接。
 */
async function withRootClient(url, fn) {
  const mod = await import('pg');
  const Client = (mod.default ?? mod).Client;
  const client = new Client({ connectionString: url });
  // 超时兜底：直接断开底层 socket，确保任何一步超时后不留活连接
  const hardClose = () => {
    try {
      client.connection?.stream?.destroy();
    } catch {
      /* 已关闭 */
    }
  };
  const step = (promise, label) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          hardClose();
          reject(new Error(`${label} 超出 ${ROOT_STEP_MS}ms`));
        }, ROOT_STEP_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    await step(client.connect(), 'connect');
    return await step(fn(client), 'query');
  } finally {
    try {
      await step(client.end(), 'end');
    } catch {
      hardClose(); // end 超时或失败：真实断开 socket
    }
  }
}

/** 给收尾步骤一个独立等待上限；超时视为该步骤失败（明确报告，绝不静默吞掉） */
async function bounded(label, ms, promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超出 ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- 本轮独占 schema：创建成功才有拥有权；清理只认本轮变量里记录的名字 ----

async function createOwnedSchema(url) {
  const name = SCHEMA_PREFIX + randomBytes(6).toString('hex');
  // 不带 IF NOT EXISTS：创建失败（撞名/已存在）即本轮失败，绝不把别人已有的 schema 当自己的
  await withRootClient(url, (c) => c.query(`CREATE SCHEMA "${name}"`));
  return name;
}

async function dropOwnedSchema(url, name) {
  // 双重守卫：名字必须来自本轮变量且严格匹配前缀；绝不 DROP public 或任何未记录的 schema
  if (typeof name !== 'string' || !name.startsWith(SCHEMA_PREFIX)) {
    throw new Error(`refusing to drop schema not owned by this run: ${String(name)}`);
  }
  await withRootClient(url, (c) => c.query(`DROP SCHEMA "${name}" CASCADE`));
}

/**
 * 对照数据：在「本轮创建、记录在本轮变量」的对照 schema 里新建同名业务表与一行
 * 对照数据。全新对象：无 IF NOT EXISTS、无 ON CONFLICT 覆盖——它对主 schema 而言
 * 就是本轮运行之外的数据，用于证明两个 schema 彼此隔离。
 */
async function seedCanarySchema(url, schema) {
  await dropOwnedSchemaGuard(schema);
  await withRootClient(url, async (c) => {
    await c.query(`CREATE TABLE "${schema}".system_settings (key text PRIMARY KEY, value text NOT NULL)`);
    await c.query(`INSERT INTO "${schema}".system_settings (key, value) VALUES ($1, $2)`, ['pc06_canary', 'alive']);
  });
}

async function readCanaryValue(url, schema) {
  await dropOwnedSchemaGuard(schema);
  const { rows } = await withRootClient(url, (c) =>
    c.query(`SELECT value FROM "${schema}".system_settings WHERE key = $1`, ['pc06_canary']),
  );
  return rows.length > 0 ? rows[0].value : null;
}

/** canary 相关函数同样只接受本轮前缀内的 schema 名 */
function dropOwnedSchemaGuard(schema) {
  if (typeof schema !== 'string' || !schema.startsWith(SCHEMA_PREFIX)) {
    throw new Error(`refusing to touch schema not owned by this run: ${String(schema)}`);
  }
}

/** pg_stat_activity 中指定 application_name 的活动连接数（验证子进程连接真实关闭） */
async function countConnections(url, applicationName) {
  return withRootClient(url, async (c) => {
    const { rows } = await c.query('SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [
      applicationName,
    ]);
    return rows[0].n;
  });
}

/** spawn 隔离子进程跑 runner；deadline 到即 SIGKILL（父侧等待真实有界） */
function runTestChild(mode, schema, deadlineMs) {
  const runner = path.join(import.meta.dirname, 'pg-batch-child.mjs');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, mode, urlFileEnv, schema], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const t0 = performance.now();
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, deadlineMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ spawnError: err, stdout, stderr, killed, code: null, signal: null, wallMs: performance.now() - t0 });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, killed, wallMs: performance.now() - t0 });
    });
  });
}

(hasPg ? describe : describe.skip)('PgStore 真实 PG 集成（ZR_TEST_PG_URL_FILE 未设置时 skip）', () => {
  const masterKey = Buffer.alloc(32, 0xab);
  const enc = (s) => encryptSecret(s, masterKey);

  let rawUrl;
  let ownedSchema = null; // 本轮主 schema（PgStore 所在），CREATE 成功即拥有权事实
  let canarySchema = null; // 本轮对照 schema（同名业务表 + 对照行），同样为本轮拥有
  let store;
  let adminId;
  let tenantId; // 配额场景租户（顺序建网 3 个）
  let tenant2Id; // 并发批次租户（从 0 开始，50 并发 / 配额 20，由隔离子进程执行）
  let otherTenantId; // 健康查询用的另一租户
  let tenantTokenHash; // tenant 的有效会话（重开持久化验证用）
  let quotaNet; // key 模式网络，承载成员持久化验证
  let pausedNodeId = 'a1b2c3d4'; // 合同形状：8 位 hex nodeId

  before(async () => {
    rawUrl = readRawDatabaseUrl();
    ownedSchema = await createOwnedSchema(rawUrl);
    canarySchema = await createOwnedSchema(rawUrl);
    await seedCanarySchema(rawUrl, canarySchema); // 本轮新建的对照数据（无 IF NOT EXISTS、无覆盖）
    store = await PgStore.connect(databaseUrlFor(ownedSchema, 'zr_pc06_test_main'));
  });

  after(async () => {
    const problems = [];
    if (store !== undefined) {
      try {
        await bounded('store.close', TEARDOWN_STEP_MS, store.close());
      } catch (error) {
        problems.push(`close: ${error.message}`);
      }
    }
    // 只清理本轮 CREATE 成功取得所有权、名字记录在本轮变量里的两个 schema
    for (const [label, schema] of [
      ['drop 对照 schema', canarySchema],
      ['drop 主 schema', ownedSchema],
    ]) {
      if (schema !== null) {
        try {
          await bounded(label, TEARDOWN_STEP_MS, dropOwnedSchema(rawUrl, schema));
        } catch (error) {
          problems.push(`${label}: ${error.message}`);
        }
      }
    }
    // 清理按拥有权完成的正向验证：本轮两个 schema 在清理后应全部消失
    const remaining = [ownedSchema, canarySchema].filter((s) => s !== null);
    if (remaining.length > 0) {
      try {
        const { rows } = await bounded(
          '清残留检查',
          TEARDOWN_STEP_MS,
          withRootClient(rawUrl, (c) =>
            c.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])', [remaining]),
          ),
        );
        if (rows.length > 0) {
          problems.push(`本轮 schema 清理后仍有残留: ${rows.map((r) => r.nspname).join(', ')}`);
        }
      } catch (error) {
        problems.push(`清残留检查: ${error.message}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`收尾验证失败: ${problems.join('; ')}`);
    }
  });

  test('connect：本轮 schema 内八张表齐全且幂等重建不抛错', { timeout: 30_000 }, async () => {
    await store.initSchema(); // 二次执行验证幂等
    const { rows } = await withRootClient(rawUrl, (c) =>
      c.query(
        "SELECT to_regclass(format('%I.%I', $1::text, table_name)) AS reg FROM (VALUES ('system_settings'),('users'),('sessions'),('networks'),('network_members'),('user_groups'),('monthly_relay_usage'),('email_otps')) AS t(table_name)",
        [ownedSchema],
      ),
    );
    const missing = rows.map((r) => r.reg).filter((r) => r === null);
    assert.deepEqual(missing, [], `本轮 schema ${ownedSchema} 内八张表必须全部存在`);
  });

  test('隔离：本轮两个 schema 彼此隔离（对照 schema 的同名表与数据不受 store 影响）', { timeout: 30_000 }, async () => {
    // store 的读写全部走主 schema（search_path），与对照 schema 的同名表互不可见
    const settings = await store.getSettings();
    assert.equal(typeof settings.maxNetworksPerUser, 'number');
    await store.updateSettings({ maxNetworksPerUser: 3, defaultMaxPeers: 4, relayRateKbps: 2048 });
    assert.equal((await store.getSettings()).maxNetworksPerUser, 3);
    // GC-2：updateSettings 改配额项 → 默认组对应列同步更新（真实 PG）
    const defaultGroup = await store.getUserGroupByCode('default');
    assert.ok(defaultGroup, 'connect 播种后 grp_default 必须存在');
    assert.equal(defaultGroup.isDefault, true);
    assert.equal(defaultGroup.maxNetworks, 3);
    assert.equal(defaultGroup.maxPeersPerNetwork, 4);
    assert.equal(defaultGroup.relayRateKbps, 2048);
    // 对照 schema 里的同名表与对照行原样：store 的 settings 写入没有越界
    assert.equal(await readCanaryValue(rawUrl, canarySchema), 'alive', '对照 schema 的数据不受本轮 store 影响');
  });

  test('顺序功能：bootstrap admin → 租户与另租户用户 → 有效会话', { timeout: 30_000 }, async () => {
    const admin = await store.ensureBootstrapAdmin({ email: 'pc06-admin@local', password: 'pc06-admin-pass' });
    assert.equal(admin.created, true);
    adminId = (await store.findUserByEmail('pc06-admin@local')).id;

    const pwHash = await hashPassword('pc06-tenant-pass');
    tenantId = (await store.createUser({ email: 'pc06-tenant@local', passwordHash: pwHash, role: 'user' })).id;
    otherTenantId = (await store.createUser({ email: 'pc06-other@local', passwordHash: pwHash, role: 'user' })).id;
    tenant2Id = (await store.createUser({ email: 'pc06-batch@local', passwordHash: pwHash, role: 'user' })).id;

    const session = await store.createSession(tenantId, 3_600_000);
    tenantTokenHash = session.tokenHash;
    assert.ok(await store.getSessionUser(tenantTokenHash, Date.now()));
  });

  test('顺序建网与成员持久化：key 模式入网 authorized → pause → paused', { timeout: 30_000 }, async () => {
    quotaNet = await store.createNetwork({
      ownerId: tenantId,
      name: 'pc06-quota-net',
      admissionMode: 'key',
      joinKeyEnc: enc('pc06-key-1'),
      maxPeers: 4,
    });
    assert.match(quotaNet.id, /^[0-9a-f]{16}$/);

    const joined = await store.upsertMemberJoinAttempt({
      networkId: quotaNet.id,
      nodeId: pausedNodeId,
      publicKeyHex: 'a1'.repeat(32), // 合同形状：64 位 hex 公钥
      joinKeyMatched: true,
    });
    assert.equal(joined.status, 'authorized');

    const paused = await store.transitionMemberStatus(quotaNet.id, pausedNodeId, 'pause');
    assert.equal(paused.status, 'paused');
    assert.equal((await store.listMembers(quotaNet.id)).length, 1);
  });

  test('GC-2 新表写入：用户组 CRUD、配额到期回退、月度流量、邮箱 OTP 冷却与一次消费', { timeout: 30_000 }, async () => {
    // 用户组：创建 + code 唯一 + 默认组禁删
    const vip = await store.createUserGroup({
      code: 'pc06vip',
      name: 'PC06 VIP',
      maxNetworks: 99,
      maxPeersPerNetwork: 32,
      relayRateKbps: 8192,
      monthlyRelayQuotaBytes: 1_000_000_000,
    });
    await assert.rejects(
      store.createUserGroup({ code: 'pc06vip', name: 'dup', maxNetworks: 1, maxPeersPerNetwork: 2, relayRateKbps: 64 }),
      (err) => err instanceof StoreError && err.code === 'duplicate-group-code',
    );
    const defaultGroup = await store.getUserGroupByCode('default');
    await assert.rejects(
      store.deleteUserGroup(defaultGroup.id),
      (err) => err instanceof StoreError && err.code === 'cannot-delete-default-group',
    );

    // 配额到期：登记组过期 → 有效组回退默认组；清除到期后回到登记组
    await store.updateUserByAdmin(tenantId, { groupId: vip.id, groupExpiresAt: '2020-01-01T00:00:00.000Z' });
    let quota = await store.resolveEffectiveUserQuota(tenantId);
    assert.equal(quota.isExpiredFallback, true);
    assert.equal(quota.group.code, 'default');
    assert.equal(quota.assignedGroupId, vip.id);
    await store.updateUserByAdmin(tenantId, { groupId: vip.id, groupExpiresAt: null });
    quota = await store.resolveEffectiveUserQuota(tenantId);
    assert.equal(quota.isExpiredFallback, false);
    assert.equal(quota.group.code, 'pc06vip');
    assert.equal(quota.group.monthlyRelayQuotaBytes, 1_000_000_000);

    // 月度流量：既有网络成员的正向字节按属主、按月累计
    await store.flushMemberTelemetry([
      { networkId: quotaNet.id, nodeId: pausedNodeId, relayBytesDelta: 500, lastSeenAt: '2026-10-01T00:00:00.000Z' },
      { networkId: quotaNet.id, nodeId: pausedNodeId, relayBytesDelta: 250, lastSeenAt: '2026-10-20T00:00:00.000Z' },
    ]);
    assert.equal(await store.getMonthlyRelayUsage(tenantId, '2026-10'), 750);

    // 邮箱 OTP：冷却窗口拦截 + 正确码一次消费
    const T0 = Date.now();
    const issued = await store.issueEmailOtp({ email: 'PC06-Otp@Local', purpose: 'signup', codeHash: 'hash-pc06', ttlMs: 600_000, cooldownMs: 60_000, nowMs: T0 });
    assert.equal(issued.email, 'pc06-otp@local'); // trim + 小写后才进库
    await assert.rejects(
      store.issueEmailOtp({ email: 'pc06-otp@local', purpose: 'signup', codeHash: 'x', ttlMs: 600_000, cooldownMs: 60_000, nowMs: T0 + 1_000 }),
      (err) => err instanceof StoreError && err.code === 'otp-cooldown',
    );
    await store.verifyAndConsumeEmailOtp({ email: 'pc06-otp@local', purpose: 'signup', codeHash: 'hash-pc06', maxAttempts: 5, nowMs: T0 + 2_000 });
    await assert.rejects(
      store.verifyAndConsumeEmailOtp({ email: 'pc06-otp@local', purpose: 'signup', codeHash: 'hash-pc06', maxAttempts: 5, nowMs: T0 + 3_000 }),
      (err) => err instanceof StoreError && err.code === 'otp-invalid',
    );
    assert.equal(await store.pruneExpiredOtps(T0 + 700_000), 1); // 本用例签发的行已全部到期

    // 收尾：tenant 回默认组、删 vip 组，不污染后续配额用例
    await store.updateUserByAdmin(tenantId, { groupId: defaultGroup.id });
    await store.deleteUserGroup(vip.id);
    assert.equal(await store.getUserGroup(vip.id), null);
  });

  test('GC-2-fix1 默认组跟随：createUser 归入活跃默认组；配额失效回退当前 is_default 组；重连不复活第二个默认组', { timeout: 30_000 }, async () => {
    const fix1Vip = await store.createUserGroup({
      code: 'pc06fix1',
      name: 'PC06 FIX1',
      isDefault: true, // 活跃默认组从 grp_default 切到本组（三项配额写回 system_settings）
      maxNetworks: 60,
      maxPeersPerNetwork: 32,
      relayRateKbps: 8192,
    });
    const grpDefault = await store.getUserGroupByCode('default');
    assert.equal(grpDefault.isDefault, false, '旧默认组应已让位');

    let fix1UserId = null;
    let oldGroupUserId = null;
    try {
      // 未显式指定组的新用户原子归入当前活跃默认组 pc06fix1（COALESCE 子查询）
      fix1UserId = (await store.createUser({ email: 'pc06-fix1@local', passwordHash: 'pw', role: 'user' })).id;
      assert.equal((await store.findUserById(fix1UserId)).groupId, fix1Vip.id);

      // 登记 grp_default（旧默认组、已失活）且配额到期 → 有效组回退当前 is_default 组
      oldGroupUserId = (await store.createUser({ email: 'pc06-fix1-old@local', passwordHash: 'pw', role: 'user', groupId: grpDefault.id })).id;
      await store.updateUserByAdmin(oldGroupUserId, { groupExpiresAt: '2020-01-01T00:00:00.000Z' });
      const quota = await store.resolveEffectiveUserQuota(oldGroupUserId);
      assert.equal(quota.isExpiredFallback, true);
      assert.equal(quota.assignedGroupId, grpDefault.id);
      assert.equal(quota.group.code, 'pc06fix1');
    } finally {
      // 收尾恢复状态，不污染后续配额用例：grp_default 重升默认（其 3/4/2048 写回 settings）、
      // 两个专用用户删除（引用随之消失）、删 pc06fix1 组
      await store.updateUserByAdmin(oldGroupUserId, { groupId: grpDefault.id, groupExpiresAt: null }).catch(() => {});
      if (oldGroupUserId !== null) await store.deleteUser(oldGroupUserId);
      if (fix1UserId !== null) await store.deleteUser(fix1UserId).catch(() => {});
      await store.updateUserGroup(grpDefault.id, { isDefault: true });
      await store.deleteUserGroup(fix1Vip.id);
    }

    // 关闭重连（同一 schema、无 seed）：pc06fix1 已删，活跃默认组是 grp_default，
    // seedSettings 绝不复活第二个默认组、也不重新插入已删的组
    await store.close();
    store = await PgStore.connect(databaseUrlFor(ownedSchema, 'zr_pc06_test_main'));
    const groups = await store.listUserGroups();
    assert.deepEqual(
      groups.filter((g) => g.isDefault).map((g) => g.code),
      ['default'],
      '重连后必须恰有一个活跃默认组',
    );
    assert.equal(await store.getUserGroupByCode('pc06fix1'), null, '已删的组不得在重连时复活');
    // 重连后设置配额回到 grp_default 的 3/4/2048（isDefault 写回 settings 的双向同步）
    const settings = await store.getSettings();
    assert.deepEqual(settings, { allowSignup: false, maxNetworksPerUser: 3, defaultMaxPeers: 4, relayRateKbps: 2048 });
    // 重连后未显式指定组的新用户归入 grp_default
    const after = await store.createUser({ email: 'pc06-fix1-after@local', passwordHash: 'pw', role: 'user' });
    try {
      assert.equal(after.groupId, grpDefault.id);
    } finally {
      await store.deleteUser(after.id);
    }
  });

  test('配额拒绝回滚：第 4 个网络 quota-exceeded，表计数不变，连接仍健康', { timeout: 30_000 }, async () => {
    // tenant 已建 1 个，配额 3：再补 2 个后第 4 个被拒
    await store.createNetwork({ ownerId: tenantId, name: 'pc06-net-2', admissionMode: 'manual', joinKeyEnc: enc('k2'), maxPeers: 4 });
    await store.createNetwork({ ownerId: tenantId, name: 'pc06-net-3', admissionMode: 'manual', joinKeyEnc: enc('k3'), maxPeers: 4 });
    await assert.rejects(
      store.createNetwork({ ownerId: tenantId, name: 'pc06-net-4', admissionMode: 'manual', joinKeyEnc: enc('k4'), maxPeers: 4 }),
      (err) => err instanceof StoreError && err.code === 'quota-exceeded',
    );
    assert.equal((await store.listNetworksByOwner(tenantId)).length, 3, '配额拒绝后不得残留新行');

    // 拒绝路径之后连接仍健康：admin（免配额）建网成功
    const adminNet = await store.createNetwork({ ownerId: adminId, name: 'pc06-admin-net', admissionMode: 'key', joinKeyEnc: enc('ka'), maxPeers: 2 });
    assert.match(adminNet.id, /^[0-9a-f]{16}$/);
  });

  test('并发批次：50 并发建网在隔离子进程中受真实总 deadline 约束（20 成功/30 拒绝，健康查询及时）', { timeout: 60_000 }, async () => {
    const outcome = await runTestChild('batch', ownedSchema, BATCH_DEADLINE_MS + 15_000);
    assert.equal(outcome.spawnError, undefined, `子进程启动失败: ${outcome.spawnError}`);
    assert.equal(outcome.code, 0, `批次子进程应正常结束（exit=${outcome.code}，stderr=${outcome.stderr.slice(0, 300)}）`);
    assert.equal(outcome.killed, false, '正常批次不得触发父侧 deadline');

    const summary = JSON.parse(outcome.stdout.trim().split('\n').pop());
    assert.equal(summary.fulfilled, 20);
    assert.equal(summary.quotaRejected, 30);
    assert.equal(summary.others, 0);
    assert.ok(summary.wallMs <= BATCH_DEADLINE_MS, `批次墙钟 ${summary.wallMs}ms`);
    assert.ok(summary.maxHealthMs <= HEALTH_LATENCY_MS, `健康查询最大延迟 ${summary.maxHealthMs}ms`);
    assert.equal(await countConnections(rawUrl, 'zr_pc06_batch'), 0, '批次子进程结束后其数据库连接必须全部关闭');
    console.info(`[pc06-fix1] 隔离子进程批次: 墙钟 ${summary.wallMs}ms（20 成功/30 配额拒绝），健康查询最大延迟 ${summary.maxHealthMs}ms，父侧总等待 ${Math.round(outcome.wallMs)}ms`);
  });

  test('受控挂起：deadline 到即 SIGKILL 隔离子进程，pg 连接随收尾真实关闭', { timeout: 30_000 }, async () => {
    const HANG_DEADLINE_MS = 3_000;
    const outcome = await runTestChild('hang', ownedSchema, HANG_DEADLINE_MS);
    assert.equal(outcome.spawnError, undefined, `子进程启动失败: ${outcome.spawnError}`);
    assert.equal(outcome.signal, 'SIGKILL', `人为挂起的子进程必须在 deadline 内被终止（exit=${outcome.code}）`);
    assert.ok(
      outcome.wallMs < HANG_DEADLINE_MS + 5_000,
      `挂起收尾 ${Math.round(outcome.wallMs)}ms 必须有界（deadline ${HANG_DEADLINE_MS}ms + 宽限）`,
    );
    // 非 force-exit 假称：服务端视角确认该子进程的连接已随进程终止被回收
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(await countConnections(rawUrl, 'zr_pc06_hang'), 0, '被终止子进程的数据库连接必须已被服务端回收');
    console.info(`[pc06-fix1] 受控挂起收尾: ${Math.round(outcome.wallMs)}ms（deadline ${HANG_DEADLINE_MS}ms），连接归零`);
  });

  test('关闭后重新打开（同一 schema）：settings、用户、网络、成员、会话全部持久化', { timeout: 30_000 }, async () => {
    // 并发批次子进程把配额改成了 20;恢复顺序阶段的 3,让重开断言回到确定状态
    await store.updateSettings({ maxNetworksPerUser: 3 });
    await store.close();
    store = await PgStore.connect(databaseUrlFor(ownedSchema, 'zr_pc06_test_main')); // 始终同一 schema

    const settings = await store.getSettings();
    assert.equal(settings.maxNetworksPerUser, 3);
    assert.equal((await store.findUserByEmail('pc06-tenant@local')).id, tenantId);
    assert.equal((await store.listNetworksByOwner(tenantId)).length, 3);
    // 并发批次的 20 个网络由子进程写入同一 schema，重开后仍在
    assert.equal((await store.listNetworksByOwner(tenant2Id)).length, 20);

    const members = await store.listMembers(quotaNet.id);
    const paused = members.find((m) => m.nodeId === pausedNodeId);
    assert.ok(paused, '成员行重开后仍在');
    assert.equal(paused.status, 'paused');

    const seen = await store.getSessionUser(tenantTokenHash, Date.now());
    assert.equal(seen.id, tenantId, '会话重开后仍有效');

    // 重开后的 store 功能完好：admin 免配额建网验证写入路径
    const adminNet = await store.createNetwork({ ownerId: adminId, name: 'pc06-after-reopen', admissionMode: 'key', joinKeyEnc: enc('kr'), maxPeers: 2 });
    assert.equal((await store.getNetwork(adminNet.id)).name, 'pc06-after-reopen');
  });

  test('清理：删除本测试创建的网络（成员随网络级联）', { timeout: 30_000 }, async () => {
    for (const ownerId of [adminId, tenantId, tenant2Id]) {
      for (const net of await store.listNetworksByOwner(ownerId)) {
        await store.deleteNetwork(net.id);
      }
    }
    assert.equal((await store.listNetworksByOwner(tenantId)).length, 0);
    assert.equal((await store.listNetworksByOwner(tenant2Id)).length, 0);
    assert.deepEqual(await store.listMembers(quotaNet.id), []);
  });
});

// ---------------------------------------------------------------- PC-07 生产接线（真实 PG）

// 与上一组不同：这里不走 PgStore.connect 直调，而是把 ZR_GATEWAY_DATABASE_URL 等
// env 喂给 resolveGatewayConfig 再进 startGateway 的生产组装，证明部署配置真的经
// openStore 播种进了真实 PG——而不是只有测试直接给 store 传 seed 才生效。
(hasPg ? describe : describe.skip)('PC-07 生产接线：resolveGatewayConfig → startGateway 进真实 PG', () => {
  /** 本轮网关数据目录（master.key）：mkdtemp 独占创建，返回值即拥有权事实；清理只认本轮变量 */
  const DATA_DIR_PREFIX = '.pc07-gw-';
  let dataDir = null; // 本轮 mkdtemp 返回的独占目录路径；不删除任何固定旧目录
  let masterKeySnapshot = null; // 首次启动后的 master.key 内容，供重开用例钉住主密钥稳定

  /** 删除守卫：只允许删本轮 mkdtemp 创建、前缀匹配且解析后位于本测试根内的目录 */
  function removeOwnedDataDir(dir) {
    if (typeof dir !== 'string' || !path.basename(dir).startsWith(DATA_DIR_PREFIX)) {
      throw new Error(`refusing to remove data dir not owned by this round: ${String(dir)}`);
    }
    const resolved = path.resolve(dir);
    const testRoot = path.resolve(import.meta.dirname);
    if (!resolved.startsWith(testRoot + path.sep)) {
      throw new Error(`refusing to remove data dir outside test root: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }

  let rawUrl;
  let ownedSchema = null; // 本轮独占 schema，CREATE 成功即拥有权事实

  const ENV_A = {
    ZR_GATEWAY_ALLOW_SIGNUP: 'true',
    ZR_GATEWAY_MAX_PEERS: '16',
    ZR_GATEWAY_MAX_NETWORKS_PER_USER: '7',
    ZR_GATEWAY_RELAY_RATE_KBPS: '128',
  };
  const ENV_B = {
    ZR_GATEWAY_ALLOW_SIGNUP: 'false',
    ZR_GATEWAY_MAX_PEERS: '64',
    ZR_GATEWAY_MAX_NETWORKS_PER_USER: '50',
    ZR_GATEWAY_RELAY_RATE_KBPS: '1048576',
  };
  const ENV_C = {
    ZR_GATEWAY_ALLOW_SIGNUP: 'false',
    ZR_GATEWAY_MAX_PEERS: '32',
    ZR_GATEWAY_MAX_NETWORKS_PER_USER: '2',
    ZR_GATEWAY_RELAY_RATE_KBPS: '512',
  };

  function gatewayEnv(fourKeys) {
    return {
      ZR_GATEWAY_UDP_ALT_PORT: '0',
      ZR_GATEWAY_DATA_DIR: dataDir,
      ZR_GATEWAY_ADMIN_USER: 'pc07-admin@local',
      ZR_GATEWAY_ADMIN_PASSWORD: 'pc07-admin-pass',
      ZR_GATEWAY_DATABASE_URL: databaseUrlFor(ownedSchema, 'zr_pc07_gateway'),
      ...fourKeys,
    };
  }

  /** 生产解析 + 测试管线例外：四键与 DATABASE_URL 全部走真实 env 解析，仅 HTTP 端口覆写 0（内核分配） */
  function resolveForTest(env) {
    return { ...resolveGatewayConfig(env), port: 0 };
  }

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
    return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
  }

  async function loginAdmin(gw) {
    const res = await fetch(gw.base + '/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pc07-admin@local', password: 'pc07-admin-pass' }),
    });
    assert.equal(res.status, 200, `admin login failed: ${JSON.stringify(await res.json())}`);
    const raw = res.headers.getSetCookie().find((c) => c.startsWith('zr_gw_session='));
    assert.ok(raw, 'expected session cookie');
    return raw.split(';')[0];
  }

  before(async () => {
    rawUrl = readRawDatabaseUrl();
    ownedSchema = await createOwnedSchema(rawUrl);
    dataDir = fs.mkdtempSync(path.join(import.meta.dirname, DATA_DIR_PREFIX)); // 独占目录，开始不删任何既有目录
  });

  after(async () => {
    const problems = [];
    if (ownedSchema !== null) {
      try {
        await bounded('drop PC-07 主 schema', TEARDOWN_STEP_MS, dropOwnedSchema(rawUrl, ownedSchema));
      } catch (error) {
        problems.push(`drop schema: ${error.message}`);
      }
    }
    if (dataDir !== null) {
      try {
        removeOwnedDataDir(dataDir); // 只删本轮 mkdtemp 创建且通过守卫核对的目录
      } catch (error) {
        problems.push(`rm dataDir: ${error.message}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`PC-07 收尾失败: ${problems.join('; ')}`);
    }
  });

  test('空库：环境配置 true/16/7/128 经生产组装播种进真实 PG，REST 实际读值一致', { timeout: 30_000 }, async () => {
    const gw = await startGateway(resolveForTest(gatewayEnv(ENV_A)));
    try {
      assert.equal(gw.admin.created, true);
      assert.equal(gw.store.constructor.name, 'PgStore', 'databaseUrl 配置下生产组装必须真的用 PG');
      masterKeySnapshot = fs.readFileSync(path.join(dataDir, 'master.key'));
      const cookie = await loginAdmin(gw);
      const res = await api(gw.base, 'GET', '/api/v1/admin/settings', { cookie });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      // 设置响应严格 4 键（GC-2-fix1：扩展内部字段绝不进 HTTP 响应）
      assert.deepEqual(res.json.data, {
        allowSignup: true,
        maxNetworksPerUser: 7,
        defaultMaxPeers: 16,
        relayRateKbps: 128,
      });

      // 控制台路径改一个键 + 建一个网络，供后续重开/缺键用例验证持久化优先
      const patched = await api(gw.base, 'PATCH', '/api/v1/admin/settings', {
        body: { defaultMaxPeers: 24 },
        cookie,
      });
      assert.equal(patched.status, 200, JSON.stringify(patched.json));
      const created = await api(gw.base, 'POST', '/api/v1/networks', {
        body: { name: 'pc07-pg-net', admissionMode: 'manual' },
        cookie,
      });
      assert.equal(created.status, 200, JSON.stringify(created.json));
    } finally {
      await gw.close();
    }
  });

  test('已有键保持：不同环境值重开同一 schema，控制台修改与首次播种值都不被覆盖', { timeout: 30_000 }, async () => {
    const gw = await startGateway(resolveForTest(gatewayEnv(ENV_B)));
    try {
      // 同一数据目录重开必须复用同一主密钥（不改写、不重建）
      assert.deepEqual(fs.readFileSync(path.join(dataDir, 'master.key')), masterKeySnapshot, '主密钥重开必须稳定');
      const res = await api(gw.base, 'GET', '/api/v1/admin/settings', { cookie: await loginAdmin(gw) });
      // 设置响应严格 4 键；播种值与控制台值不被不同环境的重开覆盖
      assert.deepEqual(res.json.data, {
        allowSignup: true, // ENV_A 播种值保留（ENV_B 是 false）
        maxNetworksPerUser: 7, // ENV_A 播种值保留（ENV_B 是 50）
        defaultMaxPeers: 24, // 控制台改过的值保留
        relayRateKbps: 128, // ENV_A 播种值保留（ENV_B 是 1048576）
      });
    } finally {
      await gw.close();
    }
  });

  test('缺键逐键补齐：删除 relay_rate_kbps 后重开，只按本轮环境补该键，admin 与网络保持', { timeout: 30_000 }, async () => {
    // 模拟旧版本库缺键：root 连接删掉单个设置行（只动本轮独占 schema）
    await withRootClient(rawUrl, (c) =>
      c.query(`DELETE FROM "${ownedSchema}".system_settings WHERE key = $1`, [SETTINGS_KEYS.relayRateKbps]),
    );

    const gw = await startGateway(resolveForTest(gatewayEnv(ENV_C)));
    try {
      const res = await api(gw.base, 'GET', '/api/v1/admin/settings', { cookie: await loginAdmin(gw) });
      // 设置响应严格 4 键；唯一缺失的键按本轮 ENV_C 补齐
      assert.deepEqual(res.json.data, {
        allowSignup: true, // 保留（ENV_C 是 false）
        maxNetworksPerUser: 7, // 保留（ENV_C 是 2）
        defaultMaxPeers: 24, // 控制台值保留（ENV_C 是 32）
        relayRateKbps: 512, // 唯一缺失的键按本轮 ENV_C 补齐
      });
      // 初始化逻辑不得重置业务数据：admin 可登录、控制台建的网络仍在
      const nets = await api(gw.base, 'GET', '/api/v1/networks', { cookie: await loginAdmin(gw) });
      assert.equal(nets.status, 200);
      assert.ok(
        Array.isArray(nets.json.data) && nets.json.data.some((n) => n.name === 'pc07-pg-net'),
        `pc07-pg-net 必须在重开后保留：${JSON.stringify(nets.json.data)}`,
      );
    } finally {
      await gw.close();
    }
  });

  test('connect 初始化失败：连接池归还、原始错误原样抛出（受控正常存储失败，隔离子进程）', { timeout: 30_000 }, async () => {
    // search_path 指向不存在的 schema：连接建立、建表必失败的纯配置型存储错误，
    // 不涉及权限操纵或网络攻击。子进程内完成失败与归还计数（显式 exit，泄漏不挂进程）。
    const outcome = await runTestChild('init-fail', ownedSchema, 20_000);
    assert.equal(outcome.spawnError, undefined, `子进程启动失败: ${outcome.spawnError}`);
    assert.equal(outcome.code, 0, `init-fail 子进程应正常结束（exit=${outcome.code}，stderr=${outcome.stderr.slice(0, 300)}）`);
    const summary = JSON.parse(outcome.stdout.trim().split('\n').pop());
    assert.equal(summary.rejected, true, 'connect 必须拒绝');
    assert.match(summary.errorMessage, /exist/i, `原始错误必须保留: ${summary.errorMessage}`);
    assert.equal(summary.leaked, 0, `初始化失败后连接池必须归还，泄漏 ${summary.leaked} 条服务端会话`);
  });
});

// ---------------------------------------------------------------- PC-10 统一五态席位规则（真实 PG）

// 契约：authorized/paused/mismatch 占席，pending/revoked 不占席；只有不占席 → 占席才新增
// 一席并查空余，缩容超额存量在占席状态之间放行。与 store.test.mjs（SQLite）覆盖同一状态
// 矩阵，另有界并发批次（8 并发以内）证明不超配、不死锁（statement_timeout 兜底）。
(hasPg ? describe : describe.skip)('PC-10 统一席位规则：真实 PG 状态矩阵与有限并发', () => {
  const masterKey = Buffer.alloc(32, 0xcd);
  const enc = (s) => encryptSecret(s, masterKey);

  let rawUrl;
  let ownedSchema = null; // 本轮独占 schema，CREATE 成功即拥有权事实
  let store;
  let adminId;

  async function join10(net, nodeId, { matched = true, pub } = {}) {
    return store.upsertMemberJoinAttempt({
      networkId: net.id,
      nodeId,
      name: `node-${nodeId}`,
      publicKeyHex: pub ?? nodeId + 'a'.repeat(56), // 合同形状：8hex nodeId + 64hex 公钥
      joinKeyMatched: matched,
    });
  }

  async function memberInState10(net, nodeId, wanted) {
    if (wanted === 'pending') return join10(net, nodeId, { matched: false });
    if (wanted === 'authorized') return join10(net, nodeId, { matched: true });
    if (wanted === 'paused') {
      await join10(net, nodeId, { matched: true });
      return store.transitionMemberStatus(net.id, nodeId, 'pause');
    }
    if (wanted === 'mismatch') {
      await join10(net, nodeId, { matched: true });
      return join10(net, nodeId, { pub: nodeId + 'c'.repeat(56), matched: true }); // 原位换钥
    }
    throw new Error(`unknown state ${wanted}`);
  }

  function limitReached(err) {
    assert.ok(err instanceof StoreError, `expected StoreError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, 'limit-reached');
    return true;
  }

  before(async () => {
    rawUrl = readRawDatabaseUrl();
    ownedSchema = await createOwnedSchema(rawUrl);
    store = await PgStore.connect(databaseUrlFor(ownedSchema, 'zr_pc10_seat'));
    await store.ensureBootstrapAdmin({ email: 'pc10-admin@local', password: 'pc10-admin-pass' });
    adminId = (await store.findUserByEmail('pc10-admin@local')).id;
  });

  after(async () => {
    const problems = [];
    if (store !== undefined) {
      try {
        await bounded('pc10 store.close', TEARDOWN_STEP_MS, store.close());
      } catch (error) {
        problems.push(`close: ${error.message}`);
      }
    }
    if (ownedSchema !== null) {
      try {
        await bounded('drop PC-10 主 schema', TEARDOWN_STEP_MS, dropOwnedSchema(rawUrl, ownedSchema));
      } catch (error) {
        problems.push(`drop schema: ${error.message}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`PC-10 收尾失败: ${problems.join('; ')}`);
    }
  });

  test('准入与 approve 同口径：满网（authorized+mismatch）拒绝一切新增占席，释放席位后空位可批', { timeout: 30_000 }, async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'pc10-caliber', admissionMode: 'both', joinKeyEnc: enc('pc10-k1'), maxPeers: 2 });
    await memberInState10(net, '10aaaaaa', 'authorized');
    await memberInState10(net, '20aaaaaa', 'mismatch'); // authorized 原位换钥，仍占第 2 席
    // 新成员带口令 → limit-reached
    await assert.rejects(join10(net, '30aaaaaa', { matched: true }), limitReached);
    // pending 换公钥滑入 mismatch 也是新增占席 → limit-reached，行保持 pending
    await memberInState10(net, '40aaaaaa', 'pending');
    await assert.rejects(join10(net, '40aaaaaa', { pub: '40aaaaaa' + 'b'.repeat(56), matched: true }), limitReached);
    const p = (await store.listMembers(net.id)).find((m) => m.nodeId === '40aaaaaa');
    assert.equal(p.status, 'pending');
    assert.equal(p.candidatePublicKeyHex, null);
    // 手动 approve 同口径：2 席已满，approve（不占席 → 占席）拒绝
    await assert.rejects(store.transitionMemberStatus(net.id, '40aaaaaa', 'approve'), limitReached);
    // mismatch→reject 释放席位（占席 → 不占席），腾出的空位可被合法批准
    await store.transitionMemberStatus(net.id, '20aaaaaa', 'reject');
    const approved = await store.transitionMemberStatus(net.id, '40aaaaaa', 'approve');
    assert.equal(approved.status, 'authorized');
  });

  test('占席→占席保持原席位：满网 repin/resume/幂等动作放行，非法 repin 仍拒绝', { timeout: 30_000 }, async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'pc10-keep-seat', admissionMode: 'both', joinKeyEnc: enc('pc10-k2'), maxPeers: 2 });
    await memberInState10(net, '11aaaaaa', 'authorized');
    await memberInState10(net, '12aaaaaa', 'paused'); // 2/2 占满
    // authorized→mismatch 原位换钥（席位不变）→ repin 换锚成功
    const swapped = await join10(net, '11aaaaaa', { pub: '11aaaaaa' + 'd'.repeat(56), matched: true });
    assert.equal(swapped.status, 'mismatch');
    const repinned = await store.transitionMemberStatus(net.id, '11aaaaaa', 'repin');
    assert.equal(repinned.status, 'authorized');
    assert.equal(repinned.publicKeyHex, '11aaaaaa' + 'd'.repeat(56));
    // resume / 幂等动作不抛 limit-reached、不重复计席
    assert.equal((await store.transitionMemberStatus(net.id, '12aaaaaa', 'resume')).status, 'authorized');
    assert.equal((await store.transitionMemberStatus(net.id, '11aaaaaa', 'approve')).status, 'authorized');
    assert.equal((await store.transitionMemberStatus(net.id, '12aaaaaa', 'pause')).status, 'paused');
    // 非法迁移仍按原规则拒绝：authorized 不能 repin
    await assert.rejects(
      store.transitionMemberStatus(net.id, '11aaaaaa', 'repin'),
      (err) => err instanceof StoreError && err.code === 'invalid-transition',
    );
  });

  test('缩容超额存量：resume/repin 放行，新增占席仍拒绝（不断言总数小于新上限）', { timeout: 30_000 }, async () => {
    const net = await store.createNetwork({ ownerId: adminId, name: 'pc10-shrink', admissionMode: 'both', joinKeyEnc: enc('pc10-k3'), maxPeers: 3 });
    await memberInState10(net, '21aaaaaa', 'authorized');
    await memberInState10(net, '22aaaaaa', 'paused');
    await memberInState10(net, '23aaaaaa', 'mismatch'); // 3 名占席成员
    await store.updateNetwork(net.id, { maxPeers: 1 }); // 缩容：存量全保留、超额
    assert.equal((await store.transitionMemberStatus(net.id, '22aaaaaa', 'resume')).status, 'authorized');
    const repinned = await store.transitionMemberStatus(net.id, '23aaaaaa', 'repin');
    assert.equal(repinned.status, 'authorized');
    await memberInState10(net, '24aaaaaa', 'pending');
    await assert.rejects(store.transitionMemberStatus(net.id, '24aaaaaa', 'approve'), limitReached);
    // 超额存量语义：只断言既定迁移的结果（3 名 authorized），不断言任何时刻占席总数 < 新上限
    const statuses = (await store.listMembers(net.id)).map((m) => m.status);
    assert.equal(statuses.filter((s) => s === 'authorized').length, 3);
  });

  test('有限并发批次：6 并发 approve 恰好 2 authorized/4 limit-reached；8 并发准入恰好 2 authorized，无死锁', { timeout: 30_000 }, async () => {
    // 并发审批：6 个 pending 竞争 2 席（走原有网络行 FOR UPDATE 事务锁）
    const approveNet = await store.createNetwork({ ownerId: adminId, name: 'pc10-conc-approve', admissionMode: 'manual', joinKeyEnc: enc('pc10-k4'), maxPeers: 2 });
    const approveIds = ['31aaaaaa', '32aaaaaa', '33aaaaaa', '34aaaaaa', '35aaaaaa', '36aaaaaa'];
    for (const id of approveIds) {
      await memberInState10(approveNet, id, 'pending');
    }
    const approveResults = await Promise.allSettled(
      approveIds.map((id) => store.transitionMemberStatus(approveNet.id, id, 'approve')),
    );
    const approved = approveResults.filter((r) => r.status === 'fulfilled');
    const limitRejected = approveResults.filter(
      (r) => r.status === 'rejected' && r.reason instanceof StoreError && r.reason.code === 'limit-reached',
    );
    const otherErrors = approveResults.filter((r) => r.status === 'rejected' && !limitRejected.includes(r));
    assert.equal(
      otherErrors.length,
      0,
      `并发批次只允许成功或 limit-reached：${otherErrors.map((r) => String(r.reason)).join('; ')}`,
    );
    assert.equal(approved.length, 2, '并发审批不得超配（恰好 2 席成功）');
    assert.equal(limitRejected.length, 4);
    const approveStatuses = (await store.listMembers(approveNet.id)).map((m) => m.status);
    assert.equal(approveStatuses.filter((s) => s === 'authorized').length, 2);

    // 并发准入：8 台带口令同时入网竞争 2 席
    const joinNet = await store.createNetwork({ ownerId: adminId, name: 'pc10-conc-join', admissionMode: 'key', joinKeyEnc: enc('pc10-k5'), maxPeers: 2 });
    const joinIds = ['41aaaaaa', '42aaaaaa', '43aaaaaa', '44aaaaaa', '45aaaaaa', '46aaaaaa', '47aaaaaa', '48aaaaaa'];
    const joinResults = await Promise.allSettled(joinIds.map((id) => join10(joinNet, id, { matched: true })));
    const joined = joinResults.filter((r) => r.status === 'fulfilled' && r.value.status === 'authorized');
    const joinRejected = joinResults.filter(
      (r) => r.status === 'rejected' && r.reason instanceof StoreError && r.reason.code === 'limit-reached',
    );
    const joinOtherErrors = joinResults.filter((r) => r.status === 'rejected' && !joinRejected.includes(r));
    assert.equal(joinOtherErrors.length, 0, `并发准入只允许成功或 limit-reached：${joinOtherErrors.map((r) => String(r.reason)).join('; ')}`);
    assert.equal(joined.length, 2, '并发准入不得超配（恰好 2 席成功）');
    assert.equal(joinRejected.length, 6);
    const joinStatuses = (await store.listMembers(joinNet.id)).map((m) => m.status);
    assert.equal(joinStatuses.filter((s) => s === 'authorized').length, 2);
  });
});

// ---------------------------------------------------------------- PC-19 第一片：flushMemberTelemetry 单事务全成/全败（真实 PG）

// 契约（PC-19 第一片）：一次 flushMemberTelemetry 的整批 UPDATE 在同一事务 client
// 里全成或全败——中途普通 SQL 失败（第二条触发 nat_type CHECK 违反）必须回滚
// 已执行的前序语句；恢复后重试同一批不重复计数。只验证正常明确失败的回滚边界，
// 不宣称任意断电/COMMIT 结果不明场景下的 exactly-once。
(hasPg ? describe : describe.skip)('PC-19 第一片：遥测批次单事务（真实 PG，ZR_TEST_PG_URL_FILE 未设置时 skip）', () => {
  const SCHEMA_PREFIX_PC19 = 'zr_pc19_test_';
  const masterKey = Buffer.alloc(32, 0x19);
  const enc = (s) => encryptSecret(s, masterKey);

  let rawUrl;
  let ownedSchema = null; // 本轮独占 schema，CREATE 成功即拥有权事实
  let store;
  let adminId;
  let net;

  /** 本轮前缀内的 schema 管理只认本轮变量记录的名字（与 PC-06 同款守卫） */
  function dropOwnedSchemaPc19(schema) {
    if (typeof schema !== 'string' || !schema.startsWith(SCHEMA_PREFIX_PC19)) {
      throw new Error(`refusing to drop schema not owned by this run: ${String(schema)}`);
    }
    return withRootClient(rawUrl, (c) => c.query(`DROP SCHEMA "${schema}" CASCADE`));
  }

  before(async () => {
    rawUrl = readRawDatabaseUrl();
    const name = SCHEMA_PREFIX_PC19 + randomBytes(6).toString('hex');
    // 不带 IF NOT EXISTS：创建失败即本轮失败，绝不把别人已有的 schema 当自己的
    await withRootClient(rawUrl, (c) => c.query(`CREATE SCHEMA "${name}"`));
    ownedSchema = name;
    store = await PgStore.connect(databaseUrlFor(ownedSchema, 'zr_pc19_test_main'));
    await store.ensureBootstrapAdmin({ email: 'pc19-admin@local', password: 'pc19-admin-pass' });
    adminId = (await store.findUserByEmail('pc19-admin@local')).id;
    net = await store.createNetwork({
      ownerId: adminId,
      name: 'pc19-telemetry',
      admissionMode: 'key',
      joinKeyEnc: enc('pc19-k1'),
      maxPeers: 4,
    });
    for (const nodeId of ['51aaaaaa', '52aaaaaa']) {
      const joined = await store.upsertMemberJoinAttempt({
        networkId: net.id,
        nodeId,
        name: `node-${nodeId}`,
        publicKeyHex: nodeId + 'a'.repeat(56),
        joinKeyMatched: true,
      });
      assert.equal(joined.status, 'authorized');
    }
  });

  after(async () => {
    const problems = [];
    if (store !== undefined) {
      try {
        await bounded('pc19 store.close', TEARDOWN_STEP_MS, store.close());
      } catch (error) {
        problems.push(`close: ${error.message}`);
      }
    }
    if (ownedSchema !== null) {
      try {
        await bounded('drop PC-19 主 schema', TEARDOWN_STEP_MS, dropOwnedSchemaPc19(ownedSchema));
      } catch (error) {
        problems.push(`drop schema: ${error.message}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`PC-19 收尾失败: ${problems.join('; ')}`);
    }
  });

  test('单批两成员同一事务全成：字节累加与 NAT/lastIp/lastSeen 合并落库', { timeout: 30_000 }, async () => {
    await store.flushMemberTelemetry([
      {
        networkId: net.id,
        nodeId: '51aaaaaa',
        relayBytesDelta: 100,
        lastIp: '10.1.1.1',
        natType: 'cone',
        lastSeenAt: new Date().toISOString(),
      },
      { networkId: net.id, nodeId: '52aaaaaa', relayBytesDelta: 200 },
    ]);
    const rows = await store.listMembers(net.id);
    const a = rows.find((m) => m.nodeId === '51aaaaaa');
    const b = rows.find((m) => m.nodeId === '52aaaaaa');
    assert.equal(a.cumulativeRelayBytes, 100);
    assert.equal(a.natType, 'cone');
    assert.equal(a.lastIp, '10.1.1.1');
    assert.ok(a.lastSeenAt !== null, 'lastSeenAt 随批次落库');
    assert.equal(b.cumulativeRelayBytes, 200);
    assert.equal(b.natType, 'unknown', '未带 NAT 的行保持原值');
  });

  test('单批第二条普通 SQL 失败（CHECK 违反）→ 整批回滚，恢复后重试不重复计数', { timeout: 30_000 }, async () => {
    const before = await store.listMembers(net.id);
    const a0 = before.find((m) => m.nodeId === '51aaaaaa').cumulativeRelayBytes;
    const b0 = before.find((m) => m.nodeId === '52aaaaaa').cumulativeRelayBytes;

    // 第二条 UPDATE 带 CHECK 枚举外的 natType → 服务端普通约束错误；此时第一条
    // 已在事务内执行——没有事务的话 +50 会已经落库（自增提交），回滚后必须原样
    await assert.rejects(
      store.flushMemberTelemetry([
        { networkId: net.id, nodeId: '51aaaaaa', relayBytesDelta: 50 },
        { networkId: net.id, nodeId: '52aaaaaa', relayBytesDelta: 7, natType: 'bogus' },
      ]),
    );
    const afterFail = await store.listMembers(net.id);
    assert.equal(
      afterFail.find((m) => m.nodeId === '51aaaaaa').cumulativeRelayBytes,
      a0,
      '第一条已执行的写入必须随事务回滚（不得残留 +50）',
    );
    assert.equal(afterFail.find((m) => m.nodeId === '52aaaaaa').cumulativeRelayBytes, b0);

    // 恢复：修正后的同一批重试，两成员各自恰好一次（不重复计数）
    await store.flushMemberTelemetry([
      { networkId: net.id, nodeId: '51aaaaaa', relayBytesDelta: 50 },
      { networkId: net.id, nodeId: '52aaaaaa', relayBytesDelta: 7 },
    ]);
    const afterRetry = await store.listMembers(net.id);
    assert.equal(afterRetry.find((m) => m.nodeId === '51aaaaaa').cumulativeRelayBytes, a0 + 50);
    assert.equal(afterRetry.find((m) => m.nodeId === '52aaaaaa').cumulativeRelayBytes, b0 + 7);
  });
});
