/**
 * Post-install script
 *
 * Runs after `npm install` to set up the development environment:
 * 1. patch-package  — apply SDK patches
 * 2. SDK cli dedup  — symlink agent-sdk/cli.js → claude-code/cli.js (save ~13MB)
 * 3. Download the Electron runtime
 * 4. Rebuild native modules for Electron
 */

import { execSync } from 'child_process'
import { copyFileSync, unlinkSync, symlinkSync, lstatSync } from 'fs'
import { dirname, join } from 'path'

const run = (cmd) => execSync(cmd, { stdio: 'inherit' })

if (Number(process.versions.napi) < 10) {
  throw new Error('Halo requires a Node runtime with N-API 10 (Node 22.14.0+ or 24+) for its native dependencies.')
}

// 1. Apply patches to @anthropic-ai/claude-agent-sdk
run('patch-package')

// 2. Deduplicate CLI binary: agent-sdk ships its own cli.js (~13MB) identical
//    to claude-code/cli.js. Replace with a symlink to save disk & ensure we
//    always run the claude-code version (which is the canonical CLI package).
const sdkCli = 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js'
const target = '../claude-code/cli.js' // relative from agent-sdk dir
try {
  const stat = lstatSync(sdkCli)
  if (stat.isSymbolicLink() || stat.isFile()) unlinkSync(sdkCli)
} catch { /* file doesn't exist yet, that's fine */ }
try {
  symlinkSync(target, sdkCli)
  console.log(`  ✔ ${sdkCli} → ${target}`)
} catch (err) {
  // Windows allows symlinks only with Developer Mode or admin rights; a copy
  // keeps the same content, it just forgoes the disk saving.
  if (err.code !== 'EPERM') throw err
  copyFileSync(join(dirname(sdkCli), target), sdkCli)
  console.log(`  ✔ ${sdkCli} copied from ${target} (symlinks not permitted)`)
}

// 3. Prepare Electron and native dependencies. Packaging-only machines can
//    skip the host runtime with HALO_SKIP_NATIVE_REBUILD=1.
if (process.env.HALO_SKIP_NATIVE_REBUILD === '1') {
  console.log('  - native rebuild skipped (HALO_SKIP_NATIVE_REBUILD=1)')
} else {
  // Electron 42+ downloads on first CLI use; Node API consumers need it now.
  run('install-electron')
  run('electron-builder install-app-deps')
}
