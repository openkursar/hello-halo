import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  spaces: new Map<string, any>(), events: [] as string[], people: [] as any[], pinned: [] as string[],
  relocate: vi.fn(), countSpace: vi.fn(), countChats: vi.fn(), maintenance: vi.fn(), stopSpace: vi.fn(), releaseSpace: vi.fn(),
  suspend: vi.fn(), drainMemory: vi.fn(), releaseMemory: vi.fn(),
}))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: (id: string) => env.spaces.get(id) ?? null,
  getHaloSpace: () => env.spaces.get('halo-temp'),
  getSpaceMemoryLayout: (id: string) => ({ type: 'space', spaceId: id }),
}))
vi.mock('../../../../src/main/services/agent', () => ({ beginSpaceMaintenance: env.maintenance, countSpaceWorkspaceWork: env.countSpace }))
vi.mock('../../../../src/main/services/memory-consolidation', () => ({ suspendMemoryConsolidation: env.suspend }))
vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({ countAppChats: env.countChats, stopAndDrainAppChats: vi.fn() }))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamService: () => undefined, getTeamStore: () => undefined }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/apps/runtime/space-change', () => ({ relocateAppWorkspace: env.relocate }))
import { deleteWorkspacePreservingPeople, previewWorkspaceDeletion } from '../../../../src/main/apps/runtime/workspace-deletion'

function fixture() {
  return {
    manager: {
      listApps: vi.fn(() => env.people),
      holdWorkspaceData: vi.fn(() => { env.events.push('hold-installations'); return () => env.events.push('release-installations') }),
    },
    store: { listAppIdsPinnedInSpace: vi.fn(() => env.pinned) },
    runtime: { getAppWorkspaceWorkCount: vi.fn((id: string) => id === 'resident' ? 2 : 1) },
  }
}
function person(id: string, spaceId = 'source', status = 'active', dataPath?: string) {
  return { id, spaceId, status, dataPath, spec: { type: 'automation', name: 'Same name' } }
}

beforeEach(() => {
  vi.clearAllMocks()
  env.spaces.clear()
  for (const id of ['source', 'destination', 'halo-temp']) env.spaces.set(id, { id, path: `/fixtures/${id}`, isTemp: id === 'halo-temp' })
  env.events.length = 0
  env.people = []
  env.pinned = []
  env.countSpace.mockReturnValue(3)
  env.countChats.mockReturnValue(4)
  env.stopSpace.mockImplementation(async () => { env.events.push('stop-space') })
  env.releaseSpace.mockImplementation(() => env.events.push('release-space'))
  env.maintenance.mockImplementation(() => { env.events.push('hold-space'); return { stopAndDrain: env.stopSpace, release: env.releaseSpace } })
  env.drainMemory.mockImplementation(async () => { env.events.push('drain-memory') })
  env.releaseMemory.mockImplementation(() => env.events.push('release-memory'))
  env.suspend.mockImplementation(() => { env.events.push('suspend-memory'); return { drain: env.drainMemory, release: env.releaseMemory } })
  env.relocate.mockImplementation(async (_deps, id, destination) => {
    env.events.push(`relocate:${id}:${destination}`)
    const app = env.people.find(app => app.id === id)
    app.spaceId = destination
    app.dataPath = undefined
    env.pinned = env.pinned.filter(pinned => pinned !== id)
  })
})

