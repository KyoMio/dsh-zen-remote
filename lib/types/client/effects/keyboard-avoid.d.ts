import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type KeyboardTuning } from '../client-config.ts';
/** The safety pad this platform gets: the configured clearance, or nothing
 * off Android. UA sniffing is the right tool here — the target is a platform
 * defect, not a feature that could be detected.
 * @param padPx - the row's clearance; defaults to the shipped 15px. */
export declare function safetyPad(userAgent: string, padPx?: number): number;
/**
 * Fallback lift for a keyboard the browser cannot see (issue #1 确诊根因:
 * 微信输入法在该设备上不向系统 insets 上报键盘高度, Chrome 键盘高度恒 0).
 * There is no signal to measure, so this is an estimate: the reporter's
 * measured WeType is ~315 CSS px on a 858px viewport (~37%); 42% capped at
 * 400px covers taller IME toolbars without stranding the composer mid-screen.
 *
 * Both numbers are a guess about someone else's hardware, so both are knobs:
 * `config.keyboardLiftRatio` / `config.keyboardLiftMaxPx` on the plugin row
 * ({@link KeyboardTuning}). The shipped pair stays the default — an install
 * that never touches them behaves exactly as before.
 *
 * @param tuning - the row's tuning; defaults to the shipped estimate.
 */
export declare function estimatedLift(innerHeight: number, tuning?: KeyboardTuning): number;
/** One visualViewport reading, in CSS pixels. */
export interface ViewportReading {
    /** Layout viewport height (window.innerHeight). */
    innerHeight: number;
    /** visualViewport.height. */
    vvHeight: number;
    /** visualViewport.offsetTop. */
    offsetTop: number;
    /** visualViewport.scale. */
    scale: number;
}
/**
 * How far the composer must rise so its bottom edge sits on the visual
 * viewport's bottom edge (issue #1, 方案 2 of
 * docs/research-ime-keyboard-occlusion.md).
 *
 * The composer is sticky at the LAYOUT viewport's bottom; the keyboard
 * shrinks only the VISUAL viewport (Chrome 108+ resizes-visual). When the
 * browser also pans the visual viewport down to reveal the focused field —
 * iOS, and Android when its auto-scroll works — the occluded band is zero
 * and this stays a no-op. When it shrinks without panning (the reported
 * class of bug), the difference is exactly the hidden band.
 *
 * Pinch-zoom shrinks vvHeight too; the scale guard keeps zooming from
 * flinging the composer around.
 */
export declare function keyboardLift(reading: ViewportReading): number;
/**
 * The lift the composer actually gets, from the three sources in priority
 * order.
 * @param geometric - {@link keyboardLift} of the current reading.
 * @param estimate - the dumb-keyboard estimate, 0 when not in that mode.
 * @param keyboardShrunk - the viewport lost {@link KEYBOARD_MIN_SHRINK_PX}
 *   or more against its no-keyboard baseline, i.e. the browser reacted.
 * @param pad - this platform's safety clearance, from {@link safetyPad}.
 * @returns pixels to translate the composer up by.
 */
export declare function composerLift(geometric: number, estimate: number, keyboardShrunk: boolean, pad: number): number;
/**
 * S10 — keep the composer above the software keyboard (< 768px).
 *
 * The shell deliberately relies on the browser's own focus-reveal behaviour
 * (home.css.ts: plain overflow:hidden so iOS pans the visual viewport, no
 * visualViewport JS). Issue #1 (小米 + 微信输入法) showed one environment
 * where that chain can break while the viewport still shrinks. This effect
 * is the increment that covers it: mirror the occluded band into a root CSS
 * variable, and let the stylesheet translate the composer up by it. In every
 * environment where the browser already handles the keyboard the band
 * computes to zero and nothing changes.
 *
 * `scroll` is listened to as well as `resize`: panning the visual viewport
 * changes offsetTop without a resize (CSSOM View §13.2), and both sides of
 * the subtraction must stay fresh.
 *
 * Second layer (2026-08-21, after on-device confirmation): the reporter's
 * 小米 + 微信输入法 keyboard is INVISIBLE to Chrome — vv.height stayed 859/858
 * with the keyboard open, so no event ever fires and the geometry above is
 * honestly zero. For that class only, a touch-granted composer focus starts a
 * short probe; if the viewport has not moved at all by the end, the composer
 * gets an ESTIMATED lift until blur. Guards against false positives:
 * - probe only after a recent touch pointerdown (a hardware-keyboard focus
 *   never lifts anything);
 * - any viewport movement ≥ {@link PROBE_EPSILON_PX} cancels the probe — a
 *   browser that shows any reaction owns the reveal itself (iOS pans,
 *   working Android resizes);
 * - a non-zero geometric lift always wins over the estimate.
 *
 * Third layer: an IME that under-reports its height (toolbar strip left out
 * of what it declares) makes the browser shrink the viewport by less than the
 * keyboard covers — every number the page can read is self-consistent, so no
 * occlusion is computable. Whenever a keyboard is up and the browser DID
 * react, the composer therefore also gets {@link safetyPad} of clearance —
 * Android only, where the under-reporting happens.
 * See {@link composerLift} for how the three sources compose.
 */
export declare function installKeyboardAvoid(ctx: ClientContext): void;
//# sourceMappingURL=keyboard-avoid.d.ts.map