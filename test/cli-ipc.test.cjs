/* dsh-zen-remote · CLI-1: 本机 IPC 控制通道 + 防遮蔽配置写入器
 *
 * 驱动 BUILT lib/cli/config-writer.js 与 lib/cli/ipc-server.js（与
 * role-wiring.test.cjs 同理：src 相对导入在 Node strip-only 模式下映射不了）。
 * 测试接缝三（SPEC）：真实 IPC Socket 服务端 + 受控 delegate 替身 + 真实临时
 * <DSH_HOME>，通过真实 Unix socket（Windows 命名管道）发 HTTP 请求，断言
 * 返回码、返回体、磁盘文件与遮蔽解除——不断言内部调用顺序。
 *
 * macOS 的 Unix socket 路径上限约 104 字节，所以临时目录用 /tmp 下的短前缀，
 * 不用 os.tmpdir()（/var/folders/... 太长，bind 会 ENAMETOOLONG）。
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const WRITER_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'config-writer.js')).href
const IPC_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'ipc-server.js')).href
const CLIENT_ROUTES_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'client-routes.js')).href
const RELAY_POOL_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'relay-pool.js')).href

const IS_WIN = process.platform === 'win32'

/** 短临时 <DSH_HOME>：Unix socket 路径上限（macOS ~104B）内的安全长度。 */
function makeHome(tag) {
  return fs.mkdtempSync(path.join('/tmp', `dshzr-${tag}-`))
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
}

/** 向 IPC socket 发一个 HTTP 请求并收完整响应。
 * 不带 Origin / Sec-Fetch-Site —— 与真实 CLI 客户端一致，也正好走
 * sameOriginPost 的「两头都缺 → 放行」通道（桌面端同形）。 */
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
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** ping 必须失败（server 已关 / socket 已清理）——返回触发错误而不是抛出。 */
async function sockRequestError(socketPath, method, reqPath) {
  try {
    const out = await sockRequest(socketPath, method, reqPath)
    return { error: null, status: out.status }
  } catch (error) {
    return { error, status: null }
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

/** 受控 delegate 替身：ping 的字段全部可调，三个角色路由可挂录妆替身。 */
function baseDelegate(overrides = {}) {
  const seen = []
  const mark = (via) => async (req, res) => {
    seen.push(`${via} ${req.method} ${String(req.url).split('?')[0]}`)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true, via }))
  }
  return {
    seen,
    delegate: {
      role: () => overrides.role ?? 'host',
      serverName: () => overrides.serverName ?? 'test-host',
      profileName: () => overrides.profileName,
      pluginVersion: () => '9.9.9-test',
      writeConfig: overrides.writeConfig ?? (() => ({ ok: true, values: {} })),
      wizardHandler: overrides.wizardHandler === undefined ? undefined : overrides.wizardHandler(seen),
      adminHandler: overrides.adminHandler === undefined ? undefined : overrides.adminHandler(seen),
      clientHandler: overrides.clientHandler === undefined ? undefined : overrides.clientHandler(seen),
    },
    seen,
  }
}

// ---- candidateSocketPaths（纯函数，两平台都钉形状） -----------------------------

test('candidateSocketPaths: unix 下从 zen-remote-cli.sock 退到 -8.sock；win32 是命名管道', async () => {
  const { candidateSocketPaths, CLI_SOCKET_BASENAME } = await import(IPC_URL)
  assert.equal(CLI_SOCKET_BASENAME, 'zen-remote-cli')

  const unix = candidateSocketPaths('/home/x/.dsh', 'linux')
  assert.equal(unix.length, 8)
  assert.equal(unix[0], path.join('/home/x/.dsh', 'zen-remote-cli.sock'))
  assert.equal(unix[1], path.join('/home/x/.dsh', 'zen-remote-cli-2.sock'))
  assert.equal(unix[7], path.join('/home/x/.dsh', 'zen-remote-cli-8.sock'))

  const win = candidateSocketPaths('C:\\home\\.dsh', 'win32')
  assert.equal(win.length, 8)
  assert.equal(win[0], '\\\\.\\pipe\\dsh-zen-remote-cli')
  assert.equal(win[1], '\\\\.\\pipe\\dsh-zen-remote-cli-2')
  assert.equal(win[7], '\\\\.\\pipe\\dsh-zen-remote-cli-8')
})

