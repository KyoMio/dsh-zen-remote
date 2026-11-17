import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decideRemoteDrop,
  decideRemoteIntake,
  isRemoteSessionId,
  rewrapFiles,
} from '../src/client-data/remote-drop.ts'

const REMOTE_ID = 'zr~0123abcd~session-1'
const LOCAL_ID = 'session-6f2e9a10-1111-2222-3333-444455556666'
const fileItem = { kind: 'file', isDirectory: false }

test('isRemoteSessionId', () => {
  assert.equal(isRemoteSessionId(REMOTE_ID), true)
  assert.equal(isRemoteSessionId(LOCAL_ID), false)
  assert.equal(isRemoteSessionId(undefined), false)
  assert.equal(isRemoteSessionId(''), false)
  assert.equal(isRemoteSessionId('zr~short'), false)
})

test('decideRemoteDrop: three-gate truth table, directory blocking, and rewrapFiles', () => {
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
    assert.deepEqual(
      decideRemoteDrop({
        trusted: gates.trusted,
        hasHostPaths: gates.hasHostPaths,
        currentSessionId: gates.remote ? REMOTE_ID : LOCAL_ID,
        items: [fileItem],
      }),
      { action, reason },
      `gates ${JSON.stringify(gates)}`,
    )
  }

  assert.deepEqual(
    decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: undefined }),
    { action: 'redispatch', reason: 'no-entry-api' },
  )
  assert.deepEqual(
    decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [fileItem, fileItem] }),
    { action: 'redispatch', reason: 'remote-files' },
  )
  assert.deepEqual(
    decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [fileItem, { kind: 'file', isDirectory: true }] }),
    { action: 'block-directories', reason: 'contains-directory' },
  )
  assert.deepEqual(
    decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [{ kind: 'file', isDirectory: true }] }),
    { action: 'block-directories', reason: 'contains-directory' },
  )
  assert.deepEqual(
    decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [{ kind: 'file', isDirectory: false }] }),
    { action: 'redispatch', reason: 'remote-files' },
  )
  assert.deepEqual(
    decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [{ kind: 'other', isDirectory: false }] }),
    { action: 'passthrough', reason: 'no-files' },
  )
  assert.equal(
    decideRemoteDrop({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: [{ kind: 'other', isDirectory: false }, { kind: 'file', isDirectory: true }] }).action,
    'block-directories',
  )

  const original = new File(['hello'], 'report.pdf', { type: 'application/pdf', lastModified: 1700000000000 })
  const [rewrapped] = rewrapFiles([original])
  assert.notEqual(rewrapped, original)
  assert.equal(rewrapped.name, 'report.pdf')
  assert.equal(rewrapped.type, 'application/pdf')
  assert.equal(rewrapped.lastModified, 1700000000000)
  assert.equal(rewrapped.size, original.size)
  const pair = rewrapFiles([original, new File([new Uint8Array([1, 2])], 'a.txt', { type: 'text/plain', lastModified: 1 })])
  assert.deepEqual(pair.map((f) => f.name), ['report.pdf', 'a.txt'])
})

test('decideRemoteIntake: picker, paste, drop, and directory precedence', () => {
  const pathFile = { entry: 'picker', isDirectory: false, hasPath: true, isImage: false }
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
    )
  }

  assert.deepEqual(intake({}, [pathFile]), { action: 'redirect', reason: 'remote-path-files' })
  assert.deepEqual(intake({}, [{ ...pathFile, isImage: true }]), { action: 'passthrough', reason: 'no-path-or-image-only' })
  assert.deepEqual(intake({}, [pathlessFile]), { action: 'passthrough', reason: 'no-path-or-image-only' })
  assert.deepEqual(
    intake({}, [{ ...pathFile, hasPath: false }, { ...pathFile, isImage: true }]),
    { action: 'passthrough', reason: 'no-path-or-image-only' },
  )
  assert.deepEqual(
    intake({}, [pathlessFile, { ...pathFile, isImage: true }, pathFile]),
    { action: 'redirect', reason: 'remote-path-files' },
  )

  assert.deepEqual(intake({}, []), { action: 'passthrough', reason: 'no-files' })
  assert.deepEqual(intake({}, [{ ...pasteFile }]), { action: 'redirect', reason: 'remote-path-files' })
  assert.deepEqual(intake({}, [{ ...pasteFile, isImage: true }]), { action: 'passthrough', reason: 'no-path-or-image-only' })
  assert.deepEqual(intake({}, [{ ...pasteFile, hasPath: false }]), { action: 'passthrough', reason: 'no-path-or-image-only' })

  assert.deepEqual(intake({}, [{ ...dropFile, hasPath: false, isImage: true }]), { action: 'redirect', reason: 'remote-path-files' })
  assert.deepEqual(intake({}, [{ ...dropFile, hasPath: false, isImage: true }, pathlessFile]), { action: 'redirect', reason: 'remote-path-files' })

  assert.deepEqual(intake({}, [{ ...pasteFile, isDirectory: true }, pasteFile]), { action: 'block-directories', reason: 'contains-directory' })
  assert.deepEqual(intake({}, [{ ...pathFile, isDirectory: true }]), { action: 'block-directories', reason: 'contains-directory' })
  assert.deepEqual(intake({}, [{ ...dropFile, isDirectory: true }]), { action: 'block-directories', reason: 'contains-directory' })
  assert.deepEqual(intake({ currentSessionId: LOCAL_ID }, [{ ...pasteFile, isDirectory: true }]), { action: 'passthrough', reason: 'not-remote-session' })

  assert.deepEqual(
    decideRemoteIntake({ trusted: true, hasHostPaths: true, currentSessionId: REMOTE_ID, items: undefined }),
    { action: 'passthrough', reason: 'no-entry-api' },
  )
})
