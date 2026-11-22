import { taskTime } from '../../../src/renderer/components/team/workbench/time'
import { executionTurns } from '../../../src/renderer/components/team/workbench/model'
import { failureCause, progressSummary, taskProgress } from '../../../src/renderer/components/team/workbench/progress'
import { failureFix } from '../../../src/renderer/components/team/workbench/progress-labels'
import { describe, expect, it } from 'vitest'
import { taskConversationRows, COLLABORATION_PREVIEW_LIMIT, conversationMessages, activityLevel, taskGroup, visibleTasks, taskActivityRows, filterTaskActivityRows, taskReportMessages, isTeamBackgroundTurn, decisionMessageId, sharedTaskDecisions, taskParticipants, reportGaps } from '../../../src/renderer/components/team/workbench/model'
import { undeliveredParties } from '../../../src/shared/apps/team-failures'
import { conversationLabel } from '../../../src/renderer/components/team/run-history'
import { isTeamWork, liveTaskCount, memberState, settingsFailure, sortByState, taskState } from '../../../src/renderer/components/team/detail/status'
import type { TeamConversation, TeamActivity, TeamDetail, RosterMember, BlackboardTask, BlackboardFinding } from '../../../src/shared/apps/team-types'
import type { ActivityEntry } from '../../../src/shared/apps/app-types'
const task = (patch: Partial<TeamConversation> = {}): TeamConversation => ({ epochId: 'task', teamId: 'team', kind: 'native', label: 'Task', readonly: false, startedAt: 1, lastActivityAt: 1, ...patch })
describe('task detail status projection', () => {
  const detail = { team: { id: 'team' }, roster: [], activities: [] } as unknown as TeamDetail
  const member = (patch: Partial<RosterMember> = {}): RosterMember => ({ appId: 'a', memberName: 'Ana', role: 'Writer', isLead: false, spaceId: null, status: 'idle', ...patch })
  it('puts a decision waiting for the user above completion and live work', () => {
    expect(taskState(detail, task({ waitingForMe: true, completed: true })).key).toBe('waiting_user')
    expect(taskState(detail, task({ waitingForMe: true })).key).toBe('waiting_user')
    expect(taskState(detail, task({ completed: true })).key).toBe('done')
    expect(taskState(detail, task({ active: true })).key).toBe('running')
  })
  it('counts a local pending decision even before the task row says so', () => {
    const withDecision = { ...detail, pendingEscalations: [{ entryId: 'e', appId: 'a', memberName: 'Ana', question: 'Ship it?', epochId: 'task' }] } as never
    const state = taskState(withDecision, task({ completed: true }))
    expect(state.key).toBe('waiting_user')
    expect(state.fact).toEqual({ kind: 'decision', memberName: 'Ana', question: 'Ship it?' })
  })
  it('reports a member error on the task it is busy with', () => {
    const failing = { ...detail, roster: [member({ status: 'error', busy: [{ epochId: 'task', label: 'Draft', kind: 'conversation' }] })] } as never
    expect(taskState(failing, task({ active: true })).key).toBe('error')
  })
  it('reports the failure the task list read from the whole record, once nobody is on the task', () => {
    const failure = { appId: 'a', activityId: 'lost', senderAppId: 'lead' }
    const withMember = { ...detail, roster: [member()] } as never
    const state = taskState(withMember, task({ failure }))
    expect(state.key).toBe('error')
    expect(state.fact).toEqual({ kind: 'error', memberName: 'Ana', failure })
    expect(taskState(withMember, task({ failure, active: true })).key).toBe('running')
  })
  it('names the member whose model settings the user can change to restart a stopped task', () => {
    const roster = [member(), member({ appId: 'b', owner: 'Bo', sameMachine: false })]
    const withMembers = { ...detail, roster } as never
    const stopped = (appId: string, reason: string, patch: Partial<TeamConversation> = {}) => task({ failure: { appId, activityId: 'x', reason }, ...patch })
    expect(settingsFailure(withMembers, stopped('a', 'model_not_found'))).toEqual({ member: roster[0], cause: 'model' })
    expect(settingsFailure(withMembers, stopped('a', 'HTTP 429 rate limit'))?.cause).toBe('quota')
    expect(settingsFailure(withMembers, stopped('a', 'ECONNRESET'))).toBeNull()
    expect(settingsFailure(withMembers, stopped('b', 'model_not_found'))).toBeNull()
    expect(settingsFailure(withMembers, stopped('a', 'model_not_found', { active: true }))).toBeNull()
    expect(settingsFailure(withMembers, task({ failure: { appId: 'a', activityId: 'x', senderAppId: 'lead' } }))).toBeNull()
  })
  it('does not infer a stuck state from silence', () => {
    expect(taskState(detail, task()).key).toBe('idle')
  })
  it('settles work nobody is on by its board', () => {
    expect(taskState(detail, task({ subtasks: { done: 2, open: 0 } })).key).toBe('done')
    expect(taskState(detail, task({ subtasks: { done: 1, open: 1 } })).key).toBe('idle')
    expect(taskState(detail, task({ active: true, subtasks: { done: 2, open: 0 } })).key).toBe('running')
  })
  it('tells team work from a question the lead simply answered', () => {
    expect(isTeamWork(task())).toBe(false)
    for (const patch of [{ subtasks: { done: 0, open: 1 } }, { teamwork: true }, { artifactCount: 1 }, { kind: 'run' as const }]) expect(isTeamWork(task(patch))).toBe(true)
  })
  it('orders tasks by need, then by recency', () => {
    const rows = [task({ epochId: 'done', completed: true, lastActivityAt: 9 }), task({ epochId: 'old', lastActivityAt: 1 }), task({ epochId: 'ask', waitingForMe: true, lastActivityAt: 0 }), task({ epochId: 'new', lastActivityAt: 5 })]
    expect(sortByState(detail, rows).map(row => row.epochId)).toEqual(['ask', 'new', 'old', 'done'])
  })
  it('lets offline outrank any stale member status', () => {
    expect(memberState(detail, member({ presence: 'offline', status: 'error' }))).toBe('offline')
    expect(memberState(detail, member({ busy: [{ epochId: 'task', label: 'Draft', kind: 'conversation' }] }))).toBe('working')
    expect(memberState(detail, member())).toBe('idle')
  })
  it('counts each live task once, however many members are on it, and ignores work outside the listed tasks', () => {
    const busy = (...ids: string[]) => ids.map(epochId => ({ epochId, label: '', kind: 'conversation' as const }))
    const roster = [member({ appId: 'a', busy: busy('t1', 't2') }), member({ appId: 'b', busy: busy('t1') }), member({ appId: 'c', busy: busy('elsewhere') }), member({ appId: 'd' })]
    const rows = ['t1', 't2', 't3'].map(epochId => task({ epochId, teamwork: true }))
    expect(liveTaskCount({ ...detail, roster } as never, rows)).toBe(2)
    expect(liveTaskCount({ ...detail, roster } as never, [task({ epochId: 't1' })])).toBe(0)
  })
  it('does not count work held up on the user as running', () => {
    expect(liveTaskCount(detail, [task({ teamwork: true, active: true, waitingForMe: true }), task({ epochId: 't2', teamwork: true, active: true })])).toBe(1)
  })
})

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
it('records one execution for messages delivered together and for messages read while it ran', () => {
  const team = (id: string, inputMode?: 'live') => ({ ...received, id, role: 'system' as const, source: 'team-message' as const, metadata: { teamId: 'team', teamTriggerKind: 'message', ...(inputMode ? { inputMode } : {}) } })
  const output = (id: string) => ({ ...received, id, role: 'assistant' as const })
  const turns = executionTurns([team('t1'), team('t2'), team('t3'), output('r1'), team('t4', 'live'), output('r2'), team('t5'), output('r3')])
  expect(turns.map(turn => [turn.id, turn.inputs.map(input => input.id), turn.outputs.map(message => message.id)])).toEqual([
    ['t5', ['t5'], ['r3']],
    ['t1', ['t1', 't2', 't3', 't4'], ['r1', 'r2']],
  ])
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
  it('draws what a member received right before its reply on that reply, and keeps the rest as a segment', () => {
    const human = { ...received, id: 'human', role: 'user' as const, content: 'Hello', timestamp: new Date(500).toISOString(), metadata: { teamTriggerKind: 'human_message' } }
    const reply = { id: 'reply', role: 'assistant' as const, content: 'Done', timestamp: new Date(4000).toISOString() }
    const events = [
      update('report', { actorAppId: 'writer', targetAppId: 'kb', createdAt: 1000 }),
      update('failed', { actorAppId: 'writer', targetAppId: 'kb', status: 'undelivered', createdAt: 1500 }),
      update('ask', { actorAppId: 'kb', targetAppId: 'writer', createdAt: 2000 }),
    ]
    const rows = taskConversationRows([human, reply] as never, events, 'task', 'kb')
    expect(rows.map(row => row.id)).toEqual(['message:human', 'activity:failed', 'activity:ask', 'message:reply'])
    expect((rows[rows.length - 1] as { openers?: TeamActivity[] }).openers?.map(row => row.id)).toEqual(['report'])
    expect(rows.flatMap(row => row.activities ?? []).map(row => row.id)).toEqual(['failed', 'ask'])
  })
  it('deduplicates live echoes and does not fold delivery failures', () => {
    const first = update('first')
    const rows = taskConversationRows([], [first, first, update('failed', { status: 'undelivered', createdAt: 2000 }), update('last', { createdAt: 3000 })], 'task', 'kb')
    expect(rows).toHaveLength(3)
    expect(rows[0].activities).toHaveLength(1)
    expect(rows[1].activities?.[0].status).toBe('undelivered')
  })
  it('on the homepage, hangs a reply\'s hand-offs under it and leaves failures to the conversation bar', () => {
    const human = { ...received, id: 'human', content: 'Go', timestamp: new Date(500).toISOString(), metadata: { teamTriggerKind: 'human_message' } }
    const reply = { id: 'reply', role: 'assistant' as const, content: 'On it', timestamp: new Date(600).toISOString() }
    const events = [
      update('to-writer', { actorAppId: 'kb', targetAppId: 'writer', createdAt: 1000 }),
      update('lost', { actorAppId: 'kb', targetAppId: 'analyst', status: 'undelivered', createdAt: 1100 }),
      update('to-analyst', { actorAppId: 'kb', targetAppId: 'analyst', createdAt: 1200 }),
      update('back', { actorAppId: 'writer', targetAppId: 'kb', createdAt: 1300 }),
    ]
    const compact = taskConversationRows([human, reply] as never, events, 'task', 'kb', [], { compact: true })
    expect(compact.map(row => row.id)).toEqual(['message:human', 'message:reply', 'activity:to-writer'])
    expect((compact[1] as { dispatches?: TeamActivity[] }).dispatches?.map(row => row.id)).toEqual(['to-writer', 'to-analyst'])
    expect(compact[2].activities?.map(row => row.id)).toEqual(['back'])
    const full = taskConversationRows([human, reply] as never, events, 'task', 'kb')
    expect(full.some(row => (row as { dispatches?: TeamActivity[] }).dispatches)).toBe(false)
    expect(full.flatMap(row => row.activities ?? []).map(row => row.id)).toContain('lost')
  })
  it('on the homepage, hangs a hand-off sent mid-turn under that turn\'s reply, not the one before', () => {
    const human = { ...received, id: 'human', content: 'Who are you?', timestamp: new Date(500).toISOString(), metadata: { teamTriggerKind: 'human_message' } }
    const intro = { id: 'intro', role: 'assistant' as const, content: 'Tell me when to start', timestamp: new Date(600).toISOString() }
    const accepted = { id: 'accepted', role: 'assistant' as const, content: 'Accepted, writer drafts next', timestamp: new Date(3000).toISOString() }
    const events = [
      update('report', { actorAppId: 'analyst', targetAppId: 'kb', createdAt: 1000 }),
      update('to-writer', { actorAppId: 'kb', targetAppId: 'writer', createdAt: 2000 }),
    ]
    const compact = taskConversationRows([human, intro, accepted] as never, events, 'task', 'kb', [], { compact: true })
    expect(compact.map(row => row.id)).toEqual(['message:human', 'message:intro', 'message:accepted'])
    expect((compact[1] as { dispatches?: TeamActivity[] }).dispatches).toBeUndefined()
    expect((compact[2] as { openers?: TeamActivity[] }).openers?.map(row => row.id)).toEqual(['report'])
    expect((compact[2] as { dispatches?: TeamActivity[] }).dispatches?.map(row => row.id)).toEqual(['to-writer'])
  })
  it('on the homepage, does not name a message on the reply\'s sender line that its work already shows', () => {
    const human = { ...received, id: 'human', content: 'Go', timestamp: new Date(500).toISOString(), metadata: { teamTriggerKind: 'human_message' } }
    const arrival = { id: 'arrived', role: 'system' as const, source: 'team-message' as const, content: 'Draft ready', timestamp: new Date(1000).toISOString(), metadata: { teamId: 'team', fromMemberName: 'Writer', inputMode: 'live' as const, inputReplyId: 'reply', correlationId: 'mid-turn' } }
    const reply = { id: 'reply', role: 'assistant' as const, content: 'Done', timestamp: new Date(3000).toISOString() }
    const events = [
      update('mid-turn', { actorAppId: 'writer', targetAppId: 'kb', correlationId: 'mid-turn', createdAt: 1000 }),
      update('before', { actorAppId: 'analyst', targetAppId: 'kb', correlationId: 'earlier', createdAt: 800 }),
    ]
    const compact = taskConversationRows([human, reply, arrival] as never, events, 'task', 'kb', [], { compact: true })
    expect((compact[compact.length - 1] as { openers?: TeamActivity[] }).openers?.map(row => row.id)).toEqual(['before'])
    const full = taskConversationRows([human, reply, arrival] as never, events, 'task', 'kb')
    expect((full[full.length - 1] as { openers?: TeamActivity[] }).openers?.map(row => row.id)).toEqual(['before', 'mid-turn'])
  })
  it('on the homepage, shows replies to teammates as dialogue before the user ever writes', () => {
    const reply = { ...received, id: 'reply', role: 'assistant' as const, content: 'Found 29 items', timestamp: new Date(3000).toISOString() }
    const nudge = { ...received, id: 'nudge-reply', role: 'assistant' as const, content: 'Still working', timestamp: new Date(5000).toISOString(), metadata: { teamTriggerKind: 'periodic_check' } }
    const events = [
      update('ask', { actorAppId: 'lead', targetAppId: 'kb', createdAt: 1000 }),
      update('report', { actorAppId: 'kb', targetAppId: 'lead', createdAt: 4000 }),
    ]
    const compact = taskConversationRows([received, reply, nudge] as never, events, 'task', 'kb', [], { compact: true })
    expect(compact.map(row => row.id)).toEqual(['message:reply'])
    expect((compact[0] as { openers?: TeamActivity[] }).openers?.map(row => row.id)).toEqual(['ask'])
    expect((compact[0] as { dispatches?: TeamActivity[] }).dispatches?.map(row => row.id)).toEqual(['report'])
    const full = taskConversationRows([received, reply, nudge] as never, events, 'task', 'kb')
    expect(full.some(row => row.message)).toBe(false)
  })
  it('on the homepage, shows a reply to a teammate turn-end report as dialogue', () => {
    const stopped = { ...received, id: 'stopped', content: '[System] Analyst finished', timestamp: new Date(2000).toISOString(), metadata: { teamTriggerKind: 'member_stopped' } }
    const reply = { ...stopped, id: 'reply', role: 'assistant' as const, content: 'Analysis received, drafting now', timestamp: new Date(3000).toISOString() }
    const events = [
      update('analysis', { actorAppId: 'analyst', targetAppId: 'lead', createdAt: 1000 }),
      update('to-writer', { actorAppId: 'lead', targetAppId: 'writer', createdAt: 4000 }),
    ]
    const compact = taskConversationRows([stopped, reply] as never, events, 'task', 'lead', [], { compact: true })
    expect(compact.map(row => row.id)).toEqual(['message:reply'])
    expect((compact[0] as { openers?: TeamActivity[] }).openers?.map(row => row.id)).toEqual(['analysis'])
    expect((compact[0] as { dispatches?: TeamActivity[] }).dispatches?.map(row => row.id)).toEqual(['to-writer'])
  })
})

