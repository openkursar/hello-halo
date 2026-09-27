import { taskTime } from '../../../src/renderer/components/team/workbench/time'
import { executionTurns } from '../../../src/renderer/components/team/workbench/model'
import { describe, expect, it } from 'vitest'
import { taskConversationRows, COLLABORATION_PREVIEW_LIMIT, conversationMessages, activityLevel, taskGroup, visibleTasks, taskActivityRows, taskReportMessages, isTeamBackgroundTurn, decisionMessageId, sharedTaskDecisions } from '../../../src/renderer/components/team/workbench/model'
import { conversationLabel } from '../../../src/renderer/components/team/run-history'
import type { TeamConversation, TeamActivity } from '../../../src/shared/apps/team-types'
import type { ActivityEntry } from '../../../src/shared/apps/app-types'
const task = (patch: Partial<TeamConversation> = {}): TeamConversation => ({ epochId: 'task', teamId: 'team', kind: 'native', label: 'Task', readonly: false, startedAt: 1, lastActivityAt: 1, ...patch })
describe('task workbench projection', () => {
  it('keeps questions above completion and source grouping', () => {
    expect(taskGroup(task({ waitingUser: true, waitingForMe: true, completed: true, kind: 'im' }))).toBe('attention')
    expect(taskGroup(task({ waitingUser: true, waitingForMe: true, kind: 'run' }))).toBe('attention')
    expect(taskGroup(task({ waitingUser: true, waitingForMe: false, kind: 'run' }))).toBe('automatic')
    expect(taskGroup(task({ completed: true, involvedMe: true }))).toBe('involved')
  })
  it('uses exclusive viewer relationships and excludes direct channels', () => {
    expect(taskGroup(task({ involvedMe: true, createdByMe: true }))).toBe('mine')
    expect(taskGroup(task({ createdByMe: true }))).toBe('mine')
    expect(taskGroup(task())).toBe('other')
    expect(visibleTasks([task({ kind: 'member' }), task({ epochId: 'old', completed: true }), task({ epochId: 'new', lastActivityAt: 3 })]).map(row => row.epochId)).toEqual(['new', 'old'])
  })
  it('never folds errors or escalation into process updates', () => {
    for (const status of ['error', 'timeout', 'undelivered', 'escalation']) expect(activityLevel({ kind: 'message', status } as TeamActivity)).toBe('attention')
    expect(activityLevel({ kind: 'decision' } as TeamActivity)).toBe('result')
    expect(activityLevel({ kind: 'finding' } as TeamActivity)).toBe('result')
  })
})

