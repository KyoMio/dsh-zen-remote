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
export declare const REMOTE_SHARE_CSS = "\nbutton.zr-remote-toggle[data-zen-remote=\"remote-toggle\"] {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n  flex-shrink: 0;\n  padding: 0;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  cursor: pointer;\n  position: relative;\n}\nbutton.zr-remote-toggle[data-zen-remote=\"remote-toggle\"]:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\nbutton.zr-remote-toggle[data-zen-remote=\"remote-toggle\"][data-state=\"on\"],\nbutton.zr-remote-toggle[data-zen-remote=\"remote-toggle\"][data-state=\"watched\"] {\n  color: var(--dsw-alias-state-business-primary, #4f6ef7);\n}\n/* The \"a desktop client is watching\" dot: a live signal outside the glyph's\n   box so it never collides with the 16px artwork. */\nbutton.zr-remote-toggle[data-zen-remote=\"remote-toggle\"][data-state=\"watched\"]::after {\n  content: '';\n  position: absolute;\n  top: 3px;\n  right: 3px;\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  background: var(--dsw-alias-state-success-primary, #16a34a);\n}\n";
//# sourceMappingURL=remote-share-css.d.ts.map