/**
 * How a review card reads progress from the review conversation: running from
 * the moment the task is recorded, a team review running until its members are
 * done (its first reply only hands the work out), stopped and failed reviews
 * told apart from finished ones, and the report taken from the review's own
 * span even when the user kept talking there.
 */

import { describe, it, expect } from 'vitest'
import { deriveReviewProgress, reviewSpan, type ReviewProgressInput } from '../../../src/renderer/utils/review-progress'
import { describeThoughtActivity, latestTodos } from '../../../src/renderer/utils/thought-activity'
import type { Message, Thought } from '../../../src/renderer/types'
import type { CollabSummary } from '../../../src/shared/apps/team-types'
import type { GitReviewRecord } from '../../../src/shared/types/git'

const task = { type: 'code-review', variant: 'quick', repoRoot: '/r', repoName: 'r', scope: { kind: 'uncommitted' }, scopeLabel: 'U', beforeRevision: null, fileCount: 1, language: 'en' } as const

const user = (id: string, content = '', extra: Partial<Message> = {}): Message =>
  ({ id, role: 'user', content, timestamp: '2026-10-03T10:00:00.000Z', ...extra }) as Message
const reply = (id: string, content: string, extra: Partial<Message> = {}): Message =>
  ({ id, role: 'assistant', content, timestamp: '2026-10-03T10:00:01.000Z', ...extra }) as Message

const record = (variant: 'quick' | 'team' = 'quick'): GitReviewRecord => ({
  repoRoot: '/r', conversationId: 'c', variant, scope: { kind: 'uncommitted' }, scopeLabel: 'U', snapshot: 'a'.repeat(40), fileCount: 1, startedAt: 1000,
})

const collab = (active: boolean): CollabSummary => ({
  teamId: 't', name: 'Review', goal: 'g', epochId: 'e', active, saved: false,
  members: [
    { appId: 'a1', memberName: 'architecture', role: 'Architecture reviewer', status: active ? 'working' : 'idle' },
    { appId: 'a2', memberName: 'correctness', role: 'Correctness reviewer', status: 'waiting_user' },
  ],
})

function input(over: Partial<ReviewProgressInput> = {}): ReviewProgressInput {
  return {
    record: record(),
    loadError: null,
    conversation: { title: 'Review · U', updatedAt: '2026-10-03T10:05:00.000Z', messages: [user('m0', '', { metadata: { task } })] },
    isGenerating: false,
    sessionError: null,
    sessionErrorType: null,
    liveTodos: null,
    liveActivity: null,
    earlierTodos: null,
    collab: null,
    collabEnd: null,
    ...over,
  }
}

const withMessages = (...messages: Message[]) => ({ title: 'Review · U', updatedAt: '2026-10-03T10:05:00.000Z', messages: [user('m0', '', { metadata: { task } }), ...messages] })

describe('reviewSpan', () => {
  it('runs from the task message to the next message the user typed', () => {
    const messages = [user('m0', '', { metadata: { task } }), reply('m1', 'r'), user('m2', 'inj', { source: 'injection' }), reply('m3', 'report'), user('m4', 'fix it'), reply('m5', 'fixed')]
    expect(reviewSpan(messages)).toEqual({ start: 0, end: 4 })
    expect(reviewSpan([user('x', 'hi')])).toBeNull()
  })
})

