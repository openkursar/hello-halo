import { describe, expect, it, vi } from 'vitest';
import { autoCompactIfNeeded, AutoCompactState } from './compact.js';
import type { LlmProvider, Message, ProviderRequest } from '../types/provider.js';

describe('compaction lifecycle', () => {
  it('never replaces history with a token-truncated summary', async () => {
    const provider = { createMessage: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'incomplete summary' }], stopReason: 'max_tokens',
    }) } as unknown as LlmProvider;
    const messages: Message[] = Array.from({ length: 20 }, () => ({ role: 'user', content: 'history' }));
    const state = new AutoCompactState();
    expect(await autoCompactIfNeeded(messages, 4000, 4096, 'test', provider, 'Test', state)).toBeNull();
    expect(state.compactionCount).toBe(0);
    expect(state.consecutiveFailures).toBe(1);
    expect(messages).toHaveLength(20);
  });

  it('cancels the summary request without counting cancellation as a compaction failure', async () => {
    const controller = new AbortController();
    const createMessage = vi.fn((request: ProviderRequest) => new Promise((_resolve, reject) => {
      const signal = request.providerOptions?.signal as AbortSignal;
      expect(signal).toBe(controller.signal);
      expect(request.maxTokens).toBe(512);
      expect(request.thinking).toEqual({ type: 'disabled' });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const provider = { createMessage } as unknown as LlmProvider;
    const messages: Message[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', content: 'test history',
    }));
    const state = new AutoCompactState();
    const pending = autoCompactIfNeeded(messages, 4000, 4096, 'test', provider, 'Test', state, [], undefined,
      { signal: controller.signal, maxTokens: 512, thinking: { type: 'disabled' } });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(createMessage).toHaveBeenCalledOnce();
    expect(state.consecutiveFailures).toBe(0);
  });

  it('does not report a compaction when there is too little history to summarize', async () => {
    const createMessage = vi.fn();
    const provider = { createMessage } as unknown as LlmProvider;
    const state = new AutoCompactState();
    expect(await autoCompactIfNeeded([{ role: 'user', content: 'short' }], 4000, 4096, 'test', provider, 'Test', state))
      .toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
    expect(state.compactionCount).toBe(0);
  });
});
