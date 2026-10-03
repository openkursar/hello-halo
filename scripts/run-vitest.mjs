/**
 * Run vitest under Electron's Node runtime.
 *
 * Tests load better-sqlite3, which is built against Electron's ABI, so plain
 * Node cannot run them. On macOS the interpreter is the Electron *Helper*
 * binary rather than the main one: every process started from the main binary
 * registers with LaunchServices and puts an "exec" icon in the Dock, and vitest
 * forks one per worker. Elsewhere the main binary has no such side effect.
 *
 * Usage: node scripts/run-vitest.mjs <vitest args...>
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

/** Electron binary to run as Node; the Helper on macOS when it exists. */
function electronBinary() {
  const main = require('electron')
  if (process.platform !== 'darwin') return main

  const macosDir = dirname(main)
  const name = basename(main)
  const helper = join(dirname(macosDir), 'Frameworks', `${name} Helper.app`, 'Contents', 'MacOS', `${name} Helper`)
  return existsSync(helper) ? helper : main
}

const child = spawn(electronBinary(), ['node_modules/vitest/vitest.mjs', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
