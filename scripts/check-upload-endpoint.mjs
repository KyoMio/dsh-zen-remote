// Integration check for the S7 upload route (src/index.ts handleUpload).
//
// Drives the real handler over a real node:http socket with a fake sessions
// service and a throwaway workspace, so the accept/reject decisions and the
// bytes that reach disk are the ones the phone would produce. No harness, no
// session, no message: writing a file into a workspace is not a prompt.
//
// Run: node scripts/check-upload-endpoint.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPLOAD_DIR, handleUpload, safeUploadName, sameOriginPost } from '../src/index.ts'

const MAX_BYTES = 4096

const workspace = await mkdtemp(join(tmpdir(), 'mnav-upload-'))
const outside = await mkdtemp(join(tmpdir(), 'mnav-outside-'))
let logged = 0

/** Minimal stand-in for the host Context the handler actually touches. */
const ctx = {
  sessions: {
    get: (id) => (id === 'session-live' ? { header: { cwd: workspace } } : undefined),
  },
  logger: { warn: () => { logged += 1 } },
}

const server = createServer((req, res) => { void handleUpload(ctx, MAX_BYTES, req, res) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

/** POST one body the way the browser does: raw bytes, same-origin headers. */
async function post(query, body, init = {}) {
  const response = await fetch(`${base}/_dsh/mobile-nav/upload${query}`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/octet-stream', ...(init.headers ?? {}) },
    body,
    duplex: 'half',
    ...init,
  })
  return { status: response.status, body: await response.json() }
}

try {
  // ---- pure helpers, before anything touches the disk ----------------------
  // Path separators cannot survive; only the basename does.
  assert.equal(safeUploadName('../../etc/passwd'), 'passwd')
  assert.equal(safeUploadName('..\\..\\windows\\system32\\evil.dll'), 'evil.dll')
  assert.equal(safeUploadName('/etc/shadow'), 'shadow')
  // Dots and hyphens are ordinary filename characters and must be preserved
  // (a character-class typo here silently mangles every extension).
  assert.equal(safeUploadName('my-photo.2026.jpg'), 'my-photo.2026.jpg')
  // Whitespace folds to _ so the client's @path mention stays one token.
  assert.equal(safeUploadName('照片 (1).png'), '照片_(1).png')
  assert.equal(safeUploadName('my  notes\tv2.txt'), 'my_notes_v2.txt')
  assert.ok(!/\s/u.test(safeUploadName('a b c d.txt')))
  // Dotfiles, empty labels, and Windows device names.
  assert.equal(safeUploadName('...'), 'upload.bin')
  assert.equal(safeUploadName(''), 'upload.bin')
  assert.equal(safeUploadName('.bashrc'), 'bashrc')
  assert.equal(safeUploadName('CON.txt'), '_CON.txt')
  // Long names are capped in bytes, keeping the extension.
  const long = safeUploadName(`${'あ'.repeat(200)}.jpg`)
  assert.ok(Buffer.byteLength(long) <= 180, `long name still ${Buffer.byteLength(long)} bytes`)
  assert.ok(long.endsWith('.jpg'))

  // The gateway rewrites Origin/Host to the upstream origin, so a phone
  // request presents as same-origin; a real cross-site POST does not.
  assert.equal(sameOriginPost({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }), true)
  assert.equal(sameOriginPost({ headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } }), false)
  assert.equal(sameOriginPost({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(sameOriginPost({ headers: { 'sec-fetch-site': 'same-origin' } }), true)

  // ---- happy path ----------------------------------------------------------
  const payload = 'hello attachment\n'
  const ok = await post('?session=session-live&name=notes.txt', payload)
  assert.equal(ok.status, 201)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.relPath, `${UPLOAD_DIR}/notes.txt`)
  assert.equal(ok.body.bytes, Buffer.byteLength(payload))
  assert.equal(await readFile(join(workspace, UPLOAD_DIR, 'notes.txt'), 'utf8'), payload)

  // ---- same name twice does not clobber -----------------------------------
  const again = await post('?session=session-live&name=notes.txt', 'second')
  assert.equal(again.status, 201)
  assert.equal(again.body.relPath, `${UPLOAD_DIR}/notes-1.txt`)
  assert.equal(await readFile(join(workspace, UPLOAD_DIR, 'notes.txt'), 'utf8'), payload)

  // ---- binary round-trip ---------------------------------------------------
  const bytes = new Uint8Array(1024)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256
  const bin = await post('?session=session-live&name=blob.bin', bytes)
  assert.equal(bin.status, 201)
  assert.deepEqual(new Uint8Array(await readFile(join(workspace, UPLOAD_DIR, 'blob.bin'))), bytes)

  // ---- oversize, declared --------------------------------------------------
  const tooBig = 'x'.repeat(MAX_BYTES + 1)
  const declared = await post('?session=session-live&name=big.txt', tooBig)
  assert.equal(declared.status, 413)
  assert.equal(declared.body.error.code, 'too-large')

  // ---- oversize, chunked (no Content-Length to pre-check) ------------------
  const chunked = await post('?session=session-live&name=stream.txt', new ReadableStream({
    start(controller) {
      for (let i = 0; i < 5; i += 1) controller.enqueue(new TextEncoder().encode('y'.repeat(2048)))
      controller.close()
    },
  }))
  assert.equal(chunked.status, 413)
  assert.equal(chunked.body.error.code, 'too-large')

  // ---- path traversal ------------------------------------------------------
  const escape = await post('?session=session-live&name=..%2F..%2Fevil.txt', 'nope')
  assert.equal(escape.status, 201, 'the name is sanitized, not rejected')
  assert.equal(escape.body.relPath, `${UPLOAD_DIR}/evil.txt`)
  assert.equal(await readFile(join(workspace, UPLOAD_DIR, 'evil.txt'), 'utf8'), 'nope')
  // Nothing at all escaped into the parent of the workspace.
  assert.deepEqual(await readdir(outside), [])

  // ---- unknown session -----------------------------------------------------
  const ghost = await post('?session=session-gone&name=a.txt', 'x')
  assert.equal(ghost.status, 404)
  assert.equal(ghost.body.error.code, 'session-not-found')

  // ---- malformed query -----------------------------------------------------
  assert.equal((await post('?name=a.txt', 'x')).status, 400)
  assert.equal((await post('?session=session-live', 'x')).status, 400)
  assert.equal((await post('?session=a&session=b&name=x.txt', 'x')).status, 400)

  // ---- method and origin ---------------------------------------------------
  const wrongMethod = await fetch(`${base}/_dsh/mobile-nav/upload?session=session-live&name=a.txt`)
  assert.equal(wrongMethod.status, 405)
  const crossSite = await post('?session=session-live&name=a.txt', 'x', {
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.body.error.code, 'origin-rejected')

  // ---- a symlinked upload directory is refused, not followed ---------------
  const trapWorkspace = await mkdtemp(join(tmpdir(), 'mnav-trap-'))
  await mkdir(join(outside, 'loot'), { recursive: true })
  await symlink(join(outside, 'loot'), join(trapWorkspace, UPLOAD_DIR))
  ctx.sessions.get = (id) => (id === 'session-trap' ? { header: { cwd: trapWorkspace } } : undefined)
  const trapped = await post('?session=session-trap&name=a.txt', 'x')
  assert.equal(trapped.status, 400)
  assert.equal(trapped.body.error.code, 'path-escape')
  assert.deepEqual(await readdir(join(outside, 'loot')), [])
  await rm(trapWorkspace, { recursive: true, force: true })

  // Every rejection that reached the body is logged once, so a failing phone
  // leaves a trail: 2x413, 404, 3x400 query, 1x400 symlink. The 405 and 403
  // short-circuit before the try block and deliberately log nothing — they are
  // the two an unpaired scanner can trigger at will.
  assert.equal(logged, 7, `expected the rejections to be logged, saw ${logged}`)

  // ---- the workspace holds exactly what was uploaded, nothing partial ------
  assert.deepEqual((await readdir(join(workspace, UPLOAD_DIR))).sort(), [
    'blob.bin', 'evil.txt', 'notes-1.txt', 'notes.txt',
  ])

  console.log('UPLOAD ENDPOINT CHECK OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(workspace, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}
