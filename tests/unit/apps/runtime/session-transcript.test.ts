/**
 * Unit tests for the digital-human transcript reader in apps/runtime/session-store:
 * stable message ids, newest-first paging, on-demand thoughts, provenance
 * mapping and the parse cache.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  convertEventsToMessages,
  openSessionWriter,
  readSessionMessages,
  readSessionMessageThoughts,
  readSessionTranscript,
  type StoredEvent,
} from '../../../../src/main/apps/runtime/session-store'

const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()

const user = (text: string, n: number, extra: Record<string, unknown> = {}): StoredEvent => ({
  _ts: ts(n),
  type: 'user',
  _isTrigger: true,
  ...extra,
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const assistant = (content: unknown[], n: number): StoredEvent => ({
  _ts: ts(n),
  type: 'assistant',
  message: { role: 'assistant', content },
})
const text = (t: string) => ({ type: 'text', text: t })
const thinking = (t: string) => ({ type: 'thinking', thinking: t })
const toolUse = (id: string, name = 'Bash') => ({ type: 'tool_use', id, name, input: { id } })
const toolResult = (id: string, n: number): StoredEvent => ({
  _ts: ts(n),
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `out-${id}` }] },
})
const result = (t: string, n: number): StoredEvent => ({ _ts: ts(n), type: 'result', result: t })

/** A run with a tool-heavy first turn, an injection, and a second turn. */
function sampleRun(): StoredEvent[] {
  return [
    user('hello', 1),
    assistant([], 2),
    assistant([thinking('plan')], 3),
    assistant([toolUse('t1')], 4),
    toolResult('t1', 5),
    user('actually, also this', 6, { _source: 'injection' }),
    assistant([text('answer')], 7),
    result('answer', 8),
    user('second question', 9),
    assistant([text('second answer')], 10),
  ]
}

