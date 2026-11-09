import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSdkCollaboration, type SdkCollaborationBinding } from './index.js';
import { getTranscriptPath } from '../../core/transcript.js';
import { readHistory, readTranscriptPage } from '../../core/transcript-reader.js';
import type { Options } from '../../types/config.js';
import type { LlmProvider, ProviderRequest } from '../../types/provider.js';

const directories: string[] = [];
const bindings: SdkCollaborationBinding[] = [];
afterEach(async () => {
  await Promise.all(bindings.splice(0).map(binding => binding.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('collaborator execution checkpoints', () => {
  it('restores compacted member history after both execution retirement and source reconstruction', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-collaborator-checkpoint-')));
    directories.push(directory);
    let calls = 0;
    let summaries = 0;
    let memberId = '';
    const requests: ProviderRequest[] = [];
    const provider: LlmProvider = {
      id: 'fixture', name: 'Fixture', capabilities: () => ({ streaming: true, toolCalling: true, thinking: false,
        imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage() {
        summaries++;
        return { id: 'summary', model: 'fixture', content: [{ type: 'text', text: 'RETAINED_COLLABORATOR_SUMMARY' }],
          stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } };
      },
      async *createMessageStream(request) {
        requests.push(request);
        const call = calls++;
        yield { type: 'message_start', id: `response-${call}`, model: 'fixture', usage: { input_tokens: call === 1 ? 14_500 : 10, output_tokens: 1 } };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: call < 2
          ? (call === 0 ? 'OLD_DETAIL ' + 'old detail '.repeat(2000) : 'recent work '.repeat(1600)) : 'MEMBER_COMPLETED' } };
        yield { type: 'content_block_stop', index: 0 };
        if (call < 2) {
          yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `work-${call}`, name: 'Work', input: {} } };
          yield { type: 'content_block_stop', index: 1 };
        }
        yield { type: 'message_delta', stopReason: call < 2 ? 'tool_use' : 'end_turn' };
        yield { type: 'message_stop' };
      },
    };
    const base: Options = { provider, model: 'fixture', cwd: directory,
      systemPrompt: 'Fixture.', tools: ['spawn_agent'],
      env: { HOME: directory, SDK_STATE: join(directory, 'state') }, conventions: { configDirEnv: 'SDK_STATE' },
      contextWindow: 16_000, maxOutputTokens: 1024, maxTurns: 4, thinking: { type: 'disabled' }, permissionMode: 'bypassPermissions',
      settingSources: [], turnEndChecks: { openWork: false, completion: false },
      hooks: { SessionStart: [{ hooks: [async input => { memberId = input.session_id; return {}; }] }] },
      customTools: [{ name: 'Work', description: 'Do one work step.', inputSchema: { type: 'object' }, permissionLevel: 'none', async execute() { return { content: 'finished' }; } }],
    };
    const sessionId = randomUUID();
    const open = () => {
      const binding = createSdkCollaboration({ sessionId, getOptions: () => base, settings: { maxIdleSessions: 0 }, deliverToSource: async () => 'buffered' });
      bindings.push(binding);
      return binding;
    };
    const first = open();
    expect((await first.server.instance.callTool('spawn_agent', { name: 'worker', prompt: 'Perform the work.' }))?.isError).not.toBe(true);
    while (first.activeCount) await first.waitForChange(first.revision);
    expect(summaries).toBeGreaterThan(0);
    const path = getTranscriptPath(memberId, directory, base);
    const history = JSON.stringify(await readHistory(path));
    expect(history).toContain('RETAINED_COLLABORATOR_SUMMARY');
    expect(history).toContain('MEMBER_COMPLETED');
    expect(history).not.toContain('OLD_DETAIL');
    expect(JSON.stringify(await readTranscriptPage(path, memberId))).toContain('OLD_DETAIL');
    await first.close();
    const next = open();
    await next.server.instance.callTool('team_send', { to: 'worker', message: 'Continue from your previous work.' });
    while (next.activeCount) await next.waitForChange(next.revision);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('RETAINED_COLLABORATOR_SUMMARY');
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('OLD_DETAIL');
  });
});