describe('conversation progress', () => {
  const member = (appId: string, patch: Partial<RosterMember> = {}) => ({ appId, memberName: appId, ...patch }) as RosterMember
  const work = (id: string, assigneeAppId: string, status: BlackboardTask['status'], updatedAt = 1) => ({ id, title: id, assigneeAppId, createdByAppId: 'lead', status, updatedAt, epochId: 'task' }) as BlackboardTask
  const base = {
    epochId: 'task', leadAppId: 'lead', activities: [] as TeamActivity[], tasks: [] as BlackboardTask[], decisions: [], waitingAppIds: [] as string[], completed: false,
    roster: [member('lead'), member('writer'), member('analyst'), member('bystander')], participants: new Set(['lead', 'writer', 'analyst']),
  }
  it('puts what needs the user first, then work in flight, and only covers who took part', () => {
    const progress = taskProgress({
      ...base,
      roster: [member('lead'), member('writer', { busy: [{ epochId: 'task', label: 'Task', kind: 'native' } as never] }), member('analyst'), member('bystander')],
      tasks: [work('draft', 'writer', 'in_progress'), work('numbers', 'analyst', 'done'), work('review', 'analyst', 'pending')],
      decisions: [{ id: 'd1', appId: 'analyst', question: 'Use Q3 data?' }],
    })
    expect(progress.members.map(row => [row.appId, row.state])).toEqual([['analyst', 'waiting'], ['writer', 'working'], ['lead', 'idle']])
    expect(progress.members[0]).toMatchObject({ decisionId: 'd1', question: 'Use Q3 data?' })
    expect(progress.members[1].taskTitle).toBe('draft')
    expect(progress.counts).toMatchObject({ done: 1, in_progress: 1, pending: 1 })
    expect(progress.total).toBe(3)
  })
  it('shows a lost message until the recipient acts again, and a decision only its owner can answer', () => {
    const lost = { ...activity, id: 'lost', actorAppId: 'lead', targetAppId: 'writer', status: 'undelivered', createdAt: 1000 } as TeamActivity
    const failed = taskProgress({ ...base, activities: [lost], waitingAppIds: ['analyst'] })
    expect(failed.members.find(row => row.appId === 'writer')).toMatchObject({ state: 'failed', activityId: 'lost', senderAppId: 'lead' })
    expect(failed.members.find(row => row.appId === 'analyst')).toEqual({ appId: 'analyst', state: 'waiting' })
    const recovered = taskProgress({ ...base, activities: [lost, { ...activity, id: 'later', actorAppId: 'writer', targetAppId: 'lead', createdAt: 2000 } as TeamActivity] })
    expect(recovered.members.find(row => row.appId === 'writer')?.state).not.toBe('failed')
    const turn = taskProgress({ ...base, activities: [{ ...activity, id: 'turn', kind: 'reply', actorAppId: 'analyst', targetAppId: 'lead', status: 'error', createdAt: 1000 } as TeamActivity] })
    expect(turn.members.find(row => row.appId === 'analyst')).toEqual({ appId: 'analyst', state: 'failed', activityId: 'turn', reason: 'Investigate' })
  })
  it('keeps why a turn failed and tells what kind of trouble it was', () => {
    const failedTurn = (subject: string, status: TeamActivity['status'] = 'error') => taskProgress({ ...base, activities: [{ ...activity, id: 'turn', kind: 'reply', actorAppId: 'analyst', targetAppId: 'lead', status, subject, createdAt: 1000 } as TeamActivity] })
      .members.find(row => row.appId === 'analyst')!
    const model = failedTurn('The member\'s turn failed: Anthropic API error (400): The model or service ID de…')
    expect(model.reason).toBe('Anthropic API error (400): The model or service ID de…')
    expect(failureCause(model)).toBe('model')
    expect(failureCause(failedTurn('The member\'s turn failed: 401 invalid x-api-key'))).toBe('account')
    expect(failureCause(failedTurn('The member\'s turn failed: 429 rate_limit_error'))).toBe('quota')
    expect(failureCause(failedTurn('The member\'s turn failed: 529 overloaded_error'))).toBe('service')
    expect(failureCause(failedTurn('The member\'s turn failed: fetch failed'))).toBe('network')
    expect(failureCause(failedTurn('The member did not finish in time (timeout).', 'timeout'))).toBe('timeout')
    expect(failureCause(failedTurn('The member\'s turn failed: something odd'))).toBeNull()
  })
  it('says who has to fix a failed turn: you through its model settings, or its owner', () => {
    const t = ((key: string, vars?: Record<string, string>) => key.replace(/\{\{(\w+)\}\}/g, (_, name) => vars?.[name] ?? '')) as never
    const row = { appId: 'analyst', state: 'failed' as const, activityId: 'turn', reason: 'Anthropic API error (400): The model or service ID de…' }
    expect(failureFix(row, [member('analyst')], t)).toEqual({ text: 'Needs you', changeModel: true })
    expect(failureFix(row, [member('analyst', { owner: 'Lin', sameMachine: false })], t)).toEqual({ text: 'Lin needs to change its model settings' })
    expect(failureFix({ ...row, reason: 'something odd' }, [member('analyst', { owner: 'Lin', sameMachine: false })], t)).toEqual({ text: 'Lin needs to look into it' })
    expect(failureFix({ ...row, reason: 'fetch failed' }, [member('analyst', { owner: 'Lin', sameMachine: false })], t)).toEqual({})
    expect(failureFix({ ...row, senderAppId: 'lead' }, [member('analyst')], t)).toEqual({})
  })
  it('reads everyone as done once the conversation is completed', () => {
    const progress = taskProgress({ ...base, completed: true, tasks: [work('draft', 'writer', 'done')] })
    expect(progress.members.map(row => row.state)).toEqual(['done', 'done', 'done'])
    expect(progress.members.find(row => row.appId === 'writer')?.taskTitle).toBe('draft')
    expect(progress.finished).toBe(true)
  })
  it('reads the work as finished once every subtask is settled and nobody is still at it', () => {
    const settled = [work('draft', 'writer', 'done'), work('extra', 'analyst', 'rejected')]
    expect(taskProgress({ ...base, tasks: settled }).finished).toBe(true)
    expect(taskProgress({ ...base, tasks: [work('draft', 'writer', 'done'), work('review', 'analyst', 'pending')] }).finished).toBe(false)
    expect(taskProgress({ ...base, tasks: [work('extra', 'analyst', 'rejected')] }).finished).toBe(false)
    expect(taskProgress({ ...base }).finished).toBe(false)
    const leadBusy = [member('lead', { busy: [{ epochId: 'task', label: 'Task', kind: 'native' } as never] }), member('writer'), member('analyst')]
    expect(taskProgress({ ...base, roster: leadBusy, tasks: settled }).finished).toBe(false)
    expect(taskProgress({ ...base, tasks: settled, waitingAppIds: ['analyst'] }).finished).toBe(false)
  })
  it('sums up the most pressing state as a count, leaving the lead\'s own work to the stream', () => {
    const counts = { done: 0, in_progress: 0, blocked: 0, pending: 0, rejected: 0 }
    const of = (...members: Parameters<typeof progressSummary>[0]['members']) => progressSummary({ members, counts, total: 0, finished: false }, 'lead')
    expect(of({ appId: 'a', state: 'failed' }, { appId: 'b', state: 'waiting', decisionId: 'd' }, { appId: 'c', state: 'waiting', decisionId: 'e' })).toEqual({ kind: 'waiting', count: 2 })
    expect(of({ appId: 'a', state: 'failed' }, { appId: 'b', state: 'waiting' })).toEqual({ kind: 'failed', count: 1 })
    expect(of({ appId: 'b', state: 'waiting' }, { appId: 'c', state: 'working' })).toEqual({ kind: 'decision', count: 1 })
    expect(of({ appId: 'lead', state: 'working' })).toEqual({ kind: 'idle' })
    expect(progressSummary({ members: [], counts, total: 0, finished: true }, 'lead')).toEqual({ kind: 'done' })
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
    expect(taskConversationRows([], [request, answer], 'task', 'remote', [], { sharedDecisions: false })).toEqual([])
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

it('shows each activity as its own record, newest first', () => {
  const beforeMidnight = Date.parse('2026-09-14T23:59:00Z')
  const afterMidnight = Date.parse('2026-09-15T00:01:00Z')
  const rows = taskActivityRows([], [
    { ...activity, id: 'request', createdAt: beforeMidnight },
    { ...activity, id: 'response', actorAppId: 'kb', targetAppId: 'lead', createdAt: afterMidnight },
    { ...activity, id: 'summary', kind: 'run_end', createdAt: afterMidnight + 1000 },
    { ...activity, id: 'unknown', kind: 'finding', createdAt: NaN },
  ])
  expect(rows.map(row => row.id)).toEqual(['summary', 'response', 'request', 'unknown'])
  expect(rows.every(row => row.activities?.length === 1)).toBe(true)
})


it('filters records by kind', () => {
  const report = { appId: 'kb', message: { ...received, id: 'report', role: 'assistant' as const, metadata: {} } }
  const failedReport = { appId: 'writer', message: { ...received, id: 'failed-report', role: 'assistant' as const, metadata: {}, error: 'crashed' } }
  const rows = taskActivityRows([report, failedReport], [
    activity,
    { ...activity, id: 'output', kind: 'finding', actorAppId: 'writer', targetAppId: null },
    { ...activity, id: 'summary', kind: 'run_end', actorAppId: 'lead', targetAppId: null },
    { ...activity, id: 'decision', kind: 'decision', actorAppId: 'kb', targetAppId: null, status: 'escalation' },
    { ...activity, id: 'lost', actorAppId: 'writer', targetAppId: 'kb', status: 'undelivered' },
  ])
  const ids = (kind: Parameters<typeof filterTaskActivityRows>[1]) => filterTaskActivityRows(rows, kind).map(row => row.activities?.[0]?.id ?? row.message?.id).sort()
  expect(filterTaskActivityRows(rows, null)).toBe(rows)
  expect(ids('output')).toEqual(['output', 'summary'])
  expect(ids('decision')).toEqual(['decision'])
  expect(ids('failed')).toEqual(['failed-report', 'lost'])
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
    expect(taskActivityRows([{ appId: 'lead', message: notice }], [])[0]).toMatchObject({ appId: 'lead', message: notice, notice: true })
  })

  it('keeps system-triggered results internal when no human started the conversation', () => {
    expect(conversationMessages([notice, result])).toEqual([])
    expect(taskReportMessages([notice, result])).toEqual([notice, result])
  })

  it('shows each notification as its own record', () => {
    const second = { ...notice, id: 'notice-2', timestamp: new Date(2000).toISOString() }
    const rows = taskActivityRows([{ appId: 'lead', message: notice }, { appId: 'lead', message: second }], [])
    expect(rows.map(row => row.message?.id)).toEqual(['notice-2', 'notice'])
    expect(rows.every(row => row.notice)).toBe(true)
  })
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

it('keeps source-marked team inputs and system notifications in their existing execution/report projections', () => {
  const source = { ...received, role: 'system' as const, source: 'team-message' as const, content: 'Original report',
    metadata: { teamId: 'team', teamName: 'Review', fromMemberName: 'Reviewer', teamTriggerKind: 'message' } }
  const notice = { ...source, id: 'notice', content: 'Periodic check', metadata: { ...source.metadata, teamTriggerKind: 'periodic_check' } }
  const result = { ...source, id: 'output', role: 'assistant' as const, source: undefined, content: 'Result' }
  expect(executionTurns([source, result])[0]).toMatchObject({ input: source, outputs: [result] })
  expect(taskReportMessages([source, result, notice]).map(message => message.id)).toEqual(['output', 'notice'])
  expect(conversationMessages([source, result, notice])).toEqual([])
  expect(isTeamBackgroundTurn([source, notice])).toBe(true)
  const human = { ...received, id: 'owner', content: 'My question', metadata: { teamTriggerKind: 'human_message' } }
  expect(conversationMessages([source, notice, human, result]).map(message => message.id)).toEqual(['owner', 'output'])
})

describe('the owner’s additions to a member’s running work, read back', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 9, 13, 10, 0, second)).toISOString()
  const teammate = { id: 'teammate', role: 'system' as const, source: 'team-message' as const, content: 'Please review', timestamp: at(1),
    metadata: { teamId: 'team', teamName: 'Review', fromMemberName: 'Lead', teamTriggerKind: 'message' } }
  const human = { id: 'human', role: 'user' as const, content: 'Review the PR', timestamp: at(1), metadata: { teamTriggerKind: 'human_message' } }
  const first = { id: 'first', role: 'assistant' as const, content: 'Reading', timestamp: at(2) }
  const addition = { id: 'addition', role: 'user' as const, source: 'injection' as const, content: 'Also check the tests', timestamp: at(3) }
  const second = { id: 'second', role: 'assistant' as const, content: 'Done', timestamp: at(4) }

  it('sit on the reply they joined, as in the chat, and never become a message row', () => {
    const rows = taskConversationRows([human, first, addition, second], [], 'task', 'kb')
    expect(rows.map(row => row.message?.id ?? row.additions?.map(message => message.id))).toEqual(['human', 'first', 'second'])
  })

  it('keep a background turn background, shown on their own where they were sent, as during the turn', () => {
    const messages = [teammate, first, addition, second]
    expect(isTeamBackgroundTurn(messages)).toBe(true)
    expect(conversationMessages(messages)).toEqual([])
    expect(taskReportMessages(messages).map(message => message.id)).toEqual(['first', 'second'])
    const rows = taskConversationRows(messages, [], 'task', 'kb')
    expect(rows).toEqual([{ id: 'addition:addition', additions: [addition] }])
  })

  it('stand on their own, together, when no shown reply carries them', () => {
    const another = { ...addition, id: 'another' }
    const reply = { ...first, timestamp: at(5) }
    const rows = taskConversationRows([human, addition, another, reply], [], 'task', 'kb')
    expect(rows.map(row => row.message?.id ?? row.additions?.map(message => message.id))).toEqual(['human', ['addition', 'another'], 'first'])
  })
})

describe('a message that did not arrive', () => {
  const failed = (patch: Partial<TeamActivity>): TeamActivity => ({ id: 'fate', teamId: 'team', epochId: 'task', kind: 'reply', actorAppId: 'design',
    targetAppId: 'requirements', subject: 'The message was not delivered', body: null, refId: null, correlationId: 'c-1', status: 'undelivered', createdAt: 1000, ...patch })

  it('reads a failed fate as the message it was, from its sender to the member it never reached', () => {
    expect(undeliveredParties(failed({}))).toEqual({ senderAppId: 'requirements', recipientAppId: 'design' })
    expect(undeliveredParties(failed({ kind: 'message', actorAppId: 'requirements', targetAppId: 'design' })))
      .toEqual({ senderAppId: 'requirements', recipientAppId: 'design' })
    expect(undeliveredParties(failed({ status: 'timeout' }))).toBeNull()
  })
})

describe('reports that cannot be read', () => {
  const member = (appId: string, patch: Partial<RosterMember> = {}): RosterMember => ({ appId, memberName: appId, role: '', isLead: false, spaceId: null, status: 'idle', sameMachine: true, presence: 'online', ...patch })
  const roster = [
    member('design'),
    member('requirements', { sameMachine: false, owner: 'Jane', presence: 'online' }),
    member('security', { sameMachine: false, owner: 'Jie', presence: 'offline' }),
    member('sonar', { sameMachine: false, owner: 'Jie', presence: 'offline' }),
    member('pm', { sameMachine: false, owner: 'Mo', presence: 'offline' }),
    member('tester', { sameMachine: false, owner: 'Harper', presence: 'offline' }),
  ]

  it('counts a member as taking part only on a trace it left in this task', () => {
    const ids = taskParticipants({
      epochId: 'task',
      activities: [{ actorAppId: 'requirements', targetAppId: 'design' } as TeamActivity],
      tasks: [{ createdByAppId: 'lead', assigneeAppId: 'tester' } as BlackboardTask],
      findings: [{ authorAppId: 'writer' } as BlackboardFinding],
      roster: [member('busy', { busy: [{ epochId: 'task', label: 'Task', kind: 'conversation' }] }), member('elsewhere', { busy: [{ epochId: 'other', label: 'Other', kind: 'conversation' }] })],
      reports: [{ appId: 'reporter', message: { id: 'm', role: 'assistant', content: 'done', timestamp: '' } }],
      memberAppIds: ['deciding'],
    })
    expect([...ids].sort()).toEqual(['busy', 'deciding', 'design', 'lead', 'reporter', 'requirements', 'tester', 'writer'])
  })

  it('warns about members of the task, by whose computer is offline, and only names uninvolved offline computers', () => {
    const gaps = reportGaps(['security', 'sonar', 'pm', 'tester'], roster, new Set(['design', 'requirements', 'tester']))
    expect(gaps).toEqual({ offline: [{ owner: 'Harper', members: ['tester'] }], failed: [], elsewhere: ['Jie', 'Mo'] })
  })

  it('never lowers a failure while the computer is reachable, involved or not', () => {
    const gaps = reportGaps(['design', 'requirements'], roster, new Set())
    expect(gaps).toEqual({ offline: [], failed: ['design', 'requirements'], elsewhere: [] })
  })
})
