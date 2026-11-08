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
const { FILE_UPLOAD_PATH, SESSION_EXPORT_PATH, FILE_MEDIA_PATH, MAX_FILE_MEDIA_BYTES, checkFetchRouteShape, installFetchRouteIntercept, shouldFallbackInstall } = require('../lib/fetch-route-intercept.js')
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
  const seen = { upload: [], export: [], file: [] }
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
  // P55-2: the host's media route (SessionMediaReferences registers GET/HEAD
  // buffered exactly like this). Present by default — installs WITHOUT a
  // resolveRemoteFileScope never probe or wrap it, so the legacy tests see
  // nothing.
  if (opts.file !== null) {
    routes.set(FILE_MEDIA_PATH, {
      methods: new Set(['GET', 'HEAD']),
      requestBody: 'buffered',
      ...(opts.file ?? {}),
      fetch: async (request) => {
        seen.file.push(request)
        return new Response('local-file', { status: 200, headers: { 'content-type': 'text/plain' } })
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
  // P55-2: the invoke face the /api/file wrapper reads — records every call
  // and plays one staged answer (a value or an Error). Separate from the
  // upload `calls` ring so the legacy assertions stay untouched.
  let invokePlay = overrides.invokePlay ?? undefined
  const invokes = []
  return {
    calls,
    setPlay: (next) => { play = next },
    invokes,
    setInvokePlay: (next) => { invokePlay = next },
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
    async invoke(namespace, method, args, signal) {
      invokes.push({ namespace, method, args, signal })
      if (invokePlay instanceof Error) throw invokePlay
      return invokePlay
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
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(600 * 1024 * 1024) },
      body: Buffer.from('tiny'),
      duplex: 'half',
    })
    const response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(request)
    assert.equal(response.status, 200, 'the UI-parseable envelope, not a transport error')
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'payload-too-large')
    assert.equal(body.error.message, '文件超过远程上传上限（500 MiB）')
    assert.deepEqual(body.error.details, {})
    assert.equal(relay.calls.length, 0, 'a 600 MiB declaration never starts a doomed round-trip')
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

    relay.setPlay(new RelayError('offline', 'the relay chain answered 502 — the gateway is unreachable', 502))
    response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal(response.status, 200, 'a link death is ALSO the 200 envelope (T51-fix)')
    body = await response.json()
    assert.equal(body.error.code, 'remote-offline')
    assert.equal(body.error.message, '服务端离线，远程会话暂时无法上传文件', 'a STATUS-carrying offline is the chain answering 5xx — the gateway really is down')
  } finally { handle.uninstall() }
})