// ---- 验收 1：socket 绑定 / 占用退避 / 死文件清理复用 ------------------------------

test('IPC socket 绑定到 zen-remote-cli.sock（0600）；被占用时退到 -2.sock；死文件清理后原路径复用', { skip: IS_WIN }, async () => {
  const ipc = await import(IPC_URL)
  const home = makeHome('bind')
  const first = baseDelegate()
  const second = baseDelegate()
  let serverA
  let serverB
  try {
    // 首个实例绑定首选路径，权限 0600。
    serverA = await ipc.createCliIpcServer({ dshHome: home, delegate: first.delegate })
    const firstPath = path.join(home, 'zen-remote-cli.sock')
    assert.equal(serverA.socketPath, firstPath)
    assert.ok(fs.existsSync(firstPath), 'socket file exists')
    assert.equal(fs.statSync(firstPath).isSocket(), true, 'it is a socket, not a regular file')
    assert.equal(fs.statSync(firstPath).mode & 0o777, 0o600, 'socket file is 0600')
    const pingA = await sockRequest(firstPath, 'GET', ipc.CLI_PING_ROUTE)
    assert.equal(pingA.status, 200)
    assert.equal(first.seen.length, 0, 'ping 走内置路由，不经 delegate 路由')

    // 对端存活的占用 → 退避到 -2.sock，首个 server 不受影响。
    serverB = await ipc.createCliIpcServer({ dshHome: home, delegate: second.delegate })
    assert.equal(serverB.socketPath, path.join(home, 'zen-remote-cli-2.sock'))
    const pingA2 = await sockRequest(firstPath, 'GET', ipc.CLI_PING_ROUTE)
    assert.equal(pingA2.status, 200, 'the first socket is untouched by the backoff')
    const pingB = await sockRequest(serverB.socketPath, 'GET', ipc.CLI_PING_ROUTE)
    assert.equal(pingB.status, 200)

    // 死文件（普通文件占位）→ 探测失败 → 清理 → 原路径复用绑定。
    const deadHome = makeHome('dead')
    try {
      const deadPath = path.join(deadHome, 'zen-remote-cli.sock')
      fs.writeFileSync(deadPath, 'not a socket')
      const third = baseDelegate()
      const serverC = await ipc.createCliIpcServer({ dshHome: deadHome, delegate: third.delegate })
      try {
        assert.equal(serverC.socketPath, deadPath, 'the stale file was removed and the FIRST path reused')
        assert.equal(fs.statSync(deadPath).isSocket(), true)
        const pingC = await sockRequest(deadPath, 'GET', ipc.CLI_PING_ROUTE)
        assert.equal(pingC.status, 200)
      } finally {
        await serverC.close()
      }
      assert.equal(fs.existsSync(deadPath), false, 'close removes the socket file')
    } finally {
      cleanup(deadHome)
    }
  } finally {
    if (serverA !== undefined) await serverA.close()
    if (serverB !== undefined) await serverB.close()
    cleanup(home)
  }
})

// ---- 验收 2：ping 协议握手 -------------------------------------------------------

