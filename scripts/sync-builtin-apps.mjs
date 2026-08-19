#!/usr/bin/env node
/**
 * sync-builtin-apps.mjs — Build-time built-in digital human sync
 *
 * Reads the `builtinApps` section of product.json (if present) and copies the
 * declared app folders from an external SSOT directory into
 * `resources/builtin-apps/<specId>/`, then writes a normalized `manifest.json`
 * that the runtime loader (src/main/apps/manager/builtin-loader.ts) consumes
 * at startup.
 *
 * Open-source builds with no `builtinApps` field (or with an empty list) are a
 * supported state — this script logs the situation and exits successfully so
 * `npm run build` still works on a vanilla checkout.
 *
 * The destination directory `resources/builtin-apps/` is git-ignored. Treating
 * it as a build artifact keeps the open-source repository free of any specific
 * enterprise's bundled apps; each variant points its own product.*.json at its
 * own SSOT (e.g. `../digital-human-protocol-<variant>/packages/digital-humans`).
 *
 * Architecture parallel: VSCode's built-in extensions live in
 * `resources/app/extensions/` and are scanned at startup, separate from the
 * marketplace install path. Halo follows the same separation — the loader at
 * src/main/apps/manager/builtin-loader.ts is the equivalent of VSCode's
 * BuiltinExtensionsScannerService.
 *
 * Usage:
 *   node scripts/sync-builtin-apps.mjs              # uses product.json
 *   HALO_BUILTIN_APPS_SOURCE=/abs/path node scripts/sync-builtin-apps.mjs
 *
 * Override env var takes precedence over product.json's sourcePath. Useful in
 * CI when the SSOT lives at a non-standard location.
 *
 * Exit codes:
 *   0  — success (including the "no builtinApps configured" no-op case)
 *   1  — configuration or filesystem error
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, cpSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncProductJson } from './product-source.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '..')
const PRODUCT_JSON = join(PROJECT_ROOT, 'product.json')
const DEST_DIR = join(PROJECT_ROOT, 'resources', 'builtin-apps')

// ANSI codes for friendly logging — same convention as other scripts/*.mjs
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
}

const log = {
  info: (msg) => console.log(`${c.blue}[builtin-apps]${c.reset} ${msg}`),
  ok:   (msg) => console.log(`${c.green}[builtin-apps]${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}[builtin-apps]${c.reset} ${msg}`),
  err:  (msg) => console.error(`${c.red}[builtin-apps]${c.reset} ${msg}`),
}

/**
 * Load product.json. Returns null when the file is missing — that case is
 * common (open-source dev checkout before deploy_*.sh has copied a variant)
 * and is treated as "nothing to bundle".
 */
function loadProductConfig() {
  if (!existsSync(PRODUCT_JSON)) {
    log.warn(`product.json not found at ${PRODUCT_JSON} — skipping (no built-in apps will be bundled).`)
    return null
  }
  try {
    return JSON.parse(readFileSync(PRODUCT_JSON, 'utf8'))
  } catch (err) {
    log.err(`Failed to parse product.json: ${err.message}`)
    process.exit(1)
  }
}

/**
 * Resolve the SSOT path. Env override wins. Otherwise relative paths are
 * resolved against the project root so product.json authors can write paths
 * like `../digital-human-protocol-<variant>/packages/digital-humans`.
 */
function resolveSourcePath(productSourcePath) {
  const envOverride = process.env.HALO_BUILTIN_APPS_SOURCE
  const raw = envOverride && envOverride.length > 0 ? envOverride : productSourcePath
  if (!raw) return null
  return isAbsolute(raw) ? raw : resolve(PROJECT_ROOT, raw)
}

/**
 * Validate a single app entry from product.json. Throws (caught by main) on
 * invalid entries so misconfiguration surfaces at build time, not runtime.
 */
function normalizeEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`builtinApps.apps[${index}] is not an object`)
  }
  if (typeof entry.specId !== 'string' || entry.specId.length === 0) {
    throw new Error(`builtinApps.apps[${index}].specId must be a non-empty string`)
  }
  // Defensive: prevent path traversal in specId
  if (entry.specId.includes('/') || entry.specId.includes('\\') || entry.specId.startsWith('.')) {
    throw new Error(`builtinApps.apps[${index}].specId contains illegal characters: "${entry.specId}"`)
  }
  const spaceId = entry.spaceId === null ? null : (entry.spaceId ?? 'halo-temp')
  if (spaceId !== null && (typeof spaceId !== 'string' || spaceId.length === 0)) {
    throw new Error(`builtinApps.apps[${index}].spaceId must be a string, null, or omitted`)
  }
  const defaultStatus = entry.defaultStatus ?? 'paused'
  if (defaultStatus !== 'active' && defaultStatus !== 'paused') {
    throw new Error(`builtinApps.apps[${index}].defaultStatus must be 'active' or 'paused'`)
  }
  return { specId: entry.specId, spaceId, defaultStatus }
}

/**
 * Wipe and recreate the destination so stale entries from a previous build
 * (e.g. after switching from one product.<variant>.json to another) cannot
 * leak into the bundled artifact.
 */
function resetDestination() {
  if (existsSync(DEST_DIR)) {
    rmSync(DEST_DIR, { recursive: true, force: true })
  }
  mkdirSync(DEST_DIR, { recursive: true })
}

