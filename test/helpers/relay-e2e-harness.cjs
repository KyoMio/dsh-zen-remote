'use strict'
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRelayHandler, loadServerId } = require('../../lib/relay-server.js')
const { createShareStore } = require('../../lib/share-store.js')
const { createRelayClient } = require('../../lib/relay-client.js')
const { startGatewayAt, pairDesktop, stopAll } = require('../util.cjs')

const SECRET = '7e6a5b4c3d2e1f00'.repeat(4)
const SERVER_NAME = '端到端服务器'
const FOLLOW_ARGS = { request: { address: { kind: 'session', sessionId: 'session-a' } } }

function makeFakeHost() {
  return {
    exact: new Map(),
    prefixes: new Map(),
    upgrades: new Map(),
    match(pathname) {
      const exact = this.exact.get(pathname)
      if (exact !== undefined) return exact
      let best
      for (const [prefix, route] of this.prefixes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
        if (best === undefined || prefix.length > best.path.length) best = route
      }
      return best
    },
    register(route) {
      this.exact.set(route.path, route)
      return () => this.exact.delete(route.path)
    },
  }
}

function makeGate(call) {
  const pending = []
  let wake = () => {}
  let settled = 'open'
  call.signal?.addEventListener('abort', () => {
    if (settled === 'open') {
      settled = { error: Object.assign(new Error('Remote invocation was aborted'), { code: 'gateway/cancelled' }) }
      wake()
    }
  })
  const iterable = (async function* () {
    while (true) {
      if (pending.length > 0) {
        const next = pending.shift()
        if (next.kind === 'frame') yield next.frame
        else if (next.kind === 'throw') throw next.error
        else return
      } else if (settled !== 'open') {
        if (settled === 'done') return
        throw settled.error
      } else {
        await new Promise((resolve) => { wake = resolve })
      }
    }
  })()
  return {
    call,
    iterable,
    push: (frame) => { pending.push({ kind: 'frame', frame }); wake() },
    finish: () => { pending.push({ kind: 'return' }); wake() },
    get aborted() { return call.signal?.aborted === true },
  }
}

function makeEventsGate(signal) {
  const pending = []
  let wake = () => {}
  let settled = 'open'
  signal?.addEventListener('abort', () => {
    if (settled === 'open') {
      settled = { error: Object.assign(new Error('Remote invocation "$events" was aborted'), { code: 'gateway/cancelled' }) }
      wake()
    }
  })
  const iterable = (async function* () {
    yield { type: 'ready', clientId: 'srv-events-client', host: { home: '/srv/home' } }
    while (true) {
      if (pending.length > 0) {
        const next = pending.shift()
        if (next.kind === 'frame') yield next.frame
        else if (next.kind === 'throw') throw next.error
        else return
      } else if (settled !== 'open') {
        if (settled === 'done') return
        throw settled.error
      } else {
        await new Promise((resolve) => { wake = resolve })
      }
    }
  })()
  return {
    iterable,
    push: (frame) => { pending.push({ kind: 'frame', frame }); wake() },
    finish: () => { pending.push({ kind: 'return' }); wake() },
    get aborted() { return signal?.aborted === true },
  }
}

