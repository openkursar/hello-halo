import { describe, expect, it } from 'vitest';
import { queryLoop, resolveQueryConfig } from '../index.js';
import type { LlmProvider, Message, ProviderRequest, StreamEvent } from '../types/provider.js';
import type { Tool } from '../types/tool.js';

const skill: Tool = {
  name: 'Skill', description: 'Load workflow instructions', permissionLevel: 'none',
  inputSchema: { type: 'object' },
  async execute() { return { content: 'Loaded.', isError: false }; },
};
const continuation: Tool = { ...skill, name: 'Continue' };

function history(body = 'Selected workflow instructions.'): Message[] {
  return [
    { role: 'user', content: 'Complete the authorized task.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'skill-call', name: 'Skill', input: { skill: 'commit' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'skill-call', content: body }] },
  ];
}

function text(messages: readonly Message[]): string {
  return JSON.stringify(messages);
}

async function run(messages: Message[], options: { full?: boolean; micro?: boolean; enabled?: boolean } = {}) {
  const requests: ProviderRequest[] = [];
  const rewritten: Message[][] = [];
  let summaries = 0;
  const provider: LlmProvider = {
    id: 'fixture', name: 'Fixture',
    capabilities: () => ({
      streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false,
      systemPromptStyle: 'top_level',
    }),
    async createMessage(request) {
      summaries++;
      return {
        id: 'summary', model: request.model, content: [{ type: 'text', text: 'The authorized task is still active.' }],
        stopReason: 'end_turn', usage: { input_tokens: 50, output_tokens: 10 },
      };
    },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const first = requests.length === 0;
      requests.push(request);
      const continueWork = first && options.full;
      const usage = { input_tokens: 0, output_tokens: 10 };
      yield { type: 'message_start', id: `answer-${requests.length}`, model: request.model, usage };
      yield {
        type: 'content_block_start', index: 0,
        content_block: continueWork
          ? { type: 'tool_use', id: 'next-step', name: 'Continue', input: {} }
          : { type: 'text', text: 'Complete.' },
      };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: continueWork ? 'tool_use' : 'end_turn', usage };
      yield { type: 'message_stop' };
    },
  };
  const config = resolveQueryConfig({
    model: 'fixture', maxTurns: 3, contextWindow: 10_000, maxOutputTokens: 1000,
    toolResultBudget: options.micro ? 64 : 0,
    systemPrompt: 'Fixture.', cwd: '/tmp', settingSources: [],
    env: { HOME: '/tmp/sdk-skill-recovery-empty-home' },
    permissionMode: 'bypassPermissions', thinking: { type: 'disabled' },
    turnEndChecks: { openWork: false, completion: false },
  });
  const tools = options.enabled === false ? [continuation] : [skill, continuation];
  for await (const message of queryLoop(config, provider, tools, messages, {
    onHistoryCompacted: next => { rewritten.push([...next]); },
  })) {
    if (message.type === 'result') expect(message.is_error).toBe(false);
  }
  return { requests, rewritten, summaries };
}

describe('skills across context rewrites', () => {
  it('keeps an old skill body while context fits, regardless of the per-result ingress cap', async () => {
    const messages = history('distinct-old-instruction '.repeat(160));
    for (let index = 0; index < 2; index++) {
      messages.push(
        { role: 'assistant', content: [{ type: 'tool_use', id: `recent-${index}`, name: 'Continue', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `recent-${index}`, content: 'Recent.' }] },
      );
    }
    const { requests, rewritten } = await run(messages, { micro: true });
    expect(rewritten).toHaveLength(0);
    expect(text(requests[0].messages)).toContain('distinct-old-instruction');
    expect(text(requests[0].messages)).toContain('commit');
  });

  it('retains a reload reference when a summary replaces the invocation', async () => {
    const messages = history();
    messages.push({ role: 'assistant', content: 'Old context. '.repeat(2600) });
    for (let index = 0; index < 16; index++) {
      messages.push({ role: index % 2 ? 'assistant' : 'user', content: `Recent ${index}.` });
    }
    const { requests, rewritten } = await run(messages);
    expect(rewritten.length).toBeGreaterThan(0);
    expect(text(requests[0].messages)).not.toContain('skill-call');
    expect(text(requests[0].messages)).toContain('<active-skills>');
  });

  it('restores the reference after an LLM summary without restoring the full body', async () => {
    const messages = history();
    messages.push({ role: 'assistant', content: 'Earlier evidence. '.repeat(2200) });
    for (let index = 0; index < 16; index++) {
      messages.push({ role: index % 2 ? 'user' : 'assistant', content: `Earlier ${index}.` });
    }
    const { requests, summaries } = await run(messages, { full: true });
    expect(summaries).toBe(1);
    expect(text(requests[1].messages)).toContain('<active-skills>');
    expect(text(requests[1].messages)).not.toContain('Selected workflow instructions.');
  });

  it('does not tell a session to reload skills when that tool is disabled', async () => {
    const messages = history();
    messages.push({ role: 'assistant', content: 'Earlier evidence. '.repeat(2200) });
    for (let index = 0; index < 16; index++) {
      messages.push({ role: index % 2 ? 'user' : 'assistant', content: `Earlier ${index}.` });
    }
    const { requests, summaries } = await run(messages, { full: true, enabled: false });
    expect(summaries).toBe(1);
    expect(text(requests[1].messages)).not.toContain('<active-skills>');
  });
});
