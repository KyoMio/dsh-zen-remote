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

import { BASE_CARD_WIDTH, USER_BUBBLE_MAX_RATIO, USER_BUBBLE_PAD_X, WIDE_SLICE_WIDTH } from './share-constants.ts'

/* ============================================================================
 * PURE PLANNING — no DOM, no React, imports only share-constants.ts
 * ========================================================================== */

/** Per-slice physical pixel budget (iOS canvas hard cap 16.7M minus margin). */
export const SLICE_PIXEL_BUDGET = 12_000_000
/** Slice count ceiling; beyond it the head is dropped and the first slice marked. */
export const MAX_SLICES = 24
/** Pixel-ratio fallback ladder, walked top-down from min(devicePixelRatio, 2). */
export const PIXEL_RATIO_STEPS: readonly number[] = [2, 1.5, 1]
/** Safety px added around computed ultra widths (sub-pixel + rounding slack). */
export const ULTRA_WIDTH_MARGIN = 2

/**
 * Machine-readable failure kinds; ticket 05 maps them to localized copy.
 * `slice-over-budget` (review 07+08): a unified-mode slice whose freshly
 * MEASURED height busts the per-slice canvas budget at the global stitch
 * width — the planner's global lever should have prevented it, and the old
 * behavior (floor the height, silently clip the bottom) was invisible data
 * loss, so it fails loudly instead.
 */
export type ShareRasterizeErrorCode = 'probe-failed' | 'image-load' | 'canvas' | 'empty-card' | 'slice-over-budget'

/** Localizable rasterize failure. `code` drives UI copy, `detail` is diagnostic. */
export class ShareRasterizeError extends Error {
  readonly code: ShareRasterizeErrorCode
  readonly detail: string

  constructor(code: ShareRasterizeErrorCode, detail: string) {
    super(`share-rasterize/${code}: ${detail}`)
    this.code = code
    this.detail = detail
  }
}

/** Descending pixel-ratio candidates for an already-clamped cap; never empty. */
export function ratioChain(cap: number): number[] {
  const chain = PIXEL_RATIO_STEPS.filter((step) => step <= cap + 1e-9)
  return chain.length > 0 ? chain : [1]
}

/** Physical pixels a slice occupies once painted (rounding up, canvas-style). */
export function slicePixelCount(outWidth: number, outHeight: number, pixelRatio: number): number {
  return Math.ceil(outWidth * pixelRatio) * Math.ceil(outHeight * pixelRatio)
}

/* ---- SVG raster document (pure; the painter only feeds it strings) --------- */

const XHTML_NS = 'http://www.w3.org/1999/xhtml'
const SVG_NS = 'http://www.w3.org/2000/svg'
/** XML 1.0 forbids these; DOM text from transcripts can theoretically carry them. */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g

