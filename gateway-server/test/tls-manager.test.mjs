// GT-1 单元测试：ZR_GATEWAY_CERT_DIR 解析、X.509/私钥校验、路径越权拦截、
// 原子写盘权限、三态 bootstrap Fail-Closed 与 fs.watch 防抖/重试热重载。
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveGatewayConfig } from '../dist/config.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import {
  TlsConfigError,
  TlsManager,
  isSafeCertFilename,
  parseAndValidateCertPair,
} from '../dist/tls/tls-manager.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-tls-mgr-test-'));

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

/** 内存 openssl 生成测试用自签证书（可选 SAN / 过期天数 / 加密私钥） */
function generateSelfSignedCert({ cn = 'gw.test.local', san = 'DNS:gw.test.local,DNS:alt.test.local,IP:127.0.0.1', days = 30, passphrase } = {}) {
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

describe('config.ts ZR_GATEWAY_CERT_DIR 解析', () => {
  test('默认解析为 <cwd>/certs，显式环境变量支持相对/绝对覆盖', () => {
    const def = resolveGatewayConfig({}, '/srv/zr');
    assert.equal(def.certDir, path.resolve('/srv/zr', 'certs'));

    const abs = resolveGatewayConfig({ ZR_GATEWAY_CERT_DIR: '/certs' }, '/srv/zr');
    assert.equal(abs.certDir, path.resolve('/srv/zr', '/certs'));

    const rel = resolveGatewayConfig({ ZR_GATEWAY_CERT_DIR: './custom-certs' }, '/srv/zr');
    assert.equal(rel.certDir, path.resolve('/srv/zr', './custom-certs'));
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
    const a = generateSelfSignedCert({ cn: 'gateway.alpha.local', san: 'DNS:gateway.alpha.local,DNS:gw2.alpha.local,IP:127.0.0.1', days: 30 });
    const b = generateSelfSignedCert({ cn: 'gateway.beta.local', days: 30 });
    const enc = generateSelfSignedCert({ cn: 'enc.local', passphrase: 'secret-passphrase' });

    const parsed = parseAndValidateCertPair(a.certPem, a.keyPem);
    assert.ok(parsed.summary.subject.includes('gateway.alpha.local'));
    assert.deepEqual(parsed.summary.san, ['gateway.alpha.local', 'gw2.alpha.local', '127.0.0.1']);
    assert.equal(parsed.summary.expired, false);
    assert.equal(parsed.summary.expiringSoon, false);
    assert.ok(parsed.summary.fingerprint256.length > 10);

    // 未来时间模拟即将过期（14 天内）与已过期
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
    const pair = generateSelfSignedCert();
    const outCert = path.join(outsideDir, 'outside.pem');
    fs.writeFileSync(outCert, pair.certPem);
    fs.writeFileSync(path.join(certDir, 'privkey.pem'), pair.keyPem);
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
    const pair = generateSelfSignedCert();
    const store = makeFreshStore();
    const mgr = new TlsManager({ certDir });
    try {
      const view = await mgr.applyCertificateUpload(store, {
        certPem: pair.certPem,
        keyPem: pair.keyPem,
        enableTls: true,
      });
      assert.equal(view.enabled, true);
      assert.equal(view.tlsActive, true);
      assert.equal(view.certFile, 'fullchain.pem');
      assert.equal(view.keyFile, 'privkey.pem');

      const certMode = fs.statSync(path.join(certDir, 'fullchain.pem')).mode & 0o777;
      const keyMode = fs.statSync(path.join(certDir, 'privkey.pem')).mode & 0o777;
      assert.equal(certMode, 0o644);
      assert.equal(keyMode, 0o600);

      // 只读目录测试（root 进程会绕过 POSIX DAC，非 root 必触发 EACCES）
      if (process.getuid?.() !== 0) {
        const roDir = makeCertDir('ro-dir');
        fs.chmodSync(roDir, 0o555);
        const roMgr = new TlsManager({ certDir: roDir });
        try {
          const roStatus = await roMgr.getStatus();
          assert.equal(roStatus.certDirWritable, false);
          await assert.rejects(
            roMgr.applyCertificateUpload(store, { certPem: pair.certPem, keyPem: pair.keyPem }),
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
    // 1) 空目录 + tlsEnabled=null → 明文 HTTP 启动
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

    // 2) 半残默认目录（有 cert 无 key）+ tlsEnabled=null → 显式失败不静默降级
    const pair = generateSelfSignedCert();
    const halfDir = makeCertDir('half');
    fs.writeFileSync(path.join(halfDir, 'fullchain.pem'), pair.certPem);
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

    // 3) 默认证成对就绪 + tlsEnabled=null → 自动启用 TLS 且持久写回 tls_enabled='true'
    const fullDir = makeCertDir('auto-enable');
    fs.writeFileSync(path.join(fullDir, 'fullchain.pem'), pair.certPem);
    fs.writeFileSync(path.join(fullDir, 'privkey.pem'), pair.keyPem);
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
    const pair = generateSelfSignedCert({ cn: 'disabled-preview.local' });
    const dir = makeCertDir('tri-state');
    fs.writeFileSync(path.join(dir, 'fullchain.pem'), pair.certPem);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), pair.keyPem);

    // 显式 false：保持明文但可读出预览摘要
    const sOff = makeFreshStore();
    const mOff = new TlsManager({ certDir: dir });
    try {
      await sOff.updateExtendedSettings({ tlsEnabled: false });
      await mOff.bootstrap(sOff);
      assert.equal(mOff.isEnabled(), false);
      assert.equal(mOff.getSecureContext(), null);
      const st = await mOff.getStatus();
      assert.ok(st.activeCert?.subject.includes('disabled-preview.local'));
    } finally {
      mOff.close();
      await sOff.close();
    }

    // 显式 true + 证书过期（clock 注入到 validTo 之后）：允许启动 HTTPS 以便登录替换
    const parsed = parseAndValidateCertPair(pair.certPem, pair.keyPem);
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

    // 显式 true + 删掉私钥：Fail-Closed 启动失败
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
    const pair1 = generateSelfSignedCert({ cn: 'v1.watch.local' });
    const pair2 = generateSelfSignedCert({ cn: 'v2.watch.local' });
    fs.writeFileSync(path.join(dir, 'fullchain.pem'), pair1.certPem);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), pair1.keyPem);

    const store = makeFreshStore();
    const contextUpdates = [];
    const reloadFailures = [];
    // 测试期压缩防抖与重试窗口（80ms / 180ms）以加速 CI 并保持真实 fs.watch 语义
    const mgr = new TlsManager({
      certDir: dir,
      debounceMs: 80,
      retryMs: 180,
      onContextChange: (next) => contextUpdates.push(next),
      onReloadFailed: (err) => reloadFailures.push(err),
    });
    try {
      await store.updateExtendedSettings({ tlsEnabled: true });
      await mgr.bootstrap(store);
      mgr.startWatching();
      const firstCtx = mgr.getSecureContext();

      // 模拟外部续期先写新证书、120ms 后才写新私钥（首次重载暂态 mismatch，retry 后恢复）
      fs.writeFileSync(path.join(dir, 'fullchain.pem'), pair2.certPem);
      setTimeout(() => {
        fs.writeFileSync(path.join(dir, 'privkey.pem'), pair2.keyPem);
      }, 120);

      await new Promise((resolve) => setTimeout(resolve, 600));
      const statusAfterRetry = await mgr.getStatus();
      assert.ok(statusAfterRetry.activeCert?.subject.includes('v2.watch.local'));
      assert.equal(statusAfterRetry.lastReloadError, null);
      assert.ok(contextUpdates.length >= 1);
      const v2Ctx = mgr.getSecureContext();
      assert.notEqual(v2Ctx, firstCtx);

      // 写坏磁盘文件：重试仍失败时，必须保留内存中 v2Ctx 并记录 lastReloadError
      fs.writeFileSync(path.join(dir, 'fullchain.pem'), 'corrupted-pem');
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(mgr.getSecureContext(), v2Ctx);
      assert.ok(reloadFailures.length >= 1);
      const errStatus = await mgr.getStatus();
      assert.equal(errStatus.lastReloadError?.code, 'TLS_CERT_INVALID');
      assert.equal(mgr.getRuntimeFlags().reloadFailed, true);
    } finally {
      mgr.close();
      await store.close();
    }
  });
});
