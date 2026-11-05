// UX-2 · the job/subagent header popovers on the phone PWA
//
// Three behaviors are pinned here, each against a measured root cause
// (2026-11-04, DSH 0.2.1):
//
// 1. The overlay's subagent selector must match ONLY the catalog trigger
//    (`button[class$="_trigger"][aria-haspopup="tree"]`). The bare
//    `button[aria-haspopup="tree"]` matched the breadcrumb's parent-session
//    switcher first (`…_switcherTrigger`, also a tree popup), so the pill
//    got the wrong button laid over it. The class-tail suffix is
//    case-sensitive and `_switcherTrigger` does not end in `_trigger`.
// 2. `place()` must pin the trigger AND its outer anchor container
//    (`trigger.parentElement` — the official `rootRef`) to the SAME viewport
//    rect: `useAnchoredPosition` measures the container, and header.css.ts
//    dissolves it with `display: contents`, which leaves its rect all zeros
//    and lands the panel at 12,12 inside the status bar. The inline
//    `display: block !important` beats the stylesheet's
//    `display: contents !important` (style attribute outranks selectors at
//    author-important), so the container regains a box to measure.
//    `release()` must clear both, fully.
// 3. header.css.ts's phone block must shed `container-type` on the titleRow
//    (`container-type: inline-size` = layout containment = the containing
//    block for every descendant `position: fixed`, which shifted every
//    viewport coordinate the overlay writes), hide the breadcrumb's
//    parent-session link and separators (the trigger container excepted),
//    and give the body-portalled `_menu` panels a safe-area + max-width
//    floor.
//
// The DOM half drives the REAL place/release through a fake tree with a
// minimal selector evaluator — just enough for the selectors the overlay
// actually uses (tag / [attr] / [attr="v"] / [attr$="v"] / :not([attr]),
// descendant combinators). If someone loosens the subagent selector back to
// the bare tree popup, the switcher decoy — placed EARLIER in document order
// — gets taken and test 1 fails loudly.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const TAKEN = 'data-zen-overlay'
const PILL_RECT = { left: 300, top: 120, width: 60, height: 28 }

// -- minimal selector engine --------------------------------------------------

