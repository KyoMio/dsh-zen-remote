import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { clientConfig } from '../client-config.ts'
import { NS } from '../locales.ts'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/** Desktop fold (issue #2) is switched on either way:
 * - plugin row `config.turnFoldDesktop: true` — the host republishes it at
 *   {@link CLIENT_CONFIG_ROUTE} because the client bundle ships statically
 *   and never sees the row config;
 * - per-browser override, same convention as the debug flag: a URL param
 *   writes localStorage (`?mobile-nav-turn-fold=1` opts this browser in,
 *   `=0` opts back out). */
const DESKTOP_KEY = 'dsh-mobile-nav.turn-fold-desktop'
const DESKTOP_PARAM = 'mobile-nav-turn-fold'
/** Last answer the row config gave. The fetch is a round-trip and the phone
 * breakpoint is not, so a desktop reader used to watch a whole session render
 * unfolded and then collapse at once, every page load (issue #3). Remembering
 * the answer switches the fold on before first paint from the second load on.
 * Enable-only: turning the row knob back off clears this, so that load still
 * folds and the next one does not — a stale fold is a chip click away, a
 * one-way `disableDesktop` is a state machine nobody asked for. */
const DESKTOP_CACHE_KEY = 'dsh-mobile-nav.turn-fold-desktop-seen'
/** Root attribute the stylesheet keys the width-independent rules on. */
const DESKTOP_ATTR = 'data-mnav-desktop-fold'

/** Read (and, when the URL param is present, persist) the per-browser opt-in. */
function desktopOptIn(): boolean {
  const param = new URLSearchParams(location.search).get(DESKTOP_PARAM)
  if (param === '1') localStorage.setItem(DESKTOP_KEY, '1')
  else if (param === '0') localStorage.removeItem(DESKTOP_KEY)
  return localStorage.getItem(DESKTOP_KEY) === '1'
}

/** True when the plugin row asks for desktop fold; false on any failure —
 * the shared reader in client-config.ts already swallows those. */
async function desktopConfigured(): Promise<boolean> {
  return (await clientConfig()).turnFoldDesktop
}

/** ChatView's flow column (dsh-client-ui-conversation lib/client.js:5512).
 * Trajectory and every other view render their own tree and never carry this
 * marker, so scoping here is what keeps this effect Chat-only. */
const FLOW = '[data-chat-flow]'

/** Marker + selector of the injected summary row. */
const CHIP = 'turn-fold'
const CHIP_SELECTOR = '[data-mobile-nav="turn-fold"]'

/** Whole-row node kinds that are turn *process*, not conversation content.
 * Keys are ChatNodeSeat's own `data-chat-flow-kind` dispatch values
 * (registerChatNodeRenderers, lib/client.js:9322): tool calls, injected
 * context rows, and slash-command rows. Everything else stays visible —
 * `user`/`steering` (the question), `assistant-step` (the prose, folded
 * per-block below), `turn-tail` (the footer with its actions), and the
 * error notices `turn-error` / `turn-max-tokens` / `model-retry`, which are
 * exactly what a reader must not have to hunt for. */
export const PROCESS_KINDS = ['context', 'tool-call', 'command'] as const
const PROCESS_KIND_SET: ReadonlySet<string> = new Set(PROCESS_KINDS)

/** Node kinds that open a new turn group. */
const TURN_HEAD_KINDS = new Set(['user', 'steering'])

/** ReasoningRow's own marker (lib/client.js:8966) — the Think disclosure
 * rendered inside an assistant-step row, beside that step's prose. */
export const THINK = '[data-variant="think"]'

/** Attribute the phone stylesheet turns into `display: none`. Written for the
 * one case the stylesheet cannot express on its own: an assistant-step row
 * whose entire body is reasoning, which has to go as a whole row (see
 * {@link foldsWholeRow}). Because it is the only thing hiding that row, it is
 * written from {@link markWholeRows} in the observer callback rather than the
 * scan a frame later — see that function for what the frame cost. */
const FOLD = 'data-mnav-fold'
/** Per-item override written while its turn is expanded. */
export const OPEN = 'data-mnav-fold-open'
/** Root attribute written for as long as this effect is attached — i.e. for
 * exactly the widths where the fold is live. The stylesheet keys its
 * born-folded rules on it, which is what makes a newly inserted tool call
 * hidden at its FIRST paint instead of after the next rescan (the "row
 * flashes in, then folds away" report, 2026-08-22); it also keeps the
 * stylesheet a no-op — content visible — if this effect never runs. */
