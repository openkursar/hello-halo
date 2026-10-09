/**
 * Deleting a space, as IPC and HTTP both reach it: refused while anything runs
 * in it; otherwise its engine processes and file watching stop before its
 * folder is removed, since Windows will not remove a folder still in use. A
 * delete that did not happen is reported as a failure, not as a success.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
const m = vi.hoisted(() => ({
  busy: vi.fn((_spaceId: string) => false),
  deleted: true,
}))

vi.mock('../../../src/main/services/space.service', () => ({
  deleteSpace: async (id: string) => {
    calls.push(`delete ${id}`)
    return m.deleted
  },
  forgetSpace: vi.fn(),
}))
vi.mock('../../../src/main/services/memory-consolidation', () => ({ getSpaceMemoryStatus: vi.fn(), consolidateSpaceMemoryNow: vi.fn() }))
vi.mock('../../../src/main/services/agent', () => ({
  isSpaceBusy: (id: string) => m.busy(id),
  closeSpaceSessions: async (id: string, reason: string) => { calls.push(`sessions ${id} (${reason})`) },
}))
vi.mock('../../../src/main/services/watcher-host.service', () => ({}))
vi.mock('../../../src/main/services/artifact-cache.service', () => ({
  destroySpaceCache: async (id: string) => { calls.push(`files ${id}`) },
}))
vi.mock('../../../src/main/apps/runtime', () => ({}))

import { deleteSpace } from '../../../src/main/controllers/space.controller'

const BUSY = {
  success: false,
  error: 'A reply, run or background task is still going in this workspace. Delete it once it has finished, or stop it first.',
  code: 'SPACE_BUSY',
}

beforeEach(() => {
  calls.length = 0
  m.deleted = true
  m.busy.mockReset().mockReturnValue(false)
})

describe('deleteSpace', () => {
  it('stops the space’s sessions and file watching, then deletes it', async () => {
    expect(await deleteSpace('space-1')).toEqual({ success: true })
    expect(calls).toEqual(['sessions space-1 (space deleted)', 'files space-1', 'delete space-1'])
  })

  it('refuses while anything runs in the space, touching nothing', async () => {
    m.busy.mockReturnValue(true)

    expect(await deleteSpace('space-1')).toEqual(BUSY)
    expect(calls).toEqual([])
  })

  it('refuses when something started while its sessions were closing', async () => {
    m.busy.mockReturnValueOnce(false).mockReturnValueOnce(true)

    expect(await deleteSpace('space-1')).toEqual(BUSY)
    expect(calls).not.toContain('delete space-1')
  })

  it('reports a delete that did not happen as a failure', async () => {
    m.deleted = false

    expect((await deleteSpace('space-1')).success).toBe(false)
  })
})
