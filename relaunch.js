'use strict';

// relaunch.js — arms scripts/relaunch-helper.js right before the launcher quits to
// install an update. The helper waits for this process to exit, waits for the
// installer to finish, and starts the launcher again, so the player is not left
// staring at a closed window after an update.
//
// Electron runs itself as plain Node for the helper (ELECTRON_RUN_AS_NODE=1), so a
// packaged launcher needs no separate node.exe next to it.

const { spawn } = require('child_process');
const path = require('path');

function startRelaunchWatcher(options) {
  const { execPath, appExe, installerPath, logPath, log } = options || {};

  if (process.platform !== 'win32') return false;
  if (!execPath || !appExe || !installerPath) return false;

  try {
    const helper = path.join(__dirname, 'scripts', 'relaunch-helper.js');
    const child = spawn(
      execPath,
      [helper, String(process.pid), installerPath, appExe, logPath],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      }
    );
    child.unref();
    if (log) log(`[updater] relaunch watchdog armed for pid ${process.pid}`);
    return true;
  } catch (error) {
    if (log) log(`[updater] could not arm the relaunch watchdog: ${error.message}`);
    return false;
  }
}

module.exports = { startRelaunchWatcher };
