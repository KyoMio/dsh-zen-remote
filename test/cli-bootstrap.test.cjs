/* dsh-zen-remote · CLI-2: CLI 底座（args / i18n / qr-terminal / ipc-client / bootstrap）
 *
 * 驱动 BUILT lib/cli/*.js（与 cli-ipc.test.cjs 同理：src 相对导入在 Node
 * strip-only 模式下映射不了）。测试接缝三（SPEC）：交互问答、插件安装与守护
 * 拉起全部走注入的 fake prompter / spawnCommand / execProbe，socket 发现与
 * 连通走真实 Unix socket（其他平台分支用 platform 注入覆盖），断言命令解析
 * 结果、返回结构与打印出来的指引，不断言内部调用顺序。
 *
 * macOS 的 Unix socket 路径上限约 104 字节，临时目录继续用 /tmp 短前缀。
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { pathToFileURL } = require('node:url')

const ARGS_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'args.js')).href
const I18N_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'i18n.js')).href
const QR_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'qr-terminal.js')).href
const IPC_CLIENT_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'ipc-client.js')).href
const BOOTSTRAP_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'bootstrap.js')).href
const IPC_SERVER_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'ipc-server.js')).href
const CLIENT_ROUTES_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'client-routes.js')).href
const RELAY_POOL_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'relay-pool.js')).href
const WRITER_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'config-writer.js')).href

const IS_WIN = process.platform === 'win32'

function makeHome(tag) {
  return fs.mkdtempSync(path.join('/tmp', `dshzr2-${tag}-`))
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
}

function mkdirIn(home, ...parts) {
  const dir = path.join(home, ...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeProfilePackage(home, profile, packageJson) {
  const dir = mkdirIn(home, 'profiles', profile)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson))
}

/** 真实 IPC server + 最小 ping delegate（discovery 只打 ping）；可挂真实
 * clientHandler（status 测试用，与 cli-ipc.test.cjs 同一接缝）。 */
async function startIpcServer(home, overrides = {}) {
  const ipc = await import(IPC_SERVER_URL)
  const delegate = {
    role: () => overrides.role ?? 'host',
    serverName: () => overrides.serverName ?? 'test-host',
    profileName: () => overrides.profileName,
    pluginVersion: () => '9.9.9-test',
    writeConfig: overrides.writeConfig ?? (() => ({ ok: true, values: {} })),
    ...(overrides.clientHandler === undefined ? {} : { clientHandler: overrides.clientHandler }),
  }
  return ipc.createCliIpcServer({ dshHome: home, delegate })
}

