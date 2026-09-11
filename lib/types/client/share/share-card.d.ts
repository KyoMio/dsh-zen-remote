/**
 * Share-card pure template (ticket 03, PLAN §5.1): renders the share-export
 * transcript JSON as one self-styled card — header strip, user bubbles,
 * assistant prose, brand footer.
 *
 * Hard rule for this file: EVERY element carries only an inline `style`, no
 * `className`, no style-module imports. The ticket-04 rasterizer deep-clones
 * this tree into an SVG `<foreignObject>` and paints it as an image — an
 * image loads no stylesheets, so the card must be fully self-describing. The
 * same rule is why wide content (long code lines, pipe tables) renders at
 * natural width with `overflow` left visible: hiding or clipping it here
 * would silently drop it from the exported PNG (adaptive slice width is
 * ticket 04's job; this template just must never lie about content width).
 */
import type { ReactNode } from 'react';
/** One exportable content block of a transcript row. */
export type ShareBlock = {
    kind: 'text';
    text: string;
} | {
    kind: 'image';
};
/** One transcript row; `seq` (log position) doubles as the React key. */
export interface ShareTurn {
    role: 'user' | 'assistant';
    seq: number;
    blocks: ShareBlock[];
}
/** Concrete colors/fonts the template bakes into its inline styles. */
export interface ShareTheme {
    /** Primary prose color (--dsw-alias-label-primary). */
    text: string;
    /** Header meta / secondary text (--dsw-alias-label-secondary). */
    textSecondary: string;
    /** Footer / caption text (--dsw-alias-label-tertiary). */
    textTertiary: string;
    /** Card background (--dsw-alias-bg-base). */
    cardBg: string;
    /** Code/table block background (--dsw-alias-markdown-code-block). */
    codeBg: string;
    /** User-bubble fill (--dsw-alias-brand-primary). */
    bubbleBg: string;
    /** User-bubble text (--dsw-alias-label-primary-foreground). */
    bubbleText: string;
    /** Brand accent (--dsw-alias-state-business-primary, DeepSeek blue). */
    accent: string;
    /** Hairline color (--dsw-alias-border-l2). */
    border: string;
    /** Sans font stack (--dsw-font-family). */
    fontFamily: string;
    /** Mono font stack (--ds-font-family-code). */
    monoFamily: string;
}
/** Light-palette fallback (resolved values from the host theme package). */
export declare const DEFAULT_SHARE_THEME: ShareTheme;
/**
 * Read the host theme once (per render call). A raw value that still contains
 * `var(` means the engine returned it un-substituted — treated as missing so
 * the default palette wins over a broken declaration.
 * @returns concrete theme values for this render.
 */
export declare function readShareTheme(): ShareTheme;
/** Localizable strings baked into the shared image (via locales `t`). */
export interface ShareCardCopy {
    /** Header turn count, e.g. "3 轮对话". */
    turnsLabel: (count: number) => string;
    /** Footer attribution, e.g. "由 DeepSeek Harness 生成". */
    generatedBy: string;
    /** Image-attachment placeholder caption. */
    image: string;
}
/** ShareCard props. All style decisions are internal; data in, pixels out. */
export interface ShareCardProps {
    /** Session display title (header strip). */
    title: string;
    /** Optional second header line (agent preset / model). */
    subtitle?: string;
    /** Session creation time (epoch ms); omitted from the header when missing. */
    createdAt?: number;
    /** Transcript rows in conversation order. */
    turns: readonly ShareTurn[];
    /** Logical width in px (default 390; ticket 04 passes wider for wide slices). */
    width?: number;
    /** Localized strings, see {@link ShareCardCopy}. */
    copy: ShareCardCopy;
}
/**
 * The share card. A pure template: no hooks, no effects, no context — the
 * same JSX must render identically inside the page (preview) and inside a
 * cloned `<foreignObject>` (rasterize).
 */
export declare function ShareCard({ title, subtitle, createdAt, turns, width, copy }: ShareCardProps): ReactNode;
//# sourceMappingURL=share-card.d.ts.map