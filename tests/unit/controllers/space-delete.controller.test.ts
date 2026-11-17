import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
const m = vi.hoisted(() => ({
  busy: vi.fn(),
  remove: vi.fn<[string, () => Promise<boolean>], Promise<boolean>>(),
  deleteData: vi.fn<[string], Promise<boolean>>(),
  destroyCache: vi.fn<[string], Promise<void>>(),
}))

vi.mock('../../../src/main/services/space.service', () => ({
  deleteSpace: (id: string) => m.deleteData(id),
}))
vi.mock('../../../src/main/services/memory-consolidation', () => ({}))
vi.mock('../../../src/main/services/agent', () => ({ isSpaceBusy: m.busy }))
vi.mock('../../../src/main/services/watcher-host.service', () => ({}))
vi.mock('../../../src/main/services/artifact-cache.service', () => ({
  destroySpaceCache: (id: string) => m.destroyCache(id),
}))
vi.mock('../../../src/main/apps/runtime', () => ({ removeWorkspacePreservingPeople: m.remove }))

import { deleteSpace } from '../../../src/main/controllers/space.controller'

beforeEach(() => {
  calls.length = 0
  m.busy.mockReset().mockReturnValue(true)
  m.deleteData.mockReset().mockImplementation(async id => {
    calls.push(`delete ${id}`)
    return true
  })
  m.destroyCache.mockReset().mockImplementation(async id => { calls.push(`files ${id}`) })
  m.remove.mockReset().mockImplementation(async (id, removeData) => {
    calls.push(`stop and rescue ${id}`)
    return removeData()
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('deleteSpace', () => {
  it('delegates stopping and rescue to runtime before cache and data removal, without a busy refusal', async () => {
    expect(await deleteSpace('space-1')).toEqual({ success: true })
    expect(m.remove).toHaveBeenCalledWith('space-1', expect.any(Function))
    expect(m.busy).not.toHaveBeenCalled()
    expect(calls).toEqual(['stop and rescue space-1', 'files space-1', 'delete space-1'])
  })

  it('does not remove cache or data until runtime invokes the preservation callback', async () => {
    let removeData!: () => Promise<boolean>
    let finish!: (result: boolean) => void
    m.remove.mockImplementation((_id, callback) => {
      removeData = callback
      return new Promise(resolve => { finish = resolve })
    })

    const pending = deleteSpace('space-1')
    await vi.waitFor(() => expect(removeData).toBeDefined())
    expect(calls).toEqual([])
    finish(await removeData())

    expect(await pending).toEqual({ success: true })
    expect(calls).toEqual(['files space-1', 'delete space-1'])
  })

  it.each(['A workspace reply could not stop', 'Digital human history could not be preserved'])(
    'keeps data when runtime preparation fails: %s', async message => {
      m.remove.mockRejectedValueOnce(new Error(message))

      expect(await deleteSpace('space-1')).toEqual({ success: false, error: message })
      expect(m.destroyCache).not.toHaveBeenCalled()
      expect(m.deleteData).not.toHaveBeenCalled()
    }
  )

  it('reports a cache-close failure without deleting data', async () => {
    m.destroyCache.mockRejectedValueOnce(new Error('Watcher could not close'))

    expect(await deleteSpace('space-1')).toEqual({ success: false, error: 'Watcher could not close' })
    expect(m.deleteData).not.toHaveBeenCalled()
  })

  it('propagates a data-removal error through runtime to the caller', async () => {
    m.deleteData.mockRejectedValueOnce(new Error('ENOSPC: index could not be saved'))

    expect(await deleteSpace('space-1')).toEqual({ success: false, error: 'ENOSPC: index could not be saved' })
    expect(m.destroyCache).toHaveBeenCalledWith('space-1')
  })

  it('reports a delete that did not happen as a failure', async () => {
    m.deleteData.mockResolvedValueOnce(false)

    expect(await deleteSpace('space-1')).toEqual({ success: false })
  })
})
