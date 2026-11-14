// GC-4 SMTP 客户端测试：真实回环 TCP / TLS mock SMTP 服务端（127.0.0.1:0）。
// TLS 测试证书用本机 openssl req -x509 生成，只经 stdout 进内存，不落任何临时文件。
// 测试文件为 .mjs，直接 import 编译产物 ../dist/，避免 Node 22 的 .ts strip 差异。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';

import { sendMail, SmtpClientError } from '../dist/mail/smtp-client.js';
import { renderOtpEmail, renderSmtpTestEmail } from '../dist/mail/templates.js';

const HOST = '127.0.0.1';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------- openssl 测试证书（stdout 直进内存）

let testCertCache; // undefined = 未生成；null = 生成失败
function getTestCert() {
  if (testCertCache !== undefined) return testCertCache;
  try {
    const out = execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-sha256', '-subj', '/CN=127.0.0.1', '-keyout', '/dev/stdout', '-out', '/dev/stdout'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const pem = out.toString('utf8');
    const key = /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/.exec(pem)?.[0];
    const cert = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(pem)?.[0];
    testCertCache = key && cert ? { key, cert } : null;
  } catch {
    testCertCache = null;
  }
  return testCertCache;
}

// ---------------------------------------------------------------- mock SMTP 服务端

/**
 * options:
 *   security    'plain' | 'tls' | 'starttls'（mock 在收到 STARTTLS 命令时升级服务端 TLS）
 *   advertiseStarttls 是否在 EHLO 里广告 STARTTLS 能力（可单独关掉测「不广告」分支）
 *   stallAfterStarttls 收到 STARTTLS 只回 220 然后彻底沉默：客户端 TLS 握手超时的靶子
 *   authLine    EHLO 里的 AUTH 能力行，如 'AUTH PLAIN LOGIN'；null 表示不广告 AUTH
 *   username / password  mock 校验用的正确凭据
 */
