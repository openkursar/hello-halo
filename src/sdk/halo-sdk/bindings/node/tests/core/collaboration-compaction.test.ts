import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../../index.js';
import type { SDKSession } from '../../contracts/core/session.js';
import type { HookCallback, HookInput } from '../../types/config.js';
import type { LlmProvider, Message, ProviderRequest, StreamEvent } from '../../types/provider.js';
import { getTranscriptPath } from './session-history.fixture.js';

const hostMarker = 'HOST_COMPACTION_CONTEXT';
const localHeading = 'Collaboration state when this conversation was compacted';
const roots: string[] = [];
const sessions: SDKSession[] = [];
const evidence = 'Original verified evidence. '.repeat(1800);

function fixture() {
  const requests: ProviderRequest[] = [];
  const summaries: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'compaction-context', name: 'Compaction context fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false,
      imageInput: false, pdfInput: false, audioInput: false, videoInput: false,
      caching: false, systemPromptStyle: 'top_level' }),
    async createMessage(request) {
      summaries.push(structuredClone({ ...request, providerOptions: undefined }));
      return { id: `summary-${summaries.length}`, model: request.model,
        content: [{ type: 'text', text: 'Continue the requested investigation. Details remain in the transcript.' }],
        stopReason: 'end_turn', usage: { input_tokens: 20, output_tokens: 10 } };
    },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      requests.push(structuredClone({ ...request, providerOptions: undefined }));
      yield { type: 'message_start', id: `work-${requests.length}`, model: request.model,
        usage: { input_tokens: 10, output_tokens: 10 } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Evidence recorded.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests, summaries };
}

const hostText = (version: string) => `${hostMarker}: reviewer is idle; task "Investigate ${version}" is unfinished.`;

async function setup(preCompact: HookCallback[] = [], overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-compaction-context-'));
  roots.push(root);
  const captured = fixture();
  const options = { provider: captured.provider, model: 'fixture', cwd: root,
    env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config') }, settingSources: [], skillCatalog: [],
    systemPrompt: 'Stable assistant instructions.', thinking: { type: 'disabled' },
    contextWindow: 200_000, maxOutputTokens: 2000, maxTurns: 5,
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    turnEndChecks: { openWork: false, completion: false }, collaboration: { mode: 'hosted' },
    ...(preCompact.length ? { hooks: { PreCompact: preCompact.map(hook => ({ hooks: [hook] })) } } : {}),
    ...overrides };
  const session = await createSession(options as Parameters<typeof createSession>[0]);
  sessions.push(session);
  return { ...captured, session, options };
}

async function turn(session: SDKSession, input: string) {
  await session.send(input);
  const events = [];
  for await (const event of session.stream()) {
    events.push(event);
    if (event.type === 'result') break;
  }
  expect(events.at(-1)).toMatchObject({ type: 'result', is_error: false });
  return events;
}

function text(message: Message) {
  return typeof message.content === 'string' ? message.content : message.content
    .filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n');
}

function carried(messages: Message[], marker = hostMarker) {
  return messages.filter(message => text(message).includes(marker));
}

