// Shadow check: every @deepseek-ai/* package the host half loads at runtime
// must come from the DSH profile — except the ones explicitly registered in
// SHADOW_ALLOWED below.
//
// Node resolves imports starting at the importing file's directory, so any
// @deepseek-ai package physically present in <plugin>/node_modules wins over
// the copy the DSH profile provides. With a 0.1.1 profile installed that
// means the host half silently loads whatever version this plugin last
// installed — "it links and starts" proves nothing.
//
// Instead of hand-maintaining a package list, the files the host half
// actually loads (dsh-push.mjs, lan-gate.mjs, lib/index.js and the modules
// it statically pulls in) are scanned for @deepseek-ai specifiers — static
// import, dynamic import() and require() — so a new import added there gets
// watched automatically. src/index.ts is type-only imports (erased at
// runtime) and the gateway subprocess uses only stdlib + web-push, so this
// scan is the whole runtime story.
//
// Run: node scripts/check-host-shadow.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginNodeModules = join(dirname(dirname(fileURLToPath(import.meta.url))), 'node_modules')
const require = createRequire(import.meta.url)

// Packages that are ALLOWED to sit in this plugin's node_modules and shadow
// the profile's copy. Every entry must carry its justification here.
//
// @deepseek-ai/dsh-tools:
// - Why allowed at all: test/push-tool.test.cjs and test/push.test.cjs import
//   dsh-push.mjs in-process, and dsh-push.mjs does
//   `import { defineTool } from '@deepseek-ai/dsh-tools'` statically. The
//   host `tools` service only exposes register(definition) — there is no way
//   to obtain defineTool from the host, so this import cannot be removed and
//   the package must be resolvable for the tests to load the module.
// - Why 0.1.2-rc.1: kept on the same release line as every other devDep.
//   0.1.1's tools statically imports dsh-session, and dsh-session is pinned
//   at 0.1.2 here — mixing the two lines inside one process is harder to
//   debug than the shadow itself. 0.1.2's tools no longer statically imports
//   dsh-session, so the whole closure stays on the 0.1.2 line.
// - WHEN TO ACT: this machine's production DSH still runs 0.1.1 and the
//   plugin is installed into its profile via link:, so this shadow is live
//   in production — the host loads 0.1.2's defineTool today. Decide whether
//   that is acceptable BEFORE merging (options: upgrade production to 0.1.2
//   first, or temporarily accept the drift).
// - npm-published tarballs contain no node_modules, so this shadow only
//   exists on dev machines where the plugin is link-installed.
//
// @deepseek-ai/dsh-session:
// - Why allowed at all: src/share-export.ts (the share-image transcript
//   route) statically imports the two pure fold helpers
//   (isAppendSurfaceEvent, deriveEventMessage) from the browser-safe
//   `@deepseek-ai/dsh-session/surface` subpath. They are THE canonical
//   per-node projection rule per their own doc; reimplementing them locally
//   would be a second fold that silently drifts, and no host service exposes
//   them, so a module import is the only way to reuse them.
// - Why 0.1.2-rc.1: same release line as every other devDep; the package is
//   also needed in node_modules for pnpm verify's type check regardless. The
//   shadow only bites the two pure functions — both take plain event records
//   and touch no class identity, and their signatures are identical on the
//   0.1.2 and 0.1.5 lines — so a version-skewed copy cannot diverge the fold
//   the way a service-class mismatch could.
//   The fact BEHIND that "signatures identical" conclusion, verified against
//   both closures (2026-09-10): the SURFACE_EVENT_TYPES set differs across
//   the lines — 0.1.2-rc.1 admits user/message, assistant/message,
//   tool/result, while 0.1.5-rc.2 also admits system/message (and its
//   deriveEventMessage projects it to a system-role message). The fold in
//   src/share-export.ts neutralizes the difference: its role filter keeps
//   only 'user'/'assistant' rows, so a system/message is dropped on 0.1.5 by
//   the filter and on 0.1.2 by isAppendSurfaceEvent itself — the exported
//   transcript is byte-identical either way. A future DSH that adds another
//   role-bearing surface type must re-run this equivalence, not assume it.
// - WHEN TO ACT: a future DSH that renames the surface subpath or changes
//   event shapes will break this import loudly at plugin load; re-pin the
//   devDep then.
// - npm-published tarballs contain no node_modules, so this shadow only
//   exists on dev machines where the plugin is link-installed.
const SHADOW_ALLOWED = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session']