function createMockSmtp(options = {}) {
  const opts = {
    security: 'plain',
    advertiseStarttls: undefined, // 默认跟随 security === 'starttls'
    stallAfterStarttls: false,
    authLine: 'AUTH PLAIN LOGIN',
    username: 'mailer@gateway.local',
    password: 'smtp-test-pass',
    ...options,
  };

  const state = {
    commands: [], // 收到的每一条命令行（含 AUTH 参数行与 DATA 内的行不在此列）
    dataPayload: null, // 原始 payload（剥掉 CRLF.CRLF 终止符、保留正文尾 CRLF）
    quit: false,
    tlsUpgraded: false,
    openSockets: new Set(),
    idleWaiters: [],
  };

  const server =
    opts.security === 'tls'
      ? tls.createServer({ key: opts.tls.key, cert: opts.tls.cert }, handleConn)
      : net.createServer(handleConn);

  server.on('connection', (sock) => {
    state.openSockets.add(sock);
    sock.once('close', () => {
      state.openSockets.delete(sock);
      const waiters = state.idleWaiters.splice(0);
      for (const waiter of waiters) waiter();
    });
  });

  /** 等待所有连接关闭（验证客户端不留残留句柄）；兜底 3s 放行避免挂死 */
  function waitIdle() {
    if (state.openSockets.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), 3000);
      state.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function handleConn(sock) {
    const conn = { sock, buf: '', inData: false, authStage: null };
    sock.on('error', () => {}); // 客户端 destroy 后回写 221 会触发 ECONNRESET，吞掉即可
    sock.on('end', () => conn.sock.end()); // 对端半关闭就回应半关闭，双方立即干净断开
    writeLine('220 mock.gateway.local ESMTP mock ready');

    sock.on('data', onData);

    function onData(chunk) {
      conn.buf += chunk.toString('utf8');
      if (conn.inData) {
        const end = conn.buf.indexOf('\r\n.\r\n');
        if (end >= 0) {
          // 剥终止符，保留正文的尾 CRLF（与客户端 normalizeToCrlf 的输出逐字可比）
          state.dataPayload = conn.buf.slice(0, end + 2);
          conn.buf = conn.buf.slice(end + 5);
          conn.inData = false;
          writeLine('250 OK message accepted');
          drain();
        }
        return; // 数据未完就继续等
      }
      drain();
    }

    function drain() {
      let idx;
      while ((idx = conn.buf.indexOf('\r\n')) !== -1) {
        const line = conn.buf.slice(0, idx);
        conn.buf = conn.buf.slice(idx + 2);
        if (line.length > 0) state.commands.push(line);
        handleLine(line);
      }
    }

    function writeLine(text) {
      conn.sock.write(`${text}\r\n`);
    }

    function checkPlainCredentials(arg) {
      const parts = Buffer.from(arg, 'base64').toString('utf8').split('\0');
      const ok = parts.length === 3 && parts[1] === opts.username && parts[2] === opts.password;
      if (ok) {
        writeLine('235 2.7.0 authentication succeeded');
      } else {
        writeLine('535 5.7.8 bad credentials');
      }
    }

    function handleLine(line) {
      // AUTH LOGIN / AUTH PLAIN（无参数）的挑战响应行先于命令路由
      if (conn.authStage === 'login-user') {
        conn.authStage = 'login-pass';
        writeLine('334 UGFzc3dvcmQ6'); // "Password:"
        return;
      }
      if (conn.authStage === 'login-pass') {
        conn.authStage = null;
        const ok = Buffer.from(line, 'base64').toString('utf8') === opts.password;
        writeLine(ok ? '235 2.7.0 authentication succeeded' : '535 5.7.8 bad credentials');
        return;
      }
      if (conn.authStage === 'plain') {
        conn.authStage = null;
        checkPlainCredentials(line);
        return;
      }

      const up = line.toUpperCase();
      if (up.startsWith('EHLO')) {
        const caps = ['mock.gateway.local greets you'];
        if ((opts.advertiseStarttls ?? opts.security === 'starttls')) caps.push('STARTTLS');
        if (opts.authLine) caps.push(opts.authLine);
        caps.push('SIZE 52428800');
        conn.sock.write(caps.map((cap, i) => `${i === caps.length - 1 ? '250 ' : '250-'}${cap}`).join('\r\n') + '\r\n');
      } else if (up === 'STARTTLS' && opts.stallAfterStarttls) {
        writeLine('220 2.0.0 Ready to start TLS');
        // 故意既不升级也不回应：客户端应在 TLS 握手阶段超时
      } else if (up === 'STARTTLS' && opts.security === 'starttls') {
        writeLine('220 2.0.0 Ready to start TLS');
        sock.removeAllListeners('data');
        const tlsSock = new tls.TLSSocket(sock, {
          isServer: true,
          secureContext: tls.createSecureContext({ key: opts.tls.key, cert: opts.tls.cert }),
        });
        tlsSock.on('error', () => {});
        tlsSock.on('data', onData);
        conn.sock = tlsSock;
        state.tlsUpgraded = true;
      } else if (up.startsWith('AUTH PLAIN')) {
        const arg = line.slice('AUTH PLAIN'.length).trim();
        if (!arg) {
          conn.authStage = 'plain';
          writeLine('334 ');
        } else {
          checkPlainCredentials(arg);
        }
      } else if (up === 'AUTH LOGIN') {
        conn.authStage = 'login-user';
        writeLine('334 VXNlcm5hbWU6'); // "Username:"
      } else if (up.startsWith('MAIL FROM')) {
        writeLine('250 2.1.0 sender OK');
      } else if (up.startsWith('RCPT TO')) {
        writeLine('250 2.1.5 recipient OK');
      } else if (up === 'DATA') {
        conn.inData = true;
        writeLine('354 End data with <CR><LF>.<CR><LF>');
      } else if (up === 'QUIT') {
        state.quit = true;
        writeLine('221 2.0.0 Bye');
        conn.sock.end();
      } else {
        writeLine('500 5.5.2 unrecognized command');
      }
    }
  }

  return { server, state, waitIdle };
}

