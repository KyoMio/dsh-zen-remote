/* dsh-mobile-pwa · gateway smoke, BOOT_SHELL, long-cache, auth-exchange & Web Push E2E tests */
'use strict'
const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const net = require('node:net')
const http = require('node:http')
const zlib = require('node:zlib')
const vm = require('node:vm')
const crypto = require('node:crypto')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { startMockTarget, startMockAuthTarget, startGateway, startGatewayAt, request, stopAll, pairDevice, REMOTE_HEADERS } = require('./util.cjs')

const VIEWPORT_RE = /<meta[^>]*name=["']?viewport["']?[^>]*>/gi
const DSH_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1" />'

function defaultPage() {
  return [
    '<!doctype html><html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<link rel="preload" as="script" href="/plugins/??@deepseek-ai/dsh-client-ui-layout/client.js&rev=testrev-a">',
    '<link rel="preload" as="script" href="/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=testrev-b">',
    '<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=testrev"></script>',
    '<link rel="manifest" href="./manifest.webmanifest" />',
    '</head><body>',
    '<main data-slot="conversation">upstream-ok</main>',
    '<div id="root"></div>',
    '<script>window.__DSH_BOOT_READY__ = true</script>',
    '</body></html>',
  ].join('\n')
}

let SHARED_PORT = 0
let sharedUpstream
let sharedGw
let sharedSeen = []
let sharedHandler = null
let onUpstreamSocket = null

before(async () => {
  const page = defaultPage()
  sharedUpstream = http.createServer((req, res) => {
    sharedSeen.push({ method: req.method, path: req.url, headers: req.headers })
    if (sharedHandler) { sharedHandler(req, res); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  sharedUpstream.on('connection', (sock) => {
    if (onUpstreamSocket) onUpstreamSocket(sock)
  })
  await new Promise((resolve, reject) => {
    sharedUpstream.on('error', reject)
    sharedUpstream.listen(0, '127.0.0.1', resolve)
  })
  sharedGw = startGateway(0, sharedUpstream.address().port, { LAN_GATE_LOGO_TIMEOUT_MS: '120' })
  SHARED_PORT = await sharedGw.ready
})

after(async () => {
  await stopAll({
    close: (done) => {
      sharedUpstream.closeAllConnections?.()
      sharedUpstream.close(done)
    },
  }, sharedGw && sharedGw.child)
})

beforeEach(() => {
  sharedSeen = []
  sharedHandler = null
  onUpstreamSocket = null
})

test('gateway logo proxy: an unpaired visitor gets the upstream favicon verbatim on both fixed paths', async () => {
  const upstreamBody = '<svg xmlns="http://www.w3.org/2000/svg"><text>logo</text></svg>'
  sharedHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(upstreamBody)
  }
  for (const p of ['/lan-gate/logo.svg', '/lan-gate/logo-dark.svg']) {
    const res = await request(SHARED_PORT, { path: p, headers: REMOTE_HEADERS })
    assert.strictEqual(res.status, 200, p)
    assert.strictEqual(res.headers['content-type'], 'image/svg+xml', p)
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff')
    assert.strictEqual(res.body, upstreamBody, p)
  }
})

test('gateway logo proxy: an upstream miss answers 404 on the logo route', async () => {
  sharedHandler = (req, res) => {
    if (req.url === '/favicon.svg' || req.url === '/favicon-dark.svg') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('upstream-404')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(defaultPage())
  }
  for (const p of ['/lan-gate/logo.svg', '/lan-gate/logo-dark.svg']) {
    const res = await request(SHARED_PORT, { path: p, headers: REMOTE_HEADERS })
    assert.strictEqual(res.status, 404, p)
  }
})

test('gateway logo proxy: the allowlist is exact — lookalike paths hit the pairing wall, and a query never reaches upstream', async () => {
  for (const p of ['/lan-gate/logo.svg/../x', '/lan-gate/logo.svg%2f..', '/favicon.svg', '/lan-gate/logo.svgx']) {
    const res = await request(SHARED_PORT, { path: p, headers: REMOTE_HEADERS })
    assert.strictEqual(res.status, 401, p)
    assert.ok(res.body.includes('id="code"'), p + ' gets the pairing page, not upstream content')
  }
  const res = await request(SHARED_PORT, { path: '/lan-gate/logo.svg?x=/api/secret', headers: REMOTE_HEADERS })
  assert.strictEqual(res.status, 200)
  const faviconCalls = sharedSeen.filter((call) => call.path.indexOf('/favicon') === 0)
  assert.deepEqual(faviconCalls.map((call) => call.path), ['/favicon.svg'])
  assert.ok(sharedSeen.every((call) => call.path.indexOf('/api/') !== 0), 'no other upstream path was touched')
})

test('gateway pairing page: DSH-styled shell with the proxied logo and the original form contract', async () => {
  const page = await request(SHARED_PORT, { path: '/', headers: REMOTE_HEADERS })
  assert.strictEqual(page.status, 401)
  assert.ok(page.body.includes('<picture class="logo">'), 'the logo is a picture element')
  assert.ok(page.body.includes('/lan-gate/logo.svg') && page.body.includes('/lan-gate/logo-dark.svg'))
  assert.ok(page.body.includes('media="(prefers-color-scheme: dark)"'), 'dark-mode sources/theme-color are present')
  assert.ok(page.body.includes('#f7f8fa') && page.body.includes('#151517'), 'the DSH light/dark page backgrounds')
  for (const id of ['id="code"', 'id="name"', 'id="go"', 'id="err"']) {
    assert.ok(page.body.includes(id), id + ' survives the restyle')
  }
})

test('gateway pairing page: shows the settings hint once in each language', async () => {
  for (const [lang, settings] of [['en', 'DSH Plugins page'], ['zh-CN', 'DSH「插件」页']]) {
    const page = await request(SHARED_PORT, { path: '/', headers: { ...REMOTE_HEADERS, 'accept-language': lang } })
    assert.strictEqual(page.status, 401)
    const visibleHtml = page.body.split('<script>')[0]
    assert.ok(visibleHtml.match(/<p class="sub">[^<]+<\/p>/)?.[0].includes(settings), lang)
    assert.strictEqual(visibleHtml.split(settings).length - 1, 1, lang)
  }
})

test('gateway logo proxy (T71-fix): response headers are whitelisted, 200 carries CSP + nosniff; POST 405, HEAD bodyless', async () => {
  sharedHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Set-Cookie': 'up=1', 'X-Up-Leak': 'yes', 'Cache-Control': 'no-store' })
    res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  }
  const res = await request(SHARED_PORT, { path: '/lan-gate/logo.svg', headers: REMOTE_HEADERS })
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.headers['content-type'], 'image/svg+xml')
  assert.strictEqual(res.headers['content-security-policy'], "default-src 'none'")
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff')
  assert.strictEqual(res.headers['cache-control'], 'public, max-age=300', 'the whitelisted directive, not the upstream\'s')
  assert.strictEqual(res.headers['set-cookie'], undefined, 'the upstream cookie stays upstream')
  assert.strictEqual(res.headers['x-up-leak'], undefined, 'custom upstream headers stay upstream')

  const post = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/logo.svg', headers: REMOTE_HEADERS, body: {} })
  assert.strictEqual(post.status, 405)

  const head = await request(SHARED_PORT, { method: 'HEAD', path: '/lan-gate/logo.svg', headers: REMOTE_HEADERS })
  assert.strictEqual(head.status, 200)
  assert.strictEqual(head.headers['content-type'], 'image/svg+xml')
  assert.strictEqual(head.body, '', 'HEAD answers headers only')
})

test('gateway logo proxy (T71-fix): path variants — doubled slashes, case, parameters, absolute-form — all hit the pairing wall', async () => {
  for (const p of ['//lan-gate/logo.svg', '/LAN-GATE/logo.svg', '/lan-gate/logo.svg;x', 'http://evil.example/lan-gate/logo.svg']) {
    const res = await request(SHARED_PORT, { path: p, headers: REMOTE_HEADERS })
    assert.strictEqual(res.status, 401, p)
    assert.ok(res.body.includes('id="code"'), p + ' gets the pairing page, not the logo')
  }
})

test('gateway logo proxy (T71-fix): a silent upstream is torn down when the visitor leaves, and times out to 404', async () => {
  const sockets = new Set()
  let closes = 0
  const upstream = http.createServer((req, _res) => { req.resume() })
  upstream.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => { closes += 1; sockets.delete(sock) }) })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const gw = startGateway(0, upstream.address().port, { LAN_GATE_LOGO_TIMEOUT_MS: '120' })
  const port = await gw.ready
  try {
    let sawUpstreamReq = false
    upstream.on('request', () => { sawUpstreamReq = true })
    const visitor = net.connect(port, '127.0.0.1', () => {
      visitor.write('GET /lan-gate/logo.svg HTTP/1.1\r\nHost: gw\r\nX-Forwarded-For: 203.0.113.9\r\nX-Forwarded-Proto: https\r\n\r\n')
    })
    visitor.on('error', () => {})
    const deadline1 = Date.now() + 2000
    while (!sawUpstreamReq && Date.now() < deadline1) await new Promise((r) => setTimeout(r, 10))
    assert.ok(sawUpstreamReq, 'upstream received the logo request')
    visitor.destroy()
    const deadline2 = Date.now() + 2000
    while ((sockets.size > 0 || closes < 1) && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 10))
    assert.equal(sockets.size, 0, 'no upstream socket left for the disconnected visitor')
    assert.ok(closes >= 1, 'the upstream saw its connection close')

    const t0 = Date.now()
    const res = await request(port, { path: '/lan-gate/logo-dark.svg', headers: REMOTE_HEADERS })
    const elapsed = Date.now() - t0
    assert.strictEqual(res.status, 404)
    assert.ok(elapsed >= 100 && elapsed < 3000, 'the answer waits out the configured timeout, then 404s (took ' + elapsed + 'ms)')
  } finally { await stopAll(upstream, gw.child) }
})

