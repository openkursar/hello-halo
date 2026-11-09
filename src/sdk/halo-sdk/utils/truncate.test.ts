/**
 * @module utils/truncate.test
 * Unit tests for content truncation utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULT_TOKENS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  truncateContent,
  truncateToolResult,
} from './truncate.js';

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('DEFAULT_MAX_RESULT_SIZE_CHARS is 50_000', () => {
    expect(DEFAULT_MAX_RESULT_SIZE_CHARS).toBe(50_000);
  });

  it('MAX_TOOL_RESULT_TOKENS is 100_000', () => {
    expect(MAX_TOOL_RESULT_TOKENS).toBe(100_000);
  });

  it('MAX_TOOL_RESULTS_PER_MESSAGE_CHARS is 200_000', () => {
    expect(MAX_TOOL_RESULTS_PER_MESSAGE_CHARS).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — within budget (no-op)
// ---------------------------------------------------------------------------

describe('truncateContent — content within budget', () => {
  it('returns the original string unchanged when under the limit', () => {
    const s = 'hello world';
    expect(truncateContent(s, 100)).toBe(s);
  });

  it('returns the original string unchanged when exactly at the limit', () => {
    const s = 'a'.repeat(50);
    expect(truncateContent(s, 50)).toBe(s);
  });

  it('handles empty string', () => {
    expect(truncateContent('', 0)).toBe('');
    expect(truncateContent('', 100)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// truncateContent — over budget (truncation path)
// ---------------------------------------------------------------------------

describe('truncateContent — content over budget', () => {
  it('includes the omission notice within the returned character budget', () => {
    const content = 'A'.repeat(200);
    const result = truncateContent(content, 100);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain('[Content truncated:');
  });

  it('inserts the omission count in the truncation marker', () => {
    const content = 'X'.repeat(1000);
    const maxChars = 100;
    const result = truncateContent(content, maxChars);
    const omitted = Number(/Content truncated: (\d+) chars omitted/.exec(result)?.[1]);
    const retained = result.replace(/\n+\[Content truncated:[\s\S]*?\]\n+/, '').length;
    expect(omitted).toBe(content.length - retained);
  });

  it('preserves the beginning of the content (head)', () => {
    const content = 'START' + 'M'.repeat(1000) + 'END';
    const result = truncateContent(content, 100);
    expect(result.startsWith('START')).toBe(true);
  });

  it('preserves the end of the content (tail)', () => {
    const content = 'START' + 'M'.repeat(1000) + 'END';
    const result = truncateContent(content, 100);
    expect(result.endsWith('END')).toBe(true);
  });

  it('splits budget evenly between head and tail', () => {
    const head = 'AAAA';
    const mid = 'M'.repeat(1000);
    const tail = 'BBBB';
    const content = head + mid + tail;
    const result = truncateContent(content, 100);
    expect(result).toContain('AAAA');
    expect(result).toContain('BBBB');
  });

  it('marker text includes newlines for readability', () => {
    const content = 'A'.repeat(200);
    const result = truncateContent(content, 100);
    expect(result).toMatch(/\n+\[Content truncated:/);
    expect(result).toMatch(/\]\n+/);
  });

  it('truncates a 1-char-over content', () => {
    const content = 'A'.repeat(101);
    const result = truncateContent(content, 100);
    expect(result).toContain('[Content truncated:');
    expect(result.length).toBeLessThanOrEqual(100);
    expect(Number(/Content truncated: (\d+) chars omitted/.exec(result)?.[1])).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// truncateToolResult
// ---------------------------------------------------------------------------

describe('truncateToolResult', () => {
  it('returns unchanged content when within default budget', () => {
    const s = 'small result';
    expect(truncateToolResult(s)).toBe(s);
  });

  it('truncates content that exceeds the default budget', () => {
    const large = 'X'.repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1);
    const result = truncateToolResult(large);
    expect(result).toContain('[Content truncated:');
  });

  it('uses the provided budget when given', () => {
    const content = 'A'.repeat(200);
    const result = truncateToolResult(content, 100);
    expect(result).toContain('[Content truncated:');
  });

  it('returns unchanged when content equals the custom budget', () => {
    const content = 'A'.repeat(100);
    expect(truncateToolResult(content, 100)).toBe(content);
  });

  it('delegates to truncateContent — same output for same inputs', () => {
    const content = 'Y'.repeat(5000);
    const budget = 100;
    expect(truncateToolResult(content, budget)).toBe(truncateContent(content, budget));
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('includes its notice in the budget and is unchanged by a second equal limit', () => {
    const content = 'BEGIN\n' + 'x'.repeat(5000) + '\nRECOVER: /tmp/output.txt';
    const once = truncateToolResult(content, 1000);
    expect(once.length).toBeLessThanOrEqual(1000);
    expect(once).toContain('omitted');
    expect(once).toContain('RECOVER: /tmp/output.txt');
    expect(truncateToolResult(once, 1000)).toBe(once);
  });

  it('handles maxChars=1', () => {
    const content = 'hello world';
    const result = truncateContent(content, 1);
    expect(result).toBe('…');
  });

  it('handles content with unicode characters', () => {
    const content = '🎉'.repeat(2000);
    for (const budget of [51, 100, 511, 1000]) {
      const result = truncateContent(content, budget);
      expect(result.length).toBeLessThanOrEqual(budget);
      expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
    }
  });

  it('handles content with newlines', () => {
    const content = 'line1\n'.repeat(200);
    const result = truncateContent(content, 100);
    expect(result).toContain('[Content truncated:');
  });

  it('handles zero, infinite, and invalid budgets explicitly', () => {
    expect(truncateContent('content', 0)).toBe('');
    expect(truncateContent('content', Infinity)).toBe('content');
    for (const budget of [-1, NaN, 2.5]) expect(() => truncateContent('content', budget)).toThrow(RangeError);
  });
});
