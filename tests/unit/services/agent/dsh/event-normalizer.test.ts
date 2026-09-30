/**
 * Unit Tests: services/agent/dsh — Event Normalizer.
 *
 * The normalizer is notification-driven: callers hand it whole runtime
 * notifications and receive the CC frames they translate to. The assertions
 * below are about the frame CONTRACT (services/agent/DESIGN.md §2) — presence,
 * shape, and above all ORDER.
 *
 * Fixtures are synthetic, derived from the harness type definitions; see
 * ./fixtures.ts.
 */

import { describe, expect, it } from 'vitest'
import { DshEventNormalizer } from '../../../../../src/main/services/agent/dsh/event-normalizer'
import {
  assistantMessage,
  attemptStart,
  chunk,
  inboxReceipt,
  sessionEvent,
  sessionStatus,
  streamFrame,
  subagentFinished,
  subagentStarted,
  textTurn,
  toolCall,
  toolResult,
  toolTurn,
} from './fixtures'

const SESSION = 'sess-a'

let idCounter = 0

function createNormalizer(opts: { includePartialMessages?: boolean; sessionId?: string } = {}): DshEventNormalizer {
  idCounter = 0
  return new DshEventNormalizer({
    sessionId: opts.sessionId ?? SESSION,
    model: 'deepseek-v4',
    includePartialMessages: opts.includePartialMessages ?? false,
    newId: (prefix) => `${prefix}-${++idCounter}`,
  })
}

/** Drive a whole turn interval and return every frame in emission order. */
function runTurn(normalizer: DshEventNormalizer, notifications: any[]): any[] {
  const frames: any[] = [...normalizer.beginTurn()]
  for (const notification of notifications) {
    frames.push(...normalizer.handle(notification))
    if (normalizer.isOwnIdle(notification)) frames.push(...normalizer.endTurn())
  }
  return frames
}

function types(frames: any[]): string[] {
  return frames.map((f) => (f.type === 'stream_event' ? `stream_event:${f.event.type}` : f.type))
}

function streamEvents(frames: any[]): any[] {
  return frames.filter((f) => f.type === 'stream_event').map((f) => f.event)
}

describe('DshEventNormalizer — turn frame contract', () => {
  it('emits init, stream events, aggregate and result for a text-only turn', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [...textTurn(SESSION), sessionStatus(SESSION, 'idle')])

    expect(types(frames)).toEqual([
      'system',
      'stream_event:message_start',
      'stream_event:content_block_start',
      'stream_event:content_block_delta',
      'stream_event:content_block_delta',
      'stream_event:content_block_stop',
      'assistant',
      'stream_event:message_delta',
      'stream_event:message_stop',
      'assistant',
      'result',
    ])

    expect(frames[0]).toMatchObject({ subtype: 'init', session_id: SESSION, model: 'deepseek-v4' })
    expect(frames[6].message.content).toEqual([{ type: 'text', text: 'Hello world' }])
    expect(frames[9].message.content).toEqual([])
    expect(frames[9].message.usage).toEqual({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    })
    expect(frames[10]).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello world',
      session_id: SESSION,
    })
  })

  it('emits exactly one init and one result per interval', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [...textTurn(SESSION), sessionStatus(SESSION, 'idle')])
    expect(frames.filter((f) => f.type === 'system' && f.subtype === 'init')).toHaveLength(1)
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
  })

  it('translates reasoning deltas into thinking deltas', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [...toolTurn(SESSION), sessionStatus(SESSION, 'idle')])
    const thinking = streamEvents(frames).filter((e) => e.delta?.type === 'thinking_delta')
    expect(thinking).toHaveLength(1)
    expect(thinking[0].delta.thinking).toBe('need to list files')
  })

  it('streams tool arguments as input_json_delta', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [...toolTurn(SESSION), sessionStatus(SESSION, 'idle')])
    const partials = streamEvents(frames)
      .filter((e) => e.delta?.type === 'input_json_delta')
      .map((e) => e.delta.partial_json)
    expect(partials).toEqual(['{"command"', ':"ls"}'])
  })

  it('maps harness tool names onto CC tool kinds', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [...toolTurn(SESSION), sessionStatus(SESSION, 'idle')])
    const start = streamEvents(frames).find((e) => e.content_block?.type === 'tool_use')
    expect(start.content_block).toMatchObject({ name: 'Bash', id: 'call-1' })
  })
})

