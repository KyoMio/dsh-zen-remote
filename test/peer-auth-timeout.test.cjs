const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const modules = new Map();
function loadSource(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const loaded = new Module(filename, module);
  modules.set(filename, loaded);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded.require = specifier => specifier.startsWith('.')
    ? loadSource(path.resolve(path.dirname(filename), specifier.replace(/\.js$/, '.ts')))
    : module.require(specifier);
  const text = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(require('node:url').pathToFileURL(filename).href));
  loaded._compile(ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, filename);
  return loaded.exports;
}
const source = file => loadSource(path.resolve(__dirname, '../src', file));
const { createPeerEngine } = source('peer/engine.ts');
const { ensurePeerIdentity, writePeerNetwork } = source('state-store.ts');
const { WsClient } = source('peer/ws-client.ts');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), 'expected state within 500ms');
}
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}
async function setup(t, { head, timeout = 1234, replyClose = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-auth-test-'));
  const stateFile = path.join(home, 'state.json');
  const sockets = [], timers = [], logs = [], events = [];
  let authFrames = 0;
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('data', data => {
      if ((data[0] & 15) === 8) {
        if (replyClose) socket.end(Buffer.from([0x88, 0]));
      } else authFrames++;
    });
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const response = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(head ? Buffer.concat([response, frame(head)]) : response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `127.0.0.1:${server.address().port}`;
  const network = { gatewayWsUrl: `ws://${origin}`, gatewayHttpOrigin: `http://${origin}`, networkId: '0123456789abcdef', joinedAt: 1 };
  writePeerNetwork(stateFile, network);
  const clock = { now: Date.now,
    setTimeout(fn, ms) { const timer = { fn, ms, active: true }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.active = false; } };
  const options = { stateFile, identity: ensurePeerIdentity(stateFile), relayPool: { maxServers: () => 8 },
    relayHandler: () => undefined, relaySecret: () => 'test', serverName: () => 'test', udpProbe: null,
    clock, log: line => logs.push(line), ...(timeout === null ? {} : { wsAuthTimeoutMs: timeout }) };
  const engine = createPeerEngine(options);
  // Observe the real HTTP-upgrade head ordering without replacing transport behavior.
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
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('zr-auth-test-'));
    fs.rmSync(home, { recursive: true });
  });
  engine.resumeFromState();
  await eventually(() => events.includes('open'));
  const deadline = () => timers.find(timer => timer.active && timer.ms === (timeout ?? 10_000));
  const fire = timer => { assert.ok(timer, 'authentication deadline must be armed'); timer.active = false; timer.fn(); };
  return { engine, options, network, timers, logs, events, sockets, sent, deadline, fire, authFrames: () => authFrames,
    send: value => sockets.at(-1).write(frame(value)) };
}

test('default authentication deadline is ten seconds', async t => {
  const env = await setup(t, { timeout: null });
  assert.equal(env.deadline()?.ms, 10_000);
});

test('invalid welcome in upgrade head still arms authentication deadline', async t => {
  const env = await setup(t, { head: { type: 'welcome', status: 'wrong', maxPeers: 64 } });
  assert.ok(env.events.indexOf('message') < env.events.indexOf('open'));
  assert.ok(env.deadline());
  assert.equal(env.engine.status().maxPeers, null);
});

test('silent gateway after upgrade times out and schedules reconnect', async t => {
  const env = await setup(t);
  env.fire(env.deadline());
  await eventually(() => env.timers.some(timer => timer.active && timer.ms === 1000));
  assert.equal(env.engine.status().gatewayState, 'offline');
  assert.ok(env.logs.some(line => /auth.*timeout/.test(line)));
});

for (const challengeHex of ['', 'a', 'zz', 12]) {
  test(`invalid challenge ${JSON.stringify(challengeHex)} is ignored without escaping or clearing deadline`, async t => {
    const env = await setup(t);
    const deadline = env.deadline();
    env.send({ type: 'challenge', challengeHex });
    await eventually(() => env.events.includes('message'));
    assert.deepEqual(env.sent, []);
    assert.equal(env.deadline(), deadline);
    assert.equal(env.engine.status().gatewayState, 'connecting');
  });
}

test('short even-length uppercase hex challenge remains compatible', async t => {
  const env = await setup(t);
  const deadline = env.deadline();
  env.send({ type: 'challenge', challengeHex: 'AB' });
  await eventually(() => env.authFrames() === 1);
  assert.equal(JSON.parse(env.sent[0]).type, 'auth');
  assert.equal(env.deadline(), deadline);
});

test('consecutive auth timeouts back off until a valid welcome resets retry delay', async t => {
  const env = await setup(t);
  for (const [index, delay] of [1000, 2000].entries()) {
    env.fire(env.deadline());
    await eventually(() => env.timers.some(timer => timer.active && timer.ms === delay));
    env.fire(env.timers.find(timer => timer.active && timer.ms === delay));
    await eventually(() => env.events.filter(event => event === 'open').length === index + 2 && env.deadline());
  }
  env.send({ type: 'welcome', status: 'pending', maxPeers: 8 });
  await eventually(() => env.engine.status().gatewayState === 'pending-approval');
  env.sockets.at(-1).destroy();
  await eventually(() => env.timers.some(timer => timer.active && timer.ms === 1000));
  assert.equal(env.timers.some(timer => timer.active && timer.ms === 4000), false);
});