test('gateway: starts and reports pwa:true', async () => {
  const status = await request(SHARED_PORT, { path: '/lan-gate/status' })
  assert.strictEqual(status.status, 200)
  const j = JSON.parse(status.body)
  assert.strictEqual(j.state, 'running')
  assert.strictEqual(j.pwa, true)
})

test('gateway: serves PWA assets (/pwa/manifest.json, /pwa/sw.js)', async () => {
  const manifest = await request(SHARED_PORT, { path: '/pwa/manifest.json' })
  assert.strictEqual(manifest.status, 200)
  assert.strictEqual(JSON.parse(manifest.body).display, 'standalone')
  assert.strictEqual(JSON.parse(manifest.body).background_color, '#f9fafb')

  const sw = await request(SHARED_PORT, { path: '/pwa/sw.js' })
  assert.strictEqual(sw.status, 200)
  assert.ok(sw.body.includes('dsh-mobile-pwa'))
})

test('gateway: /pwa/sw.js response carries Service-Worker-Allowed: / so it can control the whole app', async () => {
  const sw = await request(SHARED_PORT, { path: '/pwa/sw.js' })
  assert.strictEqual(sw.status, 200)
  assert.strictEqual(sw.headers['service-worker-allowed'], '/')

  const manifest = await request(SHARED_PORT, { path: '/pwa/manifest.json' })
  assert.strictEqual(manifest.headers['service-worker-allowed'], undefined)
})