function makeLocalGate(signal) {
  const pending = []
  let wake = () => {}
  let finished = false
  const iterable = (async function* () {
    const onAbort = () => { finished = true; wake() }
    if (signal?.aborted) return
    signal?.addEventListener('abort', onAbort)
    try {
      while (true) {
        if (pending.length > 0) yield pending.shift()
        else if (finished) return
        else await new Promise((resolve) => { wake = resolve })
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  })()
  return {
    iterable,
    push: (frame) => { pending.push(frame); wake() },
    finish: () => { finished = true; wake() },
    get aborted() { return signal?.aborted === true },
  }
}

class LocalMergeGateway {
  constructor(localGate) {
    this.localGate = localGate
    this.streamCalls = []
    this.rpcCalls = []
    this.wireStream = {
      open: (endpoint, payload, uplink, peer, signal) => this.openWireStream(endpoint, payload, uplink, peer, signal, { signal }),
    }
    this.rpcBridge = (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)
    this.wireTap = (endpoint, payload, uplink, peer, signal, control) => this.openWireStream(endpoint, payload, uplink, peer, control.signal, control)
  }
  operatorPeer() { return { id: 'operator-peer' } }
  async dispatchRpc(endpoint, payload, signal, peer) {
    this.rpcCalls.push({ endpoint, payload })
    return { ok: true, value: { items: [{ sessionId: 'session-local', updatedAt: 1 }] } }
  }
  async openWireStream(endpoint, payload, uplink, peer, signal, control) {
    this.streamCalls.push({ endpoint, payload, uplink, peer, signal, control })
    if (endpoint === 'workspace/follow') return this.localGate.iterable
    return (async function* () { yield { type: 'baseline', value: { items: [] } } })()
  }
}

class LocalEventsGateway {
  constructor(localGate) {
    this.localGate = localGate
    this.rpcCalls = []
    this.wireStream = {
      open: (endpoint, payload, uplink, peer, signal) => this.openWireStream(endpoint, payload, uplink, peer, signal, { signal }),
    }
    this.rpcBridge = (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)
    this.wireTap = (endpoint, payload, uplink, peer, signal, control) => this.openWireStream(endpoint, payload, uplink, peer, control.signal, control)
  }
  operatorPeer() { return { id: 'operator-peer' } }
  async dispatchRpc(endpoint, payload, signal, peer) {
    this.rpcCalls.push({ endpoint, payload })
    return { ok: true, value: undefined }
  }
  async openWireStream(endpoint, payload, uplink, peer, signal, control) {
    if (endpoint === '$events') return this.localGate.iterable
    return (async function* () { yield { type: 'baseline', value: { items: [] } } })()
  }
}

class BareGateway {
  constructor() {
    this.rpcBridge = (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)
  }
  operatorPeer() { return { id: 'operator-peer' } }
  dispatchRpc(endpoint) { return Promise.resolve({ ok: true, value: { endpoint } }) }
}

function fakeClock() {
  let now = 1_700_000_000_000
  const timers = []
  return {
    now: () => now,
    random: () => 0,
    setTimeout(fn, ms) {
      const timer = { fn, at: now + ms }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    },
    advance(ms) {
      now += ms
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)
      for (const timer of due) {
        const index = timers.indexOf(timer)
        if (index >= 0) {
          timers.splice(index, 1)
          timer.fn()
        }
      }
    },
    get pending() { return timers.length },
  }
}

function startReverseProxy(getGwPort) {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits += 1
    const headers = { ...req.headers, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }
    delete headers.connection
    delete headers['keep-alive']
    let upstream
    res.on('close', () => { try { if (upstream !== undefined) upstream.destroy() } catch { /* gone */ } })
    upstream = http.request({ host: '127.0.0.1', port: getGwPort(), method: req.method, path: req.url, headers }, (upRes) => {
      const out = { ...upRes.headers }
      delete out['transfer-encoding']
      delete out.connection
      delete out['keep-alive']
      res.writeHead(upRes.statusCode || 502, out)
      res.flushHeaders()
      upRes.pipe(res)
    })
    upstream.on('error', () => {
      try { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }) } catch { /* gone */ }
      try { res.end() } catch { /* gone */ }
    })
    req.pipe(upstream)
  })
  const stop = () => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    port: server.address().port,
    getHits: () => hits,
    stop,
  })))
}

