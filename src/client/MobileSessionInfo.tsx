import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconArchiveOutline20,
  IconBranchOutline16,
  IconCloseOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconShareOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceTitleOf } from './compat/store.ts'
import { agentPresetOf } from './compat/types.ts'
import type { RenameResult, SessionId } from './compat/types.ts'
import { NS } from './locales.ts'
import { GO_HOME_EVENT, SESSION_INFO_EVENT } from './nav-store.ts'
import { hasLayer, popLayer, pushLayer } from './history-nav.ts'
import { fetchShareExport, ShareFetchError } from './share/fetch-share.ts'
import type { ShareExportData, ShareRange } from './share/fetch-share.ts'
import { deliverShareImage, deliverShareImages } from './share/share-flow.ts'
import { stitchSliceBlobs, supportsPngStitch } from './share/png-stitch.ts'
import { rasterizeShareCard, ShareRasterizeError } from './share/rasterize.ts'
import { ShareCard } from './share/share-card.tsx'
import type { ShareCardCopy } from './share/share-card.tsx'
import { ShareRangeSheet } from './share/share-sheet.tsx'
import type { SharePreset } from './share/share-sheet.tsx'

/** Layer id for the info sheet, so Android back closes it before leaving the session. */
const INFO_LAYER = 'session-info'
/**
 * Layer id for the share-range sheet. Pushed ON TOP of the info layer's own
 * entry, so one back gesture closes exactly the picker — never both layers
 * at once (the one-direction rule in history-nav.ts).
 */
