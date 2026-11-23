import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { extractTarGzSafely, packTarGz } from '../dist/update/archive.js';
import {
  IdleAutoUpdateScheduler,
  UpdateManager,
  buildDownloadCandidates,
  createGatewayUpdateBridge,
  ensureReleasesNodeModulesLink,
  readReleaseState,
  writeReleaseState,
} from '../dist/update/update-manager.js';
import { UPDATE_RESTART_EXIT_CODE, runBootstrapSupervisor } from '../dist/bootstrap.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-update-test-'));
after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

let dirSeq = 0;
function makeExtractDir(label = 'extract') {
  dirSeq += 1;
  return path.join(TMP_ROOT, `${dirSeq}-${label}`);
}

/** Build a raw USTAR tar buffer with explicit header manipulation for malicious archive tests. */
function buildRawTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    nameBuf.copy(header, 0, 0, Math.min(nameBuf.length, 100));
    Buffer.from('0000644\0', 'ascii').copy(header, 100);
    Buffer.from('0000000\0', 'ascii').copy(header, 108);
    Buffer.from('0000000\0', 'ascii').copy(header, 116);
    const data = entry.data ? Buffer.from(entry.data) : Buffer.alloc(0);
    Buffer.from(data.length.toString(8).padStart(11, '0') + '\0', 'ascii').copy(header, 124);
    Buffer.from('00000000000\0', 'ascii').copy(header, 136);
    Buffer.from('        ', 'ascii').copy(header, 148);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.linkname) {
      const linkBuf = Buffer.from(entry.linkname, 'utf8');
      linkBuf.copy(header, 157, 0, Math.min(linkBuf.length, 100));
    }
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);
    if (entry.prefix) {
      const prefixBuf = Buffer.from(entry.prefix, 'utf8');
      prefixBuf.copy(header, 345, 0, Math.min(prefixBuf.length, 155));
    }
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i];
    Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
    blocks.push(header);
    if (data.length > 0) {
      const pad = (512 - (data.length % 512)) % 512;
      blocks.push(data);
      if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

describe('T1 USTAR archive codec', () => {
  test('round-trips nested directories, binary payloads, and long prefix+name paths deterministically', () => {
    const longDir = 'dist/nested/very-long-directory-segment-for-ustar-prefix-handling/' + 'sub/'.repeat(10);
    const longPath = `${longDir}deep-module-file-with-long-name-1234567890.js`;
    assert.ok(longPath.length > 100, 'path must exercise USTAR prefix splitting');

    const entries = [
      { path: 'package.json', data: '{"name":"gw","version":"0.2.0"}\n' },
      { path: 'dist/main.js', data: 'console.log("ok");\n', mode: 0o755 },
      { path: 'dist/public/assets/app.bin', data: Buffer.from([0, 1, 2, 255, 128, 42]) },
      { path: longPath, data: 'export const ok = true;\n' },
    ];

    const tgz1 = packTarGz(entries);
    const tgz2 = packTarGz([...entries].reverse());
    assert.deepEqual(tgz1, tgz2, 'packTarGz must be deterministic regardless of entry order');

    const dest = makeExtractDir('roundtrip');
    const result = extractTarGzSafely(tgz1, dest);
    assert.equal(result.files, 4);
    assert.equal(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'), '{"name":"gw","version":"0.2.0"}\n');
    assert.equal(fs.readFileSync(path.join(dest, 'dist/main.js'), 'utf8'), 'console.log("ok");\n');
    assert.deepEqual(fs.readFileSync(path.join(dest, 'dist/public/assets/app.bin')), Buffer.from([0, 1, 2, 255, 128, 42]));
    assert.equal(fs.readFileSync(path.join(dest, longPath), 'utf8'), 'export const ok = true;\n');
  });

  test('accepts safe directory type "5" entries and skips creating empty markers', () => {
    const tgz = buildRawTarGz([
      { name: 'dist/', type: '5' },
      { name: 'dist/hello.txt', type: '0', data: 'hello' },
    ]);
    const dest = makeExtractDir('dir-entry');
    const result = extractTarGzSafely(tgz, dest);
    assert.equal(result.files, 1);
    assert.equal(fs.readFileSync(path.join(dest, 'dist/hello.txt'), 'utf8'), 'hello');
  });

  test('rejects path traversal, absolute paths, symlinks, hardlinks, and device nodes with zero residue', () => {
    const badCases = [
      ['traversal', [{ name: 'ok.txt', data: 'safe' }, { name: '../evil.txt', data: 'pwn' }]],
      ['nested traversal', [{ name: 'dist/../../evil.txt', data: 'pwn' }]],
      ['absolute path', [{ name: '/etc/passwd', data: 'pwn' }]],
      ['backslash', [{ name: 'dist\\evil.txt', data: 'pwn' }]],
      ['symlink', [{ name: 'ok.txt', data: 'safe' }, { name: 'link', type: '2', linkname: '/etc/passwd' }]],
      ['hardlink', [{ name: 'hard', type: '1', linkname: 'ok.txt' }]],
      ['char device', [{ name: 'devnull', type: '3' }]],
    ];

    for (const [label, entries] of badCases) {
      const tgz = buildRawTarGz(entries);
      const dest = makeExtractDir(`bad-${label.replace(/\s+/g, '-')}`);
      assert.throws(() => extractTarGzSafely(tgz, dest), `expected rejection for ${label}`);
      assert.equal(fs.existsSync(dest), false, `${label}: targetDir must have zero residue on rejection`);
    }
  });

  test('rejects archives exceeding maxFiles or maxTotalBytes limits with zero residue', () => {
    const manyEntries = Array.from({ length: 6 }, (_, i) => ({ path: `f-${i}.txt`, data: 'x' }));
    const tgzMany = packTarGz(manyEntries);
    const destMany = makeExtractDir('too-many-files');
    assert.throws(() => extractTarGzSafely(tgzMany, destMany, { maxFiles: 5 }), /file/i);
    assert.equal(fs.existsSync(destMany), false);

    const bigTgz = packTarGz([
      { path: 'a.bin', data: Buffer.alloc(1024, 0x41) },
      { path: 'b.bin', data: Buffer.alloc(1024, 0x42) },
    ]);
    const destBig = makeExtractDir('too-big');
    assert.throws(() => extractTarGzSafely(bigTgz, destBig, { maxTotalBytes: 1500 }), /size|bytes|limit/i);
    assert.equal(fs.existsSync(destBig), false);

    // Decompression bomb guard: gzipped 4 MiB of zeros must be aborted by maxOutputLength when limit is small
    const bombTar = Buffer.alloc(4 * 1024 * 1024, 0);
    const bombGz = zlib.gzipSync(bombTar);
    const destBomb = makeExtractDir('bomb');
    assert.throws(() => extractTarGzSafely(bombGz, destBomb, { maxFiles: 5, maxTotalBytes: 4096 }));
    assert.equal(fs.existsSync(destBomb), false);
  });
});

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeGatewayBundle({
  version = '0.3.0',
  baseCompatEpoch = 1,
  minNodeMajor = 22,
  entryCode = 'if (process.argv.includes("--self-check")) process.exit(0);\n',
  includeHtml = true,
} = {}) {
  const manifest = {
    schemaVersion: 1,
    version,
    baseCompatEpoch,
    minNodeMajor,
    entry: 'dist/main.js',
    builtAt: '2026-11-18T00:00:00.000Z',
  };
  const entries = [
    { path: 'package.json', data: JSON.stringify({ name: '@dsh-zen-remote/gateway-server', version, type: 'module' }) },
    { path: 'release-manifest.json', data: JSON.stringify(manifest) },
    { path: 'dist/main.js', data: entryCode },
  ];
  if (includeHtml) {
    entries.push({ path: 'dist/public/index.html', data: '<!doctype html><html></html>\n' });
  }
  return packTarGz(entries);
}

async function startFakeReleaseServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('T3 UpdateManager', () => {
  test('buildDownloadCandidates 缺官方 sha256 时严格跳过所有第三方镜像', () => {
    const directUrl = 'https://github.com/KyoMio/dsh-zen-remote/releases/download/gateway-v0.3.0/zen-remote-gateway-bundle.tar.gz';
    const mirrors = ['https://gh-proxy.com/', 'https://ghfast.top/'];

    const withoutDigest = buildDownloadCandidates(directUrl, null, mirrors, true);
    assert.deepEqual(withoutDigest, [{ url: directUrl, mirrored: false }]);

    const withDigestPreferMirror = buildDownloadCandidates(directUrl, 'a'.repeat(64), mirrors, true);
    assert.equal(withDigestPreferMirror.length, 3);
    assert.equal(withDigestPreferMirror[0].mirrored, true);
    assert.equal(withDigestPreferMirror[2].mirrored, false);
  });

  test('① 篡改资产 sha256 被拒并清理临时文件；② 缺官方摘要时跳过镜像只走直连', async (t) => {
    const dataDir = makeExtractDir('t3-sha');
    const baseAppRoot = makeExtractDir('t3-base-1');
    fs.mkdirSync(path.join(baseAppRoot, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(baseAppRoot, 'package.json'), JSON.stringify({ version: '0.2.0' }));

    const realTgz = makeGatewayBundle({ version: '0.3.0' });
    const fakeTgz = makeGatewayBundle({ version: '0.3.0', entryCode: 'process.exit(1);\n' });
    let digestToAdvertise = `sha256:${sha256Hex(realTgz)}`;
    let serveTampered = true;
    const requestedUrls = [];

    const srv = await startFakeReleaseServer((req, res) => {
      requestedUrls.push(req.url);
      if (req.url === '/releases') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              tag_name: 'v2.6.0',
              draft: false,
              prerelease: false,
              assets: [],
            },
            {
              tag_name: 'gateway-v0.3.0',
              draft: false,
              prerelease: false,
              body: 'Hot update release',
              assets: [
                {
                  name: 'zen-remote-gateway-bundle.tar.gz',
                  browser_download_url: `${srv.base}/bundle.tar.gz`,
                  ...(digestToAdvertise !== null ? { digest: digestToAdvertise } : {}),
                },
              ],
            },
          ]),
        );
        return;
      }
      if (req.url === '/bundle.tar.gz' || req.url?.startsWith('/mirror/')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(serveTampered ? fakeTgz : realTgz);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    t.after(() => srv.close());

    const mgr = new UpdateManager({
      dataDir,
      baseAppRoot,
      currentVersion: '0.2.0',
      baseVersion: '0.2.0',
      releasesApiUrl: `${srv.base}/releases`,
      mirrorPrefixes: [`${srv.base}/mirror/`],
      preferMirror: true,
    });

    const check = await mgr.checkForUpdates();
    assert.equal(check.updateAvailable, true);
    assert.equal(check.latestVersion, '0.3.0');
    assert.equal(check.latestPluginVersion, '2.6.0');

    // Tampered payload rejected and .part temp file cleaned up
    await assert.rejects(() => mgr.prepareUpdate(), /sha256|digest|checksum/i);
    const downloadsDir = path.join(dataDir, 'releases', 'downloads');
    if (fs.existsSync(downloadsDir)) {
      assert.deepEqual(fs.readdirSync(downloadsDir), []);
    }

    // Missing official digest skips mirror candidate completely and only hits direct URL
    requestedUrls.length = 0;
    digestToAdvertise = null;
    serveTampered = false;
    await mgr.checkForUpdates();
    const res = await mgr.prepareUpdate();
    assert.equal(res.status, 'prepared');
    assert.ok(!requestedUrls.some((u) => u.startsWith('/mirror/')), 'must skip mirrors when official digest is absent');
    assert.ok(requestedUrls.includes('/bundle.tar.gz'));

    // Unreachable official API rejects without touching any mirror URL
    const mirrorHits = [];
    const mirrorOnlySrv = await startFakeReleaseServer((req, res) => {
      mirrorHits.push(req.url);
      res.writeHead(200);
      res.end();
    });
    t.after(() => mirrorOnlySrv.close());
    await srv.close();
    const mgrOffline = new UpdateManager({
      dataDir: makeExtractDir('t3-offline-api'),
      baseAppRoot,
      currentVersion: '0.2.0',
      baseVersion: '0.2.0',
      releasesApiUrl: `${srv.base}/releases`,
      mirrorPrefixes: [`${mirrorOnlySrv.base}/mirror/`],
      preferMirror: true,
    });
    await assert.rejects(() => mgrOffline.prepareUpdate());
    assert.equal(mirrorHits.length, 0);
  });

  test('③ baseCompatEpoch 或 minNodeMajor 超出返回 image-pull-required 且不写 state.json', async (t) => {
    const dataDir = makeExtractDir('t3-compat');
    const baseAppRoot = makeExtractDir('t3-base-2');
    fs.mkdirSync(path.join(baseAppRoot, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(baseAppRoot, 'package.json'), JSON.stringify({ version: '0.2.0' }));

    const tgzEpoch = makeGatewayBundle({ version: '0.3.0', baseCompatEpoch: 99 });
    const tgzNode = makeGatewayBundle({ version: '0.3.1', minNodeMajor: 999 });
    let activeTgz = tgzEpoch;
    let activeVer = '0.3.0';

    const srv = await startFakeReleaseServer((req, res) => {
      if (req.url === '/releases') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              tag_name: `gateway-v${activeVer}`,
              draft: false,
              prerelease: false,
              assets: [
                {
                  name: 'zen-remote-gateway-bundle.tar.gz',
                  browser_download_url: `${srv.base}/bundle.tar.gz`,
                  digest: `sha256:${sha256Hex(activeTgz)}`,
                },
              ],
            },
          ]),
        );
        return;
      }
      if (req.url === '/bundle.tar.gz') {
        res.writeHead(200);
        res.end(activeTgz);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    t.after(() => srv.close());

    const mgr = new UpdateManager({
      dataDir,
      baseAppRoot,
      currentVersion: '0.2.0',
      baseVersion: '0.2.0',
      releasesApiUrl: `${srv.base}/releases`,
      mirrorPrefixes: [],
    });

    await mgr.checkForUpdates();
    const res1 = await mgr.prepareUpdate();
    assert.equal(res1.status, 'image-pull-required');
    assert.equal(fs.existsSync(path.join(dataDir, 'releases', 'state.json')), false);

    activeTgz = tgzNode;
    activeVer = '0.3.1';
    await mgr.checkForUpdates();
    const res2 = await mgr.prepareUpdate();
    assert.equal(res2.status, 'image-pull-required');
    assert.equal(fs.existsSync(path.join(dataDir, 'releases', 'state.json')), false);
  });

  test('④ 损坏入口 --self-check 失败中止切换且原 activeVersion 不变；⑤ 成功准备写入 state.json 并建 node_modules 链接、保留两代', async (t) => {
    const dataDir = makeExtractDir('t3-selfcheck');
    const baseAppRoot = makeExtractDir('t3-base-3');
    fs.mkdirSync(path.join(baseAppRoot, 'node_modules', 'dummy-dep'), { recursive: true });
    fs.writeFileSync(path.join(baseAppRoot, 'node_modules', 'dummy-dep', 'index.js'), 'export const dep = 42;\n');
    fs.writeFileSync(path.join(baseAppRoot, 'package.json'), JSON.stringify({ version: '0.2.0' }));

    // Bundle that actually imports from node_modules via ESM upward resolution during --self-check!
    const goodCode = (ver) =>
      `import { dep } from 'dummy-dep/index.js';\nif (dep !== 42) process.exit(2);\nif (process.argv.includes('--self-check')) process.exit(0);\n`;

    const badTgz = makeGatewayBundle({ version: '0.3.0', entryCode: 'process.exit(1);\n' });
    const goodTgz1 = makeGatewayBundle({ version: '0.3.0', entryCode: goodCode('0.3.0') });
    const goodTgz2 = makeGatewayBundle({ version: '0.4.0', entryCode: goodCode('0.4.0') });
    const goodTgz3 = makeGatewayBundle({ version: '0.5.0', entryCode: goodCode('0.5.0') });

    let currentTag = '0.3.0';
    let currentTgz = badTgz;

    const srv = await startFakeReleaseServer((req, res) => {
      if (req.url === '/releases') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              tag_name: `gateway-v${currentTag}`,
              draft: false,
              prerelease: false,
              assets: [
                {
                  name: 'zen-remote-gateway-bundle.tar.gz',
                  browser_download_url: `${srv.base}/bundle.tar.gz`,
                  digest: `sha256:${sha256Hex(currentTgz)}`,
                },
              ],
            },
          ]),
        );
        return;
      }
      if (req.url === '/bundle.tar.gz') {
        res.writeHead(200);
        res.end(currentTgz);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    t.after(() => srv.close());

    const mgr = new UpdateManager({
      dataDir,
      baseAppRoot,
      currentVersion: '0.2.0',
      baseVersion: '0.2.0',
      releasesApiUrl: `${srv.base}/releases`,
      mirrorPrefixes: [],
    });

    // Broken entry fails --self-check -> throws, staging cleaned, no state.json
    await mgr.checkForUpdates();
    await assert.rejects(() => mgr.prepareUpdate(), /self-check/i);
    assert.equal(fs.existsSync(path.join(dataDir, 'releases', 'state.json')), false);

    // Good 0.3.0 succeeds (resolving dummy-dep via node_modules junction!)
    currentTgz = goodTgz1;
    await mgr.checkForUpdates();
    const ok1 = await mgr.prepareUpdate();
    assert.equal(ok1.status, 'prepared');
    const linkStat = fs.lstatSync(path.join(dataDir, 'releases', 'node_modules'));
    assert.equal(linkStat.isSymbolicLink(), true);
    const state1 = JSON.parse(fs.readFileSync(path.join(dataDir, 'releases', 'state.json'), 'utf8'));
    assert.equal(state1.activeVersion, '0.3.0');
    assert.equal(state1.previousVersion, '0.2.0');
    assert.equal(state1.pendingVerify, true);

    // Upgrade to 0.4.0 then 0.5.0 -> versions/ prunes 0.3.0 keeping only 0.4.0 (previous) and 0.5.0 (active)
    const mgr2 = new UpdateManager({
      dataDir,
      baseAppRoot,
      currentVersion: '0.3.0',
      baseVersion: '0.2.0',
      releasesApiUrl: `${srv.base}/releases`,
      mirrorPrefixes: [],
    });
    currentTag = '0.4.0';
    currentTgz = goodTgz2;
    await mgr2.checkForUpdates();
    await mgr2.prepareUpdate();

    const mgr3 = new UpdateManager({
      dataDir,
      baseAppRoot,
      currentVersion: '0.4.0',
      baseVersion: '0.2.0',
      releasesApiUrl: `${srv.base}/releases`,
      mirrorPrefixes: [],
    });
    currentTag = '0.5.0';
    currentTgz = goodTgz3;
    await mgr3.checkForUpdates();
    await mgr3.prepareUpdate();

    const keptDirs = fs.readdirSync(path.join(dataDir, 'releases', 'versions')).sort();
    assert.deepEqual(keptDirs, ['0.4.0', '0.5.0']);
  });
});

