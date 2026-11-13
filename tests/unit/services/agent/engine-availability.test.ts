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
import { createHash } from 'node:crypto'

const runtime = vi.hoisted(() => ({ launch: null as any, config: {} as any, resolve: vi.fn() }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => runtime.config }))
vi.mock('../../../../src/main/services/cc-runtime', () => ({ resolveCcRuntimeLaunch: runtime.resolve }))
const HALO_PACKAGE = '@hello-halo/agent-sdk'

function appNodeModules(): string {
  return path.join(globalThis.__HALO_TEST_DIR__, 'app', 'node_modules')
}

/** Write a package into the fake packaged app's node_modules. */
function writePackage(
  packageId: string,
  manifest: Record<string, unknown>,
  entries: Record<string, string> = {},
  includeNative = true,
): void {
  const pkgDir = path.join(appNodeModules(), ...packageId.split('/'))
  fs.mkdirSync(pkgDir, { recursive: true })
  if (packageId === HALO_PACKAGE && includeNative && Object.keys(entries).length) {
    const source = Object.values(entries).join('\n')
    const buildId = createHash('sha256').update(source).digest('hex')
    const platform = `${process.platform}-${process.arch}`
    const filename = `halo-sdk.${platform}.node`
    manifest = { ...manifest, exports: { ...(manifest.exports as Record<string, unknown> | undefined),
      './native': { import: './dist/native/index.js' } } }
    entries = { ...entries, 'dist/native/index.js': 'export const createNativeRuntime = () => {}',
      'dist/native/binding.js': '', [`dist/native/${filename}`]: source,
      'dist/native/build-info.json': JSON.stringify({ implementation: 'rust', abiVersion: 1, buildId,
        artifacts: [{ platform, filename, sha256: buildId }] }) }
  }
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
    runtime.launch = null
    runtime.config = {}
    runtime.resolve.mockReset().mockImplementation(async () => runtime.launch)
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

  it.each([undefined, {}, { selectedPath: '/automatic/claude', discoveryCompleted: true }])('does not inspect CC files without explicit selection: %j', async ccRuntime => {
    runtime.config = { agent: { sdkEngine: 'anthropic', ccRuntime } }
    const { getEngineAvailability } = await loadProbe()
    const spies = [vi.spyOn(fs, 'existsSync'), vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs.promises, 'stat'), vi.spyOn(fs.promises, 'realpath'), vi.spyOn(fs.promises, 'readFile'), vi.spyOn(fs.promises, 'opendir')]
    try {
      expect((await getEngineAvailability(['anthropic']))[0]).toMatchObject({ available: false, reason: expect.stringContaining('Select an installation once in the Halo desktop app under Settings > Advanced') })
      expect(runtime.resolve).not.toHaveBeenCalled()
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally { spies.forEach(spy => spy.mockRestore()) }
  })

  it.each([true, false])('only the current delegated account authorizes a runtime check: %s', async current => {
    runtime.config = { agent: { ccRuntime: { selectedPath: '/delegated/claude' } }, aiSources: { version: 2, currentId: current ? 'cli' : 'other', sources: [{ id: 'cli', provider: 'claude-cli', authType: 'delegated' }] } }
    runtime.launch = { version: '2.1.89' }
    const { getEngineAvailability } = await loadProbe()
    expect((await getEngineAvailability(['anthropic']))[0].available).toBe(current)
    expect(runtime.resolve).toHaveBeenCalledTimes(current ? 1 : 0)
  })

  it('reports a selected external CC and rechecks after its selection changes', async () => {
    runtime.config = { agent: { ccRuntime: { selectedPath: '/selected/claude', selectionOrigin: 'user' } } }
    runtime.launch = { version: '2.1.89' }
    const { getEngineAvailability } = await loadProbe()
    expect((await getEngineAvailability(['anthropic']))[0]).toMatchObject({ available: true, version: '2.1.89' })
    runtime.launch = null
    expect((await getEngineAvailability(['anthropic']))[0].available).toBe(false)
  })

  it('treats a package with no entry file as unavailable', async () => {
    // The exact shape a broken `file:` dependency produces: manifest links to a
    // dist that was never built.
    writePackage(HALO_PACKAGE, { name: HALO_PACKAGE, version: '1.0.0', main: 'dist/index.js' })

    const result = await probe('halo')

    expect(result.available).toBe(false)
    expect(result.version).toBe('')
  })

  it('rejects a package whose native execution runtime was omitted', async () => {
    writePackage(HALO_PACKAGE, { main: 'dist/index.js' }, { 'dist/index.js': 'export const query = () => {}' }, false)
    expect((await probe('halo')).available).toBe(false)
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

  it('uses native build identity, so a static version still identifies the build', async () => {
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

  it('rejects a native manifest without the current platform library', async () => {
    writePackage(HALO_PACKAGE, { main: 'dist/index.js' }, { 'dist/index.js': 'entry' })
    fs.unlinkSync(path.join(appNodeModules(), HALO_PACKAGE, 'dist/native', `halo-sdk.${process.platform}-${process.arch}.node`))
    expect((await probe('halo')).available).toBe(false)
  })

  it('rejects an incompatible native ABI before loading the implementation', async () => {
    writePackage(HALO_PACKAGE, { main: 'dist/index.js' }, { 'dist/index.js': 'entry' })
    const file = path.join(appNodeModules(), HALO_PACKAGE, 'dist/native/build-info.json')
    const build = JSON.parse(fs.readFileSync(file, 'utf8')); build.abiVersion = 999
    fs.writeFileSync(file, JSON.stringify(build))
    expect((await probe('halo')).available).toBe(false)
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

    expect(after).toEqual(before)
    expect(after.find(e => e.engineId === 'halo')!.available).toBe(false)
  })
})
