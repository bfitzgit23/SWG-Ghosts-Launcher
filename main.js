// main.js - SWG Ghosts Launcher
// 1920x1080 design, DPI/Zoom lock, sane sizing, F11 fullscreen toggle, window control IPC

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { downloadFileFromUrl, HTTP_HEADERS } = require('./download');
const { ensureOptionsCfg, primaryDisplaySize } = require('./machine-state');
const { createUpdaterController } = require('./updater');

// ---- DPI / scaling hard-fix (must be set BEFORE app ready) ----
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

let mainWindow;

// Keep ONE source of truth for your patch base
const PRECU_BASE_URL = 'https://swg-ghosts.online/tre/';
const NGE_BASE_URL = 'https://swg-ghosts.online/tre/nge/';
const PRECU_TESTCENTER_LOGIN_IP = '212.28.185.14';
const SWGEmu_EXE_FILENAME = 'SWGEmu.exe';
const SWGEmu_EXE_ALT_FILENAMES = ['SWGEmu.exe', 'SWGEmu.exe.patched', 'swgemu.exe'];
const SWGEmu_EXE_SERVER_SRC = 'SWGEmu.exe.patched';

function toggleFullscreen(win) {
  if (!win || win.isDestroyed()) return;
  win.setFullScreen(!win.isFullScreen());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    useContentSize: true,

    frame: false,
    transparent: true,

    // Allow resize for smaller screens; enforce minimum so it never becomes portrait-tiny
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,

    backgroundColor: '#00000000',
    hasShadow: false,

    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: false
    },

    show: false
  });

  mainWindow.setMinimumSize(1280, 720);
  mainWindow.loadFile('index.html');

  // ---- Hard lock zoom to 100% ----
  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      await mainWindow.webContents.setZoomFactor(1);
      await mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
    } catch (_) {}
  });

  // ---- Hotkeys (F11) + block Ctrl zoom ----
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // F11 fullscreen toggle (borderless fullscreen since frame:false)
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      toggleFullscreen(mainWindow);
      return;
    }

    // Block Ctrl zoom
    if (input.control && (input.key === '+' || input.key === '-' || input.key === '=' || input.key === '0')) {
      event.preventDefault();
      return;
    }
  });

  // Force a sane starting size every time (fit on smaller displays)
  mainWindow.once('ready-to-show', () => {
    try {
      const display = screen.getPrimaryDisplay();
      const work = display.workAreaSize;

      const target =
        (work.width >= 1920 && work.height >= 1080)
          ? { w: 1920, h: 1080 }
          : { w: 1280, h: 720 };

      mainWindow.setContentSize(target.w, target.h);
      mainWindow.center();
      mainWindow.show();

      // Extra guard against weird WM restores
      const [cw, ch] = mainWindow.getContentSize();
      if (cw < 1000 || ch < 600) {
        mainWindow.setContentSize(1280, 720);
        mainWindow.center();
      }
    } catch (_) {
      mainWindow.show();
    }
  });

  // Optional: log fullscreen changes
  mainWindow.on('enter-full-screen', () => console.log('Entered fullscreen'));
  mainWindow.on('leave-full-screen', () => console.log('Left fullscreen'));
}

// ------------------------------
// Window Controls via IPC
// ------------------------------
ipcMain.handle('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.handle('window:maximizeToggle', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.handle('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

ipcMain.handle('window:toggleFullscreen', () => {
  toggleFullscreen(mainWindow);
});

ipcMain.handle('window:isMaximized', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isMaximized();
});

ipcMain.handle('window:isFullscreen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isFullScreen();
});

