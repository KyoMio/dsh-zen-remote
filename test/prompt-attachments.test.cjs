// dsh-zen-remote · 2.3.0 host-side prompt-attachment store
// (src/prompt-attachments.ts)
//
// ZCode's model, adapted to DSH: a prompt's client-local file is materialized
// at a private, visible path under ~/.dsh/tmp/prompt-attachments/<session>/,
// with 0700/0600, a bounded stream and a janitor. Drives the compiled module
// against a temp root (the module takes `root` for tests).
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, readdir, rm, stat, utimes, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

async function load() {
  return import('../lib/prompt-attachments.js')
}

/** A web stream over one buffer. */
function bodyOf(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

test('savePromptAttachment: writes into <root>/<session>/<stamp>-<nonce>-<name> and locks the file down', async () => {
  const { savePromptAttachment } = await load()
  const root = await mkdtemp(join(tmpdir(), 'zr-prompt-'))
  try {
    const saved = await savePromptAttachment({
      root,
      sessionId: 'session-abc',
      name: '日志.txt',
      body: bodyOf('hello-日志'),
    })
    assert.match(saved.path, new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/session-abc/\\d{8}-\\d{6}-[0-9a-f]{6}-日志\\.txt$`))
    assert.equal(saved.bytes, Buffer.byteLength('hello-日志'))
    const { readFile } = require('node:fs/promises')
    assert.equal(await readFile(saved.path, 'utf8'), 'hello-日志')
    if (process.platform !== 'win32') {
      assert.equal((await stat(saved.path)).mode & 0o777, 0o600)
      assert.equal((await stat(join(root, 'session-abc'))).mode & 0o777, 0o700)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('savePromptAttachment: a traversal-looking name stays one leaf inside the session dir', async () => {
  const { savePromptAttachment } = await load()
  const root = await mkdtemp(join(tmpdir(), 'zr-prompt-'))
  try {
    const saved = await savePromptAttachment({
      root,
      sessionId: '../escape',
      name: '../../etc/passwd',
      body: bodyOf('x'),
    })
    assert.ok(saved.path.startsWith(join(root, '_escape')), `path stayed inside the root: ${saved.path}`)
    assert.equal(saved.path.endsWith('-passwd'), true, 'only the basename survived')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('savePromptAttachment: the byte cap removes the half-written file', async () => {
  const { savePromptAttachment } = await load()
  const root = await mkdtemp(join(tmpdir(), 'zr-prompt-'))
  try {
    await assert.rejects(
      savePromptAttachment({ root, sessionId: 's', name: 'big.bin', body: bodyOf('0123456789'), maxBytes: 4 }),
      /payload-too-large/,
    )
    const left = await readdir(join(root, 's')).catch(() => [])
    assert.deepEqual(left, [], 'no partial file survives the refusal')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanupStalePromptAttachments: removes files older than the window and keeps fresh ones', async () => {
  const { cleanupStalePromptAttachments } = await load()
  const root = await mkdtemp(join(tmpdir(), 'zr-prompt-'))
  try {
    const dir = join(root, 's')
    const { mkdir } = require('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const oldFile = join(dir, 'old.txt')
    const newFile = join(dir, 'new.txt')
    await writeFile(oldFile, 'old')
    await writeFile(newFile, 'new')
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await utimes(oldFile, old, old)
    const removed = await cleanupStalePromptAttachments(24 * 60 * 60 * 1000, root)
    assert.equal(removed, 1)
    const left = await readdir(dir)
    assert.deepEqual(left, ['new.txt'], 'the fresh attachment stays')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
