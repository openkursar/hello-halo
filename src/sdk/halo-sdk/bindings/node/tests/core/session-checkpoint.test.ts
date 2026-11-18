import { describe, expect, it } from 'vitest';
import { query } from '../../index.js';
import type { LlmProvider } from '../../types/provider.js';

describe('unstarted native query', () => {
  it('releases its goal without making a model request', async () => {
    let requests = 0;
    const provider = {
      id: 'unstarted', name: 'Unstarted query fixture',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
        pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage() { requests++; throw new Error('Unexpected model request'); },
      async *createMessageStream() { requests++; throw new Error('Unexpected model request'); },
    } satisfies LlmProvider;
    const operation = query({ prompt: 'Never started.', options: { provider, model: 'fixture', persistSession: false,
      tools: [], settingSources: [], collaboration: false } });
    operation.setGoal({ objective: 'Disposable goal.' });
    await operation.return(undefined);
    expect(requests).toBe(0);
    expect(operation.getGoal()).toBeNull();
  });
});
