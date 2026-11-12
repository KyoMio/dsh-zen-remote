const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Load the actual source graph without rebuilding shipping lib/ (also works in Electron).
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
  loaded._compile(ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}
const source = file => loadSource(path.resolve(__dirname, '../src', file));
const { createPeerEngine } = source('peer/engine.ts');
const { createRelayPool } = source('relay-pool.ts');
const { ensurePeerIdentity, writePeerNetwork, readPeerNetwork } = source('state-store.ts');
const { generatePeerIdentity } = source('peer/crypto.ts');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), 'expected state within 500ms');
}
function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}
async function setup(t, { cap = 8, count = 3, gatewayCap = 16, configSource = 'default' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-capacity-test-'));
  const stateFile = path.join(home, 'state.json');
  const identity = ensurePeerIdentity(stateFile);
  const peers = Array.from({ length: count }, (_, i) => ({ ...generatePeerIdentity(), name: `peer-${i}`, lanEndpoints: [] }));
  const sockets = new Set();
  let upstream;
  const server = http.createServer();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); });
  server.on('upgrade', (req, socket) => {
    upstream = socket;
    socket.on('data', () => {});
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(frame({ type: 'welcome', status: 'authorized', maxPeers: gatewayCap,
      peers: peers.map(({ nodeId, publicKeyHex, name, lanEndpoints }) => ({ nodeId, publicKeyHex, name, lanEndpoints })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `127.0.0.1:${server.address().port}`;
  writePeerNetwork(stateFile, { gatewayWsUrl: `ws://${origin}`, gatewayHttpOrigin: `http://${origin}`, networkId: '0123456789abcdef', joinedAt: 1 });
  let localCap = cap;
  const pool = createRelayPool({ stateFile, skipPersistedServers: true,
    getMaxServers: () => localCap, getMaxServersSource: () => configSource,
    getPeerNetworkCap: () => readPeerNetwork(stateFile)?.maxPeersFromGateway,
    computeOwnFingerprints: () => ({}), createClient: () => ({ state: 'online', subscribe: () => () => {}, connect: async () => {}, stop() {} }) });
  const mounts = [];
  const mountVirtual = pool.mountVirtual;
  pool.mountVirtual = function (entry) { mounts.push(entry.entryId); return mountVirtual.call(this, entry); };
  const engine = createPeerEngine({ stateFile, identity, relayPool: pool, relayHandler: () => undefined,
    relaySecret: () => 'test-only', serverName: () => 'test', udpProbe: null,
    clock: { now: Date.now, setTimeout: (fn, ms) => ({ fn, ms }), clearTimeout() {} } });
  t.after(async () => {
    engine.stop();
    pool.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('zr-capacity-test-'));
    fs.rmSync(home, { recursive: true });
  });
  engine.resumeFromState();
  await eventually(() => engine.status().gatewayState === 'authorized');
  return { engine, pool, peers, mounts, stateFile, send: value => upstream.write(frame(value)), setCap: value => { localCap = value; } };
}

test('welcome publishes network capacity, allowing more than default eight remote mounts', async t => {
  const { engine, pool, stateFile } = await setup(t, { count: 9, gatewayCap: 16 });
  assert.equal(readPeerNetwork(stateFile).maxPeersFromGateway, 16);
  assert.equal(engine.status().maxPeers, 16);
  assert.equal(pool.maxServers(), 15, 'network member count includes this node');
  assert.equal(pool.entries().length, 9);
});

test('member departure immediately fills its slot with next eligible peer', async t => {
  const { engine, pool, peers, send } = await setup(t, { cap: 1, count: 2, configSource: 'row' });
  assert.equal(pool.entries()[0].entryId, peers[0].nodeId);
  send({ type: 'peer-left', nodeId: peers[0].nodeId });
  await eventually(() => engine.status().peers.length === 1);
  assert.deepEqual(pool.entries().map(entry => entry.entryId), [peers[1].nodeId]);
});

test('disabling a mounted peer fills slot without mounting a disabled peer again', async t => {
  const { engine, pool, peers } = await setup(t, { cap: 1, count: 3, configSource: 'row' });
  engine.setNodeDisabled(peers[1].nodeId, true);
  engine.setNodeDisabled(peers[0].nodeId, true);
  assert.deepEqual(pool.entries().map(entry => entry.entryId), [peers[2].nodeId]);
});

test('live capacity growth fills eligible slots; shrink preserves existing mounts', async t => {
  const { engine, pool, setCap } = await setup(t, { cap: 1, count: 3, configSource: 'row' });
  assert.equal(pool.entries().length, 1);
  setCap(2);
  engine.refreshMounts();
  assert.equal(pool.entries().length, 2);
  setCap(1);
  engine.refreshMounts();
  assert.equal(pool.maxServers(), 1);
  assert.equal(pool.entries().length, 2);
  engine.stop();
  engine.refreshMounts();
  assert.equal(pool.entries().length, 0);
});

test('actual index volatile-update subscription fills slots after live maxServers edit', async t => {
  const { engine, pool, setCap } = await setup(t, { cap: 1, count: 3, configSource: 'row' });
  const filename = path.resolve(__dirname, '../src/index.ts');
  const ast = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const subscriptions = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.getText(ast) === 'ctx.on'
      && node.arguments[0]?.text === 'loader/volatile-update'
      && node.arguments[1]?.getText(ast).includes('volatileUpdateTouchesServerName')) subscriptions.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(subscriptions.length, 1, 'locate production subscription, not a copied callback');
  const listeners = new Map();
  const code = ts.transpileModule(subscriptions[0].getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { volatileUpdateTouchesServerName } = source('relay-client.ts');
  new Function('ctx', 'peerEngine', 'relayPool', 'volatileUpdateTouchesServerName', 'row', 'unwrapVolatile', code)(
    { on: (event, callback) => listeners.set(event, callback) }, engine, pool, volatileUpdateTouchesServerName,
    {}, () => { throw new Error('maxServers edit must not enter serverName branch'); },
  );
  setCap(2);
  listeners.get('loader/volatile-update')(['maxServers']);
  assert.equal(pool.entries().length, 2, 'production callback must invoke capacity reconciliation');
  setCap(1);
  listeners.get('loader/volatile-update')(['maxServers']);
  assert.equal(pool.entries().length, 2, 'ordinary shrink must retain mounted peers');
});

for (const status of ['pending', 'mismatch', 'denied']) {
  test(`authorized to ${status} removes all mounts and refresh cannot refill`, async t => {
    const { engine, pool, peers, mounts, send, setCap } = await setup(t, { cap: 2, count: 3, configSource: 'row' });
    assert.equal(pool.entries().length, 2);
    const initialMounts = [...mounts];
    send(status === 'denied' ? { type: 'denied', reason: 'revoked' }
      : { type: 'welcome', status, maxPeers: 16, peers });
    const expected = status === 'pending' ? 'pending-approval' : status === 'denied' ? 'revoked' : status;
    await eventually(() => engine.status().gatewayState === expected);
    assert.equal(pool.entries().length, 0);
    assert.equal(engine.status().peers.length, 0);
    assert.deepEqual(mounts, initialMounts, 'no transient refill while authorization is being revoked');
    setCap(8);
    engine.refreshMounts();
    assert.equal(pool.entries().length, 0);
  });
}

test('welcome reconciliation frees departed mounts before filling new members', async t => {
  const { engine, pool, peers, send } = await setup(t, { cap: 1, count: 3, configSource: 'row' });
  send({ type: 'welcome', status: 'authorized', maxPeers: 16, peers: peers.slice(1) });
  await eventually(() => engine.status().peers.length === 2);
  assert.deepEqual(pool.entries().map(entry => entry.entryId), [peers[1].nodeId]);
});

test('gateway growth fills slots, shrink preserves mounts, invalid replacement is ignored', async t => {
  const { engine, pool, peers, send, stateFile } = await setup(t, { count: 3, gatewayCap: 2 });
  assert.equal(pool.entries().length, 1);
  send({ type: 'welcome', status: 'authorized', maxPeers: 4, peers });
  await eventually(() => engine.status().maxPeers === 4);
  assert.equal(pool.entries().length, 3);
  send({ type: 'welcome', status: 'authorized', maxPeers: 2, peers });
  await eventually(() => engine.status().maxPeers === 2);
  assert.equal(pool.maxServers(), 1);
  assert.equal(pool.entries().length, 3);
  send({ type: 'welcome', status: 'authorized', maxPeers: -1, peers: peers.slice(1) });
  await eventually(() => engine.status().peers.length === 2);
  assert.equal(engine.status().maxPeers, 2);
  assert.equal(readPeerNetwork(stateFile).maxPeersFromGateway, 2);
});

test('identity mismatch frees its slot while retaining the blocked member', async t => {
  const { engine, pool, peers, send } = await setup(t, { cap: 1, count: 2, configSource: 'row' });
  send({ type: 'peer-joined', ...peers[0], publicKeyHex: peers[1].publicKeyHex });
  await eventually(() => engine.status().peers[0].state === 'identity-mismatch');
  assert.deepEqual(pool.entries().map(entry => entry.entryId), [peers[1].nodeId]);
});

test('invalid network capacity is ignored without changing user cap', async t => {
  const { pool, engine, stateFile } = await setup(t, { cap: 4, count: 1, gatewayCap: 1, configSource: 'row' });
  assert.equal(pool.maxServers(), 4);
  assert.equal(pool.entries().length, 1);
  assert.equal(engine.status().maxPeers, null);
  assert.equal(readPeerNetwork(stateFile).maxPeersFromGateway, undefined);
});
