/**
 * Incremental reads of a transcript must equal whole reads.
 *
 * - An update from any earlier read, applied to what that read returned,
 *   gives exactly the whole transcript (run detail polling).
 * - Converting the events after any native-turn checkpoint from its seed gives
 *   exactly the whole conversion's messages from there (federation tails).
 *
 * Event logs are generated from a fixed seed and cover the codec's moving
 * parts: tool results arriving in a later segment, text superseded by more
 * text, transparent tools, live arrivals, pushes, stopped inputs, terminal
 * checkpoints, replies that ended early (with and without the words they had
 * shown), compactions, failures and the legacy stream-event form.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync, closeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  FULL_PARSE_MAX_BYTES,
  readSessionMessages,
  readSessionMessagesFrom,
  readSessionUpdate,
} from '../../../../src/main/apps/runtime/session-store'
import { convertEventsToTranscript, type StoredEvent } from '../../../../src/main/apps/runtime/session-transcript'
import { applyTranscriptUpdate } from '../../../../src/shared/transcript-update'
import type { TranscriptMessage } from '../../../../src/shared/types/transcript'

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, n)).toISOString()

/** A plausible session log: turns of thinking, text and tools, with everything that can arrive between them. */
function randomLog(seed: number, length: number): StoredEvent[] {
  const next = random(seed)
  const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]
  const events: StoredEvent[] = []
  const openTools: string[] = []
  const inputIds: string[] = []
  let n = 0
  let tool = 0
  let lastSaid = ''
  const say = (text: string) => { lastSaid = text; return { type: 'text', text } }
  const content = (blocks: unknown[]): StoredEvent => ({ _ts: ts(++n), type: 'assistant', message: { role: 'assistant', content: blocks } })
  const trigger = (extra: Record<string, unknown> = {}): StoredEvent => {
    const inputId = `in-${n}`
    inputIds.push(inputId)
    return { _ts: ts(++n), type: 'user', _isTrigger: true, _inputId: inputId, ...extra, message: { role: 'user', content: [{ type: 'text', text: `ask ${n}` }] } }
  }
  const toolUse = (name = 'Bash') => {
    const id = `tool-${++tool}`
    openTools.push(id)
    return { type: 'tool_use', id, name, input: { step: tool } }
  }
  const kinds: Array<[number, () => StoredEvent | StoredEvent[]]> = [
    [8, () => trigger()],
    [3, () => trigger({ _source: 'injection' })],
    [4, () => trigger({ _source: 'team-message', _teamOrigin: { kind: 'message', correlationId: `c-${n}` }, _metadata: { teamId: 't', epochId: 'e', fromMemberName: 'writer', teamTriggerKind: 'message', inputMode: 'live' } })],
    [2, () => trigger({ _source: 'cross-conversation', _metadata: { fromConversationId: 'other', inputMode: 'live' } })],
    [2, () => trigger({ _teamOrigin: { kind: 'human_message', correlationId: `h-${n}` } })],
    [6, () => ({ _ts: ts(++n), type: 'system', subtype: 'init' })],
    [8, () => content([{ type: 'thinking', thinking: `think ${n}` }])],
    [14, () => content([say(`say ${n}`)])],
    [12, () => content([toolUse()])],
    [5, () => content([toolUse('TodoWrite')])],
    [6, () => content([say(`then ${n}`), toolUse()])],
    // The words shown when a reply ended early: none, a continuation of its last block, or other words.
    [4, () => {
      const shape = next()
      const shown = shape < 0.35 ? {} : { content: shape < 0.7 ? `${lastSaid} and went on` : `shown ${n}` }
      return { _ts: ts(++n), type: 'reply_ending', ending: pick(['stopped', 'interrupted', 'step-limit']), ...shown }
    }],
    [2, () => ({ _ts: ts(++n), type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: pick(['auto', 'manual']) } })],
    [16, () => {
      if (!openTools.length) return content([{ type: 'text', text: `idle ${n}` }])
      const id = openTools.splice(Math.floor(next() * openTools.length), 1)[0]
      const output = next() < 0.2
        ? [{ type: 'text', text: `shot ${id}` }, { type: 'image_file', path: `/tmp/${id}.png`, media_type: 'image/png', bytes: 10 }]
        : `out ${id}`
      return { _ts: ts(++n), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: next() < 0.1 }] } }
    }],
    [1, () => ({ _ts: ts(++n), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'stray' }] } })],
    [4, () => { openTools.length = 0; return { _ts: ts(++n), type: 'result', result: `final ${n}` } }],
    [2, () => {
      openTools.length = 0
      const thoughts = Array.from({ length: Math.floor(next() * 3) }, (_, i) => ({ id: `snap-${n}-${i}`, type: 'thinking', content: 'kept', timestamp: ts(n) }))
      return { _ts: ts(++n), type: 'turn_snapshot', content: `partial ${n}`, thoughts, ...(next() < 0.5 ? { error: 'stopped' } : {}) }
    }],
    [3, () => ({ _ts: ts(++n), type: 'push', _pushVia: pick(['message', 'result']), message: { role: 'assistant', content: [{ type: 'text', text: `push ${n}` }] } })],
    [2, () => ({ _ts: ts(++n), type: 'input_outcome', _inputId: inputIds.length ? pick(inputIds) : 'none', outcome: 'stopped' })],
    [1, () => ({ _ts: ts(++n), type: 'assistant', error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: 'Rate limited' }] } })],
    [1, () => ({ _ts: ts(++n), type: 'result', is_error: true, subtype: 'error_during_execution', result: `failed ${n}` })],
    [2, () => {
      const id = `tool-${++tool}`
      openTools.push(id)
      const at = ++n
      return [
        { _ts: ts(at), type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
        { _ts: ts(at), type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'streamed' } } },
        { _ts: ts(at), type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { _ts: ts(at), type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name: 'Read', input: {} } } },
        { _ts: ts(at), type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a"}' } } },
        { _ts: ts(at), type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
        { _ts: ts(at), type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
        { _ts: ts(at), type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'streamed text' } } },
        { _ts: ts(at), type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },
      ] as StoredEvent[]
    }],
  ]
  const total = kinds.reduce((sum, [weight]) => sum + weight, 0)
  events.push(trigger())
  while (events.length < length) {
    let roll = next() * total
    const make = kinds.find(([weight]) => (roll -= weight) < 0)?.[1] ?? kinds[0][1]
    const made = make()
    events.push(...(Array.isArray(made) ? made : [made]))
  }
  return events
}

