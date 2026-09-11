/**
 * Share-card slicing + rasterization (ticket 04, PLAN §5.2).
 *
 * Turns a rendered ShareCard DOM tree (ticket 03: fully inline-styled, marked
 * with data-share-card / -header / -turn / -role / -footer) into a sequence of
 * PNG blobs: slice by measured turn heights under a per-slice canvas pixel
 * budget, then paint each slice through
 * `<svg><foreignObject>` → Image → canvas → PNG export. The SVG document
 * carries each slice's PHYSICAL target size (intrinsic = canvas), so the image
 * rasterizes sharp at the canvas's own resolution and the draw is a 1:1 copy.
 *
 * File layout, and why it matters:
 * - The top half is PURE planning math (no DOM, no React). It may import
 *   ONLY the pure constants module of this directory (share-constants.ts):
 *   scripts/check-share-image.mjs imports this file through Node type
 *   stripping, which EXECUTES every value import — JSX or DOM code would
 *   break the check, and any other module would widen the client bundle.
 * - The DOM half below only MEASURES and EXECUTES the pure plan's decisions:
 *   slice grouping, width lifting, scale factors, pixel-ratio fallback and
 *   truncation are all decided by the pure functions, and the SVG document the
 *   painter draws is built by a pure serializer — so tests can pin all of it.
 *
 * Release policy per slice (PLAN §5.2): each slice is painted, blobbed and its
 * canvas dropped before the next slice is built — the export never holds more
 * than one live canvas. Ticket 07 adds the `unified` planning mode whose
 * single physical width lets png-stitch.ts concatenate the slice PNGs into
 * one long image.
 */
/** Per-slice physical pixel budget (iOS canvas hard cap 16.7M minus margin). */
export declare const SLICE_PIXEL_BUDGET = 12000000;
/** Slice count ceiling; beyond it the head is dropped and the first slice marked. */
export declare const MAX_SLICES = 24;
/** Pixel-ratio fallback ladder, walked top-down from min(devicePixelRatio, 2). */
export declare const PIXEL_RATIO_STEPS: readonly number[];
/** Safety px added around computed ultra widths (sub-pixel + rounding slack). */
export declare const ULTRA_WIDTH_MARGIN = 2;
/**
 * Machine-readable failure kinds; ticket 05 maps them to localized copy.
 * `slice-over-budget` (review 07+08): a unified-mode slice whose freshly
 * MEASURED height busts the per-slice canvas budget at the global stitch
 * width — the planner's global lever should have prevented it, and the old
 * behavior (floor the height, silently clip the bottom) was invisible data
 * loss, so it fails loudly instead.
 */
export type ShareRasterizeErrorCode = 'probe-failed' | 'image-load' | 'canvas' | 'empty-card' | 'slice-over-budget';
/** Localizable rasterize failure. `code` drives UI copy, `detail` is diagnostic. */
export declare class ShareRasterizeError extends Error {
    readonly code: ShareRasterizeErrorCode;
    readonly detail: string;
    constructor(code: ShareRasterizeErrorCode, detail: string);
}
/** Descending pixel-ratio candidates for an already-clamped cap; never empty. */
export declare function ratioChain(cap: number): number[];
/** Physical pixels a slice occupies once painted (rounding up, canvas-style). */
export declare function slicePixelCount(outWidth: number, outHeight: number, pixelRatio: number): number;
/** Physical raster geometry of one slice: svg/foreignObject/canvas all take these. */
export interface RasterGeometry {
    /** Physical px width (>= 1). */
    width: number;
    /** Physical px height (>= 1). */
    height: number;
    /** Wrapper transform = scale × pixelRatio (further shrunk when clamped). */
    transformScale: number;
}
/**
 * Physical target size for one slice's raster. The svg/foreignObject
 * width/height attributes MUST be these numbers, never the logical ones: the
 * browser rasterizes an SVG-as-image at its INTRINSIC size, so logical
 * attributes make WebKit decode a small bitmap that drawImage then upscales
 * (blurry on 2x screens) — and an unbounded ultra renderWidth would ask the
 * decoder for an unbounded bitmap, sailing past the pixel budget before any
 * canvas is allocated. The logical tree instead rides an inner wrapper scaled
 * by `transformScale`, so the canvas draw is a 1:1 copy. Sizes are clamped
 * into `budgetPx` (floor per side when clamping, so the product provably fits
 * even where the unclamped per-side ceil would not have).
 */
