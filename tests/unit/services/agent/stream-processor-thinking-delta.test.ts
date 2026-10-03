/**
 * A thinking delta event carries the new text only. Sending the accumulated
 * text with every delta made the bytes on IPC and every WebSocket client grow
 * quadratically with the thinking block.
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
const streamEvent = (event: Record<string, unknown>) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 's' })

beforeEach(() => emitAgentEvent.mockClear())

describe('thinking deltas', () => {
  it('carry only the new text; the accumulated text goes out once, when the block completes', async () => {
    const pieces = ['Let me ', 'think about ', 'this carefully.']
    await run(newState(), [
      init,
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...pieces.map(thinking => streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } })),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      result,
    ])

    const deltas = emitAgentEvent.mock.calls
      .filter(([channel]) => channel === 'agent:thought-delta')
      .map(([, , , data]) => data as { delta?: string; content?: string; isComplete?: boolean })
    const streaming = deltas.filter(d => !d.isComplete)
    expect(streaming.map(d => d.delta)).toEqual(pieces)
    for (const d of streaming) expect(d).not.toHaveProperty('content')
    expect(deltas.filter(d => d.isComplete)).toEqual([expect.objectContaining({ content: pieces.join(''), isComplete: true })])
  })
})
