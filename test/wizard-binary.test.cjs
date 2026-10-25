/* dsh-zen-remote · ingress binary management (GW-2)
 *
 * The pure half (lib/wizard/binary.js) is pinned on URL shapes, platform
 * mapping and install paths; the I/O half (lib/wizard/binary-io.js) is
 * driven over a real local HTTP server for downloads, a hand-built
 * gzipped-tar for the darwin `.tgz` path, and real files for the cache
 * decision — everything under a throwaway DSH_HOME, no network beyond
 * loopback, no child processes anywhere (the module must not need them).
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { pathToFileURL } = require('node:url')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'lib', 'wizard', rel)).href)

let binary
let binaryIo

let home
let server
let port
/** Requests the mock server answered, as { path, status }. */
const seen = []

before(async () => {
  binary = await load('binary.js')
  binaryIo = await load('binary-io.js')
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-binary-'))
  server = http.createServer((req, res) => {
    const body = server.bodies[String(req.url).split('?')[0]]
    seen.push({ path: req.url, status: body === undefined ? 404 : 200 })
    if (body === undefined) {
      res.writeHead(404, { 'Content-Length': '0' })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) })
    res.end(body)
  })
  server.bodies = {}
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(() => new Promise((resolve) => {
  fs.rmSync(home, { recursive: true, force: true })
  server.close(resolve)
}))

/** A local URL on the mock server. */
const mockUrl = (name) => `http://127.0.0.1:${port}/${name}`

/** A minimal ustar archive around one regular file, ready to gzip. */
function tarOf(name, content) {
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, 'ascii')
  header.write('0000644', 100, 'ascii')
  header.write(content.length.toString(8).padStart(11, '0') + ' ', 124, 'ascii')
  header.write('      ', 148, 'ascii') // checksum placeholder as spaces
  header.write('0', 156, 'ascii') // typeflag: regular file
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0)
  return Buffer.concat([header, Buffer.from(content), padding, Buffer.alloc(1024, 0)])
}

// --- the pure half: URLs, platforms, paths -----------------------------------

