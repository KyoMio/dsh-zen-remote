// Source-only regression: no shared dist writes, real SQLite plus deterministic async barriers.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, createHmac } from 'node:crypto';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) };
    return next(url, context);
  },
});
const { SqliteStore } = await import('../src/store/sqlite-store.ts');
const { PeerWsHub } = await import('../src/peer-hub/ws-hub.ts');
const { UdpStunService } = await import('../src/peer-hub/udp-stun.ts');
const { encryptSecret } = await import('../src/master-key.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  return { publicKeyHex, privateKey, nodeId: createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 8) };
}
class Ws extends EventEmitter {
  OPEN = 1; readyState = 1; sent = [];
  send(data, options, cb) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); if (typeof options === 'function') options(); cb?.(); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
async function fixture(t, admissionMode = 'key') {
  const store = new SqliteStore();
  const masterKey = Buffer.alloc(32, 1);
  const owner = await store.createUser({ email: 'test@example.invalid', passwordHash: 'unused', role: 'user' });
  const network = await store.createNetwork({ ownerId: owner.id, name: 'test', admissionMode, maxPeers: 16, joinKeyEnc: encryptSecret('join-key', masterKey) });
  const hub = new PeerWsHub({ store, masterKey, rateTickMs: null, flushMs: null });
  t.after(async () => { await hub.close(); await store.close(); });
  function connect(id = identity(), proof = true) {
    const ws = new Ws(); hub.setupConnection(ws, '127.0.0.1');
    const challengeHex = ws.sent[0].challengeHex, timestamp = Date.now();
    const msg = { type: 'auth', networkId: network.id, nodeId: id.nodeId, publicKeyHex: id.publicKeyHex, timestamp,
      signatureHex: sign(null, Buffer.from(`zr-gw-auth-v1|${network.id}|${id.nodeId}|${challengeHex}|${timestamp}`), id.privateKey).toString('hex') };
    if (proof) msg.joinKeyProofHex = createHmac('sha256', 'join-key').update(`zr-join-v1|${network.id}|${id.nodeId}|${challengeHex}`).digest('hex');
    ws.emit('message', Buffer.from(JSON.stringify(msg)), false); return ws;
  }
  async function disable() { await store.setUserActive(owner.id, false); await hub.hooks.onUserDisabled(owner.id); }
  return { store, owner, network, hub, connect, disable };
}
function denied(ws) { assert.equal(ws.sent.some(m => m.type === 'welcome' && m.status === 'authorized'), false); assert.equal(ws.readyState, 3); }
function barrier(object, method, call = 1) {
  const original = object[method].bind(object);
  let release, arrived, count = 0;
  const reached = new Promise(resolve => { arrived = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  object[method] = async (...args) => { const result = await original(...args); if (++count === call) { arrived(); await wait; } return result; };
  return { reached, release };
}
test('disabled owner rejects existing and new members; active owner can reconnect after re-enable', async t => {
  const f = await fixture(t), id = identity();
  const first = f.connect(id); await tick();
  assert.equal(f.hub.getOnlineCountByNetwork(f.network.id), 1);
  await f.disable(); assert.equal(first.readyState, 3);
  const old = f.connect(id, false), fresh = f.connect(); await tick(); denied(old); denied(fresh);
  assert.equal((await f.store.listMembers(f.network.id)).length, 1);
  await f.store.setUserActive(f.owner.id, true);
  f.connect(id, false); await tick(); assert.equal(f.hub.getOnlineCountByNetwork(f.network.id), 1);
});
for (const [method, call] of [['getNetwork', 1], ['upsertMemberJoinAttempt', 1], ['findUserById', 2]]) {
  test(`disable while auth awaits ${method} prevents stale admission`, async t => {
    const f = await fixture(t), b = barrier(f.store, method, call);
    const ws = f.connect(); await b.reached; await f.disable(); b.release(); await tick(); denied(ws);
    assert.equal(f.hub.getOnlineCountByNetwork(f.network.id), 0);
  });
}
for (const method of ['getNetwork', 'upsertMemberJoinAttempt']) {
  test(`disabling another owner preserves auth awaiting ${method}`, async t => {
    const f = await fixture(t);
    const other = await f.store.createUser({ email: 'other@example.invalid', passwordHash: 'unused', role: 'user' });
    const b = barrier(f.store, method), ws = f.connect();
    await b.reached;
    await f.store.setUserActive(other.id, false);
    await f.hub.hooks.onUserDisabled(other.id);
    b.release(); await tick();
    assert(ws.sent.some(m => m.type === 'welcome' && m.status === 'authorized'));
    assert.equal(f.hub.getOnlineCountByNetwork(f.network.id), 1);
  });
}
test('disable then re-enable cannot revive an older in-flight auth', async t => {
  const f = await fixture(t), b = barrier(f.store, 'getNetwork');
  const ws = f.connect(); await b.reached; await f.disable();
  await f.store.setUserActive(f.owner.id, true);
  b.release(); await tick(); denied(ws);
  f.connect(); await tick(); assert.equal(f.hub.getOnlineCountByNetwork(f.network.id), 1);
});
test('socket closed during auth cannot become an online ghost', async t => {
  const f = await fixture(t), b = barrier(f.store, 'upsertMemberJoinAttempt');
  const ws = f.connect(); await b.reached; ws.close(); b.release(); await tick();
  assert.equal(f.hub.getOnlineCountByNetwork(f.network.id), 0);
});
for (const action of ['approve', 'repin']) {
  test(`disable during hanging ${action} does not resurrect connection`, async t => {
    const f = await fixture(t, 'manual'), id = identity(), ws = f.connect(id, false); await tick();
    assert(ws.sent.some(m => m.status === 'pending'));
    assert.equal(typeof f.hub.admitStunProbe(f.network.id, id.nodeId, id.publicKeyHex), 'symbol');
    assert.equal(f.hub.admitStunProbe(f.network.id, id.nodeId, '00'.repeat(32)), null);
    await f.store.transitionMemberStatus(f.network.id, id.nodeId, 'approve');
    const b = barrier(f.store, 'listMembers');
    const promoting = f.hub.hooks.onMemberChanged({ action, networkId: f.network.id, nodeId: id.nodeId });
    await b.reached; await f.disable(); b.release(); await promoting;
    assert.equal(ws.readyState, 3); assert.equal(f.hub.getOnlineCountByNetwork(f.network.id), 0);
  });
}
test('missing owner and owner storage failure fail closed', async t => {
  const f = await fixture(t);
  for (const lookup of [async () => null, async () => { throw Error('offline'); }]) {
    f.store.findUserById = lookup;
    const ws = f.connect(); await tick(); denied(ws);
  }
});
test('production gateway binds UDP admission to the live hub', async t => {
  const { startGateway } = await import('../src/main.ts');
  const { resolveGatewayConfig } = await import('../src/config.ts');
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'owner-admission-'));
  const gateway = await startGateway({ ...resolveGatewayConfig({}), port: 0, udpAltPort: 0, dataDir: dir, adminPassword: 'test-password-123' });
  t.after(async () => {
    await gateway.close();
    assert.equal(path.dirname(realpathSync(dir)), realpathSync(tmpdir()));
    assert(path.basename(dir).startsWith('owner-admission-'));
    rmSync(dir, { recursive: true });
  });
  assert.equal(typeof gateway.udp.options.admitProbe, 'function');
  assert.equal(gateway.udp.options.admitProbe('1234567890abcdef', '12345678', '00'.repeat(32)), null);
  const admission = Symbol();
  gateway.hub.admitStunProbe = (...args) => args.join('|') === 'network|node|key' ? admission : null;
  assert.equal(gateway.udp.options.admitProbe('network', 'node', 'key'), admission);
});

