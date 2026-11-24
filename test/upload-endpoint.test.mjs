import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UPLOAD_DIR, handleUpload, safeUploadName, sameOriginPost } from '../lib/index.js'
import {
  UPLOAD_DIR as CLIENT_UPLOAD_DIR,
  UPLOAD_ROUTE,
  UploadHttpError,
  appendDraftOf,
  draftWithMention,
  draftWithoutMention,
  leafOf,
  mentionsIn,
  middleEllipsis,
  parseUploadResponse,
  uploadErrorSummary,
  uploadUrl,
  writeMention,
} from '../src/client/attach-upload.ts'

test('attach-upload client pure helpers: URLs, draft mentions, writeMention, chip labels', () => {
  assert.equal(CLIENT_UPLOAD_DIR, UPLOAD_DIR)
  assert.equal(uploadUrl('session-1', 'a.txt'), `${UPLOAD_ROUTE}?session=session-1&name=a.txt`)
  assert.equal(
    uploadUrl('session-2', 'my notes&session=evil.txt'),
    `${UPLOAD_ROUTE}?session=session-2&name=my+notes%26session%3Devil.txt`,
  )
  assert.equal(new URL(uploadUrl('s', '../../etc/passwd'), 'http://x').searchParams.get('name'), '../../etc/passwd')
  assert.equal(new URL(uploadUrl('s', '照片.jpg'), 'http://x').searchParams.get('name'), '照片.jpg')

  const a = `${CLIENT_UPLOAD_DIR}/a.pdf`
  const b = `${CLIENT_UPLOAD_DIR}/b.zip`

  assert.equal(draftWithMention('', a), '@.dsh-uploads/a.pdf ')
  assert.equal(draftWithMention('read', a), 'read @.dsh-uploads/a.pdf ')
  assert.equal(draftWithMention('read ', a), 'read @.dsh-uploads/a.pdf ')
  assert.equal(draftWithMention('read\n', a), 'read\n@.dsh-uploads/a.pdf ')
  assert.equal(draftWithMention(draftWithMention('', a), b), '@.dsh-uploads/a.pdf @.dsh-uploads/b.zip ')

  assert.deepEqual(mentionsIn(''), [])
  assert.deepEqual(mentionsIn('just some prose'), [])
  assert.deepEqual(mentionsIn('@.dsh-uploads/a.pdf '), [a])
  assert.deepEqual(mentionsIn('look at @.dsh-uploads/a.pdf and @.dsh-uploads/b.zip please'), [a, b])
  assert.deepEqual(mentionsIn('@.dsh-uploads/a.pdf @.dsh-uploads/a.pdf'), [a])
  assert.deepEqual(mentionsIn('@src/index.ts @.dsh-uploads/a.pdf'), [a])
  assert.deepEqual(mentionsIn('@Xdsh-uploads/a.pdf'), [])

  assert.equal(draftWithoutMention('@.dsh-uploads/a.pdf ', a), '')
  assert.equal(draftWithoutMention('@.dsh-uploads/a.pdf @.dsh-uploads/b.zip ', a), '@.dsh-uploads/b.zip ')
  assert.equal(draftWithoutMention('read @.dsh-uploads/a.pdf please', a), 'read please')
  assert.equal(draftWithoutMention('read @.dsh-uploads/a.pdf ', a), 'read ')
  assert.equal(draftWithoutMention('read @.dsh-uploads/a.pdf ', b), 'read @.dsh-uploads/a.pdf ')

  let draft = draftWithMention(draftWithMention('photos:', a), b)
  assert.deepEqual(mentionsIn(draft), [a, b])
  draft = draftWithoutMention(draft, a)
  assert.deepEqual(mentionsIn(draft), [b])
  draft = draftWithoutMention(draft, b)
  assert.deepEqual(mentionsIn(draft), [])
  assert.equal(draft, 'photos: ')

  {
    const calls = []
    const legacy = { setDraft: (text) => calls.push(['set', text]) }
    assert.equal(appendDraftOf(legacy), undefined)
    const first = writeMention(legacy, 'read', a)
    assert.equal(first, 'read @.dsh-uploads/a.pdf ')
    const second = writeMention(legacy, first, b)
    assert.equal(second, 'read @.dsh-uploads/a.pdf @.dsh-uploads/b.zip ')
    assert.deepEqual(calls, [['set', first], ['set', second]])
  }
  {
    const calls = []
    const modern = {
      draft: 'keep my @src/index.ts reference',
      setDraft(text) { calls.push(['set', text]) },
      appendDraft(text) { calls.push(['append', text, this === modern]) },
    }
    assert.equal(typeof appendDraftOf(modern), 'function')
    assert.equal(writeMention(modern, modern.draft, a), modern.draft)
    writeMention(modern, modern.draft, b)
    assert.deepEqual(calls, [['append', '@.dsh-uploads/a.pdf ', true], ['append', '@.dsh-uploads/b.zip ', true]])
  }
  {
    const calls = []
    const odd = { appendDraft: true, setDraft: (text) => calls.push(text) }
    assert.equal(appendDraftOf(odd), undefined)
    writeMention(odd, '', a)
    assert.deepEqual(calls, ['@.dsh-uploads/a.pdf '])
  }

  assert.equal(leafOf(`${CLIENT_UPLOAD_DIR}/report.pdf`), 'report.pdf')
  assert.equal(leafOf('report.pdf'), 'report.pdf')
  assert.equal(middleEllipsis('a.pdf'), 'a.pdf')
  const long = middleEllipsis('quarterly-revenue-breakdown-2026.pdf')
  assert.equal(long.length, 18)
  assert.ok(long.startsWith('quarterly'))
  assert.ok(long.endsWith('.pdf'))
  assert.ok(long.includes('…'))
})

