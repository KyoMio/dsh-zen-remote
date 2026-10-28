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
 * What the extraction is NOT: a general static analyzer, nor a pure wire
 * oracle. It knows better-sidebar's two shapes — the `"x.y": async (…)`
 * dispatch-table entries inside its bundled lib/index.js (the same recognition
 * test/adapter-better-sidebar.test.cjs layer 1 has pinned since PB-12), and
 * every `/sidebar/…` string literal the bundle carries. The npm build KEEPS
 * comments (0.28.2 ships ~470 `/**` blocks, some quoting path strings), and the
 * routes set below therefore collects registered routes, prefix checks and
 * comment mentions alike — the digest is stable exactly as long as ALL those
 * literals are (PB-18 review, verified with comment add/remove probes). That
 * is STRICTER than "wire unchanged": an upstream release that only edits a
 * path-mentioning comment changes the digest and fails closed to the
 * unlisted-version behavior of today — never an unsafe forward, just a smaller
 * auto-bridge hit rate than a pure wire comparison would give. A bundler that
 * stops emitting the literals at all fails the same closed direction.
 *
 * Pure by the adapters rule: node:crypto only, no fs, no DSH imports.
 */
import { createHash } from 'node:crypto'

/** The recognized wire surface: sorted route paths + sorted dispatch keys. */
export interface BetterSidebarSurface {
  routes: string[]
  methods: string[]
}

/** The dispatcher namespaces the plugin has used across 0.25.0–0.28.2. The
 * same object-key regex also matches unrelated tables in the bundle, so only
 * these prefixes count (the PB-12 test's filter, verbatim). */
const NAMESPACE_PATTERN = /^(session|fs|git|changes|subagents|workflows|teams|settings|open|archive|sidechat)\./u

/** A healthy build of any supported generation yields at least this many
 * dispatch keys (0.25.0 already serves 45+). Fewer means the extractor lost
 * the table — the wiring logs that distinctly from "surface changed". */
export const MIN_SURFACE_METHODS = 45

/** Every `/sidebar/…` literal in the bundle — registered routes (the upload
 * prefix, the deeper media route) plus prefix checks and comment mentions.
 * Lowercase only on purpose: the routes themselves are lowercase, and a
 * case-insensitive scan would swallow uppercase prose noise for no gain
 * (PB-18 review nit — the `i` flag is deliberately absent). */
const ROUTE_PATTERN = /\/sidebar\/[a-z0-9./:-]+/gu

/** `"ns.method":` dispatch-table entries (`async` optional after the colon). */
const METHOD_PATTERN = /"([a-zA-Z]+\.[a-zA-Z-]+)":\s*(?:async\s*)?\(/gu

/** Reduce one build's lib/index.js source to its surface fingerprint.
 * Deterministic: same source in, same sorted arrays out — the digest below is
 * a pure function of the surface. Empirically, wire-identical patch releases
 * also hash identically (0.26.1's perf work, 0.28.2's cwd fix — both kept
 * every extracted literal); see the header for why that is a fact about those
 * releases, not a structural guarantee. */
export function extractBetterSidebarSurface(source: string): BetterSidebarSurface {
  const routes = new Set<string>()
  for (const match of source.matchAll(ROUTE_PATTERN)) {
    // A literal matched through a sentence like "/sidebar/api/foo." would drag
    // a sentence-period into the set — trim one trailing dot so prose mentions
    // normalize to the same literal the code registers.
    routes.add(match[0].replace(/\.$/u, ''))
  }
  const methods = new Set<string>()
  for (const match of source.matchAll(METHOD_PATTERN)) {
    if (NAMESPACE_PATTERN.test(match[1])) methods.add(match[1])
  }
  return { routes: [...routes].sort(), methods: [...methods].sort() }
}

/** Whether an extraction looks like a real better-sidebar build at all (the
 * "extractor found nothing" tell — logged apart from digest mismatches). */
export function surfaceLooksHealthy(surface: BetterSidebarSurface): boolean {
  return surface.methods.length >= MIN_SURFACE_METHODS && surface.routes.length > 0
}

/** The 16-hex digest a `surfaces` table key carries: sha256 over the canonical
 * JSON of the surface. Same surface across versions → same digest → bridged. */
export function betterSidebarSurfaceDigest(surface: BetterSidebarSurface): string {
  const canonical = JSON.stringify({ routes: surface.routes, methods: surface.methods })
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}
