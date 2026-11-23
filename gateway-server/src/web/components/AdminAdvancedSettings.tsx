// 管理端「高级设置」标签页表单（Slice 3）：
// 1. 中转与网关连接控制（forceRelay 开关 + 9 项网关运行参数）；
// 2. 节点直连与中转流控（7 项窗口与确认合并参数）；
// 3. 节点切路与防抖（6 项停滞、冷却、回滞与乱序宽限参数）。
// 所有字段均展示白话说明、建议默认值与允许范围，仅提交发生变更的字段，
// 支持两击确认后一键恢复全部建议默认值。
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import type { LocaleKey, TranslateFn } from '../i18n/locales';
import {
  ConsoleClient,
  GATEWAY_TUNING_SPECS,
  PEER_SWITCH_SPECS,
  PEER_WINDOW_SPECS,
  buildAdvancedTuningPatch,
  createAdvancedTuningDraft,
} from '../store/console-store';
import type {
  AdminSettingsData,
  AdvancedTuningDraft,
  TuningFieldSpec,
  UiLocalState,
} from '../store/console-store';
import { adminErrorToKey } from './AdminView';

export {
  buildAdvancedTuningPatch,
  createAdvancedTuningDraft,
  validateAdvancedTuningDraft,
} from '../store/console-store';

const RESET_CONFIRM_TARGET = 'reset-advanced-tuning';

export interface AdminAdvancedSettingsProps {
  t: TranslateFn;
  client: ConsoleClient;
  settings: AdminSettingsData;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  onSettingsChanged: (next: AdminSettingsData) => void;
}

function TuningFieldInput<K extends string>(props: {
  t: TranslateFn;
  spec: TuningFieldSpec<K>;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t, spec, value, onChange } = props;
  const inputId = `admin-adv-${spec.key}`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={inputId}>
        {t(spec.labelKey)}
      </label>
      <input
        id={inputId}
        className="input input-narrow mono"
        type="number"
        required
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="field-hint">
        {t(spec.hintKey)} · {t('admin.advRecommended', { v: spec.defaultValue })} ·{' '}
        {t('admin.advRange', { min: spec.min, max: spec.max })}
      </p>
    </div>
  );
}

export function AdminAdvancedSettings(props: AdminAdvancedSettingsProps) {
  const { t, client, settings, ui, onUi, onSettingsChanged } = props;
  const [draft, setDraft] = useState<AdvancedTuningDraft>(() => createAdvancedTuningDraft(settings));
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(createAdvancedTuningDraft(settings));
  }, [settings]);

  const confirmingReset = ui.confirmTarget === RESET_CONFIRM_TARGET;

  const updateGatewayField = (key: keyof AdvancedTuningDraft['gateway'], value: string): void => {
    setDraft((prev) => ({ ...prev, gateway: { ...prev.gateway, [key]: value } }));
    setStatusMessage(null);
    setErrorMessage(null);
  };

  const updatePeerField = (key: keyof AdvancedTuningDraft['peer'], value: string): void => {
    setDraft((prev) => ({ ...prev, peer: { ...prev.peer, [key]: value } }));
    setStatusMessage(null);
    setErrorMessage(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setStatusMessage(null);
    setErrorMessage(null);

    const built = buildAdvancedTuningPatch(settings, draft);
    if (!built.ok) {
      const vars = {
        ...(built.errorParams ?? {}),
        ...(built.errorFieldKey !== undefined ? { field: t(built.errorFieldKey) } : {}),
      };
      setErrorMessage(t(built.errorKey, vars));
      return;
    }
    if (built.patch === null) {
      setStatusMessage(t('admin.advNoChanges'));
      return;
    }

    setBusy(true);
    try {
      const updated = await client.updateAdminSettings(built.patch);
      onSettingsChanged(updated);
      setStatusMessage(t('toast.saved'));
    } catch (err) {
      const key: LocaleKey = adminErrorToKey(err);
      setErrorMessage(t(key));
    } finally {
      setBusy(false);
    }
  };

  const handleResetDefaults = async (): Promise<void> => {
    if (busy) return;
    if (!confirmingReset) {
      onUi({ confirmTarget: RESET_CONFIRM_TARGET });
      return;
    }
    onUi({ confirmTarget: null });
    setBusy(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const updated = await client.updateAdminSettings({
        forceRelay: false,
        advancedTuning: null,
      });
      onSettingsChanged(updated);
      setStatusMessage(t('admin.advResetDone'));
    } catch (err) {
      setErrorMessage(t(adminErrorToKey(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        void submit(e);
      }}
    >
      <div className="settings-stack">
        <section className="settings-section">
          <div className="modal-body">
            <h3>{t('admin.advSectionGateway')}</h3>
            <p className="field-hint" style={{ margin: '0 0 12px' }}>
              {t('admin.advSectionGatewayHint')}
            </p>

            <div className="setting-row">
              <span id="admin-adv-force-relay-label">{t('admin.forceRelay')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={draft.forceRelay}
                aria-labelledby="admin-adv-force-relay-label"
                className={draft.forceRelay ? 'switch on' : 'switch'}
                onClick={() => {
                  setDraft((prev) => ({ ...prev, forceRelay: !prev.forceRelay }));
                  setStatusMessage(null);
                  setErrorMessage(null);
                }}
              >
                <span className="switch-knob" aria-hidden="true" />
              </button>
            </div>
            <p className="field-hint" style={{ margin: '-8px 0 14px' }}>
              {t('admin.forceRelayHint')}
            </p>

            {GATEWAY_TUNING_SPECS.map((spec) => (
              <TuningFieldInput
                key={spec.key}
                t={t}
                spec={spec}
                value={draft.gateway[spec.key]}
                onChange={(v) => updateGatewayField(spec.key, v)}
              />
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="modal-body">
            <h3>{t('admin.advSectionWindow')}</h3>
            <p className="field-hint" style={{ margin: '0 0 12px' }}>
              {t('admin.advSectionWindowHint')}
            </p>
            {PEER_WINDOW_SPECS.map((spec) => (
              <TuningFieldInput
                key={spec.key}
                t={t}
                spec={spec}
                value={draft.peer[spec.key]}
                onChange={(v) => updatePeerField(spec.key, v)}
              />
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="modal-body">
            <h3>{t('admin.advSectionSwitch')}</h3>
            <p className="field-hint" style={{ margin: '0 0 12px' }}>
              {t('admin.advSectionSwitchHint')}
            </p>
            {PEER_SWITCH_SPECS.map((spec) => (
              <TuningFieldInput
                key={spec.key}
                t={t}
                spec={spec}
                value={draft.peer[spec.key]}
                onChange={(v) => updatePeerField(spec.key, v)}
              />
            ))}

            {errorMessage !== null && (
              <p className="form-error" role="alert">
                {errorMessage}
              </p>
            )}
            <div className="modal-foot" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <button
                type="button"
                data-confirm-trigger
                className={confirmingReset ? 'btn danger solid' : 'btn danger'}
                disabled={busy}
                onClick={() => {
                  void handleResetDefaults();
                }}
              >
                {confirmingReset ? t('admin.advResetConfirm') : t('admin.advResetDefaults')}
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {statusMessage !== null && errorMessage === null && (
                  <p className="form-status-ok" role="status">
                    {statusMessage}
                  </p>
                )}
                <button type="submit" className="btn primary" disabled={busy}>
                  {t('common.save')}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </form>
  );
}
