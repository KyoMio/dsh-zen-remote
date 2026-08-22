const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')
const effect = read('src', 'client', 'effects', 'turn-fold.ts')
const css = read('src', 'client', 'styles', 'turn-fold.css.ts')
const host = read('src', 'index.ts')
/** The shared row-config reader both effects go through (2026-08-22). */
const clientConfig = read('src', 'client', 'client-config.ts')

/*
 * Desktop fold (issue #2), switched on either way: the plugin row's
 * config.turnFoldDesktop (republished by the host at the client-config
 * route, because the client bundle ships statically), or the per-browser
 * override ?mobile-nav-turn-fold=1 persisted to localStorage (=0 clears).
 * Either path attaches at every width and stamps the root attribute the
 * stylesheet keys its width-independent copy of the rules on.
 */

test('the host republishes turnFoldDesktop at the client-config route', () => {
  assert.match(host, /turnFoldDesktop\?: boolean/, 'the config knob exists')
  assert.match(host, /CLIENT_CONFIG_ROUTE = '\/_dsh\/mobile-nav\/client-config'/, 'route path is fixed')
  assert.match(host, /turnFoldDesktop: config\.turnFoldDesktop === true/, 'the route serves the knob as a strict boolean')
  const route = clientConfig.match(/export const CLIENT_CONFIG_ROUTE = '([^']+)'/)
  assert.ok(route, 'the client mirrors the route path')
  assert.ok(host.includes(`'${route[1]}'`), 'client and host route strings agree')
  assert.match(effect, /clientConfig\(\)/, 'the fold reads the row through the shared reader')
})

test('the URL param persists the per-browser override, both directions', () => {
  assert.match(effect, /'dsh-mobile-nav\.turn-fold-desktop'/, 'localStorage key exists')
  assert.match(effect, /'mobile-nav-turn-fold'/, 'URL param exists')
  assert.match(effect, /localStorage\.setItem\(DESKTOP_KEY, '1'\)/, '=1 opts in')
  assert.match(effect, /localStorage\.removeItem\(DESKTOP_KEY\)/, '=0 opts back out')
})

test('either switch attaches at every width and drops the breakpoint listener', () => {
  const wiring = effect.match(/const enableDesktop = ([\s\S]*?)\n {2}\}, 'dsh-mobile-nav/)
  assert.ok(wiring, 'the desktop switch must drive the attach wiring')
  assert.match(wiring[1], /setAttribute\(DESKTOP_ATTR, ''\)/, 'root attribute is stamped')
  assert.match(wiring[1], /removeAttribute\(DESKTOP_ATTR\)/, 'and removed on cleanup')
  assert.match(wiring[1], /if \(desktopOptIn\(\)\) enableDesktop\(\)/, 'local override wins without a round-trip')
  assert.match(wiring[1], /desktopConfigured\(\)\.then/, 'row config is honoured when the override is absent')
  assert.match(wiring[1], /if \(narrow\.matches\) attach\(\)\s*\n\s*narrow\.addEventListener/, 'phone breakpoint attaches before the config answer arrives')
  assert.match(effect, /if \(desktop \|\| disposed\) return/, 'a late config answer after dispose is a no-op')
})

test('the stylesheet emits the same rule block for phone and for the opt-in scope', () => {
  // Authored once, emitted twice — the template is what keeps the two copies
  // from drifting. Both call sites must go through it.
  assert.match(css, /@media \(max-width: 767px\) \{\$\{rules\(''\)\}\}/, 'phone copy is the template')
  assert.match(css, /\$\{rules\('html\[data-mnav-desktop-fold\]'\)\}/, 'desktop copy is scoped to the root attribute')
  const hides = css.match(/\$\{scope\} \[data-mnav-fold\]:not\(\[data-mnav-fold-open\]\)/g)
  assert.ok(hides !== null && hides.length === 1, 'the hiding rule lives only inside the shared template')
})

/** The constants the stylesheet imports from the effect, read back out of
 * the effect's own source: the eval harness below has to stand in for that
 * import, and parsing them here is what keeps a stale hand-written copy in
 * either file from passing. */
const constantOf = (name, pattern) => {
  const found = effect.match(pattern)
  assert.ok(found, `effects/turn-fold.ts no longer exports ${name}`)
  return found[1]
}
const PROCESS_KINDS = constantOf('PROCESS_KINDS', /export const PROCESS_KINDS = \[([^\]]+)\]/)
  .split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
const THINK = constantOf('THINK', /export const THINK = '([^']+)'/)
const OPEN = constantOf('OPEN', /export const OPEN = '([^']+)'/)
const ACTIVE = constantOf('ACTIVE_ATTR', /const ACTIVE_ATTR = '([^']+)'/)

