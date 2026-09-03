import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconArchiveOutline20,
  IconBranchOutline16,
  IconCloseOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceTitleOf } from './compat/store.ts'
import { agentPresetOf } from './compat/types.ts'
import type { RenameResult, SessionId } from './compat/types.ts'
import { NS } from './locales.ts'
import { GO_HOME_EVENT, SESSION_INFO_EVENT } from './nav-store.ts'
import { hasLayer, popLayer, pushLayer } from './history-nav.ts'

/** Layer id for the info sheet, so Android back closes it before leaving the session. */
const INFO_LAYER = 'session-info'
import { useViewTabs } from './MobileSessionHeader.tsx'

// Type-only: pulls the 'sessionStats' / 'tokenUsage' SessionProjectionMap
// merges into the program so useProjection('sessionStats' | 'tokenUsage')
// below type-checks (see appendix D: the official StatsLine, the only other
// consumer, lives in dsh-client-ui-conversation but never re-exports these
// merges from a file this package's type graph reaches — devDependencies +
// tsconfig.client.json path entries added for exactly this).
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'

/** Full props for the session-info sheet (header.utilities, second entry). */
export type MobileSessionInfoProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & {
    /** Bound ctx.sessions.fork({sessionId}). */
    forkSession: (sessionId: SessionId) => Promise<SessionId>
    /** Bound ctx.sessions.open(id) — lands on the freshly forked session. */
    openSession: (id: SessionId) => void
    /** Bound ctx.sessions.binding(id)?.session.rename(title); undefined when the binding is gone. */
    renameSession: (sessionId: SessionId, title: string) => RenameResult | undefined
    /** Bound ctx.workspaces.archiveSession(sessionId). */
    archiveSession: (sessionId: SessionId) => Promise<void>
    /** Bound ctx.sessionLogDownload.download(sessionId) — owns its own progress/result modal. */
    downloadSessionLog: (sessionId: SessionId) => Promise<void>
  }

/* ---- StatsLine-identical formatting -------------------------------------
 * Ported (not imported — the source functions are module-private to
 * StatsLine.tsx) from dsh-client-ui-conversation lib/client.js:2755-2787
 * (verified 2026-08-17). The "口径对齐官方" requirement is digit-for-digit,
 * not just look-alike, so the algorithm is copied exactly. */

/** Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits). */
function formatTokens(n: number): string {
  const scaled = (v: number) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1e3) return String(n)
  if (n < 1e6) return `${scaled(n / 1e3)}K`
  return `${scaled(n / 1e6)}M`
}

