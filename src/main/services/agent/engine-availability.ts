/**
 * Engine Availability — which agent SDK engines physically shipped in this build.
 *
 * Engine selection is user configuration (`config.agent.sdkEngine`), but whether
 * the selected engine's package is actually present is a property of the build.
 * The two can disagree: a build produced without `@hello-halo/agent-sdk` still
 * meets configs that select it, and the resulting import failure used to abort
 * the whole bootstrap. Probing here lets startup degrade to an engine this build
 * can run, and lets Settings offer only those engines.
 *
 * The probe never imports an engine module — it inspects packaged files
 * (package.json + entry file), so it is safe to call before initSdk().
 *
 * `fingerprint` exists because package version is not a reliable identity for
 * every engine: `@hello-halo/agent-sdk` is a local path dependency whose version
 * is static across rebuilds, so two different SDK builds are indistinguishable by
 * version alone. Hashing the entry file makes any shipped build identifiable from
 * a log line alone.
 */

import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { app } from 'electron'
import type { EngineId } from './capabilities'

export interface EngineAvailability {
  engineId: EngineId
  /** Whether the engine's module can be loaded in this build. */
  available: boolean
  /** Package version; empty string when the engine is absent. */
  version: string
  /** Short content hash of the entry file; empty when unavailable or not hashable. */
  fingerprint: string
}

/**
 * npm package that carries each engine's runtime.
 *
 * Codex is absent here on purpose: its adapter (`./codex`) is bundled into the
 * main bundle and always imports successfully, so package presence says nothing
 * about whether the engine can run. Its real requirement is the platform-native
 * `codex` binary, probed separately via `resolveBundledCodexBinary()`.
 */
const ENGINE_PACKAGES: Record<Exclude<EngineId, 'codex'>, string> = {
  anthropic: '@anthropic-ai/claude-agent-sdk',
  halo: '@hello-halo/agent-sdk',
}

/** Package that carries the Codex version metadata (binary lives in its platform subpackage). */
const CODEX_VERSION_PACKAGE = '@openai/codex-sdk'

export const ALL_ENGINE_IDS: EngineId[] = ['anthropic', 'halo', 'codex']

let cached: EngineAvailability[] | null = null

/**
 * Probe every engine. Result is cached for the process lifetime — packaged
 * files cannot change while the app runs.
 */
export async function getEngineAvailability(): Promise<EngineAvailability[]> {
  if (cached) return cached

  const results: EngineAvailability[] = []
  for (const engineId of ALL_ENGINE_IDS) {
    results.push(engineId === 'codex' ? await probeCodex() : probePackageEngine(engineId))
  }

  cached = results
  const summary = results
    .map(r => `${r.engineId}=${r.available ? `${r.version || 'unknown'}${r.fingerprint ? `#${r.fingerprint}` : ''}` : 'missing'}`)
    .join(' ')
  console.log(`[SDK] Engine availability: ${summary}`)
  return results
}

/** Availability of a single engine. */
export async function isEngineAvailable(engineId: EngineId): Promise<boolean> {
  const all = await getEngineAvailability()
  return all.find(e => e.engineId === engineId)?.available ?? false
}

/** Descriptor of a single engine, or null when the id is unknown. */
export async function getEngineDescriptor(engineId: EngineId): Promise<EngineAvailability | null> {
  const all = await getEngineAvailability()
  return all.find(e => e.engineId === engineId) ?? null
}

// ============================================
// Probes
// ============================================

function probePackageEngine(engineId: Exclude<EngineId, 'codex'>): EngineAvailability {
  const absent: EngineAvailability = { engineId, available: false, version: '', fingerprint: '' }

  const pkgDir = findPackageDir(ENGINE_PACKAGES[engineId])
  if (!pkgDir) return absent

  const manifest = readManifest(pkgDir)
  if (!manifest) return absent

  // A package directory with no loadable entry is the shape a broken build
  // produces (link present, dist never built) — treat it as absent so the
  // caller degrades instead of failing at import time.
  const entry = resolveEntryFile(pkgDir, manifest)
  if (!entry) return absent

  return {
    engineId,
    available: true,
    version: typeof manifest.version === 'string' ? manifest.version : '',
    fingerprint: fingerprintFile(entry),
  }
}

async function probeCodex(): Promise<EngineAvailability> {
  const pkgDir = findPackageDir(CODEX_VERSION_PACKAGE)
  const version = (pkgDir && (readManifest(pkgDir)?.version as string)) || ''

  try {
    const { resolveBundledCodexBinary } = await import('./codex/transport/connection')
    const binary = resolveBundledCodexBinary()
    return { engineId: 'codex', available: binary !== null, version, fingerprint: '' }
  } catch (error) {
    console.warn('[SDK] Codex availability probe failed:', (error as Error).message)
    return { engineId: 'codex', available: false, version, fingerprint: '' }
  }
}

// ============================================
// Filesystem helpers
// ============================================

/**
 * Directories that may hold node_modules for this process, mirroring the
 * resolution order in sdk-config.ts: packaged asar, unpacked sidecar, and the
 * out/main layout an E2E build produces. `app.getAppPath()` already resolves to
 * the project root in development, so no cwd fallback is needed — and cwd is
 * arbitrary for an installed app, which would make the probe non-deterministic.
 */
function nodeModulesRoots(): string[] {
  const roots: string[] = []

  try {
    const appPath = app.getAppPath()
    roots.push(path.join(appPath, 'node_modules'))
    // E2E build mode resolves getAppPath() to out/main; project root is two up.
    roots.push(path.join(appPath, '..', '..', 'node_modules'))
  } catch {
    // `app` is unavailable outside an Electron main process (unit tests).
  }

  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'))
  }

  return [...new Set(roots)]
}

function findPackageDir(packageId: string): string | null {
  for (const root of nodeModulesRoots()) {
    const dir = path.join(root, ...packageId.split('/'))
    if (existsSync(path.join(dir, 'package.json'))) return dir
  }
  return null
}

function readManifest(pkgDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * First entry candidate that exists on disk, or null when none does.
 * Handles the `exports` map (string or conditions object), then the legacy
 * `main` / `module` fields, then the CommonJS default.
 */
function resolveEntryFile(pkgDir: string, manifest: Record<string, unknown>): string | null {
  const candidates: string[] = []

  const root = (manifest.exports as Record<string, unknown> | undefined)?.['.']
  if (typeof root === 'string') {
    candidates.push(root)
  } else if (root && typeof root === 'object') {
    for (const condition of ['import', 'module', 'default', 'require', 'node']) {
      const value = (root as Record<string, unknown>)[condition]
      if (typeof value === 'string') candidates.push(value)
    }
  }

  for (const field of ['main', 'module']) {
    const value = manifest[field]
    if (typeof value === 'string') candidates.push(value)
  }
  candidates.push('index.js')

  for (const candidate of candidates) {
    const resolved = path.join(pkgDir, candidate)
    if (existsSync(resolved)) return resolved
  }
  return null
}

/**
 * Short content hash of an engine entry file.
 *
 * Runs once per engine per process and only on the entry file (hundreds of KB
 * for the shipped SDKs), so it stays inside the noise of the SDK import it
 * accompanies. Failures degrade to an empty fingerprint rather than blocking
 * engine selection.
 */
function fingerprintFile(filePath: string): string {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
}
