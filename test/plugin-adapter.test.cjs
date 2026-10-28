/* dsh-zen-remote · the plugin bridge's adapter framework (PB-11)
 *
 * Three layers, one file:
 *  1. the CORE pure logic (lib/plugin-adapter-core.js): route validation,
 *     the three locators' classify verdicts, the two-way rewrites, the
 *     digest, the registry-ownership (yield) check.
 *  2. the CLIENT half (lib/plugin-route-intercept.js over a fake host +
 *     fake relay): remote/local/mixed/no-locator per locator, the rewritten
 *     coordinates as the relay client received them, the client hooks, the
 *     8 MB response cap, local-true prefixes, the yield to a plugin's own
 *     declaration.
 *  3. the SERVER half (lib/relay-server.js's v1/plugin over a bare http
 *     server): the one re-location, EVERY id share-checked, the server
 *     hook's stripped body as the loopback received it, consent, stale
 *     coordinates.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { Readable, Transform } = require('node:stream')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-adapter-'))
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

const importLib = async (name) => import(pathToFileURL(path.join(__dirname, '..', 'lib', name)).href)

const SERVER_ID = 'abcd1234'
const virtual = (id) => `zr~${SERVER_ID}~${id}`

// ---- 1. the core pure logic ---------------------------------------------------

test('PB-11 core: the locator verdicts — remote, local, mixed, none', async () => {
  const core = await importLib('plugin-adapter-core.js')
  const queryRoute = core.normalizeAdapter(
    { plugin: 'some-panel', versions: ['1.2.3'], routes: [{ path: '/some-panel/data', match: 'exact', locator: { in: 'query', name: 'sid' } }] },
    '1.2.3',
  )
  const route = queryRoute.routes[0]
  const q = (s) => new URLSearchParams(s)

  // every id virtual → remote
  assert.equal(core.classifyAdapterRequest(route, '/some-panel/data', q('sid=' + encodeURIComponent(virtual('a'))), undefined).kind, 'remote')
  // none located (missing parameter) → local
  assert.equal(core.classifyAdapterRequest(route, '/some-panel/data', q('other=1'), undefined).kind, 'local')
  // located but plain → local
  assert.equal(core.classifyAdapterRequest(route, '/some-panel/data', q('sid=session-local'), undefined).kind, 'local')
  // a DUPLICATED parameter refuses outright (PB-12 review: never collapse)
  assert.throws(() => core.classifyAdapterRequest(route, '/some-panel/data', q(`sid=${virtual('a')}&sid=${virtual('b')}`), undefined), core.AdapterMultiValueQueryError)
  assert.throws(() => core.classifyAdapterRequest(route, '/some-panel/data', q('sid=a&sid=b'), undefined), core.AdapterMultiValueQueryError)
  // a MIX across distinct fields (json-body) → malformed for the bridge
  const mixedBodyRoute = core.normalizeAdapter(
    { plugin: 'some-panel', versions: ['1.2.3'], routes: [{ path: '/some-panel/mix', match: 'exact', locator: { in: 'json-body', fields: ['sessionId', 'sourceId'] } }] },
    '1.2.3',
  ).routes[0]
  assert.equal(core.classifyAdapterRequest(mixedBodyRoute, '/some-panel/mix', new URLSearchParams(), { sessionId: virtual('a'), sourceId: 'plain' }).kind, 'mixed')

  const prefixRoute = core.normalizeAdapter(
    { plugin: 'some-panel', versions: ['1.2.3'], routes: [{ path: '/some-panel/api', match: 'prefix', locator: { in: 'path-segment', index: 1 } }] },
    '1.2.3',
  ).routes[0]
  // index 1 = the SECOND segment after the prefix (/some-panel/api/open/X → X)
  assert.equal(core.classifyAdapterRequest(prefixRoute, '/some-panel/api/open/' + virtual('a'), new URLSearchParams(), undefined).kind, 'remote')
  assert.equal(core.classifyAdapterRequest(prefixRoute, '/some-panel/api/open/plain-id', new URLSearchParams(), undefined).kind, 'local')
  // only the SECOND segment locates: a virtual id sitting there with a
  // plain second segment still classifies by what was FOUND
  assert.equal(core.classifyAdapterRequest(prefixRoute, '/some-panel/api/' + virtual('a') + '/plain', new URLSearchParams(), undefined).kind, 'local', 'a virtual id OUTSIDE the located segment is just a path')
  assert.equal(core.classifyAdapterRequest(prefixRoute, '/some-panel/api/open', new URLSearchParams(), undefined).kind, 'local', 'a missing segment locates nothing')

  const bodyRoute = core.normalizeAdapter(
    { plugin: 'some-panel', versions: ['1.2.3'], routes: [{ path: '/some-panel/write', match: 'exact', methods: ['POST'], locator: { in: 'json-body', fields: ['sessionId', 'sourceId'] } }] },
    '1.2.3',
  ).routes[0]
  assert.equal(core.classifyAdapterRequest(bodyRoute, '/some-panel/write', new URLSearchParams(), { sessionId: virtual('a'), sourceId: virtual('b') }).kind, 'remote')
  assert.equal(core.classifyAdapterRequest(bodyRoute, '/some-panel/write', new URLSearchParams(), { other: 1 }).kind, 'local', 'present-but-irrelevant fields locate nothing')
  assert.equal(core.classifyAdapterRequest(bodyRoute, '/some-panel/write', new URLSearchParams(), { sessionId: virtual('a'), sourceId: 'plain' }).kind, 'mixed')
  // a non-string field value is not an id
  assert.equal(core.classifyAdapterRequest(bodyRoute, '/some-panel/write', new URLSearchParams(), { sessionId: 42 }).kind, 'local')
})

test('PB-11 core: the rewrite — query re-serialized, path segment re-encoded, JSON body re-serialized', async () => {
  const core = await importLib('plugin-adapter-core.js')
  const realIdOf = (v) => core.fromVirtual(v).id
  const fromVirtual = core.fromVirtual

  const queryRoute = core.normalizeAdapter(
    { plugin: 'p', versions: ['1'], routes: [{ path: '/p/d', match: 'exact', locator: { in: 'query', name: 'sid' } }] }, '1',
  ).routes[0]
  const search = new URLSearchParams(`sid=${encodeURIComponent(virtual('session-a'))}&keep=1`)
  const verdict = core.classifyAdapterRequest(queryRoute, '/p/d', search, undefined)
  const rewrite = core.rewriteAdapterRequest(queryRoute, '/p/d', search, undefined, verdict.hits, realIdOf)
  assert.equal(rewrite.query.get('sid'), 'session-a', 'the query carries the REAL id')
  assert.equal(rewrite.query.get('keep'), '1')
  assert.equal(rewrite.bodyText, undefined)

  const prefixRoute = core.normalizeAdapter(
    { plugin: 'p', versions: ['1'], routes: [{ path: '/p/api', match: 'prefix', locator: { in: 'path-segment', index: 1 } }] }, '1',
  ).routes[0]
  const pathname = `/p/api/open/${encodeURIComponent(virtual('sess/x'))}`
  const pVerdict = core.classifyAdapterRequest(prefixRoute, pathname, new URLSearchParams(), undefined)
  const pRewrite = core.rewriteAdapterRequest(prefixRoute, pathname, new URLSearchParams(), undefined, pVerdict.hits, realIdOf)
  assert.equal(pRewrite.pathname, '/p/api/open/sess%2Fx', 'the segment is re-encoded once')
  assert.equal(pRewrite.pathname.split('/')[4], 'sess%2Fx', 'and decodes back to the real id')

  const bodyRoute = core.normalizeAdapter(
    { plugin: 'p', versions: ['1'], routes: [{ path: '/p/w', match: 'exact', methods: ['POST'], locator: { in: 'json-body', fields: ['sessionId', 'sourceId'] } }] }, '1',
  ).routes[0]
  const body = { sessionId: virtual('session-a'), sourceId: virtual('session-b'), keep: { x: 1 } }
  const bVerdict = core.classifyAdapterRequest(bodyRoute, '/p/w', new URLSearchParams(), body)
  const bRewrite = core.rewriteAdapterRequest(bodyRoute, '/p/w', new URLSearchParams(), body, bVerdict.hits, realIdOf)
  const rewritten = JSON.parse(bRewrite.bodyText)
  assert.equal(rewritten.sessionId, 'session-a')
  assert.equal(rewritten.sourceId, 'session-b', 'BOTH body fields rewritten (one copy, no lost field)')
  assert.deepEqual(rewritten.keep, { x: 1 }, 'untouched fields ride along')

  // digest stability: same table → same digest; any locator change → new digest
  const coreMod = core
  const one = coreMod.normalizeAdapter({ plugin: 'p', versions: ['1'], routes: [{ path: '/p/d', match: 'exact', locator: { in: 'query', name: 'sid' } }] }, '1')
  const two = coreMod.normalizeAdapter({ plugin: 'p', versions: ['1'], routes: [{ path: '/p/d', match: 'exact', locator: { in: 'query', name: 'sid' } }] }, '1')
  const three = coreMod.normalizeAdapter({ plugin: 'p', versions: ['1'], routes: [{ path: '/p/d', match: 'exact', locator: { in: 'query', name: 'other' } }] }, '1')
  assert.equal(one.digest, two.digest)
  assert.notEqual(one.digest, three.digest)
  assert.equal(one.declaration.digest, one.digest)
  assert.equal(one.declaration.routes[0].scope, 'server', 'an adapter is whole-machine data by definition')

  void fromVirtual
})

test('PB-11 core: validation — versions gate, typo guard, local routes stay out of the declaration', async () => {
  const core = await importLib('plugin-adapter-core.js')
  // the installed version must be listed EXACTLY
  assert.throws(() => core.normalizeAdapter({ plugin: 'p', versions: ['2.0.0'], routes: [{ path: '/p/d', match: 'exact', locator: { in: 'query', name: 'sid' } }] }, '1.0.0'), /versions/)
  // host-owned prefixes refused
  assert.throws(() => core.normalizeAdapter({ plugin: 'p', versions: ['1'], routes: [{ path: '/api/x', match: 'exact', locator: { in: 'query', name: 'sid' } }] }, '1'), /host-owned/)
  // unknown field refused
  assert.throws(() => core.normalizeAdapter({ plugin: 'p', versions: ['1'], locater: {}, routes: [{ path: '/p/d', match: 'exact', locator: { in: 'query', name: 'sid' } }] }, '1'), /unknown field/)
  // path-segment needs a prefix route
  assert.throws(() => core.normalizeAdapter({ plugin: 'p', versions: ['1'], routes: [{ path: '/p/d', match: 'exact', locator: { in: 'path-segment', index: 0 } }] }, '1'), /prefix/)

  const mixed = core.normalizeAdapter(
    {
      plugin: 'p', versions: ['1'],
      routes: [
        { path: '/p/assets', match: 'prefix', locator: { in: 'query', name: 'sid' }, local: true },
        { path: '/p/data', match: 'exact', methods: ['POST'], locator: { in: 'json-body', fields: ['sessionId'] } },
      ],
    }, '1',
  )
  assert.equal(mixed.routes.length, 2, 'both routes live on the adapter')
  assert.equal(mixed.declaration.routes.length, 1, 'the local route never reaches the registry')
  assert.equal(mixed.declaration.routes[0].path, '/p/data')
})

test('PB-23b core: the prefix tail red line — the four illegal shapes refuse on the RAW tail, equality and non-matches stay false', async () => {
  const core = await importLib('plugin-adapter-core.js')
  const prefix = core.normalizeAdapter(
    { plugin: 'p', versions: ['1'], routes: [{ path: '/p/api', match: 'prefix', locator: { in: 'path-segment', index: 0 } }] }, '1',
  ).routes[0]
  const exact = core.normalizeAdapter(
    { plugin: 'p', versions: ['1'], routes: [{ path: '/p/e', match: 'exact', locator: { in: 'query', name: 'sid' } }] }, '1',
  ).routes[0]

  // The four shapes the declaration red line carries, judged on the tail
  // the prefix match admits: `?`, `#`, `..` (raw and EVERY `%2e`/`%2E`
  // encoding — the mixed `.%2e.` decodes to dot-dot, so any encoded dot
  // refuses), whitespace.
  const violations = ['/p/api/a?x=1', '/p/api/a#f', '/p/api/../s', '/p/api/%2e%2e/s', '/p/api/%2E%2E/s', '/p/api/.%2e.', '/p/api/a b', '/p/api/a\tb']
  for (const pathname of violations) assert.equal(core.adapterTailShapeViolation(prefix, pathname), true, pathname)

  // The false-kill surface is INTENTIONAL (PB-23b review nit-2), pinned here
  // as a test fact: `config%2ejson` decodes to the harmless `config.json`
  // and `a..b` is a harmless file name — both refuse anyway, because the
  // byte-law rule cannot see decoded intent and stays strict on purpose.
  assert.equal(core.adapterTailShapeViolation(prefix, '/p/api/config%2ejson'), true, 'config%2ejson refuses by design')
  assert.equal(core.adapterTailShapeViolation(prefix, '/p/api/a..b'), true, 'a..b refuses by design')

  // Legal tails: plain segments, dots inside a name (only the `..` pair is
  // the red line), an encoded space — and the honest boundary of the raw
  // rule: `%252e%252e` (double-encoded) carries no raw `%2e`, so it passes;
  // it only becomes dot-dot past a SECOND decode, a host behavior this rule
  // deliberately does not speculate about (the verdict is byte-law, not
  // decoder-law).
  const legal = ['/p/api/open', '/p/api/readme.txt', '/p/api/a%20b', '/p/api/x%252ey', '/p/api', '/p/api/%252e%252e']
  for (const pathname of legal) assert.equal(core.adapterTailShapeViolation(prefix, pathname), false, pathname)

  // Equality hits and non-matches are not this function's verdict: no tail,
  // or the caller's routing refusal answers first.
  assert.equal(core.adapterTailShapeViolation(exact, '/p/e'), false)
  assert.equal(core.adapterTailShapeViolation(exact, '/p/e/..'), false, 'a non-matching pathname reads no violation')
  assert.equal(core.adapterTailShapeViolation(prefix, '/p/apix'), false, 'a near-miss reads no violation')
})

// ---- 2. the client half -------------------------------------------------------

/** The fake host (PB-4's shape): a real http server dispatching through the
 * raw webServer's match. The local plugin's handlers COUNT their hits — the
 * security observable. */
