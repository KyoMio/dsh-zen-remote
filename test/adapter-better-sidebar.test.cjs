/* dsh-zen-remote · the better-sidebar adapter (PB-12, widened to 0.26.0 by PB-15)
 *
 * Drives the BUILT lib/adapters/* + the framework halves over real
 * sockets. Layers:
 *  1. the METHOD TABLE vs the plugin's OWN source: every method name the
 *     0.25.0 AND 0.26.0 builds dispatch must appear in the table — the
 *     table must cover exactly the union (skip with a note when
 *     /tmp/bs-versions/ is not on this machine);
 *  2. the client half over a fake host + fake relay: one read, one write,
 *     a rootSessionId call, settings staying local, open.external and
 *     sidechat refusing, an unknown method refusing, cwd stripped from the
 *     loopback query, and the three response rewrites;
 *  3. the server half: cwd stripped before the loopback; the html route's
 *     CSP header riding through; upload bytes verbatim; bundle forever
 *     local.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const PLUGIN_SOURCES = [
  '/tmp/bs-versions/0.25.0/lib/index.js',
  '/tmp/bs-versions/0.26.0/lib/index.js',
  '/tmp/bs-versions/0.26.1/lib/index.js',
  '/tmp/bs-versions/0.28.0-alpha.0/lib/index.js',
  '/tmp/bs-versions/0.28.0/lib/index.js',
  '/tmp/bs-versions/0.28.1/lib/index.js',
  '/tmp/bs-versions/0.28.2/lib/index.js',
]

/** Scratch space for the server-side share store — OUTSIDE the repository
 * (a store file in the repo root once landed in the commit staging by
 * accident; PB-13 fix). */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-bs-'))