test('GET /ping 携带协议版本、插件版本、PID、role 与 serves/connects，响应头带双版本', async () => {
  const ipc = await import(IPC_URL)
  const home = makeHome('ping')
  let server
  try {
    for (const role of ['host', 'client']) {
      const { delegate } = baseDelegate({
        role,
        serverName: '茶壶机',
        profileName: role === 'host' ? 'web' : undefined,
      })
      server = await ipc.createCliIpcServer({ dshHome: home, delegate })
      const res = await sockRequest(server.socketPath, 'GET', ipc.CLI_PING_ROUTE)
      assert.equal(res.status, 200)
      assert.equal(res.headers['x-zr-cli-version'], String(ipc.CLI_PROTOCOL_VERSION))
      assert.equal(res.headers['x-zr-plugin-version'], '9.9.9-test')
      const body = JSON.parse(res.body)
      assert.deepEqual(body, {
        ok: true,
        cliProtocolVersion: 1,
        pluginVersion: '9.9.9-test',
        pid: process.pid,
        role,
        serves: role !== 'client',
        connects: role !== 'host',
        serverName: '茶壶机',
        ...(role === 'host' ? { profileName: 'web' } : {}),
      })
      await server.close()
      server = undefined
    }

    // 错误方法与未知路径：405 / 404，同样带版本头。
    const { delegate } = baseDelegate()
    server = await ipc.createCliIpcServer({ dshHome: home, delegate })
    const post = await sockRequest(server.socketPath, 'POST', ipc.CLI_PING_ROUTE, {})
    assert.equal(post.status, 405)
    assert.equal(post.headers['x-zr-cli-version'], '1')
    const missing = await sockRequest(server.socketPath, 'GET', '/_dsh/zen-remote/cli/nope')
    assert.equal(missing.status, 404)
    assert.equal(JSON.parse(missing.body).ok, false)
  } finally {
    if (server !== undefined) await server.close()
    cleanup(home)
  }
})

// ---- 验收 3：POST /config 真写盘 + 解遮蔽 + env 遮蔽拒绝 -------------------------

