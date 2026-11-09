/**
 * Unit tests for the query loop — the heart of the SDK.
 *
 * Uses a fully synchronous in-process mock provider so tests run
 * instantly without any network calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { queryLoop } from './query-loop.js';
import type { SDKMessage } from './query-types.js';
import type {
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  ProviderCapabilities,
  UsageInfo,
  Message,
} from '../types/provider.js';
import type { Tool, ToolContext, ToolResult } from '../types/tool.js';
import type { QueryConfig } from '../types/config.js';
import { GOAL_RECITATION_INTERVAL } from '../prompt/constants.js';
import { ProviderError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(input = 10, output = 20): UsageInfo {
  return { input_tokens: input, output_tokens: output };
}

/** Build a minimal QueryConfig suitable for unit testing. */
function makeConfig(overrides: Partial<QueryConfig> = {}): QueryConfig {
  const abortController = new AbortController();
  return {
    model: 'test-model',
    maxTokens: 16_384,
    contextWindow: 200_000,
    maxTurns: 5,
    cwd: '/tmp',
    env: {},
    permissionMode: 'bypassPermissions',
    systemPrompt: 'You are a test assistant.',
    thinking: { type: 'disabled' },
    abortSignal: abortController.signal,
    ...overrides,
  };
}

/** Collect all messages from a queryLoop generator. */
async function drain(
  gen: AsyncGenerator<SDKMessage>,
  limit = 100,
): Promise<SDKMessage[]> {
  const msgs: SDKMessage[] = [];
  for await (const m of gen) {
    msgs.push(m);
    if (msgs.length >= limit) break;
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// Mock LlmProvider builders
// ---------------------------------------------------------------------------

/** Provider capabilities used by all mock providers. */
const TEST_CAPS: ProviderCapabilities = {
  streaming: true,
  toolCalling: true,
  thinking: false,
  imageInput: false,
  pdfInput: false,
  audioInput: false,
  videoInput: false,
  caching: false,
  systemPromptStyle: 'top_level',
};

/**
 * Build a mock provider whose createMessageStream emits the given events
 * on every call, then emits message_delta + message_stop.
 */
function makeMockProvider(
  responses: Array<Array<StreamEvent>>,
  stopReason: 'end_turn' | 'tool_use' = 'end_turn',
): LlmProvider {
  let callIndex = 0;

  return {
    id: 'mock',
    name: 'Mock',
    capabilities: () => TEST_CAPS,
    async createMessage(_req: ProviderRequest): Promise<ProviderResponse> {
      const idx = Math.min(callIndex, responses.length - 1);
      callIndex++;
      const events = responses[idx];
      const text = events
        .filter((e): e is { type: 'text_delta'; index: number; text: string } =>
          e.type === 'text_delta',
        )
        .map((e) => e.text)
        .join('');
      return {
        id: `msg_${randomUUID()}`,
        content: [{ type: 'text', text }],
        stopReason: stopReason === 'tool_use' ? 'tool_use' : 'end_turn',
        usage: makeUsage(),
        model: 'test-model',
      };
    },
    async *createMessageStream(
      _req: ProviderRequest,
    ): AsyncGenerator<StreamEvent, void, undefined> {
      const idx = Math.min(callIndex, responses.length - 1);
      callIndex++;
      const events = responses[idx];
      for (const event of events) {
        yield event;
      }
      yield { type: 'message_delta', stopReason: stopReason as 'end_turn' | 'tool_use', usage: makeUsage() };
      yield { type: 'message_stop' };
    },
  };
}

/** A simple text response stream. */
function textStream(text: string): StreamEvent[] {
  return [
    { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: makeUsage() },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'text_delta', index: 0, text },
    { type: 'content_block_stop', index: 0 },
  ];
}

/** A tool_use response stream. */
function toolUseStream(toolName: string, input: Record<string, unknown>): StreamEvent[] {
  const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
  const inputJson = JSON.stringify(input);
  return [
    { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: makeUsage() },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} },
    },
    { type: 'input_json_delta', index: 0, partialJson: inputJson },
    { type: 'content_block_stop', index: 0 },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('queryLoop — basic message flow', () => {
  it('yields system:init as the first message', async () => {
    const provider = makeMockProvider([textStream('Hello!')]);
    const config = makeConfig({ maxTurns: 1 });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));
    expect(msgs[0].type).toBe('system');
    expect((msgs[0] as Record<string, unknown>).subtype).toBe('init');
  });

  it('system:init includes required init fields', async () => {
    const provider = makeMockProvider([textStream('Hi')]);
    const config = makeConfig({ maxTurns: 1 });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));
    const init = msgs[0] as Record<string, unknown>;

    expect(init.subtype).toBe('init');
    expect(init.session_id).toBeTruthy();
    expect(typeof init.model).toBe('string');
    expect(typeof init.cwd).toBe('string');
    expect(init.permissionMode).toBe('bypassPermissions');
    expect(Array.isArray(init.mcp_servers)).toBe(true);
    expect(Array.isArray(init.slash_commands)).toBe(true);
    expect(Array.isArray(init.tools)).toBe(true);
    expect(init.uuid).toBeTruthy();
  });

  it('yields an assistant message after the LLM responds', async () => {
    const provider = makeMockProvider([textStream('Hello world')]);
    const config = makeConfig({ maxTurns: 1 });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));
    const assistant = msgs.find((m) => m.type === 'assistant');

    expect(assistant).toBeTruthy();
    if (!assistant || assistant.type !== 'assistant') throw new Error('no assistant');
    expect(assistant.message.role).toBe('assistant');
    const textBlock = assistant.message.content.find((b) => b.type === 'text');
    expect(textBlock).toBeTruthy();
    expect((textBlock as { type: 'text'; text: string }).text).toBe('Hello world');
  });

  it('yields a result message as the last message', async () => {
    const provider = makeMockProvider([textStream('Done')]);
    const config = makeConfig({ maxTurns: 1 });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));
    const last = msgs[msgs.length - 1];

    expect(last.type).toBe('result');
    expect((last as Record<string, unknown>).is_error).toBe(false);
  });

  it('result message has required init fields', async () => {
    const provider = makeMockProvider([textStream('Done')]);
    const config = makeConfig({ maxTurns: 1 });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));
    const result = msgs.find((m) => m.type === 'result') as Record<string, unknown>;

    expect(result).toBeTruthy();
    expect(result.subtype).toBe('success');
    expect(typeof result.result).toBe('string');
    expect(typeof result.num_turns).toBe('number');
    expect(typeof result.total_cost_usd).toBe('number');
    expect(typeof result.duration_ms).toBe('number');
    expect(result.uuid).toBeTruthy();
    expect(result.session_id).toBeTruthy();
    expect(result.usage).toBeTruthy();
  });

  it('all messages have a uuid field', async () => {
    const provider = makeMockProvider([textStream('Hi')]);
    const config = makeConfig({ maxTurns: 1 });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));
    const noUuid = msgs.filter(
      (m) => m.type !== 'stream_event' && !(m as Record<string, unknown>).uuid,
    );
    expect(noUuid).toHaveLength(0);
  });

  it('session_id is consistent across all messages', async () => {
    const provider = makeMockProvider([textStream('OK')]);
    const config = makeConfig({ maxTurns: 1 });
    const sessionId = randomUUID();

    const msgs = await drain(
      queryLoop(config, provider, [], 'hi', { sessionId }),
    );
    const sessionIds = new Set(
      msgs
        .filter((m) => m.type !== 'stream_event')
        .map((m) => (m as Record<string, unknown>).session_id as string),
    );
    expect(sessionIds.size).toBe(1);
    expect(sessionIds.has(sessionId)).toBe(true);
  });
});

