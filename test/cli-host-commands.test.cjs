/* dsh-zen-remote · CLI-4: host 子命令族（device pair/list/revoke + ingress start/stop/verify/snippet）
 *
 * 驱动 BUILT lib/cli/commands-host.js（与 cli-client-commands.test.cjs 同理：src 相对导入
 * 在 Node strip-only 模式下映射不了）。测试接缝三（SPEC）：真实 IPC Socket 服务端 + 受控
 * delegate 替身（admin/wizard 路由答罐装 JSON），命令层经真实 Unix socket 发请求；交互
 * 问答走注入的 fake prompter，轮询间隔与 Ctrl-C 用注入的 pollIntervalMs / abortSignal。
 * 断言退出码、stdout 双语文本、JSON 输出与路由请求体，不断言内部调用顺序。铁律断言：
 * ingress 全部走 IPC 路由（requests 表），CLI 自身零 spawn——罐头 delegate 里没有任何
 * 进程替身，实现若 spawn caddy/cloudflared 只会在测试进程里真的找不到二进制而失败。
 *
 * macOS 的 Unix socket 路径上限约 104 字节，临时目录继续用 /tmp 短前缀（沿用
 * cli-client-commands.test.cjs 的既有先例；仅测试内部的 mkdtemp，非命令输出重定向）。
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ARGS_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'args.js')).href
const I18N_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'i18n.js')).href
const BOOTSTRAP_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'bootstrap.js')).href
const IPC_SERVER_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'ipc-server.js')).href
const IPC_CLIENT_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'ipc-client.js')).href
const STATUS_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'commands-status.js')).href
const HOST_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'commands-host.js')).href

function makeHome(tag) {
  return fs.mkdtempSync(path.join('/tmp', `dshzr4-${tag}-`))
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
}

function captureStdout() {
  const lines = []
  return { lines, write: (text) => lines.push(text), text: () => lines.join('') }
}

async function loadModules() {
  const [args, i18n, bootstrap, ipcServer, ipcClient, statusMod, hostMod] = await Promise.all([
    import(ARGS_URL), import(I18N_URL), import(BOOTSTRAP_URL),
    import(IPC_SERVER_URL), import(IPC_CLIENT_URL), import(STATUS_URL), import(HOST_URL),
  ])
  return { ...args, ...i18n, ...bootstrap, ...ipcServer, ...ipcClient, ...statusMod, ...hostMod }
}

/** 罐装 delegate：admin/wizard 两张路由表，表项是 `{ status, body }` 或
 * `(res, seen) => void`；所有请求（含 POST 体）都记进 requests 供断言。 */
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
  return {
    requests,
    delegate: {
      role: () => overrides.role ?? 'host',
      serverName: () => overrides.serverName ?? '茶壶机',
      profileName: () => overrides.profileName,
      pluginVersion: () => '9.9.9-test',
      writeConfig: overrides.writeConfig ?? (() => ({ ok: true, values: {} })),
      wizardHandler: makeHandler(overrides.wizard),
      adminHandler: makeHandler(overrides.admin),
      clientHandler: makeHandler(overrides.client),
    },
  }
}

/** fake prompter：按序吐出预置答案，并把每次提问记录下来供断言。 */
function fakePrompter({ inputs = [], confirms = [], selects = [] } = {}) {
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
    async selectOne(question, choices) {
      calls.push({ kind: 'select', question, choices })
      const value = selects[selectIndex++]
      assert.notEqual(value, undefined, 'unexpected extra selectOne prompt')
      return value
    },
    close() {},
  }
}

