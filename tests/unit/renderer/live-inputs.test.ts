import { describe, expect, it } from 'vitest'
import type { LiveInput, Message, Thought } from '../../../src/renderer/types'
import { appendLiveInputs, mergeArrivingMessages, splitLiveInputSections, withoutLiveInputs, withStoppedInputs, withStoppedLiveInputs } from '../../../src/renderer/utils/live-inputs'
import { reconcileTranscript } from '../../../src/renderer/stores/chat/backend/reconcile'
import { liveArrivals, projectArrivalThoughts, mergeArrivalThoughts, workSeconds } from '../../../src/renderer/components/chat/transcript/arrivals'

const message = (id: string, content = 'report', timestamp = '2026-10-09T10:00:00.000Z'): Message => ({ id, role: 'system', source: 'team-message', content, timestamp, metadata: { fromMemberName: 'Reviewer' } })
const thought = (id: string): Thought => ({ id, type: 'tool_use', content: '', timestamp: '2026-10-09T10:00:00.000Z', toolName: 'Read' })

describe('accepted input arrival', () => {
  it('preserves history and reconciles provisional source records without duplicating them', () => {
    const old = message('old', 'old report')
    const input = message('pending-live-1')
    const arrived = mergeArrivingMessages([old], [input, input])
    expect(arrived).toEqual([old, input])
    const settled = reconcileTranscript(arrived, [old, { ...input, id: 'session-msg-20' }], { dropUnconfirmed: true }).messages
    expect(settled).toHaveLength(2)
    expect(settled[1].clientKey).toBe(input.id)
    expect(settled[1].source).toBe('team-message')
  })

  it('hides only this arrival from concurrent canonical history, not an identical older message', () => {
    const input = message('pending-live-1')
    const old = message('session-msg-2', input.content, '2026-10-08T10:00:00.000Z')
    const persisted = { ...input, id: 'session-msg-20' }
    const live: LiveInput[] = [{ message: input, textBlockVersion: 1, textOffset: 0 }]
    expect(withoutLiveInputs([old, persisted], live)).toEqual([old])
  })

  it('reuses a canonical row when its read overtakes the arrival event', () => {
    const pending = message('pending-live-raced')
    const canonical = { ...pending, id: 'session-msg-18' }
    expect(mergeArrivingMessages([canonical], [pending])).toEqual([canonical])
  })

  it('matches the owner optimistic bubble without requiring server-only team provenance fields', () => {
    const optimistic: Message = { id: 'pending-user-1', role: 'user', content: 'hello', timestamp: 'earlier' }
    const input: Message = { ...optimistic, id: 'pending-live-2', timestamp: 'now', metadata: { teamTriggerKind: 'human_message', correlationId: 'request' } }
    expect(mergeArrivingMessages([optimistic], [input])).toEqual([{ ...input, clientKey: optimistic.id }])
  })

  it('anchors multiple source messages between the tool before arrival and the next step', () => {
    const first = thought('before')
    const after = thought('after')
    const inputs = appendLiveInputs([], [message('pending-live-1'), message('pending-live-2')], {
      afterThoughtId: first.id, textBlockVersion: 3, textOffset: 5, textSnapshot: 'Hello',
    })
    const layout = splitLiveInputSections([first, after], 3, inputs)
    expect(layout.sections[0].thoughts).toEqual([first])
    expect(layout.sections[0].text).toBe('Hello')
    expect(layout.sections[1].thoughts).toEqual([])
    expect(layout.sections[1].text).toBe('')
    expect(layout.thoughts).toEqual([after])
    expect(layout.textOffset).toBe(5)
    const advanced = splitLiveInputSections([first, after, thought('last')], 4, inputs, layout.sections)
    expect(advanced.sections[0].thoughts).toBe(layout.sections[0].thoughts)
    expect(advanced.textOffset).toBe(0)
  })

  it('keeps every anchored team report in the process after the placement overlay is capped', () => {
    const records = Array.from({ length: 140 }, (_, i) => ({ ...message(`team-${i}`), metadata: { teamId: 'team', inputMode: 'live' as const, inputReplyId: 'reply' } }))
    const owner: Message = { id: 'owner', role: 'user', source: 'injection', content: 'extra', timestamp: 'now' }
    const inputs = appendLiveInputs([], [owner, ...records], { textBlockVersion: 1, textOffset: 5, textSnapshot: 'Hello' })
    expect(inputs).toHaveLength(128)
    expect(inputs[0].message).toBe(owner)
    expect(liveArrivals(records, inputs)).toEqual(records)
    const placeholder: Message = { id: 'reply', role: 'assistant', content: '', timestamp: 'earlier' }
    expect(liveArrivals([placeholder, ...records], [])).toEqual(records)
  })

  it('keeps an oversized report readable without storing its placement snapshot', () => {
    const report: Message = { ...message('large', 'x'.repeat(4 * 1024 * 1024 + 1)), metadata: { teamId: 'team', inputMode: 'live', inputReplyId: 'reply' } }
    const inputs = appendLiveInputs([], [report], { textBlockVersion: 1, textOffset: 0 })
    expect(inputs).toHaveLength(0)
    const placeholder: Message = { id: 'reply', role: 'assistant', content: '', timestamp: 'earlier' }
    expect(liveArrivals([placeholder, report], inputs)).toEqual([report])
    expect(liveArrivals([report], inputs)).toEqual([report])
    expect(liveArrivals([{ ...placeholder, id: 'reply', content: 'done' }, report], inputs)).toEqual([])
  })

  it('does not duplicate a provisional team record when canonical history overtakes it', () => {
    const pending: Message = { ...message('pending-live-team'), metadata: { teamId: 'team' } }
    const canonical = { ...pending, id: 'stored-team' }
    const inputs = appendLiveInputs([], [pending], { textBlockVersion: 0, textOffset: 0 })
    expect(liveArrivals([canonical], inputs)).toEqual([canonical])
  })

  it('leaves the record that opened the turn as its own card and completed history alone', () => {
    const opener: Message = { ...message('opener'), metadata: { teamId: 'team', inputMode: 'turn' } }
    const placeholder: Message = { id: 'reply', role: 'assistant', content: '', timestamp: 'now' }
    const live: Message = { ...message('live'), metadata: { teamId: 'team', inputMode: 'live', inputReplyId: 'reply' } }
    expect(liveArrivals([opener, placeholder, live], [])).toEqual([live])
    expect(liveArrivals([opener, { ...placeholder, content: 'done' }, live], [])).toEqual([])
  })

  it('takes a running digital-human turn’s arrivals whose partial reply is not drawn, never an older turn’s', () => {
    const done: Message = { id: 'session-msg-1', role: 'assistant', content: 'done', timestamp: 'earlier' }
    const stale: Message = { ...message('stale'), metadata: { teamId: 'team', inputMode: 'live', inputReplyId: 'removed-placeholder' } }
    const trigger: Message = { id: 'session-msg-9', role: 'user', content: 'go', timestamp: 'now' }
    const held: Message = { ...message('session-msg-14'), metadata: { teamId: 'team', inputMode: 'live', inputReplyId: 'session-msg-11' } }
    const unanchored: Message = { id: 'session-msg-15', role: 'system', source: 'cross-conversation', content: 'note', timestamp: 'now', metadata: { fromConversationId: 'c', inputMode: 'live' } }
    expect(liveArrivals([done, stale, trigger, held, unanchored], [])).toEqual([held, unanchored])
    const owner: Message = { id: 'session-msg-16', role: 'user', source: 'injection', content: 'also', timestamp: 'now' }
    expect(liveArrivals([done, trigger, held, owner], [])).toEqual([held])
  })

  it('reuses projected report objects and merges them without modifying SDK thoughts', () => {
    const report: Message = { ...message('team'), metadata: { teamId: 'team' } }
    const first = projectArrivalThoughts([report])
    const second = projectArrivalThoughts([report, { ...report, id: 'next' }], first)
    expect(second[0]).toBe(first[0])
    const native = [thought('tool')]
    expect(mergeArrivalThoughts(native, first)).toEqual([first[0], native[0]])
    expect(native).toEqual([thought('tool')])
    expect(mergeArrivalThoughts([], first)).toEqual(first)
    const later = projectArrivalThoughts([{ ...report, id: 'later', timestamp: '2026-10-09T10:00:02.000Z' }, { ...report, id: 'sooner', timestamp: '2026-10-09T10:00:01.000Z' }])
    expect(mergeArrivalThoughts(native, later).map(item => item.id)).toEqual(['tool', 'arrival:sooner', 'arrival:later'])
  })

  it('bounds the live placement overlay while preserving the separate transcript records', () => {
    const records = Array.from({ length: 140 }, (_, index) => message(`pending-live-${index}`))
    const inputs = appendLiveInputs([], records, { textBlockVersion: 0, textOffset: 0 })
    expect(inputs).toHaveLength(128)
    expect(mergeArrivingMessages([], records)).toHaveLength(140)
    expect(withoutLiveInputs(records, inputs)).toHaveLength(12)
  })

  it('marks the person’s voided inputs where they are shown, without moving or duplicating them', () => {
    const stored: Message = { id: 'injection-1', role: 'user', source: 'injection', content: 'also check B', timestamp: 't1' }
    const announced: Message = { id: 'pending-live-7', role: 'user', content: 'and C', timestamp: 't2' }
    const optimistic: Message = { id: 'pending-123', role: 'user', content: 'held send', timestamp: 'local' }
    const reply: Message = { id: 'r', role: 'assistant', content: 'working', timestamp: 't0' }
    const stoppedRecords: Message[] = [
      { ...stored, metadata: { inputOutcome: 'stopped' } },
      { ...announced, id: 'pending-live-7', metadata: { inputOutcome: 'stopped' } },
      { id: 'pending-live-8', role: 'user', content: 'held send', timestamp: 't3', metadata: { inputOutcome: 'stopped' } },
      { id: 'pending-live-9', role: 'user', content: 'from IM', timestamp: 't4', metadata: { inputOutcome: 'stopped' } },
    ]
    const next = withStoppedInputs([reply, stored, { ...announced, id: 'session-msg-30', clientKey: 'pending-live-7' }, optimistic], stoppedRecords)
    expect(next.map(item => [item.id, item.metadata?.inputOutcome])).toEqual([
      ['r', undefined], ['injection-1', 'stopped'], ['session-msg-30', 'stopped'], ['pending-123', 'stopped'], ['pending-live-9', 'stopped'],
    ])
    expect(next[0]).toBe(reply)
    const overlay = appendLiveInputs([], [stored], { textBlockVersion: 0, textOffset: 0 })
    expect(withStoppedLiveInputs(overlay, stoppedRecords)[0].message.metadata?.inputOutcome).toBe('stopped')
    expect(withStoppedLiveInputs(overlay, [])).toBe(overlay)
    const settled = reconcileTranscript(next, [reply, { ...stored, metadata: { inputOutcome: 'stopped' } }, { ...announced, id: 'session-msg-30', metadata: { inputOutcome: 'stopped' } }, { ...optimistic, id: 'session-msg-31', timestamp: 't3', metadata: { inputOutcome: 'stopped' } }, { id: 'session-msg-32', role: 'user', content: 'from IM', timestamp: 't4', metadata: { inputOutcome: 'stopped' } }], { dropUnconfirmed: true }).messages
    expect(settled.map(item => item.id)).toEqual(['r', 'injection-1', 'session-msg-30', 'session-msg-31', 'session-msg-32'])
  })

  it('counts only the reply’s own steps in how long it thought, whatever it received before or after them', () => {
    const at = (second: number) => `2026-10-13T10:00:${String(second).padStart(2, '0')}.000Z`
    const steps: Thought[] = [{ ...thought('a'), timestamp: at(1) }, { ...thought('b'), timestamp: at(3) }]
    const received = projectArrivalThoughts([message('pending-live-early', 'early', at(0)), message('pending-live-late', 'late', at(17))])
    const process = mergeArrivalThoughts(steps, received)
    expect(process.map(item => item.id)).toEqual(['arrival:pending-live-early', 'a', 'b', 'arrival:pending-live-late'])
    expect(workSeconds(process)).toBe(2)
    expect(workSeconds(steps)).toBe(2)
    expect(workSeconds(received)).toBe(0)
    expect(workSeconds([])).toBe(0)
  })

  it('marks a person’s team chat bubble in place when their stop voids it, as an accepted send would replace it', () => {
    const reply: Message = { id: 'r', role: 'assistant', content: 'working', timestamp: 't0' }
    const optimistic: Message = { id: 'pending-user-1', role: 'user', content: 'please also check X', timestamp: 'local' }
    const record: Message = {
      id: 'pending-live-5', role: 'user', content: 'please also check X', timestamp: 't5',
      metadata: { teamTriggerKind: 'human_message', correlationId: 'user-1' },
    }
    const stopped = withStoppedInputs([reply, optimistic], [{ ...record, metadata: { ...record.metadata, inputOutcome: 'stopped' } }])
    expect(stopped.map(item => [item.id, item.metadata?.inputOutcome])).toEqual([['r', undefined], ['pending-user-1', 'stopped']])
    expect(mergeArrivingMessages([reply, optimistic], [record]).map(item => [item.id, item.clientKey])).toEqual([['r', undefined], ['pending-live-5', 'pending-user-1']])
    const teammate: Message = { ...record, id: 'pending-live-6', metadata: { teamTriggerKind: 'message', correlationId: 'c-2', inputOutcome: 'stopped' } }
    expect(withStoppedInputs([reply, optimistic], [teammate]).map(item => item.id)).toEqual(['r', 'pending-user-1', 'pending-live-6'])
  })
})
