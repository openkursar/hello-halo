/**
 * Retry notices: stream-processor turns the engine's `system` / `api_retry`
 * frames into `agent:api-retry`, keeps the pending retry on the session state
 * for clients that connect mid-wait, clears it the moment the resent request
 * answers (or the turn ends), and voids whatever the failed attempt left open.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
import { parseApiRetryMessage, snapshotApiRetry } from '../../../../src/main/services/agent/api-retry'
import type { SessionState } from '../../../../src/main/services/agent/types'

function newState(): SessionState {
  return { spaceId: 'space-1', conversationId: 'conv-1', thoughts: [], abortController: new AbortController() }
}

/** Runs the frames through processStream; `onFrame` observes state as each frame is handed over. */
async function run(sessionState: SessionState, messages: unknown[], onFrame?: (index: number) => void) {
  return processStream({
    v2Session: {
      send: vi.fn(),
      stream: () => (async function* () {
        for (let i = 0; i < messages.length; i++) {
          onFrame?.(i)
          yield messages[i]
        }
      })(),
    },
    sessionState,
    spaceId: 'space-1',
    conversationId: 'conv-1',
    messageContent: 'Hi',
    displayModel: 'm',
    abortController: sessionState.abortController,
    t0: Date.now(),
    callbacks: {},
  } as unknown as Parameters<typeof processStream>[0])
}

const init = { type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [] }
const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's' }
const retryFrame = (attempt: number, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'api_retry',
  attempt,
  max_retries: 10,
  retry_delay_ms: 4000,
  error_status: 429,
  error: 'rate_limit',
  error_message: 'Go usage limit exceeded',
  session_id: 's',
  ...extra,
})
const streamEvent = (event: Record<string, unknown>) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 's' })

const retryEvents = () => emitAgentEvent.mock.calls
  .filter(([channel]) => channel === 'agent:api-retry')
  .map(([, , , data]) => (data as { retry: unknown }).retry)

/** Thought ids of tool blocks, in the order the stream announced them. */
const toolThoughtIds = () => emitAgentEvent.mock.calls
  .filter(([channel, , , data]) =>
    channel === 'agent:thought' && (data as { thought?: { type?: string } }).thought?.type === 'tool_use')
  .map(([, , , data]) => (data as { thought: { id: string } }).thought.id)

beforeEach(() => emitAgentEvent.mockClear())

describe('parseApiRetryMessage', () => {
  it('maps the engine frame shared by Claude Code and the Halo SDK', () => {
    expect(parseApiRetryMessage(retryFrame(3))).toEqual({
      attempt: 3,
      maxRetries: 10,
      delayMs: 4000,
      errorStatus: 429,
      errorKind: 'rate_limit',
      errorMessage: 'Go usage limit exceeded',
    })
  })

  it('accepts a frame without a status or reason (connection failures, Claude Code)', () => {
    const parsed = parseApiRetryMessage({ ...retryFrame(1), error_status: null, error: 'unknown', error_message: undefined })
    expect(parsed).toEqual({ attempt: 1, maxRetries: 10, delayMs: 4000, errorStatus: null, errorKind: 'unknown' })
  })

  it('falls back to unknown for an error kind it does not know', () => {
    expect(parseApiRetryMessage(retryFrame(1, { error: 'something_new' }))?.errorKind).toBe('unknown')
  })

  it('rejects a malformed frame instead of showing garbage', () => {
    expect(parseApiRetryMessage({ ...retryFrame(1), attempt: 'two' })).toBeNull()
    expect(parseApiRetryMessage({ ...retryFrame(1), retry_delay_ms: -1 })).toBeNull()
    expect(parseApiRetryMessage({ type: 'system', subtype: 'init' })).toBeNull()
  })

  it('caps an oversized server reason', () => {
    const parsed = parseApiRetryMessage(retryFrame(1, { error_message: 'x'.repeat(2000) }))
    expect(parsed?.errorMessage).toHaveLength(500)
  })
})

describe('snapshotApiRetry', () => {
  it('reports the wait left, never below zero', () => {
    const state = parseApiRetryMessage(retryFrame(1))!
    expect(snapshotApiRetry({ state, retryAt: 10_000 }, 7_000).delayMs).toBe(3_000)
    expect(snapshotApiRetry({ state, retryAt: 10_000 }, 12_000).delayMs).toBe(0)
  })
})

describe('api_retry forwarding', () => {
  it('announces each retry and clears it once the resent request answers', async () => {
    const state = newState()
    const seen: Array<unknown> = []

    await run(state, [
      init,
      retryFrame(1),
      retryFrame(2),
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      result,
    ], (i) => { if (i === 3) seen.push(state.apiRetry?.state.attempt) })

    expect(retryEvents()).toEqual([
      expect.objectContaining({ attempt: 1, errorStatus: 429, errorMessage: 'Go usage limit exceeded' }),
      expect.objectContaining({ attempt: 2 }),
      null,
    ])
    expect(seen).toEqual([2])
    expect(state.apiRetry).toBeNull()
  })

  it('clears a retry still pending when the turn ends on the final failure', async () => {
    const state = newState()

    await run(state, [
      init,
      retryFrame(10),
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Go usage limit exceeded', session_id: 's' },
    ])

    expect(retryEvents()).toEqual([expect.objectContaining({ attempt: 10 }), null])
    expect(state.apiRetry).toBeNull()
  })

  it('ignores progress from a sub-agent while the main request is still waiting', async () => {
    const state = newState()
    const pendingAtEnd: Array<number | undefined> = []

    await run(state, [
      init,
      retryFrame(1),
      { type: 'assistant', message: { id: 'sub', content: [] }, parent_tool_use_id: 'tool-1', session_id: 's' },
      result,
    ], (i) => { if (i === 3) pendingAtEnd.push(state.apiRetry?.state.attempt) })

    expect(pendingAtEnd).toEqual([1])
  })

  it('emits nothing for a turn without retries', async () => {
    await run(newState(), [init, streamEvent({ type: 'message_start', message: { id: 'm1' } }), result])
    expect(retryEvents()).toEqual([])
  })
})

