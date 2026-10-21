// dsh-zen-remote · 2.2.6 follow-up: dropped files become uploads in remote sessions
// (src/client/effects/host-path-bridge.ts)
//
// DSH's composer asks the desktop shell for a dropped file's absolute path and,
// when it gets one, inserts `@<path>` instead of uploading — fine locally,
// broken in a remote session (the path is on the client, the agent on the
// host). The guard makes `pathFor` answer undefined while a remote session is
// on screen, which sends the composer down its own upload branch. These tests
// drive the wrapper against a fake global — no DOM, no shell.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const KEY = '__DSH_HOST_PATHS__'

/** Install a fake bridge on the global and load a fresh module copy. */
async function setup(bridge) {
  const g = globalThis
  const had = Object.prototype.hasOwnProperty.call(g, KEY)
  const before = g[KEY]
  if (bridge === undefined) delete g[KEY]
  else g[KEY] = bridge
  const mod = await import('../src/client/effects/host-path-bridge.ts?' + Math.random())
  return {
    mod,
    restore() {
      if (had) g[KEY] = before
      else delete g[KEY]
    },
  }
}

test('local session: pathFor delegates to the shell bridge unchanged', async () => {
  let remote = false
  const bridge = { pathFor: (file) => `C:\\drops\\${file.name}`, other: 42 }
  const env = await setup(bridge)
  try {
    const uninstall = env.mod.installHostPathBridgeGuard(() => remote)
    assert.equal(globalThis[KEY].pathFor({ name: 'a.txt' }), 'C:\\drops\\a.txt')
    assert.equal(globalThis[KEY].other, 42, 'other members pass through')
    remote = true
    assert.equal(globalThis[KEY].pathFor({ name: 'a.txt' }), undefined, 'remote session: the composer must upload instead')
    uninstall()
    assert.equal(globalThis[KEY], bridge, 'uninstall restores the original object')
    assert.equal(globalThis[KEY].pathFor({ name: 'a.txt' }), 'C:\\drops\\a.txt')
  } finally {
    env.restore()
  }
})

test('no bridge (web UI or a shell without it) is a no-op', async () => {
  const env = await setup(undefined)
  try {
    const uninstall = env.mod.installHostPathBridgeGuard(() => true)
    assert.equal(globalThis[KEY], undefined)
    uninstall()
  } finally {
    env.restore()
  }
})

test('a bridge without pathFor still passes through', async () => {
  const env = await setup({ other: 'x' })
  try {
    env.mod.installHostPathBridgeGuard(() => true)
    assert.equal(globalThis[KEY].pathFor({ name: 'x' }), undefined, 'no shell pathFor means no path')
    assert.equal(globalThis[KEY].other, 'x')
  } finally {
    env.restore()
  }
})

test('a second install adopts the live wrapper, and only the current owner unwraps it', async () => {
  let remote = false
  const bridge = { pathFor: () => 'C:\\p\\x' }
  const env = await setup(bridge)
  try {
    const first = env.mod.installHostPathBridgeGuard(() => remote)
    const installed = globalThis[KEY]
    const second = env.mod.installHostPathBridgeGuard(() => remote)
    assert.equal(globalThis[KEY], installed, 'the live wrapper stays the one global')
    remote = true
    assert.equal(globalThis[KEY].pathFor({ name: 'x' }), undefined)
    first()
    assert.equal(globalThis[KEY], installed, 'the old generation dispose must not unwrap the adopted wrapper')
    remote = false
    assert.equal(globalThis[KEY].pathFor({ name: 'x' }), 'C:\\p\\x')
    second()
    assert.equal(globalThis[KEY], bridge, 'the owning generation restores the original')
  } finally {
    env.restore()
  }
})
