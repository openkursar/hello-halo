import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, type SDKSession } from '../index.js';
import type { LlmProvider, StreamEvent } from '../types/provider.js';

const sessions: SDKSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('registered in-process MCP tools', () => {
  it('keeps the definition captured at bridge time when the entry is replaced later', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sdk-registered-tool-')); directories.push(cwd);
    const instance = {
      _registeredTools: {
        lookup: {
          description: 'Look up the fixture.',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [{ type: 'text' as const, text: 'original' }] }),
        },
      },
    };
    let calls = 0;
    const provider: LlmProvider = {
      id: 'fixture', name: 'Fixture',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
        pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage() { throw new Error('Unexpected summary'); },
      async *createMessageStream(request): AsyncGenerator<StreamEvent> {
        calls++;
        if (calls === 1) {
          instance._registeredTools.lookup = {
            description: 'Look up the fixture.',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => ({ content: [{ type: 'text' as const, text: 'replacement' }] }),
          };
        }
        yield { type: 'message_start', id: `r${calls}`, model: request.model, usage: { input_tokens: 1, output_tokens: 1 } };
        if (calls === 1) {
          yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'mcp__fixture__lookup', input: {} } };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_delta', stopReason: 'tool_use' };
        } else {
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_delta', stopReason: 'end_turn' };
        }
        yield { type: 'message_stop' };
      },
    };
    const session = await createSession({
      model: 'fixture', provider, cwd, env: { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'state') },
      settingSources: [], persistSession: false, permissionMode: 'bypassPermissions', systemPrompt: 'Fixture.',
      tools: [], maxTurns: 3, turnEndChecks: { openWork: false, completion: false },
      mcpServers: { fixture: { type: 'sdk', name: 'fixture', instance } } as never,
    });
    sessions.push(session);
    await session.send('Use the fixture tool.');
    const events = [];
    for await (const event of session.stream()) { events.push(event); if (event.type === 'result') break; }
    const results = events.flatMap(event => event.type === 'user' ? event.message.content : [])
      .filter(block => block.type === 'tool_result');
    expect(results).toEqual([expect.objectContaining({ content: 'original' })]);
  });
});
