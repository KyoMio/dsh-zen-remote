/* dsh-mobile-pwa · gateway smoke test
 * Boots the real lib/lan-gate-server.cjs behind a mock DSH upstream and verifies:
 *   1. gateway starts and reports pwa:true (local admin surface)
 *   2. gateway serves /pwa/* assets to the local user
 *   3. gateway injects PWA bootstrap + manifest link into proxied HTML
 *   4. injected inline scripts stay syntactically sane (quoting bug guard)
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const net = require('node:net')
const http = require('node:http')
const zlib = require('node:zlib')
const vm = require('node:vm')
const { startMockTarget, startMockAuthTarget, startGateway, startGatewayAt, startRecordingTarget, request, stopAll, pairDevice, REMOTE_HEADERS, freePort } = require('./util.cjs')
const path = require('node:path')

const VIEWPORT_RE = /<meta[^>]*name=["']?viewport["']?[^>]*>/gi
// Exactly what DSH itself serves today — the tag the gateway has to rewrite.
const DSH_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1" />'

// T31-fix (relay-e2e): every port is system-assigned so parallel test-run
// copies cannot collide. Targets listen on 0 and report the kernel's pick;
// the gateway child needs a number handed to it, so boot() pre-grabs one with
// freePort() — the gateway's same-port retry band absorbs the rebind race.
// Tests in one file run sequentially, so these carry the current pair.
let PORT = 0
let TARGET_PORT = 0

async function boot(html) {
  const target = await startMockTarget(0, html)
  TARGET_PORT = target.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  return { gw, stop: () => stopAll(target, gw.child) }
}

/** An upstream that 404s exactly the two favicon files the logo proxy asks
 * for — the "upstream has no logo" case. */
async function bootWithFaviconlessUpstream() {
  const target = await startRecordingTarget(0, {
    statusFor: (url) => (url === '/favicon.svg' || url === '/favicon-dark.svg' ? 404 : 0),
  })
  TARGET_PORT = target.server.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  return { target, gw, stop: () => stopAll(target.server, gw.child) }
}

test('gateway logo proxy: an unpaired visitor gets the upstream favicon verbatim on both fixed paths', async () => {
  // A known body: the mock serves THIS for every path, so "verbatim" is
  // provable by exact comparison.
  const upstreamBody = '<svg xmlns="http://www.w3.org/2000/svg"><text>logo</text></svg>'
  const { stop } = await boot(upstreamBody)
  try {
    for (const path of ['/lan-gate/logo.svg', '/lan-gate/logo-dark.svg']) {
      const res = await request(PORT, { path, headers: REMOTE_HEADERS })
      assert.strictEqual(res.status, 200, path)
      assert.strictEqual(res.headers['content-type'], 'image/svg+xml', path)
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff')
      // "verbatim": the body is exactly what the upstream served.
      assert.strictEqual(res.body, upstreamBody, path)
    }
  } finally { await stop() }
})

test('gateway logo proxy: an upstream miss answers 404 on the logo route', async () => {
  const { stop } = await bootWithFaviconlessUpstream()
  try {
    for (const path of ['/lan-gate/logo.svg', '/lan-gate/logo-dark.svg']) {
      const res = await request(PORT, { path, headers: REMOTE_HEADERS })
      assert.strictEqual(res.status, 404, path)
    }
  } finally { await stop() }
})

test('gateway logo proxy: the allowlist is exact — lookalike paths hit the pairing wall, and a query never reaches upstream', async () => {
  const target = await startRecordingTarget(0)
  TARGET_PORT = target.server.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  try {
    // Dot-segment and sibling paths stay literal (the dispatch matches the
    // raw, un-normalized path) and fall through to the pairing wall.
    for (const path of ['/lan-gate/logo.svg/../x', '/lan-gate/logo.svg%2f..', '/favicon.svg', '/lan-gate/logo.svgx']) {
      const res = await request(PORT, { path, headers: REMOTE_HEADERS })
      assert.strictEqual(res.status, 401, path)
      assert.ok(res.body.includes('id="code"'), path + ' gets the pairing page, not upstream content')
    }
    // A query suffix resolves the fixed path but the query is dropped: the
    // upstream sees the bare /favicon.svg and nothing else.
    const res = await request(PORT, { path: '/lan-gate/logo.svg?x=/api/secret', headers: REMOTE_HEADERS })
    assert.strictEqual(res.status, 200)
    const faviconCalls = target.seen.filter((call) => call.path.indexOf('/favicon') === 0)
    assert.deepEqual(faviconCalls.map((call) => call.path), ['/favicon.svg'])
    assert.ok(target.seen.every((call) => call.path.indexOf('/api/') !== 0), 'no other upstream path was touched')
  } finally { await stopAll(target.server, gw.child) }
})