/** Physical raster geometry of one slice: svg/foreignObject/canvas all take these. */
export interface RasterGeometry {
  /** Physical px width (>= 1). */
  width: number
  /** Physical px height (>= 1). */
  height: number
  /** Wrapper transform = scale × pixelRatio (further shrunk when clamped). */
  transformScale: number
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
export function rasterGeometry(renderWidth: number, logicalHeight: number, scale: number, pixelRatio: number, budgetPx: number): RasterGeometry {
  let transformScale = scale * pixelRatio
  let width = Math.max(1, Math.ceil(renderWidth * transformScale))
  let height = Math.max(1, Math.ceil(logicalHeight * transformScale))
  if (width * height > budgetPx) {
    transformScale *= Math.sqrt(budgetPx / (width * height))
    width = Math.max(1, Math.floor(renderWidth * transformScale))
    height = Math.max(1, Math.floor(logicalHeight * transformScale))
  }
  return { width, height, transformScale }
}

/** Inputs of {@link buildSvgDocument}: logical tree size + physical target. */
export interface SvgDocumentSpec {
  /** Logical px width of the slice tree (the wrapper's width). */
  renderWidth: number
  /** Logical px height of the slice tree (the wrapper's height). */
  logicalHeight: number
  /** Physical target width ({@link RasterGeometry.width}). */
  width: number
  /** Physical target height ({@link RasterGeometry.height}). */
  height: number
  /** Wrapper transform ({@link RasterGeometry.transformScale}). */
  transformScale: number
}

/**
 * Serialize one slice subtree into a standalone SVG document sized at its
 * PHYSICAL target: svg + foreignObject carry the physical px, the xhtml
 * wrapper carries the logical size and a scale() transform, so the image
 * rasterizes at exactly the resolution the canvas wants (no upscaled copy).
 * `bodyHtml` is the prepared slice clone's outerHTML — namespace attributes
 * must already be baked in by the caller (prepareXmlSerialization).
 */
export function buildSvgDocument(bodyHtml: string, spec: SvgDocumentSpec): string {
  const body = bodyHtml.replace(INVALID_XML_CHARS, '')
  const wrapper = `<div xmlns="${XHTML_NS}" style="width:${spec.renderWidth}px;height:${spec.logicalHeight}px;transform:scale(${spec.transformScale});transform-origin:0 0">${body}</div>`
  return `<svg xmlns="${SVG_NS}" width="${spec.width}" height="${spec.height}"><foreignObject width="${spec.width}" height="${spec.height}">${wrapper}</foreignObject></svg>`
}

/**
 * Card width that fits `contentWidth` of assistant-style rows: the row spans
 * the card's whole content box, so only the card padding stacks on top.
 */
export function cardWidthForContent(contentWidth: number, cardPaddingX: number): number {
  return Math.ceil(contentWidth) + 2 * Math.ceil(cardPaddingX) + ULTRA_WIDTH_MARGIN
}

/**
 * Card width that fits `contentWidth` inside a user bubble: the bubble is
 * capped at {@link USER_BUBBLE_MAX_RATIO} of the row and adds its own padding,
 * so the percentage constraint inverts into a division.
 */
export function cardWidthForUserBubble(contentWidth: number, cardPaddingX: number): number {
  const inner = Math.ceil(contentWidth) + 2 * USER_BUBBLE_PAD_X
  return Math.ceil(inner / USER_BUBBLE_MAX_RATIO) + 2 * Math.ceil(cardPaddingX) + ULTRA_WIDTH_MARGIN
}

/** Card width a turn's measured content needs, by turn role. */
export function requiredCardWidth(role: 'user' | 'assistant', contentWidth: number, cardPaddingX: number): number {
  return role === 'user' ? cardWidthForUserBubble(contentWidth, cardPaddingX) : cardWidthForContent(contentWidth, cardPaddingX)
}

/** Which slice geometry a turn needs, from its measured natural content width. */
export type TurnWidthBucket = 'base' | 'wide' | 'ultra'

/** Bucket one turn: base width / widened (~780) / wider-than-wide (scale-to-fit). */
export function bucketTurnWidth(role: 'user' | 'assistant', contentWidth: number, cardPaddingX: number, baseWidth: number, wideWidth: number): TurnWidthBucket {
  const required = requiredCardWidth(role, contentWidth, cardPaddingX)
  if (required <= baseWidth) return 'base'
  if (required <= wideWidth) return 'wide'
  return 'ultra'
}

/**
 * Scale-to-fit geometry for content whose needed card width exceeds the wide
 * width: render the slice at full natural width, shrink geometrically on
 * output (pinch-zoom in the image viewer recovers readability — PLAN §5.2).
 */
export function ultraSliceWidth(role: 'user' | 'assistant', contentWidth: number, cardPaddingX: number, wideWidth: number): { renderWidth: number; scale: number } {
  const renderWidth = requiredCardWidth(role, contentWidth, cardPaddingX)
  return { renderWidth, scale: Math.min(1, wideWidth / renderWidth) }
}

/* ---- slice planning -------------------------------------------------------- */

/** One turn's final geometry as the DOM measured it at {@link renderWidth}. */
export interface PlannedTurnInput {
  /** Logical px height of the turn at {@link renderWidth}. */
  height: number
  /** Logical px width the turn's slice renders at (base / wide / ultra). */
  renderWidth: number
  /** Geometric output downscale (1 except ultra turns). */
  scale: number
}

/** Fixed card chrome the planner must reserve height for. */
export interface PlanExtras {
  /** Vertical gap between the card root's column children. */
  gap: number
  /** Card root top + bottom padding. */
  paddingY: number
  /** Header strip height (reserved on the first slice). */
  headerHeight: number
  /** Footer strip height (reserved on the last slice). */
  footerHeight: number
  /** Truncation-note bar height (reserved on a truncated last slice). */
  noteHeight: number
}

export interface PlanOptions {
  budgetPx: number
  maxSlices: number
  /** Descending pixel-ratio candidates (see {@link ratioChain}). */
  ratios: readonly number[]
}

/** One planned output image. */
export interface PlannedSlice {
  /** Inclusive index of the first turn in this slice. */
  from: number
  /** Inclusive index of the last turn in this slice. */
  to: number
  /** Logical width the slice must be cloned/rendered at. */
  renderWidth: number
  /** Total geometric downscale (ultra fit × budget lever; 1 = native). */
  scale: number
  /** Logical height at {@link renderWidth}, chrome included. */
  height: number
  /** Output logical width (renderWidth × scale). */
  outWidth: number
  /** Output logical height (height × scale). */
  outHeight: number
  /** Extra shrink applied to satisfy the pixel budget (1 = none). */
  lever: number
  /** Carries the header strip (and the note when {@link truncated}). */
  first: boolean
  /** Carries the footer strip. */
  last: boolean
  /** True only on the first slice of a truncated export (marks the dropped head). */
  truncated: boolean
}

export interface SlicePlan {
  pixelRatio: number
  slices: PlannedSlice[]
  truncated: boolean
  /** Turns dropped from the HEAD by the {@link PlanOptions.maxSlices} ceiling (the tail — the recent turns a share is about — is always kept). */
  droppedTurns: number
}

/** Internal greedy packing unit (chrome not yet attached). */
interface Packing {
  from: number
  to: number
  renderWidth: number
  scale: number
  /** Sum of member turn heights + inter-turn gaps; header/footer excluded. */
  children: number
}

function sameRun(a: PlannedTurnInput, b: PlannedTurnInput): boolean {
  return a.renderWidth === b.renderWidth && a.scale === b.scale
}

function packingPixels(p: Packing, extras: PlanExtras, pixelRatio: number): number {
  const height = (extras.paddingY + p.children) * p.scale
  return slicePixelCount(p.renderWidth * p.scale, height, pixelRatio)
}

/**
 * Greedy first-fit over runs of consecutive turns sharing the same geometry.
 * A turn is never split; a run never mixes widths (a 390px turn must not ride
 * a 780px slice — mid-sequence line-length jumps read as a glitch). The first
 * turn of a run always starts a slice even when it alone busts the budget
 * (un-splittable); the caller's ratio walk notices and degrades.
 */
function greedyPacking(turns: readonly PlannedTurnInput[], extras: PlanExtras, pixelRatio: number, budgetPx: number): Packing[] {
  const out: Packing[] = []
  let i = 0
  while (i < turns.length) {
    let j = i + 1
    while (j < turns.length && sameRun(turns[j]!, turns[i]!)) j += 1
    let cur: Packing | undefined
    let children = 0
    for (let k = i; k < j; k++) {
      const turn = turns[k]!
      const projected = children + (cur === undefined ? 0 : extras.gap) + turn.height
      const candidate: Packing = cur === undefined
        ? { from: k, to: k, renderWidth: turn.renderWidth, scale: turn.scale, children: turn.height }
        : { ...cur, to: k, children: projected }
      if (cur !== undefined && packingPixels(candidate, extras, pixelRatio) > budgetPx) {
        out.push(cur)
        cur = { from: k, to: k, renderWidth: turn.renderWidth, scale: turn.scale, children: turn.height }
        children = turn.height
      } else {
        cur = candidate
        children = projected
      }
    }
    if (cur !== undefined) out.push(cur)
    i = j
  }
  return out
}

/** Shared walk result: slice groupings after ratio selection and truncation. */
interface WalkResult {
  packing: Packing[]
  pixelRatio: number
  truncated: boolean
  droppedTurns: number
}

/**
 * Ratio ladder + tail-keeping truncation shared by both planners. Order of
 * levers (PLAN §5.2):
 * 1. pick the highest pixel ratio whose greedy packing fits both the budget
 *    on every slice and the {@link PlanOptions.maxSlices} count — the ratio is
 *    GLOBAL, a property of the whole card's plan, never of one slice;
 * 2. at the lowest ratio, keep the LAST maxSlices slices and drop the head
 *    (a share image is of the RECENT conversation — with range=last the user
 *    explicitly named the newest turns, which head-keeping would discard).
 */
function walkRatioAndTruncate(turns: readonly PlannedTurnInput[], extras: PlanExtras, opts: PlanOptions): WalkResult {
  const lastRatio = opts.ratios.length > 0 ? opts.ratios[opts.ratios.length - 1]! : 1
  if (turns.length === 0) {
    return { packing: [], pixelRatio: lastRatio, truncated: false, droppedTurns: 0 }
  }
  let packing: Packing[] | undefined
  let pixelRatio = lastRatio
  for (const candidate of opts.ratios) {
    const p = greedyPacking(turns, extras, candidate, opts.budgetPx)
    if (p.length <= opts.maxSlices && p.every((s) => packingPixels(s, extras, candidate) <= opts.budgetPx)) {
      packing = p
      pixelRatio = candidate
      break
    }
  }
  let truncated = false
  let droppedTurns = 0
  if (packing === undefined) {
    const p = greedyPacking(turns, extras, lastRatio, opts.budgetPx)
    // Keep the TAIL: the head is the only droppable direction (see doc above).
    const kept = p.slice(Math.max(0, p.length - opts.maxSlices))
    const firstKept = kept[0]
    droppedTurns = firstKept === undefined ? turns.length : firstKept.from
    truncated = droppedTurns > 0
    packing = kept
    pixelRatio = lastRatio
  }
  return { packing, pixelRatio, truncated, droppedTurns }
}

/** Reserve the header/note/footer chrome on the first/last packing rows (mutates). */
function attachChrome(packing: Packing[], extras: PlanExtras, truncated: boolean): void {
  const first = packing[0]!
  first.children += extras.headerHeight + extras.gap
  if (truncated) first.children += extras.noteHeight + extras.gap
  const last = packing[packing.length - 1]!
  last.children += extras.footerHeight + extras.gap
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
export function planShareSlices(turns: readonly PlannedTurnInput[], extras: PlanExtras, opts: PlanOptions): SlicePlan {
  const { packing, pixelRatio, truncated, droppedTurns } = walkRatioAndTruncate(turns, extras, opts)
  if (packing.length === 0) {
    return { pixelRatio, slices: [], truncated: false, droppedTurns: 0 }
  }
  attachChrome(packing, extras, truncated)

  const count = packing.length
  const slices: PlannedSlice[] = packing.map((p, index): PlannedSlice => {
    const height = extras.paddingY + p.children
    // Budget lever: the sqrt bound ignores the canvas ceil rounding, so shrink
    // iteratively (sub-1% deficits converge in one or two steps).
    let scale = p.scale
    if (slicePixelCount(p.renderWidth * scale, height * scale, pixelRatio) > opts.budgetPx) {
      const bound = Math.sqrt(opts.budgetPx / (p.renderWidth * height)) / pixelRatio
      scale = Math.min(p.scale, bound)
      for (let attempt = 0; attempt < 24 && slicePixelCount(p.renderWidth * scale, height * scale, pixelRatio) > opts.budgetPx; attempt++) {
        scale *= 0.997
      }
    }
    const lever = p.scale > 0 ? scale / p.scale : 1
    return {
      from: p.from,
      to: p.to,
      renderWidth: p.renderWidth,
      scale,
      height,
      outWidth: p.renderWidth * scale,
      outHeight: height * scale,
      lever,
      first: index === 0,
      last: index === count - 1,
      truncated: truncated && index === 0,
    }
  })

  return { pixelRatio, slices, truncated, droppedTurns }
}

/* ---- stitch-mode unified planning (ticket 07, PLAN §4.5) -------------------- */

/**
 * Global logical width of a stitched export: 390 unless ANY turn needs wide
 * content, then 780 for the WHOLE card — one long image must not mix widths
 * (scanlines concatenate only when every slice has the same pixel width; a
 * mid-image line-length jump would read as a glitch anyway).
 */
export function unifiedCardWidth(anyTurnNeedsWide: boolean): number {
  return anyTurnNeedsWide ? WIDE_SLICE_WIDTH : BASE_CARD_WIDTH
}

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
export function planShareSlicesUnified(turns: readonly PlannedTurnInput[], extras: PlanExtras, opts: PlanOptions): SlicePlan {
  const { packing, pixelRatio, truncated, droppedTurns } = walkRatioAndTruncate(turns, extras, opts)
  if (packing.length === 0) {
    return { pixelRatio, slices: [], truncated: false, droppedTurns: 0 }
  }
  attachChrome(packing, extras, truncated)

  // GLOBAL lever: when any un-splittable slice busts the budget at the chosen
  // ratio, the most-shrinking slice governs a single multiplier applied to all
  // of them — widths stay uniform (the stitch invariant) at the cost of
  // shrinking well-behaved slices too, which only happens when some single
  // turn is taller than the whole budget.
  let lever = 1
  const pixelsOf = (p: Packing, multiplier: number): number => {
    const height = (extras.paddingY + p.children) * p.scale * multiplier
    return slicePixelCount(p.renderWidth * p.scale * multiplier, height, pixelRatio)
  }
  if (packing.some((p) => pixelsOf(p, 1) > opts.budgetPx)) {
    let bound = 1
    for (const p of packing) {
      const logical = extras.paddingY + p.children
      const sliceBound = Math.sqrt(opts.budgetPx / (p.renderWidth * logical)) / pixelRatio
      bound = Math.min(bound, sliceBound / p.scale)
    }
    lever = Math.min(1, bound)
    for (let attempt = 0; attempt < 24 && packing.some((p) => pixelsOf(p, lever) > opts.budgetPx); attempt++) {
      lever *= 0.997
    }
  }

  const count = packing.length
  const slices: PlannedSlice[] = packing.map((p, index): PlannedSlice => {
    const height = extras.paddingY + p.children
    const scale = p.scale * lever
    return {
      from: p.from,
      to: p.to,
      renderWidth: p.renderWidth,
      scale,
      height,
      outWidth: p.renderWidth * scale,
      outHeight: height * scale,
      lever,
      first: index === 0,
      last: index === count - 1,
      truncated: truncated && index === 0,
    }
  })

  return { pixelRatio, slices, truncated, droppedTurns }
}

/**
 * Authoritative physical width of a stitched plan — the IHDR width of the
 * single long image. Every slice's own `outWidth × pixelRatio` must already
 * agree; the max absorbs the ±ε float noise of ultra scales
 * (renderWidth × W/renderWidth), so one integer serves the whole card and the
 * painter FORCES it (rasterGeometryStitch) instead of re-deriving it per slice.
 */
export function stitchPixelWidth(plan: SlicePlan): number {
  if (plan.slices.length === 0) return 0
  const widest = plan.slices.reduce((max, s) => Math.max(max, s.outWidth), 0)
  return Math.ceil(widest * plan.pixelRatio)
}

/** Stitch-mode raster geometry: the width is the GLOBAL one, never this slice's own arithmetic. */
export interface StitchRasterGeometry {
  /** Physical px width — always the caller's global width, byte-for-byte. */
  width: number
  /** Physical px height (>= 1); when `clamped`, the floor'd budget-capped height. */
  height: number
  /** Wrapper transform = globalWidth / renderWidth (ultra fit × lever × ratio all folded in). */
  transformScale: number
  /**
   * True when the measured height busts the per-slice budget at the global
   * width (the global lever should have prevented this). The pure function
   * still returns the floor'd geometry so the check script can pin the
   * arithmetic — the DOM half REFUSES to paint a clamped slice (a floor'd
   * height means the bottom of the card is silently cut off: visible data
   * loss, review 07+08 plan B).
   */
  clamped: boolean
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
export function rasterGeometryStitch(renderWidth: number, logicalHeight: number, globalWidth: number, budgetPx: number): StitchRasterGeometry {
  if (!Number.isInteger(globalWidth) || globalWidth <= 0) throw new Error(`share-rasterize: invalid stitch width ${globalWidth}`)
  const transformScale = globalWidth / renderWidth
  let height = Math.max(1, Math.ceil(logicalHeight * transformScale))
  let clamped = false
  if (globalWidth * height > budgetPx) {
    height = Math.max(1, Math.floor(budgetPx / globalWidth))
    clamped = true
  }
  return { width: globalWidth, height, transformScale, clamped }
}

/* ============================================================================
 * DOM EXECUTION — measures only, executes the pure plan
 * ========================================================================== */

/** Overflow below this many px is rounding noise, not wide content. */
const OVERFLOW_EPSILON = 1
/** Default truncation copy: counts the dropped head turns. */
const DEFAULT_TRUNCATED_NOTE = (droppedTurns: number): string => `已省略前 ${droppedTurns} 轮`

export interface RasterizeOptions {
  /** Upper bound for the pixel ratio; default min(devicePixelRatio, 2). */
  pixelRatioCap?: number
  /** Truncation-note copy, fed the count of dropped head turns (ticket 05 localizes it). */
  truncatedNote?: (droppedTurns: number) => string
  /** Called 0/N once and done/N after each slice. */
  onProgress?: (done: number, total: number) => void
  /**
   * Stitch mode (ticket 07, PLAN §4.5): plan for a single-PNG stitched export —
   * one global logical width (390/780), one global pixel ratio and one global
   * budget lever, so every slice shares the same physical width and
   * png-stitch.ts can concatenate scanlines. Default false keeps the legacy
   * per-slice-width multi-file geometry (the fallback path for browsers
   * without CompressionStream).
   */
  unified?: boolean
}

export interface RasterizeResult {
  pixelRatio: number
  truncated: boolean
  droppedTurns: number
  slices: RasterizedSlice[]
  /**
   * Unified mode only: the physical pixel width every slice shares — the IHDR
   * width of the stitched long image (undefined in legacy mode).
   */
  stitchWidth: number | undefined
}

export interface RasterizedSlice {
  index: number
  blob: Blob
  /** Physical px size of the PNG. */
  width: number
  height: number
  /** Logical slice width (before scaling). */
  logicalWidth: number
  /** Total geometric scale applied on output. */
  scale: number
  /** Transcript seq of the first/last turn in this slice (debug + ordering). */
  fromSeq: number
  toSeq: number
}

/** One turn row as measured in a clone at a specific render width. */
interface TurnMeasure {
  seq: number
  role: 'user' | 'assistant'
  height: number
  /** Widest overflowing descendant box (px); 0 when nothing overflows. */
  content: number
}

/** Card chrome as measured in a clone. */
interface CardMeasure {
  turns: TurnMeasure[]
  headerHeight: number
  footerHeight: number
  gap: number
  paddingY: number
  /** Per-side horizontal padding of the card root. */
  paddingX: number
}

/**
 * Offscreen measurement/render host. A shadow root so page stylesheets (which
 * the later SVG-image render cannot load) do not reach the clones — inside
 * the shadow tree only inherited properties flow through, and the card
 * template resets the inheritable ones (font/color/line-height) inline on its
 * root, making the two contexts agree. position:fixed/-9999px keeps it laid
 * out (measurement needs real layout) but invisible.
 */
function createOffscreenHost(): { root: ShadowRoot; dispose: () => void } {
  const host = document.createElement('div')
  host.setAttribute('data-share-rasterize-host', '')
  host.style.position = 'fixed'
  host.style.left = '-9999px'
  host.style.top = '0'
  const root = host.attachShadow({ mode: 'open' })
  document.body.appendChild(host)
  return { root, dispose: () => { host.remove() } }
}

function cloneCardAt(card: HTMLElement, width: number): HTMLElement {
  const clone = card.cloneNode(true) as HTMLElement
  clone.style.width = `${width}px`
  return clone
}

/**
 * Natural content width of a turn: the widest descendant box that actually
 * overflows its own container (`white-space: pre` code/table segments — their
 * extent is container-independent). Non-overflowing descendants report their
 * box width, which is a layout result, not a need, so they are skipped.
 */
function contentExtent(turn: HTMLElement): number {
  let max = 0
  for (const el of turn.querySelectorAll('*')) {
    if (el.scrollWidth > el.clientWidth + OVERFLOW_EPSILON && el.scrollWidth > max) {
      max = el.scrollWidth
    }
  }
  return max
}

/**
 * Clone the card at `width`, measure everything the planner needs, drop the
 * clone. All reads (offsetHeight/scrollWidth/getComputedStyle) force sync
 * layout, so the numbers are stable the moment the clone is attached — no
 * frame timing involved.
 */
function measureCardAt(root: ShadowRoot, card: HTMLElement, width: number): CardMeasure {
  const clone = cloneCardAt(card, width)
  root.appendChild(clone)
  const turns: TurnMeasure[] = []
  for (const el of Array.from(clone.querySelectorAll<HTMLElement>('[data-share-turn]'))) {
    const raw = el.getAttribute('data-share-turn')
    if (raw === null) continue
    const seq = Number(raw)
    if (!Number.isFinite(seq)) continue
    turns.push({
      seq,
      role: el.getAttribute('data-share-role') === 'user' ? 'user' : 'assistant',
      height: el.offsetHeight,
      content: contentExtent(el),
    })
  }
  const computed = getComputedStyle(clone)
  const header = clone.querySelector<HTMLElement>('[data-share-header]')
  const footer = clone.querySelector<HTMLElement>('[data-share-footer]')
  const measure: CardMeasure = {
    turns,
    headerHeight: header?.offsetHeight ?? 0,
    footerHeight: footer?.offsetHeight ?? 0,
    gap: parsePx(computed.rowGap),
    paddingY: parsePx(computed.paddingTop) + parsePx(computed.paddingBottom),
    paddingX: parsePx(computed.paddingLeft),
  }
  clone.remove()
  return measure
}

function parsePx(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

function measureElementHeight(root: ShadowRoot, el: HTMLElement): number {
  root.appendChild(el)
  const h = el.offsetHeight
  el.remove()
  return h
}

/**
 * Measure an ultra turn at its planned width, re-deciding up to three times if
 * the formula missed a constraint the DOM knows better (nested percentage
 * boxes): widening the card never shrinks `pre` content, so re-measuring
 * converges. When it still does not fit after the third pass the geometry is
 * exported anyway (completeness over sharpness) but warned about once — a
 * silent clip would look like data loss.
 */
function measureUltraTurn(root: ShadowRoot, card: HTMLElement, turn: TurnMeasure, cardPaddingX: number, targetWidth: number): { height: number; renderWidth: number; scale: number } {
  let geo = ultraSliceWidth(turn.role, turn.content, cardPaddingX, targetWidth)
  let height = turn.height
  let scrollWidth = 0
  let fits = false
  for (let attempt = 0; attempt < 3 && !fits; attempt++) {
    const clone = cloneCardAt(card, geo.renderWidth)
    root.appendChild(clone)
    const el = clone.querySelector<HTMLElement>(`[data-share-turn="${turn.seq}"]`)
    const extent = el !== null ? contentExtent(el) : turn.content
    height = el?.offsetHeight ?? height
    scrollWidth = el?.scrollWidth ?? 0
    fits = el === null || scrollWidth <= geo.renderWidth
    clone.remove()
    if (!fits) geo = ultraSliceWidth(turn.role, extent, cardPaddingX, targetWidth)
  }
  if (!fits) {
    console.warn(`[dsh-zen-remote] share-image: ultra turn ${turn.seq} still wider than its slice after 3 re-measures (content ${scrollWidth}px > render width ${geo.renderWidth}px); exporting may clip its right edge`)
  }
  return { height, renderWidth: geo.renderWidth, scale: geo.scale }
}

/** Theme probes for the truncation note, read off the live card (inline styles). */
function readNoteTheme(card: HTMLElement): { tertiary: string; border: string; fontFamily: string } {
  let tertiary = '#81858c'
  let border = 'rgba(0, 0, 0, 0.1)'
  let fontFamily = ''
  try {
    fontFamily = getComputedStyle(card).fontFamily
    const caption = card.querySelector<HTMLElement>('[data-share-footer] span:last-of-type')
    if (caption !== null) tertiary = getComputedStyle(caption).color
    const rule = card.querySelector<HTMLElement>('[data-share-footer] > div:first-child')
    if (rule !== null) border = getComputedStyle(rule).backgroundColor
  } catch {
    // getComputedStyle on a detached card — the defaults above carry the note.
  }
  return { tertiary, border, fontFamily }
}

/** The「已省略前 X 轮」marker bar — inline-styled like everything the card renders. */
function buildTruncationNote(text: string, theme: { tertiary: string; border: string; fontFamily: string }): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-share-truncated', '')
  el.style.display = 'flex'
  el.style.alignItems = 'center'
  el.style.gap = '6px'
  el.style.padding = '8px 12px'
  el.style.border = `1px dashed ${theme.border}`
  el.style.borderRadius = '8px'
  el.style.fontSize = '12px'
  el.style.lineHeight = '1.5'
  el.style.color = theme.tertiary
  if (theme.fontFamily !== '') el.style.fontFamily = theme.fontFamily
  el.style.overflow = 'visible'
  el.textContent = text
  return el
}

/**
 * Clone the card and prune it down to exactly one slice's content: the
 * planned turns, the header only on the first slice, the footer only on the
 * last, plus the truncation note right under the header of a truncated first
 * slice. The root's own flex gap/padding keep the layout identical to the
 * planner's arithmetic (children + inter-child gaps + padding).
 */
function buildSliceClone(card: HTMLElement, root: ShadowRoot, slice: PlannedSlice, seqs: ReadonlySet<number>, note: HTMLElement | undefined): HTMLElement {
  const clone = cloneCardAt(card, slice.renderWidth)
  for (const el of Array.from(clone.querySelectorAll('[data-share-turn]'))) {
    const raw = el.getAttribute('data-share-turn')
    if (raw === null || !seqs.has(Number(raw))) el.remove()
  }
  const header = clone.querySelector<HTMLElement>('[data-share-header]')
  if (!slice.first) header?.remove()
  if (slice.truncated && note !== undefined) {
    const noteNode = note.cloneNode(true) as HTMLElement
    if (header !== null && header.parentElement !== null) header.parentElement.insertBefore(noteNode, header.nextSibling)
    else clone.insertBefore(noteNode, clone.firstChild)
  }
  if (!slice.last) clone.querySelector('[data-share-footer]')?.remove()
  root.appendChild(clone)
  return clone
}

/**
 * Make an HTML subtree survive XML parsing: the foreignObject child needs the
 * xhtml namespace (HTML serialization never emits it), and inline `<svg>`
 * glyphs (the image placeholder icon) need theirs — without it they parse as
 * xhtml-namespace elements named "svg" and silently render as nothing.
 */
function prepareXmlSerialization(root: HTMLElement): void {
  root.setAttribute('xmlns', XHTML_NS)
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.namespaceURI === SVG_NS) el.setAttribute('xmlns', SVG_NS)
  }
}

/**
 * Describe a source URL for an error surface WITHOUT embedding its content:
 * the SVG data URL carries the whole card (session transcript), so only the
 * scheme prefix and total length are kept.
 */
function describeImageUrl(url: string): string {
  if (!url.startsWith('data:')) return url.slice(0, 120)
  const comma = url.indexOf(',')
  const prefix = comma === -1 ? url.slice(0, 48) : url.slice(0, comma)
  return `${prefix} (${url.length} chars, payload omitted)`
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => { resolve(img) }
    img.onerror = () => { reject(new ShareRasterizeError('image-load', describeImageUrl(url))) }
    img.src = url
  })
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new ShareRasterizeError('canvas', 'toBlob returned null'))
      else resolve(blob)
    }, 'image/png')
  })
}