describe('DshEventNormalizer — tool_use precedes tool_result', () => {
  it('puts the aggregate tool_use envelope before the matching user.tool_result', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [...toolTurn(SESSION), sessionStatus(SESSION, 'idle')])

    const aggregateIndex = frames.findIndex(
      (f) => f.type === 'assistant' && f.message.content?.[0]?.type === 'tool_use',
    )
    const resultIndex = frames.findIndex(
      (f) => f.type === 'user' && f.message.content?.[0]?.type === 'tool_result',
    )
    expect(aggregateIndex).toBeGreaterThan(-1)
    expect(resultIndex).toBeGreaterThan(-1)
    expect(aggregateIndex).toBeLessThan(resultIndex)
    expect(frames[aggregateIndex].message.content[0]).toEqual({
      type: 'tool_use',
      id: 'call-1',
      name: 'Bash',
      input: { command: 'ls' },
    })
    expect(frames[resultIndex].message.content[0]).toMatchObject({
      tool_use_id: 'call-1',
      content: 'README.md',
      is_error: false,
    })
  })

  it('never emits a second tool_use for a call the chunk stream already opened', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [...toolTurn(SESSION), sessionStatus(SESSION, 'idle')])
    const toolUses = frames.filter((f) => f.type === 'assistant' && f.message.content?.[0]?.type === 'tool_use')
    expect(toolUses).toHaveLength(1)
  })

  it('synthesizes the tool_use from tool/call when no chunks streamed', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [
      sessionEvent(SESSION, 'turn/start', { turn: 1 }),
      sessionEvent(SESSION, 'step/start', { turn: 1, step: 1 }),
      toolCall(SESSION, 1, 1, 'call-9', 'grep', '{"pattern":"todo"}'),
      toolResult(SESSION, 1, 1, 'call-9', 'no matches', true),
      sessionEvent(SESSION, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      sessionStatus(SESSION, 'idle'),
    ])

    const aggregateIndex = frames.findIndex(
      (f) => f.type === 'assistant' && f.message.content?.[0]?.type === 'tool_use',
    )
    const resultIndex = frames.findIndex((f) => f.type === 'user')
    expect(aggregateIndex).toBeLessThan(resultIndex)
    expect(frames[aggregateIndex].message.content[0]).toMatchObject({ name: 'Grep', id: 'call-9' })
    expect(frames[resultIndex].message.content[0].is_error).toBe(true)
  })

  it('rebuilds blocks the chunk stream never produced from the assembled message', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [
      sessionEvent(SESSION, 'step/start', { turn: 1, step: 1 }),
      assistantMessage(SESSION, 1, 1, [{ type: 'text', text: 'no chunks here' }]),
      sessionEvent(SESSION, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      sessionStatus(SESSION, 'idle'),
    ])
    const deltas = streamEvents(frames).filter((e) => e.delta?.type === 'text_delta')
    expect(deltas.map((e) => e.delta.text)).toEqual(['no chunks here'])
    expect(frames.find((f) => f.type === 'assistant' && f.message.content?.length)?.message.content).toEqual([
      { type: 'text', text: 'no chunks here' },
    ])
  })
})

describe('DshEventNormalizer — aggregate suppression', () => {
  it('suppresses aggregate text while stream_events are the live bubble source', () => {
    const normalizer = createNormalizer({ includePartialMessages: true })
    const frames = runTurn(normalizer, [...textTurn(SESSION), sessionStatus(SESSION, 'idle')])
    const withText = frames.filter(
      (f) => f.type === 'assistant' && f.message.content?.some((b: any) => b.type === 'text'),
    )
    expect(withText).toHaveLength(0)
    // The final text still reaches the result frame, which is what consumers
    // fall back to when the aggregate carries no text.
    expect(frames.at(-1)).toMatchObject({ type: 'result', result: 'Hello world' })
  })

  it('keeps the tool_use aggregate even in live-UI mode', () => {
    const normalizer = createNormalizer({ includePartialMessages: true })
    const frames = runTurn(normalizer, [...toolTurn(SESSION), sessionStatus(SESSION, 'idle')])
    const toolUses = frames.filter((f) => f.type === 'assistant' && f.message.content?.[0]?.type === 'tool_use')
    expect(toolUses).toHaveLength(1)
  })
})

