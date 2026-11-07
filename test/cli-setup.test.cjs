/* dsh-zen-remote · CLI-5: setup 三步向导 + bin/zen-remote.mjs 入口（runCli 分发）
 *
 * 驱动 BUILT lib/cli/command-setup.js 与 lib/cli/main.js（与前几个 CLI 测试同理：
 * src 相对导入在 Node strip-only 模式下映射不了）。测试接缝三（SPEC）：真实 IPC
 * Socket 服务端 + 受控 delegate 替身（admin/wizard/client 路由答罐装 JSON，写配置
 * 可联动翻转 delegate 角色），setup 全流程经 runCli 入口驱动；插件安装 / 守护拉起
 * 用注入的 spawnCommand / execProbe（含"拉起后 socket 才出现"的时序钩子），交互问答
 * 走注入的 fake prompter（含 selectMulti）。断言退出码、stdout 双语文本、写入配置
 * 的字段与路由请求顺序，不断言内部调用顺序。验收 6 用真实子进程跑
 * node bin/zen-remote.mjs --help / status --json（连真实临时 IPC socket）。
 *
 * macOS 的 Unix socket 路径上限约 104 字节，临时目录继续用 /tmp 短前缀（沿用
 * cli-bootstrap.test.cjs 的既有先例；仅测试内部的 mkdtemp，非命令输出重定向）。
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MAIN_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'main.js')).href
const ARGS_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'args.js')).href
const I18N_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'i18n.js')).href
const IPC_SERVER_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'ipc-server.js')).href
const IPC_CLIENT_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'ipc-client.js')).href
const BOOTSTRAP_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'bootstrap.js')).href
const ROOT = path.join(__dirname, '..')
const BIN_PATH = path.join(ROOT, 'bin', 'zen-remote.mjs')

function makeHome(tag) {
  return fs.mkdtempSync(path.join('/tmp', `dshzr5-${tag}-`))
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
}

function mkdirIn(home, ...parts) {
  const dir = path.join(home, ...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function captureStdout() {
  const lines = []
  return { lines, write: (text) => lines.push(text), text: () => lines.join('') }
}

async function loadModules() {
  const [main, args, i18n, ipcServer, ipcClient, bootstrap] = await Promise.all([
    import(MAIN_URL), import(ARGS_URL), import(I18N_URL),
    import(IPC_SERVER_URL), import(IPC_CLIENT_URL), import(BOOTSTRAP_URL),
  ])
  return { ...main, ...args, ...i18n, ...ipcServer, ...ipcClient, ...bootstrap }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 罐头 delegate 与 IPC 服务端 -----------------------------------------------

/** 罐装 delegate：admin/wizard/client 三张路由表，表项是 `{ status, body }` 或
 * `(res, seen) => void`；所有请求（含 POST 体）都记进 requests 供断言。
 * `getRole` 可给动态角色（角色切换联动测试用）。 */
function cannedDelegate(overrides = {}) {
  const requests = []
  const json = (res, status, body) => {
    const bytes = Buffer.from(JSON.stringify(body))
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
    res.end(bytes)
  }
  const makeHandler = (routes) => async (req, res) => {
    const routePath = String(req.url).split('?')[0]
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const bodyText = Buffer.concat(chunks).toString('utf8')
    const seen = { method: req.method, path: routePath, body: bodyText === '' ? undefined : JSON.parse(bodyText) }
    requests.push(seen)
    const entry = routes?.[routePath]
    if (entry === undefined) { json(res, 404, { ok: false, error: { code: 'not-found' } }); return }
    if (typeof entry === 'function') { entry(res, seen); return }
    json(res, entry.status ?? 200, typeof entry.body === 'function' ? entry.body(seen) : entry.body)
  }
  /** 写配置记录：seq 取当时 requests 长度，用来断言"停进程先于写配置"。 */
  const writes = []
  const writeConfig = (input) => {
    writes.push({ seq: requests.length, set: input.set })
    if (overrides.flipRole !== undefined && input.set?.role !== undefined) overrides.flipRole(input.set.role)
    return { ok: true, values: {} }
  }
  return {
    requests,
    writes,
    delegate: {
      role: () => (overrides.getRole !== undefined ? overrides.getRole() : overrides.role ?? 'host'),
      serverName: () => overrides.serverName ?? '茶壶机',
      profileName: () => overrides.profileName,
      pluginVersion: () => '9.9.9-test',
      writeConfig: overrides.writeConfig ?? writeConfig,
      wizardHandler: makeHandler(overrides.wizard),
      adminHandler: makeHandler(overrides.admin),
      clientHandler: makeHandler(overrides.client),
    },
  }
}

async function startIpcServer(home, overrides = {}) {
  const ipc = await import(IPC_SERVER_URL)
  const canned = cannedDelegate(overrides)
  const handle = await ipc.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
  return { handle, canned }
}

/** fake prompter：按序吐出预置答案，并把每次提问记录下来供断言。 */
function fakePrompter({ inputs = [], confirms = [], selects = [], multi = { indices: [0], customNames: [] } } = {}) {
  const calls = []
  let inputIndex = 0
  let confirmIndex = 0
  let selectIndex = 0
  return {
    calls,
    async inputText(question) {
      calls.push({ kind: 'input', question })
      const value = inputs[inputIndex++]
      assert.notEqual(value, undefined, `unexpected extra inputText prompt: ${question}`)
      return value
    },
    async confirm(question) {
      calls.push({ kind: 'confirm', question })
      const value = confirms[confirmIndex++]
      assert.notEqual(value, undefined, 'unexpected extra confirm prompt')
      return value
    },
    async selectOne(question, choices, defaultIndex) {
      calls.push({ kind: 'select', question, choices, defaultIndex })
      const value = selects[selectIndex++]
      assert.notEqual(value, undefined, 'unexpected extra selectOne prompt')
      return value
    },
    async selectMulti(question, choices, defaultIndices, allowCustomInput) {
      calls.push({ kind: 'multi', question, choices, defaultIndices, allowCustomInput })
      return multi
    },
    close() {},
  }
}

