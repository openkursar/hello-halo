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

// @parcel/watcher packages per platform
const WATCHER_PACKAGES = {
  'mac-arm64': '@parcel/watcher-darwin-arm64',
  'mac-x64': '@parcel/watcher-darwin-x64',
  'win': '@parcel/watcher-win32-x64',
  'linux': '@parcel/watcher-linux-x64-glibc'
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
 * Check if cloudflared exists and is valid for platform
 */
function checkCloudflared(platform) {
  const filePath = path.join(PROJECT_ROOT, CLOUDFLARED_PATHS[platform])
  if (!fs.existsSync(filePath)) {
    return { exists: false }
  }

  // Basic size validation
  const stats = fs.statSync(filePath)
  const minSize = platform === 'win' ? 10 * 1024 * 1024 : 30 * 1024 * 1024
  return { exists: true, valid: stats.size > minSize, size: stats.size }
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
    execSync(`curl -L -o "${tgzPath}" "${url}"`, { stdio: 'inherit' })
    execSync(`tar -xzf "${tgzPath}" -C "${outputDir}"`, { stdio: 'inherit' })

    // Rename extracted file if needed (for mac-x64)
    const extractedPath = path.join(outputDir, 'cloudflared')
    if (platform === 'mac-x64' && fs.existsSync(extractedPath)) {
      fs.renameSync(extractedPath, outputPath)
    }

    fs.unlinkSync(tgzPath)
    fs.chmodSync(outputPath, 0o755)
  } else if (url.endsWith('.exe')) {
    // Windows: direct download
    execSync(`curl -L -o "${outputPath}" "${url}"`, { stdio: 'inherit' })
  } else {
    // Linux: direct download
    execSync(`curl -L -o "${outputPath}" "${url}"`, { stdio: 'inherit' })
    fs.chmodSync(outputPath, 0o755)
  }

  log.success(`Downloaded cloudflared for ${platform}`)
}

/**
 * Install @parcel/watcher for platform
 * Uses --force to bypass platform compatibility checks when cross-compiling
 */
function installWatcher(platform) {
  const pkg = WATCHER_PACKAGES[platform]
  log.info(`Installing ${pkg}...`)

  try {
    // Use --force to bypass os/cpu platform checks for cross-platform builds
    execSync(`npm install ${pkg} --force`, { cwd: PROJECT_ROOT, stdio: 'inherit' })
    log.success(`Installed ${pkg}`)
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
