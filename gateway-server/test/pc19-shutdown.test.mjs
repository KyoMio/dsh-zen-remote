// PC-19 第二片：真实 SIGTERM 入口的受控子进程验证（正常功能路径，无攻击/压测）。
//
//   ok  ：子进程经真实 main() 入口启动（ZR_GATEWAY_* 全走生产 env 解析），驱动
//         一帧真实中转流量后宣告 READY；父进程 SIGTERM → 断言退出码 0 且有界，
//         随后父进程**重开同一 PG schema** 读回末批累计——生产关停链路的端到端
//         证据，不以 mock 冒充。
//   hang ：子进程 flushMemberTelemetry 受控永不完成（测试专用受控错误）→ SIGTERM
//         → 生产信号入口必须在墙钟预算（默认 5000ms）耗尽后**非零退出**；父进程
//         另有兜底 deadline，兜底触发（SIGKILL）即本测试失败。
//
// 隔离与清理：每例独占随机 schema（zr_pc19sd_test_ 前缀，CREATE 成功即拥有权），
// 收尾只 DROP 本轮记录的名字；子进程数据目录 mkdtemp 于 .scratch/pc-19 下，收尾
// 只删本轮目录。PG URL 文件只由测试进程读取，凭据不进日志/stdout。
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PgStore } from '../dist/store/pg-store.js';

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH_ROOT = path.resolve(TEST_ROOT, '..', '..', '.scratch', 'pc-19');
const URL_FILE = path.join(SCRATCH_ROOT, 'pg-url.txt');
const CHILD_PATH = path.join(TEST_ROOT, 'pc19-shutdown-child.mjs');
const SCHEMA_PREFIX = 'zr_pc19sd_test_';
const READY_DEADLINE_MS = 15_000;
/** 父进程兜底 deadline：到点 SIGKILL 兜底，兜底触发即失败（关停必须自有界退出） */
const EXIT_FALLBACK_MS = 20_000;
/** 生产关停墙钟预算（StartGatewayOptions 缺省 5000ms）的判定下限（留调度余量） */
const BUDGET_FLOOR_MS = 4_500;

const hasPg = fs.existsSync(URL_FILE);

/** 本轮独占 schema：CREATE 成功即拥有权事实（不带 IF NOT EXISTS，撞名即失败） */
async function createOwnedSchema() {
  const raw = fs.readFileSync(URL_FILE, 'utf8').trim();
  const schema = SCHEMA_PREFIX + randomBytes(6).toString('hex');
  await withRootClient((c) => c.query(`CREATE SCHEMA "${schema}"`));
  const url = new URL(raw);
  url.searchParams.set('options', `-c search_path=${schema}`);
  url.searchParams.set('application_name', 'zr_pc19sd_test');
  return { schema, url: url.toString() };
}

async function withRootClient(fn) {
  const mod = await import('pg');
  const Client = (mod.default ?? mod).Client;
  const raw = fs.readFileSync(URL_FILE, 'utf8').trim();
  const client = new Client({ connectionString: raw });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function dropOwnedSchema(schema) {
  if (typeof schema !== 'string' || !schema.startsWith(SCHEMA_PREFIX)) {
    throw new Error(`refusing to drop schema not owned by this run: ${String(schema)}`);
  }
  await withRootClient((c) => c.query(`DROP SCHEMA "${schema}" CASCADE`));
}

/** mkdtemp 独占子进程数据目录（.scratch/pc-19 下）；清理只认本轮返回值与前缀 */
function makeChildDataDir() {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH_ROOT, 'sd-child-'));
}

