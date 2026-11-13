/* dsh-zen-remote · state-store (src/state-store.ts → lib/state-store.js)
 *
 * The MS-1 three-in-one state file: serverId + sessions + servers in ONE
 * `zen-remote-state.json`, so a write from any of the three can never clobber
 * the other two. These tests drive the BUILT lib/state-store.js against real
 * files under os.tmpdir() — the promises under test (0600 perms, atomic
 * tmp+rename, legacy-file migration) are only honest when a real filesystem
 * answers. No DSH, no network.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { syncBuiltinESMExports } = require('node:module')

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'state-store.js')).href

// ---- PC-13 error injection ---------------------------------------------------
//
// lib/state-store.js imports node:fs by ESM named exports. Patching
// require('node:fs') alone does NOT reach them — the named bindings only
// re-sync with the CJS exports when module.syncBuiltinESMExports() runs.
// Both directions are synced here: arm = patch + sync, disarm (always in the
// test's finally) = restore the original function + sync back. The wrappers
// throw ONLY where a test armed an exact path of its own and delegate
// everything else, so no other code in the process is affected. This is a
// standard-library seam — no resolve hooks, no generated shims.

const realChmodSync = fs.chmodSync
const realReadFileSync = fs.readFileSync
let armedChmod = null
let armedRead = null

function armChmodFailure(targetPath, error) {
  armedChmod = { path: targetPath, error }
  fs.chmodSync = function patchedChmodSync(p, mode) {
    if (armedChmod !== null && armedChmod.path === p) throw armedChmod.error
    return realChmodSync(p, mode)
  }
  syncBuiltinESMExports()
}

function disarmChmodFailure() {
  armedChmod = null
  fs.chmodSync = realChmodSync
  syncBuiltinESMExports()
}

/** A synthetic read failure shaped like the real thing (code, syscall, path). */
function eacces(targetPath) {
  const error = new Error(`simulated unreadable state file: ${targetPath}`)
  error.code = 'EACCES'
  error.syscall = 'open'
  error.path = targetPath
  return error
}

function armReadFailure(targetPath) {
  armedRead = { path: targetPath }
  fs.readFileSync = function patchedReadFileSync(p, options) {
    if (armedRead !== null && armedRead.path === p) throw eacces(armedRead.path)
    return realReadFileSync(p, options)
  }
  syncBuiltinESMExports()
}

function disarmReadFailure() {
  armedRead = null
  fs.readFileSync = realReadFileSync
  syncBuiltinESMExports()
}

let mod
test.before(async () => {
  mod = await import(MODULE_URL)
})

/** Fresh temp dir, removed when the test ends; the state file path inside. */
function tempStateFile(t, name = 'zen-remote-state.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, name)
}

// ---- 1. writeStateFile: permissions, atomicity, three-field independence ----

test('writeStateFile lands 0600 with no .tmp leftover and independent updates never clobber each other', (t) => {
  const file = tempStateFile(t)
  const { writeStateFile } = mod

  // First write: serverId only (what loadServerId produces on a fresh home).
  writeStateFile(file, () => ({ version: 1, serverId: 'abcd1234' }))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the state file is 0600 — it holds pairing tokens')
  assert.equal(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')).length,
    0,
    'no .tmp leftover after the rename',
  )

  // Second writer: the share table. serverId must survive.
  writeStateFile(file, (current) => ({
    ...current,
    version: 1,
    sessions: { s1: { sharedAt: 10, lastActivityAt: 20 } },
  }))
  // Third writer: the paired-servers list. serverId AND sessions must survive.
  writeStateFile(file, (current) => ({
    ...current,
    version: 1,
    servers: [{ id: 'deadbeef', serverUrl: 'http://10.0.0.2:3088', token: 'tok', createdAt: 1 }],
  }))
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.serverId, 'abcd1234', 'a sessions/servers write never clobbers serverId')
  assert.deepEqual(onDisk.sessions.s1, { sharedAt: 10, lastActivityAt: 20 }, 'a servers write never clobbers sessions')
  assert.equal(onDisk.servers.length, 1)
  assert.equal(onDisk.version, 1)
})

test('readStateFile: missing file is an empty state; garbage is quarantined with its content preserved', (t) => {
  const { readStateFile } = mod

  const missing = tempStateFile(t)
  assert.deepEqual(readStateFile(missing), { version: 1 }, 'a missing file is the normal first run')

  const file = tempStateFile(t)
  fs.writeFileSync(file, '{ this is not json')
  assert.deepEqual(readStateFile(file), { version: 1 }, 'a corrupt file reads as empty')
  const dir = path.dirname(file)
  const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith('zen-remote-state.json.corrupt-'))
  assert.equal(quarantined.length, 1, 'exactly one quarantine copy')
  assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), '{ this is not json', 'original preserved')
  assert.equal(fs.existsSync(file), false, 'the corrupt file itself is renamed away')

  // A future version with no salvageable shape is quarantined too (this code
  // cannot know what a version:2 file means; keeping it invisible is safest).
  const future = tempStateFile(t)
  fs.writeFileSync(future, JSON.stringify({ version: 2, note: 'hello' }))
  assert.deepEqual(readStateFile(future), { version: 1 })
  assert.equal(
    fs.readdirSync(path.dirname(future)).filter((name) => name.includes('.corrupt-')).length,
    1,
  )
})

test('readStateFile salvages a legal serverId out of an odd-shaped file instead of quarantining it', (t) => {
  const { readStateFile } = mod
  const file = tempStateFile(t)
  fs.writeFileSync(file, JSON.stringify({ serverId: 'abcd1234' }), 'utf8')
  const state = readStateFile(file)
  assert.equal(state.serverId, 'abcd1234', 'the identity survives a shape-less file')
  assert.equal(fs.existsSync(file), true, 'a file still carrying a migration source is NOT renamed away')
})

