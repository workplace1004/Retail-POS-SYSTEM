import { describe, it, expect, afterEach } from "vitest";
import { getApiBaseUrl } from "@/lib/api";
import { BACKEND_SETTINGS_KEY } from "@/lib/backendSettings";

const realLocation = window.location;

function setLocation(protocol: string, hostname: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { protocol, hostname },
  });
}

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  localStorage.clear();
});

function saveBackend(protocol: string, host: string, port: string) {
  localStorage.setItem(BACKEND_SETTINGS_KEY, JSON.stringify({ protocol, host, port }));
}

describe("getApiBaseUrl", () => {
  it("derives the backend origin from the page host over http", () => {
    setLocation("http:", "192.168.1.20");
    expect(getApiBaseUrl()).toBe("http://192.168.1.20:4000");
  });

  it("falls back to loopback under file:// (packaged Electron build)", () => {
    setLocation("file:", "");
    expect(getApiBaseUrl()).toBe("http://127.0.0.1:4000");
  });

  it("falls back to loopback when the hostname is empty", () => {
    setLocation("http:", "");
    expect(getApiBaseUrl()).toBe("http://127.0.0.1:4000");
  });

  it("prefers the address configured on this machine over the page host", () => {
    setLocation("http:", "192.168.1.20");
    saveBackend("http", "10.0.0.5", "4100");
    expect(getApiBaseUrl()).toBe("http://10.0.0.5:4100");
  });

  it("uses the configured address under file://, where nothing can be derived", () => {
    setLocation("file:", "");
    saveBackend("https", "pos.example.com", "443");
    expect(getApiBaseUrl()).toBe("https://pos.example.com:443");
  });

  it("ignores a stored address with an unusable port", () => {
    setLocation("file:", "");
    saveBackend("http", "10.0.0.5", "nope");
    expect(getApiBaseUrl()).toBe("http://127.0.0.1:4000");
  });
});
