// Compat: self-written store engine + workspace-title helper, replacing the
// three runtime values this plugin used to import from
// `@deepseek-ai/dsh-client-runtime/client` (createSnapshotStore in
// chips-store.ts, defineStore in nav-store.ts, workspaceTitleOf in
// MobileSessionInfo.tsx). DSH 0.1.2 dropped that package entirely: a browser
// `require` of it now throws and the plugin would not load at all. The store
// pair moved to `@deepseek-ai/dsh-client-store` and `workspaceTitleOf`
// exists nowhere, so instead of try/catching two package names at runtime
// (and re-coupling to whichever upstream renames next), the functions are
// written here — they are small, and their contract types come from
// `@deepseek-ai/dsh-client-ui-slots`, which both DSH versions ship.
//
// Both frameworks consume a store handle structurally — they call
// `handle.create(scopeKey?)` and read `getSnapshot / subscribe / actions /
// clearPersisted` off the instance, with no `instanceof` and no brand check
// (0.1.1 dsh-client-runtime/lib/client.js:171,302; 0.1.2
// dsh-client-ui-renderer/lib/client.js:1341,1350) — so these stand-ins are
// accepted as-is by the slot engine on either version.
import type {
  ActionsDecl,
  BakedActions,
  StoreHandle,
  StoreInstance,
  StoreSpec,
} from '@deepseek-ai/dsh-client-ui-slots'

/** Writable snapshot source: read + subscribe + mutate/wholesale-set. */
export interface SnapshotStore<T> {
  /** Read the current state. Same reference every time until an update. */
  getSnapshot(): T
  /**
   * Subscribe to state changes.
   * @param fn - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(fn: () => void): () => void
  /**
   * Mutate the state through a draft.
   * @param mutator - draft mutator.
   */
  update(mutator: (draft: T) => void): void
  /** Replace the state wholesale. @param next - next state. */
  set(next: T): void
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
export function createSnapshotStore<T>(
  init: T,
  opts?: { persist?: { name: string } },
): SnapshotStore<T> {
  let state = init
  const listeners = new Set<() => void>()
  const persistName = opts?.persist?.name

  // Rehydrate once at construction: a persisted whole value replaces the
  // initial state wholesale. Failures (quota, private mode, corrupted JSON)
  // only log — a broken persisted value must not take the store down, and a
  // store that cannot persist must still work in memory.
  if (persistName !== undefined && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(persistName)
      if (raw !== null) state = JSON.parse(raw) as T
    } catch (error) {
      console.error(`snapshot store '${persistName}' rehydration failed:`, error)
    }
  }

  const persist = (): void => {
    if (persistName === undefined || typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(persistName, JSON.stringify(state))
    } catch (error) {
      console.error(`snapshot store '${persistName}' persistence failed:`, error)
    }
  }

  const notify = (): void => {
    // Iterate a snapshot of the set so a callback that unsubscribes cannot
    // make the loop skip listeners registered after it.
    for (const fn of [...listeners]) fn()
  }

  return {
    getSnapshot: (): T => state,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    update: (mutator: (draft: T) => void): void => {
      // ponytail: official uses immer's structural sharing; here we copy one
      // level shallowly (array spread / object spread) and let the mutator
      // edit that copy before swapping it in wholesale. That only supports
      // one-level-deep draft writes — fine while both plugin stores stay
      // flat ({view, workspace}, Record<string, boolean>); if a state ever
      // nests, switch this to immer instead of deepening the copy.
      const draft = (Array.isArray(state) ? [...state] : { ...(state as object) }) as T
      mutator(draft)
      state = draft
      notify()
      persist()
    },
    set: (next: T): void => {
      state = next
      notify()
      persist()
    },
  }
}

/**
 * A live `create()` product: the ui-slots contract instance plus the raw
 * snapshot store it was built on. The official engine instance carries the
 * same `store` member (dsh-client-store's EngineStoreInstance); the
 * framework-neutral `StoreInstance` contract omits it, so this file widens
 * the return of {@link defineStore}'s create with a local subtype.
 */
interface SnapshotStoreInstance<T, A extends ActionsDecl<T>> extends StoreInstance<T, A> {
  /** The underlying snapshot store. */
  readonly store: SnapshotStore<T>
}

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
export function defineStore<T, A extends ActionsDecl<T>>(
  decl: StoreSpec<T, A> & { actions: A & ActionsDecl<T> },
): StoreHandle<T, A> {
  return {
    spec: decl,
    create(scopeKey?: string): SnapshotStoreInstance<T, A> {
      const persistKey =
        decl.persist === undefined
          ? undefined
          : scopeKey === undefined
            ? decl.persist
            : `${decl.persist}.${scopeKey}`
      const store = createSnapshotStore<T>(
        decl.init(),
        persistKey !== undefined ? { persist: { name: persistKey } } : undefined,
      )
      // TS cannot verify an object that is filled key-by-key from
      // Object.keys(decl.actions) satisfies the BakedActions mapped type, so
      // the map is built loosely and narrowed once at the contract boundary;
      // at runtime every declared action key is present (the declaration's
      // own keys are the ones iterated).
      const actions = {} as Record<string, (...params: unknown[]) => void>
      for (const [key, mutate] of Object.entries(decl.actions)) {
        actions[key] = (...params: unknown[]): void => {
          store.update((draft) => {
            mutate(draft, ...params)
          })
        }
      }
      return {
        actions: actions as BakedActions<T, A>,
        getSnapshot: (): T => store.getSnapshot(),
        subscribe: (fn: () => void): (() => void) => store.subscribe(fn),
        store,
        clearPersisted: (): void => {
          if (persistKey === undefined || typeof localStorage === 'undefined') return
          try {
            localStorage.removeItem(persistKey)
          } catch {
            // Storage gone or denied: nothing to clean up anyway.
          }
        },
      }
    },
  }
}

/**
 * Last path segment of a workspace directory, for showing "which workspace
 * is this session in" on the mobile info card. 0.1.1's one-line
 * implementation, kept verbatim.
 * @param cwd - a workspace path (posix or windows separators).
 * @returns the trailing name, or '' when no non-empty segment exists.
 */
export function workspaceTitleOf(cwd: string): string {
  return cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
}
