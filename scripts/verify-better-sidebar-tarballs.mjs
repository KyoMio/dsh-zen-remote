#!/usr/bin/env node
/**
 * Manual maintainer script verifying the better-sidebar adapter's method
 * table and surfaces whitelist against unpacked tarballs in /tmp/bs-versions/.
 * Not run by `npm test`; exits 0 with a note if /tmp/bs-versions/ is absent.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const importLib = (name) => import(pathToFileURL(path.join(ROOT, 'lib', name)).href)

const PLUGIN_SOURCES = [
  '/tmp/bs-versions/0.25.0/lib/index.js',
  '/tmp/bs-versions/0.26.0/lib/index.js',
  '/tmp/bs-versions/0.26.1/lib/index.js',
  '/tmp/bs-versions/0.28.0-alpha.0/lib/index.js',
  '/tmp/bs-versions/0.28.0/lib/index.js',
  '/tmp/bs-versions/0.28.1/lib/index.js',
  '/tmp/bs-versions/0.28.2/lib/index.js',
  '/tmp/bs-versions/0.30.0/lib/index.js',
  '/tmp/bs-versions/0.30.1/lib/index.js',
  '/tmp/bs-versions/0.33.0/lib/index.js',
  '/tmp/bs-versions/0.34.0-alpha.0/lib/index.js',
]

const absent = PLUGIN_SOURCES.filter((p) => !fs.existsSync(p))
if (absent.length > 0) {
  console.log(`Skipping tarball check; missing sources: ${absent.join(', ')}`)
  process.exit(0)
}

const adapterMod = await importLib('adapters/dsh-better-sidebar/methods.js')
const surfaceMod = await importLib('adapters/dsh-better-sidebar/surface.js')
const adaptersMod = await importLib('adapters/index.js')

const names = new Set()
for (const sourcePath of PLUGIN_SOURCES) {
  const source = fs.readFileSync(sourcePath, 'utf8')
  for (const match of source.matchAll(/"([a-zA-Z]+(?:\.[a-zA-Z-]+)+)":\s*(?:async\s*)?\(/g)) {
    names.add(match[1])
  }
  // 0.34.0-alpha.0: the clue service registers its seam through `registerApi`
  // — literal names, constant-keyed names (the share surface) and the
  // workspaceForSession constant. Verified against the build: the wire set
  // and the set of `"clues.*"` string literals coincide exactly, so the
  // literal scan is the honest extraction for this family.
  for (const match of source.matchAll(/"(clues\.[a-zA-Z.]+)"/g)) {
    names.add(match[1].replace(/\.$/u, ''))
  }
  for (const match of source.matchAll(/'(clues\.[a-zA-Z.]+)'/g)) {
    names.add(match[1].replace(/\.$/u, ''))
  }
}
const sidebarNames = [...names].filter((name) => /^(session|fs|git|changes|subagents|workflows|teams|settings|open|archive|sidechat|clues|selection)\./.test(name))
assert.ok(sidebarNames.length >= 45, `the extraction found the union table (${sidebarNames.length} names)`)
const missing = sidebarNames.filter((name) => adapterMod.SIDEBAR_METHODS[name] === undefined)
assert.deepEqual(missing, [], `methods the plugin dispatches but the table lacks: ${missing.join(', ')}`)
const extra = Object.keys(adapterMod.SIDEBAR_METHODS).filter((name) => !names.has(name))
assert.deepEqual(extra, [], `table entries neither source dispatches: ${extra.join(', ')}`)

const surfaces = new Map()
for (const sourcePath of PLUGIN_SOURCES) {
  const source = fs.readFileSync(sourcePath, 'utf8')
  const surface = surfaceMod.extractBetterSidebarSurface(source)
  assert.deepEqual(surfaceMod.extractBetterSidebarSurface(source), surface, `${sourcePath} extraction is not deterministic`)
  assert.equal(surfaceMod.surfaceLooksHealthy(surface), true, `${sourcePath}: extraction looks empty`)
  surfaces.set(sourcePath, { surface, digest: surfaceMod.betterSidebarSurfaceDigest(surface) })
}
const digestOf = (version) => surfaces.get(`/tmp/bs-versions/${version}/lib/index.js`).digest
assert.equal(digestOf('0.26.0'), digestOf('0.26.1'))
assert.equal(digestOf('0.28.1'), digestOf('0.28.2'))
assert.notEqual(digestOf('0.25.0'), digestOf('0.26.0'))
assert.notEqual(digestOf('0.26.0'), digestOf('0.28.1'))
assert.notEqual(digestOf('0.28.0'), digestOf('0.28.1'))
assert.notEqual(digestOf('0.28.2'), digestOf('0.30.0'))

const raw = adaptersMod.ADAPTERS.find((entry) => entry.plugin === 'dsh-better-sidebar')
const computed = new Set()
for (const version of raw.versions) {
  const sourcePath = `/tmp/bs-versions/${version}/lib/index.js`
  assert.ok(fs.existsSync(sourcePath), `${sourcePath} is on disk`)
  const digest = surfaceMod.betterSidebarSurfaceDigest(surfaceMod.extractBetterSidebarSurface(fs.readFileSync(sourcePath, 'utf8')))
  computed.add(digest)
  assert.ok(raw.surfaces[digest] !== undefined, `${version}'s surface digest ${digest} is whitelisted`)
}
assert.deepEqual(Object.keys(raw.surfaces).sort(), [...computed].sort())

// PB-27: the generation gate — normalizeAdapter over each REAL build's own
// digest must produce the pre-0.34 route table (no share routes) for the ten
// old generations, and the 15-route table (the four gated share routes in)
// for 0.34.0-alpha.0 alone. The byte-identity of the old tables against the
// pre-gate zen-remote is pinned in test/adapter-better-sidebar.test.cjs.
const coreMod = await importLib('plugin-adapter-core.js')
for (const version of raw.versions) {
  const digest = digestOf(version)
  const normalized = coreMod.normalizeAdapter(raw, version, { surfaceDigest: digest })
  const shareRoutes = normalized.routes.filter((route) => route.path.startsWith('/sidebar/clues/share/'))
  if (version === '0.34.0-alpha.0') {
    assert.equal(shareRoutes.length, 4, 'the 0.34 generation carries the four gated share routes')
  } else {
    assert.equal(shareRoutes.length, 0, `${version} keeps the pre-0.34 table — no share routes`)
  }
}
console.log('verify-better-sidebar-tarballs: all assertions passed')
