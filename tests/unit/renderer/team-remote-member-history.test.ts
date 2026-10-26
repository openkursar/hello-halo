import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SerializedHistoryMessage } from '../../../src/main/apps/runtime/federation/protocol-m2'
import type { LiveInput, Message } from '../../../src/renderer/types'

const env = vi.hoisted(() => ({ teamChatMessages: vi.fn() }))
vi.mock('../../../src/renderer/api', () => ({ api: { teamChatMessages: env.teamChatMessages } }))

const { loadTeamSessionHistory, mergeTeamSessionHistory, retainTeamSessionHistory } = await import('../../../src/renderer/components/team/session-history')
const { mergeArrivingMessages, withoutLiveInputs, withStoppedInputs } = await import('../../../src/renderer/utils/live-inputs')
const { executionTurns, taskActivityRows, taskConversationRows, taskReportMessages } = await import('../../../src/renderer/components/team/workbench/model')

// Rows exactly as a member's owner on another computer serializes them.
const wire = (seq: number, role: string, content: string): SerializedHistoryMessage => ({ seq, role, content, ts: Date.parse('2026-10-20T09:00:00.000Z') + seq })
const remoteTranscript = [
  wire(1, 'user', 'Draft the plan'),
  wire(2, 'assistant', 'Plan drafted'),
  wire(3, 'user', 'Add the rollout section'),
  wire(4, 'assistant', 'Rollout added'),
]
// A record as the owner announces it when it reaches the member mid-turn.
const arrival: Message = {
  id: 'session-msg-12', role: 'system', source: 'team-message', content: 'Lead: also cover rollback',
  timestamp: '2026-10-20T09:05:00.000Z', metadata: { fromMemberName: 'Lead' },
}

let scope = 0
async function openRemoteMember(rows: SerializedHistoryMessage[] = remoteTranscript) {
  const epochId = `epoch-${++scope}`
  retainTeamSessionHistory('remote-member', 'space', 'team', epochId)
  env.teamChatMessages.mockResolvedValueOnce({ success: true, data: rows })
  const result = await loadTeamSessionHistory('remote-member', 'space', 'team', epochId)
  return { epochId, messages: result.data as Message[] }
}

beforeEach(() => env.teamChatMessages.mockReset())

