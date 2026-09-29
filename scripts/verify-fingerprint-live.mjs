// Live fingerprint verification (T42) — NOT part of `pnpm test`.
//
// Computes the interface fingerprints of a REAL DSH closure the way the
// plugin's registry tier normalizes them (the exact same
// lib/fingerprint.js code path: descriptors minus sourceLocation, schemas
// projected to JSON Schema, keys sorted, sha256 truncated to 12 hex chars)
// and prints one JSON document per closure root, so the acceptance check
// can diff an npm install against a packaged App side by side:
//
//   node scripts/verify-fingerprint-live.mjs                    # this checkout's dev closure
//   node scripts/verify-fingerprint-live.mjs /path/to/App/node_modules \
//                                            /path/to/npm/node_modules
//
// Expected verdict for same-interface closures (docs/spike-relay.md §2.3):
// every group's hash is IDENTICAL across roots — including across DSH
// 0.1.7 / 0.2.0, whose remote interfaces are byte-identical even though the
// versions differ. The spike recorded be9ab393695a there for the
// session-controller group under its key-sorting-only normalization; this
// canonicalization is strictly stronger (recursive schema-key sorting), so
// the comparable anchor over the 0.1.7-rc.2 dev closure is r:211083a84f52 —
// the cross-root identity verdict below is the property that matters here.
//
// The descriptors come from each package's generated
// `lib/typert.remote-client.js` — inside a real DSH process the registry
// tier reads `ctx.typert.local.list()` instead, but the spike verified the
// generated files are byte-identical between the App and npm for the same
// interfaces, so this offline stand-in measures the same thing (and is the
// only way to check a closure without starting DSH).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The fingerprint helpers import node: builtins only — safe to load from the
// built lib. A missing build gets a loud, actionable failure instead.
const { FINGERPRINT_GROUP_PACKAGES, EVENTS_GROUP, fingerprintDescriptors, fingerprintForwardedEvents } = await import(
  pathToFileURL(join(pluginRoot, 'lib', 'fingerprint.js')).href
)

const roots = process.argv.slice(2)
const effectiveRoots = roots.length > 0 ? roots : [join(pluginRoot, 'node_modules')]

/** sha256 over the stripped remote-client file — the task's documented
 * file-tier fallback, printed beside the normalized hash for reference. */
function fileTierHash(packageDir) {
  const file = join(packageDir, 'lib', 'typert.remote-client.js')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  return createHash('sha256').update(text.replace(/sourceLocation:\s*\{[^{}]*\}/gu, ''), 'utf8').digest('hex').slice(0, 12)
}

const report = {}
for (const root of effectiveRoots) {
  const entry = {}
  for (const [group, packageName] of Object.entries(FINGERPRINT_GROUP_PACKAGES)) {
    const packageDir = join(root, packageName)
    const remoteClient = join(packageDir, 'lib', 'typert.remote-client.js')
    if (!existsSync(remoteClient)) {
      entry[group] = { package: packageName, fingerprint: 'unavailable', note: 'lib/typert.remote-client.js not found in this closure' }
      continue
    }
    const mod = await import(pathToFileURL(remoteClient).href)
    const descriptors = mod.default?.descriptors
    if (!Array.isArray(descriptors)) {
      entry[group] = { package: packageName, fingerprint: 'unavailable', note: 'no descriptors export' }
      continue
    }
    entry[group] = {
      package: packageName,
      endpoints: descriptors.length,
      fingerprint: fingerprintDescriptors(descriptors),
      fileTier: fileTierHash(packageDir),
    }
  }
  // The events whitelist from dsh-api-remotes — the same input the runtime
  // events group hashes.
  const remotesFile = join(root, '@deepseek-ai', 'dsh-api-remotes', 'lib', 'index.js')
  if (existsSync(remotesFile)) {
    const remotes = await import(pathToFileURL(remotesFile).href)
    const events = remotes.API_REMOTE_FORWARDED_EVENTS
    entry[EVENTS_GROUP] = Array.isArray(events)
      ? {
          package: '@deepseek-ai/dsh-api-remotes',
          endpoints: events.length,
          fingerprint: fingerprintForwardedEvents(events),
        }
      : { package: '@deepseek-ai/dsh-api-remotes', fingerprint: 'unavailable', note: 'API_REMOTE_FORWARDED_EVENTS is not an array' }
  } else {
    entry[EVENTS_GROUP] = { package: '@deepseek-ai/dsh-api-remotes', fingerprint: 'unavailable', note: 'package not found in this closure' }
  }
  report[root] = entry
}

console.log(JSON.stringify(report, null, 2))

// Cross-root verdict: groups present in EVERY root must hash identically —
// that is the property the version-tolerance layer stands on.
if (effectiveRoots.length > 1) {
  const groups = Object.keys(FINGERPRINT_GROUP_PACKAGES).concat(EVENTS_GROUP)
  const mismatches = []
  for (const group of groups) {
    const values = effectiveRoots.map((root) => report[root][group]?.fingerprint)
    if (values.some((value) => value === undefined || value === 'unavailable')) continue
    if (new Set(values).size > 1) mismatches.push(group)
  }
  console.error(mismatches.length === 0
    ? `verify-fingerprint-live: all comparable groups identical across ${effectiveRoots.length} closures`
    : `verify-fingerprint-live: DIFFERING groups: ${mismatches.join(', ')}`)
}