/** 组装 CliExecutionContext：真 IPC client 连真 socket。 */
function makeCtx(mods, { argv, ipc, lang = 'zh', interactive = false, prompter, stdout = captureStdout(), pollIntervalMs, abortSignal }) {
  return {
    args: mods.parseCliArgs(argv),
    ipc,
    t: mods.createTranslator(lang),
    interactive,
    ...(prompter === undefined ? {} : { prompter }),
    stdout,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(abortSignal === undefined ? {} : { abortSignal }),
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 罐头数据 ----------------------------------------------------------------

const PAIR_OK = (role) => ({
  body: () => ({ ok: true, code: 'ABCD2345', expiresAt: Date.now() + 10 * 60 * 1000, role }),
})

const ADMIN_DEVICES = [
  { id: 'd1', name: '手机', role: 'web', kind: 'phone', createdAt: new Date(2026, 0, 2, 3, 4).getTime(), lastSeen: new Date(2026, 0, 3, 5, 6).getTime() },
  { id: 'd2', name: '台式机', role: 'desktop-client', kind: 'desktop', createdAt: new Date(2026, 0, 4, 7, 8).getTime(), lastSeen: new Date(2026, 0, 5, 9, 10).getTime() },
]

const HOST_ADMIN = {
  '/_dsh/zen-remote/admin/status': {
    body: {
      ok: true,
      gatewayReachable: true,
      gatewayStatus: 200,
      gateway: { state: 'running', port: 3088, devices: ADMIN_DEVICES },
      config: { values: { port: 3088 }, sources: {} },
    },
  },
}

const WIZARD_PUBLIC = {
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

const WIZARD_LAN_ONLY = {
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

/** 起一个 host 角色 IPC 服务端，返回 { mods, handle, ipc, canned }。 */
async function startHost(overrides = {}) {
  const mods = await loadModules()
  const home = makeHome(overrides.tag ?? 'host')
  const canned = cannedDelegate({ role: 'host', ...overrides })
  const handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
  const ipc = mods.createCliIpcClient(handle.socketPath)
  return { mods, home, handle, ipc, canned }
}

async function stopHost({ home, handle }) {
  if (handle !== undefined) await handle.close()
  cleanup(home)
}

// ===========================================================================
// 验收 1：client 角色下 host * 全部被角色门禁拦截（退出码 1）
// ===========================================================================

test('角色门禁：client 角色跑 host 全部子命令退出码 1，提示当前角色是 client，且无 admin/wizard 请求外泄', async () => {
  const mods = await loadModules()
  const home = makeHome('gate-client')
  let handle
  try {
    const canned = cannedDelegate({ role: 'client', admin: HOST_ADMIN, wizard: WIZARD_PUBLIC })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const cases = [
      ['host.device.pair', ['host', 'device', 'pair'], mods.runHostDevicePairCommand],
      ['host.device.list', ['host', 'device', 'list'], mods.runHostDeviceListCommand],
      ['host.device.revoke', ['host', 'device', 'revoke', 'd1'], mods.runHostDeviceRevokeCommand],
      ['host.ingress.start', ['host', 'ingress', 'start', '--mode', 'lan'], mods.runHostIngressStartCommand],
      ['host.ingress.stop', ['host', 'ingress', 'stop', '--yes'], mods.runHostIngressStopCommand],
      ['host.ingress.verify', ['host', 'ingress', 'verify', '--public-url', 'https://tea.example.com'], mods.runHostIngressVerifyCommand],
      ['host.ingress.snippet', ['host', 'ingress', 'snippet', '--proxy', 'nginx'], mods.runHostIngressSnippetCommand],
    ]
    for (const [name, argv, run] of cases) {
      const ctx = makeCtx(mods, { argv, ipc })
      const code = await run(ctx)
      assert.equal(code, 1, `${name} exits 1 under the client role`)
      const text = ctx.stdout.text()
      assert.match(text, /此命令需要 host 角色，当前角色是 client/u, `${name} names the role verdict`)
      assert.match(text, /请先用 setup 切换角色/u, `${name} names the switch command`)
      const en = makeCtx(mods, { argv, ipc, lang: 'en' })
      assert.equal(await run(en), 1, `${name} exits 1 (en)`)
      assert.match(en.stdout.text(), /This command requires the host role; the current role is client/u)
    }
    // 全程除 ping（内置路由）外没有任何 admin/wizard 路由请求外泄。
    const leaked = canned.requests.filter((r) => !r.path.endsWith('/cli/ping'))
    assert.deepEqual(leaked, [], 'no admin/wizard route request leaves the CLI under the gate')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 2：device pair / list / revoke
// ===========================================================================

test('host device pair：web 配对——POST {role:"web"}，终端二维码 + 访问地址 + 8 位码 + 有效期；--json 输出结构', async () => {
  const { mods, home, handle, ipc, canned } = await startHost({ tag: 'pair-web', admin: { '/_dsh/zen-remote/admin/pair': PAIR_OK('web') }, wizard: WIZARD_PUBLIC })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'device', 'pair', '--device-role', 'web'], ipc })
    const code = await mods.runHostDevicePairCommand(ctx)
    assert.equal(code, 0, `pair succeeds (${ctx.stdout.text()})`)
    const pair = canned.requests.find((r) => r.path === '/_dsh/zen-remote/admin/pair')
    assert.deepEqual(pair.body, { role: 'web' }, 'the pair route receives { role: "web" }')
    const text = ctx.stdout.text()
    assert.match(text, /█/u, 'a terminal QR block is drawn')
    assert.match(text, /https:\/\/tea\.example\.com/u, 'the public URL is printed')
    assert.match(text, /配对码：ABCD2345/u)
    assert.match(text, /10 分钟内有效/u)
    assert.match(text, /扫码/u, 'the scan hint is printed')

    const json = makeCtx(mods, { argv: ['host', 'device', 'pair', '--device-role', 'web', '--json'], ipc })
    assert.equal(await mods.runHostDevicePairCommand(json), 0)
    const parsed = JSON.parse(json.stdout.text())
    assert.equal(parsed.ok, true)
    assert.equal(parsed.deviceRole, 'web')
    assert.equal(parsed.code, 'ABCD2345')
    assert.equal(parsed.url, 'https://tea.example.com')
    assert.equal(typeof parsed.expiresAt, 'number')
  } finally {
    await stopHost({ home, handle })
  }
})

test('host device pair：desktop-client——打印可直接复制的 client pair 命令与向导说明', async () => {
  const { mods, home, handle, ipc, canned } = await startHost({ tag: 'pair-desktop', admin: { '/_dsh/zen-remote/admin/pair': PAIR_OK('desktop-client') }, wizard: WIZARD_PUBLIC })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'device', 'pair', '--device-role', 'desktop-client'], ipc })
    const code = await mods.runHostDevicePairCommand(ctx)
    assert.equal(code, 0, `pair succeeds (${ctx.stdout.text()})`)
    const pair = canned.requests.find((r) => r.path === '/_dsh/zen-remote/admin/pair')
    assert.deepEqual(pair.body, { role: 'desktop-client' })
    const text = ctx.stdout.text()
    assert.match(text, /dsh-zen-remote client pair https:\/\/tea\.example\.com --code ABCD2345/u, 'the copy-paste client pair command')
    assert.match(text, /设备配对/u, 'the web-wizard hint')
  } finally {
    await stopHost({ home, handle })
  }
})

test('host device pair：无 publicUrl 时用 lanAddress + 网关实际端口拼局域网地址', async () => {
  const { mods, home, handle, ipc } = await startHost({ tag: 'pair-lan', admin: { '/_dsh/zen-remote/admin/pair': PAIR_OK('web') }, wizard: WIZARD_LAN_ONLY })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'device', 'pair'], ipc })
    const code = await mods.runHostDevicePairCommand(ctx)
    assert.equal(code, 0, `pair succeeds (${ctx.stdout.text()})`)
    const text = ctx.stdout.text()
    assert.match(text, /http:\/\/10\.0\.0\.5:3088/u, 'the LAN URL is assembled from lanAddress + gatewayActualPort')
    // 无 --device-role 的非交互运行默认 web。
    assert.match(text, /配对码：/u)
  } finally {
    await stopHost({ home, handle })
  }
})

test('host device pair：非法 --device-role 报错退出码 1，不发配对请求', async () => {
  const { mods, home, handle, ipc, canned } = await startHost({ tag: 'pair-badrole', admin: {}, wizard: WIZARD_PUBLIC })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'device', 'pair', '--device-role', 'toaster'], ipc })
    const code = await mods.runHostDevicePairCommand(ctx)
    assert.equal(code, 1)
    assert.match(ctx.stdout.text(), /设备类型只能是 web 或 desktop-client/u)
    assert.deepEqual(canned.requests.filter((r) => r.path.endsWith('/admin/pair')), [], 'no pairing code is minted')
  } finally {
    await stopHost({ home, handle })
  }
})

