/**
 * The `dsh-session:` reference discipline BOTH ends share (T41a-fix2):
 *
 * - the CODEC — the canonical reference addresses the host's own parser
 *   accepts (dsh-session-reference lib/index.js: a Markdown mention
 *   `@[label](URI)` or a bare URI; the payload is
 *   base64url(JSON.stringify(sessionId)) and the decode is CANONICAL —
 *   re-encoding must reproduce the URI byte for byte);
 * - the SCAN RULE — which texts of one relayed call DSH would inject
 *   through. `prepareDirectMessages` parses the text blocks of EVERY
 *   user-sourced message wherever the message came from, and three wire
 *   paths put remote text into such a message: the prompt content
 *   (`session/prompt`, `subagents/prompt`), a queue edit — the edit
 *   REPLACES the queued user message's content verbatim (RT
 *   dsh-api-session-controller updateQueue) — and a slash command's raw
 *   input, which handlers steer in as a fresh user message (`/plan <text>`
 *   does exactly that, RT dsh-plan-mode). So the rule reads:
 *
 *     `session/prompt` / `subagents/prompt` → the text blocks of
 *       `request.content`;
 *     `session/updateQueue` → when `request.action.kind === 'edit'`, the
 *       text blocks of `request.action.content` (steer/remove carry no
 *       content the host would inject);
 *     `commands/execute` → EVERY string in the arguments, recursively —
 *       the injection surface is whatever the command's handler does with
 *       the line, so the scan does not depend on the argument field name.
 *
 *   Everything else contributes nothing. The relay server decodes every
 *   reference found in these texts and refuses the call when one names a
 *   session off its share table (relay-server.ts); the sub-client restores
 *   THIS server's virtual ids inside them and refuses references naming
 *   anything else (intercept.ts). One module serves both so the ends
 *   cannot drift — the previous two private copies are gone.
 *
 * Pure functions, no I/O; safe for both the host bundle and the tests.
 */
/** The canonical reference shape, as {@link decodeSessionReferenceUri}
 * consumes it. Match group 1 is a mention's URI, group 2 a bare URI. */
export declare const SESSION_REFERENCE_URI: RegExp;
/** Encode one session id into the canonical reference URI (matching the
 * host's encoder, the mirror of {@link decodeSessionReferenceUri}). */
export declare function encodeSessionReferenceUri(sessionId: string): string;
/**
 * Decode one `dsh-session:` URI the way the host does, or `undefined` when
 * it is not canonical. The host parser THROWS on non-canonical addresses —
 * those become gateway business errors — so an address this decoder rejects
 * can never inject anything and needs no guarding.
 */
export declare function decodeSessionReferenceUri(uri: string): string | undefined;
/**
 * Apply `visit` to EVERY text of one call the host would inject through —
 * the scan rule above, in one place. The args are mutated IN PLACE where
 * the rule reaches (content blocks) and rebuilt clone-on-write where it
 * walks recursively (commands/execute); the returned args are what should
 * travel (identical to the input when `visit` was the identity on every
 * text). Both ends call THIS to decide what to scan — the server to check,
 * the client to rewrite — so the two cannot disagree on where references
 * hide.
 */
export declare function mapReferenceTexts(namespace: string, method: string, args: unknown, visit: (text: string) => string): unknown;
/**
 * The texts of one call the host would inject through, read-only — the
 * server-side face of {@link mapReferenceTexts}.
 */
export declare function collectReferenceTexts(namespace: string, method: string, args: unknown): string[];
//# sourceMappingURL=session-reference.d.ts.map