describe('message id stability', () => {
  it('keeps every already-visible message id (and role) in every longer prefix of the log', () => {
    const events = sampleRun()
    const visible = new Map<string, string>()
    for (let k = 1; k <= events.length; k++) {
      const current = new Map(convertEventsToMessages(events.slice(0, k)).map(m => [m.id, m.role]))
      for (const [id, role] of visible) expect(current.get(id), `prefix ${k}: ${id}`).toBe(role)
      for (const [id, role] of current) visible.set(id, role)
    }
  })

  it('keeps an in-flight assistant message id while it grows', () => {
    const events = [user('q', 1), assistant([thinking('a')], 2), assistant([toolUse('t1')], 3)]
    const early = convertEventsToMessages(events)
    const grown = convertEventsToMessages([...events, toolResult('t1', 4), assistant([text('done')], 5)])
    expect(early.map(m => m.id)).toEqual(grown.map(m => m.id))
    expect(grown[1].content).toBe('done')
  })

  it('derives ids from the file line of the first event, not from message count', () => {
    const messages = convertEventsToMessages(sampleRun(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // assistant turn 1 starts at its first contributing event (line 3, the thinking block)
    expect(messages.map(m => m.id)).toEqual([
      'session-msg-1',
      'session-msg-3',
      'session-msg-6',
      'session-msg-7',
      'session-msg-9',
      'session-msg-10',
    ])
  })

  it('assigns unique ids', () => {
    const ids = convertEventsToMessages(sampleRun()).map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('an assistant turn whose only content is the result envelope starts at the result line', () => {
    const messages = convertEventsToMessages([user('q', 1), assistant([], 2), result('final', 3)])
    expect(messages.map(m => [m.role, m.id])).toEqual([
      ['user', 'session-msg-1'],
      ['assistant', 'session-msg-3'],
    ])
  })

  describe('reading a file', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'halo-transcript-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    const logPath = () => join(dir, '.halo', 'apps', 'app-1', 'runs', 'run-1.jsonl')

    it('counts blank and malformed lines so later ids do not shift', () => {
      const writer = openSessionWriter(dir, 'app-1', 'run-1')
      writer.writeTrigger('first')
      appendFileSync(logPath(), '\n{not json\n', 'utf8')
      writer.writeTrigger('second')

      expect(readSessionMessages(dir, 'app-1', 'run-1').map(m => m.id)).toEqual([
        'session-msg-1',
        'session-msg-4',
      ])
    })

    it('reports unreadable lines in the middle of a file, but not a torn final line', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const writer = openSessionWriter(dir, 'app-1', 'run-1')
        writer.writeTrigger('first')
        appendFileSync(logPath(), '{not json\n', 'utf8')
        writer.writeTrigger('second')
        appendFileSync(logPath(), '{"_ts":"2026', 'utf8')

        readSessionMessages(dir, 'app-1', 'run-1')

        expect(warn).toHaveBeenCalledTimes(1)
        expect(String(warn.mock.calls[0][0])).toMatch(/1 unreadable line.*first: line 2/)
      } finally {
        warn.mockRestore()
      }
    })

    it('ignores a torn final line and gives the same ids once it completes', () => {
      const writer = openSessionWriter(dir, 'app-1', 'run-1')
      writer.writeTrigger('question')
      const line = JSON.stringify(assistant([text('answer')], 2))
      appendFileSync(logPath(), line.slice(0, 20), 'utf8')

      const torn = readSessionMessages(dir, 'app-1', 'run-1')
      expect(torn.map(m => m.role)).toEqual(['user'])

      appendFileSync(logPath(), line.slice(20) + '\n', 'utf8')
      const whole = readSessionMessages(dir, 'app-1', 'run-1')
      expect(whole.map(m => m.role)).toEqual(['user', 'assistant'])
      expect(whole[0].id).toBe(torn[0].id)
    })
  })
})

describe('paged reads', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halo-transcript-'))
    const writer = openSessionWriter(dir, 'app-1', 'run-1')
    for (let i = 1; i <= 10; i++) {
      writer.writeTrigger(`q${i}`)
      writer.writeEvent({ type: 'assistant', message: { role: 'assistant', content: [text(`a${i}`)] } })
    }
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const read = (request = {}) => readSessionTranscript(dir, 'app-1', 'run-1', request)
  const contents = (page: { messages: { content: string }[] }) => page.messages.map(m => m.content)

  it('returns the newest page oldest→newest', () => {
    const page = read({ limit: 4 })
    expect(contents(page)).toEqual(['q9', 'a9', 'q10', 'a10'])
    expect(page.hasMoreBefore).toBe(true)
    expect(page.total).toBe(20)
    expect(page.cursor).toBe(page.messages[0].id)
  })

  it('walks backwards with the cursor without gaps or overlap', () => {
    const seen: string[] = []
    let request: { before?: string; limit: number } = { limit: 7 }
    for (let guard = 0; guard < 10; guard++) {
      const page = read(request)
      seen.unshift(...contents(page))
      if (!page.hasMoreBefore) break
      request = { before: page.cursor!, limit: 7 }
    }
    expect(seen).toEqual(Array.from({ length: 10 }, (_, i) => [`q${i + 1}`, `a${i + 1}`]).flat())
  })

  it('reports no older messages for the first page of a short transcript', () => {
    const page = read({ limit: 200 })
    expect(page.messages).toHaveLength(20)
    expect(page.hasMoreBefore).toBe(false)
  })

  it('newer appends do not disturb a cursor held by the reader', () => {
    const first = read({ limit: 4 })
    openSessionWriter(dir, 'app-1', 'run-1').writeTrigger('q11')
    const older = read({ before: first.cursor!, limit: 2 })
    expect(contents(older)).toEqual(['q8', 'a8'])
    expect(older.total).toBe(21)
  })

  it('returns an empty page for a cursor that no longer exists', () => {
    const page = read({ before: 'session-msg-9999' })
    expect(page).toEqual({ messages: [], hasMoreBefore: false, cursor: null, total: 20 })
  })

  it('returns an empty page for a missing file', () => {
    expect(readSessionTranscript(dir, 'app-1', 'nope')).toEqual({
      messages: [],
      hasMoreBefore: false,
      cursor: null,
      total: 0,
    })
  })
})

