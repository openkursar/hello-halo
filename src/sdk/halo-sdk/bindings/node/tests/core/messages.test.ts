import { describe, expect, it } from 'vitest';
import { createSession, estimateMessageTokens } from '../../index.js';
import type { Message, LlmProvider, ProviderRequest, StreamEvent } from '../../types/provider.js';

function provider(requests: ProviderRequest[], calls = false): LlmProvider {
  return {
    id: 'message-fixture', name: 'Message fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const index = requests.push(request) - 1;
      const content = calls && index === 0
        ? [{ type: 'text' as const, text: 'I will run a command' },
          { type: 'tool_use' as const, id: 'tu1', name: 'Probe', input: {} },
          { type: 'tool_use' as const, id: 'tu2', name: 'Failure', input: {} }]
        : [{ type: 'text' as const, text: 'done' }];
      yield { type: 'message_start', id: `response-${index}`, model: request.model,
        usage: { input_tokens: 0, output_tokens: 0 } };
      for (const [blockIndex, block] of content.entries()) {
        yield { type: 'content_block_start', index: blockIndex, content_block: block };
        if (block.type === 'tool_use') yield { type: 'input_json_delta', index: blockIndex, partialJson: '{}' };
        yield { type: 'content_block_stop', index: blockIndex };
      }
      yield { type: 'message_delta', stopReason: calls && index === 0 ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
}

async function run(input: string | Message['content'], calls = false) {
  const requests: ProviderRequest[] = [];
  const session = await createSession({ model: 'fixture', provider: provider(requests, calls),
    cwd: process.cwd(), persistSession: false, settingSources: [], skillCatalog: [], tools: [],
    systemPrompt: 'Fixture.', permissionMode: 'bypassPermissions',
    turnEndChecks: { openWork: false, completion: false },
    customTools: calls ? [
      { name: 'Probe', description: 'Return a result.', inputSchema: { type: 'object' }, permissionLevel: 'none',
        async execute() { return { content: 'result text' }; } },
      { name: 'Failure', description: 'Return an error.', inputSchema: { type: 'object' }, permissionLevel: 'none',
        async execute() { return { content: 'error text', isError: true }; } },
    ] : [],
  });
  try {
    await session.send(typeof input === 'string' ? input : { role: 'user', content: input });
    for await (const event of session.stream()) if (event.type === 'result') break;
    return requests;
  } finally { await session.close(); }
}

describe('message construction at the public session boundary', () => {
  it('wraps string content in a user message', async () => {
    const requests = await run('Hello');
    expect(requests[0].messages.at(-1)).toMatchObject({ role: 'user', content: 'Hello' });
  });

  it('preserves user content blocks', async () => {
    const blocks = [{ type: 'text' as const, text: 'hi' }];
    const requests = await run(blocks);
    expect(requests[0].messages.at(-1)).toMatchObject({ role: 'user', content: blocks });
  });

  it('extracts mixed and multiple tool calls and returns ordered result blocks', async () => {
    const requests = await run('Run the tools.', true);
    const assistant = requests[1].messages.find(message => message.role === 'assistant')!;
    const calls = (assistant.content as Array<{ type: string; id?: string; name?: string }>).filter(block => block.type === 'tool_use');
    expect(calls).toHaveLength(2);
    expect(calls.map(call => [call.id, call.name])).toEqual([['tu1', 'Probe'], ['tu2', 'Failure']]);
    const result = requests[1].messages.at(-1)!;
    expect(result.role).toBe('user');
    const blocks = result.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu1', content: 'result text' });
    expect(blocks[0].is_error).toBeUndefined();
    expect(blocks[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu2', content: 'error text', is_error: true });
  });

  it('does not invent tool calls for ordinary text', async () => {
    const requests = await run('Hello');
    expect(requests).toHaveLength(1);
  });
});

describe('public message token estimation', () => {
  it('estimates string and block content positively', () => {
    expect(estimateMessageTokens([{ role: 'user', content: 'Hello world, this is a test.' }])).toBeGreaterThan(0);
    expect(estimateMessageTokens([{ role: 'assistant', content: [{ type: 'text', text: 'A longer response with more tokens here.' }] }])).toBeGreaterThan(0);
  });
  it('assigns larger estimates to longer content', () => {
    expect(estimateMessageTokens([{ role: 'user', content: 'A'.repeat(10_000) }])).toBeGreaterThan(estimateMessageTokens([{ role: 'user', content: 'Hi' }]));
  });
  it('returns zero for no messages and sums individual estimates', () => {
    expect(estimateMessageTokens([]) === 0).toBe(true);
    const messages: Message[] = [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'World' }];
    expect(estimateMessageTokens(messages)).toBe(messages.reduce((sum, message) => sum + estimateMessageTokens([message]), 0));
  });
});