test('gateway: injected bootstrap registers the service worker with scope "/"', async () => {
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  assert.match(page.body, /navigator\.serviceWorker\.register\(['"]\/pwa\/sw\.js['"],\s*\{\s*scope:\s*['"]\/['"]\s*\}\)/, 'register() call passes an explicit scope of "/"')
})

test('gateway: strips an upstream-supplied manifest link so the gateway\'s own /pwa/manifest.json is the only one and actually governs', async () => {
  sharedHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="manifest" href="/manifest.webmanifest" /></head><body>ok</body></html>')
  }
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  const links = page.body.match(/<link[^>]*rel=["']?manifest["']?[^>]*>/gi) || []
  assert.strictEqual(links.length, 1, 'exactly one manifest link survives')
  assert.ok(links[0].includes('/pwa/manifest.json'), 'the surviving link is the gateway\'s own')
  assert.ok(!page.body.includes('/manifest.webmanifest'), 'the shadowed upstream manifest link is gone')
})

test('gateway: injects manifest link, PWA bootstrap & app.css into HTML (local)', async () => {
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  assert.strictEqual(page.status, 200)
  assert.ok(page.body.includes('rel="manifest"'), 'manifest link injected')
  assert.ok(page.body.includes('/pwa/app.css'), 'app.css linked')
  assert.ok(page.body.includes('window.__DSH_PWA__'), 'PWA bootstrap present')
  assert.match(page.body, /window\.__DSH_PWA__=\{vapid:"[A-Za-z0-9_-]{20,}",lang:"(zh|en)"\}/, 'real VAPID public key and resolved page language injected')
  assert.ok(!page.body.includes('href="/lan-gate/admin"'), 'no admin entry chip in injected HTML anymore')
})

test('injects after DSH bootstrap, before </head>', async () => {
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  assert.strictEqual(page.status, 200)
  const html = page.body
  const BOOTSTRAP = '<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=testrev"></script>'
  const headEnd = html.indexOf('</head>')
  assert.ok(html.includes(BOOTSTRAP), 'fixture bootstrap script present after proxying')
  assert.ok(html.indexOf('/pwa/app.css') > html.indexOf(BOOTSTRAP),
    '注入位置改了会让 0.1.2 的客户端引导拿不到模块表：app.css must come after the DSH bootstrap script')
  for (const marker of ['/pwa/app.css', 'window.__DSH_PWA__', '/pwa/manifest.json']) {
    const at = html.indexOf(marker)
    assert.ok(at !== -1 && at < headEnd, `injected marker "${marker}" sits before </head>`)
  }
  const bootReady = html.indexOf('__DSH_BOOT_READY__')
  assert.ok(bootReady > headEnd, '__DSH_BOOT_READY__ lives in the body tail')
  const tail = html.slice(bootReady)
  assert.ok(!tail.includes('/pwa/app.css') && !tail.includes('__DSH_PWA__') && !tail.includes('/pwa/manifest.json'),
    'nothing the gateway injected may follow the __DSH_BOOT_READY__ settlement script')
})

test('gateway: first-paint shell is inlined for phones, presentation-only, and absent for explicit desktop devices', async () => {
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  assert.strictEqual(page.status, 200)
  const html = page.body
  assert.ok(html.includes('<style data-dsh-zen-boot>'), 'shell CSS is inlined with the markup')
  assert.ok(html.includes('id="dsh-zen-boot"'), 'shell markup is inlined in the body')
  assert.ok(html.includes('@media (min-width:1024px){#dsh-zen-boot{display:none!important}}'),
    'desktop width hides the placeholder in CSS')
  assert.ok(html.includes('animation:dsh-zen-boot-expire 30s'), 'CSS-only auto-hide fallback exists')
  assert.ok(html.includes('html[data-ds-theme-source="dark"] #dsh-zen-boot'), 'shell fills follow the host\'s resolved theme')
  assert.ok(html.includes('html[data-ds-theme-source="light"] #dsh-zen-boot'), 'including an explicitly pinned light theme')
  assert.ok(html.includes('new MutationObserver'), 'an inline observer removes it when DSH renders')
  assert.ok(html.includes('DOMContentLoaded'), 'and removes it synchronously when the host is already there')
  assert.ok(html.includes('clearTimeout'), 'the safety valve is cancelled on normal removal')
  assert.ok(html.includes('aria-hidden="true"'), 'placeholder is hidden from assistive tech')
  assert.ok(html.includes('pointer-events:none'), 'placeholder cannot eat clicks')
  const bodyOpen = html.search(/<body[^>]*>/i)
  const shellAt = html.indexOf('id="dsh-zen-boot"')
  const bootReady = html.indexOf('__DSH_BOOT_READY__')
  assert.ok(bodyOpen >= 0 && shellAt > bodyOpen, 'shell lives in <body>')
  assert.ok(bootReady < 0 || shellAt < bootReady, 'shell is parsed before DSH settles')
  const shell = html.slice(html.indexOf('<style data-dsh-zen-boot>'), html.indexOf('</script>', shellAt))
  assert.ok(!/https?:\/\//.test(shell), 'placeholder references no external URL')
  assert.ok(!/url\(/.test(html.slice(html.indexOf('<style data-dsh-zen-boot>'), shellAt)),
    'placeholder CSS loads no images or fonts')

  const { cookie, id } = await pairDevice(SHARED_PORT, 'desk')
  await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-kind', id, kind: 'desktop' } })
  const desktop = await request(SHARED_PORT, { path: '/', headers: Object.assign({ accept: 'text/html', cookie }, REMOTE_HEADERS) })
  assert.ok(!desktop.body.includes('dsh-zen-boot'), 'explicit desktop gets no mobile placeholder')
})

test('gateway: only content-addressed /assets/ gets immutable caching', async () => {
  sharedHandler = (req, res) => {
    const u = String(req.url || '')
    if (u === '/assets/index-ZZZZ1111.js') {
      const body = zlib.gzipSync('<!doctype html><html><head></head><body>login</body></html>')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
      res.end(body)
      return
    }
    const isStatic = /\.(?:js|css|woff2)$/.test(u)
    const headers = { 'content-type': isStatic ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' }
    if (u === '/assets/vendor-DcuzkuQH.js') headers['cache-control'] = 'no-cache'
    if (u === '/assets/app.css') headers['cache-control'] = 'no-cache'
    res.writeHead(200, headers)
    res.end(isStatic ? 'console.log(1)' : '<!doctype html><html><head></head><body>ok</body></html>')
  }
  for (const p of ['/assets/index-CN7NIWNw.js', '/assets/langs/cpp-DddhVWhK.js', '/assets/fonts/montserrat-light-Cvd2VjE_.woff2']) {
    const res = await request(SHARED_PORT, { path: p })
    assert.strictEqual(res.status, 200, p)
    assert.strictEqual(res.headers['cache-control'], 'public, max-age=31536000, immutable', p + ' is content-addressed')
  }
  const upstreamOwn = await request(SHARED_PORT, { path: '/assets/vendor-DcuzkuQH.js' })
  assert.strictEqual(upstreamOwn.headers['cache-control'], 'no-cache', 'an upstream directive on a hashed path wins')
  for (const p of ['/assets/vendor-bootstrap.css', '/assets/app-BOOTSTRAP.js']) {
    const res = await request(SHARED_PORT, { path: p })
    assert.strictEqual(res.status, 200, p)
    assert.strictEqual(res.headers['cache-control'], undefined, p + ' only looks hash-shaped, not content-addressed')
  }
  const compressed = await request(SHARED_PORT, { path: '/assets/index-ZZZZ1111.js' })
  assert.strictEqual(compressed.headers['content-encoding'], 'gzip')
  assert.strictEqual(compressed.headers['cache-control'], undefined, 'HTML is never marked immutable, whatever its encoding')
  const plain = await request(SHARED_PORT, { path: '/assets/app.css' })
  assert.strictEqual(plain.headers['cache-control'], 'no-cache', 'an upstream directive is not overridden')
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  assert.strictEqual(page.headers['cache-control'], 'no-store', 'HTML stays uncached')
})

function extractBootShellScript(html) {
  const start = html.indexOf('(function(){var el=document.getElementById("dsh-zen-boot")')
  if (start < 0) throw new Error('boot shell remover not found')
  const endMark = '})()</script>'
  const end = html.indexOf(endMark, start)
  if (end < 0) throw new Error('boot shell remover is not closed')
  return html.slice(start, end + endMark.length - '</script>'.length)
}
function runBootShellScript(script, opts) {
  const removed = []
  const shell = { parentNode: { removeChild: (node) => removed.push(node) } }
  const root = { childElementCount: opts.rootChildren || 0 }
  let rootAvailable = opts.rootAvailable !== false
  let dcl = null
  const observers = []
  function MutationObserver(cb) { this.cb = cb; this.observe = () => {}; this.disconnect = () => { this.disconnected = true }; observers.push(this) }
  const document = {
    readyState: 'loading',
    documentElement: {},
    getElementById: (id) => id === 'dsh-zen-boot' ? shell : (id === 'root' && rootAvailable ? root : null),
    addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') dcl = fn }
  }
  const timers = []
  const sandbox = {
    document,
    MutationObserver,
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    clearTimeout: (id) => { if (id > 0) timers[id - 1] = null }
  }
  vm.runInContext(script, vm.createContext(sandbox), { filename: 'boot-shell.js' })
  return {
    removed,
    root,
    observers,
    timers,
    fireDcl: () => { assert.strictEqual(typeof dcl, 'function'); dcl() },
    makeRootAvailable: () => { rootAvailable = true }
  }
}

test('gateway: the inline remover handles DCL, late renders, missing #root and the safety valve', async () => {
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  const script = extractBootShellScript(page.body)

  const immediate = runBootShellScript(script, { rootChildren: 1 })
  assert.strictEqual(immediate.removed.length, 0)
  immediate.fireDcl()
  assert.strictEqual(immediate.removed.length, 1, 'removed at DOMContentLoaded')

  const late = runBootShellScript(script, { rootChildren: 0 })
  late.fireDcl()
  assert.strictEqual(late.removed.length, 0, 'shell stays while the host is empty')
  assert.ok(late.observers.length >= 1, 'observer installed on #root')
  late.root.childElementCount = 1
  late.observers[0].cb()
  assert.strictEqual(late.removed.length, 1, 'removed when the host renders')

  const missing = runBootShellScript(script, { rootAvailable: false })
  missing.fireDcl()
  assert.strictEqual(missing.removed.length, 1, 'a document without #root is not the SPA')

  const stalled = runBootShellScript(script, { rootChildren: 0 })
  stalled.fireDcl()
  assert.strictEqual(stalled.removed.length, 0)
  stalled.timers[0]()
  assert.strictEqual(stalled.removed.length, 1, 'safety valve removes the shell')
})

test('gateway: non-SPA HTML (no <head> or no #root) gets no boot shell', async () => {
  for (const html of ['<body><main>no head</main></body>',
                      '<!doctype html><html><head><meta charset="utf-8"></head><body><main>plugin preview</main></body></html>']) {
    sharedHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    }
    const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.ok(!page.body.includes('dsh-zen-boot'), 'no overlay for ' + html.slice(0, 40))
  }
})

function extractInlineScripts(html) {
  const out = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html))) { if (!/src\s*=/.test(m[1])) out.push(m[2]) }
  return out
}
function balanced(s) {
  let depth = 0
  for (const ch of s) {
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth < 0) return false }
  }
  return depth === 0
}

test('gateway: adds a viewport meta with viewport-fit=cover when upstream has none', async () => {
  sharedHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body>ok</body></html>')
  }
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  const metas = page.body.match(VIEWPORT_RE) || []
  assert.strictEqual(metas.length, 1, 'exactly one viewport meta')
  assert.match(metas[0], /viewport-fit=cover/)
})