function buildRelayParts(home, opts = {}) {
  const { shared = [], workspaces, heartbeatMs, invoke, fingerprints, plugins, pluginBridge, apiFetch, parentOf } = opts
  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  for (const id of shared) store.share(id)
  const invokeCalls = []
  const streams = []
  const eventsGates = []
  const eventResults = []
  const gateway = {
    invoke: async (call) => {
      invokeCalls.push(call)
      if (call.namespace === 'session' && call.method === 'modelCatalog') {
        return { default: null, routableProviders: [], groups: [], failures: [] }
      }
      if (invoke !== undefined) return invoke(call)
      throw Object.assign(new Error(`no invoke fake for ${call.namespace}/${call.method}`), { code: 'test/not-implemented' })
    },
    stream: async (call) => {
      const gate = makeGate(call)
      streams.push(gate)
      if (workspaces !== undefined && call.namespace === 'workspace' && call.method === 'follow') {
        gate.push({ type: 'baseline', value: { items: workspaces, archivedSessionIds: [], pinnedSessionIds: [] } })
      }
      return gate.iterable
    },
    wireStream: {
      open: async (endpoint, payload, uplink, peer, signal) => {
        if (endpoint !== '$events') {
          throw Object.assign(new Error(`no wireStream fake for ${endpoint}`), { code: 'test/not-implemented' })
        }
        const gate = makeEventsGate(signal)
        eventsGates.push(gate)
        return gate.iterable
      },
    },
    dispatchRpc: async (endpoint, payload, signal, peer) => {
      eventResults.push({ endpoint, payload, signal, peer })
      return { ok: true, value: undefined }
    },
  }
  const apiFetchCalls = []
  const handler = createRelayHandler({
    secret: SECRET,
    store,
    gateway,
    ...(parentOf !== undefined ? { parentOf } : {}),
    ...(apiFetch !== undefined
      ? {
          getApiFetch: () => async (request) => {
            apiFetchCalls.push(request)
            return apiFetch(request)
          },
        }
      : {}),
    serverInfo: {
      serverId: loadServerId(home),
      serverName: () => SERVER_NAME,
      dshVersion: '0.0.0-e2e',
      ...(fingerprints !== undefined ? { fingerprints: () => fingerprints } : {}),
      ...(plugins !== undefined ? { plugins } : {}),
    },
    ...(pluginBridge !== undefined ? { pluginBridge } : {}),
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
  })
  return { store, invokeCalls, streams, eventsGates, eventResults, apiFetchCalls, handler }
}

/**
 * File-scoped E2E harness: shares ONE gateway child + ONE reverse proxy + ONE
 * paired desktop device across standard tests, while providing `bootIsolated`
 * for tests that kill/restart the gateway or revoke the device.
 */