function startFakeHost() {
  const hits = { local: 0, lastBody: '' }
  let raw
  const server = http.createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    Promise.resolve(raw.match(rawPath)).then(async (route) => {
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
        exact: new Map(),
        prefixes: new Map(),
        upgrades: new Map(),
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
        kind: 'exact', path: '/some-panel/data',
        handler: async (req, res) => {
          hits.local += 1
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ local: true, query: new URL(req.url ?? '/', 'http://x').search }))
        },
      })
      raw.register({
        kind: 'prefix', path: '/some-panel/api',
        handler: async (req, res) => {
          hits.local += 1
          const chunks = []
          req.on('data', (c) => chunks.push(c))
          req.on('end', () => {
            hits.lastBody = Buffer.concat(chunks).toString('utf8')
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ local: true, path: new URL(req.url ?? '/', 'http://x').pathname, body: hits.lastBody }))
          })
        },
      })
      raw.register({
        kind: 'prefix', path: '/some-panel/assets',
        handler: async (req, res) => {
          hits.local += 1
          res.writeHead(200, { 'content-type': 'image/svg+xml' })
          res.end('<svg/>')
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

/** The fake relay client: records what the wrap handed over and answers
 * from a canned table (status, headers, body). */
function fakeRelayClient() {
  const forwarded = []
  const answers = new Map()
  const client = {
    forwarded,
    answer(path, answer) { answers.set(path, answer) },
    pluginRequest: async (request) => {
      const bodyChunks = []
      if (request.body !== undefined && request.body !== null) {
        for await (const chunk of request.body) bodyChunks.push(Buffer.from(chunk))
      }
      const record = {
        plugin: request.plugin, version: request.version, digest: request.digest,
        path: request.path, query: request.query, method: request.method,
        body: bodyChunks.length > 0 ? Buffer.concat(bodyChunks).toString('utf8') : undefined,
        contentType: request.contentType, contentLength: request.contentLength,
      }
      forwarded.push(record)
      const answer = answers.get(request.path) ?? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remote: true, sessionId: 'session-a' }) }
      return new Response(answer.body, { status: answer.status, headers: answer.headers })
    },
  }
  return client
}

