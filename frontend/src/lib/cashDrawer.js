import { POS_API_PREFIX as API } from './apiOrigin.js';
import { posTerminalAuthHeaders } from './posTerminalSession.js';

/**
 * Ask the backend to open the cash drawer (it is plugged into the main receipt printer).
 * `reason` 'sale' = after a cash payment; the backend skips it when the device setting
 * "Open cash drawer after order" is off. 'manual' = the cashier's Drawer button.
 * Resolves to `{ opened }`, or throws with the backend's message.
 */
export async function openCashDrawer(reason, userId = null) {
  const res = await fetch(`${API}/printers/open-drawer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...posTerminalAuthHeaders() },
    body: JSON.stringify({ reason, userId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success !== true) {
    throw new Error(data?.error || 'Could not open the cash drawer.');
  }
  return { opened: data?.data?.opened === true };
}
