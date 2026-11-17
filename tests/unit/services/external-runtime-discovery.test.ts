import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeDiscovery } from '../../../src/main/services/external-runtime/discovery'
import type { RuntimeProvider } from '../../../src/main/services/external-runtime/provider'
import type { createRuntimeProbe } from '../../../src/main/services/external-runtime/probe'

vi.mock('../../../src/main/foundation/config.service', () => ({ getHaloDir: () => globalThis.__HALO_TEST_DIR__ }))

describe('external runtime directory discovery', () => {
  it('passes an existing recognized directory to provider resolution before probing', async () => {
    const directory = join(globalThis.__HALO_TEST_DIR__, 'managed-package')
    await mkdir(directory)
    const executable = join(directory, 'native-runtime')
    const resolveCandidate = vi.fn(async () => ({ path: executable, resolvedPath: executable }))
    const checkInstallation = vi.fn(async () => ({ path: executable, compatibility: 'compatible' }))
    const provider = {
      id: 'codex', directoryName: 'codex',
      discoveryCandidates: async () => ({ paths: [directory], truncated: false }),
      resolveCandidate
    } as unknown as RuntimeProvider
    const discovery = createRuntimeDiscovery(provider, { checkInstallation } as unknown as ReturnType<typeof createRuntimeProbe>)
    const result = await discovery.discoverInstallations()
    expect(resolveCandidate).toHaveBeenCalledWith(directory)
    expect(checkInstallation).toHaveBeenCalledWith(executable, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(result).toMatchObject({ searchedLocations: 1, truncated: false, installations: [{ path: executable }] })
  })
})
