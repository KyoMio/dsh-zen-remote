// header — session-page header five-piece reflow (S2, 2026-08-17). Scoped
// entirely to (max-width: 767px) and appended LAST (after home.css.ts) so
// its rules win ties against the shared <=1023px block in layout.css.ts —
// same reasoning as home.css.ts: 768-1023px keeps the v1.0.0 drawer header
// untouched, >=1024px is a strict no-op.
//
// DOM this reflows (dsh-client-ui-conversation lib/client.js:6949-7009,
// verified live 2026-08-17 at 375px — class names below are the CURRENT
// hashed values, always targeted by suffix):
//   header                    ConversationSessionHeader root
//     div.titleRow
//       div.titleCluster        (official: a flex cluster; we flatten it)
//         nav.crumbs             breadcrumb chain, last segment = the title
//         div.headerActions      [data-slot="conversation.session.header.actions"]
//       div.headerUtilities    [data-slot="conversation.session.header.utilities"]
//     div.tabs[role="tablist"]  Chat/Trajectory, only when there is >1 view

export const HEADER_CSS = `/* ---------- session header five-piece reflow (< 768px) ---------- */

/* New elements render unconditionally (React does not know about media
   queries); default them to hidden so 768px+ never sees them, then
   re-enable inside the phone block below. Belt-and-braces alongside the
   scoped rules — mirrors the existing [data-mobile-nav="*"] desktop no-op
   list in misc.css.ts. */
[data-mobile-nav="header-back"],
[data-mobile-nav="header-viewrow"],
[data-mobile-nav="header-info"],
[data-mobile-nav="header-workbench"],
/* The workbench close pill's default-hidden used to live in compat.css.ts —
   but EVERYTHING in layout/compat/misc sits inside one shared
   (max-width: 1023px) block (opened at the top of layout, closed at the end
   of misc), so that "top-level" rule silently never applied at >=1024 and
   the pill rendered as an unstyled button on desktop (2026-08-17 report).
   This file is appended after the shared block closes, so here it is truly
   global; the <=767px :has() show rule in compat overrides it with
   !important. */
[data-mobile-nav="better-sidebar-close"] {
  display: none;
}

@media (max-width: 767px) {
  /* The Files action targeted the dsh-web-ui-all (aionui) explorer sheet —
     a different, unrelated suite from the workbench entry this slice adds
     (dsh-better-sidebar). Hidden here only; 768-1023px keeps it exactly as
     v1.0.0 shipped it. */
  [data-mobile-nav="files"] {
    display: none !important;
  }

  /* --- three-column header: [back 92px] [title, truly centered] [utilities 92px] --- */
  /* The bottom padding is the view-switch row's seat: that row is
     position:absolute (see the bottom of this file — it renders two levels
     deep inside headerActions and can never be a grid item of titleRow), so
     without a reserve it would hang over the message list. 28px = its
     height. Unconditional rather than header:has([data-mobile-nav=
     "header-viewrow"]) on purpose: :has() is silently dropped by pre-105
     WebViews (see AGENTS.md) and a 28px overlap on the first message is a
     worse failure than 28px of empty band in the (never observed in
     practice) single-view session. Total header chrome: 48 + 28 = 76px.
     Left/right 8px (S2.1 report leftover, fixed in S4): the official header
     had zero horizontal padding, so the utilities button cluster's right
     edge sat flush against the screen edge (x=390 at 390px width, no
     margin). The 92px grid columns absorb this fine — they're fixed track
     widths, only the center 1fr column shrinks by 16px. */
  [data-phase] header {
    position: relative;
    padding: 0 8px 28px !important;
  }
  /* No header bottom line — fade instead (real-device round 2, 2026-08-17).
     The official header draws its border as a \`::after\` 1px bar (the
     \`border-bottom\` on the header itself is transparent, just a layout
     reserve — dsh-client-ui-conversation lib/client.js ".wSkVaW_header{
     border-bottom:1px solid #0000}.wSkVaW_header:after{...height:1px;
     position:absolute;bottom:1px...}", verified live 2026-08-17), so
     hiding the pseudo-element is enough; the header's own border-bottom
     never had a visible color to begin with. The message scroller now
     fades in from under the header instead (styles/composer.css.ts, "no
     divider above OR below the message list" — the two edges share one
     mask-image on [class$="_scrollBody"]). */
  [data-phase] header::after {
    display: none !important;
  }
  /* grid-row: 1 on every item is load-bearing, not decoration (S2.1 fix for
     the "标题被挤下去" report). The three items are placed with explicit
     grid-column but arrive in DOM order crumbs(2) → headerActions(1) →
     headerUtilities(3): sparse auto-placement never moves its cursor
     backwards, so headerActions and headerUtilities were pushed onto an
     implicit SECOND row. Measured at 390px: row1 = crumbs 28px, row2 =
     back button 44px, titleRow = 72px with the title stuck at the top
     instead of centered. Pinning the row makes it one 48px band again. */
  [data-phase] header [class$="_titleRow"] {
    position: relative;
    display: grid;
    grid-template-columns: 92px 1fr 92px;
    grid-template-rows: minmax(48px, auto);
    align-items: center;
    min-height: 48px;
    padding: 0 !important;
  }
  /* Flatten the official cluster so its two children (crumbs, headerActions)
     become direct grid items of titleRow instead of a nested flex box. */
  [data-phase] header [class$="_titleCluster"] {
    display: contents;
  }
  /* margin-left: 0 cancels layout.css.ts's shared <=1023px
     "margin-left: auto !important" on this exact selector (it pushed the
     Files button to the row's right edge in the old non-grid header;
     inside our grid column it instead shoves the back button 48px right of
     the column's start — the auto margin absorbs the leftover space
     between the button's content width and the 92px column). */
  [data-phase] header [class$="_headerActions"] {
    grid-column: 1;
    grid-row: 1;
    justify-self: start;
    margin-left: 0 !important;
    display: flex;
    align-items: center;
    min-width: 0;
  }
  /* layout.css.ts's shared <=1023px block hides this element outright
     (header > :first-child > :last-child { display: none !important },
     specificity (0,3,1) — v1.0.0 relocated the desktop Session-log capsule
     to the drawer footer on every narrow width). That selector is repeated
     here at equal specificity so the later source order wins the display
     property; the class-suffix selector alone (0,2,1) would silently lose. */
  [data-phase] header [class$="_headerUtilities"],
  [data-phase] header > :first-child > :last-child {
    grid-column: 3;
    grid-row: 1;
    justify-self: end;
    display: flex !important;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  /* justify-self: stretch (the grid default) so this fills the whole 1fr
     column as a definite-width box — center/center-content happens inside
     it. justify-self: center (tried first) sizes the item to its content
     with no automatic column cap, and the obvious fix — max-width: 100% —
     resolves against the WRONG box here (measured 93.6px at 390px, where
     the column is ~206px): the item's DOM parent (titleCluster) is
     display:contents, and percentage max-width does not reliably resolve
     through a boxless ancestor to the grid track. Stretching sidesteps the
     percentage entirely — but layout.css.ts's shared <=1023px block ALSO
     caps this exact selector at max-width: 24vw !important (93.6px at
     390px — the value this rule used to silently inherit once its own
     max-width was dropped in favor of stretch), so that must be reset to
     none here too. */
  [data-phase] header [class$="_crumbs"] {
    grid-column: 2;
    grid-row: 1;
    justify-self: stretch;
    max-width: none !important;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    overflow: hidden;
  }
  /* Subagent sessions keep ONE ancestor crumb (2026-08-18): the PC header
     lets you tap the parent session's title to switch back — that affordance
     was lost on phone when the whole parent chain was hidden as "多余项".
     Show only the immediate parent (for agent-teams member sessions that IS
     the captain/main session; deeper ancestors stay hidden — a 3-level chain
     cannot fit the ~206px center column at 390px). The parent crumb is the
     official breadcrumb <button> (dsh-client-ui-conversation renders
     open(parentId) as its onClick), so tapping needs no JS from this plugin,
     and main sessions (chain length 1) have no :nth-last-child(2) seg at
     all — the centered single title is pixel-identical to before. */
  [data-phase] header [class$="_crumbSeg"]:not(:nth-last-child(-n+2)) {
    display: none !important;
  }
  [data-phase] header [class$="_crumbSeg"]:nth-last-child(2) {
    display: inline-flex;
    align-items: center;
    flex: none;
    min-width: 0;
    max-width: 38%;
  }
  /* Ancestors BEFORE the parent seg are hidden, which would leave the
     parent seg's own leading "/" dangling at the start of the title. */
  [data-phase] header [class$="_crumbSeg"]:nth-last-child(2) [class$="_crumbSep"] {
    display: none !important;
  }
  /* Parent crumb: small tertiary text so the 19px current title stays the
     visual anchor; min-height keeps a finger-sized target inside the 48px
     row. Specificity (0,4,1) outranks the shared 19px _crumb rule below. */
  [data-phase] header [class$="_crumbSeg"]:nth-last-child(2) [class$="_crumb"] {
    font-size: 13px;
    font-weight: 400;
    color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, .45));
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    padding: 0 2px 0 6px;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-phase] header [class$="_crumbSeg"]:last-child {
    display: flex;
    align-items: center;
    min-width: 0;
    max-width: 100%;
  }
  /* The last seg's own "/" is the divider between parent and current title —
     it only exists when there IS an ancestor (index > 0), so it can simply
     stay visible now that the parent seg shows. (It used to be hidden here:
     with the parent hidden it dangled before the title.) */
  /* BOTH selectors are required: [class$=] matches the whole class
     ATTRIBUTE's suffix, and the current-session title button's attribute is
     "wSkVaW_crumb wSkVaW_crumbCurrent" — it ends in _crumbCurrent, so the _crumb
     suffix selector alone silently missed the one element that matters
     (measured live: the title stayed 14px while the rule sat in the bundle,
     2026-08-17). */
  [data-phase] header [class$="_crumb"],
  [data-phase] header [class$="_crumbCurrent"] {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    max-width: 100%;
    /* Real-device feedback (2026-08-17): the session title read too small
       next to the enlarged header icons — 19px sits just under the home
       screen's 22px workspace title, keeping the two-level hierarchy. */
    font-size: 19px;
    font-weight: 600;
  }

  /* Running-status dot: no official element to reposition (the header
     renders only the crumb title, the two action slots, and the tablist —
     no status indicator), so this is the plan's documented fallback —
     read the data ourselves and draw it (effects/header-status.ts stamps
     data-mobile-nav-dot on the frame). A ::after on the title crumb keeps
     it truly inline with the (centered, truncated) text instead of a
     separately positioned box that would fight the centering math. */
  [data-phase] header [class$="_crumbCurrent"]::after {
    content: '';
    display: none;
    width: 6px;
    height: 6px;
    margin-left: 6px;
    border-radius: 50%;
    vertical-align: middle;
  }
  [data-mobile-nav="frame"][data-mobile-nav-dot] header [class$="_crumbCurrent"]::after {
    display: inline-block;
  }
  [data-mobile-nav="frame"][data-mobile-nav-dot="ongoing"] header [class$="_crumbCurrent"]::after {
    background: var(--dsw-alias-state-business-primary, #4f6ef7);
  }
  [data-mobile-nav="frame"][data-mobile-nav-dot="warning"] header [class$="_crumbCurrent"]::after {
    background: var(--dsw-alias-state-warn-primary, #d97706);
  }
  [data-mobile-nav="frame"][data-mobile-nav-dot="done"] header [class$="_crumbCurrent"]::after {
    background: var(--dsw-alias-state-success-primary, #16a34a);
  }

  /* Everything else the official header puts in these two list slots — the
     agent-preset mode badge, the jobs/subagent trigger, the desktop
     Session-log download capsule, and this plugin's own legacy directory
     toggle — is the "不常驻" set the design defers to the S4 info card.
     Scoped by the slots' own [data-slot] wrapper (a stable, non-hashed
     contract marker) rather than enumerating each registrant, so a future
     third-party header action is hidden by default too. */
  [data-phase] header [data-slot="conversation.session.header.actions"] > *,
  [data-phase] header [data-slot="conversation.session.header.utilities"] > * {
    display: none !important;
  }
  /* The agent-preset mode badge specifically survives the blanket hide
     above: layout.css.ts's shared <=1023px block targets it directly
     (header [class$="_label"]:has(> svg) { display: block !important }),
     specificity (0,3,1), higher than the [data-slot] wrapper rule (0,2,1) —
     display wins on specificity before source order, so a same-selector
     override is needed here too. */
  [data-phase] header [class$="_label"]:has(> svg) {
    display: none !important;
  }
  [data-phase] header [data-slot="conversation.session.header.actions"] > [data-mobile-nav="header-back"] {
    display: inline-flex !important;
  }
  /* header-viewrow is position:absolute (see below), so its re-shown
     display value must match the flex layout its own rule declares. */
  [data-phase] header [data-slot="conversation.session.header.actions"] > [data-mobile-nav="header-viewrow"] {
    display: flex !important;
  }
  [data-phase] header [data-slot="conversation.session.header.utilities"] > [data-mobile-nav="header-info"],
  [data-phase] header [data-slot="conversation.session.header.utilities"] > [data-mobile-nav="header-workbench"] {
    display: inline-flex !important;
  }

  /* Back button: 44pt touch target, leftmost column. */
  [data-mobile-nav="header-back"] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--dsw-alias-label-primary, inherit);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="header-back"]:active {
    opacity: .6;
  }

  /* Info + workbench utility buttons, rightmost column. */
  [data-mobile-nav="header-info"],
  [data-mobile-nav="header-workbench"] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--dsw-alias-label-secondary, inherit);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="header-info"]:active,
  [data-mobile-nav="header-workbench"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }
  /* Icon family unification (real-device round 2, 2026-08-17): the ⓘ text
     glyph is gone (MobileSessionHeader.tsx now renders IconInfoOutline16,
     a local 16px SVG built to match the primitives icon family) and the
     workbench button's IconPanelLeftOutline16 is mirrored into a
     panel-RIGHT glyph — there's no IconPanelRightOutline16 in primitives
     (checked lib/types/icons/index.d.ts), and the plugin's own right-side
     panel semantics are exactly the left icon flipped. Both buttons now
     carry a same-size (16px), same-stroke-weight icon. */
  [data-mobile-nav="header-workbench"] svg {
    transform: scaleX(-1);
  }

  /* Official Chat/Trajectory tablist: removed from layout entirely (S2.1 —
     visibility:hidden still held a 27px row, so the header carried the
     view-switch row's band TWICE: 72 + 27 + gap = 104px measured at 390px,
     and a real iPhone added ~54px of notch on top of that). The header's own
     padding-bottom above is now the row's seat.
     display:none does NOT break the view switch: HTMLElement.click()
     dispatches synthetically and fires React's handler regardless of
     rendering — only real pointer hit-testing needs a box, and this plugin
     never relies on it (MobileSessionHeader always calls .click()). */
  [data-phase] header [class$="_tabs"][role="tablist"] {
    display: none;
  }

  /* View-switch row: "current view name + dots", replacing the (still
     present, still clickable) official tablist visually. It renders inside
     headerActions/headerUtilities, but titleRow's own position:relative
     (set above) makes IT the containing block for absolute descendants —
     display:contents on titleCluster does not break that search — so
     top:100% sits directly under the title regardless of the title row's
     actual height, with no hardcoded offset to keep in sync. */
  [data-mobile-nav="header-viewrow"] {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 28px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-family: inherit;
    font-size: 13px;
    line-height: 18px;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="header-viewrow-dots"] {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  [data-mobile-nav="header-viewrow-dots"] > i {
    display: block;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    opacity: .35;
    font-style: normal;
  }
  [data-mobile-nav="header-viewrow-dots"] > i[data-active] {
    opacity: 1;
  }
}
`
