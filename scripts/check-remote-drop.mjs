// Behaviour check for the remote-drop decision core
// (src/client-data/remote-drop.ts): the three-gate truth table, the
// directory / no-directory / no-entry-API three-state rule,
// block-directories precedence over redispatch, and the File re-wrap
// keeping name/type/lastModified.
//
// Run: node scripts/check-remote-drop.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  decideRemoteDrop,
  isRemoteSessionId,
  rewrapFiles,
} from '../src/client-data/remote-drop.ts'

const REMOTE_ID = 'zr~0123abcd~session-1'
const LOCAL_ID = 'session-6f2e9a10-1111-2222-3333-444455556666'
const fileItem = { kind: 'file', isDirectory: false }

// ---- 1. isRemoteSessionId ---------------------------------------------------
assert.equal(isRemoteSessionId(REMOTE_ID), true, 'a virtual id is remote')
assert.equal(isRemoteSessionId(LOCAL_ID), false, 'a plain session id is not remote')
assert.equal(isRemoteSessionId(undefined), false, 'no signal is not remote')
assert.equal(isRemoteSessionId(''), false, 'an empty id is not remote')
assert.equal(isRemoteSessionId('zr~short'), false, 'the full zr~ skeleton is required, not the bare prefix')

// ---- 2. the three-gate truth table -------------------------------------------
// trusted x hasHostPaths x remote over one plain file item: exactly the
// all-true row intervenes, every failing gate lands on passthrough with its
// own reason (untrusted first, then no bridge, then local session).
const truthTable = [
  [{ trusted: true, hasHostPaths: true, remote: true }, 'redispatch', 'remote-files'],
  [{ trusted: true, hasHostPaths: true, remote: false }, 'passthrough', 'not-remote-session'],
  [{ trusted: true, hasHostPaths: false, remote: true }, 'passthrough', 'no-host-paths'],
  [{ trusted: true, hasHostPaths: false, remote: false }, 'passthrough', 'no-host-paths'],
  [{ trusted: false, hasHostPaths: true, remote: true }, 'passthrough', 'untrusted-event'],
  [{ trusted: false, hasHostPaths: true, remote: false }, 'passthrough', 'untrusted-event'],
  [{ trusted: false, hasHostPaths: false, remote: true }, 'passthrough', 'untrusted-event'],
  [{ trusted: false, hasHostPaths: false, remote: false }, 'passthrough', 'untrusted-event'],
]
for (const [gates, action, reason] of truthTable) {
  const decision = decideRemoteDrop({
    trusted: gates.trusted,
    hasHostPaths: gates.hasHostPaths,
    currentSessionId: gates.remote ? REMOTE_ID : LOCAL_ID,
    items: [fileItem],
  })
  assert.deepEqual(decision, { action, reason }, `gates ${JSON.stringify(gates)}`)
}

// ---- 3. directory / no-directory / no-entry-API -------------------------------
// No entry API: redispatch with the host's own "no directories known" default.
assert.deepEqual(
  decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: undefined }),
  { action: 'redispatch', reason: 'no-entry-api' },
)
// Files only: redispatch.
assert.deepEqual(
  decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [fileItem, fileItem] }),
  { action: 'redispatch', reason: 'remote-files' },
)
// Any directory anywhere in the list: block, even mixed with plain files.
assert.deepEqual(
  decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [fileItem, { kind: 'file', isDirectory: true }] }),
  { action: 'block-directories', reason: 'contains-directory' },
)
assert.deepEqual(
  decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [{ kind: 'file', isDirectory: true }] }),
  { action: 'block-directories', reason: 'contains-directory' },
)
// A file item whose entry cannot be read counts as NOT a directory.
assert.deepEqual(
  decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [{ kind: 'file', isDirectory: false }] }),
  { action: 'redispatch', reason: 'remote-files' },
)
// String-only drags (no file items): the host's Files-in-types gate ignores
// those anyway — passthrough, zero intervention.
assert.deepEqual(
  decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [{ kind: 'other', isDirectory: false }] }),
  { action: 'passthrough', reason: 'no-files' },
)

// ---- 4. block-directories wins over redispatch ---------------------------------
// Already covered mixed above; pin it once more against the empty-items edge:
// a directory in an otherwise undecidable list still blocks.
assert.equal(
  decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [{ kind: 'other', isDirectory: false }, { kind: 'file', isDirectory: true }] }).action,
  'block-directories',
)

// ---- 5. rewrapFiles keeps name / type / lastModified ----------------------------
const original = new File(['hello'], 'report.pdf', { type: 'application/pdf', lastModified: 1700000000000 })
const [rewrapped] = rewrapFiles([original])
assert.notEqual(rewrapped, original, 'the rewrap must produce a distinct File')
assert.equal(rewrapped.name, 'report.pdf')
assert.equal(rewrapped.type, 'application/pdf')
assert.equal(rewrapped.lastModified, 1700000000000)
assert.equal(rewrapped.size, original.size, 'the content must ride along')
// Multiple files keep their order, and any iterable source works.
const pair = rewrapFiles([original, new File([new Uint8Array([1, 2])], 'a.txt', { type: 'text/plain', lastModified: 1 })])
assert.deepEqual(pair.map((f) => f.name), ['report.pdf', 'a.txt'])

// ---- 6. the folder-block branch dismisses the host drop overlay ---------------
// When a directory drop is stopped outright (no synthetic drop is redispatched),
// the host's bubble drop handler never runs reset(); the guard must fire a
// synthetic window `dragend` via dismissHostDropOverlay() so the overlay closes.
{
  const effects = readFileSync(new URL('../src/client/effects/remote-drop.ts', import.meta.url), 'utf8')
  assert.ok(effects.includes('function dismissHostDropOverlay'), 'the guard defines dismissHostDropOverlay')
  const calls = effects.match(/^\s*dismissHostDropOverlay\(\)\s*$/gm)?.length ?? 0
  assert.equal(calls, 1, `the folder-block branch calls dismissHostDropOverlay() as a standalone statement (saw ${calls})`)
}

console.log('check-remote-drop: ok')
