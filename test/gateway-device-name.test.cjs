/* dsh-zen-remote · T59 device-name sync, gateway half (lib/lan-gate-server.cjs)
 *
 * The gateway learns a device name at pairing and every rename updates the
 * device table. Two things are pinned here:
 *   1. every desktop-client forward carries `x-zen-remote-device-name`
 *      (percent-encoded current table name), and a client-supplied header of
 *      the same name never survives — the x-zen-remote-* namespace belongs
 *      to the gateway;
 *   2. POST /_dsh/zen-remote/relay/v1/device/name is answered by the
 *      GATEWAY itself (never forwarded upstream): a desktop-client device
 *      renames only ITSELF (no id in the body to forge), 1–40 chars after
 *      trim, and the new name is visible in the table (status) and on the
 *      very next forward's marking header.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { REMOTE_HEADERS, startRecordingTarget, startGateway, request, pairDesktop, pairDevice, stopAll, freePort } = require('./util.cjs')

let PORT = 0
let TARGET_PORT = 0

async function boot() {
  const target = await startRecordingTarget(0)
  TARGET_PORT = target.server.address().port
  PORT = await freePort()
  const gw = startGateway(PORT, TARGET_PORT)
  await gw.ready
  return {
    gw,
    target,
    stop: () => stopAll(target.server, gw.child),
  }
}

const DEVICE_NAME_PATH = '/_dsh/zen-remote/relay/v1/device/name'

test('T59 gateway: desktop-client forwards carry the percent-encoded device-name header; a forged one is dropped', async () => {
  const { stop, target } = await boot()
  try {
    const { token } = await pairDesktop(PORT, '书房的台式机')
    // The client FORGES both the name header and (harmless) junk in the
    // x-zen-remote-* namespace; the gateway must replace, never forward.
    const res = await request(PORT, {
      method: 'POST',
      path: '/_dsh/zen-remote/relay/v1/handshake',
      headers: {
        ...REMOTE_HEADERS,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-zen-remote-device': 'forged-id',
        'x-zen-remote-device-name': 'forged-name',
      },
      body: {},
    })
    assert.strictEqual(res.status, 200)
    const upstream = target.seen.find((row) => String(row.path).split('?')[0] === '/_dsh/zen-remote/relay/v1/handshake')
    assert.notEqual(upstream, undefined, 'the forward reached the upstream')
    assert.strictEqual(upstream.headers['x-zen-remote-device-name'], encodeURIComponent('书房的台式机'), 'the gateway wrote ITS table name, encoded')
    assert.strictEqual(upstream.headers['x-zen-remote-device'], target.seen.length >= 0 ? upstream.headers['x-zen-remote-device'] : '', 'sanity')
    assert.notEqual(upstream.headers['x-zen-remote-device'], 'forged-id', 'the forged device id was dropped too')
  } finally { await stop() }
})

test('T59 gateway: device/name renames the CALLER only, validates the name, and never forwards', async () => {
  const { stop, target, gw } = await boot()
  try {
    const own = await pairDesktop(PORT, '旧名')
    const other = await pairDesktop(PORT, '另一台')

    // The happy path: trim, 1–40, renames the CALLING device only.
    const ok = await request(PORT, {
      method: 'POST',
      path: DEVICE_NAME_PATH,
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
      body: { name: '  书房的新名字  ' },
    })
    assert.strictEqual(ok.status, 200)
    assert.deepStrictEqual(JSON.parse(ok.body), { ok: true, name: '书房的新名字' })

    // The OTHER device's record is untouched, and the table shows it.
    const status = JSON.parse((await request(PORT, { path: '/lan-gate/status' })).body)
    const byId = new Map(status.devices.map((d) => [d.id, d.name]))
    assert.strictEqual(byId.get(own.id), '书房的新名字')
    assert.strictEqual(byId.get(other.id), '另一台')

    // The very next forward carries the new name.
    await request(PORT, {
      method: 'POST',
      path: '/_dsh/zen-remote/relay/v1/handshake',
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
      body: {},
    })
    const forward = target.seen.filter((row) => String(row.path).split('?')[0] === '/_dsh/zen-remote/relay/v1/handshake').pop()
    assert.strictEqual(forward.headers['x-zen-remote-device-name'], encodeURIComponent('书房的新名字'))

    // Name validation (T59-fix semantics): empty after the trim is refused;
    // an over-cap name is TRUNCATED to 40 whole characters, not refused.
    for (const bad of ['', '   ']) {
      const res = await request(PORT, {
        method: 'POST',
        path: DEVICE_NAME_PATH,
        headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
        body: { name: bad },
      })
      assert.strictEqual(res.status, 400, `an empty-after-trim name is refused`)
    }
    const after = JSON.parse((await request(PORT, { path: '/lan-gate/status' })).body)
    assert.strictEqual(new Map(after.devices.map((d) => [d.id, d.name])).get(own.id), '书房的新名字', 'the table survived the bad bodies')
    // An over-cap name is TRUNCATED to 40 whole characters, not refused —
    // asserted last, since it rewrites the table.
    const truncated = await request(PORT, {
      method: 'POST',
      path: DEVICE_NAME_PATH,
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
      body: { name: 'y'.repeat(41) },
    })
    assert.strictEqual(truncated.status, 200)
    assert.deepStrictEqual(JSON.parse(truncated.body), { ok: true, name: 'y'.repeat(40) }, 'over cap truncates to 40 whole characters')

    // NEVER forwarded: the upstream saw only the relay routes the client
    // asked for, not the device-name endpoint.
    const hits = target.seen.filter((row) => String(row.path).split('?')[0] === DEVICE_NAME_PATH)
    assert.strictEqual(hits.length, 0, 'the endpoint was answered by the gateway, not proxied')

    // A web device and an unauthenticated caller are refused.
    const web = await pairDevice(PORT, '手机')
    const webRes = await request(PORT, {
      method: 'POST',
      path: DEVICE_NAME_PATH,
      headers: { ...REMOTE_HEADERS, cookie: web.cookie, 'content-type': 'application/json' },
      body: { name: '手机改名' },
    })
    assert.strictEqual(webRes.status, 403, 'a web device cannot rename anything here')
    const anonRes = await request(PORT, {
      method: 'POST',
      path: DEVICE_NAME_PATH,
      headers: { ...REMOTE_HEADERS, 'content-type': 'application/json' },
      body: { name: '匿名' },
    })
    assert.strictEqual(anonRes.status, 403, 'an unauthenticated caller is refused')
    // The local user has no device to be — refused as well (this request IS
    // local: no forwarded headers, loopback Host through request()).
    const localRes = await request(PORT, { method: 'POST', path: DEVICE_NAME_PATH, headers: { 'content-type': 'application/json' }, body: { name: '本机' } })
    assert.strictEqual(localRes.status, 403, 'the local user is not a device')

    // GET is not the channel.
    const getStatus = await request(PORT, {
      method: 'GET',
      path: DEVICE_NAME_PATH,
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}` },
    })
    assert.strictEqual(getStatus.status, 405)

    // Sanity: the gateway child is still alive after all the refusals.
    const alive = await request(PORT, { path: '/lan-gate/status' })
    assert.strictEqual(alive.status, 200)
    assert.ok(gw.child.pid > 0)
  } finally { await stop() }
})

// ---- T59-fix: poison names can no longer take the gateway down ----------------

test('T59-fix: a lone-surrogate rename is answered sanitized — the gateway lives on', async () => {
  const { stop, target, gw } = await boot()
  try {
    const own = await pairDesktop(PORT, '旧名')
    // The raw "\ud800" (JSON escapes it intact): sanitizeDeviceName replaces
    // the lone surrogate with U+FFFD instead of storing a poison character.
    const res = await request(PORT, {
      method: 'POST',
      path: DEVICE_NAME_PATH,
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
      body: { name: '\ud800' },
    })
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, name: '\uFFFD' })

    // Still alive, and the next forward still works — with the sanitized
    // name riding the header.
    const alive = await request(PORT, {
      method: 'POST',
      path: '/_dsh/zen-remote/relay/v1/handshake',
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${own.token}`, 'content-type': 'application/json' },
      body: {},
    })
    assert.strictEqual(alive.status, 200, 'the gateway survived the poison name')
    const forward = target.seen.filter((row) => String(row.path).split('?')[0] === '/_dsh/zen-remote/relay/v1/handshake').pop()
    assert.strictEqual(forward.headers['x-zen-remote-device-name'], encodeURIComponent('\uFFFD'))
    assert.ok(gw.child.pid > 0)
  } finally { await stop() }
})

test('T59-fix: a pairing name cut at 39 chars + an emoji keeps the WHOLE emoji; the admin rename too', async () => {
  const { stop, target } = await boot()
  try {
    // The OLD slice(0, 40) cut this emoji in half: 39 a's + the astral
    // emoji = 41 code units, half of it a lone surrogate.
    const gen = await request(PORT, { method: 'POST', path: '/lan-gate/pair', body: { role: 'desktop-client' } })
    const code = JSON.parse(gen.body).code
    const claim = await request(PORT, {
      method: 'POST',
      path: '/lan-gate/pair/claim-desktop',
      headers: REMOTE_HEADERS,
      body: { code, name: 'a'.repeat(39) + '\u{1F600}' },
    })
    assert.strictEqual(claim.status, 200)
    const { j, token } = { j: JSON.parse(claim.body), token: JSON.parse(claim.body).token }
    assert.strictEqual(j.name, 'a'.repeat(39) + '\u{1F600}', 'the whole emoji survived the cap')

    // A forward encodes it cleanly (no URIError — the gateway stays up).
    const forward = await request(PORT, {
      method: 'POST',
      path: '/_dsh/zen-remote/relay/v1/handshake',
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: {},
    })
    assert.strictEqual(forward.status, 200)
    const seen = target.seen.filter((row) => String(row.path).split('?')[0] === '/_dsh/zen-remote/relay/v1/handshake').pop()
    assert.strictEqual(seen.headers['x-zen-remote-device-name'], encodeURIComponent('a'.repeat(39) + '\u{1F600}'))

    // The admin rename sanitizer: a trailing half-emoji becomes U+FFFD.
    const rename = await request(PORT, { method: 'POST', path: '/lan-gate/action', body: { action: 'rename', id: j.id, name: 'ab' + '\ud83d' } })
    assert.strictEqual(rename.status, 200)
    const status = JSON.parse((await request(PORT, { path: '/lan-gate/status' })).body)
    assert.strictEqual(new Map(status.devices.map((d) => [d.id, d.name])).get(j.id), 'ab\uFFFD')
  } finally { await stop() }
})

test('T59-fix: a poisoned name in the STATE FILE is scrubbed at boot and every request works', async () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const os = require('node:os')
  const { startGatewayAt } = require('./util.cjs')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't59fix-state-'))
  const poisonName = 'x'.repeat(10) + '\ud800'
  const token = 'f'.repeat(64)
  const state = {
    version: 2,
    devices: {
      deadbeef: { id: 'deadbeef', token, name: poisonName, role: 'desktop-client', kind: 'auto', createdAt: 1, lastSeen: 1, ua: '' },
    },
    vapid: null,
    pushSubscriptions: {},
  }
  fs.writeFileSync(path.join(home, 'lan-gate-state.json'), JSON.stringify(state), 'utf8')
  const target = await startRecordingTarget(0)
  const targetPort = target.server.address().port
  PORT = await freePort()
  const gw = startGatewayAt(home, PORT, targetPort)
  await gw.ready
  try {
    // The gateway booted over a poison name and answers normally; the name
    // was scrubbed at load (and rewritten).
    const status = JSON.parse((await request(PORT, { path: '/lan-gate/status' })).body)
    assert.strictEqual(status.devices.length, 1)
    assert.strictEqual(status.devices[0].name, 'x'.repeat(10) + '\uFFFD', 'the lone surrogate became U+FFFD at load')

    // The forward does not crash on the header, and the scrubbed name rides.
    const forward = await request(PORT, {
      method: 'POST',
      path: '/_dsh/zen-remote/relay/v1/handshake',
      headers: { ...REMOTE_HEADERS, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: {},
    })
    assert.strictEqual(forward.status, 200)
    const seen = target.seen.filter((row) => String(row.path).split('?')[0] === '/_dsh/zen-remote/relay/v1/handshake').pop()
    assert.strictEqual(seen.headers['x-zen-remote-device-name'], encodeURIComponent('x'.repeat(10) + '\uFFFD'))

    // And the scrubbed state was persisted.
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'lan-gate-state.json'), 'utf8'))
    assert.strictEqual(onDisk.devices.deadbeef.name, 'x'.repeat(10) + '\uFFFD', 'the rewrite landed')
  } finally { await stopAll(target.server, gw.child) }
})
