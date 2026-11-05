// dsh-zen-remote · T70 the portaled permission menu becomes the bottom sheet
//
// DSH 0.2.0 portals the permission menu to body (`portal: true` on the Menu
// primitive), so composer.css section 4's descendant selectors stopped
// matching and the phone got a floating popup instead of the bottom sheet.
// The host offers NO stable attribute on the portal (no id, a per-instance
// useId anchor, no aria-controls — checked the primitives source), and its
// only OTHER portal Menu (the copy button's confirm) must NOT become a
// sheet — hence effects/permission-sheet.ts: the trigger's click arms a
// window, the next body-level menu is marked `data-zen-sheet="perm"`, and
// the stylesheet keys the sheet off that marker.
//
// Layers tested here (MobileSessionInfo-style textual pinning for the CSS;
// the effect's two decisions are PURE over structural candidates and are
// driven behaviorally):
// - the stylesheet: the portal selector sits in the bottom-sheet rule, the
//   44pt row rule and the jump-to-latest :has() gate, all inside the phone
//   media block; the 0.1.7 descendant selectors survive untouched;
// - the marking decisions: an unmarked body-level menu is marked, a marked
//   one is not re-marked, a non-menu never is; only a phone-shell click
//   inside the permission trigger arms, any other button never does;
// - the install: the observer watches body childList, the callback exits
//   early when nothing is armed, and teardown scrubs nothing mid-flight.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const loadEffect = () => import('../src/client/effects/permission-sheet.ts?' + Math.random())

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ROOT = join(__dirname, '..')
const css = readFileSync(join(ROOT, 'src', 'client', 'styles', 'composer.css.ts'), 'utf8')
// The template literal is the shipped stylesheet; slice past the module
// constants so assertions cannot match the selector constants' prose.
const sheet = css.slice(css.indexOf('export const COMPOSER_CSS'))

const PORTAL_RULE = 'body > div[role="menu"][data-zen-sheet="perm"]'
// UX-3: the hero workspace menu gets its own marker value so a pick inside
// it can start the switch lock without ever touching permission options.
const WS_RULE = 'body > div[role="menu"][data-zen-sheet="workspace"]'

// -- the stylesheet ------------------------------------------------------------

test('T70 css: the portaled permission menu joins the bottom-sheet rule, the row rule and the :has gate', () => {
  // All three section-4/4a rules name the portal forms; the workspace
  // selector sits right beside the model menu (a comment separates it from
  // the perm line).
  assert.ok(
    sheet.includes(`${WS_RULE},\n  ${'${MODEL_MENU}'} {\n    position: fixed !important;`),
    'the workspace sheet sits in the bottom-sheet rule beside the model menu',
  )
  assert.ok(
    sheet.includes(`${PORTAL_RULE},`) && sheet.indexOf(PORTAL_RULE) < sheet.indexOf(WS_RULE),
    'the permission portal stays in the same rule, ahead of the workspace one',
  )
  assert.ok(
    sheet.includes(`${PORTAL_RULE} [role="menuitem"],`),
    'the portal menu\'s rows get the 44pt+ treatment',
  )
  assert.ok(
    sheet.includes('body:has(> div[role="menu"][data-zen-sheet="perm"]) [data-chat-flow] + div'),
    'the jump-to-latest :has() gate also matches the marked portal menu',
  )
})

test('T70 css: the 0.1.7 inline structure keeps working — descendant selectors survive', () => {
  // The old spelling is the 0.1.7 path; deleting it would break every
  // deployment that has not moved to 0.2.0 yet.
  assert.ok(sheet.includes('${PERM} [role="menu"],'), 'the inline bottom-sheet selector survives')
  assert.ok(sheet.includes('${PERM} [role="menu"] [role="menuitem"],'), 'the inline row selector survives')
  assert.ok(sheet.includes('body:has(${PERM} [role="menu"])'), 'the inline :has() gate survives')
})

