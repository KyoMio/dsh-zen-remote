// Self-check for the >=1024px standalone-PWA safe-area rule in misc.css.ts.
//
// That rule is the ONLY thing paying the status-bar inset on a wide tablet's
// home-screen PWA: the gateway hands viewport-fit=cover to every non-desktop
// device, but every other compensation rule stops at the 1023px breakpoint.
// If it is dropped (or a gate is weakened), nothing throws anywhere testable
// — desktop stays 0px-padding because env() is 0 there — the regression only
// shows up as "the top buttons are hard to tap" on a real tablet. Hence a
// check that fails loudly instead.
// Run: node scripts/check-tablet-safe-area.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import { MISC_CSS } from '../src/client/styles/misc.css.ts'
import { BASE_CSS } from '../src/client/styles/base.css.ts'

const rule = /@media\s*\(min-width:\s*1024px\)\s*and\s*\(display-mode:\s*standalone\)\s*\{\s*:has\(\s*>\s*\[data-shell-overlay\]\)\s*\{([^}]*)\}\s*\}/.exec(MISC_CSS)
assert.ok(
  rule,
  'the >=1024px standalone safe-area rule is gone: without it a wide tablet\'s ' +
    'home-screen PWA paints its top controls under the status bar (the gateway ' +
    'serves viewport-fit=cover at every width). See misc.css.ts.',
)
const body = rule[1]
assert.match(body, /box-sizing:\s*border-box\s*!important/, 'border-box is load-bearing: the frame is height:100% content-box (S2.1)')
assert.match(body, /padding-top:\s*var\(--mnav-sat\)\s*!important/, 'top inset must read the --mnav-sat variable (debug-param controllable)')
assert.match(body, /padding-bottom:\s*var\(--mnav-sab\)\s*!important/, 'bottom inset must read the --mnav-sab variable (Android tablet nav bar)')

// Both media gates are what make the desktop no-op structural. Dropping
// display-mode in particular would re-enable the rule in every >=1024px
// desktop BROWSER — still 0px there thanks to env(), but the gate keeps the
// no-op from depending on that coincidence.
assert.ok(
  /min-width:\s*1024px/.test(rule[0]) && /display-mode:\s*standalone/.test(rule[0]),
  'both no-op gates (min-width 1024px AND display-mode standalone) must stay on the media query',
)

// The variables the rule reads must stay defined on :root in base.css.ts —
// NOT inside any width media query, or the rule degrades to invalid-at
// computed-value time (padding falls back to unset) above 1023px.
const rootVars = /:root\s*\{[^}]*--mnav-sat:\s*env\(safe-area-inset-top,\s*0px\)[^}]*--mnav-sab:\s*env\(safe-area-inset-bottom,\s*0px\)[^}]*\}/.exec(BASE_CSS)
assert.ok(
  rootVars,
  '--mnav-sat/--mnav-sab must stay defined on :root in base.css.ts (ungated) for the >=1024px rule to resolve',
)
assert.ok(
  !/@media[^{]*\{[^@]*:root\s*\{[^}]*--mnav-sat/.test(BASE_CSS),
  '--mnav-sat must not move inside a media query in base.css.ts',
)

console.log('check-tablet-safe-area: ok')
