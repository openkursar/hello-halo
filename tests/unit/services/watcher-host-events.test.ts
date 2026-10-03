/**
 * Routing of worker file events in the host.
 *
 * An overflowing burst is delivered unresolved (no stat) so automation file
 * triggers still see every path; handlers that derive per-node state opt out
 * of those events and resync from the lost-events signal instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { ProcessedFsEvent, WorkerToMainMessage } from '../../../src/shared/protocol/file-watcher.protocol'

const { children } = vi.hoisted(() => ({ children: [] as Array<EventEmitter & { send: ReturnType<typeof vi.fn> }> }))

vi.mock('child_process', () => ({
  fork: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { send: vi.fn(), kill: vi.fn() })
    children.push(child)
    return child
  }),
}))
vi.mock('../../../src/main/services/artifact-cache.service', () => ({ reconcileLoadedDirs: vi.fn(async () => {}) }))

import {
  addFsEventsHandler,
  addFsEventsLostHandler,
  retainSpaceWatcher,
  releaseSpaceWatcher,
  getWatchedSpaces,
} from '../../../src/main/services/watcher-host.service'

function emit(msg: WorkerToMainMessage): void {
  children[children.length - 1].emit('message', msg)
}

const event = (i: number): ProcessedFsEvent => ({
  changeType: 'add', filePath: `/root/f${i}`, relativePath: `f${i}`, parentDir: '/root',
})

beforeEach(() => {
  retainSpaceWatcher('s1', '/root', 'test')
})

describe('fs-events routing', () => {
  it('gives unresolved overflow events to trigger handlers but not to resolved-only handlers', () => {
    const trigger = vi.fn()
    const cache = vi.fn()
    const lost = vi.fn()
    const offs = [addFsEventsHandler(trigger), addFsEventsHandler(cache, { resolvedOnly: true }), addFsEventsLostHandler(lost)]

    const total = 20_001
    emit({ type: 'fs-overflow', spaceId: 's1', overflowedEvents: total, droppedEvents: 0 })
    for (let i = 0; i < total; i += 500) {
      emit({
        type: 'fs-events', spaceId: 's1', resolved: false,
        events: Array.from({ length: Math.min(500, total - i) }, (_, j) => event(i + j)),
      })
    }

    const seen = new Set(trigger.mock.calls.flatMap(([, events]) => (events as ProcessedFsEvent[]).map(e => e.filePath)))
    expect(seen.size).toBe(total)
    expect(cache).not.toHaveBeenCalled()
    expect(lost).toHaveBeenCalledWith('s1')

    emit({ type: 'fs-events', spaceId: 's1', events: [event(0)] })
    expect(cache).toHaveBeenCalledTimes(1)
    offs.forEach(off => off())
  })
})

describe('space watcher reference counting', () => {
  it('starts on the first holder and stops only when the last holder releases', () => {
    const child = children[children.length - 1]
    child.send.mockClear()

    retainSpaceWatcher('s2', '/root2', 'artifact-cache')
    retainSpaceWatcher('s2', '/root2', 'automation:app-1')
    retainSpaceWatcher('s2', '/root2', 'automation:app-1')
    expect(child.send.mock.calls.filter(([m]) => m.type === 'init-space')).toHaveLength(1)

    releaseSpaceWatcher('s2', 'artifact-cache')
    expect(child.send.mock.calls.some(([m]) => m.type === 'destroy-space')).toBe(false)
    expect(getWatchedSpaces().find(s => s.spaceId === 's2')?.holders).toEqual(['automation:app-1'])

    releaseSpaceWatcher('s2', 'automation:app-1')
    expect(child.send).toHaveBeenLastCalledWith({ type: 'destroy-space', spaceId: 's2' })
    expect(getWatchedSpaces().some(s => s.spaceId === 's2')).toBe(false)
  })
})