test('binaryUrls maps every supported platform to both official endpoints', async () => {
  const darwinArm = binary.binaryUrls({ os: 'darwin', arch: 'arm64' })
  assert.equal(darwinArm.caddy, 'https://caddyserver.com/api/download?os=darwin&arch=arm64&p=github.com/caddy-dns/cloudflare')
  assert.equal(darwinArm.cloudflared, 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz')
  assert.equal(darwinArm.cloudflaredArchive, 'tgz')

  const linuxAmd = binary.binaryUrls({ os: 'linux', arch: 'amd64' })
  assert.equal(linuxAmd.caddy, 'https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/cloudflare')
  assert.equal(linuxAmd.cloudflared, 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64')
  assert.equal(linuxAmd.cloudflaredArchive, 'none')

  const winAmd = binary.binaryUrls({ os: 'windows', arch: 'amd64' })
  assert.equal(winAmd.cloudflared, 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe')
  assert.equal(winAmd.cloudflaredArchive, 'exe')

  const linuxArm = binary.binaryUrls({ os: 'linux', arch: 'arm64' })
  assert.equal(linuxArm.cloudflared, 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64')
  assert.equal(linuxArm.cloudflaredArchive, 'none')
})

test('currentPlatform maps this process into the supported set', async () => {
  const p = binary.currentPlatform()
  assert.ok(['darwin', 'linux', 'windows'].includes(p.os), 'os is one of the three')
  assert.ok(['amd64', 'arm64'].includes(p.arch), 'arch is one of the two')
  assert.equal(p.os, process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux')
  assert.equal(p.arch, process.arch === 'arm64' ? 'arm64' : 'amd64')
})

test('install paths sit under <DSH_HOME>/zen-remote-ingress/bin; windows gains .exe', async () => {
  assert.equal(binary.ingressDir('/dsh'), path.join('/dsh', 'zen-remote-ingress'))
  assert.equal(binary.binDir('/dsh'), path.join('/dsh', 'zen-remote-ingress', 'bin'))
  assert.equal(binary.binaryInstallPath('/dsh', 'caddy', { os: 'linux', arch: 'amd64' }), path.join('/dsh', 'zen-remote-ingress', 'bin', 'caddy'))
  assert.equal(binary.binaryInstallPath('/dsh', 'cloudflared', { os: 'darwin', arch: 'arm64' }), path.join('/dsh', 'zen-remote-ingress', 'bin', 'cloudflared'))
  assert.equal(binary.binaryInstallPath('/dsh', 'caddy', { os: 'windows', arch: 'amd64' }), path.join('/dsh', 'zen-remote-ingress', 'bin', 'caddy.exe'))
  assert.equal(binary.binaryFileName('cloudflared', { os: 'windows', arch: 'amd64' }), 'cloudflared.exe')
  assert.equal(binary.binaryFileName('cloudflared', { os: 'linux', arch: 'arm64' }), 'cloudflared')
  assert.equal(binary.dshHomeDefault({ DSH_HOME: '/custom' }), '/custom')
  assert.ok(String(binary.dshHomeDefault({})).length > 1, 'the default falls to the OS home convention')
})

test('manual install links exist for both tools', async () => {
  assert.match(binary.MANUAL_INSTALL_LINKS.caddy, /^https:\/\//)
  assert.match(binary.MANUAL_INSTALL_LINKS.cloudflared, /^https:\/\//)
})

// --- the I/O half: cache probe -------------------------------------------------

test('binaryPath answers the path only for an existing executable file', async () => {
  const installPath = binary.binaryInstallPath(home, 'caddy', { os: 'linux', arch: 'amd64' })
  assert.equal(binaryIo.binaryPath(home, 'caddy', { os: 'linux', arch: 'amd64' }), undefined, 'nothing installed yet')
  fs.mkdirSync(path.dirname(installPath), { recursive: true })
  fs.writeFileSync(installPath, '#!/bin/sh\n')
  fs.chmodSync(installPath, 0o644)
  assert.equal(binaryIo.binaryPath(home, 'caddy', { os: 'linux', arch: 'amd64' }), undefined, 'non-executable does not count')
  fs.chmodSync(installPath, 0o755)
  assert.equal(binaryIo.binaryPath(home, 'caddy', { os: 'linux', arch: 'amd64' }), installPath)
  fs.rmSync(installPath)
})

test('ensureBinary short-circuits on an installed executable without any network call', async () => {
  const installPath = binary.binaryInstallPath(home, 'cloudflared', { os: 'linux', arch: 'amd64' })
  fs.mkdirSync(path.dirname(installPath), { recursive: true })
  fs.writeFileSync(installPath, 'binary-bytes')
  fs.chmodSync(installPath, 0o755)
  const result = await binaryIo.ensureBinary(home, 'cloudflared', {
    platform: { os: 'linux', arch: 'amd64' },
    fetchImpl: () => { throw new Error('the cache must answer before any fetch') },
  })
  assert.deepEqual(result, { path: installPath, downloaded: false })
  fs.rmSync(installPath)
})

// --- the I/O half: downloads ----------------------------------------------------

test('downloadBinary installs a bare binary with 0755 atomically', async () => {
  const payload = Buffer.from('#!/bin/sh\necho fake-cloudflared\n')
  server.bodies['/cloudflared-linux-amd64'] = payload
  const progress = []
  const installPath = await binaryIo.downloadBinary(home, 'cloudflared', mockUrl('cloudflared-linux-amd64'), {
    platform: { os: 'linux', arch: 'amd64' },
    onProgress: (received, total) => progress.push([received, total]),
  })
  assert.equal(installPath, binary.binaryInstallPath(home, 'cloudflared', { os: 'linux', arch: 'amd64' }))
  assert.deepEqual(fs.readFileSync(installPath), payload)
  assert.equal(fs.statSync(installPath).mode & 0o777, 0o755, 'the image is installed executable')
  assert.ok(!fs.existsSync(`${installPath}.part`), 'no .part leftover')
  assert.ok(progress.length > 0 && progress.at(-1)[0] === payload.length, 'progress reports the full byte count')
  assert.equal(progress.at(-1)[1], payload.length, 'the declared total rides along')
  // A follow-up ensure is a cache hit now.
  const ensured = await binaryIo.ensureBinary(home, 'cloudflared', {
    platform: { os: 'linux', arch: 'amd64' },
    fetchImpl: () => { throw new Error('already installed') },
  })
  assert.deepEqual(ensured, { path: installPath, downloaded: false })
  fs.rmSync(installPath)
})

test('downloadBinary unpacks a .tgz archive (the darwin cloudflared shape)', async () => {
  const payload = Buffer.from('fake-cloudflared-mach-o')
  server.bodies['/cloudflared-darwin-arm64.tgz'] = zlib.gzipSync(tarOf('cloudflared', payload))
  const installPath = await binaryIo.downloadBinary(home, 'cloudflared', mockUrl('cloudflared-darwin-arm64.tgz'), {
    platform: { os: 'darwin', arch: 'arm64' },
  })
  assert.equal(installPath, binary.binaryInstallPath(home, 'cloudflared', { os: 'darwin', arch: 'arm64' }))
  assert.deepEqual(fs.readFileSync(installPath), payload, 'the archive entry landed as the installed image')
  assert.equal(fs.statSync(installPath).mode & 0o777, 0o755)
  assert.ok(!fs.existsSync(`${installPath}.download.tgz`), 'the archive sibling is cleaned up')
  fs.rmSync(installPath)
})

test('a corrupt archive is a typed download failure, not corrupt bytes on disk', async () => {
  server.bodies['/broken.tgz'] = zlib.gzipSync(Buffer.from('not a tar at all'))
  await assert.rejects(
    binaryIo.downloadBinary(home, 'cloudflared', mockUrl('broken.tgz'), { platform: { os: 'darwin', arch: 'arm64' } }),
    (error) => {
      assert.equal(error.code, 'download-failed')
      assert.equal(error.name, 'BinaryDownloadError')
      assert.equal(error.installUrl, binary.MANUAL_INSTALL_LINKS.cloudflared)
      return true
    },
  )
  assert.equal(binaryIo.binaryPath(home, 'cloudflared', { os: 'darwin', arch: 'arm64' }), undefined, 'nothing was installed')
})

test('an HTTP error answer and a dead endpoint both become typed download-failed errors', async () => {
  const failure = await binaryIo.downloadBinary(home, 'caddy', mockUrl('/missing'), { platform: { os: 'linux', arch: 'amd64' } })
    .then(() => { throw new Error('must have failed') }, (error) => error)
  assert.equal(failure.code, 'download-failed')
  assert.equal(failure.status, 404)
  assert.equal(failure.tool, 'caddy')
  assert.equal(failure.installUrl, binary.MANUAL_INSTALL_LINKS.caddy)
  assert.ok(failure.url.endsWith('/missing'))

  // A closed port: the transport fails before any answer exists.
  const deadServer = http.createServer()
  await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve))
  const deadPort = deadServer.address().port
  await new Promise((resolve) => deadServer.close(resolve))
  const transport = await binaryIo.downloadBinary(home, 'caddy', `http://127.0.0.1:${deadPort}/caddy`, { platform: { os: 'linux', arch: 'amd64' } })
    .then(() => { throw new Error('must have failed') }, (error) => error)
  assert.equal(transport.code, 'download-failed')
  assert.equal(transport.status, null, 'no answer, no status')
  assert.equal(binaryIo.binaryPath(home, 'caddy', { os: 'linux', arch: 'amd64' }), undefined)
})
