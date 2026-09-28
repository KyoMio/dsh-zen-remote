/**
 * Settings-page CSS for the plugin-row block (T15), transcribed from the
 * dsh-llm-verifier section styles so the page reads as native. Injected as
 * one `<style data-plugin="dsh-zen-remote-settings">` tag; every selector is
 * scoped under the block's own attribute so nothing can reach the phone-shell
 * styles (the CSS-division rule in AGENTS.md — the shell keeps its own
 * stylesheets, this surface owns its own).
 */

export const SETTINGS_CSS = `
[data-zen-remote="settings"] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
}
[data-zen-remote="settings"] .zr-settings-summary {
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
}
[data-zen-remote="settings"] .zr-settings-notice {
  font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 8px 12px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  margin: 0;
}
[data-zen-remote="settings"] .zr-settings-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  padding: 4px 16px;
}
[data-zen-remote="settings"] .zr-settings-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin: 12px 0 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-zen-remote="settings"] .zr-settings-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
[data-zen-remote="settings"] .zr-settings-field + .zr-settings-field {
  border-top: 1px solid var(--dsw-alias-border-l2);
}
[data-zen-remote="settings"] .zr-settings-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-zen-remote="settings"] .zr-settings-head label {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
[data-zen-remote="settings"] .zr-settings-badge {
  font-size: 11px;
  border-radius: 999px;
  padding: 2px 8px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
[data-zen-remote="settings"] .zr-settings-badge[data-warn="true"] {
  color: var(--dsw-alias-state-warning-primary, #b8860b);
}
[data-zen-remote="settings"] .zr-settings-reset {
  font-size: 12px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
}
[data-zen-remote="settings"] .zr-settings-reset:hover {
  color: var(--dsw-alias-label-primary);
}
[data-zen-remote="settings"] input.zr-settings-input,
[data-zen-remote="settings"] select.zr-settings-input {
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  padding: 0 10px;
}
[data-zen-remote="settings"] select.zr-settings-input {
  max-width: 260px;
}
[data-zen-remote="settings"] .zr-settings-hint {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
}
[data-zen-remote="settings"] .zr-settings-hint[data-invalid="true"] {
  color: var(--dsw-alias-state-error-primary, #d5304f);
}
[data-zen-remote="settings"] .zr-settings-check-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-zen-remote="settings"] .zr-settings-check-row input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--dsw-alias-label-primary);
}
[data-zen-remote="settings"] .zr-settings-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
[data-zen-remote="settings"] .zr-settings-status-line {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  margin: 0;
  padding: 10px 0 12px;
}
[data-zen-remote="settings"] .zr-settings-status-line[data-down="true"] {
  color: var(--dsw-alias-state-error-primary, #d5304f);
}
[data-zen-remote="settings"] .zr-settings-role-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
}
[data-zen-remote="settings"] .zr-settings-role-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
  background: none;
  text-align: left;
  font: inherit;
  color: inherit;
}
[data-zen-remote="settings"] .zr-settings-role-card[data-active="true"] {
  border-color: var(--dsw-alias-label-primary);
}
[data-zen-remote="settings"] .zr-settings-role-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
[data-zen-remote="settings"] .zr-settings-role-card-title input[type="radio"] {
  width: 15px;
  height: 15px;
  accent-color: var(--dsw-alias-label-primary);
}
[data-zen-remote="settings"] .zr-settings-pair-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 28px;
  letter-spacing: 4px;
  color: var(--dsw-alias-label-primary);
  margin: 4px 0 0;
}
[data-zen-remote="settings"] .zr-settings-device {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
[data-zen-remote="settings"] .zr-settings-device + .zr-settings-device {
  border-top: 1px solid var(--dsw-alias-border-l2);
}
[data-zen-remote="settings"] .zr-settings-device-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[data-zen-remote="settings"] .zr-settings-device-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
[data-zen-remote="settings"] .zr-settings-device-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
[data-zen-remote="settings"] .zr-settings-device-actions select.zr-settings-input {
  height: 28px;
  max-width: 170px;
}
[data-zen-remote="settings"] .zr-settings-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
}
`