function matchesCompound(compound, el) {
  const tokens = compound.match(/^[a-zA-Z][\w-]*|\[[^\]]+\]|:not\(\[[^\]]+\]\)/g) || []
  for (const tok of tokens) {
    if (tok.startsWith(':not(')) {
      const inner = tok.slice(5, -1)
      if (inner.startsWith('[') && inner.slice(1, -1) in el.attrs) return false
    } else if (tok.startsWith('[')) {
      const inner = tok.slice(1, -1)
      if (inner.includes('$=')) {
        const i = inner.indexOf('$=')
        const v = el.attrs[inner.slice(0, i)]
        if (v === undefined || !v.endsWith(inner.slice(i + 2).replace(/"/g, ''))) return false
      } else if (inner.includes('=')) {
        const i = inner.indexOf('=')
        if (el.attrs[inner.slice(0, i)] !== inner.slice(i + 1).replace(/"/g, '')) return false
      } else if (!(inner in el.attrs)) return false
    } else if (tok !== '*' && el.tagName.toLowerCase() !== tok.toLowerCase()) {
      return false
    }
  }
  return true
}

/** Descendant combinators only — every selector the overlay uses. */
function matches(selector, el) {
  const parts = selector.trim().split(/\s+/)
  if (!matchesCompound(parts[parts.length - 1], el)) return false
  let node = el.parent
  for (let i = parts.length - 2; i >= 0; i--) {
    while (node !== null && !matchesCompound(parts[i], node)) node = node.parent
    if (node === null) return false
    node = node.parent
  }
  return true
}

// -- fake DOM -----------------------------------------------------------------

function makeStyle() {
  const store = new Map()
  return {
    setProperty(p, v, important) { store.set(p, important === 'important' ? `${v} !important` : v) },
    get cssText() { return [...store].map(([p, v]) => `${p}: ${v}`).join('; ') },
    set cssText(_) { store.clear() },
    props: store,
  }
}

function makeEl(tag, attrs = {}, parent = null) {
  const el = {
    tagName: tag.toUpperCase(),
    attrs,
    parent,
    parentElement: parent,
    children: [],
    style: makeStyle(),
    getBoundingClientRect: () => ({ ...PILL_RECT, right: 0, bottom: 0 }),
    setAttribute(name, value) { el.attrs[name] = value ?? '' },
    getAttribute(name) { return name in el.attrs ? el.attrs[name] : null },
    hasAttribute(name) { return name in el.attrs },
    removeAttribute(name) { delete el.attrs[name] },
    closest(selectors) {
      let node = el
      while (node !== null) {
        if (matches(selectors, node)) return node
        node = node.parent
      }
      return null
    },
  }
  if (parent !== null) parent.children.push(el)
  return el
}

/** The header tree, with the switcher decoy FIRST in document order — the
 * exact shape that made the bare tree-popup selector grab the wrong button. */
function buildTree() {
  const body = makeEl('body')
  const phase = makeEl('div', { 'data-phase': 'active' }, body)
  const header = makeEl('header', {}, phase)
  const titleRow = makeEl('div', { class: 'KiGsTW_titleRow' }, header)
  const crumbs = makeEl('nav', { class: 'KiGsTW_crumbs' }, titleRow)
  const parentSeg = makeEl('div', { class: 'KiGsTW_crumbSeg' }, crumbs)
  const switcher = makeEl('button', { class: 'KiGsTW_switcherTrigger', 'aria-haspopup': 'tree' }, parentSeg)
  const currentSeg = makeEl('div', { class: 'KiGsTW_crumbSeg' }, crumbs)
  const catalogRoot = makeEl('div', { class: 'ZxQ7_root' }, currentSeg)
  const catalogTrigger = makeEl('button', { class: 'ZxQ7_trigger', 'aria-haspopup': 'tree' }, catalogRoot)
  const actionsSlot = makeEl('div', { 'data-slot': 'conversation.session.header.actions' }, titleRow)
  const jobRoot = makeEl('div', { class: 'Jb3_root' }, actionsSlot)
  const jobTrigger = makeEl('button', { class: 'Jb3_trigger' }, jobRoot)
  const pillbox = makeEl('div', {}, body)
  const subPill = makeEl('button', { 'data-activity-kind': 'subagent' }, pillbox)
  const jobPill = makeEl('button', { 'data-activity-kind': 'job' }, pillbox)
  return { body, header, titleRow, switcher, catalogRoot, catalogTrigger, jobRoot, jobTrigger, subPill, jobPill }
}

async function bootOverlay({ phone }) {
  const tree = buildTree()
  const rafCbs = []
  const listeners = {}
  const selectors = []
  const walk = function* (n) { yield n; for (const c of n.children) yield* walk(c) }
  /* The module captures the media object once — flip `.matches` to simulate
     a width change instead of swapping matchMedia out. */
  const mq = { matches: phone, addEventListener: () => {}, removeEventListener: () => {} }

  globalThis.window = {
    matchMedia: () => mq,
    addEventListener: (type, fn) => { listeners[type] = fn },
    removeEventListener: (type) => { delete listeners[type] },
  }
  globalThis.requestAnimationFrame = (cb) => { rafCbs.push(cb); return rafCbs.length }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.document = {
    body: tree.body,
    querySelector: (s) => { selectors.push(s); for (const n of walk(tree.body)) if (matches(s, n)) return n; return null },
    querySelectorAll: (s) => [...walk(tree.body)].filter((n) => matches(s, n)),
  }

  const mod = await import('../src/client/effects/native-trigger-overlay.ts?' + Math.random())
  let stop
  mod.installNativeTriggerOverlay({ effect: (fn) => { stop = fn() } })
  /* A resize re-arms the module's own schedule() path (the rAF callback
     self-clears, so a second sync needs a fresh schedule first). */
  const raf = () => { listeners.resize?.(); for (const cb of rafCbs.splice(0)) cb() }

  return {
    ...tree,
    mq,
    raf,
    selectors: () => selectors,
    unmount() { stop() },
    cleanup() {
      delete globalThis.window
      delete globalThis.document
      delete globalThis.requestAnimationFrame
      delete globalThis.cancelAnimationFrame
      delete globalThis.MutationObserver
    },
  }
}

// -- 1. the tightened subagent selector ---------------------------------------

const OVERLAY_SRC = readFileSync(join(ROOT, 'src', 'client', 'effects', 'native-trigger-overlay.ts'), 'utf8')
const HEADER_TSX = readFileSync(join(ROOT, 'src', 'client', 'MobileSessionHeader.tsx'), 'utf8')
const HEADER_CSS = readFileSync(join(ROOT, 'src', 'client', 'styles', 'header.css.ts'), 'utf8')
const LAYOUT_CSS = readFileSync(join(ROOT, 'src', 'client', 'styles', 'layout.css.ts'), 'utf8')
const phone = HEADER_CSS.slice(HEADER_CSS.indexOf('@media (max-width: 767px)'))

test('both the overlay and the fallback check use the class-tail tree selector', () => {
  const selector = 'button[class$="_trigger"][aria-haspopup="tree"]'
  assert.ok(OVERLAY_SRC.includes(selector), 'overlay PAIRS must narrow by the _trigger class tail')
  assert.ok(HEADER_TSX.includes(selector), 'the pill fallback check must use the same selector')
})

test('the overlay takes the catalog trigger, never the breadcrumb switcher', async () => {
  const sim = await bootOverlay({ phone: true })
  try {
    sim.raf()
    assert.ok(sim.catalogTrigger.hasAttribute(TAKEN), 'the catalog trigger is pinned over the pill')
    assert.equal(sim.switcher.hasAttribute(TAKEN), false, 'the parent-session switcher (also tree, earlier in DOM) stays untouched')
    assert.equal(sim.switcher.style.cssText, '', 'the switcher was never styled')
    assert.ok(sim.jobTrigger.hasAttribute(TAKEN), 'the jobs trigger is still paired by its no-popup selector')
    assert.ok(
      sim.selectors().some((s) => s.includes('[class$="_trigger"]') && s.includes('[aria-haspopup="tree"]')),
      'the subagent query was narrowed by the trigger class tail',
    )
  } finally { sim.cleanup() }
})

// -- 2. place/release pin and restore the anchor container --------------------

function assertPinned(el, label) {
  const s = el.style.props
  assert.equal(s.get('position'), 'fixed !important', `${label} position`)
  assert.equal(s.get('left'), `${PILL_RECT.left}px !important`, `${label} left`)
  assert.equal(s.get('top'), `${PILL_RECT.top}px !important`, `${label} top`)
  assert.equal(s.get('width'), `${PILL_RECT.width}px !important`, `${label} width`)
  assert.equal(s.get('height'), `${PILL_RECT.height}px !important`, `${label} height`)
}

test('place() pins trigger AND anchor container to the pill rect', async () => {
  const sim = await bootOverlay({ phone: true })
  try {
    sim.raf()
    for (const [trigger, anchor] of [[sim.catalogTrigger, sim.catalogRoot], [sim.jobTrigger, sim.jobRoot]]) {
      assert.equal(trigger.parentElement, anchor, `${trigger.attrs.class} rootRef is the parent div`)
      assertPinned(trigger, trigger.attrs.class)
      assertPinned(anchor, `${anchor.attrs.class} (anchor)`)
      assert.equal(anchor.style.props.get('display'), 'block !important', 'anchor display beats the stylesheet contents dissolve')
      assert.equal(anchor.style.props.get('z-index'), '3 !important', 'anchor fixed stacking context must sit above header-activity (z-index: 1)')
      assert.equal(trigger.style.props.get('opacity'), '0 !important', 'trigger stays invisible')
      assert.equal(anchor.style.props.get('opacity'), undefined, 'the anchor needs no own opacity — its content is the hidden trigger')
    }
  } finally { sim.cleanup() }
})

test('release() clears both the trigger and the anchor container', async () => {
  const sim = await bootOverlay({ phone: true })
  try {
    sim.raf()
    // The real release path: the width gate goes desktop (or the pill is
    // gone) and sync hands the elements back untouched.
    sim.mq.matches = false
    sim.raf()
    for (const el of [sim.catalogTrigger, sim.catalogRoot, sim.jobTrigger, sim.jobRoot]) {
      assert.equal(el.style.cssText, '', `${el.attrs.class} fully restored`)
      assert.equal(el.hasAttribute(TAKEN), false, `${el.attrs.class} unmarked`)
    }
    assert.equal(sim.switcher.style.cssText, '', 'the switcher was never touched in the first place')
  } finally { sim.cleanup() }
})

test('unmount releases everything the overlay marked', async () => {
  const sim = await bootOverlay({ phone: true })
  try {
    sim.raf()
    sim.unmount()
    for (const el of [sim.catalogTrigger, sim.catalogRoot, sim.jobTrigger, sim.jobRoot]) {
      assert.equal(el.style.cssText, '')
      assert.equal(el.hasAttribute(TAKEN), false)
    }
  } finally { sim.cleanup() }
})

test('the desktop width never pins anything', async () => {
  const sim = await bootOverlay({ phone: false })
  try {
    sim.raf()
    for (const el of [sim.catalogTrigger, sim.catalogRoot, sim.jobTrigger, sim.jobRoot]) {
      assert.equal(el.hasAttribute(TAKEN), false)
      assert.equal(el.style.cssText, '')
    }
  } finally { sim.cleanup() }
})

// -- 3. the CSS half ----------------------------------------------------------

test('the titleRow sheds container-type inside the phone block', () => {
  assert.ok(phone.length > 0, 'header.css.ts lost its phone media query')
  const rules = [...phone.matchAll(/\[data-phase\] header \[class\$="_titleRow"\]\s*\{([^}]*)\}/g)]
  assert.ok(
    rules.some(([, body]) => /container-type:\s*normal\s*!important/.test(body)),
    'container-type: inline-size makes titleRow the containing block for every descendant position:fixed',
  )
})

test('the breadcrumb parent link and separators hide; the trigger container stays', () => {
  assert.match(
    phone,
    /\[data-phase\] header \[class\$="_crumbSeg"\]:not\(:last-child\)\s*\{[^}]*display:\s*none\s*!important/,
    'every crumb seg but the current one is hidden (0.2.1 parent crumbs own a tree popup)',
  )
  assert.match(
    phone,
    /\[data-phase\] header \[class\$="_crumbSep"\]\s*\{[^}]*display:\s*none\s*!important/,
    'the dangling separator before the current title is hidden',
  )
})

test('body-portalled header menus get a safe-area + max-width floor', () => {
  const rule = /\bbody > \[class\$="_menu"\]:not\(\[id\$="-menu"\]\)\s*\{([^}]*)\}/.exec(phone)
  assert.ok(rule, 'the panel floor rule is missing from the phone block')
  assert.match(rule[1], /max-width:\s*calc\(100vw - 24px\)\s*!important/, 'narrow phones must not clip the panel')
  assert.match(rule[1], /env\(safe-area-inset-top/, 'the panel must stay inside the top safe area')
  assert.match(rule[1], /env\(safe-area-inset-bottom/, 'the panel must clear the home indicator')
})

test('back button orders before agent-team trigger and agent-team label stays hidden on phone', () => {
  const backRule = /(?:^|\n)\s*\[data-mobile-nav="header-back"\]\s*\{([^}]*)\}/.exec(phone)
  assert.ok(backRule, 'header-back rule missing in phone block')
  assert.match(backRule[1], /order:\s*-1\b/, 'header-back must sit to the left of [data-team-action]')
  assert.match(
    phone,
    /\[data-phase\] header \[data-team-action\] \[class\$="_triggerLabel"\]\s*\{[^}]*display:\s*none\s*!important/,
    'shedding container-type on _titleRow disables the host container query, so hide _triggerLabel explicitly',
  )
})

test('right sidebar guide page scrolls vertically without clipping leading entries', () => {
  const guideRule = /\[data-sidebar-right-guide\]\s*\{([^}]*)\}/.exec(LAYOUT_CSS)
  assert.ok(guideRule, 'missing [data-sidebar-right-guide] rule in layout.css.ts')
  assert.match(guideRule[1], /overflow-y:\s*auto\s*!important/, 'guide must scroll when tab entries overflow')
  assert.match(guideRule[1], /justify-content:\s*flex-start\s*!important/, 'replace center alignment so top entries are not pushed above y=0')
  assert.match(LAYOUT_CSS, /\[data-sidebar-right-guide\] > :first-child\s*\{[^}]*margin-top:\s*auto\s*!important/, 'short guide lists stay centered via auto margins')
})

test('DSH 0.2.2-rc.1 AppFrame: centerCol is pinned to column 1 and drawerMask/leadingSeat are handled', () => {
  const { HOME_CSS } = require('../src/client/styles/home.css.ts')
  const { CHIPS_CSS } = require('../src/client/styles/chips.css.ts')
  assert.match(
    LAYOUT_CSS,
    /\[data-mobile-nav="frame"\] > \[class\$="_centerCol"\]\s*\{[^}]*grid-area:\s*1\s*\/\s*1\s*!important/,
    '0.2.2-rc.1 sets .centerCol { grid-area: 1/2 }, which lands in our 0px 2nd track unless overridden to 1/1',
  )
  assert.match(
    LAYOUT_CSS,
    /\[data-mobile-nav="frame"\] > \[data-sidebar-mask\]\s*\{[^}]*display:\s*none\s*!important/,
    '0.2.2-rc.1 inserts [data-sidebar-mask] before sidebarCol when < 768px',
  )
  assert.match(
    HOME_CSS,
    /\[data-mobile-nav="frame"\] > \[class\$="_sidebarCol"\][\s\S]*?\[data-mobile-nav="frame"\] > \[data-shell-leading\]\s*\{[^}]*display:\s*none\s*!important/,
    'phone shell must hide [class$="_sidebarCol"] and [data-shell-leading] even when [data-sidebar-mask] is :first-child',
  )
  assert.match(
    CHIPS_CSS,
    /\[data-mobile-nav="frame"\] > \[class\$="_sidebarCol"\]:has\(\[aria-modal="true"\][\s\S]*?visibility:\s*visible\s*!important/,
    'chips portal fix must match [class$="_sidebarCol"] and override 0.2.2-rc.1 visibility:hidden',
  )
})
