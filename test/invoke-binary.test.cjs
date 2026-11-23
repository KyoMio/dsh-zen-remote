/* dsh-zen-remote · invoke-binary (src/invoke-binary.ts)
 *
 * The 2026-10-14 fix: workspaceFiles/readBytes' Uint8Array cannot ride the
 * relay's JSON invoke channel — mark on the server, restore on the client.
 * Pure round-trip tests against the BUILT lib (the artifact production
 * imports), mirroring the other pure-logic suites.
 */
'use strict'
const { test, before } = require('node:test')
const assert = require('node:assert')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

let markInvokeBinary
let restoreInvokeBinary
let extractResultAttachments
let encodeBinaryEnvelope
let decodeBinaryEnvelope
let BINARY_MARKER
let BINARY_ENVELOPE_REQUEST_HEADER
let BINARY_ENVELOPE_ENCODING
let MAX_BINARY_ENVELOPE_BYTES
let MAX_BINARY_ENVELOPE_ATTACHMENTS
let INVOKE_BINARY_RESULT_METHODS

before(async () => {
  ;({
    markInvokeBinary,
    restoreInvokeBinary,
    extractResultAttachments,
    encodeBinaryEnvelope,
    decodeBinaryEnvelope,
    BINARY_MARKER,
    BINARY_ENVELOPE_REQUEST_HEADER,
    BINARY_ENVELOPE_ENCODING,
    MAX_BINARY_ENVELOPE_BYTES,
    MAX_BINARY_ENVELOPE_ATTACHMENTS,
    INVOKE_BINARY_RESULT_METHODS,
  } = await import(
    pathToFileURL(path.join(__dirname, '..', 'lib', 'invoke-binary.js')).href
  ))
})

test('round trip: a nested Uint8Array survives mark → JSON → restore', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 128])
  const value = { data: bytes, meta: { path: 'a.png', head: new Uint8Array([9]) } }
  const marked = markInvokeBinary(value)
  // The wire really is JSON: what travels must stringify + parse losslessly.
  const onWire = JSON.parse(JSON.stringify(marked))
  const restored = restoreInvokeBinary(onWire)
  assert.ok(restored.data instanceof Uint8Array, 'data is a real Uint8Array again')
  assert.deepEqual(Array.from(restored.data), Array.from(bytes))
  assert.deepEqual(Array.from(restored.meta.head), [9])
  assert.equal(restored.meta.path, 'a.png')
})

test('mark replaces ONLY typed arrays; everything else keeps its reference', () => {
  const plain = { a: 1, list: [1, 'x', null], nested: { ok: true } }
  const marked = markInvokeBinary(plain)
  assert.equal(marked, plain, 'a result without typed arrays is returned UNCHANGED (same object)')
  const buffer = Buffer.from('hello')
  assert.deepEqual(markInvokeBinary(buffer)[BINARY_MARKER], buffer.toString('base64'), 'Buffer (a Uint8Array subclass) marks too')
})

test('restore is a no-op (same reference) on marker-free values', () => {
  const plain = { data: { 0: 1, 1: 2 }, $other: 'x' }
  assert.equal(restoreInvokeBinary(plain), plain)
  const list = [1, 2]
  assert.equal(restoreInvokeBinary(list), list)
})

test('a marker object with extra keys or a non-string value is NOT decoded', () => {
  const decoy1 = { [BINARY_MARKER]: 'AAAA', extra: 1 }
  assert.equal(restoreInvokeBinary(decoy1), decoy1, 'extra keys → untouched (only our own single-key markers decode)')
  const decoy2 = { [BINARY_MARKER]: 42 }
  assert.equal(restoreInvokeBinary(decoy2), decoy2)
})

test('deep nesting past the depth bound passes through untouched (no hang, no throw)', () => {
  let deep = { data: new Uint8Array([1]) }
  for (let i = 0; i < 30; i++) deep = { wrap: deep }
  const marked = markInvokeBinary(deep)
  assert.equal(marked, deep, 'past the bound the walker stops digging — the value travels as-is')
})

test('the method list covers exactly the known binary-result methods', () => {
  // 2.2.6 added the Office preview converter: its result carries the complete
  // PDF bytes as `data: Uint8Array`, so it needs the same marker as a file
  // read.
  assert.deepEqual([...INVOKE_BINARY_RESULT_METHODS], ['workspaceFiles/readBytes', 'officeToPdf/render', 'officeKit/render'])
})

test('an EMPTY Uint8Array round-trips too (review 2026-10-14: the empty base64 string is a legal marker)', () => {
  const restored = restoreInvokeBinary(JSON.parse(JSON.stringify(markInvokeBinary({ data: new Uint8Array(0) }))))
  assert.ok(restored.data instanceof Uint8Array)
  assert.equal(restored.data.byteLength, 0)
})

test('every binary-result method is also a REGISTERED relay method (a name outside both forwarding tables would silently never mark)', async () => {
  const relayAccess = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'relay-access.js')).href)
  for (const name of INVOKE_BINARY_RESULT_METHODS) {
    const [namespace, method] = name.split('/')
    const decision = relayAccess.decideInvoke(namespace, method, { workspaceFileScopeId: 'session-x' }, () => true)
    assert.equal(decision.allow, true, `${name} must stay a registered relay method or the marker path is dead code (${decision.reason})`)
  }
})

