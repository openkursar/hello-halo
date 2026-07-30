#!/usr/bin/env node
// ============================================================================
// verify-inputs — pre-build gate
//
// Asserts every build input declared in the variant's build-manifest.json
// BEFORE anything is compiled, materializes product.json from the variant
// source, diffs against the last release record, and writes the build record
// that verify-artifact finalizes after packaging. See README.md.
//
// Usage:
//   node scripts/release/verify-inputs.mjs --manifest <path> [--mode release|dev]
//     [--baseline <path>] [--record <path>] [--platforms <csv|all>]
//     [--confirm-sensitive]
//
// Exit codes: 0 ok · 1 missing/hard failure · 2 unconfirmed sensitive diff
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  c, log, loadManifest, gitState, sha256File, getByPath, isEmptyValue,
  readRecord, writeRecord, diffAgainstBaseline, printDiffReport, confirmSensitive,
} from './lib.mjs'

function parseArgs(argv) {
  const args = { mode: 'dev', platforms: 'all', confirmSensitive: false }
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--manifest': args.manifest = argv[++i]; break
      case '--mode': args.mode = argv[++i]; break
      case '--baseline': args.baseline = argv[++i]; break
      case '--record': args.record = argv[++i]; break
      case '--platforms': args.platforms = argv[++i]; break
      case '--confirm-sensitive': args.confirmSensitive = true; break
      default:
        console.error(`unknown argument: ${argv[i]}`)
        process.exit(1)
    }
  }
  if (!args.manifest) {
    console.error('required: --manifest <build-manifest.json>')
    process.exit(1)
  }
  if (!['release', 'dev'].includes(args.mode)) {
    console.error(`--mode must be release|dev, got: ${args.mode}`)
    process.exit(1)
  }
  return args
}

function fail(message) {
  log.fail(message)
  process.exit(1)
}

