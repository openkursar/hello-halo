import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryLoop, createSession } from '../index.js';
import { getTranscriptPath } from './transcript.js';
import { AnthropicProvider } from '../llm/anthropic.js';
import { OpenAiCompatProvider } from '../llm/openai-compat.js';
import type { QueryConfig } from '../types/config.js';
import type { SDKAssistantMessage, SDKMessage } from './query-types.js';
import type { ContentBlock, ProviderRequest } from '../types/provider.js';
import type { Tool } from '../types/tool.js';

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of servers.splice(0)) await close();
});

/**
 * The loop calls its HTTP adapters from Rust, where a JavaScript `fetch` stub
 * cannot observe or script requests, so these cases serve bytes from a loopback server.
 */
async function loopback(handler: (request: { body: any; call: number; response: ServerResponse }) => Promise<void> | void) {
  let call = 0;
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      bodies.push(body);
      await handler({ body, call: call++, response });
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  servers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies };
}

function sse(response: ServerResponse, events: unknown[]) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

const goal: Tool = {
  name: 'RecordAnswer', description: 'Record the answer.',
  inputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
  permissionLevel: 'none', execute: async () => ({ content: 'Recorded', isError: false }),
};

type FixtureFrame = {
  type: 'assistant' | 'stream_event';
  message?: SDKAssistantMessage['message'];
  event?: Record<string, unknown>;
};

const initialUsage = { input_tokens: 11, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 3 };
const finalUsage = { ...initialUsage, output_tokens: 19 };
const answer: ContentBlock = { type: 'text', text: '1+3 = 4' };
const toolCall: ContentBlock = { type: 'tool_use', id: 'tool_1', name: goal.name, input: { answer: '4' } };
const done: ContentBlock = { type: 'text', text: 'Done' };
const thinking: ContentBlock = { type: 'thinking', thinking: 'Check the sum.', signature: 'test-signature' };

function assistant(id: string, content: ContentBlock[], complete = false): FixtureFrame {
  return { type: 'assistant', message: {
    id, type: 'message', role: 'assistant', model: 'test-model', content,
    stop_reason: complete ? 'tool_use' : null, stop_sequence: null,
    usage: complete ? finalUsage : initialUsage,
  } };
}

function response(id: string, content: ContentBlock[]): FixtureFrame[] {
  const stream = (event: Record<string, unknown>): FixtureFrame => ({ type: 'stream_event', event });
  const frames = [stream({ type: 'message_start', message: assistant(id, []).message })];
  for (const [index, block] of content.entries()) {
    if (block.type === 'text') {
      frames.push(stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
        stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }));
    } else if (block.type === 'thinking') {
      frames.push(stream({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }),
        stream({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }),
        stream({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }));
    } else if (block.type === 'tool_use') {
      frames.push(stream({ type: 'content_block_start', index, content_block: { ...block, input: {} } }),
        stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }));
    } else {
      throw new Error(`Unsupported fixture block: ${block.type}`);
    }
    frames.push(assistant(id, [block]), stream({ type: 'content_block_stop', index }));
  }
  frames.push(stream({ type: 'message_delta', delta: {
    stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
  }, usage: { output_tokens: 19 } }), stream({ type: 'message_stop' }));
  return frames;
}

function scenarios(frames: FixtureFrame[]) {
  return [true, false].map(includePartialMessages => ({
    includePartialMessages,
    frames: includePartialMessages ? frames : frames.filter(frame => frame.type === 'assistant'),
  }));
}

const fixture = {
  responses: [
    ...scenarios([...response('msg_1', [answer, toolCall]), ...response('msg_2', [done])]).map(run => ({ ...run, retry: false })),
    ...scenarios([
      ...response('msg_1', [answer]).slice(0, -2),
      assistant('msg_2', [answer], true), assistant('msg_2', [toolCall], true),
      ...response('msg_3', [done]),
    ]).map(run => ({ ...run, retry: true })),
  ],
  thinking: scenarios([...response('msg_1', [thinking, answer, toolCall]), ...response('msg_2', [thinking, done])]),
};

function config(includePartialMessages = true): QueryConfig {
  return {
    model: 'test-model', contextWindow: 200_000, maxTokens: 2048,
    maxTurns: 4, cwd: tmpdir(), env: {}, permissionMode: 'bypassPermissions',
    systemPrompt: 'Protocol test.', thinking: { type: 'disabled' },
    abortSignal: new AbortController().signal, includePartialMessages,
  } as QueryConfig;
}

async function replay(frames: Array<{ type: string; event?: unknown }>) {
  const responses: unknown[][] = [];
  let events: unknown[] = [];
  for (const frame of frames) {
    if (frame.type !== 'stream_event') continue;
    const event = frame.event as { type: string };
    events.push(event);
    if (event.type === 'message_stop') { responses.push(events); events = []; }
  }
  const requests: ProviderRequest[] = [];
  const endpoint = await loopback(({ call, body, response }) => {
    requests.push(body as ProviderRequest);
    sse(response, responses[Math.min(call, responses.length - 1)]);
  });
  return { provider: new AnthropicProvider({ apiKey: 'fixture', baseUrl: endpoint.url }), requests };
}

