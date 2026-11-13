import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSession, query, createSdkMcpServer, tool, type SDKSession } from '../index.js';
import type { ContentBlock, LlmProvider, ProviderRequest, StreamEvent } from '../types/provider.js';
import type { Options } from '../types/config.js';
import type { SDKMessage } from './query-types.js';
import { getTranscriptPath } from './transcript.js';

const sessions: SDKSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input });
const search = (id = 'search', name = 'lookup') => use(id, 'ToolSearch', { query: `select:mcp__crm__${name}` });
const invoke = (id = 'invoke', args = '{ "customer": "42" }') => use(id, 'CallTool', { tool: 'mcp__crm__lookup', arguments: args });
const done: ContentBlock = { type: 'text', text: 'Done.' };

function provider(replies: ContentBlock[][]) {
  const requests: ProviderRequest[] = [];
  const llm: LlmProvider = {
    id: 'fixture', name: 'Fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false,
      imageInput: true, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    createMessage: async request => ({ id: 'summary', model: request.model, content: [{ type: 'text', text: 'Continue the requested work.' }],
      stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }),
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const content = replies[requests.length] ?? [done];
      requests.push(structuredClone({ ...request, providerOptions: undefined }));
      yield { type: 'message_start', id: `response-${requests.length}`, model: request.model,
        usage: { input_tokens: 0, output_tokens: 0 } };
      for (const [index, block] of content.entries()) {
        yield { type: 'content_block_start', index,
          content_block: block.type === 'tool_use' ? { ...block, input: {} } : block };
        if (block.type === 'tool_use') {
          const json = JSON.stringify(block.input);
          yield { type: 'input_json_delta', index, partialJson: json.slice(0, 5) };
          yield { type: 'input_json_delta', index, partialJson: json.slice(5) };
        }
        yield { type: 'content_block_stop', index };
      }
      yield { type: 'message_delta', stopReason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  return { llm, requests };
}

async function fixture(replies: ContentBlock[][], overrides: Partial<Options> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-discovery-'));
  directories.push(directory);
  const handler = vi.fn(async (input: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(input) }] }));
  const schema = { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'], additionalProperties: false };
  const { llm, requests } = provider(replies);
  const options: Options = {
    model: 'fixture', provider: llm, cwd: directory,
    env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'records') }, settingSources: [],
    systemPrompt: 'Follow the user request.', tools: [], permissionMode: 'default',
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    includePartialMessages: true, maxTurns: 10, turnEndChecks: { openWork: false, completion: false },
    mcpServers: { crm: createSdkMcpServer({ name: 'crm', instructions: 'Service guide that must survive summaries.', tools: [
      tool('lookup', 'Find a customer with the complete private definition.', schema, handler),
      tool('notes', 'Read customer notes.', schema, handler),
    ] }) },
    toolDiscovery: { services: { crm: { identity: 'installation:crm', loading: 'deferred', summary: 'Customer records' } } },
    ...overrides,
  };
  return { options, requests, handler };
}
async function collect(stream: AsyncGenerator<SDKMessage>) {
  const events: SDKMessage[] = [];
  for await (const event of stream) { events.push(event); if (event.type === 'result') break; }
  return events;
}
async function sessionFor(options: Options) {
  const session = await createSession(options); sessions.push(session); return session;
}