process.on('exit', () => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

const importLib = async (name) => import(pathToFileURL(path.join(__dirname, '..', 'lib', name)).href)

const SERVER_ID = 'abcd1234'
const virtual = (id) => `zr~${SERVER_ID}~${id}`

// ---- 1. the method table vs the plugin's own source ---------------------------

test('PB-12/PB-15 table: every method the 0.25.0+0.26.0 sources dispatch is in the table (exactly the union)', async () => {
  const adapterMod = await importLib('adapters/dsh-better-sidebar/methods.js')
  const absent = PLUGIN_SOURCES.filter((sourcePath) => !fs.existsSync(sourcePath))
  if (absent.length > 0) {
    test.skip(`plugin sources are not on this machine (${absent.join(', ')}); the table-vs-source comparison is skipped`)
    return
  }
  // The dispatcher's own method names, extracted from BOTH builds and
  // unioned: every `"x.y": async (payload) =>` entry of buildApi's table
  // (0.25.0 lib/index.js:6319-6688; 0.26.0 grows fs.readPage and the
  // sidechat trio, and drops fs.write to the /sidebar/write route), the
  // sidechat builder's keys, and the spread of buildSidechatApi into the
  // table.
  const names = new Set()
  for (const sourcePath of PLUGIN_SOURCES) {
    const source = fs.readFileSync(sourcePath, 'utf8')
    for (const match of source.matchAll(/"([a-zA-Z]+\.[a-zA-Z-]+)":\s*(?:async\s*)?\(/g)) {
      names.add(match[1])
    }
  }
  // Restrict to the sidebar namespaces (the same regex catches unrelated
  // object tables elsewhere in the bundle).
  const sidebarNames = [...names].filter((name) => /^(session|fs|git|changes|subagents|workflows|teams|settings|open|archive|sidechat)\./.test(name))
  assert.ok(sidebarNames.length >= 45, `the extraction found the union table (${sidebarNames.length} names)`)
  const missing = sidebarNames.filter((name) => adapterMod.SIDEBAR_METHODS[name] === undefined)
  assert.deepEqual(missing, [], `methods the plugin dispatches but the table lacks: ${missing.join(', ')}`)
  // And the reverse direction: a table entry NEITHER build dispatches any
  // more is a dead row (harmless but worth noticing). fs.write stays: it
  // rode the 0.25.0 JSON api and the table must keep serving 0.25.0 hosts.
  const extra = Object.keys(adapterMod.SIDEBAR_METHODS).filter((name) => !names.has(name))
  assert.deepEqual(extra, [], `table entries neither source dispatches: ${extra.join(', ')}`)
})

// ---- PB-18: the surface extractor — same wire, same digest -----------------------

test('PB-18: extractBetterSidebarSurface is deterministic and groups the fixture versions by wire generation', async () => {
  const absent = PLUGIN_SOURCES.filter((sourcePath) => !fs.existsSync(sourcePath))
  if (absent.length > 0) {
    test.skip(`plugin sources are not on this machine (${absent.join(', ')}); the surface extraction is skipped`)
    return
  }
  const mod = await importLib('adapters/dsh-better-sidebar/surface.js')
  const surfaces = new Map()
  for (const sourcePath of PLUGIN_SOURCES) {
    const source = fs.readFileSync(sourcePath, 'utf8')
    const surface = mod.extractBetterSidebarSurface(source)
    // Deterministic: same source in, identical arrays out, twice in a row.
    assert.deepEqual(mod.extractBetterSidebarSurface(source), surface, `${sourcePath} extraction is not deterministic`)
    assert.equal(mod.surfaceLooksHealthy(surface), true, `${sourcePath}: extraction looks empty (${surface.methods.length} methods, ${surface.routes.length} routes)`)
    surfaces.set(sourcePath, { surface, digest: mod.betterSidebarSurfaceDigest(surface) })
  }
  const digestOf = (version) => surfaces.get(`/tmp/bs-versions/${version}/lib/index.js`).digest
  // Wire-identical patch releases share a digest — the whole point of ADR-0003:
  // 0.26.1 was perf-only, 0.28.2 only changed backend cwd resolution.
  assert.equal(digestOf('0.26.0'), digestOf('0.26.1'), '0.26.0 and 0.26.1 must share a wire surface')
  assert.equal(digestOf('0.28.1'), digestOf('0.28.2'), '0.28.1 and 0.28.2 must share a wire surface')
  // Distinct generations differ: fs.readPage arrived in 0.26.0, git.history in 0.28.1.
  assert.notEqual(digestOf('0.25.0'), digestOf('0.26.0'), '0.25.0 and 0.26.0 are different wire surfaces')
  assert.notEqual(digestOf('0.26.0'), digestOf('0.28.1'), '0.26.x and 0.28.1 are different wire surfaces')
  assert.notEqual(digestOf('0.28.0'), digestOf('0.28.1'), '0.28.0 and 0.28.1 are different wire surfaces (git.history)')
  // And the empty-source tell: nothing healthy about a non-build.
  assert.equal(mod.surfaceLooksHealthy(mod.extractBetterSidebarSurface('')), false)
})

test('PB-15: the 0.26.0 additions carry the right dispositions; both versions normalize; /sidebar/write is declared', async () => {
  const adapterMod = await importLib('adapters/dsh-better-sidebar/methods.js')
  const specOf = (name) => adapterMod.SIDEBAR_METHODS[name]
  // fs.readPage: a paged read, session-scoped like the fs.read family
  // (0.26.0 lib/index.js:7332-7338) — no rewrite (the answer is file text).
  assert.deepEqual({ ...specOf('fs.readPage') }, { kind: 'read', sessionField: 'sessionId' })
  // sidechat.dequeue / sidechat.model: child-scoped writes
  // (0.26.0 lib/index.js:6206, 6229).
  assert.deepEqual({ ...specOf('sidechat.dequeue') }, { kind: 'write', sessionField: 'childId' })
  assert.deepEqual({ ...specOf('sidechat.model') }, { kind: 'write', sessionField: 'childId' })
  // sidechat.models: the model catalog, NO session field → local, the
  // settings.* precedent (0.26.0 lib/index.js:6228).
  assert.deepEqual({ ...specOf('sidechat.models') }, { kind: 'read', local: true })

  // Both versions register: normalizeAdapter refuses an installed version
  // outside `versions`, so each list entry must normalize clean.
  const { adapter } = await loadAdapter()
  assert.deepEqual(adapter.versions, ['0.25.0', '0.26.0', '0.26.1', '0.28.0-alpha.0', '0.28.0', '0.28.1', '0.28.2'])
  for (const version of ['0.25.0', '0.26.0', '0.26.1', '0.28.0-alpha.0', '0.28.0', '0.28.1', '0.28.2']) {
    const core = await importLib('plugin-adapter-core.js')
    const adaptersMod = await importLib('adapters/index.js')
    const raw = adaptersMod.ADAPTERS.find((entry) => entry.plugin === 'dsh-better-sidebar')
    const normalized = core.normalizeAdapter(raw, version)
    assert.equal(normalized.plugin, 'dsh-better-sidebar', `${version} normalizes`)
  }

  // The raw text-write route (0.26.0 lib/index.js:7875-7919): exact, POST,
  // the session id rides the query, 10 MiB — headroom over the plugin's
  // own 8 MiB WRITE_BODY_GUARD_BYTES, under the relay's 500 MiB.
  const write = adapter.routes.find((route) => route.path === '/sidebar/write')
  assert.ok(write !== undefined, '/sidebar/write is declared')
  assert.equal(write.match, 'exact')
  assert.deepEqual(write.methods, ['POST'])
  assert.deepEqual(write.locator, { in: 'query', name: 'sessionId' })
  assert.equal(write.maxBody, 10 * 1024 * 1024)
  assert.equal(write.local, false, 'it forwards — that is its whole point')
  assert.equal(write.upgrade, false)
})

// ---- shared fixtures -----------------------------------------------------------

async function loadAdapter() {
  const adaptersMod = await importLib('adapters/index.js')
  const core = await importLib('plugin-adapter-core.js')
  const adapter = adaptersMod.ADAPTERS.find((entry) => entry.plugin === 'dsh-better-sidebar')
  assert.ok(adapter !== undefined, 'the adapter is registered')
  return { adapter: core.normalizeAdapter(adapter, '0.25.0'), rawAdapter: adapter }
}

function startFakeHost() {
  const hits = { local: 0, localWs: 0 }
  let raw
  const server = http.createServer((req, res) => {
    Promise.resolve(raw.match(new URL(req.url ?? '/', 'http://x').pathname)).then(async (route) => {
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    }).catch(() => { try { res.destroy() } catch { /* gone */ } })
  })
  // Without an 'upgrade' listener node destroys every upgrading socket —
  // the fake host dispatches them through the raw table (the interceptor
  // shadows `upgrades.get`). Upgraded sockets also ESCAPE
  // closeAllConnections (the PB-10 finding), so they are tracked and
  // destroyed at teardown by hand.
  const upgradeSockets = new Set()
  server.on('upgrade', (req, socket, head) => {
    upgradeSockets.add(socket)
    socket.on('close', () => upgradeSockets.delete(socket))
    const route = raw.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (route !== undefined) {
      route.handler(req, socket, head)
      return
    }
    socket.destroy()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      raw = {
        exact: new Map(), prefixes: new Map(), upgrades: new Map(),
        match(pathname) {
          const exact = this.exact.get(pathname)
          if (exact !== undefined) return exact
          for (const [prefix, route] of this.prefixes) {
            if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return route
          }
          return undefined
        },
        register(route) {
          ;(route.kind === 'exact' ? this.exact : this.prefixes).set(route.path, route)
          return () => undefined
        },
      }
      raw.register({
        kind: 'prefix', path: '/sidebar/api',
        handler: async (req, res) => {
          hits.local += 1
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, value: { local: true } }))
        },
      })
      raw.register({
        kind: 'prefix', path: '/sidebar/bundle',
        handler: async (req, res) => {
          hits.local += 1
          res.writeHead(200, { 'content-type': 'text/javascript' })
          res.end('/* bundle */')
        },
      })
      // The LOCAL WS endpoint the adapter's upgrade routes shadow: a LOCAL
      // session's upgrade must land HERE, never in the tunnel (the PB-13
      // fix's direct assertion). The accept is computed for real — undici
      // validates it and fails the connection otherwise.
      raw.upgrades.set('/sidebar/ws/fs-watch', {
        path: '/sidebar/ws/fs-watch',
        handler: (req, socket) => {
          hits.localWs += 1
          const key = req.headers['sec-websocket-key']
          const accept = key === undefined
            ? 'invalid'
            : require('node:crypto').createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
        },
      })
      resolve({
        raw, hits, port,
        get: (pathWithQuery, init = {}) => fetch(`http://127.0.0.1:${port}${pathWithQuery}`, init),
        stop: () => new Promise((done) => {
          for (const socket of upgradeSockets) socket.destroy()
          server.closeAllConnections()
          server.close(done)
        }),
      })
    })
  })
}

