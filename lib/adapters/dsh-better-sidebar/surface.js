/**
 * The better-sidebar wire-surface extractor (PB-18, ADR-0003 local draft).
 *
 * The adapter's `versions` list pins EXACT upstream versions, so a wire-identical
 * patch release (0.26.1, 0.28.2 — both shipped with the routes/methods/WebSockets
 * byte-identical to their predecessor) still refuses to bridge until zen-remote
 * itself releases. The `surfaces` table (PB-19) closes that gap: the wiring reads
 * the INSTALLED plugin's `lib/index.js`, this pure function reduces it to the
 * set of `/sidebar/*` routes and `ns.method` dispatch keys it serves, and a
 * digest over that reduction whitelists every version whose WIRE SURFACE matches
 * a blessed one — regardless of the version string.
 *
 * What the extraction is NOT: a general static analyzer. It knows better-sidebar's
 * two shapes — the route literals it registers, and the `"x.y": async (…)`
 * dispatch-table entries inside its bundled lib/index.js (the same recognition
 * test/adapter-better-sidebar.test.cjs layer 1 has pinned since PB-12). Comments
 * and formatting cannot move (the npm build strips them); an internal refactor
 * that renames variables cannot move it; a bundler that stops emitting the
 * literals CAN — which fails closed (no digest match → the adapter stays out,
 * exactly the unlisted-version behavior of today).
 *
 * Pure by the adapters rule: node:crypto only, no fs, no DSH imports.
 */
import { createHash } from 'node:crypto';
/** The dispatcher namespaces the plugin has used across 0.25.0–0.28.2. The
 * same object-key regex also matches unrelated tables in the bundle, so only
 * these prefixes count (the PB-12 test's filter, verbatim). */
const NAMESPACE_PATTERN = /^(session|fs|git|changes|subagents|workflows|teams|settings|open|archive|sidechat)\./u;
/** A healthy build of any supported generation yields at least this many
 * dispatch keys (0.25.0 already serves 45+). Fewer means the extractor lost
 * the table — the wiring logs that distinctly from "surface changed". */
export const MIN_SURFACE_METHODS = 45;
/** `/sidebar/…` route literals the bundle registers (upload rides a prefix,
 * the media route a deeper one — every generation spells them out literally). */
const ROUTE_PATTERN = /\/sidebar\/[a-z0-9./:-]+/giu;
/** `"ns.method":` dispatch-table entries (`async` optional after the colon). */
const METHOD_PATTERN = /"([a-zA-Z]+\.[a-zA-Z-]+)":\s*(?:async\s*)?\(/gu;
/** Reduce one build's lib/index.js source to its wire surface. Deterministic:
 * same source in, same sorted arrays out — the digest below is a pure function
 * of the surface, and patch releases that leave the wire alone (0.28.2's cwd
 * fix, 0.26.1's perf work) hash identically to their predecessor. */
export function extractBetterSidebarSurface(source) {
    const routes = new Set();
    for (const match of source.matchAll(ROUTE_PATTERN)) {
        // A route literal immediately followed by a period was matched through a
        // sentence like "/sidebar/api/foo.bar" — trim the trailing dot the pattern
        // can pick up off a following sentence (the PB-12 layer-1 behavior).
        routes.add(match[0].replace(/\.$/u, ''));
    }
    const methods = new Set();
    for (const match of source.matchAll(METHOD_PATTERN)) {
        if (NAMESPACE_PATTERN.test(match[1]))
            methods.add(match[1]);
    }
    return { routes: [...routes].sort(), methods: [...methods].sort() };
}
/** Whether an extraction looks like a real better-sidebar build at all (the
 * "extractor found nothing" tell — logged apart from digest mismatches). */
export function surfaceLooksHealthy(surface) {
    return surface.methods.length >= MIN_SURFACE_METHODS && surface.routes.length > 0;
}
/** The 16-hex digest a `surfaces` table key carries: sha256 over the canonical
 * JSON of the surface. Same surface across versions → same digest → bridged. */
export function betterSidebarSurfaceDigest(surface) {
    const canonical = JSON.stringify({ routes: surface.routes, methods: surface.methods });
    return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}
//# sourceMappingURL=surface.js.map