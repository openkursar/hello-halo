import { describe, expect, it } from 'vitest'
import type { BlackboardTask, RosterMember, TeamActivity, TeamDetail } from '../../../src/shared/apps/team-types'
import { conversationSubtasks } from '../../../src/renderer/components/team/workbench/delegations'
import { delegatedTasks } from '../../../src/shared/apps/team-delegations'
import { taskProgress } from '../../../src/renderer/components/team/workbench/progress'

const LEAD = 'space-conv-lead'
let seq = 0
const act = (actorAppId: string, targetAppId: string, createdAt: number, extra: Partial<TeamActivity> = {}): TeamActivity => ({
  id: `a${++seq}`, teamId: 't', epochId: 'e', kind: 'message', actorAppId, targetAppId,
  subject: `${actorAppId} to ${targetAppId}`, body: null, refId: null, correlationId: null, status: 'sent', createdAt, ...extra,
})
const member = (appId: string, busy = false) => ({ appId, memberName: appId, ...(busy ? { busy: [{ epochId: 'e' }] } : {}) } as RosterMember)
const derive = (activities: TeamActivity[], roster = [member('a'), member('b')]) => delegatedTasks({
  teamId: 't', epochId: 'e', leadAppId: LEAD, activities, busyAppIds: new Set(roster.filter(row => row.busy?.length).map(row => row.appId)),
})

