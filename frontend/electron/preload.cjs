const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posElectronPrint', {
  printHtml: (html) => ipcRenderer.invoke('print-periodic-report-html', html),
});

/**
 * Customer-facing "color display" on the secondary monitor. The POS window pushes order
 * snapshots; the main process relays them to the display window (electron/main.cjs).
 */
contextBridge.exposeInMainWorld('posCustomerDisplay', {
  configure: (type) => ipcRenderer.send('customer-display:configure', type),
  update: (state) => ipcRenderer.send('customer-display:update', state),
  getState: () => ipcRenderer.invoke('customer-display:get-state'),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('customer-display:state', listener);
    return () => ipcRenderer.removeListener('customer-display:state', listener);
  },
});

contextBridge.exposeInMainWorld('posElectronApp', {
  /** Request the Electron main process to quit the application. */
  quit: () => {
    ipcRenderer.send('pos-app-quit');
  },
  /** The register name + IP this terminal was registered with, or null. */
  getTerminalBinding: () => ipcRenderer.invoke('terminal-binding:get'),
  /** Remember (or, with null, forget) the register name + IP for the next start. */
  setTerminalBinding: (binding) => ipcRenderer.invoke('terminal-binding:set', binding),
});
