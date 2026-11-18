import type { ClientContext } from '../compat/types.ts'
import { copyTextToClipboard } from '../clipboard.ts'
import { probeClientConfigRole } from '../remote-share-register.ts'
import {
  CLIENT_PEER_STATUS_ROUTE,
  derivePeerStatusView,
  shouldShowLegacyGatewayModal,
  type PeerStatusView,
} from '../../client-data/settings-form.ts'
import { en, zh } from '../locales.ts'

const UPGRADE_COMMAND = 'docker compose pull && docker compose up -d'
const CONNECTING_RETRY_DELAYS_MS = [1500, 3000, 6000] as const

const MODAL_CSS = `
dialog[data-zen-remote="legacy-gateway-modal"] {
  max-width: min(460px, calc(100vw - 32px));
  padding: 20px 22px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsw-alias-label-primary, #111827);
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.24);
  font-family: inherit;
}
dialog[data-zen-remote="legacy-gateway-modal"]::backdrop {
  background: rgba(0, 0, 0, 0.45);
}
dialog[data-zen-remote="legacy-gateway-modal"] h3 {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
}
dialog[data-zen-remote="legacy-gateway-modal"] p {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #4b5563);
}
dialog[data-zen-remote="legacy-gateway-modal"] .zr-lgw-cmd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
dialog[data-zen-remote="legacy-gateway-modal"] code {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
  background: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, 0.08));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  white-space: nowrap;
}
dialog[data-zen-remote="legacy-gateway-modal"] .zr-lgw-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
dialog[data-zen-remote="legacy-gateway-modal"] button,
dialog[data-zen-remote="legacy-gateway-modal"] a.zr-lgw-link {
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-decoration: none;
}
dialog[data-zen-remote="legacy-gateway-modal"] button.zr-lgw-primary {
  background: var(--dsw-alias-label-primary, #111827);
  color: var(--dsw-alias-bg-layer-2, #ffffff);
  border-color: transparent;
}
`

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface DialogElementLike extends HTMLElement {
  open?: boolean
  showModal?: () => void
  close?: () => void
}

export interface LegacyGatewayPromptOptions {
  probeRole?: () => Promise<'host' | 'client' | 'peer' | undefined>
  fetchImpl?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
  doc?: Pick<Document, 'head' | 'body' | 'createElement'>
  sessionStore?: StorageLike | null
  localStore?: StorageLike | null
  isViaGateway?: () => boolean
  retryDelaysMs?: readonly number[]
}

function legacyDismissStorageKeys(consoleUrl: string | null): { sessionKey: string; permanentKey: string } {
  const scope = consoleUrl ?? 'global'
  return {
    sessionKey: `zr:legacy-gw-modal:session:${scope}`,
    permanentKey: `zr:legacy-gw-modal:never:${scope}`,
  }
}

