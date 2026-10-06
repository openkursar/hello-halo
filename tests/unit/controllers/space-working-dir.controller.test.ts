/**
 * Changing a space's working directory, as IPC and HTTP both reach it: the
 * stored sessions of every folder the space used are copied before anything
 * points at the new one, then the record, the pinned environments, the folders
 * left behind, resident sessions and the file panel follow — and a failure
 * early on changes nothing. Nothing may run in the space meanwhile, and one
 * change of a space at a time.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
const m = vi.hoisted(() => ({
  problem: null as string | null,
  checked: [] as string[],
  busy: vi.fn((_spaceId: string) => false),
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
  getSpaceDir: () => '/work/old',
  workingDirChangeProblem: (_id: string, dir: string) => {
    m.checked.push(dir)
    return m.problem
  },
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
  isSpaceBusy: (id: string) => m.busy(id),
  retireWorkingDirs: (id: string, dirs: Iterable<string>, current: string) => calls.push(`retire ${id} ${[...dirs].join(', ')} for ${current}`),
  invalidateSessionsForSpace: (id: string, reason: string) => calls.push(`sessions ${id} (${reason})`),
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

const BUSY = 'A reply, run or background task is still going in this workspace. Change the folder once it has finished, or stop it first.'

beforeEach(() => {
  calls.length = 0
  m.problem = null
  m.checked = []
  m.busy.mockReset().mockReturnValue(false)
  m.copy.mockReset().mockResolvedValue(1)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('changeSpaceWorkingDir', () => {
  it('copies each folder’s sessions first, then moves the record, pins, the folders left, sessions and file panel', async () => {
    const result = await changeSpaceWorkingDir('space-1', '/work/new/')

    expect(result).toEqual({ success: true, data: { id: 'space-1', workingDir: '/work/new' } })
    expect(calls).toEqual([
      'copy /work/old -> /work/new',
      'copy /work/older -> /work/new',
      'record /work/new',
      'pins space-1 /work/new',
      'retire space-1 /work/old, /work/older for /work/new',
      'sessions space-1 (working directory change)',
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

  it('refuses an unusable folder before touching anything, judging the path as given', async () => {
    m.problem = 'Choose a folder by its full path.'
    expect(await changeSpaceWorkingDir('space-1', ' relative/folder ')).toEqual({ success: false, error: 'Choose a folder by its full path.' })
    // Not resolved against the app's own folder first.
    expect(m.checked).toEqual(['relative/folder'])

    m.problem = null
    expect((await changeSpaceWorkingDir('space-1', 42)).success).toBe(false)
    expect(calls).toEqual([])
  })

  it('refuses while anything runs in the space, before copying anything', async () => {
    m.busy.mockReturnValue(true)

    expect(await changeSpaceWorkingDir('space-1', '/work/new')).toEqual({ success: false, error: BUSY })
    expect(m.busy).toHaveBeenCalledWith('space-1')
    expect(calls).toEqual([])
  })

  it('refuses when a turn started while the sessions were being copied, leaving everything pointing where it did', async () => {
    m.busy.mockReturnValueOnce(false).mockReturnValueOnce(true)

    expect(await changeSpaceWorkingDir('space-1', '/work/new')).toEqual({ success: false, error: BUSY })
    expect(calls).toEqual(['copy /work/old -> /work/new', 'copy /work/older -> /work/new'])
  })

  it('takes one change of a space at a time, and the next once it is over', async () => {
    let finishCopy!: () => void
    m.copy.mockImplementationOnce(() => new Promise<number>(resolve => { finishCopy = () => resolve(1) }))

    const first = changeSpaceWorkingDir('space-1', '/work/new')
    expect(await changeSpaceWorkingDir('space-1', '/work/other')).toEqual({ success: false, error: 'This workspace’s folder is already being changed.' })
    finishCopy()
    expect((await first).success).toBe(true)

    m.copy.mockRejectedValueOnce(new Error('EACCES'))
    expect((await changeSpaceWorkingDir('space-1', '/work/other')).success).toBe(false)
    expect((await changeSpaceWorkingDir('space-1', '/work/other')).success).toBe(true)
  })
})
