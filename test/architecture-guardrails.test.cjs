'use strict'
// architecture-guardrails.test.cjs — ZR-3 static guardrails.
// Every check fails with the exact repair guidance from the optimization
// plan (Phase 2, ZR-3 table). Source-analysis style follows the repo's
// existing test conventions (text scans over src/, no runtime typescript
// require in the HOT path — ts is only used for the program-closure check,
// matching scripts/check-orphan-lib.mjs).
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

function walk(dir, rel = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(abs, relPath))
    else if (entry.isFile()) out.push(relPath)
  }
  return out
}

const srcFiles = walk(path.join(root, 'src'))
  .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
  .map((f) => `src/${f}`)

// ---------------------------------------------------------------------------
// ① tsconfig include 漏网：new src non-test files must be inside one of the
// two programs' input closures (include + transitive imports). Otherwise tsc
// never emits them to lib/ and the plugin crashes at runtime with
// ERR_MODULE_NOT_FOUND (2026-10-25 GW-1).
// ---------------------------------------------------------------------------
function programClosure(configPath) {
  const raw = execFileSync(process.execPath, [
    '-e',
    `const ts=require('typescript');const c=ts.readConfigFile(${JSON.stringify(configPath)},ts.sys.readFile);const p=ts.parseJsonConfigFileContent(c.config,ts.sys,${JSON.stringify(path.dirname(configPath))});const prog=ts.createProgram(p.fileNames,p.options);const names=prog.getSourceFiles().map(f=>f.fileName).filter(n=>!n.includes('node_modules'));console.log(JSON.stringify(names))`,
  ], { cwd: root, encoding: 'utf8' })
  return new Set(JSON.parse(raw).map((f) => path.relative(root, f).split('\\').join('/')))
}

test('① every non-test src file is inside a tsconfig program closure', () => {
  const closure = new Set([...programClosure(path.join(root, 'tsconfig.json')), ...programClosure(path.join(root, 'tsconfig.client.json'))])
  const uncovered = srcFiles.filter((f) => !closure.has(f))
  assert.deepEqual(
    uncovered,
    [],
    `${uncovered[0] ?? ''} 未被入口引用且不在 tsconfig*.json 的 include 中，tsc 不会产出到 lib/。请显式加入 include 或由入口引用。`,
  )
})

// ---------------------------------------------------------------------------
// ② 进程边界：nothing outside lan-gate.mjs may import lan-gate-server
// (the gateway server runs in its own child process; importing it into the
// DSH host process collapses the boundary the secret relay depends on).
// ---------------------------------------------------------------------------
test('② only lan-gate.mjs may reference the lan-gate-server module', () => {
  const offenders = []
  const scanFiles = [
    ...srcFiles,
    ...walk(path.join(root, 'scripts')).map((f) => `scripts/${f}`).filter((f) => /\.mjs$/.test(f)),
  ]
  for (const f of scanFiles) {
    if (f.endsWith('.css.ts')) continue
    const text = read(f)
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      const stripped = line.trim()
      if (stripped.startsWith('*') || stripped.startsWith('//')) return
      if (/lan-gate-server/.test(line) && /(import|require|from|spawn|execFile|fork)\b/.test(line)) {
        offenders.push(`${f}:${i + 1}`)
      }
    })
  }
  assert.deepEqual(
    offenders,
    [],
    `禁止将网关服务端 lan-gate-server 导入 DSH 宿主进程。请仅通过 lan-gate.mjs 子进程启动并经环境变量传入密钥。（命中：${offenders[0] ?? ''}）`,
  )
})

// ---------------------------------------------------------------------------
// ③ 禁用多层宿主嵌套猜想选择器 — AST/template level (ZR-3 R1 item 5):
// the line-level scan was evaded by rewrapping the selector across lines
// (format-comparison.json). Here the TypeScript AST hands us the template
// nodes, ${CONST} interpolations are resolved through module-scope const
// evaluation, selectors are split rule-head by rule-head on the FINAL
// string, and nested templates are walked recursively — rewrapping,
// requoting or reformatting cannot change what the selector IS.
// Exemption: a `zr-depth-ok` comment inside the same template, which ships
// with the artifact so the justification can never be stripped silently.
// ---------------------------------------------------------------------------
const ts = require('typescript')

