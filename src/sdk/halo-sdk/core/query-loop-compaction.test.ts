import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryLoop, TokenBudget, fullCompact, microCompact } from '../index.js';
import { resolveQueryConfig } from './context.js';
import { estimateMessageTokens } from '../utils/tokens.js';
import { AnthropicProvider } from '../llm/anthropic.js';
import { ModelFallbackError, ProviderError } from '../utils/errors.js';
import * as retry from '../utils/retry.js';
import type { LlmProvider, Message, ProviderRequest, ProviderResponse, StreamEvent, UsageInfo } from '../types/provider.js';
import type { SDKMessage } from './query-types.js';
import type { Tool } from '../types/tool.js';

function history(): Message[] {
  return Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
    content: `Record ${i}: ${'verified evidence '.repeat(300)}` }));
}
const response = (text = 'The user requested a report. Evidence is in the transcript.'): ProviderResponse => ({
  id: 'summary', model: 'fixture', content: [{ type: 'text', text }], stopReason: 'end_turn',
  usage: { input_tokens: 21, output_tokens: 17, cache_read_input_tokens: 300 },
});
const work: Tool = { name: 'work', description: 'Read evidence', inputSchema: { type: 'object' },
  permissionLevel: 'none', async execute() { return { content: 'Evidence '.repeat(1200), isError: false }; } };
function fixture(options: { usage?: UsageInfo; rounds?: number; summary?: (request: ProviderRequest) => Promise<ProviderResponse> } = {}) {
  const requests: ProviderRequest[] = [];
  const summaries: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'fixture', name: 'Fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: true, systemPromptStyle: 'top_level' }),
    async createMessage(request) {
      summaries.push(structuredClone({ ...request, providerOptions: undefined }));
      return options.summary ? options.summary(request) : response();
    },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const i = requests.length;
      requests.push(structuredClone({ ...request, providerOptions: undefined }));
      const more = i < (options.rounds ?? 0);
      yield { type: 'message_start', id: `r${i}`, model: request.model, usage: options.usage! };
      yield { type: 'content_block_start', index: 0, content_block: more
        ? { type: 'tool_use', id: `t${i}`, name: 'work', input: {} }
        : { type: 'text', text: 'Complete.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: more ? 'tool_use' : 'end_turn', usage: options.usage };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests, summaries };
}
const config = (overrides = {}) => resolveQueryConfig({
  model: 'fixture', cwd: '/tmp', settingSources: [], env: { HOME: '/tmp/halo-compact-fixture' },
  systemPrompt: 'Retain the user constraints.', contextWindow: 40_000, maxOutputTokens: 4000,
  thinking: { type: 'disabled' }, permissionMode: 'bypassPermissions', maxTurns: 30,
  turnEndChecks: { openWork: false, completion: false }, ...overrides,
});
async function collect(stream: AsyncGenerator<SDKMessage>) {
  const events: SDKMessage[] = [];
  for await (const message of stream) events.push(message);
  return events;
}
function withoutCache(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item) => key === 'cache_control' ? undefined
    : key === 'content' && typeof item === 'string' ? [{ type: 'text', text: item }] : item));
}

afterEach(() => vi.restoreAllMocks());

