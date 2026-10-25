// Behaviour check for the remote-drop decision core
// (src/client-data/remote-drop.ts): the three-gate truth table and the
// directory / no-directory / no-entry-API three-state rule, with
// block-directories precedence over the workspace-upload action.
//
// Run: node scripts/check-remote-drop.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideRemoteDrop,
  isRemoteSessionId,
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
  [{ trusted: true, hasHostPaths: true, remote: true }, 'workspace-upload', 'remote-files'],
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
// No entry API: workspace-upload with the host's own "no directories known"
// default.
assert.deepEqual(
  decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: undefined }),
  { action: 'workspace-upload', reason: 'no-entry-api' },
)
// Files only: workspace-upload.
assert.deepEqual(
  decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [fileItem, fileItem] }),
  { action: 'workspace-upload', reason: 'remote-files' },
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
  { action: 'workspace-upload', reason: 'remote-files' },
)
// String-only drags (no file items): the host's Files-in-types gate ignores
// those anyway — passthrough, zero intervention.
assert.deepEqual(
  decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [{ kind: 'other', isDirectory: false }] }),
  { action: 'passthrough', reason: 'no-files' },
)

// ---- 4. block-directories wins over workspace-upload ----------------------------
// Already covered mixed above; pin it once more against the empty-items edge:
// a directory in an otherwise undecidable list still blocks.
assert.equal(
  decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [{ kind: 'other', isDirectory: false }, { kind: 'file', isDirectory: true }] }).action,
  'block-directories',
)

// ---- 5. the shared constants are declared exactly once (R1) --------------------
// WORKSPACE_UPLOAD_ROUTE and DROP_MENTION_EVENT live in
// remote-drop-contract.ts and every other module imports them from there.
// A re-declared local copy was mutation-proven silent (a typo in one of two
// spellings turned the full 1172-test suite 0 red), so this walks the
// source tree and refuses any second `const … =` declaration outside the
// declaring module.
const DECLARING_MODULE = new URL('../src/remote-drop-contract.ts', import.meta.url)
const PINNED_CONSTANTS = [
  ['const WORKSPACE_UPLOAD_ROUTE =', 'WORKSPACE_UPLOAD_ROUTE'],
  ['const DROP_MENTION_EVENT =', 'DROP_MENTION_EVENT'],
  // The value literals too (review nit): an inline 'zr:drop-mention' or the
  // route string outside the declaring leaf would rebuild the duplicate
  // spelling the structural import just removed.
  ['/_dsh/zen-remote/client/workspace-upload', 'WORKSPACE_UPLOAD_ROUTE'],
  ["'zr:drop-mention'", 'DROP_MENTION_EVENT'],
]
const SRC_ROOT = new URL('../src/', import.meta.url)
const walkSources = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSources(path)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (path === DECLARING_MODULE.pathname) continue
    const text = readFileSync(path, 'utf8')
    for (const [marker, name] of PINNED_CONSTANTS) {
      assert.ok(
        !text.includes(marker),
        `${path} must import ${name} from remote-drop-contract.ts, not re-declare it`,
      )
    }
  }
}
walkSources(SRC_ROOT.pathname)

// ---- 6. the guard dismisses the host drop overlay after eating a drop ------
// The overlay's only close paths are its own (stopped) drop handler and a
// window `dragend` (drop-events.ts); an OS-file drag never delivers a native
// one, so the guard must fire it itself in BOTH intercept branches. A text
// nail against accidental removal — behavior is verified on real hardware.
{
  const effects = readFileSync(new URL('../src/client/effects/remote-drop.ts', import.meta.url), 'utf8')
  assert.ok(effects.includes('function dismissHostDropOverlay'), 'the guard defines dismissHostDropOverlay')
  const calls = effects.match(/^\s*dismissHostDropOverlay\(\)\s*$/gm)?.length ?? 0
  assert.equal(calls, 2, `both intercept branches call dismissHostDropOverlay() as standalone statements (saw ${calls})`)
}

console.log('check-remote-drop: ok')