describe('delegatedTasks', () => {
  it('makes one subtask per member the lead wrote to, titled by the first message', () => {
    const rows = derive([act(LEAD, 'a', 1, { subject: 'Research' }), act(LEAD, 'b', 2, { subject: 'Write' }), act(LEAD, 'a', 3, { subject: 'More' })])
    expect(rows.map(row => [row.assigneeAppId, row.title, row.status])).toEqual([['a', 'Research', 'in_progress'], ['b', 'Write', 'in_progress']])
  })

  it('is done once the member answered the latest message and is not at work', () => {
    const rows = derive([act(LEAD, 'a', 1), act('a', LEAD, 5), act(LEAD, 'b', 2), act('b', LEAD, 6)], [member('a'), member('b', true)])
    expect(rows.map(row => row.status)).toEqual(['done', 'in_progress'])
    expect(rows[0]).toMatchObject({ createdAt: 1, updatedAt: 5 })
  })

  it('once done, is titled by the opening line of the member\'s first report, its paths named by file', () => {
    const rows = derive([
      act(LEAD, 'a', 1, { subject: 'You are a reviewer named Zhou', body: 'You are a reviewer named Zhou' }),
      act('a', LEAD, 2, { body: '\n**Reviewed** /Users/me/space/collaboration/x/citywalk-draft.md and fixed 3 facts\nDetails…' }),
      act(LEAD, 'a', 3, { subject: 'Thanks, republished' }),
      act('a', LEAD, 4, { body: 'Got it, thanks for confirming. Two notes:' }),
      act(LEAD, 'b', 5, { subject: 'Write the draft' }),
      act('b', LEAD, 6, { status: 'error', body: 'Crashed' }),
    ])
    expect(rows.map(row => row.title)).toEqual(['Reviewed citywalk-draft.md and fixed 3 facts', 'Write the draft'])
  })

  it('keeps the first message as title when the report opens with a bare path, carrying the path as its result', () => {
    const rows = derive([
      act(LEAD, 'a', 1, { subject: 'Sweep the trigger claims' }),
      act('a', LEAD, 2, { body: '`content-strategy/reviews/sweep.md`\nFound 14 claims' }),
      act(LEAD, 'b', 3, { subject: 'Fix the scripts' }),
      act('b', LEAD, 4, { body: 'fixes.md' }),
    ])
    expect(rows.map(row => [row.title, row.resultRef])).toEqual([['Sweep the trigger claims', 'content-strategy/reviews/sweep.md'], ['Fix the scripts', 'fixes.md']])
  })

  it('reopens while the member works on a later ask, and ignores failed answers', () => {
    expect(derive([act(LEAD, 'a', 1), act('a', LEAD, 2), act(LEAD, 'a', 3)], [member('a', true)])[0].status).toBe('in_progress')
    expect(derive([act(LEAD, 'a', 1), act('a', LEAD, 2, { kind: 'reply', status: 'error' })])[0].status).toBe('in_progress')
    expect(derive([act(LEAD, 'a', 1), act('a', LEAD, 2, { kind: 'reply', status: 'ok' })])[0].status).toBe('done')
  })

  it('settles a closing word left unanswered by a member that has reported, unless it failed or never arrived', () => {
    expect(derive([act(LEAD, 'a', 1), act('a', LEAD, 2), act(LEAD, 'a', 3, { subject: 'Approved, no need to reply' })])[0].status).toBe('done')
    expect(derive([act(LEAD, 'a', 1), act('a', LEAD, 2), act(LEAD, 'a', 3), act('a', LEAD, 4, { kind: 'reply', status: 'error' })])[0].status).toBe('in_progress')
    expect(derive([act(LEAD, 'a', 1), act('a', LEAD, 2), act(LEAD, 'a', 3, { status: 'undelivered' })])[0].status).toBe('in_progress')
    expect(derive([act(LEAD, 'a', 1)])[0].status).toBe('in_progress')
  })

  it('counts a board finding after the ask as the member\'s answer', () => {
    const finding = (at: number) => act('a', '', at, { kind: 'finding', targetAppId: null, body: 'Replaced all four notes' })
    expect(derive([act(LEAD, 'a', 1), finding(2)])[0]).toMatchObject({ status: 'done', title: 'Replaced all four notes' })
    expect(derive([finding(0), act(LEAD, 'a', 1)])[0].status).toBe('in_progress')
  })

  it('ignores messages between members the lead set to work, and from other epochs', () => {
    expect(derive([act(LEAD, 'a', 1), act('a', 'b', 2)]).map(row => row.assigneeAppId)).toEqual(['a'])
    expect(derive([act(LEAD, 'a', 2, { epochId: 'other' })])).toEqual([])
  })

  it('counts a member that wrote first as a coordinator, done once it and the lead are both answered', () => {
    const roster = [member('front'), member('a'), member('b')]
    const rows = derive([
      act('front', 'a', 1), act('front', 'b', 1),
      act('a', 'front', 2), act('b', 'front', 2),
      act(LEAD, 'front', 3), act(LEAD, 'a', 3), act('a', LEAD, 4),
    ], roster)
    expect(rows.map(row => [row.assigneeAppId, row.status, row.createdByAppId])).toEqual([['a', 'done', 'front'], ['b', 'done', 'front']])
    expect(derive([act('front', 'a', 1), act('a', 'front', 2), act(LEAD, 'a', 3)], roster)[0].status).toBe('in_progress')
  })
})

describe('conversationSubtasks', () => {
  const detail = (ephemeral: boolean, tasks: BlackboardTask[] = []) => ({
    team: { id: 't', leadAppId: LEAD, ephemeral }, roster: [member('a')], tasks,
  } as unknown as TeamDetail)
  const activities = [act(LEAD, 'a', 1), act('a', LEAD, 2)]

  it('reads delegations only when the board is empty, for temporary and standing teams alike', () => {
    expect(conversationSubtasks(detail(true), 'e', [], activities)).toHaveLength(1)
    expect(conversationSubtasks(detail(false), 'e', [], activities)).toHaveLength(1)
    const board = [{ id: 'x', epochId: 'e', status: 'pending' } as BlackboardTask]
    expect(conversationSubtasks(detail(true), 'e', board, activities)).toBe(board)
  })

  it('settles the conversation once every delegated member has answered', () => {
    const tasks = conversationSubtasks(detail(true), 'e', [], activities)
    const progress = taskProgress({ epochId: 'e', roster: [member('a')], leadAppId: LEAD, activities, tasks, decisions: [], waitingAppIds: [], participants: new Set(['a']), completed: false })
    expect(progress).toMatchObject({ total: 1, finished: true })
  })
})
