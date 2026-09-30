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
 * dsh is the one exception: it also needs an interpreter newer than the Node
 * this Electron bundles, and the only way to know whether one exists is to ask
 * `node --version`. Without it the engine reads as available and fails on the
 * user's first message instead of in Settings, which is where the fix is.
 * That spawn is why each engine is probed on first demand rather than all at
 * once: startup asks only for the engines it may load, so an experimental
 * engine nobody selected costs nothing until Settings lists it.
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
const ENGINE_PACKAGES: Record<Exclude<EngineId, 'codex' | 'dsh'>, string> = {
  anthropic: '@anthropic-ai/claude-agent-sdk',
  halo: '@hello-halo/agent-sdk',
}

/** Package that carries the Codex version metadata (binary lives in its platform subpackage). */
const CODEX_VERSION_PACKAGE = '@openai/codex-sdk'

export const ALL_ENGINE_IDS: EngineId[] = ['anthropic', 'halo', 'codex', 'dsh']

const probes = new Map<EngineId, Promise<EngineAvailability>>()

/**
 * Probe the given engines, every engine by default. Each result is cached for
 * the process lifetime — packaged files cannot change while the app runs.
 */
export async function getEngineAvailability(
  engineIds: readonly EngineId[] = ALL_ENGINE_IDS
): Promise<EngineAvailability[]> {
  const fresh = engineIds.filter(id => !probes.has(id))
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
  if (engineId === 'codex') return probeCodex()
  if (engineId === 'dsh') return probeDsh()
  return Promise.resolve(probePackageEngine(engineId))
}

// ============================================
// Probes
// ============================================

function probePackageEngine(engineId: Exclude<EngineId, 'codex' | 'dsh'>): EngineAvailability {
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
