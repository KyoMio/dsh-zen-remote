import type { ClientContext } from '../compat/types.ts';
export interface RemoteDropDiagnostics {
    /** The listener is mounted and armed (capability check passed, effect
     * not yet disposed). */
    installed: boolean;
    /** Why the capability check declined to install; `undefined` while
     * installed (and after a dispose, which keeps the counters readable). */
    notInstalledReason: string | undefined;
    /** Drops this guard stopped from reaching the host (both the blocked and
     * the uploaded kind). */
    intercepted: number;
    /** Files that reached the server workspace and had their mention
     * dispatched. */
    uploaded: number;
    /** Files whose upload failed (the toast carries the code; the event stays
     * stopped — there is no host pipeline to fall back to). */
    failed: number;
    /** Drops stopped because they carried a folder (toast shown, nothing
     * uploaded). */
    blockedDirectories: number;
    /** Drops judged not-ours and released untouched. */
    passthrough: number;
}
/** A snapshot for the diagnostics carriers (settings page). Copying keeps
 * callers from holding a live reference into a later mount's state. */
export declare function remoteDropDiagnostics(): RemoteDropDiagnostics;
export declare function mountRemoteDropGuard(ctx: ClientContext): void;
//# sourceMappingURL=remote-drop.d.ts.map