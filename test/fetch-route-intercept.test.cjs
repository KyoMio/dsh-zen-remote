/* dsh-zen-remote · the exact-fetch-route interception (src/fetch-route-intercept.ts, T51 + T51-fix)
 *
 * The fake connection mirrors the ONE surface the wrap depends on: the
 * host's `fetchRoutes` Map — pathname → {methods, requestBody, fetch} (RT
 * dsh-client-connection lib/index.js:558, 627-631) — with recording doubles
 * as the original upload and export routes. The fake relay client records
 * every upload and plays configurable results. What is pinned here: the
 * structural shape gate; the per-route attach (immediate / lazy for a late
 * registration / permanent refusal for a misshaped entry); the virtual and
 * local split (only virtual ids leave; local request bodies are never
 * consumed); every upload answer as the UI-parseable 200 envelope
 * (T51-fix); the local oversize pre-refusal; and an uninstall that restores
 * entries only while they still hold our wrapper.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { FILE_UPLOAD_PATH, SESSION_EXPORT_PATH, checkFetchRouteShape, installFetchRouteIntercept } = require('../lib/fetch-route-intercept.js')
const { toVirtual } = require('../lib/virtual-id.js')
const { MAX_UPLOAD_BYTES } = require('../lib/relay-server.js')
const { RelayError } = require('../lib/relay-client.js')

const SERVER_ID = '721b94fb'
const LOCAL_ID = 'session-712828e2-492f-4ad1-8a88-ece10ecc4cc0'

const RECEIPT = { ok: true, value: { receiptId: 'r-1', file: { attachmentId: 'att-1', name: 'note.txt', bytes: 5 } } }

/** A fake connection service: the fetchRoutes Map with recording doubles.
 * Either entry can be omitted (or reshaped) to exercise the lazy attach and
 * the per-route refusal. */
function fakeConnection(opts = {}) {
  const seen = { upload: [], export: [] }
  const routes = new Map()
  if (opts.upload !== null) {
    routes.set(FILE_UPLOAD_PATH, {
      methods: new Set(['POST']),
      requestBody: 'streaming',
      ...(opts.upload ?? {}),
      fetch: async (request) => {
        seen.upload.push(request)
        const bytes = request.body === null ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer())
        return new Response(JSON.stringify({ ok: true, value: { receiptId: 'local', bytes: bytes.length } }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      },
    })
  }
  if (opts.export !== null) {
    routes.set(SESSION_EXPORT_PATH, {
      methods: new Set(['GET', 'HEAD']),
      requestBody: 'buffered',
      ...(opts.export ?? {}),
      fetch: async (request) => {
        seen.export.push(request)
        return new Response('exported', { status: 200 })
      },
    })
  }
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

const install = (connection, relay, overrides = {}) =>
  installFetchRouteIntercept({
    connection,
    relay,
    getServerId: () => relay.handshakeInfo.serverId,
    // The lazy-attach probe runs fast in tests; a 5 ms tick × 40 keeps a
    // late registration test well under a second.
    attachRetryMs: 5,
    attachAttempts: 40,
    ...overrides,
  })

// ---- the shape gate (structural only since T51-fix) -----------------------

test('shape: only the structural facts refuse; entry findings are notes', () => {
  const refusedObject = checkFetchRouteShape('nope')
  assert.equal(refusedObject.ok, false)
  const refusedMap = checkFetchRouteShape({})
  assert.equal(refusedMap.ok, false)
  assert.ok(refusedMap.reasons.some((r) => r.includes('not a Map')))

  // Both entries present and correct: attachable notes.
  const full = checkFetchRouteShape(fakeConnection())
  assert.equal(full.ok, true)
  assert.ok(full.notes.some((n) => n.startsWith('upload: present and attachable')))
  assert.ok(full.notes.some((n) => n.startsWith('export: present and attachable')))

  // Absent entries are notes, not refusals — the attach retries.
  const absent = checkFetchRouteShape(fakeConnection({ upload: null }))
  assert.equal(absent.ok, true)
  assert.ok(absent.notes.some((n) => n.startsWith('upload: absent')))

  // A misshaped entry is a note too — the ATTACH refuses it, the install
  // does not.
  const misshaped = checkFetchRouteShape(fakeConnection({ upload: { requestBody: 'buffered' } }))
  assert.equal(misshaped.ok, true)
  assert.ok(misshaped.notes.some((n) => n.includes('misshaped') && n.includes('streaming')))
})

// ---- the upload wrap ------------------------------------------------------

test('wrap: a virtual id forwards the original id, the name and the exact bytes; the answer is reconstructed', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = install(connection, relay)
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
  const handle = install(connection, relay)
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

test('wrap: a missing sessionId falls through to the original', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = install(connection, relay)
  try {
    const noId = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(new Request('http://dsh.internal/api/session/uploadFileBinary', { method: 'POST', body: 'x' }))
    assert.equal((JSON.parse(await noId.text())).value.receiptId, 'local', 'the original route answered the id-less request')
    assert.equal(relay.calls.length, 0, 'nothing traveled')
  } finally { handle.uninstall() }
})

test('wrap (T51-fix): an offline relay answers the UI-parseable 200 envelope and nothing travels', async () => {
  for (const state of ['unpaired', 'connecting', 'offline', 'revoked', 'incompatible']) {
    const connection = fakeConnection()
    const relay = fakeRelay({ state })
    const handle = install(connection, relay)
    try {
      const response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
      // 200 ON PURPOSE: a non-200 dies in FileUploadRuntime.upload as a bare
      // English transport error before parseFileUploadResult ever runs.
      assert.equal(response.status, 200, state)
      const body = await response.json()
      assert.deepEqual(body, { ok: false, error: { code: 'remote-offline', message: '服务端离线，远程会话暂时无法上传文件', details: {} } }, state)
      assert.equal(relay.calls.length, 0, state)
      assert.equal(connection.seen.upload.length, 0, state)
    } finally { handle.uninstall() }
  }
})

test('wrap (T51-fix): another server\'s virtual id answers the 200 remote-mismatch envelope', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = install(connection, relay)
  try {
    const response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual('ffffffff', LOCAL_ID)))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body, { ok: false, error: { code: 'remote-mismatch', message: '此远程会话属于其他主服务端', details: {} } })
    assert.equal(relay.calls.length, 0)
  } finally { handle.uninstall() }
})