test('gateway pairing page: DSH-styled shell with the proxied logo and the original form contract', async () => {
  const { stop } = await boot()
  try {
    const page = await request(PORT, { path: '/', headers: REMOTE_HEADERS })
    assert.strictEqual(page.status, 401)
    // The shell follows the system appearance (light + dark theme colors,
    // a dark-mode media query), and the logo is the <picture> switching the
    // two proxied favicon files.
    assert.ok(page.body.includes('<picture class="logo">'), 'the logo is a picture element')
    assert.ok(page.body.includes('/lan-gate/logo.svg') && page.body.includes('/lan-gate/logo-dark.svg'))
    assert.ok(page.body.includes('media="(prefers-color-scheme: dark)"'), 'dark-mode sources/theme-color are present')
    assert.ok(page.body.includes('#f7f8fa') && page.body.includes('#151517'), 'the DSH light/dark page backgrounds')
    // The pairing script's contract is unchanged.
    for (const id of ['id="code"', 'id="name"', 'id="go"', 'id="err"']) {
      assert.ok(page.body.includes(id), id + ' survives the restyle')
    }
    // The rate-limit and tap-through pages are built by the same gatePage
    // shell (one function), so they restyle together with this one.
  } finally { await stop() }
})

test('gateway logo proxy (T71-fix): response headers are whitelisted, 200 carries CSP + nosniff; POST 405, HEAD bodyless', async () => {
  // The upstream answers with its own cookie, a custom header and a
  // cache directive that must all stay upstream — plus a script inside the
  // SVG that the CSP keeps dead when the file is opened directly.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Set-Cookie': 'up=1', 'X-Up-Leak': 'yes', 'Cache-Control': 'no-store' })
    res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  TARGET_PORT = upstream.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  try {
    const res = await request(PORT, { path: '/lan-gate/logo.svg', headers: REMOTE_HEADERS })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.headers['content-type'], 'image/svg+xml')
    assert.strictEqual(res.headers['content-security-policy'], "default-src 'none'")
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff')
    assert.strictEqual(res.headers['cache-control'], 'public, max-age=300', 'the whitelisted directive, not the upstream\'s')
    assert.strictEqual(res.headers['set-cookie'], undefined, 'the upstream cookie stays upstream')
    assert.strictEqual(res.headers['x-up-leak'], undefined, 'custom upstream headers stay upstream')

    const post = await request(PORT, { method: 'POST', path: '/lan-gate/logo.svg', headers: REMOTE_HEADERS, body: {} })
    assert.strictEqual(post.status, 405)

    const head = await request(PORT, { method: 'HEAD', path: '/lan-gate/logo.svg', headers: REMOTE_HEADERS })
    assert.strictEqual(head.status, 200)
    assert.strictEqual(head.headers['content-type'], 'image/svg+xml')
    assert.strictEqual(head.body, '', 'HEAD answers headers only')
  } finally { await stopAll(upstream, gw.child) }
})

test('gateway logo proxy (T71-fix): path variants — doubled slashes, case, parameters, absolute-form — all hit the pairing wall', async () => {
  const { stop } = await boot()
  try {
    for (const path of ['//lan-gate/logo.svg', '/LAN-GATE/logo.svg', '/lan-gate/logo.svg;x', 'http://evil.example/lan-gate/logo.svg']) {
      const res = await request(PORT, { path, headers: REMOTE_HEADERS })
      assert.strictEqual(res.status, 401, path)
      assert.ok(res.body.includes('id="code"'), path + ' gets the pairing page, not the logo')
    }
  } finally { await stop() }
})

test('gateway logo proxy (T71-fix): a silent upstream is torn down when the visitor leaves, and times out to 404', async () => {
  // An upstream that accepts requests and never answers — the reviewer's
  // socket-leak scenario. It records connection closes.
  const sockets = new Set()
  let closes = 0
  const upstream = http.createServer((req, res) => { req.resume() })
  upstream.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => { closes += 1; sockets.delete(sock) }) })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  TARGET_PORT = upstream.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  try {
    // The visitor connects and then walks away mid-request: the gateway must
    // tear the parked upstream request down with it — no socket left behind.
    const visitor = net.connect(PORT, '127.0.0.1', () => {
      visitor.write('GET /lan-gate/logo.svg HTTP/1.1\r\nHost: gw\r\nX-Forwarded-For: 203.0.113.9\r\nX-Forwarded-Proto: https\r\n\r\n')
    })
    visitor.on('error', () => {})
    await new Promise((resolve) => setTimeout(resolve, 300))
    visitor.destroy()
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(sockets.size, 0, 'no upstream socket left for the disconnected visitor')
    assert.ok(closes >= 1, 'the upstream saw its connection close')

    // A patient visitor: the 5s upstream timeout answers 404 — the gateway
    // does not hang.
    const t0 = Date.now()
    const res = await request(PORT, { path: '/lan-gate/logo-dark.svg', headers: REMOTE_HEADERS })
    const elapsed = Date.now() - t0
    assert.strictEqual(res.status, 404)
    assert.ok(elapsed >= 4500 && elapsed < 9000, 'the answer waits out the 5s timeout, then 404s (took ' + elapsed + 'ms)')
  } finally { await stopAll(upstream, gw.child) }
})


