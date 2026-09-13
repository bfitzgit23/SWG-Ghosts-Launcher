// main.js - SWG Ghosts Launcher
// 1920x1080 design, DPI/Zoom lock, sane sizing, F11 fullscreen toggle, window control IPC

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ---- DPI / scaling hard-fix (must be set BEFORE app ready) ----
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

let mainWindow;

// Keep ONE source of truth for your patch base
const PRECU_BASE_URL = 'https://cmagnos.ddns.net/tre/';
const NGE_BASE_URL = 'https://cmagnos.ddns.net/tre/nge/';
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

// ------------------------------
// Load required files from server
// ------------------------------
ipcMain.handle('load-required-files', async (event, version = 'precu') => {
  return new Promise((resolve, reject) => {
    const baseUrl = version === 'nge' ? NGE_BASE_URL : PRECU_BASE_URL;
    const url = baseUrl + 'required-files.json';
    console.log(`Loading ${version.toUpperCase()} files from: ${url}`);

    const client = url.startsWith('https://') ? https : http;
    const req = client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = new URL(response.headers.location, url).toString();
        response.resume();
        const redirectClient = redirectUrl.startsWith('https://') ? https : http;
        redirectClient.get(redirectUrl, (redirectResponse) => {
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
// Download file with progress
// ------------------------------
ipcMain.handle('download-file', async (event, { url, destination, expectedMd5, size }) => {
  return new Promise((resolve, reject) => {
    if (!url || !destination) {
      reject(new Error('URL and destination are required'));
      return;
    }

    const dir = path.dirname(destination);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // NEVER write directly over a working game executable/configuration.
    // A failed download or MD5 check must not delete the user's current file.
    const tempPath = destination + `.ghosts-download-${process.pid}-${Date.now()}.tmp`;

    const cleanupTemp = () => {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
    };

    const downloadTo = (requestUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        cleanupTemp();
        reject(new Error('Too many redirects'));
        return;
      }

      const client = requestUrl.startsWith('https://') ? https : http;
      const file = fs.createWriteStream(tempPath);
      let downloadedBytes = 0;

      console.log(`Downloading: ${requestUrl} to temporary file ${tempPath}`);

      const req = client.get(requestUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          cleanupTemp();
          response.resume();
          downloadTo(new URL(response.headers.location, requestUrl).toString(), redirectCount + 1);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          cleanupTemp();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'], 10) || size || 0;

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          const percent = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('file-progress', {
              downloaded: downloadedBytes,
              total: totalBytes,
              percent,
              delta: chunk.length
            });
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();

          if (!expectedMd5) {
            try {
              fs.renameSync(tempPath, destination);
              resolve({ path: destination });
            } catch (error) {
              cleanupTemp();
              reject(error);
            }
            return;
          }

          const hash = crypto.createHash('md5');
          const readStream = fs.createReadStream(tempPath);

          readStream.on('data', (data) => hash.update(data));
          readStream.on('end', () => {
            const downloadedMd5 = hash.digest('hex').toLowerCase();
            const expected = String(expectedMd5).toLowerCase();

            if (downloadedMd5 !== expected) {
              cleanupTemp();
              reject(new Error(`MD5 mismatch: expected ${expected}, got ${downloadedMd5}. Existing file was preserved.`));
              return;
            }

            try {
              // Replace only after the complete download has passed MD5.
              // Windows can refuse rename-over-existing files, so use a
              // backup swap when necessary.
              const backupPath = destination + '.ghosts-old';
              if (fs.existsSync(backupPath)) {
                try { fs.unlinkSync(backupPath); } catch (_) {}
              }

              if (fs.existsSync(destination)) {
                try {
                  fs.renameSync(destination, backupPath);
                } catch (_) {
                  // If the existing file is locked, do not destroy it.
                  cleanupTemp();
                  reject(new Error(`Existing file is locked and could not be replaced: ${destination}`));
                  return;
                }
              }

              try {
                fs.renameSync(tempPath, destination);
                try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch (_) {}
              } catch (error) {
                // Restore the original if replacement failed.
                try {
                  if (!fs.existsSync(destination) && fs.existsSync(backupPath)) {
                    fs.renameSync(backupPath, destination);
                  }
                } catch (_) {}
                cleanupTemp();
                reject(error);
                return;
              }

              resolve({ path: destination, md5: downloadedMd5 });
            } catch (error) {
              cleanupTemp();
              reject(error);
            }
          });

          readStream.on('error', (error) => {
            cleanupTemp();
            reject(error);
          });
        });
      });

      req.on('error', (error) => {
        console.error(`Download error for ${requestUrl}:`, error);
        try { file.close(); } catch (_) {}
        cleanupTemp();
        reject(error);
      });

      req.setTimeout(30000, () => {
        req.destroy();
        try { file.close(); } catch (_) {}
        cleanupTemp();
        reject(new Error('Download timeout after 30 seconds. Existing file was preserved.'));
      });
    };

    downloadTo(url);
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
// PRE-CU and NGE retain their existing login settings.
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

// Launch game
// ------------------------------
ipcMain.handle('launch-game', async (event, exePath) => {
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

    try {
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
          startWithPowerShell();
        } else {
          reject(new Error(`Windows could not start ${exeName}: ${err.message}`));
        }
      });
    } catch (err) {
      log(`Direct launch exception: ${err.message}`);
      startWithPowerShell();
    }
  });
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

    return { success: true, message: cleared ? 'Cache cleared successfully' : 'Cache was already empty' };
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
// GitHub release auto-updater
// ------------------------------
function configureAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[Updater] Development build; automatic updates disabled.');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking GitHub Releases...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update available: ${info.version}`);
    try { appendLauncherDiagnostic(`Update available: ${info.version}`); } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('launcher-update-available', { version: info.version });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log(`[Updater] Launcher is current (${info.version}).`);
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('launcher-update-progress', {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Update ${info.version} downloaded; it will install on exit.`);
    try { appendLauncherDiagnostic(`Update ${info.version} downloaded.`); } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('launcher-update-downloaded', { version: info.version });
    }
  });

  autoUpdater.on('error', (error) => {
    console.error('[Updater] Error:', error);
    try { appendLauncherDiagnostic(`Updater error: ${error.message || error}`); } catch (_) {}
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      console.error('[Updater] Check failed:', error.message || error);
    });
  }, 3000);
}

ipcMain.handle('check-launcher-update', async () => {
  if (!app.isPackaged) {
    return { success: false, development: true, message: 'Updates are disabled in development builds.' };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    return {
      success: true,
      updateAvailable: !!result?.updateInfo,
      version: result?.updateInfo?.version || null
    };
  } catch (error) {
    return { success: false, message: error.message || String(error) };
  }
});

ipcMain.handle('install-launcher-update', () => {
  if (!app.isPackaged) return { success: false, development: true };
  autoUpdater.quitAndInstall(false, true);
  return { success: true };
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