function fetchJsonManifest(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchJsonManifest(new URL(response.headers.location, url).toString()).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Server returned status code ${response.statusCode}`));
        return;
      }
      let data = '';
      response.on('data', (chunk) => (data += chunk));
      response.on('end', () => parseRequiredFiles(data, resolve, reject));
    });
    req.on('error', (error) => reject(new Error('Failed to fetch files list: ' + error.message)));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout after 15 seconds'));
    });
  });
}

// ------------------------------
// Load required files from server
// ------------------------------
ipcMain.handle('load-required-files', async (event, version = 'precu') => {
  return new Promise((resolve, reject) => {
    const baseUrl = version === 'nge' ? NGE_BASE_URL : PRECU_BASE_URL;
    const url = baseUrl + 'required-files.json';
    console.log(`Loading ${version.toUpperCase()} files from: ${url}`);

    // HTTP_HEADERS keeps the CDN from rewriting responses (see download.js); the
    // manifest has to arrive byte-for-byte for the md5s in it to mean anything.
    const client = url.startsWith('https://') ? https : http;
    const req = client.get(url, { headers: HTTP_HEADERS }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = new URL(response.headers.location, url).toString();
        response.resume();
        const redirectClient = redirectUrl.startsWith('https://') ? https : http;
        redirectClient.get(redirectUrl, { headers: HTTP_HEADERS }, (redirectResponse) => {
          if (redirectResponse.statusCode !== 200) {
            reject(new Error(`Server returned status code ${redirectResponse.statusCode}`));
            return;
          }
          let data = '';
          redirectResponse.on('data', (chunk) => (data += chunk));
          redirectResponse.on('end', () => parseRequiredFiles(data, resolve, reject));
        }).on('error', reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Server returned status code ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', (chunk) => (data += chunk));
      response.on('end', () => parseRequiredFiles(data, resolve, reject));
    });

    req.on('error', (error) => reject(new Error('Failed to fetch files list: ' + error.message)));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout after 15 seconds'));
    });
  });
});
function parseRequiredFiles(data, resolve, reject) {
  try {
    const jsonData = JSON.parse(data);
    if (!Array.isArray(jsonData)) throw new Error('File list is not an array');

    const validData = jsonData.filter((item) =>
      item &&
      item.name &&
      typeof item.name === 'string' &&
      item.name.trim() !== '' &&
      item.md5
    ).map(item => ({
      ...item,
      size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0
    }));

    console.log(`Loaded ${validData.length} valid files from server`);
    resolve(validData);
  } catch (error) {
    console.error('JSON parse error:', error);
    reject(new Error('Failed to parse JSON: ' + error.message));
  }
}

// --------------
// Check MD5
// --------------
ipcMain.handle('check-md5', async (event, filePath) => {
  return new Promise((resolve, reject) => {
    if (!filePath || typeof filePath !== 'string') {
      reject(new Error('Invalid file path'));
      return;
    }

    if (!fs.existsSync(filePath)) {
      reject(new Error('File does not exist: ' + filePath));
      return;
    }

    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
});

// ------------------------------
// Verified-file cache + batched verification
// ------------------------------
// A scan used to hash every manifest file one at a time over IPC, which re-read
// the entire client (several GB) on every launch. Two changes remove that cost:
//   * a persisted (path, size, mtime) -> md5 cache, so a file that has not
//     changed since it was last verified against the same expected hash is
//     accepted without being read at all;
//   * batched verification with bounded concurrency, so the files that do need
//     hashing are read several at a time instead of strictly one after another.
const VERIFY_CACHE_VERSION = 1;
let verifyCache = null;
let verifyCacheDirty = false;
let verifyCacheTimer = null;

const getVerifyCachePath = () => path.join(app.getPath('userData'), 'verified-files.json');

function loadVerifyCache() {
  if (verifyCache) return verifyCache;
  verifyCache = Object.create(null);
  try {
    const p = getVerifyCachePath();
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && parsed.version === VERIFY_CACHE_VERSION && parsed.entries) {
        verifyCache = Object.assign(Object.create(null), parsed.entries);
      }
    }
  } catch (_) {
    verifyCache = Object.create(null);
  }
  return verifyCache;
}

function saveVerifyCacheNow() {
  if (!verifyCacheDirty || !verifyCache) return;
  try {
    fs.writeFileSync(
      getVerifyCachePath(),
      JSON.stringify({ version: VERIFY_CACHE_VERSION, entries: verifyCache })
    );
    verifyCacheDirty = false;
  } catch (_) {}
}

function scheduleVerifyCacheSave() {
  verifyCacheDirty = true;
  if (verifyCacheTimer) return;
  verifyCacheTimer = setTimeout(() => {
    verifyCacheTimer = null;
    saveVerifyCacheNow();
  }, 2000);
  try { verifyCacheTimer.unref(); } catch (_) {}
}

function clearVerifyCache() {
  verifyCache = Object.create(null);
  verifyCacheDirty = true;
  saveVerifyCacheNow();
}

function md5OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// status: 'ok' | 'changed' | 'missing' | 'error'
async function verifyOne({ filePath, expectedMd5, size, useCache = true }) {
  if (!filePath || typeof filePath !== 'string') {
    return { filePath, status: 'error', md5: null };
  }

  let st;
  try {
    st = fs.statSync(filePath);
  } catch (_) {
    return { filePath, status: 'missing', md5: null };
  }
  if (!st.isFile()) return { filePath, status: 'missing', md5: null };

  const expected = String(expectedMd5 || '').toLowerCase();

  // A size mismatch cannot possibly match — never spend a hash on it.
  if (size && Number(size) > 0 && st.size !== Number(size)) {
    return { filePath, status: 'changed', md5: null, reason: 'size' };
  }

  const cache = loadVerifyCache();
  const key = filePath.toLowerCase();
  const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
  const cached = cache[key];

  if (useCache && cached && cached.stamp === stamp && cached.expected === expected && cached.md5) {
    return { filePath, status: 'ok', md5: cached.md5, cached: true };
  }

  let md5;
  try {
    md5 = await md5OfFile(filePath);
  } catch (_) {
    return { filePath, status: 'error', md5: null };
  }

  const ok = md5 === expected;
  if (ok) {
    cache[key] = { stamp, expected, md5 };
  } else {
    delete cache[key];
  }
  scheduleVerifyCacheSave();

  return { filePath, status: ok ? 'ok' : 'changed', md5 };
}

ipcMain.handle('verify-files', async (event, { entries, useCache = true, concurrency = 8 } = {}) => {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return [];

  const results = new Array(list.length);
  let next = 0;
  const workers = Math.max(1, Math.min(Number(concurrency) || 8, 16, list.length));

  async function run() {
    for (;;) {
      const index = next++;
      if (index >= list.length) return;
      try {
        results[index] = await verifyOne({ ...list[index], useCache });
      } catch (error) {
        results[index] = {
          filePath: list[index] && list[index].filePath,
          status: 'error',
          md5: null,
          error: String((error && error.message) || error)
        };
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, run));
  saveVerifyCacheNow();
  return results;
});

ipcMain.handle('clear-verify-cache', () => {
  clearVerifyCache();
  return { success: true };
});

// ------------------------------
// Download file with progress
// ------------------------------
ipcMain.handle('download-file', async (event, { url, destination, expectedMd5, size }) => {
  // The request/verify/replace path is in download.js so it can be exercised
  // headlessly against the live file host (scripts/download-selftest.js).
  return downloadFileFromUrl({
    url,
    destination,
    expectedMd5,
    size,
    onProgress: (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('file-progress', progress);
      }
    },
    log: (message) => console.log(message)
  });
});

// ------------------------------
// Directory selection
// ------------------------------
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select SWG Installation Directory'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// ------------------------------
// File selection
// ------------------------------
ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: 'Select SWGEmu.exe',
    filters: [
      { name: 'Executable Files', extensions: ['exe'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// ------------------------------
function appendLauncherDiagnostic(message) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'launch-diagnostic.log'),
      `[${new Date().toISOString()}] ${message}\n`,
      'utf8'
    );
  } catch (_) {}
}

// ------------------------------
// Server login configuration
// ------------------------------
// Only the PRE-CU Test Center profile changes loginServerAddress0.
// PRE-CU retains its existing login settings.
ipcMain.handle('configure-server-login', async (event, { version = 'precu', dir } = {}) => {
  try {
    if (version !== 'precu-testcenter') return { success: true, changed: false };
    const targetLoginIp = PRECU_TESTCENTER_LOGIN_IP;

    if (!dir || typeof dir !== 'string') {
      return { success: false, error: 'No PRE-CU Test Center installation directory selected.' };
    }

    const rootDir = path.resolve(dir);
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      return { success: false, error: `PRE-CU Test Center installation directory does not exist: ${rootDir}` };
    }

    const candidates = [
      path.join(rootDir, 'swgemu_login.cfg'),
      path.join(rootDir, 'login.cfg'),
      path.join(rootDir, 'game', 'swgemu_login.cfg'),
      path.join(rootDir, 'game', 'login.cfg')
    ];

    const loginPath = candidates.find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!loginPath) {
      return {
        success: false,
        changed: false,
        error: 'Could not find swgemu_login.cfg or login.cfg in the PRE-CU Test Center installation.'
      };
    }

    let content = fs.readFileSync(loginPath, 'utf8');
    const before = content;
    const addressPattern = /(^[ \t]*loginServerAddress0[ \t]*=[ \t]*)([^\r\n;#]+)/mi;

    if (addressPattern.test(content)) {
      content = content.replace(addressPattern, `$1${targetLoginIp}`);
    } else {
      if (!content.endsWith('\n')) content += '\r\n';
      content += `loginServerAddress0=${targetLoginIp}\r\n`;
    }

    if (content !== before) {
      const temp = loginPath + `.ghosts-login-${process.pid}-${Date.now()}.tmp`;
      fs.writeFileSync(temp, content, 'utf8');
      try {
        fs.renameSync(temp, loginPath);
      } catch (error) {
        try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
        return { success: false, changed: false, error: `Could not replace login configuration: ${error.message}` };
      }
    }

    return { success: true, changed: content !== before, path: loginPath, loginIp: targetLoginIp };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ------------------------------
// Installation diagnostics
// ------------------------------
ipcMain.handle('check-installation', async (event, { version = 'precu', dir } = {}) => {
  try {
    if (!dir || typeof dir !== 'string') {
      return { ok: false, error: 'No installation directory selected.' };
    }

    const rootDir = path.resolve(dir);
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      return { ok: false, error: `Installation directory does not exist: ${rootDir}` };
    }

    const names = version === 'nge'
      ? ['swgclient_r.exe', 'SwgClient_r.exe', 'SWGClient_r.exe']
      : ['SWGEmu.exe', 'swgemu.exe', 'SWGEMU.exe'];

    const wanted = new Set(names.map(n => n.toLowerCase()));
    const skipDirs = new Set([
      'node_modules', '.git', 'logs', 'cache', 'caches',
      'gpuCache', 'crashpad', 'crashes'
    ]);

    let exePath = null;

    // First check the saved/standard locations.
    const candidates = [];
    for (const name of names) {
      candidates.push(path.join(rootDir, name));
      candidates.push(path.join(rootDir, 'game', name));
      candidates.push(path.join(rootDir, 'SWGEmu', name));
      candidates.push(path.join(rootDir, 'SWGEmu Live', name));
      candidates.push(path.join(rootDir, 'Star Wars Galaxies', name));
    }
    exePath = candidates.find(p => {
      try { return fs.existsSync(p) && fs.statSync(p).isFile(); }
      catch (_) { return false; }
    });

    // Search the selected client directory recursively. This handles clients
    // whose executable is under a game/client/bin subdirectory and avoids
    // requiring every player to have the same folder layout.
    if (!exePath) {
      const queue = [{ dir: rootDir, depth: 0 }];
      const maxDepth = 4;

      while (queue.length && !exePath) {
        const current = queue.shift();
        let entries = [];
        try {
          entries = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch (_) {
          continue;
        }

        for (const entry of entries) {
          if (entry.name.startsWith('.') || skipDirs.has(entry.name)) continue;
          const full = path.join(current.dir, entry.name);

          if (entry.isFile() && wanted.has(entry.name.toLowerCase())) {
            exePath = full;
            break;
          }

          if (entry.isDirectory() && current.depth < maxDepth) {
            queue.push({ dir: full, depth: current.depth + 1 });
          }
        }
      }
    }

    const expected = version === 'nge' ? 'swgclient_r.exe' : 'SWGEmu.exe';
    return {
      ok: !!exePath,
      version,
      directory: rootDir,
      executable: exePath || null,
      expected,
      message: exePath
        ? `Found ${path.basename(exePath)}`
        : `Could not find ${expected} in the selected installation.`
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// ------------------------------
// Elevation detection
// ------------------------------
// The launcher is built asInvoker and never requests elevation. Players can
// still start it through a shortcut left over from an older build with
// "Run this program as an administrator" ticked, and anything we spawn would
// then silently inherit those admin rights — so the game client would run
// elevated too. We detect that once and launch the client as the logged-on
// user instead.
let cachedElevation = null;
function isProcessElevated() {
  if (process.platform !== 'win32') return false;
  if (cachedElevation !== null) return cachedElevation;

  cachedElevation = false;
  try {
    const { spawnSync } = require('child_process');
    const probe = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    cachedElevation = /\btrue\b/i.test(probe.stdout || '');
  } catch (_) {
    cachedElevation = false;
  }
  return cachedElevation;
}

// ------------------------------
// Stale client-cache clear (pre-launch)
// ------------------------------
// The same protection the WoW launcher ships: the client's volatile cache
// folder and temp files left behind by an interrupted scan/update can keep
// serving stale data after a patch. The moment right before we spawn the
// client is the only time they are safe to delete — no game process is
// holding them open yet. Never touched: options/login *.cfg + *.iff,
// profiles/, logs/, mods and the game executables — the same list the scan
// treats as protected user state. Covers PRE-CU and the Test Center: both
// launch paths funnel through the launch-game handler below.
function clearStaleClientCache(installDir, exePath) {
  const roots = [];
  if (installDir && typeof installDir === 'string') {
    roots.push(path.resolve(installDir));
  }
  if (exePath && typeof exePath === 'string') {
    const exeDir = path.dirname(path.resolve(exePath));
    if (!roots.includes(exeDir)) roots.push(exeDir);
  }

  const cleared = [];

  const removeDir = (dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return 'full';
    } catch (_) {
      // A client still running holds files open — clear what we can, the way
      // the WoW launcher falls back to clearing a single subfolder.
      let any = false;
      try {
        for (const entry of fs.readdirSync(dir)) {
          try {
            fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
            any = true;
          } catch (_) {}
        }
      } catch (_) {}
      return any ? 'partial' : 'locked';
    }
  };

  // Temp names written by this launcher's downloaders
  // (destination + `.ghosts-download-<pid>-<ts>.tmp`, `.ghosts-login-...`).
  const TEMP_RE = /\.(ghosts-download|ghosts-login)-\d+-\d+\.tmp$/i;

  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory() && entry.name.toLowerCase() === 'cache') {
        const state = removeDir(full);
        if (state !== 'locked') cleared.push('cache/ (' + state + ')');
      } else if (entry.isFile() && TEMP_RE.test(entry.name)) {
        try {
          fs.unlinkSync(full);
          cleared.push(entry.name);
        } catch (_) {}
      }
    }
  }

  return cleared;
}

// A background-spawned game never becomes the foreground window (Windows
// blocks focus-stealing), so its login screen silently ignores keyboard input:
// the window is visible but "you can't type". Once the client has created its
// main window, bring it to the front using the alt-tap unlock +
// SetForegroundWindow sequence (the only combination that works reliably).
function focusGameWindow(pid, log) {
  if (!pid || process.platform !== 'win32') return;
  try {
    // Preferred: the precompiled helper (instant startup, no runtime C#
    // compile — PowerShell + Add-Type costs 20s+ on slow boxes).
    const focusExe = path.join(__dirname, 'bin', 'ghosts-focus.exe');
    if (fs.existsSync(focusExe)) {
      const helper = require('child_process').spawn(focusExe, [String(pid)], {
        windowsHide: true,
        stdio: 'ignore'
      });
      helper.once('spawn', () => {
        try { helper.unref(); } catch (_) {}
        if (log) log(`Focus helper armed for PID ${pid} (brings game window to front once created)`);
      });
      helper.once('error', (err) => {
        if (log) log(`Focus helper failed: ${err.message}; falling back to PowerShell`);
      });
      return;
    }
    // Fallback: PowerShell + Add-Type — slow but needs no binary.
    const psCommand = [
      '$p = $null;',
      'for ($i = 0; $i -lt 120; $i++) {',
      '  $p = Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue;',
      '  if (-not $p) { exit 0 };',
      '  if ($p.MainWindowHandle -ne 0) { break };',
      '  Start-Sleep -Milliseconds 500;',
      '};',
      'if (-not $p -or $p.MainWindowHandle -eq 0) { exit 0 };',
      "Add-Type 'using System;using System.Runtime.InteropServices;public class GhostsFocus {",
      '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
      '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
      '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
      "}';",
      '$h = $p.MainWindowHandle;',
      '[GhostsFocus]::ShowWindow($h, 9) | Out-Null;',
      '[GhostsFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero);',
      '[GhostsFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero);',
      '[GhostsFocus]::SetForegroundWindow($h) | Out-Null;'
    ].join(' ');

    const child = require('child_process').spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', psCommand
    ], { windowsHide: true, stdio: 'ignore' });
    child.once('spawn', () => {
      try { child.unref(); } catch (_) {}
      if (log) log(`Focus helper armed for PID ${pid} (brings game window to front once created)`);
    });
    child.once('error', (err) => {
      if (log) log(`Focus helper failed: ${err.message}`);
    });
  } catch (err) {
    if (log) log(`Focus helper skipped: ${err.message}`);
  }
}

// Launch game
// ------------------------------
function launchExecutable(exePath) {
  return new Promise((resolve, reject) => {
    if (!exePath || typeof exePath !== 'string') {
      reject(new Error('Invalid executable path'));
      return;
    }

    const resolvedExe = path.resolve(exePath);
    if (!fs.existsSync(resolvedExe)) {
      reject(new Error('Executable not found: ' + resolvedExe));
      return;
    }

    let stat;
    try {
      stat = fs.statSync(resolvedExe);
    } catch (error) {
      reject(new Error('Cannot access executable: ' + error.message));
      return;
    }

    if (!stat.isFile()) {
      reject(new Error('Selected executable is not a file: ' + resolvedExe));
      return;
    }

    const exeDir = path.dirname(resolvedExe);
    const exeName = path.basename(resolvedExe);
    const { spawn } = require('child_process');

    const log = (msg) => {
      try { appendLauncherDiagnostic(msg); } catch (_) {}
    };

    const startWithPowerShell = () => {
      const psCommand =
        `$p = Start-Process -FilePath '${resolvedExe.replace(/'/g, "''")}' ` +
        `-WorkingDirectory '${exeDir.replace(/'/g, "''")}' -PassThru; ` +
        `Write-Output $p.Id`;

      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', psCommand
      ], {
        cwd: exeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      ps.stdout.on('data', d => { stdout += d.toString(); });
      ps.stderr.on('data', d => { stderr += d.toString(); });

      ps.once('error', err => {
        log(`PowerShell fallback error: ${err.code || ''} ${err.message || err}`);
        reject(new Error(`Windows could not start ${exeName}: ${err.message}`));
      });

      ps.once('close', code => {
        if (code === 0) {
          const pid = parseInt(stdout.trim(), 10) || null;
          log(`Started ${exeName} through Windows Start-Process; PID=${pid || 'unknown'}`);
          focusGameWindow(pid, log);
          resolve({
            success: true,
            pid,
            executable: resolvedExe,
            method: 'Start-Process',
            message: `${exeName} launched successfully`
          });
        } else {
          const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
          log(`Start-Process failed: ${detail}`);
          reject(new Error(`Windows could not start ${exeName}: ${detail}`));
        }
      });
    };

    // Explorer runs as the logged-on user, so a process started through it
    // never inherits the launcher's elevation. Used only when the launcher
    // itself is elevated; otherwise we spawn the client directly.
    const startDeElevated = () => {
      const child = spawn('explorer.exe', [resolvedExe], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });

      child.once('spawn', () => {
        log(`Launcher is elevated — started ${exeName} through explorer.exe as the logged-on user (no admin rights)`);
        try { child.unref(); } catch (_) {}
        resolve({
          success: true,
          pid: null,
          executable: resolvedExe,
          deElevated: true,
          method: 'explorer (de-elevated)',
          message: `${exeName} launched as your normal user, not as administrator`
        });
      });

      child.once('error', err => {
        log(`De-elevated launch failed: ${err.code || ''} ${err.message || err}`);
        startWithPowerShell();
      });
    };

    try {
      // Never hand the game client the launcher's admin rights.
      if (process.platform === 'win32' && isProcessElevated()) {
        startDeElevated();
        return;
      }

      const child = spawn(resolvedExe, [], {
        cwd: exeDir,
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false
      });

      child.once('spawn', () => {
        log(`Started ${exeName} directly; PID=${child.pid}`);
        try { child.unref(); } catch (_) {}
        focusGameWindow(child.pid, log);
        resolve({
          success: true,
          pid: child.pid,
          executable: resolvedExe,
          method: 'CreateProcess',
          message: `${exeName} launched successfully`
        });
      });

      child.once('error', err => {
        log(`Direct CreateProcess failed: ${err.code || ''} ${err.message || err}`);
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          // Retry through the shell first: it starts the client as the logged-on
          // user, so a rights problem is never "solved" by handing the client
          // administrator access.
          log('Retrying through explorer.exe as the logged-on user');
          startDeElevated();
        } else {
          reject(new Error(`Windows could not start ${exeName}: ${err.message}`));
        }
      });
    } catch (err) {
      log(`Direct launch exception: ${err.message}`);
      startDeElevated();
    }
  });
}

