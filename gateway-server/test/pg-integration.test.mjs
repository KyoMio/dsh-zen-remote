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
import { StoreError } from '../dist/store/types.js';
import { encryptSecret, hashPassword } from '../dist/master-key.js';

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

  test('connect：本轮 schema 内五张表齐全且幂等重建不抛错', { timeout: 30_000 }, async () => {
    await store.initSchema(); // 二次执行验证幂等
    const { rows } = await withRootClient(rawUrl, (c) =>
      c.query(
        "SELECT to_regclass(format('%I.%I', $1::text, table_name)) AS reg FROM (VALUES ('system_settings'),('users'),('sessions'),('networks'),('network_members')) AS t(table_name)",
        [ownedSchema],
      ),
    );
    const missing = rows.map((r) => r.reg).filter((r) => r === null);
    assert.deepEqual(missing, [], `本轮 schema ${ownedSchema} 内五张表必须全部存在`);
  });

  test('隔离：本轮两个 schema 彼此隔离（对照 schema 的同名表与数据不受 store 影响）', { timeout: 30_000 }, async () => {
    // store 的读写全部走主 schema（search_path），与对照 schema 的同名表互不可见
    const settings = await store.getSettings();
    assert.equal(typeof settings.maxNetworksPerUser, 'number');
    await store.updateSettings({ maxNetworksPerUser: 3, defaultMaxPeers: 4, relayRateKbps: 2048 });
    assert.equal((await store.getSettings()).maxNetworksPerUser, 3);
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
