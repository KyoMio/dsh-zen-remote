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

/* The config fetch is a round-trip and first paint is not, so a desktop
 * reader watched the whole session render unfolded and then collapse, every
 * page load (issue #3). The answer is remembered; the row stays the
 * authority, so a knob turned back off forgets it again. */
test('the row answer is remembered, and forgotten when the row says no', () => {
  assert.match(effect, /DESKTOP_CACHE_KEY = 'dsh-mobile-nav\.turn-fold-desktop-seen'/, 'cache key exists')
  assert.notEqual(
    effect.match(/DESKTOP_CACHE_KEY = '([^']+)'/)[1],
    effect.match(/DESKTOP_KEY = '([^']+)'/)[1],
    'the remembered answer must not collide with the explicit per-browser override',
  )
  const answer = effect.match(/desktopConfigured\(\)\.then\(\(on\) => \{([\s\S]*?)\n {4}\}\)/)
  assert.ok(answer, 'the config answer still drives the switch')
  assert.match(answer[1], /setItem\(DESKTOP_CACHE_KEY, '1'\)/, 'a yes is remembered')
  assert.match(answer[1], /removeItem\(DESKTOP_CACHE_KEY\)/, 'a no is forgotten — the row stays the authority')
})

test('either switch attaches at every width and drops the breakpoint listener', () => {
  const wiring = effect.match(/const enableDesktop = ([\s\S]*?)\n {2}\}, 'dsh-mobile-nav/)
  assert.ok(wiring, 'the desktop switch must drive the attach wiring')
  assert.match(wiring[1], /setAttribute\(DESKTOP_ATTR, ''\)/, 'root attribute is stamped')
  assert.match(wiring[1], /removeAttribute\(DESKTOP_ATTR\)/, 'and removed on cleanup')
  assert.match(wiring[1], /if \(desktopOptIn\(\) \|\| localStorage\.getItem\(DESKTOP_CACHE_KEY\) === '1'\) enableDesktop\(\)/, 'both switches are read synchronously, without a round-trip')
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
    emitted.includes(`[data-chat-flow-kind="assistant-step"]:not([${OPEN}]) ${THINK}:not([${OPEN}])`),
    'Think disclosures are not born folded',
  )
})

/*
 * issue #3 (2026-08-25). Two defects, one cause: the reasoning-only row was
 * the one folded item the stylesheet could not express, so the effect marked
 * it a frame after React committed — long enough to paint a blank band on the
 * way in, and to keep the row hidden for a frame after prose arrived in it.
 * `:has()` does express it, which lets the stylesheet own every hide.
 */

test('the reasoning-only row is marked in the observer callback, not a frame later', () => {
  // The rAF scan lands a painted frame after React commits. Everything else
  // folded is already hidden by BORN_FOLDED before the effect looks; this row
  // is not, so its marking has to happen in the microtask — otherwise the
  // reader sees the flow column's 16px gap as a blank band on the way in, and
  // the row stays hidden for a frame after prose arrives (issue #3).
  const wiring = effect.match(/observer = new MutationObserver\(([\s\S]*?)\n {6}\}\)/)
  assert.ok(wiring, 'the observer wiring moved — re-check what runs synchronously')
  assert.match(wiring[1], /markWholeRows\(records\)/, 'the whole-row fold must be applied synchronously')
  assert.match(wiring[1], /schedule\(\)/, 'the full rescan still coalesces on an animation frame')
  const mark = effect.match(/const markWholeRows = [\s\S]*?\n {4}\}/)
  assert.ok(mark, 'markWholeRows disappeared')
  assert.match(mark[0], /foldsWholeRow\(row, thinks\)\) row\.setAttribute\(FOLD, ''\)/, 'it folds a reasoning-only row')
  assert.match(mark[0], /else row\.removeAttribute\(FOLD\)/, 'and releases the row the moment it stops being one')
  // Insertions report the flow column as target, not the new row, so the added
  // nodes have to be walked too or a fresh row is never marked in time.
  assert.match(mark[0], /record\.addedNodes/, 'a newly inserted row is only reachable through addedNodes')
  assert.match(mark[0], /querySelectorAll\(STEP_SELECTOR\)/, 'a row nested inside an inserted subtree counts too')
  // Mutation records reach the whole document, unlike scan()'s own walk of the
  // flow column. Without this the effect stops being Chat-only and hides rows
  // in any other view that seats chat nodes, with no chip to bring them back.
  assert.match(mark[0], /parent === null \|\| !parent\.matches\(FLOW\)/, 'the sync marker must be scoped to the chat flow column')
})

test('the stale sweep clears open marks, not just folds', () => {
  // A stale attribute outliving the DOM change that ended the fold is the
  // 2026-08-18 bug; OPEN needs the sweep on its own account now, because it is
  // what releases a row from the stylesheet's reasoning rules.
  assert.match(
    effect,
    /for \(const stale of flow\.querySelectorAll\(`\[\$\{FOLD\}\], \[\$\{OPEN\}\]`\)\)/,
    'the stale sweep must clear stale open marks too, not just folds',
  )
  assert.match(
    effect,
    /for \(const item of document\.querySelectorAll\(`\[\$\{FOLD\}\], \[\$\{OPEN\}\]`\)\)/,
    'detach must clear them too, or a folded turn stays folded with no chip to open it',
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
