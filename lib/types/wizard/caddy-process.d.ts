/**
 * Managed-Caddy process lifecycle (GW-3). The Caddyfile's content is
 * caddy.ts's job; this module owns everything with a heartbeat:
 *
 *   start: ensureBinary (GW-2, cached after the first download) →
 *          generateCaddyfile (typed refusals) → write the Caddyfile as a
 *          `.part` sibling → `caddy validate --config <part> --adapter
 *          caddyfile` → only on a clean validate rename it to the real
 *          path → `caddy run --config <Caddyfile>`. The ticket's "validate
 *          before write" is honored as validate-before-PUBLISH: the final
 *          Caddyfile on disk only ever holds bytes Caddy accepted, and a
 *          failed validate leaves neither a start nor a published file.
 *
 *   The Cloudflare API token travels in the child's ENVIRONMENT
 *   (`CF_API_TOKEN`, what the generated `{env.CF_API_TOKEN}` placeholder
 *   reads) — never in argv, which other processes on the machine can see.
 *
 *   Idempotency: start with a live process refuses (`already-running`) —
 *   switching configuration stops first (design: 切换路时先停旧进程再启新的).
 *   stop is idempotent; an exited child clears its own slot so a later
 *   start works. The host wiring hands stop to ctx.effect, so the row's
 *   disposal kills Caddy too.
 *
 * The subprocess service is structural (the tests feed a recorder), and
 * `fetch` is injectable for the ensureBinary step.
 */
import { type DownloadProgress } from './binary-io.js';
import { caddyDataDir, caddyfilePath, ingressDir, type BinaryPlatform } from './binary.js';
import { type CaddyfileInput } from './caddy.js';
/** The slice of DSH's subprocess service the manager drives (structural so
 * tests record instead of exec). */
export interface SubprocessHandleLike {
    terminate(): unknown;
    done: Promise<{
        exitCode?: number | null;
        signal?: string | null;
    }>;
}
export interface SubprocessServiceLike {
    spawn(options: {
        argv: string[];
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        stdio?: unknown;
        graceMs?: number;
    }): SubprocessHandleLike;
}
export interface CaddyManagerOptions {
    /** The host's subprocess service (ctx.subprocess). */
    subprocess: SubprocessServiceLike;
    /** `<DSH_HOME>` — binaries, Caddyfile and caddy-data all live under it. */
    dshHome: string;
    /** Injected transport for the one-time binary download (tests point it
     * at a mock server). */
    fetchImpl?: typeof fetch;
    /** Forced platform mapping (tests). */
    platform?: BinaryPlatform;
    /** Download progress relay (bytes, declared total or null). */
    onProgress?: DownloadProgress;
    /** Stdio byte caps for the child, both streams. Default 64 KiB — enough
     * for the startup banner and an error or two. */
    maxLogBytes?: number;
}
export type CaddyStartResult = {
    ok: true;
    binaryPath: string;
    caddyfile: string;
    alreadyRunning: false;
} | {
    ok: false;
    error: 'already-running' | 'missing-token' | 'bad-config' | 'download-failed' | 'validate-failed' | 'spawn-failed';
    /** The generateCaddyfile error code for `bad-config`, or a short
     * human-readable line for the transport/spawn failures. */
    detail?: string;
    /** Official manual-install link, present for `download-failed`. */
    installUrl?: string;
};
export interface CaddyManager {
    /**
     * Idempotent front door: a live Caddy refuses a second start (stop
     * first to switch configuration). Throws nothing — every failure is a
     * value.
     */
    start(input: CaddyfileInput & {
        cfToken: unknown;
    }): Promise<CaddyStartResult>;
    /** Idempotent terminate; safe before any start. */
    stop(): void;
    /** Whether a child is currently held (true between spawn and exit). */
    isRunning(): boolean;
    /** The live child's Caddyfile path, or undefined. */
    runningCaddyfile(): string | undefined;
}
export declare function createCaddyManager(options: CaddyManagerOptions): CaddyManager;
/** Re-exported so the wiring (and later the routes) need one import for
 * the whole ingress-directory layout. */
export { caddyDataDir, caddyfilePath, ingressDir };
//# sourceMappingURL=caddy-process.d.ts.map