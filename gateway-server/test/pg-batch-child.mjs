// PC-06 fix1 专用隔离子进程 runner（纯测试工具，不参与生产构建）。
// 用法：node test/pg-batch-child.mjs <batch|hang|init-fail> <urlFile> <schema>
// - batch：在本轮 schema 上重置配额并跑 50 并发建网 + 12 次健康查询，
//   stdout 最后一行输出 JSON 摘要（wallMs/fulfilled/quotaRejected/others/maxHealthMs）。
// - hang：connect 成功后人为永久挂起（测试工具自身的受控挂起，证明父侧 deadline+kill
//   能有界收口悬挂的子进程与其数据库连接；不是对生产代码的阻塞复现）。
// - init-fail（PC-07 fix1）：受控正常存储失败回归——子进程自建独占 schema，其中
//   system_settings 预置为缺 value 列的旧版形（模拟不兼容的历史表结构）：initSchema
//   的 IF NOT EXISTS 全部跳过/建表成功，seedSettings 的 INSERT 必然抛原始列错误且
//   连接以空闲状态留在池里。断言 connect 拒绝、错误为原始存储错误，并按
//   application_name 数 pg_stat_activity 证明连接池已归还（泄漏时显式 exit，
//   避免泄漏套接字挂住本进程）。子进程只清理自己创建的 schema。
// 连接 URL（含凭据）仅在本进程内读取使用，不输出。
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { PgStore } from '../dist/store/pg-store.js';
import { StoreError } from '../dist/store/types.js';

const STATEMENT_TIMEOUT_MS = 5000;
const HEALTH_LATENCY_MS = 5000;
const BATCH_DEADLINE_MS = 30_000;

const [mode, urlFile, schema] = process.argv.slice(2);
if ((mode !== 'batch' && mode !== 'hang' && mode !== 'init-fail') || !urlFile || !schema) {
  console.error('usage: pg-batch-child.mjs <batch|hang|init-fail> <urlFile> <schema>');
  process.exit(2);
}

const raw = readFileSync(urlFile, 'utf8').trim();

if (mode === 'init-fail') {
  const APP_NAME = 'zr_pc07_init_fail';
  // 本轮自建独占失败 schema：CREATE（无 IF NOT EXISTS）成功即拥有权；收尾只 DROP 这个名字
  const failSchema = `zr_pc07_init_fail_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const mod = await import('pg');
  const Client = (mod.default ?? mod).Client;
  const root = new Client({ connectionString: raw });
  await root.connect();
  await root.query(`CREATE SCHEMA "${failSchema}"`);
  let message = null;
  let leaked = -1;
  try {
    // 旧版形 system_settings：有 key 无 value → initSchema（IF NOT EXISTS）成功跳过，
    // seedSettings 的 INSERT INTO (key, value) 必然抛「column "value" … does not exist」
    await root.query(`CREATE TABLE "${failSchema}".system_settings (key text PRIMARY KEY)`);

    const bad = new URL(raw);
    bad.searchParams.set('options', `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c search_path=${failSchema}`);
    bad.searchParams.set('application_name', APP_NAME);
    let rejected = null;
    try {
      await PgStore.connect(bad.toString(), { allowSignup: true, maxNetworksPerUser: 7, defaultMaxPeers: 16, relayRateKbps: 128 });
    } catch (error) {
      rejected = error;
    }
    assertEqual(rejected !== null, true, 'connect 必须因 seedSettings 失败拒绝');
    message = String(rejected?.message ?? rejected);
    const isOriginalStorageError = /exist/i.test(message) && !/Connection terminated/i.test(message);
    assertEqual(isOriginalStorageError, true, `拒绝必须保留原始存储错误，实际: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 300)); // 等会话状态在服务端可见
    // 归还证据：服务端视角按 application_name 数失败 pool 的会话，归还后必须为 0
    const counted = await root.query('SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [APP_NAME]);
    leaked = counted.rows[0].n;
  } finally {
    // 断言失败也要清理本轮自建 schema 与 root 连接（只清自己创建的 failSchema）
    await root.query(`DROP SCHEMA "${failSchema}" CASCADE`).catch(() => {});
    await root.end().catch(() => {});
  }
  console.log(JSON.stringify({ rejected: true, errorMessage: message.slice(0, 160), leaked }));
  process.exit(0); // 泄漏的套接字不再挂住本进程（泄漏量已如实上报）
}

