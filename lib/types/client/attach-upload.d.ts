/**
 * S7 attachment plumbing: the string math plus the thumbnail registry.
 *
 * Kept free of React so `scripts/check-attach-upload.mjs` can import it
 * directly under Node's type stripping.
 *
 * The one idea worth stating up front: **the composer draft is the only state
 * this feature has.** Every attachment is an `@.dsh-uploads/name` token in the
 * draft text, and the chip row is a pure function of that text. Nothing to
 * keep in sync — the user deleting the token by hand, or the official send
 * clearing the draft, makes the chips disappear on their own.
 */
/** Exact host route registered by the node half (src/index.ts). */
export declare const UPLOAD_ROUTE = "/_dsh/mobile-nav/upload";
/** Workspace-relative directory uploads land in; also the `@` mention prefix. */
export declare const UPLOAD_DIR = ".dsh-uploads";
/**
 * The upload URL for one file. Root-relative on purpose: through the
 * gateway half the pairing cookie only rides along same-origin.
 * @param sessionId - target session (its workspace receives the file).
 * @param name - the browser filename; the host sanitizes it again.
 * @returns a root-relative URL.
 */
export declare function uploadUrl(sessionId: string, name: string): string;
/**
 * Every attachment mentioned in a draft, in reading order, without repeats.
 * @param draft - the composer draft text.
 * @returns workspace-relative paths (no leading `@`).
 */
export declare function mentionsIn(draft: string): string[];
/**
 * Append one `@path` mention to the draft.
 *
 * Separated from whatever came before by a space (or a newline when the draft
 * already ends in one), and trailed by a space so the next mention does not
 * fuse onto this one — and so {@link draftWithoutMention} can lift it back out
 * without leaving a double space behind.
 * @param draft - the current draft text.
 * @param relPath - workspace-relative path returned by the upload route.
 * @returns the next draft.
 */
export declare function draftWithMention(draft: string, relPath: string): string;
/**
 * Remove one `@path` mention from the draft — what a chip's × does.
 *
 * The file itself stays on disk: it is a few KB in a directory the user can
 * clear whenever, and deleting it would need a second host route whose only
 * job is destruction.
 * @param draft - the current draft text.
 * @param relPath - the attachment to drop.
 * @returns the next draft; whitespace-only collapses to empty.
 */
export declare function draftWithoutMention(draft: string, relPath: string): string;
/** The filename part of a workspace-relative path. */
export declare function leafOf(relPath: string): string;
/**
 * Shorten a filename from the MIDDLE, so both the stem and the extension stay
 * readable (CSS `text-overflow` can only cut one end).
 * @param text - the filename.
 * @param max - budget in characters, including the ellipsis.
 * @returns the original when it fits, else head + `…` + tail.
 */
export declare function middleEllipsis(text: string, max?: number): string;
/**
 * Register a preview for an uploaded image.
 * @param relPath - workspace-relative path the file landed on.
 * @param blob - the browser-owned file.
 */
export declare function rememberThumbnail(relPath: string, blob: Blob): void;
/** The preview URL for one attachment, or undefined when there is none. */
export declare function thumbnailFor(relPath: string): string | undefined;
/**
 * Revoke and forget every preview whose attachment is no longer in the draft.
 * Called whenever the chip row re-renders, so a removed chip frees its blob.
 * @param keep - the attachments still mentioned.
 */
export declare function releaseThumbnailsExcept(keep: readonly string[]): void;
//# sourceMappingURL=attach-upload.d.ts.map