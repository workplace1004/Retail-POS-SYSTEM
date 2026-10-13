#!/usr/bin/env node
/**
 * Windows: release/ with:
 * - retail-backend/ — unpacked app (retail-backend.exe, runtime/, app/)
 * - retail-backend.exe — NSIS installer (CRC self-check disabled for flaky copies)
 * - retail-backend-portable.exe — no wizard; unpacks to temp (also CRCCheck off)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const defaultReleaseOut = path.join(root, 'release', 'retail-backend');
const elauncher = path.join(root, 'electron-tray-launcher');

/** Tiny PNG fallback if frontend app icon is missing */
const FALLBACK_TRAY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAAKElEQVQoz2NgoBAwUqifgYEQgZFK9YjFMIhBYgIxGBgYsNiHOQAA+T8FxwtQV14AAAAASUVORK5CYII=',
  'base64',
);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function rmrfTry(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* wait */
  }
}

/** Windows: EXE running or Explorer preview often holds locks; retry before giving up. */
function rmrfTryRetries(p, attempts = 6, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    if (rmrfTry(p)) return true;
    if (i < attempts - 1) sleepSync(delayMs);
  }
  return false;
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, name.name);
    const d = path.join(destDir, name.name);
    if (name.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Copy unpacked app to final folder. Do not delete src (Windows often holds locks on win-unpacked). */
function copyUnpackedToOut(unpackedDir, destDir) {
  if (!rmrfTryRetries(destDir)) {
    throw new Error(
      `Cannot clear output folder (in use): ${destDir}\n` +
        '  Quit retail-backend.exe (tray → Quit), close Explorer windows on that folder, then run build again.',
    );
  }
  fs.cpSync(unpackedDir, destDir, { recursive: true });
}

function copyNodeRuntime(destRuntimeDir) {
  if (process.platform !== 'win32') {
    console.error('[build-win-exe] Only Windows is supported (need node.exe + DLLs).');
    process.exit(1);
  }
  const nodeDir = path.dirname(process.execPath);
  const nodeExe = process.execPath;
  fs.mkdirSync(destRuntimeDir, { recursive: true });
  if (!fs.existsSync(nodeExe)) {
    console.error('[build-win-exe] Could not find node at', nodeExe);
    process.exit(1);
  }
  copyFile(nodeExe, path.join(destRuntimeDir, 'node.exe'));
  for (const name of fs.readdirSync(nodeDir)) {
    if (!name.toLowerCase().endsWith('.dll')) continue;
    copyFile(path.join(nodeDir, name), path.join(destRuntimeDir, name));
  }
  console.log('[build-win-exe] Copied Node runtime from', nodeDir);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false, windowsHide: true });
  if (r.status !== 0) {
    console.error(`[build-win-exe] Failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status || 1);
  }
}

function runNpmCli(commandLine, cwd) {
  const comspec = process.env.ComSpec || 'cmd.exe';
  const r = spawnSync(comspec, ['/d', '/c', commandLine], {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
    env: process.env,
  });
  if (r.status !== 0) {
    console.error(`[build-win-exe] Failed: ${commandLine}`);
    process.exit(r.status || 1);
  }
}

/**
 * A file server.js imports but that was never staged only fails once the packaged app runs,
 * so check every relative import and prod dependency resolves before building the installers.
 */
function verifyStagedApp(appDir) {
  const missing = [];
  const files = [];

  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Third-party trees: dependencies are checked separately, the JRE holds no app code.
      if (entry.name === 'node_modules' || entry.name === 'runtime') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(p);
      else if (/\.(js|mjs)$/.test(entry.name)) files.push(p);
    }
  };
  collect(appDir);

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      if (!fs.existsSync(path.resolve(path.dirname(file), m[1]))) {
        missing.push(`${path.relative(appDir, file)} imports ${m[1]}`);
      }
    }
  }

  const appPkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const deps = Object.keys(appPkg.dependencies || {});
  for (const dep of deps) {
    if (!fs.existsSync(path.join(appDir, 'node_modules', dep, 'package.json'))) {
      missing.push(`missing dependency node_modules/${dep}`);
    }
  }

  if (missing.length) {
    console.error('[build-win-exe] Staged app is incomplete — the packaged server would not start:');
    for (const line of missing) console.error('  -', line);
    process.exit(1);
  }
  console.log(`[build-win-exe] Verified ${files.length} staged files and ${deps.length} dependencies`);
}

/**
 * Worldline C-TEP bridge. run-worldline-ctep-bridge.cjs resolves its JAR and JRE from its own
 * parent directory, and server.js writes the restart trigger to `<server.js dir>/runtime/`, so
 * app/ must mirror the dev tree exactly: scripts/, worldline-ctep-bridge/, runtime/java/.
 */
function stageWorldlineBridge(appDir) {
  const javaSrc = path.join(root, 'runtime', 'java');
  const javaExe = path.join(javaSrc, 'bin', 'java.exe');
  if (!fs.existsSync(javaExe)) {
    console.error('[build-win-exe] Portable JRE missing:', javaExe);
    console.error(
      '[build-win-exe] The packaged app cannot run the Worldline bridge without it. '
        + 'Run backend\\bat\\INSTALL_PORTABLE_JAVA.bat (or copy a Java 17 x64 JRE to backend\\runtime\\java).',
    );
    process.exit(1);
  }

  copyFile(
    path.join(root, 'scripts', 'run-worldline-ctep-bridge.cjs'),
    path.join(appDir, 'scripts', 'run-worldline-ctep-bridge.cjs'),
  );
  copyDir(path.join(root, 'worldline-ctep-bridge'), path.join(appDir, 'worldline-ctep-bridge'));
  copyDir(javaSrc, path.join(appDir, 'runtime', 'java'));
  console.log('[build-win-exe] Staged Worldline C-TEP bridge + portable JRE');
}

/**
 * Walks the whole prod dependency graph and resolves every edge the way Node would, except the
 * upward node_modules walk stops at appDir.
 *
 * That bound is the point. `serialport/` can be staged while `@serialport/parser-byte-length` is
 * not, and the packaged till then fails on the Scale test with "Cannot find module". Probing that
 * by importing does NOT catch it here: the staging tree lives under backend/, so Node walks out of
 * the bundle and satisfies the import from backend/node_modules — a false pass that only turns
 * into a bug once the app is unpacked to %TEMP% on a machine with no such parent.
 */
function verifyBundleDependencyClosure(appDir) {
  const readPkg = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      return null;
    }
  };

  const resolveWithin = (fromDir, name) => {
    let dir = fromDir;
    for (;;) {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (path.resolve(dir) === path.resolve(appDir)) return null;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };

  const missing = [];
  const seen = new Set();
  const rootPkg = readPkg(appDir) || {};
  const queue = Object.keys(rootPkg.dependencies || {}).map((name) => ({ name, fromDir: appDir, via: 'package.json' }));

  while (queue.length) {
    const { name, fromDir, via } = queue.shift();
    const dir = resolveWithin(fromDir, name);
    if (!dir) {
      missing.push(`${name} (required by ${via})`);
      continue;
    }
    const key = `${path.resolve(dir)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pkg = readPkg(dir) || {};
    // optionalDependencies may legitimately be absent (platform-specific), so they are not required.
    for (const dep of Object.keys(pkg.dependencies || {})) {
      queue.push({ name: dep, fromDir: dir, via: name });
    }
  }

  if (missing.length) {
    console.error('[build-win-exe] Staged node_modules is incomplete — the packaged app would fail at runtime:');
    for (const line of [...new Set(missing)]) console.error('  -', line);
    process.exit(1);
  }
  console.log(`[build-win-exe] Verified ${seen.size} bundled packages resolve inside the bundle`);
}

/**
 * Secondary check: actually load each prod dependency, which catches native bindings that exist on
 * disk but fail to initialise. A pass here is weak evidence (see the parent-lookup note above);
 * verifyBundleDependencyClosure is what proves the bundle is self-contained.
 */
function verifyStagedModulesLoad(appDir, runtimeDir) {
  const probe =
    "const fs=require('fs');"
    + "const deps=Object.keys(JSON.parse(fs.readFileSync('package.json','utf8')).dependencies||{});"
    + '(async()=>{const bad=[];'
    + "for(const d of deps){try{await import(d);}catch(e){bad.push('  - '+d+': '+String((e&&e.message)||e).split('\\n')[0]);}}"
    + "if(bad.length){console.error(bad.join('\\n'));process.exit(1);}"
    + "console.log(deps.length);})();";

  const r = spawnSync(path.join(runtimeDir, 'node.exe'), ['-e', probe], {
    cwd: appDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    console.error('[build-win-exe] Bundled modules do not load — the packaged app would fail at runtime:');
    console.error(r.error ? `  - could not run ${path.join(runtimeDir, 'node.exe')}: ${r.error.message}` : (r.stderr || r.stdout || '(no output)').trim());
    process.exit(1);
  }
  console.log(`[build-win-exe] Verified ${String(r.stdout).trim()} bundled modules load`);
}

/** Files the tray launcher spawns at runtime; every packaging target must end up with all of them. */
function assertPayloadPresent(baseDir, label) {
  const required = [
    path.join('runtime', 'node.exe'),
    path.join('app', 'server.js'),
    path.join('app', 'node_modules', 'dotenv', 'package.json'),
    path.join('app', 'node_modules', '@prisma', 'client', 'package.json'),
    path.join('app', 'node_modules', '.prisma', 'client', 'index.js'),
    path.join('app', 'scripts', 'run-worldline-ctep-bridge.cjs'),
    path.join('app', 'worldline-ctep-bridge', 'WorldlineCtepBrowserBridge.class'),
    path.join('app', 'worldline-ctep-bridge', 'lib', 'JEasyCTEP-3.4.0.jar'),
    path.join('app', 'worldline-ctep-bridge', 'lib', 'jeasyctep.dll'),
    path.join('app', 'runtime', 'java', 'bin', 'java.exe'),
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(baseDir, rel)));
  if (missing.length) {
    console.error(`[build-win-exe] ${label} is missing runtime payload:`);
    for (const rel of missing) console.error('  -', rel);
    process.exit(1);
  }
}

/** Copy staged runtime/ + app/ (node_modules included) beside the packed retail-backend.exe. */
function copyPayloadIntoPackedApp(staging, appOutDir) {
  for (const name of ['runtime', 'app']) {
    fs.cpSync(path.join(staging, name), path.join(appOutDir, name), { recursive: true });
  }
  assertPayloadPresent(appOutDir, 'Packed app');
  console.log('[build-win-exe] Copied runtime/ + app/ into', appOutDir);
}

async function main() {
  const electronPkg = path.join(root, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(electronPkg)) {
    console.error('[build-win-exe] Missing electron. Run: npm install (in backend)');
    process.exit(1);
  }
  const electronVersion = JSON.parse(fs.readFileSync(electronPkg, 'utf8')).version;
  const backendPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const backendVersion = backendPkg.version || '1.0.0';

  const staging = path.join(root, 'release', '.pos-backend-bundle');
  let ebOut = path.join(root, 'release', '_electron-out');

  let releaseOut = defaultReleaseOut;
  if (!rmrfTryRetries(releaseOut)) {
    releaseOut = path.join(root, 'release', `retail-backend-build-${Date.now()}`);
    console.warn(
      '[build-win-exe] Could not remove release\\retail-backend (is retail-backend.exe still running?).',
    );
    console.warn('[build-win-exe] Building to alternate folder:', releaseOut);
  }

  console.log('[build-win-exe] Output:', releaseOut);
  rmrf(staging);
  if (!rmrfTry(ebOut)) {
    ebOut = path.join(root, 'release', `_electron-out-${Date.now()}`);
    console.warn('[build-win-exe] Using alternate electron output dir:', ebOut);
  }
  fs.mkdirSync(staging, { recursive: true });

  const appDir = path.join(staging, 'app');
  const runtimeDir = path.join(staging, 'runtime');

  copyNodeRuntime(runtimeDir);

  fs.mkdirSync(appDir, { recursive: true });
  copyFile(path.join(root, 'package.json'), path.join(appDir, 'package.json'));
  copyFile(path.join(root, 'package-lock.json'), path.join(appDir, 'package-lock.json'));
  copyFile(path.join(root, 'server.js'), path.join(appDir, 'server.js'));
  copyFile(path.join(root, 'periodicReportReceipt.js'), path.join(appDir, 'periodicReportReceipt.js'));
  copyFile(path.join(root, 'financialReportReceipt.js'), path.join(appDir, 'financialReportReceipt.js'));
  copyFile(
    path.join(root, 'periodicReportWebSections.js'),
    path.join(appDir, 'periodicReportWebSections.js'),
  );
  copyFile(path.join(root, 'userReportReceipt.js'), path.join(appDir, 'userReportReceipt.js'));
  copyDir(path.join(root, 'lib'), path.join(appDir, 'lib'));
  copyDir(path.join(root, 'services'), path.join(appDir, 'services'));
  // Only what the installed backend needs from prisma/. That folder also collects database
  // backups (*.bak, retail.backup-*.db) with real data in them; they must not ship in an installer.
  for (const name of ['schema.prisma', 'seed.js']) {
    copyFile(path.join(root, 'prisma', name), path.join(appDir, 'prisma', name));
  }
  stageWorldlineBridge(appDir);
  const devDb = path.join(root, 'prisma', 'retail.db');
  if (fs.existsSync(devDb)) {
    copyFile(devDb, path.join(appDir, 'prisma', 'retail.db'));
    console.log('[build-win-exe] Copied prisma/retail.db');
  }

  console.log('[build-win-exe] npm ci --omit=dev …');
  runNpmCli('npm ci --omit=dev', appDir);
  console.log('[build-win-exe] prisma generate …');
  runNpmCli('npx prisma generate', appDir);

  verifyStagedApp(appDir);
  verifyBundleDependencyClosure(appDir);
  verifyStagedModulesLoad(appDir, runtimeDir);

  fs.copyFileSync(path.join(root, 'tray-main.cjs'), path.join(elauncher, 'main.cjs'));
  const frontendIcon = path.join(root, '..', 'frontend', 'public', 'icon.png');
  const trayPng = path.join(elauncher, 'tray-icon.png');
  if (fs.existsSync(frontendIcon)) fs.copyFileSync(frontendIcon, trayPng);
  else fs.writeFileSync(trayPng, FALLBACK_TRAY_PNG);

  const genIco = spawnSync(process.execPath, [path.join(__dirname, 'gen-installer-ico.cjs')], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (genIco.status !== 0 && genIco.status != null) {
    console.error('[build-win-exe] gen-installer-ico failed');
    process.exit(genIco.status || 1);
  }

  const installerIco = path.join(root, 'build', 'installer.ico');
  const nsis = {
    include: 'nsis/installer.nsh',
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    shortcutName: 'Retail Backend',
    uninstallDisplayName: 'Retail Backend',
    runAfterFinish: true,
    differentialPackage: false,
  };
  if (fs.existsSync(installerIco)) {
    nsis.installerIcon = installerIco;
    nsis.uninstallerIcon = installerIco;
  }

  console.log('[build-win-exe] electron-builder (folder + NSIS setup + portable exe, may download Electron once) …');
  const { build } = require('electron-builder');
  await build({
    projectDir: elauncher,
    publish: null,
    x64: true,
    config: {
      electronVersion,
      extraMetadata: { version: backendVersion },
      compression: 'normal',
      artifactName: 'retail-backend.${ext}',
      portable: {
        artifactName: 'retail-backend-portable.${ext}',
      },
      appId: 'com.retail.backend',
      productName: 'Retail Backend',
      directories: { output: ebOut },
      files: ['**/*', '!**/node_modules/**'],
      // Not `extraFiles`: app-builder-lib's createFilter() drops a file set's root `node_modules`
      // unconditionally (`if (relative === 'node_modules') return false`), before any `filter` is
      // consulted — so app/node_modules can never ride along and the packaged server dies with
      // "Cannot find package 'dotenv'". Copy the payload in afterPack, which runs after the app is
      // packed into appOutDir and before the nsis/portable targets archive it, so all three targets
      // (dir, setup, portable) get identical, complete contents.
      afterPack: async (context) => copyPayloadIntoPackedApp(staging, context.appOutDir),
      asar: false,
      win: {
        executableName: 'retail-backend',
        ...(fs.existsSync(frontendIcon) ? { icon: frontendIcon } : {}),
        target: [
          { target: 'dir', arch: ['x64'] },
          { target: 'nsis', arch: ['x64'] },
          { target: 'portable', arch: ['x64'] },
        ],
      },
      nsis,
      npmRebuild: false,
    },
  });

  const entries = fs.readdirSync(ebOut, { withFileTypes: true }).filter((d) => d.isDirectory());
  const unpacked = entries.find((d) => d.name.includes('unpacked'));
  if (!unpacked) {
    console.error('[build-win-exe] electron-builder did not produce an *unpacked* folder in', ebOut);
    process.exit(1);
  }
  const unpackedPath = path.join(ebOut, unpacked.name);
  copyUnpackedToOut(unpackedPath, releaseOut);
  assertPayloadPresent(releaseOut, 'Release folder');

  const releaseArtifactsDir = path.join(root, 'release');
  fs.mkdirSync(releaseArtifactsDir, { recursive: true });
  for (const name of fs.readdirSync(ebOut)) {
    const src = path.join(ebOut, name);
    if (!fs.statSync(src).isFile() || !name.toLowerCase().endsWith('.exe')) continue;
    const dest = path.join(releaseArtifactsDir, name);
    copyFile(src, dest);
    if (/portable/i.test(name)) {
      console.log('[build-win-exe] Portable (no install wizard; CRC check off):', dest);
    } else if (/setup/i.test(name)) {
      console.log('[build-win-exe] Setup installer:', dest);
    } else {
      console.log('[build-win-exe] Copied:', dest);
    }
  }

  if (!rmrfTry(ebOut)) {
    console.warn('[build-win-exe] Could not remove temp folder (close apps using it):', ebOut);
  }
  rmrf(staging);

  console.log('[build-win-exe] Done. Run app:', path.join(releaseOut, 'retail-backend.exe'));
  console.log(
    '[build-win-exe] Tip: The NSIS error only applies to retail-backend.exe. Use retail-backend\\retail-backend.exe from the folder, or retail-backend-portable.exe, if setup fails after copying.',
  );
  console.log('[build-win-exe] Tray icon: open the ^ menu on the taskbar — right-click → Quit to stop the API.');
  console.log('[build-win-exe] Default API: http://localhost:4000');
  if (releaseOut !== defaultReleaseOut) {
    console.warn('[build-win-exe] To refresh the usual install path, quit the tray app and delete release\\retail-backend, then rebuild.');
  }
  if (!fs.existsSync(path.join(releaseOut, 'app', 'prisma', 'retail.db'))) {
    const appRel = path.relative(root, path.join(releaseOut, 'app'));
    console.log(
      `[build-win-exe] No prisma/retail.db — create DB: cd "${appRel}" && npx prisma db push && node prisma\\seed.js`,
    );
  }
}

main().catch((err) => {
  console.error('[build-win-exe]', err);
  process.exit(1);
});