test('host device pair：交互模式未传 --device-role 时选择设备类型（默认 web）', async () => {
  const { mods, home, handle, ipc, canned } = await startHost({ tag: 'pair-select', admin: { '/_dsh/zen-remote/admin/pair': PAIR_OK('web') }, wizard: WIZARD_PUBLIC })
  try {
    const prompter = fakePrompter({ selects: [0] })
    const ctx = makeCtx(mods, { argv: ['host', 'device', 'pair'], ipc, interactive: true, prompter })
    const code = await mods.runHostDevicePairCommand(ctx)
    assert.equal(code, 0)
    const select = prompter.calls.find((c) => c.kind === 'select')
    assert.ok(select, 'the device-role question was asked')
    assert.match(select.choices[0], /web/u)
    assert.match(select.choices[1], /desktop-client/u)
    const pair = canned.requests.find((r) => r.path === '/_dsh/zen-remote/admin/pair')
    assert.deepEqual(pair.body, { role: 'web' })
  } finally {
    await stopHost({ home, handle })
  }
})

test('host device list：终端逐行 id/名称/角色/类型/时间；--json 输出 { ok, devices }', async () => {
  const { mods, home, handle, ipc, canned } = await startHost({ tag: 'list', admin: HOST_ADMIN })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'device', 'list'], ipc })
    const code = await mods.runHostDeviceListCommand(ctx)
    assert.equal(code, 0)
    const text = ctx.stdout.text()
    assert.match(text, /已配对设备：/u)
    assert.match(text, /\[d1\] 手机（web · phone）/u)
    assert.match(text, /\[d2\] 台式机（desktop-client · desktop）/u)
    assert.match(text, /创建于 2026-01-02 03:04/u)
    assert.match(text, /最后活跃 2026-01-03 05:06/u)

    const json = makeCtx(mods, { argv: ['host', 'device', 'list', '--json'], ipc })
    assert.equal(await mods.runHostDeviceListCommand(json), 0)
    const parsed = JSON.parse(json.stdout.text())
    assert.equal(parsed.ok, true)
    assert.equal(parsed.devices.length, 2)
    assert.equal(parsed.devices[0].id, 'd1')
    assert.equal(parsed.devices[1].role, 'desktop-client')
    // 命令只读 admin/status。
    assert.ok(canned.requests.some((r) => r.path === '/_dsh/zen-remote/admin/status'))
  } finally {
    await stopHost({ home, handle })
  }
})

test('host device revoke：单台 POST {action:"revoke", id}；--all --yes 非交互 POST {action:"revoke-all"} 不提问', async () => {
  const { mods, home, handle, ipc, canned } = await startHost({
    tag: 'revoke',
    admin: { ...HOST_ADMIN, '/_dsh/zen-remote/admin/action': { body: { ok: true } } },
  })
  try {
    const one = makeCtx(mods, { argv: ['host', 'device', 'revoke', 'd1', '--json'], ipc })
    assert.equal(await mods.runHostDeviceRevokeCommand(one), 0)
    const revoke = canned.requests.find((r) => r.path === '/_dsh/zen-remote/admin/action')
    assert.deepEqual(revoke.body, { action: 'revoke', id: 'd1' })
    const oneParsed = JSON.parse(one.stdout.text())
    assert.deepEqual(oneParsed, { ok: true, action: 'revoke', id: 'd1' })

    const oneText = makeCtx(mods, { argv: ['host', 'device', 'revoke', 'd1'], ipc })
    assert.equal(await mods.runHostDeviceRevokeCommand(oneText), 0)
    assert.match(oneText.stdout.text(), /已吊销设备 d1。/u)

    const prompter = fakePrompter({})
    const all = makeCtx(mods, { argv: ['host', 'device', 'revoke', '--all', '--yes'], ipc, prompter })
    assert.equal(await mods.runHostDeviceRevokeCommand(all), 0)
    assert.equal(prompter.calls.length, 0, '--yes skips every question')
    const revokeAll = canned.requests.filter((r) => r.path === '/_dsh/zen-remote/admin/action').at(-1)
    assert.deepEqual(revokeAll.body, { action: 'revoke-all' })
    assert.match(all.stdout.text(), /已吊销 2 台设备。/u)
  } finally {
    await stopHost({ home, handle })
  }
})

test('host device revoke：--all 交互模式先确认——拒绝则不动，同意才清空；无目标非交互退出 1', async () => {
  const { mods, home, handle, ipc, canned } = await startHost({
    tag: 'revoke-all',
    admin: { ...HOST_ADMIN, '/_dsh/zen-remote/admin/action': { body: { ok: true } } },
  })
  try {
    const no = makeCtx(mods, { argv: ['host', 'device', 'revoke', '--all'], ipc, interactive: true, prompter: fakePrompter({ confirms: [false] }) })
    assert.equal(await mods.runHostDeviceRevokeCommand(no), 0, 'a declined confirm is not a failure')
    const confirm = no.stdout.text()
    assert.match(confirm, /取消/u)
    assert.deepEqual(canned.requests.filter((r) => r.path === '/_dsh/zen-remote/admin/action'), [], 'a declined confirm revokes nothing')

    const yes = makeCtx(mods, { argv: ['host', 'device', 'revoke', '--all'], ipc, interactive: true, prompter: fakePrompter({ confirms: [true] }) })
    assert.equal(await mods.runHostDeviceRevokeCommand(yes), 0)
    assert.equal(yes.prompter.calls[0].question, mods.createTranslator('zh')('host.device.revokeConfirmAll'))
    const revokeAll = canned.requests.filter((r) => r.path === '/_dsh/zen-remote/admin/action').at(-1)
    assert.deepEqual(revokeAll.body, { action: 'revoke-all' })

    const missing = makeCtx(mods, { argv: ['host', 'device', 'revoke'], ipc })
    assert.equal(await mods.runHostDeviceRevokeCommand(missing), 1, 'no target in a non-interactive run fails')
    assert.match(missing.stdout.text(), /请指定要吊销的设备 id/u)
  } finally {
    await stopHost({ home, handle })
  }
})

// ===========================================================================
// 验收 3：ingress snippet
// ===========================================================================

