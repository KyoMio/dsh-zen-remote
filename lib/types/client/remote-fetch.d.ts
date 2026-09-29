/**
 * The sub-client's plain-HTTP relay, browser half (T41b). The session page's
 * changes / diff panel does not ride the typert gateway — it GETs
 * `/api/changes.summary` and `/api/changes.diff` with the session id in the
 * query (RT dsh-client-ui-deliverables/lib/client.js ~13-17, 90-109, 208:
 * plain call-time `fetch(url, { signal })`, document-relative string URLs),
 * so a remote session's virtual id would hit the LOCAL DSH and 404. This
 * module wraps `window.fetch` ONCE: a same-origin GET whose path is exactly
 * one of those two routes and whose `sessionId` parameter carries a virtual
 * id (`zr~` prefix, virtual-id.ts's skeleton — the strict parse happens in
 * the backend route) is rewritten to the sub-client relay route
 * `/_dsh/zen-remote/client/http/<route>?<original query>`, `init` (the
 * abort signal) passing through untouched. Every other request — local
 * sessions, any other path, cross-origin, non-GET — reaches the original
 * fetch unchanged, so a host-role deployment (whose session ids are never
 * virtual) is bit-for-bit unintercepted.
 *
 * Not covered by THIS wrapper (each surface has its own channel since T51):
 * the attachment upload's HTTP branch runs inside a Web Worker over XHR /
 * Worker-scoped fetch — unreachable from `window.fetch`, so it is intercepted
 * one layer down, at the host's exact-fetch-route table, by
 * `src/fetch-route-intercept.ts` (which relays the bytes and likewise blocks
 * the session export); `present.host` / `changes.open` / `present.open`
 * belong to entries hidden on remote sessions rather than relayed. The
 * complete not-relayed registry still lives beside the server's in
 * src/relay-access.ts.
 */
/** Prefix of the sub-client backend route the rewritten calls land on. */
export declare const CLIENT_HTTP_ROUTE_PREFIX = "/_dsh/zen-remote/client/http/";
/** The fetch face this module wraps; injectable so tests drive a fake. */
export interface FetchHost {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    location: {
        href: string;
    };
}
/**
 * The rewrite decision, pure: the relay URL for one fetch call, or
 * `undefined` to pass through untouched. Only a GET, same-origin against
 * `baseHref`, on one of the two exact paths, with a `zr~`-prefixed
 * `sessionId` rewrites — every other shape of the world returns undefined.
 */
export declare function rewriteRemoteApiUrl(input: unknown, method: string, baseHref: string): string | undefined;
/**
 * Wrap the host's `fetch` exactly once and return the uninstaller. A call
 * while a wrap is already live adopts it (no second layer, exactly one hop)
 * and takes over its ownership. The wrapper reads `location.href` per call,
 * not at install time.
 */
export declare function installRemoteApiFetch(host: FetchHost): () => void;
//# sourceMappingURL=remote-fetch.d.ts.map