test('upload endpoint pure helpers: safeUploadName and sameOriginPost', () => {
  assert.equal(safeUploadName('../../etc/passwd'), 'passwd')
  assert.equal(safeUploadName('..\\..\\windows\\system32\\evil.dll'), 'evil.dll')
  assert.equal(safeUploadName('/etc/shadow'), 'shadow')
  assert.equal(safeUploadName('my-photo.2026.jpg'), 'my-photo.2026.jpg')
  assert.equal(safeUploadName('照片 (1).png'), '照片_(1).png')
  assert.equal(safeUploadName('my  notes\tv2.txt'), 'my_notes_v2.txt')
  assert.ok(!/\s/u.test(safeUploadName('a b c d.txt')))
  assert.equal(safeUploadName('...'), 'upload.bin')
  assert.equal(safeUploadName(''), 'upload.bin')
  assert.equal(safeUploadName('.bashrc'), 'bashrc')
  assert.equal(safeUploadName('CON.txt'), '_CON.txt')
  const long = safeUploadName(`${'あ'.repeat(200)}.jpg`)
  assert.ok(Buffer.byteLength(long) <= 180)
  assert.ok(long.endsWith('.jpg'))

  assert.equal(sameOriginPost({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }), true)
  assert.equal(sameOriginPost({ headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } }), false)
  assert.equal(sameOriginPost({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(sameOriginPost({ headers: { 'sec-fetch-site': 'same-origin' } }), true)
})

test('upload endpoint integration: disk writes, caps, symlinks, and admission wall', async (t) => {
  const MAX_BYTES = 4096
  const workspace = await mkdtemp(join(tmpdir(), 'mnav-upload-'))
  const outside = await mkdtemp(join(tmpdir(), 'mnav-outside-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  let logged = 0
  let getSession = (id) => (id === 'session-live' ? { header: { cwd: workspace } } : undefined)
  const ctx = {
    sessions: { get: (id) => getSession(id) },
    logger: { warn: () => { logged += 1 } },
  }

  let admitHandler = undefined
  const server = createServer((req, res) => {
    void handleUpload(ctx, MAX_BYTES, req, res, admitHandler)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`

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

  const payload = 'hello attachment\n'
  const ok = await post('?session=session-live&name=notes.txt', payload)
  assert.equal(ok.status, 201)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.relPath, `${UPLOAD_DIR}/notes.txt`)
  assert.equal(ok.body.bytes, Buffer.byteLength(payload))
  assert.equal(await readFile(join(workspace, UPLOAD_DIR, 'notes.txt'), 'utf8'), payload)
  assert.equal(await readFile(join(workspace, UPLOAD_DIR, '.gitignore'), 'utf8'), '*\n!.gitignore\n')

  const again = await post('?session=session-live&name=notes.txt', 'second')
  assert.equal(again.status, 201)
  assert.equal(again.body.relPath, `${UPLOAD_DIR}/notes-1.txt`)
  assert.equal(await readFile(join(workspace, UPLOAD_DIR, 'notes.txt'), 'utf8'), payload)

  const bytes = new Uint8Array(1024)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256
  const bin = await post('?session=session-live&name=blob.bin', bytes)
  assert.equal(bin.status, 201)
  assert.deepEqual(new Uint8Array(await readFile(join(workspace, UPLOAD_DIR, 'blob.bin'))), bytes)

  const declared = await post('?session=session-live&name=big.txt', 'x'.repeat(MAX_BYTES + 1))
  assert.equal(declared.status, 413)
  assert.equal(declared.body.error.code, 'too-large')

  const chunked = await post('?session=session-live&name=stream.txt', new ReadableStream({
    start(controller) {
      for (let i = 0; i < 5; i += 1) controller.enqueue(new TextEncoder().encode('y'.repeat(2048)))
      controller.close()
    },
  }))
  assert.equal(chunked.status, 413)
  assert.equal(chunked.body.error.code, 'too-large')

  const escape = await post('?session=session-live&name=..%2F..%2Fevil.txt', 'nope')
  assert.equal(escape.status, 201)
  assert.equal(escape.body.relPath, `${UPLOAD_DIR}/evil.txt`)
  assert.equal(await readFile(join(workspace, UPLOAD_DIR, 'evil.txt'), 'utf8'), 'nope')
  assert.deepEqual(await readdir(outside), [])

  const ghost = await post('?session=session-gone&name=a.txt', 'x')
  assert.equal(ghost.status, 404)
  assert.equal(ghost.body.error.code, 'session-not-found')

  assert.equal((await post('?name=a.txt', 'x')).status, 400)
  assert.equal((await post('?session=session-live', 'x')).status, 400)
  assert.equal((await post('?session=a&session=b&name=x.txt', 'x')).status, 400)

  const wrongMethod = await fetch(`${base}/_dsh/mobile-nav/upload?session=session-live&name=a.txt`)
  assert.equal(wrongMethod.status, 405)
  const crossSite = await post('?session=session-live&name=a.txt', 'x', {
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.body.error.code, 'origin-rejected')

  const trapWorkspace = await mkdtemp(join(tmpdir(), 'mnav-trap-'))
  t.after(() => rm(trapWorkspace, { recursive: true, force: true }))
  await mkdir(join(outside, 'loot'), { recursive: true })
  await symlink(join(outside, 'loot'), join(trapWorkspace, UPLOAD_DIR))
  getSession = (id) => (id === 'session-trap' ? { header: { cwd: trapWorkspace } } : undefined)
  const trapped = await post('?session=session-trap&name=a.txt', 'x')
  assert.equal(trapped.status, 400)
  assert.equal(trapped.body.error.code, 'path-escape')
  assert.deepEqual(await readdir(join(outside, 'loot')), [])

  assert.equal(logged, 7)
  assert.deepEqual((await readdir(join(workspace, UPLOAD_DIR))).sort(), [
    '.gitignore', 'blob.bin', 'evil.txt', 'notes-1.txt', 'notes.txt',
  ])

  getSession = (id) => (id === 'session-live' ? { header: { cwd: workspace } } : undefined)
  let admitted = 0
  let currentAdmission = 401
  admitHandler = () => {
    if (currentAdmission === 'peer') {
      admitted += 1
      return { peer: {} }
    }
    return { rejection: currentAdmission }
  }

  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [503, 'service-unavailable']]) {
    currentAdmission = status
    const denied = await post('?session=session-live&name=denied.txt', 'x')
    assert.equal(denied.status, status)
    assert.equal(denied.body.ok, false)
    assert.equal(denied.body.error.code, code)
  }
  assert.deepEqual(await readdir(join(workspace, UPLOAD_DIR)), [
    '.gitignore', 'blob.bin', 'evil.txt', 'notes-1.txt', 'notes.txt',
  ])
  assert.equal(logged, 7)

  currentAdmission = 'peer'
  const allowed = await post('?session=session-live&name=admitted.txt', 'through the wall')
  assert.equal(allowed.status, 201)
  assert.equal(allowed.body.relPath, `${UPLOAD_DIR}/admitted.txt`)
  assert.equal(admitted, 1)
  assert.equal(await readFile(join(workspace, UPLOAD_DIR, 'admitted.txt'), 'utf8'), 'through the wall')
})

test('D23-1/fix: parseUploadResponse reports plain-text host rejections instead of throwing JSON parse errors', async () => {
  const fakeResponse = (status, bodyText) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
  })

  await assert.rejects(
    () => parseUploadResponse(fakeResponse(401, 'unauthorized')),
    /HTTP 401: unauthorized/,
  )
  await assert.rejects(
    () => parseUploadResponse(fakeResponse(403, 'forbidden')),
    /HTTP 403: forbidden/,
  )
  await assert.rejects(
    () => parseUploadResponse(fakeResponse(503, 'authentication unavailable')),
    /HTTP 503: authentication unavailable/,
  )
  await assert.rejects(
    () => parseUploadResponse(fakeResponse(502, '')),
    /^Error: HTTP 502$/,
  )
  await assert.rejects(
    () => parseUploadResponse(fakeResponse(403, JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'owner only' } }))),
    /owner only/,
  )
  await assert.rejects(
    () => parseUploadResponse(fakeResponse(401, JSON.stringify({ ok: false, error: { code: 'unauthorized' } }))),
    /unauthorized/,
  )
  await assert.rejects(
    () => parseUploadResponse(fakeResponse(200, 'not-json')),
    /HTTP 200: not-json/,
  )
  assert.equal(
    await parseUploadResponse(fakeResponse(200, JSON.stringify({ ok: true, relPath: '.dsh-attachments/a.png' }))),
    '.dsh-attachments/a.png',
  )
})

test('PR77-R3-L4: UploadHttpError and uploadErrorSummary render localized rejection reasons visibly', async () => {
  const fakeResponse = (status, bodyText) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
  })
  const labels = {
    attachFailed: 'Upload failed — tap to retry',
    attachFailedUnauthorized: 'Upload failed (401 unauthorized)',
    attachFailedForbidden: 'Upload failed (403 forbidden)',
    attachFailedUnavailable: 'Upload failed (503 unavailable)',
  }
  const t = (key) => labels[key]

  const err401 = await parseUploadResponse(fakeResponse(401, 'unauthorized')).catch((e) => e)
  assert.equal(err401 instanceof UploadHttpError, true)
  assert.equal(err401.status, 401)
  assert.equal(uploadErrorSummary(err401, t), labels.attachFailedUnauthorized)

  const err403 = await parseUploadResponse(fakeResponse(403, 'forbidden')).catch((e) => e)
  assert.equal(err403 instanceof UploadHttpError, true)
  assert.equal(err403.status, 403)
  assert.equal(uploadErrorSummary(err403, t), labels.attachFailedForbidden)

  const err503 = await parseUploadResponse(fakeResponse(503, 'authentication unavailable')).catch((e) => e)
  assert.equal(err503 instanceof UploadHttpError, true)
  assert.equal(err503.status, 503)
  assert.equal(uploadErrorSummary(err503, t), labels.attachFailedUnavailable)

  const err502 = await parseUploadResponse(fakeResponse(502, 'bad gateway')).catch((e) => e)
  assert.equal(err502 instanceof UploadHttpError, true)
  assert.equal(uploadErrorSummary(err502, t), 'Upload failed — tap to retry (HTTP 502)')

  assert.equal(uploadErrorSummary(new TypeError('Failed to fetch'), t), labels.attachFailed)
})
