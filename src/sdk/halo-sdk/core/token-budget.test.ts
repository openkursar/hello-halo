/**
 * Unit tests for TokenBudget.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TokenBudget, contextInputTokens, effectiveThinking, maintenanceOutputBudget } from './token-budget.js';
import type { BudgetRequest } from './token-budget.js';
import type { Message, SystemPromptBlock, ToolDefinition, UsageInfo } from '../types/provider.js';
import * as tokens from '../utils/tokens.js';

function makeMessages(totalChars: number): Message[] {
  return [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(totalChars) }] }];
}

function makeRequest(totalChars = 100): BudgetRequest {
  return {
    messages: makeMessages(totalChars),
    systemPrompt: 'Follow the task instructions.',
    tools: [{ name: 'read', description: 'Read a file.', input_schema: { type: 'object' } }],
  };
}

function usage(inputTokens: number, extra: Partial<UsageInfo> = {}): UsageInfo {
  return { input_tokens: inputTokens, output_tokens: 0, ...extra };
}

const incompleteUsage = [
  { name: 'missing usage', value: undefined },
  { name: 'empty usage', value: {} as UsageInfo },
  { name: 'zero input', value: usage(0) },
  { name: 'zero input and cache', value: usage(0, { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) },
  { name: 'output only', value: { output_tokens: 500 } as UsageInfo },
  { name: 'cache read only', value: { cache_read_input_tokens: 500 } as UsageInfo },
  { name: 'cache creation only', value: { cache_creation_input_tokens: 500 } as UsageInfo },
  { name: 'negative input', value: usage(-1, { cache_read_input_tokens: 500 }) },
  { name: 'NaN input', value: usage(Number.NaN) },
  { name: 'infinite input', value: usage(Number.POSITIVE_INFINITY) },
  { name: 'string input', value: { input_tokens: '500' } as unknown as UsageInfo },
  { name: 'null input', value: { input_tokens: null } as unknown as UsageInfo },
  { name: 'negative cache', value: usage(500, { cache_read_input_tokens: -1 }) },
  { name: 'NaN cache', value: usage(500, { cache_creation_input_tokens: Number.NaN }) },
  { name: 'infinite cache', value: usage(500, { cache_read_input_tokens: Number.POSITIVE_INFINITY }) },
];

afterEach(() => vi.restoreAllMocks());

describe('contextInputTokens', () => {
  it('sums uncached input, cache writes and cache hits, not output or searches', () => {
    expect(contextInputTokens(usage(100, {
      output_tokens: 5_000,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
      web_search_requests: 10,
    }))).toBe(600);
  });

  it('does not require usage or complete fields', () => {
    expect(contextInputTokens(undefined)).toBe(0);
    expect(contextInputTokens({} as UsageInfo)).toBe(0);
    expect(contextInputTokens(usage(0))).toBe(0);
    expect(contextInputTokens({ cache_read_input_tokens: 700 } as UsageInfo)).toBe(700);
    expect(contextInputTokens({ cache_creation_input_tokens: 300 } as UsageInfo)).toBe(300);
  });

  it.each([Number.NaN, Infinity, -Infinity, -1, '100', null])('ignores malformed fields (%s)', (invalid) => {
    expect(contextInputTokens({
      input_tokens: invalid,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    } as unknown as UsageInfo)).toBe(50);
    expect(contextInputTokens({
      input_tokens: 10,
      cache_creation_input_tokens: invalid,
      cache_read_input_tokens: invalid,
    } as unknown as UsageInfo)).toBe(10);
  });

  it('keeps the total finite even if finite supplied counts overflow when added', () => {
    expect(contextInputTokens(usage(Number.MAX_VALUE, {
      cache_creation_input_tokens: Number.MAX_VALUE,
      cache_read_input_tokens: Number.MAX_VALUE,
    }))).toBe(Number.MAX_VALUE);
  });
});

describe('request-envelope normalization', () => {
  it('keeps calibration when injected messages and the moving cache marker are cloned', () => {
    const budget = new TokenBudget(200_000, 128_000);
    const request: BudgetRequest = { systemPrompt: 'System', tools: [], messages: [
      { role: 'user', content: 'Date context', isMeta: true },
      { role: 'user', content: [{ type: 'text', text: 'Read evidence', cache_control: { type: 'ephemeral' } } as never] },
    ] };
    budget.observe(request, usage(52_000));
    const next: BudgetRequest = { ...request, messages: [
      { role: 'user', content: 'Date context', isMeta: true },
      { role: 'user', content: 'Read evidence' },
      { role: 'assistant', content: 'New evidence' },
    ] };
    expect(budget.estimateRequest(next)).toBeGreaterThan(52_000);
    expect(budget.estimateRequest(next)).toBeLessThan(52_100);
  });
});

describe('TokenBudget — calibration identity', () => {
  it('reuses an anchor when system blocks and tools are rebuilt without changing their content', () => {
    const budget = new TokenBudget(200_000);
    const request: BudgetRequest = { ...makeRequest(), model: 'first', thinking: { type: 'disabled' },
      systemPrompt: [{ type: 'text', text: 'Stable instructions' }] };
    budget.observe(request, usage(100));
    expect(budget.estimateRequest(structuredClone(request))).toBe(100);
  });

  it.each(['model', 'thinking'] as const)('rejects calibration after changing %s', part => {
    const budget = new TokenBudget(200_000);
    const request: BudgetRequest = { ...makeRequest(20_000), model: 'first', thinking: { type: 'disabled' } };
    budget.observe(request, usage(100));
    const changed: BudgetRequest = { ...request,
      ...(part === 'model' ? { model: 'second' } : { thinking: { type: 'enabled' as const, budgetTokens: 1024 } }),
    };
    expect(budget.estimateRequest(changed)).toBe(new TokenBudget(200_000).estimateRequest(changed));
  });
});

describe('TokenBudget — reservation', () => {
  it.each([32_768, 200_000, 1_000_000])('uses the supplied model context window (%i)', (contextWindow) => {
    const budget = new TokenBudget(contextWindow);
    expect(budget.contextWindow).toBe(contextWindow);
    expect(budget.maxOutputTokens).toBe(16_384);
    const reservation = Math.min(16_384, Math.floor(contextWindow / 4));
    expect(budget.outputReservationTokens).toBe(reservation);
    expect(budget.availableInputTokens).toBe(contextWindow - reservation);
    expect(budget.targetInputTokens).toBe(Math.floor((contextWindow - reservation) * 0.55));
  });

  it('uses the configured output reservation and floors the target', () => {
    const budget = new TokenBudget(10_001, 2_000);
    expect(budget.maxOutputTokens).toBe(2_000);
    expect(budget.availableInputTokens).toBe(8_001);
    expect(budget.targetInputTokens).toBe(4_400);
  });

  it.each([1_000, 2_000])('keeps a working input capacity when the output ceiling reaches the window (%i)', (outputTokens) => {
    const budget = new TokenBudget(1_000, outputTokens);
    expect(budget.outputReservationTokens).toBe(250);
    expect(budget.availableInputTokens).toBe(750);
    expect(budget.targetInputTokens).toBe(412);
    expect(budget.remainingInputTokens([])).toBe(750);
    expect(budget.usageRatio([])).toBe(0);
    expect(budget.shouldCompactRequest({ messages: [] })).toBe(false);
  });

  it.each([32_000, 128_000, 320_000, 640_000])('does not deduct a large user ceiling from input (%i)', ceiling => {
    const budget = new TokenBudget(150_000, ceiling);
    expect(budget.outputReservationTokens).toBe(20_000);
    expect(budget.availableInputTokens).toBe(130_000);
    expect(budget.requestMaxTokens(47_000)).toBe(Math.min(ceiling, 103_000));
  });

  it('reserves explicit thinking without lowering its effective budget', () => {
    const budget = new TokenBudget(150_000, 320_000);
    budget.configureOutput({ type: 'enabled', budgetTokens: 32_000 });
    expect(budget.outputReservationTokens).toBe(33_024);
    expect(budget.availableInputTokens).toBe(116_976);
    expect(budget.requestMaxTokens(115_000)).toBe(35_000);
  });

  it('applies only an explicitly supplied provider output ceiling and can release it', () => {
    const budget = new TokenBudget(150_000, 320_000);
    budget.configureOutput({ type: 'disabled' }, 8192);
    expect(budget.outputReservationTokens).toBe(8192);
    expect(budget.requestMaxTokens(1000)).toBe(8192);
    budget.configureOutput({ type: 'disabled' });
    expect(budget.requestMaxTokens(1000)).toBe(149_000);
    expect(budget.requestMaxTokens(150_000)).toBe(0);
    expect(budget.requestMaxTokens(151_000)).toBe(0);
  });

  it('keeps maintenance output independent of the answer ceiling and includes explicit reasoning', () => {
    expect(maintenanceOutputBudget(150_000)).toBe(20_000);
    expect(maintenanceOutputBudget(40_000)).toBe(10_000);
    expect(maintenanceOutputBudget(150_000, { type: 'enabled', budgetTokens: 32_000 })).toBe(52_000);
    expect(maintenanceOutputBudget(150_000, { type: 'adaptive' })).toBe(20_000);
    expect(effectiveThinking({ type: 'enabled', budgetTokens: 10_000 }, 8192)).toEqual({ type: 'enabled', budgetTokens: 8191 });
    expect(effectiveThinking({ type: 'adaptive' }, 300)).toEqual({ type: 'adaptive' });
  });

  it('compacts at exactly 90% of available input, not 90% of the context window', () => {
    const request = makeRequest();
    const budget = new TokenBudget(10_000, 2_000);
    budget.observe(request, usage(7_199));
    expect(budget.shouldCompactRequest(request)).toBe(false);
    budget.observe(request, usage(7_200));
    expect(budget.shouldCompactRequest(request)).toBe(true);
    budget.observe(request, usage(8_000));
    expect(budget.shouldCompactRequest(request)).toBe(true);
  });
});

describe('TokenBudget — complete local request estimates', () => {
  it('counts system, tools and messages with headroom over the content heuristic', () => {
    const budget = new TokenBudget(200_000);
    const request = makeRequest(4_000);
    const raw = tokens.estimateMessageTokens(request.messages) +
      tokens.estimateTokens(request.systemPrompt as string) +
      tokens.estimateTokens(JSON.stringify(request.tools![0]));
    expect(budget.estimateRequest(request)).toBeGreaterThan(raw);
    expect(budget.estimateRequest({ messages: [] })).toBe(0);
    expect(budget.estimateRequest({ messages: [], systemPrompt: '', tools: [] })).toBe(0);
  });

  it('counts structured system blocks without charging cache-control metadata as content', () => {
    const budget = new TokenBudget(200_000);
    const text = 'System policy. '.repeat(100);
    const plain = { messages: [], systemPrompt: text };
    const cached: BudgetRequest = {
      messages: [], systemPrompt: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }],
    };
    expect(budget.estimateRequest(cached)).toBe(budget.estimateRequest(plain));
    expect(budget.estimateRequest({
      messages: [], systemPrompt: [{ type: 'text', text }, { type: 'text', text }],
    })).toBe(2 * budget.estimateRequest(plain));
  });

  it.each(['messages', 'system', 'tools'])('accounts for dense CJK in %s', (part) => {
    const request = (text: string): BudgetRequest => ({
      messages: part === 'messages' ? [{ role: 'user', content: text }] : [],
      systemPrompt: part === 'system' ? text : undefined,
      tools: part === 'tools' ? [{ name: 'read', description: text, input_schema: { description: text } }] : [],
    });
    const budget = new TokenBudget(200_000);
    expect(budget.estimateRequest(request('中'.repeat(1_000)))).toBeGreaterThan(
      budget.estimateRequest(request('a'.repeat(1_000))) * 1.8,
    );
  });

  it.each(['system', 'tools'])('can trigger compaction from a %s-heavy request with tiny history', (part) => {
    const budget = new TokenBudget(10_000, 2_000);
    const request = makeRequest(20);
    if (part === 'system') request.systemPrompt = '中'.repeat(12_000);
    else request.tools = [{ name: 'large', description: 'a'.repeat(25_000), input_schema: { type: 'object' } }];
    expect(budget.shouldCompact(request.messages)).toBe(false);
    expect(budget.shouldCompactRequest(request)).toBe(true);
  });

  it('counts tool names, descriptions and nested JSON schemas', () => {
    const budget = new TokenBudget(200_000);
    const base: ToolDefinition = { name: 'read', description: 'Read.', input_schema: { type: 'object' } };
    const baseTokens = budget.estimateRequest({ messages: [], tools: [base] });
    for (const tool of [
      { ...base, name: 'long_name_'.repeat(100) },
      { ...base, description: 'description '.repeat(100) },
      { ...base, input_schema: { type: 'object', properties: { path: { description: '中'.repeat(1_000) } } } },
    ]) {
      expect(budget.estimateRequest({ messages: [], tools: [tool] })).toBeGreaterThan(baseTokens);
    }
  });

  it('includes internal injections and structured tool exchanges', () => {
    const budget = new TokenBudget(200_000);
    const request = makeRequest();
    const extra: Message[] = [
      { role: 'user', isMeta: true, content: 'Internal notice. '.repeat(100) },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Thinking. '.repeat(100) },
        { type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'file.txt' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [
        { type: 'text', text: 'File content. '.repeat(100) },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ] }] },
    ];
    const original = budget.estimateRequest(request);
    expect(budget.estimateRequest({ ...request, messages: [...request.messages, ...extra] })).toBe(
      original + budget.estimateRequest({ messages: extra }),
    );
    expect(budget.estimateRequest({ messages: extra })).toBeGreaterThan(tokens.estimateMessageTokens(extra));
  });
});

describe('TokenBudget — optional usage calibration', () => {
  it.each(incompleteUsage)('keeps local estimates with $name', ({ value }) => {
    const budget = new TokenBudget(200_000);
    const request = makeRequest(20_000);
    const local = budget.estimateRequest(request);
    budget.observe(request, value);
    expect(budget.estimateRequest(request)).toBe(local);
  });

  it.each(incompleteUsage)('preserves calibration and subsequent growth with $name', ({ value }) => {
    const budget = new TokenBudget(200_000);
    const request = makeRequest();
    budget.observe(request, usage(5_000));
    const additions = makeMessages(4_000);
    const grown = { ...request, messages: [...request.messages, ...additions] };
    budget.observe(grown, value);
    expect(budget.estimateRequest(request)).toBe(5_000);
    expect(budget.estimateRequest(grown)).toBe(5_000 + budget.estimateRequest({ messages: additions }));
  });

  it.each([100, 50_000])('uses complete input for the matching request, above or below the heuristic (%i)', (inputTokens) => {
    const budget = new TokenBudget(200_000);
    const request = makeRequest(4_000);
    budget.observe(request, usage(inputTokens));
    expect(budget.estimateRequest(request)).toBe(inputTokens);
  });

  it('treats explicit zero uncached input plus positive cache fields as a complete cached input', () => {
    const budget = new TokenBudget(200_000);
    const request = makeRequest();
    budget.observe(request, usage(0, { cache_read_input_tokens: 5_000, cache_creation_input_tokens: 500 }));
    expect(budget.estimateRequest(request)).toBe(5_500);
  });

  it('grows after an observation without multiplying fixed system/tool overhead', () => {
    const budget = new TokenBudget(200_000);
    const request = makeRequest(100);
    request.systemPrompt = 'System instructions. '.repeat(1_000);
    const additions = makeMessages(100);
    budget.observe(request, usage(40_000));
    request.messages.push(...additions);
    expect(budget.estimateRequest(request)).toBe(40_000 + budget.estimateRequest({ messages: additions }));
    expect(budget.estimateRequest(request)).toBeLessThan(41_000);
  });

  it('accounts for newly added system text, definitions and injected messages after usage', () => {
    const budget = new TokenBudget(200_000);
    const localBudget = new TokenBudget(200_000);
    const request = makeRequest();
    const localBefore = localBudget.estimateRequest(request);
    budget.observe(request, usage(2_000));
    request.systemPrompt += ' More system context. '.repeat(100);
    request.tools!.push({ name: 'write', description: 'Write a file.', input_schema: { type: 'object' } });
    request.messages.push({ role: 'user', isMeta: true, content: 'Injected context. '.repeat(100) });
    expect(budget.estimateRequest(request)).toBe(2_000 + localBudget.estimateRequest(request) - localBefore);
  });

  it('counts appended structured system blocks after usage', () => {
    const budget = new TokenBudget(200_000);
    const request: BudgetRequest = { messages: makeMessages(100), systemPrompt: [{ type: 'text', text: 'Original' }] };
    budget.observe(request, usage(1_000));
    const block: SystemPromptBlock = { type: 'text', text: 'New context. '.repeat(100) };
    (request.systemPrompt as SystemPromptBlock[]).push(block);
    expect(budget.estimateRequest(request)).toBe(1_000 + budget.estimateRequest({ messages: [], systemPrompt: [block] }));
  });

  it.each(['messages', 'system', 'tools'])('does not reuse an anchor for replaced %s', (part) => {
    const budget = new TokenBudget(200_000);
    const request = makeRequest();
    budget.observe(request, usage(40_000));
    const replacement = { ...request };
    if (part === 'messages') replacement.messages = makeMessages(200);
    else if (part === 'system') replacement.systemPrompt = 'A different system policy. '.repeat(100);
    else replacement.tools = [{ name: 'write', description: 'Write.'.repeat(100), input_schema: {} }];
    expect(budget.estimateRequest(replacement)).toBe(new TokenBudget(200_000).estimateRequest(replacement));
  });

  it('reanchors to the latest complete report', () => {
    const budget = new TokenBudget(200_000);
    const request = makeRequest();
    budget.observe(request, usage(1_000));
    request.messages.push(...makeMessages(1_000));
    budget.observe(request, usage(2_000));
    const additions = makeMessages(100);
    request.messages.push(...additions);
    expect(budget.estimateRequest(request)).toBe(2_000 + budget.estimateRequest({ messages: additions }));
  });

  it('keeps context estimates separate from billing and previously generated output', () => {
    const budget = new TokenBudget(200_000);
    const request = makeRequest();
    const billed = Object.freeze(usage(100, {
      output_tokens: 50_000, cache_creation_input_tokens: 200, cache_read_input_tokens: 4_700,
    }));
    budget.observe(request, billed);
    expect(budget.estimateRequest(request)).toBe(5_000);
    expect(billed.input_tokens).toBe(100);
    expect(billed.output_tokens).toBe(50_000);
    const reply: Message = { role: 'assistant', content: 'Actual retained reply.' };
    expect(budget.estimateRequest({ ...request, messages: [...request.messages, reply] })).toBe(
      5_000 + budget.estimateRequest({ messages: [reply] }),
    );
  });
});

describe('TokenBudget — cache lifetime and reset', () => {
  it('does not rescan old text or serialize unchanged schemas on subsequent turns', () => {
    const messageEstimate = vi.spyOn(tokens, 'estimateMessageTokens');
    const textEstimate = vi.spyOn(tokens, 'estimateTokens');
    const schemaRead = vi.fn(() => 'object');
    const request = makeRequest(100_000);
    request.tools![0].input_schema = { get type() { return schemaRead(); } };
    const budget = new TokenBudget(200_000);
    budget.estimateRequest(request);
    expect(schemaRead).toHaveBeenCalledTimes(1);
    const initialMessageCalls = messageEstimate.mock.calls.length;
    const initialTextCalls = textEstimate.mock.calls.length;
    for (let turn = 0; turn < 10; turn++) {
      budget.observe(request, usage(50_000 + turn));
      request.messages = [...request.messages, ...makeMessages(100)];
      request.tools = [...request.tools!];
      budget.estimateRequest(request);
    }
    expect(messageEstimate.mock.calls.length - initialMessageCalls).toBe(10);
    expect(textEstimate.mock.calls.length).toBe(initialTextCalls);
    expect(schemaRead).toHaveBeenCalledTimes(1);
  });

  it('caches structured system blocks even when the block array is rebuilt', () => {
    const textRead = vi.fn(() => 'System policy. '.repeat(1_000));
    const block: SystemPromptBlock = { type: 'text', get text() { return textRead(); } };
    const budget = new TokenBudget(200_000);
    budget.estimateRequest({ messages: [], systemPrompt: [block] });
    budget.estimateRequest({ messages: [], systemPrompt: [block] });
    expect(textRead).toHaveBeenCalledTimes(1);
  });

  it('clears calibration and all cached estimates after an in-place rewrite', () => {
    const budget = new TokenBudget(200_000);
    const block: SystemPromptBlock = { type: 'text', text: 'Original'.repeat(100) };
    const request = makeRequest(5_000);
    request.systemPrompt = [block];
    budget.observe(request, usage(50_000));
    request.messages[0].content = 'Short summary.';
    block.text = 'Changed system.';
    request.tools![0].description = 'Changed description.';
    budget.reset();
    expect(budget.estimateRequest(request)).toBe(new TokenBudget(200_000).estimateRequest(request));
    expect(budget.estimateRequest(request)).toBeLessThan(50_000);
    budget.observe(request, usage(300));
    expect(budget.estimateRequest(request)).toBe(300);
  });

  it('drops the cached system string and pending legacy count on reset', () => {
    const estimate = vi.spyOn(tokens, 'estimateTokens');
    const budget = new TokenBudget(200_000);
    const request: BudgetRequest = { messages: [], systemPrompt: 'System policy.' };
    budget.estimateRequest(request);
    budget.updateFromUsage(50_000);
    budget.reset();
    budget.estimateRequest(request);
    expect(estimate).toHaveBeenCalledTimes(2);
    expect(budget.currentInputTokens([])).toBe(0);
  });

  it('does not share calibration or cached content between budget instances', () => {
    const first = new TokenBudget(200_000);
    const second = new TokenBudget(200_000);
    const request = makeRequest();
    const local = second.estimateRequest(request);
    first.observe(request, usage(50_000));
    expect(second.estimateRequest(request)).toBe(local);
    expect(first.estimateRequest(request)).toBe(50_000);
  });
});

describe('TokenBudget — messages-only compatibility', () => {
  it('uses the complete-request estimator for messages-only calls', () => {
    const budget = new TokenBudget(200_000);
    const messages = makeMessages(4_000);
    expect(budget.currentInputTokens(messages)).toBe(budget.estimateRequest({ messages }));
    expect(budget.usageRatio([])).toBe(0);
  });

  it('anchors a legacy count to the next message snapshot, then grows with additions', () => {
    const budget = new TokenBudget(200_000);
    const messages = makeMessages(100);
    budget.updateFromUsage(50_000);
    expect(budget.currentInputTokens(messages)).toBe(50_000);
    const additions = makeMessages(1_000);
    expect(budget.currentInputTokens([...messages, ...additions])).toBe(
      50_000 + budget.estimateRequest({ messages: additions }),
    );
  });

  it('accepts sequential legacy updates and ignores zero or invalid ones', () => {
    const budget = new TokenBudget(200_000);
    budget.updateFromUsage(1_000);
    budget.updateFromUsage(2_000);
    expect(budget.currentInputTokens([])).toBe(2_000);
    for (const invalid of [0, -1, NaN, Infinity]) {
      budget.updateFromUsage(invalid);
      expect(budget.currentInputTokens([])).toBe(2_000);
    }
  });

  it('retains remaining-budget, ratio, compaction and summary APIs', () => {
    const budget = new TokenBudget(200_000, 16_384);
    budget.updateFromUsage(91_808);
    expect(budget.remainingInputTokens([])).toBe(91_808);
    expect(budget.usageRatio([])).toBe(0.5);
    expect(budget.shouldCompact([])).toBe(false);
    expect(budget.summary([])).toContain('50.0%');
    expect(budget.summary([])).toContain((200_000).toLocaleString());
    budget.updateFromUsage(Math.ceil(183_616 * 0.9));
    expect(budget.shouldCompact([])).toBe(true);
    budget.updateFromUsage(500_000);
    expect(budget.remainingInputTokens([])).toBe(0);
    expect(budget.usageRatio([])).toBe(1);
    expect(budget).not.toHaveProperty('shouldReduceToolResults');
  });
});