test('wrap (T5x): a MID-UPLOAD transport death answers the interrupted envelope, not 服务端离线', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = install(connection, relay)
  try {
    // The shape the real client throws when the socket dies UNDER the body
    // (EPIPE / connection reset while an undeclared oversize upload is being
    // cut, or a network fault): code offline, NO HTTP status — the upload
    // route deliberately never judges the link (T51-fix), so this must not
    // claim the server is down.
    relay.setPlay(new RelayError('offline', 'socket hang up'))
    const response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.equal(response.status, 200, 'still the UI-parseable 200 envelope')
    const body = await response.json()
    assert.deepEqual(body, {
      ok: false,
      error: { code: 'upload-interrupted', message: '上传中断，文件可能超过远程上传上限（500 MiB）或网络不稳定', details: {} },
    })
    // The diagnostics ring keeps the relay's own code.
    assert.deepEqual(handle.diagnostics().recentFailures.map((r) => r.code), ['offline'])
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

test('attach (T5x): a refused route does not keep the retry spinning — the probe stops for good', async () => {
  // The probe's only observable is the table read itself, so the fake's Map
  // is a counting subclass: install probes each route once; a running retry
  // would keep adding reads every tick. Upload is MISshaped (refused at
  // first attach), export is healthy and wrapped — nothing is pending, so
  // the interval must never start.
  class CountingMap extends Map {
    constructor() {
      super()
      this.gets = {}
    }
    get(key) {
      this.gets[key] = (this.gets[key] ?? 0) + 1
      return super.get(key)
    }
  }
  const connection = fakeConnection({ upload: { requestBody: 'buffered' } })
  const counting = new CountingMap()
  for (const [key, value] of connection.fetchRoutes) counting.set(key, value)
  connection.fetchRoutes = counting
  const relay = fakeRelay()
  const handle = install(connection, relay, { attachRetryMs: 10, attachAttempts: 10 })
  try {
    const diagnostics = handle.diagnostics()
    assert.equal(diagnostics.uploadAttachRefused !== undefined, true, 'the refusal stands')
    assert.equal(diagnostics.exportWrapped, true)
    assert.equal(diagnostics.uploadPending, false)
    assert.equal(diagnostics.exportPending, false)
    // Far past the 10-tick budget (10 ms × 10): the counts must be frozen at
    // the install-time reads — the shape check and the first attach probe
    // each route once (2 per route); a still-running retry would keep adding
    // reads every tick.
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(counting.gets[FILE_UPLOAD_PATH], 2, `the refused upload route was probed at install only, not retried (${counting.gets[FILE_UPLOAD_PATH]})`)
    assert.equal(counting.gets[SESSION_EXPORT_PATH], 2, `the attached export route was probed at install only, not retried (${counting.gets[SESSION_EXPORT_PATH]})`)
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
  assert.equal(MAX_UPLOAD_BYTES, 500 * 1024 * 1024, 'the message and the gate must move together')
})

// ---- the fallback install judgment (BU-1) ---------------------------------

test('fallback (BU-1): shouldFallbackInstall truth table — only the untouched-and-served row fires', () => {
  // injectSeen x handleSet x refused x servicesPresent: exactly one row may
  // fire — the RD-6 shape (inject silently PENDING, nothing installed, no
  // refusal, BOTH services present). Every other row is a verdict the
  // fallback must respect.
  const rows = [
    // RD-6: the pending inject, services in place — the fallback's one job.
    [{ injectSeen: false, handleSet: false, refused: false, servicesPresent: true }, true],
    // The inject callback fired: the primary path owns the install now.
    [{ injectSeen: true, handleSet: false, refused: false, servicesPresent: true }, false],
    // Already installed (by either path): the double-install guard.
    [{ injectSeen: false, handleSet: true, refused: false, servicesPresent: true }, false],
    // Already refused: a verdict, not a wait — never retried by the timer.
    [{ injectSeen: false, handleSet: false, refused: true, servicesPresent: true }, false],
    // Services absent: a legitimate startup wait (or no upload service at
    // all) — the inject stays first choice, the timer keeps waiting.
    [{ injectSeen: false, handleSet: false, refused: false, servicesPresent: false }, false],
    // Combinations never seen in the wild, pinned anyway: any set bit wins.
    [{ injectSeen: true, handleSet: true, refused: true, servicesPresent: false }, false],
    [{ injectSeen: true, handleSet: false, refused: false, servicesPresent: false }, false],
    [{ injectSeen: false, handleSet: true, refused: true, servicesPresent: true }, false],
    [{ injectSeen: false, handleSet: false, refused: true, servicesPresent: false }, false],
  ]
  for (const [state, expected] of rows) {
    assert.equal(shouldFallbackInstall(state), expected, JSON.stringify(state))
  }
})

test('fallback (BU-1): after a fallback install a later inject trigger stands down — one wrap, one counter', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  // The fallback tick fires (the RD-6 row) and installs through the SAME
  // install function the inject path uses.
  assert.equal(shouldFallbackInstall({ injectSeen: false, handleSet: false, refused: false, servicesPresent: true }), true)
  const fallbackHandle = install(connection, relay)
  try {
    const entry = connection.fetchRoutes.get(FILE_UPLOAD_PATH)
    const wrappedAfterFallback = entry.fetch
    assert.equal(fallbackHandle.diagnostics().installed, true)
    assert.equal(fallbackHandle.diagnostics().uploadWrapped, true)
    // The inject callback fires afterwards: its double-install guard reads
    // the same slots the fallback wrote — the pure judgment says stand down,
    // and the wiring returns WITHOUT calling install a second time. There is
    // no second install to observe directly here; what is pinned is that the
    // entry still holds exactly the fallback's wrapper (a chained second
    // wrap would have replaced it) and the counter stays single.
    assert.equal(
      shouldFallbackInstall({ injectSeen: true, handleSet: true, refused: false, servicesPresent: true }),
      false,
      'the guard the inject callback runs before installing',
    )
    assert.equal(connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch, wrappedAfterFallback)
    // One upload through the wrap: forwarded once, counted once.
    const response = await entry.fetch(uploadRequest(toVirtual(SERVER_ID, LOCAL_ID)))
    assert.deepEqual(JSON.parse(await response.text()), RECEIPT)
    assert.equal(relay.calls.length, 1)
    assert.equal(fallbackHandle.diagnostics().uploadCalls, 1, 'no second wrapper doubled the counters')
    assert.equal(fallbackHandle.diagnostics().uploadForwarded, 1)
  } finally { fallbackHandle.uninstall() }
})

test('fallback (BU-1): a refusal recorded by the primary path keeps every fallback tick idle', () => {
  const connection = fakeConnection({ upload: { requestBody: 'buffered' } })
  const relay = fakeRelay()
  // The inject path ran first and refused the upload entry (misshaped):
  // refused = true — the timer's judgment is false even with services up.
  assert.equal(shouldFallbackInstall({ injectSeen: true, handleSet: false, refused: true, servicesPresent: true }), false)
  // What the primary install DOES cover still stands: the healthy export
  // route wrapped, exactly once.
  const handle = install(connection, relay)
  try {
    const diagnostics = handle.diagnostics()
    assert.equal(diagnostics.exportWrapped, true)
    assert.equal(diagnostics.uploadAttachRefused !== undefined, true)
    assert.equal(connection.fetchRoutes.get(SESSION_EXPORT_PATH).fetch.name, 'wrappedExport', 'the single export wrapper from this install')
  } finally { handle.uninstall() }
})

// ---- MS-4: per-serverId upload routing (getRelayForServer) -----------------

const SERVER_A = 'aaaa1111'
const SERVER_B = 'bbbb2222'

/** A pool-shaped install: the single-server `relay`/`getServerId` stay in
 * the options (the legacy shape is still required) but are decoys — with
 * getRelayForServer present, routing must come from it alone. */
function installPool(connection, relays, decoy = fakeRelay({ serverId: 'deadbeef' })) {
  const handle = installFetchRouteIntercept({
    connection,
    relay: decoy,
    getServerId: () => decoy.handshakeInfo.serverId,
    getRelayForServer: (serverId) => relays[serverId],
    attachRetryMs: 5,
    attachAttempts: 40,
  })
  return { handle, decoy }
}

test('MS-4: uploads to server A and server B sessions each ride their OWN relay client', async () => {
  const connection = fakeConnection()
  const relayA = fakeRelay({ serverId: SERVER_A })
  const relayB = fakeRelay({ serverId: SERVER_B })
  const { handle, decoy } = installPool(connection, { [SERVER_A]: relayA, [SERVER_B]: relayB })
  try {
    const entry = connection.fetchRoutes.get(FILE_UPLOAD_PATH)
    const toA = await entry.fetch(uploadRequest(toVirtual(SERVER_A, 'session-on-a'), 'to-a', 'a.txt'))
    assert.deepEqual(JSON.parse(await toA.text()), RECEIPT)
    const toB = await entry.fetch(uploadRequest(toVirtual(SERVER_B, 'session-on-b'), 'to-b!', 'b.txt'))
    assert.deepEqual(JSON.parse(await toB.text()), RECEIPT)

    assert.equal(relayA.calls.length, 1, 'A got exactly its own upload')
    assert.equal(relayA.calls[0].options.sessionId, 'session-on-a', 'A got the REAL id of its session')
    assert.equal(relayA.calls[0].options.name, 'a.txt')
    assert.equal(relayA.calls[0].bytes.toString('utf8'), 'to-a')
    assert.equal(relayB.calls.length, 1, 'B got exactly its own upload')
    assert.equal(relayB.calls[0].options.sessionId, 'session-on-b')
    assert.equal(relayB.calls[0].bytes.toString('utf8'), 'to-b!')
    assert.equal(decoy.calls.length, 0, 'the single-server relay is never consulted in pool mode')
    assert.equal(connection.seen.upload.length, 0, 'the local route never ran')
    assert.equal(handle.diagnostics().uploadForwarded, 2)
  } finally { handle.uninstall() }
})

test('MS-4: a server the pool does not hold answers remote-mismatch; a held-but-offline one remote-offline', async () => {
  const connection = fakeConnection()
  const relayA = fakeRelay({ serverId: SERVER_A, state: 'offline' })
  const { handle, decoy } = installPool(connection, { [SERVER_A]: relayA })
  try {
    const entry = connection.fetchRoutes.get(FILE_UPLOAD_PATH)
    // Not in the pool (unpaired away, never paired) — and NOT rescued by the
    // decoy's own handshake id either.
    for (const serverId of [SERVER_B, 'deadbeef']) {
      const response = await entry.fetch(uploadRequest(toVirtual(serverId, LOCAL_ID)))
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: false, error: { code: 'remote-mismatch', message: '此远程会话属于其他主服务端', details: {} } }, serverId)
    }
    // In the pool but not online.
    const offline = await entry.fetch(uploadRequest(toVirtual(SERVER_A, LOCAL_ID)))
    assert.deepEqual(await offline.json(), { ok: false, error: { code: 'remote-offline', message: '服务端离线，远程会话暂时无法上传文件', details: {} } })
    assert.equal(relayA.calls.length, 0)
    assert.equal(decoy.calls.length, 0)
    assert.deepEqual(handle.diagnostics().recentFailures.map((r) => r.code), ['remote-mismatch', 'remote-mismatch', 'remote-offline'])
  } finally { handle.uninstall() }
})