function removeOwnedDataDir(dir) {
  if (typeof dir !== 'string' || !path.basename(dir).startsWith('sd-child-')) {
    throw new Error(`refusing to remove data dir not owned by this run: ${String(dir)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function spawnChild(mode, schemaUrl, dataDir, port) {
  const child = spawn(process.execPath, [CHILD_PATH, mode], {
    env: {
      ZR_GATEWAY_PORT: String(port),
      ZR_GATEWAY_UDP_ALT_PORT: '0',
      ZR_GATEWAY_DATA_DIR: dataDir,
      ZR_GATEWAY_ADMIN_USER: 'pc19sd-admin@local',
      ZR_GATEWAY_ADMIN_PASSWORD: 'pc19sd-admin-pass',
      ZR_GATEWAY_DATABASE_URL: schemaUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = { stdout: '', stderr: '', fallbackKilled: false };
  child.stdout.on('data', (d) => {
    capture.stdout += d;
  });
  child.stderr.on('data', (d) => {
    capture.stderr += d;
  });
  return { child, capture };
}

/** 等 READY 行（有界）；返回 { bytes, netId, senderNodeId } */
function waitForReady(capture, deadlineMs = READY_DEADLINE_MS) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const match = capture.stdout.match(/PC19_CHILD_READY bytes=(\d+) net=([0-9a-f]+) sender=([0-9a-f]+)/);
      if (match !== null) {
        resolve({ bytes: Number(match[1]), netId: match[2], senderNodeId: match[3] });
        return;
      }
      if (Date.now() - startedAt > deadlineMs) {
        reject(new Error(`child not ready within ${deadlineMs}ms; stdout=${capture.stdout.slice(0, 400)} stderr=${capture.stderr.slice(0, 400)}`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** 等 子进程退出（父进程兜底 deadline；兜底 SIGKILL 由断言判定为失败） */
function waitForExit(child, capture) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const fallback = setTimeout(() => {
      capture.fallbackKilled = true;
      child.kill('SIGKILL');
    }, EXIT_FALLBACK_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(fallback);
      resolve({ code, signal, wallMs: Date.now() - startedAt, ...capture });
    });
  });
}

(hasPg ? describe : describe.skip)('PC-19 第二片：真实 SIGTERM 子进程（ZR_TEST pg-url 缺失时 skip）', () => {
  const created = [];
  after(async () => {
    const problems = [];
    for (const entry of created.splice(0)) {
      try {
        await dropOwnedSchema(entry.schema);
      } catch (error) {
        problems.push(`drop schema: ${error.message}`);
      }
      try {
        removeOwnedDataDir(entry.dataDir);
      } catch (error) {
        problems.push(`rm dataDir: ${error.message}`);
      }
    }
    if (problems.length > 0) throw new Error(`PC-19 shutdown 收尾失败: ${problems.join('; ')}`);
  });

  test('正常 SIGTERM：真实入口退出 0，重开数据库读回末批累计', { timeout: 60_000 }, async () => {
    const { schema, url } = await createOwnedSchema();
    const dataDir = makeChildDataDir();
    created.push({ schema, dataDir });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const { child, capture } = spawnChild('ok', url, dataDir, port);
    const ready = await waitForReady(capture);
    child.kill('SIGTERM');
    const outcome = await waitForExit(child, capture);
    assert.equal(outcome.fallbackKilled, false, '正常关停必须在父进程兜底 deadline 内自行退出');
    assert.equal(outcome.signal, null, `正常关停应自行 exit（signal=${outcome.signal}）`);
    assert.equal(outcome.code, 0, `正常关停退出码必须为 0（code=${outcome.code}，stderr=${capture.stderr.slice(0, 400)}）`);

    // 重开同一 schema：末批累计与 lastSeen 必须已落库（生产 close 补末批的证据）
    const reopened = await PgStore.connect(url);
    try {
      const members = await reopened.listMembers(ready.netId);
      const sender = members.find((m) => m.nodeId === ready.senderNodeId);
      assert.ok(sender, `发送者 ${ready.senderNodeId} 应在成员表中`);
      assert.equal(sender.cumulativeRelayBytes, ready.bytes, '末批必须已落库');
      assert.ok(sender.lastSeenAt !== null, '末批应携带 lastSeenAt');
    } finally {
      await reopened.close();
    }
  });

  test('永不完成写：SIGTERM 后生产入口在墙钟预算后非零退出（兜底触发即失败）', { timeout: 60_000 }, async () => {
    const { schema, url } = await createOwnedSchema();
    const dataDir = makeChildDataDir();
    created.push({ schema, dataDir });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const { child, capture } = spawnChild('hang', url, dataDir, port);
    await waitForReady(capture);
    child.kill('SIGTERM');
    const outcome = await waitForExit(child, capture);
    assert.equal(outcome.fallbackKilled, false, '关停必须自有界退出：父进程兜底 SIGKILL 触发即失败');
    assert.equal(outcome.signal, null, `存储不响应时应 process.exit 非零（signal=${outcome.signal}）`);
    assert.notEqual(outcome.code, 0, `关停失败必须非零退出（code=${outcome.code}）`);
    assert.ok(
      outcome.wallMs >= BUDGET_FLOOR_MS,
      `非零退出必须在墙钟预算（≈5000ms）耗尽后（实测 ${outcome.wallMs}ms）`,
    );
    assert.match(capture.stderr, /shutdown failed|unconfirmed|budget/i, '失败路径必须如实报告未确认状态');
  });

  test('早期关停步骤卡点（UDP 关闭永不完成）：SIGTERM 后仍须预算+清理宽限内非零退出', { timeout: 60_000 }, async () => {
    const { schema, url } = await createOwnedSchema();
    const dataDir = makeChildDataDir();
    created.push({ schema, dataDir });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const { child, capture } = spawnChild('udp-hang', url, dataDir, port);
    await waitForReady(capture);
    child.kill('SIGTERM');
    const outcome = await waitForExit(child, capture);
    assert.equal(outcome.fallbackKilled, false, '失败兜底不得重新卡死：父进程兜底 SIGKILL 触发即失败');
    assert.equal(outcome.signal, null, `早期卡点也应 process.exit 非零（signal=${outcome.signal}）`);
    assert.notEqual(outcome.code, 0, `早期卡点路径必须非零退出（code=${outcome.code}）`);
    assert.ok(
      outcome.wallMs >= BUDGET_FLOOR_MS,
      `非零退出必须在墙钟预算（≈5000ms）耗尽后（实测 ${outcome.wallMs}ms）`,
    );
    assert.match(capture.stderr, /shutdown failed|unconfirmed|budget/i, '失败路径必须如实报告未确认状态');
  });
});
