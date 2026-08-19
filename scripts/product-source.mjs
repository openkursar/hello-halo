#!/usr/bin/env node
/**
 * product-source.mjs — Local product variant selection (shared module)
 *
 * `product.json` is a git-ignored build input: each product variant keeps its
 * own `product.<variant>.json` under `halo-local/` (also git-ignored), and the
 * active variant is chosen per-machine rather than committed.
 *
 * The active choice is stored in a git-ignored pointer file `.product-source`
 * containing one line: the path to the chosen variant file. Every dev/build
 * entry point runs sync-builtin-apps.mjs first, which calls syncProductJson()
 * here to copy the pointed-at file into product.json — so the variant can never
 * drift or be forgotten. Switching = re-running the picker (`npm run product`).
 *
 * Nothing about any specific variant is hard-coded: variants are discovered by
 * scanning halo-local/ at runtime, and labels come from each file's own fields.
 * A vanilla open-source checkout has no halo-local/ and no pointer, so this
 * module is a transparent no-op there.
 *
 * Precedence when resolving the source variant:
 *   1. HALO_PRODUCT_SOURCE env var (CI / one-off override)
 *   2. .product-source pointer file
 *   3. existing product.json (left untouched)
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = resolve(__dirname, '..')
export const PRODUCT_JSON = join(PROJECT_ROOT, 'product.json')
export const POINTER_FILE = join(PROJECT_ROOT, '.product-source')

const VARIANT_ROOT = join(PROJECT_ROOT, 'halo-local')
// Variant files legitimately live in nested build/ directories, so only
// truly irrelevant trees are skipped.
const SCAN_SKIP = new Set(['node_modules', '.git'])
const SCAN_MAX_DEPTH = 5

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
}

/**
 * Recursively collect `product.*.json` files under halo-local/.
 */
function scanVariantFiles(dir, depth, acc) {
  if (depth > SCAN_MAX_DEPTH) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SCAN_SKIP.has(entry.name)) continue
      scanVariantFiles(full, depth + 1, acc)
    } else if (/^product\..+\.json$/.test(entry.name) && !entry.name.endsWith('.schema.json')) {
      acc.push(full)
    }
  }
}

/**
 * Discover selectable variants. A file qualifies only if it parses as JSON and
 * carries a `dataFolderName` (the field that meaningfully distinguishes one
 * product build from another). Returns entries sorted by display path.
 */
