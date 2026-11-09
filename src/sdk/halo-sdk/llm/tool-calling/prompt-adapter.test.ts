/**
 * Tests for llm/tool-calling/prompt-adapter.ts
 * @license MIT
 */

import { describe, it, expect, vi } from 'vitest';
import { PromptToolCallingAdapter } from './prompt-adapter.js';
import type {
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderCapabilities,
  StreamEvent,
  ToolDefinition,
} from '../../types/provider.js';

// ---------------------------------------------------------------------------
// Mock provider helpers
// ---------------------------------------------------------------------------

function mockCapabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    streaming: true,
    toolCalling: false,
    thinking: false,
    imageInput: false,
    pdfInput: false,
    audioInput: false,
    videoInput: false,
    caching: false,
    systemPromptStyle: 'top_level',
    ...overrides,
  };
}

function makeResponse(text: string, overrides: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    id: 'resp_001',
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'test-model',
    ...overrides,
  };
}

function makeMockProvider(
  responseText: string,
  overrides: Partial<LlmProvider> = {},
): LlmProvider {
  return {
    id: 'mock',
    name: 'MockProvider',
    capabilities: () => mockCapabilities(),
    createMessage: vi.fn().mockResolvedValue(makeResponse(responseText)),
    createMessageStream: async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      yield { type: 'message_start', id: 'msg_001', model: 'test', usage: { input_tokens: 5, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'text_delta', index: 0, text: responseText };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn' };
      yield { type: 'message_stop' };
    },
    ...overrides,
  };
}

const BASH_TOOL: ToolDefinition = {
  name: 'Bash',
  description: 'Execute a shell command.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command' },
    },
    required: ['command'],
  },
};

const BASE_REQUEST: ProviderRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'List files' }],
  maxTokens: 1000,
  stream: true,
};

// ---------------------------------------------------------------------------
// Constructor & metadata
// ---------------------------------------------------------------------------

describe('PromptToolCallingAdapter — constructor', () => {
  it('sets id as inner.id:mode', () => {
    const adapter = new PromptToolCallingAdapter(makeMockProvider(''), 'xml');
    expect(adapter.id).toBe('mock:xml');
  });

  it('sets name as inner.name (mode)', () => {
    const adapter = new PromptToolCallingAdapter(makeMockProvider(''), 'xml');
    expect(adapter.name).toBe('MockProvider (xml)');
  });
});

// ---------------------------------------------------------------------------
// capabilities()
// ---------------------------------------------------------------------------

