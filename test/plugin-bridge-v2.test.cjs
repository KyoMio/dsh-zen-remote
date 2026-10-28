/* dsh-zen-remote · plugin bridge declaration-v2 (PB-20)
 *
 * Covers the four new optional route fields (`locator`, `prefix`, `deny`,
 * `rewriteIds`) and the maxBody ceiling's alignment with the upload limit,
 * per the task's acceptance list:
 *   1. digest compatibility pins — 2.1-era, 2.2-era and v2 declarations
 *      hash EXACTLY as hand-written canonical JSON strings say (the strings
 *      are typed out below on purpose: if the implementation ever changes
 *      its key order or its explicit-only rule, these hashes stop matching).
 *   2. each new field: legal shapes pass, illegal shapes are refused with
 *      the field name in the message.
 *   3. the combination conflicts: locator+sessionParam, path-segment
 *      without prefix, upgrade+prefix, rewriteIds+stream.
 *   4. explicit-vs-omitted digest difference for each of the four fields.
 *   5. the maxBody boundary at the aligned 500 MiB ceiling.
 *
 * Drives the BUILT lib/plugin-bridge.js (the lib-driving convention).
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const {
  normalizeDeclaration,
  routeLocatorOf,
  routePrefixOf,
  routeDeniesRemoteOf,
  routeRewritesIdsOf,
  routeRewriteFieldsOf,
  routeMaxBodyOf,
  MAX_ROUTE_BODY_BYTES,
} = require('../lib/plugin-bridge.js')
const { MAX_UPLOAD_BYTES } = require('../lib/upload-limits.js')

const DECL = { plugin: 'task-panel', version: '1.2.3', routes: [{ path: '/panel/tasks', scope: 'session' }] }

// --- acceptance 1: the digest compatibility pins ------------------------------

/** sha256 over a hand-written canonical string, first 16 hex chars — the
 * exact derivation the implementation performs, spelled out here so the
 * canonical FORM (key order, explicit-only membership) is pinned by the
 * test, not produced by it. */