test('POST /config 写 lan-gate.config.json、解除 row 与 cordis.patch.yml 遮蔽并触发 checkNow；env 遮蔽返回 409', async () => {
  const ipc = await import(IPC_URL)
  const { writeCliConfig, ENV_VAR_BY_FIELD } = await import(WRITER_URL)

  // 字段映射表钉形状（CLI 提示要靠它报变量名）。
  assert.equal(ENV_VAR_BY_FIELD.port, 'LAN_GATE_PORT')
  assert.equal(ENV_VAR_BY_FIELD.host, 'LAN_GATE_HOST')
  assert.equal(ENV_VAR_BY_FIELD.targetPort, 'LAN_GATE_TARGET_PORT')
  assert.equal(ENV_VAR_BY_FIELD.rateLimit, 'LAN_GATE_RATE_LIMIT')
  assert.equal(ENV_VAR_BY_FIELD.trustedProxies, 'LAN_GATE_TRUSTED_PROXIES')
  assert.equal(ENV_VAR_BY_FIELD.vapidSubject, 'LAN_GATE_VAPID_SUBJECT')
  assert.equal(ENV_VAR_BY_FIELD.lang, 'LAN_GATE_LANG')
  assert.equal(ENV_VAR_BY_FIELD.pushEvents, 'DSH_PUSH_EVENTS')
  assert.equal(ENV_VAR_BY_FIELD.pushDebounceMs, 'DSH_PUSH_DEBOUNCE_MS')
  assert.equal(ENV_VAR_BY_FIELD.pushSummary, 'DSH_PUSH_SUMMARY')
  assert.equal(ENV_VAR_BY_FIELD.pushTurnEnd, 'DSH_PUSH_TURN_END')
  assert.equal(ENV_VAR_BY_FIELD.pushTool, 'DSH_PUSH_TOOL')

  const home = makeHome('config')
  const patchPath = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
  fs.mkdirSync(path.dirname(patchPath), { recursive: true })
  fs.writeFileSync(patchPath, [
    '# patch layer',
    '- id: dsh-zen-remote',
    '  config:',
    '    role: client',
    '    trustedProxies: 10.0.0.1',
    '    serverName: wizard-name',
    '- id: other-plugin',
    '  config:',
    '    role: keepme',
    '',
  ].join('\n'))
  // 只剩一个键的 config 块：清空后应保留 config: {}。
  const patch2Path = path.join(home, 'profiles', 'headless', 'cordis.patch.yml')
  fs.mkdirSync(path.dirname(patch2Path), { recursive: true })
  fs.writeFileSync(patch2Path, [
    '- id: dsh-zen-remote',
    '  config:',
    '    role: client',
    '',
  ].join('\n'))

  const row = { idleHours: 24, serverName: 'row-name', turnFoldDesktop: false }
  let checkNowCount = 0
  const { delegate } = baseDelegate({
    role: 'host',
    writeConfig: (input) => writeCliConfig({
      dshHome: home,
      row,
      env: process.env,
      profileName: 'web',
      set: input.set,
      unset: input.unset,
      onAfterWrite: () => { checkNowCount += 1 },
    }),
  })
  // 提取 patch 文件里某一个 - id: 块的文本（到下一个 - id: 行之前）——
  // 断言只允许在块内找，跨块的正则会把别的插件的键误判进来。
  const blockOf = (text, id) => {
    const lines = text.split('\n')
    const start = lines.findIndex((l) => l.includes(`- id: ${id}`))
    if (start === -1) return null
    const end = lines.findIndex((l, i) => i > start && l.startsWith('- id:'))
    return lines.slice(start, end === -1 ? lines.length : end).join('\n')
  }
  let server
  try {
    server = await ipc.createCliIpcServer({ dshHome: home, delegate })
    const post = (body) => sockRequest(server.socketPath, 'POST', ipc.CLI_CONFIG_ROUTE, body)
    const file = () => JSON.parse(fs.readFileSync(path.join(home, 'lan-gate.config.json'), 'utf8'))

    // set 两个键：落盘 0600、返回生效值、checkNow 触发一次。
    const r1 = await post({ set: { port: 4100, serverName: 'cli-host' } })
    assert.equal(r1.status, 200)
    const b1 = JSON.parse(r1.body)
    assert.equal(b1.ok, true)
    assert.equal(b1.values.port, 4100)
    assert.equal(b1.values.serverName, 'cli-host')
    assert.equal(file().port, 4100)
    assert.equal(file().serverName, 'cli-host')
    if (!IS_WIN) assert.equal(fs.statSync(path.join(home, 'lan-gate.config.json')).mode & 0o777, 0o600)
    assert.equal(checkNowCount, 1)

    // row 层遮蔽：idleHours 在 row 上有旧值 → 写盘同时删 row 键，值穿透到 file 层。
    const r2 = await post({ set: { idleHours: 72 } })
    assert.equal(r2.status, 200)
    assert.equal(JSON.parse(r2.body).values.idleHours, 72)
    assert.equal('idleHours' in row, false, 'the shadowing row key was deleted')
    assert.equal('serverName' in row, false, 'the earlier set target left the row too')
    assert.equal(row.turnFoldDesktop, false, 'row keys outside set/unset stay untouched')

    // cordis.patch.yml 解遮蔽：只删 dsh-zen-remote 块里的 role 行，别的键、别的插件不动。
    const r3 = await post({ set: { role: 'host' } })
    assert.equal(r3.status, 200)
    assert.equal(JSON.parse(r3.body).values.role, 'host', 'the file layer wins after unshadowing')
    const patchAfter = fs.readFileSync(patchPath, 'utf8')
    const zenBlock = blockOf(patchAfter, 'dsh-zen-remote')
    assert.ok(zenBlock, 'the dsh-zen-remote block survives')
    assert.equal(/^ {4}role:/mu.test(zenBlock), false, 'role line removed from the dsh-zen-remote block')
    assert.match(zenBlock, /^ {4}trustedProxies: 10\.0\.0\.1/mu, 'a key outside set/unset stays')
    assert.equal(/^ {4}serverName:/mu.test(zenBlock), false, 'the r1 set un-shadowed the stale patch serverName too')
    assert.match(blockOf(patchAfter, 'other-plugin'), /^ {4}role: keepme/mu, 'other plugins untouched')

    // 兜底扫描 profiles 下的每个 cordis.patch.yml（headless 未指名也在扫描范围内）。
    // 这次 set 同时清掉 patch 里残留的 trustedProxies 旧值 —— 块被清空，
    // 应保留一行 config: {}。
    await post({ set: { trustedProxies: '127.0.0.1' } })
    const patchMid = fs.readFileSync(patchPath, 'utf8')
    assert.match(blockOf(patchMid, 'dsh-zen-remote'), /^ {2}config: \{\}/mu, 'the emptied config block keeps a config: {} line')
    const patch2After = fs.readFileSync(patch2Path, 'utf8')
    assert.equal(/^ {4}role:/mu.test(patch2After), false, 'the fallback scan unshadowed the other profile too')
    assert.match(patch2After, /^ {2}config: \{\}/mu, 'the other profile block keeps a config: {} line too')

    // unset：删 file 键 + 删 row 键 + patch 键幂等（早已解遮蔽，不再有残留）。
    const r4 = await post({ unset: ['serverName'] })
    assert.equal(r4.status, 200)
    assert.equal('serverName' in file(), false, 'the unset key left the file')
    assert.equal('serverName' in row, false, 'the unset key left the row')
    assert.equal(/^ {4}serverName:/mu.test(blockOf(fs.readFileSync(patchPath, 'utf8'), 'dsh-zen-remote')), false, 'unset leaves no stale key behind')

    // env 遮蔽：set 与 unset 都拒，且不落盘。
    process.env.LAN_GATE_PORT = '3000'
    try {
      const r5 = await post({ set: { port: 5000 } })
      assert.equal(r5.status, 409)
      const b5 = JSON.parse(r5.body)
      assert.equal(b5.ok, false)
      assert.equal(b5.error.code, 'env-shadowed')
      assert.equal(b5.error.field, 'port')
      assert.equal(b5.error.envVar, 'LAN_GATE_PORT')
      assert.equal(file().port, 4100, 'the shadowed write never touched the file')
      assert.equal(checkNowCount, 5, 'the refused write triggered nothing')
    } finally {
      delete process.env.LAN_GATE_PORT
    }
    process.env.DSH_PUSH_SUMMARY = '1'
    try {
      const r6 = await post({ unset: ['pushSummary'] })
      assert.equal(r6.status, 409)
      const b6 = JSON.parse(r6.body)
      assert.equal(b6.error.field, 'pushSummary')
      assert.equal(b6.error.envVar, 'DSH_PUSH_SUMMARY')
    } finally {
      delete process.env.DSH_PUSH_SUMMARY
    }

    // set / unset 全空：无写盘动作，也不触发 checkNow。
    const before = fs.readFileSync(path.join(home, 'lan-gate.config.json'), 'utf8')
    const r7 = await post({})
    assert.equal(r7.status, 200)
    assert.equal(fs.readFileSync(path.join(home, 'lan-gate.config.json'), 'utf8'), before)
    assert.equal(checkNowCount, 5)
  } finally {
    if (server !== undefined) await server.close()
    cleanup(home)
  }
})