// ---- 2. ensureStateMigrated: the legacy files move in and are deleted ----

test('ensureStateMigrated moves serverId and sessions in and deletes the legacy files', (t) => {
  const { ensureStateMigrated, readStateFile } = mod
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-migrate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'zen-remote-state.json')
  fs.writeFileSync(path.join(dir, 'zen-remote-server.json'), JSON.stringify({ serverId: '1234abcd' }))
  fs.writeFileSync(
    path.join(dir, 'zen-remote-shares.json'),
    JSON.stringify({
      version: 1,
      sessions: {
        good: { sharedAt: 10, lastActivityAt: 20 },
        bad: { sharedAt: 'x', lastActivityAt: 20 },
      },
    }),
  )

  ensureStateMigrated(dir)

  const state = readStateFile(stateFile)
  assert.equal(state.serverId, '1234abcd', 'the server identity moved in')
  assert.deepEqual(state.sessions, { good: { sharedAt: 10, lastActivityAt: 20 } }, 'legal rows moved in, the bad row was dropped')
  assert.equal(fs.existsSync(path.join(dir, 'zen-remote-server.json')), false, 'legacy server file deleted after a successful write')
  assert.equal(fs.existsSync(path.join(dir, 'zen-remote-shares.json')), false, 'legacy shares file deleted after a successful write')
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600)

  // Idempotent: a second run changes nothing.
  ensureStateMigrated(dir)
  assert.deepEqual(readStateFile(stateFile), state)

  // When the state file already has the field, the legacy file is left alone.
  fs.writeFileSync(path.join(dir, 'zen-remote-server.json'), JSON.stringify({ serverId: 'ffffffff' }))
  ensureStateMigrated(dir)
  assert.equal(state.serverId, '1234abcd', 'an existing serverId is never overwritten')
  assert.equal(fs.existsSync(path.join(dir, 'zen-remote-server.json')), true, 'no migration, no deletion')
  fs.rmSync(path.join(dir, 'zen-remote-server.json'), { force: true })
})

// ---- 3. the legacy row client becomes servers[0], exactly once ----

test('ensureStateMigrated seeds servers[0] from the legacy row client; non-empty servers are never re-migrated', (t) => {
  const { ensureStateMigrated, listPairedServers } = mod
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-legacy-client-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  ensureStateMigrated(dir, { serverUrl: 'http://192.168.1.10:3088/', deviceToken: 'tok-1' })
  const servers = listPairedServers(path.join(dir, 'zen-remote-state.json'))
  assert.equal(servers.length, 1, 'exactly one record seeded')
  assert.equal(servers[0].serverUrl, 'http://192.168.1.10:3088', 'the address is normalized')
  assert.equal(servers[0].token, 'tok-1')
  assert.match(servers[0].id, /^[0-9a-f]{8}$/, 'the entry id is an 8-hex short id')
  assert.equal(typeof servers[0].createdAt, 'number')

  // A second run with DIFFERENT legacy credentials must not touch the list.
  ensureStateMigrated(dir, { serverUrl: 'http://10.9.9.9:3088', deviceToken: 'tok-2' })
  const after = listPairedServers(path.join(dir, 'zen-remote-state.json'))
  assert.equal(after.length, 1, 'non-empty servers are never re-migrated')
  assert.equal(after[0].token, 'tok-1')

  // Unusable legacy input seeds nothing.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-legacy-empty-'))
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }))
  ensureStateMigrated(empty, { serverUrl: 'not a url', deviceToken: 'tok' })
  ensureStateMigrated(empty, { serverUrl: 'http://10.0.0.5:3088', deviceToken: '' })
  assert.deepEqual(listPairedServers(path.join(empty, 'zen-remote-state.json')), [])
})

// ---- 4. upsertPairedServer: normalization, the 8 cap, same-URL re-pair ----

test('upsertPairedServer: invalid URL refused; new entries append in order; same URL updates in place', (t) => {
  const { upsertPairedServer, listPairedServers } = mod
  const file = tempStateFile(t)

  assert.deepEqual(upsertPairedServer(file, { serverUrl: 'nope', token: 't' }), { ok: false, code: 'invalid-url' })
  assert.deepEqual(mod.listPairedServers(file), [], 'a refused input writes nothing')

  const first = upsertPairedServer(file, { serverUrl: 'http://10.0.0.1:3088', token: 't1', deviceId: 'dev-1', deviceName: 'phone', now: 100 })
  assert.equal(first.ok, true)
  assert.equal(first.replaced, false)
  assert.equal(first.record.createdAt, 100, 'an explicit now seeds createdAt')
  assert.equal(first.record.deviceId, 'dev-1')
  assert.equal(first.record.deviceName, 'phone')

  const second = upsertPairedServer(file, { serverUrl: 'https://dsh.example.com', token: 't2', now: 200 })
  assert.equal(second.ok, true)

  // Re-pair the FIRST address: same record id, same position, same createdAt,
  // fresh token.
  const again = upsertPairedServer(file, { serverUrl: 'http://10.0.0.1:3088/', token: 't1-new', now: 999 })
  assert.equal(again.ok, true)
  assert.equal(again.replaced, true)
  assert.equal(again.record.id, first.record.id, 'the entry id is stable across a re-pair')
  assert.equal(again.record.createdAt, 100, 'createdAt is NOT moved by a re-pair')
  assert.equal(again.record.token, 't1-new')
  assert.equal(again.record.deviceName, 'phone', 'fields not in the input keep their old value')

  const list = listPairedServers(file)
  assert.equal(list.length, 2)
  assert.equal(list[0].id, first.record.id, 'position is preserved')
  assert.equal(list[0].token, 't1-new')
  assert.equal(list[1].id, second.record.id)
})