test('T70 css: the portal rules live inside the PHONE media block only', () => {
  // The phone block opens at @media (max-width: 767px) and closes before
  // the trailing module tail; every T70 rule must sit INSIDE it, so a
  // desktop shell (which does not even load this stylesheet) and any
  // ≥768px viewport match nothing.
  const blockStart = sheet.indexOf('@media (max-width: 767px)')
  assert.notEqual(blockStart, -1, 'the phone media block exists')
  const blockEnd = sheet.indexOf('\n}\n', blockStart)
  assert.notEqual(blockEnd, -1, 'the media block closes')
  for (const needle of [
    PORTAL_RULE,
    WS_RULE,
    'body:has(> div[role="menu"][data-zen-sheet="perm"])',
    'body:has(> div[role="menu"][data-zen-sheet="workspace"])',
    'html[data-zen-ws-switching] [data-slot="conversation.composer.bar"]',
  ]) {
    const at = sheet.indexOf(needle, blockStart)
    assert.ok(at !== -1 && at < blockEnd, `${needle} sits inside the phone media block`)
  }
})

test('UX-3 css: the workspace sheet gets the same row treatment as the permission sheet', () => {
  assert.ok(sheet.includes(`${WS_RULE} [role="menuitem"],`), 'the workspace sheet rows get the 44pt+ treatment')
  assert.ok(
    sheet.includes('body:has(> div[role="menu"][data-zen-sheet="workspace"]) [data-chat-flow] + div'),
    'the jump-to-latest :has() gate also matches the workspace sheet',
  )
})

test('UX-3 css: the switch lock dead-zones and dims the composer inside the phone block', () => {
  const at = sheet.indexOf('html[data-zen-ws-switching] [data-slot="conversation.composer.bar"] {')
  assert.notEqual(at, -1, 'the lock rule exists')
  const block = sheet.slice(at, at + 240)
  assert.ok(block.includes('pointer-events: none !important;'), 'the composer cannot be tapped while switching')
  assert.ok(block.includes('opacity: .6 !important;'), 'the lock reads as a visible dim, not a silent freeze')
})

// -- the marking decisions (pure, structural candidates) ------------------------

const candidate = (over = {}) => ({
  matches: () => true,
  getAttribute: () => null,
  closest: () => null,
  ...over,
})

test('T70 effect: an unmarked body-level portal menu is markable; a marked one is not re-marked', async () => {
  const { isUnmarkedPortalMenu } = await loadEffect()
  assert.equal(isUnmarkedPortalMenu(candidate()), true, 'a fresh portal menu takes the marker')
  assert.equal(
    isUnmarkedPortalMenu(candidate({ getAttribute: (name) => (name === 'data-zen-sheet' ? 'perm' : null) })),
    false,
    'an already-marked menu is never touched again',
  )
  assert.equal(
    isUnmarkedPortalMenu(candidate({ matches: () => false })),
    false,
    'not a body-level role=menu — never markable (the model menu has an id, other menus nest)',
  )
})

test('T70 effect: only a phone-shell click inside the permission trigger arms the window', async () => {
  const { sheetKindForTrigger } = await loadEffect()
  const trigger = candidate({ closest: (selectors) => (selectors.includes('permission') ? {} : null) })
  const other = candidate({ closest: () => null })

  assert.equal(sheetKindForTrigger(trigger, true), 'perm', 'the permission trigger click arms as perm')
  assert.equal(sheetKindForTrigger(other, true), null, 'any other button never arms — its menus stay unmarked')
  assert.equal(sheetKindForTrigger(null, true), null, 'a text-node/absent target never arms')
  assert.equal(sheetKindForTrigger(trigger, false), null, 'the desktop shell never arms — no sheet marking there')
})

test('UX-3 effect: the hero workspace triggers arm as workspace sheets', async () => {
  const { sheetKindForTrigger } = await loadEffect()
  const chip = candidate({ closest: (s) => (s.includes('aria-haspopup="menu"]') ? {} : null) })
  const card = candidate({ closest: (s) => (s.includes('cardWorkspaceTrigger') ? {} : null) })

  assert.equal(sheetKindForTrigger(chip, true), 'workspace', 'the hero WorkspaceChip arms the workspace sheet')
  assert.equal(sheetKindForTrigger(card, true), 'workspace', 'the placeholder card trigger arms the workspace sheet')
  assert.equal(sheetKindForTrigger(chip, false), null, 'desktop keeps the floating menu')
})

