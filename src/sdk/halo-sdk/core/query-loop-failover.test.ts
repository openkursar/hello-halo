/**
 * Provider-failure handling in the query loop: retry, model fallback, and the
 * boundary between an error the loop can absorb and one it must surface.
 *
 * Backoff delays are stubbed to zero so the retry-exhaustion path runs at
 * full length without the test sleeping for minutes.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../utils/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/retry.js')>();
  return { ...actual, delayForAttempt: () => 0 };
});

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
import { DEFAULT_RETRY } from '../utils/retry.js';
import { ModelFallbackError, ProviderError } from '../utils/errors.js';

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
    model: 'primary-model',
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

/**
 * Provider that throws the scripted failure for each call in turn, then
 * answers with plain text. Records the model of every attempt so tests can
 * assert which model a retry actually went to.
 */
function makeFailingProvider(failures: unknown[]): {
  provider: LlmProvider;
  modelsTried: string[];
} {
  const modelsTried: string[] = [];
  let callIndex = 0;

  const provider: LlmProvider = {
    id: 'failing',
    name: 'Failing',
    capabilities: () => TEST_CAPS,
    async createMessage(): Promise<ProviderResponse> {
      throw new Error('not used');
    },
    async *createMessageStream(
      req: ProviderRequest,
    ): AsyncGenerator<StreamEvent, void, undefined> {
      modelsTried.push(req.model);
      const failure = failures[callIndex];
      callIndex++;
      if (failure) throw failure;

      yield { type: 'message_start', id: `msg_${randomUUID()}`, model: req.model, usage: makeUsage() };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'text_delta', index: 0, text: 'recovered' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
      yield { type: 'message_stop' };
    },
  };

  return { provider, modelsTried };
}

async function drain(gen: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
  const msgs: SDKMessage[] = [];
  for await (const m of gen) msgs.push(m);
  return msgs;
}

function subtypes(msgs: SDKMessage[]): string[] {
  return msgs
    .filter((m) => m.type === 'system')
    .map((m) => (m as unknown as { subtype: string }).subtype);
}

/** A plain error carrying only a status, as a host-supplied provider might throw. */
function plainHttpError(message: string, status: number): Error {
  const err = new Error(message);
  (err as Error & { status: number }).status = status;
  return err;
}

describe('queryLoop — model fallback', () => {
  it('switches models immediately when the provider signals fallback', async () => {
    const { provider, modelsTried } = makeFailingProvider([
      new ModelFallbackError('overloaded'),
    ]);
    const config = makeConfig({ fallbackModel: 'backup-model' });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));

    expect(modelsTried).toEqual(['primary-model', 'backup-model']);
    const fallback = msgs.find(
      (m) => m.type === 'system' && (m as unknown as { subtype: string }).subtype === 'model_fallback',
    ) as unknown as { from_model: string; to_model: string } | undefined;
    expect(fallback).toBeDefined();
    expect(fallback!.from_model).toBe('primary-model');
    expect(fallback!.to_model).toBe('backup-model');
    // The provider already spent its own budget on the primary model; the loop
    // must not spend the retry budget on it too.
    expect(subtypes(msgs)).not.toContain('api_retry');
  });

  it('surfaces a spent overload budget when no fallback model is configured', async () => {
    const { provider, modelsTried } = makeFailingProvider([
      new ModelFallbackError('overloaded'),
    ]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [], 'hi'));

    // The provider already retried; a second budget here would only multiply
    // the wait before the user learns the request failed.
    expect(modelsTried).toEqual(['primary-model']);
    expect(subtypes(msgs)).not.toContain('api_retry');
    const result = msgs.find((m) => m.type === 'result') as unknown as { subtype: string; result: string };
    expect(result.subtype).toBe('error_during_execution');
    expect(result.result).toContain('overloaded');
  });

  it('tells the provider whether a fallback model is available', async () => {
    const seen: unknown[] = [];
    const { provider } = makeFailingProvider([]);
    const inner = provider.createMessageStream.bind(provider);
    provider.createMessageStream = (req: ProviderRequest) => {
      seen.push(req.providerOptions?.fallbackModelAvailable);
      return inner(req);
    };

    await drain(queryLoop(makeConfig(), provider, [], 'hi'));
    await drain(queryLoop(makeConfig({ fallbackModel: 'backup-model' }), provider, [], 'hi'));

    expect(seen).toEqual([false, true]);
  });

  it('switches to the fallback model at once when the provider exhausted its retries', async () => {
    const { provider, modelsTried } = makeFailingProvider([
      new ProviderError('gateway down', { statusCode: 503, retryable: true, retriesExhausted: true }),
    ]);

    const msgs = await drain(queryLoop(makeConfig({ fallbackModel: 'backup-model' }), provider, [], 'hi'));

    expect(modelsTried).toEqual(['primary-model', 'backup-model']);
    expect(subtypes(msgs)).not.toContain('api_retry');
    expect(subtypes(msgs)).toContain('model_fallback');
  });

  it('tries the fallback model only after the retry budget is spent', async () => {
    const failures = Array.from(
      { length: DEFAULT_RETRY.maxRetries + 1 },
      () => new ProviderError('gateway down', { statusCode: 503, retryable: true }),
    );
    const { provider, modelsTried } = makeFailingProvider(failures);
    const config = makeConfig({ fallbackModel: 'backup-model' });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));

    // Every retry before the budget ran out stayed on the primary model — a
    // transient outage must not permanently downgrade the session's model.
    expect(modelsTried.slice(0, DEFAULT_RETRY.maxRetries + 1).every((m) => m === 'primary-model')).toBe(true);
    expect(modelsTried[modelsTried.length - 1]).toBe('backup-model');
    expect(subtypes(msgs).filter((s) => s === 'api_retry')).toHaveLength(DEFAULT_RETRY.maxRetries);
    expect(subtypes(msgs)).toContain('model_fallback');
  });
});