/** The install with the standard test verdicts (online + bridged). */
async function installedIntercept(host, relay, adapters, registry) {
  const mod = await importLib('plugin-route-intercept.js')
  const bridgeMod = await importLib('plugin-bridge.js')
  return mod.installPluginRouteIntercept({
    webServer: host.raw,
    registry,
    relay,
    getServerId: () => SERVER_ID,
    getStatus: () => bridgeMod.compareBridges(registry.list(), { 'some-panel': { version: '1.2.3', digest: (adapters ?? [])[0]?.digest ?? 'x', serverScopeConsent: true } }, true),
    adapters,
  })
}

const QUERY_ADAPTER = {
  plugin: 'some-panel', versions: ['1.2.3'],
  routes: [{ path: '/some-panel/data', match: 'exact', locator: { in: 'query', name: 'sid' } }],
}

test('PB-11 client: a query-located remote request forwards with the REAL id; local and no-locator fall through', async () => {
  const core = await importLib('plugin-adapter-core.js')
  const bridgeMod = await importLib('plugin-bridge.js')
  const host = await startFakeHost()
  const relay = fakeRelayClient()
  const registry = bridgeMod.createBridgeRegistry()
  const adapter = core.normalizeAdapter(QUERY_ADAPTER, '1.2.3')
  registry.registerNormalized(adapter.declaration)
  const handle = await installedIntercept(host, relay, [adapter], registry)
  try {
    // remote: the virtual id swaps for the real one on the wire
    const remote = await host.get(`/some-panel/data?sid=${encodeURIComponent(virtual('session-a'))}`)
    assert.equal(remote.status, 200)
    assert.deepEqual(await remote.json(), { remote: true, sessionId: 'session-a' }, 'the server answer travelled back')
    assert.equal(relay.forwarded.length, 1)
    assert.equal(relay.forwarded[0].query, 'sid=session-a', 'the REAL id left for the relay')
    assert.equal(relay.forwarded[0].version, '1.2.3', 'the adapter\'s registered coordinates')
    assert.equal(relay.forwarded[0].digest, adapter.digest)
    assert.equal(host.hits.local, 0, 'the local plugin NEVER ran')

    // local: a plain id falls through to the local handler
    const local = await host.get('/some-panel/data?sid=session-local&x=1')
    assert.equal(local.status, 200)
    assert.deepEqual(await local.json(), { local: true, query: '?sid=session-local&x=1' })
    assert.equal(host.hits.local, 1)
    assert.equal(relay.forwarded.length, 1, 'nothing left for the relay')

    // no locator at all → local
    await host.get('/some-panel/data')
    assert.equal(host.hits.local, 2)

    // mixed → 503 bad-query, never the local plugin
    const mixed = await host.get(`/some-panel/data?sid=${encodeURIComponent(virtual('a'))}&sid=plain`)
    assert.equal(mixed.status, 503)
    assert.equal(mixed.headers.get('x-zen-remote'), 'unbridged')
    assert.deepEqual(await mixed.json(), { ok: false, error: { code: 'zr-plugin-unbridged', reason: 'bad-query', plugin: 'some-panel' } })
    assert.equal(host.hits.local, 2, 'the mixed request never reached the local plugin')
  } finally {
    handle.uninstall()
    await host.stop()
  }
})

