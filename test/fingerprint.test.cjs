/* dsh-zen-remote · interface fingerprints (src/fingerprint.ts, T42 + T42-fix)
 *
 * The normalization is the spike's verified fp.mjs recipe (descriptors minus
 * sourceLocation, schemas projected to JSON Schema, keys sorted, sha256
 * truncated) with two T42-fix tightenings: only fields NAMED `create` are
 * called (any other function collapses to 'fn' uninvoked), and the projected
 * JSON Schema is recursively key-sorted (required arrays included), so field
 * declaration order cannot move a hash. Values carry their algorithm prefix
 * ('r:' registry tier, 'f:' file tier) — the comparison treats a prefix
 * mismatch as unavailable, never as a difference.
 *
 * Tests run on FAKE descriptors (schema-producing functions are duck-typed
 * schema-like objects, so no zod is needed), injected typert fakes for the
 * registry tier, injected resolution anchors for the package lookup order,
 * and the real dev node_modules for the file tier and the closure pin.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  FINGERPRINT_UNAVAILABLE,
  EVENTS_GROUP,
  FINGERPRINT_GROUP_PACKAGES,
  normalizeDescriptorValue,
  fingerprintDescriptors,
  fingerprintForwardedEvents,
  fingerprintPackageFile,
  computeFingerprints,
  compareFingerprints,
} = require('../lib/fingerprint.js')

/** A duck-typed zod schema: the only thing normalization may rely on. */
const schemaLike = (shape) => ({ toJSONSchema: (params) => ({ ...shape, unrepresentable: params.unrepresentable }) })

/** One registry-shaped descriptor with a schema-producing codec function. */
function fakeDescriptor(packageName, endpoint, overrides = {}) {
  return {
    id: `${packageName}#${endpoint}`,
    namespace: endpoint.split('/')[0],
    method: endpoint.split('/')[1],
    parameters: [{ name: 'request', wire: 'request', codec: { mode: 'strict', create: () => schemaLike({ type: 'object' }) } }],
    result: { mode: 'strict', create: () => schemaLike({ type: 'string' }) },
    sourceLocation: { file: 'packages/x/src/index.ts', line: 1, column: 2 },
    ...overrides,
  }
}

const SESSION_PKG = FINGERPRINT_GROUP_PACKAGES.session
const WORKSPACE_PKG = FINGERPRINT_GROUP_PACKAGES.workspace

// -- normalization: the spike's contract, tightened -----------------------------

test('normalizeDescriptorValue drops sourceLocation, sorts keys, projects create fields', () => {
  const descriptor = fakeDescriptor(SESSION_PKG, 'session/follow')
  const moved = fakeDescriptor(SESSION_PKG, 'session/follow', {
    sourceLocation: { file: 'totally/elsewhere.ts', line: 999, column: 9 },
  })
  assert.deepEqual(normalizeDescriptorValue(descriptor), normalizeDescriptorValue(moved))
  // The create field was projected with unrepresentable: 'any'.
  const normalized = normalizeDescriptorValue(descriptor)
  assert.equal(normalized.parameters[0].codec.create.unrepresentable, 'any')
  // Key insertion order is irrelevant; a structural change is not.
  const reordered = { result: descriptor.result, parameters: descriptor.parameters, method: descriptor.method, namespace: descriptor.namespace, id: descriptor.id }
  assert.deepEqual(normalizeDescriptorValue(descriptor), normalizeDescriptorValue(reordered))
  const changed = fakeDescriptor(SESSION_PKG, 'session/follow', {
    result: { mode: 'strict', create: () => schemaLike({ type: 'number' }) },
  })
  assert.notDeepEqual(normalizeDescriptorValue(descriptor), normalizeDescriptorValue(changed))
})

