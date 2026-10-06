#!/usr/bin/env node

/**
 * Build Dependencies Checker
 *
 * Verifies that everything a release needs is present before packaging:
 * native binaries, and the JavaScript runtimes behind the agent SDK engines.
 * This prevents shipping broken builds to users.
 *
 * Usage:
 *   node tests/check/binaries.mjs [--platform mac-arm64|mac-x64|win|linux|all]
 *                                 [--require-engines anthropic,halo,codex]
 *
 * Platforms:
 *   mac-arm64 - Mac Apple Silicon (M1/M2/M3/M4)
 *   mac-x64   - Mac Intel
 *   win       - Windows x64
 *   linux     - Linux x64
 *   all       - All platforms (default)
 *
 * --require-engines turns a missing engine into a build failure. It is opt-in
 * because engine packages are optional dependencies: a clean clone legitimately
 * lacks `@hello-halo/agent-sdk` (its source directory is gitignored), and that
 * must not break contributor builds. Release scripts pass the flag so an
 * official artifact can never ship without the engines it advertises.
 *
 * Exit codes:
 *   0 - All checks passed
 *   1 - One or more checks failed
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import engineRuntimes from '../../scripts/engine-runtimes.cjs'
import { BETTER_SQLITE3_TARGETS, getBetterSqlite3PrebuildPath, validateBetterSqlite3Prebuild } from '../../scripts/lib/better-sqlite3-prebuilds.mjs'
import { CLOUDFLARED_MINIMUM_MACOS } from '../../scripts/lib/cloudflared.mjs'
import deployment from '../../scripts/lib/macho-deployment-target.cjs'

const { ENGINE_RUNTIMES, VALID_ENGINES, resolveEngineEntry, engineArtifactPaths } = engineRuntimes

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')

// ANSI color codes
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
}

// Logging utilities
const log = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[OK]${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}[ERROR]${colors.reset} ${msg}`)
}

/**
 * Binary dependency definitions
 * Each dependency specifies:
 * - path: Relative path from project root
 * - platform: Which platform needs this binary (mac-arm64, mac-x64, win, linux, all)
 * - fix: Command to fix if missing
 * - validate: Optional function to validate the binary
 * - macOSFloor: Deployment floor of a separately launched helper, when newer than the app's
 */
