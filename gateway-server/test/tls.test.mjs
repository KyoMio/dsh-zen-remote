// GT-1 + GT-2 consolidated TLS tests: TlsManager validation/bootstrap/fs.watch reload + DualProtocolServer single-port multiplexing & Fail-Closed startup.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';

import WebSocket from 'ws';

import { resolveGatewayConfig } from '../dist/config.js';
import { startGateway } from '../dist/main.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import { createDualProtocolServer, ZR_NATIVE_TLS_SYMBOL } from '../dist/tls/dual-protocol-server.js';
import {
  TlsConfigError,
  TlsManager,
  isSafeCertFilename,
  parseAndValidateCertPair,
} from '../dist/tls/tls-manager.js';
import { getTestTlsPair, makeTmpDir, waitFor } from './helpers/fixtures.mjs';

const TMP_ROOT = makeTmpDir('zr-tls-test-');
after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

let seq = 0;
function makeCertDir(name = 'certs') {
  seq += 1;
  const dir = path.join(TMP_ROOT, `${seq}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeFreshStore() {
  return new SqliteStore({
    seed: { allowSignup: false, maxNetworksPerUser: 3, defaultMaxPeers: 8, relayRateKbps: 1024 },
  });
}

function generateCustomCert({ cn = 'gw.test.local', san = 'DNS:gw.test.local,DNS:alt.test.local,IP:127.0.0.1', days = 30, passphrase } = {}) {
  const work = fs.mkdtempSync(path.join(TMP_ROOT, 'openssl-'));
  const confPath = path.join(work, 'ext.cnf');
  const keyPath = path.join(work, 'key.pem');
  const certPath = path.join(work, 'cert.pem');
  fs.writeFileSync(
    confPath,
    `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${cn}\n[v3]\nsubjectAltName=${san}\n`,
  );
  if (passphrase !== undefined) {
    execFileSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-aes-256-cbc', '-pass', `pass:${passphrase}`, '-out', keyPath], {
      stdio: 'ignore',
    });
    execFileSync(
      'openssl',
      ['req', '-x509', '-new', '-key', keyPath, '-passin', `pass:${passphrase}`, '-days', String(Math.max(1, Math.abs(days))), '-sha256', '-config', confPath, '-out', certPath],
      { stdio: 'ignore' },
    );
  } else {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(days < 0 ? 1 : days), '-sha256', '-config', confPath, '-keyout', keyPath, '-out', certPath],
      { stdio: 'ignore' },
    );
  }
  const certPem = fs.readFileSync(certPath, 'utf8');
  const keyPem = fs.readFileSync(keyPath, 'utf8');
  fs.rmSync(work, { recursive: true, force: true });
  return { certPem, keyPem };
}

function rawTcpHttp(port, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks = [];
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error('rawTcpHttp timeout'));
    });
    sock.on('error', reject);
    sock.once('connect', () => sock.end(payload));
    sock.on('data', (d) => chunks.push(d));
    sock.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function httpsGet(port, reqPath, certPem, agent) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, path: reqPath, method: 'GET', ca: certPem, agent },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('config.ts ZR_GATEWAY_CERT_DIR 解析', () => {
  test('默认解析为 <cwd>/certs，显式环境变量支持相对/绝对覆盖', () => {
    assert.equal(resolveGatewayConfig({}, '/srv/zr').certDir, path.resolve('/srv/zr', 'certs'));
    assert.equal(resolveGatewayConfig({ ZR_GATEWAY_CERT_DIR: '/certs' }, '/srv/zr').certDir, path.resolve('/srv/zr', '/certs'));
    assert.equal(resolveGatewayConfig({ ZR_GATEWAY_CERT_DIR: './custom-certs' }, '/srv/zr').certDir, path.resolve('/srv/zr', './custom-certs'));
  });
});

describe('TlsManager 校验、权限、路径越权与原子落盘（GT-1）', () => {
  test('文件名白名单拒绝路径穿越与非证书扩展名', () => {
    assert.equal(isSafeCertFilename('fullchain.pem'), true);
    assert.equal(isSafeCertFilename('my-site_01.crt'), true);
    assert.equal(isSafeCertFilename('privkey.key'), true);
    assert.equal(isSafeCertFilename('../secret.pem'), false);
    assert.equal(isSafeCertFilename('a/b.pem'), false);
    assert.equal(isSafeCertFilename('a\\b.pem'), false);
    assert.equal(isSafeCertFilename('.hidden.pem'), false);
    assert.equal(isSafeCertFilename('readme.txt'), false);
  });

  test('解析 X.509 摘要、预检加密私钥与不匹配私钥', () => {
    const shared = getTestTlsPair();
    const a = { certPem: shared.cert.toString('utf8'), keyPem: shared.key.toString('utf8') };
    const b = generateCustomCert({ cn: 'gateway.beta.local', days: 30 });
    const enc = generateCustomCert({ cn: 'enc.local', passphrase: 'secret-passphrase' });

    const parsed = parseAndValidateCertPair(a.certPem, a.keyPem);
    assert.ok(parsed.summary.subject.includes('localhost'));
    assert.deepEqual(parsed.summary.san, ['localhost', '127.0.0.1']);
    assert.equal(parsed.summary.expired, false);
    assert.equal(parsed.summary.expiringSoon, false);
    assert.ok(parsed.summary.fingerprint256.length > 10);

    const validToMs = Date.parse(parsed.summary.validTo);
    const soon = parseAndValidateCertPair(a.certPem, a.keyPem, validToMs - 5 * 24 * 60 * 60 * 1000);
    assert.equal(soon.summary.expiringSoon, true);
    assert.equal(soon.summary.expired, false);

    const expired = parseAndValidateCertPair(a.certPem, a.keyPem, validToMs + 1000);
    assert.equal(expired.summary.expired, true);
    assert.equal(expired.summary.expiringSoon, false);

    assert.throws(
      () => parseAndValidateCertPair(enc.certPem, enc.keyPem),
      (err) => err instanceof TlsConfigError && err.code === 'TLS_KEY_ENCRYPTED',
    );
    assert.throws(
      () => parseAndValidateCertPair(a.certPem, b.keyPem),
      (err) => err instanceof TlsConfigError && err.code === 'TLS_CERT_KEY_MISMATCH',
    );
    assert.throws(
      () => parseAndValidateCertPair('not a cert', a.keyPem),
      (err) => err instanceof TlsConfigError && err.code === 'TLS_CERT_INVALID',
    );
  });

  test('目录外 symlink 逃逸被 TLS_INVALID_FILENAME 拦截且不出现在扫描列表', async () => {
    const certDir = makeCertDir('symlink');
    const outsideDir = makeCertDir('outside');
    const shared = getTestTlsPair();
    const outCert = path.join(outsideDir, 'outside.pem');
    fs.writeFileSync(outCert, shared.cert);
    fs.writeFileSync(path.join(certDir, 'privkey.pem'), shared.key);
    fs.symlinkSync(outCert, path.join(certDir, 'escape.pem'));

    const mgr = new TlsManager({ certDir });
    const scan = await mgr.scanDirectory();
    assert.equal(scan.files.some((f) => f.name === 'escape.pem'), false);
    assert.equal(scan.files.some((f) => f.name === 'privkey.pem'), true);

    const store = makeFreshStore();
    try {
      await store.updateExtendedSettings({ tlsCertFile: 'escape.pem', tlsKeyFile: 'privkey.pem', tlsEnabled: true });
      await assert.rejects(
        mgr.bootstrap(store),
        (err) => err instanceof TlsConfigError && err.code === 'TLS_INVALID_FILENAME',
      );
    } finally {
      mgr.close();
      await store.close();
    }
  });

  test('原子写盘设定 cert 0644 / key 0600；只读目录报 TLS_CERT_DIR_READONLY', async () => {
    const certDir = makeCertDir('write-perms');
    const shared = getTestTlsPair();
    const certPem = shared.cert.toString('utf8');
    const keyPem = shared.key.toString('utf8');
    const store = makeFreshStore();
    const mgr = new TlsManager({ certDir });
    try {
      const view = await mgr.applyCertificateUpload(store, { certPem, keyPem, enableTls: true });
      assert.equal(view.enabled, true);
      assert.equal(view.tlsActive, true);
      assert.equal(view.certFile, 'fullchain.pem');
      assert.equal(view.keyFile, 'privkey.pem');

      assert.equal(fs.statSync(path.join(certDir, 'fullchain.pem')).mode & 0o777, 0o644);
      assert.equal(fs.statSync(path.join(certDir, 'privkey.pem')).mode & 0o777, 0o600);

      if (process.getuid?.() !== 0) {
        const roDir = makeCertDir('ro-dir');
        fs.chmodSync(roDir, 0o555);
        const roMgr = new TlsManager({ certDir: roDir });
        try {
          assert.equal((await roMgr.getStatus()).certDirWritable, false);
          await assert.rejects(
            roMgr.applyCertificateUpload(store, { certPem, keyPem }),
            (err) => err instanceof TlsConfigError && err.code === 'TLS_CERT_DIR_READONLY',
          );
        } finally {
          roMgr.close();
          fs.chmodSync(roDir, 0o755);
        }
      }
    } finally {
      mgr.close();
      await store.close();
    }
  });
});

describe('TlsManager 三态 bootstrap 与 fs.watch 续期热重载（GT-1）', () => {
  test('tlsEnabled=null 无证默认 HTTP；仅放一半缺私钥报错；放全默认证首次自动开 TLS 并落库', async () => {
    const shared = getTestTlsPair();
    const emptyDir = makeCertDir('empty');
    const s1 = makeFreshStore();
    const m1 = new TlsManager({ certDir: emptyDir });
    try {
      await m1.bootstrap(s1);
      assert.equal(m1.isEnabled(), false);
      assert.equal(m1.getSecureContext(), null);
      assert.equal((await s1.getExtendedSettings()).tlsEnabled, null);
    } finally {
      m1.close();
      await s1.close();
    }

    const halfDir = makeCertDir('half');
    fs.writeFileSync(path.join(halfDir, 'fullchain.pem'), shared.cert);
    const s2 = makeFreshStore();
    const m2 = new TlsManager({ certDir: halfDir });
    try {
      await assert.rejects(
        m2.bootstrap(s2),
        (err) => err instanceof TlsConfigError && err.code === 'TLS_KEY_MISSING',
      );
    } finally {
      m2.close();
      await s2.close();
    }

    const fullDir = makeCertDir('auto-enable');
    fs.writeFileSync(path.join(fullDir, 'fullchain.pem'), shared.cert);
    fs.writeFileSync(path.join(fullDir, 'privkey.pem'), shared.key);
    const s3 = makeFreshStore();
    const m3 = new TlsManager({ certDir: fullDir });
    try {
      await m3.bootstrap(s3);
      assert.equal(m3.isEnabled(), true);
      assert.notEqual(m3.getSecureContext(), null);
      assert.equal((await s3.getExtendedSettings()).tlsEnabled, true);
    } finally {
      m3.close();
      await s3.close();
    }
  });

  test('tlsEnabled=false 有证仍保持 HTTP 仅预览；tlsEnabled=true 缺证 Fail-Closed，仅过期证仍可启 HTTPS', async () => {
    const shared = getTestTlsPair();
    const dir = makeCertDir('tri-state');
    fs.writeFileSync(path.join(dir, 'fullchain.pem'), shared.cert);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), shared.key);

    const sOff = makeFreshStore();
    const mOff = new TlsManager({ certDir: dir });
    try {
      await sOff.updateExtendedSettings({ tlsEnabled: false });
      await mOff.bootstrap(sOff);
      assert.equal(mOff.isEnabled(), false);
      assert.equal(mOff.getSecureContext(), null);
      const st = await mOff.getStatus();
      assert.ok(st.activeCert?.subject.includes('localhost'));
    } finally {
      mOff.close();
      await sOff.close();
    }

    const parsed = parseAndValidateCertPair(shared.cert.toString('utf8'), shared.key.toString('utf8'));
    const futureMs = Date.parse(parsed.summary.validTo) + 60_000;
    const sExpired = makeFreshStore();
    const mExpired = new TlsManager({ certDir: dir, now: () => futureMs });
    try {
      await sExpired.updateExtendedSettings({ tlsEnabled: true });
      await mExpired.bootstrap(sExpired);
      assert.equal(mExpired.isEnabled(), true);
      assert.notEqual(mExpired.getSecureContext(), null);
      assert.equal(mExpired.getRuntimeFlags().activeCertExpired, true);
    } finally {
      mExpired.close();
      await sExpired.close();
    }

    fs.rmSync(path.join(dir, 'privkey.pem'));
    const sMissing = makeFreshStore();
    const mMissing = new TlsManager({ certDir: dir });
    try {
      await sMissing.updateExtendedSettings({ tlsEnabled: true });
      await assert.rejects(
        mMissing.bootstrap(sMissing),
        (err) => err instanceof TlsConfigError && err.code === 'TLS_KEY_MISSING',
      );
    } finally {
      mMissing.close();
      await sMissing.close();
    }
  });

  test('fs.watch 防抖、acme.sh 顺序写入重试恢复、彻底损坏保留旧上下文并挂 lastReloadError', async () => {
    const dir = makeCertDir('watch-reload');
    const pair1 = getTestTlsPair();
    const pair2 = generateCustomCert({ cn: 'v2.watch.local' });
    fs.writeFileSync(path.join(dir, 'fullchain.pem'), pair1.cert);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), pair1.key);

    const store = makeFreshStore();
    const contextUpdates = [];
    const reloadFailures = [];
    const mgr = new TlsManager({
      certDir: dir,
      debounceMs: 50,
      retryMs: 120,
      onContextChange: (next) => contextUpdates.push(next),
      onReloadFailed: (err) => reloadFailures.push(err),
    });
    try {
      await store.updateExtendedSettings({ tlsEnabled: true });
      await mgr.bootstrap(store);
      mgr.startWatching();
      const firstCtx = mgr.getSecureContext();

      // Write new cert first, then key 80ms later (initial mismatch recovers on retry).
      fs.writeFileSync(path.join(dir, 'fullchain.pem'), pair2.certPem);
      const timer = setTimeout(() => {
        fs.writeFileSync(path.join(dir, 'privkey.pem'), pair2.keyPem);
      }, 80);

      try {
        await waitFor(async () => {
          const st = await mgr.getStatus();
          return st.activeCert?.subject.includes('v2.watch.local') && st.lastReloadError === null && contextUpdates.length >= 1;
        }, 'v2 cert reloaded after retry', 3000);
      } finally {
        clearTimeout(timer);
      }
      const v2Ctx = mgr.getSecureContext();
      assert.notEqual(v2Ctx, firstCtx);

      fs.writeFileSync(path.join(dir, 'fullchain.pem'), 'corrupted-pem');
      await waitFor(async () => reloadFailures.length >= 1 && (await mgr.getStatus()).lastReloadError?.code === 'TLS_CERT_INVALID', 'corrupt cert reload failure', 3000);
      assert.equal(mgr.getSecureContext(), v2Ctx);
      assert.equal(mgr.getRuntimeFlags().reloadFailed, true);
    } finally {
      mgr.close();
      await store.close();
    }
  });
});

describe('DualProtocolServer 单端口双协议复用与热切换（GT-2）', () => {
  test('HTTP → HTTPS → HTTP 单端口在线热切换、302 重定向防 HSTS/开放跳转、API/WS 426', async () => {
    const shared = getTestTlsPair();
    const certPem = shared.cert.toString('utf8');
    const keyPem = shared.key.toString('utf8');
    const { secureContext } = parseAndValidateCertPair(certPem, keyPem);
    let releaseDelayed = null;

    const dual = createDualProtocolServer({
      initialMode: { enabled: false, secureContext: null },
      requestHandler: (req, res) => {
        if (req.url === '/slow') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('part1-');
          releaseDelayed = () => res.end('part2');
          return;
        }
        const nativeTls = Boolean(req.socket[ZR_NATIVE_TLS_SYMBOL]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url: req.url, nativeTls }));
      },
    });

    await new Promise((resolve, reject) => {
      dual.netServer.once('error', reject);
      dual.netServer.listen(0, '127.0.0.1', resolve);
    });
    const port = dual.httpServer.address().port;

    try {
      const plain = await fetch(`http://127.0.0.1:${port}/ping`);
      assert.equal(plain.status, 200);
      assert.deepEqual(await plain.json(), { ok: true, url: '/ping', nativeTls: false });

      const slowSocket = net.connect(port, '127.0.0.1');
      const slowChunks = [];
      await new Promise((resolve) => slowSocket.once('connect', resolve));
      slowSocket.write(`GET /slow HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
      slowSocket.on('data', (c) => slowChunks.push(c));
      await waitFor(() => releaseDelayed !== null, 'slow response started');

      dual.setMode({ enabled: true, secureContext });
      assert.equal(dual.isTlsEnabled(), true);

      releaseDelayed();
      const slowText = await new Promise((resolve) => {
        slowSocket.once('end', () => resolve(Buffer.concat(slowChunks).toString('utf8')));
      });
      assert.match(slowText, /part1-\r\n5\r\npart2\r\n0\r\n\r\n$/);

      const tlsAgent = new https.Agent({ keepAlive: false });
      const tlsRes = await httpsGet(port, '/ping', certPem, tlsAgent);
      assert.equal(tlsRes.status, 200);
      assert.deepEqual(JSON.parse(tlsRes.body), { ok: true, url: '/ping', nativeTls: true });

      const r302 = await rawTcpHttp(port, `GET /admin?tab=settings HTTP/1.1\r\nHost: gw.local:${port}\r\n\r\n`);
      assert.match(r302, /^HTTP\/1\.1 302 Found\r\n/);
      assert.match(r302, new RegExp(`Location: https://gw\\.local:${port}/admin\\?tab=settings\\r\\n`));
      assert.match(r302, /Cache-Control: no-store\r\n/);
      assert.doesNotMatch(r302, /Strict-Transport-Security/i);
      assert.doesNotMatch(r302, /301 Moved/i);

      const rSlash = await rawTcpHttp(port, `GET //evil.com/steal HTTP/1.1\r\nHost: gw.local:${port}\r\n\r\n`);
      assert.match(rSlash, /^HTTP\/1\.1 302 Found\r\n/);
      assert.match(rSlash, new RegExp(`Location: https://gw\\.local:${port}/evil\\.com/steal\\r\\n`));

      // T7: bare LF or control chars in path must not split 302 Location response headers
      const rInjected = await rawTcpHttp(port, `GET /ok\nSet-Cookie:evil=1 HTTP/1.1\r\nHost: gw.local:${port}\r\n\r\n`);
      assert.match(rInjected, /^HTTP\/1\.1 302 Found\r\n/);
      assert.match(rInjected, new RegExp(`Location: https://gw\\.local:${port}/\\r\\n`));
      assert.doesNotMatch(rInjected, /Set-Cookie:/i);

      const rBadHost = await rawTcpHttp(port, 'GET / HTTP/1.1\r\nHost: evil.com/bad\r\n\r\n');
      assert.match(rBadHost, /^HTTP\/1\.1 426 Upgrade Required\r\n/);

      for (const reqStr of [
        `GET /api/v1/auth/me HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
        `POST /auth/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\n\r\n`,
        `GET /peer/v1/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      ]) {
        const resRaw = await rawTcpHttp(port, reqStr);
        assert.match(resRaw, /^HTTP\/1\.1 426 Upgrade Required\r\n/);
        assert.match(resRaw, /"code":"TLS_REQUIRED"/);
      }

      dual.setMode({ enabled: false, secureContext: null });
      const backToPlain = await fetch(`http://127.0.0.1:${port}/ping2`);
      assert.equal(backToPlain.status, 200);
      assert.deepEqual(await backToPlain.json(), { ok: true, url: '/ping2', nativeTls: false });
    } finally {
      await dual.close();
    }
  });
});

