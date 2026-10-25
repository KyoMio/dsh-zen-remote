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
 * effects/model-sheet-extras.ts (post-#30) collects those controls behind a
 * `⋯` pill in the dock rail and, while the sheet is open, moves the REAL
 * nodes into the [data-zen-sheet-extras] list of its own
 * composer-more-layer bottom sheet, putting each one back through its
 * Comment anchor on close.
 *
 * Nothing depends on the official model pill any more: the pre-#30 design
 * parked into the model menu, which never opens on a replaced model slot
 * (…codex-ui) or a subagent session (no pill at all), leaving those
 * controls squeezed into the row or hidden with nowhere to open.
 *
 * Both halves have to stay in step. Hiding without parking loses the
 * controls outright; parking without restoring leaves them inside a sheet
 * that unmounts on close, so they vanish from the page while their React
 * roots go on updating detached nodes. Neither failure raises anything.
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
  // from the sheet in exactly the cases where the effect declines to act —
  // reachable from nowhere (caught in review, 2026-09-06).
  const decls = strip(section)
  assert.match(
    decls,
    /\[data-slot="conversation\.input\.right"\]\[data-zen-sheet-extras\],\s*\[data-zen-composer-extra\]:not\(\[data-zen-composer-extra="open"\]\)\s*\{\s*display: none !important;/,
  )
  assert.doesNotMatch(decls, /:not\(\[data-zen-sheet-extras\]\)/)
})

test('the ⋯ sheet works without the official model pill', () => {
  // Replaced model slots and subagent sessions have no pill and no model
  // menu; the sheet is this plugin's own layer, so the model-seat
  // dependency must be gone for good.
  assert.doesNotMatch(effect, /MODEL_SEAT_SELECTOR/)
  assert.match(effect, /composer-more-sheet/)
})

test('nothing is collected when the only control is a lone vision toggle', () => {
  // The vision toggle alone is a 28px icon the row fits; moving it on its
  // own would cost a tap to buy width nobody needed. "Is or contains" —
  // some plugins wrap their toggle in a positioning node.
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

test('parked controls become full-width 48px rows, left aligned like the sheet cells', () => {
  const decls = strip(section)
  assert.match(decls, /min-height: 48px !important;/)
  assert.match(decls, /width: 100% !important;/)
  assert.match(decls, /text-align: left !important;/)
})

test("the speed chip's own menu escapes the sheet's overflow:hidden", () => {
  // It anchors bottom:100% to its trigger; inside a clipped sheet that is cut
  // off. position:fixed leaves the clip behind, the same escape section 4 uses.
  const menuRule = /\[data-zen-sheet-extras\] \[role="menu"\] \{([\s\S]*?)\n  \}/.exec(section)
  assert.ok(menuRule, 'the parked-menu rule must exist')
  assert.match(strip(menuRule[1]), /position: fixed !important;/)
  // Above the composer-more sheet it sits on (60) and below the info sheet (70).
  const z = Number(/z-index:\s*(\d+)/.exec(strip(menuRule[1]))?.[1])
  assert.ok(z > 60 && z < 70, `parked menu z-index ${z} must sit between the composer-more sheet (60) and the info sheet (70)`)
})

test('phone only — the desktop composer keeps every control in the row', () => {
  const phone = composer.indexOf('@media (max-width: 767px) {')
  const tablet = composer.indexOf('@media (min-width: 768px) {')
  const start = composer.indexOf('--- 4a. third-party composer entries')
  assert.ok(phone !== -1 && tablet !== -1, 'both breakpoint blocks must exist')
  assert.ok(start > phone && start < tablet, 'the 4a section escaped the phone breakpoint')
})

test('the effect restores nodes via their Comment anchors instead of losing them', () => {
  // The sheet unmounts on close; without this the controls go with it.
  assert.match(effect, /const unparkAll = \(\)/)
  assert.match(effect, /createComment\('zen-composer-extra'\)/)
  assert.match(effect, /placeholder\.parentNode\.insertBefore\(node, placeholder\)/)
  // Teardown goes through releaseAll(), which unparks and drops every marker
  // — so an unloaded plugin leaves the host's own row exactly as it found it.
  assert.match(effect, /const releaseAll = [\s\S]{0,80}close\(\)/)
  assert.match(effect, /return \(\) => \{[\s\S]*releaseAll\(\)/, 'teardown must release')
  // Held as references, not re-queried: once a node is detached, a document
  // query can no longer find it.
  assert.match(effect, /let parked: Array<\{ node: Element, placeholder: Comment \}>/)
})

test('the sheet is wired into the Android back-gesture stack', () => {
  assert.match(effect, /pushLayer\(\{ id: LAYER_ID, close \}\)/)
  assert.match(effect, /popLayer\(LAYER_ID\)/)
  assert.match(effect, /hasLayer\(LAYER_ID\)/)
})

test('the trigger lives in the dock rail; the layer beats its every-width default hide', () => {
  assert.match(effect, /setAttribute\('data-mobile-nav', 'composer-more'\)/)
  assert.match(effect, /data-zen-synthetic-dock/)
  assert.match(composer, /\[data-slot="conversation\.input\.dock"\] > \[data-mobile-nav="composer-more"\] \{/)
  assert.match(composer, /\[data-mobile-nav="composer-more-layer"\] \{[^}]*display: block !important;/)
})

test('the dock lookup excludes the synthetic rail itself', () => {
  // The synthetic rail is bar's SIBLING carrying the same data-slot. An
  // unqualified query would find it as the "real" dock on the next sync,
  // delete it as stale, recreate it right after — the observer would
  // oscillate forever between the two states.
  assert.match(
    effect,
    /querySelector\('\[data-slot="conversation\.input\.dock"\]:not\(\[data-zen-synthetic-dock\]\)'\)/,
  )
})

test('the composer-more sheet joins the drag/edge-back gesture family', () => {
  assert.match(gestures, /SHEET_SELECTOR = '[^']*\[data-mobile-nav="composer-more-sheet"\]'/)
})

test('the jump-to-bottom button hides while the ⋯ sheet is open', () => {
  const section4b = composer.slice(composer.indexOf('--- 4b.'), composer.indexOf('--- 5.'))
  assert.ok(section4b.length > 0, 'the 4b section must exist')
  assert.match(strip(section4b), /body:has\(\[data-mobile-nav="composer-more-layer"\]\) \[data-chat-flow\] \+ div/)
})

test('the trigger is not in the dock wrap gate — it never takes a line of its own', () => {
  // It is an inline pill sharing the scrolling rail; only full-width status
  // rows belong in the wrap gate (see composer-dock-lines.test.cjs).
  const gate = /\[data-slot="conversation\.input\.dock"\]:has\(([^)]*)\) \{\s*flex-wrap: wrap/.exec(composer)
  assert.ok(gate, 'the wrap gate must exist')
  assert.ok(!gate[1].includes('composer-more'))
})

test('the effect is actually installed', () => {
  assert.match(index, /import \{ installModelSheetExtras \}/)
  assert.match(index, /^\s*installModelSheetExtras\(ctx\)/m)
})