// ---- 验收 4：host 角色的路由转交与门禁 -------------------------------------------

test('host 角色：wizard/admin/debug-report 免 Cookie 直达 delegate，client 配对路由 409 wrong-role', async () => {
  const ipc = await import(IPC_URL)
  const home = makeHome('gate-host')
  const { delegate, seen } = baseDelegate({
    role: 'host',
    wizardHandler: (seen) => async (req, res) => {
      seen.push('wizard')
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, via: 'wizard' }))
    },
    adminHandler: (seen) => async (req, res) => {
      seen.push('admin')
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, via: 'admin' }))
    },
    clientHandler: (seen) => async (req, res) => {
      seen.push('client')
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, via: 'client' }))
    },
  })
  let server
  try {
    server = await ipc.createCliIpcServer({ dshHome: home, delegate })
    const sock = server.socketPath

    const wizard = await sockRequest(sock, 'GET', '/_dsh/zen-remote/admin/wizard/status')
    assert.equal(wizard.status, 200)
    assert.equal(JSON.parse(wizard.body).via, 'wizard', 'wizard routes forward to the delegate handler')

    const admin = await sockRequest(sock, 'GET', '/_dsh/zen-remote/admin/status')
    assert.equal(admin.status, 200)
    assert.equal(JSON.parse(admin.body).via, 'admin')

    const report = await sockRequest(sock, 'GET', '/_dsh/zen-remote/client/debug-report')
    assert.equal(report.status, 200)
    assert.equal(JSON.parse(report.body).via, 'client', 'debug-report answers on both roles')

    const remoteStatus = await sockRequest(sock, 'GET', '/_dsh/zen-remote/client/remote-status')
    assert.equal(remoteStatus.status, 200)

    const claim = await sockRequest(sock, 'POST', '/_dsh/zen-remote/client/claim', { serverUrl: 'http://127.0.0.1:9', code: 'ABCD2345', name: 'x' })
    assert.equal(claim.status, 409)
    const claimBody = JSON.parse(claim.body)
    assert.equal(claimBody.ok, false)
    assert.equal(claimBody.error.code, 'wrong-role')
    assert.equal(claimBody.error.role, 'host')
    assert.equal(claimBody.error.required, 'client')

    const status = await sockRequest(sock, 'GET', '/_dsh/zen-remote/client/status')
    assert.equal(status.status, 409)
    assert.equal(JSON.parse(status.body).error.required, 'client')

    assert.equal(seen.filter((s) => s === 'wizard').length, 1, 'each route hit its delegate exactly once')
    assert.equal(seen.filter((s) => s === 'admin').length, 1)
    assert.equal(seen.filter((s) => s.startsWith('client')).length, 2, 'debug-report and remote-status only')
  } finally {
    if (server !== undefined) await server.close()
    cleanup(home)
  }
})

