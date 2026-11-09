import { describe, expect, it, vi } from 'vitest';
import { queryLoop } from './query-loop.js';
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
  it('uses the selected model profile, then fallback, then a later explicit selection', async () => {
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
    for await (const message of queryLoop(config(), provider, [tool], 'Proceed.', { configOverrides: overrides })) {
      if (message.type === 'result') expect(message.is_error).toBe(false);
    }
    expect(requests.map(request => request.model)).toEqual(['initial', 'selected', 'fallback', 'final']);
    expect(requests.map(request => promptText(request).includes('# Execution checkpoints')))
      .toEqual([false, true, false, false]);
    for (const request of requests) {
      expect(promptText(request)).toContain(`model ${request.model}.`);
    }
    expect(overrides.model).toBeUndefined();
    expect(probes.execSync).toHaveBeenCalledTimes(process.platform === 'win32' ? 1 : 2);
  });

  it('keeps stable profile content identical across retries and does not rebuild the environment', async () => {
    const { provider, requests } = fixture(['tool', 'answer']);
    const cfg = config();
    cfg.model = 'selected';
    const tool: Tool = {
      name: 'Continue', description: 'Advance the fixture', permissionLevel: 'none',
      inputSchema: { type: 'object', properties: {} },
      async execute() { return { content: 'Ready.', isError: false }; },
    };
    probes.execSync.mockClear();
    for await (const message of queryLoop(cfg, provider, [tool], 'Proceed.')) void message;
    expect(requests).toHaveLength(2);
    expect(requests[0].systemPrompt).toBe(requests[1].systemPrompt);
    expect(probes.execSync).toHaveBeenCalledTimes(process.platform === 'win32' ? 1 : 2);
  });

  it('preserves a custom string byte-for-byte, even when it contains the preset boundary marker', async () => {
    const { provider, requests } = fixture(['fallback', 'answer']);
    const cfg = config();
    const custom = `  Custom text.\n${PROMPT_CACHE_BOUNDARY}\n Keep these spaces.  `;
    cfg.systemPrompt = custom;
    cfg.promptProfile = 'explicit';
    probes.execSync.mockClear();
    for await (const message of queryLoop(cfg, provider, [], 'Proceed.')) void message;
    expect(requests.map(request => request.systemPrompt)).toEqual([custom, custom]);
    expect(probes.execSync).not.toHaveBeenCalled();
  });
});
