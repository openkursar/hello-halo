#!/usr/bin/env node

/**
 * Binary Dependencies Checker
 *
 * Verifies that all required binary dependencies are present before packaging.
 * This prevents shipping broken builds to users.
 *
 * Usage: node tests/check/binaries.mjs [--platform mac-arm64|mac-x64|win|linux|all]
 *
 * Platforms:
 *   mac-arm64 - Mac Apple Silicon (M1/M2/M3/M4)
 *   mac-x64   - Mac Intel
 *   win       - Windows x64
 *   linux     - Linux x64
 *   all       - All platforms (default)
 *
 * Exit codes:
 *   0 - All checks passed
 *   1 - One or more checks failed
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
 */
const BINARY_DEPENDENCIES = [
  {
    name: 'Mac arm64 cloudflared',
    path: 'node_modules/cloudflared/bin/cloudflared',
    platform: 'mac-arm64',
    fix: 'npm install (triggers postinstall) or npm run prepare:mac-arm64',
    validate: (filePath) => {
      try {
        const output = execSync(`file "${filePath}"`, { encoding: 'utf-8' })
        const arch = output.includes('arm64') ? 'arm64' : output.includes('x86_64') ? 'x64' : 'unknown'
        return { valid: true, info: arch }
      } catch {
        return { valid: false, info: 'cannot read file type' }
      }
    }
  },
  {
    name: 'Mac x64 cloudflared',
    path: 'node_modules/cloudflared/bin/cloudflared-darwin-x64',
    platform: 'mac-x64',
    fix: 'npm run prepare:mac-x64',
    validate: (filePath) => {
      try {
        const stats = fs.statSync(filePath)
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1)
        // Mac x64 binary should be > 30MB
        return { valid: stats.size > 30 * 1024 * 1024, info: `${sizeMB} MB` }
      } catch {
        return { valid: false, info: 'cannot read file' }
      }
    }
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
  }
]

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
 * Run all binary checks
 */
function runChecks(targetPlatform = 'all') {
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

  if (hasErrors) {
    log.error('Binary check failed! Fix the issues above before packaging.')
    process.exit(1)
  } else {
    log.success('All binary dependencies are present.')
    process.exit(0)
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2)
  let platform = 'all'

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
  }

  return { platform }
}

// Main entry point
const { platform } = parseArgs()
runChecks(platform)
