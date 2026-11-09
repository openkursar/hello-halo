import { describe, expect, it } from 'vitest';
import { createSession } from './session.js';
import type { Options } from '../types/config.js';
import type { LlmProvider, ProviderRequest } from '../types/provider.js';

async function checkMode(options: Partial<Options>, change?: (session: Awaited<ReturnType<typeof createSession>>) => Promise<void>) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'test', name: 'test',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: true, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request) {
      requests.push(request);
      yield { type: 'message_start', id: 'test', model: 'test', usage: { input_tokens: 1, output_tokens: 1 } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'text_delta', index: 0, text: 'OK' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  const session = await createSession({ model: 'test', provider, tools: [], persistSession: false,
    systemPrompt: 'Test', conventions: { memoryFiles: [], memorySubdirs: [], agentDirs: [] },
    turnEndChecks: { openWork: false, completion: false }, ...options });
  try {
    await change?.(session);
    await session.send('Reply OK.');
    for await (const message of session.stream()) if (message.type === 'result') break;
    return requests[0];
  } finally { session.close(); await session.flush(); }
}

describe('thinking configuration ownership', () => {
  it('honors an explicit disabled mode even at maximum effort', async () => {
    const request = await checkMode({ thinking: { type: 'disabled' }, effort: 'max' });
    expect(request.thinking).toEqual({ type: 'disabled' });
    expect(request.providerOptions?.reasoning_effort).toBeUndefined();
  });
  it('retains effort-derived thinking when the caller did not choose a mode', async () => {
    expect((await checkMode({ effort: 'high' })).thinking).toMatchObject({ type: 'enabled' });
  });
  it('honors disabling through the session control method', async () => {
    expect((await checkMode({ effort: 'max' }, session => session.setMaxThinkingTokens(null))).thinking).toEqual({ type: 'disabled' });
  });
  it('retains the requested effort within an explicit adaptive mode', async () => {
    const request = await checkMode({ thinking: { type: 'adaptive' }, effort: 'low' });
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.providerOptions?.reasoning_effort).toBe('low');
  });
});
