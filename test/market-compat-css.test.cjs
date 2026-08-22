const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const compat = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'client', 'styles', 'compat.css.ts'),
  'utf8',
)

/*
 * @ace-zone/dsh-market's modal header is an unwrapping, unshrinking flex row
 * whose close button is the last item, so on a phone it is clipped off the
 * panel and the modal cannot be dismissed. The fix drops the decorative
 * items and lets the title ellipsis — and it must stay inert for everyone
 * else: "dsh market" is a name several unrelated plugins use, so the gate is
 * the version chip's title attribute, which carries the exact package name.
 */
const section = compat.slice(compat.indexOf('@ace-zone/dsh-market: modal header'))
assert.ok(section.length > 0, 'the dsh-market compat section must exist')

test('the gate is the exact package name, not the dshm- class prefix', () => {
  assert.match(compat, /const MARKET = '\.dshm-ver\[title="@ace-zone\/dsh-market"\]'/)
})

test('every dsh-market rule is presence-gated and phone-only', () => {
  const media = section.match(/@media \(max-width: 767px\) \{([\s\S]*)\n  \}/)
  assert.ok(media, 'the rules must sit inside the phone breakpoint')
  const selectors = media[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith(',') || line.endsWith('{'))
    .filter((line) => !line.startsWith('/*') && !line.startsWith('*'))
  assert.ok(selectors.length >= 5, 'expected the header rules to be present')
  for (const selector of selectors) {
    assert.ok(
      selector.startsWith('body:has(${MARKET})'),
      `ungated selector would hit look-alike plugins: ${selector}`,
    )
  }
})

test('the close button survives and only decoration is hidden', () => {
  const hidden = section.match(/([\s\S]*?)\{\n      display: none !important/)
  assert.ok(hidden)
  assert.doesNotMatch(hidden[1], /dshm-close/, 'hiding the close button would be the bug')
  assert.doesNotMatch(hidden[1], /dshm-title/)
  // The language toggle is a button, the official-site link is an <a>; only
  // the link is dropped, so the toggle must not be matched by element name.
  assert.match(hidden[1], /> a\.dshm-viewbtn/)
  assert.match(section, /\.dshm-head > \.dshm-close \{[\s\S]*?flex: 0 0 auto !important/)
  assert.match(section, /\.dshm-head > \.dshm-title \{[\s\S]*?min-width: 0 !important/)
})