ipcMain.handle('launch-game', (event, exePath, installDir) => {
  // Stale-cache protection before every launch — see clearStaleClientCache().
  try {
    const cleared = clearStaleClientCache(installDir, exePath);
    if (cleared.length) {
      appendLauncherDiagnostic('Pre-launch cache clear: ' + cleared.join(', '));
    }
  } catch (error) {
    try {
      appendLauncherDiagnostic('Pre-launch cache clear skipped: ' + error.message);
    } catch (_) {}
  }
  // Per-machine state: the channel does not ship options.cfg, so a client that has
  // never been set up gets one from this machine's desktop mode before it starts.
  if (installDir && typeof installDir === 'string') {
    try {
      const display = primaryDisplaySize();
      const state = ensureOptionsCfg(installDir, display);
      if (state.created) {
        appendLauncherDiagnostic(
          `Pre-launch machine state: wrote options.cfg at ${display.width}x${display.height}`
        );
      }
    } catch (error) {
      try {
        appendLauncherDiagnostic('Pre-launch machine state skipped: ' + error.message);
      } catch (_) {}
    }
  }
  return launchExecutable(exePath);
});

// Called by the renderer once a scan finishes, so a fresh install has a working
// options.cfg before the player ever presses Play.
ipcMain.handle('ensure-machine-state', (event, { dir } = {}) => {
  try {
    if (!dir || typeof dir !== 'string') {
      return { success: false, error: 'No installation directory selected.' };
    }
    const display = primaryDisplaySize();
    const state = ensureOptionsCfg(dir, display);
    if (state.created) {
      appendLauncherDiagnostic(
        `Machine state: wrote options.cfg at ${display.width}x${display.height}`
      );
    }
    return { success: true, ...state, display };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ------------------------------
// Client setup utility (SwgClientSetup_r.exe)
// ------------------------------
// The client ships its own graphics/sound/options dialog. Opening it from the
// launcher saves players hunting for the executable, and it must never inherit
// the launcher's admin rights — the same rule the game itself follows.
const CLIENT_SETUP_NAMES = [
  'SwgClientSetup_r.exe', 'SWGClientSetup_r.exe', 'swgclientsetup_r.exe',
  'SwgClientSetup.exe', 'SWGClientSetup.exe'
];

ipcMain.handle('launch-client-setup', async (event, { dir } = {}) => {
  try {
    if (!dir || typeof dir !== 'string') {
      return { success: false, error: 'No installation directory selected.' };
    }

    const rootDir = path.resolve(dir);
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      return { success: false, error: `Installation directory does not exist: ${rootDir}` };
    }

    const wanted = new Set(CLIENT_SETUP_NAMES.map(n => n.toLowerCase()));
    const skipDirs = new Set(['node_modules', '.git', 'logs', 'cache', 'caches', 'gpuCache', 'crashpad', 'crashes']);

    let setupPath = CLIENT_SETUP_NAMES
      .map(n => path.join(rootDir, n))
      .find(p => {
        try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch (_) { return false; }
      }) || null;

    // Nested layouts (game/, client/bin/, …) are common, so search a few levels down.
    if (!setupPath) {
      const queue = [{ dir: rootDir, depth: 0 }];
      while (queue.length && !setupPath) {
        const current = queue.shift();
        let entries = [];
        try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const entry of entries) {
          if (entry.name.startsWith('.') || skipDirs.has(entry.name)) continue;
          const full = path.join(current.dir, entry.name);
          if (entry.isFile() && wanted.has(entry.name.toLowerCase())) { setupPath = full; break; }
          if (entry.isDirectory() && current.depth < 4) queue.push({ dir: full, depth: current.depth + 1 });
        }
      }
    }

    if (!setupPath) {
      return {
        success: false,
        error: 'SwgClientSetup_r.exe was not found in this installation. Run a full scan first if the client is incomplete.'
      };
    }

    const result = await launchExecutable(setupPath);
    return { ...result, setup: setupPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ------------------------------
// Settings management
// ------------------------------
const getSettingsPath = () => path.join(app.getPath('userData'), 'settings.json');

ipcMain.handle('save-settings', (event, settings) => {
  try {
    const settingsPath = getSettingsPath();
    const existingSettings = fs.existsSync(settingsPath)
      ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      : {};

    const mergedSettings = { ...existingSettings, ...settings };
    fs.writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-settings', () => {
  const settingsPath = getSettingsPath();
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return settings;
    } catch (_) {
      return {};
    }
  }
  return {};
});

ipcMain.handle('save-install-dir', (event, { version = 'precu', dir }) => {
  const settingsPath = getSettingsPath();
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    : {};

  if (version === 'nge') {
    settings.ngeInstallDir = dir;
  } else if (version === 'precu-testcenter') {
    settings.precuTestCenterInstallDir = dir;
  } else {
    settings.precuInstallDir = dir;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return true;
});

ipcMain.handle('get-install-dir', (event, version = 'precu') => {
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) return null;

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (version === 'nge') return settings.ngeInstallDir || null;
  if (version === 'precu-testcenter') return settings.precuTestCenterInstallDir || null;
  return settings.precuInstallDir || null;
  } catch (_) {
    return null;
  }
});
ipcMain.handle('save-game-version', (event, version) => {
  const settingsPath = getSettingsPath();
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    : {};
  settings.gameVersion = version;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
});

ipcMain.handle('get-game-version', () => {
  const settingsPath = getSettingsPath();
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return settings.gameVersion || null;
    } catch (_) { return null; }
  }
  return null;
});

ipcMain.handle('save-scan-mode', (event, mode) => {
  const settingsPath = getSettingsPath();
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    : {};
  settings.scanMode = mode;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
});

ipcMain.handle('get-scan-mode', () => {
  const settingsPath = getSettingsPath();
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return settings.scanMode || 'quick';
    } catch (_) {
      return 'quick';
    }
  }
  return 'quick';
});

