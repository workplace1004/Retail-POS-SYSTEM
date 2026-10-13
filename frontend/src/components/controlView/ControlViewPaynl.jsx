import React from 'react';
import { SmallKeyboardWithNumpad } from '../SmallKeyboardWithNumpad';

const FIELD_CLASS =
  'px-4 w-[220px] py-3 bg-pos-panel h-[40px] border border-gray-300 rounded-lg text-gray-200 placeholder-pos-muted focus:outline-none focus:border-green-500';

/**
 * Pay.nl Cloud Connect settings: payments are started through Pay.nl's online API, so this takes
 * the sales location (SL-), the API token (AT- code + token) and the terminal to pay on (TH-).
 * "Find terminals" lists the account's terminals and fills the terminal code in.
 */
export function ControlViewPaynl({
  tr,
  paynlName,
  setPaynlName,
  setPaynlActiveField,
  paynlServiceId,
  setPaynlServiceId,
  paynlTokenCode,
  setPaynlTokenCode,
  paynlApiToken,
  setPaynlApiToken,
  paynlTerminalCode,
  setPaynlTerminalCode,
  paynlTerminals,
  paynlLoadingTerminals,
  paynlTerminalsError,
  handleLoadPaynlTerminals,
  savingPaynl,
  handleSavePaynl,
  paynlKeyboardValue,
  paynlKeyboardOnChange,
}) {
  const terminals = Array.isArray(paynlTerminals) ? paynlTerminals : [];

  return (
    <div className="relative min-h-[570px] rounded-xl border border-pos-border bg-pos-panel/30 p-4">
      <div className="flex text-sm gap-x-10 gap-y-4 mb-2">
        <div className="grid grid-cols-2 gap-4 pt-[10px] w-full justify-center items-center">
          <div className="flex items-center gap-2">
            <label className="block text-pos-text font-medium min-w-[120px] max-w-[120px] shrink-0">
              {tr('control.paynl.name', 'Name *')}
            </label>
            <input
              type="text"
              value={paynlName}
              onChange={(e) => setPaynlName(e.target.value)}
              onFocus={() => setPaynlActiveField('name')}
              onClick={() => setPaynlActiveField('name')}
              className={FIELD_CLASS}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="block text-pos-text font-medium min-w-[120px] max-w-[120px] shrink-0">
              {tr('control.paynl.serviceId', 'Service ID *')}
            </label>
            <input
              type="text"
              value={paynlServiceId}
              onChange={(e) => setPaynlServiceId(e.target.value)}
              onFocus={() => setPaynlActiveField('serviceId')}
              onClick={() => setPaynlActiveField('serviceId')}
              placeholder={tr('control.paynl.serviceIdPlaceholder', 'SL-1234-5678')}
              className={FIELD_CLASS}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="block text-pos-text font-medium min-w-[120px] max-w-[120px] shrink-0">
              {tr('control.paynl.tokenCode', 'Token code *')}
            </label>
            <input
              type="text"
              value={paynlTokenCode}
              onChange={(e) => setPaynlTokenCode(e.target.value)}
              onFocus={() => setPaynlActiveField('tokenCode')}
              onClick={() => setPaynlActiveField('tokenCode')}
              placeholder={tr('control.paynl.tokenCodePlaceholder', 'AT-1234-5678')}
              className={FIELD_CLASS}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="block text-pos-text font-medium min-w-[120px] max-w-[120px] shrink-0">
              {tr('control.paynl.apiToken', 'API token *')}
            </label>
            <input
              type="text"
              value={paynlApiToken}
              onChange={(e) => setPaynlApiToken(e.target.value)}
              onFocus={() => setPaynlActiveField('apiToken')}
              onClick={() => setPaynlActiveField('apiToken')}
              placeholder={tr('control.paynl.apiTokenPlaceholder', '40-character token')}
              className={FIELD_CLASS}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="block text-pos-text font-medium min-w-[120px] max-w-[120px] shrink-0">
              {tr('control.paynl.terminalCode', 'Terminal code *')}
            </label>
            <input
              type="text"
              value={paynlTerminalCode}
              onChange={(e) => setPaynlTerminalCode(e.target.value)}
              onFocus={() => setPaynlActiveField('terminalCode')}
              onClick={() => setPaynlActiveField('terminalCode')}
              placeholder={tr('control.paynl.terminalCodePlaceholder', 'TH-1234-5678')}
              className={FIELD_CLASS}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-4 py-2 rounded-lg border border-pos-border bg-pos-panel text-pos-text text-sm active:bg-pos-rowHover disabled:opacity-50"
              disabled={paynlLoadingTerminals}
              onClick={handleLoadPaynlTerminals}
            >
              {paynlLoadingTerminals
                ? tr('control.paynl.searching', 'Searching...')
                : tr('control.paynl.discover', 'Find terminals')}
            </button>
          </div>
        </div>
      </div>

      {paynlTerminalsError ? (
        <p className="px-2 text-sm text-red-400">{paynlTerminalsError}</p>
      ) : null}

      {terminals.length > 0 ? (
        <div className="px-2">
          <p className="mb-2 text-xs text-pos-muted">
            {tr('control.paynl.pickTerminal', 'Tap a terminal to use it:')}
          </p>
          <div className="flex flex-wrap gap-2">
            {terminals.map((t) => (
              <button
                key={t.code}
                type="button"
                className={`px-3 py-2 rounded-lg border text-sm ${
                  paynlTerminalCode === t.code
                    ? 'border-green-500 bg-green-600/20 text-pos-text'
                    : 'border-pos-border bg-pos-panel text-pos-muted active:text-pos-text'
                }`}
                onClick={() => {
                  setPaynlTerminalCode(String(t.code || ''));
                  if (t.name) setPaynlName(String(t.name));
                  // A terminal is tied to one sales location; take it over unless one was typed.
                  if (t.serviceId && !String(paynlServiceId || '').trim()) setPaynlServiceId(String(t.serviceId));
                }}
              >
                {t.code}
                {t.name ? ` (${t.name})` : ''}
                {t.status && t.status !== 'ACTIVE' ? ` — ${t.status}` : ''}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex justify-center pt-5 pb-5">
        <button
          type="button"
          className="flex items-center text-lg gap-4 px-6 py-3 rounded-lg bg-green-600 text-white font-medium active:bg-green-500 disabled:opacity-50"
          disabled={savingPaynl}
          onClick={handleSavePaynl}
        >
          <svg fill="#ffffff" width="18px" height="18px" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M-5.732,2.97-7.97.732a2.474,2.474,0,0,0-1.483-.7A.491.491,0,0,0-9.591,0H-18.5A2.5,2.5,0,0,0-21,2.5v11A2.5,2.5,0,0,0-18.5,16h11A2.5,2.5,0,0,0-5,13.5V4.737A2.483,2.483,0,0,0-5.732,2.97ZM-13,1V5.455h-3.591V1Zm-4.272,14V10.545h8.544V15ZM-6,13.5A1.5,1.5,0,0,1-7.5,15h-.228V10.045a.5.5,0,0,0-.5-.5h-9.544a.5.5,0,0,0-.5.5V15H-18.5A1.5,1.5,0,0,1-20,13.5V2.5A1.5,1.5,0,0,1-18.5,1h.909V5.955a.5.5,0,0,0,.5.5h7.5a.5.5,0,0,0,.5-.5v-4.8a1.492,1.492,0,0,1,.414.285l2.238,2.238A1.511,1.511,0,0,1-6,4.737Z" transform="translate(21)" /></svg>
          {tr('control.save', 'Save')}
        </button>
      </div>

      <div className="shrink-0 absolute bottom-0">
        <SmallKeyboardWithNumpad value={paynlKeyboardValue} onChange={paynlKeyboardOnChange} />
      </div>
    </div>
  );
}
