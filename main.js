// main.js - SWG Ghosts Launcher
// 1920x1080 design, DPI/Zoom lock, sane sizing, F11 fullscreen toggle, window control IPC

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
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
const BASE_URL = 'https://51.81.81.116/tre/';

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
ipcMain.handle('load-required-files', async () => {
  return new Promise((resolve, reject) => {
    const url = BASE_URL + 'required-files.json';
    console.log(`Loading files from: ${url}`);

    const client = url.startsWith('https://') ? https : http;
    const req = client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = new URL(response.headers.location, url).toString();
        response.resume();
        const redirectClient = redirectUrl.startsWith('https://') ? https : http;
        redirectClient.get(redirectUrl, (redirectResponse) => {
          if (redirectResponse.statusCode !== 200) {
            reject(new Error(`Server returned status code: ${redirectResponse.statusCode}`));
            return;
          }
          let data = '';
          redirectResponse.on('data', (chunk) => (data += chunk));
          redirectResponse.on('end', () => parseRequiredFiles(data, resolve, reject));
        }).on('error', reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Server returned status code: ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', (chunk) => (data += chunk));
      response.on('end', () => parseRequiredFiles(data, resolve, reject));
    });

    req.on('error', (error) => {
      console.error('HTTPS request error:', error);
      reject(new Error('Failed to fetch files list: ' + error.message));
    });

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
      item.url &&
      item.md5 &&
      item.size > 0
    );

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

    const downloadTo = (requestUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const client = requestUrl.startsWith('https://') ? https : http;
      const file = fs.createWriteStream(destination);
      let downloadedBytes = 0;

      console.log(`Downloading: ${requestUrl} to ${destination}`);

      const req = client.get(requestUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          try { fs.unlinkSync(destination); } catch (_) {}
          response.resume();
          downloadTo(new URL(response.headers.location, requestUrl).toString(), redirectCount + 1);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(destination); } catch (_) {}
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
            resolve({ path: destination });
            return;
          }

          const hash = crypto.createHash('md5');
          const readStream = fs.createReadStream(destination);
          readStream.on('data', (data) => hash.update(data));
          readStream.on('end', () => {
            const downloadedMd5 = hash.digest('hex');
            if (downloadedMd5 !== expectedMd5) {
              try { fs.unlinkSync(destination); } catch (_) {}
              reject(new Error(`MD5 mismatch: expected ${expectedMd5}, got ${downloadedMd5}`));
            } else {
              resolve({ path: destination, md5: downloadedMd5 });
            }
          });
          readStream.on('error', reject);
        });
      });

      req.on('error', (error) => {
        console.error(`Download error for ${requestUrl}:`, error);
        try { fs.unlinkSync(destination); } catch (_) {}
        reject(error);
      });

      req.setTimeout(30000, () => {
        req.destroy();
        try { fs.unlinkSync(destination); } catch (_) {}
        reject(new Error('Download timeout after 30 seconds'));
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
// Launch game
// ------------------------------
ipcMain.handle('launch-game', async (event, exePath) => {
  return new Promise((resolve, reject) => {
    if (!exePath || typeof exePath !== 'string') {
      reject(new Error('Invalid executable path'));
      return;
    }

    if (!fs.existsSync(exePath)) {
      reject(new Error('Executable not found: ' + exePath));
      return;
    }

    try {
      const exeDir = path.dirname(exePath);
      const exeName = path.basename(exePath);
      const { spawn } = require('child_process');

      const gameProcess = spawn(exePath, [], {
        detached: true,
        stdio: 'ignore',
        cwd: exeDir,
        shell: true,
        windowsHide: false
      });

      gameProcess.on('error', (err) => { console.error('Launch failed:', err); });
      gameProcess.unref();

      if (gameProcess.pid) {
        resolve({
          success: true,
          pid: gameProcess.pid,
          message: `${exeName} launched successfully`
        });
      } else {
        reject(new Error('Failed to launch process'));
      }
    } catch (error) {
      reject(new Error(`Failed to launch game: ${error.message}`));
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
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (_) {
      return {};
    }
  }
  return {};
});

ipcMain.handle('save-install-dir', (event, dir) => {
  const settingsPath = getSettingsPath();
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    : {};
  settings.installDir = dir;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
});

ipcMain.handle('get-install-dir', () => {
  const settingsPath = getSettingsPath();
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return settings.installDir || null;
    } catch (_) {
      return null;
    }
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
app.whenReady().then(() => {
  createWindow();

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






