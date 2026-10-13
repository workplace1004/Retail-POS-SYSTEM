import { io, type Socket } from "socket.io-client";
import { getApiBaseUrl } from "@/lib/api";
import { LOCAL_BACKEND_ORIGIN } from "@/lib/backendSettings";

let socketSingleton: Socket | null = null;

export function getRealtimeSocket(): Socket {
  if (socketSingleton) return socketSingleton;
  const base = getApiBaseUrl();
  let origin = LOCAL_BACKEND_ORIGIN;
  try {
    origin = new URL(base).origin;
  } catch {
    /* keep fallback */
  }
  socketSingleton = io(origin, { path: "/socket.io" });
  return socketSingleton;
}

/** Drop the connection so the next getRealtimeSocket() dials the newly configured backend. */
export function resetRealtimeSocket(): void {
  const socket = socketSingleton;
  socketSingleton = null;
  if (!socket) return;
  try {
    socket.disconnect();
  } catch {
    /* ignore */
  }
}
