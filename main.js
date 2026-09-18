// main.js - SWG Ghosts Launcher (Linux AppImage / Wine & Proton Cross-Compatibility Layer)
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
const PRECU_BASE_URL = 'https://ddns.net';
const NGE_BASE_URL = 'https://ddns.netnge/';
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

