/** The relay's own 500 MiB binary-channel cap, mirrored here. */
export declare const PROMPT_ATTACHMENT_MAX_BYTES: number;
/** One materialization request (the relay route's parsed query + body). */
export interface PromptAttachmentSaveInput {
    sessionId: string;
    name?: string | undefined;
    /** The raw request body; `null` writes an empty file. */
    body: ReadableStream<Uint8Array> | null;
    signal?: AbortSignal | undefined;
    /** Overrides {@link PROMPT_ATTACHMENT_MAX_BYTES} (tests). */
    maxBytes?: number | undefined;
    /** Overrides the store root (tests). */
    root?: string | undefined;
}
/** One materialized file. */
export interface PromptAttachmentSaved {
    /** Absolute path on THIS machine. */
    path: string;
    bytes: number;
}
/** The host's prompt-attachment root. */
export declare function promptAttachmentsRoot(home?: string): string;
/**
 * The stored leaf name: time, a short nonce (collision breaker for
 * same-second drops) and the sanitized original name.
 * @param name - the client's display name.
 * @param now - clock, injectable for tests.
 * @param nonce - collision breaker, injectable for tests.
 * @returns one safe leaf name.
 */
export declare function promptAttachmentFileName(name: string | undefined, now?: Date, nonce?: string): string;
/**
 * Write one uploaded file into the private materialization tree.
 *
 * The directory is created (and tightened) first; the file is opened
 * exclusively with 0600 so a collision can never truncate an earlier
 * attachment. Streams are consumed chunk by chunk under the cap; any failure
 * removes the partial file.
 * @param input - session, display name, body and cancellation.
 * @returns the absolute path and byte count.
 */
export declare function savePromptAttachment(input: PromptAttachmentSaveInput): Promise<PromptAttachmentSaved>;
/**
 * Remove files older than the janitor window (ZCode's 24h) and any directory
 * left empty. Best-effort: a permission problem in one session directory must
 * not fail the host's startup.
 * @param olderThanMs - age threshold.
 * @param root - override for tests.
 * @returns how many files were removed.
 */
export declare function cleanupStalePromptAttachments(olderThanMs?: number, root?: string, now?: number): Promise<number>;
//# sourceMappingURL=prompt-attachments.d.ts.map