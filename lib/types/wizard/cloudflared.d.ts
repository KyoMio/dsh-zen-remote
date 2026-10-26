/**
 * cloudflared process lifecycle (GW-7, 路 C's last mile). The tunnel's
 * connector runs in the foreground (`tunnel run`) as a child of the DSH
 * host, managed through the same subprocess service as the gateway child
 * and the managed Caddy.
 *
 * The connector secret NEVER touches argv (visible to every process on
 * the machine via ps) and is never an environment variable either — it is
 * written to `<DSH_HOME>/zen-remote-ingress/tunnel-token`, mode 0600,
 * through a temp-file-then-rename so a crash mid-write can never leave a
 * half token at the real path, and handed to cloudflared with
 * `--token-file`.
 *
 * Idempotency and cleanup mirror caddy-process.ts: a live child refuses a
 * second start (stop first to switch tunnels), stop is idempotent, and an
 * exited child clears its own slot. The host wiring hands stop to
 * ctx.effect so the row's disposal kills cloudflared too.
 */
import { type DownloadProgress } from './binary-io.js';
import { type BinaryPlatform } from './binary.js';
import type { SubprocessServiceLike } from './caddy-process.js';
/** Where the connector secret lives (design.md: 不进 Config 的字段). */
export declare function tunnelTokenPath(dshHome: string): string;
/** Whether a non-empty tunnel-token file exists (the projection's boolean
 * only — GW-fix-4/M1: the manager's EXISTENCE says nothing about whether a
 * token has been stored). */
export declare function tunnelTokenConfigured(dshHome: string): boolean;
/**
 * Persist the tunnel connector secret: 0600, atomic (write the `.part`
 * sibling, then rename over the real path).
 */
export declare function writeTunnelTokenFile(dshHome: string, token: string): string;
export interface CloudflaredManagerOptions {
    /** The host's subprocess service (ctx.subprocess). */
    subprocess: SubprocessServiceLike;
    /** `<DSH_HOME>` — the binary and the token file live under it. */
    dshHome: string;
    /** Injected transport for the one-time binary download (tests). */
    fetchImpl?: typeof fetch;
    /** Forced platform mapping (tests). */
    platform?: BinaryPlatform;
    /** Download progress relay (bytes, declared total or null). */
    onProgress?: DownloadProgress;
    /** Stdio byte caps for the child, both streams. Default 64 KiB. */
    maxLogBytes?: number;
}
export type CloudflaredStartResult = {
    ok: true;
    binaryPath: string;
    tokenFile: string;
    alreadyRunning: false;
} | {
    ok: false;
    error: 'already-running' | 'missing-token' | 'download-failed' | 'spawn-failed';
    detail?: string;
    installUrl?: string;
};
export interface CloudflaredManager {
    /** Idempotent front door: a live cloudflared refuses a second start. */
    start(input: {
        tunnelToken: unknown;
    }): Promise<CloudflaredStartResult>;
    /** Idempotent terminate; safe before any start. */
    stop(): void;
    /** Whether a child is currently held. */
    isRunning(): boolean;
    /** Whether any start has succeeded in this manager's lifetime. */
    hasStarted(): boolean;
}
export declare function createCloudflaredManager(options: CloudflaredManagerOptions): CloudflaredManager;
//# sourceMappingURL=cloudflared.d.ts.map