async function collect(stream: AsyncIterable<SDKMessage>) {
  const messages: SDKMessage[] = [];
  for await (const message of stream) messages.push(structuredClone(message));
  return messages;
}

function assistants(messages: Array<{ type: string; message?: unknown }>) {
  return messages.filter(message => message.type === 'assistant').map(message => message.message);
}

function sequence(messages: Array<{ type: string; event?: unknown }>) {
  return messages.flatMap(message => {
    if (message.type === 'assistant') return ['assistant'];
    if (message.type !== 'stream_event') return [];
    const event = message.event as { type: string; index?: number };
    return [`${event.type}:${event.index ?? ''}`];
  });
}


describe('assistant block delivery', () => {
  for (const expected of fixture.responses.filter(run => !run.retry)) {
    it(`emits completed blocks at their boundaries with partial=${expected.includePartialMessages}`, async () => {
      const { provider, requests } = await replay(fixture.responses[0].frames);
      const complete: SDKAssistantMessage[] = [];
      const messages = await collect(queryLoop(config(expected.includePartialMessages), provider, [goal], '1+3', {
        onAssistantMessage: message => { complete.push(message); },
      }));
      expect(assistants(messages)).toEqual(assistants(expected.frames));
      expect(sequence(messages)).toEqual(sequence(expected.frames));
      const blocks = messages.filter(message => message.type === 'assistant');
      expect(new Set(blocks.map(message => message.uuid)).size).toBe(blocks.length);
      expect(complete).toHaveLength(2);
      expect(complete[0].message.content.map(block => block.type)).toEqual(['text', 'tool_use']);
      expect(complete[0].message.usage).toMatchObject({ input_tokens: 11, output_tokens: 19 });
      expect(requests[1].messages.filter(message => message.role === 'assistant')).toHaveLength(1);
      expect(requests[1].messages.find(message => message.role === 'assistant')?.content).toEqual(complete[0].message.content);
      expect(messages.find(message => message.type === 'result')).toMatchObject({
        result: 'Done', usage: { input_tokens: 22, output_tokens: 38, cache_read_input_tokens: 6 },
      });
    });
  }

  it('preserves thinking signatures and initial usage at each block boundary', async () => {
    const expected = fixture.thinking[0];
    const { provider } = await replay(expected.frames);
    const messages = await collect(queryLoop(config(), provider, [goal], '1+3'));
    expect(assistants(messages)).toEqual(assistants(expected.frames));
    expect(sequence(messages)).toEqual(sequence(expected.frames));
    for (const run of fixture.thinking) {
      const frames = run.frames.filter(frame => frame.type === 'assistant');
      expect(frames.map(frame => frame.message?.content.map(block => block.type))).toEqual([
        ['thinking'], ['text'], ['tool_use'], ['thinking'], ['text'],
      ]);
      expect(frames[0].message?.id).toBe(frames[2].message?.id);
    }
  });

  it('keeps repeated text blocks and their original position in history', async () => {
    const frames = structuredClone(fixture.responses[0].frames) as FixtureFrame[];
    const firstStop = frames.findIndex(frame => frame.event?.type === 'message_delta');
    frames.splice(firstStop, 0,
      { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Recorded next.' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },
    );
    const { provider, requests } = await replay(frames);
    const messages = await collect(queryLoop(config(), provider, [goal], '1+3'));
    const content = (assistants(messages) as SDKAssistantMessage['message'][]).slice(0, 3).map(message => message.content);
    expect(content.map(blocks => blocks[0].type)).toEqual(['text', 'tool_use', 'text']);
    expect(content[2]).toEqual([{ type: 'text', text: 'Recorded next.' }]);
    expect(requests[1].messages.find(message => message.role === 'assistant')?.content).toEqual(content.flat());
  });

  it('journals completed blocks and resumes one coalesced message per response across session turns', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sdk-block-history-'));
    const env = { SDK_TEST_CONFIG_DIR: join(cwd, 'config') };
    const conventions = { configDirEnv: 'SDK_TEST_CONFIG_DIR' };
    const { provider, requests } = await replay(fixture.thinking[0].frames);
    const options = {
      provider, model: config().model, cwd, env, conventions, includePartialMessages: true,
      systemPrompt: 'Protocol test.', tools: [] as string[], maxTurns: 1, settingSources: [],
    };
    const session = await createSession(options);
    let resumed: Awaited<ReturnType<typeof createSession>> | undefined;
    try {
      await session.send('1+3');
      const messages = await collect(session.stream());
      expect((assistants(messages) as SDKAssistantMessage['message'][]).map(message => message.content[0].type))
        .toEqual(['thinking', 'text', 'tool_use']);
      await session.send('Continue');
      const continued = await collect(session.stream());
      await session.flush();
      const transcript = (await readFile(getTranscriptPath(session.sessionId, cwd, { env, conventions }), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line));
      const stored = transcript.filter(entry => entry.type === 'assistant');
      expect(stored).toHaveLength(5);
      expect(stored.map(entry => entry.message.content.length)).toEqual([1, 1, 1, 1, 1]);
      expect(stored.map(entry => entry.uuid)).toEqual([...messages, ...continued]
        .filter(message => message.type === 'assistant').map(message => message.uuid));
      const responseGroups = new Map<string, ContentBlock[]>();
      for (const entry of stored) {
        expect(entry.responseUuid).toEqual(expect.any(String));
        const content = responseGroups.get(entry.responseUuid) ?? [];
        content.push(...entry.message.content);
        responseGroups.set(entry.responseUuid, content);
      }
      expect(responseGroups.size).toBe(2);
      expect([...responseGroups.values()]).toEqual([[thinking, answer, toolCall], [thinking, done]]);
      const previous = requests[1].messages.filter(message => message.role === 'assistant');
      expect(previous).toHaveLength(1);
      expect(Object.keys(previous[0]).sort()).toEqual(['content', 'role']);
      await session[Symbol.asyncDispose]();
      resumed = await createSession({ ...options, resume: session.sessionId });
      await resumed.send('Continue again');
      await collect(resumed.stream());
      const history = requests.at(-1)!.messages.filter(message => message.role === 'assistant');
      expect(history).toHaveLength(2);
      expect(history.map(message => message.content)).toEqual([...responseGroups.values()]);
    } finally {
      await resumed?.[Symbol.asyncDispose]();
      await session[Symbol.asyncDispose]();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('completed blocks around a provider retry', () => {
  it.each([true, false])('retains published blocks and failed usage without persisting failed content with partial=%s', async partial => {
    const expected = fixture.responses.find(run => run.retry && run.includePartialMessages === partial)!;
    const streamed = fixture.responses.find(run => run.retry && run.includePartialMessages)!;
    const initial = streamed.frames.filter(frame => frame.type === 'stream_event').slice(0, 4)
      .map(frame => frame.event);
    const recovered = (assistants(expected.frames) as SDKAssistantMessage['message'][])
      .filter(message => message.id === 'msg_2');
    const body = { ...recovered[0], content: recovered.flatMap(message => message.content) };
    const tail = streamed.frames.filter(frame => frame.type === 'stream_event').slice(4).map(frame => frame.event);
    const endpoint = await loopback(({ call, response }) => {
      if (call === 0) return sse(response, initial);
      if (call === 1) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
        return;
      }
      return sse(response, tail);
    });
    const complete: SDKAssistantMessage[] = [];
    const execute = vi.fn(goal.execute);
    const provider = new AnthropicProvider({ apiKey: 'fixture', baseUrl: endpoint.url });
    const messages = await collect(queryLoop(config(partial), provider, [{ ...goal, execute }], '1+3', {
      onAssistantMessage: message => { complete.push(message); },
    }));
    expect(assistants(messages)).toEqual(assistants(expected.frames));
    expect(complete.map(message => message.message.id)).toEqual(['msg_2', 'msg_3']);
    expect(complete.every(message => message.message.content.length > 0)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(messages.find(message => message.type === 'result')).toMatchObject({
      result: 'Done', usage: { input_tokens: 33, output_tokens: 39, cache_read_input_tokens: 9 },
    });
  });
});


describe('OpenAI reasoning and text boundaries', () => {
  it.each([true, false])('completes prose before opening a tool with partial=%s', async partial => {
    const endpoint = await loopback(({ response }) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end([
        { id: 'openai_1', model: 'deepseek-test', choices: [{ delta: { reasoning_content: 'Add the numbers.' } }] },
        { choices: [{ delta: { content: '1+3 = 4' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool_1', function: { name: goal.name, arguments: '{"answer":"4"}' } }] } }] },
        { choices: [{ finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 31, completion_tokens: 17 } },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
    const provider = new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', apiKey: 'fixture', baseUrl: `${endpoint.url}/v1` });
    const complete: SDKAssistantMessage[] = [];
    const messages = await collect(queryLoop({ ...config(partial), maxTurns: 1 }, provider, [goal], '1+3', {
      onAssistantMessage: message => { complete.push(message); },
    }));
    expect((assistants(messages) as SDKAssistantMessage['message'][]).map(message => message.content[0].type))
      .toEqual(['thinking', 'text', 'tool_use']);
    expect(complete).toHaveLength(1);
    expect(complete[0].message.usage).toMatchObject({ input_tokens: 31, output_tokens: 17 });
    if (partial) {
      const textAt = messages.findIndex(message => message.type === 'assistant' && message.message.content[0].type === 'text');
      const toolAt = messages.findIndex(message => message.type === 'stream_event' && message.event.type === 'content_block_start' && message.event.content_block.type === 'tool_use');
      expect(textAt).toBeLessThan(toolAt);
      expect(messages.filter(message => message.type === 'stream_event' && message.event.type === 'message_delta').at(-1))
        .toMatchObject({ event: { usage: { input_tokens: 31, output_tokens: 17 } } });
    }
  });
});
