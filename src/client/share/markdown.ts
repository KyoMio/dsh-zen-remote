/**
 * Pure lenient Markdown-subset parser for the share card's assistant text
 * (ticket 09, PLAN §5.1 v1.2).
 *
 * Scope = the constructs assistant transcripts actually use: ATX headings,
 * paragraphs, ```/~~~ fenced code (with the language tag), 4-space indented
 * code, blockquotes, ordered/unordered lists (two indent levels, 2-space
 * multiples), GFM pipe tables with an alignment row, thematic breaks, and
 * own-line image placeholders; inline bold/italic/strikethrough/code/link with
 * backslash escapes. Nothing else — no HTML passthrough, no reference links,
 * no setext headings, no syntax highlighting (PLAN §8 scope discipline).
 *
 * Leniency beats strictness ON PURPOSE (PLAN §5.1): a share image that shows
 * stray asterisks is worse than one that shows plain text. Every marker pair
 * must CLOSE before it counts — unclosed, empty or implausible markers fall
 * back to their literal characters, so arbitrary prose round-trips as itself.
 * The parser is also total: any input yields a tree (empty input yields []).
 * Totality is enforced, not assumed: recursion (nested quotes, emphasis inside
 * link text) carries a depth counter and a pathological 5000-deep "> > > …"
 * degrades to literal paragraphs instead of overflowing the stack; one inline
 * run longer than {@link INLINE_PLAIN_MAX} skips inline parsing entirely —
 * every close-scan is then bounded, so no amount of unclosed markers can
 * regress past linear time.
 *
 * Hard rule for this file: no imports, no JSX, no DOM, no module side effects.
 * scripts/check-share-image.mjs loads it through Node type stripping, which
 * EXECUTES every value import, and the client bundler inlines it next to
 * share-card without new externals.
 */

/* ---- inline span tree ------------------------------------------------------- */

