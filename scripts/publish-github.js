#!/usr/bin/env node
'use strict';

// scripts/publish-github.js
//
// Publishes one built launcher (dist/) as a GitHub release, so the launcher's
// fallback update feed stays current. The primary feed is our own site
// (https://swg-ghosts.online/launcher); this is the second one the launcher tries
// when the site is unreachable, so it must carry the *same* binaries.
//
// Asset layout matches the releases already on the repo (v1.9.x):
//   Ghosts-Launcher-Setup-<version>.exe
//   Ghosts-Launcher-Setup-<version>.exe.blockmap
//   latest.yml                       (the feed manifest, with dash names inside)
//
// Usage:
//   npm run publish:github                 # publish (needs a token)
//   npm run publish:github -- --dry-run     # print the plan, touch nothing
//   npm run publish:github -- --draft       # create/keep the release as a draft
//
// Token (never stored in this repo), first one found wins:
//   GH_TOKEN / GITHUB_TOKEN environment variable, GH_TOKEN_FILE, ~/.gh-token

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'github');
const REPO = 'bfitzgit23/SWG-Ghosts-Launcher';
const SITE_FEED = 'https://swg-ghosts.online/launcher/latest.yml';

function parseArgs(argv) {
  const args = { dryRun: false, draft: false, verifyDownload: false, repo: REPO, tag: null, notesFile: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--draft') args.draft = true;
    else if (arg === '--verify-download') args.verifyDownload = true;
    else if (arg === '--verify-only') args.verifyOnly = true;
    else if (arg === '--repo') args.repo = argv[++i];
    else if (arg === '--tag') args.tag = argv[++i];
    else if (arg === '--notes') args.notesFile = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function readToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return { token: fromEnv.trim(), source: 'environment' };
  const file = process.env.GH_TOKEN_FILE || path.join(os.homedir(), '.gh-token');
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value) return { token: value, source: file };
  } catch (_) {}
  return null;
}

function sha512Base64(file) {
  const hash = crypto.createHash('sha512');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('base64');
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, text });
      });
    });
    request.on('error', reject);
    request.setTimeout(60000, () => request.destroy(new Error('request timed out')));
    if (body) request.write(body);
    request.end();
  });
}

