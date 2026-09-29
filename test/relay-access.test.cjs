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
const { decideHttpRoute, decideInvoke, decideStream } = require('../lib/relay-access.js')

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
    'goals/create is located by a top-level agentId — still unregistered (no ownership story)',
  )
})

test('decideInvoke: any unregistered method refuses, with or without a request object', () => {
  for (const [namespace, method, args] of [
    ['settings', 'update', { ns: 'x', patch: {} }],
    // T41a registered the goals bar, commands, the preset switches, the
    // workspace-files group and the whole terminal half — the REST of those
    // namespaces stay closed (global data, third-party surfaces, or calls
    // the panels do not make remotely).
    ['goals', 'create', { agentId: 'VICTIM', request: {} }],
    ['goals', 'complete', { agentId: 'VICTIM', ref: {} }],
    ['agentPresets', 'list', {}],
    ['agentPresets', 'read', { agentPreset: 'p' }],
    ['permissionPresets', 'catalog', {}],
    ['officeToPdf', 'render', { request: { path: 'x' } }],
    ['dynamicCordisRunner', 'invoke', { agentId: 'VICTIM', request: {} }],
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
    'session/follow is stream-only; the stream route serves it',
  )
  for (const [namespace, method, args] of [
    ['job', 'list', { request: { sessionId: 'S-shared' } }],
    ['job', 'follow', { request: { sessionId: 'S-shared', jobId: 'j1' } }],
    // The two global streams are registered since T22b — but only for the
    // stream route; riding them through invoke stays forbidden.
    ['workspace', 'follow', {}],
    ['session', 'control', {}],
  ]) {
    assert.deepEqual(
      decideInvoke(namespace, method, args, only(shared)),
      { allow: false, reason: 'forbidden-method' },
      `${namespace}/${method} is stream-only`,
    )
  }
})

// -- session/list: allowed on invoke, result marked for filtering --------------------

test('decideInvoke: session/list is allowed without any session field, result marked session-list', () => {
  // No session fields to check: the access decision does not depend on the
  // share table at all — the RESULT filter (relay-filter.ts) is what keeps
  // unshared sessions out of the client's list.
  assert.deepEqual(decideInvoke('session', 'list', { _request: {} }, no), { allow: true, filter: 'session-list' })
  assert.deepEqual(decideInvoke('session', 'list', { _request: { cursor: 'c1' } }, yes), {
    allow: true,
    filter: 'session-list',
  })
  assert.deepEqual(decideInvoke('session', 'list', {}, no), { allow: true, filter: 'session-list' })
  // Ordinary registered methods carry NO filter marker (strict deep-equal on
  // purpose: an undefined-valued key would be a different decision object).
  assert.deepEqual(decideInvoke('session', 'rename', { request: { sessionId: 'S-a', title: 'x' } }, yes), {
    allow: true,
  })
})

// -- decideStream: the stream route reads the same table -----------------------------

test('decideStream: the global streams allow unconditionally and carry their filter', () => {
  assert.deepEqual(decideStream('workspace', 'follow', {}, no), { allow: true, filter: 'workspace', sessionIds: [] })
  assert.deepEqual(decideStream('session', 'control', {}, no), { allow: true, filter: 'control', sessionIds: [] })
  // Garbage args ride through too — DSH's own argument validation answers
  // them as a business error on the stream, which the relay forwards.
  assert.deepEqual(decideStream('workspace', 'follow', { junk: 1 }, no), {
    allow: true,
    filter: 'workspace',
    sessionIds: [],
  })
})

test('decideStream: scoped streams follow the decideInvoke field rules verbatim', () => {
  const shared = ['S-a']
  assert.deepEqual(
    decideStream('session', 'follow', { request: { address: { kind: 'session', sessionId: 'S-a' } } }, only(shared)),
    { allow: true, sessionIds: ['S-a'] },
  )
  assert.deepEqual(
    decideStream('job', 'list', { request: { sessionId: 'S-a' } }, only(shared)),
    { allow: true, sessionIds: ['S-a'] },
  )
  assert.deepEqual(
    decideStream('job', 'follow', { request: { sessionId: 'S-a', jobId: 'j1' } }, only(shared)),
    { allow: true, sessionIds: ['S-a'] },
  )
  assert.deepEqual(
    decideStream('session', 'follow', { request: { address: { kind: 'session', sessionId: 'S-victim' } } }, only(shared)),
    { allow: false, reason: 'not-shared' },
  )
  assert.deepEqual(decideStream('session', 'follow', { request: {} }, yes), { allow: false, reason: 'no-session' })
})

test('decideStream: non-stream and unregistered methods are forbidden-method', () => {
  for (const [namespace, method, args] of [
    // session/list is invoke-only: a stream subscription of a snapshot call
    // is not a thing.
    ['session', 'list', { _request: {} }],
    ['session', 'page', { request: { address: { kind: 'session', sessionId: 'S-a' } } }],
    ['job', 'kill', { request: { sessionId: 'S-a', jobId: 'j1' } }],
    ['session', 'projections', { request: { sessionId: 'S-a' } }],
    // The T31 entries are all invoke-delivered (their results travel as one
    // envelope; none of them streams).
    ['session', 'create', { request: { workspaceId: 'w' } }],
    ['session', 'fork', { request: { sessionId: 'S-a' } }],
    ['subagents', 'prompt', { request: { parentSessionId: 'S-a', childSessionId: 'C' } }],
    ['subagents', 'interruptByParent', { parentSessionId: 'S-a', childSessionId: 'C', mode: 'continuable' }],
    ['fileUploads', 'upload', { agentId: 'S-a', request: { data: 'x' } }],
    ['fileReferences', 'list', { agentId: 'S-a', query: 'q' }],
    ['settings', 'update', {}],
    ['anything', 'atAll', 'garbage'],
  ]) {
    assert.deepEqual(
      decideStream(namespace, method, args, yes),
      { allow: false, reason: 'forbidden-method' },
      `${namespace}/${method} is not stream-delivered`,
    )
  }
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

// -- T31: session/create, session/fork ------------------------------------------------

test('decideInvoke: session/create is gated on a PRESENT workspaceId, never share-checked', () => {
  // The workspace id is not a share-table id: presence is the table's whole
  // demand — the route validates existence and auto-shares the result.
  assert.deepEqual(decideInvoke('session', 'create', { request: { workspaceId: 'W-not-shared' } }, no), { allow: true })
  assert.deepEqual(
    decideInvoke('session', 'create', { request: { workspaceId: 'W', cwd: '/x', sessionId: 'S' } }, no),
    { allow: true },
    'cwd/sessionId ride along; the route deletes them',
  )
  for (const args of [{ request: {} }, { request: { workspaceId: '' } }, { request: { workspaceId: 7 } }, {}]) {
    assert.deepEqual(
      decideInvoke('session', 'create', args, yes),
      { allow: false, reason: 'no-session' },
      JSON.stringify(args) + ' names no workspace',
    )
  }
})

test('decideInvoke: session/fork judges by the SOURCE session id', () => {
  const args = { request: { sessionId: 'S-src', atSeq: 4 } }
  assert.deepEqual(decideInvoke('session', 'fork', args, only(['S-src'])), { allow: true })
  assert.deepEqual(decideInvoke('session', 'fork', args, only([])), { allow: false, reason: 'not-shared' })
  assert.deepEqual(decideInvoke('session', 'fork', { request: { atSeq: 1 } }, yes), { allow: false, reason: 'no-session' })
})

// -- T31/T41a: subagents — BOTH ids are checked ----------------------------------------

test('decideInvoke: subagents/prompt checks parent AND child (child via ancestor inheritance)', () => {
  const args = { request: { requestId: 'r', parentSessionId: 'S-parent', childSessionId: 'S-child', mode: 'continuable', delivery: 'queue', content: [] } }
  // The stub stands for store.isAccessible AFTER the parentOf walk: a real
  // child is not in the table but borrows its parent's share, so with only
  // 'S-parent' shared BOTH ids come back accessible. The inheritance itself
  // is store behavior (relay-server's parentOf wiring test); what is pinned
  // here is that BOTH registered fields are read and BOTH checked.
  const family = (shared, child) => (id) => shared.includes(id) || id === child
  assert.deepEqual(decideInvoke('subagents', 'prompt', args, family(['S-parent'], 'S-child')), { allow: true })
  assert.deepEqual(decideInvoke('subagents', 'prompt', args, only([])), { allow: false, reason: 'not-shared' })
  // The task's decoy: a shared parent with a child that belongs to nobody
  // (its own ancestor walk finds nothing shared) refuses.
  assert.deepEqual(
    decideInvoke('subagents', 'prompt', { request: { requestId: 'r', parentSessionId: 'S-parent', childSessionId: 'S-foreign', mode: 'continuable', delivery: 'queue', content: [] } }, family(['S-parent'], 'S-child')),
    { allow: false, reason: 'not-shared' },
    'a shared parent cannot smuggle a foreign child through',
  )
  // ...and the mirror image: a shared CHILD cannot smuggle an unshared parent.
  assert.deepEqual(
    decideInvoke('subagents', 'prompt', { request: { parentSessionId: 'VICTIM', childSessionId: 'S-shared' } }, only(['S-shared'])),
    { allow: false, reason: 'not-shared' },
  )
  assert.deepEqual(decideInvoke('subagents', 'prompt', { request: { childSessionId: 'C' } }, yes), { allow: false, reason: 'no-session' })
})

test('decideInvoke: subagents/interruptByParent reads BOTH top-level ids', () => {
  // Top-level arguments — no request envelope at all. Same family stub as
  // above: the child borrows the parent's share through the ancestor walk.
  const family = (shared, child) => (id) => shared.includes(id) || id === child
  const args = { childSessionId: 'S-child', parentSessionId: 'S-parent', mode: 'continuable' }
  assert.deepEqual(decideInvoke('subagents', 'interruptByParent', args, family(['S-parent'], 'S-child')), { allow: true })
  assert.deepEqual(decideInvoke('subagents', 'interruptByParent', args, only([])), { allow: false, reason: 'not-shared' })
  assert.deepEqual(
    decideInvoke('subagents', 'interruptByParent', { childSessionId: 'S-foreign', parentSessionId: 'S-parent', mode: 'continuable' }, family(['S-parent'], 'S-child')),
    { allow: false, reason: 'not-shared' },
    'a foreign child refuses',
  )
  assert.deepEqual(
    decideInvoke('subagents', 'interruptByParent', { childSessionId: 'C', mode: 'continuable' }, yes),
    { allow: false, reason: 'no-session' },
  )
})

// -- T31: agentId-located calls — attachments and @ references -------------------------

test('decideInvoke: fileUploads/upload and fileReferences/list are gated on the top-level agentId', () => {
  const upload = { agentId: 'S-a', request: { data: 'Zm9v', name: 'x.png' } }
  const refs = { agentId: 'S-a', query: 'src' }
  assert.deepEqual(decideInvoke('fileUploads', 'upload', upload, only(['S-a'])), { allow: true })
  assert.deepEqual(decideInvoke('fileReferences', 'list', refs, only(['S-a'])), { allow: true })
  assert.deepEqual(decideInvoke('fileUploads', 'upload', upload, only([])), { allow: false, reason: 'not-shared' })
  assert.deepEqual(decideInvoke('fileReferences', 'list', refs, only([])), { allow: false, reason: 'not-shared' })
  // The reviewer's decoy, replayed on the registered method: a SHARED id
  // padded into request.sessionId buys nothing while the registered field
  // points at an unshared session.
  const decoy = { agentId: 'VICTIM', request: { data: 'Zm9v', sessionId: 'S-shared' } }
  assert.deepEqual(decideInvoke('fileUploads', 'upload', decoy, only(['S-shared'])), { allow: false, reason: 'not-shared' })
  assert.deepEqual(decideInvoke('fileReferences', 'list', { agentId: 'VICTIM', query: 'q', request: { sessionId: 'S-shared' } }, only(['S-shared'])), {
    allow: false,
    reason: 'not-shared',
  })
  for (const args of [{ request: { data: 'x' } }, { agentId: '' }, { agentId: 9 }]) {
    assert.deepEqual(
      decideInvoke('fileUploads', 'upload', args, yes),
      { allow: false, reason: 'no-session' },
      JSON.stringify(args) + ' claims no agent',
    )
  }
})

// -- T32: the forwarded-event entries ------------------------------------------------

test('decideStream: $zr/events is the special events entry — no fields, no session check', () => {
  assert.deepEqual(decideStream('$zr', 'events', {}, no), { allow: true, sessionIds: [], events: true })
  // It never rides the invoke route, and the event-result endpoint is not a
  // namespace/method at all — both refuse like anything unlisted.
  assert.deepEqual(decideInvoke('$zr', 'events', {}, yes), { allow: false, reason: 'forbidden-method' })
  assert.deepEqual(decideStream('events', 'result', {}, yes), { allow: false, reason: 'forbidden-method' })
})

test('parseEventResultBody: eventId + object result, everything else undefined', () => {
  const { parseEventResultBody } = require('../lib/relay-access.js')
  assert.deepEqual(parseEventResultBody({ eventId: 'evt-1', result: { kind: 'next' } }), { eventId: 'evt-1', result: { kind: 'next' } })
  assert.deepEqual(parseEventResultBody({ eventId: 'evt-1', result: { kind: 'result', value: { approve: true } } }), {
    eventId: 'evt-1',
    result: { kind: 'result', value: { approve: true } },
  })
  // The outcome travels verbatim: its RT validation (kinds next/result/
  // rejected, exact keys) is the GATEWAY's job, and a malformed one comes
  // back as the gateway's 200 error envelope.
  assert.deepEqual(parseEventResultBody({ eventId: 'evt-1', result: { kind: 'nonsense' } }), {
    eventId: 'evt-1',
    result: { kind: 'nonsense' },
  })
  for (const body of [
    undefined,
    null,
    'x',
    [],
    {},
    { eventId: '' , result: { kind: 'next' } },
    { eventId: 3, result: { kind: 'next' } },
    { eventId: 'evt-1' },
    { eventId: 'evt-1', result: 'next' },
    { eventId: 'evt-1', result: null },
  ]) {
    assert.equal(parseEventResultBody(body), undefined, JSON.stringify(body))
  }
})

// -- T41a: the agentId group grows (goals bar, commands, preset switches, @ candidates) --

test('decideInvoke: the T41a agentId group authorizes strictly on the top-level agentId', () => {
  const shared = ['S-a']
  const cases = [
    ['goals', 'get', { agentId: 'S-a' }],
    ['goals', 'edit', { agentId: 'S-a', ref: { id: 'g1', revision: 2 }, request: { objective: 'x' } }],
    ['goals', 'pause', { agentId: 'S-a', ref: { id: 'g1', revision: 2 } }],
    ['goals', 'resume', { agentId: 'S-a', ref: { id: 'g1', revision: 2 } }],
    ['goals', 'clear', { agentId: 'S-a', ref: { id: 'g1', revision: 3 } }],
    ['commands', 'list', { agentId: 'S-a' }],
    ['commands', 'execute', { agentId: 'S-a', line: '/model deepseek-chat', submittedAttachments: [] }],
    ['agentPresets', 'select', { agentId: 'S-a', agentPreset: 'default' }],
    ['sessionReferenceResolver', 'candidates', { agentId: 'S-a', query: '调试' }],
  ]
  for (const [namespace, method, args] of cases) {
    // candidates carries a resultFilter marker: its answer is narrowed to
    // accessible rows before it travels (relay-server.ts).
    const allowed =
      namespace === 'sessionReferenceResolver'
        ? { allow: true, filter: 'session-reference-candidates' }
        : { allow: true }
    assert.deepEqual(decideInvoke(namespace, method, args, only(shared)), allowed, `${namespace}/${method} with a shared id`)
    assert.deepEqual(
      decideInvoke(namespace, method, args, only([])),
      { allow: false, reason: 'not-shared' },
      `${namespace}/${method} with an unshared id`,
    )
  }
  // The task's decoy: `commands/execute` names an UNSHARED agentId while a
  // shared id rides in a field the method does not own — refusal, not a pass.
  const decoy = { agentId: 'VICTIM', line: '/permission acceptEdits', request: { sessionId: 'S-shared' } }
  assert.deepEqual(decideInvoke('commands', 'execute', decoy, only(['S-shared'])), { allow: false, reason: 'not-shared' })
  assert.deepEqual(decideInvoke('goals', 'get', { agentId: 'VICTIM', request: { sessionId: 'S-shared' } }, only(['S-shared'])), {
    allow: false,
    reason: 'not-shared',
  })
  // Missing, empty or non-string agentId claims no session.
  for (const args of [{ agentId: '' }, { agentId: 42 }, {}, 'garbage', undefined]) {
    assert.deepEqual(
      decideInvoke('commands', 'list', args, yes),
      { allow: false, reason: 'no-session' },
      JSON.stringify(args) + ' claims no agent',
    )
  }
})

// -- T41a: sessionFeedback/record — a plain request.sessionId method --------------------

test('decideInvoke: sessionFeedback/record is a plain request.sessionId method', () => {
  const args = { request: { sessionId: 'S-a', category: 'task-result', text: '慢' } }
  assert.deepEqual(decideInvoke('sessionFeedback', 'record', args, only(['S-a'])), { allow: true })
  assert.deepEqual(decideInvoke('sessionFeedback', 'record', args, only([])), { allow: false, reason: 'not-shared' })
  // The same decoy discipline: a shared id next to the real field buys nothing.
  assert.deepEqual(
    decideInvoke('sessionFeedback', 'record', { request: { sessionId: 'VICTIM' }, extra: { sessionId: 'S-shared' } }, only(['S-shared'])),
    { allow: false, reason: 'not-shared' },
  )
  assert.deepEqual(decideInvoke('sessionFeedback', 'record', { request: {} }, yes), { allow: false, reason: 'no-session' })
})

// -- T41a: workspaceFiles — the top-level workspaceFileScopeId IS the session id ----------

test('decideInvoke: workspaceFiles reads read share-check the top-level workspaceFileScopeId', () => {
  const shared = ['S-a']
  const cases = [
    ['workspaceFiles', 'list', { workspaceFileScopeId: 'S-a', path: 'src' }],
    ['workspaceFiles', 'read', { workspaceFileScopeId: 'S-a', path: 'src/index.ts', range: { offset: 0 } }],
    ['workspaceFiles', 'readBytes', { workspaceFileScopeId: 'S-a', path: 'logo.png', options: {} }],
    ['workspaceFiles', 'stat', { workspaceFileScopeId: 'S-a', path: '.' }],
  ]
  for (const [namespace, method, args] of cases) {
    assert.deepEqual(decideInvoke(namespace, method, args, only(shared)), { allow: true }, `${namespace}/${method} with a shared scope`)
    assert.deepEqual(
      decideInvoke(namespace, method, args, only([])),
      { allow: false, reason: 'not-shared' },
      `${namespace}/${method} with an unshared scope`,
    )
  }
  // The scope field is the ONLY thing checked: a shared id padded into
  // request.sessionId must not unlock an unshared scope.
  assert.deepEqual(
    decideInvoke('workspaceFiles', 'read', { workspaceFileScopeId: 'VICTIM', path: 'x', request: { sessionId: 'S-shared' } }, only(['S-shared'])),
    { allow: false, reason: 'not-shared' },
  )
  for (const args of [{ workspaceFileScopeId: '' }, { workspaceFileScopeId: 7 }, { path: 'x' }, {}]) {
    assert.deepEqual(
      decideInvoke('workspaceFiles', 'stat', args, yes),
      { allow: false, reason: 'no-session' },
      JSON.stringify(args) + ' claims no scope',
    )
  }
})

// -- T41a: terminal — server-side PTYs, the standing boundary, both field halves ----------

test('decideInvoke: the terminal agentId half authorizes on the top-level agentId', () => {
  const shared = ['S-a']
  const cases = [
    ['terminal', 'environment', { agentId: 'S-a' }],
    ['terminal', 'shells', { agentId: 'S-a' }],
    ['terminal', 'create', { agentId: 'S-a', request: { id: 'term-1', cols: 80, rows: 24 } }],
    ['terminal', 'write', { agentId: 'S-a', id: 'term-1', attachmentId: 'att-1', data: 'ls\n' }],
    ['terminal', 'resize', { agentId: 'S-a', id: 'term-1', attachmentId: 'att-1', cols: 100, rows: 30 }],
    ['terminal', 'rename', { agentId: 'S-a', id: 'term-1', title: '构建' }],
    ['terminal', 'close', { agentId: 'S-a', id: 'term-1' }],
  ]
  for (const [namespace, method, args] of cases) {
    assert.deepEqual(decideInvoke(namespace, method, args, only(shared)), { allow: true }, `${namespace}/${method} with a shared id`)
    assert.deepEqual(
      decideInvoke(namespace, method, args, only([])),
      { allow: false, reason: 'not-shared' },
      `${namespace}/${method} with an unshared id`,
    )
  }
  // The client-generated terminal/attachment ids are dead weight: a shared id
  // shaped as either of them must not unlock an unshared agentId.
  const decoy = { agentId: 'VICTIM', id: 'S-shared', attachmentId: 'S-shared' }
  assert.deepEqual(decideInvoke('terminal', 'write', decoy, only(['S-shared'])), { allow: false, reason: 'not-shared' })
  assert.deepEqual(decideInvoke('terminal', 'create', { agentId: '' }, yes), { allow: false, reason: 'no-session' })
})

test('decideInvoke: terminal/list reads the TOP-LEVEL sessionId (retain is stream-only)', () => {
  const list = { sessionId: 'S-a' }
  assert.deepEqual(decideInvoke('terminal', 'list', list, only(['S-a'])), { allow: true }, 'terminal/list with a shared id')
  assert.deepEqual(decideInvoke('terminal', 'list', list, only([])), { allow: false, reason: 'not-shared' }, 'terminal/list with an unshared id')
  // A shared terminal id cannot stand in for the session: only the registered
  // top-level sessionId is read.
  assert.deepEqual(decideInvoke('terminal', 'list', { sessionId: 'VICTIM', id: 'S-shared' }, only(['S-shared'])), {
    allow: false,
    reason: 'not-shared',
  })
  assert.deepEqual(decideInvoke('terminal', 'list', {}, yes), { allow: false, reason: 'no-session' })
})

// -- T41a: the three new streams ride the stream route with their claimed ids --------------

test('decideStream: the T41a scoped streams claim their ids and refuse the invoke route', () => {
  const shared = ['S-a']
  // Allowed on the stream route; the claimed ids ride back so the relay kills
  // the subscription (with the unshared end frame) when one stops being shared.
  assert.deepEqual(
    decideStream('workspaceFiles', 'changes', { workspaceFileScopeId: 'S-a', path: '.' }, only(shared)),
    { allow: true, sessionIds: ['S-a'] },
  )
  assert.deepEqual(
    decideStream('terminal', 'follow', { agentId: 'S-a', id: 'term-1', attachmentId: 'att-1' }, only(shared)),
    { allow: true, sessionIds: ['S-a'] },
  )
  assert.deepEqual(decideStream('terminal', 'retain', { sessionId: 'S-a', id: 'term-1' }, only(shared)), {
    allow: true,
    sessionIds: ['S-a'],
  })
  assert.deepEqual(
    decideStream('workspaceFiles', 'changes', { workspaceFileScopeId: 'VICTIM', path: '.' }, only(shared)),
    { allow: false, reason: 'not-shared' },
  )
  assert.deepEqual(decideStream('terminal', 'follow', { agentId: 'VICTIM', id: 't', attachmentId: 'a' }, only(shared)), {
    allow: false,
    reason: 'not-shared',
  })
  assert.deepEqual(decideStream('terminal', 'retain', { sessionId: '' }, yes), { allow: false, reason: 'no-session' })
  // ...and the invoke route refuses every one of them, like every stream method.
  for (const [namespace, method, args] of [
    ['workspaceFiles', 'changes', { workspaceFileScopeId: 'S-a', path: '.' }],
    ['terminal', 'follow', { agentId: 'S-a', id: 't', attachmentId: 'a' }],
    ['terminal', 'retain', { sessionId: 'S-a', id: 't' }],
  ]) {
    assert.deepEqual(
      decideInvoke(namespace, method, args, yes),
      { allow: false, reason: 'forbidden-method' },
      `${namespace}/${method} is stream-only`,
    )
  }
})

// -- T41b: the plain-HTTP route registry (relay/v1/http) --------------------------

test('decideHttpRoute: only the two registered routes allow, everything else is unknown-route', () => {
  assert.deepEqual(decideHttpRoute('changes.summary', 'sessionId=S1&seq=1', yes), { allow: true, query: 'sessionId=S1&seq=1' })
  assert.deepEqual(decideHttpRoute('changes.diff', 'sessionId=S1&seq=1&index=0', yes), { allow: true, query: 'sessionId=S1&seq=1&index=0' })
  assert.deepEqual(decideHttpRoute('session.export', 'sessionId=S1', yes), { allow: false, reason: 'unknown-route' })
  assert.deepEqual(decideHttpRoute('changes.open', 'sessionId=S1&seq=1&index=0', yes), { allow: false, reason: 'unknown-route' })
  assert.deepEqual(decideHttpRoute('present.host', '', yes), { allow: false, reason: 'unknown-route' })
  // A prototype key name from the wire must not resolve through the object
  // prototype the way a bare table index would.
  assert.deepEqual(decideHttpRoute('constructor', 'sessionId=S1', yes), { allow: false, reason: 'unknown-route' })
  assert.deepEqual(decideHttpRoute('__proto__', 'sessionId=S1', yes), { allow: false, reason: 'unknown-route' })
  assert.deepEqual(decideHttpRoute(undefined, 'sessionId=S1', yes), { allow: false, reason: 'unknown-route' })
})

test('decideHttpRoute: the session field must be present, single, and shared', () => {
  assert.deepEqual(decideHttpRoute('changes.summary', 'seq=1', yes), { allow: false, reason: 'no-session' })
  assert.deepEqual(decideHttpRoute('changes.summary', 'sessionId=&seq=1', yes), { allow: false, reason: 'no-session' })
  // Duplicates are the same "which session did you mean" garbage as a miss.
  assert.deepEqual(decideHttpRoute('changes.summary', 'sessionId=S1&sessionId=S2', yes), { allow: false, reason: 'no-session' })
  assert.deepEqual(decideHttpRoute('changes.summary', undefined, yes), { allow: false, reason: 'no-session' })
  // The share-table discipline, verbatim from decideInvoke: an unshared id
  // refuses even when everything else is well-formed.
  assert.deepEqual(decideHttpRoute('changes.diff', 'sessionId=S-secret&seq=1&index=0', no), { allow: false, reason: 'not-shared' })
  assert.deepEqual(decideHttpRoute('changes.diff', 'sessionId=S-shared&seq=1&index=0', only(['S-shared'])), { allow: true, query: 'sessionId=S-shared&seq=1&index=0' })
})

// -- T41b-fix: parser differential regression (tab/CR/LF in key names) -------------

test('decideHttpRoute: control characters in key names cannot split a parameter past the check', () => {
  // The reviewed bypass: URLSearchParams kept the tab inside `session\tId`,
  // the WHATWG URL parser strips it when the synthetic Request URL is built,
  // and the serving route's get('sessionId') then read the FIRST parameter —
  // the secret. The decision now rebuilds the query, so what was checked is
  // what dispatches: only the APPROVED id travels.
  for (const query of [
    'session\tId=S-secret&sessionId=S-shared&seq=1&index=0',
    'session\rId=S-secret&sessionId=S-shared&seq=1&index=0',
    'session\nId=S-secret&sessionId=S-shared&seq=1&index=0',
    'session\t\r\nId=S-secret&sessionId=S-shared&seq=1&index=0',
  ]) {
    const decision = decideHttpRoute('changes.diff', query, only(['S-shared']))
    assert.deepEqual(decision, { allow: true, query: 'sessionId=S-shared&seq=1&index=0' }, query)
    assert.equal(new URLSearchParams(decision.allow ? decision.query : '').getAll('sessionId').join(), 'S-shared')
    assert.ok(!decision.allow || !decision.query.includes('S-secret'), query)
  }
})

test('decideHttpRoute: whitelisted parameters only, fixed order, garbage coordinates refuse', () => {
  // Unknown parameters are dropped; a stray leading ? is not a key.
  assert.deepEqual(decideHttpRoute('changes.summary', '?sessionId=S1&foo=bar&seq=5', yes), { allow: true, query: 'sessionId=S1&seq=5' })
  // Coordinates must be single decimal non-negative integers when present.
  assert.deepEqual(decideHttpRoute('changes.diff', 'sessionId=S1&seq=1%2F..%2F', yes), { allow: false, reason: 'bad-query' })
  assert.deepEqual(decideHttpRoute('changes.diff', 'sessionId=S1&seq=1#/../../session.export', yes), { allow: false, reason: 'bad-query' })
  assert.deepEqual(decideHttpRoute('changes.diff', 'sessionId=S1&seq=1&seq=2', yes), { allow: false, reason: 'bad-query' })
  assert.deepEqual(decideHttpRoute('changes.diff', 'sessionId=S1&index=-1', yes), { allow: false, reason: 'bad-query' })
  // Percent-encoded key names decode like any other query text: two reads
  // of the same key are duplicates, not a decoy and a pass.
  assert.deepEqual(decideHttpRoute('changes.diff', 'sessionId=S-shared&%73essionId=S-secret&seq=1', yes), { allow: false, reason: 'no-session' })
})
