/**
 * S7 attachment plumbing, the parts that are pure functions.
 *
 * Kept free of React and of any DOM/platform import so `scripts/check-attach-
 * upload.mjs` can import this module directly under Node's type stripping —
 * the image path ends in `session.prompt(...)`, which SENDS a message, so the
 * only way to test its wiring without talking to a live agent is to assert the
 * payload this module builds and stop there.
 */
import type { PromptContentPart } from '@deepseek-ai/dsh-api-remotes/client';
/** Exact host route registered by the node half (src/index.ts). */
export declare const UPLOAD_ROUTE = "/_dsh/mobile-nav/upload";
/** The image branch of the prompt content union. */
type PromptImagePart = Extract<PromptContentPart, {
    type: 'image';
}>;
/** Exactly the media types the host will inline (`ImageMediaType`). */
export type PromptImageType = PromptImagePart['mediaType'];
/**
 * The media types the host accepts as an inline prompt image
 * (`ImageMediaType`, dsh-attachment types.d.ts:5). Anything else — HEIC from
 * an iPhone camera roll, a PDF, a zip — goes down the file-upload path
 * instead of being rejected.
 */
export declare const PROMPT_IMAGE_TYPES: readonly PromptImageType[];
/** One picked file already read into memory, ready to become a prompt part. */
export interface PickedImage {
    /** Display name shown to the agent; never interpreted as a path host-side. */
    name: string;
    /** One of {@link PROMPT_IMAGE_TYPES}. */
    mediaType: PromptImageType;
    /** Raw base64 — no `data:` prefix (the host decodes it verbatim). */
    base64: string;
}
/**
 * Classify one picked file: inline prompt image, or upload-to-disk.
 * @param mediaType - the browser-declared MIME type (may be empty).
 * @returns the media type when the host can inline it, else undefined.
 */
export declare function promptImageType(mediaType: string): PromptImageType | undefined;
/**
 * Build the `session.prompt` payload for a batch of picked images.
 *
 * Leading text part first (the composer draft, so a caption the user already
 * typed rides along with the photo instead of being stranded), then one image
 * part per file in pick order.
 * @param images - picked images in the order the user chose them.
 * @param text - the current composer draft; blank/whitespace contributes nothing.
 * @returns the content array for `prompt(content, 'queue')`.
 */
export declare function buildImageParts(images: readonly PickedImage[], text: string): PromptContentPart[];
/**
 * The upload URL for one file. Same-origin and relative on purpose: through
 * the dsh-mobile-pwa gateway the pairing cookie only rides along when the
 * request stays on the page's own origin.
 * @param sessionId - target session (its workspace receives the file).
 * @param name - the browser filename; the host sanitizes it again.
 * @returns a root-relative URL.
 */
export declare function uploadUrl(sessionId: string, name: string): string;
/**
 * Append one `@path` mention to the composer draft.
 *
 * Separated from whatever came before by a space (or a newline when the draft
 * already ends in one), and trailed by a space so the next mention does not
 * fuse onto this one.
 * @param draft - the current draft text.
 * @param relPath - workspace-relative path returned by the upload route.
 * @returns the next draft.
 */
export declare function draftWithMention(draft: string, relPath: string): string;
/**
 * Base64-encode bytes in chunks.
 *
 * Same shape as the official composer's `bytesToBase64`
 * (dsh-client-ui-conversation lib/client.js:289): a single spread of a
 * multi-megabyte photo blows the argument limit, so it goes 32KB at a time.
 * @param data - the file bytes.
 * @returns raw base64, no `data:` prefix.
 */
export declare function bytesToBase64(data: Uint8Array): string;
export {};
//# sourceMappingURL=attach-upload.d.ts.map