const LOGS = Array.from({ length: 24 }, (_, i) => randomLog(1000 + i, 30 + (i % 4) * 25))

let spacePath: string
let filePath: string

beforeEach(() => {
  spacePath = mkdtempSync(join(tmpdir(), 'halo-transcript-incremental-'))
  const dir = join(spacePath, '.halo', 'apps', 'app-1', 'runs')
  mkdirSync(dir, { recursive: true })
  filePath = join(dir, 'run-1.jsonl')
})

afterEach(() => {
  rmSync(spacePath, { recursive: true, force: true })
})

/** File text for events, with blank lines here and there (they still count as lines). */
function linesOf(events: StoredEvent[], seed: number): string {
  const next = random(seed)
  return events.map(event => `${next() < 0.1 ? '\n' : ''}${JSON.stringify(event)}\n`).join('')
}

describe('incremental run transcript reads', () => {
  it('an update applied to what the reader held equals the whole transcript, from every earlier read', () => {
    let partial = 0
    let reused = 0
    for (const [logIndex, events] of LOGS.entries()) {
      const text = linesOf(events, logIndex)
      const cuts = text.split('\n').reduce<number[]>((at, _line, i, all) => {
        if (i < all.length - 1) at.push(all.slice(0, i + 1).join('\n').length + 1)
        return at
      }, [])
      for (const cut of cuts) {
        writeFileSync(filePath, text.slice(0, cut))
        const first = readSessionUpdate(spacePath, 'app-1', 'run-1', '')
        const held = applyTranscriptUpdate<TranscriptMessage>([], first)!
        expect(held).toEqual(readSessionMessages(spacePath, 'app-1', 'run-1'))
        appendFileSync(filePath, text.slice(cut))
        const update = readSessionUpdate(spacePath, 'app-1', 'run-1', first.cursor)
        const applied = applyTranscriptUpdate(held, update)
        expect(applied).toEqual(readSessionMessages(spacePath, 'app-1', 'run-1'))
        if ((update.keep ?? 0) > 0) partial++
        if (update.messages.some(message => message.thoughtPatch)) reused++
      }
    }
    // The comparison above is only meaningful if updates actually left things out.
    expect(partial).toBeGreaterThan(100)
    expect(reused).toBeGreaterThan(100)
  })

  it('a reader polling while the log grows stays equal to the whole transcript', () => {
    for (const [logIndex, events] of LOGS.entries()) {
      const next = random(logIndex + 77)
      let held: TranscriptMessage[] = []
      let cursor = ''
      writeFileSync(filePath, '')
      let at = 0
      while (at < events.length) {
        const step = 1 + Math.floor(next() * 4)
        appendFileSync(filePath, linesOf(events.slice(at, at + step), at))
        at += step
        const update = readSessionUpdate(spacePath, 'app-1', 'run-1', cursor)
        const applied = applyTranscriptUpdate(held, update)
        expect(applied).not.toBeNull()
        held = applied!
        cursor = update.cursor
        expect(held).toEqual(readSessionMessages(spacePath, 'app-1', 'run-1'))
      }
    }
  })

  it('answers with the whole transcript to a cursor from a history that was rewritten', () => {
    writeFileSync(filePath, linesOf(LOGS[0].slice(0, 20), 1))
    const first = readSessionUpdate(spacePath, 'app-1', 'run-1', '')
    writeFileSync(filePath, linesOf(LOGS[1].slice(0, 25), 2))
    const update = readSessionUpdate(spacePath, 'app-1', 'run-1', first.cursor)
    expect(update.keep).toBeUndefined()
    expect(update.messages).toEqual(readSessionMessages(spacePath, 'app-1', 'run-1'))
  })

  it('refuses an update that does not fit what the reader holds', () => {
    writeFileSync(filePath, linesOf(LOGS[2], 3))
    const first = readSessionUpdate(spacePath, 'app-1', 'run-1', '')
    appendFileSync(filePath, linesOf([{ _ts: ts(1), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'more' }] } }], 4))
    const update = readSessionUpdate(spacePath, 'app-1', 'run-1', first.cursor)
    expect(update.keep).toBeGreaterThan(0)
    expect(applyTranscriptUpdate([], update)).toBeNull()
  })

  it('omits the cursor when there is no file', () => {
    expect(readSessionUpdate(spacePath, 'app-1', 'run-1', '')).toEqual({ cursor: '', messages: [] })
  })

  it('serves incremental reads to a reader that comes after whole reads of the same file', () => {
    writeFileSync(filePath, linesOf(LOGS[6], 8))
    const whole = readSessionMessages(spacePath, 'app-1', 'run-1')
    const first = readSessionUpdate(spacePath, 'app-1', 'run-1', '')
    expect(first.messages).toEqual(whole)
    expect(readSessionUpdate(spacePath, 'app-1', 'run-1', first.cursor)).toMatchObject({ keep: whole.length, messages: [] })
    appendFileSync(filePath, linesOf(LOGS[7].slice(0, 12), 9))
    const update = readSessionUpdate(spacePath, 'app-1', 'run-1', first.cursor)
    expect(update.keep).toBeGreaterThan(0)
    expect(applyTranscriptUpdate(first.messages, update)).toEqual(readSessionMessages(spacePath, 'app-1', 'run-1'))
  })
})

