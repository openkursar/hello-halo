// ============================================================================
// afterPack hook - Post-packaging cleanup, native binary swap, and signing
//
// Runs after electron-builder creates the unpacked app directory.
//
// 1. Remove non-target @parcel/watcher platform packages from the unpacked
//    output. All 4 platform packages exist in node_modules (so every build
//    sees a complete set), but only the target platform's package is needed
//    at runtime. Cleaning here avoids mutating the shared node_modules.
//
// 2. Swap better-sqlite3 .node binary with the correct platform-specific
//    prebuild. The host-compiled binary (darwin-arm64 on M4 Mac) is replaced
//    with the prebuild matching the target platform. Prebuilds are downloaded
//    by prepare-binaries.mjs and stored in node_modules/better-sqlite3/prebuilds/.
//
// 3. Ensure executable permissions on all native binaries in the unpacked
//    output. Some npm packages (e.g. @anthropic-ai/claude-code v2.1.89)
//    ship tarballs with missing +x on vendored binaries. This step detects
//    ELF and Mach-O files by magic bytes and adds +x if missing.
//
// 4. macOS ad-hoc signing (prevents "damaged app" prompts on unsigned builds).
// ============================================================================

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

// Maps platform-arch to the @parcel/watcher package name to KEEP.
// Everything else under @parcel/watcher-* gets removed.
const WATCHER_TARGETS = {
  'darwin-arm64': 'watcher-darwin-arm64',
  'darwin-x64':   'watcher-darwin-x64',
  'win32-x64':    'watcher-win32-x64',
  'linux-x64':    'watcher-linux-x64-glibc',
};

// Maps platform-arch to the node-pty prebuilds directory name to KEEP.
// node-pty ships prebuilds for mac and win in the npm package.
// Linux is intentionally excluded: no public prebuilds available; the terminal
// panel feature is disabled on Linux at runtime via a platform check.
const NODE_PTY_PREBUILD_TARGETS = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64':   'darwin-x64',
  'win32-x64':    'win32-x64',
};

// Maps platform-arch to the @openai/codex native package required at runtime.
const CODEX_TARGETS = {
  'darwin-arm64': { packageName: 'codex-darwin-arm64', targetTriple: 'aarch64-apple-darwin', binaryName: 'codex' },
  'darwin-x64':   { packageName: 'codex-darwin-x64', targetTriple: 'x86_64-apple-darwin', binaryName: 'codex' },
  'win32-x64':    { packageName: 'codex-win32-x64', targetTriple: 'x86_64-pc-windows-msvc', binaryName: 'codex.exe' },
  'linux-x64':    { packageName: 'codex-linux-x64', targetTriple: 'x86_64-unknown-linux-musl', binaryName: 'codex' },
};

/**
 * Resolve the app.asar.unpacked directory from electron-builder context.
 *
 * macOS:       <appOutDir>/<ProductName>.app/Contents/Resources/app.asar.unpacked
 * win32/linux: <appOutDir>/resources/app.asar.unpacked
 */
function getUnpackedDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app.asar.unpacked');
  }
  return path.join(context.appOutDir, 'resources', 'app.asar.unpacked');
}

/**
 * Remove non-target @parcel/watcher-* packages from the unpacked output.
 */
