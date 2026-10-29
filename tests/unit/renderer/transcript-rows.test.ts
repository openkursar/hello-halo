/**
 * Transcript rows are derived again only from the first changed message, and
 * must always equal what a full build of the same messages gives: the drawn
 * rows, their keys, each row's previous cost and the injected messages shown
 * on each reply.
 */

import { describe, expect, it } from 'vitest'
import { inputsByReply, nextTranscriptRows, openerOwner, type TranscriptRows } from '../../../src/renderer/components/chat/transcript/transcript-rows'
import type { Message } from '../../../src/renderer/types'

let seq = 0
const message = (fields: Partial<Message>): Message =>
  ({ id: `m${++seq}`, role: 'user', content: 'text', timestamp: '', ...fields }) as Message
const user = (fields: Partial<Message> = {}) => message({ role: 'user', ...fields })
const reply = (cost?: number, fields: Partial<Message> = {}) =>
  message({ role: 'assistant', content: 'reply', ...(cost ? { tokenUsage: { totalCostUsd: cost } as Message['tokenUsage'] } : {}), ...fields })
const injection = () => message({ role: 'user', source: 'injection' })

/** What the transcript showed before rows were derived incrementally. */
function reference(source: readonly Message[], isGenerating: boolean) {
  let display = source.filter(m => m.source !== 'injection')
  if (isGenerating) {
    display = display.filter((m, i) => !(i === display.length - 1 && m.role === 'assistant' && !m.content))
  }
  const seen = new Map<string, number>()
  const keys = display.map(m => {
    const key = m.clientKey ?? m.id
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    return n === 0 ? key : `${key}#${n}`
  })
  const injections = new Map<string, Message[]>()
  source.forEach((m, i) => {
    if (m.role !== 'assistant') return
    const run: Message[] = []
    for (let j = i + 1; j < source.length && source[j].source === 'injection'; j++) run.push(source[j])
    if (run.length) injections.set(m.id, run)
  })
  let last = 0
  const previousCosts = display.map(m => {
    const before = last
    if (m.role === 'assistant' && m.tokenUsage?.totalCostUsd) last = m.tokenUsage.totalCostUsd
    return before
  })
  return { messages: display, keys, previousCosts, injections }
}

function expectMatchesReference(rows: TranscriptRows, source: readonly Message[], isGenerating: boolean) {
  const expected = reference(source, isGenerating)
  expect(rows.messages).toEqual(expected.messages)
  rows.messages.forEach((m, i) => expect(m).toBe(expected.messages[i]))
  expect(rows.keys).toEqual(expected.keys)
  expect(rows.previousCosts).toEqual(expected.previousCosts)
  expect([...rows.injections.entries()].sort()).toEqual([...expected.injections.entries()].sort())
}

