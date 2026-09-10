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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** Exact route the browser GETs a session's share transcript from. */
export declare const SHARE_EXPORT_ROUTE = "/_dsh/mobile-nav/share-export";
/** One exportable content block of a transcript row. */
export type ShareBlock = {
    kind: 'text';
    text: string;
} | {
    kind: 'image';
};
/** One transcript row. `seq` is the source event's log position — stable
 * across re-renders, usable as a React key, and (in the range=last ticket)
 * the anchor the server slices turns by. */
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
export declare function foldShareTurns(events: readonly SessionEvent[]): ShareTurn[];
/**
 * Handle one `GET {@link SHARE_EXPORT_ROUTE}?session=<id>&range=all` request.
 *
 * Exported so an integration test can drive it with a plain node:http server
 * and a fake sessionQuery service instead of booting a harness.
 * @param ctx - host context carrying the sessionQuery service and logger.
 * @param req - inbound request; no body is read.
 * @param res - the response this call owns end to end.
 */
export declare function handleShareExport(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void>;
//# sourceMappingURL=share-export.d.ts.map