test('upsertPairedServer: the 8-server cap refuses only NEW addresses', (t) => {
  const { upsertPairedServer, listPairedServers } = mod
  const file = tempStateFile(t)

  for (let i = 1; i <= 8; i += 1) {
    const result = upsertPairedServer(file, { serverUrl: `http://10.0.0.${i}:3088`, token: `t${i}` })
    assert.equal(result.ok, true, `server ${i} fits`)
  }
  assert.equal(listPairedServers(file).length, 8)

  const ninth = upsertPairedServer(file, { serverUrl: 'http://10.0.1.1:3088', token: 't9' })
  assert.deepEqual(ninth, { ok: false, code: 'limit-reached' }, 'a ninth NEW address is refused')
  assert.equal(listPairedServers(file).length, 8, 'the refusal wrote nothing')

  // An EXISTING address may still be re-paired at the cap.
  const repair = upsertPairedServer(file, { serverUrl: 'http://10.0.0.3:3088', token: 't3-new' })
  assert.equal(repair.ok, true)
  assert.equal(repair.replaced, true)
  assert.equal(listPairedServers(file).length, 8)
  assert.equal(listPairedServers(file).find((r) => r.serverUrl === 'http://10.0.0.3:3088').token, 't3-new')
})

// ---- 5. recordServerHandshake: persistence + the second dedupe layer ----

test('recordServerHandshake records the handshake and removes stale same-serverId entries', (t) => {
  const { upsertPairedServer, recordServerHandshake, listPairedServers } = mod
  const file = tempStateFile(t)

  const a = upsertPairedServer(file, { serverUrl: 'http://10.0.0.1:3088', token: 'ta' })
  const b = upsertPairedServer(file, { serverUrl: 'http://10.0.0.2:3088', token: 'tb' })
  const c = upsertPairedServer(file, { serverUrl: 'http://10.0.0.3:3088', token: 'tc' })

  const first = recordServerHandshake(file, a.record.id, { serverId: 'aaa11111', serverName: 'home', deviceName: 'desk' })
  assert.deepEqual(first, { removedEntryIds: [] })
  let list = listPairedServers(file)
  assert.equal(list.find((r) => r.id === a.record.id).serverId, 'aaa11111')
  assert.equal(list.find((r) => r.id === a.record.id).serverName, 'home')
  assert.equal(list.find((r) => r.id === a.record.id).deviceName, 'desk')

  // Entry c now handshakes and reports the SAME serverId as entry a: the old
  // duplicate (a) is removed, the new one (c) is kept, b untouched.
  const second = recordServerHandshake(file, c.record.id, { serverId: 'aaa11111', serverName: 'home' })
  assert.deepEqual(second, { removedEntryIds: [a.record.id] }, 'the stale same-server entry is reported as removed')
  list = listPairedServers(file)
  assert.equal(list.find((r) => r.id === a.record.id), undefined, 'the stale entry is gone from the file')
  assert.equal(list.length, 2)
  assert.equal(list.find((r) => r.id === c.record.id).serverId, 'aaa11111')
  assert.equal(list.find((r) => r.id === b.record.id).serverId, undefined, 'the unrelated entry is untouched')

  // An unknown entry id changes nothing.
  const unknown = recordServerHandshake(file, 'nonesuch', { serverId: 'bbb22222', serverName: 'x' })
  assert.deepEqual(unknown, { removedEntryIds: [] })
  assert.equal(listPairedServers(file).length, 2)
})

// ---- 6. remove/clear ----

test('removePairedServer and clearPairedServers answer what they did', (t) => {
  const { upsertPairedServer, removePairedServer, clearPairedServers, listPairedServers } = mod
  const file = tempStateFile(t)
  const a = upsertPairedServer(file, { serverUrl: 'http://10.0.0.1:3088', token: 'ta' })
  const b = upsertPairedServer(file, { serverUrl: 'http://10.0.0.2:3088', token: 'tb' })

  assert.equal(removePairedServer(file, a.record.id), true)
  assert.equal(removePairedServer(file, a.record.id), false, 'a second remove of the same id answers false')
  assert.equal(listPairedServers(file).length, 1)

  assert.equal(clearPairedServers(file), 1, 'the count of removed records')
  assert.deepEqual(listPairedServers(file), [])
  assert.equal(removePairedServer(file, b.record.id), false, 'a cleared list has nothing to remove')
  assert.equal(clearPairedServers(file), 0, 'clearing an empty list answers 0')
})

// ---- 7. MS-phase1-fix regression: a servers write must never wipe the file ----