function fakeRelayClient() {
  const forwarded = []
  const answers = new Map()
  return {
    forwarded,
    answer(path, answer) { answers.set(path, answer) },
    pluginRequest: async (request) => {
      const bodyChunks = []
      if (request.body !== undefined && request.body !== null) {
        for await (const chunk of request.body) bodyChunks.push(Buffer.from(chunk))
      }
      forwarded.push({
        plugin: request.plugin, version: request.version, digest: request.digest,
        path: request.path, query: request.query, method: request.method,
        body: bodyChunks.length > 0 ? Buffer.concat(bodyChunks).toString('utf8') : undefined,
      })
      const answer = answers.get(request.path) ?? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, value: {} }) }
      return new Response(answer.body, { status: answer.status, headers: answer.headers })
    },
  }
}

async function installedIntercept(host, relay, adapter, { currentSession } = {}) {
  const mod = await importLib('plugin-route-intercept.js')
  const bridgeMod = await importLib('plugin-bridge.js')
  const registry = bridgeMod.createBridgeRegistry()
  registry.registerNormalized(adapter.declaration)
  return mod.installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay,
    getServerId: () => SERVER_ID,
    getStatus: () => bridgeMod.compareBridges(registry.list(), { 'dsh-better-sidebar': { version: '0.25.0', digest: adapter.digest, serverScopeConsent: true } }, true),
    adapters: [adapter],
    getCurrentSession: () => currentSession,
  })
}