const u = new URL(raw);
u.searchParams.set('options', `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c search_path=${schema}`);
u.searchParams.set('application_name', mode === 'hang' ? 'zr_pc06_hang' : 'zr_pc06_batch');
const databaseUrl = u.toString();

const store = await PgStore.connect(databaseUrl);

if (mode === 'hang') {
  console.log('ready');
  await new Promise(() => {}); // 受控挂起：永不 settle，由父进程 SIGKILL 收口
}

// ---- batch 模式 ----

function classifyError(reason) {
  if (reason instanceof StoreError) return reason.code;
  if (reason?.code === '57014') return 'statement-timeout';
  return `unexpected:${reason?.name ?? typeof reason}`;
}

const t0 = performance.now();
try {
  await store.updateSettings({ maxNetworksPerUser: 20 });
  const batchUser = await store.findUserByEmail('pc06-batch@local');
  const tenant = await store.findUserByEmail('pc06-tenant@local');
  const other = await store.findUserByEmail('pc06-other@local');
  if (batchUser === null || tenant === null || other === null) {
    throw new Error('前置用户缺失（父测试顺序阶段未完成）');
  }
  const session = await store.createSession(tenant.id, 3_600_000);

  const BATCH = 50;
  const batch = Promise.allSettled(
    Array.from({ length: BATCH }, (_, i) =>
      store.createNetwork({
        ownerId: batchUser.id,
        name: `pc06-conc-${String(i).padStart(2, '0')}`,
        admissionMode: 'key',
        joinKeyEnc: 'enc-payload',
        maxPeers: 4,
      }),
    ),
  );

  const HEALTH_CALLS = 12;
  const timings = [];
  const health = (async () => {
    for (let i = 0; i < HEALTH_CALLS; i++) {
      const h0 = performance.now();
      const settings = await store.getSettings();
      assertEqual(settings.maxNetworksPerUser, 20, 'settings 可读且为并发批次配额');
      const seen = await store.getSessionUser(session.tokenHash, Date.now());
      assertEqual(seen !== null, true, '有效会话必须可读（auth/me 不被建网并发饿死）');
      const otherNets = await store.listNetworksByOwner(other.id);
      assertEqual(Array.isArray(otherNets) && otherNets.length, 0, '另租户列表及时返回');
      timings.push(performance.now() - h0);
    }
  })();

  const [results] = await Promise.all([batch, health]);
  const wallMs = performance.now() - t0;

  const codes = results.map((r) => (r.status === 'fulfilled' ? 'fulfilled' : classifyError(r.reason)));
  const fulfilled = codes.filter((c) => c === 'fulfilled').length;
  const quotaRejected = codes.filter((c) => c === 'quota-exceeded').length;
  const others = codes.filter((c) => c !== 'fulfilled' && c !== 'quota-exceeded');
  assertEqual(others.length, 0, `并发批次无计划外结局: ${JSON.stringify(others.slice(0, 3))}`);
  assertEqual(fulfilled, 20, `配额 20 下应恰好 20 个成功，实际 ${fulfilled}`);
  assertEqual(quotaRejected, BATCH - 20, `应恰好 30 个配额拒绝，实际 ${quotaRejected}`);
  const nets = await store.listNetworksByOwner(batchUser.id);
  assertEqual(nets.length, 20, '落库不得越配额');
  const maxHealthMs = Math.max(...timings);
  assertEqual(maxHealthMs <= HEALTH_LATENCY_MS, true, `健康查询最大延迟 ${Math.round(maxHealthMs)}ms 超界`);
  assertEqual(wallMs <= BATCH_DEADLINE_MS, true, `批次墙钟 ${Math.round(wallMs)}ms 超出 deadline`);

  await store.close();
  console.log(
    JSON.stringify({ wallMs: Math.round(wallMs), fulfilled, quotaRejected, others: others.length, maxHealthMs: Math.round(maxHealthMs) }),
  );
  process.exit(0);
} catch (error) {
  try {
    await store.close();
  } catch {
    /* 关闭失败不掩盖原始错误 */
  }
  console.error(String(error?.message ?? error));
  process.exit(1);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}（实际 ${JSON.stringify(actual)} !== 期望 ${JSON.stringify(expected)}）`);
  }
}
