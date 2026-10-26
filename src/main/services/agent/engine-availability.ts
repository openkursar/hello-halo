/**
 * Runnable engine discovery without importing engine implementations. Bundled
 * packages are immutable for the process lifetime; selected CC installations use
 * cc-runtime's stamped compatibility cache. Startup probes candidates in order
 * and stops at the first runnable engine, so default Halo never scans external tools.
 */

import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { app } from 'electron'
import { ENGINE_IDS, type EngineId } from '../../../shared/types/engine'

export interface EngineAvailability {
  engineId: EngineId
  /** Whether the engine has a runnable module or selected external installation. */
  available: boolean
  /** Runtime version; empty string when the engine is absent. */
  version: string
  /** Short content hash of the entry file; empty when unavailable or not hashable. */
  fingerprint: string
  /** Why the engine is unavailable, for logs and Settings. Not localized. */
  reason?: string
}

/**
 * npm package that carries each engine's runtime.
 *
 * Codex is absent here on purpose: its adapter (`./codex`) is bundled into the
 * main bundle and always imports successfully, so package presence says nothing
 * about whether the engine can run. Its real requirement is the platform-native
 * `codex` binary, probed separately via `resolveBundledCodexBinary()`.
 */
const ENGINE_PACKAGES: Record<Exclude<EngineId, 'codex' | 'dsh' | 'anthropic'>, string> = {
  halo: '@hello-halo/agent-sdk',
}

/** Package that carries the Codex version metadata (binary lives in its platform subpackage). */
const CODEX_VERSION_PACKAGE = '@openai/codex-sdk'

export const ALL_ENGINE_IDS: readonly EngineId[] = ENGINE_IDS

const probes = new Map<EngineId, Promise<EngineAvailability>>()

/**
 * Probe the given engines, every engine by default. Bundled files are cached for
 * the process lifetime; CC delegates cache invalidation to its runtime owner.
 */
export async function getEngineAvailability(
  engineIds: readonly EngineId[] = ALL_ENGINE_IDS
): Promise<EngineAvailability[]> {
  // External installations can change while running; cc-runtime owns its stamped cache.
  const fresh = engineIds.filter(id => id === 'anthropic' || !probes.has(id))
  for (const engineId of fresh) probes.set(engineId, probeEngine(engineId))

  const results = await Promise.all(engineIds.map(id => probes.get(id)!))

  if (fresh.length > 0) {
    const summary = results
      .filter(r => fresh.includes(r.engineId))
      .map(r => `${r.engineId}=${r.available ? `${r.version || 'unknown'}${r.fingerprint ? `#${r.fingerprint}` : ''}` : 'missing'}`)
      .join(' ')
    console.log(`[SDK] Engine availability: ${summary}`)
  }
  return results
}

function probeEngine(engineId: EngineId): Promise<EngineAvailability> {
  if (engineId === 'anthropic') return probeCc()
  if (engineId === 'codex') return probeCodex()
  if (engineId === 'dsh') return probeDsh()
  return Promise.resolve(probePackageEngine(engineId))
}

// ============================================
// Probes
// ============================================

function probePackageEngine(engineId: Exclude<EngineId, 'codex' | 'dsh' | 'anthropic'>): EngineAvailability {
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
  if (engineId === 'halo' && !['dist/worker/index.js', 'dist/worker/entry.js'].every(file => existsSync(path.join(pkgDir, file)))) return absent

  return {
    engineId,
    available: true,
    version: typeof manifest.version === 'string' ? manifest.version : '',
    fingerprint: fingerprintFile(engineId === 'halo' ? path.join(pkgDir, 'dist/worker/entry.js') : entry),
  }
}

async function probeCc(): Promise<EngineAvailability> {
  try {
    const { resolveCcRuntimeLaunch } = await import('../cc-runtime')
    const launch = await resolveCcRuntimeLaunch()
    return { engineId: 'anthropic', available: launch !== null, version: launch?.version ?? '', fingerprint: '',
      ...(launch ? {} : { reason: 'No compatible Claude Code installation is selected' }) }
  } catch (error) {
    console.warn('[SDK] Selected CC installation probe failed:', error)
    return { engineId: 'anthropic', available: false, version: '', fingerprint: '', reason: 'The selected Claude Code installation could not be checked' }
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

async function probeDsh(): Promise<EngineAvailability> {
  const absent = (reason: string): EngineAvailability =>
    ({ engineId: 'dsh', available: false, version: '', fingerprint: '', reason })

  // Asking the module that launches the engine, rather than re-deriving the
  // path here, is what keeps the probe from reporting an engine the launcher
  // cannot find (or the reverse).
  let resolver: typeof import('./dsh/runtime')
  try {
    resolver = await import('./dsh/runtime')
  } catch (error) {
    console.warn('[SDK] dsh availability probe failed:', (error as Error).message)
    return absent('the dsh adapter failed to load')
  }
  const { describeMinNodeVersion, resolveDshInterpreter, resolveDshRuntime } = resolver

  const runtime = resolveDshRuntime()
  if (!runtime) {
    return absent('the dsh runtime bundle (resources/dsh-runtime) did not ship in this build')
  }

  if (!resolveDshInterpreter()) {
    return absent(
      `the dsh runtime needs Node >= ${describeMinNodeVersion()}; this build's Electron bundles ` +
      `${process.versions.node} and no newer "node" was found on PATH`
    )
  }

  return {
    engineId: 'dsh',
    available: true,
    version: runtime.version,
    fingerprint: fingerprintFile(runtime.entryPath),
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
