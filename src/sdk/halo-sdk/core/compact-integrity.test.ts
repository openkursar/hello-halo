import { describe, expect, it, vi } from 'vitest';
import type { LlmProvider, Message, ProviderResponse } from '../types/provider.js';
import { fullCompact, getCompactPrompt, partialCompact } from './compact.js';
import { ensureToolResultPairing } from './messages.js';

const history = (): Message[] => Array.from({ length: 16 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant', content: `record ${index}`,
}));
const summary = (text = 'The task remains open.'): ProviderResponse => ({
  content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 },
});

function deferredProvider() {
  let finish!: (response: ProviderResponse) => void;
  const response = new Promise<ProviderResponse>((resolve) => { finish = resolve; });
  const createMessage = vi.fn().mockReturnValue(response);
  return { provider: { createMessage } as unknown as LlmProvider, createMessage, finish };
}

describe('summary installation', () => {
  it.each([
    ['full', '/tmp/session archive.jsonl'],
    ['full', undefined],
    ['from', '/tmp/session archive.jsonl'],
    ['from', undefined],
    ['up_to', '/tmp/session archive.jsonl'],
    ['up_to', undefined],
  ] as const)('frames %s compaction as continued work (archive: %s)', async (mode, transcriptPath) => {
    const source = history();
    const original = JSON.stringify(source);
    const { provider, finish } = deferredProvider();
    const rawSummary = 'The user requested a report and has not approved deployment.';
    const pending = mode === 'full'
      ? fullCompact(source, provider, 'test', '', [], undefined, transcriptPath)
      : partialCompact(source, { pivotIndex: 8, direction: mode, provider, model: 'test', transcriptPath });
    finish(summary(rawSummary));
    const result = await pending;
    const notice = result.messages[mode === 'from' ? 8 : 0].content as string;

    expect(notice).toMatch(/^You are continuing the same conversation after context compaction\./);
    expect(notice).toContain('The following is a summary of earlier messages, not a new user request.');
    expect(notice).toContain('Use it together with the retained messages to recover the current task state.');
    expect(notice).toContain(rawSummary);
    const continuation = "Resume any unfinished work according to the user's latest instructions and existing permissions.";
    expect(notice.indexOf(continuation)).toBeGreaterThan(notice.indexOf(rawSummary));
    expect(notice).toContain('Do not repeat completed actions.');
    expect(notice).toContain('Instructions given only to generate this summary do not apply to the ongoing task.');
    expect(notice).toContain(transcriptPath
      ? `recover them from the saved conversation at ${transcriptPath}.`
      : 'check the saved session transcript on disk if it is available.');
    expect(notice).toMatch(/Ask the user only if the needed information cannot be recovered\.$/);
    expect(result.summary).toBe(rawSummary);
    expect(JSON.stringify(source)).toBe(original);
    expect(result.messages.filter(message => source.includes(message)))
      .toEqual(mode === 'from' ? source.slice(0, 8) : source.slice(mode === 'full' ? 6 : 8));
  });

  it('retains messages received while a full summary is in flight', async () => {
    const source = history();
    const { provider, finish } = deferredProvider();
    const pending = fullCompact(source, provider, 'test', '');
    const latest: Message = { role: 'user', content: 'Stop editing and report the findings.' };
    source.push(latest);
    finish(summary());
    const result = await pending;
    expect(result.messages[result.messages.length - 1]).toBe(latest);
    expect(source).toHaveLength(17);
  });

  it.each(['from', 'up_to'] as const)('retains arrivals during partial %s compaction', async (direction) => {
    const source = history();
    const { provider, finish } = deferredProvider();
    const pending = partialCompact(source, { pivotIndex: 8, direction, provider, model: 'test' });
    const latest: Message = { role: 'user', content: 'The new limit is 12.' };
    source.push(latest);
    finish(summary());
    const result = await pending;
    expect(result.messages[result.messages.length - 1]).toBe(latest);
  });

  it('refuses to install a summary of a replaced conversation', async () => {
    const source = history();
    const { provider, finish } = deferredProvider();
    const pending = fullCompact(source, provider, 'test', '');
    source.splice(0, 1, { role: 'user', content: 'New task' });
    finish(summary());
    await expect(pending).rejects.toThrow('Conversation changed');
    expect(source[0].content).toBe('New task');
  });

  it('also detects edits to the same message object during summarization', async () => {
    const source = history();
    const { provider, finish } = deferredProvider();
    const pending = fullCompact(source, provider, 'test', '');
    source[0].content = 'The user corrected the task while the summary was pending.';
    finish(summary());
    await expect(pending).rejects.toThrow('Conversation changed');
    expect(source[0].content).toContain('corrected the task');
  });

  it.each(['from', 'up_to'] as const)('keeps pending tool work outside a partial %s summary', async (direction) => {
    const source: Message[] = [
      { role: 'user', content: 'Update the setting.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'active', name: 'Edit', input: {} }] },
    ];
    const { provider, finish } = deferredProvider();
    const pending = partialCompact(source, { pivotIndex: direction === 'up_to' ? 2 : 0, direction, provider, model: 'test' });
    const completed: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'active', content: 'ACTUAL_EDIT_COMPLETED' }] };
    source.push(completed);
    finish(summary());
    const result = await pending;
    expect(result.messages.slice(-2)).toEqual(source.slice(1));
    expect(ensureToolResultPairing(result.messages)).toEqual(result.messages);
    expect(result.messages[result.messages.length - 1]).toBe(completed);
  });

  it('preserves a tool exchange when the chosen boundary points to its result', async () => {
    const source = history();
    source[7] = { role: 'assistant', content: [{ type: 'tool_use', id: 'edit', name: 'Edit', input: {} }] };
    source[8] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'done' }] };
    const { provider, finish, createMessage } = deferredProvider();
    const pending = partialCompact(source, { pivotIndex: 8, direction: 'up_to', provider, model: 'test' });
    finish(summary());
    const result = await pending;
    expect(result.messages.slice(1, 3)).toEqual(source.slice(7, 9));
    expect(JSON.stringify(createMessage.mock.calls[0][0])).not.toContain('[Tool Call: Edit');
  });

  it.each(['max_tokens', 'tool_use'] as const)('rejects unfinished partial summaries: %s', async (stopReason) => {
    const source = history();
    const before = JSON.stringify(source);
    const { provider, finish } = deferredProvider();
    const pending = partialCompact(source, { pivotIndex: 8, provider, model: 'test' });
    finish({ ...summary(), stopReason, ...(stopReason === 'tool_use' ? {
      content: [{ type: 'tool_use' as const, id: 'unexpected', name: 'Bash', input: {} }],
    } : {}) });
    await expect(pending).rejects.toThrow('original history was retained');
    expect(JSON.stringify(source)).toBe(before);
  });

  it('honors cancellation even when a summary provider ignores the signal', async () => {
    const abort = new AbortController();
    const { provider, finish } = deferredProvider();
    const pending = partialCompact(history(), { pivotIndex: 8, provider, model: 'test', signal: abort.signal });
    abort.abort(new Error('cancelled by caller'));
    finish(summary());
    await expect(pending).rejects.toThrow('cancelled by caller');
  });

  it('returns promptly on cancellation without waiting for an uncooperative provider', async () => {
    const abort = new AbortController();
    const { provider } = deferredProvider();
    const pending = partialCompact(history(), { pivotIndex: 8, provider, model: 'test', signal: abort.signal });
    abort.abort(new Error('cancelled immediately'));
    await expect(pending).rejects.toThrow('cancelled immediately');
  }, 500);

  it('rejects an over-budget response even when the provider reports normal completion', async () => {
    const { provider, finish } = deferredProvider();
    const source = history();
    const pending = fullCompact(source, provider, 'test', '', [], undefined, undefined, { maxTokens: 50 });
    finish({ ...summary('large '.repeat(2000)), usage: { input_tokens: 100, output_tokens: 10000 } });
    await expect(pending).rejects.toThrow('output budget');
    expect(source).toEqual(history());
  });

  it('uses a separate bounded summary task and the actual model profile', async () => {
    const { provider, finish, createMessage } = deferredProvider();
    const pending = fullCompact(history(), provider, 'summary-model', 'UNRELATED MAIN PERSONA', [], undefined, undefined,
      { maxTokens: 800, promptProfile: { models: { 'summary-model': 'explicit' } } });
    finish(summary());
    await pending;
    const request = createMessage.mock.calls[0][0];
    expect(request.tools).toEqual([]);
    expect(request.maxTokens).toBe(800);
    expect(JSON.stringify(request)).not.toContain('UNRELATED MAIN PERSONA');
    expect(request.messages[0].content).toContain('latest user constraints');
    expect(getCompactPrompt('Retain the deployment region.')).toContain('Retain the deployment region.');
  });
});