const SHARE_LAYER = 'session-info-share'
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
  // Degraded-outcome notice (review 07+08): the multi-file delivery SUCCEEDED,
  // so "操作失败：…" would lie — this row says what the user actually got,
  // without the error template. Rendered in its own row (below), never through
  // setError.
  const [notice, setNotice] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareData, setShareData] = useState<ShareExportData | null>(null)
  const shareCardHostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onOpen = (): void => {
      setError(null)
      setNotice(null)
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

  /* ---- share-image flow (ticket 05) --------------------------------------
   * The range sheet renders INSIDE this info layer's DOM — a DIRECT child of
   * the layer, a sibling of the info card, never inside the card itself (a
   * card-internal mount clipped the mask to the card's box, anchored the
   * sheet's bottom to the card's scrollable area, and let outside taps fall
   * through to the info mask, closing both layers at once and stranding
   * SHARE_LAYER as a dead history entry; review 2026-09-10): info.css.ts's
   * ≥768px display:none covers it (this feature adds no page CSS), and the
   * info layer's own z:70 header promotion carries it. Its history entry
   * sits above INFO_LAYER's, so back closes the picker alone. These helpers
   * live before the `if (!open) return null` below because the pipeline
   * effect may still be settling when the sheet unmounts. */

  // Rewind rather than flip the flag — same one-direction rule as `close`.
  const closeShare = (): void => {
    if (hasLayer(SHARE_LAYER)) popLayer(SHARE_LAYER)
    else setShareOpen(false)
  }

  // Errors land on the info sheet's existing error row (ticket 05); the
  // share sheet closes first so the row is not hidden behind its mask.
  const shareErrorMessage = (err: unknown): string => {
    if (err instanceof ShareFetchError) {
      switch (err.code) {
        case 'route-missing': return t('shareErrRouteMissing')
        case 'session-not-found': return t('shareErrSessionNotFound')
        case 'bad-request': return t('shareErrBadRequest')
        case 'network': return t('shareErrNetwork')
        case 'server': return t('shareErrServer')
        case 'bad-body': return t('shareErrBody')
      }
    }
    if (err instanceof ShareRasterizeError) {
      if (err.code === 'probe-failed') return t('shareErrProbe')
      if (err.code === 'slice-over-budget') return t('shareErrSliceBudget')
      return t('shareErrRender')
    }
    return err instanceof Error ? err.message : String(err)
  }

  const shareFailed = (err: unknown): void => {
    setBusy(false)
    setShareData(null)
    closeShare()
    setError(shareErrorMessage(err))
  }

  // Pipeline stage two. Stage one (onShareConfirm below) fetches and commits
  // the data, which renders the hidden ShareCard; this effect then runs
  // AFTER that commit, when the card element exists. The state → render →
  // effect gap is the React-idiomatic bridge over "DOM ready" without
  // react-dom (not in the client externals whitelist). Ticket 07: when the
  // browser can stitch (CompressionStream), the slices are planned with the
  // unified global width/ratio and concatenated into ONE PNG before delivery;
  // a runtime stitch failure falls back to the legacy per-slice multi-file
  // delivery, and either degraded form lands on the notice row below (never
  // the error row — the delivery itself succeeded, review 07+08).
  useEffect(() => {
    if (shareData === null) return
    const card = shareCardHostRef.current?.querySelector<HTMLElement>('[data-share-card]') ?? null
    if (card === null) {
      shareFailed(new Error(t('shareErrRender')))
      return
    }
    const stitch = supportsPngStitch()
    rasterizeShareCard(card, {
      pixelRatioCap: Math.min(window.devicePixelRatio || 1, 2),
      truncatedNote: (droppedTurns) => t('shareTruncatedNote', { count: droppedTurns }),
      unified: stitch,
    })
      .then(async (result): Promise<string | null> => {
        const title = row?.displayTitle ?? ''
        if (stitch && result.stitchWidth !== undefined) {
          try {
            const png = await stitchSliceBlobs(result.slices, result.stitchWidth)
            await deliverShareImage(png, title)
            return null
          } catch (err) {
            // Runtime stitch failure (a slice decoded at the wrong size, a
            // compressor error, …) — the rasterized slices are finished PNGs
            // either way, so deliver them multi-file instead of failing the
            // whole export. The original error stays on the console for
            // diagnosis; the notice row tells the user what they got (no
            // "操作失败" prefix — the delivery succeeded, review 07+08).
            console.error('[dsh-zen-remote] share-image: stitch failed — delivering the painted slices as multiple images instead', err)
            await deliverShareImages(result.slices, title)
            return t('shareStitchFailed')
          }
        }
        await deliverShareImages(result.slices, title)
        return t('shareStitchUnsupported')
      })
      .then((degraded) => {
        setBusy(false)
        setShareData(null)
        closeShare()
        setNotice(degraded)
      })
      .catch(shareFailed)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shareData is the trigger; helpers only touch setters and module functions.
  }, [shareData])

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

  const onShare = (): void => {
    setError(null)
    setNotice(null)
    setShareData(null)
    setShareOpen(true)
    pushLayer({ id: SHARE_LAYER, close: () => setShareOpen(false) })
  }

  // Pipeline stage one: fetch the selected range. Stage two (rasterize +
  // deliver) lives in the shareData effect above — the hidden card must be
  // committed to the DOM before the rasterizer can clone it.
  const onShareConfirm = (choice: SharePreset): void => {
    const range: ShareRange = choice === 'all' ? { kind: 'all' } : { kind: 'last', turns: choice }
    setBusy(true)
    setError(null)
    // Session id straight off the useSessions row (its branded
    // session-<uuid> form — a bare uuid 404s, PLAN §2), slot prop as backup.
    fetchShareExport(row?.id ?? sessionId, range)
      .then((data) => {
        if (data.turns.length === 0) throw new Error(t('shareErrEmpty'))
        setShareData(data)
      })
      .catch(shareFailed)
  }

  const cacheHit = usage === undefined ? null : cacheHitPercent(usage)
  const tokensEmpty = usage === undefined || (billedInputTokens(usage) === 0 && usage.outputTokens === 0)
  const cwd = row?.cwd === undefined || row.cwd === '' ? undefined : workspaceTitleOf(row.cwd)
  const preset = agentPresetOf(row)
  // Known-empty sessions (stats observed, zero turns) disable the share
  // button outright; unknown-stats sessions stay enabled and let the fetch's
  // empty-turns guard speak. Known 口径 gap, accepted for v1: the projection
  // counts a turn only once one of its steps has CLOSED (the fold increments
  // on step/end — dsh-session-stats projection.js), so a session whose only
  // content is a still-streaming turn, or user messages with no assistant
  // step yet, also reads turns === 0 and is over-disabled here. Wrong
  // direction but fail-safe: the button is merely greyed (no misleading
  // error), and every session that passes through still meets the fetch-side
  // empty-turns guard (shareErrEmpty below), which is exact.
  const shareEmpty = stats !== undefined && stats.turns === 0
  const shareCardCopy: ShareCardCopy = {
    turnsLabel: (count: number) => t('shareCardTurns', { count }),
    generatedBy: t('shareCardGeneratedBy'),
    image: t('shareCardImage'),
  }

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
        {/* Degraded-outcome notice (review 07+08): same container metrics as
            the error row, but informational colors and no prefix template —
            the export itself succeeded, only the single-long-image form did
            not. Inline-styled (this feature adds no page CSS); role="status"
            so assistive tech announces it as a polite status, not an alert. */}
        {notice !== null && (
          <div
            data-mobile-nav="info-notice"
            role="status"
            style={{
              marginBottom: 8,
              padding: '8px 10px',
              borderRadius: 10,
              background: 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06))',
              color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, .6))',
              fontSize: 12,
              lineHeight: 1.4,
            }}
          >
            {notice}
          </div>
        )}

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
          <button
            type="button"
            data-mobile-nav="info-action"
            disabled={busy || shareEmpty}
            onClick={onShare}
          >
            <IconShareOutline16 size={16} />
            <span>{t('shareAction')}</span>
          </button>
        </div>

        {/* Offscreen render host for the share card (ticket 05). The
            rasterizer clones this tree into its own shadow-root sandbox, so
            the card never has to be visible — only attached. position:fixed
            offscreen keeps it laid out but unpainted, and the info layer's
            ≥768px display:none keeps the desktop clean. */}
        {shareData !== null && (
          <div
            ref={shareCardHostRef}
            aria-hidden="true"
            style={{ position: 'fixed', left: '-9999px', top: 0, pointerEvents: 'none' }}
          >
            <ShareCard
              title={row?.displayTitle ?? t('sessionInfo')}
              {...(preset !== undefined ? { subtitle: preset } : {})}
              {...(shareData.createdAt !== undefined ? { createdAt: shareData.createdAt } : {})}
              turns={shareData.turns}
              copy={shareCardCopy}
            />
          </div>
        )}
      </div>

      {/* Share-range picker (ticket 05): a DIRECT child of the info layer —
          sibling of the card, never inside it. With the fixed layer as the
          containing block, the picker's own absolute inset:0 overlay is a
          fullscreen mask that sits above the info mask and the card: a tap
          outside the card reaches IT (popLayer(SHARE_LAYER)) and closes only
          the picker, never both layers at once; the sheet bottom anchors to
          the viewport's safe area (not the card's box, no double count) and
          stays put when the card scrolls. Its own history entry means a back
          gesture, likewise, closes it alone. */}
      {shareOpen && (
        <ShareRangeSheet busy={busy} onConfirm={onShareConfirm} onClose={closeShare} t={t} />
      )}
    </div>
  )
}
