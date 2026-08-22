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
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
/** Exact route the phone composer POSTs one file body to. */
export const UPLOAD_ROUTE = '/_dsh/mobile-nav/upload';
/** Exact route the browser GETs the plugin row's client-facing knobs from.
 * The client bundle ships statically and never sees the row config, so the
 * host republishes the client-relevant subset here (issue #2). */
export const CLIENT_CONFIG_ROUTE = '/_dsh/mobile-nav/client-config';
/** Workspace-relative directory uploads land in (also the `@` prefix the composer inserts). */
export const UPLOAD_DIR = '.dsh-uploads';
/** Body cap when the plugin row sets no `maxUploadBytes`. */
export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Longest filename, in bytes, that survives sanitization (ext4/APFS leaf limit is 255). */
const MAX_NAME_BYTES = 180;
/** Distinct leaf names tried before a collision is given up on. */
const MAX_COLLISION_TRIES = 100;
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
export function clamped(key, value, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return {};
    return { [key]: Math.min(Math.max(value, min), max) };
}
/**
 * One rejection carrying the status the client should see.
 *
 * Fields are assigned in the body rather than declared as constructor
 * parameter properties: `scripts/check-upload-endpoint.mjs` imports this
 * module through Node's strip-only type stripping, which rejects that syntax.
 */
class UploadError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.name = 'UploadError';
        this.status = status;
        this.code = code;
    }
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
function isErrnoCode(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
function responseJson(res, status, body) {
    const bytes = Buffer.from(JSON.stringify(body));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.writeHead(status);
    res.end(bytes);
}
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
export function sameOriginPost(req) {
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite === 'cross-site')
        return false;
    const origin = req.headers.origin;
    if (origin === undefined)
        return fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none';
    const host = req.headers.host;
    if (host === undefined)
        return false;
    try {
        const parsed = new URL(origin);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
    }
    catch {
        return false;
    }
}
/**
 * Reject a resolved path that is not rooted below the expected directory.
 * @param root - the directory the target must stay inside.
 * @param target - the resolved candidate path.
 * @throws when the target escapes the root.
 */
export function ensurePathInside(root, target) {
    const rel = relative(root, target);
    if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
        throw new UploadError(400, 'path-escape', `resolved upload path escapes its workspace root: ${target}`);
    }
}
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
export function safeUploadName(raw) {
    const leaf = basename(raw.replaceAll('\\', '/')).normalize('NFC');
    let cleaned = leaf
        .replace(/[<>:"|?*\u0000-\u001f/\\]/gu, '_')
        .replace(/\s+/gu, '_')
        .replace(/^\.+/u, '')
        .trim()
        .replace(/[. ]+$/u, '');
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned))
        cleaned = `_${cleaned}`;
    const candidate = cleaned === '' ? 'upload.bin' : cleaned;
    if (Buffer.byteLength(candidate) <= MAX_NAME_BYTES)
        return candidate;
    const extension = extname(candidate).slice(0, 20);
    const budget = Math.max(1, MAX_NAME_BYTES - Buffer.byteLength(extension));
    let stem = candidate.slice(0, Math.max(1, candidate.length - extension.length));
    while (Buffer.byteLength(stem) > budget)
        stem = stem.slice(0, -1);
    return `${stem}${extension}`;
}
function singleQuery(url, key) {
    const values = url.searchParams.getAll(key);
    const value = values[0];
    if (values.length !== 1 || value === undefined || value === '') {
        throw new UploadError(400, 'bad-request', `${key} is required exactly once`);
    }
    return value;
}
/** Create the directory if absent, then prove it is a real directory inside the workspace. */
async function ensureManagedDirectory(workspace, path) {
    try {
        await mkdir(path, { mode: 0o700 });
    }
    catch (error) {
        if (!isErrnoCode(error, 'EEXIST'))
            throw error;
    }
    const entry = await lstat(path);
    // A symlink here would be the one way a prior workspace write could still
    // redirect the bytes elsewhere — realpath alone would happily follow it.
    if (entry.isSymbolicLink()) {
        throw new UploadError(400, 'path-escape', `upload directory is a symbolic link: ${path}`);
    }
    if (!entry.isDirectory())
        throw new UploadError(400, 'path-escape', `upload path is not a directory: ${path}`);
    const canonical = await realpath(path);
    ensurePathInside(workspace, canonical);
    return canonical;
}
/**
 * Resolve (and create) the upload directory of one live session.
 * @param ctx - host context carrying the sessions service.
 * @param sessionId - the session whose workspace receives the file.
 * @returns the canonical and visible upload directories.
 * @throws 404 when no live session has that id.
 */
async function sessionUploadRoot(ctx, sessionId) {
    const session = ctx.sessions.get(sessionId);
    if (session === undefined)
        throw new UploadError(404, 'session-not-found', `live Session not found: ${sessionId}`);
    const cwd = session.header.cwd;
    if (cwd === undefined || !isAbsolute(cwd)) {
        throw new UploadError(404, 'session-not-found', `Session has no absolute workspace: ${sessionId}`);
    }
    const visibleWorkspace = resolve(cwd);
    const workspace = await realpath(visibleWorkspace);
    const visibleRoot = join(visibleWorkspace, UPLOAD_DIR);
    const writeRoot = await ensureManagedDirectory(workspace, visibleRoot);
    return { writeRoot, visibleRoot };
}
/**
 * Claim one not-yet-existing leaf name, suffixing `-1`, `-2`, … on collision.
 * `wx` makes the claim atomic, so two concurrent uploads of the same name
 * cannot both win the same path.
 */
