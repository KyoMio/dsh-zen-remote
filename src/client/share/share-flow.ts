/**
 * Share delivery (ticket 05, PLAN §5.4; ticket 07 adds the single-image
 * path): turn the rasterizer's output into Files named after the session
 * title and hand them to the system share panel via `navigator.share({files})`,
 * falling back to `<a download>` where the Web Share API is missing, refuses
 * the files, or loses the user activation during the multi-second rasterize.
 * Ticket 07 prefers ONE stitched long-image File (`deliverShareImage`) and
 * keeps the per-slice form (`deliverShareImages`) as the fallback for
 * browsers without CompressionStream.
 *
 * Also hosts the filename sanitizer — pure, and pinned by the share-image
 * check script, which imports this module through Node type stripping (so:
 * no JSX imports, browser globals only inside function bodies, constructor
 * fields assigned in the body).
 */
import type { RasterizedSlice } from './rasterize.ts'

/** Basename used when the session title cleans down to nothing. */
export const FALLBACK_SHARE_BASE_NAME = 'share-card'
/**
 * Max characters (code points, not UTF-16 units) kept from the title. The
 * `-NN.png` suffix adds 7; 50 + 7 stays far inside every filesystem's 255
 * byte-name limit even once UTF-8 doubles the CJK characters.
 */
export const SHARE_NAME_MAX = 50

/** XML 1.0-invalid control characters (same set rasterize.ts scrubs). */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
/**
 * Bidirectional format characters — LRM/RLM plus the LRE/RLE/PDF/LRO/RLO
 * family: zero-width, and in a filename they visually reorder the characters
 * around them (the classic `photo\u202Egpj.png` reads as a .jpg-extension
 * spoof), so they are stripped like controls rather than kept.
 */
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E]/g
/** Path separators of every mainstream filesystem — removed, not replaced in place. */
const PATH_SEPARATORS = /[\\/]/g
/** Any whitespace run — collapsed to a single space. */
const WHITESPACE_RUN = /\s+/g

/**
 * Pure: session title → portable file basename. Path separators, control
 * characters and bidi format characters are removed (a separator in a
 * download name lets a hostile title pick the destination directory; a bidi
 * character visually reorders the name into an extension spoof), whitespace
 * runs fold to one space, the result is length-capped on code points (no
 * splitting surrogate pairs) and falls back to {@link FALLBACK_SHARE_BASE_NAME}
 * when nothing survives.
 */
export function sanitizeShareFileName(title: string): string {
  const cleaned = title
    .replace(CONTROL_CHARS, '')
    .replace(BIDI_CONTROLS, '')
    .replace(PATH_SEPARATORS, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim()
  if (cleaned === '') return FALLBACK_SHARE_BASE_NAME
  const chars = Array.from(cleaned)
  if (chars.length > SHARE_NAME_MAX) {
    const capped = chars.slice(0, SHARE_NAME_MAX).join('').trim()
    return capped === '' ? FALLBACK_SHARE_BASE_NAME : capped
  }
  return cleaned
}

/**
 * File name of slice {@link index} (0-based): `<base>-NN.png`. Two digits
 * cover the rasterizer's 24-slice ceiling with room to spare and sort
 * lexicographically in every receiver's file list. Legacy multi-file fallback
 * only (ticket 07 stitches first when the browser supports it).
 */
export function shareSliceFileName(base: string, index: number): string {
  return `${base}-${String(index + 1).padStart(2, '0')}.png`
}

/**
 * File name of the stitched single long image (ticket 07): `<base>.png` — no
 * slice suffix, the deliverable is one file.
 */
export function shareImageFileName(base: string): string {
  return `${base}.png`
}

/** How the images left the page — for status copy and instrumentation. */
export type ShareDeliveryMethod = 'shared' | 'downloaded' | 'cancelled'

interface NavigatorWithShare {
  canShare?: (data: { files?: File[] }) => boolean
  share?: (data: { files?: File[] }) => Promise<void>
}

/** User dismissed the system share panel — not an error, nothing to retry. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** One entry of a {@link downloadBlobSequence}: the bytes and the file name. */
export interface DownloadEntry {
  blob: Blob
  name: string
}

/**
 * The `<a download>` fallback, as one paced sequence (review 07+08 cleanup —
 * previously tripled across this module and the debug preview's export):
 * object URL → programmatic anchor click → delayed revoke per entry, with
 * consecutive clicks spaced 300ms apart so browsers do not coalesce or block
 * them. A single entry is simply one click with no pause.
 */
export async function downloadBlobSequence(entries: readonly DownloadEntry[]): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    const url = URL.createObjectURL(entry.blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = entry.name
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    if (index < entries.length - 1) await new Promise((resolve) => window.setTimeout(resolve, 300))
  }
}

/** The `<a download>` fallback: one paced click per file. */
async function downloadFiles(files: readonly File[]): Promise<void> {
  await downloadBlobSequence(files.map((file) => ({ blob: file, name: file.name })))
}

/**
 * Deliver rasterized slices (legacy multi-file fallback): system share panel
 * when the browser accepts files, downloads otherwise. A share() rejection
 * that is NOT the user's own cancel — classically NotAllowedError, because
 * seconds of rasterizing spent the click's transient activation — falls
 * through to downloads rather than discarding the finished PNGs.
 */
export async function deliverShareImages(slices: readonly RasterizedSlice[], title: string): Promise<ShareDeliveryMethod> {
  const base = sanitizeShareFileName(title)
  const files = slices.map((slice, index) => new File([slice.blob], shareSliceFileName(base, index), { type: 'image/png' }))
  return deliverFiles(files)
}

/**
 * Deliver the stitched single long image (ticket 07): ONE `<base>.png` through
 * the system share panel, or a single download where the Web Share API is
 * missing/refusing — never a file sequence.
 */
export async function deliverShareImage(png: Blob, title: string): Promise<ShareDeliveryMethod> {
  const base = sanitizeShareFileName(title)
  return deliverFiles([new File([png], shareImageFileName(base), { type: 'image/png' })])
}

/** Shared delivery tail: share panel, else one paced download per file. */
async function deliverFiles(input: readonly File[]): Promise<ShareDeliveryMethod> {
  const files = [...input] // mutable shallow copy — the navigator.share shape wants File[]
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as NavigatorWithShare)
  if (typeof nav?.canShare === 'function' && typeof nav.share === 'function' && nav.canShare({ files })) {
    try {
      await nav.share({ files })
      return 'shared'
    } catch (err) {
      if (isAbortError(err)) return 'cancelled'
      await downloadFiles(files)
      return 'downloaded'
    }
  }
  await downloadFiles(files)
  return 'downloaded'
}
