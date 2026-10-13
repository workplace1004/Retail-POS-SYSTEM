import { useEffect, useRef } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { useCustomerDisplayOrderSubscriber } from '../hooks/useCustomerDisplayOrderSync.js';

function formatEuro(n) {
  const v = Number(n) || 0;
  return `€ ${v.toFixed(2).replace('.', ',')}`;
}

/**
 * Customer-facing screen on the secondary monitor ("Color display"): the running sales ticket
 * and its total, nothing else. During a cash payment the total is replaced by received/change.
 */
export function CustomerDisplayPage() {
  const { t } = useLanguage();
  const { ticket } = useCustomerDisplayOrderSubscriber();
  const listEndRef = useRef(null);

  const lines = ticket?.lines ?? [];
  const total = ticket?.total ?? 0;
  const customerName = ticket?.customerName ?? null;
  const payment = ticket?.payment ?? null;

  useEffect(() => {
    document.title = 'Retail POS – Customer display';
  }, []);

  // Keep the newest line in view as the cashier scans.
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [lines.length, ticket?.updatedAt, payment]);

  return (
    <div className="flex h-screen w-screen cursor-none select-none flex-col bg-pos-bg text-pos-text">
      <div className="min-h-0 flex-1 overflow-hidden p-6">
        <div className="h-full overflow-y-auto rounded-2xl bg-white p-6 text-pos-bg">
          {customerName ? (
            <div className="mb-3 border-b border-slate-200 pb-3 text-2xl text-slate-500">
              {customerName}
            </div>
          ) : null}

          {lines.length === 0 ? (
            <p className="mt-16 text-center text-4xl text-slate-400">{t('welcome')}</p>
          ) : (
            lines.map((row) => (
              <div key={row.id} className="border-b border-slate-200 py-3 last:border-b-0">
                <div className="flex items-baseline justify-between gap-6 text-3xl">
                  <span className="font-semibold">{row.mainText}</span>
                  {row.originalAmount != null && row.discountLabel ? (
                    // Same three-part treatment as the ticket: was, discount, now.
                    <span className="flex shrink-0 items-baseline gap-3 font-semibold tabular-nums">
                      <span className="line-through opacity-60">
                        {formatEuro(row.originalAmount)}
                      </span>
                      <span className="text-xl font-normal">{row.discountLabel}</span>
                      <span className="text-green-700">{formatEuro(row.mainAmount)}</span>
                    </span>
                  ) : (
                    <span className="shrink-0 font-semibold tabular-nums">
                      {formatEuro(row.mainAmount)}
                    </span>
                  )}
                </div>
                {(row.sublines || []).map((sl, idx) => (
                  <div
                    key={`${row.id}-sl-${idx}`}
                    className="flex items-baseline justify-between gap-6 pl-10 text-2xl opacity-80"
                  >
                    <span>{sl.text}</span>
                    <span className="shrink-0 tabular-nums">{formatEuro(sl.amount)}</span>
                  </div>
                ))}
              </div>
            ))
          )}
          <div ref={listEndRef} />
        </div>
      </div>

      {payment ? (
        <div className="flex items-center justify-around bg-pos-dark px-10 py-8">
          <span className="flex flex-col items-center gap-2">
            <span className="text-4xl font-semibold">{t('received')}</span>
            <span className="text-6xl font-bold tabular-nums">{formatEuro(payment.received)}</span>
          </span>
          <span className="flex flex-col items-center gap-2">
            <span className="text-4xl font-semibold">{t('change')}</span>
            <span className="text-7xl font-bold tabular-nums text-green-400">
              {formatEuro(payment.change)}
            </span>
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-between bg-pos-dark px-10 py-8">
          <span className="text-5xl font-semibold">{t('total')}</span>
          <span className="text-7xl font-bold tabular-nums text-green-400">
            {formatEuro(total)}
          </span>
        </div>
      )}
    </div>
  );
}
