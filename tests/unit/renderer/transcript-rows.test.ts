/**
 * Transcript rows are derived again only from the first changed message, and
 * must always equal what a full build of the same messages gives: the drawn
 * rows, their keys, each row's previous cost and the injected messages shown
 * on each reply.
 */

import { describe, expect, it } from 'vitest'
import { nextTranscriptRows, type TranscriptRows } from '../../../src/renderer/components/chat/transcript/transcript-rows'
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