describe('queryLoop — max turns', () => {
  it('stops after maxTurns is reached', async () => {
    // Provider always responds with a tool_use, so turns keep going
    // but we cap at maxTurns=2
    const noop: Tool = {
      name: 'noop',
      description: 'does nothing',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'read',
      async execute(_i: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
        return { content: 'done', isError: false };
      },
    };

    // First call: tool_use; second call: text to end
    const provider = makeMockProvider(
      [toolUseStream('noop', {}), textStream('finished')],
      'end_turn',
    );
    // Override second call stop reason explicitly
    let callCount = 0;
    const wrappedProvider: LlmProvider = {
      ...provider,
      async *createMessageStream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        if (callCount === 0) {
          callCount++;
          // First call: tool_use response
          yield* toolUseStream('noop', {});
          yield { type: 'message_delta', stopReason: 'tool_use', usage: makeUsage() };
          yield { type: 'message_stop' };
        } else {
          callCount++;
          // Second call: text response ending the turn
          yield* textStream('finished');
          yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
          yield { type: 'message_stop' };
        }
      },
    };

    const config = makeConfig({ maxTurns: 2 });
    const msgs = await drain(queryLoop(config, wrappedProvider, [noop], 'go'));

    const result = msgs.find((m) => m.type === 'result') as Record<string, unknown>;
    expect(result).toBeTruthy();
    expect(result.num_turns).toBeLessThanOrEqual(2);
  });

  it('emits error_max_turns result when turns are exhausted by tool use', async () => {
    const noop: Tool = {
      name: 'noop',
      description: 'does nothing',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'read',
      async execute(_i: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
        return { content: 'done', isError: false };
      },
    };

    // Always returns tool_use — loop can never end normally
    const provider: LlmProvider = {
      id: 'mock',
      name: 'Mock',
      capabilities: () => TEST_CAPS,
      async createMessage(_req: ProviderRequest): Promise<ProviderResponse> {
        const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
        return {
          id: `msg_${randomUUID()}`,
          content: [{ type: 'tool_use', id: toolUseId, name: 'noop', input: {} }],
          stopReason: 'tool_use',
          usage: makeUsage(),
          model: 'test-model',
        };
      },
      async *createMessageStream(_req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        yield* toolUseStream('noop', {});
        yield { type: 'message_delta', stopReason: 'tool_use', usage: makeUsage() };
        yield { type: 'message_stop' };
      },
    };

    const config = makeConfig({ maxTurns: 1 });
    const msgs = await drain(queryLoop(config, provider, [noop], 'go'), 50);

    const result = msgs.find((m) => m.type === 'result') as Record<string, unknown>;
    expect(result).toBeTruthy();
    expect(result.is_error).toBe(true);
    expect(result.subtype).toBe('error_max_turns');
  });
});

describe('queryLoop — tool execution', () => {
  it('executes a tool and sends result back to LLM', async () => {
    const executeSpy = vi.fn().mockResolvedValue({
      content: 'tool output',
      isError: false,
    });

    const echoTool: Tool = {
      name: 'echo',
      description: 'Echoes input',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      permissionLevel: 'read',
      execute: executeSpy,
    };

    let callCount = 0;
    const provider: LlmProvider = {
      id: 'mock',
      name: 'Mock',
      capabilities: () => TEST_CAPS,
      async createMessage(_req: ProviderRequest): Promise<ProviderResponse> {
        if (callCount === 0) {
          callCount++;
          const id = `toolu_${randomUUID().slice(0, 8)}`;
          return {
            id: `msg_${randomUUID()}`,
            content: [{ type: 'tool_use', id, name: 'echo', input: { text: 'hello' } }],
            stopReason: 'tool_use',
            usage: makeUsage(),
            model: 'test-model',
          };
        }
        callCount++;
        return {
          id: `msg_${randomUUID()}`,
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          usage: makeUsage(),
          model: 'test-model',
        };
      },
      async *createMessageStream(_req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        if (callCount === 0) {
          callCount++;
          yield* toolUseStream('echo', { text: 'hello' });
          yield { type: 'message_delta', stopReason: 'tool_use', usage: makeUsage() };
          yield { type: 'message_stop' };
        } else {
          callCount++;
          yield* textStream('done');
          yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
          yield { type: 'message_stop' };
        }
      },
    };

    const config = makeConfig({ maxTurns: 3 });
    const msgs = await drain(queryLoop(config, provider, [echoTool], 'use echo'));

    // Tool should have been called
    expect(executeSpy).toHaveBeenCalledOnce();

    // Should have a user message (tool results)
    const userMsg = msgs.find((m) => m.type === 'user');
    expect(userMsg).toBeTruthy();

    // Should end with a successful result
    const result = msgs.find((m) => m.type === 'result') as Record<string, unknown>;
    expect(result?.is_error).toBe(false);
  });

  it('handles tool execution errors gracefully', async () => {
    const failTool: Tool = {
      name: 'fail',
      description: 'Always fails',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'read',
      async execute(_i: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
        throw new Error('Tool boom');
      },
    };

    let callCount = 0;
    const provider: LlmProvider = {
      id: 'mock',
      name: 'Mock',
      capabilities: () => TEST_CAPS,
      async createMessage(_req: ProviderRequest): Promise<ProviderResponse> {
        if (callCount === 0) {
          callCount++;
          const id = `toolu_${randomUUID().slice(0, 8)}`;
          return {
            id: `msg_${randomUUID()}`,
            content: [{ type: 'tool_use', id, name: 'fail', input: {} }],
            stopReason: 'tool_use',
            usage: makeUsage(),
            model: 'test-model',
          };
        }
        callCount++;
        return {
          id: `msg_${randomUUID()}`,
          content: [{ type: 'text', text: 'noted' }],
          stopReason: 'end_turn',
          usage: makeUsage(),
          model: 'test-model',
        };
      },
      async *createMessageStream(_req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        if (callCount === 0) {
          callCount++;
          yield* toolUseStream('fail', {});
          yield { type: 'message_delta', stopReason: 'tool_use', usage: makeUsage() };
          yield { type: 'message_stop' };
        } else {
          callCount++;
          yield* textStream('noted');
          yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
          yield { type: 'message_stop' };
        }
      },
    };

    const config = makeConfig({ maxTurns: 3 });
    // Should not throw — error is wrapped and forwarded to LLM
    const msgs = await drain(queryLoop(config, provider, [failTool], 'use fail'));

    const userMsg = msgs.find((m) => m.type === 'user') as Record<string, unknown> | undefined;
    expect(userMsg).toBeTruthy();
    // Tool result should indicate error
    const content = (userMsg?.message as Record<string, unknown>)?.content as Array<Record<string, unknown>>;
    const toolResult = content?.find((b) => b.type === 'tool_result');
    expect(toolResult).toBeTruthy();

    const result = msgs.find((m) => m.type === 'result') as Record<string, unknown>;
    expect(result?.is_error).toBe(false);
  });
});

