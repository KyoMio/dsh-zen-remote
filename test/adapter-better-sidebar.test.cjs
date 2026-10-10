/* dsh-zen-remote · the better-sidebar adapter (PB-12)
 *
 * Drives the BUILT lib/adapters/* + the framework halves over real
 * sockets. Layers:
 *  1. the METHOD TABLE vs the plugin's OWN source: every method name the
 *     0.25.0 build dispatches must appear in the table (skip with a note
 *     when /tmp/bs-versions/0.25.0 is not on this machine);
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
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const PLUGIN_SOURCE = '/tmp/bs-versions/0.25.0/lib/index.js'

const importLib = async (name) => import(pathToFileURL(path.join(__dirname, '..', 'lib', name)).href)

const SERVER_ID = 'abcd1234'
const virtual = (id) => `zr~${SERVER_ID}~${id}`

// ---- 1. the method table vs the plugin's own source ---------------------------

test('PB-12 table: every method the 0.25.0 source dispatches is in the table', async () => {
  const adapterMod = await importLib('adapters/dsh-better-sidebar/methods.js')
  let source
  try {
    source = fs.readFileSync(PLUGIN_SOURCE, 'utf8')
  } catch {
    test.skip(`the plugin source is not on this machine (${PLUGIN_SOURCE}); the table-vs-source comparison is skipped`)
    return
  }
  // The dispatcher's own method names: every `"x.y": async (payload) =>`
  // entry of buildApi's table (lib/index.js:6319-6688), the sidechat
  // builder's keys (lib/index.js:4971-5140), and the spread of
  // buildSidechatApi into the table (lib/index.js:6687).
  const names = new Set()
  for (const match of source.matchAll(/"([a-zA-Z]+\.[a-zA-Z-]+)":\s*(?:async\s*)?\(/g)) {
    names.add(match[1])
  }
  // Restrict to the sidebar namespaces (the same regex catches unrelated
  // object tables elsewhere in the bundle).
  const sidebarNames = [...names].filter((name) => /^(session|fs|git|changes|subagents|workflows|teams|settings|open|archive|sidechat)\./.test(name))
  assert.ok(sidebarNames.length >= 40, `the extraction found the table (${sidebarNames.length} names)`)
  const missing = sidebarNames.filter((name) => adapterMod.SIDEBAR_METHODS[name] === undefined)
  assert.deepEqual(missing, [], `methods the plugin dispatches but the table lacks: ${missing.join(', ')}`)
  // And the reverse direction: a table entry the plugin no longer has is a
  // dead row (harmless but worth noticing).
  const extra = Object.keys(adapterMod.SIDEBAR_METHODS).filter((name) => !names.has(name))
  assert.deepEqual(extra, [], `table entries the 0.25.0 source does not dispatch: ${extra.join(', ')}`)
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
  const hits = { local: 0 }
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
      resolve({
        raw, hits, port,
        get: (pathWithQuery, init = {}) => fetch(`http://127.0.0.1:${port}${pathWithQuery}`, init),
        stop: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }),
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

test('PB-12 client: a read and a write forward with real ids; settings stays local; sidechat and open.external refuse', async () => {
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

    // sidechat refuses (deny hook — wholesale, remote or local).
    const sidechat = await host.get('/sidebar/api/sidechat.start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual('session-a'), question: 'hi' }),
    })
    assert.equal(sidechat.status, 503)
    assert.equal((await sidechat.json()).error.reason, 'adapter-sidechat-pending')
    assert.equal(host.hits.local, 1)

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
    relay.answer('/sidebar/api/session.cwd', {
      status: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', cwd: '/srv/proj', root: 'proj', parent: null }),
    })
    const cwd = await host.get('/sidebar/api/session.cwd', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual('session-a') }),
    })
    assert.deepEqual(await cwd.json(), { sessionId: virtual('session-a'), cwd: '/srv/proj', root: 'proj', parent: null })

    // subagents.live keys the map BY session id (lib/index.js:4513).
    relay.answer('/sidebar/api/subagents.live', {
      status: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ live: { 'session-a': { running: true }, 'session-child': { text: 'hi' } } }),
    })
    const live = await host.get('/sidebar/api/subagents.live', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootSessionId: virtual('session-a') }),
    })
    const liveBody = await live.json()
    assert.deepEqual(Object.keys(liveBody.live).sort(), [virtual('session-child'), virtual('session-a')].sort(), 'every key came back VIRTUAL')

    // workflows.list rows carry originSessionId + members[].childId
    // (lib/index.js:4666, 4686).
    relay.answer('/sidebar/api/workflows.list', {
      status: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runs: [{
          runId: 'r1', originSessionId: 'session-child', status: 'running',
          phases: [{ title: 'p', members: [{ seq: 1, label: '#1', childId: 'session-grandchild' }] }],
        }],
      }),
    })
    const workflows = await host.get('/sidebar/api/workflows.list', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootSessionId: virtual('session-a') }),
    })
    const workflowsBody = await workflows.json()
    assert.equal(workflowsBody.runs[0].originSessionId, virtual('session-child'))
    assert.equal(workflowsBody.runs[0].phases[0].members[0].childId, virtual('session-grandchild'))

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

async function startServerSide({ consent = true, loopbackHits, loopbackHeaders }) {
  const relayServerMod = await importLib('relay-server.js')
  const shareStoreMod = await importLib('share-store.js')
  const store = shareStoreMod.createShareStore({ file: path.join(__dirname, '..', '.tmp-bs-server.json'), idleHours: 48 })
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
  } finally {
    await server.stop()
    try { fs.unlinkSync(path.join(__dirname, '..', '.tmp-bs-server.json')) } catch { /* gone */ }
  }
})

test('PB-12: the adapter upload cap equals the relay upload budget', async () => {
  const relayServerMod = await importLib('relay-server.js')
  const { adapter } = await loadAdapter()
  const upload = adapter.routes.find((route) => route.path === '/sidebar/upload')
  assert.equal(upload.maxBody, relayServerMod.MAX_UPLOAD_BYTES, 'the two numbers move together')
  const api = adapter.routes.find((route) => route.path === '/sidebar/api')
  assert.equal(api.maxBody, 1024 * 1024, 'the api body cap is the plugin\u2019s own 1 MiB')
})
