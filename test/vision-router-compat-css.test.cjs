const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const compat = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'client', 'styles', 'compat.css.ts'),
  'utf8',
)

/*
 * dsh-vision-router puts a ~90px "识图" pill into conversation.input.right,
 * which squeezes the model name out of the phone composer's nowrap row; the
 * compat section shrinks it to a 28px round icon button showing exactly ONE
 * eye.
 *
 * "Exactly one" is the part that rots. The plugin changed its children in
 * 2.1.x from text glyphs to <svg>, and the section — written against the
 * text form — kept drawing its own ::before eye beside the plugin's new svg
 * one (two eyes in a 28px button) while nothing hid the active-state check
 * svg at all. Nothing failed: no error, no console noise, the button still
 * worked. Hence these assertions, which pin the shape of the fix rather
 * than the plugin's markup (that we cannot see from here).
 */
const sliced = compat.slice(compat.indexOf('dsh-vision-router: composer vision toggle'))
assert.ok(sliced.length > 0, 'the dsh-vision-router compat section must exist')
const nextDivider = sliced.indexOf('/* ---------- ', 10)
const section = nextDivider === -1 ? sliced : sliced.slice(0, nextDivider)

test('every span is hidden — label, and the text form\'s emoji and check', () => {
  assert.match(section, /\[data-vision-router-mode-toggle\] > span \{\s*display: none !important;/)
})

test('only the first svg survives: the trailing active-state check is hidden', () => {
  // Sibling combinator, not :nth-child(2) — how many icons the plugin ships
  // is its business; the rule only says "one icon, the first one".
  assert.match(section, /\[data-vision-router-mode-toggle\] > svg ~ svg \{\s*display: none !important;/)
})

test('our own ::before eye is a fallback, gated on the plugin having no svg', () => {
  // Without this gate the 2.1.x svg eye and our mask eye both render.
  assert.match(section, /\[data-vision-router-mode-toggle\]:has\(svg\)::before \{\s*content: none !important;/)
  // ...and the fallback itself must still exist for the <= 2.0.x text form.
  assert.match(section, /\[data-vision-router-mode-toggle\]::before \{\s*content: '';/)
})

test('the button stays a 28px round icon — the reason this section exists', () => {
  assert.match(section, /width: 28px !important;/)
  assert.match(section, /border-radius: 999px !important;/)
})

test('phone only: desktop keeps the plugin\'s full pill', () => {
  assert.match(section, /@media \(max-width: 767px\) \{/)
})

test('the gate is the plugin\'s own attribute, so the section is inert without it', () => {
  // Same convention as the dsh-market / dsh-better-sidebar sections: with the
  // plugin absent the attribute never exists and not one selector matches.
  const selectors = section.match(/^\s{4}\[data-slot=.*$/gm) || []
  assert.ok(selectors.length > 0, 'expected selector lines in the section')
  for (const line of selectors) {
    assert.match(line, /\[data-vision-router-mode-toggle\]/, `ungated selector: ${line.trim()}`)
  }
})
