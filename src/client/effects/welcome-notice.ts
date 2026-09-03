import type { ClientContext } from '../compat/types.ts'

/** Per-browser opt-out flag; localStorage because remote (non-loopback)
    connections never persist the acknowledgement host-side. */
const OPTOUT_KEY = 'dsh-zen-remote:welcome-notice-optout'

/** Localized aria-labels of the DSH first-run notice dialog
    (@deepseek-ai/dsh-client-ui-settings-models WELCOME_NOTICE_COPY). */
const NOTICE_LABELS = ['内测声明', 'Internal Testing Notice']

/**
 * "内测声明" first-run notice, opt-out half (ALL widths — same user-directed
 * exception as the _previewBadge rule in styles/base.css.ts).
 *
 * Why not CSS: the notice dialog keeps document #root inert while MOUNTED and
 * only restores it on unmount (its acknowledge button). display:none hid the
 * dialog without unmounting it, which left the whole app permanently
 * unclickable on remote connections (2026-08-18 incident) — remote browsers
 * re-mount the notice on every page load because their acknowledgement is
 * memory-only (`connection.isLoopback ? "host" : "memory"` upstream).
 *
 * So the dialog now shows normally, plus one injected "不再弹出" button. The
 * user chooses: acknowledging via that button records the opt-out in this
 * browser's localStorage, and later mounts are auto-acknowledged by clicking
 * the dialog's own continue button — the component unmounts through its
 * normal path and #root's inert is properly restored.
 */
export function installWelcomeNoticeOptOut(ctx: ClientContext): void {
  ctx.effect(() => {
    const handle = (dialog: HTMLElement): void => {
      // The notice's action row holds exactly one button ("继续"/"Continue").
      const continueBtn = dialog.querySelector('button')
      if (continueBtn === null) return
      if (localStorage.getItem(OPTOUT_KEY) !== null) {
        continueBtn.click()
        return
      }
      const row = continueBtn.parentElement
      if (row === null || row.querySelector('.zen-welcome-optout') !== null) return
      const optOut = document.createElement('button')
      optOut.type = 'button'
      optOut.className = 'zen-welcome-optout'
      optOut.textContent =
        dialog.getAttribute('aria-label') === '内测声明' ? '不再弹出' : "Don't show again"
      optOut.addEventListener('click', () => {
        localStorage.setItem(OPTOUT_KEY, '1')
        continueBtn.click()
      })
      row.insertBefore(optOut, continueBtn)
    }
    const scan = (): void => {
      for (const label of NOTICE_LABELS) {
        const dialog = document.querySelector<HTMLElement>(
          `[role="dialog"][aria-label="${label}"]`,
        )
        if (dialog !== null) handle(dialog)
      }
    }
    // The dialog portals straight under <body>, so childList on body is
    // enough; scan() once first in case it mounted before this plugin loaded.
    scan()
    const observer = new MutationObserver(scan)
    observer.observe(document.body, { childList: true })
    return () => observer.disconnect()
  }, 'dsh-mobile-nav: welcome-notice opt-out')
}
