import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
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
 * S10 — keep the composer above the software keyboard (< 768px).
 *
 * The shell deliberately relies on the browser's own focus-reveal behaviour
 * (home.css.ts: plain overflow:hidden so iOS pans the visual viewport, no
 * visualViewport JS). Issue #1 (小米 + 微信输入法) showed one environment
 * where that chain can break while the viewport still shrinks. This effect
 * is the increment that covers it: mirror the occluded band into a root CSS
 * variable, and let the stylesheet translate the composer up by it. In every
 * environment where the browser already handles the keyboard the band
 * computes to zero and nothing changes; if the IME reports no height at all
 * (the research's候选 1/2) no event fires and this is inert — that class
 * needs the polling fallback, deliberately not built until confirmed.
 *
 * `scroll` is listened to as well as `resize`: panning the visual viewport
 * changes offsetTop without a resize (CSSOM View §13.2), and both sides of
 * the subtraction must stay fresh.
 */
export declare function installKeyboardAvoid(ctx: ClientContext): void;
//# sourceMappingURL=keyboard-avoid.d.ts.map