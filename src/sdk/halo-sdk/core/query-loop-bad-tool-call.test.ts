/**
 * What the model is told when its tool call cannot be used.
 *
 * The failure these tests guard against is not that a bad call is refused —
 * it is that it is refused with the wrong explanation. Substituting empty
 * arguments for a call that failed to parse makes the tool report a missing
 * parameter the model is certain it sent, so the model sends the same broken
 * call again.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { queryLoop } from './query-loop.js';
import type { SDKMessage } from './query-types.js';
import type {
  LlmProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  UsageInfo,
} from '../types/provider.js';
import type { QueryConfig } from '../types/config.js';
import type { Tool, ToolContext, ToolResult } from '../types/tool.js';

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

function makeUsage(): UsageInfo {
  return { input_tokens: 10, output_tokens: 20 };
}

function makeConfig(overrides: Partial<QueryConfig> = {}): QueryConfig {
  return {
    model: 'test-model',
    contextWindow: 200_000,
    maxTurns: 4,
    cwd: '/tmp',
    env: {},
    permissionMode: 'bypassPermissions',
    systemPrompt: 'test',
    thinking: { type: 'disabled' },
    abortSignal: new AbortController().signal,
    ...overrides,
  } as QueryConfig;
}

/** Records every call so a test can prove the tool never ran. */
function makeRecordingTool(): { tool: Tool; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const tool: Tool = {
    name: 'Read',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
      },
      required: ['file_path'],
    },
    permissionLevel: 'readonly',
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      calls.push(input);
      return { content: 'file contents', isError: false };
    },
  };
  return { tool, calls };
}

/** A turn that emits one tool_use block whose arguments are the given raw text. */
function toolCallStream(rawArguments: string): StreamEvent[] {
  return [
    { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: makeUsage() },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_bad', name: 'Read', input: {} },
    },
    { type: 'input_json_delta', index: 0, partialJson: rawArguments },
    { type: 'content_block_stop', index: 0 },
  ];
}

function textStream(text: string): StreamEvent[] {
  return [
    { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: makeUsage() },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'text_delta', index: 0, text },
    { type: 'content_block_stop', index: 0 },
  ];
}

function makeProvider(turns: StreamEvent[][], stopReason: 'tool_use' | 'end_turn' = 'tool_use'): LlmProvider {
  let index = 0;
  return {
    id: 'mock',
    name: 'Mock',
    capabilities: () => TEST_CAPS,
    async createMessage(): Promise<ProviderResponse> {
      throw new Error('not used');
    },
    async *createMessageStream(_req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
      const events = turns[Math.min(index, turns.length - 1)];
      const last = index >= turns.length - 1;
      index++;
      for (const event of events) yield event;
      yield {
        type: 'message_delta',
        stopReason: last ? 'end_turn' : stopReason,
        usage: makeUsage(),
      };
      yield { type: 'message_stop' };
    },
  };
}

async function drain(gen: AsyncGenerator<SDKMessage>, limit = 80): Promise<SDKMessage[]> {
  const msgs: SDKMessage[] = [];
  for await (const m of gen) {
    msgs.push(m);
    if (msgs.length >= limit) break;
  }
  return msgs;
}

/** The text of every tool_result the loop produced. */
function toolResults(msgs: SDKMessage[]): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.type !== 'user') continue;
    const content = (m as unknown as { message: { content: unknown } }).message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result') out.push(String(block.content));
    }
  }
  return out;
}