function readStorageFlag(store: StorageLike | null | undefined, key: string): boolean {
  try {
    return store?.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeStorageFlag(store: StorageLike | null | undefined, key: string): void {
  try {
    store?.setItem(key, '1')
  } catch {
    /* ignore storage quota / private mode */
  }
}

function pickDict(): Record<string, string> {
  try {
    const lang = (document.documentElement?.lang || navigator.language || '').toLowerCase()
    return lang.startsWith('zh') ? zh : en
  } catch {
    return en
  }
}

/**
 * Mounts a one-time upgrade guidance modal when `role === 'peer'` connects to a
 * legacy `0.1.0` gateway that lacks hot-update support. Silent on `host`,
 * `client`, `via-gateway`, and `>= 0.2.0` gateways.
 * Must be registered before the `isDesktopShell()` gate in `src/client/index.tsx`.
 */
export function mountLegacyGatewayUpgradePrompt(
  ctx: ClientContext,
  options: LegacyGatewayPromptOptions = {},
): void {
  const probeRole = options.probeRole ?? probeClientConfigRole
  const retryDelays = options.retryDelaysMs ?? CONNECTING_RETRY_DELAYS_MS

  ctx.effect(() => {
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let mountedStyle: Element | undefined
    let mountedDialog: DialogElementLike | undefined

    const unmountNodes = (): void => {
      if (mountedDialog !== undefined) {
        try {
          mountedDialog.remove()
        } catch {
          /* ignore */
        }
        mountedDialog = undefined
      }
      if (mountedStyle !== undefined) {
        try {
          mountedStyle.remove()
        } catch {
          /* ignore */
        }
        mountedStyle = undefined
      }
    }

    const doc = options.doc ?? (typeof document !== 'undefined' ? document : undefined)
    const sessionStore =
      options.sessionStore !== undefined
        ? options.sessionStore
        : typeof sessionStorage !== 'undefined'
          ? sessionStorage
          : null
    const localStore =
      options.localStore !== undefined
        ? options.localStore
        : typeof localStorage !== 'undefined'
          ? localStorage
          : null
    const fetchImpl: ((url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>) | undefined =
      options.fetchImpl ??
      (typeof fetch === 'function' ? (url, init) => fetch(url, init) : undefined)

    const isViaGateway = (): boolean => {
      if (options.isViaGateway !== undefined) return options.isViaGateway()
      return typeof document !== 'undefined' && document.documentElement?.hasAttribute?.('data-lan-device') === true
    }

    if (doc === undefined || fetchImpl === undefined || isViaGateway()) {
      return () => {
        disposed = true
      }
    }

    const showModalForView = (view: PeerStatusView): void => {
      if (disposed || mountedDialog !== undefined) return
      const consoleUrl = view.versionSync?.gatewayConsoleUrl ?? null
      const { sessionKey, permanentKey } = legacyDismissStorageKeys(consoleUrl)
      if (
        !shouldShowLegacyGatewayModal(view, {
          sessionDismissed: readStorageFlag(sessionStore, sessionKey),
          permanentDismissed: readStorageFlag(localStore, permanentKey),
        })
      ) {
        return
      }

      const dict = pickDict()
      const styleEl = doc.createElement('style')
      styleEl.dataset.zenRemote = 'legacy-gateway-modal-style'
      styleEl.textContent = MODAL_CSS
      doc.head.appendChild(styleEl)
      mountedStyle = styleEl

      const dialog = doc.createElement('dialog') as unknown as DialogElementLike
      dialog.dataset.zenRemote = 'legacy-gateway-modal'

      const title = doc.createElement('h3')
      title.textContent = dict['legacyGatewayModal.title'] ?? ''
      const body = doc.createElement('p')
      body.textContent = dict['legacyGatewayModal.body'] ?? ''
      const cmdLabel = doc.createElement('p')
      cmdLabel.textContent = dict['legacyGatewayModal.commandLabel'] ?? ''

      const cmdRow = doc.createElement('div')
      cmdRow.className = 'zr-lgw-cmd-row'
      const code = doc.createElement('code')
      code.textContent = UPGRADE_COMMAND
      const copyBtn = doc.createElement('button')
      copyBtn.type = 'button'
      copyBtn.className = 'zr-lgw-primary'
      copyBtn.textContent = dict['legacyGatewayModal.copy'] ?? 'Copy'
      copyBtn.addEventListener('click', () => {
        void copyTextToClipboard(UPGRADE_COMMAND).then((ok) => {
          if (ok) copyBtn.textContent = dict['legacyGatewayModal.copied'] ?? 'Copied'
        })
      })
      cmdRow.appendChild?.(code)
      cmdRow.appendChild?.(copyBtn)

      const actions = doc.createElement('div')
      actions.className = 'zr-lgw-actions'

      const finish = (store: StorageLike | null, key: string): void => {
        writeStorageFlag(store, key)
        unmountNodes()
      }

      if (consoleUrl !== null) {
        const link = doc.createElement('a') as HTMLAnchorElement
        link.className = 'zr-lgw-link'
        link.href = consoleUrl
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.textContent = dict['legacyGatewayModal.openConsole'] ?? 'Open console'
        actions.appendChild?.(link)
      }

      const remindBtn = doc.createElement('button')
      remindBtn.type = 'button'
      remindBtn.textContent = dict['legacyGatewayModal.remindLater'] ?? 'Later'
      remindBtn.addEventListener('click', () => finish(sessionStore, sessionKey))

      const neverBtn = doc.createElement('button')
      neverBtn.type = 'button'
      neverBtn.textContent = dict['legacyGatewayModal.neverShow'] ?? 'Never'
      neverBtn.addEventListener('click', () => finish(localStore, permanentKey))

      actions.appendChild?.(remindBtn)
      actions.appendChild?.(neverBtn)

      dialog.appendChild?.(title)
      dialog.appendChild?.(body)
      dialog.appendChild?.(cmdLabel)
      dialog.appendChild?.(cmdRow)
      dialog.appendChild?.(actions)

      dialog.addEventListener('cancel', (ev) => {
        ev.preventDefault?.()
        finish(sessionStore, sessionKey)
      })
      dialog.addEventListener('close', () => {
        unmountNodes()
      })

      doc.body.appendChild(dialog)
      mountedDialog = dialog
      if (typeof dialog.showModal === 'function') {
        dialog.showModal()
      } else {
        dialog.setAttribute('open', 'true')
      }
    }

    const pollOnce = async (retryIndex: number): Promise<void> => {
      if (disposed || isViaGateway()) return
      try {
        const res = await fetchImpl(CLIENT_PEER_STATUS_ROUTE)
        if (disposed || res.status === 403 || !res.ok) return
        const body = await res.json()
        if (disposed) return
        const view = derivePeerStatusView(body)
        if (view.gatewayState === 'connecting' && retryIndex < retryDelays.length) {
          const delay = retryDelays[retryIndex] ?? 3000
          retryTimer = setTimeout(() => {
            void pollOnce(retryIndex + 1)
          }, delay)
          return
        }
        showModalForView(view)
      } catch {
        /* non-blocking: ignore transient status probe failures */
      }
    }

    void probeRole().then((role) => {
      if (disposed || role !== 'peer' || isViaGateway()) return
      void pollOnce(0)
    })

    return () => {
      disposed = true
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
      unmountNodes()
    }
  }, 'dsh-zen-remote: legacy gateway prompt')
}
