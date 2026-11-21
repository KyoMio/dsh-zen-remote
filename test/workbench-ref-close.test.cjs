'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = (p) => path.join(__dirname, '..', ...p)
const loadRefClose = () => import('../src/client/effects/workbench-ref-close.ts?' + Math.random())
const loadPanels = () => import('../src/client/sidebar-panels.ts?' + Math.random())

test('installWorkbenchRefClose: registered in index.tsx', () => {
  const index = fs.readFileSync(ROOT(['src', 'client', 'index.tsx']), 'utf8')
  assert.match(index, /installWorkbenchRefClose\(ctx\)/)
})

test('installWorkbenchRefClose: capture-phase tap on _explorerRef defers closeOpenSidebar, re-checks open state, and ignores desktop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  class FakeElement {
    constructor(opts = {}) {
      this.matchesTags = opts.matchesTags ?? new Set()
      this.clicks = 0
    }
    closest(selector) {
      for (const tag of this.matchesTags) {
        if (selector.includes(tag)) return this
      }
      return null
    }
    click() {
      this.clicks += 1
    }
  }

  const prevElement = Object.getOwnPropertyDescriptor(globalThis, 'Element')
  const prevWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const prevDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  t.after(() => {
    if (prevElement === undefined) delete globalThis.Element
    else Object.defineProperty(globalThis, 'Element', prevElement)
    if (prevWindow === undefined) delete globalThis.window
    else Object.defineProperty(globalThis, 'window', prevWindow)
    if (prevDocument === undefined) delete globalThis.document
    else Object.defineProperty(globalThis, 'document', prevDocument)
  })

  const state = {
    phone: true,
    officialOpen: false,
    betterOpen: false,
    listeners: [],
    officialCollapse: new FakeElement(),
    betterToggle: new FakeElement(),
  }

  globalThis.Element = FakeElement
  globalThis.window = {
    matchMedia: () => ({ get matches() { return state.phone } }),
  }
  globalThis.document = {
    addEventListener: (type, fn, capture) => {
      state.listeners.push({ type, fn, capture })
    },
    removeEventListener: (type, fn, capture) => {
      state.listeners = state.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture))
    },
    querySelector: (sel) => {
      if (sel === '[data-sidebar-right-panel][data-sidebar-right-open]') return state.officialOpen ? new FakeElement() : null
      if (sel === '[data-sidebar-right-toggle]') return state.officialCollapse
      if (sel === '[data-dsh-better-sidebar] [class$="_panel"]') return state.betterOpen ? new FakeElement() : null
      if (sel === '[data-dsh-better-sidebar] button[class$="_toggleButton"]') return state.betterToggle
      return null
    },
  }

  const { installWorkbenchRefClose } = await loadRefClose()
  const { closeOpenSidebar } = await loadPanels()
  let stop
  installWorkbenchRefClose({ effect: (fn) => { stop = fn() } })

  assert.equal(state.listeners.length, 1)
  assert.equal(state.listeners[0].type, 'click')
  assert.equal(state.listeners[0].capture, true, 'must listen in capture phase')

  const click = (target) => {
    for (const l of [...state.listeners]) l.fn({ target })
  }

  // 1. Official panel open + tap on _explorerRef inside [data-sidebar-right-panel]
  state.officialOpen = true
  const officialRef = new FakeElement({ matchesTags: new Set(['[data-sidebar-right-panel] [class$="_explorerRef"]']) })
  click(officialRef)
  assert.equal(state.officialCollapse.clicks, 0, 'close is deferred past target handler')
  t.mock.timers.tick(0)
  assert.equal(state.officialCollapse.clicks, 1, 'official collapse clicked after setTimeout(0)')

  // 2. If panel already closed before timer fires, closeOpenSidebar is a no-op (never re-opens toggle)
  state.officialOpen = false
  state.betterOpen = true
  const betterRef = new FakeElement({ matchesTags: new Set(['[data-dsh-better-sidebar] [class$="_explorerRef"]']) })
  click(betterRef)
  state.betterOpen = false
  t.mock.timers.tick(0)
  assert.equal(state.betterToggle.clicks, 0, 'closed panel is never re-opened')
  assert.equal(closeOpenSidebar(), false)

  // 3. Open better-sidebar closes when still open at fire time
  state.betterOpen = true
  click(betterRef)
  t.mock.timers.tick(0)
  assert.equal(state.betterToggle.clicks, 1)

  // 4. Desktop width and non-ref targets do nothing
  state.phone = false
  state.officialOpen = true
  click(officialRef)
  t.mock.timers.tick(0)
  assert.equal(state.officialCollapse.clicks, 1)

  state.phone = true
  click(new FakeElement())
  t.mock.timers.tick(0)
  assert.equal(state.officialCollapse.clicks, 1)

  // 5. Teardown removes the exact capture-phase listener
  stop()
  assert.equal(state.listeners.length, 0)
})

test('landscape entry collapses each visible initial panel without swallowing deliberate tool opens', async (t) => {
  const { collapseInitialLandscapePanels, OFFICIAL_PANEL, OFFICIAL_PANEL_OPEN, OFFICIAL_COLLAPSE } = await loadPanels()
  const panels = []
  const rightbar = { querySelectorAll: (selector) => selector === OFFICIAL_PANEL ? panels : [] }
  let onMutation
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
  Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class {
    constructor(callback) { onMutation = callback }
    observe() {}
    disconnect() { onMutation = undefined }
  } })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'MutationObserver', previous)
    else delete globalThis.MutationObserver
  })
  const makePanel = ({ open, hidden = false }) => ({
    open, hidden, clicks: 0,
    closest(selector) { return selector === '[hidden]' && this.hidden ? this : null },
    matches(selector) { return selector === OFFICIAL_PANEL_OPEN && this.open },
    querySelector(selector) {
      return selector === OFFICIAL_COLLAPSE && this.open ? { click: () => { this.clicks++; this.open = false } } : null
    },
  })
  const original = makePanel({ open: true })
  const inactive = makePanel({ open: true, hidden: true })
  panels.push(original, inactive)
  const stop = collapseInitialLandscapePanels(rightbar)
  assert.equal(original.open, false)
  assert.equal(inactive.open, true, 'do not change another session’s hidden panel')

  original.open = true
  onMutation()
  assert.equal(original.clicks, 1, 'manual reopen stays open')

  inactive.hidden = false
  onMutation()
  assert.equal(inactive.open, false, 'first viewing another session also leaves chat available')

  const lateClosed = makePanel({ open: false })
  panels.push(lateClosed)
  onMutation()
  lateClosed.open = true
  onMutation()
  assert.equal(lateClosed.clicks, 0, 'a panel that began closed stays manually openable')
  stop()
  assert.equal(onMutation, undefined)
})