test('late welcome and challenge during timeout close cannot revive or authenticate', async t => {
  const env = await setup(t, { replyClose: false });
  env.fire(env.deadline());
  const before = env.events.filter(event => event === 'message').length;
  env.send({ type: 'welcome', status: 'authorized', maxPeers: 8, peers: [] });
  env.send({ type: 'challenge', challengeHex: 'ab'.repeat(32) });
  await eventually(() => env.events.filter(event => event === 'message').length === before + 2);
  assert.equal(env.sockets[0].destroyed, false, 'close handshake still pending');
  assert.equal(env.engine.status().gatewayState, 'offline');
  assert.equal(env.engine.status().maxPeers, null);
  assert.deepEqual(env.sent, [], 'late challenge must not send authentication');
});

test('replaced client late messages cannot alter new connection or send auth', async t => {
  const env = await setup(t, { replyClose: false });
  const oldSocket = env.sockets[0];
  env.engine.leaveNetwork();
  writePeerNetwork(env.options.stateFile, env.network);
  env.engine.resumeFromState();
  await eventually(() => env.events.filter(event => event === 'open').length === 2);
  const newDeadline = env.deadline();
  const before = env.events.filter(event => event === 'message').length;
  oldSocket.write(Buffer.concat([
    frame({ type: 'welcome', status: 'authorized', maxPeers: 64, peers: [] }),
    frame({ type: 'challenge', challengeHex: 'cd'.repeat(32) }),
  ]));
  await eventually(() => env.events.filter(event => event === 'message').length === before + 2);
  assert.equal(env.engine.status().gatewayState, 'connecting');
  assert.equal(env.engine.status().maxPeers, null);
  assert.equal(env.deadline(), newDeadline);
  assert.deepEqual(env.sent, [], 'old challenge must not authenticate the replacement');
});

test('challenge does not renew deadline; invalid welcome does not satisfy authentication', async t => {
  const env = await setup(t);
  const deadline = env.deadline();
  assert.ok(deadline, 'initial authentication deadline');
  env.send({ type: 'challenge', challengeHex: 'ab'.repeat(32) });
  await eventually(() => env.authFrames() > 0);
  env.send({ type: 'welcome', status: 'unknown', maxPeers: 64 });
  // A second challenge confirms the preceding invalid welcome was processed.
  env.send({ type: 'challenge', challengeHex: 'cd'.repeat(32) });
  await eventually(() => env.authFrames() > 1);
  assert.equal(env.deadline(), deadline);
  assert.equal(env.engine.status().maxPeers, null);
  env.fire(deadline);
  assert.equal(env.engine.status().gatewayState, 'offline');
});

for (const status of ['authorized', 'pending', 'mismatch']) {
  test(`valid welcome ${status} clears deadline and ignores stale callback`, async t => {
    const env = await setup(t);
    const deadline = env.deadline();
    assert.ok(deadline);
    env.send({ type: 'welcome', status, maxPeers: 8, peers: [] });
    const expected = status === 'pending' ? 'pending-approval' : status;
    await eventually(() => env.engine.status().gatewayState === expected);
    assert.equal(env.deadline(), undefined);
    deadline.fn();
    assert.equal(env.engine.status().gatewayState, expected);
  });
  test(`welcome ${status} in upgrade head before open never arms auth deadline`, async t => {
    const env = await setup(t, { head: { type: 'welcome', status, maxPeers: 8, peers: [] } });
    assert.ok(env.events.indexOf('message') < env.events.indexOf('open'));
    assert.equal(env.deadline(), undefined);
    assert.equal(env.engine.status().gatewayState, status === 'pending' ? 'pending-approval' : status);
  });
}

test('denied clears deadline without retrying authentication', async t => {
  const env = await setup(t);
  const deadline = env.deadline();
  assert.ok(deadline);
  env.send({ type: 'denied', reason: 'paused' });
  await eventually(() => env.engine.status().gatewayState === 'paused');
  assert.equal(env.deadline(), undefined);
  deadline.fn();
  assert.equal(env.engine.status().gatewayState, 'paused');
});

test('connection close clears old deadline and stale callback cannot close replacement', async t => {
  const env = await setup(t);
  const oldDeadline = env.deadline();
  assert.ok(oldDeadline);
  env.sockets[0].destroy();
  await eventually(() => env.timers.some(timer => timer.active && timer.ms === 1000));
  assert.equal(env.deadline(), undefined);
  env.fire(env.timers.find(timer => timer.active && timer.ms === 1000));
  await eventually(() => env.sockets.length === 2 && env.deadline());
  const replacement = env.deadline();
  oldDeadline.fn();
  assert.equal(env.deadline(), replacement);
  assert.equal(env.engine.status().gatewayState, 'connecting');
});

for (const method of ['leaveNetwork', 'stop']) {
  test(`${method} clears authentication deadline and late callback is harmless`, async t => {
    const env = await setup(t);
    const deadline = env.deadline();
    assert.ok(deadline);
    env.engine[method]();
    assert.equal(env.deadline(), undefined);
    deadline.fn();
    assert.equal(env.engine.status().gatewayState, 'unconfigured');
  });
}

test('authentication deadline rejects invalid timing options', async t => {
  const { options } = await setup(t);
  for (const wsAuthTimeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
    assert.throws(() => createPeerEngine({ ...options, wsAuthTimeoutMs }), /wsAuthTimeoutMs/);
  }
});
