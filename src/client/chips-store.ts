import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { useSyncExternalStore } from 'react'

/**
 * Home-screen chip visibility, keyed by {@link ChipDef.id} (MobileHomeChips.tsx).
 * A missing key means "shown" — new chip ids need no migration step, they
 * just default enabled the first time they exist.
 */
export type ChipPrefs = Record<string, boolean>

/**
 * Plain `createSnapshotStore` (runtime contract/store.d.ts), not a
 * `defineStore` slot handle: this preference is not tied to any slot's
 * mount lifecycle (unlike nav-store.ts's page stack, which a session-scope
 * registration also needs a handle for), so it needs none of that
 * machinery — a bare persisted store is the whole requirement (design doc
 * Appendix G lists both as valid `defineStore`/`createSnapshotStore`
 * options for this exact case). A module-level constant is safe here
 * (unlike a `defineStore` handle) because this store is not resolved
 * per-scope by the slot runtime; it is just a persisted value with its own
 * localStorage-backed identity, so re-importing the module always reaches
 * the same store.
 */
const store = createSnapshotStore<ChipPrefs>({}, { persist: { name: 'dsh-mobile-nav.chips' } })

/** @param prefs - current snapshot. @param id - chip id. @returns whether the chip should render (default true). */
export function isChipEnabled(prefs: ChipPrefs, id: string): boolean {
  return prefs[id] !== false
}

/** Flip one chip's visibility and persist it. @param id - chip id. */
export function toggleChip(id: string): void {
  store.update((draft) => {
    draft[id] = !isChipEnabled(draft, id)
  })
}

/** Live chip-prefs mirror (React 18 tearing-safe external store read). */
export function useChipsPrefs(): ChipPrefs {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
