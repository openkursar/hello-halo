/**
 * The rules every tag list follows, wherever it is edited.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_TAGS_PER_APP, cleanTag, countTags, foldTag, hasTag, normalizeTags, renameInTags, requireTag, sameTag, tagsMatchSearch,
} from '../../../src/shared/apps/app-tags'

describe('normalizeTags', () => {
  it('trims, collapses spaces, drops empties and case-duplicates keeping the first spelling', () => {
    expect(normalizeTags(['  Daily  report ', '', 'daily REPORT', '巡检'])).toEqual(['Daily report', '巡检'])
  })

  it('refuses an over-long tag or list instead of cutting it', () => {
    expect(cleanTag('x'.repeat(50))).toHaveLength(50)
    expect(() => normalizeTags(['x'.repeat(33)])).toThrow('at most 32 characters')
    expect(normalizeTags(['x'.repeat(32)])).toEqual(['x'.repeat(32)])
    expect(() => requireTag(' ')).toThrow()
    expect(() => normalizeTags(Array.from({ length: MAX_TAGS_PER_APP + 1 }, (_, i) => `t${i}`))).toThrow()
    expect(() => normalizeTags('tag')).toThrow()
    expect(() => normalizeTags([1])).toThrow()
  })
})

describe('case folding', () => {
  it('folds ASCII only, exactly like SQLite lower(), so every layer agrees', () => {
    expect(foldTag('Ops-ÉTÉ')).toBe('ops-ÉtÉ')
    expect(sameTag('OPS', 'ops')).toBe(true)
    expect(sameTag('Été', 'été')).toBe(false)
    expect(normalizeTags(['Été', 'été'])).toEqual(['Été', 'été'])
    expect(countTags([['Été'], ['été']])).toHaveLength(2)
  })
})

describe('renameInTags', () => {
  it('renames in place, merges into an existing tag, removes with null, and leaves others alone', () => {
    expect(renameInTags(['a', 'B', 'c'], 'b', 'x')).toEqual(['a', 'x', 'c'])
    expect(renameInTags(['a', 'b'], 'b', 'A')).toEqual(['a'])
    expect(renameInTags(['a', 'b'], 'A', null)).toEqual(['b'])
    expect(renameInTags(['a'], 'z', 'y')).toEqual(['a'])
  })
})

describe('counting and matching', () => {
  it('counts across items, case folded, most used first', () => {
    expect(countTags([['a', 'B'], ['b'], undefined, ['c']])).toEqual([
      { name: 'B', count: 2 }, { name: 'a', count: 1 }, { name: 'c', count: 1 },
    ])
  })

  it('matches a filter and a search', () => {
    expect(hasTag(['Ops'], 'ops')).toBe(true)
    expect(hasTag(undefined, '')).toBe(true)
    expect(hasTag(['Ops'], 'dev')).toBe(false)
    expect(tagsMatchSearch(['巡检任务'], '巡检')).toBe(true)
    expect(tagsMatchSearch(['a'], 'b')).toBe(false)
  })
})
