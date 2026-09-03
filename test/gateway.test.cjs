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
const { startMockTarget, startMockAuthTarget, startGateway, request, stopAll, pairDevice, REMOTE_HEADERS } = require('./util.cjs')

const VIEWPORT_RE = /<meta[^>]*name=["']?viewport["']?[^>]*>/gi
// Exactly what DSH itself serves today — the tag the gateway has to rewrite.
const DSH_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1" />'

const PORT = 39202
const TARGET_PORT = 39201

async function boot() {
  const target = await startMockTarget(TARGET_PORT)
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  return { gw, stop: () => stopAll(target, gw.child) }
}

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
  const target = await startMockTarget(TARGET_PORT, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="manifest" href="/manifest.webmanifest" /></head><body>ok</body></html>')
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    const links = page.body.match(/<link[^>]*rel=["']?manifest["']?[^>]*>/gi) || []
    assert.strictEqual(links.length, 1, 'exactly one manifest link survives')
    assert.ok(links[0].includes('/pwa/manifest.json'), 'the surviving link is the gateway\'s own')
    assert.ok(!page.body.includes('/manifest.webmanifest'), 'the shadowed upstream manifest link is gone')
  } finally { await stopAll(target, gw.child) }
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
    assert.ok(page.body.includes('href="/lan-gate/admin"'), 'local user gets the admin entry chip')
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
    //    (The local-user admin chip is a body-side element and is not part of
    //    this head-ordering contract.)
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
  const target = await startMockTarget(TARGET_PORT, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + DSH_VIEWPORT + '</head><body>ok</body></html>')
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    const metas = page.body.match(VIEWPORT_RE) || []
    assert.strictEqual(metas.length, 1, 'exactly one viewport meta')
    assert.match(metas[0], /viewport-fit=cover/)
  } finally { await stopAll(target, gw.child) }
})

// Devices pinned to "desktop" keep the upstream viewport untouched.
test('gateway: leaves the viewport alone for kind=desktop devices', async () => {
  const target = await startMockTarget(TARGET_PORT, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + DSH_VIEWPORT + '</head><body>ok</body></html>')
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  try {
    const { cookie, id } = await pairDevice(PORT, 'desk')
    await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'set-kind', id, kind: 'desktop' } })
    const page = await request(PORT, { path: '/', headers: Object.assign({ accept: 'text/html', cookie }, REMOTE_HEADERS) })
    assert.ok(page.body.includes('data-lan-device="desktop"'), 'served as a desktop device')
    const metas = page.body.match(VIEWPORT_RE) || []
    assert.strictEqual(metas.length, 1)
    assert.doesNotMatch(metas[0], /viewport-fit/)
  } finally { await stopAll(target, gw.child) }
})

test('gateway: injected inline scripts have balanced braces (quoting bug guard)', async () => {
  const { stop } = await boot()
  try {
    const page = await request(PORT, { path: '/', headers: { accept: 'text/html' } })
    const scripts = extractInlineScripts(page.body)
    assert.ok(scripts.length > 0, 'expected inline scripts')
    for (const s of scripts) assert.ok(balanced(s), 'inline script braces balanced: ' + s.slice(0, 40))
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
const UPSTREAM_TOKEN_URL = () => 'http://127.0.0.1:' + TARGET_PORT + '/?token=TESTTOKEN'

async function bootAuth(opts) {
  const target = await startMockAuthTarget(TARGET_PORT, opts)
  const gw = startGateway(PORT, TARGET_PORT, { LAN_GATE_UPSTREAM_TOKEN_URL: UPSTREAM_TOKEN_URL() })
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
  const target = await startMockAuthTarget(TARGET_PORT)
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
