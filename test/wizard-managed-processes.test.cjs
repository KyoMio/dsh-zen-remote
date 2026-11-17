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
let cloudflared
let binary

const homes = []

before(async () => {
  caddy = await load('caddy.js')
  caddyProcess = await load('caddy-process.js')
  cloudflared = await load('cloudflared.js')
  binary = await load('binary.js')
})

after(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
})

function freshHome(prefix = 'dsh-zen-remote-proc-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  homes.push(home)
  return home
}

const VALID_INPUT = {
  domain: 'dsh.example.com',
  httpsPort: 8443,
  gatewayPort: 4088,
  storageDir: '/dsh/zen-remote-ingress/caddy-data',
}

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

function installFakeBinary(dshHome, name) {
  const binaryPath = binary.binaryInstallPath(dshHome, name)
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
  fs.writeFileSync(binaryPath, `not-really-${name}`)
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
  for (const bad of ['dsh.example.com\n}', 'evil{}', 'foo bar', 'https://x', 'x/y']) {
    assert.equal(caddy.generateCaddyfile({ ...VALID_INPUT, domain: bad }).error, 'bad-domain', String(bad))
  }
  for (const bad of ['/x\ny', '/x"y', '/x{y}', '/xy}', '']) {
    assert.equal(caddy.generateCaddyfile({ ...VALID_INPUT, storageDir: bad }).error, 'bad-storage', String(bad))
  }
  for (const bad of [0, -1, 70000, 4.5, '443', Number.NaN]) {
    assert.equal(caddy.generateCaddyfile({ ...VALID_INPUT, httpsPort: bad }).error, 'bad-https-port', String(bad))
    assert.equal(caddy.generateCaddyfile({ ...VALID_INPUT, gatewayPort: bad }).error, 'bad-gateway-port', String(bad))
  }
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

test('caddy start: binary cache hit → validate → publish → run, token in env only', async (t) => {
  const home = freshHome('dsh-zen-remote-caddy-')
  const subprocess = fakeSubprocess()
  const binaryPath = installFakeBinary(home, 'caddy')
  const manager = caddyProcess.createCaddyManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  const token = 'cf-secret-token-material'
  const prevSecret = process.env.LAN_GATE_RELAY_SECRET
  process.env.LAN_GATE_RELAY_SECRET = 'f'.repeat(64)
  t.after(() => {
    manager.stop()
    if (prevSecret === undefined) delete process.env.LAN_GATE_RELAY_SECRET
    else process.env.LAN_GATE_RELAY_SECRET = prevSecret
  })

  const result = await manager.start({ ...VALID_INPUT, cfToken: token })
  assert.deepEqual(result, { ok: true, binaryPath, caddyfile: binary.caddyfilePath(home), alreadyRunning: false })
  assert.equal(manager.isRunning(), true)
  assert.equal(manager.runningCaddyfile(), binary.caddyfilePath(home))

  assert.equal(subprocess.spawns.length, 2)
  const [validate, run] = subprocess.spawns
  assert.deepEqual(validate.argv, [binaryPath, 'validate', '--config', `${binary.caddyfilePath(home)}.part`, '--adapter', 'caddyfile'])
  assert.deepEqual(run.argv, [binaryPath, 'run', '--config', binary.caddyfilePath(home)])
  for (const spawn of subprocess.spawns) {
    assert.ok(!JSON.stringify(spawn.argv).includes(token))
  }
  assert.equal(validate.env.CF_API_TOKEN, token)
  assert.equal(run.env.CF_API_TOKEN, token)

  const WHITELIST = new Set([
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ',
    'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP',
    'CF_API_TOKEN',
  ])
  for (const spawn of subprocess.spawns) {
    for (const key of Object.keys(spawn.env)) {
      assert.ok(WHITELIST.has(key), `env key ${key} must be whitelisted`)
    }
    assert.ok(!JSON.stringify(spawn.env).includes('f'.repeat(64)))
  }

  const published = fs.readFileSync(binary.caddyfilePath(home), 'utf8')
  assert.equal(published, caddy.generateCaddyfile({ ...VALID_INPUT, storageDir: binary.caddyDataDir(home) }).caddyfile)
  assert.ok(published.includes(`storage file_system "${binary.caddyDataDir(home)}"`))
  assert.ok(!fs.existsSync(`${binary.caddyfilePath(home)}.part`))
})

test('a live Caddy refuses a second start; stop is idempotent and re-allows start', async () => {
  const home = freshHome('dsh-zen-remote-caddy-')
  const subprocess = fakeSubprocess()
  installFakeBinary(home, 'caddy')
  const manager = caddyProcess.createCaddyManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  const first = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.equal(first.ok, true)
  const second = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.deepEqual(second, { ok: false, error: 'already-running' })
  assert.equal(subprocess.spawns.length, 2)

  manager.stop()
  manager.stop()
  assert.equal(manager.isRunning(), false)
  assert.equal(subprocess.handles[1].terminated, true)
  assert.equal(subprocess.handles[0].terminated, false)

  const third = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.equal(third.ok, true)
  assert.equal(subprocess.spawns.length, 4)
  manager.stop()
})

test('caddy validate failure publishes nothing and starts nothing', async () => {
  const home = freshHome('dsh-zen-remote-caddy-')
  const subprocess = fakeSubprocess()
  subprocess.validateExit = 1
  installFakeBinary(home, 'caddy')
  const manager = caddyProcess.createCaddyManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  const result = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.deepEqual(result, { ok: false, error: 'validate-failed' })
  assert.equal(subprocess.spawns.length, 1)
  assert.equal(manager.isRunning(), false)
  assert.ok(!fs.existsSync(binary.caddyfilePath(home)))
  assert.ok(!fs.existsSync(`${binary.caddyfilePath(home)}.part`))
})

test('caddy: an exited child clears its own slot; the next start works', async () => {
  const home = freshHome('dsh-zen-remote-caddy-')
  const subprocess = fakeSubprocess()
  subprocess.runExit = 0
  installFakeBinary(home, 'caddy')
  const manager = caddyProcess.createCaddyManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  const first = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.equal(first.ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manager.isRunning(), false)
  const second = await manager.start({ ...VALID_INPUT, cfToken: 't' })
  assert.equal(second.ok, true)
  manager.stop()
})

test('caddy missing token and bad config refuse before anything spawns', async () => {
  const home = freshHome('dsh-zen-remote-caddy-')
  const subprocess = fakeSubprocess()
  installFakeBinary(home, 'caddy')
  const manager = caddyProcess.createCaddyManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  assert.deepEqual(await manager.start({ ...VALID_INPUT, cfToken: '   ' }), { ok: false, error: 'missing-token' })
  assert.deepEqual(
    await manager.start({ ...VALID_INPUT, cfToken: 't', domain: 'not a domain' }),
    { ok: false, error: 'bad-config', detail: 'bad-domain' },
  )
  assert.equal(subprocess.spawns.length, 0)
})

// --- cloudflared.ts: lifecycle ------------------------------------------------

test('cloudflared start: token file 0600 via atomic rename, secret by --token-file only', async (t) => {
  const home = freshHome('dsh-zen-remote-cflared-')
  const subprocess = fakeSubprocess()
  const binaryPath = installFakeBinary(home, 'cloudflared')
  const manager = cloudflared.createCloudflaredManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  const secret = 'tunnel-connector-secret-material'
  const prevSecret = process.env.LAN_GATE_RELAY_SECRET
  t.after(() => {
    manager.stop()
    if (prevSecret === undefined) delete process.env.LAN_GATE_RELAY_SECRET
    else process.env.LAN_GATE_RELAY_SECRET = prevSecret
  })

  const result = await manager.start({ tunnelToken: secret })
  const tokenFile = cloudflared.tunnelTokenPath(home)
  assert.deepEqual(result, { ok: true, binaryPath, tokenFile, alreadyRunning: false })
  assert.equal(manager.isRunning(), true)

  assert.equal(fs.readFileSync(tokenFile, 'utf8'), secret)
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600)
  assert.ok(!fs.existsSync(`${tokenFile}.part`))

  assert.equal(subprocess.spawns.length, 1)
  const spawn = subprocess.spawns[0]
  assert.deepEqual(spawn.argv, [binaryPath, 'tunnel', 'run', '--token-file', tokenFile])
  assert.ok(!JSON.stringify(spawn.argv).includes(secret))
  assert.equal(spawn.env.TUNNEL_TOKEN, undefined)
  assert.ok(!JSON.stringify(spawn.env).includes(secret))

  process.env.LAN_GATE_RELAY_SECRET = 'f'.repeat(64)
  await manager.stop()
  subprocess.spawns.length = 0
  subprocess.handles.length = 0
  assert.equal((await manager.start({ tunnelToken: secret })).ok, true)
  const envKeys = Object.keys(subprocess.spawns[0].env)
  const WHITELIST = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ'])
  for (const key of envKeys) assert.ok(WHITELIST.has(key), `env key ${key} must be whitelisted`)
  assert.ok(!JSON.stringify(subprocess.spawns[0].env).includes('f'.repeat(64)))
})

