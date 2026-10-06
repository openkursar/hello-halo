/**
 * Re-checking a space's loaded file tree against the disk (after the watcher
 * process restarts or errs, or on the user's refresh): one run per space at a
 * time. A request that arrives while one runs waits for that run instead of
 * scanning everything a second time — a second run started later could finish
 * first and the older one would then put its stale listing back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { CachedTreeNode } from '../../../src/shared/types/artifact'

const { sent, scanTreeViaWorker } = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; data: Record<string, unknown> }>,
  scanTreeViaWorker: vi.fn(async (): Promise<CachedTreeNode[]> => []),
}))

vi.mock('../../../src/main/foundation/window.service', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: { send: (channel: string, data: Record<string, unknown>) => sent.push({ channel, data }) },
  }),
}))
vi.mock('../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../src/main/services/watcher-host.service', () => ({
  retainSpaceWatcher: vi.fn(),
  releaseSpaceWatcher: vi.fn(),
  scanTreeViaWorker: (...a: unknown[]) => scanTreeViaWorker(...(a as [])),
  refreshIgnoreRules: vi.fn(),
  addFsEventsHandler: () => () => {},
  addFsEventsLostHandler: () => () => {},
  shutdown: vi.fn(async () => {}),
}))

import {
  initSpaceCache,
  destroySpaceCache,
  listArtifactsTree,
  reconcileLoadedDirs,
} from '../../../src/main/services/artifact-cache.service'

const ROOT = '/tmp/space-root'
const SPACE = 'space-1'

function node(name: string): CachedTreeNode {
  return {
    id: name, name, type: 'file', path: `${ROOT}/${name}`, relativePath: name, extension: '', icon: '',
    depth: 0, childrenLoaded: false,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

let now = 0
const treeUpdates = () => sent.filter(s => s.channel === 'artifact:tree-update')

beforeEach(async () => {
  sent.length = 0
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  scanTreeViaWorker.mockResolvedValue([node('a')])
  await initSpaceCache(SPACE, ROOT)
  await listArtifactsTree(SPACE, ROOT)
  scanTreeViaWorker.mockClear()
})

afterEach(async () => {
  await destroySpaceCache(SPACE)
  vi.restoreAllMocks()
})

describe('reconcileLoadedDirs', () => {
  it('a request made while a run is in progress waits for that run instead of scanning again', async () => {
    const scan = deferred<CachedTreeNode[]>()
    scanTreeViaWorker.mockReturnValueOnce(scan.promise)

    const first = reconcileLoadedDirs(SPACE, 'worker-restart')
    // Past the 2-second cooldown, the scan still running.
    now += 2_500
    let secondDone = false
    const second = reconcileLoadedDirs(SPACE, 'artifact-api').then(() => { secondDone = true })
    await Promise.resolve()

    expect(scanTreeViaWorker).toHaveBeenCalledTimes(1)
    expect(secondDone).toBe(false)

    scan.resolve([node('a'), node('b')])
    await Promise.all([first, second])

    expect(scanTreeViaWorker).toHaveBeenCalledTimes(1)
    expect(treeUpdates()).toHaveLength(1)
    expect(await listArtifactsTree(SPACE, ROOT)).toEqual([node('a'), node('b')])
  })

  it('scans again once the run is over and the cooldown has passed', async () => {
    await reconcileLoadedDirs(SPACE, 'worker-restart')
    now += 2_500
    await reconcileLoadedDirs(SPACE, 'artifact-api')

    expect(scanTreeViaWorker).toHaveBeenCalledTimes(2)
  })

  it('keeps the cooldown: a request right after a finished run does not scan', async () => {
    await reconcileLoadedDirs(SPACE, 'worker-restart')
    now += 500
    await reconcileLoadedDirs(SPACE, 'watcher-error')

    expect(scanTreeViaWorker).toHaveBeenCalledTimes(1)
  })

  it('does not hand a space opened again the run of its previous, destroyed cache', async () => {
    const stale = deferred<CachedTreeNode[]>()
    scanTreeViaWorker.mockReturnValueOnce(stale.promise)
    const old = reconcileLoadedDirs(SPACE, 'worker-restart')

    await destroySpaceCache(SPACE)
    scanTreeViaWorker.mockResolvedValue([node('c')])
    await initSpaceCache(SPACE, ROOT)
    await listArtifactsTree(SPACE, ROOT)
    scanTreeViaWorker.mockClear()
    await reconcileLoadedDirs(SPACE, 'artifact-api')

    expect(scanTreeViaWorker).toHaveBeenCalledTimes(1)
    stale.resolve([])
    await old
  })
})