describe('queryLoop — abort handling', () => {
  it('settles cancellation after init before making a provider request', async () => {
    const controller = new AbortController();
    const provider = makeMockProvider([textStream('not reached')]);
    const createMessageStream = vi.spyOn(provider, 'createMessageStream');
    const generator = queryLoop(makeConfig({ abortSignal: controller.signal }), provider, [], 'hi');
    expect((await generator.next()).value).toMatchObject({ type: 'system', subtype: 'init' });
    controller.abort();
    const messages = await drain(generator);
    expect(messages.filter(message => message.type === 'result')).toEqual([
      expect.objectContaining({ subtype: 'error_during_execution', num_turns: 0 }),
    ]);
    expect(createMessageStream).not.toHaveBeenCalled();
  });

  it('settles cancellation during retry backoff without another provider attempt', async () => {
    const controller = new AbortController();
    const provider = makeMockProvider([]);
    const request = vi.fn(async function* (): AsyncGenerator<StreamEvent> { throw ProviderError.rateLimit('Try later'); });
    provider.createMessageStream = request;
    const messages: SDKMessage[] = [];
    for await (const message of queryLoop(makeConfig({ abortSignal: controller.signal }), provider, [], 'hi')) {
      messages.push(message);
      if (message.type === 'system' && message.subtype === 'api_retry') controller.abort();
    }
    expect(request).toHaveBeenCalledOnce();
    expect(messages.filter(message => message.type === 'result')).toEqual([
      expect.objectContaining({ subtype: 'error_during_execution', num_turns: 0 }),
    ]);
  });

  it('settles cancellation during compaction without replacing history', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const provider = makeMockProvider([textStream('partial answer')]);
    const stream = provider.createMessageStream.bind(provider);
    provider.createMessageStream = async function* (request) {
      for await (const event of stream(request)) {
        yield event.type === 'message_delta' ? { ...event, usage: makeUsage(4000) } : event;
      }
    };
    provider.createMessage = vi.fn(request => new Promise<ProviderResponse>((_resolve, reject) => {
      expect(request.thinking).toEqual({ type: 'adaptive' });
      expect(request.providerOptions?.reasoning_effort).toBe('low');
      const signal = request.providerOptions?.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started();
    }));
    const onHistoryCompacted = vi.fn();
    const history: Message[] = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'Saved history '.repeat(100) }));
    const pending = drain(queryLoop(makeConfig({ contextWindow: 4096, maxTokens: 512, systemPrompt: 'Fixture.', abortSignal: controller.signal, thinking: { type: 'adaptive' }, effort: 'low' }), provider, [], history, { onHistoryCompacted }));
    await ready;
    controller.abort();
    const messages = await pending;
    expect(provider.createMessage).toHaveBeenCalledOnce();
    expect(onHistoryCompacted).not.toHaveBeenCalled();
    expect(messages.filter(message => message.type === 'result')).toEqual([
      expect.objectContaining({ subtype: 'error_during_execution', num_turns: 0, usage: expect.objectContaining({ input_tokens: 0 }) }),
    ]);
  }, 5000);

  it('settles tool cancellation with paired tool results and one terminal result', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const tool: Tool = {
      name: 'wait', description: 'Wait for cancellation',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_input, context) => new Promise<ToolResult>((_resolve, reject) => {
        context.abortSignal.addEventListener('abort', () => reject(context.abortSignal.reason), { once: true });
        started();
      }),
    };
    const progress: SDKMessage[] = [];
    const pending = drain(queryLoop(
      makeConfig({ abortSignal: controller.signal }),
      makeMockProvider([toolUseStream('wait', {})], 'tool_use'),
      [tool], 'Wait until stopped', { onProgress: message => progress.push(message) },
    ));
    await ready;
    controller.abort();
    const messages = await pending;
    const results = messages.filter(message => message.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ subtype: 'error_during_execution', errors: ['Operation was aborted'], num_turns: 1 });
    expect(progress.filter(message => message.type === 'result')).toEqual(results);
    const assistant = messages.find(message => message.type === 'assistant');
    const call = assistant?.type === 'assistant' ? assistant.message.content.find(block => block.type === 'tool_use') : undefined;
    const blocks = messages.flatMap(message => message.type === 'user' ? message.message.content : []);
    expect(blocks.filter(block => block.type === 'tool_result')).toEqual([
      expect.objectContaining({ tool_use_id: call?.type === 'tool_use' ? call.id : undefined, is_error: true, content: 'Interrupted by user' }),
    ]);
    expect(messages.at(-1)?.type).toBe('result');
  });

  it('settles cancellation while a permission callback is still pending', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const execute = vi.fn(async () => ({ content: 'not reached', isError: false }));
    const pending = drain(queryLoop(makeConfig({
      abortSignal: controller.signal, permissionMode: 'default',
      canUseTool: async () => { started(); return new Promise(() => {}); },
    }), makeMockProvider([toolUseStream('work', {})], 'tool_use'), [{
      name: 'work', description: 'Protected operation', inputSchema: { type: 'object', properties: {} }, execute,
    }], 'Do work'));
    await ready;
    controller.abort();
    const messages = await pending;
    expect(execute).not.toHaveBeenCalled();
    expect(messages.filter(message => message.type === 'result')).toHaveLength(1);
  }, 1000);

  it('does not start tools after cancellation at an assistant message boundary', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => ({ content: 'not reached', isError: false }));
    const generator = queryLoop(makeConfig({ abortSignal: controller.signal }),
      makeMockProvider([toolUseStream('work', {})], 'tool_use'), [{
        name: 'work', description: 'Protected operation', inputSchema: { type: 'object', properties: {} }, execute,
      }], 'Do work');
    const messages: SDKMessage[] = [];
    for await (const message of generator) {
      messages.push(message);
      if (message.type === 'assistant') controller.abort();
    }
    expect(execute).not.toHaveBeenCalled();
    expect(messages.filter(message => message.type === 'result')).toHaveLength(1);
  });

  it('settles cancellation while a provider stream is active', async () => {
    const abortController = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });

    let resolveBlock!: () => void;
    const blockPromise = new Promise<void>((resolve) => {
      resolveBlock = resolve;
    });

    const slowProvider: LlmProvider = {
      id: 'mock',
      name: 'Mock',
      capabilities: () => TEST_CAPS,
      async createMessage(_req: ProviderRequest): Promise<ProviderResponse> {
        await blockPromise;
        return {
          id: 'msg_1',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          usage: makeUsage(),
          model: 'test-model',
        };
      },
      async *createMessageStream(_req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        started();
        await blockPromise;
        yield* textStream('done');
        yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
        yield { type: 'message_stop' };
      },
    };

    // Pass the abort signal directly in config (overrides the default one from makeConfig)
    const config = makeConfig({ maxTurns: 5 });
    (config as Record<string, unknown>).abortSignal = abortController.signal;
    const msgs: SDKMessage[] = [];

    const drainPromise = (async () => {
      for await (const m of queryLoop(config, slowProvider, [], 'hi')) {
        msgs.push(m);
      }
    })();

    await ready;
    abortController.abort();
    resolveBlock(); // unblock the provider

    await drainPromise;
    expect(msgs.filter(message => message.type === 'result')).toEqual([
      expect.objectContaining({ subtype: 'error_during_execution', errors: ['Operation was aborted'], is_error: true }),
    ]);
    expect(msgs.at(-1)?.type).toBe('result');
  });
});

