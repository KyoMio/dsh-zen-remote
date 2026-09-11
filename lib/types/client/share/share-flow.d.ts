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
import type { RasterizedSlice } from './rasterize.ts';
/** Basename used when the session title cleans down to nothing. */
export declare const FALLBACK_SHARE_BASE_NAME = "share-card";
/**
 * Max characters (code points, not UTF-16 units) kept from the title. The
 * `-NN.png` suffix adds 7; 50 + 7 stays far inside every filesystem's 255
 * byte-name limit even once UTF-8 doubles the CJK characters.
 */
export declare const SHARE_NAME_MAX = 50;
/**
 * Pure: session title → portable file basename. Path separators, control
 * characters and bidi format characters are removed (a separator in a
 * download name lets a hostile title pick the destination directory; a bidi
 * character visually reorders the name into an extension spoof), whitespace
 * runs fold to one space, the result is length-capped on code points (no
 * splitting surrogate pairs) and falls back to {@link FALLBACK_SHARE_BASE_NAME}
 * when nothing survives.
 */
export declare function sanitizeShareFileName(title: string): string;
/**
 * File name of slice {@link index} (0-based): `<base>-NN.png`. Two digits
 * cover the rasterizer's 24-slice ceiling with room to spare and sort
 * lexicographically in every receiver's file list. Legacy multi-file fallback
 * only (ticket 07 stitches first when the browser supports it).
 */
export declare function shareSliceFileName(base: string, index: number): string;
/**
 * File name of the stitched single long image (ticket 07): `<base>.png` — no
 * slice suffix, the deliverable is one file.
 */
export declare function shareImageFileName(base: string): string;
/** How the images left the page — for status copy and instrumentation. */
export type ShareDeliveryMethod = 'shared' | 'downloaded' | 'cancelled';
/** One entry of a {@link downloadBlobSequence}: the bytes and the file name. */
export interface DownloadEntry {
    blob: Blob;
    name: string;
}
/**
 * The `<a download>` fallback, as one paced sequence (review 07+08 cleanup —
 * previously tripled across this module and the debug preview's export):
 * object URL → programmatic anchor click → delayed revoke per entry, with
 * consecutive clicks spaced 300ms apart so browsers do not coalesce or block
 * them. A single entry is simply one click with no pause.
 */
export declare function downloadBlobSequence(entries: readonly DownloadEntry[]): Promise<void>;
/**
 * Deliver rasterized slices (legacy multi-file fallback): system share panel
 * when the browser accepts files, downloads otherwise. A share() rejection
 * that is NOT the user's own cancel — classically NotAllowedError, because
 * seconds of rasterizing spent the click's transient activation — falls
 * through to downloads rather than discarding the finished PNGs.
 */
export declare function deliverShareImages(slices: readonly RasterizedSlice[], title: string): Promise<ShareDeliveryMethod>;
/**
 * Deliver the stitched single long image (ticket 07): ONE `<base>.png` through
 * the system share panel, or a single download where the Web Share API is
 * missing/refusing — never a file sequence.
 */
export declare function deliverShareImage(png: Blob, title: string): Promise<ShareDeliveryMethod>;
//# sourceMappingURL=share-flow.d.ts.map