test('gateway: rewrites an existing viewport meta instead of duplicating it', async () => {
  sharedHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + DSH_VIEWPORT + '</head><body>ok</body></html>')
  }
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  const metas = page.body.match(VIEWPORT_RE) || []
  assert.strictEqual(metas.length, 1, 'exactly one viewport meta')
  assert.match(metas[0], /viewport-fit=cover/)
})

test('gateway: leaves the viewport alone for kind=desktop devices', async () => {
  sharedHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + DSH_VIEWPORT + '</head><body>ok</body></html>')
  }
  const { cookie, id } = await pairDevice(SHARED_PORT, 'desk')
  await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-kind', id, kind: 'desktop' } })
  const page = await request(SHARED_PORT, { path: '/', headers: Object.assign({ accept: 'text/html', cookie }, REMOTE_HEADERS) })
  assert.ok(page.body.includes('data-lan-device="desktop"'), 'served as a desktop device')
  const metas = page.body.match(VIEWPORT_RE) || []
  assert.strictEqual(metas.length, 1)
  assert.doesNotMatch(metas[0], /viewport-fit/)
})

test('gateway: injected inline scripts have balanced braces (quoting bug guard)', async () => {
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  const scripts = extractInlineScripts(page.body)
  assert.ok(scripts.length > 0, 'expected inline scripts')
  for (const s of scripts) {
    assert.ok(balanced(s), 'inline script braces balanced: ' + s.slice(0, 40))
    assert.doesNotThrow(() => new vm.Script(s), 'inline script compiles: ' + s.slice(0, 40))
  }
  assert.ok(page.body.includes('randomUUID'), 'uuid polyfill present')
})

