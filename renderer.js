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
  const gameVersionSelect = document.getElementById('game-version-select');
  const currentVersionElement = document.getElementById('current-version');
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
  const enhancedGraphicsCheckbox = document.getElementById('enhanced-graphics-checkbox');
  const timeoutInput = document.getElementById('timeout-input');
  const saveSettingsButton = document.getElementById('save-settings');

  // State
  let isScanning = false;
  let isPaused = false;
  let installDir = null;
  let gameVersion = 'precu';
  let enhancedGraphicsEnabled = false;
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
        const enhancedMap = settings.enhancedGraphics || {};
        enhancedGraphicsEnabled = !!enhancedMap[gameVersion];
        enhancedGraphicsCheckbox.checked = enhancedGraphicsEnabled;
        timeoutInput.value = settings.timeout || 30;
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  async function saveSettings() {
    try {
      enhancedGraphicsEnabled = enhancedGraphicsCheckbox.checked;
      const existing = await ipcRenderer.invoke('get-settings') || {};
      const enhancedMap = { ...(existing.enhancedGraphics || {}) };
      enhancedMap[gameVersion] = enhancedGraphicsEnabled;

      const settings = {
        scanMode: scanModeSelect.value,
        autoLaunch: autoLaunchCheckbox.checked,
        autoUpdate: autoUpdateCheckbox.checked,
        minimizeToTray: minimizeToTrayCheckbox.checked,
        enhancedGraphics: enhancedMap,
        timeout: parseInt(timeoutInput.value, 10) || 30
      };

      await ipcRenderer.invoke('save-settings', settings);
      closeSettingsModal();

      if (enhancedGraphicsEnabled) {
        updateStatus(`${versionLabel(gameVersion)} Enhanced Graphics enabled — syncing UI files...`);
        await syncEnhancedGraphics();
      } else {
        updateStatus(`${versionLabel(gameVersion)} Enhanced Graphics disabled. Existing files were left untouched.`);
      }
    } catch (error) {
      updateStatus(`Failed to save settings: ${error.message}`);
    }
  }

  saveSettingsButton.addEventListener('click', saveSettings);

  // ------------------------------
  // Install Directory / Game Version
  // ------------------------------
  function versionLabel(version) {
    return version === 'nge' ? 'NGE' : (version === 'precu-testcenter' ? 'PRE-CU TEST CENTER' : 'PRE-CU');
  }

  async function loadVersionInstallDir() {
    gameVersion = gameVersionSelect.value || 'precu';

    try {
      const settings = await ipcRenderer.invoke('get-settings') || {};
      const enhancedMap = settings.enhancedGraphics || {};
      enhancedGraphicsEnabled = !!enhancedMap[gameVersion];
      enhancedGraphicsCheckbox.checked = enhancedGraphicsEnabled;
    } catch (_) {
      enhancedGraphicsEnabled = false;
      enhancedGraphicsCheckbox.checked = false;
    }

    // Never carry another profile's install path into this profile.
    installDir = null;
    currentDirectoryElement.textContent = `Loading ${versionLabel(gameVersion)} install location...`;

    installDir = await ipcRenderer.invoke('get-install-dir', gameVersion);
    currentVersionElement.textContent = `Version: ${versionLabel(gameVersion)}`;

    if (installDir) {
      currentDirectoryElement.textContent = installDir;
      updateStatus(`${versionLabel(gameVersion)} install directory: ${installDir}`);
    } else {
      currentDirectoryElement.textContent = `No ${versionLabel(gameVersion)} install directory set`;
      updateStatus(`Set a ${versionLabel(gameVersion)} installation directory`);
    }
  }

  async function showInstallLocationDialog() {
    try {
      const selectedDir = await ipcRenderer.invoke('select-directory');
      if (selectedDir) {
        installDir = selectedDir;
        currentDirectoryElement.textContent = installDir;
        await ipcRenderer.invoke('save-install-dir', {
          version: gameVersion,
          dir: installDir
        });
        updateStatus(`${versionLabel(gameVersion)} install directory set: ${installDir}`);
      }
    } catch (error) {
      updateStatus(`Error selecting directory: ${error.message}`);
    }
  }

  gameVersionSelect.addEventListener('change', async () => {
    installDir = null;
    await loadVersionInstallDir();
  });
  installLocationButton.addEventListener('click', showInstallLocationDialog);

  // ------------------------------
  // Launcher auto-update notifications
  // ------------------------------
  ipcRenderer.on('launcher-update-available', (_event, info) => {
    updateStatus(`Launcher update ${info.version} downloading...`);
  });

  ipcRenderer.on('launcher-update-downloaded', (_event, info) => {
    updateStatus(`Launcher update ${info.version} ready — it will install when the launcher closes.`);
  });

  // ------------------------------
  // Play button
  // ------------------------------
  playButton.addEventListener('click', async () => {
    if (!installDir) {
      updateStatus(`Please set the ${versionLabel(gameVersion)} install location first`);
      await showInstallLocationDialog();
      if (!installDir) return;
    }

    try {
      updateStatus(`Checking ${versionLabel(gameVersion)} installation...`);

      let diagnostic = await ipcRenderer.invoke('check-installation', {
        version: gameVersion,
        dir: installDir
      });

      // If the selected directory is wrong, let the user choose the actual
      // executable. This path is then remembered for that version.
      if (!diagnostic.ok) {
        updateStatus(diagnostic.message || diagnostic.error || 'Game executable not found.');
        const ok = confirm(
          `${diagnostic.expected || 'Game executable'} was not found in this installation directory.\n\n` +
          `Would you like to select the executable manually?`
        );
        if (!ok) return;

        const picked = await ipcRenderer.invoke('select-file');
        if (!picked) return;

        const pickedDir = path.dirname(picked);
        const pickedName = path.basename(picked).toLowerCase();

        const valid = gameVersion === 'nge'
          ? pickedName === 'swgclient_r.exe'
          : pickedName === 'swgemu.exe';

        if (!valid) {
          updateStatus(
            gameVersion === 'nge'
              ? 'Please select swgclient_r.exe for the NGE client.'
              : 'Please select SWGEmu.exe for the PRE-CU client.'
          );
          return;
        }

        installDir = pickedDir;
        currentDirectoryElement.textContent = installDir;

        await ipcRenderer.invoke('save-install-dir', {
          version: gameVersion,
          dir: installDir
        });
        await ipcRenderer.invoke('save-settings', {
          [gameVersion === 'nge'
            ? 'ngeExecutable'
            : (gameVersion === 'precu-testcenter' ? 'precuTestCenterExecutable' : 'precuExecutable')]: picked
        });

        diagnostic = {
          ok: true,
          executable: picked,
          message: `Found ${path.basename(picked)}`
        };
      }

      let exePath = diagnostic.executable;
      if (!exePath) {
        updateStatus(`No ${versionLabel(gameVersion)} executable found.`);
        return;
      }

      // Before launching any profile, perform a full manifest scan. This is
      // especially important for NGE: a missing client DLL/config/asset can
      // result in the game generating .dmp/.mdmp crash files instead of a
      // useful launcher error.
      updateStatus(`Verifying complete ${versionLabel(gameVersion)} client...`);
// The executable may live in a subdirectory. Re-resolve it after the
      // scan instead of assuming it is directly under the install root.

      const foundExeName = path.basename(exePath);

      if (gameVersion === 'precu-testcenter') {
        updateStatus('Configuring PRE-CU Test Center login server...');
        const loginResult = await ipcRenderer.invoke('configure-server-login', {
          version: gameVersion,
          dir: installDir
        });

        if (!loginResult || !loginResult.success) {
          throw new Error(
            loginResult?.error ||
            'Could not configure the PRE-CU Test Center login server.'
          );
        }
      }

      updateStatus(`Launching ${versionLabel(gameVersion)} — ${foundExeName}...`);
      const result = await ipcRenderer.invoke('launch-game', exePath);

      if (result && result.success) {
        updateStatus(`${versionLabel(gameVersion)} launched successfully`);
      } else {
        throw new Error('The game process did not start.');
      }
    } catch (error) {
      console.error('Launch error:', error);
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

  function isEnhancedGraphicsFile(file) {
    const name = String(file?.name || '').replace(/\\/g, '/').replace(/^[/\\]+/, '').toLowerCase();
    // The enhanced package is intentionally limited to the existing TRE UI
    // overlay plus UI-scaling .dat files. ReShade and unrelated client files
    // remain under the normal manifest and are never toggled here.
    return name.startsWith('ui/') || name.endsWith('.dat');
  }

  function shouldPatchFile(file) {
    return enhancedGraphicsEnabled || !isEnhancedGraphicsFile(file);
  }

  async function loadPatchFiles() {
    const selectedFiles = await ipcRenderer.invoke('load-required-files', gameVersion);
    if (!Array.isArray(selectedFiles)) return [];

    const normalFiles = selectedFiles.filter(file => !isEnhancedGraphicsFile(file));
    if (!enhancedGraphicsEnabled) return normalFiles;

    // Enhanced UI/scaling files are hosted in the shared /tre/ tree. For NGE,
    // pull those entries from the shared PRE-CU manifest and apply them to the
    // currently selected NGE installation.
    const sharedFiles = gameVersion === 'precu' || gameVersion === 'precu-testcenter'
      ? selectedFiles
      : await ipcRenderer.invoke('load-required-files', 'precu');
    const enhancedFiles = Array.isArray(sharedFiles)
      ? sharedFiles.filter(isEnhancedGraphicsFile)
      : [];

    const seen = new Set(normalFiles.map(file => String(file.name || '').toLowerCase()));
    for (const file of enhancedFiles) {
      const key = String(file.name || '').toLowerCase();
      if (!seen.has(key)) {
        normalFiles.push(file);
        seen.add(key);
      }
    }

    return normalFiles;
  }

  async function syncEnhancedGraphics() {
    if (!installDir) {
      updateStatus(`Set the ${versionLabel(gameVersion)} install location first.`);
      return { success: false, errors: 1 };
    }

    try {
      // Enhanced files live in the shared /tre/ tree even when NGE is selected.
      const files = await ipcRenderer.invoke('load-required-files', 'precu');
      const enhancedFiles = Array.isArray(files) ? files.filter(isEnhancedGraphicsFile) : [];
      if (!enhancedFiles.length) {
        updateStatus('No Enhanced Graphics files were found in the shared TRE manifest.');
        return { success: false, errors: 1 };
      }

      let errors = 0;
      for (let i = 0; i < enhancedFiles.length; i++) {
        const file = enhancedFiles[i];
        const normalizedName = String(file.name || '').replace(/\\/g, '/').replace(/^[/\\]+/, '');
        const localPath = path.join(installDir, normalizedName);
        updateProgress(i + 1, enhancedFiles.length, 'total');
        updateStatus(`Enhanced Graphics: ${normalizedName}`);

        let valid = false;
        if (fs.existsSync(localPath)) {
          try {
            const localMd5 = await ipcRenderer.invoke('check-md5', localPath);
            valid = String(localMd5).toLowerCase() === String(file.md5).toLowerCase();
          } catch (_) {}
        }

        if (!valid && !(await downloadFile(file, localPath, true))) errors++;
      }

      updateStatus(errors === 0
        ? `${versionLabel(gameVersion)} Enhanced Graphics installed and verified.`
        : `Enhanced Graphics finished with ${errors} download error(s).`);
      return { success: errors === 0, errors };
    } catch (error) {
      updateStatus(`Enhanced Graphics error: ${error.message}`);
      return { success: false, errors: 1 };
    }
  }

  async function runFullScanForLaunch() {
    if (!installDir) return { success: false, errors: 1 };

    try {
      const files = await loadPatchFiles();
      if (!Array.isArray(files) || files.length === 0) {
        return { success: false, errors: 1 };
      }

      let errors = 0;
      let missing = 0;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!shouldPatchFile(file)) {
          updateProgress(i + 1, files.length, 'total');
          continue;
        }
        const normalizedName = String(file.name || '')
          .replace(/\\/g, '/')
          .replace(/^[/\\]+/, '');
        const localPath = path.join(installDir, normalizedName);
        const lowerName = normalizedName.toLowerCase();

        // Existing local user state is intentionally preserved. If the file
        // exists, it is considered locally owned; if it does not exist on a
        // fresh install, it must be downloaded from the manifest.
        const localStateFile =
          ['options.cfg','user.cfg','swgemu.cfg','swgemu_machineoptions.iff',
           'swgemu_login.cfg','login.cfg','swgemu_preload.cfg'].includes(lowerName);
        const preserveExisting =
          (localStateFile && fs.existsSync(localPath)) ||
          (lowerName.startsWith('profiles/') && fs.existsSync(localPath));

        if (preserveExisting) continue;

        let valid = false;
        if (fs.existsSync(localPath)) {
          try {
            const md5 = await ipcRenderer.invoke('check-md5', localPath);
            valid = String(md5).toLowerCase() === String(file.md5).toLowerCase();
          } catch (_) {}
        }

        if (!valid) {
          if (!fs.existsSync(localPath)) missing++;
          if (!(await downloadFile(file, localPath, isEnhancedGraphicsFile(file)))) errors++;
        }

        updateProgress(i + 1, files.length, 'total');
      }

      // Re-check using the main-process executable resolver. This supports
      // nested client layouts and all supported case variants.
      const diag = await ipcRenderer.invoke('check-installation', {
        version: gameVersion,
        dir: installDir
      });
      if (!diag.ok) errors++;

      return { success: errors === 0, errors: errors + missing };
    } catch (error) {
      console.error('Pre-launch full scan failed:', error);
      return { success: false, errors: 1 };
    }
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
      const files = await loadPatchFiles();

      if (!Array.isArray(files) || files.length === 0) {
        throw new Error(
          `${versionLabel(gameVersion)} file manifest is empty or unavailable. ` +
          `Check the internet connection and server manifest URL.`
        );
      }

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
        if (!shouldPatchFile(file)) {
          updateProgress(i + 1, files.length, 'total');
          continue;
        }
        const normalizedName = String(file.name || '').replace(/\\/g, '/').replace(/^[/\\]+/, '');
        const localPath = path.join(installDir, normalizedName);
        const lowerName = normalizedName.toLowerCase();

        updateStatus(`Checking: ${normalizedName}`);
        updateProgress(i + 1, files.length, 'total');

        // Never patch/delete local user state or the client executable itself.
        // These are intentionally outside server patch ownership.
        const localStateFile =
          ['options.cfg','user.cfg','swgemu.cfg','swgemu_machineoptions.iff',
           'swgemu_login.cfg','login.cfg','swgemu_preload.cfg'].includes(lowerName);

        // Preserve existing local/user state, but allow every one of these
        // files to download on a fresh installation.
        const protectedLocal =
          (localStateFile && fs.existsSync(localPath)) ||
          (lowerName.startsWith('profiles/') && fs.existsSync(localPath)) ||
          ((lowerName === 'swgclient_r.exe' || lowerName === 'swgemu.exe') &&
           fs.existsSync(localPath));

        if (!fs.existsSync(localPath)) {
          updateStatus(`Downloading ${versionLabel(gameVersion)} client file: ${normalizedName}`);
        }

        if (protectedLocal) {
          verifiedCount++;
          updateStatus(`Preserved local file: ${normalizedName}`);
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
              if (!(await downloadFile(file, localPath, isEnhancedGraphicsFile(file)))) errorCount++;
            }
          } catch (error) {
            errorCount++;
            updateStatus(`Check failed for ${normalizedName}: ${error.message}`);
          }
        } else {
          downloadedCount++;
          if (!(await downloadFile(file, localPath, isEnhancedGraphicsFile(file)))) errorCount++;
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

  async function downloadFile(file, destination, enhancedGraphics = false) {
    updateStatus(`Downloading: ${file.name}`);

    try {
      const baseUrl = enhancedGraphics
        ? 'https://swg-ghosts.online/tre/'
        : (gameVersion === 'nge'
          ? 'https://swg-ghosts.online/tre/nge/'
          : 'https://swg-ghosts.online/tre/');
      // Enhanced Graphics is hosted in the shared /tre/ tree. Normal client
      // files remain version-specific (/tre/ or /tre/nge/).
      const url = baseUrl + file.name.replace(/^[/\\]+/, '');

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
    await loadSettings();
    await loadVersionInstallDir();
    await refreshMaximizeIcon();
    updateStatus('Ready');
  })();
});
