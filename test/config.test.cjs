/* dsh-zen-remote · config: maxServers (PG-2, tasks/peer-gateway/PG-2.md)
 *
 * The `maxServers` field: how many relay servers one sub-client may keep
 * paired, resolved through the same four layers as every other field —
 * env (LAN_GATE_MAX_SERVERS) > row > lan-gate.config.json > default 8 —
 * with a 1..64 integer band. Like idleHours it is a LIVE field: never in
 * RESTART_FIELDS, read per request by the pool / client routes. These tests
 * drive the BUILT lib/config.js and lib/cli/config-writer.js, same reason
 * as the other lib-driving tests.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const CONFIG_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'config.js')).href
const WRITER_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'config-writer.js')).href
const loadConfig = () => import(CONFIG_URL)
const loadWriter = () => import(WRITER_URL)

// Test isolation: a LAN_GATE_MAX_SERVERS exported in the developer's shell
// would flip every expectation machine-dependently (the T12-fix discipline
// of config-resolve.test.cjs).
const SAVED_ENV = {}
test.before(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(?:LAN_GATE|DSH_PUSH)_/.test(key)) {
      SAVED_ENV[key] = process.env[key]
      delete process.env[key]
    }
  }
})
test.after(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) process.env[key] = value
})

// --- the four layers --------------------------------------------------------

test('maxServers: default 8, sources tracked through all four layers', async () => {
  const { resolveConfig, DEFAULTS } = await loadConfig()
  assert.equal(DEFAULTS.maxServers, 8, 'the default cap is 8')
  assert.equal(resolveConfig({}, {}, {}).values.maxServers, 8)
  assert.equal(resolveConfig({}, {}, {}).sources.maxServers, 'default')

  assert.equal(resolveConfig({ maxServers: 16 }, {}, {}).values.maxServers, 16)
  assert.equal(resolveConfig({ maxServers: 16 }, {}, {}).sources.maxServers, 'row')
  assert.equal(resolveConfig({}, { maxServers: 12 }, {}).values.maxServers, 12)
  assert.equal(resolveConfig({}, { maxServers: 12 }, {}).sources.maxServers, 'file')
  assert.equal(resolveConfig({}, {}, { LAN_GATE_MAX_SERVERS: '16' }).values.maxServers, 16)
  assert.equal(resolveConfig({}, {}, { LAN_GATE_MAX_SERVERS: '16' }).sources.maxServers, 'env')

  // The usual precedence, all layers set.
  const all = resolveConfig({ maxServers: 4 }, { maxServers: 12 }, { LAN_GATE_MAX_SERVERS: '16' })
  assert.equal(all.values.maxServers, 16)
  assert.equal(resolveConfig({ maxServers: 4 }, { maxServers: 12 }, {}).values.maxServers, 4, 'row beats file')
})

test('maxServers: the legal band is integer 1..64 inclusive; anything else is transparent', async () => {
  const { resolveConfig } = await loadConfig()
  assert.equal(resolveConfig({ maxServers: 1 }, {}, {}).values.maxServers, 1, 'the lower bound is inclusive')
  assert.equal(resolveConfig({ maxServers: 64 }, {}, {}).values.maxServers, 64, 'the upper bound is inclusive')

  for (const bad of [0, -1, 65, 8.5, Number.NaN, Number.POSITIVE_INFINITY, '16', true, null]) {
    assert.equal(
      resolveConfig({ maxServers: bad }, {}, {}).values.maxServers,
      8,
      `row maxServers ${String(bad)} must fall to the default`,
    )
  }
  // Per-layer transparency: an illegal row value is rescued by a legal file.
  const rescued = resolveConfig({ maxServers: 0 }, { maxServers: 12 }, {})
  assert.equal(rescued.values.maxServers, 12)
  assert.equal(rescued.sources.maxServers, 'file')

  // The env layer goes through the same band, on the Number() of the string.
  assert.equal(resolveConfig({}, {}, { LAN_GATE_MAX_SERVERS: '0' }).values.maxServers, 8, 'env 0 is illegal')
  assert.equal(resolveConfig({}, {}, { LAN_GATE_MAX_SERVERS: '65' }).values.maxServers, 8, 'env 65 is illegal')
  assert.equal(resolveConfig({}, {}, { LAN_GATE_MAX_SERVERS: 'abc' }).values.maxServers, 8, 'env garbage is illegal')
  assert.equal(resolveConfig({}, {}, { LAN_GATE_MAX_SERVERS: '' }).values.maxServers, 8, 'an empty env var is unset')
  assert.equal(resolveConfig({}, {}, { LAN_GATE_MAX_SERVERS: '64' }).values.maxServers, 64, 'env 64 is legal')
})

test('maxServers: the file layer keeps the digit-string leniency, the row layer stays strict', async () => {
  const { resolveConfig } = await loadConfig()
  const lenient = resolveConfig({}, { maxServers: '16' }, {})
  assert.equal(lenient.values.maxServers, 16, 'a hand-edited "16" string keeps working at the file layer')
  assert.equal(lenient.sources.maxServers, 'file')
  assert.equal(resolveConfig({}, { maxServers: '0' }, {}).values.maxServers, 8, 'an out-of-band digit string is still illegal')
  assert.equal(resolveConfig({}, { maxServers: '-5' }, {}).values.maxServers, 8, 'a sign is not a digit string')
  assert.equal(resolveConfig({ maxServers: '16' }, {}, {}).values.maxServers, 8, 'the row layer gets NO such leniency')
})

test('maxServers is NOT a restart field (PG-2): the pool reads it live', async () => {
  const { RESTART_FIELDS } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'restart-fields.js')).href)
  assert.ok(!RESTART_FIELDS.includes('maxServers'), 'maxServers must not reload the row')
})

// --- the loader schema ------------------------------------------------------

test('Config carries maxServers as a volatile field', async () => {
  const { Config } = await loadConfig()
  assert.ok('maxServers' in Config.dict, 'the schema declares the field (the settings form renders it)')
  assert.equal(Config.dict.maxServers.meta?.volatile, true, 'maxServers must be volatile like every field')
  const empty = Config({})
  assert.equal(empty.maxServers.get(), undefined, 'no schema default leaks into an empty row')
})

// --- the CLI writer registration ---------------------------------------------

test('ENV_VAR_BY_FIELD registers maxServers: LAN_GATE_MAX_SERVERS', async () => {
  const { ENV_VAR_BY_FIELD } = await loadWriter()
  assert.equal(ENV_VAR_BY_FIELD.maxServers, 'LAN_GATE_MAX_SERVERS')
})

test('writeCliConfig writes maxServers to the file layer and refuses under the env variable', async () => {
  const { writeCliConfig } = await loadWriter()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-config-maxservers-'))
  try {
    // A plain write lands in lan-gate.config.json and resolves to file.
    const written = writeCliConfig({ dshHome: home, env: {}, set: { maxServers: 12 } })
    assert.equal(written.ok, true)
    assert.equal(written.values.maxServers, 12)
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'lan-gate.config.json'), 'utf8')).maxServers, 12)

    // An env variable shadows the file layer: the write is REFUSED, naming
    // the exact variable, and the file keeps its previous value.
    const refused = writeCliConfig({ dshHome: home, env: { LAN_GATE_MAX_SERVERS: '16' }, set: { maxServers: 20 } })
    assert.deepEqual(refused, { ok: false, code: 'env-shadowed', field: 'maxServers', envVar: 'LAN_GATE_MAX_SERVERS' })
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'lan-gate.config.json'), 'utf8')).maxServers, 12, 'the refusal wrote nothing')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