test('every servers writer preserves serverId and sessions on disk (MS-phase1-fix regression)', (t) => {
  const {
    writeStateFile,
    readStateFile,
    migrateLegacyClientIntoServers,
    upsertPairedServer,
    recordServerHandshake,
    removePairedServer,
    clearPairedServers,
    listPairedServers,
  } = mod
  const file = tempStateFile(t)
  const SEED_SESSIONS = { s1: { sharedAt: 10, lastActivityAt: 20 } }
  const expectIntact = (step) => {
    const onDisk = readStateFile(file)
    assert.equal(onDisk.serverId, 'abcd1234', `serverId survives ${step}`)
    assert.deepEqual(onDisk.sessions, SEED_SESSIONS, `sessions survive ${step}`)
  }

  // The pre-multi-server shape: an identity and a live share table, no
  // servers yet — exactly what an upgraded sub-client's state file looks like.
  writeStateFile(file, () => ({ version: 1, serverId: 'abcd1234', sessions: SEED_SESSIONS }))
  expectIntact('the seed')

  migrateLegacyClientIntoServers(file, { serverUrl: 'http://10.0.0.1:3088', deviceToken: 'tok-1' })
  expectIntact('migrateLegacyClientIntoServers')
  const [seeded] = listPairedServers(file)
  assert.equal(seeded.serverUrl, 'http://10.0.0.1:3088', 'the legacy row client was seeded as servers[0]')

  const added = upsertPairedServer(file, { serverUrl: 'http://10.0.0.2:3088', token: 'tok-2' })
  assert.equal(added.ok, true)
  assert.equal(added.replaced, false)
  expectIntact('upsertPairedServer (new entry)')

  const repaired = upsertPairedServer(file, { serverUrl: 'http://10.0.0.1:3088/', token: 'tok-1b' })
  assert.equal(repaired.ok, true)
  assert.equal(repaired.replaced, true)
  expectIntact('upsertPairedServer (same-URL re-pair)')

  const handshaken = recordServerHandshake(file, added.record.id, { serverId: 'bbb22222', serverName: 'office' })
  assert.deepEqual(handshaken, { removedEntryIds: [] })
  expectIntact('recordServerHandshake')

  assert.equal(removePairedServer(file, seeded.id), true)
  expectIntact('removePairedServer')

  assert.equal(clearPairedServers(file), 1)
  expectIntact('clearPairedServers')
})

test('writeStateFile merges over the disk state: a partial updater never erases fields it did not name', (t) => {
  const { writeStateFile, readStateFile } = mod
  const file = tempStateFile(t)
  writeStateFile(file, () => ({ version: 1, serverId: 'abcd1234', sessions: { s1: { sharedAt: 1, lastActivityAt: 2 } } }))
  // The exact buggy shape the review flagged: an updater that names ONLY its
  // own field. The belt inside writeStateFile must keep the rest alive.
  writeStateFile(file, () => ({
    version: 1,
    servers: [{ id: 'deadbeef', serverUrl: 'http://10.0.0.9:3088', token: 't', createdAt: 1 }],
  }))
  const state = readStateFile(file)
  assert.equal(state.serverId, 'abcd1234', 'the belt keeps serverId')
  assert.deepEqual(state.sessions, { s1: { sharedAt: 1, lastActivityAt: 2 } }, 'the belt keeps sessions')
  assert.equal(state.servers.length, 1, 'the field the updater DID name still lands')
})

// ---- 8. PG-2: the dynamic pairing cap ---------------------------------------

test('upsertPairedServer honors the maxServers input; the default stays 8 (PG-2)', (t) => {
  const { upsertPairedServer, listPairedServers } = mod
  const file = tempStateFile(t)

  // Default: the ninth NEW address is still refused (existing behavior).
  for (let i = 1; i <= 8; i += 1) {
    assert.equal(upsertPairedServer(file, { serverUrl: `http://10.0.0.${i}:3088`, token: `t${i}` }).ok, true)
  }
  assert.deepEqual(
    upsertPairedServer(file, { serverUrl: 'http://10.0.1.1:3088', token: 't9' }),
    { ok: false, code: 'limit-reached' },
    'without the input the cap stays at the default 8',
  )

  // A DIFFERENT file with maxServers 16: the 9th..16th fit, the 17th refuses.
  const wide = tempStateFile(t)
  for (let i = 1; i <= 16; i += 1) {
    const result = upsertPairedServer(wide, { serverUrl: `http://10.1.${Math.floor(i / 250)}.${(i % 250) + 1}:3088`, token: `t${i}`, maxServers: 16 })
    assert.equal(result.ok, true, `server ${i} fits under maxServers 16`)
  }
  assert.equal(listPairedServers(wide).length, 16)
  assert.deepEqual(
    upsertPairedServer(wide, { serverUrl: 'http://10.2.2.2:3088', token: 't17', maxServers: 16 }),
    { ok: false, code: 'limit-reached' },
    'the 17th NEW address is refused at 16/16',
  )
  assert.equal(listPairedServers(wide).length, 16, 'the refusal wrote nothing')

  // A TIGHT cap: maxServers 2 refuses the 3rd.
  const tight = tempStateFile(t)
  assert.equal(upsertPairedServer(tight, { serverUrl: 'http://10.3.0.1:3088', token: 'a', maxServers: 2 }).ok, true)
  assert.equal(upsertPairedServer(tight, { serverUrl: 'http://10.3.0.2:3088', token: 'b', maxServers: 2 }).ok, true)
  assert.deepEqual(
    upsertPairedServer(tight, { serverUrl: 'http://10.3.0.3:3088', token: 'c', maxServers: 2 }),
    { ok: false, code: 'limit-reached' },
  )

  // A re-pair of an EXISTING address never hits the cap — even over it (the
  // list shrank? no — the cap can be exceeded only by a REMOVED input).
  const repair = upsertPairedServer(tight, { serverUrl: 'http://10.3.0.1:3088/', token: 'a-new', maxServers: 2 })
  assert.equal(repair.ok, true)
  assert.equal(repair.replaced, true)

  // A garbage input value degrades to the DEFAULT cap (8) — never to "zero"
  // (which would refuse everything) nor to "infinite": the 3rd entry fits
  // again, exactly as it would without the input.
  assert.equal(upsertPairedServer(tight, { serverUrl: 'http://10.3.0.3:3088', token: 'c', maxServers: 0 }).ok, true, 'an illegal cap falls back to the default 8')
  assert.equal(upsertPairedServer(tight, { serverUrl: 'http://10.3.0.4:3088', token: 'd', maxServers: 2.5 }).ok, true)
  assert.equal(upsertPairedServer(tight, { serverUrl: 'http://10.3.0.5:3088', token: 'e', maxServers: Number.NaN }).ok, true)
  for (let i = 6; i <= 8; i += 1) {
    assert.equal(upsertPairedServer(tight, { serverUrl: `http://10.3.0.${i}:3088`, token: `t${i}` }).ok, true, `fallback default still admits server ${i}`)
  }
  assert.equal(upsertPairedServer(tight, { serverUrl: 'http://10.3.0.9:3088', token: 't9' }).ok, false, 'the fallback default still refuses the 9th')
})

