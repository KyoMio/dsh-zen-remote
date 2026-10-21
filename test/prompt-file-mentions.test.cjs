// dsh-zen-remote · 2.2.8: prompt `@local-path` mentions become attachments
// (src/prompt-file-mentions.ts)
//
// The client backend runs on the same machine as the UI, so it can read the
// path a pasted/dropped mention names even though the agent cannot. These
// tests drive the pure mention scanner and the materializer against a fake
// relay plus real temp files.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

/** Read a web stream fully (utf8). */
async function readBody(stream) {
  if (stream === null) return ''
  const chunks = []
  const reader = stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(Buffer.from(next.value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Fake relay: records invokes/uploads; `hostHas` decides the stat probe and
 * `pathMode` drives the visible-path channel (`none` = an older host). */
function fakeRelay({ hostHas = false, uploadOk = true, pathMode = 'none', remotePath = '/host/.dsh/tmp/prompt-attachments/session-a/20261021-1100-ab-日志.txt' } = {}) {
  const calls = { invokes: [], uploads: [], promptAttachments: [] }
  const relay = {
    calls,
    async invoke(namespace, method, args) {
      calls.invokes.push({ namespace, method, args })
      if (hostHas) return { absolutePath: args.path, version: 'v1' }
      throw Object.assign(new Error('not-found'), { code: 'workspace-file/not-found' })
    },
    async upload(options) {
      const bytes = await readBody(options.body)
      calls.uploads.push({ ...options, body: undefined, bytesRead: bytes })
      return uploadOk
        ? { status: 200, body: JSON.stringify({ ok: true, value: { receiptId: 'receipt-1', file: { attachmentId: 'a', name: 'x', bytes: 1 } } }) }
        : { status: 200, body: JSON.stringify({ ok: false, error: { code: 'payload-too-large', message: 'x', details: {} } }) }
    },
  }
  if (pathMode !== 'none') {
    relay.promptAttachment = async (options) => {
      const bytes = await readBody(options.body)
      calls.promptAttachments.push({ ...options, body: undefined, bytesRead: bytes })
      if (pathMode === 'throw') throw Object.assign(new Error('unsupported'), { code: 'unsupported' })
      return { path: remotePath }
    }
  }
  return relay
}

test('fileMentionsIn: absolute POSIX / Windows / UNC paths, quoted and bare', async () => {
  const { fileMentionsIn } = await import('../src/prompt-file-mentions.ts')
  const windows = fileMentionsIn('@C:\\Users\\me\\Desktop\\日志.txt 帮我看看')
  assert.deepEqual(windows.map((m) => m.path), ['C:\\Users\\me\\Desktop\\日志.txt'])
  assert.equal(windows[0].start, 0)
  assert.equal(windows[0].end, 1 + 'C:\\Users\\me\\Desktop\\日志.txt'.length)
  assert.deepEqual(fileMentionsIn('看下 @/root/Desktop/a.md 然后').map((m) => m.path), ['/root/Desktop/a.md'])
  assert.deepEqual(fileMentionsIn('@"C:\\a b\\c.txt" 内容').map((m) => m.path), ['C:\\a b\\c.txt'])
  assert.deepEqual(fileMentionsIn('阅读 @\\\\server\\share\\x.log').map((m) => m.path), ['\\\\server\\share\\x.log'])
})

test('fileMentionsIn: emails, relative paths, and ASCII mid-word @ are not mentions', async () => {
  const { fileMentionsIn } = await import('../src/prompt-file-mentions.ts')
  assert.deepEqual(fileMentionsIn('联系 me@example.com'), [])
  assert.deepEqual(fileMentionsIn('@relative/path.md 看看'), [])
  assert.deepEqual(fileMentionsIn('foo@/root/x'), [])
  assert.deepEqual(fileMentionsIn('@'), [])
})

test('fileMentionsIn: a drop glued to a half-typed CJK sentence still opens a mention', async () => {
  const { fileMentionsIn } = await import('../src/prompt-file-mentions.ts')
  // The composer inserts at the caret: "我已经更新到2.2.8 你看能读到了吗@C:\...".
  assert.deepEqual(fileMentionsIn('你看能读到了吗@C:\\Users\\me\\Desktop\\日志.txt').map((m) => m.path), ['C:\\Users\\me\\Desktop\\日志.txt'])
  const glued = fileMentionsIn('日志在（@C:\\a\\b.txt）里')
  assert.equal(glued.length, 1, 'prose punctuation before @ still opens the mention')
  assert.ok(glued[0].path.startsWith('C:\\a\\b.txt'), 'the syntactic token may carry glued prose; resolution trims it')
})

test('fileMentionsIn: CJK punctuation before the mention still opens it (prose use)', async () => {
  const { fileMentionsIn } = await import('../src/prompt-file-mentions.ts')
  assert.deepEqual(fileMentionsIn('请读（@C:\\a\\b.txt）').map((m) => m.path), ['C:\\a\\b.txt'])
})

test('materialize: a local mention becomes a file receipt and leaves the prompt text', async () => {
  const { materializeLocalFileMentions } = await import('../src/prompt-file-mentions.ts')
  const dir = await mkdtemp(join(tmpdir(), 'zr-mention-'))
  const file = join(dir, '日志.txt')
  await writeFile(file, 'hello-log')
  try {
    const relay = fakeRelay()
    const args = { request: { sessionId: 'session-a', mode: 'queue', content: [{ type: 'text', text: `@${file} 能读到了吗` }] } }
    const out = await materializeLocalFileMentions(args, relay)
    assert.equal(out, args, 'the same arguments object is rewritten in place')
    assert.equal(relay.calls.uploads.length, 1)
    assert.equal(relay.calls.uploads[0].sessionId, 'session-a')
    assert.equal(relay.calls.uploads[0].name, '日志.txt')
    assert.equal(relay.calls.uploads[0].bytesRead, 'hello-log')
    assert.deepEqual(args.request.content, [
      { type: 'file', receiptId: 'receipt-1' },
      { type: 'text', text: ' 能读到了吗' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('materialize: a path the host already has stays a text mention (no upload)', async () => {
  const { materializeLocalFileMentions } = await import('../src/prompt-file-mentions.ts')
  const dir = await mkdtemp(join(tmpdir(), 'zr-mention-'))
  const file = join(dir, 'a.md')
  await writeFile(file, 'x')
  try {
    const relay = fakeRelay({ hostHas: true })
    const args = { request: { sessionId: 'session-a', content: [{ type: 'text', text: `@${file} 看下` }] } }
    await materializeLocalFileMentions(args, relay)
    assert.equal(relay.calls.uploads.length, 0)
    assert.deepEqual(args.request.content, [{ type: 'text', text: `@${file} 看下` }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('materialize: a missing local file or a failed upload leaves the prompt untouched', async () => {
  const { materializeLocalFileMentions } = await import('../src/prompt-file-mentions.ts')
  const missing = { request: { sessionId: 's', content: [{ type: 'text', text: '@C:\\does\\not\\exist.txt 看下' }] } }
  const relay = fakeRelay()
  await materializeLocalFileMentions(missing, relay)
  assert.equal(relay.calls.uploads.length, 0)
  assert.deepEqual(missing.request.content, [{ type: 'text', text: '@C:\\does\\not\\exist.txt 看下' }])

  const dir = await mkdtemp(join(tmpdir(), 'zr-mention-'))
  const file = join(dir, 'b.txt')
  await writeFile(file, 'y')
  try {
    const failing = fakeRelay({ uploadOk: false })
    const args = { request: { sessionId: 's', content: [{ type: 'text', text: `@${file} 看下` }] } }
    await materializeLocalFileMentions(args, failing)
    assert.equal(failing.calls.uploads.length, 1)
    assert.deepEqual(args.request.content, [{ type: 'text', text: `@${file} 看下` }], 'nothing removed when the receipt fails')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('materialize: prompts without mentions are returned untouched (no relay calls)', async () => {
  const { materializeLocalFileMentions } = await import('../src/prompt-file-mentions.ts')
  const relay = fakeRelay()
  const args = { request: { sessionId: 's', content: [{ type: 'text', text: '普通消息，没有附件' }, { type: 'image', mediaType: 'image/png', data: 'AA==' }] } }
  const snapshot = JSON.stringify(args)
  await materializeLocalFileMentions(args, relay)
  assert.equal(JSON.stringify(args), snapshot)
  assert.equal(relay.calls.invokes.length + relay.calls.uploads.length, 0)
})

test('materialize: a path glued to CJK prose is resolved by the file system and only the path is removed', async () => {
  const { materializeLocalFileMentions } = await import('../src/prompt-file-mentions.ts')
  const dir = await mkdtemp(join(tmpdir(), 'zr-mention-'))
  const file = join(dir, '日志.txt')
  await writeFile(file, 'log-bytes')
  try {
    const relay = fakeRelay()
    const args = { request: { sessionId: 's', content: [{ type: 'text', text: `你看能读到了吗@${file}）里` }] } }
    await materializeLocalFileMentions(args, relay)
    assert.equal(relay.calls.uploads.length, 1)
    assert.equal(relay.calls.uploads[0].name, '日志.txt')
    assert.deepEqual(args.request.content, [
      { type: 'file', receiptId: 'receipt-1' },
      { type: 'text', text: '你看能读到了吗）里' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('materialize (2.3.0): the visible-path channel rewrites the mention to the SERVER path', async () => {
  const { materializeLocalFileMentions } = await import('../src/prompt-file-mentions.ts')
  const dir = await mkdtemp(join(tmpdir(), 'zr-mention-'))
  const file = join(dir, '日志.txt')
  await writeFile(file, 'hello-log')
  try {
    const relay = fakeRelay({ pathMode: 'ok' })
    const args = { request: { sessionId: 'session-a', content: [{ type: 'text', text: `@${file} 能读了吗` }] } }
    await materializeLocalFileMentions(args, relay)
    assert.equal(relay.calls.promptAttachments.length, 1)
    assert.equal(relay.calls.promptAttachments[0].sessionId, 'session-a')
    assert.equal(relay.calls.promptAttachments[0].name, '日志.txt')
    assert.equal(relay.calls.promptAttachments[0].bytesRead, 'hello-log')
    assert.equal(relay.calls.uploads.length, 0, 'the receipt channel stays unused when the path channel works')
    assert.deepEqual(args.request.content, [
      { type: 'text', text: '@\/host/.dsh/tmp/prompt-attachments/session-a/20261021-1100-ab-日志.txt 能读了吗'.replace('@\\/', '@') },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('materialize (2.3.0): a host without the path route falls back to the attachment receipt', async () => {
  const { materializeLocalFileMentions } = await import('../src/prompt-file-mentions.ts')
  const dir = await mkdtemp(join(tmpdir(), 'zr-mention-'))
  const file = join(dir, 'a.txt')
  await writeFile(file, 'x')
  try {
    const relay = fakeRelay({ pathMode: 'throw' })
    const args = { request: { sessionId: 's', content: [{ type: 'text', text: `@${file} 看下` }] } }
    await materializeLocalFileMentions(args, relay)
    assert.equal(relay.calls.promptAttachments.length, 1)
    assert.equal(relay.calls.uploads.length, 1, 'the receipt channel carried the bytes')
    assert.deepEqual(args.request.content, [
      { type: 'file', receiptId: 'receipt-1' },
      { type: 'text', text: ' 看下' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
