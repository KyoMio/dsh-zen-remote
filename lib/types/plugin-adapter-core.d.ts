/**
 * The plugin bridge's adapter core (PB-11) — the framework half of the
 * pluggable adapters. A cooperative plugin registers its OWN bridge
 * declaration (PB-1); an adapter is zen-remote-internal code, written
 * against one third-party plugin's EXACT version, that locates the session
 * ids in that plugin's requests and rewrites them both ways (GLOSSARY:
 * 适配器). This module owns everything the framework needs to run one:
 * the route/locator shapes, their validation, the locate → classify →
 * rewrite pipeline, and the digest the adapter registers under.
 *
 * Deliberately OUTSIDE `src/adapters/`: the pluggability contract
 * (test/adapters-pluggable.test.cjs) is that deleting that directory breaks
 * ONLY the wiring import in src/index.ts. The adapter-author face — the
 * `BridgeAdapter` interface — lives in `src/adapters/types.ts` ON TOP of
 * the shapes defined here (it re-exports them), so the framework never
 * imports a single thing from `src/adapters/`.
 *
 * Pure logic: no DSH, no I/O. The id semantics ride src/virtual-id.ts —
 * a request counts as REMOTE exactly when every id the route's locator
 * finds is a `zr~` virtual id, and the rewrite swaps each for its real
 * half before the request leaves for the relay (docs/adr/0001: the
 * sub-client never lets a remote session's request reach a local plugin).
 */
import { fromVirtual } from './virtual-id.js';
import type { NormalizedDeclaration } from './plugin-bridge.js';
export { fromVirtual };
/** Where a route's session id lives in a request (`AdapterRoute.locator`).
 * `query` names the search parameter; `path-segment` counts segments AFTER
 * the declared path (a `prefix` route's variable part, already decoded once
 * off the wire); `json-body` names TOP-LEVEL fields of the parsed JSON
 * request body — every one of those fields that is present counts. */
export type AdapterLocator = {
    in: 'query';
    name: string;
} | {
    in: 'path-segment';
    index: number;
} | {
    in: 'json-body';
    fields: readonly string[];
};
/** One adapter route as the adapter declares it. `match: 'prefix'` hits
 * `pathname === path || pathname.startsWith(path + '/')` on the RAW
 * undecoded pathname; `exact` is the equality alone. `local: true` marks a
 * path that stays on the sub-client's own machine forever (static assets
 * and the like) — it never forwards, in either direction.
 *
 * `deny` (optional) answers a reason string for requests that must refuse
 * BEFORE any id locating happens — the better-sidebar adapter uses it to
 * refuse `open.external` when the browser's CURRENT session is a remote
 * one (the request itself carries no session field, so the classify step
 * would otherwise read it as local) and the side-chat methods wholesale.
 * A `deny` hit answers the bridge's uniform 503 with that reason; returning
 * `undefined` falls through to the normal classify. */
export interface AdapterRoute {
    path: string;
    match: 'exact' | 'prefix';
    methods?: readonly string[];
    maxBody?: number;
    stream?: boolean;
    upgrade?: boolean;
    locator: AdapterLocator;
    local?: boolean;
    deny?: (info: {
        pathname: string;
        method: string;
        currentSessionId: string | undefined;
    }) => string | undefined;
}
/** One adapter route after validation: every scalar filled with its
 * EFFECTIVE value (the adapters have no legacy-digest constraint, so
 * unlike the cooperative {@link NormalizedBridgeRoute} the canonical form
 * always carries the defaults). `deny` rides along by reference — a
 * function cannot enter the digest, and it is client-half logic the
 * server never needs. */
export interface NormalizedAdapterRoute {
    path: string;
    match: 'exact' | 'prefix';
    methods: string[];
    maxBody: number;
    stream: boolean;
    upgrade: boolean;
    locator: AdapterLocator;
    local: boolean;
    deny?: AdapterRoute['deny'];
}
/** The two hook faces an adapter may implement (both optional — an adapter
 * that only relocates ids needs neither). `client.request` runs on the
 * sub-client AFTER the ids are rewritten to their real halves and can
 * refuse the forward outright or swap the parsed JSON body;
 * `client.response` runs on the sub-client on a JSON answer and returns
 * the rewritten body (real ids back to virtual form). `server.request`
 * runs on the main server before the loopback and can strip fields (e.g.
 * a `cwd`) the local machine must not receive. */
