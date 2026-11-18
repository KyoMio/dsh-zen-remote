import type { ClientContext, MobileSessionRow } from '../compat/types.ts'
import { mainSessionIdOf } from '../compat/types.ts'
import { CLIENT_CONFIG_CHANGED_EVENT, clientConfig } from '../client-config.ts'
import { probeClientConfigRole } from '../remote-share-register.ts'
import {
  REMOTE_HIDDEN_WORKSPACE_ATTR,
  hiddenRemoteWorkspaceIds,
  type RemoteSessionVisibilityInfo,
  type RemoteWorkspaceEntry,
} from '../../client-data/remote-workspace-visibility.ts'

const WORKSPACE_ROW_SELECTOR = '[role="tree"] [role="treeitem"][data-row-key^="workspace:zr~"]'
const ROW_KEY_PREFIX = 'workspace:'

interface WorkspaceSnapshotLike {
  readonly items: readonly RemoteWorkspaceEntry[]
  readonly archivedSessionIds: readonly string[]
}

interface WorkspaceServiceLike {
  readonly list?: {
    getSnapshot(): WorkspaceSnapshotLike
    subscribe(listener: () => void): () => void
  }
}

interface SessionsSnapshotLike {
  readonly byId: Readonly<Record<string, MobileSessionRow & RemoteSessionVisibilityInfo>>
}

interface SessionsServiceLike {
  readonly list: {
    getSnapshot(): SessionsSnapshotLike
    subscribe(listener: () => void): () => void
  }
}

function currentMainSessionIdOf(ctx: ClientContext): string | undefined {
  const sessions = ctx.get('sessions') as SessionsServiceLike | undefined
  if (sessions === undefined) return undefined
  const { byId } = sessions.list.getSnapshot()
  const uiSession = ctx.get('uiSession') as { current?: { value?: { key?: unknown } } } | undefined
  const current = uiSession?.current?.value?.key
  return typeof current === 'string' && (byId[current]?.retainedBy?.mainView ?? 0) > 0
    ? current
    : mainSessionIdOf(byId)
}

/** Walk up from one workspace row to its `groupSection` container directly under `[role="tree"]` or `[role="group"]`. */
function groupSectionOf(row: Element): Element | null {
  let node: Element | null = row.parentElement
  while (node !== null) {
    const parentRole = node.parentElement?.getAttribute('role')
    if (parentRole === 'tree' || parentRole === 'group') return node
    node = node.parentElement
  }
  return null
}

/** True when DSH currently renders direct session rows inside this group (e.g. "Show archived" mode). */
function groupHasRenderedSessions(row: Element): boolean {
  const section = groupSectionOf(row)
  const container = section?.parentElement ?? null
  if (section === null || container === null) return false
  for (const sessionEl of section.querySelectorAll('[data-row-key^="session:"]')) {
    if (sessionEl.closest('[role="group"], [role="tree"]') === container) return true
  }
  return false
}

export interface RemoteWorkspaceVisibilityOptions {
  /** Override role probe (tests). */
  probeRole?: () => Promise<'host' | 'client' | 'peer' | undefined>
  /** Override client config reader (tests). */
  readConfig?: () => Promise<{ hideInactiveRemoteWorkspaces: boolean }>
}

/**
 * Mark inactive remote workspace treeitems in the sidebar with
 * `data-zr-hidden-ws="1"` so CSS (`remote-session.css.ts`) hides them without
 * removing them from `ctx.workspaces` (keeping New Session workspace pickers
 * intact and avoiding `ClientWorkspaceModel.removedIds` blacklisting).
 *
 * Must be registered before the `isDesktopShell()` gate: client/peer nodes run
 * inside Electron as well as browsers. Inactive on `'host'` and when the
 * setting is false.
 */