// The accident shape: class-suffix chains (host emotion class names) linked
// by 2+ child combinators — the selector only matches when the host wraps
// content in EXACTLY that many layers, and silently dies when the wrapper
// count changes. This is what silently failed three times.
const CLASS_CHAIN_RE = /\[class[*$^]?="[^"]+"\][^,{]*>\s*[^,{]*\[class[*$^]?="[^"]+"\][^,{]*>\s*[^,{]*\[class/

// Evaluate the styles half of the SHIPPED bundle instead of guessing what
// source templates compose to: lib/client.js is what the browser actually
// runs, so a scan over its evaluated strings cannot drift from runtime
// reality. The bundle is plain CJS factories keyed in __modules; platform
// requires (react et al.) are never touched by the styles modules, which
// are pure string constants plus string functions.
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

// Split css text into rule heads: everything before each top-level `{` that
// is not inside a comment. At-rules produce nested heads; every chunk ending
// at `{` is treated as a potential selector list.
function* ruleHeads(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let chunk = ''
  for (const ch of stripped) {
    if (ch === '{') {
      yield chunk
      chunk = ''
    } else if (ch === '}') {
      chunk = ''
    } else {
      chunk += ch
    }
  }
}

test('③ no unjustified deep class-suffix chains guessing host DOM depth (artifact-level)', () => {
  const offenders = []
  for (const [where, css] of evaluateClientBundle()) {
    const exempted = css.includes('zr-depth-ok')
    const seen = new Set()
    for (const head of ruleHeads(css)) {
      for (const selector of head.split(',')) {
        const sel = selector.trim().replace(/\s+/g, ' ')
        if (!sel || sel.startsWith('@') || sel.includes('%') || seen.has(sel)) continue
        seen.add(sel)
        if (!exempted && CLASS_CHAIN_RE.test(sel)) {
          offenders.push(`${where}: ${sel.slice(0, 90)}`)
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `禁止用多层 :has() 或固定子代深度猜测宿主 DOM 结构。请改用 JS 沿父节点上溯（参考 foldsWholeRows 实现）；确属结构事实时在所属模板内加 zr-depth-ok 注释说明理由。（命中：${offenders[0] ?? ''}）`,
  )
})

// ---------------------------------------------------------------------------
// ④ via 拒止墙完整性 — BEHAVIORAL (ZR-3 R1 item 3): text scanning cannot
// prove the wall fires before dispatch (a comment mentioning the marker
// turned a wall-less file green; requoting turned correct code red). The
// real handlers run over real sockets here with fully recording stubs:
// every managed route is hit with the via marker and must answer the
// contract WITHOUT any recording stub being invoked; control requests
// without the marker prove the route is alive (no silent 404 false-pass).
// A route added without registering it in these tests fails closed:
// wizard unknowns via 403-anyway mismatching the table's status
// expectation, admin unknowns 404ing against 403.
// ---------------------------------------------------------------------------
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const { request } = require('./util.cjs')

const VIA = { 'x-zen-remote-via': 'gateway' }

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
      start: () => { calls.verify += 1; return { id: 'v' } },
      status: () => ({ state: 'not-started' }),
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
    for (const method of ['GET', 'POST']) {
      const before = JSON.stringify(calls)
      const res = await request(port, { method, path: routePath, headers: { ...VIA }, body: method === 'POST' ? '{}' : undefined })
      if (res.status !== 403 || !res.body.includes('via-gateway')) {
        bad.push(`${name} ${method}: status=${res.status} (wall must fire before any route dispatch — GET included)`)
      }
      if (JSON.stringify(calls) !== before) {
        bad.push(`${name} ${method}: a recording dependency was invoked despite the rejection`)
      }
    }
  }
  // Control: local requests must NOT 403 via-gateway — proves the rejection
  // above is the marker wall, not a dead server.
  const control = await request(port, { method: 'GET', path: wizard.WIZARD_STATUS_ROUTE })
  assert.notEqual(control.status, 403, 'control failed: local status request must not be rejected — the 403s above would be meaningless')
  // Fail-closed: an unregistered route under the wizard prefix must ALSO
  // answer 403 via-gateway — meaning a future route added without a wall
  // review cannot silently pass (the wall precedes all dispatch by design;
  // this is the probe that would catch a reordering).
  const unknown = await request(port, { method: 'GET', path: `${wizard.WIZARD_ROUTE_PREFIX}/unregistered-probe`, headers: { ...VIA } })
  assert.equal(unknown.status, 403, 'unregistered wizard route must reject via-gateway (fail-closed)')
  assert.deepEqual(bad, [], bad.join('\n'))
})

test('④-behavioral admin: management routes reject via-gateway before same-origin and before the backend', async (t) => {
  const admin = await import(pathToFileURL(path.join(root, 'lib', 'admin-routes.js')).href)
  // Mock gateway records everything it is sent — the backend-invocation probe.
  const seen = []
  const gateway = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, pairing: { code: 'LIVECODE' }, lastForwardedSource: { ip: '1.1.1.1' }, lastWebClaim: { id: 'x' }, devices: [] }))
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => gateway.close(resolve)))
  const gwPort = gateway.address().port

  const handler = admin.createAdminHandler({
    admit: () => ({ peer: {} }),
    gatewayBase: `http://127.0.0.1:${gwPort}`,
    getConfig: () => configSnapshot(),
    timeoutMs: 800,
  })
  const { server, port } = await serve(handler)
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const rejected = [
    admin.ADMIN_PAIR_ROUTE, admin.ADMIN_ACTION_ROUTE, admin.ADMIN_PUSH_TEST_ROUTE, admin.ADMIN_PLUGIN_BRIDGE_ROUTE,
  ]
  const bad = []
  for (const routePath of rejected) {
    for (const method of ['POST', 'GET']) {
      seen.length = 0
      const res = await request(port, { method, path: routePath, headers: { ...VIA }, body: method === 'POST' ? '{}' : undefined })
      if (method === 'POST') {
        // plugin-bridge without a wired registry 404s before any wall
        // decision — also fail-closed, the backend is equally unreachable.
        const acceptable = routePath === admin.ADMIN_PLUGIN_BRIDGE_ROUTE
          ? (res.status === 404 || (res.status === 403 && res.body.includes('via-gateway')))
          : (res.status === 403 && res.body.includes('via-gateway'))
        if (!acceptable) {
          bad.push(`${routePath} POST: status=${res.status} — the wall must fire before the backend`)
        }
        if (seen.length !== 0) {
          bad.push(`${routePath} POST: gateway received ${seen[0]} despite rejection`)
        }
      } else if (routePath !== admin.ADMIN_PLUGIN_BRIDGE_ROUTE) {
        // GET on POST-only management routes: either the wall (403) or
        // method enforcement (405) — never a backend call.
        if (![403, 405].includes(res.status)) bad.push(`${routePath} GET: unexpected ${res.status}`)
        if (seen.length !== 0) bad.push(`${routePath} GET: gateway called (${seen[0]})`)
      }
    }
  }
  // The remote-readable exception contract: status answers 200 to a remote
  // caller but MUST strip the live pairing code and topology facts.
  const st = await request(port, { method: 'GET', path: admin.ADMIN_STATUS_ROUTE, headers: { ...VIA } })
  assert.equal(st.status, 200, 'status must stay remote-readable')
  const parsed = JSON.parse(st.body)
  assert.equal(parsed.gateway?.pairing, null, 'remote status must strip the live pairing code')
  assert.equal(parsed.gateway?.lastForwardedSource, null, 'remote status must strip lastForwardedSource')
  assert.equal(parsed.gateway?.lastWebClaim, null, 'remote status must strip lastWebClaim')
  // Fail-closed probe: a route under the admin prefix that nobody registered
  // a wall decision for. Whatever it answers, it must never reach the
  // gateway backend — an unreviewed route cannot become a remote hole.
  seen.length = 0
  await request(port, { method: 'POST', path: `${admin.ADMIN_ROUTE_PREFIX}/unregistered-probe`, headers: { ...VIA }, body: '{}' })
  assert.equal(seen.length, 0, `unregistered admin route reached the gateway backend: ${seen[0] ?? ''}`)
  assert.deepEqual(bad, [], bad.join('\n'))
})

