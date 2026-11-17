'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const loadEffect = () => import('../src/client/effects/permission-sheet.ts?' + Math.random())
const loadComposerCss = () => import('../src/client/styles/composer.css.ts')

const ROOT = join(__dirname, '..')
const ROW = '[data-slot="conversation.composer.bar"] [class$="_card"] > [class$="_row"]'
const STD = `${ROW} > [class$="_trailing"] > [class$="_standardControls"]`
const MODEL = `${STD} > [data-slot="conversation.input.model"] > *:not([data-mobile-nav])`
const MODEL_MENU = `:is(${MODEL} > [class$="_menu"], body > [id$="-menu"][class$="_menu"]:is([role="menu"], [role="group"]))`
const PERM = `${ROW} > [class$="_tools"] > [class$="_modes"]`

const PORTAL_RULE = 'body > div[role="menu"][data-zen-sheet="perm"]'
const WS_RULE = 'body > div[role="menu"][data-zen-sheet="workspace"]'

// -- the stylesheet ------------------------------------------------------------

test('T70/UX-3 css: portaled perm & workspace sheets, 44pt rows, :has gates, switch lock, phone-only', async () => {
  const { COMPOSER_CSS: sheet } = await loadComposerCss()

  assert.ok(sheet.includes(`${WS_RULE},\n  ${MODEL_MENU} {\n    position: fixed !important;`))
  assert.ok(sheet.includes(`${PORTAL_RULE},`) && sheet.indexOf(PORTAL_RULE) < sheet.indexOf(WS_RULE))
  assert.ok(sheet.includes(`${PORTAL_RULE} [role="menuitem"],`))
  assert.ok(sheet.includes('body:has(> div[role="menu"][data-zen-sheet="perm"]) [data-chat-flow] + div'))

  assert.ok(sheet.includes(`${PERM} [role="menu"],`))
  assert.ok(sheet.includes(`${PERM} [role="menu"] [role="menuitem"],`))
  assert.ok(sheet.includes(`body:has(${PERM} [role="menu"])`))

  const blockStart = sheet.indexOf('@media (max-width: 767px)')
  assert.notEqual(blockStart, -1)
  const blockEnd = sheet.indexOf('\n}\n', blockStart)
  assert.notEqual(blockEnd, -1)
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

  assert.ok(sheet.includes(`${WS_RULE} [role="menuitem"],`))
  assert.ok(sheet.includes('body:has(> div[role="menu"][data-zen-sheet="workspace"]) [data-chat-flow] + div'))

  const lockAt = sheet.indexOf('html[data-zen-ws-switching] [data-slot="conversation.composer.bar"] {')
  assert.notEqual(lockAt, -1)
  const lockBlock = sheet.slice(lockAt, lockAt + 240)
  assert.ok(lockBlock.includes('pointer-events: none !important;'))
  assert.ok(lockBlock.includes('opacity: .6 !important;'))

  const rowRule = sheet.slice(sheet.indexOf('/* 44pt+ rows in both sheets'), sheet.indexOf('min-height: 48px !important;'))
  assert.ok(rowRule.includes(`${MODEL_MENU} [role="menuitemradio"],`))
  assert.ok(rowRule.includes(`${MODEL_MENU} [role="menuitem"],`))
  assert.ok(rowRule.includes(`${MODEL_MENU} [class$="_option"],`))
})

// -- pure marking decisions ----------------------------------------------------

const candidate = (over = {}) => ({
  matches: () => true,
  getAttribute: () => null,
  closest: () => null,
  ...over,
})

