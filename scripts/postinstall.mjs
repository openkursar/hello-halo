/**
 * Post-install script
 *
 * Runs after `npm install` to set up the development environment:
 * 1. patch-package  — apply SDK patches
 * 2. SDK cli dedup  — symlink agent-sdk/cli.js → claude-code/cli.js (save ~13MB)
 * 3. electron-builder install-app-deps
 * 4. electron-rebuild for better-sqlite3
 */

import { execSync } from 'child_process'
import { copyFileSync, unlinkSync, symlinkSync, lstatSync } from 'fs'
import { dirname, join } from 'path'

const run = (cmd) => execSync(cmd, { stdio: 'inherit' })

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

// 3. Rebuild native modules for Electron. Only needed to run Electron from this
//    checkout: packaging swaps in prebuilt binaries (afterPack), so a packaging-
//    only machine without a C++ toolchain sets HALO_SKIP_NATIVE_REBUILD=1.
if (process.env.HALO_SKIP_NATIVE_REBUILD === '1') {
  console.log('  - native rebuild skipped (HALO_SKIP_NATIVE_REBUILD=1)')
} else {
  run('electron-builder install-app-deps')
  run('electron-rebuild -f -w better-sqlite3')
}
