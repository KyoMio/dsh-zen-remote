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

/* ---------- T52: model-menu groups follow the session's side ----------
   The model catalog is GLOBAL (one shared load per page), so the merged
   catalog shows the server's groups everywhere; but a selection is only
   runnable on the side the open session lives on — the interceptor refuses
   the other side with a clear message. Hide what cannot run, by the one
   stable mark the menu carries:
   - the model menu renders one section[role="group"] per provider group
     with aria-labelledby="<useId>-<group.id>" (RT dsh-client-ui-model-
     selection lib/client.js:830-835), so a VIRTUAL group's section carries
     the "zr~" prefix in that attribute — an attribute the component itself
     writes, like data-open-target above;
   - the menu is a portal under <body>, but <html> is still its ancestor,
     so the html-level session attribute scopes it with no host-depth
     assumption and no :has();
   - the [role="menu"] scope keeps the rule inside dropdown menus (where the
     model picker lives); if DSH ever drops the aria mark the rule simply
     stops matching — the interceptor's refusals remain the backstop.
     In a remote session only the server's groups stay; otherwise only the
     local ones (the home page and dialogs read as local, which is right:
     the model picker only mounts inside a session, and a blank local
     session cannot run server models either). */
html[data-zr-remote-session="1"] [role="menu"] section[role="group"]:not([aria-labelledby*="zr~"]) {
  display: none !important;
}
html:not([data-zr-remote-session]) [role="menu"] section[role="group"][aria-labelledby*="zr~"] {
  display: none !important;
}

/* ---------- T52-fix: hide the virtual groups in NATIVE <option> pickers ----
   The model menu above is React DOM, but dsh-vision-router's settings render
   its vision-backend picker as a native <select> of <option value={group.id}>
   rows, and its filter (dsh-vision-router lib/client.js:661-670
   filterVisionBackendGroups) drops only vision-http / vision-chain / *-vision
   — a merged virtual group ("zr~<id>~…") survives into that picker even
   though a server model can never be a LOCAL vision backend (the router calls
   providers from the machine it runs on). Native <option> rows honor
   display:none in the dropdown list, so this hides them wherever they appear:
   - no scoping attribute on purpose: a virtual group is not a runnable
     backend in ANY local context, and the option element itself carries the
     value — no host-depth assumption, no :has();
   - when the vision router (or any other <option>-rendering surface) is not
     installed, nothing matches — dead rule, zero cost;
   - zen-remote's own surfaces are checked: our settings forms render fixed
     enum options ("web" / "desktop-client" / role kinds /
     configForm enum strings, src/client/settings/SettingsSection.tsx:641,690-701)
     and none can start with "zr~" (virtual group ids only ever exist inside
     model-catalog payloads and model-selection arguments). */
option[value^="zr~"] {
  display: none !important;
}
`
