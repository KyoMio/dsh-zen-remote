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
 * back. Everything else — undeclared routes, local sessions — flows to the
 * original route untouched.
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
import { routeMethodsOf, routeMaxBodyOf } from './plugin-bridge.js';
import { Readable, Transform } from 'node:stream';
import { fromVirtual } from './virtual-id.js';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    if (reasons.length > 0)
        return { ok: false, reasons };
    return { ok: true };
}
/** Longest failure ring kept for the status surface. */
const MAX_FAILURES = 10;
export function installPluginRouteIntercept(options) {
    const { webServer, registry, relay, getServerId, getStatus, log } = options;
    const target = webServer;
    const savedMatch = target.match;
    let installed = true;
    let forwarded = 0;
    let refused = 0;
    const refusalsByReason = {};
    const recentFailures = [];
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
    /** The declared route this pathname hits — EXACT equality only this task
     * (a declared prefix does not cover longer paths; that arrives with
     * PB-12). First plugin in registry order wins, deterministically. */
    const declaredRouteOf = (pathname) => {
        for (const declaration of registry.list()) {
            for (const route of declaration.routes) {
                if (route.path === pathname) {
                    return {
                        plugin: declaration.plugin,
                        version: declaration.version,
                        digest: declaration.digest,
                        path: route.path,
                        sessionParam: route.sessionParam,
                        methods: routeMethodsOf(route),
                        maxBody: routeMaxBodyOf(route),
                    };
                }
            }
        }
        return undefined;
    };
    /** The surrogate handler: ONE query parse, the virtual-id gate, the
     * unbridged walls in contract order, then the relay round-trip. */
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
        // ONE parse of the query (the session parameter's home — `match` only
        // ever saw the pathname): everything below reads THIS parse.
        let searchParams;
        try {
            searchParams = new URL(req.url ?? '/', 'http://local').searchParams;
        }
        catch {
            answerUnbridged(res, declared.plugin, 'bad-query');
            return;
        }
        const values = searchParams.getAll(declared.sessionParam);
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
        searchParams.set(declared.sessionParam, parts.id);
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
                path: declared.path,
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
            if (reader !== undefined) {
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
    /** The wrapped match: original verdict first, then the exact declaration
     * lookup — an undeclared pathname returns whatever the original match
     * answered, untouched. */
    const wrappedMatch = function match(pathname) {
        const route = savedMatch.call(this, pathname);
        if (!installed)
            return route;
        if (typeof pathname !== 'string' || !pathname.startsWith('/'))
            return route;
        const declared = declaredRouteOf(pathname);
        if (declared === undefined)
            return route;
        return {
            kind: 'exact',
            path: pathname,
            handler: surrogateHandler(declared, handlerOf(route)),
        };
    };
    target.match = wrappedMatch;
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
        },
        diagnostics() {
            return {
                installed,
                shape: checkWebServerShape(webServer),
                forwarded,
                refused,
                refusalsByReason: { ...refusalsByReason },
                recentFailures: [...recentFailures],
            };
        },
    };
}
//# sourceMappingURL=plugin-route-intercept.js.map