describe('DshEventNormalizer — todo state', () => {
  it('drops the log-only snapshot when the todo tool call is already on screen', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [
      sessionEvent(SESSION, 'step/start', { turn: 1, step: 1 }),
      toolCall(SESSION, 1, 1, 'call-t', 'todo_write', '{"todos":[{"content":"a","status":"pending"}]}'),
      sessionEvent(SESSION, 'todo/write', { todos: [{ content: 'a', status: 'pending' }] }),
      toolResult(SESSION, 1, 1, 'call-t', 'ok'),
      sessionEvent(SESSION, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      sessionStatus(SESSION, 'idle'),
    ])
    const todoCards = frames.filter(
      (f) => f.type === 'assistant' && f.message.content?.[0]?.name === 'TodoWrite',
    )
    expect(todoCards).toHaveLength(1)
    expect(todoCards[0].message.content[0].input).toEqual({ todos: [{ content: 'a', status: 'pending' }] })
  })

  it('synthesizes a TodoWrite card when the list was written without a tool call', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [
      sessionEvent(SESSION, 'step/start', { turn: 1, step: 1 }),
      sessionEvent(SESSION, 'todo/write', { todos: [{ content: 'b', status: 'in_progress' }] }),
      sessionEvent(SESSION, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      sessionStatus(SESSION, 'idle'),
    ])
    const card = frames.find((f) => f.type === 'assistant' && f.message.content?.[0]?.name === 'TodoWrite')
    expect(card.message.content[0].input).toEqual({ todos: [{ content: 'b', status: 'in_progress' }] })
    expect(frames.some((f) => f.type === 'user' && f.message.content[0].tool_use_id === card.message.content[0].id))
      .toBe(true)
  })
})

describe('DshEventNormalizer — turn end reasons', () => {
  const endWith = (reason: Record<string, unknown>): any => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [
      sessionEvent(SESSION, 'turn/start', { turn: 1 }),
      sessionEvent(SESSION, 'turn/end', { turn: 1, reason }),
      sessionStatus(SESSION, 'idle'),
    ])
    return frames.at(-1)
  }

  it('maps completed to a success result', () => {
    expect(endWith({ kind: 'completed' })).toMatchObject({ subtype: 'success', is_error: false })
  })

  it('maps a model failure to an error result carrying its message', () => {
    expect(endWith({ kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } })).toMatchObject({
      subtype: 'error_during_execution',
      is_error: true,
      result: 'rate limited',
    })
  })

  it('maps the token ceiling to error_max_turns without flagging an error', () => {
    expect(endWith({ kind: 'max-tokens' })).toMatchObject({ subtype: 'error_max_turns', is_error: false })
  })

  it('maps a cancelled turn to an interruption rather than an error', () => {
    expect(endWith({ kind: 'aborted', reason: { kind: 'user' } })).toMatchObject({
      subtype: 'error_during_execution',
      is_error: false,
      stop_reason: 'interrupted',
    })
  })

  it('sums per-call usage across the interval into the result frame', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [
      sessionEvent(SESSION, 'step/start', { turn: 1, step: 1 }),
      chunk(SESSION, 1, 1, { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }),
      assistantMessage(SESSION, 1, 1, [{ type: 'text', text: 'a' }]),
      sessionEvent(SESSION, 'step/start', { turn: 1, step: 2 }),
      chunk(SESSION, 1, 2, { type: 'usage', usage: { inputTokens: 20, outputTokens: 7 } }),
      assistantMessage(SESSION, 1, 2, [{ type: 'text', text: 'b' }]),
      sessionEvent(SESSION, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      sessionStatus(SESSION, 'idle'),
    ])
    expect(frames.at(-1).usage).toEqual({
      input_tokens: 30,
      output_tokens: 12,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })
})

describe('DshEventNormalizer — session filtering', () => {
  it('ignores events belonging to an unrelated session', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [
      ...textTurn('other-session'),
      sessionStatus('other-session', 'idle'),
    ])
    expect(types(frames)).toEqual(['system'])
  })

  it('does not treat another session going idle as its own turn end', () => {
    const normalizer = createNormalizer()
    expect(normalizer.isOwnIdle(sessionStatus('other-session', 'idle'))).toBe(false)
    expect(normalizer.isOwnIdle(sessionStatus(SESSION, 'idle'))).toBe(true)
    expect(normalizer.isOwnIdle(sessionStatus(SESSION, 'running'))).toBe(false)
  })

  it('drops everything once the interval has produced its result', () => {
    const normalizer = createNormalizer()
    runTurn(normalizer, [...textTurn(SESSION), sessionStatus(SESSION, 'idle')])
    expect(normalizer.isTerminal()).toBe(true)
    expect(normalizer.handle(sessionEvent(SESSION, 'step/start', { turn: 2, step: 1 }))).toEqual([])
    expect(normalizer.endTurn()).toEqual([])
  })
})

