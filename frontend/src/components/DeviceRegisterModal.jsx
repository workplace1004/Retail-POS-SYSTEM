import React, { useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { translations } from '../translations';
import { KeyboardWithNumpad } from './KeyboardWithNumpad';
import { QuitPinModal } from './QuitPinModal';
import { publicAssetUrl } from '../lib/publicAssetUrl.js';
import { requestTerminalBind } from '../lib/posTerminalSession.js';

function tx(t, key) {
  const out = t(key);
  if (out !== key) return out;
  return translations.en[key] ?? key;
}

/** The field the on-screen keyboard types into keeps its highlight even after it loses focus. */
const inputClass = (active) =>
  `w-full rounded-lg border ${active ? 'border-white/40' : 'border-pos-border'} bg-pos-bg px-3 py-2.5 text-sm text-pos-text outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20`;

export function DeviceRegisterModal({
  verifyFailed = false,
  apiPrefix,
  onLogin,
  onExitApplication,
  initialRegisterName = '',
  initialIp = '',
}) {
  const { t } = useLanguage();
  const [registerName, setRegisterName] = useState(initialRegisterName || '');
  const [ipField, setIpField] = useState(initialIp || '');
  /**
   * 'name' | 'ip': the field last tapped, which the on-screen keyboard edits. Set on pointer-down
   * as well as focus: Chromium withholds focus events while the window lacks OS focus, and the
   * keyboard would then type into the other field at the focused input's caret.
   */
  const [activeField, setActiveField] = useState('name');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [showQuitPinModal, setShowQuitPinModal] = useState(false);

  const titleKey = verifyFailed ? 'deviceGateTitleVerifyFailed' : 'deviceGateTitle';

  return (
    <div className="relative flex min-h-[100dvh] w-full flex-col items-center justify-center gap-6 bg-pos-bg px-4 pt-10 pb-24 text-pos-text">
      <div className="w-full max-w-md rounded-xl border border-pos-border bg-pos-panel p-6 shadow-xl">
        <h1 className="text-center text-xl font-semibold text-pos-text">{tx(t, titleKey)}</h1>

        <div className="mt-6 space-y-3 text-left">
          <div>
            <label htmlFor="device-gate-register-name" className="mb-1 block text-xs font-medium text-pos-text-dim">
              {tx(t, 'deviceGateRegisterNameLabel')}
            </label>
            <input
              id="device-gate-register-name"
              type="text"
              value={registerName}
              onChange={(e) => setRegisterName(e.target.value)}
              onPointerDown={() => setActiveField('name')}
              onFocus={() => setActiveField('name')}
              placeholder={tx(t, 'deviceGateRegisterNamePlaceholder')}
              className={inputClass(activeField === 'name')}
              autoComplete="off"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="device-gate-ip" className="mb-1 block text-xs font-medium text-pos-text-dim">
              {tx(t, 'deviceGateIpFieldLabel')}
            </label>
            <input
              id="device-gate-ip"
              type="text"
              value={ipField}
              onChange={(e) => setIpField(e.target.value)}
              onPointerDown={() => setActiveField('ip')}
              onFocus={() => setActiveField('ip')}
              placeholder={tx(t, 'deviceGateIpFieldPlaceholder')}
              className={`${inputClass(activeField === 'ip')} font-mono`}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {formError ? (
            <p className="text-sm text-red-400" role="alert">
              {formError}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          disabled={submitting}
          className="mt-8 w-full rounded-lg bg-pos-bg py-3 text-sm font-medium text-white border border-transparent hover:border-white/30 active:bg-green-600 disabled:opacity-50 disabled:pointer-events-none"
          onClick={() => {
            setFormError('');
            const name = String(registerName || '').trim();
            const ip = String(ipField || '').trim();
            if (!name || !ip) {
              setFormError(tx(t, 'deviceGateBindMissingFields'));
              return;
            }
            if (!apiPrefix || !onLogin) return;
            setSubmitting(true);
            void (async () => {
              try {
                const bound = await requestTerminalBind(apiPrefix, { name, ip });
                if (!bound.token) {
                  setFormError(bound.error || tx(t, 'deviceGateBindFailed'));
                  return;
                }
                await onLogin(bound.token, { name, ip });
              } catch {
                setFormError(tx(t, 'deviceGateBindFailed'));
              } finally {
                setSubmitting(false);
              }
            })();
          }}
        >
          {submitting ? tx(t, 'deviceGateLoginWorking') : tx(t, 'deviceGateLogin')}
        </button>
      </div>

      <div className="max-w-full overflow-x-auto">
        <KeyboardWithNumpad
          key={activeField}
          value={activeField === 'ip' ? ipField : registerName}
          onChange={activeField === 'ip' ? setIpField : setRegisterName}
        />
      </div>

      {typeof onExitApplication === 'function' && (
        <button
          type="button"
          onClick={() => setShowQuitPinModal(true)}
          aria-label={tx(t, 'loginQuitAriaLabel')}
          title={tx(t, 'loginQuitAriaLabel')}
          className="absolute bottom-4 right-4 flex h-16 w-16 items-center justify-center p-1.5 backdrop-blur-sm transition-opacity hover:opacity-90 active:opacity-100"
        >
          <img
            src={publicAssetUrl('/quit.png')}
            alt=""
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        </button>
      )}

      <QuitPinModal
        open={showQuitPinModal}
        onCancel={() => setShowQuitPinModal(false)}
        onConfirmed={() => {
          setShowQuitPinModal(false);
          onExitApplication?.();
        }}
      />
    </div>
  );
}
