'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')

const strip = (block) => block.replace(/\/\*[\s\S]*?\*\//g, '')

const ROW = '[data-slot="conversation.composer.bar"] [class$="_card"] > [class$="_row"]'
const ROOT = '[data-slot="conversation.composer.bar"] > [class$="_root"]'
const STD = `${ROW} > [class$="_trailing"] > [class$="_standardControls"]`
const MODEL = `${STD} > [data-slot="conversation.input.model"] > *:not([data-mobile-nav])`
const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

let sheet
const getCss = async () => {
  if (sheet === undefined) {
    sheet = (await import('../src/client/styles/composer.css.ts')).COMPOSER_CSS
  }
  return sheet
}

test('composer dock lines: every full-width entry claims order 1..4 and gates flex-wrap', async () => {
  const composer = await getCss()
  const FULL_WIDTH = [
    ['data-testid="todo-panel"', 1],
    ['data-goal-bar', 2],
    ['data-queue-dock', 3],
    ['data-mobile-nav="attach-chips"', 4],
  ]

  for (const [marker, order] of FULL_WIDTH) {
    const head = `[data-slot="conversation.input.dock"] > [${marker}] {`
    const at = composer.indexOf(head)
    assert.ok(at !== -1, `the dock rule for [${marker}] must exist`)
    const body = composer.slice(at + head.length)
    const decls = strip(body.slice(0, body.indexOf('\n  }')))
    assert.match(decls, /flex: 1 0 100% !important;/)
    assert.match(decls, new RegExp(`order: ${order} !important;`))
  }

  const gate = /\[data-slot="conversation\.input\.dock"\]:has\(([^)]*)\) \{\s*flex-wrap: wrap/.exec(composer)
  assert.ok(gate, 'the wrap gate must exist')
  for (const [marker] of FULL_WIDTH) {
    assert.ok(gate[1].includes(marker), `wrap gate missing [${marker}]`)
  }
})

test('composer row gap: model seat drops margin-right:auto, trailing/ring owns the gap, ContextMeter lifts to dock', async () => {
  const composer = await getCss()
  const section = strip(composer.slice(
    composer.indexOf('--- 2. the running order'),
    composer.indexOf('--- 3. permission as icon-only'),
  ))

  const modelMatch = new RegExp(`${ESC(MODEL)} \\{([\\s\\S]*?)\\n  \\}`).exec(section)
  assert.ok(modelMatch)
  assert.doesNotMatch(modelMatch[1], /margin-right: auto/)

  assert.match(section, new RegExp(`${ESC(ROW)} > \\[class\\$="_trailing"\\] > \\[class\\$="_primary"\\] \\{\\s*margin-left: auto !important;`))
  assert.match(section, /\[class\$="_row"\]::before \{\s*content: '';\s*order: 6;\s*flex: 0 0 30px;\s*margin-left: auto;/)
  assert.match(section, new RegExp(`${ESC(ROOT)}:has\\(> \\[class\\$="_dock"\\] button\\) > \\[class\\$="_card"\\] > \\[class\\$="_row"\\] > \\[class\\$="_trailing"\\] > \\[class\\$="_primary"\\] \\{\\s*margin-left: 0 !important;`))
  assert.match(section, new RegExp(`${ESC(ROOT)} > \\[class\\$="_dock"\\] \\{\\s*grid-area: 1 / 1 !important;\\s*align-self: end !important;\\s*justify-self: end !important;`))
  assert.doesNotMatch(section, /_dock"\] \{\s*position: absolute/)
  assert.match(section, /_dock"\] button\[class\$="_trigger"\] > span \{\s*display: none !important;/)
})

test('composer row shrink: modes does not shrink, model seat matches any plugin root and truncates', async () => {
  const composer = await getCss()
  const section = composer.slice(composer.indexOf('--- 1. flatten the two official groups'))
  assert.ok(section.length > 0)

  const modesRule = new RegExp(`${ESC(ROW)} > \\[class\\$="_tools"\\] > \\[class\\$="_modes"\\] \\{([\\s\\S]*?)\\n  \\}`).exec(section)
  assert.ok(modesRule)
  const modes = strip(modesRule[1])
  assert.match(modes, /flex: 0 0 auto !important;/)
  assert.doesNotMatch(modes, /flex: 0 1/)
  assert.doesNotMatch(modes, /min-width: 0/)

  const modelRule = new RegExp(`${ESC(MODEL)} \\{([\\s\\S]*?)\\n  \\}`).exec(section)
  assert.ok(modelRule)
  const model = strip(modelRule[1])
  assert.match(model, /flex: 0 1 /)
  assert.match(model, /min-width: 0 !important;/)

  assert.match(composer, /\[data-slot="conversation\.input\.model"\] > \*/)
  assert.doesNotMatch(composer, /\[data-slot="conversation\.input\.model"\] > \[class\$="_root"\]/)
  assert.match(composer, new RegExp(`${ESC(MODEL)} > button \\{[^}]*text-overflow: ellipsis !important;`))
  assert.match(composer, new RegExp(`${ESC(MODEL)} > \\[class\\$="_trigger"\\],\\s*${ESC(MODEL)} > button \\{`))
  assert.match(section, /flex-wrap: nowrap !important;/)
})

test('#31 attach restore: phone block hides the second official _add paperclip (< 768px only)', async () => {
  const composer = await getCss()
  const phoneStart = composer.indexOf('@media (max-width: 767px)')
  const phoneEnd = composer.indexOf('@media (min-width: 768px)')
  assert.ok(phoneStart !== -1 && phoneEnd !== -1 && phoneStart < phoneEnd)
  assert.match(
    composer.slice(phoneStart, phoneEnd),
    new RegExp(`${ESC(ROW)} > \\[class\\$="_tools"\\] > button\\[class\\$="_add"\\]:nth-of-type\\(2\\)\\s*\\{[^}]*display: none !important`),
  )
})
