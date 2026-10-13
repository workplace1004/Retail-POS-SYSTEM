import React, { useCallback, useEffect, useState } from 'react';

/** Comma is the decimal separator on this POS (nl-BE), so parse it back to a JS number. */
function parseOpenPriceAmount(raw) {
  const normalized = String(raw ?? '').trim().replace(',', '.');
  if (!normalized || normalized === '.') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

const MAX_INTEGER_DIGITS = 6;
const MAX_DECIMALS = 2;

/**
 * Modal: type the price for an "Open price" product before it is added to the order.
 * The amount becomes the order line's unit price; the product's catalogue price is untouched.
 */
export function OpenPriceModal({ open, product, onCancel, onConfirm, labels }) {
  const [raw, setRaw] = useState('');

  useEffect(() => {
    if (!open) setRaw('');
  }, [open]);

  const amount = parseOpenPriceAmount(raw);
  const canConfirm = amount != null && amount > 0;

  const pressDigit = useCallback((digit) => {
    setRaw((prev) => {
      const [intPart, decPart] = prev.split(',');
      if (decPart != null) {
        if (decPart.length >= MAX_DECIMALS) return prev;
        return `${intPart},${decPart}${digit}`;
      }
      if (prev === '0') return digit;
      if (intPart.length >= MAX_INTEGER_DIGITS) return prev;
      return prev + digit;
    });
  }, []);

  const pressComma = useCallback(() => {
    setRaw((prev) => (prev.includes(',') ? prev : (prev === '' ? '0,' : `${prev},`)));
  }, []);

  const clear = useCallback(() => setRaw(''), []);

  const confirm = useCallback(() => {
    if (!canConfirm) return;
    onConfirm?.({ linePrice: Math.round(amount * 100) / 100 });
  }, [amount, canConfirm, onConfirm]);

  // Hardware keyboards / numpads are common on counter tills, so accept them too.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key >= '0' && event.key <= '9') {
        pressDigit(event.key);
      } else if (event.key === ',' || event.key === '.') {
        pressComma();
      } else if (event.key === 'Backspace') {
        setRaw((prev) => prev.slice(0, -1));
      } else if (event.key === 'Delete' || event.key === 'Escape') {
        if (event.key === 'Escape') { onCancel?.(); return; }
        clear();
      } else if (event.key === 'Enter') {
        confirm();
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, pressDigit, pressComma, clear, confirm, onCancel]);

  if (!open || !product) return null;

  const keyClass =
    'h-[64px] rounded-lg text-3xl font-semibold text-pos-text active:bg-green-500 select-none';

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-[420px] rounded-2xl bg-pos-bg border border-pos-border shadow-2xl p-6">
        <p className="text-center text-lg font-semibold mb-4 text-pos-text">
          {labels?.title ?? 'Open price'} — {product.name}
          {/* Scale products weigh next, so the amount typed here is the per-KG rate, not the line total. */}
          {product.weegschaal ? ' / KG' : ''}
        </p>
        <div className="flex justify-center mb-6">
          <div className="min-w-[200px] max-w-[200px] h-[42px] rounded-lg bg-pos-panel border border-pos-border px-3 flex items-center justify-end text-2xl font-semibold tabular-nums text-pos-text">
            {raw}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-x-2 gap-y-1 mb-6">
          <button type="button" className={keyClass} onClick={clear}>{labels?.clear ?? 'C'}</button>
          <button type="button" className={keyClass} onClick={() => pressDigit('7')}>7</button>
          <button type="button" className={keyClass} onClick={() => pressDigit('8')}>8</button>
          <button type="button" className={keyClass} onClick={() => pressDigit('9')}>9</button>

          <button type="button" className={keyClass} onClick={pressComma}>,</button>
          <button type="button" className={keyClass} onClick={() => pressDigit('4')}>4</button>
          <button type="button" className={keyClass} onClick={() => pressDigit('5')}>5</button>
          <button type="button" className={keyClass} onClick={() => pressDigit('6')}>6</button>

          <button type="button" className={keyClass} onClick={() => pressDigit('0')}>0</button>
          <button type="button" className={keyClass} onClick={() => pressDigit('1')}>1</button>
          <button type="button" className={keyClass} onClick={() => pressDigit('2')}>2</button>
          <button type="button" className={keyClass} onClick={() => pressDigit('3')}>3</button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <button
            type="button"
            className="h-[62px] rounded-lg bg-pos-panel border border-pos-border text-xl text-pos-text active:bg-green-500"
            onClick={onCancel}
          >
            {labels?.cancel ?? 'Cancel'}
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            className={`h-[62px] rounded-lg text-xl font-medium ${
              canConfirm
                ? 'bg-green-600 text-white active:bg-green-500'
                : 'bg-pos-panel border border-pos-border text-pos-muted opacity-50 cursor-not-allowed'
            }`}
            onClick={confirm}
          >
            {labels?.confirm ?? 'Ok'}
          </button>
        </div>
      </div>
    </div>
  );
}