test('gateway: starts and reports pwa:true', async () => {
  const { stop } = await boot()
  try {
    const status = await request(PORT, { path: '/lan-gate/status' })
    assert.strictEqual(status.status, 200)
    const j = JSON.parse(status.body)
    assert.strictEqual(j.state, 'running')
    assert.strictEqual(j.pwa, true)
  } finally { await stop() }
})

test('gateway: serves PWA assets (/pwa/manifest.json, /pwa/sw.js)', async () => {
  const { stop } = await boot()
  try {
    const manifest = await request(PORT, { path: '/pwa/manifest.json' })
    assert.strictEqual(manifest.status, 200)
    assert.strictEqual(JSON.parse(manifest.body).display, 'standalone')
    // background_color is load-bearing, not decoration: iOS 26.x leaves a dead
    // ~59px strip below a standalone PWA's viewport (see AGENTS.md) and paints
    // it with this colour. It must stay equal to the mobile plugin's light
    // page background so the strip disappears into the page.
    //
    // It is NOT what paints the Android bottom band — that is the system
    // navigation bar, which follows the OS dark-mode setting and ignores the
    // page entirely (proven on-device 2026-08-20). Changing this value to
    // chase that band was tried and did nothing; don't repeat it.
    assert.strictEqual(JSON.parse(manifest.body).background_color, '#f9fafb')

    const sw = await request(PORT, { path: '/pwa/sw.js' })
    assert.strictEqual(sw.status, 200)
    assert.ok(sw.body.includes('dsh-mobile-pwa'))
  } finally { await stop() }
})

// sw.js is served from /pwa/sw.js, so its default scope is only /pwa/ and it
// would never control the app itself (start_url "/"). Chrome only allows a
// register({scope}) wider than the script's directory when the response
// carries this header (paired with inject.js passing { scope: '/' }).
test('gateway: /pwa/sw.js response carries Service-Worker-Allowed: / so it can control the whole app', async () => {
  const { stop } = await boot()
  try {
    const sw = await request(PORT, { path: '/pwa/sw.js' })
    assert.strictEqual(sw.status, 200)
    assert.strictEqual(sw.headers['service-worker-allowed'], '/')

    // Other /pwa/ assets must NOT get this header — it's meaningless (and
    // pointless clutter) for anything that isn't the worker script itself.
    const manifest = await request(PORT, { path: '/pwa/manifest.json' })
    assert.strictEqual(manifest.headers['service-worker-allowed'], undefined)
  } finally { await stop() }
})

