/**
 * Unit tests for artifact-cache.service.ts (in-memory cache behavior only).
 *
 * All filesystem I/O and IPC/WebSocket fan-out are delegated to other modules,
 * which are mocked here. What remains under test is the service's own in-memory
 * bookkeeping: per-space cache lifecycle, tree cache hit/miss (worker call
 * de-duplication), invalidation on refresh/destroy, and listener registration.
 *
 * The worker scan mocks are the observability point: a CACHE HIT must NOT call
 * the worker again, a MISS must call it exactly once and populate the cache.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const scanTreeViaWorker = vi.fn(async () => [] as unknown[])
const scanFlatViaWorker = vi.fn(async () => [] as unknown[])
const initSpaceWatcher = vi.fn()
const destroySpaceWatcher = vi.fn()

vi.mock('../../../src/main/index', () => ({ getMainWindow: () => null }))
vi.mock('../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../src/main/services/watcher-host.service', () => ({
  initSpaceWatcher: (...a: unknown[]) => initSpaceWatcher(...a),
  destroySpaceWatcher: (...a: unknown[]) => destroySpaceWatcher(...a),
  scanTreeViaWorker: (...a: unknown[]) => scanTreeViaWorker(...a),
  scanFlatViaWorker: (...a: unknown[]) => scanFlatViaWorker(...a),
  refreshIgnoreRules: vi.fn(),
  setFsEventsHandler: vi.fn(),
  shutdown: vi.fn(async () => {}),
}))

import {
  initSpaceCache,
  destroySpaceCache,
  listArtifactsTree,
  refreshCache,
  getCacheStats,
  onArtifactChange,
} from '../../../src/main/services/artifact-cache.service'

// A non-disk-root path so the watcher branch is exercised normally.
const ROOT = '/tmp/space-root'
const SPACE = 'space-1'

beforeEach(() => {
  scanTreeViaWorker.mockClear()
  scanFlatViaWorker.mockClear()
  initSpaceWatcher.mockClear()
  destroySpaceWatcher.mockClear()
  scanTreeViaWorker.mockResolvedValue([])
})

afterEach(async () => {
  await destroySpaceCache(SPACE)
})

describe('initSpaceCache / getCacheStats', () => {
  it('returns null stats for an unknown space', () => {
    expect(getCacheStats('nope')).toBeNull()
  })

  it('initializes an empty cache and requests a watcher for a normal root', async () => {
    await initSpaceCache(SPACE, ROOT)
    expect(getCacheStats(SPACE)).toEqual({
      flatItems: 0,
      treeNodes: 0,
      loadedDirs: 0,
      watcherActive: true,
    })
    expect(initSpaceWatcher).toHaveBeenCalledWith(SPACE, ROOT)
  })

  it('does not request a watcher for a disk-root path', async () => {
    await initSpaceCache(SPACE, '/')
    expect(getCacheStats(SPACE)?.watcherActive).toBe(false)
    expect(initSpaceWatcher).not.toHaveBeenCalled()
  })
})

describe('listArtifactsTree — cache hit/miss', () => {
  it('scans via worker on a miss, then serves the cached nodes on a hit', async () => {
    const nodes = [{ path: `${ROOT}/a.txt`, name: 'a.txt', type: 'file', size: 1 }]
    scanTreeViaWorker.mockResolvedValueOnce(nodes)

    await initSpaceCache(SPACE, ROOT)

    // MISS: worker is invoked, cache is populated.
    const first = await listArtifactsTree(SPACE, ROOT)
    expect(first).toEqual(nodes)
    expect(scanTreeViaWorker).toHaveBeenCalledTimes(1)
    expect(getCacheStats(SPACE)?.treeNodes).toBe(1)
    expect(getCacheStats(SPACE)?.loadedDirs).toBe(1)

    // HIT: same rootPath returns the cached array, no second worker call.
    const second = await listArtifactsTree(SPACE, ROOT)
    expect(second).toBe(first)
    expect(scanTreeViaWorker).toHaveBeenCalledTimes(1)
  })

  it('lazily initializes the cache when called before initSpaceCache', async () => {
    await listArtifactsTree(SPACE, ROOT)
    expect(getCacheStats(SPACE)).not.toBeNull()
    expect(scanTreeViaWorker).toHaveBeenCalledTimes(1)
  })
})

describe('invalidation', () => {
  it('refreshCache clears cached tree nodes, forcing a re-scan', async () => {
    scanTreeViaWorker.mockResolvedValueOnce([
      { path: `${ROOT}/a.txt`, name: 'a.txt', type: 'file', size: 1 },
    ])
    await initSpaceCache(SPACE, ROOT)
    await listArtifactsTree(SPACE, ROOT)
    expect(getCacheStats(SPACE)?.treeNodes).toBe(1)

    await refreshCache(SPACE, ROOT)
    expect(getCacheStats(SPACE)?.treeNodes).toBe(0)
    expect(getCacheStats(SPACE)?.loadedDirs).toBe(0)

    // Next read is a MISS again.
    await listArtifactsTree(SPACE, ROOT)
    expect(scanTreeViaWorker).toHaveBeenCalledTimes(2)
  })

  it('destroySpaceCache removes the cache and stops the watcher', async () => {
    await initSpaceCache(SPACE, ROOT)
    await destroySpaceCache(SPACE)
    expect(getCacheStats(SPACE)).toBeNull()
    expect(destroySpaceWatcher).toHaveBeenCalledWith(SPACE)
  })
})

describe('onArtifactChange', () => {
  it('returns an unsubscribe function that detaches the listener', () => {
    const listener = vi.fn()
    const off = onArtifactChange(listener)
    expect(typeof off).toBe('function')
    // Detaching twice is safe (idempotent).
    off()
    off()
    expect(listener).not.toHaveBeenCalled()
  })
})
