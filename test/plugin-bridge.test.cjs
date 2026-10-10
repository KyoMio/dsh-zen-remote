/* dsh-zen-remote · plugin bridge registration & comparison (PB-1)
 *
 * Drives the BUILT lib/plugin-bridge.js (the lib-driving convention: src/
 * relative specifiers are what the tests must never have to map), covering
 * the three pure pieces the later bridge tasks stand on:
 *   - normalizeDeclaration: every validation rule (one rejection case each,
 *     per the task's rule list), the normalization defaults, route-order
 *     transparency of the digest, and digest sensitivity to every field.
 *   - createBridgeRegistry: the overwrite warn, the stale-dispose no-op, the
 *     live dispose, onChange counts, list() ordering.
 *   - compareBridges: one case per BridgeReason plus the consent nuance
 *     (session-only routes bridge without consent; an ABSENT consent field
 *     reads as not consented).
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalizeDeclaration, createBridgeRegistry, compareBridges } = require('../lib/plugin-bridge.js')

/** One legal declaration everything else is patched from. */
const DECL = {
  plugin: 'task-panel',
  version: '1.2.3',
  routes: [
    { path: '/panel/tasks', scope: 'session' },
    { path: '/panel/teams', scope: 'server' },
  ],
}

const DIGEST_PATTERN = /^[0-9a-f]{16}$/

// --- normalizeDeclaration: rejections ----------------------------------------

test('normalizeDeclaration rejects a declaration that is not a plain object', () => {
  for (const bad of [null, undefined, 42, 'x', [], true]) {
    assert.throws(() => normalizeDeclaration(bad), /declaration/, `input ${JSON.stringify(bad)} must be refused`)
  }
})

test('normalizeDeclaration rejects unknown top-level fields (typo guard)', () => {
  assert.throws(() => normalizeDeclaration({ ...DECL, plugun: 'oops' }), /plugun/)
})

test('normalizeDeclaration rejects an illegal plugin name', () => {
  for (const [bad, why] of [
    [undefined, 'missing'],
    ['', 'empty'],
    ['Task-Panel', 'uppercase'],
    ['has space', 'space'],
    ['a/b/c', 'stray slash'],
    ['-leading', 'leading dash'],
    ['.leading', 'leading dot'],
    ['@scope/', 'empty name half'],
    ['a'.repeat(215), 'over the 214 cap'],
  ]) {
    assert.throws(() => normalizeDeclaration({ ...DECL, plugin: bad }), /plugin/, `plugin ${why} must be refused`)
  }
})

test('normalizeDeclaration accepts npm-shaped names, scoped included', () => {
  for (const name of ['task-panel', 'task.panel', 'task_panel2', '@acme/panel-bridge', '@scope.un/sub_name']) {
    const normalized = normalizeDeclaration({ ...DECL, plugin: name })
    assert.equal(normalized.plugin, name)
  }
})

test('normalizeDeclaration rejects a missing, non-string or empty version', () => {
  for (const bad of [undefined, 123, '', '   ']) {
    assert.throws(() => normalizeDeclaration({ ...DECL, version: bad }), /version/)
  }
})

test('normalizeDeclaration rejects missing, empty and over-long route lists', () => {
  for (const bad of [undefined, 'x', {}, [], Array.from({ length: 65 }, (_, i) => ({ path: `/r${i}`, scope: 'session' }))]) {
    assert.throws(() => normalizeDeclaration({ ...DECL, routes: bad }), /routes/)
  }
  // The cap itself is legal.
  const full = normalizeDeclaration({
    ...DECL,
    routes: Array.from({ length: 64 }, (_, i) => ({ path: `/r${i}`, scope: 'session' })),
  })
  assert.equal(full.routes.length, 64)
})

test('normalizeDeclaration rejects route paths that are not plain, host-unowned absolute paths', () => {
  const cases = [
    ['tasks', 'no leading slash'],
    ['/panel?x=1', 'query mark'],
    ['/panel#top', 'fragment'],
    ['/panel/../admin', 'dot segment'],
    ['/panel tasks', 'whitespace'],
    ['/_dsh/zen-remote/relay', 'the plugin prefix'],
    ['/api/session.list', 'the host /api prefix'],
    ['/apifoo', 'the literal /api string prefix'],
    ['', 'empty'],
  ]
  for (const [bad, why] of cases) {
    assert.throws(
      () => normalizeDeclaration({ ...DECL, routes: [{ path: bad, scope: 'session' }] }),
      /path/,
      `path ${why} must be refused`,
    )
  }
  // Case-sensitive: the host prefix is lowercase /api, not /API.
  assert.doesNotThrow(() => normalizeDeclaration({ ...DECL, routes: [{ path: '/API/x', scope: 'session' }] }))
})

