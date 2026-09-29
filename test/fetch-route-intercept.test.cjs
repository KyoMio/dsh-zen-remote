/* dsh-zen-remote · the exact-fetch-route interception (src/fetch-route-intercept.ts, T51)
 *
 * The fake connection mirrors the ONE surface the wrap depends on: the
 * host's `fetchRoutes` Map — pathname → {methods, requestBody, fetch} (RT
 * dsh-client-connection lib/index.js:558, 627-631) — with recording doubles
 * as the original upload and export routes. The fake relay client records
 * every upload and plays configurable results. What is pinned here: the
 * shape gate (a reshaped entry leaves everything untouched), the
 * virtual/local split (only virtual ids leave; local request bodies are
 * never consumed), the offline/mismatch refusals, the export block, and an
 * uninstall that restores entries only while they still hold our wrapper.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { FILE_UPLOAD_PATH, SESSION_EXPORT_PATH, checkFetchRouteShape, installFetchRouteIntercept } = require('../lib/fetch-route-intercept.js')
const { toVirtual } = require('../lib/virtual-id.js')

const SERVER_ID = '721b94fb'
const LOCAL_ID = 'session-712828e2-492f-4ad1-8a88-ece10ecc4cc0'

const RECEIPT = { ok: true, value: { receiptId: 'r-1', file: { attachmentId: 'att-1', name: 'note.txt', bytes: 5 } } }

/** A fake connection service: the fetchRoutes Map with recording doubles. */
function fakeConnection() {
  const seen = { upload: [], export: [] }
  const routes = new Map()
  routes.set(FILE_UPLOAD_PATH, {
    methods: new Set(['POST']),
    requestBody: 'streaming',
    fetch: async (request) => {
      seen.upload.push(request)
      const bytes = request.body === null ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer())
      return new Response(JSON.stringify({ ok: true, value: { receiptId: 'local', bytes: bytes.length } }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    },
  })
  routes.set(SESSION_EXPORT_PATH, {
    methods: new Set(['GET', 'HEAD']),
    requestBody: 'buffered',
    fetch: async (request) => {
      seen.export.push(request)
      return new Response('exported', { status: 200 })
    },
  })
  return { fetchRoutes: routes, seen }
}

/** A fake relay client: the state + handshake the wrapper reads, and an
 * upload() that consumes the body stream (like the real one) and plays
 * `play` — a result object or an Error. */
function fakeRelay(overrides = {}) {
  const calls = []
  let play = overrides.play ?? { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(RECEIPT) }
  return {
    calls,
    setPlay: (next) => { play = next },
    state: overrides.state ?? 'online',
    handshakeInfo: { relayProtocol: 1, serverId: overrides.serverId ?? SERVER_ID, serverName: '假服务器', dshVersion: '0.0.0', fingerprints: {} },
    async upload(options, signal) {
      const chunks = []
      if (options.body !== null) {
        for await (const chunk of options.body) chunks.push(Buffer.from(chunk))
      }
      const record = { options: { ...options, body: undefined }, bytes: Buffer.concat(chunks), signal }
      calls.push(record)
      if (play instanceof Error) throw play
      return play
    },
  }
}

function uploadRequest(sessionId, bytes = 'hello', name = 'note.txt') {
  const query = new URLSearchParams({ sessionId })
  if (name !== undefined) query.set('name', name)
  return new Request(`http://dsh.internal/api/session/uploadFileBinary?${query.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(Buffer.byteLength(bytes)) },
    body: Buffer.from(bytes, 'utf8'),
    duplex: 'half',
  })
}

function exportRequest(sessionId) {
  return new Request(`http://dsh.internal/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`, { method: 'HEAD' })
}

// ---- the shape gate ------------------------------------------------------

test('shape: the upload entry must be a streaming POST route with a function fetch', () => {
  assert.equal(checkFetchRouteShape({}).ok, false, 'no fetchRoutes Map at all')
  assert.equal(checkFetchRouteShape({ fetchRoutes: new Map() }).ok, false, 'no upload entry')
  const entry = (over) => {
    const routes = new Map()
    routes.set(FILE_UPLOAD_PATH, { methods: new Set(['POST']), requestBody: 'streaming', fetch: async () => new Response('x'), ...over })
    return { fetchRoutes: routes }
  }
  assert.equal(checkFetchRouteShape(entry({ fetch: 'not-a-function' })).ok, false, 'fetch is not a function')
  assert.equal(checkFetchRouteShape(entry({ requestBody: 'buffered' })).ok, false, 'requestBody is not streaming')
  assert.equal(checkFetchRouteShape(entry({ methods: new Set(['GET']) })).ok, false, 'POST not admitted')
  const okShape = checkFetchRouteShape(entry({}))
  assert.equal(okShape.ok, true)
  // A missing export entry is a NOTE, not a refusal.
  assert.ok(okShape.notes.some((note) => note.includes('session.export')), 'the absent export entry is recorded')
})

// ---- the upload wrap -----------------------------------------------------

test('wrap: a virtual id forwards the original id, the name and the exact bytes; the answer is reconstructed', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = installFetchRouteIntercept({ connection, relay, getServerId: () => relay.handshakeInfo.serverId })
  try {
    const virtual = toVirtual(SERVER_ID, LOCAL_ID)
    const response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(virtual))
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(await response.text()), RECEIPT)
    assert.equal(connection.seen.upload.length, 0, 'the local route was never reached')
    assert.equal(relay.calls.length, 1)
    const call = relay.calls[0]
    assert.equal(call.options.sessionId, LOCAL_ID, 'the ORIGINAL id rides to the server')
    assert.equal(call.options.name, 'note.txt')
    assert.ok(call.bytes.equals(Buffer.from('hello')), 'the exact bytes were forwarded')
    assert.equal(call.options.bytes, 5, 'the declared content-length sized the budget')
  } finally { handle.uninstall() }
})

