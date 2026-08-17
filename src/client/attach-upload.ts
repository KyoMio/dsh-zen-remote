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
export const UPLOAD_ROUTE = '/_dsh/mobile-nav/upload'

/** Workspace-relative directory uploads land in; also the `@` mention prefix. */
export const UPLOAD_DIR = '.dsh-uploads'

/**
 * One attachment mention in the draft.
 *
 * `\S+` is safe as the terminator because {@link safeUploadName} (host side)
 * folds every whitespace run in a filename into `_` — a path with a space in
 * it would break the `@` mention for the agent too, not just for this regex.
 */
const MENTION = new RegExp(`@(${UPLOAD_DIR.replace('.', '\\.')}/\\S+)`, 'g')

/**
 * The upload URL for one file. Root-relative on purpose: through the
 * dsh-mobile-pwa gateway the pairing cookie only rides along same-origin.
 * @param sessionId - target session (its workspace receives the file).
 * @param name - the browser filename; the host sanitizes it again.
 * @returns a root-relative URL.
 */
export function uploadUrl(sessionId: string, name: string): string {
  const query = new URLSearchParams({ session: sessionId, name })
  return `${UPLOAD_ROUTE}?${query.toString()}`
}

/**
 * Every attachment mentioned in a draft, in reading order, without repeats.
 * @param draft - the composer draft text.
 * @returns workspace-relative paths (no leading `@`).
 */
export function mentionsIn(draft: string): string[] {
  return [...new Set([...draft.matchAll(MENTION)].map((match) => match[1] as string))]
}

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
export function draftWithMention(draft: string, relPath: string): string {
  if (draft === '' || draft.endsWith('\n') || draft.endsWith(' ')) return `${draft}@${relPath} `
  return `${draft} @${relPath} `
}

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
export function draftWithoutMention(draft: string, relPath: string): string {
  const token = `@${relPath}`
  const next = draft.split(`${token} `).join('').split(token).join('')
  return next.trim() === '' ? '' : next
}

/** The filename part of a workspace-relative path. */
export function leafOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1)
}

/**
 * Shorten a filename from the MIDDLE, so both the stem and the extension stay
 * readable (CSS `text-overflow` can only cut one end).
 * @param text - the filename.
 * @param max - budget in characters, including the ellipsis.
 * @returns the original when it fits, else head + `…` + tail.
 */
export function middleEllipsis(text: string, max = 18): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`
}

/**
 * Preview URLs by attachment path.
 *
 * Module-level because the button that creates them and the chip row that
 * renders them are two different slot entries with no shared React ancestor.
 * Nothing persists it: after a reload the draft still carries the mentions
 * (it is persisted) but this map is empty, so those chips render as file
 * chips. That degradation is correct — the browser-owned blob is gone.
 */
const thumbnails = new Map<string, string>()

/**
 * Register a preview for an uploaded image.
 * @param relPath - workspace-relative path the file landed on.
 * @param blob - the browser-owned file.
 */
export function rememberThumbnail(relPath: string, blob: Blob): void {
  if (!blob.type.startsWith('image/')) return
  const previous = thumbnails.get(relPath)
  if (previous !== undefined) URL.revokeObjectURL(previous)
  thumbnails.set(relPath, URL.createObjectURL(blob))
}

/** The preview URL for one attachment, or undefined when there is none. */
export function thumbnailFor(relPath: string): string | undefined {
  return thumbnails.get(relPath)
}

/**
 * Revoke and forget every preview whose attachment is no longer in the draft.
 * Called whenever the chip row re-renders, so a removed chip frees its blob.
 * @param keep - the attachments still mentioned.
 */
export function releaseThumbnailsExcept(keep: readonly string[]): void {
  const live = new Set(keep)
  for (const [relPath, url] of thumbnails) {
    if (live.has(relPath)) continue
    URL.revokeObjectURL(url)
    thumbnails.delete(relPath)
  }
}
