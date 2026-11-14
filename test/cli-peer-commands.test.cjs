/* dsh-zen-remote · PG-10: --role peer 解锁 + peer join|status|trust|leave 子命令族
 *
 * 驱动 BUILT lib/cli/*.js（与其余 CLI 测试同理：src 相对导入在 Node strip-only
 * 模式下映射不了）。测试接缝三（SPEC）：真实 IPC Socket 服务端 + 受控 delegate
 * 替身（admin/wizard/client 路由答罐装 JSON，写配置可联动翻转 delegate 角色），
 * 命令层经真实 Unix socket 发请求；交互问答走注入的 fake prompter；轮询间隔与
 * 等待预算用注入的 pollIntervalMs / --wait。断言退出码、stdout 双语文本、JSON
 * 输出与路由请求记录，不断言内部调用顺序。
 *
 * PC-14b-fix1 Required 4：socket 实际文件必须留在副本内。node:test 默认每个
 * 文件独立进程，模块级把 cwd 固定到副本 .scratch 下的临时目录，IPC 服务端与
 * 客户端共用短相对路径（`h<N>/zen-remote-cli.sock`，约 24 字符）—— sun_path
 * 只存这段短路径，绕开 macOS 104 字节上限；socket 文件与测试状态目录全部落在
 * 副本 scratch 内，不写 /tmp，进程退出时统一清理。
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
const MAIN_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'main.js')).href
const BOOTSTRAP_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'bootstrap.js')).href
const IPC_SERVER_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'ipc-server.js')).href
const IPC_CLIENT_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'ipc-client.js')).href
const STATUS_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'commands-status.js')).href
const CLIENT_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'commands-client.js')).href
const PEER_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'commands-peer.js')).href
const HOST_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'commands-host.js')).href
const SETUP_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'command-setup.js')).href

const INVITE = 'zr-net://gw.example.com/abcdef1234567890#join-key'

const ROUTES = {
  peerStatus: '/_dsh/zen-remote/client/peer/status',
  peerJoin: '/_dsh/zen-remote/client/peer/join',
  peerTrust: '/_dsh/zen-remote/client/peer/trust',
  peerLeave: '/_dsh/zen-remote/client/peer/leave',
  caddyStop: '/_dsh/zen-remote/admin/wizard/caddy/stop',
  tunnelStop: '/_dsh/zen-remote/admin/wizard/tunnel/stop',
  adminStatus: '/_dsh/zen-remote/admin/status',
  adminPair: '/_dsh/zen-remote/admin/pair',
  wizardStatus: '/_dsh/zen-remote/admin/wizard/status',
  wizardVerify: '/_dsh/zen-remote/admin/wizard/verify',
  clientStatus: '/_dsh/zen-remote/client/status',
}

const ORIGINAL_CWD = process.cwd()
const FIX1_SCRATCH = fs.mkdtempSync(path.join(path.join(__dirname, '..', '.scratch'), 'pc-14b-'))
process.chdir(FIX1_SCRATCH)
process.on('exit', () => {
  try {
    process.chdir(ORIGINAL_CWD)
    fs.rmSync(FIX1_SCRATCH, { recursive: true, force: true })
  } catch { /* best effort */ }
})

let homeSeq = 0

/** 副本 scratch 内的短相对 home 目录（socket 随之落副本内，见文件头）。 */
function makeHome(_tag) {
  const dir = `h${++homeSeq}`
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
}

function captureStdout() {
  const lines = []
  return { lines, write: (text) => lines.push(text), text: () => lines.join('') }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 按需加载 BUILT 模块（跑红阶段允许部分模块尚不存在——只加载该用例需要的）。 */
async function loadModules(...urls) {
  const mods = await Promise.all(urls.map((url) => import(url)))
  return Object.assign({}, ...mods)
}

// ---- 罐头数据 ----------------------------------------------------------------

/** 节点端状态快照：覆盖 lan / p2p / relay / mismatch / offline 五种路径。
 * PC-11a 起真实路由始终携带四个容量字段（maxPeers 网络总上限含本机、
 * maxServers 本机有效挂载上限、mountedCount 真实挂载数、limitReached），
 * 罐头与真实契约同形：挂载 true 的两行（本机、书房机）对应 mountedCount 2。 */
function peerStatusBody(gatewayState = 'authorized', overrides = {}) {
  const configured = overrides.configured ?? (gatewayState !== 'idle')
  return {
    configured,
    nodeId: 'aa1b2c3d',
    gatewayState,
    ...(configured ? { networkId: 'abcdef1234567890', gatewayOrigin: 'https://gw.example.com' } : {}),
    maxPeers: 8,
    maxServers: 8,
    mountedCount: configured ? 2 : 0,
    limitReached: false,
    peers: configured ? [
      { nodeId: 'aa1b2c3d', name: '本机', mounted: true, path: 'lan', rttMs: 3 },
      { nodeId: 'bb22cc33', name: '书房机', mounted: true, path: 'p2p', rttMs: 12 },
      { nodeId: 'cc33dd44', name: '客厅机', mounted: false, path: 'relay', rttMs: 45 },
      { nodeId: 'dd44ee55', name: '旧手机', mounted: false, path: 'mismatch', rttMs: null },
      { nodeId: 'ee55ff66', name: '备用机', mounted: false, path: 'offline', rttMs: null },
    ] : [],
    ...overrides.extra,
  }
}

const ADMIN_OK = {
  [ROUTES.adminStatus]: {
    body: {
      ok: true, gatewayReachable: true, gatewayStatus: 200,
      gateway: { state: 'running', port: 3088, devices: [{ id: 'd1', name: '手机', role: 'web' }] },
      config: {},
    },
  },
}

const WIZARD_CADDY = {
  [ROUTES.wizardStatus]: {
    body: {
      ok: true, mode: 'caddy', domain: 'tea.example.com', httpsPort: 443,
      publicUrl: 'https://tea.example.com', cfTokenConfigured: true,
      tunnelTokenConfigured: false, caddyRunning: true, cloudflaredRunning: false,
      gatewayActualPort: 3088, lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null,
    },
  },
}

const WIZARD_STOPS = {
  [ROUTES.caddyStop]: { body: { ok: true, state: 'stopped' } },
  [ROUTES.tunnelStop]: { body: { ok: true, state: 'stopped' } },
}

const CLIENT_SERVERS = [
  { entryId: 'e1', serverId: 'abcd1234', serverUrl: 'http://10.0.0.2:3080', serverName: 'srv', displayName: '远端茶机', state: 'online', nextRetryAt: null, compat: { different: [] }, pluginBridge: [] },
  { entryId: 'e2', serverId: 'efef5678', serverUrl: 'http://100.64.0.9:3080', serverName: 'srv2', displayName: 'srv-2', state: 'offline', nextRetryAt: null, compat: { different: [] }, pluginBridge: [] },
]

// ---- 罐头 delegate 与 IPC 服务端 -----------------------------------------------

/** 罐装 delegate：admin/wizard/client 三张路由表，表项是 `{ status, body }` 或
 * `(res, seen) => void`，`body` 可以是 `(seen) => body`（状态轮询用）；所有
 * 请求（含 POST 体）都记进 requests 供断言。`getRole` + `flipRole` 支撑角色
 * 切换联动；写配置记录 writes（seq = 写入时刻的 requests 长度）。 */
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
    const seen = { method: req.method, path: routePath, at: Date.now(), body: bodyText === '' ? undefined : JSON.parse(bodyText) }
    requests.push(seen)
    const entry = routes?.[routePath]
    if (entry === undefined) { json(res, 404, { ok: false, error: { code: 'not-found' } }); return }
    if (typeof entry === 'function') { entry(res, seen); return }
    json(res, entry.status ?? 200, typeof entry.body === 'function' ? entry.body(seen) : entry.body)
  }
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
      role: () => (overrides.getRole !== undefined ? overrides.getRole() : overrides.role ?? 'peer'),
      serverName: () => overrides.serverName ?? '节点机',
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
    async selectOne(question, choices, defaultIndex) {
      calls.push({ kind: 'select', question, choices, defaultIndex })
      const value = selects[selectIndex++]
      assert.notEqual(value, undefined, 'unexpected extra selectOne prompt')
      return value
    },
    close() {},
  }
}

/** runCli 公共注入项。 */
function runOpts({ home, stdout, prompter, isTty = false, extra = {} } = {}) {
  return {
    dshHome: home,
    isTty,
    stdout,
    packageVersion: '9.9.9-test',
    ...(prompter === undefined ? {} : { prompter }),
    ...extra,
  }
}

/** 组装 CliExecutionContext：真 IPC client 连真 socket。--json 用例的人类
 * 提示走 stderr（PC-14b-fix1），默认同样捕获可断言。 */
function makeCtx(mods, { argv, ipc, lang = 'zh', interactive = false, prompter, stdout = captureStdout(), stderr = captureStdout(), pollIntervalMs, abortSignal }) {
  return {
    args: mods.parseCliArgs(argv),
    ipc,
    t: mods.createTranslator(lang),
    interactive,
    ...(prompter === undefined ? {} : { prompter }),
    stdout,
    stderr,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(abortSignal === undefined ? {} : { abortSignal }),
  }
}

async function waitFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await sleep(30)
  }
  assert.ok(await fn(), message)
}

// ===========================================================================
// 验收 1：parseCliArgs —— peer 子命令族 / --role peer / --invite
// ===========================================================================

test('args: peer join|status|trust|leave 路由与 --invite 取值，多余位置参数走 unknown', async () => {
  const { parseCliArgs } = await loadModules(ARGS_URL)

  const join = parseCliArgs(['peer', 'join', INVITE])
  assert.equal(join.command, 'peer.join')
  assert.equal(join.target, INVITE, 'the positional invite lands in target')
  assert.equal(join.options.invite, undefined)

  const joinFlag = parseCliArgs(['peer', 'join', '--invite', 'zr-nets://gw.example.com/abcdef1234567890'])
  assert.equal(joinFlag.command, 'peer.join')
  assert.equal(joinFlag.options.invite, 'zr-nets://gw.example.com/abcdef1234567890', '--invite is a value option')

  const joinExtra = parseCliArgs(['peer', 'join', INVITE, 'extra'])
  assert.equal(joinExtra.command, 'unknown', 'more than one positional after the verb is unknown')
  assert.equal(joinExtra.unknownCommand, 'peer join extra')

  assert.equal(parseCliArgs(['peer', 'status']).command, 'peer.status')
  assert.equal(parseCliArgs(['peer', 'status', '--json']).options.json, true)
  const trust = parseCliArgs(['peer', 'trust', 'dd44ee55'])
  assert.equal(trust.command, 'peer.trust')
  assert.equal(trust.target, 'dd44ee55')
  assert.equal(parseCliArgs(['peer', 'leave']).command, 'peer.leave')
  assert.equal(parseCliArgs(['peer', 'leave', '--yes']).options.yes, true)
  assert.equal(parseCliArgs(['peer', 'bogus']).command, 'unknown')
  assert.equal(parseCliArgs(['peer']).command, 'unknown', 'bare peer family word is unknown')
})

test('args: --role peer 是合法角色（无 roleIssue）；非法值仍标 invalid', async () => {
  const { parseCliArgs } = await loadModules(ARGS_URL)
  const peer = parseCliArgs(['setup', '--role', 'peer'])
  assert.equal(peer.options.role, 'peer', 'the raw value survives')
  assert.equal(peer.options.roleIssue, undefined, 'peer is an accepted role since PG-10')
  assert.equal(parseCliArgs(['status', '--role', 'peer']).options.roleIssue, undefined)
  assert.equal(parseCliArgs(['setup', '--role', 'host']).options.roleIssue, undefined)
  assert.equal(parseCliArgs(['setup', '--role', 'client']).options.roleIssue, undefined)
  const bad = parseCliArgs(['setup', '--role', 'wizard'])
  assert.equal(bad.options.role, 'wizard')
  assert.equal(bad.options.roleIssue, 'invalid')
})

// ===========================================================================
// 验收 2：ipc-server —— peer 角色的放行面与 /client/peer/* 门禁
// ===========================================================================