// ---- 9. PG-2: peer identity / network / TOFU pinning storage -----------------

/** An Ed25519 identity for the TOFU tests, via the peer crypto module. */
let peerCrypto
test.before(async () => {
  peerCrypto = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'peer', 'crypto.js')).href)
})

test('ensurePeerIdentity: a fresh machine gets a 0600 identity and serverId = nodeId; a call again reuses it (PG-2)', (t) => {
  const { ensurePeerIdentity, readStateFile } = mod
  const file = tempStateFile(t)

  const first = ensurePeerIdentity(file)
  assert.match(first.nodeId, /^[0-9a-f]{8}$/, 'the node id is an 8-hex self-certifying id')
  assert.match(first.publicKeyHex, /^[0-9a-f]{64}$/, 'the public key is 64 lowercase hex chars')
  assert.match(first.privateKeyHex, /^[0-9a-f]{64}$/, 'the private seed is 64 lowercase hex chars')
  assert.equal(peerCrypto.verifySelfCertifyingNodeId(first.nodeId, first.publicKeyHex), true, 'the id is the hash of the key')
  assert.equal(first.serverId, first.nodeId, 'a machine with no serverId adopts the nodeId as its serverId')

  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the identity lives in the 0600 state file')
  const state = readStateFile(file)
  assert.deepEqual(
    { nodeId: state.peerIdentity.nodeId, publicKeyHex: state.peerIdentity.publicKeyHex, privateKeyHex: state.peerIdentity.privateKeyHex },
    { nodeId: first.nodeId, publicKeyHex: first.publicKeyHex, privateKeyHex: first.privateKeyHex },
  )
  assert.equal(typeof state.peerIdentity.createdAt, 'number')

  // A second call is a pure read: same identity, no regeneration.
  const second = ensurePeerIdentity(file)
  assert.deepEqual(
    { nodeId: second.nodeId, publicKeyHex: second.publicKeyHex, privateKeyHex: second.privateKeyHex },
    { nodeId: first.nodeId, publicKeyHex: first.publicKeyHex, privateKeyHex: first.privateKeyHex },
  )
})

test('ensurePeerIdentity: an existing legal serverId is never overwritten by the nodeId (PG-2)', (t) => {
  const { ensurePeerIdentity, writeStateFile, readStateFile } = mod
  const file = tempStateFile(t)
  writeStateFile(file, () => ({ version: 1, serverId: 'abcd1234' }))

  const identity = ensurePeerIdentity(file)
  assert.equal(identity.nodeId, identity.nodeId)
  assert.notEqual(identity.nodeId, 'abcd1234', 'the fresh nodeId has no reason to equal the old serverId')
  assert.equal(identity.serverId, 'abcd1234', 'the OLD serverId is preserved')
  assert.equal(readStateFile(file).serverId, 'abcd1234', 'and on disk too')

  // A second call answers the same pair.
  const again = ensurePeerIdentity(file)
  assert.equal(again.nodeId, identity.nodeId)
  assert.equal(again.serverId, 'abcd1234')
})

test('ensurePeerIdentity: a hostile or broken peerIdentity is regenerated, not trusted (PG-2)', (t) => {
  const { ensurePeerIdentity, writeStateFile, readStateFile } = mod
  const file = tempStateFile(t)
  // A peerIdentity whose nodeId is NOT the hash of its key must never be
  // reused — that is the whole self-certifying contract.
  writeStateFile(file, (current) => ({
    ...current,
    version: 1,
    peerIdentity: { publicKeyHex: 'ab'.repeat(32), privateKeyHex: 'cd'.repeat(32), nodeId: 'deadbeef', createdAt: 1 },
  }))
  const identity = ensurePeerIdentity(file)
  assert.equal(peerCrypto.verifySelfCertifyingNodeId(identity.nodeId, identity.publicKeyHex), true, 'the regenerated identity is self-certifying')
  assert.notEqual(identity.nodeId, 'deadbeef')

  // A shape-broken identity (short key) regenerates too.
  const file2 = tempStateFile(t)
  writeStateFile(file2, (current) => ({
    ...current,
    version: 1,
    peerIdentity: { publicKeyHex: 'abcd', privateKeyHex: 'ef01', nodeId: '12345678', createdAt: 1 },
  }))
  const fresh = ensurePeerIdentity(file2)
  assert.equal(fresh.publicKeyHex.length, 64)
})

