import type { ClientContext } from '../compat/types.ts'
import { mainSessionIdOf } from '../compat/types.ts'
import { dotState } from '../session-dot.ts'

/**
 * Session header running-status dot (S2). No official element exists to
 * reposition (ConversationSessionHeader renders only the crumb title, the
 * actions/utilities slots, and the tablist — dsh-client-ui-conversation
 * lib/client.js:6949-7009), so this reads `ctx.sessions.list` directly
 * (the same feed `useSessions` wraps) and stamps a data attribute the
 * mobile stylesheet turns into a `::after` dot on the title crumb —
 * "read data, self-draw" is the plan's documented fallback for this piece.
 * Kept outside React: the dot must track the CURRENT session regardless of
 * which component the header happens to mount, and a plain attribute +
 * CSS avoids reaching into the official crumb's own DOM subtree.
 */
export function installHeaderStatusDot(ctx: ClientContext): void {
  ctx.effect(() => {
    const apply = (): void => {
      const frame = document.querySelector('[data-mobile-nav="frame"]')
      if (frame === null) return
      // 0.1.7: SessionListState.current is gone — the main-view session
      // derives from the catalog rows (mainSessionIdOf). The pending flag
      // moved with it: uiSession.pendingInteractions is gone too, the fact
      // now rides ctx.uiSession.sessionStatus (running + pendingInteraction
      // per session). Probed fresh on every dot recompute so registration
      // order never matters, same as before.
      const { byId } = ctx.sessions.list.getSnapshot()
      const current = mainSessionIdOf(byId)
      const row = current === undefined ? undefined : byId[current]
      const status = current === undefined ? undefined
        : ctx.get('uiSession')?.sessionStatus.getSnapshot().get(current)
      const pending = status?.pendingInteraction !== undefined && status.pendingInteraction !== null
      const state = row === undefined ? undefined : dotState(row, pending)
      if (state === undefined) frame.removeAttribute('data-mobile-nav-dot')
      else frame.setAttribute('data-mobile-nav-dot', state)
    }
    apply()
    // Two sources can push the dot (session list + the unified session
    // status table); probe uiSession once more right here and subscribe to
    // whichever exist. Degradation note: if uiSession has not registered by
    // this moment (this plugin ran before it), only the list subscription
    // is attached — the dot stays correct because every later list change
    // re-runs apply(), whose fresh probe then sees the service; a
    // pending-only change before any list change would be missed until then.
    const unsubscribes: Array<() => void> = [ctx.sessions.list.subscribe(apply)]
    const statusSource = ctx.get('uiSession')?.sessionStatus
    if (statusSource !== undefined) unsubscribes.push(statusSource.subscribe(apply))
    return () => {
      for (const off of unsubscribes) off()
    }
  }, 'dsh-mobile-nav: header status dot')
}