test('PB-11 client: a path-segment locator rewrites the segment; a local-true prefix never forwards', async () => {
  const core = await importLib('plugin-adapter-core.js')
  const bridgeMod = await importLib('plugin-bridge.js')
  const host = await startFakeHost()
  const relay = fakeRelayClient()
  const registry = bridgeMod.createBridgeRegistry()
  const adapter = core.normalizeAdapter(
    {
      plugin: 'some-panel', versions: ['1.2.3'],
      routes: [
        { path: '/some-panel/api', match: 'prefix', locator: { in: 'path-segment', index: 1 } },
        { path: '/some-panel/assets', match: 'prefix', locator: { in: 'path-segment', index: 0 }, local: true },
      ],
    }, '1.2.3',
  )
  registry.registerNormalized(adapter.declaration)
  const handle = await installedIntercept(host, relay, [adapter], registry)
  try {
    const remote = await host.get(`/some-panel/api/open/${encodeURIComponent(virtual('session-a'))}`)
    assert.equal(remote.status, 200)
    assert.equal(relay.forwarded.length, 1)
    assert.equal(relay.forwarded[0].path, '/some-panel/api/open/session-a', 'the segment carries the REAL id')

    // local segment → the LOCAL prefix handler answers
    const localHit = await host.get('/some-panel/api/open/plain-id')
    assert.equal(localHit.status, 200)
    assert.deepEqual(await localHit.json(), { local: true, path: '/some-panel/api/open/plain-id', body: '' })
    assert.equal(host.hits.local, 1)

    // local-true: even a virtual id NEVER forwards
    const assets = await host.get(`/some-panel/assets/logo.svg?sid=${encodeURIComponent(virtual('session-a'))}`)
    assert.equal(assets.status, 200)
    assert.equal(await assets.text(), '<svg/>')
    assert.equal(host.hits.local, 2, 'the local handler served the local-true route')
    assert.equal(relay.forwarded.length, 1, 'nothing extra left for the relay')
  } finally {
    handle.uninstall()
    await host.stop()
  }
})

