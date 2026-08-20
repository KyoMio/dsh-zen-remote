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
test('the native task/subagent roots are parked as invisible anchors, not shown or removed', () => {
  // Shown as-is they overflow the 92px header column across the title;
  // display:none'd they take their own popover with them and the pill has
  // nothing to open. Zero-width root + hidden trigger is the middle ground.
  const root = headerCss.match(
    /\[data-slot="conversation\.session\.header\.actions"\] > \[class\$="_root"\]:has\(> button\[class\$="_trigger"\]\)\s*\{([\s\S]*?)\}/,
  )
  assert.ok(root, 'the native roots must be addressed explicitly')
  assert.match(root[1], /position: absolute !important/)
  assert.match(root[1], /width: 0 !important/)
  assert.doesNotMatch(root[1], /display:\s*none/, 'hiding the root would kill the popover')

  const trigger = headerCss.match(
    /> \[class\$="_root"\] > button\[class\$="_trigger"\]\s*\{([\s\S]*?)\}/,
  )
  assert.ok(trigger, 'the official trigger must be addressed')
  assert.match(trigger[1], /display: none !important/, 'the pill replaces the official trigger')
})

test('the popover is right-anchored and viewport-clamped', () => {
  // Left-anchoring from a zero-width root at the right edge puts a 336px
  // panel off-screen — the exact 29px overflow measured on 2026-08-20.
  const menu = headerCss.match(/header\.actions"\] \[class\$="_menu"\]\s*\{([\s\S]*?)\}/)
  assert.ok(menu, 'the popover must be re-anchored')
  assert.match(menu[1], /right: 0 !important/)
  assert.match(menu[1], /left: auto !important/)
  assert.match(menu[1], /width: min\(336px, calc\(100vw - 32px\)\)/)
})

test('the pill opens the official popover rather than the info card', () => {
  assert.match(headerTsx, /aria-haspopup="tree"/, 'subagent trigger is found by its ARIA contract')
  assert.match(headerTsx, /button\[class\$="_trigger"\]:not\(\[aria-haspopup\]\)/, 'jobs trigger is the one without it')
  assert.match(headerTsx, /el === null \? onFallback\(\) : undefined|if \(el === null\) onFallback\(\)/, 'a missing entry still does something')
  assert.match(headerTsx, /else el\.click\(\)/, 'present entry gets the tap forwarded')
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
