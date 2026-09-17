const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { signingEnvironment } = require('./lib/mac-local-signing.cjs');

try {
  if (process.platform !== 'darwin') throw new Error('Local macOS builds require macOS.');
  const args = process.argv.slice(2);
  const allowed = new Set(['--all', '--arm64', '--x64']);
  if (args.length > 1 || args.some(arg => !allowed.has(arg))) {
    throw new Error('Usage: npm run build:mac -- [--all | --arm64 | --x64]');
  }
  const architectures = args[0] === '--all' ? ['arm64', 'x64'] : [args[0]?.slice(2) || process.arch];
  if (architectures.some(arch => !['arm64', 'x64'].includes(arch))) throw new Error('Unsupported host architecture.');
  const root = path.resolve(__dirname, '..');
  const env = {
    ...signingEnvironment(), CSC_IDENTITY_AUTO_DISCOVERY: 'false', HALO_MAC_SIGN_MODE: 'adhoc',
  };
  // Explicit credentials must not turn a local build into a distribution build.
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'CSC_IDENTITY',
    'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) delete env[key];
  const run = (file, argv) => execFileSync(file, argv, { cwd: root, env, stdio: 'inherit' });
  console.log(`[build:mac] Local ${architectures.join(', ')} build; ad-hoc signing, no notarization or publishing.`);
  run('npm', ['run', 'bump-rc']);
  for (const arch of architectures) run(process.execPath, ['scripts/prepare-binaries.mjs', '--platform', `mac-${arch}`]);
  run('npm', ['run', 'build']);
  run(path.join(root, 'node_modules', '.bin', 'electron-builder'), [
    '--mac', ...architectures.flatMap(arch => [`dmg:${arch}`, `zip:${arch}`]),
    '--config', 'electron-builder.cjs', '-c.mac.identity=null', '-c.mac.notarize=false', '--publish', 'never',
  ]);
  console.log('[build:mac] Ready. Quit the installed app, then run npm run install:mac to replace it safely.');
} catch (error) {
  console.error(`[build:mac] ${error.message}`);
  process.exitCode = 1;
}
