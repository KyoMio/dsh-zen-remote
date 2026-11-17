const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { WsClient } = require('../lib/peer/ws-client.js');
const { createPeerEngine } = require('../lib/peer/engine.js');
const { ensurePeerIdentity, writePeerNetwork } = require('../lib/state-store.js');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let certDir, credentials;
before(() => {
  certDir = mkdtempSync(path.join(tmpdir(), 'zr-ws-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  credentials = { key: readFileSync(path.join(certDir, 'key.pem')), cert: readFileSync(path.join(certDir, 'cert.pem')) };
});
after(() => {
  if (certDir && path.dirname(certDir) === path.resolve(tmpdir()) && path.basename(certDir).startsWith('zr-ws-test-')) {
    rmSync(certDir, { recursive: true });
  }
});

async function serverFor(t, secure = false) {
  const server = secure ? https.createServer(credentials) : http.createServer();
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise(resolve => server.listen(0, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server;
}
function upgrade(req, socket) {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
}
function dial(t, server, scheme = 'ws', host = 'localhost', options) {
  const client = new WsClient(`${scheme}://${host}:${server.address().port}/peer/v1/ws`, {}, options);
  client.on('error', () => {});
  t.after(() => client.close());
  return client;
}

test('stalled WS output is bounded while reserving space for control frames', () => {
  const { Writable } = require('node:stream');
  const socket = new Writable({ write(_chunk, _enc, _callback) {} });
  const client = { state: 'open', socket };
  try {
    const data = Buffer.alloc(1200);
    let refused = false;
    for (let i = 0; i < 4096; i++) {
      try { WsClient.prototype.send.call(client, data); }
      catch (error) { assert.equal(error.code, 'ERR_PEER_BACKPRESSURE'); refused = true; break; }
    }
    assert.equal(refused, true, 'DATA must stop before the socket buffer grows without bound');
    assert.ok(socket.writableLength < 1024 * 1024);
    const before = socket.writableLength;
    WsClient.prototype.send.call(client, data, true);
    assert.ok(socket.writableLength > before, 'reserved budget carries cancellation/ack frames');
    assert.throws(() => WsClient.prototype.send.call(client, Buffer.alloc(2 * 1024 * 1024), true), { code: 'ERR_PEER_BACKPRESSURE' });
    assert.ok(socket.writableLength <= 1024 * 1024);
  } finally { socket.destroy(); }
});

test('handshake timeout rejects invalid bounds before dialing', () => {
  for (const handshakeTimeoutMs of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
    assert.throws(() => new WsClient('ws://localhost:1', {}, { handshakeTimeoutMs }), /invalid handshakeTimeoutMs/);
  }
});

test('successful upgrade clears handshake deadline', async t => {
  const server = await serverFor(t);
  server.on('upgrade', upgrade);
  const client = dial(t, server, 'ws', 'localhost', { handshakeTimeoutMs: 40 });
  await once(client, 'open');
  await delay(100);
  assert.equal(client.state, 'open');
});

test('plain WS remains usable without certificates or reverse proxy', async t => {
  const server = await serverFor(t);
  server.on('upgrade', upgrade);
  const client = dial(t, server);
  await once(client, 'open');
  assert.equal(client.state, 'open');
});

test('WSS rejects an untrusted self-signed certificate', async t => {
  const server = await serverFor(t, true);
  server.on('upgrade', upgrade);
  const client = dial(t, server, 'wss');
  const outcome = await new Promise(resolve => {
    client.once('open', () => resolve('open'));
    client.once('error', error => resolve(error.code));
  });
  assert.equal(outcome, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  assert.equal(client.state, 'closed');
});

test('WSS accepts trusted hostname but rejects trusted certificate for another hostname', async t => {
  const previous = https.globalAgent.options.ca;
  https.globalAgent.options.ca = credentials.cert;
  t.after(() => { https.globalAgent.options.ca = previous; });
  const server = await serverFor(t, true);
  server.on('upgrade', upgrade);
  const trusted = dial(t, server, 'wss');
  await once(trusted, 'open');
  assert.equal(trusted.state, 'open');
  const mismatch = dial(t, server, 'wss', '127.0.0.1');
  const outcome = await new Promise(resolve => {
    mismatch.once('open', () => resolve('open'));
    mismatch.once('error', error => resolve(error.code));
  });
  assert.equal(outcome, 'ERR_TLS_CERT_ALTNAME_INVALID');
});

test('close cancels pending request, emits close once, and never accepts a late upgrade', async t => {
  const server = await serverFor(t);
  const pending = once(server, 'upgrade');
  const client = dial(t, server);
  let opens = 0, closes = 0, errors = 0;
  client.on('open', () => opens++);
  client.on('close', () => closes++);
  client.on('error', () => errors++);
  const [req, socket] = await pending;
  socket.on('end', () => socket.end());
  client.close();
  client.close();
  upgrade(req, socket);
  await delay(50);
  assert.equal(client.state, 'closed');
  assert.equal(opens, 0);
  assert.equal(closes, 1);
  assert.equal(errors, 0);
  assert.equal(socket.destroyed, true);
});

test('upgrade wait expires and closes a silent HTTP connection', async t => {
  const server = await serverFor(t);
  const pending = once(server, 'upgrade');
  const client = dial(t, server, 'ws', 'localhost', { handshakeTimeoutMs: 40 });
  const errors = [], closes = [];
  client.on('error', error => errors.push(error.message));
  client.on('close', code => closes.push(code));
  const [, socket] = await pending;
  socket.on('end', () => socket.end());
  await delay(120);
  assert.equal(client.state, 'closed');
  assert.deepEqual(closes, [1006]);
  assert.match(errors[0], /handshake timeout/);
  assert.equal(socket.destroyed, true);
});

test('keepalive options reject invalid bounds before dialing and accept zero to disable', async t => {
  for (const pingIntervalMs of [-1, NaN, Infinity, 0.5, 2_147_483_648]) {
    assert.throws(() => new WsClient('ws://localhost:1', {}, { pingIntervalMs }), /invalid pingIntervalMs/);
  }
  for (const pongTimeoutMs of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
    assert.throws(() => new WsClient('ws://localhost:1', {}, { pongTimeoutMs }), /invalid pongTimeoutMs/);
  }
  const server = await serverFor(t);
  server.on('upgrade', (req, socket) => {
    upgrade(req, socket);
    socket.on('data', () => {});
  });
  const client = dial(t, server, 'ws', 'localhost', { pingIntervalMs: 0, pongTimeoutMs: 20 });
  await once(client, 'open');
  await delay(100);
  assert.equal(client.state, 'open');
});

test('keepalive closes a silent server connection after ping/pong timeout', async t => {
  const server = await serverFor(t);
  let pings = 0;
  server.on('upgrade', (req, socket) => {
    upgrade(req, socket);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        const len = buf[1] & 0x7f;
        const need = 2 + (masked ? 4 : 0) + len;
        if (len >= 126 || buf.length < need) break;
        buf = buf.subarray(need);
        if (opcode === 0x9) pings++;
      }
    });
  });
  const client = dial(t, server, 'ws', 'localhost', { pingIntervalMs: 40, pongTimeoutMs: 60 });
  const errors = [];
  client.on('error', err => errors.push(err.message));
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), 1000);
    client.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  await once(client, 'open');
  const closeCode = await closed;
  assert.equal(closeCode, 1006);
  assert.equal(client.state, 'closed');
  assert.ok(pings >= 1, `expected at least 1 ping, got ${pings}`);
  assert.ok(errors.some(msg => /keepalive pong timeout/.test(msg)), `expected keepalive pong timeout error, got ${JSON.stringify(errors)}`);
});

