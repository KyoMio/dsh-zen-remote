'use strict'
// architecture-guardrails.test.cjs — ZR-3 static & behavioral guardrails.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const ts = require('typescript')
const { request } = require('./util.cjs')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

function walk(dir, rel = '') {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(abs, relPath))
    else if (entry.isFile()) out.push(relPath)
  }
  return out
}

const srcFiles = walk(path.join(root, 'src'))
  .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !/\.test\.tsx?$/.test(f))
  .map((f) => `src/${f}`)

function scriptKindFor(filePath) {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (filePath.endsWith('.ts') || filePath.endsWith('.mts') || filePath.endsWith('.cts')) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

// ---------------------------------------------------------------------------
// ① tsconfig include 漏网：new src non-test files must be inside one of the
// two programs' input closures (include + transitive imports), and any
// src/client-data/*.ts imported by host files must be covered by tsconfig.json
// so tsc emits lib/client-data/*.js instead of only .client-build/.
// ---------------------------------------------------------------------------
function programClosure(configPath) {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.ok(!configFile.error, `无法读取 ${configPath}`)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath))
  const prog = ts.createProgram(parsed.fileNames, parsed.options)
  const out = new Set()
  for (const sf of prog.getSourceFiles()) {
    if (prog.isSourceFileFromExternalLibrary(sf) || prog.isSourceFileDefaultLibrary(sf)) continue
    const rel = path.relative(root, sf.fileName).split('\\').join('/')
    if (rel.startsWith('..') || rel.startsWith('node_modules/')) continue
    out.add(rel)
  }
  return out
}

function collectModuleSpecifiers(filePath) {
  const text = read(filePath)
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  const specifiers = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        specifiers.push(node.arguments[0].text)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return specifiers
}