test('T70/UX-3 pure marking decisions', async () => {
  const {
    isUnmarkedPortalMenu,
    sheetKindForTrigger,
    pointerdownOnWorkspaceTrigger,
    menuitemClickStartsWorkspaceSwitch,
    workspaceSwitchSettled,
  } = await loadEffect()

  assert.equal(isUnmarkedPortalMenu(candidate()), true)
  assert.equal(isUnmarkedPortalMenu(candidate({ getAttribute: (name) => (name === 'data-zen-sheet' ? 'perm' : null) })), false)
  assert.equal(isUnmarkedPortalMenu(candidate({ matches: () => false })), false)

  const trigger = candidate({ closest: (s) => (s.includes('permission') ? {} : null) })
  const other = candidate({ closest: () => null })
  assert.equal(sheetKindForTrigger(trigger, true), 'perm')
  assert.equal(sheetKindForTrigger(other, true), null)
  assert.equal(sheetKindForTrigger(null, true), null)
  assert.equal(sheetKindForTrigger(trigger, false), null)

  const chip = candidate({ closest: (s) => (s.includes('aria-haspopup="menu"]') ? {} : null) })
  const card = candidate({ closest: (s) => (s.includes('cardWorkspaceTrigger') ? {} : null) })
  assert.equal(sheetKindForTrigger(chip, true), 'workspace')
  assert.equal(sheetKindForTrigger(card, true), 'workspace')
  assert.equal(sheetKindForTrigger(chip, false), null)

  assert.equal(pointerdownOnWorkspaceTrigger(chip), true)
  assert.equal(pointerdownOnWorkspaceTrigger(card), true)
  assert.equal(pointerdownOnWorkspaceTrigger(trigger), false)
  assert.equal(pointerdownOnWorkspaceTrigger(other), false)
  assert.equal(pointerdownOnWorkspaceTrigger(null), false)

  const wsItem = candidate({ closest: (s) => (s.includes('menuitem') ? {} : null) })
  assert.equal(menuitemClickStartsWorkspaceSwitch(wsItem), true)
  assert.equal(menuitemClickStartsWorkspaceSwitch(candidate({ closest: () => null })), false)
  assert.equal(menuitemClickStartsWorkspaceSwitch(null), false)

  const source = readFileSync(join(ROOT, 'src', 'client', 'effects', 'permission-sheet.ts'), 'utf8')
  assert.ok(source.includes('data-zen-sheet="workspace"] button[role="menuitem"]'))

  const probe = (session, placeholder) => ({
    currentSessionValue: () => session,
    placeholderOpen: () => placeholder,
  })
  assert.equal(workspaceSwitchSettled(probe('S2', false), 'S1'), true)
  assert.equal(workspaceSwitchSettled(probe('S1', false), 'S1'), false)
  assert.equal(workspaceSwitchSettled(probe('S2', true), 'S1'), false)

  const { decideNewSessionAction } = await import('../src/client-data/new-session.ts?' + Math.random())
  assert.deepEqual(decideNewSessionAction('w1', ['w1', 'w2']), { kind: 'start', workspaceId: 'w1' })
  assert.deepEqual(decideNewSessionAction(undefined, []), { kind: 'start', workspaceId: undefined })
  assert.deepEqual(decideNewSessionAction(undefined, ['only']), { kind: 'start', workspaceId: 'only' })
  assert.deepEqual(decideNewSessionAction(undefined, ['a', 'b']), { kind: 'pick-workspace' })
})

// -- behavioral Fake DOM -------------------------------------------------------

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
      if (selectors.includes('aria-haspopup="menu"') && this.kind === 'wsChip') return this
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
      state.clickListener?.(event)
      return event
    },
    pointerdown(target) {
      state.pointerdownListener?.({ target })
    },
    tapTrigger() { this.click(permTrigger) },
    addMenu() {
      const menu = new FakeElement('menu')
      state.menus.push(menu)
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

test('T70-fix behavior: OPEN click marks, CLOSE click keeps window shut, expired window marks nothing, uninstall marks nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  {
    const sim = await bootSim()
    try {
      sim.tapTrigger()
      assert.equal(sim.addMenu().getAttribute('data-zen-sheet'), 'perm')
    } finally { sim.cleanup() }
  }

  {
    const sim = await bootSim()
    try {
      sim.tapTrigger()
      assert.equal(sim.addMenu().getAttribute('data-zen-sheet'), 'perm')
      sim.tapTrigger()
      assert.equal(sim.addMenu().getAttribute('data-zen-sheet'), null)
    } finally { sim.cleanup() }
  }

  {
    const sim = await bootSim()
    try {
      sim.tapTrigger()
      t.mock.timers.tick(1_600)
      assert.equal(sim.addMenu().getAttribute('data-zen-sheet'), null)
    } finally { sim.cleanup() }
  }

  {
    const sim = await bootSim()
    try {
      sim.unmount()
      sim.tapTrigger()
      assert.equal(sim.addMenu().getAttribute('data-zen-sheet'), null)
    } finally { sim.cleanup() }
  }
})