test('gateway: injected bootstrap registers the service worker with scope "/"', async () => {
  const { stop } = await boot()
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.match(page.body, /navigator\.serviceWorker\.register\(['"]\/pwa\/sw\.js['"],\s*\{\s*scope:\s*['"]\/['"]\s*\}\)/, 'register() call passes an explicit scope of "/"')
  } finally { await stop() }
})

// DSH's own page already ships its own <link rel="manifest" href="/manifest.webmanifest">
// (generic name, single icon, display:fullscreen). Left in place it sits
// BEFORE the gateway's own manifest link in <head>, and a document only ever
// honors the FIRST rel="manifest" link — so the gateway's mobile-tailored
// manifest.json (proper icons, branding, the background_color the iOS
// dead-strip fix depends on) was silently shadowed and never took effect.
test('gateway: strips an upstream-supplied manifest link so the gateway\'s own /pwa/manifest.json is the only one and actually governs', async () => {
  const { stop } = await boot('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="manifest" href="/manifest.webmanifest" /></head><body>ok</body></html>')
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    const links = page.body.match(/<link[^>]*rel=["']?manifest["']?[^>]*>/gi) || []
    assert.strictEqual(links.length, 1, 'exactly one manifest link survives')
    assert.ok(links[0].includes('/pwa/manifest.json'), 'the surviving link is the gateway\'s own')
    assert.ok(!page.body.includes('/manifest.webmanifest'), 'the shadowed upstream manifest link is gone')
  } finally { await stop() }
})

test('gateway: injects manifest link, PWA bootstrap & app.css into HTML (local)', async () => {
  const { stop } = await boot()
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.strictEqual(page.status, 200)
    assert.ok(page.body.includes('rel="manifest"'), 'manifest link injected')
    assert.ok(page.body.includes('/pwa/app.css'), 'app.css linked')
    assert.ok(page.body.includes('window.__DSH_PWA__'), 'PWA bootstrap present')
    assert.match(page.body, /window\.__DSH_PWA__=\{vapid:"[A-Za-z0-9_-]{20,}",lang:"(zh|en)"\}/, 'real VAPID public key and resolved page language injected')
    // T13: the admin entry chip is gone — administration moved to the
    // dsh-zen-remote settings page inside DSH's Plugins page.
    assert.ok(!page.body.includes('href="/lan-gate/admin"'), 'no admin entry chip in injected HTML anymore')
  } finally { await stop() }
})

// The 0.1.2 homepage loads its client bundle from a blocking bootstrap
// <script> in <head> and settles with __DSH_BOOT_READY__ at the end of
// <body>. If the gateway ever injected BEFORE that bootstrap script, or past
// </head> into the body tail, the module table would not be ready when our
// injected code runs (or our inline scripts would sit after the settlement
// marker) — 0.1.2's client boot would break. This guards the order.
test('injects after DSH bootstrap, before </head>', async () => {
  const { stop } = await boot()
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.strictEqual(page.status, 200)
    const html = page.body
    const BOOTSTRAP = '<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=testrev"></script>'
    const headEnd = html.indexOf('</head>')
    assert.ok(html.includes(BOOTSTRAP), 'fixture bootstrap script present after proxying')
    // 1. Our injection lands after DSH's own bootstrap script.
    assert.ok(html.indexOf('/pwa/app.css') > html.indexOf(BOOTSTRAP),
      '注入位置改了会让 0.1.2 的客户端引导拿不到模块表：app.css must come after the DSH bootstrap script')
    // 2. Everything we inject into <head> still lands before </head>.
    //    (All of it is head-side since the admin chip was removed in T13.)
    for (const marker of ['/pwa/app.css', 'window.__DSH_PWA__', '/pwa/manifest.json']) {
      const at = html.indexOf(marker)
      assert.ok(at !== -1 && at < headEnd, `injected marker "${marker}" sits before </head>`)
    }
    // 3. __DSH_BOOT_READY__ is the last thing in <body>: nothing of ours
    // follows it, only the closing tags.
    const bootReady = html.indexOf('__DSH_BOOT_READY__')
    assert.ok(bootReady > headEnd, '__DSH_BOOT_READY__ lives in the body tail')
    const tail = html.slice(bootReady)
    assert.ok(!tail.includes('/pwa/app.css') && !tail.includes('__DSH_PWA__') && !tail.includes('/pwa/manifest.json'),
      'nothing the gateway injected may follow the __DSH_BOOT_READY__ settlement script')
  } finally { await stop() }
})

// Cold start is a blank page until DSH's ~2.7 MB of app/plugin JavaScript has
// run. The gateway now paints an app-shaped placeholder inside the first HTML
// byte (no extra request), and an inline script removes it as soon as DSH
// renders into #root. It must never reach an explicit desktop device.
test('gateway: first-paint shell is inlined for phones, presentation-only, and absent for explicit desktop devices', async () => {
  const { stop } = await boot()
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
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

    // An explicit desktop device is not a phone: no placeholder at all.
    const { cookie, id } = await pairDevice(PORT, 'desk')
    await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-kind', id, kind: 'desktop' } })
    const desktop = await request(PORT, { path: '/', headers: Object.assign({ accept: 'text/html', cookie }, REMOTE_HEADERS) })
    assert.ok(!desktop.body.includes('dsh-zen-boot'), 'explicit desktop gets no mobile placeholder')
  } finally { await stop() }
})