function readBackground(el: HTMLElement): string {
  const bg = getComputedStyle(el).backgroundColor
  return bg === '' || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' ? '#ffffff' : bg
}

/**
 * Paint one prepared slice clone: serialize → SVG data URL (encodeURIComponent
 * — transcript text is not ASCII) sized at the slice's PHYSICAL target → Image
 * whose intrinsic size already IS the canvas size → 1:1 canvas copy → PNG
 * blob. The canvas is released (zeroed) before returning; only the blob is
 * kept. Output height is taken from the freshly measured clone, not the
 * planner's estimate — reflow at slice width is authoritative — and any
 * resulting budget overshoot is clamped by rasterGeometry (legacy) or
 * REFUSED with ShareRasterizeError('slice-over-budget') by
 * rasterGeometryStitch (unified: width pinned to `globalWidth`, a floor'd
 * height would silently clip the bottom — review 07+08).
 */
async function paintSlice(clone: HTMLElement, slice: PlannedSlice, pixelRatio: number, globalWidth?: number): Promise<{ blob: Blob; width: number; height: number }> {
  const logicalHeight = Math.ceil(clone.offsetHeight)
  let width: number
  let height: number
  let transformScale: number
  if (globalWidth === undefined) {
    const geo = rasterGeometry(slice.renderWidth, logicalHeight, slice.scale, pixelRatio, SLICE_PIXEL_BUDGET)
    width = geo.width
    height = geo.height
    transformScale = geo.transformScale
  } else {
    const geo = rasterGeometryStitch(slice.renderWidth, logicalHeight, globalWidth, SLICE_PIXEL_BUDGET)
    if (geo.clamped) {
      // Review 07+08 (plan B): floor'ing the height would silently cut the
      // bottom off the slice — data loss the user cannot see. The planner's
      // global lever should have kept every slice in budget; reaching here
      // means it did not, and the honest answer is a localized failure, not a
      // quietly truncated image.
      const needed = Math.ceil(logicalHeight * geo.transformScale)
      const detail = `slice ${slice.from}-${slice.to} measured ${needed}px tall at stitch width ${globalWidth}px, but the canvas budget caps it at ${geo.height}px — refusing a silent bottom clip`
      console.warn(`[dsh-zen-remote] share-image: ${detail} (the global lever should have prevented this)`)
      throw new ShareRasterizeError('slice-over-budget', detail)
    }
    width = geo.width
    height = geo.height
    transformScale = geo.transformScale
  }
  prepareXmlSerialization(clone)
  const svg = buildSvgDocument(clone.outerHTML, {
    renderWidth: slice.renderWidth,
    logicalHeight,
    width,
    height,
    transformScale,
  })
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const img = await loadImage(url)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new ShareRasterizeError('canvas', '2d context unavailable')
  ctx.fillStyle = readBackground(clone)
  ctx.fillRect(0, 0, width, height)
  ctx.imageSmoothingQuality = 'high'
  // 1:1 copy — the SVG's intrinsic size is the physical target, so nothing is
  // upscaled here (the old logical-intrinsic + drawImage(target) pair made
  // WebKit hand back a small bitmap this call had to enlarge: blurry on 2x).
  ctx.drawImage(img, 0, 0)
  const blob = await canvasToPng(canvas)
  canvas.width = 0
  canvas.height = 0
  return { blob, width, height }
}

