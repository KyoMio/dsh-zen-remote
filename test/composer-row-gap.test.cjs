const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const composer = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'client', 'styles', 'composer.css.ts'),
  'utf8',
)
const strip = (block) => block.replace(/\/\*[\s\S]*?\*\//g, '')
const section = composer.slice(
  composer.indexOf('--- 2. the running order'),
  composer.indexOf('--- 3. permission as icon-only'),
)

/*
 * The row is [attach · + · permission · model] …gap… [context ring · send].
 * The gap used to be `margin-right: auto` on the model seat, which assumed a
 * model pill always exists — a subagent session has none, and the stop / send
 * buttons ended up floating in the middle of the row (reported 2026-09-06).
 * It belongs to the right-hand group instead, where it holds regardless of
 * what the left side contains.
 */
test('the model seat no longer carries the gap', () => {
  const model = strip(/\$\{MODEL\} \{([\s\S]*?)\n  \}/.exec(section)[1])
  assert.doesNotMatch(model, /margin-right: auto/)
})

test('the gap sits in front of the right-hand group', () => {
  // Send carries the auto margin on its own (no ring, e.g. a subagent session).
  assert.match(strip(section), /\$\{ROW\} > \[class\$="_trailing"\] > \[class\$="_primary"\] \{\s*margin-left: auto !important;/)
  // With the lifted ring (DSH 0.1.7 moved it into ROOT's _dock), the row's
  // placeholder in front of send takes the auto margin instead.
  assert.match(strip(section), /\[class\$="_row"\]::before \{\s*content: '';\s*order: 6;\s*flex: 0 0 \$\{RING_W\};\s*margin-left: auto;/)
})

test('send gives the gap back whenever a ring precedes it', () => {
  // Two auto margins would share the free space and open a second gap
  // between the ring and the send button.
  assert.match(strip(section), /\$\{ROOT\}:has\(> \[class\$="_dock"\] button\) > \[class\$="_card"\] > \[class\$="_row"\] > \[class\$="_trailing"\] > \[class\$="_primary"\] \{\s*margin-left: 0 !important;/)
})

test('the ContextMeter dock is lifted back beside send on the phone', () => {
  // 0.1.7 renders the ring in a _dock line under the card; unlifted it
  // falls to the bottom of the phone screen.
  assert.match(strip(section), /\$\{ROOT\} > \[class\$="_dock"\] \{\s*position: absolute !important;/)
})
