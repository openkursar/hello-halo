import { describe, expect, it, vi } from 'vitest';
import type { LlmProvider, Message } from '../types/provider.js';
import { estimateMessageTokens } from '../utils/tokens.js';
import { fullCompact } from './compact.js';

const history = (): Message[] => Array.from({ length: 30 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user', content: `Work ${index}: ${'past evidence '.repeat(350)}`,
}));
const provider = () => ({ createMessage: vi.fn(async () => ({ id: 'summary', model: 'fixture',
  content: [{ type: 'text', text: 'Prepared summary.' }], stopReason: 'end_turn', usage: { input_tokens: 100, output_tokens: 3 },
})) } as unknown as LlmProvider);

describe('compaction candidate preparation', () => {
  it('prepares fixed state before measuring capacity and counts the prepared final candidate', async () => {
    const source = history();
    const attachment: Message = { role: 'user', isMeta: true, content: 'Required state. '.repeat(80) };
    const prepareCandidate = vi.fn((messages: Message[]) => {
      let seen = false;
      return messages.filter(message => {
        if (message.content !== attachment.content) return true;
        if (seen) return false;
        seen = true;
        return true;
      });
    });
    const measured: Message[][] = [];
    const result = await fullCompact(source, provider(), 'fixture', '', Array(20).fill(attachment), undefined, undefined, {
      maxTokens: 512, targetInputTokens: 4000, maxInputTokens: 5000, prepareCandidate,
      estimateInputTokens: messages => { measured.push(messages); return estimateMessageTokens(messages); },
    });
    expect(prepareCandidate).toHaveBeenCalledTimes(2);
    expect(measured[0].filter(message => message.content === attachment.content)).toHaveLength(1);
    expect(result.messages.filter(message => message.content === attachment.content)).toHaveLength(1);
    expect(result.tokensFreed).toBe(estimateMessageTokens(source) - estimateMessageTokens(result.messages));
  });

  it('rejects prepared state that exceeds capacity even when it is smaller than the original history', async () => {
    const source = history();
    const before = structuredClone(source);
    const llm = provider();
    await expect(fullCompact(source, llm, 'fixture', '', [], undefined, undefined, {
      maxTokens: 512, targetInputTokens: 4000, maxInputTokens: 5000, estimateInputTokens: estimateMessageTokens,
      prepareCandidate: messages => messages.some(message => String(message.content).includes('Prepared summary.'))
        ? [...messages, { role: 'user', content: 'Required restoration data. '.repeat(1800) }] : messages,
    })).rejects.toMatchObject({ reason: 'capacity' });
    expect(llm.createMessage).toHaveBeenCalledOnce();
    expect(source).toEqual(before);
  });
});
