import type { ClientContext } from '../compat/types.ts'

/** Phone breakpoint — the same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/**
 * The permission trigger, addressed the way composer.css.ts addresses the
 * whole permission seat: a structured slot plus the build-suffix trigger
 * class (DSH 0.2.0 keeps both). The trigger carries NO aria-expanded and
 * NO aria-controls on 0.2.0 (the Menu primitive portals its list to body
 * and links nothing back), so the click is the only open signal there is.
 */
const PERM_TRIGGER_SELECTOR = '[data-slot="conversation.input.permission"] button[class$="_trigger"]'

/**
 * UX-3: the HERO page's two workspace triggers (WorkspaceSheet slot impl,
 * verified in the dsh-client-ui-conversation bundle 2026-11-05):
 * - `WorkspaceChip` — a bare `button` whose hashed class ends in
 *   `_workspace`, carrying `aria-haspopup="menu"` + `aria-expanded`;
 * - the placeholder card — when a blank hero session has no workspace yet
 *   the whole `div[data-composer-card]` carries `cardWorkspaceTrigger` and
 *   its click opens the same menu (`onRequestWorkspace`).
 * Both open a `body > div[role="menu"]` of `button[role="menuitem"]` items.
 */
const WORKSPACE_TRIGGER_SELECTOR =
  '[class$="_workspace"][aria-haspopup="menu"], [data-composer-card][class*="_cardWorkspaceTrigger"]'

/**
 * What the Menu primitive portals on 0.2.0: a `role=menu` div DIRECTLY under
 * body, carrying `data-menu-material` and a randomized `--dsh-menu-anchor`
 * (a per-instance useId) but NO id and no back-reference from the trigger —
 * there is no pure-CSS way to pick OUR menu out of the portal crowd: the
 * host has MANY `portal: true` Menus (agent-preset, chat preference rows,
 * the Enter-behavior row, the workspace sidebar's 「…」, open-in-app,
 * deliverables, the copy button's confirm, …), and none of them may become
 * a bottom sheet. That is why this effect exists: a click on a sheet trigger
 * arms a short window and the next body-level menu to land is OURS to mark —
 * while a marked menu still on the page (the close click) keeps the window
 * shut.
 */
const PORTAL_MENU_SELECTOR = 'body > div[role="menu"]'

/** The marker composer.css.ts section 4 styles into the bottom sheet. */
const SHEET_MARKER = 'data-zen-sheet'
const SHEET_VALUE_PERM = 'perm'
const SHEET_VALUE_WORKSPACE = 'workspace'

/**
 * UX-3: the switch lock. Picking a workspace in the hero sheet runs
 * `selectWorkspace` → `POST /api/session/create` → `replaceMain` — the
 * conversation unmounts and remounts (`useMaybeIncarnation` epoch+1) and the
 * composer briefly still belongs to the OLD blank session. A message sent in
 * that window lands on the old session and is then wiped by the remount,
 * bouncing the UI back to the "choose a workspace" placeholder. While the
 * `data-zen-ws-switching` attribute sits on `<html>`, composer.css dead-zones
 * and dims the composer bar; the lock releases the moment the conversation
 * root's `data-conversation-session` has MOVED and the placeholder card is
 * gone — with a hard cap so a failed/no-op switch cannot freeze the input.
 */
const SWITCH_MARKER = 'data-zen-ws-switching'
const SWITCH_LOCK_MS = 1_500
const SESSION_ATTR = 'data-conversation-session'
const SESSION_SELECTOR = `[${SESSION_ATTR}]`
/** The hero's inert "choose a workspace" state: the whole input card IS the trigger. */
const PLACEHOLDER_CARD_SELECTOR = '[data-composer-card][class*="_cardWorkspaceTrigger"]'
/** Spelled literally (not interpolated) — the test pins this exact text as the perm/workspace discriminator. */
const WS_MENUITEM_SELECTOR =
  'body > div[role="menu"][data-zen-sheet="workspace"] button[role="menuitem"]'

/** The DOM face the pure decisions below read — structural, so the tests
 * drive them with plain objects instead of a DOM. */
export interface PermissionSheetCandidate {
  matches(selectors: string): boolean
  getAttribute(name: string): string | null
  /** A truthy `closest` result means the click started inside the seat. */
  closest(selectors: string): unknown
}

/**
 * Whether ONE body-level node is a portal menu that does not yet carry the
 * sheet marker. Pure over the node's own methods: `matches` answers the
 * body-level role=menu shape, `getAttribute` the marker.
 */
export function isUnmarkedPortalMenu(node: PermissionSheetCandidate): boolean {
  return node.matches(PORTAL_MENU_SELECTOR) && node.getAttribute(SHEET_MARKER) === null
}

/** Which bottom sheet a trigger click arms. */
export type SheetKind = 'perm' | 'workspace'

const inSeat = (seat: unknown): boolean => seat !== undefined && seat !== null

