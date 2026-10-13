/** localStorage key written from Control → External devices → Price display. */
export const POS_PRICE_DISPLAY_STORAGE_KEY = 'pos_price_display';

/** Dispatched on the same document after saving price display settings (storage event does not fire in-tab). */
export const POS_PRICE_DISPLAY_SETTINGS_CHANGED_EVENT = 'pos-price-display-settings-changed';

/** Serial pole device (no screen). */
export const PRICE_DISPLAY_TWO_LINE = 'two-line-display';

/** The only mode that drives a customer-facing screen on the secondary monitor. */
export const PRICE_DISPLAY_COLOR = 'color-display';

export function readPriceDisplayType() {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(POS_PRICE_DISPLAY_STORAGE_KEY);
    if (!raw) return 'disabled';
    const s = JSON.parse(raw);
    return s?.type != null ? String(s.type) : 'disabled';
  } catch {
    return 'disabled';
  }
}

/** True when the customer screen should be shown on the secondary monitor. */
export function isColorDisplayEnabled() {
  return readPriceDisplayType() === PRICE_DISPLAY_COLOR;
}

export function notifyPriceDisplaySettingsChanged() {
  try {
    window.dispatchEvent(new CustomEvent(POS_PRICE_DISPLAY_SETTINGS_CHANGED_EVENT));
  } catch {
    /* ignore */
  }
}
