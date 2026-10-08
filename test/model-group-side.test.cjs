// dsh-zen-remote · T74 model-menu group side (src/client-data/model-group-side.ts
// + src/client/effects/model-group-side.ts)
//
// The 0.2.0 model menu's group sections no longer carry their group id in
// the markup (MenuGroup renders aria-labelledby={useId()} only), so which
// groups belong to which side of the pairing is decided from the heading
// TEXT: virtual group names start with the invisible WORD JOINER (T74,
// written by mergeModelCatalogs). Driven the dynamic .ts way (the same seam
// remote-group-expansion.test.cjs uses):
//
// - the PURE classifier: a container with at least one marked heading is
//   decided (marked → remote, the rest → local); a container with none
//   stamps NOTHING — that is what keeps the effect inert everywhere but the
//   model menu;
// - the heading resolution order the effect walks: aria-labelledby's target
//   first (both versions render one), then the 0.2.0 heading child, then
//   the first id-bearing child (0.1.7's heading shape).
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const loadPure = () => import('../src/client-data/model-group-side.ts?' + Math.random())
const loadEffect = () => import('../src/client/effects/model-group-side.ts?' + Math.random())

// Pinned literally: U+2060 WORD JOINER is the mark both ends must agree on.
const MARK = '\u2060'

// -- the pure classifier ---------------------------------------------------------------

test('T74 classify: a mixed container stamps marked headings remote and the rest local', async () => {
  const { classifyModelGroups } = await loadPure()
  const verdicts = classifyModelGroups([
    { containerKey: 1, headingText: `${MARK}书房 · Codex` },
    { containerKey: 1, headingText: 'DeepSeek 账号' },
    { containerKey: 1, headingText: 'OpenAI' },
  ])
  assert.deepEqual(verdicts, ['remote', 'local', 'local'])
})

test('T74 classify: a container with no marked heading stamps NOTHING', async () => {
  const { classifyModelGroups } = await loadPure()
  // Every unpaired client's model menu, every other menu, the whole rest of
  // the page: no mark anywhere → all undefined → the effect leaves the DOM
  // alone and neither CSS rule matches.
  const verdicts = classifyModelGroups([
    { containerKey: 2, headingText: 'DeepSeek 账号' },
    { containerKey: 2, headingText: 'OpenAI' },
    { containerKey: 2, headingText: '' },
  ])
  assert.deepEqual(verdicts, [undefined, undefined, undefined])
})

test('T74 classify: an all-virtual container stamps every group remote', async () => {
  const { classifyModelGroups } = await loadPure()
  const verdicts = classifyModelGroups([
    { containerKey: 3, headingText: `${MARK}书房 · Codex` },
    { containerKey: 3, headingText: `${MARK}书房 · Claude` },
  ])
  assert.deepEqual(verdicts, ['remote', 'remote'])
})

test('T74 classify: containers decide independently of one another', async () => {
  const { classifyModelGroups } = await loadPure()
  const verdicts = classifyModelGroups([
    { containerKey: 1, headingText: `${MARK}书房 · Codex` },
    { containerKey: 1, headingText: 'OpenAI' },
    { containerKey: 2, headingText: 'DeepSeek 账号' },
    { containerKey: 2, headingText: 'OpenAI' },
  ])
  assert.deepEqual(verdicts, ['remote', 'local', undefined, undefined],
    'the mixed menu decides; the all-local menu one stays unstamped')
})

// -- the heading resolution order (effects/model-group-side.ts) ------------------------

// Minimal Element stand-ins: only what headingTextOf touches.
const el = (props) => ({ ...props })
const byId = (map) => (id) => (Object.hasOwn(map, id) ? map[id] : null)

test('T74 heading: aria-labelledby wins when its target exists', async () => {
  const { headingTextOf } = await loadEffect()
  const section = el({
    getAttribute: (name) => (name === 'aria-labelledby' ? 'h-1' : null),
    // A decoy that would win if the fallback ran first.
    querySelector: () => el({ textContent: 'decoy' }),
    children: [],
  })
  assert.equal(headingTextOf(section, byId({ 'h-1': el({ textContent: 'aria heading' }) })), 'aria heading')
})

test('T74 heading: a dangling aria-labelledby falls through to the 0.2.0 heading child', async () => {
  const { headingTextOf } = await loadEffect()
  const section = el({
    getAttribute: () => ':r3:',
    querySelector: (sel) => (sel === ':scope > [data-menu-group-heading]' ? el({ textContent: 'menu heading' }) : null),
    // The MenuGroup's first child is the id-less position sentinel — never
    // the heading.
    children: [el({ id: '', textContent: 'sentinel' })],
  })
  assert.equal(headingTextOf(section, byId({})), 'menu heading')
})

test('T74 heading: with neither, the first id-bearing child stands in (the 0.1.7 shape)', async () => {
  const { headingTextOf } = await loadEffect()
  const section = el({
    getAttribute: () => null,
    querySelector: () => null,
    children: [el({ id: '', textContent: 'not this one' }), el({ id: 'sel-1-model-group', textContent: 'id heading' })],
  })
  assert.equal(headingTextOf(section, byId({})), 'id heading')
})

test('T74 heading: nothing resolvable → null', async () => {
  const { headingTextOf } = await loadEffect()
  const section = el({ getAttribute: () => null, querySelector: () => null, children: [] })
  assert.equal(headingTextOf(section, byId({})), null)
})