export function discoverVariants() {
  const files = []
  scanVariantFiles(VARIANT_ROOT, 0, files)

  const variants = []
  const seen = new Set()
  for (const path of files) {
    if (seen.has(path)) continue
    seen.add(path)
    let config
    try {
      config = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (!config || typeof config.dataFolderName !== 'string') continue
    variants.push({
      path,
      rel: relative(PROJECT_ROOT, path),
      dataFolderName: config.dataFolderName,
      name: typeof config.name === 'string' ? config.name : '(unnamed)',
    })
  }
  variants.sort((a, b) => a.rel.localeCompare(b.rel))
  return variants
}

/** Resolve a possibly-relative variant path against the project root. */
export function resolveVariantPath(raw) {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return isAbsolute(trimmed) ? trimmed : resolve(PROJECT_ROOT, trimmed)
}

/** Read the pointer file, returning an absolute variant path or null. */
export function readPointer() {
  if (!existsSync(POINTER_FILE)) return null
  const line = readFileSync(POINTER_FILE, 'utf8').split('\n').find(l => l.trim() && !l.trim().startsWith('#'))
  return resolveVariantPath(line)
}

/** Persist the active variant choice as a project-root-relative path. */
export function writePointer(variantPath) {
  const rel = relative(PROJECT_ROOT, variantPath)
  const body =
    '# Active product variant for this machine (git-ignored).\n' +
    '# Managed by `npm run product`; one path relative to the project root.\n' +
    `${rel}\n`
  writeFileSync(POINTER_FILE, body, 'utf8')
}

/** True when product.json content already equals the given variant file. */
function productMatches(variantPath) {
  if (!existsSync(PRODUCT_JSON) || !existsSync(variantPath)) return false
  try {
    const a = JSON.stringify(JSON.parse(readFileSync(PRODUCT_JSON, 'utf8')))
    const b = JSON.stringify(JSON.parse(readFileSync(variantPath, 'utf8')))
    return a === b
  } catch {
    return false
  }
}

/** Identify which discovered variant is currently active (pointer first). */
export function currentVariant(variants = discoverVariants()) {
  const pointer = readPointer()
  if (pointer) {
    const byPointer = variants.find(v => v.path === pointer)
    if (byPointer) return byPointer
  }
  return variants.find(v => productMatches(v.path)) ?? null
}

/** Copy a variant file into product.json. */
export function applyVariant(variantPath) {
  if (!existsSync(variantPath)) {
    throw new Error(`Variant file not found: ${variantPath}`)
  }
  const content = readFileSync(variantPath, 'utf8')
  JSON.parse(content) // fail loudly on malformed variant
  writeFileSync(PRODUCT_JSON, content, 'utf8')
}

const log = (msg) => console.log(`${c.blue}[product]${c.reset} ${msg}`)

/**
 * Interactive numbered picker. Returns the chosen variant, or null if the user
 * cancels or no variants exist. Never throws on empty input.
 */
export async function promptSelect(variants = discoverVariants()) {
  if (variants.length === 0) {
    log(`${c.yellow}No product variants found under halo-local/.${c.reset}`)
    return null
  }
  const active = currentVariant(variants)

  console.log(`\n${c.bold}Select product variant:${c.reset}\n`)
  variants.forEach((v, i) => {
    const mark = active && v.path === active.path ? `${c.green}●${c.reset}` : ' '
    console.log(`  ${mark} ${c.cyan}${i + 1})${c.reset} ${v.rel}  ${c.dim}[${v.dataFolderName}]${c.reset}`)
  })
  const hint = active ? ` ${c.dim}(current: ${active.rel})${c.reset}` : ''
  console.log('')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((res) => {
    rl.question(`${c.bold}Enter number${c.reset}${hint} ${c.dim}(blank to cancel):${c.reset} `, res)
  })
  rl.close()

  const n = Number.parseInt(answer.trim(), 10)
  if (!Number.isInteger(n) || n < 1 || n > variants.length) {
    log('Cancelled — product.json unchanged.')
    return null
  }
  return variants[n - 1]
}

/**
 * Ensure product.json reflects the active variant.
 *
 * @param {{ interactive?: boolean }} opts
 *   interactive: when true and no variant is resolvable, show the picker
 *   (guarded to a TTY, non-CI session).
 * @returns {Promise<{ active: string, source: string|null } | null>}
 *   active  = variant label for logging
 *   source  = variant file that was applied, or null if product.json was left
 *   null    = no product.json and nothing to apply (open-source no-op)
 */
export async function syncProductJson({ interactive = false } = {}) {
  const envSource = resolveVariantPath(process.env.HALO_PRODUCT_SOURCE)
  const pointer = readPointer()
  const source = envSource ?? pointer

  if (source) {
    if (!existsSync(source)) {
      log(`${c.yellow}Configured variant missing: ${relative(PROJECT_ROOT, source)}${c.reset}`)
      log(`${c.yellow}Run \`npm run product\` to reselect.${c.reset}`)
    } else {
      applyVariant(source)
      log(`${c.green}▶${c.reset} active variant: ${relative(PROJECT_ROOT, source)}`)
      return { active: relative(PROJECT_ROOT, source), source }
    }
  }

  const canPrompt = interactive && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI
  if (!existsSync(PRODUCT_JSON) && canPrompt) {
    const chosen = await promptSelect()
    if (chosen) {
      applyVariant(chosen.path)
      writePointer(chosen.path)
      log(`${c.green}▶${c.reset} active variant: ${chosen.rel}`)
      return { active: chosen.rel, source: chosen.path }
    }
  }

  if (existsSync(PRODUCT_JSON)) {
    const active = currentVariant()
    return { active: active ? active.rel : 'product.json', source: null }
  }

  return null
}
