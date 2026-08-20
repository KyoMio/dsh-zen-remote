/**
 * Back-gesture plumbing: a stack of dismissible layers mirrored into
 * `history`, so Android's system back gesture closes what is on top instead
 * of leaving the PWA.
 *
 * Why this exists at all: the phone shell's page stack is pure store state
 * (`nav-store.ts`), and nothing ever pushed a history entry. Android's edge
 * swipe IS the browser's back, so with an empty history it exited the app and
 * the next launch was a cold reload. The edge is also where the system
 * gesture lives, which is why the plugin's own edge-swipe never fired on
 * Android — those pixels never reach the page. `systemGestureExclusionRects`
 * is a native-app API with no web equivalent, so the gesture cannot be
 * blocked; it can only be *given something to do*. (An early version called
 * `history.back()` from the custom gesture and was removed as "a no-op
 * against an SPA" — the no-op was the missing history entry, not `back()`.)
 *
 * Contract, and the one rule that keeps this honest: **layers close in one
 * direction only.** A surface never flips its own state to closed; it calls
 * {@link popLayer}, which rewinds history, which fires `popstate`, which runs
 * the layer's `close`. State driven from both ends drifts out of sync with
 * the history stack, and the drift shows up as a back gesture that does
 * nothing.
 *
 * Verified against the harness: DSH's own client never touches the History
 * API (`pushState`/`popstate`/`replaceState` all absent from dsh-client-
 * runtime, -ui-conversation and -ui-layout, 2026-08-20), so this is
 * uncontested ground.
 */

/** One dismissible surface. `close` must be idempotent. */
export interface HistoryLayer {
  /** Stable id, unique among currently-open layers. */
  id: string
  /** Runs when the back gesture (or {@link popLayer}) rewinds past it. */
  close: () => void
}

/** Marker written into `history.state` so a popstate can tell its depth. */
interface NavState { dshNav: number }

let stack: HistoryLayer[] = []
let wired = false

function depthOf(state: unknown): number {
  if (typeof state !== 'object' || state === null) return 0
  const depth = (state as Partial<NavState>).dshNav
  return typeof depth === 'number' ? depth : 0
}

/**
 * Unwind to the depth the browser landed on, closing every layer above it.
 * A single gesture can cross more than one entry (a long swipe, or a
 * restored session), so this is a loop rather than one pop.
 */
function onPopState(event: PopStateEvent): void {
  const target = depthOf(event.state)
  while (stack.length > target) {
    const layer = stack.pop()
    try {
      layer?.close()
    } catch {
      // A layer that throws must not strand the ones underneath it.
    }
  }
}

function wire(): void {
  if (wired) return
  wired = true
  window.addEventListener('popstate', onPopState)
}

/** Open a layer: remember how to close it, and give back one entry to spend. */
export function pushLayer(layer: HistoryLayer): void {
  wire()
  if (stack.some((entry) => entry.id === layer.id)) return
  stack.push(layer)
  // Same URL on purpose: these are view states, not addresses. A changed URL
  // would show up in the PWA's address handling and survive a reload as a
  // route this app cannot serve.
  history.pushState({ dshNav: stack.length } satisfies NavState, '', location.href)
}

/**
 * Close a layer the app-side way (a close button, a nav action). Rewinds
 * history instead of flipping state, so the two never diverge.
 */
export function popLayer(id: string): void {
  const index = stack.findIndex((entry) => entry.id === id)
  if (index < 0) return
  if (index === stack.length - 1) {
    // The common case: let popstate do the closing so there is exactly one
    // code path that ever calls `close`.
    history.back()
    return
  }
  // Closed out of order (a deeper layer is still open above it). Drop it from
  // the stack and close it here — this is the one case where `close` runs
  // outside popstate, because rewinding would take the deeper layer with it.
  const [layer] = stack.splice(index, 1)
  try {
    layer?.close()
  } catch {
    // Same containment as the popstate path.
  }
}

/** Whether a layer is currently open. */
export function hasLayer(id: string): boolean {
  return stack.some((entry) => entry.id === id)
}

/** Test seam: current depth. */
export function layerDepth(): number {
  return stack.length
}

/** Test seam: drop everything without touching history. */
export function resetLayers(): void {
  stack = []
}