function githubApi(method, urlPath, token, body) {
  return httpRequest(
    {
      method,
      hostname: 'api.github.com',
      path: urlPath,
      headers: Object.assign(
        {
          'User-Agent': 'ghosts-launcher-release',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        token ? { Authorization: `Bearer ${token}` } : {},
        body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}
      ),
    },
    body
  ).then((response) => {
    let json = null;
    try {
      json = JSON.parse(response.text);
    } catch (_) {}
    return { status: response.status, json, text: response.text };
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'ghosts-launcher-release' } }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`${url} answered HTTP ${response.statusCode}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', reject);
  });
}

// GitHub serves release assets through a redirect to a signed CDN host: follow it and
// refuse any non-2xx, so a failed download can never pass as a zero-byte asset.
function downloadFollowRedirects(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'ghosts-launcher-release', Accept: 'application/octet-stream' } }, (response) => {
        const { statusCode, headers } = response;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`${url} redirected too many times`));
            return;
          }
          downloadFollowRedirects(new URL(headers.location, url).toString(), redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (statusCode < 200 || statusCode > 299) {
          response.resume();
          reject(new Error(`${url} answered HTTP ${statusCode}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

function uploadAsset(uploadUrl, token, name, file, size) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      `${uploadUrl}?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          'User-Agent': 'ghosts-launcher-release',
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode < 200 || response.statusCode > 299) {
            reject(new Error(`upload of ${name} failed: HTTP ${response.statusCode} ${text.slice(0, 300)}`));
            return;
          }
          resolve(JSON.parse(text));
        });
      }
    );
    request.on('error', reject);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.pipe(request);
  });
}

function githubLatestYml(version, fileName, sha512, size, releaseDate) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
}

// The release date is taken from the build's own dist/latest.yml so that running this
// script twice produces a byte-identical manifest: a manifest that changes on every
// invocation cannot be verified against what is already published.
function extractReleaseDate(yml) {
  return (yml.match(/^releaseDate:\s*'?([^'\n]+?)'?\s*$/m) || [])[1] || null;
}

function extractFeedFields(yml) {
  const version = (yml.match(/^version:\s*(.+)$/m) || [])[1];
  const url = (yml.match(/^\s*-\s*url:\s*(.+)$/m) || [])[1];
  const sha512 = (yml.match(/^\s+sha512:\s*(.+)$/m) || [])[1];
  const size = (yml.match(/^\s+size:\s*(\d+)$/m) || [])[1];
  return { version, url, sha512, size: size ? Number(size) : null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run publish:github [-- --dry-run] [-- --draft] [-- --verify-download] [-- --verify-only] [-- --repo o/r] [-- --tag vX.Y.Z]');
    console.log('  --verify-only      check an existing release without uploading (no token needed)');
    return 0;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const tag = args.tag || `v${version}`;
  const releaseName = version;
  const exePath = path.join(DIST, `Ghosts Launcher Setup ${version}.exe`);
  const blockmapPath = `${exePath}.blockmap`;
  const exeName = `Ghosts-Launcher-Setup-${version}.exe`;

  for (const file of [exePath, blockmapPath]) {
    if (!fs.existsSync(file)) {
      console.error(`ERROR: missing build artefact ${file}`);
      console.error('Run "npm run build:win" first.');
      return 1;
    }
  }

  const exeSize = fs.statSync(exePath).size;
  const blockmapSize = fs.statSync(blockmapPath).size;
  const exeSha512 = sha512Base64(exePath);
  console.log(`version      : ${version}`);
  console.log(`release tag  : ${tag} (repo ${args.repo}, public)`);
  console.log(`installer    : ${path.basename(exePath)} -> ${exeName} (${exeSize} bytes)`);
  console.log(`sha512       : ${exeSha512}`);

  // The two feeds must serve byte-identical installers, or a player who falls
  // back to GitHub would silently install a different (or older) build.
  let crossCheck = 'not compared';
  try {
    const siteYml = await fetchText(SITE_FEED);
    const site = extractFeedFields(siteYml);
    if (site.version === version && site.sha512 === exeSha512 && site.size === exeSize) {
      crossCheck = 'site feed already serves this exact build';
    } else {
      crossCheck = `site feed is at ${site.version} (sha512 matched: ${site.sha512 === exeSha512}) — publish the site first if this is the new release`;
    }
  } catch (error) {
    crossCheck = `site feed not reachable (${error.message})`;
  }
  console.log(`site feed    : ${crossCheck}`);

  fs.mkdirSync(STAGE, { recursive: true });
  let releaseDate = new Date().toISOString();
  try {
    const fromBuild = extractReleaseDate(fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8'));
    if (fromBuild) releaseDate = fromBuild;
  } catch (_) {}
  const manifestPath = path.join(STAGE, 'latest.yml');
  fs.writeFileSync(manifestPath, githubLatestYml(version, exeName, exeSha512, exeSize, releaseDate));
  console.log(`manifest     : ${manifestPath}`);

  const notes = args.notesFile && fs.existsSync(args.notesFile)
    ? fs.readFileSync(args.notesFile, 'utf8')
    : `Ghosts Launcher ${version}.\n\nFallback update feed for https://swg-ghosts.online/launcher.\n`;

  const assets = [
    { name: exeName, file: exePath, size: exeSize },
    { name: `${exeName}.blockmap`, file: blockmapPath, size: blockmapSize },
    { name: 'latest.yml', file: manifestPath, size: fs.statSync(manifestPath).size },
  ];

  const auth = readToken();
  if (!args.verifyOnly && (!auth || args.dryRun)) {
    console.log('');
    console.log('DRY RUN — nothing was uploaded. Plan:');
    const release = await githubApi('GET', `/repos/${args.repo}/releases/tags/${tag}`, null);
    console.log(`  release ${tag}: ${release.status === 200 ? `exists (id ${release.json.id})` : `will be created (HTTP ${release.status})`}`);
    for (const asset of assets) {
      console.log(`  upload ${asset.name} (${asset.size} bytes)`);
    }
    if (!auth) {
      console.log('');
      console.log('No GitHub token found, so this was a dry run. To publish for real set one of:');
      console.log('  GH_TOKEN=...        (environment variable)');
      console.log('  GITHUB_TOKEN=...    (environment variable)');
      console.log(`  ${path.join(os.homedir(), '.gh-token')}   (file containing just the token)`);
      console.log('Use a fine-grained token with "Contents: read and write" on');
      console.log(`  https://github.com/settings/tokens  ->  repository ${args.repo}`);
      console.log('The token only ever needs to exist on the machine that publishes; the launcher');
      console.log('itself reads this public repo anonymously.');
      return 1;
    }
    return 0;
  }

  const token = auth ? auth.token : null;

  if (args.verifyOnly) {
    console.log('');
    console.log(`verify-only: uploading nothing, checking the release that is already there (${tag})`);
  } else {
    console.log('');
    console.log(`publishing with token from ${auth.source === 'environment' ? 'environment' : auth.source}`);

    const existing = await githubApi('GET', `/repos/${args.repo}/releases/tags/${tag}`, token);
    let release = null;
    if (existing.status === 200) {
      release = existing.json;
      console.log(`release ${tag} already exists (id ${release.id}); updating it`);
      const patchBody = JSON.stringify({ name: releaseName, body: notes, draft: args.draft });
      const patched = await githubApi('PATCH', `/repos/${args.repo}/releases/${release.id}`, token, patchBody);
      if (patched.status !== 200) throw new Error(`could not update release: HTTP ${patched.status} ${patched.text.slice(0, 200)}`);
      release = patched.json;
    } else if (existing.status === 404) {
      const createBody = JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: releaseName,
        body: notes,
        draft: args.draft,
        prerelease: false,
      });
      const created = await githubApi('POST', `/repos/${args.repo}/releases`, token, createBody);
      if (created.status !== 201) throw new Error(`could not create release: HTTP ${created.status} ${created.text.slice(0, 300)}`);
      release = created.json;
      console.log(`created release ${tag} (id ${release.id})`);
    } else {
      throw new Error(`could not look up release ${tag}: HTTP ${existing.status} ${existing.text.slice(0, 200)}`);
    }

    for (const asset of assets) {
      const clash = (release.assets || []).find((entry) => entry.name === asset.name);
      if (clash) {
        const removed = await githubApi('DELETE', `/repos/${args.repo}/releases/assets/${clash.id}`, token);
        if (removed.status !== 204) throw new Error(`could not replace asset ${asset.name}: HTTP ${removed.status}`);
        console.log(`  replaced existing asset ${asset.name}`);
      }
      const uploaded = await uploadAsset(release.upload_url.replace('{?name,label}', ''), token, asset.name, asset.file, asset.size);
      console.log(`  uploaded ${uploaded.name} (${uploaded.size} bytes)`);
    }
  }

  // Verify what the release actually carries, not what we meant to send. Needs no
  // token because the repository is public, which is how --verify-only works.
  const verify = await githubApi('GET', `/repos/${args.repo}/releases/tags/${tag}`, token);
  if (verify.status !== 200) throw new Error(`verification failed: HTTP ${verify.status}`);
  let failed = false;
  for (const asset of assets) {
    const found = (verify.json.assets || []).find((entry) => entry.name === asset.name);
    const ok = found && found.size === asset.size;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${asset.name}${found ? ` (${found.size} bytes)` : ' missing'}`);
    if (!ok) failed = true;
  }

  if (args.verifyDownload) {
    const assetList = verify.json.assets || [];
    for (const asset of assets) {
      const entry = assetList.find((item) => item.name === asset.name);
      if (!entry) continue;
      const data = await downloadFollowRedirects(entry.browser_download_url);
      const digest = crypto.createHash('sha512').update(data).digest('base64');
      let ok = data.length === asset.size;
      let detail;
      if (asset.name === 'latest.yml') {
        // The manifest is metadata: what the launcher reads is the version, file name,
        // checksum and size it advertises, so compare those against the build rather
        // than the manifest's own informational releaseDate stamp.
        const remote = extractFeedFields(data.toString('utf8'));
        const fieldsOk =
          remote.version === version &&
          remote.url === exeName &&
          remote.sha512 === exeSha512 &&
          remote.size === exeSize;
        ok = ok && fieldsOk;
        detail = `advertises ${remote.version} / ${remote.url} / ${remote.size} B — ${fieldsOk ? 'matches the build' : 'MISMATCH'}`;
      } else {
        const local = sha512Base64(asset.file);
        ok = ok && digest === local;
        detail = `sha512 ${digest === local ? 'matches the build' : 'DIFFERS'}`;
      }
      console.log(`  ${ok ? 'OK  ' : 'FAIL'} downloaded ${asset.name} (${data.length} bytes, ${detail})`);
      if (!ok) failed = true;
    }
  }

  console.log(`release page: https://github.com/${args.repo}/releases/tag/${tag}`);
  if (failed) {
    console.error('PUBLISH VERIFICATION FAILED');
    return 1;
  }
  console.log('publish OK');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`ERROR: ${error.message || error}`);
    process.exit(1);
  });