// Packages that must never exist in this plugin's node_modules at all: DSH
// 0.1.2 dropped them, and a stale copy would let the type check quietly pass
// against outdated declarations. NOT exemptible via SHADOW_ALLOWED.
const BANNED_PACKAGES = ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-host-apiproxy']

// The files the host half actually loads. lib/share-export.js is statically
// imported by lib/index.js, so it is part of the same runtime graph.
const HOST_ENTRY_FILES = ['dsh-push.mjs', 'lan-gate.mjs', 'lib/index.js', 'lib/share-export.js']

// Matches the specifier of real module statements only — `... from 'pkg'`,
// `import 'pkg'`, `import('pkg')`, `require('pkg')` — so @deepseek-ai names
// that merely appear in prose comments don't pollute the set. Scoped
// subpaths (`@deepseek-ai/x/client`) are trimmed back to the package name.
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](@deepseek-ai\/[^'"\s]+)['"]/g

const packageNameOf = (specifier) => specifier.split('/').slice(0, 2).join('/')

/** Scan the host entry files for @deepseek-ai import/require specifiers. */
function collectHostRuntimePackages() {
  const found = new Map() // package name -> files referencing it
  for (const file of HOST_ENTRY_FILES) {
    const path = join(dirname(dirname(fileURLToPath(import.meta.url))), file)
    if (!existsSync(path)) {
      console.error(`check-host-shadow: FAIL — host entry file is missing: ${file}
The scan cannot guard what it cannot read. Restore the file (lib/ is committed) and re-run.`)
      process.exit(1)
    }
    for (const [, specifier] of readFileSync(path, 'utf8').matchAll(IMPORT_SPECIFIER)) {
      const name = packageNameOf(specifier)
      if (!found.has(name)) found.set(name, [])
      if (!found.get(name).includes(file)) found.get(name).push(file)
    }
  }
  return found
}

const insidePluginNodeModules = (resolved) => resolved.startsWith(pluginNodeModules + sep)

/** Version of the copy sitting in the plugin's own node_modules, if any. */
function pluginCopyVersion(packageName) {
  try {
    return JSON.parse(readFileSync(join(pluginNodeModules, ...packageName.split('/'), 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

let failed = false
const runtimePackages = collectHostRuntimePackages()

for (const packageName of BANNED_PACKAGES) {
  if (!existsSync(join(pluginNodeModules, ...packageName.split('/')))) continue
  failed = true
  console.error(`check-host-shadow: FAIL — ${packageName} is inside this plugin's node_modules.
DSH 0.1.2 no longer has this package; a stale copy here would let the type
check quietly pass against outdated declarations. Remove it from
devDependencies and run pnpm install again. This one is not exemptible via
SHADOW_ALLOWED.`)
}

for (const [packageName, files] of runtimePackages) {
  let resolved
  try {
    resolved = require.resolve(packageName)
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') continue // desired: the profile provides it
    // The package exists but its entry could not be located through the
    // "require" condition; the presence probe decides the verdict instead.
    assert.match(error?.code ?? '', /^ERR_(PACKAGE_PATH_NOT_EXPORTED|INVALID_PACKAGE_TARGET)$/,
      `unexpected error resolving ${packageName}: ${error?.message}`)
    if (!existsSync(join(pluginNodeModules, ...packageName.split('/')))) continue
    resolved = join(pluginNodeModules, ...packageName.split('/'))
  }
  if (!insidePluginNodeModules(resolved) && !existsSync(join(pluginNodeModules, ...packageName.split('/')))) continue

  if (SHADOW_ALLOWED.includes(packageName)) {
    console.log(`note: ${packageName}@${pluginCopyVersion(packageName) ?? 'unknown'} 是已登记的遮蔽（见脚本注释）`)
    continue
  }

  failed = true
  console.error(`check-host-shadow: FAIL — ${packageName} is inside this plugin's node_modules
  (imported by ${files.join(', ')})
  ${resolved}

That shadows the real package in the DSH profile: Node resolves the plugin
directory before the profile, so with a 0.1.1 profile installed the host
loads the wrong version of this package. Either remove it from this plugin's
devDependencies and run pnpm install again — or, if shadowing is truly
unavoidable for it, add it to SHADOW_ALLOWED in this script with the reason
written down next to it.`)
}

if (failed) process.exit(1)
console.log('check-host-shadow: ok')
