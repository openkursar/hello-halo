#!/usr/bin/env node

/**
 * Auto-detect and download missing binary dependencies
 *
 * Usage:
 *   node scripts/prepare-binaries.mjs                    # Auto-detect current platform
 *   node scripts/prepare-binaries.mjs --platform all     # Download for all platforms
 *   node scripts/prepare-binaries.mjs --platform mac-arm64
 *
 * This script checks for missing binaries and downloads them automatically.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

// ANSI colors
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
}

const log = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[OK]${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}[ERROR]${colors.reset} ${msg}`)
}

// Cloudflared download URLs
const CLOUDFLARED_URLS = {
  'mac-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
  'mac-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
  'win': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'linux': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64'
}

// Cloudflared output paths
const CLOUDFLARED_PATHS = {
  'mac-arm64': 'node_modules/cloudflared/bin/cloudflared',
  'mac-x64': 'node_modules/cloudflared/bin/cloudflared-darwin-x64',
  'win': 'node_modules/cloudflared/bin/cloudflared.exe',
  'linux': 'node_modules/cloudflared/bin/cloudflared-linux-x64'
}

// Portable Git self-extracting archive, bundled into the Windows build so
// Git Bash setup works on offline/intranet machines (git-bash/installer.ts
// extracts it locally instead of downloading). Globbed by filename pattern at
// runtime, so bumping the version here is enough.
const PORTABLE_GIT_VERSION = '2.47.1'
const PORTABLE_GIT_FILENAME = `PortableGit-${PORTABLE_GIT_VERSION}-64-bit.7z.exe`
const PORTABLE_GIT_DEST = `resources/git-bash/${PORTABLE_GIT_FILENAME}`
const PORTABLE_GIT_URLS = [
  `https://registry.npmmirror.com/-/binary/git-for-windows/v${PORTABLE_GIT_VERSION}.windows.1/${PORTABLE_GIT_FILENAME}`,
  `https://mirrors.huaweicloud.com/git-for-windows/v${PORTABLE_GIT_VERSION}.windows.1/${PORTABLE_GIT_FILENAME}`,
  `https://github.com/git-for-windows/git/releases/download/v${PORTABLE_GIT_VERSION}.windows.1/${PORTABLE_GIT_FILENAME}`
]

// @parcel/watcher packages per platform
const WATCHER_PACKAGES = {
  'mac-arm64': '@parcel/watcher-darwin-arm64',
  'mac-x64': '@parcel/watcher-darwin-x64',
  'win': '@parcel/watcher-win32-x64',
  'linux': '@parcel/watcher-linux-x64-glibc'
}

// @openai/codex platform packages. npm only installs the current host's
// optional dependency, so cross-arch packaging must fetch the target package.
const CODEX_PACKAGES = {
  'mac-arm64': { pkg: '@openai/codex-darwin-arm64', targetTriple: 'aarch64-apple-darwin', binary: 'codex' },
  'mac-x64': { pkg: '@openai/codex-darwin-x64', targetTriple: 'x86_64-apple-darwin', binary: 'codex' },
  'win': { pkg: '@openai/codex-win32-x64', targetTriple: 'x86_64-pc-windows-msvc', binary: 'codex.exe' },
  'linux': { pkg: '@openai/codex-linux-x64', targetTriple: 'x86_64-unknown-linux-musl', binary: 'codex' }
}

// @img/sharp-* prebuilt binaries, used by the Claude engines to downscale
// oversized images before sending them to a model. Declared as optional
// dependencies of @anthropic-ai/claude-code, so npm installs the host's package
// only and a cross-platform build would ship none — the app then fails on any
// image wider than the model limit with "Unable to resize image".
// Each package pulls its libvips sibling from its own optionalDependencies
// (win32 has none: the DLLs are inside the package).
const SHARP_PACKAGES = {
  'mac-arm64': '@img/sharp-darwin-arm64',
  'mac-x64': '@img/sharp-darwin-x64',
  'win': '@img/sharp-win32-x64',
  'linux': '@img/sharp-linux-x64'
}

// better-sqlite3 prebuild configuration
// Prebuilds are platform-specific .node binaries downloaded from GitHub releases.
// They are stored in node_modules/better-sqlite3/prebuilds/{os}-{arch}/ and
// swapped into the packaged app by afterPack.cjs during electron-builder packaging.
const BETTER_SQLITE3_PREBUILDS_DIR = 'node_modules/better-sqlite3/prebuilds'
const BETTER_SQLITE3_PLATFORMS = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64' },
  'mac-x64': { platform: 'darwin', arch: 'x64' },
  'win': { platform: 'win32', arch: 'x64' },
  'linux': { platform: 'linux', arch: 'x64' }
}

/**
 * Detect current platform
 */
