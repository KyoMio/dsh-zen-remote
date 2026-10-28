/** The recognized wire surface: sorted route paths + sorted dispatch keys. */
export interface BetterSidebarSurface {
    routes: string[];
    methods: string[];
}
/** A healthy build of any supported generation yields at least this many
 * dispatch keys (0.25.0 already serves 45+). Fewer means the extractor lost
 * the table — the wiring logs that distinctly from "surface changed". */
export declare const MIN_SURFACE_METHODS = 45;
/** Reduce one build's lib/index.js source to its surface fingerprint.
 * Deterministic: same source in, same sorted arrays out — the digest below is
 * a pure function of the surface. Empirically, wire-identical patch releases
 * also hash identically (0.26.1's perf work, 0.28.2's cwd fix — both kept
 * every extracted literal); see the header for why that is a fact about those
 * releases, not a structural guarantee. */
export declare function extractBetterSidebarSurface(source: string): BetterSidebarSurface;
/** Whether an extraction looks like a real better-sidebar build at all (the
 * "extractor found nothing" tell — logged apart from digest mismatches). */
export declare function surfaceLooksHealthy(surface: BetterSidebarSurface): boolean;
/** The 16-hex digest a `surfaces` table key carries: sha256 over the canonical
 * JSON of the surface. Same surface across versions → same digest → bridged. */
export declare function betterSidebarSurfaceDigest(surface: BetterSidebarSurface): string;
//# sourceMappingURL=surface.d.ts.map