describe('PromptToolCallingAdapter — capabilities', () => {
  it('inherits inner capabilities but forces toolCalling: true', () => {
    const inner = makeMockProvider('');
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const caps = adapter.capabilities();
    expect(caps.toolCalling).toBe(true);
    expect(caps.streaming).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createMessage — no tools (pass-through)
// ---------------------------------------------------------------------------

describe('PromptToolCallingAdapter — createMessage — no tools', () => {
  it('delegates directly to inner when request has no tools', async () => {
    const inner = makeMockProvider('Hello!');
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const response = await adapter.createMessage({ ...BASE_REQUEST, tools: [] });
    expect(inner.createMessage).toHaveBeenCalledOnce();
    expect(response.content[0]).toMatchObject({ type: 'text', text: 'Hello!' });
  });

  it('delegates when tools is undefined', async () => {
    const inner = makeMockProvider('Hello!');
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const response = await adapter.createMessage({ ...BASE_REQUEST, tools: undefined });
    expect(inner.createMessage).toHaveBeenCalledOnce();
    expect(response.stopReason).toBe('end_turn');
  });
});

// ---------------------------------------------------------------------------
// createMessage — with tools, no tool call in response
// ---------------------------------------------------------------------------

describe('PromptToolCallingAdapter — createMessage — plain text response', () => {
  it('forwards tool-result images to an image-capable inner provider', async () => {
    const inner = makeMockProvider('ok', { capabilities: () => mockCapabilities({ imageInput: true }) });
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'aGk=' } };
    await adapter.createMessage({ ...BASE_REQUEST, tools: [BASH_TOOL], messages: [{ role: 'user', content: [{
      type: 'tool_result', tool_use_id: 'shot', content: [{ type: 'text', text: 'screenshot' }, image],
    }] }] });
    const forwarded = vi.mocked(inner.createMessage).mock.calls[0][0].messages[0].content;
    expect(forwarded).toEqual([{ type: 'text', text: '[Tool Result: shot]\nscreenshot' }, image]);
  });

  it('fails explicitly when the inner provider cannot accept tool-result images', async () => {
    const inner = makeMockProvider('ok');
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    await expect(adapter.createMessage({ ...BASE_REQUEST, tools: [BASH_TOOL], messages: [{ role: 'user', content: [{
      type: 'tool_result', tool_use_id: 'shot', content: [{
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
      }],
    }] }] })).rejects.toThrow(/cannot accept images/);
    expect(inner.createMessage).not.toHaveBeenCalled();
  });

  it('returns plain text response unchanged when no XML tool calls', async () => {
    const inner = makeMockProvider('Sure, I can help!');
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const response = await adapter.createMessage({ ...BASE_REQUEST, tools: [BASH_TOOL] });
    expect(response.stopReason).toBe('end_turn');
    expect(response.content.some((b) => b.type === 'tool_use')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createMessage — with tool call in response
// ---------------------------------------------------------------------------

describe('PromptToolCallingAdapter — createMessage — tool call parsed', () => {
  it('parses BFCL-style XML tool call into ToolUseBlock', async () => {
    const xml = '<Bash>\n<param name="command" type="string" required="true">ls -la</param>\n</Bash>';
    const inner = makeMockProvider(`I will list files.\n\n${xml}`);
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const response = await adapter.createMessage({ ...BASE_REQUEST, tools: [BASH_TOOL] });

    const toolBlocks = response.content.filter((b) => b.type === 'tool_use');
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toMatchObject({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'ls -la' },
    });
  });

  it('parses legacy-style XML tool call into ToolUseBlock (backward compat)', async () => {
    const xml = '<Bash>\n<command>ls -la</command>\n</Bash>';
    const inner = makeMockProvider(`I will list files.\n\n${xml}`);
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const response = await adapter.createMessage({ ...BASE_REQUEST, tools: [BASH_TOOL] });

    const toolBlocks = response.content.filter((b) => b.type === 'tool_use');
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toMatchObject({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'ls -la' },
    });
  });

  it('sets stopReason to tool_use', async () => {
    const xml = '<Bash>\n<param name="command" type="string" required="true">ls</param>\n</Bash>';
    const inner = makeMockProvider(xml);
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const response = await adapter.createMessage({ ...BASE_REQUEST, tools: [BASH_TOOL] });
    expect(response.stopReason).toBe('tool_use');
  });

  it('generates a unique id for each tool use block', async () => {
    const xml = '<Bash>\n<param name="command" type="string" required="true">ls</param>\n</Bash>';
    const inner = makeMockProvider(xml);
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const response = await adapter.createMessage({ ...BASE_REQUEST, tools: [BASH_TOOL] });
    const toolBlock = response.content.find((b) => b.type === 'tool_use') as { id: string };
    expect(toolBlock.id).toMatch(/^toolu_/);
  });

  it('injects tool descriptions into system prompt (inner receives no tools)', async () => {
    let capturedRequest: ProviderRequest | null = null;
    const inner = makeMockProvider('<Bash>\n<param name="command" type="string" required="true">ls</param>\n</Bash>');
    (inner.createMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: ProviderRequest) => {
        capturedRequest = req;
        return makeResponse('<Bash>\n<param name="command" type="string" required="true">ls</param>\n</Bash>');
      },
    );
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    await adapter.createMessage({ ...BASE_REQUEST, tools: [BASH_TOOL], systemPrompt: 'System.' });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.tools).toBeUndefined();
    const sp = capturedRequest!.systemPrompt as string;
    expect(sp).toContain('System.');
    expect(sp).toContain('## Bash');
  });
});

// ---------------------------------------------------------------------------
// createMessageStream — tool call parsed from stream
// ---------------------------------------------------------------------------

describe('PromptToolCallingAdapter — createMessageStream', () => {
  async function collectEvents(
    gen: AsyncGenerator<StreamEvent, void, undefined>,
  ): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of gen) {
      events.push(event);
    }
    return events;
  }

  it('passes through stream unchanged when no tools', async () => {
    const inner = makeMockProvider('Hello!');
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const events = await collectEvents(
      adapter.createMessageStream({ ...BASE_REQUEST, tools: [] }),
    );
    const stopEvent = events.find((e) => e.type === 'message_stop');
    expect(stopEvent).toBeDefined();
    const deltaEvent = events.find((e) => e.type === 'message_delta') as { type: 'message_delta'; stopReason?: string };
    expect(deltaEvent?.stopReason).toBe('end_turn');
  });

  it('emits tool_use content_block_start events after parsing', async () => {
    const xml = '<Bash>\n<param name="command" type="string" required="true">ls</param>\n</Bash>';
    const inner = makeMockProvider(xml);
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const events = await collectEvents(
      adapter.createMessageStream({ ...BASE_REQUEST, tools: [BASH_TOOL] }),
    );

    const toolStartEvents = events.filter(
      (e) => e.type === 'content_block_start' && 'content_block' in e && (e as { content_block: { type: string } }).content_block.type === 'tool_use',
    );
    expect(toolStartEvents).toHaveLength(1);
  });

  it('emits message_delta with stopReason tool_use when tool call found', async () => {
    const xml = '<Bash>\n<param name="command" type="string" required="true">ls</param>\n</Bash>';
    const inner = makeMockProvider(xml);
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const events = await collectEvents(
      adapter.createMessageStream({ ...BASE_REQUEST, tools: [BASH_TOOL] }),
    );

    const deltaEvent = events.find((e) => e.type === 'message_delta') as { type: 'message_delta'; stopReason?: string } | undefined;
    expect(deltaEvent?.stopReason).toBe('tool_use');
  });

  it('discards failed-attempt tool text and deferred usage on retry', async () => {
    const inner = makeMockProvider('', {
      async *createMessageStream() {
        yield { type: 'message_start', id: 'failed', model: 'test', usage: { input_tokens: 1, output_tokens: 0 } };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: '<Bash><command>should not run</command></Bash>' };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'tool_use', usage: { input_tokens: 999 } };
        yield { type: 'retry', attempt: 1, maxRetries: 10, status: 503, delayMs: 1, message: 'retry' };
        yield { type: 'message_start', id: 'success', model: 'test', usage: { input_tokens: 2, output_tokens: 0 } };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: 'recovered' };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn', usage: { output_tokens: 3 } };
        yield { type: 'message_stop' };
      },
    });
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const events = await collectEvents(adapter.createMessageStream({ ...BASE_REQUEST, tools: [BASH_TOOL] }));
    expect(events.some((event) => event.type === 'content_block_start' && event.content_block.type === 'tool_use')).toBe(false);
    expect(events.filter((event) => event.type === 'message_delta')).toEqual([
      { type: 'message_delta', stopReason: 'end_turn', usage: { output_tokens: 3 } },
    ]);
  });

  it('merges a separate usage tail without losing the finish reason', async () => {
    const inner = makeMockProvider('', {
      async *createMessageStream() {
        yield { type: 'message_start', id: 'm', model: 'test', usage: { input_tokens: 0, output_tokens: 0 } };
        yield { type: 'message_delta', stopReason: 'max_tokens', usage: { output_tokens: 3 } };
        yield { type: 'message_delta', usage: { input_tokens: 9 } };
        yield { type: 'message_stop' };
      },
    });
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const events = await collectEvents(adapter.createMessageStream({ ...BASE_REQUEST, tools: [BASH_TOOL] }));
    expect(events).toContainEqual({ type: 'message_delta', stopReason: 'max_tokens', usage: { input_tokens: 9, output_tokens: 3 } });
  });

  it('always emits message_stop as final event', async () => {
    const xml = '<Bash>\n<param name="command" type="string" required="true">ls</param>\n</Bash>';
    const inner = makeMockProvider(xml);
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const events = await collectEvents(
      adapter.createMessageStream({ ...BASE_REQUEST, tools: [BASH_TOOL] }),
    );

    expect(events[events.length - 1].type).toBe('message_stop');
  });

  it('passes through plain text response in stream unchanged', async () => {
    const inner = makeMockProvider('No tools called here.');
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const events = await collectEvents(
      adapter.createMessageStream({ ...BASE_REQUEST, tools: [BASH_TOOL] }),
    );

    const toolEvents = events.filter(
      (e) => e.type === 'content_block_start' && 'content_block' in e && (e as { content_block: { type: string } }).content_block.type === 'tool_use',
    );
    expect(toolEvents).toHaveLength(0);

    const deltaEvent = events.find((e) => e.type === 'message_delta') as { stopReason?: string } | undefined;
    expect(deltaEvent?.stopReason).not.toBe('tool_use');
  });
});