test('normalizeDescriptorValue: JSON Schema keys and required order are canonicalized (T42-fix)', () => {
  // The same schema shape declared in two field orders must project to the
  // same canonical document: object keys at every depth, and the `required`
  // array (zod inherits its order from declaration order) alphabetized.
  // Both go through the create path — that is where projections happen.
  const viaCreate = (schema) => ({ result: { mode: 'strict', create: () => schema } })
  const first = schemaLike({
    type: 'object',
    properties: { alpha: { type: 'string' }, beta: { type: 'number' } },
    required: ['beta', 'alpha'],
  })
  const second = schemaLike({
    required: ['alpha', 'beta'],
    properties: { beta: { type: 'number' }, alpha: { type: 'string' } },
    type: 'object',
  })
  assert.deepEqual(normalizeDescriptorValue(viaCreate(first)), normalizeDescriptorValue(viaCreate(second)))
  // Array order elsewhere (items — tuple semantics) is preserved.
  const tupleA = schemaLike({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] })
  const tupleB = schemaLike({ type: 'array', items: [{ type: 'number' }, { type: 'string' }] })
  assert.notDeepEqual(normalizeDescriptorValue(viaCreate(tupleA)), normalizeDescriptorValue(viaCreate(tupleB)))
})

test('normalizeDescriptorValue: only create fields are called; other functions stay "fn"', () => {
  // A function under another name is collapsed WITHOUT being invoked.
  let called = false
  const descriptor = fakeDescriptor(SESSION_PKG, 'session/follow', {
    decode: () => { called = true; throw new Error('must never run') },
  })
  const normalized = normalizeDescriptorValue(descriptor)
  assert.equal(called, false, 'non-create functions are never invoked')
  assert.equal(normalized.decode, 'fn')
  // A create that throws stays the stable marker.
  const broken = fakeDescriptor(SESSION_PKG, 'session/follow', {
    result: { mode: 'strict', create: () => { throw new Error('no schema today') } },
  })
  assert.equal(normalizeDescriptorValue(broken).result.create, 'fn')
  // Bare functions (no key context) are never called either.
  assert.equal(normalizeDescriptorValue(() => 42), 'fn')
})

// -- group fingerprints over fake descriptors -----------------------------------

test('fingerprintDescriptors: same structure sans sourceLocation → same, different → different', () => {
  const base = [fakeDescriptor(SESSION_PKG, 'session/follow'), fakeDescriptor(SESSION_PKG, 'session/page')]
  const drifted = base.map((d, i) => ({ ...d, sourceLocation: { file: `v${i}.ts`, line: 100 + i, column: 3 } }))
  assert.equal(fingerprintDescriptors(base), fingerprintDescriptors(drifted))
  for (const value of [fingerprintDescriptors(base), fingerprintDescriptors(drifted)]) {
    assert.match(value, /^r:[0-9a-f]{12}$/, 'registry-tier values carry the r: prefix')
  }
  const different = [base[0], fakeDescriptor(SESSION_PKG, 'session/rename')]
  assert.notEqual(fingerprintDescriptors(base), fingerprintDescriptors(different))
})

test('fingerprintForwardedEvents: sorted rows, r:-prefixed, shape errors throw', () => {
  const events = [{ event: 'z/last', mode: 'emit' }, { event: 'a/first', mode: 'waterfall' }, { event: 'a/first', mode: 'emit' }]
  const hash = fingerprintForwardedEvents(events)
  assert.match(hash, /^r:[0-9a-f]{12}$/)
  // Order independence: the same rows in another order hash identically.
  assert.equal(fingerprintForwardedEvents([...events].reverse()), hash)
  // Content sensitivity: one mode flip changes the hash.
  assert.notEqual(fingerprintForwardedEvents([{ ...events[0], mode: 'waterfall' }, ...events.slice(1)]), hash)
  assert.throws(() => fingerprintForwardedEvents('nope'))
  assert.throws(() => fingerprintForwardedEvents([{ event: 'x' }]))
  assert.throws(() => fingerprintForwardedEvents([42]))
})

// -- the file tier over the real dev closure ------------------------------------

