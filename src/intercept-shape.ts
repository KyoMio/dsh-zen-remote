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
export type GatewayShapeCheck = { ok: true; notes: string[] } | { ok: false; reasons: string[] }

/** The exact dynamic call sites the 0.2.0-rc.1 constructor contains (spike
 * §2.2/§4.1). If these strings vanish from the constructor source, own
 * properties would silently stop intercepting. */
const DYNAMIC_OPEN_CALL = 'this.openWireStream(endpoint, payload, uplink, peer, control.signal, control)'
const DYNAMIC_RPC_CALL = 'this.dispatchRpc(endpoint, payload, signal, peer)'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Check the raw (`ctx.typertGateway[symbols.original]`) gateway instance
 * against the shape the wrap depends on. Pure inspection — nothing is
 * mutated, so a failed check leaves the process exactly as it was.
 */
export function checkGatewayShape(raw: unknown): GatewayShapeCheck {
  if (!isRecord(raw) || Array.isArray(raw)) {
    return { ok: false, reasons: ['original: typertGateway[symbols.original] is not an object'] }
  }
  const reasons: string[] = []
  const notes: string[] = []
  const proto = Object.getPrototypeOf(raw) as Record<string, unknown> | null

  // 2. The two wrapped methods and the wire adapter, read through the
  // PROTOTYPE chain — own properties are step 4's business, and reading the
  // prototype keeps the arity verdict honest even when another wrapper is
  // already installed.
  const open = proto === null ? undefined : proto.openWireStream
  if (typeof open !== 'function') reasons.push('prototype: openWireStream is not a function')
  else if (open.length !== 6) reasons.push(`prototype: openWireStream has ${open.length} parameters, expected 6`)
  const dispatch = proto === null ? undefined : proto.dispatchRpc
  if (typeof dispatch !== 'function') reasons.push('prototype: dispatchRpc is not a function')
  else if (dispatch.length !== 4) reasons.push(`prototype: dispatchRpc has ${dispatch.length} parameters, expected 4`)
  const wireStream = raw.wireStream
  if (!isRecord(wireStream) || typeof wireStream.open !== 'function') {
    reasons.push('wireStream.open is not a function')
  }

  // 3. The dynamic-lookup proof: the constructor source must still contain
  // both arrow-call sites. Without this, a future closure-bound gateway
  // would pass every check above and simply ignore our shadow.
  const constructorSource =
    proto !== null && typeof proto.constructor === 'function' ? String(proto.constructor) : ''
  if (constructorSource === '') {
    reasons.push('constructor: the prototype has no constructor to inspect')
  } else {
    if (!constructorSource.includes(DYNAMIC_OPEN_CALL)) {
      reasons.push(`constructor: source does not contain "${DYNAMIC_OPEN_CALL}"`)
    }
    if (!constructorSource.includes(DYNAMIC_RPC_CALL)) {
      reasons.push(`constructor: source does not contain "${DYNAMIC_RPC_CALL}"`)
    }
  }

  // 4. Existing own properties are NOT a failure — another plugin may have
  // wrapped first. We chain to whatever is installed now and restore it on
  // uninstall; the note only records the fact.
  for (const name of ['openWireStream', 'dispatchRpc']) {
    if (Object.prototype.hasOwnProperty.call(raw, name)) {
      notes.push(`own-property: "${name}" is already an own property; the wrap chains to it and restores it on uninstall`)
    }
  }

  if (reasons.length > 0) return { ok: false, reasons }
  return { ok: true, notes }
}