test('a live cloudflared refuses a second start; stop is idempotent; exit clears the slot', async () => {
  const home = freshHome('dsh-zen-remote-cflared-')
  const subprocess = fakeSubprocess()
  installFakeBinary(home, 'cloudflared')
  const manager = cloudflared.createCloudflaredManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  assert.equal((await manager.start({ tunnelToken: 't' })).ok, true)
  assert.deepEqual(await manager.start({ tunnelToken: 't' }), { ok: false, error: 'already-running' })
  assert.equal(subprocess.spawns.length, 1)

  manager.stop()
  manager.stop()
  assert.equal(manager.isRunning(), false)
  assert.equal(subprocess.handles[0].terminated, true)
  assert.equal((await manager.start({ tunnelToken: 't' })).ok, true)

  subprocess.handles[1].finish(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manager.isRunning(), false)
  assert.equal((await manager.start({ tunnelToken: 't' })).ok, true)
  manager.stop()
})

test('cloudflared missing token refuses before anything happens', async () => {
  const home = freshHome('dsh-zen-remote-cflared-')
  const subprocess = fakeSubprocess()
  installFakeBinary(home, 'cloudflared')
  const manager = cloudflared.createCloudflaredManager({ subprocess, dshHome: home, fetchImpl: noFetch })
  assert.deepEqual(await manager.start({ tunnelToken: '   ' }), { ok: false, error: 'missing-token' })
  assert.equal(subprocess.spawns.length, 0)
  assert.ok(!fs.existsSync(cloudflared.tunnelTokenPath(home)))
})