test('fingerprintPackageFile: real dev closure hashes f:-prefixed; unresolvable throws', () => {
  // The devDep closure is part of the test environment (pnpm install).
  assert.match(fingerprintPackageFile(SESSION_PKG), /^f:[0-9a-f]{12}$/)
  assert.throws(() => fingerprintPackageFile('@deepseek-ai/definitely-not-installed'))
})

// -- package resolution: the HOST anchor wins (T42-fix) --------------------------

/**
 * Two fake closure roots, each carrying a dsh-api-remotes whose whitelist
 * names its own root plus a fingerprintable package whose remote-client file
 * embeds its root's name. `anchors` are passed host-first.
 */
function makeFakeRoot(rootName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-zen-remote-fp-${rootName}-`))
  process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ } })
  const pkgDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-api-remotes')
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-api-remotes', main: 'lib/index.js', type: 'module' }))
  fs.writeFileSync(path.join(pkgDir, 'lib', 'index.js'), `export const API_REMOTE_FORWARDED_EVENTS = [{ event: '${rootName}/event', mode: 'emit' }]\n`)
  const ctlDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-fp-fake-ctl')
  fs.mkdirSync(path.join(ctlDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(ctlDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-fp-fake-ctl', type: 'module' }))
  fs.writeFileSync(path.join(ctlDir, 'lib', 'typert.remote-client.js'), `// ${rootName}\nexport default { package: '@deepseek-ai/dsh-fp-fake-ctl', descriptors: [] }\n`)
  return { root, pkgDir, ctlFile: path.join(ctlDir, 'lib', 'typert.remote-client.js'), anchor: pathToFileURL(path.join(root, 'entry.js')).href }
}

test('computeFingerprints: the host anchor is consulted before the plugin anchor (T42-fix)', async () => {
  const host = makeFakeRoot('host-root')
  const plugin = makeFakeRoot('plugin-root')
  const fingerprints = await computeFingerprints({}, { anchors: [host.anchor, plugin.anchor] })
  // The events whitelist came from the HOST root's copy…
  assert.equal(
    fingerprints[EVENTS_GROUP],
    fingerprintForwardedEvents([{ event: 'host-root/event', mode: 'emit' }]),
    'the host entry anchor resolves first',
  )
  assert.notEqual(fingerprints[EVENTS_GROUP], fingerprintForwardedEvents([{ event: 'plugin-root/event', mode: 'emit' }]))
  // …and the file tier read the HOST root's remote-client file too.
  const hostText = fs.readFileSync(host.ctlFile, 'utf8')
  const pluginText = fs.readFileSync(plugin.ctlFile, 'utf8')
  assert.notEqual(hostText, pluginText)
  assert.equal(
    fingerprintPackageFile('@deepseek-ai/dsh-fp-fake-ctl', [host.anchor, plugin.anchor]),
    'f:' + require('node:crypto').createHash('sha256').update(hostText.replace(/sourceLocation:\s*\{[^{}]*\}/gu, ''), 'utf8').digest('hex').slice(0, 12),
  )
})

test('computeFingerprints: anchors fall through when a root lacks the package', async () => {
  const host = makeFakeRoot('thin-host')
  // The host root has NO dsh-fp-fake-ctl — the fallback anchor must answer.
  fs.rmSync(path.join(host.root, 'node_modules', '@deepseek-ai', 'dsh-fp-fake-ctl'), { recursive: true, force: true })
  const plugin = makeFakeRoot('fat-plugin')
  const value = fingerprintPackageFile('@deepseek-ai/dsh-fp-fake-ctl', [host.anchor, plugin.anchor])
  const pluginText = fs.readFileSync(plugin.ctlFile, 'utf8')
  assert.equal(
    value,
    'f:' + require('node:crypto').createHash('sha256').update(pluginText.replace(/sourceLocation:\s*\{[^{}]*\}/gu, ''), 'utf8').digest('hex').slice(0, 12),
  )
})