for (const delayedReply of [true, false]) {
  test(`STUN cannot reuse an old connection ${delayedReply ? 'send callback' : 'primary slot'} after re-enable`, async t => {
    const f = await fixture(t), id = identity(); f.connect(id); await tick();
    const observations = [];
    const udp = new UdpStunService({ primaryPort: 0, admitProbe: (...args) => f.hub.admitStunProbe(...args), onNatDetected: r => observations.push(r) });
    const timestamp = Date.now(), nonce = '0123456789abcdef';
    const packet = Buffer.from(JSON.stringify({ type: 'stun-probe', networkId: f.network.id, nodeId: id.nodeId, publicKeyHex: id.publicKeyHex, timestamp, nonce,
      signatureHex: sign(null, Buffer.from(`zr-stun-probe-v1|${f.network.id}|${id.nodeId}|${nonce}|${timestamp}`), id.privateKey).toString('hex') }));
    const socket = { send(_reply, _port, _ip, cb) { cb(); } }, remote = { address: '127.0.0.1', port: 55555 };
    await udp.handlePacket(socket, 'primary', packet, remote);
    let finish;
    const pending = delayedReply ? udp.handlePacket({ send(_reply, _port, _ip, cb) { finish = cb; } }, 'alt', packet, remote) : null;
    await f.disable(); await f.store.setUserActive(f.owner.id, true);
    f.connect(id, false); await tick();
    if (pending) { finish(); await pending; }
    else await udp.handlePacket(socket, 'alt', packet, remote);
    assert.equal(observations.length, 0, 'old generation must not affect the replacement connection');
    await udp.handlePacket(socket, 'alt', packet, remote);
    await udp.handlePacket(socket, 'primary', packet, remote);
    assert.equal(observations.length, 1, 'two observations in the new generation still classify');
  });
}

test('UDP admission rejects disconnected identity and disable during send suppresses NAT callback', async t => {
  const f = await fixture(t), id = identity(); f.connect(id); await tick();
  const observations = [], sent = [];
  const udp = new UdpStunService({ primaryPort: 0, admitProbe: (...args) => f.hub.admitStunProbe(...args), onNatDetected: r => observations.push(r) });
  const timestamp = Date.now(), nonce = '0123456789abcdef';
  const packet = Buffer.from(JSON.stringify({ type: 'stun-probe', networkId: f.network.id, nodeId: id.nodeId, publicKeyHex: id.publicKeyHex, timestamp, nonce,
    signatureHex: sign(null, Buffer.from(`zr-stun-probe-v1|${f.network.id}|${id.nodeId}|${nonce}|${timestamp}`), id.privateKey).toString('hex') }));
  const socket = { send(reply, port, ip, cb) { sent.push(reply); cb(); } }, remote = { address: '127.0.0.1', port: 55555 };
  await udp.handlePacket(socket, 'primary', packet, remote); assert.equal(sent.length, 1);
  let finish;
  const pending = udp.handlePacket({ send(reply, port, ip, cb) { sent.push(reply); finish = cb; } }, 'alt', packet, remote);
  await f.disable(); finish(); await pending;
  assert.equal(observations.length, 0);
  await udp.handlePacket(socket, 'primary', packet, remote); assert.equal(sent.length, 2);
});