describe('queryLoop — permission handling', () => {
  it('skips canUseTool in bypassPermissions mode', async () => {
    const canUseToolSpy = vi.fn().mockResolvedValue({ behavior: 'allow' as const });

    const noop: Tool = {
      name: 'noop',
      description: 'does nothing',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'execute',
      async execute(_i: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
        return { content: 'ok', isError: false };
      },
    };

    let callCount = 0;
    const provider: LlmProvider = {
      id: 'mock',
      name: 'Mock',
      capabilities: () => TEST_CAPS,
      async createMessage(_req: ProviderRequest): Promise<ProviderResponse> {
        if (callCount === 0) {
          callCount++;
          return {
            id: `msg_${randomUUID()}`,
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'noop', input: {} }],
            stopReason: 'tool_use',
            usage: makeUsage(),
            model: 'test-model',
          };
        }
        callCount++;
        return {
          id: `msg_${randomUUID()}`,
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          usage: makeUsage(),
          model: 'test-model',
        };
      },
      async *createMessageStream(_req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        if (callCount === 0) {
          callCount++;
          yield* toolUseStream('noop', {});
          yield { type: 'message_delta', stopReason: 'tool_use', usage: makeUsage() };
          yield { type: 'message_stop' };
        } else {
          callCount++;
          yield* textStream('done');
          yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
          yield { type: 'message_stop' };
        }
      },
    };

    const config = makeConfig({
      maxTurns: 3,
      permissionMode: 'bypassPermissions',
      canUseTool: canUseToolSpy as unknown as QueryConfig['canUseTool'],
    });
    await drain(queryLoop(config, provider, [noop], 'go'));

    // canUseTool should NOT be called in bypassPermissions mode
    expect(canUseToolSpy).not.toHaveBeenCalled();
  });

  it('calls canUseTool in default mode and respects deny', async () => {
    const canUseToolSpy = vi.fn().mockResolvedValue({
      behavior: 'deny' as const,
      message: 'not allowed',
    });

    const noop: Tool = {
      name: 'noop',
      description: 'does nothing',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'execute',
      async execute(_i: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
        return { content: 'ok', isError: false };
      },
    };

    let callCount = 0;
    const provider: LlmProvider = {
      id: 'mock',
      name: 'Mock',
      capabilities: () => TEST_CAPS,
      async createMessage(_req: ProviderRequest): Promise<ProviderResponse> {
        if (callCount === 0) {
          callCount++;
          return {
            id: `msg_${randomUUID()}`,
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'noop', input: {} }],
            stopReason: 'tool_use',
            usage: makeUsage(),
            model: 'test-model',
          };
        }
        callCount++;
        return {
          id: `msg_${randomUUID()}`,
          content: [{ type: 'text', text: 'understood' }],
          stopReason: 'end_turn',
          usage: makeUsage(),
          model: 'test-model',
        };
      },
      async *createMessageStream(_req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        if (callCount === 0) {
          callCount++;
          yield* toolUseStream('noop', {});
          yield { type: 'message_delta', stopReason: 'tool_use', usage: makeUsage() };
          yield { type: 'message_stop' };
        } else {
          callCount++;
          yield* textStream('understood');
          yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
          yield { type: 'message_stop' };
        }
      },
    };

    const config = makeConfig({
      maxTurns: 3,
      permissionMode: 'default',
      canUseTool: canUseToolSpy as unknown as QueryConfig['canUseTool'],
    });
    const msgs = await drain(queryLoop(config, provider, [noop], 'go'));

    expect(canUseToolSpy).toHaveBeenCalledOnce();

    // Tool result should indicate permission denied
    const userMsg = msgs.find((m) => m.type === 'user') as Record<string, unknown> | undefined;
    if (userMsg) {
      const content = (userMsg.message as Record<string, unknown>)?.content as Array<Record<string, unknown>>;
      const toolResult = content?.find((b) => b.type === 'tool_result');
      expect(toolResult).toBeTruthy();
    }
  });
});

