// composer — phone-only composer reflow (S3, 2026-08-17).
//
// Appended after home/header so its < 768px rules win the ties against the
// shared <= 1023px block in layout/compat/misc (which keeps the v1.0.0
// composer treatment alive for the 768-1023px tablet range).
//
// Official structure this file reshapes (verified live at 390px, see the S3
// report): InputBar renders
//   _card > _row > [_tools > (_add, _modes > PermissionSelect, input.left)]
//                  [_trailing > (input.right, input.model, ContextMeter, _primary)]
// with `_tools` / `_trailing` as inner flex groups. Flattening both to
// `display: contents` turns every control into a direct flex item of `_row`,
// which is what makes a pure `order` reflow possible without touching a
// single official component.

/** The composer input card's bottom control row (the only `_row` that is a direct card child — the ContextMeter panel also has `_row` descendants). */
const ROW = '[data-slot="conversation.composer.bar"] [class$="_card"] > [class$="_row"]'
/** The model seat's own root inside the trailing group (long form so it beats the <=1023px pill rules in layout.css.ts). */
const MODEL = `${ROW} > [class$="_trailing"] > [data-slot="conversation.input.model"] > [class$="_root"]`
/** The permission select's trigger button (structure only — the PermissionSelect hashed classes are never named). */
const PERM = `${ROW} > [class$="_tools"] > [class$="_modes"]`