const activity = { id: 'dispatch', kind: 'message', actorAppId: 'lead', targetAppId: 'kb', body: 'Investigate the products', subject: 'Investigate', createdAt: 1000, correlationId: 'dispatch-1' } as TeamActivity
const received = { id: 'received', role: 'user' as const, content: '[Team message from Lead]\n\nInvestigate the products', timestamp: new Date(1000).toISOString(), metadata: { teamTriggerKind: 'message' } }
it('keeps internal execution inputs with their outputs and retains unfinished turns', () => {
  const turns = executionTurns([received, { ...received, id: 'result', role: 'assistant' }, { ...received, id: 'next' }])
  expect(turns.map(turn => turn.id)).toEqual(['next', 'received'])
  expect(turns[0].outputs).toEqual([])
  expect(turns[1].outputs.map(message => message.id)).toEqual(['result'])
  expect(turns[1].input?.metadata?.teamTriggerKind).toBe('message')
})
it('anchors a confirmation to its tool receipt rather than quoted reply text', () => {
  const decision: ActivityEntry = { id: 'request-id', appId: 'kb', runId: 'run', type: 'escalation', ts: 2000, content: { summary: 'Confirm' } }
  const human = { ...received, metadata: { teamTriggerKind: 'human_message' } }
  const result = { ...received, id: 'result', role: 'assistant' as const, content: 'request-id' }
  expect(decisionMessageId(decision, [human, result])).toBeUndefined()
  expect(decisionMessageId(decision, [human, { ...result, thoughts: [{ id: 'tool', type: 'tool_result', content: 'Escalation sent (entry: request-id).', timestamp: received.timestamp }] }])).toBe('result')
})
it('keeps the answered question at its original position between conversation messages', () => {
  const decision: ActivityEntry = { id: 'confirm', appId: 'kb', runId: 'run', type: 'escalation', ts: 2000, content: { summary: 'Confirm receipt' } }
  const messages = [
    { ...received, id: 'human', metadata: { teamTriggerKind: 'human_message' } },
    { ...received, id: 'result', role: 'assistant' as const, timestamp: new Date(4000).toISOString() },
  ]
  const before = taskConversationRows(messages, [], 'task', 'kb', [decision])
  const answered = { ...decision, userResponse: { ts: 3000, choice: 'Received' } }
  const after = taskConversationRows(messages, [], 'task', 'kb', [answered])
  expect(before.map(row => row.id)).toEqual(['message:human', 'decision:confirm', 'message:result'])
  expect(after.map(row => row.id)).toEqual(before.map(row => row.id))
  expect(after[1].decision?.userResponse?.choice).toBe('Received')
})
describe('human conversation boundary', () => {
  it('excludes internal triggers and responses, using explicit provenance', () => {
    const messages = [received,
      { ...received, id: 'report', role: 'assistant' as const, content: 'Internal report' },
      { ...received, id: 'question', content: 'My question', metadata: { teamTriggerKind: 'human_message' } },
      { ...received, id: 'answer', role: 'assistant' as const, content: 'Your answer', metadata: undefined },
    ]
    expect(conversationMessages(messages).map(message => message.id)).toEqual(['question', 'answer'])
    expect(conversationMessages(messages.slice(0, 2))).toEqual([])
  })
  it('honors provenance even when a human quotes a team envelope', () => {
    expect(conversationMessages([{ ...received, metadata: { teamTriggerKind: 'human_message' } }])).toHaveLength(1)
    expect(conversationMessages([{ ...received, role: 'assistant', metadata: { teamTriggerKind: 'periodic_check' } }])).toEqual([])
  })
  it('includes every participant in task activity without a selected digital human', () => {
    const rows = taskActivityRows([], [activity, { ...activity, id: 'other', actorAppId: 'ims', targetAppId: 'calendar' }])
    expect(rows.flatMap(row => row.activities ?? []).map(row => row.id)).toEqual(['dispatch', 'other'])
  })
})

it('keeps different coordination kinds and exceptions distinct', () => {
  const rows = taskActivityRows([], [activity, { ...activity, id: 'error', status: 'error' }, { ...activity, id: 'result', kind: 'finding' }])
  expect(rows).toHaveLength(3)
})


describe('conversation collaboration awareness', () => {
  const update = (id: string, patch: Partial<TeamActivity> = {}): TeamActivity => ({ ...activity, id, epochId: 'task', teamId: 'team', ...patch })
  it('excludes unrelated members, other tasks, and shared board records', () => {
    const events = [update('relevant'), update('unrelated', { actorAppId: 'ims', targetAppId: 'calendar' }), update('other-task', { epochId: 'other' }), update('output', { kind: 'finding' })]
    expect(taskConversationRows([], events, 'task', 'kb').flatMap(row => row.activities ?? []).map(row => row.id)).toEqual(['relevant'])
    expect(taskConversationRows([], [events[0]], 'task', 'ims')).toEqual([])
    expect(taskConversationRows([], events, null, 'kb')).toEqual([])
  })
  it('keeps a hundred messages in one stable segment, including long gaps', () => {
    const events = Array.from({ length: 100 }, (_, index) => update(String(index), { createdAt: index * 600000 }))
    const rows = taskConversationRows([], events, 'task', 'kb')
    expect(rows).toHaveLength(1)
    expect(rows[0].activities?.slice(-COLLABORATION_PREVIEW_LIMIT).map(row => row.id)).toEqual(['97', '98', '99'])
    expect(taskConversationRows([], events.slice(0, 10), 'task', 'kb')[0].id).toBe(rows[0].id)
  })
  it('interleaves segments with human dialogue without adding dispatch receipt bubbles', () => {
    const human = { ...received, id: 'human', content: 'Hello', timestamp: new Date(2000).toISOString(), metadata: { teamTriggerKind: 'human_message' } }
    const rows = taskConversationRows([received, human], [update('before'), update('after', { createdAt: 3000 })], 'task', 'kb')
    expect(rows.map(row => row.id)).toEqual(['activity:before', 'message:human', 'activity:after'])
  })
  it('deduplicates live echoes and does not fold delivery failures', () => {
    const first = update('first')
    const rows = taskConversationRows([], [first, first, update('failed', { status: 'undelivered', createdAt: 2000 }), update('last', { createdAt: 3000 })], 'task', 'kb')
    expect(rows).toHaveLength(3)
    expect(rows[0].activities).toHaveLength(1)
    expect(rows[1].activities?.[0].status).toBe('undelivered')
  })
})