// ---- 验收 5：client 角色经 IPC 直操 relayPool ------------------------------------

test('client 角色：IPC 的 client/status、claim、unpair 直操真实 relayPool；admin/wizard 409 wrong-role', async () => {
  const ipc = await import(IPC_URL)
  const { createClientHandler } = await import(CLIENT_ROUTES_URL)
  const { createRelayPool } = await import(RELAY_POOL_URL)

  const home = makeHome('gate-client')
  // 模拟远端 host：桌面配对码兑换 + 中继握手，都是 pool/claim 真会打的端点。
  const mockSeen = []
  const mock = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      mockSeen.push({ method: req.method, url: String(req.url).split('?')[0] })
      const send = (status, body) => {
        const bytes = Buffer.from(JSON.stringify(body))
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
      }
      if (req.method === 'POST' && req.url === '/lan-gate/pair/claim-desktop') {
        send(200, { ok: true, token: 'tok-cli-1', id: 'dev-1', name: 'cli-test' })
        return
      }
      if (req.method === 'POST' && req.url === '/_dsh/zen-remote/relay/v1/handshake') {
        send(200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: 'srv', dshVersion: '0.0.0', fingerprints: {} })
        return
      }
      send(404, { ok: false })
    })
  })
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const mockUrl = `http://127.0.0.1:${mock.address().port}`

  const pool = createRelayPool({ stateFile: path.join(home, 'zen-remote-state.json') })
  const clientHandler = createClientHandler({
    admit: () => ({ peer: {} }),
    getRowConfig: () => ({}),
    pool,
    getLogSnapshot: () => [],
    getPluginVersion: () => '0.0.0-test',
  })
  const { delegate } = baseDelegate({ role: 'client', clientHandler: () => clientHandler })
  let server
  try {
    server = await ipc.createCliIpcServer({ dshHome: home, delegate })
    const sock = server.socketPath

    // 角色门禁：host 侧路由全拒。
    const wizard = await sockRequest(sock, 'GET', '/_dsh/zen-remote/admin/wizard/status')
    assert.equal(wizard.status, 409)
    const wizardBody = JSON.parse(wizard.body)
    assert.equal(wizardBody.error.code, 'wrong-role')
    assert.equal(wizardBody.error.role, 'client')
    assert.equal(wizardBody.error.required, 'host')

    // status / claim / unpair 直达 client handler。
    const status0 = await sockRequest(sock, 'GET', '/_dsh/zen-remote/client/status')
    assert.equal(status0.status, 200)
    const body0 = JSON.parse(status0.body)
    assert.equal(body0.state, 'unpaired')
    assert.deepEqual(body0.servers, [])

    // claim：兑换（真打 mock 的 claim-desktop）→ 落入 pool → pool 拨号握手。
    const claim = await sockRequest(sock, 'POST', '/_dsh/zen-remote/client/claim', { serverUrl: mockUrl, code: 'ABCD2345', name: 'cli-test' })
    assert.equal(claim.status, 200, claim.body)
    const claimBody = JSON.parse(claim.body)
    assert.equal(claimBody.ok, true)
    assert.equal(claimBody.deviceId, 'dev-1')
    assert.ok(claimBody.entryId, 'the pool entry id rides the answer')
    const entryId = claimBody.entryId

    await waitFor(() => pool.entries().length === 1 && pool.entries()[0].client.state === 'online', 5000, 'the pool client reached the mock relay')
    assert.ok(mockSeen.some((r) => r.url === '/lan-gate/pair/claim-desktop'), 'the claim round-trip hit the mock')
    assert.ok(mockSeen.some((r) => r.url === '/_dsh/zen-remote/relay/v1/handshake'), 'the pool dialed the mock relay')

    const status1 = await sockRequest(sock, 'GET', '/_dsh/zen-remote/client/status')
    assert.equal(status1.status, 200)
    const body1 = JSON.parse(status1.body)
    assert.equal(body1.servers.length, 1)
    assert.equal(body1.servers[0].serverId, 'abcd1234')
    assert.equal(body1.servers[0].state, 'online')

    // unpair：经 IPC 移除该条目（写状态文件、停 client）。
    const unpair = await sockRequest(sock, 'POST', '/_dsh/zen-remote/client/unpair', { entryId })
    assert.equal(unpair.status, 200)
    assert.deepEqual(JSON.parse(unpair.body), { ok: true, removed: 1 })
    await waitFor(() => pool.entries().length === 0, 3000, 'the pool entry is gone')
  } finally {
    if (server !== undefined) await server.close()
    pool.stop()
    await new Promise((resolve) => mock.close(resolve))
    cleanup(home)
  }
})