function deviceAttr(html) {
  const m = html.match(/<html[^>]*\bdata-lan-device="([^"]*)"/)
  return m ? m[1] : null
}
function cssShellApplies(html) { return deviceAttr(html) !== 'desktop' }
function touchGesturesLoad(html) { return deviceAttr(html) !== 'desktop' }

test('app.css no longer gates on the literal "phone" value; it gates on non-desktop', async () => {
  const css = await request(SHARED_PORT, { path: '/pwa/app.css' })
  assert.strictEqual(css.status, 200)
  const rulesOnly = css.body.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!rulesOnly.includes('[data-lan-device="phone"]'), 'no rule left gated on literal phone')
  assert.ok(rulesOnly.includes(':not([data-lan-device="desktop"])'), 'rules gate on non-desktop instead')
})

test('inject.js loads touch-gestures.js for non-desktop, not only literal "phone"', async () => {
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  assert.ok(page.body.includes("!== 'desktop'"), 'load gate checks non-desktop')
  assert.ok(!page.body.includes("=== 'phone'"), 'no lingering literal-phone gate')
})

test('device gating: an auto-kind paired device (a real phone\'s default) gets the shell CSS + touch gestures', async () => {
  const { cookie } = await pairDevice(SHARED_PORT, '手机-auto')
  const page = await request(SHARED_PORT, { path: '/', headers: Object.assign({ accept: 'text/html', cookie }, REMOTE_HEADERS) })
  assert.strictEqual(deviceAttr(page.body), null, 'auto kind carries no data-lan-device attribute')
  assert.ok(cssShellApplies(page.body), 'app.css :not(desktop) selector matches an auto device')
  assert.ok(touchGesturesLoad(page.body), 'touch-gestures.js loads for an auto device')
})