test('host ingress snippet：三种片段都带网关实际端口 3088 与域名', async () => {
  const { mods, home, handle, ipc } = await startHost({ tag: 'snippet', admin: HOST_ADMIN, wizard: WIZARD_PUBLIC })
  try {
    const nginx = makeCtx(mods, { argv: ['host', 'ingress', 'snippet', '--proxy', 'nginx'], ipc })
    assert.equal(await mods.runHostIngressSnippetCommand(nginx), 0)
    const nginxText = nginx.stdout.text()
    assert.match(nginxText, /server_name tea\.example\.com;/u)
    assert.match(nginxText, /proxy_pass http:\/\/127\.0\.0\.1:3088;/u)
    assert.match(nginxText, /网关端口 3088/u)

    const caddy = makeCtx(mods, { argv: ['host', 'ingress', 'snippet', '--proxy', 'caddy'], ipc })
    assert.equal(await mods.runHostIngressSnippetCommand(caddy), 0)
    assert.match(caddy.stdout.text(), /reverse_proxy 127\.0\.0\.1:3088/u)

    const lucky = makeCtx(mods, { argv: ['host', 'ingress', 'snippet', '--proxy', 'lucky'], ipc })
    assert.equal(await mods.runHostIngressSnippetCommand(lucky), 0)
    assert.match(lucky.stdout.text(), /http:\/\/127\.0\.0\.1:3088/u)
    assert.match(lucky.stdout.text(), /Web 服务/u)

    // 非交互未传 --proxy：三种全部输出。
    const all = makeCtx(mods, { argv: ['host', 'ingress', 'snippet'], ipc })
    assert.equal(await mods.runHostIngressSnippetCommand(all), 0)
    const allText = all.stdout.text()
    assert.match(allText, /server_name tea\.example\.com;/u)
    assert.match(allText, /reverse_proxy 127\.0\.0\.1:3088/u)
    assert.match(allText, /Web 服务/u)

    const bad = makeCtx(mods, { argv: ['host', 'ingress', 'snippet', '--proxy', 'traefik'], ipc })
    assert.equal(await mods.runHostIngressSnippetCommand(bad), 1)
    assert.match(bad.stdout.text(), /反代类型只能是 nginx、caddy 或 lucky/u)
  } finally {
    await stopHost({ home, handle })
  }
})

// ===========================================================================
// 验收 4：ingress start 四种模式
// ===========================================================================

const WIZARD_STOPS = {
  '/_dsh/zen-remote/admin/wizard/caddy/stop': { body: { ok: true, state: 'never-started' } },
  '/_dsh/zen-remote/admin/wizard/tunnel/stop': { body: { ok: true, state: 'never-started' } },
  '/_dsh/zen-remote/admin/wizard/cf-token': { body: { ok: true, configured: true } },
  '/_dsh/zen-remote/admin/wizard/trust-proxy': { body: { ok: true, added: true } },
  '/_dsh/zen-remote/admin/wizard/caddy/start': { body: { ok: true, caddyfile: 'tea.example.com { }' } },
  '/_dsh/zen-remote/admin/wizard/tunnel/check-domain': { body: { ok: true, onCloudflare: true, zoneId: 'z1' } },
  '/_dsh/zen-remote/admin/wizard/tunnel/setup': { body: { ok: true, tunnelId: 't-new', publicUrl: 'https://tea.example.com' } },
}

const ROUTES = {
  caddyStop: '/_dsh/zen-remote/admin/wizard/caddy/stop',
  tunnelStop: '/_dsh/zen-remote/admin/wizard/tunnel/stop',
  cfToken: '/_dsh/zen-remote/admin/wizard/cf-token',
  trustProxy: '/_dsh/zen-remote/admin/wizard/trust-proxy',
  caddyStart: '/_dsh/zen-remote/admin/wizard/caddy/start',
  tunnelCheck: '/_dsh/zen-remote/admin/wizard/tunnel/check-domain',
  tunnelSetup: '/_dsh/zen-remote/admin/wizard/tunnel/setup',
  verify: '/_dsh/zen-remote/admin/wizard/verify',
}

