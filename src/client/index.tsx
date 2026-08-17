import type { ClientContext, SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { MobileNavToggle } from './MobileNavToggle.tsx'
import { MobileNavOverlay } from './MobileNavOverlay.tsx'
import { MobileDrawerFooter } from './MobileDrawerFooter.tsx'
import { MobileHome } from './MobileHome.tsx'
import { MobileHeaderActions, MobileHeaderUtilities } from './MobileSessionHeader.tsx'
import { MobileSessionInfo } from './MobileSessionInfo.tsx'
import { MobileAttachButton } from './MobileAttachButton.tsx'
import { createNavStore } from './nav-store.ts'
import { MOBILE_CSS } from './styles/index.ts'
import { installDebugBadge } from './debug.ts'
import { installPhoneChrome, installSunkInset, installViewportHeal } from './effects/phone-chrome.ts'
import { installAionuiCompat } from './effects/aionui-compat.ts'
import { installHeaderStatusDot } from './effects/header-status.ts'
import { installGestures } from './effects/gestures.ts'
import { installTurnFold } from './effects/turn-fold.ts'
import { NS, en, zh } from './locales.ts'
import type { MobileNavKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Directory-drawer controls copy. */
    'mobileNav': MobileNavKey
  }
}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'layout', 'locale', 'sessionLogDownload', 'sessions', 'workspaces']