// ---------------------------------------------------------------------------
// Dual-format parsing (parseDualTools)
// ---------------------------------------------------------------------------

describe('PromptToolCallingAdapter — dual-format parsing', () => {
  // Model output: correct JSON fence + empty XML tag (the GLM-5 scenario)
  const DUAL_OUTPUT =
    '用户想要执行 ls 命令。\n\n' +
    '```json\n' +
    '[{"name": "Bash", "params": {"command": "ls"}}]\n' +
    '```\n\n' +
    '<Bash>\n</Bash>';

  it('picks JSON over empty XML in xml mode (GLM-5 scenario)', async () => {
    const inner = makeMockProvider(DUAL_OUTPUT);
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const response = await adapter.createMessage({ ...BASE_REQUEST, tools: [BASH_TOOL] });

    const toolBlocks = response.content.filter((b) => b.type === 'tool_use');
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toMatchObject({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('picks XML over empty JSON in json mode (reverse scenario)', async () => {
    const text =
      '```json\n[{"name": "Bash", "params": {}}]\n```\n\n' +
      '<Bash>\n<param name="command" type="string" required="true">ls</param>\n</Bash>';
    const inner = makeMockProvider(text);
    const adapter = new PromptToolCallingAdapter(inner, 'json');
    const response = await adapter.createMessage({ ...BASE_REQUEST, tools: [BASH_TOOL] });

    const toolBlocks = response.content.filter((b) => b.type === 'tool_use');
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toMatchObject({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('routes through dual parsing in stream path too', async () => {
    const inner = makeMockProvider(DUAL_OUTPUT);
    const adapter = new PromptToolCallingAdapter(inner, 'xml');
    const events: StreamEvent[] = [];
    for await (const event of adapter.createMessageStream({ ...BASE_REQUEST, tools: [BASH_TOOL] })) {
      events.push(event);
    }

    const toolStartEvents = events.filter(
      (e) => e.type === 'content_block_start' && 'content_block' in e
        && (e as { content_block: { type: string } }).content_block.type === 'tool_use',
    );
    expect(toolStartEvents).toHaveLength(1);

    const deltaEvent = events.find((e) => e.type === 'message_delta') as { stopReason?: string } | undefined;
    expect(deltaEvent?.stopReason).toBe('tool_use');
  });
});