function digestOfCanonical(canonical) {
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

test('a 2.1-era declaration hashes EXACTLY as its hand-written canonical JSON says', () => {
  const legacy = {
    plugin: 'task-panel',
    version: '1.2.3',
    routes: [
      { path: '/panel/tasks', scope: 'session' },
      { path: '/panel/teams', scope: 'server' },
    ],
  }
  // Hand-written from the documented canonical form: {plugin, version,
  // routes[{path, scope, sessionParam, stream}]} — the four PB-1 keys
  // always present, defaults filled (sessionId / false), nothing else.
  // Its digest also equals the PB-1 pin the older test file carries.
  const canonical =
    '{"plugin":"task-panel","version":"1.2.3","routes":[' +
    '{"path":"/panel/tasks","scope":"session","sessionParam":"sessionId","stream":false},' +
    '{"path":"/panel/teams","scope":"server","sessionParam":"sessionId","stream":false}]}'
  const expected = digestOfCanonical(canonical)
  assert.equal(expected, 'dc490b9ea6eed005', 'the hand-written string agrees with the PB-1 pin')
  assert.equal(normalizeDeclaration(legacy).digest, expected)
})

test('a 2.2-era declaration (methods/maxBody/upgrade) hashes EXACTLY as its hand-written canonical JSON says', () => {
  const era22 = {
    plugin: 'side-panel',
    version: '2.0.0',
    routes: [
      { path: '/side/notes', scope: 'session', methods: ['GET', 'POST'], maxBody: 2097152 },
      { path: '/side/ws', scope: 'session', upgrade: true },
    ],
  }
  // methods sorted, explicit fields appended after the four always-present
  // keys in PB-9/PB-10 order; the v2 fields are ABSENT — they must not
  // appear for an old declaration.
  const canonical =
    '{"plugin":"side-panel","version":"2.0.0","routes":[' +
    '{"path":"/side/notes","scope":"session","sessionParam":"sessionId","stream":false,"methods":["GET","POST"],"maxBody":2097152},' +
    '{"path":"/side/ws","scope":"session","sessionParam":"sessionId","stream":false,"upgrade":true}]}'
  assert.equal(normalizeDeclaration(era22).digest, digestOfCanonical(canonical))
})

test('a v2 declaration (all four new fields explicit) hashes EXACTLY as its hand-written canonical JSON says', () => {
  const v2 = {
    plugin: 'notes-bridge',
    version: '3.0.0',
    routes: [
      { path: '/notes/body', scope: 'server', deny: true, rewriteIds: true, locator: { in: 'json-body', fields: ['sessionId'] } },
      { path: '/notes/seg', scope: 'session', prefix: true, locator: { in: 'path-segment', index: 0 } },
    ],
  }
  // The v2 fields append after upgrade, in locator → prefix → deny →
  // rewriteIds order; the locator serializes with its own key order
  // (in → name / index / fields). Routes sorted by path.
  const canonical =
    '{"plugin":"notes-bridge","version":"3.0.0","routes":[' +
    '{"path":"/notes/body","scope":"server","sessionParam":"sessionId","stream":false,"locator":{"in":"json-body","fields":["sessionId"]},"deny":true,"rewriteIds":true},' +
    '{"path":"/notes/seg","scope":"session","sessionParam":"sessionId","stream":false,"locator":{"in":"path-segment","index":0},"prefix":true}]}'
  assert.equal(normalizeDeclaration(v2).digest, digestOfCanonical(canonical))
})

// --- acceptance 2: each field's legal and illegal shapes ----------------------

test('locator accepts its three shapes and stores them verbatim', () => {
  const shapes = [
    { in: 'query', name: 'sid' },
    { in: 'path-segment', index: 0 },
    { in: 'json-body', fields: ['sessionId', 'teamId'] },
  ]
  for (const locator of shapes) {
    const normalized = normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', prefix: true, locator }] })
    assert.deepEqual(normalized.routes[0].locator, locator)
    assert.deepEqual(routeLocatorOf(normalized.routes[0]), locator)
  }
})

test('locator rejects illegal shapes, naming the field', () => {
  const cases = [
    ['not an object', 'x'],
    ['not an object', 42],
    ['unknown in', { in: 'header', name: 'sid' }],
    ['in missing', { name: 'sid' }],
    ['query without a name', { in: 'query' }],
    ['query with an illegal name', { in: 'query', name: '1abc' }],
    ['query with a non-string name', { in: 'query', name: 7 }],
    ['path-segment without an index', { in: 'path-segment' }],
    ['path-segment with a negative index', { in: 'path-segment', index: -1 }],
    ['path-segment with a fractional index', { in: 'path-segment', index: 1.5 }],
    ['json-body without fields', { in: 'json-body' }],
    ['json-body with empty fields', { in: 'json-body', fields: [] }],
    ['json-body with a non-string field', { in: 'json-body', fields: ['ok', 3] }],
    ['json-body with an empty-string field', { in: 'json-body', fields: [''] }],
  ]
  for (const [why, locator] of cases) {
    assert.throws(
      () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', locator }] }),
      /locator/,
      `locator: ${why} must be refused`,
    )
  }
})

test('prefix, deny and rewriteIds accept only true, and refuse anything else, naming the field', () => {
  const fields = ['prefix', 'deny', 'rewriteIds']
  for (const field of fields) {
    const ok = normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', [field]: true }] })
    assert.equal(ok.routes[0][field], true, `${field}: true is kept`)
    for (const bad of [false, 'yes', 1, null]) {
      assert.throws(
        () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', [field]: bad }] }),
        new RegExp(field),
        `${field}: ${JSON.stringify(bad)} must be refused`,
      )
    }
  }
})

test('the typo guard still fires on misspelled new fields', () => {
  assert.throws(() => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', locater: { in: 'query', name: 'sid' } }] }), /locater/)
  assert.throws(() => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', prefixes: true }] }), /prefixes/)
  assert.throws(() => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', rewrite: true }] }), /rewrite/)
})

// --- acceptance 3: the combination conflicts ----------------------------------

test('locator and sessionParam cannot coexist', () => {
  assert.throws(
    () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', sessionParam: 'sid', locator: { in: 'query', name: 'sid' } }] }),
    /locator.*sessionParam|sessionParam.*locator/,
  )
})

test('a path-segment locator requires prefix: true', () => {
  assert.throws(
    () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', locator: { in: 'path-segment', index: 0 } }] }),
    /locator.*prefix|prefix.*locator/,
  )
  // And with it, the shape is legal.
  const ok = normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', prefix: true, locator: { in: 'path-segment', index: 0 } }] })
  assert.equal(routePrefixOf(ok.routes[0]), true)
})

test('prefix and upgrade cannot combine — refused until a need shows up', () => {
  assert.throws(
    () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', upgrade: true, prefix: true }] }),
    /left for when a need shows up/,
  )
})

test('rewriteIds cannot ride a stream route', () => {
  assert.throws(
    () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', stream: true, rewriteIds: true }] }),
    /rewriteIds.*stream|stream.*rewriteIds/,
  )
  // A stream route WITHOUT rewriteIds stays legal, as before.
  assert.doesNotThrow(() => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', stream: true }] }))
})

// --- acceptance 4: explicit vs omitted moves the digest, per field ------------

test('each v2 field, when explicit, changes the digest — and locator differs from its sessionParam twin', () => {
  const base = normalizeDeclaration(DECL).digest
  const variants = {
    locator: { ...DECL, routes: [{ path: '/panel/tasks', scope: 'session', locator: { in: 'query', name: 'sessionId' } }] },
    prefix: { ...DECL, routes: [{ path: '/panel/tasks', scope: 'session', prefix: true }] },
    deny: { ...DECL, routes: [{ path: '/panel/tasks', scope: 'session', deny: true }] },
    rewriteIds: { ...DECL, routes: [{ path: '/panel/tasks', scope: 'session', rewriteIds: true }] },
  }
  for (const [what, variant] of Object.entries(variants)) {
    assert.notEqual(normalizeDeclaration(variant).digest, base, `an explicit ${what} must enter the digest`)
  }
  // The locator twin: an explicit query locator naming the default param
  // reads IDENTICALLY through the accessor but hashes DIFFERENTLY from the
  // omitted form — explicitness itself is what the two ends compare.
  const twin = normalizeDeclaration({ ...DECL, routes: [{ path: '/panel/tasks', scope: 'session', sessionParam: 'sessionId' }] })
  assert.deepEqual(routeLocatorOf(normalizeDeclaration(variants.locator).routes[0]), routeLocatorOf(twin.routes[0]))
  assert.notEqual(normalizeDeclaration(variants.locator).digest, twin.digest)
})

// --- acceptance 5: the maxBody boundary at the aligned ceiling -----------------

test('MAX_ROUTE_BODY_BYTES is the upload limit, re-exported under the bridge name', () => {
  assert.equal(MAX_ROUTE_BODY_BYTES, MAX_UPLOAD_BYTES)
  assert.equal(MAX_ROUTE_BODY_BYTES, 524288000)
})

test('maxBody admits just under and exactly at the ceiling, refuses one byte over', () => {
  const under = normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', maxBody: 499 * 1024 * 1024 }] })
  assert.equal(under.routes[0].maxBody, 499 * 1024 * 1024)
  const exact = normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', maxBody: 500 * 1024 * 1024 }] })
  assert.equal(exact.routes[0].maxBody, 500 * 1024 * 1024)
  assert.equal(routeMaxBodyOf(exact.routes[0]), 500 * 1024 * 1024)
  assert.throws(
    () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', maxBody: 500 * 1024 * 1024 + 1 }] }),
    /maxBody/,
  )
})

// --- the effective readers -----------------------------------------------------

test('routeLocatorOf defaults to the query-parameter convention; the boolean readers default to false', () => {
  const bare = normalizeDeclaration(DECL).routes[0]
  assert.deepEqual(routeLocatorOf(bare), { in: 'query', name: 'sessionId' })
  assert.equal(routePrefixOf(bare), false)
  assert.equal(routeDeniesRemoteOf(bare), false)
  assert.equal(routeRewritesIdsOf(bare), false)
  assert.equal(bare.locator, undefined)
  assert.equal(bare.prefix, undefined)
  assert.equal(bare.deny, undefined)
  assert.equal(bare.rewriteIds, undefined)

  const custom = normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', sessionParam: 'sid' }] }).routes[0]
  assert.deepEqual(routeLocatorOf(custom), { in: 'query', name: 'sid' })
})

// --- PB-25a: the rewriteIds { fields } form ------------------------------------

test('PB-25a: a rewriteIds fields declaration hashes EXACTLY as its hand-written canonical JSON says', () => {
  const decl = {
    plugin: 'creator',
    version: '4.0.0',
    routes: [
      { path: '/c/create', scope: 'session', rewriteIds: { fields: ['value.childId', 'meta.parentId'] } },
      { path: '/c/echo', scope: 'session', rewriteIds: true },
    ],
  }
  // The fields form serializes as a plain JSON object in the SAME slot the
  // `true` form occupies (after deny); field order is verbatim. The `true`
  // route's canonical bytes are UNCHANGED from PB-22 — the two pins above
  // (2.1-era, v2) carry that compatibility, this one pins the new shape.
  const canonical =
    '{"plugin":"creator","version":"4.0.0","routes":[' +
    '{"path":"/c/create","scope":"session","sessionParam":"sessionId","stream":false,"rewriteIds":{"fields":["value.childId","meta.parentId"]}},' +
    '{"path":"/c/echo","scope":"session","sessionParam":"sessionId","stream":false,"rewriteIds":true}]}'
  assert.equal(normalizeDeclaration(decl).digest, digestOfCanonical(canonical))
})

test('PB-25a: true and { fields } are different declarations — different digests, both enabling the reader', () => {
  const bool = normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', rewriteIds: true }] })
  const fields = normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', rewriteIds: { fields: ['value.childId'] } }] })
  assert.notEqual(bool.digest, fields.digest)
  assert.equal(routeRewritesIdsOf(bool.routes[0]), true)
  assert.equal(routeRewritesIdsOf(fields.routes[0]), true, 'both forms enable the rewrite')
})

test('PB-25a: the fields form — legal shapes stored verbatim, illegal shapes refused naming the field', () => {
  // Legal: dot paths of [A-Za-z0-9_-] segments, verbatim order.
  const ok = normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', rewriteIds: { fields: ['value.childId', 'top', 'a-b_C0'] } }] })
  assert.deepEqual(ok.routes[0].rewriteIds, { fields: ['value.childId', 'top', 'a-b_C0'] })
  assert.deepEqual([...routeRewriteFieldsOf(ok.routes[0])], ['value.childId', 'top', 'a-b_C0'])
  // A `true` route exposes NO fields — the position rewrite is declared-only.
  const bool = normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', rewriteIds: true }] }).routes[0]
  assert.equal(routeRewriteFieldsOf(bool), undefined)
  assert.equal(routeRewriteFieldsOf(normalizeDeclaration(DECL).routes[0]), undefined)

  const bad = [
    ['empty fields array', { fields: [] }],
    ['fields missing', {}],
    ['fields not an array', { fields: 'value.childId' }],
    ['non-string entry', { fields: ['ok', 3] }],
    ['empty entry', { fields: [''] }],
    ['empty middle segment', { fields: ['a..b'] }],
    ['leading dot', { fields: ['.a'] }],
    ['trailing dot', { fields: ['a.'] }],
    ['space in segment', { fields: ['value.child id'] }],
    ['wildcard segment', { fields: ['value.*'] }],
    ['bracket index syntax', { fields: ['items[0]'] }],
    ['numeric segment (array index)', { fields: ['items.0.id'] }],
    ['unknown object key', { fields: ['ok'], extra: 1 }],
  ]
  for (const [why, rewriteIds] of bad) {
    assert.throws(
      () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', rewriteIds }] }),
      /rewriteIds/,
      `rewriteIds fields: ${why} must be refused`,
    )
  }
})

test('PB-25a: the fields form cannot ride a stream route either', () => {
  assert.throws(
    () => normalizeDeclaration({ ...DECL, routes: [{ path: '/x', scope: 'session', stream: true, rewriteIds: { fields: ['a.b'] } }] }),
    /rewriteIds.*stream|stream.*rewriteIds/,
  )
})
