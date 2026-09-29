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
`
