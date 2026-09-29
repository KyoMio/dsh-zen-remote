/**
 * Registration for the T33b session-sharing parts — the work that must run
 * BEFORE apply's desktop-shell gate (the desktop app IS the main server:
 * its title row and session menus are exactly where these parts live),
 * extracted so the Node-side desktop-gate test can drive it against a fake
 * ctx (the components are .tsx; they arrive as parameters, keeping this
 * module JSX-free and importable under Node's type stripping — the same
 * trick register-settings.ts uses).
 *
 * Registers the title-row remote icon on
 * `conversation.session.header.actions` (order 25, past the official jobs
 * entry at 20 so the two never tie) and the remote toggle on
 * `sidebar.workspaces.session.menu.item` (order 500, under the official
 * archive row, behind a group hairline), plus the one stylesheet both
 * surfaces need.
 *
 * The parts render and poll only on the HOST role (T33b-fix): this module
 * wires the shares store's role from the SAME two-level decision the
 * settings page makes (settings-form.ts's shared `settingsRoleOf`) — the
 * configForms row document first, and while the row is silent the effective
 * role probed from `/_dsh/mobile-nav/client-config` (T17: the route carries
 * the merged role). The decision re-runs on every scope snapshot update, so
 * a snapshot that resolves late — or a row whose role appears after the
 * probe already answered — re-decides, and a deployment switched back to
 * host recovers. The wiring hangs off a lazy `ctx.inject(['configForms'], …)`;
 * where the settings service never arrives, one fallback probe wires the
 * role on its own (guarded: a snapshot answer always wins over it).
 *
 * The `sidebar.workspaces.session.menu.item` SlotMap entry is declared here
 * as a structural mirror: this package does not depend on
 * dsh-client-ui-workspace (the slot's owner), whose type-only merges would
 * normally provide it. The mirror records what the workspace browser
 * actually hands its entries: the row props (`sessionId`, `displayTitle`),
 * the `[open, setOpen]` pair it passes as the render occurrence's
 * hookContext, and the list-level inject whose `menuOpenState` hook factory
 * binds that pair — official rows call it `useMenuOpenState` and close the
 * menu with it.
 */
import type { ReactNode } from 'react'
import type { SessionId } from './compat/types.ts'
import type { ClientContext } from './compat/types.ts'
import { getSharesStore } from '../client-data/shares.ts'
import type { SharesStore } from '../client-data/shares.ts'
import { CLIENT_CONFIG_ROUTE, savedRowRole, settingsRoleOf } from '../client-data/settings-form.ts'
import type { ClientConfigBody } from '../client-data/settings-form.ts'
import { NS } from './locales.ts'
import { REMOTE_SHARE_CSS } from './remote-share-css.ts'
import { SETTINGS_ENTRY_ID } from './settings/register-settings.ts'
import type { RemoteHeaderIconProps } from './RemoteHeaderIcon.tsx'
import type { RemoteShareMenuProps } from './RemoteShareMenu.tsx'

/** The `[open, setOpen]` pair the workspace Menu hands every row entry. */
export type SessionMenuOpenState = readonly [boolean, (open: boolean) => void]

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.workspaces.session.menu.item': {
      kind: 'list'
      scope: 'root'
      owner: { sessionId: SessionId, displayTitle: string }
      hookContext: SessionMenuOpenState
      inject: { hooks: { menuOpenState: (context: unknown) => () => SessionMenuOpenState } }
    }
  }
}

/** The header icon component (a .tsx factory result; parameter for Node). */
export type RemoteHeaderIconComponent = (props: RemoteHeaderIconProps) => ReactNode
/** The menu-item component (a .tsx factory result; parameter for Node). */
export type RemoteShareMenuComponent = (props: RemoteShareMenuProps) => ReactNode

/**
 * The page's one client-config probe (T17's fallback role source). Only a
 * DEFINITE answer is cached — the route answered with a body, so its role
 * reading is stable for the process's lifetime (the role cannot change
 * without a restart). A FAILED probe (network error, non-2xx, unparseable
 * body) resolves `undefined` and is NOT cached: the next snapshot update
 * probes again, and until one answers the role reads unknown — never a
 * guessed host (T33b-fix2). `refetch` bypasses the cache and replaces it
 * with a fresh answer; the wiring uses it when the form scope's status
 * changed (the settings page re-probes on the same signal).
 */
let probeAnswer: 'host' | 'client' | undefined
let probeInFlight: Promise<'host' | 'client' | undefined> | undefined
function probeClientConfigRole(refetch = false): Promise<'host' | 'client' | undefined> {
  if (!refetch) {
    if (probeAnswer !== undefined) return Promise.resolve(probeAnswer)
    if (probeInFlight !== undefined) return probeInFlight
  }
  // Always tracked so a settled probe — failed ones especially — never
  // lingers: a stale in-flight promise would hand future probes its old
  // `undefined` without asking the route again.
  probeInFlight = fetch(CLIENT_CONFIG_ROUTE)
    .then((res) => (res.ok ? res.json() as Promise<ClientConfigBody> : undefined))
    .then((body) => {
      // A body without a role field (an older build) still reads host —
      // resolveConfig's "anything not exactly 'client'" default; only a
      // request-level failure stays undefined.
      const answer: 'host' | 'client' | undefined = body === undefined ? undefined : body.role === 'client' ? 'client' : 'host'
      if (answer !== undefined) probeAnswer = answer
      return answer
    })
    .catch(() => undefined)
    .finally(() => { probeInFlight = undefined })
  return probeInFlight
}