// ---- 2. the client half --------------------------------------------------------

test('PB-12 client: a read and a write forward with real ids; settings stays local; open.external refuses for a remote panel', async () => {
  const host = await startFakeHost()
  const relay = fakeRelayClient()
  const { adapter } = await loadAdapter()
  const handle = await installedIntercept(host, relay, adapter, { currentSession: virtual('session-a') })
  try {
    // A READ: fs.tree with a virtual sessionId AND a client cwd (stripped
    // server-side; the client half forwards it — the SERVER test proves
    // the strip).
    const read = await host.get('/sidebar/api/fs.tree', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual('session-a'), cwd: '/home/me/leaked', path: 'src' }),
    })
    assert.equal(read.status, 200)
    assert.equal(relay.forwarded.length, 1)
    const readBody = JSON.parse(relay.forwarded[0].body)
    assert.equal(readBody.sessionId, 'session-a', 'the id arrived REAL')
    assert.equal(relay.forwarded[0].path, '/sidebar/api/fs.tree')

    // A WRITE: git.commit with only the session field.
    await host.get('/sidebar/api/git.commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual('session-a'), message: 'ship' }),
    })
    assert.equal(relay.forwarded.length, 2)
    assert.equal(JSON.parse(relay.forwarded[1].body).message, 'ship')

    // A rootSessionId call forwards the same way.
    await host.get('/sidebar/api/subagents.live', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootSessionId: virtual('session-a') }),
    })
    assert.equal(relay.forwarded.length, 3)
    assert.equal(JSON.parse(relay.forwarded[2].body).rootSessionId, 'session-a')

    // settings.get carries no session field → nothing located → LOCAL.
    const settings = await host.get('/sidebar/api/settings.get', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.deepEqual(await settings.json(), { ok: true, value: { local: true } })
    assert.equal(host.hits.local, 1)
    assert.equal(relay.forwarded.length, 3, 'settings never left the machine')

    // sidechat.start FORWARDS now (PB-13): the child session inherits the
    // parent's share via meta.parentSession, so it crosses like everything
    // else — and its answer's childId comes back virtual (asserted in the
    // closed-loop test below).
    await host.get('/sidebar/api/sidechat.start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual('session-a'), question: 'hi' }),
    })
    assert.equal(relay.forwarded.length, 4)
    assert.equal(relay.forwarded[3].path, '/sidebar/api/sidechat.start')
    assert.equal(JSON.parse(relay.forwarded[3].body).sessionId, 'session-a')
    assert.equal(host.hits.local, 1, 'sidechat no longer falls to the local plugin')

    // open.external refuses when the CURRENT session is remote (deny hook).
    const openRemote = await host.get('/sidebar/api/open.external', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reveal', path: '/etc' }),
    })
    assert.equal(openRemote.status, 503)
    assert.equal((await openRemote.json()).error.reason, 'remote-open-unsupported')
    assert.equal(host.hits.local, 1)

    // …and stays LOCAL when the current session is a local one.
    handle.uninstall()
    const localHandle = await installedIntercept(host, relay, adapter, { currentSession: 'session-local' })
    const openLocal = await host.get('/sidebar/api/open.external', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reveal', path: '/etc' }),
    })
    assert.deepEqual(await openLocal.json(), { ok: true, value: { local: true } })
    assert.equal(host.hits.local, 2, 'the local open.external reached the local plugin')

    // A LOCAL session's sidechat.start stays local too (PB-13 fix's direct
    // assertion): the plain id locates to nothing remote, the local
    // handler answers, the relay sees nothing.
    const forwardedBeforeLocalSidechat = relay.forwarded.length
    const localSidechat = await host.get('/sidebar/api/sidechat.start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-local', question: 'hi' }),
    })
    assert.deepEqual(await localSidechat.json(), { ok: true, value: { local: true } })
    assert.equal(host.hits.local, 3, 'the local sidechat reached the local plugin')
    assert.equal(relay.forwarded.length, forwardedBeforeLocalSidechat, 'the local sidechat never left the machine')

    // A LOCAL session's WebSocket lands on the LOCAL upgrade handler —
    // the tunnel never opens (PB-13 fix's direct assertion).
    const forwardedBefore = relay.forwarded.length
    const localWs = new WebSocket(`ws://127.0.0.1:${host.port}/sidebar/ws/fs-watch?sessionId=session-local`)
    const wsOutcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 3000)
      localWs.addEventListener('open', () => { clearTimeout(timer); resolve('open') })
      localWs.addEventListener('error', () => { clearTimeout(timer); resolve('error') })
    })
    assert.equal(wsOutcome, 'open', 'the local upgrade answered 101 from the LOCAL handler')
    assert.equal(host.hits.localWs, 1, 'the LOCAL upgrade handler ran')
    localWs.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(relay.forwarded.length, forwardedBefore, 'no tunnel ever opened for the local session')
    localHandle.uninstall()
  } finally {
    handle.uninstall()
    await host.stop()
  }
})

