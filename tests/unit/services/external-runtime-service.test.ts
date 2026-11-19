import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeId } from '../../../src/shared/types/external-runtime'
import type { RuntimeProvider } from '../../../src/main/services/external-runtime/provider'

const state = vi.hoisted(() => ({ config: { agent: {} } as any, catalogs: new Map<string, any>(), probes: new Map<string, any>(), reuses: new Map<string, any>() }))
vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: () => state.config,
  saveConfig: (patch: any) => { state.config = { ...state.config, ...patch } }
}))
vi.mock('../../../src/main/services/external-runtime/paths', () => ({ getRuntimeRoot: (provider: RuntimeProvider) => `/runtime/${provider.id}` }))
vi.mock('../../../src/main/services/external-runtime/catalog', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/main/services/external-runtime/catalog')>(),
  mergeInstallationSnapshot: (previous: any, current: any) => ({ ...previous, ...current }),
  createRuntimeCatalog: (provider: RuntimeProvider) => {
    const catalog = { getCatalogEntry: vi.fn(async () => undefined), getCatalogSnapshot: vi.fn(async () => ({ installations: [], truncated: false })), rememberInstallation: vi.fn(async () => {}), getManagedCatalogEntries: vi.fn(async () => []) }
    state.catalogs.set(provider.id, catalog)
    return catalog
  }
}))
vi.mock('../../../src/main/services/external-runtime/probe', () => ({ createRuntimeProbe: (provider: RuntimeProvider) => {
  const probe = { checkInstallation: vi.fn(async (path: string) => record(path)), readKnownInstallation: vi.fn(), launchForInstallation: vi.fn(async (path: string) => ({ executable: path, kind: 'native', version: '1.2.3' })), shutdownProbes: vi.fn() }
  state.probes.set(provider.id, probe)
  return probe
} }))
vi.mock('../../../src/main/services/external-runtime/reuse', () => ({ createRuntimeReuse: (provider: RuntimeProvider) => {
  const reuse = { reuseManagedInstallation: vi.fn(async () => record('/managed')) }
  state.reuses.set(provider.id, reuse)
  return reuse
} }))
vi.mock('../../../src/main/services/external-runtime/releases', () => ({ createRuntimeReleases: () => ({ clearReleaseCache: vi.fn() }) }))
vi.mock('../../../src/main/services/external-runtime/discovery', () => ({ createRuntimeDiscovery: () => ({ discoverInstallations: vi.fn() }) }))
vi.mock('../../../src/main/services/external-runtime/installer', () => ({ createRuntimeInstaller: () => ({ downloadAndPublish: vi.fn() }) }))
vi.mock('../../../src/main/services/external-runtime/sources', () => ({ isInstallVersion: () => true, createRuntimeSources: () => ({ getSources: () => [], getEffectiveSourceId: () => 'official', validatePreferences: (value: unknown) => value }) }))
import { createExternalRuntime } from '../../../src/main/services/external-runtime/service'

function record(path: string) { return { path, version: '1.2.3', kind: 'native', managed: false, recommended: false, compatibility: 'compatible' } }
function provider(id: RuntimeId) {
  return { id, configKey: id === 'anthropic' ? 'ccRuntime' : 'codexRuntime', recommendedVersion: '1.2.3', recommendedRange: '1.2.3', verifiedVersions: () => [], resolveCandidate: vi.fn(async () => ({ stamp: 'first' })) } as unknown as RuntimeProvider
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => { state.config = { agent: {} }; state.catalogs.clear(); state.probes.clear(); state.reuses.clear() })

describe.each(['anthropic', 'codex'] as const)('%s generic runtime service', id => {
  it('captures selection order before catalog or probe awaits', async () => {
    const runtime = createExternalRuntime(provider(id))
    const catalog = state.catalogs.get(id)
    const older = deferred<undefined>()
    catalog.getCatalogEntry.mockImplementation((path: string) => path === '/old' ? older.promise : Promise.resolve(undefined))
    const first = runtime.select('/old')
    await runtime.select('/new')
    older.resolve(undefined)
    await first
    const key = id === 'anthropic' ? 'ccRuntime' : 'codexRuntime'
    expect(state.config.agent[key].selectedPath).toBe('/new')
    expect(catalog.rememberInstallation).toHaveBeenCalledTimes(2)
  })

  it('does no process checks or component integrity work when reading status', async () => {
    const runtime = createExternalRuntime(provider(id))
    await runtime.getStatus()
    expect(state.probes.get(id).checkInstallation).not.toHaveBeenCalled()
    expect(state.probes.get(id).launchForInstallation).not.toHaveBeenCalled()
    expect(state.reuses.get(id).reuseManagedInstallation).not.toHaveBeenCalled()
  })

  it('rechecks managed integrity only on cold or changed component stamps', async () => {
    const adapter = provider(id)
    const runtime = createExternalRuntime(adapter)
    const key = id === 'anthropic' ? 'ccRuntime' : 'codexRuntime'
    state.config.agent[key] = { selectedPath: '/managed' }
    state.catalogs.get(id).getCatalogEntry.mockResolvedValue({ installation: record('/managed'), integrity: { platform: 'darwin-arm64', checksum: 'a'.repeat(64) } })
    expect(await runtime.resolveLaunch()).not.toBeNull()
    expect(await runtime.resolveLaunch()).not.toBeNull()
    expect(state.reuses.get(id).reuseManagedInstallation).toHaveBeenCalledTimes(1)
    vi.mocked(adapter.resolveCandidate).mockResolvedValue({ stamp: 'helper-changed' } as any)
    state.reuses.get(id).reuseManagedInstallation.mockResolvedValueOnce(null)
    expect(await runtime.resolveLaunch()).toBeNull()
    expect(state.reuses.get(id).reuseManagedInstallation).toHaveBeenCalledTimes(2)
    expect(state.probes.get(id).launchForInstallation).toHaveBeenCalledTimes(2)
  })
})

