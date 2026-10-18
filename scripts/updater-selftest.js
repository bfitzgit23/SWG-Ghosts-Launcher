#!/usr/bin/env node
'use strict';

// scripts/updater-selftest.js
//
// Drives updater.js (the exact module main.js uses) against a fake autoUpdater to
// prove the behaviour we cannot easily provoke against the live feeds:
//   * the site feed is tried first and GitHub only when the site fails,
//   * a stalled download is cancelled and the fallback feed takes over (this is
//     the "tries to download and just sits there" bug),
//   * both feeds failing ends in a visible error instead of hanging,
//   * partial downloads are cleaned up but the differential baseline is kept,
//   * install is suppressed in test mode and calls quitAndInstall otherwise.
//
// Run: npm run test:updater

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  createUpdaterController,
  forceFullDownloads,
  DEFAULT_STALL_MS,
} = require('../updater');

const FEEDS = [
  { name: 'site', label: 'swg-ghosts.online', config: { provider: 'generic', url: 'https://example.invalid/launcher' } },
  { name: 'github', label: 'github.com/example/repo', config: { provider: 'github', owner: 'example', repo: 'repo' } },
];

function fakeToken() {
  const listeners = [];
  return {
    isCancellationRequested: false,
    onCancelRequested(cb) {
      listeners.push(cb);
      return { dispose() {} };
    },
    cancel() {
      this.isCancellationRequested = true;
      listeners.forEach((cb) => cb());
    },
  };
}

class FakeUpdater extends EventEmitter {
  constructor(script) {
    super();
    this.script = script || {};
    this.autoDownload = true;
    this.autoInstallOnAppQuit = true;
    this.allowDowngrade = true;
    this.feeds = [];
    this.installs = [];
    this.downloads = 0;
    this.downloadedUpdateHelper = this.script.downloadedUpdateHelper || null;
  }

  setFeedURL(config) {
    this.feed = config;
    this.feeds.push(`${config.owner ? 'github' : 'generic'}:${config.url || `${config.owner}/${config.repo}`}`);
  }

  checkForUpdates() {
    return this.script.check(this);
  }

  downloadUpdate(token) {
    this.downloads += 1;
    const cancelToken = token || fakeToken();
    return this.script.download(this, cancelToken);
  }

  quitAndInstall(silent, force) {
    this.installs.push([silent, force]);
  }
}

// --- fake feed behaviours ----------------------------------------------------

// Up to date: the check answers, no update-available event.
function upToDate() {
  return () => Promise.resolve({ updateInfo: { version: '1.0.0' } });
}

// Never answers, like a feed that accepts the connection and goes quiet.
function hangs() {
  return () => new Promise(() => {});
}

function rejects(message) {
  return () => Promise.reject(new Error(message));
}

// Offers an update; the download reports progress then finishes, emitting
// update-downloaded exactly like electron-updater does before resolving.
function offers(version) {
  return (updater) => {
    const token = fakeToken();
    updater.emit('update-available', { version });
    return Promise.resolve({ updateInfo: { version }, cancellationToken: token });
  };
}

function downloads(version, { progressMs = 15, stallAfter = null, failAfter = null } = {}) {
  return (updater, token) =>
    new Promise((resolve, reject) => {
      let ticks = 0;
      let finished = false;
      if (token && typeof token.onCancelRequested === 'function') {
        token.onCancelRequested(() => {
          if (finished) return;
          finished = true;
          clearInterval(timer);
          const error = new Error('cancelled');
          error.name = 'CancellationError';
          reject(error);
        });
      }
      const timer = setInterval(() => {
        ticks += 1;
        if (stallAfter != null && ticks > stallAfter) return; // goes quiet, like the real stall
        updater.emit('download-progress', {
          percent: Math.min(100, ticks * 10),
          transferred: ticks * 1000,
          total: 10000,
        });
        if (failAfter != null && ticks >= failAfter) {
          finished = true;
          clearInterval(timer);
          reject(new Error('ECONNRESET'));
          return;
        }
        if (ticks >= 3) {
          finished = true;
          clearInterval(timer);
          updater.emit('update-downloaded', { version, downloadedFile: `/tmp/${version}.exe` });
          resolve([`/tmp/${version}.exe`]);
        }
      }, progressMs);
    });
}

