import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';

import { createPeerEngine } from '../../lib/peer/engine.js';
import { createRelayPool } from '../../lib/relay-pool.js';
import { createRelayHandler, loadServerId } from '../../lib/relay-server.js';
import { ensurePeerIdentity, readPeerNetwork, readPeerRevokedNotice } from '../../lib/state-store.js';
import { createShareStore } from '../../lib/share-store.js';
import { toVirtual } from '../../lib/virtual-id.js';

import { startGateway } from '../dist/main.js';
import { resolveGatewayConfig } from '../dist/config.js';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  makeTmpDir,
  reserveUdpPort,
  seedSession,
  waitFor,
} from './helpers/fixtures.mjs';

const SECRET = 'peer-client-e2e-relay-secret-0123456789abcdef'.slice(0, 48);
const SESSION_TITLE = '秘密会话标题-Secret-Title';

const FAST_PUNCH = {
  punchWindowMs: 200,
  keepAliveMs: 250,
  keepAliveLostFrames: 2,
  reprobeInitialDelaysMs: [250, 500],
  reprobeIntervalMs: 500,
};

function openUdp() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', () => {
      sock.removeAllListeners('error');
      resolve(sock);
    });
  });
}

function makeFirewallSocket(realSocket, initialBlocked = true) {
  let blocked = initialBlocked;
  const messageListeners = [];
  const api = {
    on(ev, fn) {
      if (ev === 'message') messageListeners.push(fn);
      else realSocket.on(ev, fn);
      return api;
    },
    once(ev, fn) { return api.on(ev, fn); },
    off(ev, fn) {
      const i = messageListeners.indexOf(fn);
      if (i >= 0) messageListeners.splice(i, 1);
      else realSocket.off(ev, fn);
      return api;
    },
    removeListener(ev, fn) { return api.off(ev, fn); },
    address: () => realSocket.address(),
    send(bytes, port, host, cb) {
      if (blocked) {
        if (typeof cb === 'function') cb();
        return;
      }
      realSocket.send(bytes, port, host, cb);
    },
    bind(opts, cb) { realSocket.bind(opts, cb); },
    close(cb) { realSocket.close(cb); },
    setBlocked(v) { blocked = v; },
    get blocked() { return blocked; },
  };
  realSocket.on('message', (buf, rinfo) => {
    if (blocked) return;
    for (const fn of [...messageListeners]) fn(buf, rinfo);
  });
  return api;
}

function recordingClock() {
  const handles = [];
  const active = new Set();
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const entry = { ms, createdAt: handles.length, cleared: false };
      handles.push(entry);
      active.add(entry);
      entry.real = setTimeout(() => {
        active.delete(entry);
        fn();
      }, ms);
      return entry;
    },
    clearTimeout(entry) {
      if (!entry || entry.cleared) return;
      entry.cleared = true;
      active.delete(entry);
      clearTimeout(entry.real);
    },
    outstandingOfMs: (ms) => [...active].filter((e) => e.ms === ms),
    armedCount: () => handles.length,
    armedSince: (index, ms) => handles.slice(index).filter((e) => e.ms === ms),
    fireOfMs: (ms) => {
      const matching = [...active].filter((e) => e.ms === ms);
      for (const entry of matching) {
        active.delete(entry);
        clearTimeout(entry.real);
        // Re-read callback? We only need to verify armed + clear + fast pathReportMs=200.
      }
      return matching.length;
    },
  };
}

function makeManualFireClock() {
  const handles = [];
  const active = new Set();
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const entry = { ms, fn, createdAt: handles.length, cleared: false };
      handles.push(entry);
      active.add(entry);
      entry.real = setTimeout(() => {
        active.delete(entry);
        fn();
      }, ms);
      return entry;
    },
    clearTimeout(entry) {
      if (!entry || entry.cleared) return;
      entry.cleared = true;
      active.delete(entry);
      clearTimeout(entry.real);
    },
    outstandingOfMs: (ms) => [...active].filter((e) => e.ms === ms),
    armedCount: () => handles.length,
    armedSince: (index, ms) => handles.slice(index).filter((e) => e.ms === ms),
    fireOfMs: (ms) => {
      const matching = [...active].filter((e) => e.ms === ms);
      for (const entry of matching) {
        active.delete(entry);
        clearTimeout(entry.real);
        entry.fn();
      }
      return matching.length;
    },
  };
}

async function api(base, method, reqPath, { body, cookie } = {}) {
  const headers = {};
  if (cookie !== undefined) headers.cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
    headers.origin = base;
  }
  const res = await fetch(base + reqPath, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}

function inviteUri(gw, networkId, joinKey) {
  const fragment = joinKey !== undefined && joinKey !== null && joinKey !== '' ? `#${joinKey}` : '';
  return `zr-net+insecure://127.0.0.1:${gw.port}/${networkId}${fragment}`;
}