export function installRemoteWorkspaceVisibility(
  ctx: ClientContext,
  options: RemoteWorkspaceVisibilityOptions = {},
): void {
  const probeRole = options.probeRole ?? probeClientConfigRole
  const readConfig = options.readConfig ?? clientConfig

  ctx.effect(() => {
    let disposed = false
    let role: 'host' | 'client' | 'peer' | undefined
    let hideEnabled = true
    let observer: MutationObserver | undefined

    const clearAllMarks = (): void => {
      if (typeof document === 'undefined') return
      for (const el of document.querySelectorAll(`[${REMOTE_HIDDEN_WORKSPACE_ATTR}]`)) {
        el.removeAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR)
      }
    }

    const syncDom = (): void => {
      if (disposed || typeof document === 'undefined') return
      const active = (role === 'client' || role === 'peer') && hideEnabled
      if (!active) {
        clearAllMarks()
        return
      }
      const workspacesService = ctx.get('workspaces') as WorkspaceServiceLike | undefined
      const sessionsService = ctx.get('sessions') as SessionsServiceLike | undefined
      if (workspacesService?.list === undefined || sessionsService?.list === undefined) return
      const wsSnap = workspacesService.list.getSnapshot()
      const sessSnap = sessionsService.list.getSnapshot()
      const hidden = hiddenRemoteWorkspaceIds(wsSnap.items, {
        archivedIds: wsSnap.archivedSessionIds,
        sessionsById: sessSnap.byId,
        currentSessionId: currentMainSessionIdOf(ctx),
      })

      for (const row of document.querySelectorAll(WORKSPACE_ROW_SELECTOR)) {
        const key = row.getAttribute('data-row-key')
        if (key === null) continue
        const workspaceId = key.slice(ROW_KEY_PREFIX.length)
        const shouldHide = hidden.has(workspaceId) && !groupHasRenderedSessions(row)
        if (shouldHide) {
          if (row.getAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR) !== '1') {
            row.setAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR, '1')
          }
        } else if (row.hasAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR)) {
          row.removeAttribute(REMOTE_HIDDEN_WORKSPACE_ATTR)
        }
      }
    }

    let pendingSyncHandle: number | ReturnType<typeof setTimeout> | undefined
    let pendingViaRaf = false

    const cancelPendingSync = (): void => {
      if (pendingSyncHandle === undefined) return
      if (pendingViaRaf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(pendingSyncHandle as number)
      } else {
        clearTimeout(pendingSyncHandle)
      }
      pendingSyncHandle = undefined
      pendingViaRaf = false
    }

    const scheduleSync = (): void => {
      if (disposed || pendingSyncHandle !== undefined) return
      if (typeof requestAnimationFrame === 'function') {
        pendingViaRaf = true
        pendingSyncHandle = requestAnimationFrame(() => {
          pendingSyncHandle = undefined
          pendingViaRaf = false
          if (!disposed) syncDom()
        })
      } else {
        pendingViaRaf = false
        pendingSyncHandle = setTimeout(() => {
          pendingSyncHandle = undefined
          if (!disposed) syncDom()
        }, 0)
      }
    }

    const ensureObserver = (): void => {
      if (observer !== undefined || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
      if (document.body === null) return
      observer = new MutationObserver(() => {
        scheduleSync()
      })
      observer.observe(document.body, { childList: true, subtree: true })
    }

    const loadSettings = (): void => {
      void Promise.all([probeRole(), readConfig()]).then(([nextRole, cfg]) => {
        if (disposed) return
        role = nextRole
        hideEnabled = cfg.hideInactiveRemoteWorkspaces
        if ((role === 'client' || role === 'peer') && hideEnabled) {
          ensureObserver()
        }
        syncDom()
      })
    }

    const offs: Array<() => void> = []
    const workspacesService = ctx.get('workspaces') as WorkspaceServiceLike | undefined
    if (workspacesService?.list !== undefined) {
      offs.push(workspacesService.list.subscribe(syncDom))
    }
    const sessionsService = ctx.get('sessions') as SessionsServiceLike | undefined
    if (sessionsService?.list !== undefined) {
      offs.push(sessionsService.list.subscribe(syncDom))
    }
    const uiSession = ctx.get('uiSession') as { current?: { subscribe?: (listener: () => void) => () => void } } | undefined
    if (typeof uiSession?.current?.subscribe === 'function') {
      offs.push(uiSession.current.subscribe(syncDom))
    }

    const onConfigChanged = (): void => {
      loadSettings()
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener(CLIENT_CONFIG_CHANGED_EVENT, onConfigChanged)
    }

    loadSettings()

    return () => {
      disposed = true
      cancelPendingSync()
      observer?.disconnect()
      observer = undefined
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener(CLIENT_CONFIG_CHANGED_EVENT, onConfigChanged)
      }
      for (const off of offs) off()
      clearAllMarks()
    }
  }, 'dsh-zen-remote: remote workspace visibility')
}
