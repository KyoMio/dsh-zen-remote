/**
 * hostPath probe (GW-8): the server machine walks its OWN public URL and
 * classifies what answers, so the wizard can say something sharper than
 * "it didn't work" — the pairing page showing up means TLS + proxying to
 * the gateway both work; the admin surface answering 200 means the proxy
 * is DROPPING the forwarded headers the gateway trusts; a redirect smells
 * like Cloudflare Access or a proxy rewriting to a login page.
 *
 * Split exactly as the ticket asks: the two `classify*Response` functions
 * are pure (the check scripts can drive them), `probeHostPath` owns the
 * fetch I/O — `redirect: 'manual'` so a proxy's 3xx is SEEN, never
 * followed — with the URL admission reusing client-pairing's
 * `normalizeServerUrl` (https anywhere; plain http only for the explicit
 * private-network allowances) and a 10 s ceiling per request.
 */
/** What answered on `GET <publicUrl>/`. */
export type RootClassification = 'gateway-pairing-page' | 'unexpected-401' | 'unexpected-200' | 'redirect' | 'unexpected';
/** What answered on `GET <publicUrl>/lan-gate/admin`. */
export type AdminClassification = 'gateway-admin-403' | 'admin-exposed' | 'proxy-403' | 'unexpected';
/**
 * `GET /`: the ONE right answer is the gateway's pairing page — 401,
 * text/html, carrying the claim-endpoint marker the page's own script
 * posts to. A 200 means the URL belongs to something else entirely.
 */
export declare function classifyRootResponse(status: number, contentType: string, body: string): RootClassification;
/**
 * `GET /lan-gate/admin`: right is the gateway's own 403 JSON — a public
 * visitor must not get in. 200 + HTML is the DANGEROUS shape: something
 * answered with a page, meaning the proxy forwarded without the
 * forwarded headers and the gateway's local-only wall never saw a
 * proxied request (the admin page leaked). 403 + HTML smells like
 * Cloudflare Access interposing its own login.
 */
export declare function classifyAdminResponse(status: number, contentType: string, body: string): AdminClassification;
export interface HostPathReached {
    kind: 'reached';
    root: RootClassification;
    admin: AdminClassification;
    /** Wall-clock cost of both requests, milliseconds. */
    ms: number;
}
export interface HostPathUnreachable {
    kind: 'unreachable';
    /** `invalid-url` / `insecure-http` — the URL never stood a chance;
     * `timeout` — the 10 s ceiling fired; `network` — DNS, refused, reset. */
    reason: 'invalid-url' | 'insecure-http' | 'timeout' | 'network';
    detail?: string;
    ms: number;
}
export type HostPathOutcome = HostPathReached | HostPathUnreachable;
export interface ProbeOptions {
    fetchImpl?: typeof fetch;
    /** Per-request ceiling. Default 10 000 ms (the ticket's value). */
    timeoutMs?: number;
    /** Clock for the `ms` measurement (tests). */
    now?: () => number;
}
/**
 * Probe the machine's public URL from here: both the root path and the
 * admin surface, never following a redirect. The two requests run
 * concurrently; the answer carries both classifications and the elapsed
 * time. Every failure mode is a VALUE (`kind: 'unreachable'`), never a
 * throw — the wizard routes render whichever verdict arrived.
 */
export declare function probeHostPath(publicUrl: unknown, options?: ProbeOptions): Promise<HostPathOutcome>;
//# sourceMappingURL=probe.d.ts.map