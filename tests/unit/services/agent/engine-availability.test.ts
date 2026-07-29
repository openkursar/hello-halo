/**
 * Engine availability probe.
 *
 * Guards the packaging failure this module exists for: `@hello-halo/agent-sdk`
 * is an optional `file:` dependency, so a build machine with an empty source
 * directory ships either no package at all or a package directory with no
 * entry file. Both must read as "engine absent" so startup degrades instead of
 * dying on an import that can never succeed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const ANTHROPIC_PACKAGE = '@anthropic-ai/claude-agent-sdk'
const HALO_PACKAGE = '@hello-halo/agent-sdk'

function appNodeModules(): string {
  return path.join(globalThis.__HALO_TEST_DIR__, 'app', 'node_modules')
}

/** Write a package into the fake packaged app's node_modules. */
function writePackage(
  packageId: string,
  manifest: Record<string, unknown>,
  entries: Record<string, string> = {},
): void {
  const pkgDir = path.join(appNodeModules(), ...packageId.split('/'))
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(manifest))
  for (const [relPath, content] of Object.entries(entries)) {
    const target = path.join(pkgDir, relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}

/** Fresh module instance so the per-process probe cache does not leak across tests. */
async function loadProbe() {
  vi.resetModules()
  return import('../../../../src/main/services/agent/engine-availability')
}

async function probe(engineId: 'anthropic' | 'halo') {
  const { getEngineAvailability } = await loadProbe()
  const engines = await getEngineAvailability()
  return engines.find(e => e.engineId === engineId)!
}

describe('engine availability', () => {
  beforeEach(() => {
    fs.mkdirSync(appNodeModules(), { recursive: true })
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('reports an engine whose package is absent as unavailable', async () => {
    const result = await probe('halo')

    expect(result.available).toBe(false)
    expect(result.version).toBe('')
    expect(result.fingerprint).toBe('')
  })

  it('reports an installed engine with its version and a fingerprint', async () => {
    writePackage(
      ANTHROPIC_PACKAGE,
      { name: ANTHROPIC_PACKAGE, version: '0.2.89', main: 'sdk.mjs' },
      { 'sdk.mjs': 'export const query = () => {}' },
    )

    const result = await probe('anthropic')

    expect(result.available).toBe(true)
    expect(result.version).toBe('0.2.89')
    expect(result.fingerprint).toMatch(/^[0-9a-f]{12}$/)
  })

  it('treats a package with no entry file as unavailable', async () => {
    // The exact shape a broken `file:` dependency produces: manifest links to a
    // dist that was never built.
    writePackage(HALO_PACKAGE, { name: HALO_PACKAGE, version: '1.0.0', main: 'dist/index.js' })

    const result = await probe('halo')

    expect(result.available).toBe(false)
    expect(result.version).toBe('')
  })

  it('resolves the entry through the exports map', async () => {
    writePackage(
      HALO_PACKAGE,
      {
        name: HALO_PACKAGE,
        version: '1.0.0',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      },
      { 'dist/index.js': 'export const query = () => {}' },
    )

    const result = await probe('halo')

    expect(result.available).toBe(true)
    expect(result.version).toBe('1.0.0')
  })

  it('fingerprints entry content, so a static version still identifies the build', async () => {
    // `@hello-halo/agent-sdk` ships version 1.0.0 on every rebuild; without a
    // content hash two different SDK builds are indistinguishable in a log.
    writePackage(
      HALO_PACKAGE,
      { name: HALO_PACKAGE, version: '1.0.0', main: 'index.js' },
      { 'index.js': 'build-one' },
    )
    const first = await probe('halo')

    writePackage(
      HALO_PACKAGE,
      { name: HALO_PACKAGE, version: '1.0.0', main: 'index.js' },
      { 'index.js': 'build-two' },
    )
    const second = await probe('halo')

    expect(first.version).toBe(second.version)
    expect(first.fingerprint).not.toBe(second.fingerprint)
  })

  it('caches the probe so repeated reads do not re-stat the package tree', async () => {
    const { getEngineAvailability } = await loadProbe()

    const before = await getEngineAvailability()
    writePackage(
      HALO_PACKAGE,
      { name: HALO_PACKAGE, version: '1.0.0', main: 'index.js' },
      { 'index.js': 'appeared-after-first-probe' },
    )
    const after = await getEngineAvailability()

    expect(after).toBe(before)
  })
})
