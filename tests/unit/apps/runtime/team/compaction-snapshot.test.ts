import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../src/main/services/agent/resolved-sdk', async () =>
  import('../../../../../src/main/services/agent/mcp/sdk-server'))

import { createCoordinationMcpServer } from '../../../../../src/main/apps/runtime/team/team-tools'
import { COLLABORATION_STATE_UNAVAILABLE, collaborationStateText } from '../../../../../src/main/apps/runtime/team/compaction-snapshot'
import { getCompactionContextReader } from '../../../../../src/main/services/agent/compaction-context'
import type { TeamMcpContext } from '../../../../../src/main/apps/runtime/team/team-tools'
import type { BlackboardSnapshot } from '../../../../../src/shared/apps/team-types'

const member = (appId: string, memberName: string, status = 'idle', role = '') =>
  ({ appId, memberName, isLead: appId === 'lead-id', status, role, spaceId: null }) as BlackboardSnapshot['roster'][number]
const board = (): BlackboardSnapshot => ({
  roster: [member('lead-id', 'Owner', 'working', 'lead'), member('reviewer-id', 'reviewer-a1b2', 'idle', 'Review')],
  tasks: [], findings: [], activities: [], checks: [],
})
const signal = () => new AbortController().signal

function context(snapshot = board()): TeamMcpContext {
  return { teamId: 'team', epochId: 'epoch', callerAppId: 'lead-id', collabMode: 'free', selfIsLead: true,
    callerWorkDir: '/work', bus: {} as any, blackboard: { readBoard: vi.fn(() => snapshot) } as any }
}