describe('startGateway 三态 TLS 启动、wss:// 同口连接与 Fail-Closed（GT-2）', () => {
  test('首次带有效默认证书启动自动开启 HTTPS/wss://，删证重启 Fail-Closed 拒绝启动', async () => {
    const dataDir = makeCertDir('data');
    const certDir = makeCertDir('certs');
    const shared = getTestTlsPair();
    fs.writeFileSync(path.join(certDir, 'fullchain.pem'), shared.cert);
    fs.writeFileSync(path.join(certDir, 'privkey.pem'), shared.key);

    const baseCfg = {
      port: 0,
      udpAltPort: 0,
      publicUrl: undefined,
      dataDir,
      certDir,
      databaseUrl: undefined,
      adminUser: 'admin@local',
      adminPassword: 'admin-password-1',
      allowSignup: false,
      defaultMaxPeers: 8,
      maxNetworksPerUser: 3,
      relayRateKbps: 1024,
    };

    const gw = await startGateway(baseCfg);
    try {
      assert.equal(gw.tls.isEnabled(), true);
      assert.ok(gw.base.startsWith('https://'));

      const res = await httpsGet(gw.port, '/api/v1/auth/me', shared.cert);
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).ok, true);

      const challengeMsg = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${gw.port}/peer/v1/ws`, { ca: shared.cert });
        ws.once('error', reject);
        ws.once('message', (data) => {
          const obj = JSON.parse(data.toString('utf8'));
          ws.close();
          resolve(obj);
        });
      });
      assert.equal(challengeMsg.type, 'challenge');
      assert.ok(typeof challengeMsg.challengeHex === 'string' && challengeMsg.challengeHex.length > 0);
    } finally {
      await gw.close();
    }

    fs.rmSync(path.join(certDir, 'privkey.pem'));
    await assert.rejects(
      startGateway(baseCfg),
      (err) => err instanceof TlsConfigError && err.code === 'TLS_KEY_MISSING',
    );
  });
});