export declare function rasterGeometry(renderWidth: number, logicalHeight: number, scale: number, pixelRatio: number, budgetPx: number): RasterGeometry;
/** Inputs of {@link buildSvgDocument}: logical tree size + physical target. */
export interface SvgDocumentSpec {
    /** Logical px width of the slice tree (the wrapper's width). */
    renderWidth: number;
    /** Logical px height of the slice tree (the wrapper's height). */
    logicalHeight: number;
    /** Physical target width ({@link RasterGeometry.width}). */
    width: number;
    /** Physical target height ({@link RasterGeometry.height}). */
    height: number;
    /** Wrapper transform ({@link RasterGeometry.transformScale}). */
    transformScale: number;
}
/**
 * Serialize one slice subtree into a standalone SVG document sized at its
 * PHYSICAL target: svg + foreignObject carry the physical px, the xhtml
 * wrapper carries the logical size and a scale() transform, so the image
 * rasterizes at exactly the resolution the canvas wants (no upscaled copy).
 * `bodyHtml` is the prepared slice clone's outerHTML — namespace attributes
 * must already be baked in by the caller (prepareXmlSerialization).
 */
export declare function buildSvgDocument(bodyHtml: string, spec: SvgDocumentSpec): string;
/**
 * Card width that fits `contentWidth` of assistant-style rows: the row spans
 * the card's whole content box, so only the card padding stacks on top.
 */
export declare function cardWidthForContent(contentWidth: number, cardPaddingX: number): number;
/**
 * Card width that fits `contentWidth` inside a user bubble: the bubble is
 * capped at {@link USER_BUBBLE_MAX_RATIO} of the row and adds its own padding,
 * so the percentage constraint inverts into a division.
 */
export declare function cardWidthForUserBubble(contentWidth: number, cardPaddingX: number): number;
/** Card width a turn's measured content needs, by turn role. */
export declare function requiredCardWidth(role: 'user' | 'assistant', contentWidth: number, cardPaddingX: number): number;
/** Which slice geometry a turn needs, from its measured natural content width. */
export type TurnWidthBucket = 'base' | 'wide' | 'ultra';
/** Bucket one turn: base width / widened (~780) / wider-than-wide (scale-to-fit). */
export declare function bucketTurnWidth(role: 'user' | 'assistant', contentWidth: number, cardPaddingX: number, baseWidth: number, wideWidth: number): TurnWidthBucket;
/**
 * Scale-to-fit geometry for content whose needed card width exceeds the wide
 * width: render the slice at full natural width, shrink geometrically on
 * output (pinch-zoom in the image viewer recovers readability — PLAN §5.2).
 */
