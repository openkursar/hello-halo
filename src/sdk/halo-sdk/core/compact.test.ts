/**
 * Unit tests for compaction utilities.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AutoCompactState,
  shouldAutoCompact,
  calculateTokenWarningState,
  microCompact,
  apiCompact,
  formatCompactSummary,
  fullCompact,
  autoCompactIfNeeded,
} from './compact.js';
import type { Message, ToolResultBlock, LlmProvider, ProviderResponse } from '../types/provider.js';

// ---------------------------------------------------------------------------
// AutoCompactState — circuit breaker
// ---------------------------------------------------------------------------

describe('AutoCompactState', () => {
  it('starts with all zeros, not disabled', () => {
    const state = new AutoCompactState();
    expect(state.compactionCount).toBe(0);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.disabled).toBe(false);
  });

  it('onSuccess() increments compactionCount and resets consecutiveFailures', () => {
    const state = new AutoCompactState();
    state.onFailure();
    state.onSuccess();
    expect(state.compactionCount).toBe(1);
    expect(state.consecutiveFailures).toBe(0);
  });

  it('onFailure() increments consecutiveFailures', () => {
    const state = new AutoCompactState();
    state.onFailure();
    state.onFailure();
    expect(state.consecutiveFailures).toBe(2);
    expect(state.disabled).toBe(false);
  });

  it('opens circuit breaker after MAX_CONSECUTIVE_COMPACT_FAILURES (3) failures', () => {
    const state = new AutoCompactState();
    state.onFailure();
    state.onFailure();
    expect(state.disabled).toBe(false);
    state.onFailure(); // 3rd failure → open
    expect(state.disabled).toBe(true);
  });

  it('success resets consecutiveFailures but does not re-enable after circuit open', () => {
    const state = new AutoCompactState();
    state.onFailure();
    state.onFailure();
    state.onFailure(); // circuit open
    state.onSuccess();
    // Circuit stays open — once tripped, manual reset is needed
    expect(state.disabled).toBe(true);
    expect(state.consecutiveFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoCompact
// ---------------------------------------------------------------------------

describe('shouldAutoCompact', () => {
  it('returns false when circuit breaker is open', () => {
    const state = new AutoCompactState();
    state.disabled = true;
    expect(shouldAutoCompact(1_000_000, 200_000, state)).toBe(false);
  });

  it('returns false when tokens are below threshold (90% of context window)', () => {
    const state = new AutoCompactState();
    // claude-sonnet-4-6 → 200k context window; threshold = 180k
    expect(shouldAutoCompact(150_000, 200_000, state)).toBe(false);
  });

  it('returns true when tokens exceed threshold', () => {
    const state = new AutoCompactState();
    expect(shouldAutoCompact(190_000, 200_000, state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// calculateTokenWarningState
// ---------------------------------------------------------------------------

describe('calculateTokenWarningState', () => {
  it('returns ok when usage is low', () => {
    expect(calculateTokenWarningState(50_000, 200_000)).toBe('ok');
  });

  it('returns warning at 80%+', () => {
    // 200k window → 80% = 160k
    expect(calculateTokenWarningState(165_000, 200_000)).toBe('warning');
  });

  it('returns critical at 95%+', () => {
    // 200k window → 95% = 190k
    expect(calculateTokenWarningState(195_000, 200_000)).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// microCompact — replaces large tool results with placeholders
// microCompact returns { messages, truncatedCount }
// ---------------------------------------------------------------------------

function makeToolResultMsg(content: string): Message {
  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'tu1',
      content,
    } as ToolResultBlock],
  };
}

describe('microCompact', () => {
  it('does not discard image results solely because encoded bytes are large', () => {
    const image: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image', content: [{
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4 * 1024 * 1024) },
    }] }] };
    const messages = [image, makeToolResultMsg('recent 1'), makeToolResultMsg('recent 2')];
    expect(microCompact(messages, 20_000).truncatedCount).toBe(0);
    expect(apiCompact([...Array.from({ length: 12 }, () => image)])).toBeNull();
  });

  it('returns messages unchanged when no large tool results', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const { messages, truncatedCount } = microCompact(msgs, 1_000_000);
    expect(messages).toHaveLength(2);
    expect(truncatedCount).toBe(0);
    expect(messages[0].content).toBe('Hello');
  });

  it('truncates large tool results when over budget', () => {
    const bigContent = 'x'.repeat(100_000);
    // Two extra recent tool cycles so the oldest result is unprotected.
    const msgs: Message[] = [
      makeToolResultMsg(bigContent),
      makeToolResultMsg('recent 1'),
      makeToolResultMsg('recent 2'),
    ];
    // Pass a small budget to force truncation
    const { messages, truncatedCount } = microCompact(msgs, 100);
    expect(truncatedCount).toBeGreaterThan(0);
    const block = (messages[0].content as ToolResultBlock[])[0];
    expect(block.content).toContain('[tool result truncated');
  });

  it('never truncates the most recent tool cycles', () => {
    const bigContent = 'x'.repeat(100_000);
    const msgs: Message[] = [makeToolResultMsg(bigContent)];
    // The only result is also the most recent → protected even over budget.
    const { messages, truncatedCount } = microCompact(msgs, 100);
    expect(truncatedCount).toBe(0);
    const block = (messages[0].content as ToolResultBlock[])[0];
    expect(block.content).toBe(bigContent);
  });

  it('returns truncatedCount=0 when within budget', () => {
    const msgs: Message[] = [makeToolResultMsg('small content')];
    const { truncatedCount } = microCompact(msgs, 1_000_000);
    expect(truncatedCount).toBe(0);
  });

  it('does not modify string-content messages', () => {
    const msgs: Message[] = [{ role: 'user', content: 'plain text' }];
    const { messages } = microCompact(msgs, 0); // budget=0 forces compaction
    expect(messages[0].content).toBe('plain text');
  });
});

// ---------------------------------------------------------------------------
// apiCompact — removes old messages, returns null when no compaction needed
// apiCompact returns Message[] | null
// ---------------------------------------------------------------------------

describe('apiCompact', () => {
  it('returns null when messages are under MAX_INPUT_TOKENS', () => {
    const msgs: Message[] = Array.from({ length: 5 }, (_, i) => ({
      role: 'user' as const,
      content: `msg ${i}`,
    }));
    // Short messages → well under 180k tokens → returns null
    const result = apiCompact(msgs);
    expect(result).toBeNull();
  });

  it('returns trimmed message array when over MAX_INPUT_TOKENS', () => {
    // Create many large messages to exceed the 180k token threshold
    // Each message is 15,000 chars ≈ 4500 tokens; 60 msgs ≈ 270k tokens
    const msgs: Message[] = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: 'a'.repeat(15_000),
    }));
    const result = apiCompact(msgs);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThan(msgs.length);
  });

  it('returns null when message count is too small to trim', () => {
    // KEEP_RECENT_MESSAGES=10; with ≤11 messages, returns null
    const msgs: Message[] = Array.from({ length: 5 }, () => ({
      role: 'user' as const,
      content: 'a'.repeat(10_000), // large but not enough messages
    }));
    const result = apiCompact(msgs);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// microCompact — array-typed tool_result content
// ---------------------------------------------------------------------------

describe('microCompact — array content', () => {
  it('counts array-typed tool_result content against the budget', () => {
    const msgs: Message[] = [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tu1',
        content: [{ type: 'text', text: 'x'.repeat(50_000) }],
      } as ToolResultBlock],
    }, makeToolResultMsg('recent 1'), makeToolResultMsg('recent 2')];
    // Budget smaller than content → should truncate
    const { truncatedCount } = microCompact(msgs, 100);
    expect(truncatedCount).toBe(1);
  });

  it('truncates array-typed content to placeholder string', () => {
    const msgs: Message[] = [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tu2',
        content: [{ type: 'text', text: 'large content here'.repeat(5000) }],
      } as ToolResultBlock],
    }, makeToolResultMsg('recent 1'), makeToolResultMsg('recent 2')];
    const { messages } = microCompact(msgs, 100);
    const block = (messages[0].content as ToolResultBlock[])[0];
    // After truncation, content is replaced with a string placeholder
    expect(typeof block.content).toBe('string');
    expect(block.content as string).toContain('[tool result truncated');
  });

  it('leaves array content untouched when within budget', () => {
    const text = 'small';
    const msgs: Message[] = [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tu3',
        content: [{ type: 'text', text }],
      } as ToolResultBlock],
    }];
    const { messages, truncatedCount } = microCompact(msgs, 1_000_000);
    expect(truncatedCount).toBe(0);
    const block = (messages[0].content as ToolResultBlock[])[0];
    expect(Array.isArray(block.content)).toBe(true);
  });

  it('truncates oldest tool result first when multiple messages exceed budget', () => {
    const make = (id: string, size: number): Message => ({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        content: 'a'.repeat(size),
      } as ToolResultBlock],
    });
    // Three large messages; the two most recent cycles are protected,
    // so only the oldest is truncatable.
    const msgs: Message[] = [make('old', 60_000), make('mid', 60_000), make('new', 60_000)];
    const { messages, truncatedCount } = microCompact(msgs, 60_000);
    expect(truncatedCount).toBe(1);
    // The first (oldest) message should be truncated
    const firstBlock = (messages[0].content as ToolResultBlock[])[0];
    expect(firstBlock.content as string).toContain('[tool result truncated');
    // The two most recent should be intact
    for (const idx of [1, 2]) {
      const block = (messages[idx].content as ToolResultBlock[])[0];
      expect(typeof block.content).toBe('string');
      expect((block.content as string).startsWith('a')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// formatCompactSummary
// ---------------------------------------------------------------------------

describe('formatCompactSummary', () => {
  it('returns cleaned summary without leading/trailing whitespace', () => {
    const result = formatCompactSummary('  Summary text  ');
    expect(result.trim()).toBe('Summary text');
  });

  it('returns empty string for empty input', () => {
    expect(formatCompactSummary('')).toBe('');
  });

  it('strips <analysis>...</analysis> block entirely', () => {
    const input = '<analysis>This is analysis</analysis>\nSome conclusion.';
    const result = formatCompactSummary(input);
    expect(result).not.toContain('<analysis>');
    expect(result).not.toContain('This is analysis');
    expect(result).toContain('Some conclusion.');
  });

  it('converts <summary>...</summary> to "Summary:\\n" prefix', () => {
    const input = '<summary>Key findings here.</summary>';
    const result = formatCompactSummary(input);
    expect(result).toContain('Summary:');
    expect(result).toContain('Key findings here.');
    expect(result).not.toContain('<summary>');
    expect(result).not.toContain('</summary>');
  });

  it('handles both <analysis> and <summary> together', () => {
    const input =
      '<analysis>Internal reasoning.</analysis>\n' +
      '<summary>The final answer.</summary>';
    const result = formatCompactSummary(input);
    expect(result).not.toContain('<analysis>');
    expect(result).not.toContain('Internal reasoning.');
    expect(result).toContain('Summary:');
    expect(result).toContain('The final answer.');
  });

  it('preserves internal whitespace that can belong to source excerpts', () => {
    const input = 'Line 1\n\n\n\nLine 2';
    expect(formatCompactSummary(input)).toBe(input);
  });

  it('passes through text with no XML tags unchanged (modulo trim)', () => {
    const input = 'Plain summary without any tags.';
    expect(formatCompactSummary(input)).toBe(input);
  });

  it('preserves analysis tags inside recorded task content', () => {
    const input = 'Preamble.\n<analysis>Keep this source excerpt.</analysis>\nEpilogue.';
    expect(formatCompactSummary(input)).toBe(input);
  });

  it.each([
    '</analysis>Before<analysis>After',
    '```xml\n<analysis>source text</analysis>\n```',
    '<analysis>unclosed content',
    '<summary>outer<summary>inner</summary></summary>',
    '<analysis>outer<analysis>inner</analysis></analysis>\nConclusion.',
  ])('does not reinterpret malformed or quoted envelopes: %s', input => {
    expect(formatCompactSummary(input)).toBe(input);
  });

  it('preserves content before and after summary tags', () => {
    const input = 'Intro.\n<summary>Core content.</summary>\nOutro.';
    const result = formatCompactSummary(input);
    expect(result).toContain('Intro.');
    expect(result).toContain('Core content.');
    expect(result).toContain('Outro.');
  });
});

// ---------------------------------------------------------------------------
// fullCompact — async, requires mock LlmProvider
// ---------------------------------------------------------------------------

function makeMockProvider(summaryText: string): LlmProvider {
  const response: ProviderResponse = {
    content: [{ type: 'text', text: summaryText }],
    stopReason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  return {
    createMessage: vi.fn().mockResolvedValue(response),
    createMessageStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
  } as unknown as LlmProvider;
}

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `Message ${i}`,
  }));
}

describe('fullCompact', () => {
  it('returns messages unchanged when total is at or below KEEP_RECENT_MESSAGES + 1', async () => {
    const provider = makeMockProvider('summary');
    // KEEP_RECENT_MESSAGES=10 → threshold is ≤11 messages
    const msgs = makeMessages(11);
    const result = await fullCompact(msgs, provider, 'claude-sonnet-4-6', '');
    expect(result.messages).toHaveLength(11);
    expect(result.summary).toBe('');
    expect(result.tokensFreed).toBe(0);
    expect(provider.createMessage).not.toHaveBeenCalled();
  });

  it('calls provider.createMessage with a transcript and returns compacted messages', async () => {
    const provider = makeMockProvider('Summary:\nThe conversation covered X and Y.');
    const msgs = makeMessages(14); // 14 > 11
    const result = await fullCompact(msgs, provider, 'claude-sonnet-4-6', '');
    expect(provider.createMessage).toHaveBeenCalledOnce();
    // Result starts with compact notice, then tail (last 10 messages)
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(msgs.length);
    // Summary is present
    expect(result.summary).toBeTruthy();
  });

  it('first new message is the compact notice containing the summary', async () => {
    const rawSummary = 'The session covered file edits and tests.';
    const provider = makeMockProvider(rawSummary);
    const msgs = makeMessages(14);
    const result = await fullCompact(msgs, provider, 'claude-sonnet-4-6', '');
    const notice = result.messages[0];
    expect(notice.role).toBe('user');
    expect(typeof notice.content).toBe('string');
    expect(notice.content as string).toContain('summary of earlier messages, not a new user request');
    expect(notice.content as string).toContain(rawSummary);
  });

  it('tokensFreed is non-negative', async () => {
    const provider = makeMockProvider('Compact summary.');
    const msgs = makeMessages(20);
    const result = await fullCompact(msgs, provider, 'claude-sonnet-4-6', '');
    expect(result.tokensFreed).toBeGreaterThanOrEqual(0);
  });

  it('throws when provider returns empty summary', async () => {
    const emptyResponse: ProviderResponse = {
      content: [{ type: 'text', text: '' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    const provider = {
      createMessage: vi.fn().mockResolvedValue(emptyResponse),
      createMessageStream: vi.fn(),
      listModels: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as LlmProvider;
    const msgs = makeMessages(14);
    await expect(fullCompact(msgs, provider, 'claude-sonnet-4-6', '')).rejects.toThrow(
      'Compact summary was empty',
    );
  });
});

// ---------------------------------------------------------------------------
// autoCompactIfNeeded
// ---------------------------------------------------------------------------

describe('autoCompactIfNeeded', () => {
  it('returns null when tokens are below auto-compact threshold', async () => {
    const provider = makeMockProvider('summary');
    const state = new AutoCompactState();
    const msgs = makeMessages(20);
    // claude-sonnet-4-6 → 200k context window; threshold=180k; pass 100k tokens
    const result = await autoCompactIfNeeded(msgs, 100_000, 200_000, 'claude-sonnet-4-6', provider, '', state);
    expect(result).toBeNull();
    expect(provider.createMessage).not.toHaveBeenCalled();
  });

  it('runs fullCompact and calls state.onSuccess() when above threshold', async () => {
    const provider = makeMockProvider('The session summary.');
    const state = new AutoCompactState();
    const msgs = makeMessages(20);
    // Pass 190k tokens (above 180k threshold)
    const result = await autoCompactIfNeeded(msgs, 190_000, 200_000, 'claude-sonnet-4-6', provider, '', state);
    expect(result).not.toBeNull();
    expect(state.compactionCount).toBe(1);
    expect(state.consecutiveFailures).toBe(0);
  });

  it('returns null and calls state.onFailure() when fullCompact throws', async () => {
    const provider = {
      createMessage: vi.fn().mockRejectedValue(new Error('API failure')),
      createMessageStream: vi.fn(),
      listModels: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as LlmProvider;
    const state = new AutoCompactState();
    const msgs = makeMessages(20);
    const result = await autoCompactIfNeeded(msgs, 190_000, 200_000, 'claude-sonnet-4-6', provider, '', state);
    expect(result).toBeNull();
    expect(state.consecutiveFailures).toBe(1);
  });

  it('returns null when circuit breaker is already open', async () => {
    const provider = makeMockProvider('summary');
    const state = new AutoCompactState();
    state.disabled = true;
    const msgs = makeMessages(20);
    const result = await autoCompactIfNeeded(msgs, 190_000, 200_000, 'claude-sonnet-4-6', provider, '', state);
    expect(result).toBeNull();
    expect(provider.createMessage).not.toHaveBeenCalled();
  });
});
