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
const { startMockTarget, startGateway, request, stopAll, pairDevice, REMOTE_HEADERS } = require('./util.cjs')

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

    const sw = await request(PORT, { path: '/pwa/sw.js' })
    assert.strictEqual(sw.status, 200)
    assert.ok(sw.body.includes('dsh-mobile-pwa'))
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
    assert.match(page.body, /window\.__DSH_PWA__=\{vapid:"[A-Za-z0-9_-]{20,}"\}/, 'real VAPID public key injected')
    assert.ok(page.body.includes('href="/lan-gate/admin"'), 'local user gets the admin entry chip')
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