describe('transcript rows', () => {
  it('derives a sent message and its turn from the tail, keeping the rows before it', () => {
    const history = [user(), reply(0.1), user(), reply(0.3)]
    const opened = nextTranscriptRows(null, history, false)
    const sent = [...history, user({ clientKey: 'pending-1' }), reply(undefined, { content: '' })]
    const sending = nextTranscriptRows(opened, sent, true)
    expectMatchesReference(sending, sent, true)
    expect(sending.messages).toHaveLength(5)
    expect(sending.keyRows).toBe(opened.keyRows)

    const settled = [...history, user({ clientKey: 'pending-1' }), reply(0.5)]
    const done = nextTranscriptRows(sending, settled, false)
    expectMatchesReference(done, settled, false)
    expect(done.previousCosts.at(-1)).toBe(0.3)
    expect(nextTranscriptRows(done, settled, false)).toBe(done)
  })

  it('shows a running turn’s placeholder once the turn ends, and injected messages on their reply', () => {
    const placeholder = reply(undefined, { content: '' })
    const source = [user(), placeholder, injection(), injection()]
    const running = nextTranscriptRows(null, source, true)
    expectMatchesReference(running, source, true)
    expect(running.messages).not.toContain(placeholder)
    const ended = nextTranscriptRows(running, source, false)
    expectMatchesReference(ended, source, false)
    expect(ended.injections.get(placeholder.id)).toHaveLength(2)
  })

  it('draws a delivery read mid-turn in the reply it joined, and one that opened a turn on the reply it opened', () => {
    const first = reply()
    const live = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'live', inputReplyId: first.id } })
    const idle = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'turn' } })
    const second = reply()
    const source = [user(), first, live, injection(), idle, second]
    const rows = nextTranscriptRows(null, source, false)
    expect(rows.messages).toEqual([source[0], first, second])
    expect(rows.arrivals.get(first.id)).toEqual([live])
    expect(rows.arrivals.has(second.id)).toBe(false)
    expect(rows.openers.get(second.id)).toEqual([idle])
    expect(rows.injections.get(first.id)).toEqual([source[3]])
    // No reply yet and no turn running: the delivery is its own card.
    const pending = nextTranscriptRows(null, source.slice(0, -1), false)
    expect(pending.messages).toContain(idle)
    const appended = nextTranscriptRows(pending, source, false)
    expect(appended.messages).toEqual(rows.messages)
    expect([...appended.arrivals]).toEqual([...rows.arrivals])
    expect([...appended.openers]).toEqual([...rows.openers])
  })

  it('finds the reply a delivery drawn on its sender line belongs to, so a jump can land there', () => {
    const opener = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'turn' } })
    const second = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'turn' } })
    const opened = reply()
    const shown = user()
    const rows = nextTranscriptRows(null, [shown, reply(), opener, second, opened], false)
    expect(openerOwner(rows, opener.id)).toBe(opened.id)
    expect(openerOwner(rows, second.id)).toBe(opened.id)
    expect(openerOwner(rows, shown.id)).toBeUndefined()
  })

  it('gives a running turn its openers, at the end or before its placeholder, and keeps them on the settled reply', () => {
    const opener = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'turn' } })
    const notice = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'turn' } })
    const history = [user(), reply()]
    const started = nextTranscriptRows(nextTranscriptRows(null, history, false), [...history, opener, notice], true)
    expect(started.messages).toEqual(history)
    expect(started.liveOpeners).toEqual([opener, notice])

    const placeholder = reply(undefined, { content: '' })
    const running = nextTranscriptRows(started, [...history, opener, notice, placeholder], true)
    expect(running.messages).toEqual(history)
    expect(running.liveOpeners).toEqual([opener, notice])

    const settled = { ...placeholder, content: 'done' }
    const done = nextTranscriptRows(running, [...history, opener, notice, settled], false)
    expect(done.messages).toEqual([...history, settled])
    expect(done.openers.get(settled.id)).toEqual([opener, notice])
    expect(done.liveOpeners).toEqual([])
  })

  it('never draws a delivery on a push, another sender’s card, or a reply after a user message', () => {
    const opener = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'turn' } })
    const push = reply(undefined, { source: 'push' })
    const cross = message({ role: 'system', source: 'cross-conversation', metadata: { fromConversationId: 'other', inputMode: 'turn' } })
    const source = [user(), reply(), opener, push, cross, reply(), opener, user(), reply()]
    const rows = nextTranscriptRows(null, source, false)
    expect(rows.messages).toEqual(source)
    expect(rows.openers.size).toBe(0)
  })

  it('gives a view drawing its own selection the same attachment, by reply', () => {
    const first = reply()
    const live = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'live', inputReplyId: first.id } })
    const added = injection()
    const source = [user(), first, live, added, message({ role: 'system', source: 'cross-conversation' }), injection(), reply()]
    const rows = nextTranscriptRows(null, source, false)
    const byReply = inputsByReply(source)
    expect([...byReply.keys()]).toEqual([first.id])
    expect(byReply.get(first.id)).toEqual({ injections: rows.injections.get(first.id), arrivals: rows.arrivals.get(first.id) })
    expect(byReply.get(first.id)).toEqual({ injections: [added], arrivals: [live] })
  })

  it('draws another conversation’s message read mid-turn in the reply it joined, never in a push', () => {
    const first = reply()
    const crossLive = message({ role: 'system', source: 'cross-conversation', metadata: { fromConversationId: 'other', inputMode: 'live', inputReplyId: first.id } })
    const crossOpener = message({ role: 'system', source: 'cross-conversation', metadata: { fromConversationId: 'other' } })
    const second = reply()
    const source = [user(), first, crossLive, crossOpener, second]
    const rows = nextTranscriptRows(null, source, false)
    expect(rows.messages).toEqual([source[0], first, crossOpener, second])
    expect(rows.arrivals.get(first.id)).toEqual([crossLive])
    const push = reply(undefined, { source: 'push' })
    const pushed = [user(), push, message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'live', inputReplyId: push.id } })]
    expect(nextTranscriptRows(null, pushed, false).arrivals.size).toBe(0)
  })

  it('keeps a running turn’s placeholder hidden while it receives deliveries', () => {
    const placeholder = reply(undefined, { content: '' })
    const live = message({ role: 'system', source: 'cross-conversation', metadata: { fromConversationId: 'other', inputMode: 'live', inputReplyId: placeholder.id } })
    const source = [user(), placeholder, live]
    const running = nextTranscriptRows(null, source, true)
    expect(running.messages).toEqual([source[0]])
    expect(running.arrivals.get(placeholder.id)).toEqual([live])
  })

  it('does not guess ownership for old or incomplete team records', () => {
    const first = reply()
    const legacy = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team' } })
    const missingProvenance = message({ role: 'system', source: 'team-message', metadata: { inputMode: 'live' } })
    const source = [user(), first, legacy, missingProvenance, reply()]
    const rows = nextTranscriptRows(null, source, false)
    expect(rows.messages).toEqual(source)
    expect(rows.arrivals.size).toBe(0)
  })

  it('keeps team deliveries attached across a visible cross-conversation input', () => {
    const first = reply()
    const other = message({ role: 'system', source: 'cross-conversation' })
    const team = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'live', inputReplyId: first.id } })
    const source = [user(), first, other, team]
    const rows = nextTranscriptRows(null, source, false)
    expect(rows.messages).toEqual([source[0], first, other])
    expect(rows.arrivals.get(first.id)).toEqual([team])
  })

  it('leaves unanchored continuation inputs visible instead of assigning them to the last answer', () => {
    const first = reply(0.1)
    const late = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'live' } })
    const missingReply = message({ role: 'system', source: 'team-message', metadata: { teamId: 'team', inputMode: 'live', inputReplyId: 'removed-placeholder' } })
    const source = [user(), first, late, missingReply, reply(0.2)]
    const rows = nextTranscriptRows(null, source, false)
    expect(rows.messages).toEqual(source)
    expect(rows.arrivals.size).toBe(0)
  })

  it('does not move owner additions across unrelated system messages', () => {
    const source = [user(), reply(), message({ role: 'system', source: 'cross-conversation' }), injection()]
    expectMatchesReference(nextTranscriptRows(null, source, false), source, false)
    const running = [user(), reply(undefined, { content: '' }), message({ role: 'system', source: 'cross-conversation' })]
    expectMatchesReference(nextTranscriptRows(null, running, true), running, true)
  })

  it('keeps incremental team grouping equal to a fresh build while records change', () => {
    let source: Message[] = [user(), reply(0.1)]
    let rows = nextTranscriptRows(null, source, false)
    for (let i = 0; i < 60; i++) {
      const previousReply = [...source].reverse().find(m => m.role === 'assistant')!
      source = [...source, message({ role: 'system', source: 'team-message', metadata: {
        teamId: 'team', inputMode: i % 3 === 0 ? 'turn' : 'live', inputReplyId: previousReply.id,
      } })]
      if (i % 4 === 0) source.push(reply(0.2))
      if (i % 5 === 0) source.push(message({ role: 'system', source: 'cross-conversation' }))
      if (i % 6 === 0) source.push(message({ role: 'system', source: 'cross-conversation', metadata: { fromConversationId: 'other', inputMode: 'live', inputReplyId: previousReply.id } }))
      if (i % 7 === 0) source = source.slice(0, -2)
      rows = nextTranscriptRows(rows, source, i % 2 === 0)
      const full = nextTranscriptRows(null, source, i % 2 === 0)
      expect(rows.messages).toEqual(full.messages)
      expect(rows.keys).toEqual(full.keys)
      expect(rows.previousCosts).toEqual(full.previousCosts)
      expect([...rows.injections]).toEqual([...full.injections])
      expect([...rows.arrivals]).toEqual([...full.arrivals])
      expect([...rows.openers]).toEqual([...full.openers])
      expect(rows.liveOpeners).toEqual(full.liveOpeners)
    }
  })

  it('falls back to a full build for a repeated key, an older page or another conversation', () => {
    const first = user()
    const source = [first, reply(0.1)]
    const rows = nextTranscriptRows(null, source, false)
    const repeated = [...source, { ...first }]
    expectMatchesReference(nextTranscriptRows(rows, repeated, false), repeated, false)
    const older = [user(), reply(), ...source]
    expectMatchesReference(nextTranscriptRows(rows, older, false), older, false)
    const other = [user(), reply(0.2)]
    expectMatchesReference(nextTranscriptRows(rows, other, false), other, false)
  })

  it('matches a full build over long random sequences of transcript changes', () => {
    let random = 11
    const next = () => (random = (random * 48271) % 2147483647) / 2147483647
    const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)]
    for (let run = 0; run < 40; run++) {
      let source: Message[] = []
      let isGenerating = false
      let rows = nextTranscriptRows(null, source, isGenerating)
      for (let op = 0; op < 150; op++) {
        const roll = next()
        if (roll < 0.35) {
          const kind = next()
          const added = kind < 0.35 ? user() : kind < 0.6 ? reply(next() < 0.5 ? Math.round(next() * 100) / 100 : undefined)
            : kind < 0.75 ? injection() : kind < 0.85 ? reply(undefined, { content: '' })
            : kind < 0.9 && source.length ? { ...pick(source) } : user({ clientKey: `pending-${op}` })
          source = [...source, added]
        } else if (roll < 0.5 && source.length) {
          // The settled twin of the last message keeps its key.
          const last = source[source.length - 1]
          source = [...source.slice(0, -1), { ...last, content: last.content || 'settled' }]
        } else if (roll < 0.65 && source.length) {
          // Thoughts loaded or dropped for one message: a new object in place.
          const index = Math.floor(next() * source.length)
          source = source.map((m, i) => (i === index ? { ...m, thoughts: null } : m))
        } else if (roll < 0.8) {
          isGenerating = !isGenerating
        } else if (roll < 0.9) {
          source = source.slice(0, Math.floor(next() * (source.length + 1)))
        } else if (roll < 0.95) {
          source = [user(), reply(0.01), ...source]
        } else {
          source = Array.from({ length: Math.floor(next() * 6) }, () => (next() < 0.5 ? user() : reply(0.02)))
        }
        rows = nextTranscriptRows(rows, source, isGenerating)
        expectMatchesReference(rows, source, isGenerating)
      }
    }
  })
})
