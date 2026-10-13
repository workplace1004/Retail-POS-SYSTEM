/**
 * Where the backend lives, as configured on this machine.
 *
 * The panel and the API run on different PCs, and `VITE_API_BASE_URL` is baked in at build time,
 * so the packaged Electron build (loaded with `loadFile`, i.e. `file://` with no hostname) has no
 * way to derive the address — see `getApiBaseUrl`. This is the runtime override the user sets in
 * the startup modal; it is read by `@/lib/api`, which must stay the only consumer that builds URLs.
 */

export const DEFAULT_BACKEND_HOST = "127.0.0.1";
export const DEFAULT_BACKEND_PORT = "4000";
export const LOCAL_BACKEND_ORIGIN = `http://${DEFAULT_BACKEND_HOST}:${DEFAULT_BACKEND_PORT}`;

export const BACKEND_SETTINGS_KEY = "retail_webpanel_backend";

export type BackendProtocol = "http" | "https";
export type BackendSettings = { protocol: BackendProtocol; host: string; port: string };

/** Fired on this window after a successful save so open sockets/queries can re-target. */
export const BACKEND_SETTINGS_CHANGED_EVENT = "retail:backend-settings-changed";

export function backendBaseUrl(settings: BackendSettings): string {
  return `${settings.protocol}://${settings.host}:${settings.port}`;
}

function isValidPort(port: string): boolean {
  if (!/^\d{1,5}$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

/**
 * Accepts what people actually type: `192.168.1.20`, `192.168.1.20:4000`, `http://192.168.1.20`,
 * `https://pos.example.com/`. An explicit port field wins over one embedded in the host.
 */
export function parseBackendInput(hostInput: string, portInput: string): BackendSettings | null {
  const rawHost = String(hostInput ?? "").trim();
  const rawPort = String(portInput ?? "").trim();
  if (!rawHost) return null;

  const withScheme = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  const protocol: BackendProtocol = url.protocol === "https:" ? "https" : "http";
  // URL wraps IPv6 in brackets and lowercases the host, which is what we want to store.
  const host = url.hostname;
  if (!host) return null;

  const port = rawPort || url.port || DEFAULT_BACKEND_PORT;
  if (!isValidPort(port)) return null;

  return { protocol, host, port };
}

export function readBackendSettings(): BackendSettings | null {
  if (typeof localStorage === "undefined") return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(BACKEND_SETTINGS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BackendSettings>;
    const host = String(parsed?.host ?? "").trim();
    const port = String(parsed?.port ?? "").trim();
    if (!host || !isValidPort(port)) return null;
    return { protocol: parsed?.protocol === "https" ? "https" : "http", host, port };
  } catch {
    return null;
  }
}

export function getSavedBackendBaseUrl(): string | null {
  const settings = readBackendSettings();
  return settings ? backendBaseUrl(settings) : null;
}

export function saveBackendSettings(settings: BackendSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(BACKEND_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode / quota — the in-memory session still works, it just will not persist */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(BACKEND_SETTINGS_CHANGED_EVENT));
  }
}

export function clearBackendSettings(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(BACKEND_SETTINGS_KEY);
  } catch {
    /* ignore */
  }
}

/** `/api/health` is the backend's no-DB reachability probe (server.js). */
export async function pingBackend(baseUrl: string, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