function makeController(script, options = {}) {
  const autoUpdater = new FakeUpdater(script);
  const controller = createUpdaterController(Object.assign({
    autoUpdater,
    feeds: FEEDS,
    stallMs: 120,
    checkTimeoutMs: 150,
    firstCheckDelayMs: 0,
    checkIntervalMs: 0,
    log: () => {},
  }, options));
  return { autoUpdater, controller };
}

const passed = [];
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed.push(name);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

async function main() {
  // 1. Full-download enforcement (the differential path is what stalled).
  await test('differential downloads are disabled', async () => {
    const forge = {};
    const lever = forceFullDownloads(forge, () => {});
    assert.strictEqual(lever, 'legacy testOnlyOptions flag');
    assert.deepStrictEqual(forge._testOnlyOptions.isUseDifferentialDownload, false);

    const modern = { disableDifferentialDownload: false };
    assert.strictEqual(forceFullDownloads(modern, () => {}), 'disableDifferentialDownload');
    assert.strictEqual(modern.disableDifferentialDownload, true);
  });

  // 2. Site first, and a current site feed ends the search.
  await test('site up to date: one attempt, no fallback', async () => {
    const { autoUpdater, controller } = makeController({ check: upToDate(), download: downloads('1.0.0') });
    const state = await controller.runCheck('test');
    assert.strictEqual(state.phase, 'current');
    assert.strictEqual(state.attempts.length, 1);
    assert.strictEqual(autoUpdater.feeds.length, 1);
    assert.ok(autoUpdater.feeds[0].startsWith('generic:'));
    assert.strictEqual(autoUpdater.autoDownload, false, 'autoDownload must be off so the download can be watched');
  });

  // 3. Site silently hangs -> check timeout -> GitHub serves the update.
  await test('site check hangs: falls back to GitHub and completes', async () => {
    const { autoUpdater, controller } = makeController({
      check: (updater) => (updater.feed.owner ? offers('9.9.9')(updater) : hangs()(updater)),
      download: downloads('9.9.9'),
      checkTimeoutMs: 150,
    });
    const started = Date.now();
    const state = await controller.runCheck('test');
    const elapsed = Date.now() - started;
    assert.strictEqual(state.phase, 'ready');
    assert.strictEqual(state.version, '9.9.9');
    assert.strictEqual(state.source, 'github');
    assert.strictEqual(state.attempts.length, 2);
    assert.ok(/timed out/i.test(state.attempts[0].error), `site attempt error was: ${state.attempts[0].error}`);
    assert.ok(elapsed < 3000, `fallback took ${elapsed}ms`);
    assert.deepStrictEqual(autoUpdater.feeds.map((f) => f.split(':')[0]), ['generic', 'github']);
  });

  // 4. Site offers an update but the download goes quiet -> watchdog cancels it
  //    and GitHub takes over. This is the regression the launcher hit in the wild.
  await test('stalled download is cancelled and the fallback feed takes over', async () => {
    const { autoUpdater, controller } = makeController({
      check: (updater) => offers('9.9.9')(updater),
      download: (updater, token) =>
        updater.feed.owner ? downloads('9.9.9')(updater, token) : downloads('9.9.9', { stallAfter: 1 })(updater, token),
    });
    const started = Date.now();
    const state = await controller.runCheck('test');
    const elapsed = Date.now() - started;
    assert.strictEqual(state.phase, 'ready', `phase ${state.phase} error ${state.error}`);
    assert.strictEqual(state.source, 'github');
    assert.strictEqual(autoUpdater.downloads, 2, 'both feeds should have been downloaded from');
    assert.ok(/stalled/i.test(state.attempts[0].error), `site attempt error was: ${state.attempts[0].error}`);
    assert.ok(elapsed < 3000, `stall recovery took ${elapsed}ms`);
  });

  // 5. Everything down -> visible error, quickly, instead of an endless wait.
  await test('both feeds failing ends in an error state', async () => {
    const { controller } = makeController({
      check: rejects('getaddrinfo ENOTFOUND swg-ghosts.online'),
      download: downloads('9.9.9'),
    });
    const started = Date.now();
    const state = await controller.runCheck('test');
    const elapsed = Date.now() - started;
    assert.strictEqual(state.phase, 'error');
    assert.ok(/ENOTFOUND/.test(state.error), `error was: ${state.error}`);
    assert.strictEqual(state.attempts.length, 2);
    assert.ok(elapsed < 2000, `error path took ${elapsed}ms`);
  });

  // 6. A download that dies mid-way cleans its partial but keeps the cached
  //    installer that later differential attempts would use as a baseline; a
  //    failed *check* must not touch the cache at all.
  await test('failed download removes temp partials only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghosts-updater-'));
    fs.writeFileSync(path.join(dir, 'temp-Ghosts Launcher Setup 9.9.9.exe'), 'partial');
    fs.writeFileSync(path.join(dir, 'installer.exe'), 'baseline');
    fs.writeFileSync(path.join(dir, 'update-info.json'), '{}');
    const { controller } = makeController({
      check: offers('9.9.9'),
      download: (updater, token) => downloads('9.9.9', { failAfter: 2 })(updater, token),
      downloadedUpdateHelper: { cacheDirForPendingUpdate: dir },
    });
    const state = await controller.runCheck('test');
    assert.strictEqual(state.phase, 'error');
    assert.ok(/ECONNRESET/.test(state.error), `error was: ${state.error}`);
    assert.ok(!fs.existsSync(path.join(dir, 'temp-Ghosts Launcher Setup 9.9.9.exe')), 'partial not removed');
    assert.ok(fs.existsSync(path.join(dir, 'installer.exe')), 'baseline installer was removed');
    assert.ok(fs.existsSync(path.join(dir, 'update-info.json')), 'update-info.json was removed');

    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ghosts-updater-'));
    fs.writeFileSync(path.join(second, 'temp-partial.exe'), 'partial');
    const checkOnly = makeController({
      check: rejects('feed down'),
      download: downloads('9.9.9'),
      downloadedUpdateHelper: { cacheDirForPendingUpdate: second },
    });
    await checkOnly.controller.runCheck('test');
    assert.ok(fs.existsSync(path.join(second, 'temp-partial.exe')), 'a failed check must not clear the cache');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });

  // 7. Install is suppressed when asked, silent+relaunch otherwise.
  await test('installNow respects suppression and is silent with relaunch', async () => {
    const suppressed = makeController({ check: upToDate(), download: downloads('1.0.0') }, { noInstall: true });
    await suppressed.controller.runCheck('test');
    assert.strictEqual(suppressed.controller.installNow(), false);
    assert.strictEqual(suppressed.autoUpdater.installs.length, 0);
    assert.strictEqual(suppressed.autoUpdater.autoInstallOnAppQuit, false);

    const normal = makeController({
      check: offers('9.9.9'),
      download: downloads('9.9.9'),
    });
    const state = await normal.controller.runCheck('test');
    assert.strictEqual(state.phase, 'ready');
    assert.strictEqual(normal.controller.installNow(), true);
    assert.deepStrictEqual(normal.autoUpdater.installs, [[true, true]]);
    assert.strictEqual(normal.autoUpdater.autoInstallOnAppQuit, true);
  });

  // 8. A run that is already in flight is not restarted by a second caller.
  await test('concurrent checks are coalesced', async () => {
    const { controller } = makeController({ check: upToDate(), download: downloads('1.0.0') });
    const [a, b] = await Promise.all([controller.runCheck('test'), controller.runCheck('test')]);
    assert.strictEqual(a.phase, 'current');
    assert.strictEqual(b.phase, 'current');
  });

  assert.strictEqual(DEFAULT_STALL_MS, 60000);

  console.log(`updater selftest: ${passed.length} passed, ${failures.length} failed`);
  for (const name of passed) console.log(`  PASS ${name}`);
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`selftest crashed: ${error.stack || error}`);
  process.exit(1);
});
