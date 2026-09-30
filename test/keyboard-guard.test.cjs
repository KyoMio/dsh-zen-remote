// dsh-zen-remote · T72 the model sheet on 0.2.0-rc.2: the second pane as a
// bottom sheet, and the search box that must not pop the phone keyboard
//
// - the CSS half: composer.css.ts's MODEL_MENU body form accepts BOTH roles
//   (rc.1/0.1.5 portals role=menu; rc.2 re-roles the model pane to
//   role=group) with a `[class$="_menu"]` narrowing, the jump-to-latest
//   :has() gate spells the same shape, and everything sits inside the phone
//   media block;
// - the guard half (behavioral, fake DOM driving the REAL
//   installKeyboardGuard — the same seam permission-sheet.test.cjs uses):
//   a programmatic focus on the model sheet's search box is retracted by
//   moving focus INSIDE the menu (to the selected menuitemradio — the rc.2
//   root onBlur CLOSES the menu when focus leaves root and menu, so a plain
//   blur would slam the sheet shut), a tap on the field grants it until its
//   focus ends, the desktop width never attaches, and the composer's own
//   rules are untouched.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// -- the CSS half -------------------------------------------------------------

const cssFile = readFileSync(join(ROOT, 'src', 'client', 'styles', 'composer.css.ts'), 'utf8')
const css = cssFile.slice(cssFile.indexOf('export const COMPOSER_CSS'))

test('T72 css: the MODEL_MENU body form accepts role=menu AND role=group, narrowed to _menu classes', () => {
  // MODEL_MENU is a module constant interpolated into the stylesheet — the
  // definition line lives outside the template literal.
  assert.ok(
    cssFile.includes('body > [id$="-menu"][class$="_menu"]:is([role="menu"], [role="group"])'),
    'both roles, narrowed by the build-suffix class (rc.1 xevZdG_menu, rc.2 cl2Rlq_menu)',
  )
})

test('T72 css: the jump-to-latest :has() gate spells the same two-role shape', () => {
  assert.ok(
    css.includes('body:has(> [id$="-menu"][class$="_menu"]:is([role="menu"], [role="group"])) [data-chat-flow] + div'),
    'the gate hides the jump button for the second pane too',
  )
})

test('T72 css: the two-role rule sits inside the phone media block', () => {
  const blockStart = css.indexOf('@media (max-width: 767px)')
  const blockEnd = css.indexOf('\n}\n', blockStart)
  // The rules reference the constant — count its USES inside the block.
  const at = css.indexOf('${MODEL_MENU}', blockStart)
  assert.ok(at !== -1 && at < blockEnd, 'inside the phone media block — desktop shells never load it, ≥768px never matches')
})

// -- the guard half (behavioral, fake DOM) --------------------------------------

/** Fake globals + the real installKeyboardGuard, with the model menu tree
 * (search field → menu root → selected row) built on demand. Elements are
 * instances of the stubbed HTMLElement (the guard's `instanceof` check). */