test('device gating: a device explicitly pinned to "desktop" does NOT get the shell CSS or touch gestures', async () => {
  const { cookie, id } = await pairDevice(SHARED_PORT, '电脑')
  await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-kind', id, kind: 'desktop' } })
  const page = await request(SHARED_PORT, { path: '/', headers: Object.assign({ accept: 'text/html', cookie }, REMOTE_HEADERS) })
  assert.strictEqual(deviceAttr(page.body), 'desktop')
  assert.ok(!cssShellApplies(page.body), 'app.css :not(desktop) selector excludes an explicit desktop device')
  assert.ok(!touchGesturesLoad(page.body), 'touch-gestures.js does not load for an explicit desktop device')
})

test('injected HTML carries no trace of the old inline DEVICE_CSS block', async () => {
  const page = await request(SHARED_PORT, { path: '/', headers: { accept: 'text/html' } })
  assert.ok(!page.body.includes('.Sh0Q9G_triggerLabel'), 'no hashed composer-label selector')
  assert.ok(!page.body.includes('--dsw-font-s-14-font-size'), 'no old font-size-variable compression block')
  assert.ok(!page.body.includes('min-height:44px'), 'no old touch-target min-height rule')
  assert.ok(!page.body.includes('@media (max-width:820px)'), 'no old 820px fallback block')
  assert.ok(page.body.includes('<link rel="stylesheet" href="/pwa/app.css">'), 'app.css link still present')
})

test('manifest + icons are readable without the device cookie (credential-less browser fetch)', async () => {
  const manifest = await request(SHARED_PORT, { path: '/pwa/manifest.json', headers: REMOTE_HEADERS })
  assert.equal(manifest.status, 200, 'manifest served without auth')
  assert.ok(manifest.body.includes('"DeepSeek Harness Mobile"'), 'gateway manifest, not the pairing page')
  const icon = await request(SHARED_PORT, { path: '/pwa/icons/icon-192.png', headers: REMOTE_HEADERS })
  assert.equal(icon.status, 200, 'icons served without auth')
  const sw = await request(SHARED_PORT, { path: '/pwa/sw.js', headers: REMOTE_HEADERS })
  assert.notEqual(sw.status, 200, 'sw.js still requires pairing')
})

// ---- 0.1.2 browser-auth exchange (M3) ----------------------------------------

async function bootAuth(opts) {
  const target = await startMockAuthTarget(0, opts)
  const targetPort = target.server.address().port
  const gw = startGateway(0, targetPort, { LAN_GATE_UPSTREAM_TOKEN_URL: 'http://127.0.0.1:' + targetPort + '/?token=TESTTOKEN' })
  const port = await gw.ready
  return { port, targetPort, target, gw, stop: () => stopAll(target.server, gw.child) }
}

