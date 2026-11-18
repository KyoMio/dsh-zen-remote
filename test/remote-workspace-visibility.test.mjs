import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  REMOTE_HIDDEN_WORKSPACE_ATTR,
  hasActiveRemoteSession,
  hiddenRemoteWorkspaceIds,
} from '../src/client-data/remote-workspace-visibility.ts'
import { installRemoteWorkspaceVisibility } from '../src/client/effects/remote-workspace-visibility.ts'
import { CLIENT_CONFIG_CHANGED_EVENT } from '../src/client/client-config.ts'
import { REMOTE_SESSION_CSS } from '../src/client/styles/remote-session.css.ts'
import { en, zh } from '../src/client/locales.ts'

test('hasActiveRemoteSession and hiddenRemoteWorkspaceIds distinguish active vs empty/archived remote workspaces', () => {
  const srv = 'a1b2c3d4'
  const workspaces = [
    { workspaceId: 'local-empty', sessionIds: [] },
    { workspaceId: `zr~${srv}~empty`, sessionIds: [] },
    { workspaceId: `zr~${srv}~archived-only`, sessionIds: [`zr~${srv}~s-arch`] },
    { workspaceId: `zr~${srv}~blank-only`, sessionIds: [`zr~${srv}~s-blank`, `zr~${srv}~s-sub`] },
    { workspaceId: `zr~${srv}~active`, sessionIds: [`zr~${srv}~s-arch`, `zr~${srv}~s-live`] },
    { workspaceId: `zr~${srv}~unloaded`, sessionIds: [`zr~${srv}~s-pending`] },
    { workspaceId: `zr~${srv}~current-blank`, sessionIds: [`zr~${srv}~s-open-blank`] },
  ]
  const state = {
    archivedIds: [`zr~${srv}~s-arch`],
    sessionsById: {
      [`zr~${srv}~s-arch`]: { blank: false },
      [`zr~${srv}~s-blank`]: { blank: true },
      [`zr~${srv}~s-sub`]: { blank: false, origin: 'subagent' },
      [`zr~${srv}~s-live`]: { blank: false },
      [`zr~${srv}~s-open-blank`]: { blank: true },
    },
    currentSessionId: `zr~${srv}~s-open-blank`,
  }

  const hidden = hiddenRemoteWorkspaceIds(workspaces, state)
  assert.equal(hidden.has('local-empty'), false, 'local workspaces are never hidden')
  assert.equal(hidden.has(`zr~${srv}~empty`), true, 'empty remote workspace is hidden')
  assert.equal(hidden.has(`zr~${srv}~archived-only`), true, 'archived/tombstone-only remote workspace is hidden')
  assert.equal(hidden.has(`zr~${srv}~blank-only`), true, 'unopen-blank + subagent-only remote workspace is hidden')
  assert.equal(hidden.has(`zr~${srv}~active`), false, 'remote workspace with an active shared session stays visible')
  assert.equal(hidden.has(`zr~${srv}~unloaded`), false, 'unloaded session summary stays conservatively visible')
  assert.equal(hidden.has(`zr~${srv}~current-blank`), false, 'workspace holding current open session stays visible')
  assert.equal(hasActiveRemoteSession({ workspaceId: `zr~${srv}~empty`, sessionIds: [] }, state), false)
})

function makeElement(tag, attrs = {}) {
  const map = new Map(Object.entries(attrs))
  return {
    tagName: tag,
    parentElement: null,
    children: [],
    getAttribute(name) {
      return map.has(name) ? map.get(name) : null
    },
    setAttribute(name, value) {
      map.set(name, String(value))
    },
    hasAttribute(name) {
      return map.has(name)
    },
    removeAttribute(name) {
      map.delete(name)
    },
    appendChild(child) {
      child.parentElement = this
      this.children.push(child)
      return child
    },
    closest(selector) {
      const wantGroupOrTree = selector.includes('[role="group"]') && selector.includes('[role="tree"]')
      let cur = this.parentElement
      while (cur) {
        const role = cur.getAttribute('role')
        if (wantGroupOrTree && (role === 'group' || role === 'tree')) return cur
        cur = cur.parentElement
      }
      return null
    },
    querySelectorAll(selector) {
      const out = []
      const walk = (node) => {
        for (const child of node.children) {
          if (matches(child, selector)) out.push(child)
          walk(child)
        }
      }
      walk(this)
      return out
    },
  }
}