test('PB-12 client: an unknown method refuses; a duplicated query id refuses', async () => {
  const host = await startFakeHost()
  const relay = fakeRelayClient()
  const { adapter } = await loadAdapter()
  const handle = await installedIntercept(host, relay, adapter)
  try {
    // A method the 0.25.1-era plugin grew but the 0.25.0 table lacks.
    const unknown = await host.get('/sidebar/api/git.rebase-interactive', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual('session-a') }),
    })
    assert.equal(unknown.status, 503)
    assert.equal((await unknown.json()).error.reason, 'adapter-method-unknown')
    assert.equal(host.hits.local, 0, 'the unknown method never reached the local plugin')

    // The file route with a duplicated sessionId → bad-query, no forward.
    const dupe = await host.get(`/sidebar/file?sessionId=${encodeURIComponent(virtual('a'))}&sessionId=${encodeURIComponent(virtual('b'))}&path=x`)
    assert.equal(dupe.status, 503)
    assert.equal((await dupe.json()).error.reason, 'bad-query')
    assert.equal(relay.forwarded.length, 0)

    // The archive download forwards as a plain GET with the rewritten id.
    const archive = await host.get(`/sidebar/archive?sessionId=${encodeURIComponent(virtual('session-a'))}&id=ar-1`)
    assert.equal(archive.status, 200)
    assert.equal(relay.forwarded.length, 1)
    assert.equal(relay.forwarded[0].path, '/sidebar/archive')
    assert.equal(relay.forwarded[0].query, 'sessionId=session-a&id=ar-1', 'the id arrived REAL, the task id untouched')

    // The bundle chunks are LOCAL forever: a virtual id in the query does
    // not matter — the local handler serves, the relay never sees it.
    const bundle = await host.get(`/sidebar/bundle/chunk-1.js?sessionId=${encodeURIComponent(virtual('session-a'))}`)
    assert.equal(bundle.status, 200)
    assert.equal(await bundle.text(), '/* bundle */')
    assert.equal(host.hits.local, 1, 'the local bundle handler served it')
    assert.equal(relay.forwarded.length, 1, 'nothing extra left for the relay')
  } finally {
    handle.uninstall()
    await host.stop()
  }
})

