'use strict'
// A reasoning block whose display text is empty once its leading
// <signature>…</signature> is stripped. DSH 0.2.1-rc.5's ReasoningRow
// renders it as null but its ProcessReasoning wrapper stays, so the flow
// row is either blank (the block was the step's only content) or carries
// an empty wrapper beside a real Think. Before the fix neither shape was
// folded and the phone fold showed a blank band. On 0.2.1-rc.2 the same
// block renders as an ordinary Think and must fold exactly as before.
// Checked against a minimal DOM stand-in shaped like the host's real tree:
// flowItem > seat > AssistantMarkdown root > body > ProcessReasoning > Think.
const test = require('node:test')
const assert = require('node:assert/strict')

const text = (value) => ({ nodeType: 3, textContent: value, childNodes: [] })
const el = (tagName, attrs, ...children) => {
  const node = {
    nodeType: 1,
    tagName,
    attrs,
    childNodes: children,
    get textContent() { return children.map((child) => child.textContent).join('') },
    matches(selector) {
      assert.equal(selector, '[data-variant="think"]', 'only the Think selector is ever matched')
      return attrs.variant === 'think'
    },
  }
  return node
}
const think = (summary) => el('DIV', { variant: 'think' },
  el('BUTTON', {}, el('svg', {}), el('SPAN', {}, text(summary))))
const wrapper = (...children) => el('DIV', {}, ...children)
const row = (...blocks) => el('DIV', { kind: 'assistant-step' },
  el('DIV', {}, el('DIV', {}, el('DIV', {}, ...blocks))))

const load = () => import('../src/client/effects/turn-fold.ts')

test('rc.5 signature-only step: the row is blank, so it is hidden and not a fold item', async () => {
  const { isBlankStep, foldsWholeRow } = await load()
  const blank = row(wrapper())
  assert.equal(isBlankStep(blank), true)
  assert.equal(foldsWholeRow(blank, []), false, 'no Think, no step to count')
  // Whitespace-only text the host may leave between wrappers is still blank.
  assert.equal(isBlankStep(row(wrapper(), text('\n  '))), true)
})

test('rc.5 real Think + signature-only block in one step: the row still folds whole', async () => {
  const { foldsWholeRow, isBlankStep } = await load()
  const t = think('Planning the edit')
  const mixed = row(wrapper(t), wrapper())
  assert.equal(foldsWholeRow(mixed, [t]), true, 'the empty wrapper must not keep the row open')
  assert.equal(isBlankStep(mixed), false)
})

test('rc.2 signature block renders as a Think: folds exactly as before', async () => {
  const { foldsWholeRow, isBlankStep } = await load()
  const t = think('<signature>abc</signature>')
  const step = row(wrapper(t))
  assert.equal(foldsWholeRow(step, [t]), true)
  assert.equal(isBlankStep(step), false)
})

test('a row with prose, an image or a notice beside its Think is never folded whole nor blank', async () => {
  const { foldsWholeRow, isBlankStep } = await load()
  const t = think('Thinking')
  const prose = row(wrapper(t), el('P', {}, text('Here is the answer.')))
  assert.equal(foldsWholeRow(prose, [t]), false)
  const image = row(wrapper(t), el('DIV', {}, el('IMG', {})))
  assert.equal(foldsWholeRow(image, [t]), false)
  assert.equal(isBlankStep(row(el('DIV', {}, el('IMG', {})))), false, 'an image-only step is content')
  assert.equal(isBlankStep(row(el('SPAN', {}, text('Stopped')))), false, 'an interrupted notice is content')
  assert.equal(isBlankStep(row(el('svg', {}))), false, 'lower-case SVG tagName counts too')
})

test('hasContentOutside: skips only the subtrees that match', async () => {
  const { hasContentOutside } = await load()
  const t = think('Thinking')
  assert.equal(hasContentOutside(wrapper(t), '[data-variant="think"]'), false)
  assert.equal(hasContentOutside(wrapper(t), null), true)
  assert.equal(hasContentOutside({ nodeType: 8, textContent: 'comment', childNodes: [] }, null), false,
    'a comment node is not content')
})

test('the stylesheet hides the BLANK marker inside the fold scope only', async () => {
  const { BLANK } = await load()
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/client/styles/turn-fold.css.ts'), 'utf8')
  assert.equal(BLANK, 'data-mnav-blank')
  assert.match(css, /\$\{scope\} \[data-chat-flow\] > \[data-mnav-blank\] \{\s*display: none !important;/)
  assert.equal(/^\[data-mnav-blank\]/m.test(css), false, 'never hidden outside an active fold')
})
