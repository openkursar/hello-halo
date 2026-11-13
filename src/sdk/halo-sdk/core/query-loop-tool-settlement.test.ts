import { describe, expect, it, vi } from 'vitest';
import { queryLoop, resolveQueryConfig } from '../index.js';
import type { SDKMessage } from './query-types.js';
import type { LlmProvider, ProviderRequest, StreamEvent, ToolResultBlock } from '../types/provider.js';
import type { Tool } from '../types/tool.js';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

function providerFor(names: string[]) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'fixture', name: 'Fixture',
    capabilities: () => ({
      streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level',
    }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const initial = requests.length === 0;
      requests.push(request);
      const usage = { input_tokens: 20, output_tokens: 10 };
      yield { type: 'message_start', id: `response-${requests.length}`, model: request.model, usage };
      if (initial) {
        for (const [index, name] of names.entries()) {
          yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${index}`, name, input: {} } };
          yield { type: 'content_block_stop', index };
        }
      } else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Complete.' } };
        yield { type: 'content_block_stop', index: 0 };
      }
      yield { type: 'message_delta', stopReason: initial ? 'tool_use' : 'end_turn', usage };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests };
}

function config(controller = new AbortController()) {
  return resolveQueryConfig({
    model: 'fixture', cwd: '/tmp', systemPrompt: 'Fixture.', settingSources: [],
    maxTurns: 3, permissionMode: 'bypassPermissions', abortController: controller,
    thinking: { type: 'disabled' }, toolResultBudget: 1000,
    turnEndChecks: { openWork: false, completion: false },
  });
}

function tool(name: string, execute: Tool['execute']): Tool {
  return { name, description: name, inputSchema: { type: 'object' }, permissionLevel: 'none',
    isConcurrencySafe: () => true, execute };
}

async function collect(generator: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const message of generator) messages.push(message);
  return messages;
}

function results(messages: SDKMessage[]): ToolResultBlock[] {
  return messages.flatMap(message => message.type === 'user' ? message.message.content : [])
    .filter((block): block is ToolResultBlock => block.type === 'tool_result');
}

describe('tool settlement', () => {
  it('keeps a completed result when another call is interrupted and ignores its late success', async () => {
    const controller = new AbortController();
    const completed = deferred();
    const waiting = deferred();
    const release = deferred();
    const { provider } = providerFor(['saved', 'waiting']);
    const pending = collect(queryLoop(config(controller), provider, [
      tool('saved', async () => ({ content: 'Write completed.', isError: false })),
      tool('waiting', async () => { waiting.resolve(); await release.promise; return { content: 'Late result.', isError: false }; }),
    ], 'Run the work.', {
      onProgress(message) {
        if (message.type === 'tool_progress' && message.tool_name === 'saved' && message.elapsed_time_seconds !== undefined) completed.resolve();
      },
    }));
    await Promise.all([completed.promise, waiting.promise]);
    controller.abort();
    const messages = await pending;
    release.resolve();
    await Promise.resolve();
    expect(results(messages)).toEqual([
      expect.objectContaining({ tool_use_id: 'call-0', content: 'Write completed.' }),
      expect.objectContaining({ tool_use_id: 'call-1', is_error: true, content: 'Interrupted by user' }),
    ]);
    expect(results(messages)[0].is_error).not.toBe(true);
    expect(messages.filter(message => message.type === 'result')).toHaveLength(1);
    for (const id of ['call-0', 'call-1']) {
      expect(messages.filter(message => message.type === 'tool_progress' &&
        message.tool_use_id === id && message.elapsed_time_seconds !== undefined)).toHaveLength(1);
    }
  }, 1000);

  it('does not enter the permission callback after cancellation in a pre-tool hook', async () => {
    const controller = new AbortController();
    const ready = deferred();
    const cfg = config(controller);
    cfg.permissionMode = 'default';
    cfg.canUseTool = vi.fn(async () => ({ behavior: 'allow', updatedInput: {} }));
    cfg.hooks = { PreToolUse: [{ hooks: [async () => { ready.resolve(); return new Promise(() => {}); }] }] };
    const execute = vi.fn(async () => ({ content: 'Unexpected.', isError: false }));
    const pending = collect(queryLoop(cfg, providerFor(['work']).provider, [tool('work', execute)], 'Run the work.'));
    await ready.promise;
    controller.abort();
    const messages = await pending;
    expect(cfg.canUseTool).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(results(messages)).toHaveLength(1);
    expect(messages.filter(message => message.type === 'result')).toHaveLength(1);
  }, 1000);

  it('applies the final text budget after hook replacement and context additions', async () => {
    const cfg = config();
    cfg.hooks = { PostToolUse: [{ hooks: [async input => {
      expect(String((input as { tool_response: unknown }).tool_response).length).toBeLessThanOrEqual(1000);
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: 'START\n' + 'x'.repeat(5000) + '\nRECOVER: /tmp/output.txt' } };
    }] }] };
    const messages = await collect(queryLoop(cfg, providerFor(['work']).provider, [
      tool('work', async () => ({ content: 'Original.'.repeat(1000), isError: false })),
    ], 'Run the work.'));
    const content = results(messages)[0].content as string;
    expect(content.length).toBeLessThanOrEqual(1000);
    expect(content).toContain('omitted');
    expect(content).toContain('START');
    expect(content).toContain('RECOVER: /tmp/output.txt');
  });

  it('retains the successful operation when its output hook is interrupted', async () => {
    const controller = new AbortController();
    const ready = deferred();
    const cfg = config(controller);
    cfg.hooks = { PostToolUse: [{ hooks: [async () => { ready.resolve(); return new Promise(() => {}); }] }] };
    const execute = vi.fn(async () => ({ content: 'Change saved.', isError: false }));
    const pending = collect(queryLoop(cfg, providerFor(['work']).provider, [tool('work', execute)], 'Run the work.'));
    await ready.promise;
    controller.abort();
    const messages = await pending;
    expect(execute).toHaveBeenCalledOnce();
    expect(results(messages)).toEqual([expect.objectContaining({ tool_use_id: 'call-0', content: 'Change saved.' })]);
    expect(results(messages)[0].is_error).not.toBe(true);
    expect(messages.filter(message => message.type === 'result')).toHaveLength(1);
  }, 1000);
});
