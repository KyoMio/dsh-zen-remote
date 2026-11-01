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
  decideRemoteIntake,
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
  // The picker's structural gate refuses a `webkitdirectory` input on the
  // SAME line as the other four traits (RU-fix adoption 2): a third-party
  // hidden+multiple+no-accept folder picker must not be redirected.
  assert.ok(
    /input\.type !== 'file' \|\| !input\.multiple \|\| !input\.hidden \|\| input\.hasAttribute\('accept'\) \|\| input\.webkitdirectory/.test(effects),
    'the picker gate checks type/multiple/hidden/accept/webkitdirectory in one condition',
  )
}

// ---- 7. decideRemoteIntake (AU-1): the picker / paste entry decision ----------
// Reusable descriptor builders. `pathFile` = carries a disk path, not an image
// — the ONE shape that lands on the host's zero-copy `@path` chip and the only
// one the intake may intercept. `imageFile` = carries a path but is an image
// (already byte-uploads). `pathlessFile` = no path (already byte-uploads).
const pathFile = { entry: 'picker', isDirectory: false, hasPath: true, isImage: false }
const imageFile = { entry: 'picker', isDirectory: false, hasPath: true, isImage: true }
const pathlessFile = { entry: 'picker', isDirectory: false, hasPath: false, isImage: false }
const pasteFile = { entry: 'paste', isDirectory: false, hasPath: true, isImage: false }
const dropFile = { entry: 'drop', isDirectory: false, hasPath: true, isImage: false }

const intake = (overrides, items = [pathFile]) =>
  decideRemoteIntake({
    trusted: true,
    hasHostPaths: true,
    currentSessionId: REMOTE_ID,
    items,
    ...overrides,
  })

// 7a. the three gates hold for EVERY entry — one row per gate per entry
// (untrusted → no bridge → local session), plus the drop entry as a control.
{
  const gateRows = [
    [{ entry: 'picker' }, { trusted: false }, 'passthrough', 'untrusted-event'],
    [{ entry: 'picker' }, { hasHostPaths: false }, 'passthrough', 'no-host-paths'],
    [{ entry: 'picker' }, { currentSessionId: LOCAL_ID }, 'passthrough', 'not-remote-session'],
    [{ entry: 'paste' }, { trusted: false }, 'passthrough', 'untrusted-event'],
    [{ entry: 'paste' }, { hasHostPaths: false }, 'passthrough', 'no-host-paths'],
    [{ entry: 'paste' }, { currentSessionId: LOCAL_ID }, 'passthrough', 'not-remote-session'],
    [{ entry: 'drop' }, { trusted: false }, 'passthrough', 'untrusted-event'],
    [{ entry: 'drop' }, { hasHostPaths: false }, 'passthrough', 'no-host-paths'],
    [{ entry: 'drop' }, { currentSessionId: LOCAL_ID }, 'passthrough', 'not-remote-session'],
  ]
  for (const [entryOverride, gateOverride, action, reason] of gateRows) {
    const item = { ...pathFile, ...entryOverride }
    assert.deepEqual(
      intake({ ...gateOverride, currentSessionId: gateOverride.currentSessionId ?? REMOTE_ID }, [item]),
      { action, reason },
      `gate row ${JSON.stringify({ ...entryOverride, ...gateOverride })}`,
    )
  }
}

// 7b. picker intervention: ONLY the path-carrying non-image file redirects.
assert.deepEqual(intake({}, [pathFile]), { action: 'redirect', reason: 'remote-path-files' }, 'picker: a path-carrying non-image redirects')
assert.deepEqual(intake({}, [{ ...pathFile, isImage: true }]), { action: 'passthrough', reason: 'no-path-or-image-only' }, 'picker: a pure-image pick passes through (the image branch already uploads bytes)') // 钉子
assert.deepEqual(intake({}, [pathlessFile]), { action: 'passthrough', reason: 'no-path-or-image-only' }, 'picker: a pathless file passes through')
assert.deepEqual(
  intake({}, [{ ...pathFile, hasPath: false }, { ...pathFile, isImage: true }]),
  { action: 'passthrough', reason: 'no-path-or-image-only' },
  'picker: mixed pathless + image still passes through — no bad-branch file in the batch',
)
assert.deepEqual(
  intake({}, [pathlessFile, { ...pathFile, isImage: true }, pathFile]),
  { action: 'redirect', reason: 'remote-path-files' },
  'picker: ONE bad-branch file in the batch redirects the whole intake',
)

// 7c. paste: only kind:'file' clipboard items reach the descriptors, so a
// plain-text paste arrives as an EMPTY list (钉子) — and an image-only paste
// passes through exactly like the picker's.
assert.deepEqual(intake({}, []), { action: 'passthrough', reason: 'no-files' }, 'paste: an empty file list (plain text) passes through') // 钉子
assert.deepEqual(intake({}, [{ ...pasteFile }]), { action: 'redirect', reason: 'remote-path-files' }, 'paste: a path-carrying non-image redirects')
assert.deepEqual(
  intake({}, [{ ...pasteFile, isImage: true }]),
  { action: 'passthrough', reason: 'no-path-or-image-only' },
  'paste: a pasted screenshot (image with a path) passes through — unchanged behavior',
)
assert.deepEqual(
  intake({}, [{ ...pasteFile, hasPath: false }]),
  { action: 'passthrough', reason: 'no-path-or-image-only' },
  'paste: a pathless file passes through',
)

// 7d. drop entries keep the FROZEN "any file intervenes" semantics: even a
// pathless / image drop item redirects (decideRemoteDrop never looked at
// paths), while the same items through picker/paste would pass through.
assert.deepEqual(
  intake({}, [{ ...dropFile, hasPath: false, isImage: true }]),
  { action: 'redirect', reason: 'remote-path-files' },
  'drop: any file intervenes, frozen semantics',
)
assert.deepEqual(
  intake({}, [{ ...dropFile, hasPath: false, isImage: true }, pathlessFile]),
  { action: 'redirect', reason: 'remote-path-files' },
  'mixed entries: one drop item keeps the whole intake on the drop semantics',
)

// 7e. directories block ahead of every redirect, in any entry (钉子: the
// directory rule outranks a bad-branch file in the same batch).
assert.deepEqual(
  intake({}, [{ ...pasteFile, isDirectory: true }, pasteFile]),
  { action: 'block-directories', reason: 'contains-directory' },
  'paste: a directory blocks even with a redirect-worthy file present',
) // 钉子
assert.deepEqual(
  intake({}, [{ ...pathFile, isDirectory: true }]),
  { action: 'block-directories', reason: 'contains-directory' },
  'picker: a directory blocks (defensive — the picker has none, the rule is shared)',
)
assert.deepEqual(
  intake({}, [{ ...dropFile, isDirectory: true }]),
  { action: 'block-directories', reason: 'contains-directory' },
  'drop entries block on directories like decideRemoteDrop',
)
// Gates outrank the directory rule: a local session never intervenes, even on
// a folder (folders must keep working locally).
assert.deepEqual(
  intake({ currentSessionId: LOCAL_ID }, [{ ...pasteFile, isDirectory: true }]),
  { action: 'passthrough', reason: 'not-remote-session' },
  'a directory in a LOCAL session passes through — the gates come first',
)

// 7f. no inventory at all: deciding blind could eat a working flow — pass
// through even in a remote session. (Direct call: the helper's default list
// would mask the undefined.)
assert.deepEqual(
  decideRemoteIntake({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: undefined }),
  { action: 'passthrough', reason: 'no-entry-api' },
)

console.log('check-remote-drop: ok')
