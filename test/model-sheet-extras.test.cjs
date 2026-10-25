const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const composer = read('src', 'client', 'styles', 'composer.css.ts')
const effect = read('src', 'client', 'effects', 'model-sheet-extras.ts')
const gestures = read('src', 'client', 'effects', 'gestures.ts')
const index = read('src', 'client', 'index.tsx')

/*
 * The composer row is one nowrap line whose only elastic item is the model
 * pill, so every secondary control in it is paid for out of the model name.
 * effects/model-sheet-extras.ts (post-#30, chip-strip revision) collects
 * those controls and moves the REAL nodes into a 26px horizontally
 * scrollable strip at the head of the dock rail above the card — always
 * visible, one tap, no sheet and no history-nav layer in between. Each
 * parked node keeps a Comment anchor at its original spot so `unparkAll`
 * can put it back exactly where React left it.
 *
 * Nothing depends on the official model pill: replaced model slots
 * (…codex-ui) and subagent sessions (no pill at all) relocate exactly like
 * everyone else.
 *
 * Both halves have to stay in step. Hiding without parking loses the
 * controls outright; parking without restoring leaves them inside a strip
 * that unmounts, so they vanish from the page while their React roots go on
 * updating detached nodes. Neither failure raises anything.
 */
const strip = (block) => block.replace(/\/\*[\s\S]*?\*\//g, '')
const section = composer.slice(
  composer.indexOf('--- 4a. third-party composer entries'),
  composer.indexOf('--- 4b.'),
)
assert.ok(section.length > 0, 'the 4a section must exist')

test('the row hide is opt-in: only marked nodes disappear, and parked ones show', () => {
  // Two markers, both written by the effect. Keying the hide off "not
  // currently parked" instead would hide the controls in the row AND absent
  // from the strip in exactly the cases where the effect declines to act —
  // reachable from nowhere (caught in review, 2026-09-06).
  const decls = strip(section)
  assert.match(
    decls,
    /\[data-slot="conversation\.input\.right"\]\[data-zen-sheet-extras\],\s*\[data-zen-composer-extra\]:not\(\[data-zen-composer-extra="open"\]\)\s*\{\s*display: none !important;/,
  )
  assert.doesNotMatch(decls, /:not\(\[data-zen-sheet-extras\]\)/)
})

test('the chip strip works without the official model pill, and no sheet remains', () => {
  assert.doesNotMatch(effect, /MODEL_SEAT_SELECTOR/)
  assert.match(effect, /composer-chips/)
  // The ⋯-sheet detour (trigger, mask, layer, history-nav) is gone for good.
  assert.doesNotMatch(effect, /composer-more|history-nav|pushLayer|popLayer/)
})

test('nothing is collected when the only control is a lone vision toggle', () => {
  // The vision toggle alone is a 28px icon the row fits; relocating it on
  // its own would buy width nobody needed. "Is or contains" — some plugins
  // wrap their toggle in a positioning node.
  assert.match(effect, /function worthMoving/)
  assert.match(effect, /controls\.length === 0/)
  assert.match(effect, /controls\.length === 1/)
  assert.match(effect, /child\.matches\(VISION_SELECTOR\)/)
  assert.match(effect, /querySelector\(VISION_SELECTOR\)/)
})

test('the whitelist scans every position a third party can inject into', () => {
  for (const fragment of [
    '[data-slot="conversation.input.right"] > *:not([data-mobile-nav])',
    '[data-slot="conversation.input.left"] > *:not([data-mobile-nav])',
    '[class$="_tools"] > *:not(button[class$="_add"])',
    '[class$="_standardControls"] > *:not([data-slot="conversation.input.model"])',
    '[class$="_trailing"] > *:not([class$="_standardControls"])',
    '[class$="_row"] > *:not([class$="_tools"])',
  ]) {
    assert.ok(effect.includes(fragment), `the whitelist is missing ${fragment}`)
  }
})

test('the strip is a 26px single-line sideways scroller at the rail head', () => {
  const rule = /\[data-slot="conversation\.input\.dock"\] > \[data-mobile-nav="composer-chips"\] \{([\s\S]*?)\n  \}/.exec(section)
  assert.ok(rule, 'the strip rule must exist')
  const decls = strip(rule[1])
  assert.match(decls, /flex-flow: row nowrap !important;/)
  assert.match(decls, /overflow-x: auto !important;/)
  assert.match(decls, /order: 0 !important;/)
  assert.match(decls, /max-height: 26px !important;/)
  // It may shrink and scroll, never wrap onto a second line.
  assert.match(decls, /flex: 0 1 auto !important;/)
  assert.match(decls, /min-width: 0 !important;/)
})

test('parked controls shrink to 26px pills inside the strip', () => {
  const decls = strip(section)
  assert.match(decls, /\[data-mobile-nav="composer-chips"\] button \{[^}]*height: 26px !important;/)
  assert.match(decls, /\[data-mobile-nav="composer-chips"\] button \{[^}]*border-radius: 999px !important;/)
  // The full-width 48px sheet rows are gone with the sheet.
  assert.doesNotMatch(decls, /\[data-zen-sheet-extras\] button \{/)
})

test("the speed chip's own menu escapes the strip's overflow clip", () => {
  // It anchors bottom:100% to its trigger; inside a sideways scroller that
  // is cut off. position:fixed leaves the clip behind, the same escape
  // section 4 uses for the host's two menus.
  const menuRule = /\[data-zen-sheet-extras\] \[role="menu"\] \{([\s\S]*?)\n  \}/.exec(section)
  assert.ok(menuRule, 'the parked-menu rule must exist')
  assert.match(strip(menuRule[1]), /position: fixed !important;/)
  // Above the raised seat (60) and below the info sheet (70).
  const z = Number(/z-index:\s*(\d+)/.exec(strip(menuRule[1]))?.[1])
  assert.ok(z > 60 && z < 70, `parked menu z-index ${z} must sit between the raised seat (60) and the info sheet (70)`)
  // The seat carries the strip, so it must be lifted while a parked menu is
  // open — the fixed menu would otherwise fight a lower stacking context.
  assert.match(strip(section), /\[class\$="_composerSeat"\]:has\(\[data-zen-sheet-extras\] \[role="menu"\]\)/)
})

test('phone only — the desktop composer keeps every control in the row', () => {
  const phone = composer.indexOf('@media (max-width: 767px) {')
  const tablet = composer.indexOf('@media (min-width: 768px) {')
  const start = composer.indexOf('--- 4a. third-party composer entries')
  assert.ok(phone !== -1 && tablet !== -1, 'both breakpoint blocks must exist')
  assert.ok(start > phone && start < tablet, 'the 4a section escaped the phone breakpoint')
})

test('the effect restores nodes via their Comment anchors instead of losing them', () => {
  // The strip unmounts on release; without this the controls go with it.
  assert.match(effect, /const unparkAll = \(\)/)
  assert.match(effect, /createComment\('zen-composer-extra'\)/)
  assert.match(effect, /placeholder\.parentNode\.insertBefore\(node, placeholder\)/)
  // Released nodes lose the marker entirely — an unmarked control is the
  // host's own business again.
  assert.match(effect, /unparkAll[\s\S]{0,400}removeAttribute\(EXTRA\)/)
  // Teardown goes through releaseAll(), which unparks and drops every marker
  // — so an unloaded plugin leaves the host's own row exactly as it found it.
  assert.match(effect, /const releaseAll = [\s\S]{0,40}unparkAll\(\)/)
  assert.match(effect, /return \(\) => \{[\s\S]*releaseAll\(\)/, 'teardown must release')
  // Held as references, not re-queried: once a node is detached, a document
  // query can no longer find it.
  assert.match(effect, /let parked: Array<\{ node: Element, placeholder: Comment \}>/)
})

test('the dock lookup excludes the synthetic rail itself', () => {
  // The synthetic rail is bar's SIBLING carrying the same data-slot. An
  // unqualified query would find it as the "real" dock on the next sync,
  // delete it as stale, recreate it right after — the observer would
  // oscillate forever.
  assert.match(
    effect,
    /querySelector\('\[data-slot="conversation\.input\.dock"\]:not\(\[data-zen-synthetic-dock\]\)'\)/,
  )
})

test('the gestures family is back to its two sheets', () => {
  // The strip is not a sheet: drag-to-dismiss and edge-back never applied.
  assert.match(gestures, /SHEET_SELECTOR = '\[data-mobile-nav="info-sheet"\], \[data-mobile-nav="home-sheet"\]'/)
  assert.doesNotMatch(gestures, /composer-more/)
})

test('the jump-to-bottom button hides while a parked menu is open', () => {
  const section4b = composer.slice(composer.indexOf('--- 4b.'), composer.indexOf('--- 5.'))
  assert.ok(section4b.length > 0, 'the 4b section must exist')
  assert.match(strip(section4b), /body:has\(\[data-zen-sheet-extras\] \[role="menu"\]\) \[data-chat-flow\] \+ div/)
  assert.doesNotMatch(composer, /composer-more/)
})

test('the strip is not in the dock wrap gate — it never takes a line of its own', () => {
  // It is the rail's own first pill line; only full-width status rows belong
  // in the wrap gate (see composer-dock-lines.test.cjs).
  const gate = /\[data-slot="conversation\.input\.dock"\]:has\(([^)]*)\) \{\s*flex-wrap: wrap/.exec(composer)
  assert.ok(gate, 'the wrap gate must exist')
  assert.ok(!gate[1].includes('composer-chips'))
})

test('the effect is actually installed', () => {
  assert.match(index, /import \{ installModelSheetExtras \}/)
  assert.match(index, /^\s*installModelSheetExtras\(ctx\)/m)
})