test('normalizeDeclaration rejects a scope that is not exactly session or server', () => {
  for (const bad of [undefined, 'Session', 'global', 'server-scope', 1]) {
    assert.throws(
      () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: bad }] }),
      /scope/,
      `scope ${JSON.stringify(bad)} must be refused`,
    )
  }
})

test('normalizeDeclaration rejects an illegal sessionParam and a non-boolean stream', () => {
  for (const bad of ['1abc', 'a-b', 'x'.repeat(65), '', 42, null]) {
    assert.throws(
      () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', sessionParam: bad }] }),
      /sessionParam/,
      `sessionParam ${JSON.stringify(bad)} must be refused`,
    )
  }
  for (const bad of ['true', 1, 0, null]) {
    assert.throws(
      () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', stream: bad }] }),
      /stream/,
      `stream ${JSON.stringify(bad)} must be refused`,
    )
  }
})

test('normalizeDeclaration rejects duplicate paths, non-object routes and unknown route fields', () => {
  assert.throws(
    () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session' }, { path: '/x', scope: 'server' }] }),
    /duplicate/,
  )
  for (const bad of ['x', null, 42, []]) {
    assert.throws(() => normalizeDeclaration({ ...DECL, routes: [bad] }), /routes\[0\]/)
  }
  assert.throws(
    () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', streams: true }] }),
    /streams/,
  )
})

// --- normalizeDeclaration: the normalized shape -------------------------------

test('normalizeDeclaration fills the defaults and normalizes the shape', () => {
  const normalized = normalizeDeclaration({
    plugin: '@acme/panel-bridge',
    version: '0.9.0',
    routes: [{ path: '/panel/zebra', scope: 'session', stream: true }, { path: '/panel/alpaca', scope: 'server', sessionParam: 'sid' }],
  })
  assert.deepEqual(normalized.routes, [
    { path: '/panel/alpaca', scope: 'server', sessionParam: 'sid', stream: false },
    { path: '/panel/zebra', scope: 'session', sessionParam: 'sessionId', stream: true },
  ])
  assert.match(normalized.digest, DIGEST_PATTERN)
})

test('the digest ignores route order and changes with any field value', () => {
  const a = normalizeDeclaration({
    plugin: 'p',
    version: '1',
    routes: [
      { path: '/one', scope: 'session' },
      { path: '/two', scope: 'server' },
    ],
  })
  const reordered = normalizeDeclaration({
    plugin: 'p',
    version: '1',
    routes: [
      { path: '/two', scope: 'server' },
      { path: '/one', scope: 'session' },
    ],
  })
  assert.equal(reordered.digest, a.digest, 'route order is not part of the digest')

  const variants = {
    plugin: { ...DECL, plugin: 'other-plugin' },
    version: { ...DECL, version: '1.2.4' },
    scope: { ...DECL, routes: [{ path: '/panel/tasks', scope: 'server' }, { path: '/panel/teams', scope: 'server' }] },
    stream: { ...DECL, routes: [{ path: '/panel/tasks', scope: 'session', stream: true }, { path: '/panel/teams', scope: 'server' }] },
    sessionParam: { ...DECL, routes: [{ path: '/panel/tasks', scope: 'session', sessionParam: 'sid' }, { path: '/panel/teams', scope: 'server' }] },
    path: { ...DECL, routes: [{ path: '/panel/other', scope: 'session' }, { path: '/panel/teams', scope: 'server' }] },
  }
  const base = normalizeDeclaration(DECL).digest
  for (const [what, variant] of Object.entries(variants)) {
    assert.notEqual(normalizeDeclaration(variant).digest, base, `changing ${what} must change the digest`)
  }
  assert.notEqual(normalizeDeclaration(variants.plugin).digest, normalizeDeclaration({ ...variants.plugin, version: '9' }).digest)
})

