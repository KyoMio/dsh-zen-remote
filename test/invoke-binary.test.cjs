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
let BINARY_MARKER
let INVOKE_BINARY_RESULT_METHODS

before(async () => {
  ;({ markInvokeBinary, restoreInvokeBinary, extractResultAttachments, BINARY_MARKER, INVOKE_BINARY_RESULT_METHODS } = await import(
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
  assert.deepEqual([...INVOKE_BINARY_RESULT_METHODS], ['workspaceFiles/readBytes', 'officeToPdf/render'])
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
