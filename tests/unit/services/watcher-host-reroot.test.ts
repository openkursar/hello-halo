/**
 * A space pointed at another folder is watched there for everyone holding its
 * watcher — the file panel and file triggers alike — by one message the worker
 * runs as stop-then-start; a space nobody watches is left alone.
 */

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'

const { children } = vi.hoisted(() => ({ children: [] as Array<EventEmitter & { send: ReturnType<typeof vi.fn> }> }))

vi.mock('child_process', () => ({
  fork: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { send: vi.fn(), kill: vi.fn() })
    children.push(child)
    return child
  }),
}))
vi.mock('../../../src/main/services/artifact-cache.service', () => ({ reconcileLoadedDirs: vi.fn(async () => {}) }))

import { retainSpaceWatcher, rerootSpaceWatcher, getWatchedSpaces } from '../../../src/main/services/watcher-host.service'

describe('rerootSpaceWatcher', () => {
  it('moves a watched space to the new folder, keeping every holder', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    retainSpaceWatcher('s1', '/old', 'artifact-cache')
    retainSpaceWatcher('s1', '/old', 'file-trigger:person')
    const worker = children[children.length - 1]

    rerootSpaceWatcher('s1', '/new')

    expect(worker.send).toHaveBeenLastCalledWith({ type: 'reroot-space', spaceId: 's1', rootPath: '/new' })
    expect(getWatchedSpaces().find(space => space.spaceId === 's1')).toEqual({
      spaceId: 's1', rootPath: '/new', holders: ['artifact-cache', 'file-trigger:person'],
    })

    worker.send.mockClear()
    rerootSpaceWatcher('s1', '/new')
    rerootSpaceWatcher('nobody-watches', '/elsewhere')
    expect(worker.send).not.toHaveBeenCalled()
  })
})
