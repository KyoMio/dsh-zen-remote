/**
 * Share-image transcript route (issue #7): fold one session's raw event log
 * into the flat user/assistant transcript the phone rasterizes into shareable
 * PNG cards.
 *
 * Why a host route at all: the Chat view is a paged window over a surface the
 * compactor rewrites, so the browser DOM never holds the whole conversation
 * and cloning it cannot work. The whole-log source of truth is the host-side
 * `sessionQuery` service (standard dsh-base composition), which no browser
 * half can reach.
 *
 * Why append-origin folding instead of the model-visible surface: the surface
 * deliberately shadows replaced ranges, so once a replacement lands it shows
 * LESS than the user already saw — wrong source for a human transcript (the
 * official trap note on `isAppendSurfaceEvent`). The fold below keeps every
 * append-origin message in log order and never applies the shadows, so a
 * steered or compacted session still exports everything the user saw.
 */
// The two pure projection helpers are the canonical per-node rules from the
// session package's browser-safe subpath. Duplicating them here would be a
// second fold that silently drifts from the one every other consumer uses.
import { deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
/** Exact route the browser GETs a session's share transcript from. */
export const SHARE_EXPORT_ROUTE = '/_dsh/mobile-nav/share-export';
/**
 * One rejection carrying the status the client should see.
 *
 * Fields are assigned in the body rather than declared as constructor
 * parameter properties: the check scripts import this module through Node's
 * strip-only type stripping, which rejects that syntax (same reason as
 * UploadError in index.ts).
 */
class ShareExportError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.name = 'ShareExportError';
        this.status = status;
        this.code = code;
    }
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Identical envelope to index.ts's responseJson — kept local so this route
 * module stays importable without a cycle back into the entry file. */
function responseJson(res, status, body) {
    const bytes = Buffer.from(JSON.stringify(body));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.writeHead(status);
    res.end(bytes);
}
function singleQuery(url, key) {
    const values = url.searchParams.getAll(key);
    const value = values[0];
    if (values.length !== 1 || value === undefined || value === '') {
        throw new ShareExportError(400, 'bad-request', `${key} is required exactly once`);
    }
    return value;
}
/**
 * Validate the `range` parameter. Absent means `all` (the only shape this
 * ticket ships); anything else is a 400 until the range=last ticket widens
 * the accepted set — a clear contract beat a silent wrong answer.
 */
function parseRange(url) {
    const values = url.searchParams.getAll('range');
    const value = values[0];
    if (values.length === 0)
        return 'all';
    if (values.length !== 1 || value === undefined || value === '') {
        throw new ShareExportError(400, 'bad-request', 'range is allowed at most once');
    }
    if (value !== 'all') {
        throw new ShareExportError(400, 'bad-request', `unsupported range: ${value}`);
    }
    return 'all';
}
/** `SESSION_QUERY_SESSION_NOT_FOUND`, read structurally: the error class
 * lives in a package this module only knows by type, and the taxonomy string
 * is the stable contract either side can be checked against. */
function isSessionNotFound(error) {
    return error instanceof Error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND';
}
/**
 * Fold one session's complete event log into transcript rows, in log order.
 *
 * Row admission, in the order the filters run:
 * - append-origin surface events only (`isAppendSurfaceEvent`): a replacement
 *   copy is model-only and must not add itself to the transcript, while the
 *   ranges it shadowed stay in place — that is what makes this a human
 *   transcript rather than the model surface;
 * - `deriveEventMessage` drops events that produce no message, which covers
 *   turn/step boundaries AND the usage-only empty assistant message;
 * - system never renders in a shared conversation;
 * - user rows must be human-authored (`source.kind === 'user'`): injected
 *   contexts (file notices, skill content, …) are also user-role messages,
 *   and the Chat view renders them as context rows, not conversation — a
 *   share card shows the words people exchanged, not the machinery. Steering
 *   messages ARE human-authored and stay;
 * - blocks: text passes verbatim, image becomes a `{kind:'image'}` placeholder
 *   (attachments live on the host disk and stay out of v1), everything else —
 *   reasoning (folded on the phone anyway), tool-call/tool-result, file, and
 *   block types this fold does not know — is dropped;
 * - a row left with no blocks (a tool-result message, for one) is omitted
 *   entirely rather than shipped as an empty bubble.
 * @param events - complete log, contiguous ascending seq.
 * @returns the transcript rows in conversation order.
 */
export function foldShareTurns(events) {
    const turns = [];
    for (const event of events) {
        if (!isAppendSurfaceEvent(event))
            continue;
        const msg = deriveEventMessage(event);
        if (msg === null)
            continue;
        if (msg.role !== 'user' && msg.role !== 'assistant')
            continue;
        if (msg.role === 'user' && msg.source.kind !== 'user')
            continue;
        const blocks = [];
        for (const block of msg.content) {
            if (block.type === 'text')
                blocks.push({ kind: 'text', text: block.text });
            else if (block.type === 'image')
                blocks.push({ kind: 'image' });
        }
        if (blocks.length === 0)
            continue;
        turns.push({ role: msg.role, seq: event.seq, blocks });
    }
    return turns;
}
/**
 * Handle one `GET {@link SHARE_EXPORT_ROUTE}?session=<id>&range=all` request.
 *
 * Exported so an integration test can drive it with a plain node:http server
 * and a fake sessionQuery service instead of booting a harness.
 * @param ctx - host context carrying the sessionQuery service and logger.
 * @param req - inbound request; no body is read.
 * @param res - the response this call owns end to end.
 */
export async function handleShareExport(ctx, req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } });
        return;
    }
    let observation;
    try {
        const url = new URL(req.url ?? SHARE_EXPORT_ROUTE, 'http://dsh.internal');
        const sessionId = singleQuery(url, 'session');
        parseRange(url);
        // Caller-owned observation lease (see SessionObservation): the cut is
        // pinned for this read and released in the finally below, so a burst of
        // share requests cannot pin every prepared cache entry.
        observation = await ctx.sessionQuery.observeSession(sessionId);
        const body = {
            ok: true,
            createdAt: observation.header.createdAt,
            turns: foldShareTurns(observation.events),
            truncated: false,
        };
        responseJson(res, 200, body);
    }
    catch (error) {
        const status = error instanceof ShareExportError ? error.status : isSessionNotFound(error) ? 404 : 500;
        const code = error instanceof ShareExportError ? error.code : isSessionNotFound(error) ? 'session-not-found' : 'export-failed';
        ctx.logger.warn('dsh-mobile-nav share-export rejected: %s', message(error));
        responseJson(res, status, { ok: false, error: { code, message: message(error) } });
    }
    finally {
        // The lease is disposed on every exit path that acquired it; a failed
        // observeSession never returned one.
        observation?.[Symbol.dispose]();
    }
}
//# sourceMappingURL=share-export.js.map