import type { ClientContext } from '../compat/types.ts'
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
      const { current, byId } = ctx.sessions.list.getSnapshot()
      const row = current === undefined ? undefined : byId[current]
      // 0.1.2 的待处理交互来源，每次现查：本插件的 inject 不含 uiSession（加了
      // 0.1.1 就不激活），apply 此刻服务未必注册好；每次算 dot 时现查，注册顺序
      // 就不再是问题。0.1.1 上没有这个服务，这里恒 undefined，黄点只由行字段决定。
      const uiSession = ctx.get('uiSession')
      const pending = current === undefined ? false
        : uiSession?.pendingInteractions.getSnapshot().has(current) === true
      const state = row === undefined ? undefined : dotState(row, pending)
      if (state === undefined) frame.removeAttribute('data-mobile-nav-dot')
      else frame.setAttribute('data-mobile-nav-dot', state)
    }
    apply()
    // Two sources can push the dot now (session list + the 0.1.2 pending
    // map); probe uiSession once more right here and subscribe to whichever
    // exist. 0.1.1 only ever has the first. Degradation note: if uiSession
    // has not registered by this moment (this plugin ran before it), only
    // the list subscription is attached — the dot stays correct because
    // every later list change re-runs apply(), whose fresh probe then sees
    // the service; a pending-only change before any list change would be
    // missed until then.
    const unsubscribes: Array<() => void> = [ctx.sessions.list.subscribe(apply)]
    const pendingSource = ctx.get('uiSession')?.pendingInteractions
    if (pendingSource !== undefined) unsubscribes.push(pendingSource.subscribe(apply))
    return () => {
      for (const off of unsubscribes) off()
    }
  }, 'dsh-mobile-nav: header status dot')
}
