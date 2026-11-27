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
// ③ 禁用多层宿主嵌套猜想选择器。历史三次静默失效全是同一个形状：
// class 后缀链（[class$="_x"] > ... > [class$="_y"]）写死了宿主 wrapper
// 层数，slot seat 加一层 wrapper 就静默失效且无报错。
// 豁免：选择器块上方 15 行内有块注释给出结构理由（本仓的注释文化本来
// 就要求这么做）；扫描只看 src/client/ 的 css.ts。
// ---------------------------------------------------------------------------
const CLASS_CHAIN_RE = /\[class[*$^]?="[^"]+"\][^,{]*>\s*[^,{]*\[class[*$^]?="[^"]+"\][^,{]*>\s*[^,{]*\[class/

test('③ no unjustified deep class-suffix chains guessing host DOM depth', () => {
  const offenders = []
  for (const f of walk(path.join(root, 'src', 'client')).filter((f) => f.endsWith('.css.ts'))) {
    const lines = read('src', 'client', f).split('\n')
    lines.forEach((line, i) => {
      const st = line.trim()
      if (st.startsWith('*') || st.startsWith('//')) return
      if (!CLASS_CHAIN_RE.test(line)) return
      // Justification: a substantial block comment within the 15 lines
      // above the rule. The repo documents groups of rules in one block,
      // so the window deliberately spans a whole rule group.
      const window15 = lines.slice(Math.max(0, i - 15), i).join('\n')
      const justified = /\/\*[\s\S]{40,}?\*\//.test(window15)
      if (!justified) offenders.push(`src/client/${f}:${i + 1}`)
    })
  }
  assert.deepEqual(
    offenders,
    [],
    `禁止用多层 :has() 或固定子代深度猜测宿主 DOM 结构。请改用 JS 沿父节点上溯（参考 foldsWholeRows 实现）；确属结构事实时在规则上方写块注释说明理由。（命中：${offenders[0] ?? ''}）`,
  )
})

// ---------------------------------------------------------------------------
// ④ via 拒止墙完整性：admin/wizard 的路由分派必须在 x-zen-remote-via 检查
// 之后。两个文件的墙形状不同（wizard 单面墙管全部路由；admin 按路由组分墙
// + status 有远程可读例外），所以校验的是「每一分派组内 via 检查先于
// 方法/动作分派」而不是单一位置。
// ---------------------------------------------------------------------------
test('④ wizard routes: the via-gateway wall precedes every route dispatch', () => {
  const src = read('src', 'wizard', 'routes.ts')
  const viaAt = src.indexOf("req.headers['x-zen-remote-via']")
  assert.notEqual(viaAt, -1, 'wizard/routes.ts 完全没有 x-zen-remote-via 检查')
  // Route dispatch lines: route equality or method branching after url parsing.
  const dispatchRe = /route === WIZARD_\w+_ROUTE/
  const lines = src.split('\n')
  let pos = 0
  const violations = []
  for (const line of lines) {
    const idx = pos
    pos += line.length + 1
    if (dispatchRe.test(line) && idx < viaAt) {
      // url parsing itself is fine; only actual route dispatch before the wall is not
      violations.push(line.trim().slice(0, 80))
    }
  }
  assert.deepEqual(
    violations,
    [],
    `管理/向导路由缺失 x-zen-remote-via 拒止墙，远程设备将能越权访问。请在路由分派最前面加入 rejectViaProxy 检查。（命中：${violations[0] ?? ''}）`,
  )
})

test('④ admin routes: every mutating/admin route group checks via before dispatching actions', () => {
  const src = read('src', 'admin-routes.ts')
  // The wall's shape in this file: inside each management route group, the
  // x-zen-remote-via check precedes sameOriginPost and the action dispatch.
  // Two DOCUMENTED exceptions (module comment, T33a / GW-fix-2):
  //   - ADMIN_STATUS_ROUTE: remote-readable, but respondStatus must REDACT
  //     the live pairing code and topology facts for via-gateway callers.
  //   - ADMIN_SHARES_ROUTE POST: deliberately NOT refused (the phone needs
  //     the sharing toggle) — but the exception must stay documented, so we
  //     require the exception comment to sit inside the POST branch.
  const groupRe = /if \(route === (ADMIN_\w+_ROUTE[^)]*)\)/g
  const lines = src.split('\n')
  const failures = []
  const EXEMPT_GROUPS = new Set(['ADMIN_STATUS_ROUTE', 'ADMIN_SHARES_ROUTE'])
  for (const m of src.matchAll(groupRe)) {
    const groupName = m[1].split(' ')[0].replace(/,$/, '')
    if (EXEMPT_GROUPS.has(groupName)) continue
    const lineIdx = src.slice(0, m.index).split('\n').length - 1
    const body = lines.slice(lineIdx, lineIdx + 60)
    const isComment = (l) => l.trim().startsWith('*') || l.trim().startsWith('//')
    const viaLine = body.findIndex((l) => !isComment(l) && l.includes("req.headers['x-zen-remote-via']"))
    const actionLine = body.findIndex((l) => !isComment(l) && (/sameOriginPost\(req\)/.test(l) || /\baction\s*={2,3}|\bverb\s*={2,3}|^\s*case '/.test(l)))
    if (actionLine !== -1 && viaLine === -1) {
      failures.push(`${groupName} (line ${lineIdx + 1}): 分派前无 via 检查`)
    } else if (viaLine !== -1 && actionLine !== -1 && viaLine > actionLine) {
      failures.push(`${groupName} (line ${lineIdx + 1}): via 检查在分派之后`)
    }
  }
  // Exception integrity 1: status redaction must survive refactors.
  const respondStatus = src.slice(src.indexOf('async function respondStatus'), src.indexOf('async function respondStatus') + 2500)
  assert.match(
    respondStatus,
    /x-zen-remote-via/,
    '管理/向导路由 ADMIN_STATUS_ROUTE 缺失 x-zen-remote-via 拒止墙，远程设备将能越权访问。请在路由分派最前面加入 rejectViaProxy 检查。（status 为例外路由：不拒绝但必须脱敏，脱敏逻辑丢失）',
  )
  assert.match(respondStatus, /pairing\?:\s*unknown[>}]=\s*null|\.pairing = null/, 'status 脱敏不再剥除活配对码（GW-fix-2 回退）')
  // Exception integrity 2: the shares POST exception must stay documented
  // in place — undocumented exceptions are indistinguishable from holes.
  const sharesDispatchAt = src.indexOf('route === ADMIN_SHARES_ROUTE')
  const sharesPost = src.slice(sharesDispatchAt, sharesDispatchAt + 3500)
  assert.match(
    sharesPost,
    /exception[\s\S]{0,400}via-gateway POST is NOT refused|via-gateway POST is NOT refused/,
    'shares POST 的 via 豁免失去了就地注释——没有文档的豁免与漏洞不可区分，请补回例外说明或加回拒止墙',
  )
  assert.deepEqual(
    failures,
    [],
    `管理/向导路由 ${failures[0] ?? ''} 缺失 x-zen-remote-via 拒止墙，远程设备将能越权访问。请在路由分派最前面加入 rejectViaProxy 检查。`,
  )
})

// ---------------------------------------------------------------------------
// ⑤ volatile config 禁止快照：apply() 内不得对 config 做顶层解构
// （const { x } = config）——volatile 字段经参考对象传入，快照读到的
// 永远是 apply 那一刻的旧值。现场读用 unwrapVolatile/resolveConfig。
// ---------------------------------------------------------------------------
test('⑤ apply() must not snapshot-destructure volatile config', () => {
  const src = read('src', 'index.ts')
  const applyStart = src.indexOf('export function apply(')
  assert.notEqual(applyStart, -1)
  // End of apply: next top-level export function after it.
  const rest = src.slice(applyStart)
  const endMatch = rest.slice(10).search(/\nexport function \w+\(/)
  const body = endMatch === -1 ? rest : rest.slice(0, endMatch + 10)
  const offenders = []
  body.split('\n').forEach((line, i) => {
    const st = line.trim()
    if (st.startsWith('*') || st.startsWith('//')) return
    if (/^(const|let|var)\s*\{[^}]*\}\s*=\s*config\b/.test(st)) {
      offenders.push(`apply()+${i}: ${st.slice(0, 70)}`)
    }
  })
  assert.deepEqual(
    offenders,
    [],
    `禁止在 apply() 时解构 volatile Config（非重启字段变更后将永久拿到旧值）。请改用 unwrapVolatile() 或 resolveConfig() 现场读取。（命中：${offenders[0] ?? ''}）`,
  )
})

// ---------------------------------------------------------------------------
// ⑥ 开源主仓脱敏守卫。敏感词表在下面的 SENSITIVE 里用拼接构造——本文件
// 自己必须含这些词才能扫别人，但明文躺进开源仓正是本检查要拦的事，
// 所以词表一律分段拼接、运行时拼合；本测试文件按路径白名单豁免
// （豁免仅豁免「拼接后的零件」，而这些零件单独出现无害）。
// ---------------------------------------------------------------------------
const SENSITIVE = [
  'zen-remote' + '-web',
  'zen-remote' + '-gateway' + '-site',
  '/api/v1/' + 'ops',
  '/api/v1/' + 'site',
]
const SCANNER_SELF = 'test/architecture-guardrails.test.cjs'

test('⑥ no production-site or ops-route vocabulary in the open-source repo', () => {
  const offenders = []
  const scanTargets = [
    ...srcFiles,
    ...walk(path.join(root, 'docs')).map((f) => `docs/${f}`).filter((f) => /\.(md|ts|mjs|cjs)$/.test(f)),
    ...walk(path.join(root, 'scripts')).map((f) => `scripts/${f}`).filter((f) => /\.(mjs|cjs)$/.test(f)),
    ...walk(path.join(root, 'test')).map((f) => `test/${f}`).filter((f) => /\.(cjs|mjs)$/.test(f) && `test/${f}` !== SCANNER_SELF),
    ...fs.readdirSync(root).filter((f) => /\.(md|mjs|cjs)$/.test(f)),
  ]
  for (const f of scanTargets) {
    let text
    try {
      text = read(f)
    } catch {
      continue
    }
    for (const kw of SENSITIVE) {
      const at = text.indexOf(kw)
      if (at !== -1) {
        const line = text.slice(0, at).split('\n').length
        offenders.push(`${f}:${line} 命中敏感词`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `公开主仓严禁提及生产站点或专有运营路由（命中：${offenders[0] ?? ''}）。请移除相关描述，只保留开源 gateway-server 口径。`,
  )
})
