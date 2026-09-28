/* dsh-zen-remote · config resolution (src/config.ts → lib/config.js)
 *
 * The four-layer merge contract — env > plugin row > lan-gate.config.json >
 * defaults — with per-layer validation: an illegal value makes its layer
 * transparent instead of erroring, which is what lets a hand-edited row
 * coexist with an old config file. Drives the BUILT lib/config.js, same
 * reason as the other lib-driving tests: src/ uses relative specifiers that
 * Node's strip-only type stripping cannot map. Nothing here touches the real
 * ~/.dsh — readFileConfig is always handed an explicit env object whose
 * DSH_HOME points at a throwaway directory.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const CONFIG_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'config.js')).href
const load = () => import(CONFIG_URL)

// T12-fix test isolation: any LAN_GATE_* / DSH_PUSH_* variable exported in
// the developer's shell would leak into every resolveConfig call that reads
// process.env and flip these expectations machine-dependently. Save them all
// and clear before any test runs; restore afterwards (node --test runs this
// file in its own child process, so nothing leaks sideways either).
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

/** One throwaway DSH_HOME passed to readFileConfig explicitly; removed after. */
async function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-config-'))
  try { return await fn({ DSH_HOME: home }) } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

/** Set one env variable for the duration of `fn`, restoring afterwards. */
async function withEnvVar(name, value, fn) {
  const original = process.env[name]
  process.env[name] = value
  try { return await fn() } finally {
    if (original === undefined) delete process.env[name]
    else process.env[name] = original
  }
}

// --- the four layers -------------------------------------------------------

test('one field set on all four layers resolves env > row > file > default, sources tracked', async () => {
  const { resolveConfig } = await load()
  const row = { port: 4001 }
  const file = { port: 4002 }
  const env = { LAN_GATE_PORT: '4003' }

  assert.equal(resolveConfig(row, file, env).values.port, 4003)
  assert.equal(resolveConfig(row, file, env).sources.port, 'env')
  assert.equal(resolveConfig(row, file, {}).values.port, 4001)
  assert.equal(resolveConfig(row, file, {}).sources.port, 'row')
  assert.equal(resolveConfig({}, file, {}).values.port, 4002)
  assert.equal(resolveConfig({}, file, {}).sources.port, 'file')
  assert.equal(resolveConfig({}, {}, {}).values.port, 3088)
  assert.equal(resolveConfig({}, {}, {}).sources.port, 'default')
})

test('the same precedence holds for a push field with its DSH_PUSH_* variable', async () => {
  const { resolveConfig } = await load()
  assert.equal(resolveConfig({ pushDebounceMs: 5 }, { pushDebounceMs: 6 }, { DSH_PUSH_DEBOUNCE_MS: '7' }).values.pushDebounceMs, 7)
  assert.equal(resolveConfig({ pushDebounceMs: 5 }, { pushDebounceMs: 6 }, {}).values.pushDebounceMs, 5)
  assert.equal(resolveConfig({}, { pushDebounceMs: 6 }, {}).values.pushDebounceMs, 6)
  assert.equal(resolveConfig({}, {}, {}).values.pushDebounceMs, 15000)
})

test('every resolved field carries a source, and the shape covers all keys', async () => {
  const { resolveConfig, DEFAULTS } = await load()
  const { values, sources } = resolveConfig({}, {}, {})
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(key in values, `values must carry ${key}`)
    assert.ok(sources[key] in { env: 1, row: 1, file: 1, default: 1 }, `sources.${key} must be a layer name`)
  }
})

// --- illegal values skip their layer --------------------------------------

