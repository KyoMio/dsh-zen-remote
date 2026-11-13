/**
 * Sub-client backend routes (T16): pairing claim and connection status for a
 * DSH process running `role: 'client'` — this machine's settings page is the
 * ONLY browser surface that talks to them, same-origin like the host's admin
 * routes (T14). The claim route forwards the pairing code to the SERVER's
 * gateway (`<serverUrl>/lan-gate/pair/claim-desktop`) and hands the returned
 * token straight back to the browser, which writes it into the row's
 * `deviceToken` secret field; this process itself never persists or logs the
 * token — it only ever puts it into an Authorization header for the status
 * probe. The status route reads `serverUrl` / `deviceToken` from the plugin
 * ROW PER REQUEST (both are volatile `{ get() }`-wrapped fields, so the row
 * object `apply()` received is the only live source) and probes the server's
 * relay ping, reporting one of the five connection states.
 *
 * Same walls as the admin routes, in the same order: `admit` first (webServer
 * routes skip DSH's /api authentication), then for the POST also the
 * same-origin gate and a 16 KiB JSON-object body cap. Built by a factory so
 * the tests drive it over a real socket with a mock server gateway.
 *
 * T41b adds the plain-HTTP relay under `client/http/<route>`: the GETs the
 * browser fetch wrapper intercepted (`/api/changes.summary` / `changes.diff`
 * naming a virtual session id) are re-issued here through the relay client's
 * `http()` with the original id restored, and the upstream status,
 * content type and body travel back verbatim.
 */
import { homedir } from 'node:os';
import { classifyClaimResponse, classifyProbe, CLAIM_PATH, normalizeServerUrl, RELAY_PING_PATH } from './client-pairing.js';
import { readFileConfig, resolveConfig, unwrapVolatile } from './config.js';
import { assembleDebugReport } from './debug-report.js';
import { buildKeylessInviteUri, isLoopbackOrPrivateHostname, parseGatewayJoinInput } from './peer/crypto.js';
import { responseJson, sameOriginPost } from './http.js';
import { RELAY_HTTP_ROUTES } from './relay-access.js';
import { relayCredentialsDigest, RelayError } from './relay-client.js';
import { MAX_PAIRED_SERVERS } from './relay-pool.js';
import { resolveDshVersion } from './relay-server.js';
import { fromVirtual } from './virtual-id.js';
/** Prefix all client routes live under (one webServer prefix registration). */
export const CLIENT_ROUTE_PREFIX = '/_dsh/zen-remote/client';
/** POST `{serverUrl, code, name}`: redeem a desktop pairing code. */
export const CLIENT_CLAIM_ROUTE = `${CLIENT_ROUTE_PREFIX}/claim`;
/** GET: the current connection state (never carries the token). */
export const CLIENT_STATUS_ROUTE = `${CLIENT_ROUTE_PREFIX}/status`;
/** POST: one immediate reconnect attempt (T43, the settings page's 立即重连);
 * answered 409 unless the relay client is currently `offline`. */
export const CLIENT_RECONNECT_ROUTE = `${CLIENT_ROUTE_PREFIX}/reconnect`;
/** POST: the browser's NETWORK-RESTORED hint.
 *
 * Why this route exists: the host half runs in a plain Node process with no
 * OS network events, and the browser half cannot touch the relay client's
 * memory across the HTTP boundary. So the browser — the only place that can
 * observe `online`/`visibilitychange` — reports the hint here, and the host
 * turns it into ONE controlled probe + reconnect.
 *
 * Deliberately narrower than `reconnect`:
 *  - it first runs `probeHealth()` (authenticated GET /ping); a hint NEVER
 *    alone proves the link is back (`navigator.onLine === true` is not
 *    evidence);
 *  - only a successful probe advances to `networkRestored()`, which itself
 *    refuses outside `offline` and inside its 3s anti-storm gap;
 *  - it answers the probe outcome so the page can log/annotate it.
 *
 * It NEVER changes state by itself: `probeHealth` is read-only, and
 * `networkRestored` is the same controlled path the settings button uses. */
export const CLIENT_NETWORK_HINT_ROUTE = `${CLIENT_ROUTE_PREFIX}/network-hint`;
/** GET: the remote-session status the T34 client parts render from (T34) —
 * the relay's serving state, the interface-compatibility verdict, the
 * handshake's server name, and the closed-session map. The prefix is
 * registered on BOTH roles (T34-fix): a host — no relay client wired —
 * answers the empty `{state:'unpaired', versionMismatch:false, serverName:'',
 * closed:{}}` conclusion. It carries no token and no server address. */
export const CLIENT_REMOTE_STATUS_ROUTE = `${CLIENT_ROUTE_PREFIX}/remote-status`;
/** GET: the redacted diagnostic report (CU-3, SPEC 方案 C) — `_meta`,
 * `config`, `status`, optional `gateway`, `logs` plates, assembled by
 * {@link assembleDebugReport} and safe to paste into a GitHub issue. Mounted
 * on BOTH roles (each answers its own report); a request that arrived
 * through the gateway is refused BEFORE dispatch (the wizard's via wall) —
 * diagnostics are a machine-local export, and the gateway must never be able
 * to fetch this machine's report for its own device table either. */
export const CLIENT_DEBUG_REPORT_ROUTE = `${CLIENT_ROUTE_PREFIX}/debug-report`;
/** POST `{sessionId: <虚拟 id>}`: close one remote session from THIS machine
 * (T34) — the backend forwards the ORIGINAL id through the relay's
 * `POST relay/v1/unshare`, so the server closes it with reason `'client'`. */
export const CLIENT_UNSHARE_ROUTE = `${CLIENT_ROUTE_PREFIX}/unshare`;
/** POST `{sessionId: string | null}`: the browser's report of which session
 * the host UI currently has open (T62) — the intercept layer runs in this
 * backend process and cannot read the browser's localStorage itself. `null`
 * means a readable signal says nothing is open; the sink stores the value
 * and re-judges the mergers immediately. */
export const CLIENT_CURRENT_SESSION_ROUTE = `${CLIENT_ROUTE_PREFIX}/current-session`;
/** POST `{entryId?: string, all?: boolean}` (MS-5): remove one paired server
 * by its entry id, or every paired server at once (`all: true`). The paired
 * list lives in `zen-remote-state.json`; this route goes through the pool so
 * the live clients stop with their records. Pool-mode only — a mount without
 * a pool has no paired list to edit and answers the unknown-path 404. */
export const CLIENT_UNPAIR_ROUTE = `${CLIENT_ROUTE_PREFIX}/unpair`;
/** Prefix of the peer-role management routes (PG-9). All of them sit behind
 * the same walls as the rest of the prefix, PLUS the via-marker wall before
 * dispatch: a request wearing the gateway's marker came from a remote
 * device, and NO remote device may read or write this machine's peer state.
 * The POSTs additionally run the same-origin gate; every answer is free of
 * key material (`privateKeyHex`, the invite's `joinKey`). */
export const CLIENT_PEER_PREFIX = `${CLIENT_ROUTE_PREFIX}/peer`;
/** GET: the peer engine's snapshot — this machine's node id, the gateway
 * admission state, the joined network's id + HTTP origin, the announced
 * device cap and one row per network device with its view path
 * (`lan` / `p2p` / `relay` / `mismatch` / `offline`). */
export const CLIENT_PEER_STATUS_ROUTE = `${CLIENT_PEER_PREFIX}/status`;
/** POST `{inviteUri}`: join a network by pasting its `zr-net(s)://…` invite.
 * The engine's refusal keeps its code as a 400. */
export const CLIENT_PEER_JOIN_ROUTE = `${CLIENT_PEER_PREFIX}/join`;
/** POST `{}`: leave the current network (unmount everything, close the WS,
 * clear the persisted membership). */
export const CLIENT_PEER_LEAVE_ROUTE = `${CLIENT_PEER_PREFIX}/leave`;
/** POST `{nodeId, mounted}`: mount or ignore one network device's shared
 * sessions (forwards to `peerEngine.setNodeDisabled(nodeId, !mounted)`). */