export interface AdapterRequestContext {
    method: string;
    /** The full request pathname (RAW, undecoded) — a prefix route's
     * tail segment is where better-sidebar carries its API method name. */
    pathname: string;
    /** The matched route, as declared. */
    route: AdapterRoute;
    /** The request's query, ids already in their REAL form. */
    query: URLSearchParams;
    /** The parsed JSON request body when the route locates in the body and a
     * body arrived; `undefined` otherwise. */
    body: unknown;
}
/** The verdict of a request hook: allow (optionally replacing the JSON
 * body and/or the query — the better-sidebar adapter strips the `cwd`
 * query field of the file/upload routes so the backend resolves it from
 * the session), or refuse with a reason — the refusal travels the bridge's
 * uniform 503 shape on the client half, a 403 on the server half. */
export type AdapterVerdict = {
    allow: true;
    body?: unknown;
    query?: URLSearchParams;
} | {
    allow: false;
    reason: string;
};
/** The context of `client.response`: the parsed JSON answer plus the
 * virtualizer for this device — an adapter maps server-real session ids
 * back to THIS sub-client's virtual form with it. `pathname` names the
 * request the answer belongs to (better-sidebar's response rewriting is
 * per API method). */
export interface AdapterResponseContext {
    status: number;
    pathname: string;
    body: unknown;
    /** Wrap one server-real session id into this device's virtual form. */
    virtualize(id: string): string;
    /** Whether a value already IS a virtual id (rewriters skip those). */
    isVirtual(value: unknown): boolean;
}
/** The hook members the framework calls, structurally. `src/adapters/
 * types.ts`'s `BridgeAdapter` conforms to this shape by construction. */
export interface AdapterHooks {
    client?: {
        request?(ctx: AdapterRequestContext): AdapterVerdict;
        response?(ctx: AdapterResponseContext): unknown;
    };
    server?: {
        request?(ctx: AdapterRequestContext): AdapterVerdict;
    };
}
/** One adapter after validation: the route table, the digest the registry
 * entry carries, the registry-shaped declaration (server-scope routes —
 * an adapter is whole-machine data by definition), and the hooks. */
export interface NormalizedAdapter {
    plugin: string;
    /** The exact versions this adapter was written against; the INSTALLED
     * version must be among them or the adapter does not register. */
    versions: readonly string[];
    routes: NormalizedAdapterRoute[];
    /** The digest of the ROUTE TABLE (locator and match included) — the
     * value the registry entry and the handshake both carry. */
    digest: string;
    /** What went into the registry: version = the INSTALLED version, digest
     * = {@link digest}, routes = the forwardable (non-local) ones. */
    declaration: NormalizedDeclaration;
    hooks: AdapterHooks;
}
/** The body cap an ADAPTER route may declare: 500 MiB — the relay's own
 * upload budget (lib/relay-server.js `MAX_UPLOAD_BYTES`), which the
 * better-sidebar upload route rides. Wider than the cooperative
 * declaration's 64 MiB because raw media uploads are exactly what an
 * adapter exists to carry; test/adapter-better-sidebar.test.cjs pins the
 * two numbers together. */
export declare const MAX_ADAPTER_BODY_BYTES: number;
/** Validate one adapter's route table and fold it, together with the
 * INSTALLED plugin version, into the registry-ready form.
 *
 * Route paths follow the cooperative declaration's rules verbatim (plain
 * absolute paths, off the host-owned `/_dsh/` and `/api` prefixes) — an
 * adapter must not be able to reach anything a declaration cannot. The
 * installed version must be listed EXACTLY (`versions` are what the
 * adapter was written against); anything else refuses the adapter whole.
 * @throws with a field-naming message on any illegal shape.
 */
export declare function normalizeAdapter(input: unknown, installedVersion: string): NormalizedAdapter;
/** The digest of one adapter's route table: sha256 over a canonical JSON of
 * `{plugin, version, routes}` — the locator and the match mode INCLUDED (a
 * different locating rule is a different adapter), hex, first 16 chars.
 * Routes arrive path-sorted, so order never moves the hash. */
export declare function adapterDigestOf(plugin: string, version: string, routes: NormalizedAdapterRoute[]): string;
/** The prefix-match rule, shared verbatim by both halves: equality or one
 * path segment deeper, on the RAW undecoded pathname. */
