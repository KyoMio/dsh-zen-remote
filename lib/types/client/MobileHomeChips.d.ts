import type { Translate } from '@deepseek-ai/dsh-client-ui-slots';
import type { MobileNavKey } from './locales.ts';
/** One icon component's minimal shared shape (every `@deepseek-ai/dsh-client-ui-primitives` icon accepts `size`, regardless of the fixed number in its own name — see e.g. IconDownloadOutline16 used at size 14 elsewhere in this codebase). */
type IconFC = (props: {
    size?: number;
}) => React.JSX.Element;
/**
 * One home-screen chip's static registration (S5). `selector` is the
 * stable, non-hashed DOM anchor for the plugin's REAL entry button — the
 * chip never reimplements the target feature, it just "代点" (synthetic
 * `.click()`, bypasses hit-testing per the S2.1 precedent in AGENTS.md) the
 * button the plugin itself already renders elsewhere in the tree, exactly
 * like MobileSessionHeader's Chat/Trajectory tab click and the workbench
 * button's `[data-dsh-better-sidebar] button[class$="_toggleButton"]`.
 * `selector: null` marks the one chip (session log) whose availability and
 * action come from injected props instead of a DOM probe — it is a
 * first-party dsh-session-log-export service call, not a third-party
 * plugin's button.
 */
export interface ChipDef {
    id: string;
    label: MobileNavKey;
    Icon: IconFC;
    selector: string | null;
}
/** Static chip registry (S5). Order here is the default row order. */
export declare const CHIP_DEFS: readonly ChipDef[];
/** Full props for the chip row. */
export interface MobileHomeChipsProps {
    t: Translate<MobileNavKey>;
    sessionId: string | undefined;
    downloadSessionLog: (id: string) => void;
    onCustomize: () => void;
}
/**
 * Plugin-entry chips row (S5): a horizontally-scrolling line of 34px pills
 * between the workspace title and the session list, plus a trailing "···"
 * that opens the customize sheet (MobileHomeChipsSheetBody below, rendered
 * by MobileHome inside its existing home-sheet chrome). Every chip renders
 * only when both true: the user has not hidden it (useChipsPrefs) AND its
 * target actually exists right now (useDetectedIds / sessionId) — an
 * uninstalled plugin's chip never appears, matching the plan's "按用户实装
 * 插件逐个接入口". Chips beyond {@link CHIP_DEFS} (S5.1: any OTHER plugin's
 * own sidebar-footer-action entry) are auto-discovered by
 * {@link useHarvestedChips} and appended after the hand-registered ones —
 * "装了新插件、chips 行零代码长出对应入口".
 */
export declare function MobileHomeChips({ t, sessionId, downloadSessionLog, onCustomize }: MobileHomeChipsProps): import("react").JSX.Element;
/**
 * Customize-sheet body (S5, existence filter added 2026-08-17 real-device
 * follow-up): one toggle row per chip whose target actually exists —
 * `useDetectedIds()`, the SAME live probe `MobileHomeChips` uses for the row
 * itself. Originally listed every `CHIP_DEFS` entry unconditionally, on the
 * theory that a not-yet-installed plugin's toggle should still be
 * pre-settable; real-device feedback was that this instead surfaces dead
 * switches for plugins the user never installed (taskboard/ssh). Detection
 * is a live MutationObserver subscription, so installing the plugin later
 * still makes its toggle appear with no reload needed — "将来装了自动出现"
 * survives the change, it just also stops showing before that. `sessionLog`
 * (selector: null) is exempt: its existence is a runtime session-scope
 * question, not a plugin-install question, so it always lists regardless of
 * whether a session happens to be open right now. Stale prefs entries for a
 * chip that no longer renders (e.g. an uninstalled plugin's old toggle
 * value) are simply never read — `isChipEnabled`/`toggleChip`
 * (chips-store.ts) key off `CHIP_DEFS` ids already, so leftover keys in the
 * persisted object are inert, not an error. Rendered by MobileHome inside
 * the SAME home-sheet-layer/mask/sheet chrome the workspace switcher uses
 * (S6's drag-to-close and mask-click-close already bind generically to
 * `[data-mobile-nav="home-sheet"]`, so this second use needs no new gesture
 * wiring — see styles/chips.css.ts).
 */
export declare function MobileHomeChipsSheetBody({ t }: {
    t: Translate<MobileNavKey>;
}): import("react").JSX.Element;
export {};
//# sourceMappingURL=MobileHomeChips.d.ts.map