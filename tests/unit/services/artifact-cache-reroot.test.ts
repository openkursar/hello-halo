/**
 * A space pointed at another folder: its file-tree cache keeps the clients
 * that hold it but forgets the old folder's tree, so the next listing reads
 * the new folder; a disk root is still never watched, and a scan of the old
 * folder still under way puts nothing back.
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
  reconcileLoadedDirs,
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

  it('keeps nothing of a listing of the old folder that finishes after the move', async () => {
    await retainSpaceCache(SPACE, '/old', 'window-1')
    let finishScan!: (nodes: unknown[]) => void
    scanTreeViaWorker.mockImplementationOnce(() => new Promise(resolve => { finishScan = resolve }))
    const oldListing = listArtifactsTree(SPACE, '/old')
    await vi.waitFor(() => expect(scanTreeViaWorker).toHaveBeenCalled())

    rerootSpaceCache(SPACE, '/new')
    finishScan([{ path: '/old/a.txt', name: 'a.txt', type: 'file', size: 1 }])
    await oldListing

    expect(getCacheStats(SPACE)).toMatchObject({ treeNodes: 0, loadedDirs: 0 })
  })

  it('refreshes the new folder after the move instead of joining a check of the old one, which then changes nothing', async () => {
    await retainSpaceCache(SPACE, '/old', 'window-1')
    await listArtifactsTree(SPACE, '/old')
    let finishOldCheck!: (nodes: unknown[]) => void
    scanTreeViaWorker.mockImplementationOnce(() => new Promise(resolve => { finishOldCheck = resolve }))
    const oldCheck = reconcileLoadedDirs(SPACE, 'worker-restart')
    await vi.waitFor(() => expect(scanTreeViaWorker).toHaveBeenLastCalledWith(SPACE, '/old', '/old', 1))

    rerootSpaceCache(SPACE, '/new')
    const newTree = [{ path: '/new/b.txt', name: 'b.txt', type: 'file', size: 1 }]
    scanTreeViaWorker.mockResolvedValueOnce(newTree)
    await listArtifactsTree(SPACE, '/new')
    scanTreeViaWorker.mockResolvedValueOnce(newTree)
    await reconcileLoadedDirs(SPACE, 'manual')
    expect(scanTreeViaWorker).toHaveBeenLastCalledWith(SPACE, '/new', '/new', 1)

    finishOldCheck([{ path: '/old/a.txt', name: 'a.txt', type: 'file', size: 1 }])
    await oldCheck
    expect(await listArtifactsTree(SPACE, '/new')).toEqual(newTree)
    expect(getCacheStats(SPACE)).toMatchObject({ treeNodes: 1, loadedDirs: 1 })
  })
})
