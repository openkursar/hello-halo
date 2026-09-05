#!/usr/bin/env node
/**
 * Run once, right after `npm run build` (and, if applicable, the
 * electron-builder packaging step) — captures which commit + dirty-state the
 * binary under test was actually built from, as a sidecar JSON next to the
 * build output. `tests/perf/lib/build-identity.ts` reads this at test time
 * instead of the live HEAD, so a result JSON's `gitSha` field reflects the
 * binary, not whatever the working tree drifted to since the build ran.
 *
 * Writes to every build output directory that exists:
 *   out/main/.build-identity.json               (dev build, out/main/index.mjs)
 *   dist/mac-arm64/.build-identity.json          (packaged mac arm64)
 *   dist/mac/.build-identity.json                (packaged mac x64)
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '../..')

function sh(cmd) {
  return execSync(cmd, { cwd: projectRoot, encoding: 'utf-8' }).trim()
}

const sha = sh('git rev-parse HEAD')
const dirty = sh('git status --porcelain').length > 0
const identity = { sha, dirty, recordedAt: new Date().toISOString() }

const candidateDirs = ['out/main', 'dist/mac-arm64', 'dist/mac', 'dist/win-unpacked', 'dist/linux-unpacked']

let written = 0
for (const rel of candidateDirs) {
  const dir = path.join(projectRoot, rel)
  if (!fs.existsSync(dir)) continue
  fs.writeFileSync(path.join(dir, '.build-identity.json'), JSON.stringify(identity, null, 2))
  console.log(`[record-build] wrote ${rel}/.build-identity.json`)
  written++
}

if (written === 0) {
  console.error('[record-build] No build output directory found (out/main, dist/*). Run npm run build first.')
  process.exit(1)
}

console.log(`[record-build] sha=${sha}${dirty ? ' (dirty)' : ''}`)