test('an illegal row value falls through to the file layer', async () => {
  const { resolveConfig } = await load()
  // The canonical acceptance example: row port "abc", file port 4000.
  const rescued = resolveConfig({ port: 'abc' }, { port: 4000 }, {})
  assert.equal(rescued.values.port, 4000)
  assert.equal(rescued.sources.port, 'file')

  assert.equal(resolveConfig({ port: 70000 }, { port: 4002 }, {}).values.port, 4002, 'out of band is skipped, not clamped')
  assert.equal(resolveConfig({ port: 4001.5 }, { port: 4002 }, {}).values.port, 4002, 'non-integers are not ports')
  assert.equal(resolveConfig({ port: true }, { port: 4002 }, {}).values.port, 4002, 'booleans are not ports either')
  assert.equal(resolveConfig({ port: 'abc' }, {}, {}).values.port, 3088, 'nothing legal anywhere means default')
  assert.equal(resolveConfig({}, {}, { LAN_GATE_PORT: 'abc' }).values.port, 3088, 'a bad env var behaves the same')
  assert.equal(resolveConfig({}, {}, { LAN_GATE_PORT: '' }).values.port, 3088, 'an empty env var is not a port')
})

test('idleHours accepts only (0, 8760]', async () => {
  const { resolveConfig } = await load()
  assert.equal(resolveConfig({ idleHours: 24 }, {}, {}).values.idleHours, 24)
  assert.equal(resolveConfig({ idleHours: 8760 }, {}, {}).values.idleHours, 8760, 'the upper bound is inclusive')
  for (const bad of [0, -1, 8761, '48', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveConfig({ idleHours: bad }, {}, {}).values.idleHours, 48, `idleHours ${String(bad)} must fall to default`)
  }
})

test('lang and role only accept their enum members', async () => {
  const { resolveConfig } = await load()
  assert.equal(resolveConfig({ lang: 'fr' }, { lang: 'en' }, {}).values.lang, 'en')
  assert.equal(resolveConfig({ lang: 'fr' }, {}, {}).values.lang, 'auto')
  assert.equal(resolveConfig({ lang: 'zh' }, {}, {}).values.lang, 'zh')
  assert.equal(resolveConfig({}, {}, { LAN_GATE_LANG: 'fr' }).values.lang, 'auto')

  assert.equal(resolveConfig({ role: 'server' }, { role: 'client' }, {}).values.role, 'client', 'an invalid row role can be rescued by the file')
  assert.equal(resolveConfig({ role: 'server' }, {}, {}).values.role, 'host')
  assert.equal(resolveConfig({ role: 'client' }, {}, {}).values.role, 'client')
})

test('non-numeric pushDebounceMs and rateLimit fall to their defaults', async () => {
  const { resolveConfig } = await load()
  assert.equal(resolveConfig({ pushDebounceMs: -1 }, {}, {}).values.pushDebounceMs, 15000)
  assert.equal(resolveConfig({ pushDebounceMs: 'fast' }, {}, {}).values.pushDebounceMs, 15000)
  assert.equal(resolveConfig({ pushDebounceMs: 0 }, {}, {}).values.pushDebounceMs, 0, 'zero is a legal debounce')
  assert.equal(resolveConfig({ rateLimit: 0 }, {}, {}).values.rateLimit, 120, 'rateLimit must be positive')
  assert.equal(resolveConfig({ rateLimit: 30 }, {}, {}).values.rateLimit, 30)
})

test('host and vapidSubject must be non-blank; pushEvents must not be empty', async () => {
  const { resolveConfig } = await load()
  assert.equal(resolveConfig({ host: '' }, {}, {}).values.host, '127.0.0.1')
  assert.equal(resolveConfig({ host: '0.0.0.0' }, {}, {}).values.host, '0.0.0.0')
  assert.equal(resolveConfig({ vapidSubject: '   ' }, {}, {}).values.vapidSubject, 'mailto:admin@localhost')
  assert.equal(resolveConfig({ pushEvents: 'a/b,c/d' }, {}, {}).values.pushEvents, 'a/b,c/d')
  assert.equal(resolveConfig({ pushEvents: '' }, {}, {}).values.pushEvents, 'agent/turn-stopping')
})

// --- booleans --------------------------------------------------------------