// ---- 验收 6：热重载不断连（delegate 换、socket 不动） -----------------------------

test('接线端到端：连续两次 index.apply 切换 host -> client，socket 路径不变且 ping 立即反映新角色', async () => {
  const ipc = await import(IPC_URL)
  const index = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href)
  const home = makeHome('apply-reload')
  // role-wiring 风格的 fake ctx：记录 effect 返回值（旧行的 disposer 靠它
  // 触发），inject 不执行（不需要真路由），reflect 读永远 undefined（与
  // role-wiring 的 makeCtx 同形）。
  const effects = []
  const ctx = {
    plugin() {},
    provide() { return () => {} },
    on() { return () => {} },
    logger: { warn() {} },
    effect(fn) { effects.push(fn()) },
    inject() {},
    reflect: { get: () => undefined },
  }
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 行 1（host）：apply 的 IPC 生命周期合在 restart-watcher effect 里——
    // host 的第三个顶层 effect（桥注册表、闲置扫描、重启 watcher）。
    index.apply(ctx, { role: 'host' })
    assert.equal(effects.length, 3, 'host 仍是三个顶层 effect（IPC 没有新增）')
    const sockPath = path.join(home, 'zen-remote-cli.sock')
    await waitFor(() => fs.existsSync(sockPath), 3000, 'bound after the first apply')
    const ping1 = await sockRequest(sockPath, 'GET', ipc.CLI_PING_ROUTE)
    assert.equal(JSON.parse(ping1.body).role, 'host')

    // 行 2（client）：cordis 真实顺序是新行 apply 先跑、旧行 disposer 后跑。
    index.apply(ctx, { role: 'client' })
    assert.equal(effects.length, 8, 'client 加五个（桥、池、设备名、重启 watcher、fallback 定时器）')
    const oldRowDisposer = effects[2]
    assert.equal(typeof oldRowDisposer, 'function')
    oldRowDisposer()
    // 宽限期被新行持有挡住 → socket 仍在原路径。
    await sleep(ipc.CLI_CLOSE_GRACE_MS + 50)
    const ping2 = await sockRequest(sockPath, 'GET', ipc.CLI_PING_ROUTE)
    assert.equal(ping2.status, 200, 'the socket survived the apply-driven reload')
    const body2 = JSON.parse(ping2.body)
    assert.equal(body2.role, 'client', 'ping immediately reflects the new role')
    assert.equal(body2.serves, false)
    assert.equal(body2.connects, true)
    // 新行的 effect 清理照常工作（这之后宽限期关闭由 acquire 测试覆盖）。
    for (const disposer of effects.slice(3)) disposer()
  } finally {
    cleanup(home)
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  }
})

