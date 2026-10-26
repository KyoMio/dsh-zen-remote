/**
 * Tunnel orchestration (GW-13b, 路 C's autopilot): one call drives the
 * whole Cloudflare-side setup the design promises — zone/account lookup
 * (through the ancestor-chain check), tunnel create-or-adopt, ingress
 * configuration against the gateway's ACTUAL port, the proxied CNAME,
 * and the cloudflared child.
 *
 * Rules the review and the design pin down:
 *
 *   - **已有同名隧道**：the first setup pass answers `tunnel-conflict`
 *     with the same-name list; the UI lets the user pick one and re-runs
 *     with `tunnelId`, which adopts the existing tunnel through the token
 *     endpoint instead of creating anything.
 *   - **模式切换**：starting the tunnel stops the managed Caddy first
 *     (`stopCaddy`) — never two ingress processes at once.
 *   - The connector token travels from the Cloudflare answer into the
 *     0600 token file and the child's `--token-file`; it never reaches a
 *     response or a log.
 *   - Every failure is a VALUE with a stable `reason` the UI maps to
 *     locale copy; CloudflareError codes map losslessly (`cf-*` → the
 *     orchestration's own reasons), unknown ones degrade to `api`.
 */
import { type CloudflareApi, type CloudflareTunnelSummary } from './cloudflare.js';
/** The tunnel name the wizard mints and looks for. */
export declare const TUNNEL_NAME = "dsh-zen-remote";
export interface TunnelOrchestratorOptions {
    dshHome: string;
    /** The stored Cloudflare token (token-store); absent → `no-token`. */
    readToken: () => string | undefined;
    /** The gateway's ACTUAL port (the ingress service target); may probe
     * asynchronously (the wiring re-reads /lan-gate/status per setup). */
    gatewayPort: () => number | Promise<number>;
    /** The client factory; injectable so the tests drive the orchestration
     * against a scripted CloudflareApi without any HTTP. Defaults to
     * createCloudflareApi over the injected fetch. */
    apiFactory?: (token: string) => CloudflareApi;
    cloudflared: {
        start: (input: {
            tunnelToken: string;
        }) => Promise<{
            ok: true;
        } | {
            ok: false;
            error: string;
        }>;
        /** 模式切换：starting the tunnel stops the managed Caddy first. */
        stopCaddy: () => void;
    };
    fetchImpl?: typeof fetch;
}
export interface TunnelSetupInput {
    /** The public domain (bare hostname; may be a subdomain of the zone). */
    domain: string;
    /** Adopt this existing tunnel instead of creating one (the conflict path). */
    tunnelId?: string;
}
export type TunnelSetupResult = {
    ok: true;
    tunnelId: string;
    publicUrl: string;
    tokenFile: string;
} | {
    ok: false;
    reason: 'no-token' | 'bad-domain' | 'zone-not-found' | 'tunnel-conflict' | 'dns-conflict' | 'auth' | 'network' | 'api' | 'spawn-failed';
    detail?: string;
    /** The same-name tunnels, for `tunnel-conflict`. */
    existing?: CloudflareTunnelSummary[];
    /** The manual-install page, for `spawn-failed`. */
    installUrl?: string;
};
/**
 * Drive the whole tunnel setup. Throws nothing — every outcome is a value.
 */
export declare function setupTunnel(options: TunnelOrchestratorOptions, input: TunnelSetupInput): Promise<TunnelSetupResult>;
/**
 * The check-domain probe the migration card's 重新检查 drives: does any
 * ancestor of the domain name a zone on the token's accounts?
 */
export type TunnelCheckResult = {
    ok: true;
    onCloudflare: boolean;
    zoneId: string | null;
    accountId: string | null;
} | {
    ok: false;
    reason: 'no-token' | 'bad-domain' | 'auth' | 'network' | 'api';
    detail?: string;
};
export declare function checkDomainOnCloudflare(options: Pick<TunnelOrchestratorOptions, 'readToken' | 'fetchImpl' | 'apiFactory'>, domain: string): Promise<TunnelCheckResult>;
//# sourceMappingURL=tunnel-orchestrator.d.ts.map