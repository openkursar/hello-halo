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
  retainSpaceCache,
  releaseSpaceCache,
  MAX_CACHED_SPACES,
  SPACE_HOLD_LEASE_MS,
  sweepExpiredSpaceHolds,
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
  retainSpaceWatcher.mockClear()
  releaseSpaceWatcher.mockClear()
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
      treeNodes: 0,
      loadedDirs: 0,
      watcherActive: true,
    })
    expect(retainSpaceWatcher).toHaveBeenCalledWith(SPACE, ROOT, 'artifact-cache')
  })

  it('does not request a watcher for a disk-root path', async () => {
    await initSpaceCache(SPACE, '/')
    expect(getCacheStats(SPACE)?.watcherActive).toBe(false)
    expect(retainSpaceWatcher).not.toHaveBeenCalled()
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
    expect(releaseSpaceWatcher).toHaveBeenCalledWith(SPACE, 'artifact-cache')
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

describe('space lifecycle', () => {
  it('keeps a space while any client shows it and frees it with the last release', async () => {
    await retainSpaceCache(SPACE, ROOT, 'client-a')
    await retainSpaceCache(SPACE, ROOT, 'client-b')
    await releaseSpaceCache(SPACE, 'client-a')
    expect(getCacheStats(SPACE)).not.toBeNull()

    await releaseSpaceCache(SPACE, 'client-b')
    expect(getCacheStats(SPACE)).toBeNull()
    expect(releaseSpaceWatcher).toHaveBeenCalledWith(SPACE, 'artifact-cache')
  })

  it('bounds cached spaces, evicting unheld ones before held ones', async () => {
    await retainSpaceCache('held', ROOT, 'client-a')
    await listArtifactsTree('idle-old', ROOT)
    for (let i = 0; i < MAX_CACHED_SPACES; i++) await listArtifactsTree(`idle-${i}`, ROOT)

    expect(getCacheStats('held')).not.toBeNull()
    expect(getCacheStats('idle-old')).toBeNull()
    for (const id of ['held', 'idle-old', ...Array.from({ length: MAX_CACHED_SPACES }, (_, i) => `idle-${i}`)]) {
      await destroySpaceCache(id)
    }
  })

  it('drops a hold that is not renewed within the lease, and keeps a renewed one', async () => {
    await retainSpaceCache('leased', ROOT, 'gone-client')
    await retainSpaceCache('leased', ROOT, 'live-client')
    const later = Date.now() + SPACE_HOLD_LEASE_MS + 1000
    // The live client renews just before the sweep.
    vi.spyOn(Date, 'now').mockReturnValue(later - 1000)
    await retainSpaceCache('leased', ROOT, 'live-client')
    vi.restoreAllMocks()

    expect(await sweepExpiredSpaceHolds(later)).toBe(1)
    expect(getCacheStats('leased')).not.toBeNull()

    // Nobody renews: the cache and its watcher go.
    expect(await sweepExpiredSpaceHolds(later + SPACE_HOLD_LEASE_MS)).toBe(1)
    expect(getCacheStats('leased')).toBeNull()
  })

  it('reports a renewal as recreated once the hold lapsed and the cache was dropped', async () => {
    expect(await retainSpaceCache('lapsed', ROOT, 'c1')).toBe(true)
    expect(await retainSpaceCache('lapsed', ROOT, 'c1')).toBe(false)

    await sweepExpiredSpaceHolds(Date.now() + SPACE_HOLD_LEASE_MS + 1000)
    expect(getCacheStats('lapsed')).toBeNull()

    expect(await retainSpaceCache('lapsed', ROOT, 'c1')).toBe(true)
    await releaseSpaceCache('lapsed', 'c1')
  })

  it('never evicts a space a client still shows, however many are held', async () => {
    const held = Array.from({ length: MAX_CACHED_SPACES + 2 }, (_, i) => `held-${i}`)
    for (const id of held) await retainSpaceCache(id, ROOT, `client-${id}`)
    await listArtifactsTree('idle', ROOT)

    for (const id of held) expect(getCacheStats(id), id).not.toBeNull()
    for (const id of held) await releaseSpaceCache(id, `client-${id}`)
    for (const id of held) expect(getCacheStats(id)).toBeNull()
    await destroySpaceCache('idle')
  })
})
