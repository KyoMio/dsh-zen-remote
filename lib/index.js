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
import { createOwnerPeerSource, createSharedApiFetchGetter } from './owner-peer.js';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readFileConfig, resolveConfig, unwrapVolatile } from './config.js';
import { createActivityTracker, createParentIndex, seedParentIndexFromSnapshots, startSweeper } from './activity.js';
import { ADMIN_ROUTE_PREFIX, createAdminHandler } from './admin-routes.js';
import { normalizedRowServerUrl } from './client-pairing.js';
import { CLIENT_ROUTE_PREFIX, createClientHandler } from './client-routes.js';
import { responseJson, sameOriginPost } from './http.js';
import { onSessionCreated, restoreBusy } from './share-ops.js';
import { startRestartWatcher } from './restart-watcher.js';
import { handleShareExport, SHARE_EXPORT_ROUTE } from './share-export.js';
import { createShareStore } from './share-store.js';
import { createRelayClient, RelayError, volatileUpdateTouchesServerName } from './relay-client.js';
import { computeFingerprints } from './fingerprint.js';
import { runSelfCheck, installIntercept } from './intercept.js';
import { checkGatewayShape } from './intercept-shape.js';
import { checkFetchRouteShape, installFetchRouteIntercept } from './fetch-route-intercept.js';
import { checkWebServerShape, installPluginRouteIntercept } from './plugin-route-intercept.js';
import { normalizeAdapter, adapterOwnsRegistryEntry } from './plugin-adapter-core.js';
import { ADAPTERS } from './adapters/index.js';
import { createRelayHandler, loadServerId, RELAY_PREFIX, resolveDshVersion } from './relay-server.js';
import { createBridgeRegistry, compareBridges } from './plugin-bridge.js';
import { createWizardHandler, WIZARD_ROUTE_PREFIX } from './wizard/routes.js';
import { createCaddyManager } from './wizard/caddy-process.js';
import { cfTokenConfigured, deleteCfTokenFile, readCfTokenFile, writeCfTokenFile } from './wizard/token-store.js';
import { createCloudflaredManager, tunnelTokenConfigured } from './wizard/cloudflared.js';
import { checkDomainOnCloudflare as runTunnelCheck, setupTunnel } from './wizard/tunnel-orchestrator.js';
import { writeTunnelTokenFile } from './wizard/cloudflared.js';
import { detectForwardedSource, parseProxyList } from './wizard/source-detect.js';
import { createVerificationManager } from './wizard/verify.js';
import { createPluginLoopback } from './plugin-loopback.js';
import { createPluginTunnel } from './plugin-tunnel.js';
// The loader's config schema (settings form) and the role normalizer live in
// src/config.ts next to the resolution they describe; re-exported so the
// plugin row's public surface stays on the main entry. The same-origin gate
// moved to src/http.ts next to the response envelope (T14) but its export
// stays here for scripts/check-upload-endpoint.mjs.
export { Config, resolveRole } from './config.js';
export { sameOriginPost } from './http.js';
// The two sub-plugin entries the host role loads. They ship as plain .mjs at
// the package root, and `..` resolves there both from this file (via the
// hand-written lan-gate.d.mts / dsh-push.d.mts declarations) and from the
// built lib/index.js (via the real files).
import * as gateway from '../lan-gate.mjs';
import * as push from '../dsh-push.mjs';
/** Exact route the phone composer POSTs one file body to. */
export const UPLOAD_ROUTE = '/_dsh/mobile-nav/upload';
/**
 * The one piece of cordis the typert interception needs at RUNTIME: the
 * registered symbol under which every cordis proxy answers with its raw
 * instance (`symbols.original` in @deepseek-ai/cordis is
 * `Symbol.for('cordis.original')`). Bound LOCALLY instead of imported —
 * a runtime import would make the built lib depend on @deepseek-ai/cordis,
 * whose dev copy in this package's node_modules would shadow the host's
 * (the check-host-shadow gate fails the build for exactly that). Registered
 * symbols are shared across module copies by design, so the lookup is
 * identity-exact; if cordis ever renames the key the lookup yields
 * undefined and the interception reports a refused install instead of
 * misbehaving.
 */