test('① every non-test src file is inside a tsconfig program closure', () => {
  const hostClosure = programClosure(path.join(root, 'tsconfig.json'))
  const clientClosure = programClosure(path.join(root, 'tsconfig.client.json'))
  const closure = new Set([...hostClosure, ...clientClosure])
  const uncovered = srcFiles.filter((f) => !closure.has(f))
  assert.deepEqual(
    uncovered,
    [],
    `${uncovered[0] ?? ''} 未被入口引用且不在 tsconfig*.json 的 include 中，tsc 不会产出到 lib/。请显式加入 include 或由入口引用。`,
  )

  const binFiles = walk(path.join(root, 'bin')).filter((f) => /\.(mjs|cjs)$/.test(f)).map((f) => `bin/${f}`)
  const hostEntryFiles = [
    ...[...hostClosure].filter((f) => f.startsWith('src/') && !f.startsWith('src/client-data/')),
    'lan-gate.mjs',
    'dsh-push.mjs',
    ...binFiles,
  ]
  const missingHostClientData = []
  for (const hostFile of hostEntryFiles) {
    if (!fs.existsSync(path.join(root, hostFile))) continue
    for (const spec of collectModuleSpecifiers(hostFile)) {
      const match = /(?:^|\/)(?:lib\/)?client-data\/([^/'"]+?)(?:\.(?:[cm]?js|ts))?$/.exec(spec)
      if (!match) continue
      const target = `src/client-data/${match[1]}.ts`
      if (fs.existsSync(path.join(root, target)) && !hostClosure.has(target)) {
        missingHostClientData.push(`${hostFile} -> ${target}`)
      }
    }
  }
  assert.deepEqual(
    missingHostClientData,
    [],
    `宿主引用了 src/client-data/ 模块但未进入 tsconfig.json 闭包（tsc 不会产出到 lib/client-data/）：${missingHostClientData[0] ?? ''}。请将其加入 tsconfig.json include。`,
  )
})

// ---------------------------------------------------------------------------
// ② 进程边界：nothing outside lan-gate.mjs may import lan-gate-server
// (the gateway server runs in its own child process; importing it into the
// DSH host process collapses the boundary the secret relay depends on).
// ---------------------------------------------------------------------------
test('② only lan-gate.mjs may reference the lan-gate-server module', () => {
  const offenders = []
  const binFiles = walk(path.join(root, 'bin')).filter((f) => /\.(mjs|cjs)$/.test(f)).map((f) => `bin/${f}`)
  const scriptFiles = walk(path.join(root, 'scripts')).filter((f) => /\.(mjs|cjs)$/.test(f)).map((f) => `scripts/${f}`)
  const scanFiles = [...srcFiles, 'dsh-push.mjs', ...binFiles, ...scriptFiles]
    .filter((f) => f !== 'lan-gate.mjs' && f !== 'scripts/lan-gate.mjs')

  for (const f of scanFiles) {
    const sf = ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true, scriptKindFor(f))
    const isCssFile = f.endsWith('.css.ts')
    const visit = (node) => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const isModuleSpec = ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)
        const text = isCssFile && !isModuleSpec
          ? node.text.replace(/\/\*[\s\S]*?\*\//g, '')
          : node.text
        if (text.includes('lan-gate-server')) {
          offenders.push(`${f}:${lineOf(sf, node)}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(sf, visit)
  }
  assert.deepEqual(
    offenders,
    [],
    `禁止将网关服务端 lan-gate-server 导入 DSH 宿主进程。请仅通过 lan-gate.mjs 子进程启动并经环境变量传入密钥。（命中：${offenders[0] ?? ''}）`,
  )
})

// ---------------------------------------------------------------------------
// ③ 禁用多层宿主嵌套猜想选择器 — evaluates the compiled styles modules inside
// lib/client.js directly so template interpolation, rewrapping, and requoting
// cannot evade inspection. Exemptions live in test/css-depth-allowlist.json as
// verbatim whitespace-normalized selectors grouped per sheet.
// ---------------------------------------------------------------------------

// Evaluate the styles half of the SHIPPED bundle instead of guessing what
// source templates compose to: lib/client.js is what the browser actually
// runs, so a scan over its evaluated strings cannot drift from runtime
// reality.
function evaluateClientBundle() {
  const src = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
  const sf = ts.createSourceFile('client.js', src, ts.ScriptTarget.Latest, true)
  const factories = new Map()
  const visit = (node) => {
    if (ts.isBinaryExpression(node) &&
        ts.isElementAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) && node.left.expression.text === '__modules' &&
        ts.isStringLiteral(node.left.argumentExpression) &&
        (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right))) {
      factories.set(node.left.argumentExpression.text, node.right.getText(sf))
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  assert.ok(factories.size > 30, `lib/client.js bundle shape changed (${factories.size} factories) — re-run pnpm build or adapt the loader`)
  const cache = new Map()
  const localRequire = (id) => {
    const key = id.charCodeAt(0) === 46 ? id.slice(2) : id
    if (cache.has(key)) return cache.get(key).exports
    const factorySrc = factories.get(key)
    if (!factorySrc) throw new Error(`bundle module missing or platform require escaped the sandbox: ${id}`)
    const module = { exports: {} }
    cache.set(key, module)
    const fn = eval(`(${factorySrc})`)
    fn(localRequire, module, module.exports)
    return module.exports
  }
  const styles = new Map()
  for (const key of factories.keys()) {
    if (!/styles\/[^/]+\.css\.js$/.test(key)) continue
    const exports_ = localRequire(key)
    for (const [name, value] of Object.entries(exports_)) {
      if (typeof value === 'string') styles.set(`${key}#${name}`, value)
    }
  }
  assert.ok(styles.size >= 5, `styles modules failed to evaluate (${styles.size}) — the sandbox or the bundle shape broke`)
  return styles
}

// Split a selector list on top-level commas only — commas inside (...), [...],
// or quoted attribute values belong to one selector, not to the group.
function splitSelectorList(text) {
  const out = []
  let parenDepth = 0
  let bracketDepth = 0
  let quote = null
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      cur += ch
      if (ch === '\\' && i + 1 < text.length) { cur += text[i + 1]; i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '(') parenDepth += 1
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)
    else if (ch === '[') bracketDepth += 1
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

// Split CSS text into rules while tracking comments, escaped quotes, and
// @keyframes blocks so keyframe stop percentages never masquerade as selectors.
function* cssRules(css) {
  let chunk = ''
  let quote = null
  let inComment = false
  let braceDepth = 0
  let keyframesDepth = -1
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    const next = css[i + 1]
    if (inComment) {
      chunk += ch
      if (ch === '*' && next === '/') { chunk += '/'; i += 1; inComment = false }
      continue
    }
    if (quote) {
      chunk += ch
      if (ch === '\\' && i + 1 < css.length) { chunk += css[i + 1]; i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && next === '*') { inComment = true; chunk += ch; continue }
    if (ch === '"' || ch === "'") { quote = ch; chunk += ch; continue }
    if (ch === '{') {
      const clean = chunk.replace(/\/\*[\s\S]*?\*\//g, '').trimStart()
      const isAtRule = clean.startsWith('@')
      const isKeyframes = /^@(?:-[a-z]+-)?keyframes\b/i.test(clean)
      if (keyframesDepth === -1) {
        if (isKeyframes) keyframesDepth = braceDepth
        yield { head: chunk, isAtRule }
      }
      braceDepth += 1
      chunk = ''
      continue
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      if (keyframesDepth !== -1 && braceDepth <= keyframesDepth) keyframesDepth = -1
      chunk = ''
      continue
    }
    if (ch === ';') {
      chunk = ''
      continue
    }
    chunk += ch
  }
}

// Option 2 selector depth predicate: flags a selector when EITHER:
//   (1) any :has(...) argument contains a non-leading `>` or >= 2 `>` inside :has(...), OR
//   (2) the selector contains >= 2 child combinators `>` in total (ignoring quoted `>`).
// Benign 1-level direct-child predicates like `:has(> svg)` are allowed.
function isDeepChainOrHas(sel) {
  let quote = null
  let childCount = 0
  let parenDepth = 0
  const hasStack = []
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i]
    if (quote) {
      if (ch === '\\' && i + 1 < sel.length) { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      for (const frame of hasStack) frame.atArgStart = false
      continue
    }
    if (sel.slice(i, i + 5).toLowerCase() === ':has(') {
      for (const frame of hasStack) frame.atArgStart = false
      parenDepth += 1
      hasStack.push({ depth: parenDepth, atArgStart: true, childCount: 0, nonLeadingChild: false })
      i += 4
      continue
    }
    if (ch === '(') {
      for (const frame of hasStack) frame.atArgStart = false
      parenDepth += 1
      continue
    }
    if (ch === ')') {
      const top = hasStack[hasStack.length - 1]
      if (top && top.depth === parenDepth) {
        hasStack.pop()
        if (top.nonLeadingChild || top.childCount >= 2) return true
      }
      parenDepth = Math.max(0, parenDepth - 1)
      continue
    }
    if (ch === ',' && hasStack.length > 0 && hasStack[hasStack.length - 1].depth === parenDepth) {
      hasStack[hasStack.length - 1].atArgStart = true
      continue
    }
    if (ch === '>') {
      childCount += 1
      for (const frame of hasStack) {
        frame.childCount += 1
        if (!frame.atArgStart) frame.nonLeadingChild = true
        frame.atArgStart = false
      }
      continue
    }
    if (!/\s/.test(ch)) {
      for (const frame of hasStack) frame.atArgStart = false
    }
  }
  return childCount >= 2
}

test('③ no unjustified deep child-combinator chains or nested :has() depth guesses (artifact-level)', () => {
  const allowlistDoc = JSON.parse(fs.readFileSync(path.join(root, 'test', 'css-depth-allowlist.json'), 'utf8'))
  const styles = evaluateClientBundle()
  const offenders = []
  const matchedBySheet = new Map()
  for (const [where, css] of styles) {
    const approved = new Set((allowlistDoc.sheets[where]?.selectors ?? []).map((x) => x.replace(/\s+/g, ' ').trim()))
    const matched = new Set()
    matchedBySheet.set(where, matched)
    for (const rule of cssRules(css)) {
      if (rule.isAtRule) continue
      const stripped = rule.head.replace(/\/\*[\s\S]*?\*\//g, '')
      for (const selector of splitSelectorList(stripped)) {
        const sel = selector.trim().replace(/\s+/g, ' ')
        if (!sel || !isDeepChainOrHas(sel)) continue
        if (approved.has(sel)) {
          matched.add(sel)
        } else {
          offenders.push(`${where}: ${sel.slice(0, 90)}`)
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `禁止用多层 :has() 或固定子代深度猜测宿主 DOM 结构。请改用 JS 沿父节点上溯（参考 foldsWholeRows 实现）；确属结构事实时把该完整选择器加进 test/css-depth-allowlist.json 对应 sheet 并确认理由覆盖它（精确匹配，新选择器必须显式登记）。（命中：${offenders[0] ?? ''}）`,
  )

  const stale = []
  for (const [where, entry] of Object.entries(allowlistDoc.sheets ?? {})) {
    if (!styles.has(where)) {
      stale.push(`${where}: sheet absent in lib/client.js`)
      continue
    }
    const selectors = entry?.selectors ?? []
    if (selectors.length === 0) {
      stale.push(`${where}: empty selectors array`)
      continue
    }
    const matched = matchedBySheet.get(where)
    for (const raw of selectors) {
      const norm = raw.replace(/\s+/g, ' ').trim()
      if (!matched?.has(norm)) {
        stale.push(`${where}: ${norm.slice(0, 90)}`)
      }
    }
  }
  assert.deepEqual(
    stale,
    [],
    `test/css-depth-allowlist.json 存在已失效的豁免条目（目标选择器或样式表已不在 lib/client.js 中）。请从 test/css-depth-allowlist.json 删除这些过时条目：${stale[0] ?? ''}`,
  )
})

// ---------------------------------------------------------------------------
// ④ via 拒止墙完整性 — BEHAVIORAL: the real handlers run over real sockets
// with recording stubs so every managed route must reject via-gateway BEFORE
// same-origin checks and BEFORE touching any dependency or backend.
// ---------------------------------------------------------------------------
const VIA = { 'x-zen-remote-via': 'gateway' }
const CROSS_ORIGIN_VIA = {
  ...VIA,
  origin: 'https://evil.example',
  'sec-fetch-site': 'cross-site',
}

function serve(handler) {
  const server = http.createServer((req, res) => { void handler(req, res) })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

function configSnapshot() {
  const values = {
    role: 'host', port: 40000, host: '127.0.0.1', trustedProxies: '', lang: 'zh',
    serverName: 'box', idleHours: 48, pushEvents: 'x/y', logLevel: 'info',
    ingressMode: 'off', ingressDomain: '', ingressHttpsPort: 443,
    ingressAcmeEmail: '', ingressPublicUrl: '',
  }
  const sources = {}
  for (const key of Object.keys(values)) sources[key] = 'row'
  return { values, sources }
}

test('④-behavioral wizard: EVERY route under the prefix rejects via-gateway before touching any dependency', async (t) => {
  const wizard = await import(pathToFileURL(path.join(root, 'lib', 'wizard', 'routes.js')).href)
  const routes = Object.entries(wizard)
    .filter(([k, v]) => /^WIZARD_\w+_ROUTE$/.test(k) && typeof v === 'string')
    .map(([k, v]) => [k, v])
  assert.ok(routes.length >= 10, `wizard route enum broken (${routes.length})`)

  const calls = { trustProxyWrite: 0, tokenWrites: 0, caddy: 0, tunnel: 0, verify: 0 }
  const recording = {
    trustProxy: {
      resolved: () => ({ value: '', source: 'row' }),
      write: () => { calls.trustProxyWrite += 1; return true },
    },
    tokenStore: {
      writeCfToken: () => { calls.tokenWrites += 1 },
      deleteCfToken: () => { calls.tokenWrites += 1 },
      cfTokenConfigured: () => true,
      writeTunnelToken: () => { calls.tokenWrites += 1 },
    },
    caddy: {
      start: async () => { calls.caddy += 1; return { ok: true } },
      stop: () => { calls.caddy += 1 },
      status: () => 'never-started',
    },
    tunnel: {
      checkDomain: async () => { calls.tunnel += 1; return { ok: true } },
      setup: async () => { calls.tunnel += 1; return { ok: true } },
      stop: () => { calls.tunnel += 1 },
      status: () => 'never-started',
    },
    verify: {
      start: async () => { calls.verify += 1; return { ok: true } },
      check: async () => { calls.verify += 1; return { state: 'not-started' } },
    },
  }
  const handler = wizard.createWizardHandler({
    admit: () => ({ peer: {} }),
    getConfig: () => configSnapshot(),
    getRuntime: () => ({}),
    ...recording,
  })
  const { server, port } = await serve(handler)
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const bad = []
  for (const [name, routePath] of routes) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const before = JSON.stringify(calls)
      const res = await request(port, {
        method,
        path: routePath,
        headers: { ...CROSS_ORIGIN_VIA },
        body: method === 'POST' ? '{}' : undefined,
      })
      if (res.status !== 403 || !res.body.includes('via-gateway')) {
        bad.push(`${name} ${method}: status=${res.status} (via-gateway wall must fire before same-origin and route dispatch)`)
      }
      if (JSON.stringify(calls) !== before) {
        bad.push(`${name} ${method}: a recording dependency was invoked despite the rejection`)
      }
    }
  }
  const control = await request(port, { method: 'GET', path: wizard.WIZARD_STATUS_ROUTE })
  assert.notEqual(control.status, 403, 'control failed: local status request must not be rejected — the 403s above would be meaningless')
  for (const method of ['GET', 'POST']) {
    const unknown = await request(port, {
      method,
      path: `${wizard.WIZARD_ROUTE_PREFIX}/unregistered-probe`,
      headers: { ...CROSS_ORIGIN_VIA },
      body: method === 'POST' ? '{}' : undefined,
    })
    assert.equal(unknown.status, 403, `unregistered wizard ${method} route must reject via-gateway (fail-closed)`)
    assert.ok(unknown.body.includes('via-gateway'), `unregistered wizard ${method} must fail on via-gateway before same-origin`)
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})

test('④-behavioral admin: management routes reject via-gateway before same-origin and before the backend', async (t) => {
  const admin = await import(pathToFileURL(path.join(root, 'lib', 'admin-routes.js')).href)
  const { createBridgeRegistry } = await import(pathToFileURL(path.join(root, 'lib', 'plugin-bridge.js')).href)
  const seen = []
  const gateway = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, pairing: { code: 'LIVECODE' }, lastForwardedSource: { ip: '1.1.1.1' }, lastWebClaim: { id: 'x' }, devices: [] }))
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => gateway.close(resolve)))
  const gwPort = gateway.address().port

  let bridgeCalls = 0
  const baseRegistry = createBridgeRegistry()
  baseRegistry.register({ plugin: 'probe-plugin', version: '1.0.0', routes: [{ path: '/probe/x', scope: 'session' }] })
  const pluginBridge = {
    registry: {
      ...baseRegistry,
      list: () => { bridgeCalls += 1; return baseRegistry.list() },
    },
    getConsent: () => { bridgeCalls += 1; return {} },
    adaptedPlugins: () => { bridgeCalls += 1; return new Set() },
  }

  const handler = admin.createAdminHandler({
    admit: () => ({ peer: {} }),
    gatewayBase: `http://127.0.0.1:${gwPort}`,
    getConfig: () => configSnapshot(),
    pluginBridge,
    timeoutMs: 800,
  })
  const { server, port } = await serve(handler)
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const POLICY = new Map([
    [admin.ADMIN_PAIR_ROUTE, { methods: ['POST'], expect: 'reject' }],
    [admin.ADMIN_ACTION_ROUTE, { methods: ['POST'], expect: 'reject' }],
    [admin.ADMIN_PUSH_TEST_ROUTE, { methods: ['POST'], expect: 'reject' }],
    [admin.ADMIN_PLUGIN_BRIDGE_ROUTE, { methods: ['GET'], expect: 'reject' }],
    [admin.ADMIN_STATUS_ROUTE, { methods: ['GET'], expect: 'redact' }],
    [admin.ADMIN_SHARES_ROUTE, { methods: ['GET', 'POST'], expect: 'allow-excepted' }],
  ])
  const exported = Object.entries(admin)
    .filter(([k, v]) => /^ADMIN_\w+_ROUTE$/.test(k) && typeof v === 'string' && v.startsWith(admin.ADMIN_ROUTE_PREFIX))
    .map(([, v]) => v)
    .sort()
  const tabled = [...POLICY.keys()].sort()
  assert.deepEqual(
    exported,
    tabled,
    `admin 路由集合与策略表不一致——新增/删除路由必须同步在测试策略表里登记它的 via 墙预期（漏登记的路由没有任何人替它做允许/拒绝的决定）。导出未登记：${exported.filter((r) => !POLICY.has(r)).join(',') || '无'}；表内已删除：${tabled.filter((r) => !exported.includes(r)).join(',') || '无'}`,
  )
  const rejected = [...POLICY.entries()].filter(([, p]) => p.expect === 'reject')
  const bad = []
  for (const [routePath, policy] of rejected) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      seen.length = 0
      const beforeBridge = bridgeCalls
      const res = await request(port, {
        method,
        path: routePath,
        headers: { ...CROSS_ORIGIN_VIA },
        body: method === 'POST' || method === 'PUT' || method === 'PATCH' ? '{}' : undefined,
      })
      if (policy.methods.includes(method)) {
        if (res.status !== 403 || !res.body.includes('via-gateway')) {
          bad.push(`${routePath} ${method}: status=${res.status} — via-gateway wall must fire before same-origin and backend`)
        }
      } else if (![403, 405].includes(res.status)) {
        bad.push(`${routePath} ${method}: unexpected ${res.status} for unlisted method`)
      }
      if (seen.length !== 0) {
        bad.push(`${routePath} ${method}: gateway received ${seen[0]} despite rejection`)
      }
      if (bridgeCalls !== beforeBridge) {
        bad.push(`${routePath} ${method}: pluginBridge recording stub was called despite rejection`)
      }
    }
  }

  // Control: local GET on ADMIN_PLUGIN_BRIDGE_ROUTE without VIA proves the route is live.
  const beforeControlBridge = bridgeCalls
  const bridgeControl = await request(port, { method: 'GET', path: admin.ADMIN_PLUGIN_BRIDGE_ROUTE })
  assert.equal(bridgeControl.status, 200, 'local GET plugin-bridge must return 200 so the 403 via-gateway check is meaningful')
  assert.ok(bridgeCalls > beforeControlBridge, 'local GET plugin-bridge must hit the recording pluginBridge')

  // The remote-readable exception contract: status answers 200 to a remote
  // caller but MUST strip the live pairing code and topology facts.
  const st = await request(port, { method: 'GET', path: admin.ADMIN_STATUS_ROUTE, headers: { ...VIA } })
  assert.equal(st.status, 200, 'status must stay remote-readable')
  const parsed = JSON.parse(st.body)
  assert.equal(parsed.gateway?.pairing, null, 'remote status must strip the live pairing code')
  assert.equal(parsed.gateway?.lastForwardedSource, null, 'remote status must strip lastForwardedSource')
  assert.equal(parsed.gateway?.lastWebClaim, null, 'remote status must strip lastWebClaim')

  // Fail-closed probe: a route under the admin prefix that nobody registered
  // a wall decision for must never reach the gateway backend.
  seen.length = 0
  await request(port, { method: 'POST', path: `${admin.ADMIN_ROUTE_PREFIX}/unregistered-probe`, headers: { ...CROSS_ORIGIN_VIA }, body: '{}' })
  assert.equal(seen.length, 0, `unregistered admin route reached the gateway backend: ${seen[0] ?? ''}`)
  assert.deepEqual(bad, [], bad.join('\n'))
})