describe('DshEventNormalizer — subagents', () => {
  const CHILD = 'sess-child'

  function runDelegation(): any[] {
    const normalizer = createNormalizer()
    return runTurn(normalizer, [
      sessionEvent(SESSION, 'step/start', { turn: 1, step: 1 }),
      toolCall(SESSION, 1, 1, 'call-sub', 'subagent', '{"task":"research"}'),
      subagentStarted(SESSION, CHILD),
      sessionEvent(CHILD, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'child-1',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'child-call', name: 'read', arguments: '{"path":"a.md"}' }],
        },
      }),
      sessionEvent(CHILD, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'child-r',
          role: 'tool',
          toolCallId: 'child-call',
          content: [{ type: 'text', text: 'file body' }],
          source: { kind: 'tool', callId: 'child-call' },
        },
      }),
      subagentFinished(SESSION, CHILD),
      toolResult(SESSION, 1, 1, 'call-sub', 'done'),
      sessionEvent(SESSION, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      sessionStatus(SESSION, 'idle'),
    ])
  }

  it('links the child session to the delegating tool call', () => {
    const started = runDelegation().find((f) => f.subtype === 'task_started')
    expect(started).toMatchObject({ type: 'system', task_id: CHILD, tool_use_id: 'call-sub' })
  })

  it('tags descendant messages with parent_tool_use_id so the shared router nests them', () => {
    const frames = runDelegation()
    const childAssistant = frames.find((f) => f.type === 'assistant' && f.parent_tool_use_id)
    expect(childAssistant).toMatchObject({ parent_tool_use_id: 'call-sub' })
    expect(childAssistant.message.content[0]).toMatchObject({ type: 'tool_use', name: 'Read', id: 'child-call' })

    const childResult = frames.find((f) => f.type === 'user' && f.parent_tool_use_id)
    expect(childResult.message.content[0]).toMatchObject({ tool_use_id: 'child-call', content: 'file body' })
  })

  it('closes the child lifecycle with a task notification', () => {
    const finished = runDelegation().find((f) => f.subtype === 'task_notification')
    expect(finished).toMatchObject({ task_id: CHILD, status: 'completed' })
  })

  it('reports a failed child run as failed', () => {
    const normalizer = createNormalizer()
    const frames = runTurn(normalizer, [
      sessionEvent(SESSION, 'step/start', { turn: 1, step: 1 }),
      toolCall(SESSION, 1, 1, 'call-sub', 'subagent', '{}'),
      subagentStarted(SESSION, CHILD),
      subagentFinished(SESSION, CHILD, 'error', 'error'),
      sessionStatus(SESSION, 'idle'),
    ])
    expect(frames.find((f) => f.subtype === 'task_notification')).toMatchObject({ status: 'failed' })
  })

  it('ignores a subagent started by a session it does not track', () => {
    const normalizer = createNormalizer()
    normalizer.beginTurn()
    expect(normalizer.handle(subagentStarted('unrelated', 'other-child'))).toEqual([])
    expect(normalizer.isKnownSession('other-child')).toBe(false)
  })
})

describe('DshEventNormalizer — interval gating', () => {
  it('produces nothing before the interval opens', () => {
    const normalizer = createNormalizer()
    for (const notification of textTurn(SESSION)) {
      expect(normalizer.handle(notification)).toEqual([])
    }
  })

  it('reads the inbox receipt as an ordinary log event once the interval is open', () => {
    const normalizer = createNormalizer()
    normalizer.beginTurn()
    expect(normalizer.handle(inboxReceipt(SESSION, 'msg-1'))).toEqual([])
  })
})

