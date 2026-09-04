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

describe('processStream telemetry attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * The stream_event frames one tool call produces. Tool usage is counted on
   * this path only — parseSDKMessage skips tool_use blocks on plain assistant
   * envelopes.
   */
  function toolUseFrames(
    index: number,
    name: string,
    input: Record<string, unknown>
  ): Record<string, unknown>[] {
    return [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: `tool_${index}`, name },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index } },
    ]
  }

  function trackedEvent(name: string): Record<string, unknown> | undefined {
    const call = track.mock.calls.find(([event]: unknown[]) => event === name)
    return call?.[1] as Record<string, unknown> | undefined
  }

  it('parses appId and channel out of a channel-qualified conversationId', async () => {
    await processStream(
      baseParams({
        conversationId: 'app-chat:app-123:wecom-bot:group:chat-9',
        v2Session: fakeSession([
          systemInit(),
          ...toolUseFrames(0, 'Bash', { command: 'ls' }),
          resultCarrying('done'),
        ]),
      })
    )

    // Slicing the "app-chat:" prefix instead of parsing would report the
    // whole tail as the appId, splitting one digital human into one "app"
    // per chat session.
    expect(trackedEvent('tool.usage_summary')).toMatchObject({
      source: 'app-chat',
      appId: 'app-123',
      channel: 'wecom-bot',
    })
  })

  it('reports the native digital-human session without a channel qualifier', async () => {
    await processStream(
      baseParams({
        conversationId: 'app-chat:app-123',
        v2Session: fakeSession([
          systemInit(),
          ...toolUseFrames(0, 'Bash', { command: 'ls' }),
          resultCarrying('done'),
        ]),
      })
    )

    expect(trackedEvent('tool.usage_summary')).toMatchObject({
      source: 'app-chat',
      appId: 'app-123',
      channel: 'native',
    })
  })

  it('breaks Skill invocations down by the skill named in the tool input', async () => {
    await processStream(
      baseParams({
        v2Session: fakeSession([
          systemInit(),
          ...toolUseFrames(0, 'Skill', { skill: 'code-commit' }),
          ...toolUseFrames(1, 'Skill', { skill: 'code-commit' }),
          ...toolUseFrames(2, 'Skill', { skill: 'comment-review' }),
          resultCarrying('done'),
        ]),
      })
    )

    const summary = trackedEvent('tool.usage_summary')
    expect(summary).toMatchObject({ source: 'agent' })
    expect(summary?.skillCalls).toEqual(
      expect.arrayContaining([
        { skillId: 'code-commit', count: 2 },
        { skillId: 'comment-review', count: 1 },
      ])
    )
  })
})

/**
 * Providers behind the openai-compat router report no usage of their own, so
 * the router writes a zero placeholder into `message_start` and puts the real
 * or estimated counts into the final `message_delta`. The aggregate assistant
 * envelope is built from `message_start`, so reading only that path reports a
 * turn with no token fields at all — which is what production showed for ~96%
 * of `llm.invocation` rows.
 */
describe('processStream llm.invocation token attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function messageStart(id: string): Record<string, unknown> {
    return {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id, role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0 } },
      },
    }
  }

  function messageDelta(usage: Record<string, number>): Record<string, unknown> {
    return {
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
    }
  }

  /** Aggregate envelope as the SDK builds it from message_start — usage all zero. */
  function assistantText(id: string, text: string, usage?: Record<string, number>): Record<string, unknown> {
    return {
      type: 'assistant',
      message: {
        id,
        role: 'assistant',
        content: [{ type: 'text', text }],
        usage: usage ?? { input_tokens: 0, output_tokens: 0 },
      },
    }
  }

  function invocations(): Record<string, unknown>[] {
    return track.mock.calls
      .filter(([event]: unknown[]) => event === 'llm.invocation')
      .map(([, props]: unknown[]) => props as Record<string, unknown>)
  }

  it('attributes message_delta counts to the call whose message_start carried the id', async () => {
    await processStream(
      baseParams({
        v2Session: fakeSession([
          systemInit(),
          messageStart('msg_1'),
          assistantText('msg_1', 'Answer.'),
          messageDelta({ input_tokens: 9_100, output_tokens: 240 }),
          resultCarrying('Answer.'),
        ]),
      })
    )

    expect(invocations()).toEqual([
      expect.objectContaining({ status: 'ok', inputTokens: 9_100, outputTokens: 240 }),
    ])
  })

  it('keeps per-call attribution across a multi-call turn', async () => {
    await processStream(
      baseParams({
        v2Session: fakeSession([
          systemInit(),
          messageStart('msg_1'),
          assistantText('msg_1', 'First.'),
          messageDelta({ input_tokens: 1_000, output_tokens: 10 }),
          messageStart('msg_2'),
          assistantText('msg_2', 'Second.'),
          messageDelta({ input_tokens: 2_000, output_tokens: 20 }),
          resultCarrying('Second.'),
        ]),
      })
    )

    // Emission order is call order: msg_1 flushes at msg_2's assistant
    // boundary, msg_2 at stream end. A single shared "last usage" variable
    // would report 2_000/20 twice.
    expect(invocations()).toEqual([
      expect.objectContaining({ inputTokens: 1_000, outputTokens: 10 }),
      expect.objectContaining({ inputTokens: 2_000, outputTokens: 20 }),
    ])
  })

  it('prefers real assistant-frame usage over the delta', async () => {
    await processStream(
      baseParams({
        v2Session: fakeSession([
          systemInit(),
          messageStart('msg_1'),
          assistantText('msg_1', 'Answer.', { input_tokens: 7, output_tokens: 3 }),
          messageDelta({ input_tokens: 9_999, output_tokens: 9_999 }),
          resultCarrying('Answer.'),
        ]),
      })
    )

    expect(invocations()).toEqual([
      expect.objectContaining({ inputTokens: 7, outputTokens: 3 }),
    ])
  })

  it('still emits the call when nothing reported usage', async () => {
    await processStream(
      baseParams({
        v2Session: fakeSession([
          systemInit(),
          messageStart('msg_1'),
          assistantText('msg_1', 'Answer.'),
          messageDelta({ output_tokens: 0 }),
          resultCarrying('Answer.'),
        ]),
      })
    )

    const [invocation] = invocations()
    expect(invocation).toMatchObject({ status: 'ok' })
    expect(invocation).not.toHaveProperty('inputTokens')
    expect(invocation).not.toHaveProperty('outputTokens')
  })

  it('attributes usage to a call that failed before any assistant envelope', async () => {
    await processStream(
      baseParams({
        // No result frame → isInterrupted, and no assistant envelope → the
        // error tail-emit is the only llm.invocation for this turn.
        v2Session: fakeSession([
          systemInit(),
          messageStart('msg_1'),
          messageDelta({ input_tokens: 4_200, output_tokens: 15 }),
        ]),
      })
    )

    expect(invocations()).toEqual([
      expect.objectContaining({ status: 'error', inputTokens: 4_200, outputTokens: 15 }),
    ])
  })

  it('reports no tokens for a failed call that never produced output', async () => {
    await processStream(
      baseParams({
        v2Session: fakeSession([systemInit(), messageStart('msg_1')]),
      })
    )

    const [invocation] = invocations()
    expect(invocation).toMatchObject({ status: 'error' })
    expect(invocation).not.toHaveProperty('inputTokens')
  })
})
