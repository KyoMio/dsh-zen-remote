/**
 * The owner Peer this plugin speaks as when it calls the typert gateway on
 * its own behalf (relay routes, admin projections, the intercept
 * self-check, the `$events` relay subscription).
 *
 * DSH 0.2.1-alpha.3 removed the gateway's implicit operator fallback
 * (`gateway.operatorPeer()`, `connection.operator` and the `OperatorPeer`
 * export are gone): every gateway call — `invoke`, `stream`,
 * `openWireStream`, `dispatchRpc` — now asserts a live Peer, and `$events` /
 * `$events/result` additionally demand `principal.kind === 'owner'` and
 * `interactions === 'answer'`, with the result answered by the SAME Peer that
 * opened the stream. The sanctioned in-process door is
 * `connection.createPeer({ principal: { kind: 'owner' }, interactions:
 * 'answer' })` (docs/upgrade-guide/v0.2.1-alpha.2/operator-connect), whose
 * Peer is disposed with the Context that read `connection`.
 *
 * Resolution order: a cached `createPeer` Peer (recreated once its scope is
 * disposed), else `connection.browserPeer` (also an owner/answer Peer),
 * else `undefined` — the pre-alpha.3 behavior, where the gateway itself
 * defaulted a missing Peer to its operator.
 */

/** Minimal structural view of a typert `PeerScope`. */
export interface PeerLike {
  readonly signal?: AbortSignal
}

/** The connection-service members this module reads. */
export interface PeerConnectionLike {
  createPeer?: (options: { principal: { kind: 'owner' }; interactions?: 'answer' | 'none' }) => unknown
  browserPeer?: unknown
}

function isLive(peer: unknown): boolean {
  if (peer === null || typeof peer !== 'object') return false
  const signal = (peer as PeerLike).signal
  return !(signal instanceof AbortSignal) || !signal.aborted
}

/**
 * Build a lazy, caching owner-Peer source over a connection-service reader.
 * The reader runs per call (the service may be absent or restarted). The
 * cache is keyed on the Peer's LIVENESS, not on the connection object's
 * identity: `ctx.reflect.get('connection')` hands out a fresh proxy per read,
 * so an identity key would mint a new Peer per call — and the gateway
 * refuses a `$events/result` from any Peer but the one that opened
 * `$events` (found by the alpha.3 live smoke). A restarted connection
 * service disposes its Peers, which is exactly when a new one is minted.
 * @param getConnection - live reader of `ctx.connection` (may return undefined).
 * @returns a function answering the Peer to pass, or undefined to let the
 *   host default it (pre-alpha.3 hosts).
 */
export function createOwnerPeerSource(getConnection: () => unknown): () => unknown {
  let cached: unknown
  return () => {
    let connection: PeerConnectionLike | undefined
    try {
      const value = getConnection()
      connection = value !== null && typeof value === 'object' ? (value as PeerConnectionLike) : undefined
    } catch {
      connection = undefined
    }
    if (connection === undefined) return undefined
    if (typeof connection.createPeer === 'function') {
      if (isLive(cached)) return cached
      cached = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
      return cached
    }
    const browser = connection.browserPeer
    return browser !== null && typeof browser === 'object' ? browser : undefined
  }
}

/**
 * Attach `peer` to one gateway request object when a Peer is available;
 * otherwise return the request unchanged (pre-alpha.3 shape).
 */
export function withPeer<T extends object>(request: T, getPeer: (() => unknown) | undefined): T & { peer?: unknown } {
  const peer = getPeer?.()
  return peer === undefined ? request : { ...request, peer }
}

/**
 * Build the `/api` shared-fetch dispatcher reader for the relay server.
 * DSH 0.2.1-rc.3's `HostConnectionService.createSharedFetchHandler('/api').fetch(request, peer)`
 * checks `peer.principal.kind !== 'owner'` directly (returning 403 or throwing
 * TypeError when `peer` is undefined), so the dispatcher forwards the owner
 * Peer from `getPeer()` as the second argument. Pre-rc.3 hosts ignore the
 * extra argument.
 */
export function createSharedApiFetchGetter(
  getConnection: () => unknown,
  getPeer: () => unknown = createOwnerPeerSource(getConnection),
): () => ((request: Request) => Promise<Response>) | undefined {
  return () => {
    let connection:
      | {
          createSharedFetchHandler?: (channel: string) => {
            fetch?: (request: Request, peer?: unknown) => Promise<Response>
          }
        }
      | undefined
    try {
      const value = getConnection()
      connection = value !== null && typeof value === 'object' ? (value as typeof connection) : undefined
    } catch {
      connection = undefined
    }
    const handler = connection?.createSharedFetchHandler?.('/api')
    const fetch = handler?.fetch
    return typeof fetch === 'function' ? (request) => fetch.call(handler, request, getPeer()) : undefined
  }
}