function cleanNonTargetWatchers(context) {
  const platform = context.electronPlatformName;
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${archStr}`;
  const targetPkg = WATCHER_TARGETS[key];

  if (!targetPkg) {
    console.warn(`[afterPack] No watcher mapping for ${key}, skipping cleanup`);
    return;
  }

  const unpackedDir = getUnpackedDir(context);
  const parcelDir = path.join(unpackedDir, 'node_modules', '@parcel');

  if (!fs.existsSync(parcelDir)) {
    console.log(`[afterPack] No @parcel dir in unpacked output, skipping cleanup`);
    return;
  }

  const entries = fs.readdirSync(parcelDir, { withFileTypes: true });
  const removed = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('watcher-')) continue;
    if (entry.name === targetPkg) continue;

    const fullPath = path.join(parcelDir, entry.name);
    fs.rmSync(fullPath, { recursive: true });
    removed.push(entry.name);
  }

  if (removed.length > 0) {
    console.log(`[afterPack] ${key}: removed ${removed.length} non-target watcher(s): ${removed.join(', ')}`);
  }
  console.log(`[afterPack] ${key}: keeping @parcel/${targetPkg}`);
}

/**
 * Swap better-sqlite3 .node binary with the correct platform-specific prebuild.
 *
 * The binary in the unpacked output is whatever was in node_modules at pack time
 * (the host platform's binary, e.g. darwin-arm64 when building on M4 Mac).
 * This function replaces it with the prebuild matching the target platform.
 *
 * Prebuilds are stored at:
 *   {projectRoot}/node_modules/better-sqlite3/prebuilds/{platform}-{arch}/better_sqlite3.node
 *
 * Target location in unpacked output:
 *   app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node
 */
function swapBetterSqlite3Binary(context) {
  const platform = context.electronPlatformName;
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${archStr}`;

  const projectRoot = path.resolve(__dirname, '..');
  const prebuildSrc = path.join(
    projectRoot, 'node_modules/better-sqlite3/prebuilds', `${platform}-${archStr}`, 'better_sqlite3.node'
  );

  if (!fs.existsSync(prebuildSrc)) {
    console.error(`[afterPack] Missing better-sqlite3 prebuild for ${key}: ${prebuildSrc}`);
    console.error(`[afterPack] Run "npm run prepare:all" to download prebuilds for all platforms`);
    throw new Error(`Missing better-sqlite3 prebuild for ${key}`);
  }

  const unpackedDir = getUnpackedDir(context);
  const targetNode = path.join(
    unpackedDir, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  );

  if (!fs.existsSync(targetNode)) {
    console.error(`[afterPack] ${key}: better_sqlite3.node not found in unpacked output`);
    console.error(`[afterPack] Check that asarUnpack includes "node_modules/better-sqlite3/build/Release/*.node"`);
    throw new Error(`better_sqlite3.node not found in unpacked output for ${key}`);
  }

  fs.copyFileSync(prebuildSrc, targetNode);

  const sizeMB = (fs.statSync(targetNode).size / 1024 / 1024).toFixed(1);
  console.log(`[afterPack] ${key}: swapped better-sqlite3 binary (${sizeMB} MB)`);
}

/**
 * Remove non-target node-pty prebuild directories and strip .pdb debug symbols.
 *
 * node-pty ships prebuilds for all platforms inside the npm package:
 *   prebuilds/darwin-arm64/, darwin-x64/, win32-arm64/, win32-x64/
 * Plus linux-x64/ when prepared via prepare-binaries.mjs.
 *
 * We keep only the target platform directory and remove .pdb files (Windows
 * debug symbols, ~30 MB each) that are not needed at runtime.
 */
