/// <reference types="vite/client" />

interface Window {
  /** Exposed by electron/preload.cjs; undefined when running in a normal browser. */
  electronAPI?: {
    quitApp: () => void;
  };
}
