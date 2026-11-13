/**
 * Reasoning recorded under one model and replayed to another that verifies
 * reasoning signatures is rejected with HTTP 400. The loop resends once
 * without the foreign reasoning and the session keeps that history.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { queryLoop } from '../index.js';
import type { SDKMessage } from './query-types.js';
import type { LlmProvider, Message, ProviderRequest, StreamEvent } from '../types/provider.js';
import type { Tool } from '../types/tool.js';
import type { QueryConfig } from '../types/config.js';
import { ProviderError } from '../utils/errors.js';
import { REASONING_OMITTED_PLACEHOLDER, stripReasoningBlocks } from './messages.js';

const signatureError = () => ProviderError.fromHttpResponse('anthropic', 400, JSON.stringify({
  type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block' },
}));

function config(): QueryConfig {
  return {
    model: 'claude-test', contextWindow: 200_000, maxTurns: 3, cwd: '/tmp', env: {},
    permissionMode: 'bypassPermissions', systemPrompt: 'Test.', thinking: { type: 'disabled' },
    abortSignal: new AbortController().signal,
  } as QueryConfig;
}

function provider(failures: number): { provider: LlmProvider; requests: Message[][] } {
  const requests: Message[][] = [];
  return {
    requests,
    provider: {
      id: 'scripted', name: 'Scripted',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: true, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage() { throw new Error('not used'); },
      async *createMessageStream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        requests.push(req.messages.map(message => ({ ...message })));
        if (requests.length <= failures) throw signatureError();
        yield { type: 'message_start', id: `msg_${randomUUID()}`, model: req.model, usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: 'answered' };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'message_stop' };
      },
    },
  };
}

const foreignHistory = (): Message[] => [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning from another model', signature: 'foreign' }, { type: 'text', text: 'first answer' }] },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'only reasoning', signature: 'foreign' }] },
  { role: 'user', content: 'second question' },
];

async function drain(gen: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
  const out: SDKMessage[] = [];
  for await (const message of gen) out.push(message);
  return out;
}

const hasReasoning = (messages: Message[]) => messages.some(message =>
  Array.isArray(message.content) && message.content.some(block => block.type === 'thinking'));

describe('queryLoop — rejected reasoning signatures', () => {
  it('resends once without earlier reasoning and keeps the stripped history', async () => {
    const { provider: scripted, requests } = provider(1);
    let kept: Message[] | undefined;
    const messages = await drain(queryLoop(config(), scripted, [], foreignHistory(), { onHistoryCompacted: history => { kept = [...history]; } }));

    expect(requests).toHaveLength(2);
    expect(hasReasoning(requests[0])).toBe(true);
    expect(hasReasoning(requests[1])).toBe(false);
    expect(JSON.stringify(requests[1])).toContain('first answer');
    expect(JSON.stringify(requests[1])).toContain(REASONING_OMITTED_PLACEHOLDER);
    expect(kept && hasReasoning(kept)).toBe(false);
    expect(messages.find(message => message.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('does not resend a second time when the stripped request is rejected too', async () => {
    const { provider: scripted, requests } = provider(5);
    const messages = await drain(queryLoop(config(), scripted, [], foreignHistory()));
    expect(requests).toHaveLength(2);
    expect(messages.find(message => message.type === 'result')).toMatchObject({ subtype: 'error_during_execution' });
  });
});

describe('queryLoop — rejected signature after the run\'s own tool call', () => {
  it('keeps the reasoning and tool exchange this run produced, drops only the foreign reasoning, and finishes', async () => {
    const requests: Message[][] = [];
    const execute = async () => ({ content: 'listed 3 files', isError: false });
    const listTool = { name: 'list', description: 'Lists files', inputSchema: { type: 'object', properties: {} }, permissionLevel: 'readonly', execute } as unknown as Tool;
    const scripted: LlmProvider = {
      id: 'scripted', name: 'Scripted',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: true, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage() { throw new Error('not used'); },
      async *createMessageStream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        requests.push(req.messages.map(message => ({ ...message })));
        if (requests.length === 1) {
          yield { type: 'message_start', id: `msg_${randomUUID()}`, model: req.model, usage: { input_tokens: 1, output_tokens: 1 } };
          yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } };
          yield { type: 'thinking_delta', index: 0, thinking: 'own reasoning' };
          yield { type: 'signature_delta', index: 0, signature: 'own-signature' };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_own', name: 'list', input: {} } };
          yield { type: 'input_json_delta', index: 1, partialJson: '{}' };
          yield { type: 'content_block_stop', index: 1 };
          yield { type: 'message_delta', stopReason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
          yield { type: 'message_stop' };
          return;
        }
        if (requests.length === 2) throw signatureError();
        yield { type: 'message_start', id: `msg_${randomUUID()}`, model: req.model, usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: 'answered' };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'message_stop' };
      },
    };
    let kept: Message[] | undefined;
    const out = await drain(queryLoop({ ...config(), maxTurns: 5 }, scripted, [listTool], foreignHistory(), { onHistoryCompacted: history => { kept = [...history]; } }));

    expect(requests).toHaveLength(3);
    const resent = JSON.stringify(requests[2]);
    expect(resent).not.toContain('reasoning from another model');
    expect(resent).toContain('own reasoning');
    expect(resent).toContain('toolu_own');
    expect(resent).toContain('listed 3 files');
    expect(JSON.stringify(kept)).toContain('own reasoning');
    expect(JSON.stringify(kept)).not.toContain('reasoning from another model');
    expect(out.find(message => message.type === 'result')).toMatchObject({ subtype: 'success' });
  });
});

describe('stripReasoningBlocks', () => {
  it('leaves the replies it is told to keep untouched', () => {
    const history = foreignHistory();
    const own = history[1];
    expect(stripReasoningBlocks(history, message => message === own)).toBe(1);
    expect(history[1]).toBe(own);
    expect(history[2].content).toEqual([{ type: 'text', text: REASONING_OMITTED_PLACEHOLDER }]);
  });
});
