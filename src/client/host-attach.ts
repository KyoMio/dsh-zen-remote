import { useLayoutEffect, useState } from 'react'

/**
 * The host composer's own hidden file picker, when the running DSH ships one.
 *
 * DSH 0.1.5 grew a native attachment flow (dsh-attachment / dsh-client-file-
 * upload): the official tool row carries a second `_add` paperclip whose click
 * drives an `<input type="file" hidden>` that is a DIRECT sibling of the
 * buttons inside `_tools`. That input is the one structural, locale-free
 * proof that the host implements composer attachment upload — the button
 * itself can only be told apart from the "+" command menu by its localized
 * aria-label, and the capability prop (`addFiles`) lives on the composer
 * bar's own inject face, which never reaches `conversation.input.left`
 * registrants. Scoped to `_tools` children so a third-party plugin parking
 * its own file input somewhere else in the composer cannot be misread as
 * the official feature; `:not([data-mobile-nav])` keeps OUR picker
 * (`attach-picker`) out of the match.
 */
export const HOST_ATTACH_INPUT =
  '[data-slot="conversation.composer.bar"] [class$="_tools"] > input[type="file"]:not([data-mobile-nav])'

/** Synchronous read: does this host's composer ship its own attach picker? */
export function hostAttachPresent(): boolean {
  return document.querySelector(HOST_ATTACH_INPUT) !== null
}

/**
 * True while OUR attachment UI should mount (the host has none of its own).
 *
 * The rule this encodes (2026-09-11): where the host implements attachment
 * upload, the phone composer shows exactly ONE attach control — the host's —
 * and this plugin's S7 button and chips row stand down; on a host without
 * one (DSH ≤ 0.1.2), both load as they always have.
 *
 * `useLayoutEffect`, not `useEffect`: on the composer's very first mount our
 * slot child renders in the same React pass as the host's tool row, so the
 * state initializer below reads the DOM BEFORE either exists — the layout
 * effect re-checks after the commit and before the browser paints, so the
 * demotion to hidden (or, on an old host, the decision to stay) never
 * reaches the screen as a flash. The MutationObserver covers the lifetime
 * after that: the picker's existence only really changes with the page, but
 * a dynamic host plugin or a reload must not strand a stale verdict.
 */
export function useOwnAttachUi(): boolean {
  const [own, setOwn] = useState(() => !hostAttachPresent())
  useLayoutEffect(() => {
    const check = (): void => setOwn(!hostAttachPresent())
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    check()
    return () => observer.disconnect()
  }, [])
  return own
}
