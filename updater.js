'use strict';

// updater.js — Ghosts Launcher auto-update orchestration.
//
// This file exists for two reasons:
//
// 1. Where updates come from. The launcher pulls from our own site first
//    (https://swg-ghosts.online/launcher — the generic electron-updater feed the
//    release script writes), and falls back to the GitHub release for the same
//    version when the site is unreachable or the artefact will not come down.
//
// 2. Updates must never hang. electron-updater has no download timeout, and its
//    *differential* downloader (which plans a long sequence of small HTTP range
//    requests against the previous release's block map) can stall forever with
//    no progress and no error: the launcher "tries to download" and nothing ever
//    finishes. So we (a) never use the differential path, (b) put a stall
//    watchdog on every download and a timeout on every feed check, and (c) move
//    on to the next feed when an attempt stalls or errors, leaving the failure
//    visible in the log and the UI instead of silent.
//
// Deliberately free of Electron imports so scripts/updater-selftest.js can drive
// this exact code with a fake autoUpdater.

const fs = require('fs');
const path = require('path');

const SITE_URL = 'https://swg-ghosts.online/launcher';
const GITHUB_REPO = 'bfitzgit23/SWG-Ghosts-Launcher';

// Tunables (ms). A stalled download is one that has reported no progress *at all*
// for this long; a check is abandoned if the feed does not answer in time.
//
// 60s is chosen against measured reality: the site sits behind Cloudflare and the
// same 85 MB installer has been clocked from 162 KB/s to 6.4 MB/s, so a slow but
// moving download must never be cancelled (it keeps reporting progress, however
// little, and nothing here looks at throughput). A whole minute of silence means
// the connection is dead, and then the other feed gets a turn.
const DEFAULT_STALL_MS = 60000;
const DEFAULT_CHECK_TIMEOUT_MS = 45000;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-check every 6 hours
const DEFAULT_FIRST_CHECK_DELAY_MS = 3000;

function buildFeeds(env = process.env) {
  const githubRepo = env.GHOSTS_FEED_GITHUB_REPO || GITHUB_REPO;
  const [owner, repo] = githubRepo.split('/');
  return [
    {
      name: 'site',
      label: 'swg-ghosts.online',
      config: {
        provider: 'generic',
        url: env.GHOSTS_FEED_SITE_URL || SITE_URL,
        channel: 'latest',
      },
    },
    {
      name: 'github',
      label: `github.com/${githubRepo}`,
      config: { provider: 'github', owner, repo },
    },
  ];
}

function describeError(error) {
  if (error == null) return 'unknown error';
  if (typeof error === 'string') return error;
  const code = error.code ? `${error.code}: ` : '';
  return `${code}${error.message || String(error)}`;
}

// Minimal stand-in for builder-util-runtime's CancellationToken, used only if
// the updater does not hand us a real one (it does whenever an update is found).
function fallbackCancellationToken() {
  const listeners = [];
  return {
    isCancellationRequested: false,
    onCancelRequested(cb) {
      listeners.push(cb);
      return { dispose() {} };
    },
    cancel() {
      this.isCancellationRequested = true;
      listeners.forEach((cb) => {
        try { cb(); } catch (_) {}
      });
    },
  };
}

function withTimeout(promise, ms, label) {
  if (!(ms > 0)) return promise;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    // Deliberately referenced: an unref'd timer can let an otherwise-idle process
    // exit while this race is still pending, which would turn a timeout into a
    // silent hang. It is always cleared once the race settles.
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// electron-updater >= 6 exposes disableDifferentialDownload; 5.3.x only has the
// private switch. Either way the differential path is what stalled us, so we
// force the plain full-file download.
function forceFullDownloads(autoUpdater, log) {
  if (typeof autoUpdater.disableDifferentialDownload === 'boolean') {
    autoUpdater.disableDifferentialDownload = true;
    return 'disableDifferentialDownload';
  }
  autoUpdater._testOnlyOptions = { platform: process.platform, isUseDifferentialDownload: false };
  return 'legacy testOnlyOptions flag';
}

// Drop partial downloads left by a failed attempt: electron-updater resumes them,
// and resuming a truncated file from a feed that just stalled is not worth the
// risk of a corrupted artefact later.
function clearStalePartials(autoUpdater, log) {
  let dir = null;
  try {
    const helper = autoUpdater.downloadedUpdateHelper;
    if (helper && typeof helper.cacheDirForPendingUpdate === 'string') {
      dir = helper.cacheDirForPendingUpdate;
    } else if (helper && typeof helper.cacheDir === 'string') {
      dir = path.join(helper.cacheDir, 'pending');
    }
  } catch (_) {}
  if (!dir) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith('temp-')) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      log(`[updater] removed partial download ${name}`);
    } catch (_) {}
  }
}