// ------------------------------
// Clear cache
// ------------------------------
ipcMain.handle('clear-cache', async () => {
  try {
    const cachePaths = [
      path.join(app.getPath('userData'), 'Cache'),
      path.join(app.getPath('userData'), 'cache'),
      path.join(app.getPath('userData'), 'GPUCache')
    ];

    let cleared = false;
    for (const cachePath of cachePaths) {
      if (fs.existsSync(cachePath)) {
        fs.rmSync(cachePath, { recursive: true, force: true });
        cleared = true;
      }
    }

    // Also drop the verified-file cache so the next scan re-reads every file —
    // this is the escape hatch for a genuinely forced recheck.
    clearVerifyCache();

    return { success: true, message: cleared ? 'Caches cleared — next scan will recheck every file' : 'Verification cache cleared' };
  } catch (error) {
    return { success: false, error: `Failed to clear cache: ${error.message}` };
  }
});

// ------------------------------
// Open logs
// ------------------------------
ipcMain.handle('open-logs', async () => {
  const logPath = path.join(app.getPath('userData'), 'logs');
  try {
    if (!fs.existsSync(logPath)) fs.mkdirSync(logPath, { recursive: true });

    const logFile = path.join(logPath, 'launcher.log');
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, `SWG Ghosts Launcher Log\nCreated: ${new Date().toISOString()}\n\n`);
    }

    shell.openPath(logFile);
    return { success: true };
  } catch (error) {
    return { success: false, error: `Failed to open logs: ${error.message}` };
  }
});

