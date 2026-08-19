/**
 * Unit tests for apps/runtime/reply-accumulator — ReplyTextAccumulator
 *
 * Guards the IM reply reconstruction fixed in issue #143: a multi-step agent
 * flow (text → tool_use → text → text) must deliver the full trailing run of
 * consecutive text, not just the last segment, and must not leak intermediate
 * narration that preceded a tool call.
 */

import { describe, it, expect } from 'vitest'
import { ReplyTextAccumulator } from '../../../../src/main/apps/runtime/reply-accumulator'

// ============================================
// Test Helpers — SDK Message Factories
// ============================================

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }

function assistant(...blocks: Block[]) {
  return { type: 'assistant', message: { content: blocks } }
}

function text(t: string): Block {
  return { type: 'text', text: t }
}

function toolUse(name = 'Bash'): Block {
  return { type: 'tool_use', name, input: {} }
}

function thinking(t: string): Block {
  return { type: 'thinking', thinking: t } as unknown as Block
}

function feedAll(acc: ReplyTextAccumulator, messages: unknown[]): string {
  for (const m of messages) acc.feed(m)
  return acc.getReply()
}

// ============================================
// Tests
// ============================================

describe('ReplyTextAccumulator', () => {
  it('returns empty string when nothing is fed', () => {
    expect(new ReplyTextAccumulator().getReply()).toBe('')
  })

  it('returns a single text segment unchanged', () => {
    const reply = feedAll(new ReplyTextAccumulator(), [assistant(text('Hello world'))])
    expect(reply).toBe('Hello world')
  })

  it('joins consecutive text segments with a blank line (issue #143)', () => {
    // The regression: multiple trailing text messages must all survive.
    const reply = feedAll(new ReplyTextAccumulator(), [
      assistant(text('Part one of the answer.')),
      assistant(text('Part two of the answer.')),
    ])
    expect(reply).toBe('Part one of the answer.\n\nPart two of the answer.')
  })

  it('drops narration that precedes a tool_use, keeps the trailing run', () => {
    // Flow: narration → tool → final answer (two consecutive segments).
    const reply = feedAll(new ReplyTextAccumulator(), [
      assistant(text('Let me check the logs.')),
      assistant(toolUse('Bash')),
      assistant(text('The build failed because of a type error.')),
      assistant(text('Fix: add the missing import.')),
    ])
    expect(reply).toBe(
      'The build failed because of a type error.\n\nFix: add the missing import.'
    )
  })

  it('resets on a tool_use in the same message as preceding text', () => {
    // content = [text, tool_use] then a fresh answer afterwards.
    const reply = feedAll(new ReplyTextAccumulator(), [
      assistant(text('Checking...'), toolUse('Read')),
      assistant(text('Here is the result.')),
    ])
    expect(reply).toBe('Here is the result.')
  })

  it('handles multiple tool rounds, keeping only the last text run', () => {
    const reply = feedAll(new ReplyTextAccumulator(), [
      assistant(text('First thought.')),
      assistant(toolUse('Grep')),
      assistant(text('Second thought.')),
      assistant(toolUse('Read')),
      assistant(text('Final answer.')),
    ])
    expect(reply).toBe('Final answer.')
  })

  it('ignores non-assistant messages and malformed content', () => {
    const acc = new ReplyTextAccumulator()
    acc.feed({ type: 'user', message: { content: [text('user input')] } })
    acc.feed({ type: 'stream_event', event: {} })
    acc.feed(null)
    acc.feed({ type: 'assistant' })
    acc.feed({ type: 'assistant', message: { content: 'not-an-array' } })
    acc.feed(assistant(text('Only this counts.')))
    expect(acc.getReply()).toBe('Only this counts.')
  })

  it('skips empty text blocks but keeps real ones', () => {
    const reply = feedAll(new ReplyTextAccumulator(), [
      assistant({ type: 'text', text: '' }),
      assistant(text('Real content.')),
    ])
    expect(reply).toBe('Real content.')
  })

  it('returns empty when the run ends on a tool_use with no trailing text', () => {
    // trailing tool round produced no answer text → fall back to streamResult
    const acc = new ReplyTextAccumulator()
    feedAll(acc, [assistant(text('Working on it.')), assistant(toolUse('Bash'))])
    expect(acc.getReply()).toBe('')
  })

  it('skips whitespace-only text blocks so the fallback can engage', () => {
    const acc = new ReplyTextAccumulator()
    acc.feed(assistant({ type: 'text', text: '   \n  ' }))
    expect(acc.getReply()).toBe('')
  })

  it('ignores thinking blocks without resetting or leaking them', () => {
    const reply = feedAll(new ReplyTextAccumulator(), [
      assistant(thinking('internal reasoning that must not be sent')),
      assistant(text('The visible answer.')),
    ])
    expect(reply).toBe('The visible answer.')
  })

  it('joins multiple text blocks within a single assistant message', () => {
    const reply = feedAll(new ReplyTextAccumulator(), [
      assistant(text('Block one.'), text('Block two.')),
    ])
    expect(reply).toBe('Block one.\n\nBlock two.')
  })

  it('trims surrounding whitespace so segments join cleanly', () => {
    const reply = feedAll(new ReplyTextAccumulator(), [
      assistant(text('First.\n\n')),
      assistant(text('  Second.')),
    ])
    expect(reply).toBe('First.\n\nSecond.')
  })
})
