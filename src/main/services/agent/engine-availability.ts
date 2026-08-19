/**
 * Engine availability probe.
 *
 * Answers one question per engine: does THIS build ship something the engine
 * can actually run on? Engine packages are shipped independently of the app
 * code (the CC / Halo SDKs, the Codex binary carrier, the dsh runtime), so a
 * selectable engine is not the same as a usable one.
 *
 * Two consumers:
 *   - `resolved-sdk.ts` — to degrade instead of failing bootstrap when the
 *     configured engine cannot run.
 *   - Settings (via `agent:get-engine-availability`) — to tell the user why an
 *     engine cannot be selected before they restart into a broken state.
 *
 * The probe is filesystem-only: no import, no network. It runs during
 * bootstrap, so it must stay cheap and must never throw.
 *
 * One deliberate exception: dsh also needs an interpreter newer than the Node
 * this Electron bundles, and the only way to know whether a usable one exists
 * is to ask `node --version` once. Without it the engine reads as available
 * and fails on the user's first message instead of in Settings, which is where
 * the fix is. The result is cached with the rest of the probe.
 */

import { existsSync } from 'fs'
import path from 'path'
import type { EngineId } from './capabilities'
import { describeMinNodeVersion, resolveDshInterpreter } from './dsh/runtime'

export interface EngineAvailability {
  engineId: EngineId
  available: boolean
  /** Diagnostic detail for logs and settings UI. Not user-localized. */
  reason?: string
}

/**
 * npm package that carries each engine's runtime. `paths` are checked
 * relative to the package root; an empty list means "package root is enough".
 */
const ENGINE_PACKAGES: Record<EngineId, { candidates: { pkg: string; paths: string[] }[] }> = {
  anthropic: { candidates: [{ pkg: '@anthropic-ai/claude-agent-sdk', paths: [] }] },
  halo: { candidates: [{ pkg: '@hello-halo/agent-sdk', paths: [] }] },
  // Codex resolves its platform-native binary out of the CLI package at spawn
  // time; either carrier being present means the adapter has something to run.
  codex: {
    candidates: [
      { pkg: '@openai/codex', paths: [] },
      { pkg: '@openai/codex-sdk', paths: [] },
    ],
  },
  // dsh is a Node entrypoint, not a binary: the packaged bin boots a cordis
  // config with plugin resolution anchored to the installed tree (see
  // `dsh/runtime/resolve.ts`, which must agree with this entry). The entry
  // alone cannot serve the protocol, so the sibling server plugin is required
  // too — hence the escaping relative path.
  dsh: {
    candidates: [
      {
        pkg: '@deepseek-ai/dsh-sdk-jsonrpc-demo',
        paths: ['lib/packaged-bin.js', '../dsh-sdk-jsonrpc-server/package.json'],
      },
    ],
  },
}

const cache = new Map<EngineId, EngineAvailability>()

/**
 * Roots under which a shipped `node_modules` may live. Mirrors how the Codex
 * adapter locates its binary: unpacked resources first (production), then the
 * asar itself, then the dev working directory.
 */
function packageRoots(): string[] {
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked') : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar') : '',
    process.cwd(),
  ]
  return [...new Set(roots.filter(Boolean))]
}

export function probeEngine(engineId: EngineId): EngineAvailability {
  const cached = cache.get(engineId)
  if (cached) return cached

  const result = runProbe(engineId)
  cache.set(engineId, result)
  return result
}

export function probeAllEngines(): EngineAvailability[] {
  return (Object.keys(ENGINE_PACKAGES) as EngineId[]).map(probeEngine)
}

function runProbe(engineId: EngineId): EngineAvailability {
  const spec = ENGINE_PACKAGES[engineId]
  if (!spec) return { engineId, available: false, reason: `Unknown engine "${engineId}"` }

  try {
    for (const candidate of spec.candidates) {
      for (const root of packageRoots()) {
        const packageRoot = path.join(root, 'node_modules', ...candidate.pkg.split('/'))
        if (!existsSync(path.join(packageRoot, 'package.json'))) continue
        const missing = candidate.paths.find((rel) => !existsSync(path.join(packageRoot, rel)))
        if (missing) {
          return {
            engineId,
            available: false,
            reason: `${candidate.pkg} is installed but ${missing} is missing`,
          }
        }
        if (engineId === 'dsh' && !resolveDshInterpreter()) {
          return {
            engineId,
            available: false,
            reason:
              `the dsh runtime needs Node >= ${describeMinNodeVersion()}; this build's Electron ` +
              `bundles ${process.versions.node} and no newer "node" was found on PATH`,
          }
        }
        return { engineId, available: true }
      }
    }
  } catch (error) {
    return { engineId, available: false, reason: (error as Error).message }
  }

  const names = spec.candidates.map((c) => c.pkg).join(' or ')
  return { engineId, available: false, reason: `${names} is not installed in this build` }
}