test('host ingress start caddy：cf-token 先存 0600，写配置（host 回 127.0.0.1）再 caddy/start；停掉旧 tunnel 不停自己', async () => {
  const writeCalls = []
  const { mods, home, handle, ipc, canned } = await startHost({
    tag: 'start-caddy',
    writeConfig: (input) => { writeCalls.push(input); return { ok: true, values: {} } },
    admin: HOST_ADMIN,
    wizard: { ...WIZARD_PUBLIC, ...WIZARD_STOPS },
  })
  try {
    const ctx = makeCtx(mods, {
      argv: ['host', 'ingress', 'start', '--mode', 'caddy', '--domain', 'tea.example.com', '--cf-token', 'TOK123', '--email', 'me@example.com', '--https-port', '8443'],
      ipc,
    })
    const code = await mods.runHostIngressStartCommand(ctx)
    assert.equal(code, 0, `caddy start succeeds (${ctx.stdout.text()})`)
    const paths = canned.requests.filter((r) => r.path.startsWith('/_dsh/zen-remote/admin/wizard/')).map((r) => r.path)
    assert.ok(paths.includes(ROUTES.cfToken), 'the cf token is saved first')
    assert.deepEqual(canned.requests.find((r) => r.path === ROUTES.cfToken).body, { token: 'TOK123' })
    assert.ok(paths.includes(ROUTES.tunnelStop), 'the old tunnel process is stopped')
    assert.equal(paths.includes(ROUTES.caddyStop), false, 'the caddy process is NOT stopped when caddy is the target')
    assert.ok(paths.includes(ROUTES.caddyStart), 'caddy/start runs through IPC')
    assert.deepEqual(writeCalls, [{
      set: {
        role: 'host', host: '127.0.0.1', ingressMode: 'caddy',
        ingressDomain: 'tea.example.com', ingressHttpsPort: 8443, ingressAcmeEmail: 'me@example.com',
      },
    }])
    assert.match(ctx.stdout.text(), /公网接入已启动（caddy）/u)
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress start caddy：下载失败按错误码输出诊断与手动安装指引，退出码 1', async () => {
  const { mods, home, handle, ipc, canned } = await startHost({
    tag: 'start-caddy-fail',
    admin: HOST_ADMIN,
    wizard: {
      ...WIZARD_PUBLIC,
      ...WIZARD_STOPS,
      [ROUTES.caddyStart]: { body: { ok: false, error: 'download-failed', detail: 'network gone', installUrl: 'https://caddyserver.com' } },
    },
  })
  try {
    const ctx = makeCtx(mods, {
      argv: ['host', 'ingress', 'start', '--mode', 'caddy', '--domain', 'tea.example.com', '--cf-token', 'TOK123'],
      ipc,
    })
    const code = await mods.runHostIngressStartCommand(ctx)
    assert.equal(code, 1)
    const text = ctx.stdout.text()
    assert.match(text, /Caddy 下载失败/u)
    assert.match(text, /network gone/u)
    assert.match(text, /https:\/\/caddyserver\.com/u)
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress start cloudflared：check-domain → 写配置 → setup；同名隧道冲突时交互复用 existing[0].id 重调 setup', async () => {
  const writeCalls = []
  const setupBodies = []
  const { mods, home, handle, ipc, canned } = await startHost({
    tag: 'start-cf',
    writeConfig: (input) => { writeCalls.push(input); return { ok: true, values: {} } },
    admin: HOST_ADMIN,
    wizard: {
      ...WIZARD_PUBLIC,
      ...WIZARD_STOPS,
      [ROUTES.tunnelSetup]: (res, seen) => {
        setupBodies.push(seen.body)
        const body = setupBodies.length === 1
          ? { ok: false, reason: 'tunnel-conflict', existing: [{ id: 't-old', name: 'dsh-zen-remote' }] }
          : { ok: true, tunnelId: 't-old', publicUrl: 'https://tea.example.com' }
        const bytes = Buffer.from(JSON.stringify(body))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
    },
  })
  try {
    const prompter = fakePrompter({ confirms: [true] })
    const ctx = makeCtx(mods, {
      argv: ['host', 'ingress', 'start', '--mode', 'cloudflared', '--domain', 'tea.example.com', '--cf-token', 'TOK123'],
      ipc, interactive: true, prompter,
    })
    const code = await mods.runHostIngressStartCommand(ctx)
    assert.equal(code, 0, `the conflict is resolved by reusing the tunnel (${ctx.stdout.text()})`)
    assert.deepEqual(canned.requests.find((r) => r.path === ROUTES.tunnelCheck).body, { domain: 'tea.example.com' })
    assert.deepEqual(setupBodies, [
      { domain: 'tea.example.com' },
      { domain: 'tea.example.com', tunnelId: 't-old' },
    ], 'the reuse re-runs setup with the existing tunnel id')
    assert.ok(canned.requests.some((r) => r.path === ROUTES.caddyStop), 'the old caddy process is stopped')
    assert.equal(canned.requests.some((r) => r.path === ROUTES.tunnelStop), false, 'the tunnel is NOT stopped when cloudflared is the target')
    assert.deepEqual(writeCalls, [{ set: { role: 'host', host: '127.0.0.1', ingressMode: 'cloudflared', ingressDomain: 'tea.example.com' } }])
    assert.match(ctx.stdout.text(), /公网接入已启动（cloudflared）/u)
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress start cloudflared：同名隧道冲突非交互直接退出 1 并提示 --tunnel-id', async () => {
  const { mods, home, handle, ipc } = await startHost({
    tag: 'start-cf-conflict',
    admin: HOST_ADMIN,
    wizard: {
      ...WIZARD_PUBLIC,
      ...WIZARD_STOPS,
      [ROUTES.tunnelSetup]: { body: { ok: false, reason: 'tunnel-conflict', existing: [{ id: 't-old', name: 'dsh-zen-remote' }] } },
    },
  })
  try {
    const ctx = makeCtx(mods, {
      argv: ['host', 'ingress', 'start', '--mode', 'cloudflared', '--domain', 'tea.example.com', '--cf-token', 'TOK123'],
      ipc,
    })
    const code = await mods.runHostIngressStartCommand(ctx)
    assert.equal(code, 1)
    const text = ctx.stdout.text()
    assert.match(text, /--tunnel-id t-old/u)
    assert.match(text, /隧道创建失败/u)
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress start external：写配置 + 反代片段；非交互自动 trust-proxy，交互拒绝则跳过', async () => {
  const writeCalls = []
  const wizardWithSource = {
    ...WIZARD_PUBLIC,
    ...WIZARD_STOPS,
    '/_dsh/zen-remote/admin/wizard/status': {
      body: {
        ...WIZARD_PUBLIC['/_dsh/zen-remote/admin/wizard/status'].body,
        mode: 'external', publicUrl: 'https://tea.example.com', caddyRunning: false,
        lastForwardedSource: { ip: '10.0.0.7', at: 1730000000000 },
      },
    },
  }
  const { mods, home, handle, ipc, canned } = await startHost({
    tag: 'start-external',
    writeConfig: (input) => { writeCalls.push(input); return { ok: true, values: {} } },
    admin: HOST_ADMIN,
    wizard: wizardWithSource,
  })
  try {
    // 非交互（--yes 语义）：自动信任。
    const auto = makeCtx(mods, {
      argv: ['host', 'ingress', 'start', '--mode', 'external', '--public-url', 'https://tea.example.com'],
      ipc,
    })
    const autoCode = await mods.runHostIngressStartCommand(auto)
    assert.equal(autoCode, 0, `external start succeeds (${auto.stdout.text()})`)
    assert.deepEqual(writeCalls[0], { set: { role: 'host', ingressMode: 'external', ingressPublicUrl: 'https://tea.example.com' } })
    assert.deepEqual(canned.requests.find((r) => r.path === ROUTES.trustProxy).body, { ip: '10.0.0.7' })
    assert.match(auto.stdout.text(), /已自动加入信任列表/u)
    // external 不停任何托管进程？不——任务单：非 caddy 停 caddy、非 cloudflared 停 tunnel，两者都要停。
    assert.ok(canned.requests.some((r) => r.path === ROUTES.caddyStop))
    assert.ok(canned.requests.some((r) => r.path === ROUTES.tunnelStop))
    assert.match(auto.stdout.text(), /proxy_pass http:\/\/127\.0\.0\.1:3088;/u, 'the reverse-proxy snippet is printed')

    // 交互 + 拒绝：不调 trust-proxy，照常完成。
    writeCalls.length = 0
    const skip = makeCtx(mods, {
      argv: ['host', 'ingress', 'start', '--mode', 'external', '--public-url', 'https://tea.example.com'],
      ipc, interactive: true, prompter: fakePrompter({ confirms: [false] }),
    })
    assert.equal(await mods.runHostIngressStartCommand(skip), 0)
    assert.deepEqual(canned.requests.filter((r) => r.path === ROUTES.trustProxy).length, 1, 'a declined confirm skips the trust-proxy call')

    // 交互 + 同意：调 trust-proxy 并打印已加入文案。
    const add = makeCtx(mods, {
      argv: ['host', 'ingress', 'start', '--mode', 'external', '--public-url', 'https://tea.example.com'],
      ipc, interactive: true, prompter: fakePrompter({ confirms: [true] }),
    })
    assert.equal(await mods.runHostIngressStartCommand(add), 0)
    assert.deepEqual(canned.requests.filter((r) => r.path === ROUTES.trustProxy).length, 2)
    assert.match(add.stdout.text(), /已将 10\.0\.0\.7 加入信任列表/u)

    // 公网 http:// 被拒。
    const insecure = makeCtx(mods, {
      argv: ['host', 'ingress', 'start', '--mode', 'external', '--public-url', 'http://tea.example.com'],
      ipc,
    })
    assert.equal(await mods.runHostIngressStartCommand(insecure), 1)
    assert.match(insecure.stdout.text(), /公网地址必须使用 https:\/\//u)
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress start lan：写 host 0.0.0.0 + ingressMode off + lan URL，等待网关就绪后退出 0', async () => {
  const writeCalls = []
  const { mods, home, handle, ipc, canned } = await startHost({
    tag: 'start-lan',
    writeConfig: (input) => { writeCalls.push(input); return { ok: true, values: {} } },
    admin: HOST_ADMIN,
    wizard: WIZARD_LAN_ONLY,
  })
  try {
    const ctx = makeCtx(mods, {
      argv: ['host', 'ingress', 'start', '--mode', 'lan'],
      ipc, pollIntervalMs: 20,
    })
    const code = await mods.runHostIngressStartCommand(ctx)
    assert.equal(code, 0, `lan start succeeds (${ctx.stdout.text()})`)
    assert.deepEqual(writeCalls, [{ set: { role: 'host', host: '0.0.0.0', ingressMode: 'off', ingressPublicUrl: 'http://10.0.0.5:3088' } }])
    assert.ok(canned.requests.some((r) => r.path === ROUTES.caddyStop), 'the old caddy process is stopped')
    assert.ok(canned.requests.some((r) => r.path === ROUTES.tunnelStop), 'the old tunnel process is stopped')
    assert.ok(canned.requests.some((r) => r.path === '/_dsh/zen-remote/admin/status'), 'the readiness poll reads admin/status')
    assert.match(ctx.stdout.text(), /等待网关在 0\.0\.0\.0 重新就绪/u)
    assert.match(ctx.stdout.text(), /公网接入已启动（lan）/u)
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress start：非法模式与非交互缺参数报错', async () => {
  const mods = await loadModules()
  const bad = await startHost({ tag: 'start-bad-mode', admin: HOST_ADMIN, wizard: WIZARD_PUBLIC })
  const missing = await startHost({ tag: 'start-bad-missing', admin: HOST_ADMIN, wizard: WIZARD_LAN_ONLY })
  try {
    const badCtx = makeCtx(mods, { argv: ['host', 'ingress', 'start', '--mode', 'ngrok'], ipc: bad.ipc })
    assert.equal(await mods.runHostIngressStartCommand(badCtx), 1)
    assert.match(badCtx.stdout.text(), /接入方式只能是 caddy、cloudflared、external 或 lan/u)

    // 已保存配置为空（domain/publicUrl 均无）时，非交互缺参才报缺失。
    const missingCaddy = makeCtx(mods, { argv: ['host', 'ingress', 'start', '--mode', 'caddy'], ipc: missing.ipc })
    assert.equal(await mods.runHostIngressStartCommand(missingCaddy), 1)
    assert.match(missingCaddy.stdout.text(), /缺少必填参数 --domain/u)

    const missingExternal = makeCtx(mods, { argv: ['host', 'ingress', 'start', '--mode', 'external'], ipc: missing.ipc })
    assert.equal(await mods.runHostIngressStartCommand(missingExternal), 1)
    assert.match(missingExternal.stdout.text(), /缺少必填参数 --public-url/u)
  } finally {
    await stopHost(bad)
    await stopHost(missing)
  }
})

// ===========================================================================
// 验收 4b：ingress stop
// ===========================================================================

test('host ingress stop：--yes 非交互直接停两个进程；交互先确认——拒绝不动', async () => {
  const { mods, home, handle, ipc, canned } = await startHost({ tag: 'stop', admin: HOST_ADMIN, wizard: WIZARD_STOPS })
  try {
    const yes = makeCtx(mods, { argv: ['host', 'ingress', 'stop', '--yes', '--json'], ipc })
    assert.equal(await mods.runHostIngressStopCommand(yes), 0)
    assert.ok(canned.requests.some((r) => r.path === ROUTES.caddyStop))
    assert.ok(canned.requests.some((r) => r.path === ROUTES.tunnelStop))
    assert.deepEqual(JSON.parse(yes.stdout.text()), { ok: true })

    const yesText = makeCtx(mods, { argv: ['host', 'ingress', 'stop', '--yes'], ipc })
    assert.equal(await mods.runHostIngressStopCommand(yesText), 0)
    assert.match(yesText.stdout.text(), /公网接入已停止。/u)

    const no = makeCtx(mods, { argv: ['host', 'ingress', 'stop'], ipc, interactive: true, prompter: fakePrompter({ confirms: [false] }) })
    assert.equal(await mods.runHostIngressStopCommand(no), 0, 'a declined confirm is not a failure')
    assert.match(no.stdout.text(), /取消/u)

    const missing = makeCtx(mods, { argv: ['host', 'ingress', 'stop'], ipc })
    assert.equal(await mods.runHostIngressStopCommand(missing), 1, 'non-interactive without --yes refuses')
    assert.match(missing.stdout.text(), /缺少必填参数 --yes/u)
  } finally {
    await stopHost({ home, handle })
  }
})

// ===========================================================================
// 验收 5：ingress verify（三灯）
// ===========================================================================

const VERIFY_OK = { ok: true, pairingCode: 'WEBPAIR8', publicUrl: 'https://tea.example.com', expiresAt: Date.now() + 10 * 60 * 1000 }

test('host ingress verify：前两灯失败——输出两盏灯状态与原因，退出码 1', async () => {
  const { mods, home, handle, ipc, canned } = await startHost({
    tag: 'verify-fail',
    admin: HOST_ADMIN,
    wizard: {
      ...WIZARD_PUBLIC,
      [ROUTES.verify]: { body: { ok: false, reason: 'probe-failed', detail: { kind: 'reached', root: 'gateway-pairing-page', admin: 'gateway-200' } } },
    },
  })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'ingress', 'verify'], ipc })
    const code = await mods.runHostIngressVerifyCommand(ctx)
    assert.equal(code, 1)
    const text = ctx.stdout.text()
    assert.match(text, /验证公开地址 https:\/\/tea\.example\.com/u)
    assert.match(text, /第 1 盏：本地网关就绪 —— 完成/u, 'light 1 passed (the gateway was reachable)')
    assert.match(text, /第 2 盏：公开地址可达 —— 未通过/u, 'light 2 failed at the probe')
    assert.match(text, /管理面未按预期返回 403/u)
    assert.match(text, /X-Forwarded-/u)
    assert.deepEqual(canned.requests.find((r) => r.path === ROUTES.verify).body, { publicUrl: 'https://tea.example.com' })
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress verify：前两灯通过 + 轮询 pass——二维码 + 配对码 + 第 3 盏灯 + 持久化 ingressPublicUrl', async () => {
  const writeCalls = []
  let checks = 0
  const { mods, home, handle, ipc, canned } = await startHost({
    tag: 'verify-pass',
    writeConfig: (input) => { writeCalls.push(input); return { ok: true, values: {} } },
    admin: HOST_ADMIN,
    wizard: {
      ...WIZARD_PUBLIC,
      ...WIZARD_STOPS,
      [ROUTES.verify]: (res, seen) => {
        const body = seen.method === 'GET'
          ? (++checks === 1 ? { result: 'pending' } : { result: 'pass', deviceId: 'dev-new', at: 1730000001000 })
          : VERIFY_OK
        const bytes = Buffer.from(JSON.stringify(body))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
    },
  })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'ingress', 'verify'], ipc, pollIntervalMs: 20 })
    const code = await mods.runHostIngressVerifyCommand(ctx)
    assert.equal(code, 0, `the pairing lights all three (${ctx.stdout.text()})`)
    const text = ctx.stdout.text()
    assert.match(text, /第 1 盏：本地网关就绪 —— 完成/u)
    assert.match(text, /第 2 盏：公开地址可达 —— 完成/u)
    assert.match(text, /第 3 盏：真实配对完成 —— 完成/u)
    assert.match(text, /█/u, 'the terminal QR is drawn')
    assert.match(text, /配对码：WEBPAIR8/u)
    assert.match(text, /配对完成，三灯全亮。/u)
    assert.deepEqual(writeCalls, [{ set: { ingressPublicUrl: 'https://tea.example.com' } }], 'the verified URL is persisted')
    assert.ok(canned.requests.filter((r) => r.path === ROUTES.verify && r.method === 'GET').length >= 2, 'the poll ran')
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress verify：cookie-insecure——报 X-Forwarded-Proto 警告退出码 1', async () => {
  const writeCalls = []
  const { mods, home, handle, ipc } = await startHost({
    tag: 'verify-cookie',
    writeConfig: (input) => { writeCalls.push(input); return { ok: true, values: {} } },
    admin: HOST_ADMIN,
    wizard: {
      ...WIZARD_PUBLIC,
      ...WIZARD_STOPS,
      [ROUTES.verify]: (res, seen) => {
        const body = seen.method === 'GET'
          ? { result: 'cookie-insecure', deviceId: 'dev-new' }
          : VERIFY_OK
        const bytes = Buffer.from(JSON.stringify(body))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
    },
  })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'ingress', 'verify'], ipc, pollIntervalMs: 20 })
    const code = await mods.runHostIngressVerifyCommand(ctx)
    assert.equal(code, 1)
    const text = ctx.stdout.text()
    assert.match(text, /X-Forwarded-Proto: https/u)
    assert.match(text, /Secure/u)
    assert.deepEqual(writeCalls, [], 'the insecure verdict persists nothing')
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress verify：--no-wait 与 --json 跳过第 3 盏灯等待立即退出 0，不轮询', async () => {
  const { mods, home, handle, ipc, canned } = await startHost({
    tag: 'verify-nowait',
    admin: HOST_ADMIN,
    wizard: { ...WIZARD_PUBLIC, ...WIZARD_STOPS, [ROUTES.verify]: { body: VERIFY_OK } },
  })
  try {
    const noWait = makeCtx(mods, { argv: ['host', 'ingress', 'verify', '--no-wait'], ipc })
    assert.equal(await mods.runHostIngressVerifyCommand(noWait), 0)
    assert.match(noWait.stdout.text(), /已跳过手机配对等待，前两盏灯验证结果已保留。/u)
    assert.match(noWait.stdout.text(), /配对码：WEBPAIR8/u)
    assert.equal(canned.requests.filter((r) => r.path === ROUTES.verify && r.method === 'GET').length, 0, 'no polling happened')

    const json = makeCtx(mods, { argv: ['host', 'ingress', 'verify', '--json'], ipc })
    assert.equal(await mods.runHostIngressVerifyCommand(json), 0)
    const parsed = JSON.parse(json.stdout.text())
    assert.equal(parsed.ok, true)
    assert.equal(parsed.publicUrl, 'https://tea.example.com')
    assert.equal(parsed.pairingCode, 'WEBPAIR8')
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress verify：Ctrl-C（abortSignal）优雅跳过第 3 盏灯等待且退出码 0，不写配置', async () => {
  const writeCalls = []
  const ac = new AbortController()
  const { mods, home, handle, ipc, canned } = await startHost({
    tag: 'verify-abort',
    writeConfig: (input) => { writeCalls.push(input); return { ok: true, values: {} } },
    admin: HOST_ADMIN,
    wizard: {
      ...WIZARD_PUBLIC,
      ...WIZARD_STOPS,
      [ROUTES.verify]: (res, seen) => {
        if (seen.method === 'GET') ac.abort() // 第一次轮询时"用户按下 Ctrl-C"
        const body = seen.method === 'GET' ? { result: 'pending' } : VERIFY_OK
        const bytes = Buffer.from(JSON.stringify(body))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
    },
  })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'ingress', 'verify'], ipc, pollIntervalMs: 20, abortSignal: ac.signal })
    const code = await mods.runHostIngressVerifyCommand(ctx)
    assert.equal(code, 0, 'Ctrl-C during the wait is a graceful exit, not a failure')
    const text = ctx.stdout.text()
    assert.match(text, /已跳过手机配对等待，前两盏灯验证结果已保留。/u)
    assert.match(text, /第 1 盏：本地网关就绪 —— 完成/u)
    assert.match(text, /第 2 盏：公开地址可达 —— 完成/u)
    assert.doesNotMatch(text, /第 3 盏：真实配对完成 —— 完成/u)
    assert.deepEqual(writeCalls, [], 'a skipped wait persists nothing')
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress verify：配对码过期退出码 1', async () => {
  const { mods, home, handle, ipc } = await startHost({
    tag: 'verify-expired',
    admin: HOST_ADMIN,
    wizard: {
      ...WIZARD_PUBLIC,
      ...WIZARD_STOPS,
      [ROUTES.verify]: (res, seen) => {
        const body = seen.method === 'GET' ? { result: 'code-expired' } : VERIFY_OK
        const bytes = Buffer.from(JSON.stringify(body))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
    },
  })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'ingress', 'verify'], ipc, pollIntervalMs: 20 })
    assert.equal(await mods.runHostIngressVerifyCommand(ctx), 1)
    assert.match(ctx.stdout.text(), /配对码已过期/u)
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress verify：无地址可用且非交互——缺 --public-url 报错', async () => {
  const { mods, home, handle, ipc } = await startHost({
    tag: 'verify-nourl',
    admin: HOST_ADMIN,
    wizard: {
      '/_dsh/zen-remote/admin/wizard/status': {
        body: { ...WIZARD_LAN_ONLY['/_dsh/zen-remote/admin/wizard/status'].body, lanAddress: '' },
      },
    },
  })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'ingress', 'verify'], ipc })
    assert.equal(await mods.runHostIngressVerifyCommand(ctx), 1)
    assert.match(ctx.stdout.text(), /缺少必填参数 --public-url/u)
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress verify：LAN/Tailscale (http://) 本机自检 probe-failed 时自动 allowUnprobed 兜底出码，不锁死无头机', async () => {
  const verifyBodies = []
  const { mods, home, handle, ipc } = await startHost({
    tag: 'verify-lan-unprobed',
    admin: HOST_ADMIN,
    wizard: {
      '/_dsh/zen-remote/admin/wizard/status': {
        body: {
          ...WIZARD_LAN_ONLY['/_dsh/zen-remote/admin/wizard/status'].body,
          publicUrl: 'http://100.64.0.8:3088',
        },
      },
      [ROUTES.verify]: (res, seen) => {
        verifyBodies.push(seen.body)
        const body = seen.body?.allowUnprobed === true
          ? {
            ok: true,
            pairingCode: 'LAN88888',
            publicUrl: 'http://100.64.0.8:3088',
            expiresAt: Date.now() + 600_000,
            probeWarning: { kind: 'unreachable', reason: 'network' },
          }
          : { ok: false, reason: 'probe-failed', detail: { kind: 'unreachable', reason: 'network' } }
        const bytes = Buffer.from(JSON.stringify(body))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
    },
  })
  try {
    const ctx = makeCtx(mods, { argv: ['host', 'ingress', 'verify', '--no-wait'], ipc })
    const code = await mods.runHostIngressVerifyCommand(ctx)
    assert.equal(code, 0)
    assert.equal(verifyBodies.length, 2, 'retried with allowUnprobed: true')
    assert.equal(verifyBodies[1].allowUnprobed, true)
    const text = ctx.stdout.text()
    assert.match(text, /第 1 盏：本地网关就绪 —— 完成/u)
    assert.match(text, /已直接生成配对码/u)
    assert.match(text, /配对码：LAN88888/u)
  } finally {
    await stopHost({ home, handle })
  }
})

