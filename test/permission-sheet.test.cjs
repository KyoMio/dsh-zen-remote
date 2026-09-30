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

// -- the stylesheet ------------------------------------------------------------

test('T70 css: the portaled permission menu joins the bottom-sheet rule, the row rule and the :has gate', () => {
  // All three section-4/4a rules name the portal form.
  assert.ok(
    sheet.includes(`${PORTAL_RULE},\n  ${'${MODEL_MENU}'} {\n    position: fixed !important;`),
    'the portal menu sits in the bottom-sheet rule beside the model menu',
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
  for (const needle of [PORTAL_RULE, 'body:has(> div[role="menu"][data-zen-sheet="perm"])']) {
    const at = sheet.indexOf(needle, blockStart)
    assert.ok(at !== -1 && at < blockEnd, `${needle} sits inside the phone media block`)
  }
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
  const { clickArmsPermissionSheet } = await loadEffect()
  const trigger = candidate({ closest: (selectors) => (selectors.includes('permission') ? {} : null) })
  const other = candidate({ closest: () => null })

  assert.equal(clickArmsPermissionSheet(trigger, true), true, 'the trigger click arms')
  assert.equal(clickArmsPermissionSheet(other, true), false, 'any other button never arms — its menus stay unmarked')
  assert.equal(clickArmsPermissionSheet(null, true), false, 'a text-node/absent target never arms')
  assert.equal(clickArmsPermissionSheet(trigger, false), false, 'the desktop shell never arms — no sheet marking there')
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
  assert.ok(source.includes("root.setAttribute(SHEET_MARKER, SHEET_VALUE)"), 'the marker lands as an attribute')
  // Teardown stops both listeners.
  assert.ok(source.includes("removeEventListener('click', onCaptureClick, true)"), 'the capture click listener is removed')
  assert.ok(source.includes('observer.disconnect()'), 'the observer disconnects')
})

// -- the install, behaviorally (fake Element/window/document/MutationObserver) --

/**
 * A minimal DOM simulation good enough to run the REAL installPermissionSheet
 * (the same shape the review's t70review-sim.mjs used): Element with
 * matches/get/setAttribute/closest, a click-listener trap on document, a
 * manual MutationObserver callback, and a querySelector that answers the
 * guard's one question — is a MARKED menu still on the page?
 */
async function bootSim() {
  const state = { clickListener: undefined, moCallback: undefined, menus: [] }
  class FakeElement {
    constructor(kind) {
      this.kind = kind
      this.attrs = {}
    }
    matches(selectors) { return selectors === 'body > div[role="menu"]' && this.kind === 'menu' }
    getAttribute(name) { return this.attrs[name] ?? null }
    setAttribute(name, value) { this.attrs[name] = value }
    closest(selectors) { return this.kind === 'permTrigger' && selectors.includes('permission') ? this : null }
  }
  globalThis.Element = FakeElement
  globalThis.window = { matchMedia: () => ({ matches: true }) }
  globalThis.document = {
    body: {},
    addEventListener: (type, fn) => { if (type === 'click') state.clickListener = fn },
    removeEventListener: (type, fn) => { if (state.clickListener === fn) state.clickListener = undefined },
    querySelector: () => state.menus.find((menu) => menu.attrs['data-zen-sheet'] === 'perm') ?? null,
  }
  globalThis.MutationObserver = class {
    constructor(cb) { state.moCallback = cb }
    observe() { /* the test drives the callback by hand */ }
    disconnect() { state.moCallback = undefined }
  }
  const mod = await loadEffect()
  let stop
  mod.installPermissionSheet({ effect: (fn) => { stop = fn() } })
  const trigger = new FakeElement('permTrigger')
  return {
    trigger,
    tapTrigger() {
      // After an uninstall the listener is gone: the click lands nowhere.
      state.clickListener?.({ target: trigger })
    },
    addMenu() {
      const menu = new FakeElement('menu')
      state.menus.push(menu)
      // After an uninstall the observer is disconnected: the DOM changes
      // but nothing is told about it.
      state.moCallback?.([{ addedNodes: [menu] }])
      return menu
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
