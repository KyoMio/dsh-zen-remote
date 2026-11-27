/**
 * The sub-client's plain-HTTP relay and plugin block-rule wrapper, browser half
 * (T41b). The session page's changes / diff panel does not ride the typert
 * gateway — it GETs `/api/changes.summary` and `/api/changes.diff` with the
 * session id in the query (RT dsh-client-ui-deliverables/lib/client.js ~13-17,
 * 90-109, 208: plain call-time `fetch(url, { signal })`, document-relative
 * string URLs), so a remote session's virtual id would hit the LOCAL DSH and
 * 404. This module wraps `window.fetch` ONCE: a same-origin GET whose path is
 * exactly one of those two routes and whose `sessionId` parameter carries a
 * virtual id (`zr~` prefix, virtual-id.ts's skeleton — the strict parse happens
 * in the backend route) is rewritten to the sub-client relay route
 * `/_dsh/zen-remote/client/http/<route>?<original query>`, `init` (the abort
 * signal) passing through untouched.
 *
 * Callers may also pass generic {@link RemoteFetchBlockRule} entries (e.g.
 * workspace-keyed plugin routes registered by an adapter rule module) so
 * remote sessions fail closed before hitting the network and local sessions on
 * client/peer nodes carry the per-request panel-session header. Every other
 * request — and every request when `shouldAnnotateLocal` returns false (host
 * role) — reaches the original fetch unchanged.
 */
/** Rule describing a same-origin fetch path class that remote sessions block
 * locally and local sessions may annotate with the panel-session header. */
export interface RemoteFetchBlockRule {
    matchPath(pathname: string): boolean;
    refusalBody(): string;
    status?: number;
    annotateLocalHeader?: boolean;
}
/** The remote-session probe, overridable in tests: whether the CURRENT
 * session on screen is a remote one, read off the html attribute
 * remote-session.ts's guard writes and remote-session.css.ts's hiding keys
 * on. Reading the attribute rather than the backend's current-session report
 * avoids the up-to-1s report lag across session switches. */
export interface RemoteSessionProbe {
    (): boolean;
}
/**
 * Test seam: swap the remote-session probe for tests. Not part of the public
 * runtime contract.
 * @param probe - override probe, or undefined to restore the default DOM probe.
 */
export declare function setRemoteSessionProbeForTests(probe: RemoteSessionProbe | undefined): void;
/** Header sent on local-session requests matching an annotating rule so the
 * backend intercept reads the same-frame page state instead of a lagged poll. */
export declare const PANEL_SESSION_HEADER = "x-zen-remote-panel-session";
/**
 * Resolve `input` against `baseHref` and return its pathname only when it is
 * same-origin with `baseHref`. Handles string, `URL`, and Request-like objects
 * carrying a string `url`.
 * @param input - fetch input argument.
 * @param baseHref - page location base URL.
 * @returns same-origin pathname, or undefined when unparseable or cross-origin.
 */
export declare function resolveSameOriginPathname(input: unknown, baseHref: string): string | undefined;
/**
 * Find the first block rule whose `matchPath` accepts the same-origin pathname
 * of `input`.
 * @param input - fetch input argument.
 * @param baseHref - page location base URL.
 * @param rules - configured block rules.
 * @returns matching rule, or undefined.
 */
export declare function matchFetchBlockRule(input: unknown, baseHref: string, rules: readonly RemoteFetchBlockRule[]): RemoteFetchBlockRule | undefined;
/**
 * Pure block decision: whether one fetch call must be blocked locally before
 * reaching the network.
 * @param input - fetch input argument.
 * @param baseHref - page location base URL.
 * @param isRemote - whether the active session on screen is remote.
 * @param rules - configured block rules.
 * @returns true when `isRemote` is true and a rule matches `input`.
 */
export declare function shouldBlockFetchCall(input: unknown, baseHref: string, isRemote: boolean, rules: readonly RemoteFetchBlockRule[]): boolean;
/**
 * Build a `RequestInit` carrying `x-zen-remote-panel-session: local` while
 * preserving headers from BOTH `input` (`Request` or Request-like `.headers`)
 * and `init?.headers` (plain record, tuple array, or `Headers`-like `.forEach`).
 * All header keys are normalized to lowercase so case variants cannot produce
 * duplicate headers and any prior value for the panel-session header is
 * replaced cleanly.
 * @param input - fetch input argument.
 * @param init - optional caller `RequestInit`.
 * @returns new `RequestInit` with normalized headers and the local annotation.
 */
export declare function annotatePanelHeader(input: unknown, init?: RequestInit): RequestInit;
/** Prefix of the sub-client backend route the rewritten calls land on. */
export declare const CLIENT_HTTP_ROUTE_PREFIX = "/_dsh/zen-remote/client/http/";
/** The fetch face this module wraps; injectable so tests drive a fake. */
export interface FetchHost {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    location: {
        href: string;
    };
}
/** Options configuring plugin block rules and local header annotation. */
export interface InstallRemoteApiFetchOptions {
    blockRules?: readonly RemoteFetchBlockRule[];
    shouldAnnotateLocal?: () => boolean;
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
 * while a wrap is already live adopts it (no second layer, exactly one hop),
 * updates the active options, and takes over its ownership. The wrapper reads
 * `location.href` per call, not at install time.
 * @param host - window-like object exposing `fetch` and `location.href`.
 * @param options - optional block rules and local-annotation gate.
 * @returns uninstaller function for this install generation.
 */
export declare function installRemoteApiFetch(host: FetchHost, options?: InstallRemoteApiFetchOptions): () => void;
//# sourceMappingURL=remote-fetch.d.ts.map