describe('tool discovery execution boundary', () => {
  it('keeps request prefixes stable and emits real tools while replaying exact wrappers', async () => {
    const { options, requests, handler } = await fixture([[search()], [invoke()], [done]]);
    const session = await sessionFor(options);
    await session.send('Find customer 42.');
    const events = await collect(session.stream());
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toEqual({ customer: '42' });
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request.tools).toEqual(requests[0].tools);
    expect(requests[0].tools?.map(item => item.name)).toEqual(['ToolSearch', 'CallTool']);
    expect(JSON.stringify(requests[0])).not.toContain('complete private definition');
    expect(JSON.stringify(requests[1])).toContain('complete private definition');
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i].messages.slice(0, requests[i - 1].messages.length)).toEqual(requests[i - 1].messages);
    }
    expect(requests[2].messages.flatMap(message => Array.isArray(message.content) ? message.content : []))
      .toContainEqual(invoke());
    expect(JSON.stringify(events)).not.toContain('toolContext');
    const names = events.filter(event => event.type === 'assistant').flatMap(event => event.message.content)
      .filter(block => block.type === 'tool_use').map(block => block.name);
    expect(names).toEqual(['ToolSearch', 'mcp__crm__lookup']);
  });

  it('applies permissions and hook edits to the real target without changing model history', async () => {
    const permission = vi.fn(async (name: string) => ({ behavior: 'allow' as const,
      updatedInput: name === 'mcp__crm__lookup' ? { customer: 'permitted' } : {} }));
    const { options, requests, handler } = await fixture([[search()], [invoke()], [done]], { canUseTool: permission });
    const session = await sessionFor(options);
    await session.send('Find customer.');
    await collect(session.stream());
    expect(permission.mock.calls.map(args => args[0])).toEqual(['ToolSearch', 'mcp__crm__lookup']);
    expect(handler.mock.calls[0][0]).toEqual({ customer: 'permitted' });
    expect(JSON.stringify(requests[2])).toContain('{ \\"customer\\": \\"42\\" }');
  });

  it('denies the real target even when CallTool is allowed', async () => {
    const { options, handler } = await fixture([[search()], [invoke()], [done]], {
      allowedTools: ['CallTool'], canUseTool: async name => name === 'mcp__crm__lookup'
        ? { behavior: 'deny', message: 'Restricted customer data' } : { behavior: 'allow', updatedInput: {} },
    });
    const session = await sessionFor(options);
    await session.send('Find customer.');
    const events = await collect(session.stream());
    expect(handler).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ permission_denials: [{ tool_name: 'mcp__crm__lookup' }] });
  });

  it('rejects a call guessed alongside search and a direct undeclared tool name', async () => {
    const { options, handler, requests } = await fixture([[search(), invoke('guessed')],
      [use('direct', 'mcp__crm__lookup', { customer: '42' })], [invoke('allowed')], [done]]);
    const session = await sessionFor(options);
    await session.send('Find customer.');
    const events = await collect(session.stream());
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledOnce();
    expect(JSON.stringify(requests[1])).toContain('not been discovered');
    expect(JSON.stringify(requests[2])).toContain('not a declared native tool');
  });

  it('does not treat a replaced search result as discovery', async () => {
    const { options, handler, requests } = await fixture([[search()], [invoke()], [done]], {
      hooks: { PostToolUse: [{ matcher: 'ToolSearch', hooks: [async () => ({
        hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: 'Replaced by host' },
      })] }] },
    });
    const session = await sessionFor(options);
    await session.send('Find customer.');
    await collect(session.stream());
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(requests[1])).toContain('No new definitions were loaded');
  });

  it.each(['pre-context', 'post-context', 'pre-input', 'permission-input'] as const)
    ('keeps discovery working with legitimate %s additions', async source => {
      const overrides: Partial<Options> = source === 'permission-input'
        ? { canUseTool: async name => ({ behavior: 'allow', updatedInput: name === 'ToolSearch' ? { max_results: 1 } : {} }) }
        : { hooks: source === 'post-context'
          ? { PostToolUse: [{ matcher: 'ToolSearch', hooks: [async () => ({ hookSpecificOutput: {
            hookEventName: 'PostToolUse', additionalContext: 'Host context after the definition.',
          } })] }] }
          : { PreToolUse: [{ matcher: 'ToolSearch', hooks: [async () => ({ hookSpecificOutput: {
            hookEventName: 'PreToolUse', ...(source === 'pre-input' ? { updatedInput: { query: 'select:mcp__crm__lookup', max_results: 1 } }
              : { additionalContext: 'Host context before the definition.' }),
          } })] }] } };
      const { options, requests, handler } = await fixture([[search()], [invoke()], [done]], overrides);
      const session = await sessionFor(options);
      await session.send('Find the customer tool, then use it.');
      expect((await collect(session.stream())).at(-1)).toMatchObject({ is_error: false });
      expect(handler).toHaveBeenCalledOnce();
      const results = requests[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(block => block.type === 'tool_result' && block.tool_use_id === 'search');
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results)).toContain('arguments_schema');
      expect(JSON.stringify(results)).toContain(source.endsWith('context') ? 'Host context' : 'adjusted this call');
      expect(requests[1].messages.some(message => message.role !== 'user' && message.role !== 'assistant')).toBe(false);
      expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
    });

  it('preserves surrounding hook text and updated payload spans through parallel guide dedup and reopen', async () => {
    const { options, requests, handler } = await fixture([[search('one'), search('two', 'notes')], [invoke()], [done]], {
      canUseTool: async name => ({ behavior: 'allow', updatedInput: name === 'ToolSearch' ? { max_results: 1 } : {} }),
      hooks: {
        PreToolUse: [{ matcher: 'ToolSearch', hooks: [async () => ({ additionalContext: 'Host prefix 中文.' })] }],
        PostToolUse: [{ matcher: 'ToolSearch', hooks: [async () => ({ additionalContext: 'Host suffix.' })] }],
      },
    });
    const session = await sessionFor(options);
    await session.send('Find both tools, then use the lookup.');
    expect((await collect(session.stream())).at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledOnce();
    expect(requests[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'text').some(block => block.text.includes('Host prefix'))).toBe(false);
    await session.close();
    const journalPath = getTranscriptPath(session.sessionId, options.cwd!, { env: options.env });
    const entries = (await readFile(journalPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const message = entries.map(entry => entry.message)
      .find(message => message?.toolContext?.presentations?.length === 2);
    if (!message) throw new Error('Missing recorded parallel presentations');
    for (const presentation of message.toolContext.presentations) {
      const block = (message.content as ContentBlock[]).find(block => block.type === 'tool_result' && block.tool_use_id === presentation.callId);
      if (!block || block.type !== 'tool_result' || typeof block.content !== 'string') throw new Error('Missing controlled search result');
      expect(block.content).toContain('adjusted this call');
      expect(block.content).toContain('Host prefix 中文.\n\n');
      expect(block.content.endsWith('\n\nHost suffix.')).toBe(true);
      const payload = JSON.parse(block.content.slice(presentation.payloadOffset!, presentation.payloadOffset! + presentation.payloadLength!));
      expect(payload.targets[0].arguments_schema).toBeDefined();
      expect(presentation.guides.length).toBe(payload.targets[0].usage_guide ? 1 : 0);
    }
    expect(message.toolContext.presentations.flatMap((item: { guides: string[] }) => item.guides)).toHaveLength(1);
    const next = provider([[invoke('after-reopen')], [done]]);
    const resumed = await sessionFor({ ...options, provider: next.llm, resume: session.sessionId, strictResume: true });
    await resumed.send('Use the previously discovered tool again.');
    expect((await collect(resumed.stream())).at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(next.requests[0].messages)).toContain('Host suffix.');
  });

  it.each(['replacement', 'character-limit', 'byte-limit'] as const)('still rejects a search result after host %s changes', async failure => {
    const { options, requests, handler } = await fixture([[search()], [invoke()], [done]], {
      toolResultBudget: failure === 'character-limit' ? 1000 : 30000,
      hooks: { PostToolUse: [{ matcher: 'ToolSearch', hooks: [async input => ({ hookSpecificOutput: {
        hookEventName: 'PostToolUse', ...(failure === 'replacement'
          ? { updatedMCPToolOutput: String(input.tool_response) + '\nUntracked replacement.', additionalContext: 'Allowed host context.' }
          : { additionalContext: failure === 'byte-limit' ? '界'.repeat(12000) : 'x'.repeat(2000) }),
      } })] }] },
    });
    const session = await sessionFor(options);
    await session.send('Find and use the customer tool.');
    expect((await collect(session.stream())).at(-1)).toMatchObject({ is_error: false });
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(requests[1].messages)).toContain('No new definitions were loaded');
    expect(JSON.stringify(requests[2].messages)).toContain('not been discovered');
  });

  it('compacts and restores discoveries whose original results include host hook context', async () => {
    const { options, requests, handler } = await fixture([[search()],
      ...Array.from({ length: 8 }, (_, index) => [invoke(`context-call-${index}`)]), [done]], {
      contextWindow: 9000, maxOutputTokens: 512, toolResultBudget: 6000, maxTurns: 20,
      hooks: {
        PreToolUse: [{ matcher: 'ToolSearch', hooks: [async () => ({ additionalContext: 'Host prefix.' })] }],
        PostToolUse: [{ matcher: 'ToolSearch', hooks: [async () => ({ additionalContext: 'Host suffix.' })] }],
      },
    });
    handler.mockImplementation(async () => ({ content: [{ type: 'text', text: 'Customer order evidence. '.repeat(220) }] }));
    const session = await sessionFor(options);
    await session.send('Collect the customer records.');
    const events = await collect(session.stream());
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(events.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(requests[1].messages)).toContain('Host prefix.');
    await session.close();
    const next = provider([[invoke('after-context-compact')], [done]]);
    const resumed = await sessionFor({ ...options, provider: next.llm, resume: session.sessionId, strictResume: true });
    await resumed.send('Continue using the customer tool.');
    expect((await collect(resumed.stream())).at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledTimes(9);
  });

  it('does not advance discovery when the result cannot be appended', async () => {
    let entered!: () => void;
    let release!: () => void;
    const hooked = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const { options, handler, requests } = await fixture([[search()], [invoke()], [done]], {
      hooks: { PostToolUse: [{ matcher: 'ToolSearch', hooks: [async () => {
        entered();
        await held;
        return {};
      }] }] },
    });
    const session = await sessionFor(options);
    await session.send('Find the tool.');
    const stream = collect(session.stream());
    await hooked;
    const journalPath = getTranscriptPath(session.sessionId, options.cwd!, { env: options.env });
    const backup = await readFile(journalPath);
    await rm(journalPath, { force: true });
    await mkdir(journalPath);
    release();
    const events = await stream;
    expect(events.at(-1)).toMatchObject({ is_error: true, subtype: 'error_during_execution' });
    await rm(journalPath, { recursive: true, force: true });
    await writeFile(journalPath, backup);
    expect(requests).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
    await session.close();
    const next = provider([[invoke('uncommitted')], [done]]);
    const resumed = await sessionFor({ ...options, provider: next.llm, resume: session.sessionId, strictResume: true });
    await resumed.send('Continue.');
    await collect(resumed.stream());
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(next.requests[1])).toContain('not been discovered');
  });

  it('never replays a completed wrapped action after a stream interruption', async () => {
    const { options, handler, requests } = await fixture([[search()], [invoke()], [done]]);
    let completed!: () => void;
    const actionFinished = new Promise<void>(resolve => { completed = resolve; });
    handler.mockImplementation(async () => {
      completed();
      return { content: [{ type: 'text', text: 'Saved.' }] };
    });
    const original = options.provider!.createMessageStream.bind(options.provider);
    options.provider!.createMessageStream = async function* (request) {
      const actionResponse = requests.length === 1;
      for await (const event of original(request)) {
        yield event;
        if (actionResponse && event.type === 'content_block_stop') {
          await actionFinished;
          throw new Error('Fixture stream interruption after action');
        }
      }
    };
    const session = await sessionFor(options);
    await session.send('Save the record.');
    const events = await collect(session.stream());
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(requests).toHaveLength(2);
    expect(handler).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === 'user').flatMap(event => event.message.content))
      .toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'invoke', content: 'Saved.' }));
  });

  it('preserves image results through the real wrapped tool pipeline', async () => {
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSu8AAAAASUVORK5CYII=';
    const imageHandler = vi.fn(async () => ({ content: [{ type: 'image' as const, mimeType: 'image/png', data: image }] }));
    const { options, requests } = await fixture([[search()], [invoke()], [done]], {
      mcpServers: { crm: createSdkMcpServer({ name: 'crm', tools: [tool('lookup', 'Read a customer image.',
        { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] }, imageHandler)] }) },
    });
    const session = await sessionFor(options);
    await session.send('Read the image.');
    expect((await collect(session.stream())).at(-1)).toMatchObject({ is_error: false });
    expect(imageHandler).toHaveBeenCalledOnce();
    expect(JSON.stringify(requests[2].messages)).toContain(image);
  });

  it('restores committed definitions from the journal without repeating search', async () => {
    const { options, handler } = await fixture([[search()], [done]]);
    const session = await sessionFor(options);
    await session.send('Find the customer tool.');
    await collect(session.stream());
    await session.close();
    const next = provider([[invoke()], [done]]);
    const resumed = await sessionFor({ ...options, provider: next.llm, resume: session.sessionId, strictResume: true });
    await resumed.send('Use it now.');
    const events = await collect(resumed.stream());
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledOnce();
    expect(next.requests[0].tools?.map(item => item.name)).toEqual(['ToolSearch', 'CallTool']);
  });

  it('retains full declarations for a legacy transcript', async () => {
    const { options } = await fixture([[done]], { toolDiscovery: undefined });
    const session = await sessionFor(options);
    await session.send('Hello.');
    await collect(session.stream());
    await session.close();
    const next = provider([[done]]);
    const resumed = await sessionFor({ ...options, provider: next.llm, resume: session.sessionId,
      toolDiscovery: { services: { crm: { identity: 'installation:crm', loading: 'deferred' } } } });
    await resumed.send('Continue.');
    await collect(resumed.stream());
    expect(next.requests[0].tools?.map(item => item.name)).toEqual(['mcp__crm__lookup', 'mcp__crm__notes']);
  });

  it('persists inherited discovery when a fork is closed and reopened', async () => {
    const { options, handler } = await fixture([[search()], [done]]);
    const parent = await sessionFor(options);
    await parent.send('Find the tool.');
    await collect(parent.stream());
    await parent.close();
    const fork = await sessionFor({ ...options, resume: parent.sessionId, forkSession: true,
      provider: provider([[invoke('fork-call')], [done]]).llm });
    expect(fork.sessionId).not.toBe(parent.sessionId);
    await fork.send('Use the inherited tool.');
    expect((await collect(fork.stream())).at(-1)).toMatchObject({ is_error: false });
    await fork.close();
    const reopened = await sessionFor({ ...options, resume: fork.sessionId, strictResume: true,
      provider: provider([[invoke('reopened-fork-call')], [done]]).llm });
    await reopened.send('Continue.');
    expect((await collect(reopened.stream())).at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('uses the same discovery path in one-shot query', async () => {
    const { options, handler, requests } = await fixture([[search()], [invoke()], [done]], { persistSession: false });
    const events = await collect(query({ prompt: 'Find customer.', options }));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledOnce();
    expect(requests[2].tools).toEqual(requests[0].tools);
  });

  it('sends a shared guide only once for parallel discoveries after hooks settle', async () => {
    const { options, requests } = await fixture([[search('one'), search('two', 'notes')], [done]]);
    const session = await sessionFor(options);
    await session.send('Find both tools.');
    await collect(session.stream());
    expect(JSON.stringify(requests[1]).match(/Service guide that must survive summaries/g)).toHaveLength(1);
  });

  it('keeps a later parallel guide when the first discovery output is rejected', async () => {
    const { options, requests } = await fixture([[search('one'), search('two', 'notes')], [done]], {
      hooks: { PostToolUse: [{ matcher: 'ToolSearch', hooks: [async input => input.tool_use_id === 'one'
        ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: 'Blocked' } } : {}] }] },
    });
    const session = await sessionFor(options);
    await session.send('Find both tools.');
    await collect(session.stream());
    expect(JSON.stringify(requests[1]).match(/Service guide that must survive summaries/g)).toHaveLength(1);
  });

  for (const explicit of [false, true]) for (const rejectFirst of [false, true]) {
    it(`records one parallel discovery with explicit=${explicit}, rejected-first-hook=${rejectFirst}`, async () => {
      const lookup = (id: string) => explicit ? search(id) : use(id, 'ToolSearch', { query: 'lookup' });
      const { options, requests, handler } = await fixture([[lookup('one'), lookup('two')], [invoke()], [done]], {
        ...(rejectFirst ? { hooks: { PostToolUse: [{ matcher: 'ToolSearch', hooks: [async input => input.tool_use_id === 'one'
          ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: 'Blocked' } } : {}] }] } } : {}),
      });
      const session = await sessionFor(options);
      await session.send('Find the customer tool twice, then use it.');
      expect((await collect(session.stream())).at(-1)).toMatchObject({ is_error: false });
      expect(handler).toHaveBeenCalledOnce();
      const results = requests[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(block => block.type === 'tool_result' && ['one', 'two'].includes(block.tool_use_id));
      expect(results).toHaveLength(2);
      const second = results.find(block => block.type === 'tool_result' && block.tool_use_id === 'two');
      expect(second?.type).toBe('tool_result');
      if (second?.type !== 'tool_result') throw new Error('Missing second search result');
      const item = JSON.parse(String(second.content)).targets[0];
      if (explicit || rejectFirst) expect(item.arguments_schema).toBeDefined();
      else expect(item).toMatchObject({ tool: 'mcp__crm__lookup', already_loaded: true });
      await session.close();
      const configDir = options.env!.CLAUDE_CONFIG_DIR!;
      const files = await readdir(configDir, { recursive: true });
      const journal = files.find(file => file.endsWith(`${session.sessionId}.jsonl`));
      expect(journal).toBeDefined();
      const entries = (await readFile(join(configDir, journal!), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const discoveries = entries.flatMap(entry => entry.message?.toolContext?.discoveries ?? []);
      expect(discoveries).toHaveLength(1);
      expect(discoveries[0]).toMatchObject({ callId: rejectFirst ? 'two' : 'one' });
      expect(discoveries[0].definitions).toHaveLength(1);
      const resumed = await sessionFor({ ...options, resume: session.sessionId, strictResume: true,
        provider: provider([[invoke('after-parallel')], [done]]).llm });
      await resumed.send('Use the tool again.');
      expect((await collect(resumed.stream())).at(-1)).toMatchObject({ is_error: false });
      expect(handler).toHaveBeenCalledTimes(2);
    });
  }

  it('compacts and reopens even when every summary omits tool names and schemas', async () => {
    const { options, handler, requests } = await fixture([[search()],
      ...Array.from({ length: 8 }, (_, index) => [invoke(`invoke-${index}`)]), [done]], {
      contextWindow: 9000, maxOutputTokens: 512, toolResultBudget: 6000, maxTurns: 20,
    });
    handler.mockImplementation(async () => ({ content: [{ type: 'text', text: 'Customer order evidence. '.repeat(220) }] }));
    const session = await sessionFor(options);
    await session.send('Collect the customer records.');
    const events = await collect(session.stream());
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(events.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(8);
    expect(requests.every(request => JSON.stringify(request.tools) === JSON.stringify(requests[0].tools))).toBe(true);
    await session.close();
    const next = provider([[invoke('reopened')], [done]]);
    const resumed = await sessionFor({ ...options, provider: next.llm, resume: session.sessionId, strictResume: true });
    await resumed.send('Continue using that tool.');
    expect((await collect(resumed.stream())).at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledTimes(9);
  });
});
