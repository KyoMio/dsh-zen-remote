import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/**
 * "内测声明" first-run notice, opt-out half (ALL widths — same user-directed
 * exception as the _previewBadge rule in styles/base.css.ts).
 *
 * Why not CSS: the notice dialog keeps document #root inert while MOUNTED and
 * only restores it on unmount (its acknowledge button). display:none hid the
 * dialog without unmounting it, which left the whole app permanently
 * unclickable on remote connections (2026-08-18 incident) — remote browsers
 * re-mount the notice on every page load because their acknowledgement is
 * memory-only (`connection.isLoopback ? "host" : "memory"` upstream).
 *
 * So the dialog now shows normally, plus one injected "不再弹出" button. The
 * user chooses: acknowledging via that button records the opt-out in this
 * browser's localStorage, and later mounts are auto-acknowledged by clicking
 * the dialog's own continue button — the component unmounts through its
 * normal path and #root's inert is properly restored.
 */
export declare function installWelcomeNoticeOptOut(ctx: ClientContext): void;
//# sourceMappingURL=welcome-notice.d.ts.map