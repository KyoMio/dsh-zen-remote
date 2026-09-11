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
 * Why the RAW log (`readSession`) and not the observed surface: the surface
 * deliberately shadows replaced ranges, so once a replacement lands it shows
 * LESS than the user already saw — wrong source for a human transcript (the
 * official trap note on `isAppendSurfaceEvent`: append-origin events are the
 * transcript's durable source material). The raw log additionally carries the
 * `agent/inbox/spliced` bookkeeping the steering classification below folds —
 * it never exists on the surface. The fold keeps every append-origin message
 * in log order and never applies the shadows, so a steered or compacted
 * session still exports everything the user saw.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
/** Exact route the browser GETs a session's share transcript from. */
export declare const SHARE_EXPORT_ROUTE = "/_dsh/mobile-nav/share-export";
/** Upper bound on `turns` for `range=last` (PLAN §4). 500 exchanges is
 * already more wall of text than any share card wants, and the cap keeps a
 * careless `turns=99999999` from quietly meaning "the whole log". */
export declare const MAX_SHARE_TURNS = 500;
/** One exportable content block of a transcript row. */
export type ShareBlock = {
    kind: 'text';
    text: string;
} | {
    kind: 'image';
};
/** One transcript row. `seq` is the source event's log position — stable
 * across re-renders and usable as a React key; a range=last body keeps whole
 * turns, so its seqs always arrive turn-contiguous. */
export interface ShareTurn {
    role: 'user' | 'assistant';
    seq: number;
    blocks: ShareBlock[];
}
/** Response body of a successful export (PLAN §4 contract). */
export interface ShareExportBody {
    ok: true;
    /** Session creation time (Unix epoch ms) from the observed header. */
    createdAt: number;
    turns: ShareTurn[];
    /** Constant false while the server never truncates; the client's slice
     * budget is the only truncation that exists. */
    truncated: false;
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
export declare function handleShareExport(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void>;
//# sourceMappingURL=share-export.d.ts.map