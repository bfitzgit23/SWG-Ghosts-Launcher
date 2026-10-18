const { spawnSync } = require('child_process');
const path = require('path');

// Build the Windows installer, then publish it to the GitHub release so the
// launcher's fallback update feed stays current. The primary feed is our own
// site (swg-ghosts.online/launcher), which is uploaded separately with the
// release script that has SSH access to the box.
//
// Override the build step with SKIP_BUILD=1 when the installer in dist/ is
// already the one you want to publish.

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

if (process.env.SKIP_BUILD !== '1') {
  console.log('--- building Windows installer ---');
  const build = spawnSync(npx, ['electron-builder', '--win', '--x64'], {
    stdio: 'inherit',
    shell: false,
  });
  if ((build.status ?? 1) !== 0) {
    console.error('electron-builder failed — nothing published');
    process.exit(build.status ?? 1);
  }
}

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.error('');
  console.error('WARNING: no GH_TOKEN / GITHUB_TOKEN set.');
  console.error('');
  console.error('To publish the Windows release to GitHub, set a GitHub Personal Access Token');
  console.error('with permission to create/update releases in bfitzgit23/SWG-Ghosts-Launcher:');
  console.error('');
  console.error('PowerShell example:');
  console.error('  $env:GH_TOKEN = "YOUR_GITHUB_TOKEN"');
  console.error('  npm run publish:win');
  console.error('');
  console.error('The token must never be put in package.json, main.js, renderer.js or the source ZIP.');
  console.error('');
}

const publish = spawnSync(process.execPath, [path.join(__dirname, 'publish-github.js')], {
  stdio: 'inherit',
  shell: false,
});

process.exit(publish.status ?? 1);
