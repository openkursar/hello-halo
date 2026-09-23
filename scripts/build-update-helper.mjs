#!/usr/bin/env node
// ============================================================================
// build-update-helper — compile the Windows update helper into resources/
//
// The helper performs the directory swap that applies a staged update. It has
// to be a native binary: by the time it runs, the Electron runtime that would
// otherwise host that code has already been moved aside.
//
// It is built here rather than committed because it must be compiled from the
// same source tree as the app it updates — a helper and an app that disagree
// about the staging layout is exactly the failure this whole path is designed
// to avoid.
//
// Usage:
//   node scripts/build-update-helper.mjs            # windows/amd64 (for packaging)
//   node scripts/build-update-helper.mjs --host     # also build for this machine
//
// Exit codes: 0 ok · 1 failure (a Windows build without a helper must not ship)
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE_DIR = join(ROOT, 'win-update-helper')
const OUTPUT_DIR = join(ROOT, 'resources', 'update-helper')

function fail(message) {
  console.error(`[update-helper] ${message}`)
  process.exit(1)
}

function run(command, args, env) {
  try {
    execFileSync(command, args, {
      cwd: MODULE_DIR,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    })
  } catch (error) {
    fail(`${command} ${args.join(' ')} failed: ${error.message}`)
  }
}

function main() {
  if (!existsSync(MODULE_DIR)) {
    fail(`helper source not found at ${MODULE_DIR}`)
  }

  try {
    execFileSync('go', ['version'], { stdio: 'ignore' })
  } catch {
    fail('Go toolchain not found — required to build the Windows update helper')
  }

  mkdirSync(OUTPUT_DIR, { recursive: true })

  // The helper is what stands between a failed update and an app that will not
  // start, so its tests gate the build rather than being a separate step
  // someone can forget.
  console.log('[update-helper] running helper tests...')
  run('go', ['test', './...'])

  console.log('[update-helper] building windows/amd64...')
  run(
    'go',
    ['build', '-trimpath', '-ldflags=-s -w', '-o', join(OUTPUT_DIR, 'halo-update-helper.exe'), './cmd/halo-update-helper'],
    { GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' }
  )

  if (process.argv.includes('--host')) {
    // The packer runs on the build machine, not on a user's, so it is built
    // for whatever this machine is.
    console.log('[update-helper] building packer for this machine...')
    run('go', ['build', '-trimpath', '-o', join(MODULE_DIR, 'bin', 'halo-update-packer'), './cmd/halo-update-packer'], {
      CGO_ENABLED: '0',
    })
  }

  console.log(`[update-helper] done -> ${OUTPUT_DIR}`)
}

main()
