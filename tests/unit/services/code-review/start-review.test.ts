/**
 * Starting a review: refusals the user can act on, a background conversation
 * with a kept title, the team tools its variant needs, the task as its first
 * message, and the record of the latest review.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => {
  class FakeGitError extends Error {
    constructor(readonly code: string, message: string) { super(message) }
  }
  return {
    FakeGitError,
    config: { agent: {} as { disabledTools?: string[] } },
    createConversation: vi.fn(() => ({ id: 'review-1' })),
    getToolset: vi.fn(() => ({ id: 'halo-team' }) as unknown),
    openToolset: vi.fn(() => ({ ok: true })),
    closeToolset: vi.fn(() => ({ ok: true })),
    sendMessage: vi.fn(async () => {}),
    resolveRepository: vi.fn(async () => ({ root: '/space/repo', name: 'repo' })),
    createSnapshot: vi.fn(async () => ({ tree: 'a'.repeat(40), createdAt: 1000 })),
    getChangeList: vi.fn(async () => ({
      scope: { kind: 'uncommitted' },
      beforeRevision: 'b'.repeat(40) as string | null,
      files: [{ path: 'src/a.ts', state: 'modified', additions: 2, deletions: 1, binary: false }],
      truncated: false,
    })),
    saveLatestReview: vi.fn(),
  }
})

vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => m.config }))
vi.mock('../../../../src/main/services/conversation.service', () => ({ createConversation: m.createConversation }))
vi.mock('../../../../src/main/services/agent', async () => ({
  ...(await vi.importActual<object>('../../../../src/main/services/agent/prompt-text')),
  getToolset: m.getToolset,
  openToolset: m.openToolset,
  closeToolset: m.closeToolset,
  getWorkingDir: () => '/space',
  sendMessage: m.sendMessage,
}))
vi.mock('../../../../src/main/services/git', () => ({
  resolveRepository: m.resolveRepository,
  createSnapshot: m.createSnapshot,
  getChangeList: m.getChangeList,
  isGitError: (error: unknown) => error instanceof m.FakeGitError,
}))
vi.mock('../../../../src/main/services/code-review/review-store', () => ({ saveLatestReview: m.saveLatestReview }))

import { getReviewAvailability, startReview } from '../../../../src/main/services/code-review/start-review'
import type { CodeReviewStartRequest } from '../../../../src/shared/types/code-review'

const request = (over: Partial<CodeReviewStartRequest> = {}): CodeReviewStartRequest => ({
  spaceId: 'space-1',
  repoRoot: '/space/repo',
  variant: 'quick',
  scope: { kind: 'uncommitted' },
  scopeLabel: 'Uncommitted changes',
  fileCount: 1,
  language: 'zh-CN',
  title: 'Review · Uncommitted changes · 1 file',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  m.config.agent = {}
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('getReviewAvailability', () => {
  it('offers team reviews once the team toolset is registered and not withheld', () => {
    expect(getReviewAvailability()).toEqual({ team: { available: true } })
    m.getToolset.mockReturnValueOnce(undefined)
    expect(getReviewAvailability()).toEqual({ team: { available: false, reason: 'team-unavailable' } })
    m.config.agent = { disabledTools: ['mcp__halo-team__collab_start'] }
    expect(getReviewAvailability().team.available).toBe(false)
  })
})

describe('startReview', () => {
  it('starts a quick review in a background conversation and records it', async () => {
    const result = await startReview(request())

    expect(m.createConversation).toHaveBeenCalledWith('space-1', 'Review · Uncommitted changes · 1 file', undefined, { keepTitle: true })
    expect(m.closeToolset).toHaveBeenCalledWith({ spaceId: 'space-1', conversationId: 'review-1', workDir: '/space' }, 'halo-team', 'system')
    expect(m.openToolset).not.toHaveBeenCalled()
    expect(m.sendMessage).toHaveBeenCalledWith({
      spaceId: 'space-1',
      conversationId: 'review-1',
      message: '',
      thinkingEnabled: true,
      task: {
        type: 'code-review', variant: 'quick', repoRoot: '/space/repo', repoName: 'repo',
        scope: { kind: 'uncommitted' }, scopeLabel: 'Uncommitted changes', beforeRevision: 'b'.repeat(40),
        fileCount: 1, language: 'zh-CN',
      },
      taskInstructions: expect.stringContaining('M src/a.ts  (+2 -1)'),
    })
    const record = {
      repoRoot: '/space/repo', conversationId: 'review-1', variant: 'quick', scope: { kind: 'uncommitted' },
      scopeLabel: 'Uncommitted changes', snapshot: 'a'.repeat(40), fileCount: 1, startedAt: 1000,
    }
    expect(m.saveLatestReview).toHaveBeenCalledWith('space-1', record)
    expect(result).toEqual({ ok: true, conversationId: 'review-1', record })
  })

  it('opens the team tools for a team review before its first message', async () => {
    await startReview(request({ variant: 'team' }))
    expect(m.openToolset).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'review-1' }), 'halo-team', 'system')
    expect(m.openToolset.mock.invocationCallOrder[0]).toBeLessThan(m.sendMessage.mock.invocationCallOrder[0])
  })

  it('refuses a team review while team collaboration is unavailable, creating nothing', async () => {
    m.getToolset.mockReturnValueOnce(undefined)
    expect(await startReview(request({ variant: 'team' }))).toEqual({
      ok: false, reason: 'team-unavailable', message: 'Team collaboration is not available',
    })
    expect(m.createConversation).not.toHaveBeenCalled()
  })

  it('maps git failures to reasons the view can show', async () => {
    m.resolveRepository.mockRejectedValueOnce(new m.FakeGitError('GIT_NOT_A_REPOSITORY', 'gone'))
    expect(await startReview(request())).toMatchObject({ ok: false, reason: 'not-a-repository' })
    m.createSnapshot.mockRejectedValueOnce(new m.FakeGitError('GIT_UNAVAILABLE', 'no git'))
    expect(await startReview(request())).toMatchObject({ ok: false, reason: 'git-unavailable' })
    m.getChangeList.mockRejectedValueOnce(new m.FakeGitError('GIT_SNAPSHOT_MISSING', 'pruned'))
    expect(await startReview(request())).toMatchObject({ ok: false, reason: 'failed', message: 'pruned' })
    expect(m.createConversation).not.toHaveBeenCalled()
  })

  it('still runs the review when recording it fails, and keeps the larger count of a cut list', async () => {
    m.saveLatestReview.mockImplementationOnce(() => { throw new Error('disk full') })
    m.getChangeList.mockResolvedValueOnce({
      scope: { kind: 'uncommitted' }, beforeRevision: null, truncated: true,
      files: [{ path: 'a', state: 'added', additions: 1, deletions: 0, binary: false }],
    })
    const result = await startReview(request({ fileCount: 9000 }))
    expect(result.ok && result.record.fileCount).toBe(9000)
    expect(m.sendMessage).toHaveBeenCalled()
  })
})
