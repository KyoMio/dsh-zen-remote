import { useEffect, useState } from 'react'
import {
  IconChecklistOutline14,
  IconCodeOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconEllipsisOutline16,
  IconPanelLeftOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MobileNavKey } from './locales.ts'
import { isChipEnabled, toggleChip, useChipsPrefs } from './chips-store.ts'

/** One icon component's minimal shared shape (every `@deepseek-ai/dsh-client-ui-primitives` icon accepts `size`, regardless of the fixed number in its own name — see e.g. IconDownloadOutline16 used at size 14 elsewhere in this codebase). */
type IconFC = (props: { size?: number }) => React.JSX.Element

/**
 * One home-screen chip's static registration (S5). `selector` is the
 * stable, non-hashed DOM anchor for the plugin's REAL entry button — the
 * chip never reimplements the target feature, it just "代点" (synthetic
 * `.click()`, bypasses hit-testing per the S2.1 precedent in AGENTS.md) the
 * button the plugin itself already renders elsewhere in the tree, exactly
 * like MobileSessionHeader's Chat/Trajectory tab click and the workbench
 * button's `[data-dsh-better-sidebar] button[class$="_toggleButton"]`.
 * `selector: null` marks the one chip (session log) whose availability and
 * action come from injected props instead of a DOM probe — it is a
 * first-party dsh-session-log-export service call, not a third-party
 * plugin's button.
 */
export interface ChipDef {
  id: string
  label: MobileNavKey
  Icon: IconFC
  selector: string | null
}

/**
 * Task board / SSH entry buttons: not verified live in this environment (the
 * "web" profile currently installs neither plugin — checked
 * `~/.dsh/profiles/web/pnpm-lock.yaml`), but the exact selectors already
 * appear in MobileNavOverlay.tsx's drawer-close-on-navigate matcher
 * (`button[data-dsh-taskboard-entry]` / `button[data-dsh-ssh-entry]`), which
 * an earlier slice already confirmed live against those plugins. Reused
 * verbatim rather than re-derived. Both entries render inside the sidebar
 * tree (same as the settings trigger below) but need no portal fix of their
 * own: MobileNavOverlay's own comment classes them as "navigation" — they
 * take over the MAIN content area rather than opening a dialog nested in
 * the sidebar, so a plain `.click()` is enough once the sidebar's
 * display:none stops mattering (only the SOURCE button needs to exist in
 * the DOM for the synthetic click to dispatch, not be painted).
 */
const TASKBOARD_SELECTOR = 'button[data-dsh-taskboard-entry]'
const SSH_SELECTOR = 'button[data-dsh-ssh-entry]'

/**
 * Better-sidebar's own workbench toggle — the exact selector
 * MobileSessionHeader.tsx's header workbench button already clicks. Its
 * panel is better-sidebar's own top-level mount (`[data-dsh-better-sidebar]`),
 * not nested in our sidebar tree, so it needs no portal fix either.
 */
const FILES_SELECTOR = '[data-dsh-better-sidebar] button[class$="_toggleButton"]'

/**
 * dsh-usage-stats' sidebar-footer badge (`sidebar.footer.action`, order 10 —
 * AGENTS.md). Read straight from the installed plugin's own
 * `~/.dsh/profiles/web/node_modules/dsh-usage-stats/lib/client.js`:
 * `data-usage-stats-badge` on the trigger button, `data-usage-stats-panel`
 * on its `position: fixed` result panel (no backdrop/mask, unlike settings).
 * Both live inside the sidebar's `footerActions` row — display:none on the
 * phone breakpoint's sidebar root (home.css.ts) hides them exactly like the
 * settings dialog, so the badge's panel needs the SAME portal fix
 * (styles/chips.css.ts, gated on `:has([data-usage-stats-panel])` alongside
 * the settings gate on `:has([aria-modal="true"])`).
 */
const USAGE_SELECTOR = 'button[data-usage-stats-badge]'

/** Static chip registry (S5). Order here is the default row order. */
export const CHIP_DEFS: readonly ChipDef[] = [
  { id: 'taskboard', label: 'chipTaskboard', Icon: IconChecklistOutline14, selector: TASKBOARD_SELECTOR },
  { id: 'ssh', label: 'chipSsh', Icon: IconCodeOutline16, selector: SSH_SELECTOR },
  { id: 'files', label: 'files', Icon: IconPanelLeftOutline16, selector: FILES_SELECTOR },
  { id: 'usage', label: 'chipUsage', Icon: IconDataOutline16, selector: USAGE_SELECTOR },
  { id: 'sessionLog', label: 'sessionLog', Icon: IconDownloadOutline16, selector: null },
]

/**
 * Live presence of each selector-backed chip's target button, refreshed on
 * every DOM mutation (plugins mount their sidebar-footer entries
 * asynchronously, same as the FAB-visibility / aionui-compat effects
 * elsewhere in this plugin). Not gated by `mobile`/viewport — cheap, and
 * MobileHome itself already returns null above 768px, so this hook's
 * subscription lives only as long as the phone home screen does.
 */
