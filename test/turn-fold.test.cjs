'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')
const effectSrc = read('src', 'client', 'effects', 'turn-fold.ts')
const hostSrc = read('src', 'index.ts')
const clientConfigSrc = read('src', 'client', 'client-config.ts')

const loadEffect = () => import('../src/client/effects/turn-fold.ts')
const loadCss = () => import('../src/client/styles/turn-fold.css.ts')

test('host republishes turnFoldDesktop live at CLIENT_CONFIG_ROUTE matching client-config', () => {
  assert.match(hostSrc, /CLIENT_CONFIG_ROUTE = '\/_dsh\/mobile-nav\/client-config'/)
  assert.match(hostSrc, /turnFoldDesktop: unwrapVolatile\(config\.turnFoldDesktop\) === true/)
  const route = clientConfigSrc.match(/export const CLIENT_CONFIG_ROUTE = '([^']+)'/)
  assert.ok(route)
  assert.ok(hostSrc.includes(`'${route[1]}'`))
  assert.match(effectSrc, /clientConfig\(\)/)
})

test('desktop fold opt-in param, localStorage cache, and width-independent attach', () => {
  assert.match(effectSrc, /'dsh-mobile-nav\.turn-fold-desktop'/)
  assert.match(effectSrc, /'mobile-nav-turn-fold'/)
  assert.match(effectSrc, /localStorage\.setItem\(DESKTOP_KEY, '1'\)/)
  assert.match(effectSrc, /localStorage\.removeItem\(DESKTOP_KEY\)/)

  assert.match(effectSrc, /DESKTOP_CACHE_KEY = 'dsh-mobile-nav\.turn-fold-desktop-seen'/)
  assert.notEqual(
    effectSrc.match(/DESKTOP_CACHE_KEY = '([^']+)'/)[1],
    effectSrc.match(/DESKTOP_KEY = '([^']+)'/)[1],
  )
  const answer = effectSrc.match(/desktopConfigured\(\)\.then\(\(on\) => \{([\s\S]*?)\n {4}\}\)/)
  assert.ok(answer)
  assert.match(answer[1], /setItem\(DESKTOP_CACHE_KEY, '1'\)/)
  assert.match(answer[1], /removeItem\(DESKTOP_CACHE_KEY\)/)

  const wiring = effectSrc.match(/const enableDesktop = ([\s\S]*?)\n {2}\}, 'dsh-mobile-nav/)
  assert.ok(wiring)
  assert.match(wiring[1], /setAttribute\(DESKTOP_ATTR, ''\)/)
  assert.match(wiring[1], /removeAttribute\(DESKTOP_ATTR\)/)
  assert.match(wiring[1], /if \(desktopOptIn\(\) \|\| localStorage\.getItem\(DESKTOP_CACHE_KEY\) === '1'\) enableDesktop\(\)/)
  assert.match(wiring[1], /desktopConfigured\(\)\.then/)
  assert.match(wiring[1], /if \(narrow\.matches\) attach\(\)\s*\n\s*narrow\.addEventListener/)
  assert.match(effectSrc, /if \(desktop \|\| disposed\) return/)
})

