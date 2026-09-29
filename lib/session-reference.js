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
export const SESSION_REFERENCE_URI = /@\[(?:\\.|[^\\\]])*\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu;
/** Encode one session id into the canonical reference URI (matching the
 * host's encoder, the mirror of {@link decodeSessionReferenceUri}). */
export function encodeSessionReferenceUri(sessionId) {
    return `dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')}`;
}
/**
 * Decode one `dsh-session:` URI the way the host does, or `undefined` when
 * it is not canonical. The host parser THROWS on non-canonical addresses —
 * those become gateway business errors — so an address this decoder rejects
 * can never inject anything and needs no guarding.
 */
export function decodeSessionReferenceUri(uri) {
    const payload = uri.slice('dsh-session:'.length);
    if (!/^[A-Za-z0-9_-]+$/.test(payload))
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (typeof parsed !== 'string')
            return undefined;
        if (encodeSessionReferenceUri(parsed).slice('dsh-session:'.length) !== payload)
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** The text blocks of one content array, visited in order. */
function visitTextBlocks(content, visit) {
    if (!Array.isArray(content))
        return false;
    let changed = false;
    for (const block of content) {
        if (!isPlainObject(block) || block.type !== 'text' || typeof block.text !== 'string')
            continue;
        const next = visit(block.text);
        if (next !== block.text) {
            block.text = next;
            changed = true;
        }
    }
    return changed;
}
/** Clone-on-write deep map over every string (the commands/execute walk):
 * containers rebuild only when something inside them changed. */
function mapDeep(value, visit) {
    if (typeof value === 'string') {
        const next = visit(value);
        return next === value ? { value, changed: false } : { value: next, changed: true };
    }
    if (Array.isArray(value)) {
        let changed = false;
        const next = value.map((item) => {
            const mapped = mapDeep(item, visit);
            changed = changed || mapped.changed;
            return mapped.value;
        });
        return changed ? { value: next, changed: true } : { value, changed: false };
    }
    if (isPlainObject(value)) {
        let changed = false;
        const next = {};
        for (const [key, item] of Object.entries(value)) {
            const mapped = mapDeep(item, visit);
            changed = changed || mapped.changed;
            next[key] = mapped.value;
        }
        return changed ? { value: next, changed: true } : { value, changed: false };
    }
    return { value, changed: false };
}
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
export function mapReferenceTexts(namespace, method, args, visit) {
    if (!isPlainObject(args))
        return args;
    const request = isPlainObject(args.request) ? args.request : undefined;
    if ((namespace === 'session' && method === 'prompt') || (namespace === 'subagents' && method === 'prompt')) {
        if (request !== undefined)
            visitTextBlocks(request.content, visit);
        return args;
    }
    if (namespace === 'session' && method === 'updateQueue') {
        if (request !== undefined && isPlainObject(request.action) && request.action.kind === 'edit') {
            visitTextBlocks(request.action.content, visit);
        }
        return args;
    }
    if (namespace === 'commands' && method === 'execute') {
        const mapped = mapDeep(args, visit);
        return mapped.value;
    }
    return args;
}
/**
 * The texts of one call the host would inject through, read-only — the
 * server-side face of {@link mapReferenceTexts}.
 */
export function collectReferenceTexts(namespace, method, args) {
    const texts = [];
    mapReferenceTexts(namespace, method, args, (text) => {
        texts.push(text);
        return text;
    });
    return texts;
}
//# sourceMappingURL=session-reference.js.map