describe('queryLoop — provider retry', () => {
  it('retries a retryable provider error and reports each attempt', async () => {
    const { provider, modelsTried } = makeFailingProvider([
      new ProviderError('overloaded', { statusCode: 529, retryable: true }),
    ]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [], 'hi'));

    expect(modelsTried).toHaveLength(2);
    const retry = msgs.find(
      (m) => m.type === 'system' && (m as unknown as { subtype: string }).subtype === 'api_retry',
    ) as unknown as { attempt: number; error_status: number } | undefined;
    expect(retry).toBeDefined();
    expect(retry!.attempt).toBe(1);
    expect(retry!.error_status).toBe(529);
  });

  it('retries a plain error carrying a retryable status from a host provider', async () => {
    const { provider, modelsTried } = makeFailingProvider([
      plainHttpError('Custom API error (503)', 503),
    ]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [], 'hi'));

    expect(modelsTried).toHaveLength(2);
    expect(subtypes(msgs)).toContain('api_retry');
  });

  it('surfaces a non-retryable status without retrying or falling back', async () => {
    const { provider, modelsTried } = makeFailingProvider([
      new ProviderError('invalid api key', { statusCode: 401 }),
    ]);
    const config = makeConfig({ fallbackModel: 'backup-model' });

    const msgs = await drain(queryLoop(config, provider, [], 'hi'));

    expect(modelsTried).toEqual(['primary-model']);
    expect(subtypes(msgs)).not.toContain('api_retry');
    expect(subtypes(msgs)).not.toContain('model_fallback');
    const result = msgs.find((m) => m.type === 'result') as unknown as {
      subtype: string;
      result: string;
    };
    expect(result.subtype).toBe('error_during_execution');
    expect(result.result).toContain('invalid api key');
  });

  it('does not retry again what the provider already retried to exhaustion', async () => {
    const { provider, modelsTried } = makeFailingProvider([
      new ProviderError('Anthropic API error (429): Go usage limit exceeded', {
        statusCode: 429,
        retryable: true,
        retriesExhausted: true,
      }),
    ]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [], 'hi'));

    expect(modelsTried).toEqual(['primary-model']);
    expect(subtypes(msgs)).not.toContain('api_retry');
    const result = msgs.find((m) => m.type === 'result') as unknown as { is_error: boolean; result: string };
    expect(result.is_error).toBe(true);
    expect(result.result).toContain('Go usage limit exceeded');
  });

  it('reports the provider\'s own retries as api_retry and keeps nothing from the failed attempt', async () => {
    const provider: LlmProvider = {
      id: 'retrying',
      name: 'Retrying',
      capabilities: () => TEST_CAPS,
      async createMessage(): Promise<ProviderResponse> {
        throw new Error('not used');
      },
      async *createMessageStream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        yield { type: 'message_start', id: 'msg_a', model: req.model, usage: makeUsage() };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: 'cut off mid-' };
        yield { type: 'retry', attempt: 1, maxRetries: 10, delayMs: 2_000, status: 429, message: 'slow down' };
        yield { type: 'message_start', id: 'msg_b', model: req.model, usage: makeUsage() };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: 'complete answer' };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
        yield { type: 'message_stop' };
      },
    };

    const msgs = await drain(queryLoop(makeConfig({ includePartialMessages: true }), provider, [], 'hi'));

    const retry = msgs.find(
      (m) => m.type === 'system' && (m as unknown as { subtype: string }).subtype === 'api_retry',
    ) as unknown as Record<string, unknown>;
    expect(retry).toMatchObject({
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 2_000,
      error_status: 429,
      error: 'rate_limit',
      error_message: 'slow down',
    });
    // The retry notice is not a stream event: consumers never see it as content.
    expect(msgs.some((m) => m.type === 'stream_event' && (m as { event: { type: string } }).event.type === 'retry')).toBe(false);

    const assistant = msgs.find((m) => m.type === 'assistant') as unknown as {
      message: { id: string; content: Array<{ type: string; text?: string }> };
    };
    expect(assistant.message.id).toBe('msg_b');
    expect(assistant.message.content).toEqual([{ type: 'text', text: 'complete answer' }]);
  });

  it('surfaces an error that carries no provider status', async () => {
    const { provider, modelsTried } = makeFailingProvider([new Error('socket hang up')]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [], 'hi'));

    expect(modelsTried).toEqual(['primary-model']);
    expect(subtypes(msgs)).not.toContain('api_retry');
    const result = msgs.find((m) => m.type === 'result') as unknown as { subtype: string };
    expect(result.subtype).toBe('error_during_execution');
  });
});

