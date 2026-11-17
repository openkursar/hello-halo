import { describe, expect, it, vi } from 'vitest'
import { createRuntimeProbe } from '../../../src/main/services/external-runtime/probe'
import type { RuntimeProvider } from '../../../src/main/services/external-runtime/provider'

vi.mock('../../../src/main/foundation/config.service', () => ({ getHaloDir: () => globalThis.__HALO_TEST_DIR__ }))

describe('shared external runtime probe scheduling', () => {
  it('bounds both providers together to three active checks and 24 queued checks', async () => {
    let active = 0
    let maximum = 0
    const release: Array<() => void> = []
    const provider = (id: 'anthropic' | 'codex') => ({
      id,
      directoryName: id,
      configKey: id === 'anthropic' ? 'ccRuntime' : 'codexRuntime',
      recommendedVersion: '1.0.0',
      recommendedRange: '1.0.0',
      officialSource: { id: 'official', name: 'Fixture', baseUrl: 'https://fixture.invalid' },
      presetSource: () => undefined,
      getPlatform: () => 'darwin-arm64',
      verifiedVersions: () => [],
      discoveryCandidates: async () => ({ paths: [], truncated: false }),
      fetchRelease: async () => { throw new Error('Unexpected release lookup') },
      materialize: async () => { throw new Error('Unexpected materialization') },
      resolveCandidate: async (path: string) => ({ path, resolvedPath: path, stamp: path, launch: { command: path, path, argsPrefix: [], env: {}, kind: 'native' } }),
      probe: async () => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise<void>(resolve => release.push(resolve))
        active--
        return '1.0.0'
      },
      isRecommendedVersion: () => false,
      isVerifiedRuntime: () => false
    }) as RuntimeProvider
    const first = createRuntimeProbe(provider('anthropic'))
    const second = createRuntimeProbe(provider('codex'))
    const checks = Array.from({ length: 28 }, (_, index) => (index % 2 ? first : second).checkInstallation(`/runtime-${index}`))
    await vi.waitFor(() => expect(release).toHaveLength(3))
    expect(maximum).toBe(3)
    for (let index = 0; index < 27; index++) {
      await vi.waitFor(() => expect(release.length).toBeGreaterThan(index))
      release[index]()
    }
    const results = await Promise.all(checks)
    expect(maximum).toBe(3)
    expect(results.filter(result => result.issue === 'probe-busy')).toHaveLength(1)
    expect(results.filter(result => result.compatibility === 'compatible')).toHaveLength(27)
    await first.shutdownProbes()
    await second.shutdownProbes()
  })

  it('returns the launch captured by each check when old and new stamps finish together', async () => {
    let revision = 'old'
    const finish = new Map<string, () => void>()
    const provider = {
      id: 'codex', directoryName: 'codex',
      resolveCandidate: async (path: string) => ({ path, resolvedPath: `/${revision}`, stamp: revision,
        launch: { command: `/${revision}`, path, argsPrefix: [], env: {}, kind: 'native' } }),
      probe: async (candidate: { stamp: string }) => {
        await new Promise<void>(resolve => finish.set(candidate.stamp, resolve))
        return candidate.stamp === 'old' ? '1.0.0' : '2.0.0'
      },
      isRecommendedVersion: () => false, isVerifiedRuntime: () => false
    } as unknown as RuntimeProvider
    const probe = createRuntimeProbe(provider)
    const oldLaunch = probe.launchForInstallation('/selected')
    await vi.waitFor(() => expect(finish.has('old')).toBe(true))
    revision = 'new'
    const newLaunch = probe.launchForInstallation('/selected')
    await vi.waitFor(() => expect(finish.has('new')).toBe(true))
    finish.get('new')!()
    finish.get('old')!()
    await expect(oldLaunch).resolves.toMatchObject({ command: '/old', version: '1.0.0' })
    await expect(newLaunch).resolves.toMatchObject({ command: '/new', version: '2.0.0' })
    await probe.shutdownProbes()
  })
})
