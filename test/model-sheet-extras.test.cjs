const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const composer = read('src', 'client', 'styles', 'composer.css.ts')
const effect = read('src', 'client', 'effects', 'model-sheet-extras.ts')
const index = read('src', 'client', 'index.tsx')

/*
 * The composer row is one nowrap line whose only elastic item is the model
 * pill, so every third-party entry in `conversation.input.right` is paid for
 * out of the model name. effects/model-sheet-extras.ts parks that container
 * inside the model sheet while the sheet is open — the speed chip and the
 * vision toggle become rows next to 模型 and 推理等级 — and puts it back on
 * close.
 *
 * Both halves have to stay in step. Hiding without parking loses the controls
 * outright; parking without restoring leaves them inside a sheet that unmounts
 * on close, so they vanish from the page while their React roots go on
 * updating detached nodes. Neither failure raises anything.
 */
const strip = (block) => block.replace(/\/\*[\s\S]*?\*\//g, '')
const section = composer.slice(
  composer.indexOf('--- 4a. third-party composer entries'),
  composer.indexOf('--- 4b.'),
)
assert.ok(section.length > 0, 'the 4a section must exist')

test('the container is hidden in the row only while it is NOT parked', () => {
  // The :not() is what lets one element have two homes: gone from the row,
  // styled as sheet rows once the effect moves it.
  assert.match(
    strip(section),
    /\[data-slot="conversation\.input\.right"\]:not\(\[data-zen-sheet-extras\]\)\s*\{\s*display: none !important;/,
  )
})

test('parked controls become full-width 48px rows, left aligned like the sheet cells', () => {
  const decls = strip(section)
  assert.match(decls, /min-height: 48px !important;/)
  assert.match(decls, /width: 100% !important;/)
  assert.match(decls, /text-align: left !important;/)
})

test('the speed chip\'s own menu escapes the sheet\'s overflow:hidden', () => {
  // It anchors bottom:100% to its trigger; inside a clipped sheet that is cut
  // off. position:fixed leaves the clip behind, the same escape section 4 uses.
  const menuRule = /\[data-zen-sheet-extras\] \[role="menu"\] \{([\s\S]*?)\n  \}/.exec(section)
  assert.ok(menuRule, 'the parked-menu rule must exist')
  assert.match(strip(menuRule[1]), /position: fixed !important;/)
  // Above the model sheet it sits on (60) and below the info sheet (70).
  const z = Number(/z-index:\s*(\d+)/.exec(strip(menuRule[1]))?.[1])
  assert.ok(z > 60 && z < 70, `parked menu z-index ${z} must sit between the model sheet (60) and the info sheet (70)`)
})

test('phone only — the desktop composer keeps every control in the row', () => {
  const phone = composer.indexOf('@media (max-width: 767px) {')
  const tablet = composer.indexOf('@media (min-width: 768px) {')
  const start = composer.indexOf('--- 4a. third-party composer entries')
  assert.ok(phone !== -1 && tablet !== -1, 'both breakpoint blocks must exist')
  assert.ok(start > phone && start < tablet, 'the 4a section escaped the phone breakpoint')
})

test('the effect restores the container instead of letting the sheet take it', () => {
  // The sheet unmounts on close; without this the controls go with it.
  assert.match(effect, /const unpark = \(\)/)
  assert.match(effect, /return \(\) => \{[\s\S]*unpark\(\)/, 'teardown must unpark')
  // Held as a reference, not re-queried: once the menu detaches, a document
  // query can no longer find the node.
  assert.match(effect, /let parked: \{ node: Element/)
})

test('the effect is actually installed', () => {
  assert.match(index, /import \{ installModelSheetExtras \}/)
  assert.match(index, /^\s*installModelSheetExtras\(ctx\)/m)
})
