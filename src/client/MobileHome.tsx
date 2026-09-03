import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, TouchEvent as ReactTouchEvent } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14,
  IconChevronLeftOutline14,
  IconPlusOutline16,
  IconSettingsOutline16,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { agentPresetOf } from './compat/types.ts'
import type { MobileSessionRow, SessionId, UsePendingInteractions, WorkspaceId } from './compat/types.ts'
import { NS } from './locales.ts'
import { GO_HOME_EVENT } from './nav-store.ts'
import { hasLayer, popLayer, pushLayer } from './history-nav.ts'

/** The phone shell's one page-stack step: session list -> session. */
const SESSION_LAYER = 'session'
import type { createNavStore } from './nav-store.ts'
import type { WorkspaceFilter } from './nav-store.ts'
import type { MobileNavKey } from './locales.ts'
import { dotState } from './session-dot.ts'
import { MobileHomeChips, MobileHomeChipsSheetBody } from './MobileHomeChips.tsx'

/** Full props for the phone home screen (shell.overlay entry). */
export type MobileHomeProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createNavStore>>
  & PropsLocale<typeof NS>
  & {
    /** Bound ctx.sessions.open(id). */
    openSession: (id: SessionId) => void
    /** Bound ctx.workspaces.startSession(workspaceId?). */
    startSession: (workspaceId?: WorkspaceId) => void
    /** Bound ctx.sessionLogDownload.download() — the session-log chip (S5). */
    downloadSessionLog: (id: SessionId) => void
    /** Bound ctx.workspaces.archiveSession(id) — the row swipe action. */
    archiveSession: (id: SessionId) => Promise<void>
    /**
     * 0.1.2 的待处理交互选择器标准 prop；0.1.1 没有这个 prop，运行时读到
     * undefined（见组件里 EMPTY_PENDING_HOOK 兜底）。
     */
    useSessionPendingInteraction?: UsePendingInteractions
  }

/** Phone breakpoint: below the tablet range, where the app-shell layout applies. */
const PHONE_QUERY = '(max-width: 767px)'

/**
 * Empty pending-interaction map singleton: when the 0.1.2 source is absent
 * the fallback hook returns THIS map, so the selector sees one stable
 * reference across renders — a fresh Map per render would make every
 * selector result a new reference and loop the list into infinite
 * re-renders. Module-level on purpose.
 */
const EMPTY_PENDING_MAP: ReadonlyMap<SessionId, unknown> = new Map()

/** 0.1.1 兜底：恒返回空 Map 的替身 hook（见组件里 useSessionPendingInteraction ?? EMPTY_PENDING_HOOK）。 */
const EMPTY_PENDING_HOOK: UsePendingInteractions =
  <S,>(sel: (m: ReadonlyMap<SessionId, unknown>) => S) => sel(EMPTY_PENDING_MAP)

/** Swipe geometry: reveal width of the archive action / settle threshold. */
const SWIPE_REVEAL = 88
const SWIPE_SETTLE = 44

/**
 * Direction-lock slop: total displacement before the gesture commits to
 * horizontal (card drag) or vertical (native scroll) — decided ONCE per
 * touch, the way native swipe rows do it. Before the lock nothing moves.
 */
const SWIPE_SLOP = 10
/** Horizontal wins only when clearly flatter than ~35° (|dx| > 1.4·|dy|). */
const SWIPE_SLOPE = 1.4

/**
 * One session row with swipe-left-to-archive (user request, 2026-08-25;
 * interaction redone after real-device feedback the same day).
 *
 * Native-pattern mechanics:
 * - **One-shot direction lock.** The first ~10px of displacement decides the
 *   whole gesture: clearly-flat movement (|dx| > 1.4·|dy|) locks to the card
 *   drag, anything else locks to native vertical scroll and the card never
 *   moves again for that touch. The first version re-judged every move
 *   sample, so a curvy upward scroll could flip mid-gesture into a drag.
 * - **Progressive reveal, iOS-mail style.** The wrapper clips (overflow:
 *   hidden) and the archive button is PARKED past the right edge, sliding in
 *   lock-step with the card (button shift = reveal + card shift). Nothing is
 *   pre-painted under the card, so a 1px drag shows a 1px slice of button
 *   edge — not a fully drawn button popping through a gap.
 * - At most one row open at a time (parent owns `open`); tapping an open or
 *   mid-drag card closes it instead of navigating.
 *
 * Touch-only by design — the list only exists on the phone breakpoint.
 */
