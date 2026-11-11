/* dsh-zen-remote · CLI-3: status（--json / --debug）与 client 子命令族（pair / unpair / list）
 *
 * 驱动 BUILT lib/cli/commands-*.js（与 cli-ipc.test.cjs 同理：src 相对导入在
 * Node strip-only 模式下映射不了）。测试接缝三（SPEC）：真实 IPC Socket 服务端
 * + 受控 delegate 替身（admin/wizard/client 路由答罐装 JSON），命令层经真实
 * Unix socket 发请求；pair 成功用例挂真实 clientHandler + 真实 relayPool +
 * mock 远端 host（claim + 中继握手），交互问答走注入的 fake prompter，调试
 * 报告与轮询间隔用注入的时钟 / pollIntervalMs。断言退出码、stdout 双语文本、
 * JSON 输出与磁盘文件，不断言内部调用顺序。
 *
 * macOS 的 Unix socket 路径上限约 104 字节，临时目录继续用 /tmp 短前缀。
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ARGS_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'args.js')).href
const I18N_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'i18n.js')).href
const BOOTSTRAP_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'bootstrap.js')).href
const IPC_SERVER_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'ipc-server.js')).href
const IPC_CLIENT_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'ipc-client.js')).href
const STATUS_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'commands-status.js')).href
const CLIENT_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'commands-client.js')).href
const CLIENT_ROUTES_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'client-routes.js')).href
const RELAY_POOL_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'relay-pool.js')).href

function makeHome(tag) {
  return fs.mkdtempSync(path.join('/tmp', `dshzr3-${tag}-`))
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
}

function captureStdout() {
  const lines = []
  return { lines, write: (text) => lines.push(text), text: () => lines.join('') }
}

/** 一次性加载命令层与底座模块，测试内解构使用。 */
async function loadModules() {
  const [args, i18n, bootstrap, ipcServer, ipcClient, statusMod, clientMod, clientRoutes, relayPool] = await Promise.all([
    import(ARGS_URL), import(I18N_URL), import(BOOTSTRAP_URL),
    import(IPC_SERVER_URL), import(IPC_CLIENT_URL), import(STATUS_URL), import(CLIENT_URL),
    import(CLIENT_ROUTES_URL), import(RELAY_POOL_URL),
  ])
  return { ...args, ...i18n, ...bootstrap, ...ipcServer, ...ipcClient, ...statusMod, ...clientMod, ...clientRoutes, ...relayPool }
}

/** 罐装 delegate：admin/wizard/client 三张路由表，表项是
 * `{ status, body }` 或 `(res, seen) => void`；所有请求（含 POST 体）都
 * 记进 requests 供断言。 */
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
    json(res, entry.status ?? 200, entry.body)
  }
  return {
    requests,
    delegate: {
      role: () => overrides.role ?? 'client',
      serverName: () => overrides.serverName ?? '测试机',
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
function makeCtx(mods, { argv, ipc, lang = 'zh', interactive = false, prompter, stdout = captureStdout(), now, pollIntervalMs, cwd }) {
  return {
    args: mods.parseCliArgs(argv),
    ipc,
    t: mods.createTranslator(lang),
    interactive,
    ...(prompter === undefined ? {} : { prompter }),
    stdout,
    ...(now === undefined ? {} : { now }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(cwd === undefined ? {} : { cwd }),
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await fn()) return
    } catch (error) {
      lastError = error
    }
    await sleep(40)
  }
  assert.ok(await fn().catch(() => false), `${message}${lastError === undefined ? '' : ` (last error: ${lastError})`}`)
}

// ===========================================================================
// 验收 1：status 三种角色的双语文本与 --json 输出
// ===========================================================================

const HOST_ADMIN = {
  '/_dsh/zen-remote/admin/status': {
    body: {
      ok: true,
      gatewayReachable: true,
      gatewayStatus: 200,
      gateway: { state: 'running', port: 3088, devices: [
        { id: 'd1', name: '手机', role: 'web' },
        { id: 'd2', name: '台式机', role: 'desktop-client' },
      ] },
      config: {},
    },
  },
  '/_dsh/zen-remote/admin/shares': { body: { ok: true, shares: [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }] } },
}

const HOST_WIZARD = {
  '/_dsh/zen-remote/admin/wizard/status': {
    body: {
      ok: true, mode: 'caddy', domain: 'tea.example.com', httpsPort: 443,
      publicUrl: 'https://tea.example.com', cfTokenConfigured: true,
      tunnelTokenConfigured: false, caddyRunning: true, cloudflaredRunning: false,
      gatewayActualPort: 3088, lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null,
    },
  },
}

