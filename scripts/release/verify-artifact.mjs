#!/usr/bin/env node
// ============================================================================
// verify-artifact — post-build gate
//
// Verifies the DIST OUTPUT (not the environment): every packaged app must
// contain the product.json that verify-inputs materialized, every required
// engine, and every expected artifact file must exist with a consistent
// update-yml version. Finalizes the build record started by verify-inputs.
// See README.md.
//
// Usage:
//   node scripts/release/verify-artifact.mjs --manifest <path>
//     [--record <path>] [--dist <dir>] [--platforms <csv|all>]
//
// Exit codes: 0 ok · 1 failure
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import {
  c, log, loadManifest, sha256File, sha256Buffer, getByPath, isEmptyValue,
  asarList, asarRead, readRecord, writeRecord,
} from './lib.mjs'

function parseArgs(argv) {
  const args = { platforms: 'all' }
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--manifest': args.manifest = argv[++i]; break
      case '--record': args.record = argv[++i]; break
      case '--dist': args.dist = argv[++i]; break
      case '--platforms': args.platforms = argv[++i]; break
      default:
        console.error(`unknown argument: ${argv[i]}`)
        process.exit(1)
    }
  }
  if (!args.manifest) {
    console.error('required: --manifest <build-manifest.json>')
    process.exit(1)
  }
  return args
}

/** Engine id → npm package that carries it (kept in step with engine-runtimes.cjs). */
const ENGINE_PACKAGES = {
  anthropic: '@anthropic-ai/claude-agent-sdk',
  halo: '@hello-halo/agent-sdk',
  codex: '@openai/codex-sdk',
}

/** Find every packaged app.asar under dist (mac .app bundles + *-unpacked). */
function findPackagedApps(dist) {
  const found = []
  if (!fs.existsSync(dist)) return found
  for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(dist, entry.name)
    if (/^mac(-|$)/.test(entry.name)) {
      for (const sub of fs.readdirSync(dir)) {
        if (sub.endsWith('.app')) {
          const asar = path.join(dir, sub, 'Contents', 'Resources', 'app.asar')
          if (fs.existsSync(asar)) found.push({ label: `${entry.name}/${sub}`, asar })
        }
      }
    } else if (entry.name.endsWith('-unpacked')) {
      const asar = path.join(dir, 'resources', 'app.asar')
      if (fs.existsSync(asar)) found.push({ label: entry.name, asar })
    }
  }
  return found
}

function checkAsar(app, { manifest, record, problems }) {
  let listing
  try {
    listing = new Set(asarList(app.asar))
  } catch (err) {
    problems.push(`${app.label}: cannot read asar (${err.message})`)
    return
  }

  // product.json present + identical to what verify-inputs materialized
  if (!listing.has('product.json')) {
    problems.push(`${app.label}: product.json missing from asar`)
  } else {
    const buf = asarRead(app.asar, 'product.json')
    const hash = sha256Buffer(buf)
    if (record.product?.sha256 && hash !== record.product.sha256) {
      problems.push(`${app.label}: product.json hash mismatch (packed ${hash.slice(0, 12)} ≠ recorded ${record.product.sha256.slice(0, 12)}) — packaged config differs from what verify-inputs materialized`)
    } else {
      log.ok(`${app.label}: product.json hash matches`)
    }
    const content = JSON.parse(buf.toString('utf8'))
    for (const fieldPath of manifest.requiredProductFields) {
      if (isEmptyValue(getByPath(content, fieldPath))) {
        problems.push(`${app.label}: product.json field "${fieldPath}" empty INSIDE the package`)
      }
    }
  }

  // engines physically present
  const unpackedRoot = app.asar + '.unpacked'
  for (const engine of manifest.requiredEngines) {
    const pkg = ENGINE_PACKAGES[engine]
    const rel = `node_modules/${pkg}/package.json`
    const inAsar = listing.has(rel)
    const inUnpacked = fs.existsSync(path.join(unpackedRoot, rel))
    if (!inAsar && !inUnpacked) {
      problems.push(`${app.label}: engine "${engine}" (${pkg}) missing from package`)
    } else {
      log.ok(`${app.label}: engine ${engine} present`)
    }
  }
}

