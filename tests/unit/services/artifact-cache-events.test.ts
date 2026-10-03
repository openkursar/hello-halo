/**
 * How worker file events reach clients.
 *
 * A burst used to cost one IPC send + one WebSocket frame per changed file
 * (5000 on a checkout), each consumer running its callback 5000 times. Changes
 * now leave as one `artifact:changed-batch` per flush per space (split at a
 * fixed size), with a resync signal instead of changes once a burst is too
 * large or events were lost.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ProcessedFsEvent } from '../../../src/shared/protocol/file-watcher.protocol'
import type { CachedTreeNode, ArtifactChangeBatchEvent } from '../../../src/shared/types/artifact'

const { sent, handlers, scanTreeViaWorker } = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; data: Record<string, unknown> }>,
  handlers: {} as { events?: (spaceId: string, events: ProcessedFsEvent[]) => void; lost?: (spaceId: string) => void },
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
  addFsEventsHandler: (cb: typeof handlers.events) => { handlers.events = cb; return () => {} },
  addFsEventsLostHandler: (cb: typeof handlers.lost) => { handlers.lost = cb; return () => {} },
  shutdown: vi.fn(async () => {}),
}))

import {
  initSpaceCache,
  destroySpaceCache,
  listArtifactsTree,
  flushPendingBroadcasts,
  MAX_CHANGES_PER_BATCH,
  MAX_PENDING_CHANGES_PER_SPACE,
} from '../../../src/main/services/artifact-cache.service'

const ROOT = '/tmp/space-root'
const SPACE = 'space-1'

function node(name: string, type: 'file' | 'folder' = 'file'): CachedTreeNode {
  return {
    id: name, name, type, path: `${ROOT}/${name}`, relativePath: name, extension: '', icon: '',
    depth: 0, childrenLoaded: false, children: type === 'folder' ? [] : undefined,
  }
}

function addEvent(name: string): ProcessedFsEvent {
  const treeNode = node(name)
  return {
    changeType: 'add', filePath: treeNode.path, relativePath: name, parentDir: ROOT, treeNode,
    artifact: {
      id: name, spaceId: SPACE, name, type: 'file', path: treeNode.path, relativePath: name,
      extension: '', icon: '', createdAt: '', modifiedAt: '',
    },
  }
}

function deleteEvent(name: string): ProcessedFsEvent {
  return { changeType: 'unlink', filePath: `${ROOT}/${name}`, relativePath: name, parentDir: ROOT }
}

const batches = () => sent.filter(s => s.channel === 'artifact:changed-batch').map(s => s.data as unknown as ArtifactChangeBatchEvent)
const treeUpdates = () => sent.filter(s => s.channel === 'artifact:tree-update')

beforeEach(async () => {
  sent.length = 0
  scanTreeViaWorker.mockResolvedValue([node('b'), node('d')])
  await initSpaceCache(SPACE, ROOT)
  await listArtifactsTree(SPACE, ROOT)
})

afterEach(async () => {
  flushPendingBroadcasts()
  await destroySpaceCache(SPACE)
  vi.useRealTimers()
})

describe('applying worker events', () => {
  it('keeps a loaded directory sorted and de-duplicated across a burst', async () => {
    handlers.events!(SPACE, [addEvent('c'), addEvent('a'), addEvent('b'), deleteEvent('d')])
    const children = await listArtifactsTree(SPACE, ROOT)
    expect(children.map(n => n.name)).toEqual(['a', 'b', 'c'])
  })

  it('never sends a per-file change event', () => {
    handlers.events!(SPACE, Array.from({ length: 50 }, (_, i) => addEvent(`f${i}`)))
    flushPendingBroadcasts()
    expect(sent.some(s => s.channel === 'artifact:changed')).toBe(false)
  })
})

describe('broadcasting', () => {
  it('sends a burst as one tree update and one change batch', () => {
    handlers.events!(SPACE, Array.from({ length: 200 }, (_, i) => addEvent(`f${i}`)))
    handlers.events!(SPACE, Array.from({ length: 200 }, (_, i) => addEvent(`g${i}`)))
    flushPendingBroadcasts()

    expect(treeUpdates()).toHaveLength(1)
    expect(batches()).toHaveLength(1)
    const [batch] = batches()
    expect(batch.spaceId).toBe(SPACE)
    expect(batch.changes).toHaveLength(400)
    expect(batch.changes[0]).toEqual({ type: 'add', path: `${ROOT}/f0`, relativePath: 'f0' })
    expect(treeUpdates()[0].data).not.toHaveProperty('changes')
  })

  it('splits a large flush into bounded batches', () => {
    const n = MAX_CHANGES_PER_BATCH * 2 + 1
    handlers.events!(SPACE, Array.from({ length: n }, (_, i) => addEvent(`f${i}`)))
    flushPendingBroadcasts()

    expect(batches()).toHaveLength(3)
    expect(batches().every(b => b.changes.length <= MAX_CHANGES_PER_BATCH)).toBe(true)
    expect(batches().reduce((sum, b) => sum + b.changes.length, 0)).toBe(n)
  })

  it('replaces changes with a resync once the pending set exceeds its limit', () => {
    for (let i = 0; i <= MAX_PENDING_CHANGES_PER_SPACE; i += 5000) {
      handlers.events!(SPACE, Array.from({ length: 5000 }, (_, j) => deleteEvent(`x${i + j}`)))
    }
    flushPendingBroadcasts()

    expect(batches()).toEqual([{ spaceId: SPACE, changes: [], resync: true }])
  })

  it('sends a resync when the worker reports lost events', () => {
    handlers.events!(SPACE, [addEvent('a')])
    handlers.lost!(SPACE)
    flushPendingBroadcasts()

    expect(batches()).toEqual([{ spaceId: SPACE, changes: [], resync: true }])
  })

  it('flushes within the max wait even while events keep arriving', async () => {
    vi.useFakeTimers()
    for (let t = 0; t < 3000; t += 200) {
      handlers.events!(SPACE, [addEvent(`t${t}`)])
      await vi.advanceTimersByTimeAsync(200)
      if (batches().length > 0) break
    }
    expect(batches().length).toBeGreaterThan(0)
  })
})

describe('deleting a directory', () => {
  it('reports a deleted directory known to the tree as unlinkDir', async () => {
    scanTreeViaWorker.mockResolvedValue([node('dir', 'folder'), node('b')])
    await destroySpaceCache(SPACE)
    await initSpaceCache(SPACE, ROOT)
    await listArtifactsTree(SPACE, ROOT)

    handlers.events!(SPACE, [deleteEvent('dir')])
    flushPendingBroadcasts()

    expect(batches()[0].changes).toEqual([{ type: 'unlinkDir', path: `${ROOT}/dir`, relativePath: 'dir' }])
    expect((await listArtifactsTree(SPACE, ROOT)).map(n => n.name)).toEqual(['b'])
  })
})
