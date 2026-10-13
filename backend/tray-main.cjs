/**
 * Electron shell: tray icon only (no window). Spawns runtime/node.exe beside this .exe for both
 * app/server.js (the API) and app/scripts/run-worldline-ctep-bridge.cjs (the Worldline C-TEP Java
 * bridge) — the packaged counterpart of `npm run dev` (scripts/dev-with-bridge.cjs).
 * Each child's stdout/stderr goes to its own log file so startup errors are visible on Windows.
 */
const { app, Tray, Menu, nativeImage, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/** 16×16 fallback when tray-icon.png is missing */
const FALLBACK_ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAAKElEQVQoz2NgoBAwUqifgYEQgZFK9YjFMIhBYgIxGBgYsNiHOQAA+T8FxwtQV14AAAAASUVORK5CYII=',
  'base64',
);

/** Same default as scripts/dev-with-bridge.cjs; services/worldlineCtepPosService.js reads it. */
const BRIDGE_HTTP_URL = process.env.WORLDLINE_CTEP_HTTP_URL || 'http://127.0.0.1:3210';
const BRIDGE_SCRIPT = path.join('scripts', 'run-worldline-ctep-bridge.cjs');

let tray = null;
let bundle = null;
let serverProcess = null;
let bridgeProcess = null;
let serverLogPath = '';
let bridgeLogPath = '';
let bridgeRestartTrigger = '';
let restartingBridge = false;
let shuttingDown = false;

function candidateBundleRoots() {
  const roots = [];
  const push = (p) => {
    if (!p) return;
    const norm = path.normalize(p);
    if (!roots.includes(norm)) roots.push(norm);
  };
  push(path.dirname(process.execPath));
  if (process.resourcesPath) {
    push(process.resourcesPath);
    push(path.join(process.resourcesPath, '..'));
  }
  return roots;
}

/** Find runtime/node.exe + app/server.js (portable / unpacked layouts). */
function resolveServerBundle() {
  for (const base of candidateBundleRoots()) {
    const node = path.join(base, 'runtime', 'node.exe');
    const appDir = path.join(base, 'app');
    if (fs.existsSync(node) && fs.existsSync(path.join(appDir, 'server.js'))) {
      return { node, appDir, base };
    }
  }
  return null;
}

function appendLog(logPath, line) {
  try {
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    /* ignore */
  }
}

function appendServerLog(line) {
  appendLog(serverLogPath, line);
}

function appendBridgeLog(line) {
  appendLog(bridgeLogPath, line);
}

function childEnv() {
  return {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'production',
    WORLDLINE_CTEP_HTTP_URL: BRIDGE_HTTP_URL,
  };
}

function loadTrayIcon() {
  const p = path.join(__dirname, 'tray-icon.png');
  if (fs.existsSync(p)) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    } catch {
      /* fall through */
    }
  }
  return nativeImage.createFromBuffer(FALLBACK_ICON_PNG);
}