test('TURN_FOLD_CSS invariant: BORN_FOLDED covers every PROCESS_KINDS, phone + opt-in copies match, no bare display:none', async () => {
  const { PROCESS_KINDS, THINK, OPEN, BLANK } = await loadEffect()
  const { TURN_FOLD_CSS } = await loadCss()
  const ACTIVE = 'data-mnav-fold-on'

  assert.match(TURN_FOLD_CSS, /@media \(max-width: 767px\) \{[\s\S]*\[data-mnav-fold\]:not\(\[data-mnav-fold-open\]\) \{\s*display: none !important;/)
  assert.match(TURN_FOLD_CSS, /html\[data-mnav-desktop-fold\] \[data-mnav-fold\]:not\(\[data-mnav-fold-open\]\) \{\s*display: none !important;/)
  assert.match(TURN_FOLD_CSS, /html\[data-mnav-desktop-fold\] \[data-chat-flow\] > \[data-mobile-nav="turn-fold"\] \{/)

  assert.ok(PROCESS_KINDS.length > 0)
  for (const kind of PROCESS_KINDS) {
    assert.ok(
      TURN_FOLD_CSS.includes(`html[${ACTIVE}] [data-chat-flow] > [data-chat-flow-kind="${kind}"]:not([${OPEN}])`),
      `"${kind}" must be born folded`,
    )
  }
  assert.ok(TURN_FOLD_CSS.includes(`[data-chat-flow-kind="assistant-step"]:not([${OPEN}]) ${THINK}:not([${OPEN}])`))

  assert.equal(BLANK, 'data-mnav-blank')
  assert.match(TURN_FOLD_CSS, /@media \(max-width: 767px\) \{[\s\S]*\[data-chat-flow\] > \[data-mnav-blank\] \{\s*display: none !important;/)
  assert.match(TURN_FOLD_CSS, /html\[data-mnav-desktop-fold\] \[data-chat-flow\] > \[data-mnav-blank\] \{\s*display: none !important;/)
  assert.equal(/^\[data-mnav-blank\]/m.test(TURN_FOLD_CSS), false)

  const emitted = TURN_FOLD_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const phone = emitted.indexOf('@media (max-width: 767px) {')
  assert.notEqual(phone, -1)
  let depth = 0
  let phoneEnd = -1
  for (let i = emitted.indexOf('{', phone); i < emitted.length && phoneEnd === -1; i += 1) {
    if (emitted[i] === '{') depth += 1
    else if (emitted[i] === '}' && (depth -= 1) === 0) phoneEnd = i
  }
  assert.notEqual(phoneEnd, -1)

  for (let at = emitted.indexOf('display: none'); at !== -1; at = emitted.indexOf('display: none', at + 1)) {
    const brace = emitted.lastIndexOf('{', at)
    const from = Math.max(emitted.lastIndexOf('}', brace), emitted.lastIndexOf('{', brace - 1))
    for (const selector of emitted.slice(from + 1, brace).split(',').map((one) => one.trim())) {
      if (selector === '[data-mobile-nav="turn-fold"]') continue
      assert.ok(
        selector.includes(`html[${ACTIVE}]`)
          || selector.includes('html[data-mnav-desktop-fold]')
          || (brace > phone && brace < phoneEnd),
        `ungated display:none — hides host content at every width:\n  ${selector}`,
      )
    }
  }
})

test('synchronous MutationObserver markWholeRows, root ACTIVE_ATTR lifecycle, and stale open sweep', () => {
  const attach = effectSrc.match(/const attach = \(\): void => \{([\s\S]*?)\n {4}\}/)
  const detach = effectSrc.match(/const detach = \(\): void => \{([\s\S]*?)\n {4}\}/)
  assert.ok(attach && detach)
  assert.match(attach[1], /setAttribute\(ACTIVE_ATTR, ''\)/)
  assert.match(detach[1], /removeAttribute\(ACTIVE_ATTR\)/)

  const wiring = effectSrc.match(/observer = new MutationObserver\(([\s\S]*?)\n {6}\}\)/)
  assert.ok(wiring)
  assert.match(wiring[1], /markWholeRows\(records\)/)
  assert.match(wiring[1], /schedule\(\)/)
  const mark = effectSrc.match(/const markWholeRows = [\s\S]*?\n {4}\}/)
  assert.ok(mark)
  assert.match(mark[0], /foldsWholeRow\(row, thinks\)\) row\.setAttribute\(FOLD, ''\)/)
  assert.match(mark[0], /else row\.removeAttribute\(FOLD\)/)
  assert.match(mark[0], /record\.addedNodes/)
  assert.match(mark[0], /querySelectorAll\(STEP_SELECTOR\)/)
  assert.match(mark[0], /parent === null \|\| !parent\.matches\(FLOW\)/)

  assert.match(effectSrc, /for \(const stale of flow\.querySelectorAll\(`\[\$\{FOLD\}\], \[\$\{OPEN\}\]`\)\)/)
  assert.match(effectSrc, /for \(const item of document\.querySelectorAll\(`\[\$\{FOLD\}\], \[\$\{OPEN\}\]`\)\)/)
})

test('blank-step detection, foldsWholeRow, hasContentOutside, and foldSuppressionTransition', async () => {
  const text = (value) => ({ nodeType: 3, textContent: value, childNodes: [] })
  const el = (tagName, attrs, ...children) => ({
    nodeType: 1,
    tagName,
    attrs,
    childNodes: children,
    get textContent() { return children.map((child) => child.textContent).join('') },
    matches(selector) {
      assert.equal(selector, '[data-variant="think"]')
      return attrs.variant === 'think'
    },
  })
  const think = (summary) => el('DIV', { variant: 'think' }, el('BUTTON', {}, el('svg', {}), el('SPAN', {}, text(summary))))
  const wrapper = (...children) => el('DIV', {}, ...children)
  const row = (...blocks) => el('DIV', { kind: 'assistant-step' }, el('DIV', {}, el('DIV', {}, el('DIV', {}, ...blocks))))

  const { isBlankStep, foldsWholeRow, hasContentOutside, foldSuppressionTransition } = await loadEffect()

  const blank = row(wrapper())
  assert.equal(isBlankStep(blank), true)
  assert.equal(foldsWholeRow(blank, []), false)
  assert.equal(isBlankStep(row(wrapper(), text('\n  '))), true)

  const t = think('Planning the edit')
  const mixed = row(wrapper(t), wrapper())
  assert.equal(foldsWholeRow(mixed, [t]), true)
  assert.equal(isBlankStep(mixed), false)

  const rc2 = think('<signature>abc</signature>')
  const rc2Step = row(wrapper(rc2))
  assert.equal(foldsWholeRow(rc2Step, [rc2]), true)
  assert.equal(isBlankStep(rc2Step), false)

  const t2 = think('Thinking')
  assert.equal(foldsWholeRow(row(wrapper(t2), el('P', {}, text('Here is the answer.'))), [t2]), false)
  assert.equal(foldsWholeRow(row(wrapper(t2), el('DIV', {}, el('IMG', {}))), [t2]), false)
  assert.equal(isBlankStep(row(el('DIV', {}, el('IMG', {})))), false)
  assert.equal(isBlankStep(row(el('SPAN', {}, text('Stopped')))), false)
  assert.equal(isBlankStep(row(el('svg', {}))), false)

  assert.equal(hasContentOutside(wrapper(t2), '[data-variant="think"]'), false)
  assert.equal(hasContentOutside(wrapper(t2), null), true)
  assert.equal(hasContentOutside({ nodeType: 8, textContent: 'comment', childNodes: [] }, null), false)

  assert.equal(foldSuppressionTransition(false, false), 'hold')
  assert.equal(foldSuppressionTransition(true, false), 'enter')
  assert.equal(foldSuppressionTransition(true, true), 'hold')
  assert.equal(foldSuppressionTransition(false, true), 'exit')
})
