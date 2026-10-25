/**
 * Reverse-proxy configuration snippets (GW-5, 路 B) — for the user who
 * ALREADY runs their own proxy, the wizard hands out copy-paste material
 * instead of managing a process. Everything here is pure text generation:
 * every interpolated value passes a charset gate (the domain through
 * config.ts's `hostOf`, the upstream host likewise, the port in [1,
 * 65535]), so a hostile form value cannot smuggle a directive into
 * anyone's nginx.
 *
 * The upstream port is the gateway's ACTUAL port — the caller reads it
 * from the running gateway (it may have retried past the configured one),
 * never from config.
 */
export type SnippetResult = {
    ok: true;
    text: string;
} | {
    ok: false;
    error: 'bad-domain' | 'bad-upstream-host' | 'bad-upstream-port';
};
export interface SnippetInput {
    /** Public domain the proxy terminates TLS for (bare hostname). */
    domain: unknown;
    /** Where the gateway listens — a hostname or IP literal (e.g. the
     * loopback default). */
    upstreamHost: unknown;
    /** The gateway's ACTUAL port. */
    upstreamPort: unknown;
}
/**
 * nginx: a complete server block. The WebSocket upgrade map sits outside
 * the server (http-level context) — the snippet says so in a comment, the
 * user pastes it into the http/server scope their setup offers. Long
 * idle tunnels need the 3600s read/send timeouts, uploads the 128m
 * client body cap, and streaming the buffering switch — all three are
 * the shapes DSH's relay traffic actually needs.
 */
export declare function nginxSnippet(input: SnippetInput): SnippetResult;
/**
 * Caddy (user-operated, not the wizard-managed one): the site block is
 * one `reverse_proxy` line — Caddy routes the rest itself.
 */
export declare function caddySnippet(input: SnippetInput): SnippetResult;
export type StepsResult = {
    ok: true;
    steps: string[];
} | {
    ok: false;
    error: 'bad-upstream-host' | 'bad-upstream-port';
};
/**
 * Lucky (Web 服务反代) three steps: listen 443, proxy to the upstream,
 * flip the catch-all switch. Text only — Lucky has no config file format
 * to generate.
 */
export declare function luckySteps(input: {
    upstreamHost: unknown;
    upstreamPort: unknown;
}): StepsResult;
//# sourceMappingURL=proxy-snippets.d.ts.map