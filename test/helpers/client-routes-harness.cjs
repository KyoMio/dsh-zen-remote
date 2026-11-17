'use strict'
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { startResetServer } = require('../util.cjs')

const ROUTES_URL = pathToFileURL(path.join(__dirname, '..', '..', 'lib', 'client-routes.js')).href

function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.length) })
  res.end(bytes)
}

function startMockGateway() {
  const seen = []
  const state = { claimReply: () => [200, { ok: true, id: 'dev1', name: '台式机', token: 'tok-gateway' }], pingReply: () => [200, { ok: true }] }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ method: req.method, url: String(req.url).split('?')[0], headers: req.headers, body })
      if (req.url === '/lan-gate/pair/claim-desktop') {
        const [status, payload] = state.claimReply()
        sendJson(res, status, payload)
        return
      }
      if (req.url === '/_dsh/zen-remote/relay/ping') {
        const [status, payload] = state.pingReply()
        sendJson(res, status, payload)
        return
      }
      sendJson(res, 404, { ok: false })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, state })))
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

function sameOrigin(port) {
  return { origin: `http://127.0.0.1:${port}` }
}

const INFO = (name, deviceName) => {
  const info = { relayProtocol: 1, serverId: 'abcd1234', serverName: name, dshVersion: '2.0.0', fingerprints: {} }
  if (deviceName !== undefined) info.deviceName = deviceName
  return info
}

function fakeRelay(overrides = {}) {
  const relay = {
    state: 'unpaired',
    handshakeInfo: undefined,
    lastHandshakeDigest: undefined,
    deviceNameSyncing: false,
    connectCount: 0,
    connectError: undefined,
    connectResult: undefined,
    connectDelay: 0,
    digest: undefined,
    inFlight: undefined,
    subscribe: () => () => {},
    invoke: async () => { throw new Error('fake relay: invoke not wired') },
    openStream: () => { throw new Error('fake relay: openStream not wired') },
    ...overrides,
  }
  relay.connect = overrides.connect ?? (() => {
    if (relay.inFlight !== undefined) return relay.inFlight
    relay.connectCount += 1
    relay.inFlight = (async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, relay.connectDelay))
        if (relay.connectError !== undefined) throw relay.connectError
        if (relay.connectResult === undefined) throw new Error('fake relay: no connect wiring')
        relay.state = 'online'
        relay.handshakeInfo = relay.connectResult
        relay.lastHandshakeDigest = relay.digest
        return relay.connectResult
      } finally {
        relay.inFlight = undefined
      }
    })()
    return relay.inFlight
  })
  return relay
}

function createClientRoutesHarness() {
  let routes
  let gateway
  let gwSeen
  let gwState
  let gwPort
  let gwUrl

  async function start() {
    routes = await import(ROUTES_URL)
    ;({ server: gateway, seen: gwSeen, state: gwState } = await startMockGateway())
    gwPort = gateway.address().port
    gwUrl = `http://127.0.0.1:${gwPort}`
    return { routes, gateway, gwSeen, gwState, gwPort, gwUrl }
  }

  function stop() {
    return new Promise((resolve) => gateway.close(resolve))
  }

  function makeRow(overrides = {}) {
    return {
      serverUrl: overrides.serverUrl !== undefined ? overrides.serverUrl : gwUrl,
      deviceToken: overrides.deviceToken !== undefined ? overrides.deviceToken : 'tok-row',
      role: 'client',
      ...(overrides.maxServers !== undefined ? { maxServers: overrides.maxServers } : {}),
    }
  }

  function startClientServer(row, overrides = {}) {
    const handler = routes.createClientHandler({
      admit: overrides.admit || (() => ({ peer: {} })),
      getRowConfig: overrides.getRowConfig || (() => row),
      ...(overrides.fetchImpl !== undefined ? { fetchImpl: overrides.fetchImpl } : {}),
      ...(overrides.getRelayClient !== undefined ? { getRelayClient: overrides.getRelayClient } : {}),
      ...(overrides.pool !== undefined ? { pool: overrides.pool } : {}),
      ...(overrides.probeTimeoutMs !== undefined ? { probeTimeoutMs: overrides.probeTimeoutMs } : {}),
      ...(overrides.getPluginBridgeStatusForServer !== undefined ? { getPluginBridgeStatusForServer: overrides.getPluginBridgeStatusForServer } : {}),
      ...(overrides.getIntercept !== undefined ? { getIntercept: overrides.getIntercept } : {}),
      ...(overrides.getPluginBridgeStatus !== undefined ? { getPluginBridgeStatus: overrides.getPluginBridgeStatus } : {}),
      ...(overrides.remoteStatusOnly !== undefined ? { remoteStatusOnly: overrides.remoteStatusOnly } : {}),
      ...(overrides.onCurrentSession !== undefined ? { onCurrentSession: overrides.onCurrentSession } : {}),
      ...(overrides.getLogSnapshot !== undefined ? { getLogSnapshot: overrides.getLogSnapshot } : {}),
      ...(overrides.getGatewaySummary !== undefined ? { getGatewaySummary: overrides.getGatewaySummary } : {}),
      ...(overrides.getProfileName !== undefined ? { getProfileName: overrides.getProfileName } : {}),
      ...(overrides.getPluginVersion !== undefined ? { getPluginVersion: overrides.getPluginVersion } : {}),
      ...(overrides.getMaxServers !== undefined ? { getMaxServers: overrides.getMaxServers } : {}),
      ...(overrides.getPeerEngine !== undefined ? { getPeerEngine: overrides.getPeerEngine } : {}),
      ...(overrides.getPeerIdentityError !== undefined ? { getPeerIdentityError: overrides.getPeerIdentityError } : {}),
      ...(overrides.getPeerNetworkOrigin !== undefined ? { getPeerNetworkOrigin: overrides.getPeerNetworkOrigin } : {}),
    })
    const server = http.createServer((req, res) => { void handler(req, res) })
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
  }

  return { start, stop, makeRow, startClientServer }
}

