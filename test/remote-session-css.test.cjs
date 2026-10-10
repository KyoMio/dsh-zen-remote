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

test('T74: the model-menu group rules key on the data-zr-group stamp and the html-level session attribute', () => {
  // A remote session hides the groups the effect stamped LOCAL…
  assert.match(
    sheet,
    /html\[data-zr-remote-session="1"\] section\[role="group"\]\[data-zr-group="local"\] \{\s*display: none !important;/,
  )
  // …every other context hides the stamped-REMOTE ones.
  assert.match(
    sheet,
    /html:not\(\[data-zr-remote-session\]\) section\[role="group"\]\[data-zr-group="remote"\] \{\s*display: none !important;/,
  )
  // The 0.1.7-era rules that keyed on the group id inside aria-labelledby
  // must be GONE: 0.2.0's MenuGroup carries only a useId there (the group id
  // is nowhere in the markup), and the same component renders other menus'
  // groups — a surviving attribute-prefix rule would misfire in BOTH
  // directions (hide everything in a remote session's model menu, miss the
  // server's groups in local ones).
  assert.ok(!sheet.includes('aria-labelledby*="zr~"'), 'the aria-prefix group rules must not survive')
  // No [role="menu"] scoping on the stamp rules: the container rule of the
  // classifier is what scopes them, not a structural guess about menus.
  assert.ok(
    !/\[role="menu"\] section\[role="group"\]\[data-zr-group/.test(sheet),
    'the stamp rules carry no menu-structure scope',
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

// ---- PB-14: the T53 rules key on the bridge stamp -----------------------------

/** Every T53 target the hiding applies to while better-sidebar is NOT
 * bridged. The four display regimes follow from the selector shape alone:
 *  - LOCAL SESSION / NO ATTRIBUTE — no `data-zr-remote-session` on <html>,
 *    so not one rule matches (every selector is pinned to it first);
 *  - REMOTE + UNBRIDGED — the remote attribute matches, the bridge stamp
 *    is absent, the `:not()` passes → the rule FIRES;
 *  - REMOTE + BRIDGED — the stamp is present, the `:not()` fails → the
 *    rule never fires and the panels stay visible (the adapter serves the
 *    server's data). */
const T53_TARGETS = [
  '[data-dsh-bottom-toggle]',
  '[data-dsh-panel-host]',
  '[data-dsh-native-tab-host] > *',
  '[data-dsh-native-tab-host]::before',
  '[data-dockkit-tab]:has([class$="_chipIcon"])',
  '[data-floating-window]:has([data-window-body])',
  '[data-sidebar-right-guide-entry="git"]',
  '[data-sidebar-right-guide-entry="subagent"]',
  '[data-sidebar-right-guide-entry="sidechat"]',
  '[data-sidebar-right-guide-entry="files"]:not([aria-keyshortcuts])',
  '[data-dsh-dock-fallback]',
]

test('PB-14: every T53 rule sits behind the bridge stamp and fires only while unbridged', () => {
  for (const target of T53_TARGETS) {
    // The gate prefix must sit immediately before the target, in order.
    assert.ok(
      sheet.includes(`html[data-zr-remote-session="1"]:not([data-zr-bridge-dsh-better-sidebar="1"]) ${target}`),
      `the ${target} rule must sit behind the bridge stamp`,
    )
  }
  // The --dsh-sidebar-height zeroing is an html-level rule with the same gate.
  assert.match(
    sheet,
    /html\[data-zr-remote-session="1"\]:not\(\[data-zr-bridge-dsh-better-sidebar="1"\]\) \{\s*--dsh-sidebar-height: 0px !important;/,
  )
  // The UNBRIDGED-ONLY shape must be the only shape: a bare
  // `html[data-zr-remote-session="1"] <T53 target>` rule would hide the
  // panels even when bridged. Every legacy occurrence has to carry the
  // :not gate.
  const sheetWithoutGated = sheet.replaceAll(
    'html[data-zr-remote-session="1"]:not([data-zr-bridge-dsh-better-sidebar="1"])',
    'GATED',
  )
  for (const target of T53_TARGETS) {
    assert.ok(
      !sheetWithoutGated.includes(`html[data-zr-remote-session="1"] ${target} {`),
      `a bare (ungated) ${target} rule must not survive`,
    )
  }
})

test('PB-14: the unbridged tab body spends the note variable as its ::before', () => {
  // The empty tab body hides the plugin's own content…
  assert.match(
    sheet,
    /html\[data-zr-remote-session="1"\]:not\(\[data-zr-bridge-dsh-better-sidebar="1"\]\) \[data-dsh-native-tab-host\] > \* \{\s*display: none !important;/,
  )
  // …and spends the note copy the stamp effect writes on <html> (a CSS
  // variable, because ::before's attr() reads only the element itself).
  assert.match(
    sheet,
    /html\[data-zr-remote-session="1"\]:not\(\[data-zr-bridge-dsh-better-sidebar="1"\]\) \[data-dsh-native-tab-host\]::before \{\s*content: var\(--zr-bridge-note\);/,
  )
  // Unset variable (the effect not running) must render NOTHING: the
  // content declaration is the only source of the ::before.
  assert.ok(
    !/content:\s*["'].*better-sidebar[^"']*["']/.test(sheet),
    'the note copy must live in the effect (per-locale), never inline in the sheet',
  )
})
