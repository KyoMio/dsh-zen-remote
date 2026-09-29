/**
 * Shared HTTP plumbing for the host-side route modules: the one JSON response
 * envelope and the one same-origin gate every state-changing browser route
 * applies. Both lived in the main entry until the admin routes (T14) needed
 * the exact same pair; importing the entry from a route module would be an
 * import cycle, so the definitions live here and the entry re-exports the
 * same-origin gate its public surface has carried since S7.
 */
/** The one JSON response envelope every host route speaks: no-store (admin
 * surfaces and pairing codes must never sit in a shared cache), nosniff, and
 * a default-src 'none' CSP since no route serves executable content. */
export function responseJson(res, status, body) {
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
 *
 * When BOTH `Origin` and `Sec-Fetch-Site` are absent the request is ACCEPTED
 * (T16-fix): the DSH desktop app's main process forwards window requests to
 * the local backend after verifying `Origin: dsh-app://app` itself, and
 * strips `host`, `origin`, `cookie` and `sec-fetch-site` on the way (its
 * `forwardWebRequest`), so such requests arrive with neither header. A
 * curl-style local tool sends neither either. Neither shape is a
 * browser-direct cross-site POST. What stands in front of an accepted
 * headerless request depends on the route module: the admin routes (T14) and
 * the client routes (T16) run `connection.admit` FIRST, so such a request has
 * still cleared DSH's login wall before this check runs; since T17 the
 * upload and share-export routes run the same `connection.admit` first, so
 * every state-changing route this gate fronts is admission-covered and this
 * acceptance never stands alone. Everything
 * identifiable as cross-site (`Sec-Fetch-Site: cross-site`, or an `Origin`
 * that disagrees with `Host`) is still refused.
 * @param req - the inbound request.
 * @returns true when the request may mutate the workspace.
 */
export function sameOriginPost(req) {
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite === 'cross-site')
        return false;
    const origin = req.headers.origin;
    if (origin === undefined) {
        if (fetchSite === undefined)
            return true;
        return fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none';
    }
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
//# sourceMappingURL=http.js.map