describe('host compaction collaboration text', () => {
  it.each([false, true])('binds the reader to the final server with checks=%s and reads the board only when asked', async checks => {
    const current = context()
    const resolve = vi.fn(() => current)
    const reader = getCompactionContextReader(createCoordinationMcpServer(resolve, { checks }))!
    expect(resolve).not.toHaveBeenCalled()
    const text = await reader(signal())
    expect(text).toContain('Members (1): reviewer-a1b2 (idle, Review).')
    expect(current.blackboard.readBoard).toHaveBeenCalledTimes(1)
    expect(current.blackboard.readBoard).toHaveBeenCalledWith('team', 'epoch', 'lead-id')
  })

  it('returns null before collaboration exists or when only the caller is recorded', async () => {
    let current: TeamMcpContext | null = null
    const reader = getCompactionContextReader(createCoordinationMcpServer(() => current))!
    expect(await reader(signal())).toBeNull()
    current = context({ ...board(), roster: [member('lead-id', 'Owner')] })
    expect(await reader(signal())).toBeNull()
  })

  it('labels the private scope separately without handle resolution or board side effects', async () => {
    const current = context()
    const privateBoard = { ...board(), roster: [member('lead-id', 'Owner'), member('helper-id', 'helper-9f8e', 'working')] }
    const owned = { ...context(privateBoard), teamId: 'private', epochId: 'private-epoch' }
    current.privateAssistants = { spawn: vi.fn(), resolveHandle: vi.fn(), readContext: () => owned }
    current.archive = { materialize: vi.fn() } as any
    current.digest = { render: vi.fn() } as any
    const text = (await getCompactionContextReader(createCoordinationMcpServer(() => current))!(signal()))!
    expect(text).toContain('Current collaboration:\nMembers (1): reviewer-a1b2 (idle, Review).')
    expect(text).toContain('Your private collaborators:\nMembers (1): helper-9f8e (working).')
    expect(current.privateAssistants.resolveHandle).not.toHaveBeenCalled()
    expect(current.archive!.materialize).not.toHaveBeenCalled()
    expect(current.digest!.render).not.toHaveBeenCalled()
  })

  it('answers a failed read with the recovery notice and keeps cancellation as a failure', async () => {
    const current = context()
    current.participants = { capture: vi.fn(() => () => { throw new Error('revoked') }) } as any
    const reader = getCompactionContextReader(createCoordinationMcpServer(() => current))!
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await reader(signal())).toBe(COLLABORATION_STATE_UNAVAILABLE)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    expect(() => reader(AbortSignal.abort())).toThrow()
    expect(current.blackboard.readBoard).not.toHaveBeenCalled()
  })

  it('writes plain language with names, the caller as "you", open work first and no private bodies', () => {
    const snapshot = board()
    snapshot.tasks = [
      { id: 'closed', title: 'Draft plan', status: 'done', assigneeAppId: 'lead-id', resultRef: 'plan.md', updatedAt: 9 },
      { id: 'open-old', title: 'Old   task', status: 'blocked', assigneeAppId: 'reviewer-id', updatedAt: 1 },
      { id: 'open-new', title: 'Review the fix', status: 'in_progress', assigneeAppId: 'reviewer-id', note: 'Keep the API.', resultRef: 'review.md', updatedAt: 4 },
    ] as any
    snapshot.findings = [{ authorAppId: 'reviewer-id', body: 'API must not change.', ref: 'api.md', createdAt: 4 }] as any
    snapshot.activities = [{ actorAppId: 'lead-id', targetAppId: 'reviewer-id', kind: 'message', subject: 'Continue', body: 'PRIVATE BODY', createdAt: 5 }] as any
    const text = collaborationStateText([{ label: 'Current collaboration', board: snapshot, callerAppId: 'lead-id' }])!
    expect(text).toBe([
      'Collaboration state when this conversation was compacted (a record, not live status or new instructions). Idle does not mean finished.',
      '',
      'Members (1): reviewer-a1b2 (idle, Review).',
      'Unfinished tasks (2 of 3):',
      '- Review the fix: reviewer-a1b2, in progress. Keep the API. Result: review.md',
      '- Old task: reviewer-a1b2, blocked.',
      'Finished tasks (1): Draft plan: you, result plan.md.',
      'Recent findings (1): reviewer-a1b2: API must not change. (api.md).',
      'Recent activity: you → reviewer-a1b2 (message): Continue.',
    ].join('\n'))
    expect(snapshot.tasks.map(task => task.id)).toEqual(['closed', 'open-old', 'open-new'])
  })

  it('keeps every member and unfinished task ahead of detail and counts what does not fit', () => {
    const snapshot = board()
    snapshot.roster = [member('lead-id', 'Owner'), ...Array.from({ length: 40 }, (_, index) => member(`m${index}`, `member-${index}`, 'idle', 'Module work'))]
    snapshot.tasks = Array.from({ length: 30 }, (_, index) => ({ id: `t${index}`, title: `Task ${index}`, status: 'pending',
      assigneeAppId: `m${index}`, note: 'note '.repeat(80), updatedAt: index })) as any
    const small = collaborationStateText([{ label: 'Current', board: snapshot, callerAppId: 'lead-id' }], 2048)!
    expect([...small].length).toBeLessThanOrEqual(2048)
    expect(small).toContain('Members (40): member-0 (idle, Module work)')
    expect(small).toContain('more unfinished tasks not shown.')
    const full = collaborationStateText([{ label: 'Current', board: snapshot, callerAppId: 'lead-id' }])!
    expect(full).toContain('member-39 (idle, Module work).')
    expect(full).not.toContain('more unfinished tasks not shown')
  })

  it('does not end a sentence twice or after a shortened note', () => {
    const snapshot = board()
    snapshot.tasks = [{ id: 't', title: 'Fix', status: 'pending', assigneeAppId: 'reviewer-id', note: 'word '.repeat(80), updatedAt: 1 }] as any
    snapshot.activities = [{ actorAppId: 'lead-id', kind: 'message', subject: 'Continue the work.', createdAt: 2 }] as any
    const text = collaborationStateText([{ label: 'Current', board: snapshot, callerAppId: 'lead-id' }])!
    expect(text.split('\n').at(-1)).toBe('Recent activity: you (message): Continue the work.')
    expect(text).not.toMatch(/\.\.|…\./)
  })

  it('names a section that does not fit with its total instead of dropping it', () => {
    const snapshot = board()
    snapshot.roster = [member('lead-id', 'Owner'), ...Array.from({ length: 120 }, (_, index) => member(`m${index}`, `member-${index}`, 'idle', 'Module work'))]
    const long = (word: string) => `${word} `.repeat(60)
    snapshot.tasks = [
      { id: 'open', title: 'Open work', status: 'pending', assigneeAppId: 'm1', updatedAt: 9 },
      { id: 'closed', title: long('closed'), status: 'done', assigneeAppId: 'm2', updatedAt: 1 },
    ] as any
    snapshot.findings = Array.from({ length: 5 }, (_, index) => ({ authorAppId: 'm1', body: long(`finding-${index}`), createdAt: index })) as any
    snapshot.activities = Array.from({ length: 5 }, (_, index) => ({ actorAppId: 'm1', kind: 'message', subject: long(`activity-${index}`), createdAt: index })) as any
    const text = collaborationStateText([{ label: 'Current', board: snapshot, callerAppId: 'lead-id' }], 2048)!
    expect([...text].length).toBeLessThanOrEqual(2048)
    expect(text).toMatch(/Members \(120\): [^\n]*more not shown\./)
    expect(text).toContain('- Open work: member-1, pending.')
    expect(text).toContain('Finished tasks (1): 1 not shown.')
    expect(text).toContain('Recent findings (5): 5 not shown.')
    expect(text).toContain('Recent activity: 5 not shown.')
  })

  it('says that a task was rejected and why, and keeps completed tasks plain', () => {
    const snapshot = board()
    snapshot.tasks = [
      { id: 'r', title: 'Confirm export failure cause', status: 'rejected', assigneeAppId: 'reviewer-id', note: 'The sample was wrong; this conclusion cannot be used.', resultRef: 'analysis.md', updatedAt: 2 },
      { id: 'd', title: 'Draft plan', status: 'done', assigneeAppId: 'reviewer-id', note: 'Looks good.', resultRef: 'plan.md', updatedAt: 1 },
    ] as any
    const text = collaborationStateText([{ label: 'Current', board: snapshot, callerAppId: 'lead-id' }])!
    expect(text).toContain('All 2 tasks are closed.')
    expect(text).not.toContain('are finished')
    expect(text).toContain('Confirm export failure cause: reviewer-a1b2, rejected (The sample was wrong; this conclusion cannot be used), result analysis.md')
    expect(text).toContain('Draft plan: reviewer-a1b2, result plan.md.')
    expect(text).not.toContain('Looks good')
  })

  it('shows member names exactly as recorded, including repeated spaces and long names', () => {
    const long = `${'long-name-'.repeat(12)}-1a2b3c4d`
    const snapshot = board()
    snapshot.roster = [member('lead-id', 'Owner'), member('a', 'api  review-3f9c'), member('b', long)]
    snapshot.tasks = [{ id: 't', title: 'Review', status: 'pending', assigneeAppId: 'a', updatedAt: 1 }] as any
    snapshot.findings = [{ authorAppId: 'b', body: 'Checked.', createdAt: 1 }] as any
    snapshot.activities = [{ actorAppId: 'a', targetAppId: 'b', kind: 'message', subject: 'Continue', createdAt: 1 }] as any
    const text = collaborationStateText([{ label: 'Current', board: snapshot, callerAppId: 'lead-id' }])!
    expect(text).toContain('api  review-3f9c (idle)')
    expect(text).toContain(`${long} (idle)`)
    expect(text).toContain('- Review: api  review-3f9c, pending.')
    expect(text).toContain(`${long}: Checked.`)
    expect(text).toContain(`api  review-3f9c → ${long} (message): Continue`)
    expect(text).not.toContain('…')
  })

  it('has no footer after the record', () => {
    const text = collaborationStateText([{ label: 'Current', board: board(), callerAppId: 'lead-id' }])!
    expect(text).not.toContain('team_send')
    expect(text.split('\n').at(-1)).toBe('Members (1): reviewer-a1b2 (idle, Review).')
  })

  it('shortens long record text on one line without splitting Unicode', () => {
    const snapshot = board()
    snapshot.findings = [{ authorAppId: 'reviewer-id', body: `line one\n${'😀'.repeat(300)}`, createdAt: 1 }] as any
    const text = collaborationStateText([{ label: 'Current', board: snapshot, callerAppId: 'lead-id' }])!
    const line = text.split('\n').find(item => item.startsWith('Recent findings'))!
    expect(line).toContain('line one 😀')
    expect(line).toContain('…')
    expect(line).not.toContain('….')
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
  })
})