// DSH's static server sends no cache headers for its Vite output. Only real
// content-addressed names may get a year of immutable caching; HTML (even
// compressed), upstream directives and hash-shaped plain words must not.
test('gateway: only content-addressed /assets/ gets immutable caching', async () => {
  const upstream = http.createServer((req, res) => {
    const u = String(req.url || '')
    // A hash-shaped URL whose response is actually (gzipped) HTML: the header
    // must not be added even though injection skips compressed HTML.
    if (u === '/assets/index-ZZZZ1111.js') {
      const body = zlib.gzipSync('<!doctype html><html><head></head><body>login</body></html>')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
      res.end(body)
      return
    }
    const isStatic = /\.(?:js|css|woff2)$/.test(u)
    const headers = { 'content-type': isStatic ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' }
    // Explicit upstream directives must win on hashed and unhashed paths.
    if (u === '/assets/vendor-DcuzkuQH.js') headers['cache-control'] = 'no-cache'
    if (u === '/assets/app.css') headers['cache-control'] = 'no-cache'
    res.writeHead(200, headers)
    res.end(isStatic ? 'console.log(1)' : '<!doctype html><html><head></head><body>ok</body></html>')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  TARGET_PORT = upstream.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  try {
    for (const path of ['/assets/index-CN7NIWNw.js', '/assets/langs/cpp-DddhVWhK.js', '/assets/fonts/montserrat-light-Cvd2VjE_.woff2']) {
      const res = await request(PORT, { path })
      assert.strictEqual(res.status, 200, path)
      assert.strictEqual(res.headers['cache-control'], 'public, max-age=31536000, immutable', path + ' is content-addressed')
    }
    const upstreamOwn = await request(PORT, { path: '/assets/vendor-DcuzkuQH.js' })
    assert.strictEqual(upstreamOwn.headers['cache-control'], 'no-cache', 'an upstream directive on a hashed path wins')
    for (const path of ['/assets/vendor-bootstrap.css', '/assets/app-BOOTSTRAP.js']) {
      const res = await request(PORT, { path })
      assert.strictEqual(res.status, 200, path)
      assert.strictEqual(res.headers['cache-control'], undefined, path + ' only looks hash-shaped, not content-addressed')
    }
    const compressed = await request(PORT, { path: '/assets/index-ZZZZ1111.js' })
    assert.strictEqual(compressed.headers['content-encoding'], 'gzip')
    assert.strictEqual(compressed.headers['cache-control'], undefined, 'HTML is never marked immutable, whatever its encoding')
    const plain = await request(PORT, { path: '/assets/app.css' })
    assert.strictEqual(plain.headers['cache-control'], 'no-cache', 'an upstream directive is not overridden')
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.strictEqual(page.headers['cache-control'], 'no-store', 'HTML stays uncached')
  } finally { await stopAll(upstream, gw.child) }
})

// Execute the real inline remover against a fake DOM so the "DSH renders ->
// shell goes away" hard constraint is pinned, not grepped.
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
  const { stop } = await boot()
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    const script = extractBootShellScript(page.body)

    // (a) Host already rendered when DOMContentLoaded fires (module scripts
    //     execute before it) -> removed synchronously.
    const immediate = runBootShellScript(script, { rootChildren: 1 })
    assert.strictEqual(immediate.removed.length, 0)
    immediate.fireDcl()
    assert.strictEqual(immediate.removed.length, 1, 'removed at DOMContentLoaded')

    // (b) #root exists but is still empty -> observer waits for the first child.
    const late = runBootShellScript(script, { rootChildren: 0 })
    late.fireDcl()
    assert.strictEqual(late.removed.length, 0, 'shell stays while the host is empty')
    assert.ok(late.observers.length >= 1, 'observer installed on #root')
    late.root.childElementCount = 1
    late.observers[0].cb()
    assert.strictEqual(late.removed.length, 1, 'removed when the host renders')

    // (c) No #root at all -> this is not the SPA (plugin preview/fragment):
    //     remove immediately instead of covering it for 30 seconds.
    const missing = runBootShellScript(script, { rootAvailable: false })
    missing.fireDcl()
    assert.strictEqual(missing.removed.length, 1, 'a document without #root is not the SPA')

    // (d) Host never renders -> the 30s safety valve removes the overlay.
    const stalled = runBootShellScript(script, { rootChildren: 0 })
    stalled.fireDcl()
    assert.strictEqual(stalled.removed.length, 0)
    stalled.timers[0]()
    assert.strictEqual(stalled.removed.length, 1, 'safety valve removes the shell')
  } finally { await stop() }
})

