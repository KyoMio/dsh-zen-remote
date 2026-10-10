// Behaviour check for the plugin bridge's settings-page pure pieces
// (src/client-data/plugin-bridge.ts, PB-5), driven against the REAL
// settings-form pieces the toggles stage through (Node >= 23.6 type
// stripping, no build needed):
//
// - derivePluginBridgeStatuses: every BridgeReason's copy key, the bridged
//   case, the unknown-reason fallback, malformed rows skipped, non-arrays
//   answered with [].
// - togglePluginConsent: one key per click, every other key carried over
//   (including entries for plugins no longer registered), an illegal
//   current map read as empty.
// - consentField (settings-form.ts): the staged-form spec the toggles ride
//   — format/parse round-trip, an illegal draft blocks the save, and the
//   full toggle → parse → plan shape a save would send.
//
// Run: node scripts/check-plugin-bridge-ui.mjs
import assert from 'node:assert/strict'
import { derivePluginBridgeStatuses, togglePluginConsent } from '../src/client-data/plugin-bridge.ts'
import { consentField, SETTINGS_FIELDS } from '../src/client-data/settings-form.ts'

let testChain = Promise.resolve()
function test(name, fn) {
  testChain = testChain
    .then(fn)
    .then(() => { console.log(`ok - ${name}`) })
    .catch((error) => {
      console.error(`not ok - ${name}`)
      throw error
    })
  return testChain
}

const STATUS = (over = {}) => ({ plugin: 'test-panel', bridged: false, reason: 'offline', localVersion: '1.0.0', ...over })

// ---- derivePluginBridgeStatuses ---------------------------------------------

await test('every reason maps to its copy key, bridged to 已桥接', () => {
  const rows = derivePluginBridgeStatuses([
    STATUS({ bridged: true, reason: undefined }),
    STATUS({ reason: 'not-on-server' }),
    STATUS({ reason: 'version-mismatch', serverVersion: '2.0.0' }),
    STATUS({ reason: 'declaration-mismatch' }),
    STATUS({ reason: 'consent-off' }),
    STATUS({ reason: 'offline' }),
    STATUS({ reason: 'server-too-old' }),
  ])
  assert.deepEqual(rows.map((row) => row.stateKey), [
    'settings.bridge.stateBridged',
    'settings.bridge.stateNotOnServer',
    'settings.bridge.stateVersionMismatch',
    'settings.bridge.stateDeclarationMismatch',
    'settings.bridge.stateConsentOff',
    'settings.bridge.stateOffline',
    'settings.bridge.stateServerTooOld',
  ])
  assert.equal(rows[0].plugin, 'test-panel')
  assert.equal(rows[0].localVersion, '1.0.0')
  // 版本不同的文案 carries the server version for the {version} interpolation.
  assert.equal(rows[2].serverVersion, '2.0.0')
})

await test('an unknown reason falls to the offline copy; malformed rows and shapes never throw', () => {
  const rows = derivePluginBridgeStatuses([
    STATUS({ reason: 'some-future-reason' }),
    STATUS({ bridged: true, reason: 'offline' }), // bridged outranks any reason
    null,
    42,
    { noPlugin: true },
  ])
  assert.deepEqual(rows.map((row) => row.stateKey), [
    'settings.bridge.stateOffline',
    'settings.bridge.stateBridged',
  ])
  assert.deepEqual(derivePluginBridgeStatuses(undefined), [])
  assert.deepEqual(derivePluginBridgeStatuses('x'), [])
  assert.deepEqual(derivePluginBridgeStatuses(42), [])
})

// ---- togglePluginConsent ----------------------------------------------------

await test('a toggle changes exactly ONE key and keeps every other — including unregistered leftovers', () => {
  const current = { 'old-plugin': true, 'another': false, 'gone-plugin': true }
  const next = togglePluginConsent(current, 'new-plugin', true)
  assert.deepEqual(next, { 'old-plugin': true, another: false, 'gone-plugin': true, 'new-plugin': true })
  // The INPUT is never mutated (staging reads it again for the next toggle).
  assert.deepEqual(current, { 'old-plugin': true, 'another': false, 'gone-plugin': true })

  const off = togglePluginConsent(next, 'new-plugin', false)
  assert.deepEqual(off, { 'old-plugin': true, another: false, 'gone-plugin': true, 'new-plugin': false })
})

await test('an illegal current map reads as empty; the toggle writes from scratch', () => {
  for (const bad of [undefined, null, 'x', 42, [], { plugin: 'yes' }]) {
    assert.deepEqual(togglePluginConsent(bad, 'p', true), { p: true }, `current ${JSON.stringify(bad)} must read as empty`)
  }
})

// ---- consentField: the staged-form spec the toggles ride ---------------------

await test('consentField round-trips a map through format/parse; an illegal draft blocks the save', () => {
  const spec = consentField('pluginBridgeConsent')
  assert.equal(spec.field, 'pluginBridgeConsent')
  const map = { 'a': true, 'b': false }
  const draft = spec.format(map)
  const write = spec.parse(draft)
  assert.deepEqual(write, { kind: 'set', value: map })

  // format tolerates an illegal stored value (the row validator's job to refuse it).
  assert.equal(spec.format('junk'), '{}')
  assert.equal(spec.format(null), '{}')
  assert.equal(spec.format(['x']), '{}')
  assert.equal(spec.format({ a: 'yes' }), '{}')

  // Every malformed draft is undefined — the save refuses rather than writing junk.
  for (const bad of ['', 'not json', '"string"', '42', '[]', 'null', '{"a":"yes"}', '{"a":1}']) {
    assert.equal(spec.parse(bad), undefined, `draft ${bad} must not parse`)
  }
})

await test('the toggle lands on the SHARED field table and a save would send exactly one set op', () => {
  // The field the toggles stage is on SETTINGS_FIELDS — the same table
  // autoShareNewSessions rides, hence the same save button and fence.
  assert.ok(SETTINGS_FIELDS.some((spec) => spec.field === 'pluginBridgeConsent'), 'pluginBridgeConsent is a settings field')

  const spec = SETTINGS_FIELDS.find((entry) => entry.field === 'pluginBridgeConsent')
  const current = { 'old': true }
  const next = togglePluginConsent(current, 'new-plugin', true)
  const write = spec.parse(JSON.stringify(next))
  assert.deepEqual(write, { kind: 'set', value: { old: true, 'new-plugin': true } })

  // And the no-change detection: a draft equal to the displayed value
  // produces no write at all (plan() compares against format(displayValue)).
  const unchanged = spec.parse(spec.format(current))
  assert.deepEqual(unchanged, { kind: 'set', value: { old: true } })
  assert.equal(JSON.stringify(next) === spec.format(next), true, 'an unchanged map formats identical to its draft')
})

let failed = 0
await testChain.catch(() => { failed = 1 })
if (failed !== 0) process.exit(1)
console.log('check-plugin-bridge-ui: ok')