/** 在指定 socket 路径上起一个应答任意 ping 体（版本不对）的裸 http server。 */
async function startFakePingServer(socketPath, pingBody) {
  const server = http.createServer((req, res) => {
    const bytes = Buffer.from(JSON.stringify(pingBody))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
    res.end(bytes)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  return server
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** execProbe 录妆替身：key 是 `command arg1 arg2`，缺 map 时回 127。 */
function execProbeRecorder(map = {}, hooks = {}) {
  const calls = []
  const probe = async (command, args) => {
    calls.push([command, [...args]])
    const hook = hooks[`${command} ${args.join(' ')}`]
    if (hook !== undefined) await hook()
    const handler = map[`${command} ${args.join(' ')}`]
    if (handler !== undefined) return handler(args)
    return { code: 127, stdout: '' }
  }
  return { calls, probe }
}

function captureStdout() {
  const lines = []
  return { lines, write: (text) => lines.push(text), text: () => lines.join('') }
}

// ===========================================================================
// 验收 1：args.ts 参数解析
// ===========================================================================

test('args: 命令路由全表——help/version/未知命令/host·client 子命令族与 target', async () => {
  const { parseCliArgs } = await import(ARGS_URL)
  const cases = [
    { argv: [], command: 'help' },
    { argv: ['--help'], command: 'help' },
    { argv: ['-h'], command: 'help' },
    { argv: ['--version'], command: 'version' },
    { argv: ['-v'], command: 'version' },
    { argv: ['bogus'], command: 'unknown', unknownCommand: 'bogus' },
    { argv: ['host'], command: 'unknown', unknownCommand: 'host' },
    { argv: ['host', 'device'], command: 'unknown', unknownCommand: 'host device' },
    { argv: ['host', 'device', 'nope'], command: 'unknown', unknownCommand: 'host device nope' },
    { argv: ['host', 'ingress'], command: 'unknown', unknownCommand: 'host ingress' },
    { argv: ['host', 'ingress', 'nope'], command: 'unknown', unknownCommand: 'host ingress nope' },
    { argv: ['client', 'wat'], command: 'unknown', unknownCommand: 'client wat' },
    { argv: ['setup'], command: 'setup' },
    { argv: ['setup', 'http://10.0.0.2:3080'], command: 'setup', target: 'http://10.0.0.2:3080' },
    { argv: ['status'], command: 'status' },
    { argv: ['host', 'device', 'pair'], command: 'host.device.pair' },
    { argv: ['host', 'device', 'list'], command: 'host.device.list' },
    { argv: ['host', 'device', 'revoke', 'dev-7'], command: 'host.device.revoke', target: 'dev-7' },
    { argv: ['host', 'device', 'revoke', '--all'], command: 'host.device.revoke', all: true },
    { argv: ['host', 'ingress', 'start'], command: 'host.ingress.start' },
    { argv: ['host', 'ingress', 'stop'], command: 'host.ingress.stop' },
    { argv: ['host', 'ingress', 'verify'], command: 'host.ingress.verify' },
    { argv: ['host', 'ingress', 'snippet'], command: 'host.ingress.snippet' },
    { argv: ['client', 'pair', 'http://10.0.0.2:3080'], command: 'client.pair', target: 'http://10.0.0.2:3080' },
    { argv: ['client', 'unpair'], command: 'client.unpair' },
    { argv: ['client', 'unpair', 'srv-1'], command: 'client.unpair', target: 'srv-1' },
    { argv: ['client', 'list'], command: 'client.list' },
  ]
  for (const c of cases) {
    const parsed = parseCliArgs(c.argv)
    assert.equal(parsed.command, c.command, `command of ${JSON.stringify(c.argv)}`)
    if (c.unknownCommand !== undefined) assert.equal(parsed.unknownCommand, c.unknownCommand, `unknownCommand of ${JSON.stringify(c.argv)}`)
    if (c.target !== undefined) assert.equal(parsed.target, c.target, `target of ${JSON.stringify(c.argv)}`)
    if (c.all === true) assert.equal(parsed.options.all, true, `--all of ${JSON.stringify(c.argv)}`)
  }
  // 不带 target 的命令 target 为 undefined。
  assert.equal(parseCliArgs(['client', 'unpair']).target, undefined)
  assert.equal(parseCliArgs(['client', 'list']).target, undefined)
})

test('args: 全局参数默认值与显式值；全局 flag 可放在命令之前', async () => {
  const { parseCliArgs } = await import(ARGS_URL)
  const base = parseCliArgs(['status']).options
  assert.equal(base.json, false)
  assert.equal(base.yes, false)
  assert.equal(base.noWait, false)
  assert.equal(base.all, false)
  assert.equal(base.debug, false)
  assert.equal(base.debugPath, undefined)
  assert.equal(base.wait, 20, '--wait defaults to 20')
  assert.equal(base.lang, undefined)
  assert.equal(base.socket, undefined)

  const full = parseCliArgs(['--lang', 'en', '--json', '--socket', '/tmp/x.sock', '--wait', '5', '-y', '--no-wait', 'status'])
  assert.equal(full.command, 'status')
  assert.equal(full.options.lang, 'en')
  assert.equal(full.options.json, true)
  assert.equal(full.options.socket, '/tmp/x.sock')
  assert.equal(full.options.wait, 5)
  assert.equal(full.options.yes, true)
  assert.equal(full.options.noWait, true)

  // 缺值 / 非法值的 --wait 退回默认 20；未知 flag 被记录不炸。
  assert.equal(parseCliArgs(['status', '--wait']).options.wait, 20)
  assert.equal(parseCliArgs(['status', '--wait', 'abc']).options.wait, 20)
  const unknownFlag = parseCliArgs(['status', '--wat', '--json'])
  assert.equal(unknownFlag.command, 'status')
  assert.deepEqual(unknownFlag.options.unknownFlags, ['--wat'])
  assert.equal(unknownFlag.options.json, true)
})

test('args: setup 的全套参数与 --role peer / 非法角色识别', async () => {
  const { parseCliArgs } = await import(ARGS_URL)
  const argv = ['setup',
    '--role', 'host',
    '--profile', 'work, web',
    '--ingress', 'caddy',
    '--domain', 'tea.example.com',
    '--cf-token', 'tok',
    '--email', 'tea@example.com',
    '--https-port', '8443',
    '--public-url', 'https://tea.example.com',
    '--tunnel-id', 'tunnel-1',
    '--proxy', 'lucky',
    '--device-role', 'desktop-client',
    '--host-url', 'http://10.0.0.2:3080',
    '--code', 'ABCD2345',
    '--name', '茶壶机',
    '--all',
  ]
  const o = parseCliArgs(argv).options
  assert.equal(o.role, 'host')
  assert.equal(o.roleIssue, undefined)
  assert.deepEqual(o.profile, ['work', 'web'], '--profile splits on commas and trims')
  assert.equal(o.ingress, 'caddy')
  assert.equal(o.domain, 'tea.example.com')
  assert.equal(o.cfToken, 'tok')
  assert.equal(o.email, 'tea@example.com')
  assert.equal(o.httpsPort, 8443, '--https-port parses a number')
  assert.equal(o.publicUrl, 'https://tea.example.com')
  assert.equal(o.tunnelId, 'tunnel-1')
  assert.equal(o.proxy, 'lucky')
  assert.equal(o.deviceRole, 'desktop-client')
  assert.equal(o.hostUrl, 'http://10.0.0.2:3080')
  assert.equal(o.code, 'ABCD2345')
  assert.equal(o.name, '茶壶机')
  assert.equal(o.all, true)

  // --mode 与 --ingress 同义。
  assert.equal(parseCliArgs(['setup', '--mode', 'lan']).options.mode, 'lan')

  // peer：PG-10 起正式启用——合法角色不再标记 issue；非法值标记 invalid。
  const peer = parseCliArgs(['setup', '--role', 'peer'])
  assert.equal(peer.options.role, 'peer', 'the raw value survives')
  assert.equal(peer.options.roleIssue, undefined, 'peer is an accepted role since PG-10')
  const bad = parseCliArgs(['setup', '--role', 'wizard'])
  assert.equal(bad.options.role, 'wizard')
  assert.equal(bad.options.roleIssue, 'invalid')
  assert.equal(parseCliArgs(['setup', '--role', 'client']).options.roleIssue, undefined)

  // --https-port 非法值 → undefined。
  assert.equal(parseCliArgs(['setup', '--https-port', 'x']).options.httpsPort, undefined)
})

test('args: status 的 --debug 形态——带路径 / 纯开关 / 后跟 flag', async () => {
  const { parseCliArgs } = await import(ARGS_URL)
  const withPath = parseCliArgs(['status', '--debug', '/tmp/out.json'])
  assert.equal(withPath.options.debug, false, 'a path argument means a custom path, not the bare flag')
  assert.equal(withPath.options.debugPath, '/tmp/out.json')

  const bare = parseCliArgs(['status', '--debug'])
  assert.equal(bare.options.debug, true, 'bare --debug means the default filename')
  assert.equal(bare.options.debugPath, undefined)

  const followedByFlag = parseCliArgs(['status', '--debug', '--json'])
  assert.equal(followedByFlag.options.debug, true)
  assert.equal(followedByFlag.options.debugPath, undefined)
  assert.equal(followedByFlag.options.json, true, 'the following flag is still parsed as an option')
})

// ===========================================================================
// 验收 2：i18n.ts 语言解析与双语词典
// ===========================================================================

test('i18n: resolveCliLang 按 --lang > ZEN_REMOTE_LANG > LC_ALL/LC_MESSAGES/LANG 解析', async () => {
  const { resolveCliLang } = await import(I18N_URL)
  assert.equal(resolveCliLang('zh', {}), 'zh')
  assert.equal(resolveCliLang('en', { ZEN_REMOTE_LANG: 'zh' }), 'en', 'the flag wins over the env')
  assert.equal(resolveCliLang('auto', { ZEN_REMOTE_LANG: 'zh' }), 'zh', 'auto falls through to the env')
  assert.equal(resolveCliLang(undefined, { ZEN_REMOTE_LANG: 'zh' }), 'zh')
  assert.equal(resolveCliLang(undefined, { ZEN_REMOTE_LANG: 'en' }), 'en')
  assert.equal(resolveCliLang(undefined, { ZEN_REMOTE_LANG: 'zh', LANG: 'en_US.UTF-8' }), 'zh', 'ZEN_REMOTE_LANG wins over the locale')
  assert.equal(resolveCliLang(undefined, { LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveCliLang(undefined, { LC_ALL: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveCliLang(undefined, { LC_MESSAGES: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveCliLang(undefined, { LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'zh_CN', LANG: 'zh_CN' }), 'en', 'LC_ALL wins')
  assert.equal(resolveCliLang(undefined, { LC_MESSAGES: 'zh_CN', LANG: 'en' }), 'zh', 'LC_MESSAGES wins over LANG')
  assert.equal(resolveCliLang(undefined, { LANG: 'C' }), 'en', 'LANG=C is en')
  assert.equal(resolveCliLang(undefined, { LANG: 'POSIX' }), 'en')
  assert.equal(resolveCliLang(undefined, { LANG: '' }), 'en')
  assert.equal(resolveCliLang(undefined, {}), 'en', 'no hints at all is en')
})

test('i18n: createTranslator 双语输出、参数插值、缺键回退，且文案不含 server/both 混入词', async () => {
  const { createTranslator } = await import(I18N_URL)
  const zh = createTranslator('zh')
  const en = createTranslator('en')

  for (const [name, t] of [['zh', zh], ['en', en]]) {
    const peer = t('err.roleGate.peerCommands')
    assert.notEqual(peer, 'err.roleGate.peerCommands', `${name} dictionary covers the peer gate`)
    assert.match(peer, /peer/u, `${name} peer message names the role`)
    const shadowed = t('err.envShadowed', { envVar: 'LAN_GATE_PORT', field: 'port' })
    assert.match(shadowed, /LAN_GATE_PORT/u, `${name} env-shadowed message names the variable`)
    const manual = t('launch.manual', { profile: 'web' })
    assert.match(manual, /dsh --profile web web/u, `${name} manual guidance carries the run command`)
    const sudoHint = t('err.crossUserSocket')
    assert.match(sudoHint, /sudo -E/u, `${name} cross-user hint carries sudo -E`)
    // 词汇纪律：全部文案只谈 host/client/peer。
    const table = Object.values(t.keys ?? {})
    assert.ok(table.length > 30, `${name} dictionary is substantial (${table.length} keys)`)
    for (const value of table) {
      assert.doesNotMatch(value, /\bserver\b/u, `no "server" in ${name} copy: ${value}`)
      assert.doesNotMatch(value, /\bboth\b/u, `no "both" in ${name} copy: ${value}`)
    }
  }
  assert.match(zh('status.role.host'), /host/u)
  assert.match(zh('err.roleGate.peerCommands'), /[\u4e00-\u9fff]/u, 'the zh copy is Chinese')
  assert.doesNotMatch(en('err.roleGate.peerCommands'), /[\u4e00-\u9fff]/u, 'the en copy is free of Chinese')

  // 缺键回退：返回键名本身，不打空字符串。
  assert.equal(zh('no.such.key'), 'no.such.key')
})

// ===========================================================================
// 验收 3：qr-terminal.ts 终端二维码
// ===========================================================================

test('qr-terminal: 配对 URL 渲染出非空半高块矩阵（等宽行、静区、限定字符集）；超长串返回 null', async () => {
  const { renderTerminalQr } = await import(QR_URL)
  const rendered = renderTerminalQr('https://tea.example.com/?code=TEA2026X')
  assert.ok(rendered, 'a sane pairing URL renders')
  const lines = rendered.split('\n')
  assert.ok(lines.length >= 13, `the symbol has quiet-zone rows on both ends (${lines.length} lines)`)
  const width = lines[0].length
  for (const line of lines) assert.equal(line.length, width, 'every line is equally wide')
  const allowed = /^[█▀▄ ]+$/u
  for (const line of lines) assert.match(line, allowed, `half-block characters only: ${JSON.stringify(line)}`)
  assert.match(lines[0], /^ +$/u, 'the top quiet zone is blank')
  assert.match(lines[lines.length - 1], /^ +$/u, 'the bottom quiet zone is blank')
  assert.ok(rendered.includes('█') || rendered.includes('▀') || rendered.includes('▄'), 'dark modules exist')

  // 容量边界：v5-L 恰好 106 字节可以，107 起返回 null。
  assert.ok(renderTerminalQr('x'.repeat(106)), '106 bytes still fits')
  assert.equal(renderTerminalQr('x'.repeat(107)), null, '107 bytes is over capacity')
  assert.equal(renderTerminalQr('https://x.example/?' + 'a'.repeat(100)), null)
})

// ===========================================================================
// 验收 4：scanCandidateProfiles 候选扫描
// ===========================================================================

test('scanCandidateProfiles: 剔除 desktop/node_modules/.开头/非目录，web 保底置顶', async () => {
  const { scanCandidateProfiles } = await import(BOOTSTRAP_URL)
  const home = makeHome('scan')
  try {
    mkdirIn(home, 'profiles', 'work')
    mkdirIn(home, 'profiles', 'desktop')
    mkdirIn(home, 'profiles', 'node_modules')
    mkdirIn(home, 'profiles', '.hidden')
    fs.writeFileSync(path.join(home, 'profiles', 'loose.txt'), 'not a profile')

    const scanned = scanCandidateProfiles(home)
    assert.deepEqual(scanned.map((p) => p.name), ['web', 'work'],
      'desktop/node_modules/.hidden/loose.txt are gone; web sits at index 0 even with no web dir')
    assert.deepEqual(scanned.map((p) => p.installed), [false, false])

    // 已有真实 web 目录时同样置顶，不重复。
    mkdirIn(home, 'profiles', 'web')
    assert.deepEqual(scanCandidateProfiles(home).map((p) => p.name), ['web', 'work'])
  } finally {
    cleanup(home)
  }
})

test('scanCandidateProfiles: installed 按 package.json 的 dependencies / dsh.profile.bundles 判定', async () => {
  const { scanCandidateProfiles } = await import(BOOTSTRAP_URL)
  const home = makeHome('scan-installed')
  try {
    writeProfilePackage(home, 'web', { dependencies: { 'dsh-zen-remote': '^2.3.0' } })
    writeProfilePackage(home, 'alt', { dsh: { profile: { bundles: ['dsh-zen-remote', 'other'] } } })
    writeProfilePackage(home, 'stale', { dependencies: { 'other-plugin': '*' } })
    mkdirIn(home, 'profiles', 'bare')
    fs.mkdirSync(path.join(home, 'profiles', 'broken'), { recursive: true })
    fs.writeFileSync(path.join(home, 'profiles', 'broken', 'package.json'), '{ not json')

    const scanned = scanCandidateProfiles(home)
    const byName = Object.fromEntries(scanned.map((p) => [p.name, p.installed]))
    assert.deepEqual(scanned.map((p) => p.name), ['web', 'alt', 'bare', 'broken', 'stale'], 'web stays at index 0')
    assert.equal(byName.web, true, 'dependencies carry the plugin')
    assert.equal(byName.alt, true, 'dsh.profile.bundles carry the plugin')
    assert.equal(byName.stale, false)
    assert.equal(byName.bare, false, 'no package.json is not installed')
    assert.equal(byName.broken, false, 'unparsable package.json is not installed')
  } finally {
    cleanup(home)
  }
})

test('scanCandidateProfiles: 没有 profiles 目录时只保底 web', async () => {
  const { scanCandidateProfiles } = await import(BOOTSTRAP_URL)
  const home = makeHome('scan-empty')
  try {
    assert.deepEqual(scanCandidateProfiles(home), [{ name: 'web', installed: false }])
  } finally {
    cleanup(home)
  }
})

// ===========================================================================
// 验收 5（上半）：ensurePluginInstalled 多选安装与 desktop 拒绝
// ===========================================================================

function fakePrompter(multiAnswer) {
  const calls = []
  return {
    calls,
    async selectMulti(question, choices, defaultIndices, allowCustomInput) {
      calls.push({ question, choices, defaultIndices, allowCustomInput })
      return multiAnswer
    },
    async selectOne() { return 0 },
    async inputText() { return '' },
    async confirm() { return true },
  }
}

test('ensurePluginInstalled: 多选 [work, web] 依次代跑两次安装，首选运行 profile 是 web', async () => {
  const bootstrap = await import(BOOTSTRAP_URL)
  const home = makeHome('install-multi')
  try {
    mkdirIn(home, 'profiles', 'work')
    mkdirIn(home, 'profiles', 'web')
    const prompter = fakePrompter({ indices: [1, 0], customNames: [] })
    const spawnCalls = []
    const out = captureStdout()
    const result = await bootstrap.ensurePluginInstalled({
      dshHome: home,
      interactive: true,
      prompter,
      spawnCommand: async (command, args) => { spawnCalls.push([command, [...args]]); return 0 },
      stdout: out,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(spawnCalls, [
      ['dsh', ['plugin', '--profile', 'work', 'add', 'dsh-zen-remote']],
      ['dsh', ['plugin', '--profile', 'web', 'add', 'dsh-zen-remote']],
    ], 'install runs in the chosen order, one dsh plugin add per profile')
    assert.equal(result.preferredProfile, 'web', 'web is the preferred run profile even when picked second')
    assert.deepEqual(result.installedNow, ['work', 'web'])
    assert.equal(result.targets.includes('web'), true)
    // 交互问句带默认勾选 web（choices[0]）。
    assert.equal(prompter.calls.length, 1)
    assert.equal(prompter.calls[0].choices[0], 'web')
    assert.deepEqual(prompter.calls[0].defaultIndices, [0])
    assert.equal(prompter.calls[0].allowCustomInput, true)
    assert.match(out.text(), /dsh plugin/u, 'progress names the install command')
  } finally {
    cleanup(home)
  }
})

test('ensurePluginInstalled: --profile desktop 明确拒绝且不代跑任何安装', async () => {
  const bootstrap = await import(BOOTSTRAP_URL)
  const home = makeHome('install-desktop')
  try {
    mkdirIn(home, 'profiles', 'work')
    const spawnCalls = []
    const result = await bootstrap.ensurePluginInstalled({
      dshHome: home,
      profileFlag: ['desktop'],
      spawnCommand: async () => { spawnCalls.push('ran'); return 0 },
      stdout: captureStdout(),
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'desktop-refused')
    assert.deepEqual(spawnCalls, [], 'nothing was installed for desktop')
    const mixed = await bootstrap.ensurePluginInstalled({
      dshHome: home,
      profileFlag: ['web', 'desktop'],
      spawnCommand: async () => { spawnCalls.push('ran'); return 0 },
      stdout: captureStdout(),
    })
    assert.equal(mixed.ok, false, 'a mixed list containing desktop is refused too')
    assert.equal(mixed.code, 'desktop-refused')
    assert.deepEqual(spawnCalls, [])
  } finally {
    cleanup(home)
  }
})

test('ensurePluginInstalled: 已有 profile 装了插件则跳过；非交互缺省装 web；失败时打印手动命令', async () => {
  const bootstrap = await import(BOOTSTRAP_URL)
  const home = makeHome('install-rest')
  try {
    // 已安装：不 spawn，preferredProfile 取 web。
    writeProfilePackage(home, 'web', { dependencies: { 'dsh-zen-remote': '^2' } })
    mkdirIn(home, 'profiles', 'other')
    const spawnCalls = []
    const done = await bootstrap.ensurePluginInstalled({
      dshHome: home,
      spawnCommand: async () => { spawnCalls.push('ran'); return 0 },
      stdout: captureStdout(),
    })
    assert.equal(done.ok, true)
    assert.deepEqual(spawnCalls, [], 'already-installed profiles are not reinstalled')
    assert.equal(done.preferredProfile, 'web')
    assert.deepEqual(done.targets, ['web'])

    // 非交互 + 无 --profile + 全都没装：缺省 web。
    const emptyHome = makeHome('install-default')
    try {
      const spawns = []
      const def = await bootstrap.ensurePluginInstalled({
        dshHome: emptyHome,
        interactive: false,
        spawnCommand: async (command, args) => { spawns.push([command, [...args]]); return 0 },
        stdout: captureStdout(),
      })
      assert.equal(def.ok, true)
      assert.deepEqual(spawns, [['dsh', ['plugin', '--profile', 'web', 'add', 'dsh-zen-remote']]])

      // 安装失败：ok=false + 手动命令原样打印。
      const failOut = captureStdout()
      const failed = await bootstrap.ensurePluginInstalled({
        dshHome: emptyHome,
        profileFlag: ['work'],
        spawnCommand: async () => 1,
        stdout: failOut,
      })
      assert.equal(failed.ok, false)
      assert.equal(failed.code, 'install-failed')
      assert.equal(failed.failedProfile, 'work')
      assert.equal(failed.manualCommand, 'dsh plugin --profile work add dsh-zen-remote')
      assert.match(failOut.text(), /dsh plugin --profile work add dsh-zen-remote/u, 'the manual command is printed verbatim')

      // 显式 --profile 即使已有安装也照跑（幂等 add）。
      const spawns2 = []
      const forced = await bootstrap.ensurePluginInstalled({
        dshHome: home,
        profileFlag: ['extra'],
        spawnCommand: async (command, args) => { spawns2.push([command, [...args]]); return 0 },
        stdout: captureStdout(),
      })
      assert.equal(forced.ok, true)
      assert.deepEqual(spawns2, [['dsh', ['plugin', '--profile', 'extra', 'add', 'dsh-zen-remote']]])
    } finally {
      cleanup(emptyHome)
    }
  } finally {
    cleanup(home)
  }
})

// ===========================================================================
// 非交互铁律 + 默认 readline prompter
// ===========================================================================

test('非交互铁律：非 TTY / --yes 下缺必填参数立即抛 MissingRequiredOptionError，绝不挂起', async () => {
  const bootstrap = await import(BOOTSTRAP_URL)
  assert.equal(bootstrap.isInteractiveSession({ options: { yes: false } }, true), true)
  assert.equal(bootstrap.isInteractiveSession({ options: { yes: true } }, true), false, '--yes suppresses interactivity')
  assert.equal(bootstrap.isInteractiveSession({ options: { yes: false } }, false), false, 'no TTY suppresses interactivity')

  await assert.rejects(
    bootstrap.promptOrFail({ optionName: 'code', interactive: false, provided: undefined, ask: async () => 'x' }),
    (error) => error instanceof bootstrap.MissingRequiredOptionError && error.optionName === 'code',
    'missing + non-interactive throws the structured error naming the option',
  )
  const got = await bootstrap.promptOrFail({ optionName: 'code', interactive: false, provided: 'ABCD2345', ask: async () => { throw new Error('must not prompt') } })
  assert.equal(got, 'ABCD2345', 'a provided value answers without prompting')
  const asked = await bootstrap.promptOrFail({ optionName: 'code', interactive: true, provided: undefined, ask: async () => 'XYZ' })
  assert.equal(asked, 'XYZ', 'interactive + missing prompts once')
})

test('默认 readline prompter：inputText 默认值与 confirm 在管道流上可用', { skip: IS_WIN }, async () => {
  const bootstrap = await import(BOOTSTRAP_URL)
  const input = new PassThrough()
  const output = new PassThrough()
  const prompter = bootstrap.createReadlinePrompter(input, output)
  try {
    const name = prompter.inputText('本机显示名', '茶壶机')
    input.write('\n')
    assert.equal(await name, '茶壶机', 'empty input takes the default')

    const sure = prompter.confirm('继续？', true)
    input.write('y\n')
    assert.equal(await sure, true)

    const nope = prompter.confirm('继续？', false)
    input.write('\n')
    assert.equal(await nope, false, 'empty input takes the default answer')
  } finally {
    prompter.close()
  }
})

// ===========================================================================
// discoverCliSockets：存活 / 版本不匹配 / EACCES / explicitSocket
// ===========================================================================

test('discoverCliSockets: 存活 socket 进 live；版本不匹配进 versionMismatch；EACCES 进 permissionDenied', { skip: IS_WIN }, async () => {
  const ipcClient = await import(IPC_CLIENT_URL)
  const ipc = await import(IPC_SERVER_URL)
  const home = makeHome('discover')
  const fakeHome = makeHome('discover-fake')
  const eaccesHome = makeHome('discover-eacces')
  let server
  let fake
  let eacces
  try {
    server = await startIpcServer(home, { role: 'host', serverName: '茶壶机', profileName: 'web' })
    const found = await ipcClient.discoverCliSockets({ dshHome: home })
    assert.equal(found.live.length, 1)
    const live = found.live[0]
    assert.equal(live.socketPath, server.socketPath)
    assert.equal(live.cliProtocolVersion, ipc.CLI_PROTOCOL_VERSION)
    assert.equal(live.role, 'host')
    assert.equal(live.serverName, '茶壶机')
    assert.equal(live.profileName, 'web')
    assert.equal(found.versionMismatch.length, 0)
    assert.equal(found.permissionDenied.length, 0)

    // 版本不匹配：裸 http server 顶着候选路径回 cliProtocolVersion 999。
    fake = await startFakePingServer(path.join(fakeHome, 'zen-remote-cli.sock'), {
      ok: true, cliProtocolVersion: 999, pluginVersion: '9.9.9', pid: 1, role: 'host', serves: true, connects: false, serverName: 'fake',
    })
    const mismatched = await ipcClient.discoverCliSockets({ dshHome: fakeHome })
    assert.equal(mismatched.live.length, 0)
    assert.equal(mismatched.versionMismatch.length, 1)
    assert.equal(mismatched.versionMismatch[0].socketPath, path.join(fakeHome, 'zen-remote-cli.sock'))
    assert.equal(mismatched.versionMismatch[0].cliProtocolVersion, 999)

    // EACCES：socket 文件 chmod 000 后连接被拒。
    eacces = await startIpcServer(eaccesHome)
    fs.chmodSync(eacces.socketPath, 0o000)
    const denied = await ipcClient.discoverCliSockets({ dshHome: eaccesHome })
    assert.equal(denied.live.length, 0, 'a 000 socket is not live for us')
    assert.deepEqual(denied.permissionDenied, [eacces.socketPath])
  } finally {
    if (eacces !== undefined) {
      try { fs.chmodSync(eacces.socketPath, 0o600) } catch { /* ignore */ }
      await eacces.close()
    }
    if (fake !== undefined) await new Promise((resolve) => fake.close(resolve))
    if (server !== undefined) await server.close()
    cleanup(home); cleanup(fakeHome); cleanup(eaccesHome)
  }
})

test('discoverCliSockets: explicitSocket 只探测指定路径', { skip: IS_WIN }, async () => {
  const ipcClient = await import(IPC_CLIENT_URL)
  const home = makeHome('discover-explicit')
  let server
  try {
    server = await startIpcServer(home)
    // 指向不存在的路径：家里明明有存活 socket 也不去碰它。
    const none = await ipcClient.discoverCliSockets({ dshHome: home, explicitSocket: path.join(home, 'nope.sock') })
    assert.equal(none.live.length, 0)
    // 指向存活路径：只有它进 live。
    const exact = await ipcClient.discoverCliSockets({ dshHome: home, explicitSocket: server.socketPath })
    assert.equal(exact.live.length, 1)
    assert.equal(exact.live[0].socketPath, server.socketPath)
  } finally {
    if (server !== undefined) await server.close()
    cleanup(home)
  }
})

test('ipc-client: createCliIpcClient 的 ping/getStatus/writeConfig 走真实 socket', { skip: IS_WIN }, async () => {
  const ipcClient = await import(IPC_CLIENT_URL)
  const ipc = await import(IPC_SERVER_URL)
  const { createClientHandler } = await import(CLIENT_ROUTES_URL)
  const { createRelayPool } = await import(RELAY_POOL_URL)
  const { writeCliConfig } = await import(WRITER_URL)
  const home = makeHome('client-requests')
  const pool = createRelayPool({ stateFile: path.join(home, 'zen-remote-state.json') })
  let server
  try {
    const clientHandler = createClientHandler({
      admit: () => ({ peer: {} }),
      getRowConfig: () => ({}),
      pool,
      getLogSnapshot: () => [],
      getPluginVersion: () => '0.0.0-test',
    })
    server = await startIpcServer(home, {
      role: 'client',
      serverName: 'client-side',
      clientHandler,
      writeConfig: (input) => writeCliConfig({
        dshHome: home,
        row: {},
        env: process.env,
        profileName: 'web',
        set: input.set,
        unset: input.unset,
      }),
    })
    const client = ipcClient.createCliIpcClient(server.socketPath)
    const ping = await client.ping()
    assert.equal(ping.ok, true)
    assert.equal(ping.role, 'client')
    assert.equal(ping.serverName, 'client-side')

    const status = await client.getStatus()
    assert.equal(status.state, 'unpaired', 'the client status route answers through the same client')

    const written = await client.writeConfig({ set: { serverName: 'cli-name' } })
    assert.equal(written.status, 200, 'the config route answers over IPC')
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'lan-gate.config.json'), 'utf8')).serverName, 'cli-name')

    const missing = await client.request('GET', '/_dsh/zen-remote/cli/nothing')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.ok, false, 'error codes ride the parsed body')

    // 传输层错误（socket 不存在）向上抛，错误码随异常走。
    const dead = ipcClient.createCliIpcClient(path.join(home, 'nope.sock'))
    await assert.rejects(
      dead.request('GET', ipc.CLI_PING_ROUTE),
      (error) => error instanceof Error && typeof error.code === 'string',
    )
  } finally {
    if (server !== undefined) await server.close()
    pool.stop()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 6（下半）：ensureDshRunning 自动拉起
// ===========================================================================

test('ensureDshRunning: 已有 socket 直接连通；多实例时优先选目标角色', { skip: IS_WIN }, async () => {
  const bootstrap = await import(BOOTSTRAP_URL)
  const home = makeHome('launch-live')
  let hostServer
  let clientServer
  try {
    hostServer = await startIpcServer(home, { role: 'host' })
    clientServer = await startIpcServer(home, { role: 'client' })
    const recorder = execProbeRecorder()
    const found = await bootstrap.ensureDshRunning({
      dshHome: home, targetRole: 'host', waitSeconds: 2, execProbe: recorder.probe, stdout: captureStdout(),
    })
    assert.equal(found.started, true)
    assert.equal(found.socketPath, hostServer.socketPath)
    assert.equal((await found.client.ping()).role, 'host')
    assert.equal(recorder.calls.length, 0, 'a live socket never spawns any daemon command')

    const picked = await bootstrap.ensureDshRunning({
      dshHome: home, targetRole: 'client', waitSeconds: 2, execProbe: recorder.probe, stdout: captureStdout(),
    })
    assert.equal(picked.started, true)
    assert.equal(picked.socketPath, clientServer.socketPath, 'the target role wins among live instances')
    assert.equal((await picked.client.ping()).role, 'client')
  } finally {
    if (hostServer !== undefined) await hostServer.close()
    if (clientServer !== undefined) await clientServer.close()
    cleanup(home)
  }
})

test('ensureDshRunning: socket EACCES 报跨用户错误并提示 sudo -E，不触发守护拉起', { skip: IS_WIN }, async () => {
  const bootstrap = await import(BOOTSTRAP_URL)
  const home = makeHome('launch-eacces')
  let server
  try {
    server = await startIpcServer(home)
    fs.chmodSync(server.socketPath, 0o000)
    const recorder = execProbeRecorder()
    const out = captureStdout()
    const result = await bootstrap.ensureDshRunning({
      dshHome: home, waitSeconds: 1, execProbe: recorder.probe, stdout: out,
    })
    assert.equal(result.started, false)
    assert.equal(result.outcome, 'permission-denied')
    assert.match(out.text(), /sudo -E/u, 'the hint names sudo -E')
    assert.equal(recorder.calls.length, 0, 'a permission problem is not a missing-daemon problem')
  } finally {
    if (server !== undefined) {
      try { fs.chmodSync(server.socketPath, 0o600) } catch { /* ignore */ }
      await server.close()
    }
    cleanup(home)
  }
})

test('ensureDshRunning: Linux 检测 systemctl --user 单元并拉起，随后轮询连通', { skip: IS_WIN }, async () => {
  const bootstrap = await import(BOOTSTRAP_URL)
  const home = makeHome('launch-linux')
  let server
  try {
    let started = false
    const recorder = execProbeRecorder({
      'systemctl --user list-unit-files dsh*': () => ({ code: 0, stdout: 'dsh-web.service enabled enabled\n' }),
      'systemctl --user start dsh-web.service': () => ({ code: 0, stdout: '' }),
    }, {
      // start 命令发出后稍等片刻才真的有 socket 可连——轮询路径必须走到。
      'systemctl --user start dsh-web.service': async () => {
        await sleep(60)
        server = await startIpcServer(home, { role: 'host', profileName: 'web' })
        started = true
      },
    })
    const out = captureStdout()
    const result = await bootstrap.ensureDshRunning({
      dshHome: home, platform: 'linux', preferredProfile: 'web', waitSeconds: 5, execProbe: recorder.probe, stdout: out,
    })
    assert.equal(result.started, true, `the poll found the unit-started server (${out.text()})`)
    assert.equal(started, true)
    assert.deepEqual(recorder.calls, [
      ['systemctl', ['--user', 'list-unit-files', 'dsh*']],
      ['systemctl', ['--user', 'start', 'dsh-web.service']],
    ])
    assert.equal((await result.client.ping()).role, 'host')
  } finally {
    if (server !== undefined) await server.close()
    cleanup(home)
  }
})

test('ensureDshRunning: macOS launchctl kickstart 拉起；无服务时 open -a 拉起 App', { skip: IS_WIN }, async () => {
  const bootstrap = await import(BOOTSTRAP_URL)

  // 分支 1：launchd 服务存在 → kickstart。
  const home1 = makeHome('launch-mac-ks')
  let server1
  try {
    const recorder1 = execProbeRecorder({
      [`launchctl print gui/501/ai.deepseek.dsh.web`]: () => ({ code: 0, stdout: 'state = running\n' }),
      [`launchctl kickstart -k gui/501/ai.deepseek.dsh.web`]: () => ({ code: 0, stdout: '' }),
    }, {
      [`launchctl kickstart -k gui/501/ai.deepseek.dsh.web`]: async () => {
        await sleep(60)
        server1 = await startIpcServer(home1, { role: 'host' })
      },
    })
    const result1 = await bootstrap.ensureDshRunning({
      dshHome: home1, platform: 'darwin', uid: 501, preferredProfile: 'web', waitSeconds: 5, execProbe: recorder1.probe, stdout: captureStdout(),
    })
    assert.equal(result1.started, true, 'kickstart path connects')
    assert.deepEqual(recorder1.calls, [
      ['launchctl', ['print', 'gui/501/ai.deepseek.dsh.web']],
      ['launchctl', ['kickstart', '-k', 'gui/501/ai.deepseek.dsh.web']],
    ])
  } finally {
    if (server1 !== undefined) await server1.close()
    cleanup(home1)
  }

  // 分支 2：无 launchd 服务 → App 存在 → open -a（App 路径注入以避开真机差异）。
  const home2 = makeHome('launch-mac-open')
  const fakeApp = path.join(makeHome('launch-app'), 'Fake Harness.app')
  fs.mkdirSync(fakeApp, { recursive: true })
  let server2
  try {
    const recorder2 = execProbeRecorder({
      [`launchctl print gui/501/ai.deepseek.dsh.web`]: () => ({ code: 1, stdout: '' }),
      [`open -a ${fakeApp}`]: () => ({ code: 0, stdout: '' }),
    }, {
      [`open -a ${fakeApp}`]: async () => {
        await sleep(60)
        server2 = await startIpcServer(home2, { role: 'host' })
      },
    })
    const result2 = await bootstrap.ensureDshRunning({
      dshHome: home2, platform: 'darwin', uid: 501, preferredProfile: 'web', waitSeconds: 5,
      execProbe: recorder2.probe, macosAppPath: fakeApp, stdout: captureStdout(),
    })
    assert.equal(result2.started, true, 'open -a path connects')
    assert.deepEqual(recorder2.calls, [
      ['launchctl', ['print', 'gui/501/ai.deepseek.dsh.web']],
      ['open', ['-a', fakeApp]],
    ])
  } finally {
    if (server2 !== undefined) await server2.close()
    cleanup(path.dirname(fakeApp))
    cleanup(home2)
  }
})

test('ensureDshRunning: Windows 不自行拉起，打印手动指引（含 dsh web 与 systemd 示例）', async () => {
  const bootstrap = await import(BOOTSTRAP_URL)
  const home = makeHome('launch-win')
  try {
    const recorder = execProbeRecorder()
    const out = captureStdout()
    const result = await bootstrap.ensureDshRunning({
      dshHome: home, platform: 'win32', preferredProfile: 'web', waitSeconds: 1, execProbe: recorder.probe, stdout: out,
    })
    assert.equal(result.started, false)
    assert.equal(result.outcome, 'no-daemon')
    assert.equal(recorder.calls.length, 0, 'windows never spawns daemon commands')
    const printed = out.text()
    assert.match(printed, /dsh --profile web web/u, 'the guidance carries the manual run command')
    assert.match(printed, /systemd/u, 'the guidance carries the systemd unit example')
  } finally {
    cleanup(home)
  }
})

test('ensureDshRunning: Linux 无任何守护单元 → 手动指引；触发后等不到 socket → timeout', { skip: IS_WIN }, async () => {
  const bootstrap = await import(BOOTSTRAP_URL)
  const home = makeHome('launch-none')
  const emptyUnitDir = path.join(makeHome('launch-units'), 'empty')
  fs.mkdirSync(emptyUnitDir, { recursive: true })
  try {
    // 无用户单元（127）、无系统单元目录内容 → no-daemon + 手动指引。
    const recorder = execProbeRecorder({
      'systemctl --user list-unit-files dsh*': () => ({ code: 1, stdout: '' }),
    })
    const out = captureStdout()
    const result = await bootstrap.ensureDshRunning({
      dshHome: home, platform: 'linux', preferredProfile: 'work', waitSeconds: 1,
      execProbe: recorder.probe, systemUnitDir: emptyUnitDir, stdout: out,
    })
    assert.equal(result.started, false)
    assert.equal(result.outcome, 'no-daemon')
    assert.deepEqual(recorder.calls, [['systemctl', ['--user', 'list-unit-files', 'dsh*']]], 'the system-unit dir is only read after the user probe fails')
    assert.match(out.text(), /dsh --profile work web/u)
    assert.match(out.text(), /systemd/u)

    // 触发了拉起但 socket 一直不出现 → timeout。
    const recorder2 = execProbeRecorder({
      'systemctl --user list-unit-files dsh*': () => ({ code: 0, stdout: 'dsh-web.service enabled enabled\n' }),
      'systemctl --user start dsh-web.service': () => ({ code: 0, stdout: '' }),
    })
    const result2 = await bootstrap.ensureDshRunning({
      dshHome: home, platform: 'linux', preferredProfile: 'web', waitSeconds: 0.3,
      execProbe: recorder2.probe, systemUnitDir: emptyUnitDir, stdout: captureStdout(),
    })
    assert.equal(result2.started, false)
    assert.equal(result2.outcome, 'timeout')
    assert.equal(recorder2.calls.length, 2, 'the start command ran')
  } finally {
    cleanup(path.dirname(emptyUnitDir))
    cleanup(home)
  }
})