const ACTIVE_ATTR = 'data-mnav-fold-on'

/** Selector of the one row kind that can fold whole — see {@link foldsWholeRow}. */
const STEP_SELECTOR = '[data-chat-flow-kind="assistant-step"]'

/**
 * True when the reasoning rows are the ONLY thing this row renders, so the
 * whole flow item has to go: the flow column is `display: flex` with
 * `gap: 16px`, and an emptied-out flex item still claims its gap — the
 * reader would see the folded steps as a column of blank bands.
 * Structural test, no class names: every ancestor from the reasoning rows'
 * shared parent up to the flow item must be an only child.
 */
function foldsWholeRow(row: Element, thinks: readonly Element[]): boolean {
  const first = thinks[0]
  if (first === undefined) return false
  const body = first.parentElement
  if (body === null || body.childElementCount !== thinks.length) return false
  let node: Element = body
  while (node !== row) {
    const parent = node.parentElement
    if (parent === null) return false
    if (parent.childElementCount !== 1) return false
    node = parent
  }
  return true
}

/** The process items one flow row contributes: the row itself, its reasoning
 * rows, or nothing at all. */
function processItems(row: Element): readonly Element[] {
  const kind = row.getAttribute('data-chat-flow-kind')
  if (kind === null) return []
  if (PROCESS_KIND_SET.has(kind)) return [row]
  if (kind !== 'assistant-step') return []
  const thinks = [...row.querySelectorAll(THINK)]
  if (thinks.length === 0) return []
  return foldsWholeRow(row, thinks) ? [row] : thinks
}

/**
 * The summary row sitting immediately before `anchor`, created if absent.
 * Idempotent by construction — React re-rendering the flow either leaves our
 * button where it is (it only ever inserts and removes its OWN nodes) or
 * drops it, and the next rescan puts it back.
 */
function chipBefore(anchor: Element): HTMLElement | null {
  const previous = anchor.previousElementSibling
  if (previous instanceof HTMLElement && previous.dataset['mobileNav'] === CHIP) return previous
  const parent = anchor.parentElement
  if (parent === null) return null
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.dataset['mobileNav'] = CHIP
  parent.insertBefore(chip, anchor)
  return chip
}

interface Group {
  /** Stable id: the turn-opening row's node key (a positional id for a
   * leading group whose question has not been paged in). */
  readonly key: string
  /** Every process element of this turn, in flow order. */
  readonly items: Element[]
}

/** Split the flow column into turns: a group runs from one user/steering row
 * up to (not including) the next. Rows that precede the first user row —
 * a turn whose question has not been paged in yet — form a leading group of
 * their own, so their process never becomes unreachable. */
function groupsOf(flow: Element): readonly Group[] {
  const groups: Group[] = []
  let current: Group | undefined
  for (const row of flow.children) {
    const kind = row.getAttribute('data-chat-flow-kind')
    if (kind === null) continue
    if (current === undefined || TURN_HEAD_KINDS.has(kind)) {
      current = { key: row.getAttribute('data-chat-flow-key') ?? `pos${groups.length}`, items: [] }
      groups.push(current)
    }
    current.items.push(...processItems(row))
  }
  return groups
}

/**
 * S8 — collapse a turn's process into one summary row (< 768px by default;
 * every width when the plugin row sets `config.turnFoldDesktop` or a browser
 * opts itself in via `?mobile-nav-turn-fold=1`).
 *
 * Route taken: DOM marking, not the `conversation.chat.node` keyed slot.
 * That slot dispatches on node kind and a second registration at a key
 * SHADOWS the official renderer (dsh-client-ui-slots index.d.ts:542 — the
 * cell's lowest-priority live entry renders, there is no wrapping form and
 * no `children` handle to the shadowed component). Taking `tool-call` would
 * mean re-implementing every tool's presentation, its `t` seat comes from
 * the entry's own declared locale namespace and its services from the
 * registrant's own inject face — neither is reachable from here — and the
 * registration is global, so the desktop no-op would be gone too.
 *
 * The DOM route needs no class names: ChatNodeSeat stamps every row with
 * `data-chat-flow-kind` / `data-chat-flow-key` (lib/client.js:5228) and
 * ReasoningRow stamps `data-variant="think"` — turn grouping is pure
 * structure (the run of rows following one `user` row), never text.
 *
 * ponytail: one rAF-coalesced full rescan per DOM mutation batch, O(rows).
 * If a very long session ever makes streaming feel heavy, narrow the
 * observer to the flow column's own childList and diff instead.
 */
