/**
 * Back-gesture plumbing: a stack of dismissible layers mirrored into
 * `history`, so Android's system back gesture closes what is on top instead
 * of leaving the PWA.
 *
 * Why this exists at all: the phone shell's page stack is pure store state
 * (`nav-store.ts`), and nothing ever pushed a history entry. Android's edge
 * swipe IS the browser's back, so with an empty history it exited the app and
 * the next launch was a cold reload. The edge is also where the system
 * gesture lives, which is why the plugin's own edge-swipe never fired on
 * Android — those pixels never reach the page. `systemGestureExclusionRects`
 * is a native-app API with no web equivalent, so the gesture cannot be
 * blocked; it can only be *given something to do*. (An early version called
 * `history.back()` from the custom gesture and was removed as "a no-op
 * against an SPA" — the no-op was the missing history entry, not `back()`.)
 *
 * Contract, and the one rule that keeps this honest: **layers close in one
 * direction only.** A surface never flips its own state to closed; it calls
 * {@link popLayer}, which rewinds history, which fires `popstate`, which runs
 * the layer's `close`. State driven from both ends drifts out of sync with
 * the history stack, and the drift shows up as a back gesture that does
 * nothing.
 *
 * Verified against the harness: DSH's own client never touches the History
 * API (`pushState`/`popstate`/`replaceState` all absent from dsh-client-
 * runtime, -ui-conversation and -ui-layout, 2026-08-20), so this is
 * uncontested ground.
 */
/** One dismissible surface. `close` must be idempotent. */
export interface HistoryLayer {
    /** Stable id, unique among currently-open layers. */
    id: string;
    /** Runs when the back gesture (or {@link popLayer}) rewinds past it. */
    close: () => void;
}
/** Open a layer: remember how to close it, and give back one entry to spend. */
export declare function pushLayer(layer: HistoryLayer): void;
/**
 * Close a layer the app-side way (a close button, a nav action). Rewinds
 * history instead of flipping state, so the two never diverge.
 */
export declare function popLayer(id: string): void;
/** Whether a layer is currently open. */
export declare function hasLayer(id: string): boolean;
/** Test seam: current depth. */
export declare function layerDepth(): number;
/** Test seam: drop everything without touching history. */
export declare function resetLayers(): void;
//# sourceMappingURL=history-nav.d.ts.map