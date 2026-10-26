/**
 * Cloudflare API v4 client (GW-7) — the whole tunnel path (路 C) talks to
 * this module: account lookup, zone lookup, tunnel create/list, ingress
 * configuration, the CNAME that points the public hostname at the tunnel,
 * and the composed "is this domain on Cloudflare already" check.
 *
 * Transport rules the ticket pins down:
 *
 *   - Plain `fetch`, no third-party dependency; the token rides the
 *     `Authorization: Bearer` header and is NEVER logged, echoed into an
 *     error, or written into any returned structure.
 *   - Every failure is a typed {@link CloudflareError} whose `code` the UI
 *     classifies on (`cf-auth-failed`, `cf-zone-not-found`,
 *     `cf-tunnel-conflict`, `cf-dns-conflict`, `cf-network`, and the
 *     catch-all `cf-api`). Raw response bodies never pass through — the
 *     message carries only the API's short error summary, truncated,
 *     which is what the design's 「兜底显示原始错误码」 wants.
 *   - The client is stateless: a factory binds the token (plus injectable
 *     `fetchImpl` / `baseUrl` for the mock-server tests); every method
 *     takes the ids it needs. The module-level `cf*` wrappers are one-call
 *     conveniences over the factory.
 *
 * Conflict classification matches the well-known numeric codes where they
 * exist and falls back to the API's error text (`already exists`
 * wordings), so an upstream renumber degrades to the generic envelope
 * instead of a wrong verdict.
 */
export declare const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
export type CloudflareErrorCode = 'cf-auth-failed' | 'cf-zone-not-found' | 'cf-tunnel-conflict' | 'cf-dns-conflict' | 'cf-network' | 'cf-api';
/**
 * One refused API call. Fields are assigned in the constructor body (the
 * check scripts' strip-only type stripping rejects parameter properties).
 */
export declare class CloudflareError extends Error {
    readonly code: CloudflareErrorCode;
    readonly status: number | null;
    /** The API's own numeric error code(s), when the envelope carried any. */
    readonly apiCodes: readonly number[];
    constructor(code: CloudflareErrorCode, message: string, status?: number | null, apiCodes?: readonly number[], options?: {
        cause?: unknown;
    });
}
export interface CloudflareApiOptions {
    token: string;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
}
export interface CloudflareTunnelSummary {
    id: string;
    name: string;
    status: string;
}
/** One DNS record summary (the id/content the tunnel setup compares). */
export interface CloudflareDnsRecord {
    id: string;
    name: string;
    content: string;
}
export interface CloudflareDomainCheck {
    onCloudflare: boolean;
    zoneId: string | null;
    accountId: string | null;
}
export interface CloudflareApi {
    /** Every account id the token can see. */
    listAccounts(): Promise<string[]>;
    /** The zone id whose name EXACTLY equals `domain`, within one account. */
    getZone(accountId: string, domain: string): Promise<string>;
    /** One new named tunnel; `token` is the connector secret cloudflared runs with. */
    createTunnel(accountId: string, name: string): Promise<{
        id: string;
        token: string;
    }>;
    /** The account's live tunnels (deleted ones filtered server-side). */
    listTunnels(accountId: string): Promise<CloudflareTunnelSummary[]>;
    /** The connector token of an EXISTING tunnel (the re-use path of setup). */
    getTunnelToken(accountId: string, tunnelId: string): Promise<string>;
    /** Map `domain` → `serviceUrl` in the tunnel's ingress, 404 fallback last. */
    configureIngress(accountId: string, tunnelId: string, domain: string, serviceUrl: string): Promise<void>;
    /** One proxied CNAME `subdomain` → `target`; returns the record id. */
    createDnsRecord(zoneId: string, subdomain: string, target: string): Promise<string>;
    /** The CNAME records named `name` in one zone (id/name/content only). */
    listDnsRecords(zoneId: string, name: string): Promise<CloudflareDnsRecord[]>;
    /** Composed check: does any ancestor of `domain` name a zone on the
     * token's accounts (zones are apexes — `dsh.example.com` lives in the
     * `example.com` zone)? */
    checkDomainOnCloudflare(domain: string): Promise<CloudflareDomainCheck>;
}
/**
 * The ancestor chain of one hostname, itself first: `dsh.example.com` →
 * `dsh.example.com`, `example.com`, `com`. Cloudflare zones are apex
 * domains, so a wizard lookup for `dsh.example.com` must find the zone
 * named `example.com` (GW-fix-2/H1) — exact-name matching walks this chain
 * level by level.
 */
export declare function ancestorHosts(domain: string): string[];
export declare function createCloudflareApi(options: CloudflareApiOptions): CloudflareApi;
type CfCallOptions = Partial<Pick<CloudflareApiOptions, 'fetchImpl' | 'baseUrl'>>;
export declare function cfListAccounts(token: string, opts?: CfCallOptions): Promise<string[]>;
export declare function cfGetZone(token: string, accountId: string, domain: string, opts?: CfCallOptions): Promise<string>;
export declare function cfCreateTunnel(token: string, accountId: string, name: string, opts?: CfCallOptions): Promise<{
    id: string;
    token: string;
}>;
export declare function cfListTunnels(token: string, accountId: string, opts?: CfCallOptions): Promise<CloudflareTunnelSummary[]>;
export declare function cfGetTunnelToken(token: string, accountId: string, tunnelId: string, opts?: CfCallOptions): Promise<string>;
export declare function cfConfigureIngress(token: string, accountId: string, tunnelId: string, domain: string, serviceUrl: string, opts?: CfCallOptions): Promise<void>;
export declare function cfCreateDnsRecord(token: string, zoneId: string, subdomain: string, target: string, opts?: CfCallOptions): Promise<string>;
export declare function cfListDnsRecords(token: string, zoneId: string, name: string, opts?: CfCallOptions): Promise<CloudflareDnsRecord[]>;
export declare function cfCheckDomainOnCloudflare(token: string, domain: string, opts?: CfCallOptions): Promise<CloudflareDomainCheck>;
export {};
//# sourceMappingURL=cloudflare.d.ts.map