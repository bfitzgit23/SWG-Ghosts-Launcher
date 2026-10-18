// download.js - SWG Ghosts Launcher
//
// The verify-before-replace downloader used by the main process.  It lives in
// its own module so the exact request/verify path can be exercised headlessly
// (scripts/download-selftest.js): the launcher's whole pre-launch verification
// depends on it, and a single entry it could not verify used to block every
// launch.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');

// The file host sits behind Cloudflare, which rewrites responses when the
// client does not advertise what it accepts: a request with no Accept header
// gets Cloudflare's analytics <script> injected into HTML, so /tre/patch-notes.html
// arrived 367 bytes longer than the file whose md5 is published in
// required-files.json.  The launcher then discarded the download and counted an
// error on every launch, forever.  Node's http client sends no Accept header of
// its own, so ask for */* explicitly - with it the response is byte-identical
// to the manifest (verified against the live host).
const HTTP_HEADERS = Object.freeze({
  Accept: '*/*',
  'User-Agent': 'GhostsLauncher'
});

// Socket-level failures come and go (the file host resets connections when it
// is busy) and are worth another attempt; a genuine 404 is not.
const TRANSIENT_ERRORS = Object.freeze([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'ERR_SOCKET_CONNECTION_TIMEOUT'
]);
const TRANSIENT_MESSAGES = /socket hang up|premature close|connection reset|temporarily unavailable|timeout|timed out/i;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const REDIRECT_LIMIT = 5;
const IDLE_TIMEOUT_MS = 30000;

/**
 * Percent-encode a manifest path one segment at a time.  http.get() runs the URL
 * through the WHATWG parser, which already escapes a space but would read a raw
 * '#' as the start of a fragment, so a name containing one could never be
 * fetched.  encodeURIComponent on each segment (not the separators) keeps the
 * directory structure intact.
 */
function encodeManifestPath(name) {
  return String(name == null ? '' : name)
    .replace(/\\/g, '/')
    .replace(/^[/\\]+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function isTransient(error) {
  if (!error) return false;
  if (error.code && TRANSIENT_ERRORS.indexOf(error.code) !== -1) return true;
  return TRANSIENT_MESSAGES.test(String(error.message || error));
}

function md5OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

/**
 * Download `url` to `destination`, verify it against `expectedMd5`, and only
 * then replace whatever is already there.
 *
 * Resolves with { path, md5 }; rejects with an Error whose message names the
 * cause ("HTTP 404", "MD5 mismatch: ...", "Download timeout ..."), because the
 * renderer reports that text to the player.
 */
function downloadFileFromUrl(options) {
  const opts = options || {};
  const url = opts.url;
  const destination = opts.destination;
  const expectedMd5 = opts.expectedMd5;
  const size = opts.size;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const log = typeof opts.log === 'function' ? opts.log : null;

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

    const downloadTo = (requestUrl, redirectCount, attempt) => {
      if (redirectCount > REDIRECT_LIMIT) {
        cleanupTemp();
        reject(new Error('Too many redirects'));
        return;
      }

      const client = requestUrl.startsWith('https://') ? https : http;
      const file = fs.createWriteStream(tempPath);
      let downloadedBytes = 0;
      let settled = false;

      // Retry the whole request from the original URL: a half-finished temp file
      // is useless, and a redirect chain is cheap to walk again.
      const retryOrFail = (error, message) => {
        if (settled) return;
        settled = true;
        try { file.close(); } catch (_) {}
        cleanupTemp();

        if (attempt < MAX_ATTEMPTS && isTransient(error)) {
          const delay = RETRY_BASE_DELAY_MS * attempt;
          if (log) {
            log(`Download attempt ${attempt}/${MAX_ATTEMPTS} for ${url} failed (${error && error.message}); retrying in ${delay} ms`);
          }
          setTimeout(() => downloadTo(url, 0, attempt + 1), delay);
          return;
        }

        reject(new Error(message || (error && error.message) || 'Download failed'));
      };

      if (log) log(`Downloading: ${requestUrl} to temporary file ${tempPath}`);

      const req = client.get(requestUrl, { headers: HTTP_HEADERS }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          settled = true;
          try { file.close(); } catch (_) {}
          cleanupTemp();
          response.resume();
          downloadTo(new URL(response.headers.location, requestUrl).toString(), redirectCount + 1, attempt);
          return;
        }

        if (response.statusCode !== 200) {
          // 5xx/429 are worth another attempt, 4xx are not.
          const transient = response.statusCode >= 500 || response.statusCode === 429;
          retryOrFail(
            transient ? Object.assign(new Error(`HTTP ${response.statusCode}`), { code: 'HTTP_' + response.statusCode }) : null,
            `HTTP ${response.statusCode}`
          );
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'], 10) || size || 0;

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          const percent = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
          if (onProgress) {
            onProgress({
              downloaded: downloadedBytes,
              total: totalBytes,
              percent,
              delta: chunk.length
            });
          }
        });

        // A connection dropped mid-body surfaces as an error on either stream.
        response.on('error', (error) => retryOrFail(error));
        response.pipe(file);

        file.on('finish', () => {
          if (settled) return;
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

          md5OfFile(tempPath).then((downloadedMd5) => {
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
          }).catch((error) => {
            cleanupTemp();
            reject(error);
          });
        });
      });

      req.on('error', (error) => {
        if (log) log(`Download error for ${requestUrl}: ${error.message}`);
        retryOrFail(error);
      });

      req.setTimeout(IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Download timeout after ${Math.round(IDLE_TIMEOUT_MS / 1000)} seconds. Existing file was preserved.`));
      });
    };

    downloadTo(url, 0, 1);
  });
}

module.exports = { downloadFileFromUrl, encodeManifestPath, HTTP_HEADERS };