export declare function adapterPathMatches(route: NormalizedAdapterRoute, pathname: string): boolean;
/** The adapter route a forwarded request hit, or `undefined`. `local`
 * routes never match here — they stay on the sub-client's own machine in
 * both directions, so the server half must never see (nor serve) them. */
export declare function matchAdapterRoute(adapters: readonly NormalizedAdapter[] | undefined, pathname: string): {
    adapter: NormalizedAdapter;
    route: NormalizedAdapterRoute;
} | undefined;
/** One located session id: where it sat and the value as found. */
export interface AdapterIdHit {
    kind: 'query' | 'path-segment' | 'json-body';
    /** The query parameter or JSON field name; undefined for a path segment. */
    key: string | undefined;
    value: string;
}
/** Thrown when a query parameter the locator reads appears with MORE than
 * one value: the cooperative bridge refuses such requests as `bad-query`
 * (a duplicated id is a shape violation, never a forward of whichever
 * duplicate a parser happens to keep), and so does the adapter (PB-12
 * review note — the old behavior silently collapsed to `set`, rewriting
 * only one of the values). Callers catch this and answer 503/400
 * `bad-query`. */
export declare class AdapterMultiValueQueryError extends Error {
    constructor(name: string);
}
/** Locate the session ids one request carries for one route. A query
 * parameter counts once per value it appears with; a JSON body field counts
 * when present with a non-empty string value; a path segment counts when
 * the segment exists (decoded once off the wire). */
export declare function locateAdapterIds(route: NormalizedAdapterRoute, pathname: string, search: URLSearchParams, body: unknown): AdapterIdHit[];
/** The remote/local verdict of one request (the design's rule, verbatim):
 * every located id virtual → remote; none located, or none virtual →
 * local; a MIX of virtual and plain ids → the request is malformed for the
 * bridge and refuses rather than guessing which half travels. */
export type AdapterRemoteVerdict = {
    kind: 'remote';
    hits: AdapterIdHit[];
} | {
    kind: 'local';
} | {
    kind: 'mixed';
};
export declare function classifyAdapterRequest(route: NormalizedAdapterRoute, pathname: string, search: URLSearchParams, body: unknown): AdapterRemoteVerdict;
/** What {@link rewriteAdapterRequest} produces: the request coordinates
 * with every located virtual id swapped for its real half. */
export interface AdapterRewrite {
    pathname: string;
    query: URLSearchParams;
    /** The re-serialized JSON body for a body-locating route that arrived
     * with a body; `undefined` when there is nothing to re-serialize. */
    bodyText: string | undefined;
}
/** Swap every located virtual id for its real half (the pure client-half
 * rewrite): the query is re-serialized, the path segment re-encoded, the
 * JSON body re-serialized. The re-encode direction is the wire contract —
 * `encodeURIComponent` of the real id is what the server decodes again. */
export declare function rewriteAdapterRequest(route: NormalizedAdapterRoute, pathname: string, search: URLSearchParams, body: unknown, hits: AdapterIdHit[], realIdOf: (virtualId: string) => string): AdapterRewrite;
/** Whether the adapter still owns its plugin's registry entry, or a
 * cooperative declaration (the plugin's OWN `zenRemote.bridge(...)`, which
 * always wins) has taken the seat since: an entry with a different digest
 * means the adapter yielded. */
export declare function adapterOwnsRegistryEntry(adapter: NormalizedAdapter, registryEntry: {
    version: string;
    digest: string;
} | undefined): boolean;
/** The largest JSON answer the client half will buffer for a response
 * rewrite: past this the body passes through untouched (8 MB). */
export declare const MAX_ADAPTER_RESPONSE_BUFFER_BYTES: number;
/** Response headers an ADAPTER answer may carry through VERBATIM, beyond
 * the three every bridged forward passes (content-type, content-length,
 * cache-control): the better-sidebar HTML preview ships a `content-
 * security-policy` sandbox and downloads carry `content-disposition` —
 * stripping those breaks the very panels the adapter exists to serve.
 * Cooperative declaration routes keep the three-header behavior. */
export declare const ADAPTER_RESPONSE_HEADER_ALLOWLIST: readonly ["content-security-policy", "content-disposition", "etag", "last-modified", "accept-ranges", "content-range"];
//# sourceMappingURL=plugin-adapter-core.d.ts.map