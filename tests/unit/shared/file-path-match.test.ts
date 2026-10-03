/**
 * The @ menu's ranking moved from the renderer (sort the whole list per
 * keystroke) to the path index (bounded top-k). The results must be exactly
 * what the old filter + sort + slice produced.
 */

import { describe, it, expect } from 'vitest'
import { matchesNormalizedPath, normalizePathLike, rankPaths, scorePathMatch, type RankablePath } from '../../../src/shared/file-path-match'

// The renderer's previous implementation, verbatim in behavior.
function legacyRank(entries: Array<{ relativePath: string; name: string; type: 'file' | 'folder' }>, query: string, limit: number) {
  const matches = (relativePath: string, q: string): boolean => {
    const p = normalizePathLike(relativePath)
    const nq = normalizePathLike(q)
    if (!nq) return true
    if (p.includes(nq)) return true
    const ps = p.split('/').filter(Boolean)
    const qs = nq.split('/').filter(Boolean)
    if (qs.length === 0) return true
    if (qs.length > ps.length) return false
    for (let i = 0; i < qs.length; i++) if (!ps[i]?.startsWith(qs[i])) return false
    return true
  }
  const nq = normalizePathLike(query.trim())
  const score = (a: { relativePath: string; name: string; type: string }) => {
    const name = normalizePathLike(a.name)
    const rp = normalizePathLike(a.relativePath)
    if (!nq) return a.type === 'folder' ? 0 : 1
    if (rp === nq || name === nq) return 0
    if (rp.startsWith(nq)) return 1
    if (name.startsWith(nq)) return 2
    if (rp.includes(nq)) return 3
    return 10
  }
  return [...entries]
    .filter(a => matches(a.relativePath, query.trim()))
    .sort((a, b) => {
      const d = score(a) - score(b)
      if (d !== 0) return d
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.relativePath.localeCompare(b.relativePath)
    })
    .slice(0, limit)
    .map(a => a.relativePath)
}

function corpus(): Array<RankablePath & { name: string; type: 'file' | 'folder' }> {
  const out: Array<RankablePath & { name: string; type: 'file' | 'folder' }> = []
  const dirs = ['src', 'src/components', 'src/components/chat', 'docs', 'Deep', 'deep/d0_1', 'tests/unit']
  for (const dir of dirs) {
    const name = dir.split('/').pop()!
    out.push({ relativePath: dir, normalized: normalizePathLike(dir), isFolder: true, name, type: 'folder' })
    for (let i = 0; i < 40; i++) {
      const file = `${dir}/${['index', 'Chat', 'd', 'readme', 'data'][i % 5]}${i}.${i % 2 ? 'ts' : 'md'}`
      out.push({ relativePath: file, normalized: normalizePathLike(file), isFolder: false, name: file.split('/').pop()!, type: 'file' })
    }
  }
  return out
}

describe('rankPaths', () => {
  const entries = corpus()

  for (const query of ['', 'd', 'D', 'src/co', 'chat', 'deep/d0_1', 'index1', 'zzz', 'src/components/chat/Chat1.ts', ' tests ']) {
    it(`matches the previous ranking for "${query}"`, () => {
      expect(rankPaths(entries, query.trim(), 50).map(e => e.relativePath)).toEqual(legacyRank(entries, query, 50))
    })
  }

  it('returns nothing for a non-positive limit', () => {
    expect(rankPaths(entries, '', 0)).toEqual([])
  })
})

// The bounded insertion ranking rankPaths used before it became a heap (it was
// quadratic for large limits). Kept to pin the exact output order.
function insertionRank<T extends RankablePath>(entries: T[], query: string, limit: number): T[] {
  const nq = normalizePathLike(query)
  const best: Array<{ entry: T; score: number }> = []
  const before = (a: { entry: T; score: number }, b: { entry: T; score: number }): boolean => {
    if (a.score !== b.score) return a.score < b.score
    if (a.entry.isFolder !== b.entry.isFolder) return a.entry.isFolder
    return a.entry.relativePath.localeCompare(b.entry.relativePath) < 0
  }
  for (const entry of entries) {
    if (!matchesNormalizedPath(entry.normalized, nq)) continue
    const name = entry.normalized.slice(entry.normalized.lastIndexOf('/') + 1)
    const candidate = { entry, score: scorePathMatch(entry.normalized, name, entry.isFolder, nq) }
    if (best.length === limit && !before(candidate, best[best.length - 1])) continue
    let at = best.length
    while (at > 0 && before(candidate, best[at - 1])) at--
    best.splice(at, 0, candidate)
    if (best.length > limit) best.pop()
  }
  return best.map(item => item.entry)
}

function bigCorpus(n: number): RankablePath[] {
  const out: RankablePath[] = []
  for (let i = 0; i < n; i++) {
    const p = `dir${(i * 7919) % 97}/Sub${i % 13}/file${(i * 104729) % n}.${i % 3 ? 'ts' : 'MD'}`
    out.push({ relativePath: p, normalized: normalizePathLike(p), isFolder: i % 10 === 0 })
  }
  return out
}

describe('rankPaths ordering matches the previous insertion ranking', () => {
  const entries = [...corpus(), ...bigCorpus(3000)]
  for (const query of ['', 'd', 'dir1', 'dir1/sub', 'file12', 'md', 'nope']) {
    for (const limit of [1, 20, 500, 100_000]) {
      it(`"${query}" limit ${limit}`, () => {
        expect(rankPaths(entries, query, limit).map(e => e.relativePath))
          .toEqual(insertionRank(entries, query, limit).map(e => e.relativePath))
      })
    }
  }
})

// Wall-clock thresholds are not gateable under a loaded parallel suite, so the
// cost is pinned structurally: path comparisons are counted through a getter
// (every tie-breaking comparison reads both paths) and must stay O(n log n).
describe('rankPaths cost', () => {
  function counted(n: number): { entries: RankablePath[]; comparisons: () => number } {
    let reads = 0
    const entries = bigCorpus(n).map(e => {
      const { relativePath } = e
      return { ...e, get relativePath() { reads++; return relativePath } }
    })
    return { entries, comparisons: () => reads / 2 }
  }
  const bound = (n: number) => 3 * n * Math.log2(n)

  it('ranks 20,000 paths with O(n log n) comparisons', () => {
    for (const query of ['', 'dir1', 'file']) {
      const { entries, comparisons } = counted(20_000)
      const started = performance.now()
      rankPaths(entries, query, 20_000)
      console.info(`[rankPaths] 20k "${query}": ${comparisons()} comparisons, ${Math.round(performance.now() - started)} ms`)
      expect(comparisons()).toBeLessThanOrEqual(bound(20_000))
    }
  })

  it('the bound rejects the previous quadratic ranking', () => {
    const { entries, comparisons } = counted(4000)
    insertionRank(entries, '', 4000)
    expect(comparisons()).toBeGreaterThan(bound(4000))
  })
})
