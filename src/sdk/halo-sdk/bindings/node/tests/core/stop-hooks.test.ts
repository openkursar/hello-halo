import { describe, it, expect, vi } from 'vitest';
import { queryLoop, runHooks, runEventHooks } from '../../index.js';
import type { HookCallbackMatcher, QueryConfig } from '../../types/config.js';
import type { LlmProvider, ProviderRequest, StreamEvent } from '../../types/provider.js';
import type { SDKMessage } from '../../contracts/core/query-types.js';
import { getTranscriptPath } from './session-history.fixture.js';

function makeStopHooks(hook: HookCallbackMatcher['hooks'][number]) {
  return { Stop: [{ hooks: [hook] }] };
}

function makeConfig(overrides: Partial<QueryConfig> = {}): QueryConfig {
  return {
    model: 'stop-test', contextWindow: 200_000, maxTurns: 3,
    cwd: '/tmp', env: {}, permissionMode: 'bypassPermissions',
    systemPrompt: 'Answer the user.', thinking: { type: 'disabled' },
    abortSignal: new AbortController().signal, ...overrides,
  } as QueryConfig;
}

function makeProvider() {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'stop-test', name: 'Stop test',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false,
      imageInput: false, pdfInput: false, audioInput: false, videoInput: false,
      caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Streaming only'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      requests.push(structuredClone(request));
      yield { type: 'message_start', id: `stop-${requests.length}`, model: request.model,
        usage: { input_tokens: 10, output_tokens: 5 } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'text_delta', index: 0, text: `answer ${requests.length}` };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests };
}

async function collect(config: QueryConfig) {
  const { provider, requests } = makeProvider();
  const messages: SDKMessage[] = [];
  for await (const message of queryLoop(config, provider, [], 'Finish the task.')) messages.push(message);
  return { messages, requests };
}

describe('native Stop hooks', () => {
  it('uses the per-session environment and conventions for the actual loop hook', async () => {
    const hook = vi.fn().mockResolvedValue({});
    const config = makeConfig({ hooks: makeStopHooks(hook),
      env: { SDK_CONFIG: '/tmp/sdk-stop-store' }, conventions: { configDirEnv: 'SDK_CONFIG' } });
    await collect(config);
    expect(hook).toHaveBeenCalledOnce();
    const input = hook.mock.calls[0][0];
    expect(input.transcript_path).toBe(getTranscriptPath(input.session_id, config.cwd, config));
    expect(input.stop_hook_active).toBe(false);
  });

  it.each([undefined, { Stop: [] }])('finishes without notifications when hooks are %j', async (hooks) => {
    expect(await runEventHooks(hooks, 'Stop', {}, new AbortController().signal)).toEqual([]);
    const { messages, requests } = await collect(makeConfig({ hooks }));
    expect(requests).toHaveLength(1);
    expect(messages.filter(message => message.type === 'system' && message.subtype.startsWith('hook_'))).toEqual([]);
    expect(messages.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
  });

  it.each([
    [{ blockingError: 'please retry with X' }, 'please retry with X'],
    [{ decision: 'block', reason: 'must finish task #42 first' }, 'must finish task #42 first'],
    [{ decision: 'block', systemMessage: 'system-level notice' }, 'system-level notice'],
    [{ decision: 'block' }, 'Stop hook blocked continuation.'],
  ])('continues with the blocking feedback %j', async (output, feedback) => {
    const hook = vi.fn().mockResolvedValueOnce(output).mockResolvedValue({});
    const { messages, requests } = await collect(makeConfig({ hooks: makeStopHooks(hook) }));
    expect(requests).toHaveLength(2);
    expect(requests[1].messages).toContainEqual({ role: 'user', content: feedback, isMeta: true });
    expect(hook).toHaveBeenCalledTimes(2);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'system', subtype: 'hook_response',
      hook_event: 'Stop', outcome: 'error', output: feedback, stdout: feedback }));
    const started = messages.filter(message => message.type === 'system' && message.subtype === 'hook_started');
    expect(started).toHaveLength(2);
    expect(messages.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
  });

  it('honours preventContinuation without another model request', async () => {
    const hook = vi.fn().mockResolvedValue({ preventContinuation: true });
    const { requests, messages } = await collect(makeConfig({ hooks: makeStopHooks(hook) }));
    expect(requests).toHaveLength(1);
    expect(hook).toHaveBeenCalledOnce();
    expect(messages.some(message => message.type === 'result')).toBe(false);
    expect(messages.at(-1)).toMatchObject({ type: 'system', subtype: 'hook_response', outcome: 'success' });
  });

  it('ignores non-block decisions in the loop and preserves public hook output', async () => {
    const output = { decision: 'approve', reason: 'ok' };
    const hook = vi.fn().mockResolvedValue(output);
    expect(await runHooks('Stop', makeStopHooks(hook).Stop, {}, undefined, new AbortController().signal)).toEqual([output]);
    expect(await runEventHooks(makeStopHooks(hook), 'Stop', {}, new AbortController().signal)).toEqual([output]);
    const { requests, messages } = await collect(makeConfig({ hooks: makeStopHooks(hook) }));
    expect(requests).toHaveLength(1);
    expect(messages).not.toContainEqual(expect.objectContaining({ subtype: 'hook_response', outcome: 'error' }));
    expect(messages.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
  });

  it('does not invoke hooks or the provider after cancellation before the run', async () => {
    const controller = new AbortController();
    controller.abort();
    const hook = vi.fn().mockResolvedValue({});
    expect(await runEventHooks(makeStopHooks(hook), 'Stop', {}, controller.signal)).toEqual([]);
    const { requests, messages } = await collect(makeConfig({ hooks: makeStopHooks(hook), abortSignal: controller.signal }));
    expect(hook).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(messages.at(-1)).toMatchObject({ type: 'result' });
  });
});
