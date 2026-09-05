import type { ClientContext, SessionId, WorkspaceId } from './compat/types.ts'
import { MobileNavToggle } from './MobileNavToggle.tsx'
import { MobileNavOverlay } from './MobileNavOverlay.tsx'
import { MobileDrawerFooter } from './MobileDrawerFooter.tsx'
import { MobileHome } from './MobileHome.tsx'
import { MobileHeaderActions, MobileHeaderUtilities } from './MobileSessionHeader.tsx'
import { MobileSessionInfo } from './MobileSessionInfo.tsx'
import { MobileAttachButton } from './MobileAttachButton.tsx'
import { MobileAttachChips } from './MobileAttachChips.tsx'
import { createNavStore } from './nav-store.ts'
import { MOBILE_CSS } from './styles/index.ts'
import { installDebugBadge } from './debug.ts'
import { installPhoneChrome, installSunkInset, installViewportHeal } from './effects/phone-chrome.ts'
import { installAionuiCompat } from './effects/aionui-compat.ts'
import { installWorkbenchRefClose } from './effects/workbench-ref-close.ts'
import { installHeaderStatusDot } from './effects/header-status.ts'
import { installGestures } from './effects/gestures.ts'
import { installTurnFold } from './effects/turn-fold.ts'
import { installModalBack } from './effects/modal-back.ts'
import { installModelSheetExtras } from './effects/model-sheet-extras.ts'
import { installNativeTriggerOverlay } from './effects/native-trigger-overlay.ts'
import { installWelcomeNoticeOptOut } from './effects/welcome-notice.ts'
import { installKeyboardGuard } from './effects/keyboard-guard.ts'
import { installKeyboardAvoid } from './effects/keyboard-avoid.ts'
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
 * 0.1.2 把新建会话和归档会话的界面级操作挪到了 uiWorkspace 服务；
 * 0.1.1 没有这个服务，那两个操作还在 ctx.workspaces 上。这里按存在探测，
 * 不把 uiWorkspace 写进 inject（写了 0.1.1 就永远不激活）。
 * 类型用本地最小接口，不 import 那个 dsh-client-ui-workspace 包
 * ——0.1.1 装不到。
 */
interface UiWorkspaceLike {
  startSession(workspaceId?: WorkspaceId): void
  archiveSession(sessionId: SessionId): Promise<void>
}

