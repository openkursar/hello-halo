/**
 * Merging a re-read transcript into what the view already shows: rows keep
 * their identity, an optimistic message keeps its bubble when its persisted
 * twin arrives, and paged-in history is not thrown away by a re-read.
 */
import { describe, it, expect } from 'vitest'
import type { Message } from '../../../../src/renderer/types'
import {
  createPendingUserMessage,
  isPendingMessage,
  prependOlder,
  reconcileTranscript,
} from '../../../../src/renderer/stores/chat/backend/reconcile'
import { messageRowKey, messageRowKeys } from '../../../../src/renderer/utils/message-row-key'
import { windowAfterKeysChange } from '../../../../src/renderer/components/chat/transcript/useHistoryWindow'

function msg(id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { id, role, content, timestamp: `2026-09-01T10:00:${id.replace(/\D/g, '').padStart(2, '0')}.000Z`, ...extra }
}

describe('reconcileTranscript', () => {
  it('reuses the very object of a message that did not change', () => {
    const a = msg('session-msg-1', 'user', 'hi')
    const b = msg('session-msg-2', 'assistant', 'hello')
    const { messages } = reconcileTranscript([a, b], [{ ...a }, { ...b }], { dropUnconfirmed: true })
    expect(messages[0]).toBe(a)
    expect(messages[1]).toBe(b)
  })

  it('keeps the bubble identity of a pending message when its persisted twin arrives', () => {
    const pending = createPendingUserMessage('build me a site', undefined)
    const cached = [msg('session-msg-1', 'user', 'earlier'), pending]
    const fresh = [
      msg('session-msg-1', 'user', 'earlier'),
      msg('session-msg-3', 'user', 'build me a site'),
      msg('session-msg-4', 'assistant', 'done'),
    ]

    const { messages } = reconcileTranscript(cached, fresh, { dropUnconfirmed: true })

    expect(messages.map(m => m.id)).toEqual(['session-msg-1', 'session-msg-3', 'session-msg-4'])
    expect(messages.some(isPendingMessage)).toBe(false)
    expect(messageRowKey(messages[1])).toBe(pending.id)
    expect(messageRowKey(messages[2])).toBe('session-msg-4')
  })

  it('matches each pending message to one persisted message only', () => {
    const first = createPendingUserMessage('again', undefined)
    const second = createPendingUserMessage('again', undefined)
    const fresh = [msg('session-msg-1', 'user', 'again'), msg('session-msg-2', 'assistant', 'ok'), msg('session-msg-3', 'user', 'again')]

    const { messages } = reconcileTranscript([first, second], fresh, { dropUnconfirmed: true })

    expect(messageRowKey(messages[0])).toBe(first.id)
    expect(messageRowKey(messages[2])).toBe(second.id)
  })

  it('holds a pending message the reader has not written yet while a turn is running', () => {
    const pending = createPendingUserMessage('not on disk yet', undefined)
    const { messages } = reconcileTranscript([msg('session-msg-1', 'user', 'old'), pending], [msg('session-msg-1', 'user', 'old')], { dropUnconfirmed: false })
    expect(messages.map(m => m.id)).toEqual(['session-msg-1', pending.id])
  })

  it('drops an unconfirmed pending message once the turn is over', () => {
    const pending = createPendingUserMessage('rewritten by the engine', undefined)
    const { messages } = reconcileTranscript([pending], [msg('session-msg-1', 'user', 'something else')], { dropUnconfirmed: true })
    expect(messages.map(m => m.id)).toEqual(['session-msg-1'])
  })

  it('keeps thoughts the view already loaded when the read lists them as unloaded', () => {
    const loaded = msg('session-msg-2', 'assistant', 'done', {
      thoughts: [{ id: 't1', type: 'thinking', content: 'hmm', timestamp: 't' }],
      thoughtsSummary: { count: 1, types: { thinking: 1 } },
    })
    const unloaded = { ...loaded, thoughts: null }

    const { messages } = reconcileTranscript([loaded], [unloaded], { dropUnconfirmed: true })

    expect(messages[0]).toBe(loaded)
  })

  it('replaces a message whose content grew, keeping its row identity', () => {
    const prior = msg('session-msg-2', 'assistant', 'par', { clientKey: 'row-1' })
    const { messages } = reconcileTranscript([prior], [msg('session-msg-2', 'assistant', 'partial reply')], { dropUnconfirmed: true })
    expect(messages[0].content).toBe('partial reply')
    expect(messageRowKey(messages[0])).toBe('row-1')
  })

  it('keeps older history the reader paged in before the fresh window', () => {
    const older = [msg('session-msg-1', 'user', 'a'), msg('session-msg-2', 'assistant', 'b')]
    const tail = [msg('session-msg-3', 'user', 'c'), msg('session-msg-4', 'assistant', 'd')]
    const fresh = [tail[0], tail[1], msg('session-msg-5', 'user', 'e')]

    const result = reconcileTranscript([...older, ...tail], fresh, { dropUnconfirmed: true })

    expect(result.keptOlder).toBe(true)
    expect(result.messages.map(m => m.id)).toEqual(['session-msg-1', 'session-msg-2', 'session-msg-3', 'session-msg-4', 'session-msg-5'])
  })

  it('does not keep older history when the fresh window no longer overlaps what was loaded', () => {
    const cached = [msg('session-msg-1', 'user', 'a'), msg('session-msg-2', 'assistant', 'b')]
    const fresh = [msg('session-msg-9', 'user', 'z')]

    const result = reconcileTranscript(cached, fresh, { dropUnconfirmed: true })

    expect(result.keptOlder).toBe(false)
    expect(result.messages.map(m => m.id)).toEqual(['session-msg-9'])
  })
})

describe('prependOlder', () => {
  it('puts an older page in front and skips ids already loaded', () => {
    const loaded = [msg('session-msg-5', 'user', 'e'), msg('session-msg-6', 'assistant', 'f')]
    const page = [msg('session-msg-3', 'user', 'c'), msg('session-msg-5', 'user', 'e')]
    expect(prependOlder(loaded, page).map(m => m.id)).toEqual(['session-msg-3', 'session-msg-5', 'session-msg-6'])
  })
})

describe('row keys', () => {
  it('are unique even when a source repeats an id', () => {
    const keys = messageRowKeys([msg('x', 'user', 'a'), msg('x', 'assistant', 'b'), msg('y', 'user', 'c')])
    expect(new Set(keys).size).toBe(3)
    expect(keys[0]).toBe('x')
  })
})

describe('history window over a list that grew at the front', () => {
  it('follows the rows it was showing instead of the row numbers', () => {
    const before = ['m5', 'm6', 'm7', 'm8']
    const after = ['m2', 'm3', 'm4', ...before]
    const next = windowAfterKeysChange({ start: 1, count: before.length, firstKey: 'm5' }, after, 40)
    // the same rows stay mounted: what was row 1 is now row 4
    expect(next.start).toBe(4)
    expect(next.prepended).toBe(3)
  })

  it('treats an append as an append', () => {
    const next = windowAfterKeysChange({ start: 2, count: 4, firstKey: 'a' }, ['a', 'b', 'c', 'd', 'e'], 40)
    expect(next.start).toBe(2)
    expect(next.prepended).toBe(0)
  })

  it('starts from the tail when the list was empty', () => {
    const keys = Array.from({ length: 100 }, (_, i) => `k${i}`)
    expect(windowAfterKeysChange({ start: 0, count: 0, firstKey: null }, keys, 40).start).toBe(60)
  })
})
