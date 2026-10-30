/**
 * The plugin bridge's route interception (PB-4): the sub-client's local
 * DSH process owns a webServer whose `match(pathname)` every request goes
 * through (RT dsh-host-webserver lib/index.js:350-364 — `handle` computes
 * the RAW, undecoded pathname and calls `this.match`). Overriding that one
 * method intercepts every route lookup — including routes registered AFTER
 * us, because the host re-reads the instance method per request. A request
 * aimed at a BRIDGED plugin's declared route, carrying a VIRTUAL session id,
 * cannot be served locally (the session lives on the server): the surrogate
 * handler forwards it through `relay.pluginRequest` (PB-3's
 * `relay/v1/plugin`) with the real id restored, and streams the answer
 * back (PB-21: where the id lives is the route's own declaration — the 2.1
 * query parameter, or a declaration-v2 locator in a prefix route's path
 * segment or the JSON body; the v2 shapes ride the SAME adapter-core
 * locate → classify → rewrite functions the adapters run, and a
 * `prefix: true` route forwards its full matched, rewritten path).
 * Everything else — undeclared routes, local sessions — flows to the
 * original route untouched.
 *
 * PB-22 gives the two remaining declaration-v2 flags their client meaning:
 * a `deny: true` route answers the uniform 503 with reason `route-denied`
 * whenever a REMOTE context touches it — the request locating a virtual id,
 * or the browser's CURRENT session being one (T62's signal) — while a local
 * session passes through exactly as before; a `rewriteIds: true` route's
 * JSON answer is buffered (the 8 MB adapter cap) and deep-scanned, every
 * string EXACTLY equal to one of the request's own real session ids
 * rewritten to its virtual form (`zr~` carries the real id inside, so the
 * request's own hits ARE the read-only mapping — no table is consulted or
 * written), unknown strings passing through untouched.
 *
 * PB-25a adds the position form: `rewriteIds: { fields }` declares the dot
 * paths where the response's NEWLY-CREATED session ids sit (a creation
 * route's `childId` was never in the request, so no value scan can catch
 * it). On top of the value scan, each declared path's non-empty, non-virtual
 * string gains the virtual shell of THIS request's server id; missing paths
 * are no-ops and nothing is ever guessed beyond the declared positions.
 *
 * PB-25b widens the value scan's lookup from the request-local mapping to
 * the request-local mapping UNION the KNOWN-real-session inventory: the
 * merged global streams report every real id the sub-client currently holds
 * (the sidebar's `zr~` rows — subagents.live's object keys, workflows.list
 * rows: ids in the browser's view but not in THIS request), and a string
 * exactly equal to one of those is rewritten too, in the same request-sourced
 * virtual shell. The inventory is READ-ONLY consumption — the scan never
 * touches merge state — and it is read live per answer: a stream refresh
 * replaces its share, and the next answer sees the fresh union (ids that
 * appear between two refreshes wait for the next refresh — the documented
 * ceiling). Without the option the scan is exactly the PB-22 behavior.
 *
 * The un-bridged refusals answer a UNIFORM 503 shape (header
 * `x-zen-remote: unbridged`, JSON body naming the reason) — and, decisive
 * for the security posture, they answer WITHOUT the local plugin handler
 * ever running: a remote session must never execute a plugin route against
 * local state, not even when the bridge is down (docs/adr/0001).
 *
 * The wrap is gated on a structural shape check like the typert and
 * fetch-route ones; uninstall restores `match` only while the instance
 * still holds OUR wrapper — a later wrapper chained over us keeps working,
 * and ours goes inert instead (the same posture as intercept.ts and
 * fetch-route-intercept.ts).
 */
import { routeDeniesRemoteOf, routeLocatorOf, routeMaxBodyOf, routeMethodsOf, routePrefixOf, routeRewriteFieldsOf, routeRewritesIdsOf, routeUpgradesOf } from './plugin-bridge.js';
import { PassThrough, Readable, Transform } from 'node:stream';
import { fromVirtual, isVirtual, toVirtual } from './virtual-id.js';
import { adapterPathMatches, classifyAdapterRequest, rewriteAdapterRequest, adapterOwnsRegistryEntry, MAX_ADAPTER_RESPONSE_BUFFER_BYTES, ADAPTER_RESPONSE_HEADER_ALLOWLIST, AdapterMultiValueQueryError } from './plugin-adapter-core.js';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** PB-22: the rewriteIds deep scan — every string in the parsed JSON that is
 * EXACTLY a key of `known` becomes its virtual form; everything else passes
 * through untouched. The mapping's membership is the ONLY rewrite trigger —
 * no shape guessing (a session-id-LOOKING string the request never carried
 * is not ours to rewrite), and object KEYS are left alone: the scan walks
 * object values, array items and bare strings, exactly the positions a
 * response can hand an id back to the browser in. Containers are rebuilt
 * unconditionally, which keeps the rule obvious at the cost of allocations
 * bounded by the 8 MB buffer cap.
 *
 * PB-25b adds the second lookup: a string exactly equal to a member of
 * `knownIds` (the merged streams' known-real-session inventory, `undefined`
 * when the wiring passed none — the scan then stays exactly the request-local
 * behavior) is rewritten into THIS request's virtual shell, same source as
 * the position rewrite's serverId. Already-virtual strings are never
 * re-wrapped, and the set is read-only: the scan consults it, never mutates
 * it. */
function deepRewriteIds(value, known, knownIds, serverId) {
    if (typeof value === 'string') {
        const mapped = known.get(value);
        if (mapped !== undefined)
            return mapped;
        if (knownIds !== undefined && !isVirtual(value) && knownIds.has(value))
            return toVirtual(serverId, value);
        return value;
    }
    if (Array.isArray(value))
        return value.map((item) => deepRewriteIds(item, known, knownIds, serverId));
    if (isRecord(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value))
            out[key] = deepRewriteIds(item, known, knownIds, serverId);
        return out;
    }
    return value;
}
/** PB-25a: the position-based half of a `rewriteIds: { fields }` route's
 * rewrite. Runs AFTER the value scan above, on the (rebuilt, private) parsed
 * answer: each declared dot path is walked object-by-object, and a path that
 * exists and holds a NON-EMPTY, NON-virtual string gains its virtual shell
 * (`zr~<serverId>~<id>`, the serverId of the request this answer belongs to
 * — a forward always located one). A path that does not exist — or that
 * would walk through an array or a scalar — is a no-op: the answer's shape
 * is the plugin's business, never a rewrite trigger (no shape guessing), and
 * array elements stay the value scan's business (the declaration refuses
 * numeric segments outright). Already-virtual values are skipped, so a known
 * id sitting on a declared path is rewritten exactly once, by whichever half
 * reached it first. Returns the virtual ids this pass MINTED (PB-26a) —
 * exactly the positions it wrapped, deduped; a position the value scan
 * already wrapped is not a mint (that row is in the browser's view). */
function rewriteIdsAtFields(root, fields, serverId) {
    const minted = new Set();
    for (const field of fields) {
        const segments = field.split('.');
        let node = root;
        for (const segment of segments.slice(0, -1)) {
            node = isRecord(node) ? node[segment] : undefined;
        }
        if (!isRecord(node))
            continue;
        const key = segments[segments.length - 1];
        const value = node[key];
        if (typeof value === 'string' && value !== '' && !isVirtual(value)) {
            const virtualId = toVirtual(serverId, value);
            node[key] = virtualId;
            minted.add(virtualId);
        }
    }
    return [...minted];
}
/** Pump a response body reader into the browser response with real
 * backpressure — the one discipline every verbatim passthrough runs. The
 * `close` listener settles the wait when the browser vanishes mid-body (a
 * lost drain event would otherwise hang the write loop). */
async function pumpResponse(res, reader) {
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        if (!res.write(value)) {
            await new Promise((resolve) => {
                const settled = () => {
                    res.off('drain', settled);
                    res.off('close', settled);
                    resolve();
                };
                res.once('drain', settled);
                res.once('close', settled);
            });
        }
    }
}
/** PB-22/PB-25a/PB-25b: a rewriteIds route's JSON answer — buffered whole
 * (the 8 MB adapter cap), deep-scanned with the request's own real→virtual
 * mapping PLUS the known-real-session inventory (read live by the caller),
 * plus, when the route declared field paths, the position rewrite on those
 * paths, re-serialized with a corrected content-length. Past the cap, a
 * non-JSON content type, or a parse failure the answer passes through
 * untouched (the adapter discipline): a rewrite is strictly
 * better-than-nothing, never a reason to mangle or refuse an answer. The
 * caller has already handled the relay's refusal marker — this owns the
 * entire normal answer. PB-26a: the virtual ids the position rewrite minted
 * are reported through `onMinted` — at most once per answer, only when there
 * are any, and only after the rewritten body is what the browser receives
 * (a serialization failure passes the original bytes and reports nothing). */