/** The stylesheet's emitted text, evaluated the way the bundle does. */
const emit = () => {
  const body = css
    .replace(/^\/\/.*$/gm, '')
    .replace(/^import .*$/gm, '')
    .replace(/\(scope: string\): string =>/, '(scope) =>')
    .replace(/^export const TURN_FOLD_CSS/m, 'const TURN_FOLD_CSS')
  const head = `const PROCESS_KINDS = ${JSON.stringify(PROCESS_KINDS)},`
    + ` THINK = ${JSON.stringify(THINK)}, OPEN = ${JSON.stringify(OPEN)};`
  // eslint-disable-next-line no-eval
  return eval(`${head} ${body}; TURN_FOLD_CSS`)
}

test('the compiled CSS string really contains both copies', () => {
  // Belt over the regexes above: evaluate the template the way the bundle
  // does and check the emitted text, not the source.
  const emitted = emit()
  assert.match(emitted, /@media \(max-width: 767px\) \{[\s\S]*\[data-mnav-fold\]:not\(\[data-mnav-fold-open\]\) \{\s*display: none !important;/)
  assert.match(emitted, /html\[data-mnav-desktop-fold\] \[data-mnav-fold\]:not\(\[data-mnav-fold-open\]\) \{\s*display: none !important;/)
  assert.match(emitted, /html\[data-mnav-desktop-fold\] \[data-chat-flow\] > \[data-mobile-nav="turn-fold"\] \{/)
})


/*
 * Born folded (2026-08-22). The effect marks process rows on the animation
 * frame AFTER React inserts them, so a new tool call used to paint once,
 * visible, and then vanish. The stylesheet now hides those rows by the
 * host's own markers, which React sets in the same commit that inserts the
 * row — nothing to flash. The effect's rescan still runs; it just no longer
 * owns the hiding.
 */

test('the effect holds a root attribute for exactly as long as it is attached', () => {
  const attach = effect.match(/const attach = \(\): void => \{([\s\S]*?)\n {4}\}/)
  const detach = effect.match(/const detach = \(\): void => \{([\s\S]*?)\n {4}\}/)
  assert.ok(attach && detach, 'attach/detach still exist')
  assert.match(attach[1], /setAttribute\(ACTIVE_ATTR, ''\)/, 'attach stamps the attribute')
  assert.match(detach[1], /removeAttribute\(ACTIVE_ATTR\)/, 'detach drops it — nothing stays hidden')
})

test('every process kind the effect folds is also born folded', () => {
  const emitted = emit()
  assert.ok(PROCESS_KINDS.length > 0, 'the kind list parsed')
  for (const kind of PROCESS_KINDS) {
    assert.ok(
      emitted.includes(`html[${ACTIVE}] [data-chat-flow] > [data-chat-flow-kind="${kind}"]:not([${OPEN}])`),
      `"${kind}" folds a frame late — it will flash in and then fold away`,
    )
  }
  assert.ok(
    emitted.includes(`[data-chat-flow-kind="assistant-step"] ${THINK}:not([${OPEN}])`),
    'Think disclosures are not born folded',
  )
  // The step's prose is the reply itself; only the effect may hide such a row
  // whole, and only when reasoning is all it holds (foldsWholeRow).
  assert.ok(
    !emitted.includes(`> [data-chat-flow-kind="assistant-step"]:not([${OPEN}])`),
    'born-folded would hide whole assistant-step rows — that hides the reply',
  )
})

test('no rule can hide host content outside an active fold', () => {
  // The dangerous regression this file exists to catch: an unscoped
  // display:none here blanks tool calls and reasoning for every desktop
  // reader of the plain web UI, with no chip to bring them back.
  const emitted = emit().replace(/\/\*[\s\S]*?\*\//g, '')
  const phone = emitted.indexOf('@media (max-width: 767px) {')
  assert.notEqual(phone, -1, 'the phone media query disappeared')
  let depth = 0
  let phoneEnd = -1
  for (let i = emitted.indexOf('{', phone); i < emitted.length && phoneEnd === -1; i += 1) {
    if (emitted[i] === '{') depth += 1
    else if (emitted[i] === '}' && (depth -= 1) === 0) phoneEnd = i
  }
  assert.notEqual(phoneEnd, -1, 'unbalanced braces in the phone media query')

  for (let at = emitted.indexOf('display: none'); at !== -1; at = emitted.indexOf('display: none', at + 1)) {
    const brace = emitted.lastIndexOf('{', at)
    const from = Math.max(emitted.lastIndexOf('}', brace), emitted.lastIndexOf('{', brace - 1))
    // Comma lists are checked one selector at a time: a gated sibling must
    // not vouch for an ungated one.
    for (const selector of emitted.slice(from + 1, brace).split(',').map((one) => one.trim())) {
      // The one deliberate exception: our OWN summary row, hidden by default
      // so it can never paint outside the scope that created it.
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