test('④-behavioral shares: the documented exception allows the toggle but keeps same-origin and action validation', async (t) => {
  const admin = await import(pathToFileURL(path.join(root, 'lib', 'admin-routes.js')).href)
  const { createShareStore } = await import(pathToFileURL(path.join(root, 'lib', 'share-store.js')).href)
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'zr3-shares-'))
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

  // The exception itself: a via-gateway POST with valid same-origin shape is
  // NOT refused by the marker wall (a phone behind the gateway must be able
  // to toggle sharing) — but it still faces same-origin and action checks.
  const noOrigin = await request(port, {
    method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: { ...VIA },
    body: JSON.stringify({ action: 'share', sessionId: 'sess-1' }),
  })
  // Without an Origin header this presents as a desktop-client-shaped
  // same-origin request (both headers absent → allowed) — the request must
  // NOT be a via-gateway 403; the outcome is action-validation territory.
  assert.ok(noOrigin.status !== 403 || !noOrigin.body.includes('via-gateway'),
    `shares POST must not hit the marker wall (got ${noOrigin.status} via-gateway)`)
  // And the documented exception comment must still be in the source —
  // undocumented exceptions are indistinguishable from holes.
  const src = read('src', 'admin-routes.ts')
  assert.match(src, /via-gateway POST is NOT refused/, 'shares 豁免的就地注释丢失')
})

