/**
 * Guards the bound on the renderer's artifact version map.
 *
 * The map is fed by a change event that fires for every file in the space, so
 * counting every event grows it with how fast the space is written rather than
 * with anything the user did — the shape of unbounded growth this module was
 * added to remove. The bound is that only a path a viewer asked about is ever
 * tracked, and its observable form is that an unasked path stays at zero
 * however many times it is rewritten.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { onArtifactChangedBatch } = vi.hoisted(() => ({ onArtifactChangedBatch: vi.fn() }))
vi.mock('../../../src/renderer/api', () => ({ api: { onArtifactChangedBatch } }))

type Batch = { spaceId: string; changes: Array<{ type: string; path: string; relativePath: string }>; resync?: boolean }

type Mod = typeof import('../../../src/renderer/services/artifact-version')

let subscribeArtifactVersions: Mod['subscribeArtifactVersions']
let getArtifactVersion: Mod['getArtifactVersion']
let emit: (path: string, type?: 'add' | 'change' | 'unlink') => void
let emitBatch: (batch: Batch) => void

beforeEach(async () => {
  vi.resetModules()
  onArtifactChangedBatch.mockReset()

  let handler: ((data: Batch) => void) | null = null
  onArtifactChangedBatch.mockImplementation((cb: (data: Batch) => void) => {
    handler = cb
    return () => {}
  })

  const mod: Mod = await import('../../../src/renderer/services/artifact-version')
  subscribeArtifactVersions = mod.subscribeArtifactVersions
  getArtifactVersion = mod.getArtifactVersion
  emitBatch = (batch) => handler?.(batch)
  emit = (path, type = 'change') => emitBatch({ spaceId: 's', changes: [{ type, path, relativePath: path }] })
})

describe('artifact versions / what gets tracked', () => {
  it('keeps a path nobody asked about at zero however often it is rewritten', () => {
    subscribeArtifactVersions(() => {})
    for (let i = 0; i < 500; i++) emit(`/space/generated-${i}.txt`)

    // Nothing was recorded for these: the first read of any of them is the
    // first version they have ever had.
    expect(getArtifactVersion('/space/generated-0.txt')).toBe(0)
    expect(getArtifactVersion('/space/generated-499.txt')).toBe(0)
  })

  it('counts every rewrite of a path that was asked about', () => {
    subscribeArtifactVersions(() => {})
    expect(getArtifactVersion('/space/report.png')).toBe(0)

    emit('/space/report.png')
    expect(getArtifactVersion('/space/report.png')).toBe(1)

    emit('/space/report.png', 'add')
    expect(getArtifactVersion('/space/report.png')).toBe(2)
  })

  it('leaves a tracked path alone when other files change', () => {
    subscribeArtifactVersions(() => {})
    getArtifactVersion('/space/report.png')

    emit('/space/notes.md')
    emit('/space/data.csv')

    expect(getArtifactVersion('/space/report.png')).toBe(0)
  })

  it('ignores deletions, which leave no new bytes to serve', () => {
    subscribeArtifactVersions(() => {})
    getArtifactVersion('/space/report.png')

    emit('/space/report.png', 'unlink')

    expect(getArtifactVersion('/space/report.png')).toBe(0)
  })
})

describe('artifact versions / subscribers', () => {
  it('keeps counting a tracked path after the last viewer unmounts', () => {
    const unsubscribe = subscribeArtifactVersions(() => {})
    getArtifactVersion('/space/report.png')
    unsubscribe()

    emit('/space/report.png')

    expect(getArtifactVersion('/space/report.png')).toBe(1)
  })

  it('wakes subscribers only for files a viewer is tracking', () => {
    const listener = vi.fn()
    subscribeArtifactVersions(listener)
    getArtifactVersion('/space/report.png')

    emit('/space/unrelated.txt')
    expect(listener).not.toHaveBeenCalled()

    emit('/space/report.png')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('watches the change stream once however many viewers mount', () => {
    subscribeArtifactVersions(() => {})
    subscribeArtifactVersions(() => {})
    subscribeArtifactVersions(() => {})

    expect(onArtifactChangedBatch).toHaveBeenCalledTimes(1)
  })

  it('wakes subscribers once for a batch however many tracked files it touches', () => {
    const listener = vi.fn()
    subscribeArtifactVersions(listener)
    getArtifactVersion('/space/a.png')
    getArtifactVersion('/space/b.png')

    emitBatch({
      spaceId: 's',
      changes: [
        { type: 'change', path: '/space/a.png', relativePath: 'a.png' },
        { type: 'change', path: '/space/b.png', relativePath: 'b.png' },
      ],
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getArtifactVersion('/space/a.png')).toBe(1)
    expect(getArtifactVersion('/space/b.png')).toBe(1)
  })
})

describe('artifact versions / lost changes', () => {
  it('treats every tracked path as rewritten when a batch reports lost changes', () => {
    const listener = vi.fn()
    subscribeArtifactVersions(listener)
    getArtifactVersion('/space/a.png')
    getArtifactVersion('/space/b.png')

    emitBatch({ spaceId: 's', changes: [], resync: true })

    expect(getArtifactVersion('/space/a.png')).toBe(1)
    expect(getArtifactVersion('/space/b.png')).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