test('PB-12 client: the three response rewrites — session.cwd, subagents.live keys, workflows.list rows', async () => {
  const host = await startFakeHost()
  const relay = fakeRelayClient()
  const { adapter } = await loadAdapter()
  const handle = await installedIntercept(host, relay, adapter)
  try {
    // session.cwd echoes the request's sessionId (lib/index.js:6327).
    // Every /sidebar/api success rides writeOk's {ok:true, value} envelope
    // (lib/index.js:889-896) — the fakes below use the REAL wire shape
    // (2026-10-13 fix: the adapter used to miss the id inside the envelope).
    relay.answer('/sidebar/api/session.cwd', {
      status: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, value: { sessionId: 'session-a', cwd: '/srv/proj', root: 'proj', parent: null } }),
    })
    const cwd = await host.get('/sidebar/api/session.cwd', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual('session-a') }),
    })
    assert.deepEqual(await cwd.json(), { ok: true, value: { sessionId: virtual('session-a'), cwd: '/srv/proj', root: 'proj', parent: null } }, 'the envelope survives, the id inside is VIRTUAL')

    // subagents.live keys the map BY session id (lib/index.js:4513).
    relay.answer('/sidebar/api/subagents.live', {
      status: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, value: { live: { 'session-a': { running: true }, 'session-child': { text: 'hi' } } } }),
    })
    const live = await host.get('/sidebar/api/subagents.live', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootSessionId: virtual('session-a') }),
    })
    const liveBody = await live.json()
    assert.deepEqual(Object.keys(liveBody.value.live).sort(), [virtual('session-child'), virtual('session-a')].sort(), 'every key came back VIRTUAL')

    // workflows.list rows carry originSessionId + members[].childId
    // (lib/index.js:4666, 4686).
    relay.answer('/sidebar/api/workflows.list', {
      status: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, value: {
        runs: [{
          runId: 'r1', originSessionId: 'session-child', status: 'running',
          phases: [{ title: 'p', members: [{ seq: 1, label: '#1', childId: 'session-grandchild' }] }],
        }],
      } }),
    })
    const workflows = await host.get('/sidebar/api/workflows.list', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootSessionId: virtual('session-a') }),
    })
    const workflowsBody = await workflows.json()
    assert.equal(workflowsBody.value.runs[0].originSessionId, virtual('session-child'))
    assert.equal(workflowsBody.value.runs[0].phases[0].members[0].childId, virtual('session-grandchild'))

    // teams.taskCreate is NOT rewritten (its answer carries no session id).
    relay.answer('/sidebar/api/teams.taskCreate', {
      status: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, value: { id: 't1', subject: 'x' } }),
    })
    const teams = await host.get('/sidebar/api/teams.taskCreate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootSessionId: virtual('session-a'), subject: 'x' }),
    })
    assert.deepEqual(await teams.json(), { ok: true, value: { id: 't1', subject: 'x' } }, 'untouched')
  } finally {
    handle.uninstall()
    await host.stop()
  }
})

// ---- 3. the server half --------------------------------------------------------

async function startServerSide({ consent = true, loopbackHits, loopbackHeaders, parentOf } = {}) {
  const relayServerMod = await importLib('relay-server.js')
  const shareStoreMod = await importLib('share-store.js')
  const store = shareStoreMod.createShareStore({ file: path.join(TMP_ROOT, `srv-${Math.random().toString(36).slice(2)}.json`), idleHours: 48 })
  store.share('session-a')
  const loopback = {
    cookieHeader: async () => 'dsh-auth=t',
    request: async (method, path, query, headers, body, signal) => {
      const chunks = []
      if (body !== undefined && body !== null) {
        await new Promise((resolve, reject) => {
          body.on('data', (c) => chunks.push(c))
          body.on('end', resolve)
          body.on('error', reject)
          signal?.addEventListener('abort', () => { try { body.destroy() } catch { /* gone */ } })
        })
      }
      loopbackHits.push({ method, path, query, body: Buffer.concat(chunks).toString('utf8') })
      return {
        status: 200,
        contentType: 'application/json',
        contentLength: undefined,
        cacheControl: undefined,
        extraHeaders: loopbackHeaders ?? {},
        stream: (await import('node:stream')).Readable.from([JSON.stringify({ ok: true })]),
      }
    },
  }
  const { adapter } = await loadAdapter()
  const bridgeMod = await importLib('plugin-bridge.js')
  const registry = bridgeMod.createBridgeRegistry()
  registry.registerNormalized(adapter.declaration)
  const handler = relayServerMod.createRelayHandler({
    secret: 's'.repeat(64),
    store,
    // The ancestor walk (PB-13): a sidechat child inherits its parent's
    // share through this chain.
    ...(parentOf !== undefined ? { parentOf } : {}),
    gateway: { invoke: async () => { throw new Error('no') }, stream: async () => { throw new Error('no') } },
    pluginBridge: {
      registry,
      getConsent: () => (consent ? { 'dsh-better-sidebar': true } : {}),
      loopback,
      adapters: [adapter],
    },
  })
  const server = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } }) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    loopbackHits,
    pluginPost: (pluginPath, query, { method = 'POST', body } = {}) =>
      fetch(`http://127.0.0.1:${port}/_dsh/zen-remote/relay/v1/plugin`, {
        method: 'POST',
        headers: {
          'x-zen-remote-secret': 's'.repeat(64),
          'x-zen-remote-via': 'gateway',
          'x-zen-remote-role': 'desktop-client',
          'x-zen-remote-device': 'dev-1',
          'x-zr-plugin': 'dsh-better-sidebar',
          'x-zr-plugin-version': '0.25.0',
          'x-zr-plugin-digest': adapter.digest,
          'x-zr-path': pluginPath,
          'x-zr-query': query ?? '',
          'x-zr-method': method,
          ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      }),
    stop: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }),
  }
}

