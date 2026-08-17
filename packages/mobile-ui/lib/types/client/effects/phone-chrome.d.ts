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
export declare function installPhoneChrome(ctx: ClientContext): void;
/**
 * Does the layout viewport sit shorter than the screen by at least the top
 * inset env() still claims? (S1.2 predicate, wired in S1.3.)
 *
 * Device numbers (iPhone, iOS 26.5, standalone PWA, 393x852): innerHeight
 * 793, env top 59 (= 852 - 793), env bottom 34, frame bottom 793 flush.
 * The same device in a Safari TAB reads innerHeight 695 with every surface
 * flush and every design value correct, which is what rules our own CSS out.
 *
 * What the true-branch means, settled by S1.2 + S1.3 device evidence: the
 * viewport is anchored at screen y=0 and merely cut 59px short at the BOTTOM
 * — not pushed down below the status bar. So the top inset is paid exactly
 * once and must be left alone, while the bottom inset is a lie: the home
 * indicator lives in the dead strip below the page. installSunkInset() acts
 * on that, and only on --mnav-sab.
 *
 * The `envTop > 0` guard is what keeps every other standalone install out:
 * landscape iPhone (top inset 0, the notch moves to left/right), iPad, and
 * Android — where standalone also loses status-bar height off innerHeight but
 * reports env top 0 — all fall through to false. Kept pure so the boundaries
 * are checkable off-device: scripts/check-sunk-viewport.mjs.
 */
export declare function isViewportSunkBelowStatusBar(input: {
    standalone: boolean;
    screenHeight: number;
    innerHeight: number;
    envTop: number;
}): boolean;
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
/**
 * Sunk-viewport compensation (S1.3, 2026-08-17) — zeroes --mnav-sab ONLY.
 *
 * When isViewportSunkBelowStatusBar() holds, the layout viewport is 59px
 * shorter than the screen while env() still reports the full pair of insets.
 * The bottom one is then a lie with a cost: the home indicator sits in the
 * dead strip BELOW the page, so the 34px we reserve for it is 34px of blank
 * page stacked on top of an already-blank system band. Zeroing it does not
 * fix the band (nothing in the page can) but stops us widening it.
 *
 * --mnav-sat is deliberately left alone: the top edge is measured correct on
 * the device (header sits right under the notch), and the S1.2 round already
 * burned a cycle on the theory that it was double-counted.
 *
 * Reversible by design. The predicate is re-evaluated on every resize, so a
 * viewport that comes back to full height — the heal above winning, or Apple
 * shipping the fix — drops the override and the normal env() compensation
 * returns without a reload. `data-mnav-sunk` on <html> is what the debug
 * badge reads, so the badge reports the state that is actually in force
 * rather than re-deriving it.
 */
export declare function installSunkInset(ctx: ClientContext): void;
//# sourceMappingURL=phone-chrome.d.ts.map