/* ---- feature probe --------------------------------------------------------- */

type ProbeOutcome = 'unknown' | 'ok' | 'failed'
let probeOutcome: ProbeOutcome = 'unknown'

const PROBE_SIZE = 40
const PROBE_CELLS = ['#e8322c', '#2c55e8', '#28a832', '#e8a028']

/**
 * 2×2 feature probe (PLAN §5.2): before the first export, rasterize a tiny
 * known card (four solid color cells through the exact foreignObject → Image
 * → canvas path) and read the pixels back. Old Safari renders foreignObject
 * images as nothing — exporting then would produce blank PNGs, so the probe
 * fails loudly once per page load instead. Failure is sticky.
 */
export async function ensureProbe(): Promise<void> {
  if (probeOutcome === 'ok') return
  if (probeOutcome === 'failed') {
    throw new ShareRasterizeError('probe-failed', 'the SVG foreignObject probe already failed on this page')
  }
  const cells = PROBE_CELLS.map((color) => `<div style="width:20px;height:20px;background:${color}"></div>`).join('')
  const svg = `<svg xmlns="${SVG_NS}" width="${PROBE_SIZE}" height="${PROBE_SIZE}"><foreignObject width="${PROBE_SIZE}" height="${PROBE_SIZE}"><div xmlns="${XHTML_NS}" style="width:${PROBE_SIZE}px;height:${PROBE_SIZE}px;margin:0;display:flex;flex-wrap:wrap">${cells}</div></foreignObject></svg>`
  try {
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    const canvas = document.createElement('canvas')
    canvas.width = PROBE_SIZE
    canvas.height = PROBE_SIZE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx === null) throw new Error('2d context unavailable')
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE).data
    const at = (x: number, y: number, channel: number): number => data[(y * PROBE_SIZE + x) * 4 + channel] ?? 0
    // Cell centers: red top-left, blue top-right (generous thresholds —
    // color management may shift values a little, blankness shifts them a lot).
    const red = at(10, 10, 0) >= 150 && at(10, 10, 1) < 150 && at(10, 10, 2) < 150
    const blue = at(30, 10, 2) >= 150 && at(30, 10, 0) < 150 && at(30, 10, 1) < 150
    canvas.width = 0
    canvas.height = 0
    if (!red || !blue) throw new Error('probe canvas came back blank (foreignObject not rendered)')
    probeOutcome = 'ok'
  } catch (err) {
    probeOutcome = 'failed'
    console.error('[dsh-zen-remote] share-image rasterize probe failed — this browser cannot paint SVG foreignObject content', err)
    throw new ShareRasterizeError('probe-failed', err instanceof Error ? err.message : String(err))
  }
}

