import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconDownloadOutlineRegular, IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { mainSessionIdOf } from './compat/types.ts'
import { NS } from './locales.ts'

/** Full props for the sidebar footer action entry. */
export interface MobileDrawerFooterProps extends PropsRuntime<'sidebar.footer.action'>, PropsLocale<typeof NS> {
  /** Bound ctx.sessionLogDownload.download() for the current session. */
  downloadSessionLog: (sessionId: string) => void
  /** Bound ctx.layout.toggleSidebar(): the Files sheet closes the drawer. */
  toggleSidebar: () => void
}

/**
 * Mobile-only drawer footer actions, relocated from the session header to the
 * drawer footer (beside Settings):
 * - Files: opens the dsh-web-ui aionui explorer as a floating bottom sheet
 *   (the explorer column is hidden on mobile until this marker is set, so
 *   the suite's own persisted-expanded state can never cover the UI on load).
 * - Session log: the official session-log-export controller, so the
 *   progress/result dialog is shared with the desktop flow.
 * Hidden entirely on wide screens (CSS media query).
 */
export function MobileDrawerFooter({ useSessions, downloadSessionLog, toggleSidebar, t }: MobileDrawerFooterProps) {
  // 0.1.7: SessionListState.current is gone — derive the main-view session
  // from the catalog rows instead (official uiSession.publishMain's pick).
  const sessionId = useSessions((state) => mainSessionIdOf(state.byId))
  const openExplorer = (): void => {
    document.querySelector('[data-mobile-nav="frame"]')?.setAttribute('data-aionui-explorer-open', '')
    toggleSidebar()
  }
  return (
    <div data-mobile-nav="drawer-actions">
      <button
        type="button"
        data-mobile-nav="explorer"
        aria-label={t('files')}
        title={t('files')}
        onClick={openExplorer}
      >
        <IconPanelLeftOutlineRegular size={14} />
        <span>{t('files')}</span>
      </button>
      <button
        type="button"
        data-mobile-nav="session-log"
        aria-label={t('sessionLog')}
        title={t('sessionLog')}
        disabled={sessionId === undefined}
        onClick={() => {
          if (sessionId !== undefined) downloadSessionLog(sessionId)
        }}
      >
        <IconDownloadOutlineRegular size={14} />
        <span>{t('sessionLog')}</span>
      </button>
    </div>
  )
}
