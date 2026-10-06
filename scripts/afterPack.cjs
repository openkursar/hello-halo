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
// 2. Keep and validate the target platform's better-sqlite3 N-API binary.
//
// 3. Keep only the target platform's @img/sharp-* package (plus its libvips
//    sibling) and fail the build if its prebuilt binary is absent. Same
//    rationale as @parcel/watcher, with an assertion because a missing sharp
//    binary only surfaces at runtime, on the first oversized image.
//
// 4. Ensure executable permissions on all native binaries in the unpacked
//    output. Some npm packages (e.g. @anthropic-ai/claude-code v2.1.89)
//    ship tarballs with missing +x on vendored binaries. This step detects
//    ELF and Mach-O files by magic bytes and adds +x if missing.
//
// 5. macOS ad-hoc signing (prevents "damaged app" prompts on unsigned builds).
// ============================================================================

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ENGINE_RUNTIMES, VALID_ENGINES, entryCandidates, engineArtifactPaths } = require('./engine-runtimes.cjs');
const {
  RUNTIME_DIR,
  RUNTIME_ENTRY,
  EXTERNAL_PACKAGES,
  PRIVATE_EXTERNALS,
  TARGET_PLATFORMS,
  allNativeCompanions,
  nativeCompanionsFor,
} = require('../runtimes/dsh/manifest.cjs');
const { signLocalApp } = require('./lib/mac-local-signing.cjs');
const { assertMacOSDeploymentTargets } = require('./lib/macho-deployment-target.cjs');

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

// Packages that vendor per-platform binaries under vendor/<tool>/{arch}-{platform}/.
// Their runtime resolves paths via `${process.arch}-${process.platform}`, so only
// the target directory is needed; the other 5 platform directories are dead weight.
const ANTHROPIC_VENDOR_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-code',
];

// Maps platform-arch to the cloudflared binary variant stored by
// prepare-binaries.mjs in node_modules/cloudflared/bin/. At runtime the
// cloudflared lib only reads bin/cloudflared (bin/cloudflared.exe on Windows),
// so afterPack installs the target variant under that name and removes the rest.
const CLOUDFLARED_VARIANTS = {
  'darwin-arm64': 'cloudflared',
  'darwin-x64':   'cloudflared-darwin-x64',
  'win32-x64':    'cloudflared.exe',
  'linux-x64':    'cloudflared-linux-x64',
};

// Maps platform-arch to the @img/sharp-* package required at runtime. The
// Claude engines resize oversized images through sharp, which dlopens the
// prebuilt .node from this package; the libvips sibling it declares is resolved
// from the same @img directory and kept alongside it.
const SHARP_TARGETS = {
  'darwin-arm64': 'sharp-darwin-arm64',
  'darwin-x64':   'sharp-darwin-x64',
  'win32-x64':    'sharp-win32-x64',
  'linux-x64':    'sharp-linux-x64',
};

// Maps platform-arch to the @openai/codex native package required at runtime.
const CODEX_TARGETS = {
  'darwin-arm64': { packageName: 'codex-darwin-arm64', targetTriple: 'aarch64-apple-darwin', binaryName: 'codex' },
  'darwin-x64':   { packageName: 'codex-darwin-x64', targetTriple: 'x86_64-apple-darwin', binaryName: 'codex' },
  'win32-x64':    { packageName: 'codex-win32-x64', targetTriple: 'x86_64-pc-windows-msvc', binaryName: 'codex.exe' },
  'linux-x64':    { packageName: 'codex-linux-x64', targetTriple: 'x86_64-unknown-linux-musl', binaryName: 'codex' },
};

/**
 * Resolve the app resources directory from electron-builder context.
 *
 * macOS:       <appOutDir>/<ProductName>.app/Contents/Resources
 * win32/linux: <appOutDir>/resources
 */
function getResourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

/**
 * Resolve the app.asar.unpacked directory from electron-builder context.
 */