const BINARY_DEPENDENCIES = [
  {
    name: 'Mac arm64 cloudflared',
    path: 'node_modules/cloudflared/bin/cloudflared',
    platform: 'mac-arm64',
    fix: 'node scripts/prepare-binaries.mjs --platform mac-arm64',
    macOSFloor: CLOUDFLARED_MINIMUM_MACOS,
    validate: (filePath) => describeMachO(filePath, 'arm64')
  },
  {
    name: 'Mac x64 cloudflared',
    path: 'node_modules/cloudflared/bin/cloudflared-darwin-x64',
    platform: 'mac-x64',
    fix: 'node scripts/prepare-binaries.mjs --platform mac-x64',
    macOSFloor: CLOUDFLARED_MINIMUM_MACOS,
    validate: (filePath) => describeMachO(filePath, 'x64')
  },
  {
    name: 'Windows x64 cloudflared',
    path: 'node_modules/cloudflared/bin/cloudflared.exe',
    platform: 'win',
    fix: 'npm run prepare:win-x64',
    validate: (filePath) => {
      try {
        const stats = fs.statSync(filePath)
        // Windows exe should be > 10MB
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1)
        return { valid: stats.size > 10 * 1024 * 1024, info: `${sizeMB} MB` }
      } catch {
        return { valid: false, info: 'cannot read file' }
      }
    }
  },
  {
    name: 'Linux x64 cloudflared',
    path: 'node_modules/cloudflared/bin/cloudflared-linux-x64',
    platform: 'linux',
    fix: 'npm run prepare:linux-x64',
    validate: (filePath) => {
      try {
        const stats = fs.statSync(filePath)
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1)
        // Linux binary should be > 30MB
        return { valid: stats.size > 30 * 1024 * 1024, info: `${sizeMB} MB` }
      } catch {
        return { valid: false, info: 'cannot read file' }
      }
    }
  },

  // Portable Git - bundled into the Windows build for offline Git Bash setup.
  // Downloaded by prepare-binaries.mjs, shipped via win.extraResources.
  {
    name: 'Windows Portable Git archive',
    path: 'resources/git-bash',
    platform: 'win',
    fix: 'node scripts/prepare-binaries.mjs --platform win',
    validate: (dirPath) => {
      try {
        const archive = fs.readdirSync(dirPath).find(f => /^PortableGit-.+\.7z\.exe$/.test(f))
        if (!archive) {
          return { valid: false, info: 'no PortableGit-*.7z.exe found' }
        }
        const stats = fs.statSync(path.join(dirPath, archive))
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1)
        return { valid: stats.size > 40 * 1024 * 1024, info: `${archive} (${sizeMB} MB)` }
      } catch {
        return { valid: false, info: 'cannot read directory' }
      }
    }
  },

  // @parcel/watcher - Native file system watcher (same engine as VS Code)
  // Each platform has a separate npm package with prebuilt .node binaries.
  {
    name: 'Mac arm64 @parcel/watcher',
    path: 'node_modules/@parcel/watcher-darwin-arm64',
    platform: 'mac-arm64',
    fix: 'npm install @parcel/watcher',
    validate: (dirPath) => {
      try {
        const files = fs.readdirSync(dirPath, { recursive: true }).map(String)
        const nodeFile = files.find(f => f.endsWith('.node'))
        return { valid: !!nodeFile, info: nodeFile || 'no .node file found' }
      } catch {
        return { valid: false, info: 'cannot read directory' }
      }
    }
  },
  {
    name: 'Mac x64 @parcel/watcher',
    path: 'node_modules/@parcel/watcher-darwin-x64',
    platform: 'mac-x64',
    fix: 'npm install @parcel/watcher',
    validate: (dirPath) => {
      try {
        const files = fs.readdirSync(dirPath, { recursive: true }).map(String)
        const nodeFile = files.find(f => f.endsWith('.node'))
        return { valid: !!nodeFile, info: nodeFile || 'no .node file found' }
      } catch {
        return { valid: false, info: 'cannot read directory' }
      }
    }
  },
  {
    name: 'Windows x64 @parcel/watcher',
    path: 'node_modules/@parcel/watcher-win32-x64',
    platform: 'win',
    fix: 'npm install @parcel/watcher',
    validate: (dirPath) => {
      try {
        const files = fs.readdirSync(dirPath, { recursive: true }).map(String)
        const nodeFile = files.find(f => f.endsWith('.node'))
        return { valid: !!nodeFile, info: nodeFile || 'no .node file found' }
      } catch {
        return { valid: false, info: 'cannot read directory' }
      }
    }
  },
  {
    name: 'Linux x64 @parcel/watcher',
    path: 'node_modules/@parcel/watcher-linux-x64-glibc',
    platform: 'linux',
    fix: 'npm install @parcel/watcher',
    validate: (dirPath) => {
      try {
        const files = fs.readdirSync(dirPath, { recursive: true }).map(String)
        const nodeFile = files.find(f => f.endsWith('.node'))
        return { valid: !!nodeFile, info: nodeFile || 'no .node file found' }
      } catch {
        return { valid: false, info: 'cannot read directory' }
      }
    }
  },

  // node-pty - Native PTY (pseudo-terminal) for the terminal panel feature
  // Mac/Win prebuilds ship with the npm package.
  // Linux x64 prebuilds are compiled via Docker by prepare-binaries.mjs.
  // afterPack.cjs strips non-target platform directories and .pdb debug symbols.
  {
    name: 'Mac arm64 node-pty',
    path: 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
    platform: 'mac-arm64',
    fix: 'npm install (node-pty ships mac prebuilds in the npm package)',
    validate: (filePath) => {
      try {
        const stats = fs.statSync(filePath)
        return { valid: stats.size > 30 * 1024, info: `${(stats.size / 1024).toFixed(0)} KB` }
      } catch {
        return { valid: false, info: 'cannot read file' }
      }
    }
  },
  {
    name: 'Mac x64 node-pty',
    path: 'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
    platform: 'mac-x64',
    fix: 'npm install (node-pty ships mac prebuilds in the npm package)',
    validate: (filePath) => {
      try {
        const stats = fs.statSync(filePath)
        return { valid: stats.size > 20 * 1024, info: `${(stats.size / 1024).toFixed(0)} KB` }
      } catch {
        return { valid: false, info: 'cannot read file' }
      }
    }
  },
  {
    name: 'Windows x64 node-pty',
    path: 'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    platform: 'win',
    fix: 'npm install (node-pty ships win prebuilds in the npm package)',
    validate: (filePath) => {
      try {
        const stats = fs.statSync(filePath)
        return { valid: stats.size > 100 * 1024, info: `${(stats.size / 1024).toFixed(0)} KB` }
      } catch {
        return { valid: false, info: 'cannot read file' }
      }
    }
  },
  // node-pty Linux: terminal panel is not supported on Linux (no public prebuilds available).
  // Linux users get Halo without the terminal feature. Platform check at runtime handles this.

  ...Object.entries(BETTER_SQLITE3_TARGETS).map(([platform, target]) => ({
    name: `${platform} better-sqlite3`,
    path: path.relative(PROJECT_ROOT, getBetterSqlite3PrebuildPath(PROJECT_ROOT, target)),
    platform,
    fix: 'npm run prepare:all',
    validate: filePath => {
      try {
        const result = validateBetterSqlite3Prebuild(filePath, target)
        return { valid: result.valid, info: result.valid ? `${(result.size / 1024 / 1024).toFixed(1)} MB` : result.reason }
      } catch (error) {
        return { valid: false, info: `cannot validate prebuild (${error.message})` }
      }
    },
  }))
]

