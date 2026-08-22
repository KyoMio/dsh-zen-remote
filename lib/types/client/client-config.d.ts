/**
 * The plugin row's client-facing knobs, fetched once per page.
 *
 * The client bundle ships statically and never sees the row config, so the
 * host republishes the client-relevant subset at {@link CLIENT_CONFIG_ROUTE}
 * (src/index.ts). Two effects read it — turn-fold's desktop switch and
 * keyboard-avoid's fallback tuning — so the request is memoized here rather
 * than fired once per reader.
 *
 * Defaults live in THIS file, not in the host: the route omits a knob the
 * row never set, so there is exactly one place each default is written and
 * no way for the two halves to drift apart on the value. The host's job is
 * only to validate and clamp what a user actually typed.
 *
 * Every read is total — a failed request, a non-JSON body, or a garbage
 * value all fall back to the defaults rather than throwing into an effect.
 */
/** Mirror of src/index.ts CLIENT_CONFIG_ROUTE (client tsconfig cannot reach it). */
export declare const CLIENT_CONFIG_ROUTE = "/_dsh/mobile-nav/client-config";
/**
 * Tuning for the estimated-lift path in effects/keyboard-avoid.ts — the
 * fallback for a keyboard the browser cannot see at all. There is nothing to
 * measure on those devices, so these are estimates, and estimates about
 * hardware need a knob: IME toolbars, foldables, and PWA shells all sit at
 * different heights, and the person holding the phone is the only one who
 * can see whether the composer cleared the keys.
 */
export interface KeyboardTuning {
    /** Share of the layout viewport the estimated lift starts from. */
    liftRatio: number;
    /** Ceiling on that estimate, so a tall viewport cannot strand the composer mid-screen. */
    liftMaxPx: number;
    /** Extra clearance above a keyboard the browser DID react to (Android only). */
    safetyPadPx: number;
}
/** Shipped tuning: the values measured on the one reported device (issue #1,
 * WeType ~315 CSS px on an 858px viewport) plus the Android IME under-report
 * pad. Changing these changes the default for every install — a per-device
 * fix belongs in that install's plugin row instead. */
export declare const KEYBOARD_DEFAULTS: KeyboardTuning;
/** Everything the client half reads off the plugin row. */
export interface ClientConfig {
    /** Fold each turn's process at every width, not just below the phone breakpoint. */
    turnFoldDesktop: boolean;
    keyboard: KeyboardTuning;
}
/** Parse one route body. Exported for scripts/check-client-config.mjs. */
export declare function parseClientConfig(body: unknown): ClientConfig;
/** The row config, fetched at most once per page load. Never rejects. */
export declare function clientConfig(): Promise<ClientConfig>;
//# sourceMappingURL=client-config.d.ts.map