test('boolean fields read true/false plus the historic 1/"1"/0/"0" from row and file', async () => {
  const { resolveConfig } = await load()
  for (const [raw, expected] of [[true, true], [false, false], [1, true], ['1', true], [0, false], ['0', false]]) {
    const viaFile = resolveConfig({}, { pushSummary: raw }, {})
    assert.equal(viaFile.values.pushSummary, expected, `file pushSummary ${JSON.stringify(raw)} must mean ${expected}`)
    assert.equal(viaFile.sources.pushSummary, 'file')
    const viaRow = resolveConfig({ pushTurnEnd: raw }, {}, {})
    assert.equal(viaRow.values.pushTurnEnd, expected, `row pushTurnEnd ${JSON.stringify(raw)} must mean ${expected}`)
  }
  assert.equal(resolveConfig({}, { pushSummary: 'yes' }, {}).values.pushSummary, false, 'anything else falls to default')
  assert.equal(resolveConfig({ autoShareNewSessions: 'false' }, {}, {}).values.autoShareNewSessions, false, 'the string "false" is not a boolean')
  assert.equal(resolveConfig({}, {}, {}).values.pushTool, true, 'pushTool defaults to on')
})

test('env boolean semantics: DSH_PUSH_SUMMARY/TURN_END are 1-gated, DSH_PUSH_TOOL flips off only on 0', async () => {
  const { resolveConfig } = await load()
  await withEnvVar('DSH_PUSH_SUMMARY', '1', async () => {
    const r = resolveConfig({}, {}, process.env)
    assert.equal(r.values.pushSummary, true)
    assert.equal(r.sources.pushSummary, 'env')
  })
  await withEnvVar('DSH_PUSH_SUMMARY', '0', async () => {
    assert.equal(resolveConfig({}, {}, process.env).values.pushSummary, false, 'anything but "1" is off')
  })
  await withEnvVar('DSH_PUSH_TOOL', '0', async () => {
    assert.equal(resolveConfig({}, {}, process.env).values.pushTool, false)
  })
  await withEnvVar('DSH_PUSH_TOOL', '1', async () => {
    assert.equal(resolveConfig({}, {}, process.env).values.pushTool, true)
  })
  await withEnvVar('DSH_PUSH_TURN_END', '1', async () => {
    assert.equal(resolveConfig({}, {}, process.env).values.pushTurnEnd, true)
  })
  // Env beats an opposing file value — that is the whole point of layer 1.
  await withEnvVar('DSH_PUSH_TOOL', '0', async () => {
    assert.equal(resolveConfig({}, { pushTool: true }, process.env).values.pushTool, false)
  })
})

// --- normalization ---------------------------------------------------------

test('trustedProxies normalizes an array into a comma-separated string', async () => {
  const { resolveConfig } = await load()
  const array = resolveConfig({ trustedProxies: ['10.0.0.1', '10.0.0.2'] }, {}, {})
  assert.equal(array.values.trustedProxies, '10.0.0.1,10.0.0.2')
  assert.equal(array.sources.trustedProxies, 'row')
  assert.equal(resolveConfig({ trustedProxies: '10.0.0.1, 10.0.0.2' }, {}, {}).values.trustedProxies, '10.0.0.1, 10.0.0.2', 'strings pass through verbatim')
  assert.equal(resolveConfig({ trustedProxies: [1, 'x'] }, {}, {}).values.trustedProxies, '', 'a mixed array is not a proxy list')
  assert.equal(resolveConfig({ trustedProxies: ['a'] }, { trustedProxies: 'b' }, {}).values.trustedProxies, 'a', 'row still beats file after normalization')
  assert.equal(resolveConfig({}, {}, { LAN_GATE_TRUSTED_PROXIES: 'c' }).values.trustedProxies, 'c')
})

