/* dsh-zen-remote · cloudflared lifecycle (GW-7)
 *
 * The REAL manager (lib/wizard/cloudflared.js) over a FAKE subprocess
 * service and real files: the token file lands 0600 through an atomic
 * rename, the connector secret travels by --token-file (never argv, never
 * env), start is idempotent, stop is idempotent, and an exited child
 * clears its own slot. The binary comes from GW-2's cache path (a
 * pre-installed executable; the download chain is wizard-binary's). Each
 * test gets a fresh temp home so file assertions never see a sibling's
 * leftovers.
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'lib', 'wizard', rel)).href)

let cloudflared
let binary

const homes = []

before(async () => {
  cloudflared = await load('cloudflared.js')
  binary = await load('binary.js')
})

after(() => new Promise((resolve) => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
  resolve()
}))

/** One fresh DSH_HOME per test. */
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-cflared-'))
  homes.push(home)
  return home
}

/** Same recorder shape the caddy tests use; run children stay alive until
 * finished or terminated. */
function fakeSubprocess() {
  const spawns = []
  const handles = []
  const service = {
    spawns,
    handles,
    spawn(definition) {
      spawns.push(definition)
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      const handle = {
        argv: definition.argv,
        env: definition.env,
        terminated: false,
        done,
        terminate() {
          this.terminated = true
          resolveDone({ exitCode: null, signal: 'SIGTERM' })
          return Promise.resolve()
        },
        finish(exitCode) { resolveDone({ exitCode, signal: null }) },
      }
      handles.push(handle)
      return handle
    },
  }
  return service
}

function installFakeBinary(home) {
  const binaryPath = binary.binaryInstallPath(home, 'cloudflared')
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
  fs.writeFileSync(binaryPath, 'not-really-cloudflared')
  fs.chmodSync(binaryPath, 0o755)
  return binaryPath
}

const noFetch = () => { throw new Error('the binary must already be cached') }

test('start: token file 0600 via atomic rename, secret by --token-file only', async () => {
  const home = freshHome()
  const subprocess = fakeSubprocess()
  const binaryPath = installFakeBinary(home)
  const manager = cloudflared.createCloudflaredManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  const secret = 'tunnel-connector-secret-material'
  const result = await manager.start({ tunnelToken: secret })
  const tokenFile = cloudflared.tunnelTokenPath(home)
  assert.deepEqual(result, { ok: true, binaryPath, tokenFile, alreadyRunning: false })
  assert.equal(manager.isRunning(), true)

  // The token file: exact content, owner-only mode, no temp leftover.
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), secret)
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600)
  assert.ok(!fs.existsSync(`${tokenFile}.part`))

  // One spawn: tunnel run --token-file <path>. No secret in argv, none in env.
  assert.equal(subprocess.spawns.length, 1)
  const spawn = subprocess.spawns[0]
  assert.deepEqual(spawn.argv, [binaryPath, 'tunnel', 'run', '--token-file', tokenFile])
  assert.ok(!JSON.stringify(spawn.argv).includes(secret), 'no secret in argv')
  assert.equal(spawn.env.TUNNEL_TOKEN, undefined)
  assert.ok(!JSON.stringify(spawn.env).includes(secret), 'no secret in the child env')

  manager.stop()
})

test('a live cloudflared refuses a second start; stop is idempotent; exit clears the slot', async () => {
  const home = freshHome()
  const subprocess = fakeSubprocess()
  installFakeBinary(home)
  const manager = cloudflared.createCloudflaredManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  assert.equal((await manager.start({ tunnelToken: 't' })).ok, true)
  assert.deepEqual(await manager.start({ tunnelToken: 't' }), { ok: false, error: 'already-running' })
  assert.equal(subprocess.spawns.length, 1)

  manager.stop()
  manager.stop()
  assert.equal(manager.isRunning(), false)
  assert.equal(subprocess.handles[0].terminated, true)
  assert.equal((await manager.start({ tunnelToken: 't' })).ok, true, 'a stopped manager starts again')

  // Crash cleanup: the child finishing on its own frees the slot.
  subprocess.handles[1].finish(1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(manager.isRunning(), false)
  assert.equal((await manager.start({ tunnelToken: 't' })).ok, true)
  manager.stop()
})

test('missing token refuses before anything happens', async () => {
  const home = freshHome()
  const subprocess = fakeSubprocess()
  installFakeBinary(home)
  const manager = cloudflared.createCloudflaredManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  assert.deepEqual(await manager.start({ tunnelToken: '   ' }), { ok: false, error: 'missing-token' })
  assert.equal(subprocess.spawns.length, 0)
  assert.ok(!fs.existsSync(cloudflared.tunnelTokenPath(home)), 'no token file was written')
})