test('auth exchange: a cookie-less HTML GET is swapped for the upstream token, then lands on the injected page', async () => {
  const { port, targetPort, target, stop } = await bootAuth()
  try {
    const first = await request(port, { path: '/', headers: { accept: 'text/html' } })
    assert.strictEqual(first.status, 303, 'a cookie-less HTML navigation is answered with 303')
    const cookies = first.headers['set-cookie'] || []
    assert.ok(Array.isArray(cookies) && cookies.length > 0, 'the upstream set-cookie is passed through')
    assert.match(cookies[0], /^dsh-auth-x=v;/, 'the upstream cookie value arrives verbatim')
    assert.ok(String(first.headers.location || '').indexOf('dsh-auth-retry=1') >= 0, 'location carries the retry marker')

    const cookie = String(cookies[0]).split(';')[0]
    const second = await request(port, { path: first.headers.location, headers: { accept: 'text/html', cookie } })
    assert.strictEqual(second.status, 200, 'following the redirect with the cookie reaches the page')
    assert.ok(second.body.includes('/pwa/app.css'), 'the served page carries the gateway injection')

    // Marked request still 401ing (no cookie) serves the tap-through page, never a redirect loop.
    const third = await request(port, { path: first.headers.location, headers: { accept: 'text/html' } })
    assert.strictEqual(third.status, 200, 'a marked 401 is served the tap-through page, not redirected')
    assert.ok(third.body.indexOf('href="') >= 0, 'the tap-through page carries a same-site link')
    assert.strictEqual(third.headers['location'], undefined, 'no third redirect')

    // /api 401 passes through untouched.
    const apiRes = await request(port, { path: '/api/x', headers: { accept: 'text/html' } })
    assert.strictEqual(apiRes.status, 401)
    assert.strictEqual(apiRes.headers['set-cookie'], undefined, 'no cookie minted for an API call')
    assert.strictEqual(apiRes.headers['location'], undefined, 'no redirect for an API call')

    // Exchange request reached upstream with loopback Host.
    const exchange = target.seen.find((r) => r.method === 'GET' && String(r.path).indexOf('token=') >= 0)
    assert.ok(exchange, 'the gateway performed one token exchange')
    assert.strictEqual(exchange.headers.host, '127.0.0.1:' + targetPort, 'exchange Host is the loopback target, not the public domain')
  } finally { await stop() }
})

test('auth exchange: 0.1.1 mode (no token env) passes the upstream 401 through untouched', async () => {
  const target = await startMockAuthTarget(0)
  const gw = startGateway(0, target.server.address().port)
  const port = await gw.ready
  try {
    const res = await request(port, { path: '/', headers: { accept: 'text/html' } })
    assert.strictEqual(res.status, 401)
    assert.strictEqual(res.headers['set-cookie'], undefined, 'no cookie is minted in 0.1.1 mode')
    assert.strictEqual(res.headers['location'], undefined, 'no redirect in 0.1.1 mode')
  } finally { await stopAll(target.server, gw.child) }
})

test('auth exchange guard: an upstream that rejects even the token gets the tap-through page, never a redirect loop', async () => {
  const { port, stop } = await bootAuth({ tokenOk: false })
  try {
    const res = await request(port, { path: '/', headers: { accept: 'text/html' } })
    assert.notEqual(res.status, 303, 'the guard must not redirect again')
    assert.ok(res.status >= 200 && res.status < 300, 'the guard serves a page')
    assert.ok(res.body.indexOf('href="/"') >= 0, 'the guard page carries the same-site tap-through link')
    assert.strictEqual(res.headers['location'], undefined)
  } finally { await stop() }
})

// ---- GW-5: untrusted reverse-proxy detection -----------------------------------