test('serverName: default strips .local, over-long values are truncated, blank is unset', async () => {
  const { resolveConfig } = await load()
  const fallback = resolveConfig({}, {}, {})
  assert.equal(fallback.values.serverName, os.hostname().replace(/\.local$/u, '').slice(0, 40))
  assert.equal(fallback.sources.serverName, 'default')
  assert.ok(!fallback.values.serverName.endsWith('.local'), 'the default never carries the .local suffix')

  const long = resolveConfig({ serverName: 'x'.repeat(50) }, {}, {})
  assert.equal(long.values.serverName, 'x'.repeat(40))
  assert.equal(long.sources.serverName, 'row')

  assert.equal(resolveConfig({ serverName: '' }, {}, {}).values.serverName, fallback.values.serverName, 'blank means unset')
  assert.equal(resolveConfig({ serverName: 'box.local' }, {}, {}).values.serverName, 'box.local', 'provided names are kept verbatim')
})

test('targetPort is undefined unless env or the row supplies a legal port — never the file', async () => {
  const { resolveConfig } = await load()
  assert.equal(resolveConfig({}, {}, {}).values.targetPort, undefined)
  assert.equal(resolveConfig({}, {}, {}).sources.targetPort, 'default')
  assert.equal(resolveConfig({ targetPort: 3080 }, {}, {}).values.targetPort, 3080)
  assert.equal(resolveConfig({}, {}, { LAN_GATE_TARGET_PORT: '4000' }).values.targetPort, 4000)
  assert.equal(resolveConfig({ targetPort: 70000 }, {}, {}).values.targetPort, undefined, 'out of band means unset, not clamped')
  // T12-fix: the file layer is deliberately out of the targetPort path. A
  // "targetPort" written for an old setup would forward the gateway to the
  // wrong port once the host's Web UI port changes (desktop builds pick
  // their own); falling to default keeps the host-port discovery alive.
  const viaFile = resolveConfig({}, { targetPort: 3080 }, {})
  assert.equal(viaFile.values.targetPort, undefined)
  assert.equal(viaFile.sources.targetPort, 'default')
})

test('volatile row fields are unwrapped from the loader references before validation', async () => {
  const { resolveConfig, Config } = await load()
  // Config's output is EXACTLY what the loader hands apply(): since T17 every
  // field is volatile, so every field arrives as a { get() } reference.
  const row = Config({ serverName: 'MyBox', idleHours: 12, autoShareNewSessions: true, port: 4000 })
  const resolved = resolveConfig(row, {}, {})
  assert.equal(resolved.values.serverName, 'MyBox')
  assert.equal(resolved.sources.serverName, 'row')
  assert.equal(resolved.values.idleHours, 12)
  assert.equal(resolved.sources.idleHours, 'row')
  assert.equal(resolved.values.autoShareNewSessions, true)
  assert.equal(resolved.values.port, 4000, 'the row port unwraps through the same reference path')

  // The references are live: a changed get() must change the next resolution
  // — that is the whole point of volatile (edit without restarting the row).
  const updated = resolveConfig({ ...row, serverName: { get: () => 'Reboxed' } }, {}, {})
  assert.equal(updated.values.serverName, 'Reboxed')
  assert.equal(updated.sources.serverName, 'row')
})

test('the file layer accepts digit-string numbers and array pushEvents; the row layer stays strict', async () => {
  const { resolveConfig } = await load()
  // Hand-edited files historically wrote numbers as strings and the old
  // Number() read path accepted them — the fallback contract says they keep
  // working, but only at the file layer.
  const lenient = resolveConfig({}, { port: '4002', rateLimit: '30', pushDebounceMs: '0', pushEvents: ['a/b', 'c/d'] }, {})
  assert.equal(lenient.values.port, 4002)
  assert.equal(lenient.sources.port, 'file')
  assert.equal(lenient.values.rateLimit, 30)
  assert.equal(lenient.values.pushDebounceMs, 0, '"0" is a legal zero debounce, not off-by-parse')
  assert.equal(lenient.values.pushEvents, 'a/b,c/d')

  assert.equal(resolveConfig({}, { port: '-5' }, {}).values.port, 3088, 'a sign is not a digit string')
  assert.equal(resolveConfig({}, { port: '4000.5' }, {}).values.port, 3088, 'decimals stay illegal')
  assert.equal(resolveConfig({}, { pushDebounceMs: '-1' }, {}).values.pushDebounceMs, 15000)
  assert.equal(resolveConfig({}, { pushEvents: [1, 'x'] }, {}).values.pushEvents, 'agent/turn-stopping', 'a mixed array is not an event list')

  // The row layer gets NO such leniency: its values come through the loader,
  // where a wrong type is an editing mistake.
  assert.equal(resolveConfig({ port: '4000' }, {}, {}).values.port, 3088)
  assert.equal(resolveConfig({ pushEvents: ['a/b'] }, {}, {}).values.pushEvents, 'agent/turn-stopping')
})

