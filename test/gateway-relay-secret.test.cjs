/* dsh-zen-remote · T22a gateway shared secret (lib/lan-gate-server.cjs)
 *
 * The desktop-client relay depends on a secret only the gateway can write:
 * the host plugin mints it per apply, lan-gate.mjs hands it to this child
 * through LAN_GATE_RELAY_SECRET, and every device-authenticated forward
 * carries it as x-zen-remote-secret. These tests boot the REAL gateway child
 * (test/util.cjs spawns lib/lan-gate-server.cjs with the env var) behind the
 * recording mock upstream and pin the four contract points:
 *   - a device request reaches upstream WITH the correct secret;
 *   - a local direct request never carries it (or any marking header);
 *   - a client-forged secret header is dropped (local) or replaced by the
 *     gateway's own value (device);
 *   - an empty/absent env var means the header is never added.
 * The WebSocket upgrade path uses the same cleanHeaders output, so it gets
 * one assertion of its own too.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { REMOTE_HEADERS, startGateway, request, pairDevice, pairDesktop, startRecordingTarget, rawUpgrade, stopAll } = require('./util.cjs')

const PORT = 39261
const TARGET_PORT = 39262
const SECRET = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'

async function boot(extraEnv) {
  const target = await startRecordingTarget(TARGET_PORT)
  const gw = startGateway(PORT, TARGET_PORT, extraEnv)
  await gw.ready
  return { target, gw, stop: () => stopAll({ close: (done) => target.close().then(done, done) }, gw.child) }
}

test('T22a-1: device forwards carry the secret, forged ones are replaced, local direct stays unmarked', async () => {
  const { target, stop } = await boot({ LAN_GATE_RELAY_SECRET: SECRET })
  try {
    const { token, id } = await pairDesktop(PORT)
    const auth = { ...REMOTE_HEADERS, authorization: 'Bearer ' + token }

    const relay = await request(PORT, { path: '/_dsh/zen-remote/relay/ping', headers: auth })
    assert.strictEqual(relay.status, 200)
    let hit = target.seen.find((r) => r.path === '/_dsh/zen-remote/relay/ping')
    assert.ok(hit, 'upstream saw the device request')
    assert.strictEqual(hit.headers['x-zen-remote-secret'], SECRET, 'the gateway stamps its own secret for device traffic')

    const forged = await request(PORT, {
      path: '/_dsh/zen-remote/relay/ping',
      headers: { ...auth, 'x-zen-remote-secret': 'client-forged' },
    })
    assert.strictEqual(forged.status, 200)
    hit = target.seen.filter((r) => r.path === '/_dsh/zen-remote/relay/ping').pop()
    assert.strictEqual(hit.headers['x-zen-remote-secret'], SECRET, 'the forged value was replaced by the gateway value, not passed through')
    assert.strictEqual(hit.headers['x-zen-remote-device'], id, 'and the rest of the marking headers are the real ones too')

    await request(PORT, { path: '/local-check', headers: { 'x-zen-remote-secret': 'client-forged' } })
    hit = target.seen.find((r) => r.path === '/local-check')
    assert.ok(hit, 'local direct request reached upstream')
    const leaked = Object.keys(hit.headers).filter((k) => k.indexOf('x-zen-remote-') === 0)
    assert.strictEqual(leaked.length, 0, 'local direct carries no secret and no marking headers at all, got: ' + leaked.join(','))
  } finally { await stop() }
})

test('T22a-2: the WebSocket upgrade path stamps the secret the same way', async () => {
  const { target, stop } = await boot({ LAN_GATE_RELAY_SECRET: SECRET })
  try {
    const { token } = await pairDesktop(PORT)
    const up = await rawUpgrade(PORT, '/_dsh/zen-remote/relay/ws', { ...REMOTE_HEADERS, authorization: 'Bearer ' + token })
    assert.ok(/HTTP\/1\.1 101/.test(up.buf), 'relay upgrade succeeds')
    assert.strictEqual(target.upgrades.length, 1)
    assert.strictEqual(target.upgrades[0].headers['x-zen-remote-secret'], SECRET, 'the upgrade request is stamped like any HTTP forward')
    try { up.sock.destroy() } catch (e) {}
  } finally { await stop() }
})

test('T22a-fix: web device forwards carry the marking headers but NEVER the secret', async () => {
  const { target, stop } = await boot({ LAN_GATE_RELAY_SECRET: SECRET })
  try {
    const { cookie, id } = await pairDevice(PORT, '网页机')
    const page = await request(PORT, { path: '/', headers: { ...REMOTE_HEADERS, cookie } })
    assert.strictEqual(page.status, 200)
    let hit = target.seen.find((r) => r.path === '/')
    assert.ok(hit, 'upstream saw the web page request')
    assert.strictEqual(hit.headers['x-zen-remote-via'], 'gateway')
    assert.strictEqual(hit.headers['x-zen-remote-device'], id)
    assert.strictEqual(hit.headers['x-zen-remote-secret'], undefined, 'a web device never carries the relay secret')

    // Web devices may still walk the relay prefix (unchanged T13-6) — the
    // request is forwarded, but the secret stays off it: DSH's relay routes
    // refuse a web device on the via/role check anyway.
    const relay = await request(PORT, { path: '/_dsh/zen-remote/relay/ping', headers: { ...REMOTE_HEADERS, cookie } })
    assert.strictEqual(relay.status, 200)
    hit = target.seen.find((r) => r.path === '/_dsh/zen-remote/relay/ping')
    assert.ok(hit, 'the web relay request was forwarded')
    assert.strictEqual(hit.headers['x-zen-remote-secret'], undefined, 'and it carries no secret either')
  } finally { await stop() }
})

test('T22a-3: no secret in the environment means no header anywhere', async () => {
  // Explicit empty value, not a missing one: the contract must not depend on
  // the developer's shell being clean.
  const { target, stop } = await boot({ LAN_GATE_RELAY_SECRET: '' })
  try {
    const { token } = await pairDesktop(PORT)
    const relay = await request(PORT, { path: '/_dsh/zen-remote/relay/ping', headers: { ...REMOTE_HEADERS, authorization: 'Bearer ' + token } })
    assert.strictEqual(relay.status, 200)
    const hit = target.seen.find((r) => r.path === '/_dsh/zen-remote/relay/ping')
    assert.ok(hit, 'upstream saw the device request')
    assert.strictEqual(hit.headers['x-zen-remote-secret'], undefined, 'an empty secret disables the header entirely')
    assert.strictEqual(hit.headers['x-zen-remote-via'], 'gateway', 'the other marking headers are unaffected')
  } finally { await stop() }
})
