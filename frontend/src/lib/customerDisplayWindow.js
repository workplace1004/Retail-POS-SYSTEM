const WINDOW_NAME = 'pos_customer_display';

/**
 * Electron bridge (electron/preload.cjs). When present the main process owns the display
 * window: it places it on the external monitor, sizes it fullscreen and relays snapshots.
 * In a plain browser this is null and the popup path below is used instead.
 * @returns {{ configure: (type: string) => void, update: (state: object) => void, getState: () => Promise<object|null>, onUpdate: (cb: (state: object) => void) => () => void } | null}
 */
export function customerDisplayBridge() {
  if (typeof window === 'undefined') return null;
  return window.posCustomerDisplay || null;
}

/** Tell the Electron main process which price-display mode is active. No-op in the browser. */
export function configureCustomerDisplay(type) {
  const bridge = customerDisplayBridge();
  if (!bridge) return;
  try {
    bridge.configure(String(type || 'disabled'));
  } catch {
    /* ignore */
  }
}

/** @type {Window | null} */
let lastOpenedRef = null;

/**
 * Absolute URL for the customer display route (HashRouter → `#/price-display`).
 * Works for `http(s):` dev/prod and Electron `file:` builds.
 */
export function getCustomerDisplayUrl() {
  const { protocol, href, pathname, search, origin } = window.location;
  const hashRoute = '#/price-display';

  if (protocol === 'file:') {
    const hashIdx = href.indexOf('#');
    if (hashIdx >= 0) {
      return `${href.slice(0, hashIdx)}${hashRoute}`;
    }
    return `${href}${hashRoute}`;
  }

  const base = `${origin}${pathname || '/'}${search || ''}`;
  const hashIdx = base.indexOf('#');
  if (hashIdx >= 0) {
    return `${base.slice(0, hashIdx)}${hashRoute}`;
  }
  return `${base}${hashRoute}`;
}

/**
 * Opens or reuses the named customer window and navigates it to the price-display route.
 * Same window name prevents duplicates; an existing window is navigated to the latest URL.
 * @returns {Window | null}
 */
export function openCustomerDisplayWindow() {
  // Electron places the window itself; a popup here would land on the wrong monitor.
  if (customerDisplayBridge()) {
    configureCustomerDisplay('color-display');
    return null;
  }
  const url = getCustomerDisplayUrl();
  const features = 'menubar=no,toolbar=no,location=no,status=no,width=900,height=700';
  try {
    const w = window.open(url, WINDOW_NAME, features);
    if (w) {
      lastOpenedRef = w;
      try {
        w.focus();
      } catch {
        /* ignore */
      }
    }
    return w;
  } catch {
    return null;
  }
}

/** Best-effort close of the last opened customer window (same session). */
export function closeCustomerDisplayWindow() {
  if (customerDisplayBridge()) {
    configureCustomerDisplay('disabled');
    return;
  }
  try {
    if (lastOpenedRef && !lastOpenedRef.closed) {
      lastOpenedRef.close();
    }
  } catch {
    /* ignore */
  }
  lastOpenedRef = null;
}