// ---- 罐头数据 ----------------------------------------------------------------

const WIZARD_STOPS = {
  '/_dsh/zen-remote/admin/wizard/caddy/stop': { body: { ok: true, state: 'never-started' } },
  '/_dsh/zen-remote/admin/wizard/tunnel/stop': { body: { ok: true, state: 'never-started' } },
}

const ROUTES = {
  caddyStop: '/_dsh/zen-remote/admin/wizard/caddy/stop',
  tunnelStop: '/_dsh/zen-remote/admin/wizard/tunnel/stop',
  cfToken: '/_dsh/zen-remote/admin/wizard/cf-token',
  caddyStart: '/_dsh/zen-remote/admin/wizard/caddy/start',
  tunnelCheck: '/_dsh/zen-remote/admin/wizard/tunnel/check-domain',
  tunnelSetup: '/_dsh/zen-remote/admin/wizard/tunnel/setup',
  verify: '/_dsh/zen-remote/admin/wizard/verify',
  clientStatus: '/_dsh/zen-remote/client/status',
  clientClaim: '/_dsh/zen-remote/client/claim',
  clientUnpair: '/_dsh/zen-remote/client/unpair',
}

const ADMIN_OK = {
  '/_dsh/zen-remote/admin/status': {
    body: {
      ok: true,
      gatewayReachable: true,
      gatewayStatus: 200,
      gateway: { state: 'running', port: 3088, devices: [] },
      config: { values: { port: 3088 }, sources: {} },
    },
  },
}

const WIZARD_OFF = {
  ...WIZARD_STOPS,
  '/_dsh/zen-remote/admin/wizard/status': {
    body: {
      ok: true, mode: 'off', domain: '', httpsPort: 443,
      publicUrl: '', cfTokenConfigured: false,
      tunnelTokenConfigured: false, caddyRunning: false, cloudflaredRunning: false,
      gatewayActualPort: 3088, lanAddress: '10.0.0.5',
      lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null,
    },
  },
}

const WIZARD_CADDY_CONFIGURED = {
  ...WIZARD_STOPS,
  '/_dsh/zen-remote/admin/wizard/status': {
    body: {
      ok: true, mode: 'caddy', domain: 'tea.example.com', httpsPort: 443,
      publicUrl: 'https://tea.example.com', cfTokenConfigured: true,
      tunnelTokenConfigured: false, caddyRunning: true, cloudflaredRunning: false,
      gatewayActualPort: 3088, lanAddress: '10.0.0.5',
      lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null,
    },
  },
}

/** verify 路由：POST 用 seen.body.publicUrl 回声（第 1/2 盏灯通过），GET 回 pass
 * （第 3 盏灯立即点亮）。 */
const VERIFY_PASS = {
  [ROUTES.verify]: (res, seen) => {
    const body = seen.method === 'GET'
      ? { result: 'pass', deviceId: 'dev-new', at: 1730000001000 }
      : { ok: true, pairingCode: 'WEBPAIR8', publicUrl: String(seen.body?.publicUrl ?? 'https://tea.example.com'), expiresAt: Date.now() + 10 * 60 * 1000 }
    const bytes = Buffer.from(JSON.stringify(body))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
    res.end(bytes)
  },
}

const CLOUDFLARED_OK = {
  ...WIZARD_STOPS,
  [ROUTES.cfToken]: { body: { ok: true, configured: true } },
  [ROUTES.tunnelCheck]: { body: { ok: true, onCloudflare: true, zoneId: 'z1' } },
  [ROUTES.tunnelSetup]: { body: { ok: true, tunnelId: 't-new', publicUrl: 'https://tea.example.com' } },
  '/_dsh/zen-remote/admin/wizard/status': WIZARD_OFF['/_dsh/zen-remote/admin/wizard/status'],
}

const ONLINE_ROW = {
  entryId: 'e1', displayName: '远端茶壶', serverUrl: 'http://192.168.1.2:3080',
  state: 'online', compat: { different: [] }, pluginBridge: [],
}

// ---- runCli 公共入口 ----------------------------------------------------------

/** 组装 runCli 注入项：真实 stdout 捕获 + 可选 prompter / 各类替身。 */
function runOpts({ home, stdout, prompter, isTty = false, spawnCalls, extra = {} } = {}) {
  return {
    dshHome: home,
    isTty,
    stdout,
    packageVersion: '9.9.9-test',
    ...(prompter === undefined ? {} : { prompter }),
    ...(spawnCalls === undefined ? {} : { spawnCommand: async (command, args) => { spawnCalls.push([command, [...args]]); return 0 } }),
    ...extra,
  }
}

// ===========================================================================
// 验收 1：无参运行、--help、--version、--role peer 拦截
// ===========================================================================