test('writePeerNetwork / readPeerNetwork round-trip; undefined clears; every other field survives (PG-2)', (t) => {
  const { writePeerNetwork, readPeerNetwork, upsertPairedServer, readStateFile } = mod
  const file = tempStateFile(t)

  assert.equal(readPeerNetwork(file), undefined, 'no network yet')

  const net = {
    inviteUri: 'zr-net://gw.example.com:19393/9f4e2a1088c3b001#join-secret',
    gatewayWsUrl: 'wss://gw.example.com:19393',
    gatewayHttpOrigin: 'https://gw.example.com:19393',
    networkId: '9f4e2a1088c3b001',
    joinKey: 'join-secret',
    disabledNodes: ['deadbeef'],
    maxPeersFromGateway: 12,
    joinedAt: 1000,
  }
  writePeerNetwork(file, net)
  assert.deepEqual(readPeerNetwork(file), net, 'the record round-trips verbatim')

  // Another writer must not clobber it (the three-in-one belt again).
  upsertPairedServer(file, { serverUrl: 'http://10.0.0.1:3088', token: 't' })
  assert.deepEqual(readPeerNetwork(file), net, 'a pairing write keeps the network record')

  // Writing undefined removes the field — and only that field.
  writePeerNetwork(file, undefined)
  assert.equal(readPeerNetwork(file), undefined)
  assert.equal(readStateFile(file).peerNetwork, undefined, 'the field left the file')
  assert.equal(listLength(file), 1, 'the paired list survived the clear')
})

/** listPairedServers shorthand (the destructured import above stays stable). */
function listLength(file) {
  return mod.listPairedServers(file).length
}

test('setPeerNodeDisabled toggles a nodeId in peerNetwork.disabledNodes (PG-2)', (t) => {
  const { writePeerNetwork, setPeerNodeDisabled, readPeerNetwork } = mod
  const file = tempStateFile(t)
  writePeerNetwork(file, {
    gatewayWsUrl: 'wss://gw.example.com:19393',
    gatewayHttpOrigin: 'https://gw.example.com:19393',
    networkId: '9f4e2a1088c3b001',
    joinedAt: 1000,
  })

  setPeerNodeDisabled(file, 'deadbeef', true)
  assert.deepEqual(readPeerNetwork(file).disabledNodes, ['deadbeef'])
  setPeerNodeDisabled(file, 'cafebeef', true)
  assert.deepEqual(readPeerNetwork(file).disabledNodes, ['deadbeef', 'cafebeef'])
  // Idempotent: disabling an already-disabled node must not duplicate it.
  setPeerNodeDisabled(file, 'deadbeef', true)
  assert.deepEqual(readPeerNetwork(file).disabledNodes, ['deadbeef', 'cafebeef'])

  setPeerNodeDisabled(file, 'deadbeef', false)
  assert.deepEqual(readPeerNetwork(file).disabledNodes, ['cafebeef'])
  // Un-disable one that was never disabled: no error, no phantom entries.
  setPeerNodeDisabled(file, '12345678', false)
  assert.deepEqual(readPeerNetwork(file).disabledNodes, ['cafebeef'])
  // Restoring the last one leaves the empty list, not undefined fields.
  setPeerNodeDisabled(file, 'cafebeef', false)
  assert.deepEqual(readPeerNetwork(file).disabledNodes, [])

  // Without a network record there is nothing to toggle: a silent no-op.
  const bare = tempStateFile(t)
  assert.doesNotThrow(() => setPeerNodeDisabled(bare, 'deadbeef', true))
  assert.equal(mod.readPeerNetwork(bare), undefined)
})

test('verifyOrPinPeerKey: pin-new → matched → key-mismatch, and never an auto-overwrite (PG-2)', (t) => {
  const { verifyOrPinPeerKey, writeStateFile, readStateFile } = mod
  const file = tempStateFile(t)

  const honest = peerCrypto.generatePeerIdentity()
  const collided = peerCrypto.generatePeerIdentity()

  // A key whose id is not its hash is refused before anything is written.
  const bad = peerCrypto.generatePeerIdentity()
  assert.deepEqual(verifyOrPinPeerKey(file, 'deadbeef', bad.publicKeyHex), { ok: false, code: 'invalid-self-cert' })
  assert.equal((readStateFile(file).pinnedPeers ?? {}).deadbeef, undefined, 'nothing was pinned')
  // A malformed key shape lands in the same bucket (verify fails).
  assert.deepEqual(verifyOrPinPeerKey(file, honest.nodeId, 'nothex'), { ok: false, code: 'invalid-self-cert' })

  // First sight: pin it.
  const first = verifyOrPinPeerKey(file, honest.nodeId, honest.publicKeyHex, 1000)
  assert.deepEqual(first, { ok: true, status: 'pinned-new' })
  const pinned = readStateFile(file).pinnedPeers[honest.nodeId]
  assert.equal(pinned.publicKeyHex, honest.publicKeyHex)
  assert.equal(pinned.firstSeenAt, 1000)
  assert.equal(pinned.updatedAt, 1000)

  // Second sight, same key: matched, and the pin is untouched.
  const second = verifyOrPinPeerKey(file, honest.nodeId, honest.publicKeyHex, 2000)
  assert.deepEqual(second, { ok: true, status: 'matched' })
  assert.equal(readStateFile(file).pinnedPeers[honest.nodeId].updatedAt, 1000, 'a match is a read, not a write')

  // A key that does NOT self-certify for this node id (the ordinary wrong
  // peer / ordinary attack) can never even reach the pin comparison: it is
  // invalid-self-cert, and the anchor is untouched.
  const notForThisId = verifyOrPinPeerKey(file, honest.nodeId, collided.publicKeyHex, 3000)
  assert.deepEqual(notForThisId, { ok: false, code: 'invalid-self-cert' })
  assert.equal(readStateFile(file).pinnedPeers[honest.nodeId].publicKeyHex, honest.publicKeyHex)

  // The key-mismatch branch fires for a DIFFERENT key that IS self-certifying
  // for the same node id — a 32-bit hash collision, exactly the attack the
  // TOFU anchor exists for. No honest test can mine one, so the disk is set
  // into the post-collision state directly: the anchor for honest.nodeId
  // holds the collided key, the wire presents the honest key (which still
  // self-certifies for the id). The anchor must NOT move.
  writeStateFile(file, (current) => ({
    ...current,
    version: 1,
    pinnedPeers: { ...current.pinnedPeers, [honest.nodeId]: { publicKeyHex: collided.publicKeyHex, firstSeenAt: 1, updatedAt: 2 } },
  }))
  const mismatch = verifyOrPinPeerKey(file, honest.nodeId, honest.publicKeyHex, 3000)
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'key-mismatch')
  assert.equal(mismatch.expectedPublicKeyHex, collided.publicKeyHex, 'the report names the pinned key')
  assert.equal(readStateFile(file).pinnedPeers[honest.nodeId].publicKeyHex, collided.publicKeyHex, 'the anchor was NOT auto-overwritten')
  assert.equal(readStateFile(file).pinnedPeers[honest.nodeId].updatedAt, 2, 'and not even a timestamp moved')
})

