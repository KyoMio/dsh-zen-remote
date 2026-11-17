// PC-19 第二片：真实 SIGTERM 入口的受控 SQLite 子进程验证（零 skip，全平台必跑）。
// 挂起/超时兜底预算在 full-server.test.mjs 用 closeBudgetMs/abortStepBudgetMs 覆写覆盖。
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../dist/store/sqlite-store.js';
import { makeTmpDir } from './helpers/fixtures.mjs';

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHILD_PATH = path.join(TEST_ROOT, 'pc19-shutdown-child.mjs');
const READY_DEADLINE_MS = 10_000;
const EXIT_FALLBACK_MS = 10_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

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
      setTimeout(tick, 20);
    };
    tick();
  });
}

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

describe('PC-19 第二片：真实 SIGTERM 子进程（SQLite os.tmpdir 零 skip）', () => {
  const dirs = [];
  after(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  test('正常 SIGTERM：真实 main() 入口退出 0，重开 SQLite 读回末批累计', async () => {
    const dataDir = makeTmpDir('zr-pc19-sd-');
    dirs.push(dataDir);
    const port = await freePort();
    const child = spawn(process.execPath, ['--experimental-sqlite', CHILD_PATH], {
      env: {
        ...process.env,
        ZR_GATEWAY_PORT: String(port),
        ZR_GATEWAY_UDP_ALT_PORT: '0',
        ZR_GATEWAY_DATA_DIR: dataDir,
        ZR_GATEWAY_ADMIN_USER: 'pc19sd-admin@local',
        ZR_GATEWAY_ADMIN_PASSWORD: 'pc19sd-admin-pass',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = { stdout: '', stderr: '', fallbackKilled: false };
    child.stdout.on('data', (d) => { capture.stdout += d; });
    child.stderr.on('data', (d) => { capture.stderr += d; });

    const ready = await waitForReady(capture);
    child.kill('SIGTERM');
    const outcome = await waitForExit(child, capture);
    assert.equal(outcome.fallbackKilled, false, '正常关停必须在兜底 deadline 内自行退出');
    assert.equal(outcome.signal, null);
    assert.equal(outcome.code, 0, `stderr=${capture.stderr.slice(0, 400)}`);

    const reopened = new SqliteStore({ path: path.join(dataDir, 'gateway.sqlite') });
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
});
