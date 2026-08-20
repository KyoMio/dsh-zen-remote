// base — split from src/client/mobile.css.ts (2026-08-16), order preserved.
// Do not reorder: styles/index.ts concatenates in this exact order.

export const BASE_CSS = `
/* ---------- safe-area variables (S2.1, 2026-08-17) ----------
   Every safe-area use in this stylesheet reads --mnav-sat / --mnav-sab
   instead of env() directly. Same computed value by default, but the
   indirection gives one place to override: ?mobile-nav-inset=54 (client/
   debug.ts) writes a fake inset onto the root element, so a desktop CDP
   run can regress notch layout — env(safe-area-inset-*) is hard 0 in every
   desktop browser, which is exactly why the header and the workbench
   panel shipped broken to a real iPhone. */
:root {
  --mnav-sat: env(safe-area-inset-top, 0px);
  --mnav-sab: env(safe-area-inset-bottom, 0px);
}

/* ---------- base control styles (rendered at any width, hidden where unused) ---------- */

[data-mobile-nav="toggle"],
[data-mobile-nav="files"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
[data-mobile-nav="toggle"]:hover,
[data-mobile-nav="files"]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}
[data-mobile-nav="toggle"]:focus-visible,
[data-mobile-nav="files"]:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4f6ef7);
  outline-offset: 1px;
}

/* Drawer footer actions: the relocated Session log download plus the Files
   action that opens the dsh-web-ui explorer sheet. */
[data-mobile-nav="drawer-actions"] {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
[data-mobile-nav="session-log"],
[data-mobile-nav="explorer"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
[data-mobile-nav="session-log"]:hover:not(:disabled),
[data-mobile-nav="explorer"]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}
[data-mobile-nav="session-log"]:disabled {
  color: var(--dsw-alias-label-dimmed, rgba(0, 0, 0, .35));
  cursor: default;
}

/* Floating fallback button (hero / blank phases without a session header).
   The top clears the camera band below the status bar; when the client has
   set viewport-fit=cover the safe-area inset moves it below the notch too. */
[data-mobile-nav="fab"] {
  position: absolute;
  top: calc(var(--mnav-sat) + 72px);
  left: 10px;
  z-index: 21;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 50%;
  background: var(--dsw-alias-button-floating-fill, #ffffff);
  color: var(--dsw-alias-label-primary, inherit);
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0, 0, 0, .18);
  -webkit-tap-highlight-color: transparent;
}
[data-mobile-nav="fab"]:hover {
  background: var(--dsw-alias-button-floating-hover, rgba(0, 0, 0, .08));
}
[data-mobile-nav="fab"]:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4f6ef7);
  outline-offset: 2px;
}

/* Dimmed backdrop under the open drawer; above every column, below the drawer. */
[data-mobile-nav="backdrop"] {
  position: absolute;
  inset: 0;
  z-index: 30;
  background: rgba(0, 0, 0, .45);
  cursor: pointer;
  animation: dsh-mobile-nav-fade .2s var(--ds-ease-in-out, ease-in-out);
  -webkit-tap-highlight-color: transparent;
}
@keyframes dsh-mobile-nav-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
/* Settings sheet entrance: the official dialog mounts with no animation at
   all, so it snaps in. Fade + slight rise/scale reads as a proper sheet. */
@keyframes dsh-mobile-nav-sheet-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* Preview sheet rise: the aionui preview column opens as a bottom sheet. */
@keyframes dsh-mobile-nav-sheet-up {
  from {
    opacity: 0;
    transform: translateY(28px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ---------- beta-notice handling (ALL widths — deliberate exception) ----
   User-directed (2026-08-17): tone down DSH's beta/preview notices
   everywhere, including desktop. This is the ONE place this plugin
   intentionally breaks its own ">=1024px strict no-op" rule.
   - The hero "预览版" badge only carries a hashed class; per repo convention
     the stable part is the suffix (_previewBadge), matched with [class$=].
   - The first-run "内测声明" modal must NOT be hidden with CSS: while it is
     mounted it holds document #root inert, so display:none leaves the whole
     app unclickable (2026-08-18 incident). effects/welcome-notice.ts instead
     injects a "不再弹出" opt-out button; this styles it. */
[class$="_previewBadge"] {
  display: none !important;
}
/* Mirrors the official primitives Button (md capsule, outline variant):
   36px height, 18px radius, --dsw-alias-border-l2 hairline. */
.zen-welcome-optout {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  /* The notice's action row is a flex row and the official confirm button
     takes the slack; without an explicit shrink guard this button collapsed
     to about two characters wide on a phone. Content width, never squeezed. */
  flex: 0 0 auto;
  min-width: max-content;
  white-space: nowrap;
  padding: 0 14px;
  margin-right: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .15));
  border-radius: 18px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.zen-welcome-optout:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}
`