async function bootGuard({ phone }) {
  const elementProto = class FakeHTMLElement {}.prototype
  function makeElement({ kind, role = null, tagName = 'DIV' }) {
    const el = {
      kind,
      role,
      tagName,
      focused: 0,
      blurred: 0,
      parent: null,
      querySelector: () => null,
      focus() { el.focused += 1 },
      blur() { el.blurred += 1 },
      getAttribute(name) { return name === 'role' ? role : null },
      closest(selectors) {
        if (selectors.includes('conversation.composer.bar') || selectors.includes('data-composer-input')) {
          return kind === 'composer-field' ? el : null
        }
        if (selectors === 'body > [id$="-menu"]') return kind === 'search' ? el.parent : null
        if (selectors === 'body > [id$="-menu"] [role="searchbox"]') return kind === 'search' ? el : null
        return null
      },
    }
    Object.setPrototypeOf(el, elementProto)
    return el
  }
  const state = {
    listeners: {},
    addTypes: [],
    activeElement: null,
    menu: null,
    selected: null,
    search: null,
  }
  globalThis.HTMLElement = elementProto.constructor
  globalThis.window = {
    matchMedia: () => ({ matches: phone, addEventListener: () => {}, removeEventListener: () => {} }),
    setTimeout,
    clearTimeout,
  }
  globalThis.document = {
    body: {},
    get activeElement() { return state.activeElement },
    set activeElement(value) { state.activeElement = value },
    addEventListener: (type, fn) => {
      state.addTypes.push(type)
      state.listeners[type] = fn
    },
    removeEventListener: (type) => { delete state.listeners[type] },
  }
  globalThis.MutationObserver = class {
    observe() { /* the tests drive sweep() through focusin directly */ }
    disconnect() {}
  }

  const mod = await import('../src/client/effects/keyboard-guard.ts?' + Math.random())
  let stop
  mod.installKeyboardGuard({ effect: (fn) => { stop = fn() } })

  return {
    addTypes: () => state.addTypes,
    makeComposerField() {
      const field = makeElement({ kind: 'composer-field', tagName: 'TEXTAREA' })
      state.activeElement = field
      return field
    },
    makeSearchField() {
      if (state.search === null) {
        state.selected = makeElement({ kind: 'selected', role: 'menuitemradio' })
        state.menu = makeElement({ kind: 'menu', role: 'group' })
        state.menu.querySelector = (selectors) => {
          if (selectors.includes('aria-checked="true"')) return state.selected
          if (selectors.includes('menuitemradio')) return state.selected
          return null
        }
        state.search = makeElement({ kind: 'search', role: 'searchbox' })
        state.search.parent = state.menu
      }
      state.activeElement = state.search
      return state.search
    },
    selected() { return state.selected },
    search() { return state.search },
    focusIn(target) { state.listeners.focusin?.({ target }) },
    focusOut(target) { state.listeners.focusout?.({ target }) },
    pointerDown(target) { state.listeners.pointerdown?.({ target }) },
    unmount() { stop() },
    cleanup() {
      delete globalThis.HTMLElement
      delete globalThis.window
      delete globalThis.document
      delete globalThis.MutationObserver
    },
  }
}

test('T72 guard: a programmatic focus on the search box is retracted INTO the menu, not blurred away', async () => {
  const sim = await bootGuard({ phone: true })
  try {
    assert.ok(sim.addTypes().includes('focusin'), 'the guard attached on the phone width')
    const search = sim.makeSearchField()
    sim.focusIn(search)
    assert.equal(sim.selected().focused, 1, 'focus moved to the selected menuitemradio')
    assert.equal(search.blurred, 0, 'never blurred — the rc.2 root onBlur would close the menu')
  } finally { sim.cleanup() }
})

test('T72 guard: a tap on the search field grants it until its focus ends', async () => {
  const sim = await bootGuard({ phone: true })
  try {
    const search = sim.makeSearchField()
    // The user's own tap: the keyboard is wanted — typing filters models.
    sim.pointerDown(search)
    sim.focusIn(search)
    assert.equal(search.blurred, 0)
    assert.equal(sim.selected().focused, 0, 'granted — no retraction')
    // Later focusin events while still focused: no repeated retraction.
    sim.focusIn(search)
    assert.equal(sim.selected().focused, 0, 'the grant holds for subsequent sweeps')
    // The field blurs: the grant dies with it.
    sim.focusOut(search)
    sim.focusIn(search)
    assert.equal(sim.selected().focused, 1, 'a programmatic focus after blur is retracted again')
  } finally { sim.cleanup() }
})

test('T72 guard: the desktop width never attaches', async () => {
  const sim = await bootGuard({ phone: false })
  try {
    assert.equal(sim.addTypes().length, 0, 'no listeners registered — nothing can intercept focus')
    const search = sim.makeSearchField()
    assert.equal(sim.selected().focused, 0)
    assert.equal(search.blurred, 0)
  } finally { sim.cleanup() }
})

test('T72 guard: the composer rules are untouched', async () => {
  const sim = await bootGuard({ phone: true })
  try {
    // Programmatic composer focus is blurred, as since S9.
    const field = sim.makeComposerField()
    sim.focusIn(field)
    assert.equal(field.blurred, 1, 'the composer autofocus is still retracted')
    assert.equal(sim.search()?.blurred ?? 0, 0, 'the composer path never touches the search field')

    // A tap on the composer field grants it.
    sim.pointerDown(field)
    sim.focusIn(field)
    assert.equal(field.blurred, 1, 'no second blur — the grant holds')
  } finally { sim.cleanup() }
})
