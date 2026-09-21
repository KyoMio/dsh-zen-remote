const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')
const effect = read('src', 'client', 'effects', 'workbench-ref-close.ts')
const index = read('src', 'client', 'index.tsx')
const gestures = read('src', 'client', 'effects', 'gestures.ts')
const header = read('src', 'client', 'MobileSessionHeader.tsx')
const panels = read('src', 'client', 'sidebar-panels.ts')

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
  assert.match(effect, /setTimeout\(\(\) => \{ closeOpenSidebar\(\) \}, 0\)/, 'the close must be deferred past the tap\'s own handler')
  // closeOpenSidebar is the re-check: it reads the open state when it runs
  // and never clicks a toggle against a closed panel.
  assert.match(panels, /if \(officialSidebarOpen\(\)\)[\s\S]*?OFFICIAL_COLLAPSE[\s\S]*?if \(betterSidebarOpen\(\)\)[\s\S]*?BETTER_TOGGLE/, 'closeOpenSidebar must read open state before clicking either control')
})

test('phone-gated per tap, desktop untouched', () => {
  assert.match(effect, /max-width: 767px/, 'same breakpoint as every phone-only effect')
  assert.match(effect, /if \(!phone\.matches\) return/, 'checked per tap — a mid-session resize must not leave a stale arm')
})

test('the anchors live in one module, shared by every caller', () => {
  // One convention, one place to update if better-sidebar or the host
  // renames things: sidebar-panels.ts owns the selectors; the header
  // button, the edge swipe-back and this effect all import from it.
  assert.match(panels, /BETTER_TOGGLE = '\[data-dsh-better-sidebar\] button\[class\$="_toggleButton"\]'/, 'legacy toggle anchor drifted')
  assert.match(panels, /BETTER_PANEL_OPEN = '\[data-dsh-better-sidebar\] \[class\$="_panel"\]'/, 'legacy open-state read drifted')
  assert.match(panels, /OFFICIAL_PANEL_OPEN = '\[data-sidebar-right-panel\]\[data-sidebar-right-open\]'/, 'official open-state read drifted')
  assert.match(panels, /OFFICIAL_COLLAPSE = '\[data-sidebar-right-toggle\]'/, 'official collapse anchor drifted')
  for (const [name, src] of [['workbench-ref-close.ts', effect], ['gestures.ts', gestures], ['MobileSessionHeader.tsx', header]]) {
    assert.match(src, /from '\.\.?\/sidebar-panels\.ts'/, `${name} no longer imports the shared anchors`)
    assert.doesNotMatch(src, /'\[data-dsh-better-sidebar\] button\[class\$="_toggleButton"\]'|'\[data-sidebar-right-toggle\]'/, `${name} spells a sidebar anchor out again — use sidebar-panels.ts`)
  }
  // The explorer's @ button is looked up under BOTH hosts: better-sidebar
  // 0.19+ renders the tree inside the native right panel, older versions
  // inside their own root.
  assert.match(effect, /\$\{OFFICIAL_PANEL\} \[class\$="_explorerRef"\], \$\{BETTER_ROOT\} \[class\$="_explorerRef"\]/, 'REF_SELECTOR must cover the native panel and the legacy root')
})
