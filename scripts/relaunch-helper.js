#!/usr/bin/env node
'use strict';

// scripts/relaunch-helper.js
//
// Brings the launcher back after an update. electron-updater hands the downloaded
// installer to Windows and quits the app; whether the NSIS installer starts the app
// again afterwards depends on installer flags and install mode, and in the field the
// launcher simply stayed closed. So main.js arms this watcher before quitting:
//
//   node relaunch-helper.js <parentPid> <installerPath> <appExe> <logPath>
//
// It waits for the launcher to exit, waits for the installer to finish, then starts
// the launcher again. main.js holds a single-instance lock, so if Windows' own
// installer relaunch fires too, only one window survives.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [parentPid, installerPath, appExe, logPath] = process.argv.slice(2);

const PARENT_TIMEOUT_MS = 120000; // launcher is normally gone in a second
const INSTALL_TIMEOUT_MS = 4 * 60 * 1000; // a silent install takes well under two
const INSTALLER_GRACE_MS = 20000; // time allowed for the installer to appear
const QUIET_MS = 3000; // installer must be gone this long before we launch
const NO_INSTALLER_QUIET_MS = 12000; // no installer ever seen: still relaunch
const POLL_MS = 1000;

function log(message) {
  const line = `[${new Date().toISOString()}] relaunch: ${message}\n`;
  try {
    fs.appendFileSync(logPath, line);
  } catch (_) {}
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// tasklist is used instead of process.kill because it also tells us about the
// installer, which is not our child.
function tasklist(filter) {
  const result = spawnSync('tasklist', ['/FI', filter, '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return `${(result && result.stdout) || ''}${(result && result.stderr) || ''}`;
}

function processRunning(pid) {
  if (!pid) return false;
  return tasklist(`PID eq ${pid}`).includes(String(pid));
}

function imageRunning(exePath) {
  const name = path.basename(exePath || '');
  if (!name) return false;
  const output = tasklist(`IMAGENAME eq ${name}`);
  // tasklist answers "INFO: No tasks are running which match the specified criteria."
  if (/No tasks are running/i.test(output)) return false;
  return new RegExp(escapeForRegExp(name), 'i').test(output);
}

// Windows locks the executable while the installer replaces it, so "can I open it
// for writing" is a reliable signal that the copy step is over.
function fileWritable(file) {
  try {
    const handle = fs.openSync(file, 'r+');
    fs.closeSync(handle);
    return true;
  } catch (_) {
    return false;
  }
}

// spawn() reports failures asynchronously ('error'), so the attempt is retried from
// that event rather than from a try/catch around the call.
function launch(attempt) {
  const tries = attempt || 1;

  return new Promise((resolve) => {
    let settled = false;
    let child;

    try {
      child = spawn(appExe, [], { detached: true, stdio: 'ignore' });
    } catch (error) {
      log(`attempt ${tries} to start the launcher failed: ${error.message}`);
      if (tries >= 4) {
        log('could not start the launcher again; the player will need to open it manually');
        resolve(false);
        return;
      }
      setTimeout(() => resolve(launch(tries + 1)), 4000);
      return;
    }

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      log(`attempt ${tries} to start the launcher failed: ${error.message}`);
      if (tries >= 4) {
        log('could not start the launcher again; the player will need to open it manually');
        resolve(false);
        return;
      }
      setTimeout(() => resolve(launch(tries + 1)), 4000);
    });

    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      log(`started the launcher again (attempt ${tries}, pid ${child.pid})`);
      resolve(true);
    });
  });
}

function main() {
  if (!parentPid || !appExe) {
    log(`missing arguments (parentPid=${parentPid}, appExe=${appExe})`);
    return;
  }

  log(`waiting for launcher pid ${parentPid} to exit`);

  const parentDeadline = Date.now() + PARENT_TIMEOUT_MS;
  while (processRunning(parentPid) && Date.now() < parentDeadline) sleep(500);

  if (processRunning(parentPid)) {
    log('launcher did not exit in time; leaving the relaunch alone');
    return;
  }

  log('launcher exited; waiting for the installer to finish');

  const startedAt = Date.now();
  const deadline = startedAt + INSTALL_TIMEOUT_MS;
  let sawInstaller = false;
  let quietSince = 0;

  while (Date.now() < deadline) {
    // If Windows' installer relaunch already brought the launcher back, we are done.
    if (imageRunning(appExe)) {
      log('launcher is already running again');
      return;
    }

    const installerBusy = installerPath ? imageRunning(installerPath) : false;

    if (installerBusy) {
      if (!sawInstaller) log(`installer running: ${path.basename(installerPath)}`);
      sawInstaller = true;
      quietSince = 0;
      sleep(POLL_MS);
      continue;
    }

    // Give the installer time to appear before deciding it never will.
    if (!sawInstaller && Date.now() - startedAt < INSTALLER_GRACE_MS) {
      sleep(POLL_MS);
      continue;
    }

    // Nothing is installing and there is no executable to start: stop waiting for
    // an installer that is never coming and try anyway (the attempt is logged).
    if (!sawInstaller && !fs.existsSync(appExe) && Date.now() - startedAt > 60000) {
      log('launcher executable is missing and no installer is running; trying to start it anyway');
      launch();
      return;
    }

    if (!quietSince) quietSince = Date.now();
    const quietFor = Date.now() - quietSince;

    if (fileWritable(appExe)) {
      if (quietFor >= (sawInstaller ? QUIET_MS : NO_INSTALLER_QUIET_MS)) {
        log(`install finished (${sawInstaller ? 'installer closed' : 'no installer seen'}); starting the launcher`);
        launch();
        return;
      }
    } else {
      quietSince = 0; // still being replaced
    }

    sleep(POLL_MS);
  }

  log('gave up waiting for the installer; starting the launcher anyway');
  launch();
}

main();
