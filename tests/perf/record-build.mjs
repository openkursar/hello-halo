#!/usr/bin/env node
/**
 * Run once, right after `npm run build` (and, if applicable, the
 * electron-builder packaging step) — captures which commit, dirty-state and
 * artifact kind the binary under test was actually built from, as a sidecar
 * JSON next to each build output. `tests/perf/lib/build-identity.ts` reads
 * this at test time instead of the live HEAD, so a result reflects the binary
 * rather than whatever the working tree drifted to since the build ran.
 *
 * The artifact kind matters as much as the sha: `out/main` (electron-vite,
 * what the perf fixture launches) and a packaged `.app` can carry the same
 * commit while differing in asar packing and signing.
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '../..')

// Kept in sync with ARTIFACT_DIRS in lib/build-identity.ts.
const ARTIFACT_DIRS = [
  ['out/main', 'electron-vite'],
  ['dist/mac-arm64', 'packaged-mac-arm64'],
  ['dist/mac', 'packaged-mac-x64'],
  ['dist/win-unpacked', 'packaged-win'],
  ['dist/linux-unpacked', 'packaged-linux']
]

function sh(cmd) {
  return execSync(cmd, { cwd: projectRoot, encoding: 'utf-8' }).trim()
}

const sha = sh('git rev-parse HEAD')
const dirty = sh('git status --porcelain').length > 0
const recordedAt = new Date().toISOString()

let written = 0
for (const [rel, artifactKind] of ARTIFACT_DIRS) {
  const dir = path.join(projectRoot, rel)
  if (!fs.existsSync(dir)) continue
  fs.writeFileSync(
    path.join(dir, '.build-identity.json'),
    JSON.stringify({ sha, dirty, artifactKind, recordedAt }, null, 2)
  )
  console.log(`[record-build] wrote ${rel}/.build-identity.json (${artifactKind})`)
  written++
}

if (written === 0) {
  console.error('[record-build] No build output directory found (out/main, dist/*). Run npm run build first.')
  process.exit(1)
}

console.log(`[record-build] sha=${sha}${dirty ? ' (dirty)' : ''}`)
