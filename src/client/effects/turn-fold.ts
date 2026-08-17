import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { NS } from '../locales.ts'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

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
const PROCESS_KINDS = new Set(['context', 'tool-call', 'command'])

/** Node kinds that open a new turn group. */
const TURN_HEAD_KINDS = new Set(['user', 'steering'])

/** ReasoningRow's own marker (lib/client.js:8966) — the Think disclosure
 * rendered inside an assistant-step row, beside that step's prose. */
const THINK = '[data-variant="think"]'

/** Attribute the phone stylesheet turns into `display: none`. */
const FOLD = 'data-mnav-fold'
/** Per-item override written while its turn is expanded. */
const OPEN = 'data-mnav-fold-open'

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
  if (PROCESS_KINDS.has(kind)) return [row]
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
 * S8 — collapse a turn's process into one summary row (< 768px only).
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

      groups.forEach((group, index) => {
        if (group.items.length === 0) return
        const open = expanded.has(group.key)
        for (const item of group.items) {
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
      for (const item of document.querySelectorAll(`[${FOLD}]`)) {
        item.removeAttribute(FOLD)
        item.removeAttribute(OPEN)
      }
    }

    const attach = (): void => {
      if (observer !== null) return
      observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      document.addEventListener('click', onClick)
      scan()
    }
    const detach = (): void => {
      observer?.disconnect()
      observer = null
      document.removeEventListener('click', onClick)
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      expanded.clear()
      clear()
    }

    if (narrow.matches) attach()
    const onChange = (event: MediaQueryListEvent): void => (event.matches ? attach() : detach())
    narrow.addEventListener('change', onChange)
    // A language switch changes the chip copy of every already-rendered turn.
    const stopLocale = ctx.locale.subscribe(schedule)
    return () => {
      narrow.removeEventListener('change', onChange)
      stopLocale()
      detach()
    }
  }, 'dsh-mobile-nav: turn process fold')
}
