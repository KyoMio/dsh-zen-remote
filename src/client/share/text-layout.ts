/**
 * Pure text → segment fold for share-card text blocks (ticket 03).
 *
 * Deliberately NOT a markdown parser: the transcripts the share card renders
 * are *mostly* markdown, and the readability wins that matter on a phone-size
 * image are structures recognizable from line shape alone — fenced/indented
 * code, list items, pipe tables. Everything else stays one pre-wrapped
 * paragraph, which degrades gracefully (raw text still reads), instead of
 * half-parsing markup into broken pseudo-HTML.
 *
 * No React and no DOM in this file on purpose: the share-image check script
 * (ticket 04) imports it through Node type stripping, which rejects JSX, so
 * the fold must live in a JSX-free module.
 */

/** One recognized paragraph shape inside a text block. */
export type ShareTextSegment =
  | { kind: 'para'; text: string }
  | { kind: 'code'; lines: string[] }
  | { kind: 'list'; items: Array<{ marker: string; text: string }> }
  | { kind: 'table'; lines: string[] }

/** ``` / ~~~ fence opener; a language tag after it is allowed and dropped. */
const FENCE_OPEN = /^ {0,3}(```+|~~~+)/
/** A closing fence is the same run of the same character, alone on a line. */
const FENCE_CLOSE: Record<string, RegExp> = {
  '`': /^ {0,3}`{3,}\s*$/,
  '~': /^ {0,3}~{3,}\s*$/,
}
/** 4+ leading spaces or a tab — the classic indented-code threshold. */
const INDENTED = /^(?: {4,}|\t)/
/** `- item` / `* item` / `+ item` / `12. item` / `12) item`. */
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,3}[.)]) +(.*)$/
/** Pipe-table row; must be followed by another pipe row to OPEN a table block
 * (a single stray `|` line stays an ordinary paragraph). */
const TABLE_ROW = /^\s*\|.*\|/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

/**
 * Fold one text block's raw string into display segments, top to bottom.
 *
 * Rules, in the order each line is tested:
 * - ```/~~~ fences switch to verbatim code until the closing fence (or the
 *   end of the block — an unterminated fence must not swallow nothing);
 * - a 4-space/tab indent opens verbatim code; a blank line between two
 *   indented lines stays inside the block (lazy continuation);
 * - two consecutive pipe rows open a table block, collected while rows last;
 * - a `-`/`*`/`+`/`N.`/`N)` line opens a list, collected while items last;
 * - blank lines end the current paragraph; anything else accumulates into the
 *   current paragraph (rendered pre-wrap, so manual line breaks survive).
 * @param text - raw text-block content from the share-export route.
 * @returns the segments in reading order; never contains empty segments.
 */
export function segmentShareText(text: string): ShareTextSegment[] {
  const segments: ShareTextSegment[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let pending: string[] = []
  const flushPending = (): void => {
    if (pending.length > 0) {
      segments.push({ kind: 'para', text: pending.join('\n') })
      pending = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''

    const fence = line.match(FENCE_OPEN)
    if (fence !== null) {
      flushPending()
      const close = FENCE_CLOSE[fence[1]?.[0] ?? '`'] ?? FENCE_CLOSE['`']!
      const body: string[] = []
      i += 1
      while (i < lines.length && !close.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i += 1
      }
      // Skip the closing fence; when the block never closed, this steps past
      // the end and the loop simply ends.
      i += 1
      if (body.length > 0) segments.push({ kind: 'code', lines: body })
      continue
    }

    if (INDENTED.test(line)) {
      flushPending()
      const body: string[] = [line]
      i += 1
      while (i < lines.length) {
        const next = lines[i] ?? ''
        if (INDENTED.test(next)) {
          body.push(next)
          i += 1
          continue
        }
        if (isBlank(next) && INDENTED.test(lines[i + 1] ?? '')) {
          body.push('')
          i += 1
          continue
        }
        break
      }
      segments.push({ kind: 'code', lines: body })
      continue
    }

    if (TABLE_ROW.test(line) && TABLE_ROW.test(lines[i + 1] ?? '')) {
      flushPending()
      const body: string[] = []
      while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i += 1
      }
      segments.push({ kind: 'table', lines: body })
      continue
    }

    if (isBlank(line)) {
      flushPending()
      i += 1
      continue
    }

    const item = line.match(LIST_ITEM)
    if (item !== null) {
      flushPending()
      const items: Array<{ marker: string; text: string }> = []
      while (i < lines.length) {
        const m = (lines[i] ?? '').match(LIST_ITEM)
        if (m === null) break
        items.push({ marker: m[1] ?? '-', text: m[2] ?? '' })
        i += 1
      }
      segments.push({ kind: 'list', items })
      continue
    }

    pending.push(line)
    i += 1
  }
  flushPending()
  return segments
}
