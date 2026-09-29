/**
 * Startup shape check for the typertGateway interception point (T23b-1,
 * docs/spike-relay.md §4.1). The wrap works by shadowing two instance
 * methods with own properties, which only intercepts because DSH's
 * TypertGatewayService resolves them DYNAMICALLY — its constructor registers
 * arrow functions like `(…) => this.openWireStream(…)`, so every call looks
 * the method up on the instance at call time. If a future DSH binds the
 * methods directly into closures, the prototype still advertises the same
 * functions but our shadow would never be reached — so the constructor
 * source check below is the load-bearing one, and a failed check must leave
 * the gateway untouched (remote features off, local behavior identical).
 *
 * Every reason string is a stable diagnostic label (never source text), fit
 * for the settings surface via the client status route.
 */
/** Verdict of {@link checkGatewayShape}. `notes` record non-fatal facts —
 * an existing own property means another wrapper is already installed; we
 * stack on it (saving its value) rather than failing. */
export type GatewayShapeCheck = {
    ok: true;
    notes: string[];
} | {
    ok: false;
    reasons: string[];
};
/**
 * Check the raw (`ctx.typertGateway[symbols.original]`) gateway instance
 * against the shape the wrap depends on. Pure inspection — nothing is
 * mutated, so a failed check leaves the process exactly as it was.
 */
export declare function checkGatewayShape(raw: unknown): GatewayShapeCheck;
//# sourceMappingURL=intercept-shape.d.ts.map