function useDetectedIds(): ReadonlySet<string> {
  const [detected, setDetected] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    const sync = (): void => {
      const next = new Set<string>()
      for (const def of CHIP_DEFS) {
        if (def.selector !== null && document.querySelector(def.selector) !== null) next.add(def.id)
      }
      setDetected(next)
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return detected
}

/** Session-log's own availability/action, and everyone else's `.click()` target. */
function activate(def: ChipDef, sessionId: string | undefined, downloadSessionLog: (id: string) => void): void {
  if (def.id === 'sessionLog') {
    if (sessionId !== undefined) downloadSessionLog(sessionId)
    return
  }
  if (def.selector !== null) document.querySelector<HTMLButtonElement>(def.selector)?.click()
}

/** Full props for the chip row. */
export interface MobileHomeChipsProps {
  t: Translate<MobileNavKey>
  sessionId: string | undefined
  downloadSessionLog: (id: string) => void
  onCustomize: () => void
}

/**
 * Plugin-entry chips row (S5): a horizontally-scrolling line of 34px pills
 * between the workspace title and the session list, plus a trailing "···"
 * that opens the customize sheet (MobileHomeChipsSheetBody below, rendered
 * by MobileHome inside its existing home-sheet chrome). Every chip renders
 * only when both true: the user has not hidden it (useChipsPrefs) AND its
 * target actually exists right now (useDetectedIds / sessionId) — an
 * uninstalled plugin's chip never appears, matching the plan's "按用户实装
 * 插件逐个接入口".
 */
export function MobileHomeChips({ t, sessionId, downloadSessionLog, onCustomize }: MobileHomeChipsProps) {
  const detected = useDetectedIds()
  const prefs = useChipsPrefs()
  const visible = CHIP_DEFS.filter((def) => {
    if (!isChipEnabled(prefs, def.id)) return false
    return def.id === 'sessionLog' ? sessionId !== undefined : detected.has(def.id)
  })
  return (
    <div data-mobile-nav="chip-row">
      {visible.map((def) => (
        <button
          key={def.id}
          type="button"
          data-mobile-nav="chip"
          onClick={() => activate(def, sessionId, downloadSessionLog)}
        >
          <def.Icon size={16} />
          <span>{t(def.label)}</span>
        </button>
      ))}
      <button
        type="button"
        data-mobile-nav="chip-more"
        aria-label={t('chipCustomize')}
        title={t('chipCustomize')}
        onClick={onCustomize}
      >
        <IconEllipsisOutline16 size={16} />
      </button>
    </div>
  )
}

/**
 * Customize-sheet body (S5, existence filter added 2026-08-17 real-device
 * follow-up): one toggle row per chip whose target actually exists —
 * `useDetectedIds()`, the SAME live probe `MobileHomeChips` uses for the row
 * itself. Originally listed every `CHIP_DEFS` entry unconditionally, on the
 * theory that a not-yet-installed plugin's toggle should still be
 * pre-settable; real-device feedback was that this instead surfaces dead
 * switches for plugins the user never installed (taskboard/ssh). Detection
 * is a live MutationObserver subscription, so installing the plugin later
 * still makes its toggle appear with no reload needed — "将来装了自动出现"
 * survives the change, it just also stops showing before that. `sessionLog`
 * (selector: null) is exempt: its existence is a runtime session-scope
 * question, not a plugin-install question, so it always lists regardless of
 * whether a session happens to be open right now. Stale prefs entries for a
 * chip that no longer renders (e.g. an uninstalled plugin's old toggle
 * value) are simply never read — `isChipEnabled`/`toggleChip`
 * (chips-store.ts) key off `CHIP_DEFS` ids already, so leftover keys in the
 * persisted object are inert, not an error. Rendered by MobileHome inside
 * the SAME home-sheet-layer/mask/sheet chrome the workspace switcher uses
 * (S6's drag-to-close and mask-click-close already bind generically to
 * `[data-mobile-nav="home-sheet"]`, so this second use needs no new gesture
 * wiring — see styles/chips.css.ts).
 */
export function MobileHomeChipsSheetBody({ t }: { t: Translate<MobileNavKey> }) {
  const prefs = useChipsPrefs()
  const detected = useDetectedIds()
  const listed = CHIP_DEFS.filter((def) => def.selector === null || detected.has(def.id))
  return (
    <>
      <div data-mobile-nav="home-sheet-title">{t('chipCustomize')}</div>
      {listed.map((def) => {
        const enabled = isChipEnabled(prefs, def.id)
        return (
          <div key={def.id} data-mobile-nav="chip-toggle-row">
            <def.Icon size={16} />
            <span data-mobile-nav="chip-toggle-label">{t(def.label)}</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={t(def.label)}
              data-mobile-nav="chip-toggle"
              onClick={() => toggleChip(def.id)}
            />
          </div>
        )
      })}
    </>
  )
}
