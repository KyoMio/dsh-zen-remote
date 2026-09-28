/* dsh-zen-remote · share ops (src/share-ops.ts, T33a)
 *
 * The two pure host-side operations on the shared table, driven with a REAL
 * createShareStore over a temp file (their whole point is how they move the
 * table's clocks and flags, so a fake would only restate the assertions):
 *
 * - restoreBusy: the post-restart re-marking of sessions whose agent is
 *   mid-turn. Field semantics verified against DSH 0.2.0 (see the module
 *   comment in share-ops.ts): an agent id IS a session id and `status` is
 *   'idle' | 'running'.
 * - onSessionCreated: the share decision for one fresh session header —
 *   top-level (autoShare), fork (parentSession + origin absent), subagent
 *   (origin 'subagent', never enters the table).
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { restoreBusy, onSessionCreated } = require('../lib/share-ops.js')
const { createShareStore } = require('../lib/share-store.js')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-share-ops-'))
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

let fileCounter = 0
function makeStore() {
  fileCounter += 1
  return createShareStore({ file: path.join(ROOT, `shares-${fileCounter}.json`), idleHours: 48 })
}

// ---- restoreBusy ----------------------------------------------------------------

test('restoreBusy marks shared sessions whose agent is running, and nothing else', () => {
  const store = makeStore()
  store.share('s-running')
  store.share('s-idle')
  // 's-stranger' runs but was never shared: the store must not hear about it.
  restoreBusy(store, () => [
    { id: 's-running', status: 'running' },
    { id: 's-idle', status: 'idle' },
    { id: 's-stranger', status: 'running' },
  ])
  const busy = Object.fromEntries(store.list().map((e) => [e.sessionId, e.busy]))
  assert.equal(busy['s-running'], true, 'a shared session with a running agent is busy')
  assert.equal(busy['s-idle'], false, 'an idle agent stays idle')
  assert.equal(store.isShared('s-stranger'), false, 'an unshared runner is never added')
})

test('restoreBusy never clears a busy flag and never moves lastActivityAt', () => {
  const store = makeStore()
  store.share('s-a')
  store.setBusy('s-a', true)
  const before = store.list()[0].lastActivityAt
  // Nobody is running any more (the turn ended while the process was down):
  // the restore must NOT stamp busy false (which would restart the idle
  // clock) — T22c's turn/end owns the clearing.
  restoreBusy(store, () => [{ id: 's-a', status: 'idle' }])
  const row = store.list()[0]
  assert.equal(row.busy, true, 'restore only sets busy, never clears')
  assert.equal(row.lastActivityAt, before, 'and it never touches the activity clock')
})

test('restoreBusy tolerates a throwing roster and a malformed one', () => {
  const store = makeStore()
  store.share('s-a')
  assert.doesNotThrow(() => restoreBusy(store, () => { throw new Error('agents service exploded') }))
  assert.equal(store.list()[0].busy, false, 'no information means no change')
  assert.doesNotThrow(() => restoreBusy(store, () => [null, undefined, 42, {}, { id: 's-a' }, { id: 's-a', status: 'running' }]))
  assert.equal(store.list()[0].busy, true, 'the one well-formed running entry still lands')
})

test('restoreBusy follows forked/subagent sessions only through the table: a shared parent is not busy because its CHILD runs', () => {
  const store = makeStore()
  store.share('parent')
  // The child agent runs under its own id; restoreBusy is table-scoped on
  // purpose (a child's motion reaches the parent through T22c's touch, not
  // through busy).
  restoreBusy(store, () => [{ id: 'child', status: 'running' }])
  assert.equal(store.list()[0].busy, false)
})

// ---- onSessionCreated ------------------------------------------------------------

const noopParent = () => undefined

test('onSessionCreated: a top-level session is shared exactly when autoShare is on', () => {
  const store = makeStore()
  assert.equal(onSessionCreated({ id: 'top-1' }, { store, autoShare: true, parentOf: noopParent }), true)
  assert.equal(store.isShared('top-1'), true)

  const off = makeStore()
  assert.equal(onSessionCreated({ id: 'top-2' }, { store: off, autoShare: false, parentOf: noopParent }), false)
  assert.equal(off.isShared('top-2'), false)
})

test('onSessionCreated: a subagent session never enters the table, autoShare on or off', () => {
  const store = makeStore()
  const header = { id: 'child-1', origin: 'subagent', parentSession: 'top-1' }
  assert.equal(onSessionCreated(header, { store, autoShare: true, parentOf: noopParent }), false)
  assert.equal(store.isShared('child-1'), false)
  assert.equal(store.isShared('top-1'), false, 'the parent is not dragged in either')
})

test('onSessionCreated: a fork follows an accessible source, shared directly or through an ancestor', () => {
  const store = makeStore()
  const parentOf = (id) => (id === 'child-of-shared' ? 'shared-ancestor' : undefined)

  store.share('source')
  assert.equal(
    onSessionCreated({ id: 'fork-1', parentSession: 'source', isSeeded: true }, { store, autoShare: false, parentOf: noopParent }),
    true,
    'fork of a directly shared source joins the table',
  )
  assert.equal(store.isShared('fork-1'), true)

  store.share('shared-ancestor')
  assert.equal(
    onSessionCreated({ id: 'fork-2', parentSession: 'child-of-shared', isSeeded: true }, { store, autoShare: false, parentOf }),
    true,
    'a fork whose source is only reachable through a shared ancestor joins too',
  )
  assert.equal(store.isShared('fork-2'), true)
})

test('onSessionCreated: a fork obeys autoShare too — an unreachable source shares when the knob is on, not when off', () => {
  const on = makeStore()
  assert.equal(
    onSessionCreated({ id: 'fork-3', parentSession: 'never-shared', isSeeded: true }, { store: on, autoShare: true, parentOf: noopParent }),
    true,
    'a fork is an ordinary new session: autoShare applies even when the source is unreachable',
  )
  assert.equal(on.isShared('fork-3'), true)

  const off = makeStore()
  assert.equal(
    onSessionCreated({ id: 'fork-4', parentSession: 'never-shared', isSeeded: true }, { store: off, autoShare: false, parentOf: noopParent }),
    false,
    'with the knob off, an unreachable source still shares nothing',
  )
  assert.equal(off.isShared('fork-4'), false)
})

test('onSessionCreated: hostile or header-less shapes are ignored', () => {
  const store = makeStore()
  for (const header of [undefined, null, 42, 'x', {}, { origin: 'subagent' }, { parentSession: 'p' }, { id: '' }]) {
    assert.equal(onSessionCreated(header, { store, autoShare: true, parentOf: noopParent }), false, JSON.stringify(header))
  }
  assert.equal(store.list().length, 0)
})

test('onSessionCreated: sharing an already-shared fork is a no-op that keeps sharedAt', () => {
  const store = makeStore()
  store.share('source')
  assert.equal(onSessionCreated({ id: 'fork-1', parentSession: 'source' }, { store, autoShare: false, parentOf: noopParent }), true)
  const first = store.list().find((e) => e.sessionId === 'fork-1')
  // A repeat creation announcement (the same header announced twice) must
  // not move the original timestamp.
  assert.equal(onSessionCreated({ id: 'fork-1', parentSession: 'source' }, { store, autoShare: false, parentOf: noopParent }), false)
  const second = store.list().find((e) => e.sessionId === 'fork-1')
  assert.equal(second.sharedAt, first.sharedAt, 'sharedAt stays at the first share')
})
