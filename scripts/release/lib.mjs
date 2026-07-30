// ============================================================================
// Release verification shared helpers
//
// Variant-agnostic: every variant-specific fact comes in through the
// build-manifest.json the caller passes. See README.md in this directory.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

const require = createRequire(import.meta.url)

export const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
}

export const log = {
  info: (m) => console.log(`${c.blue}[release]${c.reset} ${m}`),
  ok: (m) => console.log(`${c.green}  ✓${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}  ⚠${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}  ✗${c.reset} ${m}`),
}

// ----------------------------------------------------------------------------
// Manifest
// ----------------------------------------------------------------------------

/**
 * Load and validate a build-manifest.json. All relative paths inside the
 * manifest resolve against the manifest's own directory, so the caller's cwd
 * never matters.
 */
export function loadManifest(manifestPath) {
  const abs = path.resolve(manifestPath)
  if (!fs.existsSync(abs)) {
    throw new Error(`build-manifest not found: ${abs}`)
  }
  const dir = path.dirname(abs)
  const m = JSON.parse(fs.readFileSync(abs, 'utf8'))

  for (const key of ['variant', 'product', 'repos']) {
    if (!m[key]) throw new Error(`build-manifest missing required key "${key}" (${abs})`)
  }
  if (!m.repos.main) throw new Error(`build-manifest repos.main is required (${abs})`)

  return {
    ...m,
    path: abs,
    dir,
    productPath: path.resolve(dir, m.product),
    repoPaths: Object.fromEntries(
      Object.entries(m.repos).map(([name, p]) => [name, path.resolve(dir, p)])
    ),
    requiredEnv: m.requiredEnv ?? [],
    requiredEngines: m.requiredEngines ?? [],
    requiredProductFields: m.requiredProductFields ?? [],
    sensitiveFields: m.sensitiveFields ?? [],
    expectedArtifacts: m.expectedArtifacts ?? {},
  }
}

// ----------------------------------------------------------------------------
// Git
// ----------------------------------------------------------------------------

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

/**
 * Snapshot a repo's git state. `unpushed` is null when there is no upstream
 * (callers decide how strict to be about that).
 */
export function gitState(repo) {
  if (!fs.existsSync(path.join(repo))) {
    throw new Error(`repo path does not exist: ${repo}`)
  }
  const sha = git(repo, ['rev-parse', 'HEAD'])
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const status = git(repo, ['status', '--porcelain'])
  const dirtyFiles = status ? status.split('\n') : []

  let unpushed = null
  try {
    const counts = git(repo, ['rev-list', '--count', '@{u}..HEAD'])
    unpushed = Number.parseInt(counts, 10) > 0
  } catch {
    unpushed = null
  }

  return { sha, branch, dirty: dirtyFiles.length > 0, dirtyFiles, unpushed }
}

// ----------------------------------------------------------------------------
// Values
// ----------------------------------------------------------------------------

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function getByPath(obj, dotPath) {
  let cur = obj
  for (const part of dotPath.split('.')) {
    if (cur && typeof cur === 'object' && part in cur) cur = cur[part]
    else return undefined
  }
  return cur
}

/** Empty = absent, null, empty string, empty array, empty object. */
export function isEmptyValue(v) {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v).length === 0
  return false
}

// ----------------------------------------------------------------------------
// Asar
// ----------------------------------------------------------------------------

function asarModule() {
  // Dependency of electron-builder; resolve it from the main repo.
  return require('@electron/asar')
}

export function asarList(asarPath) {
  return asarModule()
    .listPackage(asarPath)
    .map((e) => e.replace(/^[\\/]/, '').split(path.sep).join('/'))
}

export function asarRead(asarPath, relPath) {
  return asarModule().extractFile(asarPath, relPath)
}

// ----------------------------------------------------------------------------
// Build record
// ----------------------------------------------------------------------------

export function readRecord(recordPath) {
  if (!fs.existsSync(recordPath)) return null
  return JSON.parse(fs.readFileSync(recordPath, 'utf8'))
}

export function writeRecord(recordPath, record) {
  fs.mkdirSync(path.dirname(recordPath), { recursive: true })
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', 'utf8')
}

// ----------------------------------------------------------------------------
// Baseline diff — three tiers: missing blocks upstream of here; changes are
// classified sensitive (needs confirmation) or routine (printed only).
// ----------------------------------------------------------------------------

/** Deep-diff two plain JSON values into [{path, from, to}]. */
export function deepDiff(from, to, prefix = '') {
  if (JSON.stringify(from) === JSON.stringify(to)) return []
  const bothObjects =
    from && to && typeof from === 'object' && typeof to === 'object' &&
    Array.isArray(from) === Array.isArray(to) && !Array.isArray(from)
  if (!bothObjects) {
    return [{ path: prefix || '(root)', from, to }]
  }
  const keys = new Set([...Object.keys(from), ...Object.keys(to)])
  const out = []
  for (const key of keys) {
    out.push(...deepDiff(from[key], to[key], prefix ? `${prefix}.${key}` : key))
  }
  return out
}

