/**
 * Rewrite the version strings embedded in both READMEs to match package.json.
 *
 * Runs from the `version` npm lifecycle script, which fires AFTER the version
 * bump and BEFORE the release commit — so `npm version patch` carries the
 * refreshed README into the same commit instead of leaving the badge stuck on
 * whatever it said at 1.0.0 (it sat there through 1.0.1 and 1.0.2).
 *
 * Every target is required: an unmatched marker exits non-zero rather than
 * quietly succeeding, because a silent no-op is exactly the failure this
 * script exists to prevent. Idempotent — running it when nothing changed is a
 * no-op with exit 0.
 *
 * Also usable standalone: `node scripts/sync-doc-version.mjs [--check]`.
 * `--check` reports drift without writing, for CI.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const checkOnly = process.argv.includes('--check')

/**
 * Each target names the file, what it looks for, and what it becomes. Both
 * READMEs carry the same three markers, and both are required: a missing one
 * means the docs moved and this script has to be updated, which is the whole
 * point of failing loudly.
 */
const targets = ['README.md', 'README.zh-CN.md'].flatMap((file) => [
  {
    file,
    label: 'release badge',
    pattern: /badge\/release-v\d+\.\d+\.\d+-/,
    replace: `badge/release-v${version}-`,
  },
  {
    file,
    label: 'release badge alt text',
    pattern: /alt="v\d+\.\d+\.\d+"/,
    replace: `alt="v${version}"`,
  },
  {
    file,
    label: 'profile dependency example',
    pattern: /"dsh-zen-remote": "\^\d+\.\d+\.\d+"/,
    replace: `"dsh-zen-remote": "^${version}"`,
  },
])

const edits = new Map()
const missing = []
const drifted = []

for (const target of targets) {
  const path = join(root, target.file)
  const before = edits.get(target.file) ?? readFileSync(path, 'utf8')
  if (!target.pattern.test(before)) {
    missing.push(`${target.file}: ${target.label} (${target.pattern})`)
    continue
  }
  const after = before.replace(target.pattern, target.replace)
  if (after !== before) drifted.push(`${target.file}: ${target.label} -> ${target.replace}`)
  edits.set(target.file, after)
}

if (missing.length > 0) {
  console.error(`sync-doc-version: marker not found — the docs moved, update this script:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

if (checkOnly) {
  if (drifted.length === 0) {
    console.log(`sync-doc-version: docs already at ${version}`)
    process.exit(0)
  }
  console.error(`sync-doc-version: docs are out of date (package.json is ${version}):\n  ${drifted.join('\n  ')}`)
  process.exit(1)
}

for (const [file, content] of edits) writeFileSync(join(root, file), content)
console.log(
  drifted.length === 0
    ? `sync-doc-version: docs already at ${version}`
    : `sync-doc-version: synced to ${version}\n  ${drifted.join('\n  ')}`,
)
