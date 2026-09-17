const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findMachOFiles } = require('./lib/mac-local-signing.cjs');

try {
  if (process.platform !== 'darwin') throw new Error('Local macOS installation requires macOS.');
  const root = path.resolve(__dirname, '..');
  const config = require('../electron-builder.cjs');
  const source = path.join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', `${config.productName}.app`);
  const target = path.join('/Applications', path.basename(source));
  const readPlist = (app, key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  if (!fs.existsSync(source)) throw new Error(`Missing local build: ${source}`);
  const bundleId = readPlist(source, 'CFBundleIdentifier');
  if (bundleId !== config.appId) throw new Error(`Build identity mismatch: ${bundleId} (expected ${config.appId})`);
  if (fs.existsSync(target) && readPlist(target, 'CFBundleIdentifier') !== bundleId) {
    throw new Error(`Refusing to replace a different product at ${target}`);
  }
  const executable = readPlist(source, 'CFBundleExecutable');
  const processes = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n').map(line => line.trim());
  // Include renamed copies of this product, but not unrelated Electron apps.
  if (processes.some(command => command.endsWith(`/Contents/MacOS/${executable}`))) {
    throw new Error(`Quit ${config.productName} (including renamed copies) before installation; active sessions will not be killed.`);
  }
  const staging = fs.mkdtempSync(path.join('/Applications', '.halo-install-'));
  const stagedApp = path.join(staging, path.basename(source));
  let backup;
  try {
    execFileSync('/usr/bin/ditto', [source, stagedApp], { stdio: 'inherit' });
    execFileSync('/usr/bin/xattr', ['-cr', stagedApp], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp], { stdio: 'inherit' });
    for (const file of findMachOFiles(path.join(stagedApp, 'Contents', 'Resources'))) {
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], { stdio: 'inherit' });
    }
    if (fs.existsSync(target)) {
      backup = path.join(staging, path.basename(source, '.app') + '.previous.app');
      fs.renameSync(target, backup);
    }
    try {
      fs.renameSync(stagedApp, target);
    } catch (error) {
      if (backup) fs.renameSync(backup, target);
      throw error;
    }
    // The new app is in place, so the previous one is only a rollback copy that
    // is no longer reachable. Keeping it would leave a hidden multi-hundred-MB
    // directory in /Applications after every install, growing without bound.
    fs.rmSync(staging, { recursive: true, force: true });
    console.log(`[install:mac] Installed ${target}`);
    execFileSync('/usr/bin/open', [target], { stdio: 'inherit' });
  } catch (error) {
    // Retained on failure: it holds the previous app whenever the target was
    // already moved aside, which is the only copy left to recover from.
    if (fs.existsSync(staging)) console.error(`[install:mac] Installation failed; staging retained at ${staging}`);
    throw error;
  }
} catch (error) {
  console.error(`[install:mac] ${error.message}`);
  process.exitCode = 1;
}
