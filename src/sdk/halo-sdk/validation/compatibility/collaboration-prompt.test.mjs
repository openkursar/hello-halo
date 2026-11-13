import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../../dist', import.meta.url));
const { createSession, createSdkMcpServer, query, tool } = await import(pathToFileURL(join(compiled, 'index.js')).href);
const manifest = JSON.parse(await readFile(join(dirname(compiled), 'package.json'), 'utf8'));
const { COLLABORATION_GUIDANCE } = await import(pathToFileURL(join(dirname(compiled), manifest.exports['./collaboration'].import)).href);

for (const entry of ['session', 'query']) for (const mode of ['hosted', 'local']) {
  test(`${entry} includes one collaboration guide when its owner is ${mode}`, { timeout: 10_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'halo-collaboration-prompt-'));
    const requests = [];
    const provider = {
      id: 'fixture', name: 'Fixture',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
        pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage() { throw new Error('Unexpected summary'); },
      async *createMessageStream(request) {
        requests.push(request);
        yield { type: 'message_start', id: 'fixture', model: request.model, usage: { input_tokens: 10, output_tokens: 0 } };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Complete.' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn', usage: { output_tokens: 1 } };
        yield { type: 'message_stop' };
      },
    };
    const options = {
      cwd, env: { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'config') }, provider, model: 'fixture',
      tools: [], settingSources: [], persistSession: false, permissionMode: 'bypassPermissions',
      thinking: { type: 'disabled' }, collaboration: { mode },
      systemPrompt: mode === 'hosted' ? `Host instructions.\n\n${COLLABORATION_GUIDANCE}` : 'Standalone instructions.',
      ...(mode === 'hosted' ? { mcpServers: { 'halo-team': createSdkMcpServer({ name: 'halo-team', tools: [
        tool('spawn_agent', 'Host-owned delegation.', { type: 'object' }, async () => ({ content: [] })),
      ] }) } } : {}),
    };
    let session;
    try {
      const events = [];
      if (entry === 'session') {
        session = await createSession(options);
        await session.send('Return a bounded answer.');
        for await (const event of session.stream()) events.push(event);
      } else {
        for await (const event of query({ prompt: 'Return a bounded answer.', options })) events.push(event);
      }
      assert.equal(requests.length, 1);
      assert.ok(requests[0].tools.some(tool => tool.name === 'mcp__halo-team__spawn_agent'));
      assert.equal(requests[0].systemPrompt.split(COLLABORATION_GUIDANCE).length - 1, 1);
      assert.equal(events.find(event => event.type === 'result')?.is_error, false);
    } finally { await session?.close(); await rm(cwd, { recursive: true, force: true }); }
  });
}
