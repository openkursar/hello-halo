/**
 * The options that shape what the model produces — such as the API-side task
 * budget — have to reach the provider request, not just sit in the resolved
 * config.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, createSession, createProvider } from '../index.js';
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
import { resolveQueryConfig } from './context.js';
import type { Options } from '../types/config.js';

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

function makeUsage(outputTokens = 20): UsageInfo {
  return { input_tokens: 10, output_tokens: outputTokens };
}

function makeConfig(overrides: Partial<QueryConfig> = {}): QueryConfig {
  return {
    model: 'test-model',
    contextWindow: 200_000,
    maxTurns: 3,
    cwd: '/tmp',
    env: {},
    permissionMode: 'bypassPermissions',
    systemPrompt: 'You are a test assistant.',
    thinking: { type: 'disabled' },
    abortSignal: new AbortController().signal,
    ...overrides,
  } as QueryConfig;
}

function makeRecordingProvider(outputTokens = 20): {
  provider: LlmProvider;
  requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'recording',
    name: 'Recording',
    capabilities: () => TEST_CAPS,
    async createMessage(): Promise<ProviderResponse> {
      throw new Error('not used');
    },
    async *createMessageStream(
      req: ProviderRequest,
    ): AsyncGenerator<StreamEvent, void, undefined> {
      requests.push(req);
      yield { type: 'message_start', id: `msg_${randomUUID()}`, model: req.model, usage: makeUsage(outputTokens) };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'text_delta', index: 0, text: '{"answer":"ok"}' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage(outputTokens) };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests };
}

async function drain(gen: AsyncGenerator<SDKMessage>, limit = 60): Promise<SDKMessage[]> {
  const msgs: SDKMessage[] = [];
  for await (const m of gen) {
    msgs.push(m);
    if (msgs.length >= limit) break;
  }
  return msgs;
}

describe('queryLoop — task budget', () => {
  it('forwards the API-side task budget to the provider request', async () => {
    const { provider, requests } = makeRecordingProvider();
    const config = makeConfig({ maxTurns: 1, taskBudget: { total: 50_000 } });

    await drain(queryLoop(config, provider, [], 'hi'));

    expect(requests[0].providerOptions?.taskBudget).toEqual({ total: 50_000 });
  });

  it('survives the Options → QueryConfig resolution', () => {
    const cfg = resolveQueryConfig({ model: 'deepseek-chat', taskBudget: { total: 1_234 } } as Options);
    expect(cfg.taskBudget).toEqual({ total: 1_234 });
  });
});

describe('public task-budget requests', () => {
  let directory: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sdk-task-budget-'));
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  function response(type: 'anthropic' | 'openai-compat'): Response {
    const events = type === 'anthropic' ? [
      { type: 'message_start', message: { id: 'budget-message', model: 'test-model', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ] : [
      { id: 'budget-message', model: 'test-model', choices: [{ delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ];
    const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
      + (type === 'openai-compat' ? 'data: [DONE]\n\n' : '');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }

  async function run(mode: 'query' | 'session', type: 'anthropic' | 'openai-compat', taskBudget?: Options['taskBudget']) {
    fetchMock.mockImplementation(async () => response(type));
    const options: Options = {
      model: 'test-model',
      provider: createProvider({ type, apiKey: 'fixture-key', baseUrl: 'https://budget.example.test' }),
      cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: directory },
      persistSession: false, settingSources: [], skillCatalog: [], collaboration: false,
      tools: [], systemPrompt: 'Answer the request.', thinking: { type: 'disabled' },
      maxOutputTokens: 1024, taskBudget, turnEndChecks: { openWork: false, completion: false },
    };
    let messages: SDKMessage[];
    if (mode === 'query') {
      const current = query({ prompt: 'Reply briefly.', options });
      try { messages = await drain(current); }
      finally { current.close(); await current.return(undefined); }
    } else {
      const session = await createSession(options);
      try {
        await session.send('Reply briefly.');
        messages = await drain(session.stream());
      } finally { session.close(); await session.flush(); }
    }
    expect(messages.find(message => message.type === 'result')).toMatchObject({ subtype: 'success' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(1024);
    return { url, body, headers: new Headers(init.headers) };
  }

  for (const mode of ['query', 'session'] as const) {
    it(`${mode} encodes the public total-only option at the Anthropic boundary`, async () => {
      const budget = Object.freeze({ total: 50000 });
      const { url, body, headers } = await run(mode, 'anthropic', budget);
      expect(url).toBe('https://budget.example.test/v1/messages');
      expect(body.output_config.task_budget).toEqual({ type: 'tokens', total: 50000 });
      expect(headers.get('anthropic-beta')).toBe('task-budgets-2026-03-13');
      expect(budget).toEqual({ total: 50000 });
    });

    it(`${mode} leaves Anthropic requests unchanged when the option is absent`, async () => {
      const { body, headers } = await run(mode, 'anthropic');
      expect(body.output_config?.task_budget).toBeUndefined();
      expect(headers.has('anthropic-beta')).toBe(false);
    });

    it(`${mode} does not send Anthropic task-budget fields to OpenAI-compatible endpoints`, async () => {
      const { url, body, headers } = await run(mode, 'openai-compat', { total: 50000 });
      expect(url).toBe('https://budget.example.test/chat/completions');
      expect(body.output_config).toBeUndefined();
      expect(body.task_budget).toBeUndefined();
      expect(headers.has('anthropic-beta')).toBe(false);
    });
  }
});

describe('queryLoop — output length', () => {
  it('does not treat token counts in the user wording as a continuation target', async () => {
    const { provider, requests } = makeRecordingProvider();

    await drain(queryLoop(makeConfig({ maxTurns: 3 }), provider, [], '+500k write the report'));

    expect(requests).toHaveLength(1);
  });
});
