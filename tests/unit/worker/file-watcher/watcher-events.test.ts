/**
 * Watcher event pipeline: root mapping, bounded stat, chunked delivery and the
 * overflow fallback. `@parcel/watcher` is replaced by a stub whose callback the
 * tests drive directly, so batches are exact and timing-independent of the OS.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, promises as fsp } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ProcessedFsEvent } from '../../../../src/shared/protocol/file-watcher.protocol'

type ParcelCallback = (err: Error | null, events: Array<{ type: 'create' | 'update' | 'delete'; path: string }>) => Promise<void>

const subscriptions: Array<{ root: string; cb: ParcelCallback; ignore: string[] }> = []

vi.mock('@parcel/watcher', () => ({
  default: {
    subscribe: vi.fn(async (root: string, cb: ParcelCallback, opts: { ignore: string[] }) => {
      subscriptions.push({ root, cb, ignore: opts.ignore })
      return { unsubscribe: async () => {} }
    }),
  },
}))

type WatcherModule = typeof import('../../../../src/worker/file-watcher/watcher')

let watcher: WatcherModule
let delivered: Array<{ spaceId: string; events: ProcessedFsEvent[]; resolved: boolean }>
let overflows: Array<{ spaceId: string; overflowed: number; dropped: number }>
let errors: Array<{ spaceId: string; error: string }>
let tmp: string

async function waitForFlush(): Promise<void> {
  await new Promise(r => setTimeout(r, 400))
}

beforeEach(async () => {
  vi.resetModules()
  subscriptions.length = 0
  watcher = await import('../../../../src/worker/file-watcher/watcher')
  delivered = []
  overflows = []
  errors = []
  watcher.setOnEventsCallback((spaceId, events, resolved) => delivered.push({ spaceId, events, resolved }))
  watcher.setOnOverflowCallback((spaceId, overflowed, dropped) => overflows.push({ spaceId, overflowed, dropped }))
  watcher.setOnErrorCallback((spaceId, error) => errors.push({ spaceId, error }))
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'halo-watcher-')))
})

afterEach(async () => {
  await watcher.stopAll()
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

describe('mapToWatchedRoot', () => {
  it('passes through paths already under the space root', () => {
    expect(watcher.mapToWatchedRoot('/proj/a.ts', '/real/proj', '/proj')).toBe('/proj/a.ts')
  })

  it('maps canonical paths back under a symlinked root', () => {
    expect(watcher.mapToWatchedRoot('/private/tmp/p/src/a.ts', '/private/tmp/p', '/tmp/p')).toBe('/tmp/p/src/a.ts')
    expect(watcher.mapToWatchedRoot('/private/tmp/p', '/private/tmp/p', '/tmp/p')).toBe('/tmp/p')
  })

  it('rejects paths under neither root, including prefix look-alikes', () => {
    expect(watcher.mapToWatchedRoot('/private/tmp/p2/a.ts', '/private/tmp/p', '/tmp/p')).toBeNull()
    expect(watcher.mapToWatchedRoot('/elsewhere/a.ts', '/proj', '/proj')).toBeNull()
  })
})

describe('symlinked space root', () => {
  it('subscribes on the canonical root and reports events under the space root', async () => {
    const real = join(tmp, 'real-project')
    mkdirSync(real)
    writeFileSync(join(real, 'a.txt'), 'x')
    const link = join(tmp, 'linked-project')
    symlinkSync(real, link)

    await watcher.startWatcher('s1', link)
    expect(subscriptions[0].root).toBe(real)
    expect(subscriptions[0].ignore).toContain(join(real, 'node_modules'))

    // The OS reports the canonical path; before the fix this reached `ignore`
    // as "../real-project/a.txt" and threw, crashing the worker.
    await subscriptions[0].cb(null, [{ type: 'update', path: join(real, 'a.txt') }])
    await waitForFlush()

    expect(errors).toEqual([])
    expect(delivered).toHaveLength(1)
    const [event] = delivered[0].events
    expect(event.filePath).toBe(join(link, 'a.txt'))
    expect(event.relativePath).toBe('a.txt')
    expect(event.parentDir).toBe(link)
    expect(event.artifact?.path).toBe(join(link, 'a.txt'))
  })

  it('reports a failed batch as a watcher error instead of throwing out of the callback', async () => {
    await watcher.startWatcher('s1', tmp)
    const malformed = { type: 'create' as const, path: undefined as unknown as string }

    await expect(subscriptions[0].cb(null, [malformed])).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0].spaceId).toBe('s1')
  })
})

describe('event bursts', () => {
  it('stats with bounded concurrency and delivers in chunks', async () => {
    const count = 1200
    for (let i = 0; i < count; i++) writeFileSync(join(tmp, `f${i}.txt`), '')

    let running = 0
    let peak = 0
    const realStat = fsp.stat.bind(fsp)
    vi.spyOn(fsp, 'stat').mockImplementation(async (...args: Parameters<typeof fsp.stat>) => {
      running++
      peak = Math.max(peak, running)
      try {
        return await realStat(...args)
      } finally {
        running--
      }
    })

    await watcher.startWatcher('s1', tmp)
    await subscriptions[0].cb(null, Array.from({ length: count }, (_, i) => ({ type: 'create' as const, path: join(tmp, `f${i}.txt`) })))
    await waitForFlush()

    expect(peak).toBeLessThanOrEqual(watcher.MAX_CONCURRENT_STATS)
    expect(delivered.every(d => d.events.length <= watcher.MAX_EVENTS_PER_MESSAGE)).toBe(true)
    expect(delivered.reduce((n, d) => n + d.events.length, 0)).toBe(count)
    expect(delivered.length).toBe(Math.ceil(count / watcher.MAX_EVENTS_PER_MESSAGE))
  })

  it('delivers every path of a burst over the limit unresolved, without stat', async () => {
    await watcher.startWatcher('s1', tmp)
    const statSpy = vi.spyOn(fsp, 'stat')
    const n = watcher.MAX_PENDING_EVENTS_PER_SPACE + 1

    await subscriptions[0].cb(null, Array.from({ length: n }, (_, i) => ({ type: 'create' as const, path: join(tmp, `g${i}.txt`) })))
    await waitForFlush()

    expect(statSpy).not.toHaveBeenCalled()
    expect(overflows).toEqual([{ spaceId: 's1', overflowed: n, dropped: 0 }])
    expect(delivered.every(d => !d.resolved && d.events.length <= watcher.MAX_EVENTS_PER_MESSAGE)).toBe(true)
    const paths = new Set(delivered.flatMap(d => d.events.map(e => e.filePath)))
    expect(paths.size).toBe(n)
    expect(delivered[0].events[0]).toEqual({
      changeType: 'add', filePath: join(tmp, 'g0.txt'), relativePath: 'g0.txt', parentDir: tmp,
    })
  })

  it('moves events already pending into the overflow window when the limit is crossed across batches', async () => {
    await watcher.startWatcher('s1', tmp)
    const half = Math.ceil(watcher.MAX_PENDING_EVENTS_PER_SPACE / 2) + 1
    const batch = (offset: number) =>
      Array.from({ length: half }, (_, i) => ({ type: 'delete' as const, path: join(tmp, `d${offset + i}.txt`) }))

    await subscriptions[0].cb(null, batch(0))
    await subscriptions[0].cb(null, batch(half))
    await waitForFlush()

    expect(overflows).toHaveLength(1)
    expect(overflows[0].overflowed).toBe(half * 2)
    expect(delivered.every(d => !d.resolved)).toBe(true)
    expect(delivered.reduce((sum, d) => sum + d.events.length, 0)).toBe(half * 2)
  })

  it('reloads ignore rules when .gitignore changes', async () => {
    writeFileSync(join(tmp, 'keep.log'), '')
    await watcher.startWatcher('s1', tmp)

    await subscriptions[0].cb(null, [{ type: 'update', path: join(tmp, 'keep.log') }])
    await waitForFlush()
    expect(delivered.flatMap(d => d.events).map(e => e.relativePath)).toContain('keep.log')

    delivered.length = 0
    writeFileSync(join(tmp, '.gitignore'), '*.log\n')
    await subscriptions[0].cb(null, [
      { type: 'create', path: join(tmp, '.gitignore') },
      { type: 'update', path: join(tmp, 'keep.log') },
    ])
    await waitForFlush()
    expect(delivered.flatMap(d => d.events).map(e => e.relativePath)).toEqual(['.gitignore'])
  })

  it('does not subscribe twice when init races an in-flight start', async () => {
    await Promise.all([watcher.startWatcher('s1', tmp), watcher.startWatcher('s1', tmp)])
    expect(subscriptions).toHaveLength(1)
  })

  it('keeps the space path index current from events', async () => {
    writeFileSync(join(tmp, 'old.txt'), '')
    await watcher.startWatcher('s1', tmp)
    // Watching alone builds no index; the first query starts it.
    expect(watcher.hasPathIndex('s1')).toBe(false)
    expect(watcher.queryPaths('s1', 'old', 10)?.indexing).toBe(true)
    await new Promise(r => setTimeout(r, 50))
    expect(watcher.queryPaths('s1', 'old', 10)?.items.map(i => i.relativePath)).toEqual(['old.txt'])

    writeFileSync(join(tmp, 'new.txt'), '')
    await subscriptions[0].cb(null, [
      { type: 'create', path: join(tmp, 'new.txt') },
      { type: 'delete', path: join(tmp, 'old.txt') },
    ])

    expect(watcher.queryPaths('s1', '', 10)?.items.map(i => i.relativePath)).toEqual(['new.txt'])
    expect(watcher.queryPaths('unknown-space', '', 10)).toBeNull()
  })

  it('drops an index nobody queried for the idle period, and with the watcher', async () => {
    await watcher.startWatcher('s1', tmp)
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    try {
      watcher.queryPaths('s1', '', 10)
      expect(watcher.hasPathIndex('s1')).toBe(true)
      vi.advanceTimersByTime(watcher.PATH_INDEX_IDLE_MS + 60_000)
      expect(watcher.hasPathIndex('s1')).toBe(false)

      watcher.queryPaths('s1', '', 10)
      expect(watcher.hasPathIndex('s1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
    await watcher.stopWatcher('s1')
    expect(watcher.hasPathIndex('s1')).toBe(false)
  })
})