describe('DshEventNormalizer — MCP status on system.init', () => {
  /** `system.init` is what feeds Halo's MCP panel; it opens every turn. */
  function initFrame(mcpServerNames: string[], catalogue?: string[]): any {
    const normalizer = new DshEventNormalizer({
      sessionId: SESSION,
      model: 'deepseek-v4',
      includePartialMessages: false,
      mcpServerNames,
    })
    normalizer.beginTurn()
    if (catalogue) {
      normalizer.handle(
        sessionEvent(SESSION, 'request/header', {
          header: { tools: catalogue.map((name) => ({ name })) },
        }),
      )
    }
    return normalizer.beginTurn().find((frame) => frame.subtype === 'init')
  }

  it('reports a configured server as pending until its tools are seen', () => {
    // The composition lets a server fail without taking the session down, so
    // "configured" is not "reachable" and must not be shown as connected.
    expect(initFrame(['web-search']).mcp_servers).toEqual([
      { name: 'web-search', status: 'pending' },
    ])
  })

  it('reports a server as connected once the runtime advertises its tools', () => {
    expect(initFrame(['web-search'], ['bash', 'mcp__web-search__query']).mcp_servers).toEqual([
      { name: 'web-search', status: 'connected' },
    ])
  })

  it('does not credit one server for another server namespace', () => {
    expect(initFrame(['files'], ['mcp__web-search__query']).mcp_servers).toEqual([
      { name: 'files', status: 'pending' },
    ])
  })

  it('reports no servers when none are configured', () => {
    expect(initFrame([]).mcp_servers).toEqual([])
  })
})

describe('DshEventNormalizer — live stream relay', () => {
  it('drops a failed attempt\'s partial block when the retry starts', () => {
    const normalizer = createNormalizer({ includePartialMessages: true })
    const frames = runTurn(normalizer, [
      sessionEvent(SESSION, 'step/start', { turn: 1, step: 1 }),
      attemptStart(SESSION, 1, 1),
      chunk(SESSION, 1, 1, { type: 'block-start', index: 0, blockType: 'text' }),
      chunk(SESSION, 1, 1, { type: 'text-delta', index: 0, text: 'Half a sen' }),
      streamFrame(SESSION, { type: 'end', attemptId: 'a-1-1', revision: 1, index: 2, outcome: { kind: 'abandoned' } }),
      attemptStart(SESSION, 1, 1),
      chunk(SESSION, 1, 1, { type: 'block-start', index: 0, blockType: 'text' }),
      chunk(SESSION, 1, 1, { type: 'text-delta', index: 0, text: 'Whole answer' }),
      chunk(SESSION, 1, 1, { type: 'block-end', index: 0, block: { type: 'text', text: 'Whole answer' } }),
      chunk(SESSION, 1, 1, { type: 'finish', reason: { kind: 'stop' } }),
      assistantMessage(SESSION, 1, 1, [{ type: 'text', text: 'Whole answer' }]),
      sessionEvent(SESSION, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      sessionStatus(SESSION, 'idle'),
    ])

    const starts = streamEvents(frames).filter((e) => e.type === 'content_block_start')
    const stops = streamEvents(frames).filter((e) => e.type === 'content_block_stop')
    // The abandoned block is closed, the retry opens a fresh one, and the
    // assembled message does not replay the answer a second time.
    expect(starts).toHaveLength(2)
    expect(stops).toHaveLength(2)
    expect(frames.at(-1)).toMatchObject({ type: 'result', result: 'Whole answer' })
  })

  it('keeps a child session\'s stream inside the child', () => {
    const normalizer = createNormalizer({ includePartialMessages: true })
    const frames = runTurn(normalizer, [
      sessionEvent(SESSION, 'step/start', { turn: 1, step: 1 }),
      toolCall(SESSION, 1, 1, 'call-sub', 'subagent', '{}'),
      subagentStarted(SESSION, 'child'),
      attemptStart('child', 1, 1),
      chunk('child', 1, 1, { type: 'text-delta', index: 0, text: 'child text' }),
    ])

    expect(JSON.stringify(frames)).not.toContain('child text')
  })
})

describe('DshEventNormalizer — compaction', () => {
  it('reports the runtime\'s own compaction as a CC compact boundary', () => {
    const frames = runTurn(createNormalizer(), [
      sessionEvent(SESSION, 'compaction/start', { compactionId: 'c1', turn: 1 }),
      sessionEvent(SESSION, 'compaction/summary', {
        compactionId: 'c1',
        summary: [{ type: 'text', text: 'earlier work' }],
        shadowedRange: { start: 3, end: 40 },
        shadowedSeqs: [3, 40],
        shadowedTokenCount: 91_000,
        provider: 'deepseek-official',
        model: 'm',
      }),
      sessionEvent(SESSION, 'compaction/end', { compactionId: 'c1', turn: 1 }),
      sessionStatus(SESSION, 'idle'),
    ])

    expect(frames.find((f) => f.subtype === 'compact_boundary')).toMatchObject({
      type: 'system',
      compact_metadata: { trigger: 'auto', pre_tokens: 91_000 },
    })
  })
})