test('keepalive stays open when server replies with RFC6455 pong or sends data frames', async t => {
  const server = await serverFor(t);
  let pongsSent = 0;
  server.on('upgrade', (req, socket) => {
    upgrade(req, socket);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        const len = buf[1] & 0x7f;
        const maskOff = 2;
        const need = 2 + (masked ? 4 : 0) + len;
        if (len >= 126 || buf.length < need) break;
        const payload = Buffer.from(buf.subarray(maskOff + (masked ? 4 : 0), need));
        if (masked) {
          const mask = buf.subarray(maskOff, maskOff + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        buf = buf.subarray(need);
        if (opcode === 0x9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
          pongsSent++;
        }
      }
    });
  });
  const client = dial(t, server, 'ws', 'localhost', { pingIntervalMs: 30, pongTimeoutMs: 45 });
  await once(client, 'open');
  await delay(180);
  assert.equal(client.state, 'open');
  assert.ok(pongsSent >= 3, `expected >=3 pongs, got ${pongsSent}`);
});

test('keepalive stays open when server sends application frames without pong', async t => {
  const server = await serverFor(t);
  let serverSocket = null;
  server.on('upgrade', (req, socket) => {
    serverSocket = socket;
    upgrade(req, socket);
    socket.on('data', () => {});
  });
  const client = dial(t, server, 'ws', 'localhost', { pingIntervalMs: 35, pongTimeoutMs: 55 });
  await once(client, 'open');
  const timer = setInterval(() => {
    if (serverSocket && !serverSocket.destroyed) {
      const msg = Buffer.from('hi');
      serverSocket.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
    }
  }, 25);
  t.after(() => clearInterval(timer));
  await delay(180);
  assert.equal(client.state, 'open');
});

