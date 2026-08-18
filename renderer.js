// renderer.js - SWG Ghosts Launcher (Renderer Process)

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

window.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const closeButton = document.getElementById('close-button');
  const minimizeButton = document.getElementById('minimize-button');
  const maximizeButton = document.getElementById('maximize-button');

  const playButton = document.getElementById('play-button');
  const quickScanButton = document.getElementById('quick-scan');
  const fullScanButton = document.getElementById('full-scan');
  const installLocationButton = document.getElementById('install-location');
  const settingsButton = document.getElementById('settings-button');
  const pauseButton = document.getElementById('pause-button');
  const clearCacheButton = document.getElementById('clear-cache');
  const viewLogsButton = document.getElementById('view-logs');
  const donateButton = document.getElementById('donate-button');

  const currentDirectoryElement = document.getElementById('current-directory');
  const totalProgressBar = document.getElementById('total-progress');
  const fileProgressBar = document.getElementById('file-progress');
  const totalStatusElement = document.getElementById('total-status');
  const statusElement = document.getElementById('status');
  const downloadSpeedElement = document.getElementById('download-speed');

  // Settings Modal Elements
  const modalOverlay = document.getElementById('modal-overlay');
  const settingsModal = document.getElementById('settings-modal');
  const settingsCloseButton = document.getElementById('settings-close');
  const scanModeSelect = document.getElementById('scan-mode-select');
  const autoLaunchCheckbox = document.getElementById('auto-launch-checkbox');
  const autoUpdateCheckbox = document.getElementById('auto-update-checkbox');
  const minimizeToTrayCheckbox = document.getElementById('minimize-to-tray-checkbox');
  const timeoutInput = document.getElementById('timeout-input');
  const saveSettingsButton = document.getElementById('save-settings');
  const resetSettingsButton = document.getElementById('reset-settings');
  const settingsStatus = document.getElementById('settings-status');

  // State
  let isScanning = false;
  let isPaused = false;
  let installDir = null;
  let lastDownloadUpdate = Date.now();
  let lastDownloadBytes = 0;

  // ------------------------------
  // Helpers
  // ------------------------------
  function updateStatus(text) {
    statusElement.textContent = text;
    console.log(`[Status] ${text}`);
  }

  function updateProgress(current, total, type = 'total') {
    if (!total || total <= 0) return;
    const percentage = (current / total) * 100;

    if (type === 'total') {
      totalProgressBar.style.width = `${percentage}%`;
      totalStatusElement.textContent = `${current}/${total} files`;
    } else {
      fileProgressBar.style.width = `${percentage}%`;
    }
  }

  function updateDownloadSpeed(bytesSoFar) {
    const now = Date.now();
    const timeDiff = (now - lastDownloadUpdate) / 1000;

    if (timeDiff >= 1) {
      const bytesDiff = bytesSoFar - lastDownloadBytes;
      const speed = bytesDiff / timeDiff;

      let speedText;
      if (speed >= 1048576) speedText = `${(speed / 1048576).toFixed(2)} MB/s`;
      else if (speed >= 1024) speedText = `${(speed / 1024).toFixed(2)} KB/s`;
      else speedText = `${speed.toFixed(0)} B/s`;

      downloadSpeedElement.textContent = `Download speed: ${speedText}`;
      lastDownloadUpdate = now;
      lastDownloadBytes = bytesSoFar;
    }
  }

  // ------------------------------
  // Window Controls
  // ------------------------------
  async function refreshMaximizeIcon() {
    try {
      const isMax = await ipcRenderer.invoke('window:isMaximized');
      maximizeButton.textContent = isMax ? '❐' : '▢';
    } catch (_) {}
  }

  closeButton.addEventListener('click', async () => {
    await ipcRenderer.invoke('window:close');
  });

  minimizeButton.addEventListener('click', async () => {
    await ipcRenderer.invoke('window:minimize');
  });

  maximizeButton.addEventListener('click', async () => {
    await ipcRenderer.invoke('window:maximizeToggle');
    await refreshMaximizeIcon();
  });

  // (Main handles F11 already; keeping this is harmless)
  window.addEventListener('keydown', async (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      await ipcRenderer.invoke('window:toggleFullscreen');
    }
  });

  // ------------------------------
  // Settings Modal
  // ------------------------------
  function openSettingsModal() {
    modalOverlay.style.display = 'block';
    settingsModal.style.display = 'block';
    loadSettings();
  }

  function closeSettingsModal() {
    modalOverlay.style.display = 'none';
    settingsModal.style.display = 'none';
  }

  settingsButton.addEventListener('click', openSettingsModal);
  settingsCloseButton.addEventListener('click', closeSettingsModal);
  modalOverlay.addEventListener('click', closeSettingsModal);
  settingsModal.addEventListener('click', (e) => e.stopPropagation());

  async function loadSettings() {
    try {
      const scanMode = await ipcRenderer.invoke('get-scan-mode');
      scanModeSelect.value = scanMode || 'quick';

      const settings = await ipcRenderer.invoke('get-settings');
      if (settings) {
        autoLaunchCheckbox.checked = settings.autoLaunch || false;
        autoUpdateCheckbox.checked = settings.autoUpdate || false;
        minimizeToTrayCheckbox.checked = settings.minimizeToTray || false;
        timeoutInput.value = settings.timeout || 30;
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  async function resetSettings() {
    scanModeSelect.value = 'quick';
    autoLaunchCheckbox.checked = false;
    autoUpdateCheckbox.checked = false;
    minimizeToTrayCheckbox.checked = false;
    timeoutInput.value = 30;
    settingsStatus.textContent = 'Defaults restored. Click SAVE SETTINGS to apply.';
  }

  async function saveSettings() {
    try {
      const settings = {
        scanMode: scanModeSelect.value,
        autoLaunch: autoLaunchCheckbox.checked,
        autoUpdate: autoUpdateCheckbox.checked,
        minimizeToTray: minimizeToTrayCheckbox.checked,
        timeout: parseInt(timeoutInput.value, 10) || 30
      };

      await ipcRenderer.invoke('save-settings', settings);
      updateStatus('Settings saved successfully');
      settingsStatus.textContent = 'Settings saved successfully.';
      setTimeout(closeSettingsModal, 450);
    } catch (error) {
      updateStatus(`Failed to save settings: ${error.message}`);
    }
  }

  saveSettingsButton.addEventListener('click', saveSettings);
  resetSettingsButton.addEventListener('click', resetSettings);

  // ------------------------------
  // Install Directory
  // ------------------------------
  async function showInstallLocationDialog() {
    try {
      const selectedDir = await ipcRenderer.invoke('select-directory');
      if (selectedDir) {
        installDir = selectedDir;
        currentDirectoryElement.textContent = installDir;
        await ipcRenderer.invoke('save-install-dir', installDir);
        updateStatus(`Install directory set: ${installDir}`);
      }
    } catch (error) {
      updateStatus(`Error selecting directory: ${error.message}`);
    }
  }

  installLocationButton.addEventListener('click', showInstallLocationDialog);

  // ------------------------------
  // Play button
  // ------------------------------
  playButton.addEventListener('click', async () => {
    if (!installDir) {
      updateStatus('Please set an install location first');
      await showInstallLocationDialog();
      return;
    }

    const possibleExecutables = [
      'SWGEmu.exe',
      'swgemu.exe',
      'SWGEMU.exe',
      'SWGEmu/SWGEmu.exe',
      'game/SWGEmu.exe',
      'Star Wars Galaxies/SWGEmu.exe',
      'SWGEmu Live/SWGEmu.exe'
    ];

    let exePath = null;
    let foundExeName = '';

    for (const exeName of possibleExecutables) {
      const testPath = path.join(installDir, exeName);
      if (fs.existsSync(testPath)) {
        exePath = testPath;
        foundExeName = exeName;
        break;
      }
    }

    if (!exePath) {
      updateStatus('Could not find SWGEmu.exe. Please verify your installation.');
      const ok = confirm('SWGEmu.exe not found. Would you like to browse for it?');
      if (!ok) return;

      const picked = await ipcRenderer.invoke('select-file');
      if (!picked) return;
      exePath = picked;
      foundExeName = path.basename(picked);
    }

    try {
      updateStatus(`Launching ${foundExeName}...`);
      await ipcRenderer.invoke('launch-game', exePath, installDir);
      updateStatus(`${foundExeName} launched successfully`);
    } catch (error) {
      updateStatus(`Launch failed: ${error.message}`);
    }
  });

  // ------------------------------
  // Scanning
  // ------------------------------
  quickScanButton.addEventListener('click', () => {
    if (!installDir) {
      updateStatus('Please set an install location first');
      showInstallLocationDialog();
      return;
    }
    startScan('quick');
  });

  fullScanButton.addEventListener('click', () => {
    if (!installDir) {
      updateStatus('Please set an install location first');
      showInstallLocationDialog();
      return;
    }
    startScan('full');
  });

  pauseButton.addEventListener('click', () => {
    isPaused = !isPaused;
    pauseButton.textContent = isPaused ? 'RESUME SCAN' : 'PAUSE SCAN';
    updateStatus(isPaused ? 'Scan paused' : 'Scan resumed');
  });

  clearCacheButton.addEventListener('click', async () => {
    try {
      await ipcRenderer.invoke('clear-cache');
      updateStatus('Cache cleared');
    } catch (error) {
      updateStatus(`Failed to clear cache: ${error.message}`);
    }
  });

  viewLogsButton.addEventListener('click', async () => {
    try {
      await ipcRenderer.invoke('open-logs');
      updateStatus('Opening logs...');
    } catch (error) {
      updateStatus(`Failed to open logs: ${error.message}`);
    }
  });

  donateButton.addEventListener('click', () => {
    require('electron').shell.openExternal('https://www.paypal.me/Fitzpatrick251');
    updateStatus('Opening PayPal donation page...');
  });


  // These files contain per-player/per-machine settings and must NEVER be
  // overwritten by launcher patching. They are deliberately local-only.
  const PROTECTED_LOCAL_SETTINGS = new Set([
    'options.cfg',
    'user.cfg',
    'swgemu_machineoptions.iff'
  ]);

  function isProtectedLocalSetting(fileName) {
    const normalized = String(fileName || '').replace(/\\/g, '/').toLowerCase();
    const base = normalized.split('/').pop();
    return PROTECTED_LOCAL_SETTINGS.has(base);
  }

  async function startScan(mode) {
    if (isScanning) return updateStatus('Scan already in progress');

    isScanning = true;
    isPaused = false;
    pauseButton.textContent = 'PAUSE SCAN';
    downloadSpeedElement.textContent = '';
    lastDownloadUpdate = Date.now();
    lastDownloadBytes = 0;

    try {
      updateStatus(`Starting ${mode} scan...`);
      await ipcRenderer.invoke('save-scan-mode', mode);

      updateStatus('Loading file list from server...');
      const files = await ipcRenderer.invoke('load-required-files');

      let verifiedCount = 0;
      let downloadedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < files.length; i++) {
        if (isPaused) {
          updateStatus('Scan paused. Click Resume to continue.');
          while (isPaused) await new Promise(r => setTimeout(r, 100));
          updateStatus('Resuming scan...');
        }

        const file = files[i];
        const localPath = path.join(installDir, file.name);

        updateStatus(`Checking: ${file.name}`);
        updateProgress(i + 1, files.length, 'total');

        // Never replace the user's game settings, even if an old/stale
        // required-files.json accidentally lists them.
        if (isProtectedLocalSetting(file.name) && fs.existsSync(localPath)) {
          verifiedCount++;
          updateProgress(100, 100, 'file');
          updateStatus(`Preserved local settings: ${file.name}`);
          continue;
        }

        if (fs.existsSync(localPath)) {
          try {
            const localMd5 = await ipcRenderer.invoke('check-md5', localPath);
            if (localMd5 === file.md5) {
              verifiedCount++;
              updateProgress(100, 100, 'file');
            } else {
              downloadedCount++;
              await downloadFile(file, localPath);
            }
          } catch (_) {
            errorCount++;
            downloadedCount++;
            await downloadFile(file, localPath);
          }
        } else {
          downloadedCount++;
          await downloadFile(file, localPath);
        }
      }

      updateStatus(`Scan complete. Verified: ${verifiedCount}, Downloaded: ${downloadedCount}, Errors: ${errorCount}`);
    } catch (error) {
      updateStatus(`Scan error: ${error.message}`);
    } finally {
      isScanning = false;
      downloadSpeedElement.textContent = '';
    }
  }

  async function downloadFile(file, destination) {
    if (isProtectedLocalSetting(file.name) && fs.existsSync(destination)) {
      updateStatus(`Preserved local settings: ${file.name}`);
      return true;
    }

    updateStatus(`Downloading: ${file.name}`);

    try {
      // Always build the download URL from the current Ghosts HTTPS TRE host.
      // The manifest may still contain legacy manifest/IP URLs, so never trust
      // item.url for the actual download destination.
      const relativeName = String(file.name || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');
      const url = `https://51-81-81-116.sslip.io/tre/${relativeName}`;

      await ipcRenderer.invoke('download-file', {
        url,
        destination,
        expectedMd5: file.md5,
        size: file.size
      });

      updateStatus(`Downloaded: ${file.name}`);
      return true;
    } catch (error) {
      updateStatus(`Download failed for ${file.name}: ${error.message}`);
      return false;
    }
  }

  // Progress updates from main
  ipcRenderer.on('file-progress', (event, data) => {
    updateProgress(data.downloaded, data.total, 'file');
    updateDownloadSpeed(data.downloaded);
  });

  // ------------------------------
  // Init
  // ------------------------------
  (async function init() {
    installDir = await ipcRenderer.invoke('get-install-dir');

    if (installDir) {
      currentDirectoryElement.textContent = installDir;
      updateStatus(`Install directory: ${installDir}`);
    } else {
      currentDirectoryElement.textContent = 'No install directory set';
      updateStatus('Please set an install location');
    }

    await loadSettings();
    await refreshMaximizeIcon();
    updateStatus('Ready');
  })();
});