export declare function ultraSliceWidth(role: 'user' | 'assistant', contentWidth: number, cardPaddingX: number, wideWidth: number): {
    renderWidth: number;
    scale: number;
};
/** One turn's final geometry as the DOM measured it at {@link renderWidth}. */
export interface PlannedTurnInput {
    /** Logical px height of the turn at {@link renderWidth}. */
    height: number;
    /** Logical px width the turn's slice renders at (base / wide / ultra). */
    renderWidth: number;
    /** Geometric output downscale (1 except ultra turns). */
    scale: number;
}
/** Fixed card chrome the planner must reserve height for. */
export interface PlanExtras {
    /** Vertical gap between the card root's column children. */
    gap: number;
    /** Card root top + bottom padding. */
    paddingY: number;
    /** Header strip height (reserved on the first slice). */
    headerHeight: number;
    /** Footer strip height (reserved on the last slice). */
    footerHeight: number;
    /** Truncation-note bar height (reserved on a truncated last slice). */
    noteHeight: number;
}
export interface PlanOptions {
    budgetPx: number;
    maxSlices: number;
    /** Descending pixel-ratio candidates (see {@link ratioChain}). */
    ratios: readonly number[];
}
/** One planned output image. */
export interface PlannedSlice {
    /** Inclusive index of the first turn in this slice. */
    from: number;
    /** Inclusive index of the last turn in this slice. */
    to: number;
    /** Logical width the slice must be cloned/rendered at. */
    renderWidth: number;
    /** Total geometric downscale (ultra fit × budget lever; 1 = native). */
    scale: number;
    /** Logical height at {@link renderWidth}, chrome included. */
    height: number;
    /** Output logical width (renderWidth × scale). */
    outWidth: number;
    /** Output logical height (height × scale). */
    outHeight: number;
    /** Extra shrink applied to satisfy the pixel budget (1 = none). */
    lever: number;
    /** Carries the header strip (and the note when {@link truncated}). */
    first: boolean;
    /** Carries the footer strip. */
    last: boolean;
    /** True only on the first slice of a truncated export (marks the dropped head). */
    truncated: boolean;
}
export interface SlicePlan {
    pixelRatio: number;
    slices: PlannedSlice[];
    truncated: boolean;
    /** Turns dropped from the HEAD by the {@link PlanOptions.maxSlices} ceiling (the tail — the recent turns a share is about — is always kept). */
    droppedTurns: number;
}
/**
 * Plan the slice sequence (legacy multi-file geometry, ticket 04). Beyond the
 * shared walk, any slice still over budget (an un-splittable giant turn, or
 * the header/footer chrome nudging a full slice past the line) is shrunk
 * uniformly PER SLICE (the `lever`) — geometric scaling keeps completeness,
 * zoom restores size. Per-slice levers make physical widths diverge, which is
 * fine for separate files and exactly what the stitched planner removes.
 *
 * Deterministic pure function of its inputs.
 */
export declare function planShareSlices(turns: readonly PlannedTurnInput[], extras: PlanExtras, opts: PlanOptions): SlicePlan;
/**
 * Global logical width of a stitched export: 390 unless ANY turn needs wide
 * content, then 780 for the WHOLE card — one long image must not mix widths
 * (scanlines concatenate only when every slice has the same pixel width; a
 * mid-image line-length jump would read as a glitch anyway).
 */
export declare function unifiedCardWidth(anyTurnNeedsWide: boolean): number;
/**
 * Plan the slice sequence for a stitched single-PNG export. Same walk and
 * truncation semantics as {@link planShareSlices}, but the budget lever is
 * GLOBAL: one multiplier shared by every slice, so every slice's output width
 * is identical and the PNG stitcher can concatenate scanlines directly. The
 * inputs must already be normalized to the global width by the caller (the
 * DOM half measures the card once at {@link unifiedCardWidth}; turns still
 * wider than that keep their per-turn ultra scale-to-fit, which lands on the
 * same output width by construction).
 */
export declare function planShareSlicesUnified(turns: readonly PlannedTurnInput[], extras: PlanExtras, opts: PlanOptions): SlicePlan;
/**
 * Authoritative physical width of a stitched plan — the IHDR width of the
 * single long image. Every slice's own `outWidth × pixelRatio` must already
 * agree; the max absorbs the ±ε float noise of ultra scales
 * (renderWidth × W/renderWidth), so one integer serves the whole card and the
 * painter FORCES it (rasterGeometryStitch) instead of re-deriving it per slice.
 */
