// Remote-session entry hiding (T41b). Separate from MOBILE_CSS on purpose:
// the phone stylesheet is injected behind apply's desktop gate, while these
// rules must hold on every sub-client surface (phone browser, desktop-width
// browser, desktop app) — they are keyed on the html-level remote-session
// attribute, which only a virtual (relay) session ever sets, so a host-role
// deployment never matches any of them.

export const REMOTE_SESSION_CSS = `/* ---------- remote session: hide the open-on-the-server-machine entries ----------
   A remote session's files live on the relay SERVER; every "open" control here
   would act on the machine the DSH process runs on, not the one the browser is
   on. Hidden while the current session is remote (html[data-zr-remote-session]):
   - [data-open-target] is dsh-client-ui-open-in-app's own mount marker (RT
     dsh-client-ui-open-in-app lib/client.js ~325: the split-button anchor
     React renders with data-open-target={kind}) — one selector covers the
     session-header "Open In..." button, the document-preview actions, AND the
     "Open / Show in Finder / Choose an application" buttons of the changes
     panel and the deliverable cards (RT dsh-client-ui-deliverables
     lib/client.js ~1702, ~1963: those cards render the open-in-app package's
     FileRouteAction through the deliverables.file.actions and
     deliverables.review.file.actions slots, the same OpenTargetButton anchor).
     The attribute is the component's own contract, not a generated class. */
html[data-zr-remote-session="1"] [data-open-target] {
  display: none !important;
}

/* ---------- remote session: hide the session-export menu item (T51, T51-fix) ----------
   A remote session's log lives on the relay server and the backend refuses
   /api/session.export for a virtual id with 403 remote-unsupported
   (fetch-route-intercept.ts) — the item would only ever end in the "Export
   failed" modal, so it is hidden IN THE MENU (T51-fix: the anchor button
   stays, because it also opens the 反馈 entry, which a remote session can
   still use). The DOM, verified against RT:
   - the Menu renders its anchor and its list as SIBLINGS inside its own
     span root (RT dsh-client-ui-primitives lib/index.js ~4265-4273:
     children = [anchor, portal ? createPortal(list) : list]), and the
     export Menu passes no portal flag (default false, ~3923) — so the list
     is the anchor's next sibling, matched by the general-sibling
     combinator below;
   - the list surface carries role="menu" (Menu passes it at ~4243;
     MenuSurface spreads ...props onto its root div, ~3778-3795) and the
     items viewport inside it is div[role="presentation"] (~4249-4252);
   - every data item is ONE div (the itemWrap wrapper, ~4143), so
     :first-child of the viewport is the FIRST item — and the export
     package puts 下载/导出 first by construction (RT dsh-session-log-export
     lib/client.js 202-206, the optional feedback entry appended after at
     207-211).
   The anchor button class suffix is matched the way compat.css.ts matches
   module classes (the hash prefix is build-local, "_moreButton" is the
   source name; unique in this slot — the only other moreButton in the RT
   tree, dsh-client-ui-sidebar-documentpreview lib/client.excel.js, lives in
   the sidebar, never under conversation.session.header.utilities).
   Known costs, accepted: with the feedback UI absent the menu's only item
   is the export, so the opened menu is EMPTY; and keyboard navigation still
   steps into the hidden item (focusable but invisible) until activated or
   escaped — it cannot be triggered through the visibility, only tabbed
   past blindly. */
html[data-zr-remote-session="1"] [data-slot="conversation.session.header.utilities"] [class$="_moreButton"] ~ [role="menu"] > [role="presentation"] > :first-child {
  display: none !important;
}
`