test('④-behavioral shares: the documented exception allows the toggle but keeps same-origin and action validation', async (t) => {
  const admin = await import(pathToFileURL(path.join(root, 'lib', 'admin-routes.js')).href)
  const { createShareStore } = await import(pathToFileURL(path.join(root, 'lib', 'share-store.js')).href)
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zr3-shares-'))
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }))
  const store = createShareStore({ file: path.join(tmpHome, 'shares.json'), idleHours: 48 })
  const seen = []
  const gateway = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, devices: [] }))
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => gateway.close(resolve)))
  const handler = admin.createAdminHandler({
    admit: () => ({ peer: {} }),
    gatewayBase: `http://127.0.0.1:${gateway.address().port}`,
    getConfig: () => configSnapshot(),
    store,
    timeoutMs: 800,
  })
  const { server, port } = await serve(handler)
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const noOrigin = await request(port, {
    method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: { ...VIA },
    body: JSON.stringify({ action: 'share', sessionId: 'sess-1' }),
  })
  assert.ok(noOrigin.status !== 403 || !noOrigin.body.includes('via-gateway'),
    `shares POST must not hit the marker wall (got ${noOrigin.status} via-gateway)`)

  seen.length = 0
  const crossOrigin = await request(port, {
    method: 'POST',
    path: admin.ADMIN_SHARES_ROUTE,
    headers: { ...CROSS_ORIGIN_VIA },
    body: JSON.stringify({ action: 'share', sessionId: 'sess-1' }),
  })
  assert.equal(crossOrigin.status, 403, 'shares POST with cross-origin headers must be rejected')
  assert.equal(JSON.parse(crossOrigin.body).error?.code, 'origin-rejected', 'shares cross-origin must fail same-origin check')
  assert.equal(seen.length, 0, 'cross-origin shares POST must not reach gateway')

  const src = read('src', 'admin-routes.ts')
  assert.match(src, /via-gateway POST is NOT refused/, 'shares 豁免的就地注释丢失')
})

