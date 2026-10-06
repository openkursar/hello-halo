/**
 * A space pointed at another folder: its file-tree cache keeps the clients
 * that hold it but forgets the old folder's tree, so the next listing reads
 * the new folder; a disk root is still never watched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const scanTreeViaWorker = vi.fn(async (..._args: unknown[]) => [] as unknown[])
const retainSpaceWatcher = vi.fn()
const releaseSpaceWatcher = vi.fn()

vi.mock('../../../src/main/index', () => ({ getMainWindow: () => null }))
vi.mock('../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../src/main/services/watcher-host.service', () => ({
  retainSpaceWatcher: (...a: unknown[]) => retainSpaceWatcher(...a),
  releaseSpaceWatcher: (...a: unknown[]) => releaseSpaceWatcher(...a),
  scanTreeViaWorker: (...a: unknown[]) => scanTreeViaWorker(...a),
  refreshIgnoreRules: vi.fn(),
  addFsEventsHandler: vi.fn(),
  addFsEventsLostHandler: vi.fn(),
  shutdown: vi.fn(async () => {}),
}))

import {
  destroySpaceCache,
  getCacheStats,
  listArtifactsTree,
  rerootSpaceCache,
  retainSpaceCache,
} from '../../../src/main/services/artifact-cache.service'

const SPACE = 'space-1'

beforeEach(() => {
  scanTreeViaWorker.mockReset().mockResolvedValue([])
  retainSpaceWatcher.mockClear()
  releaseSpaceWatcher.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  await destroySpaceCache(SPACE)
  vi.restoreAllMocks()
})

describe('rerootSpaceCache', () => {
  it('drops the old folder’s tree and lists the new folder, keeping the client’s hold', async () => {
    scanTreeViaWorker.mockResolvedValueOnce([{ path: '/old/a.txt', name: 'a.txt', type: 'file', size: 1 }])
    await retainSpaceCache(SPACE, '/old', 'window-1')
    await listArtifactsTree(SPACE, '/old')
    expect(getCacheStats(SPACE)?.treeNodes).toBe(1)

    rerootSpaceCache(SPACE, '/new')

    expect(getCacheStats(SPACE)).toEqual({ treeNodes: 0, loadedDirs: 0, watcherActive: true })
    // The watcher host moves the shared watcher; the cache's own hold stays.
    expect(releaseSpaceWatcher).not.toHaveBeenCalled()
    scanTreeViaWorker.mockResolvedValueOnce([{ path: '/new/b.txt', name: 'b.txt', type: 'file', size: 1 }])
    expect(await listArtifactsTree(SPACE, '/new')).toEqual([{ path: '/new/b.txt', name: 'b.txt', type: 'file', size: 1 }])
    expect(scanTreeViaWorker).toHaveBeenLastCalledWith(SPACE, '/new', '/new', 0)
    // The window's hold survived: renewing it is not a re-creation.
    expect(await retainSpaceCache(SPACE, '/new', 'window-1')).toBe(false)
  })

  it('stops watching for a disk root and starts again when moved off it', async () => {
    await retainSpaceCache(SPACE, '/old', 'window-1')

    rerootSpaceCache(SPACE, '/')
    expect(releaseSpaceWatcher).toHaveBeenCalledWith(SPACE, 'artifact-cache')
    expect(getCacheStats(SPACE)?.watcherActive).toBe(false)

    rerootSpaceCache(SPACE, '/projects/app')
    expect(retainSpaceWatcher).toHaveBeenLastCalledWith(SPACE, '/projects/app', 'artifact-cache')
    expect(getCacheStats(SPACE)?.watcherActive).toBe(true)
  })

  it('does nothing for a space with no cache', () => {
    rerootSpaceCache('nobody-shows-it', '/new')
    expect(getCacheStats('nobody-shows-it')).toBeNull()
  })
})