function assertCarried(messages: Message[], version: string) {
  const found = carried(messages);
  expect(found).toHaveLength(1);
  expect(text(found[0])).toBe(`<system-reminder>\n${hostText(version)}\n</system-reminder>`);
  expect(found[0]).not.toHaveProperty('compactionContext');
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.close();
    await session.flush();
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('PreCompact additionalContext through public session compaction', () => {
  it('does not run the hook or change the stable prefix during ordinary turns', async () => {
    const hook = vi.fn<HookCallback>(async () => ({ additionalContext: hostText('ordinary') }));
    const { session, requests, summaries } = await setup([hook]);
    await turn(session, 'First ordinary request.');
    await turn(session, 'Second ordinary request.');
    expect(hook).not.toHaveBeenCalled();
    expect(summaries).toHaveLength(0);
    expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
    expect(carried(requests[1].messages)).toHaveLength(0);
  });

  it('carries the hook text into context after a manual summary that omits it', async () => {
    const hook = vi.fn<HookCallback>(async () => ({ additionalContext: hostText('manual') }));
    const { session, requests, summaries } = await setup([hook]);
    await turn(session, evidence);
    await turn(session, 'Continue investigation.');
    const events = await turn(session, '/compact');
    expect(events.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(true);
    expect(summaries).toHaveLength(1);
    expect(carried(summaries[0].messages)).toHaveLength(0);
    expect(hook).toHaveBeenCalledOnce();
    const input = hook.mock.calls[0][0] as HookInput;
    expect(input).toMatchObject({ hook_event_name: 'PreCompact', trigger: 'manual' });
    expect(hook.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
    await turn(session, 'Continue from the handover.');
    assertCarried(requests.at(-1)!.messages, 'manual');
    expect(requests.at(-1)!.systemPrompt).toEqual(requests[0].systemPrompt);
    expect(requests.at(-1)!.tools).toEqual(requests[0].tools);
  });

  it('carries the hook text during automatic context-pressure compaction', async () => {
    const hook = vi.fn<HookCallback>(async () => ({ additionalContext: hostText('automatic') }));
    const captured = fixture();
    const originalStream = captured.provider.createMessageStream.bind(captured.provider);
    captured.provider.createMessageStream = async function* (request) {
      for await (const event of originalStream(request)) {
        if (event.type === 'message_delta') event.usage = { input_tokens: 35_000, output_tokens: 10 };
        yield event;
      }
    };
    const { session } = await setup([hook], { provider: captured.provider, contextWindow: 40_000 });
    await turn(session, evidence);
    await turn(session, 'Continue investigation.');
    expect(captured.summaries.length).toBeGreaterThan(0);
    expect(hook.mock.calls[0][0]).toMatchObject({ trigger: 'auto' });
    assertCarried(captured.requests.at(-1)!.messages, 'automatic');
  });

  it('adds nothing when hooks return nothing, blank text or fail, and compaction still succeeds', async () => {
    const run = async (hooks: HookCallback[]) => {
      const { session, requests } = await setup(hooks);
      await turn(session, evidence);
      await turn(session, 'Continue investigation.');
      const events = await turn(session, '/compact');
      expect(events.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(true);
      await turn(session, 'Continue.');
      return requests.at(-1)!.messages;
    };
    const empty = vi.fn<HookCallback>(async () => ({}));
    const blank = vi.fn<HookCallback>(async () => ({ additionalContext: '  \n ' }));
    const failing = vi.fn<HookCallback>(async () => { throw new Error('host state offline'); });
    const hooked = await run([empty, blank, failing]);
    const plain = await run([]);
    expect([empty, blank, failing].map(hook => hook.mock.calls.length)).toEqual([1, 1, 1]);
    const normalized = (messages: Message[]) => messages.map(message => text(message)
      .replace(/sdk-compaction-context-[^/\s]+/g, 'root')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'id'));
    expect(normalized(hooked)).toEqual(normalized(plain));
  });

  it('joins several hooks in registration order', async () => {
    const { session, requests } = await setup([
      async () => ({ additionalContext: `${hostMarker} first` }),
      async () => ({ hookSpecificOutput: { hookEventName: 'PreCompact', additionalContext: 'second' } } as never),
    ]);
    await turn(session, evidence);
    await turn(session, 'Continue investigation.');
    await turn(session, '/compact');
    await turn(session, 'Continue.');
    const found = carried(requests.at(-1)!.messages);
    expect(found).toHaveLength(1);
    expect(text(found[0])).toBe(`<system-reminder>\n${hostMarker} first\nsecond\n</system-reminder>`);
  });

  it.each([false, true])('restores two local members in plain language after compaction and idle retirement, reconstruct=%s', async reconstruct => {
    const captured = fixture();
    const requests: Array<{ child: boolean; request: ProviderRequest }> = [];
    const flags = new Set<string>();
    let sequence = 0;
    captured.provider.createMessageStream = async function* (request): AsyncGenerator<StreamEvent> {
      const child = JSON.stringify(request.systemPrompt).includes('You are collaborator');
      requests.push({ child, request: structuredClone({ ...request, providerOptions: undefined }) });
      const history = JSON.stringify(request.messages);
      const once = (key: string) => {
        if (flags.has(key)) return false;
        flags.add(key);
        return true;
      };
      let call: { name: string; input: Record<string, unknown> } | undefined;
      if (!child && once('spawn-alpha')) call = { name: 'mcp__halo-team__spawn_agent',
        input: { name: 'alpha', prompt: 'Remember ALPHA_PRIVATE_CONTEXT and await continuation.' } };
      else if (!child && once('spawn-beta')) call = { name: 'mcp__halo-team__spawn_agent',
        input: { name: 'beta', prompt: 'Remember BETA_PRIVATE_CONTEXT and await continuation.' } };
      else if (!child && history.includes('CONTINUE_EXISTING_MEMBERS') && once('send-alpha'))
        call = { name: 'mcp__halo-team__team_send', input: { to: 'alpha', message: 'CONTINUE_ALPHA_CONTEXT' } };
      else if (!child && history.includes('CONTINUE_EXISTING_MEMBERS') && once('send-beta'))
        call = { name: 'mcp__halo-team__team_send', input: { to: 'beta', message: 'CONTINUE_BETA_CONTEXT' } };
      const id = `local-frame-${++sequence}`;
      yield { type: 'message_start', id, model: request.model, usage: { input_tokens: 10, output_tokens: 10 } };
      yield { type: 'content_block_start', index: 0, content_block: call
        ? { type: 'tool_use', id, name: call.name, input: call.input }
        : { type: 'text', text: child ? 'Local context retained.' : 'Local work ready.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: call ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    };
    const configured = await setup([], { provider: captured.provider,
      systemPrompt: 'You are the source assistant.', maxTurns: 30,
      collaboration: { mode: 'local', maxIdleSessions: 0 } });
    let session = configured.session;
    await session.send(`Create the local collaboration. ${evidence}`);
    for await (const _event of session.stream()) { /* Drain collaborator continuations. */ }
    expect(requests.filter(item => item.child).length).toBeGreaterThanOrEqual(2);
    if (reconstruct) {
      session.close();
      await session.flush();
      session = await createSession({ ...configured.options, resume: session.sessionId } as Parameters<typeof createSession>[0]);
      sessions.push(session);
    }
    await turn(session, '/compact');
    await session.send('CONTINUE_EXISTING_MEMBERS');
    for await (const _event of session.stream()) { /* Drain the existing member continuation. */ }
    const recovered = requests.filter(item => !item.child)
      .find(item => JSON.stringify(item.request.messages).includes('CONTINUE_EXISTING_MEMBERS'))!;
    const restored = carried(recovered.request.messages, localHeading);
    expect(restored).toHaveLength(1);
    const reminder = text(restored[0]);
    expect(reminder).toMatch(/^<system-reminder>\nCollaboration state when this conversation was compacted/);
    expect(reminder).toMatch(/Members \(2\): (alpha|beta) \([a-z ]+\), (alpha|beta) \([a-z ]+\)\./);
    expect(reminder).not.toContain('team_send');
    expect(reminder).not.toMatch(/[{}]/);
    for (const [name, own, other] of [['ALPHA', 'ALPHA_PRIVATE_CONTEXT', 'BETA_PRIVATE_CONTEXT'], ['BETA', 'BETA_PRIVATE_CONTEXT', 'ALPHA_PRIVATE_CONTEXT']]) {
      const continued = requests.filter(item => item.child).find(item => JSON.stringify(item.request.messages).includes(`CONTINUE_${name}_CONTEXT`));
      expect(continued).toBeDefined();
      expect(JSON.stringify(continued!.request.messages)).toContain(own);
      expect(JSON.stringify(continued!.request.messages)).not.toContain(other);
    }
  });

  it('does not install hook text when the summary is rejected', async () => {
    const captured = fixture();
    captured.provider.createMessage = async request => ({ id: 'invalid-summary', model: request.model,
      content: [{ type: 'tool_use', id: 'not-executed', name: 'Write', input: {} }],
      stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } });
    const hook = vi.fn<HookCallback>(async () => ({ additionalContext: hostText('uncommitted') }));
    const { session } = await setup([hook], { provider: captured.provider });
    await turn(session, evidence);
    await turn(session, 'Continue investigation.');
    await session.send('/compact');
    const events = [];
    for await (const event of session.stream()) { events.push(event); if (event.type === 'result') break; }
    expect(events.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(false);
    expect(hook).toHaveBeenCalledOnce();
    await turn(session, 'Continue after the rejected summary.');
    expect(JSON.stringify(captured.requests.at(-1)!.messages)).toContain(evidence);
    expect(carried(captured.requests.at(-1)!.messages)).toHaveLength(0);
  });

  it('cancels a pending hook and retains the original history for the next turn', async () => {
    let entered!: () => void;
    let signal: AbortSignal | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hook: HookCallback = (_input, _id, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      entered();
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const { session, requests } = await setup([hook]);
    await turn(session, evidence);
    await turn(session, 'Continue investigation.');
    await session.send('/compact');
    const consuming = (async () => {
      const events = [];
      for await (const event of session.stream()) {
        events.push(event);
        if (event.type === 'result') break;
      }
      return events;
    })();
    await started;
    await session.interrupt();
    await consuming;
    expect(signal?.aborted).toBe(true);
    await turn(session, 'Continue after cancellation.');
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain(evidence);
    expect(carried(requests.at(-1)!.messages)).toHaveLength(0);
  });

  it('replaces earlier text, excludes it from summaries, and persists the latest across resume', async () => {
    let version = 'old-state';
    const hook = vi.fn<HookCallback>(async () => ({ additionalContext: hostText(version) }));
    const { session, options, requests, summaries } = await setup([hook]);
    await turn(session, evidence);
    await turn(session, 'Continue investigation.');
    await turn(session, '/compact');
    await turn(session, `New evidence: ${evidence}`);
    assertCarried(requests.at(-1)!.messages, version);
    version = 'latest-state';
    await turn(session, 'Continue investigation with the new evidence.');
    await turn(session, '/compact');
    expect(summaries).toHaveLength(2);
    expect(JSON.stringify(summaries[1].messages)).not.toContain(hostMarker);
    session.close();
    await session.flush();
    const journal = await readFile(getTranscriptPath(session.sessionId, options.cwd, { env: options.env }), 'utf8');
    expect(journal).toContain('compactionContext');
    const resumed = await createSession({ ...options, resume: session.sessionId } as Parameters<typeof createSession>[0]);
    sessions.push(resumed);
    await turn(resumed, 'Continue after restoring the durable checkpoint.');
    assertCarried(requests.at(-1)!.messages, version);
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain('old-state');
    expect(hook).toHaveBeenCalledTimes(2);
  });
});
