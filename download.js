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

// Segmented transfers.  Both clients are mostly multi-hundred-megabyte TREs and
// the file host throttles each connection (single-stream ranged requests
// measured at 1.2-4.5 MB/s against 15-17 MB/s over 8 ranges), so files above
// this size are fetched as several byte ranges at once and written positionally
// into one temp file.  The result is still verified and swapped in exactly like
// a streamed download.
const SEGMENTED_MIN_BYTES = 8 * 1024 * 1024;
const SEGMENT_TARGET_BYTES = 8 * 1024 * 1024;
const SEGMENTED_MAX_CONNECTIONS = 8;
const SEGMENT_MAX_ATTEMPTS = 3;

function makeSegments(totalBytes) {
  const segments = [];
  for (let start = 0; start < totalBytes; start += SEGMENT_TARGET_BYTES) {
    segments.push({ start, end: Math.min(totalBytes - 1, start + SEGMENT_TARGET_BYTES - 1) });
  }
  return segments;
}

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
 * Ask the host whether it serves byte ranges.  A one-byte request is enough:
 * a 206 with `Content-Range: bytes 0-0/<total>` both proves range support and
 * reports the exact file length the segments have to cover.
 */
function probeRangeSupport(url, size) {
  return new Promise((resolve, reject) => {
    const request = (requestUrl, redirectCount) => {
      if (redirectCount > REDIRECT_LIMIT) {
        reject(new Error('Too many redirects'));
        return;
      }

      const client = requestUrl.startsWith('https://') ? https : http;
      const req = client.get(requestUrl, {
        headers: Object.assign({}, HTTP_HEADERS, { Range: 'bytes=0-0' })
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          request(new URL(response.headers.location, requestUrl).toString(), redirectCount + 1);
          return;
        }

        if (response.statusCode === 206) {
          const match = /^bytes\s+0-0\/(\d+)/i.exec(String(response.headers['content-range'] || ''));
          const total = match ? Number(match[1]) : 0;
          response.resume();
          resolve({
            supported: true,
            total: total || (Number(size) > 0 ? Number(size) : 0)
          });
          return;
        }

        if (response.statusCode === 200) {
          response.resume();
          resolve({ supported: false, total: Number(size) > 0 ? Number(size) : 0 });
          return;
        }

        response.resume();
        const error = new Error(`HTTP ${response.statusCode}`);
        error.code = 'HTTP_' + response.statusCode;
        reject(error);
      });

      req.on('error', reject);
      req.setTimeout(IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Download timeout after ${Math.round(IDLE_TIMEOUT_MS / 1000)} seconds.`));
      });
    };

    request(url, 0);
  });
}

/**
 * Fetch one byte range and write it at its offset in `tempPath`.
 * Retries transient failures for that segment only, so a reset at 1.5 GB does
 * not throw away the rest of the transfer.
 */
function downloadSegmentRange({ url, tempPath, start, end, onBytes }) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let finished = false;

    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      fn(value);
    };

    const retry = (error) => {
      if (finished) return false;
      if (attempts >= SEGMENT_MAX_ATTEMPTS || !isTransient(error)) return false;
      attempts += 1;
      setTimeout(() => run(url, 0), RETRY_BASE_DELAY_MS * attempts);
      return true;
    };

    const run = (requestUrl, redirectCount) => {
      if (finished) return;
      if (redirectCount > REDIRECT_LIMIT) {
        finish(reject, new Error('Too many redirects'));
        return;
      }

      // One attempt: the guards below are per attempt, so the socket error
      // raised by tearing this attempt down cannot schedule a second retry.
      let attemptDone = false;
      let reported = 0;
      let out = null;

      const fail = (error) => {
        if (attemptDone || finished) return;
        attemptDone = true;
        if (out) { try { out.destroy(); } catch (_) {} }
        if (reported) {
          onBytes(-reported);
          reported = 0;
        }
        if (!retry(error)) finish(reject, error);
      };

      const client = requestUrl.startsWith('https://') ? https : http;
      const req = client.get(requestUrl, {
        headers: Object.assign({}, HTTP_HEADERS, { Range: `bytes=${start}-${end}` })
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          attemptDone = true;
          run(new URL(response.headers.location, requestUrl).toString(), redirectCount + 1);
          return;
        }

        if (response.statusCode === 200) {
          // The host ignored Range and is about to send the whole file.
          response.resume();
          finish(reject, Object.assign(
            new Error('File host ignored the range request'),
            { code: 'RANGE_UNSUPPORTED' }
          ));
          return;
        }

        if (response.statusCode !== 206) {
          response.resume();
          attemptDone = true;
          const error = new Error(`HTTP ${response.statusCode}`);
          error.code = 'HTTP_' + response.statusCode;
          if (response.statusCode >= 500 || response.statusCode === 429) {
            if (retry(error)) return;
          }
          finish(reject, error);
          return;
        }

        const match = /^bytes\s+(\d+)-(\d+)\//i.exec(String(response.headers['content-range'] || ''));
        if (match && Number(match[1]) !== start) {
          response.resume();
          finish(reject, new Error(`File host returned bytes ${match[1]}-${match[2]} for the requested range ${start}-${end}`));
          return;
        }

        out = fs.createWriteStream(tempPath, { flags: 'r+', start });
        const expectedBytes = end - start + 1;

        response.on('data', (chunk) => {
          reported += chunk.length;
          onBytes(chunk.length);
        });
        response.on('error', fail);
        response.on('aborted', () => fail(Object.assign(
          new Error('Connection closed before the segment finished'),
          { code: 'ECONNRESET' }
        )));
        out.on('error', fail);
        out.on('finish', () => {
          if (attemptDone) return;
          // A response that stops short of the requested range must be retried,
          // not stitched into the file: the final MD5 would reject the whole
          // download over one truncated segment.
          if (reported !== expectedBytes) {
            fail(Object.assign(
              new Error(`Segment ${start}-${end} ended after ${reported} of ${expectedBytes} bytes`),
              { code: 'ECONNRESET' }
            ));
            return;
          }
          attemptDone = true;
          finish(resolve);
        });

        response.pipe(out);
      });

      req.on('error', fail);

      req.setTimeout(IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Download timeout after ${Math.round(IDLE_TIMEOUT_MS / 1000)} seconds.`));
      });
    };

    run(url, 0);
  });
}