test('MS-4: a local session id still reaches the local route untouched in pool mode', async () => {
  const connection = fakeConnection()
  const relayA = fakeRelay({ serverId: SERVER_A })
  const { handle } = installPool(connection, { [SERVER_A]: relayA })
  try {
    const response = await connection.fetchRoutes.get(FILE_UPLOAD_PATH).fetch(uploadRequest(LOCAL_ID, 'local-bytes'))
    assert.deepEqual(await response.json(), { ok: true, value: { receiptId: 'local', bytes: 11 } })
    assert.equal(relayA.calls.length, 0)
  } finally { handle.uninstall() }
})

// ---- P55-2: the /api/file media wrap --------------------------------------

/** A bytes answer shaped the way the relay channel carries it: the server
 * marks readBytes's Uint8Array as `{ $zr-u8: base64 }` (invoke-binary.ts). */
function bytesAnswer(buffer) {
  return { offset: 0, data: { '$zr-u8': Buffer.from(buffer).toString('base64') }, eof: true, absolutePath: '/srv/work/f', version: 'v1' }
}

function fileRequest(path, init = {}) {
  const query = new URLSearchParams({ path })
  if (init.sessionId !== undefined) query.set('sessionId', init.sessionId)
  return new Request(`http://dsh.internal/api/file?${query.toString()}`, { method: init.method ?? 'GET' })
}