export declare function stitchPixelWidth(plan: SlicePlan): number;
/** Stitch-mode raster geometry: the width is the GLOBAL one, never this slice's own arithmetic. */
export interface StitchRasterGeometry {
    /** Physical px width — always the caller's global width, byte-for-byte. */
    width: number;
    /** Physical px height (>= 1); when `clamped`, the floor'd budget-capped height. */
    height: number;
    /** Wrapper transform = globalWidth / renderWidth (ultra fit × lever × ratio all folded in). */
    transformScale: number;
    /**
     * True when the measured height busts the per-slice budget at the global
     * width (the global lever should have prevented this). The pure function
     * still returns the floor'd geometry so the check script can pin the
     * arithmetic — the DOM half REFUSES to paint a clamped slice (a floor'd
     * height means the bottom of the card is silently cut off: visible data
     * loss, review 07+08 plan B).
     */
    clamped: boolean;
}
/**
 * Physical raster geometry of one slice in stitch mode. The width is pinned to
 * `globalWidth` so every slice's canvas — and the scanlines the stitcher reads
 * from it — is exactly as wide as the final image; a slice that freshly
 * measures past the per-slice budget would need a height CLIP (never a width
 * shrink: that would break concatenation, never aspect distortion), and the
 * painter rejects that case instead of clipping (see `clamped`). The
 * planner's global lever is the mechanism that keeps slices in budget; this
 * clamp is the loud tripwire behind it.
 */
export declare function rasterGeometryStitch(renderWidth: number, logicalHeight: number, globalWidth: number, budgetPx: number): StitchRasterGeometry;
export interface RasterizeOptions {
    /** Upper bound for the pixel ratio; default min(devicePixelRatio, 2). */
    pixelRatioCap?: number;
    /** Truncation-note copy, fed the count of dropped head turns (ticket 05 localizes it). */
    truncatedNote?: (droppedTurns: number) => string;
    /** Called 0/N once and done/N after each slice. */
    onProgress?: (done: number, total: number) => void;
    /**
     * Stitch mode (ticket 07, PLAN §4.5): plan for a single-PNG stitched export —
     * one global logical width (390/780), one global pixel ratio and one global
     * budget lever, so every slice shares the same physical width and
     * png-stitch.ts can concatenate scanlines. Default false keeps the legacy
     * per-slice-width multi-file geometry (the fallback path for browsers
     * without CompressionStream).
     */
    unified?: boolean;
}
export interface RasterizeResult {
    pixelRatio: number;
    truncated: boolean;
    droppedTurns: number;
    slices: RasterizedSlice[];
    /**
     * Unified mode only: the physical pixel width every slice shares — the IHDR
     * width of the stitched long image (undefined in legacy mode).
     */
    stitchWidth: number | undefined;
}
export interface RasterizedSlice {
    index: number;
    blob: Blob;
    /** Physical px size of the PNG. */
    width: number;
    height: number;
    /** Logical slice width (before scaling). */
    logicalWidth: number;
    /** Total geometric scale applied on output. */
    scale: number;
    /** Transcript seq of the first/last turn in this slice (debug + ordering). */
    fromSeq: number;
    toSeq: number;
}
/**
 * 2×2 feature probe (PLAN §5.2): before the first export, rasterize a tiny
 * known card (four solid color cells through the exact foreignObject → Image
 * → canvas path) and read the pixels back. Old Safari renders foreignObject
 * images as nothing — exporting then would produce blank PNGs, so the probe
 * fails loudly once per page load instead. Failure is sticky.
 */
export declare function ensureProbe(): Promise<void>;
/**
 * Rasterize a rendered share card into a PNG sequence.
 *
 * Pipeline: probe once → measure a clone at base width → bucket turns (pure)
 * → measure wide/ultra turns at their final widths → plan slices (pure) →
 * per slice: prune a clone to the slice, measure, serialize into SVG, paint,
 * release. The returned blobs are owned by the caller (object URLs etc.).
 *
 * `unified` (ticket 07) flips both planning decisions the stitch depends on:
 * one global logical width (re-measured once at 390 or 780 — a card that
 * lifts ANY turn to wide renders every turn wide) and one global budget
 * lever, so `stitchWidth` comes back as the single physical width every slice
 * shares and png-stitch.ts can concatenate the scanlines into one PNG.
 */
export declare function rasterizeShareCard(card: HTMLElement, options?: RasterizeOptions): Promise<RasterizeResult>;
//# sourceMappingURL=rasterize.d.ts.map