test('defaultAnchors: a symlinked process entry resolves through to the real closure behind it (T23b2-fix3)', async () => {
  // The npm global CLI shape: `…/bin/dsh` is a SYMLINK into the real install
  // (whose node_modules sits beside the target). Without the realpath the
  // host anchor would be the bin directory — its upward node_modules walk
  // finds nothing, the anchor silently fails, and this plugin's own copies
  // (the second anchor) would answer instead of the host's.
  const real = makeFakeRoot('real-behind-link')
  // The realpath needs a REAL target: create the entry file the symlink
  // points at (the npm CLI's entry exists too — it is what Node runs).
  fs.writeFileSync(path.join(real.root, 'entry.js'), '// anchor target\n')
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-fp-bin-'))
  process.on('exit', () => { try { fs.rmSync(bin, { recursive: true, force: true }) } catch { /* best effort */ } })
  const link = path.join(bin, 'dsh')
  fs.symlinkSync(path.join(real.root, 'entry.js'), link)
  const originalEntry = process.argv[1]
  process.argv[1] = link
  try {
    // DEFAULT anchors — the host entry first (realpath'd), the plugin second.
    const fingerprints = await computeFingerprints({})
    assert.equal(
      fingerprints[EVENTS_GROUP],
      fingerprintForwardedEvents([{ event: 'real-behind-link/event', mode: 'emit' }]),
      'the symlinked entry anchored the real closure beside it, not the plugin copy',
    )
  } finally {
    process.argv[1] = originalEntry
  }
})

// -- computeFingerprints over injected typert fakes ------------------------------

function fakeCtx(typert) {
  return { reflect: { get: (name) => (name === 'typert' ? typert : undefined) } }
}

test('computeFingerprints: registry tier groups by id prefix (T42-fix)', async () => {
  const descriptors = [
    fakeDescriptor(SESSION_PKG, 'session/follow'),
    fakeDescriptor(SESSION_PKG, 'session/page'),
    fakeDescriptor(WORKSPACE_PKG, 'workspace/follow'),
    // A descriptor of an UNRELATED package — never lands in any group.
    fakeDescriptor('@deepseek-ai/dsh-something-else', 'other/thing'),
  ]
  const fingerprints = await computeFingerprints(fakeCtx({ local: { list: () => descriptors } }), { anchors: [] })
  // Groups with descriptors hash from the registry tier…
  assert.match(fingerprints.session, /^r:[0-9a-f]{12}$/)
  assert.match(fingerprints.workspace, /^r:[0-9a-f]{12}$/)
  // …and equal the direct descriptor hash over the same subset.
  assert.equal(fingerprints.session, fingerprintDescriptors(descriptors.filter((d) => d.id.startsWith(`${SESSION_PKG}#`))))
  // Groups the registry does not carry are unavailable — a handshake against
  // a half-assembled registry (typert-loader registers package by package)
  // must not publish throwaway empty-set hashes its clients would read as
  // differences (T42-fix).
  assert.equal(fingerprints.job, FINGERPRINT_UNAVAILABLE)
  assert.equal(fingerprints.files, FINGERPRINT_UNAVAILABLE)
  assert.equal(fingerprints.goal, FINGERPRINT_UNAVAILABLE)
  assert.equal(fingerprints[EVENTS_GROUP], FINGERPRINT_UNAVAILABLE, 'no anchors, no events resolution')
})

test('computeFingerprints: an empty registry marks every registry group unavailable (T42-fix)', async () => {
  const fingerprints = await computeFingerprints(fakeCtx({ local: { list: () => [] } }), { anchors: [] })
  assert.equal(fingerprints.session, FINGERPRINT_UNAVAILABLE)
  assert.equal(fingerprints.job, FINGERPRINT_UNAVAILABLE)
  assert.equal(fingerprints.goal, FINGERPRINT_UNAVAILABLE)
})

