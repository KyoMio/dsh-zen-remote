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
 * than in the dsh-mobile-pwa gateway: the gateway authenticates and forwards
 * verbatim, it does not know what a session or a workspace is.
 *
 * The browser half still ships via exports["./client"], discovered through
 * the package.json dsh.client declaration.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
/** Exact route the phone composer POSTs one file body to. */
export declare const UPLOAD_ROUTE = "/_dsh/mobile-nav/upload";
/** Workspace-relative directory uploads land in (also the `@` prefix the composer inserts). */
export declare const UPLOAD_DIR = ".dsh-uploads";
/** Body cap when the plugin row sets no `maxUploadBytes`. */
export declare const DEFAULT_MAX_UPLOAD_BYTES: number;
/** Host half config; the only knob is the body cap. */
export interface MobileNavConfig {
    /** Max upload body in bytes; larger bodies get 413. Default {@link DEFAULT_MAX_UPLOAD_BYTES}. */
    maxUploadBytes?: number;
}
/**
 * Accept a state-changing request only from this DSH Web application's origin.
 *
 * The dsh-mobile-pwa gateway rewrites `Origin`/`Host` to the upstream origin
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
 * dropped, and the Windows reserved device names are prefixed. Length is
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