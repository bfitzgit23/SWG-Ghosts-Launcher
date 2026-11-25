#!/usr/bin/env node
'use strict';

// scripts/build-mac.js — macOS build wrapper.
//
// Why this exists: Apple only signs and notarizes macOS software with tools that
// ship on macOS (codesign, notarytool). Whatever a Linux or Windows machine builds
// for the mac is therefore unsigned, and Squirrel.Mac refuses to install an update
// over it. This wrapper signs and notarizes whenever credentials exist on the
// machine it runs on, and says plainly when it cannot — so an unsigned mac build
// is never mistaken for a shippable one.
//
// Signing material (either is enough):
//   - a "Developer ID Application" certificate in the login keychain, or
//   - CSC_LINK (+ CSC_KEY_PASSWORD) pointing at a .p12 holding that certificate.
// Notarization credentials (one complete set):
//   - APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER        (preferred by Apple)
//   - APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
//   - APPLE_KEYCHAIN_PROFILE (+ optional APPLE_KEYCHAIN)
//
// Usage:
//   node scripts/build-mac.js                 # both architectures
//   node scripts/build-mac.js --x64           # one architecture
//   node scripts/build-mac.js --require-signed  # fail instead of warning
//   node scripts/build-mac.js --dry-run       # report what would happen, build nothing

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IS_MAC = process.platform === 'darwin';
const argv = process.argv.slice(2);

const archFlags = argv.filter((arg) => arg === '--x64' || arg === '--arm64');
const requireSigned = argv.includes('--require-signed');
const dryRun = argv.includes('--dry-run');

const unknown = argv.filter(
  (arg) => !['--x64', '--arm64', '--require-signed', '--dry-run', '--help', '-h'].includes(arg)
);
if (unknown.length) {
  console.error(`build-mac: unknown argument(s): ${unknown.join(' ')}`);
  process.exit(2);
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/build-mac.js [--x64] [--arm64] [--require-signed] [--dry-run]');
  console.log('  --x64 / --arm64   architectures to build (default: both)');
  console.log('  --require-signed  exit non-zero instead of warning when the build cannot be signed');
  console.log('  --dry-run         report detected credentials and the command, build nothing');
  process.exit(0);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const pkg = readJson(path.join(ROOT, 'package.json'));
const outDir = path.join(ROOT, (pkg.build && pkg.build.directories && pkg.build.directories.output) || 'dist');

// --- credentials -----------------------------------------------------------

function keychainIdentity() {
  if (!IS_MAC) return null;
  // A locked/unavailable keychain is not an error here: it just means no identity
  // was found and the build is unsigned.
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return null;
  const line = result.stdout
    .split('\n')
    .find((entry) => entry.includes('Developer ID Application'));
  if (!line) return null;
  const quoted = line.match(/"([^"]+)"/);
  return quoted ? quoted[1] : 'Developer ID Application';
}

function signingIdentity() {
  if (process.env.CSC_NAME) return { source: `CSC_NAME`, value: process.env.CSC_NAME };
  if (process.env.CSC_LINK) {
    return { source: 'CSC_LINK', value: `${path.basename(process.env.CSC_LINK)}${process.env.CSC_KEY_PASSWORD ? ' (with password)' : ' (no CSC_KEY_PASSWORD)'}` };
  }
  if (!IS_MAC) return null;
  const identity = keychainIdentity();
  return identity ? { source: 'keychain', value: identity } : null;
}

function notarizationCredentials(env) {
  const apiKey = [env.APPLE_API_KEY, env.APPLE_API_KEY_ID, env.APPLE_API_ISSUER];
  const appleId = [env.APPLE_ID, env.APPLE_APP_SPECIFIC_PASSWORD, env.APPLE_TEAM_ID];
  const keychain = [env.APPLE_KEYCHAIN_PROFILE];

  if (apiKey.some(Boolean)) {
    if (!apiKey.every(Boolean)) {
      return { error: 'APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER must all be set' };
    }
    return { source: 'App Store Connect API key' };
  }
  if (appleId.some(Boolean)) {
    if (!appleId.every(Boolean)) {
      return { error: 'APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID must all be set' };
    }
    return { source: 'Apple ID + app-specific password' };
  }
  if (keychain.some(Boolean)) {
    return { source: 'notarytool keychain profile' };
  }
  return null;
}

const identity = signingIdentity();
const notarizeCreds = notarizationCredentials(process.env);

if (notarizeCreds && notarizeCreds.error) {
  console.error(`build-mac: incomplete notarization credentials — ${notarizeCreds.error}`);
  process.exit(1);
}

const canSign = IS_MAC && !!identity;