function SwipeRow({ open, onOpenChange, onArchive, archiveLabel, children }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onArchive: () => void
  archiveLabel: string
  children: (guardClick: (navigate: () => void) => void) => ReactNode
}) {
  const start = useRef<{ x: number, y: number } | null>(null)
  const lock = useRef<'h' | 'v' | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  // Ref mirror of `drag`: touchend must read the LATEST position even when
  // the browser delivers move+end in one task (coalesced touch events) —
  // the state value in this render's closure can be a frame stale.
  const dragRef = useRef<number | null>(null)
  const moveTo = (value: number | null): void => {
    dragRef.current = value
    setDrag(value)
  }

  const base = open ? -SWIPE_REVEAL : 0
  const shift = drag ?? base
  const dragging = drag !== null

  const onTouchStart = (e: ReactTouchEvent): void => {
    const t = e.touches[0]
    if (t === undefined) return
    start.current = { x: t.clientX, y: t.clientY }
    lock.current = null
  }
  const onTouchMove = (e: ReactTouchEvent): void => {
    const s = start.current
    const t = e.touches[0]
    if (s === null || t === undefined) return
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (lock.current === null) {
      if (Math.hypot(dx, dy) < SWIPE_SLOP) return
      lock.current = Math.abs(dx) > SWIPE_SLOPE * Math.abs(dy) ? 'h' : 'v'
      if (lock.current === 'v') return
      // Re-anchor so the card starts moving from here, not with a 10px jump.
      start.current = { x: t.clientX, y: t.clientY }
      return
    }
    if (lock.current === 'v') return
    moveTo(Math.max(-SWIPE_REVEAL, Math.min(0, base + dx)))
  }
  const onTouchEnd = (): void => {
    start.current = null
    if (lock.current !== 'h') return
    const settled = (dragRef.current ?? base) < -SWIPE_SETTLE
    moveTo(null)
    onOpenChange(settled)
  }

  const guardClick = (navigate: () => void): void => {
    // A tap on an open (or mid-drag) card closes it; navigation needs a
    // second, clean tap. Matches every list app's swipe convention.
    if (open || lock.current === 'h') onOpenChange(false)
    else navigate()
  }

  const motion = dragging ? { transition: 'none' as const } : {}
  return (
    <li
      data-mobile-nav="home-swipe"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <button
        type="button"
        data-mobile-nav="home-archive"
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        style={{ transform: `translateX(${SWIPE_REVEAL + shift}px)`, ...motion }}
        onClick={onArchive}
      >
        {archiveLabel}
      </button>
      <div
        data-mobile-nav="home-swipe-card"
        style={{ transform: `translateX(${shift}px)`, ...motion }}
      >
        {children(guardClick)}
      </div>
    </li>
  )
}


/** Live matchMedia hook for the phone breakpoint. */
function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches)
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY)
    const onChange = (event: MediaQueryListEvent) => setPhone(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return phone
}

/**
 * The site's own favicon, read at runtime from `document.head` (real-device
 * round 2 feedback: a home-screen logo, without shipping any trademarked
 * asset in this repo). A one-time lazy read is enough — the gateway/host
 * writes this `<link>` before the client bundle ever runs (same "first
 * frame" guarantee AGENTS.md documents for `viewport-fit=cover`), and
 * favicons do not change at runtime in practice, so there is no case here
 * that justifies a MutationObserver.
 */
function useSiteIconHref(): string | undefined {
  const [href] = useState(() => document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href)
  return href
}

// Timestamps use the browser's own locale data — no dictionary keys, correct
// plurals everywhere. Deliberately NOT `document.documentElement.lang`: the
// shell stamps zh-CN there while the UI copy follows the browser languages
// (measured 2026-08-17), so the html attribute would print Chinese times in
// an English UI.
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' })

/**
 * Relative timestamp for a session row.
 * @param at - epoch milliseconds.
 * @returns "now" / "3 minutes ago" / "5/12", localized.
 */