async function waitForFile(filePath, predicate = () => true, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (predicate(content)) return content;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`waitForFile timeout: ${filePath}`);
}

describe('T4 bootstrap supervisor & pack-release', () => {
  test('1) 退出码 75 秒级热切到新版本且父进程不退出；2) 超时(120ms)与崩溃自动回滚并写 lastRollback', async () => {
    const dataDir = makeExtractDir('t4-sup-data');
    const baseAppDir = makeExtractDir('t4-sup-base');
    fs.mkdirSync(path.join(baseAppDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(baseAppDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(baseAppDir, 'package.json'), JSON.stringify({ type: 'module', version: '0.2.0' }));

    const logFile = path.join(dataDir, 'events.log');
    // Fake base gateway: logs boot, sends ready, if trigger file exists exits 75 after staging update;
    // when started a second time (after rollback) logs rollback recovery and exits on SIGTERM.
    const baseMain = `
      import fs from 'node:fs';
      import path from 'node:path';
      const dataDir = process.env.ZR_GATEWAY_DATA_DIR;
      const logFile = path.join(dataDir, 'events.log');
      fs.appendFileSync(logFile, 'boot:base:' + process.env.ZR_GATEWAY_ACTIVE_SOURCE + '\\n');
      process.send?.({ type: 'zr-gateway-ready', version: '0.2.0' });
      const trigger = path.join(dataDir, 'switch-to-0.3.0');
      const iv = setInterval(() => {
        if (fs.existsSync(trigger)) {
          fs.rmSync(trigger, { force: true });
          clearInterval(iv);
          process.exit(${UPDATE_RESTART_EXIT_CODE});
        }
      }, 15);
      process.on('SIGTERM', () => { clearInterval(iv); process.exit(0); });
      process.on('message', (m) => { if (m?.type === 'zr-shutdown') { clearInterval(iv); process.exit(0); } });
    `;
    fs.writeFileSync(path.join(baseAppDir, 'dist', 'main.js'), baseMain);

    // Stage 0.3.0 (healthy) and 0.4.0 (hangs without ready) and 0.5.0 (crashes exit 1)
    const ver030Dir = path.join(dataDir, 'releases', 'versions', '0.3.0', 'dist');
    fs.mkdirSync(ver030Dir, { recursive: true });
    fs.writeFileSync(
      path.join(ver030Dir, 'main.js'),
      `
      import fs from 'node:fs';
      import path from 'node:path';
      const dataDir = process.env.ZR_GATEWAY_DATA_DIR;
      fs.appendFileSync(path.join(dataDir, 'events.log'), 'boot:0.3.0:' + process.env.ZR_GATEWAY_ACTIVE_SOURCE + '\\n');
      process.send?.({ type: 'zr-gateway-ready', version: '0.3.0' });
      const triggerBad = path.join(dataDir, 'switch-to-0.4.0');
      const iv = setInterval(() => {
        if (fs.existsSync(triggerBad)) {
          fs.rmSync(triggerBad, { force: true });
          clearInterval(iv);
          process.exit(${UPDATE_RESTART_EXIT_CODE});
        }
      }, 15);
      process.on('SIGTERM', () => { clearInterval(iv); process.exit(0); });
      process.on('message', (m) => { if (m?.type === 'zr-shutdown') { clearInterval(iv); process.exit(0); } });
      `,
    );

    const ver040Dir = path.join(dataDir, 'releases', 'versions', '0.4.0', 'dist');
    fs.mkdirSync(ver040Dir, { recursive: true });
    fs.writeFileSync(
      path.join(ver040Dir, 'main.js'),
      `
      import fs from 'node:fs';
      import path from 'node:path';
      const dataDir = process.env.ZR_GATEWAY_DATA_DIR;
      fs.appendFileSync(path.join(dataDir, 'events.log'), 'boot:0.4.0:hang\\n');
      setInterval(() => {}, 1000);
      `,
    );

    const ver050Dir = path.join(dataDir, 'releases', 'versions', '0.5.0', 'dist');
    fs.mkdirSync(ver050Dir, { recursive: true });
    fs.writeFileSync(
      path.join(ver050Dir, 'main.js'),
      `
      import fs from 'node:fs';
      import path from 'node:path';
      const dataDir = process.env.ZR_GATEWAY_DATA_DIR;
      fs.appendFileSync(path.join(dataDir, 'events.log'), 'boot:0.5.0:crash\\n');
      process.exit(1);
      `,
    );

    const signalTarget = new EventEmitter();
    const supPromise = runBootstrapSupervisor({
      dataDir,
      baseAppDir,
      verifyTimeoutMs: 120,
      signalTarget,
      env: { ...process.env, ZR_GATEWAY_DATA_DIR: dataDir },
    });

    // Wait for base 0.2.0 boot
    await waitForFile(logFile, (c) => c.includes('boot:base:base'));

    // Prepare 0.3.0 in state.json and trigger exit 75
    writeReleaseState(dataDir, {
      activeVersion: '0.3.0',
      activeEntry: 'versions/0.3.0/dist/main.js',
      previousVersion: '0.2.0',
      previousEntry: null,
      pendingVerify: true,
      baseVersionSeen: '0.2.0',
      lastRollback: null,
    });
    fs.writeFileSync(path.join(dataDir, 'switch-to-0.3.0'), '1');

    // Supervisor switches without exiting and clears pendingVerify once 0.3.0 sends ready
    await waitForFile(logFile, (c) => c.includes('boot:0.3.0:hot-update'));
    await new Promise((r) => setTimeout(r, 40));
    const after030 = readReleaseState(dataDir);
    assert.equal(after030.pendingVerify, false);
    assert.equal(after030.activeVersion, '0.3.0');

    // Switch to hanging 0.4.0 -> verifyTimeoutMs (120ms) triggers rollback to 0.3.0
    writeReleaseState(dataDir, {
      activeVersion: '0.4.0',
      activeEntry: 'versions/0.4.0/dist/main.js',
      previousVersion: '0.3.0',
      previousEntry: 'versions/0.3.0/dist/main.js',
      pendingVerify: true,
      baseVersionSeen: '0.2.0',
      lastRollback: null,
    });
    fs.writeFileSync(path.join(dataDir, 'switch-to-0.4.0'), '1');

    await waitForFile(logFile, (c) => {
      const lines = c.trim().split('\n');
      return lines.includes('boot:0.4.0:hang') && lines.filter((l) => l === 'boot:0.3.0:hot-update').length >= 2;
    });
    const afterTimeoutRb = readReleaseState(dataDir);
    assert.equal(afterTimeoutRb.activeVersion, '0.3.0');
    assert.equal(afterTimeoutRb.pendingVerify, false);
    assert.equal(afterTimeoutRb.lastRollback?.failedVersion, '0.4.0');
    assert.equal(afterTimeoutRb.lastRollback?.rolledBackTo, '0.3.0');

    // Also verify immediate crash (exit 1) triggers rollback to 0.3.0
    writeReleaseState(dataDir, {
      activeVersion: '0.5.0',
      activeEntry: 'versions/0.5.0/dist/main.js',
      previousVersion: '0.3.0',
      previousEntry: 'versions/0.3.0/dist/main.js',
      pendingVerify: true,
      baseVersionSeen: '0.2.0',
      lastRollback: null,
    });
    fs.writeFileSync(path.join(dataDir, 'switch-to-0.4.0'), '1');
    await waitForFile(logFile, (c) => {
      const lines = c.trim().split('\n');
      return lines.includes('boot:0.5.0:crash') && lines.filter((l) => l === 'boot:0.3.0:hot-update').length >= 3;
    });
    const afterCrashRb = readReleaseState(dataDir);
    assert.equal(afterCrashRb.activeVersion, '0.3.0');
    assert.equal(afterCrashRb.lastRollback?.failedVersion, '0.5.0');

    signalTarget.emit('SIGTERM');
    const exitCode = await supPromise;
    assert.equal(exitCode, 0);
  });

  test('3) 镜像升级后 baseVersion >= activeVersion 时「谁新跑谁」自动切回基础镜像', async () => {
    const dataDir = makeExtractDir('t4-newer-base-data');
    const baseAppDir = makeExtractDir('t4-newer-base-app');
    fs.mkdirSync(path.join(baseAppDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(baseAppDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(baseAppDir, 'package.json'), JSON.stringify({ type: 'module', version: '0.4.0' }));
    fs.writeFileSync(
      path.join(baseAppDir, 'dist', 'main.js'),
      `
      import fs from 'node:fs';
      import path from 'node:path';
      const dataDir = process.env.ZR_GATEWAY_DATA_DIR;
      fs.writeFileSync(path.join(dataDir, 'ran.txt'), process.env.ZR_GATEWAY_ACTIVE_SOURCE + ':' + process.env.ZR_GATEWAY_BASE_VERSION);
      process.send?.({ type: 'zr-gateway-ready', version: '0.4.0' });
      process.on('SIGTERM', () => process.exit(0));
      process.on('message', (m) => { if (m?.type === 'zr-shutdown') process.exit(0); });
      `,
    );

    const oldHotDir = path.join(dataDir, 'releases', 'versions', '0.3.0', 'dist');
    fs.mkdirSync(oldHotDir, { recursive: true });
    fs.writeFileSync(path.join(oldHotDir, 'main.js'), 'process.exit(99);\n');
    writeReleaseState(dataDir, {
      activeVersion: '0.3.0',
      activeEntry: 'versions/0.3.0/dist/main.js',
      previousVersion: '0.2.0',
      previousEntry: null,
      pendingVerify: true,
      baseVersionSeen: '0.2.0',
      lastRollback: null,
    });

    const signalTarget = new EventEmitter();
    const supPromise = runBootstrapSupervisor({
      dataDir,
      baseAppDir,
      verifyTimeoutMs: 120,
      signalTarget,
      env: { ...process.env, ZR_GATEWAY_DATA_DIR: dataDir },
    });

    const ran = await waitForFile(path.join(dataDir, 'ran.txt'));
    assert.equal(ran, 'base:0.4.0');
    const state = readReleaseState(dataDir);
    assert.equal(state.activeVersion, null);
    assert.equal(state.pendingVerify, false);
    assert.equal(state.baseVersionSeen, '0.4.0');

    signalTarget.emit('SIGTERM');
    assert.equal(await supPromise, 0);
  });

  test('4) pack-release.mjs 产物可被 extractTarGzSafely 解包并通过 dist/main.js --self-check', () => {
    const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const outDir = makeExtractDir('t4-pack-out');
    const outBundle = path.join(outDir, 'zen-remote-gateway-bundle.tar.gz');
    execFileSync(process.execPath, [path.join(gatewayRoot, 'scripts', 'pack-release.mjs'), '--out', outBundle], {
      cwd: gatewayRoot,
      stdio: 'pipe',
    });
    assert.equal(fs.existsSync(outBundle), true);

    const extractRoot = makeExtractDir('t4-pack-extract');
    const stagedDir = path.join(extractRoot, 'releases', 'versions', '0.2.0');
    ensureReleasesNodeModulesLink(extractRoot, gatewayRoot);
    extractTarGzSafely(fs.readFileSync(outBundle), stagedDir);

    const manifest = JSON.parse(fs.readFileSync(path.join(stagedDir, 'release-manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.entry, 'dist/main.js');
    assert.equal(fs.existsSync(path.join(stagedDir, 'dist', 'public', 'index.html')), true);

    execFileSync(process.execPath, ['--experimental-sqlite', path.join(stagedDir, 'dist', 'main.js'), '--self-check'], {
      stdio: 'pipe',
    });
  });
});

describe('T5 IdleAutoUpdateScheduler', () => {
  test('仅在 supervisorManaged && autoUpdateEnabled 且连续两次 totalLiveRelayKbps === 0 时自动更新并重启；存在中转速率时顺延', async (t) => {
    const dataDir = makeExtractDir('t5-idle-data');
    const baseAppRoot = makeExtractDir('t5-idle-base');
    fs.mkdirSync(path.join(baseAppRoot, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(baseAppRoot, 'package.json'), JSON.stringify({ type: 'module', version: '0.2.0' }));

    const goodTgz = makeGatewayBundle({ version: '0.3.0' });
    const srv = await startFakeReleaseServer((req, res) => {
      if (req.url === '/releases') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              tag_name: 'gateway-v0.3.0',
              draft: false,
              prerelease: false,
              assets: [
                {
                  name: 'zen-remote-gateway-bundle.tar.gz',
                  browser_download_url: `${srv.base}/bundle.tar.gz`,
                  digest: `sha256:${sha256Hex(goodTgz)}`,
                },
              ],
            },
          ]),
        );
        return;
      }
      if (req.url === '/bundle.tar.gz') {
        res.writeHead(200);
        res.end(goodTgz);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    t.after(() => srv.close());

    const mgr = new UpdateManager({
      dataDir,
      baseAppRoot,
      currentVersion: '0.2.0',
      baseVersion: '0.2.0',
      releasesApiUrl: `${srv.base}/releases`,
      mirrorPrefixes: [],
    });

    let liveKbps = 12;
    let autoEnabled = true;
    let restarts = 0;

    const scheduler = new IdleAutoUpdateScheduler({
      updateManager: mgr,
      supervisorManaged: true,
      isAutoUpdateEnabled: async () => autoEnabled,
      getTotalLiveRelayKbps: () => liveKbps,
      onRestart: () => {
        restarts += 1;
      },
      idleConfirmDelayMs: 25,
    });
    t.after(() => scheduler.stop());

    // Active relay traffic -> deferred!
    const busyOutcome = await scheduler.runOnce();
    assert.equal(busyOutcome, 'deferred-busy');
    assert.equal(restarts, 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'releases', 'state.json')), false);

    // Disabled -> skipped!
    liveKbps = 0;
    autoEnabled = false;
    const disabledOutcome = await scheduler.runOnce();
    assert.equal(disabledOutcome, 'skipped-disabled');
    assert.equal(restarts, 0);

    // Enabled & idle twice -> prepares and triggers restart!
    autoEnabled = true;
    const okOutcome = await scheduler.runOnce();
    assert.equal(okOutcome, 'applied');
    assert.equal(restarts, 1);
    const st = readReleaseState(dataDir);
    assert.equal(st.activeVersion, '0.3.0');
    assert.equal(st.pendingVerify, true);
  });

  test('start() 按 initialDelayMs 触发首轮检查；stop() 可取消未触发的 initialTimer', async (t) => {
    const dataDir1 = makeExtractDir('t5-init-data-1');
    const baseAppRoot = makeExtractDir('t5-init-base');
    fs.mkdirSync(path.join(baseAppRoot, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(baseAppRoot, 'package.json'), JSON.stringify({ type: 'module', version: '0.2.0' }));

    let releaseCalls = 0;
    const srv = await startFakeReleaseServer((req, res) => {
      if (req.url === '/releases') {
        releaseCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ tag_name: 'gateway-v0.2.0', draft: false, prerelease: false, assets: [] }]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    t.after(() => srv.close());

    const mgr1 = new UpdateManager({
      dataDir: dataDir1,
      baseAppRoot,
      currentVersion: '0.2.0',
      baseVersion: '0.2.0',
      releasesApiUrl: `${srv.base}/releases`,
      mirrorPrefixes: [],
    });

    const scheduler1 = new IdleAutoUpdateScheduler({
      updateManager: mgr1,
      supervisorManaged: true,
      isAutoUpdateEnabled: () => true,
      getTotalLiveRelayKbps: () => 0,
      onRestart: () => {},
      initialDelayMs: 25,
      checkIntervalMs: 60_000,
    });
    t.after(() => scheduler1.stop());
    scheduler1.start();

    const deadline = Date.now() + 1500;
    while (releaseCalls === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(releaseCalls >= 1, true, 'initialTimer fires initial check after initialDelayMs');
    assert.notEqual(mgr1.getLastCheckedAt(), null);

    // Second scheduler stopped before initialDelayMs must cancel initialTimer
    const beforeCalls = releaseCalls;
    const scheduler2 = new IdleAutoUpdateScheduler({
      updateManager: mgr1,
      supervisorManaged: true,
      isAutoUpdateEnabled: () => true,
      getTotalLiveRelayKbps: () => 0,
      onRestart: () => {},
      initialDelayMs: 50,
      checkIntervalMs: 60_000,
    });
    scheduler2.start();
    scheduler2.stop();
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(releaseCalls, beforeCalls, 'stop() cancels pending initialTimer');
  });

  test('Task 6: createGatewayUpdateBridge#getRuntimeSummary filters offlinePeerRecommendedVersion against currentVersion and latestRelease', () => {
    let currentVersion = '0.2.0';
    let latestRelease = null;
    let observed = null;

    const fakeManager = {
      getState: () => ({
        activeVersion: currentVersion,
        activeEntry: null,
        previousVersion: null,
        previousEntry: null,
        pendingVerify: false,
        baseVersionSeen: '0.2.0',
        lastRollback: null,
      }),
      getCurrentVersion: () => currentVersion,
      getBaseVersion: () => '0.2.0',
      getLatestRelease: () => latestRelease,
      getLatestPluginVersion: () => null,
      getCompatibilityForLatest: () => ({ compatibility: 'compatible', reason: null }),
      isUpdateAvailable: () => latestRelease !== null && currentVersion !== null && latestRelease.version > currentVersion,
      getLastCheckedAt: () => null,
      getLastCheckError: () => null,
      checkForUpdates: async () => {},
      prepareUpdate: async () => ({ status: 'up-to-date', version: currentVersion }),
    };

    const bridge = createGatewayUpdateBridge({
      updateManager: fakeManager,
      supervisorManaged: false,
      activeSource: 'base',
      getOfflinePeerRecommendedVersion: () => observed,
    });

    // 1. observed < current -> null
    currentVersion = '0.2.1';
    observed = '0.2.0';
    assert.equal(bridge.getRuntimeSummary(false).offlinePeerRecommendedVersion, null);

    // 2. observed === current -> null
    observed = '0.2.1';
    assert.equal(bridge.getRuntimeSummary(false).offlinePeerRecommendedVersion, null);

    // 3. observed > current and no latestRelease -> returns observed
    currentVersion = '0.2.0';
    observed = '0.2.1';
    assert.equal(bridge.getRuntimeSummary(false).offlinePeerRecommendedVersion, '0.2.1');

    // 4. latestRelease >= observed -> superseded -> null
    latestRelease = { version: '0.2.1', tagName: 'gateway-v0.2.1', downloadUrl: 'https://example/gw.tgz', sha256: null, notesSummary: null, publishedAt: null };
    assert.equal(bridge.getRuntimeSummary(false).offlinePeerRecommendedVersion, null);

    // 5. observed > latestRelease -> returns observed
    observed = '0.2.2';
    assert.equal(bridge.getRuntimeSummary(false).offlinePeerRecommendedVersion, '0.2.2');

    // 6. currentVersion === null -> null
    currentVersion = null;
    assert.equal(bridge.getRuntimeSummary(false).offlinePeerRecommendedVersion, null);
  });
});
