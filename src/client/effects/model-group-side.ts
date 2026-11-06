import type { ClientContext } from '../compat/types.ts'
import { classifyModelGroupsForSession, REMOTE_SERVER_ATTRIBUTE, type ModelGroupHeading, type ModelGroupSide } from '../../client-data/model-group-side.ts'

/**
 * T74: stamp every model-menu group with the side of the pairing it belongs
 * to, so remote-session.css.ts can hide the groups the open session cannot
 * run. The stamps are `data-zr-group="remote|local"` on each
 * `section[role="group"]`; which sections get one (and which get none) is
 * the pure classifier's container rule (client-data/model-group-side.ts) —
 * only a container holding at least one marked (WORD JOINER-prefixed, see
 * virtual-id.ts) heading is decided at all, so every other menu and the
 * whole rest of the page is never touched.
 *
 * MS-4: the open remote session's server id (`data-zr-remote-server` on
 * <html>, written by effects/remote-session.ts) is the classifier's
 * `activeRemoteServerId` — a remote group whose heading decodes to a
 * DIFFERENT paired server is stamped `remote-other`. Switching between two
 * servers' sessions changes no group DOM at all, so a second observer
 * watches that one <html> attribute and rescans the moment it moves.
 *
 * Synchronous in the observer callback, never behind rAF: the callback is a
 * microtask and runs before this frame paints, so a group that must be
 * hidden is hidden the first time it is drawn. A rAF would land a frame late
 * and show one frame of the groups the CSS is about to hide (AGENTS.md's
 * "晚一帧" rule — the same shape the turn-fold and model-sheet-extras bugs
 * shared). The cheap batch gate below keeps the full rescan off the hot
 * path: most mutations (chat streaming, composer typing) touch no group.
 */
const GROUP_SELECTOR = 'section[role="group"]'

/** The stamp this effect writes; remote-session.css.ts hides
 * `[data-zr-group="local"]` and `[data-zr-group="remote-other"]` in a
 * remote session and both remote stamps everywhere else. */
const STAMP = 'data-zr-group'

/**
 * The heading text a group section renders, across the two DSH layouts:
 * 0.1.7 points `aria-labelledby` at a heading div (id `<useId>-<group.id>`);
 * 0.2.0's MenuGroup points it at its own useId heading — which is also the
 * first `[data-menu-group-heading]` child — and its first child is an
 * id-less position sentinel span. Falls through in that order, then to the
 * first id-bearing child (0.1.7's heading, should `aria-labelledby` ever be
 * dropped), and gives up with `null`.
 */
export function headingTextOf(section: Element, getElementById: (id: string) => Element | null): string | null {
  const labelledby = section.getAttribute('aria-labelledby')
  if (labelledby !== null) {
    const heading = getElementById(labelledby)
    if (heading !== null) return heading.textContent
  }
  const own = section.querySelector(':scope > [data-menu-group-heading]')
  if (own !== null) return own.textContent
  for (const child of section.children) {
    if (child.id !== '') return child.textContent
  }
  return null
}

/** Does this mutation involve a group section, inside or as a node? Groups
 * are rare; everything else (streaming text, composer typing) bails here. */
function touchesGroup(mutation: MutationRecord): boolean {
  if (mutation.type === 'childList') {
    for (const node of mutation.addedNodes) if (isGroupish(node)) return true
    for (const node of mutation.removedNodes) if (isGroupish(node)) return true
  }
  const target = mutation.target
  const el = target.nodeType === 1 ? (target as Element) : target.parentElement
  return el !== null && el.closest(GROUP_SELECTOR) !== null
}

function isGroupish(node: Node): boolean {
  if (node.nodeType !== 1) return false
  const el = node as Element
  return el.matches(GROUP_SELECTOR) || el.querySelector(GROUP_SELECTOR) !== null
}

export function installModelGroupSide(ctx: ClientContext): void {
  ctx.effect(() => {
    const applyVerdict = (section: Element, verdict: ModelGroupSide): void => {
      // Write only on change — the observer does not watch attributes (so a
      // stamp cannot re-trigger it), but a removed section's container may
      // be re-decided, and an unconditional set would still churn
      // style/attribute machinery for no effect.
      if (verdict === undefined) {
        if (section.hasAttribute(STAMP)) section.removeAttribute(STAMP)
      } else if (section.getAttribute(STAMP) !== verdict) {
        section.setAttribute(STAMP, verdict)
      }
    }

    const scan = (): void => {
      const sections = document.querySelectorAll(GROUP_SELECTOR)
      // Group by parent element, in document order: querySelectorAll walks
      // the document, and one parent's children form a contiguous run of it,
      // so a running number per distinct parent is a stable container key.
      const containerKeys = new Map<Element, number>()
      const rows: Array<ModelGroupHeading & { section: Element }> = []
      for (const section of sections) {
        const parent = section.parentElement
        if (parent === null) continue
        let key = containerKeys.get(parent)
        if (key === undefined) {
          key = containerKeys.size
          containerKeys.set(parent, key)
        }
        const text = headingTextOf(section, (id) => document.getElementById(id))
        rows.push({ section, containerKey: key, headingText: text ?? '' })
      }
      const activeRemoteServerId = document.documentElement.getAttribute(REMOTE_SERVER_ATTRIBUTE) ?? undefined
      const verdicts = classifyModelGroupsForSession(rows, activeRemoteServerId)
      rows.forEach((row, i) => applyVerdict(row.section, verdicts[i]))
    }

    // childList + subtree catches mounted/unmounted/re-parented groups,
    // characterData catches heading texts changing in place. Attributes are
    // deliberately unwatched: this effect is their only writer.
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (touchesGroup(mutation)) {
          scan()
          return
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    // MS-4: the session's server moves on <html> alone (A's session → B's
    // with the menu open touches no group) — rescan synchronously, same
    // no-rAF discipline as above.
    const serverObserver = new MutationObserver(() => scan())
    serverObserver.observe(document.documentElement, { attributes: true, attributeFilter: [REMOTE_SERVER_ATTRIBUTE] })
    // The initial paint may already hold groups (session restored under an
    // open menu): stamp them synchronously at install, like every observer
    // effect here does.
    scan()

    return () => {
      observer.disconnect()
      serverObserver.disconnect()
      // Undo every stamp so the host DOM reads exactly as before the effect
      // ran — the CSS rules key on the stamp, so this un-hides everything.
      for (const section of document.querySelectorAll(`${GROUP_SELECTOR}[${STAMP}]`)) {
        section.removeAttribute(STAMP)
      }
    }
  }, 'dsh-zen-remote: model group side')
}
