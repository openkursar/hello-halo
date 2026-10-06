/**
 * A turn stopped before the model produced anything leaves no blank reply:
 * its placeholder is removed, and the conversation list's preview is the
 * latest message that has text. Replies with anything in them stay.
 *
 * The service is real; only its IO boundaries (fs, space registry, config,
 * KB seed) are mocked as an in-memory disk, as in
 * conversation-update-message-by-id.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => {
  const files = new Map<string, string>()
  return {
    __disk: files,
    // A directory exists while it holds a file, so the index can be rebuilt by a scan.
    existsSync: (p: string) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    readFileSync: (p: string) => {
      const data = files.get(p)
      if (data === undefined) throw new Error(`ENOENT: ${p}`)
      return data
    },
    writeFileSync: (p: string, data: string) => { files.set(p, data) },
    mkdirSync: () => undefined,
    readdirSync: (p: string) => [...files.keys()].filter((k) => k.startsWith(p)).map((k) => k.split('/').pop() as string),
    rmSync: (p: string) => { files.delete(p) },
    renameSync: (from: string, to: string) => {
      const data = files.get(from)
      if (data === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, data)
    },
  }
})
vi.mock('../../../src/main/services/space.service', () => ({
  getSpace: (spaceId: string) => ({ id: spaceId, path: `/spaces/${spaceId}`, isTemp: false }),
  touchSpaceActivity: () => undefined,
}))
vi.mock('../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [], resolveSourcesForReadPaths: () => [] }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getConfig: () => undefined }))
vi.mock('../../../src/main/services/notification.service', () => ({ notifyTaskComplete: vi.fn() }))

import {
  createConversation,
  getConversation,
  addMessage,
  updateLastMessage,
  removeEmptyReplyPlaceholder,
  listConversations,
} from '../../../src/main/services/conversation.service'
import { createConversationSink } from '../../../src/main/services/agent/conversation-sink'
import type { StreamResult } from '../../../src/main/services/agent/stream-processor'
import type { Thought } from '../../../src/main/services/agent/types'

let spaceSeq = 0
let SPACE = 'space-0'

const marker = (type: Thought['type']): Thought => ({ id: `${type}-1`, type, content: type === 'system' ? 'Connected | Model: m' : '', timestamp: new Date().toISOString() })

function streamResult(overrides: Partial<StreamResult> = {}): StreamResult {
  return {
    finalContent: '',
    hasMeaningfulContent: false,
    thoughts: [marker('system')],
    tokenUsage: null,
    capturedSessionId: undefined,
    isInterrupted: true,
    wasAborted: true,
    hasErrorThought: false,
    errorThought: undefined,
    reachedMaxTurns: false,
    firstEventReceived: true,
    drainTimedOut: false,
    ...overrides,
  } as StreamResult
}

/** A sent message and the reply placeholder its turn starts with. */
function startTurn(text: string) {
  const conversation = createConversation(SPACE)
  addMessage(SPACE, conversation.id, { role: 'user', content: text })
  const sink = createConversationSink(SPACE, conversation.id)
  sink.onTurnStart?.()
  return { id: conversation.id, sink }
}

const messages = (id: string) => getConversation(SPACE, id)!.messages
/** The list line, read once per space: the first read builds the index from the files. */
const preview = (id: string) => listConversations(SPACE).find(meta => meta.id === id)?.preview

beforeEach(() => {
  vi.clearAllMocks()
  SPACE = `space-${++spaceSeq}`
})

describe('a turn that produced nothing', () => {
  it('leaves only the user message, however often it happens, and the preview shows that message', () => {
    const { id, sink } = startTurn('Summarize the report')
    sink.onTurnComplete?.(streamResult())
    for (let i = 0; i < 2; i++) {
      addMessage(SPACE, id, { role: 'user', content: `Try again ${i}` })
      sink.onTurnStart?.()
      sink.onTurnComplete?.(streamResult({ thoughts: [marker('system'), marker('result')] }))
    }
    expect(messages(id).map(m => [m.role, m.content])).toEqual([
      ['user', 'Summarize the report'], ['user', 'Try again 0'], ['user', 'Try again 1'],
    ])
    expect(preview(id)).toBe('Try again 1')
  })

  it('keeps replies that have text, thinking or an error', () => {
    const thinking = startTurn('Think first')
    thinking.sink.onTurnComplete?.(streamResult({ thoughts: [marker('system'), { ...marker('thinking'), content: 'Considering…' }] }))
    expect(messages(thinking.id).at(-1)).toMatchObject({ role: 'assistant', content: '' })
    expect(messages(thinking.id).at(-1)?.thoughtsSummary?.count).toBe(2)

    const partial = startTurn('Write it')
    partial.sink.onTurnComplete?.(streamResult({ finalContent: 'Half a reply', hasMeaningfulContent: true }))
    expect(messages(partial.id).at(-1)).toMatchObject({ role: 'assistant', content: 'Half a reply' })

    const failed = startTurn('Run it')
    failed.sink.onTurnError?.(new Error('Provider refused'), true, streamResult())
    expect(messages(failed.id).at(-1)).toMatchObject({ role: 'assistant', error: 'Provider refused' })
  })
})

describe('removeEmptyReplyPlaceholder', () => {
  it('removes only an empty reply that is the last message', () => {
    const conversation = createConversation(SPACE)
    addMessage(SPACE, conversation.id, { role: 'user', content: 'hello' })
    addMessage(SPACE, conversation.id, { role: 'assistant', content: '', toolCalls: [] })
    addMessage(SPACE, conversation.id, { role: 'user', content: 'typed while it ran', source: 'injection' })
    expect(removeEmptyReplyPlaceholder(SPACE, conversation.id)).toBe(false)
    expect(messages(conversation.id)).toHaveLength(3)

    const answered = createConversation(SPACE)
    addMessage(SPACE, answered.id, { role: 'user', content: 'hello' })
    addMessage(SPACE, answered.id, { role: 'assistant', content: '', toolCalls: [] })
    updateLastMessage(SPACE, answered.id, { error: 'Provider refused' })
    expect(removeEmptyReplyPlaceholder(SPACE, answered.id)).toBe(false)
    expect(removeEmptyReplyPlaceholder(SPACE, 'missing')).toBe(false)

    const userLast = createConversation(SPACE)
    addMessage(SPACE, userLast.id, { role: 'user', content: '' })
    expect(removeEmptyReplyPlaceholder(SPACE, userLast.id)).toBe(false)
  })

  it('leaves the preview on the latest message with text even when an older blank reply remains', () => {
    const conversation = createConversation(SPACE)
    addMessage(SPACE, conversation.id, { role: 'user', content: 'Plan the launch' })
    addMessage(SPACE, conversation.id, { role: 'assistant', content: '', toolCalls: [] })
    updateLastMessage(SPACE, conversation.id, { thoughts: [marker('system')] })
    expect(preview(conversation.id)).toBe('Plan the launch')
  })
})