/* ---- pipeline -------------------------------------------------------------- */

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
export async function rasterizeShareCard(card: HTMLElement, options: RasterizeOptions = {}): Promise<RasterizeResult> {
  await ensureProbe()
  const cap = Math.min(2, Math.max(1, options.pixelRatioCap ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)))
  const host = createOffscreenHost()
  try {
    const base = measureCardAt(host.root, card, BASE_CARD_WIDTH)
    if (base.turns.length === 0) {
      throw new ShareRasterizeError('empty-card', 'no [data-share-turn] elements found under the card root')
    }
    const noteTheme = readNoteTheme(card)
    const noteFor = (droppedTurns: number): HTMLElement =>
      buildTruncationNote((options.truncatedNote ?? DEFAULT_TRUNCATED_NOTE)(droppedTurns), noteTheme)
    const extrasOf = (note: HTMLElement): PlanExtras => ({
      gap: base.gap,
      paddingY: base.paddingY,
      headerHeight: base.headerHeight,
      footerHeight: base.footerHeight,
      noteHeight: measureElementHeight(host.root, note),
    })

    const planOpts: PlanOptions = { budgetPx: SLICE_PIXEL_BUDGET, maxSlices: MAX_SLICES, ratios: ratioChain(cap) }
    let note = noteFor(0)
    let plan: SlicePlan
    let stitchWidth: number | undefined
    const inputs: PlannedTurnInput[] = []
    if (options.unified === true) {
      // Global width first: any wide-needing turn widens the WHOLE card, then
      // everything is (re)measured at that one width. Turns still wider than
      // the global width keep the per-turn ultra scale-to-fit — which lands on
      // the same output width by construction (renderWidth × W/renderWidth).
      const needsWide = base.turns.some((turn) => bucketTurnWidth(turn.role, turn.content, base.paddingX, BASE_CARD_WIDTH, WIDE_SLICE_WIDTH) !== 'base')
      const cardWidth = unifiedCardWidth(needsWide)
      const measure = cardWidth === BASE_CARD_WIDTH ? base : measureCardAt(host.root, card, cardWidth)
      for (const turn of measure.turns) {
        if (requiredCardWidth(turn.role, turn.content, measure.paddingX) <= cardWidth) {
          inputs.push({ height: turn.height, renderWidth: cardWidth, scale: 1 })
        } else {
          const ultra = measureUltraTurn(host.root, card, turn, measure.paddingX, cardWidth)
          inputs.push({ height: ultra.height, renderWidth: ultra.renderWidth, scale: ultra.scale })
        }
      }
      plan = planShareSlicesUnified(inputs, extrasOf(note), planOpts)
      if (plan.truncated) {
        // Re-plan once with the real dropped count baked into the note (its text
        // length can change the bar's height); droppedTurns itself does not
        // depend on noteHeight, so this converges in one step.
        note = noteFor(plan.droppedTurns)
        plan = planShareSlicesUnified(inputs, extrasOf(note), planOpts)
      }
      stitchWidth = stitchPixelWidth(plan)
    } else {
      const buckets = base.turns.map((turn) => bucketTurnWidth(turn.role, turn.content, base.paddingX, BASE_CARD_WIDTH, WIDE_SLICE_WIDTH))
      const wideHeights = buckets.includes('wide')
        ? new Map(measureCardAt(host.root, card, WIDE_SLICE_WIDTH).turns.map((t) => [t.seq, t.height]))
        : undefined
      for (let i = 0; i < base.turns.length; i++) {
        const turn = base.turns[i]!
        const bucket = buckets[i]!
        if (bucket === 'base') {
          inputs.push({ height: turn.height, renderWidth: BASE_CARD_WIDTH, scale: 1 })
        } else if (bucket === 'wide') {
          inputs.push({ height: wideHeights?.get(turn.seq) ?? turn.height, renderWidth: WIDE_SLICE_WIDTH, scale: 1 })
        } else {
          const ultra = measureUltraTurn(host.root, card, turn, base.paddingX, WIDE_SLICE_WIDTH)
          inputs.push({ height: ultra.height, renderWidth: ultra.renderWidth, scale: ultra.scale })
        }
      }
      plan = planShareSlices(inputs, extrasOf(note), planOpts)
      if (plan.truncated) {
        note = noteFor(plan.droppedTurns)
        plan = planShareSlices(inputs, extrasOf(note), planOpts)
      }
    }

    options.onProgress?.(0, plan.slices.length)
    const slices: RasterizedSlice[] = []
    for (let index = 0; index < plan.slices.length; index++) {
      const slice = plan.slices[index]!
      const seqSet = new Set(base.turns.slice(slice.from, slice.to + 1).map((t) => t.seq))
      const clone = buildSliceClone(card, host.root, slice, seqSet, slice.truncated ? note : undefined)
      const painted = await paintSlice(clone, slice, plan.pixelRatio, stitchWidth)
      clone.remove()
      slices.push({
        index,
        blob: painted.blob,
        width: painted.width,
        height: painted.height,
        logicalWidth: slice.renderWidth,
        scale: slice.scale,
        fromSeq: base.turns[slice.from]!.seq,
        toSeq: base.turns[slice.to]!.seq,
      })
      options.onProgress?.(index + 1, plan.slices.length)
    }
    return { pixelRatio: plan.pixelRatio, truncated: plan.truncated, droppedTurns: plan.droppedTurns, slices, stitchWidth }
  } finally {
    host.dispose()
  }
}
