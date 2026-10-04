/**
 * Memory bounds of the changes view: at most MAX_LIVE_EDITORS diff editors at
 * once (off-screen ones give theirs up first), and a content cache bounded by
 * text size that shares in-flight loads and forgets everything on refresh.
 */

import { describe, it, expect, vi } from 'vitest'
import { EditorSlots } from '../../../../../src/renderer/components/canvas/viewers/changes/diff/editor-slots'
import { ContentCache } from '../../../../../src/renderer/components/canvas/viewers/changes/state/content-cache'

describe('EditorSlots', () => {
  it('evicts the least recently used holder past the cap', () => {
    const slots = new EditorSlots(2)
    const evicted: string[] = []
    slots.acquire('a', () => evicted.push('a'))
    slots.acquire('b', () => evicted.push('b'))
    slots.acquire('c', () => evicted.push('c'))
    expect(evicted).toEqual(['a'])
    expect(slots.size).toBe(2)
    expect(slots.has('a')).toBe(false)
  })

  it('takes slots from off-screen holders before on-screen ones', () => {
    const slots = new EditorSlots(2)
    const evicted: string[] = []
    slots.acquire('a', () => evicted.push('a'), true)
    slots.acquire('b', () => evicted.push('b'))
    slots.acquire('c', () => evicted.push('c'), true)
    expect(evicted).toEqual(['b'])
  })

  it('falls back to the least recently seen on-screen holder when all are on screen', () => {
    const slots = new EditorSlots(2)
    const evicted: string[] = []
    slots.acquire('a', () => evicted.push('a'), true)
    slots.acquire('b', () => evicted.push('b'), true)
    slots.setVisible('a', true)
    slots.acquire('c', () => evicted.push('c'), true)
    expect(evicted).toEqual(['b'])
  })

  it('frees a slot on release and re-acquiring does not evict', () => {
    const slots = new EditorSlots(1)
    const onEvict = vi.fn()
    slots.acquire('a', onEvict)
    slots.acquire('a', onEvict)
    slots.release('a')
    slots.acquire('b', onEvict)
    expect(onEvict).not.toHaveBeenCalled()
    expect(slots.has('b')).toBe(true)
  })
})

describe('ContentCache', () => {
  const value = (size: number, id = size) => ({ size, id })

  it('keeps the most recently used values within the size budget', async () => {
    const cache = new ContentCache<{ size: number; id: number }>(10)
    await cache.get('a', async () => value(4, 1))
    await cache.get('b', async () => value(4, 2))
    cache.peek('a')
    await cache.get('c', async () => value(4, 3))
    expect(cache.peek('b')).toBeUndefined()
    expect(cache.peek('a')?.id).toBe(1)
    expect(cache.chars).toBe(8)
  })

  it('shares a load already in flight', async () => {
    const cache = new ContentCache<{ size: number }>(10)
    const load = vi.fn(async () => value(1))
    const [first, second] = await Promise.all([cache.get('a', load), cache.get('a', load)])
    expect(load).toHaveBeenCalledOnce()
    expect(first).toBe(second)
  })

  it('does not keep a value that finished loading after a clear', async () => {
    const cache = new ContentCache<{ size: number }>(10)
    let finish!: (v: { size: number }) => void
    const pending = cache.get('a', () => new Promise((resolve) => { finish = resolve }))
    cache.clear()
    finish(value(1))
    await expect(pending).resolves.toEqual(value(1))
    expect(cache.peek('a')).toBeUndefined()
  })

  it('never keeps a value larger than the whole budget, and forgets failed loads', async () => {
    const cache = new ContentCache<{ size: number }>(10)
    await cache.get('big', async () => value(11))
    expect(cache.count).toBe(0)
    await expect(cache.get('bad', async () => { throw new Error('nope') })).rejects.toThrow('nope')
    const retry = vi.fn(async () => value(1))
    await cache.get('bad', retry)
    expect(retry).toHaveBeenCalledOnce()
  })
})
