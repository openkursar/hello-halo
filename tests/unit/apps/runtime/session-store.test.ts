/**
 * Unit tests for apps/runtime/session-store — convertEventsToMessages()
 *
 * Tests the event-to-message conversion that powers three display scenarios:
 * - Digital human chat (Halo Chat)
 * - IM session display
 * - Scheduled run detail view ("View Process")
 *
 * The core invariant: one agent turn = one merged thought-process block + one message bubble,
 * matching the main-space conversation rendering behavior.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  convertEventsToMessages,
  openSessionWriter,
  readSessionMessages,
  type StoredEvent,
} from '../../../../src/main/apps/runtime/session-store'

// ============================================
// Test Helpers — Event Factories
// ============================================

/** Create an assistant event with text content */
function assistantText(text: string, ts = '2026-01-01T00:00:00.000Z'): StoredEvent {
  return {
    _ts: ts,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

/** Create an assistant event with a thinking block */
function assistantThinking(thinking: string, ts = '2026-01-01T00:00:00.000Z'): StoredEvent {
  return {
    _ts: ts,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking }],
    },
  }
}

/** Create an assistant event with a tool_use block */
function assistantToolUse(
  toolName: string,
  toolId: string,
  input: Record<string, unknown> = {},
  ts = '2026-01-01T00:00:00.000Z'
): StoredEvent {
  return {
    _ts: ts,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
    },
  }
}

/** Create an assistant event with thinking + tool_use (common pattern) */
function assistantThinkingAndToolUse(
  thinking: string,
  toolName: string,
  toolId: string,
  input: Record<string, unknown> = {},
  ts = '2026-01-01T00:00:00.000Z'
): StoredEvent {
  return {
    _ts: ts,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking },
        { type: 'tool_use', id: toolId, name: toolName, input },
      ],
    },
  }
}

/** Create a user event with tool_result */
function userToolResult(
  toolUseId: string,
  output: string,
  isError = false,
  ts = '2026-01-01T00:00:00.000Z'
): StoredEvent {
  return {
    _ts: ts,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output, is_error: isError }],
    },
  }
}

/** Create a user trigger message */
function userTrigger(text: string, ts = '2026-01-01T00:00:00.000Z'): StoredEvent {
  return {
    _ts: ts,
    type: 'user',
    _isTrigger: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  }
}

/** Create a user message carrying image blocks; `isTrigger` marks it as user-sent */
function userTriggerWithImages(
  text: string,
  images: Array<{ name?: string; data: string }>,
  ts = '2026-01-01T00:00:00.000Z',
  isTrigger = true
): StoredEvent {
  return {
    _ts: ts,
    type: 'user',
    ...(isTrigger ? { _isTrigger: true } : {}),
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map(img => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: img.data },
          ...(img.name ? { _name: img.name } : {}),
        })),
      ],
    },
  }
}

/** Create a system event (should be skipped) */
function systemEvent(ts = '2026-01-01T00:00:00.000Z'): StoredEvent {
  return { _ts: ts, type: 'system' }
}

/** Create a result event (should be skipped) */
function resultEvent(ts = '2026-01-01T00:00:00.000Z'): StoredEvent {
  return { _ts: ts, type: 'result' }
}

/** Create a Codex-style terminal result event carrying the turn's final text */
function resultWithText(
  result: string,
  isError = false,
  ts = '2026-01-01T00:00:00.000Z'
): StoredEvent {
  return { _ts: ts, type: 'result', subtype: isError ? 'error_during_execution' : 'success', result, is_error: isError }
}

function streamEvent(event: Record<string, unknown>, ts = '2026-01-01T00:00:00.000Z'): StoredEvent {
  return { _ts: ts, type: 'stream_event', event }
}

// ============================================
// Tests
// ============================================