/** An install whose resolver attributes `/srv/work/…` to the SERVER_ID
 * session and declines everything else. */
const installFile = (connection, relay, resolver = (path) => (path.startsWith('/srv/work/') ? { serverId: SERVER_ID, sessionId: LOCAL_ID } : undefined)) =>
  install(connection, relay, { resolveRemoteFileScope: resolver })

test('file (P55-2): GET forwards readBytes, restores the $zr-u8 bytes and answers 200 with the safe headers', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  relay.setInvokePlay(bytesAnswer(PNG))
  const handle = installFile(connection, relay)
  try {
    assert.equal(handle.diagnostics().fileWrapped, true, 'the media route is wrapped when a resolver is present')
    const request = fileRequest('/srv/work/chart.png')
    const response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(request)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'")
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('content-length'), String(PNG.length))
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(PNG), 'the exact bytes came back')
    assert.equal(relay.invokes.length, 1)
    assert.deepEqual(
      { namespace: relay.invokes[0].namespace, method: relay.invokes[0].method, args: relay.invokes[0].args },
      { namespace: 'workspaceFiles', method: 'readBytes', args: { workspaceFileScopeId: LOCAL_ID, path: '/srv/work/chart.png', options: {} } },
      'the REAL session id and the absolute path ride to the server',
    )
    assert.equal(relay.invokes[0].signal, request.signal, 'the browser abort rides along')
    assert.equal(connection.seen.file.length, 0, 'the local media route was never reached')
    const diagnostics = handle.diagnostics()
    assert.equal(diagnostics.fileCalls, 1)
    assert.equal(diagnostics.fileForwarded, 1)
    assert.equal(diagnostics.fileRefused, 0)
  } finally { handle.uninstall() }
})

