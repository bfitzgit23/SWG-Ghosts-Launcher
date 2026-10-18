#!/usr/bin/env node
// download-selftest.js - exercise the launcher's real download path against the
// live file host, without opening the launcher.
//
// The pre-launch scan verifies every manifest file against the md5 published in
// required-files.json. A single entry the downloader cannot reproduce used to
// stop Play with "Client verification failed", so this harness downloads the
// manifest's riskiest entries through the same module the launcher uses and
// checks the bytes against the manifest.
//
//   node scripts/download-selftest.js                # text-ish entries (CDN rewrite surface)
//   node scripts/download-selftest.js --all          # every entry (multi-GB, for a full audit)
//   node scripts/download-selftest.js --version=nge
//   node scripts/download-selftest.js --file=data_sku1_00.tre   # named entries only
//
// It also runs a control fetch with no Accept header, which is how the CDN
// rewrite that broke verification is still detectable.
//
// Exit code 0 = every entry verified, 1 = at least one could not be verified.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const { downloadFileFromUrl } = require('../download');

const UA = { 'User-Agent': 'GhostsLauncher' };
const HOST = 'https://swg-ghosts.online';
const BASES = { precu: HOST + '/tre/', 'precu-testcenter': HOST + '/tre/', nge: HOST + '/tre/nge/' };
const MANIFESTS = {
  precu: HOST + '/tre/required-files.json',
  'precu-testcenter': HOST + '/tre/required-files.json',
  nge: HOST + '/tre/nge/required-files.json'
};

// Files whose bytes the CDN has been caught rewriting, plus one of each shape
// the launcher actually ships (DLL, exe, cfg) so a transport change shows up.
const ALWAYS = ['D3D9.dll', 'swgemu.cfg', 'patch-notes.html'];
const TEXT_EXT = /\.(html?|txt|md|json|xml|cfg|ini|fx|fxh)$/i;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const hit = args.find(a => a.startsWith(name + '='));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const version = value('--version') || 'precu';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghosts-selftest-'));

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: UA }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function md5Of(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex').toLowerCase()))
      .on('error', reject);
  });
}

function encodeManifestName(name) {
  return String(name).replace(/\\/g, '/').replace(/^[/\\]+/, '')
    .split('/').map(encodeURIComponent).join('/');
}

async function checkEntry(entry) {
  const local = path.join(tmpRoot, encodeManifestName(entry.name).replace(/%2F/gi, '_'));
  try {
    await downloadFileFromUrl({
      url: BASES[version] + encodeManifestName(entry.name),
      destination: local,
      expectedMd5: entry.md5,
      size: entry.size
    });
  } catch (error) {
    return { name: entry.name, ok: false, reason: error.message };
  }

  const md5 = await md5Of(local);
  if (md5 !== String(entry.md5).toLowerCase()) {
    return { name: entry.name, ok: false, reason: `md5 ${md5} != manifest ${entry.md5}` };
  }
  return { name: entry.name, ok: true, size: entry.size };
}

/**
 * Fetch a URL the way the launcher did before the fix - no Accept header - and
 * report whether the bytes still disagree with the manifest. This is the
 * evidence that the header, not luck, is what makes verification pass.
 */
function controlFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: UA }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function controlCheck(manifest) {
  console.log('--- control: same URLs fetched with no Accept header');
  for (const name of ALWAYS) {
    const entry = manifest.find((e) => e.name === name);
    if (!entry) continue;
    try {
      const body = await controlFetch(BASES[version] + encodeManifestName(name));
      const md5 = crypto.createHash('md5').update(body).digest('hex').toLowerCase();
      const mismatched = md5 !== String(entry.md5).toLowerCase();
      console.log(`${mismatched ? 'REWRITTEN' : 'identical'} ${name} (${body.length} bytes, md5 ${md5.slice(0, 12)}, manifest ${String(entry.md5).slice(0, 12)})`);
    } catch (error) {
      console.log(`control fetch failed for ${name}: ${error.message}`);
    }
  }
  console.log('');
}

function main() {
  return fetchJson(MANIFESTS[version]).then(async (manifest) => {
    const named = args.filter(a => a.startsWith('--file='))
      .flatMap(a => a.slice('--file='.length).split(',')) 
      .map(name => name.trim()).filter(Boolean);

    let targets;
    if (named.length) {
      const byName = new Map(manifest.map((e) => [e.name, e]));
      targets = named.map((name) => {
        const entry = byName.get(name);
        if (!entry) throw new Error(`no manifest entry named ${name}`);
        return entry;
      });
    } else if (flag('--all')) {
      targets = manifest;
    } else {
      const byName = new Map(manifest.map((e) => [e.name, e]));
      targets = manifest.filter((e) => TEXT_EXT.test(e.name));
      for (const name of ALWAYS) {
        const entry = byName.get(name);
        if (entry && !targets.includes(entry)) targets.push(entry);
      }
    }

    console.log(`version           : ${version}`);
    console.log(`manifest entries  : ${manifest.length}`);
    console.log(`checking          : ${targets.length} file(s) through download.js (Accept: */*)`);
    console.log('');

    await controlCheck(manifest);

    const results = [];
    const queue = targets.slice();
    const workers = Array.from({ length: 4 }, async () => {
      for (;;) {
        const entry = queue.shift();
        if (!entry) return;
        const result = await checkEntry(entry);
        results.push(result);
        console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.ok ? '' : ` -> ${result.reason}`}`);
      }
    });
    await Promise.all(workers);

    const failures = results.filter((r) => !r.ok);
    console.log('');
    console.log(`checked ${results.length}, failed ${failures.length}`);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    return failures.length === 0 ? 0 : 1;
  });
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('selftest error:', error.message);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    process.exit(2);
  });