/**
 * Copy one app folder. Validates the source has at least a spec.yaml so build
 * fails loudly when product.json references a missing or moved app.
 *
 * `verbatimSymlinks: true` keeps symlinks as symlinks rather than dereferencing
 * them — a defensive measure so a poisoned SSOT directory containing a link
 * to e.g. `/etc` cannot trick the build into copying arbitrary host files
 * into the bundle.
 */
function copyApp(sourceRoot, entry) {
  const src = join(sourceRoot, entry.specId)
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`Built-in app source not found: ${src}`)
  }
  const specPath = join(src, 'spec.yaml')
  if (!existsSync(specPath)) {
    throw new Error(`Missing spec.yaml in built-in app source: ${specPath}`)
  }
  const dest = join(DEST_DIR, entry.specId)
  cpSync(src, dest, { recursive: true, verbatimSymlinks: true })
  log.info(`copied ${entry.specId} (space=${entry.spaceId === null ? 'global' : entry.spaceId}, defaultStatus=${entry.defaultStatus})`)
}

/**
 * Write the runtime manifest atomically (write to a temp file then rename) so a
 * crash mid-write cannot leave the loader staring at half-baked JSON. Keeping
 * the manifest beside the copied app folders means the loader needs only one
 * filesystem lookup at startup.
 *
 * `intentionalEmpty` is true only when product.json explicitly declares
 * `builtinApps.apps: []`. The runtime loader uses this flag to distinguish
 * "build author really meant zero builtins" from "this build has no builtinApps
 * config at all" — the latter case must NOT trigger GC of pre-existing rows.
 */
function writeManifest(entries, sourceRoot, intentionalEmpty) {
  const manifest = {
    /** Manifest format version. Bump when the loader needs a breaking change. */
    version: 1,
    /** Build-time SSOT path — informational, used in logs only. */
    sourcePath: sourceRoot,
    /** UTC timestamp when this build was generated. */
    generatedAt: new Date().toISOString(),
    apps: entries.map(e => ({
      specId: e.specId,
      spaceId: e.spaceId,
      defaultStatus: e.defaultStatus,
    })),
    intentionalEmpty: intentionalEmpty === true,
  }
  const finalPath = join(DEST_DIR, 'manifest.json')
  const tmpPath = `${finalPath}.tmp`
  const json = JSON.stringify(manifest, null, 2) + '\n'
  writeFileSync(tmpPath, json, 'utf8')
  // POSIX rename is atomic; on Windows it's atomic when both paths are on the
  // same volume, which is our case (both inside resources/builtin-apps/).
  renameSync(tmpPath, finalPath)
}

async function main() {
  // Bring product.json in line with the machine-local variant choice before
  // anything reads it. `--interactive` (dev entry only) allows a first-run
  // picker when no variant has been selected yet.
  await syncProductJson({ interactive: process.argv.includes('--interactive') })

  const product = loadProductConfig()
  const builtinConfig = product?.builtinApps

  // ── No builtinApps section at all ───────────────────────────────────────
  // Open-source default. Reset the destination (so a previous enterprise
  // variant's artifacts don't leak in) and write a manifest with
  // intentionalEmpty=false so the runtime loader knows NOT to garbage-collect
  // existing built-in rows.
  if (!builtinConfig) {
    log.info('No builtinApps configured in product.json — bundling zero built-in digital humans.')
    resetDestination()
    writeManifest([], '', /* intentionalEmpty */ false)
    return
  }

  // ── Explicitly empty apps array ────────────────────────────────────────
  // Author wants to remove all built-ins (e.g. switching from an enterprise
  // variant back to open-source while keeping the section as documentation).
  // Mark intentionalEmpty=true so the runtime loader runs GC.
  if (!Array.isArray(builtinConfig.apps) || builtinConfig.apps.length === 0) {
    log.info('builtinApps.apps is empty — intentional zero-builtins build.')
    resetDestination()
    writeManifest([], builtinConfig.sourcePath ?? '', /* intentionalEmpty */ true)
    return
  }

  const sourceRoot = resolveSourcePath(builtinConfig.sourcePath)
  if (!sourceRoot) {
    log.err('builtinApps.sourcePath is missing and HALO_BUILTIN_APPS_SOURCE is not set.')
    process.exit(1)
  }
  if (!existsSync(sourceRoot)) {
    log.err(`Built-in apps source directory does not exist: ${sourceRoot}`)
    log.err('Either fix builtinApps.sourcePath in product.json or set HALO_BUILTIN_APPS_SOURCE.')
    process.exit(1)
  }

  log.info(`source: ${sourceRoot}`)
  log.info(`destination: ${DEST_DIR}`)

  const entries = builtinConfig.apps.map(normalizeEntry)

  // Detect duplicate specId in manifest — would otherwise cause silent overwrites
  const seen = new Set()
  for (const e of entries) {
    if (seen.has(e.specId)) {
      log.err(`Duplicate specId in builtinApps.apps: "${e.specId}"`)
      process.exit(1)
    }
    seen.add(e.specId)
  }

  resetDestination()
  for (const entry of entries) {
    copyApp(sourceRoot, entry)
  }
  writeManifest(entries, sourceRoot, /* intentionalEmpty */ false)

  log.ok(`Bundled ${entries.length} built-in digital human(s).`)
}

main().catch((err) => {
  log.err(err.message)
  process.exit(1)
})