// -- engine WS authentication deadline & welcome/challenge ordering (from peer-auth-timeout) --

async function authEventually(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), 'expected state within 500ms');
}

function wsTextFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

async function setupAuth(t, { head, timeout = 1234, replyClose = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'zr-auth-test-'));
  const stateFile = path.join(home, 'state.json');
  const sockets = [];
  const timers = [];
  const logs = [];
  const events = [];
  let authFrames = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { removed: true } }));
  });
  server.on('upgrade', (req, socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    socket.on('data', data => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) break;
        const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
        if (masked) {
          const mask = buf.subarray(off, off + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        buf = buf.subarray(off + maskLen + len);
        if (opcode === 8) {
          if (replyClose) socket.end(Buffer.from([0x88, 0]));
        } else if (opcode === 9 && payload.length < 126) {
          socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        } else if (opcode === 1 || opcode === 2) {
          authFrames++;
        }
      }
    });
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const response = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(head ? Buffer.concat([response, wsTextFrame(head)]) : response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `127.0.0.1:${server.address().port}`;
  const network = { gatewayWsUrl: `ws://${origin}`, gatewayHttpOrigin: `http://${origin}`, networkId: '0123456789abcdef', joinedAt: 1 };
  writePeerNetwork(stateFile, network);
  const clock = {
    now: Date.now,
    setTimeout(fn, ms) { const timer = { fn, ms, active: true }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.active = false; },
  };
  const options = {
    stateFile,
    identity: ensurePeerIdentity(stateFile),
    relayPool: { maxServers: () => 8 },
    relayHandler: () => undefined,
    relaySecret: () => 'test',
    serverName: () => 'test',
    udpProbe: null,
    clock,
    log: line => logs.push(line),
    ...(timeout === null ? {} : { wsAuthTimeoutMs: timeout }),
  };
  const engine = createPeerEngine(options);
  const emit = WsClient.prototype.emit;
  const send = WsClient.prototype.send;
  const sent = [];
  WsClient.prototype.emit = function (name, ...args) { events.push(name); return emit.call(this, name, ...args); };
  WsClient.prototype.send = function (data, ...args) { sent.push(data); return send.call(this, data, ...args); };
  t.after(async () => {
    engine.stop();
    WsClient.prototype.emit = emit;
    WsClient.prototype.send = send;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('zr-auth-test-'));
    rmSync(home, { recursive: true, force: true });
  });
  engine.resumeFromState();
  await authEventually(() => events.includes('open'));
  const deadline = () => timers.find(timer => timer.active && timer.ms === (timeout ?? 10_000));
  const fire = timer => { assert.ok(timer, 'authentication deadline must be armed'); timer.active = false; timer.fn(); };
  return {
    engine, options, network, timers, logs, events, sockets, sent, deadline, fire,
    authFrames: () => authFrames,
    send: value => sockets.at(-1).write(wsTextFrame(value)),
  };
}