function relativeTime(at: number): string {
  const elapsed = Date.now() - at
  if (elapsed < 60_000) return relative.format(0, 'second')
  if (elapsed < 3_600_000) return relative.format(-Math.floor(elapsed / 60_000), 'minute')
  if (elapsed < 86_400_000) return relative.format(-Math.floor(elapsed / 3_600_000), 'hour')
  if (elapsed < 604_800_000) return relative.format(-Math.floor(elapsed / 86_400_000), 'day')
  return shortDate.format(at)
}

/**
 * Card status subline (real-device round 2 follow-up, 2026-08-17): reuses
 * `dotState`'s own state read (the same ongoing/warning/done semantics the
 * dot already encodes) plus `agentPreset` from the same session row — no
 * new data source. Returns undefined when there is neither a
 * state nor a preset to show, so the caller can skip the subline entirely
 * rather than render an empty row.
 */
function statusLine(row: MobileSessionRow, dot: StateDotState | undefined, t: (key: MobileNavKey) => string): string | undefined {
  const preset = agentPresetOf(row)
  const state = dot === 'ongoing' ? t('homeStatusOngoing')
    : dot === 'warning' ? t('homeStatusWarning')
    : dot === 'done' ? t('homeStatusDone')
    : undefined
  if (state !== undefined && preset !== undefined) return `${state} · ${preset}`
  return state ?? preset
}

/**
 * Phone home screen: the full-screen session list that owns the first level
 * of the page stack. Renders nothing at or above 768px — the tablet drawer
 * and the desktop layout stay exactly as they were.
 *
 * All data comes from the standard kit (`useSessions` / `useWorkspaces`) and
 * all navigation from the injected official actions; nothing here reads the
 * official DOM.
 */