/**
 * Download `totalBytes` into `tempPath` over several connections at once.
 * The file is truncated to its final size first and every segment writes at its
 * own offset, so parallel writers never overlap.
 *
 * The file is divided into fixed-size segments and a pool of `connections`
 * workers pulls them off a shared queue: a fast connection picks up the next
 * segment instead of waiting for the slowest one, and a retry only restarts the
 * segment that failed rather than a whole fixed share of the file.
 */
async function downloadSegments({ url, tempPath, totalBytes, connections, onProgress }) {
  const handle = await fs.promises.open(tempPath, 'w');
  try {
    await handle.truncate(totalBytes);
  } finally {
    await handle.close();
  }

  let downloaded = 0;
  const onBytes = (delta) => {
    downloaded += delta;
    if (!onProgress) return;
    onProgress({
      downloaded,
      total: totalBytes,
      percent: totalBytes > 0 ? (downloaded / totalBytes) * 100 : 0,
      delta
    });
  };

  const segments = makeSegments(totalBytes);
  const wanted = Math.max(2, Math.min(Number(connections) || 2, SEGMENTED_MAX_CONNECTIONS));
  const workerCount = Math.max(1, Math.min(wanted, segments.length));

  let next = 0;
  let failure = null;

  async function runWorker() {
    for (;;) {
      if (failure) return;
      const index = next;
      next += 1;
      if (index >= segments.length) return;

      const segment = segments[index];
      try {
        await downloadSegmentRange({
          url,
          tempPath,
          start: segment.start,
          end: segment.end,
          onBytes
        });
      } catch (error) {
        // Record the first failure and stop handing out work. Segments already
        // in flight are allowed to finish so nothing writes to the temp file
        // after the caller has cleaned it up.
        if (!failure) failure = error;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  if (failure) throw failure;
}

/**
 * Verify the completed temp file and only then replace the destination.
 * Shared by the single-stream and segmented paths so both replace identically.
 */
function finalizeTempFile(tempPath, destination, expectedMd5, cleanupTemp) {
  if (!expectedMd5) {
    try {
      fs.renameSync(tempPath, destination);
      return Promise.resolve({ path: destination });
    } catch (error) {
      cleanupTemp();
      return Promise.reject(error);
    }
  }

  return md5OfFile(tempPath).then((downloadedMd5) => {
    const expected = String(expectedMd5).toLowerCase();

    if (downloadedMd5 !== expected) {
      cleanupTemp();
      throw new Error(`MD5 mismatch: expected ${expected}, got ${downloadedMd5}. Existing file was preserved.`);
    }

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
        throw new Error(`Existing file is locked and could not be replaced: ${destination}`);
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
      throw error;
    }

    return { path: destination, md5: downloadedMd5 };
  }).catch((error) => {
    cleanupTemp();
    throw error;
  });
}

/**
 * Download `url` to `destination`, verify it against `expectedMd5`, and only
 * then replace whatever is already there.
 *
 * `segments` (optional) requests that the transfer be split across that many
 * connections when the host supports byte ranges and the file is large enough;
 * otherwise the single stream path below is used unchanged.
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
  const requestedSegments = Math.floor(Number(opts.segments) || 0);

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

    const finish = () => finalizeTempFile(tempPath, destination, expectedMd5, cleanupTemp);

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
          settled = true;
          file.close();
          finish().then(resolve, reject);
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

    const start = async () => {
      // A manifest file smaller than one segment cannot be split; skip the probe
      // so the hundreds of small client files do not cost an extra round trip.
      const knownSize = Number(size) > 0 ? Number(size) : 0;
      if (requestedSegments > 1 && (!knownSize || knownSize >= SEGMENTED_MIN_BYTES)) {
        let probe = null;
        try {
          probe = await probeRangeSupport(url, size);
        } catch (error) {
          if (log) log(`Range probe failed for ${url} (${error.message}); using a single connection`);
        }

        if (probe && probe.supported && probe.total >= SEGMENTED_MIN_BYTES) {
          const connections = Math.max(2, Math.min(requestedSegments, SEGMENTED_MAX_CONNECTIONS));
          try {
            if (log) log(`Downloading ${url} over ${connections} parallel connections (${probe.total} bytes)`);
            await downloadSegments({
              url,
              tempPath,
              totalBytes: probe.total,
              connections,
              onProgress
            });
            resolve(await finish());
          } catch (error) {
            cleanupTemp();
            if (error && error.code === 'RANGE_UNSUPPORTED') {
              if (log) log(`File host ignored the range request for ${url}; using a single connection`);
              downloadTo(url, 0, 1);
            } else {
              reject(error);
            }
          }
          return;
        }
      }

      downloadTo(url, 0, 1);
    };

    start().catch(reject);
  });
}

module.exports = { downloadFileFromUrl, encodeManifestPath, HTTP_HEADERS };