function getUnpackedDir(context) {
  return path.join(getResourcesDir(context), 'app.asar.unpacked');
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

/** Keep the target's bundled N-API binary, which is independent of Electron ABI. */
async function cleanAndValidateBetterSqlite3Prebuilds(context) {
  const platform = context.electronPlatformName;
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${archStr}`;
  const { getBetterSqlite3PrebuildPath, validateBetterSqlite3Prebuild } = await import('./lib/better-sqlite3-prebuilds.mjs');
  const target = { platform, arch: archStr };
  const prebuild = getBetterSqlite3PrebuildPath(getUnpackedDir(context), target);
  const validation = validateBetterSqlite3Prebuild(prebuild, target);
  if (!validation.valid) {
    throw new Error(`[afterPack] Invalid bundled better-sqlite3 N-API binary for ${key}: ${validation.reason}. Check the prebuilds asarUnpack rule.`);
  }
  for (const entry of fs.readdirSync(path.dirname(prebuild))) {
    if (entry !== `${key}.node`) fs.rmSync(path.join(path.dirname(prebuild), entry), { recursive: true, force: true });
  }
  console.log(`[afterPack] ${key}: validated better-sqlite3 N-API binary (${(validation.size / 1024 / 1024).toFixed(1)} MB)`);
}

/**
 * Install the dsh runtime's own node_modules into the packaged output.
 *
 * electron-builder drops `node_modules` directories it finds under a `files`
 * glob — it collects node_modules from the dependency graph instead — so the
 * tree `runtimes/dsh/build.mjs` plants beside the bundle (private
 * externals with their dependencies, native companions for every platform)
 * never reaches the artifact on its own. It is copied from the project here,
 * minus the native companions of other platforms.
 */
function installDshPrivateExternals(context) {
  const projectRoot = path.resolve(__dirname, '..');
  const runtimeSegments = RUNTIME_DIR.split('/');
  const srcModules = path.join(projectRoot, ...runtimeSegments, 'node_modules');
  const destRuntimeDir = path.join(getUnpackedDir(context), ...runtimeSegments);

  if (!fs.existsSync(destRuntimeDir)) {
    console.log('[afterPack] dsh runtime bundle not in the unpacked output, skipping its node_modules');
    return;
  }
  if (!fs.existsSync(srcModules)) {
    throw new Error(`[afterPack] dsh runtime has no node_modules at ${srcModules}. Run "npm run runtime:dsh".`);
  }

  const key = `${context.electronPlatformName}-${ARCH_NAMES[context.arch] || String(context.arch)}`;
  if (!TARGET_PLATFORMS.includes(key)) {
    throw new Error(`[afterPack] no dsh native companion mapping for ${key} in runtimes/dsh/manifest.cjs`);
  }
  const keep = new Set(nativeCompanionsFor(key));
  const skip = new Set(allNativeCompanions().filter(name => !keep.has(name)));

  const destModules = path.join(destRuntimeDir, 'node_modules');
  fs.cpSync(srcModules, destModules, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const segments = path.relative(srcModules, src).split(path.sep);
      const name = segments[0].startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
      return !skip.has(name);
    },
  });
  console.log(
    `[afterPack] ${key}: dsh runtime node_modules installed ` +
    `(private: ${PRIVATE_EXTERNALS.map(e => e.name).join(', ')}; native: ${[...keep].join(', ') || 'none'})`
  );
}

/**
 * Prune the dsh runtime's private node-pty to what the target loads.
 *
 * The copy runtimes/dsh/build.mjs plants beside the bundle carries every
 * platform's prebuilds plus the sources node-pty compiles itself from. It is
 * pruned here, separately from the app's own node-pty (cleanNodePtyPrebuilds),
 * so dsh packaging cannot change what Halo's terminal ships.
 */
function cleanDshRuntimeNodePty(context) {
  const key = `${context.electronPlatformName}-${ARCH_NAMES[context.arch] || String(context.arch)}`;
  const pkgDir = path.join(getUnpackedDir(context), ...RUNTIME_DIR.split('/'), 'node_modules', 'node-pty');
  if (!fs.existsSync(pkgDir)) return;

  const prebuildsDir = path.join(pkgDir, 'prebuilds');
  const targetDir = NODE_PTY_PREBUILD_TARGETS[key];
  if (fs.existsSync(prebuildsDir)) {
    for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(prebuildsDir, entry.name);
      if (entry.name !== targetDir) {
        fs.rmSync(entryPath, { recursive: true });
        continue;
      }
      for (const pdb of fs.readdirSync(entryPath).filter(f => f.endsWith('.pdb'))) {
        fs.rmSync(path.join(entryPath, pdb));
      }
    }
  }
  // Sources and toolchain files node-pty needs only to compile itself; the
  // runtime loads `prebuilds/<platform>-<arch>/`, which carries its own conpty.
  for (const entry of ['build', 'src', 'deps', 'node-addon-api', 'third_party', 'scripts', 'typings', 'binding.gyp']) {
    fs.rmSync(path.join(pkgDir, entry), { recursive: true, force: true });
  }
  console.log(`[afterPack] ${key}: dsh runtime node-pty pruned to prebuilds/${targetDir ?? '(none)'}`);
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

  // The ConPTY runtime ships one directory per Windows architecture; only the
  // target's is ever loaded.
  const conptyRoot = path.join(unpackedDir, 'node_modules', 'node-pty', 'third_party', 'conpty');
  if (platform === 'win32' && fs.existsSync(conptyRoot)) {
    for (const release of fs.readdirSync(conptyRoot)) {
      const releaseDir = path.join(conptyRoot, release);
      if (!fs.statSync(releaseDir).isDirectory()) continue;
      for (const archDir of fs.readdirSync(releaseDir)) {
        if (archDir === `win10-${archStr}`) continue;
        fs.rmSync(path.join(releaseDir, archDir), { recursive: true });
        console.log(`[afterPack] ${key}: removed non-target node-pty conpty/${release}/${archDir}`);
      }
    }
  }

  // build/ and bin/ hold binaries compiled for the build host. node-pty tries
  // build/ before prebuilds/, so in a package for another platform or chip they
  // are dead weight that fails to load before the matching prebuild is found.
  const hostKey = `${process.platform}-${process.arch}`;
  if (hostKey !== key) {
    for (const dir of ['build', 'bin']) {
      const hostBuilt = path.join(unpackedDir, 'node_modules', 'node-pty', dir);
      if (!fs.existsSync(hostBuilt)) continue;
      fs.rmSync(hostBuilt, { recursive: true });
      console.log(`[afterPack] ${key}: removed node-pty/${dir} (compiled for build host ${hostKey})`);
    }
  }
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
 * Keep only the target platform's @img/sharp-* package (and the libvips sibling
 * it declares) in the unpacked output, and fail the build when its prebuilt
 * binary is missing.
 *
 * The binary must live outside the asar archive: a .node cannot be dlopened
 * from inside the archive, and sharp's only fallback is to give up, which
 * surfaces to the user as "Unable to resize image" on any oversized image.
 */
function cleanAndValidateSharpNativePackage(context) {
  const platform = context.electronPlatformName;
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${archStr}`;
  const targetPkg = SHARP_TARGETS[key];

  if (!targetPkg) {
    console.warn(`[afterPack] No sharp package mapping for ${key}, skipping cleanup`);
    return;
  }

  const unpackedDir = getUnpackedDir(context);
  const imgDir = path.join(unpackedDir, 'node_modules', '@img');
  const targetDir = path.join(imgDir, targetPkg);
  const targetLibDir = path.join(targetDir, 'lib');

  const hasBinary = fs.existsSync(targetLibDir)
    && fs.readdirSync(targetLibDir).some(f => f.endsWith('.node'));

  if (!hasBinary) {
    console.error(`[afterPack] ${key}: missing sharp native binary: ${targetLibDir}`);
    console.error(`[afterPack] Run "npm run prepare:all" before cross-platform/cross-arch packaging`);
    console.error(`[afterPack] Also check that asarUnpack includes "node_modules/@img/**/*"`);
    throw new Error(`Missing @img/${targetPkg} native binary for ${key}`);
  }

  // The .node links against libvips through an @rpath/RUNPATH pointing at a
  // sibling directory under @img, so the sibling must survive the cleanup.
  const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8'));
  const siblings = Object.keys(manifest.optionalDependencies || {}).map(dep => dep.split('/').pop());

  const missingSiblings = siblings.filter(name => !fs.existsSync(path.join(imgDir, name, 'lib')));
  if (missingSiblings.length > 0) {
    console.error(`[afterPack] ${key}: @img/${targetPkg} needs ${missingSiblings.join(', ')}, not in the unpacked output`);
    console.error(`[afterPack] Run "npm run prepare:all" to install the libvips sibling`);
    throw new Error(`Missing libvips package(s) for ${key}: ${missingSiblings.join(', ')}`);
  }

  const keep = new Set([targetPkg, ...siblings]);
  const removed = [];
  for (const entry of fs.readdirSync(imgDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (keep.has(entry.name)) continue;

    fs.rmSync(path.join(imgDir, entry.name), { recursive: true });
    removed.push(entry.name);
  }

  if (removed.length > 0) {
    console.log(`[afterPack] ${key}: removed ${removed.length} non-target sharp package(s): ${removed.join(', ')}`);
  }
  console.log(`[afterPack] ${key}: keeping ${[...keep].map(name => `@img/${name}`).join(', ')}`);
}

/**
 * Identify an executable's target platform-arch from its file header.
 * Returns a `${platform}-${arch}` key (win32/linux assume x64, matching the
 * only shipped targets) or null if unrecognized.
 */
function detectExecutableTarget(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(8);
    if (fs.readSync(fd, header, 0, 8, 0) < 8) return null;

    // ELF: 0x7F 'E' 'L' 'F'
    if (header[0] === 0x7F && header[1] === 0x45 && header[2] === 0x4C && header[3] === 0x46) {
      return 'linux-x64';
    }
    // PE: 'M' 'Z'
    if (header[0] === 0x4D && header[1] === 0x5A) {
      return 'win32-x64';
    }
    // Mach-O 64-bit LE: CF FA ED FE, cputype at offset 4
    if (header[0] === 0xCF && header[1] === 0xFA && header[2] === 0xED && header[3] === 0xFE) {
      const cpuType = header.readUInt32LE(4);
      if (cpuType === 0x0100000C) return 'darwin-arm64';
      if (cpuType === 0x01000007) return 'darwin-x64';
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Keep only the target {arch}-{platform} directory in the vendored binary
 * trees of @anthropic-ai/claude-agent-sdk and @anthropic-ai/claude-code
 * (vendor/ripgrep, vendor/audio-capture). Non-directory files (e.g. COPYING)
 * are preserved.
 */
function cleanAnthropicVendorBinaries(context) {
  const platform = context.electronPlatformName;
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const targetDir = `${archStr}-${platform}`;

  const unpackedDir = getUnpackedDir(context);

  for (const pkg of ANTHROPIC_VENDOR_PACKAGES) {
    const vendorDir = path.join(unpackedDir, 'node_modules', pkg, 'vendor');
    if (!fs.existsSync(vendorDir)) {
      console.warn(`[afterPack] No vendor dir for ${pkg} in unpacked output, skipping cleanup`);
      continue;
    }

    const removed = [];
    let targetFound = false;

    for (const tool of fs.readdirSync(vendorDir, { withFileTypes: true })) {
      if (!tool.isDirectory()) continue;
      const toolDir = path.join(vendorDir, tool.name);

      for (const entry of fs.readdirSync(toolDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === targetDir) {
          targetFound = true;
          continue;
        }
        fs.rmSync(path.join(toolDir, entry.name), { recursive: true });
        removed.push(`${tool.name}/${entry.name}`);
      }
    }

    if (!targetFound) {
      console.warn(`[afterPack] ${pkg}: no ${targetDir} vendor binaries found in unpacked output`);
    }
    console.log(`[afterPack] ${pkg}: removed ${removed.length} non-target vendor dir(s), keeping */${targetDir}`);
  }
}

/**
 * Install the target-platform cloudflared binary under its runtime name and
 * remove all other variants.
 *
 * prepare-binaries.mjs stores per-platform variants in the project's
 * node_modules/cloudflared/bin/ (see CLOUDFLARED_VARIANTS). The copy goes from
 * the project node_modules (source of truth) into the unpacked output, so the
 * result is deterministic regardless of which variants electron-builder packed.
 * Returns the installed binary path, or null when the target has no variant.
 */
function installCloudflaredBinary(context) {
  const platform = context.electronPlatformName;
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${archStr}`;
  const variant = CLOUDFLARED_VARIANTS[key];

  if (!variant) {
    console.warn(`[afterPack] No cloudflared variant mapping for ${key}, skipping`);
    return null;
  }

  const projectRoot = path.resolve(__dirname, '..');
  const srcBinary = path.join(projectRoot, 'node_modules/cloudflared/bin', variant);

  if (!fs.existsSync(srcBinary) || fs.statSync(srcBinary).size < 10 * 1024 * 1024) {
    console.error(`[afterPack] ${key}: missing or invalid cloudflared binary: ${srcBinary}`);
    console.error(`[afterPack] Run "npm run prepare:all" to download cloudflared for all platforms`);
    throw new Error(`Missing cloudflared binary for ${key}`);
  }

  // Arch/format check via magic bytes. Local bin/ files can be polluted by
  // manual swaps (e.g. an x64 binary left under the arm64 name), which would
  // otherwise ship silently and break tunnels on the target machine.
  const detected = detectExecutableTarget(srcBinary);
  if (detected !== key) {
    console.error(`[afterPack] ${key}: cloudflared binary is ${detected || 'unrecognized'}: ${srcBinary}`);
    console.error(`[afterPack] Delete it and run "npm run prepare:all" to re-download`);
    throw new Error(`cloudflared binary mismatch for ${key} (got ${detected || 'unknown'})`);
  }

  const runtimeName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const destDir = path.join(getUnpackedDir(context), 'node_modules', 'cloudflared', 'bin');
  fs.mkdirSync(destDir, { recursive: true });

  fs.copyFileSync(srcBinary, path.join(destDir, runtimeName));
  if (platform !== 'win32') {
    fs.chmodSync(path.join(destDir, runtimeName), 0o755);
  }

  const removed = [];
  for (const entry of fs.readdirSync(destDir)) {
    if (entry === runtimeName) continue;
    if (!entry.startsWith('cloudflared')) continue;
    fs.rmSync(path.join(destDir, entry), { recursive: true });
    removed.push(entry);
  }

  const sizeMB = (fs.statSync(path.join(destDir, runtimeName)).size / 1024 / 1024).toFixed(1);
  console.log(`[afterPack] ${key}: installed cloudflared as bin/${runtimeName} (${sizeMB} MB)` +
    (removed.length > 0 ? `, removed ${removed.length} variant(s): ${removed.join(', ')}` : ''));
  return path.join(destDir, runtimeName);
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

// ============================================================================
// Packaged artifact assertions
//
// Everything above operates on files the build machine happened to have. These
// checks read the artifact itself and refuse to hand back a package that is
// missing something the app needs at runtime — the only place that can catch a
// dependency which was installed but excluded from the package, or never
// installed at all because it was optional.
// ============================================================================

/**
 * Reader over the packaged app, whether it was written as an asar archive or a
 * plain directory. `exists` also consults app.asar.unpacked, since asarUnpack
 * moves matching files out of the archive.
 */
function createPackageReader(context) {
  const resourcesDir = getResourcesDir(context);
  const asarPath = path.join(resourcesDir, 'app.asar');
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');

  if (!fs.existsSync(asarPath)) {
    const appDir = path.join(resourcesDir, 'app');
    if (!fs.existsSync(appDir)) {
      throw new Error(`[afterPack] Packaged app not found (looked for ${asarPath} and ${appDir})`);
    }
    return {
      exists: (relPath) => fs.existsSync(path.join(appDir, relPath)),
      read: (relPath) => fs.readFileSync(path.join(appDir, relPath)),
    };
  }

  const asar = require('@electron/asar');
  // listPackage builds entries with path.join, so on Windows they use
  // backslashes — normalize to forward slashes for lookups.
  const entries = new Set(
    asar.listPackage(asarPath).map(entry => entry.replace(/^[\\/]/, '').split(path.sep).join('/'))
  );

  return {
    exists: (relPath) => {
      const normalized = relPath.split(path.sep).join('/');
      return entries.has(normalized) || fs.existsSync(path.join(unpackedDir, relPath));
    },
    read: (relPath) => {
      const unpacked = path.join(unpackedDir, relPath);
      if (fs.existsSync(unpacked)) return fs.readFileSync(unpacked);
      // extractFile traverses the archive tree by splitting on path.sep, so it
      // needs the platform-native relPath, not a forward-slash one.
      return asar.extractFile(asarPath, relPath);
    },
  };
}

/**
 * Engines the artifact must contain, from HALO_REQUIRE_ENGINES (comma
 * separated). Release scripts set it; ad-hoc builds leave it unset and only get
 * an inventory report.
 */
function getRequiredEngines() {
  const raw = process.env.HALO_REQUIRE_ENGINES;
  if (!raw) return [];
  const requested = raw.split(',').map(e => e.trim()).filter(Boolean);
  const unknown = requested.filter(e => !VALID_ENGINES.includes(e));
  if (unknown.length > 0) {
    throw new Error(
      `[afterPack] HALO_REQUIRE_ENGINES names unknown engine(s): ${unknown.join(', ')}. ` +
      `Valid engines: ${VALID_ENGINES.join(', ')}`
    );
  }
  return requested;
}

function validateEngineRuntimes(pkg) {
  const required = getRequiredEngines();
  const missing = [];

  for (const engineId of VALID_ENGINES) {
    const engine = ENGINE_RUNTIMES[engineId];
    const { name, fix } = engine;
    const { pkgDir, manifestPath, entryPaths, label } = engineArtifactPaths(engine);

    let reason = null;
    if (!pkg.exists(manifestPath)) {
      reason = engine.prebuilt ? 'prebuilt runtime not in the artifact' : 'package not in the artifact';
    } else {
      const manifest = JSON.parse(pkg.read(manifestPath).toString('utf-8'));
      const candidates = entryPaths
        ?? entryCandidates(manifest).map(candidate => path.join(pkgDir, candidate));
      const entry = candidates.find(candidate => pkg.exists(candidate));
      if (!entry) {
        reason = 'present but its entry file was excluded';
      } else {
        console.log(`[afterPack] Engine bundled: ${name} v${manifest.version ?? 'unknown'}`);
      }
    }

    if (!reason) continue;
    if (required.includes(engineId)) {
      missing.push(`${name} (${label}): ${reason}. Fix: ${fix}`);
    } else {
      console.log(`[afterPack] Engine not bundled: ${name} — ${reason} (not required by this build)`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      '[afterPack] Required agent engine(s) are missing from the packaged app:\n  ' +
      missing.join('\n  ')
    );
  }
}

/**
 * `app-update.yml` is written by electron-builder only when a publish target is
 * configured. Without it electron-updater can check for updates but fails to
 * download them, so a build that advertises updates must carry the file.
 */
function validateUpdaterConfig(context) {
  const publish = context.packager.config && context.packager.config.publish;
  const configured = Array.isArray(publish) ? publish.length > 0 : Boolean(publish);
  if (!configured) {
    console.log('[afterPack] No publish target configured — skipping app-update.yml check');
    return;
  }

  const updateConfigPath = path.join(getResourcesDir(context), 'app-update.yml');
  if (!fs.existsSync(updateConfigPath)) {
    throw new Error(
      '[afterPack] A publish target is configured but app-update.yml is missing from resources. ' +
      'Auto-update would fail at download time with ENOENT.'
    );
  }
  console.log('[afterPack] app-update.yml present');
}

/**
 * product.json drives auth providers and data-folder isolation. When it is
 * absent the app silently falls back to open-source defaults, which strips
 * every enterprise login option from the setup screen.
 */
function validateProductConfig(pkg) {
  if (!pkg.exists('product.json')) {
    throw new Error('[afterPack] product.json is missing from the packaged app');
  }

  const product = JSON.parse(pkg.read('product.json').toString('utf-8'));
  if (!Array.isArray(product.authProviders) || product.authProviders.length === 0) {
    throw new Error('[afterPack] product.json in the packaged app declares no authProviders');
  }
  console.log(
    `[afterPack] product.json present (dataFolderName=${product.dataFolderName ?? 'halo'}, ` +
    `authProviders=${product.authProviders.length})`
  );
  return product;
}

/**
 * A staged Windows build without its helper does not fail: the runtime quietly
 * falls back to the installer path, so nobody notices the fast path is gone.
 * The helper arrives via win.extraResources, which copies nothing — silently —
 * when the helper was never compiled. Mirrors getWindowsUpdateMode's rule for
 * when staged is actually in effect.
 */
function validateUpdateHelper(context, product) {
  if (context.electronPlatformName !== 'win32') return;
  const update = product.updateConfig ?? {};
  if (update.windowsMode !== 'staged' || !update.manifestPublicKey?.trim()) return;

  const helperPath = path.join(getResourcesDir(context), 'update-helper', 'halo-update-helper.exe');
  if (!fs.existsSync(helperPath)) {
    throw new Error(
      '[afterPack] product.json enables staged Windows updates but update-helper/halo-update-helper.exe ' +
      'is missing from resources. Fix: node scripts/build-update-helper.mjs'
    );
  }
  console.log('[afterPack] Windows update helper present');
}

/**
 * Assert the dsh runtime can load in the packaged app: its entry, every
 * external it imports (all carried beside it, never the app's), and the
 * target's native companions.
 */
function validateDshRuntimeBundle(context) {
  const runtimeDir = path.join(getUnpackedDir(context), ...RUNTIME_DIR.split('/'));

  if (!fs.existsSync(runtimeDir)) {
    console.log('[afterPack] dsh runtime bundle not in the unpacked output — skipping bundle check');
    return;
  }

  const entry = path.join(runtimeDir, ...RUNTIME_ENTRY.split('/'));
  if (!fs.existsSync(entry)) {
    throw new Error(
      `[afterPack] dsh runtime directory is present but its entry is missing: ${entry}. ` +
      `Check that asarUnpack covers "${RUNTIME_DIR}/**/*".`
    );
  }

  const key = `${context.electronPlatformName}-${ARCH_NAMES[context.arch] || String(context.arch)}`;
  const missing = [...EXTERNAL_PACKAGES, ...nativeCompanionsFor(key)].filter(
    name => !fs.existsSync(path.join(runtimeDir, 'node_modules', ...name.split('/'), 'package.json'))
  );
  if (missing.length > 0) {
    throw new Error(
      `[afterPack] ${key}: dsh runtime is missing ${missing.join(', ')} beside its bundle. ` +
      `Run "npm run runtime:dsh" and check installDshPrivateExternals.`
    );
  }

  const sizeMB = (fs.statSync(entry).size / 1024 / 1024).toFixed(1);
  console.log(`[afterPack] ${key}: dsh runtime bundle present (${sizeMB} MB)`);
}

function validatePackagedArtifact(context) {
  console.log('[afterPack] Validating packaged artifact...');
  const pkg = createPackageReader(context);
  validateEngineRuntimes(pkg);
  const product = validateProductConfig(pkg);
  validateUpdaterConfig(context);
  validateUpdateHelper(context, product);
  console.log('[afterPack] Packaged artifact validation passed');
}

module.exports = async function(context) {
  // Clean non-target watcher packages from unpacked output
  cleanNonTargetWatchers(context);

  await cleanAndValidateBetterSqlite3Prebuilds(context);

  // Give the dsh bundle its own node_modules and native companions for this
  // target, then prune its private node-pty. None of this touches packages the
  // rest of the app uses.
  installDshPrivateExternals(context);
  cleanDshRuntimeNodePty(context);

  // Clean non-target node-pty prebuild directories and strip .pdb files
  cleanNodePtyPrebuilds(context);

  // Ensure the packaged app contains the Codex native binary for this arch.
  cleanAndValidateCodexNativePackage(context);

  // Ensure the packaged app contains the sharp native binary for this arch.
  cleanAndValidateSharpNativePackage(context);

  // Keep only target-platform binaries in @anthropic-ai vendored trees.
  cleanAnthropicVendorBinaries(context);

  // Install the target cloudflared binary under its runtime name.
  const cloudflaredBinary = installCloudflaredBinary(context);

  // Ensure all native binaries in unpacked output have +x permission.
  // Defends against upstream npm packages shipping broken permissions
  // (e.g. @anthropic-ai/claude-code v2.1.89 ripgrep EACCES bug).
  ensureNativeBinaryPermissions(context);

  // Last gate before the artifact leaves the packer: assert it actually
  // contains the engines, product config and updater metadata it needs.
  // Throwing here fails the build, which is the point — a broken package must
  // never reach a user.
  validateDshRuntimeBundle(context);

  validatePackagedArtifact(context);

  // macOS signing (other platforms skip)
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const nativeAppPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const { CLOUDFLARED_MINIMUM_MACOS } = await import('./lib/cloudflared.mjs');
  const helperFloors = cloudflaredBinary ? { [cloudflaredBinary]: CLOUDFLARED_MINIMUM_MACOS } : {};
  const nativeTargets = assertMacOSDeploymentTargets(nativeAppPath, undefined, helperFloors);
  console.log(`[afterPack] Verified macOS 12 deployment targets for ${nativeTargets.length} native binaries` +
    (cloudflaredBinary ? ` (cloudflared: macOS ${CLOUDFLARED_MINIMUM_MACOS})` : ''));

  // Developer ID mode: electron-builder performs real Developer ID signing and
  // notarization in its own later step. Ad-hoc signing here would overwrite that
  // with an unnotarizable signature, so skip it entirely.
  if (process.env.HALO_MAC_SIGN_MODE === 'developer-id') {
    console.log('[afterPack] \u2705 Developer ID signing mode \u2014 skipping ad-hoc; electron-builder will sign & notarize');
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlementsPath = path.join(__dirname, '..', 'resources', 'entitlements.mac.plist');

  console.log('[afterPack] Local ad-hoc signing (no Developer ID or notarization required for local development)');
  console.log(`[afterPack] Ad-hoc signing: ${appPath}`);

  try {
    // 1. Remove quarantine attribute (if exists)
    try {
      execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appPath], { stdio: 'pipe' });
    } catch (error) {
      if (!String(error.stderr).includes('No such xattr')) throw error;
      console.log('[afterPack] No quarantine attribute to remove');
    }

    signLocalApp(appPath, entitlementsPath);

    console.log('[afterPack] Ad-hoc signing complete');
  } catch (error) {
    console.error('[afterPack] Signing failed:', error.message);
    throw error;
  }
};