test('热重载：两次 acquire 换 delegate，socket 路径不变不断连；最后一次 release 后宽限期关闭并清理', async () => {
  const ipc = await import(IPC_URL)
  const home = makeHome('reload')
  const hostSide = baseDelegate({ role: 'host', serverName: 'host-side' })
  const clientSide = baseDelegate({ role: 'client', serverName: 'client-side' })
  try {
    // 行 1 apply：绑定。
    const handle1 = ipc.acquireCliIpcServer(home, hostSide.delegate)
    const sockPath = path.join(home, 'zen-remote-cli.sock')
    await waitFor(() => fs.existsSync(sockPath), 3000, 'the socket file appears')
    const ping1 = await sockRequest(sockPath, 'GET', ipc.CLI_PING_ROUTE)
    assert.equal(JSON.parse(ping1.body).role, 'host')

    // 行 2 apply（模拟热重载）：同一进程同一 home → 复用同一 server，只换 delegate。
    const handle2 = ipc.acquireCliIpcServer(home, clientSide.delegate)
    // cordis 顺序：新行 apply 完成后旧行的清理才跑 → release 行 1。
    handle1.release()
    // 宽限期内新行仍持有 → 不关闭。
    await sleep(ipc.CLI_CLOSE_GRACE_MS + 50)
    const ping2 = await sockRequest(sockPath, 'GET', ipc.CLI_PING_ROUTE)
    assert.equal(ping2.status, 200, 'the socket survived the reload')
    const body2 = JSON.parse(ping2.body)
    assert.equal(body2.role, 'client', 'ping immediately reflects the new role')
    assert.equal(body2.serves, false)
    assert.equal(body2.connects, true)
    assert.equal(body2.serverName, 'client-side')

    // 最后一行 release：宽限期后关闭 + 清理 socket 文件。
    handle2.release()
    await waitFor(() => !fs.existsSync(sockPath), ipc.CLI_CLOSE_GRACE_MS + 2000, 'the socket file is cleaned after the grace period')
    const dead = await sockRequestError(sockPath, 'GET', ipc.CLI_PING_ROUTE)
    assert.notEqual(dead.error, null, 'ping after close fails (connection refused / ENOENT)')
  } finally {
    cleanup(home)
  }
})

// ---- acquire 后 delegate 路由在重载后换新（409 门禁跟着新行走） --------------------

test('热重载后 IPC 路由门禁立即跟随新 delegate 的角色', async () => {
  const ipc = await import(IPC_URL)
  const home = makeHome('reload-gate')
  const hostSide = baseDelegate({ role: 'host', adminHandler: (seen) => async (req, res) => {
    seen.push('admin')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true, via: 'admin' }))
  } })
  const clientSide = baseDelegate({ role: 'client' })
  try {
    const handle1 = ipc.acquireCliIpcServer(home, hostSide.delegate)
    const sockPath = path.join(home, 'zen-remote-cli.sock')
    await waitFor(() => fs.existsSync(sockPath), 3000, 'bound')
    const before = await sockRequest(sockPath, 'GET', '/_dsh/zen-remote/admin/status')
    assert.equal(before.status, 200)
    assert.equal(JSON.parse(before.body).via, 'admin')

    const handle2 = ipc.acquireCliIpcServer(home, clientSide.delegate)
    handle1.release()
    const after = await sockRequest(sockPath, 'GET', '/_dsh/zen-remote/admin/status')
    assert.equal(after.status, 409, 'the NEW delegate is client: admin routes refuse')
    assert.equal(JSON.parse(after.body).error.required, 'host')
    handle2.release()
  } finally {
    cleanup(home)
  }
})
