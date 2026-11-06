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
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'state-store.js')).href

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