test('GW-5: a proxy signature from an untrusted socket is recorded as lastForwardedSource', async (t) => {
  let lan
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === 'IPv4' && !entry.internal) { lan = entry.address; break }
    }
    if (lan) break
  }
  if (!lan) {
    t.skip('no non-loopback IPv4 interface on this host')
    return
  }

  const target = await startMockTarget(0)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-gw5-'))
  const gw = startGatewayAt(home, 0, target.address().port, { LAN_GATE_HOST: '0.0.0.0' })
  const port = await gw.ready
  try {
    const before = JSON.parse((await request(port, { path: '/lan-gate/status' })).body)
    assert.strictEqual(before.lastForwardedSource, null)

    const marked = await fetch(`http://${lan}:${port}/lan-gate/status`, { headers: { 'x-forwarded-for': '203.0.113.9' } })
    assert.strictEqual(marked.status, 403)
    const after = JSON.parse((await request(port, { path: '/lan-gate/status' })).body)
    assert.strictEqual(after.lastForwardedSource.ip, lan, 'the recorded ip is the SOCKET peer, not the XFF claim')
    assert.strictEqual(typeof after.lastForwardedSource.at, 'number')

    await fetch(`http://${lan}:${port}/lan-gate/status`)
    const final = JSON.parse((await request(port, { path: '/lan-gate/status' })).body)
    assert.strictEqual(final.lastForwardedSource.ip, lan, 'the last detection survives headerless traffic')
  } finally {
    await stopAll(target, gw.child)
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

// ---- GW-9: web-claim cookie-safety record ----------------------------------------

test('GW-9: a web claim records lastWebClaim; a proxy that drops X-Forwarded-Proto reads secure:false', async () => {
  const first = await pairDevice(SHARED_PORT, 'phone-a')
  assert.strictEqual(first.claim.status, 200)
  assert.ok(String(first.claim.headers['set-cookie'][0]).includes('Secure'))
  const s1 = JSON.parse((await request(SHARED_PORT, { path: '/lan-gate/status' })).body)
  assert.strictEqual(s1.lastWebClaim.secure, true)
  assert.strictEqual(typeof s1.lastWebClaim.at, 'number')

  const gen2 = await request(SHARED_PORT, { method: 'POST', path: '/lan-gate/pair' })
  const code2 = JSON.parse(gen2.body).code
  const claim2 = await request(SHARED_PORT, {
    method: 'POST',
    path: '/lan-gate/pair/claim',
    headers: { 'x-forwarded-for': '203.0.113.9' },
    body: { code: code2, name: 'phone-b' },
  })
  assert.strictEqual(claim2.status, 200)
  assert.ok(!String(claim2.headers['set-cookie'][0]).includes('Secure'))
  const s2 = JSON.parse((await request(SHARED_PORT, { path: '/lan-gate/status' })).body)
  assert.strictEqual(s2.lastWebClaim.secure, false)
  assert.ok(s2.lastWebClaim.at >= s1.lastWebClaim.at)
})

// ---- Web Push E2E (merged from push.test.cjs:1-101) ----------------------------

function fakeSubscription(pushPort) {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    endpoint: 'http://127.0.0.1:' + pushPort + '/push/abc',
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
  }
}

function startMockPushService(statusCode) {
  const captured = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      captured.push({ headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(statusCode, {})
      res.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, captured, port: server.address().port }))
  })
}

test('WebPush: subscribe requires a paired device; send delivers VAPID-signed encrypted push; expired 410 drops subscription', async () => {
  const push201 = await startMockPushService(201)
  const target = await startMockTarget(0)
  const gw = startGateway(0, target.address().port, { LAN_GATE_ALLOW_HTTP_PUSH: '1' })
  const port = await gw.ready
  try {
    const anon = await request(port, { method: 'POST', path: '/pwa/push/subscribe', headers: REMOTE_HEADERS, body: { subscription: fakeSubscription(push201.port) } })
    assert.strictEqual(anon.status, 401)

    const { cookie } = await pairDevice(port)
    const bad = await request(port, { method: 'POST', path: '/pwa/push/subscribe', headers: { ...REMOTE_HEADERS, cookie }, body: { subscription: { endpoint: 'javascript:alert(1)' } } })
    assert.strictEqual(bad.status, 400)

    const ok = await request(port, { method: 'POST', path: '/pwa/push/subscribe', headers: { ...REMOTE_HEADERS, cookie }, body: { subscription: fakeSubscription(push201.port) } })
    assert.strictEqual(ok.status, 200)

    const send = await request(port, { method: 'POST', path: '/pwa/push/send', body: { title: 'DSH 任务完成', body: '会话 X' } })
    assert.strictEqual(send.status, 200)
    assert.deepStrictEqual(JSON.parse(send.body), { ok: true, sent: 1, failed: 0 })

    assert.strictEqual(push201.captured.length, 1)
    const req = push201.captured[0]
    assert.match(String(req.headers.authorization || ''), /^vapid /i, 'VAPID Authorization header present')
    assert.strictEqual(req.headers['content-encoding'], 'aes128gcm', 'payload is encrypted')
    assert.ok(req.body.length > 0)
    assert.throws(() => JSON.parse(req.body.toString('utf8')), 'body must not be plaintext JSON')

    // Expired subscription (410) is dropped after send.
    await new Promise((r) => push201.server.close(r))
    const push410 = await startMockPushService(410)
    try {
      const sub410 = await request(port, { method: 'POST', path: '/pwa/push/subscribe', headers: { ...REMOTE_HEADERS, cookie }, body: { subscription: fakeSubscription(push410.port) } })
      assert.strictEqual(sub410.status, 200)
      const send410 = await request(port, { method: 'POST', path: '/pwa/push/send', body: {} })
      assert.deepStrictEqual(JSON.parse(send410.body), { ok: true, sent: 0, failed: 1 })
      const status = JSON.parse((await request(port, { path: '/lan-gate/status' })).body)
      assert.strictEqual(status.pushSubscriptions, 0, 'dead subscription removed')
    } finally {
      await new Promise((r) => push410.server.close(r))
    }
  } finally {
    await stopAll(target, gw.child)
    if (push201.server.listening) await new Promise((r) => push201.server.close(r))
  }
})
