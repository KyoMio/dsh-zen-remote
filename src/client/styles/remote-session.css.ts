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

/* ---------- remote session: hide the session-export entry (T51) ----------
   A remote session's log lives on the relay server and the backend refuses
   /api/session.export for a virtual id with 403 remote-unsupported
   (fetch-route-intercept.ts) — the button would only ever end in the
   "Export failed" modal, so it is hidden instead. The anchor is the export
   package's "more actions" button: RT dsh-session-log-export lib/client.js
   ~195-228 renders the Menu with the Button carrying the
   HeaderAction.module.css class (compiled "JRpPLa_moreButton", applied at
   ~219) inside the slot anchor div[data-slot=…] the slot renderer itself
   emits (RT dsh-client-ui-renderer lib/client.js ~1093-1104). The class
   SUFFIX is matched the way compat.css.ts matches module classes — the hash
   prefix is build-local, the "_moreButton" tail is the source name — and
   within this slot it is unique: the only other moreButton in the RT tree
   (dsh-client-ui-sidebar-documentpreview lib/client.excel.js) lives in the
   sidebar, never under conversation.session.header.utilities.
   Known cost, accepted: the same button also opens the menu's 反馈 entry, so
   feedback goes with it while the session is remote — a feedback sheet over
   a session whose content is server-side could not be answered locally
   anyway. */
html[data-zr-remote-session="1"] [data-slot="conversation.session.header.utilities"] [class$="_moreButton"] {
  display: none !important;
}
`