test('UX-3 effect: pointerdown lands on a workspace trigger only', async () => {
  const { pointerdownOnWorkspaceTrigger } = await loadEffect()
  const chip = candidate({ closest: (s) => (s.includes('aria-haspopup="menu"]') ? {} : null) })
  const card = candidate({ closest: (s) => (s.includes('cardWorkspaceTrigger') ? {} : null) })
  const perm = candidate({ closest: (s) => (s.includes('permission') ? {} : null) })
  const other = candidate({ closest: () => null })

  assert.equal(pointerdownOnWorkspaceTrigger(chip), true, 'the chip is a toggle-race trigger')
  assert.equal(pointerdownOnWorkspaceTrigger(card), true, 'the placeholder card is too')
  assert.equal(pointerdownOnWorkspaceTrigger(perm), false, 'the permission trigger toggles by click alone — never suppressed')
  assert.equal(pointerdownOnWorkspaceTrigger(other), false)
  assert.equal(pointerdownOnWorkspaceTrigger(null), false)
})

test('UX-3 effect: a menuitem click inside the marked WORKSPACE sheet starts the switch', async () => {
  const { menuitemClickStartsWorkspaceSwitch } = await loadEffect()
  const wsItem = candidate({ closest: (s) => (s.includes('menuitem') ? {} : null) })

  assert.equal(menuitemClickStartsWorkspaceSwitch(wsItem), true, 'a workspace pick starts the lock')
  assert.equal(menuitemClickStartsWorkspaceSwitch(candidate({ closest: () => null })), false, 'clicks outside the sheet never do')
  assert.equal(menuitemClickStartsWorkspaceSwitch(null), false)
  // The lock keys on the WORKSPACE marker, never on a bare menu item: pin
  // the discriminating selector text so a permission option can never lock
  // the composer.
  const source = readFileSync(join(ROOT, 'src', 'client', 'effects', 'permission-sheet.ts'), 'utf8')
  assert.ok(
    source.includes('data-zen-sheet="workspace"] button[role="menuitem"]'),
    'the lock selector names the marked workspace sheet',
  )
})

test('UX-3 effect: the switch releases when the session moved and the placeholder is gone', async () => {
  const { workspaceSwitchSettled } = await loadEffect()
  const probe = (session, placeholder) => ({
    currentSessionValue: () => session,
    placeholderOpen: () => placeholder,
  })

  assert.equal(workspaceSwitchSettled(probe('S2', false), 'S1'), true, 'the new session mounted and the picker card is gone')
  assert.equal(workspaceSwitchSettled(probe('S1', false), 'S1'), false, 'same session id — selectWorkspace no-oped, keep waiting')
  assert.equal(workspaceSwitchSettled(probe('S2', true), 'S1'), false, 'the placeholder card is still up — the workspace is not chosen yet')
})

test('UX-3 action: decideNewSessionAction starts pinned/auto-single/none and defers the multi pick', async () => {
  const { decideNewSessionAction } = await import('../src/client-data/new-session.ts?' + Math.random())

  assert.deepEqual(decideNewSessionAction('w1', ['w1', 'w2']), { kind: 'start', workspaceId: 'w1' }, 'a selected workspace starts directly')
  assert.deepEqual(decideNewSessionAction(undefined, []), { kind: 'start', workspaceId: undefined }, 'no workspaces at all — nothing to pick')
  assert.deepEqual(decideNewSessionAction(undefined, ['only']), { kind: 'start', workspaceId: 'only' }, 'exactly one workspace auto-starts')
  assert.deepEqual(decideNewSessionAction(undefined, ['a', 'b']), { kind: 'pick-workspace' }, 'several workspaces and none selected — open the drawer')
})

// -- the install (textual: the observer needs a DOM Node has none of) ----------

test('T70 effect: the install watches body childList, exits early when unarmed, and marks via the pure decision', () => {
  const source = readFileSync(join(ROOT, 'src', 'client', 'effects', 'permission-sheet.ts'), 'utf8')
  // body childList only: the portal appends straight to body.
  assert.ok(source.includes("observer.observe(document.body, { childList: true })"), 'the observer watches exactly the body\'s child list')
  // Unarmed ticks exit before touching anything — a menu opened through
  // any OTHER button is never marked.
  assert.ok(source.includes('if (!armed) return'), 'an unarmed window never marks')
  // The mark itself goes through the pure decision + the one attribute.
  assert.ok(source.includes('isUnmarkedPortalMenu(node)'), 'added nodes go through the pure decision')
  assert.ok(source.includes('root.setAttribute(SHEET_MARKER, armedKind)'), 'the marker lands as an attribute (perm or workspace)')
  // Teardown stops both listeners and the switch lock.
  assert.ok(source.includes("removeEventListener('click', onCaptureClick, true)"), 'the capture click listener is removed')
  assert.ok(source.includes("removeEventListener('pointerdown', onCapturePointerDown, true)"), 'the capture pointerdown listener is removed')
  assert.ok(source.includes('observer.disconnect()'), 'the observer disconnects')
  assert.ok(source.includes('releaseLock()'), 'teardown releases the switch lock')
})

