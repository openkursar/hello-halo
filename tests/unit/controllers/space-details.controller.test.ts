import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  getSpace: vi.fn(),
  deletionImpact: vi.fn(),
}))

vi.mock('../../../src/main/services/space.service', () => ({ getSpaceWithPreferences: m.getSpace }))
vi.mock('../../../src/main/services/memory-consolidation', () => ({}))
vi.mock('../../../src/main/services/agent', () => ({}))
vi.mock('../../../src/main/services/watcher-host.service', () => ({}))
vi.mock('../../../src/main/services/artifact-cache.service', () => ({}))
vi.mock('../../../src/main/apps/runtime', () => ({ getWorkspaceDeletionImpact: m.deletionImpact }))

import { getSpace } from '../../../src/main/controllers/space.controller'

const space = { id: 'space-1', name: 'Project', path: '/owned/project', isTemp: false }
const deletionImpact = { digitalHumans: [{ id: 'person-1', name: 'Researcher' }], activeWorkCount: 2 }

beforeEach(() => {
  m.getSpace.mockReset().mockReturnValue(space)
  m.deletionImpact.mockReset().mockResolvedValue(deletionImpact)
})

describe('getSpace deletion impact', () => {
  it.each([undefined, {}, { includeDeletionImpact: false }])('does not compute deletion impact for ordinary reads: %j', async options => {
    expect(await getSpace('space-1', options)).toEqual({ success: true, data: space })
    expect(m.getSpace).toHaveBeenCalledWith('space-1')
    expect(m.deletionImpact).not.toHaveBeenCalled()
  })

  it('awaits runtime impact only when explicitly requested, without mutating the space record', async () => {
    expect(await getSpace('space-1', { includeDeletionImpact: true })).toEqual({
      success: true,
      data: { ...space, deletionImpact },
    })
    expect(m.deletionImpact).toHaveBeenCalledTimes(1)
    expect(m.deletionImpact).toHaveBeenCalledWith('space-1')
    expect(space).not.toHaveProperty('deletionImpact')
  })

  it('never computes deletion impact for the Halo workspace', async () => {
    const halo = { ...space, id: 'halo-temp', isTemp: true }
    m.getSpace.mockReturnValueOnce(halo)

    expect(await getSpace('halo-temp', { includeDeletionImpact: true })).toEqual({ success: true, data: halo })
    expect(m.deletionImpact).not.toHaveBeenCalled()
  })

  it('does not scan runtime state for a missing space', async () => {
    m.getSpace.mockReturnValueOnce(null)

    expect(await getSpace('missing', { includeDeletionImpact: true })).toEqual({ success: false, error: 'Space not found' })
    expect(m.deletionImpact).not.toHaveBeenCalled()
  })

  it('returns impact calculation failures to the confirmation caller', async () => {
    m.deletionImpact.mockRejectedValueOnce(new Error('Digital human services are not ready'))

    expect(await getSpace('space-1', { includeDeletionImpact: true })).toEqual({
      success: false, error: 'Digital human services are not ready',
    })
  })
})