// ------------------------------
// App lifecycle
// ------------------------------

// ------------------------------
// Launcher auto-update
// ------------------------------
// Updates come from our own site first (swg-ghosts.online/launcher) and fall back
// to the GitHub release if the site is unreachable or the download stalls. The
// download/watchdog/fallback logic lives in updater.js so it can be exercised
// without Electron (see scripts/updater-selftest.js).
let updaterController = null;

function sendToLauncherWindow(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  } catch (_) {}
}

function configureAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[Updater] Development build; automatic updates disabled.');
    return;
  }

  updaterController = createUpdaterController({
    autoUpdater,
    currentVersion: app.getVersion(),
    log: (message) => {
      console.log(message);
      appendLauncherDiagnostic(message.replace(/^\[updater\]\s*/, 'Updater: '));
    },
    onState: (state, previous) => {
      if (state.phase !== previous.phase) {
        if (state.phase === 'downloading') {
          sendToLauncherWindow('launcher-update-available', {
            version: state.version,
            feed: state.feedLabel
          });
        } else if (state.phase === 'ready') {
          sendToLauncherWindow('launcher-update-downloaded', {
            version: state.version,
            feed: state.feedLabel
          });
        } else if (state.phase === 'error') {
          sendToLauncherWindow('launcher-update-error', {
            message: state.error,
            feed: state.feedLabel
          });
        }
      }

      if (state.phase === 'downloading' && state.percent !== previous.percent) {
        sendToLauncherWindow('launcher-update-progress', {
          percent: state.percent,
          transferred: state.transferred,
          total: state.total
        });
      }

      sendToLauncherWindow('launcher-update-status', {
        phase: state.phase,
        version: state.version,
        feed: state.feedLabel,
        error: state.error
      });
    },
    noInstall: process.env.GHOSTS_UPDATER_NO_INSTALL === '1',
    stallMs: Number(process.env.GHOSTS_UPDATER_STALL_MS) || undefined,
    checkTimeoutMs: Number(process.env.GHOSTS_UPDATER_CHECK_TIMEOUT_MS) || undefined
  });

  updaterController.init();
  updaterController.scheduleAutoChecks();
}