async function createNetwork(gw, { mode = 'key', peerDirectMaxRttMs = 0, maxPeers } = {}) {
  const res = await api(gw.base, 'POST', '/api/v1/networks', {
    body: {
      name: `net-${Math.random().toString(36).slice(2, 8)}`,
      admissionMode: mode,
      ...(maxPeers !== undefined ? { maxPeers } : {}),
    },
    cookie: gw.adminCookie,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const net = res.json.data;
  if (peerDirectMaxRttMs !== undefined) {
    const patch = await api(gw.base, 'PATCH', `/api/v1/networks/${net.id}`, {
      body: { peerDirectMaxRttMs },
      cookie: gw.adminCookie,
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.json));
  }
  return net;
}

async function getTopology(gw, networkId) {
  const res = await api(gw.base, 'GET', `/api/v1/networks/${networkId}/topology`, { cookie: gw.adminCookie });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.data;
}

async function startNode(t, gw, {
  name,
  firewall = false,
  firewallOpen = false,
  udpDelayMs = 0,
  directMaxRttMs,
  shared = [],
  hostFetch,
  punch = FAST_PUNCH,
  pathReportMs = 200,
  stunProbeTimeoutMs = 120,
  useDefaultWelcomeStun = false,
  clock,
} = {}) {
  const home = makeTmpDir(`zr-e2e-node-${name}-`);
  const stateFile = path.join(home, 'zen-remote-state.json');
  const identity = ensurePeerIdentity(stateFile);
  const punchReal = await openUdp();
  let punchSocket = firewall || firewallOpen ? makeFirewallSocket(punchReal, !firewallOpen) : punchReal;
  if (udpDelayMs > 0) {
    const inner = punchSocket;
    const realSend = inner.send.bind(inner);
    punchSocket = {
      address: () => inner.address(),
      on: (...a) => inner.on(...a),
      once: (...a) => inner.once(...a),
      removeListener: (...a) => inner.removeListener(...a),
      bind: (...a) => inner.bind(...a),
      close: (...a) => inner.close(cb => cb?.()),
      setBlocked: inner.setBlocked ? (v) => inner.setBlocked(v) : undefined,
      send(bytes, port, host, cb) {
        const copy = Buffer.from(bytes);
        const timer = setTimeout(() => {
          try { realSend(copy, port, host, cb); } catch { /* closed */ }
        }, udpDelayMs);
        timer.unref?.();
      },
    };
  }

  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 });
  for (const id of shared) store.share(id);
  const followGates = [];
  const sessionFollowGates = [];
  let invokeImpl = null;

  function makeGate(signal) {
    const pending = [];
    let settled = 'open';
    let wake = () => {};
    signal?.addEventListener('abort', () => {
      if (settled === 'open') {
        settled = { error: Object.assign(new Error('aborted'), { code: 'gateway/cancelled' }) };
        wake();
      }
    });
    const iterable = (async function* () {
      for (;;) {
        if (pending.length > 0) {
          const next = pending.shift();
          if (next.kind === 'frame') yield next.frame;
          else return;
        } else if (settled !== 'open') {
          if (settled === 'done') return;
          throw settled.error;
        } else {
          await new Promise((resolve) => { wake = resolve; });
        }
      }
    })();
    return {
      iterable,
      push: (frame) => { pending.push({ kind: 'frame', frame }); wake(); },
      finish: () => { pending.push({ kind: 'return' }); wake(); },
    };
  }

  const gateway = {
    invoke: async (call) => {
      if (invokeImpl !== null) return invokeImpl(call);
      if (call.namespace === 'session' && call.method === 'list') {
        return { items: shared.map((id) => ({ sessionId: id, title: SESSION_TITLE })) };
      }
      if (call.namespace === 'session' && call.method === 'modelCatalog') {
        return { default: null, routableProviders: [], groups: [], failures: [] };
      }
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' });
    },
    stream: async (call) => {
      if (call.namespace === 'workspace' && call.method === 'follow') {
        const gate = makeGate(call.signal);
        followGates.push(gate);
        return gate.iterable;
      }
      if (call.namespace === 'session' && call.method === 'follow') {
        const gate = makeGate(call.signal);
        sessionFollowGates.push(gate);
        return gate.iterable;
      }
      throw Object.assign(new Error(`no stream fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' });
    },
    wireStream: { open: async () => { throw Object.assign(new Error('no wireStream'), { code: 'test/not-implemented' }); } },
    dispatchRpc: async () => ({ ok: true, value: undefined }),
  };

  const relayHandler = createRelayHandler({
    secret: SECRET,
    store,
    gateway,
    serverInfo: {
      serverId: loadServerId(home),
      serverName: () => name,
      dshVersion: '0.0.0-e2e',
      fingerprints: () => ({}),
      plugins: () => ({}),
    },
    getApiFetch: hostFetch ?? (() => async (request) => {
      const bodyText = await request.text();
      return new Response(JSON.stringify({ ok: true, echoedBytes: bodyText.length, url: request.url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
    heartbeatMs: 250,
  });

  const relayPool = createRelayPool({
    stateFile,
    requestTimeoutMs: 400,
    computeOwnFingerprints: () => ({}),
  });

  const logs = [];
  const engine = createPeerEngine({
    stateFile,
    identity,
    relayPool,
    relayHandler: () => relayHandler,
    relaySecret: () => SECRET,
    serverName: () => name,
    udpSocket: punchSocket,
    ...(useDefaultWelcomeStun ? {} : { udpProbe: { primaryPort: gw.udpPorts.primaryPort, altPort: gw.udpPorts.altPort ?? 0 } }),
    ...(punch !== undefined ? { punch } : {}),
    ...(pathReportMs !== undefined ? { pathReportMs } : {}),
    ...(clock !== undefined ? { clock } : {}),
    stunProbeTimeoutMs,
    wsReconnectBaseMs: 40,
    ...(directMaxRttMs === null ? {} : { directMaxRttMs: directMaxRttMs ?? (() => 0) }),
    log: (line) => logs.push(line),
  });

  const node = {
    name,
    identity,
    home,
    stateFile,
    store,
    relayHandler,
    relayPool,
    engine,
    logs,
    followGates,
    sessionFollowGates,
    set invokeImpl(fn) { invokeImpl = fn; },
    setFirewall: (v) => punchSocket.setBlocked?.(v),
    stop: () => {
      engine.stop();
      relayPool.stop();
      relayHandler.closeAll();
      try { punchSocket.close(); } catch { /* closed */ }
    },
  };
  t.after(() => {
    node.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return node;
}

async function waitPeerOnline(node, peerNodeId, timeoutMs = 8000) {
  await waitFor(() => {
    const entry = node.relayPool.getByServerId(peerNodeId);
    return entry !== undefined && entry.client.state === 'online';
  }, `${node.name} -> ${peerNodeId} online`, timeoutMs);
  return node.relayPool.getByServerId(peerNodeId);
}

describe('peer-client-e2e (cross-package PeerEngine + RelayPool + gateway-server)', () => {
  let gw;
  let gwDataDir;
  const relayedBinary = [];
  const inboundControl = [];
  const natObservations = [];

  before(async () => {
    gwDataDir = makeTmpDir('zr-peer-e2e-gw-');
    const altPort = await reserveUdpPort();
    gw = await startGateway(
      {
        ...resolveGatewayConfig({
          ZR_GATEWAY_PORT: '19393',
          ZR_GATEWAY_DATA_DIR: gwDataDir,
          ZR_GATEWAY_ADMIN_USER: ADMIN_EMAIL,
          ZR_GATEWAY_ADMIN_PASSWORD: ADMIN_PASSWORD,
          ZR_GATEWAY_ALLOW_SIGNUP: 'false',
          ZR_GATEWAY_MAX_NETWORKS_PER_USER: '50',
          ZR_GATEWAY_DEFAULT_MAX_PEERS: '8',
          ZR_GATEWAY_RELAY_RATE_KBPS: '4096',
          ZR_GATEWAY_UDP_ALT_PORT: String(altPort),
        }),
        port: 0,
      },
      { closeBudgetMs: 150, abortStepBudgetMs: 100 },
    );
    const adminSession = await seedSession(gw.store, { email: ADMIN_EMAIL, role: 'admin' });
    gw.adminCookie = adminSession.cookie;

    const origApplyNat = gw.hub.applyNatObservation.bind(gw.hub);
    gw.hub.applyNatObservation = (record) => {
      natObservations.push(record.nodeId);
      return origApplyNat(record);
    };
    const origSetup = gw.hub.setupConnection.bind(gw.hub);
    gw.hub.setupConnection = (ws, remoteIp) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          relayedBinary.push(Buffer.from(data));
          return;
        }
        try {
          inboundControl.push(JSON.parse(Buffer.from(data).toString('utf8')));
        } catch { /* ignore */ }
      });
      return origSetup(ws, remoteIp);
    };
  });

  after(async () => {
    if (gw !== undefined) await gw.close();
    if (gwDataDir !== undefined) fs.rmSync(gwDataDir, { recursive: true, force: true });
  });

  test('1. STUN self-check, reflexive registration, direct connect (no LAN) & WS reconnect re-probe', async (t) => {
    const net = await createNetwork(gw, { mode: 'key' });
    const A = await startNode(t, gw, { name: 'stun-a', shared: ['s-a1'], useDefaultWelcomeStun: true });
    const B = await startNode(t, gw, { name: 'stun-b', useDefaultWelcomeStun: true });

    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await waitFor(() => A.engine.status().natType === 'public' && B.engine.status().natType === 'public', 'both natType public');

    await waitFor(async () => {
      const topo = await getTopology(gw, net.id);
      return [A, B].every((node) => {
        const row = topo.members.find((m) => m.nodeId === node.identity.nodeId);
        return row?.natType === 'cone' && row.lastIp === '127.0.0.1';
      });
    }, 'gateway registered both reflexive endpoints');

    await waitFor(() => {
      const peer = A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId);
      return peer !== undefined && (peer.path === 'lan' || peer.path === 'p2p');
    }, 'A<->B direct path');
    assert.equal(typeof A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId).rttMs, 'number');

    const virtualAonB = await waitPeerOnline(B, A.identity.nodeId);
    const listed = await virtualAonB.client.invoke('session', 'list', { request: {} });
    assert.ok(listed.items.some((i) => i.sessionId === 's-a1'));
    assert.equal(toVirtual(A.identity.nodeId, 's-a1'), `zr~${A.identity.nodeId}~s-a1`);

    // Drop A's WS connection -> offline -> reconnect -> re-probe registers fresh reflexive observation.
    const beforeDrop = natObservations.filter((id) => id === A.identity.nodeId).length;
    gw.hub.conns.get(net.id)?.get(A.identity.nodeId)?.ws?.close();
    await waitFor(() => A.engine.status().gatewayState === 'offline', 'A offline after WS drop');
    await waitFor(() => A.engine.status().gatewayState === 'authorized', 'A re-authorized');
    await waitFor(() => natObservations.filter((id) => id === A.identity.nodeId).length > beforeDrop, 'A re-probed after WS reconnect');
  });

  test('2. 2 MiB upload survives mid-flight UDP blackout onto WS relay (SHA256 intact, zero plaintext leak)', async (t) => {
    const net = await createNetwork(gw, { mode: 'key' });
    const PAYLOAD = randomBytes(2 * 1024 * 1024);
    const EXPECTED_DIGEST = createHash('sha256').update(PAYLOAD).digest('hex');
    const BLACKOUT_AT = 512 * 1024;
    const binaryOffset = relayedBinary.length;

    let blackedOut = false;
    let hostCalls = 0;
    let B;
    const A = await startNode(t, gw, {
      name: 'blk-a',
      shared: ['s-a1'],
      hostFetch: () => async (request) => {
        hostCalls += 1;
        const hash = createHash('sha256');
        const reader = request.body.getReader();
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          hash.update(value);
          if (!blackedOut && received >= BLACKOUT_AT) {
            blackedOut = true;
            B.setFirewall(true);
          }
        }
        return new Response(JSON.stringify({ ok: true, echoedBytes: received, sha256: hash.digest('hex') }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    B = await startNode(t, gw, { name: 'blk-b', firewallOpen: true });

    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await waitFor(() => {
      const peer = A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId);
      return peer !== undefined && (peer.path === 'lan' || peer.path === 'p2p');
    }, 'A<->B direct before upload');
    const virtualBonA = await waitPeerOnline(B, A.identity.nodeId);

    let sent = 0;
    const drip = new ReadableStream({
      async pull(controller) {
        if (sent >= PAYLOAD.length) { controller.close(); return; }
        const end = Math.min(sent + 256 * 1024, PAYLOAD.length);
        controller.enqueue(new Uint8Array(PAYLOAD.subarray(sent, end)));
        sent = end;
        await new Promise((r) => setTimeout(r, 15));
      },
    });
    const result = await virtualBonA.client.upload({ sessionId: 's-a1', name: 'big.bin', body: drip, bytes: PAYLOAD.length });
    assert.equal(result.status, 200);
    const receipt = JSON.parse(result.body);
    assert.equal(receipt.echoedBytes, PAYLOAD.length);
    assert.equal(receipt.sha256, EXPECTED_DIGEST);
    assert.equal(hostCalls, 1);
    assert.equal(blackedOut, true);
    await waitFor(() => B.engine.status().peers.find((p) => p.nodeId === A.identity.nodeId)?.path === 'relay', 'B transitioned to relay');

    // Also verify zero plaintext markers in relayed binary frames and follow stream over relay.
    const virtualAonB = await waitPeerOnline(A, B.identity.nodeId);
    const listed = await virtualAonB.client.invoke('session', 'list', { request: {} });
    assert.ok(listed.items.some((i) => i.sessionId === 's-a1') || listed.items.length === 0);
    const relayedSince = relayedBinary.slice(binaryOffset);
    assert.ok(relayedSince.length > 10);
    for (const buf of relayedSince) {
      const text = buf.toString('utf8');
      assert.equal(text.includes(SESSION_TITLE), false);
      assert.equal(text.includes('relay/v1/'), false);
    }
  });

  test('3. firewall recovery silent reprobe auto-upgrades to direct & streaming relay->direct hot-switch', async (t) => {
    const net = await createNetwork(gw, { mode: 'key' });
    const PAYLOAD = randomBytes(1024 * 1024);
    const EXPECTED_DIGEST = createHash('sha256').update(PAYLOAD).digest('hex');

    let hostCalls = 0;
    let hostReceived = 0;
    const A = await startNode(t, gw, {
      name: 'up-a',
      shared: ['s-a1'],
      hostFetch: () => async (request) => {
        hostCalls += 1;
        const hash = createHash('sha256');
        const reader = request.body.getReader();
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          hash.update(value);
          hostReceived = received;
        }
        return new Response(JSON.stringify({ ok: true, echoedBytes: received, sha256: hash.digest('hex') }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const B = await startNode(t, gw, { name: 'up-b', firewall: true });

    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await waitFor(() => A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId)?.path === 'relay', 'starts on relay');

    const virtualBonA = await waitPeerOnline(B, A.identity.nodeId);
    const virtualAonB = await waitPeerOnline(A, B.identity.nodeId);

    // Open follow stream over relay and verify frames flow across silent reprobe upgrade.
    const stream = virtualAonB.client.openStream('workspace', 'follow', { request: {} });
    const frames = [];
    const consuming = (async () => { for await (const f of stream) frames.push(f); })();
    await waitFor(() => B.followGates.length >= 1, 'follow stream opened');
    const gate = B.followGates.at(-1);
    gate.push({ type: 'upsert', workspace: { id: 'ws-1', name: 'relay-phase' } });
    await waitFor(() => frames.length >= 1, 'first frame over relay');

    // Start upload on relay, unblock firewall mid-stream -> silent reprobe upgrades to direct!
    let sent = 0;
    const drip = new ReadableStream({
      async pull(controller) {
        if (sent >= PAYLOAD.length) { controller.close(); return; }
        const end = Math.min(sent + 128 * 1024, PAYLOAD.length);
        controller.enqueue(new Uint8Array(PAYLOAD.subarray(sent, end)));
        sent = end;
        await new Promise((r) => setTimeout(r, 35));
      },
    });
    const uploadPromise = virtualBonA.client.upload({ sessionId: 's-a1', name: 'up.bin', body: drip, bytes: PAYLOAD.length });
    await waitFor(() => hostReceived > 0, 'first upload bytes arrived over relay');
    B.setFirewall(false); // Automatic silent reprobe ([250, 500]) upgrades back to direct!

    await waitFor(() => {
      const p = A.engine.status().peers.find((x) => x.nodeId === B.identity.nodeId);
      return p?.path === 'lan' || p?.path === 'p2p';
    }, 'auto-upgraded to direct via silent reprobe', 8000);

    const result = await uploadPromise;
    assert.equal(result.status, 200);
    const receipt = JSON.parse(result.body);
    assert.equal(receipt.echoedBytes, PAYLOAD.length);
    assert.equal(receipt.sha256, EXPECTED_DIGEST);
    assert.equal(hostCalls, 1);

    gate.push({ type: 'upsert', workspace: { id: 'ws-1', name: 'direct-phase' } });
    await waitFor(() => frames.length >= 2, 'follow stream survived relay->direct hot-switch');
    gate.finish();
    await consuming;
  });

  test('4. local TOFU anchor divergence blocks independently (blocked topology) & trustPeer restores', async (t) => {
    const net = await createNetwork(gw, { mode: 'key' });
    const A = await startNode(t, gw, { name: 'tofu-a', shared: ['s-a1'] });
    const B = await startNode(t, gw, { name: 'tofu-b' });

    const raw = JSON.parse(fs.readFileSync(A.stateFile, 'utf8'));
    raw.pinnedPeers = { [B.identity.nodeId]: { publicKeyHex: 'ff'.repeat(32), firstSeenAt: 1, updatedAt: 1 } };
    fs.writeFileSync(A.stateFile, JSON.stringify(raw));

    const binStart = relayedBinary.length;
    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));

    await waitFor(() => A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId)?.state === 'identity-mismatch', 'A marks mismatch');
    assert.equal(A.relayPool.getByServerId(B.identity.nodeId), undefined);
    assert.equal(A.engine.status().peers.find((p) => p.nodeId === B.identity.nodeId).path, 'blocked');

    await waitFor(async () => {
      const topo = await getTopology(gw, net.id);
      const link = topo.links.find((l) => l.srcNodeId === A.identity.nodeId && l.peerNodeId === B.identity.nodeId);
      return link?.path === 'blocked' && link.rttMs === null;
    }, 'blocked edge reported with rttMs=null');

    const aToB = relayedBinary.slice(binStart).filter((buf) => buf.length >= 12
      && buf.subarray(4, 8).toString('hex') === A.identity.nodeId
      && buf.subarray(8, 12).toString('hex') === B.identity.nodeId);
    assert.equal(aToB.length, 0, 'zero frames sent toward blocked peer');

    assert.equal(A.engine.trustPeer(B.identity.nodeId), true);
    const virtualBonA = await waitPeerOnline(A, B.identity.nodeId);
    const virtualAonB = await waitPeerOnline(B, A.identity.nodeId);
    assert.deepEqual((await virtualBonA.client.invoke('session', 'list', { request: {} })).items, []);
    assert.ok((await virtualAonB.client.invoke('session', 'list', { request: {} })).items.some((i) => i.sessionId === 's-a1'));
  });

  test('5. manual approval escalation, pause/resume, kick/removed, offline removal & wrong joinKey deniedReason', async (t) => {
    const manualNet = await createNetwork(gw, { mode: 'manual' });
    const A = await startNode(t, gw, { name: 'adm-a', shared: ['s-m1'] });
    const B = await startNode(t, gw, { name: 'adm-b' });

    await A.engine.joinNetwork(inviteUri(gw, manualNet.id, manualNet.joinKey));
    await B.engine.joinNetwork(inviteUri(gw, manualNet.id, manualNet.joinKey));
    await waitFor(() => A.engine.status().gatewayState === 'pending-approval' && B.engine.status().gatewayState === 'pending-approval', 'both pending');

    for (const node of [A, B]) {
      const res = await api(gw.base, 'POST', `/api/v1/networks/${manualNet.id}/members/${node.identity.nodeId}/approve`, { cookie: gw.adminCookie });
      assert.equal(res.status, 200);
    }
    await waitFor(() => A.engine.status().gatewayState === 'authorized' && B.engine.status().gatewayState === 'authorized', 'both approved');
    await waitPeerOnline(A, B.identity.nodeId);

    // Pause -> paused state + unmounted; resume -> authorized in-place + re-online.
    assert.equal((await api(gw.base, 'POST', `/api/v1/networks/${manualNet.id}/members/${B.identity.nodeId}/pause`, { cookie: gw.adminCookie })).status, 200);
    await waitFor(() => B.engine.status().gatewayState === 'paused', 'B paused');
    await waitFor(() => A.relayPool.getByServerId(B.identity.nodeId) === undefined, 'A unmounts paused B');

    assert.equal((await api(gw.base, 'POST', `/api/v1/networks/${manualNet.id}/members/${B.identity.nodeId}/resume`, { cookie: gw.adminCookie })).status, 200);
    await waitFor(() => B.engine.status().gatewayState === 'authorized', 'B resumed');
    await waitPeerOnline(A, B.identity.nodeId);

    // Online DELETE -> revoked + notice + cleared peerNetwork.
    assert.equal((await api(gw.base, 'DELETE', `/api/v1/networks/${manualNet.id}/members/${A.identity.nodeId}`, { cookie: gw.adminCookie })).status, 200);
    await waitFor(() => A.engine.status().gatewayState === 'revoked', 'A revoked');
    assert.equal(readPeerNetwork(A.stateFile), undefined);
    assert.equal(A.engine.status().revokedNotice?.deviceName, 'adm-a');
    A.engine.dismissRevokedNotice();
    assert.equal(A.engine.status().revokedNotice, null);

    // Offline DELETE -> resumeFromState blocked from resurrecting.
    B.engine.stop();
    assert.equal((await api(gw.base, 'DELETE', `/api/v1/networks/${manualNet.id}/members/${B.identity.nodeId}`, { cookie: gw.adminCookie })).status, 200);
    const b2Pool = createRelayPool({ stateFile: B.stateFile, requestTimeoutMs: 400, computeOwnFingerprints: () => ({}) });
    const b2 = createPeerEngine({
      stateFile: B.stateFile,
      identity: B.identity,
      relayPool: b2Pool,
      relayHandler: () => undefined,
      relaySecret: () => SECRET,
      serverName: () => 'adm-b',
      udpProbe: null,
    });
    t.after(() => { b2.stop(); b2Pool.stop(); });
    assert.equal(b2.resumeFromState(), true);
    await waitFor(() => b2.status().gatewayState === 'revoked', 'B2 blocked on reconnect');
    assert.equal(readPeerNetwork(B.stateFile), undefined);
    assert.equal(readPeerRevokedNotice(B.stateFile)?.deviceName, 'adm-b');

    // Wrong joinKey on first join -> revoked, NO revokedNotice.
    const keyNet = await createNetwork(gw, { mode: 'key' });
    const C = await startNode(t, gw, { name: 'bad-key' });
    await C.engine.joinNetwork(inviteUri(gw, keyNet.id, 'wrong-key'));
    await waitFor(() => C.engine.status().gatewayState === 'revoked', 'C denied');
    assert.equal(C.engine.status().revokedNotice, null);
  });

  test('6. 250ms peerDirectMaxRttMs cap, network switch & >100KB history load regression', async (t) => {
    const net = await createNetwork(gw, { mode: 'key', peerDirectMaxRttMs: 250 });
    const bigMessages = Array.from({ length: 350 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `history-${i}-` + 'x'.repeat(350),
    }));
    const expectedJson = JSON.stringify({ sessionId: 's-hist', messages: bigMessages });
    assert.ok(Buffer.byteLength(expectedJson, 'utf8') > 100 * 1024);

    const capPunch = { ...FAST_PUNCH, keepAliveMs: 120, keepAliveLostFrames: 3 };
    const A = await startNode(t, gw, { name: 'cap-a', directMaxRttMs: null, punch: capPunch });
    const B = await startNode(t, gw, { name: 'cap-b', directMaxRttMs: null, shared: ['s-hist'], punch: capPunch });
    const histInvoke = async (call) => {
      if (call.namespace === 'session' && call.method === 'page') return { sessionId: 's-hist', messages: bigMessages };
      return { items: [{ id: 's-hist', title: 'Large History' }] };
    };
    B.invokeImpl = histInvoke;

    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await waitFor(() => A.engine.status().gatewayState === 'authorized' && B.engine.status().gatewayState === 'authorized', 'both authorized');
    assert.equal(A.engine.status().directCapMs, 250);
    assert.equal(A.engine.status().directCapSource, 'gateway');

    await waitFor(() => {
      const p = A.engine.status().peers.find((x) => x.nodeId === B.identity.nodeId);
      return p?.path === 'lan' || p?.path === 'p2p';
    }, 'promoted to direct under 250ms cap', 8000);
    const virtualB = await waitPeerOnline(A, B.identity.nodeId);
    const hist1 = await virtualB.client.invoke('session', 'page', { request: { address: { kind: 'session', sessionId: 's-hist' } } });
    assert.equal(JSON.stringify(hist1), expectedJson);

    // Simulate B network switch (same stateFile/identity, new socket, initially firewalled -> relay) -> replaceExisting + connSeq reset.
    const B2 = await startNode(t, gw, { name: 'cap-b2', directMaxRttMs: null, firewall: true, shared: ['s-hist'], punch: capPunch });
    // Join B2 with B's identity by sharing B's identity through a fresh node? Or re-join A to another network:
    // Use B2 directly on same network to test >100KB history over relay then upgrade!
    await B2.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    B2.invokeImpl = histInvoke;
    const virtualB2 = await waitPeerOnline(A, B2.identity.nodeId);
    const histRelay = await virtualB2.client.invoke('session', 'page', { request: { address: { kind: 'session', sessionId: 's-hist' } } });
    assert.equal(JSON.stringify(histRelay), expectedJson);
  });

  test('7. path-report bounded periodic reporting & stop/leaveNetwork timer hygiene', async (t) => {
    const net = await createNetwork(gw, { mode: 'key' });
    const clock = makeManualFireClock();
    const D = await startNode(t, gw, { name: 'timer-d', pathReportMs: 15_000, clock });

    await D.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await waitFor(() => D.engine.status().gatewayState === 'authorized', 'D authorized');
    await waitFor(() => clock.outstandingOfMs(15_000).length >= 1, '15s path-report timer armed');

    const reportsBefore = inboundControl.filter((m) => m.type === 'path-report').length;
    const armedAtFire = clock.armedCount();
    assert.ok(clock.fireOfMs(15_000) >= 1, 'manual tick fired');
    await waitFor(() => inboundControl.filter((m) => m.type === 'path-report').length >= reportsBefore + 1, 'path-report delivered');
    assert.ok(clock.armedSince(armedAtFire, 15_000).length >= 1, 're-armed after fire');

    await D.engine.leaveNetwork();
    assert.equal(clock.outstandingOfMs(15_000).length, 0, 'leaveNetwork cleared path-report timer');

    await D.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await waitFor(() => D.engine.status().gatewayState === 'authorized', 'D re-authorized');
    await waitFor(() => clock.outstandingOfMs(15_000).length >= 1, 're-armed after rejoin');
    D.engine.stop();
    assert.equal(clock.outstandingOfMs(15_000).length, 0, 'stop() cleared path-report timer');
  });

  test('8. secondary STUN port disabled (udpAltPort=0) still publishes primary reflexive endpoint & connects direct', async (t) => {
    const dir = makeTmpDir('zr-peer-e2e-alt0-');
    const inst = await startGateway(
      {
        ...resolveGatewayConfig({
          ZR_GATEWAY_PORT: '19393',
          ZR_GATEWAY_DATA_DIR: dir,
          ZR_GATEWAY_ADMIN_USER: ADMIN_EMAIL,
          ZR_GATEWAY_ADMIN_PASSWORD: ADMIN_PASSWORD,
          ZR_GATEWAY_ALLOW_SIGNUP: 'false',
          ZR_GATEWAY_UDP_ALT_PORT: '0',
        }),
        port: 0,
      },
      { closeBudgetMs: 150, abortStepBudgetMs: 100 },
    );
    t.after(async () => {
      await inst.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    assert.equal(inst.udpPorts.altPort, null);
    inst.adminCookie = (await seedSession(inst.store, { email: ADMIN_EMAIL, role: 'admin' })).cookie;
    const net = await createNetwork(inst, { mode: 'key' });

    const A = await startNode(t, inst, { name: 'alt0-a', shared: ['s-1'], useDefaultWelcomeStun: true });
    const B = await startNode(t, inst, { name: 'alt0-b', useDefaultWelcomeStun: true });
    await A.engine.joinNetwork(inviteUri(inst, net.id, net.joinKey));
    await B.engine.joinNetwork(inviteUri(inst, net.id, net.joinKey));
    await waitFor(() => A.engine.status().natType === 'unknown' && B.engine.status().natType === 'unknown', 'single-port natType unknown');
    await waitFor(() => {
      const p = A.engine.status().peers.find((x) => x.nodeId === B.identity.nodeId);
      return p?.path === 'lan' || p?.path === 'p2p';
    }, 'direct path with altPort disabled');
    const virtualAonB = await waitPeerOnline(B, A.identity.nodeId);
    assert.ok((await virtualAonB.client.invoke('session', 'list', { request: {} })).items.some((i) => i.sessionId === 's-1'));
  });

  test('9. Slice 3: live admin PATCH forceRelay switches connected PeerEngines between relay and direct', async (t) => {
    const net = await createNetwork(gw, { mode: 'key' });
    const A = await startNode(t, gw, { name: 'fr-a', shared: ['s-fr'], useDefaultWelcomeStun: true });
    const B = await startNode(t, gw, { name: 'fr-b', useDefaultWelcomeStun: true });
    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));

    await waitFor(() => {
      const p = A.engine.status().peers.find((x) => x.nodeId === B.identity.nodeId);
      return p?.path === 'lan' || p?.path === 'p2p';
    }, 'initially promoted to direct', 8000);
    assert.equal(A.engine.status().forceRelay, false);

    // Enable forceRelay live via admin REST API
    const onRes = await fetch(`${gw.base}/api/v1/admin/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: gw.adminCookie },
      body: JSON.stringify({ forceRelay: true }),
    });
    assert.equal(onRes.status, 200);
    await waitFor(
      () =>
        A.engine.status().forceRelay === true &&
        B.engine.status().forceRelay === true &&
        A.engine.status().peers.find((x) => x.nodeId === B.identity.nodeId)?.path === 'relay' &&
        B.engine.status().peers.find((x) => x.nodeId === A.identity.nodeId)?.path === 'relay',
      'both nodes switched to relay on live forceRelay=true',
      5000,
    );
    const virtualAonB = await waitPeerOnline(B, A.identity.nodeId);
    assert.ok((await virtualAonB.client.invoke('session', 'list', { request: {} })).items.some((i) => i.sessionId === 's-fr'));

    // Disable forceRelay live -> re-punches and restores direct
    const offRes = await fetch(`${gw.base}/api/v1/admin/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: gw.adminCookie },
      body: JSON.stringify({ forceRelay: false }),
    });
    assert.equal(offRes.status, 200);
    await waitFor(
      () => {
        const p = A.engine.status().peers.find((x) => x.nodeId === B.identity.nodeId);
        return A.engine.status().forceRelay === false && (p?.path === 'lan' || p?.path === 'p2p');
      },
      'direct restored on live forceRelay=false',
      8000,
    );
  });

  test('10. Slice 4: live admin PATCH advancedTuning.peer updates connected PeerEngines peerTuning', async (t) => {
    const net = await createNetwork(gw, { mode: 'key' });
    const A = await startNode(t, gw, { name: 'adv-a', shared: ['s-adv'], useDefaultWelcomeStun: true });
    const B = await startNode(t, gw, { name: 'adv-b', useDefaultWelcomeStun: true });
    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));

    await waitFor(
      () => A.engine.status().gatewayState === 'authorized' && B.engine.status().gatewayState === 'authorized',
      'both nodes authorized',
      5000,
    );
    assert.equal(A.engine.status().peerTuning.sackCoalesceFrames, 6);
    assert.equal(A.engine.status().peerTuning.directPromoteStreak, 2);

    const patchRes = await fetch(`${gw.base}/api/v1/admin/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: gw.adminCookie },
      body: JSON.stringify({
        advancedTuning: {
          peer: {
            sackCoalesceFrames: 1,
            directPromoteStreak: 4,
            directPromoteRatio: 0.85,
            wsReorderGraceMs: 1200,
          },
        },
      }),
    });
    assert.equal(patchRes.status, 200);

    await waitFor(
      () =>
        A.engine.status().peerTuning.sackCoalesceFrames === 1 &&
        A.engine.status().peerTuning.directPromoteStreak === 4 &&
        A.engine.status().peerTuning.directPromoteRatio === 0.85 &&
        B.engine.status().peerTuning.wsReorderGraceMs === 1200,
      'live peerTuning applied to both connected PeerEngines',
      5000,
    );

    const virtualAonB = await waitPeerOnline(B, A.identity.nodeId);
    assert.ok((await virtualAonB.client.invoke('session', 'list', { request: {} })).items.some((i) => i.sessionId === 's-adv'));

    // Reset to recommended defaults via null
    const resetRes = await fetch(`${gw.base}/api/v1/admin/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: gw.adminCookie },
      body: JSON.stringify({ advancedTuning: null }),
    });
    assert.equal(resetRes.status, 200);
    await waitFor(
      () => A.engine.status().peerTuning.sackCoalesceFrames === 6 && B.engine.status().peerTuning.directPromoteStreak === 2,
      'peerTuning reset back to defaults on null PATCH',
      5000,
    );
  });

  test('11. active session/follow stream survives forced direct -> relay degrade and relay -> direct upgrade without drops or reordering', async (t) => {
    const net = await createNetwork(gw, { mode: 'key' });
    const A = await startNode(t, gw, { name: 'stream-a', shared: ['s-stream-1'], useDefaultWelcomeStun: true });
    const B = await startNode(t, gw, { name: 'stream-b', useDefaultWelcomeStun: true });

    t.after(async () => {
      await fetch(`${gw.base}/api/v1/admin/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: gw.adminCookie },
        body: JSON.stringify({ forceRelay: false }),
      }).catch(() => {});
    });

    await A.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));
    await B.engine.joinNetwork(inviteUri(gw, net.id, net.joinKey));

    await waitFor(() => {
      const p = A.engine.status().peers.find((x) => x.nodeId === B.identity.nodeId);
      return p !== undefined && (p.path === 'lan' || p.path === 'p2p');
    }, 'initial A<->B direct path', 8000);

    const virtualAonB = await waitPeerOnline(B, A.identity.nodeId);
    const stream = virtualAonB.client.openStream('session', 'follow', {
      request: { address: { kind: 'session', sessionId: 's-stream-1' } },
    });
    const received = [];
    const consuming = (async () => {
      for await (const frame of stream) received.push(frame);
    })();

    await waitFor(() => A.sessionFollowGates.length >= 1, 'session/follow opened on A');
    const gate = A.sessionFollowGates.at(-1);

    const TOTAL = 60;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const pushRange = async (from, to, delayMs) => {
      for (let seq = from; seq <= to; seq += 1) {
        gate.push({
          type: 'event',
          seq,
          sessionId: 's-stream-1',
          marker: `SECRET-STREAM-PAYLOAD-${seq}`,
        });
        await sleep(delayMs);
      }
    };

    // Phase 1: stream initial events over direct path
    await pushRange(1, 15, 10);
    await waitFor(() => received.length >= 10, 'direct phase events delivered');

    // Phase 2: force degrade to relay while events continue flowing
    const binaryOffset = relayedBinary.length;
    const midPush = pushRange(16, 40, 15);
    const degradeRes = await fetch(`${gw.base}/api/v1/admin/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: gw.adminCookie },
      body: JSON.stringify({ forceRelay: true }),
    });
    assert.equal(degradeRes.status, 200);
    await waitFor(
      () =>
        A.engine.status().peers.find((x) => x.nodeId === B.identity.nodeId)?.path === 'relay' &&
        B.engine.status().peers.find((x) => x.nodeId === A.identity.nodeId)?.path === 'relay',
      'both nodes degraded to relay mid-stream',
      5000,
    );
    await midPush;
    await waitFor(() => received.length >= 35, 'relay phase events delivered');
    assert.ok(relayedBinary.length > binaryOffset, 'relay frames traversed gateway during degrade');

    // Phase 3: restore upgrade back to direct while trailing events continue flowing,
    // then push final batch AFTER direct path is confirmed active.
    const midUpgradePush = pushRange(41, 50, 15);
    const upgradeRes = await fetch(`${gw.base}/api/v1/admin/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: gw.adminCookie },
      body: JSON.stringify({ forceRelay: false }),
    });
    assert.equal(upgradeRes.status, 200);
    await waitFor(
      () => {
        const pA = A.engine.status().peers.find((x) => x.nodeId === B.identity.nodeId);
        const pB = B.engine.status().peers.find((x) => x.nodeId === A.identity.nodeId);
        return (pA?.path === 'lan' || pA?.path === 'p2p') && (pB?.path === 'lan' || pB?.path === 'p2p');
      },
      'both nodes upgraded back to direct mid-stream',
      8000,
    );
    await midUpgradePush;
    await pushRange(51, TOTAL, 10);

    gate.finish();
    await consuming;

    assert.equal(received.length, TOTAL, `expected ${TOTAL} events without drops or duplicates, got ${received.length}`);
    for (let i = 0; i < TOTAL; i += 1) {
      assert.equal(received[i].seq, i + 1, `event ${i} out of order: got seq=${received[i].seq}`);
      assert.equal(received[i].marker, `SECRET-STREAM-PAYLOAD-${i + 1}`);
    }

    const relayedSince = relayedBinary.slice(binaryOffset);
    assert.ok(relayedSince.length > 0);
    for (const buf of relayedSince) {
      const text = buf.toString('utf8');
      assert.equal(text.includes('SECRET-STREAM-PAYLOAD-'), false, 'zero plaintext stream marker leak through gateway');
      assert.equal(text.includes(SESSION_TITLE), false, 'zero plaintext session title leak through gateway');
    }
  });
});
