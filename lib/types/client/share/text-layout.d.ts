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
export type ShareTextSegment = {
    kind: 'para';
    text: string;
} | {
    kind: 'code';
    lines: string[];
} | {
    kind: 'list';
    items: Array<{
        marker: string;
        text: string;
    }>;
} | {
    kind: 'table';
    lines: string[];
};
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
export declare function segmentShareText(text: string): ShareTextSegment[];
//# sourceMappingURL=text-layout.d.ts.map