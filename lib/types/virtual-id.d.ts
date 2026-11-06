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
/**
 * The invisible WORD JOINER (U+2060) every virtual GROUP NAME starts with
 * (T74). DSH 0.2.0 renders the model menu's provider groups with the
 * primitives' MenuGroup, whose `aria-labelledby` carries only a useId — the
 * group id is gone from the markup — so the browser half can no longer tell
 * a virtual group from a local one by attribute. The merged catalog's group
 * NAME (merge-streams.ts mergeModelCatalogs) is the one mark that survives
 * in both 0.1.7 and 0.2.0, and effects/model-group-side.ts classifies each
 * group container by which headings start with it. Zero-width: headings
 * read exactly as before. Sidebar workspace TITLES deliberately do NOT
 * carry it — those groups are told apart by their `zr~` row ids, not by
 * text.
 */
export declare const VIRTUAL_GROUP_NAME_MARK = "\u2060";
/**
 * MS-4: the invisible prefix a REMOTE model-menu group heading carries
 * before its server name (merge-streams.ts mergeModelCatalogs). The full
 * form is `${MARK}${32 zero-width bits}${MARK}` — the 32 bits of the
 * 8-hex serverId (MSB first per nibble), ZERO_BIT for 0 and ONE_BIT for 1
 * — so the browser half can tell WHICH server a remote model group came
 * from (effects/model-group-side.ts classifies per-server hiding from
 * heading text alone). A serverId that is not 8 lowercase hex (the format
 * every real handshake carries) degrades to the bare legacy mark: the
 * heading stays a marked remote heading, just without a decodable server.
 */
export declare function encodeServerIdZeroWidth(serverId: unknown): string;
/**
 * MS-4: read the server id back out of one group heading, or `undefined`.
 * Strict like every decoder here: the text must start with the mark, the
 * window right after it must be exactly 32 zero-width bits closed by the
 * terminator mark — anything else (the legacy bare-mark heading, visible
 * text, a short or long bit run, a missing terminator) answers
 * `undefined`, which the classifier reads as "remote, server unknown".
 */
export declare function decodeServerIdZeroWidth(headingText: unknown): string | undefined;
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