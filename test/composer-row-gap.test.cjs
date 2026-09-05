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
  assert.match(strip(section), /span\[class\$="_root"\],\s*\$\{ROW\} > \[class\$="_trailing"\] > \[class\$="_primary"\] \{\s*margin-left: auto !important;/)
})

test('send gives the gap back whenever a ring precedes it', () => {
  // Two auto margins would share the free space and open a second gap
  // between the ring and the send button.
  assert.match(strip(section), /span\[class\$="_root"\] ~ \[class\$="_primary"\] \{\s*margin-left: 0 !important;/)
})
