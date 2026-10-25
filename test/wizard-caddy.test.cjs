/* dsh-zen-remote · managed Caddy (GW-3)
 *
 * caddy.js is pinned on the exact generated Caddyfile and its injection
 * guards; caddy-process.js is driven over a FAKE subprocess service (real
 * files, no exec) through the full start chain — ensureBinary cache hit
 * (GW-2 integration, the download path itself is wizard-binary's), .part
 * write, validate spawn, publish, run spawn — plus idempotency, validate
 * failure, exit cleanup, and the token-in-env-not-argv rule.
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'lib', 'wizard', rel)).href)

let caddy
let caddyProcess
let binary

const homes = []

before(async () => {
  caddy = await load('caddy.js')
  caddyProcess = await load('caddy-process.js')
  binary = await load('binary.js')
})

after(() => new Promise((resolve) => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
  resolve()
}))

/** One fresh DSH_HOME per test — published Caddyfiles and installed
 * binaries must never leak between lifecycle cases. */
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-caddy-'))
  homes.push(home)
  return home
}

const VALID_INPUT = {
  domain: 'dsh.example.com',
  httpsPort: 8443,
  gatewayPort: 4088,
  storageDir: '/dsh/zen-remote-ingress/caddy-data',
}

/** A subprocess service that records every spawn. Children behave like the
 * real things: a `validate` child exits on its own with `validateExit`
 * (microtask), a `run` child stays alive (`runExit: null`) until the test
 * finishes or terminates it. */
function fakeSubprocess() {
  const spawns = []
  const handles = []
  const service = {
    spawns,
    handles,
    validateExit: 0,
    runExit: null,
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
      const isValidate = definition.argv.includes('validate')
      const exit = isValidate ? service.validateExit : service.runExit
      if (exit !== null) queueMicrotask(() => resolveDone({ exitCode: exit, signal: null }))
      return handle
    },
  }
  return service
}

/** Pre-install a fake executable so ensureBinary cache-hits without any
 * network (GW-2's contract; the download chain is wizard-binary's). */
function installFakeBinary(dshHome) {
  const binaryPath = binary.binaryInstallPath(dshHome, 'caddy')
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
  fs.writeFileSync(binaryPath, 'not-really-caddy')
  fs.chmodSync(binaryPath, 0o755)
  return binaryPath
}

const noFetch = () => { throw new Error('the binary must already be cached') }

// --- caddy.ts: generation -----------------------------------------------------

test('generateCaddyfile emits the full DNS-01 shape with the gateway port upstream', () => {
  const result = caddy.generateCaddyfile(VALID_INPUT)
  assert.equal(result.ok, true)
  assert.deepEqual(result.caddyfile.split('\n'), [
    '{',
    '\tacme_dns cloudflare {env.CF_API_TOKEN}',
    '\tstorage file_system "/dsh/zen-remote-ingress/caddy-data"',
    '\tadmin off',
    '}',
    '',
    'https://dsh.example.com:8443 {',
    '\treverse_proxy 127.0.0.1:4088',
    '}',
    '',
  ])
  assert.equal(result.domain, 'dsh.example.com')
  assert.equal(result.httpsPort, 8443)
})

test('generateCaddyfile refuses injection shapes: CRLF, braces, quotes, control chars in any field', () => {
  // Domain: hostOf already rejects everything but a bare hostname — the
  // CRLF/newline injection attempts land there.
  for (const bad of ['dsh.example.com\n}', 'evil{}', 'foo bar', 'https://x', 'x/y']) {
    assert.equal(caddy.generateCaddyfile({ ...VALID_INPUT, domain: bad }).error, 'bad-domain', String(bad))
  }
  // Storage path: quoted in the output, so quoting/block delimiters and
  // control characters are refused before they reach the file.
  for (const bad of ['/x\ny', '/x"y', '/x{y}', '/xy}', '']) {
    assert.equal(caddy.generateCaddyfile({ ...VALID_INPUT, storageDir: bad }).error, 'bad-storage', String(bad))
  }
  // Ports: out-of-band or junk-typed are refusals, never coerced.
  for (const bad of [0, -1, 70000, 4.5, '443', Number.NaN]) {
    assert.equal(caddy.generateCaddyfile({ ...VALID_INPUT, httpsPort: bad }).error, 'bad-https-port', String(bad))
    assert.equal(caddy.generateCaddyfile({ ...VALID_INPUT, gatewayPort: bad }).error, 'bad-gateway-port', String(bad))
  }
  // Token env var name: strict POSIX shape.
  assert.equal(caddy.generateCaddyfile({ ...VALID_INPUT, cfTokenEnvName: 'BAD NAME' }).error, 'bad-token-env')
  assert.equal(caddy.generateCaddyfile({ ...VALID_INPUT, cfTokenEnvName: 'lower' }).error, 'bad-token-env')
})