function cleanNodePtyPrebuilds(context) {
  const platform = context.electronPlatformName;
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${archStr}`;
  const targetDir = NODE_PTY_PREBUILD_TARGETS[key];

  if (!targetDir) {
    // Linux: terminal panel is not supported, node-pty prebuilds are not included.
    console.log(`[afterPack] ${key}: node-pty not included (terminal panel disabled on Linux)`);
    return;
  }

  const unpackedDir = getUnpackedDir(context);
  const prebuildsDir = path.join(unpackedDir, 'node_modules', 'node-pty', 'prebuilds');

  if (!fs.existsSync(prebuildsDir)) {
    console.warn(`[afterPack] node-pty prebuilds not found in unpacked output: ${prebuildsDir}`);
    console.warn(`[afterPack] Check that asarUnpack includes "node_modules/node-pty/prebuilds/**"`);
    return;
  }

  const entries = fs.readdirSync(prebuildsDir, { withFileTypes: true });
  const removed = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === targetDir) {
      // Target platform: strip .pdb debug symbols (Windows only, ~30 MB each)
      const targetPath = path.join(prebuildsDir, entry.name);
      const pdbFiles = fs.readdirSync(targetPath).filter(f => f.endsWith('.pdb'));
      for (const pdb of pdbFiles) {
        fs.rmSync(path.join(targetPath, pdb));
      }
      if (pdbFiles.length > 0) {
        console.log(`[afterPack] ${key}: removed ${pdbFiles.length} .pdb file(s) from node-pty/${targetDir}`);
      }
    } else {
      // Non-target platform: remove entirely
      fs.rmSync(path.join(prebuildsDir, entry.name), { recursive: true });
      removed.push(entry.name);
    }
  }

  if (removed.length > 0) {
    console.log(`[afterPack] ${key}: removed ${removed.length} non-target node-pty prebuild(s): ${removed.join(', ')}`);
  }
  console.log(`[afterPack] ${key}: keeping node-pty prebuilds/${targetDir}`);
}

/**
 * Keep only the Codex native package for the target app architecture and fail
 * early if the required binary is missing. npm installs Codex's native binary
 * through host-filtered optional dependencies, so cross-arch builds must run
 * prepare-binaries first.
 */
function cleanAndValidateCodexNativePackage(context) {
  const platform = context.electronPlatformName;
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${archStr}`;
  const target = CODEX_TARGETS[key];

  if (!target) {
    console.warn(`[afterPack] No Codex native package mapping for ${key}, skipping cleanup`);
    return;
  }

  const unpackedDir = getUnpackedDir(context);
  const openaiDir = path.join(unpackedDir, 'node_modules', '@openai');
  if (!fs.existsSync(openaiDir)) {
    console.warn(`[afterPack] No @openai dir in unpacked output, skipping Codex cleanup`);
    return;
  }

  const targetDir = path.join(openaiDir, target.packageName);
  const targetBinary = path.join(
    targetDir,
    'vendor',
    target.targetTriple,
    'codex',
    target.binaryName
  );

  if (!fs.existsSync(targetBinary)) {
    console.error(`[afterPack] ${key}: missing Codex native binary: ${targetBinary}`);
    console.error(`[afterPack] Run "npm run prepare:all" before cross-platform/cross-arch packaging`);
    throw new Error(`Missing @openai/${target.packageName} native binary for ${key}`);
  }

  const entries = fs.readdirSync(openaiDir, { withFileTypes: true });
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^codex-(darwin|linux|win32)-/.test(entry.name)) continue;
    if (entry.name === target.packageName) continue;

    fs.rmSync(path.join(openaiDir, entry.name), { recursive: true });
    removed.push(entry.name);
  }

  if (removed.length > 0) {
    console.log(`[afterPack] ${key}: removed ${removed.length} non-target Codex package(s): ${removed.join(', ')}`);
  }
  console.log(`[afterPack] ${key}: keeping @openai/${target.packageName}`);
}

/**
 * Ensure all native binaries in the unpacked output have executable permission.
 *
 * npm packages occasionally ship tarballs with missing +x on vendored binaries
 * (e.g. @anthropic-ai/claude-code v2.1.89 lost +x on ripgrep). This causes
 * EACCES at runtime with no fallback, silently breaking core tools like
 * Grep/Glob.
 *
 * Rather than maintaining a list of known-broken packages, we detect native
 * binaries by their file header magic bytes and fix permissions generically:
 *
 *   - ELF:    0x7F 'E' 'L' 'F'          (Linux binaries)
 *   - Mach-O: 0xFEEDFACE / 0xFEEDFACF   (macOS binaries, 32/64-bit)
 *   - Mach-O fat: 0xCAFEBABE / 0xBEBAFECA (universal binaries)
 *
 * Note: Java .class files share the 0xCAFEBABE magic with Mach-O fat binaries.
 * We skip files with a .class extension to avoid false positives (Capacitor
 * Android build artifacts live in the unpacked output).
 *
 * Windows .exe/.dll are not checked — NTFS does not use Unix permission bits.
 *
 * This runs at pack time, so there is zero runtime cost.
 */