describe('incremental reads of a large run transcript', () => {
  /**
   * A first line past the single-parse limit, so the file is read through
   * boundaries, uncached. A record written again starts with a line of its own
   * time, as a real one does (`at`).
   */
  const fill = (at = 0) => JSON.stringify({ _ts: ts(at), type: 'user', _isTrigger: true, message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(FULL_PARSE_MAX_BYTES + 1024) }] } })
  const init = (n: number): StoredEvent => ({ _ts: ts(n), type: 'system', subtype: 'init' })
  const say = (n: number, text: string): StoredEvent => ({ _ts: ts(n), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const ask = (n: number, inputId: string): StoredEvent => ({ _ts: ts(n), type: 'user', _isTrigger: true, _inputId: inputId, message: { role: 'user', content: [{ type: 'text', text: `ask ${n}` }] } })
  const bytes = (update: object) => Buffer.byteLength(JSON.stringify(update))

  it('after the first read, sends only what changed: nothing, one line, a segment', () => {
    writeFileSync(filePath, `${fill()}\n${linesOf([init(1), say(2, 'one'), { _ts: ts(3), type: 'result', result: 'one' }, ask(4, 'in-4'), init(5), say(6, 'two')], 1)}`)
    const first = readSessionUpdate(spacePath, 'app-1', 'run-1', '')
    expect(first.cursor).not.toBe('')
    let held = applyTranscriptUpdate<TranscriptMessage>([], first)!
    expect(held).toEqual(readSessionMessages(spacePath, 'app-1', 'run-1'))

    const unchanged = readSessionUpdate(spacePath, 'app-1', 'run-1', first.cursor)
    expect(unchanged.keep).toBe(held.length)
    expect(unchanged.messages).toEqual([])
    expect(bytes(unchanged)).toBeLessThan(1024)

    appendFileSync(filePath, linesOf([say(7, 'three')], 2))
    const oneLine = readSessionUpdate(spacePath, 'app-1', 'run-1', unchanged.cursor)
    expect(oneLine.keep).toBeGreaterThan(0)
    expect(bytes(oneLine)).toBeLessThan(64 * 1024)
    held = applyTranscriptUpdate(held, oneLine)!
    expect(held).toEqual(readSessionMessages(spacePath, 'app-1', 'run-1'))

    appendFileSync(filePath, linesOf([{ _ts: ts(8), type: 'result', result: 'three' }, ask(9, 'in-9'), init(10), say(11, 'four'), say(12, 'five')], 3))
    const segment = readSessionUpdate(spacePath, 'app-1', 'run-1', oneLine.cursor)
    expect(segment.keep).toBeGreaterThan(0)
    expect(bytes(segment)).toBeLessThan(64 * 1024)
    held = applyTranscriptUpdate(held, segment)!
    expect(held).toEqual(readSessionMessages(spacePath, 'app-1', 'run-1'))
  })

  it('answers whole when a stop marked a message from before the turn it reads from', () => {
    writeFileSync(filePath, `${fill()}\n${linesOf([init(1), ask(2, 'in-2'), say(3, 'working'), { _ts: ts(4), type: 'result', result: 'done' }, ask(5, 'in-5'), init(6), say(7, 'next')], 1)}`)
    const first = readSessionUpdate(spacePath, 'app-1', 'run-1', '')
    const held = applyTranscriptUpdate<TranscriptMessage>([], first)!
    appendFileSync(filePath, linesOf([{ _ts: ts(8), type: 'input_outcome', _inputId: 'in-2', outcome: 'stopped' }], 2))
    const update = readSessionUpdate(spacePath, 'app-1', 'run-1', first.cursor)
    expect(update.keep).toBeUndefined()
    const whole = readSessionMessages(spacePath, 'app-1', 'run-1')
    expect(applyTranscriptUpdate(held, update)).toEqual(whole)
    expect(whole.find(message => message.metadata?.inputOutcome === 'stopped')).toBeTruthy()
  })

  it('answers whole to a cursor from before the file was rewritten', () => {
    writeFileSync(filePath, `${fill()}\n${linesOf([init(1), say(2, 'old')], 1)}`)
    const first = readSessionUpdate(spacePath, 'app-1', 'run-1', '')
    // Written again as a cleared chat is: the same file, new content with its own times.
    writeFileSync(filePath, `${fill(1)}\n${linesOf([init(5), say(6, 'new'), say(7, 'more')], 2)}`)
    const update = readSessionUpdate(spacePath, 'app-1', 'run-1', first.cursor)
    expect(update.keep).toBeUndefined()
    expect(update.messages).toEqual(readSessionMessages(spacePath, 'app-1', 'run-1'))
  })

  it('a reader polling a growing large log stays equal to the whole transcript', () => {
    let incremental = 0
    for (const logIndex of [8, 9, 10]) {
      const events = LOGS[logIndex]
      const next = random(logIndex + 99)
      writeFileSync(filePath, `${fill(logIndex)}\n`)
      let held: TranscriptMessage[] = []
      let cursor = ''
      let at = 0
      while (at < events.length) {
        const step = 1 + Math.floor(next() * 8)
        appendFileSync(filePath, linesOf(events.slice(at, at + step), at))
        at += step
        const update = readSessionUpdate(spacePath, 'app-1', 'run-1', cursor)
        if (update.keep !== undefined) {
          incremental++
          expect(bytes(update)).toBeLessThan(FULL_PARSE_MAX_BYTES / 4)
        }
        const applied = applyTranscriptUpdate(held, update)
        expect(applied).not.toBeNull()
        held = applied!
        cursor = update.cursor
        expect(held).toEqual(readSessionMessages(spacePath, 'app-1', 'run-1'))
      }
    }
    expect(incremental).toBeGreaterThan(20)
  })
})

