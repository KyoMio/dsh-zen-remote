// chips — S5 (2026-08-17): the home-screen plugin-entry chips row, its
// customize sheet, the settings gear button, and the settings/usage-stats
// dialog portal fix. Appended LAST in index.ts (after home.css.ts) so its
// `display` overrides win any tie against the phone shell's blanket
// `[data-mobile-nav="frame"] > :first-child { display: none }` rule — though
// the extra `:has()` clause already outranks it on specificity alone.

export const CHIPS_CSS = `/* ---------- chips row + settings entry (S5) ---------- */

@media (max-width: 767px) {
  /* --- settings dialog / usage-stats panel / scheduled-tasks dialog portal fix ---
     dsh-client-ui-settings-general's SettingsRoot (trigger button +
     position:fixed;z-index:1000 modal), dsh-usage-stats' sidebar-footer
     badge (position:fixed panel), and @opendsh/dsh-plugin-scheduled-tasks'
     "定时任务" trigger (position:fixed;z-index:120 \`.dshst-overlay\`,
     verified against 0.2.0 — real-device report 2026-08-17: chip click
     produced no visible window) all mount as PLAIN CHILDREN of the sidebar
     tree — not a React portal to document.body — inside
     sidebar.settings / sidebar.footer.action
     (dsh-client-ui-sidebar's SidebarRoot: footArea > settingsArea /
     footerActions). home.css.ts sets the sidebar ROOT
     (\`[data-mobile-nav="frame"] > :first-child\`) to display:none on the
     phone breakpoint (the app shell replaced the drawer) — and display:none
     removes the WHOLE subtree from the render tree, including
     position:fixed descendants, which cannot escape it the way they escape
     a merely-offscreen or opacity:0 ancestor. A \`.click()\` on the (still
     DOM-present) hidden trigger still flips its component-local \`open\`
     state and mounts the aria-modal dialog (synthetic dispatch bypasses
     hit-testing — S2.1 precedent), but nothing paints without this fix.

     Un-hiding the WHOLE sidebar would surface the session tree / new-session
     button underneath the dialog, so this is scoped to exactly the sidebar
     root plus its OWN direct children that are not on the path to
     footArea: display:contents on the root removes its own box (no
     duplicate page background/padding, no grid-column reflow) while
     letting footArea/footerActions/settingsArea resume their OWN official
     (non-none) display — logoRow / newSession / regionArea are hidden
     explicitly instead. :has() matches against the DOM tree regardless of
     the scope element's own computed display, so this reads correctly even
     though the whole subtree started at display:none (same precedent as
     every other :has()-gated rule in this stylesheet, e.g. the settings
     sheet adaptation below, which depends on exactly this becoming
     visible).

     \`:first-child\` is a layout-column WRAPPER
     (\`pI_x6G_sidebarCol\`, dsh-client-ui-layout's AppFrame grid cell), not
     SidebarRoot's own div — SidebarRoot (\`hHd-Xa_root\`) sits one more empty
     unstyled div below it (measured 2026-08-17: sidebarCol > div (no
     class) > div.hHd-Xa_root > logoRow/newSession/regionArea/footArea).
     display:contents on sidebarCol lets that whole chain resume its own
     official (non-none) display with no other rule needed, but the
     "hide the other three" selectors below must therefore be DESCENDANT
     (unscoped depth), not direct-child \`>\`, or they silently match
     nothing — confirmed live: an earlier \`>\`-only version left
     logoRow/newSession/regionArea at \`display: flex\`, which is only
     hidden from view by being fully underneath the usage-stats panel's
     opaque body, not by this rule. */
  [data-mobile-nav="frame"] > :first-child:has([aria-modal="true"], [data-usage-stats-panel], .dshst-overlay) {
    display: contents !important;
  }
  [data-mobile-nav="frame"] > :first-child:has([aria-modal="true"], [data-usage-stats-panel], .dshst-overlay) [class$="_logoRow"],
  [data-mobile-nav="frame"] > :first-child:has([aria-modal="true"], [data-usage-stats-panel], .dshst-overlay) [class$="_newSession"],
  [data-mobile-nav="frame"] > :first-child:has([aria-modal="true"], [data-usage-stats-panel], .dshst-overlay) [class$="_regionArea"] {
    display: none !important;
  }

  /* Home-top settings gear: 44pt touch target, pushed to the row's end by
     its own auto margin (home-top itself stays a plain flex row). */
  [data-mobile-nav="home-settings"] {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    margin-left: auto;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--dsw-alias-label-secondary, inherit);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="home-settings"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    border-radius: 50%;
  }

  /* Plugin-entry chips row: one horizontally-scrolling line of 34px pills
     between the workspace title and the session list (prototype spec).
     Scrollbar hidden on BOTH engines (2026-08-18 user decision): iOS
     overlay scrollbars never showed anyway, but desktop browsers painted a
     permanent 2px strip under the pills. This revisits the AGENTS.md
     "silently cut off the last tab" lesson deliberately — with 4+ chips the
     row now always overflows mid-chip (a partially visible pill is the
     scroll affordance), unlike the early incident where the chips fit
     flush and the hidden overflow was undiscoverable. */
  [data-mobile-nav="chip-row"] {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 10px;
    overflow-x: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  [data-mobile-nav="chip-row"]::-webkit-scrollbar {
    display: none;
  }
  [data-mobile-nav="chip"],
  [data-mobile-nav="chip-more"] {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 14px;
    border: none;
    border-radius: 17px;
    background: var(--dsw-alias-bg-base, #ffffff);
    color: var(--dsw-alias-label-primary, inherit);
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .06);
  }
  [data-mobile-nav="chip-more"] {
    padding: 0 9px;
  }
  [data-mobile-nav="chip"]:active,
  [data-mobile-nav="chip-more"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }

  /* Harvested chip icon (S5.1): the cloned <svg> keeps whatever width/height
     the source plugin gave it (18px for the one verified live example) —
     force it down to the same 16px box every hand-registered chip icon
     uses, CSS wins over the presentational SVG attributes. */
  [data-mobile-nav="chip-harvest-icon"] {
    display: inline-flex;
    flex: none;
  }
  [data-mobile-nav="chip-harvest-icon"] svg {
    display: block;
    width: 16px;
    height: 16px;
  }

  /* Customize sheet: toggle rows inside the SAME home-sheet-layer/mask/sheet
     chrome the workspace switcher declares in home.css.ts — S6's
     drag-to-close and mask-click-close bind to
     \`[data-mobile-nav="home-sheet"]\` generically (effects/gestures.ts), so
     this second use of the marker needs no new gesture wiring. */
  [data-mobile-nav="chip-toggle-row"] {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    /* Real-device fix: without border-box this row's used width is
       100% (of the sheet's own already-padded content box) PLUS the
       12px+12px padding below, overflowing the sheet by 24px and
       shoving the flex:none toggle off its right edge (2026-08-17
       report: "开关跑到屏幕外"). home-sheet-item next door in
       home.css.ts has the identical width:100%+padding shape and the
       same latent bug, just with no trailing element to visibly clip. */
    box-sizing: border-box;
    min-height: 48px;
    padding: 0 12px;
    color: inherit;
  }
  [data-mobile-nav="chip-toggle-label"] {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-mobile-nav="chip-toggle"] {
    flex: none;
    position: relative;
    width: 42px;
    height: 26px;
    border: none;
    border-radius: 13px;
    background: var(--dsw-alias-border-l2, rgba(0, 0, 0, .16));
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition: background .15s var(--ds-ease-in-out, ease-in-out);
  }
  [data-mobile-nav="chip-toggle"]::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
    transition: transform .15s var(--ds-ease-in-out, ease-in-out);
  }
  [data-mobile-nav="chip-toggle"][aria-checked="true"] {
    background: var(--dsw-alias-button-primary-fill, #1a1a1a);
  }
  [data-mobile-nav="chip-toggle"][aria-checked="true"]::after {
    transform: translateX(16px);
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-nav="chip-toggle"],
    [data-mobile-nav="chip-toggle"]::after {
      transition: none !important;
    }
  }
}
`
