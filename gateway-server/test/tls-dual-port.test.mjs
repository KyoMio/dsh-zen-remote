// GT-2 单元测试：单端口（19393/tcp）DualProtocolServer 协议复用、302/426 明文分流、
// 防开放重定向、热切换 keep-alive 退场、wss:// 同口入网及 startGateway 启动 Fail-Closed 闭环。
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import WebSocket from 'ws';

import { startGateway } from '../dist/main.js';
import { createDualProtocolServer, ZR_NATIVE_TLS_SYMBOL } from '../dist/tls/dual-protocol-server.js';
import { TlsConfigError, parseAndValidateCertPair } from '../dist/tls/tls-manager.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-tls-dual-test-'));

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

let seq = 0;
function makeDir(label) {
  seq += 1;
  const dir = path.join(TMP_ROOT, `${seq}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function generateCert(cn = '127.0.0.1') {
  const work = fs.mkdtempSync(path.join(TMP_ROOT, 'cert-'));
  const conf = path.join(work, 'c.cnf');
  const key = path.join(work, 'k.pem');
  const cert = path.join(work, 'c.pem');
  fs.writeFileSync(conf, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${cn}\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '10', '-sha256', '-config', conf, '-keyout', key, '-out', cert], {
    stdio: 'ignore',
  });
  const certPem = fs.readFileSync(cert, 'utf8');
  const keyPem = fs.readFileSync(key, 'utf8');
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
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: 'GET',
        ca: certPem,
        agent,
      },
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

describe('DualProtocolServer 单端口双协议复用与热切换（GT-2）', () => {
  test('HTTP → HTTPS → HTTP 单端口在线热切换、302 重定向防 HSTS/开放跳转、API/WS 426', async () => {
    const { certPem, keyPem } = generateCert();
    const { secureContext } = parseAndValidateCertPair(certPem, keyPem);
    let releaseDelayed = null;

    const dual = createDualProtocolServer({
      initialMode: { enabled: false, secureContext: null },
      requestHandler: (req, res) => {
        if (req.url === '/slow') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('part1-');
          releaseDelayed = () => {
            res.end('part2');
          };
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
      // 1) 明文初始模式：GET /ping 返回 nativeTls:false
      const plain = await fetch(`http://127.0.0.1:${port}/ping`);
      assert.equal(plain.status, 200);
      assert.deepEqual(await plain.json(), { ok: true, url: '/ping', nativeTls: false });

      // 2) 发起一个在途慢响应 keep-alive 请求，并在响应结束前热切为 TLS 模式
      const slowSocket = net.connect(port, '127.0.0.1');
      const slowChunks = [];
      await new Promise((resolve) => slowSocket.once('connect', resolve));
      slowSocket.write(`GET /slow HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
      slowSocket.on('data', (c) => slowChunks.push(c));
      await new Promise((resolve) => {
        const poll = () => (releaseDelayed !== null ? resolve() : setTimeout(poll, 10));
        poll();
      });

      dual.setMode({ enabled: true, secureContext });
      assert.equal(dual.isTlsEnabled(), true);

      // 放行在途响应并等待旧 keep-alive socket 自然收尾（不被粗暴截断）
      releaseDelayed();
      const slowText = await new Promise((resolve) => {
        slowSocket.once('end', () => resolve(Buffer.concat(slowChunks).toString('utf8')));
      });
      assert.match(slowText, /part1-\r\n5\r\npart2\r\n0\r\n\r\n$/);

      // 3) 同一端口 HTTPS 请求生效且带 ZR_NATIVE_TLS_SYMBOL
      const tlsAgent = new https.Agent({ keepAlive: false });
      const tlsRes = await httpsGet(port, '/ping', certPem, tlsAgent);
      assert.equal(tlsRes.status, 200);
      assert.deepEqual(JSON.parse(tlsRes.body), { ok: true, url: '/ping', nativeTls: true });

      // 4) 明文浏览器页面 GET → 302 + Cache-Control: no-store，绝不发 301/HSTS
      const r302 = await rawTcpHttp(port, `GET /admin?tab=settings HTTP/1.1\r\nHost: gw.local:${port}\r\n\r\n`);
      assert.match(r302, /^HTTP\/1\.1 302 Found\r\n/);
      assert.match(r302, new RegExp(`Location: https://gw\\.local:${port}/admin\\?tab=settings\\r\\n`));
      assert.match(r302, /Cache-Control: no-store\r\n/);
      assert.doesNotMatch(r302, /Strict-Transport-Security/i);
      assert.doesNotMatch(r302, /301 Moved/i);

      // 5) 防开放重定向：GET //evil.com 不得跳外站；非法 Host 拒为 426
      const rSlash = await rawTcpHttp(port, `GET //evil.com/steal HTTP/1.1\r\nHost: gw.local:${port}\r\n\r\n`);
      assert.match(rSlash, /^HTTP\/1\.1 302 Found\r\n/);
      assert.match(rSlash, new RegExp(`Location: https://gw\\.local:${port}/evil\\.com/steal\\r\\n`));

      const rBadHost = await rawTcpHttp(port, `GET / HTTP/1.1\r\nHost: evil.com/bad\r\n\r\n`);
      assert.match(rBadHost, /^HTTP\/1\.1 426 Upgrade Required\r\n/);

      // 6) 明文 /api/*、POST、明文 WS Upgrade 一律 426 TLS_REQUIRED
      for (const reqStr of [
        `GET /api/v1/auth/me HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
        `POST /auth/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\n\r\n`,
        `GET /peer/v1/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      ]) {
        const resRaw = await rawTcpHttp(port, reqStr);
        assert.match(resRaw, /^HTTP\/1\.1 426 Upgrade Required\r\n/);
        assert.match(resRaw, /"code":"TLS_REQUIRED"/);
      }

      // 7) 在线热切回 HTTP 模式，同一端口直接恢复明文 200
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
    const dataDir = makeDir('data');
    const certDir = makeDir('certs');
    const { certPem, keyPem } = generateCert('127.0.0.1');
    fs.writeFileSync(path.join(certDir, 'fullchain.pem'), certPem);
    fs.writeFileSync(path.join(certDir, 'privkey.pem'), keyPem);

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

      // 同一端口原生 HTTPS REST 可用
      const res = await httpsGet(gw.port, '/api/v1/auth/me', certPem);
      assert.equal(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.ok, true);

      // 同一端口 wss:// /peer/v1/ws 握手进入 PeerWsHub 协议 challenge 响应
      const challengeMsg = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${gw.port}/peer/v1/ws`, { ca: certPem });
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

    // 删掉私钥后再启同一实例（库中已记录 tls_enabled='true'）→ Fail-Closed 拒起且不漏句柄
    fs.rmSync(path.join(certDir, 'privkey.pem'));
    await assert.rejects(
      startGateway(baseCfg),
      (err) => err instanceof TlsConfigError && err.code === 'TLS_KEY_MISSING',
    );
  });
});