async function answerRewriteIds(res, response, known, fields, serverId, knownIds, onMinted) {
    const contentType = response.headers.get('content-type');
    const verbatimHeaders = {
        ...(contentType !== null ? { 'content-type': contentType } : {}),
        ...(response.headers.get('content-length') !== null ? { 'content-length': response.headers.get('content-length') } : {}),
        ...(response.headers.get('cache-control') !== null ? { 'cache-control': response.headers.get('cache-control') } : {}),
    };
    const reader = response.body?.getReader();
    if (reader === undefined || contentType === null || !contentType.includes('application/json')) {
        res.writeHead(response.status, verbatimHeaders);
        if (reader !== undefined)
            await pumpResponse(res, reader);
        res.end();
        return;
    }
    const chunks = [];
    let size = 0;
    let overflow = false;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.length;
        // The over-cap chunk ITSELF is body content — it lands in the
        // passthrough buffer too; only the REWRITE is cancelled.
        chunks.push(Buffer.from(value));
        if (size > MAX_ADAPTER_RESPONSE_BUFFER_BYTES) {
            overflow = true;
            break;
        }
    }
    if (overflow) {
        res.writeHead(response.status, verbatimHeaders);
        for (const chunk of chunks) {
            if (!res.write(chunk)) {
                await new Promise((resolve) => {
                    const settled = () => {
                        res.off('drain', settled);
                        res.off('close', settled);
                        resolve();
                    };
                    res.once('drain', settled);
                    res.once('close', settled);
                });
            }
        }
        await pumpResponse(res, reader);
        res.end();
        return;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let outBody;
    let minted = [];
    try {
        const scanned = deepRewriteIds(JSON.parse(text), known, knownIds, serverId);
        if (fields !== undefined)
            minted = rewriteIdsAtFields(scanned, fields, serverId);
        outBody = Buffer.from(JSON.stringify(scanned), 'utf8');
    }
    catch {
        // Not JSON after all (or the scan hit something unserializable): the
        // original bytes pass through, length recomputed for the corrected
        // header set.
        outBody = Buffer.from(text, 'utf8');
        res.writeHead(response.status, { ...verbatimHeaders, 'content-length': String(outBody.length) });
        res.end(outBody);
        return;
    }
    res.writeHead(response.status, { ...verbatimHeaders, 'content-length': String(outBody.length) });
    res.end(outBody);
    if (minted.length > 0 && onMinted !== undefined) {
        try {
            onMinted(minted);
        }
        catch {
            // Bookkeeping for the sidebar — never a reason to fail an answer
            // the browser already has.
        }
    }
}
/** Pure inspection of the RAW webServer instance — nothing is mutated, so a
 * failed check leaves every route exactly as it was. */
export function checkWebServerShape(webServer) {
    if (!isRecord(webServer))
        return { ok: false, reasons: ['webServer: not an object'] };
    const reasons = [];
    if (typeof webServer.match !== 'function')
        reasons.push('match: not a function');
    if (!(webServer.exact instanceof Map))
        reasons.push('exact: not a Map');
    if (!(webServer.prefixes instanceof Map))
        reasons.push('prefixes: not a Map');
    if (!(webServer.upgrades instanceof Map))
        reasons.push('upgrades: not a Map');
    if (reasons.length > 0)
        return { ok: false, reasons };
    return { ok: true };
}
/** Longest failure ring kept for the status surface. */
const MAX_FAILURES = 10;
/** The NormalizedBridgeRoute read through the adapter-core route shapes
 * (PB-21): the declaration-v2 locators must ride the SAME locate →
 * classify → rewrite functions the adapters run — never a second copy of
 * those rules — so the cooperative route is handed to them as the
 * NormalizedAdapterRoute those functions consume. Every field comes from a
 * plugin-bridge effective reader; `deny` stays unset — the cooperative
 * `deny: true` flag is a static declaration, not an adapter-style hook, so
 * the surrogate halves judge it themselves (PB-22). */
