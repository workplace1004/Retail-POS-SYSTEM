/**
 * Cancel a card payment on the terminal and report honestly whether the device was reached.
 *
 * The backend answers `{ ok, deliveredToTerminal, warning }` because a cancel the terminal never
 * accepted still leaves it waiting for the card. Callers used to do `fetch(...).catch(() => {})`,
 * which threw that away and showed the operator a clean "cancelled" either way.
 *
 * @returns {Promise<string|null>} warning to show, or null when the terminal really was cancelled.
 */
export async function requestTerminalCancel(apiBase, provider, sessionId, extraHeaders = {}) {
  try {
    const res = await fetch(
      `${apiBase}/${provider}/cancel/${encodeURIComponent(sessionId)}`,
      { method: 'POST', headers: { ...extraHeaders } },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      return data?.error || `Cancel failed (${res.status}). Cancel on the terminal itself.`;
    }
    return data?.warning || null;
  } catch (e) {
    return `Could not reach the server to cancel: ${e?.message || e}. Cancel on the terminal itself.`;
  }
}

/**
 * After a cancel: did the terminal take the card anyway? A card presented in the same moment as
 * the cancel is charged, so the terminal's own answer decides, not the cancel request. When this
 * is true the till must book the payment instead of showing "cancelled".
 */
export async function terminalApprovedDespiteCancel(apiBase, provider, sessionId, extraHeaders = {}) {
  try {
    const res = await fetch(
      `${apiBase}/${provider}/status/${encodeURIComponent(sessionId)}`,
      { headers: { ...extraHeaders } },
    );
    const data = await res.json().catch(() => ({}));
    return res.ok && String(data?.state || '').toUpperCase() === 'APPROVED';
  } catch {
    return false;
  }
}
