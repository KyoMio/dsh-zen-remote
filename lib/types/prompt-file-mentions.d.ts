/** One `@path` occurrence in a text part. */
export interface FileMention {
    /** Offset of the leading `@`. */
    start: number;
    /** Offset just past the mention (exclusive). */
    end: number;
    /** The mention's path, quotes stripped. */
    path: string;
}
/**
 * True when a path must NEVER be read and shipped by the mention materializer.
 *
 * The client uploads any absolute path a prompt mentions, so a pasted log line
 * that happens to contain `~/.dsh/lan-gate-state.json` (the pairing table and
 * the VAPID keys) or `~/.ssh/id_ed25519` would silently exfiltrate a secret to
 * the host. The reviewer of the upstream PR called this out; the denylist is
 * deliberately broad and fail-closed: DSH's own home (keys, shares, attachment
 * store), the usual credential directories, and credential-looking file names.
 *
 * @param path - one resolved absolute path.
 * @param dshHome - DSH home (tests inject one); defaults to DSH_HOME or ~/.dsh.
 * @returns whether the path is refused.
 */
export declare function isSensitivePath(path: string, dshHome?: string): boolean;
/** Absolute in either spelling the Host accepts: POSIX, Windows drive, UNC. */
export declare function isAbsolutePathMention(path: string): boolean;
/**
 * Every absolute-path `@` mention in one text part, in order.
 *
 * A mention starts at `@` unless the preceding character could be part of an
 * ASCII identifier local-part — `邮箱@example.com` / `foo@/root/x` must not
 * become paths, while a CJK character or prose punctuation immediately before
 * the `@` does open one (dragging a file into a half-typed Chinese sentence
 * inserts `吗@C:\...` with no space). The quoted form
 * `@"…"` ends at the closing quote; the bare form ends at whitespace. A
 * trailing `)`, `]`, `}` or `）` is trimmed because prose wraps paths in
 * them; a bare token with none of those follows.
 * @param text - one prompt text part.
 * @returns the mention ranges and their paths.
 */
export declare function fileMentionsIn(text: string): FileMention[];
/** The relay face this module needs (invoke for the host probe, the two
 * binary channels for bytes). */
export interface MentionRelay {
    invoke(namespace: string, method: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
    upload(options: {
        sessionId: string;
        name?: string;
        body: ReadableStream<Uint8Array> | null;
        bytes?: number;
    }, signal?: AbortSignal): Promise<{
        status: number;
        body: string;
    }>;
    /** Visible-path upload (2.3.0); absent on an older client wiring. */
    promptAttachment?(options: {
        sessionId: string;
        name?: string;
        body: ReadableStream<Uint8Array> | null;
        bytes?: number;
    }, signal?: AbortSignal): Promise<{
        path: string;
    }>;
}
/**
 * Rewrite one forwarded prompt's locale-path mentions into file receipts.
 *
 * @param args - the invoke arguments (`{ request: { sessionId, content } }`);
 *   mutated in place only when at least one mention was staged.
 * @param relay - the relay face (host probe + binary upload).
 * @param signal - the call's cancellation.
 * @returns the same arguments object, possibly rewritten.
 */
export declare function materializeLocalFileMentions(args: unknown, relay: MentionRelay, signal?: AbortSignal): Promise<unknown>;
//# sourceMappingURL=prompt-file-mentions.d.ts.map