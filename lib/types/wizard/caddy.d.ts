/**
 * Caddyfile generation (GW-3), pure logic — every byte the managed Caddy
 * will run comes out of {@link generateCaddyfile}, so the validation and
 * the injection guards live HERE and the process half (caddy-process.ts)
 * only writes, validates and spawns what this answered.
 *
 * Shape (design.md 路 A), with one deliberate correction to the design
 * sketch: the global DNS-01 option in a real Caddyfile is `acme_dns
 * <provider> <token-placeholder>` — the sketch's bare `dns cloudflare`
 * line is site-block `tls` syntax and is not valid as a global option.
 * The DNS-01 challenge itself is the point: the certificate is ordered
 * through Cloudflare's API (the token rides the `CF_API_TOKEN`
 * environment variable, never the file), so neither 80 nor 443 needs to
 * be reachable from outside for issuance; only the HTTPS service port
 * must be.
 *
 * Injection posture: every interpolated value passes a charset gate —
 * the domain through config.ts's `hostOf` (the exact validator the row
 * layer applies), the storage path free of control characters, quotes and
 * braces (Caddyfile's block delimiters), the env-var name as a legal
 * POSIX name. Nothing else from the outside world reaches the output.
 */
/** The default environment variable the Cloudflare token rides in on. */
export declare const CF_TOKEN_ENV_DEFAULT = "CF_API_TOKEN";
export interface CaddyfileInput {
    /** Public ingress domain, bare hostname (validated like the row field). */
    domain: unknown;
    /** HTTPS port the managed Caddy listens on. [1, 65535]. */
    httpsPort: unknown;
    /** The gateway's ACTUAL listening port — the caller reads it from the
     * running gateway, never the configured one (it may have retried). */
    gatewayPort: unknown;
    /** Caddy storage directory (certificates + ACME account). */
    storageDir: unknown;
    /** Environment variable name the Cloudflare token arrives in. */
    cfTokenEnvName?: unknown;
}
export type CaddyfileResult = {
    ok: true;
    caddyfile: string;
    domain: string;
    httpsPort: number;
    gatewayPort: number;
} | {
    ok: false;
    error: 'bad-domain' | 'bad-https-port' | 'bad-gateway-port' | 'bad-storage' | 'bad-token-env';
};
/**
 * Build the complete Caddyfile for the managed Caddy. Refuses (typed)
 * instead of throwing so the caller can map each refusal to a form error.
 */
export declare function generateCaddyfile(input: CaddyfileInput): CaddyfileResult;
//# sourceMappingURL=caddy.d.ts.map