/** One inline run. Emphasis nests by recursion; code/link leaves are atomic. */
export type MdSpan =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; spans: MdSpan[] }
  | { kind: 'italic'; spans: MdSpan[] }
  | { kind: 'strike'; spans: MdSpan[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; spans: MdSpan[]; href: string }

/* ---- block tree -------------------------------------------------------------- */

/** One list item: inline content plus one nested level (the parser's cap). */
export interface MdListItem {
  spans: MdSpan[]
  /** Ordered item number as written (undefined for bullets). */
  number: number | undefined
  children: MdListItem[]
}

/** Column alignment from the delimiter row (null = unspecified/left). */
export type MdAlign = 'left' | 'center' | 'right' | null

/** One recognized block. The renderer switches on `kind` only. */
export type MdBlock =
  | { kind: 'heading'; level: number; spans: MdSpan[] }
  | { kind: 'para'; spans: MdSpan[] }
  | { kind: 'code'; lang: string | undefined; lines: string[] }
  | { kind: 'quote'; children: MdBlock[] }
  | { kind: 'list'; ordered: boolean; items: MdListItem[] }
  | { kind: 'table'; align: MdAlign[]; header: MdSpan[][]; rows: MdSpan[][][] }
  | { kind: 'hr' }
  | { kind: 'image'; alt: string; src: string }

/* ---- shared character helpers ------------------------------------------------ */

/** Whitespace test for the opener/closer flanking rules; EOL counts as space. */
function isWs(ch: string | undefined): boolean {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n'
}

/** CommonMark's escapable set: one ASCII punctuation char after a backslash. */
const ESCAPABLE = new Set<string>('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''))

/**
 * Nesting ceiling shared by the block and inline recursion (a quote inside a
 * quote, emphasis inside link text). Real transcripts never approach it; past
 * the ceiling the nested content degrades to literal text instead of growing
 * the native stack — a synthetic 5000-deep "> " chain used to throw.
 */
const MAX_DEPTH = 64

/**
 * One inline run longer than this parses as plain text, no markers. Keeps the
 * close-marker scans bounded: unclosed "*a *a *a …" prose is quadratic in the
 * classic scan-per-opener shape, and a share-card paragraph this long (4k+
 * chars with no blank line) has no plausible emphasis anyway.
 */
const INLINE_PLAIN_MAX = 4096

/* ---- inline parser ----------------------------------------------------------- */

/**
 * Parse one inline run into spans. Scans left to right; backslash escapes and
 * code spans are handled first (their content is literal), then emphasis and
 * links. Anything that does not close cleanly is emitted as literal text.
 */
function parseInline(raw: string, depth = 0): MdSpan[] {
  // Depth or length guard (see the constants above): degrade to plain text.
  if (depth >= MAX_DEPTH || raw.length > INLINE_PLAIN_MAX) {
    return raw === '' ? [] : [{ kind: 'text', text: raw }]
  }
  const spans: MdSpan[] = []
  let buf = ''
  const flush = (): void => {
    if (buf !== '') {
      spans.push({ kind: 'text', text: buf })
      buf = ''
    }
  }
  const n = raw.length
  let i = 0
  while (i < n) {
    const ch = raw[i]!

    if (ch === '\\') {
      const next = raw[i + 1]
      if (next !== undefined && ESCAPABLE.has(next)) {
        buf += next
        i += 2
      } else {
        buf += '\\'
        i += 1
      }
      continue
    }

    if (ch === '`') {
      const run = tickRun(raw, i)
      const close = findTickRun(raw, i + run, run)
      if (close !== -1) {
        flush()
        spans.push({ kind: 'code', text: raw.slice(i + run, close) })
        i = close + run
      } else {
        buf += '`'
        i += 1
      }
      continue
    }

    if (ch === '*') {
      const run = starRun(raw, i)
      // Try the longest marker first (*** = bold(italic)), then **, then *.
      const lengths = run >= 3 ? [3, 2, 1] : run === 2 ? [2, 1] : [1]
      let matched = false
      for (const len of lengths) {
        if (matched) break
        // Left-flanking: an opener must be immediately followed by a
        // non-space character (so "5 * 3" never italicizes).
        if (isWs(raw[i + len])) continue
        const close = findStarClose(raw, i + len, len)
        if (close === -1) continue
        const content = raw.slice(i + len, close)
        if (content.trim() === '') continue
        flush()
        const inner = parseInline(content, depth + 1)
        if (len === 3) spans.push({ kind: 'bold', spans: [{ kind: 'italic', spans: inner }] })
        else if (len === 2) spans.push({ kind: 'bold', spans: inner })
        else spans.push({ kind: 'italic', spans: inner })
        i = close + len
        matched = true
      }
      if (!matched) {
        buf += '*'
        i += 1
      }
      continue
    }

    if (ch === '~' && raw[i + 1] === '~') {
      const close = findStrikeClose(raw, i + 2)
      if (close !== -1 && raw.slice(i + 2, close).trim() !== '') {
        flush()
        spans.push({ kind: 'strike', spans: parseInline(raw.slice(i + 2, close), depth + 1) })
        i = close + 2
        continue
      }
      // Unclosed ~~ (or a lone ~): literal tilde, one char at a time.
      buf += '~'
      i += 1
      continue
    }

    if (ch === '[') {
      const link = tryLink(raw, i, depth)
      if (link !== undefined) {
        flush()
        spans.push(link.span)
        i = link.end
        continue
      }
      buf += '['
      i += 1
      continue
    }

    buf += ch
    i += 1
  }
  flush()
  return spans
}

/** Length of the backtick run starting at `start`. */
function tickRun(raw: string, start: number): number {
  let n = 0
  while (raw[start + n] === '`') n += 1
  return n
}

/** Length of the asterisk run starting at `start`. */
function starRun(raw: string, start: number): number {
  let n = 0
  while (raw[start + n] === '*') n += 1
  return n
}

/**
 * Find the closing backtick run of EXACT length `len` at/after `from` (a code
 * span closes only on a matching run, per CommonMark). Escapes do not apply
 * inside code spans, so every tick is a tick.
 */
function findTickRun(raw: string, from: number, len: number): number {
  let j = from
  while (j + len <= raw.length) {
    if (raw[j] !== '`') {
      j += 1
      continue
    }
    let k = 0
    while (k < len && raw[j + k] === '`') k += 1
    if (k === len && raw[j + len] !== '`') return j
    while (raw[j] === '`') j += 1 // inside a longer run: skip it whole
  }
  return -1
}

/**
 * Find a `*` closer of length `len` at/after `from`: the run must match EXACTLY
 * (a longer run cannot close a shorter marker — `*a **b** c*` must find its
 * single-star closer past the inner bold pair, not the first half of it), be
 * preceded by a non-space character (right-flanking), and escaped stars are
 * skipped. Mirrors findTickRun's exact-length guard.
 */
function findStarClose(raw: string, from: number, len: number): number {
  let j = from
  while (j + len <= raw.length) {
    if (raw[j] === '\\') {
      j += 2
      continue
    }
    if (raw[j] === '*') {
      let k = 0
      while (k < len && raw[j + k] === '*') k += 1
      if (k === len && raw[j + len] !== '*' && raw[j - 1] !== undefined && !isWs(raw[j - 1]!)) return j
      while (raw[j] === '*') j += 1
      continue
    }
    j += 1
  }
  return -1
}

/**
 * Find a `~~` closer at/after `from`, preceded by a non-space character. The
 * run must be exactly two tildes — a `~~~` fence-looking run is not a strike
 * closer (same exact-length rule as findStarClose).
 */
function findStrikeClose(raw: string, from: number): number {
  let j = from
  while (j + 2 <= raw.length) {
    if (raw[j] === '\\') {
      j += 2
      continue
    }
    if (raw[j] === '~') {
      if (raw[j + 1] === '~' && raw[j + 2] !== '~' && raw[j - 1] !== undefined && !isWs(raw[j - 1]!)) return j
      // Not a closer (start of a longer run, or wrong flanking): skip the
      // WHOLE run — advancing one char would let positions 2–3 of a `~~~`
      // triple pose as an exact `~~` closer.
      while (raw[j] === '~') j += 1
      continue
    }
    j += 1
  }
  return -1
}

/**
 * Try to read `[text](href)` starting at the `[` at `start`. The destination
 * must be a bare URL (no whitespace, no parentheses) — that requirement is
 * what keeps prose like "[see (note)](aside)" from turning into links.
 * Empty link text displays the URL itself.
 */
function tryLink(raw: string, start: number, depth: number): { span: MdSpan; end: number } | undefined {
  let j = start + 1
  while (j < raw.length && raw[j] !== ']') {
    j += raw[j] === '\\' ? 2 : 1
  }
  if (j >= raw.length || raw[j + 1] !== '(') return undefined
  let k = j + 2
  while (k < raw.length && raw[k] !== ')') {
    k += raw[k] === '\\' ? 2 : 1
  }
  if (k >= raw.length) return undefined
  const href = raw.slice(j + 2, k)
  if (/[\s()]/.test(href)) return undefined
  const text = raw.slice(start + 1, j)
  return {
    span: { kind: 'link', spans: parseInline(text === '' ? href : text, depth + 1), href },
    end: k + 1,
  }
}

/* ---- block parser ------------------------------------------------------------ */

/** ```/~~~ fence opener; the info string after it becomes the language tag. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/
/** 4+ leading spaces or a tab — the indented-code threshold (as text-layout). */
const INDENTED = /^(?: {4,}|\t)/
/** 3+ of one char (- * _) with optional spaces between — a thematic break. */
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
/** ATX heading: 1–6 hashes, then space(s) + text (or nothing). */
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
/** Own-line image: `![alt](src)` with a bare-URL src (alt may be empty). */
const IMAGE_LINE = /^ {0,3}!\[([^[\]]*)\]\(([^()[\]\s]*)\)[ \t]*$/
/** Blockquote prefix; the single space after `>` is consumed with it. */
const QUOTE_PREFIX = /^ {0,3}>[ \t]?/
/**
 * List item: up to 8 leading spaces (the block loop routes ≥4-space lines at
 * document level to indented code, so inside a list collection the wider
 * indents simply land on the nested level), then a bullet or `N.`/`N)` marker
 * and space-separated content. The space is REQUIRED after the marker, which
 * is what keeps "3.14" a paragraph.
 */
const LIST_ITEM = /^( {0,8})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/
/** One delimiter-row cell: ---, :--, --:, :-: (at least one hyphen). */
const DELIM_CELL = /^:?-+:?$/

/** Split a pipe row into trimmed cells; edge pipes are dropped when empty. */
function splitCells(line: string): string[] {
  let cells = line.split('|')
  if (cells.length > 1) {
    if (cells[0]!.trim() === '') cells = cells.slice(1)
    if (cells.length > 1 && cells[cells.length - 1]!.trim() === '') cells = cells.slice(0, -1)
  }
  return cells.map((cell) => cell.trim())
}

/** Delimiter-row test: has a pipe, and every cell is ---/:--/--:/:-:. */
function isDelimiterRow(line: string): boolean {
  if (!line.includes('|')) return false
  const cells = splitCells(line)
  return cells.length > 0 && cells.every((cell) => cell !== '' && DELIM_CELL.test(cell))
}

/** Column alignment from one delimiter cell. */
function alignOf(cell: string): MdAlign {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/** Parse a list-item line; undefined when the line is not an item. */
function matchListItem(line: string): { indent: number; ordered: boolean; number: number | undefined; text: string } | undefined {
  const m = line.match(LIST_ITEM)
  if (m === null) return undefined
  const marker = m[2]!
  const ordered = /^\d/.test(marker)
  return {
    indent: m[1]!.length,
    ordered,
    number: ordered ? Number.parseInt(marker, 10) : undefined,
    text: m[3] ?? '',
  }
}

/** Count leading spaces (a tab counts as the 4 that make indented code). */
function leadingSpaces(line: string): number {
  if (line.startsWith('\t')) return 4
  let n = 0
  while (line[n] === ' ') n += 1
  return n
}

/** Parse a run of lines into blocks (also the recursion entry for quotes). */
function parseBlocks(lines: readonly string[], depth = 0): MdBlock[] {
  const blocks: MdBlock[] = []
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ kind: 'para', spans: parseInline(para.join('\n'), depth) })
      para = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    if (line.trim() === '') {
      flushPara()
      i += 1
      continue
    }

    const fence = line.match(FENCE_OPEN)
    if (fence !== null) {
      flushPara()
      const ch = fence[1]![0]!
      const close = ch === '`' ? /^ {0,3}`{3,}[ \t]*$/ : /^ {0,3}~{3,}[ \t]*$/
      const body: string[] = []
      i += 1
      while (i < lines.length && !close.test(lines[i]!)) {
        body.push(lines[i]!)
        i += 1
      }
      // Past the closing fence; an unterminated fence just ends the block.
      i += 1
      const info = fence[2]?.trim() ?? ''
      blocks.push({ kind: 'code', lang: info === '' ? undefined : info, lines: body })
      continue
    }

    // Indented code cannot interrupt a paragraph (CommonMark) — with one open
    // the line is an ordinary continuation below.
    if (para.length === 0 && INDENTED.test(line)) {
      const strip = (s: string): string => s.replace(/^(?: {4}|\t)/, '')
      const body: string[] = [strip(line)]
      i += 1
      while (i < lines.length) {
        const next = lines[i]!
        if (INDENTED.test(next)) {
          body.push(strip(next))
          i += 1
          continue
        }
        // A blank line between indented lines stays inside the block (lazy).
        if (next.trim() === '' && INDENTED.test(lines[i + 1] ?? '')) {
          body.push('')
          i += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'code', lang: undefined, lines: body })
      continue
    }

    if (HR.test(line)) {
      flushPara()
      blocks.push({ kind: 'hr' })
      i += 1
      continue
    }

    const heading = line.match(HEADING)
    if (heading !== null) {
      flushPara()
      blocks.push({ kind: 'heading', level: heading[1]!.length, spans: parseInline((heading[2] ?? '').trim(), depth) })
      i += 1
      continue
    }

    const image = line.match(IMAGE_LINE)
    if (image !== null) {
      flushPara()
      blocks.push({ kind: 'image', alt: image[1] ?? '', src: image[2] ?? '' })
      i += 1
      continue
    }

    if (line.includes('|') && isDelimiterRow(lines[i + 1] ?? '')) {
      flushPara()
      const headerCells = splitCells(line)
      const alignCells = splitCells(lines[i + 1]!)
      const align: MdAlign[] = headerCells.map((_, c) => (c < alignCells.length ? alignOf(alignCells[c]!) : null))
      i += 2
      const rows: string[][] = []
      while (i < lines.length) {
        const row = lines[i]!
        if (row.trim() === '' || !row.includes('|')) break
        rows.push(splitCells(row))
        i += 1
      }
      blocks.push({
        kind: 'table',
        align,
        header: headerCells.map((cell) => parseInline(cell, depth)),
        // Rows ride the header's column count: short rows pad, extras drop.
        rows: rows.map((cells) => headerCells.map((_, c) => parseInline(cells[c] ?? '', depth))),
      })
      continue
    }

    if (/^ {0,3}>/.test(line)) {
      flushPara()
      const inner: string[] = []
      while (i < lines.length && /^ {0,3}>/.test(lines[i]!)) {
        inner.push(lines[i]!.replace(QUOTE_PREFIX, ''))
        i += 1
      }
      // Depth guard (MAX_DEPTH): past the ceiling the quoted lines degrade to
      // a plain paragraph instead of recursing — a synthetic "> > > …" chain
      // deep enough used to overflow the native stack.
      blocks.push(depth + 1 >= MAX_DEPTH
        ? { kind: 'para', spans: [{ kind: 'text', text: inner.join('\n') }] }
        : { kind: 'quote', children: parseBlocks(inner, depth + 1) })
      continue
    }

    {
      const item = matchListItem(line)
      // Only 0–3-space indents OPEN a list at block level; deeper indents are
      // indented code (para closed) or paragraph continuation (para open).
      // Inside collectList the wider indents land on the nested level.
      if (item !== undefined && item.indent <= 3) {
        flushPara()
        const collected = collectList(lines, i, depth)
        blocks.push(collected.block)
        i = collected.next
        continue
      }
    }

    para.push(line)
    i += 1
  }
  flushPara()
  return blocks
}

/** Mutable collection item; spans are parsed once the run is complete. */
interface RawItem {
  text: string[]
  number: number | undefined
  children: RawItem[]
}

/**
 * Collect one list block starting at `start` (a list-item line).
 *
 * Rules: marker lines with ≥2 leading spaces nest under the last top-level
 * item (capped at the parser's two levels); a non-marker line indented ≥2
 * spaces lazily continues the deepest open item; a blank line keeps the list
 * open only when the next non-blank line is a same-kind item (loose lists);
 * anything else ends the block.
 */
function collectList(lines: readonly string[], start: number, depth: number): { block: MdBlock; next: number } {
  const ordered = matchListItem(lines[start]!)!.ordered
  const items: RawItem[] = []
  const deepest = (): RawItem | undefined => {
    const top = items[items.length - 1]
    if (top === undefined) return undefined
    return top.children[top.children.length - 1] ?? top
  }
  let i = start
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') {
      let j = i + 1
      while (j < lines.length && lines[j]!.trim() === '') j += 1
      const nextItem = j < lines.length ? matchListItem(lines[j]!) : undefined
      if (nextItem !== undefined && nextItem.ordered === ordered) {
        i = j
        continue
      }
      break
    }
    const m = matchListItem(line)
    if (m !== undefined) {
      if (m.ordered !== ordered) break
      const raw: RawItem = { text: [m.text], number: m.number, children: [] }
      if (m.indent >= 2 && items.length > 0) items[items.length - 1]!.children.push(raw)
      else items.push(raw)
      i += 1
      continue
    }
    if (leadingSpaces(line) >= 2) {
      const target = deepest()
      if (target !== undefined) {
        target.text.push(line.trim())
        i += 1
        continue
      }
    }
    break
  }
  const finish = (raw: RawItem): MdListItem => ({
    spans: parseInline(raw.text.join('\n'), depth),
    number: raw.number,
    children: raw.children.map(finish),
  })
  return { block: { kind: 'list', ordered, items: items.map(finish) }, next: i }
}

/**
 * Parse a raw text block into the share card's Markdown tree.
 * @param text - raw text-block content from the share-export route.
 * @returns blocks in reading order; `[]` for blank input.
 */
export function parseMarkdown(text: string): MdBlock[] {
  return parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'))
}
