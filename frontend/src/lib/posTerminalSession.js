const STORAGE_KEY = 'pos-terminal-jwt';

export function getPosTerminalToken() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && String(v).trim() ? String(v).trim() : null;
  } catch {
    return null;
  }
}

export function setPosTerminalToken(token) {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, String(token).trim());
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function clearPosTerminalToken() {
  setPosTerminalToken(null);
}

export function posTerminalAuthHeaders() {
  const t = getPosTerminalToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/**
 * The register name + IP typed on the device screen are kept as well as the token,
 * so the terminal can be registered again by itself after a restart, an expired
 * token or a backend that no longer accepts it. In the desktop app they also go to
 * a file in the app's data folder, which -- unlike browser storage -- does not
 * depend on the page's origin.
 */
const BINDING_KEY = 'pos-terminal-binding';

function isBinding(value) {
  return Boolean(value)
    && typeof value.name === 'string' && value.name.trim() !== ''
    && typeof value.ip === 'string' && value.ip.trim() !== '';
}

/** The register name + IP saved when this terminal was last registered, or null. */
export async function loadTerminalBinding() {
  try {
    const fromApp = await window.posElectronApp?.getTerminalBinding?.();
    if (isBinding(fromApp)) return { name: fromApp.name, ip: fromApp.ip };
  } catch {
    /* not running in the desktop app */
  }
  try {
    const stored = JSON.parse(localStorage.getItem(BINDING_KEY) || 'null');
    if (isBinding(stored)) return { name: stored.name, ip: stored.ip };
  } catch {
    /* ignore */
  }
  return null;
}

/** Remember the register name + IP for the next start; null forgets them. */
export function saveTerminalBinding(binding) {
  const value = isBinding(binding) ? { name: binding.name.trim(), ip: binding.ip.trim() } : null;
  try {
    if (value) localStorage.setItem(BINDING_KEY, JSON.stringify(value));
    else localStorage.removeItem(BINDING_KEY);
  } catch {
    /* ignore */
  }
  try {
    window.posElectronApp?.setTerminalBinding?.(value)?.catch?.(() => {});
  } catch {
    /* not running in the desktop app */
  }
}

/** Ask the backend to bind this terminal: `{ token }` on success, `{ error }` otherwise. */
export async function requestTerminalBind(apiPrefix, { name, ip }) {
  const res = await fetch(`${apiPrefix}/pos-registers/terminal-bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ip }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) return { error: data.error ? String(data.error) : '' };
  return { token: String(data.token) };
}