// --- createBridgeRegistry ------------------------------------------------------

function registryWithWarnings() {
  const warnings = []
  const registry = createBridgeRegistry({ warn: (message) => warnings.push(message) })
  return { registry, warnings }
}

test('the registry registers, gets and lists sorted; an illegal declaration throws through and never registers', () => {
  const { registry } = registryWithWarnings()
  assert.deepEqual(registry.list(), [])
  assert.equal(registry.get('nope'), undefined)

  const disposeB = registry.register({ ...DECL, plugin: 'b-plugin' })
  const disposeA = registry.register({ ...DECL, plugin: 'a-plugin' })
  assert.equal(typeof disposeB, 'function')
  assert.deepEqual(registry.list().map((d) => d.plugin), ['a-plugin', 'b-plugin'], 'list() is sorted by plugin')
  assert.equal(registry.get('b-plugin').version, '1.2.3')

  assert.throws(() => registry.register({ ...DECL, plugin: 'UPPER' }), /plugin/, 'the normalize error passes through')
  assert.equal(registry.get('UPPER'), undefined, 'nothing was registered for the rejected declaration')
  assert.deepEqual(registry.list().map((d) => d.plugin), ['a-plugin', 'b-plugin'], 'the rejection changed nothing')

  disposeA()
  disposeB()
  assert.deepEqual(registry.list(), [])
})

test('a same-plugin registration replaces the earlier one, warns once, and the STALE dispose is a no-op', () => {
  const { registry, warnings } = registryWithWarnings()
  const changes = []
  const off = registry.onChange(() => changes.push('change'))

  const stale = registry.register({ ...DECL, version: '1.0.0' })
  const fresh = registry.register({ ...DECL, version: '2.0.0' })
  assert.equal(registry.get('task-panel').version, '2.0.0', 'the newer declaration is live')
  assert.deepEqual(warnings, ['plugin "task-panel" re-registered its bridge declaration; the earlier one was replaced'])

  // Each successful register fired onChange once (2 so far).
  assert.equal(changes.length, 2, 'register fired onChange on both registrations')

  stale() // must NOT remove the replacement
  assert.equal(registry.get('task-panel').version, '2.0.0', 'the stale dispose removed nothing')
  assert.equal(changes.length, 2, 'and fired no onChange')

  fresh()
  assert.equal(registry.get('task-panel'), undefined, 'the live dispose removed its own registration')
  assert.equal(changes.length, 3, 'and fired onChange once')
  off()
})

test('disposing is idempotent and per-plugin; onChange unsubscribe works; a throwing listener never breaks register', () => {
  const { registry, warnings } = registryWithWarnings()
  const changes = []
  const off = registry.onChange(() => changes.push(1))
  const dispose = registry.register(DECL)
  assert.equal(changes.length, 1, 'register fired onChange once')
  dispose()
  dispose() // second call: silent no-op
  assert.equal(changes.length, 2, 'dispose fired onChange exactly once — the repeat fired nothing')

  const d1 = registry.register({ ...DECL, plugin: 'one' })
  const d2 = registry.register({ ...DECL, plugin: 'two' })
  d1()
  assert.deepEqual(registry.list().map((d) => d.plugin), ['two'], 'each dispose removes only its own plugin')
  d2()
  off()

  registry.onChange(() => { throw new Error('observer boom') })
  assert.doesNotThrow(() => registry.register(DECL), 'a throwing listener must not fail the register')
  assert.match(warnings[0], /observer boom/)
  assert.equal(registry.get('task-panel')?.plugin, 'task-panel', 'the failing observer did not stop the registration')
  const d = registry.register(DECL)
  assert.doesNotThrow(d, 'nor the removal')
})

// --- compareBridges -------------------------------------------------------------

/** A server table entry matching DECL exactly (its digest computed for real). */
function matchingEntry(overrides = {}) {
  return { version: DECL.version, digest: normalizeDeclaration(DECL).digest, serverScopeConsent: true, ...overrides }
}

test('compareBridges: offline wins over everything, and no serverVersion is reported', () => {
  const local = [normalizeDeclaration(DECL)]
  const statuses = compareBridges(local, { 'task-panel': matchingEntry() }, false)
  assert.deepEqual(statuses, [{ plugin: 'task-panel', bridged: false, reason: 'offline', localVersion: '1.2.3' }])
  assert.equal(statuses[0].serverVersion, undefined)
  // Even a server that predates everything stays "offline" while offline.
  assert.deepEqual(compareBridges(local, undefined, false)[0].reason, 'offline')
})