export function MobileHome({
  useSessions,
  useWorkspaces,
  useSessionPendingInteraction,
  useStore,
  actions,
  openSession,
  startSession,
  downloadSessionLog,
  archiveSession,
  t,
}: MobileHomeProps) {
  const phone = usePhone()
  const iconHref = useSiteIconHref()
  const [iconBroken, setIconBroken] = useState(false)
  const view = useStore((s) => s.view)
  const pinned = useStore((s) => s.workspace)
  // Whole snapshots: both stores keep unchanged rows identity-stable, and the
  // list re-renders on any session change anyway (the running dots live here).
  const sessions = useSessions((s) => s)
  const workspaces = useWorkspaces((s) => s)
  const [sheet, setSheet] = useState<'filter' | 'chips' | null>(null)
  /** The one row whose archive action is swiped open (null = none). */
  const [swipeOpen, setSwipeOpen] = useState<SessionId | null>(null)
  // 0.1.2 的待处理交互来源；0.1.1 没有这个标准 prop，读到 undefined 时用一个
  // 恒返回空 Map 的替身，保证 hook 调用次数与顺序在两版之间一致（hooks 规则：
  // 真实 hook 只在 0.1.2 被调用，且每次渲染同一位置无条件调用一次）。
  const pendingHook = useSessionPendingInteraction ?? EMPTY_PENDING_HOOK
  const pending = pendingHook((m) => m)

  /** Archive with the same confirm gate the session-info card uses. */
  const onArchiveRow = (id: SessionId): void => {
    if (!window.confirm(t('infoArchiveConfirm'))) { setSwipeOpen(null); return }
    setSwipeOpen(null)
    // The store removes the row reactively (archivedSessionIds frame echo);
    // failures leave the row in place, which is the honest outcome.
    void archiveSession(id)
  }

  // Workspace of the current session — the untouched filter default.
  const currentWorkspaceId = useMemo(() => {
    const current = sessions.current
    if (current === undefined) return undefined
    return workspaces.items.find((item) => item.sessionIds.includes(current))?.workspaceId
  }, [sessions.current, workspaces.items])

  const selected: WorkspaceFilter = pinned ?? currentWorkspaceId ?? 'all'
  const selectedWorkspace = selected === 'all'
    ? undefined
    : workspaces.items.find((item) => item.workspaceId === selected)

  const rows = useMemo(() => {
    const archived = new Set(workspaces.archivedSessionIds)
    const scope = selectedWorkspace === undefined ? null : new Set(selectedWorkspace.sessionIds)
    return sessions.ids
      .flatMap((id) => {
        const row = sessions.byId[id]
        return row === undefined ? [] : [row]
      })
      // Blank sessions are the New Session placeholders the official sidebar
      // hides too; subagents belong to their parent's session view.
      .filter((row) => !row.blank && row.parentId === undefined && row.origin !== 'subagent')
      .filter((row) => !archived.has(row.id))
      .filter((row) => scope === null || scope.has(row.id))
      // A session that never completed a single turn is not established yet —
      // creating one from the FAB and backing out leaves these behind, and
      // they pile up as basename-titled rows (user report, 2026-08-25). The
      // host's sessionStats projection rides every list row; `turns` counts
      // turns with at least one CLOSED step, and cancelled steps count too,
      // so an interrupted first reply still shows. Keep when: it is the
      // current session (highlight row), it is running (first reply in
      // flight), it earned a title, or the projection is absent (no signal —
      // show rather than silently hide).
      .filter((row) => {
        if (row.id === sessions.current || row.running || row.title !== undefined) return true
        const stats = (row.projectionValues as { sessionStats?: { turns?: number } } | undefined)?.sessionStats
        return stats?.turns === undefined || stats.turns > 0
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions.ids, sessions.byId, sessions.current, workspaces.archivedSessionIds, selectedWorkspace])

  // The session header's back button (session scope) cannot hold this
  // store directly — a handle mounts under exactly one scope, and this one
  // is already root-scoped here (see nav-store.ts) — so it dispatches
  // GO_HOME_EVENT instead and this, the store's actual owner, applies it.
  //
  // Both directions go through the history layer (history-nav.ts) so
  // Android's system back gesture lands on the session→list step instead of
  // exiting the PWA. GO_HOME_EVENT rewinds rather than setting the store: the
  // store is only ever moved home by the layer's own close callback, so the
  // history stack and the page stack cannot drift apart. The direct
  // `show('home')` fallback covers a session view that was somehow entered
  // without a layer (a restored session, a host that blocks pushState).
  useEffect(() => {
    const onGoHome = (): void => {
      if (hasLayer(SESSION_LAYER)) popLayer(SESSION_LAYER)
      else actions.show('home')
    }
    window.addEventListener(GO_HOME_EVENT, onGoHome)
    return () => window.removeEventListener(GO_HOME_EVENT, onGoHome)
  }, [actions])

  const enter = (start: () => void): void => {
    start()
    setSheet(null)
    actions.show('session')
    pushLayer({ id: SESSION_LAYER, close: () => actions.show('home') })
  }

  // Opens the OFFICIAL settings modal (dsh-client-ui-settings-general's
  // SettingsRoot) by clicking its real trigger button — its "open" state is
  // component-local React state with no public setter, same reasoning as
  // MobileSessionHeader's Chat/Trajectory tab click. The trigger mounts
  // inside the sidebar's `sidebar.settings` footer slot
  // (`[class$="_settingsArea"]`, the sidebar shell's stable class suffix —
  // see dsh-client-ui-sidebar's SidebarRoot), which is display:none on the
  // phone breakpoint (home.css.ts): `.click()` still dispatches (bypasses
  // hit-testing, S2.1 precedent) and flips `open`, but the resulting
  // `aria-modal="true"` dialog would still paint nothing without the portal
  // fix in styles/chips.css.ts (`:has([aria-modal="true"])` un-hides exactly
  // the ancestor chain down to it, not the whole sidebar).
  const openSettings = (): void => {
    document.querySelector<HTMLButtonElement>('[class$="_settingsArea"] button[aria-haspopup="dialog"]')?.click()
  }

  if (!phone) return null

  const title = selectedWorkspace?.title ?? t('allWorkspaces')

  return (
    <>
      {/* Hero (new blank session) renders no conversation.session.header, so the
        * header-slot back button doesn't exist there. This floating fallback is
        * hidden by CSS whenever the real header back is mounted. */}
      {view === 'session' && (
        <button
          type="button"
          data-mobile-nav="hero-back"
          aria-label={t('backToList')}
          onClick={() => actions.show('home')}
        >
          <IconChevronLeftOutline14 size={20} />
        </button>
      )}
    <div data-mobile-nav="home" data-view={view} aria-hidden={view === 'session'}>
      <div data-mobile-nav="home-top">
        {iconHref !== undefined && !iconBroken && (
          <img
            src={iconHref}
            alt=""
            aria-hidden="true"
            data-mobile-nav="home-logo"
            onError={() => setIconBroken(true)}
          />
        )}
        <button
          type="button"
          data-mobile-nav="ws-switch"
          aria-haspopup="menu"
          onClick={() => setSheet('filter')}
        >
          <span>{title}</span>
          <IconChevronDownOutline14 size={14} />
        </button>
        <button
          type="button"
          data-mobile-nav="home-settings"
          aria-label={t('settings')}
          title={t('settings')}
          onClick={openSettings}
        >
          <IconSettingsOutline16 size={18} />
        </button>
      </div>

      <MobileHomeChips
        t={t}
        sessionId={sessions.current}
        downloadSessionLog={(id) => downloadSessionLog(id as SessionId)}
        onCustomize={() => setSheet('chips')}
      />

      <ul data-mobile-nav="home-list">
        {rows.map((row) => {
          const dot = dotState(row, pending.has(row.id))
          const status = statusLine(row, dot, t)
          const initial = row.displayTitle.trim().charAt(0).toUpperCase()
          return (
            <SwipeRow
              key={row.id}
              open={swipeOpen === row.id}
              onOpenChange={(open) => setSwipeOpen(open ? row.id : null)}
              onArchive={() => onArchiveRow(row.id)}
              archiveLabel={t('infoArchive')}
            >
              {(guardClick) => (
                <button
                  type="button"
                  data-mobile-nav="home-row"
                  data-current={row.id === sessions.current ? '' : undefined}
                  onClick={() => guardClick(() => enter(() => openSession(row.id)))}
                >
                  <span data-mobile-nav="home-row-avatar" aria-hidden="true">
                    {dot !== undefined ? <StateDot state={dot} size={10} /> : initial}
                  </span>
                  <span data-mobile-nav="home-row-body">
                    <span data-mobile-nav="home-row-title">{row.displayTitle}</span>
                    {status !== undefined && (
                      <span data-mobile-nav="home-row-status">{status}</span>
                    )}
                  </span>
                  <time data-mobile-nav="home-row-time" dateTime={new Date(row.updatedAt).toISOString()}>
                    {relativeTime(row.updatedAt)}
                  </time>
                </button>
              )}
            </SwipeRow>
          )
        })}
        {rows.length === 0 && <li data-mobile-nav="home-empty">{t('noSessions')}</li>}
      </ul>

      <button
        type="button"
        data-mobile-nav="home-fab"
        aria-label={t('newSession')}
        title={t('newSession')}
        onClick={() => enter(() => startSession(selectedWorkspace?.workspaceId))}
      >
        <IconPlusOutline16 size={18} />
        <span>{t('newSession')}</span>
      </button>

      {sheet !== null && (
        <div data-mobile-nav="home-sheet-layer">
          <div
            data-mobile-nav="home-sheet-mask"
            role="button"
            tabIndex={-1}
            aria-label={t('close')}
            onClick={() => setSheet(null)}
          />
          {/* Two sheets share this one container (chrome + S6 drag-to-close
            * + mask-click-close, all keyed off data-mobile-nav="home-sheet"
            * generically — effects/gestures.ts): the workspace switcher
            * (role="menu", unchanged) and the S5 chip-customize toggle list
            * (MobileHomeChipsSheetBody, no menu semantics — its rows are
            * switches, not menu items that close the sheet on click). */}
          <div data-mobile-nav="home-sheet" role={sheet === 'filter' ? 'menu' : undefined}>
            {sheet === 'filter' && (
              <>
                <div data-mobile-nav="home-sheet-title">{t('switchWorkspace')}</div>
                <button
                  type="button"
                  role="menuitem"
                  data-mobile-nav="home-sheet-item"
                  data-selected={selected === 'all' ? '' : undefined}
                  onClick={() => {
                    actions.filter('all')
                    setSheet(null)
                  }}
                >
                  {t('allWorkspaces')}
                </button>
                {workspaces.items.map((item) => (
                  <button
                    key={item.workspaceId}
                    type="button"
                    role="menuitem"
                    data-mobile-nav="home-sheet-item"
                    data-selected={selected === item.workspaceId ? '' : undefined}
                    onClick={() => {
                      actions.filter(item.workspaceId)
                      setSheet(null)
                    }}
                  >
                    {item.title}
                  </button>
                ))}
              </>
            )}
            {sheet === 'chips' && <MobileHomeChipsSheetBody t={t} />}
          </div>
        </div>
      )}
    </div>
    </>
  )
}