async function main() {
  const args = parseArgs(process.argv)
  const manifest = loadManifest(args.manifest)
  const mainRepo = manifest.repoPaths.main
  const recordPath = args.record ?? path.join(mainRepo, 'dist', 'build-record.json')
  const baselinePath = args.baseline ?? path.join(manifest.dir, 'last-release-record.json')

  log.info(`variant=${manifest.variant} mode=${args.mode}`)
  const problems = []

  // -- 1. Git state of every declared repo -----------------------------------
  const repoStates = {}
  for (const [name, repoPath] of Object.entries(manifest.repoPaths)) {
    let state
    try {
      state = gitState(repoPath)
    } catch (err) {
      fail(`repo "${name}": ${err.message}`)
    }
    repoStates[name] = state

    const label = `${name} @ ${state.sha.slice(0, 9)} (${state.branch})`
    if (args.mode === 'release') {
      if (state.dirty) {
        problems.push(`repo "${name}" has uncommitted changes (release mode requires clean):\n` +
          state.dirtyFiles.slice(0, 10).map((f) => `        ${f}`).join('\n'))
      } else if (state.unpushed !== false) {
        // Current flows push after a successful build, so unpushed HEAD is a
        // warning here; the recorded SHA only becomes reproducible once pushed.
        log.warn(`git: ${label} clean but not pushed — push after a successful build or the recorded SHA is not reproducible`)
      } else {
        log.ok(`git: ${label} clean+pushed`)
      }
    } else {
      if (state.dirty) log.warn(`git: ${label} DIRTY (${state.dirtyFiles.length} files) — dev build, will be marked`)
      else log.ok(`git: ${label}`)
    }
  }

  // -- 2. Required environment variables (names checked, values never shown) --
  for (const key of manifest.requiredEnv) {
    const value = process.env[key]
    if (value === undefined || value.trim() === '') {
      problems.push(`required env "${key}" is missing or empty`)
    } else {
      log.ok(`env: ${key} present`)
    }
  }

  // -- 3. Materialize product.json from the variant source -------------------
  if (!fs.existsSync(manifest.productPath)) {
    fail(`variant product file not found: ${manifest.productPath}`)
  }
  let productContent
  try {
    productContent = JSON.parse(fs.readFileSync(manifest.productPath, 'utf8'))
  } catch (err) {
    fail(`variant product file is not valid JSON: ${err.message}`)
  }
  const materialized = path.join(mainRepo, 'product.json')
  fs.copyFileSync(manifest.productPath, materialized)
  const productHash = sha256File(materialized)
  log.ok(`product.json materialized from ${path.relative(manifest.dir, manifest.productPath)} (${productHash.slice(0, 12)})`)

  for (const fieldPath of manifest.requiredProductFields) {
    if (isEmptyValue(getByPath(productContent, fieldPath))) {
      problems.push(`product.json field "${fieldPath}" is missing or empty`)
    } else {
      log.ok(`product: ${fieldPath} non-empty`)
    }
  }

  // -- 4. Engines + binaries -------------------------------------------------
  try {
    execFileSync(process.execPath, [
      path.join(mainRepo, 'tests', 'check', 'binaries.mjs'),
      '--platform', args.platforms,
      ...(manifest.requiredEngines.length > 0
        ? ['--require-engines', manifest.requiredEngines.join(',')]
        : []),
    ], { cwd: mainRepo, stdio: 'inherit' })
    log.ok(`engines/binaries check passed (${manifest.requiredEngines.join(',') || 'no engines required'})`)
  } catch {
    problems.push('engines/binaries check failed (see output above)')
  }

  // -- 5. SDK version (when the halo engine is required) ---------------------
  let sdk
  if (manifest.requiredEngines.includes('halo')) {
    const sdkPkg = path.join(mainRepo, 'node_modules', '@hello-halo', 'agent-sdk', 'package.json')
    if (fs.existsSync(sdkPkg)) {
      sdk = { version: JSON.parse(fs.readFileSync(sdkPkg, 'utf8')).version }
      const sdkSrc = path.join(mainRepo, 'src', 'sdk', 'halo-sdk')
      try {
        sdk.sha = gitState(sdkSrc).sha
      } catch { /* sdk source may be a plain package, not a checkout */ }
      log.ok(`sdk: @hello-halo/agent-sdk ${sdk.version}${sdk.sha ? ` @ ${sdk.sha.slice(0, 9)}` : ''}`)
    }
    // Absence is already reported by the engines check above.
  }

  // -- Hard failures block before any diffing --------------------------------
  if (problems.length > 0) {
    console.log('')
    console.log(`${c.red}${c.bold}[MISSING → build blocked]${c.reset}`)
    for (const p of problems) log.fail(p)
    process.exit(1)
  }

  // -- 6. Baseline diff (vs last successful release) -------------------------
  const version = JSON.parse(fs.readFileSync(path.join(mainRepo, 'package.json'), 'utf8')).version
  const current = {
    schema: 1,
    variant: manifest.variant,
    mode: args.mode,
    createdAt: new Date().toISOString(),
    version,
    repos: repoStates,
    sdk,
    requiredEnv: manifest.requiredEnv,
    requiredEngines: manifest.requiredEngines,
    expectedArtifacts: manifest.expectedArtifacts,
    product: {
      source: path.relative(manifest.dir, manifest.productPath),
      sha256: productHash,
      content: productContent,
    },
    checks: { inputs: 'passed' },
  }

  const baseline = readRecord(baselinePath)
  const diff = diffAgainstBaseline(manifest, current, baseline)
  printDiffReport(diff, baseline ? `${baseline.variant} v${baseline.version}` : 'none')

  if (diff.sensitive.length > 0) {
    const { confirmed, confirmedBy } = await confirmSensitive(diff.sensitive, {
      flagConfirm: args.confirmSensitive,
    })
    if (!confirmed) {
      console.log('')
      log.fail('unconfirmed sensitive changes. Review the report above, then rerun with --confirm-sensitive (or HALO_CONFIRM_SENSITIVE=1), or confirm interactively.')
      process.exit(2)
    }
    current.confirmations = diff.sensitive.map((ch) => ({
      path: ch.path, from: ch.from, to: ch.to, confirmedBy,
    }))
  }

  writeRecord(recordPath, current)
  console.log('')
  log.info(`${c.green}verify-inputs passed${c.reset} → ${recordPath}`)
}

main().catch((err) => {
  log.fail(err.stack || String(err))
  process.exit(1)
})
