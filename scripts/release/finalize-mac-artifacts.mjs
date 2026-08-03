#!/usr/bin/env node
// ============================================================================
// finalize-mac-artifacts — reconcile the two single-arch mac builds
//
// Mac ships as two separate electron-builder runs (arm64, then x64). Each run
// rewrites latest-mac.yml from scratch, so the x64 run erases the arm64 entries.
// Under `--publish always` electron-builder used to re-merge against the yml
// already on the Release; with verify-then-upload (`--publish never`) nothing
// merges it, which would leave Apple Silicon users updating to the Intel build.
//
// This renames the x64 artifacts to their public "Intel" names and writes a
// latest-mac.yml carrying BOTH arches, keeping the two in sync — electron-updater
// picks a file by testing the url for "arm64" (MacUpdater.isArm64), so the
// arm64 entry must keep that token and the Intel entry must not contain it.
//
// Usage:
//   node scripts/release/finalize-mac-artifacts.mjs --dist <dir> --version <v>
//     --arm64-yml <saved-copy-of-arm64-latest-mac.yml>
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { load, dump } from 'js-yaml'
import { c, log } from './lib.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dist': args.dist = argv[++i]; break
      case '--version': args.version = argv[++i]; break
      case '--arm64-yml': args.arm64Yml = argv[++i]; break
      case '--notes-file': args.notesFile = argv[++i]; break
      default:
        console.error(`unknown argument: ${argv[i]}`)
        process.exit(1)
    }
  }
  for (const key of ['dist', 'version', 'arm64Yml']) {
    if (!args[key]) {
      console.error('required: --dist <dir> --version <v> --arm64-yml <path> [--notes-file <path>]')
      process.exit(1)
    }
  }
  return args
}

function fail(message) {
  log.fail(message)
  process.exit(1)
}

function main() {
  const { dist, version, arm64Yml, notesFile } = parseArgs(process.argv)
  const ymlPath = path.join(dist, 'latest-mac.yml')

  if (!fs.existsSync(arm64Yml)) {
    fail(`arm64 update metadata not found: ${arm64Yml} — the arm64 build must save latest-mac.yml before the x64 build overwrites it`)
  }
  if (!fs.existsSync(ymlPath)) {
    fail(`${ymlPath} not found — expected the x64 build to have produced it`)
  }

  // x64 artifact base name → public Intel name
  const renames = [
    [`Halo-${version}.dmg`, `Halo-${version}-Intel.dmg`],
    [`Halo-${version}.dmg.blockmap`, `Halo-${version}-Intel.dmg.blockmap`],
    [`Halo-${version}-mac.zip`, `Halo-${version}-Intel-mac.zip`],
    [`Halo-${version}-mac.zip.blockmap`, `Halo-${version}-Intel-mac.zip.blockmap`],
  ]
  for (const [from, to] of renames) {
    const src = path.join(dist, from)
    const dest = path.join(dist, to)
    if (fs.existsSync(src)) {
      fs.renameSync(src, dest)
      log.ok(`renamed ${from} → ${to}`)
    } else if (fs.existsSync(dest)) {
      log.ok(`already named ${to}`)
    } else if (from.endsWith('.blockmap')) {
      log.warn(`no blockmap for ${from} (differential update will fall back to full download)`)
    } else {
      fail(`x64 artifact missing: ${from}`)
    }
  }

  const armInfo = load(fs.readFileSync(arm64Yml, 'utf8'))
  const x64Info = load(fs.readFileSync(ymlPath, 'utf8'))

  for (const [label, info] of [['arm64', armInfo], ['x64', x64Info]]) {
    if (info?.version !== version) {
      fail(`${label} update metadata is for version "${info?.version}", expected "${version}"`)
    }
  }

  const renameMap = new Map(renames.map(([from, to]) => [from, to]))
  const x64Files = (x64Info.files ?? []).map((f) => ({ ...f, url: renameMap.get(f.url) ?? f.url }))
  const armFiles = armInfo.files ?? []

  const leakedArm64 = x64Files.filter((f) => f.url.includes('arm64'))
  if (leakedArm64.length > 0) {
    fail(`x64 metadata references arm64 files (${leakedArm64.map((f) => f.url).join(', ')}) — Intel clients would update to the wrong build`)
  }
  const armZip = armFiles.find((f) => f.url.endsWith('.zip') && f.url.includes('arm64'))
  const intelZip = x64Files.find((f) => f.url.endsWith('.zip'))
  if (!armZip) fail('arm64 metadata has no arm64 zip entry (electron-updater needs a zip to update mac)')
  if (!intelZip) fail('x64 metadata has no zip entry (electron-updater needs a zip to update mac)')

  // Top-level path/sha512 are the legacy single-file fields; point them at the
  // arm64 zip like previous releases did. Arch selection happens over `files`.
  const merged = {
    version,
    files: [...armFiles, ...x64Files],
    path: armZip.url,
    sha512: armZip.sha512,
    releaseDate: new Date().toISOString(),
  }

  // electron-builder does not write releaseNotes into latest-mac.yml even when
  // --releaseNotesFile is passed (only win/linux get it), so mac update
  // notifications would otherwise fall back to the full GitHub release body.
  // Inject the same summary here so all three platforms show identical text.
  if (notesFile) {
    if (!fs.existsSync(notesFile)) {
      fail(`--notes-file not found: ${notesFile}`)
    }
    const notes = fs.readFileSync(notesFile, 'utf8').trim()
    if (notes) merged.releaseNotes = notes + '\n'
    else log.warn('notes file is empty — latest-mac.yml will have no releaseNotes')
  }

  for (const f of merged.files) {
    if (!fs.existsSync(path.join(dist, f.url))) {
      fail(`latest-mac.yml would reference a missing file: ${f.url}`)
    }
  }

  fs.writeFileSync(ymlPath, dump(merged, { lineWidth: -1 }), 'utf8')
  fs.rmSync(arm64Yml, { force: true })

  log.ok(`latest-mac.yml carries both arches (${merged.files.map((f) => f.url).join(', ')})`)
  if (merged.releaseNotes) log.ok('latest-mac.yml carries releaseNotes for the update notification')
  log.info(`${c.green}finalize-mac-artifacts passed${c.reset}`)
}

main()