ipcMain.handle('check-launcher-update', async () => {
  if (!app.isPackaged) {
    return { success: false, development: true, message: 'Updates are disabled in development builds.' };
  }
  if (!updaterController) {
    return { success: false, message: 'Updater is not running yet.' };
  }
  try {
    const state = await updaterController.runCheck('manual');
    return {
      success: state.phase !== 'error',
      phase: state.phase,
      updateAvailable: state.phase === 'downloading' || state.phase === 'ready',
      ready: state.phase === 'ready',
      version: state.version,
      feed: state.feedLabel,
      message: state.error
    };
  } catch (error) {
    return { success: false, message: error.message || String(error) };
  }
});

ipcMain.handle('install-launcher-update', () => {
  if (!app.isPackaged) return { success: false, development: true };
  if (!updaterController) return { success: false, message: 'Updater is not running yet.' };
  return { success: updaterController.installNow() };
});

ipcMain.handle('launcher-update-state', () => {
  if (!updaterController) return null;
  const state = updaterController.getState();
  return {
    phase: state.phase,
    version: state.version,
    feed: state.feedLabel,
    error: state.error,
    percent: state.percent
  };
});

app.whenReady().then(() => {
  createWindow();
  configureAutoUpdater();

  const logPath = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logPath)) fs.mkdirSync(logPath, { recursive: true });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Persist whatever the last scan learned before the process goes away.
app.on('will-quit', () => {
  try { saveVerifyCacheNow(); } catch (_) {}
  try { if (updaterController) updaterController.dispose(); } catch (_) {}
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ------------------------------
// Handle errors
// ------------------------------
process.on('uncaughtException', (error) => {
  try {
    const logPath = path.join(app.getPath('userData'), 'logs', 'error.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `${timestamp} - Uncaught Exception: ${error.stack || error.message}\n`);
  } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
  try {
    const logPath = path.join(app.getPath('userData'), 'logs', 'error.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `${timestamp} - Unhandled Rejection: ${reason}\n`);
  } catch (_) {}
});






