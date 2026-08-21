const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')
const effect = read('src', 'client', 'effects', 'turn-fold.ts')
const css = read('src', 'client', 'styles', 'turn-fold.css.ts')
const host = read('src', 'index.ts')

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
  const route = effect.match(/const CLIENT_CONFIG_ROUTE = '([^']+)'/)
  assert.ok(route, 'the client mirrors the route path')
  assert.ok(host.includes(`'${route[1]}'`), 'client and host route strings agree')
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

test('the compiled CSS string really contains both copies', () => {
  // Belt over the regexes above: evaluate the template the way the bundle
  // does and check the emitted text, not the source.
  const body = css
    .replace(/^\/\/.*$/gm, '')
    .replace(/\(scope: string\): string =>/, '(scope) =>')
    .replace(/^export const TURN_FOLD_CSS/m, 'const TURN_FOLD_CSS')
  // eslint-disable-next-line no-eval
  const emitted = eval(`${body}; TURN_FOLD_CSS`)
  assert.match(emitted, /@media \(max-width: 767px\) \{[\s\S]*\[data-mnav-fold\]:not\(\[data-mnav-fold-open\]\) \{\s*display: none !important;/)
  assert.match(emitted, /html\[data-mnav-desktop-fold\] \[data-mnav-fold\]:not\(\[data-mnav-fold-open\]\) \{\s*display: none !important;/)
  assert.match(emitted, /html\[data-mnav-desktop-fold\] \[data-chat-flow\] > \[data-mobile-nav="turn-fold"\] \{/)
})