function startServer() {
  const { node, appDir } = bundle;
  appendServerLog(`\n[${new Date().toISOString()}] Starting server cwd=${appDir} node=${node}\n`);

  serverProcess = spawn(node, ['server.js'], {
    cwd: appDir,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProcess.stdout.on('data', (buf) => appendServerLog(String(buf)));
  serverProcess.stderr.on('data', (buf) => appendServerLog(String(buf)));

  serverProcess.on('exit', (code, signal) => {
    appendServerLog(`[${new Date().toISOString()}] Server exit code=${code} signal=${signal || ''}\n`);
    serverProcess = null;
    if (signal) return;
    if (code !== 0 && code !== null && Notification.isSupported()) {
      new Notification({
        title: 'Retail Backend',
        body: `Server exited (code ${code}). Log: ${serverLogPath}`,
      }).show();
    }
  });

  return true;
}

/**
 * The bridge is optional at runtime: a missing JRE or terminal only breaks card payments, so a
 * failure here is logged and notified but must never stop the API (same as dev-with-bridge).
 */
function startBridge() {
  const { node, appDir } = bundle;
  const scriptPath = path.join(appDir, BRIDGE_SCRIPT);
  if (!fs.existsSync(scriptPath)) {
    appendBridgeLog(`\n[${new Date().toISOString()}] ERROR: ${scriptPath} is missing from the bundle.\n`);
    return false;
  }

  appendBridgeLog(
    `\n[${new Date().toISOString()}] Starting Worldline C-TEP bridge cwd=${appDir} `
      + `WORLDLINE_CTEP_HTTP_URL=${BRIDGE_HTTP_URL}\n`,
  );

  bridgeProcess = spawn(node, [BRIDGE_SCRIPT], {
    cwd: appDir,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  bridgeProcess.stdout.on('data', (buf) => appendBridgeLog(String(buf)));
  bridgeProcess.stderr.on('data', (buf) => appendBridgeLog(String(buf)));

  bridgeProcess.on('error', (err) => {
    appendBridgeLog(`[${new Date().toISOString()}] Bridge spawn failed: ${err.message}\n`);
  });

  bridgeProcess.on('exit', (code, signal) => {
    appendBridgeLog(`[${new Date().toISOString()}] Bridge exit code=${code} signal=${signal || ''}\n`);
    bridgeProcess = null;
    if (shuttingDown || restartingBridge || signal) return;
    if (code !== 0 && code !== null && Notification.isSupported()) {
      new Notification({
        title: 'Retail Backend',
        body: `Worldline bridge stopped (code ${code}). Card payments will fail. Log: ${bridgeLogPath}`,
      }).show();
    }
  });

  return true;
}

function restartBridge() {
  if (shuttingDown || restartingBridge) return;
  restartingBridge = true;
  appendBridgeLog(`[${new Date().toISOString()}] Restarting bridge after configuration change…\n`);
  const prev = bridgeProcess;
  bridgeProcess = null;
  const finish = () => {
    startBridge();
    restartingBridge = false;
  };
  if (!prev) {
    finish();
    return;
  }
  prev.once('exit', () => setTimeout(finish, 120));
  try {
    prev.kill('SIGTERM');
  } catch {
    setTimeout(finish, 120);
  }
}

/** POST /api/worldline/restart-bridge touches this file; server.js writes it under app/runtime/. */
function watchBridgeRestartTrigger() {
  bridgeRestartTrigger = path.join(bundle.appDir, 'runtime', 'worldline-bridge.restart');
  fs.watchFile(bridgeRestartTrigger, { interval: 500 }, (curr, prev) => {
    if (shuttingDown) return;
    if (curr.mtimeMs && curr.mtimeMs !== prev.mtimeMs) restartBridge();
  });
}

function stopChild(child) {
  if (child && !child.killed) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

function stopServer() {
  shuttingDown = true;
  try {
    if (bridgeRestartTrigger) fs.unwatchFile(bridgeRestartTrigger);
  } catch {
    /* ignore */
  }
  stopChild(bridgeProcess);
  stopChild(serverProcess);
  bridgeProcess = null;
  serverProcess = null;
}

function revealLog(logPath) {
  if (logPath && fs.existsSync(logPath)) shell.showItemInFolder(logPath);
}

function createTray() {
  const icon = loadTrayIcon();
  const sized = icon.isEmpty() ? nativeImage.createFromBuffer(FALLBACK_ICON_PNG) : icon;
  tray = new Tray(sized.resize({ width: 16, height: 16 }));
  tray.setToolTip('Retail Backend — http://localhost:4000');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Retail Backend (API running)', enabled: false },
      { label: 'Open server log…', click: () => revealLog(serverLogPath) },
      { label: 'Open Worldline bridge log…', click: () => revealLog(bridgeLogPath) },
      { type: 'separator' },
      {
        label: 'Restart Worldline bridge',
        click: () => restartBridge(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          stopServer();
          app.quit();
        },
      },
    ]),
  );
}

/**
 * Give this tray its own identity before taking the single-instance lock. Electron keys the lock
 * (and the log folder) on userData, which defaults to the launcher's package name. The RES POS
 * backend ships the same launcher package ("pos-backend-tray"), so on a PC with both installed the
 * shared lock made whichever started second quit instantly - no server, nothing on :4000.
 */
app.setName('Retail Backend');
app.setPath('userData', path.join(app.getPath('appData'), 'Retail Backend'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    /* optional: focus nothing */
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.retail.backend.tray');
    }
    let logDir;
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      logDir = app.getPath('userData');
    } catch {
      logDir = app.getPath('temp');
    }
    serverLogPath = path.join(logDir, 'backend-server.log');
    bridgeLogPath = path.join(logDir, 'worldline-bridge.log');

    bundle = resolveServerBundle();
    if (!bundle) {
      const tried = candidateBundleRoots().join('\n');
      console.error('Retail Backend: could not find runtime\\node.exe and app\\server.js. Tried:\n', tried);
      appendServerLog(`\n[${new Date().toISOString()}] ERROR: bundle not found. Tried:\n${tried}\n`);
      if (Notification.isSupported()) {
        new Notification({
          title: 'Retail Backend',
          body: `Could not start API. See log: ${serverLogPath}`,
        }).show();
      }
      app.quit();
      return;
    }

    startServer();
    startBridge();
    watchBridgeRestartTrigger();
    createTray();
  });

  app.on('window-all-closed', (e) => e.preventDefault());
  app.on('before-quit', () => stopServer());
}