test('main: 无参运行与 --help 输出双语完整命令树返回 0，不进交互向导', async () => {
  const { runCli } = await loadModules()
  // --help/-h 按参数解析的既有设计优先于一切 flag，语言经环境变量给定。
  const zhEnv = { LC_ALL: 'zh_CN.UTF-8' }
  for (const argv of [[], ['--help'], ['-h']]) {
    const out = captureStdout()
    const code = await runCli(argv, runOpts({ stdout: out, extra: { env: zhEnv } }))
    assert.equal(code, 0, `bare run exits 0 (${argv.join(' ')})`)
    assert.match(out.text(), /dsh-zen-remote —— DeepSeek Harness 远程接入命令行/u, 'the zh help title is printed')
    assert.match(out.text(), /setup {2}交互式配置向导/u, 'the setup command is listed')
    assert.match(out.text(), /host device pair/u, 'the host family is listed')
    assert.match(out.text(), /client pair/u, 'the client family is listed')
    assert.match(out.text(), /--yes/u, 'the options block is listed')
  }
  const enOut = captureStdout()
  const en = await runCli(['--help'], runOpts({ stdout: enOut, extra: { env: { LC_ALL: 'en_US.UTF-8' } } }))
  assert.equal(en, 0)
  assert.match(enOut.text(), /Usage: dsh-zen-remote <command>/u)
  assert.match(enOut.text(), /peer is not enabled yet/u)
  assert.doesNotMatch(enOut.text(), /[\u4e00-\u9fff]/u, 'the en help has no Chinese')
})

test('main: --version 输出注入的包版本返回 0', async () => {
  const { runCli } = await loadModules()
  const out = captureStdout()
  const code = await runCli(['--version'], runOpts({ stdout: out }))
  assert.equal(code, 0)
  assert.equal(out.text().trim(), '9.9.9-test')
})

test('main: --role peer 在任何命令上直接拦截退出码 1；非法角色同样拦截', async () => {
  const { runCli } = await loadModules()
  for (const argv of [['--role', 'peer', 'setup'], ['setup', '--role', 'peer'], ['status', '--role', 'peer']]) {
    const out = captureStdout()
    const code = await runCli(['--lang', 'zh', ...argv], runOpts({ stdout: out }))
    assert.equal(code, 1, `peer is refused for ${argv.join(' ')}`)
    assert.match(out.text(), /peer 角色尚未启用/u)
  }
  const bad = captureStdout()
  const badCode = await runCli(['--lang', 'zh', 'setup', '--role', 'wizard'], runOpts({ stdout: bad }))
  assert.equal(badCode, 1)
  assert.match(bad.text(), /未知角色：wizard/u)

  const en = captureStdout()
  await runCli(['--lang', 'en', 'setup', '--role', 'peer'], runOpts({ stdout: en }))
  assert.match(en.text(), /The peer role is not enabled yet/u)
})

