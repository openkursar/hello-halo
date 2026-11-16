import { describe, expect, it } from 'vitest';
import { queryLoop } from '../../index.js';
import type { QueryConfig } from '../../types/config.js';
import type { LlmProvider, StreamEvent } from '../../types/provider.js';
import type { Tool } from '../../types/tool.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('native tool child messages', () => {
  it('forwards awaited child messages in order with consumer backpressure before the tool result', async () => {
    const started = deferred();
    const completed: number[] = [];
    const total = 1024;
    const tool: Tool = {
      name: 'Work', description: 'Emit child progress', permissionLevel: 'none', inputSchema: { type: 'object' },
      async execute(_input, context) {
        expect(context.onToolMessage).toBeTypeOf('function');
        started.resolve();
        for (let index = 0; index < total; index++) {
          await context.onToolMessage!({ type: 'tool_progress', tool_name: 'child', tool_use_id: `child-${index}`,
            parent_tool_use_id: context.toolUseId, session_id: 'child', uuid: `child-message-${index}` });
          completed.push(index);
        }
        return { content: 'Child done.', isError: false };
      },
    };
    let requests = 0;
    const provider: LlmProvider = {
      id: 'child-test', name: 'Child test',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
        pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage() { throw new Error('Streaming only'); },
      async *createMessageStream(request): AsyncGenerator<StreamEvent> {
        requests++;
        yield { type: 'message_start', id: `response-${requests}`, model: request.model };
        if (requests === 1) {
          yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'work-1', name: 'Work', input: {} } };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_delta', stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
        } else {
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
          yield { type: 'text_delta', index: 0, text: 'Finished.' };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_delta', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
        }
        yield { type: 'message_stop' };
      },
    };
    const config = { model: 'child-test', contextWindow: 200_000, maxTurns: 3, cwd: '/tmp', env: {},
      permissionMode: 'bypassPermissions', systemPrompt: 'Finish the task.', thinking: { type: 'disabled' },
      abortSignal: new AbortController().signal } as QueryConfig;
    const stream = queryLoop(config, provider, [tool], 'Run Work.');
    const children: string[] = [];
    let results = 0;
    try {
      while (true) {
        const next = await stream.next();
        expect(next.done).toBe(false);
        if (next.value?.type === 'tool_progress' && next.value.tool_name === 'child') {
          children.push(next.value.tool_use_id);
          break;
        }
      }
      await started.promise;
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(completed.length).toBeLessThan(total);
      for await (const message of stream) {
        if (message.type === 'tool_progress' && message.tool_name === 'child') children.push(message.tool_use_id);
        if (message.type === 'user' && Array.isArray(message.message.content) && message.message.content.some(block => block.type === 'tool_result')) {
          results++;
          expect(children).toHaveLength(total);
          expect(message.message.content).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'work-1', content: 'Child done.' }));
        }
      }
      expect(children).toEqual(Array.from({ length: total }, (_, index) => `child-${index}`));
      expect(completed).toEqual(Array.from({ length: total }, (_, index) => index));
      expect(requests).toBe(2);
      expect(results).toBe(1);
    } finally {
      await stream.return(undefined);
    }
  }, 20_000);
});
