/**
 * Rewrite the version strings embedded in both READMEs to match package.json,
 * and synchronize root `package.json#gatewayVersion` from
 * `gateway-server/package.json#version` when the gateway subpackage is present.
 *
 * Runs before `build` and during `npm version` (before the release commit),
 * and runs with `--check` at the end of `pnpm test` to fail loudly on drift.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.ZR_SYNC_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..')
const rootPkgPath = join(root, 'package.json')
const rootPkgRaw = readFileSync(rootPkgPath, 'utf8')
const rootPkg = JSON.parse(rootPkgRaw)
const version = rootPkg.version
const checkOnly = process.argv.includes('--check')

const missing = []
const drifted = []

// 1. Sync / verify root package.json#gatewayVersion <-> gateway-server/package.json#version
const gatewayPkgPath = join(root, 'gateway-server', 'package.json')
let nextRootPkgRaw = null

if (existsSync(gatewayPkgPath)) {
  const gatewayPkg = JSON.parse(readFileSync(gatewayPkgPath, 'utf8'))
  const gwVersion = typeof gatewayPkg.version === 'string' ? gatewayPkg.version.trim() : ''
  if (!gwVersion) {
    missing.push('gateway-server/package.json: version field is missing or empty')
  } else {
    if (rootPkg.gatewayVersion !== gwVersion) {
      drifted.push(`package.json: gatewayVersion (${rootPkg.gatewayVersion ?? '<missing>'}) -> ${gwVersion}`)
      const updated = {}
      let inserted = false
      for (const [k, v] of Object.entries(rootPkg)) {
        if (k === 'gatewayVersion') {
          updated[k] = gwVersion
          inserted = true
        } else {
          updated[k] = v
          if (k === 'version' && !('gatewayVersion' in rootPkg)) {
            updated.gatewayVersion = gwVersion
            inserted = true
          }
        }
      }
      if (!inserted) updated.gatewayVersion = gwVersion
      const trailingNl = rootPkgRaw.endsWith('\n') ? '\n' : ''
      nextRootPkgRaw = JSON.stringify(updated, null, 2) + trailingNl
    }

    // Warn only during explicit release checks / `npm version` if gateway-v<ver> is missing or has unreleased commits
    const releaseCheck = process.argv.includes('--release-check') || process.env.npm_lifecycle_event === 'version'
    if (releaseCheck) {
      const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' })
      if (inRepo.status === 0) {
        const tagName = `gateway-v${gwVersion}`
        const tagCheck = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`], {
          cwd: root,
          encoding: 'utf8',
        })
        if (tagCheck.status !== 0) {
          console.warn(
            `\x1b[33msync-doc-version: WARNING — tag ${tagName} does not exist locally yet (gateway-server/package.json#version is ${gwVersion}). Tag and push ${tagName} before cutting a main plugin release.\x1b[0m`,
          )
        } else {
          const revCount = spawnSync('git', ['rev-list', '--count', `${tagName}..HEAD`, '--', 'gateway-server/src'], {
            cwd: root,
            encoding: 'utf8',
          })
          const count = Number.parseInt((revCount.stdout || '').trim(), 10)
          if (revCount.status === 0 && Number.isFinite(count) && count > 0) {
            console.warn(
              `\x1b[33msync-doc-version: WARNING — gateway-server/src has ${count} commit(s) since tag ${tagName}, but gateway-server/package.json#version is still ${gwVersion}. Consider bumping gateway-server version.\x1b[0m`,
            )
          }
        }
      }
    }
  }
}

// 2. Sync / verify README dependency markers
const targets = ['README.md', 'README.zh-CN.md'].flatMap((file) => [
  {
    file,
    label: 'profile dependency example',
    pattern: /"dsh-zen-remote": "\^\d+\.\d+\.\d+"/,
    replace: `"dsh-zen-remote": "^${version}"`,
  },
])

const edits = new Map()

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
    console.log(`sync-doc-version: docs & gatewayVersion already at ${version} / ${rootPkg.gatewayVersion ?? 'n/a'}`)
    process.exit(0)
  }
  console.error(`sync-doc-version: out of date (plugin ${version}):\n  ${drifted.join('\n  ')}`)
  process.exit(1)
}

if (nextRootPkgRaw !== null) writeFileSync(rootPkgPath, nextRootPkgRaw)
for (const [file, content] of edits) writeFileSync(join(root, file), content)
console.log(
  drifted.length === 0
    ? `sync-doc-version: docs & gatewayVersion already at ${version} / ${rootPkg.gatewayVersion ?? 'n/a'}`
    : `sync-doc-version: synced to ${version}\n  ${drifted.join('\n  ')}`,
)
