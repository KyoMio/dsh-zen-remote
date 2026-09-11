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
/** One inline run. Emphasis nests by recursion; code/link leaves are atomic. */
export type MdSpan = {
    kind: 'text';
    text: string;
} | {
    kind: 'bold';
    spans: MdSpan[];
} | {
    kind: 'italic';
    spans: MdSpan[];
} | {
    kind: 'strike';
    spans: MdSpan[];
} | {
    kind: 'code';
    text: string;
} | {
    kind: 'link';
    spans: MdSpan[];
    href: string;
};
/** One list item: inline content plus one nested level (the parser's cap). */
export interface MdListItem {
    spans: MdSpan[];
    /** Ordered item number as written (undefined for bullets). */
    number: number | undefined;
    children: MdListItem[];
}
/** Column alignment from the delimiter row (null = unspecified/left). */
export type MdAlign = 'left' | 'center' | 'right' | null;
/** One recognized block. The renderer switches on `kind` only. */
export type MdBlock = {
    kind: 'heading';
    level: number;
    spans: MdSpan[];
} | {
    kind: 'para';
    spans: MdSpan[];
} | {
    kind: 'code';
    lang: string | undefined;
    lines: string[];
} | {
    kind: 'quote';
    children: MdBlock[];
} | {
    kind: 'list';
    ordered: boolean;
    items: MdListItem[];
} | {
    kind: 'table';
    align: MdAlign[];
    header: MdSpan[][];
    rows: MdSpan[][][];
} | {
    kind: 'hr';
} | {
    kind: 'image';
    alt: string;
    src: string;
};
/**
 * Parse a raw text block into the share card's Markdown tree.
 * @param text - raw text-block content from the share-export route.
 * @returns blocks in reading order; `[]` for blank input.
 */
export declare function parseMarkdown(text: string): MdBlock[];
//# sourceMappingURL=markdown.d.ts.map