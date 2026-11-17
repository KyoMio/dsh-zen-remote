'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const strip = (block) => block.replace(/\/\*[\s\S]*?\*\//g, '')

let composerCss
const getCss = async () => {
  if (composerCss === undefined) {
    composerCss = (await import('../src/client/styles/composer.css.ts')).COMPOSER_CSS
  }
  return composerCss
}

test('4a/4b CSS contracts: opt-in hide, 26px scroller strip, fixed menu z-index 60..70, phone-only, jump-to-bottom hide', async () => {
  const composer = await getCss()
  const section = composer.slice(
    composer.indexOf('--- 4a. third-party composer entries'),
    composer.indexOf('--- 4b.'),
  )
  assert.ok(section.length > 0)
  const decls = strip(section)

  assert.match(
    decls,
    /\[data-slot="conversation\.input\.right"\]\[data-zen-sheet-extras\],\s*\[data-zen-composer-extra\]:not\(\[data-zen-composer-extra="open"\]\)\s*\{\s*display: none !important;/,
  )
  assert.doesNotMatch(decls, /:not\(\[data-zen-sheet-extras\]\)/)

  const stripRule = /\[data-slot="conversation\.input\.dock"\] > \[data-mobile-nav="composer-chips"\] \{([\s\S]*?)\n  \}/.exec(section)
  assert.ok(stripRule)
  const stripDecls = strip(stripRule[1])
  assert.match(stripDecls, /flex-flow: row nowrap !important;/)
  assert.match(stripDecls, /overflow-x: auto !important;/)
  assert.match(stripDecls, /order: 0 !important;/)
  assert.match(stripDecls, /max-height: 26px !important;/)
  assert.match(stripDecls, /flex: 0 1 auto !important;/)
  assert.match(stripDecls, /min-width: 0 !important;/)

  assert.match(decls, /\[data-mobile-nav="composer-chips"\] button \{[^}]*height: 26px !important;/)
  assert.match(decls, /\[data-mobile-nav="composer-chips"\] button \{[^}]*border-radius: 999px !important;/)

  const menuRule = /\[data-zen-sheet-extras\] \[role="menu"\] \{([\s\S]*?)\n  \}/.exec(section)
  assert.ok(menuRule)
  const menuDecls = strip(menuRule[1])
  assert.match(menuDecls, /position: fixed !important;/)
  const z = Number(/z-index:\s*(\d+)/.exec(menuDecls)?.[1])
  assert.ok(z > 60 && z < 70)
  assert.match(decls, /\[class\$="_composerSeat"\]:has\(\[data-zen-sheet-extras\] \[role="menu"\]\)/)

  const phone = composer.indexOf('@media (max-width: 767px) {')
  const tablet = composer.indexOf('@media (min-width: 768px) {')
  const start = composer.indexOf('--- 4a. third-party composer entries')
  assert.ok(phone !== -1 && tablet !== -1 && start > phone && start < tablet)

  const section4b = composer.slice(composer.indexOf('--- 4b.'), composer.indexOf('--- 5.'))
  assert.ok(section4b.length > 0)
  assert.match(strip(section4b), /body:has\(\[data-zen-sheet-extras\] \[role="menu"\]\) \[data-chat-flow\] \+ div/)

  const gate = /\[data-slot="conversation\.input\.dock"\]:has\(([^)]*)\) \{\s*flex-wrap: wrap/.exec(composer)
  assert.ok(gate && !gate[1].includes('composer-chips'))

  assert.match(read('src', 'client', 'index.tsx'), /^\s*installModelSheetExtras\(ctx\)/m)
})

test('installModelSheetExtras behavior: relocates extras, spares lone vision toggle, restores via Comment anchor on desktop/unmount', async (t) => {
  class FakeNode {
    constructor(tag = 'DIV', attrs = {}) {
      this.tagName = tag
      this.attrs = { ...attrs }
      this.children = []
      this.parentNode = null
      this.parentElement = null
    }
    get isConnected() {
      let cur = this
      while (cur !== null) {
        if (cur._isRoot) return true
        cur = cur.parentNode
      }
      return false
    }
    setAttribute(k, v) { this.attrs[k] = String(v) }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
    hasAttribute(k) { return k in this.attrs }
    removeAttribute(k) { delete this.attrs[k] }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this
      child.parentElement = this
      this.children.push(child)
      return child
    }
    prepend(child) {
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this
      child.parentElement = this
      this.children.unshift(child)
    }
    insertBefore(newNode, refNode) {
      if (newNode.parentNode) newNode.parentNode.removeChild(newNode)
      newNode.parentNode = this
      newNode.parentElement = this
      const idx = refNode ? this.children.indexOf(refNode) : -1
      if (idx === -1) this.children.push(newNode)
      else this.children.splice(idx, 0, newNode)
      return newNode
    }
    removeChild(child) {
      const idx = this.children.indexOf(child)
      if (idx !== -1) this.children.splice(idx, 1)
      child.parentNode = null
      child.parentElement = null
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this)
    }
    matches(sel) {
      if (sel === '[data-vision-router-mode-toggle]') return 'data-vision-router-mode-toggle' in this.attrs
      return false
    }
    querySelector(sel) {
      for (const c of this.children) {
        if (matchesSimple(c, sel)) return c
        const nested = c.querySelector(sel)
        if (nested) return nested
      }
      return null
    }
    querySelectorAll(sel) {
      const out = []
      const walk = (node) => {
        for (const c of node.children) {
          if (matchesSimple(c, sel)) out.push(c)
          walk(c)
        }
      }
      walk(this)
      return out
    }
  }

  function matchesSimple(el, sel) {
    if (el.tagName === '#comment') return false
    if (sel === '[data-vision-router-mode-toggle]') return 'data-vision-router-mode-toggle' in el.attrs
    if (sel === '[data-mobile-nav="composer-chips"]') return el.attrs['data-mobile-nav'] === 'composer-chips'
    if (sel === '[data-zen-composer-extra]') return 'data-zen-composer-extra' in el.attrs
    if (sel === '[data-slot="conversation.input.right"]') return el.attrs['data-slot'] === 'conversation.input.right'
    if (sel === '[data-slot="conversation.input.dock"]:not([data-zen-synthetic-dock])') {
      return el.attrs['data-slot'] === 'conversation.input.dock' && !('data-zen-synthetic-dock' in el.attrs)
    }
    if (sel === '[data-slot="conversation.composer.bar"]') return el.attrs['data-slot'] === 'conversation.composer.bar'
    if (sel.includes('[data-slot="conversation.input.right"] > *:not([data-mobile-nav])')) {
      return el.parentElement?.attrs['data-slot'] === 'conversation.input.right' && !('data-mobile-nav' in el.attrs)
    }
    return false
  }

  const prevWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const prevDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const prevMo = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
  t.after(() => {
    if (prevWindow === undefined) delete globalThis.window
    else Object.defineProperty(globalThis, 'window', prevWindow)
    if (prevDocument === undefined) delete globalThis.document
    else Object.defineProperty(globalThis, 'document', prevDocument)
    if (prevMo === undefined) delete globalThis.MutationObserver
    else Object.defineProperty(globalThis, 'MutationObserver', prevMo)
  })

  const root = new FakeNode('DIV')
  root._isRoot = true
  const seat = new FakeNode('DIV')
  const bar = new FakeNode('DIV', { 'data-slot': 'conversation.composer.bar' })
  const rightSlot = new FakeNode('DIV', { 'data-slot': 'conversation.input.right' })
  bar.appendChild(rightSlot)
  seat.appendChild(bar)
  root.appendChild(seat)

  const vision = new FakeNode('BUTTON', { 'data-vision-router-mode-toggle': '' })
  rightSlot.appendChild(vision)

  let phoneMatches = true
  const mqListeners = []
  let moCallback = null

  globalThis.window = {
    matchMedia: () => ({
      get matches() { return phoneMatches },
      addEventListener: (_t, fn) => mqListeners.push(fn),
      removeEventListener: (_t, fn) => {
        const idx = mqListeners.indexOf(fn)
        if (idx !== -1) mqListeners.splice(idx, 1)
      },
    }),
  }
  globalThis.MutationObserver = class {
    constructor(cb) { moCallback = cb }
    observe() {}
    disconnect() {}
  }
  globalThis.document = {
    body: root,
    createElement: (tag) => new FakeNode(tag.toUpperCase()),
    createComment: (text) => new FakeNode('#comment', { text }),
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
  }

  const { installModelSheetExtras } = await import('../src/client/effects/model-sheet-extras.ts?' + Math.random())
  let stop
  installModelSheetExtras({ effect: (fn) => { stop = fn() } })

  // 1. Lone vision toggle stays in place (worthMoving === false)
  assert.equal(vision.parentElement, rightSlot)
  assert.equal(vision.hasAttribute('data-zen-composer-extra'), false)
  assert.equal(root.querySelector('[data-mobile-nav="composer-chips"]'), null)

  // 2. Add a speed chip -> both controls park into composer-chips strip inside synthetic dock
  const speed = new FakeNode('BUTTON', { 'data-speed-chip': '1' })
  rightSlot.appendChild(speed)
  moCallback()
  const strip = root.querySelector('[data-mobile-nav="composer-chips"]')
  assert.ok(strip !== null, 'strip created when worthMoving is true')
  assert.equal(vision.parentElement, strip)
  assert.equal(speed.parentElement, strip)
  assert.equal(vision.getAttribute('data-zen-composer-extra'), 'open')
  assert.equal(speed.getAttribute('data-zen-composer-extra'), 'open')
  assert.equal(rightSlot.getAttribute('data-zen-sheet-extras'), '')

  // 3. Switch to desktop -> nodes return to rightSlot via Comment anchors, strip removed
  phoneMatches = false
  for (const fn of [...mqListeners]) fn()
  assert.equal(vision.parentElement, rightSlot)
  assert.equal(speed.parentElement, rightSlot)
  assert.equal(vision.hasAttribute('data-zen-composer-extra'), false)
  assert.equal(rightSlot.hasAttribute('data-zen-sheet-extras'), false)
  assert.equal(root.querySelector('[data-mobile-nav="composer-chips"]'), null)

  // 4. Re-enter phone and unmount -> clean restoration
  phoneMatches = true
  for (const fn of [...mqListeners]) fn()
  assert.equal(speed.parentElement.getAttribute('data-mobile-nav'), 'composer-chips')
  stop()
  assert.equal(speed.parentElement, rightSlot)
  assert.equal(root.querySelector('[data-mobile-nav="composer-chips"]'), null)
})
