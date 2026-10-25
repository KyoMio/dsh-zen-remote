/**
 * Wizard-page CSS (GW-10), scoped end to end under the block's own
 * `data-zen-remote` attributes — the desktop no-op rule in its CSS form:
 * nothing here may reach a selector the wizard does not own, so the
 * Plugins detail page at ≥1024px renders byte-identically whether or not
 * the component mounts. Same transcription discipline as settings-css.ts
 * (host design tokens only, no literal colors).
 */

export const WIZARD_CSS = `
[data-zen-remote="wizard"] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
}
[data-zen-remote="wizard"] .zr-wizard-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-subtitle {
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-notice {
  font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 8px 12px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-notice[data-tone="error"] {
  border-color: var(--dsw-alias-border-error, var(--dsw-alias-border-l2));
  color: var(--dsw-alias-label-error, var(--dsw-alias-label-secondary));
}
[data-zen-remote="wizard"] .zr-wizard-steps {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-steps [data-current="true"] {
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
[data-zen-remote="wizard"] .zr-wizard-paths {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: none;
}
[data-zen-remote="wizard"] .zr-wizard-path {
  text-align: left;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--dsw-alias-bg-module-platform);
  cursor: pointer;
  font: inherit;
  color: inherit;
}
[data-zen-remote="wizard"] .zr-wizard-path[data-selected="true"] {
  border-color: var(--dsw-alias-border-brand, var(--dsw-alias-border-l2));
}
[data-zen-remote="wizard"] .zr-wizard-path:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
[data-zen-remote="wizard"] .zr-wizard-pathName {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin: 0 0 2px;
}
[data-zen-remote="wizard"] .zr-wizard-pathDesc {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
[data-zen-remote="wizard"] .zr-wizard-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-hint {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-input {
  font: inherit;
  font-size: 13px;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-input, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-primary);
  max-width: 360px;
}
[data-zen-remote="wizard"] .zr-wizard-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[data-zen-remote="wizard"] .zr-wizard-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-brand, var(--dsw-alias-label-secondary));
  cursor: pointer;
  text-decoration: underline;
}
[data-zen-remote="wizard"] .zr-wizard-lights {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-zen-remote="wizard"] .zr-wizard-light {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}
[data-zen-remote="wizard"] .zr-wizard-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
  flex: none;
}
[data-zen-remote="wizard"] .zr-wizard-dot[data-state="pass"] {
  background: var(--dsw-alias-label-success, #16a34a);
}
[data-zen-remote="wizard"] .zr-wizard-dot[data-state="fail"] {
  background: var(--dsw-alias-label-error, #dc2626);
}
[data-zen-remote="wizard"] .zr-wizard-dot[data-state="pending"] {
  background: var(--dsw-alias-label-tertiary);
}
[data-zen-remote="wizard"] .zr-wizard-code {
  font-size: 20px;
  letter-spacing: 4px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-countdown {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-qr {
  width: 148px;
  height: 148px;
  image-rendering: pixelated;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: #fff;
  padding: 6px;
}
[data-zen-remote="wizard"] .zr-wizard-qr[data-usable="false"] {
  display: none;
}

/* The modal card: a body-level overlay, above the app chrome. */
[data-zen-remote="wizard-card"] {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
[data-zen-remote="wizard-card"] .zr-wizard-cardPanel {
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  max-width: min(560px, calc(100vw - 32px));
  max-height: min(80vh, 640px);
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardTitle {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardTabs {
  display: flex;
  gap: 6px;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardTab {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardTab[data-selected="true"] {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-brand, var(--dsw-alias-border-l2));
}
[data-zen-remote="wizard-card"] .zr-wizard-cardStep {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
  margin: 0;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardCode {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  white-space: pre;
  background: var(--dsw-alias-bg-input, rgba(127, 127, 127, 0.12));
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 10px;
  overflow: auto;
  max-height: 260px;
  margin: 0;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
[data-zen-remote="wizard-card"] button {
  font: inherit;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
[data-zen-remote="wizard-card"] button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
`
