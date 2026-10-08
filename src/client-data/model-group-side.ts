/**
 * T74: which side of the pairing a model-menu GROUP belongs to, as pure
 * functions — the readable core of the browser effect
 * (src/client/effects/model-group-side.ts).
 *
 * WHY: the merged catalog (merge-streams.ts mergeModelCatalogs) appends the
 * server's provider groups everywhere, but a selection only runs on the side
 * the open session lives on — the interceptor refuses the other side. Through
 * DSH 0.1.7 every menu group carried its id in `aria-labelledby`
 * (`<useId>-<group.id>`), so CSS keyed the hiding on the `zr~` prefix (T52).
 * DSH 0.2.0 renders the groups with the primitives' MenuGroup, whose
 * `aria-labelledby` is a bare useId — the id is gone — and the same component
 * renders OTHER menus' groups too, so attribute scoping misfires in both
 * directions. Classification therefore moved to the one mark every version
 * renders: virtual group NAMES start with VIRTUAL_GROUP_NAME_MARK
 * (virtual-id.ts), read off each group's heading text.
 *
 * The container rule is what keeps the effect inert wherever it cannot be
 * sure: a container with not ONE marked heading — the model menu of a
 * sub-client with no shared models, every other menu on the page, the whole
 * rest of the page — classifies as `undefined` for every group, which the
 * effect reads as "leave the DOM alone". Only a container holding at least
 * one marked heading is decided, and inside it the unmarked groups are
 * exactly the LOCAL ones: the merged catalog only ever APPENDS virtual
 * groups to the local list, never mixes them the other way.
 *
 * Defensive like the rest of client-data: an empty or missing heading never
 * counts as a mark, so it can never decide a container by accident.
 */

import { VIRTUAL_GROUP_NAME_MARK } from '../virtual-id.ts'

/** One group's display description, as the DOM shows it. */
export interface ModelGroupHeading {
  /** Groups sharing one container share one key (the effect numbers the
   * parent elements it scans). */
  containerKey: number
  /** The group's heading text ('' when no heading could be found). */
  headingText: string
}

/** Per-group verdict, in input order: `remote` for marked headings, `local`
 * for the rest of a container that has at least one, and `undefined` —
 * "stamp nothing" — for every group of a container that holds no mark at
 * all. */
export type ModelGroupSide = 'remote' | 'local' | undefined

export function classifyModelGroups(groups: readonly ModelGroupHeading[]): ModelGroupSide[] {
  // Per container: did any heading carry the mark? Containers are decided
  // independently — one mixed model menu must not turn an all-local
  // container (a second menu elsewhere on the page) into "hide everything
  // local" there.
  const marked = new Map<number, boolean>()
  for (const group of groups) {
    const had = marked.get(group.containerKey) ?? false
    marked.set(group.containerKey, had || group.headingText.startsWith(VIRTUAL_GROUP_NAME_MARK))
  }
  return groups.map((group) =>
    marked.get(group.containerKey)
      ? group.headingText.startsWith(VIRTUAL_GROUP_NAME_MARK)
        ? 'remote'
        : 'local'
      : undefined,
  )
}