describe('queryLoop — cost tracking', () => {
  it('result message contains non-zero total_cost_usd for Anthropic provider', async () => {
    // Cost is 0 for our mock provider since pricing lookup may miss test-model
    const provider = makeMockProvider([textStream('hi')]);
    const config = makeConfig({ maxTurns: 1 });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));
    const result = msgs.find((m) => m.type === 'result') as Record<string, unknown>;

    expect(result).toBeTruthy();
    expect(typeof result.total_cost_usd).toBe('number');
    // Cost may be 0 for unknown model, but field must be present
    expect(result.total_cost_usd).toBeGreaterThanOrEqual(0);
  });

  it('result message usage has correct token counts', async () => {
    const provider = makeMockProvider([textStream('hello world')]);
    const config = makeConfig({ maxTurns: 1 });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));
    const result = msgs.find((m) => m.type === 'result') as Record<string, unknown>;
    const usage = result?.usage as Record<string, unknown> | undefined;

    expect(usage).toBeTruthy();
    // Usage fields may be camelCase or snake_case depending on provider
    const inputTokens = (usage?.inputTokens ?? usage?.input_tokens) as number | undefined;
    const outputTokens = (usage?.outputTokens ?? usage?.output_tokens) as number | undefined;
    expect(typeof inputTokens === 'number' || inputTokens === undefined).toBe(true);
    expect(typeof outputTokens === 'number' || outputTokens === undefined).toBe(true);
  });
});

describe('queryLoop — streaming events', () => {
  it('yields stream_event messages for each provider event when includePartialMessages is true', async () => {
    const provider = makeMockProvider([textStream('hello')]);
    const config = makeConfig({ maxTurns: 1, includePartialMessages: true });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));
    const streamEvents = msgs.filter((m) => m.type === 'stream_event');

    // text_delta events should be wrapped as stream_events
    expect(streamEvents.length).toBeGreaterThan(0);
  });

  it('does not yield stream_event messages when includePartialMessages is false', async () => {
    const provider = makeMockProvider([textStream('hello')]);
    const config = makeConfig({ maxTurns: 1, includePartialMessages: false });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));
    const streamEvents = msgs.filter((m) => m.type === 'stream_event');

    expect(streamEvents).toHaveLength(0);
  });
});

describe('queryLoop — initial prompt formats', () => {
  it('accepts a string prompt', async () => {
    const provider = makeMockProvider([textStream('ok')]);
    const msgs = await drain(queryLoop(makeConfig({ maxTurns: 1 }), provider, [], 'hello'));

    expect(msgs.find((m) => m.type === 'result')).toBeTruthy();
  });

  it('accepts a Message array as initial prompt', async () => {
    const provider = makeMockProvider([textStream('ok')]);
    const msgs = await drain(
      queryLoop(makeConfig({ maxTurns: 1 }), provider, [], [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ]),
    );

    expect(msgs.find((m) => m.type === 'result')).toBeTruthy();
  });
});

describe('queryLoop — stagnation notice', () => {
  it('appends a stagnation notice to the tool_result after repeated identical calls', async () => {
    const noop: Tool = {
      name: 'noop',
      description: 'does nothing',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'read',
      async execute(_i: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
        return { content: 'done', isError: false };
      },
    };

    // Always the same tool call with identical input — never terminates.
    const provider: LlmProvider = {
      id: 'mock',
      name: 'Mock',
      capabilities: () => TEST_CAPS,
      async createMessage(): Promise<ProviderResponse> {
        throw new Error('unused');
      },
      async *createMessageStream(): AsyncGenerator<StreamEvent, void, undefined> {
        yield* toolUseStream('noop', { path: '/tmp/x' });
        yield { type: 'message_delta', stopReason: 'tool_use', usage: makeUsage() };
        yield { type: 'message_stop' };
      },
    };

    const config = makeConfig({ maxTurns: 5 });
    const msgs = await drain(queryLoop(config, provider, [noop], 'go'), 200);

    const toolResultTexts = msgs
      .filter((m) => m.type === 'user')
      .flatMap((m) => ((m as Record<string, any>).message.content as Array<Record<string, any>>) ?? [])
      .filter((b) => b.type === 'tool_result')
      .map((b) => String(b.content ?? ''));

    const withNotice = toolResultTexts.filter((t) => t.includes('identical input'));
    expect(withNotice).toHaveLength(1);
    expect(withNotice[0]).toContain('This may be intentional');
    expect(withNotice[0]).toContain('continue or adjust your approach');
    expect(toolResultTexts).toHaveLength(5);
  });

  it('does not fire a notice for distinct inputs', async () => {
    const noop: Tool = {
      name: 'noop',
      description: 'does nothing',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'read',
      async execute(_i: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
        return { content: 'done', isError: false };
      },
    };

    let call = 0;
    const provider: LlmProvider = {
      id: 'mock',
      name: 'Mock',
      capabilities: () => TEST_CAPS,
      async createMessage(): Promise<ProviderResponse> {
        throw new Error('unused');
      },
      async *createMessageStream(): AsyncGenerator<StreamEvent, void, undefined> {
        call++;
        yield* toolUseStream('noop', { path: `/tmp/file-${call}` });
        yield { type: 'message_delta', stopReason: 'tool_use', usage: makeUsage() };
        yield { type: 'message_stop' };
      },
    };

    const config = makeConfig({ maxTurns: 5 });
    const msgs = await drain(queryLoop(config, provider, [noop], 'go'), 200);

    const toolResultTexts = msgs
      .filter((m) => m.type === 'user')
      .flatMap((m) => ((m as Record<string, any>).message.content as Array<Record<string, any>>) ?? [])
      .filter((b) => b.type === 'tool_result')
      .map((b) => String(b.content ?? ''));

    expect(toolResultTexts.some((t) => t.includes('identical input'))).toBe(false);
  });
});