export function installTurnFold(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(PHONE_QUERY)
    const t = ctx.locale.bind(NS)
    /** Turns the reader opened. Deliberately not persisted (spec: a reload
     * returns to the default folded state). */
    const expanded = new Set<string>()
    let observer: MutationObserver | null = null
    let frame = 0

    const label = (chip: HTMLElement, count: number, running: boolean): void => {
      const next = running ? t('turnFoldRunning', { count }) : t('turnFold', { count })
      if (chip.textContent !== next) chip.textContent = next
    }

    const scan = (): void => {
      const flow = document.querySelector(FLOW)
      if (flow === null) return
      // TurnStatus, ChatView's own running banner — present only while the
      // last turn is still working (lib/client.js:5548).
      const running = flow.querySelector(':scope > [role="status"]') !== null
      const groups = groupsOf(flow)
      const live = new Set<string>()
      const liveItems = new Set<Element>()

      groups.forEach((group, index) => {
        if (group.items.length === 0) return
        const open = expanded.has(group.key)
        for (const item of group.items) {
          liveItems.add(item)
          item.setAttribute(FOLD, '')
          if (open) item.setAttribute(OPEN, '')
          else item.removeAttribute(OPEN)
        }
        const first = group.items[0]
        if (first === undefined) return
        const anchor = first.closest('[data-chat-flow-key]') ?? first
        const chip = chipBefore(anchor)
        if (chip === null) return
        chip.dataset['foldGroup'] = group.key
        chip.setAttribute('aria-expanded', open ? 'true' : 'false')
        if (open) chip.dataset['open'] = ''
        else delete chip.dataset['open']
        const groupRunning = running && index === groups.length - 1
        if (groupRunning) chip.dataset['running'] = ''
        else delete chip.dataset['running']
        label(chip, group.items.length, groupRunning)
        live.add(group.key)
      })

      for (const chip of flow.querySelectorAll<HTMLElement>(CHIP_SELECTOR)) {
        const key = chip.dataset['foldGroup']
        if (key === undefined || !live.has(key)) chip.remove()
      }

      // Unmark elements that stopped being process items. Without this, an
      // assistant-step row folded whole while it streamed ONLY reasoning kept
      // its row-level fold after prose started arriving in the same DOM node
      // (React updates the row in place), hiding the streaming reply until a
      // completion re-render rebuilt the row — the "reply only appears when
      // the turn finishes" phone bug (2026-08-18). {@link OPEN} needs the
      // same sweep on its own account: it is what releases a row from the
      // stylesheet's reasoning rules, so a stale one shows the reasoning of
      // a turn the reader has since folded.
      for (const stale of flow.querySelectorAll(`[${FOLD}], [${OPEN}]`)) {
        if (liveItems.has(stale)) continue
        stale.removeAttribute(FOLD)
        stale.removeAttribute(OPEN)
      }
    }

    /**
     * Fold (or release) the reasoning-only rows this mutation batch touched,
     * synchronously.
     *
     * The full {@link scan} is rAF-coalesced, and React commits after that
     * frame's rAF phase, so a scan scheduled from a mutation lands one PAINTED
     * frame later. For everything else that is invisible — the stylesheet
     * already hid it by the host's own markers before the effect looked. For
     * the whole-row fold, which nothing but {@link FOLD} hides, the reader saw
     * that frame: a blank 16px band on the way in (the flow column's gap,
     * which an emptied flex item still claims), and — worse — the row still
     * hidden for a frame after prose started arriving into it, so the reply
     * appeared to stutter (issue #3).
     *
     * A MutationObserver callback is a microtask: it runs at the end of the
     * task that mutated the DOM, before that frame's rendering update. Marking
     * here is therefore never a frame late, in either direction.
     *
     * ponytail: O(rows touched by the batch), not O(rows). If streaming ever
     * feels heavy, the cheap win is skipping batches whose records are all
     * characterData — the fold verdict only changes when elements do.
     */
    const markWholeRows = (records: readonly MutationRecord[]): void => {
      const rows = new Set<Element>()
      for (const record of records) {
        const target = record.target
        if (target instanceof Element) {
          const row = target.closest(STEP_SELECTOR)
          if (row !== null) rows.add(row)
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          if (node.matches(STEP_SELECTOR)) rows.add(node)
          for (const nested of node.querySelectorAll(STEP_SELECTOR)) rows.add(nested)
        }
      }
      for (const row of rows) {
        // Exactly what {@link groupsOf} walks: a direct child of the chat flow
        // column. This is the scoping that keeps the effect Chat-only — the
        // mutation records reach the whole document, so without it a row in
        // any other view that seats chat nodes would get hidden with no chip
        // to bring it back. It also drops rows detached since the batch.
        const parent = row.parentElement
        if (parent === null || !parent.matches(FLOW)) continue
        const thinks = [...row.querySelectorAll(THINK)]
        if (thinks.length > 0 && foldsWholeRow(row, thinks)) row.setAttribute(FOLD, '')
        else row.removeAttribute(FOLD)
      }
    }

    const schedule = (): void => {
      // The locale subscription below lives outside attach/detach, so this
      // guard is what keeps a late dictionary registration from marking up
      // the flow at >= 768px (real WebKit regression: chips and fold
      // attributes appeared at 1280px — invisible, since every rule that
      // hides anything is inside the phone media query, but still wrong).
      if (observer === null) return
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        scan()
        // Drop the records our own chip insertions just queued, so a rescan
        // can never re-trigger itself (the debug-badge feedback-loop freeze).
        observer?.takeRecords()
      })
    }

    const onClick = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const chip = target.closest<HTMLElement>(CHIP_SELECTOR)
      const key = chip?.dataset['foldGroup']
      if (key === undefined) return
      if (expanded.has(key)) expanded.delete(key)
      else expanded.add(key)
      scan()
    }

    const clear = (): void => {
      for (const chip of document.querySelectorAll(CHIP_SELECTOR)) chip.remove()
      for (const item of document.querySelectorAll(`[${FOLD}], [${OPEN}]`)) {
        item.removeAttribute(FOLD)
        item.removeAttribute(OPEN)
      }
    }

    const attach = (): void => {
      if (observer !== null) return
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      observer = new MutationObserver((records) => {
        markWholeRows(records)
        schedule()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      document.addEventListener('click', onClick)
      scan()
    }
    const detach = (): void => {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
      observer?.disconnect()
      observer = null
      document.removeEventListener('click', onClick)
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      expanded.clear()
      clear()
    }

    const onChange = (event: MediaQueryListEvent): void => (event.matches ? attach() : detach())
    let disposed = false
    let desktop = false
    /** Attach at every width and drop the breakpoint listener — the
     * stylesheet's html[DESKTOP_ATTR] rules take over from the phone media
     * query. Idempotent: the config answer and the local opt-in may both
     * ask for it. */
    const enableDesktop = (): void => {
      if (desktop || disposed) return
      desktop = true
      document.documentElement.setAttribute(DESKTOP_ATTR, '')
      narrow.removeEventListener('change', onChange)
      attach()
    }

    if (narrow.matches) attach()
    narrow.addEventListener('change', onChange)
    // Both switches are synchronous reads, so a returning reader folds before
    // first paint. Not awaited before phone attach either — folding must not
    // wait on a round-trip.
    if (desktopOptIn() || localStorage.getItem(DESKTOP_CACHE_KEY) === '1') enableDesktop()
    // The row config still arrives async, and remains the authority: a late
    // yes attaches then and is remembered, a no forgets. A late answer after
    // dispose is a no-op inside enableDesktop.
    void desktopConfigured().then((on) => {
      if (on) { localStorage.setItem(DESKTOP_CACHE_KEY, '1'); enableDesktop() }
      else localStorage.removeItem(DESKTOP_CACHE_KEY)
    })
    // A language switch changes the chip copy of every already-rendered turn.
    const stopLocale = ctx.locale.subscribe(schedule)
    return () => {
      disposed = true
      document.documentElement.removeAttribute(DESKTOP_ATTR)
      narrow.removeEventListener('change', onChange)
      stopLocale()
      detach()
    }
  }, 'dsh-mobile-nav: turn process fold')
}