test('generateCaddyfile accepts IP-literal domains and a custom token env name', () => {
  const result = caddy.generateCaddyfile({ ...VALID_INPUT, domain: '192.168.1.10', cfTokenEnvName: 'MY_CF_TOKEN' })
  assert.equal(result.ok, true)
  assert.ok(result.caddyfile.includes('{env.MY_CF_TOKEN}'))
  assert.ok(result.caddyfile.includes('https://192.168.1.10:8443 {'))
})

// --- caddy-process.ts: lifecycle ----------------------------------------------

test('start: binary cache hit → validate → publish → run, token in env only', async () => {
  const home = freshHome()
  const subprocess = fakeSubprocess()
  const binaryPath = installFakeBinary(home)
  const manager = caddyProcess.createCaddyManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  const token = 'cf-secret-token-material'
  const result = await manager.start({ ...VALID_INPUT, cfToken: token })
  assert.deepEqual(result, { ok: true, binaryPath, caddyfile: binary.caddyfilePath(home), alreadyRunning: false })
  assert.equal(manager.isRunning(), true)
  assert.equal(manager.runningCaddyfile(), binary.caddyfilePath(home))

  // Two spawns: validate against the .part, then run against the published file.
  assert.equal(subprocess.spawns.length, 2)
  const [validate, run] = subprocess.spawns
  assert.deepEqual(validate.argv, [binaryPath, 'validate', '--config', `${binary.caddyfilePath(home)}.part`, '--adapter', 'caddyfile'])
  assert.deepEqual(run.argv, [binaryPath, 'run', '--config', binary.caddyfilePath(home)])
  // The token NEVER rides argv (ps-visible) — only the environment.
  for (const spawn of subprocess.spawns) {
    assert.ok(!JSON.stringify(spawn.argv).includes(token), 'no token in argv')
  }
  assert.equal(validate.env.CF_API_TOKEN, token)
  assert.equal(run.env.CF_API_TOKEN, token)

  // The published Caddyfile carries exactly the generated bytes; no part leftover.
  const published = fs.readFileSync(binary.caddyfilePath(home), 'utf8')
  assert.equal(published, caddy.generateCaddyfile(VALID_INPUT).caddyfile)
  assert.ok(!fs.existsSync(`${binary.caddyfilePath(home)}.part`))
  manager.stop()
})

test('a live Caddy refuses a second start; stop is idempotent and re-allows start', async () => {
  const home = freshHome()
  const subprocess = fakeSubprocess()
  installFakeBinary(home)
  const manager = caddyProcess.createCaddyManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  const first = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.equal(first.ok, true)
  const second = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.deepEqual(second, { ok: false, error: 'already-running' })
  assert.equal(subprocess.spawns.length, 2, 'no extra spawn happened')

  manager.stop()
  manager.stop()
  assert.equal(manager.isRunning(), false)
  assert.equal(subprocess.handles[1].terminated, true, 'the run child was terminated')
  assert.equal(subprocess.handles[0].terminated, false, 'the validate child was left alone (it already exited)')

  const third = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.equal(third.ok, true, 'a stopped manager starts again')
  assert.equal(subprocess.spawns.length, 4)
  manager.stop()
})

test('validate failure publishes nothing and starts nothing', async () => {
  const home = freshHome()
  const subprocess = fakeSubprocess()
  subprocess.validateExit = 1
  installFakeBinary(home)
  const manager = caddyProcess.createCaddyManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  const result = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.deepEqual(result, { ok: false, error: 'validate-failed' })
  assert.equal(subprocess.spawns.length, 1, 'no run spawn after a failed validate')
  assert.equal(manager.isRunning(), false)
  assert.ok(!fs.existsSync(binary.caddyfilePath(home)), 'no Caddyfile published')
  assert.ok(!fs.existsSync(`${binary.caddyfilePath(home)}.part`), 'no part leftover')
})

test('an exited child clears its own slot; the next start works', async () => {
  const home = freshHome()
  const subprocess = fakeSubprocess()
  subprocess.runExit = 0 // the run child exits on its own, like a crash
  installFakeBinary(home)
  const manager = caddyProcess.createCaddyManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  const first = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.equal(first.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(manager.isRunning(), false, 'the slot cleared itself')
  const second = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.equal(second.ok, true, 'start works again without a manual stop')
  manager.stop()
})

test('missing token and bad config refuse before anything spawns', async () => {
  const home = freshHome()
  const subprocess = fakeSubprocess()
  installFakeBinary(home)
  const manager = caddyProcess.createCaddyManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  assert.deepEqual(await manager.start({ ...VALID_INPUT, cfToken: '   ' }), { ok: false, error: 'missing-token' })
  assert.deepEqual(
    await manager.start({ ...VALID_INPUT, cfToken: 't', domain: 'not a domain' }),
    { ok: false, error: 'bad-config', detail: 'bad-domain' },
  )
  assert.equal(subprocess.spawns.length, 0, 'nothing was spawned')
})