test('Config stays permissive: junk-typed row fields parse through for resolveConfig to judge', async () => {
  const { Config, resolveConfig } = await load()
  // Any of these used to make the LOADER reject the whole row (plugin dead);
  // every one must now parse and land on the value the resolver decides.
  const junkRows = [{ port: 'abc' }, { lang: 'zh-CN' }, { pushSummary: 1 }, { role: 'Client' }]
  for (const junk of junkRows) {
    let parsed
    assert.doesNotThrow(() => { parsed = Config(junk) }, `Config(${JSON.stringify(junk)}) must not throw`)
    const r = resolveConfig(parsed, {}, {})
    if ('port' in junk) assert.equal(r.values.port, 3088, 'an illegal row port falls to default')
    if ('lang' in junk) assert.equal(r.values.lang, 'auto', 'an off-enum lang falls to default')
    if ('pushSummary' in junk) assert.equal(r.values.pushSummary, true, 'numeric 1 stays a legal row-level true')
    if ('role' in junk) assert.equal(r.values.role, 'host', 'a botched role degrades to host, not a dead plugin')
  }
  // Still no schema defaults leaking into an empty row.
  const empty = JSON.stringify(Config({}))
  assert.ok(!empty.includes('3088') && !empty.includes('48') && !empty.includes('15000'))
})

// --- readFileConfig --------------------------------------------------------

test('readFileConfig: missing file, bad JSON, null and array roots all yield {}', async () => {
  const { readFileConfig } = await load()
  await withTempHome(async (env) => {
    assert.deepEqual(readFileConfig(env), {}, 'no file at all')
    fs.writeFileSync(path.join(env.DSH_HOME, 'lan-gate.config.json'), '{not json')
    assert.deepEqual(readFileConfig(env), {}, 'unparsable JSON')
    fs.writeFileSync(path.join(env.DSH_HOME, 'lan-gate.config.json'), 'null')
    assert.deepEqual(readFileConfig(env), {}, 'a null root is not an object')
    fs.writeFileSync(path.join(env.DSH_HOME, 'lan-gate.config.json'), '[1,2]')
    assert.deepEqual(readFileConfig(env), {}, 'an array root is not a config object')
    fs.writeFileSync(path.join(env.DSH_HOME, 'lan-gate.config.json'), '{"port":4002}')
    assert.deepEqual(readFileConfig(env), { port: 4002 })
  })
})

// --- the loader schema -----------------------------------------------------

