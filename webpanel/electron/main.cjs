const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const path = require("path");

const isDev = !app.isPackaged;

const appIconPath = path.join(__dirname, "..", "public", "icon.png");

/**
 * Kiosk-only shell: the panel runs unattended on a shop PC, so there is no windowed mode, no
 * resize and no menu bar. Ctrl+Q stays bound as the deliberate way out (kiosk swallows the
 * window chrome, and without it the app can only be killed from Task Manager).
 */
function createWindow() {
  const win = new BrowserWindow({
    kiosk: true,
    fullscreen: true,
    resizable: false,
    maximizable: false,
    fullscreenable: true,
    autoHideMenuBar: true,
    show: false,
    icon: appIconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.setMenuBarVisibility(false);

  win.once("ready-to-show", () => {
    // Electron can drop kiosk when the window is shown on a display that changed since creation.
    if (!win.isKiosk()) win.setKiosk(true);
    win.show();
    win.focus();
  });

  // Leaving fullscreen is not reachable through the UI; block the OS/renderer paths too.
  win.on("leave-full-screen", () => {
    if (!win.isDestroyed()) win.setFullScreen(true);
  });

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = String(input.key || "").toLowerCase();
    if (input.control && key === "q") {
      event.preventDefault();
      app.quit();
      return;
    }
    // F11 would drop the window out of fullscreen; swallow it.
    if (key === "f11") {
      event.preventDefault();
      return;
    }
    if (isDev && input.control && input.shift && key === "i") {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  if (isDev) {
    win.loadURL("http://localhost:8080");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// Quit button on the login screen (see preload.cjs).
ipcMain.on("app:quit", () => {
  app.quit();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