const CLIENT_SERVERS = [
  {
    entryId: 'e1', serverId: 'abcd1234', serverUrl: 'http://10.0.0.2:3080',
    serverName: 'srv', displayName: '远端茶机', state: 'online', nextRetryAt: null,
    compat: { identical: ['a', 'b'], different: [], unavailable: [] },
    pluginBridge: [
      { plugin: 'p1', bridged: true, localVersion: '1.0.0' },
      { plugin: 'p2', bridged: false, reason: 'consent-off', localVersion: '1.0.0' },
    ],
  },
  {
    entryId: 'e2', serverId: 'efef5678', serverUrl: 'http://100.64.0.9:3080',
    serverName: 'srv2', displayName: 'srv-2', state: 'offline', nextRetryAt: 1700000000000,
    lastError: 'boom',
    pluginBridge: [],
  },
]

const CLIENT_STATUS = {
  '/_dsh/zen-remote/client/status': {
    body: { state: 'online', maxServers: 8, servers: CLIENT_SERVERS, pluginBridge: [] },
  },
}

test('status：host 角色中文文本——角色 / 网关端口 / 接入方式 / 设备清单 / 共享会话数', async () => {
  const mods = await loadModules()
  const home = makeHome('status-host-zh')
  let handle
  try {
    const canned = cannedDelegate({ role: 'host', serverName: '茶壶机', profileName: 'web', admin: HOST_ADMIN, wizard: HOST_WIZARD })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctx = makeCtx(mods, { argv: ['status'], ipc })
    const code = await mods.runStatusCommand(ctx)
    assert.equal(code, 0)
    const text = ctx.stdout.text()
    assert.match(text, /当前角色：host（作为服务端/u)
    assert.match(text, /本机名称：茶壶机/u)
    assert.match(text, /插件版本：9\.9\.9-test/u)
    assert.match(text, /profile：web/u)
    assert.match(text, /host 状态：/u)
    assert.match(text, /网关监听中（端口 3088）/u)
    assert.match(text, /接入方式：caddy/u)
    assert.match(text, /公开地址：https:\/\/tea\.example\.com/u)
    assert.match(text, /Caddy 进程：运行中/u)
    assert.match(text, /已配对设备：2 台/u)
    assert.match(text, /手机（web）/u)
    assert.match(text, /台式机（desktop-client）/u)
    assert.match(text, /已开启远程共享的会话：3 个/u)
    assert.doesNotMatch(text, /client 状态：/u, 'a host answers no client section')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('status：host 角色 --json 输出——experimental/身份/host 板块，无 client 板块', async () => {
  const mods = await loadModules()
  const home = makeHome('status-host-json')
  let handle
  try {
    const canned = cannedDelegate({ role: 'host', serverName: '茶壶机', profileName: 'web', admin: HOST_ADMIN, wizard: HOST_WIZARD })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctx = makeCtx(mods, { argv: ['status', '--json'], ipc })
    const code = await mods.runStatusCommand(ctx)
    assert.equal(code, 0)
    const parsed = JSON.parse(ctx.stdout.text())
    assert.equal(parsed.experimental, true)
    assert.equal(parsed.role, 'host')
    assert.equal(parsed.pluginVersion, '9.9.9-test')
    assert.equal(parsed.pid, process.pid)
    assert.equal(parsed.serverName, '茶壶机')
    assert.equal(parsed.client, undefined)
    assert.equal(parsed.host.gateway.reachable, true)
    assert.equal(parsed.host.gateway.port, 3088)
    assert.equal(parsed.host.ingress.mode, 'caddy')
    assert.equal(parsed.host.ingress.publicUrl, 'https://tea.example.com')
    assert.equal(parsed.host.ingress.caddyRunning, true)
    assert.equal(parsed.host.ingress.cloudflaredRunning, false)
    assert.equal(parsed.host.devices.count, 2)
    assert.deepEqual(parsed.host.devices.list, [
      { name: '手机', role: 'web' },
      { name: '台式机', role: 'desktop-client' },
    ])
    assert.equal(parsed.host.sharedSessions, 3)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('status：client 角色中文与英文文本——N/8 计数、逐台状态、指纹与桥接、lastError', async () => {
  const mods = await loadModules()
  const home = makeHome('status-client')
  let handle
  try {
    const canned = cannedDelegate({ role: 'client', serverName: '笔名机', client: CLIENT_STATUS })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const zh = makeCtx(mods, { argv: ['status'], ipc })
    assert.equal(await mods.runStatusCommand(zh), 0)
    const zhText = zh.stdout.text()
    assert.match(zhText, /当前角色：client（连接远端 host）/u)
    assert.match(zhText, /已配对的 host：2 \/ 8 台/u)
    assert.match(zhText, /\[e1\] 远端茶机  http:\/\/10\.0\.0\.2:3080  在线/u)
    assert.match(zhText, /接口指纹一致/u)
    assert.match(zhText, /已桥接 1 个插件/u)
    assert.match(zhText, /\[e2\] srv-2  http:\/\/100\.64\.0\.9:3080  离线/u)
    assert.match(zhText, /上次错误：boom/u)
    assert.doesNotMatch(zhText, /host 状态：/u, 'a client answers no host section')

    const en = makeCtx(mods, { argv: ['status'], ipc, lang: 'en' })
    assert.equal(await mods.runStatusCommand(en), 0)
    const enText = en.stdout.text()
    assert.match(enText, /Current role: client \(connects out to a remote host\)/u)
    assert.match(enText, /Paired hosts: 2 \/ 8/u)
    assert.match(enText, /\[e1\] 远端茶机  http:\/\/10\.0\.0\.2:3080  online/u)
    assert.match(enText, /interface fingerprints identical/u)
    assert.match(enText, /1 plugin\(s\) bridged/u)
    assert.match(enText, /last error: boom/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('status：client 角色 --json——client 板块带 maxServers 与 servers 原样行', async () => {
  const mods = await loadModules()
  const home = makeHome('status-client-json')
  let handle
  try {
    const canned = cannedDelegate({ role: 'client', client: CLIENT_STATUS })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctx = makeCtx(mods, { argv: ['status', '--json'], ipc })
    assert.equal(await mods.runStatusCommand(ctx), 0)
    const parsed = JSON.parse(ctx.stdout.text())
    assert.equal(parsed.experimental, true)
    assert.equal(parsed.role, 'client')
    assert.equal(parsed.host, undefined)
    assert.equal(parsed.client.maxServers, 8)
    assert.equal(parsed.client.servers.length, 2)
    assert.equal(parsed.client.servers[0].entryId, 'e1')
    assert.equal(parsed.client.servers[0].displayName, '远端茶机')
    assert.equal(parsed.client.servers[0].state, 'online')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('status：peer 角色标注「peer（节点端）」，节点端板块与 host 板块如实渲染', async () => {
  const mods = await loadModules()
  const home = makeHome('status-peer')
  let handle
  try {
    const peerClient = {
      '/_dsh/zen-remote/client/peer/status': {
        body: {
          configured: true, nodeId: 'aa1b2c3d', gatewayState: 'authorized',
          networkId: 'abcdef1234567890', gatewayOrigin: 'https://gw.example.com', maxPeers: 8,
          peers: [{ nodeId: 'aa1b2c3d', name: '本机', mounted: true, path: 'lan', rttMs: 3 }],
        },
      },
    }
    const canned = cannedDelegate({ role: 'peer', serverName: '手工机', admin: HOST_ADMIN, wizard: HOST_WIZARD, client: peerClient })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctx = makeCtx(mods, { argv: ['status'], ipc })
    assert.equal(await mods.runStatusCommand(ctx), 0)
    const text = ctx.stdout.text()
    assert.match(text, /peer（节点端）/u)
    assert.match(text, /本机名称：手工机/u)
    // servesRole/connectsRole 对 peer 都为 true（两半都挂载）：节点端板块与
    // 手机网关板块同时如实渲染。
    assert.match(text, /节点端（虚拟网络互通）：/u)
    assert.match(text, /本机节点 ID：aa1b2c3d/u)
    assert.match(text, /网关接入状态：已接入/u)
    assert.match(text, /host 状态：/u)
    assert.match(text, /网关监听中（端口 3088）/u)
    const en = makeCtx(mods, { argv: ['status'], ipc, lang: 'en' })
    await mods.runStatusCommand(en)
    assert.match(en.stdout.text(), /peer \(peer node\)/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 2：status --debug 生成脱敏诊断 JSON 文件
// ===========================================================================

const DEBUG_REPORT = {
  '/_dsh/zen-remote/client/debug-report': {
    body: {
      _meta: { role: 'host', pluginVersion: '9.9.9-test', platform: 'darwin arm64' },
      config: { serverUrl: 'https://address-domain:443' },
      status: { state: 'unpaired' },
      gateway: { reachable: true },
      logs: [{ t: 1, level: 'info', msg: 'boot' }],
    },
  },
}

test('status --debug：显式路径写出五板块 JSON，--json 同步打印 { ok, path, report }，双语提示', async () => {
  const mods = await loadModules()
  const home = makeHome('debug-explicit')
  let handle
  try {
    const canned = cannedDelegate({ role: 'host', client: DEBUG_REPORT })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const outPath = path.join(home, 'report.json')
    const ctx = makeCtx(mods, { argv: ['status', '--debug', outPath, '--json'], ipc })
    assert.equal(await mods.runStatusCommand(ctx), 0)
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    for (const key of ['_meta', 'config', 'status', 'logs']) {
      assert.ok(key in written, `the report file carries ${key}`)
    }
    assert.deepEqual(written.logs, [{ t: 1, level: 'info', msg: 'boot' }])
    const printed = JSON.parse(ctx.stdout.text().slice(0, ctx.stdout.text().lastIndexOf('}') + 1))
    assert.equal(printed.ok, true)
    assert.equal(printed.path, outPath)
    assert.deepEqual(printed.report, written)
    assert.match(ctx.stdout.text(), /诊断报告已写出/u)
    const en = makeCtx(mods, { argv: ['status', '--debug', outPath], ipc, lang: 'en' })
    assert.equal(await mods.runStatusCommand(en), 0)
    assert.match(en.stdout.text(), /Debug report written/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('status --debug：缺省在 cwd 生成 zen-remote-debug-<role>-<yyyymmdd-hhmm>.json（注入时钟）', async () => {
  const mods = await loadModules()
  const home = makeHome('debug-default')
  let handle
  try {
    const canned = cannedDelegate({ role: 'host', client: DEBUG_REPORT })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const cwd = makeHome('debug-cwd')
    try {
      const now = () => new Date(2026, 10, 7, 14, 25)
      const ctx = makeCtx(mods, { argv: ['status', '--debug'], ipc, now, cwd })
      assert.equal(await mods.runStatusCommand(ctx), 0)
      const expected = path.join(cwd, 'zen-remote-debug-host-20261107-1425.json')
      assert.ok(fs.existsSync(expected), `the default filename lands in cwd: ${ctx.stdout.text()}`)
      assert.match(ctx.stdout.text(), /zen-remote-debug-host-20261107-1425\.json/u)
    } finally {
      cleanup(cwd)
    }
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('status --debug：错误信封（ok:false）不得写盘，退出码 1 并报获取失败', async () => {
  const mods = await loadModules()
  const home = makeHome('debug-envelope')
  let handle
  try {
    const canned = cannedDelegate({
      role: 'host',
      client: { '/_dsh/zen-remote/client/debug-report': { status: 503, body: { ok: false, error: { code: 'unavailable' } } } },
    })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const outPath = path.join(home, 'should-not-exist.json')
    const ctx = makeCtx(mods, { argv: ['status', '--debug', outPath], ipc })
    assert.equal(await mods.runStatusCommand(ctx), 1, 'an error envelope is a failed debug fetch')
    assert.equal(fs.existsSync(outPath), false, 'the error envelope never lands in a file')
    assert.match(ctx.stdout.text(), /诊断报告获取失败/u)
    assert.match(ctx.stdout.text(), /unavailable/u, 'the failure names the error code')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 3：host 角色下 client 子命令被角色门禁拦截（退出码 1 + 双语提示）
// ===========================================================================

test('角色门禁：host 角色跑 client list/pair/unpair 全部退出码 1，提示切换命令，且不发任何 client 路由请求', async () => {
  const mods = await loadModules()
  const home = makeHome('gate-host')
  let handle
  try {
    const canned = cannedDelegate({ role: 'host', client: CLIENT_STATUS })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctxs = [
      makeCtx(mods, { argv: ['client', 'list'], ipc }),
      makeCtx(mods, { argv: ['client', 'pair', 'http://10.0.0.2:3080', '--code', 'ABCD2345'], ipc }),
      makeCtx(mods, { argv: ['client', 'unpair', 'e1'], ipc }),
    ]
    const codes = [
      await mods.runClientListCommand(ctxs[0]),
      await mods.runClientPairCommand(ctxs[1]),
      await mods.runClientUnpairCommand(ctxs[2]),
    ]
    for (const [i, command] of ['list', 'pair', 'unpair'].entries()) {
      assert.equal(codes[i], 1, `client ${command} exits 1 under the host role`)
      const text = ctxs[i].stdout.text()
      assert.match(text, /当前 role 是 host，不连接远端 host/u, `${command} names the role verdict`)
      assert.match(text, /dsh-zen-remote setup --role client/u, `${command} names the switch command`)
    }
    // 全程除 ping（内置路由）外没有任何 client 路由请求外泄。
    assert.deepEqual(canned.requests.filter((r) => r.path.startsWith('/_dsh/zen-remote/client/')), [])
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 4：client pair
// ===========================================================================

test('client pair：公网 http:// 地址被本地预校验拒绝（退出码 1，不发 claim）', async () => {
  const mods = await loadModules()
  const home = makeHome('pair-public-http')
  let handle
  try {
    const canned = cannedDelegate({ role: 'client', client: CLIENT_STATUS })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctx = makeCtx(mods, { argv: ['client', 'pair', 'http://tea.example.com', '--code', 'ABCD2345'], ipc })
    assert.equal(await mods.runClientPairCommand(ctx), 1)
    assert.match(ctx.stdout.text(), /公网地址必须使用 https:\/\//u)
    assert.deepEqual(canned.requests.filter((r) => r.path.endsWith('/claim')), [], 'no claim round-trip for a refused address')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('client pair：内网 http 地址兑换成功写入连接池并轮询至 online；--name 先同步本机名', async () => {
  const mods = await loadModules()
  const home = makeHome('pair-success')
  // 模拟远端 host：桌面配对码兑换 + 中继握手（与 cli-ipc.test.cjs 同一 mock 形状）。
  const mock = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const send = (status, body) => {
        const bytes = Buffer.from(JSON.stringify(body))
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      }
      if (req.method === 'POST' && req.url === '/lan-gate/pair/claim-desktop') {
        send(200, { ok: true, token: 'tok-cli-3', id: 'dev-3', name: 'cli-pair-test' })
        return
      }
      if (req.method === 'POST' && req.url === '/_dsh/zen-remote/relay/v1/handshake') {
        send(200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '远端茶机', dshVersion: '0.0.0', fingerprints: {} })
        return
      }
      send(404, { ok: false })
    })
  })
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const mockUrl = `http://127.0.0.1:${mock.address().port}`

  const pool = mods.createRelayPool({ stateFile: path.join(home, 'zen-remote-state.json') })
  const clientHandler = mods.createClientHandler({
    admit: () => ({ peer: {} }),
    getRowConfig: () => ({}),
    pool,
    getLogSnapshot: () => [],
    getPluginVersion: () => '0.0.0-test',
  })
  const writeCalls = []
  const { delegate } = cannedDelegate({
    role: 'client',
    serverName: '笔名机',
    writeConfig: (input) => { writeCalls.push(input); return { ok: true, values: {} } },
  })
  delegate.clientHandler = clientHandler
  let handle
  try {
    handle = await mods.createCliIpcServer({ dshHome: home, delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctx = makeCtx(mods, {
      argv: ['client', 'pair', mockUrl, '--code', 'ABCD2345', '--name', '我的笔名'],
      ipc, pollIntervalMs: 20,
    })
    const code = await mods.runClientPairCommand(ctx)
    assert.equal(code, 0, `pair succeeds end to end (${ctx.stdout.text()})`)
    assert.deepEqual(writeCalls, [{ set: { serverName: '我的笔名' } }], '--name syncs through the config route first')
    const text = ctx.stdout.text()
    assert.match(text, /正在兑换配对码并握手/u)
    assert.match(text, /本地配对凭证/u)
    assert.match(text, /host 连接/u)
    assert.match(text, /会话与插件同步/u)
    assert.match(text, /对端 host：远端茶机/u)
    await waitFor(() => pool.entries().length === 1 && pool.entries()[0].client.state === 'online', 5000, 'the pool entry reached the mock relay')
    // 轮询完成后的状态表里，该条目按 online 报告。
    const status = JSON.parse(JSON.stringify(await ipc.getStatus()))
    assert.equal(status.servers.length, 1)
    assert.equal(status.servers[0].state, 'online')
  } finally {
    if (handle !== undefined) await handle.close()
    pool.stop()
    await new Promise((resolve) => mock.close(resolve))
    cleanup(home)
  }
})

test('client pair：池满 8 台 claim 回 409 limit-reached，非交互直接退出码 1', async () => {
  const mods = await loadModules()
  const home = makeHome('pair-limit')
  let handle
  try {
    const canned = cannedDelegate({
      role: 'client',
      client: { '/_dsh/zen-remote/client/claim': { status: 409, body: { ok: false, code: 'limit-reached' } } },
    })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctx = makeCtx(mods, { argv: ['client', 'pair', 'http://10.0.0.2:3080', '--code', 'ABCD2345'], ipc })
    assert.equal(await mods.runClientPairCommand(ctx), 1)
    assert.match(ctx.stdout.text(), /已达 8 台上限/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('client pair：交互模式错码只重问配对码（不重问地址），二问通过后轮询至 online', async () => {
  const mods = await loadModules()
  const home = makeHome('pair-retry-code')
  const serverUrl = 'http://10.0.0.2:3080'
  let claimCalls = 0
  const canned = cannedDelegate({
    role: 'client',
    serverName: '笔名机',
    client: {
      '/_dsh/zen-remote/client/claim': (res) => {
        claimCalls += 1
        if (claimCalls === 1) {
          const bytes = Buffer.from(JSON.stringify({ ok: false, code: 'bad-code' }))
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
          res.end(bytes)
          return
        }
        const bytes = Buffer.from(JSON.stringify({ ok: true, entryId: 'e9', deviceId: 'dev-9', deviceName: 'dev', serverUrl }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
      '/_dsh/zen-remote/client/status': {
        body: {
          state: 'online', maxServers: 8,
          servers: [{ entryId: 'e9', serverId: 'srv9', serverUrl, serverName: '远端茶机', displayName: '远端茶机', state: 'online', nextRetryAt: null, pluginBridge: [] }],
        },
      },
    },
  })
  let handle
  try {
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const prompter = fakePrompter({ inputs: ['ABC12345', 'ABCD2345'] })
    const ctx = makeCtx(mods, {
      argv: ['client', 'pair', serverUrl],
      ipc, interactive: true, prompter, pollIntervalMs: 20,
    })
    const code = await mods.runClientPairCommand(ctx)
    assert.equal(code, 0, `the retry loop lands online (${ctx.stdout.text()})`)
    const inputQuestions = prompter.calls.filter((c) => c.kind === 'input').map((c) => c.question)
    assert.equal(inputQuestions.length, 2, 'exactly two prompts: both pairing-code asks')
    const codeQuestion = mods.createTranslator('zh')('client.prompt.code')
    assert.deepEqual(inputQuestions, [codeQuestion, codeQuestion], 'only the code was re-asked — never the address')
    assert.match(ctx.stdout.text(), /配对码错误或已过期/u)
    assert.match(ctx.stdout.text(), /对端 host：远端茶机/u)
    assert.equal(claimCalls, 2, 'the claim route ran once per entered code')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('client pair：交互模式 --code 传错码时重试必须重问新码，绝不拿旧参数死循环', async () => {
  const mods = await loadModules()
  const home = makeHome('pair-flag-code-retry')
  const serverUrl = 'http://10.0.0.2:3080'
  const claimedCodes = []
  const canned = cannedDelegate({
    role: 'client',
    serverName: '笔名机',
    client: {
      '/_dsh/zen-remote/client/claim': (res, seen) => {
        claimedCodes.push(seen.body?.code)
        if (claimedCodes.length > 4) {
          // 保险丝：死循环会让这个断言把测试打红，而不是让整个进程挂死。
          assert.fail(`infinite retry loop: claim ran ${claimedCodes.length} times with codes ${claimedCodes}`)
        }
        if (claimedCodes.length === 1) {
          const bytes = Buffer.from(JSON.stringify({ ok: false, code: 'bad-code' }))
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
          res.end(bytes)
          return
        }
        const bytes = Buffer.from(JSON.stringify({ ok: true, entryId: 'e9', deviceId: 'dev-9', deviceName: 'dev', serverUrl }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
      '/_dsh/zen-remote/client/status': {
        body: {
          state: 'online', maxServers: 8,
          servers: [{ entryId: 'e9', serverId: 'srv9', serverUrl, serverName: '远端茶机', displayName: '远端茶机', state: 'online', nextRetryAt: null, pluginBridge: [] }],
        },
      },
    },
  })
  let handle
  try {
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    // --code 00000000 是命令行传入的错码：重试分支必须忽略它，向 prompter 要新码。
    const prompter = fakePrompter({ inputs: ['12345678'] })
    const ctx = makeCtx(mods, {
      argv: ['client', 'pair', serverUrl, '--code', '00000000'],
      ipc, interactive: true, prompter, pollIntervalMs: 20,
    })
    const code = await mods.runClientPairCommand(ctx)
    assert.equal(code, 0, `the flag-provided wrong code is retried once, not forever (${ctx.stdout.text()})`)
    assert.deepEqual(claimedCodes, ['00000000', '12345678'], 'first claim carries the flag code, the retry the prompted one')
    const inputCalls = prompter.calls.filter((c) => c.kind === 'input')
    assert.equal(inputCalls.length, 1, 'exactly one new-code prompt after the bad-code verdict')
    assert.match(ctx.stdout.text(), /对端 host：远端茶机/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('client pair：交互模式 role-mismatch 同样只重问配对码（地址保留）并成功配对', async () => {
  const mods = await loadModules()
  const home = makeHome('pair-role-mismatch-retry')
  const serverUrl = 'http://10.0.0.2:3080'
  const claimedCodes = []
  const canned = cannedDelegate({
    role: 'client',
    serverName: '笔名机',
    client: {
      '/_dsh/zen-remote/client/claim': (res, seen) => {
        claimedCodes.push(seen.body?.code)
        if (claimedCodes.length > 4) {
          assert.fail(`infinite retry loop: claim ran ${claimedCodes.length} times`)
        }
        if (claimedCodes.length === 1) {
          const bytes = Buffer.from(JSON.stringify({ ok: false, code: 'role-mismatch', message: '桌面客户端码才行' }))
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
          res.end(bytes)
          return
        }
        const bytes = Buffer.from(JSON.stringify({ ok: true, entryId: 'e9', deviceId: 'dev-9', deviceName: 'dev', serverUrl }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
      '/_dsh/zen-remote/client/status': {
        body: {
          state: 'online', maxServers: 8,
          servers: [{ entryId: 'e9', serverId: 'srv9', serverUrl, serverName: '远端茶机', displayName: '远端茶机', state: 'online', nextRetryAt: null, pluginBridge: [] }],
        },
      },
    },
  })
  let handle
  try {
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const prompter = fakePrompter({ inputs: ['ABCD2345'] })
    const ctx = makeCtx(mods, {
      argv: ['client', 'pair', serverUrl, '--code', 'WEB12345'],
      ipc, interactive: true, prompter, pollIntervalMs: 20,
    })
    const code = await mods.runClientPairCommand(ctx)
    assert.equal(code, 0, `role-mismatch falls back to the code prompt (${ctx.stdout.text()})`)
    assert.deepEqual(claimedCodes, ['WEB12345', 'ABCD2345'], 'the web code is retried with the prompted desktop code')
    const inputQuestions = prompter.calls.filter((c) => c.kind === 'input').map((c) => c.question)
    const codeQuestion = mods.createTranslator('zh')('client.prompt.code')
    assert.deepEqual(inputQuestions, [codeQuestion], 'only the code was re-asked — never the address')
    assert.match(ctx.stdout.text(), /桌面客户端码才行/u, 'the refusal carries the reason')
    assert.match(ctx.stdout.text(), /对端 host：远端茶机/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 5：client unpair
// ===========================================================================

const UNPAIR_SERVERS = {
  '/_dsh/zen-remote/client/status': {
    body: {
      state: 'online', maxServers: 8,
      servers: [
        { entryId: 'e1', serverId: 'a1', serverUrl: 'http://10.0.0.2:3080', serverName: 'srv', displayName: '远端茶机', state: 'online', nextRetryAt: null, pluginBridge: [] },
        { entryId: 'e2', serverId: 'a2', serverUrl: 'http://100.64.0.9:3080', serverName: 'srv2', displayName: 'srv-2', state: 'offline', nextRetryAt: null, pluginBridge: [] },
      ],
    },
  },
}

test('client unpair：按 entryId 移除（POST { entryId }），退出码 0', async () => {
  const mods = await loadModules()
  const home = makeHome('unpair-id')
  let handle
  try {
    const canned = cannedDelegate({
      role: 'client',
      client: { ...UNPAIR_SERVERS, '/_dsh/zen-remote/client/unpair': { body: { ok: true, removed: 1 } } },
    })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctx = makeCtx(mods, { argv: ['client', 'unpair', 'e1'], ipc })
    assert.equal(await mods.runClientUnpairCommand(ctx), 0)
    const unpair = canned.requests.find((r) => r.path.endsWith('/unpair'))
    assert.deepEqual(unpair.body, { entryId: 'e1' })
    assert.match(ctx.stdout.text(), /已移除 远端茶机。/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('client unpair：按 hostUrl 移除——地址先归一化再匹配条目', async () => {
  const mods = await loadModules()
  const home = makeHome('unpair-url')
  let handle
  try {
    const canned = cannedDelegate({
      role: 'client',
      client: { ...UNPAIR_SERVERS, '/_dsh/zen-remote/client/unpair': { body: { ok: true, removed: 1 } } },
    })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctx = makeCtx(mods, { argv: ['client', 'unpair', 'http://10.0.0.2:3080/'], ipc })
    assert.equal(await mods.runClientUnpairCommand(ctx), 0)
    const unpair = canned.requests.find((r) => r.path.endsWith('/unpair'))
    assert.deepEqual(unpair.body, { entryId: 'e1' }, 'the trailing slash normalizes away and matches e1')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('client unpair：未匹配目标报未找到并退出码 1', async () => {
  const mods = await loadModules()
  const home = makeHome('unpair-miss')
  let handle
  try {
    const canned = cannedDelegate({ role: 'client', client: UNPAIR_SERVERS })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctx = makeCtx(mods, { argv: ['client', 'unpair', 'zzz'], ipc })
    assert.equal(await mods.runClientUnpairCommand(ctx), 1)
    assert.match(ctx.stdout.text(), /没有找到 zzz/u)
    assert.deepEqual(canned.requests.filter((r) => r.path.endsWith('/unpair')), [], 'nothing was removed')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('client unpair：--all 交互模式先确认——拒绝则不动，同意则清空全部', async () => {
  const mods = await loadModules()
  const home = makeHome('unpair-all-interactive')
  let handle
  try {
    const canned = cannedDelegate({
      role: 'client',
      client: { ...UNPAIR_SERVERS, '/_dsh/zen-remote/client/unpair': { body: { ok: true, removed: 2 } } },
    })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)

    // 拒绝确认：不发生任何移除请求，退出码 0（用户主动取消）。
    const noPrompter = fakePrompter({ confirms: [false] })
    const no = makeCtx(mods, {
      argv: ['client', 'unpair', '--all'], ipc, interactive: true,
      prompter: noPrompter,
    })
    assert.equal(await mods.runClientUnpairCommand(no), 0)
    const confirmQuestion = noPrompter.calls[0]?.question
    assert.equal(confirmQuestion, mods.createTranslator('zh')('clientUnpair.confirmAll').replace('{count}', '2'),
      'the confirm names the exact count')
    assert.deepEqual(canned.requests.filter((r) => r.path.endsWith('/unpair')), [], 'a declined confirm removes nothing')
    assert.match(no.stdout.text(), /取消/u)

    // 同意确认：POST { all: true }。
    const yes = makeCtx(mods, {
      argv: ['client', 'unpair', '--all'], ipc, interactive: true,
      prompter: fakePrompter({ confirms: [true] }),
    })
    assert.equal(await mods.runClientUnpairCommand(yes), 0)
    const unpair = canned.requests.find((r) => r.path.endsWith('/unpair'))
    assert.deepEqual(unpair.body, { all: true })
    assert.match(yes.stdout.text(), /已移除全部 2 台已配对的 host。/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('client unpair：--all --yes 非交互直接清空，不提问', async () => {
  const mods = await loadModules()
  const home = makeHome('unpair-all-yes')
  let handle
  try {
    const canned = cannedDelegate({
      role: 'client',
      client: { ...UNPAIR_SERVERS, '/_dsh/zen-remote/client/unpair': { body: { ok: true, removed: 2 } } },
    })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const prompter = fakePrompter({})
    const ctx = makeCtx(mods, { argv: ['client', 'unpair', '--all', '--yes'], ipc, prompter })
    assert.equal(await mods.runClientUnpairCommand(ctx), 0)
    const unpair = canned.requests.find((r) => r.path.endsWith('/unpair'))
    assert.deepEqual(unpair.body, { all: true })
    assert.equal(prompter.calls.length, 0, '--yes skips every question')
    assert.match(ctx.stdout.text(), /已移除全部 2 台已配对的 host。/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// client list
// ===========================================================================

test('client list：表头 N/8 + 逐行条目；--json 原样输出 { ok, count, maxServers, servers }', async () => {
  const mods = await loadModules()
  const home = makeHome('client-list')
  let handle
  try {
    const canned = cannedDelegate({ role: 'client', client: CLIENT_STATUS })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)

    const zh = makeCtx(mods, { argv: ['client', 'list'], ipc })
    assert.equal(await mods.runClientListCommand(zh), 0)
    const text = zh.stdout.text()
    assert.match(text, /已配对的 host（2 \/ 8）/u)
    assert.match(text, /\[e1\] 远端茶机  http:\/\/10\.0\.0\.2:3080  在线/u)
    assert.match(text, /\[e2\] srv-2  http:\/\/100\.64\.0\.9:3080  离线/u)

    const json = makeCtx(mods, { argv: ['client', 'list', '--json'], ipc })
    assert.equal(await mods.runClientListCommand(json), 0)
    const parsed = JSON.parse(json.stdout.text())
    assert.deepEqual(parsed, { ok: true, count: 2, maxServers: 8, servers: CLIENT_SERVERS })
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('client list：满 8 台时表头后追加达到上限提示', async () => {
  const mods = await loadModules()
  const home = makeHome('client-list-full')
  let handle
  try {
    const servers = []
    for (let i = 1; i <= 8; i += 1) {
      servers.push({ entryId: `e${i}`, serverId: `s${i}`, serverUrl: `http://10.0.0.${i}:3080`, serverName: `s${i}`, displayName: `s-${i}`, state: 'online', nextRetryAt: null, pluginBridge: [] })
    }
    const canned = cannedDelegate({
      role: 'client',
      client: { '/_dsh/zen-remote/client/status': { body: { state: 'online', maxServers: 8, servers } } },
    })
    handle = await mods.createCliIpcServer({ dshHome: home, delegate: canned.delegate })
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const ctx = makeCtx(mods, { argv: ['client', 'list'], ipc })
    assert.equal(await mods.runClientListCommand(ctx), 0)
    const text = ctx.stdout.text()
    assert.match(text, /已配对的 host（8 \/ 8）/u)
    assert.match(text, /已达 8 台上限/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})