/** mock 端把 payload 的头剥掉、解点填充，还原出客户端原始正文（统一 CRLF） */
function payloadBody(payload) {
  assert.ok(payload !== null, 'mock did not receive a DATA payload');
  const headerEnd = payload.indexOf('\r\n\r\n');
  assert.ok(headerEnd >= 0, 'payload has no header/body separator');
  const body = payload.slice(headerEnd + 4);
  return body
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? line.slice(1) : line))
    .join('\r\n');
}

/** 测试本地独立实现的 CRLF 归一（不 import 客户端代码，避免同源遮蔽 bug） */
function toCrlf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').join('\r\n');
}

/** 从原始 payload 抽出完整的 Subject 头（RFC 5322 解折叠后续行） */
function extractSubjectLine(payload) {
  const header = payload.slice(0, payload.indexOf('\r\n\r\n'));
  const unfolded = header.replace(/\r\n[ \t]/g, ' ');
  const line = unfolded.split('\r\n').find((candidate) => candidate.startsWith('Subject: '));
  assert.ok(line !== undefined, 'Subject header missing from payload');
  return line.slice('Subject: '.length);
}

/** 逐段解析 RFC 2047 Base64 编码词，每段独立解码（跨块劈裂会在这里产生 U+FFFD） */
function decodeRfc2047Words(value) {
  return [...value.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)].map((match) =>
    Buffer.from(match[1], 'base64').toString('utf8'),
  );
}

const GOOD_CONFIG = {
  host: HOST,
  port: 0, // 每个用例 listen 后覆盖
  security: 'none',
  username: 'mailer@gateway.local',
  password: 'smtp-test-pass',
  fromAddress: 'noreply@notify.local',
  fromName: '网关通知',
};

function rejectsCode(promise, code) {
  return assert.rejects(promise, (err) => {
    assert.ok(err instanceof SmtpClientError, `expected SmtpClientError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    return true;
  });
}

// ---------------------------------------------------------------- 用例

describe('RFC 2047 编码块完整性', () => {
  test('25 个汉字跨两个编码块：每块独立解码无 U+FFFD、拼接逐字全等', async (t) => {
    const mock = createMockSmtp({ security: 'plain', authLine: 'AUTH PLAIN' });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    // 25 个汉字 = 75 个 UTF-8 字节，必然切成 45B + 30B 两个编码块
    const SUBJECT = '这是一封用于验证长主题按字节切块的中文邮件主题内容';
    assert.equal(Buffer.byteLength(SUBJECT, 'utf8'), 75);

    await sendMail(
      { ...GOOD_CONFIG, port },
      { to: 'user@example.com', subject: SUBJECT, text: '编码块校验\n' },
    );

    await mock.waitIdle();
    const subjectLine = extractSubjectLine(mock.state.dataPayload);
    const chunks = decodeRfc2047Words(subjectLine);
    assert.ok(chunks.length >= 2, `expected at least 2 encoded words, got ${chunks.length}`);
    for (const [i, chunk] of chunks.entries()) {
      assert.ok(!chunk.includes('\uFFFD'), `encoded word #${i} decodes with U+FFFD (split inside a multi-byte char): ${JSON.stringify(chunk)}`);
    }
    assert.equal(chunks.join(''), SUBJECT);
  });

  test('ASCII 与中文混排且切点落在汉字字节中间：按码点换块不劈裂', async (t) => {
    const mock = createMockSmtp({ security: 'plain', authLine: 'AUTH PLAIN' });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    // 44 字节 ASCII + 42 字节汉字：固定 45 字节硬切会把「验」的首字节劈进上一块，
    // 解码出 U+FFFD；按码点切块则整字挪到下一块
    const SUBJECT = `${'a'.repeat(44)}验证主题切块不劈裂多字节字符`;
    assert.equal(Buffer.byteLength(SUBJECT, 'utf8'), 44 + 14 * 3);

    await sendMail(
      { ...GOOD_CONFIG, port },
      { to: 'user@example.com', subject: SUBJECT, text: '混排切块校验\n' },
    );

    await mock.waitIdle();
    const subjectLine = extractSubjectLine(mock.state.dataPayload);
    const chunks = decodeRfc2047Words(subjectLine);
    assert.ok(chunks.length >= 2);
    for (const [i, chunk] of chunks.entries()) {
      assert.ok(!chunk.includes('\uFFFD'), `encoded word #${i} decodes with U+FFFD: ${JSON.stringify(chunk)}`);
    }
    assert.equal(chunks.join(''), SUBJECT);
    assert.ok(chunks[0].length > 0 && !chunks[0].includes('验'), 'first chunk should be pure ASCII when the split falls before a multi-byte char');
  });
});