function matches(el, selector) {
  if (selector === `[${REMOTE_HIDDEN_WORKSPACE_ATTR}]`) {
    return el.hasAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR)
  }
  if (selector === '[data-row-key^="session:"]') {
    return (el.getAttribute('data-row-key') ?? '').startsWith('session:')
  }
  if (selector === '[role="tree"] [role="treeitem"][data-row-key^="workspace:zr~"]') {
    return el.getAttribute('role') === 'treeitem'
      && (el.getAttribute('data-row-key') ?? '').startsWith('workspace:zr~')
      && el.closest('[role="group"], [role="tree"]') !== null
  }
  return false
}

test('installRemoteWorkspaceVisibility stamps inactive sidebar treeitems and updates live on store/config changes', async (t) => {
  const srv = 'deadbeef'
  const body = makeElement('body')
  const tree = body.appendChild(makeElement('div', { role: 'tree' }))
  const localSection = tree.appendChild(makeElement('div'))
  const localRow = localSection.appendChild(makeElement('div', { role: 'treeitem', 'data-row-key': 'workspace:local-1' }))

  const emptySection = tree.appendChild(makeElement('div'))
  const emptyRow = emptySection.appendChild(makeElement('div', { role: 'treeitem', 'data-row-key': `workspace:zr~${srv}~empty` }))

  const activeSection = tree.appendChild(makeElement('div'))
  const activeRow = activeSection.appendChild(makeElement('div', { role: 'treeitem', 'data-row-key': `workspace:zr~${srv}~active` }))

  // Parent workspace empty, but nested child workspace active under [role="group"]: only parent row hides.
  const nestedSection = tree.appendChild(makeElement('div'))
  const nestedParentRow = nestedSection.appendChild(makeElement('div', { role: 'treeitem', 'data-row-key': `workspace:zr~${srv}~parent-empty` }))
  const nestedGroup = nestedSection.appendChild(makeElement('div', { role: 'group' }))
  const nestedChildSection = nestedGroup.appendChild(makeElement('div'))
  const nestedChildRow = nestedChildSection.appendChild(makeElement('div', { role: 'treeitem', 'data-row-key': `workspace:zr~${srv}~child-active` }))

  // Workspace whose rendered section still has a direct archived session row (e.g. "Show archived" filter): stay visible.
  const archivedRenderedSection = tree.appendChild(makeElement('div'))
  const archivedRenderedRow = archivedRenderedSection.appendChild(makeElement('div', { role: 'treeitem', 'data-row-key': `workspace:zr~${srv}~arch-rendered` }))
  archivedRenderedSection.appendChild(makeElement('div', { role: 'treeitem', 'data-row-key': `session:zr~${srv}~sess-arch` }))

  // Picker menu (outside [role="tree"]) must never be matched or hidden.
  const pickerMenu = body.appendChild(makeElement('div', { role: 'menu' }))
  const pickerRow = pickerMenu.appendChild(makeElement('div', { role: 'menuitem', 'data-row-key': `workspace:zr~${srv}~empty` }))

  const originalDoc = globalThis.document
  const originalWin = globalThis.window
  const winListeners = new Map()
  globalThis.document = {
    body,
    querySelectorAll: (sel) => body.querySelectorAll(sel),
  }
  globalThis.window = {
    addEventListener: (ev, fn) => { winListeners.set(ev, fn) },
    removeEventListener: (ev) => { winListeners.delete(ev) },
  }
  t.after(() => {
    globalThis.document = originalDoc
    globalThis.window = originalWin
  })

  let wsSnap = {
    items: [
      { workspaceId: 'local-1', sessionIds: [] },
      { workspaceId: `zr~${srv}~empty`, sessionIds: [] },
      { workspaceId: `zr~${srv}~active`, sessionIds: [`zr~${srv}~sess-1`] },
      { workspaceId: `zr~${srv}~parent-empty`, sessionIds: [] },
      { workspaceId: `zr~${srv}~child-active`, sessionIds: [`zr~${srv}~sess-2`] },
      { workspaceId: `zr~${srv}~arch-rendered`, sessionIds: [`zr~${srv}~sess-arch`] },
    ],
    archivedSessionIds: [`zr~${srv}~sess-arch`],
  }
  const sessSnap = {
    byId: {
      [`zr~${srv}~sess-1`]: { blank: false },
      [`zr~${srv}~sess-2`]: { blank: false },
      [`zr~${srv}~sess-arch`]: { blank: false },
    },
  }
  const wsListeners = new Set()
  const services = {
    workspaces: {
      list: {
        getSnapshot: () => wsSnap,
        subscribe: (fn) => { wsListeners.add(fn); return () => { wsListeners.delete(fn) } },
      },
    },
    sessions: {
      list: {
        getSnapshot: () => sessSnap,
        subscribe: () => () => {},
      },
    },
  }
  const cleanups = []
  const ctx = {
    get: (name) => services[name],
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }

  let hideEnabled = true
  let role = 'peer'
  installRemoteWorkspaceVisibility(ctx, {
    probeRole: async () => role,
    readConfig: async () => ({ hideInactiveRemoteWorkspaces: hideEnabled }),
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(localRow.getAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR), null)
  assert.equal(emptyRow.getAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR), '1')
  assert.equal(activeRow.getAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR), null)
  assert.equal(nestedParentRow.getAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR), '1')
  assert.equal(nestedChildRow.getAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR), null)
  assert.equal(archivedRenderedRow.getAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR), null)
  assert.equal(pickerRow.getAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR), null)

  // Starting a session inside the previously empty workspace reveals it immediately.
  wsSnap = {
    ...wsSnap,
    items: wsSnap.items.map((w) => (w.workspaceId === `zr~${srv}~empty` ? { ...w, sessionIds: [`zr~${srv}~sess-new`] } : w)),
  }
  for (const fn of wsListeners) fn()
  assert.equal(emptyRow.getAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR), null)

  // Toggling setting off clears all stamps immediately without reload.
  hideEnabled = false
  winListeners.get(CLIENT_CONFIG_CHANGED_EVENT)?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(nestedParentRow.getAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR), null)

  // Host role stays no-op even if hideEnabled is true.
  hideEnabled = true
  role = 'host'
  winListeners.get(CLIENT_CONFIG_CHANGED_EVENT)?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(nestedParentRow.getAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR), null)

  for (const fn of cleanups) fn()
})