// ---------------------------------------------------------------------------
// ⑤ volatile config 禁止快照 — AST level: walk apply()'s AST for direct
// destructuring of `config` or direct local aliases (e.g. `const row = config
// as Record<string, unknown>`), covering both variable declarations and
// assignment destructuring while allowing resolveConfig(config, ...),
// someObj.config, and inner parameter shadowing.
// ---------------------------------------------------------------------------
function unwrapExpr(node) {
  let cur = node
  while (cur && (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  )) {
    cur = cur.expression
  }
  return cur
}

function collectBindingNames(pattern, out = []) {
  if (ts.isIdentifier(pattern)) {
    out.push(pattern.text)
    return out
  }
  if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
    for (const el of pattern.elements) {
      if (ts.isBindingElement(el)) collectBindingNames(el.name, out)
    }
  }
  return out
}

test('⑤ apply() must not snapshot-destructure volatile config (AST-level)', () => {
  const full = path.join(root, 'src', 'index.ts')
  const sourceFile = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true)
  let applyFn
  const findApply = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'apply') applyFn = node
    ts.forEachChild(node, findApply)
  }
  ts.forEachChild(sourceFile, findApply)
  assert.ok(applyFn, 'src/index.ts 里找不到 apply()')
  const configParam = applyFn.parameters[1]
  assert.ok(configParam && ts.isIdentifier(configParam.name), 'apply() 第二参数不是 config 标识符——签名变了，护栏需要跟着改')

  const offenders = []
  const visit = (node, aliases) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      const innerAliases = new Set(aliases)
      for (const param of node.parameters) {
        for (const name of collectBindingNames(param.name)) innerAliases.delete(name)
      }
      if (node.body) visit(node.body, innerAliases)
      return
    }
    if (ts.isBlock(node)) {
      const blockAliases = new Set(aliases)
      ts.forEachChild(node, (child) => visit(child, blockAliases))
      return
    }
    if (ts.isVariableDeclaration(node)) {
      const inner = node.initializer ? unwrapExpr(node.initializer) : undefined
      const isDirectConfig = Boolean(inner && ts.isIdentifier(inner) && aliases.has(inner.text))
      if (ts.isObjectBindingPattern(node.name)) {
        if (isDirectConfig) offenders.push(`src/index.ts:${lineOf(sourceFile, node)}`)
        for (const name of collectBindingNames(node.name)) aliases.delete(name)
      } else if (ts.isIdentifier(node.name)) {
        if (isDirectConfig) aliases.add(node.name.text)
        else aliases.delete(node.name.text)
      }
      if (node.initializer) visit(node.initializer, aliases)
      return
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const inner = unwrapExpr(node.right)
      const isDirectConfig = Boolean(inner && ts.isIdentifier(inner) && aliases.has(inner.text))
      if (ts.isObjectLiteralExpression(node.left)) {
        if (isDirectConfig) offenders.push(`src/index.ts:${lineOf(sourceFile, node)}`)
      } else if (ts.isIdentifier(node.left)) {
        if (isDirectConfig) aliases.add(node.left.text)
        else aliases.delete(node.left.text)
      }
      visit(node.right, aliases)
      return
    }
    ts.forEachChild(node, (child) => visit(child, aliases))
  }

  if (applyFn.body) visit(applyFn.body, new Set([configParam.name.text]))
  assert.deepEqual(
    offenders,
    [],
    `禁止在 apply() 时解构 volatile Config（非重启字段变更后将永久拿到旧值）。请改用 unwrapVolatile() 或 resolveConfig() 现场读取。（命中：${offenders[0] ?? ''}）`,
  )
})

