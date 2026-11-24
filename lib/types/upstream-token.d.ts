/**
 * Shared upstream browser-auth token URL resolver for `lan-gate.mjs` and the
 * plugin-bridge loopback executor.
 *
 * DSH <= 0.2.2-rc.1 exposes `connection.authenticatedUrl(baseUrl)`.
 * DSH >= 0.2.2-rc.2 removed that method; `host-authentication-token` instead
 * publishes signed entry URLs synchronously via `'webserver/entry-url'`.
 */
/** Minimal entry appended by `webserver/entry-url` listeners. */
export interface WebEntryUrlCandidate {
    readonly label?: unknown;
    readonly url?: unknown;
    readonly open?: unknown;
}
/** Minimal context surface consumed by {@link resolveUpstreamTokenUrl}. */
export interface UpstreamTokenContext {
    readonly connection?: unknown;
    get?: (name: string) => unknown;
    reflect?: {
        get?: (name: string) => unknown;
    };
    emit?: (thisArg: unknown, event: string, baseUrl: string, entries: WebEntryUrlCandidate[]) => void;
}
/**
 * Resolve an authenticated upstream entry URL for `baseUrl` on both legacy
 * (`connection.authenticatedUrl`) and `0.2.2-rc.2+` (`webserver/entry-url`) hosts.
 * @param ctx - plugin or inject context carrying `connection` / `emit`.
 * @param webServer - active `webServer` instance passed as `thisArg` to `webserver/entry-url`.
 * @param baseUrl - clean origin or base URL without credentials.
 * @returns validated entry URL with a single non-empty `token`, or `undefined`.
 */
export declare function resolveUpstreamTokenUrl(ctx: UpstreamTokenContext | undefined, webServer: unknown, baseUrl: string): string | undefined;
//# sourceMappingURL=upstream-token.d.ts.map