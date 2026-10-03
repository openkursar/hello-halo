import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createStampedLru } from '../../../../src/main/platform/file-cache'

describe('createStampedLru', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halo-lru-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const file = (name: string, content = 'x') => {
    const path = join(dir, name)
    writeFileSync(path, content)
    return path
  }

  it('derives once while the file is unchanged', () => {
    const cache = createStampedLru<string>({ maxEntries: 4, maxWeight: 1e6 })
    const path = file('a')
    let derived = 0
    const derive = () => `v${++derived}`
    expect(cache.get(path, derive)).toBe('v1')
    expect(cache.get(path, derive)).toBe('v1')
    expect(derived).toBe(1)
  })

  it('re-derives after the file grows', () => {
    const cache = createStampedLru<string>({ maxEntries: 4, maxWeight: 1e6 })
    const path = file('a')
    let derived = 0
    const derive = () => `v${++derived}`
    cache.get(path, derive)
    appendFileSync(path, 'more')
    expect(cache.get(path, derive)).toBe('v2')
  })

  it('answers null and forgets the entry when the file is gone or cannot be derived', () => {
    const cache = createStampedLru<string>({ maxEntries: 4, maxWeight: 1e6 })
    const path = file('a')
    cache.get(path, () => 'v')
    rmSync(path)
    expect(cache.get(path, () => 'never')).toBeNull()
    expect(cache.size).toBe(0)

    const other = file('b')
    expect(cache.get(other, () => null)).toBeNull()
    expect(cache.size).toBe(0)
  })

  it('evicts the least recently used entry beyond maxEntries', () => {
    const cache = createStampedLru<string>({ maxEntries: 2, maxWeight: 1e6 })
    const [a, b, c] = ['a', 'b', 'c'].map(n => file(n))
    cache.get(a, () => 'A1')
    cache.get(b, () => 'B1')
    cache.get(a, () => 'A2') // touch a; b is now the oldest
    cache.get(c, () => 'C1')
    expect(cache.size).toBe(2)
    expect(cache.get(a, () => 'A3')).toBe('A1')
    expect(cache.get(b, () => 'B2')).toBe('B2')
  })

  it('evicts by total weight, least recently used first', () => {
    const cache = createStampedLru<string>({ maxEntries: 10, maxWeight: 10 })
    const a = file('a', '123456')
    const b = file('b', '123456')
    cache.get(a, () => 'A')
    cache.get(b, () => 'B')
    expect(cache.size).toBe(1)
    expect(cache.get(b, () => 'B2')).toBe('B')
  })

  it('never retains a single entry heavier than the whole budget', () => {
    const cache = createStampedLru<string>({ maxEntries: 10, maxWeight: 10 })
    const small = file('small', '12')
    cache.get(small, () => 'S')
    const huge = file('huge', '1'.repeat(50))
    expect(cache.get(huge, () => 'H')).toBe('H')
    expect(cache.get(huge, () => 'H2')).toBe('H2')
    // The oversize read did not evict what fits.
    expect(cache.get(small, () => 'S2')).toBe('S')
  })

  it('hands the previous value to derive after the file changes', () => {
    const cache = createStampedLru<string>({ maxEntries: 10, maxWeight: 1e6 })
    const path = file('grow', 'a')
    cache.get(path, () => 'v1')
    writeFileSync(path, 'ab')
    let seen: string | undefined
    cache.get(path, (previous) => {
      seen = previous
      return 'v2'
    })
    expect(seen).toBe('v1')
  })

  it('clear empties the cache', () => {
    const cache = createStampedLru<string>({ maxEntries: 4, maxWeight: 1e6 })
    cache.get(file('a'), () => 'A')
    cache.clear()
    expect(cache.size).toBe(0)
  })
})
