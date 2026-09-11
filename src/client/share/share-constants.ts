/**
 * Template constants the share card and its rasterizer MUST agree on
 * (tickets 03/04; the width-lifting formulas in rasterize.ts invert the
 * template's own constraints, so a diverging copy would mis-bucket wide
 * content). Formerly duplicated as literals in share-card.tsx and re-derived
 * in rasterize.ts with a regex lock in the check script; both sides now
 * import this single module, and scripts/check-share-image.mjs asserts its
 * values directly.
 *
 * Hard rule for this file: a pure leaf — no imports, no JSX, no DOM, no
 * module side effects. Node type stripping executes every value import, and
 * both the check script and the client bundler rely on this module being
 * loadable anywhere.
 */

/** Base logical card width (share-card.tsx default render width). */
export const BASE_CARD_WIDTH = 390

/** Widened slice width for wide content (PLAN §5.2 “更大逻辑宽 ~780”). */
export const WIDE_SLICE_WIDTH = 780

/**
 * User-bubble width cap relative to its row (`maxWidth` in share-card.tsx,
 * e.g. 0.82 → '82%'). cardWidthForUserBubble inverts this percentage into a
 * division, so the two sides must be the same number.
 */
export const USER_BUBBLE_MAX_RATIO = 0.82

/** Horizontal padding inside the user bubble (its `padding` X component). */
export const USER_BUBBLE_PAD_X = 14