/**
 * Mobile-adaptive shell, browser half: injects the mobile stylesheet, then
 * contributes the directory toggle to the session header and the backdrop +
 * floating button to the shell overlay.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mobile-nav: dictionaries')

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@dsh-external/dsh-mobile-nav'
    tag.dataset.pluginCss = '@dsh-external/dsh-mobile-nav/mobile.css'
    tag.textContent = MOBILE_CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'dsh-mobile-nav: styles')

  // Diagnostic overlay for phone-side repros (?mobile-nav-debug=1).
  installDebugBadge(ctx)

  installPhoneChrome(ctx)

  // Standalone-PWA only: undo the WebKit keyboard bug that permanently steals
  // the status-bar height from the viewport (the ~60px band under the
  // composer and the session list). No-op in any browser tab.
  installViewportHeal(ctx)

  // Registered after the heal so a viewport that heals is measured healed:
  // when the strip is real, drop the home-indicator padding that would only
  // stack more blank page on top of it.
  installSunkInset(ctx)

  installAionuiCompat(ctx)

  // Session header running-status dot (S2): no official element exists to
  // reposition, so this reads ctx.sessions directly and self-draws via CSS.
  installHeaderStatusDot(ctx)

  // S6: content-area swipe (Chat/Trajectory) + sheet drag-to-close.
  installGestures(ctx)

  // S8: fold a turn's process (tool calls, injected context, slash commands,
  // Think rows) behind one summary chip. Chat view only, phone only — see
  // effects/turn-fold.ts for why the keyed conversation.chat.node seat could
  // not carry this.
  installTurnFold(ctx)

  // Page-stack store (apply world) — created before any registration so
  // every slot below (the phone home screen, the session header's back
  // button) shares the exact same handle/instance.
  const nav = createNavStore()

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'mobile-nav-toggle',
    order: 10,
    locale: NS,
    inject: () => ({
      toggleSidebar: () => ctx.layout.toggleSidebar(),
    }),
  }, MobileNavToggle))

  // Session header back button + Chat/Trajectory view-switch row (S2).
  // Renders unconditionally; CSS (styles/header.css.ts) keeps it hidden at
  // >= 768px. Order is irrelevant here — the phone stylesheet hides every
  // other header.actions entry and only re-shows this one.
  //
  // No `store: nav` here: this slot is session-scope while `nav` already
  // mounts at shell.overlay's root scope, and a handle can only mount
  // under one scope (runtime throws otherwise — see nav-store.ts). The
  // back button dispatches GO_HOME_EVENT and MobileHome applies it.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'mobile-header-actions',
    order: 0,
    locale: NS,
  }, MobileHeaderActions))

  // Session-info entry (placeholder — S4 owns the sheet) + workbench entry
  // (dsh-better-sidebar, see MobileSessionHeader.tsx for the trigger).
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'mobile-header-utilities',
    order: 0,
    locale: NS,
  }, MobileHeaderUtilities))

  // Session-info sheet (S4): a second, sibling entry on the SAME slot as
  // the ⓘ button above — it listens for the CustomEvent that button fires
  // instead of sharing render state with it. Session scope gives this
  // entry useProjection/sessionId (the stats grid) for free alongside the
  // always-present useSessions/useWorkspaces (see MobileSessionInfo.tsx's
  // header comment for the full mount-point tradeoff against shell.overlay).
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'mobile-session-info',
    order: 10,
    locale: NS,
    // The factory's own sessionId param is unused: every function below
    // takes its own session id explicitly (they're generic action bindings
    // reused verbatim, not closures over one particular session).
    inject: (_sessionId: SessionId) => ({
      forkSession: (id: SessionId) => ctx.sessions.fork({ sessionId: id }),
      openSession: (id: SessionId) => ctx.sessions.open(id),
      renameSession: (id: SessionId, title: string) => ctx.sessions.binding(id)?.session.rename(title),
      archiveSession: (id: SessionId) => ctx.workspaces.archiveSession(id),
      downloadSessionLog: (id: SessionId) => ctx.sessionLogDownload.download(id),
    }),
  }, MobileSessionInfo))

  // Composer attachment seat (S3 placeholder, S7 wires it to a real picker).
  // Registered unconditionally; styles/composer.css.ts hides it at >= 768px
  // and orders it into the leftmost seat of the phone composer row.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'mobile-attach',
    order: 0,
    locale: NS,
  }, MobileAttachButton))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'mobile-nav-overlay',
    order: 10,
    locale: NS,
    inject: () => ({
      toggleSidebar: () => ctx.layout.toggleSidebar(),
    }),
  }, MobileNavOverlay))

  // Phone app shell (< 768px): the full-screen session list that is level 1
  // of the page stack. Owns the `nav` handle created above (root scope);
  // the session header's back button listens for GO_HOME_EVENT instead of
  // sharing the handle directly (see nav-store.ts and the comment above).
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'mobile-home',
    order: 20,
    locale: NS,
    store: nav,
    inject: () => ({
      openSession: (id: SessionId) => ctx.sessions.open(id),
      startSession: (workspaceId?: WorkspaceId) => ctx.workspaces.startSession(workspaceId),
      // S5 session-log chip — the same service call MobileDrawerFooter uses.
      downloadSessionLog: (id: SessionId) => ctx.sessionLogDownload.download(id),
    }),
  }, MobileHome))

  // Session log download, relocated from the session header to the drawer
  // footer on mobile (the header capsule is hidden by CSS); the drawer
  // footer also hosts the Files action that opens the dsh-web-ui explorer
  // sheet.
  //
  // Footer stacking relies on the list-slot sort by (priority, order):
  // dsh-remote-web-ui leaves it unset (default 0, its two icon buttons stay
  // on top) and dsh-usage-stats uses 10. Order 5 keeps the Files + Session
  // log pills directly under the icon row with the usage/balance badge
  // below them — instead of a tie at 10 where registration order could
  // wedge the badge between the icons and the pills.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'mobile-nav-session-log',
    order: 5,
    locale: NS,
    inject: () => ({
      downloadSessionLog: (sessionId: string) => ctx.sessionLogDownload.download(sessionId),
      toggleSidebar: () => ctx.layout.toggleSidebar(),
    }),
  }, MobileDrawerFooter))
}

// Type-only augmentation imports: pull the layout / conversation / sidebar
// SlotMap merges and the sessionLogDownload service typing into this program
// without any runtime import.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-session-log-export/client'