describe('convertEventsToMessages', () => {
  // ── Core: Single Turn Merging ──

  describe('single turn merging', () => {
    it('merges a full agent turn into one message with one thought block', () => {
      // Simulates: thinking → Read tool → tool result → thinking → text output
      const events: StoredEvent[] = [
        userTrigger('Check my config', '2026-01-01T00:00:00.000Z'),
        assistantThinkingAndToolUse('Let me read the config', 'Read', 'tool-1', { file_path: '/etc/config' }, '2026-01-01T00:00:01.000Z'),
        userToolResult('tool-1', 'config content here', false, '2026-01-01T00:00:02.000Z'),
        assistantThinking('Got the config, analyzing...', '2026-01-01T00:00:03.000Z'),
        assistantText('Your config looks good!', '2026-01-01T00:00:04.000Z'),
      ]

      const messages = convertEventsToMessages(events)

      // Should produce: 1 user message + 1 assistant message
      expect(messages).toHaveLength(2)
      expect(messages[0].role).toBe('user')
      expect(messages[0].content).toBe('Check my config')

      const assistant = messages[1]
      expect(assistant.role).toBe('assistant')
      expect(assistant.content).toBe('Your config looks good!')
      expect(assistant.thoughts).toBeDefined()
      expect(assistant.thoughts!.length).toBe(3) // thinking + tool_use + thinking
      expect(assistant.thoughts![0].type).toBe('thinking')
      expect(assistant.thoughts![1].type).toBe('tool_use')
      expect(assistant.thoughts![1].toolName).toBe('Read')
      expect(assistant.thoughts![1].toolResult).toBeDefined()
      expect(assistant.thoughts![1].toolResult!.output).toBe('config content here')
      expect(assistant.thoughts![2].type).toBe('thinking')
    })

    it('merges multiple tool calls into one thought block', () => {
      // Simulates: thinking → tool1 → result1 → thinking → tool2 → result2 → text
      const events: StoredEvent[] = [
        userTrigger('Analyze my project'),
        assistantThinkingAndToolUse('Reading file A', 'Read', 'tool-1', { file_path: '/a.ts' }),
        userToolResult('tool-1', 'file A content'),
        assistantThinkingAndToolUse('Now reading file B', 'Read', 'tool-2', { file_path: '/b.ts' }),
        userToolResult('tool-2', 'file B content'),
        assistantThinking('Both files look related'),
        assistantText('Files A and B are consistent.'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(2) // user + 1 assistant
      const assistant = messages[1]
      expect(assistant.content).toBe('Files A and B are consistent.')
      // 3 thinking + 2 tool_use = 5 thoughts
      expect(assistant.thoughts!.length).toBe(5)
      expect(assistant.thoughtsSummary!.count).toBe(5)
      expect(assistant.thoughtsSummary!.types['thinking']).toBe(3)
      expect(assistant.thoughtsSummary!.types['tool_use']).toBe(2)
    })
  })

  // ── Text Merging Logic ──

  describe('text merging', () => {
    it('concatenates consecutive text blocks (no tool in between)', () => {
      const events: StoredEvent[] = [
        assistantText('Part 1'),
        assistantText('Part 2'),
        assistantText('Part 3'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('Part 1\n\nPart 2\n\nPart 3')
    })

    it('replaces text when a substantive tool intervenes', () => {
      // text A → Read tool → text B → Bash tool → text C
      // Expected: content = text C, thoughts include text A and text B as 'text' type
      const events: StoredEvent[] = [
        assistantText('Looking at the code...', '2026-01-01T00:00:01.000Z'),
        assistantToolUse('Read', 'tool-1', { file_path: '/foo.ts' }, '2026-01-01T00:00:02.000Z'),
        userToolResult('tool-1', 'content of foo.ts', false, '2026-01-01T00:00:03.000Z'),
        assistantText('Found an issue, running fix...', '2026-01-01T00:00:04.000Z'),
        assistantToolUse('Bash', 'tool-2', { command: 'npm run fix' }, '2026-01-01T00:00:05.000Z'),
        userToolResult('tool-2', 'fixed', false, '2026-01-01T00:00:06.000Z'),
        assistantText('All fixed!', '2026-01-01T00:00:07.000Z'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('All fixed!')

      // Should have: tool_use(Read), text(A demoted), tool_use(Bash), text(B demoted) = 4 thoughts
      // Note: demoted text appears AFTER the tool that caused the demotion, because the
      // demotion happens when the next text block arrives (deferred evaluation).
      const thoughts = messages[0].thoughts!
      expect(thoughts.length).toBe(4)

      // First thought: Read tool (pushed when encountered)
      expect(thoughts[0].type).toBe('tool_use')
      expect(thoughts[0].toolName).toBe('Read')

      // Second thought: demoted text A (pushed when text B arrives and sees hadSubstantiveTool)
      expect(thoughts[1].type).toBe('text')
      expect(thoughts[1].content).toBe('Looking at the code...')

      // Third thought: Bash tool (pushed when encountered)
      expect(thoughts[2].type).toBe('tool_use')
      expect(thoughts[2].toolName).toBe('Bash')

      // Fourth thought: demoted text B (pushed when text C arrives and sees hadSubstantiveTool)
      expect(thoughts[3].type).toBe('text')
      expect(thoughts[3].content).toBe('Found an issue, running fix...')
    })

    it('concatenates text when only TodoWrite (transparent tool) is between texts', () => {
      const events: StoredEvent[] = [
        assistantText('Starting analysis...'),
        assistantToolUse('TodoWrite', 'tool-1', { todos: [] }),
        userToolResult('tool-1', 'ok'),
        assistantText('Analysis complete.'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(1)
      // TodoWrite is transparent — text should be concatenated
      expect(messages[0].content).toBe('Starting analysis...\n\nAnalysis complete.')
      // tool_use thought should still be present
      expect(messages[0].thoughts!.some(t => t.type === 'tool_use' && t.toolName === 'TodoWrite')).toBe(true)
      // No demoted text thoughts
      expect(messages[0].thoughts!.filter(t => t.type === 'text')).toHaveLength(0)
    })

    it('replaces text when a non-transparent tool follows a transparent tool', () => {
      // text A → TodoWrite → Read → text B
      // Read is substantive, so text A should be demoted
      const events: StoredEvent[] = [
        assistantText('Planning...'),
        assistantToolUse('TodoWrite', 'tool-1', { todos: [] }),
        userToolResult('tool-1', 'ok'),
        assistantToolUse('Read', 'tool-2', { file_path: '/x.ts' }),
        userToolResult('tool-2', 'content'),
        assistantText('Done!'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('Done!')
      // 'Planning...' should be demoted to a text thought
      expect(messages[0].thoughts!.filter(t => t.type === 'text')).toHaveLength(1)
      expect(messages[0].thoughts!.find(t => t.type === 'text')!.content).toBe('Planning...')
    })
  })

  // ── Multi-Turn (User Interleave) ──

  describe('multi-turn conversations', () => {
    it('produces separate messages per user turn', () => {
      const events: StoredEvent[] = [
        userTrigger('Question 1'),
        assistantThinking('Thinking about Q1'),
        assistantText('Answer 1'),
        userTrigger('Question 2'),
        assistantThinking('Thinking about Q2'),
        assistantText('Answer 2'),
      ]

      const messages = convertEventsToMessages(events)

      // user1 + assistant1 + user2 + assistant2 = 4
      expect(messages).toHaveLength(4)
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Question 1' })
      expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Answer 1' })
      expect(messages[1].thoughts).toHaveLength(1)
      expect(messages[2]).toMatchObject({ role: 'user', content: 'Question 2' })
      expect(messages[3]).toMatchObject({ role: 'assistant', content: 'Answer 2' })
      expect(messages[3].thoughts).toHaveLength(1)
    })

    it('flushes thoughts-only assistant turn before new user message', () => {
      // Agent does thinking + tool but no text, then user sends another message
      const events: StoredEvent[] = [
        userTrigger('Start task'),
        assistantThinkingAndToolUse('Let me check', 'Read', 'tool-1', { file_path: '/a' }),
        userToolResult('tool-1', 'content'),
        // No text output from assistant, then user sends new message
        userTrigger('Continue'),
        assistantText('Done!'),
      ]

      const messages = convertEventsToMessages(events)

      // user1 + thoughts-only assistant + user2 + assistant2 = 4
      expect(messages).toHaveLength(4)
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Start task' })
      // Thoughts-only assistant message
      expect(messages[1].role).toBe('assistant')
      expect(messages[1].content).toBe('')
      expect(messages[1].thoughts).toHaveLength(2) // thinking + tool_use
      expect(messages[2]).toMatchObject({ role: 'user', content: 'Continue' })
      expect(messages[3]).toMatchObject({ role: 'assistant', content: 'Done!' })
    })
  })

  // ── Edge Cases ──

  describe('edge cases', () => {
    it('returns empty array for no events', () => {
      expect(convertEventsToMessages([])).toHaveLength(0)
    })

    it('handles agent with only tool calls and no text output', () => {
      const events: StoredEvent[] = [
        userTrigger('Do something'),
        assistantThinkingAndToolUse('Working on it', 'Bash', 'tool-1', { command: 'echo hi' }),
        userToolResult('tool-1', 'hi'),
      ]

      const messages = convertEventsToMessages(events)

      // user + thoughts-only assistant = 2
      expect(messages).toHaveLength(2)
      expect(messages[1].role).toBe('assistant')
      expect(messages[1].content).toBe('')
      expect(messages[1].thoughts).toHaveLength(2) // thinking + tool_use
      expect(messages[1].thoughts![1].toolResult).toBeDefined()
    })

    it('skips system and result events', () => {
      const events: StoredEvent[] = [
        systemEvent(),
        userTrigger('Hello'),
        assistantText('Hi!'),
        resultEvent(),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(2) // user + assistant
      expect(messages[1].content).toBe('Hi!')
    })

    it('handles assistant event with non-array content gracefully', () => {
      const events: StoredEvent[] = [
        { _ts: '2026-01-01T00:00:00.000Z', type: 'assistant', message: { role: 'assistant', content: 'plain string' } },
        assistantText('After non-array'),
      ]

      const messages = convertEventsToMessages(events)

      // Non-array content is skipped, only the second text survives
      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('After non-array')
    })

    it('handles thinking with only whitespace (skipped)', () => {
      const events: StoredEvent[] = [
        { _ts: '2026-01-01T00:00:00.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '   ' }] } },
        assistantText('Result'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('Result')
      // Whitespace-only thinking should not be in thoughts
      expect(messages[0].thoughts).toBeUndefined()
    })

    it('does not create message when no thoughts and no text remain at end', () => {
      const events: StoredEvent[] = [
        systemEvent(),
        resultEvent(),
      ]

      const messages = convertEventsToMessages(events)
      expect(messages).toHaveLength(0)
    })
  })

  // ── Tool Result Merging ──

  describe('Codex stream_event persistence', () => {
    it('rebuilds thinking, tool calls, tool results, and final text from stream events', () => {
      const events: StoredEvent[] = [
        userTrigger('Inspect repo', '2026-01-01T00:00:00.000Z'),
        streamEvent({ type: 'message_start' }, '2026-01-01T00:00:01.000Z'),
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, '2026-01-01T00:00:02.000Z'),
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should inspect files.' } }, '2026-01-01T00:00:03.000Z'),
        streamEvent({ type: 'content_block_stop', index: 0 }, '2026-01-01T00:00:04.000Z'),
        streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'cmd-1', name: 'Bash', input: {} } }, '2026-01-01T00:00:05.000Z'),
        streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } }, '2026-01-01T00:00:06.000Z'),
        streamEvent({ type: 'content_block_stop', index: 1 }, '2026-01-01T00:00:07.000Z'),
        userToolResult('cmd-1', '/tmp/project\n', false, '2026-01-01T00:00:08.000Z'),
        streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }, '2026-01-01T00:00:09.000Z'),
        streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Repo inspected.' } }, '2026-01-01T00:00:10.000Z'),
        streamEvent({ type: 'content_block_stop', index: 2 }, '2026-01-01T00:00:11.000Z'),
        streamEvent({ type: 'message_stop' }, '2026-01-01T00:00:12.000Z'),
        resultEvent('2026-01-01T00:00:13.000Z'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(2)
      expect(messages[1].content).toBe('Repo inspected.')

      const thoughts = messages[1].thoughts!
      expect(thoughts).toHaveLength(2)
      expect(thoughts[0]).toMatchObject({ type: 'thinking', content: 'I should inspect files.' })
      expect(thoughts[1]).toMatchObject({
        type: 'tool_use',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        toolResult: { output: '/tmp/project\n', isError: false, timestamp: '2026-01-01T00:00:08.000Z' },
      })
      expect(messages[1].thoughtsSummary).toMatchObject({
        count: 2,
        types: { thinking: 1, tool_use: 1 },
      })
    })

    it('uses repaired or raw tool input for malformed streamed JSON without dropping the panel', () => {
      const events: StoredEvent[] = [
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } }),
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"' } }),
        streamEvent({ type: 'content_block_stop', index: 0 }),
        assistantText('Done'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('Done')
      expect(messages[0].thoughts![0]).toMatchObject({
        type: 'tool_use',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      })
    })

    it('does not duplicate Claude assistant-message thoughts when no stream events are persisted', () => {
      const events: StoredEvent[] = [
        assistantThinkingAndToolUse('Need to read', 'Read', 'tool-1', { file_path: '/a.ts' }),
        userToolResult('tool-1', 'content'),
        assistantText('Read complete.'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('Read complete.')
      expect(messages[0].thoughts).toHaveLength(2)
      expect(messages[0].thoughtsSummary).toMatchObject({
        count: 2,
        types: { thinking: 1, tool_use: 1 },
      })
    })
  })

  // ── Codex live-mode: result.result text fallback ──

  describe('Codex result-text fallback', () => {
    it('recovers the bubble text from result.result when the assistant text aggregate was suppressed', () => {
      // Codex live mode persists only the user trigger + terminal result for a
      // pure-text turn (the assistant text aggregate is suppressed and
      // stream_events are not persisted).
      const events: StoredEvent[] = [
        userTrigger('Hi', '2026-01-01T00:00:00.000Z'),
        resultWithText('Hello! How can I help?', false, '2026-01-01T00:00:01.000Z'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Hi' })
      expect(messages[1].role).toBe('assistant')
      expect(messages[1].content).toBe('Hello! How can I help?')
      expect(messages[1].timestamp).toBe('2026-01-01T00:00:01.000Z')
    })

    it('keeps tool thoughts while recovering final text from result.result', () => {
      // thinking is suppressed too in live mode, but the tool aggregate is
      // persisted; the final bubble text comes from the result envelope.
      const events: StoredEvent[] = [
        userTrigger('Run pwd', '2026-01-01T00:00:00.000Z'),
        assistantToolUse('Bash', 'c1', { command: 'pwd' }, '2026-01-01T00:00:01.000Z'),
        userToolResult('c1', '/tmp/project\n', false, '2026-01-01T00:00:02.000Z'),
        resultWithText('You are in /tmp/project.', false, '2026-01-01T00:00:03.000Z'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(2)
      expect(messages[1].content).toBe('You are in /tmp/project.')
      expect(messages[1].thoughts).toHaveLength(1)
      expect(messages[1].thoughts![0]).toMatchObject({
        type: 'tool_use',
        toolName: 'Bash',
        toolResult: { output: '/tmp/project\n', isError: false },
      })
    })

    it('prefers a reconstructed assistant text block over result.result (no override, no doubling)', () => {
      const events: StoredEvent[] = [
        assistantText('Real bubble text', '2026-01-01T00:00:00.000Z'),
        resultWithText('redundant final text', false, '2026-01-01T00:00:01.000Z'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('Real bubble text')
    })

    it('ignores result.result when the result is an error', () => {
      const events: StoredEvent[] = [
        userTrigger('Do x', '2026-01-01T00:00:00.000Z'),
        resultWithText('fatal error detail', true, '2026-01-01T00:00:01.000Z'),
      ]

      const messages = convertEventsToMessages(events)

      // No assistant bubble fabricated from an error result.
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Do x' })
    })

    it('associates each turn result with its own bubble across multiple turns', () => {
      const events: StoredEvent[] = [
        userTrigger('Q1', '2026-01-01T00:00:00.000Z'),
        resultWithText('A1', false, '2026-01-01T00:00:01.000Z'),
        userTrigger('Q2', '2026-01-01T00:00:02.000Z'),
        resultWithText('A2', false, '2026-01-01T00:00:03.000Z'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages.map(m => [m.role, m.content])).toEqual([
        ['user', 'Q1'],
        ['assistant', 'A1'],
        ['user', 'Q2'],
        ['assistant', 'A2'],
      ])
    })

    it('leaves a result event without a text payload inert', () => {
      const events: StoredEvent[] = [
        userTrigger('Hello'),
        assistantText('Hi!'),
        resultEvent(),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(2)
      expect(messages[1].content).toBe('Hi!')
    })
  })

  describe('tool result merging', () => {
    it('merges tool_result into corresponding tool_use thought', () => {
      const events: StoredEvent[] = [
        assistantToolUse('Read', 'tool-abc', { file_path: '/test.ts' }),
        userToolResult('tool-abc', 'file content here'),
        assistantText('Done'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(1)
      const toolThought = messages[0].thoughts!.find(t => t.type === 'tool_use')!
      expect(toolThought.toolResult).toEqual({
        output: 'file content here',
        isError: false,
        timestamp: expect.any(String),
      })
    })

    it('merges error tool_result correctly', () => {
      const events: StoredEvent[] = [
        assistantToolUse('Bash', 'tool-err', { command: 'bad-cmd' }),
        userToolResult('tool-err', 'command not found', true),
        assistantText('Command failed'),
      ]

      const messages = convertEventsToMessages(events)

      const toolThought = messages[0].thoughts!.find(t => t.type === 'tool_use')!
      expect(toolThought.toolResult!.isError).toBe(true)
      expect(toolThought.toolResult!.output).toBe('command not found')
    })

    it('handles orphan tool_result gracefully (no crash)', () => {
      const events: StoredEvent[] = [
        userToolResult('nonexistent-tool-id', 'orphan result'),
        assistantText('Still works'),
      ]

      const messages = convertEventsToMessages(events)

      // Should not crash, orphan result is simply ignored
      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('Still works')
    })
  })

  // ── ThoughtsSummary ──

  describe('thoughtsSummary', () => {
    it('includes correct counts per type', () => {
      const events: StoredEvent[] = [
        assistantThinking('Think 1'),
        assistantToolUse('Read', 'tool-1', {}),
        userToolResult('tool-1', 'ok'),
        assistantThinking('Think 2'),
        assistantText('Intermediate text', '2026-01-01T00:00:01.000Z'),
        assistantToolUse('Bash', 'tool-2', {}),
        userToolResult('tool-2', 'ok'),
        assistantText('Final text', '2026-01-01T00:00:02.000Z'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(1)
      const summary = messages[0].thoughtsSummary!
      // thinking(2) + tool_use(2) + text(1 demoted) = 5
      expect(summary.count).toBe(5)
      expect(summary.types['thinking']).toBe(2)
      expect(summary.types['tool_use']).toBe(2)
      expect(summary.types['text']).toBe(1)
    })

    it('omits thoughtsSummary when no thoughts', () => {
      const events: StoredEvent[] = [
        assistantText('Just text, no thinking'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages).toHaveLength(1)
      expect(messages[0].thoughts).toBeUndefined()
      expect(messages[0].thoughtsSummary).toBeUndefined()
    })
  })

  // ── Realistic Scenario: Full Automation Run ──

  describe('realistic automation run', () => {
    it('produces 1 message for a typical multi-step automation run', () => {
      // Simulates a typical automation: trigger → think → tool → result → think → text → tool → result → think → text → tool → result → final text
      const events: StoredEvent[] = [
        userTrigger('Scheduled run at 2026-01-01 00:00', '2026-01-01T00:00:00.000Z'),

        // Round 1: thinking + Read
        assistantThinkingAndToolUse('Let me check the database', 'Read', 'r1', { file_path: '/db.json' }, '2026-01-01T00:00:01.000Z'),
        userToolResult('r1', '{"status":"ok"}', false, '2026-01-01T00:00:02.000Z'),

        // Round 2: thinking + intermediate text + Bash
        assistantThinking('Database looks fine, running health check', '2026-01-01T00:00:03.000Z'),
        assistantText('Running health check...', '2026-01-01T00:00:04.000Z'),
        assistantToolUse('Bash', 'r2', { command: 'healthcheck' }, '2026-01-01T00:00:05.000Z'),
        userToolResult('r2', 'all healthy', false, '2026-01-01T00:00:06.000Z'),

        // Round 3: thinking + intermediate text + another tool
        assistantThinking('Health OK, let me update the status', '2026-01-01T00:00:07.000Z'),
        assistantText('Updating status...', '2026-01-01T00:00:08.000Z'),
        assistantToolUse('Write', 'r3', { file_path: '/status.json' }, '2026-01-01T00:00:09.000Z'),
        userToolResult('r3', 'written', false, '2026-01-01T00:00:10.000Z'),

        // Final output
        assistantThinking('All done', '2026-01-01T00:00:11.000Z'),
        assistantText('Health check completed. All systems operational.', '2026-01-01T00:00:12.000Z'),

        // SDK metadata (skipped)
        resultEvent('2026-01-01T00:00:13.000Z'),
      ]

      const messages = convertEventsToMessages(events)

      // Should be: 1 user trigger + 1 assistant message
      expect(messages).toHaveLength(2)

      const user = messages[0]
      expect(user.role).toBe('user')
      expect(user.content).toBe('Scheduled run at 2026-01-01 00:00')

      const assistant = messages[1]
      expect(assistant.role).toBe('assistant')
      expect(assistant.content).toBe('Health check completed. All systems operational.')

      // Count thoughts:
      // thinking(1) + tool_use(Read) + thinking(2) + text("Running health check...") + tool_use(Bash)
      // + thinking(3) + text("Updating status...") + tool_use(Write) + thinking(4) = 9
      expect(assistant.thoughts!.length).toBe(9)

      // Verify demoted intermediate texts are in thought process
      const textThoughts = assistant.thoughts!.filter(t => t.type === 'text')
      expect(textThoughts).toHaveLength(2)
      expect(textThoughts[0].content).toBe('Running health check...')
      expect(textThoughts[1].content).toBe('Updating status...')

      // Verify tool results are merged
      const toolThoughts = assistant.thoughts!.filter(t => t.type === 'tool_use')
      expect(toolThoughts).toHaveLength(3)
      expect(toolThoughts.every(t => t.toolResult !== undefined)).toBe(true)
    })
  })

  // ── Image attachments ──

  describe('image attachments', () => {
    it('reconstructs attached images on the user message', () => {
      const events: StoredEvent[] = [
        userTriggerWithImages('What is in this screenshot?', [
          { name: 'shot.png', data: 'AAAA' },
        ]),
        assistantText('A table of contacts.'),
      ]

      const messages = convertEventsToMessages(events)

      expect(messages[0]).toMatchObject({ role: 'user', content: 'What is in this screenshot?' })
      expect(messages[0].images).toEqual([
        { id: 'session-img-1-0', type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
      ])
      // Images belong to the user turn only.
      expect(messages[1].images).toBeUndefined()
    })

    it('keeps an image-only message (no text) visible', () => {
      const messages = convertEventsToMessages([
        userTriggerWithImages('', [{ data: 'AAAA' }]),
      ])

      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('')
      expect(messages[0].images).toHaveLength(1)
    })

    it('assigns distinct ids to the images of one message', () => {
      const messages = convertEventsToMessages([
        userTriggerWithImages('two', [{ data: 'AAAA' }, { data: 'BBBB' }]),
      ])

      const ids = messages[0].images!.map(i => i.id)
      expect(new Set(ids).size).toBe(2)
    })

    it('ignores image blocks on a user event that is not a trigger', () => {
      // SDK round-trip user events can carry image blocks that are tool
      // plumbing rather than something the user attached.
      const messages = convertEventsToMessages([
        userTriggerWithImages('tool echo', [{ data: 'AAAA' }], undefined, false),
      ])

      expect(messages[0].images).toBeUndefined()
    })

    it('omits the images field for a text-only message', () => {
      const messages = convertEventsToMessages([userTrigger('plain text')])
      expect(messages[0].images).toBeUndefined()
    })

    it('round-trips images through the JSONL writer and reader', () => {
      const spacePath = mkdtempSync(join(tmpdir(), 'halo-session-store-'))
      try {
        const writer = openSessionWriter(spacePath, 'app-1', 'run-1')
        writer.writeTrigger('Look at this', [
          { id: 'img-1', type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
        ])
        writer.writeEvent({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Got it.' }] },
        })

        const messages = readSessionMessages(spacePath, 'app-1', 'run-1')

        expect(messages.map(m => [m.role, m.content])).toEqual([
          ['user', 'Look at this'],
          ['assistant', 'Got it.'],
        ])
        expect(messages[0].images).toEqual([
          { id: 'session-img-1-0', type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
        ])
      } finally {
        rmSync(spacePath, { recursive: true, force: true })
      }
    })

    it('writes no image blocks when a trigger has no attachments', () => {
      const spacePath = mkdtempSync(join(tmpdir(), 'halo-session-store-'))
      try {
        openSessionWriter(spacePath, 'app-1', 'run-1').writeTrigger('text only')
        const messages = readSessionMessages(spacePath, 'app-1', 'run-1')

        expect(messages).toHaveLength(1)
        expect(messages[0].images).toBeUndefined()
      } finally {
        rmSync(spacePath, { recursive: true, force: true })
      }
    })
  })

  // ── Message ID uniqueness ──

  describe('message and thought IDs', () => {
    it('generates unique IDs across messages and thoughts', () => {
      const events: StoredEvent[] = [
        userTrigger('Q1'),
        assistantThinking('T1'),
        assistantToolUse('Read', 'tool-1', {}),
        assistantText('A1'),
        userTrigger('Q2'),
        assistantThinking('T2'),
        assistantText('A2'),
      ]

      const messages = convertEventsToMessages(events)

      // Collect all message IDs
      const msgIds = messages.map(m => m.id)
      expect(new Set(msgIds).size).toBe(msgIds.length)

      // Collect all thought IDs
      const thoughtIds = messages
        .flatMap(m => m.thoughts || [])
        .map(t => t.id)
      expect(new Set(thoughtIds).size).toBe(thoughtIds.length)
    })
  })
})
