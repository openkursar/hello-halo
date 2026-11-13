import { describe, expect, it, vi } from 'vitest';
import { queryLoop, resolveQueryConfig } from '../index.js';
import type { QueryLoopOptions, SDKAssistantMessage, SDKMessage } from './query-types.js';
import type { LlmProvider, ProviderRequest, StreamEvent, ToolResultBlock } from '../types/provider.js';
import type { Tool } from '../types/tool.js';
import { ProviderError } from '../utils/errors.js';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const usage = { input_tokens: 20, output_tokens: 10 };

function config(controller = new AbortController()) {
  return resolveQueryConfig({
    model: 'fixture', cwd: '/tmp', systemPrompt: 'Fixture.', settingSources: [],
    maxTurns: 3, permissionMode: 'bypassPermissions', abortController: controller,
    thinking: { type: 'disabled' }, toolResultBudget: 1000,
    turnEndChecks: { openWork: false, completion: false },
  });
}

function tool(name: string, execute: Tool['execute'], safe = true): Tool {
  return { name, description: name, inputSchema: { type: 'object' }, permissionLevel: 'none',
    isConcurrencySafe: () => safe, execute };
}

function* toolCall(name: string, index = 0): Generator<StreamEvent> {
  yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${index}`, name, input: {} } };
  yield { type: 'content_block_stop', index };
}

function scriptedProvider(script: (request: ProviderRequest) => AsyncGenerator<StreamEvent>) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'fixture', name: 'Fixture',
    capabilities: () => ({
      streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level',
    }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request) {
      requests.push(request);
      const first = requests.length === 1;
      yield { type: 'message_start', id: `response-${requests.length}`, model: request.model, usage };
      if (first) yield* script(request);
      else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Complete.' } };
        yield { type: 'content_block_stop', index: 0 };
      }
      yield { type: 'message_delta', stopReason: first ? 'tool_use' : 'end_turn', usage };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests };
}

async function collect(generator: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const message of generator) messages.push(message);
  return messages;
}

function results(messages: SDKMessage[]): ToolResultBlock[] {
  return messages.flatMap(message => message.type === 'user' && !message.parent_tool_use_id ? message.message.content : [])
    .filter((block): block is ToolResultBlock => block.type === 'tool_result');
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve()
    : new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

describe('streaming tool execution', () => {
  it('finishes a complete tool call before the provider finishes generating', async () => {
    const finished = deferred();
    const { provider, requests } = scriptedProvider(async function* () {
      yield* toolCall('Read');
      await finished.promise;
      yield { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Tail.' } };
      yield { type: 'content_block_stop', index: 1 };
    });
    const messages = await collect(queryLoop(config(), provider, [tool('Read', async () => {
      finished.resolve();
      return { content: 'Read complete.', isError: false };
    })], 'Read the file.'));
    expect(results(messages)).toEqual([expect.objectContaining({ tool_use_id: 'call-0', content: 'Read complete.' })]);
    expect(requests).toHaveLength(2);
    expect(messages.at(-1)).toMatchObject({ type: 'result', is_error: false });
  }, 2000);

  it('waits for the complete JSON block and executes exactly once', async () => {
    const execute = vi.fn(async () => ({ content: 'Done.', isError: false }));
    const { provider } = scriptedProvider(async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-0', name: 'Read', input: {} } };
      yield { type: 'input_json_delta', index: 0, partialJson: '{"path":' };
      await flush();
      expect(execute).not.toHaveBeenCalled();
      yield { type: 'input_json_delta', index: 0, partialJson: '"file.txt"}' };
      await flush();
      expect(execute).not.toHaveBeenCalled();
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'content_block_stop', index: 0 };
    });
    await collect(queryLoop(config(), provider, [tool('Read', execute)], 'Read the file.'));
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toEqual({ path: 'file.txt' });
  });

  it('rejects malformed completed arguments without executing the tool', async () => {
    const execute = vi.fn(async () => ({ content: 'Unexpected.', isError: false }));
    const { provider } = scriptedProvider(async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-0', name: 'Write', input: {} } };
      yield { type: 'input_json_delta', index: 0, partialJson: '{"path":' };
      yield { type: 'content_block_stop', index: 0 };
    });
    const messages = await collect(queryLoop(config(), provider, [tool('Write', execute, false)], 'Save the file.'));
    expect(execute).not.toHaveBeenCalled();
    expect(results(messages)).toEqual([expect.objectContaining({ tool_use_id: 'call-0', is_error: true })]);
  });

  it('overlaps safe calls while enforcing exclusive barriers across arriving blocks', async () => {
    const started: string[] = [];
    const firstReady = deferred();
    const secondReady = deferred();
    const releaseReads = deferred();
    const writeReady = deferred();
    const releaseWrite = deferred();
    const { provider } = scriptedProvider(async function* () {
      yield* toolCall('FirstRead', 0);
      await firstReady.promise;
      yield* toolCall('SecondRead', 1);
      await secondReady.promise;
      yield* toolCall('Write', 2);
      yield* toolCall('LastRead', 3);
      await flush();
      expect(started).toEqual(['first', 'second']);
      releaseReads.resolve();
      await writeReady.promise;
      await flush();
      expect(started).toEqual(['first', 'second', 'write']);
      releaseWrite.resolve();
    });
    const messages = await collect(queryLoop(config(), provider, [
      tool('FirstRead', async () => { started.push('first'); firstReady.resolve(); await releaseReads.promise; return { content: 'first', isError: false }; }),
      tool('SecondRead', async () => { started.push('second'); secondReady.resolve(); await releaseReads.promise; return { content: 'second', isError: false }; }),
      tool('Write', async () => { started.push('write'); writeReady.resolve(); await releaseWrite.promise; return { content: 'write', isError: false }; }, false),
      tool('LastRead', async () => { started.push('last'); return { content: 'last', isError: false }; }),
    ], 'Run the work.'));
    expect(started).toEqual(['first', 'second', 'write', 'last']);
    expect(results(messages).map(result => result.content)).toEqual(['first', 'second', 'write', 'last']);
  }, 2000);

  it('keeps allowed independent tools parallel when the host permission callback is installed', async () => {
    const firstReady = deferred();
    const secondReady = deferred();
    const release = deferred();
    const { provider } = scriptedProvider(async function* () {
      yield* toolCall('Read', 0);
      await firstReady.promise;
      yield* toolCall('Read', 1);
      await secondReady.promise;
      release.resolve();
    });
    const cfg = config();
    cfg.permissionMode = 'default';
    cfg.canUseTool = vi.fn(async () => ({ behavior: 'allow', updatedInput: {} }));
    const messages = await collect(queryLoop(cfg, provider, [tool('Read', async (_input, ctx) => {
      if (ctx.toolUseId === 'call-0') firstReady.resolve();
      else secondReady.resolve();
      await release.promise;
      return { content: ctx.toolUseId!, isError: false };
    })], 'Read both files.'));
    expect(cfg.canUseTool).toHaveBeenCalledTimes(2);
    expect(results(messages).map(result => result.content)).toEqual(['call-0', 'call-1']);
  }, 2000);

  it('delivers child messages with backpressure while the provider awaits tool completion', async () => {
    const finished = deferred();
    const { provider } = scriptedProvider(async function* () {
      yield* toolCall('EmitChild');
      await finished.promise;
    });
    const messages = await collect(queryLoop(config(), provider, [tool('EmitChild', async (_input, ctx) => {
      for (let index = 0; index < 3; index++) {
        await ctx.onToolMessage?.({
          type: 'assistant', parent_tool_use_id: 'call-0', uuid: `child-${index}`, session_id: 'child',
          message: { id: `child-${index}`, type: 'message', role: 'assistant', model: 'fixture',
            content: [{ type: 'text', text: `Child ${index}` }], stop_reason: null, stop_sequence: null },
        });
      }
      finished.resolve();
      return { content: 'Child finished.', isError: false };
    })], 'Run the child.'));
    expect(messages.filter(message => message.type === 'assistant' && message.parent_tool_use_id === 'call-0')
      .map(message => message.uuid)).toEqual(['child-0', 'child-1', 'child-2']);
    expect(results(messages)[0].content).toBe('Child finished.');
  }, 2000);

  it('does not replay a provider retry after an operation has completed', async () => {
    const completed = deferred();
    let replayed = false;
    const { provider, requests } = scriptedProvider(async function* () {
      yield* toolCall('Write');
      await completed.promise;
      yield { type: 'retry', attempt: 1, maxRetries: 3, delayMs: 0, status: 529, message: 'Stream disconnected' };
      replayed = true;
      yield* toolCall('Write');
    });
    const execute = vi.fn(async () => ({ content: 'Saved once.', isError: false }));
    const messages = await collect(queryLoop(config(), provider, [tool('Write', execute, false)], 'Save the file.', {
      onProgress(message) {
        if (message.type === 'tool_progress' && message.elapsed_time_seconds !== undefined) completed.resolve();
      },
    }));
    expect(execute).toHaveBeenCalledOnce();
    expect(results(messages)[0].is_error).not.toBe(true);
    expect(replayed).toBe(false);
    expect(requests).toHaveLength(1);
    expect(results(messages)).toEqual([expect.objectContaining({ content: 'Saved once.' })]);
    expect(messages.at(-1)).toMatchObject({ type: 'result', is_error: true });
  }, 2000);

  it('preserves effects after a retryable stream error without retrying or falling back', async () => {
    const completed = deferred();
    const { provider, requests } = scriptedProvider(async function* () {
      yield* toolCall('Write');
      await completed.promise;
      throw new ProviderError('Connection lost after write', { statusCode: 503, retryable: true });
    });
    const execute = vi.fn(async () => ({ content: 'Saved once.', isError: false }));
    const cfg = config();
    cfg.fallbackModel = 'backup';
    const messages = await collect(queryLoop(cfg, provider, [tool('Write', execute, false)], 'Save the file.', {
      onProgress(message) {
        if (message.type === 'tool_progress' && message.elapsed_time_seconds !== undefined) completed.resolve();
      },
    }));
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(results(messages)).toEqual([expect.objectContaining({ content: 'Saved once.' })]);
    expect(results(messages)[0].is_error).not.toBe(true);
    expect(messages.at(-1)).toMatchObject({ type: 'result', is_error: true });
  }, 2000);

  it('does not execute an incomplete later call when the stream fails after a completed call', async () => {
    const completed = deferred();
    const { provider } = scriptedProvider(async function* () {
      yield* toolCall('Write');
      await completed.promise;
      yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'Write', input: {} } };
      yield { type: 'input_json_delta', index: 1, partialJson: '{"path":' };
      throw new Error('Connection lost');
    });
    const execute = vi.fn(async () => ({ content: 'First write.', isError: false }));
    const messages = await collect(queryLoop(config(), provider, [tool('Write', execute, false)], 'Save the files.', {
      onProgress(message) {
        if (message.type === 'tool_progress' && message.elapsed_time_seconds !== undefined) completed.resolve();
      },
    }));
    expect(execute).toHaveBeenCalledOnce();
    expect(results(messages)).toEqual([expect.objectContaining({ tool_use_id: 'call-0', content: 'First write.' })]);
  }, 2000);

  it('does not execute a repeated tool call ID twice', async () => {
    const completed = deferred();
    const { provider, requests } = scriptedProvider(async function* () {
      yield* toolCall('Write');
      await completed.promise;
      yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-0', name: 'Write', input: {} } };
      yield { type: 'content_block_stop', index: 1 };
    });
    const execute = vi.fn(async () => ({ content: 'Saved once.', isError: false }));
    const messages = await collect(queryLoop(config(), provider, [tool('Write', execute, false)], 'Save the file.', {
      onProgress(message) {
        if (message.type === 'tool_progress' && message.elapsed_time_seconds !== undefined) completed.resolve();
      },
    }));
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(results(messages)).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ type: 'result', is_error: true });
  }, 2000);

  it('retains completed results when cancelled during the remaining model stream', async () => {
    const controller = new AbortController();
    const tail = deferred();
    const completed = deferred();
    const { provider } = scriptedProvider(async function* (request) {
      yield* toolCall('Write');
      tail.resolve();
      await waitForAbort(request.providerOptions!.signal as AbortSignal);
    });
    const pending = collect(queryLoop(config(controller), provider, [tool('Write', async () => ({ content: 'Saved.', isError: false }), false)], 'Save the file.', {
      onProgress(message) {
        if (message.type === 'tool_progress' && message.elapsed_time_seconds !== undefined) completed.resolve();
      },
    }));
    await Promise.all([tail.promise, completed.promise]);
    controller.abort();
    const messages = await pending;
    expect(results(messages)).toEqual([expect.objectContaining({ content: 'Saved.' })]);
    expect(results(messages)[0].is_error).not.toBe(true);
    expect(messages.filter(message => message.type === 'result')).toHaveLength(1);
  }, 2000);

  it('does not execute a tool when persistence rejects its complete block', async () => {
    const execute = vi.fn(async () => ({ content: 'Unexpected.', isError: false }));
    const { provider, requests } = scriptedProvider(async function* () { yield* toolCall('Write'); });
    const options: QueryLoopOptions & { onAssistantBlock: (message: SDKAssistantMessage, responseUuid: string) => Promise<void> } = {
      onAssistantBlock: async () => { throw new Error('Persistence unavailable'); },
    };
    const messages = await collect(queryLoop(config(), provider, [tool('Write', execute, false)], 'Save the file.', options));
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ type: 'result', is_error: true });
  });

  it('retains a completed side effect when the consumer closes before receiving results', async () => {
    const retained: SDKMessage[] = [];
    const { provider } = scriptedProvider(async function* (request) {
      yield* toolCall('Write');
      await waitForAbort(request.providerOptions!.signal as AbortSignal);
    });
    const generator = queryLoop(config(), provider, [tool('Write', async () => ({ content: 'Saved durably.', isError: false }), false)], 'Save the file.', {
      onAssistantMessage: message => { retained.push(message); },
      onToolResultMessage: message => { retained.push(message); },
    });
    for await (const message of generator) {
      if (message.type === 'tool_progress' && message.elapsed_time_seconds !== undefined) break;
    }
    expect(retained.filter(message => message.type === 'assistant')).toHaveLength(1);
    expect(results(retained)).toEqual([expect.objectContaining({ content: 'Saved durably.', tool_use_id: 'call-0' })]);
    expect(results(retained)[0].is_error).not.toBe(true);
  }, 2000);

  it('retains completed results and ends without replay when final assistant persistence fails', async () => {
    const retained: SDKMessage[] = [];
    const { provider, requests } = scriptedProvider(async function* () { yield* toolCall('Write'); });
    const execute = vi.fn(async () => ({ content: 'Saved once.', isError: false }));
    const failure = new ProviderError('Final persistence failed', { statusCode: 503, retryable: true });
    const messages = await collect(queryLoop(config(), provider, [tool('Write', execute, false)], 'Save the file.', {
      onAssistantMessage: async () => { throw failure; },
      onToolResultMessage: message => { retained.push(message); },
    }));
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(results(retained)).toEqual([expect.objectContaining({ content: 'Saved once.', tool_use_id: 'call-0' })]);
    expect(results(retained)[0].is_error).not.toBe(true);
    expect(results(messages)).toEqual(results(retained));
    expect(messages.at(-1)).toMatchObject({ type: 'result', is_error: true });
  });

  it('still retains completed results when assistant persistence fails during consumer close', async () => {
    const retained: SDKMessage[] = [];
    const { provider, requests } = scriptedProvider(async function* (request) {
      yield* toolCall('Write');
      await waitForAbort(request.providerOptions!.signal as AbortSignal);
    });
    const execute = vi.fn(async () => ({ content: 'Saved before close.', isError: false }));
    const failure = new ProviderError('Final persistence failed', { statusCode: 503, retryable: true });
    const consume = async () => {
      const generator = queryLoop(config(), provider, [tool('Write', execute, false)], 'Save the file.', {
        onAssistantMessage: async () => { throw failure; },
        onToolResultMessage: message => { retained.push(message); },
      });
      for await (const message of generator) {
        if (message.type === 'tool_progress' && message.elapsed_time_seconds !== undefined) break;
      }
    };
    await expect(consume()).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(results(retained)).toEqual([expect.objectContaining({ content: 'Saved before close.', tool_use_id: 'call-0' })]);
    expect(results(retained)[0].is_error).not.toBe(true);
  }, 2000);

  it('excludes the tool tail from model API time', async () => {
    const providerFinished = deferred();
    const releaseTool = deferred();
    const { provider } = scriptedProvider(async function* () {
      yield* toolCall('Read');
      providerFinished.resolve();
    });
    const cfg = config();
    cfg.maxTurns = 1;
    try {
      const pending = collect(queryLoop(cfg, provider, [tool('Read', async () => {
        await releaseTool.promise;
        return { content: 'Read complete.', isError: false };
      })], 'Read the file.'));
      await providerFinished.promise;
      await new Promise<void>(resolve => setTimeout(resolve, 250));
      releaseTool.resolve();
      const messages = await pending;
      const result = messages.find(message => message.type === 'result') as
        { duration_api_ms: number; duration_ms: number } | undefined;
      expect(result).toBeDefined();
      expect(result!.duration_ms - result!.duration_api_ms).toBeGreaterThanOrEqual(150);
    } finally {
      releaseTool.resolve();
    }
  }, 5000);

  it('aborts in-flight tools when the stream consumer closes', async () => {
    const controller = new AbortController();
    const started = deferred();
    let toolSignal: AbortSignal | undefined;
    const { provider } = scriptedProvider(async function* (request) {
      yield* toolCall('Read');
      await waitForAbort(request.providerOptions!.signal as AbortSignal);
    });
    const generator = queryLoop(config(controller), provider, [tool('Read', async (_input, ctx) => {
      toolSignal = ctx.abortSignal;
      started.resolve();
      await ctx.onToolMessage?.({
        type: 'assistant', parent_tool_use_id: 'call-0', uuid: 'active-child', session_id: 'child',
        message: { id: 'active-child', type: 'message', role: 'assistant', model: 'fixture',
          content: [{ type: 'text', text: 'Started.' }], stop_reason: null, stop_sequence: null },
      });
      await waitForAbort(ctx.abortSignal);
      return { content: 'Stopped.', isError: true };
    })], 'Read the file.');
    for await (const message of generator) {
      if (message.type === 'assistant' && message.uuid === 'active-child') {
        await started.promise;
        break;
      }
    }
    expect(toolSignal?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  }, 2000);
  it('waits for an earlier block before admitting an interleaved completed call', async () => {
    const order: number[] = [];
    const { provider } = scriptedProvider(async function* () {
      for (const index of [0, 1]) {
        yield { type: 'content_block_start', index, content_block: {
          type: 'tool_use', id: `call-${index}`, name: 'Read', input: { index },
        } };
      }
      yield { type: 'content_block_stop', index: 1 };
      await flush();
      expect(order).toEqual([]);
      yield { type: 'content_block_stop', index: 0 };
    });
    const messages = await collect(queryLoop(config(), provider, [tool('Read', async input => {
      order.push(Number(input.index));
      return { content: String(input.index), isError: false };
    })], 'Read.'));
    expect(order).toEqual([0, 1]);
    expect(results(messages).map(result => result.tool_use_id)).toEqual(['call-0', 'call-1']);
  });

  it.each<StreamEvent>([
    { type: 'input_json_delta', index: 0, partialJson: '{"late":true}' },
    { type: 'message_start', id: 'restarted', model: 'fixture', usage },
    { type: 'content_block_start', index: -1,
      content_block: { type: 'tool_use', id: 'late', name: 'Write', input: {} } },
  ])('rejects a malformed later event without replaying a completed operation: $type', async event => {
    const finished = deferred();
    const execute = vi.fn(async () => ({ content: 'Saved.', isError: false }));
    const { provider, requests } = scriptedProvider(async function* () {
      yield* toolCall('Write');
      await finished.promise;
      yield event;
    });
    const messages = await collect(queryLoop(config(), provider, [tool('Write', execute, false)], 'Save.', {
      onProgress(message) {
        if (message.type === 'tool_progress' && message.elapsed_time_seconds !== undefined) finished.resolve();
      },
    }));
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(results(messages)[0].content).toBe('Saved.');
    expect(messages.at(-1)).toMatchObject({ type: 'result', is_error: true });
  });

});
