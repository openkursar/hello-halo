import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_RESULT_SIZE_CHARS, truncateToolResult } from '../../index.js';

describe('Node truncation boundary', () => {
  it('retains the public default and delegates the budget to Rust', () => {
    expect(DEFAULT_MAX_RESULT_SIZE_CHARS).toBe(50_000);
    expect(truncateToolResult('small result')).toBe('small result');
    expect(truncateToolResult('A'.repeat(100), 100)).toBe('A'.repeat(100));
    expect(truncateToolResult('A'.repeat(200), 100)).toContain('[Content truncated:');
    expect(truncateToolResult('X'.repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1))).toContain('[Content truncated:');
  });

  it('preserves UTF-16 strings and rejects invalid JavaScript budgets', () => {
    expect(truncateToolResult('content', 0)).toBe('');
    expect(truncateToolResult('content', Infinity)).toBe('content');
    for (const budget of [-1, NaN, 2.5]) expect(() => truncateToolResult('content', budget)).toThrow(RangeError);
    expect(truncateToolResult('\ud800')).toBe('\ud800');
    for (const budget of [51, 100, 511, 1000]) {
      const result = truncateToolResult('🎉'.repeat(2000), budget);
      expect(result.length).toBeLessThanOrEqual(budget);
      expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
    }
  });
});