// -- the install, behaviorally (fake Element/window/document/MutationObserver) --

/**
 * A minimal DOM simulation good enough to run the REAL installPermissionSheet
 * (the same shape the review's t70review-sim.mjs used): Element with
 * matches/get/set/removeAttribute/closest, click+pointerdown-listener traps
 * on document, a documentElement carrying the switch-lock marker, a
 * querySelector that answers the four lookups the effect makes (marked menu?
 * current session? placeholder card?), and MutationObserver instances kept
 * in install order (0 = the arming observer, 1 = the lazy switch-lock
 * observer that only exists after a workspace pick).
 */
async function bootSim({ session = null, placeholder = false } = {}) {
  const state = {
    clickListener: undefined,
    pointerdownListener: undefined,
    observers: [],
    menus: [],
    sessionNode: null,
    placeholderOpen: placeholder,
  }
  class FakeElement {
    constructor(kind) {
      this.kind = kind
      this.attrs = {}
    }
    matches(selectors) { return selectors === 'body > div[role="menu"]' && this.kind === 'menu' }
    getAttribute(name) { return this.attrs[name] ?? null }
    setAttribute(name, value) { this.attrs[name] = value }
    removeAttribute(name) { delete this.attrs[name] }
    closest(selectors) {
      if (selectors.includes('permission')) return this.kind === 'permTrigger' ? this : null
      if (selectors.includes('menuitem')) return this.kind === 'wsMenuitem' ? this : null
      // The workspace selector is a comma list — mirror real closest()
      // semantics: the element matches if EITHER alternative matches it.
      if (selectors.includes('aria-haspopup="menu"]') && this.kind === 'wsChip') return this
      if (selectors.includes('cardWorkspaceTrigger') && this.kind === 'wsCard') return this
      return null
    }
  }
  globalThis.Element = FakeElement
  globalThis.window = { matchMedia: () => ({ matches: true }) }
  const html = new FakeElement('html')
  globalThis.document = {
    documentElement: html,
    body: {},
    addEventListener: (type, fn) => {
      if (type === 'click') state.clickListener = fn
      if (type === 'pointerdown') state.pointerdownListener = fn
    },
    removeEventListener: (type, fn) => {
      if (state.clickListener === fn) state.clickListener = undefined
      if (state.pointerdownListener === fn) state.pointerdownListener = undefined
    },
    querySelector: (selectors) => {
      if (selectors.includes('data-zen-sheet')) {
        return state.menus.find((menu) => menu.attrs['data-zen-sheet'] != null) ?? null
      }
      if (selectors.includes('data-conversation-session')) return state.sessionNode
      if (selectors.includes('_cardWorkspaceTrigger')) return state.placeholderOpen ? new FakeElement('placeholderCard') : null
      return null
    },
  }
  globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; state.observers.push(this) }
    observe() { this.observing = true }
    disconnect() { this.observing = false }
  }
  if (session !== null) {
    state.sessionNode = new FakeElement('session')
    state.sessionNode.attrs['data-conversation-session'] = session
  }
  const mod = await loadEffect()
  let stop
  mod.installPermissionSheet({ effect: (fn) => { stop = fn() } })
  const permTrigger = new FakeElement('permTrigger')
  const wsChip = new FakeElement('wsChip')
  const wsCard = new FakeElement('wsCard')
  return {
    state,
    el: (kind) => new FakeElement(kind),
    html,
    permTrigger,
    wsChip,
    wsCard,
    click(target) {
      const event = {
        target,
        prevented: false,
        stopped: false,
        preventDefault() { this.prevented = true },
        stopPropagation() { this.stopped = true },
      }
      // After an uninstall the listener is gone: the click lands nowhere.
      state.clickListener?.(event)
      return event
    },
    pointerdown(target) {
      state.pointerdownListener?.({ target })
    },
    // Sugar for the T70 tests: a plain tap on the permission trigger.
    tapTrigger() { this.click(permTrigger) },
    addMenu() {
      const menu = new FakeElement('menu')
      state.menus.push(menu)
      // After an uninstall the observer is disconnected: the DOM changes
      // but nothing is told about it.
      state.observers[0]?.cb([{ addedNodes: [menu] }])
      return menu
    },
    lockMo() { return state.observers[1] },
    setSession(value) {
      const node = new FakeElement('session')
      node.attrs['data-conversation-session'] = value
      state.sessionNode = node
    },
    unmount() { stop() },
    cleanup() {
      delete globalThis.Element
      delete globalThis.window
      delete globalThis.document
      delete globalThis.MutationObserver
    },
  }
}