function main() {
  const args = parseArgs(process.argv)
  const manifest = loadManifest(args.manifest)
  const mainRepo = manifest.repoPaths.main
  const dist = args.dist ?? path.join(mainRepo, 'dist')
  const recordPath = args.record ?? path.join(dist, 'build-record.json')

  const record = readRecord(recordPath)
  if (!record) {
    log.fail(`build record not found: ${recordPath} — run verify-inputs first (artifact checks depend on the pre-build record)`)
    process.exit(1)
  }

  const version = JSON.parse(fs.readFileSync(path.join(mainRepo, 'package.json'), 'utf8')).version
  // Artifact filenames use electron-builder's productName, which a variant may
  // override away from product.json's display name — manifest wins.
  const productName = manifest.productName ?? record.product?.content?.name ?? 'Halo'
  // electron-updater channel: prerelease id ("rc" in 2.1.13-rc.3) names the
  // update yml (rc-mac.yml); stable versions use latest-mac.yml.
  const channel = version.includes('-') ? version.split('-')[1].split('.')[0] : 'latest'
  log.info(`variant=${record.variant} version=${version} dist=${dist}`)

  const problems = []

  // -- 1. Packaged apps: asar-level assertions -------------------------------
  const apps = findPackagedApps(dist)
  if (apps.length === 0) {
    problems.push(`no packaged app found under ${dist} (expected mac*/…/app.asar or *-unpacked/resources/app.asar)`)
  }
  for (const app of apps) checkAsar(app, { manifest, record, problems })

  // -- 2. Expected artifact files for the built platforms --------------------
  const platformKeys = args.platforms === 'all'
    ? Object.keys(manifest.expectedArtifacts)
    : args.platforms.split(',').map((s) => s.trim()).filter(Boolean)

  const artifactHashes = {}
  for (const key of platformKeys) {
    const patterns = manifest.expectedArtifacts[key]
    if (!patterns) {
      problems.push(`platform "${key}" not declared in expectedArtifacts`)
      continue
    }
    for (const pattern of patterns) {
      const name = pattern
        .replaceAll('{version}', version)
        .replaceAll('{productName}', productName)
        .replaceAll('{channel}', channel)
      const file = path.join(dist, name)
      if (!fs.existsSync(file)) {
        problems.push(`expected artifact missing: ${name} (platform ${key})`)
        continue
      }
      if (name.endsWith('.yml')) {
        const ymlVersion = (fs.readFileSync(file, 'utf8').match(/^version:\s*(.+)$/m) ?? [])[1]?.trim()
        if (ymlVersion !== version) {
          problems.push(`${name}: version "${ymlVersion}" ≠ package.json "${version}" — auto-update would point at the wrong version`)
          continue
        }
      }
      artifactHashes[name] = sha256File(file)
      log.ok(`artifact: ${name}`)
    }
  }

  // -- 3. Finalize record ----------------------------------------------------
  record.version = version
  record.artifacts = artifactHashes
  record.checks = { ...record.checks, artifact: problems.length === 0 ? 'passed' : 'failed' }
  record.finishedAt = new Date().toISOString()
  writeRecord(recordPath, record)

  console.log('')
  if (problems.length > 0) {
    console.log(`${c.red}${c.bold}[ARTIFACT VERIFICATION FAILED — do not publish]${c.reset}`)
    for (const p of problems) log.fail(p)
    process.exit(1)
  }
  if (record.mode !== 'release') {
    log.warn(`${record.mode}-mode artifact (may contain uncommitted changes) — local verification only, do not distribute`)
  }
  log.info(`${c.green}verify-artifact passed${c.reset} → ${recordPath}`)
  log.info('after a successful release: cp ' + recordPath + ' <variant>/last-release-record.json (baseline for the next build)')
}

main()