describe('cache-stable context management', () => {
  it('retains old evidence above the former micro threshold without rewriting its prefix', async () => {
    const { provider, requests, summaries } = fixture({ rounds: 7, usage: { input_tokens: 52_000, output_tokens: 10 } });
    const events = await collect(queryLoop(config({ contextWindow: 200_000, maxOutputTokens: 128_000 }), provider, [work], 'Inspect evidence.'));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(summaries).toHaveLength(0);
    for (let i = 1; i < requests.length; i++) {
      const previous = requests[i - 1].messages;
      expect(withoutCache(requests[i].messages.slice(0, previous.length))).toEqual(withoutCache(previous));
    }
    expect(JSON.stringify(requests.at(-1))).not.toContain('tool result truncated to save context');
  });

  it.each([undefined, { input_tokens: 0, output_tokens: 0 }, { output_tokens: 2 } as UsageInfo])(
    'compacts a growing conversation when input usage is missing: %j', async usage => {
      const { provider, summaries, requests } = fixture({ usage, rounds: 16 });
      const events = await collect(queryLoop(config(), provider, [work], 'Inspect evidence.'));
      expect(events.at(-1)).toMatchObject({ is_error: false });
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.length).toBeLessThan(4);
      expect(requests).toHaveLength(17);
      expect(events.some(e => e.type === 'system' && e.subtype === 'compact_boundary')).toBe(true);
    });

  it('uses the full envelope for the summary and counts its reported usage', async () => {
    const { provider, summaries, requests } = fixture();
    const compacted = vi.fn();
    const events = await collect(queryLoop(config(), provider, [work], history(), { onCompact: compacted }));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].systemPrompt).toEqual(requests[0].systemPrompt);
    expect(summaries[0].tools).toEqual(requests[0].tools);
    expect(summaries[0].thinking).toEqual(requests[0].thinking);
    expect(JSON.stringify(summaries[0].messages)).toContain('Record 0:');
    expect(JSON.stringify(requests[0].messages)).not.toContain('Record 0:');
    expect(compacted).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ is_error: false, usage: { input_tokens: 21,
      output_tokens: 17, cache_read_input_tokens: 300 } });
  });

  it('preserves all history after bounded no-progress recovery above capacity', async () => {
    const source = history();
    const before = structuredClone(source);
    const compacted = vi.fn();
    const { provider, summaries, requests } = fixture({ summary: async () => response('summary '.repeat(20000)) });
    const events = await collect(queryLoop(config(), provider, [], source, { onCompact: compacted }));
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(summaries).toHaveLength(2);
    expect(requests).toHaveLength(0);
    expect(compacted).not.toHaveBeenCalled();
    expect(source).toEqual(before);
  });

  it('does not execute a tool returned by the summarizer', async () => {
    const execute = vi.fn(work.execute);
    const { provider, summaries } = fixture({ summary: async () => ({ ...response(), stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 'unexpected', name: 'work', input: {} }] }) });
    const events = await collect(queryLoop(config(), provider, [{ ...work, execute }], history()));
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(summaries).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('defers another proactive summary while reported pressure is below capacity and new work is small', async () => {
    const { provider, summaries, requests } = fixture({ rounds: 5, usage: { input_tokens: 33_000, output_tokens: 1 } });
    const tinyTool = { ...work, async execute() { return { content: 'Done.', isError: false }; } };
    const events = await collect(queryLoop(config(), provider, [tinyTool], history()));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(summaries).toHaveLength(1);
    expect(requests).toHaveLength(6);
  });

  it('retries transient summary failures through the ordinary retry path without changing the prefix', async () => {
    vi.spyOn(retry, 'sleep').mockResolvedValue();
    let attempts = 0;
    const { provider, summaries, requests } = fixture({ summary: async () => {
      if (attempts++ === 0) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      return response();
    } });
    const events = await collect(queryLoop(config(), provider, [], history()));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(summaries).toHaveLength(2);
    expect(summaries[1]).toEqual(summaries[0]);
    expect(requests).toHaveLength(1);
    expect(events.filter(e => e.type === 'system' && e.subtype === 'api_retry')).toHaveLength(1);
  });

  it('uses a fallback model when the summary provider has already exhausted its retries', async () => {
    const { provider, summaries, requests } = fixture({ summary: async request => {
      if (request.model === 'fixture') throw new ModelFallbackError('Primary unavailable');
      return { ...response(), model: request.model };
    } });
    const events = await collect(queryLoop(config({ fallbackModel: 'fallback' }), provider, [], history()));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(summaries.map(r => r.model)).toEqual(['fixture', 'fallback']);
    expect(requests[0].model).toBe('fallback');
    expect(events.some(e => e.type === 'system' && e.subtype === 'model_fallback')).toBe(true);
  });

  it('continues below capacity after a bounded unusable-summary repair without dropping evidence', async () => {
    const source = history();
    const { provider, summaries, requests } = fixture({ summary: async () => response('') });
    const budget = new TokenBudget(200_000, 4000);
    const full = { messages: source, systemPrompt: 'Retain the user constraints.', tools: [] };
    const estimated = budget.estimateRequest(full);
    const events = await collect(queryLoop(config({ contextWindow: Math.ceil(estimated / 0.95) + 4000 }), provider, [], source));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(summaries).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(withoutCache(requests[0].messages.slice(-source.length))).toEqual(withoutCache(source));
    expect(events.some(e => e.type === 'system' && e.subtype === 'compact_boundary')).toBe(false);
  });

  it('does not misclassify a later network failure after a successful summary', async () => {
    vi.spyOn(retry, 'sleep').mockResolvedValue();
    const { provider, summaries, requests } = fixture();
    const original = provider.createMessageStream.bind(provider);
    let attempts = 0;
    provider.createMessageStream = async function* (request) {
      if (attempts++ === 0) throw ProviderError.overloaded();
      yield* original(request);
    };
    const events = await collect(queryLoop(config(), provider, [], history()));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(summaries).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(events.filter(e => e.type === 'system' && e.subtype === 'api_retry')).toHaveLength(1);
  });

  it('recovers from a server overflow immediately after a proactive summary', async () => {
    const { provider, summaries, requests } = fixture();
    const original = provider.createMessageStream.bind(provider);
    let attempts = 0;
    provider.createMessageStream = async function* (request) {
      if (attempts++ === 0) throw ProviderError.contextWindowExceeded();
      yield* original(request);
    };
    const events = await collect(queryLoop(config(), provider, [], history()));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(attempts).toBe(2);
    expect(summaries).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  it('stops persistent server overflow after bounded recovery without trimming history', async () => {
    const { provider, summaries } = fixture();
    let attempts = 0;
    provider.createMessageStream = async function* () {
      attempts++;
      throw ProviderError.contextWindowExceeded();
    };
    const events = await collect(queryLoop(config(), provider, [], history()));
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(attempts).toBeLessThanOrEqual(2);
    expect(summaries.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(events)).not.toContain('tool result truncated');
  });

  it('cancels a summary retry wait without changing history or retrying again', async () => {
    const controller = new AbortController();
    const { provider, summaries, requests } = fixture({ summary: async () => { throw ProviderError.overloaded(); } });
    const source = history();
    const before = structuredClone(source);
    const events: SDKMessage[] = [];
    for await (const event of queryLoop({ ...config(), abortSignal: controller.signal }, provider, [], source)) {
      events.push(event);
      if (event.type === 'system' && event.subtype === 'api_retry') controller.abort();
    }
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(summaries).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect(source).toEqual(before);
    expect(events.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(false);
  });

  it('retries only a failed summary segment after earlier segments have already been summarized', async () => {
    vi.spyOn(retry, 'sleep').mockResolvedValue();
    const source = history();
    let paid = 0;
    let interrupted = false;
    const { provider, summaries } = fixture({ summary: async request => {
      if (estimateMessageTokens(request.messages) > 10_000) throw ProviderError.contextWindowExceeded();
      if (paid === 1 && !interrupted) {
        interrupted = true;
        throw ProviderError.overloaded();
      }
      paid++;
      return response();
    } });
    const events = await collect(queryLoop(config(), provider, [], source));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(interrupted).toBe(true);
    const failed = summaries.findIndex((request, index) => index > 0 &&
      JSON.stringify(request) === JSON.stringify(summaries[index - 1]));
    expect(failed).toBeGreaterThan(0);
    expect(paid).toBeGreaterThan(1);
    expect(events.at(-1)).toMatchObject({ usage: { output_tokens: paid * 17 } });
  });

  it('does not reset a provider-exhausted retry budget', async () => {
    const { provider, summaries, requests } = fixture({ summary: async () => {
      throw new ProviderError('Unavailable after retries', { statusCode: 503, retryable: true, retriesExhausted: true });
    } });
    const events = await collect(queryLoop(config(), provider, [], history()));
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(summaries).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect(events.some(event => event.type === 'system' && event.subtype === 'api_retry')).toBe(false);
  });

  it('uses the owner-supplied archive rather than inventing a main-session path for a child', async () => {
    const { provider, requests } = fixture();
    await collect(queryLoop(config(), provider, [], history(), { transcriptPath: '/fixture/records/collaborator.jsonl' }));
    expect(JSON.stringify(requests[0].messages)).toContain('/fixture/records/collaborator.jsonl');
  });

  it('checks the monetary budget again after the summary call', async () => {
    const { provider, requests } = fixture();
    const events = await collect(queryLoop(config({ maxBudgetUsd: 0.001,
      modelPricing: { fixture: { inputPerMtk: 100, outputPerMtk: 100, cacheCreationPerMtk: 100, cacheReadPerMtk: 100 } },
    }), provider, [], history()));
    expect(events.at(-1)).toMatchObject({ subtype: 'error_max_budget_usd' });
    expect(requests).toHaveLength(0);
  });

  it('does not discard incoming messages while the summary is pending', async () => {
    let incoming = false;
    const { provider, requests } = fixture({ summary: async () => { incoming = true; return response(); } });
    await collect(queryLoop(config(), provider, [], history(), {
      getPendingUserMessage: async () => {
        if (!incoming) return null;
        incoming = false;
        return { role: 'user', content: 'Report only, do not edit.' };
      },
    }));
    expect(JSON.stringify(requests[0].messages)).toContain('Report only, do not edit.');
  });
});

describe('output allowances', () => {
  it.each([32_000, 128_000, 320_000])('keeps the same ordinary history with output ceiling %i', async maxOutputTokens => {
    const source = history();
    const original = structuredClone(source);
    const cfg = config({ contextWindow: 150_000, maxOutputTokens });
    const { provider, requests, summaries } = fixture();
    const events = await collect(queryLoop(cfg, provider, [], source));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(summaries).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(withoutCache(requests[0].messages.slice(-source.length))).toEqual(withoutCache(original));
    const inputTokens = new TokenBudget(cfg.contextWindow).estimateRequest(requests[0]);
    expect(requests[0].maxTokens).toBe(Math.min(maxOutputTokens, cfg.contextWindow - inputTokens));
    expect(requests[0].maxTokens).toBeGreaterThan(20_000);
    expect(cfg.maxTokens).toBe(maxOutputTokens);
    expect(source).toEqual(original);
  });

  it.each([{ type: 'disabled' as const }, { type: 'adaptive' as const }, { type: 'enabled' as const, budgetTokens: 32_000 }])(
    'makes room and continues automatically under a large ceiling with %j thinking', async thinking => {
      const source = history().map(message => ({ ...message, content: String(message.content).repeat(3) }));
      const cfg = config({ contextWindow: 150_000, maxOutputTokens: 320_000, thinking });
      const { provider, summaries, requests } = fixture({ summary: async request => {
        const estimate = new TokenBudget(cfg.contextWindow).estimateRequest(request);
        if (estimate + request.maxTokens > cfg.contextWindow) throw ProviderError.contextWindowExceeded();
        return response();
      } });
      const stream = provider.createMessageStream.bind(provider);
      provider.createMessageStream = async function* (request) {
        const inputTokens = new TokenBudget(cfg.contextWindow).estimateRequest(request);
        expect(inputTokens + request.maxTokens).toBeLessThanOrEqual(cfg.contextWindow);
        expect(request.thinking).toEqual(thinking);
        yield* stream(request);
      };
      const compacted = vi.fn();
      const events = await collect(queryLoop(cfg, provider, [], source, { onCompact: compacted }));
      expect(events.at(-1)).toMatchObject({ is_error: false });
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.length).toBeLessThanOrEqual(16);
      expect(compacted).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(1);
      expect(events.filter(event => event.type === 'system' && event.subtype === 'compact_boundary')).toHaveLength(1);
      for (const request of summaries) expect(request.thinking).toEqual(thinking);
      expect(cfg.maxTokens).toBe(320_000);
    });

  it('does not starve internal summaries with a small work-response ceiling', async () => {
    const cfg = config({ maxOutputTokens: 300 });
    const { provider, summaries, requests } = fixture({ summary: async request => ({ ...response(),
      stopReason: request.maxTokens < 1000 ? 'max_tokens' : 'end_turn' }) });
    const events = await collect(queryLoop(cfg, provider, [], history()));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].maxTokens).toBeGreaterThanOrEqual(1000);
    expect(summaries[0].maxTokens).toBeLessThanOrEqual(10_000);
    expect(requests).toHaveLength(1);
    expect(requests[0].maxTokens).toBe(300);
    expect(cfg.maxTokens).toBe(300);
  });

  it('keeps a large explicit thinking budget while maintenance uses its own allowance', async () => {
    const cfg = config({ contextWindow: 150_000, maxOutputTokens: 320_000,
      thinking: { type: 'enabled', budgetTokens: 32_000 } });
    const source = history().map(message => ({ ...message, content: String(message.content).repeat(3) }));
    const { provider, summaries, requests } = fixture();
    const events = await collect(queryLoop(cfg, provider, [], source));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].maxTokens).toBeGreaterThan(32_000);
    expect(summaries[0].maxTokens).toBeLessThanOrEqual(52_000);
    expect(summaries[0].thinking).toEqual(requests[0].thinking);
    expect(requests[0].thinking).toEqual({ type: 'enabled', budgetTokens: 32_000 });
  });

  it('does not count explicit thinking toward the handover text target', async () => {
    const cfg = config({ contextWindow: 400_000, maxOutputTokens: 640_000,
      thinking: { type: 'enabled', budgetTokens: 32_000 } });
    const source = history().map(message => ({ ...message, content: String(message.content).repeat(8) }));
    const { provider, summaries, requests } = fixture();
    const events = await collect(queryLoop(cfg, provider, [], source));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(summaries).toHaveLength(1);
    const instruction = String(summaries[0].messages.at(-1)?.content);
    expect(instruction).toContain('The complete response must fit within 20000 output tokens.');
    expect(summaries[0].maxTokens).toBe(52_000);
    expect(summaries[0].thinking).toEqual({ type: 'enabled', budgetTokens: 32_000 });
    expect(requests).toHaveLength(1);
    expect(cfg.maxTokens).toBe(640_000);
  });

  it('corrects an explicit output rejection once without summarizing or changing saved configuration', async () => {
    const cfg = config({ contextWindow: 1_000_000, maxOutputTokens: 640_000 });
    const { provider, requests, summaries } = fixture();
    const attempted: ProviderRequest[] = [];
    const stream = provider.createMessageStream.bind(provider);
    provider.createMessageStream = async function* (request) {
      attempted.push(request);
      if (request.maxTokens > 393_216) throw new ProviderError('max_tokens must be between 1 and 393216', { statusCode: 400 });
      yield* stream(request);
    };
    const events = await collect(queryLoop(cfg, provider, [], 'Hello.'));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(attempted.map(request => request.maxTokens)).toEqual([640_000, 393_216]);
    expect(withoutCache(attempted[1].messages)).toEqual(withoutCache(attempted[0].messages));
    expect(attempted[1].systemPrompt).toEqual(attempted[0].systemPrompt);
    expect(attempted[1].tools).toEqual(attempted[0].tools);
    expect(summaries).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(cfg.maxTokens).toBe(640_000);
  });

  it('applies a learned allowance to later work in the same run without sharing it with another run', async () => {
    const cfg = config({ contextWindow: 1_000_000, maxOutputTokens: 640_000 });
    const { provider, requests } = fixture({ rounds: 1 });
    const attempted: number[] = [];
    const stream = provider.createMessageStream.bind(provider);
    provider.createMessageStream = async function* (request) {
      attempted.push(request.maxTokens);
      if (request.maxTokens > 393_216) throw new ProviderError('max_tokens must be between 1 and 393216', { statusCode: 400 });
      yield* stream(request);
    };
    expect((await collect(queryLoop(cfg, provider, [work], 'Work.'))).at(-1)).toMatchObject({ is_error: false });
    expect(attempted).toEqual([640_000, 393_216, 393_216]);
    const other = fixture();
    expect((await collect(queryLoop(cfg, other.provider, [], 'Hello.'))).at(-1)).toMatchObject({ is_error: false });
    expect(other.requests[0].maxTokens).toBe(640_000);
    expect(requests).toHaveLength(2);
  });

  it('corrects a summary output rejection without letting repair exceed the learned allowance', async () => {
    const cfg = config({ maxOutputTokens: 300 });
    let accepted = 0;
    const { provider, summaries, requests } = fixture({ summary: async request => {
      if (request.maxTokens > 2048) throw ProviderError.fromHttpResponse('Fixture', 400, JSON.stringify({ error: { message: 'max_tokens must be between 1 and 2048' } }));
      return { ...response(), stopReason: accepted++ === 0 ? 'max_tokens' : 'end_turn' };
    } });
    const events = await collect(queryLoop(cfg, provider, [], history()));
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(summaries).toHaveLength(3);
    expect(summaries[0].maxTokens).toBeGreaterThan(2048);
    expect(summaries.slice(1).map(request => request.maxTokens)).toEqual([2048, 2048]);
    expect(requests[0].maxTokens).toBe(300);
    expect(events.at(-1)).toMatchObject({ usage: { output_tokens: 34 } });
  });

  it.each(['remaining-context', 'provider-limit'] as const)('validates summaries against the actual %s allowance', async limitSource => {
    const source = history();
    const estimated = new TokenBudget(150_000).estimateRequest({ messages: source, systemPrompt: 'Retain the user constraints.', tools: [] });
    const cfg = config({ contextWindow: limitSource === 'remaining-context' ? estimated + 5000 : 40_000, maxOutputTokens: 300 });
    const sent: number[] = [];
    const { provider, requests } = fixture({ summary: async request => {
      sent.push(request.maxTokens);
      if (limitSource === 'provider-limit' && request.maxTokens > 2048) {
        throw ProviderError.fromHttpResponse('Fixture', 400, JSON.stringify({ error: { message: 'max_tokens must be between 1 and 2048' } }));
      }
      return { ...response(), usage: { input_tokens: 100, output_tokens: request.maxTokens + 1 } };
    } });
    const checkpoint = vi.fn();
    const events = await collect(queryLoop(cfg, provider, [], source, { onCompact: checkpoint }));
    expect(events.at(-1)).toMatchObject({ is_error: limitSource === 'provider-limit' });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(requests).toHaveLength(limitSource === 'provider-limit' ? 0 : 1);
    expect(sent).toHaveLength(limitSource === 'provider-limit' ? 3 : 2);
    if (limitSource === 'remaining-context') expect(sent[0]).toBeLessThan(10_000);
    expect(source).toEqual(history());
  });

  it('does not correct a summary rejection without proof that its response never started', async () => {
    const { provider, summaries, requests } = fixture({ summary: async () => {
      throw ProviderError.fromStreamError('Fixture', 'invalid_request_error', 'max_tokens must be between 1 and 2048');
    } });
    const checkpoint = vi.fn();
    const events = await collect(queryLoop(config(), provider, [], history(), { onCompact: checkpoint }));
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(summaries).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it.each(['invalid', 'persistent', 'thinking'] as const)('does not repeatedly replay an unsafe %s output rejection', async reason => {
    const cfg = config({ contextWindow: 150_000, maxOutputTokens: 128_000,
      thinking: reason === 'thinking' ? { type: 'enabled', budgetTokens: 32_000 } : { type: 'disabled' } });
    const { provider, summaries } = fixture();
    const attempted: number[] = [];
    provider.createMessageStream = async function* (request) {
      attempted.push(request.maxTokens);
      throw new ProviderError(reason === 'invalid' ? 'Invalid parameter: max_tokens'
        : `max_tokens must be between 1 and ${reason === 'thinking' ? 8192 : 64_000}`, { statusCode: 400 });
    };
    const events = await collect(queryLoop(cfg, provider, [], 'Hello.'));
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(attempted).toHaveLength(reason === 'persistent' ? 2 : 1);
    expect(summaries).toHaveLength(0);
    expect(cfg.maxTokens).toBe(128_000);
  });

  it.each(['text', 'thinking', 'tool_use'] as const)('never replays an output rejection after %s content starts', async kind => {
    const { provider, summaries } = fixture();
    let attempts = 0;
    const execute = vi.fn(work.execute);
    provider.createMessageStream = async function* () {
      attempts++;
      yield { type: 'content_block_start', index: 0, content_block: kind === 'tool_use'
        ? { type: 'tool_use', id: 'partial', name: 'work', input: {} }
        : kind === 'thinking' ? { type: 'thinking', thinking: 'Partial' } : { type: 'text', text: 'Partial' } };
      throw new ProviderError('max_tokens must be between 1 and 2048', { statusCode: 400 });
    };
    const events = await collect(queryLoop(config(), provider, [{ ...work, execute }], 'Hello.'));
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(attempts).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(summaries).toHaveLength(0);
  });
});