test('PB-12 server: the cwd is stripped from the api body AND the file/upload query before the loopback', async () => {
  const loopbackHits = []
  const server = await startServerSide({ loopbackHits })
  try {
    // The api body's cwd goes; everything else stays.
    const api = await server.pluginPost('/sidebar/api/fs.tree', '', {
      body: JSON.stringify({ sessionId: 'session-a', cwd: '/home/me/leaked', path: 'src' }),
    })
    assert.equal(api.status, 200)
    assert.equal(loopbackHits.length, 1)
    const apiBody = JSON.parse(loopbackHits[0].body)
    assert.equal(apiBody.cwd, undefined, 'the body cwd was stripped')
    assert.equal(apiBody.sessionId, 'session-a')
    assert.equal(apiBody.path, 'src')

    // The file route's query cwd goes; sessionId and path stay.
    const file = await server.pluginPost('/sidebar/file', `sessionId=session-a&path=p.png&cwd=${encodeURIComponent('/home/me/leaked')}`, { method: 'GET' })
    assert.equal(file.status, 200)
    assert.equal(loopbackHits.length, 2)
    assert.equal(loopbackHits[1].query.includes('cwd='), false, 'the query cwd was stripped')
    assert.ok(loopbackHits[1].query.includes('sessionId=session-a'))
    assert.ok(loopbackHits[1].query.includes('path=p.png'))

    // The upload route's query cwd goes too.
    const upload = await server.pluginPost('/sidebar/upload', `sessionId=session-a&dir=assets&relativePath=a.png&cwd=${encodeURIComponent('/leaked')}`, { body: Buffer.from([1, 2, 3]).toString('binary') })
    assert.equal(upload.status, 200)
    assert.equal(loopbackHits.length, 3)
    assert.equal(loopbackHits[2].query.includes('cwd='), false)

    // The raw text-write route (0.26.0's /sidebar/write): same strip, the
    // text body crossing verbatim (PB-15).
    const write = await server.pluginPost('/sidebar/write', `sessionId=session-a&path=notes.md&cwd=${encodeURIComponent('/leaked')}`, { body: 'the document text' })
    assert.equal(write.status, 200)
    assert.equal(loopbackHits.length, 4)
    assert.equal(loopbackHits[3].query.includes('cwd='), false, 'the write route\u2019s query cwd was stripped')
    assert.ok(loopbackHits[3].query.includes('sessionId=session-a'))
    assert.ok(loopbackHits[3].query.includes('path=notes.md'))
    assert.equal(loopbackHits[3].body, 'the document text', 'the text body arrived verbatim')
  } finally {
    await server.stop()
  }
})

test('0.28.0-alpha.0 / 0.28.0: git.graph is a session-scoped read; changes.ops drops `wait` (and cwd) before the loopback', async () => {
  const adapterMod = await importLib('adapters/dsh-better-sidebar/methods.js')
  assert.deepEqual({ ...adapterMod.SIDEBAR_METHODS['git.graph'] }, { kind: 'read', sessionField: 'sessionId' })
  // 0.28.1: git.history rides the same shape (lib/index.js:8986) — paged
  // git-log companion, session-scoped read.
  assert.deepEqual({ ...adapterMod.SIDEBAR_METHODS['git.history'] }, { kind: 'read', sessionField: 'sessionId' })
  const loopbackHits = []
  const server = await startServerSide({ loopbackHits })
  try {
    // A primed changes.ops long-poll: the backend would park it 25 s, past
    // the relay's 15 s header wait — the server hook strips `wait`.
    const ops = await server.pluginPost('/sidebar/api/changes.ops', '', {
      body: JSON.stringify({ sessionId: 'session-a', afterSeq: 7, wait: true }),
    })
    assert.equal(ops.status, 200)
    const opsBody = JSON.parse(loopbackHits[0].body)
    assert.equal(opsBody.wait, undefined, 'wait was stripped')
    assert.equal(opsBody.afterSeq, 7, 'the cursor survives')
    assert.equal(opsBody.sessionId, 'session-a')
    // `wait` on any OTHER method is not ours to touch.
    const graph = await server.pluginPost('/sidebar/api/git.graph', '', {
      body: JSON.stringify({ sessionId: 'session-a', branch: 'main', wait: true, cwd: '/leaked' }),
    })
    assert.equal(graph.status, 200)
    const graphBody = JSON.parse(loopbackHits[1].body)
    assert.equal(graphBody.wait, true, 'only changes.ops loses wait')
    assert.equal(graphBody.cwd, undefined, 'cwd still stripped')
    assert.equal(graphBody.branch, 'main')
  } finally {
    await server.stop()
  }
})

