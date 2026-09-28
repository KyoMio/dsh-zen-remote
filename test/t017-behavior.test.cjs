/* dsh-zen-remote · T-017 new-behavior tests
 * Real coverage for the three 0.1.7 adaptations whose previous guards were
 * source-regex only (review finding #3): the main-view session derivation,
 * the turn-fold suppression state machine, and the desktop-shell gate. Each
 * imports the actual .ts module — Node ≥23.6 strips the type-only imports,
 * and none of these modules touches the DOM at import time.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')

test('mainSessionIdOf: no row retained by the main view → undefined', async () => {
  const { mainSessionIdOf } = await import('../src/client/compat/types.ts')
  assert.equal(mainSessionIdOf({}), undefined)
  assert.equal(mainSessionIdOf({
    a: { id: 'a', retainedBy: {} },
    b: { id: 'b', retainedBy: { mainView: 0 } },
  }), undefined, 'a zero count is not a retention')
})

test('mainSessionIdOf: the one retained row wins', async () => {
  const { mainSessionIdOf } = await import('../src/client/compat/types.ts')
  assert.equal(mainSessionIdOf({
    a: { id: 'session-a', retainedBy: {} },
    b: { id: 'session-b', retainedBy: { mainView: 1 } },
  }), 'session-b')
  assert.equal(mainSessionIdOf({ b: { id: 'session-b', retainedBy: { mainView: 2 } } }), 'session-b')
})

test('mainSessionIdOf: a switch instant with two retained rows is deterministic', async () => {
  const { mainSessionIdOf } = await import('../src/client/compat/types.ts')
  // The swap window: the old and the new row both report mainView > 0. The
  // pick must not throw, and must settle on ONE row — the first in the
  // table's own order (the same rule official publishMain applies over
  // Object.values) — so repeated reads of the same snapshot agree.
  const byId = {
    first: { id: 'session-first', retainedBy: { mainView: 1 } },
    second: { id: 'session-second', retainedBy: { mainView: 1 } },
  }
  const picks = new Set([mainSessionIdOf(byId), mainSessionIdOf(byId), mainSessionIdOf(byId)])
  assert.equal(picks.size, 1, 'same snapshot, same answer')
  assert.equal(picks.has('session-first'), true, 'table order decides')
})

test('foldSuppressionTransition: enter / exit / hold', async () => {
  const { foldSuppressionTransition } = await import('../src/client/effects/turn-fold.ts')
  // No group yet, not suppressed → nothing to do.
  assert.equal(foldSuppressionTransition(false, false), 'hold')
  // A group appears → enter suppression (marks cleared, ACTIVE_ATTR dropped).
  assert.equal(foldSuppressionTransition(true, false), 'enter')
  // Still grouped, already suppressed → stay put.
  assert.equal(foldSuppressionTransition(true, true), 'hold')
  // The last group leaves → exit suppression (fold re-arms).
  assert.equal(foldSuppressionTransition(false, true), 'exit')
})

test('isDesktopShell: the dshDesktop bridge decides, both states', async () => {
  const { isDesktopShell } = await import('../src/client/compat/desktop.ts')
  // Electron preload exposes the bridge before any page script runs.
  assert.equal(isDesktopShell({ dshDesktop: { protocolVersion: 1 } }), true)
  // Plain web — phone browsers, the gateway, desktop browsers — never does.
  assert.equal(isDesktopShell({}), false)
  // The marker is key PRESENCE (the `in` check), not the value's truthiness
  // — a bridge object, even a bare `{}`, means the desktop shell.
  assert.equal(isDesktopShell({ dshDesktop: {} }), true)
})