describe('abandoning the failed attempt', () => {
  it('closes its open thinking block and marks its unfinished tool call as never run', async () => {
    const state = newState()

    await run(state, [
      init,
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'half a thought' } }),
      streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' } }),
      retryFrame(1),
      result,
    ])

    const thinking = state.thoughts.find(t => t.type === 'thinking')!
    expect(thinking.isStreaming).toBe(false)
    expect(thinking.content).toBe('half a thought')

    const tool = state.thoughts.find(t => t.type === 'tool_use')!
    expect(tool.isStreaming).toBe(false)
    expect(tool.toolResult?.isError).toBe(true)

    const toolDeltas = emitAgentEvent.mock.calls.filter(
      ([channel, , , data]) => channel === 'agent:thought-delta' && (data as { thoughtId: string }).thoughtId === tool.id,
    )
    expect(toolDeltas.map(([, , , data]) => data)).toEqual([
      expect.objectContaining({ isToolInput: true, isComplete: true }),
      expect.objectContaining({ isToolResult: true }),
    ])
  })

  it('rolls back stopped tools and text before a resent request with a new tool ID', async () => {
    const state = newState()
    const outcome = await run(state, [
      init,
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'failed attempt' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'old-tool', name: 'Bash' } }),
      streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"old"}' } }),
      streamEvent({ type: 'content_block_stop', index: 1 }),
      retryFrame(1),
      streamEvent({ type: 'message_start', message: { id: 'm2' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'new-tool', name: 'Bash' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"new"}' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'new-tool', content: 'executed' }] }, session_id: 's' },
      streamEvent({ type: 'message_start', message: { id: 'm3' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fresh reply' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      { ...result, result: '' },
    ])

    const [oldThoughtId, newThoughtId] = toolThoughtIds()
    const oldTool = state.thoughts.find(t => t.id === oldThoughtId)!
    const newTool = state.thoughts.find(t => t.id === newThoughtId)!
    expect(oldTool.id).not.toBe(newTool.id)
    expect(oldTool.toolResult).toMatchObject({ isError: true, output: expect.stringContaining('Not run') })
    expect(newTool.toolResult).toMatchObject({ output: 'executed', isError: false })
    expect(outcome.finalContent).toBe('fresh reply')
    const messages = emitAgentEvent.mock.calls.filter(([channel]) => channel === 'agent:message').map(([, , , data]) => data)
    expect(messages).toContainEqual(expect.objectContaining({ content: '', isStreaming: false }))
  })

  it('leaves completed tool results intact and closes only unfinished parallel calls on retry', async () => {
    const state = newState()
    await run(state, [
      init,
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'executed', name: 'Bash' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'executed', content: 'real output' }] }, session_id: 's' },
      streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'unfinished', name: 'Bash' } }),
      streamEvent({ type: 'content_block_stop', index: 1 }),
      streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'still-open', name: 'Bash' } }),
      retryFrame(1),
      result,
    ])

    const [executedId, ...abandonedIds] = toolThoughtIds()
    expect(state.thoughts.find(t => t.id === executedId)?.toolResult).toMatchObject({ output: 'real output', isError: false })
    expect(abandonedIds).toHaveLength(2)
    for (const thoughtId of abandonedIds) {
      const thought = state.thoughts.find(t => t.id === thoughtId)!
      expect(thought.isStreaming).toBe(false)
      expect(thought.toolResult).toMatchObject({ isError: true, output: expect.stringContaining('Not run') })
      expect(emitAgentEvent.mock.calls.filter(([channel, , , data]) =>
        channel === 'agent:thought-delta' && (data as { thoughtId?: string; isToolResult?: boolean }).thoughtId === thought.id &&
        (data as { isToolResult?: boolean }).isToolResult)).toHaveLength(1)
    }
  })

  it('takes the partial text off the reply and keeps the resent answer only', async () => {
    const state = newState()

    const outcome = await run(state, [
      init,
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cut off mid-' } }),
      retryFrame(1),
      streamEvent({ type: 'message_start', message: { id: 'm2' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'complete answer' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's' },
    ])

    const resets = emitAgentEvent.mock.calls.filter(
      ([channel, , , data]) => channel === 'agent:message' && (data as { content?: string }).content === '' && !(data as { isNewTextBlock?: boolean }).isNewTextBlock,
    )
    expect(resets).toHaveLength(1)
    expect(outcome.finalContent).toBe('complete answer')
  })
})