test('file (P55-2): the media type comes from the path extension', async () => {
  const rows = [
    ['a.md', 'text/markdown; charset=utf-8'],
    ['b.HTML', 'text/html; charset=utf-8'],
    ['c.svg', 'image/svg+xml'],
    ['d.mp4', 'video/mp4'],
    ['e.log', 'text/plain; charset=utf-8'],
    ['no-ext', 'application/octet-stream'],
  ]
  for (const [name, expected] of rows) {
    const connection = fakeConnection()
    const relay = fakeRelay()
    relay.setInvokePlay(bytesAnswer('x'))
    const handle = installFile(connection, relay)
    try {
      const response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest(`/srv/work/${name}`))
      assert.equal(response.status, 200, name)
      assert.equal(response.headers.get('content-type'), expected, name)
    } finally { handle.uninstall() }
  }
})

test('file (P55-2): HEAD forwards stat and answers Content-Length without a body', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  relay.setInvokePlay({ absolutePath: '/srv/work/chart.png', version: 'v1', bytes: 4321 })
  const handle = installFile(connection, relay)
  try {
    const response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/srv/work/chart.png', { method: 'HEAD' }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('content-length'), '4321')
    const body = await response.arrayBuffer()
    assert.equal(body.byteLength, 0, 'a HEAD answer carries no body')
    assert.equal(relay.invokes.length, 1)
    assert.deepEqual(
      { namespace: relay.invokes[0].namespace, method: relay.invokes[0].method, args: relay.invokes[0].args },
      { namespace: 'workspaceFiles', method: 'stat', args: { workspaceFileScopeId: LOCAL_ID, path: '/srv/work/chart.png' } },
      'stat takes the scope and the path, no options',
    )
    assert.equal(connection.seen.file.length, 0)
  } finally { handle.uninstall() }
})

test('file (P55-2): oversize answers 413 — the stat gate, the byte gate and the too-large error alike', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = installFile(connection, relay)
  try {
    // stat reports a size past the cap: refused before any body moves.
    relay.setInvokePlay({ absolutePath: '/srv/work/huge.png', version: 'v1', bytes: MAX_FILE_MEDIA_BYTES + 1 })
    let response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/srv/work/huge.png', { method: 'HEAD' }))
    assert.equal(response.status, 413)
    assert.equal(relay.invokes.length, 1, 'stat ran, readBytes never did')

    // The server's own cap refuses the read (workspace-file/too-large).
    relay.setInvokePlay(new RelayError('workspace-file/too-large', '"huge.png" exceeds the cap', 413))
    response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/srv/work/huge.png'))
    assert.equal(response.status, 413)
    assert.equal(relay.invokes.length, 2)

    // A restored body past the cap (the server cap was raised, ours stands) is refused too.
    relay.setInvokePlay(bytesAnswer(Buffer.alloc(MAX_FILE_MEDIA_BYTES + 1)))
    response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/srv/work/huge.png'))
    assert.equal(response.status, 413)
    assert.equal(handle.diagnostics().fileRefused, 3)
  } finally { handle.uninstall() }
})

