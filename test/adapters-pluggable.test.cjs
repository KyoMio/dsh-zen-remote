/* dsh-zen-remote · the adapters' PLUGGABILITY contract (PB-11)
 *
 * 用户硬要求：适配器整块移除后不影响其他功能。三项检查钉住它：
 *  ① 以空适配器数组跑一遍插件桥协作全链路——核心转发一个字节都不差；
 *  ② 静态扫描 src 下的全部 ts：`src/adapters/` 之外只有接线文件（src/index.ts）
 *     import `./adapters/index`，且没有任何文件 import 适配器子目录——
 *     删目录的爆炸半径被钉在接线的一行 import 上；
 *  ③ ADAPTERS 里每个适配器形状合法（versions 非空、路由可规范化）。
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const http = require('node:http')

const SRC = path.join(__dirname, '..', 'src')

const importLib = async (name) => import(pathToFileURL(path.join(__dirname, '..', 'lib', name)).href)

/** ② The static import scan. */
function scanAdapterImports() {
  const entries = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (entry.name.endsWith('.ts')) entries.push(path.relative(SRC, full).split(path.sep).join('/'))
    }
  }
  walk(SRC)
  const indexImporters = []
  const subdirImporters = []
  for (const file of entries) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8')
    // Both import shapes: the static `from '...'` and the dynamic
    // `import('...')` — an adapter pulled in dynamically would dodge the
    // delete-the-directory guarantee just as surely.
    const specs = [
      ...[...text.matchAll(/from\s+['"]([^'"]*adapters\/[^'"]*)['"]/g)].map((match) => match[1]),
      ...[...text.matchAll(/import\(\s*['"]([^'"]*adapters\/[^'"]*)['"]\s*\)/g)].map((match) => match[1]),
    ]
    for (const spec of specs) {
      if (/adapters\/index/.test(spec)) indexImporters.push(file)
      else if (/adapters\/types/.test(spec)) {
        // The author-face types module — adapter code and types.ts itself
        // only; a framework file importing it would drag the directory into
        // the delete blast radius. types.ts importing the CORE is fine (the
        // dependency arrow points the right way), and so is anything INSIDE
        // adapters/.
        if (file.startsWith('adapters/')) continue
        subdirImporters.push(`${file} -> ${spec} (types must only be imported from inside adapters/)`)
      } else subdirImporters.push(`${file} -> ${spec} (adapter subdirectories are importable from nowhere)`)
    }
  }
  return { indexImporters, subdirImporters }
}

test('PB-11 pluggable: the import scan — only the wiring sees the adapters directory', () => {
  const { indexImporters, subdirImporters } = scanAdapterImports()
  assert.deepEqual(
    indexImporters.filter((file) => file !== 'index.ts'),
    [],
    `only src/index.ts may import ./adapters/index — found: ${indexImporters.join(', ')}`,
  )
  assert.ok(indexImporters.includes('index.ts'), 'the wiring import exists (the array is actually consumed)')
  assert.deepEqual(subdirImporters, [], `no file may import an adapter subdirectory or the types outside adapters/ — found: ${subdirImporters.join(', ')}`)
})

test('PB-11 pluggable: every registered adapter is well-formed', async () => {
  const adaptersMod = await importLib('adapters/index.js')
  const core = await importLib('plugin-adapter-core.js')
  assert.ok(Array.isArray(adaptersMod.ADAPTERS), 'ADAPTERS is an array')
  for (const adapter of adaptersMod.ADAPTERS) {
    assert.ok(typeof adapter.plugin === 'string' && adapter.plugin !== '', 'plugin named')
    assert.ok(Array.isArray(adapter.versions) && adapter.versions.length > 0, `${adapter.plugin}: versions non-empty`)
    // Normalizing against the FIRST listed version must succeed — the route
    // table (paths, locators, methods) is legal.
    const normalized = core.normalizeAdapter(adapter, adapter.versions[0])
    assert.ok(normalized.routes.length > 0)
    assert.ok(/^[0-9a-f]{16}$/u.test(normalized.digest), `${adapter.plugin}: the digest is the 16-hex form`)
  }
})

test('PB-11 pluggable: the cooperative bridge runs COMPLETELY with an empty adapter array', async () => {
  // The minimal cooperative round trip: a declared route, a virtual id, the
  // match wrap with adapters ABSENT (the default), a fake relay — the
  // forward crosses and the answer comes back, with every adapter counter
  // at zero and the local plugin untouched.
  const interceptMod = await importLib('plugin-route-intercept.js')
  const bridgeMod = await importLib('plugin-bridge.js')

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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  raw = {
    exact: new Map(), prefixes: new Map(), upgrades: new Map(),
    match(pathname) { return this.exact.get(pathname) },
    register(route) { this.exact.set(route.path, route); return () => undefined },
  }
  raw.register({
    path: '/coop/data',
    handler: async (req, res) => {
      hits.local += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ local: true }))
    },
  })

  // The fake relay: answers every v1/plugin with the canned remote body.
  const relayServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ remote: true, sessionId: 'session-a' }))
  })
  await new Promise((resolve) => relayServer.listen(0, '127.0.0.1', resolve))
  const relayPort = relayServer.address().port

  const DECLARED = { plugin: 'coop-plugin', version: '9.9.9', routes: [{ path: '/coop/data', scope: 'session' }] }
  const declared = bridgeMod.normalizeDeclaration(DECLARED)
  const registry = bridgeMod.createBridgeRegistry()
  registry.register(DECLARED)
  const relay = {
    pluginRequest: async (request) => {
      assert.equal(request.plugin, 'coop-plugin')
      assert.equal(request.path, '/coop/data')
      assert.equal(request.query, 'sessionId=session-a', 'the virtual id arrived as its REAL half')
      return new Response(JSON.stringify({ remote: true, sessionId: 'session-a' }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
  const handle = interceptMod.installPluginRouteIntercept({
    webServer: raw,
    registry,
    relay,
    getServerId: () => 'abcd1234',
    getStatus: () => bridgeMod.compareBridges(registry.list(), { 'coop-plugin': { version: '9.9.9', digest: declared.digest, serverScopeConsent: true } }, true),
    // adapters deliberately ABSENT — the pluggable default.
  })
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/coop/data?sessionId=${encodeURIComponent('zr~abcd1234~session-a')}`)
    assert.equal(answer.status, 200)
    assert.deepEqual(await answer.json(), { remote: true, sessionId: 'session-a' })
    assert.equal(hits.local, 0, 'the local plugin never ran')
    const diagnostics = handle.diagnostics()
    assert.equal(diagnostics.forwarded, 1, 'the cooperative forward happened exactly as before')
    assert.equal(diagnostics.adapterForwarded, 0, 'no adapter was involved')
  } finally {
    handle.uninstall()
    await new Promise((done) => { server.closeAllConnections(); server.close(done) })
    await new Promise((done) => { relayServer.closeAllConnections(); relayServer.close(done) })
  }
})