test('REMOTE_SESSION_CSS hides stamped sidebar workspace rows and locales define settings copy', () => {
  assert.match(
    REMOTE_SESSION_CSS,
    /\[role="tree"\] \[role="treeitem"\]\[data-row-key\^="workspace:zr~"\]\[data-zr-hidden-ws="1"\]\s*\{\s*display:\s*none\s*!important;/,
  )
  for (const dict of [zh, en]) {
    assert.ok(typeof dict['settings.fieldHideInactiveRemoteWorkspaces'] === 'string')
    assert.ok(typeof dict['settings.fieldHideInactiveRemoteWorkspacesHint'] === 'string')
  }
})

test('T9: MutationObserver coalesces burst DOM mutations into a single syncDom per animation frame', async (t) => {
  const origDoc = globalThis.document
  const origWin = globalThis.window
  const origMo = globalThis.MutationObserver
  const origRaf = globalThis.requestAnimationFrame
  const origCaf = globalThis.cancelAnimationFrame

  let queryCount = 0
  let moCallback = null
  const rafQueue = []
  let rafId = 0

  globalThis.document = {
    body: {},
    querySelectorAll: () => { queryCount += 1; return [] },
  }
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.MutationObserver = class {
    constructor(cb) { moCallback = cb }
    observe() {}
    disconnect() { moCallback = null }
  }
  globalThis.requestAnimationFrame = (cb) => {
    const id = ++rafId
    rafQueue.push({ id, cb })
    return id
  }
  globalThis.cancelAnimationFrame = (id) => {
    const idx = rafQueue.findIndex((item) => item.id === id)
    if (idx >= 0) rafQueue.splice(idx, 1)
  }

  t.after(() => {
    globalThis.document = origDoc
    globalThis.window = origWin
    globalThis.MutationObserver = origMo
    globalThis.requestAnimationFrame = origRaf
    globalThis.cancelAnimationFrame = origCaf
  })

  const cleanups = []
  const ctx = {
    get: (name) => {
      if (name === 'workspaces') return { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }), subscribe: () => () => {} } }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } }
      return undefined
    },
    effect: (fn) => {
      const stop = fn()
      if (typeof stop === 'function') cleanups.push(stop)
    },
  }

  installRemoteWorkspaceVisibility(ctx, {
    probeRole: async () => 'peer',
    readConfig: async () => ({ hideInactiveRemoteWorkspaces: true }),
  })
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(moCallback, 'MutationObserver attached')

  queryCount = 0
  for (let i = 0; i < 10; i++) moCallback()
  assert.equal(queryCount, 0, 'burst mutations must defer DOM scan to rAF instead of running synchronously')
  assert.equal(rafQueue.length, 1, '10 burst mutations coalesce into 1 scheduled rAF')
  rafQueue.shift().cb(0)
  assert.equal(queryCount, 1, 'exactly 1 syncDom scan executes when rAF fires')

  // Cleanup cancels pending rAF
  moCallback()
  assert.equal(rafQueue.length, 1)
  for (const stop of cleanups) stop()
  assert.equal(rafQueue.length, 0, 'disposal must cancel pending rAF')
})
