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
export const VIRTUAL_GROUP_NAME_MARK = '\u2060'

/** MS-4: the two zero-width code points the serverId rides on inside a
 * virtual group NAME — ZERO WIDTH SPACE encodes bit 0, ZERO WIDTH
 * NON-JOINER bit 1. Invisible everywhere, and neither can appear in a
 * server id's own visible text, so the window between the two marks is
 * unambiguous. */
const ZERO_BIT = '\u200b'
const ONE_BIT = '\u200c'
const SERVER_ID_BITS = 32

/** The server id half: exactly the 8 lowercase hex chars relay-server.ts
 * mints (`randomBytes(4).toString('hex')`). */
const SERVER_ID_PATTERN = /^[0-9a-f]{8}$/

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
export function encodeServerIdZeroWidth(serverId: unknown): string {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)) return VIRTUAL_GROUP_NAME_MARK
  let bits = ''
  for (const nibble of serverId) {
    for (const bit of Number.parseInt(nibble, 16).toString(2).padStart(4, '0')) {
      bits += bit === '0' ? ZERO_BIT : ONE_BIT
    }
  }
  return `${VIRTUAL_GROUP_NAME_MARK}${bits}${VIRTUAL_GROUP_NAME_MARK}`
}

/**
 * MS-4: read the server id back out of one group heading, or `undefined`.
 * Strict like every decoder here: the text must start with the mark, the
 * window right after it must be exactly 32 zero-width bits closed by the
 * terminator mark — anything else (the legacy bare-mark heading, visible
 * text, a short or long bit run, a missing terminator) answers
 * `undefined`, which the classifier reads as "remote, server unknown".
 */
export function decodeServerIdZeroWidth(headingText: unknown): string | undefined {
  if (typeof headingText !== 'string' || !headingText.startsWith(VIRTUAL_GROUP_NAME_MARK)) return undefined
  const rest = headingText.slice(VIRTUAL_GROUP_NAME_MARK.length)
  if (rest.length < SERVER_ID_BITS + 1 || rest[SERVER_ID_BITS] !== VIRTUAL_GROUP_NAME_MARK) return undefined
  let hex = ''
  for (let i = 0; i < SERVER_ID_BITS; i += 4) {
    let nibble = 0
    for (let bit = 0; bit < 4; bit++) {
      const bitChar = rest[i + bit]
      if (bitChar === ZERO_BIT) nibble = nibble << 1
      else if (bitChar === ONE_BIT) nibble = (nibble << 1) | 1
      else return undefined
    }
    hex += nibble.toString(16)
  }
  return hex
}

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
