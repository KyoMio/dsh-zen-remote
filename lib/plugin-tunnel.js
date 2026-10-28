/**
 * The plugin bridge's WebSocket byte tunnel (PB-10), server half. Per
 * docs/adr/0002 the relay NEVER speaks WebSocket: a bridged upgrade route is
 * carried as ONE NDJSON streaming response (server → client bytes) plus
 * ordinary POSTs per chunk (client → server bytes), both ends treating the
 * payload as OPAQUE BYTES — the WebSocket handshake and every frame are
 * produced by the real plugin route on the server machine and arrive at the
 * browser untouched.
 *
 * Open: `POST relay/v1/plugin-tunnel/open` — the same coordinate headers and
 * the SAME validation chain as `v1/plugin` (shared {@link validatePluginCall};
 * the route must additionally be declared `upgrade: true`), plus a small
 * JSON body carrying exactly the four `sec-websocket-*` headers and the
 * optional early head bytes. On success the relay dials the local web server
 * itself (net/tls, loopback only), writes a hand-built upgrade request with
 * the operator's cookie, and pumps socket bytes downstream line by line.
 * Send/close: `POST relay/v1/plugin-tunnel/{send,close}` — ordered chunks
 * upstream (one in-flight per tunnel, sequence-gated) and idempotent
 * teardown.
 *
 * Every tunnel belongs to the device that opened it; another device's
 * send/close is 404. Budgets, heartbeats and the slow-reader discipline
 * mirror the routes this module sits beside.
 */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { pluginBridgeError, responseJson } from './http.js';
import { adapterPathMatches, adapterTailShapeViolation } from './plugin-adapter-core.js';
import { routeLocatorOf, routeMaxBodyOf, routeMethodsOf, routePrefixOf, routeUpgradesOf } from './plugin-bridge.js';
/** The cooperative route through the adapter core's matcher (PB-23): the
 * path rule is ONE rule on both halves — {@link adapterPathMatches} decides,
 * fed the declaration route converted to its shape (exact by default;
 * `prefix: true` becomes the adapter's `match: 'prefix'`). A hand-copied
 * predicate here could drift from the adapter segment's rule; the conversion
 * cannot. Only `path` and `match` are actually read by the matcher. */
function asAdapterRoute(route) {
    return {
        path: route.path,
        match: routePrefixOf(route) ? 'prefix' : 'exact',
        methods: routeMethodsOf(route),
        maxBody: routeMaxBodyOf(route),
        stream: route.stream,
        upgrade: routeUpgradesOf(route),
        locator: routeLocatorOf(route),
        local: false,
    };
}
/** Validate one plugin-bridge call's coordinates — the parse-once query
 * discipline (the re-serialization of THIS parse is the only string the
 * tunnel's upgrade request may carry), the share table with its ancestor
 * walk, and the live consent wall. `bridge.getConsent()` throwing reads as
 * unknown consent, and unknown consent stays home. */
export function validatePluginCall(bridge, coords, isAccessible) {
    const declaration = bridge.registry.get(coords.pluginName);
    if (declaration === undefined)
        return { ok: false, status: 404, code: 'plugin-unknown' };
    if (declaration.version !== coords.pluginVersion || declaration.digest !== coords.pluginDigest) {
        return { ok: false, status: 409, code: 'plugin-mismatch' };
    }
    // First hit in the declaration's (path-sorted) order wins. PB-23: an
    // exact-declared route matches equality alone; a `prefix: true` route also
    // admits every deeper RAW path (`x-zr-path` is matched undecoded, the
    // module-wide discipline) — the SAME rule the adapter segment applies, so
    // the sub-client's prefix forwarding (PB-21) is checked here against the
    // declaration instead of being trusted.
    const route = declaration.routes.find((candidate) => adapterPathMatches(asAdapterRoute(candidate), coords.routePath));
    if (route === undefined)
        return { ok: false, status: 404, code: 'route-undeclared' };
    // PB-23b: a prefix hit's variable tail carries the declaration-side shape
    // red lines itself (`?`, `#`, `..` — encoded forms included — and
    // whitespace; the shared rule, the adapter segment's too). 400
    // `bad-request`, the coordinate-shape code this chain already answers.
    if (adapterTailShapeViolation(asAdapterRoute(route), coords.routePath)) {
        return { ok: false, status: 400, code: 'bad-request' };
    }
    let params;
    try {
        params = new URLSearchParams(coords.rawQuery);
    }
    catch {
        return { ok: false, status: 400, code: 'bad-query' };
    }
    const ids = params.getAll(route.sessionParam);
    const sessionId = ids.length === 1 ? ids[0] : undefined;
    if (sessionId === undefined || sessionId === '')
        return { ok: false, status: 400, code: 'bad-query' };
    if (!isAccessible(sessionId))
        return { ok: false, status: 403, code: 'not-shared' };
    if (route.scope === 'server') {
        let consent = {};
        try {
            consent = bridge.getConsent();
        }
        catch {
            consent = {};
        }
        if (consent[coords.pluginName] !== true)
            return { ok: false, status: 403, code: 'consent-off' };
    }
    return { ok: true, declaration, route, params, sessionId, normalizedQuery: params.toString() };
}
/** Largest single downstream data LINE (base64 will inflate by 4/3 — the cap
 * is on the RAW bytes carried, and the line stays well under typical proxy
 * line limits this way). */