export const CLIENT_PEER_TOGGLE_MOUNT_ROUTE = `${CLIENT_PEER_PREFIX}/toggle-mount`;
/** POST `{nodeId}`: explicit local confirmation to trust a peer's NEW public
 * key after a `mismatch` verdict (`peerEngine.trustPeer`). */
export const CLIENT_PEER_TRUST_ROUTE = `${CLIENT_PEER_PREFIX}/trust`;
/** POST `{}`: re-run the UDP hole-punch for every eligible device. */
export const CLIENT_PEER_REPROBE_ROUTE = `${CLIENT_PEER_PREFIX}/reprobe`;
/** Longest `sessionId` the current-session route accepts (T62): real ids —
 * a local `session-<uuid>` or a `zr~<serverId>~<id>` virtual id — are far
 * shorter; the cap bounds garbage, not reality. */
const MAX_CURRENT_SESSION_ID = 512;
/** Prefix of the plain-HTTP relay routes (T41b):
 * `GET ${CLIENT_HTTP_ROUTE_PREFIX}<route>?<query>` relays one intercepted
 * `/api/<route>` call (the fetch wrapper's rewrites land here) to the
 * server, with the virtual session id swapped back to the original. */
export const CLIENT_HTTP_ROUTE_PREFIX = `${CLIENT_ROUTE_PREFIX}/http/`;
/** Longest wait for one pairing round-trip to the server's gateway. */
const CLAIM_TIMEOUT_MS = 10_000;
/** Longest wait for one connection probe. */
const PROBE_TIMEOUT_MS = 5_000;
/** Inbound claim body cap — the settings form sends a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024;
/**
 * One refusal this module raises on purpose, carrying the status and code the
 * browser should see.
 *
 * Fields are assigned in the body rather than declared as constructor
 * parameter properties: check scripts import these modules through Node's
 * strip-only type stripping, which rejects that syntax (same reason as
 * UploadError in index.ts and AdminError in admin-routes.ts).
 */
class ClientRouteError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.name = 'ClientRouteError';
        this.status = status;
        this.code = code;
    }
}
/**
 * Read the whole body under the cap and demand one JSON object. Same contract
 * as the admin routes' reader: an empty body counts as `{}`, a declared
 * oversized body length is refused before a byte is read, and the streaming
 * cap stays as the chunked-body guard.
 */
async function readJsonBody(req) {
    const declared = req.headers['content-length'];
    const expected = declared === undefined ? undefined : Number(declared);
    if (expected !== undefined && Number.isSafeInteger(expected) && expected > MAX_BODY_BYTES) {
        throw new ClientRouteError(400, 'bad-request', `request body exceeds the ${MAX_BODY_BYTES}-byte limit`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES)
            throw new ClientRouteError(400, 'bad-request', `request body exceeds the ${MAX_BODY_BYTES}-byte limit`);
        chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '')
        return {};
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new ClientRouteError(400, 'bad-request', 'request body must be valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ClientRouteError(400, 'bad-request', 'request body must be a JSON object');
    }
    return parsed;
}
function stringOrEmpty(value) {
    return typeof value === 'string' ? value : '';
}
/**
 * Write one relayed upstream answer (T41b): the underlying `/api` route's
 * status with its body as received, and a content type held to JSON — the
 * two registered routes answer JSON, and a compromised server must not land
 * a scriptable type (`text/html`) on this same-origin browser path (T41b-fix),
 * so anything else downgrades to inert `text/plain`. `nosniff` backs the
 * downgrade up, and the no-store discipline every route here answers with.
 */
function respondUpstream(res, result) {
    const bytes = Buffer.from(result.body, 'utf8');
    const mediaType = result.contentType?.split(';', 1)[0]?.trim().toLowerCase();
    const contentType = mediaType === 'application/json' && result.contentType !== undefined ? result.contentType : 'text/plain; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.writeHead(result.status);
    res.end(bytes);
}
/**
 * Map one relay failure onto the plain-HTTP answer (T41b): the four
 * link-level codes mean "the server chain is not usable" (503
 * `remote-offline`); a refusal the relay route itself answered keeps ITS
 * status and code (an unshared session is the relay's 403 `not-shared`,
 * verbatim); anything else is a bug and answers a bare 502.
 */
function respondRelayFailure(res, error) {
    if (error instanceof RelayError) {
        if (error.code === 'offline' || error.code === 'unpaired' || error.code === 'revoked' || error.code === 'incompatible') {
            responseJson(res, 503, { ok: false, error: { code: 'remote-offline' } });
            return;
        }
        if (error.status !== undefined && error.status >= 400 && error.status <= 599) {
            responseJson(res, error.status, { ok: false, error: { code: error.code } });
            return;
        }
    }
    responseJson(res, 502, { ok: false, error: { code: 'internal' } });
}
/** One probe of the server's relay ping with the row's token. Only the
 * Authorization header ever sees the token. */