test('gateway: non-SPA HTML (no <head> or no #root) gets no boot shell', async () => {
  // Plugin HTML previews and iframes are proxied as text/html too; they must
  // stay untouched instead of being covered by a fake home screen.
  for (const html of ['<body><main>no head</main></body>',
                      '<!doctype html><html><head><meta charset="utf-8"></head><body><main>plugin preview</main></body></html>']) {
    const { stop } = await boot(html)
    try {
      const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
      assert.ok(!page.body.includes('dsh-zen-boot'), 'no overlay for ' + html.slice(0, 40))
    } finally { await stop() }
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

// The cold-start safe area depends on viewport-fit=cover being in the HTML
// itself, not added later by the plugin bundle.
test('gateway: adds a viewport meta with viewport-fit=cover when upstream has none', async () => {
  const { stop } = await boot()
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    const metas = page.body.match(VIEWPORT_RE) || []
    assert.strictEqual(metas.length, 1, 'exactly one viewport meta')
    assert.match(metas[0], /viewport-fit=cover/)
  } finally { await stop() }
})

test('gateway: rewrites an existing viewport meta instead of duplicating it', async () => {
  const { stop } = await boot('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + DSH_VIEWPORT + '</head><body>ok</body></html>')
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    const metas = page.body.match(VIEWPORT_RE) || []
    assert.strictEqual(metas.length, 1, 'exactly one viewport meta')
    assert.match(metas[0], /viewport-fit=cover/)
  } finally { await stop() }
})

// Devices pinned to "desktop" keep the upstream viewport untouched.
test('gateway: leaves the viewport alone for kind=desktop devices', async () => {
  const { stop } = await boot('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + DSH_VIEWPORT + '</head><body>ok</body></html>')
  try {
    const { cookie, id } = await pairDevice(PORT, 'desk')
    await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-kind', id, kind: 'desktop' } })
    const page = await request(PORT, { path: '/', headers: Object.assign({ accept: 'text/html', cookie }, REMOTE_HEADERS) })
    assert.ok(page.body.includes('data-lan-device="desktop"'), 'served as a desktop device')
    const metas = page.body.match(VIEWPORT_RE) || []
    assert.strictEqual(metas.length, 1)
    assert.doesNotMatch(metas[0], /viewport-fit/)
  } finally { await stop() }
})

test('gateway: injected inline scripts have balanced braces (quoting bug guard)', async () => {
  const { stop } = await boot()
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    const scripts = extractInlineScripts(page.body)
    assert.ok(scripts.length > 0, 'expected inline scripts')
    for (const s of scripts) {
      assert.ok(balanced(s), 'inline script braces balanced: ' + s.slice(0, 40))
      assert.doesNotThrow(() => new vm.Script(s), 'inline script compiles: ' + s.slice(0, 40))
    }
    assert.ok(page.body.includes('randomUUID'), 'uuid polyfill present')
  } finally { await stop() }
})

// ---- device-kind gating: app.css / touch-gestures.js must key off
// "not explicitly desktop", not the literal "phone" value, because a real
// paired phone defaults to kind "auto" and the gateway never stamps
// data-lan-device for it (only "phone"/"desktop" are explicit). See
// pwa/app.css and the `isNonDesktop` gate in pwa/inject.js.
function deviceAttr(html) {
  const m = html.match(/<html[^>]*\bdata-lan-device="([^"]*)"/)
  return m ? m[1] : null
}
// Mirrors app.css's `html:not([data-lan-device="desktop"])` selector.
function cssShellApplies(html) { return deviceAttr(html) !== 'desktop' }
// Mirrors inject.js's `getAttribute('data-lan-device') !== 'desktop'` gate.
function touchGesturesLoad(html) { return deviceAttr(html) !== 'desktop' }

test('app.css no longer gates on the literal "phone" value; it gates on non-desktop', async () => {
  const { stop } = await boot()
  try {
    const css = await request(PORT, { path: '/pwa/app.css' })
    assert.strictEqual(css.status, 200)
    // Strip comments first — the file's own header comment mentions the old
    // literal-phone selector by name while explaining why it changed.
    const rulesOnly = css.body.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!rulesOnly.includes('[data-lan-device="phone"]'), 'no rule left gated on literal phone')
    assert.ok(rulesOnly.includes(':not([data-lan-device="desktop"])'), 'rules gate on non-desktop instead')
  } finally { await stop() }
})

test('inject.js loads touch-gestures.js for non-desktop, not only literal "phone"', async () => {
  const { stop } = await boot()
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.ok(page.body.includes("!== 'desktop'"), 'load gate checks non-desktop')
    assert.ok(!page.body.includes("=== 'phone'"), 'no lingering literal-phone gate')
  } finally { await stop() }
})

test('device gating: an auto-kind paired device (a real phone\'s default) gets the shell CSS + touch gestures', async () => {
  const { stop } = await boot()
  try {
    const { cookie } = await pairDevice(PORT, '手机-auto')
    const page = await request(PORT, { path: '/', headers: Object.assign({ accept: 'text/html', cookie }, REMOTE_HEADERS) })
    assert.strictEqual(deviceAttr(page.body), null, 'auto kind carries no data-lan-device attribute')
    assert.ok(cssShellApplies(page.body), 'app.css :not(desktop) selector matches an auto device')
    assert.ok(touchGesturesLoad(page.body), 'touch-gestures.js loads for an auto device')
  } finally { await stop() }
})

test('device gating: a device explicitly pinned to "desktop" does NOT get the shell CSS or touch gestures', async () => {
  const { stop } = await boot()
  try {
    const { cookie, id } = await pairDevice(PORT, '电脑')
    await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-kind', id, kind: 'desktop' } })
    const page = await request(PORT, { path: '/', headers: Object.assign({ accept: 'text/html', cookie }, REMOTE_HEADERS) })
    assert.strictEqual(deviceAttr(page.body), 'desktop')
    assert.ok(!cssShellApplies(page.body), 'app.css :not(desktop) selector excludes an explicit desktop device')
    assert.ok(!touchGesturesLoad(page.body), 'touch-gestures.js does not load for an explicit desktop device')
  } finally { await stop() }
})

