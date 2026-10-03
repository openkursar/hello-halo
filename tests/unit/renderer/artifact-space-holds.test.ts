/**
 * The renderer declares which spaces it shows so main can free the rest.
 * One retain per space however many components hold it, one release after the
 * last hold drops (with a grace period so remounts do not thrash the watcher).
 * Held spaces are re-retained periodically, since main expires unrenewed holds.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { retainArtifactSpace, releaseArtifactSpace } = vi.hoisted(() => ({
  retainArtifactSpace: vi.fn(async (..._args: unknown[]): Promise<{ success: boolean; data?: { recreated: boolean } }> => ({ success: true })),
  releaseArtifactSpace: vi.fn(async (..._args: unknown[]) => ({ success: true })),
}))
// The real changed-batch subscription (local dispatch included), over a stub transport.
vi.mock('../../../src/renderer/api/_shared', () => ({
  isElectron: () => false, onEvent: () => () => {}, httpRequest: vi.fn(), getAuthToken: vi.fn(), getRemoteServerUrl: vi.fn(),
}))
vi.mock('../../../src/renderer/api', async () => {
  const { artifactApi } = await import('../../../src/renderer/api/artifact.api')
  return {
    api: {
      retainArtifactSpace,
      releaseArtifactSpace,
      onArtifactChangedBatch: artifactApi.onArtifactChangedBatch,
      emitLocalArtifactChangedBatch: artifactApi.emitLocalArtifactChangedBatch,
    },
  }
})

type Mod = typeof import('../../../src/renderer/services/artifact-space-holds')
let holdArtifactSpace: Mod['holdArtifactSpace']
let api: typeof import('../../../src/renderer/api')['api']

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  retainArtifactSpace.mockClear()
  releaseArtifactSpace.mockClear()
  const mod = await import('../../../src/renderer/services/artifact-space-holds')
  holdArtifactSpace = mod.holdArtifactSpace
  api = (await import('../../../src/renderer/api')).api
})

afterEach(() => {
  vi.useRealTimers()
})

describe('holdArtifactSpace', () => {
  it('retains once and releases once after the last hold and the grace period', () => {
    const a = holdArtifactSpace('s1')
    const b = holdArtifactSpace('s1')
    expect(retainArtifactSpace).toHaveBeenCalledTimes(1)

    a()
    a()
    vi.advanceTimersByTime(10_000)
    expect(releaseArtifactSpace).not.toHaveBeenCalled()

    b()
    vi.advanceTimersByTime(10_000)
    expect(releaseArtifactSpace).toHaveBeenCalledTimes(1)
    expect(releaseArtifactSpace.mock.calls[0][0]).toBe('s1')
    expect(releaseArtifactSpace.mock.calls[0][1]).toBe(retainArtifactSpace.mock.calls[0][1])
  })

  it('cancels a pending release when the space is held again within the grace period', () => {
    holdArtifactSpace('s1')()
    vi.advanceTimersByTime(1000)
    const again = holdArtifactSpace('s1')
    vi.advanceTimersByTime(10_000)

    expect(retainArtifactSpace).toHaveBeenCalledTimes(1)
    expect(releaseArtifactSpace).not.toHaveBeenCalled()
    again()
  })

  it('switching spaces retains the new space and releases the old one', () => {
    const drop = holdArtifactSpace('old')
    drop()
    holdArtifactSpace('new')
    vi.advanceTimersByTime(10_000)

    expect(retainArtifactSpace.mock.calls.map(c => c[0])).toEqual(['old', 'new'])
    expect(releaseArtifactSpace.mock.calls.map(c => c[0])).toEqual(['old'])
  })

  it('renews every held space within the lease and stops once nothing is held', () => {
    const a = holdArtifactSpace('s1')
    const b = holdArtifactSpace('s2')
    retainArtifactSpace.mockClear()

    vi.advanceTimersByTime(60_000)
    expect(retainArtifactSpace.mock.calls.map(c => c[0]).sort()).toEqual(['s1', 's2'])

    a()
    vi.advanceTimersByTime(10_000)
    retainArtifactSpace.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(retainArtifactSpace.mock.calls.map(c => c[0])).toEqual(['s2'])
    const renewedId = retainArtifactSpace.mock.calls[0][1]

    b()
    vi.advanceTimersByTime(10_000)
    expect(releaseArtifactSpace.mock.calls.map(c => [c[0], c[1]])).toEqual([['s1', renewedId], ['s2', renewedId]])
    retainArtifactSpace.mockClear()
    vi.advanceTimersByTime(5 * 60_000)
    expect(retainArtifactSpace).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('raises a lapsed renewal as a resync to changed-batch subscribers', async () => {
    const recreated: unknown[] = []
    const off = api.onArtifactChangedBatch(batch => recreated.push(batch))
    // The first retain of a space always reports recreated; that is not a lapse.
    retainArtifactSpace.mockResolvedValue({ success: true, data: { recreated: true } })
    const drop = holdArtifactSpace('s1')
    await vi.advanceTimersByTimeAsync(0)
    expect(recreated).toEqual([])

    retainArtifactSpace.mockResolvedValue({ success: true, data: { recreated: false } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(recreated).toEqual([])

    retainArtifactSpace.mockResolvedValue({ success: true, data: { recreated: true } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(recreated).toEqual([{ spaceId: 's1', changes: [], resync: true }])
    off()

    drop()
    retainArtifactSpace.mockResolvedValue({ success: true })
  })
})