console.log('build-mac:');
console.log(`  host                 ${process.platform} (${process.arch})`);
console.log(`  signing identity     ${canSign ? `${identity.source}: ${identity.value}` : 'none'}`);
if (identity && !IS_MAC) {
  console.log('  note                 signing material is set, but codesign only exists on macOS');
}
console.log(`  notarization         ${notarizeCreds ? notarizeCreds.source : 'no credentials'} ` +
  `${notarizeCreds && !canSign ? '(will be skipped: notarization needs a signed app)' : ''}`);
console.log(`  result               ${canSign ? 'signed and notarized build' : 'UNSIGNED build — macOS auto-update will not install it'}`);

if (!canSign) {
  const reason = !IS_MAC
    ? 'macOS builds can only be signed on macOS (codesign/notarytool are macOS-only).'
    : 'No "Developer ID Application" certificate was found in the keychain and CSC_LINK is not set.';
  console.warn(`\nbuild-mac: ${reason}`);
  console.warn('build-mac: run this on a Mac with Apple Developer Program credentials to produce an updatable build.');
}
if (notarizeCreds && !canSign) {
  console.error('\nbuild-mac: notarization credentials are set but the app cannot be signed, so notarization would be skipped.');
  console.error('build-mac: refusing to produce a build that looks notarized but is not — unset the Apple credentials or build on macOS.');
  process.exit(1);
}
if (requireSigned && !canSign) {
  console.error('\nbuild-mac: --require-signed was requested and this build is unsigned.');
  process.exit(1);
}

// --- build -----------------------------------------------------------------

const archArgs = archFlags.length ? archFlags : ['--x64', '--arm64'];
const env = Object.assign({}, process.env);
if (canSign) {
  // Let electron-builder pick up the certificate that is actually there (keychain or CSC_*).
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
} else {
  // Skip discovery entirely so a stray certificate cannot half-sign a cross build.
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

const builderBin = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
);
const builderArgs = ['--mac', 'zip'].concat(archArgs);

if (dryRun) {
  console.log(`\nbuild-mac: would run ${path.relative(ROOT, builderBin)} ${builderArgs.join(' ')}`);
  process.exit(0);
}

if (!fs.existsSync(builderBin)) {
  console.error(`build-mac: electron-builder not found at ${builderBin} — run npm install first`);
  process.exit(1);
}

console.log(`\nbuild-mac: running electron-builder ${builderArgs.join(' ')}`);
const build = spawnSync(builderBin, builderArgs, { cwd: ROOT, env, stdio: 'inherit' });
if (build.status !== 0) {
  console.error(`build-mac: electron-builder failed with exit code ${build.status}`);
  process.exit(build.status || 1);
}

// --- verify what came out --------------------------------------------------

if (!IS_MAC) {
  console.log('\nbuild-mac: build finished unsigned (macOS update install will be refused).');
  process.exit(0);
}

function appBundles() {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .map((entry) => path.join(outDir, entry.name))
    .flatMap((dir) => {
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
          .map((entry) => path.join(dir, entry.name));
      } catch (_) {
        return [];
      }
    });
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

const apps = appBundles();
if (!apps.length) {
  console.error(`build-mac: no .app bundles found under ${outDir}`);
  process.exit(1);
}

let allSigned = true;
let allStapled = true;
for (const app of apps) {
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const details = run('codesign', ['-dv', '--verbose=4', app]);
  const authority = (details.output.match(/^Authority=(.+)$/m) || [])[1] || 'none';
  const team = (details.output.match(/^TeamIdentifier=(.+)$/m) || [])[1] || 'not set';
  const staple = notarizeCreds ? run('xcrun', ['stapler', 'validate', app]) : null;

  const signed = verify.status === 0 && authority !== 'none';
  const stapled = staple ? staple.status === 0 : false;
  allSigned = allSigned && signed;
  allStapled = allStapled && (!notarizeCreds || stapled);

  console.log(`\nbuild-mac: ${path.relative(ROOT, app)}`);
  console.log(`  signature     ${signed ? 'valid' : 'INVALID/absent'} — ${authority}`);
  console.log(`  team          ${team}`);
  if (staple) console.log(`  notarization  ${stapled ? 'ticket stapled' : 'NOT stapled'}`);
}

if (!allSigned) {
  console.error('\nbuild-mac: one or more bundles are not validly signed — do not publish this as an updatable build.');
  process.exit(requireSigned || !!notarizeCreds ? 1 : 0);
}
if (!allStapled) {
  console.error('\nbuild-mac: notarization ticket missing from at least one bundle.');
  process.exit(1);
}
console.log(
  notarizeCreds
    ? '\nbuild-mac: signed, notarized and stapled — ready to publish.'
    : '\nbuild-mac: signed, but not notarized (no Apple credentials set) — Gatekeeper will still block it for new users.'
);