// ---- DEVICE_CSS removal: the gateway used to inject a second, separate
// inline <style> block (the `DEVICE_CSS` constant in lib/lan-gate-server.cjs)
// ahead of app.css, carrying its own stale copy of the old mobile-layout
// rules gated on the literal `[data-lan-device="phone"]` value. It was
// removed outright (nothing in it was both correct and not already covered
// by app.css or dsh-mobile-nav) — guard against it silently coming back.
test('injected HTML carries no trace of the old inline DEVICE_CSS block', async () => {
  const { stop } = await boot()
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.ok(!page.body.includes('.Sh0Q9G_triggerLabel'), 'no hashed composer-label selector')
    assert.ok(!page.body.includes('--dsw-font-s-14-font-size'), 'no old font-size-variable compression block')
    assert.ok(!page.body.includes('min-height:44px'), 'no old touch-target min-height rule')
    assert.ok(!page.body.includes('@media (max-width:820px)'), 'no old 820px fallback block')
    // app.css is still the one place mobile shell CSS is injected from.
    assert.ok(page.body.includes('<link rel="stylesheet" href="/pwa/app.css">'), 'app.css link still present')
  } finally { await stop() }
})

test('manifest + icons are readable without the device cookie (credential-less browser fetch)', async () => {
  const { stop } = await boot()
  try {
    // Browsers fetch the manifest (and the icons it lists) WITHOUT cookies by
    // spec. Behind the pairing wall Chrome got the 401 pairing page instead:
    // no install prompt, install name fell back to the upstream <title>.
    const manifest = await request(PORT, { path: '/pwa/manifest.json', headers: REMOTE_HEADERS })
    assert.equal(manifest.status, 200, 'manifest served without auth')
    assert.ok(manifest.body.includes('"DeepSeek Harness Mobile"'), 'gateway manifest, not the pairing page')
    const icon = await request(PORT, { path: '/pwa/icons/icon-192.png', headers: REMOTE_HEADERS })
    assert.equal(icon.status, 200, 'icons served without auth')
    // Everything else under /pwa/ stays behind the wall for unpaired remotes.
    const sw = await request(PORT, { path: '/pwa/sw.js', headers: REMOTE_HEADERS })
    assert.notEqual(sw.status, 200, 'sw.js still requires pairing')
  } finally { await stop() }
})

// ---- 0.1.2 browser-auth exchange (M3): the gateway swaps the upstream
// token for a cookie on the phone's behalf --------------------------------

async function bootAuth(opts) {
  const target = await startMockAuthTarget(0, opts)
  TARGET_PORT = target.server.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, TARGET_PORT, { LAN_GATE_UPSTREAM_TOKEN_URL: 'http://127.0.0.1:' + TARGET_PORT + '/?token=TESTTOKEN' })
  await gw.ready
  return { target, gw, stop: () => stopAll(target.server, gw.child) }
}

test('auth exchange: a cookie-less HTML GET is swapped for the upstream token, then lands on the injected page', async () => {
  const { stop } = await bootAuth()
  try {
    const first = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.strictEqual(first.status, 303, 'a cookie-less HTML navigation is answered with 303')
    const cookies = first.headers['set-cookie'] || []
    assert.ok(Array.isArray(cookies) && cookies.length > 0, 'the upstream set-cookie is passed through')
    assert.match(cookies[0], /^dsh-auth-x=v;/, 'the upstream cookie value arrives verbatim')
    assert.ok(String(first.headers.location || '').indexOf('dsh-auth-retry=1') >= 0, 'location carries the retry marker')

    const cookie = String(cookies[0]).split(';')[0]
    const second = await request(PORT, { path: first.headers.location, headers: { accept: 'text/html', cookie } })
    assert.strictEqual(second.status, 200, 'following the redirect with the cookie reaches the page')
    assert.ok(second.body.includes('/pwa/app.css'), 'the served page carries the gateway injection')
  } finally { await stop() }
})

test('auth exchange: 0.1.1 mode (no token env) passes the upstream 401 through untouched', async () => {
  // Gateway WITHOUT LAN_GATE_UPSTREAM_TOKEN_URL against an auth-acting target:
  // the 401 must reach the client verbatim — no set-cookie, no redirect.
  const target = await startMockAuthTarget(0)
  TARGET_PORT = target.server.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  try {
    const res = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.strictEqual(res.status, 401)
    assert.strictEqual(res.headers['set-cookie'], undefined, 'no cookie is minted in 0.1.1 mode')
    assert.strictEqual(res.headers['location'], undefined, 'no redirect in 0.1.1 mode')
  } finally { await stopAll(target.server, gw.child) }
})