test('T70-fix behavior: an OPEN click marks the menu that lands with it', async () => {
  const sim = await bootSim()
  try {
    sim.tapTrigger()
    const menu = sim.addMenu()
    assert.equal(menu.getAttribute('data-zen-sheet'), 'perm', 'the opening menu is marked')
  } finally { sim.cleanup() }
})

test('T70-fix behavior: the CLOSE click opens no window — a later unrelated menu is never marked', async () => {
  const sim = await bootSim()
  try {
    // Open: the menu lands marked; it is still on the page.
    sim.tapTrigger()
    const perm = sim.addMenu()
    assert.equal(perm.getAttribute('data-zen-sheet'), 'perm')

    // Close: the click lands BEFORE the host unmounts the menu (capture
    // first) — the marked menu on the page must keep the window shut.
    sim.tapTrigger()
    const unrelated = sim.addMenu()
    assert.equal(unrelated.getAttribute('data-zen-sheet'), undefined ?? null, 'an unrelated menu inside a close-click window is NOT marked')
    assert.equal(unrelated.getAttribute('data-zen-sheet'), null)
  } finally { sim.cleanup() }
})

test('T70-fix behavior: a window whose menu never came expires and marks nothing', async () => {
  const sim = await bootSim()
  try {
    // Open click, but the menu never lands (React stalled): the window must
    // retire on its own instead of marking whatever shows up later.
    sim.tapTrigger()
    await wait(1_700)
    const unrelated = sim.addMenu()
    assert.equal(unrelated.getAttribute('data-zen-sheet'), null, 'the expired window marks nothing')
  } finally { sim.cleanup() }
})

test('T70-fix behavior: after uninstall nothing is marked', async () => {
  const sim = await bootSim()
  try {
    sim.unmount()
    sim.tapTrigger()
    const menu = sim.addMenu()
    assert.equal(menu.getAttribute('data-zen-sheet'), null, 'an uninstalled effect never marks')
  } finally { sim.cleanup() }
})

// -- UX-3 behavior: workspace sheet, toggle debounce, switch lock ---------------

test('UX-3 behavior: a workspace chip click arms a WORKSPACE-marked sheet', async () => {
  const sim = await bootSim()
  try {
    sim.click(sim.wsChip)
    const menu = sim.addMenu()
    assert.equal(menu.getAttribute('data-zen-sheet'), 'workspace', 'the workspace menu gets its own marker value')
    // The host unmounts the sheet on close — only then can the placeholder
    // card trigger arm the next one.
    sim.state.menus.length = 0
    sim.click(sim.wsCard)
    const menu2 = sim.addMenu()
    assert.equal(menu2.getAttribute('data-zen-sheet'), 'workspace')
  } finally { sim.cleanup() }
})

test('UX-3 behavior: a tap on the open workspace chip closes — the toggle click is swallowed', async () => {
  const sim = await bootSim()
  try {
    sim.pointerdown(sim.wsChip)
    sim.click(sim.wsChip)
    const menu = sim.addMenu()
    assert.equal(menu.getAttribute('data-zen-sheet'), 'workspace', 'open works through pointerdown+click')

    // Second tap while open: the host Menu closed on the outside pointerdown;
    // the trigger's own click must not flip it straight back open.
    sim.pointerdown(sim.wsChip)
    const e = sim.click(sim.wsChip)
    assert.ok(e.prevented && e.stopped, 'the toggle click is swallowed whole')
    const stray = sim.addMenu()
    assert.equal(stray.getAttribute('data-zen-sheet'), null, 'the close tap arms nothing — a stray menu is never mis-marked')

    // Self-heal: if the pointerdown close did NOT land (the marked menu is
    // still on the page at click time), the NEXT tap falls through to the
    // host's own toggle instead of being swallowed forever.
    sim.pointerdown(sim.wsChip)
    const e2 = sim.click(sim.wsChip)
    assert.ok(!e2.prevented && !e2.stopped, 'a tap that could not close passes through to the host toggle')
  } finally { sim.cleanup() }
})

