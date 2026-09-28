/**
 * Styles for the T33b session-sharing parts — the title-row remote icon's
 * three states and nothing else (the menu item is an official
 * MenuItemButton and needs no CSS; the settings list draws on the settings
 * block's own zr-settings-* sheet). Injected as one
 * `<style data-plugin="dsh-zen-remote-remote-share">` tag BEFORE apply's
 * desktop gate: the desktop app IS the main server and its title row is
 * where the icon lives. Every selector is scoped under the button's own
 * attribute, so nothing here can reach host elements (the title row's
 * layout especially — this box is a fixed 28px grid item and shrinks for
 * nobody).
 *
 * On the phone shell the icon needs no rules of its own: the mobile
 * stylesheet blanket-hides every child of the
 * `conversation.session.header.actions` slot wrapper (styles/header.css.ts),
 * which this entry is.
 */

export const REMOTE_SHARE_CSS = `
button.zr-remote-toggle[data-zen-remote="remote-toggle"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  position: relative;
}
button.zr-remote-toggle[data-zen-remote="remote-toggle"]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
button.zr-remote-toggle[data-zen-remote="remote-toggle"][data-state="on"],
button.zr-remote-toggle[data-zen-remote="remote-toggle"][data-state="watched"] {
  color: var(--dsw-alias-state-business-primary, #4f6ef7);
}
/* The "a desktop client is watching" dot: a live signal outside the glyph's
   box so it never collides with the 16px artwork. */
button.zr-remote-toggle[data-zen-remote="remote-toggle"][data-state="watched"]::after {
  content: '';
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary, #16a34a);
}
`