test('file (P55-2): a remote not-found falls back to the local route — its 200 is adopted, otherwise 404', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  // The ORIGINAL local route is swapped before install (so the wrap saves
  // THIS one) and answers via a flag the test flips mid-test.
  let localMisses = false
  connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch = async (request) => {
    connection.seen.file.push(request)
    return localMisses ? new Response('missing', { status: 404 }) : new Response('local-file', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  relay.setInvokePlay(new RelayError('workspace-file/not-found', 'no entry at "/srv/work/gone.png"', 404))
  const handle = installFile(connection, relay)
  try {
    // The local route still has the file: its answer wins.
    let response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/srv/work/gone.png'))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'local-file', 'the local answer was adopted')
    assert.equal(connection.seen.file.length, 1)

    // The local route misses too: an honest 404 for the <img> to unload on.
    localMisses = true
    response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/srv/work/gone.png'))
    assert.equal(response.status, 404)
    assert.equal(relay.invokes.length, 2, 'both attempts went through the relay first')
  } finally { handle.uninstall() }
})

test('file (P55-2): relay refusals map to honest statuses — permission 403, link death 503, other 502', async () => {
  const rows = [
    [new RelayError('FS_PERMISSION_DENIED', 'denied'), 403],
    [new RelayError('workspace-file/not-regular-file', 'a directory', 403), 403],
    [new RelayError('not-shared', 'the session is not shared any more', 403), 403],
    [new RelayError('offline', 'the chain answered 502', 502), 503],
    [new RelayError('gateway/invocation-unavailable', 'no such method', 400), 502],
    ['plain-error', 502],
  ]
  for (const [play, expected] of rows) {
    const connection = fakeConnection()
    const relay = fakeRelay()
    relay.setInvokePlay(play === 'plain-error' ? new Error('boom') : play)
    const handle = installFile(connection, relay, () => ({ serverId: SERVER_ID, sessionId: LOCAL_ID }))
    try {
      const response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/srv/work/x.png'))
      assert.equal(response.status, expected, `code ${(play.code ?? 'plain')} → ${expected}`)
      assert.equal(connection.seen.file.length, 0, `the local route stayed out of a ${expected}`)
    } finally { handle.uninstall() }
  }
})

test('file (P55-2): an offline relay answers 503 and another server\'s scope 403s, nothing travels', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay({ state: 'offline' })
  const handle = installFile(connection, relay)
  try {
    const response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/srv/work/chart.png'))
    assert.equal(response.status, 503)
    assert.equal(relay.invokes.length, 0)
    assert.equal(handle.diagnostics().fileRefused, 1)
  } finally { handle.uninstall() }

  const connection2 = fakeConnection()
  const relay2 = fakeRelay()
  const foreign = installFile(connection2, relay2, () => ({ serverId: 'ffffffff', sessionId: 's' }))
  try {
    const response = await connection2.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/srv/work/chart.png'))
    assert.equal(response.status, 403, 'a server the single-server wiring does not hold refuses')
    assert.equal(relay2.invokes.length, 0)
  } finally { foreign.uninstall() }
})

test('file (P55-2): an explicit virtual sessionId forwards without cwd help; a local one passes through', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  relay.setInvokePlay(bytesAnswer('x'))
  const handle = installFile(connection, relay, () => undefined)
  try {
    const remote = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/anywhere/x.png', { sessionId: toVirtual(SERVER_ID, LOCAL_ID) }))
    assert.equal(remote.status, 200)
    assert.equal(relay.invokes.length, 1, 'the explicit virtual id decided the scope on its own')
    assert.equal(relay.invokes[0].args.workspaceFileScopeId, LOCAL_ID)

    const local = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/anywhere/x.png', { sessionId: LOCAL_ID }))
    assert.equal(local.status, 200)
    assert.equal(await local.text(), 'local-file', 'the local id reached the local route')
    assert.equal(relay.invokes.length, 1, 'nothing extra traveled')
  } finally { handle.uninstall() }
})