test('wrap: a local id reaches the original with its body UNTOUCHED', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = installFetchRouteIntercept({ connection, relay, getServerId: () => relay.handshakeInfo.serverId })
  try {
    const request = uploadRequest(LOCAL_ID)
    const response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(request)
    assert.equal(response.status, 200)
    const body = JSON.parse(await response.text())
    assert.equal(body.value.receiptId, 'local', 'the ORIGINAL route answered')
    assert.equal(connection.seen.upload.length, 1)
    assert.equal(connection.seen.upload[0], request, 'the same Request object arrived')
    assert.equal(relay.calls.length, 0, 'nothing traveled')
  } finally { handle.uninstall() }
})

test('wrap: a missing or duplicated sessionId falls through to the original', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = installFetchRouteIntercept({ connection, relay, getServerId: () => relay.handshakeInfo.serverId })
  try {
    const noId = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(new Request('http://dsh.internal/api/session/uploadFileBinary', { method: 'POST', body: 'x' }))
    assert.equal((JSON.parse(await noId.text())).value.receiptId, 'local', 'the original route answered the id-less request')
    assert.equal(relay.calls.length, 0, 'nothing traveled')
  } finally { handle.uninstall() }
})

test('wrap: an offline relay answers 503 remote-offline and nothing travels', async () => {
  for (const state of ['unpaired', 'connecting', 'offline', 'revoked', 'incompatible']) {
    const connection = fakeConnection()
    const relay = fakeRelay({ state })
    const handle = installFetchRouteIntercept({ connection, relay, getServerId: () => relay.handshakeInfo.serverId })
    try {
      const response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
      assert.equal(response.status, 503, state)
      const body = await response.json()
      assert.deepEqual(body, { ok: false, error: { code: 'remote-offline', message: '服务端离线，远程会话暂时无法上传文件', details: {} } }, state)
      assert.equal(relay.calls.length, 0, state)
      assert.equal(connection.seen.upload.length, 0, state)
    } finally { handle.uninstall() }
  }
})

test('wrap: another server\'s virtual id answers 400 remote-mismatch', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = installFetchRouteIntercept({ connection, relay, getServerId: () => SERVER_ID })
  try {
    const response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual('ffffffff', LOCAL_ID)))
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, 'remote-mismatch')
    assert.equal(relay.calls.length, 0)
  } finally { handle.uninstall() }
})

test('wrap: a relay refusal keeps the host 200-envelope contract; a link death is 503', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = installFetchRouteIntercept({ connection, relay, getServerId: () => SERVER_ID })
  try {
    relay.setPlay(new (require('../lib/relay-client.js').RelayError)('not-shared', 'shared session session-x is not shared', 403))
    let response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal(response.status, 200, 'a business answer keeps the host contract')
    let body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'not-shared')
    assert.equal(typeof body.error.message, 'string')
    assert.deepEqual(body.error.details, {}, 'details is the record parseFileUploadResult demands')

    relay.setPlay(new (require('../lib/relay-client.js').RelayError)('payload-too-large', 'past the cap', 413))
    response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal(response.status, 200)
    body = await response.json()
    assert.equal(body.error.code, 'payload-too-large')

    relay.setPlay(new (require('../lib/relay-client.js').RelayError)('offline', 'the gateway is unreachable', 502))
    response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal(response.status, 503, 'a link death is the transport answer')
    body = await response.json()
    assert.equal(body.error.code, 'remote-offline')
  } finally { handle.uninstall() }
})

// ---- the export wrap -----------------------------------------------------

