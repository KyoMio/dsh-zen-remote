/**
 * The upload-limits drift check (the upload unification, 2026-10-28).
 * The plugin's upload ceilings live in exactly one place —
 * src/upload-limits.ts — and this script keeps the rest of the repo in
 * step with it, the way sync-doc-version.mjs keeps the READMEs in step
 * with package.json: every target below is REQUIRED, and a missing
 * marker exits non-zero rather than quietly passing, because a silent
 * no-op is exactly the failure each pin exists to prevent.
 *
 *  a. Both languages' docs state the `/v1/upload` route's cap, and every
 *     MiB number on that table row equals MAX_UPLOAD_BYTES (the docs
 *     drifted to "100 MiB" once already).
 *  b. Every nginx `client_max_body_size <N>m;` the repo hands out — the
 *     wizard's generated snippet and the docs' example block — is at
 *     least MAX_UPLOAD_BYTES in MiB (nginx's `m` is MiB; the snippet sat
 *     at 128m under a 500 MiB relay once already). The Chinese doc must
 *     carry the example; the English doc is checked wherever it appears.
 *  c. A static scan: no upload-limit VALUE may reappear as a constant
 *     definition anywhere else in the repo (the better-sidebar adapter
 *     hand-copied the relay budget once already, kept honest only by a
 *     paired test). The scan matches `const X = <N> * 1024 * 1024`
 *     definitions for the three shipped values, so unrelated MiB
 *     constants (the 64 MiB bridge body cap, the 512 MiB download cap,
 *     buffer sizes) stay untouched — and so do test-side literal
 *     arguments, which are assertions, not definitions.
 *
 * Imports the BUILT lib/upload-limits.js — run after `pnpm build` (the
 * test script already is). The scan reads the values at run time, so
 * raising a limit in upload-limits.ts moves every pin with it.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const limits = await import(pathToFileURL(join(root, 'lib', 'upload-limits.js')).href)
const capMib = limits.MAX_UPLOAD_BYTES / (1024 * 1024)

const failures = []

// --- a. the docs' `/v1/upload` row states the relay cap ---------------------

const DOCS = ['docs/remote-access.md', 'docs/remote-access.en.md']

for (const file of DOCS) {
  const row = readFileSync(join(root, file), 'utf8')
    .split('\n')
    .find((line) => /^\|\s*`\/v1\/upload`\s*\|/.test(line))
  if (row === undefined) {
    failures.push(`${file}: no \`/v1/upload\` table row found — the docs moved, update this check`)
    continue
  }
  const mibs = [...row.matchAll(/(\d+(?:\.\d+)?)\s*MiB/g)].map((match) => Number(match[1]))
  if (mibs.length === 0) {
    failures.push(`${file}: the \`/v1/upload\` row states no MiB cap — the docs moved, update this check`)
    continue
  }
  for (const mib of mibs) {
    if (mib !== capMib) failures.push(`${file}: the \`/v1/upload\` row says ${mib} MiB but MAX_UPLOAD_BYTES is ${capMib} MiB`)
  }
}

// --- b. every nginx body cap we hand out covers the relay -------------------

const NGINX_CAP = /client_max_body_size\s+(\d+)m\s*;/g

const nginxCapsOf = (text) => [...text.matchAll(NGINX_CAP)].map((match) => Number(match[1]))

const { nginxSnippet } = await import(pathToFileURL(join(root, 'lib', 'wizard', 'proxy-snippets.js')).href)
const snippet = nginxSnippet({ domain: 'dsh.example.com', upstreamHost: '127.0.0.1', upstreamPort: 4088 })
if (!snippet.ok) {
  failures.push('wizard nginxSnippet refused a plainly valid input — the generator broke')
} else {
  const caps = nginxCapsOf(snippet.text)
  if (caps.length === 0) {
    failures.push('wizard nginx snippet: no `client_max_body_size` found — the snippet moved, update this check')
  }
  for (const cap of caps) {
    if (cap < capMib) failures.push(`wizard nginx snippet: client_max_body_size ${cap}m is below the relay cap (${capMib}m)`)
  }
}

for (const file of DOCS) {
  const caps = nginxCapsOf(readFileSync(join(root, file), 'utf8'))
  if (file === 'docs/remote-access.md' && caps.length === 0) {
    failures.push(`${file}: no nginx \`client_max_body_size\` example found — the docs moved, update this check`)
  }
  for (const cap of caps) {
    if (cap < capMib) failures.push(`${file}: client_max_body_size ${cap}m is below the relay cap (${capMib}m)`)
  }
}

// --- c. the one-definition scan ----------------------------------------------

/** The value each upload-limit constant ships, by name — the scan keys on
 * the VALUES so raising a limit in upload-limits.ts moves the pin too. */
const LIMIT_VALUES = Object.entries({
  MAX_UPLOAD_BYTES: limits.MAX_UPLOAD_BYTES,
  DEFAULT_MAX_UPLOAD_BYTES: limits.DEFAULT_MAX_UPLOAD_BYTES,
  MAX_INVOKE_BODY_BYTES: limits.MAX_INVOKE_BODY_BYTES,
})

const GUARDED = 'src/upload-limits.ts'
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist'])
const SCAN_EXT = /\.(ts|mts|cts|js|mjs|cjs)$/

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full)
    } else if (SCAN_EXT.test(entry.name)) {
      files.push(full)
    }
  }
}
walk(join(root, 'src'))
walk(join(root, 'test'))
walk(join(root, 'scripts'))
walk(join(root, 'pwa'))
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && SCAN_EXT.test(entry.name)) files.push(join(root, entry.name))
}

for (const full of files) {
  const rel = relative(root, full).split('\\').join('/')
  if (rel === GUARDED) continue
  const text = readFileSync(full, 'utf8')
  for (const [name, bytes] of LIMIT_VALUES) {
    const mib = bytes / (1024 * 1024)
    const defines = new RegExp(
      `\\b(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*(?::[^=\\n]+)?=\\s*${mib}\\s*\\*\\s*1024\\s*\\*\\s*1024\\b`,
    )
    if (defines.test(text)) {
      failures.push(`${rel}: defines a ${mib} MiB upload-limit literal — import ${name} from src/upload-limits.ts instead`)
    }
  }
}

// -----------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`check-upload-limits: drift against src/upload-limits.ts:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(
  `check-upload-limits: docs state ${capMib} MiB, nginx covers it, one definition (src/upload-limits.ts) — ok`,
)
