// PC-06 fix1 专用隔离子进程 runner（纯测试工具，不参与生产构建）。
// 用法：node test/pg-batch-child.mjs <batch|hang> <urlFile> <schema>
// - batch：在本轮 schema 上重置配额并跑 50 并发建网 + 12 次健康查询，
//   stdout 最后一行输出 JSON 摘要（wallMs/fulfilled/quotaRejected/others/maxHealthMs）。
// - hang：connect 成功后人为永久挂起（测试工具自身的受控挂起，证明父侧 deadline+kill
//   能有界收口悬挂的子进程与其数据库连接；不是对生产代码的阻塞复现）。
// 连接 URL（含凭据）仅在本进程内读取使用，不输出。
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { PgStore } from '../dist/store/pg-store.js';
import { StoreError } from '../dist/store/types.js';

const STATEMENT_TIMEOUT_MS = 5000;
const HEALTH_LATENCY_MS = 5000;
const BATCH_DEADLINE_MS = 30_000;

const [mode, urlFile, schema] = process.argv.slice(2);
if ((mode !== 'batch' && mode !== 'hang') || !urlFile || !schema) {
  console.error('usage: pg-batch-child.mjs <batch|hang> <urlFile> <schema>');
  process.exit(2);
}

const raw = readFileSync(urlFile, 'utf8').trim();
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
