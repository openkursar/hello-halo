const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ENGINE_RUNTIMES } = require('../engine-runtimes.cjs');

const SDK_DIR = path.join('src', 'sdk', 'halo-sdk');

/**
 * Rebuild the nested Halo SDK so a package carries its current source.
 * The app depends on it as `file:src/sdk/halo-sdk` and ships its dist/, which
 * `npm run build` never touches.
 */
function buildHaloSdk(root, { env = process.env, execFile = execFileSync } = {}) {
  const { packageId, requiredFiles } = ENGINE_RUNTIMES.halo;
  const sdk = path.join(root, SDK_DIR);
  const manifestPath = path.join(sdk, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Halo SDK source not found at ${SDK_DIR}; check it out there before packaging.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== packageId || !manifest.scripts?.build) {
    throw new Error(`${SDK_DIR}/package.json is not a buildable ${packageId}.`);
  }
  if (!fs.existsSync(path.join(sdk, 'node_modules'))) {
    throw new Error(`Halo SDK dependencies are missing; run npm install in ${SDK_DIR} first.`);
  }
  const installed = path.join(root, 'node_modules', ...packageId.split('/'));
  if (!fs.existsSync(installed) || fs.realpathSync(installed) !== fs.realpathSync(sdk)) {
    throw new Error(`node_modules/${packageId} does not link to ${SDK_DIR}; run npm install at the repository root.`);
  }
  console.log(`[halo-sdk] Building ${SDK_DIR}...`);
  console.log(`[halo-sdk] SDK ${describeRevision(sdk, execFile)}`);
  execFile('npm', ['run', 'build'], { cwd: sdk, env, stdio: 'inherit' });
  const missing = requiredFiles.filter(file => !fs.existsSync(path.join(sdk, file)));
  if (missing.length) throw new Error(`Halo SDK build did not produce ${missing.join(', ')}.`);
}

/** The checkout a package is built from, so uncommitted SDK work is visible in the build log. */
function describeRevision(sdk, execFile) {
  const git = args => String(execFile('git', args, { cwd: sdk, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  try {
    if (fs.realpathSync(git(['rev-parse', '--show-toplevel'])) !== fs.realpathSync(sdk)) return 'revision unknown (not its own git checkout)';
    const changed = git(['--no-optional-locks', 'status', '--porcelain']).split('\n').filter(Boolean).length;
    return `${git(['rev-parse', '--short', 'HEAD'])} · ${changed} uncommitted`;
  } catch {
    return 'revision unknown (git unavailable)';
  }
}

module.exports = { buildHaloSdk };

if (require.main === module) {
  try {
    buildHaloSdk(path.resolve(__dirname, '..', '..'));
  } catch (error) {
    console.error(`[halo-sdk] ${error.message}`);
    process.exitCode = 1;
  }
}
