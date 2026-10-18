import type { ClientContext } from '../compat/types.ts';
export interface RemoteDropDiagnostics {
    /** The listener is mounted and armed (capability check passed, effect
     * not yet disposed). */
    installed: boolean;
    /** Why the capability check declined to install; `undefined` while
     * installed (and after a dispose, which keeps the counters readable). */
    notInstalledReason: string | undefined;
    /** Drops this guard stopped from reaching the host (both the blocked and
     * the redispatched kind). */
    intercepted: number;
    /** Synthetic path-stripped drops actually dispatched. */
    redispatched: number;
    /** Drops stopped because they carried a folder (toast shown, nothing
     * dispatched). */
    blockedDirectories: number;
    /** Drops judged not-ours and released untouched. */
    passthrough: number;
    /** Redispatches aborted because a re-wrap or a DataTransfer add threw —
     * the original event was released instead (宁坏勿丢). */
    rewrapFailed: number;
}
/** A snapshot for the diagnostics carriers (settings page). Copying keeps
 * callers from holding a live reference into a later mount's state. */
export declare function remoteDropDiagnostics(): RemoteDropDiagnostics;
export declare function mountRemoteDropGuard(ctx: ClientContext): void;
//# sourceMappingURL=remote-drop.d.ts.map