async function openUnique(directory, filename) {
    const extension = extname(filename);
    const stem = filename.slice(0, filename.length - extension.length) || 'upload';
    for (let n = 0; n < MAX_COLLISION_TRIES; n += 1) {
        const path = join(directory, n === 0 ? `${stem}${extension}` : `${stem}-${n}${extension}`);
        ensurePathInside(directory, path);
        try {
            return { handle: await open(path, 'wx', 0o600), path };
        }
        catch (error) {
            if (!isErrnoCode(error, 'EEXIST'))
                throw error;
        }
    }
    throw new UploadError(409, 'name-taken', `too many files named like ${filename}`);
}
/**
 * Stream the request body onto disk under a running byte cap.
 * @param req - the request whose body is the file.
 * @param directory - canonical upload directory.
 * @param filename - sanitized leaf name.
 * @param maxBytes - hard cap; exceeding it aborts and unlinks.
 * @returns the absolute path written and its byte count.
 */
async function writeUpload(req, directory, filename, maxBytes) {
    const declared = req.headers['content-length'];
    const expected = declared === undefined ? undefined : Number(declared);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
        throw new UploadError(400, 'bad-request', 'Content-Length is not a byte count');
    }
    // Reject the oversized upload before a single byte is read, so the phone
    // gets its 413 without spending the whole body on the radio.
    if (expected !== undefined && expected > maxBytes) {
        throw new UploadError(413, 'too-large', `upload exceeds the ${maxBytes}-byte limit`);
    }
    const { handle, path } = await openUnique(directory, filename);
    let received = 0;
    try {
        for await (const chunk of req) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += bytes.length;
            // Chunked bodies declare no length, so the cap must also hold here.
            if (received > maxBytes)
                throw new UploadError(413, 'too-large', `upload exceeds the ${maxBytes}-byte limit`);
            await handle.write(bytes);
        }
        if (expected !== undefined && received !== expected) {
            throw new UploadError(400, 'truncated', `upload body size mismatch: expected ${expected}, received ${received}`);
        }
        await handle.close();
        return { path, bytes: received };
    }
    catch (error) {
        await handle.close().catch(() => { });
        await rm(path, { force: true }).catch(() => { });
        throw error;
    }
}
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
export async function handleUpload(ctx, maxBytes, req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } });
        return;
    }
    if (!sameOriginPost(req)) {
        const error = { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' };
        responseJson(res, 403, { ok: false, error });
        return;
    }
    try {
        const url = new URL(req.url ?? UPLOAD_ROUTE, 'http://dsh.internal');
        const sessionId = singleQuery(url, 'session');
        const filename = safeUploadName(singleQuery(url, 'name'));
        const root = await sessionUploadRoot(ctx, sessionId);
        const written = await writeUpload(req, root.writeRoot, filename, maxBytes);
        const leaf = basename(written.path);
        responseJson(res, 201, {
            ok: true,
            relPath: `${UPLOAD_DIR}/${leaf}`,
            absolutePath: join(root.visibleRoot, leaf),
            filename: leaf,
            bytes: written.bytes,
        });
    }
    catch (error) {
        const status = error instanceof UploadError ? error.status : 400;
        const code = error instanceof UploadError ? error.code : 'upload-rejected';
        ctx.logger.warn('dsh-mobile-nav upload rejected: %s', message(error));
        responseJson(res, status, { ok: false, error: { code, message: message(error) } });
    }
}
/**
 * Host half: mount the upload route wherever a webServer and live sessions
 * exist. Both are injected INSIDE apply rather than declared as a top-level
 * `inject`, so the plugin row still loads (and the browser half still ships)
 * in a composition without them — Electron carries no webServer.
 * @param ctx - host plugin context.
 * @param config - optional body cap override.
 */
export function apply(ctx, config = {}) {
    const maxBytes = config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    ctx.inject(['webServer', 'sessions'], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register({
            kind: 'exact',
            path: UPLOAD_ROUTE,
            handler: (req, res) => handleUpload(webCtx, maxBytes, req, res),
        }), 'dsh-mobile-nav: upload route');
    });
    // Needs only the webServer: the client-config route must exist even in a
    // composition without live sessions.
    ctx.inject(['webServer'], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register({
            kind: 'exact',
            path: CLIENT_CONFIG_ROUTE,
            handler: (req, res) => {
                if (req.method !== 'GET') {
                    res.setHeader('Allow', 'GET');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } });
                    return;
                }
                responseJson(res, 200, {
                    turnFoldDesktop: config.turnFoldDesktop === true,
                    ...clamped('keyboardLiftRatio', config.keyboardLiftRatio, 0, 1),
                    ...clamped('keyboardLiftMaxPx', config.keyboardLiftMaxPx, 0, 2000),
                    ...clamped('keyboardSafetyPadPx', config.keyboardSafetyPadPx, 0, 200),
                });
            },
        }), 'dsh-mobile-nav: client config route');
    });
}
//# sourceMappingURL=index.js.map