describe('thoughts on demand', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halo-transcript-'))
    const writer = openSessionWriter(dir, 'app-1', 'run-1')
    writer.writeTrigger('do it')
    writer.writeEvent(assistant([thinking('plan'), toolUse('t1')], 2))
    writer.writeEvent(toolResult('t1', 3))
    writer.writeEvent(assistant([text('finished')], 4))
    writer.writeTrigger('thanks')
    writer.writeEvent(assistant([text('welcome')], 6))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists messages with thoughts:null plus a summary, never the tool output', () => {
    const page = readSessionTranscript(dir, 'app-1', 'run-1')
    const [, work, , plain] = page.messages
    expect(work.thoughts).toBeNull()
    expect(work.thoughtsSummary).toMatchObject({ count: 2, types: { thinking: 1, tool_use: 1 } })
    expect(JSON.stringify(page)).not.toContain('out-t1')
    // A message without a thought process has none to load.
    expect(plain.thoughts).toBeUndefined()
    expect(plain.thoughtsSummary).toBeUndefined()
  })

  it('loads the thought process of one message by id', () => {
    const work = readSessionTranscript(dir, 'app-1', 'run-1').messages[1]
    const thoughts = readSessionMessageThoughts(dir, 'app-1', 'run-1', work.id)
    expect(thoughts.map(t => t.type)).toEqual(['thinking', 'tool_use'])
    expect(thoughts[1].toolResult?.output).toBe('out-t1')
  })

  it('answers with no thoughts for an unknown or thought-less message', () => {
    const page = readSessionTranscript(dir, 'app-1', 'run-1')
    expect(readSessionMessageThoughts(dir, 'app-1', 'run-1', 'session-msg-404')).toEqual([])
    expect(readSessionMessageThoughts(dir, 'app-1', 'run-1', page.messages[0].id)).toEqual([])
  })

  it('leaves the full read unchanged: readSessionMessages still carries thoughts', () => {
    const messages = readSessionMessages(dir, 'app-1', 'run-1')
    expect(messages[1].thoughts).toHaveLength(2)
  })

  it('does not let a page projection strip thoughts from the cached parse', () => {
    readSessionTranscript(dir, 'app-1', 'run-1')
    expect(readSessionMessages(dir, 'app-1', 'run-1')[1].thoughts).toHaveLength(2)
  })
})

