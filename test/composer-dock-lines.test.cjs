const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const composer = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'client', 'styles', 'composer.css.ts'),
  'utf8',
)
const strip = (block) => block.replace(/\/\*[\s\S]*?\*\//g, '')

/*
 * conversation.input.dock is a chip rail, but four things that register into
 * it are not chips: the to-do panel, the goal bar, the queue strip and our own
 * attachment chips. Each is a full-width status row, and the rail is nowrap —
 * so any two of them on one line means one gets squeezed to a stub and the
 * other runs off the right edge (reported 2026-09-06 with 任务 + 进行中的目标).
 * Each therefore takes a line of its own, in a fixed order, with attachments
 * last so what is about to be sent sits closest to the input.
 */
const dock = (marker) => {
  const head = `[data-slot="conversation.input.dock"] > [${marker}] {`
  const at = composer.indexOf(head)
  assert.ok(at !== -1, `the dock rule for [${marker}] must exist`)
  const body = composer.slice(at + head.length)
  return strip(body.slice(0, body.indexOf('\n  }')))
}

const FULL_WIDTH = [
  ['data-testid="todo-panel"', 1],
  ['data-goal-bar', 2],
  ['data-queue-dock', 3],
  ['data-mobile-nav="attach-chips"', 4],
]

for (const [marker, order] of FULL_WIDTH) {
  test(`[${marker}] takes a whole line, at order ${order}`, () => {
    const decls = dock(marker)
    assert.match(decls, /flex: 1 0 100% !important;/)
    assert.match(decls, new RegExp(`order: ${order} !important;`))
  })
}

test('every full-width entry has a distinct line', () => {
  const orders = FULL_WIDTH.map(([, o]) => o)
  assert.equal(new Set(orders).size, orders.length)
})

test('the rail only wraps once a full-width entry is present', () => {
  // With nothing but pills it stays the original single scrolling line.
  const gate = /\[data-slot="conversation\.input\.dock"\]:has\(([^)]*)\) \{\s*flex-wrap: wrap/.exec(composer)
  assert.ok(gate, 'the wrap gate must exist')
  for (const [marker] of FULL_WIDTH) {
    assert.ok(gate[1].includes(marker), `wrap gate is missing [${marker}] — its line would not exist`)
  }
})
