/**
 * Home-screen chip visibility, keyed by {@link ChipDef.id} (MobileHomeChips.tsx).
 * A missing key means "shown" — new chip ids need no migration step, they
 * just default enabled the first time they exist.
 */
export type ChipPrefs = Record<string, boolean>;
/** @param prefs - current snapshot. @param id - chip id. @returns whether the chip should render (default true). */
export declare function isChipEnabled(prefs: ChipPrefs, id: string): boolean;
/** Flip one chip's visibility and persist it. @param id - chip id. */
export declare function toggleChip(id: string): void;
/** Live chip-prefs mirror (React 18 tearing-safe external store read). */
export declare function useChipsPrefs(): ChipPrefs;
//# sourceMappingURL=chips-store.d.ts.map