describe('provenance', () => {
  it('reads an injection as a user message flagged with its source', () => {
    const [, injected] = convertEventsToMessages([user('a', 1), user('and this', 2, { _source: 'injection' })])
    expect(injected).toMatchObject({ role: 'user', source: 'injection', content: 'and this' })
    expect(injected.metadata).toBeUndefined()
  })

  it.each(['cross-conversation', 'cross-conversation-notice', 'team-message'] as const)(
    'reads source %s as a system message',
    source => {
      const [message] = convertEventsToMessages([user('from elsewhere', 1, { _source: source })])
      expect(message).toMatchObject({ role: 'system', source })
    }
  )

  it('carries cross-conversation provenance and drops unknown or mistyped fields', () => {
    const [message] = convertEventsToMessages([
      user('hi', 1, {
        _source: 'cross-conversation',
        _metadata: {
          fromConversationId: 'c-1',
          fromConversationTitle: 'Planning',
          summary: 'sync',
          correlationId: 'corr',
          forwardDepth: 2,
          bogus: 'x',
          teamId: 42,
        },
      }),
    ])
    expect(message.metadata).toEqual({
      fromConversationId: 'c-1',
      fromConversationTitle: 'Planning',
      summary: 'sync',
      correlationId: 'corr',
      forwardDepth: 2,
    })
  })

  it('ignores an unrecognised source and its metadata (an ordinary user turn)', () => {
    const [message] = convertEventsToMessages([
      user('hi', 1, { _source: 'martian', _metadata: { summary: 'x' } }),
    ])
    expect(message.role).toBe('user')
    expect(message.source).toBeUndefined()
    expect(message.metadata).toBeUndefined()
  })

  it('keeps a null member name (system-authored team notice)', () => {
    const [message] = convertEventsToMessages([
      user('turn ended', 1, { _source: 'team-message', _metadata: { teamId: 't', fromMemberName: null } }),
    ])
    expect(message.metadata).toEqual({ teamId: 't', fromMemberName: null })
  })

  it('merges team-origin metadata with provenance on the user record', () => {
    const [message] = convertEventsToMessages([
      user('hi', 1, {
        _teamOrigin: { kind: 'message', correlationId: 'd-1' },
        _source: 'team-message',
        _metadata: { teamName: 'Ops' },
      }),
    ])
    expect(message.metadata).toEqual({ teamTriggerKind: 'message', correlationId: 'd-1', teamName: 'Ops' })
  })

  it('does not leak provenance onto the assistant reply', () => {
    const messages = convertEventsToMessages([
      user('hi', 1, { _source: 'cross-conversation', _metadata: { fromConversationId: 'c' } }),
      assistant([text('ok')], 2),
    ])
    expect(messages[1]).toMatchObject({ role: 'assistant' })
    expect(messages[1].source).toBeUndefined()
    expect(messages[1].metadata).toBeUndefined()
  })

  describe('writer round trip', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'halo-transcript-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('persists _source/_metadata and reads them back', () => {
      const writer = openSessionWriter(dir, 'app-1', 'run-1')
      writer.writeTrigger('plain')
      writer.writeTrigger('raw text', undefined, undefined, {
        source: 'cross-conversation',
        metadata: { fromConversationId: 'c-9', fromConversationTitle: 'Other', forwardDepth: 1 },
      })
      writer.writeTrigger('inject', undefined, undefined, { source: 'injection' })

      const messages = readSessionMessages(dir, 'app-1', 'run-1')
      expect(messages.map(m => [m.role, m.source, m.content])).toEqual([
        ['user', undefined, 'plain'],
        ['system', 'cross-conversation', 'raw text'],
        ['user', 'injection', 'inject'],
      ])
      expect(messages[1].metadata).toEqual({
        fromConversationId: 'c-9',
        fromConversationTitle: 'Other',
        forwardDepth: 1,
      })
    })
  })
})

describe('parse cache', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halo-transcript-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('picks up appended events on the next read', () => {
    const writer = openSessionWriter(dir, 'app-1', 'run-1')
    writer.writeTrigger('one')
    expect(readSessionTranscript(dir, 'app-1', 'run-1').total).toBe(1)
    writer.writeTrigger('two')
    expect(readSessionTranscript(dir, 'app-1', 'run-1').total).toBe(2)
  })

  it('does not serve stale messages after the file is replaced (history cleared)', () => {
    const writer = openSessionWriter(dir, 'app-1', 'run-1')
    writer.writeTrigger('old conversation')
    expect(readSessionMessages(dir, 'app-1', 'run-1')).toHaveLength(1)

    rmSync(join(dir, '.halo', 'apps', 'app-1', 'runs', 'run-1.jsonl'))
    expect(readSessionMessages(dir, 'app-1', 'run-1')).toEqual([])

    openSessionWriter(dir, 'app-1', 'run-1').writeTrigger('new')
    expect(readSessionMessages(dir, 'app-1', 'run-1').map(m => m.content)).toEqual(['new'])
  })

  it('does not hand callers the cached array to mutate', () => {
    openSessionWriter(dir, 'app-1', 'run-1').writeTrigger('one')
    const first = readSessionMessages(dir, 'app-1', 'run-1')
    first.pop()
    expect(readSessionMessages(dir, 'app-1', 'run-1')).toHaveLength(1)
  })

  it('re-reads a file that was rewritten with different content', () => {
    openSessionWriter(dir, 'app-1', 'run-1').writeTrigger('AAAA')
    const path = join(dir, '.halo', 'apps', 'app-1', 'runs', 'run-1.jsonl')
    const before = readSessionMessages(dir, 'app-1', 'run-1')[0].content
    expect(before).toBe('AAAA')
    // Different size => new stamp, regardless of mtime granularity.
    writeFileSync(path, JSON.stringify(user('BBBBBB', 1)) + '\n', 'utf8')
    expect(readSessionMessages(dir, 'app-1', 'run-1')[0].content).toBe('BBBBBB')
  })
})