test('wrap (T51-fix): a DECLARED body past the relay cap is refused locally — the relay never hears of it', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = install(connection, relay)
  try {
    const query = new URLSearchParams({ sessionId: toVirtual(SERVER_ID, LOCAL_ID), name: 'huge.bin' })
    const request = new Request(`http://dsh.internal/api/session/uploadFileBinary?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(250 * 1024 * 1024) },
      body: Buffer.from('tiny'),
      duplex: 'half',
    })
    const response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(request)
    assert.equal(response.status, 200, 'the UI-parseable envelope, not a transport error')
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'payload-too-large')
    assert.equal(body.error.message, '文件超过远程上传上限（100 MiB）')
    assert.deepEqual(body.error.details, {})
    assert.equal(relay.calls.length, 0, 'a 250 MiB declaration never starts a doomed round-trip')
    assert.equal(connection.seen.upload.length, 0)
    assert.equal(handle.diagnostics().uploadRefused, 1)
  } finally { handle.uninstall() }
})

test('wrap: a relay refusal keeps the host 200-envelope contract; a link death is the same envelope', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = install(connection, relay)
  try {
    relay.setPlay(new RelayError('not-shared', 'shared session session-x is not shared', 403))
    let response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal(response.status, 200, 'a business answer keeps the host contract')
    let body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'not-shared')
    assert.equal(typeof body.error.message, 'string')
    assert.deepEqual(body.error.details, {}, 'details is the record parseFileUploadResult demands')

    relay.setPlay(new RelayError('payload-too-large', 'past the cap', 413))
    response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal(response.status, 200)
    body = await response.json()
    assert.equal(body.error.code, 'payload-too-large')

    relay.setPlay(new RelayError('offline', 'the gateway is unreachable', 502))
    response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal(response.status, 200, 'a link death is ALSO the 200 envelope (T51-fix)')
    body = await response.json()
    assert.equal(body.error.code, 'remote-offline')
    assert.equal(body.error.message, '服务端离线，远程会话暂时无法上传文件')
  } finally { handle.uninstall() }
})

// ---- the export wrap ------------------------------------------------------

test('export: a virtual id is refused 403 without reaching the local route; a local id passes', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = install(connection, relay)
  try {
    const blocked = await connection.fetchRoutes.get(SESSION_EXPORT_PATH).fetch(exportRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal(blocked.status, 403, 'the export dialog reads response.ok — a real 403 is wanted here')
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

// ---- the per-route attach (T51-fix) ---------------------------------------

test('attach: a route registered LATE is picked up by the retry and wrapped', async () => {
  const connection = fakeConnection({ upload: null, export: null })
  const relay = fakeRelay()
  const handle = install(connection, relay)
  try {
    let diagnostics = handle.diagnostics()
    assert.equal(diagnostics.uploadWrapped, false)
    assert.equal(diagnostics.exportWrapped, false)
    assert.equal(diagnostics.uploadPending, true, 'absent and still retrying')
    assert.equal(diagnostics.exportPending, true)

    // session-log-export registers after us: two ticks of the probe later
    // both routes are wrapped.
    connection.fetchRoutes.set(FILE_UPLOAD_PATH, {
      methods: new Set(['POST']),
      requestBody: 'streaming',
      fetch: async () => new Response('{"ok":true,"value":{"receiptId":"local"}}'),
    })
    connection.fetchRoutes.set(SESSION_EXPORT_PATH, {
      methods: new Set(['GET', 'HEAD']),
      requestBody: 'buffered',
      fetch: async () => new Response('exported'),
    })
    const start = Date.now()
    while (Date.now() - start < 2000) {
      if (handle.diagnostics().uploadWrapped && handle.diagnostics().exportWrapped) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    diagnostics = handle.diagnostics()
    assert.equal(diagnostics.uploadWrapped, true, 'the late upload entry got wrapped')
    assert.equal(diagnostics.exportWrapped, true, 'the late export entry got wrapped')
    assert.equal(diagnostics.uploadPending, false)
    assert.equal(diagnostics.exportPending, false)

    // And the attached wrappers really serve: a virtual upload forwards.
    const response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.deepEqual(JSON.parse(await response.text()), RECEIPT)
    assert.equal(relay.calls.length, 1)
  } finally { handle.uninstall() }
})

test('attach: a first upload call also picks up a late-registered export route', async () => {
  const connection = fakeConnection({ export: null })
  const relay = fakeRelay()
  const handle = install(connection, relay)
  try {
    connection.fetchRoutes.set(SESSION_EXPORT_PATH, {
      methods: new Set(['GET', 'HEAD']),
      requestBody: 'buffered',
      fetch: async () => new Response('exported'),
    })
    // The upload call is the hook: before it answers, the export entry has
    // been probed and wrapped.
    await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(LOCAL_ID))
    assert.equal(handle.diagnostics().exportWrapped, true, 'the upload call attached the late export entry')
    const blocked = await connection.fetchRoutes.get(SESSION_EXPORT_PATH).fetch(exportRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal(blocked.status, 403)
  } finally { handle.uninstall() }
})

test('attach: a misshaped entry is refused for ITS route only; the other route still installs', async () => {
  const connection = fakeConnection({ upload: { requestBody: 'buffered' } })
  const relay = fakeRelay()
  const handle = install(connection, relay)
  try {
    const diagnostics = handle.diagnostics()
    assert.equal(diagnostics.installed, true)
    assert.equal(diagnostics.uploadWrapped, false, 'the misshaped upload entry was never wrapped')
    assert.equal(diagnostics.uploadPending, false, 'present-but-wrong never fixes itself — no retry')
    assert.ok(diagnostics.uploadAttachRefused !== null && diagnostics.uploadAttachRefused.includes('streaming'))
    assert.equal(diagnostics.exportWrapped, true, 'the healthy export route installed anyway')

    // BOTH local and virtual uploads reach the ORIGINAL (misshaped-but-
    // functioning) route — local behavior identical to pre-plugin.
    const virtual = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal((JSON.parse(await virtual.text())).value.receiptId, 'local')
    assert.equal(relay.calls.length, 0)
  } finally { handle.uninstall() }
})

// ---- uninstall + diagnostics ---------------------------------------------

test('uninstall: entries are restored only while they hold OUR wrapper; a chained-over wrap goes inert', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = install(connection, relay)
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
  const second = install(connection, relay)
  assert.notEqual(uploadEntry.fetch, foreign, 'the second install wrapped over the foreign wrapper')
  second.uninstall()
  assert.equal(uploadEntry.fetch, foreign, 'the second uninstall restored the foreign wrapper, not the original')
})

test('uninstall: a clean cycle restores the exact original and local uploads still work', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const routes = connection.fetchRoutes
  const original = routes.get(FILE_UPLOAD_PATH).fetch
  const handle = install(connection, relay)
  assert.notEqual(routes.get(FILE_UPLOAD_PATH).fetch, original)
  handle.uninstall()
  assert.equal(routes.get(FILE_UPLOAD_PATH).fetch, original, 'the exact original came back')
  assert.equal(handle.diagnostics().exportWrapped, false, 'the export wrapper is gone too')
  assert.equal(handle.diagnostics().uploadPending, false, 'uninstalled — no retry is running')
  const response = await routes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
  assert.equal((JSON.parse(await response.text())).value.receiptId, 'local', 'the unwrapped route treats a virtual id as garbage — local behavior identical to pre-plugin')
  handle.uninstall()
})

test('diagnostics: counters, flags, attach refusals and the failure ring — no credential material anywhere', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = install(connection, relay)
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
    assert.equal(diagnostics.uploadPending, false)
    assert.equal(diagnostics.exportPending, false)
    assert.equal(diagnostics.uploadAttachRefused, undefined)
    assert.equal(diagnostics.exportAttachRefused, undefined)
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

test('the cap the local pre-refusal quotes is the relay module cap', () => {
  assert.equal(MAX_UPLOAD_BYTES, 100 * 1024 * 1024, 'the message and the gate must move together')
})
