const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function signingEnvironment() {
  const candidates = [process.env.CODESIGN_ALLOCATE];
  try {
    candidates.push(execFileSync('/usr/bin/xcrun', ['--find', 'codesign_allocate'], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
  } catch (error) {
    console.warn(`[mac-local-signing] Selected developer tools unavailable; checking installed alternatives: ${error.message}`);
  }
  candidates.push('/Library/Developer/CommandLineTools/usr/bin/codesign_allocate',
    '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/codesign_allocate');
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-signing-tools-'));
  try {
    for (const candidate of [...new Set(candidates.filter(Boolean))]) {
      if (!fs.existsSync(candidate)) continue;
      const env = { ...process.env, CODESIGN_ALLOCATE: candidate };
      const probe = path.join(probeDir, 'probe');
      fs.copyFileSync('/usr/bin/true', probe);
      try {
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', probe],
          { env, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
        execFileSync('/usr/bin/codesign', ['--verify', '--strict', probe],
          { env, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
        console.log(`[mac-local-signing] Using ${candidate}`);
        return env;
      } catch (error) {
        console.warn(`[mac-local-signing] Toolchain probe failed (${candidate}): ${error.message}`);
      }
    }
    throw new Error('No working codesign_allocate. Install Xcode Command Line Tools with xcode-select --install. No Developer ID certificate is required.');
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

function findMachOFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findMachOFiles(file));
    else if (entry.isFile() && !entry.name.endsWith('.class')) {
      const fd = fs.openSync(file, 'r');
      try {
        const header = Buffer.alloc(4);
        if (fs.readSync(fd, header, 0, 4, 0) === 4 &&
            ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))) {
          files.push(file);
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return files;
}

function signLocalApp(appPath, entitlementsPath, env = signingEnvironment()) {
  const run = (args) => execFileSync('/usr/bin/codesign', args, { env, stdio: 'pipe', timeout: 120000 });
  // codesign --deep does not treat executables under Resources as nested code.
  const files = findMachOFiles(path.join(appPath, 'Contents', 'Resources'));
  for (const file of files) {
    const staging = fs.mkdtempSync(path.join(path.dirname(file), '.halo-sign-'));
    const replacement = path.join(staging, path.basename(file));
    try {
      fs.copyFileSync(file, replacement);
      fs.chmodSync(replacement, fs.statSync(file).mode | 0o111);
      run(['--force', '--sign', '-', '--timestamp=none', '--entitlements', entitlementsPath, replacement]);
      run(['--verify', '--strict', replacement]);
      // A new inode avoids stale kernel signature state and shared hard links.
      fs.renameSync(replacement, file);
    } catch (error) {
      throw new Error(`[mac-local-signing] Failed signing ${file}: ${error.message}`, { cause: error });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  run(['--force', '--deep', '--sign', '-', '--timestamp=none', '--entitlements', entitlementsPath, appPath]);
  run(['--verify', '--deep', '--strict', appPath]);
  for (const file of files) run(['--verify', '--strict', file]);
  console.log(`[mac-local-signing] Verified app and ${files.length} resource binaries (ad-hoc, no notarization).`);
}

module.exports = { signingEnvironment, findMachOFiles, signLocalApp };
