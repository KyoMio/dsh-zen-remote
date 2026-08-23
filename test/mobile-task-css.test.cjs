const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')
const headerCss = read('src', 'client', 'styles', 'header.css.ts')
const headerTsx = read('src', 'client', 'MobileSessionHeader.tsx')

/*
 * The native background-task / subagent header entries are neither shown
 * nor removed on phone: they are parked as zero-width invisible anchors at
 * the right end of the view-switch band, with their own triggers hidden.
 * The plugin's activity pill is the visible control and forwards the tap,
 * so the official popover still opens — the phone gets the official list,
 * not a substitute.
 *
 * Both extremes were tried and both broke (measured live at 375px,
 * 2026-08-20): shown as-is each entry is ~103px against a 92px grid column
 * and overflowed across the centred title; display:none'd, the popover is a
 * child of the root and disappeared with it, leaving the pill opening the
 * info card instead of the real list.
 */
test('CSS never re-arms a size or pointer-events on the official trigger', () => {
  // The overlay owns the trigger's geometry at runtime. A stylesheet rule that
  // sized it, hid it, or set pointer-events would take the tap target away —
  // which is exactly how the pill went dead once already.
  const rules = headerCss.match(/> \* > button\[class\$="_trigger"\][\s\S]*?\}/g) || []
  for (const r of rules) {
    assert.doesNotMatch(r, /pointer-events/, 'the overlay needs the trigger tappable')
    assert.doesNotMatch(r, /display:\s*none/, 'a hidden trigger cannot receive a real tap')
  }
})

test('the overlay lays the official trigger over the pill instead of scripting it', () => {
  const overlay = read('src', 'client', 'effects', 'native-trigger-overlay.ts')
  // Strip comments first — the file deliberately explains why .click() is not
  // used, and matching that prose would be a false positive.
  const code = overlay.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  // Real tap on the real element: 0.1.1 ignores .click() and synthetic
  // pointer/mouse events; only trusted input opens the popover.
  assert.doesNotMatch(code, /\.click\(\)/, 'must not script the official trigger')
  assert.match(overlay, /'position', 'fixed'/, 'fixed rect is what the portalled popover measures against')
  assert.match(overlay, /'pointer-events', 'auto'/)
  assert.match(overlay, /'opacity', '0'/, 'invisible, but present')
  assert.match(overlay, /aria-haspopup="tree"/, 'subagent pairing keeps the ARIA split')
  // The pill must not eat the tap meant for the trigger on top of it.
  assert.match(headerCss, /\[data-mobile-nav="activity-pill"\]\s*\{[^}]*pointer-events: none/)
})

test('the activity chip reports subagents and background jobs from the sessions snapshot', () => {
  assert.match(headerTsx, /s\.subagentsByParent\[sessionId\]/, 'subagent count comes from the snapshot')
  assert.match(headerTsx, /s\.jobsBySession\[sessionId\]/, 'job count comes from the snapshot')
  // Read, never re-parent: moving React-owned nodes across trees is what the
  // chip exists to avoid. Scoped to MobileHeaderActions — elsewhere in this
  // file the workbench-close pill legitimately appends an element it created
  // itself, which is a different thing entirely.
  const actions = headerTsx.match(/export function MobileHeaderActions[\s\S]*?\n}\n/)
  assert.ok(actions, 'MobileHeaderActions still present')
  assert.doesNotMatch(actions[0], /appendChild|insertBefore|replaceWith|removeChild/, 'the chip must not move official DOM')
})

test('the activity dot distinguishes running, settled and failed', () => {
  assert.match(headerTsx, /jobState: ActivityState = jobRunning \? 'running' : jobBad \? 'warning' : 'done'/)
  // Blue pulses while work is live, green means settled, warning covers a
  // failed/killed job — painting that green would call a failure a success.
  assert.match(headerCss, /\[data-activity-state="running"\][\s\S]*?animation: dsh-zen-activity-pulse/)
  assert.match(headerCss, /\[data-activity-state="warning"\][\s\S]*?--dsw-alias-state-warn-primary/)
  assert.match(
    headerCss,
    /\[data-mobile-nav="activity-dot"\]\s*\{[^}]*--dsw-alias-state-success-primary/,
    'the resting dot is the success green',
  )
})

test('the activity chip is a sibling of the view-switch row, not nested inside it', () => {
  // The switch button spans the whole band; nesting the chip would make every
  // tap on it also switch views.
  const viewrowButton = headerTsx.match(/data-mobile-nav="header-viewrow"[\s\S]*?<\/button>/)
  assert.ok(viewrowButton, 'view-switch button still present')
  assert.doesNotMatch(viewrowButton[0], /header-activity/, 'the chip must not live inside the switch button')
  assert.match(headerCss, /\[data-mobile-nav="header-activity"\]\s*\{[\s\S]*?position: absolute/)
})

test('reduced-motion callers get no pulse', () => {
  assert.match(
    headerCss,
    /prefers-reduced-motion: reduce\)\s*\{\s*\[data-activity-state="running"\][^}]*\{\s*animation: none/,
  )
})