describe('deriveReviewProgress', () => {
  it('is running from the moment its task is recorded', () => {
    expect(deriveReviewProgress(input()).status).toBe('running')
    expect(deriveReviewProgress(input({ conversation: null })).status).toBe('loading')
    expect(deriveReviewProgress(input({ loadError: 'Conversation not found' }))).toMatchObject({ status: 'missing', error: 'Conversation not found' })
  })

  it('shows the live action and todo list while a turn runs', () => {
    const progress = deriveReviewProgress(input({
      isGenerating: true,
      liveActivity: { key: 'Reading {{file}}...', params: { file: 'a.ts' } },
      liveTodos: [{ content: 'Read rules', status: 'completed' }],
    }))
    expect(progress).toMatchObject({ status: 'running', activity: { key: 'Reading {{file}}...' }, todos: [{ content: 'Read rules' }] })
  })

  it('finishes a quick review with its last reply as the report, ignoring later chat', () => {
    const progress = deriveReviewProgress(input({
      conversation: withMessages(
        reply('m1', '# Report', { tokenUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 1, totalCostUsd: 0, contextWindow: 0 } }),
        user('m2', 'now fix it'),
        reply('m3', 'fixed'),
      ),
    }))
    expect(progress).toMatchObject({
      status: 'done',
      report: { messageId: 'm1', content: '# Report' },
      tokens: 116,
      endedAt: Date.parse('2026-10-03T10:05:00.000Z'),
      conversationTitle: 'Review · U',
    })
  })

  it('tells stopped and failed reviews apart', () => {
    expect(deriveReviewProgress(input({ sessionErrorType: 'interrupted', sessionError: 'Stopped by user.' })).status).toBe('stopped')
    expect(deriveReviewProgress(input({ sessionError: 'boom' }))).toMatchObject({ status: 'error', error: 'boom' })
    expect(deriveReviewProgress(input({ conversation: withMessages(reply('m1', '', { error: 'rate limited' })) }))).toMatchObject({ status: 'error', error: 'rate limited' })
    expect(deriveReviewProgress(input({ conversation: withMessages(reply('m1', '  ')) })).status).toBe('stopped')
  })

  describe('team review', () => {
    const team = (over: Partial<ReviewProgressInput>) => input({ record: record('team'), ...over })

    it('keeps running while its members work, never taking the hand-out note as the report', () => {
      const progress = deriveReviewProgress(team({ conversation: withMessages(reply('m1', 'Team is on it.')), collab: collab(true) }))
      expect(progress.status).toBe('running')
      expect(progress.report).toBeNull()
      expect(progress.members).toEqual([
        { name: 'architecture', role: 'Architecture reviewer', state: 'working' },
        { name: 'correctness', role: 'Correctness reviewer', state: 'waiting' },
      ])
    })

    it('waits for the collaboration before judging an idle conversation', () => {
      expect(deriveReviewProgress(team({ conversation: withMessages(reply('m1', 'Team is on it.')), collab: undefined })).status).toBe('loading')
      expect(deriveReviewProgress(team({ collab: collab(false), collabEnd: undefined, conversation: withMessages(reply('m1', 'x')) })).status).toBe('running')
    })

    it('is done once the team completed and the coordinator replied', () => {
      const progress = deriveReviewProgress(team({
        conversation: withMessages(reply('m1', 'Team is on it.'), reply('m2', '# Team report')),
        collab: collab(false),
        collabEnd: { reason: 'completed', summary: 'Reviewed' },
      }))
      expect(progress).toMatchObject({ status: 'done', report: { messageId: 'm2' } })
      expect(progress.members?.[0].state).toBe('done')
    })

    it('is stopped when its work was closed without team_complete, failed on timeout', () => {
      const closed = { conversation: withMessages(reply('m1', 'Team is on it.')), collab: collab(false) }
      expect(deriveReviewProgress(team({ ...closed, collabEnd: { reason: 'completed', summary: null } })).status).toBe('stopped')
      expect(deriveReviewProgress(team({ ...closed, collabEnd: { reason: 'stopped', summary: null } })).status).toBe('stopped')
      expect(deriveReviewProgress(team({ ...closed, collabEnd: { reason: 'timeout', summary: null } })).status).toBe('error')
    })

    it('falls back to a single reviewer when no collaboration was ever made', () => {
      const progress = deriveReviewProgress(team({ conversation: withMessages(reply('m1', '# Solo report')), collab: null }))
      expect(progress).toMatchObject({ status: 'done', members: null, report: { content: '# Solo report' } })
    })
  })
})

describe('thought activity', () => {
  const step = (over: Partial<Thought>): Thought => ({ id: Math.random().toString(), type: 'tool_use', content: '', timestamp: '', isReady: true, ...over })

  it('describes the latest main-agent action with the chat\'s own keys', () => {
    expect(describeThoughtActivity([])).toEqual({ key: 'Thinking...' })
    expect(describeThoughtActivity([step({ toolName: 'Read', toolInput: { file_path: '/a/b/provider-adapters.ts' } })]))
      .toEqual({ key: 'Reading {{file}}...', params: { file: 'provider-adapters.ts' } })
    expect(describeThoughtActivity([
      step({ toolName: 'Bash', toolInput: { command: 'git diff --stat HEAD' } }),
      step({ toolName: 'Read', parentToolUseId: 'sub', toolInput: { file_path: 'x' } }),
    ])).toEqual({ key: 'Executing {{command}}...', params: { command: 'git diff' } })
  })

  it('reads the latest todo list of the main agent', () => {
    const todos = (items: string[]) => step({ toolName: 'TodoWrite', toolInput: { todos: items.map(content => ({ content, status: 'pending' })) } })
    expect(latestTodos([todos(['a']), todos(['a', 'b'])])).toEqual([
      { content: 'a', status: 'pending', activeForm: undefined },
      { content: 'b', status: 'pending', activeForm: undefined },
    ])
    expect(latestTodos([step({ toolName: 'Read' })])).toBeNull()
  })
})