// ============================================================================
// Agent SDK engine runtimes
// ============================================================================

/**
 * Check one engine runtime. Reports version and a content fingerprint of the
 * entry file: `@hello-halo/agent-sdk` carries a static version across rebuilds,
 * so the fingerprint is the only way to tell two SDK builds apart in a log.
 */
function checkEngine(engineId) {
  const engine = ENGINE_RUNTIMES[engineId]
  const { pkgDir, manifestPath, entryPaths, label } = engineArtifactPaths(engine)
  const absoluteManifest = path.join(PROJECT_ROOT, manifestPath)

  if (!fs.existsSync(absoluteManifest)) {
    return { engineId, name: engine.name, status: 'missing', path: label, fix: engine.fix }
  }

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(absoluteManifest, 'utf-8'))
  } catch (error) {
    return {
      engineId,
      name: engine.name,
      status: 'invalid',
      path: label,
      info: `unreadable package.json (${error.message})`,
      fix: engine.fix
    }
  }

  const entry = entryPaths
    ? entryPaths.map(p => path.join(PROJECT_ROOT, p)).find(fs.existsSync)
    : resolveEngineEntry(path.join(PROJECT_ROOT, pkgDir), manifest)
  if (!entry) {
    return {
      engineId,
      name: engine.name,
      status: 'invalid',
      path: label,
      info: 'present but has no loadable entry file',
      fix: engine.fix
    }
  }

  const fingerprint = createHash('sha256').update(fs.readFileSync(entry)).digest('hex').slice(0, 12)
  return {
    engineId,
    name: engine.name,
    status: 'ok',
    path: label,
    info: `v${manifest.version ?? 'unknown'} #${fingerprint}`
  }
}

/** Reports a thin Mach-O executable's architecture and deployment target. */
function describeMachO(filePath, architecture) {
  try {
    const { slices } = deployment.inspectMachO(filePath)
    if (slices.length !== 1 || slices[0].architecture !== architecture) {
      return { valid: false, info: `expected ${architecture}, found ${slices.map(slice => slice.architecture).join('+') || 'no Mach-O slices'}` }
    }
    return { valid: true, info: `${architecture}, macOS ${slices[0].minimumMacOS}` }
  } catch (error) {
    return { valid: false, info: `cannot read Mach-O (${error.message})` }
  }
}

/**
 * Check a single binary dependency
 */