test('UX-3 behavior: workspace sheet, toggle debounce, switch lock, 1.5s cap under mock timers, uninstall', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  {
    const sim = await bootSim()
    try {
      sim.click(sim.wsChip)
      assert.equal(sim.addMenu().getAttribute('data-zen-sheet'), 'workspace')
      sim.state.menus.length = 0
      sim.click(sim.wsCard)
      assert.equal(sim.addMenu().getAttribute('data-zen-sheet'), 'workspace')
    } finally { sim.cleanup() }
  }

  {
    const sim = await bootSim()
    try {
      sim.pointerdown(sim.wsChip)
      sim.click(sim.wsChip)
      assert.equal(sim.addMenu().getAttribute('data-zen-sheet'), 'workspace')
      sim.pointerdown(sim.wsChip)
      const e = sim.click(sim.wsChip)
      assert.ok(e.prevented && e.stopped)
      assert.equal(sim.addMenu().getAttribute('data-zen-sheet'), null)
      sim.pointerdown(sim.wsChip)
      const e2 = sim.click(sim.wsChip)
      assert.ok(!e2.prevented && !e2.stopped)
    } finally { sim.cleanup() }
  }

  {
    const sim = await bootSim()
    try {
      sim.pointerdown(sim.wsChip)
      sim.click(sim.wsChip)
      sim.addMenu()
      const e = sim.click(sim.permTrigger)
      assert.ok(!e.prevented && !e.stopped)
    } finally { sim.cleanup() }
  }

  {
    const sim = await bootSim({ session: 'S1', placeholder: true })
    try {
      sim.click(sim.el('wsMenuitem'))
      assert.equal(sim.html.getAttribute('data-zen-ws-switching'), '1')
      sim.lockMo().cb([])
      assert.equal(sim.html.getAttribute('data-zen-ws-switching'), '1')
      sim.setSession('S2')
      sim.state.placeholderOpen = false
      sim.lockMo().cb([])
      assert.equal(sim.html.getAttribute('data-zen-ws-switching'), null)
    } finally { sim.cleanup() }
  }

  {
    const sim = await bootSim({ session: 'S1', placeholder: false })
    try {
      sim.click(sim.el('permMenuitem'))
      assert.equal(sim.html.getAttribute('data-zen-ws-switching'), null)
    } finally { sim.cleanup() }
  }

  {
    const sim = await bootSim({ session: 'S1', placeholder: true })
    try {
      sim.click(sim.el('wsMenuitem'))
      assert.equal(sim.html.getAttribute('data-zen-ws-switching'), '1')
      t.mock.timers.tick(1_600)
      assert.equal(sim.html.getAttribute('data-zen-ws-switching'), null)
    } finally { sim.cleanup() }
  }

  {
    const sim = await bootSim({ session: 'S1', placeholder: true })
    try {
      sim.click(sim.el('wsMenuitem'))
      assert.equal(sim.html.getAttribute('data-zen-ws-switching'), '1')
      sim.unmount()
      assert.equal(sim.html.getAttribute('data-zen-ws-switching'), null)
      sim.pointerdown(sim.wsChip)
      const e = sim.click(sim.wsChip)
      assert.ok(!e.prevented && !e.stopped)
      assert.equal(sim.addMenu().getAttribute('data-zen-sheet'), null)
    } finally { sim.cleanup() }
  }
})
