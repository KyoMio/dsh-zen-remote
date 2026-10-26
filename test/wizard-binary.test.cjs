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

/** Valid image magics for the install self-check (GW-fix-1/H1 item 4). */
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const MACH_O_LE64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
const elfPayload = (body) => Buffer.concat([ELF, Buffer.from(body)])
const machoPayload = (body) => Buffer.concat([MACH_O_LE64, Buffer.from(body)])

test('binaryUrls maps every supported platform to both official endpoints WITH archive shapes', async () => {
  const darwinArm = binary.binaryUrls({ os: 'darwin', arch: 'arm64' })
  assert.equal(darwinArm.caddy, 'https://caddyserver.com/api/download?os=darwin&arch=arm64&p=github.com/caddy-dns/cloudflare')
  assert.equal(darwinArm.caddyArchive, 'none', 'caddyserver.com/api/download returns a bare binary on unix')
  assert.equal(darwinArm.cloudflared, 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz')
  assert.equal(darwinArm.cloudflaredArchive, 'tgz')

  const linuxAmd = binary.binaryUrls({ os: 'linux', arch: 'amd64' })
  assert.equal(linuxAmd.caddy, 'https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/cloudflare')
  assert.equal(linuxAmd.caddyArchive, 'none')
  assert.equal(linuxAmd.cloudflared, 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64')
  assert.equal(linuxAmd.cloudflaredArchive, 'none')

  const winAmd = binary.binaryUrls({ os: 'windows', arch: 'amd64' })
  assert.equal(winAmd.caddyArchive, 'exe', 'caddyserver.com/api/download returns a bare .exe on Windows')
  assert.equal(winAmd.cloudflared, 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe')
  assert.equal(winAmd.cloudflaredArchive, 'exe')

  const linuxArm = binary.binaryUrls({ os: 'linux', arch: 'arm64' })
  assert.equal(linuxArm.cloudflared, 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64')
  assert.equal(linuxArm.cloudflaredArchive, 'none')

  // Prebuilt Caddy release + mainland China mirror ordering
  const cnCaddy = binary.binaryDownloadCandidates('caddy', { os: 'windows', arch: 'amd64' }, true)
  assert.ok(cnCaddy[0].url.startsWith('https://gh-proxy.com/https://github.com/KyoMio/dsh-zen-remote/releases/download/caddy-cloudflare/caddy-windows-amd64.exe'))
  assert.equal(cnCaddy[0].archive, 'exe')
  assert.ok(cnCaddy[1].url.startsWith('https://ghfast.top/'))
  assert.equal(cnCaddy[2].url, 'https://github.com/KyoMio/dsh-zen-remote/releases/download/caddy-cloudflare/caddy-windows-amd64.exe')
  assert.equal(cnCaddy[3].url, 'https://caddyserver.com/api/download?os=windows&arch=amd64&p=github.com/caddy-dns/cloudflare')

  const globalCaddy = binary.binaryDownloadCandidates('caddy', { os: 'darwin', arch: 'arm64' }, false)
  assert.equal(globalCaddy[0].url, 'https://github.com/KyoMio/dsh-zen-remote/releases/download/caddy-cloudflare/caddy-darwin-arm64.tgz')
  assert.equal(globalCaddy[0].archive, 'tgz')
  assert.ok(globalCaddy[1].url.startsWith('https://gh-proxy.com/'))
})

test('currentPlatform maps this process into the supported set (windows is amd64-only, GW-fix-1/L4)', async () => {
  const p = binary.currentPlatform()
  assert.ok(['darwin', 'linux', 'windows'].includes(p.os), 'os is one of the three')
  assert.ok(['amd64', 'arm64'].includes(p.arch), 'arch is one of the two')
  if (p.os === 'windows') assert.equal(p.arch, 'amd64', 'windows never claims arm64')
  assert.equal(p.os, process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux')
  assert.equal(p.arch, process.arch === 'arm64' ? 'arm64' : 'amd64')
  // caddyDownload models the archive per OS family, mirroring binaryUrls.
  assert.equal(binary.caddyDownload({ os: 'darwin', arch: 'arm64' }).archive, 'none')
  assert.equal(binary.caddyDownload({ os: 'linux', arch: 'amd64' }).archive, 'none')
  assert.equal(binary.caddyDownload({ os: 'windows', arch: 'amd64' }).archive, 'exe')
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

test('downloadBinary installs a bare binary with 0755 atomically (self-checked ELF magic)', async () => {
  const payload = elfPayload('#!/bin/sh\necho fake-cloudflared\n')
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

test('downloadBinary unpacks a .tgz archive (the darwin cloudflared shape) and self-checks the Mach-O magic', async () => {
  const payload = machoPayload('fake-cloudflared-mach-o-body')
  server.bodies['/cloudflared-darwin-arm64.tgz'] = zlib.gzipSync(tarOf('cloudflared', payload))
  const installPath = await binaryIo.downloadBinary(home, 'cloudflared', mockUrl('cloudflared-darwin-arm64.tgz'), {
    platform: { os: 'darwin', arch: 'arm64' },
    archive: 'tgz',
  })
  assert.equal(installPath, binary.binaryInstallPath(home, 'cloudflared', { os: 'darwin', arch: 'arm64' }))
  assert.deepEqual(fs.readFileSync(installPath), payload, 'the archive entry landed as the installed image')
  assert.equal(fs.statSync(installPath).mode & 0o777, 0o755)
  assert.ok(!fs.existsSync(`${installPath}.download.tgz`), 'the archive sibling is cleaned up')
  fs.rmSync(installPath)
})

test('GW-fix-1/H1: the Caddy bare-binary chain — download, self-check, install, cache hit', async () => {
  // The exact shape caddyserver.com/api/download answers with: a bare ELF or
  // Mach-O binary (`Content-Type: application/octet-stream`).
  const payload = elfPayload('fake-caddy-elf-body')
  server.bodies['/api/download'] = payload
  const ensured = await binaryIo.ensureBinary(home, 'caddy', {
    platform: { os: 'linux', arch: 'amd64' },
    fetchImpl: async (url) => {
      // Point the official URL at the mock server without touching network:
      // the fetch impl resolves the real URL, the server serves the bytes.
      const body = server.bodies[new URL(url).pathname]
      return new Response(body, { status: 200, headers: { 'Content-Length': String(body.length) } })
    },
  })
  assert.equal(ensured.downloaded, true)
  const installPath = ensured.path
  assert.equal(installPath, binary.binaryInstallPath(home, 'caddy', { os: 'linux', arch: 'amd64' }))
  assert.equal(installPath, path.join(home, 'zen-remote-ingress', 'bin', 'caddy'))
  assert.deepEqual(fs.readFileSync(installPath), payload, 'the caddy image landed byte-for-byte')
  assert.equal(fs.statSync(installPath).mode & 0o777, 0o755)
  assert.ok(!fs.existsSync(`${installPath}.download.tgz`), 'no archive leftover')
  assert.ok(!fs.existsSync(`${installPath}.part`), 'no .part leftover')
  // Second ensure: the cache answers, no fetch again.
  const again = await binaryIo.ensureBinary(home, 'caddy', {
    platform: { os: 'linux', arch: 'amd64' },
    fetchImpl: () => { throw new Error('cache must answer') },
  })
  assert.deepEqual(again, { path: installPath, downloaded: false })
  fs.rmSync(installPath)
})

test('GW-fix-1/H1: a zip archive is refused before any network traffic', async () => {
  let fetched = false
  const failure = await binaryIo.downloadBinary(home, 'caddy', mockUrl('whatever'), {
    platform: { os: 'windows', arch: 'amd64' },
    archive: 'zip',
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch') },
  }).then(() => { throw new Error('must have failed') }, (error) => error)
  assert.equal(failure.code, 'windows-zip-unsupported')
  assert.equal(failure.name, 'BinaryDownloadError')
  assert.equal(failure.installUrl, binary.MANUAL_INSTALL_LINKS.caddy)
  assert.equal(fetched, false, 'the refusal happens before the transport runs')
  assert.ok(!fs.existsSync(path.join(home, 'zen-remote-ingress', 'bin', 'caddy.exe')), 'nothing landed on disk')
})

test('GW-fix-1/H1: a payload without an executable magic is refused, leaving nothing on disk', async () => {
  // tgz whose entry is text, not an image: the unpack succeeds, the
  // self-check refuses, nothing is installed.
  server.bodies['/garbage-entry.tgz'] = zlib.gzipSync(tarOf('cloudflared', Buffer.from('plain text, not a binary')))
  const tgzFailure = await binaryIo.downloadBinary(home, 'cloudflared', mockUrl('garbage-entry.tgz'), {
    platform: { os: 'darwin', arch: 'arm64' },
    archive: 'tgz',
  }).then(() => { throw new Error('must have failed') }, (error) => error)
  assert.equal(tgzFailure.code, 'bad-binary-image')
  assert.equal(binaryIo.binaryPath(home, 'cloudflared', { os: 'darwin', arch: 'arm64' }), undefined, 'no tgz-path residue')
  assert.ok(!fs.existsSync(binary.binaryInstallPath(home, 'cloudflared', { os: 'darwin', arch: 'arm64' })))
  assert.ok(!fs.existsSync(`${binary.binaryInstallPath(home, 'cloudflared', { os: 'darwin', arch: 'arm64' })}.download.tgz`))

  // A bare download of non-image bytes: same verdict, no .part residue.
  server.bodies['/garbage-raw'] = Buffer.from('definitely not ELF or Mach-O')
  const bareFailure = await binaryIo.downloadBinary(home, 'cloudflared', mockUrl('garbage-raw'), {
    platform: { os: 'linux', arch: 'amd64' },
  }).then(() => { throw new Error('must have failed') }, (error) => error)
  assert.equal(bareFailure.code, 'bad-binary-image')
  const linuxPath = binary.binaryInstallPath(home, 'cloudflared', { os: 'linux', arch: 'amd64' })
  assert.ok(!fs.existsSync(linuxPath), 'no install residue')
  assert.ok(!fs.existsSync(`${linuxPath}.part`), 'no .part residue')
})

test('a corrupt archive is a typed download failure, not corrupt bytes on disk', async () => {
  server.bodies['/broken.tgz'] = zlib.gzipSync(Buffer.from('not a tar at all'))
  await assert.rejects(
    binaryIo.downloadBinary(home, 'cloudflared', mockUrl('broken.tgz'), { platform: { os: 'darwin', arch: 'arm64' }, archive: 'tgz' }),
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