test('default authentication deadline is ten seconds', async t => {
  const env = await setupAuth(t, { timeout: null });
  assert.equal(env.deadline()?.ms, 10_000);
});

test('invalid welcome in upgrade head still arms authentication deadline', async t => {
  const env = await setupAuth(t, { head: { type: 'welcome', status: 'wrong', maxPeers: 64 } });
  assert.ok(env.events.indexOf('message') < env.events.indexOf('open'));
  assert.ok(env.deadline());
  assert.equal(env.engine.status().maxPeers, null);
});

test('silent gateway after upgrade times out and schedules reconnect', async t => {
  const env = await setupAuth(t);
  env.fire(env.deadline());
  await authEventually(() => env.timers.some(timer => timer.active && timer.ms === 1000));
  assert.equal(env.engine.status().gatewayState, 'offline');
  assert.ok(env.logs.some(line => /auth.*timeout/.test(line)));
});

for (const challengeHex of ['', 'a', 'zz', 12]) {
  test(`invalid challenge ${JSON.stringify(challengeHex)} is ignored without escaping or clearing deadline`, async t => {
    const env = await setupAuth(t);
    const deadline = env.deadline();
    env.send({ type: 'challenge', challengeHex });
    await authEventually(() => env.events.includes('message'));
    assert.deepEqual(env.sent, []);
    assert.equal(env.deadline(), deadline);
    assert.equal(env.engine.status().gatewayState, 'connecting');
  });
}

test('short even-length uppercase hex challenge remains compatible', async t => {
  const env = await setupAuth(t);
  const deadline = env.deadline();
  env.send({ type: 'challenge', challengeHex: 'AB' });
  await authEventually(() => env.authFrames() === 1);
  assert.equal(JSON.parse(env.sent[0]).type, 'auth');
  assert.equal(env.deadline(), deadline);
});

test('consecutive auth timeouts back off until a valid welcome resets retry delay', async t => {
  const env = await setupAuth(t);
  for (const [index, delayMs] of [1000, 2000].entries()) {
    env.fire(env.deadline());
    await authEventually(() => env.timers.some(timer => timer.active && timer.ms === delayMs));
    env.fire(env.timers.find(timer => timer.active && timer.ms === delayMs));
    await authEventually(() => env.events.filter(event => event === 'open').length === index + 2 && env.deadline());
  }
  env.send({ type: 'welcome', status: 'pending', maxPeers: 8 });
  await authEventually(() => env.engine.status().gatewayState === 'pending-approval');
  env.sockets.at(-1).destroy();
  await authEventually(() => env.timers.some(timer => timer.active && timer.ms === 1000));
  assert.equal(env.timers.some(timer => timer.active && timer.ms === 4000), false);
});

test('late welcome and challenge during timeout close cannot revive or authenticate', async t => {
  const env = await setupAuth(t, { replyClose: false });
  env.fire(env.deadline());
  const before = env.events.filter(event => event === 'message').length;
  env.send({ type: 'welcome', status: 'authorized', maxPeers: 8, peers: [] });
  env.send({ type: 'challenge', challengeHex: 'ab'.repeat(32) });
  await authEventually(() => env.events.filter(event => event === 'message').length === before + 2);
  assert.equal(env.sockets[0].destroyed, false, 'close handshake still pending');
  assert.equal(env.engine.status().gatewayState, 'offline');
  assert.equal(env.engine.status().maxPeers, null);
  assert.deepEqual(env.sent, [], 'late challenge must not send authentication');
});

test('replaced client late messages cannot alter new connection or send auth', async t => {
  const env = await setupAuth(t, { replyClose: false });
  const oldSocket = env.sockets[0];
  await env.engine.leaveNetwork();
  writePeerNetwork(env.options.stateFile, env.network);
  env.engine.resumeFromState();
  await authEventually(() => env.events.filter(event => event === 'open').length === 2);
  const newDeadline = env.deadline();
  const before = env.events.filter(event => event === 'message').length;
  oldSocket.write(Buffer.concat([
    wsTextFrame({ type: 'welcome', status: 'authorized', maxPeers: 64, peers: [] }),
    wsTextFrame({ type: 'challenge', challengeHex: 'cd'.repeat(32) }),
  ]));
  await authEventually(() => env.events.filter(event => event === 'message').length === before + 2);
  assert.equal(env.engine.status().gatewayState, 'connecting');
  assert.equal(env.engine.status().maxPeers, null);
  assert.equal(env.deadline(), newDeadline);
  assert.deepEqual(env.sent, [], 'old challenge must not authenticate the replacement');
});