function detectPlatform() {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  } else if (platform === 'win32') {
    return 'win'
  } else if (platform === 'linux') {
    return 'linux'
  }
  return null
}

/**
 * Validate binary format by reading file header magic bytes.
 * Returns the detected platform kind or null if unrecognized.
 */
function detectBinaryPlatform(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const header = Buffer.alloc(16)
    fs.readSync(fd, header, 0, 16, 0)

    // ELF (Linux): 0x7F 'E' 'L' 'F'
    if (header[0] === 0x7F && header[1] === 0x45 && header[2] === 0x4C && header[3] === 0x46) {
      return 'linux'
    }

    // PE / Windows: 'M' 'Z'
    if (header[0] === 0x4D && header[1] === 0x5A) {
      return 'win'
    }

    // Mach-O 64-bit: 0xFEEDFACF (little-endian: CF FA ED FE)
    if (header[0] === 0xCF && header[1] === 0xFA && header[2] === 0xED && header[3] === 0xFE) {
      // CPU type at offset 4 (uint32 LE): 0x0100000C = arm64, 0x01000007 = x86_64
      const cpuType = header.readUInt32LE(4)
      if (cpuType === 0x0100000C) return 'mac-arm64'
      if (cpuType === 0x01000007) return 'mac-x64'
      return 'mac-unknown'
    }

    // Mach-O universal (fat binary): 0xCAFEBABE (big-endian)
    if (header[0] === 0xCA && header[1] === 0xFE && header[2] === 0xBA && header[3] === 0xBE) {
      return 'mac-universal'
    }

    return null
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Validate a cloudflared binary: size threshold + magic bytes platform match.
 * Returns { valid, size, detected, reason? }.
 */
function validateCloudflaredBinary(filePath, platform) {
  const stats = fs.statSync(filePath)
  const minSize = platform === 'win' ? 10 * 1024 * 1024 : 30 * 1024 * 1024
  if (stats.size <= minSize) {
    return { valid: false, size: stats.size, detected: null, reason: `too small (${(stats.size / 1024 / 1024).toFixed(1)} MB)` }
  }

  const detected = detectBinaryPlatform(filePath)
  const acceptable = platform === 'mac-arm64' || platform === 'mac-x64'
    ? [platform, 'mac-universal']
    : [platform]

  if (!detected || !acceptable.includes(detected)) {
    return { valid: false, size: stats.size, detected, reason: `format mismatch (detected: ${detected || 'unknown'})` }
  }

  return { valid: true, size: stats.size, detected }
}

/**
 * Check if cloudflared exists and is valid for platform.
 */
function checkCloudflared(platform) {
  const filePath = path.join(PROJECT_ROOT, CLOUDFLARED_PATHS[platform])
  if (!fs.existsSync(filePath)) {
    return { exists: false }
  }

  const result = validateCloudflaredBinary(filePath, platform)
  if (!result.valid) {
    log.warn(`cloudflared for ${platform}: ${result.reason}, will re-download`)
  }
  return { exists: true, ...result }
}

/**
 * Check if @parcel/watcher exists for platform
 */
function checkWatcher(platform) {
  const dirPath = path.join(PROJECT_ROOT, 'node_modules', WATCHER_PACKAGES[platform])
  if (!fs.existsSync(dirPath)) {
    return { exists: false }
  }

  try {
    const files = fs.readdirSync(dirPath, { recursive: true }).map(String)
    const hasNodeFile = files.some(f => f.endsWith('.node'))
    return { exists: true, valid: hasNodeFile }
  } catch {
    return { exists: true, valid: false }
  }
}

/**
 * Download cloudflared for platform
 */
function downloadCloudflared(platform) {
  const url = CLOUDFLARED_URLS[platform]
  const outputPath = path.join(PROJECT_ROOT, CLOUDFLARED_PATHS[platform])
  const outputDir = path.dirname(outputPath)

  log.info(`Downloading cloudflared for ${platform}...`)

  // Ensure directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  // Remove existing file
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath)
  }

  if (url.endsWith('.tgz')) {
    // Mac: download and extract tgz
    const tgzPath = outputPath + '.tgz'
    curlDownload(url, tgzPath)
    execSync(`tar -xzf "${tgzPath}" -C "${outputDir}"`, { stdio: 'pipe' })

    // Rename extracted file if needed (for mac-x64)
    const extractedPath = path.join(outputDir, 'cloudflared')
    if (platform === 'mac-x64' && fs.existsSync(extractedPath)) {
      fs.renameSync(extractedPath, outputPath)
    }

    fs.unlinkSync(tgzPath)
    fs.chmodSync(outputPath, 0o755)
  } else if (url.endsWith('.exe')) {
    // Windows: direct download
    curlDownload(url, outputPath)
  } else {
    // Linux: direct download
    curlDownload(url, outputPath)
    fs.chmodSync(outputPath, 0o755)
  }

  // Post-download integrity verification
  verifyCloudflared(platform, outputPath)

  log.success(`Downloaded cloudflared for ${platform}`)
}