test('file (P55-2): a path the resolver declines passes through to the local route untouched', async () => {
  const connection = fakeConnection()
  const relay = fakeRelay()
  const handle = installFile(connection, relay)
  try {
    const response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/local/only/shot.png'))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'local-file')
    assert.equal(connection.seen.file.length, 1, 'the ORIGINAL route answered')
    assert.equal(relay.invokes.length, 0, 'nothing traveled')
    const diagnostics = handle.diagnostics()
    assert.equal(diagnostics.fileForwarded, 0)
    assert.equal(diagnostics.fileCalls, 1)
  } finally { handle.uninstall() }
})

test('file (P55-2): without a resolver the media route is never probed, wrapped or counted', async () => {
  class CountingMap extends Map {
    constructor() {
      super()
      this.gets = {}
    }
    get(key) {
      this.gets[key] = (this.gets[key] ?? 0) + 1
      return super.get(key)
    }
  }
  const connection = fakeConnection()
  const counting = new CountingMap()
  for (const [key, value] of connection.fetchRoutes) counting.set(key, value)
  connection.fetchRoutes = counting
  const relay = fakeRelay()
  const handle = install(connection, relay, { attachRetryMs: 10, attachAttempts: 10 })
  try {
    const diagnostics = handle.diagnostics()
    assert.equal(diagnostics.fileWrapped, undefined, 'the media fields stay absent without the resolver')
    assert.equal(diagnostics.filePending, undefined)
    assert.equal(diagnostics.fileCalls, undefined)
    // The legacy routes probed exactly twice each (shape check + first
    // attach); the media route was NEVER read.
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(counting.gets[FILE_UPLOAD_PATH], 2)
    assert.equal(counting.gets[SESSION_EXPORT_PATH], 2)
    assert.equal(counting.gets[FILE_MEDIA_PATH], undefined, 'no probe ever touched the media route')
    // And the unwrapped route serves directly.
    const response = await counting.get(FILE_MEDIA_PATH).fetch(fileRequest('/srv/work/chart.png'))
    assert.equal(await response.text(), 'local-file')
  } finally { handle.uninstall() }
})

test('file (P55-2): with a resolver a late-registered media entry attaches via the retry and serves', async () => {
  const connection = fakeConnection({ file: null })
  const relay = fakeRelay()
  relay.setInvokePlay(bytesAnswer('x'))
  const handle = installFile(connection, relay)
  try {
    let diagnostics = handle.diagnostics()
    assert.equal(diagnostics.fileWrapped, false)
    assert.equal(diagnostics.filePending, true, 'absent and still retrying')

    connection.fetchRoutes.set(FILE_MEDIA_PATH, {
      methods: new Set(['GET', 'HEAD']),
      requestBody: 'buffered',
      fetch: async () => new Response('local-file', { status: 200 }),
    })
    const start = Date.now()
    while (Date.now() - start < 2000) {
      if (handle.diagnostics().fileWrapped) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    diagnostics = handle.diagnostics()
    assert.equal(diagnostics.fileWrapped, true, 'the late media entry got wrapped')
    assert.equal(diagnostics.filePending, false)

    const response = await connection.fetchRoutes.get(FILE_MEDIA_PATH).fetch(fileRequest('/srv/work/chart.png'))
    assert.equal(response.status, 200)
    assert.equal(relay.invokes.length, 1)
  } finally { handle.uninstall() }
})

test('file (P55-2): the pinned cap and the media route path name', () => {
  assert.equal(FILE_MEDIA_PATH, '/api/file')
  assert.equal(MAX_FILE_MEDIA_BYTES, 20 * 1024 * 1024)
})