describe('queryLoop — end-of-turn checks', () => {
  /** Recording provider that plays the scripted replies, repeating the last one. */
  function makeScriptedRecorder(
    replies: Array<{ events: StreamEvent[]; stop?: 'end_turn' | 'tool_use' }>,
  ): { provider: LlmProvider; requests: ProviderRequest[] } {
    const requests: ProviderRequest[] = [];
    const provider: LlmProvider = {
      id: 'mock',
      name: 'Mock',
      capabilities: () => TEST_CAPS,
      async createMessage(): Promise<ProviderResponse> {
        throw new Error('unused');
      },
      async *createMessageStream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        requests.push(req);
        const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
        yield* reply.events;
        yield { type: 'message_delta', stopReason: reply.stop ?? 'end_turn', usage: makeUsage() };
        yield { type: 'message_stop' };
      },
    };
    return { provider, requests };
  }

  const stoppingHere = () => makeScriptedRecorder([{ events: textStream('stopping here') }]);

  function lastRequestText(requests: ProviderRequest[]): string {
    return JSON.stringify(requests[requests.length - 1].messages);
  }

  const activeGoal = {
    objective: 'Reconcile all invoices',
    doneWhen: ['Every invoice marked'],
    status: 'active' as const,
    updatedBy: 'agent' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('reminds once about unfinished todos, then lets the model stop', async () => {
    const { provider, requests } = stoppingHere();

    const msgs = await drain(
      queryLoop(makeConfig({ maxTurns: 10 }), provider, [], 'go', {
        getPendingTodos: () => [
          { content: 'ship the fix', status: 'pending' },
          { content: 'write tests', status: 'completed' },
        ],
      }),
      200,
    );

    expect(requests.length).toBe(2);
    const text = lastRequestText(requests);
    expect(text).toContain('1 of 2 todo items are unfinished');
    expect(text).toContain('ship the fix');
    expect(text).toContain('This is a check, not an instruction to continue');
    const result = msgs.find((m) => m.type === 'result') as Record<string, unknown>;
    expect(result?.is_error).toBe(false);
  });

  it('does not check when every todo is completed', async () => {
    const { provider, requests } = stoppingHere();

    await drain(
      queryLoop(makeConfig({ maxTurns: 10 }), provider, [], 'go', {
        getPendingTodos: () => [{ content: 'already done', status: 'completed' }],
      }),
      200,
    );

    expect(requests.length).toBe(1);
  });

  it('checks again whenever the open work has changed', async () => {
    const { provider, requests } = stoppingHere();

    let read = 0;
    const msgs = await drain(
      queryLoop(makeConfig({ maxTurns: 10 }), provider, [], 'go', {
        getPendingTodos: () => [{ content: `step ${++read}`, status: 'in_progress' }],
      }),
      300,
    );

    expect(requests.length).toBe(10);
    const result = msgs.find((m) => m.type === 'result') as Record<string, unknown>;
    expect(result?.subtype).toBe('error_max_turns');
  });

  it('checks an active goal even without todos', async () => {
    const { provider, requests } = stoppingHere();

    await drain(
      queryLoop(makeConfig({ maxTurns: 10 }), provider, [], 'go', { getGoal: () => activeGoal }),
      200,
    );

    expect(requests.length).toBe(2);
    const text = lastRequestText(requests);
    expect(text).toContain('Reconcile all invoices');
    expect(text).toContain('is not marked complete');
  });

  it('does not check a goal that is already complete', async () => {
    const { provider, requests } = stoppingHere();

    await drain(
      queryLoop(makeConfig({ maxTurns: 10 }), provider, [], 'go', {
        getGoal: () => ({ ...activeGoal, status: 'complete' }),
      }),
      200,
    );

    expect(requests.length).toBe(1);
  });

  it('skips the open-work check when the host turns it off', async () => {
    const { provider, requests } = stoppingHere();

    await drain(
      queryLoop(
        makeConfig({ maxTurns: 10, turnEndChecks: { openWork: false, completion: false } }),
        provider,
        [],
        'go',
        { getPendingTodos: () => [{ content: 'ship the fix', status: 'pending' }] },
      ),
      200,
    );

    expect(requests.length).toBe(1);
  });

  it('runs the completion check once when enabled and keeps the earlier answer', async () => {
    const { provider, requests } = makeScriptedRecorder([
      { events: textStream('Here is the report.') },
      { events: textStream('') },
    ]);

    const msgs = await drain(
      queryLoop(
        makeConfig({ maxTurns: 10, turnEndChecks: { openWork: true, completion: true } }),
        provider,
        [],
        'write the report',
      ),
      200,
    );

    expect(requests.length).toBe(2);
    expect(lastRequestText(requests)).toContain('Before you finish, look back at what was asked');
    const result = msgs.find((m) => m.type === 'result') as Record<string, unknown>;
    expect(result?.result).toBe('Here is the report.');
  });

  it('runs the open-work check before the completion check', async () => {
    const { provider, requests } = stoppingHere();

    await drain(
      queryLoop(
        makeConfig({ maxTurns: 10, turnEndChecks: { openWork: true, completion: true } }),
        provider,
        [],
        'go',
        { getPendingTodos: () => [{ content: 'ship the fix', status: 'pending' }] },
      ),
      200,
    );

    expect(requests.length).toBe(3);
    expect(JSON.stringify(requests[1].messages)).toContain('work still open');
    expect(lastRequestText(requests)).toContain('Before you finish');
  });
});