test('PB-12: the upload route rides the shared relay budget; the api route keeps the plugin\u2019s own 1 MiB', async () => {
  // The upload cap no longer hand-copies the relay budget — the adapter
  // imports MAX_UPLOAD_BYTES from lib/upload-limits.js like everyone else,
  // so a "the two numbers move together" pair-pin would be a tautology and
  // is gone with the copy. What stays worth pinning: the route really
  // declares that constant, and the api route's cap is better-sidebar's own
  // 1 MiB (lib/index.js:863), not the relay's.
  const { MAX_UPLOAD_BYTES } = await importLib('upload-limits.js')
  const { adapter } = await loadAdapter()
  const upload = adapter.routes.find((route) => route.path === '/sidebar/upload')
  assert.equal(upload.maxBody, MAX_UPLOAD_BYTES)
  const api = adapter.routes.find((route) => route.path === '/sidebar/api')
  assert.equal(api.maxBody, 1024 * 1024, 'the api body cap is the plugin\u2019s own 1 MiB')
})

// ---- PB-13: the two WebSockets and the sidechat loop ---------------------------

test('PB-13: both WS routes are in the declaration table as upgrades; the tunnel opens through the adapter registration', async () => {
  const { adapter } = await loadAdapter()
  for (const path of ['/sidebar/ws/agent-opens', '/sidebar/ws/fs-watch']) {
    const route = adapter.routes.find((entry) => entry.path === path)
    assert.ok(route !== undefined, `${path} is declared`)
    assert.equal(route.upgrade, true, `${path} is an upgrade route`)
    assert.equal(route.match, 'exact')
    assert.deepEqual(route.methods, ['GET'])
    assert.equal(route.locator.in, 'query')
    assert.equal(route.locator.name, 'sessionId')
    // The registry entry carries it too — that is what the tunnel's
    // validation chain (and the handshake table) reads.
    const declared = adapter.declaration.routes.find((entry) => entry.path === path)
    assert.ok(declared !== undefined, `${path} reached the registry`)
    assert.equal(declared.upgrade, true)
  }
})

test('PB-13 sidechat loop: start forwards and virtualizes the childId; prompt takes the virtual id back to the REAL one; the server admits it through the ancestor chain', async () => {
  // ---- the CLIENT half: start's answer childId comes back VIRTUAL, and a
  // prompt carrying that virtual id forwards as the REAL child id.
  const host = await startFakeHost()
  const relay = fakeRelayClient()
  const { adapter } = await loadAdapter()
  const handle = await installedIntercept(host, relay, adapter)
  // The REAL wire shape: writeOk wraps every /sidebar/api success in
  // {ok:true, value} — the 2026-10-13 regression this test pins.
  relay.answer('/sidebar/api/sidechat.start', {
    status: 200, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, value: { childId: 'session-child-1' } }),
  })
  try {
    const start = await host.get('/sidebar/api/sidechat.start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual('session-a'), question: 'what changed?' }),
    })
    assert.deepEqual(await start.json(), { ok: true, value: { childId: virtual('session-child-1') } }, 'the REAL child id came back VIRTUAL inside the envelope')

    await host.get('/sidebar/api/sidechat.prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ childId: virtual('session-child-1'), text: 'the diff please' }),
    })
    assert.equal(relay.forwarded.length, 2)
    assert.equal(JSON.parse(relay.forwarded[1].body).childId, 'session-child-1', 'the prompt forwarded with the REAL child id')
  } finally {
    handle.uninstall()
    await host.stop()
  }

  // ---- the SERVER half: the SAME virtual-id-shaped flow arrives with the
  // real child id, and the ancestor chain admits it (session-child-1's
  // parent is the shared session-a). An unshared orphan refuses.
  const loopbackHits = []
  const server = await startServerSide({
    loopbackHits,
    parentOf: (sessionId) => (sessionId === 'session-child-1' ? 'session-a' : undefined),
  })
  try {
    const prompt = await server.pluginPost('/sidebar/api/sidechat.prompt', '', {
      body: JSON.stringify({ childId: 'session-child-1', text: 'the diff please' }),
    })
    assert.equal(prompt.status, 200, 'the inherited child is admitted')
    assert.equal(loopbackHits.length, 1)
    assert.equal(JSON.parse(loopbackHits[0].body).childId, 'session-child-1')

    const stranger = await server.pluginPost('/sidebar/api/sidechat.prompt', '', {
      body: JSON.stringify({ childId: 'session-stranger', text: 'hello?' }),
    })
    assert.equal(stranger.status, 403)
    assert.equal((await stranger.json()).error.code, 'not-shared')
    assert.equal(loopbackHits.length, 1, 'the stranger never reached the loopback')
  } finally {
    await server.stop()
  }
})
