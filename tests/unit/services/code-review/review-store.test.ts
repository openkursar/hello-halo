/**
 * The latest review per repository survives a restart, replaces the previous
 * one, lives beside the space's conversations, and a damaged file reads as
 * "no review" instead of failing the changes view.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { GitReviewRecord } from '../../../../src/shared/types/git'

const { spaces } = vi.hoisted(() => ({ spaces: new Map<string, { path: string; isTemp: boolean }>() }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: (spaceId: string) => {
    const space = spaces.get(spaceId)
    return space ? { id: spaceId, name: spaceId, icon: '', createdAt: '', updatedAt: '', ...space } : null
  },
}))

const { getLatestReview, saveLatestReview } = await import('../../../../src/main/services/code-review/review-store')

let base: string

function record(repoRoot: string, overrides: Partial<GitReviewRecord> = {}): GitReviewRecord {
  return {
    repoRoot,
    conversationId: 'conv-1',
    variant: 'quick',
    scope: { kind: 'uncommitted' },
    scopeLabel: 'Uncommitted changes',
    snapshot: 'a'.repeat(40),
    fileCount: 3,
    startedAt: 1_790_000_000_000,
    ...overrides,
  }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'halo-review-store-')))
  spaces.set('space', { path: join(base, 'space'), isTemp: false })
  spaces.set('halo-temp', { path: join(base, 'temp'), isTemp: true })
})
afterEach(() => {
  spaces.clear()
  vi.restoreAllMocks()
  rmSync(base, { recursive: true, force: true })
})

describe('review store', () => {
  it('keeps one latest review per repository, across reads', () => {
    expect(getLatestReview('space', '/work/app')).toBeNull()
    saveLatestReview('space', record('/work/app'))
    saveLatestReview('space', record('/work/lib', { conversationId: 'conv-lib', variant: 'team' }))
    saveLatestReview('space', record('/work/app', { conversationId: 'conv-2', scope: { kind: 'since-review', snapshot: 'b'.repeat(40) } }))

    expect(getLatestReview('space', '/work/app')).toEqual(
      record('/work/app', { conversationId: 'conv-2', scope: { kind: 'since-review', snapshot: 'b'.repeat(40) } }),
    )
    expect(getLatestReview('space', '/work/lib')?.conversationId).toBe('conv-lib')
    expect(getLatestReview('space', '/work/other')).toBeNull()
  })

  it('writes beside the conversations: .halo/code-review for a space, code-review for the temp space', () => {
    saveLatestReview('space', record('/work/app'))
    saveLatestReview('halo-temp', record('/tmp/scratch'))
    const spaceFile = join(base, 'space', '.halo', 'code-review', 'latest.json')
    const tempFile = join(base, 'temp', 'code-review', 'latest.json')
    expect(JSON.parse(readFileSync(spaceFile, 'utf8'))).toEqual({ version: 1, reviews: { '/work/app': record('/work/app') } })
    expect(JSON.parse(readFileSync(tempFile, 'utf8')).reviews['/tmp/scratch'].repoRoot).toBe('/tmp/scratch')
    expect(readdirSync(join(base, 'space', '.halo', 'code-review'))).toEqual(['latest.json'])
  })

  it('uses the repository root only as a key', () => {
    for (const repoRoot of ['../../outside', '__proto__', 'constructor']) {
      saveLatestReview('space', record(repoRoot))
      expect(getLatestReview('space', repoRoot)?.repoRoot).toBe(repoRoot)
    }
    expect(readdirSync(join(base, 'space', '.halo', 'code-review'))).toEqual(['latest.json'])
    expect(existsSync(join(base, 'outside'))).toBe(false)
    expect(getLatestReview('space', 'toString')).toBeNull()
  })

  it('reads a damaged file as no review, says so once, and replaces it on the next save', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = join(base, 'space', '.halo', 'code-review')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'latest.json'), '{ not json')
    expect(getLatestReview('space', '/work/app')).toBeNull()
    expect(getLatestReview('space', '/work/app')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)

    saveLatestReview('space', record('/work/app'))
    expect(getLatestReview('space', '/work/app')?.conversationId).toBe('conv-1')
  })

  it('ignores records of the wrong shape and unknown spaces', () => {
    const dir = join(base, 'space', '.halo', 'code-review')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'latest.json'), JSON.stringify({ version: 1, reviews: { '/work/app': { repoRoot: '/work/app', conversationId: 7 } } }))
    expect(getLatestReview('space', '/work/app')).toBeNull()
    expect(getLatestReview('missing', '/work/app')).toBeNull()
    expect(() => saveLatestReview('missing', record('/work/app'))).toThrow(/Unknown space/)
  })
})