/**
 * Verify downloaded cloudflared binary integrity.
 * Removes the file and throws on failure to avoid leaving bad binaries on disk.
 */
function verifyCloudflared(platform, filePath) {
  const result = validateCloudflaredBinary(filePath, platform)
  if (!result.valid) {
    fs.unlinkSync(filePath)
    throw new Error(`Downloaded cloudflared for ${platform}: ${result.reason}`)
  }
  log.info(`Verified: ${(result.size / 1024 / 1024).toFixed(1)} MB, format: ${result.detected}`)
}

/**
 * Get the installed @parcel/watcher version to match platform-specific packages
 */
function getWatcherVersion() {
  const pkgPath = path.join(PROJECT_ROOT, 'node_modules', '@parcel', 'watcher', 'package.json')
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
}

/**
 * Download a file with curl and verify download completeness.
 */
function curlDownload(url, dest) {
  const cmd = (extra = '') => `curl -fsSL ${extra} -o "${dest}" "${url}"`

  try {
    execSync(cmd(), { stdio: 'pipe' })
  } catch {
    log.warn('Download failed, retrying without proxy...')
    execSync(cmd("--noproxy '*'"), { stdio: 'pipe' })
  }

  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    if (fs.existsSync(dest)) fs.unlinkSync(dest)
    throw new Error(`Download failed: ${path.basename(dest)}`)
  }
}

/**
 * Get better-sqlite3 version and Electron ABI for constructing prebuild download URLs.
 *
 * Reads installed package versions and uses node-abi to map the Electron version
 * to the correct native module ABI number. This ABI is embedded in the prebuild
 * tarball filename on GitHub releases.
 */
function getBetterSqlite3Info() {
  const bsPkg = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, 'node_modules/better-sqlite3/package.json'), 'utf8'
  ))
  const electronPkg = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, 'node_modules/electron/package.json'), 'utf8'
  ))
  const abi = execSync(
    `node -e "console.log(require('node-abi').getAbi('${electronPkg.version}', 'electron'))"`,
    { encoding: 'utf8', cwd: PROJECT_ROOT }
  ).trim()

  return { version: bsPkg.version, electronVersion: electronPkg.version, abi }
}

/**
 * Check if better-sqlite3 prebuild exists and is valid for platform
 */