// ---------------------------------------------------------------------------
// ⑥ 开源主仓脱敏守卫。敏感词表在下面的 SENSITIVE 里用拼接构造——本文件
// 自己不含明文敏感词，因此也不需要路径豁免；按大小写不敏感扫描所有 git
// 跟踪文件（含手工维护的 lib/lan-gate-server.cjs，仅跳过 tsc/esbuild
// 再生产物）。
// ---------------------------------------------------------------------------
const SENSITIVE = [
  'zen-remote' + '-web',
  'zen-remote' + '-gateway' + '-site',
  '/api/v1/' + 'ops',
  '/api/v1/' + 'site',
  'console.' + 'zen-remote.com',
  'relay.' + 'zen-remote.com',
]

test('⑥ no production-site or ops-route vocabulary in the open-source repo', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' })
    .toString('utf8').split('\0').filter(Boolean)
  const offenders = []
  const unreadable = []
  for (const f of tracked) {
    if (f !== 'lib/lan-gate-server.cjs' && /^(lib|\.client-build)\//.test(f)) continue
    let buf
    try {
      buf = fs.readFileSync(path.join(root, f))
    } catch (e) {
      unreadable.push(`${f}: ${String(e).slice(0, 60)}`)
      continue
    }
    if (buf.includes(0)) continue
    const lowerText = buf.toString('utf8').toLowerCase()
    for (const kw of SENSITIVE) {
      const at = lowerText.indexOf(kw.toLowerCase())
      if (at !== -1) {
        const line = lowerText.slice(0, at).split('\n').length
        offenders.push(`${f}:${line} 命中敏感词 (${kw})`)
      }
    }
  }
  assert.deepEqual(unreadable, [], `跟踪文件读取失败（不得静默跳过）：${unreadable[0] ?? ''}`)
  assert.deepEqual(
    offenders,
    [],
    `公开主仓严禁提及生产站点或专有运营路由（命中：${offenders[0] ?? ''}）。请移除相关描述，只保留开源 gateway-server 口径。`,
  )
})
