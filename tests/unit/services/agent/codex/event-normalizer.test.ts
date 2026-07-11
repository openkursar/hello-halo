/**
 * Unit Tests: services/agent/codex — Event Normalizer (app-server protocol)
 *
 * The normalizer is method-driven: callers pass the JSON-RPC notification
 * method name + params object and receive a batch of CC-shaped messages.
 */

import { describe, expect, it } from 'vitest'
import { CodexEventNormalizer } from '../../../../../src/main/services/agent/codex/event-normalizer'
import { ServerNotifications } from '../../../../../src/main/services/agent/codex/types/codex-protocol'

function createNormalizer(opts: { includePartialMessages?: boolean } = {}): CodexEventNormalizer {
  return new CodexEventNormalizer({
    sessionId: 'session-1',
    model: 'test-model',
    mcpServers: {},
    // Default the existing-suite path to the aggregate-only mode that these
    // tests assert on. The live-UI mode (true) is exercised by a dedicated
    // describe block further down that asserts aggregate text/thinking are
    // suppressed.
    includePartialMessages: opts.includePartialMessages ?? false,
  })
}

function streamEvents(messages: any[]): any[] {
  return messages.filter((m) => m?.type === 'stream_event').map((m) => m.event)
}

describe('CodexEventNormalizer (app-server protocol)', () => {
  it('emits message_start on turn/started and tracks token text deltas', () => {
    const n = createNormalizer()
    const turnStart = streamEvents(n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' }))
    const itemStart = n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'msg-1',
      item: { id: 'msg-1', type: 'agentMessage' },
    })
    const delta1 = n.handle(ServerNotifications.AgentMessageDelta, { threadId: 't', turnId: 'r1', itemId: 'msg-1', delta: 'Hel' })
    const delta2 = n.handle(ServerNotifications.AgentMessageDelta, { threadId: 't', turnId: 'r1', itemId: 'msg-1', delta: 'lo' })
    const itemDone = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'msg-1',
      item: { id: 'msg-1', type: 'agentMessage', text: 'Hello' },
    })

    expect(turnStart[0]).toMatchObject({ type: 'message_start', message: { role: 'assistant', model: 'test-model' } })
    expect(streamEvents(itemStart)).toEqual([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ])
    expect(streamEvents(delta1)).toEqual([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    ])
    expect(streamEvents(delta2)).toEqual([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    ])
    expect(streamEvents(itemDone)).toEqual([
      { type: 'content_block_stop', index: 0 },
    ])
  })

  it('streams reasoning text deltas as thinking_delta blocks', () => {
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'rs',
      item: { id: 'rs', type: 'reasoning' },
    })
    const delta = n.handle(ServerNotifications.ReasoningTextDelta, {
      threadId: 't', turnId: 'r1', itemId: 'rs', delta: 'Considering...',
    })
    expect(streamEvents(delta)[0]).toMatchObject({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'Considering...' },
    })
  })

  it('maps command_execution to tool_use Bash + tool_result', () => {
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    const started = n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'cmd',
      item: { id: 'cmd', type: 'commandExecution', command: 'pwd', status: 'inProgress' },
    })
    const completed = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'cmd',
      item: { id: 'cmd', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/tmp\n', status: 'completed' },
    })
    expect(streamEvents(started)).toEqual([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'cmd', name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } },
      { type: 'content_block_stop', index: 0 },
    ])
    // ItemCompleted yields an aggregate `assistant` envelope with the tool_use
    // block (Claude SDK protocol parity — must precede tool_result for
    // id-based linking during JSONL replay; see `aggregateBlock`), followed
    // by a `user` envelope with the tool_result.
    expect(completed).toEqual([
      {
        type: 'assistant',
        message: {
          id: expect.stringMatching(/^codex-msg-/),
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'cmd', name: 'Bash', input: { command: 'pwd' } }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'cmd', content: '/tmp\n', is_error: false }],
        },
      },
    ])
  })

  it('synthesizes TodoWrite from a Codex plan item (Markdown checkbox text → 2-state list)', () => {
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    const started = n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'p',
      item: {
        id: 'p',
        type: 'plan',
        text: '- [x] Read file\n- [ ] Patch it',
      },
    })
    const events = streamEvents(started)
    expect(events[0].content_block.name).toBe('TodoWrite')
    const input = JSON.parse(events[1].delta.partial_json)
    expect(input.todos).toEqual([
      { content: 'Read file', activeForm: 'Read file', status: 'completed' },
      { content: 'Patch it', activeForm: 'Patch it', status: 'pending' },
    ])
  })

  it('emits message_delta + result on turn/completed and marks terminal', () => {
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'msg-1',
      item: { id: 'msg-1', type: 'agentMessage', text: 'done' },
    })
    const final = n.handle(ServerNotifications.TurnCompleted, {
      threadId: 't', turnId: 'r1',
      usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 7 },
    })
    const events = streamEvents(final)
    expect(events[0]).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 1 },
    })
    expect(final[final.length - 1]).toMatchObject({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    expect(n.isTerminal()).toBe(true)
  })

  it('uses stop_reason=tool_use when the turn included a tool call', () => {
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'cmd',
      item: { id: 'cmd', type: 'commandExecution', command: 'pwd' },
    })
    n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'cmd',
      item: { id: 'cmd', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/x\n', status: 'completed' },
    })
    const completed = streamEvents(n.handle(ServerNotifications.TurnCompleted, {
      threadId: 't', turnId: 'r1',
      usage: { input_tokens: 1, output_tokens: 2 },
    }))
    expect(completed[0]).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
    })
  })

  it('treats turn/failed as a terminal error result', () => {
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    const failed = n.handle(ServerNotifications.TurnFailed, { error: { message: 'boom' } })
    expect(failed[failed.length - 1]).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'boom',
    })
    expect(n.isTerminal()).toBe(true)
  })

  it('lazily opens a message envelope when the server skips turn/started', () => {
    const n = createNormalizer()
    const messages = n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'msg',
      item: { id: 'msg', type: 'agentMessage' },
    })
    expect(messages[0]).toMatchObject({ type: 'system', subtype: 'init' })
    expect(messages[1]).toMatchObject({ type: 'stream_event', event: { type: 'message_start' } })
  })

  it('surfaces agentMessage text from item.completed even when no deltas streamed (regression)', () => {
    // Smoke regression: when the upstream LLM returns a complete chunk
    // without server-side incremental forwarding, Codex emits only
    // item.started + item.completed for the agentMessage with the full
    // text in `text`. The normalizer MUST surface that text — earlier
    // versions matched snake_case 'agent_message' and silently fell into
    // the orphan-tool path, surfacing as a "tool call - agentMessage" entry
    // with empty content.
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'msg-1',
      item: { id: 'msg-1', type: 'agentMessage' },
    })
    const completed = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'msg-1',
      item: { id: 'msg-1', type: 'agentMessage', text: '你好！我是 Codex。' },
    })
    const events = streamEvents(completed)
    expect(events.find((e) => e.type === 'content_block_delta')?.delta).toEqual({
      type: 'text_delta', text: '你好！我是 Codex。',
    })
    expect(events.some((e) => e.type === 'content_block_stop')).toBe(true)
  })

  it('drops userMessage item echoes (avoids fake "userMessage" tool card)', () => {
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    const started = n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'um-1',
      item: { id: 'um-1', type: 'userMessage', text: 'hi' },
    })
    const completed = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'um-1',
      item: { id: 'um-1', type: 'userMessage', text: 'hi' },
    })
    expect(started).toEqual([])
    expect(completed).toEqual([])
  })

  it('drops notifications after terminal to prevent duplicate result(success) trailing an error', () => {
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    // Codex emits an error notification (e.g. missing API key) — terminal.
    const errMessages = n.handle(ServerNotifications.Error, { message: 'boom' })
    expect(n.isTerminal()).toBe(true)
    expect(errMessages[errMessages.length - 1]).toMatchObject({ type: 'result', is_error: true })

    const after = n.handle(ServerNotifications.TurnCompleted, {
      threadId: 't', turnId: 'r1',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    expect(after).toEqual([])
  })

  it('resetTurn clears terminal flag for the next turn', () => {
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.TurnCompleted, { threadId: 't', turnId: 'r1', usage: { input_tokens: 0, output_tokens: 0 } })
    expect(n.isTerminal()).toBe(true)
    n.resetTurn()
    expect(n.isTerminal()).toBe(false)
  })

  it('createInit is idempotent — second call returns null (prevents duplicate init)', () => {
    const n = createNormalizer()
    const first = n.createInit('thread-x')
    const second = n.createInit('thread-x')
    expect(first).toMatchObject({ type: 'system', subtype: 'init', session_id: 'thread-x' })
    expect(second).toBeNull()
  })

  it('setSessionId updates the id used by lazy fallback inits (resume persistence)', () => {
    const n = createNormalizer()
    n.setSessionId('thread-real')
    // Trigger lazy init via item.started (no prior turn/started or
    // explicit createInit). The lazy path uses context.sessionId, which
    // setSessionId mutated.
    const messages = n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'msg',
      item: { id: 'msg', type: 'agentMessage' },
    })
    const init = messages.find((m: any) => m?.type === 'system' && m?.subtype === 'init')
    expect(init?.session_id).toBe('thread-real')
  })

  it('REGRESSION: deltas + duplicated item.completed.text must NOT double-render', () => {
    // Codex (and Halo's OpenAI-compat router on chat_completions→responses
    // transcoding) emits BOTH:
    //   - incremental content via item/agentMessage/delta
    //   - the same (or doubled) full text again in item.completed.text
    // The TUI reference impl trusts deltas exclusively. Halo MUST do the
    // same — naively adding a "tail" from item.text re-emits the entire
    // message, producing visible doubled bubbles in the UI.
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'msg',
      item: { id: 'msg', type: 'agentMessage' },
    })
    n.handle(ServerNotifications.AgentMessageDelta, {
      threadId: 't', turnId: 'r1', itemId: 'msg', delta: '\n你好！有什么我可以帮助你的吗？',
    })
    // Item.completed carries item.text DOUBLED (the router-side bug shape).
    const completed = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'msg',
      item: { id: 'msg', type: 'agentMessage', text: '\n你好！有什么我可以帮助你的吗？\n你好！有什么我可以帮助你的吗？' },
    })
    // Emitted: only content_block_stop. NO additional text_delta — the
    // delta already covered the canonical content.
    const events = streamEvents(completed)
    expect(events.find((e) => e.type === 'content_block_delta')).toBeUndefined()
    expect(events.some((e) => e.type === 'content_block_stop')).toBe(true)
  })

  it('REGRESSION: agentMessage delta arriving before item/started must emit content_block_start too', () => {
    // On some Codex builds the first delta beats item/started to the
    // wire. Previously `ensureTextBlock` lazily created the block but
    // dropped the start frame; the renderer received a delta referring
    // to an unopened index → text rendered late or not at all.
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    // Skip item/started; delta arrives directly.
    const messages = n.handle(ServerNotifications.AgentMessageDelta, {
      threadId: 't', turnId: 'r1', itemId: 'msg-unstarted', delta: 'hello',
    })
    const events = streamEvents(messages)
    expect(events.find((e) => e.type === 'content_block_start')).toMatchObject({
      content_block: { type: 'text', text: '' },
    })
    expect(events.find((e) => e.type === 'content_block_delta')?.delta).toEqual({
      type: 'text_delta', text: 'hello',
    })
  })

  it('REGRESSION: thread/started must be SILENT (Codex auto-fires it on warmup)', () => {
    // Codex's app-server emits `thread/started` immediately after a
    // successful `thread/start`, BEFORE any user message. If our handler
    // emits `system:init` in response, Halo's stream-processor flips
    // chat.store into streaming state and the UI freezes in the "Thinking…"
    // state forever (no turn → no result → no exit). The handler MUST stay
    // silent; lazy init in handleTurnStarted/handleItemStarted is the
    // sole entry point for system:init.
    const n = createNormalizer()
    const warmupMessages = n.handle(ServerNotifications.ThreadStarted, { threadId: 'thread-x' })
    expect(warmupMessages).toEqual([])
    // The `initialized` flag must NOT have been flipped, so the eventual
    // turn/started can still emit a proper init.
    const turnStart = n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    const initFrame = turnStart.find((m: any) => m?.type === 'system' && m?.subtype === 'init')
    expect(initFrame).toBeDefined()
  })

  // ──────────────────────────────────────────────────────────────────────
  // Aggregate `type: 'assistant'` envelopes (Claude SDK protocol parity)
  // ──────────────────────────────────────────────────────────────────────
  //
  // Halo's automation runtime (apps/runtime/execute.ts), app-chat
  // lastAssistantText capture, and session-store JSONL replay all key off
  // top-level `type: 'assistant'` messages. The Codex normalizer must
  // surface those alongside its stream_events so engine selection is
  // invisible to consumers. See event-normalizer.ts → aggregateBlock().

  it('emits an aggregate `type:"assistant"` with the final text after a text block stops', () => {
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'msg-1',
      item: { id: 'msg-1', type: 'agentMessage' },
    })
    n.handle(ServerNotifications.AgentMessageDelta, { threadId: 't', turnId: 'r1', itemId: 'msg-1', delta: 'Hello world' })
    const itemDone = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'msg-1',
      item: { id: 'msg-1', type: 'agentMessage', text: 'Hello world' },
    })
    const aggregate = itemDone.find((m) => m?.type === 'assistant')
    expect(aggregate).toBeDefined()
    expect(aggregate.message.role).toBe('assistant')
    expect(aggregate.message.content).toEqual([{ type: 'text', text: 'Hello world' }])
  })

  it('emits an aggregate `type:"assistant"` with the thinking block after reasoning stops', () => {
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'r-1',
      item: { id: 'r-1', type: 'reasoning' },
    })
    n.handle(ServerNotifications.ReasoningTextDelta, { threadId: 't', turnId: 'r1', itemId: 'r-1', delta: 'Pondering' })
    const itemDone = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'r-1',
      item: { id: 'r-1', type: 'reasoning', content: ['Pondering'] },
    })
    const aggregate = itemDone.find((m) => m?.type === 'assistant')
    expect(aggregate).toBeDefined()
    expect(aggregate.message.content).toEqual([{ type: 'thinking', thinking: 'Pondering' }])
  })

  it('emits an aggregate `tool_use` envelope BEFORE the user.tool_result so JSONL replay can link them by id', () => {
    // Order matters: session-store.convertEventsToMessages builds toolUseMap
    // lazily as `assistant` messages arrive. If the user.tool_result is seen
    // before the corresponding tool_use, the link is silently dropped.
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'cmd',
      item: { id: 'cmd', type: 'commandExecution', command: 'ls' },
    })
    const itemDone = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'cmd',
      item: { id: 'cmd', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a\nb\n', status: 'completed' },
    })
    const assistantIdx = itemDone.findIndex((m) => m?.type === 'assistant')
    const userIdx = itemDone.findIndex((m) => m?.type === 'user')
    expect(assistantIdx).toBeGreaterThanOrEqual(0)
    expect(userIdx).toBeGreaterThanOrEqual(0)
    expect(assistantIdx).toBeLessThan(userIdx)

    const aggregate = itemDone[assistantIdx]
    expect(aggregate.message.content).toEqual([{
      type: 'tool_use',
      id: 'cmd',
      name: 'Bash',
      input: { command: 'ls' },
    }])

    const toolResult = itemDone[userIdx]
    expect(toolResult.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'cmd',
      is_error: false,
    })
  })

  it('does not emit an empty aggregate for a text block that streamed no content', () => {
    // Defensive: a placeholder text block with no deltas and no item.text
    // should not surface a degenerate `assistant` envelope.
    const n = createNormalizer()
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'msg-empty',
      item: { id: 'msg-empty', type: 'agentMessage' },
    })
    const itemDone = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'msg-empty',
      item: { id: 'msg-empty', type: 'agentMessage', text: '' },
    })
    expect(itemDone.find((m) => m?.type === 'assistant')).toBeUndefined()
  })

  // ──────────────────────────────────────────────────────────────────────
  // includePartialMessages = true (live-UI mode)
  // ──────────────────────────────────────────────────────────────────────
  //
  // Production regression (chat showed the reply text stacked twice): in the
  // default app-chat / interactive chat path Halo passes
  // `includePartialMessages: true` to the SDK adapter. With Codex this
  // previously meant stream-processor's `lastTextContent` was written TWICE
  // — once from the stream_event content_block_stop, then again from the
  // aggregate `type:'assistant'` text thought — producing a doubled
  // bubble. Claude SDK avoids this by emitting text in EITHER stream_event
  // OR aggregate, never both. These tests lock the same either/or in Codex.

  it('suppresses aggregate text content when includePartialMessages=true (stream_event is the live source)', () => {
    const n = createNormalizer({ includePartialMessages: true })
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'msg-1',
      item: { id: 'msg-1', type: 'agentMessage' },
    })
    n.handle(ServerNotifications.AgentMessageDelta, { threadId: 't', turnId: 'r1', itemId: 'msg-1', delta: '你好！有什么我可以帮你的吗？😊' })
    const itemDone = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'msg-1',
      item: { id: 'msg-1', type: 'agentMessage', text: '你好！有什么我可以帮你的吗？😊' },
    })
    // stream_event content_block_stop still fires (drives live UI)…
    const streamStop = streamEvents(itemDone).find((e) => e.type === 'content_block_stop')
    expect(streamStop).toBeDefined()
    // …but NO aggregate `type:'assistant'` text envelope is emitted, so
    // stream-processor.ts:711-726 has nothing to append on top of the
    // already-streamed lastTextContent — no doubled bubble.
    expect(itemDone.find((m) => m?.type === 'assistant')).toBeUndefined()
  })

  it('suppresses aggregate thinking content when includePartialMessages=true', () => {
    const n = createNormalizer({ includePartialMessages: true })
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'r-1',
      item: { id: 'r-1', type: 'reasoning' },
    })
    n.handle(ServerNotifications.ReasoningTextDelta, { threadId: 't', turnId: 'r1', itemId: 'r-1', delta: 'Pondering' })
    const itemDone = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'r-1',
      item: { id: 'r-1', type: 'reasoning', content: ['Pondering'] },
    })
    expect(itemDone.find((m) => m?.type === 'assistant')).toBeUndefined()
  })

  it('still emits aggregate tool_use envelope when includePartialMessages=true (ordering for JSONL linking is mandatory)', () => {
    // tool_use aggregate is independent of the text/thinking split because
    // session-store.convertEventsToMessages links tool_use ↔ tool_result by
    // id during JSONL replay, and the user.tool_result envelope MUST be
    // preceded by its tool_use `assistant` aggregate.
    const n = createNormalizer({ includePartialMessages: true })
    n.handle(ServerNotifications.TurnStarted, { threadId: 't', turnId: 'r1' })
    n.handle(ServerNotifications.ItemStarted, {
      threadId: 't', turnId: 'r1', itemId: 'cmd',
      item: { id: 'cmd', type: 'commandExecution', command: 'ls' },
    })
    const itemDone = n.handle(ServerNotifications.ItemCompleted, {
      threadId: 't', turnId: 'r1', itemId: 'cmd',
      item: { id: 'cmd', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a\nb\n', status: 'completed' },
    })
    const aggregate = itemDone.find((m) => m?.type === 'assistant')
    expect(aggregate).toBeDefined()
    expect(aggregate.message.content[0]).toMatchObject({ type: 'tool_use', id: 'cmd', name: 'Bash' })
  })

  it('REGRESSION: handle() emits zero messages until a turn-scoped notification arrives', () => {
    // Halo's stream-processor reads `system:init` (and message_start, etc.)
    // as "a turn started" and flips chat.store.isStreaming=true. If anything
    // turn-shaped reaches the stream during warmup — before the user has
    // sent a message — the UI freezes in the "Thinking…" state, the user reasonably
    // hits Stop, the consumer enters silent-drain, and the next real
    // message goes black. This invariant locks the contract: the
    // normalizer MUST NOT emit anything spontaneously. It only reacts to
    // notifications it's explicitly handed.
    const n = createNormalizer()
    // No handle() calls. We do NOT call createInit. State is freshly
    // constructed — nothing should be observable.
    expect(n.isTerminal()).toBe(false)
    // Notifications unrelated to any turn (e.g. mid-warm warnings) are
    // also silent.
    expect(n.handle(ServerNotifications.Warning, { message: 'meh' })).toEqual([])
  })
})