test('extractResultAttachments produces the dispatchRpc attachment contract', () => {
  const bytes = new Uint8Array([7, 8, 9])
  const nested = new Uint8Array([1])
  const value = { data: bytes, meta: { list: [nested, 'x'] }, path: 'a.png' }
  const out = extractResultAttachments(value)
  assert.equal(out.value.data, null, 'value position becomes null')
  assert.equal(out.value.meta.list[0], null, 'nested positions too')
  assert.equal(out.value.meta.list[1], 'x')
  assert.deepEqual(out.attachments.map((a) => a.path), [['data'], ['meta', 'list', 0]], 'paths address the exact positions')
  assert.deepEqual(Array.from(out.attachments[0].bytes), Array.from(bytes))
  assert.deepEqual(Array.from(out.attachments[1].bytes), [1])
})

test('extractResultAttachments keeps the reference when nothing is a typed array', () => {
  const plain = { a: 1, list: [{ b: 2 }] }
  const out = extractResultAttachments(plain)
  assert.equal(out.value, plain)
  assert.deepEqual(out.attachments, [])
})

test('full round trip: mark → JSON wire → restore → extract matches the envelope contract', () => {
  const bytes = new Uint8Array([0, 255, 128])
  const onWire = JSON.parse(JSON.stringify(markInvokeBinary({ data: bytes, path: 'p' })))
  const restored = restoreInvokeBinary(onWire)
  const out = extractResultAttachments(restored)
  assert.equal(out.value.data, null)
  assert.deepEqual(Array.from(out.attachments[0].bytes), Array.from(bytes))
})

test('Slice 2: encodeBinaryEnvelope / decodeBinaryEnvelope round-trips attachments and enforces bounds & prototype safety', () => {
  assert.equal(BINARY_ENVELOPE_REQUEST_HEADER, 'x-zr-binary-envelope')
  assert.equal(BINARY_ENVELOPE_ENCODING, 'binary-envelope')
  assert.equal(MAX_BINARY_ENVELOPE_BYTES, 128 * 1024 * 1024)
  assert.equal(MAX_BINARY_ENVELOPE_ATTACHMENTS, 64)

  // 1. Non-binary payload returns null (server falls back to JSON/gzip)
  assert.equal(encodeBinaryEnvelope({ version: 'v1', mimeType: 'text/plain', text: 'hi' }), null)

  // 2. Single image, nested multiple attachments, and empty Uint8Array round-trip
  const img = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const empty = new Uint8Array(0)
  const extra = new Uint8Array([1, 2, 3, 255])
  const value = {
    version: 'mtime:123',
    mimeType: 'image/png',
    data: img,
    extras: [{ empty }, extra],
  }
  const encoded = encodeBinaryEnvelope(value)
  assert.ok(Buffer.isBuffer(encoded))
  const decoded = decodeBinaryEnvelope(encoded)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.value.version, 'mtime:123')
  assert.equal(decoded.value.mimeType, 'image/png')
  assert.ok(decoded.value.data instanceof Uint8Array)
  assert.deepEqual(Array.from(decoded.value.data), Array.from(img))
  assert.ok(decoded.value.extras[0].empty instanceof Uint8Array)
  assert.equal(decoded.value.extras[0].empty.byteLength, 0)
  assert.deepEqual(Array.from(decoded.value.extras[1]), Array.from(extra))

  // 3. Mutating the source encoded buffer after decode does not mutate decoded views
  encoded.fill(0)
  assert.deepEqual(Array.from(decoded.value.data), Array.from(img))

  // 4. Malformed header/length checks
  assert.throws(() => decodeBinaryEnvelope(new Uint8Array(3)), /envelope/)
  const zeroLen = Buffer.alloc(4)
  assert.throws(() => decodeBinaryEnvelope(zeroLen), /envelope/)
  const trunc = Buffer.alloc(8)
  trunc.writeUInt32BE(100, 0)
  assert.throws(() => decodeBinaryEnvelope(trunc), /envelope/)

  // 5. Attachment byteLength mismatch & ok!==true rejected
  const badMeta = Buffer.from(JSON.stringify({ ok: true, value: { data: null }, attachments: [{ path: ['data'], byteLength: 10 }] }))
  const badBuf = Buffer.alloc(4 + badMeta.length + 3)
  badBuf.writeUInt32BE(badMeta.length, 0)
  badMeta.copy(badBuf, 4)
  assert.throws(() => decodeBinaryEnvelope(badBuf), /byteLength|mismatch/i)

  // 6. Prototype pollution keys in attachment path or JSON header are rejected
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const evilPathJson = Buffer.from(JSON.stringify({
      ok: true,
      value: { safe: null },
      attachments: [{ path: [key], byteLength: 2 }],
    }))
    const evilPathBuf = Buffer.alloc(4 + evilPathJson.length + 2)
    evilPathBuf.writeUInt32BE(evilPathJson.length, 0)
    evilPathJson.copy(evilPathBuf, 4)
    assert.throws(() => decodeBinaryEnvelope(evilPathBuf), /forbidden|unsafe|prototype/i)

    const evilObjJson = Buffer.from(`{"ok":true,"value":{"${key}":{"polluted":true},"data":null},"attachments":[{"path":["data"],"byteLength":1}]}`)
    const evilObjBuf = Buffer.alloc(4 + evilObjJson.length + 1)
    evilObjBuf.writeUInt32BE(evilObjJson.length, 0)
    evilObjJson.copy(evilObjBuf, 4)
    assert.throws(() => decodeBinaryEnvelope(evilObjBuf), /forbidden|unsafe|prototype/i)
  }

  // 7. Max attachments (64) limit enforced
  const tooMany = { items: Array.from({ length: 65 }, (_, i) => new Uint8Array([i])) }
  assert.throws(() => encodeBinaryEnvelope(tooMany), /attachment/i)
})
