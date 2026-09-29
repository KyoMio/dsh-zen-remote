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
export const VIRTUAL_ID_PREFIX = 'zr~'

/** The server id half: exactly the 8 lowercase hex chars relay-server.ts
 * mints (`randomBytes(4).toString('hex')`). */
const SERVER_ID_PATTERN = /^[0-9a-f]{8}$/

/** The two halves {@link fromVirtual} recovers from a virtual id. */
export interface VirtualIdParts {
  serverId: string
  id: string
}

/** Build the virtual form of one server-side session or workspace id. */
export function toVirtual(serverId: string, id: string): string {
  return `${VIRTUAL_ID_PREFIX}${serverId}~${id}`
}

/**
 * Parse one virtual id back into its halves, or `undefined` for anything
 * that does not match the skeleton. Strict on the parts that carry meaning:
 * the literal prefix, exactly 8 lowercase hex server id chars, and the
 * separating `~` after them. The remainder is not validated — any string,
 * including the empty one, is a legal original id.
 */
export function fromVirtual(id: unknown): VirtualIdParts | undefined {
  if (typeof id !== 'string' || !id.startsWith(VIRTUAL_ID_PREFIX)) return undefined
  const rest = id.slice(VIRTUAL_ID_PREFIX.length)
  // The shortest legal remainder is `<8 hex>~` — 9 chars with the separator
  // at index 8. Anything shorter cannot carry a server id.
  if (rest.length < 9 || rest[8] !== '~') return undefined
  const serverId = rest.slice(0, 8)
  if (!SERVER_ID_PATTERN.test(serverId)) return undefined
  return { serverId, id: rest.slice(9) }
}

/** True when {@link fromVirtual} would parse this value. */
export function isVirtual(id: unknown): boolean {
  return fromVirtual(id) !== undefined
}