const symbols = { original: Symbol.for('cordis.original') };
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
 * The client role's relay client (T23a), created inside apply() and kept on
 * the module so other halves of the plugin can reach it without reaching
 * into a context. T23b's request interception reads it through
 * {@link getRelayClient}; it stays undefined on the host role (and in
 * compositions that never ran this module's apply).
 */
let clientRelayClient;
/** The live client-role relay client, if one was built. */
export function getRelayClient() {
    return clientRelayClient;
}
/**
 * The plugin bridge's declaration registry (PB-1), created inside apply() on
 * BOTH roles and kept on the module so later tasks (the handshake's plugins
 * table, the client-side rewrite) can reach it without reaching into a
 * context. Undefined in compositions that never ran this module's apply, and
 * — identity-guarded below — after the row that owned a registry was
 * unloaded or reloaded, so a reloaded row never leaves a stale table where
 * the getter can hand it out (the T23a-fix discipline).
 */
let bridgeRegistry;
/** The live bridge registry, if a plugin row is currently applied. */
export function getBridgeRegistry() {
    return bridgeRegistry;
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
    await ensureSelfIgnoring(canonical);
    return canonical;
}
/**
 * Drop a self-ignoring `.gitignore` (`*` + `!.gitignore`) next to the
 * upload directory's creation, so dropped files never surface as untracked
 * entries in the session workspace — an agent's `git add -A` would
 * otherwise commit the user's uploads. `wx` keeps a pre-existing
 * (user-customized) file untouched; in a non-git workspace the file is an
 * inert no-op. Best-effort only: a read-only directory still receives the
 * upload route's own error, never a new one from here.
 */
async function ensureSelfIgnoring(directory) {
    try {
        await writeFile(join(directory, '.gitignore'), '*\n!.gitignore\n', { flag: 'wx', mode: 0o644 });
    }
    catch (error) {
        if (!isErrnoCode(error, 'EEXIST') && !isErrnoCode(error, 'EROFS') && !isErrnoCode(error, 'EACCES'))
            throw error;
    }
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
 * @param admit - DSH's connection-service admission, passed by the apply()
 *   wiring (T17): webServer routes skip DSH's /api authentication, so every
 *   request must ask the connection service itself, its refusal relayed
 *   verbatim — same first wall as the admin and client routes. Optional only
 *   for the direct-drive check scripts; production always passes it.
 */
export async function handleUpload(ctx, maxBytes, req, res, admit) {
    if (admit !== undefined) {
        const admission = admit(req);
        if ('rejection' in admission) {
            responseJson(res, admission.rejection, {
                ok: false,
                error: { code: admission.rejection === 401 ? 'unauthorized' : 'forbidden' },
            });
            return;
        }
    }
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
 *
 * On the host role (the default) this row also loads the gateway and push
 * sub-plugins, each with the RESOLVED config — every field merged from env >
 * row > lan-gate.config.json > defaults (src/config.ts) — not the raw row,
 * so the halves see the same effective values the row does. Cordis honors a
 * sub-plugin's own `inject` before calling its apply and routes fiber
 * failures into the context logger, so a fire-and-forget call is the whole
 * contract. The route tests' fake contexts carry a no-op `plugin` for it.
 * @param ctx - host plugin context.
 * @param config - the plugin row config as the loader handed it over (see
 *   {@link MobileNavConfig}): every field is a volatile live reference
 *   (`{ get() }` wrapper, T17), so nothing here is snapshotted —
 *   `resolveConfig` merges the row with `lan-gate.config.json` and the
 *   environment per read, and the route handlers unwrap their knobs per
 *   request.
 */
export function apply(ctx, config = {}) {
    const effective = resolveConfig(config, readFileConfig(), process.env);
    // RD-6 probe fact: whether the fetch-route inject callback (below, in the
    // client-half wiring) ever fired. On a composition where `connection` or
    // `fileUploads` never becomes available the callback stays silently
    // PENDING (cordis waits forever, printing nothing) and every fetch-route
    // diagnostic stays undefined — this flag is the one honest signal of that
    // state. Declared this early because probes on BOTH role branches read it.
    let fetchRouteInjectSeen = false;
    /** The client branch's fetch-route diagnostics getter, assigned once that
     * branch declares it; the probe reads it lazily through this slot so both
     * role mounts can share one probe factory. */
    let fetchRouteDiagnosticsRef;
    /** RD-6: build the lazy service probe against a context whose own inject
     * already resolved (the client-routes mounts qualify on both roles). One
     * reflection per process: `connection` / `fileUploads` presence plus the
     * fetchRoutes table's shape — enough to name the missing service. */
    const uploadServiceProbe = (probeCtx) => {
        let cached;
        return () => {
            if (cached !== undefined)
                return cached;
            const reflect = probeCtx.reflect;
            const connection = reflect?.get('connection');
            const fileUploads = reflect?.get('fileUploads');
            const fetchRoute = fetchRouteDiagnosticsRef?.();
            cached = {
                uploadInjectSeen: fetchRouteInjectSeen,
                connectionService: connection === undefined ? 'absent' : 'present',
                fileUploadsService: fileUploads === undefined ? 'absent' : 'present',
                ...(connection === undefined ? {} : { connectionShape: checkFetchRouteShape(connection) }),
                ...(fetchRoute === undefined ? {} : { fetchRoute }),
            };
            return cached;
        };
    };
    // The plugin bridge's zenRemote service (PB-1), provided on BOTH roles
    // before any role branch: a plugin that wants its panel data forwarded in
    // remote sessions declares that against THIS process whichever role it
    // runs as, and the declaration registry is the one piece of PB-1 both the
    // server half (handshake plugins table) and the client half (route
    // rewrite) will read. ctx.provide (cordis 4) registers the service owned
    // by THIS row's fiber: visible to `inject(['zenRemote'])` dependents once
    // the row is active, withdrawn when the row unloads — so a composition
    // without zen-remote never fires those injects and a row reload swaps the
    // service wholesale. The registry goes into the module slot BEFORE the
    // provide so this apply's consumers never see a window without it; the
    // effect's identity guard then clears the slot exactly when THIS row
    // unloads (a reload installs the new registry before the old disposer
    // runs, same shape as clientRelayClient). provide() throwing is not worth
    // failing the row over — the bridge stays off, everything else keeps
    // working — so it degrades to a warning like the session feeds do.
    const registry = createBridgeRegistry({
        warn: (text) => { ctx.logger?.warn('dsh-zen-remote plugin bridge: %s', text); },
    });
    bridgeRegistry = registry;
    try {
        const service = {
            bridge: (declaration) => registry.register(declaration),
        };
        ctx.provide('zenRemote', service);
    }
    catch (error) {
        ctx.logger?.warn('dsh-zen-remote: cannot provide the "zenRemote" service: %s', message(error));
    }
    ctx.effect(() => () => {
        if (bridgeRegistry === registry)
            bridgeRegistry = undefined;
    }, 'dsh-zen-remote: plugin bridge registry disposal');
    // The adapters (PB-11): each one registers ONLY against its target's
    // EXACT installed version, probed off the host's `pluginPackages` service
    // (`packageOf(name, ctx.baseUrl)` — verified on 0.2.0-rc.2 to answer
    // `{name, version, dir, …}` or undefined; any other shape, a missing
    // service or a probe failure reads as "not installed" and the adapter
    // stays out). A plugin that registers its OWN cooperative declaration
    // always wins: the adapter yields at registration time (logged), and the
    // runtime re-checks the registry digest on every request. Both roles run
    // this loop — the registry entries drive the handshake table, the bridge
    // verdicts and the settings listing on either side, while the returned
    // array feeds the two request halves.
    const adapters = [];
    {
        const adapterWarn = (text) => { ctx.logger?.warn('dsh-zen-remote adapter: %s', text); };
        for (const adapter of ADAPTERS) {
            try {
                const holder = ctx;
                const packages = holder.get?.('pluginPackages');
                const found = packages?.packageOf?.(adapter.plugin, holder.baseUrl ?? '');
                const installedVersion = found !== null && typeof found === 'object' && typeof found.version === 'string'
                    ? found.version
                    : undefined;
                if (installedVersion === undefined || installedVersion === '') {
                    adapterWarn(`${adapter.plugin}: target package (or its version) not found; not registered`);
                    continue;
                }
                const normalized = normalizeAdapter(adapter, installedVersion);
                if (registry.get(normalized.plugin) !== undefined) {
                    adapterWarn(`${normalized.plugin}: the plugin registers its own bridge declaration; the adapter yields`);
                    continue;
                }
                registry.registerNormalized(normalized.declaration);
                adapters.push(normalized);
                ctx.logger?.info('dsh-zen-remote adapter: %s adapted at version %s', normalized.plugin, installedVersion);
            }
            catch (error) {
                adapterWarn(`${adapter.plugin} refused: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    if (effective.values.role === 'host') {
        // A row that switched from client to host must not leave a stale relay
        // client where getRelayClient() can find it (T23a-fix).
        clientRelayClient = undefined;
        // The relay shared secret (T22a): minted fresh per apply, handed to the
        // gateway child through LAN_GATE_RELAY_SECRET and kept here for the
        // relay routes below. The push half never sees it.
        const relaySecret = randomBytes(32).toString('hex');
        ctx.plugin(gateway, { ...effective.values, relaySecret });
        ctx.plugin(push, effective.values);
        // The shared-session table backing the relay's access control. The relay
        // route consumes it below; the activity tracker and idle sweeper (T22c)
        // keep its "quiet for idleHours → close" promise. The settings surface is
        // a later task.
        const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
        const store = createShareStore({
            file: join(home, 'zen-remote-shares.json'),
            idleHours: effective.values.idleHours,
        });
        // The live relay handler, kept so the admin shares route can read viewer
        // counts through it (T33a2): the handler is the only piece that knows
        // who is connected. Assigned when the relay route mounts, cleared in its
        // teardown (identity-checked: a row reload builds a NEW handler before
        // the old one's disposer runs) — the admin route reads whatever is live
        // at request time and answers 0 viewers when none is mounted.
        let relayHandler;
        // Keep the table's clocks honest (T22c). The subscription mirrors
        // dsh-push.mjs's session/event listener — post-commit append feed for
        // EVERY session, subagent children included. The session id is read off
        // the Session object itself: `session.id` (a getter over the durable
        // header's single copy, per @deepseek-ai/dsh-session's Session type),
        // same field the push half reads through exec.agent.session.id. An event
        // that somehow arrives without a usable id is ignored, and listener
        // registration failure degrades to a warning like the push half's.
        // The parent index (T22c-fix) records subagent→parent links off the same
        // events' headers — DSH 0.2.0 dsh-session's validateSessionHeader pins
        // the two fields (`origin` is only ever 'subagent', `parentSession` a
        // string) — so a background child's motion refreshes its ancestors'
        // clocks and the relay can walk the same chain for reachability.
        const parentIndex = createParentIndex();
        const tracker = createActivityTracker(store, parentIndex.parentOf);
        try {
            ctx.on('session/event', (session, event) => {
                // Record the parent link BEFORE tracking, so a child's very first
                // event already reaches its ancestors.
                parentIndex.observe(session);
                const sessionId = session?.id;
                if (typeof sessionId !== 'string' || sessionId === '')
                    return;
                tracker.onEvent(sessionId, event.type);
            });
        }
        catch (error) {
            ctx.logger.warn('dsh-zen-remote cannot listen on "session/event": %s', message(error));
        }
        // Auto-share and fork-following (T33a), off `agent/created` — the only
        // host event that fires EXACTLY ONCE per NEW session. Its `source` is
        // 'startup' for fresh creation (top-level, fork and subagent all go
        // through the same factory call) and 'resume' when a persisted session
        // re-enters the live store, so filtering on 'startup' is what keeps a
        // manually-closed session closed across reopens — `session/created`
        // re-fires on resume and `api-session/added` also fires when an agent is
        // disposed, so neither qualifies. The payload's agent id IS the session
        // id (dsh-agent keys its registry by it; its typert wire type is
        // `dsh-session/types#SessionId`), and by announce time the fresh header
        // already carries the subagent/fork markers the share decision reads.
        // autoShareNewSessions is a volatile row setting: resolved at EVENT time,
        // never snapshotted here.
        try {
            ctx.on('agent/created', ({ agent, source }) => {
                // The feed dispatches SERIALLY: a throwing listener rolls the whole
                // session creation back (dsh-agent's announce awaits every listener
                // and fails the creation on the first rejection). Sharing is
                // best-effort bookkeeping — it must never be able to fail the
                // creation that triggered it.
                try {
                    if (source !== 'startup')
                        return;
                    onSessionCreated(agent.session.header, {
                        store,
                        autoShare: resolveConfig(config, readFileConfig(), process.env).values.autoShareNewSessions,
                        parentOf: parentIndex.parentOf,
                    });
                }
                catch (error) {
                    ctx.logger.warn('dsh-zen-remote cannot share new session "%s": %s', agent.id, message(error));
                }
            });
        }
        catch (error) {
            ctx.logger.warn('dsh-zen-remote cannot listen on "agent/created": %s', message(error));
        }
        // Busy restore (T33a): `busy` is never persisted, so right after a row
        // restart every shared session believes itself idle — including one whose
        // agent is mid-turn, which would then idle out from under the turn. Once
        // the agents service exists, re-mark whatever is actually running (the
        // flags clear again through the tracker's turn/end above).
        ctx.inject(['agents'], (agentsCtx) => {
            const agents = agentsCtx.agents;
            restoreBusy(store, () => agents.list());
        });
        // Restart repair (2026-10-13): the parent index rebuilds only from LIVE
        // session/event traffic, so after a host restart every already-stored
        // sidechat / subagent child lost its parent link and the relay answered
        // `not-shared` for a session whose share it used to inherit through the
        // ancestor chain. Seed the index once from the persistence service's
        // snapshot list — headers only, event logs are never read.
        try {
            ctx.inject(['sessionPersistence'], (persistenceCtx) => {
                const persistence = persistenceCtx.sessionPersistence;
                if (persistence === undefined) {
                    ctx.logger.warn('dsh-zen-remote: no sessionPersistence service — pre-restart subagent sessions stay not-shared until they emit an event');
                    return;
                }
                void persistence
                    .list()
                    .then((snapshots) => {
                    const recorded = seedParentIndexFromSnapshots(parentIndex, snapshots);
                    if (recorded > 0)
                        ctx.logger.info?.('dsh-zen-remote: restored %d persisted parent links', recorded);
                })
                    .catch((error) => ctx.logger.warn('dsh-zen-remote cannot seed parent links from persisted sessions: %s', message(error)));
            });
        }
        catch (error) {
            ctx.logger.warn('dsh-zen-remote cannot listen on "sessionPersistence": %s', message(error));
        }
        // Settings-surface admin routes (T14). The browser cannot call the
        // gateway's loopback-only admin API from DSH's origin, so the host
        // process re-exposes it same-origin and the handler calls the gateway AS
        // the local machine. `connection` supplies admit() — webServer routes
        // skip DSH's /api authentication — so a composition without one (Electron
        // carries no webServer either) simply never mounts the routes. Everything
        // config-shaped is resolved PER REQUEST inside the handler (volatile row
        // fields change without a restart, and the test-push copy follows the
        // live `lang`); only the non-volatile gateway port is captured here,
        // which a row restart re-reads anyway. Registered AFTER the store exists
        // above: an inject callback whose services are already present runs
        // synchronously during apply, and the shares options close over `store`.
        ctx.inject(['webServer', 'connection'], (webCtx) => {
            webCtx.effect(() => webCtx.webServer.register({
                kind: 'prefix',
                path: ADMIN_ROUTE_PREFIX,
                handler: createAdminHandler({
                    admit: (req) => webCtx.connection.admit(req),
                    gatewayBase: `http://127.0.0.1:${effective.values.port}`,
                    getConfig: () => resolveConfig(config, readFileConfig(), process.env),
                    // Shares routes (T33a): the table above is the truth they serve and
                    // mutate. typertGateway and agents are deliberately NOT in this
                    // inject's declaration list — adding them would keep the WHOLE
                    // admin prefix off 0.1.7 / Electron compositions that lack them —
                    // so they are read PER REQUEST through the reflection layer's
                    // store lookup (runtime `ctx.get`, declared `ctx.reflect.get`),
                    // which answers undefined when the service is absent. Property
                    // access is not an option: cordis refuses reads of services the
                    // context did not declare (`cannot get property … without inject`),
                    // which would turn every shares request into a 500.
                    store,
                    typert: () => webCtx.reflect.get('typertGateway'),
                    getPeer: createOwnerPeerSource(() => webCtx.connection),
                    listAgents: () => webCtx.reflect.get('agents')?.list() ?? [],
                    // The "who is looking" badge (T33a2): read through whichever relay
                    // handler is live right now. sessionQuery likewise — the share
                    // action reads the durable session header through it to judge
                    // subagent sessions, degrading to the projection identity when the
                    // composition lacks the service.
                    viewerCount: (id) => relayHandler?.viewerCount(id) ?? 0,
                    sessionQuery: () => webCtx.reflect.get('sessionQuery'),
                    // The plugin bridge listing (PB-5): the SAME registry this apply
                    // built and the SAME live consent reader the relay's plugins table
                    // uses — one source of truth per question. PB-11: the listing
                    // marks the plugins an adapter stands in for (live — a plugin
                    // that registered its own declaration stops being marked).
                    pluginBridge: {
                        registry,
                        getConsent: () => resolveConfig(config, readFileConfig(), process.env).values.pluginBridgeConsent,
                        adaptedPlugins: () => new Set(adapters.filter((adapter) => adapterOwnsRegistryEntry(adapter, registry.get(adapter.plugin))).map((adapter) => adapter.plugin)),
                    },
                }),
            }), 'dsh-zen-remote: admin routes');
        });
        // Gateway-wizard routes (GW-4, extended by GW-5): a separate LONGEST-
        // prefix registration under the admin prefix — the host web server
        // matches the longest prefix first, so /admin/wizard/* lands here and
        // everything else stays with the admin handler above. Same host-only
        // gate and admit wall; the wizard handler applies its own via-marker
        // and same-origin walls to every route. The runtime probe reads the
        // gateway's own /lan-gate/status for the untrusted-proxy detection
        // (read-only, best-effort); the trust-proxy persister merges into the
        // FILE layer of lan-gate.config.json — the only writable config surface
        // the plugin owns — which the restart watcher's poll picks up and
        // reloads the row from (trustedProxies is a restart field), restarting
        // the gateway with the new trust list. When the resolved value comes
        // from env or the row the route refuses instead: a file-layer write
        // would be shadowed there.
        ctx.inject(['webServer', 'connection'], (wizardCtx) => {
            // GW-13a: the managed Caddy lives in THIS row's closure — a row
            // reload rebuilds the manager (and the row's disposal, below, kills
            // the child), which is the reconcile-by-process-generation rule. The
            // subprocess service is a lazy reflection lookup: adding it to the
            // inject list would keep the whole wizard off compositions that lack
            // it, and there `reflect.get` answers undefined instead.
            const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
            const subprocessService = wizardCtx.reflect.get('subprocess');
            const caddyManager = subprocessService === undefined ? undefined : createCaddyManager({ subprocess: subprocessService, dshHome });
            const cloudflaredManager = subprocessService === undefined ? undefined : createCloudflaredManager({ subprocess: subprocessService, dshHome });
            // The verification session lives in THIS manager's closure (GW-9):
            // memory-only by design, and a row reload rebuilds it — the same
            // "stale" verdict the config fingerprint produces, arriving via the
            // process generation instead.
            const currentMode = () => resolveConfig(config, readFileConfig(), process.env).values.ingressMode;
            // One runtime probe per request: the gateway's own status (source-IP
            // detection + the ACTUAL port for snippets/QR), plus our processes'
            // liveness for the projection.
            const buildRuntime = async () => {
                try {
                    const response = await fetch(`http://127.0.0.1:${effective.values.port}/lan-gate/status`, { signal: AbortSignal.timeout(3000) });
                    if (!response.ok)
                        return { caddyRunning: caddyManager?.isRunning() === true };
                    const body = (await response.json());
                    return {
                        lastForwardedSource: detectForwardedSource(body),
                        // GW-fix-3/M2: the wizard's snippets and QR target the
                        // gateway's ACTUAL port (it may have retried past the
                        // configured one).
                        gatewayActualPort: typeof body?.port === 'number' ? body.port : undefined,
                        caddyRunning: caddyManager?.isRunning() === true,
                        cloudflaredRunning: cloudflaredManager?.isRunning() === true,
                        tunnelTokenConfigured: cloudflaredManager !== undefined,
                        cfTokenConfigured: cfTokenConfigured(dshHome),
                    };
                }
                catch {
                    // No answer is no detection — the status projection renders
                    // its null shape and the UI offers nothing.
                    return {
                        caddyRunning: caddyManager?.isRunning() === true,
                        cloudflaredRunning: cloudflaredManager?.isRunning() === true,
                        tunnelTokenConfigured: tunnelTokenConfigured(dshHome),
                        cfTokenConfigured: cfTokenConfigured(dshHome),
                    };
                }
            };
            const verification = createVerificationManager({
                gatewayBase: `http://127.0.0.1:${effective.values.port}`,
                getValues: () => resolveConfig(config, readFileConfig(), process.env).values,
                // runtimeReady now covers the managed paths: Caddy must actually be
                // alive; cloudflared arrives with GW-13b; the external path has no
                // process of ours to wait for.
                runtimeReady: () => {
                    const mode = currentMode();
                    if (mode === 'caddy')
                        return caddyManager?.isRunning() === true;
                    if (mode === 'cloudflared')
                        return cloudflaredManager?.isRunning() === true;
                    return true;
                },
            });
            wizardCtx.effect(() => {
                const unregister = wizardCtx.webServer.register({
                    kind: 'prefix',
                    path: WIZARD_ROUTE_PREFIX,
                    handler: createWizardHandler({
                        admit: (req) => wizardCtx.connection.admit(req),
                        getConfig: () => resolveConfig(config, readFileConfig(), process.env),
                        tokenStore: {
                            writeCfToken: (token) => { writeCfTokenFile(dshHome, token); },
                            deleteCfToken: () => {
                                // Stop the consumers first (the mode-switch rule): whichever
                                // process might hold the token in its environment dies before
                                // the file disappears.
                                caddyManager?.stop();
                                cloudflaredManager?.stop();
                                deleteCfTokenFile(dshHome);
                            },
                            cfTokenConfigured: () => cfTokenConfigured(dshHome),
                            writeTunnelToken: (token) => { writeTunnelTokenFile(dshHome, token); },
                        },
                        ...(caddyManager === undefined ? {} : {
                            caddy: {
                                start: async (input) => {
                                    // The token rides the child env only — read from the store
                                    // inside the wiring, never through a route payload.
                                    const token = readCfTokenFile(dshHome);
                                    if (token === undefined)
                                        return { ok: false, error: 'missing-token' };
                                    return caddyManager.start({ ...input, cfToken: token });
                                },
                                stop: () => caddyManager.stop(),
                                status: () => (caddyManager.isRunning() ? 'running' : caddyManager.hasStarted() ? 'stopped' : 'never-started'),
                            },
                        }),
                        ...(cloudflaredManager === undefined ? {} : {
                            tunnel: {
                                checkDomain: (domain) => runTunnelCheck({ readToken: () => readCfTokenFile(dshHome) }, domain),
                                setup: (input) => setupTunnel({
                                    dshHome,
                                    readToken: () => readCfTokenFile(dshHome),
                                    gatewayPort: async () => {
                                        // The ingress service target is the gateway's ACTUAL
                                        // port — same fallback as the caddy start route: probe
                                        // /lan-gate/status first, fall back to the configured
                                        // port when it does not answer (GW-fix-4/M2).
                                        try {
                                            const response = await fetch(`http://127.0.0.1:${resolveConfig(config, readFileConfig(), process.env).values.port}/lan-gate/status`, { signal: AbortSignal.timeout(3000) });
                                            if (response.ok) {
                                                const body = (await response.json());
                                                if (typeof body?.port === 'number')
                                                    return body.port;
                                            }
                                        }
                                        catch { /* fall through to the configured port */ }
                                        return resolveConfig(config, readFileConfig(), process.env).values.port;
                                    },
                                    cloudflared: {
                                        start: async (startInput) => {
                                            const started = await cloudflaredManager.start({ tunnelToken: startInput.tunnelToken });
                                            return started.ok ? { ok: true } : { ok: false, error: started.error ?? 'spawn-failed' };
                                        },
                                        // 模式切换：starting the tunnel stops the managed Caddy.
                                        stopCaddy: () => caddyManager?.stop(),
                                    },
                                }, input),
                                stop: () => cloudflaredManager.stop(),
                                status: () => (cloudflaredManager.isRunning() ? 'running' : cloudflaredManager.hasStarted() ? 'stopped' : 'never-started'),
                            },
                        }),
                        verify: { start: (input) => verification.start(input), check: () => verification.check() },
                        getRuntime: () => buildRuntime(),
                        trustProxy: {
                            resolved: () => {
                                const snapshot = resolveConfig(config, readFileConfig(), process.env);
                                return { value: snapshot.values.trustedProxies, source: snapshot.sources.trustedProxies };
                            },
                            write: async (expected, list) => {
                                const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
                                const file = join(home, 'lan-gate.config.json');
                                const current = readFileConfig();
                                // Concurrent-write guard (GW-fix-2/L2): the route resolved
                                // the list moments ago; if the file layer moved since (a
                                // parallel trust click, a hand edit), refuse instead of
                                // clobbering the other writer's entry. Both sides compare
                                // normalized so an illegal file value reads as "empty", the
                                // same thing resolveConfig saw.
                                const now = typeof current.trustedProxies === 'string' ? current.trustedProxies : '';
                                if (parseProxyList(now).join(',') !== parseProxyList(expected).join(','))
                                    return false;
                                const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
                                await writeFile(tmp, `${JSON.stringify({ ...current, trustedProxies: list }, null, 2)}\n`, { mode: 0o600 });
                                await rename(tmp, file);
                                return true;
                            },
                        },
                    }),
                });
                // H1: the row's disposal must not orphan the managed children — the
                // Caddy/cloudflared processes die WITH the row that spawned them,
                // before the route registration unregisters.
                return () => {
                    caddyManager?.stop();
                    cloudflaredManager?.stop();
                    unregister();
                };
            }, 'dsh-zen-remote: wizard routes');
        });
        // The idle sweeper (T22c): every minute, hand the table the CURRENT
        // idleHours and let it close sessions quiet past that. idleHours is a
        // volatile row field, so getIdleHours re-resolves from the SAME row
        // object apply() received at every tick — never snapshotted (the same
        // discipline as serverName in the relay route above); an illegal value
        // falls back inside resolveConfig, and share-store ignores the rest.
        ctx.effect(() => startSweeper({ store, getIdleHours: () => resolveConfig(config, readFileConfig(), process.env).values.idleHours }), 'dsh-zen-remote: idle sweeper');
        // The relay routes live where the typertGateway service does (0.2.0
        // compositions): a composition without it — 0.1.7, Electron — simply
        // never mounts them, and the relay prefix stays unrouted.
        ctx.inject(['webServer', 'typertGateway'], (relayCtx) => {
            // Structurally typed instead of a Context augmentation: the providing
            // package is not a devDependency here (see RelayGateway's comment).
            const gatewayService = relayCtx.typertGateway;
            // T41b: the `/api` shared-fetch dispatcher, probed PER REQUEST through
            // the reflection layer (the same discipline as the admin routes'
            // typertGateway: adding `connection` to the inject list would keep the
            // whole relay prefix off compositions that lack the service). The
            // connection service's `createSharedFetchHandler('/api').fetch` is the
            // in-process entry to the same exact-fetch route table the browser
            // `/api` transport dispatches through (RT dsh-client-connection
            // lib/index.js ~608-637 — pathname + method lookup over `fetchRoutes`,
            // the registry dsh-client-ui-deliverables' changes routes register
            // into), so a synthetic Request reaches the serving functions directly:
            // no loopback HTTP, no login state. A composition without the service
            // answers the relay route 501 instead. DSH 0.2.1-rc.3: the handler's
            // fetch takes the requesting Peer as a second argument and refuses
            // everything but the owner (a missing peer there throws TypeError,
            // surfacing as a 502 on every relayed /api call) — the dispatcher
            // forwards the cached owner Peer below; pre-rc.3 hosts ignore it.
            const relayPeer = createOwnerPeerSource(() => relayCtx.reflect.get('connection'));
            const getApiFetch = createSharedApiFetchGetter(() => relayCtx.reflect.get('connection'), relayPeer);
            relayCtx.effect(() => {
                // The plugin bridge's loopback facts (PB-3), both read PER REQUEST
                // through the reflection layer: the web server may have restarted on
                // another port or protocol, and the connection service's
                // authenticatedUrl — the token-exchange entry the lan-gate wiring
                // also reads (0.1.1 hosts lack the method entirely) — lives on a
                // service deliberately NOT in this inject's declaration list (same
                // reason as getApiFetch above: adding it would keep the whole relay
                // prefix off compositions that lack it).
                const getLoopbackTarget = () => {
                    const webServer = relayCtx.reflect.get('webServer');
                    const port = typeof webServer?.port === 'number' && webServer.port > 0 ? webServer.port : undefined;
                    if (port === undefined)
                        throw new Error('the web server exposes no loopback port');
                    return { protocol: webServer?.protocol === 'https:' ? 'https:' : 'http:', port };
                };
                const getTokenUrl = () => {
                    const connection = relayCtx.reflect.get('connection');
                    if (typeof connection?.authenticatedUrl !== 'function')
                        return undefined;
                    const { protocol, port } = getLoopbackTarget();
                    return connection.authenticatedUrl(`${protocol}//127.0.0.1:${port}`);
                };
                // One loopback executor for BOTH plugin halves (the HTTP forward and
                // the PB-10 tunnel): a single cookie cache behind two consumers.
                const pluginLoopback = createPluginLoopback({ getTarget: getLoopbackTarget, getTokenUrl });
                const pluginConsent = () => resolveConfig(config, readFileConfig(), process.env).values.pluginBridgeConsent;
                const handler = createRelayHandler({
                    secret: relaySecret,
                    store,
                    gateway: gatewayService,
                    getApiFetch,
                    // DSH 0.2.1-alpha.3: one cached owner/answer Peer for every relay
                    // gateway call — `$events/result` must come from the Peer that
                    // opened `$events`.
                    getPeer: relayPeer,
                    // Subagent reachability (T22c-fix): isAccessible walks the same
                    // child→parent chain the activity tracker keeps fresh.
                    parentOf: parentIndex.parentOf,
                    serverInfo: {
                        serverId: loadServerId(home),
                        // serverName is a volatile row setting ({ get() } wrapped) that
                        // can change without a row restart, so it is recomputed from the
                        // SAME row object apply() received at every handshake — never
                        // snapshotted from the resolveConfig call above.
                        serverName: () => resolveConfig(config, readFileConfig(), process.env).values.serverName,
                        dshVersion: resolveDshVersion(),
                        // The server's interface fingerprints (T42): recomputed at EVERY
                        // handshake, deliberately uncached — the typert loader registers
                        // package by package asynchronously, so a client that
                        // auto-reconnects right after a server restart would otherwise
                        // handshake a half-empty registry and pin those throwaway values
                        // for the row's lifetime. ~7 ms per computation against a full
                        // registry; a failed compute lands as the empty map inside the
                        // relay handler's own guard.
                        fingerprints: () => computeFingerprints(relayCtx),
                        // PB-2: the plugin bridge table, rebuilt FRESH at every handshake
                        // from the PB-1 registry and the row's consent map — both live:
                        // the registry through this apply's own closure, the consent
                        // through resolveConfig on the SAME row object (a volatile field,
                        // read at use time per the hard constraint, never snapshotted).
                        plugins: () => {
                            const consent = resolveConfig(config, readFileConfig(), process.env).values.pluginBridgeConsent;
                            const table = {};
                            for (const declaration of registry.list()) {
                                table[declaration.plugin] = {
                                    version: declaration.version,
                                    digest: declaration.digest,
                                    serverScopeConsent: consent[declaration.plugin] === true,
                                };
                            }
                            return table;
                        },
                    },
                    // PB-3: the forwarding half of the plugin bridge — the registry
                    // this apply built (the zenRemote service's table), the consent
                    // map read LIVE per request (a volatile row field), and the
                    // loopback executor over the wiring's two reflection getters.
                    // PB-10: the WebSocket byte tunnel's server half shares the SAME
                    // loopback (one cookie cache) and the same live consent; its
                    // reachability judgment rides the store directly (the handler's
                    // own isAccessible closure is not visible out here).
                    pluginBridge: {
                        registry,
                        getConsent: pluginConsent,
                        loopback: pluginLoopback,
                        adapters,
                        tunnel: createPluginTunnel({
                            bridge: { registry, getConsent: pluginConsent, loopback: pluginLoopback },
                            getTarget: getLoopbackTarget,
                            isAccessible: (sessionId) => store.isAccessible(sessionId, parentIndex.parentOf),
                            heartbeatMs: 15_000,
                        }),
                    },
                });
                const unregister = relayCtx.webServer.register({
                    kind: 'prefix',
                    path: RELAY_PREFIX,
                    handler,
                });
                // Publish the handler for the admin shares route's viewer counts
                // (T33a2) BEFORE the route is reachable, so no request can hit a
                // mounted route with an unpublished handler.
                relayHandler = handler;
                // A row reload builds a NEW handler over a NEW share table; the open
                // streams of this one would push forever, unreachable by any unshare
                // (T22b-fix) — so the teardown ends them with a server-restart error
                // line before the route itself is unregistered, and the pointer
                // follows (identity-checked: the new handler is already live by the
                // time this old disposer runs).
                return () => {
                    handler.closeAll('plugin row reloaded');
                    unregister();
                    if (relayHandler === handler)
                        relayHandler = undefined;
                };
            }, 'dsh-zen-remote: relay route');
        });
        // The remote-status route lives on BOTH roles (T34-fix): it is what the
        // client-half parts poll, and a desktop app can switch roles without a
        // code path change — on a host it reads the empty
        // `{state:'unpaired', versionMismatch:false, …}` conclusion. The rest of
        // the client prefix does NOT (T41a-fix2): claim / status / reconnect /
        // unshare exist for a client role's pairing surface, and a host answers
        // them 404 (least exposure — the prefix registration stays one route,
        // the handler just refuses everything but remote-status). Same admission
        // wall as the client role's mount.
        ctx.inject(['webServer', 'connection'], (clientCtx) => {
            clientCtx.effect(() => clientCtx.webServer.register({
                kind: 'prefix',
                path: CLIENT_ROUTE_PREFIX,
                handler: createClientHandler({
                    admit: (req) => clientCtx.connection.admit(req),
                    getRowConfig: () => config,
                    remoteStatusOnly: true,
                    getServiceProbe: uploadServiceProbe(clientCtx),
                }),
            }), 'dsh-zen-remote: client routes (host)');
        });
    }
    else {
        // Sub-client half (T16, T23a): pairing claim + connection status, talking to
        // the SERVER's gateway instead of running one. Same admission wall as
        // the admin routes — and, like them, a composition without a connection
        // service (Electron carries none) simply never mounts the routes. The
        // handler keeps the RAW row object: serverUrl / deviceToken are volatile
        // ({ get() } wrapped), so every request reads them live through
        // unwrapVolatile — an apply-time snapshot would go stale the moment the
        // settings page pairs or unpairs.
        //
        // The relay client (T23a) reads the SAME volatile fields live at every
        // request; the address passes the claim route's normalizer, and an
        // address that no longer normalizes counts as missing — a hand-edited
        // row must not receive the pairing token.
        const row = config;
        const relayClient = createRelayClient({
            getServerUrl: () => normalizedRowServerUrl(row),
            getToken: () => {
                const value = unwrapVolatile(row.deviceToken);
                return typeof value === 'string' && value !== '' ? value : undefined;
            },
            // Interface compatibility (T42): after each completed handshake this
            // side computes its OWN fingerprints against THIS process's typert
            // registry (read per call — at creation time the row context may still
            // be assembling), and the relay client stores the group-by-group
            // verdict the status route reports.
            computeOwnFingerprints: () => computeFingerprints(ctx),
        });
        clientRelayClient = relayClient;
        // The plugin bridge's live verdict (PB-2), the CLIENT role's job — a host
        // has no remote sessions of its own to bridge anything into. Computed PER
        // CALL (never a stored conclusion): the local registry is this apply's
        // own closure, the server's table is the LAST handshake's `plugins`
        // (undefined until one succeeded — an old server reads server-too-old),
        // and `online` is the client's CURRENT state — so a registry change, a
        // fresh handshake or a link flip shows up at the very next read.
        const pluginBridgeStatus = () => compareBridges(registry.list(), relayClient.handshakeInfo?.plugins, relayClient.state === 'online');
        // A stopped or reloaded row must not leave a stale instance where the
        // module getter can hand it out (T23a-fix), and its reconnect machinery
        // (T43) must not outlive the row either: stop() cancels the armed retry
        // timer and blocks further scheduling. The identity guard keeps a slow
        // dispose from clearing a NEWER row's instance that a reload already
        // installed.
        ctx.effect(() => () => {
            relayClient.stop();
            if (clientRelayClient === relayClient)
                clientRelayClient = undefined;
        }, 'dsh-zen-remote: relay client disposal');
        // Credentials watch (T43): serverUrl / deviceToken are volatile row
        // fields, and a pairing write (or unpair) commits them WITHOUT a row
        // restart. The loader announces the commit on the row context; the
        // client drops its pending reconnect wait and dials the new credentials
        // immediately. Failure to subscribe degrades to a warning — the ladder
        // and the per-request getters keep working without it.
        // T59 rides the same announcement, and ONLY that announcement (T59-fix):
        // the row's `serverName` is this device's name, and a USER-committed
        // change is forwarded to the gateway's device table — but the event
        // fires for EVERY volatile commit (an unrelated knob, or the settings
        // page's own server-driven follow write arriving at startup), so the
        // listener filters on the changed paths. A push fires only when
        // `serverName` itself moved and differs from the server's record
        // (queueDeviceName's contract) — which is what keeps the follow write
        // from bouncing back and forth. NOT pushed at startup either: the row's
        // loaded name is stale by definition (the server's table may have been
        // edited while we were gone) and an unconditional boot-time push would
        // overwrite an administrator's rename. A rename committed offline and
        // lost to a process exit therefore stays local until the user edits it
        // again — accepted; the server's record wins by default.
        ctx.effect(() => {
            try {
                const off = ctx.on('loader/volatile-update', (paths) => {
                    relayClient.credentialsChanged();
                    if (!volatileUpdateTouchesServerName(paths))
                        return;
                    const name = unwrapVolatile(row.serverName);
                    if (typeof name === 'string' && name.trim() !== '')
                        relayClient.queueDeviceName(name);
                });
                return () => {
                    off();
                };
            }
            catch (error) {
                ctx.logger.warn('dsh-zen-remote: cannot listen on "loader/volatile-update" for relay credentials: %s', message(error));
                return () => { };
            }
        }, 'dsh-zen-remote: relay credentials watcher');
        // One connection attempt at startup (T23a). Failures only log — the
        // status route surfaces the resulting state, and the client's own
        // backoff ladder (T43) takes over from the first failure. An unpaired
        // row is the normal not-configured shape and stays silent.
        void relayClient.connect().catch((error) => {
            if (error instanceof RelayError && error.code === 'unpaired')
                return;
            const code = error instanceof RelayError ? error.code : 'error';
            ctx.logger.warn('dsh-zen-remote relay client initial connect failed (%s): %s', code, message(error));
        });
        // The typertGateway interception (T23b-1): remote-session calls ride the
        // relay, everything else reaches the local gateway untouched. The live
        // diagnostics flow to the client status route through whichever of the
        // two slots is filled — an installed handle, or the shape verdict that
        // REFUSED an install (both belong on the settings surface). A
        // composition without typertGateway (0.1.7 client) leaves both empty and
        // the status answer simply carries no intercept field.
        let interceptHandle;
        let interceptRefused;
        // T62: the browser's current-session report, held here and read live by
        // the intercept (which cannot reach the browser's localStorage — it
        // wraps the backend gateway). Last write wins across windows; until the
        // first report arrives the value is `unavailable` and the intercept
        // keeps its conservative tombstone behavior.
        let reportedCurrentSession = { kind: 'unavailable' };
        const onCurrentSession = (read) => {
            reportedCurrentSession = read;
            // Re-judge NOW — the merger dedupes no-change calls, so a report that
            // carries nothing new costs one compare.
            interceptHandle?.currentSessionChanged();
        };
        const interceptDiagnostics = () => {
            if (interceptHandle !== undefined)
                return interceptHandle.diagnostics();
            if (interceptRefused !== undefined) {
                return { installed: false, shape: interceptRefused, recentFailures: [], incompatibleCalls: [], closedSessions: [] };
            }
            return undefined;
        };
        ctx.inject(['typertGateway'], (gatewayCtx) => {
            // Degraded logging: the real cordis context always carries a logger,
            // but a row fake without one must not crash apply.
            const logWarn = (...args) => { ctx.logger?.warn(...args); };
            const proxy = gatewayCtx.typertGateway;
            const raw = proxy !== null && typeof proxy === 'object'
                ? proxy[symbols.original]
                : undefined;
            if (raw === null || typeof raw !== 'object') {
                interceptRefused = { ok: false, reasons: ['original: typertGateway[symbols.original] is not an object'] };
                logWarn('dsh-zen-remote client intercept not installed: %s', interceptRefused.reasons[0]);
                return;
            }
            // Shape first (spike §4.1): a failed check leaves the gateway exactly
            // as it was — remote features stay off, local behavior is untouched.
            const shape = checkGatewayShape(raw);
            if (!shape.ok) {
                interceptRefused = shape;
                logWarn('dsh-zen-remote client intercept not installed: %s', shape.reasons.join('; '));
                return;
            }
            const handle = installIntercept({
                raw,
                relay: relayClient,
                getServerId: () => relayClient.handshakeInfo?.serverId,
                getCurrentSession: () => reportedCurrentSession,
                log: (format, ...args) => { ctx.logger?.info(`dsh-zen-remote ${format}`, ...args); },
            });
            interceptHandle = handle;
            gatewayCtx.effect(() => () => {
                handle.uninstall();
                if (interceptHandle === handle)
                    interceptHandle = undefined;
            }, 'dsh-zen-remote: typert intercept');
            // Behavior self-check (spike §4.1 check 4) — the shape check proves
            // the constructor still resolves dynamically, this proves the wrap is
            // actually REACHED: one local `workspace/follow` through
            // wireStream.open, whose own payload must enter the wrapper (recognized
            // by identity, not by call counters) and answer a `baseline` first
            // frame with a value.items array. One retry after a pause; only a
            // second failure uninstalls (a half-trusted interception is worse than
            // none). Failure handling lives in runSelfCheck, which records the
            // verdict via noteSelfCheck.
            // DSH 0.2.1-alpha.3: the probe needs an owner Peer of its own (the
            // gateway's operatorPeer fallback is gone) — read `connection` through
            // the reflection layer so a composition without it still installs.
            void runSelfCheck(raw, {
                handle,
                log: logWarn,
                info: (format, ...args) => { ctx.logger?.info(`dsh-zen-remote ${format}`, ...args); },
                getPeer: createOwnerPeerSource(() => gatewayCtx.reflect.get('connection')),
            });
        });
        // The exact-fetch-route interception (T51): the local backend's
        // `/api/session/uploadFileBinary` entry forwards REMOTE sessions'
        // non-image attachments through the relay's binary channel (the
        // browser's Web-Worker upload bypasses window.fetch and the typert
        // gateway entirely — it lands here), and `/api/session.export` refuses
        // virtual ids. Injected on `fileUploads` beside `connection` on purpose:
        // the upload route is registered inside the FileUploads service's
        // CONSTRUCTOR (RT dsh-client-file-upload lib/index.js:171-176), so
        // requiring the service both guarantees the entry exists and skips
        // compositions that have no upload service at all — the same
        // absent-half-loads-anyway posture the typertGateway inject keeps. The
        // diagnostics flow to the client status route like the typert
        // interception's, refused installs included.
        let fetchRouteHandle;
        let fetchRouteRefused;
        const fetchRouteDiagnostics = () => {
            if (fetchRouteHandle !== undefined)
                return fetchRouteHandle.diagnostics();
            if (fetchRouteRefused !== undefined) {
                return {
                    installed: false,
                    shape: fetchRouteRefused,
                    uploadWrapped: false,
                    exportWrapped: false,
                    uploadPending: false,
                    exportPending: false,
                    uploadAttachRefused: undefined,
                    exportAttachRefused: undefined,
                    uploadCalls: 0,
                    uploadForwarded: 0,
                    uploadRefused: 0,
                    exportBlocked: 0,
                    recentFailures: [],
                };
            }
            return undefined;
        };
        fetchRouteDiagnosticsRef = fetchRouteDiagnostics;
        ctx.inject(['connection', 'fileUploads'], (connectionCtx) => {
            fetchRouteInjectSeen = true;
            const logWarn = (...args) => { ctx.logger?.warn(...args); };
            const logInfo = (...args) => { ctx.logger?.info(...args); };
            const proxy = connectionCtx.connection;
            const raw = proxy !== null && typeof proxy === 'object'
                ? proxy[symbols.original]
                : undefined;
            if (raw === null || typeof raw !== 'object') {
                fetchRouteRefused = { ok: false, reasons: ['original: connection[symbols.original] is not an object'] };
                logWarn('dsh-zen-remote fetch-route intercept not installed: %s', fetchRouteRefused.reasons[0]);
                return;
            }
            // Shape first, like the typert wrap: a failed check leaves every route
            // exactly as it was — local uploads untouched, remote uploads keep
            // failing with the honest local error.
            const shape = checkFetchRouteShape(raw);
            if (!shape.ok) {
                fetchRouteRefused = shape;
                logWarn('dsh-zen-remote fetch-route intercept not installed: %s', shape.reasons.join('; '));
                return;
            }
            const handle = installFetchRouteIntercept({
                connection: raw,
                relay: relayClient,
                getServerId: () => relayClient.handshakeInfo?.serverId,
                log: (format, ...args) => { logInfo(`dsh-zen-remote ${format}`, ...args); },
            });
            fetchRouteHandle = handle;
            connectionCtx.effect(() => () => {
                handle.uninstall();
                if (fetchRouteHandle === handle)
                    fetchRouteHandle = undefined;
            }, 'dsh-zen-remote: fetch-route intercept');
        });
        // The plugin bridge's route interception (PB-4): the local webServer's
        // `match` wrap forwarding bridged-plugin requests for REMOTE sessions
        // through the relay. Injected on `webServer` alone — the only service
        // it reads — and the raw instance comes off the reflection layer's
        // symbols lookup, the same face the typert and fetch-route wraps use.
        // The diagnostics flow to the client status route like theirs, refused
        // installs included.
        let pluginRouteHandle;
        let pluginRouteRefused;
        const pluginRouteDiagnostics = () => {
            if (pluginRouteHandle !== undefined)
                return pluginRouteHandle.diagnostics();
            if (pluginRouteRefused !== undefined) {
                return {
                    installed: false,
                    shape: pluginRouteRefused,
                    forwarded: 0,
                    refused: 0,
                    refusalsByReason: {},
                    recentFailures: [],
                    adapterForwarded: 0,
                    adapterResponseRewrites: 0,
                    adapterResponsePassthroughs: 0,
                    tunnelsCurrent: 0,
                    tunnelsOpened: 0,
                    tunnelsClosed: 0,
                };
            }
            return undefined;
        };
        ctx.inject(['webServer'], (wsCtx) => {
            const logWarn = (...args) => { ctx.logger?.warn(...args); };
            const proxy = wsCtx.webServer;
            const raw = proxy !== null && typeof proxy === 'object'
                ? proxy[symbols.original]
                : undefined;
            if (raw === null || typeof raw !== 'object') {
                pluginRouteRefused = { ok: false, reasons: ['original: webServer[symbols.original] is not an object'] };
                logWarn('dsh-zen-remote plugin-route intercept not installed: %s', pluginRouteRefused.reasons[0]);
                return;
            }
            // Shape first, like every wrap: a failed check leaves the webServer
            // exactly as it was — local routing untouched, remote bridging off.
            const shape = checkWebServerShape(raw);
            if (!shape.ok) {
                pluginRouteRefused = shape;
                logWarn('dsh-zen-remote plugin-route intercept not installed: %s', shape.reasons.join('; '));
                return;
            }
            const handle = installPluginRouteIntercept({
                webServer: raw,
                registry,
                relay: relayClient,
                getServerId: () => relayClient.handshakeInfo?.serverId,
                getStatus: pluginBridgeStatus,
                adapters,
                // PB-12: the browser's currently open session — a VIRTUAL id means
                // a remote panel is the request's origin, the signal the adapter
                // routes' deny hooks read (better-sidebar's open.external carries
                // no session field of its own).
                getCurrentSession: () => (reportedCurrentSession.kind === 'open' ? reportedCurrentSession.sessionId : undefined),
                log: (format, ...args) => { ctx.logger?.info(`dsh-zen-remote ${format}`, ...args); },
            });
            pluginRouteHandle = handle;
            wsCtx.effect(() => () => {
                handle.uninstall();
                if (pluginRouteHandle === handle)
                    pluginRouteHandle = undefined;
            }, 'dsh-zen-remote: plugin route intercept');
        });
        ctx.inject(['webServer', 'connection'], (clientCtx) => {
            clientCtx.effect(() => clientCtx.webServer.register({
                kind: 'prefix',
                path: CLIENT_ROUTE_PREFIX,
                handler: createClientHandler({
                    admit: (req) => clientCtx.connection.admit(req),
                    getRowConfig: () => config,
                    getRelayClient: () => relayClient,
                    getIntercept: interceptDiagnostics,
                    getFetchRouteIntercept: fetchRouteDiagnostics,
                    getServiceProbe: uploadServiceProbe(clientCtx),
                    getPluginRouteIntercept: pluginRouteDiagnostics,
                    getPluginBridgeStatus: pluginBridgeStatus,
                    onCurrentSession,
                }),
            }), 'dsh-zen-remote: client routes');
        });
    }
    // Restart watcher (T17 + T17b), both roles: every Config field is volatile
    // (the settings surface would not exist otherwise), so the restart-required
    // fields are watched by fingerprint instead — when their resolved values
    // (row, lan-gate.config.json, or environment — all re-read per trigger)
    // move, the plugin row reloads through cordis and apply() runs again,
    // restarting the gateway child and push half with it. Two triggers share
    // the one fire-at-most-once guard: the 2s poll (the fallback for the
    // layers a settings save never touches — lan-gate.config.json and the
    // LAN_GATE_* / DSH_PUSH_* environment) and, immediately, the loader's
    // `loader/volatile-update` event: DSH 0.2.0 commits a volatile-only
    // settings change WITHOUT restarting the row and announces it on the row
    // context (`fiber.ctx.emit(self, "loader/volatile-update", paths)`, the
    // listener filter being `owner.fiber === fiber` — verified in
    // cordis-plugin-loader/lib/index.js of loader 1.0.5 / DSH 0.2.0-rc.1,
    // ~line 420). Subscribing here on the row context receives exactly this
    // row's updates, so a saved restart-required field reloads the row within
    // the same tick instead of waiting out the poll. ctx.fiber is the row's
    // own Fiber (cordis 4.0.4 assigns it in the Fiber constructor: `this.ctx =
    // parent.extend({ fiber: this })`), and restart() is its public
    // dispose-and-reload entry. A fake context without a fiber (the route
    // tests) only ever reaches the warn.
    const reload = () => {
        const fiber = ctx.fiber;
        if (fiber?.restart === undefined) {
            ctx.logger.warn('dsh-zen-remote: a restart-required setting changed, but no fiber is available to reload the plugin row');
            return;
        }
        try {
            Promise.resolve(fiber.restart()).catch((error) => {
                ctx.logger.warn('dsh-zen-remote: plugin row reload failed: %s', message(error));
            });
        }
        catch (error) {
            ctx.logger.warn('dsh-zen-remote: plugin row reload failed: %s', message(error));
        }
    };
    ctx.effect(() => {
        const watcher = startRestartWatcher({
            getValues: () => resolveConfig(config, readFileConfig(), process.env).values,
            onChange: reload,
        });
        // Registration failure degrades to a warning, like the session feeds
        // above: the poll trigger keeps the watcher fully functional without it.
        try {
            ctx.on('loader/volatile-update', () => { watcher.checkNow(); });
        }
        catch (error) {
            ctx.logger.warn('dsh-zen-remote: cannot listen on "loader/volatile-update": %s', message(error));
        }
        return watcher.stop;
    }, 'dsh-zen-remote: restart watcher');
    // The upload route carries the T17 admission wall too: webServer routes
    // skip DSH's /api authentication, so without the connection service's
    // admit this 1.x-era route was the one unauthenticated write path left. A
    // composition without connection (Electron carries none) mounts nothing.
    // maxBytes is NOT captured here: `maxUploadBytes` is a volatile row field
    // ({ get() } wrapped), so the cap is re-read from the SAME row object per
    // request — an edit applies without waiting for a row reload. A stored
    // value that is not a positive finite number falls to the shipped default,
    // the same junk-in/shipped-default rule the keyboard knobs follow.
    ctx.inject(['webServer', 'sessions', 'connection'], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register({
            kind: 'exact',
            path: UPLOAD_ROUTE,
            handler: (req, res) => {
                const rawMax = unwrapVolatile(config.maxUploadBytes);
                const maxBytes = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
                    ? rawMax
                    : DEFAULT_MAX_UPLOAD_BYTES;
                // Returned, not fire-and-forget: handleUpload owns res end to end,
                // and a rejection escaping it must reach webServer's unified error
                // handling instead of vanishing into an unhandled rejection (T17b
                // restored the await-shaped contract the route used to have).
                return handleUpload(webCtx, maxBytes, req, res, (admitReq) => webCtx.connection.admit(admitReq));
            },
        }), 'dsh-mobile-nav: upload route');
    });
    // Needs only the webServer: the client-config route must exist even in a
    // composition without live sessions — and it is the settings page's
    // fallback role probe (T17): when the row snapshot cannot answer the saved
    // role (role only in lan-gate.config.json), this route reports the
    // EFFECTIVE one. Every displayed knob is re-read from the SAME row object
    // per request through unwrapVolatile, so an edit lands without waiting for
    // a row reload.
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
                    role: resolveConfig(config, readFileConfig(), process.env).values.role,
                    turnFoldDesktop: unwrapVolatile(config.turnFoldDesktop) === true,
                    ...clamped('keyboardLiftRatio', unwrapVolatile(config.keyboardLiftRatio), 0, 1),
                    ...clamped('keyboardLiftMaxPx', unwrapVolatile(config.keyboardLiftMaxPx), 0, 2000),
                    ...clamped('keyboardSafetyPadPx', unwrapVolatile(config.keyboardSafetyPadPx), 0, 200),
                });
            },
        }), 'dsh-mobile-nav: client config route');
    });
    // Share-image transcript route (issue #7): needs the sessionQuery service
    // every standard dsh-base composition provides, plus the connection
    // service for the T17 admission wall (same as the upload route: without
    // admit this 1.x-era route answered unauthenticated reads of any session's
    // transcript). Injected lazily like the routes above, so a composition
    // without them (Electron carries neither webServer nor sessionQuery)
    // simply never mounts the route — the browser half's fetch then 404s into
    // its "needs full DSH" message.
    ctx.inject(['webServer', 'sessionQuery', 'connection'], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register({
            kind: 'exact',
            path: SHARE_EXPORT_ROUTE,
            handler: (req, res) => handleShareExport(webCtx, req, res, (admitReq) => webCtx.connection.admit(admitReq)),
        }), 'dsh-mobile-nav: share export route');
    });
}
//# sourceMappingURL=index.js.map