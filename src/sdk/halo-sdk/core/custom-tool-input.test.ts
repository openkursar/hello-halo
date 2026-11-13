import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, type SDKSession } from '../index.js';
import type { ContentBlock, LlmProvider, StreamEvent } from '../types/provider.js';
import type { Options } from '../types/config.js';

const sessions: SDKSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function provider(input: Record<string, unknown>): LlmProvider {
  let calls = 0;
  return {
    id: 'fixture', name: 'Fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const index = calls++;
      yield { type: 'message_start', id: `response-${index}`, model: request.model, usage: { input_tokens: 0, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: index === 0
        ? { type: 'tool_use', id: 'probe', name: 'Probe', input }
        : { type: 'text', text: 'Done.' } };
      yield { type: index === 0 ? 'input_json_delta' : 'content_block_stop', index: 0,
        ...(index === 0 ? { partialJson: JSON.stringify(input) } : {}) };
      if (index === 0) yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: index === 0 ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
}

describe('custom tool input fidelity', () => {
  it('preserves business data that resembles a native control marker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sdk-tool-input-')); directories.push(cwd);
    let observed: Record<string, unknown> | undefined;
    const options: Options = {
      model: 'fixture', provider: provider({ payload: { __haloSdkNativeUndefined: false, keep: 'literal' } }),
      cwd, env: { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'config') }, settingSources: [],
      persistSession: false, permissionMode: 'bypassPermissions', systemPrompt: 'Fixture.',
      tools: [], maxTurns: 3, turnEndChecks: { openWork: false, completion: false },
      customTools: [{
        name: 'Probe', description: 'Observe the callback input.',
        inputSchema: { type: 'object', properties: { payload: { type: 'object' } }, required: ['payload'] },
        permissionLevel: 'none',
        async execute(input) { observed = input as Record<string, unknown>; return { content: 'observed' }; },
      }],
    };
    const session = await createSession(options); sessions.push(session);
    await session.send('Probe the data object.');
    for await (const event of session.stream()) if (event.type === 'result') break;
    expect(observed).toEqual({ payload: { __haloSdkNativeUndefined: false, keep: 'literal' } });
  });
});