test('PB-11 client: the client.request hook refuses (503, the local plugin never runs) and can replace the body', async () => {
  const core = await importLib('plugin-adapter-core.js')
  const bridgeMod = await importLib('plugin-bridge.js')
  const host = await startFakeHost()
  const relay = fakeRelayClient()
  const registry = bridgeMod.createBridgeRegistry()
  const adapter = core.normalizeAdapter(
    {
      plugin: 'some-panel', versions: ['1.2.3'],
      client: {
        request: (ctx) => {
          const body = ctx.body
          if (body !== undefined && body.openExternal === true) return { allow: false, reason: 'open-external-refused' }
          if (body !== undefined && body.inject === true) return { allow: true, body: { ...body, injected: 'by-adapter' } }
          return { allow: true }
        },
      },
      routes: [{ path: '/some-panel/api', match: 'prefix', methods: ['POST'], maxBody: 4096, locator: { in: 'json-body', fields: ['sessionId'] } }],
    }, '1.2.3',
  )
  registry.registerNormalized(adapter.declaration)
  const handle = await installedIntercept(host, relay, [adapter], registry)
  try {
    // refused: 503 with the hook's reason, the local plugin never reached
    const refused = await host.get('/some-panel/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual('session-a'), openExternal: true }),
    })
    assert.equal(refused.status, 503)
    assert.deepEqual(await refused.json(), { ok: false, error: { code: 'zr-plugin-unbridged', reason: 'open-external-refused', plugin: 'some-panel' } })
    assert.equal(host.hits.local, 0)

    // body replacement rides the same verdict
    await host.get('/some-panel/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual('session-a'), inject: true }),
    })
    assert.equal(relay.forwarded.length, 1)
    const sent = JSON.parse(relay.forwarded[0].body)
    assert.equal(sent.sessionId, 'session-a', 'the id was rewritten first')
    assert.equal(sent.injected, 'by-adapter', 'the hook\'s body replacement travelled')

    // over-maxBody body → the cooperative 413, locally, before anything
    const over = await host.get('/some-panel/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: virtual('session-a'), pad: 'x'.repeat(5000) }),
    })
    assert.equal(over.status, 413)
    assert.deepEqual(await over.json(), { ok: false, error: { code: 'zr-plugin-body-too-large' } })
    assert.equal(relay.forwarded.length, 1)
  } finally {
    handle.uninstall()
    await host.stop()
  }
})

