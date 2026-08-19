/**
 * handleSubAgentMessage parses complete sub-agent SDK messages (no stream deltas)
 * into nested Thoughts. These pin the three load-bearing behaviors:
 *   - tool_use → a tool_use Thought carrying the resolved parentToolUseId, and its
 *     id registered in toolIdToThoughtId so a later result can merge;
 *   - tool_result → merges into the mapped tool_use Thought, or (orphan path)
 *     becomes a standalone tool_result Thought when no mapping exists;
 *   - block.input parsed from both an object and a JSON string.
 *
 * team-lifecycle.test.ts already covers hasActiveTeamTasks/isTeamLifecycleThought,
 * so those are intentionally not re-tested here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent }))

import { handleSubAgentMessage, type SubAgentContext } from '../../../../src/main/services/agent/subagent-handler'
import type { Thought } from '../../../../src/main/services/agent/types'

function makeCtx(): SubAgentContext {
  return {
    spaceId: 'space-1',
    conversationId: 'conv-1',
    sessionState: { thoughts: [] as Thought[] } as SubAgentContext['sessionState'],
    toolIdToThoughtId: new Map<string, string>()
  }
}

const assistant = (content: unknown[]) => ({ type: 'assistant', message: { content } })
const user = (content: unknown[]) => ({ type: 'user', message: { content } })

beforeEach(() => emitAgentEvent.mockClear())

describe('handleSubAgentMessage — tool_use', () => {
  it('creates a tool_use thought carrying the resolved parentToolUseId and registers the mapping', () => {
    const ctx = makeCtx()
    // Map the SDK parent id to a Halo thought id so the child resolves to it.
    ctx.toolIdToThoughtId.set('parent-tu', 'halo-parent')

    handleSubAgentMessage(
      assistant([{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }]),
      'parent-tu',
      ctx
    )

    expect(ctx.sessionState.thoughts).toHaveLength(1)
    const th = ctx.sessionState.thoughts[0]
    expect(th.type).toBe('tool_use')
    expect(th.toolName).toBe('Bash')
    expect(th.toolInput).toEqual({ command: 'ls' })
    expect(th.parentToolUseId).toBe('halo-parent')
    // tu-1 now maps to the new thought so a later result can merge.
    expect(ctx.toolIdToThoughtId.get('tu-1')).toBe(th.id)
    expect(emitAgentEvent).toHaveBeenCalledWith('agent:thought', 'space-1', 'conv-1', { thought: th })
  })

  it('falls back to the raw parent id when it is not in the map', () => {
    const ctx = makeCtx()
    handleSubAgentMessage(
      assistant([{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }]),
      'unmapped-parent',
      ctx
    )
    expect(ctx.sessionState.thoughts[0].parentToolUseId).toBe('unmapped-parent')
  })

  it('parses a JSON-string input, and leaves toolInput empty on malformed JSON', () => {
    const ctx = makeCtx()
    handleSubAgentMessage(
      assistant([
        { type: 'tool_use', id: 'a', name: 'X', input: '{"k":1}' },
        { type: 'tool_use', id: 'b', name: 'Y', input: 'not json' }
      ]),
      'p',
      ctx
    )
    expect(ctx.sessionState.thoughts[0].toolInput).toEqual({ k: 1 })
    expect(ctx.sessionState.thoughts[1].toolInput).toEqual({})
  })

  it('ignores non-array assistant content', () => {
    const ctx = makeCtx()
    handleSubAgentMessage({ type: 'assistant', message: { content: null } }, 'p', ctx)
    expect(ctx.sessionState.thoughts).toHaveLength(0)
  })
})

describe('handleSubAgentMessage — tool_result', () => {
  it('merges a result into the mapped tool_use thought (no new thought)', () => {
    const ctx = makeCtx()
    handleSubAgentMessage(
      assistant([{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }]),
      'p',
      ctx
    )
    const toolUse = ctx.sessionState.thoughts[0]
    emitAgentEvent.mockClear()

    handleSubAgentMessage(
      user([{ type: 'tool_result', tool_use_id: 'tu-1', content: 'output text', is_error: false }]),
      'p',
      ctx
    )

    // No new thought — merged onto the existing one.
    expect(ctx.sessionState.thoughts).toHaveLength(1)
    expect(toolUse.toolResult).toEqual({ output: 'output text', isError: false, timestamp: expect.any(String) })
    expect(emitAgentEvent).toHaveBeenCalledWith(
      'agent:thought-delta',
      'space-1',
      'conv-1',
      expect.objectContaining({ thoughtId: toolUse.id, isToolResult: true })
    )
  })

  it('serializes non-string result content to JSON when merging', () => {
    const ctx = makeCtx()
    handleSubAgentMessage(assistant([{ type: 'tool_use', id: 'tu-1', name: 'B', input: {} }]), 'p', ctx)
    handleSubAgentMessage(
      user([{ type: 'tool_result', tool_use_id: 'tu-1', content: [{ type: 'text', text: 'hi' }] }]),
      'p',
      ctx
    )
    expect(ctx.sessionState.thoughts[0].toolResult!.output).toBe(JSON.stringify([{ type: 'text', text: 'hi' }]))
  })

  it('creates a standalone tool_result thought when no tool_use mapping exists (orphan path)', () => {
    const ctx = makeCtx()
    ctx.toolIdToThoughtId.set('parent-tu', 'halo-parent')

    handleSubAgentMessage(
      user([{ type: 'tool_result', tool_use_id: 'orphan-id', content: 'boom', is_error: true }]),
      'parent-tu',
      ctx
    )

    expect(ctx.sessionState.thoughts).toHaveLength(1)
    const th = ctx.sessionState.thoughts[0]
    expect(th.type).toBe('tool_result')
    expect(th.id).toBe('orphan-id')
    expect(th.isError).toBe(true)
    expect(th.content).toBe('Tool execution failed')
    expect(th.toolOutput).toBe('boom')
    expect(th.parentToolUseId).toBe('halo-parent')
    expect(emitAgentEvent).toHaveBeenCalledWith('agent:thought', 'space-1', 'conv-1', { thought: th })
  })

  it('labels a successful orphan result as succeeded', () => {
    const ctx = makeCtx()
    handleSubAgentMessage(
      user([{ type: 'tool_result', tool_use_id: 'orphan', content: 'ok', is_error: false }]),
      'p',
      ctx
    )
    expect(ctx.sessionState.thoughts[0].content).toBe('Tool execution succeeded')
  })
})