describe('a team member running on another computer', () => {
  it('takes a message that arrives while its conversation is open', async () => {
    const { messages } = await openRemoteMember()
    const merged = mergeArrivingMessages(messages, [arrival])
    expect(merged.map(message => message.content)).toEqual([...remoteTranscript.map(row => row.content), arrival.content])
    expect(mergeArrivingMessages(merged, [arrival])).toHaveLength(merged.length)
  })

  it('reads its history alongside a stop and the live overlay', async () => {
    const { messages } = await openRemoteMember()
    expect(withStoppedInputs(messages, [arrival]).at(-1)).toMatchObject({ id: arrival.id, clientKey: arrival.id })
    const live: LiveInput[] = [{ message: arrival, textBlockVersion: 1, textOffset: 0 }]
    expect(withoutLiveInputs(messages, live)).toEqual(messages)
  })

  it('gives every row its own id, kept across a tail read and never one its owner could assign', async () => {
    const { epochId, messages } = await openRemoteMember()
    const ids = messages.map(message => message.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toEqual(expect.any(String))
      expect(id).not.toMatch(/^(session-msg-|pending-)/)
    }

    env.teamChatMessages.mockResolvedValueOnce({ success: true, data: [wire(4, 'assistant', 'Rollout added, with dates'), wire(5, 'user', 'Ship it')] })
    const tail = (await loadTeamSessionHistory('remote-member', 'space', 'team', epochId)).data as Message[]
    expect(env.teamChatMessages).toHaveBeenLastCalledWith('remote-member', 'space', 'team', epochId, 3)
    expect(tail.slice(0, 4).map(message => message.id)).toEqual(ids)
    expect(tail[3].content).toBe('Rollout added, with dates')
    expect(new Set(tail.map(message => message.id)).size).toBe(5)
  })

  it('keeps each execution record and report apart', async () => {
    const { messages } = await openRemoteMember()
    const turns = executionTurns(messages)
    expect(new Set(turns.map(turn => turn.id)).size).toBe(2)
    const rows = taskActivityRows(messages.map(message => ({ appId: 'remote-member', message })), [])
    expect(new Set(rows.map(row => row.id)).size).toBe(messages.length)
  })

  it('lists a long conversation and its reports in the order they were written', async () => {
    const chat = Array.from({ length: 24 }, (_, i) => wire(i + 1, i % 2 ? 'assistant' : 'user', `m${i + 1}`))
    const room = taskConversationRows((await openRemoteMember(chat)).messages, [], 'epoch', 'remote-member')
    expect(room.map(row => row.message?.content)).toEqual(chat.map(row => row.content))

    const work = Array.from({ length: 24 }, (_, i) => wire(i + 1, i % 2 ? 'assistant' : 'system', `w${i + 1}`))
    const { messages } = await openRemoteMember(work)
    const reports = taskActivityRows(taskReportMessages(messages).map(message => ({ appId: 'remote-member', message })), [])
    expect(reports.map(row => row.message?.content)).toEqual(work.filter(row => row.role === 'assistant').map(row => row.content))
  })

  it('draws an addition it received mid-turn once, and keeps a stop on that row', async () => {
    const text = 'Also cover rollback'
    const { epochId, messages } = await openRemoteMember(remoteTranscript.slice(0, 2))
    const read = async (rows: SerializedHistoryMessage[]) => {
      env.teamChatMessages.mockResolvedValueOnce({ success: true, data: rows })
      return (await loadTeamSessionHistory('remote-member', 'space', 'team', epochId)).data as Message[]
    }
    // As the owner's sink announces an addition to the running work.
    const announced: Message = {
      id: 'pending-live-7d1e', role: 'user', source: 'injection', content: text,
      timestamp: '2026-10-20T09:00:05.000Z', metadata: { inputMode: 'live' },
    }
    const live: LiveInput[] = [{ message: announced, textBlockVersion: 1, textOffset: 0 }]
    const drawn = (shown: Message[]) => withoutLiveInputs(shown, live).filter(message => message.content === text).length + 1

    let shown = mergeArrivingMessages(messages, [announced])
    expect(drawn(shown)).toBe(1)
    shown = mergeTeamSessionHistory(shown, await read([wire(3, 'user', text)]))
    expect(drawn(shown)).toBe(1)
    expect(shown.filter(message => message.content === text)).toHaveLength(1)
    shown = mergeTeamSessionHistory(shown, await read([wire(4, 'assistant', 'Rollback covered')]))
    expect(drawn(shown)).toBe(1)

    shown = withStoppedInputs(shown, [{ ...announced, metadata: { ...announced.metadata, inputOutcome: 'stopped' } }])
    shown = mergeTeamSessionHistory(shown, await read([wire(4, 'assistant', 'Rollback covered')]))
    const rows = shown.filter(message => message.content === text)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toMatch(/^remote-seq-0+3$/)
    expect(rows[0].metadata?.inputOutcome).toBe('stopped')
    expect(shown.map(message => message.content)).toEqual(['Draft the plan', 'Plan drafted', text, 'Rollback covered'])
  })
})

describe('a team member running on this computer', () => {
  it('keeps the ids its transcript already carries', async () => {
    retainTeamSessionHistory('local-member', 'space', 'team', 'local-epoch')
    const local = [
      { id: 'session-msg-1', seq: 1, role: 'user', content: 'Draft the plan', timestamp: '2026-10-20T09:00:00.000Z' },
      { id: 'session-msg-3', seq: 2, role: 'assistant', content: 'Plan drafted', timestamp: '2026-10-20T09:01:00.000Z' },
    ]
    env.teamChatMessages.mockResolvedValueOnce({ success: true, data: local })
    const result = await loadTeamSessionHistory('local-member', 'space', 'team', 'local-epoch')
    expect(result.data).toEqual(local)
  })

  it('takes its stored rows as they are when they replace what the screen showed', () => {
    const announced: Message = {
      id: 'pending-live-1', role: 'user', source: 'injection', content: 'Also cover rollback',
      timestamp: '2026-10-20T09:02:00.000Z', metadata: { inputMode: 'live' },
    }
    const stored: Array<Message & { seq: number }> = [
      { id: 'session-msg-1', seq: 1, role: 'user', content: 'Draft the plan', timestamp: '2026-10-20T09:00:00.000Z' },
      { id: 'session-msg-2', seq: 2, role: 'user', source: 'injection', content: announced.content, timestamp: announced.timestamp, metadata: { inputMode: 'live' } },
    ]
    const shown = [{ ...stored[0], metadata: { inputOutcome: 'stopped' as const } }, announced]
    const merged = mergeTeamSessionHistory(shown, stored)
    expect(merged).toHaveLength(2)
    merged.forEach((message, index) => expect(message).toBe(stored[index]))
  })
})
