import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildWorker } from '../scripts/build-worker.mjs';
import { createWorkerRuntime, createSdkMcpServer, tool, type WorkerRuntime } from './index.js';

let directory: string | undefined;
let runtime: WorkerRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('preserves MCP service metadata and raw definitions in a real worker without leaking them into provider tool schemas', async () => {
  directory = await mkdtemp(join(tmpdir(), 'mcp-source-worker-'));
  const workerPath = join(directory, 'entry.mjs');
  const setupPath = join(directory, 'setup.mjs');
  await buildWorker(workerPath);
  await writeFile(setupPath, `
    export function setup(options) {
      const server = options.mcpServers['configured/key'];
      return { ...options, provider: {
        id: 'metadata-fixture', name: 'Metadata fixture',
        capabilities: () => ({ streaming: true, toolCalling: true, thinking: false,
          imageInput: false, pdfInput: false, audioInput: false, videoInput: false,
          caching: false, systemPromptStyle: 'top_level' }),
        async createMessage() { throw new Error('Unexpected non-streaming request'); },
        async *createMessageStream(request) {
          yield { type: 'message_start', id: 'reply', model: 'fixture', usage: { input_tokens: 1, output_tokens: 1 } };
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
          yield { type: 'text_delta', index: 0, text: JSON.stringify({
            description: server.description, instructions: server.instructions,
            instanceDescription: server.instance.description, instanceInstructions: server.instance.instructions,
            definitions: server.instance.listTools(), wireTools: request.tools,
          }) };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_delta', stopReason: 'end_turn' };
          yield { type: 'message_stop' };
        },
      } };
    }
  `);
  runtime = createWorkerRuntime({ workerUrl: pathToFileURL(workerPath), maxWorkers: 1 });
  const description = 'Full tool description. '.repeat(150);
  const current = await runtime.createSession({
    model: 'fixture', apiKey: 'fixture', cwd: directory,
    env: { HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: directory },
    tools: [], settingSources: [], persistSession: false, systemPrompt: 'Test assistant.',
    turnEndChecks: { openWork: false, completion: false },
    mcpServers: { 'configured/key': createSdkMcpServer({ name: 'display/name',
      description: 'Customer records', instructions: 'Use IDs.',
      tools: [tool('lookup/order', description, {}, async () => ({ content: [] }))],
    }) },
  }, { setup: { module: pathToFileURL(setupPath).href } });
  await current.send('Describe the fixture.');
  let answer: Record<string, any> | undefined;
  for await (const message of current.stream()) {
    if (message.type === 'result' && message.subtype === 'success') answer = JSON.parse(message.result);
  }
  expect(answer).toMatchObject({ description: 'Customer records', instructions: 'Use IDs.',
    instanceDescription: 'Customer records', instanceInstructions: 'Use IDs.' });
  expect(answer?.definitions).toEqual([{ name: 'lookup/order', description,
    inputSchema: {} }]);
  expect(answer?.wireTools).toHaveLength(1);
  expect(answer?.wireTools[0].name).toBe('mcp__display_name__lookup_order');
  expect(answer?.wireTools[0]).not.toHaveProperty('mcpSource');
  expect(answer?.wireTools[0]).not.toHaveProperty('instructions');
  expect(answer?.wireTools[0].description.length).toBeLessThan(description.length);
});
