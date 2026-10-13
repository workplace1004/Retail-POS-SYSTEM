import { DEFAULT_BACKEND_PORT, LOCAL_BACKEND_ORIGIN, getSavedBackendBaseUrl } from "@/lib/backendSettings";

/** Session token for webpanel API (set after login). */
export const WEBPANEL_TOKEN_KEY = "retail_webpanel_token";

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function getWebpanelToken(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(WEBPANEL_TOKEN_KEY);
}

export function setWebpanelToken(token: string | null): void {
  if (typeof sessionStorage === "undefined") return;
  if (token) sessionStorage.setItem(WEBPANEL_TOKEN_KEY, token);
  else sessionStorage.removeItem(WEBPANEL_TOKEN_KEY);
}

function envApiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || "";
}

/** When the address is baked in at build time the startup settings gate has nothing to ask about. */
export function isApiBaseUrlPinnedByEnv(): boolean {
  return envApiBaseUrl().length > 0;
}

/**
 * Precedence: build-time env override, then the address configured on this machine (the startup
 * BackendSettingsGate), then the page host, then loopback.
 */
export function getApiBaseUrl() {
  const envBase = envApiBaseUrl();
  if (envBase) return trimSlash(envBase);
  const saved = getSavedBackendBaseUrl();
  if (saved) return trimSlash(saved);
  if (typeof window === "undefined") return LOCAL_BACKEND_ORIGIN;
  const { protocol, hostname } = window.location;
  // The packaged Electron build loads `dist/index.html` with `loadFile`, so the page is
  // `file://` with an empty hostname — deriving from it yields the unfetchable `file://:4000`.
  if (protocol !== "http:" && protocol !== "https:") return LOCAL_BACKEND_ORIGIN;
  if (!hostname) return LOCAL_BACKEND_ORIGIN;
  return `${protocol}//${hostname}:${DEFAULT_BACKEND_PORT}`;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getWebpanelToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    headers,
    ...init,
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `Request failed (${response.status})`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