test('host ingress start cloudflared：交互询问 CF Token 前打印 4 项权限指引；start lan 多网卡时支持交互选择并等 gatewayActualHost=0.0.0.0', async () => {
  let wizardPolls = 0
  const { mods, home, handle, ipc } = await startHost({
    tag: 'cf-guide-and-lan-multi',
    admin: HOST_ADMIN,
    wizard: {
      ...WIZARD_STOPS,
      '/_dsh/zen-remote/admin/wizard/status': (res) => {
        wizardPolls += 1
        const body = {
          ok: true,
          mode: 'off',
          domain: 'tea.example.com',
          httpsPort: 443,
          publicUrl: '',
          cfTokenConfigured: false,
          tunnelTokenConfigured: false,
          caddyRunning: false,
          cloudflaredRunning: false,
          gatewayActualPort: 3088,
          gatewayActualHost: wizardPolls >= 3 ? '0.0.0.0' : '127.0.0.1',
          lanAddress: '10.0.0.5',
          lanAddresses: [
            { ip: '100.64.0.9', kind: 'tailscale', iface: 'tailscale0' },
            { ip: '10.0.0.5', kind: 'lan', iface: 'eth0' },
          ],
          lastHostProbe: null,
          lastExternalVerification: null,
          lastForwardedSource: null,
        }
        const bytes = Buffer.from(JSON.stringify(body))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
      [ROUTES.cfToken]: { body: { ok: true, configured: true } },
      [ROUTES.tunnelCheck]: { body: { ok: false, reason: 'auth' } },
    },
  })
  try {
    // 1) cloudflared 提示权限清单
    const cfCtx = makeCtx(mods, {
      argv: ['host', 'ingress', 'start', '--mode', 'cloudflared'],
      ipc,
      interactive: true,
      prompter: fakePrompter({ inputs: ['CF_TOK_123'] }),
    })
    assert.equal(await mods.runHostIngressStartCommand(cfCtx), 1)
    const cfOut = cfCtx.stdout.text()
    assert.match(cfOut, /Cloudflare API 令牌权限要求/u)
    assert.match(cfOut, /Cloudflare Tunnel · 编辑/u)
    assert.match(cfOut, /账户设置 .* 读取/u)

    // 2) lan 多网卡选择 + 等待 gatewayActualHost 变为 0.0.0.0
    const lanCtx = makeCtx(mods, {
      argv: ['host', 'ingress', 'start', '--mode', 'lan'],
      ipc,
      interactive: true,
      pollIntervalMs: 15,
      prompter: fakePrompter({ selects: [0] }),
    })
    assert.equal(await mods.runHostIngressStartCommand(lanCtx), 0)
    assert.ok(wizardPolls >= 3, 'waited until gatewayActualHost became 0.0.0.0')
  } finally {
    await stopHost({ home, handle })
  }
})