describe('queryLoop — arguments that could not be read', () => {
  it('tells the model its JSON was invalid instead of blaming a missing parameter', async () => {
    const { tool, calls } = makeRecordingTool();
    const provider = makeProvider([
      toolCallStream('{"file_path": "/tmp/a'),
      textStream('sorry'),
    ]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [tool], 'read it'));

    const results = toolResults(msgs);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('not valid JSON');
    expect(results[0]).not.toContain('file_path is required');
    expect(calls).toHaveLength(0);
  });

  it('echoes the fragment that arrived, so truncation is recognisable', async () => {
    const { tool } = makeRecordingTool();
    const provider = makeProvider([
      toolCallStream('{"file_path": "/tmp/somewhere'),
      textStream('ok'),
    ]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [tool], 'read it'));

    expect(toolResults(msgs)[0]).toContain('/tmp/somewhere');
  });

  it('still pairs a tool_result with the tool_use, so the next request is valid', async () => {
    const { tool } = makeRecordingTool();
    const provider = makeProvider([toolCallStream('{oops'), textStream('ok')]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [tool], 'read it'));

    const resultMsg = msgs.find(
      (m) =>
        m.type === 'user' &&
        Array.isArray((m as unknown as { message: { content: unknown } }).message.content),
    ) as unknown as { message: { content: Array<Record<string, unknown>> } };
    expect(resultMsg.message.content[0].tool_use_id).toBe('toolu_bad');
    expect(resultMsg.message.content[0].is_error).toBe(true);
  });

  it('rejects arguments that parse but are not an object', async () => {
    const { tool, calls } = makeRecordingTool();
    const provider = makeProvider([toolCallStream('["/tmp/a"]'), textStream('ok')]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [tool], 'read it'));

    expect(toolResults(msgs)[0]).toContain('not a JSON object');
    expect(calls).toHaveLength(0);
  });
});

describe('queryLoop — arguments that do not match the schema', () => {
  it('reports the mismatch and does not run the tool', async () => {
    const { tool, calls } = makeRecordingTool();
    const provider = makeProvider([
      toolCallStream('{"file_path": "/tmp/a", "offset": "10"}'),
      textStream('ok'),
    ]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [tool], 'read it'));

    const results = toolResults(msgs);
    expect(results[0]).toContain('"offset" must be number');
    expect(results[0]).toContain('received string');
    expect(calls).toHaveLength(0);
  });

  it('reports a missing required argument', async () => {
    const { tool, calls } = makeRecordingTool();
    const provider = makeProvider([toolCallStream('{"offset": 1}'), textStream('ok')]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [tool], 'read it'));

    expect(toolResults(msgs)[0]).toContain('"file_path" is required');
    expect(calls).toHaveLength(0);
  });

  it('runs the tool when the arguments are right', async () => {
    const { tool, calls } = makeRecordingTool();
    const provider = makeProvider([
      toolCallStream('{"file_path": "/tmp/a", "offset": 10}'),
      textStream('done'),
    ]);

    await drain(queryLoop(makeConfig(), provider, [tool], 'read it'));

    expect(calls).toEqual([{ file_path: '/tmp/a', offset: 10 }]);
  });
});

describe('queryLoop — a tool call that produced no call at all', () => {
  /** A turn that ends the way a prompt-protocol adapter reports a broken block. */
  function unreadableBlockTurn(reason: string): StreamEvent[] {
    return [
      { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: makeUsage() },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'text_delta', index: 0, text: 'calling the tool now' },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() },
      { type: 'message_stop', unreadableToolCall: reason },
    ];
  }

  /** Provider that emits raw turns verbatim, including its own message_stop. */
  function makeRawProvider(turns: StreamEvent[][]): { provider: LlmProvider; turnCount: () => number } {
    let index = 0;
    const provider: LlmProvider = {
      id: 'raw',
      name: 'Raw',
      capabilities: () => TEST_CAPS,
      async createMessage(): Promise<ProviderResponse> {
        throw new Error('not used');
      },
      async *createMessageStream(): AsyncGenerator<StreamEvent, void, undefined> {
        const events = turns[Math.min(index, turns.length - 1)];
        index++;
        for (const event of events) yield event;
      },
    };
    return { provider, turnCount: () => index };
  }

  it('asks the model to resend rather than ending the turn on prose', async () => {
    const { provider, turnCount } = makeRawProvider([
      unreadableBlockTurn('a ```json tool-call block that was not valid JSON'),
      [
        { type: 'message_start', id: 'm2', model: 'test-model', usage: makeUsage() },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'text_delta', index: 0, text: 'here is the answer' },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() },
        { type: 'message_stop' },
      ],
    ]);

    await drain(queryLoop(makeConfig(), provider, [], 'do it'));

    expect(turnCount()).toBe(2);
  });

  it('gives up after a bounded number of attempts', async () => {
    const { provider, turnCount } = makeRawProvider([
      unreadableBlockTurn('a ```json tool-call block that was not valid JSON'),
    ]);

    await drain(queryLoop(makeConfig({ maxTurns: 10 }), provider, [], 'do it'));

    // One original turn plus the retry limit, then the loop stops re-prompting.
    expect(turnCount()).toBe(3);
  });
});
