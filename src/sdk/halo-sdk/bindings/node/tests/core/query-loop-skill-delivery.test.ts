import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, type SDKSession } from '../../index.js';
import type { SDKMessage } from '../../contracts/core/query-types.js';
import type {
  LlmProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  UsageInfo,
} from '../../types/provider.js';

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

function usage(): UsageInfo {
  return { input_tokens: 10, output_tokens: 20 };
}

function textStream(text: string): StreamEvent[] {
  return [
    { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: usage() },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'text_delta', index: 0, text },
    { type: 'content_block_stop', index: 0 },
  ];
}

function toolUseStream(name: string, input: Record<string, unknown>): StreamEvent[] {
  return [
    { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: usage() },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${randomUUID().slice(0, 8)}`, name, input: {} } },
    { type: 'input_json_delta', index: 0, partialJson: JSON.stringify(input) },
    { type: 'content_block_stop', index: 0 },
  ];
}

function scriptedProvider(replies: { events: StreamEvent[]; stop?: 'end_turn' | 'tool_use' }[]): {
  provider: LlmProvider;
  requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  let index = 0;
  return {
    requests,
    provider: {
      id: 'scripted',
      name: 'Scripted',
      capabilities: () => TEST_CAPS,
      async createMessage(): Promise<ProviderResponse> {
        return { id: `msg_${randomUUID()}`, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: usage(), model: 'test-model' };
      },
      async *createMessageStream(request): AsyncGenerator<StreamEvent> {
        requests.push(request);
        const reply = replies[Math.min(index, replies.length - 1)];
        index += 1;
        for (const event of reply.events) yield event;
        yield { type: 'message_delta', stopReason: reply.stop ?? 'end_turn', usage: usage() };
        yield { type: 'message_stop' };
      },
    },
  };
}

async function driveTurn(session: SDKSession): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const message of session.stream()) {
    messages.push(message);
    const state = (message as unknown as Record<string, unknown>).state;
    if ((message as unknown as Record<string, unknown>).subtype === 'session_state_changed' && state === 'idle') break;
    if (messages.length > 500) throw new Error('turn did not reach idle');
  }
  return messages;
}

async function runSkillBody(size: number): Promise<{ requests: ProviderRequest[]; text: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'halo-sdk-skill-delivery-'));
  const skill = join(directory, 'large.md');
  const body = `BEGIN-${size}\n${'A'.repeat(size)}\nEND-${size}`;
  writeFileSync(skill, `---\ndescription: Large delivery fixture\n---\n${body}`);
  const { provider, requests } = scriptedProvider([
    { events: toolUseStream('Skill', { skill: 'large' }), stop: 'tool_use' },
    { events: textStream('followed the instructions') },
  ]);
  const session = await createSession({
    provider,
    cwd: directory,
    env: { HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: join(directory, 'state') },
    settingSources: [],
    model: 'test-model',
    permissionMode: 'bypassPermissions',
    persistSession: false,
    tools: ['Skill'],
    skillCatalog: [{ name: 'large', description: 'Large delivery fixture', source: { kind: 'file', path: skill } }],
    toolResultBudget: 64,
    maxTurns: 4,
    systemPrompt: 'Fixture.',
  } as Parameters<typeof createSession>[0]);
  try {
    await session.send('follow the large skill');
    await driveTurn(session);
    const text = JSON.stringify(requests[1]?.messages ?? []);
    return { requests, text };
  } finally {
    session.close();
    await session.flush();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Skill list delivery', () => {
  it('keeps list results under the normal tool-result budget', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'halo-sdk-skill-list-'));
    const skill = join(directory, 'fixture.md');
    writeFileSync(skill, '---\ndescription: Fixture\n---\nBODY');
    const catalog = Array.from({ length: 120 }, (_, index) => ({
      name: `fixture-${String(index).padStart(3, '0')}`,
      description: `entry-${String(index).padStart(3, '0')}-${'d'.repeat(180)}`,
      source: { kind: 'file', path: skill },
    }));
    const { provider, requests } = scriptedProvider([
      { events: toolUseStream('Skill', { skill: 'list' }), stop: 'tool_use' },
      { events: textStream('listed') },
    ]);
    const session = await createSession({
      provider,
      cwd: directory,
      env: { HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: join(directory, 'state') },
      settingSources: [],
      model: 'test-model',
      permissionMode: 'bypassPermissions',
      persistSession: false,
      tools: ['Skill'],
      skillCatalog: catalog,
      toolResultBudget: 1_000,
      maxTurns: 4,
      systemPrompt: 'Fixture.',
    } as Parameters<typeof createSession>[0]);
    try {
      await session.send('list the skills');
      await driveTurn(session);
      const results = requests[1]?.messages.flatMap(message =>
        Array.isArray(message.content)
          ? message.content.filter(block => block.type === 'tool_result')
          : [],
      ) ?? [];
      const text = String(results.find(block => typeof block.content === 'string')?.content ?? '');
      expect(text).toContain('[Content truncated:');
      expect(text.length).toBeLessThanOrEqual(1_000);
      expect(text).not.toContain('fixture-119');
    } finally {
      session.close();
      await session.flush();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('Skill instruction delivery', () => {
  for (const size of [60_000, 100_000]) {
    it(`keeps a ${size}-character instruction body complete in the next model request`, async () => {
      const { text } = await runSkillBody(size);
      expect(text).toContain(`BEGIN-${size}`);
      expect(text).toContain(`END-${size}`);
      expect(text).not.toContain('[Content truncated:');
      expect(text).not.toContain('tool result truncated');
      const bodyLength = text.match(/A/g)?.length ?? 0;
      expect(bodyLength).toBeGreaterThanOrEqual(size);
    });
  }
});