test('compareBridges: an undefined server table means a server too old for plugins', () => {
  const statuses = compareBridges([normalizeDeclaration(DECL)], undefined, true)
  assert.deepEqual(statuses, [{ plugin: 'task-panel', bridged: false, reason: 'server-too-old', localVersion: '1.2.3' }])
})

test('compareBridges: a plugin the server never heard of is not-on-server', () => {
  const statuses = compareBridges([normalizeDeclaration(DECL)], {}, true)
  assert.equal(statuses[0].reason, 'not-on-server')
  assert.equal(statuses[0].serverVersion, undefined)
})

test('compareBridges: a version difference is version-mismatch, with the server version reported', () => {
  const statuses = compareBridges([normalizeDeclaration(DECL)], { 'task-panel': matchingEntry({ version: '9.9.9' }) }, true)
  assert.deepEqual(statuses, [{
    plugin: 'task-panel', bridged: false, reason: 'version-mismatch', localVersion: '1.2.3', serverVersion: '9.9.9',
  }])
})

test('compareBridges: same version, different declaration is declaration-mismatch', () => {
  const local = normalizeDeclaration({ ...DECL, routes: [{ path: '/panel/tasks', scope: 'session' }, { path: '/panel/elsewhere', scope: 'server' }] })
  const statuses = compareBridges([local], { 'task-panel': matchingEntry() }, true)
  assert.equal(statuses[0].reason, 'declaration-mismatch')
  assert.equal(statuses[0].serverVersion, DECL.version, 'version agreed, so it rides along')
})

test('compareBridges: a server-scope route without consent stays home; absent consent reads as NO', () => {
  const local = normalizeDeclaration(DECL) // carries one scope:'server' route
  for (const consent of [false, undefined]) {
    const entry = matchingEntry()
    if (consent === undefined) delete entry.serverScopeConsent
    else entry.serverScopeConsent = consent
    const statuses = compareBridges([local], { 'task-panel': entry }, true)
    assert.equal(statuses[0].reason, 'consent-off', `serverScopeConsent ${JSON.stringify(consent)} means not consented`)
    assert.equal(statuses[0].bridged, false)
  }
})

test('compareBridges: session-only routes bridge WITHOUT consent; everything matching bridges', () => {
  const sessionOnly = normalizeDeclaration({ plugin: 'task-panel', version: '1.2.3', routes: [{ path: '/panel/tasks', scope: 'session' }] })
  const bridged = compareBridges([sessionOnly], { 'task-panel': matchingEntry({ digest: sessionOnly.digest, serverScopeConsent: false }) }, true)
  assert.deepEqual(bridged, [{
    plugin: 'task-panel', bridged: true, localVersion: '1.2.3', serverVersion: '1.2.3',
  }])
  assert.equal(bridged[0].reason, undefined, 'a bridged plugin carries no reason')

  const full = compareBridges([normalizeDeclaration(DECL)], { 'task-panel': matchingEntry() }, true)
  assert.equal(full[0].bridged, true)
  assert.equal(full[0].serverVersion, '1.2.3')
})

test('compareBridges: one status per local declaration, in order, each judged on its own', () => {
  const local = [
    normalizeDeclaration({ plugin: 'a-bridged', version: '1', routes: [{ path: '/a', scope: 'session' }] }),
    normalizeDeclaration({ plugin: 'b-stale', version: '1', routes: [{ path: '/b', scope: 'session' }] }),
    normalizeDeclaration({ plugin: 'c-unknown', version: '1', routes: [{ path: '/c', scope: 'session' }] }),
  ]
  const server = {
    'a-bridged': matchingEntry({ version: '1', digest: local[0].digest }),
    'b-stale': matchingEntry({ version: '0', digest: local[1].digest }),
  }
  const statuses = compareBridges(local, server, true)
  assert.deepEqual(
    statuses.map((s) => [s.plugin, s.reason ?? 'bridged']),
    [['a-bridged', 'bridged'], ['b-stale', 'version-mismatch'], ['c-unknown', 'not-on-server']],
  )
})