// ---------------------------------------------------------------------------
// ⑤ volatile config 禁止快照 — AST level (ZR-3 R1 item 5): the regex
// matched only single-line destructuring; the same statement rewrapped
// across lines passed. Here we walk apply()'s AST for any variable
// declaration whose object-binding pattern initializer ultimately
// references the `config` parameter — formatting is irrelevant by
// construction. Only unwrapVolatile()/resolveConfig() access is legal.
// ---------------------------------------------------------------------------
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
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      // Does the initializer mention the config identifier directly
      // (const { x } = config / config as T / (config))? Property access on
      // resolveConfig(...) results is fine — those are fresh reads.
      let hitsConfig = false
      const probe = (n) => {
        if (ts.isIdentifier(n) && n.text === configParam.name.text) hitsConfig = true
        ts.forEachChild(n, probe)
      }
      probe(node.initializer)
      if (hitsConfig) offenders.push(`src/index.ts:${lineOf(node)}`)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(applyFn, visit)
  assert.deepEqual(
    offenders,
    [],
    `禁止在 apply() 时解构 volatile Config（非重启字段变更后将永久拿到旧值）。请改用 unwrapVolatile() 或 resolveConfig() 现场读取。（命中：${offenders[0] ?? ''}）`,
  )
})

// ---------------------------------------------------------------------------
// ⑥ 开源主仓脱敏守卫。敏感词表在下面的 SENSITIVE 里用拼接构造——本文件
// 自己必须含这些词才能扫别人，但明文躺进开源仓正是本检查要拦的事，
// 所以词表一律分段拼接、运行时拼合。拼接后的零件单独出现无害
// （"-web"、"ops" 不是敏感词），即便如此本文件仍按路径整体豁免——
// 不是怕误报，而是扫描器把自己的词表当作扫描输入没有任何信息量，
// 豁免声明写在这里，删词表的时候记得一起删豁免。
// ---------------------------------------------------------------------------
const SENSITIVE = [
  'zen-remote' + '-web',
  'zen-remote' + '-gateway' + '-site',
  '/api/v1/' + 'ops',
  '/api/v1/' + 'site',
]
const SCANNER_SELF = 'test/architecture-guardrails.test.cjs'

test('⑥ no production-site or ops-route vocabulary in the open-source repo', () => {
  // Enumeration is git-tracked files (ZR-3 R1 item 4): filesystem walking
  // missed .github/workflows YAML because the scan list never included it,
  // and untracked scratch files must not red the gate. Binary files are
  // excluded by a NUL-byte sniff; a candidate that fails to read is an
  // ERROR, never a silent skip. Case is NOT folded: the tokens are
  // lowercase product/route names whose camelCase or uppercase variants
  // are different words with different meanings — folding would red
  // legitimate prose ("the site") without catching anything real.
  const SCANNER_SELF = 'test/architecture-guardrails.test.cjs'
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean)
  const TEXT_EXT = /\.(md|ts|tsx|cjs|mjs|js|json|ya?ml|txt|css|html|sh)$/
  const offenders = []
  const unreadable = []
  for (const f of tracked) {
    if (f === SCANNER_SELF) continue // self-exemption: the scanner carries the keyword fragments; see the header note
    if (!TEXT_EXT.test(f)) continue
    if (/^(lib|\.client-build)\//.test(f)) continue // build outputs are regenerated from scanned sources
    let buf
    try {
      buf = fs.readFileSync(path.join(root, f))
    } catch (e) {
      unreadable.push(`${f}: ${String(e).slice(0, 60)}`)
      continue
    }
    if (buf.includes(0)) continue // binary sniff — explicitly excluded
    const text = buf.toString('utf8')
    for (const kw of SENSITIVE) {
      const at = text.indexOf(kw)
      if (at !== -1) {
        const line = text.slice(0, at).split('\n').length
        offenders.push(`${f}:${line} 命中敏感词`)
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