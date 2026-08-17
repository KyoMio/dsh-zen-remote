import { useEffect, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14,
  IconChevronLeftOutline14,
  IconPlusOutline16,
  IconSettingsOutline16,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, SessionSummary, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { NS } from './locales.ts'
import { GO_HOME_EVENT } from './nav-store.ts'
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
  }

/** Phone breakpoint: below the tablet range, where the app-shell layout applies. */
const PHONE_QUERY = '(max-width: 767px)'


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
 * dot already encodes) plus `agentPreset` from the same `SessionSummary`
 * row — no new data source. Returns undefined when there is neither a
 * state nor a preset to show, so the caller can skip the subline entirely
 * rather than render an empty row.
 */
function statusLine(row: SessionSummary, dot: StateDotState | undefined, t: (key: MobileNavKey) => string): string | undefined {
  const state = dot === 'ongoing' ? t('homeStatusOngoing')
    : dot === 'warning' ? t('homeStatusWarning')
    : dot === 'done' ? t('homeStatusDone')
    : undefined
  if (state !== undefined && row.agentPreset !== undefined) return `${state} · ${row.agentPreset}`
  return state ?? row.agentPreset
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
  useStore,
  actions,
  openSession,
  startSession,
  downloadSessionLog,
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
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions.ids, sessions.byId, workspaces.archivedSessionIds, selectedWorkspace])

  // The session header's back button (session scope) cannot hold this
  // store directly — a handle mounts under exactly one scope, and this one
  // is already root-scoped here (see nav-store.ts) — so it dispatches
  // GO_HOME_EVENT instead and this, the store's actual owner, applies it.
  useEffect(() => {
    const onGoHome = (): void => actions.show('home')
    window.addEventListener(GO_HOME_EVENT, onGoHome)
    return () => window.removeEventListener(GO_HOME_EVENT, onGoHome)
  }, [actions])

  const enter = (start: () => void): void => {
    start()
    setSheet(null)
    actions.show('session')
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
          <IconChevronLeftOutline14 size={18} />
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
          const dot = dotState(row)
          const status = statusLine(row, dot, t)
          const initial = row.displayTitle.trim().charAt(0).toUpperCase()
          return (
            <li key={row.id}>
              <button
                type="button"
                data-mobile-nav="home-row"
                data-current={row.id === sessions.current ? '' : undefined}
                onClick={() => enter(() => openSession(row.id))}
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
            </li>
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
