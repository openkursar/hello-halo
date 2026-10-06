/**
 * Changing a space's working directory, as IPC and HTTP both reach it: the
 * stored sessions of every folder the space used are copied before anything
 * points at the new one, then the record, the pinned environments, resident
 * sessions and the file panel follow — and a failure early on changes nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
const m = vi.hoisted(() => ({
  space: { id: 'space-1', isTemp: false } as { id: string; isTemp: boolean } | null,
  problem: null as string | null,
  copy: vi.fn(async (_from: string, _to: string) => 0),
}))

vi.mock('../../../src/main/services/space.service', () => ({
  getHaloSpace: vi.fn(),
  listSpaces: vi.fn(),
  createSpace: vi.fn(),
  deleteSpace: vi.fn(),
  forgetSpace: vi.fn(),
  getSpaceWithPreferences: vi.fn(),
  openSpaceFolder: vi.fn(),
  updateSpace: vi.fn(),
  reorderSpaces: vi.fn(),
  getSpacePreferences: vi.fn(),
  updateSpacePreferences: vi.fn(),
  getSpace: () => m.space,
  getSpaceDir: () => '/work/old',
  workingDirProblem: () => m.problem,
  setSpaceWorkingDir: (_id: string, dir: string) => {
    calls.push(`record ${dir}`)
    return { id: 'space-1', workingDir: dir }
  },
}))
vi.mock('../../../src/main/services/memory-consolidation', () => ({ getSpaceMemoryStatus: vi.fn(), consolidateSpaceMemoryNow: vi.fn() }))
vi.mock('../../../src/main/services/agent', () => ({
  copyStoredSessions: async (from: string, to: string) => {
    calls.push(`copy ${from} -> ${to}`)
    return m.copy(from, to)
  },
  invalidateSessionsForSpace: (id: string) => calls.push(`sessions ${id}`),
}))
vi.mock('../../../src/main/services/watcher-host.service', () => ({ rerootSpaceWatcher: (id: string, dir: string) => calls.push(`watcher ${id} ${dir}`) }))
vi.mock('../../../src/main/services/artifact-cache.service', () => ({ rerootSpaceCache: (id: string, dir: string) => calls.push(`files ${id} ${dir}`) }))
vi.mock('../../../src/main/apps/runtime', () => ({
  listPinnedWorkDirs: () => ['/work/old', '/work/older'],
  repointSpaceEnvironments: (id: string, dir: string) => {
    calls.push(`pins ${id} ${dir}`)
    return 2
  },
}))

import { changeSpaceWorkingDir } from '../../../src/main/controllers/space.controller'

beforeEach(() => {
  calls.length = 0
  m.space = { id: 'space-1', isTemp: false }
  m.problem = null
  m.copy.mockReset().mockResolvedValue(1)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('changeSpaceWorkingDir', () => {
  it('copies each folder’s sessions first, then moves the record, pins, sessions and file panel', async () => {
    const result = await changeSpaceWorkingDir('space-1', '/work/new/')

    expect(result).toEqual({ success: true, data: { id: 'space-1', workingDir: '/work/new' } })
    expect(calls).toEqual([
      'copy /work/old -> /work/new',
      'copy /work/older -> /work/new',
      'record /work/new',
      'pins space-1 /work/new',
      'sessions space-1',
      'watcher space-1 /work/new',
      'files space-1 /work/new',
    ])
  })

  it('changes nothing when the sessions cannot be copied', async () => {
    m.copy.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))

    const result = await changeSpaceWorkingDir('space-1', '/work/new')

    expect(result).toEqual({ success: false, error: 'ENOSPC: no space left on device' })
    expect(calls).toEqual(['copy /work/old -> /work/new'])
  })

  it('refuses an unusable folder and the default space before touching anything', async () => {
    m.problem = 'That folder does not exist.'
    expect(await changeSpaceWorkingDir('space-1', '/work/missing')).toEqual({ success: false, error: 'That folder does not exist.' })

    m.problem = null
    m.space = { id: 'halo-temp', isTemp: true }
    expect((await changeSpaceWorkingDir('halo-temp', '/work/new')).success).toBe(false)

    m.space = { id: 'space-1', isTemp: false }
    expect((await changeSpaceWorkingDir('space-1', 42)).success).toBe(false)
    expect(calls).toEqual([])
  })
})