function bridgeRouteAsAdapterRoute(route) {
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
export function installPluginRouteIntercept(options) {
    // Shape FIRST, like every wrap: a caller that skipped checkWebServerShape
    // (or a host whose shape changed between the check and this call) gets an
    // INERT handle — nothing on the instance is touched — instead of a
    // TypeError from a missing table midway through the install.
    const shape = checkWebServerShape(options.webServer);
    if (!shape.ok) {
        options.log?.('plugin route intercept refused: %s', shape.reasons.join('; '));
        return {
            uninstall() { },
            diagnostics() {
                return {
                    installed: false,
                    shape,
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
            },
        };
    }
    const { webServer, registry, relay, getServerId, getStatus, log } = options;
    const adapters = options.adapters ?? [];
    const getCurrentSession = options.getCurrentSession;
    const getKnownRealIds = options.getKnownRealIds;
    const onMintedVirtualIds = options.onMintedVirtualIds;
    const target = webServer;
    const savedMatch = target.match;
    let installed = true;
    let forwarded = 0;
    let refused = 0;
    let adapterForwarded = 0;
    let adapterResponseRewrites = 0;
    let adapterResponsePassthroughs = 0;
    let tunnelsCurrent = 0;
    let tunnelsOpened = 0;
    let tunnelsClosed = 0;
    const refusalsByReason = {};
    const recentFailures = [];
    /** The unbridged refusal written straight onto an upgrading socket
     * (PB-10): the WebSocket handshake never happened, so the "response" is
     * hand-written HTTP — same shape, same marker, then the socket dies
     * without the local plugin ever seeing the connection. */
    const answerUnbridgedSocket = (socket, plugin, reason) => {
        recordRefusal(plugin, reason);
        log?.('plugin upgrade refused for %s: %s', plugin, reason);
        const body = Buffer.from(JSON.stringify({ ok: false, error: { code: 'zr-plugin-unbridged', reason, plugin } }), 'utf8');
        try {
            socket.write(`HTTP/1.1 503 Service Unavailable\r\n` +
                `x-zen-remote: unbridged\r\n` +
                `content-type: application/json; charset=utf-8\r\n` +
                `content-length: ${body.length}\r\n` +
                `connection: close\r\n` +
                `\r\n`);
            socket.end(body);
        }
        catch {
            // The socket was already gone.
        }
    };
    const recordRefusal = (plugin, reason) => {
        refused += 1;
        refusalsByReason[reason] = (refusalsByReason[reason] ?? 0) + 1;
        if (recentFailures.length >= MAX_FAILURES)
            recentFailures.shift();
        recentFailures.push({ time: new Date().toISOString(), plugin, reason });
    };
    /** The uniform unbridged 503: one shape for every refusal, the local
     * plugin handler never reached. */
    const answerUnbridged = (res, plugin, reason) => {
        recordRefusal(plugin, reason);
        log?.('plugin route refused for %s: %s', plugin, reason);
        res.setHeader('x-zen-remote', 'unbridged');
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.writeHead(503);
        res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-unbridged', reason, plugin } }));
    };
    /** The original route handler when it is worth calling at all. */
    const handlerOf = (route) => route !== undefined && isRecord(route) && typeof route.handler === 'function'
        ? route.handler
        : undefined;
    /** The declared route this pathname hits — exact equality, or, for a
     * route declared `prefix: true` (PB-21), equality or one path segment
     * deeper on the RAW undecoded pathname. The rule is `adapterPathMatches`
     * itself, run against the route's adapter-core view, so the cooperative
     * match can never drift from the adapters'. First plugin in registry
     * order wins, and within it the first route in declaration order — a
     * pathname two routes of one plugin can both hit belongs to the earlier
     * one, exactly as the exact-only lookup always did. */
    const declaredRouteOf = (pathname) => {
        for (const declaration of registry.list()) {
            for (const route of declaration.routes) {
                const view = bridgeRouteAsAdapterRoute(route);
                if (!adapterPathMatches(view, pathname))
                    continue;
                return {
                    plugin: declaration.plugin,
                    version: declaration.version,
                    digest: declaration.digest,
                    path: route.path,
                    locator: routeLocatorOf(route),
                    prefix: routePrefixOf(route),
                    methods: routeMethodsOf(route),
                    maxBody: routeMaxBodyOf(route),
                    deny: routeDeniesRemoteOf(route),
                    rewriteIds: routeRewritesIdsOf(route),
                    rewriteFields: routeRewriteFieldsOf(route),
                    view,
                };
            }
        }
        return undefined;
    };
    /** The surrogate handler, query locator's half (every 2.1 route and an
     * explicit query declaration): ONE query parse, the virtual-id gate, the
     * unbridged walls in contract order, then the relay round-trip. A
     * declaration-v2 locator dispatches to the PB-21 half below. */
    const surrogateHandler = (declared, originalHandler) => async (req, res) => {
        const passthrough = async () => {
            if (originalHandler !== undefined) {
                await originalHandler(req, res);
                return;
            }
            res.writeHead(404);
            res.end();
        };
        // Chained-over: inert passthrough, exactly the posture of the other
        // intercepts.
        if (!installed) {
            await passthrough();
            return;
        }
        // PB-21: a v2 locator (path-segment / json-body) runs the adapter-core
        // pipeline in its own half — the query locator keeps THIS code path
        // verbatim. The dispatch sits after the installed check, so the v2
        // half never runs chained-over either.
        if (declared.locator.in !== 'query') {
            await surrogateV2Handler(declared, originalHandler)(req, res);
            return;
        }
        // ONE parse of the query (the session parameter's home — `match` only
        // ever saw the pathname): everything below reads THIS parse. The
        // parameter NAME is the effective locator's (the 2.1 sessionParam for
        // a route that declared no locator — the same value routeLocatorOf
        // reads back out).
        let requestUrl;
        try {
            requestUrl = new URL(req.url ?? '/', 'http://local');
        }
        catch {
            answerUnbridged(res, declared.plugin, 'bad-query');
            return;
        }
        const searchParams = requestUrl.searchParams;
        const values = searchParams.getAll(declared.locator.name);
        // The parameter appearing MORE than once is a shape violation the
        // bridge refuses (bad-query) — never a passthrough, and never a
        // forward of whichever duplicate a parser happens to keep. Its TOTAL
        // absence, though, is the LOCAL route's business (a whole-machine
        // route may simply not take one).
        if (values.length > 1) {
            answerUnbridged(res, declared.plugin, 'bad-query');
            return;
        }
        const value = values.length === 1 ? values[0] : undefined;
        // PB-22: a `deny: true` route refuses a REMOTE context outright — the
        // request locating a virtual id, or the browser's CURRENT session
        // being one (T62's signal; requests like open.external carry no id of
        // their own). The uniform 503 with the route's own reason: the local
        // handler is never reached, and the forward path below is unreachable
        // for this route. A local session's request without a virtual id falls
        // through — `deny` must not touch local behavior.
        if (declared.deny) {
            const current = getCurrentSession?.();
            if ((current !== undefined && isVirtual(current)) || (value !== undefined && value.startsWith('zr~'))) {
                answerUnbridged(res, declared.plugin, 'route-denied');
                return;
            }
        }
        // A LOCAL id (or none at all): the original route's business — its
        // handler runs exactly as if we were never here.
        if (value === undefined || value === '' || !value.startsWith('zr~')) {
            await passthrough();
            return;
        }
        const parts = fromVirtual(value);
        if (parts === undefined || parts.id === '') {
            answerUnbridged(res, declared.plugin, 'bad-query');
            return;
        }
        if (parts.serverId !== getServerId()) {
            answerUnbridged(res, declared.plugin, 'server-changed');
            return;
        }
        // PB-9: the method must be one the route declared — the write surface
        // is exactly as explicit as the read one was in 2.1, and an undeclared
        // method never reaches the local plugin OR the relay.
        const method = req.method ?? 'GET';
        if (!declared.methods.includes(method)) {
            answerUnbridged(res, declared.plugin, 'method-not-bridged');
            return;
        }
        // PB-9: the body gate, BEFORE a byte moves — a declared
        // Content-Length past the route's `maxBody` is refused locally (the
        // relay would refuse it at the streaming count anyway; refusing here
        // saves the round-trip and keeps the plugin out of it entirely).
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const declaredLength = Number(req.headers['content-length']);
        if (hasBody && Number.isFinite(declaredLength) && declaredLength > declared.maxBody) {
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.writeHead(413);
            res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-body-too-large' } }));
            recordRefusal(declared.plugin, 'body-too-large');
            log?.('plugin request for %s refused locally: body-too-large (%s declared)', declared.path, req.headers['content-length']);
            return;
        }
        const status = getStatus().find((entry) => entry.plugin === declared.plugin);
        if (status === undefined || !status.bridged) {
            answerUnbridged(res, declared.plugin, status?.reason ?? 'not-on-server');
            return;
        }
        forwarded += 1;
        // Logged HERE, after the virtual-id gate (PB-5-fix): a local panel
        // polling its route every second must not log a line a second — the
        // bridge only speaks when a request actually leaves for the relay (or
        // is refused below, which answerUnbridged logs).
        log?.('plugin route %s forwards for %s', declared.path, declared.plugin);
        // The session id rides the CHECKED parse, restored to its ORIGINAL
        // form, re-serialized once — what was judged is what is forwarded.
        searchParams.set(declared.locator.name, parts.id);
        // PB-22: the request's own real→virtual pair — the READ-ONLY mapping a
        // rewriteIds route's answer scan consults (`zr~` carries the real id
        // inside, so the ids this very request named are exactly the ones the
        // answer may hand back). PB-25b: the scan consults ONE more source
        // beside this mapping — the known-real-session inventory, read live at
        // the answer (never copied here) and consumed read-only; nothing here
        // writes any session table.
        const idMapping = new Map([[parts.id, value]]);
        const controller = new AbortController();
        // The counting gate's failure has its OWN abort signal (PB-9-fix, the
        // mirror of the relay route's bodyGateError): tripping the gate is a
        // LOCAL verdict — it must tear the relay round-trip down AND be
        // readable in the catch below without depending on the error MESSAGE
        // surviving undici's fetch rejection. It also tells the relay client
        // (through the aborted signal) that this is a caller abort, never a
        // transport death.
        let bodyGateFailed = false;
        const bodyAbort = new AbortController();
        const forwardSignal = AbortSignal.any([controller.signal, bodyAbort.signal]);
        const onClientGone = () => {
            if (!res.writableEnded)
                controller.abort();
        };
        res.on('close', onClientGone);
        try {
            const accept = typeof req.headers.accept === 'string' ? req.headers.accept : undefined;
            const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
            const requestContentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
            // PB-9: the request body streams through a counting Transform —
            // node's pipe owns the backpressure, and the route's `maxBody` is
            // enforced ON THE STREAM for a chunked body (no Content-Length for
            // the pre-check above to read). Past the cap the gate errors, which
            // aborts the relay round-trip mid-flight and answers the local 413
            // below (the browser's headers are not out — nothing ever started).
            let bodyStream = null;
            if (hasBody) {
                let pumped = 0;
                const gate = new Transform({
                    transform(chunk, _encoding, callback) {
                        pumped += chunk.length;
                        if (pumped > declared.maxBody) {
                            callback(new Error('zr-plugin-body-too-large'));
                            return;
                        }
                        callback(null, chunk);
                    },
                });
                req.on('error', (error) => gate.destroy(error));
                gate.on('error', () => {
                    if (!bodyGateFailed)
                        bodyGateFailed = true;
                    bodyAbort.abort();
                });
                // The fetch body must be a WEB ReadableStream (undici's contract);
                // Readable.toWeb adapts the counting gate, preserving backpressure.
                bodyStream = Readable.toWeb(gate);
                req.pipe(gate);
            }
            const response = await relay.pluginRequest({
                plugin: declared.plugin,
                version: declared.version,
                digest: declared.digest,
                // A prefix route (PB-21) forwards its FULL matched pathname —
                // the declared base alone would lose the variable tail; an
                // exact route's pathname IS the declared path, the bytes that
                // always travelled.
                path: declared.prefix ? requestUrl.pathname : declared.path,
                query: searchParams.toString(),
                method,
                ...(hasBody ? { body: bodyStream } : {}),
                ...(hasBody && requestContentType !== undefined ? { contentType: requestContentType } : {}),
                ...(hasBody && Number.isFinite(declaredLength) && declaredLength > 0 ? { contentLength: declaredLength } : {}),
                ...(accept !== undefined ? { accept } : {}),
                ...(range !== undefined ? { range } : {}),
            }, forwardSignal);
            // A relay-side refusal travels its OWN marker header (PB-3); the
            // browser sees the uniform unbridged shape with that code as the
            // reason. The relay's JSON body is disposed unread.
            const refusal = response.headers.get('x-zen-remote-error');
            if (refusal !== null) {
                await response.body?.cancel().catch(() => { });
                answerUnbridged(res, declared.plugin, refusal);
                return;
            }
            // PB-22: a rewriteIds route's answer is buffered and deep-scanned
            // (the ids this request named come back virtual); everything else —
            // non-JSON answers included — streams verbatim. PB-25a: a
            // `{ fields }` declaration adds the position rewrite, under THIS
            // request's own server id. PB-25b: the scan's lookup widens to the
            // known inventory, read live right here (undefined when the wiring
            // passed no getter — the scan stays request-local).
            if (declared.rewriteIds) {
                await answerRewriteIds(res, response, idMapping, declared.rewriteFields, parts.serverId, getKnownRealIds?.(), onMintedVirtualIds);
                return;
            }
            const contentType = response.headers.get('content-type');
            const contentLength = response.headers.get('content-length');
            const cacheControl = response.headers.get('cache-control');
            res.writeHead(response.status, {
                ...(contentType !== null ? { 'content-type': contentType } : {}),
                ...(contentLength !== null ? { 'content-length': contentLength } : {}),
                ...(cacheControl !== null ? { 'cache-control': cacheControl } : {}),
            });
            // Stream the body through with real backpressure; a mid-stream
            // failure with headers already out can only cut the response.
            const reader = response.body?.getReader();
            if (reader !== undefined)
                await pumpResponse(res, reader);
            res.end();
        }
        catch (error) {
            // The gate's local flag FIRST (PB-9-fix): the counting gate tripped
            // mid-forward — the chunked body outgrew the route's `maxBody` while
            // the relay round-trip was still being written. The browser's
            // headers are not out, so the local 413 still fits — same shape the
            // pre-check above answers. The flag is local on purpose: the gate's
            // error cannot be relied on to survive undici's fetch rejection
            // wrapper, and the relay client has (correctly) NOT judged the link
            // offline for a caller abort — answering from the wire's error would
            // misreport this as 503 offline.
            if (bodyGateFailed && !res.headersSent) {
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.writeHead(413);
                res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-body-too-large' } }));
                recordRefusal(declared.plugin, 'body-too-large');
                return;
            }
            if (controller.signal.aborted || res.destroyed || res.headersSent) {
                // The browser is gone (its abort tore the relay round-trip down)
                // or the body already started: the status cannot change, so the
                // response is cut.
                try {
                    res.destroy();
                }
                catch {
                    // Already gone.
                }
                return;
            }
            const code = typeof error?.code === 'string' ? error.code : 'offline';
            answerUnbridged(res, declared.plugin, code === 'aborted' ? 'offline' : code);
        }
        finally {
            res.off('close', onClientGone);
        }
    };
    /** The PB-21 surrogate half for the declaration-v2 locators — json-body,
     * and path-segment on a prefix route: the adapter surrogate's pipeline
     * (locate → classify → walls → rewrite → the relay round-trip) run
     * through the SAME adapter-core functions against the route's
     * adapter-core view. The response discipline stays the query half's —
     * three headers, no hooks: `deny` and `rewriteIds` are PB-22's business.
     * Dispatch above guarantees `installed` and a non-query locator. */
    const surrogateV2Handler = (declared, originalHandler) => async (req, res) => {
        const plugin = declared.plugin;
        // The local passthrough. A json-body route has ALREADY consumed the
        // request body by the time this runs (the classify needs the parsed
        // body), so the replay hands the buffered bytes back behind the
        // original request's metadata — the shape a local handler actually
        // reads (method/url/headers/pipe).
        const passthrough = async (replayBody) => {
            if (originalHandler === undefined) {
                res.writeHead(404);
                res.end();
                return;
            }
            if (replayBody !== undefined) {
                const replay = new PassThrough();
                replay.end(replayBody);
                Object.assign(replay, { method: req.method, url: req.url, headers: req.headers });
                await originalHandler(replay, res);
                return;
            }
            await originalHandler(req, res);
        };
        let controller;
        const onClientGone = () => {
            if (controller !== undefined && !res.writableEnded)
                controller.abort();
        };
        res.on('close', onClientGone);
        // The counting gate's LOCAL flag (the query half's PB-9-fix shape): a
        // tripped gate answers the local 413 in the catch below — never an
        // offline verdict, never a half-written response.
        let bodyGateFailed = false;
        const bodyAbort = new AbortController();
        try {
            let url;
            try {
                url = new URL(req.url ?? '/', 'http://local');
            }
            catch {
                answerUnbridged(res, plugin, 'bad-query');
                return;
            }
            const pathname = url.pathname;
            const searchParams = url.searchParams;
            const method = req.method ?? 'GET';
            const hasBody = method !== 'GET' && method !== 'HEAD';
            // PB-22: the deny wall's current-session half — a remote panel is
            // the request's origin even when it carries no id of its own
            // (open.external's shape). Refused before any body byte is read.
            if (declared.deny) {
                const current = getCurrentSession?.();
                if (current !== undefined && isVirtual(current)) {
                    answerUnbridged(res, plugin, 'route-denied');
                    return;
                }
            }
            // A json-body route buffers the request body up front, bounded by
            // the route's own maxBody — the cooperative 413 shape, answered
            // locally, the plugin never reached. A path-segment route's body is
            // never consumed by locating; it streams through the counting gate
            // at the forward.
            let bufferedBody;
            if (hasBody && declared.locator.in === 'json-body') {
                const chunks = [];
                let size = 0;
                let over = false;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > declared.maxBody) {
                        over = true;
                        break;
                    }
                    chunks.push(Buffer.from(chunk));
                }
                if (over) {
                    res.setHeader('content-type', 'application/json; charset=utf-8');
                    res.writeHead(413);
                    res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-body-too-large' } }));
                    recordRefusal(plugin, 'body-too-large');
                    log?.('plugin request for %s refused locally: body-too-large (%s buffered)', declared.path, size);
                    return;
                }
                bufferedBody = Buffer.concat(chunks);
            }
            // A present body must parse as JSON when the route locates in it —
            // a corrupted body refuses rather than falling through to the local
            // plugin with a body the locate could not judge (the adapter half's
            // shared rule).
            let parsedBody;
            let bodyGiven = false;
            if (hasBody && declared.locator.in === 'json-body' && bufferedBody !== undefined && bufferedBody.length > 0) {
                try {
                    parsedBody = JSON.parse(bufferedBody.toString('utf8'));
                    bodyGiven = true;
                }
                catch {
                    answerUnbridged(res, plugin, 'bad-query');
                    return;
                }
            }
            // The remote/local verdict on the ids as they arrived — the
            // adapter-core classify (locate inside), no second copy of the
            // rule: every id virtual → forward, none → local, a mix → the
            // uniform refusal (docs/adr/0001: a remote session never reaches a
            // local plugin).
            let verdict;
            try {
                verdict = classifyAdapterRequest(declared.view, pathname, searchParams, bodyGiven ? parsedBody : undefined);
            }
            catch (error) {
                if (error instanceof AdapterMultiValueQueryError) {
                    answerUnbridged(res, plugin, 'bad-query');
                    return;
                }
                throw error;
            }
            // PB-22: the deny wall's request half — the locate found a virtual
            // id (a remote verdict, or a mixed one: that too means a virtual id
            // sat in the request). This route never serves a remote context, so
            // the answer is the route's own refusal, not the mixed shape.
            if (declared.deny && verdict.kind !== 'local') {
                answerUnbridged(res, plugin, 'route-denied');
                return;
            }
            if (verdict.kind === 'local') {
                await passthrough(bufferedBody);
                return;
            }
            if (verdict.kind === 'mixed') {
                answerUnbridged(res, plugin, 'bad-query');
                return;
            }
            // Remote: the route's method wall, then the per-id server walls —
            // the query half's gates, re-run per located id.
            if (!declared.methods.includes(method)) {
                answerUnbridged(res, plugin, 'method-not-bridged');
                return;
            }
            const serverId = getServerId();
            // PB-22: the request's own real→virtual pairs, collected while the
            // wall validates each hit — the READ-ONLY mapping a rewriteIds
            // route's answer scan consults (`zr~` carries the real id inside, so
            // the ids this very request named are exactly the ones the answer
            // may hand back). PB-25a: the SAME unwrap hands the position rewrite
            // its server id — the ids this request located live under it, so a
            // NEWLY-created id joins them (the query half's source verbatim;
            // `remote` always has at least one hit). PB-25b: the scan consults
            // ONE more source beside this mapping — the known-real-session
            // inventory, read live at the answer (never copied here) and
            // consumed read-only; nothing here writes any session table.
            const idMapping = new Map();
            let locatedServerId;
            for (const idHit of verdict.hits) {
                const parts = fromVirtual(idHit.value);
                if (parts === undefined || parts.id === '') {
                    answerUnbridged(res, plugin, 'bad-query');
                    return;
                }
                if (parts.serverId !== serverId) {
                    answerUnbridged(res, plugin, 'server-changed');
                    return;
                }
                idMapping.set(parts.id, idHit.value);
                locatedServerId = parts.serverId;
            }
            // The bridge verdicts judged from the SAME live table the query
            // half reads.
            const status = getStatus().find((entry) => entry.plugin === plugin);
            if (status === undefined || !status.bridged) {
                answerUnbridged(res, plugin, status?.reason ?? 'not-on-server');
                return;
            }
            // Real ids in, coordinates rewritten — the adapter-core rewrite:
            // the query re-serialized, the path segment re-encoded, the JSON
            // body re-serialized. The forward carries the REWRITTEN pathname —
            // a prefix route's full matched path, never the declared base.
            const rewrite = rewriteAdapterRequest(declared.view, pathname, searchParams, bodyGiven ? parsedBody : undefined, verdict.hits, (virtualId) => fromVirtual(virtualId).id);
            forwarded += 1;
            log?.('plugin route %s forwards for %s', rewrite.pathname, plugin);
            controller = new AbortController();
            const forwardSignal = AbortSignal.any([controller.signal, bodyAbort.signal]);
            const accept = typeof req.headers.accept === 'string' ? req.headers.accept : undefined;
            const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
            const requestContentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
            const declaredLength = Number(req.headers['content-length']);
            let bodyStream = null;
            let contentLength;
            if (hasBody && declared.locator.in === 'json-body') {
                // The buffer forwards in full: the (possibly rewritten)
                // re-serialization when ids sat in it, the original bytes
                // otherwise. The REWRITTEN byte count is the declared length —
                // the budget reads what actually travels.
                const payload = rewrite.bodyText !== undefined ? Buffer.from(rewrite.bodyText, 'utf8') : bufferedBody ?? Buffer.alloc(0);
                contentLength = payload.length;
                bodyStream = Readable.toWeb(Readable.from(payload));
            }
            else if (hasBody) {
                // The pre-check first — a DECLARED Content-Length past the cap
                // never starts a round-trip — then the counting gate for a
                // chunked body, exactly the query half's PB-9 discipline.
                if (Number.isFinite(declaredLength) && declaredLength > declared.maxBody) {
                    res.setHeader('content-type', 'application/json; charset=utf-8');
                    res.writeHead(413);
                    res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-body-too-large' } }));
                    recordRefusal(plugin, 'body-too-large');
                    log?.('plugin request for %s refused locally: body-too-large (%s declared)', declared.path, req.headers['content-length']);
                    return;
                }
                let pumped = 0;
                const gate = new Transform({
                    transform(chunk, _encoding, callback) {
                        pumped += chunk.length;
                        if (pumped > declared.maxBody) {
                            callback(new Error('zr-plugin-body-too-large'));
                            return;
                        }
                        callback(null, chunk);
                    },
                });
                req.on('error', (error) => gate.destroy(error));
                gate.on('error', () => {
                    if (!bodyGateFailed)
                        bodyGateFailed = true;
                    bodyAbort.abort();
                });
                bodyStream = Readable.toWeb(gate);
                req.pipe(gate);
                if (Number.isFinite(declaredLength) && declaredLength > 0)
                    contentLength = declaredLength;
            }
            const response = await relay.pluginRequest({
                plugin,
                version: declared.version,
                digest: declared.digest,
                path: rewrite.pathname,
                query: rewrite.query.toString(),
                method,
                ...(bodyStream !== null ? { body: bodyStream } : {}),
                ...(bodyStream !== null && requestContentType !== undefined ? { contentType: requestContentType } : {}),
                ...(bodyStream !== null && contentLength !== undefined ? { contentLength } : {}),
                ...(accept !== undefined ? { accept } : {}),
                ...(range !== undefined ? { range } : {}),
            }, forwardSignal);
            // Down from here the query half's response discipline verbatim: the
            // relay refusal marker, the three cooperative headers, the pump
            // with real backpressure — plus (PB-22) the rewriteIds branch.
            const refusal = response.headers.get('x-zen-remote-error');
            if (refusal !== null) {
                await response.body?.cancel().catch(() => { });
                answerUnbridged(res, plugin, refusal);
                return;
            }
            if (declared.rewriteIds) {
                await answerRewriteIds(res, response, idMapping, declared.rewriteFields, locatedServerId, getKnownRealIds?.(), onMintedVirtualIds);
                return;
            }
            const contentType = response.headers.get('content-type');
            const responseLength = response.headers.get('content-length');
            const cacheControl = response.headers.get('cache-control');
            res.writeHead(response.status, {
                ...(contentType !== null ? { 'content-type': contentType } : {}),
                ...(responseLength !== null ? { 'content-length': responseLength } : {}),
                ...(cacheControl !== null ? { 'cache-control': cacheControl } : {}),
            });
            const reader = response.body?.getReader();
            if (reader !== undefined)
                await pumpResponse(res, reader);
            res.end();
        }
        catch (error) {
            // The gate's local flag first (the query half's shape): the 413
            // still fits while the browser's headers are not out.
            if (bodyGateFailed && !res.headersSent) {
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.writeHead(413);
                res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-body-too-large' } }));
                recordRefusal(plugin, 'body-too-large');
                return;
            }
            if (controller?.signal.aborted || res.destroyed || res.headersSent) {
                try {
                    res.destroy();
                }
                catch {
                    // Already gone.
                }
                return;
            }
            const code = typeof error?.code === 'string' ? error.code : 'offline';
            answerUnbridged(res, plugin, code === 'aborted' ? 'offline' : code);
        }
        finally {
            res.off('close', onClientGone);
        }
    };
    // ---- PB-11: the adapter interception ---------------------------------------
    //
    // An adapter (src/adapters/, validated into a NormalizedAdapter by the
    // wiring) claims routes of a NON-cooperative plugin: the match lookup
    // below hands one of those requests to a surrogate that locates the
    // session ids (query / path segment / JSON body), classifies the request
    // — every id virtual → forward, none → local passthrough, a mix → the
    // uniform 503 (docs/adr/0001: a remote session never reaches a local
    // plugin) — rewrites the ids to their real halves and forwards through
    // the SAME relay door the cooperative surrogate uses. On the way back a
    // `client.response` hook maps real ids to virtual form inside a buffered
    // JSON answer (8 MB cap; past it the answer passes through untouched).
    /** The adapter route this pathname hits, if any: only an adapter that
     * STILL owns its plugin's registry entry qualifies — a plugin's own
     * cooperative declaration always wins, and the adapter yields silently
     * here (the registration-time yield logged a line already). */
    const adapterRouteOf = (pathname) => {
        if (!installed || adapters.length === 0)
            return undefined;
        for (const adapter of adapters) {
            if (!adapterOwnsRegistryEntry(adapter, registry.get(adapter.plugin)))
                continue;
            for (const route of adapter.routes) {
                if (route.local)
                    continue;
                if (adapterPathMatches(route, pathname))
                    return { adapter, route };
            }
        }
        return undefined;
    };
    /** The adapter surrogate: locate → classify → walls → rewrite → hooks →
     * the relay round-trip, then the buffered JSON rewrite on the way back. */
    const adapterSurrogateHandler = (hit, originalHandler) => async (req, res) => {
        const { adapter, route } = hit;
        const plugin = adapter.plugin;
        // The local passthrough. A body-locating route has ALREADY consumed
        // the request body by the time this runs, so the replay hands the
        // buffered bytes back behind the original request's metadata — the
        // shape a local handler actually reads (method/url/headers/pipe).
        const passthrough = async (replayBody) => {
            if (originalHandler === undefined) {
                res.writeHead(404);
                res.end();
                return;
            }
            if (replayBody !== undefined) {
                const replay = new PassThrough();
                replay.end(replayBody);
                Object.assign(replay, { method: req.method, url: req.url, headers: req.headers });
                await originalHandler(replay, res);
                return;
            }
            await originalHandler(req, res);
        };
        // Chained-over: inert passthrough, exactly the posture of the other
        // intercepts.
        if (!installed) {
            await passthrough();
            return;
        }
        let controller;
        const onClientGone = () => {
            if (controller !== undefined && !res.writableEnded)
                controller.abort();
        };
        res.on('close', onClientGone);
        try {
            let url;
            try {
                url = new URL(req.url ?? '/', 'http://local');
            }
            catch {
                answerUnbridged(res, plugin, 'bad-query');
                return;
            }
            const pathname = url.pathname;
            const searchParams = url.searchParams;
            const method = req.method ?? 'GET';
            const hasBody = method !== 'GET' && method !== 'HEAD';
            // The route's deny hook runs BEFORE any id locating: a request the
            // adapter refuses on path grounds (better-sidebar's open.external
            // from a remote panel, the side-chat methods) answers here — these
            // requests often carry NO session field, so the classify below
            // would otherwise read them as local and let them through.
            if (route.deny !== undefined) {
                const denial = route.deny({ pathname, method, currentSessionId: getCurrentSession?.() });
                if (denial !== undefined) {
                    answerUnbridged(res, plugin, denial);
                    return;
                }
            }
            // A body-locating route buffers the request body up front (bounded
            // by the route's own maxBody — the cooperative 413 shape, answered
            // locally, the plugin never reached). Any other locator's body
            // streams through the cooperative counting gate below.
            let bufferedBody;
            if (hasBody && route.locator.in === 'json-body') {
                const chunks = [];
                let size = 0;
                let over = false;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > route.maxBody) {
                        over = true;
                        break;
                    }
                    chunks.push(Buffer.from(chunk));
                }
                if (over) {
                    res.setHeader('content-type', 'application/json; charset=utf-8');
                    res.writeHead(413);
                    res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-body-too-large' } }));
                    recordRefusal(plugin, 'body-too-large');
                    return;
                }
                bufferedBody = Buffer.concat(chunks);
            }
            // A present body must be a JSON object when the route locates in
            // the body: a remote request with a corrupted body refuses rather
            // than falling through to the local plugin.
            let parsedBody;
            let bodyGiven = false;
            if (hasBody && route.locator.in === 'json-body' && bufferedBody !== undefined && bufferedBody.length > 0) {
                try {
                    parsedBody = JSON.parse(bufferedBody.toString('utf8'));
                    bodyGiven = true;
                }
                catch {
                    answerUnbridged(res, plugin, 'bad-query');
                    return;
                }
            }
            // The remote/local verdict on the ids as they arrived. A duplicated
            // query id refuses rather than silently collapsing (PB-12 review).
            let verdict;
            try {
                verdict = classifyAdapterRequest(route, pathname, searchParams, bodyGiven ? parsedBody : undefined);
            }
            catch (error) {
                if (error instanceof AdapterMultiValueQueryError) {
                    answerUnbridged(res, plugin, 'bad-query');
                    return;
                }
                throw error;
            }
            if (verdict.kind === 'local') {
                await passthrough(bufferedBody);
                return;
            }
            if (verdict.kind === 'mixed') {
                answerUnbridged(res, plugin, 'bad-query');
                return;
            }
            // Remote: the route's method wall, then per-id server walls.
            if (!route.methods.includes(method)) {
                answerUnbridged(res, plugin, 'method-not-bridged');
                return;
            }
            const serverId = getServerId();
            for (const idHit of verdict.hits) {
                const parts = fromVirtual(idHit.value);
                if (parts === undefined || parts.id === '') {
                    answerUnbridged(res, plugin, 'bad-query');
                    return;
                }
                if (parts.serverId !== serverId) {
                    answerUnbridged(res, plugin, 'server-changed');
                    return;
                }
            }
            // The bridge verdicts (version skew, consent, offline…) judged from
            // the SAME live table the cooperative surrogate reads — the
            // adapter's registry entry makes the plugin indistinguishable from
            // a cooperative one here.
            const status = getStatus().find((entry) => entry.plugin === plugin);
            if (status === undefined || !status.bridged) {
                answerUnbridged(res, plugin, status?.reason ?? 'not-on-server');
                return;
            }
            // Real ids in, coordinates rewritten.
            const rewrite = rewriteAdapterRequest(route, pathname, searchParams, bodyGiven ? parsedBody : undefined, verdict.hits, (virtualId) => fromVirtual(virtualId).id);
            // The client hook: refuse, or replace the parsed body wholesale.
            // The hook sees the REWRITTEN body — the ids are already real (the
            // design's order: locate → rewrite → hook → forward).
            const hook = adapter.hooks.client?.request;
            if (hook !== undefined) {
                const hookedBody = bodyGiven && rewrite.bodyText !== undefined ? JSON.parse(rewrite.bodyText) : bodyGiven ? parsedBody : undefined;
                let hookVerdict;
                try {
                    hookVerdict = hook({ method, pathname, route, query: rewrite.query, body: hookedBody });
                }
                catch {
                    answerUnbridged(res, plugin, 'internal');
                    return;
                }
                if (!hookVerdict.allow) {
                    answerUnbridged(res, plugin, hookVerdict.reason);
                    return;
                }
                if (hookedBody !== undefined && hookVerdict.body !== undefined) {
                    rewrite.bodyText = JSON.stringify(hookVerdict.body);
                }
            }
            controller = new AbortController();
            adapterForwarded += 1;
            // The forward. A body-locating route sends its (possibly rewritten)
            // buffer; any other body rides the cooperative counting gate.
            const accept = typeof req.headers.accept === 'string' ? req.headers.accept : undefined;
            const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
            const requestContentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
            let bodyStream = null;
            let contentLength;
            if (hasBody && route.locator.in === 'json-body') {
                const payload = rewrite.bodyText !== undefined ? Buffer.from(rewrite.bodyText, 'utf8') : bufferedBody ?? Buffer.alloc(0);
                contentLength = payload.length;
                bodyStream = Readable.toWeb(Readable.from(payload));
            }
            else if (hasBody) {
                let pumped = 0;
                const gate = new Transform({
                    transform(chunk, _encoding, callback) {
                        pumped += chunk.length;
                        if (pumped > route.maxBody) {
                            callback(new Error('zr-plugin-body-too-large'));
                            return;
                        }
                        callback(null, chunk);
                    },
                });
                gate.on('error', () => controller?.abort());
                bodyStream = Readable.toWeb(gate);
                req.pipe(gate);
            }
            const response = await relay.pluginRequest({
                plugin,
                version: adapter.declaration.version,
                digest: adapter.digest,
                path: rewrite.pathname,
                query: rewrite.query.toString(),
                method,
                ...(bodyStream !== null ? { body: bodyStream } : {}),
                ...(bodyStream !== null && requestContentType !== undefined ? { contentType: requestContentType } : {}),
                ...(bodyStream !== null && contentLength !== undefined ? { contentLength } : {}),
                ...(accept !== undefined ? { accept } : {}),
                ...(range !== undefined ? { range } : {}),
            }, controller.signal);
            const refusal = response.headers.get('x-zen-remote-error');
            if (refusal !== null) {
                await response.body?.cancel().catch(() => { });
                answerUnbridged(res, plugin, refusal);
                return;
            }
            const contentType = response.headers.get('content-type');
            const responseLength = response.headers.get('content-length');
            const cacheControl = response.headers.get('cache-control');
            // The adapter header allowlist (PB-12): beyond the three cooperative
            // headers, the answers adapters carry may need their own — the HTML
            // preview's CSP sandbox, download dispositions, range headers. The
            // plugin wrote them; the browser needs them.
            const allowlistedHeaders = ADAPTER_RESPONSE_HEADER_ALLOWLIST.flatMap((name) => {
                const value = response.headers.get(name);
                return value !== null ? [{ [name]: value }] : [];
            });
            const responseHook = adapter.hooks.client?.response;
            const rewriteCandidate = responseHook !== undefined && !route.stream && contentType !== null && contentType.includes('application/json');
            if (!rewriteCandidate) {
                // The verbatim pump: chunk-for-chunk with real backpressure, the
                // cooperative surrogate's discipline.
                res.writeHead(response.status, {
                    ...(contentType !== null ? { 'content-type': contentType } : {}),
                    ...(responseLength !== null ? { 'content-length': responseLength } : {}),
                    ...(cacheControl !== null ? { 'cache-control': cacheControl } : {}),
                    ...Object.assign({}, ...allowlistedHeaders),
                });
                const reader = response.body?.getReader();
                if (reader !== undefined)
                    await pumpResponse(res, reader);
                res.end();
                return;
            }
            // The buffered rewrite: the whole answer (≤ 8 MB), parsed, hooked,
            // re-serialized with a corrected content-length. Past the cap — or
            // on a parse/hook failure — the answer passes through untouched.
            const reader = response.body.getReader();
            const chunks = [];
            let size = 0;
            let overflow = false;
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                size += value.length;
                // The over-cap chunk ITSELF is body content — it lands in the
                // passthrough buffer too; only the REWRITE is cancelled.
                chunks.push(Buffer.from(value));
                if (size > MAX_ADAPTER_RESPONSE_BUFFER_BYTES) {
                    overflow = true;
                    break;
                }
            }
            if (overflow) {
                adapterResponsePassthroughs += 1;
                res.writeHead(response.status, {
                    ...(contentType !== null ? { 'content-type': contentType } : {}),
                    ...(responseLength !== null ? { 'content-length': responseLength } : {}),
                    ...(cacheControl !== null ? { 'cache-control': cacheControl } : {}),
                    ...Object.assign({}, ...allowlistedHeaders),
                });
                for (const chunk of chunks) {
                    if (!res.write(chunk)) {
                        await new Promise((resolve) => {
                            const settled = () => {
                                res.off('drain', settled);
                                res.off('close', settled);
                                resolve();
                            };
                            res.once('drain', settled);
                            res.once('close', settled);
                        });
                    }
                }
                await pumpResponse(res, reader);
                res.end();
                return;
            }
            const text = Buffer.concat(chunks).toString('utf8');
            let rewrittenBody;
            // PB-26a: every id the hook virtualizes is a row the browser is
            // about to learn of (sidechat.start's childId) — collected here,
            // reported only once the hook's answer is what the browser gets.
            const minted = new Set();
            try {
                rewrittenBody = responseHook({
                    status: response.status,
                    pathname,
                    body: JSON.parse(text),
                    virtualize: (id) => {
                        const virtualId = toVirtual(serverId ?? '', id);
                        if (isVirtual(virtualId))
                            minted.add(virtualId);
                        return virtualId;
                    },
                    isVirtual: (value) => isVirtual(value),
                });
            }
            catch {
                adapterResponsePassthroughs += 1;
                const passthroughBody = Buffer.from(text, 'utf8');
                res.writeHead(response.status, {
                    ...(contentType !== null ? { 'content-type': contentType } : {}),
                    ...(cacheControl !== null ? { 'cache-control': cacheControl } : {}),
                    ...Object.assign({}, ...allowlistedHeaders),
                    'content-length': String(passthroughBody.length),
                });
                res.end(passthroughBody);
                return;
            }
            adapterResponseRewrites += 1;
            const outBody = Buffer.from(JSON.stringify(rewrittenBody), 'utf8');
            res.writeHead(response.status, {
                ...(contentType !== null ? { 'content-type': contentType } : {}),
                ...(cacheControl !== null ? { 'cache-control': cacheControl } : {}),
                ...Object.assign({}, ...allowlistedHeaders),
                'content-length': String(outBody.length),
            });
            res.end(outBody);
            if (minted.size > 0 && onMintedVirtualIds !== undefined) {
                try {
                    onMintedVirtualIds([...minted]);
                }
                catch {
                    // Sidebar bookkeeping — never a reason to fail an answer the
                    // browser already has.
                }
            }
        }
        catch (error) {
            if (controller?.signal.aborted || res.destroyed || res.headersSent) {
                try {
                    res.destroy();
                }
                catch {
                    // Already gone.
                }
                return;
            }
            const code = typeof error?.code === 'string' ? error.code : 'offline';
            answerUnbridged(res, plugin, code === 'aborted' ? 'offline' : code);
        }
        finally {
            res.off('close', onClientGone);
        }
    };
    /** The wrapped match: original verdict first, then the adapter routes
     * (PB-11 — BEFORE the declaration lookup: the adapter's registry entry
     * IS a declaration, and the cooperative surrogate's query-sessionParam
     * logic is not how an adapter request is judged), then the declaration
     * lookup — exact paths plus (PB-21) a declared prefix route's full
     * match. An undeclared pathname returns whatever the original match
     * answered, untouched. */
    const wrappedMatch = function match(pathname) {
        const route = savedMatch.call(this, pathname);
        if (!installed)
            return route;
        if (typeof pathname !== 'string' || !pathname.startsWith('/'))
            return route;
        const adapterHit = adapterRouteOf(pathname);
        if (adapterHit !== undefined) {
            return {
                kind: 'exact',
                path: pathname,
                handler: adapterSurrogateHandler(adapterHit, handlerOf(route)),
            };
        }
        const declared = declaredRouteOf(pathname);
        if (declared !== undefined) {
            return {
                kind: 'exact',
                path: pathname,
                handler: surrogateHandler(declared, handlerOf(route)),
            };
        }
        return route;
    };
    // ---- PB-10: the WebSocket upgrade interception -----------------------------
    //
    // The host's upgrade handler reads `this.upgrades.get(pathname)` (RT
    // dsh-host-webserver — the probe verified the shape on real instances).
    // Shadowing that ONE method on the raw instance intercepts every upgrade
    // lookup, including upgrades registered after us. Declared `upgrade`
    // routes with a virtual session id become a byte tunnel to the server:
    // the browser's WebSocket speaks to THIS process, the bytes travel the
    // tunnel, and the REAL handshake (101, frames, close) is produced by the
    // plugin route on the server machine — neither end parses WebSocket
    // frames (docs/adr/0002).
    const targetWithUpgrades = webServer;
    const savedUpgradesGet = targetWithUpgrades.upgrades.get;
    const upgradeRoutesOf = (pathname) => {
        if (!installed)
            return undefined;
        for (const declaration of registry.list()) {
            for (const route of declaration.routes) {
                if (route.path === pathname && routeUpgradesOf(route)) {
                    return {
                        plugin: declaration.plugin,
                        version: declaration.version,
                        digest: declaration.digest,
                        path: route.path,
                        sessionParam: route.sessionParam,
                        deny: routeDeniesRemoteOf(route),
                    };
                }
            }
        }
        return undefined;
    };
    /** The tunnel's surrogate upgrade handler. Every outcome — refusal,
     * teardown, the byte pumping — owns the socket's whole remaining life. */
    const surrogateUpgrade = (declared, originalHandler) => (req, socket, head) => {
        // The host never awaits an upgrade handler — the async body runs on
        // its own and every failure path owns the socket's teardown.
        void (async () => {
            log?.('upgrade entered for %s', declared.path);
            const socketGone = () => socket.destroyed || !socket.writable;
            const passthrough = () => {
                if (typeof originalHandler === 'function') {
                    originalHandler(req, socket, head);
                    return;
                }
                try {
                    socket.destroy();
                }
                catch {
                    // Already gone.
                }
            };
            try {
                // ONE parse of the query — the session parameter's home.
                let searchParams;
                try {
                    searchParams = new URL(req.url ?? '/', 'http://local').searchParams;
                }
                catch {
                    answerUnbridgedSocket(socket, declared.plugin, 'bad-query');
                    return;
                }
                const values = searchParams.getAll(declared.sessionParam);
                if (values.length > 1) {
                    answerUnbridgedSocket(socket, declared.plugin, 'bad-query');
                    return;
                }
                const value = values.length === 1 ? values[0] : undefined;
                // PB-22: the deny wall on the tunnel — the HTTP surrogate's rule
                // verbatim. A remote context (the request's own virtual id, or the
                // browser's reported current session) never opens a byte tunnel into
                // a route declared `deny: true`; a local session's upgrade passes
                // through untouched.
                if (declared.deny) {
                    const current = getCurrentSession?.();
                    if ((current !== undefined && isVirtual(current)) || (value !== undefined && value.startsWith('zr~'))) {
                        answerUnbridgedSocket(socket, declared.plugin, 'route-denied');
                        return;
                    }
                }
                // A LOCAL session (or no parameter at all): the original upgrade
                // handler's business, the head bytes untouched.
                if (value === undefined || value === '' || !value.startsWith('zr~')) {
                    passthrough();
                    return;
                }
                const parts = fromVirtual(value);
                if (parts === undefined || parts.id === '') {
                    answerUnbridgedSocket(socket, declared.plugin, 'bad-query');
                    return;
                }
                if (parts.serverId !== getServerId()) {
                    answerUnbridgedSocket(socket, declared.plugin, 'server-changed');
                    return;
                }
                // The PB-2 bridge verdict, the SAME wall the HTTP surrogate raises:
                // the tunnel opens only for a plugin bridged RIGHT NOW — an absent
                // or unbridged status refuses with its own reason, and the local
                // plugin handler is never reached.
                const bridgeStatus = getStatus().find((entry) => entry.plugin === declared.plugin);
                if (bridgeStatus === undefined || !bridgeStatus.bridged) {
                    answerUnbridgedSocket(socket, declared.plugin, bridgeStatus?.reason ?? 'not-on-server');
                    return;
                }
                // ---- bridged: open the byte tunnel (PB-10) ---------------------
                const controller = new AbortController();
                socket.on('close', () => controller.abort());
                const wsKey = typeof req.headers['sec-websocket-key'] === 'string' ? req.headers['sec-websocket-key'] : undefined;
                const wsVersion = typeof req.headers['sec-websocket-version'] === 'string' ? req.headers['sec-websocket-version'] : undefined;
                if (wsKey === undefined || wsVersion === undefined) {
                    answerUnbridgedSocket(socket, declared.plugin, 'bad-query');
                    return;
                }
                const protocol = typeof req.headers['sec-websocket-protocol'] === 'string' ? req.headers['sec-websocket-protocol'] : undefined;
                const extensions = typeof req.headers['sec-websocket-extensions'] === 'string' ? req.headers['sec-websocket-extensions'] : undefined;
                const query = new URLSearchParams(searchParams);
                query.set(declared.sessionParam, parts.id);
                let tunnel;
                try {
                    log?.('opening tunnel for %s', declared.path);
                    tunnel = await relay.pluginTunnelOpen({
                        plugin: declared.plugin,
                        version: declared.version,
                        digest: declared.digest,
                        path: declared.path,
                        query: query.toString(),
                        wsHeaders: {
                            'sec-websocket-key': wsKey,
                            'sec-websocket-version': wsVersion,
                            ...(protocol !== undefined ? { 'sec-websocket-protocol': protocol } : {}),
                            ...(extensions !== undefined ? { 'sec-websocket-extensions': extensions } : {}),
                        },
                        ...(head.length > 0 ? { head: head.toString('base64') } : {}),
                    }, controller.signal);
                }
                catch (error) {
                    // The relay refused the open (unbridged walls arrive with their
                    // code in the error). The browser's handshake never completes.
                    const rawCode = error?.code;
                    const code = typeof rawCode === 'string' && rawCode !== '' ? rawCode : 'offline';
                    answerUnbridgedSocket(socket, declared.plugin, code);
                    return;
                }
                tunnelsCurrent += 1;
                tunnelsOpened += 1;
                log?.('tunnel open for %s: %s', declared.path, tunnel.tunnel);
                // ---- downstream: tunnel frames → the browser socket -------------
                void (async () => {
                    try {
                        for await (const chunk of tunnel.frames) {
                            if (socketGone())
                                break;
                            if (!socket.write(chunk)) {
                                // Real backpressure: the NEXT frame is not pulled until the
                                // browser socket drained — the tunnel's server half pauses
                                // its upstream read in turn (the same discipline the NDJSON
                                // streams run).
                                await new Promise((resolve) => {
                                    const settled = () => {
                                        socket.off('drain', settled);
                                        socket.off('close', settled);
                                        resolve();
                                    };
                                    socket.once('drain', settled);
                                    socket.once('close', settled);
                                });
                                if (socketGone())
                                    break;
                            }
                        }
                    }
                    catch {
                        // The tunnel died (transport or server-side failure) — the
                        // browser socket follows, below.
                    }
                    // Upstream is over: the browser's WebSocket ends here. A WebSocket
                    // close frame cannot be synthesized (this is a byte tunnel — the
                    // upstream's own close bytes, when the plugin sent any, already
                    // travelled as data), so the socket is cut the honest way.
                    if (!socketGone())
                        socket.destroy();
                })();
                // ---- upstream: browser bytes → ordered sends --------------------
                let sendSeq = 0;
                let upstreamBroken = false;
                let pending = Promise.resolve();
                socket.on('data', (chunk) => {
                    let offset = 0;
                    while (offset < chunk.length) {
                        const part = chunk.subarray(offset, Math.min(offset + 65536, chunk.length));
                        offset += part.length;
                        const bytes = new Uint8Array(part);
                        const seq = sendSeq;
                        sendSeq += 1;
                        // ONE in-flight send at a time: each chunk chains behind the
                        // previous answer, which is what keeps the server-side sequence
                        // gate satisfied and the byte order intact.
                        pending = pending.then(async () => {
                            if (upstreamBroken)
                                return;
                            try {
                                await relay.pluginTunnelSend(tunnel.tunnel, seq, bytes, controller.signal);
                            }
                            catch {
                                upstreamBroken = true;
                            }
                        });
                    }
                });
                const teardownTunnel = () => {
                    upstreamBroken = true;
                    tunnelsCurrent -= 1;
                    tunnelsClosed += 1;
                    void relay.pluginTunnelClose(tunnel.tunnel).catch(() => { });
                };
                socket.on('close', teardownTunnel);
                socket.on('error', teardownTunnel);
            }
            catch {
                // Any unexpected failure in the bridged path: the socket goes.
                try {
                    socket.destroy();
                }
                catch {
                    // Already gone.
                }
            }
        })().catch(() => {
            try {
                socket.destroy();
            }
            catch {
                // Already gone.
            }
        });
        void originalHandler;
    };
    const wrappedUpgradesGet = function get(pathname) {
        const entry = savedUpgradesGet.call(this, pathname);
        if (!installed)
            return entry;
        if (typeof pathname !== 'string' || !pathname.startsWith('/'))
            return entry;
        const declared = upgradeRoutesOf(pathname);
        if (declared === undefined)
            return entry;
        const originalHandler = entry !== undefined && isRecord(entry) && typeof entry.handler === 'function'
            ? entry.handler
            : undefined;
        return {
            path: pathname,
            handler: surrogateUpgrade(declared, originalHandler),
        };
    };
    target.match = wrappedMatch;
    // Instance-owning property shadows Map.prototype.get — exactly the seam
    // the probe verified (the host calls `this.upgrades.get(pathname)`).
    targetWithUpgrades.upgrades.get = wrappedUpgradesGet;
    return {
        uninstall() {
            if (!installed)
                return;
            installed = false;
            // Only restore while the instance still holds OUR wrapper — a later
            // wrapper chained over us captured this function, and restoring the
            // original would silently drop ITS wrap. Ours goes inert instead.
            if (target.match === wrappedMatch)
                target.match = savedMatch;
            if (targetWithUpgrades.upgrades.get === wrappedUpgradesGet) {
                targetWithUpgrades.upgrades.get = savedUpgradesGet;
            }
        },
        diagnostics() {
            return {
                installed,
                shape: checkWebServerShape(webServer),
                forwarded,
                refused,
                refusalsByReason: { ...refusalsByReason },
                recentFailures: [...recentFailures],
                adapterForwarded,
                adapterResponseRewrites,
                adapterResponsePassthroughs,
                tunnelsCurrent,
                tunnelsOpened,
                tunnelsClosed,
            };
        },
    };
}
//# sourceMappingURL=plugin-route-intercept.js.map