function checkBetterSqlite3(platform) {
  const { platform: os, arch } = BETTER_SQLITE3_PLATFORMS[platform]
  const prebuildPath = path.join(
    PROJECT_ROOT, BETTER_SQLITE3_PREBUILDS_DIR, `${os}-${arch}`, 'better_sqlite3.node'
  )
  if (!fs.existsSync(prebuildPath)) {
    return { exists: false }
  }
  const stats = fs.statSync(prebuildPath)
  // Compiled .node binary should be > 500 KB
  return { exists: true, valid: stats.size > 500 * 1024, size: stats.size }
}

/**
 * Download better-sqlite3 prebuild for a target platform.
 *
 * Downloads the prebuilt .node binary from better-sqlite3 GitHub releases.
 * The tarball naming convention is:
 *   better-sqlite3-v{version}-electron-v{abi}-{platform}-{arch}.tar.gz
 *
 * The tarball contains: build/Release/better_sqlite3.node
 * We extract it to: node_modules/better-sqlite3/prebuilds/{platform}-{arch}/
 */
function downloadBetterSqlite3(platform) {
  const { platform: targetPlatform, arch: targetArch } = BETTER_SQLITE3_PLATFORMS[platform]
  const { version, abi } = getBetterSqlite3Info()
  const prebuildDir = path.join(PROJECT_ROOT, BETTER_SQLITE3_PREBUILDS_DIR, `${targetPlatform}-${targetArch}`)
  const outputPath = path.join(prebuildDir, 'better_sqlite3.node')

  const tarballName = `better-sqlite3-v${version}-electron-v${abi}-${targetPlatform}-${targetArch}.tar.gz`
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${tarballName}`
  const tmpTgz = path.join(PROJECT_ROOT, `node_modules/.better-sqlite3-${targetPlatform}-${targetArch}.tgz`)

  log.info(`Downloading better-sqlite3 prebuild for ${platform}...`)

  fs.mkdirSync(prebuildDir, { recursive: true })

  try {
    curlDownload(url, tmpTgz)

    // Extract .node file from tarball (contains build/Release/better_sqlite3.node)
    const tmpExtract = path.join(PROJECT_ROOT, `node_modules/.better-sqlite3-extract-${targetPlatform}-${targetArch}`)
    if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true })
    fs.mkdirSync(tmpExtract, { recursive: true })
    execSync(`tar -xzf "${tmpTgz}" -C "${tmpExtract}"`, { stdio: 'pipe' })

    const extractedNode = path.join(tmpExtract, 'build', 'Release', 'better_sqlite3.node')
    if (!fs.existsSync(extractedNode)) {
      throw new Error('Tarball does not contain build/Release/better_sqlite3.node')
    }

    fs.copyFileSync(extractedNode, outputPath)

    // Cleanup temp files
    fs.unlinkSync(tmpTgz)
    fs.rmSync(tmpExtract, { recursive: true })

    const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)
    log.success(`Downloaded better-sqlite3 prebuild for ${platform} (${sizeMB} MB)`)
  } catch (err) {
    if (fs.existsSync(tmpTgz)) fs.unlinkSync(tmpTgz)
    const tmpExtractCleanup = path.join(PROJECT_ROOT, `node_modules/.better-sqlite3-extract-${targetPlatform}-${targetArch}`)
    if (fs.existsSync(tmpExtractCleanup)) fs.rmSync(tmpExtractCleanup, { recursive: true })
    log.error(`Failed to download better-sqlite3 prebuild for ${platform}: ${err.message}`)
    throw err
  }
}

/**
 * Install @parcel/watcher for platform
 * Downloads tarball directly from npm registry to bypass platform compatibility checks
 */
function installWatcher(platform) {
  const pkg = WATCHER_PACKAGES[platform]
  const pkgName = pkg.replace('@parcel/', '')
  const version = getWatcherVersion()
  const registry = execSync('npm config get registry', { encoding: 'utf8' }).trim().replace(/\/+$/, '')
  const tarballUrl = `${registry}/@parcel/${pkgName}/-/${pkgName}-${version}.tgz`
  const destDir = path.join(PROJECT_ROOT, 'node_modules', pkg)
  const tmpTgz = path.join(PROJECT_ROOT, `node_modules/.${pkgName}.tgz`)

  log.info(`Installing ${pkg}@${version} from registry...`)

  try {
    // Clean up destination
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true })
    }
    fs.mkdirSync(destDir, { recursive: true })

    // Download tarball and extract (--strip-components=1 removes the "package/" prefix)
    curlDownload(tarballUrl, tmpTgz)
    execSync(`tar -xzf "${tmpTgz}" -C "${destDir}" --strip-components=1`, { stdio: 'pipe' })
    fs.unlinkSync(tmpTgz)

    // Verify .node file exists
    const files = fs.readdirSync(destDir, { recursive: true }).map(String)
    if (!files.some(f => f.endsWith('.node'))) {
      throw new Error(`No .node binary found in downloaded ${pkg}`)
    }

    log.success(`Installed ${pkg}@${version}`)
  } catch (err) {
    // Clean up on failure
    if (fs.existsSync(tmpTgz)) fs.unlinkSync(tmpTgz)
    log.error(`Failed to install ${pkg}: ${err.message}`)
    throw err
  }
}

/**
 * Check if the bundled Portable Git archive exists and looks valid.
 * The .7z.exe is a self-extracting PE, so it must start with the MZ magic.
 */
function checkPortableGit() {
  const filePath = path.join(PROJECT_ROOT, PORTABLE_GIT_DEST)
  if (!fs.existsSync(filePath)) {
    return { exists: false }
  }
  const stats = fs.statSync(filePath)
  const valid = stats.size > 40 * 1024 * 1024 && detectBinaryPlatform(filePath) === 'win'
  if (!valid) {
    log.warn(`Portable Git archive invalid (${(stats.size / 1024 / 1024).toFixed(1)} MB), will re-download`)
  }
  return { exists: true, valid }
}

/**
 * Download the Portable Git self-extracting archive (mirrors first, GitHub fallback).
 */
function downloadPortableGit() {
  const outputPath = path.join(PROJECT_ROOT, PORTABLE_GIT_DEST)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  let lastError = null
  for (const url of PORTABLE_GIT_URLS) {
    log.info(`Downloading Portable Git ${PORTABLE_GIT_VERSION}: ${url}`)
    try {
      curlDownload(url, outputPath)
      const stats = fs.statSync(outputPath)
      if (stats.size <= 40 * 1024 * 1024 || detectBinaryPlatform(outputPath) !== 'win') {
        fs.unlinkSync(outputPath)
        throw new Error(`invalid archive (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)
      }
      log.success(`Downloaded Portable Git (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)
      return
    } catch (err) {
      lastError = err
      log.warn(`Source failed: ${err.message}`)
    }
  }
  throw new Error(`All Portable Git download sources failed: ${lastError?.message}`)
}

function getCodexVersion() {
  const pkgPath = path.join(PROJECT_ROOT, 'node_modules', '@openai', 'codex', 'package.json')
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
}

function checkCodex(platform) {
  const target = CODEX_PACKAGES[platform]
  const binaryPath = path.join(
    PROJECT_ROOT,
    'node_modules',
    target.pkg,
    'vendor',
    target.targetTriple,
    'codex',
    target.binary
  )
  if (!fs.existsSync(binaryPath)) {
    return { exists: false }
  }
  const stats = fs.statSync(binaryPath)
  return { exists: true, valid: stats.size > 10 * 1024 * 1024, size: stats.size }
}

/**
 * Install @openai/codex platform package for a target platform.
 * Downloads tarball directly from npm registry to bypass host os/cpu checks.
 */
function installCodex(platform) {
  const target = CODEX_PACKAGES[platform]
  const version = getCodexVersion()
  const platformVersion = `${version}-${target.pkg.replace('@openai/codex-', '')}`
  const registry = execSync('npm config get registry', { encoding: 'utf8' }).trim().replace(/\/+$/, '')
  const tarballUrl = `${registry}/@openai/codex/-/codex-${platformVersion}.tgz`
  const destDir = path.join(PROJECT_ROOT, 'node_modules', target.pkg)
  const tmpTgz = path.join(PROJECT_ROOT, `node_modules/.${target.pkg.replace('@openai/', '')}.tgz`)

  log.info(`Installing ${target.pkg}@${platformVersion} from registry...`)

  try {
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true })
    }
    fs.mkdirSync(destDir, { recursive: true })

    curlDownload(tarballUrl, tmpTgz)
    execSync(`tar -xzf "${tmpTgz}" -C "${destDir}" --strip-components=1`, { stdio: 'pipe' })
    fs.unlinkSync(tmpTgz)

    const status = checkCodex(platform)
    if (!status.exists || !status.valid) {
      throw new Error(`No valid Codex binary found in downloaded ${target.pkg}`)
    }

    log.success(`Installed ${target.pkg}@${platformVersion}`)
  } catch (err) {
    if (fs.existsSync(tmpTgz)) fs.unlinkSync(tmpTgz)
    log.error(`Failed to install ${target.pkg}: ${err.message}`)
    throw err
  }
}

/**
 * Sharp release to install for every target platform, read from whichever
 * @img/sharp-* package npm resolved for this host. Pinning all platforms to the
 * host's version keeps one sharp release across the whole build matrix.
 */
function getSharpVersion() {
  const imgDir = path.join(PROJECT_ROOT, 'node_modules', '@img')
  const hostPkg = fs.existsSync(imgDir)
    ? fs.readdirSync(imgDir).find(name => name.startsWith('sharp-') && !name.startsWith('sharp-libvips-'))
    : undefined

  if (!hostPkg) {
    throw new Error('No @img/sharp-* package in node_modules, run "npm install" first')
  }
  return JSON.parse(fs.readFileSync(path.join(imgDir, hostPkg, 'package.json'), 'utf8')).version
}

/**
 * Download an npm package tarball straight into node_modules, bypassing the
 * host os/cpu checks that make npm refuse a foreign-platform package.
 */
function installFromRegistry(pkg, version) {
  const shortName = pkg.split('/').pop()
  const registry = execSync('npm config get registry', { encoding: 'utf8' }).trim().replace(/\/+$/, '')
  const tarballUrl = `${registry}/${pkg}/-/${shortName}-${version}.tgz`
  const destDir = path.join(PROJECT_ROOT, 'node_modules', ...pkg.split('/'))
  const tmpTgz = path.join(PROJECT_ROOT, `node_modules/.${shortName}.tgz`)

  try {
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true })
    }
    fs.mkdirSync(destDir, { recursive: true })

    curlDownload(tarballUrl, tmpTgz)
    execSync(`tar -xzf "${tmpTgz}" -C "${destDir}" --strip-components=1`, { stdio: 'pipe' })
    fs.unlinkSync(tmpTgz)
  } catch (err) {
    if (fs.existsSync(tmpTgz)) fs.unlinkSync(tmpTgz)
    throw err
  }

  return destDir
}

function checkSharp(platform) {
  const pkg = SHARP_PACKAGES[platform]
  const pkgDir = path.join(PROJECT_ROOT, 'node_modules', ...pkg.split('/'))
  const manifestPath = path.join(pkgDir, 'package.json')

  if (!fs.existsSync(manifestPath)) {
    return { exists: false }
  }

  const libDir = path.join(pkgDir, 'lib')
  if (!fs.existsSync(libDir) || !fs.readdirSync(libDir).some(f => f.endsWith('.node'))) {
    return { exists: true, valid: false }
  }

  // The libvips sibling carries the shared library the .node links against,
  // so the package alone is not enough on platforms that declare one.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const siblings = Object.keys(manifest.optionalDependencies || {})
  const valid = siblings.every(dep =>
    fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', ...dep.split('/'), 'package.json'))
  )
  return { exists: true, valid }
}

/**
 * Install the @img/sharp-* package for a target platform, plus the libvips
 * sibling it declares.
 */
function installSharp(platform) {
  const pkg = SHARP_PACKAGES[platform]
  const version = getSharpVersion()

  log.info(`Installing ${pkg}@${version} from registry...`)

  try {
    const destDir = installFromRegistry(pkg, version)

    const manifest = JSON.parse(fs.readFileSync(path.join(destDir, 'package.json'), 'utf8'))
    for (const [dep, range] of Object.entries(manifest.optionalDependencies || {})) {
      const depVersion = range.replace(/^[^0-9]*/, '')
      log.info(`Installing ${dep}@${depVersion} for ${pkg}...`)
      installFromRegistry(dep, depVersion)
    }

    const status = checkSharp(platform)
    if (!status.exists || !status.valid) {
      throw new Error(`No valid sharp binary found in downloaded ${pkg}`)
    }

    log.success(`Installed ${pkg}@${version}`)
  } catch (err) {
    log.error(`Failed to install ${pkg}: ${err.message}`)
    throw err
  }
}

/**
 * Prepare all binaries for a platform
 */
function preparePlatform(platform) {
  console.log(`\n=== Preparing binaries for ${platform} ===\n`)

  // Check and download cloudflared
  const cfStatus = checkCloudflared(platform)
  if (!cfStatus.exists || !cfStatus.valid) {
    downloadCloudflared(platform)
  } else {
    log.success(`cloudflared already exists for ${platform}`)
  }

  // Check and install @parcel/watcher
  const watcherStatus = checkWatcher(platform)
  if (!watcherStatus.exists || !watcherStatus.valid) {
    installWatcher(platform)
  } else {
    log.success(`@parcel/watcher already exists for ${platform}`)
  }

  // Check and download better-sqlite3 prebuild
  const sqliteStatus = checkBetterSqlite3(platform)
  if (!sqliteStatus.exists || !sqliteStatus.valid) {
    downloadBetterSqlite3(platform)
  } else {
    log.success(`better-sqlite3 prebuild already exists for ${platform}`)
  }

  // Check and install @openai/codex native package
  const codexStatus = checkCodex(platform)
  if (!codexStatus.exists || !codexStatus.valid) {
    installCodex(platform)
  } else {
    log.success(`@openai/codex native package already exists for ${platform}`)
  }

  // Check and install the @img/sharp-* prebuilt image resizer
  const sharpStatus = checkSharp(platform)
  if (!sharpStatus.exists || !sharpStatus.valid) {
    installSharp(platform)
  } else {
    log.success(`@img/sharp native package already exists for ${platform}`)
  }

  // Portable Git: bundled into the Windows build for offline Git Bash setup
  if (platform === 'win') {
    const gitStatus = checkPortableGit()
    if (!gitStatus.exists || !gitStatus.valid) {
      downloadPortableGit()
    } else {
      log.success('Portable Git archive already exists')
    }
  }

  // node-pty: mac/win prebuilds ship with the npm package automatically.
  // Linux terminal is not yet supported (no public prebuilds available);
  // the terminal panel feature is disabled on Linux at runtime.
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2)
  let platform = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) {
      platform = args[i + 1]
    }
  }

  return { platform }
}

/**
 * Main entry point
 */
async function main() {
  const { platform: targetPlatform } = parseArgs()
  const validPlatforms = ['mac-arm64', 'mac-x64', 'win', 'linux', 'all']

  let platforms = []

  if (targetPlatform === 'all') {
    platforms = ['mac-arm64', 'mac-x64', 'win', 'linux']
  } else if (targetPlatform) {
    if (!validPlatforms.includes(targetPlatform)) {
      log.error(`Invalid platform: ${targetPlatform}`)
      console.log(`Valid platforms: ${validPlatforms.join(', ')}`)
      process.exit(1)
    }
    platforms = [targetPlatform]
  } else {
    // Auto-detect current platform
    const detected = detectPlatform()
    if (!detected) {
      log.error('Could not detect current platform')
      process.exit(1)
    }
    log.info(`Auto-detected platform: ${detected}`)
    platforms = [detected]
  }

  for (const platform of platforms) {
    preparePlatform(platform)
  }

  console.log('\n' + colors.green + '✅ All binaries prepared successfully!' + colors.reset)
}

main().catch(err => {
  log.error(err.message)
  process.exit(1)
})
