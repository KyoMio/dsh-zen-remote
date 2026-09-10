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
/** Upper bound on `turns` for `range=last` (PLAN §4). 500 exchanges is
 * already more wall of text than any share card wants, and the cap keeps a
 * careless `turns=99999999` from quietly meaning "the whole log". */
export const MAX_SHARE_TURNS = 500;
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
 * Validate the `range`/`turns` pair. Absent `range` means `all`; `last`
 * must carry exactly one `turns` that is a plain integer 1–500 — the phone
 * only offers presets, so a fractional/negative/oversized/repeated value is
 * a hand-typed URL or a client bug, and a loud 400 beats slicing to a
 * guessed intent. `turns` next to any other range (or to none) is rejected
 * rather than ignored: silently dropping it would answer a different
 * question than the URL asks.
 */
function parseRange(url) {
    const values = url.searchParams.getAll('range');
    const value = values[0];
    if (values.length === 0)
        return { kind: 'all' };
    if (values.length !== 1 || value === undefined || value === '') {
        throw new ShareExportError(400, 'bad-request', 'range is allowed at most once');
    }
    if (value === 'all')
        return { kind: 'all' };
    if (value !== 'last') {
        throw new ShareExportError(400, 'bad-request', `unsupported range: ${value}`);
    }
    const turnsList = url.searchParams.getAll('turns');
    const turns = turnsList[0];
    if (turnsList.length !== 1 || turns === undefined || turns === '') {
        throw new ShareExportError(400, 'bad-request', 'turns is required exactly once when range=last');
    }
    const count = /^[0-9]+$/.test(turns) ? Number(turns) : Number.NaN;
    if (!Number.isInteger(count) || count < 1 || count > MAX_SHARE_TURNS) {
        throw new ShareExportError(400, 'bad-request', `turns must be an integer between 1 and ${MAX_SHARE_TURNS}`);
    }
    return { kind: 'last', turns: count };
}
/** Reject a `turns` parameter on a request that is not range=last. */
function rejectStrayTurns(url) {
    if (url.searchParams.has('turns')) {
        throw new ShareExportError(400, 'bad-request', 'turns is only valid with range=last');
    }
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
 * - a row that survives every filter above but yields no exportable block
 *   (a file-only human message, a tool-call-only assistant step) is KEPT
 *   here with `blocks: []`: the turn grouping below needs the conversation's
 *   true anchor shape, and only the serializers drop the empties.
 * @param events - complete log, contiguous ascending seq.
 * @returns the admitted rows in conversation order, empty ones included.
 */
function foldRows(events) {
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
        turns.push({ role: msg.role, seq: event.seq, blocks });
    }
    return turns;
}
/**
 * The `range=all` body: {@link foldRows} minus the rows with no exportable
 * blocks — an empty bubble is not worth shipping.
 * @param events - complete log, contiguous ascending seq.
 * @returns the transcript rows in conversation order.
 */
export function foldShareTurns(events) {
    return foldRows(events).filter((row) => row.blocks.length > 0);
}
/**
 * Group folded rows into conversation turns (PLAN §4): one turn is a user
 * anchor — every user row the fold admits is human-authored by its source
 * filter — plus the assistant rows up to the next anchor. Assistant rows
 * before the FIRST anchor form turn 0: a fork inherits history that begins
 * mid-conversation, and those rows belong to no anchor yet.
 */
function groupRowsIntoTurns(rows) {
    const groups = [];
    let current = [];
    for (const row of rows) {
        // An empty `current` on an anchor means the log OPENED on this anchor:
        // nothing was inherited, so turn 0 simply does not exist here.
        if (row.role === 'user' && current.length > 0) {
            groups.push(current);
            current = [];
        }
        current.push(row);
    }
    if (current.length > 0)
        groups.push(current);
    return groups;
}
/**
 * The `range=last&turns=N` body: the transcript of the last N turns that
 * fold to at least one block. Walked from the end so a turn whose every row
 * went empty (a file-only message answered by tool-call-only steps — the
 * exchange happened, but a share card has nothing to show) is skipped
 * WITHOUT eating one of the N slots; rows that went empty INSIDE a kept
 * turn still never serialize. Only the selected tail is returned — the cut
 * head never reaches the response body.
 */
function sliceLastTurns(rows, count) {
    const groups = groupRowsIntoTurns(rows);
    const selected = [];
    let remaining = count;
    for (let i = groups.length - 1; i >= 0 && remaining > 0; i -= 1) {
        const group = groups[i];
        if (group.every((row) => row.blocks.length === 0))
            continue;
        selected.unshift(...group);
        remaining -= 1;
    }
    return selected.filter((row) => row.blocks.length > 0);
}
/**
 * Handle one `GET {@link SHARE_EXPORT_ROUTE}?session=<id>&range=all|last&turns=N`
 * request.
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
        const range = parseRange(url);
        if (range.kind === 'all')
            rejectStrayTurns(url);
        // Caller-owned observation lease (see SessionObservation): the cut is
        // pinned for this read and released in the finally below, so a burst of
        // share requests cannot pin every prepared cache entry.
        observation = await ctx.sessionQuery.observeSession(sessionId);
        // One fold of the whole log (the last N turns cannot be found from the
        // tail alone); the range decides which slice of it is serialized.
        const rows = foldRows(observation.events);
        const body = {
            ok: true,
            createdAt: observation.header.createdAt,
            turns: range.kind === 'last' ? sliceLastTurns(rows, range.turns) : rows.filter((row) => row.blocks.length > 0),
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