describe('summary request prefix', () => {
  it('keeps the serialized Anthropic prefix and thinking parameters unchanged', async () => {
    const provider = new AnthropicProvider({ apiKey: 'fixture-not-a-key' });
    const source = history();
    const request: ProviderRequest = { model: 'fixture', messages: source, stream: true, maxTokens: 6000,
      systemPrompt: [{ type: 'text', text: 'Stable system', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Stable project context' }],
      tools: [{ name: 'work', description: 'Read', input_schema: { type: 'object' } }],
      thinking: { type: 'enabled', budgetTokens: 1024 }, providerOptions: { effort: 'high' } };
    const body = (value: ProviderRequest) => (provider as unknown as {
      buildRequestBody(request: ProviderRequest): Promise<Record<string, unknown>>;
    }).buildRequestBody(value);
    const normal = await body(request);
    let summaryBody: Record<string, unknown> | undefined;
    vi.spyOn(provider, 'createMessage').mockImplementation(async sent => { summaryBody = await body(sent); return response(); });
    await fullCompact(source, provider, 'fixture', '', [], undefined, undefined, {
      request, maxTokens: 4000, targetInputTokens: 20_000, estimateInputTokens: estimateMessageTokens,
    });
    expect(summaryBody?.system).toEqual(normal.system);
    expect(summaryBody?.tools).toEqual(normal.tools);
    expect(summaryBody?.thinking).toEqual(normal.thinking);
    expect((summaryBody?.messages as unknown[]).slice(0, -1)).toEqual(normal.messages);
    const markers = JSON.stringify(summaryBody).match(/cache_control/g) ?? [];
    expect(markers.length).toBeLessThanOrEqual(4);
  });

  it.each([undefined, { type: 'enabled' as const, budgetTokens: 10_000 }])(
    'preserves the effective wire thinking budget with a smaller output reservation: %j', async thinking => {
      const provider = new AnthropicProvider({ apiKey: 'fixture-not-a-key' });
      const body = (request: ProviderRequest) => (provider as unknown as {
        buildRequestBody(request: ProviderRequest): Promise<Record<string, unknown>>;
      }).buildRequestBody(request);
      const source = history();
      const cfg = config({ thinking, maxOutputTokens: 8192 });
      const expected = await body({ model: cfg.model, messages: source, maxTokens: cfg.maxTokens, stream: true,
        thinking: thinking ?? { type: 'enabled', budgetTokens: 10_000 } });
      const serialized: Record<string, unknown>[] = [];
      const { provider: scripted, requests, summaries } = fixture({ summary: async request => {
        serialized.push(await body(request));
        return response();
      } });
      const events = await collect(queryLoop(cfg, scripted, [], source));
      expect(events.at(-1)).toMatchObject({ is_error: false });
      expect(summaries).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(serialized[0].thinking).toEqual(expected.thinking);
      expect(serialized[0].thinking).toEqual({ type: 'enabled', budget_tokens: 8191 });
      expect(serialized[0].max_tokens).toBeGreaterThan(8192);
      expect(requests[0].maxTokens).toBe(8192);
    });

  it('accepts a useful handover above the preferred target without a second summary', async () => {
    const source = history();
    const createMessage = vi.fn(async () => response('Working state. '.repeat(700)));
    const result = await fullCompact(source, { createMessage } as unknown as LlmProvider, 'fixture', '', [], undefined, undefined, {
      request: { model: 'fixture', messages: source, maxTokens: 4000, stream: true },
      maxTokens: 4000, targetInputTokens: 1000, maxInputTokens: 40_000, estimateInputTokens: estimateMessageTokens,
    });
    expect(estimateMessageTokens(result.messages)).toBeGreaterThan(1000);
    expect(result.tokensFreed).toBeGreaterThan(0);
    expect(createMessage).toHaveBeenCalledOnce();
  });

  it('can summarize when required fixed context exceeds the preferred target but still fits', async () => {
    const source = history();
    const createMessage = vi.fn(async () => response());
    const result = await fullCompact(source, { createMessage } as unknown as LlmProvider, 'fixture', '', [], undefined, undefined, {
      request: { model: 'fixture', messages: source, maxTokens: 4000, stream: true },
      maxTokens: 4000, targetInputTokens: 10_000, maxInputTokens: 22_000,
      estimateInputTokens: messages => 13_000 + estimateMessageTokens(messages),
    });
    expect(result.tokensFreed).toBeGreaterThan(0);
    expect(createMessage).toHaveBeenCalledOnce();
    expect(createMessage.mock.calls[0][0].maxTokens).toBeGreaterThanOrEqual(1024);
  });

  it('keeps the latest user constraint verbatim even when the recent tool exchange exceeds the tail budget', async () => {
    const source: Message[] = [...history(),
      { role: 'user', content: 'Report only. Do not edit files or run commands.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-final', name: 'work', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-final', content: 'large observation '.repeat(2000) }] },
    ];
    const createMessage = vi.fn(async () => response());
    const result = await fullCompact(source, { createMessage } as unknown as LlmProvider, 'fixture', '', [], undefined, undefined, {
      request: { model: 'fixture', messages: source, maxTokens: 4000, stream: true },
      maxTokens: 4000, targetInputTokens: 3000, maxInputTokens: 36_000, estimateInputTokens: estimateMessageTokens,
    });
    expect(result.messages).toContainEqual({ role: 'user', content: 'Report only. Do not edit files or run commands.' });
    expect(createMessage.mock.calls[0][0].messages).toContainEqual(source.at(-1));
    expect(result.tokensFreed).toBeGreaterThan(0);
  });

  it('rejects fixed context above capacity before making a summary request', async () => {
    const createMessage = vi.fn();
    await expect(fullCompact(history(), { createMessage } as unknown as LlmProvider, 'fixture', '', [], undefined, undefined, {
      maxTokens: 4000, targetInputTokens: 10_000, maxInputTokens: 12_000,
      estimateInputTokens: messages => 13_000 + estimateMessageTokens(messages),
    })).rejects.toThrow('required task state fill the input capacity');
    expect(createMessage).not.toHaveBeenCalled();
  });

  it.each(['empty', 'truncated', 'tool_use'] as const)('repairs %s output once without executing tools or altering the prefix', async reason => {
    const source = history();
    const invalid = reason === 'empty' ? response('') : reason === 'truncated' ? { ...response(), stopReason: 'max_tokens' }
      : { ...response(), stopReason: 'tool_use', content: [{ type: 'tool_use' as const, id: 'no', name: 'work', input: {} }] };
    const onResponse = vi.fn();
    const createMessage = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce(response());
    const result = await fullCompact(source, { createMessage } as unknown as LlmProvider, 'fixture', '', [], undefined, undefined, {
      request: { model: 'fixture', messages: source, maxTokens: 8000, stream: true },
      maxTokens: 4000, targetInputTokens: 10_000, maxInputTokens: 22_000,
      estimateInputTokens: estimateMessageTokens, onResponse,
    });
    expect(result.tokensFreed).toBeGreaterThan(0);
    expect(onResponse).toHaveBeenCalledTimes(2);
    expect(createMessage).toHaveBeenCalledTimes(2);
    const [first, second] = createMessage.mock.calls.map(([request]) => request);
    expect(second.messages.slice(0, -1)).toEqual(first.messages.slice(0, -1));
    expect(second.messages.at(-1)).not.toEqual(first.messages.at(-1));
    if (reason === 'truncated') expect(second.maxTokens).toBeGreaterThan(first.maxTokens);
  });

  it('summarizes every ordered record in smaller groups when the provider rejects the full head', async () => {
    const source = Array.from({ length: 16 }, (_, i): Message => ({ role: i % 2 ? 'assistant' : 'user',
      content: `record-${i} ${'evidence '.repeat(300)}` }));
    const seen = new Set<number>();
    const createMessage = vi.fn(async (request: ProviderRequest) => {
      if (estimateMessageTokens(request.messages) > 4000) throw ProviderError.contextWindowExceeded();
      for (const match of JSON.stringify(request.messages).matchAll(/record-(\d+)/g)) seen.add(Number(match[1]));
      return response('Retain the report-only instruction and pending work.');
    });
    const result = await fullCompact(source, { createMessage } as unknown as LlmProvider, 'fixture', '', [], undefined, undefined, {
      request: { model: 'fixture', messages: source, maxTokens: 2000, stream: true },
      maxTokens: 2000, targetInputTokens: 1000, maxInputTokens: 12_000, estimateInputTokens: estimateMessageTokens,
    });
    const retained = JSON.stringify(result.messages);
    for (let i = 0; i < source.length; i++) expect(seen.has(i) || retained.includes(`record-${i}`)).toBe(true);
    expect(createMessage.mock.calls.length).toBeLessThanOrEqual(16);
    expect(result.tokensFreed).toBeGreaterThan(0);
  });

  it.each([false, true])('recovers an oversized handover merge without dropping ordered summaries (thinking=%s)', async thinking => {
    const source: Message[] = [{ role: 'user', content: 'Report only.' },
      ...Array.from({ length: 8 }, (_, index): Message => ({ role: index % 2 ? 'user' : 'assistant',
        content: `record-${index}: ${'evidence '.repeat(1200)}` })),
      { role: 'user', content: 'Final instruction: no writes.' },
    ];
    const requests: ProviderRequest[] = [];
    const acceptedRecords = new Set<number>();
    let accepted = 0;
    let mergeRejected = false;
    const onResponse = vi.fn();
    const createMessage = vi.fn(async (request: ProviderRequest) => {
      requests.push(request);
      const input = estimateMessageTokens(request.messages);
      const merge = request.messages.some(message => String(message.content).startsWith('Earlier record handover:'));
      if (input + request.maxTokens > 18_000) {
        if (merge) mergeRejected = true;
        throw ProviderError.contextWindowExceeded();
      }
      accepted++;
      for (const match of JSON.stringify(request.messages).matchAll(/record-(\d+)/g)) acceptedRecords.add(Number(match[1]));
      const text = request.maxTokens > 6000 ? 'state '.repeat(3000) : 'Ordered constraints and pending work.';
      return { ...response(text), usage: { input_tokens: input, output_tokens: estimateMessageTokens([{ role: 'assistant', content: text }]) } };
    });
    const result = await fullCompact(source, { createMessage } as unknown as LlmProvider, 'fixture', '', [], undefined, undefined, {
      request: { model: 'fixture', messages: source, maxTokens: 8000, stream: true,
        thinking: thinking ? { type: 'enabled', budgetTokens: 1024 } : { type: 'disabled' } },
      targetInputTokens: 24_000, maxInputTokens: 40_000, maxTokens: 8000,
      estimateInputTokens: estimateMessageTokens, onResponse,
    });
    expect(mergeRejected).toBe(true);
    expect(createMessage.mock.calls.length).toBeLessThanOrEqual(16);
    expect(result.tokensFreed).toBeGreaterThan(0);
    expect(onResponse).toHaveBeenCalledTimes(accepted);
    const output = JSON.stringify(result.messages);
    for (let index = 0; index < 8; index++) expect(acceptedRecords.has(index) || output.includes(`record-${index}`)).toBe(true);
    expect(output).toContain('Final instruction: no writes.');
    for (const request of requests) if (thinking) expect(request.thinking).toEqual({ type: 'enabled', budgetTokens: 1024 });
    const failedMerge = requests.findIndex(request => request.messages.some(message => String(message.content).startsWith('Earlier record handover:')) &&
      estimateMessageTokens(request.messages) + request.maxTokens > 18_000);
    expect(requests[failedMerge + 1].messages).toEqual(requests[failedMerge].messages);
    expect(requests[failedMerge + 1].maxTokens).toBeLessThan(requests[failedMerge].maxTokens);
  });

  it.each([true, false])('shortens already-produced handovers when merge input alone is oversized (progress=%s)', async progress => {
    const source: Message[] = [{ role: 'user', content: 'Report only.' },
      ...Array.from({ length: 8 }, (_, index): Message => ({ role: index % 2 ? 'user' : 'assistant',
        content: `record-${index}: ${'evidence '.repeat(1200)}` })),
      { role: 'user', content: 'Final instruction: no writes.' },
    ];
    let shortens = 0;
    let accepted = 0;
    const onResponse = vi.fn();
    const createMessage = vi.fn(async (request: ProviderRequest) => {
      if (estimateMessageTokens(request.messages) > 10_000) throw ProviderError.contextWindowExceeded();
      accepted++;
      const shortening = request.messages.some(message => String(message.content).startsWith('Record handover:'));
      if (shortening) shortens++;
      const merge = request.messages.some(message => String(message.content).startsWith('Earlier record handover:'));
      const text = (shortening && progress) || merge ? 'Preserve report-only permission and pending work.' : 'state '.repeat(3000);
      return { ...response(text), usage: { input_tokens: 1, output_tokens: estimateMessageTokens([{ role: 'assistant', content: text }]) } };
    });
    const pending = fullCompact(source, { createMessage } as unknown as LlmProvider, 'fixture', '', [], undefined, undefined, {
      request: { model: 'fixture', messages: source, maxTokens: 8000, stream: true },
      targetInputTokens: 24_000, maxInputTokens: 40_000, maxTokens: 8000,
      estimateInputTokens: estimateMessageTokens, onResponse,
    });
    if (progress) {
      const result = await pending;
      expect(result.tokensFreed).toBeGreaterThan(0);
      expect(shortens).toBe(2);
    } else {
      await expect(pending).rejects.toThrow();
      expect(shortens).toBeGreaterThan(0);
    }
    expect(createMessage.mock.calls.length).toBeLessThanOrEqual(16);
    expect(onResponse).toHaveBeenCalledTimes(accepted);
  });

  it('keeps adaptive reasoning headroom separate from the handover text target', async () => {
    const source = history();
    const request: ProviderRequest = { model: 'fixture', messages: source, stream: true, maxTokens: 128_000,
      systemPrompt: 'Stable', tools: [], thinking: { type: 'adaptive' } };
    const createMessage = vi.fn(async () => ({ ...response(), usage: { input_tokens: 100, output_tokens: 8000 } }));
    await fullCompact(source, { createMessage } as unknown as LlmProvider, 'fixture', '', [], undefined, undefined, {
      request, maxTokens: 20_000, targetInputTokens: 20_000, estimateInputTokens: estimateMessageTokens,
    });
    const sent = createMessage.mock.calls[0][0];
    expect(sent.thinking).toEqual({ type: 'adaptive' });
    expect(sent.maxTokens).toBe(20_000);
  });

  it('retries an oversized summary once using only the head being replaced', async () => {
    const source = history();
    const request: ProviderRequest = { model: 'fixture', messages: source, stream: true, maxTokens: 4000,
      systemPrompt: 'Stable', tools: [] };
    const createMessage = vi.fn().mockRejectedValueOnce(ProviderError.contextWindowExceeded())
      .mockResolvedValue(response());
    const result = await fullCompact(source, { createMessage } as unknown as LlmProvider, 'fixture', '', [], undefined, undefined, {
      request, maxTokens: 4000, targetInputTokens: 20_000, estimateInputTokens: estimateMessageTokens,
    });
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(createMessage.mock.calls[1][0].messages.length).toBeLessThan(createMessage.mock.calls[0][0].messages.length);
    expect(result.messages.at(-1)).toEqual(source.at(-1));
  });
  it('appends the handover instruction without changing the effective request prefix', async () => {
    const source = history();
    const request: ProviderRequest = { model: 'fixture', messages: source, stream: true, maxTokens: 4000,
      systemPrompt: [{ type: 'text', text: 'Stable system', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'work', description: 'Read', input_schema: { type: 'object' } }],
      thinking: { type: 'disabled' }, providerOptions: { effort: 'high', extendedTtl: true } };
    const createMessage = vi.fn(async () => response());
    await fullCompact(source, { createMessage } as unknown as LlmProvider, 'fixture', '', [], undefined, undefined, {
      request, maxTokens: 4000, targetInputTokens: 20_000, estimateInputTokens: estimateMessageTokens,
    });
    const sent = createMessage.mock.calls[0][0];
    expect(sent.messages.slice(0, -1)).toEqual(request.messages);
    expect(sent.systemPrompt).toEqual(request.systemPrompt);
    expect(sent.tools).toEqual(request.tools);
    expect(sent.providerOptions).toMatchObject({ effort: 'high', extendedTtl: true, skipCacheWrite: true });
    expect(sent.messages.at(-1).content).toContain('No tools will be executed');
  });
});

describe('explicit tool-result reduction', () => {
  const result = (id: string, content: string): Message => ({ role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }] });
  it('does not rewrite placeholders or claim progress without net savings', () => {
    const marker = '[tool result truncated to save context — 109 chars omitted; re-run the tool to recover this output if needed]';
    const input = [...Array.from({ length: 200 }, (_, i) => result(`p${i}`, marker)),
      result('old', 'x'.repeat(30_000)), result('a', 'a'.repeat(10_000)), result('b', 'b'.repeat(10_000))];
    const reduced = microCompact(input, 50_000);
    expect(reduced.truncatedCount).toBe(1);
    expect(reduced.messages.slice(0, 200)).toEqual(input.slice(0, 200));
    expect(microCompact(reduced.messages, 50_000).truncatedCount).toBe(0);
  });
  it('never expands a short result', () => {
    const input = [result('old', 'x'), result('a', 'a'.repeat(30_000)), result('b', 'b'.repeat(30_000))];
    expect(microCompact(input, 50_000)).toEqual({ messages: input, truncatedCount: 0 });
  });
});
