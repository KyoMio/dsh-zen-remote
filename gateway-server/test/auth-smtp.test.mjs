// GC-4 + GC-5 consolidated SMTP client + email OTP + self-service account REST tests.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

import { createGatewayApiServer } from '../dist/server.js';
import { SqliteStore } from '../dist/store/sqlite-store.js';
import { deriveMasterKeyFromSecret, hashPassword } from '../dist/master-key.js';
import {
  OTP_COOLDOWN_MS,
  OTP_IP_MAX_REQUESTS,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  encodeSmtpConfig,
  hashOtpCode,
  loginAccountRateLimiter,
  loginIpRateLimiter,
  otpSendRateLimiter,
  signupRateLimiter,
} from '../dist/http/auth.js';
import { checkPassword } from '../dist/http/password-policy.js';
import { StoreError } from '../dist/store/types.js';
import { sendMail, SmtpClientError } from '../dist/mail/smtp-client.js';
import { renderOtpEmail, renderSmtpTestEmail } from '../dist/mail/templates.js';
import {
  ADMIN_EMAIL,
  ADMIN_HASH,
  ADMIN_PASSWORD,
  TENANT_HASH,
  getTestTlsPair,
  seedSession,
} from './helpers/fixtures.mjs';

const HOST = '127.0.0.1';
const MASTER_KEY = deriveMasterKeyFromSecret('auth-otp-account-test');
const SESSION_COOKIE_RE = /^zr_gw_session=[0-9a-f]{64}$/;

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

