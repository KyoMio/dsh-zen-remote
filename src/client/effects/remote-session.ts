import type { ClientContext, MobileSessionRow } from '../compat/types.ts'
import { mainSessionIdOf } from '../compat/types.ts'
import { isVirtual } from '../../virtual-id.ts'
import { REMOTE_SESSION_CSS } from '../styles/remote-session.css.ts'

/**
 * The remote-session marker (T41b): the CURRENT main-view session id, read
 * the way the official uiSession `publishMain` reads it (RT
 * dsh-client-ui-session lib/client.js:279-291), stamped onto <html> as
 * `data-zr-remote-session="1"` while it is a virtual (relay) id and removed
 * otherwise. remote-session.css.ts turns the attribute into the hiding of
 * every open-on-the-server-machine entry, so the decision lives at the one
 * place that knows the session and never inside component DOM.
 *
 * The official tie-break is kept verbatim: when the previous answer is still
 * mainView-retained it STAYS the answer, and only otherwise does the first
 * mainView-retained row in catalog order win — so two simultaneously
 * retained rows are decided by "current", never by iteration order. The
 * current value comes from the uiSession service's own main binding source
 * (`current.value.key`); where the service has not registered yet the scan
 * (compat/types.ts mainSessionIdOf) stands in, and a later list or main
 * change re-decides — which is why BOTH sources are subscribed below.
 *
 * Kept outside React for the same reason the header status dot is: the
 * attribute must track the current session regardless of which panel is
 * mounted, and an attribute + stylesheet survives every re-render untouched.
 */
export function installRemoteSessionGuard(ctx: ClientContext): void {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-zen-remote'
    tag.dataset.pluginCss = 'dsh-zen-remote/remote-session.css'
    tag.textContent = REMOTE_SESSION_CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'dsh-zen-remote: remote-session styles')

  ctx.effect(() => {
    const apply = (): void => {
      const { byId } = ctx.sessions.list.getSnapshot()
      // publishMain's tie-break (see the module comment): prefer the still-
      // retained current main binding, else the first mainView row.
      const uiSession = ctx.get('uiSession') as { current?: { value?: { key?: unknown }, subscribe?: (listener: () => void) => () => void } } | undefined
      const current = uiSession?.current?.value?.key
      const rows = byId as Readonly<Record<string, MobileSessionRow>>
      const sessionId =
        typeof current === 'string' && (rows[current]?.retainedBy?.mainView ?? 0) > 0
          ? current
          : mainSessionIdOf(byId)
      const root = document.documentElement
      if (sessionId !== undefined && isVirtual(sessionId)) root.setAttribute('data-zr-remote-session', '1')
      else root.removeAttribute('data-zr-remote-session')
    }
    apply()
    const offs: Array<() => void> = [ctx.sessions.list.subscribe(apply)]
    // The main binding can move without a list event (a retention change on
    // the current main re-publishes through uiSession's own retain watcher,
    // RT lib/client.js:293-301); subscribe to that source too when it exists.
    const current = (ctx.get('uiSession') as { current?: { subscribe?: (listener: () => void) => () => void } } | undefined)?.current
    if (typeof current?.subscribe === 'function') offs.push(current.subscribe(apply))
    return () => {
      for (const off of offs) off()
      document.documentElement.removeAttribute('data-zr-remote-session')
    }
  }, 'dsh-zen-remote: remote-session attribute')
}