/** 0.1.1 的 ctx.workspaces 上还有 startSession；0.1.2 的类型里没有了。 */
interface LegacyWorkspacesLike {
  startSession(workspaceId?: WorkspaceId): void
}

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
    tag.dataset.plugin = 'dsh-zen-remote'
    tag.dataset.pluginCss = 'dsh-zen-remote/mobile.css'
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

  // Phone: tapping a file's @-reference in the workbench closes the panel —
  // the conversation returning with the fresh mention IS the tap feedback.
  installWorkbenchRefClose(ctx)

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
  installModalBack(ctx)
  installNativeTriggerOverlay(ctx)
  // Third-party composer entries (speed chip, vision toggle) move into the
  // model sheet — the row has no width to spare and both are model settings.
  installModelSheetExtras(ctx)

  // "内测声明" first-run notice: keep it visible (CSS-hiding it leaked the
  // dialog's #root inert lock — see effects/welcome-notice.ts) and offer a
  // per-browser "不再弹出" opt-out instead.
  installWelcomeNoticeOptOut(ctx)

  // S9: opening a session must not pop the phone keyboard — the official
  // composer autofocuses on every sessionId change; keep focus only when the
  // user tapped the composer (or typed) themselves.
  installKeyboardGuard(ctx)

  // S10: when the keyboard shrinks the visual viewport but the browser fails
  // to reveal the focused composer (issue #1 的「视口缩了页面没跟上」类环境),
  // translate the composer up by the occluded band. Inert everywhere else.
  installKeyboardAvoid(ctx)

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
      // 0.1.2 的界面级归档在 uiWorkspace（顺带清当前选中）；懒查——回调是用户
      // 点击才跑，那时服务必已注册。本插件的 inject 不包含 uiWorkspace（0.1.1
      // 没有它），所以启动时不能查一次就用：可能早于它注册。
      archiveSession: (id: SessionId) => {
        const ui = ctx.get('uiWorkspace') as UiWorkspaceLike | undefined
        return ui === undefined ? ctx.workspaces.archiveSession(id) : ui.archiveSession(id)
      },
      downloadSessionLog: (id: SessionId) => ctx.sessionLogDownload.download(id),
    }),
  }, MobileSessionInfo))

  // Composer attachment seat (S7). Registered unconditionally;
  // styles/composer.css.ts hides it at >= 768px and orders it into the
  // leftmost seat of the phone composer row.
  //
  // No `inject` here: every attachment now rides the host upload route and
  // the standard session props (`sessionId`, `inputActions`), so the button
  // needs nothing bound off ctx. S7.1 removed the session.prompt binding that
  // used to send inlineable images straight into the conversation.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'mobile-attach',
    order: 0,
    locale: NS,
  }, MobileAttachButton))

  // Attachment preview row (S7.1), above the composer card. Renders purely
  // off the draft's @.dsh-uploads/ tokens — see MobileAttachChips.tsx. Order 0
  // puts it left of the git branch chip (order 100) on the shared dock line.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'mobile-attach-chips',
    order: 0,
    locale: NS,
  }, MobileAttachChips))

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
      // uiWorkspace 懒查：回调是用户点击才跑，服务那时必已注册（inject 不含
      // uiWorkspace，启动时可能先于它注册，不能启动查一次就用）。0.1.1 上恒
      // undefined，退回 ctx.workspaces.startSession——0.1.1 专用分支，0.1.2 的
      // 类型里该方法已不存在，故对类型做 LegacyWorkspacesLike cast，运行时走不到。
      startSession: (workspaceId?: WorkspaceId) => {
        const ui = ctx.get('uiWorkspace') as UiWorkspaceLike | undefined
        return ui === undefined
          ? (ctx.workspaces as unknown as LegacyWorkspacesLike).startSession(workspaceId)
          : ui.startSession(workspaceId)
      },
      // S5 session-log chip — the same service call MobileDrawerFooter uses.
      downloadSessionLog: (id: SessionId) => ctx.sessionLogDownload.download(id),
      // Row swipe action — the same binding MobileSessionInfo archives with;
      // on 0.1.2 the uiWorkspace variant also clears the current selection
      // when the archived session is the one selected. Same lazy lookup as
      // the session-info sheet's archive binding above.
      archiveSession: (id: SessionId) => {
        const ui = ctx.get('uiWorkspace') as UiWorkspaceLike | undefined
        return ui === undefined ? ctx.workspaces.archiveSession(id) : ui.archiveSession(id)
      },
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
      // The footer slot contract hands the id over as a loose string;
      // download() wants the branded SessionId — pure type-layer narrowing
      // (runtime value is a session id either way, same as MobileHome.tsx).
      downloadSessionLog: (sessionId: string) => ctx.sessionLogDownload.download(sessionId as SessionId),
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
// 0.1.2-only package: augments GlobalStandardProps with
// useSessions/useSessionPendingInteraction and SessionStandardProps with
// sessionId/useSession/useProjection, and declares the `ctx.uiSession`
// service. 0.1.1 has no such package — but this is `import type`, so the
// build output carries no trace of it and the runtime is unaffected.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// 0.1.2-only controller packages: their `/client` type entries merge
// `ctx.sessions` / `ctx.workspaces` onto the cordis Context (0.1.1 declared
// both from dsh-client-runtime). Type-only again — nothing to load at
// runtime, so a 0.1.1 installation is unaffected.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// 0.1.2-only, type-only: the renderer declares `ctx.slots` on the cordis
// Context (the service this plugin registers every slot through) and
// `dsh-subagent/client` types the subagent catalog rows the session header
// reads (SessionListState.subagentsByParent). 0.1.1 had both declared in the
// dsh-client-runtime bundle that no longer exists.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
