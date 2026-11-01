import type { ClientContext } from '../compat/types.ts';
export interface RemoteDropEntryCounts {
    drop: number;
    picker: number;
    paste: number;
}
export interface RemoteDropDiagnostics {
    /** The listeners are mounted and armed (capability check passed, effect
     * not yet disposed). */
    installed: boolean;
    /** Why the capability check declined to install; `undefined` while
     * installed (and after a dispose, which keeps the counters readable). */
    notInstalledReason: string | undefined;
    /** Intakes this guard stopped from reaching the host (both the blocked and
     * the redirected kind) — the sum of the three entries below. */
    intercepted: number;
    /** Synthetic path-stripped drops actually dispatched (= redirected sum). */
    redispatched: number;
    /** Intakes stopped because they carried a folder (toast shown, nothing
     * dispatched) (= blocked sum). */
    blockedDirectories: number;
    /** Intakes judged not-ours and released untouched (= passthrough sum). */
    passthrough: number;
    /** Redispatches aborted because a re-wrap or a DataTransfer add threw —
     * the original event was released instead (宁坏勿丢). */
    rewrapFailed: number;
    /** The same four counters split by entry (AU-2); the scalars above are
     * their sums, so existing readers keep working unchanged. */
    interceptedBy: RemoteDropEntryCounts;
    redirectedBy: RemoteDropEntryCounts;
    blockedBy: RemoteDropEntryCounts;
    passthroughBy: RemoteDropEntryCounts;
}
/** A snapshot for the diagnostics carriers (settings page). Copying keeps
 * callers from holding a live reference into a later mount's state — the
 * per-entry objects are copied too, or a caller would keep counting. */
export declare function remoteDropDiagnostics(): RemoteDropDiagnostics;
export declare function mountRemoteDropGuard(ctx: ClientContext): void;
//# sourceMappingURL=remote-drop.d.ts.map