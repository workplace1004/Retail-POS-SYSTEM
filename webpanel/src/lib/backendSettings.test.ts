import { describe, it, expect, afterEach } from "vitest";
import {
  BACKEND_SETTINGS_KEY,
  backendBaseUrl,
  getSavedBackendBaseUrl,
  parseBackendInput,
  readBackendSettings,
  saveBackendSettings,
} from "@/lib/backendSettings";

afterEach(() => {
  localStorage.clear();
});

describe("parseBackendInput", () => {
  it("accepts a bare host and defaults the port", () => {
    expect(parseBackendInput("192.168.1.20", "")).toEqual({
      protocol: "http",
      host: "192.168.1.20",
      port: "4000",
    });
  });

  it("takes the port from the port field", () => {
    expect(parseBackendInput("192.168.1.20", "4100")).toEqual({
      protocol: "http",
      host: "192.168.1.20",
      port: "4100",
    });
  });

  it("reads a port embedded in the host when the port field is empty", () => {
    expect(parseBackendInput("192.168.1.20:5000", "")).toEqual({
      protocol: "http",
      host: "192.168.1.20",
      port: "5000",
    });
  });

  it("lets an explicit port field win over one embedded in the host", () => {
    expect(parseBackendInput("192.168.1.20:5000", "4000")?.port).toBe("4000");
  });

  it("keeps an https scheme and strips a trailing path", () => {
    expect(parseBackendInput("https://pos.example.com/", "443")).toEqual({
      protocol: "https",
      host: "pos.example.com",
      port: "443",
    });
  });

  it("rejects an empty host, a non-numeric port and an out-of-range port", () => {
    expect(parseBackendInput("", "4000")).toBeNull();
    expect(parseBackendInput("192.168.1.20", "abc")).toBeNull();
    expect(parseBackendInput("192.168.1.20", "70000")).toBeNull();
  });
});

describe("backendBaseUrl", () => {
  it("builds the origin the API client fetches against", () => {
    expect(backendBaseUrl({ protocol: "http", host: "10.0.0.5", port: "4000" })).toBe(
      "http://10.0.0.5:4000",
    );
  });
});

describe("readBackendSettings", () => {
  it("round-trips a saved address", () => {
    saveBackendSettings({ protocol: "http", host: "10.0.0.5", port: "4100" });
    expect(readBackendSettings()).toEqual({ protocol: "http", host: "10.0.0.5", port: "4100" });
    expect(getSavedBackendBaseUrl()).toBe("http://10.0.0.5:4100");
  });

  it("returns null when nothing is stored", () => {
    expect(readBackendSettings()).toBeNull();
    expect(getSavedBackendBaseUrl()).toBeNull();
  });

  it("ignores malformed or incomplete stored entries", () => {
    localStorage.setItem(BACKEND_SETTINGS_KEY, "not json");
    expect(readBackendSettings()).toBeNull();

    localStorage.setItem(BACKEND_SETTINGS_KEY, JSON.stringify({ host: "10.0.0.5" }));
    expect(readBackendSettings()).toBeNull();

    localStorage.setItem(BACKEND_SETTINGS_KEY, JSON.stringify({ host: "", port: "4000" }));
    expect(readBackendSettings()).toBeNull();
  });
});