describe('sendMail over plain TCP', () => {
  test('none + AUTH PLAIN：中文正文与点开头行逐字还原、QUIT、无残留连接', async (t) => {
    const mock = createMockSmtp({ security: 'plain', authLine: 'AUTH PLAIN' });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    const TEXT = [
      '您好，您的验证码是 482913。',
      '.single leading dot line',
      '.',
      '..double dot line',
      '',
      '最后一行',
      '',
    ].join('\n');

    await sendMail({ ...GOOD_CONFIG, port }, { to: 'user@example.com', subject: '网关验证码', text: TEXT });

    // 先等连接关闭：sendMail 返回时 QUIT 可能还在传输路上
    await mock.waitIdle();
    assert.equal(mock.state.quit, true, 'client did not send QUIT');
    assert.ok(mock.state.dataPayload !== null);

    // 点填充解包后逐字还原（含中文、以 . 与 .. 开头的行、尾部换行）
    assert.equal(payloadBody(mock.state.dataPayload), toCrlf(TEXT));

    const payload = mock.state.dataPayload;
    const header = payload.slice(0, payload.indexOf('\r\n\r\n'));
    assert.ok(header.startsWith('From: =?UTF-8?B?'), `From header should RFC 2047-encode the display name, got: ${header.split('\r\n')[0]}`);
    assert.ok(header.includes(' <noreply@notify.local>'));
    assert.ok(header.includes('To: user@example.com'));
    assert.ok(header.includes('Subject: =?UTF-8?B?'), 'subject with non-ASCII should be RFC 2047 encoded');
    assert.match(header, /^Date: [A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m);
    assert.match(header, /^Message-ID: <[0-9a-f-]{36}@notify\.local>$/m);
    assert.ok(header.includes('MIME-Version: 1.0'));
    assert.ok(header.includes('Content-Type: text/plain; charset=utf-8'));
    assert.ok(header.includes('Content-Transfer-Encoding: 8bit'));

    // AUTH PLAIN 参数确实是 base64(\0user\0pass)
    const authCommand = mock.state.commands.find((cmd) => cmd.startsWith('AUTH PLAIN '));
    assert.ok(authCommand, 'AUTH PLAIN command missing');
    assert.equal(
      Buffer.from(authCommand.slice('AUTH PLAIN '.length), 'base64').toString('utf8'),
      '\0mailer@gateway.local\0smtp-test-pass',
    );

    await mock.waitIdle();
  });

  test('AUTH LOGIN：两轮 334 挑战成功', async (t) => {
    const mock = createMockSmtp({ security: 'plain', authLine: 'AUTH LOGIN' });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    await sendMail({ ...GOOD_CONFIG, port }, { to: 'user@example.com', subject: 'hello', text: 'plain ascii body\n' });

    await mock.waitIdle();
    assert.equal(mock.state.quit, true);
    const commands = mock.state.commands;
    const authIdx = commands.findIndex((cmd) => cmd === 'AUTH LOGIN');
    assert.ok(authIdx >= 0, 'AUTH LOGIN command missing');
    assert.equal(commands[authIdx + 1], Buffer.from('mailer@gateway.local', 'utf8').toString('base64'), 'username challenge response');
    assert.equal(commands[authIdx + 2], Buffer.from('smtp-test-pass', 'utf8').toString('base64'), 'password challenge response');
  });

  test('AUTH LOGIN：密码错误抛 SMTP_AUTH_FAILED，消息不含密码原文', async (t) => {
    const mock = createMockSmtp({ security: 'plain', authLine: 'AUTH LOGIN' });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    const wrongPassword = 'totally-wrong-pass';
    let caught;
    try {
      await sendMail({ ...GOOD_CONFIG, port, password: wrongPassword }, { to: 'user@example.com', subject: 'hi', text: 'x' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof SmtpClientError, `expected SmtpClientError, got ${caught?.constructor?.name}: ${caught?.message}`);
    assert.equal(caught.code, 'SMTP_AUTH_FAILED');
    assert.equal(caught.smtpStatus, 535);
    assert.ok(!caught.message.includes(wrongPassword), 'error message must not contain the real password');
    assert.ok(
      !caught.message.includes(Buffer.from(wrongPassword).toString('base64')),
      'error message must not contain the base64 password',
    );
    await mock.waitIdle();
  });
});

describe('sendMail over TLS', () => {
  test('TLS 握手挂起（STARTTLS 后对端沉默）：timeoutMs 到点抛 SMTP_TIMEOUT 并清理连接', async (t) => {
    // 不需要证书：mock 回完 220 就沉默，客户端卡在握手阶段，由握手超时收口
    const mock = createMockSmtp({ security: 'plain', advertiseStarttls: true, stallAfterStarttls: true });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    await rejectsCode(
      sendMail(
        { ...GOOD_CONFIG, port, security: 'starttls', rejectUnauthorized: false, timeoutMs: 300 },
        { to: 'user@example.com', subject: 'handshake stall', text: 'never sent\n' },
      ),
      'SMTP_TIMEOUT',
    );

    await mock.waitIdle();
    assert.equal(mock.state.openSockets.size, 0, 'handshake timeout must not leave a half-open connection');
    assert.equal(mock.state.dataPayload, null, 'no message data should have been accepted');
  });

  test('starttls：明文起步、升级 TLS、发信成功', async (t) => {
    const cert = getTestCert();
    if (cert === null) return t.skip('本机 openssl 不可用');
    const mock = createMockSmtp({ security: 'starttls', tls: cert });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    await sendMail(
      { ...GOOD_CONFIG, port, security: 'starttls', rejectUnauthorized: false },
      { to: 'user@example.com', subject: 'via starttls', text: 'encrypted after upgrade\n' },
    );

    assert.equal(mock.state.tlsUpgraded, true, 'mock should have upgraded to TLS');
    assert.equal(payloadBody(mock.state.dataPayload), toCrlf('encrypted after upgrade\n'));
    await mock.waitIdle();
    assert.equal(mock.state.quit, true);
  });

  test('tls：隐式 TLS 直连发信成功', async (t) => {
    const cert = getTestCert();
    if (cert === null) return t.skip('本机 openssl 不可用');
    const mock = createMockSmtp({ security: 'tls', tls: cert });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    await sendMail(
      { ...GOOD_CONFIG, port, security: 'tls', rejectUnauthorized: false },
      { to: 'user@example.com', subject: 'implicit tls', text: 'encrypted from byte one\n' },
    );

    assert.equal(payloadBody(mock.state.dataPayload), toCrlf('encrypted from byte one\n'));
    await mock.waitIdle();
    assert.equal(mock.state.quit, true);
  });

  test('tls：rejectUnauthorized 默认拒绝自签证书，抛 SMTP_TLS_FAILED', async (t) => {
    const cert = getTestCert();
    if (cert === null) return t.skip('本机 openssl 不可用');
    const mock = createMockSmtp({ security: 'tls', tls: cert });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    // 默认 rejectUnauthorized = true：自签证书必须被拒
    await rejectsCode(
      sendMail({ ...GOOD_CONFIG, port, security: 'tls' }, { to: 'user@example.com', subject: 'x', text: 'x' }),
      'SMTP_TLS_FAILED',
    );
    await mock.waitIdle();
  });

  test('starttls：服务端不广告 STARTTLS 能力时抛 SMTP_TLS_FAILED', async (t) => {
    const cert = getTestCert();
    if (cert === null) return t.skip('本机 openssl 不可用');
    const mock = createMockSmtp({ security: 'plain', advertiseStarttls: false, tls: cert });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    await rejectsCode(
      sendMail({ ...GOOD_CONFIG, port, security: 'starttls', rejectUnauthorized: false }, { to: 'user@example.com', subject: 'x', text: 'x' }),
      'SMTP_TLS_FAILED',
    );
    await mock.waitIdle();
  });
});

describe('header injection 与本地校验', () => {
  // host 指向必定拒绝连接的端口：若实现误在连接后才发现注入，会得到 SMTP_CONNECT_FAILED 而非期望码
  const deadConfig = { ...GOOD_CONFIG, port: 1, security: 'none' };

  test('to 注入 Bcc 头：连接建立前抛 SMTP_HEADER_INJECTION', async () => {
    await rejectsCode(sendMail(deadConfig, { to: 'a@b.com\r\nBcc: evil@x.com', subject: 'hi', text: 'x' }), 'SMTP_HEADER_INJECTION');
  });

  test('subject 注入换行：连接建立前抛 SMTP_HEADER_INJECTION', async () => {
    await rejectsCode(sendMail(deadConfig, { to: 'a@b.com', subject: 'hi\nBcc: x', text: 'x' }), 'SMTP_HEADER_INJECTION');
  });

  test('fromName 注入 CR：连接建立前抛 SMTP_HEADER_INJECTION', async () => {
    await rejectsCode(sendMail({ ...deadConfig, fromName: 'x\r\ny' }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_HEADER_INJECTION');
  });

  test('ehloDomain 注入 CRLF：连接建立前抛 SMTP_HEADER_INJECTION', async () => {
    await rejectsCode(
      sendMail(
        { ...deadConfig, ehloDomain: 'gateway.local\r\nAUTH PLAIN AGk6c2VjcmV0' },
        { to: 'a@b.com', subject: 'hi', text: 'x' },
      ),
      'SMTP_HEADER_INJECTION',
    );
  });

  test('非法地址与端口：SMTP_INVALID_CONFIG', async () => {
    await rejectsCode(sendMail(deadConfig, { to: 'not-an-address', subject: 'hi', text: 'x' }), 'SMTP_INVALID_CONFIG');
    await rejectsCode(sendMail(deadConfig, { to: 'a@@b.com', subject: 'hi', text: 'x' }), 'SMTP_INVALID_CONFIG');
    await rejectsCode(sendMail({ ...deadConfig, port: 0 }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_INVALID_CONFIG');
    await rejectsCode(sendMail({ ...deadConfig, port: 65536 }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_INVALID_CONFIG');
    await rejectsCode(sendMail({ ...deadConfig, port: 1.5 }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_INVALID_CONFIG');
    await rejectsCode(sendMail({ ...deadConfig, host: '' }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_INVALID_CONFIG');
    await rejectsCode(sendMail({ ...deadConfig, fromAddress: 'a b@c.com' }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_INVALID_CONFIG');
  });

  test('连接失败：SMTP_CONNECT_FAILED', async (t) => {
    const mock = createMockSmtp({ security: 'plain', authLine: null });
    const port = await listen(mock.server);
    await closeServer(mock.server); // 先拿到端口再立刻关掉，保证连接被拒
    t.after(() => closeServer(mock.server));
    await rejectsCode(sendMail({ ...GOOD_CONFIG, port }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_CONNECT_FAILED');
  });
});

describe('超时与清理', () => {
  test('服务端沉默不发 greeting：timeoutMs 到点抛 SMTP_TIMEOUT 并清理连接', async (t) => {
    const state = { openSockets: new Set(), idleWaiters: [] };
    const silent = net.createServer((sock) => {
      state.openSockets.add(sock);
      sock.once('close', () => {
        state.openSockets.delete(sock);
        for (const waiter of state.idleWaiters.splice(0)) waiter();
      });
      // 故意什么都不发：greeting 超时的靶子
    });
    const port = await listen(silent);
    t.after(() => closeServer(silent));

    await rejectsCode(
      sendMail({ ...GOOD_CONFIG, port, timeoutMs: 150 }, { to: 'a@b.com', subject: 'hi', text: 'x' }),
      'SMTP_TIMEOUT',
    );

    // destroy 后 FIN 传播到对端是异步的：先等连接关闭（兜底 2s），再断言没有残留
    await new Promise((resolve) => {
      if (state.openSockets.size === 0) return resolve();
      const timer = setTimeout(resolve, 2000);
      state.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    assert.equal(state.openSockets.size, 0, 'client must destroy the socket on timeout');
  });
});

describe('renderOtpEmail / renderSmtpTestEmail', () => {
  test('中文验证码邮件：验证码、有效期、网关地址与忽略提示齐全', () => {
    const mail = renderOtpEmail({ locale: 'zh', purpose: 'signup', code: '482913', ttlMinutes: 10, publicUrl: 'https://gw.example.com' });
    assert.ok(mail.subject.includes('482913'));
    assert.ok(mail.text.includes('482913'));
    assert.ok(mail.text.includes('10 分钟'));
    assert.ok(mail.text.includes('https://gw.example.com'));
    assert.ok(mail.text.includes('忽略'));
    assert.ok(mail.text.includes('注册'));
  });

  test('中文邮件不带 publicUrl 时不出现网关行', () => {
    const mail = renderOtpEmail({ locale: 'zh', purpose: 'reset_password', code: '998877', ttlMinutes: 5, publicUrl: null });
    assert.ok(mail.subject.includes('重置') || mail.subject.includes('密码重置'));
    assert.ok(!mail.text.includes('http'));
    assert.ok(mail.text.includes('998877'));
    assert.ok(mail.text.includes('5 分钟'));
  });

  test('英文验证码邮件：文案清楚列出关键信息', () => {
    const mail = renderOtpEmail({ locale: 'en', purpose: 'change_email', code: 'ABC123', ttlMinutes: 15, publicUrl: 'https://gw.example.com' });
    assert.ok(mail.subject.includes('ABC123'));
    assert.ok(mail.text.includes('ABC123'));
    assert.ok(mail.text.includes('15 minutes'));
    assert.ok(mail.text.includes('https://gw.example.com'));
    assert.ok(/ignore/i.test(mail.text));
    assert.ok(/change the email/i.test(mail.text));
  });

  test('SMTP 测试邮件中英文：含网关地址与发送时间', () => {
    const sentAtIso = '2026-11-13T08:30:00.000Z';
    const zh = renderSmtpTestEmail({ locale: 'zh', publicUrl: 'https://gw.example.com', sentAtIso });
    assert.ok(zh.subject.includes('测试'));
    assert.ok(zh.text.includes('https://gw.example.com'));
    assert.ok(zh.text.includes(sentAtIso));

    const en = renderSmtpTestEmail({ locale: 'en', publicUrl: null, sentAtIso });
    assert.equal(en.subject, 'SMTP test email');
    assert.ok(!en.text.includes('Gateway:'));
    assert.ok(en.text.includes(sentAtIso));
  });
});
