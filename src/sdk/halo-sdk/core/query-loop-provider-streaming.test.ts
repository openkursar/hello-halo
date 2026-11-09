import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../llm/anthropic.js';
import { OpenAiCompatProvider } from '../llm/openai-compat.js';
import type { Tool } from '../types/tool.js';
import { queryLoop } from './query-loop.js';
import { resolveQueryConfig } from './context.js';
import type { SDKMessage } from './query-types.js';

afterEach(() => vi.unstubAllGlobals());

describe('native provider output allowances', () => {
  it.each(['anthropic', 'openai'] as const)('corrects a pre-content HTTP refusal through the real %s adapter', async protocol => {
    const bodies: Record<string, any>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: 'max_tokens must be between 1 and 393216' } }), { status: 400 });
      const events = protocol === 'anthropic' ? [
        { type: 'message_start', message: { id: 'done', model: 'fixture', usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Complete.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ] : [
        { id: 'done', model: 'fixture', choices: [{ delta: { role: 'assistant', content: 'Complete.' }, finish_reason: null }] },
        { id: 'done', model: 'fixture', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (protocol === 'openai' ? 'data: [DONE]\n\n' : ''),
        { headers: { 'Content-Type': 'text/event-stream' } });
    }));
    const provider = protocol === 'anthropic' ? new AnthropicProvider({ apiKey: 'fixture-only' })
      : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid', apiKey: 'fixture-only' });
    const cfg = resolveQueryConfig({ model: 'fixture', cwd: '/tmp', systemPrompt: 'Fixture', settingSources: [],
      contextWindow: 1_000_000, maxOutputTokens: 640_000, thinking: { type: 'disabled' },
      turnEndChecks: { openWork: false, completion: false } });
    const events: SDKMessage[] = [];
    for await (const event of queryLoop(cfg, provider, [], 'Hello.')) events.push(event);
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(bodies.map(body => body.max_tokens)).toEqual([640_000, 393_216]);
    expect(bodies[1].messages).toEqual(bodies[0].messages);
    expect(cfg.maxTokens).toBe(640_000);
  });

  it.each(['text', 'thinking', 'tool_use'] as const)('does not replay a summary when the Anthropic stream fails after %s starts', async kind => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      const block = kind === 'tool_use' ? { type: kind, id: 'never-run', name: 'work', input: {} }
        : kind === 'thinking' ? { type: kind, thinking: '' } : { type: kind, text: '' };
      const events = [
        { type: 'message_start', message: { id: 'partial', model: 'fixture', usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens must be between 1 and 2048' } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    }));
    const cfg = resolveQueryConfig({ model: 'fixture', cwd: '/tmp', systemPrompt: 'Fixture', settingSources: [],
      contextWindow: 40_000, maxOutputTokens: 300, thinking: { type: 'disabled' },
      turnEndChecks: { openWork: false, completion: false } });
    const history = Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `Record ${index}: ${'verified evidence '.repeat(300)}` }));
    const checkpoint = vi.fn();
    const events: SDKMessage[] = [];
    for await (const event of queryLoop(cfg, new AnthropicProvider({ apiKey: 'fixture-only' }), [], history, { onCompact: checkpoint })) events.push(event);
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(calls).toBe(1);
    expect(checkpoint).not.toHaveBeenCalled();
  });
});

describe('native provider streaming execution', () => {
  it.each([false, true])('executes before the HTTP stream ends and avoids replay after interruption=%s', async interrupted => {
    let release!: () => void;
    const executed = new Promise<void>(resolve => { release = resolve; });
    const encoder = new TextEncoder();
    let requests = 0;
    let ended = false;
    const execute = vi.fn(async () => {
      expect(ended).toBe(false);
      release();
      return { content: 'Saved exactly once.', isError: false };
    });
    const fixture: Tool = { name: 'SaveFixture', description: 'Fixture', permissionLevel: 'write',
      inputSchema: { type: 'object' }, isConcurrencySafe: () => false, execute };
    vi.stubGlobal('fetch', vi.fn(async () => {
      const first = requests++ === 0;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          emit({ type: 'message_start', message: { id: `response-${requests}`, model: 'fixture',
            usage: { input_tokens: 20, output_tokens: 0 } } });
          if (first) {
            emit({ type: 'content_block_start', index: 0,
              content_block: { type: 'tool_use', id: 'save-1', name: fixture.name, input: {} } });
            emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } });
            emit({ type: 'content_block_stop', index: 0 });
            await executed;
            // Yield a complete tool result before terminating the transport.
            await new Promise<void>(resolve => setImmediate(resolve));
            if (interrupted) { controller.close(); return; }
          } else {
            emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Complete.' } });
            emit({ type: 'content_block_stop', index: 0 });
          }
          ended = true;
          emit({ type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: 10 } });
          emit({ type: 'message_stop' });
          controller.close();
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }));
    const config = resolveQueryConfig({ model: 'fixture', cwd: '/tmp', systemPrompt: 'Fixture',
      settingSources: [], permissionMode: 'bypassPermissions', maxTurns: 3,
      thinking: { type: 'disabled' }, turnEndChecks: { openWork: false, completion: false } });
    const messages: SDKMessage[] = [];
    for await (const message of queryLoop(config, new AnthropicProvider({ apiKey: 'fixture-only' }), [fixture], 'Save.')) {
      messages.push(message);
    }
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toBe(interrupted ? 1 : 2);
    expect(messages.at(-1)).toMatchObject({ type: 'result', is_error: interrupted });
    const results = messages.flatMap(message => message.type === 'user' ? message.message.content : [])
      .filter(block => block.type === 'tool_result');
    expect(results).toEqual([expect.objectContaining({ content: 'Saved exactly once.' })]);
  }, 2000);
});