test('PB-11 client: the client.response hook rewrites and fixes content-length; an over-8MB answer passes through untouched', async () => {
  const core = await importLib('plugin-adapter-core.js')
  const bridgeMod = await importLib('plugin-bridge.js')
  const host = await startFakeHost()
  const relay = fakeRelayClient()
  const registry = bridgeMod.createBridgeRegistry()
  // The response hook maps the answer's ids back to virtual form.
  const adapter = core.normalizeAdapter(
    {
      plugin: 'some-panel', versions: ['1.2.3'],
      client: {
        response: (ctx) => ({ ...ctx.body, sessionId: ctx.virtualize(ctx.body.sessionId) }),
      },
      routes: [{ path: '/some-panel/data', match: 'exact', locator: { in: 'query', name: 'sid' } }],
    }, '1.2.3',
  )
  registry.registerNormalized(adapter.declaration)
  const handle = await installedIntercept(host, relay, [adapter], registry)
  try {
    relay.answer('/some-panel/data', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '22' }, body: JSON.stringify({ remote: true, sessionId: 'session-a' }) })
    const answer = await host.get(`/some-panel/data?sid=${encodeURIComponent(virtual('session-a'))}`)
    assert.equal(answer.status, 200)
    const text = await answer.text()
    assert.deepEqual(JSON.parse(text), { remote: true, sessionId: virtual('session-a') }, 'the real id came back VIRTUAL')
    const length = Number(answer.headers.get('content-length'))
    assert.equal(length, Buffer.byteLength(text), 'the content-length matches the REWRITTEN body')
    assert.equal(relay.forwarded.length, 1)
    const diagnostics = handle.diagnostics()
    assert.equal(diagnostics.adapterResponseRewrites, 1)

    // Over the 8 MB cap: a huge JSON answer passes through untouched (the
    // hook does not run), byte for byte.
    const huge = JSON.stringify({ sessionId: 'session-a', pad: 'x'.repeat(8 * 1024 * 1024) })
    relay.answer('/some-panel/data', { status: 200, headers: { 'content-type': 'application/json' }, body: huge })
    const big = await host.get(`/some-panel/data?sid=${encodeURIComponent(virtual('session-a'))}`)
    assert.equal(await big.text(), huge, 'the over-cap answer passed through byte for byte')
  } finally {
    handle.uninstall()
    await host.stop()
  }
})