test('export: a virtual id is refused 403 without reaching the local route; a local id passes', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = installFetchRouteIntercept({ connection, relay, getServerId: () => SERVER_ID })
  try {
    const blocked = await connection.fetchRoutes.get(SESSION_EXPORT_PATH).fetch(exportRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal(blocked.status, 403)
    const body = await blocked.json()
    assert.equal(body.error.code, 'remote-unsupported')
    assert.equal(body.error.message, '远程会话不支持导出')
    assert.equal(connection.seen.export.length, 0, 'the local export route was never reached')
    assert.equal(relay.calls.length, 0, 'nothing was forwarded either')

    const local = await connection.fetchRoutes.get(SESSION_EXPORT_PATH).fetch(exportRequest(LOCAL_ID))
    assert.equal(local.status, 200)
    assert.equal(connection.seen.export.length, 1, 'the local export answered')
  } finally { handle.uninstall() }
})

// ---- uninstall + diagnostics ---------------------------------------------

test('uninstall: entries are restored only while they hold OUR wrapper; a chained-over wrap goes inert', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = installFetchRouteIntercept({ connection, relay, getServerId: () => SERVER_ID })
  const routes = connection.fetchRoutes
  const uploadEntry = routes.get(FILE_UPLOAD_PATH)
  // Someone chains a wrapper OVER ours, capturing it the way a real chain
  // does — then we uninstall.
  const ours = uploadEntry.fetch
  let foreignCalls = 0
  const foreign = async (request) => {
    foreignCalls += 1
    return ours(request)
  }
  uploadEntry.fetch = foreign
  handle.uninstall()
  assert.equal(uploadEntry.fetch, foreign, 'the foreign wrapper survives our uninstall — restoring would drop ITS wrap')
  assert.equal(handle.diagnostics().uploadWrapped, false)
  // The chain still reaches our (inert) wrapper, which now passthroughs to
  // the ORIGINAL route: even a virtual id gets the LOCAL answer, nothing
  // travels.
  const response = await uploadEntry.fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
  assert.equal(foreignCalls, 1, 'the foreign wrapper was reached')
  const body = JSON.parse(await response.text())
  assert.equal(body.value.receiptId, 'local', 'the inert wrapper let the local route answer')
  assert.equal(relay.calls.length, 0, 'nothing traveled through the inert wrapper')

  // A second, clean install over the foreign wrapper chains IT and restores
  // it on uninstall — never the original underneath.
  const second = installFetchRouteIntercept({ connection, relay, getServerId: () => SERVER_ID })
  assert.notEqual(uploadEntry.fetch, foreign, 'the second install wrapped over the foreign wrapper')
  second.uninstall()
  assert.equal(uploadEntry.fetch, foreign, 'the second uninstall restored the foreign wrapper, not the original')
})

test('uninstall: a clean cycle restores the exact original and local uploads still work', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const routes = connection.fetchRoutes
  const original = routes.get(FILE_UPLOAD_PATH).fetch
  const handle = installFetchRouteIntercept({ connection, relay, getServerId: () => SERVER_ID })
  assert.notEqual(routes.get(FILE_UPLOAD_PATH).fetch, original)
  handle.uninstall()
  assert.equal(routes.get(FILE_UPLOAD_PATH).fetch, original, 'the exact original came back')
  assert.equal(handle.diagnostics().exportWrapped, false, 'the export wrapper is gone too')
  const response = await routes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
  assert.equal((JSON.parse(await response.text())).value.receiptId, 'local', 'the unwrapped route treats a virtual id as garbage — local behavior identical to pre-plugin')
  handle.uninstall()
})

test('diagnostics: counters, flags and the failure ring — and no credential material anywhere', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = installFetchRouteIntercept({ connection, relay, getServerId: () => SERVER_ID })
  try {
    const routes = connection.fetchRoutes
    await routes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    await routes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(LOCAL_ID))
    await routes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual('ffffffff', LOCAL_ID)))
    await routes.get(SESSION_EXPORT_PATH).fetch(exportRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    const diagnostics = handle.diagnostics()
    assert.equal(diagnostics.installed, true)
    assert.equal(diagnostics.uploadWrapped, true)
    assert.equal(diagnostics.exportWrapped, true)
    assert.equal(diagnostics.uploadCalls, 3)
    assert.equal(diagnostics.uploadForwarded, 1)
    assert.equal(diagnostics.uploadRefused, 1)
    assert.equal(diagnostics.exportBlocked, 1)
    assert.equal(diagnostics.recentFailures.length, 2)
    assert.deepEqual(diagnostics.recentFailures.map((r) => r.code), ['remote-mismatch', 'remote-unsupported'])
    handle.uninstall()
    assert.equal(handle.diagnostics().installed, false)
    assert.equal(handle.diagnostics().uploadWrapped, false)
    const text = JSON.stringify(handle.diagnostics())
    assert.ok(!text.includes('tok'), 'no token material')
  } finally { handle.uninstall() }
})