/** Compact duration: 45.2s under a minute, 2m42s from there on. */
function formatDuration(ms: number): string {
  const s = ms / 1e3
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Sum of the three disjoint prompt-side billing buckets. */
function billedInputTokens(usage: { uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/**
 * Cache-hit share of prompt-side input over the whole durable log; null when
 * nothing was billed. Returned unrounded — the cell is the headline figure
 * now and shows one decimal, so rounding here would throw that digit away.
 */
function cacheHitPercent(usage: { cacheReadTokens: number; uncachedInputTokens: number; cacheWriteTokens: number }): number | null {
  const denominator = billedInputTokens(usage)
  return denominator === 0 ? null : (usage.cacheReadTokens / denominator) * 100
}

/** Data-missing / not-yet-observed placeholder for a stat cell. */
const NA = '—'

/**
 * Session-info sheet: the bottom sheet that gathers everything S3 pulled off
 * the composer (the official stats strip) and everything S2 left out of the
 * header (Chat/Trajectory as a real control, badges, session actions).
 *
 * Registered as a SECOND entry on `conversation.session.header.utilities` —
 * session scope, sibling to the ⓘ button that opens it
 * (MobileSessionHeader.tsx dispatches {@link SESSION_INFO_EVENT}).
 *
 * Mount-point choice (the plan's own tradeoff to weigh): this needs
 * `useProjection`/`sessionId` for the stats grid, and those are
 * session-scope-only standard props — `header.utilities` has them,
 * `shell.overlay` (S1's other option) does not. `shell.overlay` would have
 * gained nothing in exchange (GlobalStandardProps — `useSessions` for the
 * badges/subagent-count — is unconditional on every slot per
 * `PropsRuntime`, so this component gets it here for free too) while
 * running into a real problem: shell.overlay content renders inside the
 * `pI_x6G_overlayLayer`, a z-index:20 stacking context (AGENTS.md), and the
 * composer's own permission/model bottom sheets sit at z:60 — a
 * shell.overlay-hosted info sheet would render BEHIND an open composer
 * menu. Mounting inside the header's own DOM (outside that capped layer)
 * lets this sheet's z-index clear every other phone-shell float.
 */
export function MobileSessionInfo({
  sessionId,
  useSessions,
  useProjection,
  forkSession,
  openSession,
  renameSession,
  archiveSession,
  downloadSessionLog,
  t,
}: MobileSessionInfoProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onOpen = (): void => {
      setError(null)
      setOpen(true)
      // Stack a history entry on top of the session's: Android back now
      // closes this sheet first and only then leaves the session.
      pushLayer({ id: INFO_LAYER, close: () => setOpen(false) })
    }
    window.addEventListener(SESSION_INFO_EVENT, onOpen)
    return () => window.removeEventListener(SESSION_INFO_EVENT, onOpen)
  }, [])

  const tabs = useViewTabs()
  const row = useSessions((s) => s.byId[sessionId])
  const subagentCount = useSessions((s) => s.subagentsByParent[sessionId]?.entries.length ?? 0)
  const jobCount = useSessions((s) => s.jobsBySession[sessionId]?.length ?? 0)
  const stats = useProjection('sessionStats')
  const usage = useProjection('tokenUsage')

  if (!open) return null

  // Rewind rather than flip the flag — see the one-direction rule in
  // history-nav.ts. Falls back to a plain close if the layer is gone (the
  // sheet was opened before this wiring existed, or pushState is unavailable).
  const close = (): void => {
    if (hasLayer(INFO_LAYER)) popLayer(INFO_LAYER)
    else setOpen(false)
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onRename = (): void => {
    const next = window.prompt(t('infoRenamePrompt'), row?.displayTitle ?? '')
    if (next === null) return
    const title = next.trim()
    if (title === '') return
    void run(async () => {
      const result = await renameSession(sessionId, title)
      if (result === undefined) throw new Error(t('infoRename'))
      if (!result.ok) throw new Error(result.error.message)
    })
  }

  const onFork = (): void => {
    void run(async () => {
      const forkedId = await forkSession(sessionId)
      openSession(forkedId)
      close()
    })
  }

  const onArchive = (): void => {
    if (!window.confirm(t('infoArchiveConfirm'))) return
    void run(async () => {
      await archiveSession(sessionId)
      window.dispatchEvent(new CustomEvent(GO_HOME_EVENT))
      close()
    })
  }

  const onExport = (): void => {
    void downloadSessionLog(sessionId)
  }

  const cacheHit = usage === undefined ? null : cacheHitPercent(usage)
  const tokensEmpty = usage === undefined || (billedInputTokens(usage) === 0 && usage.outputTokens === 0)
  const cwd = row?.cwd === undefined || row.cwd === '' ? undefined : workspaceTitleOf(row.cwd)
  const preset = agentPresetOf(row)

  const cells: Array<{ label: string; value: string; sub: string | undefined }> = [
    { label: t('infoStatTurns'), value: stats === undefined ? NA : String(stats.turns), sub: undefined },
    { label: t('infoStatSteps'), value: stats === undefined ? NA : String(stats.steps), sub: undefined },
    {
      label: t('infoStatTtft'),
      value: stats === undefined || stats.ttftSteps === 0 ? NA : formatDuration(stats.ttftMs / stats.ttftSteps),
      sub: undefined,
    },
    {
      label: t('infoStatLlm'),
      value: stats === undefined || stats.llmMs === 0 ? NA : formatDuration(stats.llmMs),
      sub: undefined,
    },
    {
      label: t('infoStatTool'),
      value: stats === undefined || stats.toolMs === 0 ? NA : formatDuration(stats.toolMs),
      sub: undefined,
    },
    /* Cache hit is the headline, token flow the sub-line (2026-08-20): on a
       long session the ratio is the number worth glancing at — it moves, and
       it is what the bill turns on — while the absolute in→out figure is
       reference detail. One decimal, because "100%" and "99.6%" are very
       different answers and integer rounding hid that. */
    {
      label: t('infoStatCacheHit'),
      value: cacheHit === null ? NA : `${cacheHit.toFixed(1)}%`,
      sub: tokensEmpty || usage === undefined
        ? undefined
        : t('infoTokenFlow', {
          io: `${formatTokens(billedInputTokens(usage))}→${formatTokens(usage.outputTokens)}`,
        }),
    },
  ]

  return (
    <div data-mobile-nav="info-layer">
      <div
        data-mobile-nav="info-mask"
        role="button"
        tabIndex={-1}
        aria-label={t('infoClose')}
        onClick={close}
      />
      <div data-mobile-nav="info-sheet" role="dialog" aria-modal="true">
        <div data-mobile-nav="info-head">
          {tabs.length > 1 && (
            // Deliberately NOT role="tablist"/role="tab": readViewTabs()
            // (MobileSessionHeader.tsx) locates the OFFICIAL tablist with
            // `header [role="tablist"]`, and this control also renders
            // inside <header> (the header.utilities slot) — reusing that
            // role here made the query match this control instead of the
            // real one once the sheet was open, so a tap "switched" this
            // already-open segmented control rather than the official tabs
            // underneath (found via HTMLElement.prototype.click patching:
            // tab.el.click() was recursing into its own button). A plain
            // button group with aria-pressed avoids the collision entirely.
            <div data-mobile-nav="info-tabs" role="group" aria-label={t('switchView')}>
              {tabs.map((tab) => (
                <button
                  key={tab.label}
                  type="button"
                  aria-pressed={tab.active}
                  data-mobile-nav="info-tab"
                  data-selected={tab.active ? '' : undefined}
                  onClick={() => {
                    if (!tab.active) tab.el.click()
                    close()
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
          <button type="button" data-mobile-nav="info-close" aria-label={t('infoClose')} onClick={close}>
            <IconCloseOutline16 size={16} />
          </button>
        </div>

        <div data-mobile-nav="info-badges">
          {preset !== undefined && <span data-mobile-nav="info-badge">{preset}</span>}
          {subagentCount > 0 && (
            <span data-mobile-nav="info-badge">{t('infoSubagents', { count: subagentCount })}</span>
          )}
          {/* The header activity chip points here, so the count it shows has
              to be readable here too — otherwise tapping it explains nothing. */}
          {jobCount > 0 && (
            <span data-mobile-nav="info-badge">{t('infoJobs', { count: jobCount })}</span>
          )}
          <span data-mobile-nav="info-badge-cwd">{cwd ?? t('infoCwdFallback')}</span>
        </div>

        <div data-mobile-nav="info-stats">
          {cells.map((cell) => (
            <div key={cell.label} data-mobile-nav="info-stat">
              <span data-mobile-nav="info-stat-value">{cell.value}</span>
              <span data-mobile-nav="info-stat-label">{cell.label}</span>
              {cell.sub !== undefined && <span data-mobile-nav="info-stat-sub">{cell.sub}</span>}
            </div>
          ))}
        </div>

        {error !== null && <div data-mobile-nav="info-error">{t('infoActionError', { message: error })}</div>}

        <div data-mobile-nav="info-actions">
          <button type="button" data-mobile-nav="info-action" disabled={busy} onClick={onExport}>
            <IconDownloadOutline16 size={16} />
            <span>{t('infoExport')}</span>
          </button>
          <button type="button" data-mobile-nav="info-action" disabled={busy} onClick={onRename}>
            <IconEditOutline16 size={16} />
            <span>{t('infoRename')}</span>
          </button>
          <button type="button" data-mobile-nav="info-action" disabled={busy} onClick={onFork}>
            <IconBranchOutline16 size={16} />
            <span>{t('infoFork')}</span>
          </button>
          <button
            type="button"
            data-mobile-nav="info-action"
            data-mobile-nav-danger=""
            disabled={busy}
            onClick={onArchive}
          >
            <IconArchiveOutline20 size={20} />
            <span>{t('infoArchive')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