test('main: 未知命令与非交互缺必填参数——结构化双语错误退出码 1', async () => {
  const { runCli } = await loadModules()
  const unknown = captureStdout()
  const unknownCode = await runCli(['--lang', 'zh', 'bogus'], runOpts({ stdout: unknown }))
  assert.equal(unknownCode, 1)
  assert.match(unknown.text(), /未知命令：bogus/u)

  const missing = captureStdout()
  const home = makeHome('main-missing')
  let handle
  try {
    const { handle: h } = await startIpcServer(home, { role: 'host', wizard: WIZARD_OFF, admin: ADMIN_OK })
    handle = h
    const missingCode = await runCli(['--lang', 'zh', 'setup', '--yes'], runOpts({ home, stdout: missing }))
    assert.equal(missingCode, 1, 'setup --yes without --role fails fast')
    assert.match(missing.text(), /缺少必填参数 --role/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 2：全新机器首次 setup 全流程（安装 → 拉起 → 选 host → 选 lan → 三灯）
// ===========================================================================

test('setup 全新机器：多选安装 web → open -a 拉起 DSH → 选 host → 选 lan → 三灯全亮 + 二维码 + 摘要', { timeout: 30000 }, async () => {
  const mods = await loadModules()
  const home = makeHome('fresh-full')
  mkdirIn(home, 'profiles', 'work') // 一个没装插件的候选 profile；web 目录不存在也要保底
  const fakeApp = path.join(makeHome('fresh-app'), 'Fake Harness.app')
  fs.mkdirSync(fakeApp, { recursive: true })
  // DSH 实例只在 "open -a" 拉起钩子里才出现（全新机器预检时必须没有存活 socket）。
  const state = { handle: undefined, canned: undefined }
  const startServer = async () => {
    const started = await startIpcServer(home, {
      role: 'host', wizard: { ...WIZARD_OFF, ...VERIFY_PASS }, admin: ADMIN_OK,
    })
    state.handle = started.handle
    state.canned = started.canned
  }
  try {
    const spawnCalls = []
    const prompter = fakePrompter({
      multi: { indices: [0], customNames: [] }, // 安装多选：默认勾选的 web
      selects: [0, 3], // 第 1 步选 host；第 2 步选 lan（无"保持当前"项时第 4 项）
      confirms: [false], // 不顺手生成 desktop-client 配对码
    })
    const out = captureStdout()
    const code = await mods.runCli(['--lang', 'zh', 'setup'], runOpts({
      home, stdout: out, prompter, isTty: true, spawnCalls,
      extra: {
        platform: 'darwin',
        uid: 501,
        macosAppPath: fakeApp,
        pollIntervalMs: 20,
        execProbe: async (command, args) => {
          const key = `${command} ${args.join(' ')}`
          if (key === 'launchctl print gui/501/ai.deepseek.dsh.web') return { code: 1, stdout: '' }
          if (key === `open -a ${fakeApp}`) {
            await sleep(40)
            await startServer()
            return { code: 0, stdout: '' }
          }
          return { code: 127, stdout: '' }
        },
      },
    }))
    assert.equal(code, 0, `the fresh-machine run succeeds (${out.text()})`)

    // 安装：代跑一次 dsh plugin add，目标是默认勾选的 web。
    assert.deepEqual(spawnCalls, [['dsh', ['plugin', '--profile', 'web', 'add', 'dsh-zen-remote']]])
    const multi = prompter.calls.find((c) => c.kind === 'multi')
    assert.ok(multi, 'the install multi-select was asked')
    assert.equal(multi.choices[0], 'web', 'web is synthesized at index 0')
    assert.deepEqual(multi.defaultIndices, [0])
    assert.equal(multi.allowCustomInput, true)

    // 第 1 步角色选择：host/client 两项，当前 host 默认高亮第 1 项。
    const roleSelect = prompter.calls.find((c) => c.kind === 'select' && c.question === mods.createTranslator('zh')('setup.roleQuestion'))
    assert.ok(roleSelect, 'the role question was asked')
    assert.match(roleSelect.choices[0], /host/u)
    assert.match(roleSelect.choices[1], /client/u)
    assert.equal(roleSelect.defaultIndex, 0)

    // 第 2 步接入方式：全新机器没有"保持当前"项，四路 + 推荐漏斗。
    const ingressSelect = prompter.calls.filter((c) => c.kind === 'select').at(-1)
    assert.equal(ingressSelect.choices.length, 5, 'four modes + the recommend funnel')
    assert.equal(ingressSelect.choices.find((label) => label === mods.createTranslator('zh')('setup.ingressKeep')), undefined)

    // 第 3 步三灯 + 二维码 + 配对码。
    const text = out.text()
    assert.match(text, /第 1 盏：本地网关就绪 —— 完成/u)
    assert.match(text, /第 2 盏：公开地址可达 —— 完成/u)
    assert.match(text, /第 3 盏：真实配对完成 —— 完成/u)
    assert.match(text, /█/u, 'a terminal QR is drawn')
    assert.match(text, /http:\/\/10\.0\.0\.5:3088/u, 'the LAN URL is the pairing address')
    assert.match(text, /配对码：WEBPAIR8/u)
    assert.match(text, /配对完成，三灯全亮。/u)
    assert.match(text, /配置完成/u, 'the completion summary is printed')

    // lan 模式的配置写入：0.0.0.0 + ingressMode off + 局域网地址；verify 又持久化一次地址。
    const sets = state.canned.writes.map((w) => w.set)
    assert.ok(sets.some((s) => s.role === 'host' && s.host === '0.0.0.0' && s.ingressMode === 'off' && s.ingressPublicUrl === 'http://10.0.0.5:3088'),
      `the lan config write is present (${JSON.stringify(sets)})`)
    assert.ok(sets.some((s) => s.ingressPublicUrl === 'http://10.0.0.5:3088' && s.role === undefined),
      'the verified URL is persisted after light 3')
    // 角色本就是 host：没有单独的角色切换写入。
    assert.equal(sets.filter((s) => Object.keys(s).length === 1 && s.role === 'host').length, 0)
  } finally {
    if (state.handle !== undefined) await state.handle.close()
    cleanup(home)
    cleanup(path.dirname(fakeApp))
  }
})

// ===========================================================================
// 验收 3：角色切换 setup
// ===========================================================================

test('setup host→client：先停 Caddy/Tunnel 再写 client 配置并轮询就绪，随后配对远端 host 点亮三盏灯', async () => {
  const mods = await loadModules()
  const home = makeHome('switch-to-client')
  const roleRef = { current: 'host' }
  let claimed = false
  const clientRoutes = {
    [ROUTES.clientClaim]: (res, seen) => {
      claimed = true
      const body = { ok: true, entryId: 'e1', ...(seen.body ?? {}) }
      const bytes = Buffer.from(JSON.stringify(body))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
      res.end(bytes)
    },
    [ROUTES.clientStatus]: {
      body: () => ({ ok: true, state: claimed ? 'connected' : 'unpaired', maxServers: 8, servers: claimed ? [ONLINE_ROW] : [] }),
    },
  }
  const { handle, canned } = await startIpcServer(home, {
    getRole: () => roleRef.current,
    flipRole: (role) => { roleRef.current = role },
    wizard: { ...WIZARD_CADDY_CONFIGURED, ...VERIFY_PASS },
    admin: ADMIN_OK,
    client: clientRoutes,
  })
  try {
    const prompter = fakePrompter({
      inputs: ['http://192.168.1.2:3080', 'ABCD2345'], // 配对地址 + 8 位码
      confirms: [false], // 不继续添加下一台
    })
    const out = captureStdout()
    const code = await mods.runCli(['--lang', 'zh', 'setup', '--role', 'client'], runOpts({
      home, stdout: out, prompter, isTty: true, pollIntervalMs: 20,
    }))
    assert.equal(code, 0, `the host→client switch run succeeds (${out.text()})`)

    // 顺序：停 Caddy、停 Tunnel 都发生在写入 role: client 之前。
    const stopCaddyAt = canned.requests.findIndex((r) => r.path === ROUTES.caddyStop)
    const stopTunnelAt = canned.requests.findIndex((r) => r.path === ROUTES.tunnelStop)
    const roleWrite = canned.writes.find((w) => w.set?.role === 'client')
    assert.ok(roleWrite, 'role: client is written')
    assert.ok(stopCaddyAt !== -1 && stopTunnelAt !== -1, 'both managed processes are stopped')
    assert.ok(stopCaddyAt < roleWrite.seq && stopTunnelAt < roleWrite.seq, 'the stops precede the config write')

    // 配对流程走完，claim 请求体正确，三盏客户端状态灯点亮。
    const claim = canned.requests.find((r) => r.path === ROUTES.clientClaim)
    assert.deepEqual(claim.body, { serverUrl: 'http://192.168.1.2:3080', code: 'ABCD2345' })
    const text = out.text()
    assert.match(text, /切换到 client：先停掉托管的 Caddy \/ Cloudflare 隧道/u)
    assert.match(text, /本地配对凭证 ✓ —— 完成/u)
    assert.match(text, /host 连接 ✓ —— 在线/u)
    assert.match(text, /会话与插件同步 ✓ —— 在线/u)
    assert.match(text, /对端 host：远端茶壶/u)
    assert.match(text, /配置完成/u)
  } finally {
    await handle.close()
    cleanup(home)
  }
})

test('setup client→host：--yes 非交互写 role host 并等待网关就绪，lan 接入 + --no-wait 验证全自动跑通', async () => {
  const mods = await loadModules()
  const home = makeHome('switch-to-host')
  const roleRef = { current: 'client' }
  const { handle, canned } = await startIpcServer(home, {
    getRole: () => roleRef.current,
    flipRole: (role) => { roleRef.current = role },
    wizard: { ...WIZARD_OFF, ...VERIFY_PASS },
    admin: ADMIN_OK,
  })
  try {
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'host', '--ingress', 'lan', '--no-wait', '--yes'],
      runOpts({ home, stdout: out, pollIntervalMs: 20 }),
    )
    assert.equal(code, 0, `the client→host switch run succeeds (${out.text()})`)
    const roleWrite = canned.writes.find((w) => w.set?.role === 'host')
    assert.ok(roleWrite, 'role: host is written')
    assert.ok(canned.writes.some((w) => w.set?.host === '0.0.0.0' && w.set?.ingressMode === 'off'), 'the lan rebind follows')
    const text = out.text()
    assert.match(text, /切换到 host：写入配置并等待网关就绪/u)
    assert.match(text, /第 1 盏：本地网关就绪 —— 完成/u)
    assert.match(text, /第 2 盏：公开地址可达 —— 完成/u)
    assert.match(text, /已跳过手机配对等待/u, '--no-wait skips light 3')
    assert.match(text, /配置完成/u)
  } finally {
    await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 4：已配好 host 再次运行 setup —— 默认"保持当前接入配置"
// ===========================================================================

test('setup 已配好 host：第 2 步第 0 项默认"保持当前接入配置"，选中后直达验证，不碰托管进程', async () => {
  const mods = await loadModules()
  const home = makeHome('keep-config')
  const { handle, canned } = await startIpcServer(home, {
    role: 'host',
    wizard: { ...WIZARD_CADDY_CONFIGURED, ...VERIFY_PASS },
    admin: ADMIN_OK,
  })
  try {
    const prompter = fakePrompter({
      selects: [0, 0], // 第 1 步选 host（默认）；第 2 步选"保持当前接入配置"（默认）
      confirms: [false], // 不生成 desktop 配对码
    })
    const out = captureStdout()
    const code = await mods.runCli(['--lang', 'zh', 'setup'], runOpts({
      home, stdout: out, prompter, isTty: true, pollIntervalMs: 20,
    }))
    assert.equal(code, 0, `the keep-config run succeeds (${out.text()})`)

    const keepLabel = mods.createTranslator('zh')('setup.ingressKeep')
    const ingressSelect = prompter.calls.filter((c) => c.kind === 'select').at(-1)
    assert.equal(ingressSelect.choices[0], keepLabel, 'keep is the first choice')
    assert.equal(ingressSelect.defaultIndex, 0, 'keep is the default')
    assert.equal(ingressSelect.choices.length, 6, 'keep + four modes + recommend funnel')

    // 保持路径：没有任何托管进程启停，没有接入模式写入。
    assert.equal(canned.requests.some((r) => r.path === ROUTES.caddyStop || r.path === ROUTES.tunnelStop), false)
    assert.deepEqual(canned.writes.map((w) => w.set), [{ ingressPublicUrl: 'https://tea.example.com' }],
      'only the verify persistence write happens')

    const text = out.text()
    assert.match(text, /验证公开地址 https:\/\/tea\.example\.com/u)
    assert.match(text, /第 3 盏：真实配对完成 —— 完成/u)
    assert.match(text, /配对完成，三灯全亮。/u)
  } finally {
    await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 4b：推荐漏斗（两个问题 → cloudflared）
// ===========================================================================

test('setup 推荐漏斗：无公网 IP + 域名在 Cloudflare → 推荐 cloudflared 并按其流程配置', async () => {
  const mods = await loadModules()
  const home = makeHome('funnel')
  const { handle, canned } = await startIpcServer(home, {
    role: 'host',
    wizard: { ...CLOUDFLARED_OK, ...VERIFY_PASS },
    admin: ADMIN_OK,
  })
  try {
    const prompter = fakePrompter({
      selects: [4], // 四路之后的推荐漏斗项
      confirms: [false, true, false], // 无公网 IP；域名在 Cloudflare；不生成 desktop 码
      inputs: ['tea.example.com', 'CF-TOKEN-9'], // 域名 + API 令牌（未存过时必问）
    })
    const out = captureStdout()
    const code = await mods.runCli(['--lang', 'zh', 'setup', '--role', 'host', '--no-wait'], runOpts({
      home, stdout: out, prompter, isTty: true, pollIntervalMs: 20,
    }))
    assert.equal(code, 0, `the funnel run succeeds (${out.text()})`)
    assert.match(out.text(), /根据回答推荐：cloudflared/u)
    assert.ok(canned.writes.some((w) => w.set?.ingressMode === 'cloudflared' && w.set?.host === '127.0.0.1'),
      'the cloudflared config is written')
    assert.ok(canned.requests.some((r) => r.path === ROUTES.tunnelCheck && r.body?.domain === 'tea.example.com'))
    assert.ok(canned.requests.some((r) => r.path === ROUTES.tunnelSetup))
  } finally {
    await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 4c：验证失败时的交互重试
// ===========================================================================

test('setup 验证失败：交互可选重试验证，第二次通过后正常收尾', async () => {
  const mods = await loadModules()
  const home = makeHome('verify-retry')
  let posts = 0
  const verifyFlaky = {
    [ROUTES.verify]: (res, seen) => {
      let body
      if (seen.method === 'POST') {
        posts += 1
        body = posts === 1
          ? { ok: false, reason: 'probe-failed', detail: { kind: 'reached', root: 'gateway-pairing-page', admin: 'gateway-200' } }
          : { ok: true, pairingCode: 'WEBPAIR8', publicUrl: 'https://tea.example.com', expiresAt: Date.now() + 600_000 }
      } else {
        body = { result: 'pass' }
      }
      const bytes = Buffer.from(JSON.stringify(body))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
      res.end(bytes)
    },
  }
  const { handle, canned } = await startIpcServer(home, {
    role: 'host',
    wizard: {
      ...WIZARD_CADDY_CONFIGURED,
      [ROUTES.cfToken]: { body: { ok: true, configured: true } },
      [ROUTES.caddyStart]: { body: { ok: true } },
      ...verifyFlaky,
    },
    admin: ADMIN_OK,
  })
  try {
    const prompter = fakePrompter({
      selects: [0], // 重试验证
      confirms: [false],
    })
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'host', '--mode', 'caddy', '--domain', 'tea.example.com', '--cf-token', 'TOK', '--no-wait'],
      runOpts({ home, stdout: out, prompter, isTty: true, pollIntervalMs: 20 }),
    )
    assert.equal(code, 0, `the retry run succeeds (${out.text()})`)
    assert.match(out.text(), /第 2 盏：公开地址可达 —— 未通过/u, 'the first attempt records a failed light 2')
    const retrySelect = prompter.calls.find((c) => c.kind === 'select')
    assert.match(retrySelect.choices[0], /重试验证/u)
    assert.match(retrySelect.choices[1], /保留配置退出/u)
    assert.equal(posts, 2, 'the verification ran twice')
    assert.match(out.text(), /配对码：WEBPAIR8/u, 'the second attempt mints the code')
    void canned
  } finally {
    await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 5：参数化非交互模式（--yes 全自动零提问；缺参立即报错）
// ===========================================================================

test('setup --yes 参数化：host + lan 与 client + host-url/code 两条全自动路径零提问跑通', async () => {
  const mods = await loadModules()

  // (a) host 侧。
  const hostHome = makeHome('param-host')
  const host1 = await startIpcServer(hostHome, { role: 'host', wizard: { ...WIZARD_OFF, ...VERIFY_PASS }, admin: ADMIN_OK })
  try {
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'host', '--ingress', 'lan', '--no-wait', '--yes'],
      runOpts({ home: hostHome, stdout: out, pollIntervalMs: 20 }),
    )
    assert.equal(code, 0, `the parametric host run succeeds (${out.text()})`)
    assert.ok(host1.canned.writes.some((w) => w.set?.role === 'host' && w.set?.host === '0.0.0.0'))
    assert.match(out.text(), /配置完成/u)
  } finally {
    await host1.handle.close()
    cleanup(hostHome)
  }

  // (b) client 侧：--host-url + --code 直接执行配对。
  const clientHome = makeHome('param-client')
  let claimed = false
  const client2 = await startIpcServer(clientHome, {
    role: 'client',
    client: {
      [ROUTES.clientClaim]: (res) => {
        claimed = true
        const bytes = Buffer.from(JSON.stringify({ ok: true, entryId: 'e1' }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
      [ROUTES.clientStatus]: { body: () => ({ ok: true, state: claimed ? 'connected' : 'unpaired', maxServers: 8, servers: claimed ? [ONLINE_ROW] : [] }) },
    },
    wizard: WIZARD_OFF,
    admin: ADMIN_OK,
  })
  try {
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'client', '--host-url', 'http://192.168.1.2:3088', '--code', '12345678', '--yes'],
      runOpts({ home: clientHome, stdout: out, pollIntervalMs: 20 }),
    )
    assert.equal(code, 0, `the parametric client run succeeds (${out.text()})`)
    const claim = client2.canned.requests.find((r) => r.path === ROUTES.clientClaim)
    assert.deepEqual(claim.body, { serverUrl: 'http://192.168.1.2:3088', code: '12345678' })
    assert.match(out.text(), /host 连接 ✓ —— 在线/u)
    assert.match(out.text(), /配置完成/u)
  } finally {
    await client2.handle.close()
    cleanup(clientHome)
  }
})

test('setup --yes 缺必填参数：缺 role / 缺 host-url / 缺 domain 都立即报错退出码 1', async () => {
  const mods = await loadModules()
  const home = makeHome('param-missing')
  const clientHome = makeHome('param-missing-client')
  const host1 = await startIpcServer(home, { role: 'host', wizard: WIZARD_OFF, admin: ADMIN_OK })
  const client1 = await startIpcServer(clientHome, { role: 'client', wizard: WIZARD_OFF, admin: ADMIN_OK })
  try {
    const noRole = captureStdout()
    assert.equal(await mods.runCli(['--lang', 'zh', 'setup', '--yes'], runOpts({ home, stdout: noRole })), 1)
    assert.match(noRole.text(), /缺少必填参数 --role/u)

    const noUrl = captureStdout()
    assert.equal(await mods.runCli(['--lang', 'zh', 'setup', '--role', 'client', '--yes'], runOpts({ home: clientHome, stdout: noUrl })), 1)
    assert.match(noUrl.text(), /缺少必填参数 --host-url/u)

    const noDomain = captureStdout()
    assert.equal(await mods.runCli(['--lang', 'zh', 'setup', '--role', 'host', '--ingress', 'caddy', '--yes'], runOpts({ home, stdout: noDomain })), 1)
    assert.match(noDomain.text(), /缺少必填参数 --domain/u)
  } finally {
    await host1.handle.close()
    await client1.handle.close()
    cleanup(home)
    cleanup(clientHome)
  }
})

// ===========================================================================
// 验收 5b：client 多台管理菜单（N>0 菜单 / 满 8 台置顶重配 / 继续添加）
// ===========================================================================

test('setup client 菜单：已配 1 台时列出菜单并可选移除后完成退出', async () => {
  const mods = await loadModules()
  const home = makeHome('client-menu')
  const { handle, canned } = await startIpcServer(home, {
    role: 'client',
    client: {
      [ROUTES.clientStatus]: {
        body: () => ({ ok: true, state: 'connected', maxServers: 8, servers: canned.requests.filter((r) => r.path === ROUTES.clientUnpair).length === 0 ? [ONLINE_ROW] : [] }),
      },
      [ROUTES.clientUnpair]: { body: { ok: true, removed: 1 } },
    },
    wizard: WIZARD_OFF,
    admin: ADMIN_OK,
  })
  try {
    const prompter = fakePrompter({
      selects: [2, 0, 1], // 菜单选"移除"；unpair 自己的选择题选第 0 行；移除后空池菜单选"完成退出"
      confirms: [false],
    })
    const out = captureStdout()
    const code = await mods.runCli(['--lang', 'zh', 'setup', '--role', 'client'], runOpts({
      home, stdout: out, prompter, isTty: true, pollIntervalMs: 20,
    }))
    assert.equal(code, 0, `the client menu run succeeds (${out.text()})`)
    const menuSelect = prompter.calls.find((c) => c.kind === 'select' && c.choices.length === 4)
    assert.ok(menuSelect, 'the 4-item menu was shown')
    assert.match(menuSelect.choices[0], /新增配对一台 host/u)
    assert.match(menuSelect.choices[3], /完成退出/u)
    // 移除后空池：菜单退化为 [新增, 完成]，退出是用户显式选择。
    const emptyMenu = prompter.calls.find((c) => c.kind === 'select' && c.choices.length === 2)
    assert.ok(emptyMenu, 'the emptied pool shows the add/done menu')
    assert.match(emptyMenu.choices[0], /新增配对一台 host/u)
    assert.match(emptyMenu.choices[1], /完成退出/u)
    const unpair = canned.requests.find((r) => r.path === ROUTES.clientUnpair)
    assert.ok(unpair, 'the unpair route was driven')
    assert.match(out.text(), /已移除 远端茶壶。/u)
    assert.match(out.text(), /远端茶壶/u, 'the paired list prints the display name')
    assert.match(out.text(), /配置完成/u)
  } finally {
    await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// CLI-5-fix 1：真实 SIGINT 接线（process.emit 触发，无监听泄漏）
// ===========================================================================

test('setup 验证等待响应真实 SIGINT：process.emit 跳过第 3 盏灯等待退出码 0，结束后无监听泄漏', { timeout: 20000 }, async () => {
  const mods = await loadModules()
  const home = makeHome('sigint-skip')
  let gets = 0
  const verifyPending = {
    [ROUTES.verify]: (res, seen) => {
      let body
      if (seen.method === 'POST') {
        body = { ok: true, pairingCode: 'WEBPAIR8', publicUrl: 'https://tea.example.com', expiresAt: Date.now() + 600_000 }
      } else {
        gets += 1
        if (gets === 1) process.emit('SIGINT') // 用户在等待期间按下 Ctrl-C
        // 兜底：接线缺失（红）时 emit 不会中止等待，第 7 次起回 expired
        // 让 runCli 走到头，测试以断言失败告终而不是挂死整个测试进程。
        body = gets >= 7 ? { result: 'code-expired' } : { result: 'pending' }
      }
      const bytes = Buffer.from(JSON.stringify(body))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
      res.end(bytes)
    },
  }
  const { handle } = await startIpcServer(home, {
    role: 'host',
    wizard: { ...WIZARD_CADDY_CONFIGURED, ...verifyPending },
    admin: ADMIN_OK,
  })
  // 守卫监听：保证 emit 永远不触发"无监听者即默认退出"的信号行为，
  // 缺接线时测试进程也活得好好的，由断言给出干净的失败。
  const guardian = () => {}
  process.on('SIGINT', guardian)
  try {
    const out = captureStdout()
    const listenersBefore = process.listenerCount('SIGINT')
    // 不注入 deps.abortSignal——真实 SIGINT 接线必须由 runCli 自己建立。
    const code = await mods.runCli(['--lang', 'zh', 'setup', '--role', 'host'], runOpts({ home, stdout: out, pollIntervalMs: 20 }))
    assert.equal(code, 0, `the SIGINT skip is a graceful success (${out.text()})`)
    assert.equal(gets, 1, 'the wait stopped at the first poll')
    const text = out.text()
    assert.match(text, /第 1 盏：本地网关就绪 —— 完成/u)
    assert.match(text, /第 2 盏：公开地址可达 —— 完成/u)
    assert.match(text, /已跳过手机配对等待/u, 'the wait was skipped by SIGINT')
    assert.doesNotMatch(text, /配对完成，三灯全亮/u, 'light 3 was never lit')
    assert.match(text, /配置完成/u, 'the summary still prints after the skip')
    assert.equal(process.listenerCount('SIGINT'), listenersBefore, 'the SIGINT listener is removed after the run')
  } finally {
    process.removeListener('SIGINT', guardian)
    await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// CLI-5-fix 2：setup 位置参数 hostUrl
// ===========================================================================

test('setup 位置参数 hostUrl：setup <hostUrl> --code … --yes 与 --host-url 等价', async () => {
  const mods = await loadModules()
  const home = makeHome('positional-url')
  let claimed = false
  const client = await startIpcServer(home, {
    role: 'client',
    client: {
      [ROUTES.clientClaim]: (res) => {
        claimed = true
        const bytes = Buffer.from(JSON.stringify({ ok: true, entryId: 'e1' }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
      [ROUTES.clientStatus]: { body: () => ({ ok: true, state: claimed ? 'connected' : 'unpaired', maxServers: 8, servers: claimed ? [ONLINE_ROW] : [] }) },
    },
    wizard: WIZARD_OFF,
    admin: ADMIN_OK,
  })
  try {
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'client', 'http://192.168.1.2:3080', '--code', '12345678', '--yes'],
      runOpts({ home, stdout: out, pollIntervalMs: 20 }),
    )
    assert.equal(code, 0, `the positional hostUrl run succeeds (${out.text()})`)
    const claim = client.canned.requests.find((r) => r.path === ROUTES.clientClaim)
    assert.deepEqual(claim.body, { serverUrl: 'http://192.168.1.2:3080', code: '12345678' })
    assert.match(out.text(), /host 连接 ✓ —— 在线/u)
    assert.match(out.text(), /配置完成/u)
  } finally {
    await client.handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// CLI-5-fix 3：preflight 把 preferredProfile 透传给 ensureDshRunning
// ===========================================================================

test('setup 预检：安装时选中的 preferredProfile 透传——无守护时手动指引点名所选 profile 而非缺省 web', { timeout: 20000 }, async () => {
  const mods = await loadModules()
  const home = makeHome('preferred-profile')
  mkdirIn(home, 'profiles', 'work')
  const emptyUnitDir = path.join(makeHome('preferred-units'), 'empty')
  fs.mkdirSync(emptyUnitDir, { recursive: true })
  try {
    const spawnCalls = []
    const prompter = fakePrompter({ multi: { indices: [1], customNames: [] } }) // 不选默认的 web，改选 work
    const out = captureStdout()
    const code = await mods.runCli(['--lang', 'zh', 'setup', '--role', 'host'], runOpts({
      home, stdout: out, prompter, isTty: true, spawnCalls,
      extra: {
        platform: 'linux',
        pollIntervalMs: 20,
        systemUnitDir: emptyUnitDir,
        execProbe: async () => ({ code: 1, stdout: '' }), // 无 systemd 用户单元 → 无守护可拉起
      },
    }))
    assert.equal(code, 1, 'no-daemon is a failure')
    assert.deepEqual(spawnCalls, [['dsh', ['plugin', '--profile', 'work', 'add', 'dsh-zen-remote']]])
    assert.match(out.text(), /dsh --profile work web/u, 'the manual guidance names the CHOSEN profile, not the web default')
  } finally {
    cleanup(home)
    cleanup(path.dirname(emptyUnitDir))
  }
})

// ===========================================================================
// 验收 6：真实子进程跑 bin/zen-remote.mjs
// ===========================================================================

function execNode(args, env, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BIN_PATH, ...args], { cwd: ROOT, env, timeout: timeoutMs }, (error, stdout, stderr) => {
      // error 是 null 表示正常退出；有 code（含非零）是可解析的退出，其余才是 spawn 失败。
      if (error && error.code === undefined) { reject(error); return }
      resolve({ code: error ? Number(error.code) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

test('bin: 真实子进程 node bin/zen-remote.mjs --help 与 --version 返回 0', { timeout: 30000 }, async () => {
  assert.equal(fs.existsSync(BIN_PATH), true, 'bin/zen-remote.mjs exists')
  const mode = fs.statSync(BIN_PATH).mode & 0o777
  assert.ok((mode & 0o111) !== 0, `the bin entry is executable (mode ${mode.toString(8)})`)

  const help = await execNode(['--help'], { ...process.env, LC_ALL: 'zh_CN.UTF-8' })
  assert.equal(help.code, 0, `--help exits 0 (stderr: ${help.stderr})`)
  assert.match(help.stdout, /dsh-zen-remote/u)
  assert.match(help.stdout, /setup/u)

  const version = await execNode(['--version'], process.env)
  assert.equal(version.code, 0, `--version exits 0 (stderr: ${version.stderr})`)
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/u, 'the package version is printed')
})

test('bin: 真实子进程 node bin/zen-remote.mjs status --json 连真实临时 IPC socket 返回 0', { timeout: 30000 }, async () => {
  const mods = await loadModules()
  const home = makeHome('bin-status')
  let handle
  try {
    const { handle: h } = await startIpcServer(home, { role: 'host', serverName: '茶壶机' })
    handle = h
    const result = await execNode(['status', '--json'], { ...process.env, DSH_HOME: home })
    assert.equal(result.code, 0, `status --json exits 0 (stderr: ${result.stderr})`)
    const jsonStart = result.stdout.indexOf('{')
    assert.ok(jsonStart !== -1, `the JSON body is present (${result.stdout})`)
    const parsed = JSON.parse(result.stdout.slice(jsonStart))
    assert.equal(parsed.role, 'host')
    assert.equal(parsed.serverName, '茶壶机')
    assert.equal(parsed.pid, process.pid, 'the IPC server lives in this test process')
    assert.equal(parsed.pluginVersion, '9.9.9-test')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})