function fakePool(entries, overrides = {}) {
  const calls = { pair: [], unpair: [], unpairAll: 0, reconnect: [], probeRestore: 0, deviceName: [] }
  const virtualIds = new Set(overrides.virtualIds ?? [])
  const pool = {
    calls,
    virtualIds,
    entries: () => entries,
    getByEntryId: (entryId) => entries.find((entry) => entry.entryId === entryId),
    getByServerId: (serverId) => entries.find((entry) => entry.serverId === serverId),
    isVirtual: (entryId) => virtualIds.has(entryId),
    pair: async (input) => {
      calls.pair.push(input)
      const existing = entries.find((entry) => entry.serverUrl === input.serverUrl)
      if (existing !== undefined) return { ok: true, entry: existing, replaced: true }
      if (entries.length >= (typeof overrides.pairCap === 'number' ? overrides.pairCap : 8)) return { ok: false, code: 'limit-reached' }
      const view = {
        entryId: `fresh-${entries.length + 1}`,
        serverUrl: input.serverUrl,
        serverId: undefined,
        serverName: undefined,
        displayName: input.serverUrl,
        client: fakeRelay({ state: 'connecting' }),
        createdAt: 1,
      }
      entries.push(view)
      return { ok: true, entry: view, replaced: false }
    },
    unpair: (entryId) => {
      calls.unpair.push(entryId)
      const index = entries.findIndex((entry) => entry.entryId === entryId)
      if (index === -1) return false
      entries.splice(index, 1)
      return true
    },
    unpairAll: () => {
      calls.unpairAll += 1
      const count = entries.length
      entries.length = 0
      return count
    },
    reconnect: async (entryId) => {
      calls.reconnect.push(entryId ?? null)
      if (entryId !== undefined) {
        const entry = entries.find((candidate) => candidate.entryId === entryId)
        return entry !== undefined && entry.client.reconnect() === true
      }
      let any = false
      for (const entry of entries) {
        if (entry.client.state === 'offline') any = entry.client.reconnect() || any
      }
      return any
    },
    probeAndRestoreAll: async () => {
      calls.probeRestore += 1
      return { reachable: true, reconnected: true }
    },
    queueDeviceNameAll: (name) => { calls.deviceName.push(name) },
    stop: () => {},
    ...overrides,
  }
  return pool
}

function makeEntry(entryId, serverId, serverUrl, name, clientOverrides = {}) {
  const client = fakeRelay({ state: 'online', handshakeInfo: { relayProtocol: 1, serverId, serverName: name, dshVersion: '2.0.0', fingerprints: {} }, ...clientOverrides })
  if (client.nextRetryAt === undefined) client.nextRetryAt = null
  return {
    entryId,
    serverUrl,
    serverId: clientOverrides.serverIdView !== undefined ? clientOverrides.serverIdView : serverId,
    serverName: clientOverrides.serverNameView !== undefined ? clientOverrides.serverNameView : name,
    displayName: clientOverrides.displayName ?? name,
    client,
    createdAt: 1,
  }
}

module.exports = {
  ROUTES_URL,
  sendJson,
  startMockGateway,
  closeServer,
  sameOrigin,
  INFO,
  fakeRelay,
  fakePool,
  makeEntry,
  startResetServer,
  createClientRoutesHarness,
}
