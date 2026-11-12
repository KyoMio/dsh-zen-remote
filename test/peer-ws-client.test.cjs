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
const Module = require('node:module');
const ts = require('typescript');

// Test current source in Node and Electron without touching shipping lib/.
const filename = path.resolve(__dirname, '../src/peer/ws-client.ts');
const source = new Module(filename, module);
source.filename = filename;
source.paths = module.paths;
source._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { WsClient } = source.exports;
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
