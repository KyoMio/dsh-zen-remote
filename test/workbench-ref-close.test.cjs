const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')
const effect = read('src', 'client', 'effects', 'workbench-ref-close.ts')
const index = read('src', 'client', 'index.tsx')
const gestures = read('src', 'client', 'effects', 'gestures.ts')

/*
 * Phone: an @-file tap in the workbench closes the panel (real-device
 * report, 2026-08-26). The panel is full-screen over the conversation, so
 * the draft change the tap makes is invisible — closing the panel is the
 * feedback. These pin the load-bearing choices, each of which fails
 * silently if lost.
 */

test('the effect is registered', () => {
  assert.match(index, /installWorkbenchRefClose\(ctx\)/, 'never installed — the tap does nothing again')
})

test('the listener is capture-phase, or the ref button silences it', () => {
  // The @ button's own handler calls stopPropagation() (its row would open
  // the file otherwise), so a bubble listener never hears the tap.
  assert.match(effect, /addEventListener\('click', onClick, true\)/, 'must listen in capture phase')
  assert.match(effect, /removeEventListener\('click', onClick, true\)/, 'and remove the SAME phase, or the listener leaks')
})

test('the close waits for the reference to land, and re-checks open state', () => {
  // The button's handler writes the draft at target phase, inside the same
  // dispatch — the deferral is what orders "mention lands" before "panel
  // closes". The re-check matters because the toggle is a toggle: clicking
  // it against an already-closed panel would reopen it.
  assert.match(effect, /setTimeout\(/, 'the close must be deferred past the tap\'s own handler')
  assert.match(effect, /document\.querySelector\(PANEL_OPEN_SELECTOR\) === null\) return/, 'a closed panel must not be toggled back open')
})

test('phone-gated per tap, desktop untouched', () => {
  assert.match(effect, /max-width: 767px/, 'same breakpoint as every phone-only effect')
  assert.match(effect, /if \(!phone\.matches\) return/, 'checked per tap — a mid-session resize must not leave a stale arm')
})

test('the anchors match the ones the rest of the plugin already trusts', () => {
  // One convention, one place to update if better-sidebar renames things.
  assert.match(effect, /\[data-dsh-better-sidebar\] button\[class\$="_toggleButton"\]/, 'toggle anchor drifted from gestures.ts')
  assert.ok(gestures.includes('[data-dsh-better-sidebar] button[class$="_toggleButton"]'), 'gestures.ts moved off the shared toggle anchor — update both or extract it')
  assert.match(effect, /\[data-dsh-better-sidebar\] \[class\$="_panel"\]/, 'open-state read drifted from the shared convention')
})