describe('shared decision visibility', () => {
  const decisionActivity = (id: string, patch: Partial<TeamActivity> = {}): TeamActivity => ({
    id, teamId: 'team', epochId: 'task', kind: 'decision', actorAppId: 'remote', targetAppId: null,
    subject: 'Approve?', body: 'Approve the deployment?', refId: 'entry-1', correlationId: null,
    status: 'escalation', createdAt: 2000, ...patch,
  })

  it('pairs the shared request and answer for the selected member', () => {
    const request = decisionActivity('request')
    const answer = decisionActivity('answer', { status: 'ok', body: 'Approved', createdAt: 3000 })
    expect(sharedTaskDecisions([request, answer], 'task', 'remote')).toEqual([{
      refId: 'entry-1', appId: 'remote', question: 'Approve the deployment?', requestedAt: 2000,
      answer: 'Approved', answeredAt: 3000,
    }])
    expect(taskConversationRows([], [request, answer], 'task', 'remote')[0].sharedDecision?.answer).toBe('Approved')
  })

  it('does not duplicate a shared decision that has a local actionable entry', () => {
    const local: ActivityEntry = { id: 'entry-1', appId: 'remote', runId: 'run', type: 'escalation', ts: 2000, content: { summary: 'Approve?' } }
    const rows = taskConversationRows([], [decisionActivity('request')], 'task', 'remote', [local])
    expect(rows.map(row => row.id)).toEqual(['decision:entry-1'])
  })
})


it('does not infer system provenance from a human message body', () => {
  const { metadata, ...plain } = received
  expect(conversationMessages([{ ...plain, content: '[System] Turn-end report.' }])).toHaveLength(1)
  expect(conversationMessages([{ ...received, metadata: { teamTriggerKind: 'member_stopped' } }])).toEqual([])
})

it('keeps invalid-date reports without fabricating dates or breaking ordering', () => {
  const reports = ['', 'invalid', '2026-09-15T12:00:00Z'].map((timestamp, index) => ({ appId: 'kb', message: { ...received, id: String(index), role: 'assistant' as const, timestamp } }))
  const rows = taskActivityRows(reports, [{ ...activity, createdAt: Number.POSITIVE_INFINITY }])
  expect(rows).toHaveLength(4)
  expect(rows[0].message?.id).toBe('2')
  expect(rows.slice(1).every(row => row.at === null)).toBe(true)
})

it('shows newest activity groups first while preserving request and reply order inside them', () => {
  const beforeMidnight = Date.parse('2026-09-14T23:59:00Z')
  const afterMidnight = Date.parse('2026-09-15T00:01:00Z')
  const rows = taskActivityRows([], [
    { ...activity, id: 'request', createdAt: beforeMidnight },
    { ...activity, id: 'response', actorAppId: 'kb', targetAppId: 'lead', createdAt: afterMidnight },
    { ...activity, id: 'summary', kind: 'run_end', createdAt: afterMidnight + 1000 },
    { ...activity, id: 'unknown', kind: 'finding', createdAt: NaN },
  ])
  expect(rows.map(row => row.id)).toEqual(['summary', 'request', 'unknown'])
  expect(rows[1].at).toBe(afterMidnight)
  expect(rows[1].activities?.map(item => item.id)).toEqual(['request', 'response'])
})