test('PB-11 client: a plugin that registers its OWN declaration silences the adapter (yield)', async () => {
  const core = await importLib('plugin-adapter-core.js')
  const bridgeMod = await importLib('plugin-bridge.js')
  const host = await startFakeHost()
  const relay = fakeRelayClient()
  const registry = bridgeMod.createBridgeRegistry()
  const adapter = core.normalizeAdapter(QUERY_ADAPTER, '1.2.3')
  registry.registerNormalized(adapter.declaration)
  // The plugin registers its OWN declaration — the registry entry is no
  // longer the adapter's, and every adapter route goes inert.
  registry.register({ plugin: 'some-panel', version: '1.2.3', routes: [{ path: '/some-panel/data', scope: 'session' }] })
  const handle = await installedIntercept(host, relay, [adapter], registry)
  try {
    const response = await host.get(`/some-panel/data?sid=${encodeURIComponent(virtual('session-a'))}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { local: true, query: `?sid=${encodeURIComponent(virtual('session-a'))}` }, 'the request stayed LOCAL')
    assert.equal(host.hits.local, 1)
    assert.equal(relay.forwarded.length, 0, 'the adapter forwarded nothing')
    assert.equal(core.adapterOwnsRegistryEntry(adapter, registry.get('some-panel')), false, 'the ownership check says yielded')
  } finally {
    handle.uninstall()
    await host.stop()
  }
})

// ---- 3. the server half -------------------------------------------------------

/** The bare relay: lib/relay-server.js's handler over a plain http server,
 * with the adapter wired in and the loopback pointed at a recording fake. */
async function startServerSide({ adapter, consent = true, shared = ['session-a'], loopbackHits }) {
  const relayServerMod = await importLib('relay-server.js')
  const shareStoreMod = await importLib('share-store.js')
  const store = shareStoreMod.createShareStore({ file: path.join(ROOT, `srv-${Math.random().toString(36).slice(2)}.json`), idleHours: 48 })
  for (const id of shared) store.share(id)
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
      loopbackHits.push({ method, path, query, headers, body: Buffer.concat(chunks).toString('utf8') })
      return { status: 200, contentType: 'application/json', contentLength: undefined, cacheControl: undefined, stream: Readable.from([JSON.stringify({ served: true })]) }
    },
  }
  const registryMod = await importLib('plugin-bridge.js')
  const registry = registryMod.createBridgeRegistry()
  if (adapter !== undefined) registry.registerNormalized(adapter.declaration)
  const handler = relayServerMod.createRelayHandler({
    secret: 's'.repeat(64),
    store,
    gateway: { invoke: async () => { throw Object.assign(new Error('no'), { code: 'test' }) }, stream: async () => { throw Object.assign(new Error('no'), { code: 'test' }) } },
    pluginBridge: {
      registry,
      getConsent: () => (consent ? { 'some-panel': true } : {}),
      loopback,
      adapters: adapter !== undefined ? [adapter] : [],
    },
  })
  const server = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.destroy() } catch { /* gone */ } }) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    loopbackHits,
    pluginPost: (path, query, { method = 'POST', body, digest, version = '1.2.3' } = {}) =>
      // v1/plugin is a POST route; the PLUGIN method rides x-zr-method.
      fetch(`http://127.0.0.1:${port}/_dsh/zen-remote/relay/v1/plugin`, {
        method: 'POST',
        headers: {
          'x-zen-remote-secret': 's'.repeat(64),
          'x-zen-remote-via': 'gateway',
          'x-zen-remote-role': 'desktop-client',
          'x-zen-remote-device': 'dev-1',
          'x-zr-plugin': 'some-panel',
          'x-zr-plugin-version': version,
          'x-zr-plugin-digest': digest ?? adapter.digest,
          'x-zr-path': path,
          'x-zr-query': query ?? '',
          'x-zr-method': method,
          ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      }),
    stop: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }),
  }
}

test('PB-11 server: the relocated ids are ALL share-checked; the server hook strips before the loopback', async () => {
  const core = await importLib('plugin-adapter-core.js')
  const loopbackHits = []
  const adapter = core.normalizeAdapter(
    {
      plugin: 'some-panel', versions: ['1.2.3'],
      server: {
        request: (ctx) => {
          if (ctx.body === undefined) return { allow: true }
          const copy = { ...ctx.body }
          delete copy.cwd
          return { allow: true, body: copy }
        },
      },
      routes: [{ path: '/some-panel/api', match: 'prefix', methods: ['POST'], locator: { in: 'json-body', fields: ['sessionId', 'sourceId'] } }],
    }, '1.2.3',
  )
  const server = await startServerSide({ adapter, loopbackHits })
  try {
    // BOTH ids shared: the loopback receives the STRIPPED body.
    const ok = await server.pluginPost('/some-panel/api/open', '', {
      body: JSON.stringify({ sessionId: 'session-a', sourceId: 'session-a', cwd: '/home/me/secret' }),
    })
    assert.equal(ok.status, 200)
    assert.equal(loopbackHits.length, 1)
    const sent = JSON.parse(loopbackHits[0].body)
    assert.equal(sent.sessionId, 'session-a')
    assert.equal(sent.cwd, undefined, 'the server hook stripped the cwd before the loopback')
    assert.equal(sent.sourceId, 'session-a')

    // ONE unshared id among several → 403, the loopback never sees it.
    const unshared = await server.pluginPost('/some-panel/api/open', '', {
      body: JSON.stringify({ sessionId: 'session-a', sourceId: 'session-secret' }),
    })
    assert.equal(unshared.status, 403)
    assert.deepEqual(await unshared.json(), { ok: false, error: { code: 'not-shared' } })
    assert.equal(loopbackHits.length, 1, 'the unshared request never reached the loopback')

    // An undeclared method answers 405 before anything moves.
    const wrongMethod = await server.pluginPost('/some-panel/api/open', '', { method: 'DELETE', body: JSON.stringify({ sessionId: 'session-a' }) })
    assert.equal(wrongMethod.status, 405)
    assert.equal((await wrongMethod.json()).error.code, 'method-undeclared')
    assert.equal(loopbackHits.length, 1, 'the 405 never reached the loopback either')
  } finally {
    await server.stop()
  }
})

