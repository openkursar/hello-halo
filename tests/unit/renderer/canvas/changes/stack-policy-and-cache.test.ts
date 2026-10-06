/** Rendering policy, the read-size budget and content-cache bounds for the changes view. */

import { describe, it, expect, vi } from 'vitest'
import { MAX_STACK_CHARS, MAX_STACK_FILES, MAX_STACK_LINES, MAX_STACK_PARTS, ReadBudget, diffChars, showOneFile } from '../../../../../src/renderer/components/canvas/viewers/changes/diff/stack-policy'
import type { ViewFile } from '../../../../../src/renderer/components/canvas/viewers/changes/model/view-files'
import { ContentCache } from '../../../../../src/renderer/components/canvas/viewers/changes/state/content-cache'

const file = (overrides: Partial<ViewFile> = {}): ViewFile => ({
  key: 'a.ts', path: 'a.ts', absPath: '/repo/a.ts', state: 'modified', additions: 1, deletions: 1, binary: false, generated: false, ...overrides,
})

describe('diff presentation', () => {
  it('keeps small diffs mounted, including an empty list', () => {
    expect(showOneFile([])).toBe(false)
    expect(showOneFile([file()])).toBe(false)
    expect(showOneFile(Array.from({ length: MAX_STACK_FILES }, (_, i) => file({ key: `${i}` })))).toBe(false)
    expect(showOneFile(Array.from({ length: MAX_STACK_FILES + 1 }, () => file()))).toBe(true)
  })

  it('prices aggregate changed lines, not just the largest file', () => {
    expect(showOneFile([file({ additions: MAX_STACK_LINES, deletions: 0 })])).toBe(false)
    expect(showOneFile([file({ additions: MAX_STACK_LINES, deletions: 0 }), file()])).toBe(true)
    expect(showOneFile([file({ additions: MAX_STACK_LINES + 1 })])).toBe(true)
  })

  it('treats unknown text sizes conservatively but does not price binary editors', () => {
    expect(showOneFile([file({ additions: null })])).toBe(true)
    expect(showOneFile([file({ deletions: null })])).toBe(true)
    expect(showOneFile([file({ binary: true, additions: null, deletions: null })])).toBe(false)
  })

  it('bounds message fragments and long text even with few changed lines', () => {
    const edits = Array.from({ length: MAX_STACK_PARTS }, (_, i) => ({ id: `${i}`, before: 'before', after: 'after' }))
    expect(showOneFile([file({ edits })])).toBe(false)
    expect(showOneFile([file({ edits }), file()])).toBe(true)
    expect(showOneFile([file({ written: 'x'.repeat(MAX_STACK_CHARS) })])).toBe(false)
    expect(showOneFile([file({ written: 'x'.repeat(MAX_STACK_CHARS + 1) })])).toBe(true)
    expect(showOneFile([file({ edits: [{ id: 'e', before: 'x'.repeat(MAX_STACK_CHARS), after: 'x' }] })])).toBe(true)
  })
})

describe('ReadBudget', () => {
  const a = file({ key: 'a.ts', path: 'a.ts' })
  const b = file({ key: 'b.ts', path: 'b.ts' })
  const half = MAX_STACK_CHARS / 2

  it('prices only files still listed', () => {
    const budget = new ReadBudget()
    budget.setScope('uncommitted')
    budget.admit('a.ts', MAX_STACK_CHARS, { files: [a, b], single: false, selectedKey: 'b.ts' })
    budget.admit('b.ts', 1, { files: [a, b], single: false, selectedKey: 'b.ts' })
    expect(budget.exceeds([a, b])).toBe(true)
    expect(budget.exceeds([b])).toBe(false)
  })

  it('lets only the file the one-file view will show go on past the budget', () => {
    const budget = new ReadBudget()
    const view = { files: [a, b], single: false, selectedKey: 'a.ts' }
    expect(budget.admit('a.ts', half, view)).toEqual({ admit: true, recheck: false })
    expect(budget.admit('b.ts', half + 1, view)).toEqual({ admit: false, recheck: true })
    expect(budget.admit('a.ts', half, view)).toEqual({ admit: true, recheck: true })
  })

  it('in the one-file view admits every read and rechecks only when a size changed', () => {
    const budget = new ReadBudget()
    const view = { files: [a, b], single: true, selectedKey: 'a.ts' }
    expect(budget.admit('a.ts', MAX_STACK_CHARS + 1, view)).toEqual({ admit: true, recheck: true })
    expect(budget.admit('a.ts', MAX_STACK_CHARS + 1, view)).toEqual({ admit: true, recheck: false })
    expect(budget.admit('a.ts', 10, view)).toEqual({ admit: true, recheck: true })
    expect(budget.exceeds([a, b])).toBe(false)
  })

  it('keeps sizes across a refresh of the same scope and forgets them for another scope', () => {
    const budget = new ReadBudget()
    budget.setScope('repo\nuncommitted')
    budget.admit('b.ts', MAX_STACK_CHARS + 1, { files: [a, b], single: true, selectedKey: 'b.ts' })
    budget.setScope('repo\nuncommitted')
    expect(budget.exceeds([a, b])).toBe(true)
    budget.setScope('repo\nstaged')
    expect(budget.exceeds([a, b])).toBe(false)
  })

  it('counts both sides of every text part and nothing for other diffs', () => {
    expect(diffChars({ kind: 'text', parts: [
      { id: '1', before: 'ab', after: 'abc', kind: 'modified', lineNumbers: true },
      { id: '2', before: '', after: 'x', kind: 'added', lineNumbers: false },
    ] })).toBe(6)
    expect(diffChars({ kind: 'unchanged' })).toBe(0)
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
