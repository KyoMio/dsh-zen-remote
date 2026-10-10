// dsh-zen-remote · PB-14: the bridge stamp's pure core
// (src/client-data/remote-status.ts)
//
// The remote-status body's `bridgedPlugins` list decides whether the
// better-sidebar panels stay visible in a remote session: the pure parse
// (tolerant — a garbage field degrades to "nothing bridged") and the
// shouldStampBridgeAttribute verdict the remote-session effect spends on
// the html attribute. Pure functions, driven the dynamic .ts way.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/client-data/remote-status.ts?' + Math.random())

test('PB-14: the parse carries bridgedPlugins tolerantly', async () => {
  const { parseRemoteStatusBody } = await load()
  const now = 1_700_000_000_000

  // A real body: the list rides through verbatim.
  const full = parseRemoteStatusBody({ state: 'online', bridgedPlugins: ['dsh-better-sidebar', 'other-panel'] }, now)
  assert.deepEqual(full.bridgedPlugins, ['dsh-better-sidebar', 'other-panel'])

  // Non-string and empty entries are dropped, not kept.
  const filtered = parseRemoteStatusBody({ bridgedPlugins: ['dsh-better-sidebar', 42, null, '', 'x'] }, now)
  assert.deepEqual(filtered.bridgedPlugins, ['dsh-better-sidebar', 'x'])

  // An older server that never learned the field, or a broken body, reads
  // as NOTHING bridged — the hiding rules stay in force.
  assert.deepEqual(parseRemoteStatusBody({ state: 'online' }, now).bridgedPlugins, [])
  assert.deepEqual(parseRemoteStatusBody({ bridgedPlugins: 'dsh-better-sidebar' }, now).bridgedPlugins, [])
  assert.deepEqual(parseRemoteStatusBody({ bridgedPlugins: { 0: 'dsh-better-sidebar' } }, now).bridgedPlugins, [])
  assert.deepEqual(parseRemoteStatusBody('garbage', now).bridgedPlugins, [])
})

test('PB-14: shouldStampBridgeAttribute judges one plugin off the list', async () => {
  const { shouldStampBridgeAttribute, BRIDGE_STAMP_ATTRIBUTE, BRIDGE_STAMP_PLUGIN } = await load()
  assert.equal(BRIDGE_STAMP_PLUGIN, 'dsh-better-sidebar')
  assert.equal(BRIDGE_STAMP_ATTRIBUTE, 'data-zr-bridge-dsh-better-sidebar')

  assert.equal(shouldStampBridgeAttribute(['dsh-better-sidebar'], 'dsh-better-sidebar'), true)
  assert.equal(shouldStampBridgeAttribute(['other-panel'], 'dsh-better-sidebar'), false)
  // Garbage inputs read as NOT bridged — the hiding rules stay unless the
  // server positively says otherwise.
  assert.equal(shouldStampBridgeAttribute(undefined, 'dsh-better-sidebar'), false)
  assert.equal(shouldStampBridgeAttribute('dsh-better-sidebar', 'dsh-better-sidebar'), false)
  assert.equal(shouldStampBridgeAttribute(null, 'dsh-better-sidebar'), false)
})

test('PB-14: the parse keeps every OTHER field\u2019s tolerance while bridgedPlugins lands', async () => {
  const { parseRemoteStatusBody } = await load()
  const now = 1
  const view = parseRemoteStatusBody({ state: 'online', versionMismatch: true, serverName: 'srv', closed: { 's1': 'idle' } }, now)
  assert.equal(view.state, 'online')
  assert.equal(view.versionMismatch, true)
  assert.equal(view.serverName, 'srv')
  assert.deepEqual(view.closed, { s1: 'idle' })
  assert.equal(view.asOf, now)
})