/** Unified mock SMTP server supporting plain, TLS, STARTTLS, AUTH PLAIN/LOGIN, and message capture. */
function createMockSmtp(options = {}) {
  const opts = {
    security: 'plain',
    advertiseStarttls: undefined,
    stallAfterStarttls: false,
    authLine: 'AUTH PLAIN LOGIN',
    username: 'mailer@gateway.local',
    password: 'smtp-test-pass',
    ...options,
  };
  const state = {
    messages: [],
    commands: [],
    dataPayload: null,
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
      for (const waiter of state.idleWaiters.splice(0)) waiter();
    });
  });

  function waitIdle() {
    if (state.openSockets.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      state.idleWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  function handleConn(sock) {
    const conn = { sock, buf: '', inData: false, authStage: null, from: null, to: null };
    sock.on('error', () => {});
    sock.on('end', () => conn.sock.end());
    writeLine('220 mock.gateway.local ESMTP mock ready');
    sock.on('data', onData);

    function onData(chunk) {
      conn.buf += chunk.toString('utf8');
      if (conn.inData) {
        const end = conn.buf.indexOf('\r\n.\r\n');
        if (end >= 0) {
          const payload = conn.buf.slice(0, end + 2);
          conn.buf = conn.buf.slice(end + 5);
          conn.inData = false;
          state.dataPayload = payload;
          state.messages.push({ from: conn.from, to: conn.to, payload });
          writeLine('250 OK message accepted');
          drain();
        }
        return;
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

    function writeLine(text) { conn.sock.write(`${text}\r\n`); }

    function checkPlainCredentials(arg) {
      const parts = Buffer.from(arg, 'base64').toString('utf8').split('\0');
      const ok = parts.length === 3 && parts[1] === opts.username && parts[2] === opts.password;
      writeLine(ok ? '235 2.7.0 authentication succeeded' : '535 5.7.8 bad credentials');
    }

    function handleLine(line) {
      if (conn.authStage === 'login-user') {
        conn.authStage = 'login-pass';
        writeLine('334 UGFzc3dvcmQ6');
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
        if (!arg) { conn.authStage = 'plain'; writeLine('334 '); }
        else checkPlainCredentials(arg);
      } else if (up === 'AUTH LOGIN') {
        conn.authStage = 'login-user';
        writeLine('334 VXNlcm5hbWU6');
      } else if (up.startsWith('MAIL FROM')) {
        conn.from = line;
        writeLine('250 2.1.0 sender OK');
      } else if (up.startsWith('RCPT TO')) {
        conn.to = line;
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

function otpFromMessage(message) {
  const subjectLine = message.payload.split('\r\n').find((line) => line.toUpperCase().startsWith('SUBJECT:'));
  assert.ok(subjectLine, `message must have a Subject header:\n${message.payload}`);
  const encoded = /=\?UTF-8\?B\?([^?]*)\?=/.exec(subjectLine);
  const subject = encoded ? Buffer.from(encoded[1], 'base64').toString('utf8') : subjectLine.slice('Subject:'.length).trim();
  const match = /(\d{6})\s*$/.exec(subject);
  assert.ok(match, `subject must end with the 6-digit code: ${subjectLine}`);
  return match[1];
}

function wrongCode(realCode) {
  return realCode === '000000' ? '111111' : '000000';
}

function seedSettings(overrides = {}) {
  return { allowSignup: false, maxNetworksPerUser: 2, defaultMaxPeers: 4, relayRateKbps: 2048, ...overrides };
}

async function startServer(opts = {}) {
  const store = opts.store ?? new SqliteStore({ seed: seedSettings(opts.seed) });
  const server = createGatewayApiServer({ store, masterKey: MASTER_KEY, publicUrl: opts.publicUrl });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  return { server, store, base: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(handle) {
  await new Promise((resolve) => {
    handle.server.closeIdleConnections?.();
    handle.server.close(() => resolve());
    handle.server.closeAllConnections?.();
  });
  await handle.store.close();
}

async function api(base, method, reqPath, { body, headers = {}, cookie } = {}) {
  const h = { ...headers };
  if (method !== 'GET' && method !== 'HEAD') h.origin = base;
  if (cookie !== undefined) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const res = await fetch(base + reqPath, { method, headers: h, body: payload });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null, setCookies: res.headers.getSetCookie() };
}

function sessionCookie(res) {
  const raw = res.setCookies.find((c) => c.startsWith('zr_gw_session='));
  assert.ok(raw, 'expected a zr_gw_session Set-Cookie header');
  const pair = raw.split(';')[0];
  assert.match(pair, SESSION_COOKIE_RE);
  return pair;
}

async function login(base, email, password) {
  const res = await api(base, 'POST', '/api/v1/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login ${email} failed: ${JSON.stringify(res.json)}`);
  return sessionCookie(res);
}

function assertEnvelopeError(json, code) {
  assert.equal(json.ok, false);
  assert.equal(json.error.code, code);
  assert.ok(json.error.message.length > 0);
}

function assertNoSecrets(json) {
  const text = JSON.stringify(json);
  assert.ok(!text.includes('passwordHash'));
  assert.ok(!text.includes('smtpConfigEnc'));
  assert.ok(!text.includes('smtp-test-pass'));
  assert.ok(!text.includes('codeHash'));
}

function payloadBody(payload) {
  assert.ok(payload !== null);
  const headerEnd = payload.indexOf('\r\n\r\n');
  assert.ok(headerEnd >= 0);
  return payload.slice(headerEnd + 4).split('\r\n').map((l) => (l.startsWith('.') ? l.slice(1) : l)).join('\r\n');
}

function toCrlf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').join('\r\n');
}

function extractSubjectLine(payload) {
  const header = payload.slice(0, payload.indexOf('\r\n\r\n')).replace(/\r\n[ \t]/g, ' ');
  const line = header.split('\r\n').find((c) => c.startsWith('Subject: '));
  assert.ok(line !== undefined);
  return line.slice('Subject: '.length);
}

function decodeRfc2047Words(value) {
  return [...value.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
}

const GOOD_SMTP = {
  host: HOST,
  port: 0,
  security: 'none',
  username: 'mailer@gateway.local',
  password: 'smtp-test-pass',
  fromAddress: 'noreply@notify.local',
  fromName: '网关通知',
};

function rejectsCode(promise, code) {
  return assert.rejects(promise, (err) => {
    assert.ok(err instanceof SmtpClientError);
    assert.equal(err.code, code);
    return true;
  });
}

// ---------------------------------------------------------------- SMTP client (GC-4)

describe('RFC 2047 编码块完整性', () => {
  test('25 个汉字跨两个编码块 & ASCII/中文混排切点：每块独立解码无 U+FFFD、拼接全等', async (t) => {
    const mock = createMockSmtp({ security: 'plain', authLine: 'AUTH PLAIN' });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    const SUBJECT1 = '这是一封用于验证长主题按字节切块的中文邮件主题内容';
    await sendMail({ ...GOOD_SMTP, port }, { to: 'user@example.com', subject: SUBJECT1, text: '编码块校验\n' });
    await mock.waitIdle();
    const chunks1 = decodeRfc2047Words(extractSubjectLine(mock.state.dataPayload));
    assert.ok(chunks1.length >= 2);
    for (const c of chunks1) assert.ok(!c.includes('\uFFFD'));
    assert.equal(chunks1.join(''), SUBJECT1);

    const SUBJECT2 = `${'a'.repeat(44)}验证主题切块不劈裂多字节字符`;
    await sendMail({ ...GOOD_SMTP, port }, { to: 'user@example.com', subject: SUBJECT2, text: '混排切块校验\n' });
    await mock.waitIdle();
    const chunks2 = decodeRfc2047Words(extractSubjectLine(mock.state.dataPayload));
    assert.ok(chunks2.length >= 2);
    for (const c of chunks2) assert.ok(!c.includes('\uFFFD'));
    assert.equal(chunks2.join(''), SUBJECT2);
    assert.ok(chunks2[0].length > 0 && !chunks2[0].includes('验'));
  });
});

describe('sendMail over plain TCP', () => {
  test('none + AUTH PLAIN：中文正文与点开头行逐字还原、QUIT、无残留连接', async (t) => {
    const mock = createMockSmtp({ security: 'plain', authLine: 'AUTH PLAIN' });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    const TEXT = ['您好，您的验证码是 482913。', '.single leading dot line', '.', '..double dot line', '', '最后一行', ''].join('\n');
    await sendMail({ ...GOOD_SMTP, port }, { to: 'user@example.com', subject: '网关验证码', text: TEXT });
    await mock.waitIdle();
    assert.equal(mock.state.quit, true);
    assert.equal(payloadBody(mock.state.dataPayload), toCrlf(TEXT));
    const header = mock.state.dataPayload.slice(0, mock.state.dataPayload.indexOf('\r\n\r\n'));
    assert.ok(header.startsWith('From: =?UTF-8?B?'));
    assert.ok(header.includes(' <noreply@notify.local>'));
    assert.ok(header.includes('To: user@example.com'));
    assert.ok(header.includes('Subject: =?UTF-8?B?'));
    assert.match(header, /^Date: [A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m);
    assert.match(header, /^Message-ID: <[0-9a-f-]{36}@notify\.local>$/m);
    const authCommand = mock.state.commands.find((cmd) => cmd.startsWith('AUTH PLAIN '));
    assert.equal(Buffer.from(authCommand.slice('AUTH PLAIN '.length), 'base64').toString('utf8'), '\0mailer@gateway.local\0smtp-test-pass');
  });

  test('AUTH LOGIN：成功与密码错误抛 SMTP_AUTH_FAILED（不含密码原文）', async (t) => {
    const mock = createMockSmtp({ security: 'plain', authLine: 'AUTH LOGIN' });
    const port = await listen(mock.server);
    t.after(() => closeServer(mock.server));

    await sendMail({ ...GOOD_SMTP, port }, { to: 'user@example.com', subject: 'hello', text: 'plain ascii body\n' });
    await mock.waitIdle();
    const authIdx = mock.state.commands.indexOf('AUTH LOGIN');
    assert.ok(authIdx >= 0);
    assert.equal(mock.state.commands[authIdx + 1], Buffer.from('mailer@gateway.local', 'utf8').toString('base64'));
    assert.equal(mock.state.commands[authIdx + 2], Buffer.from('smtp-test-pass', 'utf8').toString('base64'));

    const wrongPassword = 'totally-wrong-pass';
    let caught;
    try {
      await sendMail({ ...GOOD_SMTP, port, password: wrongPassword }, { to: 'user@example.com', subject: 'hi', text: 'x' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof SmtpClientError);
    assert.equal(caught.code, 'SMTP_AUTH_FAILED');
    assert.equal(caught.smtpStatus, 535);
    assert.ok(!caught.message.includes(wrongPassword));
    assert.ok(!caught.message.includes(Buffer.from(wrongPassword).toString('base64')));
    await mock.waitIdle();
  });
});

describe('sendMail over TLS (shared cert)', () => {
  test('STARTTLS 挂起超时清理连接；starttls/tls 成功；自签拒绝与缺 STARTTLS 拒绝', async (t) => {
    const tlsPair = getTestTlsPair();

    const stallMock = createMockSmtp({ security: 'plain', advertiseStarttls: true, stallAfterStarttls: true });
    const stallPort = await listen(stallMock.server);
    t.after(() => closeServer(stallMock.server));
    await rejectsCode(sendMail({ ...GOOD_SMTP, port: stallPort, security: 'starttls', rejectUnauthorized: false, timeoutMs: 150 }, { to: 'u@e.com', subject: 's', text: 'x\n' }), 'SMTP_TIMEOUT');
    await stallMock.waitIdle();
    assert.equal(stallMock.state.openSockets.size, 0);

    const starttlsMock = createMockSmtp({ security: 'starttls', tls: tlsPair });
    const starttlsPort = await listen(starttlsMock.server);
    t.after(() => closeServer(starttlsMock.server));
    await sendMail({ ...GOOD_SMTP, port: starttlsPort, security: 'starttls', rejectUnauthorized: false }, { to: 'u@e.com', subject: 'via starttls', text: 'encrypted after upgrade\n' });
    assert.equal(starttlsMock.state.tlsUpgraded, true);
    assert.equal(payloadBody(starttlsMock.state.dataPayload), toCrlf('encrypted after upgrade\n'));
    await starttlsMock.waitIdle();

    const tlsMock = createMockSmtp({ security: 'tls', tls: tlsPair });
    const tlsPort = await listen(tlsMock.server);
    t.after(() => closeServer(tlsMock.server));
    await sendMail({ ...GOOD_SMTP, port: tlsPort, security: 'tls', rejectUnauthorized: false }, { to: 'u@e.com', subject: 'implicit tls', text: 'encrypted from byte one\n' });
    assert.equal(payloadBody(tlsMock.state.dataPayload), toCrlf('encrypted from byte one\n'));
    await tlsMock.waitIdle();

    await rejectsCode(sendMail({ ...GOOD_SMTP, port: tlsPort, security: 'tls' }, { to: 'u@e.com', subject: 'x', text: 'x' }), 'SMTP_TLS_FAILED');
    await tlsMock.waitIdle();

    const noStarttlsMock = createMockSmtp({ security: 'plain', advertiseStarttls: false, tls: tlsPair });
    const noStarttlsPort = await listen(noStarttlsMock.server);
    t.after(() => closeServer(noStarttlsMock.server));
    await rejectsCode(sendMail({ ...GOOD_SMTP, port: noStarttlsPort, security: 'starttls', rejectUnauthorized: false }, { to: 'u@e.com', subject: 'x', text: 'x' }), 'SMTP_TLS_FAILED');
    await noStarttlsMock.waitIdle();
  });
});

describe('header injection、本地校验与超时清理', () => {
  const deadConfig = { ...GOOD_SMTP, port: 1, security: 'none' };

  test('头注入拦截 / 非法配置 / 连接失败 / greeting 超时清理', async (t) => {
    await rejectsCode(sendMail(deadConfig, { to: 'a@b.com\r\nBcc: evil@x.com', subject: 'hi', text: 'x' }), 'SMTP_HEADER_INJECTION');
    await rejectsCode(sendMail(deadConfig, { to: 'a@b.com', subject: 'hi\nBcc: x', text: 'x' }), 'SMTP_HEADER_INJECTION');
    await rejectsCode(sendMail({ ...deadConfig, fromName: 'x\r\ny' }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_HEADER_INJECTION');
    await rejectsCode(sendMail({ ...deadConfig, ehloDomain: 'gw.local\r\nAUTH PLAIN x' }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_HEADER_INJECTION');
    for (const bad of [{ to: 'not-an-address' }, { to: 'a@@b.com' }]) {
      await rejectsCode(sendMail(deadConfig, { ...bad, subject: 'hi', text: 'x' }), 'SMTP_INVALID_CONFIG');
    }
    for (const bad of [{ port: 0 }, { port: 65536 }, { port: 1.5 }, { host: '' }, { fromAddress: 'a b@c.com' }]) {
      await rejectsCode(sendMail({ ...deadConfig, ...bad }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_INVALID_CONFIG');
    }

    const closedMock = createMockSmtp({ security: 'plain', authLine: null });
    const closedPort = await listen(closedMock.server);
    await closeServer(closedMock.server);
    await rejectsCode(sendMail({ ...GOOD_SMTP, port: closedPort }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_CONNECT_FAILED');

    const state = { openSockets: new Set(), idleWaiters: [] };
    const silent = net.createServer((sock) => {
      state.openSockets.add(sock);
      sock.once('close', () => {
        state.openSockets.delete(sock);
        for (const w of state.idleWaiters.splice(0)) w();
      });
    });
    const silentPort = await listen(silent);
    t.after(() => closeServer(silent));
    await rejectsCode(sendMail({ ...GOOD_SMTP, port: silentPort, timeoutMs: 120 }, { to: 'a@b.com', subject: 'hi', text: 'x' }), 'SMTP_TIMEOUT');
    await new Promise((resolve) => {
      if (state.openSockets.size === 0) return resolve();
      const timer = setTimeout(resolve, 2000);
      state.idleWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
    assert.equal(state.openSockets.size, 0);
  });

  test('renderOtpEmail / renderSmtpTestEmail 中英双语模板', () => {
    const zh = renderOtpEmail({ locale: 'zh', purpose: 'signup', code: '482913', ttlMinutes: 10, publicUrl: 'https://gw.example.com' });
    assert.ok(zh.subject.includes('482913') && zh.text.includes('10 分钟') && zh.text.includes('https://gw.example.com'));
    const zhReset = renderOtpEmail({ locale: 'zh', purpose: 'reset_password', code: '998877', ttlMinutes: 5, publicUrl: null });
    assert.ok(!zhReset.text.includes('http') && zhReset.text.includes('998877'));
    const en = renderOtpEmail({ locale: 'en', purpose: 'change_email', code: 'ABC123', ttlMinutes: 15, publicUrl: 'https://gw.example.com' });
    assert.ok(en.subject.includes('ABC123') && en.text.includes('15 minutes') && /change the email/i.test(en.text));
    const tZh = renderSmtpTestEmail({ locale: 'zh', publicUrl: 'https://gw.example.com', sentAtIso: '2026-11-13T08:30:00.000Z' });
    assert.ok(tZh.subject.includes('测试') && tZh.text.includes('https://gw.example.com'));
    const tEn = renderSmtpTestEmail({ locale: 'en', publicUrl: null, sentAtIso: '2026-11-13T08:30:00.000Z' });
    assert.equal(tEn.subject, 'SMTP test email');
    assert.ok(!tEn.text.includes('Gateway:'));
  });
});

// ---------------------------------------------------------------- OTP & account REST (GC-5)

test('password policy covers weak patterns, email names, boundaries and strong passwords', () => {
  for (const password of ['', 'aaaaaaaaaa', 'ababababab', 'password123', 'PASSWORD123', 'qwertyuiop', '1234567890', 'iloveyou12', 'abcdefghij', '0987654321', 'Ab3!xy789', 'prefixALICE!42', 'x'.repeat(129)]) {
    assert.equal(checkPassword(password, 'alice@example.com'), false, password);
  }
  assert.equal(checkPassword('Copper!River-742', 'alice@example.com'), true);
  assert.equal(checkPassword('aB3!xy7890'), true);
  assert.equal(checkPassword('Copper!River-742'.padEnd(128, 'z')), true);
  assert.equal(checkPassword('cat-Copper!742', 'cat@example.com'), true);
});

test('signup without verification hides duplicates, validates passwords and limits client IP attempts', async (t) => {
  const handle = await startServer({ seed: { allowSignup: true } });
  signupRateLimiter.clear();
  t.after(async () => { signupRateLimiter.clear(); await stopServer(handle); });
  for (const password of ['aaaaaaaaaa', 'password123', 'abcdefghij', 'Ab3!xy789', 'Alice!River742']) {
    const res = await api(handle.base, 'POST', '/api/v1/auth/signup', { body: { email: 'alice@example.com', password } });
    assert.equal(res.status, 400);
    assertEnvelopeError(res.json, 'WEAK_PASSWORD');
  }
  signupRateLimiter.clear();
  const body = { email: 'alice@example.com', password: 'Copper!River-742' };
  assert.equal((await api(handle.base, 'POST', '/api/v1/auth/signup', { body })).status, 200);
  const duplicate = await api(handle.base, 'POST', '/api/v1/auth/signup', { body });
  assert.equal(duplicate.status, 400);
  assertEnvelopeError(duplicate.json, 'SIGNUP_FAILED');
  signupRateLimiter.clear();
  for (let i = 0; i < OTP_IP_MAX_REQUESTS; i++) {
    const invalid = await api(handle.base, 'POST', '/api/v1/auth/signup', { body: { email: 'invalid', password: '' } });
    assert.equal(invalid.status, 400);
  }
  const limited = await api(handle.base, 'POST', '/api/v1/auth/signup', { body });
  assert.equal(limited.status, 429);
  assertEnvelopeError(limited.json, 'RATE_LIMITED');
});

test('verified signup maps a duplicate-email race to OTP_INVALID', async (t) => {
  const handle = await startServer({ seed: { allowSignup: true, requireEmailVerification: true } });
  t.after(() => stopServer(handle));
  const email = 'alice@example.com';
  const code = '123456';
  await handle.store.issueEmailOtp({ email, purpose: 'signup', codeHash: hashOtpCode(MASTER_KEY, 'signup', email, code), ttlMs: OTP_TTL_MS, cooldownMs: OTP_COOLDOWN_MS });
  t.mock.method(handle.store, 'createUser', async () => { throw new StoreError('duplicate-email'); });
  const result = await api(handle.base, 'POST', '/api/v1/auth/signup', { body: { email, password: 'Copper!River-742', otpCode: code } });
  assert.equal(result.status, 400);
  assertEnvelopeError(result.json, 'OTP_INVALID');
});

describe('SMTP 未配置（独立实例）', () => {
  let handle;
  let adminCookie;

  before(async () => {
    handle = await startServer();
    adminCookie = (await seedSession(handle.store, { email: ADMIN_EMAIL, role: 'admin', passwordHash: ADMIN_HASH })).cookie;
  });

  after(async () => stopServer(handle));

  test('send-otp 503；无 SMTP 一步换绑成功、旧邮箱失效、新邮箱可登录', async () => {
    for (const purpose of ['signup', 'reset_password']) {
      const res = await api(handle.base, 'POST', '/api/v1/auth/send-otp', { body: { email: 'someone@example.com', purpose } });
      assert.equal(res.status, 503);
      assertEnvelopeError(res.json, 'SMTP_NOT_CONFIGURED');
    }
    const bad = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: adminCookie,
      body: { currentPassword: 'wrong-pass-999', newEmail: 'root@example.com' },
    });
    assert.equal(bad.status, 401);
    assertNoSecrets(bad.json);

    const notEmail = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: 'not-an-email' },
    });
    assert.equal(notEmail.status, 400);
    const same = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: ADMIN_EMAIL },
    });
    assert.equal(same.status, 400);

    const reqRes = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: 'root@example.com' },
    });
    assert.equal(reqRes.status, 200);
    assert.deepEqual(reqRes.json.data, { otpRequired: false, cooldownSec: 0 });

    const confirm = await api(handle.base, 'POST', '/api/v1/auth/account/email', {
      cookie: adminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newEmail: 'root@example.com' },
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.json.data.user.email, 'root@example.com');
    assert.equal(confirm.json.data.user.emailVerifiedAt, null);
    assertNoSecrets(confirm.json);

    assert.equal((await api(handle.base, 'POST', '/api/v1/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })).status, 401);
    assert.match(await login(handle.base, 'root@example.com', ADMIN_PASSWORD), SESSION_COOKIE_RE);
  });
});

describe('注册邮箱验证全链路（独立实例 + 假 SMTP）', () => {
  let handle;
  let smtp;
  let smtpPort;
  const EMAIL = 'alice@example.com';
  const PASSWORD = 'Copper!River-742';

  before(async () => {
    smtp = createMockSmtp();
    smtpPort = await listen(smtp.server);
    handle = await startServer({
      seed: seedSettings({
        allowSignup: true,
        requireEmailVerification: true,
        smtpConfigEnc: encodeSmtpConfig(
          { host: HOST, port: smtpPort, security: 'none', username: 'mailer@gateway.local', password: 'smtp-test-pass', fromAddress: 'gateway@example.com', fromName: 'Zen Remote Gateway' },
          MASTER_KEY,
        ),
      }),
    });
  });

  after(async () => {
    await stopServer(handle);
    await closeServer(smtp.server);
  });

  test('signup accepts the emailed otpCode and creates an authenticated session', async () => {
    const email = 'console-signup@example.com';
    const policy = await api(handle.base, 'GET', '/api/v1/auth/me');
    assert.equal(policy.json.data.requireEmailVerification, true);
    assert.equal(policy.json.data.smtpConfigured, true);
    const sent = await api(handle.base, 'POST', '/api/v1/auth/send-otp', {
      body: { email, purpose: 'signup', locale: 'zh' },
    });
    assert.equal(sent.status, 200);
    const otpCode = otpFromMessage(smtp.state.messages.at(-1));
    const wrong = await api(handle.base, 'POST', '/api/v1/auth/signup', {
      body: { email, password: PASSWORD, otpCode: wrongCode(otpCode) },
    });
    assertEnvelopeError(wrong.json, 'OTP_INVALID');
    const signup = await api(handle.base, 'POST', '/api/v1/auth/signup', {
      body: { email, password: PASSWORD, otpCode },
    });
    assert.equal(signup.status, 200);
    assert.ok(signup.json.data.user.emailVerifiedAt);
    const me = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: sessionCookie(signup) });
    assert.equal(me.json.data.authenticated, true);
    assert.equal(me.json.data.user.email, email);
    smtp.state.messages.length = 0;
    otpSendRateLimiter.clear();
  });

  test('signup OTP validation, cooldown, locking and anti-enumeration for registered emails', async () => {
    assert.equal((await api(handle.base, 'POST', '/api/v1/auth/signup', { body: { email: EMAIL, password: PASSWORD } })).status, 400);
    assert.equal((await api(handle.base, 'POST', '/api/v1/auth/signup', { body: { email: EMAIL, password: PASSWORD, otpCode: '12ab56' } })).status, 400);

    const sendRes = await api(handle.base, 'POST', '/api/v1/auth/send-otp', { body: { email: EMAIL, purpose: 'signup' } });
    assert.equal(sendRes.status, 200);
    assert.equal(smtp.state.messages.length, 1);
    assert.equal(smtp.state.messages[0].to, `RCPT TO:<${EMAIL}>`);

    const cooldown = await api(handle.base, 'POST', '/api/v1/auth/send-otp', { body: { email: EMAIL, purpose: 'signup' } });
    assert.equal(cooldown.status, 429);
    assertEnvelopeError(cooldown.json, 'OTP_COOLDOWN');

    const real = otpFromMessage(smtp.state.messages[0]);
    const wrong = wrongCode(real);
    for (let i = 1; i <= OTP_MAX_ATTEMPTS - 1; i++) {
      const res = await api(handle.base, 'POST', '/api/v1/auth/signup', { body: { email: EMAIL, password: PASSWORD, otpCode: wrong } });
      assert.equal(res.status, 400);
      assertEnvelopeError(res.json, 'OTP_INVALID');
    }
    const fifth = await api(handle.base, 'POST', '/api/v1/auth/signup', { body: { email: EMAIL, password: PASSWORD, otpCode: wrong } });
    assert.equal(fifth.status, 429);
    assertEnvelopeError(fifth.json, 'OTP_LOCKED');
    assert.equal((await api(handle.base, 'POST', '/api/v1/auth/signup', { body: { email: EMAIL, password: PASSWORD, otpCode: real } })).status, 429);

    const code2 = '246813';
    await handle.store.issueEmailOtp({
      email: EMAIL, purpose: 'signup', codeHash: hashOtpCode(MASTER_KEY, 'signup', EMAIL, code2),
      ttlMs: OTP_TTL_MS, cooldownMs: OTP_COOLDOWN_MS, nowMs: Date.now() + OTP_COOLDOWN_MS + 1000,
    });
    const okRes = await api(handle.base, 'POST', '/api/v1/auth/signup', { body: { email: EMAIL, password: PASSWORD, otp: code2 } });
    assert.equal(okRes.status, 200);
    assert.ok(typeof okRes.json.data.user.emailVerifiedAt === 'string');
    assertNoSecrets(okRes.json);
    const cookie = sessionCookie(okRes);
    const me = await api(handle.base, 'GET', '/api/v1/auth/me', { cookie });
    assert.equal(me.json.data.quota.maxNetworks, 2);

    otpSendRateLimiter.clear();
    const mailCount = smtp.state.messages.length;
    const taken = await api(handle.base, 'POST', '/api/v1/auth/send-otp', { body: { email: EMAIL, purpose: 'signup' } });
    assert.equal(taken.status, 200);
    assert.deepEqual(taken.json.data, { sent: true, cooldownSec: OTP_COOLDOWN_MS / 1000 });
    assert.equal(smtp.state.messages.length, mailCount);
    const retry = await api(handle.base, 'POST', '/api/v1/auth/signup', { body: { email: EMAIL, password: PASSWORD, otpCode: '123456' } });
    assertEnvelopeError(retry.json, 'OTP_INVALID');
  });
});

describe('忘记密码重置、IP 限流、已登录改密与两步换绑邮箱（假 SMTP）', () => {
  let handle;
  let smtp;
  let smtpPort;
  const TENANT_EMAIL = 'tenant@example.com';
  const TENANT_PASS = 'tenant-pass-1234';
  const NEW_PASS = 'brand-new-pass-9';

  before(async () => {
    smtp = createMockSmtp();
    smtpPort = await listen(smtp.server);
    handle = await startServer({
      seed: seedSettings({ smtpConfigEnc: encodeSmtpConfig({ host: HOST, port: smtpPort, security: 'none', fromAddress: 'gateway@example.com' }, MASTER_KEY) }),
    });
    await handle.store.createUser({ email: TENANT_EMAIL, passwordHash: await hashPassword(TENANT_PASS), role: 'user' });
    const off = await handle.store.createUser({ email: 'off@example.com', passwordHash: TENANT_HASH, role: 'user' });
    await handle.store.setUserActive(off.id, false);
    await handle.store.createUser({ email: 'taken@example.com', passwordHash: TENANT_HASH, role: 'user' });
    otpSendRateLimiter.clear();
  });

  after(async () => {
    await stopServer(handle);
    await closeServer(smtp.server);
  });

  test('防枚举（未注册/停用不发信）、重置成功吊销会话、错输锁定、IP 限流与停用账号 R4 分支', async () => {
    assert.equal((await api(handle.base, 'POST', '/api/v1/auth/send-otp', { body: { email: 'ghost@example.com', purpose: 'reset_password' } })).status, 200);
    assert.equal((await api(handle.base, 'POST', '/api/v1/auth/send-otp', { body: { email: 'off@example.com', purpose: 'reset_password' } })).status, 200);
    assert.equal(smtp.state.messages.length, 0);

    await api(handle.base, 'POST', '/api/v1/auth/send-otp', { body: { email: TENANT_EMAIL, purpose: 'reset_password' } });
    const real = otpFromMessage(smtp.state.messages[0]);
    assert.equal((await api(handle.base, 'POST', '/api/v1/auth/reset-password', { body: { email: TENANT_EMAIL, otpCode: 'abc123', newPassword: NEW_PASS } })).status, 400);
    assert.equal((await api(handle.base, 'POST', '/api/v1/auth/reset-password', { body: { email: TENANT_EMAIL, otpCode: real, newPassword: 'short' } })).status, 400);
    for (const newPassword of ['aaaaaaaaaa', 'password123', 'abcdefghij', 'Ab3!xy789', 'Tenant!River742']) {
      const weak = await api(handle.base, 'POST', '/api/v1/auth/reset-password', { body: { email: TENANT_EMAIL, otpCode: real, newPassword } });
      assert.equal(weak.status, 400);
      assertEnvelopeError(weak.json, 'WEAK_PASSWORD');
    }

    const tenantUser = await handle.store.findUserByEmail(TENANT_EMAIL);
    const cookieA = `zr_gw_session=${(await handle.store.createSession(tenantUser.id, 86_400_000)).token}`;
    const cookieB = `zr_gw_session=${(await handle.store.createSession(tenantUser.id, 86_400_000)).token}`;
    const reset = await api(handle.base, 'POST', '/api/v1/auth/reset-password', { body: { email: TENANT_EMAIL, otpCode: real, newPassword: NEW_PASS } });
    assert.equal(reset.status, 200);
    for (const c of [cookieA, cookieB]) {
      assert.equal((await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: c })).json.data.authenticated, false);
    }
    assert.equal((await api(handle.base, 'POST', '/api/v1/auth/login', { body: { email: TENANT_EMAIL, password: TENANT_PASS } })).status, 401);
    const cookieNew = await login(handle.base, TENANT_EMAIL, NEW_PASS);
    for (const newPassword of ['aaaaaaaaaa', 'password123', 'abcdefghij', 'Ab3!xy789', 'Tenant!River742']) {
      const weak = await api(handle.base, 'PATCH', '/api/v1/auth/account/password', { cookie: cookieNew, body: { currentPassword: NEW_PASS, newPassword } });
      assert.equal(weak.status, 400);
      assertEnvelopeError(weak.json, 'WEAK_PASSWORD');
    }

    // Self-service password change preserves current session, revokes others.
    const cookieOther = `zr_gw_session=${(await handle.store.createSession(tenantUser.id, 86_400_000)).token}`;
    assert.equal((await api(handle.base, 'PATCH', '/api/v1/auth/account/password', { body: { currentPassword: NEW_PASS, newPassword: 'next-pass-1234' } })).status, 401);
    assert.equal((await api(handle.base, 'PATCH', '/api/v1/auth/account/password', { cookie: cookieNew, body: { currentPassword: 'wrong', newPassword: 'next-pass-1234' } })).status, 401);
    const chg = await api(handle.base, 'PATCH', '/api/v1/auth/account/password', { cookie: cookieNew, body: { currentPassword: NEW_PASS, newPassword: 'next-pass-1234' } });
    assert.equal(chg.status, 200);
    assert.equal((await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: cookieNew })).json.data.authenticated, true);
    assert.equal((await api(handle.base, 'GET', '/api/v1/auth/me', { cookie: cookieOther })).json.data.authenticated, false);

    // Two-step email change with SMTP.
    const taken = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: cookieNew,
      body: { currentPassword: 'next-pass-1234', newEmail: 'taken@example.com' },
    });
    assert.equal(taken.status, 409);
    const reqEmail = await api(handle.base, 'POST', '/api/v1/auth/account/email/request', {
      cookie: cookieNew,
      body: { currentPassword: 'next-pass-1234', newEmail: 'renamed@example.com', locale: 'en' },
    });
    assert.equal(reqEmail.status, 200);
    assert.equal(reqEmail.json.data.otpRequired, true);
    const emailOtp = otpFromMessage(smtp.state.messages[1]);
    assert.equal((await api(handle.base, 'POST', '/api/v1/auth/account/email', { cookie: cookieNew, body: { currentPassword: 'next-pass-1234', newEmail: 'renamed@example.com', otpCode: wrongCode(emailOtp) } })).status, 400);
    const doneEmail = await api(handle.base, 'POST', '/api/v1/auth/account/email', { cookie: cookieNew, body: { currentPassword: 'next-pass-1234', newEmail: 'renamed@example.com', otpCode: emailOtp } });
    assert.equal(doneEmail.status, 200);
    assert.ok(typeof doneEmail.json.data.user.emailVerifiedAt === 'string');

    // IP burst limit + disabled-account R4 branch.
    otpSendRateLimiter.clear();
    const statuses = [];
    for (let i = 0; i <= OTP_IP_MAX_REQUESTS; i++) {
      statuses.push((await api(handle.base, 'POST', '/api/v1/auth/send-otp', { body: { email: `burst${i}@example.com`, purpose: 'reset_password' } })).status);
    }
    assert.deepEqual(statuses.slice(0, OTP_IP_MAX_REQUESTS), new Array(OTP_IP_MAX_REQUESTS).fill(200));
    assert.equal(statuses[OTP_IP_MAX_REQUESTS], 429);

    otpSendRateLimiter.clear();
    await handle.store.createUser({ email: 'r4@example.com', passwordHash: await hashPassword('r4-pass-123456'), role: 'user' });
    await api(handle.base, 'POST', '/api/v1/auth/send-otp', { body: { email: 'r4@example.com', purpose: 'reset_password' } });
    const r4Otp = otpFromMessage(smtp.state.messages.at(-1));
    const r4User = await handle.store.findUserByEmail('r4@example.com');
    await handle.store.setUserActive(r4User.id, false);
    const r4Res = await api(handle.base, 'POST', '/api/v1/auth/reset-password', { body: { email: 'r4@example.com', otpCode: r4Otp, newPassword: 'r4-attacker-pass-1' } });
    assert.equal(r4Res.status, 200);
    const r4Login = await api(handle.base, 'POST', '/api/v1/auth/login', { body: { email: 'r4@example.com', password: 'r4-pass-123456' } });
    assert.equal(r4Login.status, 403);
    assertEnvelopeError(r4Login.json, 'ACCOUNT_DISABLED');

    // T7: Repeated wrong-password login triggers 429 RATE_LIMITED with Retry-After.
    loginIpRateLimiter.clear();
    loginAccountRateLimiter.clear();
    try {
      let rateLimited = null;
      for (let i = 0; i < 15; i++) {
        const res = await fetch(handle.base + '/api/v1/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: handle.base },
          body: JSON.stringify({ email: 'brute@example.com', password: `wrong-pass-${i}` }),
        });
        const json = await res.json();
        if (res.status === 429 && rateLimited === null) {
          rateLimited = { status: res.status, json, retryAfter: res.headers.get('retry-after') };
        }
      }
      assert.ok(rateLimited !== null, 'repeated wrong-password logins must trigger 429 RATE_LIMITED');
      assertEnvelopeError(rateLimited.json, 'RATE_LIMITED');
      assert.ok(Number(rateLimited.retryAfter) > 0, '429 response carries positive Retry-After header');
    } finally {
      loginIpRateLimiter.clear();
      loginAccountRateLimiter.clear();
    }
  });
});
