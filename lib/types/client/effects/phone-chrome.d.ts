import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/**
 * Phone chrome: KEEP the system status bar (no fullscreen) and make it
 * blend into the page. On narrow screens:
 * - The viewport meta gains viewport-fit=cover, so env(safe-area-inset-top)
 *   is the real status-bar / notch height and the stylesheet can push every
 *   surface below it (off notched phones, or in a browser tab where the
 *   layout viewport already sits below the status bar, the inset is 0 and
 *   nothing shifts).
 * - A theme-color meta tracks the shell background (the official theme is
 *   toggled by body[data-ds-dark-theme], which flips --dsw-alias-bg-base):
 *   Android then paints the status bar / URL bar with the page's own base
 *   color, so the status bar reads as part of the UI instead of a foreign
 *   strip. The drawer paints the same strip on iOS / notch displays.
 * - gesturestart is suppressed as the legacy-iOS fallback for double-tap
 *   zoom; modern browsers are covered by the stylesheet's
 *   touch-action: manipulation (which keeps pan and pinch zoom).
 */
/**
 * Candidate test for the "sunk viewport" model of the iOS standalone-PWA
 * quirk (S1.2, 2026-08-17). NOT WIRED TO ANY STYLE — deliberately.
 *
 * Real-device numbers (iPhone, standalone PWA, 393x852 screen): innerHeight
 * 793, env top 59 (= 852 - 793), env bottom 34, frame bottom 793 flush.
 * One reading is that the system already pushed the layout viewport below the
 * status bar while env() still reports the full notch, so --mnav-sat pads a
 * second time. But the user reports the session header sits correctly right
 * under the notch, and a ~60px white band at the BOTTOM — which instead fits
 * a viewport anchored at screen y=0 and merely 59px short of the screen
 * bottom. Both models predict the same innerHeight; only the viewport's
 * on-screen ORIGIN separates them, and that is what the debug badge now
 * measures (screenY / visualViewport offsets / the two edge markers).
 *
 * So this stays a pure, tested predicate that the badge merely displays.
 * Wiring it to zero --mnav-sat is a one-liner once the screenshot settles
 * which model is real; doing it now would break a top edge that is correct.
 * See scripts/check-sunk-viewport.mjs — no desktop browser can enter the mode.
 *
 * The `envTop > 0` guard is what keeps every other standalone install out:
 * landscape iPhone (top inset 0, the notch moves to left/right), iPad, and
 * Android — where standalone also loses status-bar height off innerHeight but
 * reports env top 0 — all fall through to false.
 */
export declare function isViewportSunkBelowStatusBar(input: {
    standalone: boolean;
    screenHeight: number;
    innerHeight: number;
    envTop: number;
}): boolean;
export declare function installPhoneChrome(ctx: ClientContext): void;
/**
 * iOS standalone-PWA keyboard shrink (S1.2, 2026-08-17) — the ~60px white
 * band under the composer AND under the session list.
 *
 * Documented WebKit defect: the first time the software keyboard opens inside
 * a home-screen (standalone) PWA, the layout viewport permanently loses the
 * status-bar height for the rest of the app session. innerHeight,
 * visualViewport.height and 100dvh all report the shrunken value together, so
 * nothing inside the page can see anything wrong — the page simply ends early
 * and the strip below it is system background that no CSS can reach. Reported
 * as 932 -> 873 on an iPhone Pro Max; the user's device reads 852 -> 793.
 * Both are exactly one status bar. See
 * https://dev.to/cederhook/fixing-the-ios-standalone-pwa-keyboard-bug-that-shrinks-your-viewport-for-good-63d
 *
 * This is why the reported symptom is asymmetric and why the earlier
 * "double-counted top inset" reading was wrong: the top edge is genuinely
 * correct (env top 59 is paid once, the viewport starts at screen y=0), the
 * bottom is simply 59px short. It also explains a chat client being hit
 * hardest — the trigger is typing, which happens on the first message.
 *
 * The only known cure is to make WebKit re-measure: drop a full-viewport
 * element out of the box tree and force a synchronous reflow. Two departures
 * from the published recipe:
 * - scrollTop is saved and restored around the toggle. Un-boxing an ancestor
 *   resets every descendant scroller to 0, which in a chat client means the
 *   conversation jumps to its first message. Both happen inside one task, so
 *   no frame is ever painted in between and nothing flickers.
 * - the baseline is the tallest innerHeight this session has actually seen,
 *   not the screen height. On any device where the viewport is legitimately
 *   short, the baseline equals the current height and this never fires.
 *
 * Standalone-gated, so a browser tab (and every desktop, CDP included) is a
 * strict no-op — which is also why the fix cannot be regression-tested here
 * and has to be confirmed on the device.
 */
export declare function installViewportHeal(ctx: ClientContext): void;
//# sourceMappingURL=phone-chrome.d.ts.map