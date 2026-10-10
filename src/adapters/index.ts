/**
 * The adapter registry — the ONE door between `src/adapters/` and the rest
 * of the plugin. Every adapter implementation lives in its own
 * subdirectory (`src/adapters/<plugin-name>/`), is imported here, and adds
 * exactly one element to the array. Nothing outside `src/index.ts` (the
 * wiring) may import from this directory, and no file anywhere may import
 * an adapter subdirectory — both pinned by test/adapters-pluggable.test.cjs.
 * Deleting this whole directory leaves the plugin fully working: the wiring
 * parameter defaults to `[]`.
 *
 * PB-11 ships the FRAMEWORK only: the array stays EMPTY, the first real
 * adapter (better-sidebar) arrives with PB-12.
 */

import type { BridgeAdapter } from './types.js'

/** Every adapter zen-remote ships, in registration order. */
export const ADAPTERS: readonly BridgeAdapter[] = []
