import React, { useEffect, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

const PIN_LEN = 4;
/** Must match control-access PIN used elsewhere (App.jsx). */
const QUIT_CONFIRM_PIN = '1258';

const PAD = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
  ['Again', '0']
];

/**
 * PIN dialog shown before the application is closed from a screen with no user logged in.
 * Calls `onConfirmed` once the control-access PIN is entered. A wrong PIN is reported through
 * `onWrongPin` when given (the login screen shows a toast); otherwise the dialog shows it itself.
 */
export function QuitPinModal({ open, onCancel, onConfirmed, onWrongPin }) {
  const { t } = useLanguage();
  const [pinInput, setPinInput] = useState('');
  const [wrongPin, setWrongPin] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPinInput('');
    setWrongPin(false);
  }, [open]);

  if (!open) return null;

  const handlePadKey = (key) => {
    setWrongPin(false);
    if (key === 'Again') {
      setPinInput('');
      return;
    }
    const next = pinInput.length >= PIN_LEN ? pinInput : pinInput + key;
    if (next.length < PIN_LEN) {
      setPinInput(next);
      return;
    }
    setPinInput('');
    if (next === QUIT_CONFIRM_PIN) {
      onConfirmed?.();
      return;
    }
    if (onWrongPin) onWrongPin();
    else setWrongPin(true);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quit-pin-title"
    >
      <div className="bg-pos-panel w-full max-w-md rounded-xl border border-pos-border p-6 shadow-2xl">
        <h2 id="quit-pin-title" className="text-xl font-semibold text-center text-pos-text mb-4">
          {t('loginQuitPinTitle')}
        </h2>
        <div className="mb-4 h-16 flex items-center bg-pos-bg justify-center rounded text-xl font-mono text-white tracking-widest">
          {pinInput.replace(/./g, '•') || t('pin')}
        </div>
        {wrongPin ? (
          <p className="-mt-2 mb-3 text-center text-sm text-red-400" role="alert">
            {t('loginWrongPin')}
          </p>
        ) : null}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {PAD.map((row) =>
            row.map((key) => (
              <button
                key={key}
                type="button"
                className={`col-span-1 py-2 rounded-lg font-semibold transition-colors border border-transparent ${key === 'Again'
                  ? 'col-span-2 text-xl bg-pos-bg text-white active:border-white'
                  : 'bg-pos-bg text-xl text-white active:border-white'
                  } active:bg-green-500`}
                onClick={() => handlePadKey(key)}
              >
                {key === 'Again' ? t('again') : key}
              </button>
            ))
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="w-full py-3 rounded-lg text-lg font-semibold border border-pos-border bg-pos-bg text-pos-text active:bg-pos-panel transition-colors"
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}
