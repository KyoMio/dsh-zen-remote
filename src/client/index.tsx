import type { ClientContext, JobsLike, SessionId, WorkspaceId } from './compat/types.ts'
import { isDesktopShell } from './compat/desktop.ts'
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
import { SharePreview } from './share/share-preview.tsx'
import { NS } from './locales.ts'
import type { MobileNavKey } from './locales.ts'
import { SettingsSection } from './settings/SettingsSection.tsx'
import { registerSettingsPage } from './settings/register-settings.ts'
import { RemoteHeaderIcon } from './RemoteHeaderIcon.tsx'
import { RemoteShareMenuItem } from './RemoteShareMenu.tsx'
import { registerRemoteShareUi } from './remote-share-register.ts'
import { installRemoteApiFetch } from './remote-fetch.ts'
import { installRemoteSessionGuard } from './effects/remote-session.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Directory-drawer controls copy. */
    'mobileNav': MobileNavKey
  }
}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'layout', 'locale', 'sessionLogDownload', 'sessions', 'workspaces']

/**
 * 0.1.2 把新建会话、归档会话与打开会话的界面级操作挪到了 uiWorkspace
 * 服务（0.1.7 删掉了 ctx.sessions.open，这是它唯一的替代入口）。类型用
 * 本地最小接口，不 import 那个 dsh-client-ui-workspace 包——本插件的
 * peerDependencies 不含它，运行时实例由宿主提供，类型自己声明就够。
 */
interface UiWorkspaceLike {
  openSession(target: SessionId): void
  startSession(workspaceId?: WorkspaceId): void
  archiveSession(sessionId: SessionId): Promise<void>
}

/**
 * Activity data both session-header entries read (0.1.7 sources — 0.1.5's
 * per-parent subagent snapshot and per-session job snapshot are gone):
 * - the subagent catalog is read straight off the sessions snapshot's
 *   explicit-read store (`projectionsBySession[id].values.subagentCatalog`),
 *   exactly like the official SubagentHeaderLineage — no refresh is issued
 *   from here: every projection refresh call registers another session in
 *   the controller's load table, and all of them are re-read on every
 *   reconnect (manager handleConnected), so per-open refreshes would grow
 *   into a batch of re-reads forever;
 * - job rows come from the `jobs` client service; the inject face mirrors
 *   the official JobListAction registration (`hooks.jobs` observable → the
 *   renderer hands the component a `useJobs` hook prop). When the service is
 *   absent (a build without the job controller) a fixed empty source keeps
 *   the prop present, so the component's hook count never varies — the
 *   counts simply read zero instead of the pill silently disappearing.
 */
const NO_JOBS_SNAPSHOT = Object.freeze({ rows: Object.freeze({}) }) as {
  readonly rows: Readonly<Record<string, readonly never[]>>
}
/** Module-level singleton: one stable observable identity across renders. */
const NO_JOBS_SOURCE = {
  getSnapshot: () => NO_JOBS_SNAPSHOT,
  subscribe: (): (() => void) => () => {},
}
const NO_WATCH_ROWS = (): (() => void) => () => {}

function activityInject(ctx: ClientContext) {
  const jobs = ctx.get('jobs') as JobsLike | undefined
  return {
    hooks: { jobs: jobs === undefined ? NO_JOBS_SOURCE : jobs.state },
    watchRows: jobs === undefined ? NO_WATCH_ROWS : (id: SessionId) => jobs.watchRows(id),
  }
}

