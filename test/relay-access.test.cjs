/* dsh-zen-remote · T22a-fix relay access control (src/relay-access.ts)
 *
 * The registry is the security boundary now, so these tests pin BOTH halves
 * of it: every REGISTERED method must authorize strictly along its declared
 * fields (and only those), and every UNREGISTERED method must refuse before
 * an id is even read — including the reviewer's three decoy bypasses, where
 * a shared id smuggled into an unused `request.sessionId` field must buy
 * nothing. `isAccessible` is a stub the test controls; the real store wiring
 * is covered by relay-server.test.cjs.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { decideInvoke } = require('../lib/relay-access.js')

const yes = () => true
const no = () => false
const only = (shared) => (id) => shared.includes(id)

// -- unregistered methods refuse unconditionally ---------------------------------

test('decideInvoke: the three reviewer bypass requests are forbidden-method, decoy or not', () => {
  // exp2.mjs reproduction, at the decision layer: a shared session id
  // ('S-shared') padded into fields the method does not own must not matter,
  // because the METHODS are not registered at all.
  assert.deepEqual(
    decideInvoke('session', 'search', { request: { query: 'password', sessionId: 'S-shared' } }, only(['S-shared'])),
    { allow: false, reason: 'forbidden-method' },
    'session/search is located by query, not by any session id',
  )
  assert.deepEqual(
    decideInvoke('goals', 'create', { agentId: 'VICTIM', request: { objective: 'x', maxGoalRounds: 3, sessionId: 'S-shared' } }, only(['S-shared'])),
    { allow: false, reason: 'forbidden-method' },
    'goals/create is located by a top-level agentId — not registered until P4 verifies ownership',
  )
  assert.deepEqual(
    decideInvoke('subagents', 'prompt', { request: { parentSessionId: 'VICTIM', childSessionId: 'C', sessionId: 'S-shared' } }, only(['S-shared'])),
    { allow: false, reason: 'forbidden-method' },
    'subagents/* waits for T31 to verify the parent-child ownership check',
  )
})

test('decideInvoke: any unregistered method refuses, with or without a request object', () => {
  for (const [namespace, method, args] of [
    ['settings', 'update', { ns: 'x', patch: {} }],
    ['terminal', 'create', { agentId: 'a', request: { shellPath: '/bin/zsh' } }],
    ['account', 'getProfile', { client: {} }],
    ['pluginManager', 'listPlugins', {}],
    ['session', 'list', { _request: {} }],
    ['session', 'fork', { request: { sessionId: 'S-shared', atSeq: 1 } }],
    ['workspace', 'follow', {}],
    ['schedule', 'delete', { request: { id: 's1', sessionId: 'S-shared' } }],
    ['anything', 'atAll', 'garbage'],
    ['nope', 'x', undefined],
  ]) {
    assert.deepEqual(
      decideInvoke(namespace, method, args, yes),
      { allow: false, reason: 'forbidden-method' },
      `${namespace}/${method} is not registered`,
    )
  }
})

// -- streaming entries refuse the invoke route ------------------------------------

test('decideInvoke: a stream-only entry is forbidden on the invoke route', () => {
  const shared = ['S-shared']
  assert.deepEqual(
    decideInvoke('session', 'follow', { request: { address: { kind: 'session', sessionId: 'S-shared' } } }, only(shared)),
    { allow: false, reason: 'forbidden-method' },
    'session/follow is stream-only; T22b streams it',
  )
  assert.deepEqual(
    decideInvoke('job', 'list', { request: { sessionId: 'S-shared' } }, only(shared)),
    { allow: false, reason: 'forbidden-method' },
    'job/list is stream-only too',
  )
  assert.deepEqual(
    decideInvoke('job', 'follow', { request: { sessionId: 'S-shared' } }, only(shared)),
    { allow: false, reason: 'forbidden-method' },
  )
})

// -- registered methods: request.sessionId field -----------------------------------

test('decideInvoke: request.sessionId methods authorize strictly on that field', () => {
  const shared = ['S-a', 'S-b']
  const cases = [
    ['session', 'projections', { request: { sessionId: 'S-a' } }],
    ['session', 'prompt', { request: { requestId: 'r', sessionId: 'S-a', mode: 'queue', content: [] } }],
    ['session', 'cancel', { request: { sessionId: 'S-a' } }],
    ['session', 'rename', { request: { sessionId: 'S-b', title: 'x' } }],
    ['session', 'selectModel', { request: { sessionId: 'S-b', provider: 'p', model: 'm' } }],
    ['session', 'updateQueue', { request: { sessionId: 'S-b', itemId: 'i', action: 'x' } }],
    ['session', 'attachment', { request: { sessionId: 'S-b', attachmentId: 'f' } }],
    ['job', 'kill', { request: { sessionId: 'S-b', jobId: 'j' } }],
    ['skills', 'list', { request: { sessionId: 'S-b' } }],
    ['messageFeedback', 'list', { request: { sessionId: 'S-b' } }],
    ['messageFeedback', 'put', { request: { sessionId: 'S-b', messageId: 'm', rating: 'up' } }],
    ['messageFeedback', 'delete', { request: { sessionId: 'S-b', messageId: 'm' } }],
    ['schedule', 'list', { request: { sessionId: 'S-b' } }],
    ['workspace', 'pinSession', { request: { sessionId: 'S-b' } }],
    ['workspace', 'unpinSession', { request: { sessionId: 'S-b' } }],
    ['workspace', 'archiveSession', { request: { sessionId: 'S-b', stopActivity: true } }],
    ['workspace', 'unarchiveSession', { request: { sessionId: 'S-b' } }],
  ]
  for (const [namespace, method, args] of cases) {
    assert.deepEqual(decideInvoke(namespace, method, args, only(shared)), { allow: true }, `${namespace}/${method} with a shared id`)
    assert.deepEqual(
      decideInvoke(namespace, method, args, only([])),
      { allow: false, reason: 'not-shared' },
      `${namespace}/${method} with an unshared id`,
    )
  }
})

test('decideInvoke: a decoy NEXT to the real field does not unlock anything', () => {
  // Even on a registered method the extra id is dead weight: authorization
  // reads the declared field, nothing else — an unshared REAL id refuses
  // regardless of what decoys ride along.
  const args = { request: { sessionId: 'VICTIM', extra: 'S-shared' } }
  assert.deepEqual(decideInvoke('session', 'rename', args, only([])), { allow: false, reason: 'not-shared' })
  assert.deepEqual(decideInvoke('session', 'rename', args, only(['S-shared'])), { allow: false, reason: 'not-shared' })
})

test('decideInvoke: missing, empty, or non-string field values are no-session', () => {
  for (const args of [
    { request: {} },
    { request: { sessionId: '' } },
    { request: { sessionId: 42 } },
    { request: { sessionId: null } },
    { request: 'not-an-object' },
    {},
    'garbage',
    null,
    undefined,
    7,
  ]) {
    assert.deepEqual(
      decideInvoke('session', 'projections', args, yes),
      { allow: false, reason: 'no-session' },
      JSON.stringify(args) + ' claims no session through the registered field',
    )
  }
})

// -- registered methods: request.address field --------------------------------------

test('decideInvoke: address kind session uses sessionId, subagent uses parentSessionId', () => {
  const shared = ['S-parent', 'S-direct']
  assert.deepEqual(
    decideInvoke('session', 'page', { request: { address: { kind: 'session', sessionId: 'S-direct' }, throughSeq: 5 } }, only(shared)),
    { allow: true },
  )
  assert.deepEqual(
    decideInvoke('session', 'page', { request: { address: { kind: 'subagent', parentSessionId: 'S-parent', childSessionId: 'S-child', mode: 'continuable' } } }, only(shared)),
    { allow: true },
    'a subagent call judges by its parent; DSH validates the parent-child link',
  )
  assert.deepEqual(
    decideInvoke('session', 'page', { request: { address: { kind: 'subagent', parentSessionId: 'VICTIM' } } }, only(shared)),
    { allow: false, reason: 'not-shared' },
  )
  assert.deepEqual(
    decideInvoke('session', 'page', { request: { address: { kind: 'session', sessionId: 'VICTIM' } } }, only(shared)),
    { allow: false, reason: 'not-shared' },
  )
})

test('decideInvoke: unknown address kinds and missing address ids are no-session', () => {
  for (const address of [
    { kind: 'direct', sessionId: 'S-x' },
    { kind: 'workspace', workspaceId: 'w' },
    { sessionId: 'S-x' },
    {},
    { kind: 'session' },
    { kind: 'subagent', childSessionId: 'S-child' },
    { kind: 'subagent', parentSessionId: '' },
    { kind: 'subagent', parentSessionId: 3 },
  ]) {
    assert.deepEqual(
      decideInvoke('session', 'page', { request: { address } }, yes),
      { allow: false, reason: 'no-session' },
      'address ' + JSON.stringify(address),
    )
  }
  assert.deepEqual(decideInvoke('session', 'page', { request: {} }, yes), { allow: false, reason: 'no-session' })
})
