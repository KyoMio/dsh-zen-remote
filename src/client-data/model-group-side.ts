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

import { VIRTUAL_GROUP_NAME_MARK, decodeServerIdZeroWidth } from '../virtual-id.ts'

/** MS-4: the <html> attribute carrying the open REMOTE session's server id
 * (`zr~<serverId>~…`'s middle half). Written by effects/remote-session.ts
 * together with `data-zr-remote-session`, read by
 * effects/model-group-side.ts as the `activeRemoteServerId`. */
export const REMOTE_SERVER_ATTRIBUTE = 'data-zr-remote-server'

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
 * all. MS-4 adds `remote-other`: with a session's own server id known
 * ({@link classifyModelGroupsForSession}'s `activeRemoteServerId`), a
 * marked group whose DECODED server id is a DIFFERENT paired server — the
 * model menu must show only the models of the server the open session
 * lives on. */
export type ModelGroupSide = 'remote' | 'local' | 'remote-other' | undefined

export function classifyModelGroups(groups: readonly ModelGroupHeading[]): ModelGroupSide[] {
  return classifyModelGroupsForSession(groups)
}

/**
 * The MS-4 extension: with `activeRemoteServerId` set (the `zr~<serverId>~`
 * half of the session the browser has open, effects/remote-session.ts),
 * each marked heading's embedded server id (decodeServerIdZeroWidth)
 * decides between plain `remote` (the open session's own server, or a
 * heading whose server cannot be decoded — shown, never hidden) and
 * `remote-other` (a DIFFERENT paired server's group — hidden in a remote
 * session by remote-session.css.ts). Without the argument the verdicts
 * are exactly {@link classifyModelGroups}'s — the single-paired-server
 * behavior, byte for byte.
 */
export function classifyModelGroupsForSession(groups: readonly ModelGroupHeading[], activeRemoteServerId?: string): ModelGroupSide[] {
  // Per container: did any heading carry the mark? Containers are decided
  // independently — one mixed model menu must not turn an all-local
  // container (a second menu elsewhere on the page) into "hide everything
  // local" there.
  const marked = new Map<number, boolean>()
  for (const group of groups) {
    const had = marked.get(group.containerKey) ?? false
    marked.set(group.containerKey, had || group.headingText.startsWith(VIRTUAL_GROUP_NAME_MARK))
  }
  return groups.map((group) => {
    if (!marked.get(group.containerKey)) return undefined
    if (!group.headingText.startsWith(VIRTUAL_GROUP_NAME_MARK)) return 'local'
    if (activeRemoteServerId !== undefined) {
      const groupServerId = decodeServerIdZeroWidth(group.headingText)
      if (groupServerId !== undefined && groupServerId !== activeRemoteServerId) return 'remote-other'
    }
    return 'remote'
  })
}