/**
 * Compare the current build inputs against the last release's record.
 *
 * `comparable` fields of a record: product content, requiredEnv names,
 * requiredEngines, sdk, repo SHAs, version. Sensitivity is decided by the
 * manifest's `sensitiveFields`:
 *   - "product:<dot-path>"  matches product content changes under that path
 *   - any other entry       matches the record field of that name
 */
export function diffAgainstBaseline(manifest, current, baseline) {
  if (!baseline) return { sensitive: [], routine: [], noBaseline: true }

  const changes = []

  const productChanges = deepDiff(baseline.product?.content ?? {}, current.product.content)
  for (const ch of productChanges) changes.push({ ...ch, scope: 'product' })

  for (const field of ['requiredEnv', 'requiredEngines', 'expectedArtifacts']) {
    for (const ch of deepDiff(baseline[field] ?? [], current[field] ?? [], field)) {
      changes.push({ ...ch, scope: 'record' })
    }
  }
  for (const ch of deepDiff(baseline.sdk ?? {}, current.sdk ?? {}, 'sdkVersion')) {
    changes.push({ ...ch, scope: 'record' })
  }
  for (const [name, state] of Object.entries(current.repos ?? {})) {
    const prev = baseline.repos?.[name]?.sha
    if (prev && prev !== state.sha) {
      changes.push({ path: `repos.${name}`, from: prev, to: state.sha, scope: 'record' })
    }
  }
  if (baseline.version && baseline.version !== current.version) {
    changes.push({ path: 'version', from: baseline.version, to: current.version, scope: 'record' })
  }

  const sensitive = []
  const routine = []
  for (const ch of changes) {
    if (isSensitive(manifest.sensitiveFields, ch)) sensitive.push(ch)
    else routine.push(ch)
  }
  return { sensitive, routine, noBaseline: false }
}

function isSensitive(sensitiveFields, change) {
  for (const rule of sensitiveFields) {
    if (rule.startsWith('product:')) {
      if (change.scope !== 'product') continue
      const rulePath = rule.slice('product:'.length)
      if (change.path === rulePath || change.path.startsWith(rulePath + '.')) return true
    } else if (change.scope === 'record') {
      if (change.path === rule || change.path.startsWith(rule + '.')) return true
    }
  }
  return false
}

export function printDiffReport({ sensitive, routine, noBaseline }, baselineLabel) {
  console.log('')
  console.log(`${c.bold}══ Build diff report (vs ${baselineLabel}) ══${c.reset}`)
  if (noBaseline) {
    log.warn('no baseline record (first run) — this build establishes the baseline')
    return
  }
  if (sensitive.length === 0 && routine.length === 0) {
    log.ok('no changes vs last release')
    return
  }
  if (sensitive.length > 0) {
    console.log(`${c.yellow}${c.bold}[SENSITIVE CHANGES → confirmation required]${c.reset}`)
    for (const ch of sensitive) printChange(ch, c.yellow)
  }
  if (routine.length > 0) {
    console.log(`${c.dim}[routine changes → informational]${c.reset}`)
    for (const ch of routine) printChange(ch, c.dim)
  }
}

function short(v) {
  const s = v === undefined ? '(absent)' : JSON.stringify(v)
  return s.length > 120 ? s.slice(0, 117) + '…' : s
}

function printChange(ch, color) {
  const scope = ch.scope === 'product' ? 'product.json: ' : ''
  console.log(`  ${color}·${c.reset} ${scope}${ch.path}`)
  console.log(`      ${c.red}- ${short(ch.from)}${c.reset}`)
  console.log(`      ${c.green}+ ${short(ch.to)}${c.reset}`)
}

/**
 * Confirm sensitive changes. Resolution order:
 *   1. `--confirm-sensitive` / HALO_CONFIRM_SENSITIVE=1 → acknowledged
 *      non-interactively (CI approval step or explicit operator intent).
 *   2. Interactive TTY → per-change y/n prompt.
 *   3. Otherwise → refuse (exit code 2 upstream).
 * Returns { confirmed: boolean, confirmedBy: string }.
 */
export async function confirmSensitive(sensitive, { flagConfirm }) {
  if (sensitive.length === 0) return { confirmed: true, confirmedBy: 'none-needed' }
  if (flagConfirm || process.env.HALO_CONFIRM_SENSITIVE === '1') {
    return { confirmed: true, confirmedBy: 'flag' }
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { confirmed: false, confirmedBy: 'non-interactive' }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise((res) => rl.question(q, res))
  for (const ch of sensitive) {
    const answer = await ask(`${c.yellow}Confirm this sensitive change? ${c.reset}${ch.path} [y/N] `)
    if (answer.trim().toLowerCase() !== 'y') {
      rl.close()
      return { confirmed: false, confirmedBy: 'interactive-rejected' }
    }
  }
  rl.close()
  return { confirmed: true, confirmedBy: 'interactive' }
}