/** How one probe is issued — the real route reader, or the check/test
 * double. `refetch` mirrors {@link probeClientConfigRole}: true drops any
 * cached answer and asks again. */
export type ClientConfigProbe = (refetch?: boolean) => Promise<'host' | 'client' | undefined>

export interface WireSharesRoleOptions {
  /** Called once a definite verdict was applied (the no-configForms
   * fallback checks this before trusting its own probe). */
  onVerdict?: () => void
  /** The probe to consult while the row document is silent. Defaults to
   * the real client-config reader; tests inject a controllable double so
   * they never depend on module-level probe state. */
  probe?: ClientConfigProbe
}

/**
 * Wire a shares store's role off one configForms scope: the saved row role
 * wins (settingsRoleOf), while the row is silent the client-config probe
 * fills the gap, and every scope update re-decides. Verdicts of
 * `'unknown'` — snapshot still loading, probe pending or FAILED — leave
 * the store untouched: nothing polls and nothing renders (never a guessed
 * host). A scope STATUS change (loading→ready, a mirror resync) drops the
 * probe answer and probes again, the same two signals the settings page's
 * probe effect re-runs on.
 * @param scope - the plugin row's shared configuration form scope.
 * @param store - the shares store whose role this wiring drives.
 * @param options - verdict callback and probe injection.
 * @returns disposer releasing the scope subscription.
 */
export function wireSharesRole(
  scope: {
    getSnapshot(): { status: 'loading' | 'ready' | 'unavailable', value?: unknown, user?: unknown }
    subscribe(listener: () => void): () => void
  },
  store: Pick<SharesStore, 'setRole'>,
  options: WireSharesRoleOptions = {},
): () => void {
  const { onVerdict, probe = probeClientConfigRole } = options
  let probed: 'host' | 'client' | undefined
  let lastStatus: 'loading' | 'ready' | 'unavailable' | undefined
  let probing = false
  /** Re-decide. `fromProbe` marks the re-entry after a probe settled: the
   * answer is already in `probed`, and starting another probe here would
   * loop (a failed answer re-probing forever, a cached one starving the
   * event loop). Snapshot updates enter through `apply` instead. */
  const evaluate = (fromProbe: boolean): void => {
    const snap = scope.getSnapshot()
    // The form scope moved between loading/ready/unavailable: the previous
    // probe answer no longer stands in for this state — ask again (the
    // settings page's effect re-runs on exactly this signal).
    const statusChanged = lastStatus !== undefined && snap.status !== lastStatus
    lastStatus = snap.status
    if (statusChanged) probed = undefined
    // The row document answers first; only a row-silent snapshot needs the
    // probe (the settings page's exact rule — see settingsRoleOf). A failed
    // probe is not remembered: the NEXT snapshot update probes again — the
    // probe's own completion path must not (see fromProbe).
    const rowRole = savedRowRole(snap)
    if (!fromProbe && snap.status !== 'loading' && rowRole === undefined && !probing) {
      probing = true
      void probe(statusChanged).then((answer) => {
        probing = false
        // A FAILED probe changes no verdict — leave the role exactly as it
        // was (unknown stays unknown; never a guessed host) and wait for
        // the next snapshot update to try again.
        if (answer === undefined) return
        probed = answer
        evaluate(true)
      })
    }
    const verdict = settingsRoleOf(snap.status, snap, probed)
    if (verdict === 'unknown') return
    onVerdict?.()
    store.setRole(verdict)
  }
  const apply = (): void => { evaluate(false) }
  apply()
  return scope.subscribe(apply)
}

/**
 * Register the stylesheet and the two sharing parts. Gate-independent by
 * design — the caller (apply) places this before its desktop gate.
 * @param ctx - client root context.
 * @param headerIcon - the title-row icon component.
 * @param menuItem - the session-menu toggle component.
 */
export function registerRemoteShareUi(
  ctx: ClientContext,
  headerIcon: RemoteHeaderIconComponent,
  menuItem: RemoteShareMenuComponent,
): void {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-zen-remote-remote-share'
    tag.textContent = REMOTE_SHARE_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-zen-remote: remote-share styles')

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'remote-share-icon',
    order: 25,
    locale: NS,
    inject: () => ({ shares: getSharesStore() }),
  }, headerIcon))

  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'remote-share',
    order: 500,
    locale: NS,
    inject: () => ({ shares: getSharesStore() }),
  }, menuItem))

  // The role wiring is lazy on configForms: where the service exists the
  // scope snapshot decides (and keeps deciding on every update); where it
  // never arrives, the fallback probe below wires the role on its own —
  // but a snapshot answer always wins over it.
  const store = getSharesStore()
  let snapshotAnswered = false
  ctx.inject(['configForms'], (formsCtx) => {
    const scope = formsCtx.configForms.get(SETTINGS_ENTRY_ID)
    const off = wireSharesRole(scope, store, { onVerdict: () => { snapshotAnswered = true } })
    formsCtx.effect(() => off, 'dsh-zen-remote: remote-share role')
  })
  void probeClientConfigRole().then((answer) => {
    // A definite answer wires the role; a FAILED probe wires nothing —
    // the parts stay dark (unknown) rather than guessing host
    // (T33b-fix2), and a wiring verdict that arrives later still wins.
    if (snapshotAnswered || answer === undefined) return
    store.setRole(answer)
  })
}
