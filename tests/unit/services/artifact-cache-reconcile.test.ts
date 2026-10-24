/**
 * Re-checking a space's loaded file tree against the disk (after the watcher
 * process restarts or errs, or on the user's refresh): one run per space at a
 * time. A request that arrives while one runs waits for that run instead of
 * scanning everything a second time — a second run started later could finish
 * first and the older one would then put its stale listing back.
 *
 * A folder that cannot be read during a check is not a deleted or emptied
 * folder: only one that is not there any more is dropped (#458).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { CachedTreeNode } from '../../../src/shared/types/artifact'

const { sent, scanTreeViaWorker } = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; data: Record<string, unknown> }>,
  scanTreeViaWorker: vi.fn(async (..._args: unknown[]): Promise<CachedTreeNode[]> => []),
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
  scanTreeViaWorker: (...a: unknown[]) => scanTreeViaWorker(...a),
  refreshIgnoreRules: vi.fn(),
  addFsEventsHandler: () => () => {},
  addFsEventsLostHandler: () => () => {},
  shutdown: vi.fn(async () => {}),
}))

import {
  initSpaceCache,
  destroySpaceCache,
  listArtifactsTree,
  loadDirectoryChildren,
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

describe('reconcileLoadedDirs — a folder that cannot be read is not a deleted one', () => {
  const SUB = `${ROOT}/sub`
  const DEEP = `${SUB}/deep`

  function entry(relPath: string, type: 'file' | 'folder' = 'file'): CachedTreeNode {
    return {
      id: relPath, name: relPath.split('/').pop()!, type, path: `${ROOT}/${relPath}`, relativePath: relPath,
      extension: '', icon: '', depth: relPath.split('/').length - 1, childrenLoaded: false,
      ...(type === 'folder' ? { children: [] } : {}),
    }
  }

  /** What each folder's scan gives in the next run: its listing, or the error it rejects with. */
  function scans(results: Record<string, CachedTreeNode[] | Error>): void {
    scanTreeViaWorker.mockImplementation(async (...args: unknown[]) => {
      const result = results[args[1] as string]
      if (result instanceof Error) throw result
      return result ?? []
    })
  }
  const fsError = (code: string, dir: string) => Object.assign(new Error(`${code}: scandir '${dir}'`), { code })
  const timeout = (dir: string) => new Error(`Worker request timeout: ${dir}`)
  const updates = () => treeUpdates().map(u => u.data.updatedDirs)
  const rootListing = [entry('sub', 'folder'), entry('a')]
  const subListing = [entry('sub/deep', 'folder'), entry('sub/x')]

  beforeEach(async () => {
    await destroySpaceCache(SPACE)
    await initSpaceCache(SPACE, ROOT)
    scans({ [ROOT]: rootListing, [SUB]: subListing, [DEEP]: [entry('sub/deep/y')] })
    await listArtifactsTree(SPACE, ROOT)
    await loadDirectoryChildren(SPACE, SUB, ROOT)
    await loadDirectoryChildren(SPACE, DEEP, ROOT)
    scanTreeViaWorker.mockClear()
    sent.length = 0
  })

  it('keeps the cached tree and sends nothing when the rescans time out, and checks it again next time', async () => {
    scans({ [ROOT]: timeout(ROOT), [SUB]: timeout(SUB), [DEEP]: timeout(DEEP) })
    await reconcileLoadedDirs(SPACE, 'artifact-api')

    expect(updates()).toEqual([])
    expect(await listArtifactsTree(SPACE, ROOT)).toEqual(rootListing)
    expect(await loadDirectoryChildren(SPACE, SUB, ROOT)).toEqual(subListing)
    expect(scanTreeViaWorker).toHaveBeenCalledTimes(3)

    now += 2_500
    scans({ [ROOT]: [...rootListing, entry('b')], [SUB]: subListing, [DEEP]: [entry('sub/deep/y')] })
    await reconcileLoadedDirs(SPACE, 'artifact-api')
    expect(scanTreeViaWorker).toHaveBeenCalledTimes(6)
    expect(updates()).toEqual([[{ dirPath: ROOT, children: [...rootListing, entry('b')] }]])
  })

  it.each(['EACCES', 'EBUSY'])('keeps every listing when the folders cannot be read (%s)', async (code) => {
    scans({ [ROOT]: fsError(code, ROOT), [SUB]: fsError(code, SUB), [DEEP]: fsError(code, DEEP) })
    await reconcileLoadedDirs(SPACE, 'artifact-api')

    expect(updates()).toEqual([])
    expect(await listArtifactsTree(SPACE, ROOT)).toEqual(rootListing)
    expect(await loadDirectoryChildren(SPACE, SUB, ROOT)).toEqual(subListing)
    expect(scanTreeViaWorker).toHaveBeenCalledTimes(3)
  })

  it('keeps an unreadable folder in its parent while the parent reads fine', async () => {
    scans({ [ROOT]: rootListing, [SUB]: fsError('EBUSY', SUB), [DEEP]: [entry('sub/deep/y')] })
    await reconcileLoadedDirs(SPACE, 'artifact-api')

    expect(updates()).toEqual([])
    expect(await loadDirectoryChildren(SPACE, SUB, ROOT)).toEqual(subListing)
    expect(scanTreeViaWorker).toHaveBeenCalledTimes(3)
  })

  it.each(['ENOENT', 'ENOTDIR'])('drops a folder that is gone (%s) with its loaded descendants and sends its parent once without it', async (code) => {
    scans({ [ROOT]: timeout(ROOT), [SUB]: fsError(code, SUB), [DEEP]: fsError(code, DEEP) })
    await reconcileLoadedDirs(SPACE, 'artifact-api')

    expect(updates()).toEqual([[{ dirPath: ROOT, children: [entry('a')] }]])

    now += 2_500
    scanTreeViaWorker.mockClear()
    scans({ [ROOT]: [entry('a')] })
    await reconcileLoadedDirs(SPACE, 'artifact-api')
    expect(scanTreeViaWorker.mock.calls.map(call => call[1])).toEqual([ROOT])
  })

  it('lists the space folder as empty while it is gone and fills it again when it is back', async () => {
    scans({ [ROOT]: fsError('ENOENT', ROOT), [SUB]: fsError('ENOENT', SUB), [DEEP]: fsError('ENOENT', DEEP) })
    await reconcileLoadedDirs(SPACE, 'artifact-api')
    expect(updates()).toEqual([[{ dirPath: ROOT, children: [] }]])

    now += 2_500
    scans({ [ROOT]: [entry('a')] })
    await reconcileLoadedDirs(SPACE, 'artifact-api')
    expect(updates()[1]).toEqual([{ dirPath: ROOT, children: [entry('a')] }])
  })

  it('clears a folder that really became empty', async () => {
    scans({ [ROOT]: rootListing, [SUB]: [], [DEEP]: fsError('ENOENT', DEEP) })
    await reconcileLoadedDirs(SPACE, 'artifact-api')

    expect(updates()).toEqual([[{ dirPath: SUB, children: [] }]])
    expect(await loadDirectoryChildren(SPACE, SUB, ROOT)).toEqual([])
  })

  it('clears the root when everything in the space folder was deleted', async () => {
    scans({ [ROOT]: [], [SUB]: fsError('ENOENT', SUB), [DEEP]: fsError('ENOENT', DEEP) })
    await reconcileLoadedDirs(SPACE, 'artifact-api')

    expect(updates()).toEqual([[{ dirPath: ROOT, children: [] }]])
  })

  it.each([
    ['the root listing', () => listArtifactsTree(SPACE, ROOT)],
    ['a re-listing of the root', () => loadDirectoryChildren(SPACE, ROOT, ROOT)],
  ])('reads %s that failed again at the next check and sends it, so refresh is not a no-op', async (_, list) => {
    await destroySpaceCache(SPACE)
    await initSpaceCache(SPACE, ROOT)
    scans({ [ROOT]: timeout(ROOT) })
    await expect(list()).rejects.toThrow('timeout')

    scans({ [ROOT]: [entry('a')] })
    await reconcileLoadedDirs(SPACE, 'artifact-api')

    expect(updates()).toEqual([[{ dirPath: ROOT, children: [entry('a')] }]])
    scanTreeViaWorker.mockClear()
    expect(await listArtifactsTree(SPACE, ROOT)).toEqual([entry('a')])
    expect(scanTreeViaWorker).not.toHaveBeenCalled()
  })

  it('reports the folders it could not read in one warning per check', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    scans({ [ROOT]: timeout(ROOT), [SUB]: fsError('EACCES', SUB), [DEEP]: fsError('EACCES', DEEP) })
    await reconcileLoadedDirs(SPACE, 'window-focus')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/3\/3 .*window-focus/)
  })
})
