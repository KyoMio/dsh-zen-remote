// Machine evidence for "the client half no longer requires anything that a
// DSH version could fail to provide" (PLAN §3.1 verification): scan
// lib/client.js for every non-relative require() specifier and assert the
// set is within the small allowlist below.
//
// Why this matters: the browser resolves these names against the host's
// module table (window.__ModuleLoader__). A name the table does not know
// throws when the plugin factory runs, taking the WHOLE plugin down with it.
// The seed words BOTH DSH versions statically provide are exactly the four
// allowlisted entries — anything else here means the plugin stopped being
// version-agnostic (or someone added a require the bundler did not inline).
//
// Run: node scripts/check-client-externals.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientJs = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib', 'client.js')

const ALLOWED = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
]

const specifiers = new Set()
const source = readFileSync(clientJs, 'utf8')
for (const match of source.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
  const specifier = match[2]
  if (specifier.startsWith('.')) continue // relative module — bundled inline
  specifiers.add(specifier)
}

const extra = [...specifiers].filter((specifier) => !ALLOWED.includes(specifier))
if (extra.length > 0) {
  console.error(`check-client-externals: FAIL — lib/client.js requires packages outside the allowlist:
  ${extra.join('\n  ')}

These names are fetched from the host browser module table at runtime; a name
the table does not know throws "missed the module table" and the plugin does
not load at all. The only names BOTH DSH 0.1.1 and 0.1.2 seed statically are
the four allowlisted ones. Add new host requires only after confirming the
name is a seed word in every supported version.`)
  process.exit(1)
}

console.log('check-client-externals: ok')