export const COMPOSER_CSS = `/* ---------- phone composer (< 768px) ---------- */

/* The file picker the attachment button drives (S7) — hidden at EVERY width,
   deliberately OUTSIDE the phone media block below. A bare <input type="file">
   renders as a native "Choose Files" control, and the slot wrapper around it is
   \`display: contents\`, so an un-hidden one becomes a flex item of the official
   tool row. Scoping this to < 768px once put that control in the DESKTOP
   composer (caught on a live deploy, 2026-08-17): the button that drives it is
   phone-only, but the input it drives is in the DOM at all widths. */
[data-mobile-nav="attach-picker"] {
  display: none !important;
}

@media (max-width: 767px) {
  /* --- 1. flatten the two official groups ---
     \`_tools\` and \`_trailing\` only exist to cluster controls left/right.
     display:contents dissolves them into \`_row\`, so the six leaf controls
     become siblings in one flex line and \`order\` alone drives the layout:
     [attach · + · permission · model] …elastic gap… [context ring · send]. */
  ${ROW} {
    justify-content: flex-start !important;
    gap: 5px !important;
    padding: 2px 8px 8px !important;
  }
  ${ROW} > [class$="_tools"],
  ${ROW} > [class$="_trailing"] {
    display: contents !important;
  }

  /* --- 2. the running order ---
     The attachment button (S3 placeholder, S7 wires it up) sits leftmost;
     the official "+" command menu keeps its seat right next to it, where
     the two "insert something" affordances read as one cluster. */
  ${ROW} [data-mobile-nav="attach"] {
    order: 1 !important;
  }
  ${ROW} > [class$="_tools"] > [class$="_add"] {
    order: 2 !important;
  }
  ${ROW} > [class$="_tools"] > [class$="_modes"] {
    order: 3 !important;
    flex: 0 1 auto !important;
    min-width: 0 !important;
    gap: 6px !important;
  }
  /* The model seat carries the elastic gap: everything after it is pushed to
     the right edge, so no spacer element is needed. */
  ${MODEL} {
    order: 4 !important;
    flex: 0 1 auto !important;
    min-width: 0 !important;
    margin-right: auto !important;
  }
  /* Third-party input.right entries park next to the ring rather than
     landing at order 0 (= far left) once the groups are flattened. */
  ${ROW} > [class$="_trailing"] > [data-slot="conversation.input.right"] > * {
    order: 5 !important;
  }
  /* ContextMeter — the only \`span\` ending in _root inside the row. */
  ${ROW} > [class$="_trailing"] > span[class$="_root"] {
    order: 6 !important;
    flex: none !important;
  }
  ${ROW} > [class$="_trailing"] > [class$="_primary"] {
    order: 7 !important;
  }

  /* --- 3. permission + model as icon-only pills (real-device round 2, 2026-08-17) ---
     S3's icon-and-label capsules read as noise on an actual phone — there
     is no room to usefully show a preset name or a model id, so the label
     text is now hidden outright and both triggers collapse to a plain
     ~44x30 icon button. This AGREES with (rather than fights) the official
     container query (\`@container (width <= 460px) { .trigger:has(.triggerIcon)
     .triggerLabel { display: none } }\`) that S3 had to override — no need
     to override it back. Accessible name is unaffected: both official
     triggers already ship a descriptive aria-label independent of the
     visible text (PermissionSelect: t('input.accessMode', {name}); the
     model trigger: t('trigger.aria'/'trigger.ariaEffort')) — verified live
     in dsh-client-ui-conversation / dsh-client-ui-model-selection lib/
     client.js, 2026-08-17 — so hiding the label costs nothing for screen
     readers. The permission trigger only renders an icon for the
     "read-only" / "workspace-write" presets (permissionGlyphs in
     dsh-client-ui-conversation) — "Full access" and any host-configured
     preset name fall back to chevron-only, a known gap in the official
     markup this plugin cannot fill without inventing new icon meaning.
     The model trigger never renders an icon at all (only label + optional
     effort text + chevron), so its ::before below draws one from a
     primitives icon path (Sparkle — the closest existing "model" glyph) as
     a CSS-only pseudo-element: it survives React re-renders for free
     (unlike a DOM-injected node, which would need a MutationObserver, see
     the preview-full-toggle pitfall in AGENTS.md) and does not touch
     accessible-name computation (empty generated content). S3's
     rtl-ellipsis trick on the model label is simply inert under
     display:none now; left alone rather than unpicked. */
  ${PERM} [class$="_triggerLabel"],
  ${MODEL} > [class$="_trigger"] > [class$="_triggerLabel"],
  ${MODEL} > [class$="_trigger"] > [class$="_triggerEffort"] {
    display: none !important;
  }
  ${PERM} button[class$="_trigger"],
  ${MODEL} > [class$="_trigger"] {
    background: var(--dsw-specific-selector, rgba(127, 127, 127, .12)) !important;
    width: 44px !important;
    height: 30px !important;
    max-width: none !important;
    min-width: 0 !important;
    padding: 0 !important;
    gap: 2px !important;
    justify-content: center !important;
    border-radius: 999px !important;
    touch-action: manipulation !important;
  }
  /* PermissionSelect wraps its trigger in the Menu primitive's root span,
     which must shrink to the icon button's fixed width. */
  ${PERM} > span:has(> button[class$="_trigger"]) {
    flex: 0 0 auto !important;
    min-width: 0 !important;
  }
  /* ic_ds_sparkle_16 (@deepseek-ai/dsh-client-ui-primitives IconSparkle16
     path, copied verbatim) as a mask so it inherits currentColor like every
     other icon in the row — the model trigger has no official icon slot to
     hook into. */
  ${MODEL} > [class$="_trigger"]::before {
    content: '';
    width: 16px;
    height: 16px;
    flex: none;
    background: currentColor;
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z'/%3E%3Cpath d='M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z'/%3E%3C/svg%3E");
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z'/%3E%3Cpath d='M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z'/%3E%3C/svg%3E");
    -webkit-mask-size: contain;
    mask-size: contain;
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
  }

  /* --- 4. both menus become bottom sheets ---
     The permission menu is the Menu primitive (role=menu, absolute, side=top)
     and the model menu is ModelSelect's own \`_menu\` (absolute, bottom+right).
     Neither has a transformed ancestor between it and the viewport, so
     position:fixed re-anchors both to the screen edge. Only the shell moves —
     the items, the two-level model panes and every selection handler stay
     official. */
  ${PERM} [role="menu"],
  ${MODEL} > [class$="_menu"] {
    position: fixed !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    top: auto !important;
    transform: none !important;
    width: 100% !important;
    min-width: 0 !important;
    max-width: none !important;
    max-height: min(70dvh, 520px) !important;
    box-sizing: border-box !important;
    border-radius: 16px 16px 0 0 !important;
    border-bottom: none !important;
    padding: 8px 8px calc(8px + var(--mnav-sab)) !important;
    z-index: 60 !important;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, .18) !important;
  }
  /* 44pt+ rows in both sheets (Menu items, model options, and the model
     sheet's two root cells that drill into the model / effort panes). */
  ${PERM} [role="menu"] [role="menuitem"],
  ${MODEL} > [class$="_menu"] [class$="_option"],
  ${MODEL} > [class$="_menu"] [class$="_cell"] {
    min-height: 48px !important;
    border-radius: 12px !important;
    font-size: 15px !important;
  }
  /* --- 4b. the official scroll-to-bottom button must not poke through the
     sheet (real-device follow-up, 2026-08-17) ---
     ChatView's own "jump to latest" button (aria-label t("chat.toBottom"))
     is \`position: sticky; z-index: 8\` inside the message column, not
     \`position: fixed\` — it never escapes to the same top-level stacking
     context our sheets get promoted to, so raising the sheet's z-index
     further does nothing (measured live: it still rendered on top at
     z-index 60 vs 8). Rather than chase engine-specific stacking-context
     semantics (Chromium and WebKit do not always agree here — see AGENTS.md
     CDP/document.hidden lesson for another instance of that), this hides
     the button outright while either sheet is open and lets it reappear on
     close: a plain \`display: none\` behind a live \`:has()\` read is correct
     regardless of which stacking rules the engine happens to apply.
     Selector: no hashed classes (dsh-client-ui-conversation lib/client.js,
     verified 2026-08-17) — \`data-chat-flow\` is the one stable attribute on
     the message column, and the button's wrapper is its only sibling
     (ChatView only ever renders the column and, conditionally, this one
     slot), so the adjacent-sibling combinator pins it precisely. */
  body:has(${PERM} [role="menu"]) [data-chat-flow] + div,
  body:has(${MODEL} > [class$="_menu"]) [data-chat-flow] + div {
    display: none !important;
  }
  /* --- 5. input box: two lines minimum, five lines maximum ---
     The official autosizer drives the box off the hidden mirror's height, so
     a min-height on the mirror IS the min-height of the field; the scroll cap
     rides the official custom property. 52px = 2 x 24px line box + 4px pad,
     124px = 5 lines. The hero card keeps its own one-line collapse (misc.css
     pins _scroll/_grow while the placeholder shows). */
  [data-slot="conversation.composer.bar"] [class$="_card"] [class$="_mirror"] {
    min-height: 52px !important;
  }
  [class$="_composerSeat"] {
    --dsh-composer-text-max-height: 124px;
  }

  /* --- 6. no divider above OR below the message list ---
     Instead of a rule the messages butt against, the message scroller
     fades out over its last 26px (S3, no divider above the composer) AND
     fades in over its first 20px (S3.1 real-device round 2: the header's
     own bottom line is removed too, styles/header.css.ts's
     \`header::after\` rule). The mask lives on the scroll body (NOT on the
     header or the composer): a mask clips everything it paints, and both
     surfaces host position:fixed children (composer's permission/model
     sheets, any future header overlay) that must not be clipped.
     \`mask-image\` can only be declared once per element, so both fades are
     ONE linear-gradient rather than two separate declarations (the second
     would silently replace the first) — this is the merge of what used to
     be S3's bottom-only mask. */
  [class$="_scrollBody"] {
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 26px), transparent 100%);
    mask-image: linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 26px), transparent 100%);
  }
  [class$="_composerSeat"],
  [class$="_composerStack"] {
    border-top: none !important;
  }

  /* --- 7. dock entries become mini chips above the input card ---
     conversation.input.dock is display:contents (inline style), so its
     entries are stacked rows of the composer column. Forcing the slot itself
     to flex turns them into ONE scrollable chip line outside and above the
     card. Written against the slot, not against any particular plugin's chip
     (the git branch chip and the todo panel are third-party and may not be
     installed at all). */
  [data-slot="conversation.input.dock"] {
    display: flex !important;
    flex-flow: row nowrap !important;
    align-items: center !important;
    gap: 6px !important;
    min-width: 0 !important;
    margin: 0 16px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    scrollbar-width: none !important;
  }
  [data-slot="conversation.input.dock"]::-webkit-scrollbar {
    display: none !important;
  }
  [data-slot="conversation.input.dock"] > * {
    flex: 0 0 auto !important;
    max-width: 70% !important;
    min-height: 26px !important;
    max-height: 26px !important;
    border-radius: 999px !important;
    font-size: 11.5px !important;
    line-height: 18px !important;
    overflow: hidden !important;
  }
  /* The git-graph chip carries a 34px tablet target from misc.css; that
     selector is more specific, so restate it at the phone breakpoint. */
  [data-slot="conversation.input.dock"] [data-gitgraph-chip-anchor] [data-gitgraph-chip] {
    min-height: 26px !important;
    padding: 0 10px !important;
    font-size: 11.5px !important;
  }

  /* --- 7b. attachment chips (S7.1) ---
     Our own dock entry opts OUT of the 26px pill cage above: an image chip is
     a 48px tile. The row sits tight under the card's top edge, so the chips
     read as part of the composer rather than as a floating strip. */
  [data-slot="conversation.input.dock"] > [data-mobile-nav="attach-chips"] {
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
    max-width: none !important;
    min-height: 0 !important;
    max-height: none !important;
    border-radius: 0 !important;
    overflow: visible !important;
    margin-bottom: -2px;
  }
  [data-mobile-nav="attach-chip"] {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    max-width: 62vw;
    background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
    color: var(--dsw-alias-label-primary, inherit);
  }
  [data-mobile-nav="attach-chip"][data-kind="file"] {
    height: 26px;
    padding: 0 4px 0 8px;
    border-radius: 999px;
    font-size: 11.5px;
    line-height: 18px;
  }
  /* An image chip is the thumbnail: no name line, the filename lives in the
     title attribute (and in the draft text right below). */
  [data-mobile-nav="attach-chip"][data-kind="image"] {
    width: 48px;
    height: 48px;
    padding: 0;
    border-radius: 10px;
    overflow: hidden;
  }
  [data-mobile-nav="attach-chip-art"] {
    position: relative;
    display: grid;
    place-items: center;
    flex: none;
    overflow: hidden;
  }
  [data-kind="file"] > [data-mobile-nav="attach-chip-art"] {
    width: 16px;
    height: 16px;
    opacity: .7;
  }
  [data-kind="image"] > [data-mobile-nav="attach-chip-art"] {
    width: 100%;
    height: 100%;
  }
  /* The <img> is stacked over the paperclip, not swapped for it: a format the
     engine cannot decode (HEIC outside WebKit) simply paints nothing and the
     icon shows through — no onError state to carry. */
  [data-mobile-nav="attach-chip-art"] img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .18));
  }
  [data-mobile-nav="attach-chip-name"] {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  [data-mobile-nav="attach-chip-remove"] {
    display: grid;
    place-items: center;
    flex: none;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    touch-action: manipulation;
  }
  /* On a tile the × floats in the corner over the picture, so it needs its own
     ground to stay legible against an arbitrary photo. */
  [data-kind="image"] > [data-mobile-nav="attach-chip-remove"] {
    position: absolute;
    top: 2px;
    right: 2px;
    background: rgba(0, 0, 0, .55);
    color: #fff;
  }
  [data-mobile-nav="attach-chip-remove"]:active {
    transform: scale(.9);
  }

  /* --- 8. the official stats strip leaves the composer ---
     Its data moves into the session info card (S4). The row is the composer
     dock's own \`_root\` entry; the slot itself stays live for later entries. */
  [data-slot="conversation.composer.dock"] > [class$="_root"] {
    display: none !important;
  }

  /* --- 9. the attachment button (S7; its file input is hidden at the top of
     this file, at every width) --- */
  [data-mobile-nav="attach"] {
    position: relative;
    width: 28px !important;
    height: 28px !important;
    flex: none !important;
    display: grid !important;
    place-items: center !important;
    padding: 0 !important;
    border: none !important;
    border-radius: 999px !important;
    background: var(--dsw-specific-selector, rgba(127, 127, 127, .12));
    color: var(--dsw-alias-label-primary, inherit);
    cursor: pointer;
    touch-action: manipulation;
  }
  [data-mobile-nav="attach"]:active {
    transform: scale(.94);
    transition: transform .12s;
  }
  /* Busy: a ring sweeps around the paperclip. Drawn with a conic gradient in
     a pseudo-element rather than a spinner node, so the official React tree
     around us has nothing extra to re-render (same reasoning as the model
     pill's mask icon, S3.1). */
  [data-mobile-nav="attach"][data-busy]::after {
    content: "";
    position: absolute;
    inset: -2px;
    border-radius: 999px;
    background: conic-gradient(from 0deg, transparent 0 65%, currentColor 100%);
    mask: radial-gradient(closest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
    -webkit-mask: radial-gradient(closest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
    animation: mnav-attach-spin .9s linear infinite;
    pointer-events: none;
  }
  @keyframes mnav-attach-spin {
    to { transform: rotate(1turn); }
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-nav="attach"][data-busy]::after {
      animation-duration: 3s;
    }
  }
  /* Failure note: one line above the button, tap-to-dismiss. Sits on the
     composer card (z 2) rather than in an overlay layer — nothing here needs
     to clear the permission/model sheets. */
  [data-mobile-nav="attach-error"] {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 2;
    max-width: 62vw;
    padding: 5px 8px;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, .82));
    color: var(--dsw-alias-label-primary, #fff);
    box-shadow: 0 2px 8px rgba(0, 0, 0, .24);
  }

  /* --- 9. home-indicator clearance (S4.1, 2026-08-17) ---
     Owned HERE, not by dsh-mobile-pwa. That plugin used to carry
       [data-slot="conversation.composer"] { padding-bottom: max(env(safe-area-inset-bottom), 8px) }
     in both pwa/app.css and the gateway's inline DEVICE_CSS. Both were
     INERT and had always been: that slot element is \`display: contents\`
     (measured 2026-08-17 — the slot wrapper generates no box, so padding on
     it is discarded), which is why raising it never moved anything. The rule
     is deleted on the PWA side and restated here on an element that actually
     lays out, reading --mnav-sab so ?mobile-nav-inset=54,34 can regress it
     off-device (env() is hard 0 on desktop — the whole reason S2.1 exists).

     Target: the card should look EQUALLY inset on all four sides. This same
     element carries the card's side inset (\`padding: 0 16px\` officially,
     measured 16px left and 16px right at 390px), so the bottom gap is simply
     capped at that same 16px. Clearing the FULL 34px inset — the naive
     max(sab, 8px) — is what read as "too thick": it is more than double the
     side margin, so the card looked shoved up off the bottom edge.

     clamp() says all three requirements at once:
       - floor 8px  -> a device with no home indicator (sab: 0) keeps the
                       official 8px exactly, so this is a strict no-op there;
       - track sab  -> a shallower inset than 16px is honoured as-is;
       - cap 16px   -> a full-size indicator (sab: 34) lands on 16px, equal
                       to the side inset, which is the look being asked for.
     Keep the 16px in step with the side padding above if that ever changes;
     that equality IS the spec here, not a coincidence. */
  [data-slot="conversation.composer.bar"] > [class$="_root"] {
    padding-bottom: clamp(8px, var(--mnav-sab), 16px) !important;
  }
}

/* The attachment button and its preview row only exist for the phone shell.
   Both render at every width (the slots are not breakpoint-aware), so both
   need hiding here — the dock-row rules that shape the chips live in the
   < 768px block and would otherwise leave a bare, unstyled chip line in the
   desktop composer. */
@media (min-width: 768px) {
  [data-mobile-nav="attach"],
  [data-mobile-nav="attach-chips"] {
    display: none !important;
  }
}
`