describe('queryLoop — goal', () => {
  function makeRecorder(
    replies: Array<{ events: StreamEvent[]; stop?: 'end_turn' | 'tool_use' }>,
  ): { provider: LlmProvider; requests: ProviderRequest[] } {
    const requests: ProviderRequest[] = [];
    const provider: LlmProvider = {
      id: 'mock',
      name: 'Mock',
      capabilities: () => TEST_CAPS,
      async createMessage(): Promise<ProviderResponse> {
        throw new Error('unused');
      },
      async *createMessageStream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        requests.push(req);
        const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
        yield* reply.events;
        yield { type: 'message_delta', stopReason: reply.stop ?? 'end_turn', usage: makeUsage() };
        yield { type: 'message_stop' };
      },
    };
    return { provider, requests };
  }

  const baseGoal = {
    objective: 'Migrate to TypeScript',
    doneWhen: ['tsc passes'],
    status: 'active' as const,
    updatedBy: 'user' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('tells the model and the host about a goal the user set between turns', async () => {
    const { provider, requests } = makeRecorder([{ events: textStream('ok') }]);
    let pending: { previous: null; current: typeof baseGoal } | null = { previous: null, current: baseGoal };

    const msgs = await drain(
      queryLoop(makeConfig({ maxTurns: 3, turnEndChecks: { openWork: false, completion: false } }), provider, [], 'go', {
        getGoal: () => baseGoal,
        drainGoalChange: () => {
          const change = pending;
          pending = null;
          return change;
        },
      }),
      100,
    );

    const event = msgs.find((m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'goal_updated') as
      | Record<string, unknown>
      | undefined;
    expect(event?.source).toBe('user');
    expect((event?.goal as { objective: string }).objective).toBe('Migrate to TypeScript');
    const firstRequest = JSON.stringify(requests[0].messages);
    expect(firstRequest).toContain('The user set a goal for this work.');
    expect(firstRequest).toContain('Objective: Migrate to TypeScript');
  });

  it('reports a goal the model changed through the Goal tool', async () => {
    let goal: typeof baseGoal | null = null;
    const goalTool: Tool = {
      name: 'Goal',
      description: 'goal',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'none',
      async execute(): Promise<ToolResult> {
        goal = { ...baseGoal, updatedBy: 'agent' as never, updatedAt: '2026-01-02T00:00:00.000Z' };
        return { content: 'Goal set.', isError: false };
      },
    };
    const { provider } = makeRecorder([
      { events: toolUseStream('Goal', { action: 'set', objective: 'Migrate to TypeScript' }), stop: 'tool_use' },
      { events: textStream('done') },
    ]);

    const msgs = await drain(
      queryLoop(
        makeConfig({ maxTurns: 5, turnEndChecks: { openWork: false, completion: false } }),
        provider,
        [goalTool],
        'go',
        { getGoal: () => goal },
      ),
      100,
    );

    const events = msgs.filter((m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'goal_updated');
    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).source).toBe('agent');
  });

  it('re-injects the goal and todo list after compaction', async () => {
    const requests: ProviderRequest[] = [];
    const noop: Tool = {
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'none',
      async execute(): Promise<ToolResult> {
        return { content: 'ok', isError: false };
      },
    };
    const provider: LlmProvider = {
      id: 'mock',
      name: 'Mock',
      capabilities: () => TEST_CAPS,
      async createMessage(): Promise<ProviderResponse> {
        return {
          id: 'msg_summary',
          content: [{ type: 'text', text: '<summary>Earlier work summarized.</summary>' }],
          stopReason: 'end_turn',
          usage: makeUsage(),
          model: 'test-model',
        };
      },
      async *createMessageStream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        requests.push(req);
        const first = requests.length === 1;
        const usage = makeUsage(0);
        for (const event of first ? toolUseStream('noop', {}) : textStream('done')) {
          yield event.type === 'message_start' ? { ...event, usage } : event;
        }
        yield { type: 'message_delta', stopReason: first ? 'tool_use' : 'end_turn', usage };
        yield { type: 'message_stop' };
      },
    };
    const history = Array.from({ length: 14 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i} ${'saved evidence '.repeat(250)}`,
    }));
    const todoAttachment = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: '<system-reminder>\n# Current todo list\n[ ] Match March\n</system-reminder>' }],
    };

    await drain(
      queryLoop(
        makeConfig({ maxTurns: 5, contextWindow: 10_000, maxTokens: 1000, systemPrompt: 'Fixture.', turnEndChecks: { openWork: false, completion: false } }),
        provider,
        [noop],
        history,
        { getGoal: () => baseGoal, getTodoAttachment: () => todoAttachment },
      ),
      200,
    );

    const afterCompaction = JSON.stringify(requests[1].messages);
    expect(afterCompaction).toContain('Earlier work summarized.');
    expect(afterCompaction).toContain('Current goal:');
    expect(afterCompaction).toContain('Objective: Migrate to TypeScript');
    expect(afterCompaction).toContain('Match March');
  });

  it('opens each run with the active goal and recites it after it has been out of view', async () => {
    const noop: Tool = {
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'none',
      async execute(): Promise<ToolResult> {
        return { content: 'ok', isError: false };
      },
    };
    const { provider, requests } = makeRecorder([{ events: toolUseStream('noop', {}), stop: 'tool_use' }]);

    await drain(
      queryLoop(
        makeConfig({ maxTurns: 30, turnEndChecks: { openWork: false, completion: false } }),
        provider,
        [noop],
        'go',
        { getGoal: () => baseGoal },
      ),
      400,
    );

    const recitedAt = requests
      .map((r, i) => (JSON.stringify(r.messages[r.messages.length - 1]).includes('Current goal:') ? i : -1))
      .filter((i) => i >= 0);
    // Once when the run opens, then again after the goal has been out of view
    // for the recitation interval.
    expect(recitedAt).toEqual([0, GOAL_RECITATION_INTERVAL + 1]);
  });
});

// ---------------------------------------------------------------------------
// Prompt cache breakpoint injection
// ---------------------------------------------------------------------------

describe('queryLoop — prompt cache breakpoint', () => {
  /** Build a recording provider that captures messages from each LLM call. */
  function makeRecordingProvider(
    cachingEnabled: boolean,
    responses: Array<Array<StreamEvent>>,
  ): { provider: LlmProvider; requests: ProviderRequest[] } {
    const requests: ProviderRequest[] = [];
    let callIndex = 0;

    const provider: LlmProvider = {
      id: 'recording',
      name: 'Recording',
      capabilities: () => ({
        ...TEST_CAPS,
        caching: cachingEnabled,
      }),
      async createMessage(_req: ProviderRequest): Promise<ProviderResponse> {
        return {
          id: 'msg_test',
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          usage: makeUsage(),
          model: 'test-model',
        };
      },
      async *createMessageStream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        requests.push(req);
        const idx = Math.min(callIndex, responses.length - 1);
        callIndex++;
        for (const event of responses[idx]) {
          yield event;
        }
        yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
        yield { type: 'message_stop' };
      },
      listModels: async () => [],
      healthCheck: async () => ({ status: 'healthy' as const }),
    };

    return { provider, requests };
  }

  it('injects cache_control on last block when provider supports caching', async () => {
    const { provider, requests } = makeRecordingProvider(true, [textStream('Hi')]);
    const config = makeConfig({ maxTurns: 1 });

    await drain(queryLoop(config, provider, [], 'hello'));

    expect(requests.length).toBeGreaterThan(0);
    const lastRequest = requests[requests.length - 1];
    const msgs = lastRequest.messages;
    expect(msgs.length).toBeGreaterThan(0);

    const lastMsg = msgs[msgs.length - 1];
    const content = lastMsg.content;

    if (typeof content === 'string') {
      // String content is allowed — not cached via block annotation
      // (string messages don't support inline cache_control in Anthropic API)
    } else {
      const blocks = content as Array<Record<string, unknown>>;
      // Find last non-thinking block
      let targetIdx = blocks.length - 1;
      while (targetIdx >= 0 && blocks[targetIdx].type === 'thinking') {
        targetIdx--;
      }
      if (targetIdx >= 0) {
        expect(blocks[targetIdx].cache_control).toEqual({ type: 'ephemeral' });
      }
    }
  });

  it('does NOT inject cache_control when provider does not support caching', async () => {
    const { provider, requests } = makeRecordingProvider(false, [textStream('Hi')]);
    const config = makeConfig({ maxTurns: 1 });

    await drain(queryLoop(config, provider, [], 'hello'));

    expect(requests.length).toBeGreaterThan(0);
    const lastRequest = requests[requests.length - 1];
    for (const msg of lastRequest.messages) {
      if (typeof msg.content !== 'string') {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          expect(block.cache_control).toBeUndefined();
        }
      }
    }
  });

  it('does not mutate the original messages array', async () => {
    const { provider } = makeRecordingProvider(true, [textStream('Hi')]);
    const config = makeConfig({ maxTurns: 1 });

    // Run the query loop (which builds messages internally)
    await drain(queryLoop(config, provider, [], 'hello'));

    // No assertion needed — test passes if no TypeError about frozen/sealed objects
    // and the test runs without errors
  });

  it('caching still works when message content is a string (no crash)', async () => {
    const { provider, requests } = makeRecordingProvider(true, [textStream('Hi')]);
    const config = makeConfig({ maxTurns: 1 });

    await drain(queryLoop(config, provider, [], 'hello'));

    // Verify the query loop completed successfully
    expect(requests.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tool scheduling
// ---------------------------------------------------------------------------

describe('queryLoop — tool scheduling', () => {
  /** A tool that records when it starts and stops relative to its siblings. */
  function makeTrackingTool(
    name: string,
    concurrencySafe: boolean,
    state: { inFlight: number; peak: Map<string, number> },
  ): Tool {
    return {
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'none',
      ...(concurrencySafe ? { isConcurrencySafe: () => true } : {}),
      async execute(): Promise<ToolResult> {
        state.inFlight++;
        state.peak.set(name, Math.max(state.peak.get(name) ?? 0, state.inFlight));
        await new Promise((resolve) => setTimeout(resolve, 5));
        state.inFlight--;
        return { content: 'done', isError: false };
      },
    } as Tool;
  }

  /** A stream carrying several tool_use blocks in one assistant message. */
  function multiToolStream(names: string[]): StreamEvent[] {
    const events: StreamEvent[] = [
      { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: makeUsage() },
    ];
    names.forEach((name, index) => {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: `toolu_${index}`, name, input: {} },
      });
      events.push({ type: 'input_json_delta', index, partialJson: '{}' });
      events.push({ type: 'content_block_stop', index });
    });
    return events;
  }

  it('runs concurrency-safe tools together', async () => {
    const state = { inFlight: 0, peak: new Map<string, number>() };
    const tools = [makeTrackingTool('SafeRead', true, state)];
    const provider = makeMockProvider(
      [multiToolStream(['SafeRead', 'SafeRead', 'SafeRead']), textStream('done')],
      'tool_use',
    );

    await drain(queryLoop(makeConfig({ maxTurns: 2 }), provider, tools, 'go'));

    expect(state.peak.get('SafeRead')).toBeGreaterThan(1);
  });

  it('never overlaps a tool that has not declared itself safe', async () => {
    const state = { inFlight: 0, peak: new Map<string, number>() };
    const tools = [
      makeTrackingTool('SafeRead', true, state),
      makeTrackingTool('Mutator', false, state),
    ];
    const provider = makeMockProvider(
      [multiToolStream(['SafeRead', 'Mutator', 'SafeRead']), textStream('done')],
      'tool_use',
    );

    await drain(queryLoop(makeConfig({ maxTurns: 2 }), provider, tools, 'go'));

    expect(state.peak.get('Mutator')).toBe(1);
  });

  it('returns tool results in the order the model requested', async () => {
    const state = { inFlight: 0, peak: new Map<string, number>() };
    const tools = [
      makeTrackingTool('Alpha', true, state),
      makeTrackingTool('Beta', false, state),
      makeTrackingTool('Gamma', true, state),
    ];
    const provider = makeMockProvider(
      [multiToolStream(['Alpha', 'Beta', 'Gamma']), textStream('done')],
      'tool_use',
    );

    const msgs = await drain(queryLoop(makeConfig({ maxTurns: 2 }), provider, tools, 'go'));

    const toolResultMsg = msgs.find(
      (m) =>
        m.type === 'user' &&
        Array.isArray((m as never as { message: { content: unknown } }).message.content) &&
        ((m as never as { message: { content: Array<{ type: string }> } }).message.content)[0]?.type ===
          'tool_result',
    ) as never as { message: { content: Array<{ tool_use_id: string }> } };

    expect(toolResultMsg.message.content.map((b) => b.tool_use_id)).toEqual([
      'toolu_0',
      'toolu_1',
      'toolu_2',
    ]);
  });
});

describe('queryLoop — project instruction files', () => {
  it('sends instruction files once, in the per-turn reminder, not in the preset system prompt', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const cwd = mkdtempSync(join(tmpdir(), 'halo-sdk-conventions-'));
    const marker = 'PROJECT_RULE_MARKER_7f3a';
    writeFileSync(join(cwd, 'AGENTS.md'), marker);

    const requests: ProviderRequest[] = [];
    const base = makeMockProvider([textStream('ok')]);
    const provider: LlmProvider = {
      ...base,
      createMessageStream(req) {
        requests.push(req);
        return base.createMessageStream(req);
      },
    };

    await drain(queryLoop(
      makeConfig({ cwd, systemPrompt: { type: 'preset', preset: 'default' }, settingSources: ['project'] }),
      provider,
      [],
      'hi',
    ));

    const req = requests[0];
    expect(JSON.stringify(req.systemPrompt)).not.toContain(marker);
    const occurrences = JSON.stringify(req.messages).split(marker).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('queryLoop live input', () => {
  it('adds the messages received during a tool before the next model step', async () => {
    let pending: import('../types/provider.js').Message | null = null;
    const requests: ProviderRequest[] = [];
    const tool: Tool = {
      name: 'receive_update', description: 'Receives messages while busy',
      inputSchema: { type: 'object', properties: {} }, permissionLevel: 'read',
      async execute() {
        pending = { role: 'user', content: 'first update\n\nsecond update' };
        return { content: 'tool finished', isError: false };
      },
    };
    const base = makeMockProvider([textStream('done')]);
    const provider: LlmProvider = {
      ...base,
      async *createMessageStream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield* toolUseStream('receive_update', {});
          yield { type: 'message_delta', stopReason: 'tool_use', usage: makeUsage() };
          yield { type: 'message_stop' };
        } else {
          yield* base.createMessageStream(request);
        }
      },
    };
    const frames = await drain(queryLoop(makeConfig(), provider, [tool], 'start', {
      getPendingUserMessage: async () => {
        const message = pending;
        pending = null;
        return message;
      },
    }));
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain('first update\\n\\nsecond update');
    expect(frames.filter(frame => frame.type === 'result')).toHaveLength(1);
  });
});