test('PB-11 server: consent off refuses 403; stale (yielded) coordinates refuse plugin-mismatch; a wrong method answers 405', async () => {
  const core = await importLib('plugin-adapter-core.js')
  const loopbackHits = []
  const adapter = core.normalizeAdapter(
    {
      plugin: 'some-panel', versions: ['1.2.3'],
      routes: [{ path: '/some-panel/api', match: 'prefix', methods: ['POST'], locator: { in: 'json-body', fields: ['sessionId'] } }],
    }, '1.2.3',
  )
  const server = await startServerSide({ adapter, consent: false, loopbackHits })
  try {
    const off = await server.pluginPost('/some-panel/api/open', '', { body: JSON.stringify({ sessionId: 'session-a' }) })
    assert.equal(off.status, 403)
    assert.equal((await off.json()).error.code, 'consent-off')

    const stale = await server.pluginPost('/some-panel/api/open', '', { body: JSON.stringify({ sessionId: 'session-a' }), digest: 'deadbeefdeadbeef' })
    assert.equal(stale.status, 409)
    assert.equal((await stale.json()).error.code, 'plugin-mismatch')
    assert.equal(loopbackHits.length, 0, 'nothing reached the loopback')
  } finally {
    await server.stop()
  }
})

test('PB-23b server: an illegal prefix tail refuses 400 before the loopback; legal tails (plain, dotted, encoded) still forward verbatim', async () => {
  const core = await importLib('plugin-adapter-core.js')
  const loopbackHits = []
  const adapter = core.normalizeAdapter(
    {
      plugin: 'some-panel', versions: ['1.2.3'],
      routes: [{ path: '/some-panel/api', match: 'prefix', methods: ['GET'], locator: { in: 'path-segment', index: 0 } }],
    }, '1.2.3',
  )
  const server = await startServerSide({ adapter, shared: ['session-a', 'a b', 'readme.txt'], loopbackHits })
  try {
    // The four illegal tail shapes — each answers 400 `bad-request` and the
    // recording loopback stays at zero: the tail never rides into a request
    // line.
    const illegal = [
      '/some-panel/api/session-a?x=1',
      '/some-panel/api/session-a#frag',
      '/some-panel/api/../secret',
      '/some-panel/api/%2e%2e/secret',
      '/some-panel/api/a b',
    ]
    for (const path of illegal) {
      const res = await server.pluginPost(path, '')
      assert.equal(res.status, 400, `${path}: status`)
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'bad-request' } }, `${path}: body`)
      assert.equal(res.headers.get('x-zen-remote-error'), 'bad-request', `${path}: marker header`)
      assert.equal(loopbackHits.length, 0, `${path}: the loopback saw nothing`)
    }

    // The red line sits AFTER the coordinate check: stale coordinates keep
    // their 409 even with an illegal tail.
    const stale = await server.pluginPost('/some-panel/api/..%2fsecret', '', { digest: 'deadbeefdeadbeef' })
    assert.equal(stale.status, 409)
    assert.equal((await stale.json()).error.code, 'plugin-mismatch')

    // Legal tails keep forwarding VERBATIM (the loopback fake records the
    // path it received): a plain segment, dots inside a name, and an encoded
    // space — the encoding the red line does NOT refuse (no `%2e` inside).
    for (const [path, id] of [['/some-panel/api/session-a', 'session-a'], ['/some-panel/api/readme.txt', 'readme.txt'], ['/some-panel/api/a%20b', 'a b']]) {
      const ok = await server.pluginPost(path, '', { method: 'GET' })
      assert.equal(ok.status, 200, `${path}: status`)
      await ok.text()
      assert.equal(loopbackHits.at(-1).path, path, `${path}: the loopback received the tail verbatim`)
    }
    assert.equal(loopbackHits.length, 3, 'exactly the three legal requests moved')
  } finally {
    await server.stop()
  }
})