test('auth exchange guard: an upstream that rejects even the token gets the tap-through page, never a redirect loop', async () => {
  const { stop } = await bootAuth({ tokenOk: false })
  try {
    const res = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.notEqual(res.status, 303, 'the guard must not redirect again')
    assert.ok(res.status >= 200 && res.status < 300, 'the guard serves a page')
    assert.ok(res.body.indexOf('href="/"') >= 0, 'the guard page carries the same-site tap-through link')
    assert.strictEqual(res.headers['location'], undefined)
  } finally { await stop() }
})

// The marker guard, exercised end-to-end: the token WORKS, but the follow-up
// arrives WITHOUT the cookie — exactly what SameSite=Strict does on a
// cross-app top-level navigation. The marked 401 must produce the tap-through
// page, not another 303 (which would loop forever in a redirect-following
// browser).
test('auth exchange guard: a marked request that still 401s is answered with the tap-through page, never exchanged again', async () => {
  const { stop } = await bootAuth() // tokenOk: true
  try {
    const first = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    assert.strictEqual(first.status, 303)
    const marked = first.headers.location
    assert.ok(String(marked).indexOf('dsh-auth-retry=1') >= 0)

    // Follow WITHOUT the cookie (Strict cookie withheld on cross-site nav).
    const second = await request(PORT, { path: marked, headers: { accept: 'text/html' } })
    assert.strictEqual(second.status, 200, 'a marked 401 is served the tap-through page, not redirected')
    assert.ok(second.body.indexOf('href="') >= 0, 'the tap-through page carries a same-site link')
    assert.strictEqual(second.headers['location'], undefined, 'no third redirect')
  } finally { await stop() }
})

test('auth exchange: an /api 401 passes through untouched (XHR is not a page navigation)', async () => {
  const { stop } = await bootAuth()
  try {
    const res = await request(PORT, { path: '/api/x', headers: { accept: 'text/html' } })
    assert.strictEqual(res.status, 401)
    assert.strictEqual(res.headers['set-cookie'], undefined, 'no cookie minted for an API call')
    assert.strictEqual(res.headers['location'], undefined, 'no redirect for an API call')
  } finally { await stop() }
})

test('auth exchange: the token request reaches upstream with the rewritten loopback Host', async () => {
  const { target, stop } = await bootAuth()
  try {
    await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    const exchange = target.seen.find((r) => r.method === 'GET' && String(r.path).indexOf('token=') >= 0)
    assert.ok(exchange, 'the gateway performed one token exchange')
    assert.strictEqual(exchange.headers.host, '127.0.0.1:' + TARGET_PORT, 'exchange Host is the loopback target, not the public domain')
  } finally { await stop() }
})

// ---- GW-5: untrusted reverse-proxy detection -----------------------------------

test('GW-5: a proxy signature from an untrusted socket is recorded as lastForwardedSource', async () => {
  // The detection needs a NON-loopback socket peer (loopback is always
  // trusted), so the gateway binds 0.0.0.0 and the test connects to this
  // host's own LAN address — the closest faithful stand-in for the user's
  // reverse proxy. No LAN interface: nothing to simulate.
  const os = require('node:os')
  const fs = require('node:fs')
  let lan
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === 'IPv4' && !entry.internal) { lan = entry.address; break }
    }
    if (lan) break
  }
  if (!lan) return

  const target = await startMockTarget(0)
  const port = await freePort()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-gw5-'))
  const gw = startGatewayAt(home, port, target.address().port, { LAN_GATE_HOST: '0.0.0.0' })
  try {
    await gw.ready
    // Before any proxied request: the field exists and answers null.
    const before = JSON.parse((await request(port, { path: '/lan-gate/status' })).body)
    assert.strictEqual(before.lastForwardedSource, null)

    // A proxy signature (XFF) from the LAN socket: still refused as an
    // untrusted client (the 403 the pre-wizard gateway always gave), AND
    // recorded with the SOCKET ip for the wizard to offer.
    const marked = await fetch(`http://${lan}:${port}/lan-gate/status`, { headers: { 'x-forwarded-for': '203.0.113.9' } })
    assert.strictEqual(marked.status, 403)
    const after = JSON.parse((await request(port, { path: '/lan-gate/status' })).body)
    assert.strictEqual(after.lastForwardedSource.ip, lan, 'the recorded ip is the SOCKET peer, not the XFF claim')
    assert.strictEqual(typeof after.lastForwardedSource.at, 'number')

    // A plain (headerless) request from the same untrusted socket changes
    // nothing — only a proxy signature is a detection.
    await fetch(`http://${lan}:${port}/lan-gate/status`)
    const final = JSON.parse((await request(port, { path: '/lan-gate/status' })).body)
    assert.strictEqual(final.lastForwardedSource.ip, lan, 'the last detection survives headerless traffic')
  } finally {
    await stopAll(target, gw.child)
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