async function probe(fetchImpl, serverUrl, token) {
    let response;
    try {
        response = await fetchImpl(serverUrl.replace(/\/+$/u, '') + RELAY_PING_PATH, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}` },
            // A wrong server must not walk the probe through a redirect chain.
            redirect: 'manual',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
    }
    catch {
        return classifyProbe({ kind: 'error' });
    }
    const text = await response.text().catch(() => undefined);
    let body;
    if (text !== undefined) {
        try {
            body = JSON.parse(text);
        }
        catch {
            body = undefined;
        }
    }
    return classifyProbe({ kind: 'response', status: response.status, body });
}
/** Relay one classified claim outcome to the browser. The success envelope
 * additionally echoes the NORMALIZED address — the exact string this route
 * validated, so the browser writes back what the backend approved. */
function respondClaim(res, outcome, serverUrl) {
    if (outcome.ok) {
        responseJson(res, 200, { ...outcome, serverUrl });
        return;
    }
    responseJson(res, 200, outcome);
}
/**
 * Map one relay failure onto the status vocabulary (T23a-fix, extended by
 * T43): ONLY the gateway's unpaired wall is `revoked`. A server that refuses
 * the relay prefix or speaks another protocol version answers
 * `incompatible` — the settings page renders it with its own "upgrade both
 * ends" copy. The relay route's own 401 `relay-unauthorized` is a
 * server-side secret fault, and every other odd shape lands in `unexpected`
 * — never in a verdict that would unpair a validly-paired device. Transport
 * death is `unreachable`.
 */
function probeStateOfRelayError(error) {
    if (error instanceof RelayError) {
        if (error.code === 'revoked')
            return 'revoked';
        if (error.code === 'offline')
            return 'unreachable';
        if (error.code === 'unpaired')
            return 'unpaired';
        if (error.code === 'incompatible')
            return 'incompatible';
    }
    return 'unexpected';
}
/**
 * The online status body (T59): the handshake facts plus the device's own
 * name — the SERVER's record of this device (T59), which the settings page
 * follows into the row while the user is not mid-edit. Absent from an older
 * relay client (no handshake field) and then the body carries it as '' —
 * the settings page treats empty as "nothing to follow". While a
 * locally-pushed rename is queued or in flight the name is FORCED empty
 * (T59-fix): the answer could predate the push, and a page that followed it
 * would bounce the user's fresh save back to the old name.
 */
function deviceStatusBody(state, info, serverUrl, deviceNameSyncing) {
    return {
        state,
        serverName: info.serverName,
        serverUrl,
        deviceName: !deviceNameSyncing && typeof info.deviceName === 'string' ? info.deviceName : '',
    };
}
/**
 * One live handshake bounded by the probe timeout. An abandoned connect
 * keeps running in the background — its result lands in the relay client's
 * state and digest either way — but the status answer never waits longer
 * than a probe would have.
 */
async function withProbeTimeout(promise) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new RelayError('offline', `no handshake within ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
                if (typeof timer.unref === 'function')
                    timer.unref();
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * The relay client's live state in the `remote-status` vocabulary (T34):
 * `connecting` and `incompatible` report as `offline` — both are "the link
 * is not serving, recovery pending" as far as a remote session is concerned.
 * No relay client wired (a host role) is `unpaired`, the honest "no
 * connection configured".
 */
function remoteStatusStateOf(relay) {
    if (relay === undefined)
        return 'unpaired';
    switch (relay.state) {
        case 'online':
            return 'online';
        case 'revoked':
            return 'revoked';
        case 'unpaired':
            return 'unpaired';
        default:
            return 'offline';
    }
}
/**
 * The diagnostics decorator shared by the single-client and pool status
 * bodies (CU-3's extraction, extended by MS-5): every interception getter is
 * read live per call, and the compat verdict rides whenever there is
 * something to report — from `compatRelay`'s last handshake (the single
 * client, or in pool mode the FIRST entry's client) or from the interceptor's
 * incompatible-call ring. `pluginBridgeOverride` replaces the single-client
 * verdict source in pool mode (the first entry's per-server verdicts, keeping
 * the top-level field's shape).
 */
function diagnosticsDecorator(options, compatRelay, pluginBridgeOverride) {
    const intercept = options.getIntercept?.();
    const fetchRouteIntercept = options.getFetchRouteIntercept?.();
    const serviceProbe = options.getServiceProbe?.();
    const pluginRouteIntercept = options.getPluginRouteIntercept?.();
    const compat = compatRelay?.compat !== undefined || (intercept?.incompatibleCalls.length ?? 0) > 0
        ? {
            identical: compatRelay?.compat?.identical ?? [],
            different: compatRelay?.compat?.different ?? [],
            unavailable: compatRelay?.compat?.unavailable ?? [],
            incompatibleCalls: intercept?.incompatibleCalls ?? [],
        }
        : undefined;
    return (body) => {
        // PB-2: the per-plugin bridge verdict rides EVERY status answer —
        // the settings surface explains a not-bridged plugin whatever the
        // connection state (unpaired reads all-offline, the honest verdict).
        let next = { ...body, pluginBridge: pluginBridgeOverride ?? options.getPluginBridgeStatus?.() ?? [] };
        if (intercept !== undefined)
            next = { ...next, intercept };
        if (fetchRouteIntercept !== undefined)
            next = { ...next, fetchRouteIntercept };
        if (serviceProbe !== undefined)
            next = { ...next, serviceProbe };
        if (pluginRouteIntercept !== undefined)
            next = { ...next, pluginRouteIntercept };
        return compat === undefined ? next : { ...next, compat };
    };
}
/**
 * One pool entry's per-server status row (MS-5): the live client facts and
 * the entry's own identity — NEVER the token, which the route never even
 * sees (it lives in the state file, behind the pool). `compat` appears only
 * once that client has a handshake verdict to report; `pluginBridge` comes
 * from the per-server verdict getter ([] unwired).
 */
function poolServerStatus(entry, options) {
    const client = entry.client;
    const body = {
        entryId: entry.entryId,
        serverId: entry.serverId,
        serverUrl: entry.serverUrl,
        serverName: entry.serverName ?? '',
        displayName: entry.displayName,
        state: client.state,
        nextRetryAt: client.nextRetryAt ?? null,
        ...(client.lastError !== undefined ? { lastError: client.lastError } : {}),
        ...(client.compat !== undefined
            ? { compat: { identical: client.compat.identical, different: client.compat.different, unavailable: client.compat.unavailable } }
            : {}),
        pluginBridge: options.getPluginBridgeStatusForServer?.(entry.serverId, client) ?? [],
    };
    return body;
}
/**
 * The EFFECTIVE pairing cap for a pool-mode mount (PG-2-fix): the pool's own
 * `maxServers()` is the one synthesis point that folds the peer mode's
 * network-reported `maxPeersFromGateway` into the configured value, and
 * `pool.pair()` enforces exactly that number — so the status body and the
 * claim pre-check must read the SAME source, not the raw config value (two
 * truths would let the pre-check admit what pair refuses, or the reverse).
 * The live config getter (then the historic constant) answers only when
 * there is no pool, or the pool predates the getter (test stubs).
 */
function effectiveMaxServers(pool, options) {
    if (pool !== undefined && typeof pool.maxServers === 'function')
        return pool.maxServers();
    return options.getMaxServers?.() ?? MAX_PAIRED_SERVERS;
}
/**
 * The POOL status body (MS-5): the paired list is the truth — the row's
 * serverUrl/deviceToken are never consulted. The top level keeps the FIRST
 * entry's compatibility fields (the old single-server page keeps rendering)
 * and every entry reports as one `servers` row; `maxServers` names the
 * EFFECTIVE cap — the pool's own synthesis (PG-2-fix), the same number
 * `pool.pair()` enforces. An empty pool answers `unpaired` — the honest
 * "nothing paired".
 */
async function poolStatusBodyOf(options) {
    const pool = options.pool;
    const entries = pool.entries();
    const first = entries[0];
    const bridgeOverride = first !== undefined
        ? options.getPluginBridgeStatusForServer?.(first.serverId, first.client) ?? []
        : [];
    const withDiagnostics = diagnosticsDecorator(options, first?.client, bridgeOverride);
    const servers = entries.map((entry) => poolServerStatus(entry, options));
    const maxServers = effectiveMaxServers(pool, options);
    if (first === undefined) {
        return withDiagnostics({ state: 'unpaired', maxServers, servers });
    }
    const body = deviceStatusBody(first.client.state, { serverName: first.serverName ?? '', deviceName: first.client.handshakeInfo?.deviceName }, first.serverUrl, first.client.deviceNameSyncing);
    if (first.client.nextRetryAt !== null && first.client.nextRetryAt !== undefined)
        body.nextRetryAt = first.client.nextRetryAt;
    if (first.client.lastError !== undefined)
        body.lastError = first.client.lastError;
    return withDiagnostics({ ...body, maxServers, servers });
}
/**
 * One network device's view path (PG-9): the engine's internal state/path
 * words mapped onto the four the settings page renders. A local TOFU
 * mismatch is `mismatch`; a user-disabled device has no sessions to speak
 * of, so it reads `offline`; an eligible device whose UDP/relay path is not
 * up yet also reads `offline` (honest — nothing flows).
 */
function peerViewPath(state, path) {
    if (state === 'identity-mismatch')
        return 'mismatch';
    if (state === 'disabled')
        return 'offline';
    if (path === 'lan' || path === 'p2p' || path === 'relay')
        return path;
    return 'offline';
}
/** The reason word for every non-authorized gateway verdict: the admission
 * fact itself, prefixed so the field is self-describing downstream. */
const PEER_GATEWAY_SYNC_REASONS = {
    'connecting': 'gateway-connecting',
    'pending-approval': 'gateway-pending-approval',
    'mismatch': 'gateway-mismatch',
    'paused': 'gateway-paused',
    'revoked': 'gateway-revoked',
    'offline': 'gateway-offline',
};
/**
 * The peer/status body's additive `sync` object (PC-14a): the structured
 * readiness facts the third wizard light (and any future UI/CLI surface)
 * renders from, derived from the SAME engine snapshot and the SAME pool the
 * rest of the body reads — never a second discovery state machine. No pool
 * (or one that cannot answer entry lookups — an old test double) means no
 * honest readiness fact: the field stays absent rather than guessing.
 *
 * The counting walks the engine's members and tracks each candidate's REAL
 * mount through `mountVirtual`'s entryId seam (= the peer nodeId), demanding
 * the pool's virtual flag: an old client pairing whose handshake happens to
 * carry the same serverId word shares only the SHAPE (record ids are
 * `randomBytes(4).hex`) and must never impersonate the mount. A candidate
 * without a real mount is counted in `unmountedCount` and can never count
 * ready — fix1: the reason stays the NEUTRAL `peers-not-mounted`, because a
 * fresh announcement, a pending punch, a full cap or a failed mount all look
 * identical to this snapshot and no cap-vs-occupancy proof runs here (the
 * capacity story stays with the body's own PC-11a fields). Actively ignored
 * devices are excluded from the candidates but keep their own count; a local
 * TOFU mismatch blocks the whole verdict.
 *
 * `ready` speaks ONLY of the remote handshake having completed on every
 * candidate mount (`client.state === 'online'`) — an empty shared-session
 * list is perfectly ready. There is deliberately no `synced` fact: nothing
 * in the engine or pool observes a concrete session data transfer completing.
 */
function peerSyncBodyOf(status, pool) {
    if (pool === undefined)
        return undefined;
    if (typeof pool.getByEntryId !== 'function' || typeof pool.isVirtual !== 'function')
        return undefined;
    let readyCount = 0;
    let candidateCount = 0;
    let unmountedCount = 0;
    let ignoredCount = 0;
    let mismatchCount = 0;
    for (const peer of status.peers) {
        if (peer.state === 'identity-mismatch') {
            mismatchCount += 1;
            continue;
        }
        if (peer.state === 'disabled') {
            ignoredCount += 1;
            continue;
        }
        candidateCount += 1;
        const view = peer.mounted ? pool.getByEntryId(peer.nodeId) : undefined;
        if (view === undefined || !pool.isVirtual(peer.nodeId)) {
            unmountedCount += 1;
            continue;
        }
        if (view.client.state === 'online')
            readyCount += 1;
    }
    let state;
    let reason;
    if (status.networkId === null || status.gatewayState === 'unconfigured') {
        state = 'unconfigured';
        reason = 'unconfigured';
    }
    else if (status.gatewayState !== 'authorized') {
        // The gateway admission fact gates the verdict: a stale online client
        // from before the WS died must never read as ready. The counts stay
        // honest; the state carries the real reason word.
        state = 'not-ready';
        reason = PEER_GATEWAY_SYNC_REASONS[status.gatewayState] ?? 'gateway-offline';
    }
    else if (mismatchCount > 0) {
        state = 'blocked';
        reason = 'identity-mismatch';
    }
    else if (candidateCount === 0 && ignoredCount > 0) {
        state = 'ignored';
        reason = 'ignored';
    }
    else if (candidateCount === 0) {
        state = 'waiting-peers';
        reason = 'waiting-peers';
    }
    else if (readyCount === candidateCount) {
        state = 'ready';
        reason = 'ok';
    }
    else if (readyCount === 0) {
        state = 'not-ready';
        // fix1: unmounted covers a fresh announcement, a pending punch, a full
        // cap or a failed mount alike — the neutral word only, no capacity claim.
        reason = unmountedCount > 0 ? 'peers-not-mounted' : 'peers-not-online';
    }
    else {
        state = 'partial';
        reason = unmountedCount > 0 ? 'peers-not-mounted' : 'peers-partial';
    }
    return { state, readyCount, candidateCount, unmountedCount, ignoredCount, mismatchCount, reason };
}
function peerStatusBodyOf(engine, options) {
    const status = engine.status();
    const peers = status.peers.map((peer) => ({
        nodeId: peer.nodeId,
        name: peer.name,
        mounted: peer.mounted,
        path: peerViewPath(peer.state, peer.path),
        rttMs: peer.rttMs,
    }));
    const gatewayOrigin = options.getPeerNetworkOrigin?.();
    const maxServers = effectiveMaxServers(options.pool, options);
    const mountedCount = status.peers.filter((peer) => peer.mounted).length;
    const sync = peerSyncBodyOf(status, options.pool);
    return {
        configured: status.networkId !== null,
        nodeId: status.nodeId,
        gatewayState: status.gatewayState,
        ...(typeof status.deniedReason === 'string' && status.deniedReason !== '' ? { deniedReason: status.deniedReason } : {}),
        ...(status.networkId !== null ? { networkId: status.networkId } : {}),
        ...(gatewayOrigin !== undefined && status.networkId !== null ? { gatewayOrigin } : {}),
        maxPeers: status.maxPeers,
        maxServers,
        mountedCount,
        limitReached: mountedCount >= maxServers,
        peers,
        ...(sync !== undefined ? { sync } : {}),
    };
}
/**
 * The status route's body, computed exactly as the CLIENT_STATUS_ROUTE
 * branch always has — extracted (CU-3) so the debug-report route can embed
 * the same diagnostics aggregation without a second implementation. All
 * reads are live per call: volatile row fields, the interception getters,
 * the relay client's current state. May await one bounded probe or connect
 * (never longer than the probe timeout). In pool mode the paired list is
 * the truth instead ({@link poolStatusBodyOf}); the row is not consulted.
 */
async function statusBodyOf(options) {
    const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    if (options.pool !== undefined)
        return poolStatusBodyOf(options);
    // The typert interception's view (T23b-1) rides on EVERY status
    // answer, whatever the connection state — the settings surface needs
    // it to explain a refused install even while unpaired. The interface
    // compat verdict (T42) appears once there is something to report: a
    // stored comparison from the relay client's last handshake, or any
    // incompatible call the interceptor recorded. Absent otherwise —
    // nothing to show, and the settings block presence-gates on exactly
    // that.
    const compatRelay = options.getRelayClient?.();
    const withDiagnostics = diagnosticsDecorator(options, compatRelay);
    // The ROW decides its own two shapes first, per request (both fields
    // are volatile { get() } wrappers — only the row object apply()
    // received is a live source): without both credentials nothing is
    // paired, and a stored address that no longer normalizes must never
    // see the token (T16-fix).
    const row = options.getRowConfig();
    const record = row !== null && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const serverUrl = stringOrEmpty(unwrapVolatile(record.serverUrl)).trim();
    const token = stringOrEmpty(unwrapVolatile(record.deviceToken));
    if (token === '' || serverUrl === '') {
        return withDiagnostics({ state: 'unpaired' });
    }
    const normalized = normalizeServerUrl(serverUrl);
    if (!normalized.ok) {
        return withDiagnostics({ state: 'invalid-url' });
    }
    const relay = options.getRelayClient?.();
    if (relay === undefined) {
        // T16 shape: no relay client wired — the ping probe is the answer.
        const state = await probe(fetchImpl, normalized.url, token);
        return withDiagnostics({ state, serverUrl: normalized.url });
    }
    // The cached verdict is trusted only over the EXACT credentials the
    // handshake earned it with: an online state whose digest no longer
    // matches the row (address edited, re-pair) is an answer about a
    // DIFFERENT server and falls through to a live connect instead
    // (T23a-fix). The token never enters this body — the digest is a
    // one-way sha256 prefix computed on both sides.
    if (relay.state === 'online' &&
        relay.handshakeInfo !== undefined &&
        relay.lastHandshakeDigest !== undefined &&
        relay.lastHandshakeDigest === relayCredentialsDigest(normalized.url, token)) {
        return withDiagnostics(deviceStatusBody(relay.state, relay.handshakeInfo, normalized.url, relay.deviceNameSyncing));
    }
    // Everything else — never connected, offline, connecting, revoked,
    // stale credentials — gets ONE live connect bounded by the probe
    // timeout; its FRESH result is the answer, never the possibly stale
    // cached state. A failed attempt additionally carries the relay
    // client's reconnect machinery readout (T43): when the next
    // automatic retry fires and which code failed last — both free of
    // credential material by contract.
    try {
        const info = await withProbeTimeout(relay.connect());
        return withDiagnostics(deviceStatusBody('online', info, normalized.url, relay.deviceNameSyncing));
    }
    catch (error) {
        const body = { state: probeStateOfRelayError(error), serverUrl: normalized.url };
        if (relay.nextRetryAt !== null && relay.nextRetryAt !== undefined)
            body.nextRetryAt = relay.nextRetryAt;
        if (relay.lastError !== undefined)
            body.lastError = relay.lastError;
        return withDiagnostics(body);
    }
}
/**
 * Build the client route handler for one plugin row. The returned handler
 * owns the full response lifecycle of every request under
 * {@link CLIENT_ROUTE_PREFIX} and never throws.
 */
export function createClientHandler(options) {
    const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const resolveLang = () => {
        const value = typeof options.lang === 'function' ? options.lang() : options.lang;
        return value === 'en' ? 'en' : 'zh';
    };
    const mismatchMessage = () => resolveLang() === 'en' ? 'This remote session belongs to another server' : '此远程会话属于其他主服务端';
    return async (req, res) => {
        // Wall 1: DSH's own admission, relaying its refusal verbatim.
        const admission = options.admit(req);
        if ('rejection' in admission) {
            responseJson(res, admission.rejection, {
                ok: false,
                error: { code: admission.rejection === 401 ? 'unauthorized' : 'forbidden' },
            });
            return;
        }
        const route = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
        const method = req.method ?? 'GET';
        try {
            // CU-3: the debug-report route's via wall, BEFORE any dispatch (the
            // wizard's rule): a request wearing the gateway's marker arrived from
            // a remote device, and a forwarded request presents as same-origin
            // (the gateway rewrites Origin/Host) — the marker is the only honest
            // signal. The report is a machine-local export; the gateway must
            // never be able to fetch this machine's diagnostics either.
            if (route === CLIENT_DEBUG_REPORT_ROUTE && req.headers['x-zen-remote-via'] !== undefined) {
                responseJson(res, 403, {
                    ok: false,
                    error: {
                        code: 'via-gateway',
                        message: resolveLang() === 'en' ? 'Diagnostics report can only be exported on this machine' : '诊断报告只能在本机导出',
                    },
                });
                return;
            }
            // PG-9: the peer management routes' via wall, BEFORE any dispatch (the
            // same rule the debug report applies): a gateway-marked request came
            // from a remote device, and NO remote device may read or write this
            // machine's peer state — not even the status snapshot.
            if (route.startsWith(CLIENT_PEER_PREFIX) && req.headers['x-zen-remote-via'] !== undefined) {
                responseJson(res, 403, {
                    ok: false,
                    error: {
                        code: 'via-gateway',
                        message: resolveLang() === 'en' ? 'Peer settings can only be changed on this machine' : '节点端设置只能在本机查看和修改',
                    },
                });
                return;
            }
            // The host mount's least-exposure wall (T41a-fix2): remote-status and
            // the debug report (CU-3, both roles answer their own) exist here,
            // and both sit BEHIND the admission wall like every other route. The
            // shape of the refusal matches the unknown-path fallthrough.
            if (options.remoteStatusOnly === true && route !== CLIENT_REMOTE_STATUS_ROUTE && route !== CLIENT_DEBUG_REPORT_ROUTE) {
                responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } });
                return;
            }
            if (route === CLIENT_CLAIM_ROUTE) {
                if (method !== 'POST') {
                    res.setHeader('Allow', 'POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } });
                    return;
                }
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const body = await readJsonBody(req);
                const normalized = normalizeServerUrl(stringOrEmpty(body.serverUrl));
                if (!normalized.ok) {
                    responseJson(res, 400, { ok: false, code: normalized.reason });
                    return;
                }
                // MS-5 pool mode: the pairing cap is judged BEFORE the round-trip —
                // a refusal the user can fix locally (remove a server, or re-enter
                // an already-paired address) must not spend a claim code on the
                // wire. The cap is the POOL's effective cap ({@link
                // effectiveMaxServers}, PG-2-fix): the same `pool.maxServers()`
                // synthesis — gateway cap folded in — that `pool.pair()` enforces,
                // so the pre-check can never disagree with the actual pairing. An
                // address that is ALREADY paired is always allowed through:
                // re-pairing it just refreshes the token in place, at the cap too.
                // The pool stays the single writer afterwards: the gateway's
                // token goes straight into `zen-remote-state.json` and NEVER reaches
                // the browser — this response carries only the entry id and the
                // address echo.
                const pool = options.pool;
                if (pool !== undefined) {
                    const known = pool.entries().some((entry) => entry.serverUrl === normalized.url);
                    if (!known && pool.entries().length >= effectiveMaxServers(pool, options)) {
                        responseJson(res, 409, { ok: false, code: 'limit-reached' });
                        return;
                    }
                }
                const payload = JSON.stringify({
                    code: stringOrEmpty(body.code),
                    name: stringOrEmpty(body.name),
                });
                let status;
                let gatewayBody;
                try {
                    // No hand-set body-length (or host/connection/transfer-encoding)
                    // header here: DSH swaps the global fetch's dispatcher for its
                    // bundled undici 8.x, which refuses any fetch that carries one
                    // (UND_ERR_INVALID_ARG → the whole pairing round-trip answers
                    // "unreachable"), while the dispatcher computes the length itself
                    // from the string body.
                    const response = await fetchImpl(new URL(CLAIM_PATH, normalized.url), {
                        method: 'POST',
                        headers: { 'content-type': 'application/json; charset=utf-8' },
                        body: payload,
                        // A wrong server must not walk the pairing round-trip through a
                        // redirect chain (T16-fix): any 3xx lands in the classifier's
                        // `unexpected` bucket instead of being followed.
                        redirect: 'manual',
                        signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
                    });
                    status = response.status;
                    const text = await response.text();
                    try {
                        gatewayBody = JSON.parse(text);
                    }
                    catch {
                        gatewayBody = undefined;
                    }
                }
                catch {
                    responseJson(res, 502, { ok: false, code: 'unreachable' });
                    return;
                }
                const outcome = classifyClaimResponse(status, gatewayBody);
                if (pool === undefined || !outcome.ok) {
                    respondClaim(res, outcome, normalized.url);
                    return;
                }
                // Pool mode, redemption succeeded: land the pairing in the state
                // file through the pool (which also starts/refreshes the live
                // client) and answer without the token. The pair() can only refuse
                // past the pre-check on a concurrent writer — the same envelopes.
                const paired = await pool.pair({
                    serverUrl: normalized.url,
                    token: outcome.token,
                    deviceId: outcome.deviceId,
                    deviceName: outcome.deviceName,
                });
                if (!paired.ok) {
                    responseJson(res, paired.code === 'limit-reached' ? 409 : 400, { ok: false, code: paired.code });
                    return;
                }
                responseJson(res, 200, {
                    ok: true,
                    entryId: paired.entry.entryId,
                    deviceId: outcome.deviceId,
                    deviceName: outcome.deviceName,
                    serverUrl: normalized.url,
                });
                return;
            }
            if (route === CLIENT_UNPAIR_ROUTE) {
                // MS-5: remove one paired server or all of them. Pool-mode only —
                // a mount without a pool has no paired list to edit (the old
                // single-server pairing lived in the ROW, which the browser writes
                // directly), and answers the same 404 an unknown path would.
                const pool = options.pool;
                if (pool === undefined) {
                    responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } });
                    return;
                }
                if (method !== 'POST') {
                    res.setHeader('Allow', 'POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } });
                    return;
                }
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const body = await readJsonBody(req);
                if (body.all === true) {
                    const removed = pool.unpairAll();
                    responseJson(res, 200, { ok: true, removed });
                    return;
                }
                if (typeof body.entryId === 'string' && body.entryId !== '') {
                    const removed = pool.unpair(body.entryId);
                    responseJson(res, 200, { ok: true, removed: removed ? 1 : 0 });
                    return;
                }
                responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'entryId (non-empty string) or all (true) is required' } });
                return;
            }
            if (route === CLIENT_STATUS_ROUTE) {
                if (method !== 'GET') {
                    res.setHeader('Allow', 'GET');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } });
                    return;
                }
                responseJson(res, 200, await statusBodyOf(options));
                return;
            }
            if (route === CLIENT_DEBUG_REPORT_ROUTE) {
                // Unwired composition (no log ring handed over): the same shape an
                // unknown path gets — an old host must not pretend to have a report.
                const logs = options.getLogSnapshot?.();
                if (logs === undefined) {
                    responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } });
                    return;
                }
                if (method !== 'GET') {
                    res.setHeader('Allow', 'GET');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } });
                    return;
                }
                // The picked config summary (CU-2's construction layer): field by
                // NAME, never a spread — deviceToken and the other secret row fields
                // are structurally absent; the assembler's deep redactor is the
                // second layer behind this. serverUrl travels to the assembler raw
                // and comes out as a shape (scheme + address class + port).
                const row = options.getRowConfig();
                const record = row !== null && typeof row === 'object' && !Array.isArray(row) ? row : {};
                const values = resolveConfig(record, readFileConfig(), process.env).values;
                const rawMaxUpload = unwrapVolatile(record.maxUploadBytes);
                const maxUploadBytes = typeof rawMaxUpload === 'number' && Number.isFinite(rawMaxUpload) && rawMaxUpload > 0
                    ? rawMaxUpload
                    : undefined;
                const rawProfile = options.getProfileName?.();
                const report = assembleDebugReport({
                    meta: {
                        generatedAt: new Date().toISOString(),
                        pluginVersion: options.getPluginVersion?.() ?? 'unknown',
                        dshVersion: resolveDshVersion(),
                        platform: `${process.platform} ${process.arch}`,
                        role: String(values.role),
                        ...(rawProfile === undefined ? {} : { profileName: rawProfile }),
                    },
                    configSummary: {
                        role: values.role,
                        host: values.host,
                        port: values.port,
                        idleHours: values.idleHours,
                        maxServers: values.maxServers,
                        maxUploadBytes,
                        autoShareNewSessions: values.autoShareNewSessions,
                        pluginBridgeConsent: values.pluginBridgeConsent,
                        pushSummary: values.pushSummary,
                        pushTurnEnd: values.pushTurnEnd,
                        pushTool: values.pushTool,
                        pushEnabled: values.pushEnabled,
                        pushSessionName: values.pushSessionName,
                        serverUrl: stringOrEmpty(unwrapVolatile(record.serverUrl)).trim(),
                    },
                    statusBody: await statusBodyOf(options),
                    ...(options.getGatewaySummary === undefined ? {} : { gatewaySummary: await options.getGatewaySummary() }),
                    logs,
                    home: homedir(),
                });
                responseJson(res, 200, report);
                return;
            }
            if (route === CLIENT_RECONNECT_ROUTE) {
                if (method !== 'POST') {
                    res.setHeader('Allow', 'POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } });
                    return;
                }
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const relay = options.getRelayClient?.();
                // MS-5 pool mode: an optional { entryId } names ONE server — the
                // same offline-only, 409-on-conflict contract the single client's
                // button has, per entry; without it every OFFLINE server gets one
                // attempt (an online server is not "reconnected", it is fine).
                const pool = options.pool;
                if (pool !== undefined) {
                    const body = await readJsonBody(req);
                    const entryId = typeof body.entryId === 'string' && body.entryId !== '' ? body.entryId : undefined;
                    if (entryId === undefined) {
                        const started = await pool.reconnect();
                        responseJson(res, 200, { ok: true, started });
                        return;
                    }
                    const entry = pool.getByEntryId(entryId);
                    if (entry === undefined) {
                        responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'No such paired server' } });
                        return;
                    }
                    if (entry.client.state !== 'offline' || !entry.client.reconnect()) {
                        responseJson(res, 409, { ok: false, error: { code: 'not-offline', message: 'The client is not offline' } });
                        return;
                    }
                    responseJson(res, 200, { ok: true });
                    return;
                }
                // No relay client (a composition that never built one): there is
                // nothing to reconnect, and the probe-shaped status route is the
                // only connection surface this deployment has.
                if (relay === undefined) {
                    responseJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'No relay client is running' } });
                    return;
                }
                // The button is only clickable while offline; anything else is a
                // conflict with the state the page just rendered.
                if (relay.state !== 'offline' || !relay.reconnect()) {
                    responseJson(res, 409, { ok: false, error: { code: 'not-offline', message: 'The client is not offline' } });
                    return;
                }
                // Fired, not awaited: the attempt runs on the relay client (bounded
                // by its own request timeout), the state lands there either way, and
                // the page's status refresh reports the outcome.
                responseJson(res, 200, { ok: true });
                return;
            }
            if (route === CLIENT_NETWORK_HINT_ROUTE) {
                if (method !== 'POST') {
                    res.setHeader('Allow', 'POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } });
                    return;
                }
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const relay = options.getRelayClient?.();
                // MS-5 pool mode: the same QUESTION per server — one authenticated
                // ping sweep over the offline clients, the reachable ones get the
                // controlled `networkRestored()` (probe-first, no storm, offline
                // only — the pool method enforces the same rules per client).
                const pool = options.pool;
                if (pool !== undefined) {
                    const outcome = await pool.probeAndRestoreAll();
                    responseJson(res, 200, { ok: true, reachable: outcome.reachable, reconnected: outcome.reconnected });
                    return;
                }
                if (relay === undefined) {
                    responseJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'No relay client is running' } });
                    return;
                }
                // a hint is a QUESTION, not a verdict.
                // `probeHealth` is one authenticated GET /ping: it proves the HOST is
                // reachable with the current token — nothing about the long streams.
                // Only a reachable host earns the controlled reconnect, and
                // `networkRestored()` is what enforces "offline only" + the 3s gap.
                const reachable = await relay.probeHealth();
                if (!reachable) {
                    // Honest answer: the network may be back, the HOST is not.
                    responseJson(res, 200, { ok: true, reachable: false, reconnected: false });
                    return;
                }
                const reconnected = relay.networkRestored();
                responseJson(res, 200, { ok: true, reachable: true, reconnected });
                return;
            }
            if (route === CLIENT_REMOTE_STATUS_ROUTE) {
                if (method !== 'GET') {
                    res.setHeader('Allow', 'GET');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } });
                    return;
                }
                // T34: the T34 client parts' data source — no token, no server
                // address, nothing but the serving state, the compat verdict's
                // difference flag, the display name and the closed-session map.
                // PB-2 adds `bridgedPlugins`: the names whose bridge verdict is
                // bridged RIGHT NOW, sorted (the list arrives plugin-sorted, but the
                // sort is pinned here so the field's shape never depends on the
                // registry's internal order). The host mount — no verdict source —
                // answers [].
                // MS-5 pool mode: the SAME shape per server, under `servers` keyed
                // by the handshake serverId (an entry that never handshook owns no
                // virtual ids and is not addressable — skipped). The top level
                // mirrors the FIRST entry so the old page keeps rendering.
                const pool = options.pool;
                const intercept = options.getIntercept?.();
                const bridgedOf = (serverId, client) => (options.getPluginBridgeStatusForServer?.(serverId, client) ?? [])
                    .filter((status) => status.bridged)
                    .map((status) => status.plugin)
                    .sort();
                if (pool !== undefined) {
                    const entries = pool.entries();
                    const first = entries[0];
                    const servers = {};
                    for (const entry of entries) {
                        if (entry.serverId === undefined)
                            continue;
                        servers[entry.serverId] = {
                            state: remoteStatusStateOf(entry.client),
                            versionMismatch: (entry.client.compat?.different?.length ?? 0) > 0,
                            serverName: entry.serverName ?? '',
                            bridgedPlugins: bridgedOf(entry.serverId, entry.client),
                        };
                    }
                    responseJson(res, 200, {
                        state: remoteStatusStateOf(first?.client),
                        versionMismatch: (first?.client.compat?.different?.length ?? 0) > 0,
                        serverName: first?.serverName ?? '',
                        closed: Object.fromEntries((intercept?.closedSessions ?? []).map((record) => [record.sessionId, record.reason])),
                        bridgedPlugins: first !== undefined ? bridgedOf(first.serverId, first.client) : [],
                        servers,
                    });
                    return;
                }
                const relay = options.getRelayClient?.();
                responseJson(res, 200, {
                    state: remoteStatusStateOf(relay),
                    versionMismatch: (relay?.compat?.different?.length ?? 0) > 0,
                    serverName: relay?.handshakeInfo?.serverName ?? '',
                    closed: Object.fromEntries((intercept?.closedSessions ?? []).map((record) => [record.sessionId, record.reason])),
                    bridgedPlugins: (options.getPluginBridgeStatus?.() ?? [])
                        .filter((status) => status.bridged)
                        .map((status) => status.plugin)
                        .sort(),
                });
                return;
            }
            if (route === CLIENT_CURRENT_SESSION_ROUTE) {
                // No sink wired: a client mount without the intercept half — same
                // answer an unknown path gets (the host mount never reaches here,
                // its remoteStatusOnly wall 404s first).
                const sink = options.onCurrentSession;
                if (sink === undefined) {
                    responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } });
                    return;
                }
                if (method !== 'POST') {
                    res.setHeader('Allow', 'POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } });
                    return;
                }
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const body = await readJsonBody(req);
                // Exactly `sessionId`: a non-empty string (length-capped) or null —
                // null is a REAL "nothing is open" answer; anything else (absent,
                // wrong type, blank, over-long) is a malformed report, refused.
                const raw = body.sessionId;
                if (raw !== null && (typeof raw !== 'string' || raw === '' || raw.length > MAX_CURRENT_SESSION_ID)) {
                    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId must be a non-empty string of at most 512 characters, or null' } });
                    return;
                }
                const read = raw === null ? { kind: 'none' } : { kind: 'open', sessionId: raw };
                const reportedLang = body.lang === 'en' ? 'en' : body.lang === 'zh' ? 'zh' : undefined;
                sink(read, reportedLang);
                responseJson(res, 200, { ok: true });
                return;
            }
            if (route === CLIENT_UNSHARE_ROUTE) {
                if (method !== 'POST') {
                    res.setHeader('Allow', 'POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } });
                    return;
                }
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const body = await readJsonBody(req);
                // Only a VIRTUAL id is a remote session of this deployment — a local
                // id here is a caller bug, refused before anything travels.
                const parts = fromVirtual(body.sessionId);
                if (parts === undefined) {
                    responseJson(res, 400, { ok: false, error: { code: 'not-virtual', message: 'sessionId must be a remote (virtual) session id' } });
                    return;
                }
                // MS-5 pool mode: the id's serverId half names the server — its own
                // client closes the session with the ORIGINAL id. A server the pool
                // does not hold is the same remote-mismatch the interceptor answers.
                const pool = options.pool;
                if (pool !== undefined) {
                    const entry = pool.getByServerId(parts.serverId);
                    if (entry === undefined) {
                        responseJson(res, 200, { ok: false, error: { code: 'remote-mismatch', message: mismatchMessage() } });
                        return;
                    }
                    try {
                        await entry.client.unshare(parts.id);
                        responseJson(res, 200, { ok: true });
                    }
                    catch (error) {
                        const code = error instanceof RelayError ? error.code : 'internal';
                        responseJson(res, 200, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
                    }
                    return;
                }
                const relay = options.getRelayClient?.();
                if (relay === undefined) {
                    responseJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'No relay client is running' } });
                    return;
                }
                // A session of a DIFFERENT server than the current handshake would
                // just answer not-shared out there — the mismatch is answerable
                // locally, with the code the interceptor uses for the same fact.
                if (relay.handshakeInfo === undefined || relay.handshakeInfo.serverId !== parts.serverId) {
                    responseJson(res, 200, { ok: false, error: { code: 'remote-mismatch', message: mismatchMessage() } });
                    return;
                }
                try {
                    await relay.unshare(parts.id);
                    responseJson(res, 200, { ok: true });
                }
                catch (error) {
                    // The relay's refusal travels with its code — the icon's alert
                    // keys the short copy on it.
                    const code = error instanceof RelayError ? error.code : 'internal';
                    responseJson(res, 200, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
                }
                return;
            }
            if (route.startsWith(CLIENT_HTTP_ROUTE_PREFIX)) {
                // The plain-HTTP relay (T41b): the browser fetch wrapper sends the
                // `/api/changes.*` calls it intercepted here. Same first wall as
                // every client route (admit, above), then the four checks the
                // interceptor's own routes apply — registered route, exactly one
                // virtual session id, the relay online, and THAT id belonging to the
                // connected server — before the query travels with the original id
                // restored.
                if (method !== 'GET') {
                    res.setHeader('Allow', 'GET');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } });
                    return;
                }
                const httpRoute = route.slice(CLIENT_HTTP_ROUTE_PREFIX.length);
                // Registry lookup by hasOwnProperty, never a bare index: `route` is
                // a wire string, and `constructor` must not resolve through the
                // object prototype.
                if (httpRoute === '' || !Object.prototype.hasOwnProperty.call(RELAY_HTTP_ROUTES, httpRoute)) {
                    responseJson(res, 404, { ok: false, error: { code: 'unknown-route' } });
                    return;
                }
                const url = new URL(req.url ?? '/', 'http://dsh.internal');
                const sessionIds = url.searchParams.getAll('sessionId');
                const virtualId = sessionIds.length === 1 ? sessionIds[0] : undefined;
                if (virtualId === undefined || virtualId === '') {
                    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId is required exactly once' } });
                    return;
                }
                const parts = fromVirtual(virtualId);
                if (parts === undefined) {
                    responseJson(res, 400, { ok: false, error: { code: 'not-virtual', message: 'sessionId is not a remote session id' } });
                    return;
                }
                // MS-5 pool mode: route by the id's serverId half. A server the pool
                // does not hold refuses like a foreign one; its client must be the
                // ONLINE one before the query travels with the original id restored.
                const pool = options.pool;
                if (pool !== undefined) {
                    const entry = pool.getByServerId(parts.serverId);
                    if (entry === undefined) {
                        responseJson(res, 400, { ok: false, error: { code: 'remote-mismatch', message: mismatchMessage() } });
                        return;
                    }
                    if (entry.client.state !== 'online') {
                        responseJson(res, 503, { ok: false, error: { code: 'remote-offline' } });
                        return;
                    }
                    url.searchParams.set('sessionId', parts.id);
                    // A browser walk-off cancels the round-trip mid-flight; the write
                    // guard in the catch keeps a settled answer from racing the close.
                    const hangUp = new AbortController();
                    res.once('close', () => {
                        if (!res.writableEnded)
                            hangUp.abort();
                    });
                    try {
                        const result = await entry.client.http(httpRoute, url.searchParams.toString(), hangUp.signal);
                        respondUpstream(res, result);
                    }
                    catch (error) {
                        if (!res.writableEnded && !res.destroyed)
                            respondRelayFailure(res, error);
                    }
                    return;
                }
                const relay = options.getRelayClient?.();
                if (relay === undefined || relay.state !== 'online') {
                    responseJson(res, 503, { ok: false, error: { code: 'remote-offline' } });
                    return;
                }
                if (relay.handshakeInfo?.serverId !== parts.serverId) {
                    responseJson(res, 400, { ok: false, error: { code: 'remote-mismatch', message: mismatchMessage() } });
                    return;
                }
                url.searchParams.set('sessionId', parts.id);
                // A browser walk-off cancels the round-trip mid-flight; the write
                // guard in the catch keeps a settled answer from racing the close.
                const hangUp = new AbortController();
                res.once('close', () => {
                    if (!res.writableEnded)
                        hangUp.abort();
                });
                try {
                    const result = await relay.http(httpRoute, url.searchParams.toString(), hangUp.signal);
                    respondUpstream(res, result);
                }
                catch (error) {
                    if (!res.writableEnded && !res.destroyed)
                        respondRelayFailure(res, error);
                }
                return;
            }
            // PG-9: the peer management routes. The shared walls already ran —
            // admit at the very top, the via-marker wall before dispatch — so per
            // route it is method, same-origin (POSTs), body, engine. A mount
            // without an engine (a plain client or host row) answers 503
            // `peer-unavailable`: the routes are registered for the whole
            // connects-role family, but only a peer row has something to manage.
            if (route.startsWith(CLIENT_PEER_PREFIX)) {
                const engine = options.getPeerEngine?.();
                if (engine === undefined) {
                    responseJson(res, 503, { ok: false, error: { code: 'peer-unavailable' } });
                    return;
                }
                if (route === CLIENT_PEER_STATUS_ROUTE) {
                    if (method !== 'GET') {
                        res.setHeader('Allow', 'GET');
                        responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } });
                        return;
                    }
                    responseJson(res, 200, peerStatusBodyOf(engine, options));
                    return;
                }
                if (route === CLIENT_PEER_JOIN_ROUTE || route === CLIENT_PEER_LEAVE_ROUTE || route === CLIENT_PEER_TOGGLE_MOUNT_ROUTE || route === CLIENT_PEER_TRUST_ROUTE || route === CLIENT_PEER_REPROBE_ROUTE) {
                    if (method !== 'POST') {
                        res.setHeader('Allow', 'POST');
                        responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } });
                        return;
                    }
                    if (!sameOriginPost(req)) {
                        responseJson(res, 403, {
                            ok: false,
                            error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                        });
                        return;
                    }
                    const body = await readJsonBody(req);
                    if (route === CLIENT_PEER_JOIN_ROUTE) {
                        const rawInput = (stringOrEmpty(body.inviteUri) || stringOrEmpty(body.gatewayUrl)).trim();
                        const requestedNetworkId = stringOrEmpty(body.networkId).trim().toLowerCase();
                        if (rawInput === '') {
                            responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'inviteUri or gatewayUrl (non-empty string) is required' } });
                            return;
                        }
                        if (/^zr-net/i.test(rawInput)) {
                            const outcome = await engine.joinNetwork(rawInput);
                            if (outcome.ok) {
                                responseJson(res, 200, { ok: true });
                            }
                            else {
                                responseJson(res, 400, { ok: false, error: { code: outcome.code } });
                            }
                            return;
                        }
                        const parsed = parseGatewayJoinInput(rawInput);
                        if (parsed === null || parsed.kind === 'invite') {
                            responseJson(res, 400, { ok: false, error: { code: 'invalid-invite' } });
                            return;
                        }
                        // Keyless manual-approval join by gateway address: discover joinable
                        // networks on `/peer/v1/networks`, then dial without `#joinKey` so
                        // the node lands in `pending` on the gateway console.
                        const candidates = parsed.schemeMode === 'https'
                            ? [{ tls: true, origin: `https://${parsed.rawHost}:${parsed.port}` }]
                            : parsed.schemeMode === 'http'
                                ? [{ tls: false, origin: `http://${parsed.rawHost}:${parsed.port}` }]
                                : isLoopbackOrPrivateHostname(parsed.hostname)
                                    ? [{ tls: false, origin: `http://${parsed.rawHost}:${parsed.port}` }]
                                    : parsed.port === 443
                                        ? [{ tls: true, origin: `https://${parsed.rawHost}:${parsed.port}` }]
                                        : [
                                            { tls: true, origin: `https://${parsed.rawHost}:${parsed.port}` },
                                            { tls: false, origin: `http://${parsed.rawHost}:${parsed.port}` },
                                        ];
                        let discovered = null;
                        for (const candidate of candidates) {
                            try {
                                const probeRes = await fetchImpl(`${candidate.origin}/peer/v1/networks`, {
                                    method: 'GET',
                                    redirect: 'manual',
                                    signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
                                });
                                if (probeRes.status !== 200)
                                    continue;
                                const rawJson = JSON.parse(await probeRes.text());
                                if (rawJson === null || typeof rawJson !== 'object')
                                    continue;
                                const payloadObj = rawJson.ok === true && rawJson.data !== null && typeof rawJson.data === 'object' && !Array.isArray(rawJson.data)
                                    ? rawJson.data
                                    : rawJson;
                                if (!Array.isArray(payloadObj.networks))
                                    continue;
                                const networks = [];
                                let malformed = false;
                                for (const item of payloadObj.networks) {
                                    if (item === null
                                        || typeof item !== 'object'
                                        || typeof item.id !== 'string'
                                        || !/^[0-9a-f]{16}$/i.test(item.id)
                                        || typeof item.name !== 'string') {
                                        malformed = true;
                                        break;
                                    }
                                    networks.push({
                                        id: item.id.toLowerCase(),
                                        name: item.name,
                                    });
                                }
                                if (malformed)
                                    continue;
                                const totalNetworks = typeof payloadObj.totalNetworks === 'number' && Number.isFinite(payloadObj.totalNetworks)
                                    ? payloadObj.totalNetworks
                                    : networks.length;
                                discovered = { tls: candidate.tls, networks, totalNetworks };
                                break;
                            }
                            catch {
                                // Try next scheme candidate if available.
                            }
                        }
                        if (discovered === null) {
                            responseJson(res, 502, { ok: false, error: { code: 'gateway-unreachable' } });
                            return;
                        }
                        const explicitNetId = requestedNetworkId !== '' ? requestedNetworkId : (parsed.networkId ?? '');
                        let targetNetworkId;
                        if (explicitNetId !== '') {
                            if (!/^[0-9a-f]{16}$/.test(explicitNetId)) {
                                responseJson(res, 400, { ok: false, error: { code: 'invalid-invite' } });
                                return;
                            }
                            const matched = discovered.networks.find((n) => n.id === explicitNetId);
                            if (!matched) {
                                const code = discovered.totalNetworks > discovered.networks.length ? 'manual-disabled' : 'no-network';
                                responseJson(res, 400, { ok: false, error: { code } });
                                return;
                            }
                            targetNetworkId = matched.id;
                        }
                        else if (discovered.networks.length === 1) {
                            targetNetworkId = discovered.networks[0].id;
                        }
                        else if (discovered.networks.length > 1) {
                            responseJson(res, 409, {
                                ok: false,
                                error: { code: 'select-network' },
                                networks: discovered.networks,
                            });
                            return;
                        }
                        else {
                            const code = discovered.totalNetworks > 0 ? 'manual-disabled' : 'no-network';
                            responseJson(res, 400, { ok: false, error: { code } });
                            return;
                        }
                        const synthesizedUri = buildKeylessInviteUri({
                            rawHost: parsed.rawHost,
                            hostname: parsed.hostname,
                            port: parsed.port,
                            tls: discovered.tls,
                            networkId: targetNetworkId,
                        });
                        const outcome = await engine.joinNetwork(synthesizedUri);
                        if (outcome.ok) {
                            responseJson(res, 200, { ok: true, networkId: targetNetworkId, manualApproval: true });
                        }
                        else {
                            responseJson(res, 400, { ok: false, error: { code: outcome.code } });
                        }
                        return;
                    }
                    if (route === CLIENT_PEER_LEAVE_ROUTE) {
                        engine.leaveNetwork();
                        responseJson(res, 200, { ok: true });
                        return;
                    }
                    if (route === CLIENT_PEER_TOGGLE_MOUNT_ROUTE) {
                        const nodeId = body.nodeId;
                        const mounted = body.mounted;
                        if (typeof nodeId !== 'string' || nodeId === '' || typeof mounted !== 'boolean') {
                            responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'nodeId (non-empty string) and mounted (boolean) are required' } });
                            return;
                        }
                        // 引擎内部按小写 8-hex 存节点 id——路由层先归一，大小写粘贴无感。
                        engine.setNodeDisabled(nodeId.toLowerCase(), !mounted);
                        responseJson(res, 200, { ok: true });
                        return;
                    }
                    if (route === CLIENT_PEER_TRUST_ROUTE) {
                        const nodeId = body.nodeId;
                        if (typeof nodeId !== 'string' || nodeId === '') {
                            responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'nodeId (non-empty string) is required' } });
                            return;
                        }
                        if (!engine.trustPeer(nodeId.toLowerCase())) {
                            responseJson(res, 404, { ok: false, error: { code: 'unknown-peer' } });
                            return;
                        }
                        responseJson(res, 200, { ok: true });
                        return;
                    }
                    // CLIENT_PEER_REPROBE_ROUTE: fire and answer — the punch rounds
                    // report their own outcome through the status poll.
                    engine.reprobePunch();
                    responseJson(res, 200, { ok: true });
                    return;
                }
            }
            responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } });
        }
        catch (error) {
            // Only the route's OWN refusals carry a message; anything else is a bug
            // and answers a bare 500 — internal error text (absolute paths, stack
            // fragments) never reaches the browser (T16-fix).
            if (error instanceof ClientRouteError) {
                responseJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
                return;
            }
            responseJson(res, 500, { ok: false, error: { code: 'internal' } });
        }
    };
}
//# sourceMappingURL=client-routes.js.map