test('UX-3 behavior: a pointerdown elsewhere never arms the swallow', async () => {
  const sim = await bootSim()
  try {
    sim.pointerdown(sim.wsChip)
    sim.click(sim.wsChip)
    sim.addMenu()
    // Tap somewhere that is not a workspace trigger (the mask behind the
    // sheet): the click must pass through untouched.
    const e = sim.click(sim.permTrigger)
    assert.ok(!e.prevented && !e.stopped, 'unrelated clicks are never swallowed')
  } finally { sim.cleanup() }
})

test('UX-3 behavior: picking a workspace item locks the composer until the session settles', async () => {
  const sim = await bootSim({ session: 'S1', placeholder: true })
  try {
    sim.click(sim.el('wsMenuitem'))
    assert.equal(sim.html.getAttribute('data-zen-ws-switching'), '1', 'the lock lands on <html>')

    // Not settled yet: the placeholder card is still up (the same session).
    sim.lockMo().cb([])
    assert.equal(sim.html.getAttribute('data-zen-ws-switching'), '1', 'placeholder still up — the lock holds')

    // Settle: the conversation remounted on S2 and the picker card is gone.
    sim.setSession('S2')
    sim.state.placeholderOpen = false
    sim.lockMo().cb([])
    assert.equal(sim.html.getAttribute('data-zen-ws-switching'), null, 'settled — the lock releases')
  } finally { sim.cleanup() }
})

test('UX-3 behavior: a permission option click never locks the composer', async () => {
  const sim = await bootSim({ session: 'S1', placeholder: false })
  try {
    sim.click(sim.el('permMenuitem'))
    assert.equal(sim.html.getAttribute('data-zen-ws-switching'), null, 'perm-menu items are outside the lock selector')
  } finally { sim.cleanup() }
})

test('UX-3 behavior: the switch lock self-releases after the 1.5 s cap', async () => {
  const sim = await bootSim({ session: 'S1', placeholder: true })
  try {
    sim.click(sim.el('wsMenuitem'))
    assert.equal(sim.html.getAttribute('data-zen-ws-switching'), '1')
    await wait(1_700)
    assert.equal(sim.html.getAttribute('data-zen-ws-switching'), null, 'the cap releases the lock on its own')
  } finally { sim.cleanup() }
})

test('UX-3 behavior: uninstall clears the lock and both listeners', async () => {
  const sim = await bootSim({ session: 'S1', placeholder: true })
  try {
    sim.click(sim.el('wsMenuitem'))
    assert.equal(sim.html.getAttribute('data-zen-ws-switching'), '1')
    sim.unmount()
    assert.equal(sim.html.getAttribute('data-zen-ws-switching'), null, 'teardown releases the lock')
    sim.pointerdown(sim.wsChip)
    const e = sim.click(sim.wsChip)
    assert.ok(!e.prevented && !e.stopped, 'both capture listeners are gone')
    const menu = sim.addMenu()
    assert.equal(menu.getAttribute('data-zen-sheet'), null, 'the arming observer is gone too')
  } finally { sim.cleanup() }
})

// -- model sheet rows (DSH 0.2.0) -----------------------------------------------

test('model sheet rows: options and root cells are matched by role, so the SELECTED option gets the row treatment', () => {
  // On 0.2.0 the checked option's class list ends in `_selected`
  // (`…_option …_selected`), which a `[class$="_option"]` selector misses —
  // the checked row fell back to the host's 34px pill beside 48px siblings.
  // The role selectors cover it; the class forms stay for older hosts.
  const rowRule = sheet.slice(sheet.indexOf('/* 44pt+ rows in both sheets'), sheet.indexOf('min-height: 48px !important;'))
  assert.ok(rowRule.includes('${MODEL_MENU} [role="menuitemradio"],'), 'model/effort options are matched by role')
  assert.ok(rowRule.includes('${MODEL_MENU} [role="menuitem"],'), 'the two root cells are matched by role')
  assert.ok(rowRule.includes('${MODEL_MENU} [class$="_option"],'), 'the class form survives for older hosts')
})
