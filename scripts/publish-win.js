const { spawnSync } = require('child_process');

if (!process.env.GH_TOKEN) {
  console.error('');
  console.error('ERROR: GH_TOKEN is not set.');
  console.error('');
  console.error('To publish a Windows release to GitHub, set a GitHub Personal Access Token');
  console.error('with permission to create/update releases in bfitzgit23/SWG-Ghosts-Launcher.');
  console.error('');
  console.error('PowerShell example:');
  console.error('  $env:GH_TOKEN = "YOUR_GITHUB_TOKEN"');
  console.error('  npm run publish:win');
  console.error('');
  console.error('Do NOT put the token in package.json, main.js, renderer.js, or the source ZIP.');
  process.exit(1);
}

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-builder', '--win', '--x64', '--publish', 'always'],
  { stdio: 'inherit', shell: false }
);

process.exit(result.status ?? 1);