describe('conversion from a native-turn checkpoint', () => {
  it('equals the whole conversion from that checkpoint on, at every checkpoint', () => {
    let checked = 0
    for (const events of LOGS) {
      const lines = events.map((_, i) => i * 2 + 1)
      const whole = convertEventsToTranscript(events, lines, { checkpoints: true })
      for (const checkpoint of whole.checkpoints ?? []) {
        const tail = convertEventsToTranscript(events.slice(checkpoint.eventIndex), lines.slice(checkpoint.eventIndex), { seed: checkpoint.seed })
        expect(tail.messages).toEqual(whole.messages.slice(checkpoint.messageCount))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('reads a large transcript from a message on without reading what precedes the last boundary', () => {
    const fill = JSON.stringify({ _ts: ts(0), type: 'user', _isTrigger: true, message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(FULL_PARSE_MAX_BYTES + 1024) }] } })
    writeFileSync(filePath, `${fill}\n${linesOf(LOGS[3], 5)}`)
    const whole = readSessionMessages(spacePath, 'app-1', 'run-1')
    for (const from of [1, Math.floor(whole.length / 2), whole.length - 2, whole.length]) {
      expect(readSessionMessagesFrom(spacePath, 'app-1', 'run-1', from)).toEqual(whole.slice(from))
    }

    appendFileSync(filePath, linesOf(LOGS[4], 6))
    const grown = readSessionMessages(spacePath, 'app-1', 'run-1')
    const from = whole.length - 1
    // Break the first line in place: a whole read would now skip it and shift
    // every later message; a tail read never reaches it.
    const fd = openSync(filePath, 'r+')
    try {
      writeSync(fd, Buffer.from('"'), 0, 1, 1000)
    } finally {
      closeSync(fd)
    }
    expect(readSessionMessagesFrom(spacePath, 'app-1', 'run-1', from)).toEqual(grown.slice(from))
    expect(readSessionMessages(spacePath, 'app-1', 'run-1').length).toBe(grown.length - 1)
  })

  it('the latest boundaries alone equal the last of all of them, stopped inputs included', () => {
    let compared = 0
    for (const events of LOGS) {
      const all = convertEventsToTranscript(events, undefined, { checkpoints: true }).checkpoints ?? []
      const latest = convertEventsToTranscript(events, undefined, { checkpoints: { latest: 3 } }).checkpoints ?? []
      expect(latest).toEqual(all.slice(-3))
      if (latest.some(checkpoint => checkpoint.seed.stoppedInputs?.length)) compared++
    }
    expect(compared).toBeGreaterThan(3)
  })

  it('reads a small transcript from the cached whole parse', () => {
    writeFileSync(filePath, linesOf(LOGS[5], 7))
    const whole = readSessionMessages(spacePath, 'app-1', 'run-1')
    expect(readSessionMessagesFrom(spacePath, 'app-1', 'run-1', 3)).toEqual(whole.slice(3))
    expect(readSessionMessagesFrom(spacePath, 'app-1', 'run-1', 0)).toEqual(whole)
    expect(readFileSync(filePath, 'utf8').length).toBeGreaterThan(0)
  })
})
