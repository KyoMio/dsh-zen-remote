import type { ActionsDecl, StoreHandle, StoreSpec } from '@deepseek-ai/dsh-client-ui-slots';
/** Writable snapshot source: read + subscribe + mutate/wholesale-set. */
export interface SnapshotStore<T> {
    /** Read the current state. Same reference every time until an update. */
    getSnapshot(): T;
    /**
     * Subscribe to state changes.
     * @param fn - invalidation callback.
     * @returns unsubscribe function.
     */
    subscribe(fn: () => void): () => void;
    /**
     * Mutate the state through a draft.
     * @param mutator - draft mutator.
     */
    update(mutator: (draft: T) => void): void;
    /** Replace the state wholesale. @param next - next state. */
    set(next: T): void;
}
/**
 * Create a snapshot store with optional whole-value localStorage persistence.
 * The 0.1.1 `opts.flush: 'raf' | 'sync'` mode is deliberately not
 * implemented: this plugin never used it (chips-store.ts persists
 * synchronously and React reads via useSyncExternalStore).
 * @param init - initial state.
 * @param opts - optional persistence key.
 * @returns the store.
 */
export declare function createSnapshotStore<T>(init: T, opts?: {
    persist?: {
        name: string;
    };
}): SnapshotStore<T>;
/**
 * Declare a store: an init lambda (fresh state per instance), an optional
 * persistence key, and the full write set as pure draft mutators. Returns
 * the registration currency of the slot system's store seat.
 *
 * The `A & ActionsDecl<T>` actions position is load-bearing: T resolves from
 * `init` in the first inference round, and the intersection then
 * contextually types each mutator's draft parameter, so call sites write
 * `(draft, view: MobileView) => { … }` without annotating the draft. Keep
 * the intersection — dropping it makes nav-store.ts fail to typecheck.
 *
 * Persist-key rules mirror the official defineStore: `decl.persist` alone at
 * root scope, suffixed with `.{scopeKey}` per session scope, none when
 * `decl.persist` is absent.
 * @param decl - init/persist/actions declaration.
 * @returns the store handle.
 */
export declare function defineStore<T, A extends ActionsDecl<T>>(decl: StoreSpec<T, A> & {
    actions: A & ActionsDecl<T>;
}): StoreHandle<T, A>;
/**
 * Last path segment of a workspace directory, for showing "which workspace
 * is this session in" on the mobile info card. 0.1.1's one-line
 * implementation, kept verbatim.
 * @param cwd - a workspace path (posix or windows separators).
 * @returns the trailing name, or '' when no non-empty segment exists.
 */
export declare function workspaceTitleOf(cwd: string): string;
//# sourceMappingURL=store.d.ts.map