test('repinPeerKey: only an explicit call moves the anchor, and it verifies first (PG-2)', (t) => {
  const { repinPeerKey, verifyOrPinPeerKey, writeStateFile, readStateFile } = mod
  const file = tempStateFile(t)

  const honest = peerCrypto.generatePeerIdentity()
  const collided = peerCrypto.generatePeerIdentity()

  assert.equal(verifyOrPinPeerKey(file, honest.nodeId, honest.publicKeyHex, 1000).status, 'pinned-new')

  // An invalid replacement is refused and changes nothing.
  assert.equal(repinPeerKey(file, honest.nodeId, 'nothex', 2000), false, 'a non-self-certifying key is refused')
  assert.equal(repinPeerKey(file, honest.nodeId, collided.publicKeyHex, 2000), false, 'a key for a DIFFERENT id does not self-certify for this one')
  assert.equal(readStateFile(file).pinnedPeers[honest.nodeId].publicKeyHex, honest.publicKeyHex)

  // The collision world again (see the verifyOrPinPeerKey test): the anchor
  // was subverted to the collided key; the user clicks 信任新身份 to trust
  // the honest key. The explicit re-pin moves the anchor; firstSeenAt is
  // preserved, updatedAt moves, and the NEXT verifyOrPinPeerKey answers
  // matched for the restored key.
  writeStateFile(file, (current) => ({
    ...current,
    version: 1,
    pinnedPeers: { ...current.pinnedPeers, [honest.nodeId]: { publicKeyHex: collided.publicKeyHex, firstSeenAt: 1, updatedAt: 2 } },
  }))
  assert.equal(repinPeerKey(file, honest.nodeId, honest.publicKeyHex, 3000), true)
  const pinned = readStateFile(file).pinnedPeers[honest.nodeId]
  assert.equal(pinned.publicKeyHex, honest.publicKeyHex)
  assert.equal(pinned.firstSeenAt, 1, 'the first-seen history is kept')
  assert.equal(pinned.updatedAt, 3000)
  assert.deepEqual(verifyOrPinPeerKey(file, honest.nodeId, honest.publicKeyHex, 4000), { ok: true, status: 'matched' })

  // A re-pin of an UNPINNED node anchors it outright (verify passes, so the
  // operator's explicit action is honored).
  const fresh = peerCrypto.generatePeerIdentity()
  assert.equal(repinPeerKey(file, fresh.nodeId, fresh.publicKeyHex, 6000), true)
  assert.equal(readStateFile(file).pinnedPeers[fresh.nodeId].publicKeyHex, fresh.publicKeyHex)
})

test('the peer fields ride the write belt: a pairing write never wipes identity/network/pins (PG-2)', (t) => {
  const { ensurePeerIdentity, writePeerNetwork, verifyOrPinPeerKey, upsertPairedServer, readStateFile } = mod
  const file = tempStateFile(t)
  const identity = ensurePeerIdentity(file)
  writePeerNetwork(file, {
    gatewayWsUrl: 'wss://gw.example.com:19393',
    gatewayHttpOrigin: 'https://gw.example.com:19393',
    networkId: '9f4e2a1088c3b001',
    joinedAt: 1000,
  })
  const peer = peerCrypto.generatePeerIdentity()
  verifyOrPinPeerKey(file, peer.nodeId, peer.publicKeyHex)

  upsertPairedServer(file, { serverUrl: 'http://10.0.0.1:3088', token: 't' })

  const state = readStateFile(file)
  assert.equal(state.serverId, identity.nodeId)
  assert.equal(state.peerIdentity.nodeId, identity.nodeId, 'the identity survived a pairing write')
  assert.equal(state.peerNetwork.networkId, '9f4e2a1088c3b001', 'the network survived a pairing write')
  assert.equal(state.pinnedPeers[peer.nodeId].publicKeyHex, peer.publicKeyHex, 'the pin survived a pairing write')
})

// ---- 10. PC-13: permission repair is visible, never silent ------------------

/** sha256 of a key, so a failed assertion never prints key material. */
function keyHash(hex) {
  return createHash('sha256').update(hex).digest('hex')
}

test('writeStateFile: a failed tmp chmod aborts the rename, keeps the original, cleans the tmp (PC-13)', (t) => {
  const file = tempStateFile(t)
  const { writeStateFile } = mod
  writeStateFile(file, () => ({ version: 1, serverId: 'abcd1234', sessions: { s1: { sharedAt: 1, lastActivityAt: 2 } } }))
  const before = fs.readFileSync(file, 'utf8')

  armChmodFailure(`${file}.tmp`, new Error('simulated tmp chmod failure'))
  let error = null
  try {
    writeStateFile(file, (current) => ({ ...current, version: 1, serverId: 'ffffffff' }))
  } catch (caught) {
    error = caught
  } finally {
    disarmChmodFailure()
  }
  assert.ok(error, 'the chmod failure must reach the caller, not be swallowed before the rename')
  assert.equal(error.message, 'simulated tmp chmod failure', 'the ORIGINAL error surfaces')
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the original file was not renamed over')
  assert.equal(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')).length,
    0,
    'the aborted tmp of ours is cleaned up',
  )

  // The door is not wedged: a normal write still lands.
  writeStateFile(file, (current) => ({ ...current, version: 1, sessions: { s2: { sharedAt: 3, lastActivityAt: 4 } } }))
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(after.serverId, 'abcd1234')
  assert.equal(after.sessions.s2.lastActivityAt, 4)
})

