// ============================================================================
// native-modules.cjs - Platform-specific native module management
//
// Problem:
//   electron-builder filters native addons (.node files) by the build machine's
//   platform. When cross-compiling (e.g. building Windows on macOS), it packs
//   the build machine's native module instead of the target's.
//
// Solution:
//   Before packing, move non-target native modules to a backup directory so
//   electron-builder only sees the correct one. After packing, restore them
//   for subsequent platform builds.
//
// Usage (called by beforePack.cjs / afterPack.cjs):
//   const nativeModules = require('./native-modules.cjs');
//   nativeModules.prepare(projectRoot, 'win32', 1);   // beforePack
//   nativeModules.restore(projectRoot);                // afterPack
// ============================================================================

const fs = require('fs');
const path = require('path');

const BACKUP_DIR = '.native-modules-backup';

// electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

// ============================================================================
// Native module registry
//
// Each entry describes a set of platform-specific packages under a npm scope.
// To add a new native module, add an entry here - no other changes needed.
// ============================================================================

const REGISTRY = [
  {
    // @parcel/watcher ships one npm package per platform, each containing a
    // pre-built .node binary. At runtime, the main @parcel/watcher package
    // does: require(`@parcel/watcher-${process.platform}-${process.arch}`)
    scope: '@parcel',
    prefix: 'watcher-',
    resolve: (platform, arch) => ({
      'darwin-arm64':  'watcher-darwin-arm64',
      'darwin-x64':    'watcher-darwin-x64',
      'win32-x64':     'watcher-win32-x64',
      'linux-x64':     'watcher-linux-x64-glibc',
    })[`${platform}-${arch}`] || null,
  },
];

// ============================================================================
// Public API
// ============================================================================

/**
 * Prepare native modules for the target platform.
 *
 * 1. Restores any leftover backup (from a previous interrupted build)
 * 2. Validates the target package exists
 * 3. Moves all non-target packages to backup
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {string} electronPlatformName - 'darwin' | 'win32' | 'linux'
 * @param {number} arch - electron-builder Arch enum value
 */
function prepare(projectRoot, electronPlatformName, arch) {
  const archStr = ARCH_NAMES[arch] || String(arch);
  const backupRoot = path.join(projectRoot, 'node_modules', BACKUP_DIR);

  // Safety: restore any leftover backup from an interrupted build
  restore(projectRoot);

  const moved = [];

  for (const entry of REGISTRY) {
    const targetName = entry.resolve(electronPlatformName, archStr);
    if (!targetName) {
      throw new Error(
        `[native-modules] No mapping for ${entry.scope}/${entry.prefix}* ` +
        `on ${electronPlatformName}-${archStr}. Update the registry in native-modules.cjs.`
      );
    }

    const scopeDir = path.join(projectRoot, 'node_modules', entry.scope);
    if (!fs.existsSync(scopeDir)) continue;

    // Validate target package exists
    const targetPath = path.join(scopeDir, targetName);
    if (!fs.existsSync(targetPath)) {
      throw new Error(
        `[native-modules] Required package not found: ${entry.scope}/${targetName}\n` +
        `  Run "npm run prepare:all" to install platform-specific binaries.`
      );
    }

    // Move non-target packages to backup
    const entries = fs.readdirSync(scopeDir, { withFileTypes: true });
    for (const item of entries) {
      if (!item.isDirectory()) continue;
      if (!item.name.startsWith(entry.prefix)) continue;
      if (item.name === targetName) continue;

      const src = path.join(scopeDir, item.name);
      const backupScopeDir = path.join(backupRoot, entry.scope);
      const dest = path.join(backupScopeDir, item.name);

      fs.mkdirSync(backupScopeDir, { recursive: true });
      fs.renameSync(src, dest);
      // Leave empty directory so electron-builder's scandir doesn't ENOENT
      fs.mkdirSync(src);
      moved.push(`${entry.scope}/${item.name}`);
    }

    console.log(`[native-modules] ${electronPlatformName}-${archStr}: keeping ${entry.scope}/${targetName}`);
  }

  if (moved.length > 0) {
    console.log(`[native-modules] Backed up ${moved.length} non-target package(s): ${moved.join(', ')}`);
  }
}

/**
 * Restore all backed-up native modules to their original locations.
 * Safe to call even when no backup exists (no-op).
 *
 * @param {string} projectRoot - Absolute path to project root
 */
function restore(projectRoot) {
  const backupRoot = path.join(projectRoot, 'node_modules', BACKUP_DIR);
  if (!fs.existsSync(backupRoot)) return;

  let restored = 0;

  const scopes = fs.readdirSync(backupRoot, { withFileTypes: true });
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;

    const backupScopeDir = path.join(backupRoot, scope.name);
    const targetScopeDir = path.join(projectRoot, 'node_modules', scope.name);

    const packages = fs.readdirSync(backupScopeDir, { withFileTypes: true });
    for (const pkg of packages) {
      if (!pkg.isDirectory()) continue;

      const src = path.join(backupScopeDir, pkg.name);
      const dest = path.join(targetScopeDir, pkg.name);

      // Remove destination if it somehow already exists
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true });
      }

      fs.renameSync(src, dest);
      restored++;
    }
  }

  // Clean up backup directory
  fs.rmSync(backupRoot, { recursive: true });

  if (restored > 0) {
    console.log(`[native-modules] Restored ${restored} package(s) from backup`);
  }
}

module.exports = { prepare, restore };