test('Config parses a fully populated row and leaves an empty row free of defaults', async () => {
  const { Config } = await load()
  const full = {
    role: 'client', port: 4000, host: '0.0.0.0', targetPort: 3080, rateLimit: 60,
    trustedProxies: ['10.0.0.1'], vapidSubject: 'mailto:x@y.z', lang: 'zh',
    pushEvents: 'a/b', pushDebounceMs: 1000, pushSummary: true, pushTurnEnd: true, pushTool: false,
    serverName: 'phone', idleHours: 24, autoShareNewSessions: true,
    serverUrl: 'https://gw.example', deviceToken: 'tok',
    turnFoldDesktop: true, keyboardLiftRatio: 0.5, keyboardLiftMaxPx: 300, keyboardSafetyPadPx: 10, maxUploadBytes: 1024,
  }
  const parsed = Config(full)
  // EVERY field is volatile (T17): each arrives as a live reference, stored
  // value behind get().
  assert.equal(parsed.role.get(), 'client')
  assert.equal(parsed.port.get(), 4000)
  assert.deepEqual(parsed.trustedProxies.get(), ['10.0.0.1'])
  assert.equal(parsed.maxUploadBytes.get(), 1024)
  assert.equal(parsed.deviceToken.get(), 'tok')

  const empty = Config({})
  const json = JSON.stringify(empty)
  assert.ok(!json.includes('3088'), 'no default port may leak into a parsed empty row')
  assert.ok(!json.includes('48'), 'no default idleHours may leak')
  assert.ok(!json.includes('15000'), 'no default debounce may leak')
  // Every field materializes as a live reference object whose get() answers
  // undefined — present in shape, unset in value.
  for (const [name, schema] of Object.entries(Config.dict)) {
    const value = empty[name]
    assert.ok(
      value !== null && typeof value === 'object' && typeof value.get === 'function',
      `${name} must materialize as a live reference on an empty row`,
    )
    assert.equal(value.get(), undefined, `${name} stays unset on an empty row`)
    // Schemastery schema nodes are callable (typeof 'function') but carry
    // their meta as properties — that access is what the marker test needs.
    assert.ok(schema !== null && typeof schema.meta === 'object', `${name} exposes its meta`)
  }
})

// --- T17: all-volatile schema ----------------------------------------------

test('every Config field carries the volatile marker; deviceToken keeps its secret role', async () => {
  const { Config, DEFAULTS } = await load()
  // The settings surface exists ONLY for volatile fields (dsh-settings'
  // volatileForm drops the rest), so a single non-volatile field would go
  // dark in the settings page — assert the whole dict.
  const expected = [...Object.keys(DEFAULTS), 'serverUrl', 'deviceToken', 'turnFoldDesktop', 'keyboardLiftRatio', 'keyboardLiftMaxPx', 'keyboardSafetyPadPx', 'maxUploadBytes']
  assert.deepEqual(Object.keys(Config.dict).sort(), expected.sort(), 'the schema declares exactly the known fields')
  for (const [name, schema] of Object.entries(Config.dict)) {
    assert.equal(schema.meta?.volatile, true, `Config.${name} must be volatile`)
  }
  assert.equal(Config.dict.deviceToken.meta.role, 'secret', 'the pairing token stays redacted from every wire surface')
})

test('a fully populated Config row resolves with EVERY source = row (T17)', async () => {
  const { Config, resolveConfig, DEFAULTS } = await load()
  const full = {
    role: 'client', port: 4000, host: '0.0.0.0', targetPort: 3080, rateLimit: 60,
    trustedProxies: ['10.0.0.1'], vapidSubject: 'mailto:x@y.z', lang: 'zh',
    pushEvents: 'a/b', pushDebounceMs: 1000, pushSummary: true, pushTurnEnd: true, pushTool: false,
    serverName: 'phone', idleHours: 24, autoShareNewSessions: true,
    serverUrl: 'https://gw.example', deviceToken: 'tok',
    turnFoldDesktop: true, keyboardLiftRatio: 0.5, keyboardLiftMaxPx: 300, keyboardSafetyPadPx: 10, maxUploadBytes: 1024,
  }
  const resolved = resolveConfig(Config(full), {}, {})
  for (const key of Object.keys(DEFAULTS)) {
    assert.equal(resolved.sources[key], 'row', `${key} must come from the row layer`)
  }
  // Spot-check the unwrapped values ride through.
  assert.equal(resolved.values.role, 'client')
  assert.equal(resolved.values.port, 4000)
  assert.equal(resolved.values.trustedProxies, '10.0.0.1')
  assert.equal(resolved.values.pushSummary, true)
  assert.equal(resolved.values.serverName, 'phone')
})
