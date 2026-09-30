/** The storage face used, narrowed to the two methods (structurally typed:
 * this module compiles under the client tsconfig with DOM lib, but tests
 * inject stubs). */
interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}
/** One matched row: the group id, its current expansion, and the click. */
interface RowHandle {
    key: string;
    expanded: boolean;
    click(): void;
}
export interface RemoteGroupExpansionKeeperOptions {
    /** Both storage reads and writes. Default: the page's localStorage; a
     * broken or absent one makes every tick a no-op. */
    storage?: StorageLike;
    /** The role probe. Default: the shared cached client-config probe. */
    probeRole?: () => Promise<'host' | 'client' | undefined>;
    /** The sidebar's server group rows. Default: the real DOM query — rows
     * without a readable `aria-expanded` are skipped. Tests inject fake rows
     * with click recorders. */
    queryRows?: () => RowHandle[];
    /** The re-check interval; default 1000ms. */
    intervalMs?: number;
}
/**
 * Start the keeper loop. Returns the disposer (interval) the mounting
 * effect calls on teardown.
 */
export declare function startRemoteGroupExpansionKeeper(options?: RemoteGroupExpansionKeeperOptions): () => void;
/**
 * Mount the keeper as one page-lifetime effect, beside the current-session
 * reporter (T62): before the desktop-shell gate in apply(), same client-role
 * probe, same 1s cadence — its own timer, its own file.
 */
export declare function mountRemoteGroupExpansionKeeper(ctx: {
    effect(fn: () => () => void, name: string): void;
}, options?: RemoteGroupExpansionKeeperOptions): void;
export {};
//# sourceMappingURL=remote-group-expansion.d.ts.map