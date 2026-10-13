import React, { useMemo, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { POS_API_PREFIX as API } from '../lib/apiOrigin.js';
import { posTerminalAuthHeaders } from '../lib/posTerminalSession.js';

const KEYS = [
  ['C', '7', '8', '9'],
  [',', '4', '5', '6'],
  ['0', '1', '2', '3']
];

const formatEuro = (n) => `€ ${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace('.', ',')}`;

export function DiscountModal({ open, total = 0, target = null, onApplied, onClose }) {
  const { t } = useLanguage();
  const tr = (key, fallback) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };
  const [mode, setMode] = useState('amount');
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const parsed = useMemo(() => {
    const normalized = String(input || '').replace(',', '.');
    const value = Number(normalized);
    return Number.isFinite(value) ? value : 0;
  }, [input]);

  // With lines selected the dialog prices only those lines; with none it prices the whole order.
  const selectedCount = Array.isArray(target?.itemIds) ? target.itemIds.length : 0;
  const baseTotal = Number.isFinite(Number(target?.total)) ? Number(target.total) : Number(total);
  const orderTotal = Math.round((Number(baseTotal) || 0) * 100) / 100;

  /** Amount mode subtracts the typed euros; percentage mode subtracts that share of the total. */
  const discountValue = useMemo(() => {
    const raw = mode === 'percentage' ? (orderTotal * parsed) / 100 : parsed;
    // Never discount more than the order is worth, and never turn a discount into a surcharge.
    return Math.min(Math.max(Math.round(raw * 100) / 100, 0), orderTotal);
  }, [mode, orderTotal, parsed]);

  const discountedTotal = Math.round((orderTotal - discountValue) * 100) / 100;

  const applyDiscount = async () => {
    const orderId = target?.orderId;
    if (!orderId) {
      setError(tr('discountNoOrder', 'No open order to discount.'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${API}/orders/${encodeURIComponent(orderId)}/discount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...posTerminalAuthHeaders() },
        body: JSON.stringify({ mode, value: parsed, itemIds: target?.itemIds || [] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Discount failed (${res.status})`);
      await onApplied?.();
      setInput('');
      onClose?.();
    } catch (e) {
      setError(e?.message || tr('discountFailed', 'Could not apply the discount.'));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-[520px] rounded-md bg-pos-panel px-8 py-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* The same dialog prices a selection or the whole ticket, so say which. */}
        <div className="text-center text-sm text-pos-muted mb-2">
          {selectedCount > 0
            ? `${selectedCount} ${selectedCount === 1 ? tr('discountLine', 'selected line') : tr('discountLines', 'selected lines')}`
            : tr('discountWholeOrder', 'Whole order')}
        </div>
        <div className="grid grid-cols-3 items-center text-4xl text-pos-text mb-5">
          <div className="text-center">{formatEuro(orderTotal)}</div>
          <div className="text-center rounded bg-pos-bg border border-pos-inputBorder py-1 px-2 text-3xl font-semibold">
            {mode === 'percentage'
              ? (input ? `${input} %` : '0 %')
              : (input ? `€ ${input}` : '€ 0,00')}
          </div>
          <div className="text-center text-green-700">{formatEuro(discountedTotal)}</div>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-10">
          <div className="space-y-5">
            <button
              type="button"
              className={`w-full h-[52px] rounded text-xl font-semibold ${mode === 'amount' ? 'bg-pos-bg border border-pos-inputBorder text-green-700' : 'bg-pos-bg border border-pos-inputBorder text-pos-text active:bg-green-500'}`}
              onClick={() => setMode('amount')}
            >
              {tr('discountAmount', 'Amount')}
            </button>
            <button
              type="button"
              className={`w-full h-[52px] rounded text-xl font-semibold ${mode === 'percentage' ? 'bg-pos-bg border border-pos-inputBorder text-green-700' : 'bg-pos-bg border border-pos-inputBorder text-pos-text active:bg-green-500'}`}
              onClick={() => setMode('percentage')}
            >
              {tr('percentage', 'Percentage')}
            </button>
          </div>

          <div className="grid grid-cols-4 gap-4">
            {KEYS.flat().map((key, idx) => {
              if (!key) return <div key={`empty-${idx}`} />;
              return (
                <button
                  key={key}
                  type="button"
                  className="h-[52px] w-[52px] rounded text-4xl font-semibold text-pos-text active:bg-green-500"
                  onClick={() => {
                    if (key === 'C') {
                      setInput('');
                      return;
                    }
                    if (key === ',') {
                      setInput((prev) => (prev.includes(',') ? prev : `${prev},`));
                      return;
                    }
                    setInput((prev) => `${prev}${key}`);
                  }}
                >
                  {key}
                </button>
              );
            })}
          </div>
        </div>

        {error ? <div className="mt-4 text-center text-lg text-rose-400">{error}</div> : null}

        <div className="mt-5 flex justify-between">
          <button
            type="button"
            className="h-[52px] min-w-[160px] rounded text-2xl font-semibold bg-pos-bg border border-pos-inputBorder text-pos-text active:bg-green-500"
            onClick={onClose}
          >
            {tr('cancel', 'Cancel')}
          </button>
          <button
            type="button"
            disabled={parsed <= 0 || saving}
            className={`h-[52px] min-w-[160px] rounded text-2xl font-semibold ${parsed > 0 && !saving ? 'bg-pos-bg border border-pos-inputBorder text-pos-text active:bg-green-500' : 'bg-pos-bg border border-pos-inputBorder text-pos-muted cursor-not-allowed'}`}
            onClick={applyDiscount}
          >
            {tr('ok', 'Ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