function gateDelegate(getRole, seen) {
  const mark = (label) => async (req, res) => {
    seen.push(`${label}:${req.method}:${String(req.url).split('?')[0]}`)
    const bytes = Buffer.from(JSON.stringify({ ok: true, via: label }))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
    res.end(bytes)
  }
  return {
    role: getRole,
    serverName: () => '门禁机',
    profileName: () => undefined,
    pluginVersion: () => '9.9.9-test',
    writeConfig: () => ({ ok: true, values: {} }),
    wizardHandler: mark('wizard'),
    adminHandler: mark('admin'),
    clientHandler: mark('client'),
  }
}

function sockRequest(socketPath, method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers = {}
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload))
    }
    const req = http.request({ socketPath, method, path: reqPath, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

test('ipc-server: peer 角色放行 /admin/*、/admin/wizard/*、/client/{status,claim} 与 /client/peer/*', async () => {
  const ipc = await loadModules(IPC_SERVER_URL)
  const home = makeHome('gate-peer')
  const seen = []
  let server
  try {
    server = await ipc.createCliIpcServer({ dshHome: home, delegate: gateDelegate(() => 'peer', seen) })
    const sock = server.socketPath

    const wizard = await sockRequest(sock, 'GET', ROUTES.wizardStatus)
    assert.equal(wizard.status, 200, 'servesRole(peer) opens the wizard routes')
    assert.equal(JSON.parse(wizard.body).via, 'wizard')

    const admin = await sockRequest(sock, 'GET', ROUTES.adminStatus)
    assert.equal(admin.status, 200)
    assert.equal(JSON.parse(admin.body).via, 'admin')

    const clientStatus = await sockRequest(sock, 'GET', ROUTES.clientStatus)
    assert.equal(clientStatus.status, 200, 'connectsRole(peer) opens client/status')
    assert.equal(JSON.parse(clientStatus.body).via, 'client')

    const claim = await sockRequest(sock, 'POST', '/_dsh/zen-remote/client/claim', { serverUrl: 'http://127.0.0.1:9', code: 'ABCD2345' })
    assert.equal(claim.status, 200, 'connectsRole(peer) opens the pairing routes')

    const peerStatus = await sockRequest(sock, 'GET', ROUTES.peerStatus)
    assert.equal(peerStatus.status, 200, 'peer routes forward on the peer role')
    assert.equal(JSON.parse(peerStatus.body).via, 'client')

    const peerJoin = await sockRequest(sock, 'POST', ROUTES.peerJoin, { inviteUri: INVITE })
    assert.equal(peerJoin.status, 200)

    const peerTrust = await sockRequest(sock, 'POST', ROUTES.peerTrust, { nodeId: 'dd44ee55' })
    assert.equal(peerTrust.status, 200)

    const peerLeave = await sockRequest(sock, 'POST', ROUTES.peerLeave, {})
    assert.equal(peerLeave.status, 200)
    assert.equal(seen.filter((s) => s.startsWith('client')).length, 6, 'every client-surface route reached the delegate exactly once')
  } finally {
    if (server !== undefined) await server.close()
    cleanup(home)
  }
})

test('ipc-server: host 与 client 角色拒绝 /client/peer/*（409 wrong-role，required=peer）', async () => {
  const ipc = await loadModules(IPC_SERVER_URL)
  for (const role of ['host', 'client']) {
    const home = makeHome(`gate-${role}-peer`)
    const seen = []
    let server
    try {
      server = await ipc.createCliIpcServer({ dshHome: home, delegate: gateDelegate(() => role, seen) })
      const sock = server.socketPath

      const status = await sockRequest(sock, 'GET', ROUTES.peerStatus)
      assert.equal(status.status, 409, `${role} cannot read peer status`)
      const statusBody = JSON.parse(status.body)
      assert.equal(statusBody.ok, false)
      assert.equal(statusBody.error.code, 'wrong-role')
      assert.equal(statusBody.error.role, role)
      assert.equal(statusBody.error.required, 'peer')

      const join = await sockRequest(sock, 'POST', ROUTES.peerJoin, { inviteUri: INVITE })
      assert.equal(join.status, 409)
      assert.equal(JSON.parse(join.body).error.required, 'peer')

      const leave = await sockRequest(sock, 'POST', ROUTES.peerLeave, {})
      assert.equal(leave.status, 409)
      assert.equal(seen.filter((s) => s.startsWith('client')).length, 0, 'no peer-surface request reached the delegate')
    } finally {
      if (server !== undefined) await server.close()
      cleanup(home)
    }
  }
})

// ===========================================================================
// 验收 3：peer join
// ===========================================================================

const PEER_CLIENT = {
  [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized') },
  [ROUTES.peerJoin]: { body: { ok: true } },
}

/** PS-3a 的 5 计数 sync 块罐头：与真实 peer/status 契约同形（无 derived state/reason）。 */
function syncBlock(overrides = {}) {
  return {
    readyCount: 0,
    mountedCandidateCount: 0,
    candidateCount: 0,
    ignoredCount: 0,
    mismatchCount: 0,
    ...overrides,
  }
}

/** PS-3a 就绪 join 罐头：authorized + nodeId（两台候选设备全部握手在线、无身份异常行）。 */
const PEER_CLIENT_READY = {
  [ROUTES.peerStatus]: {
    body: () => peerStatusBody('authorized', { extra: {
      peers: [
        { nodeId: 'aa1b2c3d', name: '本机', mounted: true, path: 'lan', rttMs: 3 },
        { nodeId: 'bb22cc33', name: '书房机', mounted: true, path: 'p2p', rttMs: 12 },
      ],
      sync: syncBlock({ readyCount: 2, mountedCandidateCount: 2, candidateCount: 2 }),
    } }),
  },
  [ROUTES.peerJoin]: { body: { ok: true } },
}

test('peer join: 非 peer 角色非交互缺 --yes —— 提示角色门禁立即退出 1，绝不挂起', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-gate')
  let handle
  try {
    const started = await startIpcServer(home, { role: 'client', client: PEER_CLIENT })
    handle = started.handle
    const ctx = makeCtx(mods, { argv: ['peer', 'join', INVITE], ipc: mods.createCliIpcClient(handle.socketPath), pollIntervalMs: 15 })
    const startedAt = Date.now()
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 1)
    assert.match(ctx.stdout.text(), /dsh-zen-remote setup --role peer/u, 'the refusal names the setup switch')
    assert.match(ctx.stdout.text(), /--yes/u, 'the refusal names the --yes shortcut')
    assert.ok(Date.now() - startedAt < 3000, 'the gate answers immediately without waiting on stdin')
    assert.equal(started.canned.requests.some((r) => r.path === ROUTES.peerJoin), false, 'no join POST left the gate')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer join: 非 peer 角色 + --yes 自动切换 —— 不停托管网关，写配置后轮询到节点端就绪再入网', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-switch')
  let handle
  try {
    let currentRole = 'client'
    const { handle: h, canned } = await startIpcServer(home, {
      getRole: () => currentRole,
      flipRole: (role) => { currentRole = role },
      wizard: { ...WIZARD_STOPS, ...WIZARD_CADDY },
      admin: ADMIN_OK,
      client: PEER_CLIENT_READY,
    })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--yes', '--wait', '2'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 0)
    const roleWrite = canned.writes.find((w) => w.set?.role === 'peer')
    assert.ok(roleWrite, 'the switch wrote role=peer through the anti-shadowing writer')
    assert.equal(canned.requests.some((r) => r.path === ROUTES.caddyStop), false, 'host gateway channels stay untouched on the switch')
    assert.equal(canned.requests.some((r) => r.path === ROUTES.tunnelStop), false)
    const joinSeen = canned.requests.find((r) => r.path === ROUTES.peerJoin)
    assert.ok(joinSeen, 'the join POST happened after the switch')
    assert.deepEqual(joinSeen.body, { inviteUri: INVITE })
    assert.ok(joinSeen.method === 'POST')
    const text = ctx.stdout.text()
    assert.match(text, /本机身份已生成 ✓/u)
    assert.match(text, /网关准入：已接入 ✓/u)
    assert.match(text, /成员同步：设备就绪，可开始同步 ✓/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer join: 已是 peer 角色 + 交互输入邀请链接 —— join POST、真就绪三盏灯、退出 0', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-interactive')
  let handle
  try {
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: PEER_CLIENT_READY })
    handle = h
    const prompter = fakePrompter({ inputs: [INVITE] })
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      interactive: true,
      prompter,
      pollIntervalMs: 15,
    })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 0)
    assert.deepEqual(prompter.calls.filter((c) => c.kind === 'input').map((c) => c.question), [
      mods.createTranslator('zh')('peer.prompt.invite'),
    ], 'the missing invite was asked exactly once')
    const joinSeen = canned.requests.find((r) => r.path === ROUTES.peerJoin)
    assert.deepEqual(joinSeen.body, { inviteUri: INVITE })
    const text = ctx.stdout.text()
    assert.match(text, /本机身份已生成 ✓/u)
    assert.match(text, /网关准入：已接入 ✓/u)
    assert.match(text, /成员同步：设备就绪，可开始同步 ✓/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer join: 错误邀请链接本地预校验 —— 显式错参立即报错退出 1', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-bad-invite')
  let handle
  try {
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: PEER_CLIENT })
    handle = h
    for (const bad of ['http://gw.example.com/x', 'zr-net://gw.example.com/nothex', 'zr-ftp://gw/abcdef1234567890']) {
      const ctx = makeCtx(mods, {
        argv: ['peer', 'join', bad],
        ipc: mods.createCliIpcClient(handle.socketPath),
        interactive: true,
        pollIntervalMs: 15,
      })
      const code = await mods.runPeerJoinCommand(ctx)
      assert.equal(code, 1, `the malformed invite is refused: ${bad}`)
      assert.match(ctx.stdout.text(), /邀请链接/u, 'the refusal names the invite link')
    }
    assert.equal(canned.requests.some((r) => r.path === ROUTES.peerJoin), false, 'no join POST for a locally refused invite')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer join: 非 peer 角色交互确认切换 —— 确认后切换入网；取消则退出 0 不发 join', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-confirm')
  let handle
  try {
    // 确认分支。
    let currentRole = 'client'
    const yes = await startIpcServer(home, {
      getRole: () => currentRole,
      flipRole: (role) => { currentRole = role },
      wizard: WIZARD_CADDY,
      admin: ADMIN_OK,
      client: PEER_CLIENT_READY,
    })
    handle = yes.handle
    const yesPrompter = fakePrompter({ confirms: [true] })
    const yesCtx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE],
      ipc: mods.createCliIpcClient(handle.socketPath),
      interactive: true,
      prompter: yesPrompter,
      pollIntervalMs: 15,
    })
    assert.equal(await mods.runPeerJoinCommand(yesCtx), 0)
    assert.equal(yes.canned.writes.some((w) => w.set?.role === 'peer'), true, 'the confirmed switch wrote the role')
    assert.ok(yes.canned.requests.some((r) => r.path === ROUTES.peerJoin))
    await handle.close()
    handle = undefined

    // 取消分支。
    let cancelledRole = 'client'
    const no = await startIpcServer(home, {
      getRole: () => cancelledRole,
      flipRole: (role) => { cancelledRole = role },
      wizard: WIZARD_CADDY,
      admin: ADMIN_OK,
      client: PEER_CLIENT_READY,
    })
    handle = no.handle
    const noPrompter = fakePrompter({ confirms: [false] })
    const noCtx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE],
      ipc: mods.createCliIpcClient(handle.socketPath),
      interactive: true,
      prompter: noPrompter,
      pollIntervalMs: 15,
    })
    assert.equal(await mods.runPeerJoinCommand(noCtx), 0, 'a cancelled switch is not a failure')
    assert.equal(no.canned.writes.some((w) => w.set?.role !== undefined), false, 'cancel writes nothing')
    assert.equal(no.canned.requests.some((r) => r.path === ROUTES.peerJoin), false, 'cancel sends no join')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer join: 等待批准 —— --no-wait 只代表已提交（submitted:true ready:false）退出 0 并标注 pending-approval', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-pending-nowait')
  let handle
  try {
    const pendingClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('pending-approval') },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: pendingClient })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--no-wait', '--json'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 0, '--no-wait keeps the pending progress as success')
    // PC-14b-fix1：--json 时人类提示全部走 stderr，stdout 只留单个合法 JSON。
    const errText = ctx.stderr.text()
    assert.match(errText, /等待管理员在网关控制台批准/u, 'the pending state is named in the stderr copy')
    assert.doesNotMatch(errText, /成员同步：设备就绪/u, '--no-wait never claims member readiness it did not observe')
    const raw = ctx.stdout.text()
    assert.match(raw, /^\{/u, 'stdout carries the JSON document alone')
    assert.doesNotMatch(raw, /等待/u, 'no human copy on stdout under --json')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.submitted, true, 'the JSON names the join as submitted')
    assert.equal(parsed.ready, false, 'ready stays false — it is never inferred from exit 0')
    assert.equal(parsed.gatewayState, 'pending-approval')
    assert.equal(parsed.nodeId, 'aa1b2c3d')
    assert.equal(parsed.networkId, 'abcdef1234567890')
    assert.ok(Array.isArray(parsed.peers))
    assert.equal(canned.requests.filter((r) => r.path === ROUTES.peerJoin).length, 1)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer join: 等待批准 —— 轮询预算内转 authorized+sync ready 三盏灯退出 0', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-pending-approved')
  let handle
  try {
    const states = [
      () => peerStatusBody('pending-approval'),
      () => peerStatusBody('pending-approval'),
      () => peerStatusBody('authorized', { extra: {
        peers: [
          { nodeId: 'aa1b2c3d', name: '本机', mounted: true, path: 'lan', rttMs: 3 },
          { nodeId: 'bb22cc33', name: '书房机', mounted: true, path: 'p2p', rttMs: 12 },
        ],
        sync: syncBlock({ readyCount: 2, mountedCandidateCount: 2, candidateCount: 2 }),
      } }),
    ]
    let call = 0
    const evolvingClient = {
      [ROUTES.peerStatus]: { body: () => states[Math.min(call++, states.length - 1)]() },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: evolvingClient })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '5'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 0)
    const text = ctx.stdout.text()
    assert.match(text, /等待管理员在网关控制台批准/u, 'the intermediate pending state was reported')
    assert.match(text, /本机身份已生成 ✓/u)
    assert.match(text, /网关准入：已接入 ✓/u)
    assert.match(text, /成员同步：设备就绪，可开始同步 ✓/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer join: 等待批准期间被拒（revoked）—— 报错退出 1', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-revoked')
  let handle
  try {
    const revokedClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('revoked') },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: revokedClient })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '5'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 1)
    assert.match(ctx.stdout.text(), /拒绝/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer join: 超时仍等待批准 —— 非零退出、报告仍在等待的最后实际状态', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-pending-timeout')
  let handle
  try {
    const pendingClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('pending-approval') },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: pendingClient })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '1'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const startedAt = Date.now()
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 1, 'an unmet default wait is a non-zero exit — pending is not ready')
    assert.ok(Date.now() - startedAt < 9000, 'the wait is bounded by the --wait budget')
    const text = ctx.stdout.text()
    assert.match(text, /仍在等待/u, 'the timeout names the still-pending state')
    assert.match(text, /网关准入：等待批准/u, 'the last actual gateway state is reported without a green mark')
    assert.doesNotMatch(text, /成员同步：设备就绪/u, 'no member-ready claim without the sync facts')
    assert.equal(canned.requests.some((r) => r.path === ROUTES.peerLeave), false, 'the timeout never leaves the network')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer join: 后端拒绝（400 invalid-invite）—— 双语报错退出 1；--name 写入显示名', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-backend-refused')
  let handle
  try {
    const refusingClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('idle', { configured: false }) },
      [ROUTES.peerJoin]: { status: 400, body: { ok: false, error: { code: 'invalid-invite' } } },
    }
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: refusingClient })
    handle = h
    const refused = makeCtx(mods, {
      argv: ['peer', 'join', INVITE],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    assert.equal(await mods.runPeerJoinCommand(refused), 1)
    assert.match(refused.stdout.text(), /邀请链接/u)

    const named = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--name', '书房节点', '--wait', '2'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    assert.equal(await mods.runPeerJoinCommand(named), 1)
    assert.ok(canned.writes.some((w) => w.set?.serverName === '书房节点'), '--name wrote the display name')
    assert.match(named.stdout.text(), /邀请链接/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer join: --json 输出结构化结果（submitted/ready/gatewayState/sync 原样）', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-json')
  let handle
  try {
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: PEER_CLIENT_READY })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--json'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    assert.equal(await mods.runPeerJoinCommand(ctx), 0)
    // PC-14b-fix1：--json 时 stdout 是单个合法 JSON，三盏灯文案在 stderr。
    const raw = ctx.stdout.text()
    assert.match(raw, /^\{/u)
    assert.doesNotMatch(raw, /✓/u, 'the light copy rides stderr — stdout stays one JSON document')
    assert.match(ctx.stderr.text(), /成员同步：设备就绪，可开始同步 ✓/u)
    const parsed = JSON.parse(raw)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.submitted, true)
    assert.equal(parsed.ready, true, 'ready is true only because the observed snapshot was ready')
    assert.equal(parsed.nodeId, 'aa1b2c3d')
    assert.equal(parsed.networkId, 'abcdef1234567890')
    assert.equal(parsed.gatewayState, 'authorized')
    assert.deepEqual(parsed.sync, syncBlock({ readyCount: 2, mountedCandidateCount: 2, candidateCount: 2 }), 'the backend sync block echoes verbatim')
    assert.equal(parsed.peers.length, 2)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 4：peer status
// ===========================================================================

test('peer status: 非 peer 角色门禁 —— 引导 setup --role peer 退出 1', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('status-gate')
  let handle
  try {
    const { handle: h } = await startIpcServer(home, { role: 'host', admin: ADMIN_OK, client: PEER_CLIENT })
    handle = h
    for (const lang of ['zh', 'en']) {
      const ctx = makeCtx(mods, { argv: ['peer', 'status'], ipc: mods.createCliIpcClient(handle.socketPath), lang })
      const code = await mods.runPeerStatusCommand(ctx)
      assert.equal(code, 1)
      const text = ctx.stdout.text()
      assert.match(text, /peer/u)
      assert.match(text, /setup --role peer/u)
    }
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer status: 文本输出 —— 五种连接方式、延迟、挂载、网络 ID 与网关地址', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('status-peer-text')
  let handle
  try {
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: PEER_CLIENT })
    handle = h
    const ctx = makeCtx(mods, { argv: ['peer', 'status'], ipc: mods.createCliIpcClient(handle.socketPath) })
    assert.equal(await mods.runPeerStatusCommand(ctx), 0)
    const text = ctx.stdout.text()
    assert.match(text, /节点端（虚拟网络互通）：/u)
    assert.match(text, /本机节点 ID：aa1b2c3d/u)
    assert.match(text, /已加入网络 abcdef1234567890/u)
    assert.match(text, /https:\/\/gw\.example\.com/u)
    assert.match(text, /网关接入状态：已接入/u)
    assert.match(text, /网内设备：5 台/u)
    assert.match(text, /局域网直连/u)
    assert.match(text, /3ms/u)
    assert.match(text, /直连/u)
    assert.match(text, /经网关中转/u)
    assert.match(text, /45ms/u)
    assert.match(text, /身份异常/u)
    assert.match(text, /离线/u)
    assert.match(text, /已挂载会话/u)
    assert.match(text, /未挂载会话/u)
    assert.match(text, /\[dd44ee55\]/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer status: 未入网与 --json 快照', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('status-peer-json')
  let handle
  try {
    const idleClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('idle', { configured: false }) },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: idleClient })
    handle = h
    const idle = makeCtx(mods, { argv: ['peer', 'status'], ipc: mods.createCliIpcClient(handle.socketPath) })
    assert.equal(await mods.runPeerStatusCommand(idle), 0)
    assert.match(idle.stdout.text(), /未加入任何虚拟网络/u)

    const json = makeCtx(mods, { argv: ['peer', 'status', '--json'], ipc: mods.createCliIpcClient(handle.socketPath) })
    assert.equal(await mods.runPeerStatusCommand(json), 0)
    assert.deepEqual(JSON.parse(json.stdout.text()), {
      ok: true,
      configured: false,
      nodeId: 'aa1b2c3d',
      gatewayState: 'idle',
      maxPeers: 8,
      maxServers: 8,
      mountedCount: 0,
      limitReached: false,
      peers: [],
    })
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PS-2: peer status reports identity-error clearly instead of false not-joined', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('status-peer-identity-error')
  let handle
  try {
    const errClient = {
      [ROUTES.peerStatus]: {
        body: () => ({
          configured: false,
          nodeId: '',
          gatewayState: 'identity-error',
          identityError: 'state-file-unreadable',
          maxPeers: null,
          maxServers: 8,
          mountedCount: 0,
          limitReached: false,
          peers: [],
        }),
      },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: errClient })
    handle = h
    const ctx = makeCtx(mods, { argv: ['peer', 'status'], ipc: mods.createCliIpcClient(handle.socketPath) })
    assert.equal(await mods.runPeerStatusCommand(ctx), 0)
    const output = ctx.stdout.text()
    assert.match(output, /本地身份读取失败/u)
    assert.match(output, /修复文件权限后重试/u)
    assert.doesNotMatch(output, /未加入任何虚拟网络/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 5：peer trust
// ===========================================================================

test('peer trust: 指定 nodeId —— 200 已信任（含 --json）；404 unknown-peer 退出 1', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('trust-explicit')
  let handle
  try {
    const trustClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized') },
      [ROUTES.peerTrust]: (res, seen) => {
        const ok = seen.body?.nodeId === 'dd44ee55'
        const bytes = Buffer.from(JSON.stringify(ok ? { ok: true } : { ok: false, error: { code: 'unknown-peer' } }))
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
    }
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: trustClient })
    handle = h
    const ok = makeCtx(mods, { argv: ['peer', 'trust', 'dd44ee55', '--json'], ipc: mods.createCliIpcClient(handle.socketPath) })
    assert.equal(await mods.runPeerTrustCommand(ok), 0)
    assert.deepEqual(JSON.parse(ok.stdout.text()), { ok: true, nodeId: 'dd44ee55' })
    assert.deepEqual(canned.requests.find((r) => r.path === ROUTES.peerTrust)?.body, { nodeId: 'dd44ee55' })

    const text = makeCtx(mods, { argv: ['peer', 'trust', 'dd44ee55'], ipc: mods.createCliIpcClient(handle.socketPath) })
    assert.equal(await mods.runPeerTrustCommand(text), 0)
    assert.match(text.stdout.text(), /已信任/u)

    const missing = makeCtx(mods, { argv: ['peer', 'trust', 'ffff0000'], ipc: mods.createCliIpcClient(handle.socketPath) })
    assert.equal(await mods.runPeerTrustCommand(missing), 1)
    assert.match(missing.stdout.text(), /没有找到|未找到/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer trust: 交互从身份异常设备中选择；无异常设备友好提示退出 0', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('trust-select')
  let handle
  try {
    const interactiveClient = {
      ...PEER_CLIENT,
      [ROUTES.peerTrust]: (res, seen) => {
        const ok = seen.body?.nodeId === 'dd44ee55'
        const bytes = Buffer.from(JSON.stringify(ok ? { ok: true } : { ok: false, error: { code: 'unknown-peer' } }))
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
    }
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: interactiveClient })
    handle = h
    const prompter = fakePrompter({ selects: [0] })
    const ctx = makeCtx(mods, {
      argv: ['peer', 'trust'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      interactive: true,
      prompter,
    })
    assert.equal(await mods.runPeerTrustCommand(ctx), 0)
    const selectCall = prompter.calls.find((c) => c.kind === 'select')
    assert.ok(selectCall, 'the mismatch device menu was shown')
    assert.match(selectCall.question, /身份异常/u)
    assert.equal(selectCall.choices.length, 1, 'only the mismatch device is offered')
    assert.match(selectCall.choices[0], /旧手机/u)
    assert.deepEqual(canned.requests.find((r) => r.path === ROUTES.peerTrust)?.body, { nodeId: 'dd44ee55' })

    // 无异常设备：直接友好提示退出 0，不进交互。
    const cleanClient = {
      [ROUTES.peerStatus]: {
        body: () => peerStatusBody('authorized', { extra: { peers: peerStatusBody().peers.filter((p) => p.path !== 'mismatch') } }),
      },
    }
    await handle.close()
    const clean = await startIpcServer(home, { role: 'peer', client: cleanClient })
    handle = clean.handle
    const noMismatchPrompter = fakePrompter({})
    const cleanCtx = makeCtx(mods, {
      argv: ['peer', 'trust'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      interactive: true,
      prompter: noMismatchPrompter,
    })
    assert.equal(await mods.runPeerTrustCommand(cleanCtx), 0)
    assert.match(cleanCtx.stdout.text(), /身份异常/u, 'the nothing-to-trust message names the mismatch state')
    assert.equal(noMismatchPrompter.calls.length, 0, 'no prompt at all')
    assert.equal(clean.canned.requests.some((r) => r.path === ROUTES.peerTrust), false)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer trust: 非交互缺 nodeId —— 报缺少必填参数 --node-id 退出 1', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('trust-missing')
  let handle
  try {
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: PEER_CLIENT })
    handle = h
    const ctx = makeCtx(mods, { argv: ['peer', 'trust'], ipc: mods.createCliIpcClient(handle.socketPath) })
    const code = await mods.runPeerTrustCommand(ctx)
    assert.equal(code, 1)
    assert.match(ctx.stdout.text(), /缺少必填参数 --node-id/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 6：peer leave
// ===========================================================================

test('peer leave: --yes 非交互退出 0；交互取消不发请求；非交互缺 --yes 退出 1', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('leave')
  let handle
  try {
    const leaveClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized') },
      [ROUTES.peerLeave]: { body: { ok: true } },
    }
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: leaveClient })
    handle = h

    const yes = makeCtx(mods, { argv: ['peer', 'leave', '--yes', '--json'], ipc: mods.createCliIpcClient(handle.socketPath) })
    assert.equal(await mods.runPeerLeaveCommand(yes), 0)
    assert.deepEqual(JSON.parse(yes.stdout.text()), { ok: true })
    assert.equal(canned.requests.filter((r) => r.path === ROUTES.peerLeave).length, 1)
    const firstLeaveCount = canned.requests.filter((r) => r.path === ROUTES.peerLeave).length

    const yesText = makeCtx(mods, { argv: ['peer', 'leave', '--yes'], ipc: mods.createCliIpcClient(handle.socketPath) })
    assert.equal(await mods.runPeerLeaveCommand(yesText), 0)
    assert.match(yesText.stdout.text(), /已离开虚拟网络/u)
    const afterTextCount = canned.requests.filter((r) => r.path === ROUTES.peerLeave).length

    const cancelPrompter = fakePrompter({ confirms: [false] })
    const cancelled = makeCtx(mods, {
      argv: ['peer', 'leave'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      interactive: true,
      prompter: cancelPrompter,
    })
    assert.equal(await mods.runPeerLeaveCommand(cancelled), 0, 'a cancelled leave is not a failure')
    assert.match(cancelled.stdout.text(), /取消/u)
    assert.equal(canned.requests.filter((r) => r.path === ROUTES.peerLeave).length, afterTextCount, 'cancel sends no leave POST')

    const denied = makeCtx(mods, { argv: ['peer', 'leave'], ipc: mods.createCliIpcClient(handle.socketPath) })
    assert.equal(await mods.runPeerLeaveCommand(denied), 1)
    assert.match(denied.stdout.text(), /缺少必填参数 --yes/u)
    assert.equal(canned.requests.filter((r) => r.path === ROUTES.peerLeave).length, afterTextCount)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 7：setup --role peer 向导 + 角色切换联动（host→peer 不停网关；peer→client 必停）
// ===========================================================================

test('setup --role peer 非交互全流程：host→peer 不发停机路由，join + 摘要含节点端与配对提示', { timeout: 30000 }, async () => {
  const mods = await loadModules(MAIN_URL, ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, SETUP_URL)
  const home = makeHome('setup-peer-headless')
  let handle
  try {
    let currentRole = 'host'
    const { handle: h, canned } = await startIpcServer(home, {
      getRole: () => currentRole,
      flipRole: (role) => { currentRole = role },
      wizard: { ...WIZARD_STOPS, ...WIZARD_CADDY },
      admin: ADMIN_OK,
      client: PEER_CLIENT_READY,
    })
    handle = h
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'peer', '--yes', '--invite', INVITE, '--wait', '3'],
      runOpts({ home, stdout: out, extra: { pollIntervalMs: 15 } }),
    )
    assert.equal(code, 0, out.text())
    assert.ok(canned.writes.some((w) => w.set?.role === 'peer'), 'the wizard wrote role=peer')
    const joinSeen = canned.requests.find((r) => r.path === ROUTES.peerJoin)
    assert.deepEqual(joinSeen?.body, { inviteUri: INVITE })
    assert.equal(canned.requests.some((r) => r.path === ROUTES.caddyStop), false, 'host→peer never stops the managed gateway')
    assert.equal(canned.requests.some((r) => r.path === ROUTES.tunnelStop), false, 'host→peer never stops the managed tunnel')
    const roleWrite = canned.writes.find((w) => w.set?.role === 'peer')
    const joinIndex = canned.requests.findIndex((r) => r.path === ROUTES.peerJoin)
    assert.ok(roleWrite.seq <= joinIndex, 'the role write landed before the join POST')
    const text = out.text()
    assert.match(text, /节点端/u, 'the summary names the peer node section')
    assert.match(text, /host device pair/u, 'the summary carries the phone-pairing hint')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('setup --role peer 交互全流程：未入网时提示输入邀请链接，join 后三盏灯与摘要', { timeout: 30000 }, async () => {
  const mods = await loadModules(MAIN_URL, ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, SETUP_URL)
  const home = makeHome('setup-peer-interactive')
  let handle
  try {
    let currentRole = 'host'
    let joined = false
    const evolvingClient = {
      [ROUTES.peerStatus]: { body: () => {
        if (!joined) return peerStatusBody('idle', { configured: false })
        return peerStatusBody('authorized', { extra: {
          peers: [
            { nodeId: 'aa1b2c3d', name: '本机', mounted: true, path: 'lan', rttMs: 3 },
            { nodeId: 'bb22cc33', name: '书房机', mounted: true, path: 'p2p', rttMs: 12 },
          ],
          sync: syncBlock({ readyCount: 2, mountedCandidateCount: 2, candidateCount: 2 }),
        } })
      } },
      [ROUTES.peerJoin]: (res) => {
        joined = true
        const bytes = Buffer.from(JSON.stringify({ ok: true }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
    }
    const { handle: h, canned } = await startIpcServer(home, {
      getRole: () => currentRole,
      flipRole: (role) => { currentRole = role },
      wizard: WIZARD_CADDY,
      admin: ADMIN_OK,
      client: evolvingClient,
    })
    handle = h
    const prompter = fakePrompter({ inputs: [INVITE] })
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'peer', '--wait', '3'],
      runOpts({ home, stdout: out, prompter, isTty: true, extra: { pollIntervalMs: 15 } }),
    )
    assert.equal(code, 0, out.text())
    const askedInvite = prompter.calls.find((c) => c.kind === 'input')
    assert.match(askedInvite.question, /邀请链接/u)
    assert.deepEqual(canned.requests.find((r) => r.path === ROUTES.peerJoin)?.body, { inviteUri: INVITE })
    assert.match(out.text(), /本机身份已生成 ✓/u)
    assert.match(out.text(), /成员同步：设备就绪，可开始同步 ✓/u)
    assert.match(out.text(), /host device pair/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('setup --role peer 交互：已在网络中确认保留 —— 不发 join 直接出摘要', { timeout: 30000 }, async () => {
  const mods = await loadModules(MAIN_URL, ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, SETUP_URL)
  const home = makeHome('setup-peer-keep')
  let handle
  try {
    let currentRole = 'peer'
    const { handle: h, canned } = await startIpcServer(home, {
      getRole: () => currentRole,
      flipRole: (role) => { currentRole = role },
      wizard: WIZARD_CADDY,
      admin: ADMIN_OK,
      client: PEER_CLIENT,
    })
    handle = h
    const prompter = fakePrompter({ confirms: [true] })
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'peer', '--wait', '3'],
      runOpts({ home, stdout: out, prompter, isTty: true, extra: { pollIntervalMs: 15 } }),
    )
    assert.equal(code, 0, out.text())
    assert.match(prompter.calls.find((c) => c.kind === 'confirm').question, /保留当前网络/u)
    assert.equal(canned.requests.some((r) => r.path === ROUTES.peerJoin), false, 'keeping the network skips the join')
    assert.match(out.text(), /节点端/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('setup --role client：peer→client 切换必发两条停机路由，先停后写配置', { timeout: 30000 }, async () => {
  const mods = await loadModules(MAIN_URL, ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, SETUP_URL)
  const home = makeHome('setup-peer-to-client')
  let handle
  try {
    let currentRole = 'peer'
    const pairedClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized') },
      [ROUTES.clientStatus]: { body: { state: 'online', maxServers: 8, servers: CLIENT_SERVERS, pluginBridge: [] } },
    }
    const { handle: h, canned } = await startIpcServer(home, {
      getRole: () => currentRole,
      flipRole: (role) => { currentRole = role },
      wizard: { ...WIZARD_STOPS, ...WIZARD_CADDY },
      admin: ADMIN_OK,
      client: pairedClient,
    })
    handle = h
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'client', '--yes', '--wait', '3'],
      runOpts({ home, stdout: out, extra: { pollIntervalMs: 15 } }),
    )
    assert.equal(code, 0, out.text())
    const stopIndexes = canned.requests
      .map((r, index) => (r.path === ROUTES.caddyStop || r.path === ROUTES.tunnelStop ? index : -1))
      .filter((index) => index >= 0)
    assert.equal(stopIndexes.length, 2, 'both managed-ingress stops fired (peer serves the gateway too)')
    const roleWrite = canned.writes.find((w) => w.set?.role === 'client')
    assert.ok(roleWrite, 'the switch wrote role=client')
    // writes.seq 是写入时刻的请求条数：两条停机请求在前（index 0/1），写入
    // 记录的 seq 必须大于最后一条停机的下标——先停后写。
    assert.ok(roleWrite.seq > Math.max(...stopIndexes), 'the stops ran before the config write')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 8：peer 角色下的 status 双板块与 host device pair
// ===========================================================================

test('status: peer 角色同时渲染节点端板块与手机网关板块；--json 带 peer 快照', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL)
  const home = makeHome('status-dual')
  let handle
  try {
    const peerRoleClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized') },
      [ROUTES.clientStatus]: { body: { state: 'online', maxServers: 8, servers: [], pluginBridge: [] } },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', admin: ADMIN_OK, wizard: WIZARD_CADDY, client: peerRoleClient })
    handle = h
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const zh = makeCtx(mods, { argv: ['status'], ipc })
    assert.equal(await mods.runStatusCommand(zh), 0)
    const text = zh.stdout.text()
    assert.match(text, /peer（节点端）/u)
    assert.match(text, /节点端（虚拟网络互通）：/u)
    assert.match(text, /本机节点 ID：aa1b2c3d/u)
    assert.match(text, /网关接入状态：已接入/u)
    assert.match(text, /host 状态：/u, 'the phone/browser gateway section still renders under peer')
    assert.match(text, /网关监听中（端口 3088）/u)
    assert.match(text, /已配对设备：1 台/u)

    const json = makeCtx(mods, { argv: ['status', '--json'], ipc })
    assert.equal(await mods.runStatusCommand(json), 0)
    const parsed = JSON.parse(json.stdout.text())
    assert.equal(parsed.role, 'peer')
    assert.equal(parsed.peer.nodeId, 'aa1b2c3d')
    assert.equal(parsed.peer.gatewayState, 'authorized')
    assert.equal(parsed.peer.networkId, 'abcdef1234567890')
    assert.equal(parsed.host.gateway.port, 3088)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('status: peer 角色引擎缺席时节点端板块如实留白，命令不失败', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL)
  const home = makeHome('status-peer-blank')
  let handle
  try {
    // canned 未挂 peer/status 路由 → 404 → fetchBody null（等同引擎 503）。
    const { handle: h } = await startIpcServer(home, { role: 'peer', admin: ADMIN_OK, wizard: WIZARD_CADDY })
    handle = h
    const ctx = makeCtx(mods, { argv: ['status'], ipc: mods.createCliIpcClient(handle.socketPath) })
    assert.equal(await mods.runStatusCommand(ctx), 0)
    const text = ctx.stdout.text()
    assert.match(text, /peer（节点端）/u)
    assert.match(text, /host 状态：/u)
    assert.doesNotMatch(text, /本机节点 ID：/u, 'no engine answer means no peer facts')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('host device pair: peer 角色下正常生成手机配对码（servesRole(peer) 放行）', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, HOST_URL)
  const home = makeHome('peer-device-pair')
  let handle
  try {
    const pairAdmin = {
      ...ADMIN_OK,
      [ROUTES.adminPair]: { body: { ok: true, code: 'WEBPAIR8', desktopCode: '', expiresAt: Date.now() + 10 * 60 * 1000 } },
    }
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', admin: pairAdmin, wizard: WIZARD_CADDY })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['host', 'device', 'pair', '--device-role', 'web'],
      ipc: mods.createCliIpcClient(handle.socketPath),
    })
    assert.equal(await mods.runHostDevicePairCommand(ctx), 0)
    assert.match(ctx.stdout.text(), /配对码：WEBPAIR8/u)
    assert.ok(canned.requests.some((r) => r.path === ROUTES.adminPair), 'the mint reached the admin route through the peer role')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 10：PG-10-fix 回归——角色切换边界与 abortSignal
// ===========================================================================

const WIZARD_OFF_LAN = {
  [ROUTES.wizardStatus]: {
    body: {
      ok: true, mode: 'off', domain: '', httpsPort: 443,
      publicUrl: '', cfTokenConfigured: false,
      tunnelTokenConfigured: false, caddyRunning: false, cloudflaredRunning: false,
      gatewayActualPort: 3088, lanAddress: '10.0.0.5',
      lastHostProbe: null, lastExternalVerification: null, lastForwardedSource: null,
    },
  },
}

/** verify 路由：POST 出码、GET 回 pass（第 3 盏灯立即点亮）。 */
const VERIFY_PASS = {
  [ROUTES.wizardVerify]: (res, seen) => {
    const body = seen.method === 'GET'
      ? { result: 'pass', deviceId: 'dev-new', at: 1730000001000 }
      : { ok: true, pairingCode: 'WEBPAIR8', publicUrl: String(seen.body?.publicUrl ?? 'http://10.0.0.5:3088'), expiresAt: Date.now() + 10 * 60 * 1000 }
    const bytes = Buffer.from(JSON.stringify(body))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
    res.end(bytes)
  },
}

test('PG-10-fix: peer→host 必须写入 role:host（切换写在最前），且角色切换阶段零停机路由', { timeout: 30000 }, async () => {
  const mods = await loadModules(MAIN_URL, ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, SETUP_URL)
  const home = makeHome('fix-peer-to-host')
  let handle
  try {
    let currentRole = 'peer'
    const { handle: h, canned } = await startIpcServer(home, {
      getRole: () => currentRole,
      flipRole: (role) => { currentRole = role },
      wizard: { ...WIZARD_STOPS, ...WIZARD_OFF_LAN, ...VERIFY_PASS },
      admin: ADMIN_OK,
      client: PEER_CLIENT,
    })
    handle = h
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'host', '--ingress', 'lan', '--no-wait', '--yes', '--wait', '3'],
      runOpts({ home, stdout: out, extra: { pollIntervalMs: 15 } }),
    )
    assert.equal(code, 0, out.text())
    // 角色切换写在最前：首条写配置就是 role:host，且之前没有任何业务请求。
    const firstWrite = canned.writes[0]
    assert.ok(firstWrite, 'the wizard wrote something')
    assert.equal(firstWrite.set?.role, 'host', 'peer→host MUST write role:host (peer already serves, the old !serves gate skipped the write)')
    assert.equal(firstWrite.seq, 0, 'the role switch write lands before any business request')
    // 模式切换清理会停机（ingress start 的正常行为），但必须发生在角色写之后。
    const stopIndexes = canned.requests
      .map((r, index) => (r.path === ROUTES.caddyStop || r.path === ROUTES.tunnelStop ? index : -1))
      .filter((index) => index >= 0)
    assert.ok(stopIndexes.length >= 2, 'the lan-mode cleanup stops fired inside ingress start')
    assert.ok(Math.min(...stopIndexes) > firstWrite.seq, 'the ROLE SWITCH itself sent no stop routes (servesRole(host) stays true)')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PG-10-fix: peer→client 必须等到 ping.role 变为 client 才进配对流程（旧 connects 提前放行）', { timeout: 30000 }, async () => {
  const mods = await loadModules(MAIN_URL, ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, SETUP_URL)
  const home = makeHome('fix-peer-to-client')
  let handle
  try {
    // 模拟重载窗口：写入 role:client 后 120ms 插件行才真正切成 client。
    let currentRole = 'peer'
    let flippedAt = 0
    const pairedClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized') },
      [ROUTES.clientStatus]: { body: { state: 'online', maxServers: 8, servers: CLIENT_SERVERS, pluginBridge: [] } },
    }
    const { handle: h, canned } = await startIpcServer(home, {
      getRole: () => currentRole,
      flipRole: () => {
        setTimeout(() => { currentRole = 'client'; flippedAt = Date.now() }, 120)
      },
      wizard: { ...WIZARD_STOPS, ...WIZARD_CADDY },
      admin: ADMIN_OK,
      client: pairedClient,
    })
    handle = h
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'client', '--yes', '--wait', '3'],
      runOpts({ home, stdout: out, extra: { pollIntervalMs: 15 } }),
    )
    assert.equal(code, 0, out.text())
    assert.ok(flippedAt > 0, 'the simulated reload flipped the role')
    const firstClientFetch = canned.requests.find((r) => r.path === ROUTES.clientStatus)
    assert.ok(firstClientFetch, 'the client branch fetched the pool status')
    assert.ok(
      firstClientFetch.at >= flippedAt,
      `the client branch ran only after the row reloaded into client (fetch at ${firstClientFetch.at}, flipped at ${flippedAt})`,
    )
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PC-14b: peer join 等待批准期间 Ctrl-C（abortSignal）—— 有界结束退出 130，申请保留不自动离开', { timeout: 10000 }, async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('fix-join-abort')
  let handle
  try {
    const pendingClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('pending-approval') },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: pendingClient })
    handle = h
    const controller = new AbortController()
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '30'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
      abortSignal: controller.signal,
    })
    const abortTimer = setTimeout(() => controller.abort(), 120)
    const startedAt = Date.now()
    try {
      const code = await mods.runPeerJoinCommand(ctx)
      assert.equal(code, 130, 'Ctrl-C ends the wait with the 130 convention')
      assert.match(ctx.stdout.text(), /已中断等待/u, 'the abort names the interrupted wait')
      assert.match(ctx.stdout.text(), /未离开/u, 'the abort keeps the submitted join — no auto-leave')
      assert.ok(Date.now() - startedAt < 8000, `the abort ended the wait immediately (took ${Date.now() - startedAt}ms, --wait 30 budget)`)
      assert.equal(canned.requests.some((r) => r.path === ROUTES.peerLeave), false, 'Ctrl-C never sends a leave request')
    } finally {
      clearTimeout(abortTimer)
    }
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PG-10-fix: peer join 已是 peer 角色非交互缺邀请链接——立即退出 1 提示 --invite，零 join 请求', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('fix-join-missing-invite')
  let handle
  try {
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: PEER_CLIENT })
    handle = h
    const ctx = makeCtx(mods, { argv: ['peer', 'join'], ipc: mods.createCliIpcClient(handle.socketPath), pollIntervalMs: 15 })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 1)
    assert.match(ctx.stdout.text(), /缺少必填参数 --invite/u)
    assert.equal(canned.requests.some((r) => r.path === ROUTES.peerJoin), false, 'no join POST without an invite link')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// PS-3a（原 PC-14b）：等待与退出码以网关接入（authorized + nodeId）为准，
// 不被空网、全忽略、满额部分挂载或对端尚在握手拖住；同时诚实报告 5 计数与异常告警
// ===========================================================================

test('PS-3a: peer join 连接中→authorized 立即退出 0（即使尚在握手中也诚实报计数、不误打成员✓）', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('ps3a-evolve-partial-ready')
  let handle
  try {
    const states = [
      () => peerStatusBody('connecting'),
      () => peerStatusBody('authorized', { extra: {
        peers: [
          { nodeId: 'aa1b2c3d', name: '本机', mounted: true, path: 'lan', rttMs: 3 },
          { nodeId: 'bb22cc33', name: '书房机', mounted: false, path: 'relay', rttMs: 45 },
        ],
        sync: syncBlock({ readyCount: 1, mountedCandidateCount: 2, candidateCount: 2 }),
      } }),
    ]
    let call = 0
    const evolvingClient = {
      [ROUTES.peerStatus]: { body: () => states[Math.min(call++, states.length - 1)]() },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: evolvingClient })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '5'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 0, 'authorized + non-empty nodeId exits 0 even while handshakes are in flight')
    const text = ctx.stdout.text()
    assert.match(text, /本机身份已生成 ✓/u)
    assert.match(text, /网关准入：已接入 ✓/u)
    assert.match(text, /成员同步：已向 1\/2 台已挂载设备完成握手/u)
    assert.doesNotMatch(text, /1\/2 台已挂载设备完成握手 ✓/u, 'partial handshake count does not show false ✓')

    // en 同语义，两台均 ready 时给出三盏 ✓
    const homeReady = makeHome('ps3a-en-ready')
    const { handle: h2 } = await startIpcServer(homeReady, { role: 'peer', client: PEER_CLIENT_READY })
    try {
      const en = makeCtx(mods, {
        argv: ['peer', 'join', INVITE, '--wait', '2'],
        ipc: mods.createCliIpcClient(h2.socketPath),
        lang: 'en',
        pollIntervalMs: 15,
      })
      assert.equal(await mods.runPeerJoinCommand(en), 0)
      const enText = en.stdout.text()
      assert.match(enText, /Local identity created ✓/u)
      assert.match(enText, /Gateway admission: connected ✓/u)
      assert.match(enText, /Member sync: devices ready — syncing may start ✓/u)
    } finally {
      await h2.close()
      cleanup(homeReady)
    }
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PS-3a: 空网、全忽略与 maxServers 满额部分挂载 —— authorized 后立刻退出 0（ready: true）', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const cases = [
    {
      name: 'empty-network',
      extra: { peers: [], sync: syncBlock() },
      expectMatch: /已入网，等待其他设备加入 ✓/u,
    },
    {
      name: 'all-ignored',
      extra: { peers: [], sync: syncBlock({ ignoredCount: 2 }) },
      expectMatch: /已入网，其他设备均被设为忽略 ✓/u,
    },
    {
      name: 'limit-reached-partial-mount',
      extra: {
        limitReached: true,
        maxServers: 1,
        mountedCount: 1,
        peers: [
          { nodeId: 'aa1b2c3d', name: '本机', mounted: true, path: 'lan', rttMs: 3 },
          { nodeId: 'bb22cc33', name: '备用机', mounted: false, path: 'offline', rttMs: null },
        ],
        sync: syncBlock({ readyCount: 1, mountedCandidateCount: 1, candidateCount: 2 }),
      },
      expectMatch: /成员同步：设备就绪，可开始同步 ✓/u,
    },
  ]
  for (const scenario of cases) {
    const home = makeHome(`ps3a-${scenario.name}`)
    let handle
    try {
      const client = {
        [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized', { extra: scenario.extra }) },
        [ROUTES.peerJoin]: { body: { ok: true } },
      }
      const { handle: h } = await startIpcServer(home, { role: 'peer', client })
      handle = h
      const ctx = makeCtx(mods, {
        argv: ['peer', 'join', INVITE, '--wait', '2', '--json'],
        ipc: mods.createCliIpcClient(handle.socketPath),
        pollIntervalMs: 15,
      })
      const startedAt = Date.now()
      const code = await mods.runPeerJoinCommand(ctx)
      assert.equal(code, 0, scenario.name)
      assert.ok(Date.now() - startedAt < 1500, `${scenario.name} exited immediately without waiting for timeout`)
      const parsed = JSON.parse(ctx.stdout.text())
      assert.equal(parsed.ok, true, scenario.name)
      assert.equal(parsed.ready, true, scenario.name)
      assert.match(ctx.stderr.text(), scenario.expectMatch, scenario.name)
    } finally {
      if (handle !== undefined) await handle.close()
      cleanup(home)
    }
  }
})

test('PS-3a: paused / mismatch / identity-error —— 立即失败退出 1，不做无意义等待', { timeout: 8000 }, async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  for (const scenario of [
    { state: 'paused', extra: {}, expectPattern: /暂停/u, reason: 'paused' },
    { state: 'mismatch', extra: {}, expectPattern: /peer trust/u, reason: 'mismatch' },
    {
      state: 'identity-error',
      extra: { configured: false, nodeId: '', identityError: 'state-file-unreadable' },
      expectPattern: /修复文件权限后重试/u,
      reason: 'identity-error',
    },
  ]) {
    const home = makeHome(`ps3a-blocked-${scenario.state}`)
    let handle
    try {
      const blockedClient = {
        [ROUTES.peerStatus]: { body: () => peerStatusBody(scenario.state, { extra: scenario.extra }) },
        [ROUTES.peerJoin]: { body: { ok: true } },
      }
      const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: blockedClient })
      handle = h
      const ctx = makeCtx(mods, {
        argv: ['peer', 'join', INVITE, '--wait', '5', '--json'],
        ipc: mods.createCliIpcClient(handle.socketPath),
        pollIntervalMs: 15,
      })
      const startedAt = Date.now()
      const code = await mods.runPeerJoinCommand(ctx)
      assert.equal(code, 1, scenario.state)
      assert.ok(Date.now() - startedAt < 4000, `${scenario.state} failed fast (took ${Date.now() - startedAt}ms)`)
      const parsed = JSON.parse(ctx.stdout.text())
      assert.equal(parsed.ok, false)
      assert.equal(parsed.ready, false)
      assert.equal(parsed.reason, scenario.reason)
      assert.match(ctx.stderr.text(), scenario.expectPattern, scenario.state)
      assert.equal(canned.requests.filter((r) => r.path === ROUTES.peerStatus).length <= 2, true, scenario.state)
    } finally {
      if (handle !== undefined) await handle.close()
      cleanup(home)
    }
  }
})

test('PS-3a: authorized 但存在对端 identity-mismatch —— 正常退出 0 并提示 peer trust 处理异常对端', { timeout: 8000 }, async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('ps3a-mismatch-warning')
  let handle
  try {
    const mismatchPeerClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized', { extra: {
        peers: [
          { nodeId: 'aa1b2c3d', name: '本机', mounted: true, path: 'lan', rttMs: 3 },
          { nodeId: 'dd44ee55', name: '旧手机', mounted: false, path: 'mismatch', rttMs: null },
        ],
        sync: syncBlock({ readyCount: 1, mountedCandidateCount: 1, candidateCount: 1, mismatchCount: 1 }),
      } }) },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: mismatchPeerClient })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '5'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 0, 'a per-peer identity mismatch does not fail network admission')
    const text = ctx.stdout.text()
    assert.match(text, /网关准入：已接入 ✓/u)
    assert.match(text, /peer trust/u, 'still surfaces clear warning to run peer trust')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PC-14b: --no-wait 提交后立即 revoked —— 不伪造成功，退出 1', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('pc14b-nowait-revoked')
  let handle
  try {
    const revokedClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('revoked') },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: revokedClient })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--no-wait', '--json'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 1, 'a terminally refused admission is a failure even under --no-wait')
    // PC-14b-fix1：失败也要结构化 —— stdout 单个 JSON（ok:false/reason:revoked），
    // 人类提示去 stderr；提交事实不因失败被抹掉。
    const raw = ctx.stdout.text()
    assert.match(raw, /^\{/u)
    const parsed = JSON.parse(raw)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.submitted, true, 'the accepted POST stays submitted even on a refused admission')
    assert.equal(parsed.ready, false)
    assert.equal(parsed.reason, 'revoked')
    assert.equal(parsed.gatewayState, 'revoked')
    assert.doesNotMatch(raw, /"ready": true/u)
    assert.match(ctx.stderr.text(), /拒绝/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PC-14b: IPC 断连 —— 等待期间服务端关闭，有界结束非零并报告最后一次已知状态', { timeout: 15000 }, async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('pc14b-ipc-drop')
  let handle
  try {
    let statusCalls = 0
    let serverHandleRef
    const droppingClient = {
      [ROUTES.peerStatus]: { body: () => {
        statusCalls += 1
        if (statusCalls === 2) setTimeout(() => { void serverHandleRef.close() }, 0)
        return peerStatusBody('pending-approval')
      } },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const started = await startIpcServer(home, { role: 'peer', client: droppingClient })
    handle = started.handle
    serverHandleRef = started.handle
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '2'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const startedAt = Date.now()
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 1, 'a dead IPC surface ends the wait non-zero at the deadline')
    assert.ok(Date.now() - startedAt < 9000, `the drop is bounded by the budget (took ${Date.now() - startedAt}ms, no 15s default hang)`)
    assert.match(ctx.stdout.text(), /仍在等待/u, 'the last known pending state is reported honestly')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PC-14b: 每次 IPC 轮询受剩余预算约束 —— 慢应答在预算内超时结束，不挂满默认 15s', { timeout: 20000 }, async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('pc14b-budget-bound')
  let handle
  try {
    const slowClient = {
      [ROUTES.peerStatus]: (res) => {
        // 应答慢于 2s 预算：请求必须在剩余预算内超时，而不是吃满 15s 默认。
        setTimeout(() => {
          const bytes = Buffer.from(JSON.stringify(peerStatusBody('pending-approval')))
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
          res.end(bytes)
        }, 8000)
      },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: slowClient })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '2'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const startedAt = Date.now()
    const code = await mods.runPeerJoinCommand(ctx)
    const elapsed = Date.now() - startedAt
    assert.equal(code, 1, 'an unanswered poll burns the budget, not the default 15s timeout')
    assert.ok(elapsed < 8000, `each poll must ride under the remaining budget (took ${elapsed}ms)`)
    assert.match(ctx.stdout.text(), /读取节点端状态失败/u, 'no observed snapshot means the fetch-failure copy')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PC-14b: setup 传播 join 超时 —— 退出 1、不打印成功摘要', { timeout: 20000 }, async () => {
  const mods = await loadModules(MAIN_URL, ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, SETUP_URL)
  const home = makeHome('pc14b-setup-join-timeout')
  let handle
  try {
    let currentRole = 'host'
    const { handle: h, canned } = await startIpcServer(home, {
      getRole: () => currentRole,
      flipRole: (role) => { currentRole = role },
      wizard: { ...WIZARD_STOPS, ...WIZARD_CADDY },
      admin: ADMIN_OK,
      client: {
        [ROUTES.peerStatus]: { body: () => peerStatusBody('pending-approval') },
        [ROUTES.peerJoin]: { body: { ok: true } },
      },
    })
    handle = h
    const out = captureStdout()
    const code = await mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'peer', '--yes', '--invite', INVITE, '--wait', '1'],
      runOpts({ home, stdout: out, extra: { pollIntervalMs: 15 } }),
    )
    assert.equal(code, 1, 'setup returns the join timeout code instead of a green summary')
    assert.doesNotMatch(out.text(), /配置完成/u, 'no success summary after a failed join')
    assert.match(out.text(), /仍在等待/u, 'the join still-pending report rides through setup')
    assert.ok(canned.requests.some((r) => r.path === ROUTES.peerJoin))
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PC-14b: setup 传播 join 的 Ctrl-C（130）—— 有界结束、不打印成功摘要', { timeout: 15000 }, async () => {
  const mods = await loadModules(MAIN_URL, ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, SETUP_URL)
  const home = makeHome('pc14b-setup-join-abort')
  let handle
  try {
    let currentRole = 'host'
    const { handle: h } = await startIpcServer(home, {
      getRole: () => currentRole,
      flipRole: (role) => { currentRole = role },
      wizard: WIZARD_CADDY,
      admin: ADMIN_OK,
      client: {
        [ROUTES.peerStatus]: { body: () => peerStatusBody('pending-approval') },
        [ROUTES.peerJoin]: { body: { ok: true } },
      },
    })
    handle = h
    const controller = new AbortController()
    const out = captureStdout()
    const runPromise = mods.runCli(
      ['--lang', 'zh', 'setup', '--role', 'peer', '--yes', '--invite', INVITE, '--wait', '30'],
      runOpts({ home, stdout: out, extra: { pollIntervalMs: 15, abortSignal: controller.signal } }),
    )
    const abortTimer = setTimeout(() => controller.abort(), 500)
    const startedAt = Date.now()
    try {
      const code = await runPromise
      assert.equal(code, 130, 'setup propagates the join wait abort code')
      assert.ok(Date.now() - startedAt < 8000, `the abort ends setup bounded (took ${Date.now() - startedAt}ms)`)
      assert.doesNotMatch(out.text(), /配置完成/u, 'no success summary after Ctrl-C')
      assert.match(out.text(), /已中断等待/u)
    } finally {
      clearTimeout(abortTimer)
    }
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// PC-14b fix1：等待期及时取消、硬截止、文本/JSON 同口径
//
// Required 1：取消必须终止当前等待（在途请求本身被切断，不是只看下一拍）；
// 预算是墙钟截止 —— 慢分段合法 JSON 拖不出去，晚到的 ready 绕不过已触发的
// 截止。socket idle 超时不是总预算：分段写会一直重置它。
// Required 2：第三行措辞/mark 与退出判定同口径 —— 停机网关带历史 sync ready
// 不显示成员绿；计数按 PC-14a 口径收非负安全整数，非法显示未知。
// Required 3：--json 的失败路径也输出结构化结果 —— stdout 恒为单个合法
// JSON（ok:false/submitted/ready:false/reason/实际状态），人类提示去 stderr。
// ===========================================================================

test('PC-14b-fix1: 取消终止当前等待 —— 慢应答中 Ctrl-C，明显小于预算返回 130', { timeout: 10000 }, async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('fix1-abort-slow')
  let handle
  try {
    // 应答延迟 4s：旧实现在初次 GET 之后才检查 abort，要等满 4s 才到 130；
    // 新实现在途请求被取消信号直接切断，~300ms 结束。
    const slowClient = {
      [ROUTES.peerStatus]: (res) => {
        res.on('error', () => {})
        const timer = setTimeout(() => {
          try {
            const bytes = Buffer.from(JSON.stringify(peerStatusBody('pending-approval')))
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
            res.end(bytes)
          } catch { /* the requester went away with the abort */ }
        }, 4000)
        res.on('close', () => clearTimeout(timer))
      },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: slowClient })
    handle = h
    const controller = new AbortController()
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '20'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
      abortSignal: controller.signal,
    })
    const abortTimer = setTimeout(() => controller.abort(), 300)
    const startedAt = Date.now()
    try {
      const code = await mods.runPeerJoinCommand(ctx)
      const elapsed = Date.now() - startedAt
      assert.equal(code, 130)
      assert.ok(elapsed < 3000, `the abort must cut the in-flight request (took ${elapsed}ms, response would land at ~4s)`)
      assert.match(ctx.stdout.text(), /已中断等待/u)
      assert.equal(canned.requests.some((r) => r.path === ROUTES.peerLeave), false, 'no auto-leave on abort')
    } finally {
      clearTimeout(abortTimer)
    }
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PC-14b-fix1: 硬截止 —— 慢分段合法 JSON 拖不出墙钟预算，晚到 ready 不算数', { timeout: 10000 }, async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('fix1-drip-budget')
  let handle
  try {
    // 每 600ms 滴一段合法 JSON（authorized + sync ready），总时长 ~3.6s：
    // socket idle 超时被数据流不断重置，只有墙钟硬截止能终结它。旧实现会
    // 在 ~3.6s 拿到完整 ready 并退出 0（超预算仍 0）；新实现 1.2s 截止退出 1。
    const readyJson = JSON.stringify(peerStatusBody('authorized', { extra: {
      peers: [
        { nodeId: 'aa1b2c3d', name: '本机', mounted: true, path: 'lan', rttMs: 3 },
        { nodeId: 'bb22cc33', name: '书房机', mounted: true, path: 'p2p', rttMs: 12 },
      ],
      sync: syncBlock('ready', { readyCount: 2, candidateCount: 2 }),
    } }))
    const dripClient = {
      [ROUTES.peerStatus]: (res) => {
        res.on('error', () => {})
        res.writeHead(200, { 'Content-Type': 'application/json' })
        let index = 0
        let stopped = false
        res.on('close', () => { stopped = true })
        const drip = () => {
          if (stopped || index >= readyJson.length) {
            try { res.end() } catch { /* already gone */ }
            return
          }
          try {
            res.write(readyJson.slice(index, index + 16))
            index += 16
          } catch { /* the requester cut the socket at the deadline */ }
          setTimeout(drip, 600)
        }
        drip()
      },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: dripClient })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '1.2'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const startedAt = Date.now()
    const code = await mods.runPeerJoinCommand(ctx)
    const elapsed = Date.now() - startedAt
    assert.equal(code, 1, 'the wall-clock deadline ends the wait non-zero — a late ready body must not count')
    assert.ok(elapsed < 3200, `the hard cutoff fired at the budget, not when the drip finished (took ${elapsed}ms)`)
    assert.match(ctx.stdout.text(), /读取节点端状态失败/u, 'no complete snapshot ever landed — the honest fetch-failure copy')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PC-14b-fix1: 停机网关带历史 sync ready —— 第三行服从判定，不显示成员绿', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('fix1-stale-sync')
  let handle
  try {
    const cleanPeers = [
      { nodeId: 'aa1b2c3d', name: '本机', mounted: true, path: 'lan', rttMs: 3 },
      { nodeId: 'bb22cc33', name: '书房机', mounted: true, path: 'p2p', rttMs: 12 },
    ]
    const staleSync = syncBlock({ readyCount: 2, mountedCandidateCount: 2, candidateCount: 2 })
    const offlineClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('offline', { extra: { peers: cleanPeers, sync: staleSync } }) },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: offlineClient })
    handle = h
    const offlineCtx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '1'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const offlineCode = await mods.runPeerJoinCommand(offlineCtx)
    assert.equal(offlineCode, 1, 'a dead gateway never exits the wait as ready')
    const offlineText = offlineCtx.stdout.text()
    assert.match(offlineText, /成员同步：等待网关接入完成/u, 'the stale sync block reads as the gateway hold, not member-ready')
    assert.doesNotMatch(offlineText, /设备就绪，可开始同步/u)
    assert.doesNotMatch(offlineText, /离线重连中 ✓/u)

    // paused 同口径：立即失败，历史 sync ready 不给成员绿。
    const home2 = makeHome('fix1-stale-sync-paused')
    const pausedStarted = await startIpcServer(home2, {
      role: 'peer',
      client: {
        [ROUTES.peerStatus]: { body: () => peerStatusBody('paused', { extra: { peers: cleanPeers, sync: staleSync } }) },
        [ROUTES.peerJoin]: { body: { ok: true } },
      },
    })
    const handle2 = pausedStarted.handle
    try {
      const pausedCtx = makeCtx(mods, {
        argv: ['peer', 'join', INVITE, '--wait', '5'],
        ipc: mods.createCliIpcClient(handle2.socketPath),
        pollIntervalMs: 15,
      })
      const pausedCode = await mods.runPeerJoinCommand(pausedCtx)
      assert.equal(pausedCode, 1)
      const pausedText = pausedCtx.stdout.text()
      assert.match(pausedText, /暂停/u)
      assert.doesNotMatch(pausedText, /设备就绪，可开始同步/u)
      assert.doesNotMatch(pausedText, /成员同步：.* ✓/u)
    } finally {
      await handle2.close()
      cleanup(home2)
    }
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PS-3a: 非法计数按 5 计数校验降级 —— 负数/小数不成台数，authorized 仍退出 0', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('fix1-bad-counts')
  let handle
  try {
    const junkCountsClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized', { extra: {
        peers: [
          { nodeId: 'aa1b2c3d', name: '本机', mounted: true, path: 'lan', rttMs: 3 },
          { nodeId: 'bb22cc33', name: '书房机', mounted: false, path: 'relay', rttMs: 45 },
        ],
        sync: { readyCount: -1, mountedCandidateCount: 1, candidateCount: 2.5 },
      } }) },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: junkCountsClient })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '1'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 0)
    const text = ctx.stdout.text()
    assert.doesNotMatch(text, /握手/u)
    assert.doesNotMatch(text, /-1/u)
    assert.doesNotMatch(text, /2\.5/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PC-14b-fix1: --json 默认等待未达成 —— stdout 单个 JSON（ok:false/reason:timeout），人类提示去 stderr', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('fix1-json-timeout')
  let handle
  try {
    const pendingClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('pending-approval') },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: pendingClient })
    handle = h
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '1', '--json'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 1)
    const raw = ctx.stdout.text()
    assert.match(raw, /^\{/u, 'stdout is the JSON document alone')
    assert.doesNotMatch(raw, /等待/u)
    const parsed = JSON.parse(raw)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.submitted, true, 'the accepted POST is not erased by the timeout')
    assert.equal(parsed.ready, false)
    assert.equal(parsed.reason, 'timeout')
    assert.equal(parsed.gatewayState, 'pending-approval', 'the last actual state rides the failure body')
    assert.equal(parsed.nodeId, 'aa1b2c3d')
    assert.match(ctx.stderr.text(), /仍在等待/u)
    assert.equal(canned.requests.some((r) => r.path === ROUTES.peerLeave), false, 'no auto-leave on timeout')
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PC-14b-fix1: --json Ctrl-C —— reason:aborted、submitted 保留、退出 130', { timeout: 10000 }, async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('fix1-json-abort')
  let handle
  try {
    const pendingClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('pending-approval') },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h, canned } = await startIpcServer(home, { role: 'peer', client: pendingClient })
    handle = h
    const controller = new AbortController()
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '30', '--json'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
      abortSignal: controller.signal,
    })
    const abortTimer = setTimeout(() => controller.abort(), 200)
    try {
      const code = await mods.runPeerJoinCommand(ctx)
      assert.equal(code, 130)
      const parsed = JSON.parse(ctx.stdout.text())
      assert.equal(parsed.ok, false)
      assert.equal(parsed.reason, 'aborted')
      assert.equal(parsed.submitted, true, 'Ctrl-C must not fake not-submitted')
      assert.equal(parsed.ready, false)
      assert.equal(parsed.gatewayState, 'pending-approval')
      assert.match(ctx.stderr.text(), /已中断等待/u)
      assert.equal(canned.requests.some((r) => r.path === ROUTES.peerLeave), false)
    } finally {
      clearTimeout(abortTimer)
    }
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('PS-3a: --json 已知网关阻塞与无快照 —— reason 走同一词表，不填假状态', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('fix1-json-blocked')
  let handle
  try {
    // 网关身份校验阻塞：gatewayState === 'mismatch'。
    const blockedClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('mismatch') },
      [ROUTES.peerJoin]: { body: { ok: true } },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: blockedClient })
    handle = h
    const blocked = makeCtx(mods, {
      argv: ['peer', 'join', INVITE, '--wait', '5', '--json'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      pollIntervalMs: 15,
    })
    assert.equal(await mods.runPeerJoinCommand(blocked), 1)
    const blockedParsed = JSON.parse(blocked.stdout.text())
    assert.equal(blockedParsed.ok, false)
    assert.equal(blockedParsed.reason, 'mismatch')
    assert.equal(blockedParsed.submitted, true)
    assert.equal(blockedParsed.ready, false)
    await handle.close()
    handle = undefined

    // 无快照：--no-wait 提交成功、快照请求在传输层被拒绝 —— 拿不到任何数据。
    const home2 = makeHome('fix1-json-unavailable')
    const dyingClient = {
      [ROUTES.peerStatus]: (res) => {
        res.on('error', () => {})
        res.destroy()
      },
      [ROUTES.peerJoin]: (res) => {
        const bytes = Buffer.from(JSON.stringify({ ok: true }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      },
    }
    const dying = await startIpcServer(home2, { role: 'peer', client: dyingClient })
    const handle2 = dying.handle
    try {
      const unavailable = makeCtx(mods, {
        argv: ['peer', 'join', INVITE, '--no-wait', '--json'],
        ipc: mods.createCliIpcClient(handle2.socketPath),
        pollIntervalMs: 15,
      })
      assert.equal(await mods.runPeerJoinCommand(unavailable), 1)
      const raw = unavailable.stdout.text()
      assert.match(raw, /^\{/u)
      const parsed = JSON.parse(raw)
      assert.equal(parsed.ok, false)
      assert.equal(parsed.reason, 'status-unavailable')
      assert.equal(parsed.submitted, true)
      assert.equal(parsed.ready, false)
      assert.equal(parsed.gatewayState, undefined, 'no snapshot means no invented state')
      assert.equal(parsed.sync, undefined, 'no snapshot means no invented sync block')
    } finally {
      await handle2.close()
      cleanup(home2)
    }
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 9：--help 文本与 i18n 词典纪律
// ===========================================================================

test('help: 展示 --role host|client|peer 与 peer 子命令族（双语，en 无中文）', async () => {
  const mods = await loadModules(MAIN_URL, ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL)
  const zhOut = captureStdout()
  const zhCode = await mods.runCli(['--lang', 'zh', '--help'], runOpts({ stdout: zhOut }))
  assert.equal(zhCode, 0)
  assert.match(zhOut.text(), /peer join\|status\|trust\|leave/u)
  assert.match(zhOut.text(), /--role host\|client\|peer/u)
  assert.match(zhOut.text(), /--invite/u)

  const enOut = captureStdout()
  const enCode = await mods.runCli(['--lang', 'en', '--help'], runOpts({ stdout: enOut }))
  assert.equal(enCode, 0)
  assert.match(enOut.text(), /peer join\|status\|trust\|leave/u)
  assert.match(enOut.text(), /--role host\|client\|peer/u)
  assert.doesNotMatch(enOut.text(), /[\u4e00-\u9fff]/u, 'the en help has no Chinese')
  assert.doesNotMatch(enOut.text(), /not enabled/u, 'peer is no longer gated out of the help')
})

test('i18n: zh/en 键集完全对称；zh 零「互通端」；en 零中文字符；术语钉住', async () => {
  const { createTranslator } = await loadModules(I18N_URL)
  const zh = createTranslator('zh')
  const en = createTranslator('en')

  const zhKeys = Object.keys(zh.keys).sort()
  const enKeys = Object.keys(en.keys).sort()
  assert.deepEqual(
    zhKeys.filter((key) => !enKeys.includes(key)),
    [],
    `zh-only keys: ${zhKeys.filter((key) => !enKeys.includes(key)).join(', ')}`,
  )
  assert.deepEqual(
    enKeys.filter((key) => !zhKeys.includes(key)),
    [],
    `en-only keys: ${enKeys.filter((key) => !zhKeys.includes(key)).join(', ')}`,
  )

  for (const value of Object.values(zh.keys)) {
    assert.doesNotMatch(value, /互通端/u, `the deprecated term must not reappear: ${value}`)
  }
  for (const value of Object.values(en.keys)) {
    assert.doesNotMatch(value, /[\u4e00-\u9fff]/u, `the en copy is free of Chinese: ${value}`)
  }

  // 术语红线：节点端 / 邀请链接 / 连接方式四词。
  assert.equal(zh('status.role.peer'), 'peer（节点端）')
  assert.match(zh('peer.prompt.invite'), /邀请链接/u)
  assert.equal(zh('peer.path.lan'), '局域网直连')
  assert.equal(zh('peer.path.p2p'), '直连')
  assert.equal(zh('peer.path.relay'), '经网关中转')
  assert.equal(zh('peer.path.mismatch'), '身份异常')
  assert.match(zh('err.role.invalid'), /host、client 或 peer/u)
  assert.doesNotMatch(zh('err.role.invalid'), /尚未启用/u)
  assert.equal(en('status.role.peer'), 'peer (peer node)')
})

test('peer join: 支持直接输入中继网关地址（手动审批准入）及多网络交互选择', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('join-gw-url')
  let handle
  try {
    let joinCalls = 0
    const { handle: h, canned } = await startIpcServer(home, {
      role: 'peer',
      client: {
        [ROUTES.peerStatus]: { body: () => peerStatusBody('pending-approval') },
        [ROUTES.peerJoin]: (res, seen) => {
          joinCalls += 1
          if (joinCalls === 1 && !seen.body.networkId) {
            const payload = JSON.stringify({
              ok: false,
              error: { code: 'select-network' },
              networks: [
                { id: '1111222233334444', name: '默认网络' },
                { id: 'aaaabbbbccccdddd', name: '研发网络' },
              ],
            })
            res.writeHead(409, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) })
            res.end(payload)
            return
          }
          const okBody = JSON.stringify({ ok: true, networkId: seen.body.networkId, manualApproval: true })
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(okBody)) })
          res.end(okBody)
        },
      },
    })
    handle = h
    const prompter = fakePrompter({ selects: [1] })
    const ctx = makeCtx(mods, {
      argv: ['peer', 'join', 'http://192.168.1.88:19393', '--no-wait'],
      ipc: mods.createCliIpcClient(handle.socketPath),
      interactive: true,
      prompter,
      pollIntervalMs: 15,
    })
    const code = await mods.runPeerJoinCommand(ctx)
    assert.equal(code, 0)
    const joins = canned.requests.filter((r) => r.path === ROUTES.peerJoin)
    assert.equal(joins.length, 2)
    assert.deepEqual(joins[0].body, { gatewayUrl: 'http://192.168.1.88:19393' })
    assert.deepEqual(joins[1].body, { gatewayUrl: 'http://192.168.1.88:19393', networkId: 'aaaabbbbccccdddd' })
    assert.match(ctx.stdout.text(), /等待管理员在网关控制台批准/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

// ===========================================================================
// 验收 9：PC-11c —— CLI 统一容量事实（peer status 与总 status 同口径）
//
// 服务端契约（PC-11a）：maxPeers = 网络总上限（含本机）；maxServers = 本机
// 有效远端挂载上限；mountedCount = 本机真实挂载数；limitReached = 两者之比。
// CLI 文本与网页同口径：本机挂载 N/M 一行、网络总上限独立一行、满额/超额
// 说明已有挂载保留新增受限；旧端缺字段明示未知、绝不按 maxPeers-1 或常量
// 8 推测；JSON 原样透传服务端字段（未知保持缺席，不伪造 0/8）。
// ===========================================================================

test('peer status: 容量行 —— 本机挂载 N/M 与网络总上限独立成行（中英）', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('pc11c-normal')
  let handle
  try {
    const client = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized', { extra: { maxServers: 3, mountedCount: 2, limitReached: false } }) },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client })
    handle = h
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const zh = makeCtx(mods, { argv: ['peer', 'status'], ipc, lang: 'zh' })
    assert.equal(await mods.runPeerStatusCommand(zh), 0)
    const zhText = zh.stdout.text()
    assert.match(zhText, /本机已挂载 2 \/ 3 台远端设备/u)
    assert.doesNotMatch(zhText, /网络设备上限 8 台（含本机）/u, 'the network-total cap stays hidden until full')
    assert.doesNotMatch(zhText, /已达本机挂载上限/u, 'under the cap means no full note')

    const en = makeCtx(mods, { argv: ['peer', 'status'], ipc, lang: 'en' })
    assert.equal(await mods.runPeerStatusCommand(en), 0)
    const enText = en.stdout.text()
    assert.match(enText, /2 \/ 3 remote devices mounted on this machine/u)
    assert.doesNotMatch(enText, /Network device cap 8 \(this machine included\)/u)
    assert.doesNotMatch(enText, /mount cap .* is reached/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer status: 满额与超额 —— 提示指本机上限、已有挂载保留；超额存量不钳制', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('pc11c-full')
  let handle
  try {
    // 满额：2/2 —— 默认网络上限 8 与显式本机上限 2 同时在场，两行不得混淆。
    const fullClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized', { extra: { maxServers: 2, mountedCount: 2, limitReached: true } }) },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: fullClient })
    handle = h
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const full = makeCtx(mods, { argv: ['peer', 'status'], ipc, lang: 'zh' })
    assert.equal(await mods.runPeerStatusCommand(full), 0)
    const fullText = full.stdout.text()
    assert.match(fullText, /本机已挂载 2 \/ 2 台远端设备/u)
    assert.match(fullText, /已达本机挂载上限（2 台）：已有挂载保留，新增挂载前请先取消部分设备的挂载/u)
    assert.match(fullText, /网络设备上限 8 台（含本机）/u, 'network cap stays 8 while the local cap is the smaller explicit 2')
    assert.doesNotMatch(fullText, /已达本机挂载上限（8 台）/u, 'the full note blames the LOCAL cap, never the network total')

    // 超额存量（上限下调后 mountedCount > maxServers）：数字照实、不钳到 2/2。
    const overClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized', { extra: { maxServers: 2, mountedCount: 3, limitReached: true } }) },
    }
    const home2 = makeHome('pc11c-over')
    const { handle: h2 } = await startIpcServer(home2, { role: 'peer', client: overClient })
    const handle2 = h2
    try {
      const ipc2 = mods.createCliIpcClient(handle2.socketPath)
      const over = makeCtx(mods, { argv: ['peer', 'status'], ipc: ipc2, lang: 'zh' })
      assert.equal(await mods.runPeerStatusCommand(over), 0)
      const overText = over.stdout.text()
      assert.match(overText, /本机已挂载 3 \/ 2 台远端设备/u, 'the over-cap stock renders verbatim, never clamped')
      assert.match(overText, /已达本机挂载上限（2 台）/u)
    } finally {
      await handle2.close()
      cleanup(home2)
    }
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('总 status: peer 板块容量行与 peer status 同口径，热改下次调用即见（中英）', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('pc11c-total')
  let handle
  try {
    // 同一罐头在三次调用之间热改（等同 maxServers 配置热改后的下一次查询）。
    let current = peerStatusBody('authorized', { extra: { maxServers: 3, mountedCount: 2, limitReached: false } })
    const client = { [ROUTES.peerStatus]: { body: () => current } }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client })
    handle = h
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const zh = makeCtx(mods, { argv: ['status'], ipc, lang: 'zh' })

    // 第一次：正常 2/3。
    assert.equal(await mods.runStatusCommand(zh), 0)
    assert.match(zh.stdout.text(), /本机已挂载 2 \/ 3 台远端设备/u)
    assert.doesNotMatch(zh.stdout.text(), /网络设备上限 8 台（含本机）/u)
    assert.doesNotMatch(zh.stdout.text(), /已达本机挂载上限/u)
    zh.stdout.lines.length = 0

    // 热改 → 满额 2/2：下一次调用立即反映新事实。
    current = peerStatusBody('authorized', { extra: { maxServers: 2, mountedCount: 2, limitReached: true } })
    assert.equal(await mods.runStatusCommand(zh), 0)
    const fullText = zh.stdout.text()
    assert.match(fullText, /本机已挂载 2 \/ 2 台远端设备/u)
    assert.match(fullText, /已达本机挂载上限（2 台）：已有挂载保留，新增挂载前请先取消部分设备的挂载/u)
    assert.match(fullText, /网络设备上限 8 台（含本机）/u)
    zh.stdout.lines.length = 0

    // 热改 → 超额 3/2：超额存量照实显示。
    current = peerStatusBody('authorized', { extra: { maxServers: 2, mountedCount: 3, limitReached: true } })
    assert.equal(await mods.runStatusCommand(zh), 0)
    assert.match(zh.stdout.text(), /本机已挂载 3 \/ 2 台远端设备/u)
    zh.stdout.lines.length = 0

    // 英文同口径。
    const en = makeCtx(mods, { argv: ['status'], ipc, lang: 'en' })
    assert.equal(await mods.runStatusCommand(en), 0)
    const enText = en.stdout.text()
    assert.match(enText, /3 \/ 2 remote devices mounted on this machine/u)
    assert.match(enText, /The local mount cap \(2 devices\) is reached — existing mounts stay/u)
    assert.match(enText, /Network device cap 8 \(this machine included\)/u)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('peer status: 旧端缺字段 —— 容量未知明示、网络上限仍单独显示；JSON 不伪造', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('pc11c-legacy')
  let handle
  try {
    // 旧端快照：只有 maxPeers，没有 PC-11a 的三个新字段。
    const legacyBody = peerStatusBody('authorized')
    delete legacyBody.maxServers
    delete legacyBody.mountedCount
    delete legacyBody.limitReached
    const legacyClient = { [ROUTES.peerStatus]: { body: () => legacyBody } }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: legacyClient })
    handle = h
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const zh = makeCtx(mods, { argv: ['peer', 'status'], ipc, lang: 'zh' })
    assert.equal(await mods.runPeerStatusCommand(zh), 0)
    const text = zh.stdout.text()
    assert.match(text, /本机挂载容量未知/u, 'missing fields say unknown explicitly')
    assert.doesNotMatch(text, /本机已挂载 \d+ \/ \d+ 台远端设备/u, 'no N/M fabricated from maxPeers - 1 or the constant 8')
    assert.doesNotMatch(text, /网络设备上限 8 台（含本机）/u, 'network cap note stays hidden unless limitReached is true')

    // 垃圾值（分数上限 / 负数挂载）同样按未知处理，不进文本。
    const junkBody = peerStatusBody('authorized', { extra: { maxServers: 1.5, mountedCount: -1, limitReached: true } })
    const junkClient = { [ROUTES.peerStatus]: { body: () => junkBody } }
    const homeJunk = makeHome('pc11c-junk')
    const { handle: h2 } = await startIpcServer(homeJunk, { role: 'peer', client: junkClient })
    const handle2 = h2
    try {
      const junk = makeCtx(mods, { argv: ['peer', 'status'], ipc: mods.createCliIpcClient(handle2.socketPath), lang: 'zh' })
      assert.equal(await mods.runPeerStatusCommand(junk), 0)
      const junkText = junk.stdout.text()
      assert.match(junkText, /本机挂载容量未知/u)
      assert.doesNotMatch(junkText, /已达本机挂载上限/u, 'a junk limitReached is not trusted on its own')
    } finally {
      await handle2.close()
      cleanup(homeJunk)
    }

    // JSON：旧端缺的字段保持缺席（不伪造 0/8），已有的 maxPeers 原样保留。
    const json = makeCtx(mods, { argv: ['peer', 'status', '--json'], ipc, lang: 'zh' })
    assert.equal(await mods.runPeerStatusCommand(json), 0)
    const parsed = JSON.parse(json.stdout.text())
    assert.equal(parsed.maxPeers, 8)
    assert.ok(!('maxServers' in parsed), 'an absent maxServers stays absent in JSON')
    assert.ok(!('mountedCount' in parsed), 'an absent mountedCount stays absent in JSON')
    assert.ok(!('limitReached' in parsed), 'an absent limitReached stays absent in JSON')

    // 总 status --json 同口径：peer 段原样透传。
    const totalJson = makeCtx(mods, { argv: ['status', '--json'], ipc, lang: 'zh' })
    assert.equal(await mods.runStatusCommand(totalJson), 0)
    const totalParsed = JSON.parse(totalJson.stdout.text())
    assert.equal(totalParsed.peer.maxPeers, 8)
    assert.ok(!('maxServers' in totalParsed.peer))
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})

test('JSON: 结构化容量字段原样保留（超额不钳制、limitReached 不改写）', async () => {
  const mods = await loadModules(ARGS_URL, I18N_URL, BOOTSTRAP_URL, IPC_SERVER_URL, IPC_CLIENT_URL, STATUS_URL, PEER_URL)
  const home = makeHome('pc11c-json')
  let handle
  try {
    const overClient = {
      [ROUTES.peerStatus]: { body: () => peerStatusBody('authorized', { extra: { maxPeers: 8, maxServers: 2, mountedCount: 3, limitReached: true } }) },
    }
    const { handle: h } = await startIpcServer(home, { role: 'peer', client: overClient })
    handle = h
    const ipc = mods.createCliIpcClient(handle.socketPath)
    const peerJson = makeCtx(mods, { argv: ['peer', 'status', '--json'], ipc, lang: 'zh' })
    assert.equal(await mods.runPeerStatusCommand(peerJson), 0)
    const parsed = JSON.parse(peerJson.stdout.text())
    assert.equal(parsed.maxPeers, 8)
    assert.equal(parsed.maxServers, 2)
    assert.equal(parsed.mountedCount, 3, 'the over-cap stock passes through verbatim, never clamped to the cap')
    assert.equal(parsed.limitReached, true)

    const totalJson = makeCtx(mods, { argv: ['status', '--json'], ipc, lang: 'zh' })
    assert.equal(await mods.runStatusCommand(totalJson), 0)
    const totalParsed = JSON.parse(totalJson.stdout.text())
    assert.equal(totalParsed.peer.maxPeers, 8)
    assert.equal(totalParsed.peer.maxServers, 2)
    assert.equal(totalParsed.peer.mountedCount, 3)
    assert.equal(totalParsed.peer.limitReached, true)
  } finally {
    if (handle !== undefined) await handle.close()
    cleanup(home)
  }
})