function checkBinary(dep) {
  const fullPath = path.join(PROJECT_ROOT, dep.path)

  if (!fs.existsSync(fullPath)) {
    return {
      name: dep.name,
      status: 'missing',
      path: dep.path,
      fix: dep.fix
    }
  }

  if (dep.platform.startsWith('mac-')) {
    try {
      const files = fs.statSync(fullPath).isDirectory() ? deployment.findMachOFiles(fullPath) : [fullPath]
      for (const file of files) {
        const native = deployment.inspectMachO(file)
        if (!native.isMachO) continue
        const target = deployment.validateMacOSDeploymentTarget(file, dep.macOSFloor)
        if (!target.valid) return { name: dep.name, status: 'invalid', path: dep.path, info: target.reason, fix: dep.fix }
      }
    } catch (error) {
      return { name: dep.name, status: 'invalid', path: dep.path, info: error.message, fix: dep.fix }
    }
  }

  // Run validation if provided
  if (dep.validate) {
    const validation = dep.validate(fullPath)
    if (!validation.valid) {
      return {
        name: dep.name,
        status: 'invalid',
        path: dep.path,
        info: validation.info,
        fix: dep.fix
      }
    }
    return {
      name: dep.name,
      status: 'ok',
      path: dep.path,
      info: validation.info
    }
  }

  return {
    name: dep.name,
    status: 'ok',
    path: dep.path
  }
}

/**
 * Report every engine runtime. Engines named in `requiredEngines` fail the
 * build when absent; the rest are informational, so a contributor clone
 * without the optional engines still passes.
 *
 * Returns true when a required engine is missing or unusable.
 */
function runEngineChecks(requiredEngines) {
  log.info('Checking agent SDK engine runtimes...\n')

  let hasErrors = false

  for (const engineId of VALID_ENGINES) {
    const result = checkEngine(engineId)
    const required = requiredEngines.includes(engineId)

    if (result.status === 'ok') {
      log.success(`${result.name} (${result.info})`)
      continue
    }

    const detail = result.info ? ` - ${result.info}` : ''
    if (!required) {
      log.warn(`Not bundled: ${result.name}${detail} (not required by this build)`)
      continue
    }

    log.error(`${result.status === 'missing' ? 'Missing' : 'Invalid'}: ${result.name}${detail}`)
    console.log(`  Package: ${result.path}`)
    console.log(`  Fix: ${result.fix}`)
    hasErrors = true
  }

  console.log('')
  return hasErrors
}

/**
 * Run all binary checks
 */
function runChecks(targetPlatform = 'all', requiredEngines = []) {
  log.info('Checking binary dependencies...\n')

  const results = []
  let hasErrors = false

  for (const dep of BINARY_DEPENDENCIES) {
    // Skip if platform doesn't match
    if (targetPlatform !== 'all' && dep.platform !== targetPlatform) {
      continue
    }

    const result = checkBinary(dep)
    results.push(result)

    if (result.status === 'ok') {
      const info = result.info ? ` (${result.info})` : ''
      log.success(`${result.name}${info}`)
    } else if (result.status === 'missing') {
      log.error(`Missing: ${result.name}`)
      console.log(`  Path: ${result.path}`)
      console.log(`  Fix: ${result.fix}`)
      hasErrors = true
    } else if (result.status === 'invalid') {
      log.error(`Invalid: ${result.name} - ${result.info}`)
      console.log(`  Path: ${result.path}`)
      console.log(`  Fix: ${result.fix}`)
      hasErrors = true
    }
  }

  console.log('')

  if (runEngineChecks(requiredEngines)) {
    hasErrors = true
  }

  if (hasErrors) {
    log.error('Build dependency check failed! Fix the issues above before packaging.')
    process.exit(1)
  } else {
    log.success('All build dependencies are present.')
    process.exit(0)
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2)
  let platform = 'all'
  let requiredEngines = []

  const validPlatforms = ['mac-arm64', 'mac-x64', 'win', 'linux', 'all']

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) {
      platform = args[i + 1]
      if (!validPlatforms.includes(platform)) {
        log.error(`Invalid platform: ${platform}`)
        console.log(`Valid platforms: ${validPlatforms.join(', ')}`)
        process.exit(1)
      }
    }

    if (args[i] === '--require-engines' && args[i + 1]) {
      requiredEngines = args[i + 1].split(',').map(e => e.trim()).filter(Boolean)
      const unknown = requiredEngines.filter(e => !VALID_ENGINES.includes(e))
      if (unknown.length > 0) {
        log.error(`Unknown engine(s): ${unknown.join(', ')}`)
        console.log(`Valid engines: ${VALID_ENGINES.join(', ')}`)
        process.exit(1)
      }
    }
  }

  return { platform, requiredEngines }
}

// Main entry point
const { platform, requiredEngines } = parseArgs()
runChecks(platform, requiredEngines)
