/**
 * A digital human's turn looks the same while it runs and after its record is
 * read back: a teammate's message read mid-turn sits in the reply's work at the
 * point it arrived, and a message the digital human pushed mid-turn sits after
 * the latest tool call — as its own bubble splitting the reply in both views.
 *
 * The record is read with the real transcript reader; the live view is laid out
 * the way the streaming section lays it out.
 */

import { describe, expect, it } from 'vitest'
import { convertEventsToMessages, type StoredEvent } from '../../../src/main/apps/runtime/session-transcript'
import { nextTranscriptRows } from '../../../src/renderer/components/chat/transcript/transcript-rows'
import { mergeArrivalThoughts, projectArrivalThoughts } from '../../../src/renderer/components/chat/transcript/arrivals'
import { appendLiveInputs, splitLiveInputSections } from '../../../src/renderer/utils/live-inputs'
import type { Message, Thought } from '../../../src/renderer/types'

const ts = (n: number) => new Date(Date.UTC(2026, 9, 13, 10, 0, n)).toISOString()
const user = (text: string, n: number, extra: Record<string, unknown> = {}): StoredEvent => ({
  _ts: ts(n), type: 'user', _isTrigger: true, ...extra, message: { role: 'user', content: [{ type: 'text', text }] },
})
const assistant = (content: unknown[], n: number): StoredEvent => ({ _ts: ts(n), type: 'assistant', message: { role: 'assistant', content } })
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { id } })
const toolResult = (id: string, n: number): StoredEvent => ({
  _ts: ts(n), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `out-${id}` }] },
})
const init = (n: number): StoredEvent => ({ _ts: ts(n), type: 'system', subtype: 'init' })
const result = (text: string, n: number): StoredEvent => ({ _ts: ts(n), type: 'result', result: text })
const teamLive = (body: string, n: number): StoredEvent => user(body, n, {
  _teamOrigin: { kind: 'message', correlationId: `corr-${n}` },
  _source: 'team-message',
  _metadata: { teamId: 'team', epochId: 'epoch', teamName: 'Crew', fromMemberName: 'Writer', teamTriggerKind: 'message', inputMode: 'live' },
})
const push = (text: string, n: number): StoredEvent => ({ _ts: ts(n), type: 'push', _pushVia: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const thought = (id: string, n: number): Thought => ({ id, type: 'tool_use', content: '', timestamp: ts(n), toolName: 'Bash' })

describe('a running digital-human turn and its record read back', () => {
  it('keeps a teammate message read mid-turn inside the one reply’s work', () => {
    const stored = convertEventsToMessages([
      user('check the build', 1), init(2), assistant([toolUse('t1')], 3), toolResult('t1', 4),
      teamLive('tests are green', 5), assistant([toolUse('t2')], 6), toolResult('t2', 7),
      assistant([{ type: 'text', text: 'All good' }], 8), result('All good', 9),
    ]) as Message[]
    const rows = nextTranscriptRows(null, stored, false)
    expect(rows.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    const reply = rows.messages[1]
    expect(rows.arrivals.get(reply.id)?.map(message => message.content)).toEqual(['tests are green'])

    // Live: the same arrival joins the process between the two tool calls.
    const arrival: Message = { id: 'pending-live-1', role: 'system', source: 'team-message', content: 'tests are green', timestamp: ts(5), metadata: { teamId: 'team', inputMode: 'live' } }
    const live = mergeArrivalThoughts([thought('t1', 3), thought('t2', 6)], projectArrivalThoughts([arrival]))
    expect(live.map(item => item.id)).toEqual(['t1', 'arrival:pending-live-1', 't2'])
    const settled = mergeArrivalThoughts(reply.thoughts as Thought[], projectArrivalThoughts(rows.arrivals.get(reply.id)!))
    expect(settled.map(item => ('arrival' in item ? 'arrival' : item.toolName))).toEqual(['Bash', 'arrival', 'Bash'])
  })

  it('places a push made during a tool call after that tool call, live and read back', () => {
    const stored = convertEventsToMessages([
      user('deploy it', 1), init(2), assistant([toolUse('notify')], 3), push('Deploy started', 4), toolResult('notify', 5),
      assistant([toolUse('t2')], 6), toolResult('t2', 7), assistant([{ type: 'text', text: 'Deployed' }], 8), result('Deployed', 9),
    ]) as Message[]
    const rows = nextTranscriptRows(null, stored, false)
    expect(rows.messages.map(message => message.source ?? message.role)).toEqual(['user', 'assistant', 'push', 'assistant'])
    expect((rows.messages[1].thoughts as Thought[]).map(item => item.toolResult?.output)).toEqual(['out-notify'])
    expect(rows.messages[3].content).toBe('Deployed')

    // Live: the push is received while the notify call runs, so it follows it.
    const pushed: Message = { id: 'pending-live-2', role: 'assistant', source: 'push', content: 'Deploy started', timestamp: ts(4) }
    const inputs = appendLiveInputs([], [pushed], { afterThoughtId: 'notify', textBlockVersion: 0, textOffset: 0, textSnapshot: '' })
    const layout = splitLiveInputSections([thought('notify', 3), thought('t2', 6)], 1, inputs)
    expect(layout.sections.map(section => [section.thoughts.map(item => item.id), section.input.message.content])).toEqual([[['notify'], 'Deploy started']])
    expect(layout.thoughts.map(item => item.id)).toEqual(['t2'])
  })
})