test('computeFingerprints: registry absent → file tier over the real closure', async () => {
  const fingerprints = await computeFingerprints({})
  assert.equal(fingerprints.session, fingerprintPackageFile(SESSION_PKG), 'the file tier answers for resolvable packages')
  assert.equal(fingerprints.job, FINGERPRINT_UNAVAILABLE, 'unresolvable packages degrade, one group at a time')
  assert.match(fingerprints[EVENTS_GROUP], /^r:[0-9a-f]{12}$/, 'the dev closure carries the events whitelist')
})

test('computeFingerprints: a throwing registry read degrades to the file tier', async () => {
  const fingerprints = await computeFingerprints(fakeCtx({ local: { list: () => { throw new Error('registry exploded') } } }))
  assert.equal(fingerprints.session, fingerprintPackageFile(SESSION_PKG))
})

test('computeFingerprints: the dev closure pins the canonicalized session hash', async () => {
  // The spike §2.3 recorded be9ab393695a for the session-controller group
  // under its key-sorting-only normalization, byte-identical across
  // App/npm/0.1.7/0.2.0. This canonicalization is strictly stronger
  // (recursive schema-key sorting), so the pin here is ITS value over the
  // same 0.1.7-rc.2 dev closure — a drift means the interface definitions
  // or the projection changed, which is exactly what this pin must catch.
  const remote = await import('../node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js')
  assert.equal(remote.default.descriptors.length, 21)
  const fingerprints = await computeFingerprints(fakeCtx({ local: { list: () => remote.default.descriptors } }), { anchors: [] })
  assert.equal(fingerprints.session, 'r:211083a84f52')
})

// -- the comparison -------------------------------------------------------------

test('compareFingerprints: identical maps are fully compatible', () => {
  const map = { session: 'r:aaa111', workspace: 'r:bbb222', events: 'r:ccc333' }
  assert.deepEqual(compareFingerprints(map, { ...map }), { identical: ['events', 'session', 'workspace'], different: [], unavailable: [] })
})

test('compareFingerprints: differing groups are listed by name', () => {
  const verdict = compareFingerprints({ session: 'r:aaa111', workspace: 'r:bbb222' }, { session: 'r:aaa111', workspace: 'r:zzz999' })
  assert.deepEqual(verdict, { identical: ['session'], different: ['workspace'], unavailable: [] })
})

test('compareFingerprints: mixed algorithm prefixes are unavailable, never different (T42-fix)', () => {
  // Same digest, different tiers — different material, incomparable.
  assert.deepEqual(
    compareFingerprints({ session: 'r:aaa111' }, { session: 'f:aaa111' }),
    { identical: [], different: [], unavailable: ['session'] },
  )
  // One end file-tier, the other registry-tier on a REAL difference must
  // also stay silent.
  assert.deepEqual(
    compareFingerprints({ session: 'r:aaa111' }, { session: 'f:zzz999' }).unavailable,
    ['session'],
  )
})

test('compareFingerprints: unavailable and one-sided groups never count as different', () => {
  const verdict = compareFingerprints(
    { session: 'r:aaa111', workspace: FINGERPRINT_UNAVAILABLE, job: 'r:ccc333' },
    { session: 'r:aaa111', workspace: 'r:bbb222', goal: 'r:ddd444' },
  )
  assert.deepEqual(verdict, { identical: ['session'], different: [], unavailable: ['goal', 'job', 'workspace'] })
})

test('compareFingerprints: hostile junk degrades to unavailable, never different', () => {
  // A server substituting non-strings (or an empty map — a pre-T42 server)
  // makes those groups incomparable, not "different".
  assert.deepEqual(compareFingerprints({ session: 42 }, { session: 'r:aaa111' }).unavailable, ['session'])
  assert.deepEqual(compareFingerprints({}, { session: 'r:aaa111' }).unavailable, ['session'])
  assert.deepEqual(compareFingerprints(undefined, { session: 'r:aaa111' }).unavailable, ['session'])
  assert.deepEqual(compareFingerprints(undefined, undefined), { identical: [], different: [], unavailable: [] })
})