/**
 * Which sheet ONE click event's target arms: the phone shell only. The
 * permission seat's trigger arms `perm` (T70); the hero page's two
 * workspace triggers arm `workspace` (UX-3). Any other button — the
 * sidebar's 「…」, a copy button — arms nothing, so the menus they open are
 * never marked.
 */
export function sheetKindForTrigger(target: PermissionSheetCandidate | null | undefined, phoneMatches: boolean): SheetKind | null {
  if (!phoneMatches) return null
  if (inSeat(target?.closest(PERM_TRIGGER_SELECTOR))) return 'perm'
  if (inSeat(target?.closest(WORKSPACE_TRIGGER_SELECTOR))) return 'workspace'
  return null
}

/**
 * UX-3: whether a pointerdown landed inside a WORKSPACE trigger — the only
 * triggers whose open/close suffers the outside-pointerdown + toggle-click
 * race (the Menu closes the portaled sheet on the outside pointerdown, and
 * the trigger's own click would flip it straight back open). The permission
 * trigger toggles by click alone and is never suppressed.
 */
export function pointerdownOnWorkspaceTrigger(target: PermissionSheetCandidate | null | undefined): boolean {
  return inSeat(target?.closest(WORKSPACE_TRIGGER_SELECTOR))
}

/**
 * UX-3: whether a click started on a workspace item inside the MARKED
 * workspace sheet — the pick that starts the switch lock. Keyed on the
 * `workspace` marker value, so a permission option can never lock the
 * composer.
 */
export function menuitemClickStartsWorkspaceSwitch(target: PermissionSheetCandidate | null | undefined): boolean {
  return inSeat(target?.closest(WS_MENUITEM_SELECTOR))
}

/** What the release check reads, injected so the tests stay DOM-free. */
export interface WorkspaceSwitchProbe {
  /** The conversation root's current `data-conversation-session` value (null = none mounted). */
  currentSessionValue(): string | null
  /** Whether the hero's "choose a workspace" placeholder card is mounted. */
  placeholderOpen(): boolean
}

/**
 * Whether the workspace switch has settled: the conversation root now names
 * a DIFFERENT session than the one the lock was taken on, and the no-workspace
 * placeholder card is gone (the optimistic `pendingWorkspaceId` display alone
 * is not enough — the remount resets it).
 */
export function workspaceSwitchSettled(probe: WorkspaceSwitchProbe, lockedSessionValue: string | null): boolean {
  if (probe.currentSessionValue() === lockedSessionValue) return false
  return !probe.placeholderOpen()
}

/**
 * How long an OPEN click stays armed. The portal lands in the same React
 * commit as the state flip, so milliseconds of real latency; the window is
 * consumed by the menu that opens with it, or expires on its own — the
 * close path never arms at all (the marked menu is still on the page, see
 * the guard in onCaptureClick), so the ceiling's only job is retiring a
 * window whose menu never came.
 */
const ARM_MS = 1_500

/**
 * T70: turn the portaled permission menu into the bottom sheet composer.css
 * section 4 promises, on DSH 0.2.0. Up to 0.1.7 the permission menu rendered
 * inside the permission seat and the stylesheet's descendant selectors
 * reached it; 0.2.0 portals it to body (`portal: true` on the Menu), the
 * selectors stopped matching, and the phone got a tiny floating popup. The
 * host offers no stable attribute to key the portal off — the anchor is a
 * per-instance useId, there is no id and no aria-controls — so this effect
 * marks it: the trigger's click arms a short window, the observer stamps the
 * next body-level menu with `data-zen-sheet`, and the stylesheet (which
 * only the phone shell loads) turns THAT into the sheet. The portal menu
 * unmounts on close, so the marker's lifetime is exactly the menu's; the
 * 0.1.7 inline structure keeps working through the untouched descendant
 * selectors, and the desktop shell never loads this stylesheet at all.
 *
 * UX-3 extends the same machinery to the hero page's workspace menu:
 * - the two workspace triggers arm a `data-zen-sheet="workspace"` sheet;
 * - a pointerdown on a workspace trigger while a marked sheet is up
 *   suppresses the trigger's own click, so one tap reliably CLOSES (the
 *   host's outside-pointerdown close stands instead of being undone by the
 *   toggle click);
 * - a pick inside the workspace sheet locks the composer for the length of
 *   the `selectWorkspace` remount (see SWITCH_MARKER above).
 */