it('validates timestamps across message and board date representations', () => {
  for (const value of [undefined, null, '', 'bad date', NaN, Infinity, 8640000000000001]) expect(taskTime(value)).toBeNull()
  expect(taskTime(0)).toBe(0)
  expect(taskTime('2026-09-15T12:00:00.000Z')).toBe(Date.UTC(2026, 8, 15, 12))
})


describe('conversation audience across agent turns', () => {
  const human = { ...received, id: 'human-request', content: 'Ask WeOA what to eat', metadata: { teamTriggerKind: 'human_message' } }
  const reply = { ...received, id: 'reply', content: 'Received', metadata: { teamTriggerKind: 'message' } }
  const result = { ...reply, id: 'result', role: 'assistant' as const, content: 'WeOA replied. Verification passed.' }
  const notice = { ...received, id: 'notice', content: '[System] Actual notice received by Lead', metadata: { teamTriggerKind: 'member_stopped' } }

  it('keeps the human conversation audience when a teammate resumes it', () => {
    const messages = [human, reply, result]
    expect(conversationMessages(messages).map(message => message.id)).toEqual(['human-request', 'result'])
    expect(isTeamBackgroundTurn(messages)).toBe(false)
    expect(taskReportMessages(messages)).toEqual([])
  })

  it('keeps an AI-started member conversation internal', () => {
    expect(conversationMessages([reply, result])).toEqual([])
    expect(isTeamBackgroundTurn([reply, result])).toBe(true)
    expect(isTeamBackgroundTurn([])).toBe(true)
    expect(taskReportMessages([reply, result])).toEqual([result])
  })

  it('does not backfill old internal results when a person starts talking', () => {
    const later = { ...result, id: 'later' }
    const messages = [reply, result, human, reply, later]
    expect(conversationMessages(messages).map(message => message.id)).toEqual(['human-request', 'later'])
    expect(taskReportMessages(messages)).toEqual([result])
  })

  it('preserves actual system inputs in activity without duplicating the human-facing result', () => {
    const messages = [human, notice, result]
    expect(conversationMessages(messages)).toEqual([human, result])
    expect(taskReportMessages(messages)).toEqual([notice])
    expect(taskActivityRows([{ appId: 'lead', message: notice }], [])[0].notifications).toEqual([{ appId: 'lead', message: notice }])
  })

  it('keeps system-triggered results internal when no human started the conversation', () => {
    expect(conversationMessages([notice, result])).toEqual([])
    expect(taskReportMessages([notice, result])).toEqual([notice, result])
  })

  it('groups consecutive notifications without crossing member boundaries or other records', () => {
    const second = { ...notice, id: 'notice-2', timestamp: new Date(2000).toISOString() }
    const records = [{ appId: 'lead', message: notice }, { appId: 'lead', message: second }]
    expect(taskActivityRows(records, [])[0].notifications).toHaveLength(2)
    expect(taskActivityRows([records[0], { ...records[1], appId: 'kb' }], [])).toHaveLength(2)
    expect(taskActivityRows(records, [{ ...activity, createdAt: 1500 }])).toHaveLength(3)
  })
})

it('bounds each expandable activity group during a long message burst', () => {
  const events = Array.from({ length: 1200 }, (_, i) => ({ ...activity, id: `burst-${i}`, createdAt: 1000 + i }))
  const rows = taskActivityRows([], events)
  expect(rows.flatMap(row => row.activities ?? [])).toHaveLength(1200)
  expect(rows.every(row => (row.activities?.length ?? 0) <= 20)).toBe(true)
})

describe('conversation labels', () => {
  const label = (kind: TeamConversation['kind']) => conversationLabel(task({ kind, label: '' }), key => key)

  it('names a collaboration room as one, never as a direct message', () => {
    expect(label('collab')).toBe('Collaboration')
    expect(label('native')).toBe('New session')
    expect(label('member')).toBe('Direct message')
  })

  it('keeps the proper name a room arrives with', () => {
    expect(conversationLabel(task({ kind: 'collab', label: 'Research crew' }), key => key)).toBe('Research crew')
  })
})
