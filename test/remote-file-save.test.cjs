// dsh-zen-remote · 2.2.6 remote artifact download (src/client/remote-file-save.ts)
//
// The read window is the ONLY shape that works against the host's caps: a
// ranged read is limited by `Config.maxBytes` (2 MiB by default) and a
// rangeless read by `maxFileBytes` (32 MiB), so a produced file of any size
// must be pulled window by window. These tests drive the pure collector with
// a fake reader — no DOM, no DSH — and pin the two behaviors that make it
// safe: it stops on the host's own `eof`, and it adapts DOWN when the host
// names a smaller window in `details.limit`, instead of failing the download.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

/** A fake file served in fixed windows. */
function fileReader(bytes, { honorEof = true, ignoreRange = false } = {}) {
  const calls = []
  const read = async ({ offset, length }) => {
    calls.push({ offset, length })
    if (ignoreRange) {
      // A pathological host: always the whole file, never eof — the loop must
      // stop on the chunk guard, not spin forever.
      return { ok: true, value: { data: bytes, eof: false } }
    }
    const slice = bytes.subarray(offset, offset + length)
    const eof = honorEof ? offset + slice.byteLength >= bytes.byteLength : false
    return { ok: true, value: { data: slice, eof } }
  }
  return { read, calls }
}

test('downloadFileNameOf: last segment of a POSIX or Windows path, never blank', async () => {
  const { downloadFileNameOf } = await import('../src/client/remote-file-save.ts')
  assert.equal(downloadFileNameOf('/root/Desktop/report.docx'), 'report.docx')
  assert.equal(downloadFileNameOf('C:\\Users\\me\\Desktop\\交付物.xlsx'), '交付物.xlsx')
  assert.equal(downloadFileNameOf('/tmp/'), 'download')
  assert.equal(downloadFileNameOf('   '), 'download')
  assert.equal(downloadFileNameOf('plain.txt'), 'plain.txt')
})

test('collectRemoteFile: windows are concatenated in order and the read stops on eof', async () => {
  const { collectRemoteFile } = await import('../src/client/remote-file-save.ts')
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7])
  const { read, calls } = fileReader(bytes)
  const out = await collectRemoteFile(read, 3)
  assert.deepEqual([...out], [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(calls, [
    { offset: 0, length: 3 },
    { offset: 3, length: 3 },
    { offset: 6, length: 3 },
  ], 'one round trip per window, offsets advance by the bytes actually read')
})

test('collectRemoteFile: an exact-multiple file ends on the empty window after eof', async () => {
  const { collectRemoteFile } = await import('../src/client/remote-file-save.ts')
  const bytes = new Uint8Array([9, 8, 7, 6])
  const { read } = fileReader(bytes)
  const out = await collectRemoteFile(read, 2)
  assert.deepEqual([...out], [9, 8, 7, 6])
})

test('collectRemoteFile: an empty file is one empty window and an empty result', async () => {
  const { collectRemoteFile } = await import('../src/client/remote-file-save.ts')
  const { read } = fileReader(new Uint8Array(0))
  const out = await collectRemoteFile(read, 4)
  assert.equal(out.byteLength, 0)
})

test('collectRemoteFile: a host-declared smaller window adapts down instead of failing', async () => {
  const { collectRemoteFile } = await import('../src/client/remote-file-save.ts')
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])
  const calls = []
  const read = async ({ offset, length }) => {
    calls.push({ offset, length })
    if (length > 2) {
      return { ok: false, error: { code: 'workspace-file/too-large', details: { limit: 2 } } }
    }
    const slice = bytes.subarray(offset, offset + length)
    return { ok: true, value: { data: slice, eof: offset + slice.byteLength >= bytes.byteLength } }
  }
  const out = await collectRemoteFile(read, 4)
  assert.deepEqual([...out], [1, 2, 3, 4, 5, 6])
  assert.deepEqual(calls.slice(0, 2), [
    { offset: 0, length: 4 },
    { offset: 0, length: 2 },
  ], 'the refused window is retried at the SAME offset with the host limit')
})

test('collectRemoteFile: other refusals throw their code (the button shows failure)', async () => {
  const { collectRemoteFile } = await import('../src/client/remote-file-save.ts')
  const read = async () => ({ ok: false, error: { code: 'not-shared' } })
  await assert.rejects(collectRemoteFile(read, 4), /not-shared/)
})

test('collectRemoteFile: a reader that never advances is stopped by the chunk guard', async () => {
  const { collectRemoteFile } = await import('../src/client/remote-file-save.ts')
  const bytes = new Uint8Array([1, 2])
  const { read } = fileReader(bytes, { ignoreRange: true })
  await assert.rejects(collectRemoteFile(read, 2), /too-many-chunks/)
})

/** A fake card tree: the action button's `closest` returns the card, whose
 * `querySelector` returns the preview button carrying the host's title. */
function fakeCard(title) {
  const preview = {
    closest: () => null,
    querySelector: () => null,
    getAttribute: (name) => (name === 'title' ? title : null),
  }
  const card = {
    closest: () => null,
    querySelector: (selector) => (selector === 'button[title]' ? preview : null),
    getAttribute: () => null,
  }
  const button = {
    closest: (selector) => (selector === '[data-presented-file]' ? card : null),
    querySelector: () => null,
    getAttribute: () => null,
  }
  return button
}

test('downloadPathFromCard: reads the card preview button\'s resolved path', async () => {
  const { downloadPathFromCard } = await import('../src/client/remote-file-save.ts')
  assert.equal(downloadPathFromCard(fakeCard('/root/Desktop/出图/report.docx')), '/root/Desktop/出图/report.docx')
  assert.equal(downloadPathFromCard(fakeCard('  C:\\work\\交付.pptx  ')), 'C:\\work\\交付.pptx')
})

test('downloadPathFromCard: no card / no title / blank title resolve to undefined (never a guess)', async () => {
  const { downloadPathFromCard } = await import('../src/client/remote-file-save.ts')
  assert.equal(downloadPathFromCard(null), undefined)
  assert.equal(downloadPathFromCard(fakeCard(null)), undefined)
  assert.equal(downloadPathFromCard(fakeCard('   ')), undefined)
  assert.equal(downloadPathFromCard({ closest: () => null, querySelector: () => null, getAttribute: () => null }), undefined)
})
