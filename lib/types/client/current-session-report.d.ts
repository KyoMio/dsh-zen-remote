/** The storage face used, narrowed to the one method (structurally typed:
 * this module compiles under the client tsconfig with DOM lib, but tests
 * inject stubs). */
interface StorageLike {
    getItem(key: string): string | null;
}
export interface CurrentSessionReporterOptions {
    /** The storage reader. Default: the page's localStorage; a broken or
     * absent one makes every read `unavailable` and nothing is ever posted. */
    storage?: StorageLike;
    /** Outbound POST transport. Default: the page's fetch. */
    fetchImpl?: (url: string, init: RequestInit) => Promise<unknown>;
    /** The role probe. Default: the shared cached client-config probe. */
    probeRole?: () => Promise<'host' | 'client' | undefined>;
    /** POST target. Default: the current-session route. */
    route?: string;
    /** The re-check interval; default 1000ms. */
    intervalMs?: number;
    /** The unconditional re-send window (T66); default 30000ms. */
    resendIntervalMs?: number;
}
/**
 * Start the reporter loop. Returns the disposer (listeners + interval) the
 * mounting effect calls on teardown.
 */
export declare function startCurrentSessionReporter(options?: CurrentSessionReporterOptions): () => void;
/**
 * Mount the reporter as one page-lifetime effect. The caller places this
 BEFORE the desktop-shell gate in apply(): the desktop app in the client
 * role is exactly where remote sessions live, so the report must not wait
 * on a width gate. On a host the loop idles after one probe answer.
 */
export declare function mountCurrentSessionReporter(ctx: {
    effect(fn: () => () => void, name: string): void;
}, options?: CurrentSessionReporterOptions): void;
export {};
//# sourceMappingURL=current-session-report.d.ts.map