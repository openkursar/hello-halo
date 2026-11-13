import { describe, expect, it, vi } from 'vitest';
import { queryLoop, createSession } from '../index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveQueryConfig } from './context.js';
import type { MutableConfigOverrides } from './query-types.js';
import type { Tool } from '../types/tool.js';
import type { LlmProvider, ProviderRequest, StreamEvent } from '../types/provider.js';
import { ModelFallbackError } from '../utils/errors.js';
import { PROMPT_CACHE_BOUNDARY } from '../prompt/constants.js';

const probes = vi.hoisted(() => ({ execSync: vi.fn(() => 'fixture') }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execSync: probes.execSync,
}));

function promptText(request: ProviderRequest): string {
  return typeof request.systemPrompt === 'string'
    ? request.systemPrompt
    : request.systemPrompt?.map(block => block.text).join('\n') ?? '';
}

type Step = 'answer' | 'tool' | 'fallback';

function fixture(steps: Step[]) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'fixture',
    name: 'Fixture',
    capabilities: () => ({
      streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: true,
      systemPromptStyle: 'top_level',
    }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const index = requests.length;
      requests.push(request);
      const step = steps[index] ?? 'answer';
      if (step === 'fallback') throw new ModelFallbackError('Fixture model unavailable');
      const usage = { input_tokens: 10, output_tokens: 5 };
      yield { type: 'message_start', id: `message-${index}`, model: request.model, usage };
      yield {
        type: 'content_block_start', index: 0,
        content_block: step === 'tool'
          ? { type: 'tool_use', id: `call-${index}`, name: 'Continue', input: {} }
          : { type: 'text', text: 'Complete.' },
      };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: step === 'tool' ? 'tool_use' : 'end_turn', usage };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests };
}

function config() {
  return resolveQueryConfig({
    model: 'initial',
    fallbackModel: 'fallback',
    promptProfile: { models: { selected: 'explicit' } },
    maxTurns: 8,
    cwd: '/tmp',
    settingSources: [],
    permissionMode: 'bypassPermissions',
    thinking: { type: 'disabled' },
    turnEndChecks: { openWork: false, completion: false },
  });
}

describe('request model and prompt profile', () => {
  it.each([undefined, false, true])('carries the explicit work approach into native session requests (%s)', async ultraEffort => {
    const directory = await mkdtemp(join(tmpdir(), 'sdk-work-approach-'));
    const { provider, requests } = fixture(['answer', 'answer', 'answer']);
    const session = await createSession({
      model: 'initial', provider, ultraEffort,
      promptProfile: { models: { selected: 'explicit' } },
      systemPrompt: { type: 'preset', preset: 'default', append: 'Caller instructions.' },
      cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: directory },
      tools: [], collaboration: false, persistSession: false, settingSources: [],
      maxOutputTokens: 512, maxTurns: 3, maxBudgetUsd: 1, effort: 'low', thinking: { type: 'disabled' },
      turnEndChecks: { openWork: false, completion: false },
    });
    try {
      for (const model of ['initial', 'initial', 'selected']) {
        session.setModel(model);
        await session.send('Answer the question.');
        let succeeded = false;
        for await (const event of session.stream()) {
          if (event.type === 'result') succeeded = !event.is_error;
        }
        expect(succeeded).toBe(true);
      }
      expect(requests).toHaveLength(3);
      expect(requests[0].systemPrompt).toEqual(requests[1].systemPrompt);
      for (const request of requests) {
        const prompt = promptText(request);
        expect(prompt.includes("Put your fullest effort into solving the user's task")).toBe(ultraEffort === true);
        expect(prompt.includes("Fulfill the user's request efficiently")).toBe(ultraEffort !== true);
        expect(prompt).toContain('# Communicating');
        expect(prompt.match(/Caller instructions\./g)).toHaveLength(1);
        expect(request.maxTokens).toBe(512);
        expect(request.thinking).toEqual({ type: 'disabled' });
        expect(request.providerOptions?.effort).toBe('low');
        expect(request.temperature).toBe(0);
      }
      expect(promptText(requests[2])).toContain('# Execution checkpoints');
    } finally {
      await session[Symbol.asyncDispose]();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])('preserves the work approach through profile selection, fallback and a later model (%s)', async ultraEffort => {
    const { provider, requests } = fixture(['tool', 'fallback', 'tool', 'answer']);
    const overrides: MutableConfigOverrides = {};
    let calls = 0;
    const tool: Tool = {
      name: 'Continue', description: 'Advance the fixture', permissionLevel: 'none',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        overrides.model = calls++ === 0 ? 'selected' : 'final';
        return { content: 'Ready.', isError: false };
      },
    };
    probes.execSync.mockClear();
    for await (const message of queryLoop({ ...config(), ultraEffort }, provider, [tool], 'Proceed.', { configOverrides: overrides })) {
      if (message.type === 'result') expect(message.is_error).toBe(false);
    }
    expect(requests.map(request => request.model)).toEqual(['initial', 'selected', 'fallback', 'final']);
    expect(requests.map(request => promptText(request).includes('# Execution checkpoints')))
      .toEqual([false, true, false, false]);
    for (const request of requests) {
      expect(promptText(request)).toContain(`model ${request.model}.`);
      expect(promptText(request).includes("Put your fullest effort into solving the user's task")).toBe(ultraEffort);
      expect(promptText(request)).toContain('# Communicating');
    }
    expect(overrides.model).toBeUndefined();
    // Profile preparation runs no shell command from JavaScript.
    expect(probes.execSync).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps stable profile content identical across tool steps (%s)', async ultraEffort => {
    const { provider, requests } = fixture(['tool', 'answer']);
    const cfg = { ...config(), ultraEffort };
    cfg.model = 'selected';
    const tool: Tool = {
      name: 'Continue', description: 'Advance the fixture', permissionLevel: 'none',
      inputSchema: { type: 'object', properties: {} },
      async execute() { return { content: 'Ready.', isError: false }; },
    };
    probes.execSync.mockClear();
    for await (const message of queryLoop(cfg, provider, [tool], 'Proceed.')) void message;
    expect(requests).toHaveLength(2);
    expect(requests[0].systemPrompt).toStrictEqual(requests[1].systemPrompt);
    expect(probes.execSync).not.toHaveBeenCalled();
  });

  it.each(['', `  Custom text.\n${PROMPT_CACHE_BOUNDARY}\n Keep these spaces.  `])('preserves a custom string byte-for-byte with maximal effort (%s)', async custom => {
    const { provider, requests } = fixture(['fallback', 'answer']);
    const cfg = { ...config(), ultraEffort: true };
    cfg.systemPrompt = custom;
    cfg.promptProfile = 'explicit';
    probes.execSync.mockClear();
    for await (const message of queryLoop(cfg, provider, [], 'Proceed.')) void message;
    expect(requests.map(request => request.systemPrompt)).toEqual([custom, custom]);
    expect(probes.execSync).not.toHaveBeenCalled();
  });
});