export const TUNNEL_DOWN_CHUNK_BYTES = 48 * 1024;
/** Largest upstream send chunk (the wire body of one `send`). */
export const TUNNEL_UP_CHUNK_BYTES = 64 * 1024;
/** Concurrent tunnels per device. */
export const MAX_TUNNELS_PER_DEVICE = 8;
/** The four WebSocket headers the open body may carry, verbatim. */
const TUNNEL_CLIENT_HEADERS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'];
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Header values must be plain strings — a CR/LF anywhere would inject into
 * the hand-built upgrade request. */
function cleanHeaderValue(value) {
    if (typeof value !== 'string' || value === '' || /[\r\n]/.test(value))
        return undefined;
    return value;
}
/** The tunnel table: id → the live entry. Every teardown path removes its
 * own entry exactly once. */
export function createPluginTunnel(options) {
    const tunnels = new Map();
    /** Teardown, idempotent: end line (when the downstream still wants one
     * and none was written), upstream destroyed, heartbeat cleared, entry
     * gone. */
    const teardown = (tunnel, id, reason) => {
        if (tunnels.get(id) !== tunnel)
            return;
        tunnels.delete(id);
        clearInterval(tunnel.heartbeat);
        if (reason !== null && !tunnel.res.writableEnded && !tunnel.res.destroyed) {
            writeLine(tunnel.res, { type: 'end', reason });
        }
        try {
            tunnel.res.end();
        }
        catch {
            // Already gone.
        }
        try {
            tunnel.upstream.destroy();
        }
        catch {
            // Already gone.
        }
    };
    const writeLine = (res, value) => {
        if (res.destroyed || res.writableEnded)
            return false;
        return res.write(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
    };
    const deviceOf = (req) => {
        const raw = req.headers['x-zen-remote-device'];
        const value = Array.isArray(raw) ? raw[0] : raw;
        return typeof value === 'string' ? value : '';
    };
    /** One coordinate header of the open request. */
    const coordOf = (req, name) => {
        const raw = req.headers[name];
        const value = Array.isArray(raw) ? raw[0] : raw;
        return typeof value === 'string' ? value : undefined;
    };
    return {
        tunnelCount() {
            return tunnels.size;
        },
        async open(req, res) {
            const bridge = options.bridge;
            // The open body is a SMALL JSON object (four headers + optional head);
            // anything past the shared body cap is refused by the reader itself.
            let body;
            try {
                const chunks = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 1024 * 1024) {
                        pluginBridgeError(res, 413, 'body-too-large');
                        return;
                    }
                    chunks.push(Buffer.from(chunk));
                }
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                if (!isRecord(parsed)) {
                    pluginBridgeError(res, 400, 'bad-request');
                    return;
                }
                body = parsed;
            }
            catch {
                pluginBridgeError(res, 400, 'bad-request');
                return;
            }
            const rawHeaders = isRecord(body.headers) ? body.headers : undefined;
            // ALL four headers pass the CR/LF check unconditionally — confining it
            // to the missing-key branch would let a poisoned OPTIONAL header
            // through when key/version are fine, and the hand-built request below
            // would write a literal `undefined` header for it.
            for (const optional of ['sec-websocket-protocol', 'sec-websocket-extensions']) {
                if (rawHeaders?.[optional] !== undefined && cleanHeaderValue(rawHeaders[optional]) === undefined) {
                    pluginBridgeError(res, 400, 'bad-request');
                    return;
                }
            }
            const wsKey = rawHeaders === undefined ? undefined : cleanHeaderValue(rawHeaders['sec-websocket-key']);
            const wsVersion = rawHeaders === undefined ? undefined : cleanHeaderValue(rawHeaders['sec-websocket-version']);
            // The two headers a WebSocket handshake cannot exist without.
            if (wsKey === undefined || wsVersion === undefined) {
                pluginBridgeError(res, 400, 'bad-request');
                return;
            }
            let head = Buffer.alloc(0);
            if (body.head !== undefined) {
                if (typeof body.head !== 'string') {
                    pluginBridgeError(res, 400, 'bad-request');
                    return;
                }
                head = Buffer.from(body.head, 'base64');
                if (head.length === 0 && body.head !== '') {
                    pluginBridgeError(res, 400, 'bad-request');
                    return;
                }
            }
            const coords = {
                pluginName: coordOf(req, 'x-zr-plugin') ?? '',
                pluginVersion: coordOf(req, 'x-zr-plugin-version') ?? '',
                pluginDigest: coordOf(req, 'x-zr-plugin-digest') ?? '',
                routePath: coordOf(req, 'x-zr-path') ?? '',
                rawQuery: coordOf(req, 'x-zr-query') ?? '',
            };
            if (coords.pluginName === '' || coords.pluginVersion === '' || coords.pluginDigest === '' ||
                coords.routePath === '' || !coords.routePath.startsWith('/')) {
                pluginBridgeError(res, 400, 'bad-request');
                return;
            }
            const validation = validatePluginCall(bridge, coords, options.isAccessible);
            if (!validation.ok) {
                pluginBridgeError(res, validation.status, validation.code);
                return;
            }
            // Tunnel routes must be DECLARED as upgrades: an ordinary (HTTP)
            // route has no WebSocket endpoint behind it to dial.
            if (!routeUpgradesOf(validation.route)) {
                pluginBridgeError(res, 404, 'route-undeclared');
                return;
            }
            const device = deviceOf(req);
            if (([...tunnels.values()].filter((tunnel) => tunnel.device === device)).length >= MAX_TUNNELS_PER_DEVICE) {
                pluginBridgeError(res, 429, 'busy');
                return;
            }
            // Dial the local web server with a hand-built upgrade request. The
            // cookie authenticates as the operator (same loopback discipline as
            // every bridged call); Origin is deliberately NOT written.
            let cookie;
            try {
                cookie = await bridge.loopback.cookieHeader();
            }
            catch {
                pluginBridgeError(res, 502, 'loopback-auth');
                return;
            }
            const target = options.getTarget();
            let upstream;
            try {
                // Self-signed https on the literal loopback: the dial is the pinned
                // 127.0.0.1, so certificate identity carries no information (the
                // same rule plugin-loopback applies to its own hops).
                upstream =
                    target.protocol === 'https:'
                        ? tlsConnect({ host: '127.0.0.1', port: target.port, rejectUnauthorized: false, servername: '127.0.0.1' })
                        : netConnect({ host: '127.0.0.1', port: target.port });
            }
            catch {
                pluginBridgeError(res, 502, 'internal');
                return;
            }
            const id = (await import('node:crypto')).randomBytes(16).toString('hex');
            const tunnel = {
                device,
                upstream,
                res,
                expectedSeq: 0,
                heartbeat: setInterval(() => {
                    writeLine(res, { type: 'ping' });
                }, options.heartbeatMs),
            };
            if (typeof tunnel.heartbeat.unref === 'function')
                tunnel.heartbeat.unref();
            tunnels.set(id, tunnel);
            // The NDJSON river opens BEFORE the dial can succeed — the open line
            // is the client's signal to stop HTTP-ing and start reading. A dial
            // failure becomes an end line, not a lost connection.
            res.writeHead(200, {
                'content-type': 'application/x-ndjson; charset=utf-8',
                'cache-control': 'no-store, no-transform',
                'x-accel-buffering': 'no',
            });
            res.write(Buffer.from(`${JSON.stringify({ type: 'open', tunnel: id })}\n`, 'utf8'));
            const query = validation.normalizedQuery;
            const requestLines = [
                `GET ${coords.routePath}${query === '' ? '' : `?${query}`} HTTP/1.1`,
                `Host: 127.0.0.1:${target.port}`,
                'Connection: Upgrade',
                'Upgrade: websocket',
                `Sec-WebSocket-Key: ${wsKey}`,
                `Sec-WebSocket-Version: ${wsVersion}`,
                ...(rawHeaders?.['sec-websocket-protocol'] !== undefined ? [`Sec-WebSocket-Protocol: ${cleanHeaderValue(rawHeaders['sec-websocket-protocol'])}`] : []),
                ...(rawHeaders?.['sec-websocket-extensions'] !== undefined ? [`Sec-WebSocket-Extensions: ${cleanHeaderValue(rawHeaders['sec-websocket-extensions'])}`] : []),
                ...(cookie !== '' ? [`Cookie: ${cookie}`] : []),
                '\r\n',
            ];
            upstream.write(requestLines.join('\r\n'));
            if (head.length > 0)
                upstream.write(head);
            // Upstream bytes → downstream data lines, at most 48 KiB PER LINE, with
            // the slow-reader discipline: a full socket pauses the UPSTREAM read, so
            // a stalled client never grows this process's buffers. Whatever arrived
            // is sent NOW — an interactive WebSocket speaks in tens of bytes, and
            // holding a sub-chunk arrival for a fuller buffer would stall the
            // handshake and every early frame (the PB-10 e2e hang).
            let downstreamBuffer = Buffer.alloc(0);
            const pumpDownstream = () => {
                while (downstreamBuffer.length > 0) {
                    const chunk = downstreamBuffer.subarray(0, TUNNEL_DOWN_CHUNK_BYTES);
                    downstreamBuffer = downstreamBuffer.subarray(chunk.length);
                    if (!writeLine(res, { type: 'data', b64: chunk.toString('base64') })) {
                        upstream.pause();
                        res.once('drain', () => upstream.resume());
                        return;
                    }
                }
            };
            upstream.on('data', (chunk) => {
                downstreamBuffer = Buffer.concat([downstreamBuffer, chunk]);
                pumpDownstream();
            });
            upstream.on('close', () => {
                // Whatever bytes remained inside the last (sub-chunk) buffer still
                // travel before the end line.
                if (downstreamBuffer.length > 0 && !res.destroyed && !res.writableEnded) {
                    writeLine(res, { type: 'data', b64: downstreamBuffer.toString('base64') });
                    downstreamBuffer = Buffer.alloc(0);
                }
                teardown(tunnel, id, 'upstream-closed');
            });
            upstream.on('error', () => {
                teardown(tunnel, id, 'upstream-error');
            });
            res.on('close', () => {
                // The client is gone: no end line can be delivered.
                teardown(tunnel, id, null);
            });
        },
        async send(req, res) {
            const tunnelId = coordOf(req, 'x-zr-tunnel') ?? '';
            const seqRaw = coordOf(req, 'x-zr-seq') ?? '';
            const tunnel = tunnels.get(tunnelId);
            const device = deviceOf(req);
            if (tunnel === undefined || tunnel.device !== device) {
                pluginBridgeError(res, 404, 'tunnel-unknown');
                // Drain the body so the client reads the refusal instead of a reset.
                req.resume();
                return;
            }
            if (!/^\d+$/u.test(seqRaw)) {
                pluginBridgeError(res, 400, 'bad-request');
                req.resume();
                return;
            }
            const seq = Number(seqRaw);
            if (seq !== tunnel.expectedSeq) {
                // Out of order: the stream's ordering contract is broken — the
                // tunnel closes (client-closed, the sending side's failure).
                pluginBridgeError(res, 409, 'tunnel-out-of-order');
                teardown(tunnel, tunnelId, 'client-closed');
                req.resume();
                return;
            }
            const declaredLength = Number(req.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > TUNNEL_UP_CHUNK_BYTES) {
                pluginBridgeError(res, 413, 'body-too-large');
                req.resume();
                return;
            }
            const chunks = [];
            let size = 0;
            let over = false;
            for await (const chunk of req) {
                size += chunk.length;
                if (size > TUNNEL_UP_CHUNK_BYTES) {
                    over = true;
                    break;
                }
                chunks.push(Buffer.from(chunk));
            }
            if (over) {
                pluginBridgeError(res, 413, 'body-too-large');
                req.resume();
                return;
            }
            const bytes = Buffer.concat(chunks);
            tunnel.expectedSeq = seq + 1;
            // Backpressure: the answer waits for the upstream socket to take the
            // bytes, so a stalled plugin makes THIS send slow instead of growing
            // buffers here.
            const flushed = tunnel.upstream.write(bytes);
            if (!flushed) {
                await new Promise((resolve) => {
                    const settled = () => {
                        tunnel.upstream.off('drain', settled);
                        tunnel.upstream.off('close', settled);
                        tunnel.upstream.off('error', settled);
                        resolve();
                    };
                    tunnel.upstream.once('drain', settled);
                    tunnel.upstream.once('close', settled);
                    tunnel.upstream.once('error', settled);
                });
            }
            if (tunnels.get(tunnelId) !== tunnel) {
                // The tunnel died while the bytes were draining.
                pluginBridgeError(res, 404, 'tunnel-unknown');
                return;
            }
            responseJson(res, 200, { ok: true });
        },
        async close(req, res) {
            const tunnelId = coordOf(req, 'x-zr-tunnel') ?? '';
            const tunnel = tunnels.get(tunnelId);
            const device = deviceOf(req);
            if (tunnel !== undefined && tunnel.device !== device) {
                pluginBridgeError(res, 404, 'tunnel-unknown');
                return;
            }
            // Idempotent: a known tunnel closes (end line client-closed — the
            // downstream's owner walked away), an unknown id answers ok.
            if (tunnel !== undefined) {
                teardown(tunnel, tunnelId, 'client-closed');
            }
            responseJson(res, 200, { ok: true });
        },
    };
}
//# sourceMappingURL=plugin-tunnel.js.map