/**
 * Mobile-adaptive shell, browser half: injects the mobile stylesheet, then
 * contributes the directory toggle to the session header and the backdrop +
 * floating button to the shell overlay.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // 2.0.0 设置页：必须在桌面门之前注册——桌面端 App 里手机外壳整体不生效，
  // 但设置页必须生效（主服务端就是桌面端）。字典、设置页样式与设置表单服务
  // 的按需注入都在 registerSettingsPage 里（那个服务名绝不进顶层的 inject
  // 数组，否则没有该服务的环境整个界面半边都加载不了）。
  registerSettingsPage(ctx, SettingsSection)

  // T33b 会话共享的三个入口里前两个（标题行远程图标、会话右键菜单项）：
  // 同样必须在桌面门之前注册——桌面端 App 就是主服务端，图标和菜单恰好
  // 住在它的标题行与会话菜单里。部件自身按数据降级：shares 路由 404
  // （子客户端部署没有这条路由）时渲染为空，手机外壳则由样式表兜底隐藏
  // （styles/header.css.ts 的 header.actions 全量隐藏）。设置页的共享
  // 列表在 SettingsSection 内部，随设置页已在门之前。
  registerRemoteShareUi(ctx, RemoteHeaderIcon, RemoteShareMenuItem)

  // T41b 的两个远程会话部件：fetch 改写（改动 / diff 面板的两条 /api GET）与
  // 远程会话标记（data-zr-remote-session + 隐藏「在服务端机器上打开」类入口
  // 的样式）。同样必须在桌面门之前注册——桌面窗口也可以是配对好的子客户端，
  // 改写与隐藏在它里面一样必要。改写只碰「同源 + 精确两条路径 + zr~ 虚拟
  // 会话 id」的 GET（remote-fetch.ts），宿主角色的桌面端（会话 id 永非虚拟）
  // 逐字节原样放行；标记属性只在虚拟会话打开时出现，卸载时还原。
  ctx.effect(() => installRemoteApiFetch(window), 'dsh-zen-remote: remote api fetch')
  installRemoteSessionGuard(ctx)

  // Desktop gate (DSH 0.1.7): the official Electron shell can be dragged
  // down to ~520px wide, where every width-based gate would flip the phone
  // shell on inside the desktop app. Inside that shell this plugin is a
  // complete no-op — no stylesheet, no effects, no slot entries, which is
  // bit-for-bit "not installed" and also retires the desktop-fold knobs
  // there (they exist for narrow desktop *browsers*, which never carry the
  // dshDesktop bridge). See compat/desktop.ts for the marker's provenance.
  if (isDesktopShell()) return

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
    // Activity-pill data (subagent catalog + job roster), see activityInject.
    inject: () => activityInject(ctx),
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
    // reused verbatim, not closures over one particular session). The
    // spread adds the activity-pill data (subagent catalog + job roster for
    // the info-sheet badges), see activityInject.
    inject: (_sessionId: SessionId) => ({
      ...activityInject(ctx),
      forkSession: (id: SessionId) => ctx.sessions.fork({ sessionId: id }),
      // 0.1.7: ctx.sessions.open is gone; uiWorkspace.openSession is the one
      // navigation entry (also what the official subagent catalog uses).
      // Lazy lookup like every other uiWorkspace binding here: the callback
      // runs on a user tap, by which time the service is registered.
      openSession: (id: SessionId) => {
        const ui = ctx.get('uiWorkspace') as UiWorkspaceLike | undefined
        if (ui === undefined) console.warn('[dsh-zen-remote] uiWorkspace service unavailable; cannot open session', id)
        else ui.openSession(id)
      },
      renameSession: (id: SessionId, title: string) => ctx.sessions.binding(id)?.session.rename(title),
      // 0.1.2 的界面级归档在 uiWorkspace（顺带清当前选中）；懒查——回调是用户
      // 点击才跑，那时服务必已注册。本插件的 inject 不包含 uiWorkspace，
      // 所以启动时不能查一次就用：可能早于它注册。
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
      // Same uiWorkspace.openSession binding as the session-info sheet above.
      openSession: (id: SessionId) => {
        const ui = ctx.get('uiWorkspace') as UiWorkspaceLike | undefined
        if (ui === undefined) console.warn('[dsh-zen-remote] uiWorkspace service unavailable; cannot open session', id)
        else ui.openSession(id)
      },
      // uiWorkspace 懒查：回调是用户点击才跑，服务那时必已注册（inject 不含
      // uiWorkspace，启动时可能先于它注册，不能启动查一次就用）。
      startSession: (workspaceId?: WorkspaceId) => {
        const ui = ctx.get('uiWorkspace') as UiWorkspaceLike | undefined
        if (ui === undefined) console.warn('[dsh-zen-remote] uiWorkspace service unavailable; cannot start a session')
        else ui.startSession(workspaceId)
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

  // Share-card debug preview (ticket 03): renders the share-card template at
  // the top of the page so its layout is inspectable before the rasterizer
  // (ticket 04) exists. Registered ONLY with the URL param, so the no-param
  // path — including desktop — stays bit-for-bit untouched (same debug-param
  // exemption as ?mobile-nav-inset=, see debug.ts).
  if (new URLSearchParams(location.search).has('mobile-nav-share-preview')) {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'share-preview',
      // Above the phone home screen (order 20) within the same overlay layer.
      order: 30,
      locale: NS,
    }, SharePreview))
  }
}

// Type-only augmentation imports: pull the layout / conversation / sidebar
// SlotMap merges and the sessionLogDownload service typing into this program
// without any runtime import.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-session-log-export/client'
// ui-session: augments GlobalStandardProps with useSessions /
// useSessionPendingInteraction / useSessionStatus and SessionStandardProps
// with sessionId/useSession/useProjection, and declares the `ctx.uiSession`
// service.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Controller packages: their `/client` type entries merge `ctx.sessions` /
// `ctx.workspaces` onto the cordis Context. Type-only — nothing to load at
// runtime.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the renderer declares `ctx.slots` on the cordis Context (the
// service this plugin registers every slot through) and `dsh-subagent/client`
// types the subagent catalog projection entries the session header reads
// (projectionsBySession[].values.subagentCatalog on 0.1.7).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
