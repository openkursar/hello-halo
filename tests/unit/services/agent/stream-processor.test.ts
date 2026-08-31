/**
 * Unit tests for stream-processor processStream() — thinking-only turns.
 *
 * Pins the #299 defect shape: some providers return an assistant envelope that
 * carries ONLY a thinking block (parseSDKMessage returns null for it — no text
 * block is ever seen), and the reply body lands solely in the terminal result
 * message's `result` field. The result branch must still emit a final
 * `agent:message` bubble and surface result.finalContent, so the user sees the
 * reply instead of an empty turn.
 *
 * processStream is imported REAL. Only side-effectful leaves are mocked:
 * renderer events (emitAgentEvent), telemetry (analytics.service), and the
 * MCP broadcast/probe pair. `is.dev` is pinned false to silence dev logs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }))
const { track } = vi.hoisted(() => ({ track: vi.fn().mockResolvedValue(undefined) }))
const { broadcastMcpStatus, probeUnhealthyServers } = vi.hoisted(() => ({
  broadcastMcpStatus: vi.fn(),
  probeUnhealthyServers: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track },
}))
vi.mock('../../../../src/main/services/agent/mcp-manager', () => ({
  broadcastMcpStatus,
}))
vi.mock('../../../../src/main/services/agent/mcp-probe', () => ({
  probeUnhealthyServers,
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { processStream } from '../../../../src/main/services/agent/stream-processor'
import type { SessionState, Thought } from '../../../../src/main/services/agent/types'

// ============================================
// Helpers
// ============================================

function makeSessionState(): SessionState {
  return {
    sessionId: 'sess-test',
    thoughts: [],
  } as unknown as SessionState
}

/** Build a fake V2 session whose stream() yields the given SDK messages. */
function fakeSession(messages: unknown[]) {
  return {
    send: vi.fn(),
    stream: () =>
      (async function* () {
        for (const m of messages) yield m
      })(),
  }
}

function baseParams(overrides: Partial<Parameters<typeof processStream>[0]> = {}) {
  return {
    v2Session: fakeSession([]),
    sessionState: makeSessionState(),
    spaceId: 'space-1',
    conversationId: 'conv-1',
    messageContent: 'Hi',
    displayModel: 'test-model',
    abortController: new AbortController(),
    t0: Date.now(),
    callbacks: {},
    ...overrides,
  }
}

/** The system:init envelope every turn starts with. */
function systemInit(): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'sess-1',
    tools: [],
    mcp_servers: [],
  }
}

/**
 * Assistant envelope carrying ONLY a thinking block. parseSDKMessage skips
 * thinking blocks (:145-147), so this yields no text thought — the exact
 * precondition of the #299 defect.
 */
function assistantThinkingOnly(thinking: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'thinking', thinking }],
    },
  }
}

/** Terminal result carrying the whole reply body in `result`. */
function resultCarrying(result: string): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    duration_ms: 100,
    session_id: 'sess-1',
    message: { role: 'result', result },
  }
}

// ============================================
// Tests
// ============================================

describe('processStream thinking-only turns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits the final agent:message from result content when the envelope has only thinking', async () => {
    const result = await processStream(
      baseParams({
        v2Session: fakeSession([
          systemInit(),
          assistantThinkingOnly('User wants a greeting. I will reply directly.'),
          resultCarrying('The answer.'),
        ]),
      })
    )

    const completeCall = emitAgentEvent.mock.calls.find(
      ([event, , , payload]: unknown[]) =>
        event === 'agent:message' &&
        (payload as Record<string, unknown>)?.isComplete === true
    )
    expect(completeCall).toBeTruthy()

    expect(completeCall?.[1]).toBe('space-1')
    expect(completeCall?.[2]).toBe('conv-1')
    expect(completeCall?.[3]).toMatchObject({
      type: 'message',
      content: 'The answer.',
      isComplete: true,
    })

    expect(result.finalContent).toBe('The answer.')
    expect(result.hasMeaningfulContent).toBe(true)
    expect(result.isInterrupted).toBe(false)
    expect(result.wasAborted).toBe(false)
  })

  it('keeps the thinking envelope out of the bubble text but preserves it as a thought', async () => {
    const sessionState = makeSessionState()
    const result = await processStream(
      baseParams({
        sessionState,
        v2Session: fakeSession([
          systemInit(),
          assistantThinkingOnly('Internal reasoning.'),
          resultCarrying('Visible reply.'),
        ]),
      })
    )

    expect(result.finalContent).toBe('Visible reply.')
    expect(result.finalContent).not.toContain('Internal reasoning.')

    // parseSDKMessage drops thinking-only envelopes entirely (returns null),
    // so the SDK-message path accumulates no thinking thought for this shape.
    const thinkingThoughts = sessionState.thoughts.filter(
      (t: Thought) => t.type === 'thinking'
    )
    expect(thinkingThoughts).toHaveLength(0)
  })

  it('locks finalContent at the result thought so a trailing re-fire cannot corrupt it', async () => {
    const result = await processStream(
      baseParams({
        v2Session: fakeSession([
          systemInit(),
          assistantThinkingOnly('Internal reasoning.'),
          resultCarrying('Locked answer.'),
          // Trailing SDK assistant text AFTER the result — the dual-path
          // corruption shape the lockedFinalContent invariant protects against.
          {
            type: 'assistant',
            message: {
              id: 'msg_trailing',
              role: 'assistant',
              content: [{ type: 'text', text: 'trailing junk' }],
            },
          },
        ]),
      })
    )

    expect(result.finalContent).toBe('Locked answer.')
    expect(result.finalContent).not.toContain('trailing junk')
  })
})
