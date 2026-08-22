/**
 * dsh-mobile-nav, node half.
 *
 * Was an empty apply (pure client UI plugin) until S7. It now owns ONE host
 * route: the phone composer's attachment upload. The official file picker
 * opens on the machine running DSH, which is useless from a phone, and the
 * public client API has no upload verb at all — the only public browser->host
 * byte channel is `session.prompt([{type:'image',…}])`, which is images only
 * and lands as a sent message rather than a file on disk. So a non-image
 * attachment needs a route of its own, and that route belongs here rather
 * than in the gateway half of this plugin: the gateway authenticates and forwards
 * verbatim, it does not know what a session or a workspace is.
 *
 * The browser half still ships via exports["./client"], discovered through
 * the package.json dsh.client declaration.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
/** Exact route the phone composer POSTs one file body to. */
export declare const UPLOAD_ROUTE = "/_dsh/mobile-nav/upload";
/** Exact route the browser GETs the plugin row's client-facing knobs from.
 * The client bundle ships statically and never sees the row config, so the
 * host republishes the client-relevant subset here (issue #2). */
export declare const CLIENT_CONFIG_ROUTE = "/_dsh/mobile-nav/client-config";
/** Workspace-relative directory uploads land in (also the `@` prefix the composer inserts). */
export declare const UPLOAD_DIR = ".dsh-uploads";
/** Body cap when the plugin row sets no `maxUploadBytes`. */
export declare const DEFAULT_MAX_UPLOAD_BYTES: number;
/** Host half config. */
export interface MobileNavConfig {
    /** Max upload body in bytes; larger bodies get 413. Default {@link DEFAULT_MAX_UPLOAD_BYTES}. */
    maxUploadBytes?: number;
    /** Fold each turn's process at every viewport width, not just below the
     * phone breakpoint. Default false (phone-only). A browser can still opt
     * itself in via `?mobile-nav-turn-fold=1` when this is off. */
    turnFoldDesktop?: boolean;
    /** Calibration for the composer lift used when a phone's keyboard is
     * invisible to the browser (src/client/effects/keyboard-avoid.ts). Leave
     * every one of these unset to keep the shipped estimate — the route omits
     * what the row never set, and the client half owns the defaults, so there
     * is one place each default is written.
     *
     * Share of the layout viewport the estimated lift starts from (shipped
     * 0.42). Clamped to 0-1. */
    keyboardLiftRatio?: number;
    /** Ceiling on that estimate in CSS pixels (shipped 400). Clamped to 0-2000. */
    keyboardLiftMaxPx?: number;
    /** Extra clearance above a keyboard the browser DID react to, Android only
     * (shipped 15). Clamped to 0-200. */
    keyboardSafetyPadPx?: number;
}
/**
 * One configured number on its way to the browser, clamped into a band that
 * cannot break the composer — a ratio of 5 or a 9000px lift would push the
 * input clean off the screen with no way back except editing the YAML again.
 * Absent from the result when the row left it unset or wrote something that
 * is not a finite number, which leaves the client on its shipped default.
 *
 * Exported for scripts/check-keyboard-avoid.mjs — this is the trust boundary
 * between a hand-edited YAML row and the browser, so it is asserted directly.
 */
export declare function clamped(key: string, value: number | undefined, min: number, max: number): Record<string, number>;
/**
 * Accept a state-changing request only from this DSH Web application's origin.
 *
 * The gateway half rewrites `Origin`/`Host` to the upstream origin
 * before forwarding (lan-gate-server.cjs `cleanHeaders`), so a phone request
 * that already cleared the pairing wall presents here as same-origin; a
 * request with neither header falls back to the Fetch metadata.
 * @param req - the inbound request.
 * @returns true when the request may mutate the workspace.
 */
export declare function sameOriginPost(req: IncomingMessage): boolean;
/**
 * Reject a resolved path that is not rooted below the expected directory.
 * @param root - the directory the target must stay inside.
 * @param target - the resolved candidate path.
 * @throws when the target escapes the root.
 */
export declare function ensurePathInside(root: string, target: string): void;
/**
 * Convert an untrusted browser label into one portable leaf filename.
 *
 * Everything that could steer the write out of the upload directory is gone
 * after this: only the basename survives (so `../../etc/passwd` becomes
 * `passwd`), separators and control characters become `_`, leading dots are
 * dropped, and the Windows reserved device names are prefixed. Whitespace
 * folds to `_` rather than being kept: the client appends the result to the
 * composer draft as an `@path` mention, and a mention with a space in it is
 * broken for the agent reading it, not just for the chip parser. Length is
 * capped in BYTES because the label arrives as UTF-8.
 * @param raw - browser-supplied filename.
 * @returns a single safe leaf name, never empty.
 */
export declare function safeUploadName(raw: string): string;
/**
 * Handle one `POST {@link UPLOAD_ROUTE}?session=<id>&name=<file>` request.
 *
 * Exported so an integration check can drive it with a plain node:http server
 * and a fake sessions service instead of booting a harness.
 * @param ctx - host context carrying the sessions service and logger.
 * @param maxBytes - body cap.
 * @param req - inbound request; its body is the raw file.
 * @param res - the response this call owns end to end.
 */
export declare function handleUpload(ctx: Context, maxBytes: number, req: IncomingMessage, res: ServerResponse): Promise<void>;
/**
 * Host half: mount the upload route wherever a webServer and live sessions
 * exist. Both are injected INSIDE apply rather than declared as a top-level
 * `inject`, so the plugin row still loads (and the browser half still ships)
 * in a composition without them — Electron carries no webServer.
 * @param ctx - host plugin context.
 * @param config - optional body cap override.
 */
export declare function apply(ctx: Context, config?: MobileNavConfig): void;
//# sourceMappingURL=index.d.ts.map