function ensureNativeBinaryPermissions(context) {
  if (context.electronPlatformName === 'win32') {
    // Windows does not use Unix permission bits; skip entirely.
    return;
  }

  const unpackedDir = getUnpackedDir(context);
  if (!fs.existsSync(unpackedDir)) {
    console.log('[afterPack] No unpacked directory found, skipping binary permission fix');
    return;
  }

  // Magic bytes that identify native executable formats (non-Windows)
  const MAGIC = {
    ELF:       Buffer.from([0x7F, 0x45, 0x4C, 0x46]),           // \x7FELF
    MACHO_64:  Buffer.from([0xCF, 0xFA, 0xED, 0xFE]),           // Mach-O 64-bit
    MACHO_32:  Buffer.from([0xCE, 0xFA, 0xED, 0xFE]),           // Mach-O 32-bit
    MACHO_FAT: Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]),           // Mach-O fat (universal)
    MACHO_FAT_CIGAM: Buffer.from([0xBE, 0xBA, 0xFE, 0xCA]),     // Mach-O fat (reversed)
  };

  const EXEC_BITS = 0o111; // owner + group + others execute

  function isNativeBinary(filePath) {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const header = Buffer.alloc(4);
      const bytesRead = fs.readSync(fd, header, 0, 4, 0);
      if (bytesRead < 4) return false;

      return Object.values(MAGIC).some(magic => header.equals(magic));
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  const fixed = [];

  function walkDir(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile()) {
        try {
          // Skip Java .class files — they share the 0xCAFEBABE magic with Mach-O fat binaries
          if (entry.name.endsWith('.class')) continue;

          const stat = fs.statSync(fullPath);
          if ((stat.mode & EXEC_BITS) === EXEC_BITS) continue; // already executable
          if (!isNativeBinary(fullPath)) continue;

          fs.chmodSync(fullPath, stat.mode | EXEC_BITS);
          fixed.push(path.relative(unpackedDir, fullPath));
        } catch {
          // Ignore individual file errors (broken symlinks, etc.)
        }
      }
    }
  }

  walkDir(unpackedDir);

  if (fixed.length > 0) {
    console.log(`[afterPack] Fixed executable permissions on ${fixed.length} native binary(ies):`);
    for (const f of fixed) {
      console.log(`  +x ${f}`);
    }
  } else {
    console.log('[afterPack] All native binaries already have executable permissions');
  }
}

module.exports = async function(context) {
  // Clean non-target watcher packages from unpacked output
  cleanNonTargetWatchers(context);

  // Swap better-sqlite3 native binary for the target platform
  swapBetterSqlite3Binary(context);

  // Clean non-target node-pty prebuild directories and strip .pdb files
  cleanNodePtyPrebuilds(context);

  // Ensure the packaged app contains the Codex native binary for this arch.
  cleanAndValidateCodexNativePackage(context);

  // Ensure all native binaries in unpacked output have +x permission.
  // Defends against upstream npm packages shipping broken permissions
  // (e.g. @anthropic-ai/claude-code v2.1.89 ripgrep EACCES bug).
  ensureNativeBinaryPermissions(context);

  // macOS signing (other platforms skip)
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  // Developer ID mode: electron-builder performs real Developer ID signing and
  // notarization in its own later step. Ad-hoc signing here would overwrite that
  // with an unnotarizable signature, so skip it entirely.
  if (process.env.HALO_MAC_SIGN_MODE === 'developer-id') {
    console.log('[afterPack] \u2705 Developer ID signing mode \u2014 skipping ad-hoc; electron-builder will sign & notarize');
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlementsPath = path.join(__dirname, '..', 'resources', 'entitlements.mac.plist');

  console.warn('[afterPack] \u26a0\ufe0f AD-HOC signing (NOT notarized \u2014 will be blocked by macOS 26.5+ Gatekeeper/XProtect)');
  console.log(`[afterPack] Ad-hoc signing: ${appPath}`);

  try {
    // 1. Remove quarantine attribute (if exists)
    try {
      execSync(`xattr -dr com.apple.quarantine "${appPath}"`, { stdio: 'pipe' });
    } catch { }

    // 2. Ad-hoc sign with entitlements
    const codesignCmd = `codesign --force --deep -s - --entitlements "${entitlementsPath}" --timestamp=none "${appPath}"`;
    console.log(`[afterPack] Executing: ${codesignCmd}`);
    execSync(codesignCmd, { stdio: 'inherit' });

    // 3. Verify signature
    console.log('[afterPack] Verifying signature...');
    const verifyOutput = execSync(`codesign -dv "${appPath}" 2>&1`, { encoding: 'utf8' });
    console.log(verifyOutput);

    console.log('[afterPack] Ad-hoc signing complete');
  } catch (error) {
    console.error('[afterPack] Signing failed:', error.message);
    // Don't throw error, let build continue
  }
};
