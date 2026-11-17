import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, 'test')

const rawConcurrency = Number(process.env.ZR_TEST_CONCURRENCY)
const defaultConcurrency = Math.max(1, Math.min(os.availableParallelism(), 6))
const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1
  ? Math.floor(rawConcurrency)
  : defaultConcurrency

const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.cjs') || name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join('test', name))

const extraArgs = process.argv.slice(2)
const nodeArgs = ['--test', `--test-concurrency=${concurrency}`, ...extraArgs, ...testFiles]
const testRun = spawnSync(process.execPath, nodeArgs, { cwd: root, stdio: 'inherit' })
if (testRun.status !== 0) process.exit(testRun.status ?? 1)

