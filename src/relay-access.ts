/**
 * Pure access control for the relay invoke route (2.0.0 desktop-client).
 *
 * PER-METHOD ALLOWLIST, not a generic id scan. The first draft extracted
 * whatever session ids it could find in `args.request` and checked those —
 * which a hostile client defeats with a DECOY: DSH's gateway validates only
 * the top-level argument names (`assertExactArguments`) and zod silently
 * strips unknown fields inside `request`, so padding the arguments with an
 * extra shared `sessionId` gets through the share-table check while the
 * method's REAL ownership field (`agentId`, `request.parentSessionId`, …)
 * goes unchecked. The fix: every invokable method is registered below with
 * EXACTLY the fields that locate its session, authorization looks at those
 * fields and nothing else, and any method not in the table is refused
 * (`forbidden-method`) before an id is ever read.
 *
 * Field verification (T22a-fix, against the 0.2.0-rc.1 wire inventory in the
 * review's keys.txt and the local `typert.remote-client.js` — the spike
 * proved those files byte-identical across 0.1.7/0.2.0, docs/spike-relay.md
 * §2.3):
 *
 * - `request.address` exists only on `session/follow` and `session/page`;
 *   its zod schema is a union of EXACTLY two shapes —
 *   `{kind:'session', sessionId}` and `{kind:'subagent', parentSessionId,
 *   childSessionId, mode}` — and DSH's `validateAddress` re-checks that the
 *   child belongs to the parent, so judging a subagent call by the parent id
 *   is authoritative. Any other kind, or a missing id, is a refusal.
 * - every other registered method carries `request.sessionId`.
 *
 * Pure functions: no I/O, no clock, the share-table lookup is injected.
 */

/** The argument fields that can locate a session, as registered per method. */
type SessionField = 'request.sessionId' | 'request.address'

interface RelayMethod {
  /** Every field that carries session ownership for this method. ALL of
   * them must exist, be strings, and pass the share-table check. */
  fields: SessionField[]
  /** Stream-delivered methods (`[stream]` in the wire inventory): callable
   * ONLY through the streaming route T22b will add — an invoke carrying one
   * is refused, and so will be a stream carrying a non-stream method. */
  stream?: boolean
}

/**
 * The registry. Deliberately small: everything not listed here — plugin and
 * account management, settings, credentials, terminal, `session/create` /
 * `session/fork` (new sessions must auto-share, T31), `subagents/*` (T31
 * re-verifies ownership first), the methods located by other ids
 * (`schedule/update|delete|history`, `goals/*`, `fileReferences/*`,
 * `fileUploads/*`, `workspaceFiles/*` — P4 verifies DSH's ownership checks),
 * and the unscoped lists T22b will serve through filtered controlled paths
 * (`session/list`, `session/control`, `workspace/follow`) — is refused by
 * default.
 */
const RELAY_METHODS: Record<string, RelayMethod> = {
  // session/* — ownership via the address envelope
  'session/follow': { fields: ['request.address'], stream: true },
  'session/page': { fields: ['request.address'] },
  // session/* — ownership via request.sessionId
  'session/projections': { fields: ['request.sessionId'] },
  'session/prompt': { fields: ['request.sessionId'] },
  'session/cancel': { fields: ['request.sessionId'] },
  'session/rename': { fields: ['request.sessionId'] },
  'session/selectModel': { fields: ['request.sessionId'] },
  'session/updateQueue': { fields: ['request.sessionId'] },
  'session/attachment': { fields: ['request.sessionId'] },
  // job/*
  'job/list': { fields: ['request.sessionId'], stream: true },
  'job/follow': { fields: ['request.sessionId'], stream: true },
  'job/kill': { fields: ['request.sessionId'] },
  // skills, message feedback
  'skills/list': { fields: ['request.sessionId'] },
  'messageFeedback/list': { fields: ['request.sessionId'] },
  'messageFeedback/put': { fields: ['request.sessionId'] },
  'messageFeedback/delete': { fields: ['request.sessionId'] },
  // schedule (list only — update/delete/history wait for P4)
  'schedule/list': { fields: ['request.sessionId'] },
  // workspace session-scoped mutations
  'workspace/pinSession': { fields: ['request.sessionId'] },
  'workspace/unpinSession': { fields: ['request.sessionId'] },
  'workspace/archiveSession': { fields: ['request.sessionId'] },
  'workspace/unarchiveSession': { fields: ['request.sessionId'] },
}

/** One invoke decision: allow, or the reason that goes into the 403 body. */
export type InvokeDenyReason = 'no-session' | 'not-shared' | 'forbidden-method'

export type InvokeDecision = { allow: true } | { allow: false; reason: InvokeDenyReason }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An OWNED session id: present and a non-empty string, anything else means
 * "the field does not locate a session" (an empty id is garbage, not one). */
function ownedId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The session ids one registered method's arguments claim, read STRICTLY
 * along the registered fields (this replaces the old generic
 * `extractSessionIds` scan — that scan is exactly the decoy hole).
 *
 * `request.address` contributes its session id by kind: `session` →
 * `sessionId`, `subagent` → `parentSessionId` (the child never enters the
 * share table; DSH validates the parent-child link server-side). Any other
 * kind, or a missing id, makes the method unauthorizable.
 */
function claimedSessionIds(entry: RelayMethod, args: unknown): { ids: string[] } | { reason: InvokeDenyReason } {
  if (!isPlainObject(args)) return { reason: 'no-session' }
  const request = args.request
  if (!isPlainObject(request)) return { reason: 'no-session' }
  const ids: string[] = []
  for (const field of entry.fields) {
    if (field === 'request.sessionId') {
      const id = ownedId(request.sessionId)
      if (id === undefined) return { reason: 'no-session' }
      ids.push(id)
      continue
    }
    // 'request.address'
    const address = request.address
    if (!isPlainObject(address)) return { reason: 'no-session' }
    if (address.kind === 'session') {
      const id = ownedId(address.sessionId)
      if (id === undefined) return { reason: 'no-session' }
      ids.push(id)
    } else if (address.kind === 'subagent') {
      const id = ownedId(address.parentSessionId)
      if (id === undefined) return { reason: 'no-session' }
      ids.push(id)
    } else {
      // Unknown kind — not an address DSH would accept either.
      return { reason: 'no-session' }
    }
  }
  return { ids }
}

/**
 * Decide one relayed invoke against the per-method allowlist:
 *
 * 1. the method must be registered AND invoke-delivered (a `stream: true`
 *    entry refuses the invoke route) — anything else is `forbidden-method`;
 * 2. its registered fields must all yield an owned session id — else
 *    `no-session`;
 * 3. every claimed id must pass `isAccessible` — one unreachable id refuses
 *    the whole call (`not-shared`): an unshared session must not become
 *    readable through a shared one riding in the same arguments.
 */
export function decideInvoke(
  namespace: string,
  method: string,
  args: unknown,
  isAccessible: (sessionId: string) => boolean,
): InvokeDecision {
  const entry = RELAY_METHODS[`${namespace}/${method}`]
  if (entry === undefined || entry.stream === true) return { allow: false, reason: 'forbidden-method' }
  const claimed = claimedSessionIds(entry, args)
  if ('reason' in claimed) return { allow: false, reason: claimed.reason }
  for (const id of claimed.ids) {
    if (!isAccessible(id)) return { allow: false, reason: 'not-shared' }
  }
  return { allow: true }
}
