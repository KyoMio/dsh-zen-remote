import type { ClientContext, MobileSessionRow } from '../compat/types.ts'
import { mainSessionIdOf } from '../compat/types.ts'
import { isVirtual } from '../../virtual-id.ts'
import { REMOTE_SESSION_CSS } from '../styles/remote-session.css.ts'
import { BRIDGE_STAMP_ATTRIBUTE, BRIDGE_STAMP_PLUGIN, getRemoteStatusStore, shouldStampBridgeAttribute, subscribeIfVirtual } from '../../client-data/remote-status.ts'
import { en, zh } from '../locales.ts'

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

/** The CURRENT main-view session id, the publishMain way (see the module
 * comment). Shared by the session marker and the bridge stamp — both key on
 * the same "which session is on screen" answer. */
function currentMainSessionIdOf(ctx: ClientContext): string | undefined {
  const { byId } = ctx.sessions.list.getSnapshot()
  const uiSession = ctx.get('uiSession') as { current?: { value?: { key?: unknown } } } | undefined
  const current = uiSession?.current?.value?.key
  const rows = byId as Readonly<Record<string, MobileSessionRow>>
  return typeof current === 'string' && (rows[current]?.retainedBy?.mainView ?? 0) > 0
    ? current
    : mainSessionIdOf(byId)
}

/** The unbridged note copy in the BROWSER's language (the plugin's own
 * namespace carries both dictionaries; the framework `t` seat is not
 * reachable from a non-React effect, so the navigator's language picks —
 * `zh*` reads Chinese, everything else English). */
function bridgeNoteOf(language: string | undefined): string {
  const key = 'remoteBridgeUnbridgedNote' as const
  return typeof language === 'string' && language.startsWith('zh') ? zh[key] : en[key]
}

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
      const sessionId = currentMainSessionIdOf(ctx)
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

  // The bridge stamp (PB-14): while a REMOTE session is on screen, the
  // remote-status poll's `bridgedPlugins` decides whether better-sidebar is
  // bridged RIGHT NOW — bridged, the T53 hiding rules lift (the panels read
  // the server's data through the adapter) and the html carries
  // `data-zr-bridge-dsh-better-sidebar="1"`; not bridged, the rules stay
  // and the html carries the unbridged note copy as a CSS variable the
  // stylesheet spends on the empty tab body. The subscription rides
  // subscribeIfVirtual — a LOCAL session (or a host page) never polls, and
  // the attribute comes off; better-sidebar not installed or the server not
  // paired simply never appear in `bridgedPlugins`, so the stamp never
  // fires from this side alone.
  ctx.effect(() => {
    const root = document.documentElement
    const store = getRemoteStatusStore()
    let offStore: (() => void) | undefined
    const clear = (): void => {
      root.removeAttribute(BRIDGE_STAMP_ATTRIBUTE)
      root.style.removeProperty('--zr-bridge-note')
    }
    const applyBridge = (): void => {
      const view = store.getSnapshot().view
      if (shouldStampBridgeAttribute(view?.bridgedPlugins, BRIDGE_STAMP_PLUGIN)) {
        root.setAttribute(BRIDGE_STAMP_ATTRIBUTE, '1')
        root.style.removeProperty('--zr-bridge-note')
      } else {
        root.removeAttribute(BRIDGE_STAMP_ATTRIBUTE)
        // JSON.stringify's quotes are a legal CSS string — the stylesheet's
        // ::before spends it as `content: var(--zr-bridge-note)`.
        root.style.setProperty('--zr-bridge-note', JSON.stringify(bridgeNoteOf(navigator.language)))
      }
    }
    const retune = (): void => {
      const sessionId = currentMainSessionIdOf(ctx)
      const virtualNow = sessionId !== undefined && isVirtual(sessionId)
      if (virtualNow && offStore === undefined && typeof sessionId === 'string') {
        offStore = subscribeIfVirtual(store, sessionId, applyBridge)
        applyBridge()
        return
      }
      if (!virtualNow && offStore !== undefined) {
        offStore()
        offStore = undefined
        clear()
      }
    }
    retune()
    const offs: Array<() => void> = [ctx.sessions.list.subscribe(retune)]
    const current = (ctx.get('uiSession') as { current?: { subscribe?: (listener: () => void) => () => void } } | undefined)?.current
    if (typeof current?.subscribe === 'function') offs.push(current.subscribe(retune))
    return () => {
      for (const off of offs) off()
      offStore?.()
      clear()
    }
  }, 'dsh-zen-remote: bridge stamp')
}