it.each(['missing-integrity', 'missing-version', 'missing-helper', 'wrong-pin'])('fails closed at every service entry for managed %s', async problem => {
  const pin = `sha512-${Buffer.alloc(64, 1).toString('base64')}`
  const adapter = { ...provider('codex'), requiredComponents: () => ['codex', 'rg'], pinnedIntegrity: () => pin }
  const runtime = createExternalRuntime(adapter)
  const installation = { ...record('/managed/codex'), managed: true, compatibility: 'unavailable', issue: 'checksum-mismatch', checkedAt: '2020-01-01' }
  const entry = { installation: { ...installation, version: problem === 'missing-version' ? undefined : '1.2.3' },
    ...(problem === 'missing-integrity' ? {} : { integrity: {
      platform: 'darwin-arm64', directory: '/managed', artifactIntegrity: problem === 'wrong-pin' ? `sha512-${Buffer.alloc(64, 2).toString('base64')}` : pin,
      components: [{ path: 'codex', checksum: 'a'.repeat(64), size: 1 }, ...(problem === 'missing-helper' ? [] : [{ path: 'rg', checksum: 'b'.repeat(64), size: 1 }])]
    } }) }
  state.config.agent.codexRuntime = { selectedPath: '/previous' }
  state.catalogs.get('codex').getCatalogEntry.mockResolvedValue(entry)
  await expect(runtime.select('/managed/codex')).rejects.toMatchObject({ code: 'checksum-mismatch' })
  expect(state.config.agent.codexRuntime.selectedPath).toBe('/previous')
  state.config.agent.codexRuntime.selectedPath = '/managed/codex'
  expect(await runtime.resolveLaunch()).toBeNull()
  expect(await runtime.probeInstallation('/managed/codex')).toMatchObject({ managed: true, compatibility: 'unavailable', issue: 'checksum-mismatch' })
  state.catalogs.get('codex').getCatalogSnapshot.mockResolvedValue({ installations: [entry.installation], truncated: false })
  state.probes.get('codex').readKnownInstallation.mockReturnValue({ ...record('/managed/codex'), checkedAt: '2030-01-01' })
  expect((await runtime.getStatus()).selected).toMatchObject({ managed: true, compatibility: 'unavailable', issue: 'checksum-mismatch' })
  expect(state.probes.get('codex').checkInstallation).not.toHaveBeenCalled()
  expect(state.probes.get('codex').launchForInstallation).not.toHaveBeenCalled()
  expect(state.reuses.get('codex').reuseManagedInstallation).not.toHaveBeenCalled()
  expect(adapter.resolveCandidate).not.toHaveBeenCalled()
  expect(state.catalogs.get('codex').rememberInstallation).not.toHaveBeenCalled()
})

it('preserves legacy CC managed records without component requirements', async () => {
  const runtime = createExternalRuntime(provider('anthropic'))
  state.catalogs.get('anthropic').getCatalogEntry.mockResolvedValue({ installation: { ...record('/legacy'), managed: true } })
  await expect(runtime.select('/legacy')).resolves.toMatchObject({ path: '/legacy' })
  expect(state.probes.get('anthropic').checkInstallation).toHaveBeenCalledOnce()
})

it('keeps selection and status state isolated between runtime instances', async () => {
  const anthropic = createExternalRuntime(provider('anthropic'))
  const codex = createExternalRuntime(provider('codex'))
  await Promise.all([anthropic.select('/claude'), codex.select('/codex')])
  expect(state.config.agent.ccRuntime.selectedPath).toBe('/claude')
  expect(state.config.agent.codexRuntime.selectedPath).toBe('/codex')
  expect((await anthropic.getStatus()).selectedPath).toBe('/claude')
  expect((await codex.getStatus()).selectedPath).toBe('/codex')
  expect(state.catalogs.get('anthropic').rememberInstallation).toHaveBeenCalledWith(expect.objectContaining({ path: '/claude' }))
  expect(state.catalogs.get('codex').rememberInstallation).toHaveBeenCalledWith(expect.objectContaining({ path: '/codex' }))
})