test('writeStateFile: an unreadable state file fails the write instead of being silently replaced (PC-13)', (t) => {
  const file = tempStateFile(t)
  const { writeStateFile } = mod
  writeStateFile(file, () => ({ version: 1, serverId: 'abcd1234', sessions: { s1: { sharedAt: 1, lastActivityAt: 2 } } }))
  const before = fs.readFileSync(file, 'utf8')

  // Deterministic: the read failure is injected for THIS path only, so the
  // case does not depend on real mode bits — a root user could still read a
  // 0000 file, and Windows' chmod cannot produce one at all.
  armReadFailure(file)
  let error = null
  try {
    writeStateFile(file, (current) => ({ ...current, version: 1, sessions: { s2: { sharedAt: 3, lastActivityAt: 4 } } }))
  } catch (caught) {
    error = caught
  } finally {
    disarmReadFailure()
  }
  assert.ok(error, 'a read error must not read as an empty file and get renamed over')
  assert.equal(error.code, 'EACCES', 'the read failure itself is what surfaced')
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the original data is intact and recoverable')
  assert.equal(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')).length,
    0,
    'no tmp leftover from the refused write',
  )
})

test('ensurePeerIdentity: reusing an identity repairs a world-readable file to 0600 without touching any data (PC-13)', (t) => {
  const { ensurePeerIdentity } = mod
  const file = tempStateFile(t)
  const seed = peerCrypto.generatePeerIdentity()
  // Written RAW (not through writeStateFile) so the file also carries a
  // top-level field this code does not know — the reuse must not rewrite it.
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    serverId: 'abcd1234',
    peerIdentity: { ...seed, createdAt: 1000 },
    sessions: { s1: { sharedAt: 1, lastActivityAt: 2 } },
    servers: [{ id: 'deadbeef', serverUrl: 'http://10.0.0.1:3088', token: 'tok', createdAt: 1 }],
    futureField: { keep: true },
  }))
  fs.chmodSync(file, 0o644)
  // POSIX mode-bit assertions only: Windows' chmodSync cannot express 0644
  // or 0600 (it moves the read-only attribute), so gating JUST these two
  // checks keeps the repair test itself running everywhere without faking a
  // failure — or claiming ACL equivalence.
  const posixModeBits = process.platform !== 'win32'
  if (posixModeBits) assert.equal(fs.statSync(file).mode & 0o777, 0o644)
  const rawBefore = fs.readFileSync(file, 'utf8')

  const identity = ensurePeerIdentity(file)

  if (posixModeBits) assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the reuse path repaired the wide mode')
  assert.equal(
    keyHash(identity.privateKeyHex),
    keyHash(seed.privateKeyHex),
    'the private seed was reused, not regenerated (hash-compared)',
  )
  assert.equal(identity.nodeId, seed.nodeId)
  assert.equal(identity.serverId, 'abcd1234', 'the old serverId is kept')
  assert.equal(fs.readFileSync(file, 'utf8'), rawBefore, 'not one byte of content changed — no rewrite, unknown fields intact')
})

test('ensurePeerIdentity: a permission repair that fails errors loudly instead of regenerating (PC-13)', (t) => {
  const { ensurePeerIdentity, readStateFile } = mod
  const file = tempStateFile(t)
  const first = ensurePeerIdentity(file)
  fs.chmodSync(file, 0o644)

  armChmodFailure(file, new Error('simulated repair failure'))
  let error = null
  try {
    ensurePeerIdentity(file)
  } catch (caught) {
    error = caught
  } finally {
    disarmChmodFailure()
  }
  assert.ok(error, 'a repair that cannot be done must not be a silent no-op')
  assert.equal(error.message, 'simulated repair failure', 'the ORIGINAL error surfaces')
  const state = readStateFile(file)
  assert.equal(state.peerIdentity.nodeId, first.nodeId, 'the identity was NOT regenerated')
  assert.equal(keyHash(state.peerIdentity.privateKeyHex), keyHash(first.privateKeyHex), 'the original seed is still on disk')
})

test('ensurePeerIdentity: an unreadable state file is an explicit failure, not a fresh machine (PC-13)', (t) => {
  const { ensurePeerIdentity, readStateFile } = mod
  const file = tempStateFile(t)
  const first = ensurePeerIdentity(file)

  // Deterministic injection (see the writeStateFile unreadable test): no
  // reliance on real mode bits, which root or Windows chmod could defeat.
  armReadFailure(file)
  let error = null
  try {
    ensurePeerIdentity(file)
  } catch (caught) {
    error = caught
  } finally {
    disarmReadFailure()
  }
  assert.ok(error, 'an unreadable file must not be mistaken for "no identity"')
  const state = readStateFile(file)
  assert.equal(state.peerIdentity.nodeId, first.nodeId, 'the original identity was not renamed away')
  assert.equal(keyHash(state.peerIdentity.privateKeyHex), keyHash(first.privateKeyHex), 'the original seed survived')
  assert.equal(state.serverId, first.serverId, 'the serverId survived')
  assert.equal(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')).length,
    0,
    'no rename attempt left a tmp behind',
  )
})
