/**
 * Reversible virtual ids for sessions and workspaces the sub-client surfaces
 * locally while their real records live on a relay server (T23b-1). The UI
 * only ever sees `zr~<serverId>~<original id>`; the interceptor maps those
 * back to the original ids before a call travels, and maps server-returned
 * ids back to virtual form on the way out.
 *
 * The mapping is deliberately a PURE function of (serverId, id), not a
 * session-table lookup: every shared session of one server gets the same
 * virtual id whether or not this process ever opened it, so result rewriting
 * needs no state. Parsing validates the fixed skeleton (`zr~` + the 8 hex
 * chars `loadServerId` mints, relay-server.ts) and keeps the remainder
 * VERBATIM — the original id may contain any characters, including `~`, so
 * nothing after the second separator is interpreted.
 *
 * A local DSH id can never collide with the prefix: real session ids are
 * `session-<uuid>` and workspace ids are bare uuids.
 */
/** The fixed prefix every virtual id starts with. */
export declare const VIRTUAL_ID_PREFIX = "zr~";
/** The two halves {@link fromVirtual} recovers from a virtual id. */
export interface VirtualIdParts {
    serverId: string;
    id: string;
}
/** Build the virtual form of one server-side session or workspace id. */
export declare function toVirtual(serverId: string, id: string): string;
/**
 * Parse one virtual id back into its halves, or `undefined` for anything
 * that does not match the skeleton. Strict on the parts that carry meaning:
 * the literal prefix, exactly 8 lowercase hex server id chars, and the
 * separating `~` after them. The remainder is not validated — any string,
 * including the empty one, is a legal original id.
 */
export declare function fromVirtual(id: unknown): VirtualIdParts | undefined;
/** True when {@link fromVirtual} would parse this value. */
export declare function isVirtual(id: unknown): boolean;
//# sourceMappingURL=virtual-id.d.ts.map