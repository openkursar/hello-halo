/**
 * With partial messages on, the halo engine leaves the answer out of its
 * aggregate `assistant` message (the text already went out as stream events)
 * and repeats it only in `result.result`. A digital human's chat shows the
 * answer both while the turn streams and when the conversation is reopened
 * from its stored events. Frames are those the bundled engine produced for a
 * thinking model's reply.
 */

import { describe, expect, it, vi } from 'vitest'

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('../../../../src/main/services/agent/mcp-manager', () => ({ broadcastMcpStatus: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-probe', () => ({ probeUnhealthyServers: vi.fn() }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../../../src/main/foundation/logging', () => ({ isDeveloperMode: () => false }))

import { processStream } from '../../../../src/main/services/agent/stream-processor'
import { convertEventsToMessages, type StoredEvent } from '../../../../src/main/apps/runtime/session-transcript'
import type { SessionState } from '../../../../src/main/services/agent/types'

const ANSWER = 'Answer 1: the body text.'
const streamEvent = (event: Record<string, unknown>) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 's' })

/** One turn as the halo engine reports it. */
const frames = [
  { type: 'system', subtype: 'session_state_changed', state: 'running', session_id: 's' },
  { type: 'system', subtype: 'init', model: 'glm-5.1', tools: [], mcp_servers: [], session_id: 's' },
  streamEvent({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'glm-5.1', content: [], usage: { input_tokens: 12, output_tokens: 1 }, stop_reason: null, stop_sequence: null } }),
  streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
  streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Thinking about turn 1.' } }),
  streamEvent({ type: 'content_block_stop', index: 0 }),
  streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
  streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer 1: ' } }),
  streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the body text.' } }),
  streamEvent({ type: 'content_block_stop', index: 1 }),
  streamEvent({ type: 'message_delta', delta: { type: 'message_delta', stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 20 } }),
  streamEvent({ type: 'message_stop' }),
  {
    type: 'assistant',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'glm-5.1', content: [{ type: 'thinking', thinking: 'Thinking about turn 1.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 20 } },
    parent_tool_use_id: null,
    session_id: 's',
  },
  { type: 'result', subtype: 'success', result: ANSWER, is_error: false, stop_reason: 'end_turn', session_id: 's' },
]

describe('a halo engine reply whose aggregate message carries no text', () => {
  it('shows the answer while the turn streams', async () => {
    const sessionState: SessionState = { spaceId: 'space-1', conversationId: 'conv-1', thoughts: [], abortController: new AbortController() }

    const result = await processStream({
      v2Session: { send: vi.fn(), stream: () => (async function* () { yield* frames })() },
      sessionState,
      spaceId: 'space-1',
      conversationId: 'conv-1',
      messageContent: 'Hi',
      displayModel: 'm',
      abortController: sessionState.abortController,
      t0: Date.now(),
      callbacks: {},
    } as unknown as Parameters<typeof processStream>[0])

    expect(result.finalContent).toBe(ANSWER)
    expect(result.hasMeaningfulContent).toBe(true)
    const completed = emitAgentEvent.mock.calls
      .filter(([channel, , , data]) => channel === 'agent:message' && (data as { isComplete?: boolean }).isComplete)
      .map(([, , , data]) => (data as { content: string }).content)
    expect(completed.at(-1)).toBe(ANSWER)
  })

  it('shows the answer when the chat is reopened from its stored events', () => {
    // Digital-human chats store the aggregate frames, not the stream events.
    const stored = frames
      .filter(frame => frame.type !== 'stream_event')
      .map((frame, i) => ({ ...frame, _ts: new Date(1_700_000_000_000 + i).toISOString() }) as StoredEvent)

    const messages = convertEventsToMessages(stored)

    const replies = messages.filter(message => message.role === 'assistant')
    expect(replies).toHaveLength(1)
    expect(replies[0].content).toBe(ANSWER)
    expect(replies[0].thoughts?.some(thought => thought.type === 'thinking')).toBe(true)
  })
})
