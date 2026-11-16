import { describe, expect, it } from 'vitest';
import { estimateMessageTokens, estimateTokens } from '../../index.js';
import type { Message } from '../../types/provider.js';

describe('Node token helpers', () => {
  it('preserves UTF-16 input and delegates message estimates to Rust', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(100))).toBe(30);
    expect(estimateTokens('中'.repeat(100))).toBe(60);
    expect(estimateTokens('\ud800')).toBe(1);
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    expect(estimateMessageTokens(messages)).toBe(6);
    expect(messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });
});
