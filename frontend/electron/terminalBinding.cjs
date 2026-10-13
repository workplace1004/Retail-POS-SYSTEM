const fs = require('fs');
const path = require('path');

/**
 * The register name + IP this terminal was registered with on the device screen,
 * kept in a file in the application's own data folder. Browser storage belongs to
 * the page's origin, so a dev server on another port (or localhost instead of
 * 127.0.0.1) starts with none of it; this file belongs to the app and survives
 * that as well as every restart.
 */
function bindingFile(app) {
  return path.join(app.getPath('userData'), 'terminal-binding.json');
}

function isBinding(value) {
  return Boolean(value)
    && typeof value.name === 'string' && value.name.trim() !== ''
    && typeof value.ip === 'string' && value.ip.trim() !== '';
}

function registerTerminalBindingHandlers(ipcMain, app) {
  ipcMain.handle('terminal-binding:get', () => {
    try {
      const value = JSON.parse(fs.readFileSync(bindingFile(app), 'utf8'));
      return isBinding(value) ? { name: value.name, ip: value.ip } : null;
    } catch {
      return null;
    }
  });
  ipcMain.handle('terminal-binding:set', (_event, value) => {
    try {
      if (isBinding(value)) {
        fs.writeFileSync(bindingFile(app), JSON.stringify({ name: value.name.trim(), ip: value.ip.trim() }));
      } else {
        fs.rmSync(bindingFile(app), { force: true });
      }
      return true;
    } catch {
      return false;
    }
  });
}

module.exports = { registerTerminalBindingHandlers };
