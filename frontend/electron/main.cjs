const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
const path = require('path');
const { registerTerminalBindingHandlers } = require('./terminalBinding.cjs');

const VITE_DEV_URL = 'http://127.0.0.1:5173';
/** Run unpacked Electron against `dist/` (no Vite) — set by npm script or launcher. */
const loadDist = app.isPackaged || process.env.ELECTRON_LOAD_DIST === '1';

/**
 * Print HTML to the OS default printer (no dialog).
 * Uses a hidden window because data: URLs + print in the main fullscreen window are unreliable.
 */
function registerAppQuitHandler() {
  ipcMain.on('pos-app-quit', () => {
    app.quit();
  });
}

function registerPrintHandler() {
  ipcMain.handle('print-periodic-report-html', async (_event, html) => {
    const payload = typeof html === 'string' ? html : '';
    if (!payload.trim()) return { success: false, failureReason: 'empty_html' };

    return new Promise((resolve) => {
      const printWin = new BrowserWindow({
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      let settled = false;
      const finish = (success, failureReason) => {
        if (settled) return;
        settled = true;
        if (!printWin.isDestroyed()) printWin.close();
        resolve({ success, failureReason: failureReason || null });
      };

      printWin.webContents.once('did-fail-load', (_e, _code, desc) => {
        finish(false, desc || 'did-fail-load');
      });

      printWin.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          try {
            printWin.webContents.print(
              { silent: true, printBackground: true },
              (success, failureReason) => {
                finish(!!success, failureReason);
              }
            );
          } catch (err) {
            finish(false, String(err?.message || err));
          }
        }, 150);
      });

      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(payload)}`;
      printWin.loadURL(dataUrl).catch((err) => finish(false, String(err?.message || err)));
    });
  });
}

/**
 * Customer "color display" (Control -> External devices -> Price display).
 *
 * A second frameless fullscreen window on the external monitor, rendering the same bundle at
 * the HashRouter route `#/price-display` (the sales ticket only, no cashier chrome). The POS
 * window pushes order snapshots over IPC and they are relayed here.
 */
let mainWindow = null;
let customerWindow = null;
let customerDisplayType = 'disabled';
let customerDisplayState = null;

const CUSTOMER_DISPLAY_HASH = '/price-display';

function findExternalDisplay() {
  const primary = screen.getPrimaryDisplay();
  const posBounds =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : primary.bounds;
  const posDisplay = screen.getDisplayMatching(posBounds);
  return screen.getAllDisplays().find((d) => d.id !== posDisplay.id) || null;
}

function closeCustomerWindow() {
  if (customerWindow && !customerWindow.isDestroyed()) customerWindow.close();
  customerWindow = null;
}

function syncCustomerWindow() {
  if (customerDisplayType !== 'color-display') {
    closeCustomerWindow();
    return;
  }
  // With a single monitor the display window would cover the till itself.
  const display = findExternalDisplay();
  if (!display) {
    closeCustomerWindow();
    return;
  }
  const { x, y, width, height } = display.bounds;
  if (customerWindow && !customerWindow.isDestroyed()) {
    customerWindow.setFullScreen(false);
    customerWindow.setBounds({ x, y, width, height });
    customerWindow.setFullScreen(true);
    return;
  }
  customerWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: '#2c3e50',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  customerWindow.setMenuBarVisibility(false);
  customerWindow.once('ready-to-show', () => {
    if (!customerWindow || customerWindow.isDestroyed()) return;
    customerWindow.setBounds({ x, y, width, height });
    customerWindow.setFullScreen(true);
    // showInactive: the cashier keeps focus on the till while this opens.
    customerWindow.showInactive();
  });
  customerWindow.on('closed', () => {
    customerWindow = null;
  });
  if (loadDist) {
    customerWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      hash: CUSTOMER_DISPLAY_HASH,
    });
  } else {
    customerWindow.loadURL(`${VITE_DEV_URL}/#${CUSTOMER_DISPLAY_HASH}`);
  }
}

function registerCustomerDisplayHandlers() {
  ipcMain.on('customer-display:configure', (_event, type) => {
    customerDisplayType = typeof type === 'string' ? type : 'disabled';
    syncCustomerWindow();
  });
  ipcMain.on('customer-display:update', (_event, state) => {
    customerDisplayState = state || null;
    if (customerWindow && !customerWindow.isDestroyed()) {
      customerWindow.webContents.send('customer-display:state', customerDisplayState);
    }
  });
  ipcMain.handle('customer-display:get-state', () => customerDisplayState);
  // Plugging or unplugging the second screen must open or close the display window.
  screen.on('display-added', syncCustomerWindow);
  screen.on('display-removed', syncCustomerWindow);
}

function createWindow() {
  const win = new BrowserWindow({
    show: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    }
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    closeCustomerWindow();
  });

  win.setMenuBarVisibility(false);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });

  win.once('ready-to-show', () => {
    win.setFullScreen(true);
    win.show();
  });

  if (loadDist) {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    win.loadURL(VITE_DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerAppQuitHandler();
  registerTerminalBindingHandlers(ipcMain, app);
  registerPrintHandler();
  registerCustomerDisplayHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
