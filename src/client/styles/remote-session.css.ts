// Remote-session entry hiding (T41b). Separate from MOBILE_CSS on purpose:
// the phone stylesheet is injected behind apply's desktop gate, while these
// rules must hold on every sub-client surface (phone browser, desktop-width
// browser, desktop app) — they are keyed on the html-level remote-session
// attribute, which only a virtual (relay) session ever sets, so a host-role
// deployment never matches any of them.
//
// T53 extends the same file instead of styles/compat.css.ts for that exact
// reason: the compat section rides MOBILE_CSS, which apply injects only AFTER
// the isDesktopShell() gate (src/client/index.tsx) — a desktop app acting as
// a paired sub-client would never see compat rules, and dsh-better-sidebar's
// file surfaces are exactly the things a desktop sub-client must not see. The
// writing conventions stay the compat section's: anchor on the plugin's own
// mount markers / rendered data attributes, never on hashed class names, so
// with dsh-better-sidebar absent not one selector matches.

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

/* ---------- remote session: hide dsh-better-sidebar's file surfaces (T53) ----------
   dsh-better-sidebar 0.24.x is the second big "open the machine's files" UI.
   Every tab it registers (files/editor, git changes, subagent/tasks, side
   chat, the markdown/html/code file viewers) builds its requests from a
   {sessionId, cwd} scope and POSTs them to the plugin's own /sidebar/api/*
   routes on whichever machine answers — in a remote session that is the
   SUB-CLIENT's machine (client.js call() ~3111, fetchUpload ~3162,
   encodeHtmlUrl /sidebar/html/ ~3069-3414), so the tree would show same-named
   LOCAL files as if they were the session's and an edit would WRITE locally.
   Per the T53 decision the interfaces are hidden, not proxied: the relay
   carries no /sidebar routes and none are added.

   Anchors, all the plugin's or the host's own rendered contracts (no hashed
   class names; the one suffix selector, _chipIcon, is unique among the
   profile's packages — checked dsh-vision-router / dsh-auto-approve /
   dsh-mem0 / dsh-llm-verifier / dsh-plugin-subscriptions /
   @liustack/modsearch / @wxg-prc-cpg/browser-skill-dsh-plugin (modsearch /
   browser-skill) / dshmarket and every @deepseek-ai sidebar package for it):

   HONEST LIMITS (T53-fix): everything here is display:none ONLY. The plugin's
   components stay mounted and keep silently POSTing READ-ONLY /sidebar/api
   requests to the local machine (session.cwd, changes.ops, the tree reads a
   mounted tab refreshes with) — the data never leaves that machine, and no
   write can happen because every write control is inside the hidden surfaces.
   Known boundary: a dsh-resource://file/** address opened through
   sidebarRight.openResource in a remote session (file links in chat,
   deliverables, @-references, skills) is CLAIMED by the plugin's editor
   registration (client.js ~21377: patterns ["dsh-resource://file/**"]) before
   the host preview sees it — the right sidebar expands, the rules below hide
   the tab's body and chip, and an EMPTY panel remains. Root fix needs
   zen-remote's own remote file tree; separate discussion.

   - [data-dsh-bottom-toggle] — the header-utilities button that expands the
     bottom workbench (client.js BottomDockToggle ~20863; slot registration
     ~21492-21498, id dsh-better-sidebar:bottom-toggle). Our own phone header
     button drives the OFFICIAL right sidebar (MobileSessionHeader.tsx), so
     hiding this does not strand the phone.
   - [data-dsh-panel-host] — the fixed viewport layer the plugin appends to
     document.body (client.js ~20763); the bottom workbench panel
     ([data-dsh-bottom-panel]) is its only child, so hiding the layer hides
     the workbench whole (tab strip, + menu, tree, editor and all).
   - --dsh-sidebar-height — the plugin's layout push: written INLINE on <html>
     while the workbench is open (client.js writeGeometry ~20482-20488) and
     spent by its own layout.css as the center column's margin-bottom
     (client.js layout css ~23009: #root [data-dsh-center-col] { margin-bottom:
     var(--dsh-sidebar-height, 0px) }). Hiding the panel alone would leave
     that reserved band as a blank strip under the conversation, so the remote
     html zeroes the variable. A stylesheet !important beats a non-important
     inline style, and the plugin's JS state is never touched: the moment the
     attribute is removed (back on a local session) its own value applies
     again, transitions included.
   - [data-dsh-native-tab-host] — the wrapper the plugin renders around EVERY
     tab body it contributes to the host's native right Sidebar
     (client.js NativeTabBody ~21074, marker ~21110/21120). The host's pane
     chrome is untouched: the strip keeps the "+" (guide) button and the
     collapse/fullscreen controls, so a tab that was already open leaves no
     dead panel — an empty body behind a strip that still collapses, and the
     "+" re-opens the guide page (whose plugin capsules these rules hide, see
     below). React keeps mounting into the display:none node: no errors, and
     the restore on returning to a local session is instant.
   - [data-dockkit-tab]:has([class$="_chipIcon"]) — the native tab STRIP's
     chips for plugin tabs, so an already-open tab does not survive as a
     clickable ghost. The chip button is dockkit's ([data-dockkit-tab], dsh-web
     frontend bundle: role=tab, renderTabTitle inside a
     span[data-dockkit-tab-title]); its content is the plugin's
     NativeTabTitle (~21172-21197), which always leads with a
     [class$="_chipIcon"] glyph span because every built-in descriptor ships an
     icon — a chip with no glyph (an external tab registered through the
     plugin's viewer service without an icon) keeps its chip; its body is
     still hidden by the rule above. Host tabs' chips never contain a
     _chipIcon (checked all four @deepseek-ai sidebar packages), so the
     remote-aware host files page survives alongside.
   - [data-floating-window]:has([data-window-body]) — the plugin's
     body-PORTALED floating windows (client.js FloatingWindow ~15078-15120):
     the task edit window (teams.taskCreate/Update with rootSessionId via
     /sidebar/api, writeTask ~3124-3140) and the job-output window (host jobs
     kill). Both open from the subagent/tasks tab; portal escapes the tab
     body's display:none, so they need their own rule. Anchored on the
     window's own root attribute plus its own inner body marker, so a foreign
     [data-floating-window] without that shape never matches.
   - guide capsules — the empty-sidebar doorway buttons the HOST renders from
     the plugin's registrations ([data-sidebar-right-guide-entry="<kind>"], RT
     dsh-client-ui-sidebar-right lib/client.js:466): kinds git / subagent /
     sidechat exist only while this plugin registers them, so those selectors
     are inert without it. The "files" capsule is the one ambiguous kind:
     dsh-client-ui-sidebar-files registers the SAME kind (its filesDefinition,
     lib/client.js:14-31) and that page is REMOTE-AWARE (it injects the host's
     remote.workspaceFiles service). T53-fix discriminates on the capsule's
     own rendered contract instead of plugin presence: the host's EntryBox
     renders aria-keyshortcuts from the shortcut matching entry.commandId (RT
     sidebar-right lib/client.js:461-467) — the host files guide row carries
     commandId "workspace.files" (dsh-client-ui-sidebar-files
     lib/client.js:30), while better-sidebar's guide rows carry NO commandId
     (client.js registerNativeSurface ~21385-21400), so its capsule never
     renders the attribute. :not([aria-keyshortcuts]) therefore hides the
     plugin's takeover capsule and spares the host's wherever the host has a
     default binding. Boundary: that "wherever" is not everywhere — the host
     registers workspace.files defaults for desktop:macos/windows/linux and
     web:macos/windows only (dsh-client-ui-sidebar-files lib/client.js:949-977),
     so on any other platform the OFFICIAL capsule also renders without the
     attribute and this rule hides it too (cosmetic; the page stays reachable
     through its shortcut command path and the plugin's takeover is the
     "files" implementation on every deployment this plugin pairs with
     better-sidebar anyway). */
html[data-zr-remote-session="1"] [data-dsh-bottom-toggle] {
  display: none !important;
}
html[data-zr-remote-session="1"] [data-dsh-panel-host] {
  display: none !important;
}
html[data-zr-remote-session="1"] {
  --dsh-sidebar-height: 0px !important;
}
html[data-zr-remote-session="1"] [data-dsh-native-tab-host] {
  display: none !important;
}
html[data-zr-remote-session="1"] [data-dockkit-tab]:has([class$="_chipIcon"]) {
  display: none !important;
}
html[data-zr-remote-session="1"] [data-floating-window]:has([data-window-body]) {
  display: none !important;
}
html[data-zr-remote-session="1"] [data-sidebar-right-guide-entry="git"],
html[data-zr-remote-session="1"] [data-sidebar-right-guide-entry="subagent"],
html[data-zr-remote-session="1"] [data-sidebar-right-guide-entry="sidechat"] {
  display: none !important;
}
html[data-zr-remote-session="1"] [data-sidebar-right-guide-entry="files"]:not([aria-keyshortcuts]) {
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