export function installPermissionSheet(ctx: ClientContext): void {
  ctx.effect(() => {
    const phone = window.matchMedia(PHONE_QUERY)
    let armed = false
    let armedKind: string = SHEET_VALUE_PERM
    let armTimer: ReturnType<typeof setTimeout> | undefined
    // UX-3 toggle debounce: recomputed on EVERY pointerdown, consumed by the
    // next click — a pointerdown whose click never comes (drag cancel) cannot
    // leave a stale swallow behind.
    let suppressClick = false
    // Set when a swallowed click found the marked menu STILL on the page
    // (the pointerdown close did not land): the next tap passes through to
    // the host's own toggle instead of being swallowed forever.
    let allowToggle = false

    const disarm = (): void => {
      armed = false
      if (armTimer !== undefined) {
        clearTimeout(armTimer)
        armTimer = undefined
      }
    }

    const markedSheet = (): Element | null =>
      document.querySelector(`${PORTAL_MENU_SELECTOR}[${SHEET_MARKER}]`)

    const readSessionValue = (): string | null =>
      document.querySelector(SESSION_SELECTOR)?.getAttribute(SESSION_ATTR) ?? null

    const placeholderOpen = (): boolean => document.querySelector(PLACEHOLDER_CARD_SELECTOR) !== null

    // -- UX-3 switch lock -------------------------------------------------
    let lockedSessionValue: string | null = null
    let lockTimer: ReturnType<typeof setTimeout> | undefined
    let lockObserver: MutationObserver | undefined

    const releaseLock = (): void => {
      if (lockTimer !== undefined) {
        clearTimeout(lockTimer)
        lockTimer = undefined
      }
      lockObserver?.disconnect()
      lockObserver = undefined
      lockedSessionValue = null
      document.documentElement.removeAttribute(SWITCH_MARKER)
    }

    const checkLock = (): void => {
      if (lockedSessionValue === null) return
      if (workspaceSwitchSettled({ currentSessionValue: readSessionValue, placeholderOpen }, lockedSessionValue)) {
        releaseLock()
      }
    }

    const startSwitchLock = (): void => {
      if (lockedSessionValue === null) {
        lockedSessionValue = readSessionValue()
        document.documentElement.setAttribute(SWITCH_MARKER, '1')
        lockObserver = new MutationObserver(checkLock)
        // The session id moves on the conversation root (attribute) and the
        // placeholder card mounts/unmounts (childList) — plus class flips on
        // the card are attribute mutations too. One bounded subtree watch
        // covers all of it.
        lockObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
      }
      if (lockTimer !== undefined) clearTimeout(lockTimer)
      lockTimer = setTimeout(releaseLock, SWITCH_LOCK_MS)
    }
    // ---------------------------------------------------------------------

    const onCapturePointerDown = (event: Event): void => {
      const target = event.target instanceof Element ? event.target : null
      const onTrigger = pointerdownOnWorkspaceTrigger(target)
      suppressClick = onTrigger && markedSheet() !== null && !allowToggle
      if (!suppressClick) allowToggle = false
    }

    const onCaptureClick = (event: Event): void => {
      // UX-3: let the outside-pointerdown close stand — stopPropagation
      // keeps the click from React's root listeners, so the trigger cannot
      // toggle the sheet straight back open.
      if (suppressClick) {
        suppressClick = false
        if (markedSheet() !== null) allowToggle = true
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const target = event.target instanceof Element ? event.target : null
      // UX-3: a pick inside the workspace sheet starts the switch lock — the
      // composer must not accept input on the old blank session while
      // selectWorkspace remounts the conversation underneath it.
      if (phone.matches && menuitemClickStartsWorkspaceSwitch(target)) {
        startSwitchLock()
        return
      }
      const kind = sheetKindForTrigger(target, phone.matches)
      if (kind === null) return
      // T70-fix: the trigger TOGGLES. A click that CLOSES the menu lands
      // while the marked menu is still in the DOM (capture runs before the
      // host's own handler unmounts it) — arming there would leave a live
      // 1.5 s window with no menu coming to consume it, and any unrelated
      // body-level menu opening inside that window would be mis-marked as
      // ours. A marked menu present at click time means this click can only
      // be the close (or a no-op re-open), never an opening we must catch.
      if (markedSheet() !== null) return
      armed = true
      armedKind = kind === 'workspace' ? SHEET_VALUE_WORKSPACE : SHEET_VALUE_PERM
      if (armTimer !== undefined) clearTimeout(armTimer)
      armTimer = setTimeout(disarm, ARM_MS)
    }

    /** Mark it if this tick is armed; one menu consumes the arm. */
    const markIfArmed = (root: Element): void => {
      if (!armed) return
      disarm()
      root.setAttribute(SHEET_MARKER, armedKind)
    }

    // Capture phase: the host's own handlers may stop the click's bubble
    // (the trigger toggles `open` itself), so listen on the document in
    // capture and never depend on propagation reaching us.
    document.addEventListener('pointerdown', onCapturePointerDown, true)
    document.addEventListener('click', onCaptureClick, true)
    const observer = new MutationObserver((records) => {
      if (!armed) return
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && isUnmarkedPortalMenu(node)) markIfArmed(node)
        }
      }
    })
    observer.observe(document.body, { childList: true })

    return () => {
      document.removeEventListener('pointerdown', onCapturePointerDown, true)
      document.removeEventListener('click', onCaptureClick, true)
      observer.disconnect()
      disarm()
      releaseLock()
      // A still-open marked menu outliving this effect keeps its marker only
      // until the user closes it (the element unmounts); scrubbing here
      // would fight a React commit mid-flight for no visual gain.
    }
  }, 'dsh-mobile-nav: permission sheet marker')
}
