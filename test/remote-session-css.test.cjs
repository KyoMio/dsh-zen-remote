const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const css = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'client', 'styles', 'remote-session.css.ts'),
  'utf8',
)
// The template literal is the shipped stylesheet; slice past the module
// comment so assertion regexes can't match prose.
const start = css.indexOf('export const REMOTE_SESSION_CSS = `')
const sheet = css.slice(start)
assert.ok(sheet.length > 0, 'the template literal must exist')

/*
 * The model-menu group rules (T52) and the native-option rule (T52-fix) both
 * key on attributes the COMPONENTS themselves write, so their shape is worth
 * pinning: a selector that stopped matching would degrade silently (the
 * interceptor's refusal messages are the backstop), and one that matched too
 * much would hide selectable rows in menus we never meant to touch.
 */

test('T52: the model-menu group rules key on the aria mark and the html-level session attribute', () => {
  // A remote session keeps only the server's groups (sections whose
  // aria-labelledby does NOT carry the virtual "zr~" prefix are hidden)…
  assert.match(
    sheet,
    /html\[data-zr-remote-session="1"\] \[role="menu"\] section\[role="group"\]:not\(\[aria-labelledby\*="zr~"\]\) \{\s*display: none !important;/,
  )
  // …every other context keeps only the virtual ones.
  assert.match(
    sheet,
    /html:not\(\[data-zr-remote-session\]\) \[role="menu"\] section\[role="group"\]\[aria-labelledby\*="zr~"\] \{\s*display: none !important;/,
  )
})

test('T52-fix: native <option> rows with a virtual group value are hidden unconditionally', () => {
  // dsh-vision-router's settings render its vision-backend picker as
  // <option value={group.id}> and its filter keeps zr~ groups; a virtual
  // group is never a runnable LOCAL backend, so the rule carries no session
  // scoping — the value prefix on the option element is the whole gate.
  assert.match(sheet, /option\[value\^="zr~"\] \{\s*display: none !important;/)
  // The gate is anchored at the START of the value: a group id that merely
  // CONTAINS "zr~" must not be caught.
  assert.ok(!/option\[value\*="zr~"\]/.test(sheet), 'no contains-match on the option value')
})

test('T51: the export menu-item rule is gated on the session attribute and locked to the FIRST item', () => {
  // The exact selector, character for character: the html-level remote-
  // session gate, the utilities-slot anchor, the anchor's sibling menu
  // surface, its items viewport, and `> :first-child`. The first item is
  // the export by construction (the feedback entry is appended AFTER it),
  // so anything wider — `*`, or a rule without the session gate — would
  // hide entries a remote session must keep, or fire on local sessions.
  assert.match(
    sheet,
    /html\[data-zr-remote-session="1"\] \[data-slot="conversation\.session\.header\.utilities"\] \[class\$="_moreButton"\] ~ \[role="menu"\] > \[role="presentation"\] > :first-child \{\s*display: none !important;/,
  )
  // No weaker shape may exist alongside: the child must not be the
  // universal selector, and the anchor chain must never appear WITHOUT the
  // html-level gate in front.
  assert.ok(
    !sheet.includes('[role="presentation"] > *'),
    'the export item is pinned to :first-child, not matched by `>` + universal',
  )
  assert.ok(
    !/\[data-slot="conversation\.session\.header\.utilities"\] \[class\$="_moreButton"\]/.test(
      sheet.replace(/html\[data-zr-remote-session="1"\] \[data-slot="conversation\.session\.header\.utilities"\] \[class\$="_moreButton"\]/g, ''),
    ),
    'every use of the utilities-slot anchor chain sits behind the session gate',
  )
})
