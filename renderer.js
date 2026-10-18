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
  const clientSetupButton = document.getElementById('client-setup');
  const installLocationButton = document.getElementById('install-location');
  const gameVersionRadios = Array.from(document.querySelectorAll('input[name="game-version"]'));
  function selectedGameVersion() {
    const checked = gameVersionRadios.find(r => r.checked);
    return checked ? checked.value : 'precu';
  }
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

      const savedVersion = await ipcRenderer.invoke('get-game-version');
      if (savedVersion) {
        const radio = gameVersionRadios.find(r => r.value === savedVersion);
        if (radio) radio.checked = true;
      }

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

  function versionValidExe(version, lowerName) {
    return version === 'nge' ? lowerName === 'swgclient_r.exe' : lowerName === 'swgemu.exe';
  }

  function versionExeSettingKey(version) {
    return version === 'nge' ? 'ngeExecutable'
      : (version === 'precu-testcenter' ? 'precuTestCenterExecutable' : 'precuExecutable');
  }

  async function loadVersionInstallDir() {
    gameVersion = selectedGameVersion();

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

  gameVersionRadios.forEach(radio => radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    await ipcRenderer.invoke('save-game-version', radio.value);
    installDir = null;
    await loadVersionInstallDir();
  }));
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

        const valid = versionValidExe(gameVersion, pickedName);

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
          [versionExeSettingKey(gameVersion)]: picked
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

      // Launch checks removed in 2.2.4: Play launches the executable as-is
      // with no manifest verification scan. Manual Quick/Full scans remain
      // available from the buttons for repairing an install.
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
      const result = await ipcRenderer.invoke('launch-game', exePath, installDir);

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
    // Full means full: every file is re-read, ignoring the verification cache.
    startScan('full');
  });

  // ------------------------------
  // Client setup utility
  // ------------------------------
  // Opens SwgClientSetup_r.exe from the selected installation. The main process
  // resolves it (nested layouts included) and starts it with the same
  // never-elevated rule the game client uses.
  if (clientSetupButton) {
    clientSetupButton.addEventListener('click', async () => {
      if (!installDir) {
        updateStatus('Please set an install location first');
        showInstallLocationDialog();
        return;
      }

      try {
        updateStatus('Opening the client setup utility...');
        const result = await ipcRenderer.invoke('launch-client-setup', { dir: installDir });

        if (result && result.success) {
          const name = path.basename(result.setup || 'SwgClientSetup_r.exe');
          updateStatus(`${name} opened`);
        } else {
          updateStatus(`Client setup unavailable: ${(result && result.error) || 'unknown error'}`);
        }
      } catch (error) {
        updateStatus(`Client setup failed: ${error.message}`);
      }
    });
  }

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

  // Manifest names come from the file host, so they are not guaranteed to be
  // URL-safe. Requesting one segment at a time and escaping each keeps names
  // with spaces or '#' fetchable (a raw '#' would be read as a fragment).
  function encodeManifestName(name) {
    return String(name == null ? '' : name)
      .replace(/\\/g, '/')
      .replace(/^[/\\]+/, '')
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
  }

  // ipcRenderer.invoke() re-wraps whatever the main process rejected, e.g.
  // "Error invoking remote method 'download-file': Error: HTTP 404". Strip the
  // wrapper so the player sees the real cause.
  function describeIpcError(error) {
    return String((error && error.message) || error || 'unknown error')
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^Error:\s*/, '');
  }

  // "name (reason), name (reason)" - the point of naming them is that the old
  // message only said how many files failed.
  function summarizeFailedFiles(failed, limit = 3) {
    const list = Array.isArray(failed) ? failed : [];
    const shown = list.slice(0, limit)
      .map(entry => (entry && entry.reason ? `${entry.name} (${entry.reason})` : String((entry && entry.name) || entry)))
      .join(', ');
    return list.length > limit ? `${shown} (+${list.length - limit} more)` : shown;
  }

  // The advice has to match the cause: telling someone to check their
  // connection when the file host serves bytes that disagree with its own
  // manifest sends them round a loop that can never succeed.
  function verificationHint(failed) {
    const reasons = (Array.isArray(failed) ? failed : [])
      .map(entry => String((entry && entry.reason) || '').toLowerCase());
    const network = reasons.some(r => /timeout|timed out|econnreset|socket|network|refused|unreachable|http 5\d\d|http 429/.test(r));
    const checksum = reasons.some(r => r.includes('md5'));

    if (checksum && !network) {
      return 'The file host served bytes that do not match the checksums in its own manifest, so these files cannot be repaired from the client side. Press Play after the manifest is refreshed on the server.';
    }
    if (checksum && network) {
      return 'Check your connection and press Play again; if the same files fail, the file host manifest is out of date.';
    }
    if (network) {
      return 'Check your connection and press Play again.';
    }
    return 'Run a scan, then press Play again.';
  }

  function versionManifestUrl(version) {
    return version === 'nge'
      ? 'https://swg-ghosts.online/tre/nge/required-files.json'
      : 'https://swg-ghosts.online/tre/required-files.json';
  }

  function versionFileUrl(version) {
    return version === 'nge'
      ? 'https://swg-ghosts.online/tre/nge/'
      : 'https://swg-ghosts.online/tre/';
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
      // Enhanced files live in the shared /tre/ tree.
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

        if (!valid) {
          const result = await downloadFile(file, localPath, true);
          if (!result.ok) errors++;
        }
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

  // ------------------------------
  // Patch reconciliation
  // ------------------------------
  // Scanning used to hash every manifest file one at a time and then download
  // strictly sequentially. Neither scale to a multi-gigabyte client, so both are
  // now done through bounded worker pools, and the hashing itself happens in the
  // main process (see `verify-files`) where it can run several files at once.
  const DOWNLOAD_CONCURRENCY = 4;
  const VERIFY_CONCURRENCY = 8;

  function normalizeManifestName(name) {
    return String(name || '').replace(/\\/g, '/').replace(/^[/\\]+/, '');
  }

  // Local user state is never overwritten — but it is allowed to download when
  // it does not exist yet, which is what makes a fresh install work.
  function isProtectedLocalFile(lowerName, localPath, preserveExecutable) {
    const localStateFile =
      ['options.cfg', 'user.cfg', 'swgemu.cfg', 'swgemu_machineoptions.iff',
       'swgemu_login.cfg', 'login.cfg', 'swgemu_preload.cfg',
       'live.cfg', 'local_machine_options.iff'].includes(lowerName);

    if (localStateFile && fs.existsSync(localPath)) return true;
    if (lowerName.startsWith('profiles/') && fs.existsSync(localPath)) return true;
    if (preserveExecutable &&
        (lowerName === 'swgclient_r.exe' || lowerName === 'swgemu.exe') &&
        fs.existsSync(localPath)) return true;

    return false;
  }

  // Bounded-concurrency worker pool: keeps N jobs in flight, reusing the same
  // helpers for downloads so both phases behave the same way.
  async function runPool(items, worker, concurrency) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];

    const results = new Array(list.length);
    let next = 0;
    const workers = Math.max(1, Math.min(Number(concurrency) || 1, list.length));

    async function run() {
      for (;;) {
        const index = next++;
        if (index >= list.length) return;
        try {
          results[index] = { ok: true, value: await worker(list[index], index) };
        } catch (error) {
          results[index] = { ok: false, error };
        }
      }
    }

    await Promise.all(Array.from({ length: workers }, run));
    return results;
  }

  // Verify the whole manifest in one batched call, then download only what
  // failed. `useCache` false forces every byte to be re-read.
  async function reconcile(files, options) {
    const opts = options || {};
    const useCache = opts.useCache !== false;
    const label = opts.label || 'Scan';
    const preserveExecutable = opts.preserveExecutable === true;

    const verifyTargets = [];
    const missing = [];
    let preserved = 0;

    for (const file of files) {
      if (!shouldPatchFile(file)) continue;

      const normalizedName = normalizeManifestName(file.name);
      const localPath = path.join(installDir, normalizedName);
      const lowerName = normalizedName.toLowerCase();

      if (isProtectedLocalFile(lowerName, localPath, preserveExecutable)) {
        preserved++;
        continue;
      }

      if (!fs.existsSync(localPath)) {
        missing.push({ file, localPath, normalizedName });
      } else {
        verifyTargets.push({ file, localPath, normalizedName });
      }
    }

    updateStatus(
      `${label}: verifying ${verifyTargets.length} file(s)` +
      (useCache ? '...' : ' — forced recheck, reading every file...')
    );

    let verifications = [];
    if (verifyTargets.length) {
      verifications = await ipcRenderer.invoke('verify-files', {
        entries: verifyTargets.map(t => ({
          filePath: t.localPath,
          expectedMd5: t.file.md5,
          size: t.file.size
        })),
        useCache,
        concurrency: VERIFY_CONCURRENCY
      });
    }

    const toDownload = [];
    let verified = 0;
    let cacheHits = 0;

    for (let i = 0; i < verifyTargets.length; i++) {
      const res = verifications[i] || {};
      if (res.status === 'ok') {
        verified++;
        if (res.cached) cacheHits++;
      } else {
        toDownload.push(verifyTargets[i]);
      }
    }
    for (const entry of missing) toDownload.push(entry);

    let errors = 0;
    const failed = [];
    if (toDownload.length) {
      updateStatus(`${label}: downloading ${toDownload.length} file(s) (${DOWNLOAD_CONCURRENCY} in parallel)`);

      let done = 0;
      await runPool(toDownload, async (target) => {
        if (isPaused) {
          while (isPaused) await new Promise(r => setTimeout(r, 120));
        }
        const result = await downloadFile(target.file, target.localPath, isEnhancedGraphicsFile(target.file));
        if (!result.ok) {
          errors++;
          failed.push({
            name: String(target.file && target.file.name ? target.file.name : 'unknown file'),
            reason: result.reason || 'download failed'
          });
        }
        done++;
        updateProgress(done, toDownload.length, 'total');
        return result.ok;
      }, DOWNLOAD_CONCURRENCY);

      updateStatus(`${label}: ${done} file(s) processed`);
    }

    return {
      verified,
      cacheHits,
      downloaded: toDownload.length,
      errors,
      failed,
      failedNames: failed.map(entry => entry.name),
      preserved,
      total: verifyTargets.length + missing.length
    };
  }

  async function runFullScanForLaunch() {
    if (!installDir) return { success: false, errors: 1, failed: [{ name: 'install location', reason: 'no install directory is selected' }] };

    try {
      const files = await loadPatchFiles();
      if (!Array.isArray(files) || files.length === 0) {
        return {
          success: false,
          errors: 1,
          failed: [{ name: 'file manifest', reason: 'the file list could not be loaded from the server' }]
        };
      }

      // Pre-launch runs on the cached result: a file whose size and mtime are
      // unchanged since it was last verified against the same hash cannot have
      // changed, so there is no reason to re-read several gigabytes every time
      // the player presses Play.
      const outcome = await reconcile(files, {
        useCache: true,
        label: 'Pre-launch scan'
      });

      // Re-check using the main-process executable resolver. This supports
      // nested client layouts and all supported case variants.
      const diag = await ipcRenderer.invoke('check-installation', {
        version: gameVersion,
        dir: installDir
      });
      if (!diag.ok) {
        outcome.errors++;
        outcome.failed.push({
          name: diag.expected || 'client executable',
          reason: diag.message || diag.error || 'not found in the install directory'
        });
      }

      // Carry the offending file names and causes up to the Play button so the
      // error it shows says what is actually wrong.
      return { success: outcome.errors === 0, errors: outcome.errors, failed: outcome.failed };
    } catch (error) {
      console.error('Pre-launch full scan failed:', error);
      return {
        success: false,
        errors: 1,
        failed: [{ name: 'pre-launch scan', reason: describeIpcError(error) }]
      };
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

      // Quick: trust files unchanged since their last successful verification.
      // Full: re-read every file, so this is the genuine "recheck all".
      const outcome = await reconcile(files, {
        useCache: mode !== 'full',
        preserveExecutable: true,
        label: mode === 'full' ? 'Full scan' : 'Quick scan'
      });

      updateStatus(
        `Scan complete. Verified: ${outcome.verified}` +
        (outcome.cacheHits ? ` (${outcome.cacheHits} unchanged)` : '') +
        `, Downloaded: ${outcome.downloaded}, Errors: ${outcome.errors}`
      );

      if (outcome.errors) {
        updateStatus(`Scan finished with ${outcome.errors} error(s): ${summarizeFailedFiles(outcome.failed)}. ${verificationHint(outcome.failed)}`);
      }
    } catch (error) {
      updateStatus(`Scan error: ${error.message}`);
    } finally {
      isScanning = false;
      downloadSpeedElement.textContent = '';
    }
  }
  // Returns { ok, reason } so callers can report why a file could not be
  // fetched instead of only counting it.
  async function downloadFile(file, destination, enhancedGraphics = false) {
    updateStatus(`Downloading: ${file.name}`);

    try {
      const baseUrl = versionFileUrl(gameVersion);
      // Enhanced Graphics and client files both live in the shared /tre/ tree.
      const url = baseUrl + encodeManifestName(file.name);

      await ipcRenderer.invoke('download-file', {
        url,
        destination,
        expectedMd5: file.md5,
        size: file.size
      });

      updateStatus(`Downloaded: ${file.name}`);
      return { ok: true };
    } catch (error) {
      const reason = describeIpcError(error);
      updateStatus(`Download failed for ${file.name}: ${reason}`);
      return { ok: false, reason };
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