describe('queryLoop — a request that cannot succeed', () => {
  const reason = 'Anthropic API error (403): OAuth authentication is currently not allowed for this organization.';

  it('ends the turn with the reason as its closing assistant message, then the error result', async () => {
    const { provider } = makeFailingProvider([new ProviderError(reason, { statusCode: 403 })]);
    const onAssistantMessage = vi.fn();

    const msgs = await drain(queryLoop(makeConfig(), provider, [], 'hi', { onAssistantMessage }));

    expect(msgs.slice(-2).map((m) => m.type)).toEqual(['assistant', 'result']);
    expect(msgs.filter((m) => m.type === 'assistant')).toEqual([expect.objectContaining({
      error: 'authentication_failed',
      parent_tool_use_id: null,
      message: expect.objectContaining({
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: reason }],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    })]);
    expect(msgs.at(-1)).toMatchObject({ is_error: true, subtype: 'error_during_execution', result: reason });
    // The completed-response callback feeds model history and transcripts.
    expect(onAssistantMessage).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a spent rate limit', failure: new ProviderError('Anthropic API error (429): usage limit', { statusCode: 429, retryable: true, retriesExhausted: true }), kind: 'rate_limit' },
    { label: 'a rejected request', failure: new ProviderError('Anthropic API error (400): bad input', { statusCode: 400 }), kind: 'invalid_request' },
    { label: 'a failure without a status', failure: new Error('socket hang up'), kind: 'unknown' },
  ])('classifies $label as $kind', async ({ failure, kind }) => {
    const { provider } = makeFailingProvider([failure]);

    const msgs = await drain(queryLoop(makeConfig(), provider, [], 'hi'));

    expect(msgs.find((m) => m.type === 'assistant')).toMatchObject({
      error: kind,
      message: { content: [{ type: 'text', text: failure.message }] },
    });
  });

  it('tells the failure once, after the retries are spent', async () => {
    const failures = Array.from(
      { length: DEFAULT_RETRY.maxRetries + 1 },
      () => new ProviderError('gateway down', { statusCode: 503, retryable: true }),
    );
    const { provider } = makeFailingProvider(failures);

    const msgs = await drain(queryLoop(makeConfig(), provider, [], 'hi'));

    const kinds = msgs.map((m) => m.type === 'system' ? (m as unknown as { subtype: string }).subtype : m.type);
    expect(kinds.filter((kind) => kind === 'assistant')).toHaveLength(1);
    expect(kinds.indexOf('assistant')).toBeGreaterThan(kinds.lastIndexOf('api_retry'));
    expect(msgs.find((m) => m.type === 'assistant')).toMatchObject({ error: 'server_error' });
  });

  it('does not tell a stop as a failure', async () => {
    const controller = new AbortController();
    const { provider } = makeFailingProvider([ProviderError.rateLimit('slow down')]);
    const msgs: SDKMessage[] = [];

    for await (const m of queryLoop(makeConfig({ abortSignal: controller.signal }), provider, [], 'hi')) {
      msgs.push(m);
      if (m.type === 'system' && (m as unknown as { subtype: string }).subtype === 'api_retry') controller.abort();
    }

    expect(msgs.at(-1)).toMatchObject({ type: 'result', subtype: 'error_during_execution', errors: ['Operation was aborted'] });
    expect(msgs.some((m) => m.type === 'assistant')).toBe(false);
  });
});