function createUpdaterController(options) {
  const autoUpdater = options.autoUpdater;
  if (!autoUpdater) throw new Error('createUpdaterController requires an autoUpdater');

  const feeds = options.feeds || buildFeeds();
  const log = options.log || (() => {});
  const onState = options.onState || (() => {});
  const stallMs = options.stallMs > 0 ? options.stallMs : DEFAULT_STALL_MS;
  const checkTimeoutMs = options.checkTimeoutMs > 0 ? options.checkTimeoutMs : DEFAULT_CHECK_TIMEOUT_MS;
  const checkIntervalMs = options.checkIntervalMs > 0 ? options.checkIntervalMs : DEFAULT_CHECK_INTERVAL_MS;
  const firstCheckDelayMs = options.firstCheckDelayMs >= 0 ? options.firstCheckDelayMs : DEFAULT_FIRST_CHECK_DELAY_MS;
  const installEnabled = options.noInstall !== true;

  let state = {
    phase: 'idle', // idle | checking | downloading | ready | current | error
    feed: null,
    feedLabel: null,
    version: null,
    percent: 0,
    transferred: 0,
    total: 0,
    error: null,
    checkedAt: null,
    downloadedAt: null,
    source: null,
  };
  let initialised = false;
  let running = null;
  let currentAttempt = null;
  let intervalTimer = null;

  function setState(patch) {
    const previous = state;
    state = Object.assign({}, state, patch);
    try {
      onState(state, previous);
    } catch (_) {}
    return state;
  }

  function init() {
    if (initialised) return;
    initialised = true;
    const lever = forceFullDownloads(autoUpdater, log);
    log(`[updater] full (non-differential) downloads enforced via ${lever}`);
    // autoInstallOnAppQuit keeps a verified update installable on exit even if the
    // player never presses the restart button; autoDownload stays off because we
    // drive the download ourselves so it can be watched and cancelled.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = installEnabled;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('update-available', (info) => {
      if (currentAttempt) currentAttempt.available = info || {};
    });
    autoUpdater.on('download-progress', (progress) => {
      if (currentAttempt) currentAttempt.lastProgressAt = Date.now();
      setState({
        percent: progress && progress.percent ? progress.percent : 0,
        transferred: progress && progress.transferred ? progress.transferred : 0,
        total: progress && progress.total ? progress.total : 0,
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      if (currentAttempt) currentAttempt.downloaded = info || {};
    });
    // This listener must always be attached (not only mid-attempt): install and
    // install-on-quit failures are dispatched as 'error' after the check has
    // finished, when currentAttempt is already null. Without this they vanish
    // except for electron-updater's own console line — the user is never told
    // why the update didn't install.
    autoUpdater.on('error', (error) => {
      const message = describeError(error);
      if (currentAttempt && !currentAttempt.error) currentAttempt.error = message;
      log(`[updater] error: ${message}`);
      // Surface failures that happen once an update is staged (e.g. the
      // installer failing to spawn). The UI maps a changed error in 'ready'
      // phase to a visible message.
      if (state.phase === 'ready') setState({ error: message });
    });
  }

  function applyFeed(feed) {
    // setFeedURL replaces the provider built from app-update.yml, so one installed
    // launcher can try the site and then GitHub without a reinstall.
    autoUpdater.setFeedURL(feed.config);
  }

  async function downloadWithWatchdog(attempt, feed) {
    const token = attempt.cancellationToken || fallbackCancellationToken();
    attempt.lastProgressAt = Date.now();
    let stalled = false;
    const watchEveryMs = Math.max(1000, Math.min(5000, Math.round(stallMs / 4)));
    const watchdog = setInterval(() => {
      if (attempt.downloaded) return;
      const idle = Date.now() - (attempt.lastProgressAt || attempt.startedAt);
      if (idle < stallMs) return;
      stalled = true;
      log(`[updater] ${feed.label}: no download progress for ${Math.round(idle / 1000)}s — cancelling this attempt`);
      try {
        token.cancel();
      } catch (_) {}
    }, watchEveryMs);
    if (watchdog.unref) watchdog.unref();

    try {
      await withTimeout(
        autoUpdater.downloadUpdate(token),
        20 * 60 * 1000,
        `Downloading from ${feed.label}`
      );
      if (!attempt.downloaded) {
        throw new Error('download finished without a verified update');
      }
      return attempt.downloaded;
    } catch (error) {
      if (stalled) {
        const stallError = new Error(`download stalled (no progress for ${Math.round(stallMs / 1000)}s)`);
        stallError.code = 'ERR_UPDATER_STALLED';
        throw stallError;
      }
      throw error;
    } finally {
      clearInterval(watchdog);
    }
  }

  async function runCheck(reason) {
    if (running) return running;
    running = doRunCheck(reason || 'auto').finally(() => {
      running = null;
    });
    return running;
  }

  async function doRunCheck(reason) {
    init();
    const attempts = [];
    setState({
      phase: 'checking',
      error: null,
      version: null,
      percent: 0,
      transferred: 0,
      total: 0,
      checkedAt: Date.now(),
      source: null,
      attempts: [],
    });

    for (const feed of feeds) {
      const attempt = { feed: feed.name, label: feed.label, startedAt: Date.now() };
      attempts.push(attempt);
      currentAttempt = attempt;
      setState({ feed: feed.name, feedLabel: feed.label, attempts });
      log(`[updater] (${reason}) checking ${feed.label}`);

      try {
        applyFeed(feed);

        const result = await withTimeout(
          autoUpdater.checkForUpdates(),
          checkTimeoutMs,
          `Checking ${feed.label}`
        );

        if (!attempt.available) {
          const latest = result && result.updateInfo ? result.updateInfo.version : 'unknown';
          log(`[updater] ${feed.label}: launcher is up to date (feed version ${latest})`);
          attempt.upToDate = true;
          setState({ attempts, phase: 'current', percent: 0, error: null });
          return state;
        }

        const version = attempt.available.version || (result && result.updateInfo && result.updateInfo.version) || 'unknown';
        attempt.cancellationToken = result && result.cancellationToken;
        log(`[updater] ${feed.label}: version ${version} available — downloading (full file)`);
        setState({ attempts, phase: 'downloading', version, percent: 0, source: feed.name });

        attempt.downloading = true;
        const downloaded = await downloadWithWatchdog(attempt, feed);
        const file = downloaded && downloaded.downloadedFile ? downloaded.downloadedFile : 'verified download';
        log(`[updater] ${feed.label}: version ${version} downloaded and checksum-verified (${file})`);
        setState({
          attempts,
          phase: 'ready',
          version,
          percent: 100,
          error: null,
          downloadedAt: Date.now(),
          source: feed.name,
        });
        return state;
      } catch (error) {
        attempt.error = describeError(error);
        attempt.failedAt = Date.now();
        log(`[updater] ${feed.label} failed: ${attempt.error}`);
        // Only clear partials if this attempt got as far as downloading: a failed
        // *check* leaves nothing behind, and the cache's installer.exe (used by
        // the next differential attempt) must survive untouched either way.
        if (attempt.downloading) clearStalePartials(autoUpdater, log);
        setState({ attempts, error: attempt.error });
        attempt.cancellationToken = null;
        // fall through to the next feed
      } finally {
        currentAttempt = null;
      }
    }

    const last = attempts[attempts.length - 1];
    const message = last && last.error ? last.error : 'no update feed answered';
    log(`[updater] every feed failed; last error: ${message}`);
    setState({ phase: 'error', error: message, attempts });
    return state;
  }

  function scheduleAutoChecks() {
    setTimeout(() => {
      runCheck('startup').catch((error) => log(`[updater] startup check failed: ${describeError(error)}`));
    }, firstCheckDelayMs);
    if (checkIntervalMs > 0) {
      if (intervalTimer) clearInterval(intervalTimer);
      intervalTimer = setInterval(() => {
        runCheck('periodic').catch((error) => log(`[updater] periodic check failed: ${describeError(error)}`));
      }, checkIntervalMs);
      if (intervalTimer.unref) intervalTimer.unref();
    }
  }

  function installNow() {
    if (!installEnabled) {
      log('[updater] install suppressed (updates disabled in this build)');
      return false;
    }
    if (state.phase !== 'ready') {
      log(`[updater] install requested but no verified update is ready (phase ${state.phase})`);
      return false;
    }
    log(`[updater] installing ${state.version} silently and restarting the launcher`);
    // Silent install (no NSIS wizard) and relaunch afterwards.
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  function getState() {
    return state;
  }

  function dispose() {
    if (intervalTimer) clearInterval(intervalTimer);
    intervalTimer = null;
  }

  return { init, runCheck, scheduleAutoChecks, installNow, getState, dispose };
}

module.exports = {
  buildFeeds,
  createUpdaterController,
  forceFullDownloads,
  clearStalePartials,
  describeError,
  DEFAULT_STALL_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_CHECK_INTERVAL_MS,
  SITE_URL,
  GITHUB_REPO,
};