function createE2eHarness(prefix = 'dsh-zen-remote-e2e-') {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

  let sharedGw
  let sharedGwPort = 0
  let sharedProxy
  let sharedProxyPort = 0
  let sharedTarget
  let sharedPaired
  let activeHandler = null
  let bootCounter = 0

  async function start() {
    const sharedHome = path.join(ROOT, 'shared-gw')
    fs.mkdirSync(sharedHome, { recursive: true })
    sharedTarget = http.createServer((req, res) => {
      if (activeHandler === null) {
        res.writeHead(404)
        res.end()
        return
      }
      activeHandler(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } })
    })
    await new Promise((resolve) => sharedTarget.listen(0, '127.0.0.1', resolve))
    const targetPort = sharedTarget.address().port
    sharedGw = startGatewayAt(sharedHome, 0, targetPort, { LAN_GATE_RELAY_SECRET: SECRET })
    sharedGwPort = await sharedGw.ready
    sharedProxy = await startReverseProxy(() => sharedGwPort)
    sharedProxyPort = sharedProxy.port
    sharedPaired = await pairDesktop(sharedGwPort, '端到端台式机')
  }

  async function stop() {
    if (sharedTarget !== undefined && sharedGw !== undefined) {
      await stopAll({ close: (done) => { sharedTarget.closeAllConnections(); sharedTarget.close(done) } }, sharedGw.child)
    }
    if (sharedProxy !== undefined) await sharedProxy.stop()
  }

  async function boot(opts = {}) {
    const home = path.join(ROOT, `run-${bootCounter++}`)
    fs.mkdirSync(home, { recursive: true })
    const parts = buildRelayParts(home, opts)
    activeHandler = parts.handler
    const allClients = []
    const registerClient = (client) => { allClients.push(client); return client }
    const token = sharedPaired.token
    const env = {
      ...parts,
      deviceId: sharedPaired.id,
      deviceToken: token,
      proxyPort: sharedProxyPort,
      gwPort: sharedGwPort,
      getProxyHits: () => sharedProxy.getHits(),
      allClients,
      client: registerClient(createRelayClient({
        getServerUrl: () => `http://127.0.0.1:${sharedProxyPort}`,
        getToken: () => token,
      })),
      tunedClient: (overrides = {}) => registerClient(createRelayClient({
        getServerUrl: () => `http://127.0.0.1:${sharedProxyPort}`,
        getToken: () => token,
        ...overrides,
      })),
      stop: async () => {
        for (const client of allClients) client.stop()
        parts.handler.closeAll('e2e teardown')
        activeHandler = null
      },
    }
    return env
  }

  async function bootIsolated(opts = {}) {
    const home = path.join(ROOT, `iso-${bootCounter++}`)
    fs.mkdirSync(home, { recursive: true })
    const parts = buildRelayParts(home, opts)
    const server = http.createServer((req, res) => {
      parts.handler(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const targetPort = server.address().port
    let gw = startGatewayAt(home, 0, targetPort, { LAN_GATE_RELAY_SECRET: SECRET })
    const gwPort = await gw.ready
    const isoProxy = await startReverseProxy(() => gwPort)
    const paired = await pairDesktop(gwPort, '端到端台式机')
    const token = paired.token
    const allClients = []
    const registerClient = (client) => { allClients.push(client); return client }
    return {
      ...parts,
      deviceId: paired.id,
      deviceToken: token,
      gwPort,
      proxyPort: isoProxy.port,
      getProxyHits: () => isoProxy.getHits(),
      allClients,
      client: registerClient(createRelayClient({
        getServerUrl: () => `http://127.0.0.1:${isoProxy.port}`,
        getToken: () => token,
      })),
      tunedClient: (overrides = {}) => registerClient(createRelayClient({
        getServerUrl: () => `http://127.0.0.1:${isoProxy.port}`,
        getToken: () => token,
        ...overrides,
      })),
      killGateway: () => new Promise((resolve) => {
        const child = gw.child
        if (child.exitCode !== null) { resolve(); return }
        child.once('exit', resolve)
        child.kill('SIGTERM')
      }),
      restartGateway: async () => {
        gw = startGatewayAt(home, gwPort, targetPort, { LAN_GATE_RELAY_SECRET: SECRET })
        await gw.ready
      },
      stop: async () => {
        for (const client of allClients) client.stop()
        parts.handler.closeAll('e2e teardown')
        await stopAll({ close: (done) => { server.closeAllConnections(); server.close(done) } }, gw.child)
        await isoProxy.stop()
      },
    }
  }

  return { ROOT, start, stop, boot, bootIsolated, getProxyPort: () => sharedProxyPort }
}

async function waitFor(predicate, ms = 3000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function collect(iterable) {
  const frames = []
  let error
  try {
    for await (const frame of iterable) frames.push(frame)
  } catch (e) {
    error = e
  }
  return { frames, error }
}

async function collectFrames(iterator, count, ms = 5000) {
  const frames = []
  for (let i = 0; i < count; i += 1) {
    let timer
    const result = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for merged frame ${frames.length + 1}/${count}`)), ms)
      }),
    ]).finally(() => clearTimeout(timer))
    if (result.done) throw new Error(`merged stream ended after ${frames.length} of ${count} frames`)
    frames.push(result.value)
  }
  return frames
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

module.exports = {
  SECRET,
  SERVER_NAME,
  FOLLOW_ARGS,
  makeFakeHost,
  makeGate,
  makeEventsGate,
  makeLocalGate,
  LocalMergeGateway,
  LocalEventsGateway,
  BareGateway,
  fakeClock,
  createE2eHarness,
  waitFor,
  collect,
  collectFrames,
  sleep,
}