test('challenge does not renew deadline; invalid welcome does not satisfy authentication', async t => {
  const env = await setupAuth(t);
  const deadline = env.deadline();
  assert.ok(deadline, 'initial authentication deadline');
  env.send({ type: 'challenge', challengeHex: 'ab'.repeat(32) });
  await authEventually(() => env.authFrames() > 0);
  env.send({ type: 'welcome', status: 'unknown', maxPeers: 64 });
  env.send({ type: 'challenge', challengeHex: 'cd'.repeat(32) });
  await authEventually(() => env.authFrames() > 1);
  assert.equal(env.deadline(), deadline);
  assert.equal(env.engine.status().maxPeers, null);
  env.fire(deadline);
  assert.equal(env.engine.status().gatewayState, 'offline');
});

for (const status of ['authorized', 'pending', 'mismatch']) {
  test(`valid welcome ${status} clears deadline and ignores stale callback`, async t => {
    const env = await setupAuth(t);
    const deadline = env.deadline();
    assert.ok(deadline);
    env.send({ type: 'welcome', status, maxPeers: 8, peers: [] });
    const expected = status === 'pending' ? 'pending-approval' : status;
    await authEventually(() => env.engine.status().gatewayState === expected);
    assert.equal(env.deadline(), undefined);
    deadline.fn();
    assert.equal(env.engine.status().gatewayState, expected);
  });
  test(`welcome ${status} in upgrade head before open never arms auth deadline`, async t => {
    const env = await setupAuth(t, { head: { type: 'welcome', status, maxPeers: 8, peers: [] } });
    assert.ok(env.events.indexOf('message') < env.events.indexOf('open'));
    assert.equal(env.deadline(), undefined);
    assert.equal(env.engine.status().gatewayState, status === 'pending' ? 'pending-approval' : status);
  });
}

test('denied clears deadline without retrying authentication', async t => {
  const env = await setupAuth(t);
  const deadline = env.deadline();
  assert.ok(deadline);
  env.send({ type: 'denied', reason: 'paused' });
  await authEventually(() => env.engine.status().gatewayState === 'paused');
  assert.equal(env.deadline(), undefined);
  deadline.fn();
  assert.equal(env.engine.status().gatewayState, 'paused');
});

test('connection close clears old deadline and stale callback cannot close replacement', async t => {
  const env = await setupAuth(t);
  const oldDeadline = env.deadline();
  assert.ok(oldDeadline);
  env.sockets[0].destroy();
  await authEventually(() => env.timers.some(timer => timer.active && timer.ms === 1000));
  assert.equal(env.deadline(), undefined);
  env.fire(env.timers.find(timer => timer.active && timer.ms === 1000));
  await authEventually(() => env.sockets.length === 2 && env.deadline());
  const replacement = env.deadline();
  oldDeadline.fn();
  assert.equal(env.deadline(), replacement);
  assert.equal(env.engine.status().gatewayState, 'connecting');
});

for (const method of ['leaveNetwork', 'stop']) {
  test(`${method} clears authentication deadline and late callback is harmless`, async t => {
    const env = await setupAuth(t);
    const deadline = env.deadline();
    assert.ok(deadline);
    await env.engine[method]();
    assert.equal(env.deadline(), undefined);
    deadline.fn();
    assert.equal(env.engine.status().gatewayState, 'unconfigured');
  });
}

test('authentication deadline rejects invalid timing options', async t => {
  const { options } = await setupAuth(t);
  for (const wsAuthTimeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
    assert.throws(() => createPeerEngine({ ...options, wsAuthTimeoutMs }), /wsAuthTimeoutMs/);
  }
});