describe('workspace deletion orchestration', () => {
  it('previews only affected residents and counts ordinary work plus affected app runs and chats without fences', () => {
    env.people = [person('resident'), person('moved', 'destination', 'active', '/fixtures/source/.halo/apps/moved'), person('unrelated', 'destination')]
    const deps = fixture()
    const preview = previewWorkspaceDeletion(deps as never, 'source')
    expect(preview.digitalHumans).toEqual([{ id: 'resident', name: 'Same name' }])
    expect(deps.manager.listApps).toHaveBeenCalledWith({ type: 'automation' })
    expect(deps.runtime.getAppWorkspaceWorkCount.mock.calls).toEqual([['resident'], ['moved']])
    expect(env.countChats.mock.calls).toEqual([['resident'], ['moved']])
    expect(env.countSpace).toHaveBeenCalledWith('source', { ordinaryOnly: true })
    expect(preview.activeWorkCount).toBe(14)
    expect(env.events).toEqual([])
    expect(env.relocate).not.toHaveBeenCalled()
    expect(deps.manager.holdWorkspaceData).not.toHaveBeenCalled()
  })

  it('moves every resident including uninstalled same-name people to Halo Workspace before removing', async () => {
    env.people = [person('resident'), person('removed', 'source', 'uninstalled')]
    const deps = fixture()
    const remove = vi.fn(async () => { env.events.push('remove'); return true })
    await expect(deleteWorkspacePreservingPeople(deps as never, 'source', remove)).resolves.toBe(true)
    expect(deps.manager.holdWorkspaceData).toHaveBeenCalledWith([], 'source')
    expect(env.relocate.mock.calls.map(call => call.slice(1))).toEqual([['resident', 'halo-temp', '/fixtures/source'], ['removed', 'halo-temp', '/fixtures/source']])
    expect(env.events).toEqual(['hold-space', 'hold-installations', 'suspend-memory', 'relocate:resident:halo-temp', 'relocate:removed:halo-temp', 'stop-space', 'drain-memory', 'remove', 'release-memory', 'release-space', 'release-installations'])
    expect(env.people.map(app => app.spaceId)).toEqual(['halo-temp', 'halo-temp'])
    expect(remove).toHaveBeenCalledOnce()
  })

  it('repairs pinned and data-path legacy dependents into their current workspace, not Halo Workspace', async () => {
    env.people = [person('pinned', 'destination'), person('data', 'destination', 'active', '/fixtures/source/.halo/apps/data'), person('unrelated', 'destination')]
    env.pinned = ['pinned']
    const deps = fixture()
    const remove = vi.fn(async () => true)
    await deleteWorkspacePreservingPeople(deps as never, 'source', remove)
    expect(env.relocate.mock.calls.map(call => call.slice(1))).toEqual([['pinned', 'destination', '/fixtures/source'], ['data', 'destination', '/fixtures/source']])
    expect(env.people.every(app => app.spaceId === 'destination')).toBe(true)
    expect(remove).toHaveBeenCalledOnce()
  })

  it('rescues a dependent whose current workspace is unavailable into Halo Workspace', async () => {
    env.people = [person('stranded', 'missing', 'active', '/fixtures/source/.halo/apps/stranded')]
    const deps = fixture()
    await deleteWorkspacePreservingPeople(deps as never, 'source', async () => true)
    expect(env.relocate).toHaveBeenCalledWith(deps, 'stranded', 'halo-temp', '/fixtures/source')
  })

  it.each(['relocate', 'space-drain', 'memory-drain', 'remove'])('propagates %s errors and releases acquired holds without deleting prematurely', async failure => {
    env.people = [person('resident')]
    const deps = fixture()
    const error = new Error(`${failure} failed`)
    const remove = vi.fn(async () => true)
    if (failure === 'relocate') env.relocate.mockRejectedValueOnce(error)
    if (failure === 'space-drain') env.stopSpace.mockRejectedValueOnce(error)
    if (failure === 'memory-drain') env.drainMemory.mockRejectedValueOnce(error)
    if (failure === 'remove') remove.mockRejectedValueOnce(error)
    await expect(deleteWorkspacePreservingPeople(deps as never, 'source', remove)).rejects.toBe(error)
    expect(env.events.slice(-3)).toEqual(['release-memory', 'release-space', 'release-installations'])
    if (failure !== 'remove') expect(remove).not.toHaveBeenCalled()
    expect(env.spaces.has('source')).toBe(true)
  })

  it('refuses removal if a relocation leaves any legacy dependency behind', async () => {
    env.people = [person('resident')]
    env.relocate.mockResolvedValueOnce(undefined)
    const remove = vi.fn(async () => true)
    await expect(deleteWorkspacePreservingPeople(fixture() as never, 'source', remove)).rejects.toThrow('still depends on this workspace')
    expect(remove).not.toHaveBeenCalled()
    expect(env.events.slice(-3)).toEqual(['release-memory', 'release-space', 'release-installations'])
  })

  it('returns a failed removal result without converting it to success and still releases', async () => {
    await expect(deleteWorkspacePreservingPeople(fixture() as never, 'source', async () => false)).resolves.toBe(false)
    expect(env.events.slice(-3)).toEqual(['release-memory', 'release-space', 'release-installations'])
  })

  it.each(['halo-temp', 'missing'])('never deletes the Halo workspace or an unavailable workspace: %s', async spaceId => {
    const deps = fixture()
    const remove = vi.fn(async () => true)
    await expect(deleteWorkspacePreservingPeople(deps as never, spaceId, remove)).resolves.toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(deps.manager.holdWorkspaceData).not.toHaveBeenCalled()
    expect(env.events).toEqual([])
  })
})
